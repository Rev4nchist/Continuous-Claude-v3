"""store_learning_v2: redaction before the embedding, schema check, reject log, provenance.

The memory factory and the embedder are replaced (same seam as
test_memory_write_log.py). No database, no model load.

Ways it can fail, one test each:
1. The embedder sees the raw secret (redaction after the embed).
2. context and tags keep the secret (only content is redacted).
3. source, is_inference or evidence do not reach the metadata, or kinds are missing.
4. A gate A reject leaves no hash line, or the line holds the content.
5. A duplicate skip is logged as a reject.
6. A source outside the enum is stored, or its reason is not "schema:source...".
7. The CLI defaults change (session id sentinel, source, --inferred).
8. The fake factory is bypassed, so a test could reach the real database.
9. A missing source is silent (it must reach the failure log).
10. v1 store_learning and the extractor pass a candidate_hash through.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

OPC = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(OPC))
sys.path.insert(0, str(OPC / "scripts" / "core"))

import memory_reject_log as rl  # noqa: E402
import store_learning  # noqa: E402
from db.memory_provenance import prepare_write  # noqa: E402

from tests.unit import fake_secrets as fs  # noqa: E402

KEY = fs.anthropic_key()
CONTENT = (
    "Fixed the deploy: the build failed until the token " + KEY
    + " was exported before the build step; the build now passes."
)


class FakeMemory:
    def __init__(self, similarity: float | None = None) -> None:
        self.stored: list[dict] = []
        self.closed = False
        self._similarity = similarity

    async def search_vector_for_dedup(self, embedding, **_kw):
        if self._similarity is None:
            return []
        return [{"similarity": self._similarity, "id": "existing-1"}]

    async def store(self, content, metadata=None, embedding=None, **kw):
        # Run the real store() backstop on what the caller passed. "late" is true when
        # the caller let a secret through to the embedding.
        _c, backstop_md, _sid = prepare_write(content, metadata, "s1")
        late = bool(backstop_md.get("redacted_late"))
        self.stored.append({"content": content, "metadata": metadata, "late": late, **kw})
        return "mem-1"

    async def close(self):
        self.closed = True


class FakeEmbedder:
    def __init__(self) -> None:
        self.seen: list[str] = []

    async def embed(self, text):
        self.seen.append(text)
        return [0.1] * 8


@pytest.fixture
def seam(monkeypatch):
    import db.memory_factory as factory

    state = {"memory": FakeMemory(), "factory_calls": 0}
    embedder = FakeEmbedder()

    async def fake_create(backend, **_kwargs):
        state["factory_calls"] += 1
        return state["memory"]

    monkeypatch.setattr(factory, "create_memory_service", fake_create)
    monkeypatch.setattr(store_learning, "get_embedder", lambda: embedder)
    state["embedder"] = embedder
    return state


def _reject_lines() -> list[dict]:
    path = rl.reject_log_path()
    if not path.exists():
        return []
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines()]


async def test_embedder_receives_redacted_text_and_row_has_the_marker(seam):
    result = await store_learning.store_learning_v2(
        "s1", CONTENT, "WORKING_SOLUTION", source="manual"
    )
    assert result["success"] is True and result["memory_id"] == "mem-1"
    assert all("aaaa" not in seen for seen in seam["embedder"].seen)
    (row,) = seam["memory"].stored
    assert "[REDACTED:provider_token]" in row["content"] and "aaaa" not in row["content"]
    assert row["late"] is False


async def test_context_and_tags_are_redacted(seam):
    await store_learning.store_learning_v2(
        "s1", CONTENT, "WORKING_SOLUTION", context="seen with " + KEY,
        tags=["ok-tag", KEY], source="manual",
    )
    (row,) = seam["memory"].stored
    md = row["metadata"]
    assert "aaaa" not in md["context"]
    assert md["tags"][0] == "ok-tag" and "aaaa" not in md["tags"][1]
    assert row["late"] is False


async def test_provenance_params_reach_the_metadata(seam):
    ev = {"kind": "thinking_block", "line": 3, "hash": "0123456789abcdef"}
    await store_learning.store_learning_v2(
        "s1", CONTENT, "WORKING_SOLUTION", source="llm", is_inference=True, evidence=ev,
    )
    (row,) = seam["memory"].stored
    md = row["metadata"]
    assert md["source"] == "llm" and md["is_inference"] is True
    assert md["session_id"] == "s1" and md["evidence"] == ev
    assert md["redacted_kinds"] == ["provider_token"]
    assert row["late"] is False  # the backstop found nothing the caller missed


async def test_clean_row_has_no_redaction_keys(seam):
    await store_learning.store_learning_v2(
        "s1", "Use a lock file so two syncs never run at once; the second sync waits.",
        "WORKING_SOLUTION", source="manual",
    )
    (row,) = seam["memory"].stored
    assert "redacted_kinds" not in row["metadata"]
    assert row["metadata"]["is_inference"] is False


async def test_gate_a_reject_logs_one_hash_line_without_content(seam):
    result = await store_learning.store_learning_v2(
        "s1", "Let me think about the deployment order again", "WORKING_SOLUTION",
        source="hook", candidate_hash="0123456789abcdef",
    )
    assert result["skipped"] is True and result["reason"].startswith("noise_prefix")
    (line,) = _reject_lines()
    assert line["hash"] == "0123456789abcdef" and line["stage"] == "gate_a"
    assert line["source"] == "hook" and line["session_id"] == "s1"
    assert "content" not in line and "deployment" not in json.dumps(line)
    assert seam["memory"].stored == []


async def test_gate_a_reject_without_candidate_hash_hashes_the_redacted_content(seam):
    text = "Let me think about " + KEY
    await store_learning.store_learning_v2("s1", text, "WORKING_SOLUTION", source="hook")
    (line,) = _reject_lines()
    redacted = "Let me think about [REDACTED:provider_token]"
    assert line["hash"] == rl.content_hash(redacted)


async def test_duplicate_skip_is_not_logged(seam):
    seam["memory"] = FakeMemory(similarity=0.97)
    result = await store_learning.store_learning_v2(
        "s1", CONTENT, "WORKING_SOLUTION", source="manual"
    )
    assert result["skipped"] is True and result["reason"].startswith("duplicate")
    assert _reject_lines() == []


async def test_bad_source_is_a_schema_reject(seam):
    result = await store_learning.store_learning_v2(
        "s1", CONTENT, "WORKING_SOLUTION", source="bogus", candidate_hash="fedcba9876543210",
    )
    assert result["success"] is True and result["skipped"] is True
    assert result["reason"].startswith("schema:source")
    (line,) = _reject_lines()
    assert line["stage"] == "schema" and line["hash"] == "fedcba9876543210"
    assert seam["memory"].stored == []


async def test_missing_source_is_a_failure_that_reaches_the_failure_log(seam):
    from memory_write_log import failure_log_path

    result = await store_learning.store_learning_v2("s1", CONTENT, "WORKING_SOLUTION")
    assert result["success"] is False and "source" in result["error"]
    logged = failure_log_path().read_text(encoding="utf-8")
    assert "source" in logged and "aaaa" not in logged
    assert seam["memory"].stored == []


async def test_empty_session_id_is_replaced_by_the_sentinel_not_rejected(seam):
    result = await store_learning.store_learning_v2(
        "", CONTENT, "WORKING_SOLUTION", source="manual"
    )
    assert result["success"] is True and not result.get("skipped")
    assert seam["memory"].stored[0]["metadata"]["session_id"] == "unknown-session"


async def test_the_fake_factory_was_used(seam):
    await store_learning.store_learning_v2("s1", CONTENT, "WORKING_SOLUTION", source="manual")
    assert seam["factory_calls"] == 1 and seam["memory"].closed is True


async def test_v1_entrypoint_passes_source_manual(monkeypatch):
    calls = []

    async def fake_v2(**kwargs):
        calls.append(kwargs)
        return {"success": True, "memory_id": "x"}

    monkeypatch.setattr(store_learning, "store_learning_v2", fake_v2)
    with pytest.warns(DeprecationWarning):
        await store_learning.store_learning(
            "s1", "The worked path is long enough to store.", "None", "None", "None"
        )
    assert calls[0]["source"] == "manual" and calls[0]["is_inference"] is False


def test_cli_defaults(monkeypatch):
    monkeypatch.delenv("CLAUDE_SESSION_ID", raising=False)
    args = store_learning.build_parser().parse_args(["--content", "x"])
    assert args.session_id == "cli-manual"
    assert args.source == "manual" and args.inferred is False


def test_cli_session_id_comes_from_env_then_flag(monkeypatch):
    monkeypatch.setenv("CLAUDE_SESSION_ID", "from-env")
    assert store_learning.build_parser().parse_args(["--content", "x"]).session_id == "from-env"
    args = store_learning.build_parser().parse_args(["--content", "x", "--session-id", "flag"])
    assert args.session_id == "flag"


def test_cli_source_choices_and_inferred_flag():
    parser = store_learning.build_parser()
    args = parser.parse_args(["--content", "x", "--source", "hook", "--inferred"])
    assert args.source == "hook" and args.inferred is True
    with pytest.raises(SystemExit):
        parser.parse_args(["--content", "x", "--source", "bogus"])


async def test_over_length_input_is_cut_and_still_stored(seam):
    """Breaks if the schema caps reject rows that were stored before phase 3."""
    long_text = " ".join(
        f"Step {i}: worker number {i * 7} retries with a jitter of {i * 13} ms."
        for i in range(120)
    )
    assert len(long_text) > 5000
    result = await store_learning.store_learning_v2(
        "s1", long_text, "WORKING_SOLUTION", context="c" * 3000,
        tags=["t" * 300] + [f"tag{i}" for i in range(40)], source="hook",
    )
    assert result["success"] is True and not result.get("skipped"), result
    (row,) = seam["memory"].stored
    md = row["metadata"]
    assert len(row["content"]) == 4000
    assert len(md["context"]) == 1000
    assert len(md["tags"]) == 30 and all(len(t) <= 100 for t in md["tags"])
    assert _reject_lines() == []
    assert result["content_length"] == 4000
