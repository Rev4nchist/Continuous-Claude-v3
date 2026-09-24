"""Tests for Gate C: Phase 3b judge runner (subscription-OAuth, REGISTRY rework).

These tests stub out ``subprocess.run`` (the two judge backends) and the
feedback HTTP POST, so no real LLM calls and no real Braintrust traffic
occurs.

2026-09-24 (P32): the three original hard-coded judges (factuality,
closedqa, plan_rubric) were retired -- none produced a usable score in
production. ``judge_session.py`` now carries an empty ``JUDGE_REGISTRY`` and
the RUNNER mechanism (sampling, feedback POST, idempotency, per-judge skip,
routing) is exercised here against FAKE registered judges, not the retired
rubrics. Coverage:

- Preflight fails fast when a REQUIRED CLI (of a REGISTERED judge) is
  unavailable; passes when both CLIs are ready; requires NOTHING when the
  registry is empty
- Deterministic sampling (same session_id -> same in/out)
- ~35% sample rate across random IDs (statistical tolerance)
- A fake claude-backed + fake codex-backed judge each POST once for an
  in-sample session; 0 POSTs when out of sample
- --max-sessions caps batch size
- --dry-run produces 0 subprocess calls and 0 feedback POSTs
- Idempotency: re-run produces same deterministic feedback IDs
- Backend routing: a codex-backed judge spec calls the codex backend; a
  claude-backed judge spec calls the claude backend (incl. --model sonnet)
- Claude envelope -> .result -> judge-JSON DOUBLE parse
- Codex stdout with preamble/noise -> first {...} judge JSON parsed
- Per-judge skip: one registered judge's backend failure skips only that
  judge; the other registered judge still POSTs
- The SHIPPED registry is empty: judge_session() returns "retired" with 0
  posts and no subprocess calls
- Orphan exit: no session_id and no BRAINTRUST_SESSION_ID
"""

from __future__ import annotations

import hashlib
import json
import random
import subprocess
import sys
from pathlib import Path
from unittest import mock

import pytest

# Ensure scripts/core is importable
_CORE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_CORE_DIR))


# ---------------------------------------------------------------------------
# Canned subprocess outputs
# ---------------------------------------------------------------------------


def _codex_stdout(score: float = 0.8, rationale: str = "codex says") -> str:
    """Codex stdout has preamble/noise lines then the judge JSON."""
    judge_json = json.dumps({"score": score, "rationale": rationale})
    return (
        "hook: UserPromptSubmit\n"
        "hook: UserPromptSubmit Completed\n"
        "codex\n"
        f"{judge_json}\n"
        "tokens used\n"
        "23604\n"
        f"{judge_json}\n"  # codex tends to echo it twice; parser takes the first
    )


def _claude_envelope_stdout(
    score: float = 0.9, rationale: str = "claude says", is_error: bool = False
) -> str:
    """Claude Code headless envelope wraps the judge JSON string in .result.

    DOUBLE layer: the envelope is JSON, and envelope['result'] is itself a
    string containing the judge JSON.
    """
    inner_judge_json = json.dumps({"score": score, "rationale": rationale})
    envelope = {
        "type": "result",
        "subtype": "success",
        "is_error": is_error,
        "result": inner_judge_json,  # <- the model's text output, itself judge JSON
        "session_id": "fake-claude-session",
        "total_cost_usd": 0.0,
    }
    return json.dumps(envelope)


def _make_completed(stdout: str, returncode: int = 0) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(
        args=["fake"], returncode=returncode, stdout=stdout, stderr=""
    )


# ---------------------------------------------------------------------------
# Fixtures: minimal session traces
# ---------------------------------------------------------------------------


@pytest.fixture
def sample_session_trace():
    """A session trace dict with recall, top-level Task, and plan artifacts."""
    return {
        "session_id": "sess-fixture-001",
        "user_prompt": "How do I add a new hook to the Claude Code system?",
        "top_recall_chunk": (
            "Hooks live in .claude/hooks/src/*.ts and are compiled by esbuild "
            "to dist/*.mjs. Register them in ~/.claude/settings.json via Node "
            "atomic write."
        ),
        "task_spans": [
            {
                "span_id": "task-1",
                "parent_span_id": "root-1",  # parent is root, NOT another Task
                "tool_name": "Task",
                "task_request": "Find all hook source files and list their names.",
                "agent_output": (
                    "Found 47 hook source files under .claude/hooks/src/, including "
                    "memory-awareness.ts, telemetry-tracker.ts, plan-exit-tracker.ts."
                ),
            }
        ],
        "plan_body": (
            "1. Add new hook scaffold at .claude/hooks/src/new-hook.ts.\n"
            "2. Implement handler logic.\n"
            "3. Build with `npm run build`.\n"
            "4. Register in settings.json.\n"
            "5. Test with vitest.\n"
            "Verification: run `npm test` and confirm hook fires on a test input."
        ),
    }


