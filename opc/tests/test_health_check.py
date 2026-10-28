"""Tests for scripts/health_check.py.

All external dependencies (subprocess, asyncpg, anthropic, filesystem) are
mocked. No live DB, LLM, or CLI calls.
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from scripts.health_check import (
    CheckResult,
    HealthCheckRunner,
    compute_canary_timeout,
    compute_exit_code,
    render_markdown,
    CATEGORY_ORDER,
)


# ---------------------------------------------------------------------------
# CheckResult dataclass
# ---------------------------------------------------------------------------


def test_checkresult_serializes_cleanly():
    """CheckResult -> JSON roundtrip preserves every field."""
    r = CheckResult(
        name="memory-canary-roundtrip",
        category="memory",
        status="PASS",
        severity="CRITICAL",
        evidence="canary stored and retrieved as top-1 in 842ms",
        duration_ms=842,
        remediation="",
        metadata={"canary_id": "HEALTH_CHECK_abc"},
    )
    as_dict = r.to_dict()
    # must be JSON-serializable
    blob = json.dumps(as_dict)
    back = json.loads(blob)
    assert back["name"] == "memory-canary-roundtrip"
    assert back["category"] == "memory"
    assert back["status"] == "PASS"
    assert back["severity"] == "CRITICAL"
    assert back["duration_ms"] == 842
    assert back["metadata"]["canary_id"] == "HEALTH_CHECK_abc"


def test_checkresult_default_metadata_is_independent():
    """default metadata dict must not be shared between instances."""
    a = CheckResult(name="a", category="x", status="PASS", severity="INFO",
                    evidence="", duration_ms=0)
    b = CheckResult(name="b", category="x", status="PASS", severity="INFO",
                    evidence="", duration_ms=0)
    a.metadata["x"] = 1
    assert "x" not in b.metadata


# ---------------------------------------------------------------------------
# Exit code escalation
# ---------------------------------------------------------------------------


def _mk(status: str, severity: str = "MEDIUM") -> CheckResult:
    return CheckResult(
        name="x", category="c", status=status, severity=severity,
        evidence="", duration_ms=1,
    )


def test_exit_code_all_pass_is_zero():
    assert compute_exit_code([_mk("PASS"), _mk("PASS")]) == 0


def test_exit_code_warn_escalates_to_one():
    assert compute_exit_code([_mk("PASS"), _mk("WARN", "LOW")]) == 1


def test_exit_code_high_fail_escalates_to_two():
    assert compute_exit_code([_mk("PASS"), _mk("FAIL", "HIGH")]) == 2


def test_exit_code_critical_fail_escalates_to_three():
    assert compute_exit_code([_mk("PASS"), _mk("FAIL", "CRITICAL")]) == 3


def test_exit_code_critical_beats_everything():
    """CRITICAL must dominate regardless of order."""
    results = [_mk("WARN"), _mk("FAIL", "HIGH"), _mk("FAIL", "CRITICAL")]
    assert compute_exit_code(results) == 3


def test_exit_code_skip_does_not_contribute():
    assert compute_exit_code([_mk("PASS"), _mk("SKIP", "INFO")]) == 0


# ---------------------------------------------------------------------------
# Isolation: one crash must not kill siblings
# ---------------------------------------------------------------------------


def test_one_check_crash_does_not_kill_others(tmp_path):
    runner = HealthCheckRunner(output_dir=tmp_path, quiet=True)

    def good_check() -> CheckResult:
        return CheckResult(
            name="good", category="infrastructure", status="PASS",
            severity="INFO", evidence="ok", duration_ms=1,
        )

    def crashing_check() -> CheckResult:
        raise RuntimeError("boom -- check crashed")

    def another_good() -> CheckResult:
        return CheckResult(
            name="another", category="infrastructure", status="PASS",
            severity="INFO", evidence="also ok", duration_ms=1,
        )

    runner.register("good", "infrastructure", good_check)
    runner.register("crash", "infrastructure", crashing_check)
    runner.register("another", "infrastructure", another_good)

    results = runner.run_sync()
    names = {r.name: r for r in results}

    # all three ran
    assert set(names.keys()) == {"good", "crash", "another"}
    # the crash became a FAIL result, not an uncaught exception
    assert names["crash"].status == "FAIL"
    assert names["crash"].severity == "HIGH"
    assert "boom" in names["crash"].evidence
    # neighbours still passed
    assert names["good"].status == "PASS"
    assert names["another"].status == "PASS"


# ---------------------------------------------------------------------------
# Category filtering
# ---------------------------------------------------------------------------


def test_category_filter_runs_only_requested(tmp_path):
    runner = HealthCheckRunner(output_dir=tmp_path, quiet=True)

    def mem_check() -> CheckResult:
        return CheckResult(name="m", category="memory", status="PASS",
                           severity="INFO", evidence="", duration_ms=1)

    def infra_check() -> CheckResult:
        return CheckResult(name="i", category="infrastructure",
                           status="PASS", severity="INFO",
                           evidence="", duration_ms=1)

    runner.register("m", "memory", mem_check)
    runner.register("i", "infrastructure", infra_check)

    results = runner.run_sync(categories=["memory"])
    assert {r.name for r in results} == {"m"}


def test_category_filter_empty_means_all(tmp_path):
    runner = HealthCheckRunner(output_dir=tmp_path, quiet=True)
    runner.register("m", "memory", lambda: CheckResult(
        name="m", category="memory", status="PASS", severity="INFO",
        evidence="", duration_ms=1))
    runner.register("i", "infrastructure", lambda: CheckResult(
        name="i", category="infrastructure", status="PASS", severity="INFO",
        evidence="", duration_ms=1))
    results = runner.run_sync(categories=None)
    assert len(results) == 2


# ---------------------------------------------------------------------------
# Markdown rendering
# ---------------------------------------------------------------------------


def test_markdown_output_has_required_sections():
    results = [
        CheckResult(name="a", category="memory", status="PASS",
                    severity="INFO", evidence="ok", duration_ms=5),
        CheckResult(name="b", category="hooks", status="WARN",
                    severity="MEDIUM", evidence="mild", duration_ms=3),
        CheckResult(name="c", category="memory", status="FAIL",
                    severity="CRITICAL", evidence="boom",
                    remediation="restart", duration_ms=4),
    ]
    md = render_markdown(results, duration_s=12.5)
    # headline
    assert "CCv3 Health Check" in md
    assert "Overall:" in md
    # severity sections
    assert "## CRITICAL" in md
    assert "## Summary" in md
    assert "## Per-category" in md
    # per-category table header
    assert "| Category" in md
    # evidence text appears
    assert "boom" in md
    # remediation surfaced for the failing check
    assert "restart" in md


def test_markdown_reports_counts():
    results = [
        _mk("PASS"), _mk("PASS"), _mk("WARN"),
        _mk("FAIL", "CRITICAL"), _mk("SKIP", "INFO"),
    ]
    md = render_markdown(results, duration_s=1.0)
    assert "PASS: 2" in md
    assert "WARN: 1" in md
    assert "FAIL: 1" in md
    assert "SKIP: 1" in md


# ---------------------------------------------------------------------------
# JSON + history output
# ---------------------------------------------------------------------------


def test_runner_writes_json_and_markdown_and_history(tmp_path):
    runner = HealthCheckRunner(output_dir=tmp_path, quiet=True)
    runner.register("ok", "infrastructure", lambda: CheckResult(
        name="ok", category="infrastructure", status="PASS",
        severity="INFO", evidence="ran", duration_ms=2))

    results = runner.run_sync()
    runner.write_outputs(results)

    # JSON artifact
    json_files = list(tmp_path.glob("*.json"))
    # we expect at least the run JSON (history.jsonl also lives here but ends in .jsonl)
    assert any(f.name != "history.jsonl" for f in json_files)

    # markdown artifact
    md_files = list(tmp_path.glob("*.md"))
    assert md_files
    md_text = md_files[0].read_text(encoding="utf-8")
    assert "CCv3 Health Check" in md_text

    # history line appended
    history = tmp_path / "history.jsonl"
    assert history.exists()
    lines = [line for line in history.read_text().splitlines() if line.strip()]
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert entry["counts"]["PASS"] == 1
    assert "timestamp" in entry
    assert "overall_status" in entry


def test_history_accumulates_across_runs(tmp_path):
    runner = HealthCheckRunner(output_dir=tmp_path, quiet=True)
    runner.register("ok", "infrastructure", lambda: CheckResult(
        name="ok", category="infrastructure", status="PASS",
        severity="INFO", evidence="", duration_ms=1))

    for _ in range(3):
        results = runner.run_sync()
        runner.write_outputs(results)

    history = tmp_path / "history.jsonl"
    lines = [line for line in history.read_text().splitlines() if line.strip()]
    assert len(lines) == 3


# ---------------------------------------------------------------------------
# Category ordering (stable report layout)
# ---------------------------------------------------------------------------


def test_category_order_is_declared_and_covers_known_categories():
    # Must contain the big-ticket categories the runner defines
    for expected in ("infrastructure", "hooks", "memory", "skills", "agents"):
        assert expected in CATEGORY_ORDER


# ---------------------------------------------------------------------------
# Canary roundtrip -- logic-level test (no real DB)
# ---------------------------------------------------------------------------


def test_canary_id_is_unique_per_invocation():
    """The canary generator must produce distinct ids on repeat calls."""
    from scripts.health_check import _build_canary_signal

    a = _build_canary_signal()
    b = _build_canary_signal()
    assert a["canary_id"] != b["canary_id"]
    # both must carry a deterministic semantic phrase marker
    assert a["phrase"]
    assert b["phrase"]
    # and a date stamp component for audit
    assert a["canary_id"].startswith("HEALTH_CHECK_")


# ---------------------------------------------------------------------------
# Exit code matches overall_status
# ---------------------------------------------------------------------------


def test_exit_code_matches_overall_status():
    """compute_exit_code must agree with _overall_status across all 4 tiers."""
    pass_only = [CheckResult(name="x", category="c", status="PASS",
                             severity="INFO", evidence="", duration_ms=1)]
    assert compute_exit_code(pass_only) == 0

    with_warn = pass_only + [CheckResult(name="y", category="c", status="WARN",
                                         severity="LOW", evidence="",
                                         duration_ms=1)]
    assert compute_exit_code(with_warn) == 1

    with_high = pass_only + [CheckResult(name="z", category="c", status="FAIL",
                                          severity="HIGH", evidence="",
                                          duration_ms=1)]
    assert compute_exit_code(with_high) == 2

    with_crit = pass_only + [CheckResult(name="w", category="c", status="FAIL",
                                          severity="CRITICAL", evidence="",
                                          duration_ms=1)]
    assert compute_exit_code(with_crit) == 3


def test_exit_code_covers_all_fail_severities():
    """FAIL at MEDIUM or LOW must still return 2 (any FAIL merits a signal)."""
    base = [CheckResult(name="x", category="c", status="PASS",
                        severity="INFO", evidence="", duration_ms=1)]

    with_medium = base + [CheckResult(name="y", category="c", status="FAIL",
                                      severity="MEDIUM", evidence="",
                                      duration_ms=1)]
    assert compute_exit_code(with_medium) == 2

    with_low = base + [CheckResult(name="z", category="c", status="FAIL",
                                   severity="LOW", evidence="",
                                   duration_ms=1)]
    assert compute_exit_code(with_low) == 2


# ---------------------------------------------------------------------------
# Vitest check uses --outputFile (not stdout parsing)
# ---------------------------------------------------------------------------


def test_vitest_check_uses_output_file(tmp_path):
    """check_hook_vitest must pass --outputFile to vitest and read that file."""
    from scripts.health_check import check_hook_vitest, CLAUDE_DIR

    # The checkout's real hooks/package.json must survive this test.
    real_pkg = CLAUDE_DIR / "hooks" / "package.json"
    real_before = real_pkg.read_bytes() if real_pkg.exists() else None

    vitest_json = {
        "numTotalTests": 10,
        "numPassedTests": 10,
        "numFailedTests": 0,
    }

    captured_cmd: list = []

    def fake_run(cmd, **kwargs):
        captured_cmd.extend(cmd)
        # Find the --outputFile argument and write JSON there.
        for arg in cmd:
            if arg.startswith("--outputFile="):
                out_path = Path(arg.split("=", 1)[1])
                out_path.write_text(json.dumps(vitest_json), encoding="utf-8")
        ns = MagicMock()
        ns.returncode = 0
        ns.stdout = ""
        ns.stderr = ""
        return ns

    # Point the check at a fake .claude dir. Writing the checkout's own
    # hooks/package.json and then deleting it removed the real file.
    fake_claude = tmp_path / ".claude"
    (fake_claude / "hooks").mkdir(parents=True)
    (fake_claude / "hooks" / "package.json").write_text("{}", encoding="utf-8")

    with patch("scripts.health_check.CLAUDE_DIR", fake_claude), \
            patch("scripts.health_check._run", side_effect=fake_run):
        result = check_hook_vitest()

    # Must have passed --outputFile in the command
    assert any(a.startswith("--outputFile=") for a in captured_cmd), (
        "--outputFile not found in vitest command: " + str(captured_cmd)
    )
    # Must have read the file and reported correctly
    assert result.status == "PASS"
    assert "10/10" in result.evidence
    real_after = real_pkg.read_bytes() if real_pkg.exists() else None
    assert real_after == real_before, "test changed the real .claude/hooks/package.json"


# ---------------------------------------------------------------------------
# compute_canary_timeout
# ---------------------------------------------------------------------------


def _make_canary_pass_line(duration_ms: float) -> str:
    """Build a history.jsonl line with a single memory-canary-roundtrip PASS."""
    return json.dumps({
        "timestamp": "2026-01-01T00:00:00+00:00",
        "results": [
            {
                "name": "memory-canary-roundtrip",
                "status": "PASS",
                "duration_ms": duration_ms,
            }
        ],
    })


def test_compute_canary_timeout_no_history_file(tmp_path):
    """No history file -> floor (90.0)."""
    result = compute_canary_timeout(history_path=tmp_path / "nonexistent.jsonl")
    assert result == 90.0


def test_compute_canary_timeout_fewer_than_5_pass_records(tmp_path):
    """<5 PASS records -> floor (90.0), adaptive logic does not engage."""
    history = tmp_path / "history.jsonl"
    for dur in [20000, 25000, 30000, 22000]:  # 4 records
        history.open("a").write(_make_canary_pass_line(dur) + "\n")
    result = compute_canary_timeout(history_path=history)
    assert result == 90.0


def test_compute_canary_timeout_within_bounds(tmp_path):
    """>=5 PASS records, P95*2 within [90, 300] -> clamped adaptive value."""
    history = tmp_path / "history.jsonl"
    # 6 records, all 50 000 ms (50s) -> P95 = 50 000 ms -> *2 = 100s (within bounds)
    for _ in range(6):
        history.open("a").write(_make_canary_pass_line(50_000) + "\n")
    result = compute_canary_timeout(history_path=history)
    assert 90.0 <= result <= 300.0
    # P95 of 6 identical values is 50000ms; *2 / 1000 = 100s
    assert result == pytest.approx(100.0, abs=1.0)


def test_compute_canary_timeout_ceiling(tmp_path):
    """P95*2 exceeds 300s -> ceiling (300.0)."""
    history = tmp_path / "history.jsonl"
    # 6 records, all 200 000 ms (200s) -> P95*2 = 400s -> clamped to 300
    for _ in range(6):
        history.open("a").write(_make_canary_pass_line(200_000) + "\n")
    result = compute_canary_timeout(history_path=history)
    assert result == 300.0


# ---------------------------------------------------------------------------
# hook-runtime category helpers
# ---------------------------------------------------------------------------


def _make_trace_line(
    *,
    name: str = "memory-awareness",
    event: str = "PreToolUse",
    duration_ms: int = 50,
    exit_code: int = 0,
    ts: str | None = None,
    error: str | None = None,
) -> str:
    """Build a hook-trace.jsonl line."""
    if ts is None:
        ts = "2026-04-25T12:00:00.000Z"
    return json.dumps({
        "ts": ts,
        "name": name,
        "event": event,
        "durationMs": duration_ms,
        "exitCode": exit_code,
        "sessionId": "test-session",
        "error": error,
    })


def test_parse_hook_trace_missing_file_returns_empty(tmp_path):
    """Missing trace file -> empty list (no exception)."""
    from scripts.health_check import parse_hook_trace

    result = parse_hook_trace(trace_path=tmp_path / "nonexistent.jsonl")
    assert result == []


def test_parse_hook_trace_filters_by_since_days(tmp_path):
    """Lines older than since_days are excluded."""
    from datetime import datetime, timedelta, timezone
    from scripts.health_check import parse_hook_trace

    trace = tmp_path / "hook-trace.jsonl"
    now = datetime.now(timezone.utc)
    recent = (now - timedelta(days=2)).isoformat().replace("+00:00", "Z")
    ancient = (now - timedelta(days=30)).isoformat().replace("+00:00", "Z")
    with trace.open("a", encoding="utf-8") as f:
        f.write(_make_trace_line(name="recent", ts=recent) + "\n")
        f.write(_make_trace_line(name="ancient", ts=ancient) + "\n")

    result = parse_hook_trace(trace_path=trace, since_days=7)
    names = [e["name"] for e in result]
    assert "recent" in names
    assert "ancient" not in names


def test_parse_hook_trace_skips_malformed_lines(tmp_path):
    """Malformed JSON lines are skipped silently; valid lines preserved."""
    from scripts.health_check import parse_hook_trace

    trace = tmp_path / "hook-trace.jsonl"
    with trace.open("w", encoding="utf-8") as f:
        f.write(_make_trace_line(name="ok-1") + "\n")
        f.write("this is not json\n")
        f.write("{partial: not-quoted-json}\n")
        f.write("\n")  # blank line
        f.write(_make_trace_line(name="ok-2") + "\n")

    result = parse_hook_trace(trace_path=trace, since_days=365)
    names = sorted(e["name"] for e in result)
    assert names == ["ok-1", "ok-2"]


def test_aggregate_by_hook_counts_fires_errors_durations():
    """aggregate_by_hook returns per-hook fires/errors/durations."""
    from scripts.health_check import aggregate_by_hook

    events = [
        {"name": "hook-a", "exitCode": 0, "durationMs": 50,
         "ts": "2026-04-20T10:00:00.000Z"},
        {"name": "hook-a", "exitCode": 0, "durationMs": 70,
         "ts": "2026-04-21T10:00:00.000Z"},
        {"name": "hook-a", "exitCode": 1, "durationMs": 100,
         "ts": "2026-04-22T10:00:00.000Z"},
        {"name": "hook-b", "exitCode": 0, "durationMs": 25,
         "ts": "2026-04-22T10:00:00.000Z"},
    ]
    agg = aggregate_by_hook(events)
    assert set(agg.keys()) == {"hook-a", "hook-b"}
    assert agg["hook-a"]["fires"] == 3
    assert agg["hook-a"]["errors"] == 1
    assert sorted(agg["hook-a"]["durations_ms"]) == [50, 70, 100]
    assert agg["hook-b"]["fires"] == 1
    assert agg["hook-b"]["errors"] == 0
    assert agg["hook-a"]["first_fire"] is not None
    assert agg["hook-a"]["last_fire"] is not None


def test_get_registered_hooks_extracts_basenames(tmp_path):
    """settings.json command paths -> set of bare hook names (no .mjs, no dirs)."""
    from scripts.health_check import get_registered_hooks

    settings = {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Agent",
                    "hooks": [
                        {
                            "type": "command",
                            "command": (
                                "node C:/Users/david.hayes/.claude/hooks/"
                                "dist/agent-validate.mjs"
                            ),
                        },
                        {
                            "type": "command",
                            "command": (
                                "node ~/.claude/hooks/dist/no-haiku-enforcer.mjs"
                            ),
                        },
                    ],
                },
            ],
            "PostToolUse": [
                {
                    "matcher": "Edit",
                    "hooks": [
                        {
                            "type": "command",
                            "command": "node /some/path/memory-awareness.mjs",
                        },
                    ],
                },
            ],
        },
    }
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(json.dumps(settings), encoding="utf-8")

    names = get_registered_hooks(settings_path=settings_path)
    assert "agent-validate" in names
    assert "no-haiku-enforcer" in names
    assert "memory-awareness" in names
    # No .mjs, no dirs
    for n in names:
        assert not n.endswith(".mjs")
        assert "/" not in n
        assert "\\" not in n


def test_get_registered_hooks_handles_split_command_args_form(tmp_path):
    """The SPLIT {"command": "node", "args": [path]} shape must resolve too.

    REGRESSION GUARD, 2026-07-28. The test above covers only the INLINE form,
    and that gap is exactly why this went unnoticed: the live
    ~/.claude/settings.json uses the SPLIT form for 80 of its 85 registrations,
    so the parser found ZERO paths in production while this suite stayed green.

    The damage was silent rather than loud. check_hook_registrations reported
    "0 hook registrations all resolve" and PASSED -- structurally unable to
    catch the registered-but-missing hook it exists for -- check_hook_orphans
    counted 114 false orphans, and get_registered_hooks returned an empty set,
    so every hook-runtime comparison ran against nothing.
    """
    from scripts.health_check import get_registered_hooks

    settings = {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "EnterPlanMode",
                    "hooks": [
                        {
                            "type": "command",
                            "command": "node",
                            "args": [
                                "C:/Users/david.hayes/.claude/hooks/"
                                "dist/pre-plan-memory.mjs"
                            ],
                            "timeout": 5000,
                        },
                    ],
                },
            ],
            "SessionEnd": [
                {
                    "hooks": [
                        # Quoted inline: must not resolve to a path with a
                        # leading apostrophe (a false MISSING). This shape is
                        # a quoted inline command.
                        {
                            "type": "command",
                            "command": "node 'C:/x/dist/coordination-release.mjs'",
                        },
                        # Non-.mjs registrations (python hooks) are ignored by
                        # design; asserted so the omission stays deliberate.
                        {
                            "type": "command",
                            "command": "python",
                            "args": ["C:/x/braintrust_hooks.py", "session_end"],
                        },
                    ],
                },
            ],
        },
    }
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(json.dumps(settings), encoding="utf-8")

    names = get_registered_hooks(settings_path=settings_path)
    assert "pre-plan-memory" in names, "split command/args form was not parsed"
    assert "coordination-release" in names, "quoted inline form was not parsed"
    assert not any("'" in n or '"' in n for n in names)
    assert "braintrust_hooks" not in names


def test_extract_hook_paths_reads_args_array(tmp_path):
    """check_hook_registrations' parser must see the split form as well.

    Separate function, same defect -- fixing only one would leave
    hook-registrations-valid passing vacuously while hook-runtime was correct.
    """
    from scripts.health_check import _extract_hook_paths

    settings = {
        "hooks": {
            "PostToolUse": [
                {
                    "matcher": "Edit",
                    "hooks": [
                        {
                            "type": "command",
                            "command": "node",
                            "args": ["C:/x/dist/memory-awareness.mjs"],
                        },
                    ],
                },
            ],
        },
    }

    paths = _extract_hook_paths(settings)
    assert len(paths) == 1, f"expected 1 path from the args array, got {paths}"
    event, path = paths[0]
    assert event == "PostToolUse"
    assert path.endswith("memory-awareness.mjs")


def test_compute_unfired_hooks_insufficient_history():
    """If history span < min_history_days, has_sufficient_history=False."""
    from scripts.health_check import compute_unfired_hooks

    registered = {"hook-a", "hook-b", "hook-c"}
    aggregated = {
        "hook-a": {
            "fires": 5, "errors": 0, "durations_ms": [10],
            "first_fire": "2026-04-25T10:00:00.000Z",
            "last_fire": "2026-04-25T15:00:00.000Z",
        },
    }
    # Same-day events span 5 hours -> < 3 days
    events = [
        {"name": "hook-a", "exitCode": 0, "durationMs": 10,
         "ts": "2026-04-25T10:00:00.000Z"},
        {"name": "hook-a", "exitCode": 0, "durationMs": 10,
         "ts": "2026-04-25T15:00:00.000Z"},
    ]
    unfired, sufficient = compute_unfired_hooks(
        registered, aggregated, min_history_days=3, events=events,
    )
    assert sufficient is False


def test_compute_unfired_hooks_sufficient_history_returns_unfired():
    """With >=3 days of history, returns the registered-but-unfired list."""
    from scripts.health_check import compute_unfired_hooks

    registered = {"hook-a", "hook-b", "hook-c", "hook-d"}
    aggregated = {
        "hook-a": {
            "fires": 5, "errors": 0, "durations_ms": [10],
            "first_fire": "2026-04-20T10:00:00.000Z",
            "last_fire": "2026-04-25T15:00:00.000Z",
        },
        "hook-b": {
            "fires": 1, "errors": 0, "durations_ms": [10],
            "first_fire": "2026-04-22T10:00:00.000Z",
            "last_fire": "2026-04-22T10:00:00.000Z",
        },
    }
    events = [
        {"name": "hook-a", "exitCode": 0, "durationMs": 10,
         "ts": "2026-04-20T10:00:00.000Z"},
        {"name": "hook-a", "exitCode": 0, "durationMs": 10,
         "ts": "2026-04-25T15:00:00.000Z"},
    ]
    unfired, sufficient = compute_unfired_hooks(
        registered, aggregated, min_history_days=3, events=events,
    )
    assert sufficient is True
    assert set(unfired) == {"hook-c", "hook-d"}


def test_hook_runtime_integration_all_subchecks(tmp_path):
    """Feed fixture jsonl + settings -> verify all 4 sub-checks fire."""
    from datetime import datetime, timedelta, timezone
    from scripts.health_check import check_hook_runtime

    trace = tmp_path / "hook-trace.jsonl"
    settings_path = tmp_path / "settings.json"

    now = datetime.now(timezone.utc)
    # 5 days of trace data so fire-rate has sufficient history
    days = [(now - timedelta(days=i)).isoformat().replace("+00:00", "Z")
            for i in range(5, 0, -1)]
    lines = []
    # hook-a: many fires, mostly clean (>=10 fires triggers timing/error analysis)
    for i in range(15):
        lines.append(_make_trace_line(
            name="hook-a", duration_ms=50 + i, exit_code=0, ts=days[i % 5],
        ))
    # hook-b: many fires, high error rate (>5%)
    for i in range(15):
        lines.append(_make_trace_line(
            name="hook-b", duration_ms=100, exit_code=(1 if i < 5 else 0),
            ts=days[i % 5],
        ))
    # hook-zero: registered but never fired -> goes via settings only
    trace.write_text("\n".join(lines) + "\n", encoding="utf-8")

    settings = {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Agent",
                    "hooks": [
                        {"type": "command",
                         "command": "node ~/.claude/hooks/dist/hook-a.mjs"},
                        {"type": "command",
                         "command": "node ~/.claude/hooks/dist/hook-b.mjs"},
                        {"type": "command",
                         "command": "node ~/.claude/hooks/dist/hook-zero.mjs"},
                    ],
                },
            ],
        },
    }
    settings_path.write_text(json.dumps(settings), encoding="utf-8")

    results = check_hook_runtime(
        trace_path=trace, settings_path=settings_path,
    )
    by_name = {r.name: r for r in results}

    # Must produce 4 sub-checks
    assert "hook-trace-file-present" in by_name
    assert "hook-fire-rate" in by_name
    assert "hook-error-rate" in by_name
    assert "hook-timing-p95" in by_name

    # All in hook-runtime category
    for r in results:
        assert r.category == "hook-runtime"

    # Trace file present -> PASS
    assert by_name["hook-trace-file-present"].status == "PASS"

    # Fire-rate: hook-zero registered but no fires AND >=3 days history -> WARN
    fr = by_name["hook-fire-rate"]
    assert fr.status == "WARN"
    assert fr.severity == "MEDIUM"
    assert "hook-zero" in fr.evidence

    # Error-rate: hook-b has 5/15 = 33% errors -> WARN HIGH
    er = by_name["hook-error-rate"]
    assert er.status == "WARN"
    assert er.severity == "HIGH"
    assert "hook-b" in er.evidence

    # Timing P95: PASS, INFO severity
    tp = by_name["hook-timing-p95"]
    assert tp.status == "PASS"
    assert tp.severity == "INFO"


def test_hook_runtime_skips_when_trace_missing(tmp_path):
    """Trace file missing -> hook-trace-file-present SKIPs (not WARN)."""
    from scripts.health_check import check_hook_runtime

    settings_path = tmp_path / "settings.json"
    settings_path.write_text(json.dumps({"hooks": {}}), encoding="utf-8")

    results = check_hook_runtime(
        trace_path=tmp_path / "missing.jsonl",
        settings_path=settings_path,
    )
    by_name = {r.name: r for r in results}
    assert by_name["hook-trace-file-present"].status == "SKIP"
    assert by_name["hook-trace-file-present"].severity == "INFO"


def test_hook_runtime_fail_safe_on_unhandled_exception(tmp_path, monkeypatch):
    """Any unhandled exception in helpers -> single FAIL with severity LOW."""
    from scripts.health_check import check_hook_runtime
    import scripts.health_check as hc

    # Force parse_hook_trace to raise
    def boom(*args, **kwargs):
        raise RuntimeError("synthetic-boom")

    monkeypatch.setattr(hc, "parse_hook_trace", boom)

    settings_path = tmp_path / "settings.json"
    settings_path.write_text(json.dumps({"hooks": {}}), encoding="utf-8")

    trace = tmp_path / "hook-trace.jsonl"
    trace.write_text("", encoding="utf-8")

    results = check_hook_runtime(
        trace_path=trace, settings_path=settings_path,
    )
    # exactly one FAIL result, severity LOW, mentions error
    assert len(results) == 1
    r = results[0]
    assert r.status == "FAIL"
    assert r.severity == "LOW"
    assert "synthetic-boom" in r.evidence


def test_hook_runtime_registered_in_build_runner(tmp_path):
    """build_runner must register hook-runtime category checks."""
    from scripts.health_check import build_runner, CATEGORY_ORDER

    assert "hook-runtime" in CATEGORY_ORDER
    runner = build_runner(output_dir=tmp_path, quiet=True)
    # The runner stores _Registration per check; categories should include hook-runtime
    cats = {reg.category for reg in runner._registrations}
    assert "hook-runtime" in cats


# ---------------------------------------------------------------------------
# git-remote-sync (compares HEAD to fork/main backup)
# ---------------------------------------------------------------------------


def _git_remote_run_factory(branch: str = "main",
                            rev_stdout: str = "0\t0",
                            rev_returncode: int = 0,
                            rev_stderr: str = ""):
    """Build a fake _run that responds to rev-parse and rev-list."""
    captured: list[list[str]] = []

    def fake(cmd, **kwargs):
        captured.append(list(cmd))
        ns = MagicMock()
        if "rev-parse" in cmd:
            ns.returncode = 0
            ns.stdout = branch + "\n"
            ns.stderr = ""
        elif "rev-list" in cmd:
            ns.returncode = rev_returncode
            ns.stdout = rev_stdout
            ns.stderr = rev_stderr
        else:
            ns.returncode = 0
            ns.stdout = ""
            ns.stderr = ""
        return ns

    return fake, captured


def test_git_remote_sync_in_sync():
    """0 ahead, 0 behind fork/main -> PASS."""
    from scripts.health_check import check_git_remote_sync

    fake, _ = _git_remote_run_factory(rev_stdout="0\t0")
    with patch("scripts.health_check._run", side_effect=fake):
        r = check_git_remote_sync()
    assert r.status == "PASS"
    assert "in sync" in r.evidence
    assert r.metadata["ahead"] == 0
    assert r.metadata["behind"] == 0
    assert r.metadata["ref"] == "fork/main"


def test_git_remote_sync_ahead_warns_for_backup_gap():
    """Ahead of fork/main -> WARN (push needed for backup).

    This is the key behavior the old `git status -sb` parser missed.
    """
    from scripts.health_check import check_git_remote_sync

    fake, _ = _git_remote_run_factory(rev_stdout="0\t5",
                                      branch="feature/system-coherence")
    with patch("scripts.health_check._run", side_effect=fake):
        r = check_git_remote_sync()
    assert r.status == "WARN"
    assert r.severity == "LOW"
    assert "ahead" in r.evidence
    assert "5" in r.evidence
    assert "push" in r.evidence.lower()
    assert "feature/system-coherence" in r.evidence
    assert r.metadata["ahead"] == 5
    assert r.metadata["behind"] == 0


def test_git_remote_sync_behind_warns():
    """Behind fork/main -> WARN."""
    from scripts.health_check import check_git_remote_sync

    fake, _ = _git_remote_run_factory(rev_stdout="3\t0")
    with patch("scripts.health_check._run", side_effect=fake):
        r = check_git_remote_sync()
    assert r.status == "WARN"
    assert "behind" in r.evidence
    assert "3" in r.evidence
    assert r.metadata["behind"] == 3
    assert r.metadata["ahead"] == 0


def test_git_remote_sync_diverged_warns():
    """Both ahead and behind -> WARN diverged."""
    from scripts.health_check import check_git_remote_sync

    fake, _ = _git_remote_run_factory(rev_stdout="2\t4")
    with patch("scripts.health_check._run", side_effect=fake):
        r = check_git_remote_sync()
    assert r.status == "WARN"
    assert "diverged" in r.evidence
    assert "4 ahead" in r.evidence
    assert "2 behind" in r.evidence


def test_git_remote_sync_skips_when_fork_missing():
    """rev-list nonzero -> SKIP rather than crash."""
    from scripts.health_check import check_git_remote_sync

    fake, _ = _git_remote_run_factory(rev_returncode=128,
                                      rev_stdout="",
                                      rev_stderr="fatal: ambiguous argument")
    with patch("scripts.health_check._run", side_effect=fake):
        r = check_git_remote_sync()
    assert r.status == "SKIP"
    assert "fork/main" in r.evidence


def test_git_remote_sync_uses_rev_list_against_fork_main():
    """The check MUST compare to fork/main, not just rely on git status -sb.

    Regression guard: previous implementation used `git status -sb` which
    silently passed when the branch had no upstream tracking, hiding ahead
    state from the fork backup remote.
    """
    from scripts.health_check import check_git_remote_sync

    fake, captured = _git_remote_run_factory(rev_stdout="0\t0")
    with patch("scripts.health_check._run", side_effect=fake):
        check_git_remote_sync()

    # Find the rev-list invocation
    rev_list_cmds = [c for c in captured if "rev-list" in c]
    assert len(rev_list_cmds) == 1, (
        "expected exactly one git rev-list call, got: " + str(captured))
    cmd = rev_list_cmds[0]
    assert "--left-right" in cmd
    assert "--count" in cmd
    assert any("fork/main...HEAD" in arg for arg in cmd), (
        "rev-list must compare against fork/main, got: " + str(cmd))

    # And we must NOT be using `git status -sb` for the sync determination.
    status_sb = [c for c in captured
                 if "status" in c and "-sb" in c]
    assert not status_sb, (
        "must not use 'git status -sb' for fork backup delta: " + str(captured))
