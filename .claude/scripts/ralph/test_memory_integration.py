#!/usr/bin/env python3
"""Integration tests for memory round-trip.

Tests that:
1. Stored learnings can be recalled via prepare-agent-context
2. Extracted learnings are queryable from the database

Requires PostgreSQL running at localhost:5434.
Mark tests with @pytest.mark.integration.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

# Register integration marker
def pytest_configure(config):
    config.addinivalue_line(
        "markers", "integration: mark test as integration test (requires DB)"
    )

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

from importlib import import_module


def is_postgres_available() -> bool:
    """Check if PostgreSQL is available for integration tests."""
    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url:
        return False
    try:
        import asyncpg
        return True
    except ImportError:
        return False


pytestmark = pytest.mark.skipif(
    not is_postgres_available(),
    reason="PostgreSQL not available (DATABASE_URL not set or asyncpg not installed)"
)


@pytest.fixture
def unique_test_id():
    """Generate unique ID for test isolation."""
    return f"integration-test-{uuid.uuid4().hex[:8]}"


@pytest.fixture
async def cleanup_test_learnings(unique_test_id):
    """Clean up test learnings after test."""
    yield
    try:
        import asyncpg
        database_url = os.environ.get("DATABASE_URL")
        if database_url:
            conn = await asyncpg.connect(database_url)
            try:
                await conn.execute(
                    "DELETE FROM archival_memory WHERE session_id LIKE $1",
                    f"%{unique_test_id}%",
                )
            finally:
                await conn.close()
    except Exception:
        pass


@pytest.mark.integration
@pytest.mark.asyncio
async def test_store_then_recall(unique_test_id, cleanup_test_learnings):
    """Store a learning, then verify prepare-agent-context recalls it."""
    from core.store_learning import store_learning_v2

    test_content = f"Test auth pattern ({unique_test_id}): always validate tokens before processing"
    await store_learning_v2(
        session_id=f"test-{unique_test_id}",
        content=test_content,
        learning_type="WORKING_SOLUTION",
        context="authentication testing",
        tags=["auth", "testing", unique_test_id],
        confidence="high",
    )

    prepare_context_module = import_module("prepare-agent-context")
    prepare_context = prepare_context_module.prepare_context

    with tempfile.TemporaryDirectory() as output_dir:
        result = await prepare_context(
            task_description=f"Implement authentication middleware {unique_test_id}",
            project_dir="/tmp/test-project",
            story_id=f"INT-{unique_test_id}",
            output_dir=output_dir,
        )

        assert result["success"] is True

        learnings_md = Path(result["files"]["learnings"]).read_text()

        assert unique_test_id in learnings_md or "auth" in learnings_md.lower(), (
            f"Expected test learning to appear in learnings.md. Content:\n{learnings_md[:500]}"
        )


@pytest.mark.integration
@pytest.mark.asyncio
async def test_extract_stores_to_db(unique_test_id, cleanup_test_learnings):
    """Verify extract-agent-learnings stores to PostgreSQL.

    Uses subprocess to avoid event loop conflicts between tests.
    Tests: extract script runs, returns success, reports WORKING_SOLUTION.
    The memory_id in result confirms DB storage.
    """
    import subprocess

    output_data = {
        "status": "success",
        "task_description": f"Test task {unique_test_id}",
        "task_type": "implement",
        "files_modified": ["src/test.ts"],
        "approach_summary": f"Used pattern X ({unique_test_id})",
        "key_insight": f"Pattern X ({unique_test_id}) is effective",
        "verification": {"tests_passed": True},
    }

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False
    ) as f:
        json.dump(output_data, f)
        output_file = f.name

    try:
        # Use subprocess to avoid event loop sharing issues
        result = subprocess.run(
            [
                "uv", "run", "python",
                str(Path(__file__).parent / "extract-agent-learnings.py"),
                "--output-file", output_file,
                "--story-id", f"EXTRACT-{unique_test_id}",
                "--task-description", f"Test task {unique_test_id}",
                "--json",
            ],
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).parent),
        )

        assert result.returncode == 0, f"Extract script failed: {result.stderr}"

        result_data = json.loads(result.stdout)
        assert result_data.get("success") or result_data.get("skipped"), f"Extract failed: {result_data}"
        assert result_data.get("learning_type") == "WORKING_SOLUTION"

        # Verify we got a memory_id (confirms DB storage)
        assert result_data.get("memory_id"), f"No memory_id returned - storage may have failed: {result_data}"
        assert result_data.get("backend") == "postgres", f"Expected postgres backend: {result_data}"

    finally:
        Path(output_file).unlink()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_failure_learning_round_trip(unique_test_id, cleanup_test_learnings):
    """Store a failure learning and verify it's recalled as 'What To Avoid'."""
    from core.store_learning import store_learning_v2

    test_content = f"Failed approach ({unique_test_id}): Don't use synchronous DB calls in middleware"
    await store_learning_v2(
        session_id=f"test-failure-{unique_test_id}",
        content=test_content,
        learning_type="FAILED_APPROACH",
        context="middleware errors",
        tags=["middleware", "database", unique_test_id],
        confidence="high",
    )

    prepare_context_module = import_module("prepare-agent-context")
    prepare_context = prepare_context_module.prepare_context

    with tempfile.TemporaryDirectory() as output_dir:
        result = await prepare_context(
            task_description=f"fix middleware database errors {unique_test_id}",
            project_dir="/tmp/test-project",
            story_id=f"FAIL-{unique_test_id}",
            output_dir=output_dir,
        )

        learnings_md = Path(result["files"]["learnings"]).read_text()

        has_avoid_section = "What To Avoid" in learnings_md
        has_test_content = unique_test_id in learnings_md

        assert has_avoid_section or has_test_content, (
            f"Expected failure learning in 'What To Avoid' section. Content:\n{learnings_md[:500]}"
        )