# ---------------------------------------------------------------------------
# Helper to import the module fresh
# ---------------------------------------------------------------------------


def _import_judge_session():
    """Import the judge_session module fresh, isolated from prior imports."""
    if "judge_session" in sys.modules:
        del sys.modules["judge_session"]
    import judge_session  # noqa: E402

    return judge_session


def _set_post_env(monkeypatch) -> None:
    """Env needed for the POST path (no OPENAI_API_KEY anymore)."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("BRAINTRUST_API_KEY", "bt-test-fixture")
    monkeypatch.setenv("BRAINTRUST_CC_PROJECT_ID", "test-project-id")
    monkeypatch.setenv("TRACE_TO_BRAINTRUST", "true")


def _register_fake_judges(js, monkeypatch):
    """Register one claude-backed and one codex-backed FAKE judge.

    Mirrors what a real P17 binary judge registration will look like: a
    ``JudgeSpec`` with a ``build(trace)`` callable returning ``(prompt,
    metadata)`` or a skip-reason string.
    """

    def build_claude_judge(trace):
        prompt = trace.get("user_prompt") or ""
        if not prompt:
            return "missing_input_or_output"
        return (
            f"grade: {prompt}",
            {"judge": "fake_claude_judge", "session_id": trace.get("session_id")},
        )

    def build_codex_judge(trace):
        plan = trace.get("plan_body") or ""
        if not plan:
            return "missing_input_or_output"
        return (
            f"grade plan: {plan}",
            {"judge": "fake_codex_judge", "session_id": trace.get("session_id")},
        )

    registry = [
        js.JudgeSpec(name="fake_claude_judge", backend="claude", build=build_claude_judge),
        js.JudgeSpec(name="fake_codex_judge", backend="codex", build=build_codex_judge),
    ]
    monkeypatch.setattr(js, "JUDGE_REGISTRY", registry)
    return registry


# ---------------------------------------------------------------------------
# Preflight (requires only the CLIs of REGISTERED judges)
# ---------------------------------------------------------------------------


def test_preflight_requires_nothing_when_registry_empty(monkeypatch):
    js = _import_judge_session()
    assert js.JUDGE_REGISTRY == []

    def boom(cmd, **kwargs):
        raise AssertionError("empty registry must not probe any CLI")

    monkeypatch.setattr(js.subprocess, "run", boom)
    js.check_cli_preflight()  # should not raise, should not probe


def test_preflight_fails_fast_when_codex_cli_unavailable(monkeypatch):
    """`codex login status` != 0 -> SystemExit (non-zero), for a codex-backed judge."""
    js = _import_judge_session()
    _register_fake_judges(js, monkeypatch)

    def fake_run(cmd, **kwargs):
        # codex login status fails; claude --version succeeds
        if "login" in cmd:
            return _make_completed("not logged in", returncode=1)
        return _make_completed("2.1.150 (Claude Code)", returncode=0)

    monkeypatch.setattr(js.subprocess, "run", fake_run)

    with pytest.raises(SystemExit) as excinfo:
        js.check_cli_preflight()
    assert excinfo.value.code != 0


def test_preflight_names_codex_and_fix_command(monkeypatch, capsys):
    js = _import_judge_session()
    _register_fake_judges(js, monkeypatch)

    def fake_run(cmd, **kwargs):
        if "login" in cmd:
            return _make_completed("not logged in", returncode=1)
        return _make_completed("2.1.150", returncode=0)

    monkeypatch.setattr(js.subprocess, "run", fake_run)
    with pytest.raises(SystemExit):
        js.check_cli_preflight()
    err = capsys.readouterr().err
    assert "codex" in err.lower()
    assert "codex login" in err.lower()


def test_preflight_fails_fast_when_claude_cli_unavailable(monkeypatch, capsys):
    """`claude --version` != 0 -> SystemExit naming claude + fix command."""
    js = _import_judge_session()
    _register_fake_judges(js, monkeypatch)

    def fake_run(cmd, **kwargs):
        if "login" in cmd:  # codex login status
            return _make_completed("Logged in using ChatGPT", returncode=0)
        return _make_completed("command not found", returncode=127)

    monkeypatch.setattr(js.subprocess, "run", fake_run)
    with pytest.raises(SystemExit):
        js.check_cli_preflight()
    err = capsys.readouterr().err
    assert "claude" in err.lower()
    assert "claude login" in err.lower()


def test_preflight_passes_when_both_clis_ready(monkeypatch):
    js = _import_judge_session()
    _register_fake_judges(js, monkeypatch)

    def fake_run(cmd, **kwargs):
        return _make_completed("ok", returncode=0)

    monkeypatch.setattr(js.subprocess, "run", fake_run)
    js.check_cli_preflight()  # should not raise


# ---------------------------------------------------------------------------
# Deterministic sampling (UNCHANGED)
# ---------------------------------------------------------------------------


def test_sampling_is_deterministic_per_session_id():
    js = _import_judge_session()
    sid = "deterministic-test-session-abc"
    decisions = {js.is_sampled(sid) for _ in range(50)}
    assert len(decisions) == 1, "Same session_id must produce deterministic sample decision"


def test_sampling_rate_approximates_35_percent():
    """Across many random IDs, ~35% should land in the sample (+/- 3%)."""
    js = _import_judge_session()
    rng = random.Random(42)  # reproducible
    in_count = 0
    n = 1000
    for _ in range(n):
        sid = f"sid-{rng.randint(0, 10_000_000)}-{rng.randint(0, 10_000_000)}"
        if js.is_sampled(sid):
            in_count += 1
    rate = in_count / n
    assert 0.32 <= rate <= 0.38, f"Expected ~35% sample rate, got {rate:.3f}"


# ---------------------------------------------------------------------------
# Feedback ID determinism (UNCHANGED idempotency)
# ---------------------------------------------------------------------------


def test_feedback_id_is_deterministic_sha256():
    js = _import_judge_session()
    sid = "fixed-session-x"
    judge = "fake_claude_judge"
    fid1 = js.make_feedback_id(sid, judge)
    fid2 = js.make_feedback_id(sid, judge)
    assert fid1 == fid2
    expected = hashlib.sha256(f"{sid}:{judge}".encode()).hexdigest()[:16]
    assert fid1 == expected
    assert js.make_feedback_id(sid, "fake_codex_judge") != fid1


# ---------------------------------------------------------------------------
# Score parsing: codex stdout + claude envelope double-parse (UNCHANGED)
# ---------------------------------------------------------------------------


def test_parse_score_finds_first_json_block_with_preamble():
    js = _import_judge_session()
    parsed = js._parse_judge_json(_codex_stdout(score=0.8, rationale="ok"))
    assert parsed["score"] == 0.8
    assert parsed["rationale"] == "ok"


def test_parse_score_tolerates_markdown_fences():
    js = _import_judge_session()
    fenced = 'Sure, here you go:\n```json\n{"score": 0.5, "rationale": "mid"}\n```\n'
    parsed = js._parse_judge_json(fenced)
    assert parsed["score"] == 0.5
    assert parsed["rationale"] == "mid"


def test_parse_score_normalizes_missing_rationale():
    js = _import_judge_session()
    parsed = js._parse_judge_json('{"score": 1.0}')
    assert parsed["score"] == 1.0
    assert isinstance(parsed["rationale"], str)


def test_parse_score_raises_on_unparseable():
    js = _import_judge_session()
    with pytest.raises(ValueError):
        js._parse_judge_json("there is no json here at all")


def test_judge_via_codex_invokes_read_only_sandbox(monkeypatch):
    js = _import_judge_session()
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["timeout"] = kwargs.get("timeout")
        return _make_completed(_codex_stdout(score=0.7, rationale="codex"))

    monkeypatch.setattr(js.subprocess, "run", fake_run)
    parsed = js._judge_via_codex("grade this plan")
    assert parsed["score"] == 0.7
    # Assert it called: codex exec --sandbox read-only "<prompt>"
    # cmd[0] is the resolved executable path (e.g. codex.cmd on Windows).
    cmd = captured["cmd"]
    assert "codex" in cmd[0].lower()
    assert "exec" in cmd
    assert "--sandbox" in cmd
    assert "read-only" in cmd
    assert "grade this plan" in cmd
    assert captured["timeout"] == 180


def test_judge_via_claude_headless_double_parses_envelope(monkeypatch):
    js = _import_judge_session()
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["env"] = kwargs.get("env")
        captured["timeout"] = kwargs.get("timeout")
        return _make_completed(_claude_envelope_stdout(score=0.9, rationale="claude"))

    monkeypatch.setattr(js.subprocess, "run", fake_run)
    parsed = js._judge_via_claude_headless("answer the question?")
    # DOUBLE parse: envelope.result string -> judge JSON
    assert parsed["score"] == 0.9
    assert parsed["rationale"] == "claude"
    # Assert claude command shape incl. --model sonnet
    # cmd[0] is the resolved executable path (e.g. claude.exe on Windows).
    cmd = captured["cmd"]
    assert "claude" in cmd[0].lower()
    assert "-p" in cmd
    assert "answer the question?" in cmd
    assert "--output-format" in cmd
    assert "json" in cmd
    assert "--model" in cmd
    assert "sonnet" in cmd
    assert captured["timeout"] == 180


def test_judge_via_claude_strips_anthropic_api_key_from_child_env(monkeypatch):
    """The claude subprocess must NOT inherit ANTHROPIC_API_KEY (forces OAuth)."""
    js = _import_judge_session()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-should-be-stripped")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "should-be-stripped-too")
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["env"] = kwargs.get("env")
        return _make_completed(_claude_envelope_stdout())

    monkeypatch.setattr(js.subprocess, "run", fake_run)
    js._judge_via_claude_headless("x")
    env = captured["env"]
    assert env is not None, "claude subprocess must pass an explicit env"
    assert "ANTHROPIC_API_KEY" not in env
    assert "ANTHROPIC_AUTH_TOKEN" not in env


def test_judge_via_claude_skips_on_envelope_is_error(monkeypatch):
    """When the claude envelope reports is_error=true (e.g. auth failure), the
    judge backend raises JudgeBackendError('claude_unavailable') so only that
    judge is skipped."""
    js = _import_judge_session()

    def fake_run(cmd, **kwargs):
        return _make_completed(
            _claude_envelope_stdout(is_error=True, rationale="Invalid API key")
        )

    monkeypatch.setattr(js.subprocess, "run", fake_run)
    with pytest.raises(js.JudgeBackendError) as excinfo:
        js._judge_via_claude_headless("x")
    assert str(excinfo.value) == "claude_unavailable"


# ---------------------------------------------------------------------------
# Registry mechanism: routing, sampling gate, dry-run, idempotency, skip
# ---------------------------------------------------------------------------


def _setup_run_mocks(monkeypatch, js, force_in_sample: bool = True):
    """Common mock setup: env, two fake registered judges, both backends, POST."""
    _set_post_env(monkeypatch)
    monkeypatch.setattr(js, "is_sampled", lambda _sid: force_in_sample)
    _register_fake_judges(js, monkeypatch)

    calls = {"codex": [], "claude": []}

    def fake_codex(prompt):
        calls["codex"].append(prompt)
        return {"score": 0.8, "rationale": "codex"}

    def fake_claude(prompt):
        calls["claude"].append(prompt)
        return {"score": 0.9, "rationale": "claude"}

    monkeypatch.setattr(js, "_judge_via_codex", fake_codex)
    monkeypatch.setattr(js, "_judge_via_claude_headless", fake_claude)

    posts: list = []

    def fake_post(url, json=None, headers=None, timeout=None):
        posts.append({"url": url, "json": json, "headers": headers})
        resp = mock.MagicMock()
        resp.status_code = 200
        return resp

    monkeypatch.setattr(js.requests, "post", fake_post)
    return posts, calls


def test_sampled_session_posts_once_per_registered_judge(monkeypatch, sample_session_trace):
    js = _import_judge_session()
    posts, calls = _setup_run_mocks(monkeypatch, js, force_in_sample=True)

    result = js.judge_session(sample_session_trace, dry_run=False)

    assert len(posts) == 2, f"Expected 2 feedback POSTs (2 registered judges), got {len(posts)}"
    for p in posts:
        assert "/v1/project_logs/" in p["url"]
        assert p["url"].endswith("/feedback")
    fids = [p["json"]["feedback"][0]["id"] for p in posts]
    assert len(set(fids)) == 2, "Each judge gets its own feedback id"
    assert result["sampled"] is True
    assert result["posts"] == 2
    assert "retired" not in result


def test_backend_routing_follows_judge_spec(monkeypatch, sample_session_trace):
    """Each JudgeSpec's declared backend is the one actually invoked."""
    js = _import_judge_session()
    posts, calls = _setup_run_mocks(monkeypatch, js, force_in_sample=True)

    js.judge_session(sample_session_trace, dry_run=False)

    # fake_codex_judge -> codex backend, called exactly once
    assert len(calls["codex"]) == 1
    # fake_claude_judge -> claude backend, called exactly once
    assert len(calls["claude"]) == 1


