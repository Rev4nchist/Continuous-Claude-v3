#!/usr/bin/env python3
"""Recall learnings from archival_memory backed by Postgres + pgvector.

Default mode is hybrid RRF (Reciprocal Rank Fusion) combining text (FTS)
and vector (pgvector cosine) ranks. The vector arm calls the local BGE
embedding daemon (BAAI/bge-large-en-v1.5) over TCP loopback for query
embedding; falls back to in-process embedding if the daemon is unreachable.

MODES (mutually exclusive flags):
    default (no flag): hybrid RRF -- combines FTS + pgvector ranks.
        The --threshold CLI default (0.2) is scaled by 0.01 internally
        because RRF scores cluster in the 0.01-0.03 range.
    --text-only:       FTS only. No embeddings; no daemon dependency.
        Uses the --threshold value directly (FTS ts_rank scale).
    --vector-only:     pgvector cosine similarity only (no FTS arm).
        Accepts --threshold raw (0.0-1.0 cosine scale). Supports
        --recency for time-weighted ranking.
    --rerank:          opt-in stage-2 cross-encoder rerank
        (BAAI/bge-reranker-v2-m3) over the top-N RRF candidates.
        Requires the rerank daemon (rerank.py --daemon) for
        production-acceptable latency. Applied after RRF, before output.
    --pageindex:       PageIndex tree-based search (ROADMAP, docs).
    --hybrid:          Combined vector memory + PageIndex search.

OUTPUT:
    Default: human-readable ranked list with scores and metadata.
    --json: machine-readable JSON array (used by memory-awareness.ts hook).

OPERATIONAL:
    Scope partitioning: rows tagged scope=PROJECT are filtered to the
        current project (CLAUDE_PROJECT_ID or resolved from CWD).
        scope=GLOBAL rows are always visible across all projects.
        Pass --scope all to disable filtering.
    Decay weighting: _apply_decay() down-weights older entries so
        more recent learnings rank higher at equal similarity.
    Dedup: store_learning.py uses 0.85 cosine similarity threshold
        at write time; near-duplicate entries are rejected at storage.

USAGE:
    # Default hybrid RRF (recommended)
    uv run python scripts/core/recall_learnings.py --query "auth patterns"

    # More results
    uv run python scripts/core/recall_learnings.py --query "db schema" --k 10

    # Text-only (faster, no daemon required)
    uv run python scripts/core/recall_learnings.py --query "errors" --text-only

    # With cross-encoder rerank (requires rerank daemon)
    uv run python scripts/core/recall_learnings.py --query "memory hardening" --rerank

Environment:
    DATABASE_URL      - Postgres connection string (opc/.env is authoritative)
    VOYAGE_API_KEY    - For Voyage embeddings provider (optional, legacy)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

# Load .env files - opc/.env is authoritative for DATABASE_URL
# Use override=True so .env takes precedence over shell env vars
script_dir = Path(__file__).resolve().parent
opc_dir = script_dir.parent.parent  # opc/scripts/core -> opc/
opc_env = opc_dir / ".env"
if opc_env.exists():
    load_dotenv(opc_env, override=True)  # opc/.env is authoritative

global_env = Path.home() / ".claude" / ".env"
if global_env.exists():
    load_dotenv(global_env)  # Global env supplements but doesn't override
load_dotenv()  # CWD .env as fallback

# Add scripts to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def format_result_preview(content: str, max_length: int = 200) -> str:
    """Format content for display, truncating if needed.

    Args:
        content: Full content string
        max_length: Maximum characters before truncation

    Returns:
        Content string, truncated with ... if over max_length
    """
    if len(content) <= max_length:
        return content
    return content[:max_length] + "..."


def get_backend() -> str:
    """Determine which backend to use (sqlite or postgres)."""
    # Check explicit env var first
    backend = os.environ.get("AGENTICA_MEMORY_BACKEND", "").lower()
    if backend in ("sqlite", "postgres"):
        return backend

    # Check if DATABASE_URL or CONTINUOUS_CLAUDE_DB_URL is set
    if os.environ.get("DATABASE_URL") or os.environ.get("CONTINUOUS_CLAUDE_DB_URL"):
        return "postgres"

    # Default to sqlite for simplicity
    return "sqlite"


def _resolve_registry_path() -> Path:
    """Locate .claude/project-registry.json relative to the install root.

    Phase B2: previously hardcoded as ``~/continuous-claude/.claude/...`` which
    only worked for the original developer's username and breaks on CI / new
    machines / non-default install paths. We instead derive the install root
    from this file's location: ``opc/scripts/core/recall_learnings.py`` lives
    three parents below the install root, so ``__file__.parents[3]`` is the
    repo root and ``<root>/.claude/project-registry.json`` is the registry.
    """
    install_root = Path(__file__).resolve().parents[3]
    return install_root / ".claude" / "project-registry.json"


def _resolve_registered_root(abs_path: str) -> str | None:
    """Return the registered PROJECT ROOT containing abs_path, or None.

    Returns the root, not a bool, because the caller must hash the ROOT rather
    than the path it was given. abs_path may legitimately be a SUBDIRECTORY of
    a registered project -- and the canonical documented invocation is exactly
    that: `cd $CLAUDE_OPC_DIR && ... recall_learnings.py`, i.e. from `opc/`.

    Getting this wrong is silent and total. The old code answered a bool here
    and then hashed the CWD, so from `<repo>/opc` it derived
    b963d587e5d0a6b0 while every stored row carries the repo root's
    addc92d926988bb9. Mode still reported 'project', the SQL still ran, and it
    matched nothing -- so PROJECT-scoped recall returned GLOBAL rows only and
    looked exactly like "no relevant memories". Two handoffs recorded that as a
    possible break in the read path; the read path was fine, the scope key was
    wrong.

    Longest match wins, so a project nested inside another resolves to the
    innermost one rather than whichever the registry happens to list first.
    """
    try:
        registry_path = _resolve_registry_path()
        if not registry_path.exists():
            return None
        with open(registry_path, encoding="utf-8") as f:
            registry = json.load(f)
        norm = str(Path(abs_path).resolve()).replace("\\", "/").lower()
        best: str | None = None
        best_len = -1
        for proj in registry.get("projects", []):
            raw = proj.get("path", "")
            if not raw:
                continue
            resolved = str(Path(raw).resolve())
            proj_path = resolved.replace("\\", "/").lower()
            if norm == proj_path or norm.startswith(proj_path + "/"):
                if len(proj_path) > best_len:
                    best, best_len = resolved, len(proj_path)
        return best
    except Exception:
        return None


def _is_registered_project(abs_path: str) -> bool:
    """Back-compat wrapper: does abs_path sit inside a registered project?

    Kept because it names a real question, but callers deciding SCOPE must use
    _resolve_registered_root -- a bool cannot tell you what to hash.
    """
    return _resolve_registered_root(abs_path) is not None


def resolve_recall_scope(
    project_dir: str | None = None,
    all_projects: bool = False,
) -> tuple[str | None, str]:
    """Resolve project_id and recall mode for the current invocation.

    Decision flow:
      1. all_projects=True            -> ('all', 'all')           debug opt-out
      2. CLAUDE_PROJECT_ID env set    -> (env_value, 'project')   explicit override
      3. project_dir provided         -> (sha256(...), 'project') explicit
      4. CWD inside registered project-> (sha256(ROOT), 'project') implicit
                                         NB: the project ROOT, not the CWD --
                                         a subdir hashes to an id no row has.
      5. else                          -> (None, 'global_only')   fail-safe default

    Returns:
        Tuple of (project_id, mode).
        - mode='all'           -> drop the project_id filter entirely
        - mode='project'       -> WHERE (scope='GLOBAL' OR (scope='PROJECT' AND project_id=?))
        - mode='global_only'   -> WHERE scope = 'GLOBAL'
    """
    if all_projects:
        return None, "all"

    # Explicit env-var override (used in tests + hooks that already know project_id)
    env_pid = os.environ.get("CLAUDE_PROJECT_ID")
    if env_pid:
        return env_pid, "project"

    # Explicit CLI flag
    if project_dir:
        from project_memory import get_project_id  # type: ignore
        return get_project_id(project_dir), "project"

    # Implicit: CWD inside a registered project.
    # Hash the matched project ROOT, never the CWD -- see _resolve_registered_root.
    cwd = os.getcwd()
    root = _resolve_registered_root(cwd)
    if root:
        from project_memory import get_project_id  # type: ignore
        return get_project_id(root), "project"

    # Fail-safe: GLOBAL-only when context is unclear
    return None, "global_only"


def _build_scope_clause(
    mode: str,
    project_id: str | None,
    starting_param_idx: int,
) -> tuple[str, list[Any], int]:
    """Build SQL WHERE fragment + params for project_id scoping.

    Args:
        mode: One of 'all', 'project', 'global_only'.
        project_id: 16-char project hash (only used when mode == 'project').
        starting_param_idx: Next available 1-based param index.

    Returns:
        (clause, params_to_append, next_param_idx).
        clause is a parenthesized SQL fragment to AND into the WHERE; empty
        string when no constraint is needed (mode='all').
    """
    if mode == "all":
        return "", [], starting_param_idx
    if mode == "global_only":
        return f"scope = ${starting_param_idx}", ["GLOBAL"], starting_param_idx + 1
    # mode == 'project'
    if project_id is None:
        # Defensive: caller should have set project_id when mode=='project'.
        return f"scope = ${starting_param_idx}", ["GLOBAL"], starting_param_idx + 1
    clause = (
        f"(scope = ${starting_param_idx} OR "
        f"(scope = ${starting_param_idx + 1} AND project_id = ${starting_param_idx + 2}))"
    )
    return clause, ["GLOBAL", "PROJECT", project_id], starting_param_idx + 3


# Phase 1.10 (memory hardening v2): Temporal / decay defaults.
#
# Half-life of ~35 days: ln(2)/0.02 ~= 34.7 days. Older entries are
# down-weighted exponentially so fresh learnings rank above ancient ones with
# identical similarity scores. Setting --decay-lambda 0 (or --no-decay)
# bypasses the multiplier.
DEFAULT_DECAY_LAMBDA = 0.02

# QW-06 Fix C (D3b-08): absolute cosine cutoff on the vector arm of the hybrid
# RRF query. Without it, every row gets a vector rank (cosine distance always
# defined), so semantically irrelevant rows survive RRF purely on vector
# ranking.
#
# Calibrated from the live corpus (2026-06-28). BGE-large has a high cosine
# baseline, so the spec's first-guess 0.45 was BELOW the junk ceiling and did
# not gate at all:
#   junk    "banana smoothie recipe ukulele"            top-5 cos = 0.527..0.495
#   on-topic"memory recall relevance hybrid floor decay" top-5 cos = 0.668..0.630
#   rows>=0.45: junk 46 / on-topic 330   (0.45 gates NOTHING — junk survives)
#   rows>=0.55: junk  0 / on-topic  17   (0.55 cleanly separates the two)
# 0.55 sits above the junk ceiling (0.527) and well below on-topic matches, so
# junk is gated to zero while on-topic recall keeps a healthy 17-row vector arm.
VECTOR_MIN_COSINE = 0.55  # TUNABLE — calibrate from memory-recall.jsonl as corpus grows (SG-01)


# Task 1.4 (Task #11 Path A): persistent BGE embedding daemon.
#
# When the daemon is alive at ~/.claude/run/ccv3-embedding.json AND ping responds
# ready=True under EMBED_DAEMON_PING_TIMEOUT_S, query embeds are routed
# through the daemon (TCP loopback, length-prefixed JSON frames) instead
# of paying the ~30s sentence-transformers import tax in-process.
#
# The daemon's embed output byte-for-byte matches LocalEmbeddingProvider
# (verified in kraken handoff smoke check, max_diff=0.00 on bge-large),
# so cosine similarity against rows stored in archival_memory.embedding
# is preserved.
#
# Fallback: any failure (no daemon, dead PID, slow ping, embed error,
# or non-local provider) routes through the in-process EmbeddingService
# path. The provider arg must equal "local" to use the daemon -- Voyage
# is API-backed and doesn't have the cold-start problem.
EMBED_DAEMON_PING_TIMEOUT_S = 1.5
# Mirrors DEFAULT_PING_TIMEOUT_MS = 1500 in embedding-client.ts (lines 67-73).
# Prior value was 0.2 s. The TS hook correctly used 1500ms, but Python re-pinged
# at 200ms, slipping under load → fell to in-process embed → 12s SIGKILL.
# Was 30.0 — too loose for hook path (8-12s subprocess budget).
# 5.0 still gives 30x safety margin over warm p95 ~157ms; hung daemon
# now caught before the hook itself times out.
EMBED_DAEMON_CALL_TIMEOUT_S = 5.0


async def _embed_query_with_daemon(
    query: str,
    provider: str,
    meta_out: dict[str, Any] | None = None,
) -> list[float]:
    """Embed ``query`` via the embedding daemon when alive, else in-process.

    Mirrors the rerank daemon routing pattern (``_apply_rerank``). When the
    daemon is reachable AND its ping responds with ``ready: true`` AND the
    requested provider is ``"local"`` (the only one the daemon serves),
    we send an ``embed`` request and return the vector. Otherwise we fall
    back to ``EmbeddingService(provider).embed(query)``.

    The optional ``meta_out`` dict is populated with diagnostics:
      * ``embed_used_daemon``: True iff the daemon answered with a vector.
      * ``embed_elapsed_ms``: total time spent embedding (daemon or local).
      * ``embed_provider``: the provider that produced the vector (echo of
        the input arg; "local" for daemon path).
      * ``embed_fallback_reason``: filled when used_daemon=False and a
        non-trivial reason exists (e.g. "daemon_not_alive", "ping_failed",
        "embed_failed", "provider_not_local").

    Args:
        query: Text to embed.
        provider: Embedding provider name ("local" or "voyage").
        meta_out: Optional diagnostic sink. Mutated in place when provided.

    Returns:
        Query embedding (list of floats). Dim matches the provider's model.
    """
    t0 = time.perf_counter()

    # Only the local BGE daemon is supported. Voyage has its own latency
    # profile (API call, no cold start) and a different dimension on some
    # models -- the daemon would silently produce 1024-dim vectors that
    # don't match Voyage rows. Bail out fast.
    if provider != "local":
        if meta_out is not None:
            meta_out["embed_fallback_reason"] = "provider_not_local"
        return await _embed_query_inproc(query, provider, t0, meta_out)

    # Try the daemon. Import lazily so the daemon module isn't loaded
    # unless we're actually about to use it.
    try:
        from core import embedding_daemon as _ed  # type: ignore
    except ImportError:
        if meta_out is not None:
            meta_out["embed_fallback_reason"] = "daemon_import_error"
        return await _embed_query_inproc(query, provider, t0, meta_out)

    # Cheap discovery + PID check before paying the ping round-trip.
    alive, info = _ed.daemon_is_alive()
    if not alive or not info:
        if meta_out is not None:
            meta_out["embed_fallback_reason"] = "daemon_not_alive"
        return await _embed_query_inproc(query, provider, t0, meta_out)

    # Liveness probe with a tight timeout so we don't burn the recall
    # budget on a hung daemon.
    ping_resp = _ed.ping_daemon(timeout_s=EMBED_DAEMON_PING_TIMEOUT_S)
    if not ping_resp or not ping_resp.get("ready"):
        if meta_out is not None:
            meta_out["embed_fallback_reason"] = (
                "ping_failed" if not ping_resp else "model_not_ready"
            )
        return await _embed_query_inproc(query, provider, t0, meta_out)

    # Sanity-check: model + dim must match what's stored in archival_memory.
    # If the daemon was started against a different model (bge-base etc.),
    # bail out -- silent dim mismatch would corrupt recall.
    if ping_resp.get("model") != "BAAI/bge-large-en-v1.5" or ping_resp.get("dim") != 1024:
        if meta_out is not None:
            meta_out["embed_fallback_reason"] = "daemon_model_mismatch"
            meta_out["daemon_model"] = ping_resp.get("model")
            meta_out["daemon_dim"] = ping_resp.get("dim")
        return await _embed_query_inproc(query, provider, t0, meta_out)

    # Send the embed request.
    resp = _ed.embed_via_daemon(query, timeout_s=EMBED_DAEMON_CALL_TIMEOUT_S)
    if resp is None or "vector" not in resp:
        if meta_out is not None:
            meta_out["embed_fallback_reason"] = (
                "embed_failed" if resp is None else "embed_no_vector"
            )
            if resp is not None and "error" in resp:
                meta_out["embed_daemon_error"] = resp["error"]
        return await _embed_query_inproc(query, provider, t0, meta_out)

    elapsed_ms = (time.perf_counter() - t0) * 1000
    if meta_out is not None:
        meta_out["embed_used_daemon"] = True
        meta_out["embed_elapsed_ms"] = elapsed_ms
        meta_out["embed_provider"] = provider
        meta_out["embed_dim"] = len(resp["vector"])
        # Echo the daemon-internal timing for diagnostics.
        if "elapsed_ms" in resp:
            meta_out["embed_daemon_inner_ms"] = float(resp["elapsed_ms"])
    return resp["vector"]


async def _embed_query_inproc(
    query: str,
    provider: str,
    t0: float,
    meta_out: dict[str, Any] | None,
) -> list[float]:
    """Fallback path: load EmbeddingService in-process and embed.

    Pays the ~30s sentence-transformers import + bge-large load on first
    call within this process. Subsequent calls within the same process
    are fast.
    """
    from db.embedding_service import EmbeddingService

    embedder = EmbeddingService(provider=provider)
    try:
        vec = await embedder.embed(query)
    finally:
        await embedder.aclose()
    elapsed_ms = (time.perf_counter() - t0) * 1000
    if meta_out is not None:
        # Don't clobber the existing fallback_reason if already set.
        meta_out.setdefault("embed_used_daemon", False)
        meta_out["embed_elapsed_ms"] = elapsed_ms
        meta_out["embed_provider"] = provider
        meta_out["embed_dim"] = len(vec)
    return vec


def _build_temporal_clause(
    valid_at: datetime | None,
    include_superseded: bool,
    starting_param_idx: int,
) -> tuple[str, list[Any], int]:
    """Build SQL WHERE fragment + params for temporal validity scoping.

    Args:
        valid_at: If provided, restrict to entries where valid_from <= valid_at
            AND (valid_until IS NULL OR valid_until > valid_at). The bi-temporal
            full filter is only applied when the caller passes an explicit
            timestamp -- the default behaviour just filters out
            currently-superseded rows.
        include_superseded: If True, do not filter out entries with
            valid_until < NOW(). Useful for historical analysis. Ignored when
            valid_at is set (the valid_at filter is more specific).
        starting_param_idx: Next available 1-based param index.

    Returns:
        (clause, params_to_append, next_param_idx).
        clause is a parenthesized SQL fragment to AND into the WHERE; empty
        string when no temporal constraint applies.
    """
    # Explicit point-in-time query: full bi-temporal filter.
    if valid_at is not None:
        clause = (
            f"(valid_from <= ${starting_param_idx}::timestamptz AND "
            f"(valid_until IS NULL OR valid_until > ${starting_param_idx}::timestamptz))"
        )
        return clause, [valid_at], starting_param_idx + 1

    # Default behaviour: drop currently-superseded rows.
    if include_superseded:
        return "", [], starting_param_idx

    # Filter rows where valid_until < NOW() (i.e., superseded in the past).
    # We use NOW() inline rather than parameterizing -- this is the cheapest
    # form and keeps the param indices stable across callers.
    return "(valid_until IS NULL OR valid_until > NOW())", [], starting_param_idx


def _apply_decay(
    results: list[dict[str, Any]],
    decay_lambda: float,
    *,
    score_key: str = "similarity",
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Apply exponential decay to result scores in Python.

    Used as a fallback / for backends where we don't compute decay in SQL.
    When decay_lambda <= 0, this is a no-op that still records audit fields.

    Sets on each result:
        base_score: original score before decay
        decay_weight: multiplier applied (1.0 when no decay)
        final_score: base_score * decay_weight
        age_days: integer age in days (clamped to >= 0)

    Also re-sorts the list by final_score descending so callers can rely on
    ordering after the multiplier.
    """
    now = now or datetime.now(timezone.utc)
    for r in results:
        base = float(r.get(score_key, 0.0) or 0.0)
        created = r.get("created_at")
        if isinstance(created, datetime):
            # Postgres returns tz-aware; SQLite may be naive. Coerce naive ->
            # UTC so the subtraction is well-defined.
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            age_seconds = max(0.0, (now - created).total_seconds())
        else:
            age_seconds = 0.0
        age_days = age_seconds / 86400.0
        if decay_lambda > 0:
            weight = math.exp(-age_days * decay_lambda)
        else:
            weight = 1.0
        r["base_score"] = base
        r["decay_weight"] = weight
        r["age_days"] = int(age_days)
        r["final_score"] = base * weight
        # Keep the legacy "similarity" key in sync so existing consumers
        # that read result["similarity"] see the decay-adjusted score.
        r["similarity"] = base * weight
    results.sort(key=lambda x: x.get("final_score", 0.0), reverse=True)
    return results


