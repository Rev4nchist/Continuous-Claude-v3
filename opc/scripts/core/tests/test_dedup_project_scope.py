"""Tests for Phase 4C: dedup is now scoped by project_id, not session_id.

Prior to Phase 4C, the dedup query in store_learning_v2 called
``memory.search_vector(embedding, limit=1)`` -- which filters by
``session_id = self.session_id``. So identical content stored from session
A and session B would BOTH land in archival_memory because the dedup search
only looked at session A's rows from session A's perspective.

Phase 4C adds ``MemoryServicePG.search_vector_for_dedup`` which scopes by
project_id (PROJECT scope) or by GLOBAL scope (no project filter), and
``store_learning_v2`` now calls that method. Threshold stays at 0.85.

Two layers of tests:
  1. Unit-level: stub out search_vector_for_dedup and confirm it's called
     with the right (scope, project_id) tuple.
  2. Integration-level (DATABASE_URL required): store identical content
     across sessions/projects and confirm row count deltas.
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
import warnings
from pathlib import Path
from unittest import mock

import pytest

# Ensure scripts/core is importable as a package
_CORE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_CORE_DIR))

import store_learning  # noqa: E402


# ---------------------------------------------------------------------------
# Unit tests: confirm v2 calls search_vector_for_dedup with right scope/project
# ---------------------------------------------------------------------------


@pytest.fixture
def stubbed_memory_service():
    """Patch create_memory_service to return a memory mock.

    The mock provides search_vector_for_dedup, store, and close so we can
    assert their call arguments without touching the real backend.
    """
    memory = mock.AsyncMock()
    memory.search_vector_for_dedup = mock.AsyncMock(return_value=[])
    memory.store = mock.AsyncMock(return_value="fake-memory-id")
    memory.close = mock.AsyncMock()

    # Also stub embedding to avoid loading the BGE model
    embedder = mock.AsyncMock()
    embedder.embed = mock.AsyncMock(return_value=[0.1] * 1024)

    return memory, embedder


@pytest.fixture
def preserve_database_url():
    """Save and restore DATABASE_URL so unit tests don't clobber real env."""
    original = os.environ.get("DATABASE_URL")
    yield
    if original is None:
        os.environ.pop("DATABASE_URL", None)
    else:
        os.environ["DATABASE_URL"] = original


def test_v2_dedup_uses_search_vector_for_dedup_not_search_vector(
    stubbed_memory_service, preserve_database_url
):
    """v2's dedup path calls search_vector_for_dedup, not session-scoped search_vector."""
    memory, embedder = stubbed_memory_service

    async def _run():
        with mock.patch("db.memory_factory.create_memory_service", return_value=memory):
            with mock.patch.object(store_learning, "get_embedder", return_value=embedder):
                # Make get_default_backend pickable
                with mock.patch("db.memory_factory.get_default_backend", return_value="postgres"):
                    os.environ["DATABASE_URL"] = "postgresql://stub"
                    await store_learning.store_learning_v2(
                        session_id="phase4c-unit-1",
                        content=(
                            "Phase 4C: dedup is now project-scoped, not session-scoped. "
                            "Identical content from different sessions in the same project "
                            "should be deduplicated. The fix moves scope/project_id "
                            "computation BEFORE the dedup search."
                        ),
                        learning_type="WORKING_SOLUTION",
                        scope="PROJECT",
                        project_dir="C:/some/project/path",
                    )

        memory.search_vector_for_dedup.assert_called_once()
        # The session-scoped search_vector should NOT be used for dedup
        memory.search_vector.assert_not_called()

    asyncio.run(_run())