def test_out_of_sample_session_produces_zero_posts(monkeypatch, sample_session_trace):
    js = _import_judge_session()
    posts, calls = _setup_run_mocks(monkeypatch, js, force_in_sample=False)

    result = js.judge_session(sample_session_trace, dry_run=False)

    assert len(posts) == 0
    assert result["sampled"] is False
    assert result["posts"] == 0
    assert calls["codex"] == [] and calls["claude"] == []


# ---------------------------------------------------------------------------
# Dry run: 0 subprocess calls and 0 POSTs
# ---------------------------------------------------------------------------


def test_dry_run_makes_no_subprocess_calls_and_no_posts(monkeypatch, sample_session_trace):
    js = _import_judge_session()
    _set_post_env(monkeypatch)
    monkeypatch.setattr(js, "is_sampled", lambda _sid: True)
    _register_fake_judges(js, monkeypatch)

    def boom(*a, **k):
        raise AssertionError("Dry run must not invoke a judge backend")

    monkeypatch.setattr(js, "_judge_via_codex", boom)
    monkeypatch.setattr(js, "_judge_via_claude_headless", boom)

    # Also assert no raw subprocess.run leaks through
    def boom_run(*a, **k):
        raise AssertionError("Dry run must not call subprocess.run")

    monkeypatch.setattr(js.subprocess, "run", boom_run)

    posts: list = []

    def boom_post(*a, **k):
        posts.append((a, k))
        raise AssertionError("Dry run must not POST")

    monkeypatch.setattr(js.requests, "post", boom_post)

    result = js.judge_session(sample_session_trace, dry_run=True)
    assert posts == []
    assert result["sampled"] is True
    assert result["would_post"] == 2


