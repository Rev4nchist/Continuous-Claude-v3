#!/usr/bin/env python3
"""Test suite for project-scoped memory system.

Tests:
1. Scope classification (GLOBAL vs PROJECT)
2. Project ID generation
3. Local index operations (init, update, query)
4. Store learning with scope
5. Memory service integration
"""

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

# Current directory must come BEFORE parent to import updated store_learning
current_dir = os.path.dirname(__file__)
parent_dir = os.path.join(current_dir, "..")
# Remove any existing paths that might conflict
sys.path = [p for p in sys.path if 'core' not in p or 'core\\core' in p or 'core/core' in p]
sys.path.insert(0, current_dir)
sys.path.insert(1, parent_dir)

from store_learning import (
    GLOBAL_KEYWORDS,
    PROJECT_KEYWORDS,
    classify_scope,
    get_project_id,
)
from project_memory import (
    init_project_index,
    load_index,
    save_index,
    update_index,
    search_local_topics,
    extract_topics,
    parse_handoff,
    get_memory_dir,
)


class TestScopeClassification:
    """Test scope classification logic."""

    def test_global_keywords_detected(self):
        """Content with global keywords should be classified as GLOBAL."""
        content = "Windows platform issue with hooks and TypeScript async patterns"
        scope = classify_scope(content)
        assert scope == "GLOBAL", f"Expected GLOBAL, got {scope}"

    def test_project_keywords_detected(self):
        """Content with project-specific paths should be PROJECT."""
        content = "Fixed bug in src/components/Button.tsx affecting package.json"
        scope = classify_scope(content)
        assert scope == "PROJECT", f"Expected PROJECT, got {scope}"

    def test_mixed_content_global_wins(self):
        """When global keywords outnumber project keywords, GLOBAL wins."""
        content = "Windows Docker kubernetes postgres issue in src/api"
        scope = classify_scope(content)
        assert scope == "GLOBAL", f"Expected GLOBAL (4 global vs 1 project), got {scope}"

    def test_tags_influence_classification(self):
        """Tags should be considered in classification."""
        content = "Fixed a bug"
        tags = ["windows", "hooks", "platform"]
        scope = classify_scope(content, tags=tags)
        assert scope == "GLOBAL", f"Expected GLOBAL from tags, got {scope}"

    def test_context_influences_classification(self):
        """Context string should be considered."""
        content = "Made some changes"
        context = "git workflow npm installation docker"
        scope = classify_scope(content, context=context)
        assert scope == "GLOBAL", f"Expected GLOBAL from context, got {scope}"

    def test_default_is_project(self):
        """Without strong signals, default to PROJECT."""
        content = "Updated the configuration file"
        scope = classify_scope(content)
        assert scope == "PROJECT", f"Expected PROJECT (default), got {scope}"

    def test_single_global_keyword_not_enough(self):
        """Need at least 2 global keywords to classify as GLOBAL."""
        content = "Fixed a Windows issue"
        scope = classify_scope(content)
        assert scope == "PROJECT", f"Expected PROJECT (only 1 global keyword), got {scope}"


class TestProjectIdGeneration:
    """Test project ID generation from paths."""

    def test_stable_project_id(self):
        """Same path should always generate same ID."""
        path = "/home/user/projects/myapp"
        id1 = get_project_id(path)
        id2 = get_project_id(path)
        assert id1 == id2, "Project ID should be stable"

    def test_different_paths_different_ids(self):
        """Different paths should generate different IDs."""
        id1 = get_project_id("/home/user/project1")
        id2 = get_project_id("/home/user/project2")
        assert id1 != id2, "Different paths should have different IDs"

    def test_none_path_returns_none(self):
        """None path should return None."""
        result = get_project_id(None)
        assert result is None

    def test_id_length(self):
        """Project ID should be 16 characters (first 16 of sha256 hex)."""
        pid = get_project_id("/some/path")
        assert len(pid) == 16, f"Expected 16 chars, got {len(pid)}"


