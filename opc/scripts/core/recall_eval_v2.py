#!/usr/bin/env python3
"""Recall eval v2: graded gold set keyed by content hash, floor sweep and ratchet.

Run it through ``eval_recall.py`` (it dispatches here when the eval set header has
``version: 2``):

    uv run --directory opc --frozen python scripts/core/eval_recall.py \\
      --eval-set tests/recall_eval_set_v2.jsonl --arms hybrid,text
    ... --write-baseline     # the only thing that writes recall_eval_baseline.json
    ... --check              # the ratchet; local only (CI has no Postgres)

Why v2 exists: v1 keys gold rows by row UUID, and the database was recreated on
2026-10-24, so every v1 id is gone. v2 keys by ``sha256(content utf-8)[:16]`` with
no normalisation (``incremental_extract.content_hash`` normalises and does NOT match).

Query parity: the search term for each gold query comes from the REAL hook code. The
node script ``.claude/hooks/scripts/hook-query-terms.mjs`` bundles
``src/shared/intent-extractor.ts`` and runs ``deriveRecallIntent`` (git expansion, else
``extractIntent``) and ``cleanSearchTerm``, the same calls ``memory-awareness.ts`` makes,
so the eval cannot drift from the hook. One node call covers the whole set.
Left out on purpose: in hybrid mode the hook appends the session-focus terms from the
context bus (memory-awareness.ts ``queryBiased``). They depend on the live session, so a
fixed gold set cannot reproduce them; the eval measures the un-biased query.

Exit codes: 0 pass, 1 regression, 2 setup error or preflight failure.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

_SCRIPTS_DIR = Path(__file__).resolve().parents[1]
_CORE_DIR = Path(__file__).resolve().parent
OPC_ROOT = Path(__file__).resolve().parents[2]
for _p in (str(_SCRIPTS_DIR), str(_CORE_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from core.utils import percentile as _pct  # noqa: E402

DEFAULT_BASELINE = OPC_ROOT / "tests" / "recall_eval_baseline.json"
DEFAULT_REPORT_JSON = OPC_ROOT / "tests" / "recall_eval_v2_report.json"
DEFAULT_REPORT_MD = OPC_ROOT / "tests" / "recall_eval_v2_report.md"

HASH_RE = re.compile(r"^[0-9a-f]{16}$")
CATEGORIES = ("direct", "paraphrase", "multi", "none")
GRADES = (1, 2, 3)
FIR_LIMIT = 0.20  # 2 of the 10 none prompts
TOLERANCE = {"ndcg_at_5": 0.03, "none_precision": 0.10}
MIN_PAIRS = 40
MIN_NONE = 5
EPS = 1e-9
HOOK_K = 3
NDCG_K = 5
PREVIEW_CHARS = 120
INTENT_CHARS = 200  # the hook sanitises the intent shown in the MEMORY MATCH header to 200 chars
HOOK_TERMS_SCRIPT = ".claude/hooks/scripts/hook-query-terms.mjs"
ILIKE_BASE_SCORE = 0.1  # recall_learnings ILIKE fallback gives every row exactly this base score
DEFAULT_ARMS = ("hybrid", "text")
GATED_ARM = "hybrid"
LATENCY_LABEL = "uv subprocess, hook fallback path"


class SetupError(Exception):
    """A problem with the setup (set, baseline, DB, daemon), not a quality regression."""


# ---------------------------------------------------------------------------
# Gold set
# ---------------------------------------------------------------------------


def row_hash(content: str) -> str:
    """The gold-set key. No normalisation: it must match the stored text byte for byte."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


def _check_relevant(rel: Any, category: str, where: str) -> None:
    if not isinstance(rel, list):
        raise ValueError(f"{where}: 'relevant' must be a list")
    if category == "none" and rel:
        raise ValueError(f"{where}: category none must have no relevant rows")
    if category != "none" and not rel:
        raise ValueError(f"{where}: category {category} needs relevant rows")
    for entry in rel:
        h, g = entry.get("content_hash"), entry.get("grade")
        if not isinstance(h, str) or not HASH_RE.match(h):
            raise ValueError(f"{where}: bad content_hash {h!r} (need 16 lowercase hex chars)")
        if g not in GRADES:
            raise ValueError(f"{where}: grade {g!r} not in {GRADES}")
    if rel and not any(e["grade"] == 3 for e in rel):
        raise ValueError(f"{where}: answerable row needs a grade-3 entry")


