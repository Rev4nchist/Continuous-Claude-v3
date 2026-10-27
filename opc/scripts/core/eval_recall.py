#!/usr/bin/env python3
"""NDCG@5 + latency eval harness for the Phase 2 reranker.

Measures retrieval quality (NDCG@5) and wall-clock latency (P50/P95) of
``recall_learnings.py`` with and without ``--rerank``, against a fixed
``(query, relevant_id)`` eval set. Emits both a machine-readable JSON
report and a human-readable Markdown report.

This is the measurement infrastructure for the Phase 2 decision gate
(Task 3.2). The decision gate fires on two thresholds:

* NDCG@5 lift >= +10% (rerank vs baseline)  -> "rerank meaningfully wins"
* P95 latency <= 500ms                       -> "fast enough to default-on"

Both pass -> flip ``--rerank`` to default-on. Lift only -> keep opt-in.
Neither -> drop the feature.

USAGE:

  # Baseline arm only (no rerank, fast sanity check):
  uv run --project opc python opc/scripts/core/eval_recall.py \\
    --eval-set opc/tests/recall_eval_set.jsonl --k 5 \\
    --baseline-only \\
    --report-json opc/tests/recall_eval_report.json \\
    --report-md opc/tests/recall_eval_report.md

  # Full eval (both arms, with daemon management):
  uv run --project opc python opc/scripts/core/eval_recall.py \\
    --eval-set opc/tests/recall_eval_set.jsonl --k 5 \\
    --daemon-mode --warmup \\
    --report-json opc/tests/recall_eval_report.json \\
    --report-md opc/tests/recall_eval_report.md

  # Smoke test (first 3 pairs, baseline only):
  uv run --project opc python opc/scripts/core/eval_recall.py \\
    --eval-set opc/tests/recall_eval_set.jsonl --k 5 \\
    --max-pairs 3 --baseline-only \\
    --report-json /tmp/smoke.json --report-md /tmp/smoke.md

OUTPUT (JSON shape):
    {
      "_meta": {...run metadata...},
      "baseline": {mean_ndcg_at_5, found_rate, p50_ms, p95_ms, by_type, by_scope},
      "rerank":   {... same shape ...},
      "comparison": {ndcg_lift_pct, by_type_lift, rescued/demoted/shuffled counts + ids},
      "per_pair":  [{query, relevant_id, type, scope, baseline, rerank, verdict}, ...]
    }

OUTPUT (Markdown):
    Decision-gate-ready summary, per-type/scope tables, rescued/demoted detail.

CONSTRAINTS:
    - DOES NOT modify recall_learnings.py or rerank.py (off-limits per Task 2.1).
    - DOES NOT run the full eval set itself (that's Task 2.2 / arbiter).
    - DOES smoke-test the plumbing with --max-pairs N.
"""

from __future__ import annotations

import argparse
import atexit
import json
import math
import os
import socket
import statistics
import struct
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Bootstrap sys.path so `core.*` is importable when this script is run directly
# (mirrors the pattern in recall_learnings.py:57). Must come before any project
# imports so failures surface at launch, not mid-eval.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from core.utils import percentile as _pct  # noqa: E402

# Daemon discovery file path mirrors rerank.py's DAEMON_INFO_PATH so we can
# inspect it without importing the rerank module (which would pull torch
# transitively). Kept in sync with opc/scripts/core/rerank.py:72.
DAEMON_INFO_PATH = Path(tempfile.gettempdir()) / "ccv3-rerank.json"

# Decision-gate thresholds (Task 3.2). Documented here for transparency; the
# Markdown report cites these values verbatim. Updating them is a deliberate
# protocol change, not a casual tweak.
DECISION_GATE_NDCG_LIFT_PCT = 10.0
DECISION_GATE_P95_LATENCY_MS = 500.0


# ---------------------------------------------------------------------------
# NDCG@K
# ---------------------------------------------------------------------------

def ndcg_at_k(top_k_ids: list[str], relevant_id: str, k: int) -> float:
    """Binary-relevance NDCG@K with a single relevant document.

    DCG@K  = sum_{i=0..k-1} rel_i / log2(i + 2)
    IDCG@K = 1.0  (single relevant doc, ideal position 1)
    NDCG@K = DCG@K / IDCG@K

    Returns 0.0 if ``relevant_id`` is not in ``top_k_ids[:k]``.
    """
    if not relevant_id:
        return 0.0
    for i, rid in enumerate(top_k_ids[:k]):
        if str(rid) == str(relevant_id):
            # rel_i = 1 at position i (0-indexed), log2(i+2): pos 1 -> log2(2)=1
            return 1.0 / math.log2(i + 2)
    return 0.0


# ---------------------------------------------------------------------------
# Eval set loading
# ---------------------------------------------------------------------------