async def search_learnings_text_only_postgres(
    query: str,
    k: int = 5,
    project_id: str | None = None,
    scope_mode: str | None = None,
    valid_at: datetime | None = None,
    include_superseded: bool = False,
    decay_lambda: float = DEFAULT_DECAY_LAMBDA,
) -> list[dict[str, Any]]:
    """Fast text-only search for PostgreSQL using full-text search.

    Uses tsvector/tsquery with GIN index. Automatic stopword handling.
    Falls back to ILIKE if tsquery fails (e.g., all stopwords).

    Cross-project isolation:
        Filters by project_id so PROJECT-scoped rows from other projects do
        not leak. GLOBAL-scoped rows are always visible. Pass scope_mode='all'
        (or set --all-projects on the CLI) to drop the filter for debug.

        When called without explicit args (the common library/test path), we
        auto-resolve scope from CLAUDE_PROJECT_ID, then CWD vs project
        registry, falling back to 'global_only' as the safe default.

    Temporal filtering (Phase 1.10):
        valid_at: point-in-time bi-temporal filter.
        include_superseded: keep rows with valid_until < NOW() (default False).
        decay_lambda: exponential decay applied in SQL (0 disables).
    """
    from db.postgres_pool import get_pool

    # Auto-resolve scope when caller didn't pass it explicitly
    if scope_mode is None:
        project_id, scope_mode = resolve_recall_scope()

    # Build the project_id constraint (params start at $3: query=$1, k=$2)
    scope_clause, scope_params, next_idx = _build_scope_clause(scope_mode, project_id, 3)
    # Build the temporal constraint after scope so param indices stay sequential.
    temporal_clause, temporal_params, _ = _build_temporal_clause(
        valid_at, include_superseded, next_idx,
    )

    pool = await get_pool()

    async with pool.acquire() as conn:
        # Try full-text search using plainto_tsquery (flexible OR semantics)
        # Strip meta-words and normalize for better matching
        meta_words = {'help', 'want', 'need', 'show', 'tell', 'find', 'look', 'please', 'with', 'for'}
        clean_query = query.lower().replace('-', ' ')  # "multi-terminal" -> "multi terminal"
        clean_query = ' '.join(w for w in clean_query.split() if w not in meta_words)
        if not clean_query.strip():
            clean_query = query  # Fallback to original if all stripped

        # Build OR-based query: "session affinity terminal" -> 'session' | 'affinity' | 'terminal'
        # This matches documents containing ANY of the terms, ranked by how many match
        words = [w for w in clean_query.split() if len(w) > 2]
        if not words:
            words = clean_query.split()[:1] or [query.split()[0]]
        or_query = ' | '.join(words)

        scope_sql = f" AND {scope_clause}" if scope_clause else ""
        temporal_sql = f" AND {temporal_clause}" if temporal_clause else ""

        # Decay applied in SQL so we sort by final_score before LIMIT.
        decay_select = (
            f"EXP(-EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0 * {decay_lambda})"
            if decay_lambda > 0
            else "1.0"
        )

        # Postgres doesn't allow output-column aliases inside arithmetic
        # expressions in ORDER BY (the alias is only visible in bare-reference
        # form). Inline the ts_rank expression so the decay multiplier
        # references real columns / functions.
        rank_expr = (
            "ts_rank(to_tsvector('english', content), "
            "to_tsquery('english', $1))"
        )
        rows = await conn.fetch(
            f"""
            SELECT
                id,
                session_id,
                content,
                metadata,
                created_at,
                valid_from,
                valid_until,
                {rank_expr} as similarity,
                {decay_select} as decay_weight
            FROM archival_memory
            WHERE (metadata->>'type' IS NULL OR metadata->>'type' IN (
                'session_learning', 'WORKING_SOLUTION', 'ERROR_FIX',
                'ARCHITECTURAL_DECISION', 'CODEBASE_PATTERN', 'FAILED_APPROACH',
                'USER_PREFERENCE', 'OPEN_THREAD'))
                AND to_tsvector('english', content) @@ to_tsquery('english', $1)
                AND LENGTH(content) >= 50
                {scope_sql}
                {temporal_sql}
            ORDER BY ({rank_expr} * {decay_select}) DESC, created_at DESC
            LIMIT $2
            """,
            or_query,
            k,
            *scope_params,
            *temporal_params,
        )

        # Fallback to ILIKE if no FTS results (query was all stopwords)
        if not rows:
            # Extract first word for simple substring match
            first_word = query.split()[0] if query.split() else query
            rows = await conn.fetch(
                f"""
                SELECT
                    id,
                    session_id,
                    content,
                    metadata,
                    created_at,
                    valid_from,
                    valid_until,
                    0.1 as similarity,
                    {decay_select} as decay_weight
                FROM archival_memory
                WHERE (metadata->>'type' IS NULL OR metadata->>'type' IN (
                    'session_learning', 'WORKING_SOLUTION', 'ERROR_FIX',
                    'ARCHITECTURAL_DECISION', 'CODEBASE_PATTERN', 'FAILED_APPROACH',
                    'USER_PREFERENCE', 'OPEN_THREAD'))
                    AND content ILIKE '%' || $1 || '%'
                    AND LENGTH(content) >= 50
                    {scope_sql}
                    {temporal_sql}
                ORDER BY (0.1 * {decay_select}) DESC, created_at DESC
                LIMIT $2
                """,
                first_word,
                k,
                *scope_params,
                *temporal_params,
            )

    results = []
    for row in rows:
        metadata = row["metadata"]
        if isinstance(metadata, str):
            metadata = json.loads(metadata)

        base = float(row["similarity"])
        weight = float(row["decay_weight"]) if row["decay_weight"] is not None else 1.0
        created = row["created_at"]
        age_seconds = 0.0
        if isinstance(created, datetime):
            now = datetime.now(timezone.utc)
            created_tz = created if created.tzinfo else created.replace(tzinfo=timezone.utc)
            age_seconds = max(0.0, (now - created_tz).total_seconds())

        results.append({
            "id": str(row["id"]),
            "session_id": row["session_id"],
            "content": row["content"],
            "metadata": metadata,
            "created_at": row["created_at"],
            "valid_from": row["valid_from"],
            "valid_until": row["valid_until"],
            "base_score": base,
            "decay_weight": weight,
            "final_score": base * weight,
            "age_days": int(age_seconds / 86400.0),
            "similarity": base * weight,  # Back-compat: read as final_score
        })

    return results


