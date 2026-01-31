#!/usr/bin/env python3
"""Backfill embeddings for archival_memory entries missing them.

Usage:
    cd ~/.claude/scripts/core
    uv run python -m core.backfill_embeddings          # Only NULL embeddings
    uv run python -m core.backfill_embeddings --force  # Re-embed everything

This script:
1. Finds all archival_memory entries with embedding IS NULL (or all if --force)
2. Generates embeddings using local BGE model (no API cost)
3. Pads/truncates to configured EMBEDDING_DIMENSION
4. Updates each entry with the generated embedding

Use --force after changing embedding models to re-embed with new model.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

import numpy as np
from dotenv import load_dotenv

# Load environment
global_env = Path.home() / ".claude" / ".env"
if global_env.exists():
    load_dotenv(global_env, override=True)
load_dotenv(override=True)

# Add project to path
project_dir = os.environ.get("CLAUDE_PROJECT_DIR", str(Path(__file__).parent.parent))
sys.path.insert(0, project_dir)


def pad_embedding(embedding: list[float], target_dim: int) -> list[float]:
    """Pad or truncate embedding to target dimension."""
    vec = np.array(embedding)
    if len(vec) >= target_dim:
        return vec[:target_dim].tolist()
    return np.pad(vec, (0, target_dim - len(vec)), mode="constant").tolist()


async def backfill(force: bool = False, batch_size: int = 100):
    """Backfill embeddings for entries missing them.

    Args:
        force: If True, re-embed all entries (not just NULL)
        batch_size: Number of entries to process per batch
    """
    from core.db.postgres_pool import get_connection, init_pgvector, close_pool
    from core.db.embedding_service import EmbeddingService
    from core.db.embedding_config import get_embedding_dimension

    target_dim = get_embedding_dimension()
    print(f"Target embedding dimension: {target_dim}")

    print("Initializing BGE embedding model...")
    embedder = EmbeddingService(provider="local")
    print(f"Model loaded. Native dimension: {embedder.dimension}")

    if embedder.dimension != target_dim:
        print(f"Note: Embeddings will be padded/truncated to {target_dim} dims")

    try:
        async with get_connection() as conn:
            # Find entries to process
            if force:
                rows = await conn.fetch("""
                    SELECT id, content FROM archival_memory
                    ORDER BY created_at DESC
                """)
                print(f"Force mode: re-embedding all {len(rows)} entries.")
            else:
                rows = await conn.fetch("""
                    SELECT id, content FROM archival_memory
                    WHERE embedding IS NULL
                """)

            if not rows:
                print("No entries need backfilling.")
                return

            print(f"Found {len(rows)} entries to backfill.")

            for i, row in enumerate(rows):
                content = row["content"]
                memory_id = str(row["id"])

                print(f"[{i+1}/{len(rows)}] Generating embedding for {memory_id[:8]}...")

                # Generate embedding
                embedding = await embedder.embed(content)

                # Pad/truncate to target dimension
                padded = pad_embedding(embedding, target_dim)

                # Update entry
                await init_pgvector(conn)
                await conn.execute("""
                    UPDATE archival_memory
                    SET embedding = $1::vector
                    WHERE id = $2
                """, padded, row["id"])

                print(f"  [OK] Updated ({len(padded)} dims)")

        print(f"\nBackfill complete. {len(rows)} entries updated.")
    finally:
        await close_pool()


def main():
    parser = argparse.ArgumentParser(
        description="Backfill embeddings for archival_memory entries"
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-embed all entries, not just NULL ones",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=100,
        help="Entries per batch (default: 100)",
    )
    args = parser.parse_args()

    asyncio.run(backfill(force=args.force, batch_size=args.batch_size))


if __name__ == "__main__":
    main()
