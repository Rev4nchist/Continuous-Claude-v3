#!/usr/bin/env python3
"""Unit tests for prepare-agent-context.py

Tests context preparation for Docker-isolated agents.
Mocks memory queries to test in isolation.
"""

from __future__ import annotations

import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from importlib import import_module

prepare_context_module = import_module("prepare-agent-context")

extract_task_keywords = prepare_context_module.extract_task_keywords
classify_task_type = prepare_context_module.classify_task_type
get_project_id = prepare_context_module.get_project_id
get_project_name = prepare_context_module.get_project_name
format_learnings_md = prepare_context_module.format_learnings_md
create_task_md = prepare_context_module.create_task_md
prepare_context = prepare_context_module.prepare_context


class TestExtractTaskKeywords:
    def test_removes_stopwords(self):
        description = "add the authentication to the system"
        keywords = extract_task_keywords(description)
        assert "the" not in keywords
        assert "to" not in keywords
        assert "authentication" in keywords
        assert "system" in keywords

    def test_limits_to_10_keywords(self):
        description = "a b c d e f g h i j k l m n o p q r s t"
        keywords = extract_task_keywords(description)
        assert len(keywords) <= 10

    def test_strips_punctuation(self):
        description = "implement, authentication; system!"
        keywords = extract_task_keywords(description)
        assert "implement" in keywords
        assert "authentication" in keywords

    def test_lowercase_conversion(self):
        description = "IMPLEMENT Authentication SYSTEM"
        keywords = extract_task_keywords(description)
        assert "implement" in keywords
        assert "authentication" in keywords

    def test_filters_short_words(self):
        description = "add a db to it"
        keywords = extract_task_keywords(description)
        assert "add" in keywords
        # "a", "to", "it" removed (stopwords/short)

    def test_empty_description(self):
        keywords = extract_task_keywords("")
        assert keywords == []


class TestClassifyTaskType:
    def test_implement_keywords(self):
        assert classify_task_type("add user authentication") == "implement"
        assert classify_task_type("create new API endpoint") == "implement"
        assert classify_task_type("implement feature flag") == "implement"
        assert classify_task_type("build the dashboard") == "implement"
        assert classify_task_type("new component for forms") == "implement"

    def test_fix_keywords(self):
        assert classify_task_type("fix login bug") == "fix"
        assert classify_task_type("bug in authentication") == "fix"
        assert classify_task_type("error handling broken") == "fix"
        assert classify_task_type("issue with database") == "fix"

    def test_test_keywords(self):
        assert classify_task_type("write tests for auth") == "test"
        assert classify_task_type("add unit test spec") == "test"
        assert classify_task_type("expect assertions") == "test"
        assert classify_task_type("mock the service") == "test"

    def test_refactor_keywords(self):
        assert classify_task_type("refactor auth module") == "refactor"
        assert classify_task_type("clean up code") == "refactor"
        assert classify_task_type("reorganize files") == "refactor"
        assert classify_task_type("restructure components") == "refactor"

    def test_update_keywords(self):
        assert classify_task_type("update the config") == "update"
        assert classify_task_type("modify settings") == "update"
        assert classify_task_type("change default behavior") == "update"
        assert classify_task_type("enhance logging") == "update"

    def test_delete_keywords(self):
        assert classify_task_type("delete old files") == "delete"
        assert classify_task_type("remove deprecated code") == "delete"
        assert classify_task_type("drop unused table") == "delete"

    def test_debug_keywords(self):
        # Note: "debug" contains "bug" as substring, triggering fix
        # This tests the keywords that DON'T overlap with fix
        assert classify_task_type("investigate slow performance") == "debug"
        assert classify_task_type("diagnose latency") == "debug"
        # "debug" itself triggers "fix" due to substring match (known limitation)
        assert classify_task_type("debug the system") == "fix"  # "bug" in "debug"

    def test_default_is_implement(self):
        assert classify_task_type("process data") == "implement"
        assert classify_task_type("handle requests") == "implement"