def test_v2_dedup_passes_project_scope_and_project_id(
    stubbed_memory_service, preserve_database_url
):
    """Project-scoped store passes (scope='PROJECT', project_id=<hash>)."""
    memory, embedder = stubbed_memory_service

    async def _run():
        with mock.patch("db.memory_factory.create_memory_service", return_value=memory):
            with mock.patch.object(store_learning, "get_embedder", return_value=embedder):
                with mock.patch("db.memory_factory.get_default_backend", return_value="postgres"):
                    os.environ["DATABASE_URL"] = "postgresql://stub"
                    await store_learning.store_learning_v2(
                        session_id="phase4c-unit-2",
                        content=(
                            "A project-scoped learning that should dedup across sessions "
                            "within the same project, but not across different projects."
                        ),
                        learning_type="WORKING_SOLUTION",
                        scope="PROJECT",
                        project_dir="C:/some/project/path",
                    )

        kwargs = memory.search_vector_for_dedup.call_args.kwargs
        assert kwargs["scope"] == "PROJECT"
        # project_id is the 16-char hash of "C:/some/project/path"
        assert isinstance(kwargs["project_id"], str)
        assert len(kwargs["project_id"]) == 16
        assert kwargs["limit"] == 1

    asyncio.run(_run())


def test_v2_dedup_passes_global_scope(stubbed_memory_service, preserve_database_url):
    """Global-scoped store passes (scope='GLOBAL', project_id=None)."""
    memory, embedder = stubbed_memory_service

    async def _run():
        with mock.patch("db.memory_factory.create_memory_service", return_value=memory):
            with mock.patch.object(store_learning, "get_embedder", return_value=embedder):
                with mock.patch("db.memory_factory.get_default_backend", return_value="postgres"):
                    os.environ["DATABASE_URL"] = "postgresql://stub"
                    await store_learning.store_learning_v2(
                        session_id="phase4c-unit-3",
                        content=(
                            "A global learning that should dedup across all projects "
                            "and sessions because it's a cross-cutting Windows pattern."
                        ),
                        learning_type="CODEBASE_PATTERN",
                        scope="GLOBAL",
                    )

        kwargs = memory.search_vector_for_dedup.call_args.kwargs
        assert kwargs["scope"] == "GLOBAL"
        # project_id is None for global learnings
        assert kwargs["project_id"] is None

    asyncio.run(_run())


def test_v2_skips_when_dedup_returns_high_similarity(
    stubbed_memory_service, preserve_database_url
):
    """Threshold (0.85) is honored: dedup hit -> skip with existing_id."""
    memory, embedder = stubbed_memory_service
    memory.search_vector_for_dedup = mock.AsyncMock(return_value=[
        {
            "id": "existing-uuid-1234",
            "content": "near-duplicate content",
            "metadata": {},
            "created_at": None,
            "scope": "PROJECT",
            "project_id": "abc123",
            "similarity": 0.97,
        }
    ])

    async def _run():
        with mock.patch("db.memory_factory.create_memory_service", return_value=memory):
            with mock.patch.object(store_learning, "get_embedder", return_value=embedder):
                with mock.patch("db.memory_factory.get_default_backend", return_value="postgres"):
                    os.environ["DATABASE_URL"] = "postgresql://stub"
                    result = await store_learning.store_learning_v2(
                        session_id="phase4c-unit-4",
                        content=(
                            "Identical content stored from a different session -- "
                            "this should be deduplicated against the project's existing rows."
                        ),
                        learning_type="WORKING_SOLUTION",
                        scope="PROJECT",
                        project_dir="C:/some/project",
                    )

        assert result.get("skipped") is True
        assert result.get("existing_id") == "existing-uuid-1234"
        # store should NOT have been called
        memory.store.assert_not_called()

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# Integration tests: live DB required
# ---------------------------------------------------------------------------

@pytest.fixture
def canary_prefix():
    return f"phase4c-{uuid.uuid4().hex[:8]}"


