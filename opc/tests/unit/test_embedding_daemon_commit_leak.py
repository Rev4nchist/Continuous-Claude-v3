"""Tests for embedding-daemon-commit-leak (2026-11-13).

Root cause: socketserver.ThreadingTCPServer runs each request on a new thread, and torch's OpenMP
runtime keeps one thread team per calling thread forever. The fix runs every encode on ONE
long-lived thread; a commit ceiling bounds any other leak. Evidence: .claudedocs/e2e-embedding-daemon-commit-leak/.

Offline: the model is never loaded (embed / embed_batch are patched), no database is used, and the
discovery file always points at a temp path, so no test can touch the live daemon's ~/.claude/run file.
The one real-torch test runs only with CCV3_EMBED_SLOW=1, by hand (seat, 2026-11-13: not in the suite or pre-pr).
"""
from __future__ import annotations

import json
import os
import re
import socket
import struct
import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from scripts.core import embedding_daemon as ed

VEC = [0.0, 1.0, 2.0]


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """Temp discovery file, clean drain state, no server; restore afterwards."""
    # getattr: the root-cause test must also run (and fail on its assertion) against the old daemon, which lacks these names.
    monkeypatch.setattr(ed, "DAEMON_INFO_PATH", tmp_path / "ccv3-embedding.json")
    events = [e for e in (getattr(ed, "_DRAINING", None), getattr(ed, "_CEILING_EXIT_STARTED", None)) if e is not None]
    for e in events:
        e.clear()
    monkeypatch.setattr(ed, "_SERVER", None, raising=False)
    monkeypatch.delenv(getattr(ed, "COMMIT_CEILING_ENV", "CCV3_EMBED_COMMIT_CEILING_MB"), raising=False)
    yield
    for e in events:
        e.clear()


@pytest.fixture
def server():
    """A real daemon TCP server on 127.0.0.1:0 with the daemon's handler. Yields its port."""
    srv = ed._ThreadingTCPServer(("127.0.0.1", 0), ed._EmbeddingHandler)
    t = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    t.start()
    try:
        yield srv
    finally:
        srv.shutdown()
        srv.server_close()


def _call(port: int, obj: dict, timeout: float = 5.0) -> dict:
    """One request on its own connection, as the hook client does."""
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
        payload = json.dumps(obj).encode("utf-8")
        s.sendall(struct.pack(">I", len(payload)) + payload)
        (n,) = struct.unpack(">I", ed._recv_exact(s, 4))
        return json.loads(ed._recv_exact(s, n).decode("utf-8"))


def _port(srv) -> int:
    return srv.server_address[1]


# ---------- the root cause: one encode thread ----------

def test_every_encode_runs_on_one_thread(server):
    """Fails on the old daemon: each request ran model.encode on its own new thread (one OpenMP team each)."""
    ids: list[int] = []

    def fake_embed(text, model=None):
        ids.append(threading.get_ident())
        return VEC

    def fake_batch(texts, model=None):
        ids.append(threading.get_ident())
        return [VEC for _ in texts]

    with patch.object(ed, "embed", side_effect=fake_embed), patch.object(ed, "embed_batch", side_effect=fake_batch):
        for i in range(8):
            assert _call(_port(server), {"cmd": "embed", "text": f"t{i}"})["vector"] == VEC
        for _ in range(4):
            assert _call(_port(server), {"cmd": "embed_batch", "texts": ["a", "b"]})["count"] == 2
    assert len(ids) == 12
    assert len(set(ids)) == 1, f"encode ran on {len(set(ids))} threads"
    assert ids[0] != threading.get_ident()


def test_a_daemon_embed_from_any_thread_runs_on_the_encode_thread():
    """The recall handler embeds through _daemon_embed, so recall gets the same single thread."""
    ids: list[int] = []

    def fake_embed(text, model=None):
        ids.append(threading.get_ident())
        return VEC

    with patch.object(ed, "embed", side_effect=fake_embed):
        ed._daemon_embed("q1")
        threading.Thread(target=lambda: ed._daemon_embed("q2")).start()
        time.sleep(0.3)
    assert len(ids) == 2 and len(set(ids)) == 1


def test_an_encode_error_reaches_the_client_and_the_encode_thread_survives(server):
    calls = {"n": 0}
    ids: list[int] = []

    def flaky(text, model=None):
        calls["n"] += 1
        ids.append(threading.get_ident())
        if calls["n"] == 1:
            raise ValueError("boom")
        return VEC

    with patch.object(ed, "embed", side_effect=flaky):
        assert _call(_port(server), {"cmd": "embed", "text": "x"}) == {"error": "boom"}
        assert _call(_port(server), {"cmd": "embed", "text": "y"})["vector"] == VEC
    assert len(set(ids)) == 1


