#!/usr/bin/env python3
"""Mark an archival_memory entry as superseded by newer content.

Phase 1.10 of the memory hardening v2 plan. The `archival_memory` table has
`valid_from` / `valid_until` columns. Setting `valid_until = NOW()` flags an
entry as no longer current; default recall (`recall_learnings.py`) excludes
those rows unless the caller passes `--include-superseded`.

This script performs a two-step transaction:
  1. UPDATE archival_memory SET valid_until = NOW() WHERE id = <old_id>
     - Errors if the row is already superseded (idempotency safety net)
  2. INSERT a new row with content, embedding, and metadata that records
     `supersedes: <old_id>` and optional `supersede_reason`.

The old row stays in the database for audit / historical recall.

Usage:
    cd opc && PYTHONPATH=. uv run python scripts/core/supersede.py \\
        <old-id> "<new content>" [--reason "<why>"] [--scope GLOBAL|PROJECT] \\
        [--project-dir <path>] [--type <LEARNING_TYPE>] [--provider local|voyage]

Output (JSON to stdout):
    {"success": true, "old_id": "...", "new_id": "...", "supersedes": "..."}

Errors are surfaced as `{"success": false, "error": "..."}` with exit code 1.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

# Load .env files - opc/.env is authoritative for DATABASE_URL
script_dir = Path(__file__).resolve().parent
opc_dir = script_dir.parent.parent  # opc/scripts/core -> opc/
opc_env = opc_dir / ".env"
if opc_env.exists():
    load_dotenv(opc_env, override=True)

global_env = Path.home() / ".claude" / ".env"
if global_env.exists():
    load_dotenv(global_env)
load_dotenv()

# Add scripts to path for imports like `from db.embedding_service import ...`
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from db.memory_provenance import prepare_write  # noqa: E402
from db.memory_redact import redact, redact_obj  # noqa: E402

# Valid learning types (mirrors store_learning.py + incremental_extract.py).
LEARNING_TYPES = {
    "FAILED_APPROACH",
    "WORKING_SOLUTION",
    "USER_PREFERENCE",
    "CODEBASE_PATTERN",
    "ARCHITECTURAL_DECISION",
    "ERROR_FIX",
    "OPEN_THREAD",
}


def _infer_type_safely(content: str) -> str:
    """Infer the learning type without creating a hard dependency.

    Tries to import the canonical heuristic from
    `incremental_extract.infer_learning_type`. Falls back to a minimal
    keyword check so this script still works in isolation (e.g. if
    incremental_extract is mid-rewrite).
    """
    try:
        from core.incremental_extract import infer_learning_type  # type: ignore

        return infer_learning_type(content)
    except Exception:
        pass

    # Minimal fallback heuristic. Order matters -- mirrors the canonical
    # pattern in incremental_extract.
    lowered = (content or "").lower()
    if "todo" in lowered or "open thread" in lowered:
        return "OPEN_THREAD"
    if "prefer" in lowered:
        return "USER_PREFERENCE"
    if "failed" in lowered or "doesn't work" in lowered or "did not work" in lowered:
        return "FAILED_APPROACH"
    if "error" in lowered and ("fix" in lowered or "resolved" in lowered):
        return "ERROR_FIX"
    if "architect" in lowered or "decided" in lowered:
        return "ARCHITECTURAL_DECISION"
    if "pattern" in lowered or "convention" in lowered:
        return "CODEBASE_PATTERN"
    return "WORKING_SOLUTION"


def build_successor(
    old_id: str,
    old_meta: dict[str, Any],
    old_session_id: str | None,
    new_content: str,
    reason: str | None,
    learning_type: str,
    now: datetime,
) -> tuple[str, dict[str, Any], str | None]:
    """Build the successor row: ``(content, metadata, session_id)``. Pure, no I/O.

    Provenance: source "manual" (a deliberate CLI correction), is_inference False. The
    old row's source goes to ``supersedes_source``. The session id is inherited from the
    old row. content and reason are redacted.
    """
    content = redact(new_content)
    reason_r = redact(reason) if reason else None
    session_id = old_meta.get("session_id") or old_session_id
    metadata: dict[str, Any] = {
        "type": "session_learning",
        "session_id": session_id,
        "timestamp": now.isoformat(),
        "learning_type": learning_type,
        "supersedes": str(old_id),
        "source": "manual",
        "is_inference": False,
    }
    if old_meta.get("source"):
        metadata["supersedes_source"] = old_meta["source"]
    if reason_r:
        metadata["supersede_reason"] = reason_r.text
    # Carry forward tags / context / confidence when present so the
    # successor inherits prior categorisation.
    # Rows written before phase 3 can hold raw secrets here, so redact what is inherited.
    inherited_hits: tuple[str, ...] = ()
    for key in ("tags", "context", "confidence"):
        if key in old_meta:
            metadata[key], hits = redact_obj(old_meta[key])
            inherited_hits += hits
    kinds = sorted(
        set(content.hits) | set(reason_r.hits if reason_r else ()) | set(inherited_hits)
    )
    if kinds:
        metadata["redacted_kinds"] = kinds
    return content.text, metadata, session_id


async def supersede(
    old_id: str,
    new_content: str,
    reason: str | None = None,
    scope: str | None = None,
    project_dir: str | None = None,
    learning_type: str | None = None,
    provider: str = "local",
) -> dict:
    """Mark `old_id` as superseded and insert `new_content` as a successor.

    Returns a dict with the operation result. Idempotent: if `old_id` is
    already superseded, this raises with `success=False` rather than
    double-marking or inserting a duplicate successor.
    """
    if not old_id or not old_id.strip():
        return {"success": False, "error": "old_id is required"}
    if not new_content or not new_content.strip():
        return {"success": False, "error": "new_content is required"}

    try:
        from db.embedding_service import EmbeddingService
        from db.postgres_pool import get_pool, init_pgvector, get_transaction
    except ImportError as exc:
        return {"success": False, "error": f"db module unavailable: {exc}"}

    # Optional project_id derivation (mirrors store_learning's get_project_id).
    project_id: str | None = None
    if project_dir:
        try:
            from core.project_memory import get_project_id  # type: ignore

            project_id = get_project_id(project_dir)
        except Exception:
            # Non-fatal: project_id is metadata, not a hard requirement.
            project_id = None

    learning_type = learning_type or _infer_type_safely(new_content)
    if learning_type not in LEARNING_TYPES:
        return {
            "success": False,
            "error": (
                f"Unknown learning_type={learning_type!r}. "
                f"Valid types: {sorted(LEARNING_TYPES)}"
            ),
        }

    # Generate embedding for the new content. Done outside the txn so the
    # embedding service can be closed promptly.
    embedder = EmbeddingService(provider=provider)
    try:
        embedding = await embedder.embed(redact(new_content).text)
    finally:
        await embedder.aclose()

    pool = await get_pool()
    async with pool.acquire() as conn:
        await init_pgvector(conn)

        async with conn.transaction():
            # 1. Verify the old row exists and isn't already superseded.
            row = await conn.fetchrow(
                """
                SELECT id, session_id, content, metadata, valid_until, project_id, scope
                FROM archival_memory
                WHERE id = $1::uuid
                """,
                old_id,
            )
            if row is None:
                return {
                    "success": False,
                    "error": f"No archival_memory row with id={old_id}",
                }
            if row["valid_until"] is not None:
                return {
                    "success": False,
                    "error": (
                        f"Entry {old_id} already superseded at "
                        f"{row['valid_until'].isoformat()}"
                    ),
                    "valid_until": row["valid_until"].isoformat(),
                }

            now = datetime.now(timezone.utc)

            # 2. Mark the old row superseded.
            await conn.execute(
                """
                UPDATE archival_memory
                SET valid_until = $1
                WHERE id = $2::uuid
                """,
                now,
                old_id,
            )

            # 3. Build metadata for the new row. Inherit session/scope/project
            # from the old row when caller didn't pass overrides.
            old_meta_raw = row["metadata"]
            if isinstance(old_meta_raw, str):
                old_meta = json.loads(old_meta_raw)
            else:
                old_meta = dict(old_meta_raw or {})

            new_content_r, new_metadata, new_session_id = build_successor(
                old_id, old_meta, row["session_id"], new_content, reason, learning_type, now
            )

            insert_scope = scope or row["scope"] or "PROJECT"
            insert_project_id = project_id or row["project_id"]

            # Raw INSERT: prepare_write is the redaction backstop plus the provenance
            # check that MemoryServicePG.store() applies on its own path.
            new_content_r, new_metadata, new_session_id = prepare_write(
                new_content_r, new_metadata, new_session_id
            )

            # 4. Insert the successor. The DB default for valid_from = now()
            # (and valid_until stays NULL = currently valid).
            inserted = await conn.fetchrow(
                """
                INSERT INTO archival_memory
                    (session_id, content, metadata, embedding, scope, project_id)
                VALUES
                    ($1, $2, $3::jsonb, $4::vector, $5, $6)
                RETURNING id, valid_from
                """,
                new_session_id,
                new_content_r,
                json.dumps(new_metadata),
                str(embedding),
                insert_scope,
                insert_project_id,
            )

            return {
                "success": True,
                "old_id": str(old_id),
                "new_id": str(inserted["id"]),
                "supersedes": str(old_id),
                "valid_from": inserted["valid_from"].isoformat(),
                "valid_until": now.isoformat(),
                "learning_type": learning_type,
                "scope": insert_scope,
                "project_id": insert_project_id,
            }


async def main_async() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Mark an archival_memory entry as superseded and insert a "
            "replacement entry. Old entry stays in the DB but is excluded "
            "from default recall."
        ),
    )
    parser.add_argument(
        "old_id",
        help="UUID of the entry to mark superseded.",
    )
    parser.add_argument(
        "new_content",
        help="Replacement content. Generates a new embedding via --provider.",
    )
    parser.add_argument(
        "--reason",
        default=None,
        help="Why the old entry was superseded (stored in metadata).",
    )
    parser.add_argument(
        "--scope",
        choices=["GLOBAL", "PROJECT"],
        default=None,
        help="Override scope of the new entry (default: inherit from old).",
    )
    parser.add_argument(
        "--project-dir",
        default=None,
        help=(
            "Project directory for the new entry. Defaults to inheriting "
            "the old entry's project_id."
        ),
    )
    parser.add_argument(
        "--type",
        dest="learning_type",
        choices=sorted(LEARNING_TYPES),
        default=None,
        help=(
            "Learning type for the new entry. Inferred from content when "
            "not provided."
        ),
    )
    parser.add_argument(
        "--provider",
        choices=["local", "voyage"],
        default="local",
        help="Embedding provider for the new content (default: local).",
    )
    args = parser.parse_args()

    result = await supersede(
        old_id=args.old_id,
        new_content=args.new_content,
        reason=args.reason,
        scope=args.scope,
        project_dir=args.project_dir,
        learning_type=args.learning_type,
        provider=args.provider,
    )

    print(json.dumps(result, indent=2))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main_async()))
