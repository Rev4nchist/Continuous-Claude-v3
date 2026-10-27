"""The memory scripts find the database the setup wizard configured.

Ways it can fail, one test each:
1. Only CONTINUOUS_CLAUDE_DB_URL is set (what the wizard writes), and the pool
   ignores it, falling back to the development default on port 5434.
2. An explicit override (OPC_POSTGRES_URL) no longer wins over the wizard value.
3. store_learning_v2 picks the sqlite backend (whose module does not exist)
   when only CONTINUOUS_CLAUDE_DB_URL is set.
4. The canonical schema file loses a column the memory code writes or reads.
5. The removed duplicate schema file comes back (two copies drift apart again).
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

OPC = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(OPC))
sys.path.insert(0, str(OPC / "scripts" / "core"))

from scripts.core.db import postgres_pool  # noqa: E402

WIZARD_URL = "postgresql://claude:x@localhost:5432/continuous_claude"


def _clear(monkeypatch):
    for name in postgres_pool.URL_VARS:
        monkeypatch.delenv(name, raising=False)


def test_wizard_variable_alone_is_used(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("CONTINUOUS_CLAUDE_DB_URL", WIZARD_URL)
    assert postgres_pool.get_connection_string() == WIZARD_URL


def test_explicit_override_still_wins(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("CONTINUOUS_CLAUDE_DB_URL", WIZARD_URL)
    monkeypatch.setenv("OPC_POSTGRES_URL", "postgresql://o@h:1/d")
    assert postgres_pool.get_connection_string() == "postgresql://o@h:1/d"


def test_store_uses_postgres_with_wizard_variable(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("CONTINUOUS_CLAUDE_DB_URL", WIZARD_URL)
    import db.memory_factory as factory
    import store_learning

    seen = {}

    async def fake_create(backend, **_kwargs):
        seen["backend"] = backend
        raise RuntimeError("stop after backend choice")

    monkeypatch.setattr(factory, "create_memory_service", fake_create)
    content = "Fabric capacity throttling: fail fast and cap throttle waits at 15 minutes."
    result = asyncio.run(store_learning.store_learning_v2("t", content, "WORKING_SOLUTION"))
    assert seen.get("backend") == "postgres", result


def test_schema_has_memory_columns():
    sql = (OPC.parent / "docker" / "init-schema.sql").read_text(encoding="utf-8")
    for column in ("project_id TEXT", "scope TEXT", "valid_until TIMESTAMPTZ"):
        assert f"ADD COLUMN IF NOT EXISTS {column}" in sql, column
    # valid_from is added in a guarded block that copies created_at for old rows.
    assert "ADD COLUMN valid_from TIMESTAMPTZ" in sql
    assert "SET valid_from = created_at" in sql


def test_single_schema_copy():
    assert not (OPC / "docker" / "init-schema.sql").exists()
