#!/usr/bin/env python3
"""Store session learnings in PostgreSQL with pgvector embeddings.

Claude-native learning storage - called by stop-learnings hook or memory extractor.
Stores learnings in memory for semantic recall in future sessions.

Usage (legacy):
    uv run python opc/scripts/store_learning.py \
        --session-id "abc123" \
        --worked "Approach X worked well" \
        --failed "Y didn't work" \
        --decisions "Chose Z because..." \
        --patterns "Reusable technique..."

Usage (v2 - direct content):
    uv run python opc/scripts/store_learning.py \
        --session-id "abc123" \
        --type "WORKING_SOLUTION" \
        --context "hook development" \
        --tags "hooks,patterns" \
        --confidence "high" \
        --content "Pattern X works well for Y"

Learning Types:
    FAILED_APPROACH: Things that didn't work
    WORKING_SOLUTION: Successful approaches
    USER_PREFERENCE: User style/preferences
    CODEBASE_PATTERN: Discovered code patterns
    ARCHITECTURAL_DECISION: Design choices made
    ERROR_FIX: Error->solution pairs
    OPEN_THREAD: Unfinished work/TODOs

Environment:
    DATABASE_URL: PostgreSQL connection string
    VOYAGE_API_KEY: For embeddings (optional, falls back to local)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

# Load global ~/.claude/.env first, then local .env
global_env = Path.home() / ".claude" / ".env"
if global_env.exists():
    load_dotenv(global_env)
load_dotenv()

# Add parent directory to path (for imports like 'from db.memory_factory')
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from db.memory_provenance import SENTINEL_CLI, SENTINEL_UNKNOWN, SOURCES  # noqa: E402
from db.memory_redact import redact, redact_obj  # noqa: E402
from memory_candidate import LEARNING_TYPES, clip_fields, validate_candidate  # noqa: E402
from memory_reject_log import content_hash, record_reject  # noqa: E402
from memory_write_log import record_write_failure  # noqa: E402

# Valid confidence levels
CONFIDENCE_LEVELS = ["high", "medium", "low"]

# Deduplication threshold (0.85 = 85% similar)
DEDUP_THRESHOLD = 0.85

# Keywords that indicate GLOBAL scope (cross-project learnings)
GLOBAL_KEYWORDS = {
    "windows", "linux", "macos", "darwin", "posix", "platform",
    "wsl", "mingw", "cygwin", "powershell", "cmd.exe",
    "hooks", "hook", "skill", "skills", "mcp", "claude code",
    "subagent", "agent", "spawn", "memory", "embedding",
    "python", "typescript", "javascript", "rust", "go",
    "async", "await", "promise", "generator", "decorator",
    "git", "npm", "pip", "docker", "kubernetes", "postgres", "redis",
    "segfault", "stack overflow", "memory leak", "race condition",
}

# Keywords that indicate PROJECT scope (project-specific)
PROJECT_KEYWORDS = {
    "src/", "lib/", "app/", "components/", "pages/", "routes/",
    "test/", "tests/", "spec/", "__tests__/",
    "package.json", "tsconfig", "pyproject.toml", "cargo.toml",
}

# Singleton embedding service (prevents 1.5GB model reload per learning)
_embedder = None


def get_embedder():
    """Get or create singleton EmbeddingService instance.

    The BGE embedding model is ~1.5GB. Creating a new instance per learning
    causes OOM after ~10 learnings. This singleton ensures the model is
    loaded once and reused.
    """
    global _embedder
    if _embedder is None:
        from db.embedding_service import EmbeddingService
        _embedder = EmbeddingService(provider="local")
    return _embedder


def get_project_id(project_dir: str | None) -> str | None:
    """Generate stable project ID from absolute path."""
    if not project_dir or not project_dir.strip():
        return None
    import hashlib
    abs_path = str(Path(project_dir).resolve())
    if not abs_path or abs_path == ".":
        return None
    return hashlib.sha256(abs_path.encode()).hexdigest()[:16]


def classify_scope(
    content: str,
    tags: list[str] | None = None,
    context: str | None = None,
) -> str:
    """Classify learning as PROJECT or GLOBAL scope.

    GLOBAL: Cross-project patterns (Windows issues, hooks, language patterns)
    PROJECT: Project-specific code, paths, architecture
    """
    combined = content.lower()
    if context:
        combined += " " + context.lower()
    if tags:
        combined += " " + " ".join(tags).lower()

    global_score = sum(1 for kw in GLOBAL_KEYWORDS if kw in combined)
    project_score = sum(1 for kw in PROJECT_KEYWORDS if kw in combined)

    if global_score > project_score and global_score >= 2:
        return "GLOBAL"
    return "PROJECT"


# --- Quality gate: reject noise before expensive embedding ---

# Minimum content length by type (chars)
MIN_CONTENT_LENGTH = {
    "FAILED_APPROACH": 100,
    "WORKING_SOLUTION": 50,
    "ERROR_FIX": 50,
    "USER_PREFERENCE": 20,
    "CODEBASE_PATTERN": 50,
    "ARCHITECTURAL_DECISION": 50,
    "OPEN_THREAD": 30,
    None: 80,  # untyped default
}

# Noise patterns -- content starting with these is ephemeral thinking, not a learning.
# G14 (Task #15): these prefixes leaked through previously; we now reject them
# BEFORE the min-length check so a short-but-noisy fragment still gets rejected
# with a clear noise_prefix reason (helps debugging / observability).
NOISE_PREFIXES = [
    "Agent '",           # agent failure dumps
    "Now I have",        # thinking fragment
    "Let me ",           # planning fragment
    "The user wants",    # intent narration
    "I need to",         # planning fragment
    "Looking at",        # observation, not insight
    "I notice the",      # observation without conclusion
    "The user sent",     # message narration
]

# Quality signals -- content containing these is more likely a real learning
QUALITY_SIGNALS = [
    "because",
    "fix:",
    "solution:",
    "pattern:",
    "the root cause",
    "works because",
    "didn't work because",
    "always ",
    "never ",
    "must ",
    "requires ",
    "workaround:",
]


def validate_learning_quality(
    content: str,
    learning_type: str | None = None,
    _internal_caller: bool = False,
    session_id: str | None = None,
) -> dict:
    """Gate: reject noise, accept quality learnings.

    Order matters here. Noise-prefix rejection runs BEFORE the length check
    so a short-but-noisy fragment ("Let me think") gets a clear
    ``noise_prefix`` reason rather than a misleading ``too_short`` one.

    Args:
        content: The candidate learning content.
        learning_type: One of LEARNING_TYPES, or None. When None and the
            caller is external (``_internal_caller=False``), the gate
            rejects -- callers must declare a type so the canonical
            7-type heuristic can apply.
        _internal_caller: Sentinel set by trusted in-process callers (e.g.,
            ``store_learning_v2`` when it has already inferred a type, or
            the legacy v1 entrypoint). External CLI / hook callers MUST
            leave this False so the NULL-type guard fires.
        session_id: Optional session identifier. Kept for caller
            compatibility. Not used in gate logic. Defaults to None.

    Returns:
        {"passes": True} or {"passes": False, "reason": "..."}
    """
    stripped = content.strip()
    content_len = len(stripped)

    # 1. Reject noise prefixes FIRST (Task #15 / G14).
    # Even a short fragment like "Let me think" is rejected with a clear
    # noise_prefix reason rather than too_short.
    for prefix in NOISE_PREFIXES:
        if stripped.startswith(prefix):
            reason = f"noise_prefix: {prefix}"
            return {"passes": False, "reason": reason}

    # 2. Reject NULL learning_type for external callers (G14 follow-up).
    # Forces callers to either pass --type or rely on store_learning_v2's
    # inferred type (which sets _internal_caller=True before re-validating).
    if learning_type is None and not _internal_caller:
        reason = "missing_type (external caller must provide learning_type)"
        return {"passes": False, "reason": reason}

    # 3. Minimum length by type.
    min_len = MIN_CONTENT_LENGTH.get(learning_type, MIN_CONTENT_LENGTH[None])
    if len(stripped) < min_len:
        reason = f"too_short ({len(stripped)}<{min_len})"
        return {"passes": False, "reason": reason}

    # 4. Reject if high newline ratio (code/log dumps)
    newline_ratio = stripped.count("\n") / max(len(stripped), 1)
    if newline_ratio > 0.15 and len(stripped) > 500:
        reason = "high_newline_ratio (likely code dump)"
        return {"passes": False, "reason": reason}

    # 4b. Reject verbatim repetition (e.g., "this is important data. " × N).
    # Only applies to longer content (>=200 chars) -- short content legitimately
    # reuses words (e.g., "always use X, never use Y"). Threshold 0.25 is
    # conservative: normal prose sits at 0.40-0.60, code snippets 0.30-0.45.
    if len(stripped) >= 200:
        words = stripped.split()
        if words:
            uniqueness_ratio = len(set(w.lower() for w in words)) / len(words)
            if uniqueness_ratio < 0.25:
                reason = "repetition"
                return {
                    "passes": False,
                    "reason": reason,
                    "detail": f"uniqueness_ratio={uniqueness_ratio:.2f} (threshold 0.25)",
                }

    # 5. Boost: if content has quality signals, always pass
    content_lower = stripped.lower()
    signal_count = sum(1 for s in QUALITY_SIGNALS if s in content_lower)
    if signal_count >= 2:
        return {"passes": True, "boost": True, "signals": signal_count}

    # 6. Default: pass (don't over-filter)
    return {"passes": True}


# --- Canonical type heuristic (Task #6 + #15 -- mirrors incremental_extract.py) ---
# Same patterns and order as incremental_extract.infer_learning_type so the
# canonical 7-type taxonomy is consistent across extraction paths and the
# manual store CLI. If you change one, change both.
import re as _re

_TYPE_PATTERNS: list[tuple[str, "_re.Pattern[str]"]] = [
    # OPEN_THREAD first -- "TODO" / "next session" beats any generic noun match below.
    ("OPEN_THREAD", _re.compile(r"\bTODO\b|incomplete|next\s+session|to\s+do\s+later", _re.IGNORECASE)),
    ("USER_PREFERENCE", _re.compile(r"\bprefer\b|user\s+wants|user\s+prefers", _re.IGNORECASE)),
    ("FAILED_APPROACH", _re.compile(r"\bfailed\b|didn'?t\s+work|don'?t\s+do", _re.IGNORECASE)),
    ("ERROR_FIX", _re.compile(r"\berror\b|\bexception\b|\bfix\b|\bbug\b", _re.IGNORECASE)),
    ("ARCHITECTURAL_DECISION", _re.compile(r"\b(decided|chose|architecture|trade-?off|rationale)\b|^\s*decisions?\s*:", _re.IGNORECASE | _re.MULTILINE)),
    ("CODEBASE_PATTERN", _re.compile(r"\bpattern\b|\balways\b|\bconvention\b|recurring", _re.IGNORECASE)),
]


def _infer_learning_type(content: str) -> str:
    """Classify content into one of the 7 canonical learning types.

    Mirrors ``incremental_extract.infer_learning_type``. Falls back to
    ``WORKING_SOLUTION`` when no pattern matches (broadest bucket).

    Order is intentional: OPEN_THREAD > USER_PREFERENCE > FAILED_APPROACH
    > ERROR_FIX > ARCHITECTURAL_DECISION > CODEBASE_PATTERN > WORKING_SOLUTION.
    """
    if not content:
        return "WORKING_SOLUTION"
    for learning_type, pattern in _TYPE_PATTERNS:
        if pattern.search(content):
            return learning_type
    return "WORKING_SOLUTION"


async def store_learning_v2(
    session_id: str,
    content: str,
    learning_type: str | None = None,
    context: str | None = None,
    tags: list[str] | None = None,
    confidence: str | None = None,
    project_dir: str | None = None,
    scope: str | None = None,
    agent_id: str | None = None,
    source: str | None = None,
    is_inference: bool = False,
    candidate_hash: str | None = None,
    evidence: dict | None = None,
) -> dict:
    """Store learning with v2 metadata schema, deduplication, and scope classification.

    Every write is redacted (content, context, tags) BEFORE the embedding, checked
    against the MemoryCandidate schema, and stamped with provenance.

    Args:
        session_id: Session identifier
        content: The learning content
        learning_type: One of LEARNING_TYPES (e.g., WORKING_SOLUTION). When
            None, the canonical 7-type heuristic (``_infer_learning_type``)
            is used so the ``archival_memory.learning_type`` column is
            always populated. Previously, passing None left the column
            NULL, which broke type-scoped recall.
        context: What this learning relates to (e.g., "hook development")
        tags: List of tags for categorization
        confidence: Confidence level (high/medium/low)
        project_dir: Project directory for PROJECT scope learnings
        scope: Override scope classification (PROJECT or GLOBAL)
        agent_id: Optional agent identifier (e.g., "kraken", "spark"). When
            set, written to ``archival_memory.agent_id`` so per-agent recall
            works (G12 follow-up).
        source: Required. One of hook, manual, handoff, llm. A missing value is a
            failure (logged for the health line). A value outside the set is a
            schema reject.
        is_inference: True when the content is a model conclusion, not an observed fact.
        candidate_hash: content_hash of the RAW candidate, for the reject log. Without
            it the hash is taken from the redacted content.
        evidence: Extractor rows only: {kind, line, hash}.

    Returns:
        dict with success status, memory_id, or skipped info for duplicates
    """
    try:
        from db.memory_factory import (
            create_memory_service,
            get_default_backend,
        )
        from db.embedding_service import EmbeddingService
    except ImportError as e:
        record_write_failure("store_learning", f"Memory service not available: {e}", session_id)
        return {"success": False, "error": f"Memory service not available: {e}"}

    if not content or not content.strip():
        return {"success": False, "error": "No content provided"}

    if source is None:
        # A caller that forgot provenance is a bug. Make it visible on the health line.
        record_write_failure("store_learning", "missing metadata.source", session_id)
        return {"success": False, "error": "source is required (hook, manual, handoff, llm)"}

    if not session_id or not session_id.strip() or session_id.strip() == "default":
        session_id = SENTINEL_UNKNOWN

    # Redact BEFORE anything else sees the text: the embedder, scope classifier,
    # dedup search and the row all get the redacted values.
    redacted = redact(content)
    content = redacted.text
    context, context_hits = redact_obj(context)
    tags, tag_hits = redact_obj(tags)
    redacted_kinds = sorted(set(redacted.hits) | set(context_hits) | set(tag_hits))
    reject_hash = candidate_hash or content_hash(content)
    content, context, tags = clip_fields(content, context, tags)

    # Infer learning_type when caller passes None. This runs BEFORE the
    # quality gate so the gate sees a non-NULL type and the NULL-type guard
    # in validate_learning_quality only fires for external callers that
    # bypass this helper (impossible from inside store_learning_v2, but the
    # _internal_caller flag below makes that explicit).
    if learning_type is None:
        learning_type = _infer_learning_type(content)

    # Schema check: field types, lengths and enums, before the quality gate.
    candidate, schema_reasons = validate_candidate(
        {
            "content": content,
            "learning_type": learning_type,
            "source": source,
            "is_inference": is_inference,
            "session_id": session_id,
            "context": context,
            "tags": tags or [],
            "confidence": confidence,
            "evidence": evidence,
        }
    )
    if candidate is None:
        reason = ",".join(schema_reasons[:3])
        record_reject(reject_hash, "schema", reason, source, session_id)
        return {"success": True, "skipped": True, "reason": reason}

    # Quality gate -- reject noise before expensive embedding.
    # We pass _internal_caller=True because we just inferred a type above;
    # the NULL-type guard would otherwise fire spuriously if the heuristic
    # somehow returns None in the future.
    quality = validate_learning_quality(
        content, learning_type, _internal_caller=True, session_id=session_id
    )
    if not quality["passes"]:
        record_reject(reject_hash, "gate_a", quality["reason"], source, session_id)
        return {"success": True, "skipped": True, "reason": quality["reason"]}

    # Postgres when any database URL is configured (the wizard writes only
    # CONTINUOUS_CLAUDE_DB_URL; the sqlite backend module does not exist).
    from db.postgres_pool import configured_url

    if configured_url():
        backend = "postgres"
    else:
        backend = get_default_backend()

    try:
        memory = await create_memory_service(
            backend=backend,
            session_id=session_id,
            agent_id=agent_id,
        )

        # Generate embedding (uses singleton to avoid 1.5GB model reload)
        embedder = get_embedder()
        embedding = await embedder.embed(content)

        # Classify scope if not explicitly provided. Phase 4C: we need this
        # BEFORE dedup so the dedup search can scope by project_id, not by
        # the current session_id.
        final_scope = scope or classify_scope(content, tags, context)
        project_id = get_project_id(project_dir) if project_dir else None

        # Deduplication check (Phase 4C: scoped by project_id, not session_id).
        # GLOBAL learnings dedup across ALL global rows. PROJECT learnings
        # dedup within the same project_id (or within the NULL-project bucket
        # when project_dir wasn't provided).
        try:
            existing = await memory.search_vector_for_dedup(
                embedding,
                scope=final_scope,
                project_id=project_id,
                limit=1,
            )
            if existing and len(existing) > 0:
                top_match = existing[0]
                similarity = top_match.get("similarity", 0)
                if similarity >= DEDUP_THRESHOLD:
                    await memory.close()
                    return {
                        "success": True,
                        "skipped": True,
                        "reason": f"duplicate (similarity: {similarity:.2f})",
                        "existing_id": top_match.get("id"),
                    }
        except Exception:
            # If search fails, proceed with storing (don't block on dedup errors)
            pass

        # Build metadata
        metadata = {
            "type": "session_learning",
            "session_id": session_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        if learning_type:
            metadata["learning_type"] = learning_type
        if context:
            metadata["context"] = context
        if tags:
            metadata["tags"] = tags
        if confidence:
            metadata["confidence"] = confidence
        metadata["source"] = source
        metadata["is_inference"] = is_inference
        if evidence:
            metadata["evidence"] = evidence
        if redacted_kinds:
            metadata["redacted_kinds"] = redacted_kinds

        # Store with embedding, scope, and project_id
        memory_id = await memory.store(
            content,
            metadata=metadata,
            embedding=embedding,
            scope=final_scope,
            project_id=project_id,
        )

        await memory.close()

        return {
            "success": True,
            "memory_id": memory_id,
            "backend": backend,
            "content_length": len(content),
            "embedding_dim": len(embedding),
            "scope": final_scope,
            "project_id": project_id,
        }

    except Exception as e:
        record_write_failure("store_learning", e, session_id)
        return {"success": False, "error": str(e)}


# Mapping from legacy v1 bundle categories to v2 learning types.
# Used by the deprecated v1 entrypoint to route each category through the
# v2 quality gate with the correct learning_type semantic.
_V1_CATEGORY_TO_TYPE = {
    "worked": "WORKING_SOLUTION",
    "failed": "FAILED_APPROACH",
    "decisions": "ARCHITECTURAL_DECISION",
    "patterns": "CODEBASE_PATTERN",
}


async def store_learning(
    session_id: str,
    worked: str,
    failed: str,
    decisions: str,
    patterns: str,
    source: str = "manual",
    is_inference: bool = False,
) -> dict:
    """[DEPRECATED] Legacy v1 entrypoint -- routes through store_learning_v2.

    .. deprecated:: 4.0
        Use ``store_learning_v2`` directly. This wrapper exists only for
        back-compat with callers still on the legacy bundle interface.
        Every category (worked/failed/decisions/patterns) is routed through
        the v2 quality gate (``validate_learning_quality``) with the
        appropriate ``learning_type``. NOISE inputs are now rejected
        (previously written to Postgres unscored), and dedup applies.

    Args:
        session_id: Session identifier
        worked: What worked well -> WORKING_SOLUTION
        failed: What failed or was tricky -> FAILED_APPROACH
        decisions: Key decisions made -> ARCHITECTURAL_DECISION
        patterns: Reusable patterns -> CODEBASE_PATTERN
        source: Provenance source passed to every v2 call (default "manual")
        is_inference: True when the content is a model conclusion

    Returns:
        Aggregated dict with per-category results. Top-level ``success`` is
        True iff all non-empty categories were either stored or skipped
        cleanly (i.e., no transport/backend errors). Each category appears
        as a sub-dict under ``results`` with the same shape that
        ``store_learning_v2`` returns.
    """
    warnings.warn(
        "store_learning() is deprecated; use store_learning_v2() directly. "
        "Each legacy category (worked/failed/decisions/patterns) is now "
        "routed through the v2 quality gate. NOISE inputs will be rejected.",
        DeprecationWarning,
        stacklevel=2,
    )

    # Collect non-empty categories
    legacy_bundle = {
        "worked": worked,
        "failed": failed,
        "decisions": decisions,
        "patterns": patterns,
    }
    populated = {
        cat: val
        for cat, val in legacy_bundle.items()
        if val and val.strip().lower() != "none"
    }

    if not populated:
        return {"success": False, "error": "No learning content provided"}

    # Route each category through v2. The v2 path handles:
    #   - quality gate (rejects NOISE, including too-short content)
    #   - embedding via singleton
    #   - dedup
    #   - scope classification
    results: dict[str, dict] = {}
    any_stored = False
    any_error = False
    for category, value in populated.items():
        learning_type = _V1_CATEGORY_TO_TYPE[category]
        result = await store_learning_v2(
            session_id=session_id,
            content=value,
            learning_type=learning_type,
            context=f"v1_legacy:{category}",
            tags=["v1_legacy", category],
            source=source,
            is_inference=is_inference,
        )
        results[category] = result
        if result.get("success") and not result.get("skipped"):
            any_stored = True
        if not result.get("success"):
            any_error = True

    # Aggregate top-level shape -- preserve back-compat fields where possible.
    aggregated: dict = {
        "success": not any_error,
        "results": results,
        "categories_processed": list(populated.keys()),
        "deprecated": True,
    }

    # If exactly one category was stored, surface its memory_id at top level
    # for callers expecting v1's single-row shape.
    stored_ids = [
        (cat, r.get("memory_id"))
        for cat, r in results.items()
        if r.get("success") and not r.get("skipped") and r.get("memory_id")
    ]
    if len(stored_ids) == 1:
        aggregated["memory_id"] = stored_ids[0][1]
    elif stored_ids:
        aggregated["memory_ids"] = {cat: mid for cat, mid in stored_ids}

    if any_stored:
        # Pull backend/embedding_dim from the first successful store
        for r in results.values():
            if r.get("success") and not r.get("skipped"):
                if "backend" in r:
                    aggregated["backend"] = r["backend"]
                if "embedding_dim" in r:
                    aggregated["embedding_dim"] = r["embedding_dim"]
                break

    aggregated["content_length"] = sum(len(v) for v in populated.values())

    return aggregated


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Store session learnings in memory")
    parser.add_argument(
        "--session-id",
        default=os.environ.get("CLAUDE_SESSION_ID") or SENTINEL_CLI,
        help=(
            "Session identifier (default: $CLAUDE_SESSION_ID, else "
            f"'{SENTINEL_CLI}' for a manual store with no session)"
        ),
    )

    # Legacy parameters (v1)
    parser.add_argument("--worked", default="None", help="What worked well (legacy)")
    parser.add_argument("--failed", default="None", help="What failed or was tricky (legacy)")
    parser.add_argument("--decisions", default="None", help="Key decisions made (legacy)")
    parser.add_argument("--patterns", default="None", help="Reusable patterns (legacy)")

    # New v2 parameters
    parser.add_argument(
        "--type",
        choices=LEARNING_TYPES,
        help="Learning type (v2)",
    )
    parser.add_argument("--content", help="Direct content (v2)")
    parser.add_argument("--context", help="What this relates to (v2)")
    parser.add_argument("--tags", help="Comma-separated tags (v2)")
    parser.add_argument(
        "--confidence",
        choices=CONFIDENCE_LEVELS,
        help="Confidence level (v2)",
    )

    # Scope parameters (v3)
    parser.add_argument("--project-dir", help="Project directory for PROJECT scope")
    parser.add_argument(
        "--scope",
        choices=["PROJECT", "GLOBAL"],
        help="Override scope classification",
    )

    # Agent identifier (G12 follow-up: writes to archival_memory.agent_id)
    parser.add_argument(
        "--agent-id",
        default=os.environ.get("CLAUDE_AGENT_ID"),
        help="Optional agent identifier (defaults to $CLAUDE_AGENT_ID)",
    )

    # Provenance (phase 3)
    parser.add_argument(
        "--source",
        choices=list(SOURCES),
        default="manual",
        help="Where the learning came from (default: manual, a deliberate store)",
    )
    parser.add_argument(
        "--inferred",
        action="store_true",
        help="Mark the content as a model conclusion, not an observed fact",
    )

    # Output options
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    return parser


async def main():
    args = build_parser().parse_args()

    # Determine which mode to use: v2 if --content is provided, else legacy
    if args.content:
        # Parse tags from comma-separated string to list
        tags = None
        if args.tags:
            tags = [t.strip() for t in args.tags.split(",") if t.strip()]

        result = await store_learning_v2(
            session_id=args.session_id,
            content=args.content,
            learning_type=args.type,
            context=args.context,
            tags=tags,
            confidence=args.confidence,
            project_dir=args.project_dir,
            scope=args.scope,
            agent_id=args.agent_id,
            source=args.source,
            is_inference=args.inferred,
        )
    else:
        # Legacy mode
        result = await store_learning(
            session_id=args.session_id,
            worked=args.worked,
            failed=args.failed,
            decisions=args.decisions,
            patterns=args.patterns,
            source=args.source,
            is_inference=args.inferred,
        )

    if args.json:
        # Ensure all values are JSON serializable (UUIDs, etc.)
        def serialize(obj):
            if hasattr(obj, 'hex'):  # UUID
                return str(obj)
            raise TypeError(f"Object of type {type(obj)} is not JSON serializable")
        print(json.dumps(result, default=serialize))
    else:
        if result.get("skipped"):
            print(f"~ Learning skipped: {result.get('reason', 'duplicate')}")
        elif result["success"]:
            print(f"Learning stored (id: {result.get('memory_id', 'unknown')})")
            print(f"  Backend: {result.get('backend', 'unknown')}")
            print(f"  Content: {result.get('content_length', 0)} chars")
            if result.get("scope"):
                print(f"  Scope: {result.get('scope')}")
        else:
            print(f"Failed to store learning: {result.get('error', 'unknown')}")
            sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