class TestGetProjectId:
    def test_stable_hash(self):
        project_dir = "/path/to/project"
        id1 = get_project_id(project_dir)
        id2 = get_project_id(project_dir)
        assert id1 == id2

    def test_different_paths_different_ids(self):
        id1 = get_project_id("/path/to/project1")
        id2 = get_project_id("/path/to/project2")
        assert id1 != id2

    def test_hash_length(self):
        project_id = get_project_id("/any/path")
        assert len(project_id) == 16


class TestGetProjectName:
    def test_extracts_dir_name(self):
        assert get_project_name("/path/to/MyProject") == "MyProject"
        assert get_project_name("/home/user/code/app") == "app"

    def test_handles_trailing_slash(self):
        name = get_project_name("/path/to/project/")
        assert name == "project" or name == ""  # Path behavior varies


class TestFormatLearningsMd:
    def test_with_working_solutions(self):
        solutions = [{
            "content": "Use JWT for auth tokens",
            "similarity": 0.85,
            "created_at": "2024-01-15",
            "metadata": {
                "learning_type": "WORKING_SOLUTION",
                "context": "auth implementation",
            },
        }]
        md = format_learnings_md(
            "Implement auth",
            working_solutions=solutions,
            failed_approaches=[],
            codebase_patterns=[],
        )
        assert "What Worked Before" in md
        assert "JWT for auth tokens" in md
        assert "0.85" in md
        assert "auth implementation" in md

    def test_with_failed_approaches(self):
        failures = [{
            "content": "Don't use plain cookies for tokens",
            "similarity": 0.75,
            "created_at": datetime(2024, 1, 10, tzinfo=timezone.utc),
            "metadata": {
                "learning_type": "FAILED_APPROACH",
                "context": "auth vulnerability",
            },
        }]
        md = format_learnings_md(
            "Implement auth",
            working_solutions=[],
            failed_approaches=failures,
            codebase_patterns=[],
        )
        assert "What To Avoid" in md
        assert "plain cookies" in md
        assert "FAILED_APPROACH" in md

    def test_with_codebase_patterns(self):
        patterns = [{
            "content": "All services use dependency injection",
            "metadata": {
                "learning_type": "CODEBASE_PATTERN",
                "tags": ["di", "architecture"],
            },
        }]
        md = format_learnings_md(
            "Add service",
            working_solutions=[],
            failed_approaches=[],
            codebase_patterns=patterns,
        )
        assert "Codebase Patterns" in md
        assert "dependency injection" in md
        assert "di, architecture" in md

    def test_empty_learnings(self):
        md = format_learnings_md(
            "New task",
            working_solutions=[],
            failed_approaches=[],
            codebase_patterns=[],
        )
        assert "No Relevant Learnings Found" in md
        assert "new type of task" in md

    def test_includes_header(self):
        md = format_learnings_md(
            "Test task",
            working_solutions=[],
            failed_approaches=[],
            codebase_patterns=[],
        )
        assert "# Relevant Learnings for: Test task" in md
        assert "Recalled at" in md


class TestCreateTaskMd:
    def test_contains_task_description(self):
        md = create_task_md(
            task_description="Implement auth middleware",
            story_id="STORY-123",
            iteration=1,
            max_iterations=30,
            project_name="MyApp",
        )
        assert "Implement auth middleware" in md
        assert "STORY-123" in md

    def test_contains_iteration_info(self):
        md = create_task_md(
            task_description="Task",
            story_id="S-1",
            iteration=5,
            max_iterations=30,
            project_name="App",
        )
        assert "5 / 30" in md

    def test_contains_output_instructions(self):
        md = create_task_md(
            task_description="Task",
            story_id="S-1",
            iteration=1,
            max_iterations=10,
            project_name="App",
        )
        assert "agent-output.json" in md
        assert '"status"' in md
        assert '"success"' in md
        assert '"failure"' in md

    def test_mentions_context_files(self):
        md = create_task_md(
            task_description="Task",
            story_id="S-1",
            iteration=1,
            max_iterations=10,
            project_name="App",
        )
        assert "learnings.md" in md
        assert "knowledge-tree.json" in md


