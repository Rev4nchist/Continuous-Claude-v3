"""Static ratchet: no new write path may skip provenance and redaction.

Ways it can fail, one test each:
1. A new raw `INSERT INTO archival_memory` appears outside the allowlist.
2. supersede.py stops calling prepare_write before its raw INSERT.
3. A new `.store(` caller passes no metadata with a "source" key.
4. A Python argv that runs store_learning.py has no --source (the CLI default would
   then label an automated write "manual").
5. The raw-insert scan misses an INSERT split across lines or spaced differently.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent.parent / "scripts"
ALLOWED_RAW_INSERT = {
    "core/db/memory_service_pg.py",  # the one insert point, enforces provenance
    "core/supersede.py",  # raw INSERT, calls prepare_write first
    "core/memory_backup.py",  # exact restore of rows as backed up (exempt)
}


RAW_INSERT = re.compile(r"INSERT\s+INTO\s+archival_memory\b", re.IGNORECASE)


def _production_files():
    for path in SCRIPTS.rglob("*.py"):
        parts = set(path.relative_to(SCRIPTS).parts)
        if parts & {"tests", "archive", "__pycache__"} or path.name.startswith("test_"):
            continue
        yield path


def _rel(path: Path) -> str:
    return path.relative_to(SCRIPTS).as_posix()


def test_raw_inserts_into_archival_memory_are_allowlisted():
    found = {
        _rel(p) for p in _production_files()
        if RAW_INSERT.search(p.read_text(encoding="utf-8"))
    }
    assert found <= ALLOWED_RAW_INSERT, f"new raw writer(s): {sorted(found - ALLOWED_RAW_INSERT)}"
    assert "core/db/memory_service_pg.py" in found  # guards against a vacuous scan


def test_supersede_calls_prepare_write():
    tree = ast.parse((SCRIPTS / "core" / "supersede.py").read_text(encoding="utf-8"))
    names = {
        n.func.id if isinstance(n.func, ast.Name) else getattr(n.func, "attr", "")
        for n in ast.walk(tree) if isinstance(n, ast.Call)
    }
    assert "prepare_write" in names


def _module_has_source_key(tree: ast.AST) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict) and any(
            isinstance(k, ast.Constant) and k.value == "source" for k in node.keys
        ):
            return True
        if (
            isinstance(node, ast.Subscript)
            and isinstance(node.slice, ast.Constant)
            and node.slice.value == "source"
        ):
            return True
    return False


def test_every_store_call_passes_metadata_with_a_source_key():
    checked = 0
    for path in _production_files():
        if _rel(path) == "core/db/memory_service_pg.py":
            continue  # defines store() and its wrapper
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "store"
            ):
                continue
            checked += 1
            kw = {k.arg: k.value for k in node.keywords}
            where = f"{_rel(path)}:{node.lineno}"
            assert "metadata" in kw, f"{where}: .store() call has no metadata= argument"
            value = kw["metadata"]
            if isinstance(value, ast.Dict):
                keys = [k.value for k in value.keys if isinstance(k, ast.Constant)]
                assert "source" in keys, f"{where}: metadata dict has no source key"
            else:
                assert _module_has_source_key(tree), f"{where}: no source key set in module"
    assert checked >= 2  # store_learning.py and index_handoffs.py


def test_raw_insert_pattern_matches_spacing_and_case_variants():
    """Breaks if the pattern goes back to one exact string."""
    for text in (
        "INSERT INTO archival_memory (a)",
        "insert  into archival_memory(a)",
        "INSERT\n    INTO archival_memory (a)",
    ):
        assert RAW_INSERT.search(text), text
    assert not RAW_INSERT.search("INSERT INTO archival_memory_backup (a)")


def test_every_python_argv_that_runs_store_learning_passes_source():
    """Breaks if an automated Python caller drops --source from its argv list."""
    checked = 0
    for path in _production_files():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.List):
                continue
            items = [e.value for e in node.elts if isinstance(e, ast.Constant)]
            if not any(isinstance(v, str) and v.endswith("store_learning.py") for v in items):
                continue
            checked += 1
            assert "--source" in items, f"{_rel(path)}:{node.lineno}: argv has no --source"
    assert checked >= 1  # health_check.py canary; guards against a vacuous scan