# ---------------------------------------------------------------------------
# Idempotency on re-run
# ---------------------------------------------------------------------------


def test_idempotent_rerun_produces_same_feedback_ids(monkeypatch, sample_session_trace):
    js = _import_judge_session()
    posts1, _ = _setup_run_mocks(monkeypatch, js, force_in_sample=True)
    js.judge_session(sample_session_trace, dry_run=False)
    ids_run1 = sorted(p["json"]["feedback"][0]["id"] for p in posts1)

    posts2, _ = _setup_run_mocks(monkeypatch, js, force_in_sample=True)
    js.judge_session(sample_session_trace, dry_run=False)
    ids_run2 = sorted(p["json"]["feedback"][0]["id"] for p in posts2)

    assert ids_run1 == ids_run2, "Re-running with same session_id must yield identical feedback IDs"


# ---------------------------------------------------------------------------
# Per-judge skip: one registered judge's backend failure skips only that
# judge; the other registered judge still POSTs
# ---------------------------------------------------------------------------


def test_codex_backend_failure_skips_only_that_judge(monkeypatch, sample_session_trace):
    js = _import_judge_session()
    _set_post_env(monkeypatch)
    monkeypatch.setattr(js, "is_sampled", lambda _sid: True)
    _register_fake_judges(js, monkeypatch)

    def codex_fails(prompt):
        raise js.JudgeBackendError("codex_unavailable")

    def claude_ok(prompt):
        return {"score": 0.9, "rationale": "claude"}

    monkeypatch.setattr(js, "_judge_via_codex", codex_fails)
    monkeypatch.setattr(js, "_judge_via_claude_headless", claude_ok)

    posts: list = []

    def fake_post(url, json=None, headers=None, timeout=None):
        posts.append({"url": url, "json": json})
        resp = mock.MagicMock()
        resp.status_code = 200
        return resp

    monkeypatch.setattr(js.requests, "post", fake_post)

    result = js.judge_session(sample_session_trace, dry_run=False)

    assert "fake_codex_judge" in result["skipped"]
    assert result["skipped"]["fake_codex_judge"] == "codex_unavailable"
    # fake_claude_judge still posted
    assert result["posts"] == 1
    posted_judges = {list(p["json"]["feedback"][0]["scores"].keys())[0] for p in posts}
    assert posted_judges == {"fake_claude_judge"}