@pytest.fixture
def reset_postgres_pool():
    """Reset the global asyncpg pool before and after the test.

    Each pytest function creates a new event loop via asyncio.run(), so a
    pool created on a prior loop becomes unusable. reset_pool() drops the
    reference so the next get_pool() call creates a fresh one bound to
    the current loop.
    """
    # Reset before to drop any pool from a prior test
    sys.path.insert(0, str(_CORE_DIR))
    try:
        from db.postgres_pool import reset_pool
        reset_pool()
    except ModuleNotFoundError:
        # db.postgres_pool isn't on sys.path in this env -- nothing to reset,
        # the test will skipif on DATABASE_URL anyway if it really matters.
        pass
    except Exception as exc:  # pragma: no cover - cleanup observability
        warnings.warn(
            f"reset_pool() failed: {exc!r}", RuntimeWarning, stacklevel=2
        )
    yield
    # And after, so the next test starts clean
    try:
        from db.postgres_pool import reset_pool
        reset_pool()
    except ModuleNotFoundError:
        # db.postgres_pool isn't on sys.path in this env -- nothing to reset,
        # the test will skipif on DATABASE_URL anyway if it really matters.
        pass
    except Exception as exc:  # pragma: no cover - cleanup observability
        warnings.warn(
            f"reset_pool() failed: {exc!r}", RuntimeWarning, stacklevel=2
        )


@pytest.fixture
def cleanup_db(canary_prefix):
    """Remove canary rows BEFORE and AFTER the test.

    Pre-clean: a previously-failed run (e.g. crashed mid-test, or a
    differently-named canary that happened to hash-collide with this one's
    LIKE pattern) could leave stale rows that make this test pass for the
    wrong reason or fail spuriously. Cleaning up-front guarantees the test
    starts from a known-empty state for its canary prefix space.

    Post-clean: leave the table the way we found it for the next test /
    developer.
    """

    def _clean_sync():
        try:
            import asyncpg  # type: ignore

            url = os.environ.get("DATABASE_URL")
            if not url:
                return

            async def _delete():
                conn = await asyncpg.connect(url)
                try:
                    await conn.execute(
                        "DELETE FROM archival_memory WHERE session_id LIKE $1",
                        canary_prefix + "%",
                    )
                finally:
                    await conn.close()

            asyncio.run(_delete())
        except ModuleNotFoundError:
            # asyncpg not installed in this env -- canary cleanup is a no-op
            # and the test itself will be skipped via the DATABASE_URL guard.
            pass
        except Exception as exc:  # pragma: no cover - cleanup observability
            # Cleanup failures shouldn't crash the test, but they shouldn't
            # be silent either -- a stuck DELETE means the next run starts
            # from a dirty state and may pass for the wrong reason.
            warnings.warn(
                f"cleanup_db delete failed: {exc!r}",
                RuntimeWarning,
                stacklevel=2,
            )

    _clean_sync()  # pre-test
    yield
    _clean_sync()  # post-test


@pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; skipping integration test",
)
def test_same_content_same_project_different_sessions_deduped(
    canary_prefix, cleanup_db, reset_postgres_pool
):
    """Identical content + same project_id + different sessions -> 2nd call deduped.

    This is the core Phase 4C guarantee. Pre-Phase-4C the second store would
    create a duplicate row because dedup was filtered by session_id.
    """
    project_dir = "~/Projects/phase4c-fake-project"
    content = (
        "Phase 4C integration test canary content -- this string is unique "
        "enough to not collide with anything else in archival_memory, and "
        "it must dedup across sessions within the same project. The fix "
        "scoped the dedup query by project_id instead of session_id."
    )

    async def _run():
        # Session A
        result_a = await store_learning.store_learning_v2(
            session_id=f"{canary_prefix}-A",
            content=content,
            learning_type="WORKING_SOLUTION",
            scope="PROJECT",
            project_dir=project_dir,
        )
        assert result_a.get("success") is True, result_a
        assert not result_a.get("skipped"), (
            f"First store should not be skipped; got {result_a}"
        )

        # Session B -- same content, same project, different session
        result_b = await store_learning.store_learning_v2(
            session_id=f"{canary_prefix}-B",
            content=content,
            learning_type="WORKING_SOLUTION",
            scope="PROJECT",
            project_dir=project_dir,
        )
        assert result_b.get("success") is True, result_b
        # The crucial assertion: this MUST be a skip, not a new row.
        assert result_b.get("skipped") is True, (
            f"Phase 4C: identical content + same project from different sessions "
            f"should be deduped. Got non-skip: {result_b}"
        )
        # And it should reference the existing row from session A.
        assert result_b.get("existing_id") is not None

    asyncio.run(_run())

    # Verify row count: should be exactly 1 row across both sessions.
    import asyncpg  # type: ignore

    async def _count():
        conn = await asyncpg.connect(os.environ["DATABASE_URL"])
        try:
            row = await conn.fetchrow(
                "SELECT COUNT(*)::int AS n FROM archival_memory WHERE session_id LIKE $1",
                canary_prefix + "%",
            )
            return row["n"] if row else 0
        finally:
            await conn.close()

    n = asyncio.run(_count())
    assert n == 1, (
        f"Expected exactly 1 row for canary {canary_prefix} (deduped second store), "
        f"got {n}. Phase 4C dedup is not project-scoped."
    )


@pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; skipping integration test",
)
def test_same_content_different_projects_both_stored(
    canary_prefix, cleanup_db, reset_postgres_pool
):
    """Identical content + different projects -> both stored as separate rows.

    Project boundaries should NOT collapse -- a 'WORKING_SOLUTION' for project
    X is independent from the same string in project Y.
    """
    content = (
        "Phase 4C integration: same content in two different projects must "
        "create two separate rows because project_id distinguishes them. "
        "This canary confirms cross-project independence is preserved."
    )

    async def _run():
        result_x = await store_learning.store_learning_v2(
            session_id=f"{canary_prefix}-X",
            content=content,
            learning_type="WORKING_SOLUTION",
            scope="PROJECT",
            project_dir="~/Projects/phase4c-project-X",
        )
        assert result_x.get("success") is True
        assert not result_x.get("skipped"), result_x

        result_y = await store_learning.store_learning_v2(
            session_id=f"{canary_prefix}-Y",
            content=content,
            learning_type="WORKING_SOLUTION",
            scope="PROJECT",
            project_dir="~/Projects/phase4c-project-Y",
        )
        assert result_y.get("success") is True
        assert not result_y.get("skipped"), (
            f"Cross-project should NOT dedup. Got skip: {result_y}"
        )

    asyncio.run(_run())

    # Both rows present
    import asyncpg  # type: ignore

    async def _count():
        conn = await asyncpg.connect(os.environ["DATABASE_URL"])
        try:
            row = await conn.fetchrow(
                "SELECT COUNT(*)::int AS n FROM archival_memory WHERE session_id LIKE $1",
                canary_prefix + "%",
            )
            return row["n"] if row else 0
        finally:
            await conn.close()

    n = asyncio.run(_count())
    assert n == 2, (
        f"Expected 2 rows (different projects = no dedup) for {canary_prefix}, got {n}"
    )


# ---------------------------------------------------------------------------
# Method existence (cheap signal, no DB)
# ---------------------------------------------------------------------------


def test_search_vector_for_dedup_exists_on_memory_service():
    """The new dedup-specific search method is exposed on MemoryServicePG.

    We assert against the source string (rather than importing the class)
    because the relative imports inside db/memory_service_pg.py require
    asyncpg/numpy/pgvector to be importable, which we don't need just to
    verify the method exists.
    """
    src = (_CORE_DIR / "db" / "memory_service_pg.py").read_text(encoding="utf-8")
    assert "async def search_vector_for_dedup" in src, (
        "MemoryServicePG must define search_vector_for_dedup for Phase 4C"
    )
    # And store_learning.py must be calling it
    sl_src = (_CORE_DIR / "store_learning.py").read_text(encoding="utf-8")
    assert "search_vector_for_dedup" in sl_src, (
        "store_learning_v2 must call search_vector_for_dedup (Phase 4C)"
    )
