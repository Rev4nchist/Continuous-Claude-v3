#!/usr/bin/env python3
"""Gate C: Phase 3b judge runner (subscription-OAuth backends, NO API keys).

Runs a REGISTRY of LLM judges against a sampled subset of Claude Code
sessions captured in Braintrust. This is an offline / async runner: it is
NOT in the live hook path. It reads completed-session traces from the local
cache or BTQL, runs every registered judge, and emits one feedback POST per
judge per sampled session.

Retirement (P32, 2026-09-24)
-----------------------------
The original three judges (``factuality``, ``closedqa``, ``plan_rubric``)
were retired. None of the three produced a usable score in production:
``closedqa`` filtered on a span name that never matched a live span, so it
never scored; ``plan_rubric`` never scored either; and ``factuality``
compared a prompt against an intent string derived from that same prompt,
which is circular by construction. Across 102 scheduled runs the judges
posted 22 scores and exited 0 every day, so the scheduler showed green while
the eval layer measured nothing.

This file keeps the RUNNER (sampling, feedback POST, idempotency, trace
loading, CLI, batch mode) and retires only the three broken rubrics. New
judges register in ``JUDGE_REGISTRY`` below. ``JUDGE_REGISTRY`` ships EMPTY.
A later change (P17) is expected to add binary judges -- one failure mode
each, pass/fail, validated against human labels -- rather than a three-point
rubric. When the registry is empty, ``judge_session()`` makes no subprocess
calls, POSTs nothing, and returns its normal result dict plus a
``"retired"`` key explaining why.

Judge registry
--------------
Each entry is a ``JudgeSpec``: a name, a subscription-OAuth backend
(``"claude"`` or ``"codex"``), and a ``build(trace)`` callable that returns
either ``(prompt, metadata)`` when the judge has what it needs, or a skip
reason string (e.g. ``"missing_input_or_output"``) when the trace lacks it.
``judge_session()`` iterates the registry and calls ``_score_and_post`` for
each entry that can build a prompt.

LLM backends (NO API keys -- both subscription-billed via OAuth)
----------------------------------------------------------------
A registered judge is graded by one of two subscription-OAuth subprocess
CLIs, never autoevals' OpenAI-client calls:

- ``codex exec --sandbox read-only "<prompt>"`` -- the ChatGPT subscription
  (this is a SAFE codex command: read-only sandbox, no file mutation).

- ``claude -p "<prompt>" --output-format json --model sonnet`` -- the Claude
  Code subscription (Sonnet bucket). NOTE: the child env strips
  ``ANTHROPIC_API_KEY`` / ``ANTHROPIC_AUTH_TOKEN`` so the subprocess uses
  subscription OAuth rather than an inherited external API key.

Sampling
--------
Deterministic per-session: ``int(sha256(session_id)[:8], 16) % 100 < 35``.
The same session_id always lands in or out of the sample. ~35% of sessions
are sampled overall. This keeps quota predictable and the decision easy to
audit.

Per-judge skip (don't crash the whole run)
-------------------------------------------
A subprocess non-zero exit / timeout / unparseable output skips THAT judge
with a reason (``codex_unavailable``, ``claude_timeout``,
``unparseable_score``, etc.), records it, and continues the others. A
session emits 0..N scores depending on backend success + artifact presence,
where N is the registry size (currently 0).

Idempotency
-----------
Each feedback POST id is derived from
``sha256(f"{session_id}:{judge_name}")[:16]``. Braintrust dedups on the
``id`` field, so re-runs are safe.

CLI
---
    cd opc
    uv run python -m scripts.core.judge_session --session-id <id>
    uv run python -m scripts.core.judge_session --scan-since 2026-05-20 \\
        --max-sessions 10 --dry-run

Environment / preflight
-----------------------
NO API keys are required for the judges. Preflight verifies only the CLIs a
REGISTERED judge actually needs (subscription OAuth):
- If any registered judge uses the codex backend: ``codex login status``
  must exit 0 (fix: ``codex login``).
- If any registered judge uses the claude backend: ``claude --version`` must
  exit 0 (fix: ``claude login``).
With an empty registry, preflight requires no CLI at all.

For the feedback POST:
- ``BRAINTRUST_API_KEY`` (required to actually POST feedback; the dry-run
  path tolerates absence).
- ``BRAINTRUST_CC_PROJECT_ID`` (required for the POST URL).
- ``TRACE_TO_BRAINTRUST`` ("true" to enable; otherwise POSTs are skipped).
- ``BRAINTRUST_API_URL`` (default https://api.braintrust.dev).
- ``BRAINTRUST_SESSION_ID`` (optional fallback when --session-id is unset).

Out of scope (deferred to follow-ups):
- Online scoring rule UI configuration (see
  ``docs/braintrust-online-scoring-recipe.md``).
- New binary judge definitions (P17).
- Phase 4 sub-agent correlation.
- Phase 5 closed-loop tuning.
- Distribution review of judge outputs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Union

import requests
from dotenv import load_dotenv

# Load opc/.env first (authoritative), then ~/.claude/.env, then CWD .env.
_OPC_ROOT = Path(__file__).resolve().parents[2]
opc_env = _OPC_ROOT / ".env"
if opc_env.exists():
    load_dotenv(opc_env, override=True)
global_env = Path.home() / ".claude" / ".env"
if global_env.exists():
    load_dotenv(global_env)
load_dotenv()


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SAMPLE_RATE_PERCENT = 35
BRAINTRUST_DEFAULT_URL = "https://api.braintrust.dev"
LOCAL_SESSION_CACHE = Path.home() / ".claude" / "state" / "braintrust_sessions"
PROJECT_REGISTRY = Path.home() / ".claude" / "project-registry.json"
FEEDBACK_TIMEOUT_SECONDS = 5.0

# Subprocess judge calls are slow LLM turns; allow up to 3 minutes each.
JUDGE_SUBPROCESS_TIMEOUT_SECONDS = 180


class JudgeBackendError(Exception):
    """A judge backend failed in a way that should skip ONLY that judge.

    The string value is the skip reason recorded in the result (e.g.
    ``codex_unavailable``, ``claude_timeout``, ``unparseable_score``). The
    orchestrator catches this, records the reason, and continues the other
    judges -- one backend failure never crashes the whole run.
    """


# ---------------------------------------------------------------------------
# Judge registry (P32, 2026-09-24: ships EMPTY -- see module docstring)
# ---------------------------------------------------------------------------

# A judge's ``build`` callable inspects a session trace and either returns
# ``(prompt, metadata)`` when it has what it needs, or a skip-reason string
# (e.g. ``"missing_input_or_output"``) when it doesn't.
JudgeBuildResult = Union["tuple[str, dict[str, Any]]", str]


@dataclass(frozen=True)
class JudgeSpec:
    """One registered judge: a name, its subscription backend, and a prompt
    builder. See the module docstring for how the registry is used."""

    name: str
    backend: str  # "claude" | "codex"
    build: Callable[[dict[str, Any]], JudgeBuildResult]


# Ships empty (P32, 2026-09-24): the three original judges (factuality,
# closedqa, plan_rubric) were retired because none produced a usable score.
# New binary judges (one failure mode each, pass/fail, validated against
# human labels -- P17) register here.
JUDGE_REGISTRY: list[JudgeSpec] = []


def _current_judge_backends() -> dict[str, str]:
    """Judge name -> backend, derived live from the registry (never stale)."""
    return {spec.name: spec.backend for spec in JUDGE_REGISTRY}


# ---------------------------------------------------------------------------
# Preflight: verify the subscription-OAuth CLIs are authenticated
# ---------------------------------------------------------------------------


def check_cli_preflight() -> None:
    """Fail fast if a REQUIRED judge CLI isn't ready.

    No API keys are used; instead we verify the subscription-OAuth CLIs are
    authenticated, but ONLY for backends a currently-registered judge uses:

    - If any registered judge uses the codex backend: ``codex login status``
      must exit 0.
    - If any registered judge uses the claude backend: ``claude --version``
      must exit 0.

    With an empty registry, no CLI is required. Names WHICH CLI isn't ready
    and the fix command, then exits non-zero.
    """
    backends = {spec.backend for spec in JUDGE_REGISTRY}

    if "codex" in backends:
        if _probe_cli(["codex", "login", "status"]) != 0:
            print(
                "ERROR: the `codex` CLI is not authenticated (required by a "
                "registered codex-backed judge). `codex login status` did not "
                "exit 0.\n"
                "Fix: run `codex login` (ChatGPT subscription OAuth), then retry.",
                file=sys.stderr,
            )
            sys.exit(2)

    if "claude" in backends:
        if _probe_cli(["claude", "--version"]) != 0:
            print(
                "ERROR: the `claude` CLI is not available (required by a "
                "registered claude-backed judge). `claude --version` did not "
                "exit 0.\n"
                "Fix: install/authenticate Claude Code (`claude login`), then retry.",
                file=sys.stderr,
            )
            sys.exit(2)


def _resolve_cli(name: str) -> str:
    """Resolve a CLI name to its full executable path (cross-platform).

    On Windows, ``codex`` is an npm shim installed as ``codex.cmd`` (plus a
    bash script with no extension). ``subprocess.run(["codex", ...])`` without
    ``shell=True`` only finds ``codex.exe`` and otherwise raises
    ``FileNotFoundError``. ``shutil.which`` honors PATHEXT, so it finds the
    ``.cmd``/``.exe`` shim. Falls back to the bare name if nothing resolves
    (lets the subprocess raise, which the callers convert to a skip reason).
    """
    return shutil.which(name) or name


def _probe_cli(cmd: list[str]) -> int:
    """Run a quick CLI probe and return its exit code (127 on any failure).

    The first element is resolved via ``shutil.which`` so Windows npm shims
    (e.g. ``codex.cmd``) are found.
    """
    if not cmd:
        return 127
    resolved = [_resolve_cli(cmd[0]), *cmd[1:]]
    try:
        proc = subprocess.run(
            resolved,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return proc.returncode
    except Exception:
        return 127


# ---------------------------------------------------------------------------
# Deterministic sampling
# ---------------------------------------------------------------------------


def is_sampled(session_id: str) -> bool:
    """Deterministic sampler. Same session_id always yields the same bool.

    Hash first 8 hex chars of sha256(session_id) -> int -> mod 100 < 35.
    """
    if not session_id:
        return False
    h = hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:8]
    return int(h, 16) % 100 < SAMPLE_RATE_PERCENT


def make_feedback_id(session_id: str, judge_name: str) -> str:
    """Deterministic feedback id for idempotency (T5 mitigation).

    Braintrust dedups feedback on the ``id`` field, so re-runs of this
    runner with the same session won't double-emit scores.
    """
    return hashlib.sha256(f"{session_id}:{judge_name}".encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Trace loading (local cache first, fall back to BTQL stub)
# ---------------------------------------------------------------------------


def load_trace(session_id: str) -> dict[str, Any] | None:
    """Load a completed session's relevant artifacts.

    Local-cache fast path: ``~/.claude/state/braintrust_sessions/<id>.json``
    contains session metadata. For Gate C we ALSO need the trace
    artifacts (recall, task, plan) which the metadata file alone doesn't
    carry. So we layer in:

    1. The local metadata file (root_span_id, project_id, etc).
    2. ``.claude/logs/memory-recall.jsonl`` joined on session_id for the
       top recall result.
    3. A BTQL fallback via ``opc/scripts/braintrust_analyze.py``'s
       ``run_sql`` helper to fetch Task and ExitPlanMode spans.

    Returns None when the session can't be loaded at all.
    """
    cache_path = LOCAL_SESSION_CACHE / f"{session_id}.json"
    meta: dict[str, Any] = {}
    if cache_path.exists():
        try:
            meta = json.loads(cache_path.read_text(encoding="utf-8"))
        except Exception:
            meta = {}

    # Read top recall chunk hint from memory-recall.jsonl (intent + score).
    # For now we use the recall *intent* text as a proxy for the chunk
    # because the chunk text isn't logged in the jsonl. The judge prompt
    # asks "is recalled context about what the user asked?" so the intent
    # text is a reasonable surface. Future enhancement: pull full chunk
    # body via the embedding daemon.
    top_recall_chunk = _read_top_recall_from_log(session_id)

    # Pull spans from BTQL (Task + ExitPlanMode). Best-effort: if BTQL
    # is unavailable, we return what we have and let the per-judge guards
    # decide whether to skip.
    spans = _fetch_session_spans(session_id, meta.get("project_id"))

    return {
        "session_id": session_id,
        "root_span_id": meta.get("root_span_id", session_id),
        "project_id": meta.get("project_id"),
        "user_prompt": spans.get("user_prompt", ""),
        "top_recall_chunk": top_recall_chunk,
        "task_spans": spans.get("task_spans", []),
        "plan_body": spans.get("plan_body", ""),
    }


def _candidate_recall_logs() -> list[Path]:
    """All memory-recall.jsonl locations to search, cross-project.

    The memory-awareness hook writes this log per-project
    (``<projectDir>/.claude/logs/memory-recall.jsonl``), so recall data is
    fragmented across project directories. To score factuality for a session
    from ANY project, search: the global log, the current working dir, and
    every project path in the registry. Deduped, order-preserving.
    """
    candidates: list[Path] = [
        Path.home() / ".claude" / "logs" / "memory-recall.jsonl",
        Path.cwd() / ".claude" / "logs" / "memory-recall.jsonl",
    ]
    try:
        reg = json.loads(PROJECT_REGISTRY.read_text(encoding="utf-8"))
        for proj in reg.get("projects", []):
            proj_path = proj.get("path")
            if proj_path:
                candidates.append(
                    Path(proj_path) / ".claude" / "logs" / "memory-recall.jsonl"
                )
    except Exception:
        pass  # registry missing/unreadable -> fall back to global + cwd
    seen: set[str] = set()
    deduped: list[Path] = []
    for c in candidates:
        key = str(c)
        if key not in seen:
            seen.add(key)
            deduped.append(c)
    return deduped


def _read_top_recall_from_log(session_id: str) -> str:
    """Return the highest-scoring recall intent for this session, or ''.

    Searches every candidate recall log (global + cwd + each registry
    project), so a session from any project is scorable -- not just the one
    whose .claude/logs the runner happens to be sitting in.
    """
    best_score = -1.0
    best_intent = ""
    for log_path in _candidate_recall_logs():
        if not log_path.exists():
            continue
        try:
            for line in log_path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                if row.get("session_id") != session_id:
                    continue
                score = float(row.get("top_score") or 0.0)
                if score > best_score:
                    best_score = score
                    best_intent = str(row.get("intent") or "")
        except Exception:
            continue
    return best_intent


def _fetch_session_spans(session_id: str, project_id: str | None) -> dict[str, Any]:
    """Best-effort BTQL fetch for Task spans, ExitPlanMode plan, root prompt.

    Returns a dict shaped like:
        {
          "user_prompt": "...",
          "task_spans": [{"span_id", "parent_span_id", "task_request", "agent_output"}],
          "plan_body": "...",
        }
    Returns empty fields on any failure (the per-judge guards handle skip).
    """
    if not project_id:
        return {"user_prompt": "", "task_spans": [], "plan_body": ""}

    api_key = os.environ.get("BRAINTRUST_API_KEY", "")
    if not api_key:
        return {"user_prompt": "", "task_spans": [], "plan_body": ""}

    # Lazy import to avoid breaking unit tests if the analyzer file moves.
    try:
        sys.path.insert(0, str(_OPC_ROOT / "scripts"))
        from braintrust_analyze import run_sql  # type: ignore
    except Exception:
        return {"user_prompt": "", "task_spans": [], "plan_body": ""}

    out: dict[str, Any] = {"user_prompt": "", "task_spans": [], "plan_body": ""}

    # Root prompt (best-effort: first user message text on the root span).
    try:
        rows = run_sql(
            project_id,
            f"""
            SELECT input as prompt
            FROM logs
            WHERE root_span_id = '{session_id}' AND id = root_span_id
            LIMIT 1
            """,
            api_key,
        )
        if rows:
            out["user_prompt"] = str(rows[0].get("prompt") or "")
    except Exception:
        pass

    # Task spans (orchestrator -> sub-agent).
    try:
        task_rows = run_sql(
            project_id,
            f"""
            SELECT id as span_id,
                   span_parents,
                   input,
                   output
            FROM logs
            WHERE root_span_id = '{session_id}'
              AND span_attributes['name'] = 'Task'
            """,
            api_key,
        )
        task_spans = []
        for r in task_rows or []:
            parents = r.get("span_parents") or []
            parent = parents[0] if isinstance(parents, list) and parents else None
            task_spans.append(
                {
                    "span_id": r.get("span_id"),
                    "parent_span_id": parent,
                    "tool_name": "Task",
                    "task_request": _coerce_str(r.get("input")),
                    "agent_output": _coerce_str(r.get("output")),
                }
            )
        out["task_spans"] = task_spans
    except Exception:
        pass

    # ExitPlanMode plan body.
    try:
        plan_rows = run_sql(
            project_id,
            f"""
            SELECT input
            FROM logs
            WHERE root_span_id = '{session_id}'
              AND metadata['tool_name'] = 'ExitPlanMode'
            ORDER BY created ASC
            LIMIT 1
            """,
            api_key,
        )
        if plan_rows:
            inp = plan_rows[0].get("input") or {}
            if isinstance(inp, dict):
                out["plan_body"] = str(inp.get("plan") or inp.get("plan_body") or "")
            else:
                out["plan_body"] = _coerce_str(inp)
    except Exception:
        pass

    return out


def _coerce_str(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)


# ---------------------------------------------------------------------------
# Judge prompt infrastructure
# ---------------------------------------------------------------------------
#
# 2026-09-24 (P32): the three hand-written rubrics that used to live here
# (factuality, closedqa, plan_rubric) are retired -- see the module
# docstring. ``_STRUCTURED_OUTPUT_DEMAND`` stays: a new judge's ``build``
# function (registered in ``JUDGE_REGISTRY``) can still append it to its
# prompt so the backend returns ONLY parseable JSON.

_STRUCTURED_OUTPUT_DEMAND = (
    'Respond with ONLY this JSON and nothing else: '
    '{"score": <float 0.0-1.0>, "rationale": "<one sentence>"}'
)


# ---------------------------------------------------------------------------
# Score parsing (tolerate markdown fences / preamble / trailing noise)
# ---------------------------------------------------------------------------


def _parse_judge_json(text: str) -> dict[str, Any]:
    """Find the first ``{...}`` block in ``text`` and normalize it.

    Backends wrap the judge JSON in preamble, markdown fences, or trailing
    noise (codex echoes token counts; the model may add prose). We scan for
    the first balanced ``{...}`` that parses as JSON and contains a numeric
    ``score``. Returns ``{"score": float, "rationale": str}``.

    Raises ``ValueError`` if no parseable score block is found.
    """
    if not text:
        raise ValueError("empty backend output")

    # Scan every '{' and try to parse the smallest balanced object from there.
    for match in re.finditer(r"\{", text):
        start = match.start()
        depth = 0
        for i in range(start, len(text)):
            ch = text[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    candidate = text[start : i + 1]
                    try:
                        obj = json.loads(candidate)
                    except Exception:
                        break  # not valid JSON from this '{' -> try next '{'
                    if isinstance(obj, dict) and "score" in obj:
                        return _normalize_score_obj(obj)
                    break  # parsed but no score -> try next '{'
    raise ValueError("no parseable {score, rationale} block in backend output")


def _normalize_score_obj(obj: dict[str, Any]) -> dict[str, Any]:
    """Coerce a parsed object to ``{"score": float[0..1], "rationale": str}``."""
    try:
        score = float(obj.get("score"))
    except (TypeError, ValueError):
        raise ValueError("score is not a number")
    # Clamp to [0.0, 1.0] -- judges occasionally emit out-of-range values.
    score = max(0.0, min(1.0, score))
    rationale = obj.get("rationale")
    if not isinstance(rationale, str):
        rationale = "" if rationale is None else str(rationale)
    return {"score": score, "rationale": rationale}


# ---------------------------------------------------------------------------
# Judge backends (subscription-OAuth subprocess CLIs, mocked in tests)
# ---------------------------------------------------------------------------


def _judge_via_codex(prompt: str) -> dict[str, Any]:
    """Grade ``prompt`` via ``codex exec --sandbox read-only`` (ChatGPT sub).

    SAFE codex invocation: ``--sandbox read-only`` cannot mutate files. Parses
    the judge JSON out of stdout (tolerating codex's hook/token-count noise).

    Raises ``JudgeBackendError`` with a skip reason on non-zero exit, timeout,
    or unparseable output -- the caller skips only this judge.
    """
    cmd = [_resolve_cli("codex"), "exec", "--sandbox", "read-only", prompt]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=JUDGE_SUBPROCESS_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise JudgeBackendError("codex_timeout")
    except Exception:
        raise JudgeBackendError("codex_unavailable")

    if proc.returncode != 0:
        raise JudgeBackendError("codex_unavailable")

    try:
        return _parse_judge_json(proc.stdout or "")
    except ValueError:
        raise JudgeBackendError("unparseable_score")


def _judge_via_claude_headless(prompt: str) -> dict[str, Any]:
    """Grade ``prompt`` via ``claude -p ... --output-format json --model sonnet``.

    DOUBLE-LAYER parse: ``claude -p --output-format json`` returns a Claude
    Code *envelope* JSON whose ``.result`` field is a STRING containing the
    model's text output -- and that text is itself the judge JSON. So we parse
    the envelope, take ``.result``, then parse the judge JSON from within it.

    The child env strips ``ANTHROPIC_API_KEY`` / ``ANTHROPIC_AUTH_TOKEN`` so
    the subprocess authenticates via subscription OAuth (the Sonnet bucket)
    instead of an inherited external API key (which would 401).

    Raises ``JudgeBackendError`` with a skip reason on non-zero exit, timeout,
    envelope error, or unparseable output.
    """
    cmd = [_resolve_cli("claude"), "-p", prompt, "--output-format", "json", "--model", "sonnet"]
    env = _claude_child_env()
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=JUDGE_SUBPROCESS_TIMEOUT_SECONDS,
            env=env,
        )
    except subprocess.TimeoutExpired:
        raise JudgeBackendError("claude_timeout")
    except Exception:
        raise JudgeBackendError("claude_unavailable")

    if proc.returncode != 0:
        raise JudgeBackendError("claude_unavailable")

    # Layer 1: parse the Claude Code envelope.
    try:
        envelope = json.loads((proc.stdout or "").strip())
    except Exception:
        raise JudgeBackendError("unparseable_score")
    if not isinstance(envelope, dict):
        raise JudgeBackendError("unparseable_score")
    # An auth/runtime failure surfaces as is_error=true with the error text in
    # .result (e.g. "Invalid API key"). Treat that as unavailable.
    if envelope.get("is_error"):
        raise JudgeBackendError("claude_unavailable")

    inner = envelope.get("result")
    if not isinstance(inner, str):
        raise JudgeBackendError("unparseable_score")

    # Layer 2: the .result string is itself the judge JSON.
    try:
        return _parse_judge_json(inner)
    except ValueError:
        raise JudgeBackendError("unparseable_score")


def _claude_child_env() -> dict[str, str]:
    """Copy the current env but strip external Anthropic API credentials.

    ``opc/.env`` sets ``ANTHROPIC_API_KEY`` (for PageIndex). If the ``claude``
    subprocess inherits it, Claude Code uses it as an external API key and
    401s instead of using subscription OAuth. Stripping both Anthropic
    credential vars forces the subscription path.
    """
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("ANTHROPIC_AUTH_TOKEN", None)
    return env


def _run_judge(backend: str, prompt: str) -> dict[str, Any]:
    """Dispatch a judge prompt to the given subscription backend."""
    if backend == "codex":
        return _judge_via_codex(prompt)
    if backend == "claude":
        return _judge_via_claude_headless(prompt)
    raise JudgeBackendError("no_backend_configured")


# ---------------------------------------------------------------------------
# Feedback POST
# ---------------------------------------------------------------------------


def _post_feedback(
    *,
    feedback_id: str,
    judge_name: str,
    score: float,
    metadata: dict[str, Any],
) -> bool:
    """POST a single feedback entry to Braintrust. Fail-open, returns True on 2xx."""
    if os.environ.get("TRACE_TO_BRAINTRUST", "false").lower() != "true":
        return False
    api_key = os.environ.get("BRAINTRUST_API_KEY", "")
    if not api_key:
        return False
    project_id = os.environ.get("BRAINTRUST_CC_PROJECT_ID", "").strip()
    if not project_id:
        return False

    api_url = os.environ.get("BRAINTRUST_API_URL", BRAINTRUST_DEFAULT_URL)
    url = f"{api_url}/v1/project_logs/{project_id}/feedback"
    payload = {
        "feedback": [
            {
                "id": feedback_id,
                "scores": {judge_name: float(score)},
                "metadata": metadata,
            }
        ]
    }
    try:
        resp = requests.post(
            url,
            json=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            timeout=FEEDBACK_TIMEOUT_SECONDS,
        )
        return 200 <= resp.status_code < 300
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Core judging entrypoint
# ---------------------------------------------------------------------------


def judge_session(
    trace: dict[str, Any], dry_run: bool = False, force: bool = False
) -> dict[str, Any]:
    """Score a single session's trace against every registered judge.

    ``force`` bypasses the 35% sampler (single-session/on-demand use). When a
    session is judged only because of ``force``, the result carries
    ``"forced": True`` and ``"sampled"`` reflects the true (un-forced) hash.

    When ``JUDGE_REGISTRY`` is empty (the shipped state as of P32,
    2026-09-24), no judge runs: no subprocess calls, no POSTs. The result
    carries a ``"retired"`` key explaining why instead.

    Returns a result dict:
        {
          "session_id": "...",
          "sampled": bool,
          "posts": int,         # actual POSTs performed
          "would_post": int,    # planned POSTs in dry-run mode
          "skipped": { judge_name: reason, ... },
          "retired": "...",     # present only when the registry is empty
        }
    """
    session_id = trace.get("session_id", "")
    result: dict[str, Any] = {
        "session_id": session_id,
        "sampled": False,
        "posts": 0,
        "would_post": 0,
        "skipped": {},
    }

    # Mark retirement before the sampling return, so every session in a retired
    # run carries the marker the batch ratchet looks for (CodeRabbit #52).
    if not JUDGE_REGISTRY:
        result["retired"] = (
            "no judges registered (P32, 2026-09-24); new binary judges "
            "arrive with P17"
        )

    in_sample = is_sampled(session_id)
    if not in_sample and not force:
        return result
    result["sampled"] = in_sample
    if force and not in_sample:
        result["forced"] = True

    if not JUDGE_REGISTRY:
        return result

    for spec in JUDGE_REGISTRY:
        built = spec.build(trace)
        if isinstance(built, str):
            result["skipped"][spec.name] = built
            continue
        prompt, metadata = built
        _score_and_post(
            result,
            session_id=session_id,
            judge_name=spec.name,
            backend=spec.backend,
            prompt=prompt,
            metadata=metadata,
            dry_run=dry_run,
        )

    return result


def _score_and_post(
    result: dict[str, Any],
    *,
    session_id: str,
    judge_name: str,
    backend: str,
    prompt: str,
    metadata: dict[str, Any],
    dry_run: bool,
) -> None:
    """Run one judge through its backend and POST the score (or record skip).

    Mutates ``result`` in place:
    - dry_run: increments ``would_post`` (no backend call, no POST).
    - success: runs the backend, POSTs feedback, increments ``posts``.
    - JudgeBackendError: records the skip reason (e.g. ``codex_unavailable``,
      ``claude_timeout``, ``unparseable_score``) and continues -- one judge's
      failure never crashes the run.
    """
    if dry_run:
        result["would_post"] += 1
        return

    try:
        parsed = _run_judge(backend, prompt)
    except JudgeBackendError as e:
        result["skipped"][judge_name] = str(e)
        return
    except Exception as e:  # defensive: unexpected backend failure
        result["skipped"][judge_name] = f"judge_error: {type(e).__name__}"
        return

    fid = make_feedback_id(session_id, judge_name)
    enriched = {**metadata, "rationale": parsed.get("rationale", "")}
    ok = _post_feedback(
        feedback_id=fid,
        judge_name=judge_name,
        score=float(parsed.get("score", 0.0) or 0.0),
        metadata=enriched,
    )
    if ok:
        result["posts"] += 1
    else:
        result["skipped"][judge_name] = "post_failed_or_disabled"


# ---------------------------------------------------------------------------
# Batch helpers
# ---------------------------------------------------------------------------


def list_sessions_since(scan_since: str) -> list[dict[str, Any]]:
    """List session_ids from the local cache that started on/after ``scan_since``.

    ``scan_since`` is an ISO date or datetime string. Best-effort: any cache
    entry whose ``started`` field is missing or unparseable is skipped and
    counted on stderr (it used to be re-judged on every daily run). Results
    are newest first, so a cap keeps the most recent sessions.
    """
    if not LOCAL_SESSION_CACHE.exists():
        return []
    cutoff = _parse_iso(scan_since)
    sessions: list[dict[str, Any]] = []
    undated = 0
    for path in sorted(LOCAL_SESSION_CACHE.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        started = _parse_iso(str(data.get("started") or ""))
        if started is None:
            # 2026-09-23 (Opus 5.5 eval, P32): undated sessions used to be included on EVERY
            # daily run, so the same stale sessions were re-judged forever and crowded out
            # new ones. They are now skipped and counted instead.
            undated += 1
            continue
        if cutoff is None or started >= cutoff:
            sessions.append({"session_id": path.stem, "started": data.get("started"), "_started": _utc_sort_key(str(data.get("started")))})
    if undated:
        print(f"[judge-batch] skipped {undated} cached session(s) with no 'started' date", file=sys.stderr)
    # Newest first, so the max_sessions cap keeps the most recent sessions rather than the
    # first N by UUID order.
    sessions.sort(key=lambda s: s["_started"], reverse=True)
    for s in sessions:
        s.pop("_started", None)
    return sessions


def _utc_sort_key(value: str) -> float:
    """Seconds since the epoch in UTC, for ordering only.

    _parse_iso converts to naive LOCAL time, which can reorder sessions across a
    daylight-saving fall-back hour; sorting on UTC avoids that. Naive inputs are
    treated as UTC. Unparseable values sort last.
    """
    v = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        dt = datetime.fromisoformat(v)
    except Exception:
        return float("-inf")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _parse_iso(value: str) -> datetime | None:
    """Parse an ISO date or datetime. Returns offset-NAIVE datetime in UTC.

    All comparisons in this module are naive-vs-naive so we don't trip the
    'can't compare offset-naive and offset-aware datetimes' TypeError when
    the cutoff is a bare date like '2026-05-20' and the cache 'started'
    field is a timezoned ISO string like '2026-04-23T11:52:25Z'.
    """
    if not value:
        return None
    # Handle trailing Z (UTC) which fromisoformat rejects in older Pythons.
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(value)
    except Exception:
        return None
    # Coerce to naive UTC for safe comparison.
    if dt.tzinfo is not None:
        dt = dt.astimezone(tz=None).replace(tzinfo=None)
    return dt


def run_batch(
    scan_since: str,
    max_sessions: int = 10,
    dry_run: bool = False,
) -> list[dict[str, Any]]:
    """Process up to ``max_sessions`` sessions started since ``scan_since``."""
    sessions = list_sessions_since(scan_since)
    sessions = sessions[: max_sessions]
    results: list[dict[str, Any]] = []
    for s in sessions:
        sid = s["session_id"]
        trace = load_trace(sid)
        if trace is None:
            results.append(
                {
                    "session_id": sid,
                    "sampled": False,
                    "posts": 0,
                    "would_post": 0,
                    "skipped": {"all": "trace_not_found"},
                }
            )
            continue
        results.append(judge_session(trace, dry_run=dry_run))
    return results


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="judge_session",
        description=(
            "Gate C: Phase 3b judge runner (subscription-OAuth backends, "
            "no API keys)."
        ),
    )
    p.add_argument("--session-id", default=None, help="Single-session mode.")
    p.add_argument(
        "--scan-since",
        default=None,
        help="Batch mode: ISO date/datetime cutoff for sessions to process.",
    )
    p.add_argument(
        "--max-sessions",
        type=int,
        default=10,
        help="Cap batch size (default 10).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print sampling decisions only. Zero LLM calls, zero POSTs.",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help=(
            "Single-session mode only: bypass the 35%% sampler and judge the "
            "session regardless of its hash (on-demand/debug scoring)."
        ),
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    # Preflight verifies the subscription CLIs are authenticated. A dry-run
    # makes no backend calls (it only reports sampling + routing), so we skip
    # the auth check in that mode -- useful for quota audits on a box where the
    # CLIs aren't logged in.
    if not args.dry_run:
        check_cli_preflight()

    if args.force and args.scan_since:
        print(
            "NOTE: --force is ignored in batch mode (--scan-since); it only "
            "applies to single-session --session-id.",
            file=sys.stderr,
        )

    if args.scan_since:
        results = run_batch(
            scan_since=args.scan_since,
            max_sessions=args.max_sessions,
            dry_run=args.dry_run,
        )
        print(
            json.dumps(
                {
                    "mode": "batch",
                    "scan_since": args.scan_since,
                    "max_sessions": args.max_sessions,
                    "dry_run": args.dry_run,
                    "backends": _current_judge_backends(),
                    "count": len(results),
                    "results": results,
                },
                indent=2,
            )
        )
        return 0

    # Single-session mode
    session_id = (args.session_id or "").strip()
    if not session_id:
        session_id = os.environ.get("BRAINTRUST_SESSION_ID", "").strip()
    if not session_id:
        print(
            "ERROR: No session_id provided and BRAINTRUST_SESSION_ID env var "
            "unset. Pass --session-id <id> or set BRAINTRUST_SESSION_ID.",
            file=sys.stderr,
        )
        sys.exit(2)

    trace = load_trace(session_id)
    if trace is None:
        print(
            json.dumps({"mode": "single", "session_id": session_id, "error": "trace_not_found"}),
        )
        return 1
    result = judge_session(trace, dry_run=args.dry_run, force=args.force)
    print(
        json.dumps(
            {
                "mode": "single",
                "dry_run": args.dry_run,
                "backends": _current_judge_backends(),
                "result": result,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
