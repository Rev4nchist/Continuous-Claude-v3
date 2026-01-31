"""Migrate embedding column dimension.

Changes the vector column dimension in archival_memory and handoffs tables.
This requires rebuilding the HNSW index.

Usage:
    python -m core.db.migrate_embedding_dimension --target-dim 2048 --dry-run
    python -m core.db.migrate_embedding_dimension --target-dim 2048

After migration:
    1. Update EMBEDDING_DIMENSION env var to new dimension
    2. Run backfill_embeddings.py --force to re-embed with new model
"""

import argparse
import asyncio
import sys
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from dotenv import load_dotenv

from core.db.postgres_pool import get_connection, close_pool


async def get_current_dimension(table: str, column: str = "embedding") -> int | None:
    """Get current vector column dimension from pg_attribute."""
    async with get_connection() as conn:
        row = await conn.fetchrow(
            """
            SELECT atttypmod
            FROM pg_attribute
            WHERE attrelid = $1::regclass
              AND attname = $2
        """,
            table,
            column,
        )
        if row and row["atttypmod"] > 0:
            return row["atttypmod"]
        return None


async def count_non_null_embeddings(table: str) -> int:
    """Count rows with non-null embeddings."""
    async with get_connection() as conn:
        row = await conn.fetchrow(
            f"SELECT COUNT(*) as cnt FROM {table} WHERE embedding IS NOT NULL"  # noqa: S608
        )
        return row["cnt"] if row else 0


async def migrate_dimension(
    target_dim: int,
    dry_run: bool = True,
    tables: list[str] | None = None,
) -> dict:
    """Migrate embedding columns to new dimension.

    Args:
        target_dim: Target vector dimension
        dry_run: If True, only report what would happen
        tables: Tables to migrate (default: archival_memory, handoffs)

    Returns:
        Migration report dict
    """
    if tables is None:
        tables = ["archival_memory", "handoffs"]

    report = {
        "target_dim": target_dim,
        "dry_run": dry_run,
        "tables": {},
    }

    for table in tables:
        current_dim = await get_current_dimension(table)
        count = await count_non_null_embeddings(table)

        table_report = {
            "current_dim": current_dim,
            "target_dim": target_dim,
            "embeddings_count": count,
            "action": "none",
        }

        if current_dim == target_dim:
            table_report["action"] = "skip"
            table_report["reason"] = "Already at target dimension"
        elif current_dim is None:
            table_report["action"] = "skip"
            table_report["reason"] = "No embedding column found"
        else:
            table_report["action"] = "migrate"
            if count > 0:
                table_report["warning"] = (
                    f"{count} existing embeddings will be padded/truncated"
                )

            if not dry_run:
                await _execute_migration(table, current_dim, target_dim)
                table_report["status"] = "completed"

        report["tables"][table] = table_report

    return report


async def _execute_migration(table: str, current_dim: int, target_dim: int) -> None:
    """Execute the actual migration for a table."""
    async with get_connection() as conn:
        # Drop the HNSW index first (required for ALTER TYPE)
        index_name = f"idx_{table.split('.')[-1]}_embedding_hnsw"
        await conn.execute(f"DROP INDEX IF EXISTS {index_name}")  # noqa: S608

        # For dimension increase: pad with zeros
        # For dimension decrease: truncate
        if target_dim > current_dim:
            # Pad existing embeddings with zeros
            await conn.execute(
                f"""
                UPDATE {table}
                SET embedding = embedding::float8[] || array_fill(0::float8, ARRAY[{target_dim - current_dim}])
                WHERE embedding IS NOT NULL
            """  # noqa: S608
            )
        elif target_dim < current_dim:
            # Truncate existing embeddings
            await conn.execute(
                f"""
                UPDATE {table}
                SET embedding = (embedding::float8[])[1:{target_dim}]
                WHERE embedding IS NOT NULL
            """  # noqa: S608
            )

        # Alter the column type
        await conn.execute(
            f"ALTER TABLE {table} ALTER COLUMN embedding TYPE vector({target_dim})"  # noqa: S608
        )

        # Recreate the HNSW index
        await conn.execute(
            f"""
            CREATE INDEX {index_name} ON {table}
            USING hnsw(embedding vector_cosine_ops)
            WITH (m = 16, ef_construction = 64)
        """  # noqa: S608
        )


def print_report(report: dict) -> None:
    """Print migration report to console."""
    print(f"\n{'='*60}")
    print(f"Embedding Dimension Migration {'(DRY RUN)' if report['dry_run'] else ''}")
    print(f"{'='*60}")
    print(f"Target dimension: {report['target_dim']}")
    print()

    for table, info in report["tables"].items():
        print(f"Table: {table}")
        print(f"  Current dimension: {info.get('current_dim', 'N/A')}")
        print(f"  Embeddings count: {info.get('embeddings_count', 0)}")
        print(f"  Action: {info['action']}")

        if "reason" in info:
            print(f"  Reason: {info['reason']}")
        if "warning" in info:
            print(f"  Warning: {info['warning']}")
        if "status" in info:
            print(f"  Status: {info['status']}")
        print()

    if report["dry_run"]:
        print("Run without --dry-run to execute migration.")
    else:
        print("Migration complete. Remember to:")
        print("  1. Update EMBEDDING_DIMENSION environment variable")
        print("  2. Run backfill_embeddings.py --force to re-embed with new model")


async def main():
    parser = argparse.ArgumentParser(
        description="Migrate embedding column dimension"
    )
    parser.add_argument(
        "--target-dim",
        type=int,
        required=True,
        help="Target vector dimension",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only report what would happen",
    )
    parser.add_argument(
        "--table",
        action="append",
        dest="tables",
        help="Table to migrate (can specify multiple, default: archival_memory, handoffs)",
    )

    args = parser.parse_args()

    # Load environment
    load_dotenv(Path.home() / ".claude" / ".env", override=True)
    load_dotenv(override=True)

    try:
        report = await migrate_dimension(
            target_dim=args.target_dim,
            dry_run=args.dry_run,
            tables=args.tables,
        )
        print_report(report)
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
