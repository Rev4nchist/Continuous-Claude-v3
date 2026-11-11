#!/usr/bin/env python3
"""Incremental Memory Extraction from JSONL Transcripts.

Extracts thinking blocks with perception signals from Claude session transcripts.
Supports incremental extraction (only new lines since last run) and deduplication.

Used by:
- pre-compact-extract.ts (PreCompact hook) - extract before context compression
- session-end-extract.ts (SessionEnd hook) - final sweep with dedup

Usage:
    # Extract from line 0 (full transcript)
    uv run python scripts/core/incremental_extract.py \
        --transcript /path/to/session.jsonl \
        --session-id abc123 \
        --project-dir /path/to/project

    # Extract incrementally (from line 100)
    uv run python scripts/core/incremental_extract.py \
        --transcript /path/to/session.jsonl \
        --session-id abc123 \
        --start-line 100 \
        --state-file /path/to/extraction-state.json

Output (JSON):
    {
        "learnings_stored": 3,
        "learnings_skipped": 1,
        "new_last_line": 250,
        "hashes": ["abc123", "def456", "ghi789"]
    }
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TypedDict

try:
    from dotenv import load_dotenv
    # Load environment
    global_env = Path.home() / ".claude" / ".env"
    if global_env.exists():
        load_dotenv(global_env)
    load_dotenv()
except ImportError:
    # python-dotenv not available; rely on env vars already set in environment.
    pass

# Add parent directory to path (db.*) and this directory (sibling modules, also when
# this file is imported as core.incremental_extract)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from db.memory_redact import redact  # noqa: E402
from memory_reject_log import (  # noqa: E402
    content_hash,  # noqa: F401 - re-exported, tests and callers import it from here
    load_rejected_hashes,
    record_reject,
)

# Perception signal patterns (from lazy_memory.py)
PERCEPTION_SIGNALS = [
    # Discoveries
    r"(?i)I\s+(?:now\s+)?(?:realize|understand|see)\s+(?:that|why|how)",
    r"(?i)(?:Ah|Oh),?\s+(?:I\s+)?(?:see|got\s+it|understand)",
    r"(?i)(?:This|That)\s+(?:explains|clarifies|makes\s+sense)",
    # Pattern recognition
    r"(?i)(?:There(?:'s|\s+is)\s+a\s+pattern|I\s+notice(?:d)?)",
    r"(?i)(?:This|It)\s+(?:looks\s+like|appears\s+to\s+be|seems)",
    r"(?i)(?:The|This)\s+(?:common\s+)?(?:pattern|structure|approach)",
    # Learning moments
    r"(?i)(?:I\s+)?learn(?:ed|ing)\s+(?:that|from)",
    r"(?i)(?:Key|Important)\s+(?:insight|takeaway|learning)",
    r"(?i)(?:This|The)\s+lesson\s+(?:here\s+)?is",
    # Problem solving
    r"(?i)(?:The|Root)\s+(?:issue|problem|cause)\s+(?:is|was)",
    r"(?i)(?:This|It)\s+(?:works?|worked)\s+because",
    r"(?i)(?:The|A)\s+(?:fix|solution|answer)\s+(?:is|was)",
    # Failures/mistakes
    r"(?i)(?:I|We)\s+(?:made\s+a\s+)?mistake",
    r"(?i)(?:This|That)\s+(?:didn't|doesn't)\s+work",
    r"(?i)(?:Wrong|Bad)\s+(?:approach|assumption)",
    # Corrections
    r"(?i)(?:Actually|Wait),?\s+(?:I\s+)?(?:need\s+to|should)",
    r"(?i)(?:Let\s+me\s+)?(?:reconsider|rethink|revisit)",
    r"(?i)(?:I\s+was\s+)?(?:wrong|mistaken)\s+(?:about|when)",
]

COMPILED_PATTERNS = [re.compile(p) for p in PERCEPTION_SIGNALS]

# Error patterns for tool output extraction
ERROR_PATTERNS = [
    r"(?i)\berror\b",
    r"(?i)\bfailed\b",
    r"(?i)\bexception\b",
    r"(?i)\bfailure\b",
    r"(?i)\bcrashed?\b",
    r"(?i)\btimeout\b",
    r"(?i)Traceback\s+\(most recent",  # Python stack trace
    r"at\s+\S+\s+\(\S+:\d+:\d+\)",      # JS stack trace
    r"(?i)\bpanic:",                    # Go panic
    r"(?i)\bRuntimeError\b",
    r"(?i)\bTypeError\b",
    r"(?i)\bSyntaxError\b",
    r"(?i)\bImportError\b",
    r"(?i)\bModuleNotFoundError\b",
    r"(?i)\bConnectionRefused\b",
    r"(?i)\bENOENT\b",
    r"(?i)\bEPERM\b",
    r"(?i)\bEACCES\b",
]

COMPILED_ERROR_PATTERNS = [re.compile(p) for p in ERROR_PATTERNS]


def has_error_pattern(text: str) -> bool:
    """Check if text contains any error patterns."""
    return any(p.search(text) for p in COMPILED_ERROR_PATTERNS)


# --- Quality scoring (Python port of memory-quality-scorer.ts) ---

SIGNAL_KEYWORDS = re.compile(
    r"(error|exception|failure|bug|crash).*(fix|fixed|solved|solution|resolved|workaround)"
    r"|(fix|fixed|solved|solution|resolved|workaround).*(error|exception|failure|bug|crash)",
    re.IGNORECASE,
)
DECISION_KEYWORDS = re.compile(
    r"(chose|decided|picked|selected|went with|prefer|trade-?off)", re.IGNORECASE
)
TECH_TERMS = re.compile(
    r"(async|await|import|export|class\s|function\s|def\s|hook|middleware|"
    r"endpoint|schema|migration|component|module|pipeline|mutex|semaphore|"
    r"docker|kubernetes|postgres|redis)",
    re.IGNORECASE,
)
SPECIFIC_REFS = re.compile(r"[\w/\\]+\.\w{1,5}(?::\d+)?|`[^`]{3,}`|https?://\S+")
NOISE_REPETITION = re.compile(
    r"(extraction|checkpoint|heartbeat|periodic|session\s+\d+|"
    r"phase\s+\d+\s+complete|running|processing)",
    re.IGNORECASE,
)
NOISE_SHORT = 30    # chars
NOISE_GENERIC = re.compile(
    r"^(ok|done|yes|no|sure|thanks|got it|understood)[\.\!\s]*$", re.IGNORECASE
)


def score_extraction(content: str, context: str = "") -> dict:
    """Score an extraction candidate. Returns dict with score, classification, reasons."""
    score = 5  # base
    reasons: list[str] = []

    # --- positive signals ---
    if SIGNAL_KEYWORDS.search(content):
        score += 2
        reasons.append("+2 error-fix pair")
    if DECISION_KEYWORDS.search(content):
        score += 1
        reasons.append("+1 decision language")
    if TECH_TERMS.search(content):
        score += 1
        reasons.append("+1 technical terms")
    refs = SPECIFIC_REFS.findall(content)
    if len(refs) >= 2:
        score += 1
        reasons.append("+1 specific references")

    # --- negative signals ---
    if len(content.strip()) < NOISE_SHORT:
        score -= 3
        reasons.append("-3 too short")
    if NOISE_GENERIC.match(content.strip()):
        score -= 4
        reasons.append("-4 generic response")
    rep_count = len(NOISE_REPETITION.findall(content))
    if rep_count >= 3:
        score -= 3
        reasons.append(f"-3 repetitive ({rep_count} noise markers)")
    elif rep_count >= 1:
        score -= 1
        reasons.append(f"-1 noise marker ({rep_count})")

    score = max(0, min(10, score))
    if score >= 5:
        classification = "SIGNAL"
    elif score >= 3:
        classification = "BORDERLINE"
    else:
        classification = "NOISE"

    return {"score": score, "classification": classification, "reasons": reasons}


# --- Canonical type heuristic (Task #4, Phase 1.1) ---
# Mirrors the auto-type heuristic documented in .claude/skills/memory/SKILL.md.
# Order matters: more specific patterns match before more general ones.

_TYPE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # OPEN_THREAD checked first -- "TODO" / "next session" wins over any generic
    # noun that might also match below.
    ("OPEN_THREAD", re.compile(r"\bTODO\b|incomplete|next\s+session|to\s+do\s+later", re.IGNORECASE)),
    ("USER_PREFERENCE", re.compile(r"\bprefer\b|user\s+wants|user\s+prefers", re.IGNORECASE)),
    ("FAILED_APPROACH", re.compile(r"\bfailed\b|didn'?t\s+work|don'?t\s+do", re.IGNORECASE)),
    ("ERROR_FIX", re.compile(r"\berror\b|\bexception\b|\bfix\b|\bbug\b", re.IGNORECASE)),
    ("ARCHITECTURAL_DECISION", re.compile(r"\b(decided|chose|architecture|trade-?off|rationale)\b|^\s*decisions?\s*:", re.IGNORECASE | re.MULTILINE)),
    ("CODEBASE_PATTERN", re.compile(r"\bpattern\b|\balways\b|\bconvention\b|recurring", re.IGNORECASE)),
]


def infer_learning_type(content: str) -> str:
    """Classify content into one of the 7 canonical learning types.

    Falls back to WORKING_SOLUTION when no pattern matches (the broadest
    bucket for "a thing that worked" insights).

    Order is intentional: OPEN_THREAD beats USER_PREFERENCE beats FAILED_APPROACH
    beats ERROR_FIX beats ARCHITECTURAL_DECISION beats CODEBASE_PATTERN.
    """
    if not content:
        return "WORKING_SOLUTION"
    for learning_type, pattern in _TYPE_PATTERNS:
        if pattern.search(content):
            return learning_type
    return "WORKING_SOLUTION"


class ExtractionState(TypedDict, total=False):
    session_id: str
    last_extracted_line: int
    recent_hashes: list[str]
    last_extraction_time: str


class ExtractionResult(TypedDict):
    learnings_stored: int
    learnings_skipped: int
    learnings_deduped: int
    learnings_rejected_before: int
    new_last_line: int
    hashes: list[str]
    errors: list[str]


def has_perception_signal(text: str) -> bool:
    """Check if text contains any perception signal patterns."""
    return any(p.search(text) for p in COMPILED_PATTERNS)


def extract_thinking_blocks(line_data: dict) -> list[str]:
    """Extract thinking blocks from a JSONL line.

    Thinking blocks appear in assistant messages with content type 'thinking'.
    """
    thinking_blocks = []

    # Check for assistant message with content array
    if line_data.get("type") == "assistant":
        content = line_data.get("message", {}).get("content", [])
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "thinking":
                    thinking_text = block.get("thinking", "")
                    if thinking_text and has_perception_signal(thinking_text):
                        thinking_blocks.append(thinking_text)

    return thinking_blocks


def extract_tool_errors(line_data: dict) -> list[dict]:
    """Extract errors from tool outputs in a JSONL line.

    Tool outputs appear in assistant messages with tool_use content blocks,
    followed by tool_result blocks in subsequent lines.

    Returns list of dicts with 'tool_name', 'error_context', and 'input_summary'.
    """
    errors = []

    # Check for tool_result in assistant message
    if line_data.get("type") == "assistant":
        content = line_data.get("message", {}).get("content", [])
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    result_content = block.get("content", "")
                    if isinstance(result_content, str) and has_error_pattern(result_content):
                        # Extract error context (first 500 chars around error)
                        error_context = _extract_error_context(result_content)
                        if error_context:
                            errors.append({
                                "tool_name": block.get("tool_use_id", "unknown"),
                                "error_context": error_context,
                                "input_summary": "",  # We don't have input here
                            })

    # Also check for tool errors in tool_use responses
    if line_data.get("type") == "tool_result":
        content = line_data.get("content", "")
        tool_name = line_data.get("tool_use_id", "unknown")
        if isinstance(content, str) and has_error_pattern(content):
            error_context = _extract_error_context(content)
            if error_context:
                errors.append({
                    "tool_name": tool_name,
                    "error_context": error_context,
                    "input_summary": "",
                })

    return errors


def _extract_error_context(text: str, max_len: int = 500) -> str:
    """Extract the most relevant error portion from text."""
    lines = text.split("\n")

    # Look for lines with error patterns
    for i, line in enumerate(lines):
        if any(p.search(line) for p in COMPILED_ERROR_PATTERNS):
            # Include context: 2 lines before and 3 lines after
            start = max(0, i - 2)
            end = min(len(lines), i + 4)
            context = "\n".join(lines[start:end])
            return context[:max_len]

    # If no specific error found, return beginning
    return text[:max_len] if text else ""


# State file shape (B9, version 2), shared with .claude/hooks/src/shared/extraction-state.ts:
#   {"version": 2, "recent_hashes": [...],
#    "sessions": {"<session id>": {"last_extracted_line", "last_launched", "last_extraction_time"}}}
# A line index only means something inside ONE transcript, so it is kept per session.
# The old flat shape ({"session_id", "last_extracted_line", ...}) still loads: it maps to the
# one session it names. A flat file with no session id maps to no session.
_STATE_VERSION = 2
_STATE_MAX_SESSIONS = 50
_STATE_MAX_HASHES = 100
_LOCK_STALE_S = 10.0
_LOCK_TIMEOUT_S = 5.0


def _empty_raw_state() -> dict:
    return {"version": _STATE_VERSION, "recent_hashes": [], "sessions": {}}


def _read_raw_state(state_file: str | None) -> dict:
    """Read the state file (either shape) as {"recent_hashes": [...], "sessions": {...}}.

    Never raises: a missing, empty or corrupt file reads as empty state.
    """
    raw = _empty_raw_state()
    if not state_file:
        return raw
    try:
        with open(state_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return raw
    if not isinstance(data, dict):
        return raw

    hashes = data.get("recent_hashes")
    if isinstance(hashes, list):
        raw["recent_hashes"] = [h for h in hashes if isinstance(h, str)]

    sessions = data.get("sessions")
    if isinstance(sessions, dict):
        raw["sessions"] = {k: v for k, v in sessions.items() if isinstance(v, dict)}
    elif isinstance(data.get("session_id"), str) and data["session_id"]:
        raw["sessions"] = {data["session_id"]: {
            k: data[k]
            for k in ("last_extracted_line", "last_launched", "last_extraction_time")
            if k in data
        }}
    return raw


def load_state(state_file: str | None, session_id: str | None = None) -> ExtractionState:
    """Load the extraction state of ONE session. Hashes are shared across sessions."""
    raw = _read_raw_state(state_file)
    entry = raw["sessions"].get(session_id or "", {})
    line = entry.get("last_extracted_line", 0)
    return ExtractionState(
        session_id=session_id or "",
        last_extracted_line=line if isinstance(line, int) and line >= 0 else 0,
        recent_hashes=raw["recent_hashes"],
        last_extraction_time=str(entry.get("last_extraction_time", "")),
    )


def _acquire_lock(lock_file: str) -> bool:
    """Take the same O_EXCL lock file as shared/atomic-write.ts (state_file + '.lock')."""
    import time

    start = time.monotonic()
    while True:
        try:
            fd = os.open(lock_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                if time.time() - os.stat(lock_file).st_mtime > _LOCK_STALE_S:
                    os.unlink(lock_file)
                    continue
            except FileNotFoundError:
                continue  # the lock vanished: take it now
            except OSError:
                pass  # cannot delete it (held handle): fall through to the timeout and sleep
            if time.monotonic() - start > _LOCK_TIMEOUT_S:
                return False
            time.sleep(0.05)
        except OSError:
            return False
        else:
            try:
                os.write(fd, f"{os.getpid()}\n{int(time.time() * 1000)}".encode())
            finally:
                os.close(fd)
            return True


def save_state(state_file: str, state: ExtractionState) -> None:
    """Save one session's progress into the state file.

    Read-modify-write under the shared lock: only this session's entry and the shared
    hashes change, so other sessions and `last_launched` survive. The write goes to a
    temp file, then os.replace, so a reader never sees an empty or half-written file.
    """
    state_dir = os.path.dirname(state_file) or "."
    os.makedirs(state_dir, exist_ok=True)
    lock_file = state_file + ".lock"
    locked = _acquire_lock(lock_file)  # fail open: write anyway, as the TS side does
    tmp_file = os.path.join(state_dir, f".{os.path.basename(state_file)}.tmp.{os.getpid()}")
    try:
        raw = _read_raw_state(state_file)
        # Merge, never replace: another session may have saved hashes since this run loaded.
        on_disk = raw["recent_hashes"]
        known = set(on_disk)
        merged = on_disk + [h for h in state.get("recent_hashes", []) if h not in known]
        raw["recent_hashes"] = merged[-_STATE_MAX_HASHES:]
        session_id = state.get("session_id", "")
        if session_id:
            entry = dict(raw["sessions"].get(session_id, {}))
            entry["last_extracted_line"] = state.get("last_extracted_line", 0)
            entry["last_extraction_time"] = state.get("last_extraction_time", "")
            raw["sessions"][session_id] = entry
        if len(raw["sessions"]) > _STATE_MAX_SESSIONS:
            def recency(item: tuple[str, dict]) -> str:
                return str(item[1].get("last_extraction_time", ""))
            newest = sorted(raw["sessions"].items(), key=recency, reverse=True)
            keep = dict(newest[:_STATE_MAX_SESSIONS])
            if session_id in raw["sessions"]:
                keep[session_id] = raw["sessions"][session_id]
            raw["sessions"] = keep
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(raw, f, indent=2)
        os.replace(tmp_file, state_file)
    finally:
        if os.path.exists(tmp_file):
            try:
                os.unlink(tmp_file)
            except OSError:
                pass
        if locked:
            try:
                os.unlink(lock_file)
            except OSError:
                pass


_UNSAFE_DISTILL_REASONS = frozenset({"distill:injected", "distill:secret"})


@dataclass
class _Candidate:
    """One extraction candidate. ``text`` is already redacted; ``raw_hash`` is the hash
    of the RAW text (the reject log and the dedup state key on it)."""

    text: str
    raw_hash: str
    line: int
    kind: str  # thinking_block | tool_error
    error_info: dict | None = None

    @property
    def evidence(self) -> dict:
        return {"kind": self.kind, "line": self.line, "hash": self.raw_hash}


@dataclass
class _StoreItem:
    content: str
    candidate: _Candidate
    context: str | None = None
    extra_tags: list[str] | None = None
    source: str = "hook"
    is_inference: bool = True


async def store_thinking_learning(
    content: str,
    session_id: str,
    project_dir: str | None,
    context: str | None = None,
    extra_tags: list[str] | None = None,
    source: str = "hook",
    is_inference: bool = True,
    candidate_hash: str | None = None,
    evidence: dict | None = None,
) -> dict:
    """Store a thinking block (or its distilled lesson) as a learning.

    Provenance: a verbatim thinking block is source "hook" (mechanical extraction of
    model reasoning); a distilled lesson is source "llm" (the model wrote it). Both are
    inferences, because reasoning is not an observed fact.
    """
    try:
        from store_learning import store_learning_v2
    except ImportError:
        # Try relative import
        sys.path.insert(0, os.path.dirname(__file__))
        from store_learning import store_learning_v2

    # Determine learning type via canonical auto-type heuristic
    # (Phase 1.1 / Task #4 -- aligns with .claude/skills/memory/SKILL.md)
    learning_type = infer_learning_type(content)

    # Extract tags from content (simple keyword extraction)
    content_lower = content.lower()
    tags = ["auto_extracted", "thinking_block"]
    if extra_tags:
        tags.extend(extra_tags)
    keywords = ["hook", "test", "build", "api", "database", "ui", "config"]
    for kw in keywords:
        if kw in content_lower:
            tags.append(kw)

    # Capture CLAUDE_AGENT_ID env var for agent attribution (Task #14).
    # Tagged into metadata as a carrier so Task #6 (store_learning.py owner)
    # can wire it through to the archival_memory.agent_id column.
    agent_id = os.environ.get("CLAUDE_AGENT_ID")
    if agent_id:
        tags.append(f"agent:{agent_id}")

    result = await store_learning_v2(
        session_id=session_id,
        content=content[:2000],  # Limit size
        learning_type=learning_type,
        context=context or "extracted from thinking block",
        tags=tags,
        confidence="medium",
        project_dir=project_dir,
        source=source,
        is_inference=is_inference,
        candidate_hash=candidate_hash,
        evidence=evidence,
    )

    return result


async def store_tool_error_learning(
    error_info: dict,
    session_id: str,
    project_dir: str | None,
    candidate_hash: str | None = None,
    evidence: dict | None = None,
) -> dict:
    """Store a tool error as an ERROR_FIX learning (source hook, not an inference)."""
    try:
        from store_learning import store_learning_v2
    except ImportError:
        sys.path.insert(0, os.path.dirname(__file__))
        from store_learning import store_learning_v2

    tool_name = error_info.get("tool_name", "unknown")
    error_context = error_info.get("error_context", "")

    content = f"Tool '{tool_name}' failed with error: {error_context}"

    tags = [
        "auto_extracted",
        "tool_error",
        f"tool:{tool_name}",
        "scope:global",
    ]

    # Capture CLAUDE_AGENT_ID env var for agent attribution (Task #14).
    agent_id = os.environ.get("CLAUDE_AGENT_ID")
    if agent_id:
        tags.append(f"agent:{agent_id}")

    # ERROR_FIX is a closer canonical type than FAILED_APPROACH for tool errors
    # that we are about to surface for future-self diagnosis. Tool errors are
    # the most common ERROR_FIX trigger in the heuristic. (Task #4)
    result = await store_learning_v2(
        session_id=session_id,
        content=content[:2000],
        learning_type="ERROR_FIX",
        context="extracted from tool error output",
        tags=tags,
        confidence="medium",
        project_dir=project_dir,
        source="hook",
        is_inference=False,
        candidate_hash=candidate_hash,
        evidence=evidence,
    )

    return result


_CONNECTION_EXCEPTIONS = (ConnectionError, OSError, asyncio.TimeoutError)
_CONNECTION_MARKERS = (
    "connection", "connect call failed", "refused", "timeout", "timed out",
    "could not connect", "network", "name or service not known", "getaddrinfo",
    "too many clients", "the database system is starting up", "pool",
)
# Permanent errors: a retry cannot fix them (an ImportError stays an ImportError).
_PERMANENT_MARKERS = ("no content provided", "source is required", "memory service not available")


def _is_connection_error(error: object) -> bool:
    """True when a store error looks like a database or network outage, so a retry can work."""
    text = str(error).lower()
    if any(marker in text for marker in _PERMANENT_MARKERS):
        return False
    return any(marker in text for marker in _CONNECTION_MARKERS)


def _hold_back_lost_stores(
    held_back: list[_Candidate], new_hashes: list[str], result: ExtractionResult
) -> None:
    """Keep learnings the store lost on a connection error for the next run.

    Drops their hashes (a saved hash would make the retry look like a duplicate) and
    moves the pointer back to the earliest of them. Stored candidates keep their hashes,
    so the re-read dedupes them.
    """
    if not held_back:
        return
    lost = {c.raw_hash for c in held_back}
    new_hashes[:] = [h for h in new_hashes if h not in lost]
    line = min(c.line for c in held_back)
    result["new_last_line"] = line
    result["errors"].append(
        f"store failed on connection error, held back at line {line} ({len(held_back)} candidates)"
    )


async def extract_incremental(
    transcript_path: str,
    session_id: str,
    start_line: int = 0,
    state_file: str | None = None,
    project_dir: str | None = None,
    max_learnings: int = 10,
) -> ExtractionResult:
    """Extract learnings from JSONL transcript incrementally.

    Every candidate is redacted as soon as it is collected, so nothing downstream
    (quality gate, distiller, embedder, store) sees a secret. The raw hash is taken
    first. A candidate any gate rejects goes into the reject log by that hash, and the
    next run skips it.

    Args:
        transcript_path: Path to session JSONL file
        session_id: Session identifier
        start_line: Line to start extraction from (0-indexed)
        state_file: Path to state file for tracking progress
        project_dir: Project directory for scoping
        max_learnings: Maximum learnings to extract per run

    Returns:
        ExtractionResult with counts and new state
    """
    result = ExtractionResult(
        learnings_stored=0,
        learnings_skipped=0,
        learnings_deduped=0,
        learnings_rejected_before=0,
        new_last_line=start_line,
        hashes=[],
        errors=[]
    )

    if not os.path.exists(transcript_path):
        result["errors"].append(f"Transcript not found: {transcript_path}")
        return result

    # Load existing state for dedup hashes
    state = load_state(state_file, session_id)
    existing_hashes = set(state.get("recent_hashes", []))
    rejected_hashes = load_rejected_hashes()

    # Read and process transcript
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except IOError as e:
        result["errors"].append(f"Failed to read transcript: {e}")
        return result

    # Process lines from start_line
    new_hashes: list[str] = []
    thinking_cands: list[_Candidate] = []
    error_cands: list[_Candidate] = []

    def _skip_known(h: str) -> bool:
        if h in existing_hashes or h in new_hashes:
            result["learnings_deduped"] += 1
            return True
        if h in rejected_hashes:
            result["learnings_rejected_before"] += 1
            return True
        return False

    for line_num, line in enumerate(lines[start_line:], start=start_line):
        if len(thinking_cands) + len(error_cands) >= max_learnings:
            break

        result["new_last_line"] = line_num + 1

        if not line.strip():
            continue

        try:
            line_data = json.loads(line)
        except json.JSONDecodeError:
            continue

        # Extract thinking blocks (existing logic)
        for thinking in extract_thinking_blocks(line_data):
            h = content_hash(thinking)  # hash the RAW text first
            if _skip_known(h):
                continue
            new_hashes.append(h)
            thinking_cands.append(_Candidate(redact(thinking).text, h, line_num, "thinking_block"))

        # Extract tool errors (new logic)
        for error_info in extract_tool_errors(line_data):
            raw_ctx = error_info.get("error_context", "")
            h = content_hash(raw_ctx)
            if _skip_known(h):
                continue
            new_hashes.append(h)
            safe_info = {
                **error_info,
                "error_context": redact(raw_ctx).text,
                "tool_name": redact(str(error_info.get("tool_name", "unknown"))).text,
            }
            error_cands.append(
                _Candidate(safe_info["error_context"], h, line_num, "tool_error", safe_info)
            )

    # Quality gate (gate B): filter NOISE before storing
    def _passes_gate_b(cand: _Candidate, label: str) -> bool:
        qr = score_extraction(cand.text)
        if qr["classification"] != "NOISE":
            return True
        record_reject(
            cand.raw_hash, "gate_b_noise", f"NOISE score={qr['score']}", "hook", session_id
        )
        print(f"  [QUALITY] {label} (score={qr['score']}): {cand.text[:60]}...", file=sys.stderr)
        return False

    kept_thinking = [c for c in thinking_cands if _passes_gate_b(c, "NOISE")]
    kept_errors = [c for c in error_cands if _passes_gate_b(c, "NOISE error")]
    result["learnings_skipped"] += (len(thinking_cands) - len(kept_thinking)) + (
        len(error_cands) - len(kept_errors)
    )
    thinking_cands = kept_thinking
    error_cands = kept_errors

    # --- LLM distillation before store (proposal 07-09 R2, 2026-07-24) ---
    # One batched headless `claude -p` call turns raw thinking blocks into
    # crisp lessons. Candidates are already redacted, so no secret reaches the
    # model (distill() re-checks as a second line of defense). Any distiller
    # failure falls back to verbatim for ALL candidates -- extraction is never
    # lost to a broken distiller. Kill switch: CCV3_DISTILL=0. The distiller
    # child carries CCV3_DISTILL_CHILD=1 so extraction hooks can never cascade.
    store_items: list[_StoreItem] = []
    distill_enabled = os.environ.get("CCV3_DISTILL", "1") != "0"
    if distill_enabled and thinking_cands:
        try:
            from distill_learning import distill, looks_injected
        except ImportError:
            sys.path.insert(0, os.path.dirname(__file__))
            from distill_learning import distill, looks_injected

        distill_rejects: list[dict] = []
        distilled = distill([c.text for c in thinking_cands], rejects=distill_rejects)
        if distilled is None:
            # Distiller failure -> verbatim fallback, nothing lost.
            store_items.extend(_StoreItem(c.text, c) for c in thinking_cands)
        else:
            by_index = {d["index"]: d for d in distilled}
            # Only unsafe model output (injected, secret) drops the candidate for good.
            # A formatting glitch (bad action, empty lesson) falls back to verbatim, so
            # one bad model reply never costs a candidate in every later run.
            bad_index = {
                r["index"]: r["reason"]
                for r in distill_rejects
                if r.get("index") is not None and r.get("reason") in _UNSAFE_DISTILL_REASONS
            }
            for i, cand in enumerate(thinking_cands):
                d = by_index.get(i)
                if d is None and i in bad_index:
                    # The model's item for this candidate failed the output schema.
                    record_reject(cand.raw_hash, "distill_schema", bad_index[i], "llm", session_id)
                    result["learnings_skipped"] += 1
                    continue
                if d is None:
                    # Model omitted this candidate -> verbatim fallback.
                    store_items.append(_StoreItem(cand.text, cand))
                    continue
                if d["action"] == "skip":
                    record_reject(cand.raw_hash, "distill_skip", "model_skip", "llm", session_id)
                    result["learnings_skipped"] += 1
                    continue
                lesson = f"{d['lesson']}"
                if d["why"]:
                    lesson += f"\nWhy: {d['why']}"
                if d["how_to_apply"]:
                    lesson += f"\nApply: {d['how_to_apply']}"
                # Post-distillation gates: NOISE re-score + injection shape
                # (memory-injection defense -- distilled text becomes trusted
                # context in future sessions).
                if looks_injected(lesson):
                    reason = "injected"
                elif score_extraction(lesson)["classification"] == "NOISE":
                    reason = "NOISE"
                else:
                    reason = ""
                if reason:
                    record_reject(cand.raw_hash, "post_distill", reason, "llm", session_id)
                    result["learnings_skipped"] += 1
                    continue
                # Verbatim companion (ablations favor keeping the source):
                # carried in context, truncated, for traceability.
                ctx = f"distilled from thinking block; verbatim excerpt: {cand.text[:400]}"
                store_items.append(_StoreItem(lesson, cand, ctx, ["distilled"], "llm", True))
    else:
        store_items.extend(_StoreItem(c.text, c) for c in thinking_cands)

    held_back: list[_Candidate] = []

    async def _tally(coro, cand: _Candidate) -> None:
        try:
            store_result = await coro
            if store_result.get("success"):
                if store_result.get("skipped"):
                    result["learnings_skipped"] += 1
                else:
                    result["learnings_stored"] += 1
            else:
                error = store_result.get("error", "Unknown error")
                result["errors"].append(error)
                if store_result.get("retryable") or _is_connection_error(error):
                    held_back.append(cand)
        except Exception as e:
            result["errors"].append(str(e))
            if isinstance(e, _CONNECTION_EXCEPTIONS) or _is_connection_error(e):
                held_back.append(cand)

    # Store thinking learnings (distilled or verbatim)
    for item in store_items:
        await _tally(
            store_thinking_learning(
                content=item.content,
                session_id=session_id,
                project_dir=project_dir,
                context=item.context,
                extra_tags=item.extra_tags,
                source=item.source,
                is_inference=item.is_inference,
                candidate_hash=item.candidate.raw_hash,
                evidence=item.candidate.evidence,
            ),
            item.candidate,
        )

    # Store tool error learnings
    for cand in error_cands:
        await _tally(
            store_tool_error_learning(
                error_info=cand.error_info or {},
                session_id=session_id,
                project_dir=project_dir,
                candidate_hash=cand.raw_hash,
                evidence=cand.evidence,
            ),
            cand,
        )

    _hold_back_lost_stores(held_back, new_hashes, result)
    result["hashes"] = new_hashes

    # Update and save state if state_file provided
    if state_file:
        # Keep last 100 hashes to prevent unbounded growth
        all_hashes = list(existing_hashes) + new_hashes
        recent_hashes = all_hashes[-100:] if len(all_hashes) > 100 else all_hashes

        new_state = ExtractionState(
            session_id=session_id,
            last_extracted_line=result["new_last_line"],
            recent_hashes=recent_hashes,
            last_extraction_time=datetime.now(timezone.utc).isoformat()
        )
        save_state(state_file, new_state)

    return result


async def main():
    parser = argparse.ArgumentParser(description="Incremental memory extraction from JSONL")
    parser.add_argument("--transcript", required=True, help="Path to session JSONL file")
    parser.add_argument("--session-id", required=True, help="Session identifier")
    parser.add_argument("--start-line", type=int, default=0, help="Line to start from (0-indexed)")
    parser.add_argument("--state-file", help="Path to state file for tracking")
    parser.add_argument("--project-dir", help="Project directory")
    parser.add_argument("--max-learnings", type=int, default=20, help="Max learnings per run (keep <=50 to avoid memory issues)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    result = await extract_incremental(
        transcript_path=args.transcript,
        session_id=args.session_id,
        start_line=args.start_line,
        state_file=args.state_file,
        project_dir=args.project_dir,
        max_learnings=args.max_learnings,
    )

    if args.json:
        print(json.dumps(result))
    else:
        print(f"Extraction complete:")
        print(f"  Stored: {result['learnings_stored']}")
        print(f"  Skipped (semantic dedup): {result['learnings_skipped']}")
        print(f"  Skipped (hash dedup): {result['learnings_deduped']}")
        print(f"  New last line: {result['new_last_line']}")
        if result["errors"]:
            print(f"  Errors: {len(result['errors'])}")
            for err in result["errors"][:3]:
                print(f"    - {err}")


if __name__ == "__main__":
    asyncio.run(main())