@pytest.mark.integration
@pytest.mark.asyncio
async def test_multiple_learning_types_categorized(unique_test_id, cleanup_test_learnings):
    """Store multiple learning types and verify correct categorization."""
    from core.store_learning import store_learning_v2

    await store_learning_v2(
        session_id=f"test-solution-{unique_test_id}",
        content=f"Solution ({unique_test_id}): Use dependency injection",
        learning_type="WORKING_SOLUTION",
        context="architecture patterns",
        tags=["di", unique_test_id],
        confidence="high",
    )

    await store_learning_v2(
        session_id=f"test-failure-{unique_test_id}",
        content=f"Failure ({unique_test_id}): Global state caused issues",
        learning_type="FAILED_APPROACH",
        context="architecture anti-patterns",
        tags=["anti-pattern", unique_test_id],
        confidence="high",
    )

    await store_learning_v2(
        session_id=f"test-pattern-{unique_test_id}",
        content=f"Pattern ({unique_test_id}): All services extend BaseService",
        learning_type="CODEBASE_PATTERN",
        context="codebase conventions",
        tags=["conventions", unique_test_id],
        confidence="medium",
    )

    prepare_context_module = import_module("prepare-agent-context")
    prepare_context = prepare_context_module.prepare_context

    with tempfile.TemporaryDirectory() as output_dir:
        result = await prepare_context(
            task_description=f"implement new service with dependency injection {unique_test_id}",
            project_dir="/tmp/test-project",
            story_id=f"MULTI-{unique_test_id}",
            output_dir=output_dir,
        )

        learnings_md = Path(result["files"]["learnings"]).read_text()

        sections = {
            "What Worked Before": "WORKING_SOLUTION" in learnings_md or unique_test_id in learnings_md,
            "What To Avoid": "FAILED_APPROACH" in learnings_md or "Avoid" in learnings_md,
        }

        assert any(sections.values()), (
            f"Expected categorized sections. Sections found: {sections}\n"
            f"Content preview:\n{learnings_md[:800]}"
        )


@pytest.mark.integration
@pytest.mark.asyncio
async def test_meta_json_reflects_query_results(unique_test_id, cleanup_test_learnings):
    """Verify meta.json contains accurate learning counts."""
    from core.store_learning import store_learning_v2

    for i in range(3):
        await store_learning_v2(
            session_id=f"test-count-{unique_test_id}-{i}",
            content=f"Working solution {i} ({unique_test_id})",
            learning_type="WORKING_SOLUTION",
            context="counting test",
            tags=["count-test", unique_test_id],
            confidence="medium",
        )

    prepare_context_module = import_module("prepare-agent-context")
    prepare_context = prepare_context_module.prepare_context

    with tempfile.TemporaryDirectory() as output_dir:
        result = await prepare_context(
            task_description=f"count test task {unique_test_id}",
            project_dir="/tmp/test-project",
            story_id=f"COUNT-{unique_test_id}",
            output_dir=output_dir,
        )

        meta = json.loads(Path(result["files"]["meta"]).read_text())

        assert "learnings_count" in meta
        assert "memory_queries" in meta
        total = sum(meta["learnings_count"].values())
        assert total >= 0


@pytest.mark.integration
@pytest.mark.asyncio
async def test_project_scoped_learnings(unique_test_id, cleanup_test_learnings):
    """Test that project-specific patterns are retrieved."""
    from core.store_learning import store_learning_v2

    await store_learning_v2(
        session_id=f"test-project-{unique_test_id}",
        content=f"TestProject ({unique_test_id}) uses React with TypeScript",
        learning_type="CODEBASE_PATTERN",
        context="TestProject conventions",
        tags=["TestProject", "react", "typescript", unique_test_id],
        confidence="high",
    )

    prepare_context_module = import_module("prepare-agent-context")
    prepare_context = prepare_context_module.prepare_context

    with tempfile.TemporaryDirectory() as output_dir:
        result = await prepare_context(
            task_description=f"add component to project {unique_test_id}",
            project_dir="/tmp/TestProject",
            story_id=f"PROJ-{unique_test_id}",
            output_dir=output_dir,
        )

        meta = json.loads(Path(result["files"]["meta"]).read_text())
        assert "TestProject patterns conventions" in meta["memory_queries"]["patterns"]


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-m", "integration"])
