"""Embedding dimension configuration.

Centralizes embedding dimension settings to enable future model migrations.

Environment Variables:
    EMBEDDING_DIMENSION: Target dimension for embeddings (default: 1024)

The dimension should match your embedding model:
    - bge-large-en-v1.5: 1024 (default)
    - bge-base-en-v1.5: 768
    - voyage-3/voyage-code-3: 1024
    - all-MiniLM-L6-v2: 384
    - all-mpnet-base-v2: 768

When changing dimensions:
    1. Update EMBEDDING_DIMENSION
    2. Run: python -m core.db.migrate_embedding_dimension
    3. Re-embed existing data: python -m core.backfill_embeddings --force
"""

import os


def get_embedding_dimension() -> int:
    """Get configured embedding dimension.

    Returns:
        Embedding dimension from EMBEDDING_DIMENSION env var or default 1024.
    """
    dim_str = os.environ.get("EMBEDDING_DIMENSION", "1024")
    try:
        dim = int(dim_str)
        if dim <= 0:
            return 1024
        return dim
    except ValueError:
        return 1024


def get_supported_dimensions() -> list[int]:
    """Get list of commonly supported embedding dimensions.

    Returns:
        List of dimension sizes for common models.
    """
    return [384, 512, 768, 1024, 1536, 2048, 3072, 4096]


def validate_dimension(dim: int) -> bool:
    """Check if dimension is valid.

    Args:
        dim: Embedding dimension to validate.

    Returns:
        True if dimension is positive and reasonable.
    """
    return 0 < dim <= 8192  # Most models are under 8192


# Default for easy import
DEFAULT_DIMENSION = 1024