def test_claude_backend_timeout_skips_only_that_judge(monkeypatch, sample_session_trace):
    js = _import_judge_session()
    _set_post_env(monkeypatch)
    monkeypatch.setattr(js, "is_sampled", lambda _sid: True)
    _register_fake_judges(js, monkeypatch)

    def claude_times_out(prompt):
        raise js.JudgeBackendError("claude_timeout")

    def codex_ok(prompt):
        return {"score": 0.8, "rationale": "codex"}

    monkeypatch.setattr(js, "_judge_via_codex", codex_ok)
    monkeypatch.setattr(js, "_judge_via_claude_headless", claude_times_out)

    posts: list = []

    def fake_post(url, json=None, headers=None, timeout=None):
        posts.append({"url": url, "json": json})
        resp = mock.MagicMock()
        resp.status_code = 200
        return resp

    monkeypatch.setattr(js.requests, "post", fake_post)

    result = js.judge_session(sample_session_trace, dry_run=False)
    assert result["skipped"]["fake_claude_judge"] == "claude_timeout"
    assert result["posts"] == 1  # fake_codex_judge only


# ---------------------------------------------------------------------------
# A judge's build() can itself return a skip reason (missing trace fields)
# ---------------------------------------------------------------------------


def test_judge_build_skip_reason_is_recorded_without_running_backend(
    monkeypatch, sample_session_trace
):
    js = _import_judge_session()
    _set_post_env(monkeypatch)
    monkeypatch.setattr(js, "is_sampled", lambda _sid: True)
    _register_fake_judges(js, monkeypatch)

    trace = {**sample_session_trace, "plan_body": ""}  # fake_codex_judge needs plan_body

    def boom(*a, **k):
        raise AssertionError("a judge that returned a skip reason must not call a backend")

    monkeypatch.setattr(js, "_judge_via_codex", boom)
    monkeypatch.setattr(js, "_judge_via_claude_headless", lambda p: {"score": 0.9, "rationale": "ok"})
    monkeypatch.setattr(js.requests, "post", lambda *a, **k: mock.MagicMock(status_code=200))

    result = js.judge_session(trace, dry_run=False)
    assert result["skipped"]["fake_codex_judge"] == "missing_input_or_output"
    assert result["posts"] == 1