def load_eval_set(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Load the JSONL eval set; return (header_meta, pairs).

    Lines starting with ``{"_header"`` are treated as the metadata header.
    All other lines must have ``query``, ``relevant_id``, ``type``, ``scope``,
    ``confidence`` fields.
    """
    if not path.exists():
        raise FileNotFoundError(f"eval set not found: {path}")

    header: dict[str, Any] = {}
    pairs: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                row = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"{path}:{lineno}: invalid JSON: {exc}"
                ) from exc
            if "_header" in row:
                header = row
                continue
            required = {"query", "relevant_id", "type", "scope", "confidence"}
            missing = required - row.keys()
            if missing:
                raise ValueError(
                    f"{path}:{lineno}: missing fields {sorted(missing)}"
                )
            pairs.append(row)
    return header, pairs


# ---------------------------------------------------------------------------
# Daemon lifecycle (TCP loopback on 127.0.0.1, discovery via $TEMP/ccv3-rerank.json)
# ---------------------------------------------------------------------------

def _send_recv_frame(port: int, payload: dict[str, Any],
                     timeout_s: float = 5.0) -> dict[str, Any] | None:
    """Send a length-prefixed JSON frame to the rerank daemon, receive reply.

    Frame protocol mirrors rerank.py: 4-byte big-endian length, then payload.
    Returns None on any socket / decode failure.
    """
    try:
        body = json.dumps(payload).encode("utf-8")
        header = struct.pack(">I", len(body))
        with socket.create_connection(("127.0.0.1", port), timeout=timeout_s) as sock:
            sock.settimeout(timeout_s)
            sock.sendall(header + body)
            # Receive length-prefixed reply.
            head = b""
            while len(head) < 4:
                chunk = sock.recv(4 - len(head))
                if not chunk:
                    return None
                head += chunk
            (reply_len,) = struct.unpack(">I", head)
            reply = b""
            while len(reply) < reply_len:
                chunk = sock.recv(min(8192, reply_len - len(reply)))
                if not chunk:
                    return None
                reply += chunk
            return json.loads(reply.decode("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _read_daemon_info() -> dict[str, Any] | None:
    """Read $TEMP/ccv3-rerank.json; return None if absent or invalid."""
    if not DAEMON_INFO_PATH.exists():
        return None
    try:
        return json.loads(DAEMON_INFO_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _pid_alive(pid: int) -> bool:
    """Cross-platform PID liveness check (mirrors rerank.py:_pid_alive)."""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        try:
            import ctypes  # noqa: PLC0415
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            handle = kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, pid,
            )
            if not handle:
                return False
            kernel32.CloseHandle(handle)
            return True
        except Exception:  # noqa: BLE001
            return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def _daemon_reachable(timeout_s: float = 2.0) -> tuple[bool, dict[str, Any] | None]:
    """Check both the discovery file AND a ping round-trip.

    Returns ``(reachable, info)``. ``info`` is the parsed discovery dict
    when the file exists, even if the daemon doesn't reply.
    """
    info = _read_daemon_info()
    if not info:
        return False, None
    pid = int(info.get("pid", 0))
    port = int(info.get("port", 0))
    if not _pid_alive(pid) or port <= 0:
        return False, info
    reply = _send_recv_frame(port, {"cmd": "ping"}, timeout_s=timeout_s)
    if reply and reply.get("status") == "ok":
        return True, info
    return False, info


def _wait_for_daemon(timeout_s: float = 60.0,
                     poll_interval: float = 1.0) -> dict[str, Any] | None:
    """Poll until the daemon answers ping or timeout elapses."""
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < timeout_s:
        reachable, info = _daemon_reachable(timeout_s=2.0)
        if reachable:
            return info
        time.sleep(poll_interval)
    return None


class DaemonManager:
    """Owns the rerank daemon for the duration of the eval run.

    If --daemon-mode is set:
      * Reuse an existing healthy daemon (don't kill the user's session daemon).
      * Otherwise spawn one in the background and tear it down on exit.

    The ``spawned_by_us`` flag controls cleanup: we never kill a daemon we
    didn't start (avoids stomping on other terminals).
    """

    def __init__(self, enabled: bool, repo_root: Path, startup_timeout_s: float = 180.0) -> None:
        self.enabled = enabled
        self.repo_root = repo_root
        self.startup_timeout_s = startup_timeout_s
        self.info: dict[str, Any] | None = None
        self.spawned_by_us = False
        self.proc: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        if not self.enabled:
            return
        reachable, info = _daemon_reachable(timeout_s=2.0)
        if reachable and info:
            self.info = info
            self.spawned_by_us = False
            print(
                f"[eval] reusing existing rerank daemon "
                f"(pid={info.get('pid')}, port={info.get('port')})",
                file=sys.stderr,
            )
            return

        # Spawn a fresh daemon. We don't try to clean up a stale discovery
        # file ourselves; rerank.py will overwrite it on startup.
        print("[eval] spawning rerank daemon (this can take ~30-50s on cold start)...",
              file=sys.stderr)
        rerank_path = self.repo_root / "opc" / "scripts" / "core" / "rerank.py"
        if not rerank_path.exists():
            raise FileNotFoundError(f"rerank.py not found: {rerank_path}")

        # Detach so the daemon survives this script's exit if cleanup fails.
        # On Windows, CREATE_NEW_PROCESS_GROUP keeps it independent.
        creationflags = 0
        if sys.platform == "win32":
            creationflags = (
                subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
                | getattr(subprocess, "CREATE_NO_WINDOW", 0)
            )
        # Capture daemon stderr to a tempfile so startup failures are diagnosable.
        daemon_log_path = Path(tempfile.gettempdir()) / "ccv3-rerank-daemon.log"
        print(f"[eval] daemon stderr -> {daemon_log_path}", file=sys.stderr)
        daemon_log = open(daemon_log_path, "w")  # noqa: WPS515
        self.proc = subprocess.Popen(  # noqa: S603
            [
                "uv", "run", "--project", str(self.repo_root / "opc"),
                "python", str(rerank_path),
                "--daemon", "--port", "0",
            ],
            cwd=str(self.repo_root),
            stdout=subprocess.DEVNULL,
            stderr=daemon_log,
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        self.spawned_by_us = True

        info = _wait_for_daemon(timeout_s=self.startup_timeout_s, poll_interval=1.0)
        if not info:
            raise RuntimeError(
                f"rerank daemon failed to become ready within {self.startup_timeout_s}s "
                f"(discovery file: {DAEMON_INFO_PATH}; "
                f"see daemon log: {daemon_log_path})"
            )
        self.info = info
        print(
            f"[eval] rerank daemon ready (pid={info.get('pid')}, "
            f"port={info.get('port')})",
            file=sys.stderr,
        )

    def stop(self) -> None:
        if not self.enabled or not self.spawned_by_us or not self.info:
            return
        port = int(self.info.get("port", 0))
        if port <= 0:
            return
        # Polite shutdown via TCP frame; rerank.py's handler tears the server
        # down and unlinks the discovery file.
        _send_recv_frame(port, {"cmd": "shutdown"}, timeout_s=5.0)

        # Give the daemon up to 10s to clean up.
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < 10.0:
            if not DAEMON_INFO_PATH.exists():
                break
            time.sleep(0.5)

        # Last resort: terminate the subprocess. Only kill if the discovery
        # file is still here (which means shutdown frame didn't take).
        if DAEMON_INFO_PATH.exists() and self.proc is not None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=5.0)
            except (subprocess.TimeoutExpired, OSError):
                try:
                    self.proc.kill()
                except OSError:
                    pass
            # Best-effort discovery file cleanup.
            try:
                DAEMON_INFO_PATH.unlink()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Recall subprocess invocation
# ---------------------------------------------------------------------------

def run_recall(
    repo_root: Path,
    query: str,
    k: int,
    rerank: bool,
    timeout_s: float,
    all_projects: bool = True,
) -> tuple[list[str], float, str | None, dict[str, Any]]:
    """Invoke recall_learnings.py --json once; return (ids, latency_ms, error, meta).

    The eval set spans PROJECT learnings tagged to multiple projects plus
    GLOBAL ones. By default we pass ``--all-projects`` so the recall side
    sees the full pool regardless of CWD; otherwise PROJECT entries tagged
    to *other* projects (or untagged ones) get filtered out and the eval is
    invalid.

    On any subprocess failure / JSON parse failure / DB error, the returned
    error string is non-empty and ids is an empty list. We never raise here
    so the eval loop can continue past degenerate pairs.
    """
    recall_path = repo_root / "opc" / "scripts" / "core" / "recall_learnings.py"
    cmd = [
        "uv", "run", "--project", str(repo_root / "opc"),
        "python", str(recall_path),
        "--query", query,
        "--k", str(k),
        "--json",
    ]
    if all_projects:
        cmd.append("--all-projects")
    if rerank:
        cmd.append("--rerank")

    t0 = time.perf_counter()
    try:
        proc = subprocess.run(  # noqa: S603
            cmd,
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return [], (time.perf_counter() - t0) * 1000.0, "timeout", {}
    except OSError as exc:
        return [], (time.perf_counter() - t0) * 1000.0, f"oserror:{exc}", {}

    latency_ms = (time.perf_counter() - t0) * 1000.0

    if proc.returncode != 0:
        return [], latency_ms, (
            f"returncode={proc.returncode}; stderr_tail="
            f"{(proc.stderr or '')[-200:]!r}"
        ), {}

    # recall_learnings.py prints exactly one JSON document to stdout in --json
    # mode (followed by trailing newline). But it can also print warnings to
    # stderr that should NOT be parsed as the result document.
    stdout = (proc.stdout or "").strip()
    if not stdout:
        return [], latency_ms, "empty_stdout", {}
    try:
        doc = json.loads(stdout)
    except json.JSONDecodeError:
        # Try to recover: take the last non-empty line. Some hooks may inject
        # context lines on stdout.
        candidates = [ln for ln in stdout.splitlines() if ln.strip().startswith("{")]
        doc = None
        for line in reversed(candidates):
            try:
                doc = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
        if doc is None:
            return [], latency_ms, (
                f"json_decode_error; stdout_tail={stdout[-200:]!r}"
            ), {}

    if "error" in doc:
        return [], latency_ms, f"recall_error:{doc['error']}", doc.get("_meta", {})

    results = doc.get("results", []) or []
    ids = [str(r.get("id", "")) for r in results if r.get("id")]
    meta = doc.get("_meta", {}) or {}
    return ids, latency_ms, None, meta


# ---------------------------------------------------------------------------
# Aggregations
# ---------------------------------------------------------------------------

def _percentile(values: list[float], p: float) -> float:
    """Nearest-rank percentile. Delegates to core.utils.percentile.

    (Phase 2 MEDIUM-4: previously an inline linear-interpolation formula.
    Replaced with the canonical nearest-rank implementation shared across
    rerank.py, eval_recall.py, and embedding_daemon.py.)
    """
    if not values:
        return 0.0
    return _pct(values, p)


def aggregate_arm(
    per_pair_records: list[dict[str, Any]],
    arm_key: str,
    warmup_count: int,
) -> dict[str, Any]:
    """Build the per-arm aggregate block.

    Pairs whose arm-side ``error`` is set are excluded from latency stats
    (we don't want timeouts skewing P95). They're still counted in NDCG
    (with ndcg=0, found=False) so missing data is conservative.
    """
    ndcgs: list[float] = []
    latencies_post_warmup: list[float] = []
    found_count = 0
    by_type: dict[str, list[float]] = {}
    by_scope: dict[str, list[float]] = {}
    by_type_found: dict[str, int] = {}
    by_type_total: dict[str, int] = {}

    for idx, rec in enumerate(per_pair_records):
        arm = rec.get(arm_key, {}) or {}
        ndcg = float(arm.get("ndcg_at_5", 0.0))
        ndcgs.append(ndcg)
        ptype = rec.get("type", "UNKNOWN")
        pscope = rec.get("scope", "UNKNOWN")
        by_type.setdefault(ptype, []).append(ndcg)
        by_scope.setdefault(pscope, []).append(ndcg)
        by_type_total[ptype] = by_type_total.get(ptype, 0) + 1
        if ndcg > 0.0:
            found_count += 1
            by_type_found[ptype] = by_type_found.get(ptype, 0) + 1
        # Skip warmup pairs and errored pairs for latency.
        if idx < warmup_count:
            continue
        if arm.get("error"):
            continue
        lat = arm.get("latency_ms")
        if isinstance(lat, (int, float)):
            latencies_post_warmup.append(float(lat))

    n = len(per_pair_records)
    return {
        "n_pairs": n,
        "mean_ndcg_at_5": (sum(ndcgs) / n) if n else 0.0,
        "found_count": found_count,
        "found_rate": (found_count / n) if n else 0.0,
        "p50_ms": _percentile(latencies_post_warmup, 50),
        "p95_ms": _percentile(latencies_post_warmup, 95),
        "latency_sample_n": len(latencies_post_warmup),
        "by_type": {
            t: (sum(v) / len(v)) if v else 0.0 for t, v in sorted(by_type.items())
        },
        "by_type_found_rate": {
            t: (by_type_found.get(t, 0) / by_type_total[t]) if by_type_total[t] else 0.0
            for t in sorted(by_type_total)
        },
        "by_type_n": {t: by_type_total[t] for t in sorted(by_type_total)},
        "by_scope": {
            s: (sum(v) / len(v)) if v else 0.0 for s, v in sorted(by_scope.items())
        },
        "by_scope_n": {s: len(v) for s, v in sorted(by_scope.items())},
    }


def classify_verdict(baseline_ids: list[str], rerank_ids: list[str],
                     relevant_id: str, k: int) -> str:
    """Per-pair verdict for the comparison view.

    * ``both_miss``        - relevant_id not in either top-K
    * ``rescued``          - missing in baseline top-K, present in rerank top-K
    * ``demoted``          - present in baseline top-K, missing in rerank top-K
    * ``baseline_match``   - both top-K identical lists (no rerank reordering)
    * ``shuffled_improved`` - both contain relevant_id, rerank rank is better
    * ``shuffled_worse``    - both contain, rerank rank is worse
    * ``shuffled_no_change`` - both contain, same rank but different surrounding order
    """
    in_baseline = relevant_id in baseline_ids[:k]
    in_rerank = relevant_id in rerank_ids[:k]
    if not in_baseline and not in_rerank:
        return "both_miss"
    if not in_baseline and in_rerank:
        return "rescued"
    if in_baseline and not in_rerank:
        return "demoted"
    # Both contain. Look at rank.
    b_rank = baseline_ids[:k].index(relevant_id)
    r_rank = rerank_ids[:k].index(relevant_id)
    if baseline_ids[:k] == rerank_ids[:k]:
        return "baseline_match"
    if r_rank < b_rank:
        return "shuffled_improved"
    if r_rank > b_rank:
        return "shuffled_worse"
    return "shuffled_no_change"


def build_comparison(per_pair_records: list[dict[str, Any]],
                     baseline_agg: dict[str, Any],
                     rerank_agg: dict[str, Any]) -> dict[str, Any]:
    """Build the comparison block. Both arms must have run."""
    rescued_ids: list[str] = []
    demoted_ids: list[str] = []
    shuffled_no_change_ids: list[str] = []
    shuffled_improved_ids: list[str] = []
    shuffled_worse_ids: list[str] = []
    both_miss_ids: list[str] = []
    baseline_match_ids: list[str] = []

    for rec in per_pair_records:
        verdict = rec.get("verdict", "")
        rid = rec.get("relevant_id", "")
        if verdict == "rescued":
            rescued_ids.append(rid)
        elif verdict == "demoted":
            demoted_ids.append(rid)
        elif verdict == "shuffled_no_change":
            shuffled_no_change_ids.append(rid)
        elif verdict == "shuffled_improved":
            shuffled_improved_ids.append(rid)
        elif verdict == "shuffled_worse":
            shuffled_worse_ids.append(rid)
        elif verdict == "both_miss":
            both_miss_ids.append(rid)
        elif verdict == "baseline_match":
            baseline_match_ids.append(rid)

    b_ndcg = baseline_agg.get("mean_ndcg_at_5", 0.0) or 0.0
    r_ndcg = rerank_agg.get("mean_ndcg_at_5", 0.0) or 0.0
    if b_ndcg > 0:
        lift_pct = (r_ndcg - b_ndcg) / b_ndcg * 100.0
    elif r_ndcg > 0:
        # Baseline is 0 but rerank is nonzero: infinite lift, report as a
        # sentinel rather than crash. Markdown formatter handles this.
        lift_pct = float("inf")
    else:
        lift_pct = 0.0

    by_type_lift: dict[str, float] = {}
    baseline_by_type = baseline_agg.get("by_type", {}) or {}
    rerank_by_type = rerank_agg.get("by_type", {}) or {}
    for t in sorted(set(baseline_by_type) | set(rerank_by_type)):
        b = baseline_by_type.get(t, 0.0)
        r = rerank_by_type.get(t, 0.0)
        if b > 0:
            by_type_lift[t] = (r - b) / b * 100.0
        elif r > 0:
            by_type_lift[t] = float("inf")
        else:
            by_type_lift[t] = 0.0

    return {
        "ndcg_lift_pct": lift_pct,
        "by_type_lift_pct": by_type_lift,
        "rescued_count": len(rescued_ids),
        "demoted_count": len(demoted_ids),
        "shuffled_no_change_count": len(shuffled_no_change_ids),
        "shuffled_improved_count": len(shuffled_improved_ids),
        "shuffled_worse_count": len(shuffled_worse_ids),
        "both_miss_count": len(both_miss_ids),
        "baseline_match_count": len(baseline_match_ids),
        "rescued_ids": rescued_ids,
        "demoted_ids": demoted_ids,
        "shuffled_no_change_ids": shuffled_no_change_ids,
    }


# ---------------------------------------------------------------------------
# Decision gate evaluation
# ---------------------------------------------------------------------------

def evaluate_decision_gate(comparison: dict[str, Any],
                           rerank_agg: dict[str, Any]) -> dict[str, Any]:
    """Compare measured metrics to the Phase 2 gate thresholds."""
    lift = comparison.get("ndcg_lift_pct", 0.0)
    p95 = rerank_agg.get("p95_ms", 0.0)

    # Inf lift counts as pass; NaN does not.
    lift_pass = (
        lift == float("inf") or
        (isinstance(lift, (int, float)) and lift >= DECISION_GATE_NDCG_LIFT_PCT)
    )
    latency_pass = isinstance(p95, (int, float)) and p95 <= DECISION_GATE_P95_LATENCY_MS

    if lift_pass and latency_pass:
        decision = "default-on"
        rationale = "NDCG lift and P95 latency both pass; flip --rerank to default."
    elif lift_pass and not latency_pass:
        decision = "opt-in"
        rationale = (
            "NDCG lift passes but P95 latency exceeds the gate; keep --rerank "
            "opt-in until latency improves (smaller model, batching, GPU)."
        )
    else:
        decision = "drop"
        rationale = (
            "NDCG lift below the gate threshold; reranker does not pay for "
            "itself even ignoring latency. Drop or revisit the candidate pool."
        )

    return {
        "ndcg_lift_pct_measured": lift,
        "ndcg_lift_pct_threshold": DECISION_GATE_NDCG_LIFT_PCT,
        "ndcg_lift_pass": lift_pass,
        "p95_ms_measured": p95,
        "p95_ms_threshold": DECISION_GATE_P95_LATENCY_MS,
        "p95_latency_pass": latency_pass,
        "decision": decision,
        "rationale": rationale,
    }


# ---------------------------------------------------------------------------
# Markdown rendering
# ---------------------------------------------------------------------------

def _fmt_pct(v: Any) -> str:
    """Format a percentage value for the markdown report.

    Handles inf (baseline 0 lift), None, and ordinary floats.
    """
    if v is None:
        return "n/a"
    if isinstance(v, float) and math.isinf(v):
        return "inf"
    if isinstance(v, float) and math.isnan(v):
        return "nan"
    return f"{float(v):+.1f}%"


def _fmt_ms(v: Any) -> str:
    if v is None:
        return "n/a"
    if isinstance(v, (int, float)):
        return f"{float(v):.0f}ms"
    return str(v)


def _fmt_ndcg(v: Any) -> str:
    if v is None:
        return "n/a"
    return f"{float(v):.3f}"


def _short_id(rid: str) -> str:
    return (rid[:8] + "...") if rid and len(rid) > 8 else rid


def render_markdown(report: dict[str, Any]) -> str:
    """Render the human-readable markdown report from the JSON report dict."""
    meta = report.get("_meta", {}) or {}
    baseline = report.get("baseline")
    rerank = report.get("rerank")
    comparison = report.get("comparison")
    gate = report.get("decision_gate")
    per_pair = report.get("per_pair", []) or []

    lines: list[str] = []
    lines.append("# Recall Eval Report — Phase 2 Reranker")
    lines.append("")
    lines.append(f"*Generated: {meta.get('ran_at', 'unknown')}*")
    lines.append("")
    lines.append("## Run Metadata")
    lines.append("")
    lines.append("| Field | Value |")
    lines.append("|-------|-------|")
    lines.append(f"| Eval set | `{meta.get('eval_set', '')}` |")
    lines.append(f"| Pairs evaluated | {meta.get('n_pairs', 0)} |")
    lines.append(f"| K | {meta.get('k', 5)} |")
    lines.append(f"| Reranker model | `{meta.get('model', 'n/a')}` |")
    lines.append(f"| Max length | {meta.get('max_length', 'n/a')} |")
    lines.append(f"| Rerank top-N | {meta.get('rerank_top_n', 'n/a')} |")
    lines.append(f"| Daemon mode | {meta.get('daemon_mode', False)} |")
    lines.append(f"| Warmup excluded | {meta.get('warmup_skipped', False)} (n={meta.get('warmup_count', 0)}) |")
    lines.append(f"| Baseline arm ran | {baseline is not None} |")
    lines.append(f"| Rerank arm ran | {rerank is not None} |")
    lines.append("")

    if baseline is not None or rerank is not None:
        lines.append("## Summary")
        lines.append("")
        lines.append("| Metric | Baseline | Rerank | Lift |")
        lines.append("|--------|----------|--------|------|")
        b_ndcg = (baseline or {}).get("mean_ndcg_at_5")
        r_ndcg = (rerank or {}).get("mean_ndcg_at_5")
        lift = (comparison or {}).get("ndcg_lift_pct") if comparison else None
        lines.append(
            f"| Mean NDCG@5 | {_fmt_ndcg(b_ndcg)} | {_fmt_ndcg(r_ndcg)} | "
            f"{_fmt_pct(lift)} |"
        )
        b_found = (baseline or {}).get("found_rate")
        r_found = (rerank or {}).get("found_rate")
        b_found_s = f"{(b_found or 0) * 100:.1f}%" if b_found is not None else "n/a"
        r_found_s = f"{(r_found or 0) * 100:.1f}%" if r_found is not None else "n/a"
        lines.append(f"| Found rate (in top-{meta.get('k', 5)}) | {b_found_s} | {r_found_s} | - |")
        lines.append(
            f"| P50 latency | {_fmt_ms((baseline or {}).get('p50_ms'))} | "
            f"{_fmt_ms((rerank or {}).get('p50_ms'))} | - |"
        )
        lines.append(
            f"| P95 latency | {_fmt_ms((baseline or {}).get('p95_ms'))} | "
            f"{_fmt_ms((rerank or {}).get('p95_ms'))} | - |"
        )
        lines.append(
            f"| Latency sample n | {(baseline or {}).get('latency_sample_n', 0)} | "
            f"{(rerank or {}).get('latency_sample_n', 0)} | - |"
        )
        lines.append("")

    # By-type table
    if baseline is not None or rerank is not None:
        lines.append("## NDCG@5 by Type")
        lines.append("")
        lines.append("| Type | n | Baseline | Rerank | Lift |")
        lines.append("|------|---|----------|--------|------|")
        baseline_by_type = (baseline or {}).get("by_type", {}) or {}
        rerank_by_type = (rerank or {}).get("by_type", {}) or {}
        by_type_n = (baseline or rerank or {}).get("by_type_n", {}) or {}
        by_type_lift = (comparison or {}).get("by_type_lift_pct", {}) if comparison else {}
        for t in sorted(set(baseline_by_type) | set(rerank_by_type)):
            n_t = by_type_n.get(t, "?")
            b = baseline_by_type.get(t) if baseline is not None else None
            r = rerank_by_type.get(t) if rerank is not None else None
            lift_t = by_type_lift.get(t) if by_type_lift else None
            lines.append(
                f"| {t} | {n_t} | {_fmt_ndcg(b)} | {_fmt_ndcg(r)} | {_fmt_pct(lift_t)} |"
            )
        lines.append("")

    # By-scope table
    if baseline is not None or rerank is not None:
        lines.append("## NDCG@5 by Scope")
        lines.append("")
        lines.append("| Scope | n | Baseline | Rerank |")
        lines.append("|-------|---|----------|--------|")
        baseline_by_scope = (baseline or {}).get("by_scope", {}) or {}
        rerank_by_scope = (rerank or {}).get("by_scope", {}) or {}
        by_scope_n = (baseline or rerank or {}).get("by_scope_n", {}) or {}
        for s in sorted(set(baseline_by_scope) | set(rerank_by_scope)):
            n_s = by_scope_n.get(s, "?")
            b = baseline_by_scope.get(s) if baseline is not None else None
            r = rerank_by_scope.get(s) if rerank is not None else None
            lines.append(f"| {s} | {n_s} | {_fmt_ndcg(b)} | {_fmt_ndcg(r)} |")
        lines.append("")

    # Decision gate
    if gate is not None:
        lines.append("## Decision Gate (Task 3.2)")
        lines.append("")
        ndcg_pass = "PASS" if gate.get("ndcg_lift_pass") else "FAIL"
        p95_pass = "PASS" if gate.get("p95_latency_pass") else "FAIL"
        lines.append(
            f"- **NDCG@5 lift**: {_fmt_pct(gate.get('ndcg_lift_pct_measured'))} "
            f"(gate >= +{gate.get('ndcg_lift_pct_threshold'):.1f}%) -> **{ndcg_pass}**"
        )
        lines.append(
            f"- **P95 latency**: {_fmt_ms(gate.get('p95_ms_measured'))} "
            f"(gate <= {gate.get('p95_ms_threshold'):.0f}ms) -> **{p95_pass}**"
        )
        lines.append(f"- **Decision**: `{gate.get('decision')}` — {gate.get('rationale')}")
        lines.append("")

    # Comparison detail (verdict breakdown)
    if comparison is not None:
        lines.append("## Comparison Breakdown")
        lines.append("")
        lines.append("| Verdict | Count | Meaning |")
        lines.append("|---------|-------|---------|")
        lines.append(
            f"| rescued | {comparison.get('rescued_count', 0)} | "
            "Rerank pulled the relevant doc INTO top-K from outside |"
        )
        lines.append(
            f"| demoted | {comparison.get('demoted_count', 0)} | "
            "Rerank pushed the relevant doc OUT of top-K (failure mode) |"
        )
        lines.append(
            f"| shuffled_improved | {comparison.get('shuffled_improved_count', 0)} | "
            "Both top-K contain relevant; rerank rank is better |"
        )
        lines.append(
            f"| shuffled_worse | {comparison.get('shuffled_worse_count', 0)} | "
            "Both top-K contain relevant; rerank rank is worse |"
        )
        lines.append(
            f"| shuffled_no_change | {comparison.get('shuffled_no_change_count', 0)} | "
            "Top-K reordered but relevant doc rank unchanged |"
        )
        lines.append(
            f"| baseline_match | {comparison.get('baseline_match_count', 0)} | "
            "Rerank returned the identical top-K as baseline |"
        )
        lines.append(
            f"| both_miss | {comparison.get('both_miss_count', 0)} | "
            "Relevant doc not in top-K under either arm |"
        )
        lines.append("")

    # Rescued detail
    rescued_records = [r for r in per_pair if r.get("verdict") == "rescued"]
    if rescued_records:
        lines.append("## Top Rescued Pairs (rerank wins)")
        lines.append("")
        lines.append("| Query | Relevant ID | Type | Scope |")
        lines.append("|-------|-------------|------|-------|")
        for rec in rescued_records[:5]:
            q = rec.get("query", "")
            q_short = q if len(q) < 60 else q[:57] + "..."
            lines.append(
                f"| {q_short} | `{_short_id(rec.get('relevant_id', ''))}` | "
                f"{rec.get('type', '')} | {rec.get('scope', '')} |"
            )
        lines.append("")

    # Demoted detail (all of them — failure mode)
    demoted_records = [r for r in per_pair if r.get("verdict") == "demoted"]
    if demoted_records:
        lines.append("## Demoted Pairs (rerank failure mode)")
        lines.append("")
        lines.append("| Query | Relevant ID | Type | Scope | Baseline Rank |")
        lines.append("|-------|-------------|------|-------|---------------|")
        for rec in demoted_records:
            q = rec.get("query", "")
            q_short = q if len(q) < 60 else q[:57] + "..."
            b_ids = (rec.get("baseline") or {}).get("top_k_ids", []) or []
            rid = rec.get("relevant_id", "")
            try:
                b_rank = b_ids.index(rid) + 1
            except ValueError:
                b_rank = "?"
            lines.append(
                f"| {q_short} | `{_short_id(rid)}` | {rec.get('type', '')} | "
                f"{rec.get('scope', '')} | {b_rank} |"
            )
        lines.append("")

    # Errors
    err_records = [
        r for r in per_pair
        if (r.get("baseline") or {}).get("error")
        or (r.get("rerank") or {}).get("error")
    ]
    if err_records:
        lines.append("## Errors")
        lines.append("")
        lines.append("| Query | Arm | Error |")
        lines.append("|-------|-----|-------|")
        for rec in err_records:
            q = rec.get("query", "")
            q_short = q if len(q) < 50 else q[:47] + "..."
            for arm_key in ("baseline", "rerank"):
                arm = rec.get(arm_key) or {}
                if arm.get("error"):
                    err = arm["error"]
                    err_short = err if len(err) < 80 else err[:77] + "..."
                    lines.append(f"| {q_short} | {arm_key} | {err_short} |")
        lines.append("")

    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Main eval loop
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="NDCG@5 + latency eval harness for the Phase 2 reranker.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--eval-set", required=True, type=Path,
                        help="Path to recall_eval_set.jsonl")
    parser.add_argument("--k", type=int, default=5,
                        help="Top-K to evaluate (default: 5)")
    parser.add_argument("--report-json", type=Path, default=None,
                        help="Output path for machine-readable JSON report "
                             "(required for v1 sets; v2 defaults to "
                             "opc/tests/recall_eval_v2_report.json)")
    parser.add_argument("--report-md", type=Path, default=None,
                        help="Output path for human-readable Markdown report "
                             "(required for v1 sets; v2 defaults to "
                             "opc/tests/recall_eval_v2_report.md)")
    parser.add_argument("--daemon-mode", action="store_true",
                        help="Ensure rerank daemon is running for --rerank arm; clean up at end")
    parser.add_argument("--baseline-only", action="store_true",
                        help="Skip the --rerank arm (faster sanity check)")
    parser.add_argument("--rerank-only", action="store_true",
                        help="Skip the baseline arm")
    parser.add_argument("--max-pairs", type=int, default=None,
                        help="Cap at first N pairs (for smoke testing; default = all)")
    parser.add_argument("--warmup", action="store_true",
                        help="Discard first 2 calls of each arm from latency stats (cold-start exclusion)")
    parser.add_argument("--daemon-startup-timeout", type=float, default=180.0,
                        help="Seconds to wait for daemon to load model on cold start "
                             "(default 180; bump to 300 on slow hardware)")
    parser.add_argument("--recall-timeout-baseline", type=float, default=60.0,
                        help="Per-call timeout for baseline recall (seconds, default 60)")
    parser.add_argument("--recall-timeout-rerank", type=float, default=180.0,
                        help="Per-call timeout for rerank recall (seconds, default 180; cold rerank can be ~50s)")
    parser.add_argument(
        "--scope-current-project", action="store_true",
        help=(
            "Drop --all-projects from the recall invocation and use CWD-based "
            "scope resolution instead. Off by default because the eval set "
            "spans multiple projects' PROJECT learnings; turning this on will "
            "zero out NDCG for any pair whose relevant_id is scoped to a "
            "different project than the harness was launched from."
        ),
    )

    # v2 eval flags (recall_eval_v2.py). Ignored by the v1 path.
    v2 = parser.add_argument_group("v2 eval set (header version 2)")
    v2.add_argument("--arms", default="hybrid,text",
                    help="Comma list of hybrid,text,rerank (default hybrid,text; "
                         "rerank is opt-in and starts the rerank daemon)")
    v2.add_argument("--scope", choices=("hook", "all"), default="hook",
                    help="hook = the scope the UserPromptSubmit hook recalls in (default); "
                         "all = pass --all-projects")
    v2.add_argument("--allow-cold-embed", action="store_true",
                    help="Run the hybrid arm without the embed daemon (about 31 s per query)")
    mode = v2.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true",
                      help="Ratchet: compare to the baseline, exit 1 on regression. "
                           "Never writes it.")
    mode.add_argument("--write-baseline", action="store_true",
                      help="Write the baseline at the sweep-chosen floors")
    v2.add_argument("--allow-lower", action="store_true",
                    help="Let --write-baseline lower a gated number")
    v2.add_argument("--baseline", type=Path, default=None,
                    help="Baseline path (default opc/tests/recall_eval_baseline.json)")
    v2.add_argument("--timeout", type=float, default=120.0,
                    help="Per-call timeout in seconds for v2 recall calls (default 120)")
    return parser


def _eval_set_version(path: Path) -> int:
    """The ``_header.version`` of an eval set file, or 1 when it has no v2 header."""
    try:
        with path.open("r", encoding="utf-8") as fh:
            for raw in fh:
                if raw.strip():
                    header = json.loads(raw).get("_header") or {}
                    return int(header.get("version", 1))
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    return 1


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if _eval_set_version(args.eval_set) == 2:
        from core.recall_eval_v2 import run_v2  # noqa: PLC0415

        return run_v2(args)

    if args.check or args.write_baseline or args.allow_lower:
        parser.error("--check, --write-baseline and --allow-lower need an eval set with "
                     "a version 2 header")

    if args.report_json is None or args.report_md is None:
        parser.error("--report-json and --report-md are required for v1 eval sets")

    if args.baseline_only and args.rerank_only:
        print("[eval] --baseline-only and --rerank-only are mutually exclusive",
              file=sys.stderr)
        return 2

    repo_root = Path(__file__).resolve().parents[3]  # opc/scripts/core -> repo
    if not (repo_root / ".git").exists():
        # Fallback: use cwd if our derived root looks wrong.
        repo_root = Path.cwd()

    # Load eval set.
    try:
        header, pairs = load_eval_set(args.eval_set)
    except (FileNotFoundError, ValueError) as exc:
        print(f"[eval] failed to load eval set: {exc}", file=sys.stderr)
        return 1

    if args.max_pairs is not None and args.max_pairs > 0:
        pairs = pairs[: args.max_pairs]

    if not pairs:
        print("[eval] no pairs to evaluate", file=sys.stderr)
        return 1

    run_baseline = not args.rerank_only
    run_rerank = not args.baseline_only

    warmup_count = 2 if args.warmup else 0

    # Daemon lifecycle (only needed if rerank arm runs AND user opted in).
    daemon = DaemonManager(
        enabled=(args.daemon_mode and run_rerank),
        repo_root=repo_root,
        startup_timeout_s=args.daemon_startup_timeout,
    )
    atexit.register(daemon.stop)
    try:
        daemon.start()
    except (FileNotFoundError, RuntimeError) as exc:
        print(f"[eval] daemon startup failed: {exc}", file=sys.stderr)
        return 1

    # Per-pair evaluation.
    per_pair_records: list[dict[str, Any]] = []
    print(f"[eval] evaluating {len(pairs)} pairs "
          f"(baseline={run_baseline}, rerank={run_rerank})",
          file=sys.stderr)
    for idx, pair in enumerate(pairs):
        query = pair["query"]
        relevant_id = pair["relevant_id"]
        ptype = pair["type"]
        pscope = pair["scope"]
        confidence = pair["confidence"]

        rec: dict[str, Any] = {
            "query": query,
            "relevant_id": relevant_id,
            "type": ptype,
            "scope": pscope,
            "confidence": confidence,
        }
        for extra_key in ("notes", "caveat", "deliberate_dup_test"):
            if extra_key in pair:
                rec[extra_key] = pair[extra_key]

        # Baseline arm.
        if run_baseline:
            ids, lat, err, _meta = run_recall(
                repo_root=repo_root,
                query=query,
                k=args.k,
                rerank=False,
                timeout_s=args.recall_timeout_baseline,
                all_projects=(not args.scope_current_project),
            )
            rec["baseline"] = {
                "top_k_ids": ids,
                "ndcg_at_5": ndcg_at_k(ids, relevant_id, args.k),
                "latency_ms": lat,
                "error": err,
            }
            msg = f"NDCG={rec['baseline']['ndcg_at_5']:.3f} {lat:.0f}ms"
            if err:
                msg += f" ERR={err[:50]}"
            print(f"  [{idx+1}/{len(pairs)}] baseline {msg}", file=sys.stderr)

        # Rerank arm.
        if run_rerank:
            ids, lat, err, meta = run_recall(
                repo_root=repo_root,
                query=query,
                k=args.k,
                rerank=True,
                timeout_s=args.recall_timeout_rerank,
                all_projects=(not args.scope_current_project),
            )
            rec["rerank"] = {
                "top_k_ids": ids,
                "ndcg_at_5": ndcg_at_k(ids, relevant_id, args.k),
                "latency_ms": lat,
                "error": err,
                "rerank_meta": {
                    k: v for k, v in (meta or {}).items()
                    if k.startswith("rerank_")
                },
            }
            msg = f"NDCG={rec['rerank']['ndcg_at_5']:.3f} {lat:.0f}ms"
            if err:
                msg += f" ERR={err[:50]}"
            print(f"  [{idx+1}/{len(pairs)}] rerank   {msg}", file=sys.stderr)

        # Verdict (only when both arms ran).
        if run_baseline and run_rerank:
            b_ids = (rec.get("baseline") or {}).get("top_k_ids", []) or []
            r_ids = (rec.get("rerank") or {}).get("top_k_ids", []) or []
            rec["verdict"] = classify_verdict(b_ids, r_ids, relevant_id, args.k)

        per_pair_records.append(rec)

    # Aggregates.
    baseline_agg: dict[str, Any] | None = None
    rerank_agg: dict[str, Any] | None = None
    if run_baseline:
        baseline_agg = aggregate_arm(per_pair_records, "baseline", warmup_count)
    if run_rerank:
        rerank_agg = aggregate_arm(per_pair_records, "rerank", warmup_count)

    comparison: dict[str, Any] | None = None
    decision_gate: dict[str, Any] | None = None
    if baseline_agg is not None and rerank_agg is not None:
        comparison = build_comparison(per_pair_records, baseline_agg, rerank_agg)
        decision_gate = evaluate_decision_gate(comparison, rerank_agg)

    # Build the report doc.
    report: dict[str, Any] = {
        "_meta": {
            "eval_set": str(args.eval_set),
            "n_pairs": len(per_pair_records),
            "k": args.k,
            "model": "BAAI/bge-reranker-v2-m3",
            "max_length": 256,
            "rerank_top_n": 50,
            "ran_at": datetime.now(timezone.utc).isoformat(),
            "daemon_mode": bool(args.daemon_mode),
            "daemon_spawned_by_us": daemon.spawned_by_us,
            "warmup_skipped": bool(args.warmup),
            "warmup_count": warmup_count,
            "baseline_only": bool(args.baseline_only),
            "rerank_only": bool(args.rerank_only),
            "scope_current_project": bool(args.scope_current_project),
            "all_projects": (not bool(args.scope_current_project)),
            "eval_set_header": header,
        },
        "baseline": baseline_agg,
        "rerank": rerank_agg,
        "comparison": comparison,
        "decision_gate": decision_gate,
        "per_pair": per_pair_records,
    }

    # Write outputs.
    args.report_json.parent.mkdir(parents=True, exist_ok=True)
    args.report_md.parent.mkdir(parents=True, exist_ok=True)

    # Use the float-tolerant encoder so inf serializes as a string sentinel.
    def _default(o: Any) -> Any:
        if isinstance(o, float) and (math.isinf(o) or math.isnan(o)):
            return "inf" if math.isinf(o) else "nan"
        if isinstance(o, datetime):
            return o.isoformat()
        raise TypeError(f"not JSON-serialisable: {type(o)}")

    with args.report_json.open("w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, default=_default)
        fh.write("\n")

    md = render_markdown(report)
    args.report_md.write_text(md, encoding="utf-8")

    print(
        f"[eval] wrote {args.report_json} and {args.report_md}",
        file=sys.stderr,
    )

    # Always return 0 from a successful eval pass. Decision-gate FAIL is a
    # measurement outcome, not a script-level error.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
