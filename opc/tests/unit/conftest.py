"""Shared fixtures for opc unit tests."""
import pytest


@pytest.fixture(autouse=True)
def _isolated_memory_failure_log(monkeypatch, tmp_path):
    """Keep forced store failures out of ~/.claude/state/memory-write-failures.jsonl.

    The SessionStart health line counts that file, so a test run must never add to it.
    """
    monkeypatch.setenv("CCV3_MEMORY_FAILURE_LOG", str(tmp_path / "memory-write-failures.jsonl"))


@pytest.fixture(autouse=True)
def _isolated_memory_reject_log(monkeypatch, tmp_path):
    """Keep test rejects out of ~/.claude/state/memory-rejected-candidates.jsonl.

    Extraction reads that file to skip candidates it rejected before, so a test run
    must never add to it.
    """
    monkeypatch.setenv("CCV3_MEMORY_REJECT_LOG", str(tmp_path / "memory-rejected-candidates.jsonl"))