# ---------------------------------------------------------------------------
# The SHIPPED registry is empty: retirement contract
# ---------------------------------------------------------------------------


def test_shipped_registry_is_empty():
    js = _import_judge_session()
    assert js.JUDGE_REGISTRY == []


def test_empty_registry_returns_retired_with_zero_posts_no_subprocess_calls(
    monkeypatch, sample_session_trace
):
    js = _import_judge_session()
    assert js.JUDGE_REGISTRY == []  # the actual shipped state, not a fake
    _set_post_env(monkeypatch)
    monkeypatch.setattr(js, "is_sampled", lambda _sid: True)

    def boom_run(*a, **k):
        raise AssertionError("empty registry must not call subprocess.run")

    monkeypatch.setattr(js.subprocess, "run", boom_run)

    def boom_post(*a, **k):
        raise AssertionError("empty registry must not POST")

    monkeypatch.setattr(js.requests, "post", boom_post)

    result = js.judge_session(sample_session_trace, dry_run=False)
    assert result["sampled"] is True
    assert result["posts"] == 0
    assert result["would_post"] == 0
    assert result["skipped"] == {}
    assert "retired" in result
    assert "P32" in result["retired"]


def test_empty_registry_marks_out_of_sample_sessions_retired_too(sample_session_trace, monkeypatch):
    """The batch ratchet keys on "retired"; an out-of-sample session must carry it as well."""
    js = _import_judge_session()
    assert js.JUDGE_REGISTRY == []
    monkeypatch.setattr(js, "is_sampled", lambda _sid: False)

    result = js.judge_session(sample_session_trace, dry_run=False)
    assert result["sampled"] is False
    assert result["posts"] == 0
    assert "P32" in result["retired"]


