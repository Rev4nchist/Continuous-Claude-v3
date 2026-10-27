#!/usr/bin/env python3
"""Extraction precision harness: replay real transcripts through the extractor, no model calls.

One run compares two code trees ("before" and "after") on the same transcripts:

    uv run python scripts/core/eval_extraction.py sample  --out sample.json
    uv run python scripts/core/eval_extraction.py run \\
        --sample sample.json --before <dir with scripts/core> --after <dir with scripts/core> \\
        --out report.json [--labels labels.jsonl]

Safety:
- Each arm runs in its own subprocess, so module caches never mix.
- The child sets CONTINUOUS_CLAUDE_DB_URL to a dead local URL and CCV3_DISTILL=0.
- db.memory_factory.create_memory_service and store_learning.get_embedder are replaced by
  fakes that record their calls. A write that escapes the fakes fails against the dead URL.
- The distiller arm runs `claude -p` (subscription quota, about one call per run). It needs
  both --distill live and --allow-model-calls.

Pool widening (the same for both arms; the real extractor finds few candidates):
- --no-prefilter: has_perception_signal is forced True. The real answer is recorded.
- --user-tool-results: tool_result blocks inside user-type lines are also read.

Seeded noise: the real pool is accepted whole by both gates, so it cannot show the reject log
at work. Each run therefore adds SEEDED_SESSION, a short transcript of known NOISE thinking
blocks (each carries a perception signal but is under 30 characters, so gate B rejects it).
Pass 1 must write one reject-log line per block. Pass 2 must skip them all. A seeded block
never counts as a real candidate, and the precision numbers ignore it.

Passes: two passes per arm share one temp reject log, to measure re-proposals of candidates
that were rejected in pass 1. Labels: a JSONL file keyed by raw_hash,
{"raw_hash", "label": "durable"|"noise", "labeler"}. Without labels the report holds counts only.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

DEAD_DB_URL = "postgresql://127.0.0.1:1/none"  # port 1: nothing listens, no userinfo
PER_PROJECT_CAP = 5
SAMPLE_SIZE = 20
EXCERPT_CHARS = 400
SEEDED_SESSION = "seeded-noise"
# Known NOISE: a perception signal ("Ah, I see") and fewer than 30 characters.
SEEDED_NOISE_BLOCKS = (
    "Ah, I see it now.",
    "That makes sense.",
    "This explains it.",
    "Ah, I see. Ok.",
    "Ah, got it. Done.",
)


# ----------------------------------------------------------------------------- sample


def count_thinking_blocks(path: Path) -> int:
    n = 0
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if '"thinking"' not in line:
                    continue
                try:
                    data = json.loads(line)
                except ValueError:
                    continue
                content = (data.get("message") or {}).get("content")
                if data.get("type") == "assistant" and isinstance(content, list):
                    n += sum(
                        1
                        for b in content
                        if isinstance(b, dict) and b.get("type") == "thinking" and b.get("thinking")
                    )
    except OSError:
        return 0
    return n


def build_sample(projects_dir: Path, size: int = SAMPLE_SIZE) -> list[dict]:
    """Top transcripts by non-empty thinking-block count, at most 5 per project."""
    scored = []
    for path in projects_dir.glob("*/*.jsonl"):
        count = count_thinking_blocks(path)
        if count:
            scored.append((count, path))
    scored.sort(key=lambda x: (-x[0], str(x[1])))
    per_project: dict[str, int] = defaultdict(int)
    picked: list[dict] = []
    for count, path in scored:
        if per_project[path.parent.name] >= PER_PROJECT_CAP:
            continue
        per_project[path.parent.name] += 1
        picked.append({"session": path.stem, "path": str(path), "thinking_blocks": count})
        if len(picked) == size:
            break
    return picked


# ----------------------------------------------------------------------------- child


def _load_redactor(path: Path):
    spec = importlib.util.spec_from_file_location("_eval_redact", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["_eval_redact"] = module  # a dataclass in the module needs this
    spec.loader.exec_module(module)
    return module.redact


class _FakeMemory:
    def __init__(self, sink: list) -> None:
        self._sink = sink

    async def search_vector_for_dedup(self, *_a, **_k):
        return []

    async def store(self, content, metadata=None, **_k):
        self._sink.append({"content": content, "metadata": metadata or {}})
        return "fake-id"

    async def close(self):
        return None


class _FakeEmbedder:
    async def embed(self, _text):
        return [0.0] * 8


def child_main(args: argparse.Namespace) -> None:
    import asyncio

    arm_core = Path(args.opc_dir) / "scripts" / "core"
    arm_scripts = arm_core.parent
    sys.path.insert(0, str(arm_scripts))
    sys.path.insert(0, str(arm_core))
    os.environ["CONTINUOUS_CLAUDE_DB_URL"] = DEAD_DB_URL
    os.environ.pop("DATABASE_URL", None)
    os.environ["CCV3_DISTILL"] = "1" if args.distill == "live" else "0"
    temp = Path(tempfile.mkdtemp(prefix="eval-extraction-"))
    os.environ["CCV3_MEMORY_REJECT_LOG"] = str(temp / "rejects.jsonl")
    os.environ["CCV3_MEMORY_FAILURE_LOG"] = str(temp / "failures.jsonl")

    import db.memory_factory as factory
    import incremental_extract as ie
    import store_learning

    redact = _load_redactor(Path(args.redactor))
    stored: list[dict] = []

    async def fake_create(*_a, **_k):
        return _FakeMemory(stored)

    factory.create_memory_service = fake_create
    store_learning.get_embedder = lambda: _FakeEmbedder()

    sample = json.loads(Path(args.sample).read_text(encoding="utf-8"))
    seeded_path = temp / "seeded-noise.jsonl"
    seeded_path.write_text(
        "".join(
            json.dumps({"type": "assistant", "message": {"content": [
                {"type": "thinking", "thinking": block}]}}) + "\n"
            for block in SEEDED_NOISE_BLOCKS
        ),
        encoding="utf-8",
    )
    sample = [*sample, {"session": SEEDED_SESSION, "path": str(seeded_path)}]
    cands: dict[str, dict] = {}
    state = {"session": "", "accepted": set(), "gate_calls": 0}

    def note(raw: str, kind: str, prefilter: bool) -> None:
        h = ie.content_hash(raw)
        entry = cands.setdefault(
            h,
            {
                "raw_hash": h,
                "session": state["session"],
                "seeded": state["session"] == SEEDED_SESSION,
                "kind": kind,
                "prefilter_pass": prefilter,
                "gate_b": ie.score_extraction(raw)["classification"],
                "redaction_kinds": sorted(set(redact(raw).hits)),
                "excerpt": redact(raw).text[:EXCERPT_CHARS],
            },
        )
        entry["prefilter_pass"] = entry["prefilter_pass"] or prefilter

    orig_prefilter = ie.has_perception_signal
    def prefilter(text: str) -> bool:
        real = orig_prefilter(text)
        if real or args.no_prefilter:
            note(text, "thinking_block", real)
        return True if args.no_prefilter else real

    ie.has_perception_signal = prefilter

    orig_errors = ie.extract_tool_errors

    def widened_errors(line_data: dict) -> list[dict]:
        found = list(orig_errors(line_data))
        if args.user_tool_results and line_data.get("type") == "user":
            content = (line_data.get("message") or {}).get("content")
            for block in content if isinstance(content, list) else []:
                if not (isinstance(block, dict) and block.get("type") == "tool_result"):
                    continue
                body = block.get("content", "")
                if isinstance(body, list):
                    body = "\n".join(b.get("text", "") for b in body if isinstance(b, dict))
                if isinstance(body, str) and ie.has_error_pattern(body):
                    ctx = ie._extract_error_context(body)
                    if ctx:
                        found.append(
                            {"tool_name": block.get("tool_use_id", "unknown"),
                             "error_context": ctx, "input_summary": ""}
                        )
        for info in found:
            note(info.get("error_context", ""), "tool_error", True)
        return found

    ie.extract_tool_errors = widened_errors

    def hash_of(kwargs: dict, raw_for_hash: str) -> str:
        return kwargs.get("candidate_hash") or ie.content_hash(raw_for_hash)

    orig_think = ie.store_thinking_learning
    orig_error = ie.store_tool_error_learning

    async def think(*a, **k):
        before = len(stored)
        res = await orig_think(*a, **k)
        content = k.get("content") if "content" in k else a[0]
        if len(stored) > before:
            state["accepted"].add(hash_of(k, content))
        return res

    async def error(*a, **k):
        before = len(stored)
        res = await orig_error(*a, **k)
        info = k.get("error_info") if "error_info" in k else a[0]
        if len(stored) > before:
            state["accepted"].add(hash_of(k, info.get("error_context", "")))
        return res

    ie.store_thinking_learning = think
    ie.store_tool_error_learning = error

    orig_score = ie.score_extraction

    def counted_score(*a, **k):
        state["gate_calls"] += 1
        return orig_score(*a, **k)

    ie.score_extraction = counted_score

    passes = []
    for pass_no in (1, 2):
        stored.clear()
        state["accepted"] = set()
        state["gate_calls"] = 0
        totals = defaultdict(int)
        seen_before = set(cands)
        for item in sample:
            state["session"] = item["session"]
            result = asyncio.run(
                ie.extract_incremental(
                    item["path"], item["session"],
                    state_file=str(temp / f"state-{pass_no}-{item['session']}.json"),
                    max_learnings=100000,
                )
            )
            for key in ("learnings_stored", "learnings_skipped", "learnings_deduped",
                        "learnings_rejected_before"):
                totals[key] += result.get(key, 0)
        leaks = sum(1 for r in stored if redact(r["content"]).hits)
        provenance_ok = sum(
            1 for r in stored
            if r["metadata"].get("source") and r["metadata"].get("session_id")
            and "is_inference" in r["metadata"]
        )
        passes.append(
            {
                "pass": pass_no,
                "accepted_hashes": sorted(state["accepted"]),
                "rows_stored": len(stored),
                "rows_with_raw_secret": leaks,
                "rows_with_provenance": provenance_ok,
                "gate_b_calls": state["gate_calls"],
                "new_candidates_seen": len(set(cands) - seen_before),
                **dict(totals),
            }
        )

    rejects_path = Path(os.environ["CCV3_MEMORY_REJECT_LOG"])
    stages: dict[str, int] = defaultdict(int)
    if rejects_path.exists():
        for line in rejects_path.read_text(encoding="utf-8").splitlines():
            try:
                stages[json.loads(line)["stage"]] += 1
            except (ValueError, KeyError):
                continue
    print(json.dumps({"candidates": list(cands.values()), "passes": passes,
                      "reject_log_stages": dict(stages)}))
    shutil.rmtree(temp, ignore_errors=True)


# ----------------------------------------------------------------------------- parent


def wilson(successes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def run_arm(args: argparse.Namespace, opc_dir: str) -> dict:
    cmd = [
        sys.executable, os.path.abspath(__file__), "child",
        "--opc-dir", opc_dir, "--sample", args.sample, "--distill", args.distill,
        "--redactor", str(Path(__file__).resolve().parent / "db" / "memory_redact.py"),
    ]
    if args.no_prefilter:
        cmd.append("--no-prefilter")
    if args.user_tool_results:
        cmd.append("--user-tool-results")
    env = dict(os.environ, CONTINUOUS_CLAUDE_DB_URL=DEAD_DB_URL, CCV3_DISTILL="0")
    proc = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", env=env, timeout=3600
    )
    if proc.returncode != 0:
        raise SystemExit(f"arm failed ({opc_dir}): {proc.stderr[-800:]}")
    return json.loads(proc.stdout.strip().splitlines()[-1])


def summarize(arm: dict, labels: dict[str, str]) -> dict:
    cands = {c["raw_hash"]: c for c in arm["candidates"] if not c.get("seeded")}
    seeded = {c["raw_hash"] for c in arm["candidates"] if c.get("seeded")}
    p1, p2 = arm["passes"]
    accepted = set(p1["accepted_hashes"])
    out = {
        "candidates": len(cands),
        "accepted_pass1": len(accepted),
        "rows_with_raw_secret_pass1": p1["rows_with_raw_secret"],
        "rows_with_provenance_pass1": p1["rows_with_provenance"],
        "rows_stored_pass1": p1["rows_stored"],
        "skipped_pass1": p1.get("learnings_skipped", 0),
        "reject_log_stages": arm["reject_log_stages"],
        "candidates_with_secrets": sum(1 for c in cands.values() if c["redaction_kinds"]),
        "redaction_kinds": sorted({k for c in cands.values() for k in c["redaction_kinds"]}),
    }
    rejected1 = (set(cands) | seeded) - accepted
    skips2 = p2.get("learnings_rejected_before", 0)
    out["seeded_noise_blocks"] = len(seeded)
    out["seeded_rejected_pass1"] = len(seeded - accepted)
    out["rejected_pass1"] = len(rejected1)
    out["pass2_rejected_before_skips"] = skips2
    out["pass2_reproposals_of_rejected"] = max(0, len(rejected1) - skips2)
    labelled_accepted = [h for h in accepted if h in labels]
    if labels:
        durable = sum(1 for h in labelled_accepted if labels[h] == "durable")
        n = len(labelled_accepted)
        lo, hi = wilson(durable, n)
        all_durable = [h for h in cands if labels.get(h) == "durable"]
        out.update(
            {
                "labelled_accepted": n,
                "durable_accepted": durable,
                "precision": round(durable / n, 3) if n else None,
                "precision_wilson95": [round(lo, 3), round(hi, 3)],
                "durable_recall": round(
                    sum(1 for h in all_durable if h in accepted) / len(all_durable), 3
                ) if all_durable else None,
                "unlabelled_accepted": len(accepted) - n,
            }
        )
        by_kind: dict[str, dict] = {}
        for kind in ("thinking_block", "tool_error"):
            pool = [h for h in accepted if cands[h]["kind"] == kind]
            done = [h for h in pool if h in labels]
            hit = sum(1 for h in done if labels[h] == "durable")
            lo, hi = wilson(hit, len(done))
            by_kind[kind] = {
                "accepted": len(pool), "labelled": len(done), "durable": hit,
                "precision": round(hit / len(done), 3) if done else None,
                "wilson95": [round(lo, 3), round(hi, 3)],
            }
        out["by_kind"] = by_kind
        weighted = sum(
            v["accepted"] * v["precision"] for v in by_kind.values() if v["precision"] is not None
        )
        out["precision_weighted_by_pool"] = round(weighted / len(accepted), 3) if accepted else None
    return out


def parent_main(args: argparse.Namespace) -> None:
    if args.distill == "live" and not args.allow_model_calls:
        raise SystemExit("--distill live needs --allow-model-calls (it runs claude -p)")
    labels: dict[str, str] = {}
    if args.labels and Path(args.labels).exists():
        for line in Path(args.labels).read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
                labels[row["raw_hash"]] = row["label"]
            except (ValueError, KeyError):
                continue
    sample = json.loads(Path(args.sample).read_text(encoding="utf-8"))
    report = {
        "n_sessions": len(sample),
        "sessions": [s["session"] for s in sample],
        "widening": {
            "no_prefilter": args.no_prefilter,
            "user_tool_results": args.user_tool_results,
        },
        "distill": args.distill,
        "labels": len(labels),
    }
    arms = {}
    for name, opc_dir in (("before", args.before), ("after", args.after)):
        arms[name] = run_arm(args, opc_dir)
        report[name] = summarize(arms[name], labels)
    # The reject-log proof is vacuous unless every seeded NOISE block reached gate B and
    # the after arm rejected it.
    want = len(SEEDED_NOISE_BLOCKS)
    got = (report["after"]["seeded_noise_blocks"], report["after"]["seeded_rejected_pass1"])
    if got != (want, want):
        raise SystemExit(f"seeded NOISE blocks: want {want} seen and rejected, got {got}")
    Path(args.out).write_text(json.dumps(report, indent=2), encoding="utf-8")
    if args.candidates_out:
        rows = {c["raw_hash"]: c for arm in arms.values() for c in arm["candidates"]}
        accepted = {h for arm in arms.values() for h in arm["passes"][0]["accepted_hashes"]}
        with Path(args.candidates_out).open("w", encoding="utf-8") as handle:
            for h, c in rows.items():
                handle.write(json.dumps({**c, "accepted": h in accepted}) + "\n")
    print(json.dumps(report, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_sample = sub.add_parser("sample")
    p_sample.add_argument("--projects-dir", default=str(Path.home() / ".claude" / "projects"))
    p_sample.add_argument("--size", type=int, default=SAMPLE_SIZE)
    p_sample.add_argument("--out", required=True)

    for name in ("run", "child"):
        p = sub.add_parser(name)
        p.add_argument("--sample", required=True)
        p.add_argument("--distill", choices=["off", "live"], default="off")
        p.add_argument("--no-prefilter", action="store_true")
        p.add_argument("--user-tool-results", action="store_true")
        if name == "run":
            p.add_argument("--before", required=True, help="opc dir of the base code")
            p.add_argument("--after", required=True, help="opc dir of the changed code")
            p.add_argument("--out", required=True)
            p.add_argument("--labels")
            p.add_argument("--candidates-out")
            p.add_argument("--allow-model-calls", action="store_true")
        else:
            p.add_argument("--opc-dir", required=True)
            p.add_argument("--redactor", required=True)

    args = parser.parse_args()
    if args.cmd == "sample":
        sample = build_sample(Path(args.projects_dir), args.size)
        Path(args.out).write_text(json.dumps(sample, indent=2), encoding="utf-8")
        blocks = sum(s["thinking_blocks"] for s in sample)
        print(f"sample: {len(sample)} transcripts, {blocks} blocks")
    elif args.cmd == "child":
        child_main(args)
    else:
        parent_main(args)


if __name__ == "__main__":
    main()
