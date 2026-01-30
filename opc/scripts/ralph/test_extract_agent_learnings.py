#!/usr/bin/env python3
"""Unit tests for extract-agent-learnings.py

Tests learning extraction from agent output files.
Mocks storage to test in isolation.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from importlib import import_module

extract_module = import_module("extract-agent-learnings")

format_success_learning = extract_module.format_success_learning
format_failure_learning = extract_module.format_failure_learning
generate_tags = extract_module.generate_tags
extract_and_store = extract_module.extract_and_store


class TestFormatSuccessLearning:
    def test_includes_files_modified(self):
        output = {
            "files_modified": ["src/auth.ts", "src/middleware.ts"],
            "approach_summary": "Used middleware pattern",
            "key_insight": "Middleware is effective",
            "task_type": "implement",
        }
        content = format_success_learning(output, "Implement auth")
        assert "src/auth.ts" in content
        assert "src/middleware.ts" in content

    def test_includes_approach(self):
        output = {
            "files_modified": [],
            "approach_summary": "Used factory pattern for creation",
            "key_insight": "Factories simplify testing",
            "task_type": "implement",
        }
        content = format_success_learning(output, "Create factories")
        assert "factory pattern for creation" in content

    def test_includes_key_insight(self):
        output = {
            "files_modified": [],
            "approach_summary": "Standard approach",
            "key_insight": "Cache invalidation was the key",
            "task_type": "fix",
        }
        content = format_success_learning(output, "Fix cache bug")
        assert "Key insight: Cache invalidation was the key" in content

    def test_includes_verification_status(self):
        output = {
            "files_modified": [],
            "approach_summary": "Implementation",
            "key_insight": "It works",
            "task_type": "implement",
            "verification": {
                "tests_passed": True,
                "typecheck_passed": True,
                "lint_passed": False,
            },
        }
        content = format_success_learning(output, "Task")
        assert "Tests: passed" in content
        assert "Type check: passed" in content
        assert "Lint: failed" in content

    def test_includes_learnings_applied(self):
        output = {
            "files_modified": [],
            "approach_summary": "Applied pattern",
            "key_insight": "Pattern worked",
            "task_type": "implement",
            "learnings_applied": [
                "Used middleware pattern from past session",
                "Applied caching strategy",
            ],
        }
        content = format_success_learning(output, "Task")
        assert "Applied from past learnings:" in content
        assert "middleware pattern from past session" in content
        assert "caching strategy" in content

    def test_handles_missing_fields(self):
        output = {}
        content = format_success_learning(output, "Minimal task")
        assert "Minimal task" in content
        assert "Standard implementation" in content  # default approach


class TestFormatFailureLearning:
    def test_includes_error_message(self):
        output = {
            "error_message": "Connection timeout to database",
            "failure_stage": "implementation",
            "task_type": "implement",
        }
        content = format_failure_learning(output, "Setup DB connection")
        assert "Connection timeout" in content

    def test_includes_failure_stage(self):
        output = {
            "error_message": "Type mismatch",
            "failure_stage": "testing",
            "task_type": "test",
        }
        content = format_failure_learning(output, "Write tests")
        assert "Stage: testing" in content

    def test_includes_avoid_advice(self):
        output = {
            "error_message": "Memory leak",
            "failure_stage": "implementation",
            "avoid_next_time": "Don't cache large objects",
            "task_type": "implement",
        }
        content = format_failure_learning(output, "Cache data")
        assert "Avoid: Don't cache large objects" in content

    def test_includes_files_attempted(self):
        output = {
            "files_modified": ["src/broken.ts"],
            "error_message": "Compile error",
            "failure_stage": "implementation",
            "task_type": "fix",
        }
        content = format_failure_learning(output, "Fix module")
        assert "src/broken.ts" in content
        assert "Files attempted:" in content


class TestGenerateTags:
    def test_always_includes_ralph(self):
        tags = generate_tags({}, "Any task")
        assert "ralph" in tags

    def test_includes_task_type(self):
        tags = generate_tags({"task_type": "implement"}, "Task")
        assert "implement" in tags

    def test_includes_status(self):
        tags = generate_tags({"status": "success"}, "Task")
        assert "task-success" in tags

    def test_detects_auth_keyword(self):
        tags = generate_tags({}, "Implement authentication middleware")
        assert "auth" in tags

    def test_detects_api_keyword(self):
        tags = generate_tags({}, "Create API endpoint")
        assert "api" in tags

    def test_detects_database_keywords(self):
        tags1 = generate_tags({}, "Setup database connection")
        tags2 = generate_tags({}, "Configure DB migration")
        assert "database" in tags1
        assert "database" in tags2

    def test_detects_test_keyword(self):
        tags = generate_tags({}, "Write test cases")
        assert "testing" in tags

    def test_detects_ui_keywords(self):
        tags1 = generate_tags({}, "Build UI component")
        tags2 = generate_tags({}, "Create React component")
        assert "ui" in tags1
        assert "ui" in tags2


class TestExtractAndStore:
    @pytest.mark.asyncio
    async def test_success_status_creates_working_solution(self):
        output_data = {
            "status": "success",
            "task_description": "Implement feature",
            "task_type": "implement",
            "files_modified": ["src/feature.ts"],
            "approach_summary": "Used pattern X",
            "key_insight": "Pattern X is effective",
            "verification": {"tests_passed": True},
        }

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(output_data, f)
            output_file = f.name

        try:
            with patch.object(
                extract_module,
                "store_learning_async",
                new_callable=AsyncMock,
                return_value={"success": True, "memory_id": "test-123"},
            ) as mock_store:
                result = await extract_and_store(
                    output_file=output_file,
                    story_id="TEST-001",
                    task_description="Implement feature",
                )

            assert result["learning_type"] == "WORKING_SOLUTION"
            mock_store.assert_called_once()
            call_args = mock_store.call_args
            assert call_args.kwargs["learning_type"] == "WORKING_SOLUTION"
            assert call_args.kwargs["confidence"] == "high"
        finally:
            Path(output_file).unlink()

    @pytest.mark.asyncio
    async def test_failure_status_creates_failed_approach(self):
        output_data = {
            "status": "failure",
            "task_description": "Fix bug",
            "task_type": "fix",
            "error_message": "Couldn't reproduce",
            "failure_stage": "testing",
        }

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(output_data, f)
            output_file = f.name

        try:
            with patch.object(
                extract_module,
                "store_learning_async",
                new_callable=AsyncMock,
                return_value={"success": True, "memory_id": "test-456"},
            ) as mock_store:
                result = await extract_and_store(
                    output_file=output_file,
                    story_id="TEST-002",
                    task_description="Fix bug",
                )

            assert result["learning_type"] == "FAILED_APPROACH"
            mock_store.assert_called_once()
            call_args = mock_store.call_args
            assert call_args.kwargs["learning_type"] == "FAILED_APPROACH"
        finally:
            Path(output_file).unlink()

    @pytest.mark.asyncio
    async def test_blocked_status_skipped(self):
        output_data = {
            "status": "blocked",
            "task_description": "Waiting for dep",
            "error_message": "Dependency not ready",
        }

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(output_data, f)
            output_file = f.name

        try:
            result = await extract_and_store(
                output_file=output_file,
                story_id="TEST-003",
                task_description="Waiting for dep",
            )

            assert result["success"] is True
            assert result["skipped"] is True
            assert "Blocked tasks" in result["reason"]
        finally:
            Path(output_file).unlink()

    @pytest.mark.asyncio
    async def test_missing_file_returns_error(self):
        result = await extract_and_store(
            output_file="/nonexistent/path/agent-output.json",
            story_id="TEST-004",
            task_description="Task",
        )

        assert result["success"] is False
        assert "not found" in result["error"]

    @pytest.mark.asyncio
    async def test_invalid_json_returns_error(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            f.write("{ invalid json }")
            output_file = f.name

        try:
            result = await extract_and_store(
                output_file=output_file,
                story_id="TEST-005",
                task_description="Task",
            )

            assert result["success"] is False
            assert "Invalid JSON" in result["error"]
        finally:
            Path(output_file).unlink()

    @pytest.mark.asyncio
    async def test_unknown_status_returns_error(self):
        output_data = {
            "status": "unknown_status",
            "task_description": "Task",
        }

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(output_data, f)
            output_file = f.name

        try:
            result = await extract_and_store(
                output_file=output_file,
                story_id="TEST-006",
                task_description="Task",
            )

            assert result["success"] is False
            assert "Unknown status" in result["error"]
        finally:
            Path(output_file).unlink()

    @pytest.mark.asyncio
    async def test_includes_content_preview(self):
        output_data = {
            "status": "success",
            "task_type": "implement",
            "files_modified": ["a.ts"],
            "approach_summary": "Did the thing",
            "key_insight": "It worked",
        }

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(output_data, f)
            output_file = f.name

        try:
            with patch.object(
                extract_module,
                "store_learning_async",
                new_callable=AsyncMock,
                return_value={"success": True},
            ):
                result = await extract_and_store(
                    output_file=output_file,
                    story_id="TEST-007",
                    task_description="Implement feature",
                )

            assert "content_preview" in result
            assert "Implement feature" in result["content_preview"]
        finally:
            Path(output_file).unlink()

    @pytest.mark.asyncio
    async def test_passes_project_dir_to_storage(self):
        output_data = {
            "status": "success",
            "task_type": "implement",
            "files_modified": [],
            "approach_summary": "Done",
            "key_insight": "Success",
        }

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(output_data, f)
            output_file = f.name

        try:
            with patch.object(
                extract_module,
                "store_learning_async",
                new_callable=AsyncMock,
                return_value={"success": True},
            ) as mock_store:
                await extract_and_store(
                    output_file=output_file,
                    story_id="TEST-008",
                    task_description="Task",
                    project_dir="/path/to/project",
                )

            call_args = mock_store.call_args
            assert call_args.kwargs["project_dir"] == "/path/to/project"
        finally:
            Path(output_file).unlink()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