# ---------------------------------------------------------------------------
# Batch + max-sessions cap (UNCHANGED)
# ---------------------------------------------------------------------------


def test_max_sessions_caps_batch_size(monkeypatch):
    js = _import_judge_session()

    fake_sessions = [{"session_id": f"sess-{i:03d}"} for i in range(100)]
    monkeypatch.setattr(js, "list_sessions_since", lambda since: fake_sessions)
    monkeypatch.setattr(js, "load_trace", lambda sid: {"session_id": sid})

    processed: list = []

    def fake_judge(trace, dry_run=False):
        processed.append(trace["session_id"])
        return {"sampled": False, "posts": 0, "would_post": 0, "skipped": {}}

    monkeypatch.setattr(js, "judge_session", fake_judge)

    js.run_batch(scan_since="2026-05-20", max_sessions=5, dry_run=True)
    assert len(processed) == 5


# ---------------------------------------------------------------------------
# Orphan-call exit: no session_id and no BRAINTRUST_SESSION_ID env
# ---------------------------------------------------------------------------


def test_no_session_id_and_no_env_var_exits_with_explicit_error(monkeypatch, capsys):
    js = _import_judge_session()
    monkeypatch.delenv("BRAINTRUST_SESSION_ID", raising=False)
    # Preflight must pass so we reach the orphan check, not exit on CLI preflight.
    monkeypatch.setattr(js, "check_cli_preflight", lambda: None)

    with pytest.raises(SystemExit):
        js.main(["--session-id", ""])  # explicitly empty

    captured = capsys.readouterr()
    combined = captured.out + captured.err
    assert "No session_id" in combined or "BRAINTRUST_SESSION_ID" in combined


# ---------------------------------------------------------------------------
# --force: bypass the sampler for single-session / on-demand judging
# ---------------------------------------------------------------------------


def test_force_judges_out_of_sample_session(monkeypatch, sample_session_trace):
    """force=True judges a session even when it hashes out of the 35% sample."""
    js = _import_judge_session()
    posts, _calls = _setup_run_mocks(monkeypatch, js, force_in_sample=False)

    result = js.judge_session(sample_session_trace, dry_run=False, force=True)

    assert result["forced"] is True
    assert result["sampled"] is False  # true hash status preserved for transparency
    assert result["posts"] == 2
    assert len(posts) == 2


def test_force_false_leaves_out_of_sample_session_unjudged(monkeypatch, sample_session_trace):
    """Without force, an out-of-sample session is untouched (no 'forced' key)."""
    js = _import_judge_session()
    posts, _calls = _setup_run_mocks(monkeypatch, js, force_in_sample=False)

    result = js.judge_session(sample_session_trace, dry_run=False, force=False)

    assert result["sampled"] is False
    assert "forced" not in result
    assert result["posts"] == 0
    assert len(posts) == 0


def test_force_in_sample_session_not_marked_forced(monkeypatch, sample_session_trace):
    """force=True on an in-sample session judges it but does NOT set forced."""
    js = _import_judge_session()
    _posts, _calls = _setup_run_mocks(monkeypatch, js, force_in_sample=True)

    result = js.judge_session(sample_session_trace, dry_run=False, force=True)

    assert result["sampled"] is True
    assert "forced" not in result  # only set when force bypassed an out-of-sample hash


# ---------------------------------------------------------------------------
# Cross-project recall aggregation (read-side, via project registry)
# ---------------------------------------------------------------------------