def test_a_hung_encode_does_not_block_ping_or_shutdown(server):
    """Seat condition (iii): ping and shutdown never go through the encode thread."""
    entered, release = threading.Event(), threading.Event()

    def hang(text, model=None):
        entered.set()
        release.wait(10)
        return VEC

    with patch.object(ed, "embed", side_effect=hang):
        threading.Thread(target=lambda: _call(_port(server), {"cmd": "embed", "text": "slow"}, timeout=15), daemon=True).start()
        assert entered.wait(5)
        try:
            t0 = time.perf_counter()
            pong = _call(_port(server), {"cmd": "ping"}, timeout=3)
            assert pong["ok"] is True
            assert time.perf_counter() - t0 < 2.0
            with patch.object(server, "shutdown") as stop:
                assert _call(_port(server), {"cmd": "shutdown"}, timeout=3) == {"ok": True}
                time.sleep(0.2)
                assert stop.called
        finally:
            release.set()


# ---------- the commit ceiling ----------

@pytest.mark.parametrize("raw", ["0", "-5", "abc", "100", "4095", "8.5", " "])
def test_a_bad_or_too_small_ceiling_falls_back_to_the_default_and_logs_once(raw, capsys):
    """Seat condition (ii): no restart loop. A fresh daemon (about 3 GB) must start far under the ceiling."""
    assert ed._commit_ceiling_mb({ed.COMMIT_CEILING_ENV: raw}) == ed.COMMIT_CEILING_DEFAULT_MB
    err = capsys.readouterr().err
    assert err.count("\n") == (0 if raw.strip() == "" else 1)


def test_a_good_ceiling_is_used_and_the_default_is_above_the_floor():
    assert ed._commit_ceiling_mb({}) == 8192
    assert ed._commit_ceiling_mb({ed.COMMIT_CEILING_ENV: "4096"}) == 4096
    assert ed._commit_ceiling_mb({ed.COMMIT_CEILING_ENV: "12000"}) == 12000
    assert ed.COMMIT_CEILING_DEFAULT_MB > ed.CEILING_FLOOR_MB >= 4096


def test_the_ceiling_tick_exits_only_above_the_ceiling_and_never_raises():
    begin = MagicMock(return_value=True)
    assert ed._ceiling_tick(read_mb=lambda: 9000, ceiling_mb=8192, begin_exit=begin) is True
    begin.assert_called_once_with(9000, 8192)
    begin.reset_mock()
    assert ed._ceiling_tick(read_mb=lambda: 8192, ceiling_mb=8192, begin_exit=begin) is False
    assert ed._ceiling_tick(read_mb=lambda: 100, ceiling_mb=8192, begin_exit=begin) is False
    begin.assert_not_called()

    def broken():
        raise OSError("no psutil")

    assert ed._ceiling_tick(read_mb=broken, ceiling_mb=8192, begin_exit=begin) is False
    assert ed._ceiling_tick(read_mb=lambda: 9000, ceiling_mb=8192, begin_exit=MagicMock(side_effect=RuntimeError("x"))) is False


def test_the_watchdog_reads_the_ceiling_once_and_checks_it_each_tick(monkeypatch):
    ticks = {"n": 0}

    def sleep(_s):
        ticks["n"] += 1
        if ticks["n"] > 3:
            raise KeyboardInterrupt  # end the endless loop

    monkeypatch.setattr(ed.time, "sleep", sleep)
    monkeypatch.setattr(ed, "_SERVER", object())
    read = MagicMock(return_value=8192)
    tick = MagicMock(return_value=False)
    monkeypatch.setattr(ed, "_commit_ceiling_mb", read)
    monkeypatch.setattr(ed, "_ceiling_tick", tick)
    monkeypatch.setattr(ed, "_recall_watchdog_tick", lambda was: True)
    with pytest.raises(KeyboardInterrupt):
        ed._recall_watchdog(interval_s=0)
    assert read.call_count == 1
    assert tick.call_count == 3
    tick.assert_called_with(ceiling_mb=8192)


def test_the_private_commit_reader_returns_whole_megabytes():
    mb = ed._private_commit_mb()
    assert isinstance(mb, int) and mb > 0


