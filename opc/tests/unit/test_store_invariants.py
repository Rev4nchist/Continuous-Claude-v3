"""MemoryServicePG.store() is the one insert point. It enforces provenance.

No database: get_transaction is replaced by a fake connection that records the
execute arguments.

Ways it can fail, one test each:
1. The inserted metadata lacks source, session_id, is_inference or provenance_v
   (store() does not call prepare_write).
2. A store with no source runs SQL, or raises after the transaction opened.
3. Content with a key is stored raw (the redaction backstop is removed), or the
   late flag is not set.
4. The column session id stays "default" while metadata says otherwise.
5. store_with_embedding bypasses the check.
"""
from __future__ import annotations

import contextlib
import json
import sys
from pathlib import Path

import pytest

OPC = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(OPC))
sys.path.insert(0, str(OPC / "scripts" / "core"))

from db import memory_service_pg as msp  # noqa: E402

from tests.unit import fake_secrets as fs  # noqa: E402


class FakeConn:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple]] = []

    async def execute(self, sql, *args):
        self.calls.append((sql, args))


@pytest.fixture
def conn(monkeypatch):
    fake = FakeConn()
    entered = {"n": 0}

    @contextlib.asynccontextmanager
    async def fake_tx():
        entered["n"] += 1
        yield fake

    monkeypatch.setattr(msp, "get_transaction", fake_tx)
    fake.entered = entered
    return fake


def _insert_args(conn: FakeConn):
    (sql, args) = conn.calls[0]
    assert "INSERT INTO archival_memory" in sql
    # (id, session_id, agent_id, content, metadata_json, scope, project_id)
    return {"session_id": args[1], "content": args[3], "metadata": json.loads(args[4])}


async def test_insert_carries_full_provenance(conn):
    svc = msp.MemoryServicePG(session_id="sess-1")
    await svc.store("a plain learning", metadata={"source": "hook", "is_inference": True})
    row = _insert_args(conn)
    md = row["metadata"]
    assert md["source"] == "hook" and md["is_inference"] is True
    assert md["session_id"] == "sess-1" == row["session_id"]
    assert md["provenance_v"] == 1


async def test_missing_source_raises_before_any_sql(conn):
    svc = msp.MemoryServicePG(session_id="sess-1")
    with pytest.raises(ValueError, match="source"):
        await svc.store("a plain learning", metadata={"type": "session_learning"})
    with pytest.raises(ValueError, match="source"):
        await svc.store("a plain learning")
    assert conn.calls == []
    assert conn.entered["n"] == 0


async def test_unknown_source_raises(conn):
    svc = msp.MemoryServicePG(session_id="sess-1")
    with pytest.raises(ValueError, match="source"):
        await svc.store("a plain learning", metadata={"source": "bogus"})
    assert conn.calls == []


async def test_content_with_a_key_is_stored_redacted_with_the_late_flag(conn):
    svc = msp.MemoryServicePG(session_id="sess-1")
    await svc.store("exported " + fs.anthropic_key() + " first", metadata={"source": "manual"})
    row = _insert_args(conn)
    assert "aaaa" not in row["content"]
    assert "[REDACTED:provider_token]" in row["content"]
    assert row["metadata"]["redacted_late"] is True
    assert row["metadata"]["redacted_kinds"] == ["provider_token"]


async def test_default_session_id_becomes_the_sentinel_in_column_and_metadata(conn):
    svc = msp.MemoryServicePG()  # session_id defaults to "default"
    await svc.store("a plain learning", metadata={"source": "manual"})
    row = _insert_args(conn)
    assert row["session_id"] == "unknown-session"
    assert row["metadata"]["session_id"] == "unknown-session"


async def test_store_with_embedding_goes_through_the_same_check(conn):
    svc = msp.MemoryServicePG(session_id="s")
    with pytest.raises(ValueError, match="source"):
        await svc.store_with_embedding("a plain learning", {"type": "x"}, None)
    assert conn.calls == []


async def test_secret_in_a_direct_tag_is_cut_and_flagged_late(conn):
    """Breaks if tag hits are dropped: the tag is cut but the row is not flagged."""
    svc = msp.MemoryServicePG(session_id="sess-1")
    await svc.store(
        "a plain learning", metadata={"source": "manual"}, tags=["ok-tag", fs.github_token()]
    )
    row = _insert_args(conn)
    assert row["metadata"]["redacted_late"] is True
    assert row["metadata"]["redacted_kinds"] == ["provider_token"]
    tag_values = {args[1] for _sql, args in conn.calls[1:]}
    assert "ok-tag" in tag_values
    assert all("bbbb" not in t for t in tag_values)


async def test_store_with_embedding_redacts_before_the_embedder_sees_the_text(conn, monkeypatch):
    """Breaks if the embed runs on the raw text (the vector would encode the secret)."""
    seen: list[str] = []

    async def no_pgvector(_conn):
        return None

    monkeypatch.setattr(msp, "init_pgvector", no_pgvector)

    class Embedder:
        async def embed(self, text):
            seen.append(text)
            return [0.1] * 8

    svc = msp.MemoryServicePG(session_id="sess-1")
    await svc.store_with_embedding(
        "exported " + fs.anthropic_key() + " first", {"source": "manual"}, Embedder()
    )
    assert seen and all("aaaa" not in t for t in seen)
    row = _insert_args(conn)
    assert "aaaa" not in row["content"]
    assert "redacted_late" not in row["metadata"]
    assert row["metadata"]["redacted_kinds"] == ["provider_token"]
