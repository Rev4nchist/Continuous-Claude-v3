"""incremental_extract: redaction, provenance mapping, evidence and the reject log.

store_learning_v2 and distill are replaced. A temp transcript drives the run.

Ways it can fail, one test each:
1. A hash already in the reject log is stored again (log is not read), or not counted.
2. A NOISE block leaves no gate_b_noise line, or the line has the redacted hash.
3. With CCV3_DISTILL=1 a thinking block with a key reaches the model or the store raw.
4. The same with CCV3_DISTILL=0.
5. A tool error with a key is stored raw, or gets the wrong source or is_inference.
6. A distilled lesson or a verbatim fallback gets the wrong source, is_inference or tag.
7. A distill "skip" is not logged.
8. metadata evidence loses the transcript line or the raw hash.
9. A model item with injected or secret content is stored anyway, or not logged.
9b. A model formatting glitch (bad action, empty lesson) loses the candidate for good.
10. A gate A reject inside the store does not get the raw candidate hash.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

OPC = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(OPC))
sys.path.insert(0, str(OPC / "scripts" / "core"))

import distill_learning  # noqa: E402
import incremental_extract as ie  # noqa: E402
import memory_reject_log as rl  # noqa: E402
import store_learning  # noqa: E402

from tests.unit import fake_secrets as fs  # noqa: E402

KEY = fs.anthropic_key()
GOOD = (
    "I now realize that the root cause was a missing index on session_id in the "
    "migration file, and the fix is to add the index before the backfill runs."
)
NOISE = "I realize that running processing checkpoint heartbeat"


def _thinking_line(text: str) -> str:
    msg = {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": text}]}}
    return json.dumps(msg)


def _tool_error_line(text: str) -> str:
    return json.dumps({"type": "tool_result", "tool_use_id": "Bash", "content": text})


def _write(tmp_path: Path, lines: list[str]) -> str:
    path = tmp_path / "t.jsonl"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(path)


def _reject_lines() -> list[dict]:
    path = rl.reject_log_path()
    if not path.exists():
        return []
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines()]


@pytest.fixture
def store(monkeypatch):
    calls: list[dict] = []

    async def fake_v2(**kwargs):
        calls.append(kwargs)
        return {"success": True, "memory_id": "m1"}

    monkeypatch.setattr(store_learning, "store_learning_v2", fake_v2)
    return calls


@pytest.fixture
def distiller(monkeypatch):
    state = {"result": None, "seen": [], "rejects": []}

    def fake_distill(candidates, timeout_s=0, rejects=None):
        state["seen"].append(list(candidates))
        if rejects is not None:
            rejects.extend(state["rejects"])
        return state["result"]

    monkeypatch.setattr(distill_learning, "distill", fake_distill)
    return state


async def _run(tmp_path, lines, **kw):
    return await ie.extract_incremental(
        _write(tmp_path, lines), "sess-1", state_file=str(tmp_path / "state.json"), **kw
    )


async def test_a_logged_hash_is_skipped_and_counted(tmp_path, monkeypatch, store):
    monkeypatch.setenv("CCV3_DISTILL", "0")
    rl.record_reject(rl.content_hash(GOOD), "gate_a", "too_short", "hook", "old")
    result = await _run(tmp_path, [_thinking_line(GOOD)])
    assert store == []
    assert result["learnings_rejected_before"] == 1 and result["learnings_stored"] == 0


async def test_noise_block_is_logged_with_the_raw_hash(tmp_path, monkeypatch, store):
    monkeypatch.setenv("CCV3_DISTILL", "0")
    result = await _run(tmp_path, [_thinking_line(NOISE + " " + KEY)])
    assert store == [] and result["learnings_skipped"] == 1
    (line,) = _reject_lines()
    assert line["stage"] == "gate_b_noise"
    assert line["hash"] == rl.content_hash(NOISE + " " + KEY)
    assert "aaaa" not in json.dumps(line)


async def test_distill_on_nothing_raw_reaches_the_model_or_the_store(
    tmp_path, monkeypatch, store, distiller
):
    monkeypatch.setenv("CCV3_DISTILL", "1")
    distiller["result"] = None  # distiller failure -> verbatim fallback
    await _run(tmp_path, [_thinking_line(GOOD + " Token " + KEY + " was exported.")])
    assert all("aaaa" not in c for batch in distiller["seen"] for c in batch)
    (call,) = store
    assert "[REDACTED:provider_token]" in call["content"] and "aaaa" not in call["content"]


async def test_distill_off_thinking_block_is_stored_redacted(tmp_path, monkeypatch, store):
    monkeypatch.setenv("CCV3_DISTILL", "0")
    await _run(tmp_path, [_thinking_line(GOOD + " Token " + KEY + " was exported.")])
    (call,) = store
    assert "[REDACTED:provider_token]" in call["content"] and "aaaa" not in call["content"]


async def test_tool_error_is_redacted_with_hook_provenance(tmp_path, monkeypatch, store):
    monkeypatch.setenv("CCV3_DISTILL", "0")
    text = "Traceback (most recent call last): the deploy failed with an error using " + KEY
    await _run(tmp_path, [_tool_error_line(text)])
    (call,) = store
    assert "aaaa" not in call["content"] and "[REDACTED:provider_token]" in call["content"]
    assert call["source"] == "hook" and call["is_inference"] is False
    assert call["learning_type"] == "ERROR_FIX"
    assert call["evidence"]["kind"] == "tool_error"


async def test_verbatim_thinking_block_is_hook_and_inference(tmp_path, monkeypatch, store):
    monkeypatch.setenv("CCV3_DISTILL", "0")
    await _run(tmp_path, [_thinking_line(GOOD)])
    (call,) = store
    assert call["source"] == "hook" and call["is_inference"] is True
    assert "distilled" not in call["tags"]


async def test_distilled_lesson_is_llm_and_inference(tmp_path, monkeypatch, store, distiller):
    monkeypatch.setenv("CCV3_DISTILL", "1")
    distiller["result"] = [
        {
            "index": 0, "action": "add",
            "lesson": "Add the session_id index before the backfill runs in the migration.",
            "why": "The backfill scans the table without it.",
            "how_to_apply": "Order the DDL first.",
        }
    ]
    await _run(tmp_path, [_thinking_line(GOOD)])
    (call,) = store
    assert call["source"] == "llm" and call["is_inference"] is True
    assert "distilled" in call["tags"] and call["content"].startswith("Add the session_id index")


async def test_distill_skip_is_logged(tmp_path, monkeypatch, store, distiller):
    monkeypatch.setenv("CCV3_DISTILL", "1")
    distiller["result"] = [
        {"index": 0, "action": "skip", "lesson": "", "why": "", "how_to_apply": ""}
    ]
    result = await _run(tmp_path, [_thinking_line(GOOD)])
    assert store == [] and result["learnings_skipped"] == 1
    (line,) = _reject_lines()
    assert line["stage"] == "distill_skip" and line["hash"] == rl.content_hash(GOOD)


async def test_distill_schema_reject_is_logged_and_not_stored(
    tmp_path, monkeypatch, store, distiller
):
    monkeypatch.setenv("CCV3_DISTILL", "1")
    distiller["result"] = []
    distiller["rejects"] = [{"index": 0, "reason": "distill:injected"}]
    result = await _run(tmp_path, [_thinking_line(GOOD)])
    assert store == [] and result["learnings_skipped"] == 1
    (line,) = _reject_lines()
    assert line["stage"] == "distill_schema" and line["reason"] == "distill:injected"


@pytest.mark.parametrize("reason", ["distill:bad_action", "distill:empty_lesson"])
async def test_model_formatting_glitch_falls_back_to_verbatim_and_is_not_logged(
    tmp_path, monkeypatch, store, distiller, reason
):
    """Breaks if a malformed model item drops the candidate and logs its hash for good."""
    monkeypatch.setenv("CCV3_DISTILL", "1")
    distiller["result"] = []
    distiller["rejects"] = [{"index": 0, "reason": reason}]
    result = await _run(tmp_path, [_thinking_line(GOOD)])
    assert result["learnings_stored"] == 1
    (call,) = store
    assert call["source"] == "hook" and call["is_inference"] is True
    assert "distilled" not in call["tags"]
    assert _reject_lines() == []


async def test_evidence_has_the_transcript_line_and_raw_hash(tmp_path, monkeypatch, store):
    monkeypatch.setenv("CCV3_DISTILL", "0")
    await _run(tmp_path, ["", _thinking_line(GOOD)])  # the block is on line 1 (0-indexed)
    (call,) = store
    assert call["evidence"] == {
        "kind": "thinking_block", "line": 1, "hash": rl.content_hash(GOOD),
    }
    assert call["candidate_hash"] == rl.content_hash(GOOD)


async def test_state_hash_is_the_raw_hash(tmp_path, monkeypatch, store):
    monkeypatch.setenv("CCV3_DISTILL", "0")
    result = await _run(tmp_path, [_thinking_line(GOOD)])
    assert result["hashes"] == [rl.content_hash(GOOD)]
