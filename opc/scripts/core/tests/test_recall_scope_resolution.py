"""Scope RESOLUTION tests for recall_learnings.

Why this file exists separately from test_recall_project_scope.py: that file
tests the SQL built *given* a project_id -- the half that always worked. Nothing
tested how the project_id is DERIVED, so a bug there was invisible for as long
as it existed.

The bug: _is_registered_project() answered a bool for "is CWD inside a
registered project", matching subdirectories by prefix, and the caller then
hashed the CWD. From <repo>/opc that yields a project_id no stored row carries,
so mode was still 'project', the SQL still ran, and it matched nothing.
PROJECT-scoped recall silently degraded to GLOBAL-only and read as "no relevant
memories". The documented invocation -- `cd $CLAUDE_OPC_DIR && ... recall` --
runs from exactly such a subdirectory, so PROJECT recall had never worked from
the canonical call site. Two handoffs recorded it as a suspected break in the
read path; the read path was fine.

The regression these lock down is therefore: derive from the matched project
ROOT, never from the path you were handed.
"""

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import recall_learnings as R  # noqa: E402
from project_memory import get_project_id  # noqa: E402


@pytest.fixture
def registry(tmp_path, monkeypatch):
    """Point the registry resolver at a temp registry and return a builder."""

    def build(*project_dirs: Path):
        reg = tmp_path / "project-registry.json"
        reg.write_text(
            json.dumps({"projects": [{"path": str(p)} for p in project_dirs]}),
            encoding="utf-8",
        )
        monkeypatch.setattr(R, "_resolve_registry_path", lambda: reg)
        return reg

    return build


def _mkproj(tmp_path: Path, name: str) -> Path:
    p = tmp_path / name
    p.mkdir(parents=True, exist_ok=True)
    return p


def test_cwd_at_project_root_resolves_to_root(tmp_path, registry, monkeypatch):
    root = _mkproj(tmp_path, "repo")
    registry(root)
    monkeypatch.chdir(root)
    monkeypatch.delenv("CLAUDE_PROJECT_ID", raising=False)

    pid, mode = R.resolve_recall_scope()
    assert mode == "project"
    assert pid == get_project_id(str(root))


def test_cwd_in_subdirectory_still_resolves_to_ROOT(tmp_path, registry, monkeypatch):
    """THE REGRESSION. `cd $CLAUDE_OPC_DIR` is the documented call site."""
    root = _mkproj(tmp_path, "repo")
    sub = root / "opc"
    sub.mkdir()
    registry(root)
    monkeypatch.chdir(sub)
    monkeypatch.delenv("CLAUDE_PROJECT_ID", raising=False)

    pid, mode = R.resolve_recall_scope()
    assert mode == "project"
    assert pid == get_project_id(str(root)), (
        "must hash the project ROOT; hashing the subdirectory yields an id no "
        "stored row carries, which silently degrades PROJECT recall to GLOBAL-only"
    )
    assert pid != get_project_id(str(sub)), "hashing the CWD is the bug"


def test_deeply_nested_subdirectory_resolves_to_root(tmp_path, registry, monkeypatch):
    root = _mkproj(tmp_path, "repo")
    deep = root / "a" / "b" / "c"
    deep.mkdir(parents=True)
    registry(root)
    monkeypatch.chdir(deep)
    monkeypatch.delenv("CLAUDE_PROJECT_ID", raising=False)

    pid, _ = R.resolve_recall_scope()
    assert pid == get_project_id(str(root))


def test_unregistered_cwd_fails_safe_to_global_only(tmp_path, registry, monkeypatch):
    root = _mkproj(tmp_path, "repo")
    outside = _mkproj(tmp_path, "elsewhere")
    registry(root)
    monkeypatch.chdir(outside)
    monkeypatch.delenv("CLAUDE_PROJECT_ID", raising=False)

    pid, mode = R.resolve_recall_scope()
    assert mode == "global_only"
    assert pid is None


def test_nested_projects_resolve_to_the_innermost(tmp_path, registry, monkeypatch):
    """Longest match wins, not registry order -- otherwise a project nested
    inside another silently answers with its parent's id."""
    outer = _mkproj(tmp_path, "outer")
    inner = outer / "packages" / "inner"
    inner.mkdir(parents=True)
    registry(outer, inner)  # outer listed FIRST on purpose
    monkeypatch.chdir(inner)
    monkeypatch.delenv("CLAUDE_PROJECT_ID", raising=False)

    pid, _ = R.resolve_recall_scope()
    assert pid == get_project_id(str(inner))


def test_sibling_with_shared_prefix_is_not_matched(tmp_path, registry, monkeypatch):
    """`/repo-tools` must not match the project `/repo` -- prefix matching has
    to be path-segment aware, not string-prefix aware."""
    root = _mkproj(tmp_path, "repo")
    sibling = _mkproj(tmp_path, "repo-tools")
    registry(root)
    monkeypatch.chdir(sibling)
    monkeypatch.delenv("CLAUDE_PROJECT_ID", raising=False)

    _, mode = R.resolve_recall_scope()
    assert mode == "global_only"


def test_explicit_env_override_still_wins(tmp_path, registry, monkeypatch):
    root = _mkproj(tmp_path, "repo")
    registry(root)
    monkeypatch.chdir(root)
    monkeypatch.setenv("CLAUDE_PROJECT_ID", "deadbeefdeadbeef")

    pid, mode = R.resolve_recall_scope()
    assert (pid, mode) == ("deadbeefdeadbeef", "project")


def test_is_registered_project_wrapper_still_answers_bool(tmp_path, registry, monkeypatch):
    root = _mkproj(tmp_path, "repo")
    sub = root / "opc"
    sub.mkdir()
    registry(root)

    assert R._is_registered_project(str(sub)) is True
    assert R._is_registered_project(str(tmp_path / "elsewhere")) is False


def test_the_real_registry_resolves_this_repo_from_opc():
    """Integration guard against the ACTUAL registry, not a fixture.

    The fixture tests would all pass against a registry whose paths had drifted.
    This one asserts the live file still maps <repo>/opc to <repo>.
    """
    here = Path(__file__).resolve()
    repo_root = None
    for parent in here.parents:
        if (parent / ".claude" / "project-registry.json").exists():
            repo_root = parent
            break
    if repo_root is None:
        pytest.skip("no project-registry.json above this test")

    opc_dir = repo_root / "opc"
    if not opc_dir.is_dir():
        pytest.skip("no opc/ subdirectory in this checkout")

    assert R._resolve_registered_root(str(opc_dir)) is not None, (
        "the live registry no longer maps this repo -- PROJECT recall would "
        "silently fall back to GLOBAL-only"
    )
    assert Path(R._resolve_registered_root(str(opc_dir))).resolve() == repo_root.resolve()