async def search_learnings_sqlite(query: str, k: int = 5) -> list[dict[str, Any]]:
    """Search learnings using SQLite FTS5 (BM25 ranking).

    Cross-session search - finds learnings from ALL sessions.

    Args:
        query: Search query
        k: Number of results to return

    Returns:
        List of matching learnings with BM25 scores
    """
    import sqlite3
    import re

    # Global SQLite path
    db_path = Path.home() / ".claude" / "cache" / "memory.db"

    if not db_path.exists():
        return []

    # Prepare FTS query (OR-join words for broader matching)
    words = re.findall(r"\w+", query.lower())
    fts_query = " OR ".join(words) if words else query

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    try:
        cursor = conn.execute(
            """
            SELECT
                a.id,
                a.session_id,
                a.content,
                a.metadata_json,
                a.created_at,
                bm25(archival_fts) as rank
            FROM archival_memory a
            JOIN archival_fts f ON a.rowid = f.rowid
            WHERE archival_fts MATCH ?
            ORDER BY rank
            LIMIT ?
            """,
            (fts_query, k),
        )
        rows = cursor.fetchall()

        results = []
        for row in rows:
            # BM25 returns negative scores (lower = better)
            # Normalize to 0.0-1.0 range
            raw_rank = row["rank"] if row["rank"] else 0
            normalized_score = min(1.0, max(0.0, -raw_rank / 25.0))

            metadata = {}
            if row["metadata_json"]:
                try:
                    metadata = json.loads(row["metadata_json"])
                except json.JSONDecodeError:
                    pass

            results.append({
                "id": row["id"] or "",
                "session_id": row["session_id"] or "unknown",
                "content": row["content"] or "",
                "metadata": metadata,
                "created_at": datetime.fromtimestamp(row["created_at"]) if row["created_at"] else None,
                "similarity": normalized_score,
            })

        return results
    finally:
        conn.close()