def load_eval_set_v2(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Load and validate the v2 set. Raises ValueError("file:line: reason")."""
    path = Path(path)
    header: dict[str, Any] = {}
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    with path.open("r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            raw = raw.strip()
            if not raw:
                continue
            where = f"{path.name}:{lineno}"
            try:
                row = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{where}: invalid JSON: {exc}") from exc
            if "_header" in row:
                header = row["_header"]
                if header.get("version") != 2:
                    raise ValueError(
                        f"{where}: header version must be 2, got {header.get('version')!r}"
                    )
                continue
            if not header:
                raise ValueError(f"{where}: missing _header line with version 2 (version header)")
            category = row.get("category")
            if category not in CATEGORIES:
                raise ValueError(f"{where}: unknown category {category!r}")
            query = row.get("query")
            if not isinstance(query, str) or not query.strip():
                raise ValueError(f"{where}: empty query")
            if query in seen:
                raise ValueError(f"{where}: duplicate query")
            seen.add(query)
            _check_relevant(row.get("relevant"), category, where)
            rows.append(row)
    if not header:
        raise ValueError(f"{path.name}:1: missing _header line with version 2 (version header)")
    return header, rows


# ---------------------------------------------------------------------------
# Live rows and reachability
# ---------------------------------------------------------------------------


async def fetch_live_rows() -> list[dict[str, Any]]:
    """Every current row: id, content, scope, project_id. Read-only."""
    from db.postgres_pool import close_pool, get_pool  # type: ignore

    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            recs = await conn.fetch(
                "SELECT id::text AS id, content, scope, project_id "
                "FROM archival_memory WHERE valid_until IS NULL"
            )
        return [dict(r) for r in recs]
    finally:
        await close_pool()


def resolve_hashes(
    rows: list[dict[str, Any]], hashes: list[str]
) -> tuple[dict[str, list[str]], list[str]]:
    """Map each gold hash to every live row id with that hash; list the hashes with none."""
    by_hash: dict[str, list[str]] = {}
    for r in rows:
        by_hash.setdefault(row_hash(r["content"]), []).append(r["id"])
    found = {h: by_hash[h] for h in hashes if h in by_hash}
    missing = [h for h in hashes if h not in by_hash]
    return found, missing


def reachable(row: dict[str, Any], project_id: str | None) -> bool:
    """True when the hook scope (GLOBAL, or PROJECT with this project id) can recall the row."""
    if row.get("scope") == "GLOBAL":
        return True
    return project_id is not None and row.get("project_id") == project_id


def resolve_hook_project_id(repo_root: Path) -> str:
    """The project id the hook's recall resolves, found the way the hook finds it.

    The hook spawns recall with cwd=<opc dir>, so the id comes from the registered
    project root containing that dir (resolve_recall_scope step 4). CLAUDE_PROJECT_ID
    would override it, so it is cleared for the lookup.
    """
    from core import recall_learnings  # type: ignore

    opc_dir = Path(repo_root) / "opc"
    old_cwd, old_env = os.getcwd(), os.environ.pop("CLAUDE_PROJECT_ID", None)
    try:
        os.chdir(opc_dir)
        project_id, mode = recall_learnings.resolve_recall_scope()
    finally:
        os.chdir(old_cwd)
        if old_env is not None:
            os.environ["CLAUDE_PROJECT_ID"] = old_env
    if mode != "project" or not project_id:
        raise SetupError(
            f"hook scope did not resolve to a project (mode={mode}); "
            "is the opc dir inside a registered project?"
        )
    return project_id


def daemon_ready() -> bool:
    """True when the BGE embed daemon answers ping, is ready and matches the stored dim."""
    from core import embedding_daemon  # type: ignore

    resp = embedding_daemon.ping_daemon()
    return bool(
        resp and resp.get("ready")
        and resp.get("model") == "BAAI/bge-large-en-v1.5" and resp.get("dim") == 1024
    )


# ---------------------------------------------------------------------------
# Hook parity
# ---------------------------------------------------------------------------


def hook_search_terms(repo_root: Path, prompts: list[str]) -> list[dict[str, Any]]:
    """The hook's intent and search term for each prompt, from the real TypeScript.

    One node call for the whole batch. Each item has ``prompt``, ``intent``, ``term`` and
    ``skipped`` (None, or the reason the hook would not run recall for that prompt).
    """
    node = shutil.which("node")
    script = Path(repo_root) / HOOK_TERMS_SCRIPT
    if node is None:
        raise SetupError("node not found on PATH; the eval builds its queries with the hook code")
    if not script.exists():
        raise SetupError(f"hook query script missing: {HOOK_TERMS_SCRIPT}")
    try:
        proc = subprocess.run(  # noqa: S603
            [node, str(script)], input=json.dumps(prompts), capture_output=True, text=True,
            encoding="utf-8", check=False, timeout=60, cwd=str(script.parent),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SetupError(f"hook query script failed to run ({type(exc).__name__})") from exc
    if proc.returncode != 0:
        tail = (proc.stderr or "")[-300:]
        raise SetupError(f"hook query script exit {proc.returncode}: {tail!r}")
    try:
        items = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise SetupError(f"hook query script printed invalid JSON: {exc}") from exc
    if not isinstance(items, list) or [i.get("prompt") for i in items] != prompts:
        raise SetupError("hook query script returned a different prompt list than it was given")
    return items


def _parse_recall_stdout(stdout: str) -> dict[str, Any] | None:
    stdout = stdout.strip()
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        for line in reversed([ln for ln in stdout.splitlines() if ln.strip().startswith("{")]):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return None


def run_arm_query(
    repo_root: Path,
    term: str,
    arm: str,
    k: int,
    env: dict[str, str] | None = None,
    all_projects: bool = False,
    timeout_s: float = 120.0,
) -> dict[str, Any]:
    """One recall_learnings.py --json call. Never raises; failures set ``error``.

    ``term`` is the final search term from ``hook_search_terms``; it is sent as is.
    ``env`` entries are added to the child environment (CLAUDE_PROJECT_ID in hook scope).
    """
    repo_root = Path(repo_root)
    cmd = [
        "uv", "run", "--frozen", "--project", str(repo_root / "opc"),
        "python", str(repo_root / "opc" / "scripts" / "core" / "recall_learnings.py"),
        "--query", term, "--k", str(k), "--json",
    ]
    if arm == "text":
        cmd.append("--text-only")
    elif arm == "rerank":
        cmd.append("--rerank")
    if all_projects:
        cmd.append("--all-projects")

    child_env = {**os.environ, **(env or {})}
    t0 = time.perf_counter()
    empty: dict[str, Any] = {"ids": [], "rows": []}
    try:
        proc = subprocess.run(  # noqa: S603
            cmd, cwd=str(repo_root), env=child_env, capture_output=True, text=True,
            check=False, timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return {**empty, "latency_ms": (time.perf_counter() - t0) * 1000.0, "error": "timeout"}
    except OSError as exc:
        return {**empty, "latency_ms": (time.perf_counter() - t0) * 1000.0,
                "error": f"oserror:{type(exc).__name__}"}
    latency_ms = (time.perf_counter() - t0) * 1000.0
    if proc.returncode != 0:
        tail = re.sub(r"postgres(?:ql)?(?:\+\w+)?://\S+", "<db-url>", (proc.stderr or "")[-200:])
        return {**empty, "latency_ms": latency_ms, "error": f"exit {proc.returncode}: {tail!r}"}
    doc = _parse_recall_stdout(proc.stdout or "")
    if doc is None:
        return {**empty, "latency_ms": latency_ms, "error": "unparseable output"}
    if "error" in doc:
        reason = re.sub(r"postgres(?:ql)?(?:\+\w+)?://\S+", "<db-url>", str(doc["error"]))[:200]
        return {**empty, "latency_ms": latency_ms, "error": f"recall_error: {reason}"}
    rows = [
        {
            "id": str(r.get("id", "")),
            "base_score": r.get("base_score"),
            "score": r.get("score"),
            "rerank_score": r.get("rerank_score"),
            "content": r.get("content") or "",
            "type": r.get("type"),
            "created_at": r.get("created_at"),
        }
        for r in (doc.get("results") or [])
    ]
    return {"ids": [r["id"] for r in rows], "rows": rows, "latency_ms": latency_ms, "error": None}


def floor_score(row: dict[str, Any], arm: str) -> float:
    """The score the floor gates on: rerank_score for rerank, pre-decay base_score otherwise."""
    if arm == "rerank":
        value = row.get("rerank_score")
    else:
        value = row.get("base_score")
        if value is None:
            value = row.get("score")
    return float(value or 0.0)


def apply_floor(rows: list[dict[str, Any]], arm: str, floor: float) -> list[dict[str, Any]]:
    """The hook's top-3 after the floor."""
    return [r for r in rows[:HOOK_K] if floor_score(r, arm) >= floor]


def _preview(content: str) -> str:
    text = " ".join(ln.strip() for ln in content.split("\n") if ln.strip())[:PREVIEW_CHARS]
    return text + ("..." if len(content) > PREVIEW_CHARS else "")


def injected_chars(query: str, kept_rows: list[dict[str, Any]]) -> int:
    """Length of the MEMORY MATCH text the hook would inject (without the constant wrapper).

    ``query`` is the hook intent. No "(stored YYYY-MM-DD; may be stale)" suffix: mergeResults
    drops ``storedDate``, so the hook never emits it today.
    """
    if not kept_rows:
        return 0
    lines = [
        f"{i}. [{r.get('type') or 'UNKNOWN'}] {_preview(r.get('content') or '')}"
        f" (id: {str(r.get('id', ''))[:8]})"
        for i, r in enumerate(kept_rows, start=1)
    ]
    header = f'MEMORY MATCH ({len(kept_rows)} results) for "{query[:INTENT_CHARS]}":\n'
    return len(header + "\n".join(lines))


def tokens_for_chars(chars: int) -> int:
    return math.ceil(chars / 4)


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def ndcg_graded(ids: list[str], rel: dict[str, int], k: int = NDCG_K) -> float | None:
    """Graded NDCG@k with gain 2^g - 1. None when there is nothing to find."""
    if not rel:
        return None
    dcg = sum((2 ** rel.get(i, 0) - 1) / math.log2(pos + 2) for pos, i in enumerate(ids[:k]))
    ideal = sorted(rel.values(), reverse=True)[:k]
    idcg = sum((2**g - 1) / math.log2(pos + 2) for pos, g in enumerate(ideal))
    return dcg / idcg if idcg else 0.0


def recall_at(ids: list[str], rel: dict[str, int], k: int = HOOK_K) -> float:
    """|rel in top k| / min(|rel|, k)."""
    if not rel:
        return 0.0
    return len(set(ids[:k]) & set(rel)) / min(len(rel), k)


def _is_answerable(rec: dict[str, Any]) -> bool:
    return rec["category"] != "none" and bool(rec["rel"])


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def aggregate_arm(records: list[dict[str, Any]], arm: str, floor: float) -> dict[str, Any]:
    """Per-arm metrics at one floor.

    A query is a hit when any relevant id is in the kept (floored) top 3.
    ``hit_rate_at_floor`` divides by all answerable queries, ``hit_rate_reachable`` by the
    answerable queries the hook scope can reach.
    """
    ndcgs, recalls, tokens, latencies = [], [], [], []
    n_answerable = n_reachable = n_partial = n_none = n_errors = 0
    hits = hits_reachable = none_clean = 0
    for rec in records:
        calls = rec["arms"][arm]
        k3, k5 = calls["k3"], calls["k5"]
        call_errors = sum(1 for c in (k3, k5) if c.get("error"))
        n_errors += call_errors
        if call_errors:
            # An errored query has no rows. Counting it would flatter none_precision.
            continue
        if not k3.get("error") and isinstance(k3.get("latency_ms"), (int, float)):
            latencies.append(float(k3["latency_ms"]))
        kept = apply_floor(k3["rows"], arm, floor)
        tokens.append(tokens_for_chars(injected_chars(rec["intent"], kept)))
        if rec["category"] == "none":
            n_none += 1
            none_clean += 0 if kept else 1
            continue
        if not _is_answerable(rec):
            continue
        n_answerable += 1
        rel = rec["rel"]
        ndcgs.append(ndcg_graded(k5["ids"], rel) or 0.0)
        recalls.append(recall_at(k3["ids"], rel))
        is_reachable = bool(rec["reachable_ids"])
        n_reachable += is_reachable
        n_partial += is_reachable and len(rec["reachable_ids"]) < len(rel)
        hit = bool({r["id"] for r in kept} & set(rel))
        hits += hit
        hits_reachable += hit and is_reachable
    injected = [t for t in tokens if t > 0]
    return {
        "floor": floor,
        "ndcg_at_5": _mean(ndcgs),
        "recall_at_3": _mean(recalls),
        "hit_rate_at_floor": hits / n_answerable if n_answerable else 0.0,
        "hit_rate_reachable": hits_reachable / n_reachable if n_reachable else 0.0,
        "none_precision": none_clean / n_none if n_none else 1.0,
        "p50_ms": _pct(latencies, 50) if latencies else 0.0,
        "p95_ms": _pct(latencies, 95) if latencies else 0.0,
        "latency_label": LATENCY_LABEL,
        "mean_tokens_all": _mean([float(t) for t in tokens]),
        "mean_tokens_injected": _mean([float(t) for t in injected]),
        "n_answerable": n_answerable,
        "n_reachable": n_reachable,
        "n_partial": n_partial,
        "n_none": n_none,
        "n_errors": n_errors,
    }


# ---------------------------------------------------------------------------
# Floor sweep
# ---------------------------------------------------------------------------


def floor_grid(arm: str) -> list[float]:
    """Sweep grid built from integers so every floor prints short and compares exactly."""
    if arm == "hybrid":
        # Extra points: 0.01639/0.0164 straddle 1/61 (one arm, rank 1) and 0.03275 sits just
        # under 2/61 = 0.032787 (rank 1 in both arms), a point the 0.0005 step skips.
        grid = {round(i / 10000, 5) for i in range(100, 331, 5)} | {0.01639, 0.0164, 0.03275}
    elif arm == "text":
        grid = {round(i * 25 / 10000, 5) for i in range(0, 41)}
    elif arm == "rerank":
        grid = {round(i / 20, 2) for i in range(0, 21)}
    else:
        raise ValueError(f"unknown arm {arm!r}")
    return sorted(grid)


def sweep(records: list[dict[str, Any]], arm: str, grid: list[float]) -> list[dict[str, Any]]:
    rows = []
    for floor in grid:
        agg = aggregate_arm(records, arm, floor)
        rows.append({
            "floor": floor,
            "hit_rate_reachable": agg["hit_rate_reachable"],
            "false_injection_rate": 1.0 - agg["none_precision"],
            "mean_tokens": agg["mean_tokens_all"],
        })
    return rows


def choose_floor(sweep_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Highest hit rate with false-injection <= 0.20; ties go to the higher floor.

    A floor that injects nothing (hit 0) is never feasible: it meets the limit by turning
    recall off. When no floor qualifies, take the best (hit - FIR), ties to the higher
    floor, and flag ``constraint_unmet``.
    """
    feasible = [
        r for r in sweep_rows
        if r["false_injection_rate"] <= FIR_LIMIT + EPS and r["hit_rate_reachable"] > 0
    ]
    if feasible:
        best = max(feasible, key=lambda r: (r["hit_rate_reachable"], r["floor"]))
        return {**best, "constraint_unmet": False}
    best = max(
        sweep_rows,
        key=lambda r: (r["hit_rate_reachable"] - r["false_injection_rate"], r["floor"]),
    )
    return {**best, "constraint_unmet": True}


# ---------------------------------------------------------------------------
# Baseline ratchet
# ---------------------------------------------------------------------------


def compare_to_baseline(
    current: dict[str, Any], baseline: dict[str, Any]
) -> tuple[bool, list[str]]:
    """Gate the default arm. Raises SetupError when the comparison would be meaningless."""
    if current["eval_set_sha256"] != baseline["eval_set_sha256"]:
        raise SetupError("eval set changed since the baseline was written (sha256 differs); "
                         "rewrite the baseline with --write-baseline")
    if current["n_pairs"] < MIN_PAIRS:
        raise SetupError(f"only {current['n_pairs']} pairs; the gate needs at least {MIN_PAIRS}")
    if current["n_none"] < MIN_NONE:
        raise SetupError(
            f"only {current['n_none']} none prompts; the gate needs at least {MIN_NONE}"
        )
    arm = baseline.get("default_arm", GATED_ARM)
    cur, base = current["arms"][arm], baseline["arms"][arm]
    tol = baseline.get("tolerance", TOLERANCE)
    reasons = []
    for key in ("ndcg_at_5", "none_precision"):
        drop = base[key] - cur[key]
        if drop > tol[key] + EPS:
            reasons.append(
                f"{arm} {key} fell {drop:.3f} (baseline {base[key]:.3f}, now {cur[key]:.3f}, "
                f"tolerance {tol[key]:.2f})"
            )
    return not reasons, reasons


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------


def _fmt(v: Any, nd: int = 3) -> str:
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def render_markdown(report: dict[str, Any]) -> str:
    meta, reach = report["_meta"], report["reachability"]
    out = ["# Recall eval v2 report", "", "## Run metadata", ""]
    for key in ("ran_at", "eval_set", "eval_set_sha256", "scope", "project_id",
                "embed_daemon", "arms", "live_rows", "n_pairs", "hit_definition",
                "token_note", "query_source", "latency_note"):
        out.append(f"- {key}: {meta.get(key)}")
    out += ["", "## Reachability", "",
            f"- Answerable queries: {reach['n_answerable']}",
            f"- Reachable in this scope: {reach['n_reachable']}",
            f"- Unreachable (no relevant row reachable): {len(reach['unreachable_queries'])}",
            f"- Partly reachable: {len(reach['partial_queries'])}",
            f"- Live rows unreachable in this scope: {reach['unreachable_live_rows']}", ""]
    for label, key in (
        ("Unreachable", "unreachable_queries"),
        ("Partly reachable", "partial_queries"),
    ):
        if reach[key]:
            out.append(f"{label} queries:")
            out += [f"- {q}" for q in reach[key]]
            out.append("")
    for arm, block in report["arms"].items():
        s, chosen = block["summary"], block["chosen"]
        out += [f"## Arm: {arm}", "", f"Summary at floor {s['floor']}:", ""]
        for key in ("ndcg_at_5", "recall_at_3", "hit_rate_at_floor", "hit_rate_reachable",
                    "none_precision", "p50_ms", "p95_ms", "mean_tokens_all",
                    "mean_tokens_injected", "n_answerable", "n_reachable", "n_partial",
                    "n_none", "n_errors"):
            out.append(f"- {key}: {_fmt(s[key])}")
        out.append(f"- latency: {s['latency_label']}")
        if block.get("ilike_suspects"):
            out.append(f"- ILIKE fallback rows (constant base score {ILIKE_BASE_SCORE}, "
                       f"clear every text floor): {len(block['ilike_suspects'])} queries")
            out += [f"  - {q}" for q in block["ilike_suspects"]]
        out += ["", f"### Sweep: {arm}", "",
                f"Errored calls in this arm: {s['n_errors']} (errored queries are left out).", "",
                "| floor | hit_rate_reachable | false_injection_rate | mean_tokens | chosen |",
                "|---|---|---|---|---|"]
        for r in block["sweep"]:
            mark = "**<- chosen**" if r["floor"] == chosen["floor"] else ""
            fir, tok = _fmt(r["false_injection_rate"]), _fmt(r["mean_tokens"], 2)
            out.append(
                f"| {r['floor']} | {_fmt(r['hit_rate_reachable'])} | {fir} | {tok} | {mark} |"
            )
        out.append("")
    out += ["## Constraint status", ""]
    for arm, block in report["arms"].items():
        c = block["chosen"]
        status = "UNMET (best hit - FIR chosen)" if c["constraint_unmet"] else "met"
        out.append(f"- {arm}: false-injection limit {FIR_LIMIT:.2f} {status}; "
                   f"chosen floor {c['floor']}")
    out += ["", "## Errors", ""]
    errors = report["errors"]
    out += [f"- {e}" for e in errors] if errors else ["- none"]
    return "\n".join(out) + "\n"


def _json_default(o: Any) -> Any:
    if isinstance(o, Path):
        return str(o)
    raise TypeError(f"not JSON-serialisable: {type(o)}")


def _slim(rec: dict[str, Any]) -> dict[str, Any]:
    """Report copy of a record with long content cut (the full text is in the DB)."""
    slim = json.loads(json.dumps(rec, default=_json_default))
    for calls in slim["arms"].values():
        for call in calls.values():
            for row in call.get("rows", []):
                row["content"] = (row.get("content") or "")[:PREVIEW_CHARS]
    return slim


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------


def _log(msg: str) -> None:
    print(msg, file=sys.stderr)


def _build_records(
    rows: list[dict[str, Any]],
    found: dict[str, list[str]],
    live_by_id: dict[str, dict[str, Any]],
    project_id: str | None,
    scope: str,
) -> list[dict[str, Any]]:
    records = []
    for row in rows:
        rel: dict[str, int] = {}
        for entry in row["relevant"]:
            for rid in found[entry["content_hash"]]:
                rel[rid] = max(rel.get(rid, 0), entry["grade"])
        reach_ids = [
            rid for rid in rel
            if scope == "all" or reachable(live_by_id[rid], project_id)
        ]
        records.append({
            "query": row["query"], "intent": row["query"], "search_term": row["query"],
            "category": row["category"], "note": row.get("note"),
            "rel": rel, "reachable_ids": reach_ids, "arms": {},
        })
    return records


def _apply_hook_terms(records: list[dict[str, Any]], repo_root: Path) -> None:
    """Give every record the hook's own intent and search term (the real TypeScript)."""
    items = hook_search_terms(repo_root, [r["query"] for r in records])
    skipped = [f"{i['prompt']!r}: {i['skipped']}" for i in items if i["skipped"]]
    if skipped:
        raise SetupError("the hook would skip recall for these gold queries: " + "; ".join(skipped))
    for rec, item in zip(records, items, strict=True):
        rec["intent"], rec["search_term"] = item["intent"], item["term"]


def _print_reachability(records: list[dict[str, Any]], live: list[dict[str, Any]],
                        project_id: str | None, scope: str) -> dict[str, Any]:
    answerable = [r for r in records if _is_answerable(r)]
    unreach = [r["query"] for r in answerable if not r["reachable_ids"]]
    partial = [r["query"] for r in answerable
               if r["reachable_ids"] and len(r["reachable_ids"]) < len(r["rel"])]
    orphan_rows = sum(1 for r in live if scope != "all" and not reachable(r, project_id))
    info = {
        "n_answerable": len(answerable),
        "n_reachable": len(answerable) - len(unreach),
        "unreachable_queries": unreach,
        "partial_queries": partial,
        "unreachable_live_rows": orphan_rows,
    }
    print(f"Reachability (scope={scope}): {info['n_answerable']} answerable, "
          f"{info['n_reachable']} reachable, {len(unreach)} unreachable, "
          f"{len(partial)} partly reachable; {orphan_rows} of {len(live)} live rows unreachable")
    for label, qs in (("unreachable", unreach), ("partly reachable", partial)):
        for q in qs:
            print(f"  {label}: {q}")
    return info


def _run_arms(records: list[dict[str, Any]], arms: list[str], repo_root: Path,
              env: dict[str, str], scope: str, timeout_s: float) -> None:
    total = len(records) * len(arms)
    done = 0
    for rec in records:
        for arm in arms:
            calls = {}
            for key, k in (("k3", HOOK_K), ("k5", NDCG_K)):
                calls[key] = run_arm_query(repo_root, rec["search_term"], arm, k, env,
                                           all_projects=(scope == "all"), timeout_s=timeout_s)
            rec["arms"][arm] = calls
            done += 1
            err = calls["k3"]["error"] or calls["k5"]["error"]
            _log(f"  [{done}/{total}] {arm:7s} k3={calls['k3']['latency_ms']:.0f}ms"
                 + (f" ERR={str(err)[:60]}" if err else ""))


def _ilike_suspects(records: list[dict[str, Any]], arm: str) -> list[str]:
    if arm != "text":
        return []
    return [
        r["query"] for r in records
        if any(row.get("base_score") == ILIKE_BASE_SCORE for row in r["arms"][arm]["k3"]["rows"])
    ]


def _rel_path(path: Path) -> str:
    try:
        return Path(os.path.relpath(path, OPC_ROOT)).as_posix()
    except ValueError:
        return str(path)


def _load_baseline(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SetupError(f"baseline not found: {path.name} (write it with --write-baseline)")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SetupError(f"baseline is not valid JSON: {exc}") from exc


def _lowered(new_arm: dict[str, Any], old_arm: dict[str, Any]) -> list[str]:
    return [
        f"{key} {old_arm[key]:.3f} -> {new_arm[key]:.3f}"
        for key in ("ndcg_at_5", "none_precision")
        if new_arm[key] < old_arm[key] - EPS
    ]


def _start_rerank_daemon(repo_root: Path):
    from core.eval_recall import DaemonManager  # type: ignore

    daemon = DaemonManager(enabled=True, repo_root=repo_root)
    try:
        daemon.start()
    except (FileNotFoundError, RuntimeError) as exc:
        raise SetupError(f"rerank daemon startup failed: {exc}") from exc
    return daemon


def run_v2(args: Any) -> int:
    """Run the v2 eval. Returns 0 pass, 1 regression, 2 setup error."""
    try:
        return _run_v2(args)
    except SetupError as exc:
        print(f"[eval] setup error: {exc}", file=sys.stderr)
        return 2


def _run_v2(args: Any) -> int:
    repo_root = OPC_ROOT.parent
    arms = [a.strip() for a in str(args.arms).split(",") if a.strip()]
    unknown = [a for a in arms if a not in ("hybrid", "text", "rerank")]
    if unknown or not arms:
        raise SetupError(f"--arms must be a list of hybrid,text,rerank; got {args.arms!r}")
    if (args.check or args.write_baseline) and GATED_ARM not in arms:
        raise SetupError(f"--check and --write-baseline need the {GATED_ARM} arm")
    if (args.check or args.write_baseline) and args.max_pairs:
        raise SetupError("--max-pairs cannot be combined with --check or --write-baseline")

    eval_set = Path(args.eval_set)
    try:
        header, rows = load_eval_set_v2(eval_set)
    except (OSError, ValueError) as exc:
        raise SetupError(f"cannot load eval set: {exc}") from exc
    # Line endings are normalised: git autocrlf gives CRLF here and LF elsewhere.
    eval_sha = hashlib.sha256(eval_set.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
    if args.max_pairs:
        rows = rows[: args.max_pairs]

    try:
        live = asyncio.run(fetch_live_rows())
    except Exception as exc:  # noqa: BLE001 - class name only: asyncpg errors can carry the URL
        raise SetupError(f"cannot read live rows ({type(exc).__name__})") from exc
    hashes = sorted({e["content_hash"] for row in rows for e in row["relevant"]})
    found, missing = resolve_hashes(live, hashes)
    if missing:
        print(f"[eval] {len(missing)} of {len(hashes)} gold hashes not found among live rows: "
              f"{missing}", file=sys.stderr)
        return 2

    project_id = None if args.scope == "all" else resolve_hook_project_id(repo_root)
    live_by_id = {r["id"]: r for r in live}
    records = _build_records(rows, found, live_by_id, project_id, args.scope)
    reach = _print_reachability(records, live, project_id, args.scope)
    _apply_hook_terms(records, repo_root)

    embed_state = "not needed (text arm only)"
    if "hybrid" in arms or "rerank" in arms:
        ready = daemon_ready()
        embed_state = "ready" if ready else "not ready (cold in-process embed, ~31 s per query)"
        if not ready and not args.allow_cold_embed:
            raise SetupError("embed daemon is not ready; start it, or pass --allow-cold-embed")

    baseline = _load_baseline(Path(args.baseline or DEFAULT_BASELINE)) if args.check else None
    if baseline is not None:
        if (baseline.get("scope"), baseline.get("project_id")) != (args.scope, project_id):
            raise SetupError("baseline scope or project id differs from this run")

    env = {"CLAUDE_PROJECT_ID": project_id} if project_id else {}
    daemon = _start_rerank_daemon(repo_root) if "rerank" in arms else None
    try:
        _log(f"[eval] {len(records)} queries x {len(arms)} arms x 2 calls")
        _run_arms(records, arms, repo_root, env, args.scope, args.timeout)
    finally:
        if daemon is not None:
            daemon.stop()

    arm_blocks: dict[str, Any] = {}
    errors: list[str] = []
    for arm in arms:
        sw = sweep(records, arm, floor_grid(arm))
        chosen = choose_floor(sw)
        floor = chosen["floor"]
        if baseline and arm in baseline["floors"]:
            floor = baseline["floors"][arm]
        summary = aggregate_arm(records, arm, floor)
        arm_blocks[arm] = {"summary": summary, "sweep": sw, "chosen": chosen,
                           "ilike_suspects": _ilike_suspects(records, arm)}
        for rec in records:
            for key in ("k3", "k5"):
                if rec["arms"][arm][key]["error"]:
                    err = rec["arms"][arm][key]["error"]
                    errors.append(f"{arm} {key} {rec['query'][:60]!r}: {err}")

    report = {
        "_meta": {
            "ran_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "eval_set": _rel_path(eval_set.resolve()), "eval_set_sha256": eval_sha,
            "scope": args.scope, "project_id": project_id, "embed_daemon": embed_state,
            "arms": arms, "live_rows": len(live), "n_pairs": len(records),
            "hit_definition": "a query is a hit when any relevant id is in the kept top 3 "
                              "after the floor",
            "token_note": "tokens = ceil(chars/4) of the MEMORY MATCH text; the constant "
                          "wrapMemoryContext wrapper and sanitising are left out; the "
                          "'(stored DATE; may be stale)' suffix is left out because the hook "
                          "does not emit it today (mergeResults drops storedDate)",
            "query_source": "real hook functions via .claude/hooks/scripts/hook-query-terms.mjs "
                            "(deriveRecallIntent + cleanSearchTerm); session-focus terms are "
                            "not added",
            "latency_note": LATENCY_LABEL,
        },
        "reachability": reach,
        "arms": arm_blocks,
        "chosen_floors": {a: b["chosen"]["floor"] for a, b in arm_blocks.items()},
        "errors": errors,
        "per_query": [_slim(r) for r in records],
    }
    rj = Path(args.report_json or DEFAULT_REPORT_JSON)
    rm = Path(args.report_md or DEFAULT_REPORT_MD)
    rj.parent.mkdir(parents=True, exist_ok=True)
    rm.parent.mkdir(parents=True, exist_ok=True)
    rj.write_text(json.dumps(report, indent=2, default=_json_default) + "\n", encoding="utf-8")
    rm.write_text(render_markdown(report), encoding="utf-8")

    _print_sweep_and_floors(arm_blocks, report["chosen_floors"], errors, rj, rm)

    n_none = sum(1 for r in records if r["category"] == "none")
    if args.check:
        return _do_check(arm_blocks, errors, eval_sha, len(records), n_none, baseline)
    if args.write_baseline:
        return _do_write_baseline(args, arm_blocks, report, errors, eval_sha, eval_set,
                                  len(records), len(live), project_id)
    return 0


def _print_sweep_and_floors(arm_blocks, chosen_floors, errors, rj, rm) -> None:
    for arm, block in arm_blocks.items():
        print(f"\nSweep: {arm} (floor, hit_rate_reachable, false_injection_rate, mean_tokens)")
        for r in block["sweep"]:
            mark = "  <- chosen" if r["floor"] == block["chosen"]["floor"] else ""
            print(f"  {r['floor']:<8} {r['hit_rate_reachable']:.3f}  "
                  f"{r['false_injection_rate']:.3f}  {r['mean_tokens']:.2f}{mark}")
        c = block["chosen"]
        print(f"  constraint_unmet={c['constraint_unmet']}")
    print("\nChosen floors: " + ", ".join(f"{a}={f}" for a, f in chosen_floors.items()))
    print(f"Errors: {len(errors)}")
    print(f"Reports: {rj} and {rm}")


def _do_check(arm_blocks, errors, eval_sha, n_pairs, n_none, baseline) -> int:
    if arm_blocks[GATED_ARM]["summary"]["n_errors"]:
        raise SetupError(f"{GATED_ARM} arm had errors; the gate cannot read a partial run")
    current = {
        "eval_set_sha256": eval_sha, "n_pairs": n_pairs, "n_none": n_none,
        "arms": {a: b["summary"] for a, b in arm_blocks.items()},
    }
    ok, reasons = compare_to_baseline(current, baseline)
    gate = current["arms"][baseline.get("default_arm", GATED_ARM)]
    print(f"CHECK {'PASS' if ok else 'FAIL'}: ndcg_at_5={gate['ndcg_at_5']:.3f} "
          f"none_precision={gate['none_precision']:.3f} at floor {gate['floor']}")
    for reason in reasons:
        print(f"  regression: {reason}")
    return 0 if ok else 1


def _do_write_baseline(args, arm_blocks, report, errors, eval_sha, eval_set, n_pairs,
                       n_live, project_id) -> int:
    if errors:
        raise SetupError(f"refusing to write the baseline: {len(errors)} recall errors in this run")
    path = Path(args.baseline or DEFAULT_BASELINE)
    n_none = sum(1 for r in report["per_query"] if r["category"] == "none")
    if n_pairs < MIN_PAIRS or n_none < MIN_NONE:
        raise SetupError(f"refusing to write the baseline: {n_pairs} pairs, {n_none} none prompts "
                         f"(need {MIN_PAIRS} and {MIN_NONE})")
    # A write run never has a baseline loaded, so every summary is at the sweep-chosen floor.
    new_arms = {arm: block["summary"] for arm, block in arm_blocks.items()}
    if path.exists() and not args.allow_lower:
        old = json.loads(path.read_text(encoding="utf-8"))
        worse = _lowered(new_arms[GATED_ARM], old["arms"].get(GATED_ARM, new_arms[GATED_ARM]))
        if worse:
            print("[eval] refusing to lower the baseline without --allow-lower: "
                  + "; ".join(worse), file=sys.stderr)
            return 1
    baseline = {
        "_comment": "Written only by eval_recall.py --write-baseline",
        "eval_set": _rel_path(eval_set.resolve()),
        "eval_set_sha256": eval_sha,
        "scope": args.scope,
        "project_id": project_id,
        "default_arm": GATED_ARM,
        "floors": {a: b["chosen"]["floor"] for a, b in arm_blocks.items()},
        "tolerance": dict(TOLERANCE),
        "arms": new_arms,
        "n_pairs": n_pairs,
        "live_rows": n_live,
        "recorded": datetime.now().date().isoformat(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(baseline, indent=2) + "\n", encoding="utf-8")
    print(f"Baseline written: {path}")
    return 0
