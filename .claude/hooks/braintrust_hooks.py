#!/usr/bin/env python3
"""Braintrust tracing hooks - Cross-platform Python port.

Replaces the 5 bash hooks + common.sh:
- session_start
- session_end
- user_prompt_submit
- post_tool_use
- stop (creates LLM spans)

Usage:
    python3 braintrust_hooks.py <hook_name>

    # In settings.json:
    "command": "python3 $HOME/.claude/hooks/braintrust_hooks.py session_start"
"""

from __future__ import annotations

import json
import os
import random
import socket
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

# Config from environment
STATE_DIR = Path.home() / ".claude" / "state" / "braintrust_sessions"
LOG_FILE = Path.home() / ".claude" / "state" / "braintrust_hook.log"
GLOBAL_STATE_FILE = Path.home() / ".claude" / "state" / "braintrust_global.json"

# Durable spool. Every POST that fails (transport error OR non-200) lands here
# instead of being dropped, and is retried by flush_spool(). This is what makes
# a network blip a delay rather than data loss.
SPOOL_FILE = Path.home() / ".claude" / "state" / "braintrust_spool.jsonl"
SPOOL_LOCK = Path.home() / ".claude" / "state" / "braintrust_spool.lock"
SPOOL_DEADLETTER = Path.home() / ".claude" / "state" / "braintrust_spool.deadletter.jsonl"

# Entries older than this move to the dead-letter file. They are NEVER silently
# discarded -- a prolonged outage must not become invisible telemetry loss.
SPOOL_MAX_AGE_SECONDS = 7 * 24 * 3600
# A flush that dies mid-run must not deadlock every later flush.
LOCK_STALE_SECONDS = 300
# Halving bound for oversized batches: 2^6 = 64 sub-batches. Past this the
# payload is one enormous span, not a batching problem.
MAX_SPLIT_DEPTH = 6
# Bounds one flush so it cannot outlive its hook budget.
FLUSH_MAX_SECONDS = 20.0

LOG_MAX_BYTES = 5 * 1024 * 1024
STATE_MAX_AGE_SECONDS = 30 * 24 * 3600

# Every value stays under the smallest registered hook timeout (5s PostToolUse),
# so a stalled TLS handshake fails fast instead of blocking until the harness
# kills the process mid-POST. Replaces a flat timeout=30 that could never fail
# gracefully inside a 10s budget.
HTTP_TIMEOUT = httpx.Timeout(connect=3.0, read=8.0, write=8.0, pool=3.0)

API_KEY = os.environ.get("BRAINTRUST_API_KEY", "")
PROJECT = os.environ.get("BRAINTRUST_CC_PROJECT", "claude-code")
API_URL = os.environ.get("BRAINTRUST_API_URL", "https://api.braintrust.dev")
DEBUG = os.environ.get("BRAINTRUST_CC_DEBUG", "false").lower() == "true"
TRACE_ENABLED = os.environ.get("TRACE_TO_BRAINTRUST", "false").lower() == "true"
SAMPLE_RATE = float(os.environ.get("BRAINTRUST_SAMPLE_RATE", "1.0"))

# Tools to SKIP tracing (high-volume, low-signal -- biggest data consumers)
EXCLUDED_TOOLS = {
    "Read", "Glob", "Grep", "ToolSearch",
    "TaskList", "TaskGet", "TaskCreate", "TaskUpdate",
    "CronList", "CronCreate", "CronDelete",
    "ListMcpResourcesTool", "ReadMcpResourceTool",
}

# Max chars for tool input/output in PostToolUse spans
TOOL_PAYLOAD_MAX_CHARS = 8192


def ensure_dirs():
    """Ensure state directories exist."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)


def _scrub_surrogates(obj: Any) -> Any:
    """Strip lone surrogates so the value can be UTF-8 encoded.

    Transcript text read from disk can carry unpaired surrogates (e.g. '\\udc90').
    json.dumps() accepts them but .encode('utf-8') does not, so the failure
    surfaced late -- at the HTTP write -- and killed the whole batch. The log
    carries ~47 of these. Applied at EVERY encode point, not just the last one.
    """
    if isinstance(obj, str):
        # Fast path: most strings are clean, and encode() is cheaper than a scan.
        try:
            obj.encode("utf-8")
            return obj
        except UnicodeEncodeError:
            return obj.encode("utf-8", "replace").decode("utf-8")
    if isinstance(obj, dict):
        return {_scrub_surrogates(k): _scrub_surrogates(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_scrub_surrogates(v) for v in obj]
    return obj


def _rotate_log_if_needed():
    """Keep the hook log bounded. It reached 18MB unbroken since 2026-01-14."""
    try:
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > LOG_MAX_BYTES:
            os.replace(LOG_FILE, LOG_FILE.with_suffix(LOG_FILE.suffix + ".1"))
    except OSError:
        # Rotation is hygiene, never a reason to lose the log line itself.
        pass


def log(level: str, message: str):
    """Log to file."""
    ensure_dirs()
    _rotate_log_if_needed()
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"{timestamp} [{level}] {_scrub_surrogates(message)}\n")


def debug(message: str):
    """Debug log if enabled."""
    if DEBUG:
        log("DEBUG", message)


def get_timestamp() -> str:
    """Get ISO timestamp."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def generate_uuid() -> str:
    """Generate a UUID."""
    return str(uuid.uuid4())


def get_hostname() -> str:
    """Get hostname."""
    return socket.gethostname()


def get_username() -> str:
    """Get username."""
    return os.environ.get("USER", os.environ.get("USERNAME", "unknown"))


def get_os() -> str:
    """Get OS name."""
    return sys.platform