class TestLocalIndexOperations:
    """Test local .claude/memory/index.json operations."""

    def test_init_creates_directory_and_file(self):
        """init_project_index should create directory structure."""
        with tempfile.TemporaryDirectory() as tmpdir:
            index = init_project_index(tmpdir)

            memory_dir = get_memory_dir(tmpdir)
            assert memory_dir.exists(), "Memory directory should be created"
            assert (memory_dir / "handoffs").exists(), "Handoffs subdirectory should exist"
            assert (memory_dir / "index.json").exists(), "index.json should be created"
            assert index["version"] == "1.0"
            assert "project_id" in index
            assert "sessions" in index
            assert "topic_index" in index

    def test_load_nonexistent_returns_none(self):
        """load_index on nonexistent directory should return None."""
        result = load_index("/nonexistent/path/12345")
        assert result is None

    def test_save_and_load_roundtrip(self):
        """Saving and loading should preserve data."""
        with tempfile.TemporaryDirectory() as tmpdir:
            index = init_project_index(tmpdir)
            index["sessions"]["test-session"] = {"name": "test", "tasks": []}
            save_index(tmpdir, index)

            loaded = load_index(tmpdir)
            assert "test-session" in loaded["sessions"]


class TestTopicExtraction:
    """Test topic extraction from handoff content."""

    def test_extracts_known_topics(self):
        """Known topic keywords should be extracted."""
        handoff = {
            "goal": "Implement authentication with JWT tokens",
            "now": "Testing the login flow",
            "decisions": {"auth_method": "Use JWT for API auth"},
        }
        topics = extract_topics(handoff)
        assert "authentication" in topics or "auth" in topics
        assert "testing" in topics or "test" in topics

    def test_empty_handoff_returns_empty(self):
        """Empty handoff should return empty list."""
        handoff = {}
        topics = extract_topics(handoff)
        assert topics == []


class TestHandoffParsing:
    """Test handoff file parsing."""

    def test_parse_yaml_handoff(self):
        """Should parse YAML handoff files."""
        with tempfile.TemporaryDirectory() as tmpdir:
            filepath = Path(tmpdir) / "test.yaml"
            filepath.write_text("""
session: test-session
goal: Implement feature X
now: Working on tests
status: SUCCEEDED
decisions:
  approach: Use pattern A
""")
            result = parse_handoff(str(filepath))
            assert result is not None
            assert result["session"] == "test-session"
            assert result["goal"] == "Implement feature X"
            assert result["outcome"] == "SUCCEEDED"

    def test_parse_md_handoff(self):
        """Should parse Markdown handoff files."""
        with tempfile.TemporaryDirectory() as tmpdir:
            filepath = Path(tmpdir) / "test.md"
            filepath.write_text("""
## Goal
Implement the new feature

### Now
Testing implementation
""")
            result = parse_handoff(str(filepath))
            assert result is not None
            assert "Implement the new feature" in result.get("goal", "")

    def test_parse_nonexistent_returns_none(self):
        """Nonexistent file should return None."""
        result = parse_handoff("/nonexistent/file.yaml")
        assert result is None


class TestLocalTopicSearch:
    """Test local topic index search."""

    def test_keyword_match_returns_results(self):
        """Matching keywords should return results."""
        with tempfile.TemporaryDirectory() as tmpdir:
            index = init_project_index(tmpdir)
            index["sessions"]["session-abc12345"] = {
                "name": "auth-session",
                "tasks": [{"id": "task1", "summary": "Implement auth", "outcome": "SUCCEEDED"}]
            }
            index["topic_index"]["authentication"] = ["session-abc12345/task1"]
            save_index(tmpdir, index)

            results = search_local_topics(tmpdir, "authentication", k=5)
            assert len(results) > 0
            assert results[0]["task_id"] == "task1"

    def test_no_match_returns_empty(self):
        """Non-matching query should return empty list."""
        with tempfile.TemporaryDirectory() as tmpdir:
            init_project_index(tmpdir)
            results = search_local_topics(tmpdir, "nonexistent-topic-xyz", k=5)
            assert results == []


class TestIntegration:
    """Integration tests requiring database connection."""

    def test_scope_classification_integration(self):
        """Test classify_scope with various inputs."""
        # GLOBAL: Windows + hooks + TypeScript (3 global keywords)
        scope = classify_scope(
            "Windows hook development pattern for TypeScript",
            context="hook development",
        )
        assert scope == "GLOBAL"

        # PROJECT: project-specific path
        scope = classify_scope(
            "Fixed bug in src/components/Button.tsx",
            context="component styling",
        )
        assert scope == "PROJECT"

    def test_project_id_with_scope(self):
        """Test project_id generation works with classify_scope."""
        project_id = get_project_id("/test/project")
        assert project_id is not None
        assert len(project_id) == 16

        # Classify some content
        scope = classify_scope("Platform-specific Windows issue with Docker")
        assert scope == "GLOBAL"


def run_tests():
    """Run all tests and report results."""
    pytest.main([__file__, "-v", "--tb=short"])


if __name__ == "__main__":
    run_tests()