def test_the_ceiling_exit_lets_the_encode_in_work_finish_then_stops(server):
    """Seat condition (i): no request in work is cut. New work is refused while draining."""
    entered, release = threading.Event(), threading.Event()
    calls = {"n": 0}
    replies: list[dict] = []

    def hang(text, model=None):
        calls["n"] += 1
        entered.set()
        release.wait(10)
        return VEC

    stop = MagicMock()
    with patch.object(ed, "embed", side_effect=hang):
        worker = threading.Thread(target=lambda: replies.append(_call(_port(server), {"cmd": "embed", "text": "in work"}, timeout=15)), daemon=True)
        worker.start()
        assert entered.wait(5)
        exiter = threading.Thread(target=lambda: ed._begin_ceiling_exit(9000, 8192, shutdown=stop, drain_s=10), daemon=True)
        exiter.start()
        time.sleep(0.3)
        try:
            assert ed._DRAINING.is_set()
            assert not stop.called, "shutdown must wait for the encode in work"
            assert _call(_port(server), {"cmd": "embed", "text": "new"}) == {"error": "daemon_draining"}
            assert _call(_port(server), {"cmd": "embed_batch", "texts": ["a"]}) == {"error": "daemon_draining"}
            assert _call(_port(server), {"cmd": "ping"})["ready"] is False
            assert calls["n"] == 1
        finally:
            release.set()
        exiter.join(5)
        worker.join(5)
        time.sleep(0.2)  # the stop runs on its own thread
    assert stop.called
    assert replies and replies[0]["vector"] == VEC
    assert ed._begin_ceiling_exit(9000, 8192, shutdown=stop) is False, "the exit starts once"


def test_the_ceiling_exit_stops_after_the_drain_limit_when_an_encode_hangs():
    entered, release = threading.Event(), threading.Event()

    def hang():
        entered.set()
        release.wait(10)

    ed._encode_executor().submit(hang)
    assert entered.wait(5)
    stop = MagicMock()
    try:
        t0 = time.perf_counter()
        assert ed._begin_ceiling_exit(9000, 8192, shutdown=stop, drain_s=0.3) is True
        time.sleep(0.1)
        assert stop.called
        assert time.perf_counter() - t0 < 3.0
    finally:
        release.set()


def test_the_ceiling_exit_removes_only_its_own_discovery_file(tmp_path):
    own = tmp_path / "own.json"
    own.write_text(json.dumps({"pid": os.getpid(), "port": 1}), encoding="utf-8")
    other = tmp_path / "other.json"
    other.write_text(json.dumps({"pid": os.getpid() + 100000, "port": 2}), encoding="utf-8")
    assert ed._delete_own_daemon_info(own) is True and not own.exists()
    assert ed._delete_own_daemon_info(other) is False and other.exists()
    assert ed._delete_own_daemon_info(tmp_path / "missing.json") is False
    bad = tmp_path / "bad.json"
    bad.write_text("not json", encoding="utf-8")
    assert ed._delete_own_daemon_info(bad) is False and bad.exists()


def test_the_ceiling_log_line_holds_sizes_and_counts_only(server, capsys, monkeypatch):
    """Seat condition (iv): no request text and no database address in the log line."""
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pw@db.example:5432/opc")
    with patch.object(ed, "embed", return_value=VEC):
        _call(_port(server), {"cmd": "embed", "text": "SECRET-QUERY-TEXT"})
    capsys.readouterr()
    ed._begin_ceiling_exit(9000, 8192, shutdown=MagicMock(), drain_s=2)
    lines = [ln for ln in capsys.readouterr().err.splitlines() if "commit ceiling" in ln]
    assert len(lines) == 1
    assert re.fullmatch(
        r"\[embedding\] daemon: commit ceiling: private \d+ MB over \d+ MB; os threads -?\d+; python threads \d+; draining, then exiting",
        lines[0],
    ), lines[0]
    assert "SECRET" not in lines[0] and "postgresql" not in lines[0] and "db.example" not in lines[0]


# ---------- real torch, by hand only ----------

@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("CCV3_EMBED_SLOW") != "1", reason="real model; run by hand with CCV3_EMBED_SLOW=1 outside a quiet window")
def test_real_torch_fresh_request_threads_do_not_grow_the_thread_count():
    psutil = pytest.importorskip("psutil")
    pytest.importorskip("torch")
    ed.load_model()
    ed._daemon_embed("warmup")
    proc = psutil.Process()
    threads0, commit0 = proc.num_threads(), ed._private_commit_mb()
    for i in range(50):
        t = threading.Thread(target=lambda i=i: ed._daemon_embed(f"request {i} about memory"))
        t.start()
        t.join()
    grew_threads = proc.num_threads() - threads0
    grew_mb = ed._private_commit_mb() - commit0
    print(json.dumps({"requests": 50, "threadsBefore": threads0, "threadGrowth": grew_threads, "commitGrowthMB": grew_mb}))
    assert grew_threads < 20, f"threads grew by {grew_threads} over 50 requests (old daemon: about 650)"
    assert grew_mb < 200, f"commit grew by {grew_mb} MB over 50 requests"