async def search_learnings_hybrid_rrf(
    query: str,
    k: int = 5,
    provider: str = "local",
    rrf_k: int = 60,
    similarity_threshold: float = 0.0,
    project_id: str | None = None,
    scope_mode: str | None = None,
    valid_at: datetime | None = None,
    include_superseded: bool = False,
    decay_lambda: float = DEFAULT_DECAY_LAMBDA,
    embed_meta_out: dict[str, Any] | None = None,
    query_vector: list[float] | None = None,
    stats_out: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Hybrid RRF search combining text and vector rankings.

    Uses Reciprocal Rank Fusion:
        score = 1/(k + rank_fts) + 1/(k + rank_vector)

    Args:
        query: Search query
        k: Number of results
        provider: Embedding provider
        rrf_k: RRF constant (default 60)
        similarity_threshold: Minimum RRF score to include (applied to
            base_score before decay; see Phase 1.10 note below)
        project_id: Project hash (16-char sha256). Auto-derived when None.
        scope_mode: 'project' | 'global_only' | 'all'. Auto-resolved when None.
        valid_at: Optional bi-temporal filter (point-in-time recall).
        include_superseded: When True, do not filter out rows whose
            valid_until has passed.
        decay_lambda: Exponential decay constant (per day). 0.02 -> half-life
            ~35 days. Set to 0 to disable.
        query_vector: ST-05 seam. When provided (by the resident recall
            daemon, which already embedded the query with its own pinned
            model), the internal ``_embed_query_with_daemon`` call is SKIPPED
            and this vector drives the pgvector leg directly. The FTS leg
            still uses ``query`` text (H4 — hybrid must not silently degrade
            to vector-only). The CLI passes ``None`` and is unchanged.
        stats_out: ST-05 seam. Optional diagnostics sink (mutated in place):
            ``vector_count`` / ``fts_count`` (arm participation across the
            fetched candidate rows) and ``threshold_drops`` (rows below
            ``similarity_threshold``). ``None`` on the CLI path -> no-op.

    Returns:
        List of learnings with RRF + decay-adjusted scores. Each row has
        base_score, decay_weight, age_days, final_score in addition to the
        legacy similarity field (which mirrors final_score for back-compat).

    Cross-project isolation:
        PROJECT-scoped rows from other projects are filtered out by default.
        GLOBAL-scoped rows are always visible. Pass scope_mode='all' to drop
        the filter (debug only).
    """
    from db.memory_service_pg import build_rrf_sql
    from db.postgres_pool import get_pool, init_pgvector

    # Auto-resolve scope when caller didn't pass it explicitly
    if scope_mode is None:
        project_id, scope_mode = resolve_recall_scope()

    pool = await get_pool()

    # Generate query embedding. Task 1.4: route through the embedding
    # daemon when alive, else fall back to in-process. Diagnostics land
    # in embed_meta_out (mutated dict), which main() merges into the
    # JSON `_meta` block.
    #
    # ST-05 seam: when the caller (resident recall daemon) already embedded
    # the query with its OWN resident model, thread that vector straight into
    # the pgvector leg and skip the embed round-trip entirely. `query` text
    # is still passed to the FTS leg below (H4). CLI path: query_vector=None.
    if query_vector is not None:
        query_embedding = query_vector
    else:
        query_embedding = await _embed_query_with_daemon(
            query=query,
            provider=provider,
            meta_out=embed_meta_out,
        )

    # Filter to learning-typed entries (or untyped legacy rows), with content
    # length and a known agent-failure exclusion. Phase 3B: WHERE-only fragment;
    # the shared builder appends the FTS @@ tsquery and embedding-NOT-NULL clauses
    # to each ranking CTE.
    learnings_where = (
        "(metadata->>'type' IS NULL OR metadata->>'type' IN ("
        "'session_learning', 'WORKING_SOLUTION', 'ERROR_FIX', "
        "'ARCHITECTURAL_DECISION', 'CODEBASE_PATTERN', 'FAILED_APPROACH', "
        "'USER_PREFERENCE', 'OPEN_THREAD'))"
        " AND LENGTH(content) >= 50"
    )

    # Phase 1 (cross-project isolation): append project_id constraint to the
    # WHERE clause so it appears in BOTH ranking CTEs (FTS + vector). Param
    # indices for scope start at 5 (after text_query=1, embedding=2,
    # rrf_k=3, limit=4).
    scope_clause, scope_params, next_idx = _build_scope_clause(scope_mode, project_id, 5)
    if scope_clause:
        learnings_where = f"{learnings_where} AND {scope_clause}"

    # Phase 1.10: append the temporal/supersede filter. The shared RRF builder
    # applies `learnings_where` inside BOTH ranking CTEs, so this filters both
    # branches consistently.
    temporal_clause, temporal_params, _ = _build_temporal_clause(
        valid_at, include_superseded, next_idx,
    )
    if temporal_clause:
        learnings_where = f"{learnings_where} AND {temporal_clause}"

    async with pool.acquire() as conn:
        await init_pgvector(conn)

        # RRF query across all sessions for learnings, via shared builder.
        # We project valid_from/valid_until alongside the standard fields so
        # downstream JSON output can echo them.
        sql = build_rrf_sql(
            where_clause=learnings_where,
            text_query_param=1,
            embedding_param=2,
            rrf_k_param=3,
            limit_param=4,
            extra_select=[
                "a.session_id",
                "a.valid_from",
                "a.valid_until",
                "c.fts_rank",
                "c.vec_rank",
            ],
            min_cosine=VECTOR_MIN_COSINE,  # QW-06 Fix C (D3b-08): gate vector junk
        )
        rows = await conn.fetch(
            sql,
            query,
            str(query_embedding),
            rrf_k,
            k * 2,  # Fetch more to allow filtering
            *scope_params,
            *temporal_params,
        )

    # Convert rows then apply decay in Python (RRF score is computed in SQL
    # against a tight LIMIT; applying decay in SQL would require restructuring
    # the shared builder, so we post-process here -- the bounded k*2 row count
    # keeps this trivial).
    candidates: list[dict[str, Any]] = []
    for row in rows:
        # Defensive: tests sometimes mock rows without the new valid_from /
        # valid_until columns. asyncpg Records support dict(row) -- so we
        # normalise to a plain dict and use .get() for optional fields.
        row_d = dict(row) if not isinstance(row, dict) else row
        rrf_score = float(row_d["rrf_score"])

        # ST-05: arm-participation diagnostics across ALL fetched rows (before
        # the threshold filter). Guarded by stats_out so the CLI path is
        # untouched.
        if stats_out is not None:
            if row_d.get("vec_rank") is not None:
                stats_out["vector_count"] = stats_out.get("vector_count", 0) + 1
            if row_d.get("fts_rank") is not None:
                stats_out["fts_count"] = stats_out.get("fts_count", 0) + 1

        # Threshold applies to the base RRF score, not the decay-adjusted one.
        # That keeps the threshold semantics stable (it's about ranking
        # quality, not freshness).
        if similarity_threshold > 0 and rrf_score < similarity_threshold:
            if stats_out is not None:
                stats_out["threshold_drops"] = stats_out.get("threshold_drops", 0) + 1
            continue

        metadata = row_d["metadata"]
        if isinstance(metadata, str):
            metadata = json.loads(metadata)

        candidates.append({
            "id": str(row_d["id"]),
            "session_id": row_d["session_id"],
            "content": row_d["content"],
            "metadata": metadata,
            "created_at": row_d["created_at"],
            "valid_from": row_d.get("valid_from"),
            "valid_until": row_d.get("valid_until"),
            "similarity": rrf_score,  # Pre-decay; _apply_decay will overwrite
            "fts_rank": row_d.get("fts_rank"),
            "vec_rank": row_d.get("vec_rank"),
        })

    # Apply decay, re-sort by final_score, then trim to k.
    _apply_decay(candidates, decay_lambda, score_key="similarity")
    return candidates[:k]


async def search_learnings_postgres(
    query: str,
    k: int = 5,
    provider: str = "local",
    text_fallback: bool = True,
    similarity_threshold: float = 0.0,
    recency_weight: float = 0.0,
    project_id: str | None = None,
    scope_mode: str | None = None,
    valid_at: datetime | None = None,
    include_superseded: bool = False,
    decay_lambda: float = DEFAULT_DECAY_LAMBDA,
    embed_meta_out: dict[str, Any] | None = None,
    query_vector: list[float] | None = None,
) -> list[dict[str, Any]]:
    """Search learnings using PostgreSQL (vector similarity or text fallback).

    Args:
        query: Search query for semantic matching
        k: Number of results to return
        provider: Embedding provider ("local" or "voyage")
        text_fallback: If True, use text search when no embeddings exist
        similarity_threshold: Minimum similarity score (0.0-1.0) to include results
        recency_weight: Weight for recency boost (0.0-1.0). 0=no boost, 0.3=30% recency
        project_id: Project hash (16-char sha256). Auto-derived when None.
        scope_mode: 'project' | 'global_only' | 'all'. Auto-resolved when None.
        valid_at: Optional bi-temporal point-in-time filter.
        include_superseded: When True, do not filter out superseded rows.
        decay_lambda: Exponential decay per day (default 0.02, half-life ~35d).

    Returns:
        List of matching learnings. Each row exposes base_score, decay_weight,
        final_score, age_days alongside the legacy similarity field (which
        mirrors final_score for back-compat).
    """
    from db.postgres_pool import get_pool

    # Auto-resolve scope when caller didn't pass it explicitly
    if scope_mode is None:
        project_id, scope_mode = resolve_recall_scope()

    pool = await get_pool()

    # First check if any learnings have embeddings *within the resolved scope*.
    # Phase B2: the COUNT must apply the same scope-mode WHERE clause that the
    # downstream SELECTs use; otherwise this branch sees global embeddings,
    # picks the vector path, then the scoped SELECT returns zero rows even
    # when text-fallback would have found matches in the current project.
    # That manifested as "vector triggers, returns nothing, but text path
    # would have hit" right after the Phase 1 scope filter landed.
    scope_clause, scope_params, next_idx = _build_scope_clause(scope_mode, project_id, 1)
    scope_sql = f" AND {scope_clause}" if scope_clause else ""
    temporal_clause_count, temporal_params_count, _ = _build_temporal_clause(
        valid_at, include_superseded, next_idx,
    )
    temporal_sql_count = f" AND {temporal_clause_count}" if temporal_clause_count else ""
    async with pool.acquire() as conn:
        count_row = await conn.fetchrow(
            f"""
            SELECT COUNT(*) as cnt FROM archival_memory
            WHERE (metadata->>'type' IS NULL OR metadata->>'type' IN (
                'session_learning', 'WORKING_SOLUTION', 'ERROR_FIX',
                'ARCHITECTURAL_DECISION', 'CODEBASE_PATTERN', 'FAILED_APPROACH',
                'USER_PREFERENCE', 'OPEN_THREAD'))
                AND embedding IS NOT NULL
                {scope_sql}
                {temporal_sql_count}
            """,
            *scope_params,
            *temporal_params_count,
        )
        has_embeddings = count_row["cnt"] > 0

    # Decay expression reused across vector branches. Computed in SQL so the
    # ORDER BY can rank by the decay-adjusted score.
    decay_expr = (
        f"EXP(-EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0 * {decay_lambda})"
        if decay_lambda > 0
        else "1.0"
    )

    if has_embeddings:
        # Vector similarity search. Task 1.4: route through the embedding
        # daemon when alive, else fall back to in-process.
        # ST-05 seam: a precomputed query_vector (from the resident recall
        # daemon) skips the embed entirely. CLI path: query_vector=None.
        if query_vector is not None:
            query_embedding = query_vector
        else:
            query_embedding = await _embed_query_with_daemon(
                query=query,
                provider=provider,
                meta_out=embed_meta_out,
            )

        async with pool.acquire() as conn:
            from db.postgres_pool import init_pgvector
            await init_pgvector(conn)

            if recency_weight > 0:
                # Combined score: (1-recency_weight)*similarity + recency_weight*recency
                # Recency is normalized: 1.0 for newest, 0.0 for 30 days old or older
                # Scope params start at $4 (after embedding=$1, k=$2, recency=$3)
                scope_clause, scope_params, next_idx = _build_scope_clause(scope_mode, project_id, 4)
                scope_sql = f" AND {scope_clause}" if scope_clause else ""
                temporal_clause, temporal_params, _ = _build_temporal_clause(
                    valid_at, include_superseded, next_idx,
                )
                temporal_sql = f" AND {temporal_clause}" if temporal_clause else ""
                rows = await conn.fetch(
                    f"""
                    WITH scored AS (
                        SELECT
                            id,
                            session_id,
                            content,
                            metadata,
                            created_at,
                            valid_from,
                            valid_until,
                            1 - (embedding <=> $1::vector) as similarity,
                            GREATEST(0, 1.0 - EXTRACT(EPOCH FROM NOW() - created_at) / (30 * 86400)) as recency,
                            {decay_expr} as decay_weight
                        FROM archival_memory
                        WHERE (metadata->>'type' IS NULL OR metadata->>'type' IN (
                            'session_learning', 'WORKING_SOLUTION', 'ERROR_FIX',
                            'ARCHITECTURAL_DECISION', 'CODEBASE_PATTERN', 'FAILED_APPROACH',
                            'USER_PREFERENCE', 'OPEN_THREAD'))
                            AND embedding IS NOT NULL
                            AND LENGTH(content) >= 50
                            {scope_sql}
                            {temporal_sql}
                    )
                    SELECT
                        id, session_id, content, metadata, created_at,
                        valid_from, valid_until,
                        similarity, recency, decay_weight,
                        ((1.0 - $3::float) * similarity + $3::float * recency) as combined_score
                    FROM scored
                    ORDER BY (((1.0 - $3::float) * similarity + $3::float * recency) * decay_weight) DESC
                    LIMIT $2
                    """,
                    str(query_embedding),
                    k,
                    recency_weight,
                    *scope_params,
                    *temporal_params,
                )
            else:
                # Scope params start at $3 (after embedding=$1, k=$2)
                scope_clause, scope_params, next_idx = _build_scope_clause(scope_mode, project_id, 3)
                scope_sql = f" AND {scope_clause}" if scope_clause else ""
                temporal_clause, temporal_params, _ = _build_temporal_clause(
                    valid_at, include_superseded, next_idx,
                )
                temporal_sql = f" AND {temporal_clause}" if temporal_clause else ""
                rows = await conn.fetch(
                    f"""
                    SELECT
                        id,
                        session_id,
                        content,
                        metadata,
                        created_at,
                        valid_from,
                        valid_until,
                        1 - (embedding <=> $1::vector) as similarity,
                        {decay_expr} as decay_weight
                    FROM archival_memory
                    WHERE (metadata->>'type' IS NULL OR metadata->>'type' IN (
                        'session_learning', 'WORKING_SOLUTION', 'ERROR_FIX',
                        'ARCHITECTURAL_DECISION', 'CODEBASE_PATTERN', 'FAILED_APPROACH',
                        'USER_PREFERENCE', 'OPEN_THREAD'))
                        AND embedding IS NOT NULL
                        AND LENGTH(content) >= 50
                        {scope_sql}
                        {temporal_sql}
                    ORDER BY ((1 - (embedding <=> $1::vector)) * {decay_expr}) DESC
                    LIMIT $2
                    """,
                    str(query_embedding),
                    k,
                    *scope_params,
                    *temporal_params,
                )
    elif text_fallback:
        # Fallback to text search (ILIKE) when no embeddings
        # Scope params start at $3 (after query=$1, k=$2)
        scope_clause, scope_params, next_idx = _build_scope_clause(scope_mode, project_id, 3)
        scope_sql = f" AND {scope_clause}" if scope_clause else ""
        temporal_clause, temporal_params, _ = _build_temporal_clause(
            valid_at, include_superseded, next_idx,
        )
        temporal_sql = f" AND {temporal_clause}" if temporal_clause else ""
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                f"""
                SELECT
                    id,
                    session_id,
                    content,
                    metadata,
                    created_at,
                    valid_from,
                    valid_until,
                    0.5 as similarity,
                    {decay_expr} as decay_weight
                FROM archival_memory
                WHERE (metadata->>'type' IS NULL OR metadata->>'type' IN (
                    'session_learning', 'WORKING_SOLUTION', 'ERROR_FIX',
                    'ARCHITECTURAL_DECISION', 'CODEBASE_PATTERN', 'FAILED_APPROACH',
                    'USER_PREFERENCE', 'OPEN_THREAD'))
                    AND content ILIKE '%' || $1 || '%'
                    AND LENGTH(content) >= 50
                    {scope_sql}
                    {temporal_sql}
                ORDER BY (0.5 * {decay_expr}) DESC, created_at DESC
                LIMIT $2
                """,
                query,
                k,
                *scope_params,
                *temporal_params,
            )
    else:
        return []

    results = []
    for row in rows:
        row_dict = dict(row)  # Convert Record to dict for easier access

        # base_score: pre-decay score (combined_score wins over similarity
        # when recency_weight was applied).
        if "combined_score" in row_dict and row_dict["combined_score"] is not None:
            base = float(row_dict["combined_score"])
        else:
            base = float(row_dict["similarity"]) if row_dict["similarity"] is not None else 0.0

        # Skip results below threshold (threshold is on base_score, not
        # decay-adjusted score -- threshold gates ranking quality, not freshness)
        if similarity_threshold > 0 and base < similarity_threshold:
            continue

        weight = (
            float(row_dict["decay_weight"])
            if row_dict.get("decay_weight") is not None
            else 1.0
        )

        # Compute age_days for audit / JSON output.
        created = row_dict.get("created_at")
        age_seconds = 0.0
        if isinstance(created, datetime):
            now = datetime.now(timezone.utc)
            created_tz = created if created.tzinfo else created.replace(tzinfo=timezone.utc)
            age_seconds = max(0.0, (now - created_tz).total_seconds())

        metadata = row_dict["metadata"]
        if isinstance(metadata, str):
            metadata = json.loads(metadata)

        result = {
            "id": str(row_dict["id"]),
            "session_id": row_dict["session_id"],
            "content": row_dict["content"],
            "metadata": metadata,
            "created_at": row_dict["created_at"],
            "valid_from": row_dict.get("valid_from"),
            "valid_until": row_dict.get("valid_until"),
            "base_score": base,
            "decay_weight": weight,
            "final_score": base * weight,
            "age_days": int(age_seconds / 86400.0),
            "similarity": base * weight,  # Back-compat alias
        }

        # Include raw similarity and recency if available
        if "recency" in row_dict:
            result["raw_similarity"] = (
                float(row_dict["similarity"]) if row_dict["similarity"] else 0.0
            )
            result["recency"] = (
                float(row_dict["recency"]) if row_dict["recency"] else 0.0
            )

        results.append(result)

    # Re-sort by final_score because SQL already did so, but recency_weight +
    # decay interactions may shift ordering for tied rows. Safe to call.
    results.sort(key=lambda x: x.get("final_score", 0.0), reverse=True)
    return results


async def search_learnings(
    query: str,
    k: int = 5,
    provider: str = "local",
    text_fallback: bool = True,
    similarity_threshold: float = 0.2,
    recency_weight: float = 0.0,
    project_id: str | None = None,
    scope_mode: str | None = None,
    valid_at: datetime | None = None,
    include_superseded: bool = False,
    decay_lambda: float = DEFAULT_DECAY_LAMBDA,
    embed_meta_out: dict[str, Any] | None = None,
    query_vector: list[float] | None = None,
) -> list[dict[str, Any]]:
    """Search archival_memory for session learnings.

    Automatically selects SQLite (BM25) or PostgreSQL (vector) based on environment.

    Args:
        query: Search query for semantic matching
        k: Number of results to return
        provider: Embedding provider ("local" or "voyage") - PostgreSQL only
        text_fallback: If True, use text search when no embeddings exist
        similarity_threshold: Minimum similarity score (default 0.2 filters garbage)
        recency_weight: Weight for recency boost (0.0-1.0). 0=no boost, 0.3=30% recency
        project_id: Project hash (16-char sha256). Auto-derived when None.
        scope_mode: 'project' | 'global_only' | 'all'. Auto-resolved when None.
        valid_at: Optional point-in-time bi-temporal filter.
        include_superseded: When True, do not filter out superseded rows.
        decay_lambda: Exponential decay per day (default 0.02, half-life ~35d).

    Returns:
        List of matching learnings with similarity scores
    """
    if not query.strip():
        return []

    backend = get_backend()

    if backend == "sqlite":
        # SQLite path doesn't support temporal/decay in SQL; apply decay in
        # Python after the BM25 search. SQLite doesn't have the valid_from /
        # valid_until columns, so temporal filtering is a no-op there.
        results = await search_learnings_sqlite(query, k)
        if decay_lambda > 0:
            _apply_decay(results, decay_lambda, score_key="similarity")
        return results
    else:
        return await search_learnings_postgres(
            query, k, provider, text_fallback,
            similarity_threshold, recency_weight,
            project_id=project_id, scope_mode=scope_mode,
            valid_at=valid_at,
            include_superseded=include_superseded,
            decay_lambda=decay_lambda,
            embed_meta_out=embed_meta_out,
            query_vector=query_vector,
        )


async def search_pageindex(query: str, k: int = 5, project_path: str | None = None) -> list[dict[str, Any]]:
    """Search PageIndex trees using LLM-based reasoning.

    Args:
        query: Search query
        k: Max results per document
        project_path: Optional project path (defaults to cwd)

    Returns:
        List of search results with document context
    """
    try:
        from scripts.pageindex.pageindex_service import PageIndexService
        from scripts.pageindex.tree_search import tree_search, SearchResult
    except ImportError as e:
        print(f"PageIndex not available: {e}", file=sys.stderr)
        return []

    project = project_path or os.getcwd()
    service = PageIndexService()

    try:
        trees = service.list_trees(project_path=project)
        if not trees:
            return []

        all_results = []
        for tree_meta in trees:
            tree_index = service.get_tree(project, tree_meta.doc_path)
            if not tree_index:
                continue

            search_results = tree_search(
                query=query,
                tree_structure=tree_index.tree_structure,
                doc_name=tree_meta.doc_path,
                max_results=k,
                model="sonnet"
            )

            for result in search_results:
                all_results.append({
                    "source": "pageindex",
                    "doc_path": tree_meta.doc_path,
                    "node_id": result.node_id,
                    "title": result.title,
                    "content": result.text,
                    "line_num": result.line_num,
                    "relevance_reason": result.relevance_reason,
                    "similarity": result.confidence,
                    "session_id": f"pageindex:{tree_meta.doc_path}",
                    "created_at": tree_index.updated_at,
                })

        all_results.sort(key=lambda x: x["similarity"], reverse=True)
        return all_results[:k * 2]

    finally:
        service.close()


# Phase 2 (Task 1.3): Stage-2 rerank integration.
#
# When --rerank is set on the hybrid path, we ask the search function for a
# larger candidate pool (up to RERANK_CANDIDATE_POOL), pass those candidates
# through the cross-encoder reranker, and return the top-K.
#
# The reranker lives in opc/scripts/core/rerank.py. We prefer talking to the
# long-lived daemon (TCP loopback, $TEMP/ccv3-rerank.json discovery file) when
# available, and fall back to spawning a subprocess one-shot when not.
RERANK_CANDIDATE_POOL = 50


def _serialize_candidate_for_rerank(cand: dict[str, Any]) -> dict[str, Any]:
    """Strip a candidate dict to JSON-serialisable fields for the reranker.

    The reranker only needs ``id``, ``content``, and ``base_score`` (the
    last is a passthrough audit field). All other keys (metadata, datetime
    columns, session_id, valid_from, etc.) are kept on the original
    candidate and re-attached after rerank by matching on ``id``.
    """
    return {
        "id": str(cand.get("id", "")),
        "content": cand.get("content", "") or "",
        "base_score": cand.get(
            "base_score", cand.get("final_score", cand.get("similarity", 0.0)),
        ),
    }


def _apply_rerank(
    query: str,
    candidates: list[dict[str, Any]],
    top_k: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Run Stage-2 rerank on candidates, return (top_k_results, meta).

    Strategy:
        1. If $TEMP/ccv3-rerank.json exists AND the PID is alive, try TCP
           daemon mode.
        2. Otherwise, spawn ``rerank.py --candidates-from-stdin`` as a
           subprocess (cold path: model load ~50s on Windows CPU).
        3. On any failure, return the original RRF top-K unchanged with
           ``meta["rerank_status"] == "failed"`` and the error.

    The returned candidates carry an added ``rerank_score`` field; the
    original ``id`` -> candidate mapping is used to re-hydrate metadata
    columns (since the reranker only sees id/content/base_score).
    """
    if not candidates:
        return [], {"rerank_status": "skipped", "reason": "no_candidates"}

    # Map id -> original candidate so we can rehydrate after rerank.
    by_id: dict[str, dict[str, Any]] = {str(c.get("id", "")): c for c in candidates}
    slim = [_serialize_candidate_for_rerank(c) for c in candidates]

    # Lazy import: rerank.py imports torch/sentence-transformers, which we
    # want to defer until --rerank is actually used.
    # Import via `from core import rerank` -- recall_learnings inserts
    # ``opc/scripts/`` onto sys.path at module load, which makes ``core`` a
    # package (siblings to ``db``, ``pageindex``, etc.).
    from core import rerank as _rerank  # type: ignore

    t0 = time.perf_counter()
    daemon_used = False
    elapsed_remote_ms: float | None = None
    try:
        resp = _rerank.rerank_via_daemon(
            query=query,
            candidates=slim,
            top_k=top_k,
        )
        if resp is not None and "results" in resp:
            daemon_used = True
            slim_results = resp["results"]
            elapsed_remote_ms = float(resp.get("elapsed_ms", 0.0))
        else:
            slim_results = None
    except Exception as exc:  # noqa: BLE001
        print(f"[recall] rerank daemon error: {exc}", file=sys.stderr)
        slim_results = None

    if slim_results is None:
        # Fallback: subprocess one-shot.
        try:
            import subprocess
            rerank_path = Path(__file__).resolve().parent / "rerank.py"
            payload = "\n".join(json.dumps(s, default=str) for s in slim) + "\n"
            proc = subprocess.run(  # noqa: S603
                [sys.executable, str(rerank_path),
                 "--query", query,
                 "--candidates-from-stdin",
                 "--top-k", str(top_k)],
                input=payload,
                capture_output=True,
                text=True,
                check=False,
                timeout=180,  # cold load can take ~50s; give headroom
            )
            if proc.returncode != 0:
                return candidates[:top_k], {
                    "rerank_status": "failed",
                    "reason": "subprocess_nonzero",
                    "stderr_tail": (proc.stderr or "")[-400:],
                }
            slim_results = []
            for line in (proc.stdout or "").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    slim_results.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        except Exception as exc:  # noqa: BLE001
            return candidates[:top_k], {
                "rerank_status": "failed",
                "reason": "subprocess_error",
                "error": str(exc),
            }

    elapsed_total_ms = (time.perf_counter() - t0) * 1000

    # Rehydrate full candidate rows by id, preserving rerank_score.
    hydrated: list[dict[str, Any]] = []
    for slim_row in slim_results or []:
        cid = str(slim_row.get("id", ""))
        full = by_id.get(cid)
        if full is None:
            continue
        # Attach rerank_score onto the original candidate dict.
        # rerank.rerank() mutates its input dicts in place (sets rerank_score
        # on each slim row). The by_id map above holds references to those
        # same dicts, so we can read rerank_score from slim_row and write
        # it onto the full candidate. Single-threaded use only. (Phase 2 MEDIUM-3)
        full["rerank_score"] = float(slim_row.get("rerank_score", 0.0))
        hydrated.append(full)

    meta = {
        "rerank_status": "ok",
        "rerank_used_daemon": daemon_used,
        "rerank_total_ms": elapsed_total_ms,
        "rerank_remote_ms": elapsed_remote_ms,
        "rerank_candidate_pool": len(candidates),
        "rerank_top_k": top_k,
        "rerank_model": "BAAI/bge-reranker-v2-m3",
    }
    return hydrated, meta


def _serialize_results_json(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Serialize recall results to the ``--json`` wire shape.

    Single source of truth for the JSON result-entry shape, shared by the
    ``--json`` CLI serializer in ``main()`` and the ST-05 daemon ``do_recall``
    path so the two can never drift (premortem R7/H1 parity). Mirrors the
    archival_memory recall contract::

        {id, score, base_score, decay_weight, final_score, age_days,
         session_id, content, created_at, rerank_score?, valid_from?, valid_until?}

    ``rerank_score`` / ``valid_from`` / ``valid_until`` are included only when
    present on the source row, exactly as the CLI path does.
    """
    json_results: list[dict[str, Any]] = []
    for result in results:
        created_at = result["created_at"]
        if isinstance(created_at, datetime):
            created_str = created_at.isoformat()
        else:
            created_str = str(created_at)

        entry: dict[str, Any] = {
            "id": result.get("id"),
            "score": result["similarity"],
            "base_score": result.get("base_score"),
            "decay_weight": result.get("decay_weight"),
            "final_score": result.get("final_score", result["similarity"]),
            "age_days": result.get("age_days"),
            "session_id": result["session_id"],
            "content": result["content"],
            "created_at": created_str,
        }

        # Phase 2 (Task 1.3): surface the cross-encoder score when rerank ran.
        if "rerank_score" in result:
            entry["rerank_score"] = result["rerank_score"]

        # Include temporal fields when available (postgres-only).
        valid_from = result.get("valid_from")
        valid_until = result.get("valid_until")
        if isinstance(valid_from, datetime):
            entry["valid_from"] = valid_from.isoformat()
        elif valid_from is not None:
            entry["valid_from"] = str(valid_from)
        if isinstance(valid_until, datetime):
            entry["valid_until"] = valid_until.isoformat()
        elif valid_until is not None:
            entry["valid_until"] = str(valid_until)

        json_results.append(entry)
    return json_results


async def _recycle_pool_best_effort() -> None:
    """Discard all idle pooled connections so the next acquire reconnects fresh.

    Used by ``do_recall``'s H3 retry to recover IMMEDIATELY from a Postgres
    restart (which leaves every pooled connection dead at once) instead of
    healing gradually over several calls. Dual-import for the script-vs-pytest
    context (the ST-05 import-context lesson). Best-effort: any failure here is
    swallowed so the hardening can never break the retry path itself. Exposed as
    a module-level seam so tests can assert it is called between retry attempts.
    """
    try:
        try:
            from db.postgres_pool import get_pool  # script ctx (live daemon)
        except ModuleNotFoundError:
            from core.db.postgres_pool import get_pool  # package ctx (pytest)
        await (await get_pool()).expire_connections()
    except Exception:
        pass


async def do_recall(
    query_vector: list[float],
    query_text: str,
    k: int = 5,
    mode: str = "hybrid",
    *,
    project_id: str | None = None,
    scope_mode: str | None = None,
) -> dict[str, Any]:
    """Daemon-facing recall (ST-05). Reuses the same search functions + JSON
    serializer the CLI uses, so results are identical to ``recall_learnings.py
    --json`` for the same query/k AND the same scope.

    The query is embedded by the CALLER (the resident BGE daemon, with its own
    pinned model) and the precomputed ``query_vector`` is threaded into the
    pgvector leg; ``query_text`` drives the FTS leg (H4 — hybrid must NOT
    silently degrade to vector-only). This avoids a second ``EmbeddingService``
    load inside the daemon (the 30-45s cold-load trap, premortem R5).

    SCOPE PARITY (cross-project correctness — ST-05 review fix):
        Project-scoped recall depends on ``resolve_recall_scope``, which keys
        off the *current working directory*. The resident daemon's CWD is its
        LAUNCH directory (e.g. repoRoot), which is NOT where the uv fallback
        runs: ``memory-awareness.checkDbMemory`` invokes ``recall_learnings.py``
        with ``cwd=<opc>`` and no ``--project-dir``. If do_recall used the
        daemon's ambient CWD it would derive a DIFFERENT ``project_id`` and
        silently return a different PROJECT-scoped result set than its own
        fallback (a real, deterministic ranking divergence — root-caused via
        a project-scope diff with an identical query vector).

        So when the caller does not forward an explicit scope, do_recall
        resolves scope from the OPC dir (``__file__.parents[2]``) — the same
        fixed location the uv path uses as its CWD — NOT the ambient daemon
        CWD. A caller (the TS ``recallViaDaemon`` client) MAY forward the fully
        resolved ``project_id`` + ``scope_mode`` to pin per-project scope
        exactly; when BOTH are provided they are used verbatim (no
        ``resolve_recall_scope`` call, no env/CWD dependence).

    Returns the SAME dict the ``--json`` serializer builds, plus a recall
    ``_meta`` block::

        {"results": [ ...--json entries... ],
         "_meta": {"vector_count", "fts_count", "threshold_drops",
                   "scope_mode", "project_id", "db_error"?}}

    The daemon handler adds ``model`` + ``dim`` to ``_meta`` (H6) and wraps the
    payload with ``ok`` / ``elapsed_ms``. This function never adds an ``ok``
    field; it returns a completed result or RAISES (the daemon handler maps any
    exception to ``ok:false`` — H1).

    Args:
        query_vector: Precomputed 1024-dim query embedding from the resident
            model. Required (and must be non-zero) for ``hybrid`` / ``vector``.
        query_text: Original query text. Required (non-empty) for ``hybrid`` /
            ``text`` (the FTS leg).
        k: Number of results.
        mode: ``"hybrid"`` (default), ``"vector"`` or ``"text"``.
        project_id: Caller-forwarded project hash. When BOTH this and
            ``scope_mode`` are given, scope is used verbatim (TS client path).
        scope_mode: Caller-forwarded scope ('project' | 'global_only' | 'all').

    Raises:
        ValueError: invalid inputs (H4 / zero-vector rejection).
        Exception: a non-recoverable DB error after one retry (H3); propagated
            so the daemon handler returns ``ok:false`` rather than empty
            results (H1).
    """
    import asyncpg  # lazy: only needed when the daemon path is exercised

    if not isinstance(k, int) or k <= 0:
        k = 5
    if mode not in ("hybrid", "vector", "text"):
        mode = "hybrid"

    # H4 + zero-vector rejection: both legs must have valid inputs.
    if mode in ("hybrid", "vector"):
        if not query_vector or not any(query_vector):
            raise ValueError("do_recall: query_vector required and must be non-zero")
    if mode in ("hybrid", "text"):
        if not query_text or not query_text.strip():
            raise ValueError("do_recall: query_text required for the FTS leg")

    # Scope resolution (see SCOPE PARITY in the docstring).
    if project_id is not None and scope_mode is not None:
        # Caller forwarded the resolved scope — honor it verbatim.
        pass
    else:
        # Resolve from the OPC dir (NOT the ambient daemon CWD) so the daemon
        # recall scopes IDENTICALLY to the uv fallback (which runs with
        # cwd=<opc>). resolve_recall_scope still honors a CLAUDE_PROJECT_ID env
        # override first, matching a uv call from the same environment.
        opc_dir = str(Path(__file__).resolve().parents[2])
        project_id, scope_mode = resolve_recall_scope(project_dir=opc_dir)
    stats: dict[str, Any] = {}

    async def _run() -> list[dict[str, Any]]:
        if mode == "text":
            return await search_learnings_text_only_postgres(
                query_text, k,
                project_id=project_id, scope_mode=scope_mode,
            )
        if mode == "vector":
            # Mirror the CLI ``--vector-only`` defaults (threshold 0.2,
            # recency 0.1) but skip the embed via the query_vector seam.
            return await search_learnings(
                query=query_text, k=k,
                similarity_threshold=0.2,
                recency_weight=0.1,
                project_id=project_id, scope_mode=scope_mode,
                query_vector=query_vector,
            )
        # hybrid (default): mirror the CLI default ``--json`` hybrid path,
        # whose threshold is ``args.threshold(0.2) * 0.01`` (RRF scores are
        # in the ~0.01-0.03 range).
        return await search_learnings_hybrid_rrf(
            query=query_text, k=k,
            similarity_threshold=0.2 * 0.01,
            project_id=project_id, scope_mode=scope_mode,
            query_vector=query_vector,
            stats_out=stats,
        )

    # H3: a stale/closed pooled connection (Postgres server-side idle close)
    # surfaces as one of these on first use. asyncpg discards the broken
    # connection when it is released back to the pool, so a second acquire
    # returns a fresh one — retry exactly once. A second failure propagates
    # (the daemon handler maps it to ok:false, never a silent empty list).
    retryable = (
        asyncpg.exceptions.ConnectionDoesNotExistError,
        asyncpg.exceptions.InterfaceError,
        asyncpg.exceptions.PostgresConnectionError,
        ConnectionResetError,
    )
    db_error: str | None = None
    try:
        results = await _run()
    except retryable as exc:
        db_error = f"retry_after:{type(exc).__name__}"
        stats.clear()
        # H3 hardening: a Postgres restart / network drop can leave EVERY pooled
        # connection dead at once, so a plain re-acquire may return another
        # broken one. Recycle idle pooled connections before the single retry so
        # it reconnects fresh (immediate recovery instead of gradual self-heal
        # over several calls). Best-effort helper — never breaks the retry path.
        await _recycle_pool_best_effort()
        results = await _run()

    meta: dict[str, Any] = {
        "vector_count": stats.get("vector_count", 0),
        "fts_count": stats.get("fts_count", 0),
        "threshold_drops": stats.get("threshold_drops", 0),
        # Observable scope so a caller can confirm the daemon recall scoped the
        # same way as the uv fallback (cross-project parity check).
        "scope_mode": scope_mode,
        "project_id": project_id,
    }
    if db_error is not None:
        meta["db_error"] = db_error
    return {"results": _serialize_results_json(results), "_meta": meta}


async def main() -> int:
    """Run semantic recall on session learnings."""
    parser = argparse.ArgumentParser(
        description="Semantic recall of session learnings from archival_memory",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--query",
        "-q",
        required=True,
        help="Search query for semantic matching",
    )
    parser.add_argument(
        "--k",
        type=int,
        default=5,
        help="Number of results to return (default: 5)",
    )
    parser.add_argument(
        "--provider",
        choices=["local", "voyage"],
        default="local",
        help="Embedding provider (default: local)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output results as JSON (for programmatic use)",
    )
    parser.add_argument(
        "--text-only",
        action="store_true",
        help="Use text search only (faster, no embeddings)",
    )
    parser.add_argument(
        "--threshold",
        "-t",
        type=float,
        default=0.2,
        help="Minimum similarity threshold (default: 0.2, filters low-quality results)",
    )
    parser.add_argument(
        "--vector-only",
        action="store_true",
        help="Use vector-only search (disables hybrid RRF, enables recency)",
    )
    parser.add_argument(
        "--recency",
        "-r",
        type=float,
        default=0.1,
        help="Recency weight for vector-only mode (0.0-1.0, default: 0.1)",
    )
    parser.add_argument(
        "--pageindex",
        action="store_true",
        help="Use PageIndex tree-based search for large documents (ROADMAP, docs)",
    )
    parser.add_argument(
        "--hybrid",
        action="store_true",
        help="Search both vector memory AND PageIndex trees",
    )
    parser.add_argument(
        "--project-dir",
        default=None,
        help=(
            "Project directory to scope recall to. When passed, derive "
            "project_id = sha256(abs_path)[:16] and filter PROJECT-scoped "
            "results to that project. Defaults to CWD when CWD is inside a "
            "registered project; falls back to GLOBAL-only otherwise."
        ),
    )
    parser.add_argument(
        "--all-projects",
        action="store_true",
        help=(
            "DEBUG/AUDIT: drop the project_id filter entirely. By default, "
            "recall is scoped to the current project (or GLOBAL-only when "
            "context is unclear). Use this opt-out only when you need to "
            "see learnings across projects."
        ),
    )
    # Phase 1.10 (memory hardening v2): temporal-aware retrieval flags.
    parser.add_argument(
        "--valid-at",
        default=None,
        help=(
            "ISO 8601 timestamp for point-in-time recall. When set, returns "
            "entries that existed at that moment (valid_from <= ts AND "
            "(valid_until IS NULL OR valid_until > ts)). Default behaviour "
            "without this flag is to filter out only currently-superseded "
            "entries."
        ),
    )
    parser.add_argument(
        "--include-superseded",
        action="store_true",
        help=(
            "Include entries whose valid_until has passed (i.e., learnings "
            "replaced by newer versions). Off by default."
        ),
    )
    parser.add_argument(
        "--no-decay",
        action="store_true",
        help=(
            "Disable exponential decay weighting. Equivalent to "
            "--decay-lambda 0."
        ),
    )
    parser.add_argument(
        "--decay-lambda",
        type=float,
        default=DEFAULT_DECAY_LAMBDA,
        help=(
            "Per-day exponential decay constant for score weighting. "
            f"Default {DEFAULT_DECAY_LAMBDA} -> half-life ~35 days. "
            "Set to 0 to disable."
        ),
    )
    # Phase 2 (Task 1.3): Stage-2 cross-encoder reranker. Hybrid RRF path only.
    # Default off until the Task 3.2 decision gate flips it.
    parser.add_argument(
        "--rerank",
        action="store_true",
        help=(
            "Apply Stage-2 cross-encoder rerank (BAAI/bge-reranker-v2-m3) over the "
            "top-50 hybrid-RRF candidates and return the top-K. No-op for "
            "--text-only / --vector-only modes (warning to stderr)."
        ),
    )

    args = parser.parse_args()

    # Phase 1 (cross-project isolation): resolve scope once, pass to all paths.
    project_id, scope_mode = resolve_recall_scope(
        project_dir=args.project_dir,
        all_projects=args.all_projects,
    )

    # Phase 1.10: resolve temporal/decay flags.
    valid_at: datetime | None = None
    if args.valid_at:
        try:
            # Accept both `2026-01-15T00:00:00Z` and `2026-01-15T00:00:00+00:00`.
            ts_str = args.valid_at.replace("Z", "+00:00")
            valid_at = datetime.fromisoformat(ts_str)
            # Coerce to UTC-aware so the SQL comparison is unambiguous.
            if valid_at.tzinfo is None:
                valid_at = valid_at.replace(tzinfo=timezone.utc)
        except ValueError as exc:
            print(
                f"Error: --valid-at must be ISO 8601 (e.g. 2026-01-15T00:00:00Z). "
                f"Got: {args.valid_at!r} ({exc})",
                file=sys.stderr,
            )
            return 2
    decay_lambda = 0.0 if args.no_decay else max(0.0, args.decay_lambda)

    # JSON mode: suppress human-readable output
    backend = get_backend()

    # Phase 2 (Task 1.3): --rerank only applies to the hybrid-RRF default path.
    # For other modes (text-only, vector-only, pageindex, sqlite, --hybrid w/
    # pageindex blend) we no-op with a stderr warning. The decision gate at
    # Task 3.2 will decide whether to flip the default.
    apply_rerank = False
    rerank_meta: dict[str, Any] = {}
    # Task 1.4: capture embedding-path diagnostics so JSON output can
    # surface whether the query embed went through the daemon. Populated
    # by _embed_query_with_daemon; merged into the _meta block below.
    embed_meta: dict[str, Any] = {}
    if args.rerank:
        # The hybrid-RRF default is "no --text-only, no --vector-only, no
        # --pageindex, postgres backend, and not the --hybrid PageIndex
        # blend". The --hybrid flag fans out PageIndex alongside vector,
        # which we don't rerank (Stage-2 rerank is for the vector recall
        # path; PageIndex already does LLM reasoning).
        if (backend != "postgres"
                or args.text_only
                or args.vector_only
                or args.pageindex
                or args.hybrid):
            print(
                "[recall] --rerank is hybrid-RRF only; skipping for "
                f"backend={backend!r} text_only={args.text_only} "
                f"vector_only={args.vector_only} pageindex={args.pageindex} "
                f"hybrid={args.hybrid}",
                file=sys.stderr,
            )
        else:
            apply_rerank = True

    if not args.json:
        print(f'Recalling learnings for: "{args.query}"')
        if args.pageindex:
            print("Search mode: PageIndex (tree-based)")
        elif args.hybrid:
            print(f"Search mode: Hybrid (vector + PageIndex)")
            print(f"Backend: {backend}")
        else:
            print(f"Backend: {backend}")
            print(f"Embedding provider: {args.provider}")
            if apply_rerank:
                print("Rerank: Stage-2 cross-encoder (bge-reranker-v2-m3)")
        print()

    try:
        # Phase B2: thread --project-dir through to PageIndex so its tree
        # discovery uses the caller's project rather than os.getcwd(). When
        # recall is invoked from inside one project but with --project-dir
        # pointed elsewhere (or from a hook running in a non-project CWD),
        # the previous default silently searched whatever PageIndex trees
        # happened to live next to the working directory.
        # PageIndex-only search
        if args.pageindex:
            results = await search_pageindex(
                args.query, args.k, project_path=args.project_dir
            )
        # Hybrid search: combine vector memory + PageIndex
        elif args.hybrid:
            vector_results = []
            pageindex_results = await search_pageindex(
                args.query, args.k, project_path=args.project_dir
            )

            if backend == "sqlite":
                vector_results = await search_learnings_sqlite(args.query, args.k)
                if decay_lambda > 0:
                    _apply_decay(vector_results, decay_lambda, score_key="similarity")
            elif args.text_only:
                vector_results = await search_learnings_text_only_postgres(
                    args.query, args.k,
                    project_id=project_id, scope_mode=scope_mode,
                    valid_at=valid_at,
                    include_superseded=args.include_superseded,
                    decay_lambda=decay_lambda,
                )
            else:
                vector_results = await search_learnings_hybrid_rrf(
                    query=args.query,
                    k=args.k,
                    provider=args.provider,
                    similarity_threshold=args.threshold * 0.01,
                    project_id=project_id, scope_mode=scope_mode,
                    valid_at=valid_at,
                    include_superseded=args.include_superseded,
                    decay_lambda=decay_lambda,
                    embed_meta_out=embed_meta,
                )

            for r in vector_results:
                r["source"] = "vector"
            for r in pageindex_results:
                r["source"] = "pageindex"

            results = vector_results + pageindex_results
            results.sort(key=lambda x: x.get("similarity", 0), reverse=True)
            results = results[:args.k * 2]

        elif backend == "sqlite":
            # SQLite only supports text search (no pgvector)
            if not args.text_only and not args.json:
                print("  (SQLite backend - using text search)")
            results = await search_learnings_sqlite(args.query, args.k)
            # SQLite has no valid_from / valid_until columns, so the
            # --valid-at / --include-superseded flags are no-ops here. Decay
            # is still applied in Python.
            if decay_lambda > 0:
                _apply_decay(results, decay_lambda, score_key="similarity")
        elif args.text_only:
            # Fast text-only search (no embeddings)
            results = await search_learnings_text_only_postgres(
                args.query, args.k,
                project_id=project_id, scope_mode=scope_mode,
                valid_at=valid_at,
                include_superseded=args.include_superseded,
                decay_lambda=decay_lambda,
            )
        elif args.vector_only:
            # Vector-only search with recency boost
            results = await search_learnings(
                query=args.query,
                k=args.k,
                provider=args.provider,
                similarity_threshold=args.threshold,
                recency_weight=args.recency,
                project_id=project_id, scope_mode=scope_mode,
                valid_at=valid_at,
                include_superseded=args.include_superseded,
                decay_lambda=decay_lambda,
                embed_meta_out=embed_meta,
            )
        else:
            # Default: Hybrid RRF search (text + vector combined).
            # When --rerank is set, ask the RRF for a wider candidate pool
            # (top-50 by default) so the cross-encoder has more to choose from.
            fetch_k = max(args.k, RERANK_CANDIDATE_POOL) if apply_rerank else args.k
            results = await search_learnings_hybrid_rrf(
                query=args.query,
                k=fetch_k,
                provider=args.provider,
                similarity_threshold=args.threshold * 0.01,  # RRF scores are ~0.01-0.03 range
                project_id=project_id, scope_mode=scope_mode,
                valid_at=valid_at,
                include_superseded=args.include_superseded,
                decay_lambda=decay_lambda,
                embed_meta_out=embed_meta,
            )

            # Phase 2 (Task 1.3): Stage-2 cross-encoder rerank over the
            # candidate pool, return top-K. Failure mode: keep RRF results
            # untouched, attach rerank_status='failed' to the meta block.
            if apply_rerank and len(results) > args.k:
                pre_rerank_count = len(results)
                results, rerank_meta = _apply_rerank(
                    query=args.query,
                    candidates=results,
                    top_k=args.k,
                )
                rerank_meta["rerank_pre_count"] = pre_rerank_count
            elif apply_rerank:
                # Fewer candidates than top-K -- nothing to rerank meaningfully.
                rerank_meta = {
                    "rerank_status": "skipped",
                    "reason": "candidate_pool_smaller_than_top_k",
                    "rerank_candidate_pool": len(results),
                    "rerank_top_k": args.k,
                }
    except Exception as e:
        if args.json:
            print(json.dumps({"error": str(e), "results": []}))
        else:
            print(f"Error: {e}", file=sys.stderr)
        return 1

    # JSON output mode
    if args.json:
        # ST-05: the per-entry shape is now produced by the shared
        # _serialize_results_json helper (single source of truth, also used by
        # the daemon do_recall path) so the two cannot drift.
        json_results = _serialize_results_json(results)
        # Phase 2 (Task 1.3): include _meta block carrying rerank diagnostics
        # when --rerank was used. Task 1.4: also surface embedding-path
        # diagnostics (embed_used_daemon, embed_elapsed_ms) when the path
        # touched the vector index. Kept absent when no diagnostics were
        # collected so callers that parse the JSON aren't surprised.
        out_doc: dict[str, Any] = {"results": json_results}
        combined_meta: dict[str, Any] = {}
        if rerank_meta:
            combined_meta.update(rerank_meta)
        if embed_meta:
            combined_meta.update(embed_meta)
        if combined_meta:
            out_doc["_meta"] = combined_meta
        print(json.dumps(out_doc))
        return 0

    # Human-readable output
    if not results:
        print("No matching learnings found.")
        return 0

    print(f"Found {len(results)} matching learnings:")
    if rerank_meta and rerank_meta.get("rerank_status") == "ok":
        total_ms = rerank_meta.get("rerank_total_ms")
        used_daemon = rerank_meta.get("rerank_used_daemon")
        if total_ms is not None:
            print(
                f"  (reranked from {rerank_meta.get('rerank_pre_count', '?')} via "
                f"{'daemon' if used_daemon else 'subprocess'} in "
                f"{total_ms:.0f}ms)"
            )
    elif rerank_meta and rerank_meta.get("rerank_status") == "failed":
        print(f"  (rerank failed: {rerank_meta.get('reason')})")
    # Task 1.4: surface embedding-daemon usage when the vector path ran.
    if embed_meta and "embed_used_daemon" in embed_meta:
        em_used = embed_meta.get("embed_used_daemon")
        em_ms = embed_meta.get("embed_elapsed_ms")
        if em_ms is not None:
            print(
                f"  (embedded via {'daemon' if em_used else 'in-process'} "
                f"in {em_ms:.0f}ms)"
            )
    print()

    for i, result in enumerate(results, 1):
        similarity = result["similarity"]
        content_preview = format_result_preview(result["content"], max_length=300)
        session_id = result["session_id"]
        created_at = result["created_at"]

        # Format timestamp
        if isinstance(created_at, datetime):
            created_str = created_at.strftime("%Y-%m-%d %H:%M")
        else:
            created_str = str(created_at)[:16]

        source = result.get("source", "vector")
        if source == "pageindex":
            doc_path = result.get("doc_path", "unknown")
            title = result.get("title", "")
            line_num = result.get("line_num")
            reason = result.get("relevance_reason", "")
            loc = f":{line_num}" if line_num else ""
            print(f"{i}. [{similarity:.0%}] 📄 {doc_path}{loc}")
            print(f"   Section: {title}")
            if reason:
                print(f"   Why: {reason}")
            print(f"   {content_preview}")
        else:
            rerank_suffix = ""
            if "rerank_score" in result:
                rerank_suffix = f" rerank={result['rerank_score']:.3f}"
            print(f"{i}. [{similarity:.3f}{rerank_suffix}] Session: {session_id} ({created_str})")
            print(f"   {content_preview}")
        print()

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