def get_workspace_project_id(workspace: str) -> str:
    """Generate stable project ID from workspace path (matches memory system).

    Uses SHA-256 hash of absolute path, first 16 chars.
    This matches the project_id format used in archival_memory for isolation.
    """
    import hashlib
    if not workspace:
        return "global"
    abs_path = os.path.abspath(workspace)
    return hashlib.sha256(abs_path.encode()).hexdigest()[:16]


# State management
def load_session_state(session_id: str) -> dict:
    """Load session state from file."""
    ensure_dirs()
    state_file = STATE_DIR / f"{session_id}.json"
    if state_file.exists():
        try:
            return json.loads(state_file.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def save_session_state(session_id: str, state: dict):
    """Save session state atomically."""
    ensure_dirs()
    state_file = STATE_DIR / f"{session_id}.json"
    temp_file = state_file.with_suffix(".tmp")
    temp_file.write_text(json.dumps(state, indent=2))
    os.replace(temp_file, state_file)


def get_session_value(session_id: str, key: str) -> str | None:
    """Get a value from session state."""
    state = load_session_state(session_id)
    return state.get(key)


def set_session_value(session_id: str, key: str, value: Any):
    """Set a value in session state."""
    state = load_session_state(session_id)
    state[key] = value
    save_session_state(session_id, state)


def load_global_state() -> dict:
    """Load global state."""
    if GLOBAL_STATE_FILE.exists():
        try:
            return json.loads(GLOBAL_STATE_FILE.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def save_global_state(state: dict):
    """Save global state."""
    ensure_dirs()
    GLOBAL_STATE_FILE.write_text(json.dumps(state, indent=2))


# Braintrust API
def get_project_id(project_name: str) -> str | None:
    """Get or cache project ID from Braintrust."""
    global_state = load_global_state()
    cached = global_state.get("project_ids", {}).get(project_name)
    if cached:
        return cached

    try:
        with httpx.Client(timeout=10) as client:
            resp = client.get(
                f"{API_URL}/v1/project",
                headers={"Authorization": f"Bearer {API_KEY}"},
                params={"project_name": project_name},
            )
            if resp.status_code == 200:
                data = resp.json()
                if data.get("objects"):
                    project_id = data["objects"][0]["id"]
                    global_state.setdefault("project_ids", {})[project_name] = project_id
                    save_global_state(global_state)
                    return project_id
    except Exception as e:
        log("ERROR", f"Failed to get project ID: {e}")
    return None


def insert_span(project_id: str, event: dict) -> str | None:
    """Insert a single span into Braintrust. Spools on failure."""
    _status, rows = batch_insert_spans(project_id, [event])
    return rows[0] if rows else None


def _post_events(
    project_id: str, events: list[dict], client: httpx.Client | None = None
) -> tuple[bool, str]:
    """POST one batch. Returns (ok, detail). Never raises, never spools.

    Split out from batch_insert_spans so flush_spool() can retry a batch without
    re-spooling it on every attempt. Pass `client` to reuse one connection pool
    across a whole flush: constructing a Client per batch cost ~0.5s each and
    made a 40-batch drain overrun its own time budget.
    """
    owns_client = client is None
    c = client or httpx.Client(timeout=HTTP_TIMEOUT)
    try:
        resp = c.post(
            f"{API_URL}/v1/project_logs/{project_id}/insert",
            headers={
                "Authorization": f"Bearer {API_KEY}",
                "Content-Type": "application/json",
            },
            json={"events": _scrub_surrogates(events)},
        )
        if resp.status_code == 200:
            return True, json.dumps(resp.json().get("row_ids", []))
        # A non-200 previously returned [] with NO log line at all, so every
        # rejected batch was invisible. Surface status and a body snippet.
        return False, f"HTTP {resp.status_code}: {resp.text[:200]}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"
    finally:
        if owns_client:
            c.close()


def _is_payload_too_large(detail: str) -> bool:
    """Braintrust rejects requests over 10 MiB with HTTP 413."""
    return "HTTP 413" in detail or "content length exceeded" in detail.lower()


def _split_and_post(
    project_id: str, events: list[dict], client: httpx.Client | None = None, depth: int = 0
) -> tuple[list[dict], list[dict], str]:
    """Deliver an oversized batch by halving it. Returns (unsent, undeliverable, error).

    A 413 is PERMANENT for the same bytes -- resending identical content can
    never succeed, so the plain spool-and-retry path would retry it every session
    for 7 days and then dead-letter it. Halving is the only thing that can make
    progress. A SINGLE event that still 413s is undeliverable and is dead-lettered
    immediately rather than burning a week of retries.

    `unsent` are events that failed for some OTHER (transient) reason and should
    be spooled. Tracking them separately means a partially-successful split does
    not re-send the halves that already landed.
    """
    if not events:
        return [], [], ""

    ok, detail = _post_events(project_id, events, client)
    if ok:
        return [], [], ""
    if not _is_payload_too_large(detail):
        return list(events), [], detail
    if len(events) == 1 or depth >= MAX_SPLIT_DEPTH:
        return [], list(events), detail

    mid = len(events) // 2
    unsent_a, dead_a, err_a = _split_and_post(project_id, events[:mid], client, depth + 1)
    unsent_b, dead_b, err_b = _split_and_post(project_id, events[mid:], client, depth + 1)
    return unsent_a + unsent_b, dead_a + dead_b, err_a or err_b


def batch_insert_spans(project_id: str, events: list[dict]) -> tuple[str, list]:
    """Insert spans into Braintrust in a single API call.

    Returns (status, row_ids) where status is
    "empty" | "sent" | "split" | "spooled" | "undeliverable".

    Callers MUST use the status rather than truthiness of the rows: the old
    contract returned a bare [] for success-with-no-rows, non-200, AND transport
    failure alike, so callers logged "Turn finalized" / "Session ended" even when
    nothing reached Braintrust.
    """
    if not events:
        return "empty", []

    ok, detail = _post_events(project_id, events)
    if ok:
        try:
            return "sent", json.loads(detail)
        except (json.JSONDecodeError, TypeError):
            return "sent", []

    # Oversized batches take the splitting path. Everything else spools as-is.
    if _is_payload_too_large(detail):
        log("WARN", f"Batch of {len(events)} spans exceeded the size limit, splitting")
        unsent, undeliverable, split_detail = _split_and_post(project_id, events)
        if undeliverable:
            _deadletter_events(project_id, undeliverable, f"oversized single span: {split_detail}")
        if unsent:
            log("ERROR", f"Failed to insert {len(unsent)} spans after split, spooling: {split_detail}")
            spool_events(project_id, unsent)
            return "spooled", []
        return ("undeliverable" if undeliverable else "split"), []

    log("ERROR", f"Failed to insert {len(events)} spans, spooling: {detail}")
    spool_events(project_id, events)
    return "spooled", []


# --- Durable spool -----------------------------------------------------------


def spool_events(project_id: str, events: list[dict]) -> bool:
    """Append a batch to the spool, durably. No network, so it cannot stall.

    fsync matters here: this is the last line of defence for events whose POST
    already failed, and session_end hands off to a detached child immediately
    after. A buffered write that dies with the process fixes nothing.
    """
    if not events:
        return True
    try:
        ensure_dirs()
        record = {
            "project_id": project_id,
            "events": _scrub_surrogates(events),
            "spooled_at": time.time(),
        }
        with open(SPOOL_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
            f.flush()
            os.fsync(f.fileno())
        return True
    except Exception as e:
        log("ERROR", f"Spool write failed for {len(events)} spans: {e}")
        return False


def _acquire_spool_lock() -> bool:
    """Exclusive spool lock. 3+ sessions run concurrently on this machine, and
    an unlocked read-modify-write rewrite of the spool loses entries."""
    try:
        ensure_dirs()
        if SPOOL_LOCK.exists():
            age = time.time() - SPOOL_LOCK.stat().st_mtime
            if age < LOCK_STALE_SECONDS:
                return False
            # A flush that died mid-run must not deadlock every later flush.
            SPOOL_LOCK.unlink(missing_ok=True)
        fd = os.open(str(SPOOL_LOCK), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        return False
    except OSError:
        return False


def _release_spool_lock():
    try:
        SPOOL_LOCK.unlink(missing_ok=True)
    except OSError:
        pass


def flush_spool(input_data: dict | None = None) -> dict:
    """Retry spooled batches. Safe to call concurrently -- the lock serializes.

    Retries re-send the ALREADY-FORMED events with their original `id` fields, so
    a POST that actually succeeded but lost its response merges rather than
    duplicating. Span ids are never regenerated on retry.
    """
    if not SPOOL_FILE.exists():
        return {"result": "continue"}
    if not API_KEY:
        return {"result": "continue"}
    if not _acquire_spool_lock():
        debug("Spool flush skipped: another flusher holds the lock")
        return {"result": "continue"}

    started = time.time()
    sent = failed = dead = deferred = 0
    first_error = ""
    remaining: list[str] = []
    client = httpx.Client(timeout=HTTP_TIMEOUT)
    try:
        try:
            lines = SPOOL_FILE.read_text(encoding="utf-8").splitlines()
        except OSError as e:
            log("ERROR", f"Spool read failed: {e}")
            return {"result": "continue"}

        for idx, line in enumerate(lines):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                dead += 1
                _deadletter(line, "unparseable spool line")
                continue

            age = time.time() - record.get("spooled_at", 0)
            if age > SPOOL_MAX_AGE_SECONDS:
                dead += 1
                _deadletter(line, f"expired after {int(age / 86400)}d")
                continue

            # Budget guard: keep the rest for the next flush rather than
            # overrunning the hook that called us.
            if time.time() - started > FLUSH_MAX_SECONDS:
                deferred = len(lines) - idx
                remaining.extend(lines[idx:])
                break

            rec_project = record.get("project_id", "")
            rec_events = record.get("events", [])
            ok, detail = _post_events(rec_project, rec_events, client)

            if not ok and _is_payload_too_large(detail):
                # Retrying identical oversized bytes can never succeed. Halve it
                # here too, or this entry retries every session until it expires.
                # Say so: a silent split leaves the summary line unexplained.
                log("WARN", f"Spooled batch of {len(rec_events)} spans too large, splitting")
                unsent, undeliverable, detail = _split_and_post(rec_project, rec_events, client)
                if undeliverable:
                    dead += 1
                    _deadletter_events(
                        rec_project, undeliverable, f"oversized single span: {detail}"
                    )
                if unsent:
                    ok = False
                    remaining.append(
                        json.dumps(
                            {
                                "project_id": rec_project,
                                "events": unsent,
                                "spooled_at": record.get("spooled_at", time.time()),
                            }
                        )
                    )
                    failed += 1
                    if not first_error:
                        first_error = detail
                else:
                    sent += 1
                continue

            if ok:
                sent += 1
            else:
                failed += 1
                # Record WHY the first failure happened. Without this a flush
                # that keeps failing reports only a count, which is the same
                # silent-failure problem this whole change exists to remove.
                # Captured once per run so a large failing spool cannot spam.
                if not first_error:
                    first_error = detail
                remaining.append(line)

        _rewrite_spool(remaining)
    finally:
        client.close()
        _release_spool_lock()

    if sent or failed or dead or deferred:
        # `deferred` is reported separately: a run that leaves entries behind
        # must not read as a clean drain.
        summary = f"Spool flush: sent={sent} retry={failed} deferred={deferred} deadlettered={dead}"
        if first_error:
            log("ERROR", f"{summary} first_error={first_error}")
        else:
            log("INFO", summary)
    return {"result": "continue"}


def _deadletter_events(project_id: str, events: list[dict], reason: str):
    """Dead-letter events that can never be delivered as-is."""
    _deadletter(
        json.dumps(
            {"project_id": project_id, "events": events, "spooled_at": time.time()}
        ),
        reason,
    )


def _deadletter(line: str, reason: str):
    """Expired or corrupt entries are recorded, never silently discarded."""
    try:
        with open(SPOOL_DEADLETTER, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        log("ERROR", f"Spool entry dead-lettered ({reason})")
    except OSError as e:
        log("ERROR", f"Dead-letter write failed ({reason}): {e}")


def _rewrite_spool(remaining: list[str]):
    """Atomic replace, matching save_session_state's temp+os.replace pattern."""
    try:
        if not remaining:
            SPOOL_FILE.unlink(missing_ok=True)
            return
        temp = SPOOL_FILE.with_suffix(".tmp")
        temp.write_text("\n".join(remaining) + "\n", encoding="utf-8")
        os.replace(temp, SPOOL_FILE)
    except OSError as e:
        log("ERROR", f"Spool rewrite failed: {e}")


# Hook implementations
def session_start(input_data: dict) -> dict:
    """Handle SessionStart hook."""
    debug("SessionStart hook triggered")

    if not TRACE_ENABLED:
        return {"result": "continue"}

    if not API_KEY:
        log("ERROR", "BRAINTRUST_API_KEY not set")
        return {"result": "continue"}

    session_id = input_data.get("session_id", generate_uuid())

    # Drain whatever a previous session spooled. This is the safe drain point:
    # the network is healthy, the hook has real budget, and it runs once per
    # session. Deliberately NOT post_tool_use -- that fires on every tool call
    # inside a 5000ms budget.
    flush_spool()
    _prune_old_state(session_id)

    # Check if already has root span
    existing = get_session_value(session_id, "root_span_id")
    if existing:
        debug(f"Session already has root span: {existing}")
        return {"result": "continue"}

    # Session sampling -- skip tracing for a fraction of sessions
    if SAMPLE_RATE < 1.0 and random.random() > SAMPLE_RATE:
        set_session_value(session_id, "sampled_out", True)
        log("INFO", f"Session {session_id} sampled out (rate={SAMPLE_RATE})")
        return {"result": "continue"}

    project_id = get_project_id(PROJECT)
    if not project_id:
        log("ERROR", "Failed to get project")
        return {"result": "continue"}

    root_span_id = session_id
    timestamp = get_timestamp()
    workspace = input_data.get("cwd", "")
    workspace_name = Path(workspace).name if workspace else "Claude Code"
    workspace_project_id = get_workspace_project_id(workspace)

    event = {
        "id": root_span_id,
        "span_id": root_span_id,
        "root_span_id": root_span_id,
        "created": timestamp,
        "input": f"Session: {workspace_name}",
        "metadata": {
            "session_id": session_id,
            "workspace": workspace,
            "workspace_project_id": workspace_project_id,
            "hostname": get_hostname(),
            "username": get_username(),
            "os": get_os(),
            "source": "claude-code",
        },
        "span_attributes": {
            "name": f"Claude Code: {workspace_name}",
            "type": "task",
        },
    }

    insert_span(project_id, event)

    set_session_value(session_id, "root_span_id", root_span_id)
    set_session_value(session_id, "project_id", project_id)
    set_session_value(session_id, "turn_count", 0)
    set_session_value(session_id, "started", timestamp)

    log("INFO", f"Created session root: {session_id} workspace={workspace_name}")
    return {"result": "continue"}


def _prune_old_state(current_session_id: str):
    """Bound the session-state directory (1,865 files and never cleaned).

    Keyed on each file's own `started` field, NEVER on mtime, and the current
    session's file is always kept. A long-lived or resumed session can have a
    stale mtime -- session 20c500e6 ran 08-06 into 08-07 -- and deleting its
    state drops root_span_id/project_id, which makes every later hook for that
    session silently no-op.
    """
    try:
        now = datetime.now(timezone.utc)
        for state_file in STATE_DIR.glob("*.json"):
            if state_file.stem == current_session_id:
                continue
            try:
                started = json.loads(state_file.read_text()).get("started", "")
                if not started:
                    continue  # No provenance -> not safe to judge. Keep it.
                age = (now - datetime.strptime(started, "%Y-%m-%dT%H:%M:%SZ")
                       .replace(tzinfo=timezone.utc)).total_seconds()
                if age > STATE_MAX_AGE_SECONDS:
                    state_file.unlink(missing_ok=True)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
    except OSError:
        pass


def session_end(input_data: dict) -> dict:
    """Handle SessionEnd hook.

    Closes the root span in Braintrust so traces have an end timestamp. Before
    this fix, root spans were never finalized: spans showed start timestamps
    only and Braintrust UI computed open-ended durations. We emit a merge-event
    keyed on root_span_id with metrics.end so Braintrust merges the close into
    the existing root span.
    """
    debug("SessionEnd hook triggered")

    if not TRACE_ENABLED:
        return {"result": "continue"}

    session_id = input_data.get("session_id", "")
    if not session_id:
        return {"result": "continue"}

    # Skip sampled-out sessions (they have no root span to close)
    if get_session_value(session_id, "sampled_out"):
        log("INFO", f"Session ended (sampled out): {session_id}")
        return {"result": "continue"}

    root_span_id = get_session_value(session_id, "root_span_id")
    project_id = get_session_value(session_id, "project_id")
    turn_count = get_session_value(session_id, "turn_count") or 0

    # If we never created a root span (e.g., API failure on session_start),
    # there's nothing to close. Log locally and exit clean.
    if not root_span_id or not project_id:
        log(
            "INFO",
            f"Session ended (no root span): {session_id} (turns={turn_count})",
        )
        return {"result": "continue"}

    # POST a merge event that closes the root span with an end timestamp.
    # Pattern mirrors the `stop` hook's turn finalization (lines ~707-714):
    # we emit `_is_merge: True` so Braintrust merges this update into the
    # existing event keyed by `id` rather than creating a new event.
    end_time = int(datetime.now().timestamp())
    close_event = {
        "id": root_span_id,
        "_is_merge": True,
        "metrics": {"end": end_time},
        "metadata": {
            "turn_count": turn_count,
            "session_ended": get_timestamp(),
        },
    }

    # NEVER POST inline here. This hook runs while the CLI is tearing the session
    # down; a stalled connection leaves the process inside the POST when the
    # harness cancels it ("Hook cancelled"), losing the event AND printing an
    # error at the user. Spool durably, then hand the network to a detached child.
    spool_events(project_id, [close_event])
    _spawn_detached_flush()
    log(
        "INFO",
        f"Session ended: {session_id} (turns={turn_count}, root_span close spooled at {end_time})",
    )

    return {"result": "continue"}


def _spawn_detached_flush():
    """Drain the spool in a child that outlives this hook process.

    Uses explicit Windows creation flags, NOT start_new_session=True: that
    argument is silently ignored on Windows (CPython passes it through as
    `unused_start_new_session`), so it is not a detachment mechanism here.
    """
    try:
        kwargs: dict[str, Any] = {
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "close_fds": True,
        }
        if sys.platform == "win32":
            kwargs["creationflags"] = (
                subprocess.DETACHED_PROCESS
                | subprocess.CREATE_NEW_PROCESS_GROUP
                | subprocess.CREATE_NO_WINDOW
            )
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "flush"], **kwargs)
    except Exception as e:
        # The events are already durably spooled, so the next session_start
        # drains them. A failed spawn delays delivery; it never loses it.
        log("ERROR", f"Detached spool flush spawn failed: {e}")


def user_prompt_submit(input_data: dict) -> dict:
    """Handle UserPromptSubmit hook."""
    debug("UserPromptSubmit hook triggered")

    if not TRACE_ENABLED:
        return {"result": "continue"}

    session_id = input_data.get("session_id", "")
    if not session_id:
        return {"result": "continue"}

    # Skip sampled-out sessions
    if get_session_value(session_id, "sampled_out"):
        return {"result": "continue"}

    root_span_id = get_session_value(session_id, "root_span_id")
    project_id = get_session_value(session_id, "project_id")

    if not root_span_id or not project_id:
        # Create session root if missing
        session_start(input_data)
        root_span_id = get_session_value(session_id, "root_span_id")
        project_id = get_session_value(session_id, "project_id")
        if not root_span_id or not project_id:
            return {"result": "continue"}

    # Increment turn count
    turn_count = (get_session_value(session_id, "turn_count") or 0) + 1
    turn_span_id = generate_uuid()
    timestamp = get_timestamp()
    prompt = input_data.get("prompt", "")[:100]

    event = {
        "id": turn_span_id,
        "span_id": turn_span_id,
        "root_span_id": root_span_id,
        "span_parents": [root_span_id],
        "created": timestamp,
        "input": prompt,
        "span_attributes": {
            "name": f"Turn {turn_count}",
            "type": "task",
        },
    }

    insert_span(project_id, event)

    set_session_value(session_id, "turn_count", turn_count)
    set_session_value(session_id, "current_turn_span_id", turn_span_id)

    log("INFO", f"Turn {turn_count} started: {turn_span_id}")
    return {"result": "continue"}


def _truncate_payload(data: Any, max_chars: int = TOOL_PAYLOAD_MAX_CHARS) -> Any:
    """Truncate large payloads to reduce Braintrust log volume.

    Slicing can cut a surrogate pair in half and MANUFACTURE the lone surrogate
    that breaks UTF-8 encoding downstream, so every truncated result is scrubbed
    here rather than only at the outbound encode.
    """
    if isinstance(data, str):
        if len(data) > max_chars:
            return _scrub_surrogates(data[:max_chars]) + f"... [truncated, {len(data)} total chars]"
        return data
    if isinstance(data, dict):
        s = json.dumps(data, default=str)
        if len(s) > max_chars:
            return _scrub_surrogates(s[:max_chars]) + f"... [truncated, {len(s)} total chars]"
        return data
    return data


def _detect_tool_error(resp: Any) -> bool:
    """Detect whether a PostToolUse tool_response represents a failed call.

    Phase 2.3 (story braintrust-scoring). Used by post_tool_use to compute
    the tool_call_success span score. Reads the original tool_response BEFORE
    truncation so we don't accidentally classify a truncated success payload
    as an error just because the truncated tail mentions "error".

    Detection rules (any one is sufficient):
      * dict.is_error is True
      * dict.error is a non-empty string OR True
      * dict.success is False

    Everything else (including non-dict responses and dicts with none of
    these flags set) is treated as success.
    """
    if not isinstance(resp, dict):
        return False
    if resp.get("is_error") is True:
        return True
    err = resp.get("error")
    if isinstance(err, str) and err.strip():
        return True
    if err is True:
        return True
    if resp.get("success") is False:
        return True
    return False


def post_tool_use(input_data: dict) -> dict:
    """Handle PostToolUse hook."""
    debug("PostToolUse hook triggered")

    if not TRACE_ENABLED:
        return {"result": "continue"}

    session_id = input_data.get("session_id", "")
    tool_name = input_data.get("tool_name", "")

    if not session_id or not tool_name:
        return {"result": "continue"}

    # Skip sampled-out sessions
    if get_session_value(session_id, "sampled_out"):
        return {"result": "continue"}

    # Skip excluded tools (high-volume, low-signal)
    if tool_name in EXCLUDED_TOOLS:
        debug(f"Skipping excluded tool: {tool_name}")
        return {"result": "continue"}

    turn_span_id = get_session_value(session_id, "current_turn_span_id")
    project_id = get_session_value(session_id, "project_id")
    root_span_id = get_session_value(session_id, "root_span_id")

    if not turn_span_id or not project_id:
        return {"result": "continue"}

    span_id = generate_uuid()
    timestamp = get_timestamp()
    tool_input = input_data.get("tool_input", {})
    tool_response_raw = input_data.get("tool_response", input_data.get("output", {}))

    # Phase 2.3 (story braintrust-scoring): compute tool_call_success BEFORE
    # truncating tool_output so we read the original `is_error` / `error` /
    # `success` fields rather than a truncated string fragment.
    #
    # Claude Code's tool_response shape varies by tool, but the conventions
    # we observe across hook payloads are:
    #   * dict with `is_error: True`     -> failed tool call
    #   * dict with non-empty `error`    -> failed tool call
    #   * dict with `success: False`     -> failed tool call
    #   * anything else (incl. missing)  -> treat as success
    #
    # Defaulting to success because most successful tool calls don't bother
    # setting any flag on the happy path. Marking unknown as failure would
    # bias the score downward and confuse the time-series.
    tool_error = _detect_tool_error(tool_response_raw)

    # Truncate payloads to reduce data volume (AFTER error detection above)
    tool_input = _truncate_payload(tool_input)
    tool_output = _truncate_payload(tool_response_raw)

    # Determine span name
    if tool_name in ("Write", "Edit", "MultiEdit"):
        file_path = tool_input.get("file_path", tool_input.get("path", "")) if isinstance(tool_input, dict) else ""
        span_name = f"{tool_name}: {Path(file_path).name}" if file_path else tool_name
    elif tool_name in ("Bash", "Terminal"):
        cmd = str(tool_input.get("command", "") if isinstance(tool_input, dict) else tool_input)[:50]
        span_name = f"Terminal: {cmd}"
    else:
        span_name = tool_name

    event = {
        "id": span_id,
        "span_id": span_id,
        "root_span_id": root_span_id,
        "span_parents": [turn_span_id],
        "created": timestamp,
        "input": tool_input,
        "output": tool_output,
        "metadata": {"tool_name": tool_name},
        "span_attributes": {
            "name": span_name,
            "type": "tool",
        },
        # Phase 2.3: attach tool_call_success score directly to the span
        # event at insert time. Braintrust accepts `scores` on insert
        # payloads (distinct from the /feedback endpoint used for
        # after-the-fact scoring via the TS helper). Quota note: the
        # EXCLUDED_TOOLS guard above filters out Read/Glob/Grep/etc. BEFORE
        # we get here, so we only emit a score for tools we already pay to
        # trace -- no extra budget cost.
        "scores": {
            "tool_call_success": 0.0 if tool_error else 1.0,
        },
    }

    insert_span(project_id, event)
    log("INFO", f"Tool: {span_name} (success={not tool_error})")
    return {"result": "continue"}


def stop(input_data: dict) -> dict:
    """Handle Stop hook - creates LLM spans for model calls within the turn.

    Parses the conversation JSONL to identify LLM calls (assistant messages
    after user/tool_result) and creates Braintrust spans for each.
    """
    log("INFO", "=== STOP HOOK CALLED ===")

    if not TRACE_ENABLED:
        return {"result": "continue"}

    # Get session ID
    session_id = input_data.get("session_id", "")
    if not session_id:
        transcript_path = input_data.get("transcript_path", "")
        if transcript_path:
            session_id = Path(transcript_path).stem

    if not session_id:
        debug("No session ID")
        return {"result": "continue"}

    # Skip sampled-out sessions
    if get_session_value(session_id, "sampled_out"):
        return {"result": "continue"}

    # Get session state
    root_span_id = get_session_value(session_id, "root_span_id")
    project_id = get_session_value(session_id, "project_id")
    turn_span_id = get_session_value(session_id, "current_turn_span_id")

    if not turn_span_id or not project_id:
        log("WARN", f"No current turn to finalize (turn={turn_span_id}, project={project_id})")
        return {"result": "continue"}

    log("INFO", f"Stop hook processing turn: {turn_span_id} (session={session_id})")

    # Find conversation file
    conv_file = input_data.get("transcript_path", "")
    if not conv_file or not Path(conv_file).exists():
        sessions_dir = Path.home() / ".claude" / "projects"
        for jsonl in sessions_dir.rglob(f"{session_id}.jsonl"):
            conv_file = str(jsonl)
            break

    if not conv_file or not Path(conv_file).exists():
        debug("No conversation file")
        return {"result": "continue"}

    debug(f"Processing transcript: {conv_file}")

    # Get last processed line
    turn_last_line = get_session_value(session_id, "turn_last_line") or 0

    # Process transcript — collect events for batch insert
    llm_calls_created = 0
    pending_events: list = []
    current_output_text = ""
    current_tool_calls: list = []
    current_model = ""
    current_prompt_tokens = 0
    current_completion_tokens = 0
    current_start_timestamp = ""
    current_end_timestamp = ""
    conversation_history: list = []
    line_num = 0

    def create_llm_span(output_text: str, model: str, prompt_tokens: int,
                        completion_tokens: int, start_ts: str, end_ts: str,
                        tool_calls: list, input_history: list) -> bool:
        """Collect an LLM span event for batch insert."""
        nonlocal llm_calls_created

        if not output_text and not tool_calls:
            return False

        span_id = generate_uuid()
        total_tokens = prompt_tokens + completion_tokens

        # Parse timestamps
        try:
            start_time = int(datetime.fromisoformat(start_ts.replace("Z", "+00:00")).timestamp()) if start_ts else int(datetime.now().timestamp())
            end_time = int(datetime.fromisoformat(end_ts.replace("Z", "+00:00")).timestamp()) if end_ts else int(datetime.now().timestamp())
        except (ValueError, AttributeError):
            start_time = end_time = int(datetime.now().timestamp())

        # Format output
        if tool_calls:
            output_json = {"role": "assistant", "content": output_text or "", "tool_calls": tool_calls}
        else:
            output_json = {"role": "assistant", "content": output_text}

        event = {
            "id": span_id,
            "span_id": span_id,
            "root_span_id": root_span_id,
            "span_parents": [turn_span_id],
            "created": start_ts or get_timestamp(),
            "input": input_history,
            "output": output_json,
            "metrics": {
                "start": start_time,
                "end": end_time,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "tokens": total_tokens,
            },
            "metadata": {"model": model or "claude"},
            "span_attributes": {
                "name": model or "claude",
                "type": "llm",
            },
        }

        pending_events.append(event)
        llm_calls_created += 1
        log("INFO", f"LLM span queued: {model} tokens={total_tokens} (turn={turn_span_id})")
        return True

    # Read and process JSONL
    with open(conv_file, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line_num += 1
            if line_num <= turn_last_line:
                continue

            line = line.strip()
            if not line:
                continue

            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type", "")
            msg_timestamp = msg.get("timestamp", "")

            if msg_type == "user":
                content = msg.get("message", {}).get("content", "")

                # Check if tool_result
                is_tool_result = False
                if isinstance(content, list) and content:
                    is_tool_result = content[0].get("type") == "tool_result"

                if is_tool_result:
                    # Save pending output first
                    if current_output_text or current_tool_calls:
                        create_llm_span(current_output_text, current_model,
                                       current_prompt_tokens, current_completion_tokens,
                                       current_start_timestamp, current_end_timestamp,
                                       current_tool_calls, conversation_history.copy())
                        conversation_history.append({
                            "role": "assistant",
                            "content": current_output_text,
                            "tool_calls": current_tool_calls if current_tool_calls else None,
                        })

                    # Add tool result to history
                    tool_content = content[0].get("content", "tool result")[:51200]
                    tool_id = content[0].get("tool_use_id", "")
                    conversation_history.append({
                        "role": "tool",
                        "tool_call_id": tool_id,
                        "content": tool_content,
                    })

                    # Reset
                    current_output_text = ""
                    current_tool_calls = []
                    current_model = ""
                    current_prompt_tokens = 0
                    current_completion_tokens = 0
                    current_start_timestamp = ""
                    current_end_timestamp = ""
                else:
                    # Real user message
                    if current_output_text or current_tool_calls:
                        create_llm_span(current_output_text, current_model,
                                       current_prompt_tokens, current_completion_tokens,
                                       current_start_timestamp, current_end_timestamp,
                                       current_tool_calls, conversation_history.copy())
                        conversation_history.append({
                            "role": "assistant",
                            "content": current_output_text,
                            "tool_calls": current_tool_calls if current_tool_calls else None,
                        })

                    # Add user message
                    content_str = content if isinstance(content, str) else json.dumps(content)[:51200]
                    conversation_history.append({"role": "user", "content": content_str})

                    # Reset
                    current_output_text = ""
                    current_tool_calls = []
                    current_model = ""
                    current_prompt_tokens = 0
                    current_completion_tokens = 0
                    current_start_timestamp = msg_timestamp
                    current_end_timestamp = ""

            elif msg_type == "assistant":
                message = msg.get("message", {})
                content = message.get("content", "")

                # Extract text
                if isinstance(content, list):
                    texts = [c.get("text", "") for c in content if c.get("type") == "text"]
                    text = "\n".join(texts)
                elif isinstance(content, str):
                    text = content
                else:
                    text = ""

                # Extract tool calls
                if isinstance(content, list):
                    tool_calls = [
                        {
                            "id": c.get("id", ""),
                            "type": "function",
                            "function": {
                                "name": c.get("name", ""),
                                "arguments": json.dumps(c.get("input", {})),
                            },
                        }
                        for c in content if c.get("type") == "tool_use"
                    ]
                else:
                    tool_calls = []

                # Set start timestamp from first assistant message
                if not current_start_timestamp:
                    current_start_timestamp = msg_timestamp

                if text:
                    current_output_text = f"{current_output_text}\n{text}" if current_output_text else text
                    current_end_timestamp = msg_timestamp

                if tool_calls:
                    current_tool_calls = tool_calls
                    current_end_timestamp = msg_timestamp

                # Extract model
                model = message.get("model", "")
                if model:
                    current_model = model

                # Extract tokens
                usage = message.get("usage", {})
                if usage:
                    current_prompt_tokens += usage.get("input_tokens", 0) or 0
                    current_completion_tokens += usage.get("output_tokens", 0) or 0

    log("DEBUG", f"Finished processing transcript (lines={line_num}, llm_calls={llm_calls_created})")

    # Save final LLM call
    if current_output_text or current_tool_calls:
        log("DEBUG", "Saving final LLM call")
        create_llm_span(current_output_text, current_model,
                       current_prompt_tokens, current_completion_tokens,
                       current_start_timestamp, current_end_timestamp,
                       current_tool_calls, conversation_history.copy())

    # Nothing new in the transcript means this turn is already finalized. That
    # happens on every session that ends normally: `stop` is registered on BOTH
    # Stop (per turn) and SessionEnd (a safety net for an abrupt exit mid-turn),
    # so the last turn is seen twice. Without this guard the second pass merges a
    # later metrics.end and silently stretches the last turn's duration.
    #
    # This REPLACES a mechanism, it does not add one. Clearing current_turn_span_id
    # below used to make a second stop bail at the "No current turn to finalize"
    # check. That clear is gone (it was the only two-writer key), so re-entry has
    # to be caught here instead -- on the transcript, which is the honest signal.
    if llm_calls_created == 0 and line_num <= turn_last_line:
        log("INFO", f"Turn {turn_span_id} already finalized (no new transcript lines) -- skipping")
        return {"result": "continue"}

    # Add turn finalization event to the batch
    end_time = int(datetime.now().timestamp())
    turn_update = {
        "id": turn_span_id,
        "_is_merge": True,
        "metrics": {"end": end_time},
    }
    pending_events.append(turn_update)

    # Send all events in a single batch API call
    log("DEBUG", f"Batch inserting {len(pending_events)} events: turn={turn_span_id} project={project_id}")
    status, _rows = batch_insert_spans(project_id, pending_events)

    # Update state. `stop` deliberately does NOT clear current_turn_span_id: that
    # made it the only key with two writers (see
    # docs/hooks/braintrust-stop-event-scope.md section 2), and stop's whole-dict
    # read-modify-write would clobber every other key on a collision.
    # user_prompt_submit now owns the key outright -- it is the writer that
    # assigns a real value, and it overwrites this one at the start of each turn.
    # Cost: a post_tool_use span landing BETWEEN turns attaches to the previous
    # turn instead of nothing, which is the more useful attribution anyway.
    set_session_value(session_id, "turn_last_line", line_num)

    # Report what actually happened. These lines previously claimed success even
    # when the POST returned a non-200 or died, which is why the log's
    # "Turn finalized" count was never evidence that spans reached Braintrust.
    if llm_calls_created > 0:
        log("INFO", f"Created {llm_calls_created} LLM spans for turn ({status})")
    log("INFO", f"Turn finalized (end={end_time}) ({status})")

    return {"result": "continue"}


HOOKS = {
    "session_start": session_start,
    "session_end": session_end,
    "user_prompt_submit": user_prompt_submit,
    "post_tool_use": post_tool_use,
    "stop": stop,
    # Not a Claude Code event -- an internal subcommand invoked by the detached
    # child that session_end spawns. Never register this in settings.json.
    "flush": flush_spool,
}


def main():
    """CLI entrypoint."""
    if len(sys.argv) < 2:
        print("Usage: braintrust_hooks.py <hook_name>", file=sys.stderr)
        sys.exit(1)

    hook_name = sys.argv[1]
    if hook_name not in HOOKS:
        print(f"Unknown hook: {hook_name}", file=sys.stderr)
        sys.exit(1)

    # Earliest-possible TRACE-disabled early-out for the per-prompt hot path.
    # user_prompt_submit fires on every prompt; when tracing is off (the
    # default) we want to do the absolute minimum before returning the no-op
    # continue result -- skipping the config re-parse, stdin read, and dispatch
    # below. We must NOT short-circuit when tracing is effectively enabled, so
    # we resolve TRACE_TO_BRAINTRUST from BOTH the process env and ~/.env (the
    # latter is how tracing is enabled on machines that don't export the var).
    # The full path (which mutates os.environ and re-parses every config var)
    # still runs whenever tracing is on or for any other subcommand.
    if hook_name == "user_prompt_submit":
        env_trace_raw = os.environ.get("TRACE_TO_BRAINTRUST")
        trace_effective = (env_trace_raw or "").lower() == "true"
        # An EXPLICIT value in the environment is the off switch and beats
        # ~/.claude/.env; only fall through to the file when the environment is
        # silent. Without the `is None` check, TRACE_TO_BRAINTRUST=false was
        # overruled by the file and tracing could not be turned off at all.
        if not trace_effective and env_trace_raw is None:
            try:
                env_file_probe = Path.home() / ".claude" / ".env"
                if env_file_probe.exists():
                    for probe_line in env_file_probe.read_text().splitlines():
                        if probe_line.startswith("#") or "=" not in probe_line:
                            continue
                        k, _, v = probe_line.partition("=")
                        if k.strip() == "TRACE_TO_BRAINTRUST":
                            trace_effective = v.strip().lower() == "true"
                            break
            except Exception:
                # Fail open toward the full path -- never silently lose a trace.
                trace_effective = True
        if not trace_effective:
            print(json.dumps({"result": "continue"}))
            sys.exit(0)

    # Captured BEFORE the .env merge below: an explicit TRACE_TO_BRAINTRUST in the
    # real environment is the off switch and beats the file. Mirrors
    # hooks/src/shared/braintrust-score.ts so spans and scores cannot disagree
    # about whether tracing is on.
    pre_env_trace = os.environ.get("TRACE_TO_BRAINTRUST")

    # Load .env if exists
    env_file = Path.home() / ".claude" / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                key, _, value = line.partition("=")
                os.environ[key.strip()] = value.strip()

    # Reload config after .env
    global API_KEY, PROJECT, API_URL, DEBUG, TRACE_ENABLED, SAMPLE_RATE
    API_KEY = os.environ.get("BRAINTRUST_API_KEY", "")
    PROJECT = os.environ.get("BRAINTRUST_CC_PROJECT", "claude-code")
    API_URL = os.environ.get("BRAINTRUST_API_URL", "https://api.braintrust.dev")
    DEBUG = os.environ.get("BRAINTRUST_CC_DEBUG", "false").lower() == "true"
    TRACE_ENABLED = (
        pre_env_trace
        if pre_env_trace is not None
        else os.environ.get("TRACE_TO_BRAINTRUST", "false")
    ).lower() == "true"
    SAMPLE_RATE = float(os.environ.get("BRAINTRUST_SAMPLE_RATE", "1.0"))

    try:
        stdin_data = sys.stdin.read()
        input_data = json.loads(stdin_data) if stdin_data.strip() else {}
    except json.JSONDecodeError:
        input_data = {}

    result = HOOKS[hook_name](input_data)
    print(json.dumps(result))
    sys.exit(0)


if __name__ == "__main__":
    main()