def test_candidate_recall_logs_includes_registry_projects(monkeypatch, tmp_path):
    """_candidate_recall_logs spans global + cwd + every registry project path."""
    js = _import_judge_session()
    reg = {
        "version": 1,
        "projects": [
            {"path": str(tmp_path / "projA"), "status": "active"},
            {"path": str(tmp_path / "projB"), "status": "active"},
        ],
    }
    reg_file = tmp_path / "project-registry.json"
    reg_file.write_text(json.dumps(reg), encoding="utf-8")
    monkeypatch.setattr(js, "PROJECT_REGISTRY", reg_file)

    candidates = [str(p) for p in js._candidate_recall_logs()]

    assert all(c.endswith("memory-recall.jsonl") for c in candidates)
    assert any("projA" in c for c in candidates)
    assert any("projB" in c for c in candidates)
    assert len(candidates) == len(set(candidates))  # de-duplicated


def test_candidate_recall_logs_falls_back_when_registry_missing(monkeypatch, tmp_path):
    """A missing/unreadable registry degrades to global + cwd (no crash)."""
    js = _import_judge_session()
    monkeypatch.setattr(js, "PROJECT_REGISTRY", tmp_path / "does-not-exist.json")

    candidates = js._candidate_recall_logs()

    assert len(candidates) >= 2  # global + cwd at minimum
    assert all(str(p).endswith("memory-recall.jsonl") for p in candidates)


def test_read_top_recall_finds_cross_project_log(monkeypatch, tmp_path):
    """A session's recall is found in a registry project's log, not just cwd."""
    js = _import_judge_session()
    logdir = tmp_path / "otherproj" / ".claude" / "logs"
    logdir.mkdir(parents=True)
    (logdir / "memory-recall.jsonl").write_text(
        json.dumps(
            {"session_id": "sess-xproj-find", "intent": "cross project hit", "top_score": 0.9}
        )
        + "\n",
        encoding="utf-8",
    )
    reg = {"projects": [{"path": str(tmp_path / "otherproj"), "status": "active"}]}
    reg_file = tmp_path / "reg.json"
    reg_file.write_text(json.dumps(reg), encoding="utf-8")
    monkeypatch.setattr(js, "PROJECT_REGISTRY", reg_file)

    assert js._read_top_recall_from_log("sess-xproj-find") == "cross project hit"


def test_read_top_recall_picks_highest_score_across_logs(monkeypatch, tmp_path):
    """When a session appears in multiple project logs, the highest score wins."""
    js = _import_judge_session()
    for sub, intent, score in (("p1", "low", 0.2), ("p2", "high", 0.95)):
        d = tmp_path / sub / ".claude" / "logs"
        d.mkdir(parents=True)
        (d / "memory-recall.jsonl").write_text(
            json.dumps({"session_id": "sess-xproj-multi", "intent": intent, "top_score": score})
            + "\n",
            encoding="utf-8",
        )
    reg = {"projects": [{"path": str(tmp_path / "p1")}, {"path": str(tmp_path / "p2")}]}
    reg_file = tmp_path / "reg.json"
    reg_file.write_text(json.dumps(reg), encoding="utf-8")
    monkeypatch.setattr(js, "PROJECT_REGISTRY", reg_file)

    assert js._read_top_recall_from_log("sess-xproj-multi") == "high"


# ---------------------------------------------------------------------------
# Batch sampling (2026-09-23 Opus 5.5 eval, P32)
# ---------------------------------------------------------------------------


def test_list_sessions_since_skips_undated_and_returns_newest_first(tmp_path, monkeypatch):
    js = _import_judge_session()
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "old.json").write_text(json.dumps({"started": "2026-09-01T10:00:00Z"}), encoding="utf-8")
    (cache / "new.json").write_text(json.dumps({"started": "2026-09-20T10:00:00Z"}), encoding="utf-8")
    (cache / "mid.json").write_text(json.dumps({"started": "2026-09-10T10:00:00Z"}), encoding="utf-8")
    (cache / "undated.json").write_text(json.dumps({"foo": 1}), encoding="utf-8")
    (cache / "before.json").write_text(json.dumps({"started": "2026-08-01T10:00:00Z"}), encoding="utf-8")
    monkeypatch.setattr(js, "LOCAL_SESSION_CACHE", cache)

    got = [s["session_id"] for s in js.list_sessions_since("2026-08-15")]

    # Undated sessions used to be re-judged on every daily run; they are skipped now.
    assert "undated" not in got
    assert "before" not in got
    # Newest first, so the max_sessions cap keeps the most recent sessions.
    assert got == ["new", "mid", "old"]