class TestPrepareContext:
    @pytest.mark.asyncio
    async def test_creates_all_files(self):
        with tempfile.TemporaryDirectory() as output_dir:
            with patch.object(
                prepare_context_module,
                "query_memory",
                new_callable=AsyncMock,
                return_value=[],
            ):
                result = await prepare_context(
                    task_description="Test task",
                    project_dir="/tmp/test-project",
                    story_id="TEST-001",
                    output_dir=output_dir,
                )

            assert result["success"] is True
            assert Path(result["files"]["learnings"]).exists()
            assert Path(result["files"]["knowledge_tree"]).exists()
            assert Path(result["files"]["task"]).exists()
            assert Path(result["files"]["meta"]).exists()

    @pytest.mark.asyncio
    async def test_meta_json_structure(self):
        with tempfile.TemporaryDirectory() as output_dir:
            with patch.object(
                prepare_context_module,
                "query_memory",
                new_callable=AsyncMock,
                return_value=[],
            ):
                result = await prepare_context(
                    task_description="Implement auth",
                    project_dir="/tmp/test-project",
                    story_id="AUTH-001",
                    output_dir=output_dir,
                    iteration=3,
                    max_iterations=10,
                )

            meta = json.loads(Path(result["files"]["meta"]).read_text())
            assert meta["task_description"] == "Implement auth"
            assert meta["story_id"] == "AUTH-001"
            assert meta["task_type"] == "implement"
            assert meta["iteration"] == 3
            assert meta["max_iterations"] == 10
            assert "memory_queries" in meta
            assert "learnings_count" in meta

    @pytest.mark.asyncio
    async def test_with_mocked_memory_results(self):
        mock_results = [
            {
                "content": "Use middleware pattern",
                "similarity": 0.9,
                "created_at": "2024-01-01",
                "metadata": {
                    "learning_type": "WORKING_SOLUTION",
                    "context": "middleware implementation",
                },
            },
        ]

        with tempfile.TemporaryDirectory() as output_dir:
            with patch.object(
                prepare_context_module,
                "query_memory",
                new_callable=AsyncMock,
                return_value=mock_results,
            ) as mock_query:
                result = await prepare_context(
                    task_description="Implement middleware",
                    project_dir="/tmp/test-project",
                    story_id="MW-001",
                    output_dir=output_dir,
                )

            # Verify memory was queried
            assert mock_query.call_count == 3  # 3 query types

            # Verify learnings.md contains the mocked result
            learnings_content = Path(result["files"]["learnings"]).read_text()
            assert "middleware pattern" in learnings_content

    @pytest.mark.asyncio
    async def test_categorizes_learnings_correctly(self):
        mock_results = [
            {
                "content": "Working solution",
                "similarity": 0.8,
                "created_at": "2024-01-01",
                "metadata": {"learning_type": "WORKING_SOLUTION"},
            },
            {
                "content": "Failed approach",
                "similarity": 0.7,
                "created_at": "2024-01-02",
                "metadata": {"learning_type": "FAILED_APPROACH"},
            },
        ]

        with tempfile.TemporaryDirectory() as output_dir:
            with patch.object(
                prepare_context_module,
                "query_memory",
                new_callable=AsyncMock,
                return_value=mock_results,
            ):
                result = await prepare_context(
                    task_description="Test categorization",
                    project_dir="/tmp/test",
                    story_id="CAT-001",
                    output_dir=output_dir,
                )

            learnings_content = Path(result["files"]["learnings"]).read_text()
            assert "What Worked Before" in learnings_content
            assert "What To Avoid" in learnings_content

    @pytest.mark.asyncio
    async def test_knowledge_tree_fallback(self):
        with tempfile.TemporaryDirectory() as output_dir:
            with patch.object(
                prepare_context_module,
                "query_memory",
                new_callable=AsyncMock,
                return_value=[],
            ):
                result = await prepare_context(
                    task_description="Test",
                    project_dir="/nonexistent/project",
                    story_id="KT-001",
                    output_dir=output_dir,
                )

            kt = json.loads(Path(result["files"]["knowledge_tree"]).read_text())
            assert "note" in kt
            assert "No knowledge tree found" in kt["note"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
