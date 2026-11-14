"""Tests for embedding-daemon-commit-leak (2026-11-13).

Root cause: socketserver.ThreadingTCPServer runs each request on a new thread, and torch's OpenMP
runtime keeps one thread team per calling thread forever. The fix runs every encode on ONE
long-lived thread; a commit ceiling bounds any other leak.
Evidence: .claudedocs/e2e-embedding-daemon-commit-leak/.

Offline: the model is never loaded (embed / embed_batch are patched), no database is used, and the
discovery file always points at a temp path, so no test can touch the live daemon's
~/.claude/run file.
The one real-torch test runs only with CCV3_EMBED_SLOW=1, by hand (seat, 2026-11-13: not in
the suite or pre-pr).
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


class _StopLoop(BaseException):
    """Ends a watchdog loop in a test. Not KeyboardInterrupt: a stray thread cannot stop pytest."""


def _patch_daemon_sleep(monkeypatch, sleep) -> None:
    """Give the daemon module its own time namespace: the patched sleep reaches no other module."""
    import types

    fake = types.SimpleNamespace(
        **{k: getattr(time, k) for k in dir(time) if not k.startswith("__")}
    )
    fake.sleep = sleep
    monkeypatch.setattr(ed, "time", fake)


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """Temp discovery file, clean drain state, no server; restore afterwards."""
    # getattr: the root-cause test must also run (and fail on its assertion) against the old
    # daemon, which lacks these names.
    monkeypatch.setattr(ed, "DAEMON_INFO_PATH", tmp_path / "ccv3-embedding.json")
    events = [
        e
        for e in (getattr(ed, "_DRAINING", None), getattr(ed, "_CEILING_EXIT_STARTED", None))
        if e is not None
    ]
    for e in events:
        e.clear()
    monkeypatch.setattr(ed, "_SERVER", None, raising=False)
    monkeypatch.setattr(ed, "_INFLIGHT", 0, raising=False)
    monkeypatch.delenv(
        getattr(ed, "COMMIT_CEILING_ENV", "CCV3_EMBED_COMMIT_CEILING_MB"), raising=False
    )
    yield
    # A handler thread of this test can end its request late: let it, so it cannot change the
    # count of the next test.
    _wait_for(lambda: getattr(ed, "_INFLIGHT", 0) == 0, 2)
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
    """Fails on the old daemon: each request encoded on a new thread (one OpenMP team each)."""
    ids: list[int] = []

    def fake_embed(text, model=None):
        ids.append(threading.get_ident())
        return VEC

    def fake_batch(texts, model=None):
        ids.append(threading.get_ident())
        return [VEC for _ in texts]

    with (
        patch.object(ed, "embed", side_effect=fake_embed),
        patch.object(ed, "embed_batch", side_effect=fake_batch),
    ):
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
        t = threading.Thread(target=lambda: ed._daemon_embed("q2"))
        t.start()
        t.join(5)
    assert len(ids) == 2 and len(set(ids)) == 1


@pytest.fixture
def recall_loop(monkeypatch):
    """A real asyncio loop on its own thread, as the daemon's recall runtime (no database)."""
    import asyncio

    loop = asyncio.new_event_loop()
    t = threading.Thread(target=loop.run_forever, daemon=True)
    t.start()
    monkeypatch.setattr(ed, "_RECALL_LOOP", loop)
    monkeypatch.setattr(ed, "_RECALL_READY", True)
    try:
        yield loop
    finally:
        loop.call_soon_threadsafe(loop.stop)
        t.join(5)
        loop.close()


def _fake_do_recall(entered: threading.Event | None = None, release: threading.Event | None = None):
    import asyncio

    async def do_recall(vec, query, k, mode, project_id=None, scope_mode=None):
        if entered is not None:
            entered.set()
        while release is not None and not release.is_set():
            await asyncio.sleep(0.01)
        return {"results": [{"q": query}], "_meta": {}}

    return do_recall


def test_a_recall_embeds_on_the_encode_thread(server, recall_loop):
    """A recall embed reverted to a direct encode runs on the handler thread: this fails then."""
    ids: list[int] = []

    def fake_embed(text, model=None):
        ids.append(threading.get_ident())
        return VEC

    with (
        patch.object(ed, "embed", side_effect=fake_embed),
        patch.object(ed, "_get_do_recall", return_value=_fake_do_recall()),
    ):
        assert _call(_port(server), {"cmd": "embed", "text": "a"})["vector"] == VEC
        reply = _call(_port(server), {"cmd": "recall", "query": "b"})
    assert reply["ok"] is True, reply
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


def test_a_hung_encode_does_not_block_ping_or_shutdown(server, monkeypatch):
    """Seat condition (iii): ping and shutdown never go through the encode thread.

    Shutdown drains for a bounded time, then stops.
    """
    monkeypatch.setattr(ed, "SHUTDOWN_DRAIN_S", 0.2, raising=False)
    entered, release = threading.Event(), threading.Event()

    def hang(text, model=None):
        entered.set()
        release.wait(10)
        return VEC

    with patch.object(ed, "embed", side_effect=hang):
        threading.Thread(
            target=lambda: _call(_port(server), {"cmd": "embed", "text": "slow"}, timeout=15),
            daemon=True,
        ).start()
        assert entered.wait(5)
        try:
            t0 = time.perf_counter()
            pong = _call(_port(server), {"cmd": "ping"}, timeout=3)
            assert pong["ok"] is True
            assert time.perf_counter() - t0 < 2.0
            with patch.object(server, "shutdown") as stop:
                assert _call(_port(server), {"cmd": "shutdown"}, timeout=3) == {"ok": True}
                assert _wait_for(lambda: stop.called, 3), (
                    "shutdown must stop the server after the bounded drain"
                )
        finally:
            release.set()


# ---------- the commit ceiling ----------


@pytest.mark.parametrize("raw", ["0", "-5", "abc", "100", "4095", "8.5", " "])
def test_a_bad_or_too_small_ceiling_falls_back_to_the_default_and_logs_once(raw, capsys):
    """Seat condition (ii): no restart loop. A fresh daemon (about 3 GB) starts far under it."""
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
    assert (
        ed._ceiling_tick(
            read_mb=lambda: 9000,
            ceiling_mb=8192,
            begin_exit=MagicMock(side_effect=RuntimeError("x")),
        )
        is False
    )


def test_the_watchdog_reads_the_ceiling_once_and_checks_it_each_tick(monkeypatch):
    ticks = {"n": 0}

    def sleep(_s):
        ticks["n"] += 1
        if ticks["n"] > 3:
            raise _StopLoop  # end the endless loop

    _patch_daemon_sleep(monkeypatch, sleep)
    monkeypatch.setattr(ed, "_SERVER", object())
    read = MagicMock(return_value=8192)
    tick = MagicMock(return_value=False)
    monkeypatch.setattr(ed, "_commit_ceiling_mb", read)
    monkeypatch.setattr(ed, "_ceiling_tick", tick)
    monkeypatch.setattr(ed, "_recall_watchdog_tick", lambda was: True)
    with pytest.raises(_StopLoop):
        ed._recall_watchdog(interval_s=0)
    assert read.call_count == 1
    assert tick.call_count == 3
    tick.assert_called_with(ceiling_mb=8192, uptime_s=None)


def test_the_watchdog_raises_the_ceiling_over_the_baseline_and_passes_the_uptime(monkeypatch):
    """The watchdog wiring: a reverted baseline or uptime argument fails here."""
    ticks = {"n": 0}

    def sleep(_s):
        ticks["n"] += 1
        if ticks["n"] > 1:
            raise _StopLoop

    _patch_daemon_sleep(monkeypatch, sleep)
    monkeypatch.setattr(ed, "_SERVER", object())
    monkeypatch.setattr(ed, "_BASELINE_MB", 7000)
    monkeypatch.setattr(ed, "_STARTED_MONO", time.monotonic() - 1000)
    monkeypatch.setattr(ed, "_commit_ceiling_mb", lambda: 8192)
    tick = MagicMock(return_value=False)
    monkeypatch.setattr(ed, "_ceiling_tick", tick)
    monkeypatch.setattr(ed, "_recall_watchdog_tick", lambda was: True)
    with pytest.raises(_StopLoop):
        ed._recall_watchdog(interval_s=0)
    kwargs = tick.call_args.kwargs
    assert kwargs["ceiling_mb"] == 7000 + ed.CEILING_MARGIN_MB
    assert kwargs["uptime_s"] >= 1000


def test_a_request_ends_only_after_its_reply_is_sent(server):
    """A drain that sees zero requests must never stop the server before a reply has gone out."""
    real_send = ed._send_frame
    sending, release = threading.Event(), threading.Event()
    counts: list[int] = []

    def slow_send(sock, obj):
        if "vector" in obj:
            counts.append(ed._INFLIGHT)
            sending.set()
            release.wait(5)
        real_send(sock, obj)

    with (
        patch.object(ed, "embed", return_value=VEC),
        patch.object(ed, "_send_frame", side_effect=slow_send),
    ):
        t = threading.Thread(
            target=lambda: _call(_port(server), {"cmd": "embed", "text": "x"}), daemon=True
        )
        t.start()
        assert sending.wait(5)
        try:
            assert ed._INFLIGHT == 1, "the request must still count while its reply is sent"
        finally:
            release.set()
        t.join(5)
    assert counts == [1]
    assert _wait_for(lambda: ed._INFLIGHT == 0, 2)


def test_the_ceiling_exit_keeps_a_discovery_file_of_another_daemon():
    """A reverted call site (delete whatever file is there) removes the other daemon's file."""
    ed.DAEMON_INFO_PATH.write_text(
        json.dumps({"pid": os.getpid() + 100000, "port": 2}), encoding="utf-8"
    )
    assert ed._begin_ceiling_exit(9000, 8192, shutdown=MagicMock(), drain_s=0.1) is True
    assert ed.DAEMON_INFO_PATH.exists()


def test_the_ceiling_exit_removes_its_own_discovery_file():
    ed.DAEMON_INFO_PATH.write_text(json.dumps({"pid": os.getpid(), "port": 2}), encoding="utf-8")
    assert ed._begin_ceiling_exit(9000, 8192, shutdown=MagicMock(), drain_s=0.1) is True
    assert not ed.DAEMON_INFO_PATH.exists()


def test_a_ceiling_exit_whose_log_fails_still_stops(monkeypatch):
    """A started exit always ends in a stop: never a daemon that drains forever with no file."""

    def broken_print(*_a, **_k):
        raise OSError("stderr is gone")

    monkeypatch.setattr("builtins.print", broken_print)
    stop = MagicMock()
    assert ed._begin_ceiling_exit(9000, 8192, shutdown=stop, drain_s=0.1) is True
    assert stop.called


def test_a_ceiling_exit_whose_file_delete_raises_still_stops(monkeypatch):
    """MemoryError under commit pressure between the once-guard and the drain must still stop."""

    def boom(*_a, **_k):
        raise MemoryError

    monkeypatch.setattr(ed, "_delete_own_daemon_info", boom)
    stop = MagicMock()
    with pytest.raises(MemoryError):
        ed._begin_ceiling_exit(9000, 8192, shutdown=stop, drain_s=0.1)
    assert stop.called


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
        worker = threading.Thread(
            target=lambda: replies.append(
                _call(_port(server), {"cmd": "embed", "text": "in work"}, timeout=15)
            ),
            daemon=True,
        )
        worker.start()
        assert entered.wait(5)
        exiter = threading.Thread(
            target=lambda: ed._begin_ceiling_exit(9000, 8192, shutdown=stop, drain_s=10),
            daemon=True,
        )
        exiter.start()
        time.sleep(0.3)
        try:
            assert ed._DRAINING.is_set()
            assert not stop.called, "shutdown must wait for the encode in work"
            assert _call(_port(server), {"cmd": "embed", "text": "new"}) == {
                "error": "daemon_draining"
            }
            assert _call(_port(server), {"cmd": "embed_batch", "texts": ["a"]}) == {
                "error": "daemon_draining"
            }
            assert _call(_port(server), {"cmd": "ping"})["ready"] is False
            assert calls["n"] == 1
        finally:
            release.set()
        exiter.join(5)
        worker.join(5)
    assert stop.called
    assert replies and replies[0]["vector"] == VEC
    assert ed._begin_ceiling_exit(9000, 8192, shutdown=stop) is False, "the exit starts once"


def test_a_recall_whose_embed_hangs_answers_within_its_own_timeout(server, recall_loop):
    """The client waits RECALL_TIMEOUT_S; the recall embed must not hold the handler for 120 s."""
    entered, release = threading.Event(), threading.Event()

    def hang(text, model=None):
        entered.set()
        release.wait(10)
        return VEC

    with patch.object(ed, "embed", side_effect=hang):
        try:
            t0 = time.perf_counter()
            reply = _call(_port(server), {"cmd": "recall", "query": "q"}, timeout=10)
            assert time.perf_counter() - t0 < ed.RECALL_TIMEOUT_S + 2
        finally:
            release.set()
    assert reply["ok"] is False and "encode_timeout" in reply["error"], reply


def test_a_recall_that_times_out_is_cancelled(server, recall_loop, monkeypatch):
    """A do_recall that outlives its wait is cancelled: it holds no pool connection for nobody."""
    import asyncio

    monkeypatch.setattr(ed, "RECALL_TIMEOUT_S", 0.3)
    cancelled = threading.Event()

    async def slow(vec, query, k, mode, project_id=None, scope_mode=None):
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled.set()
            raise
        return {"results": [], "_meta": {}}

    with (
        patch.object(ed, "embed", return_value=VEC),
        patch.object(ed, "_get_do_recall", return_value=slow),
    ):
        reply = _call(_port(server), {"cmd": "recall", "query": "q"}, timeout=10)
    assert reply == {"ok": False, "error": "recall_timeout"}, reply
    assert cancelled.wait(3), "the timed-out do_recall was not cancelled"


def test_the_ceiling_exit_stops_after_the_drain_limit_when_a_request_hangs():
    assert ed._admit_request() is True  # a request in work that never ends
    stop = MagicMock()
    try:
        t0 = time.perf_counter()
        assert ed._begin_ceiling_exit(9000, 8192, shutdown=stop, drain_s=0.3) is True
        time.sleep(0.1)
        assert stop.called
        assert time.perf_counter() - t0 < 3.0
    finally:
        ed._end_request()


def test_the_drain_limit_outlasts_every_request_timeout():
    """Critic m1: a valid request always ends by its own timeout before the drain gives up on it."""
    assert ed.CEILING_DRAIN_S > ed.ENCODE_WAIT_S + ed.RECALL_TIMEOUT_S


def test_the_ceiling_exit_waits_for_a_recall_in_do_recall(server, recall_loop):
    """Critic M1: the old drain waited only on the encode queue: a recall past its embed was cut."""
    entered, release = threading.Event(), threading.Event()
    replies: list[dict] = []
    stop = MagicMock()
    with (
        patch.object(ed, "embed", return_value=VEC),
        patch.object(ed, "_get_do_recall", return_value=_fake_do_recall(entered, release)),
    ):
        worker = threading.Thread(
            target=lambda: replies.append(
                _call(_port(server), {"cmd": "recall", "query": "q"}, timeout=10)
            ),
            daemon=True,
        )
        worker.start()
        assert entered.wait(5)
        exiter = threading.Thread(
            target=lambda: ed._begin_ceiling_exit(9000, 8192, shutdown=stop, drain_s=5), daemon=True
        )
        exiter.start()
        time.sleep(0.3)
        try:
            assert not stop.called, "the drain must wait for the recall in do_recall"
        finally:
            release.set()
        worker.join(5)
        exiter.join(5)
    assert stop.called
    assert replies and replies[0]["ok"] is True, replies


def test_a_request_admitted_before_the_drain_holds_the_exit():
    """Critic M2: the drain check and the count are one step; an admitted request holds the exit."""
    assert ed._admit_request() is True
    stop = MagicMock()
    exiter = threading.Thread(
        target=lambda: ed._begin_ceiling_exit(9000, 8192, shutdown=stop, drain_s=5), daemon=True
    )
    exiter.start()
    time.sleep(0.3)
    assert ed._DRAINING.is_set()
    assert ed._admit_request() is False, "no admission while draining"
    assert not stop.called
    ed._end_request()
    exiter.join(5)
    assert stop.called


def test_a_timed_out_encode_is_cancelled_and_names_its_cause():
    """Critic m2, m3: a queued encode whose caller left never runs; the error text is not empty."""
    entered, release = threading.Event(), threading.Event()
    ran = {"late": False}

    def hang():
        entered.set()
        release.wait(10)

    def late():
        ran["late"] = True

    blocker = threading.Thread(target=lambda: ed._on_encode_thread(hang, timeout=15), daemon=True)
    blocker.start()
    assert entered.wait(5)
    try:
        with pytest.raises(ed._cf.TimeoutError) as info:
            ed._on_encode_thread(late, timeout=0.2)
        assert str(info.value), "the timeout must name its cause"
    finally:
        release.set()
    blocker.join(5)
    ed._on_encode_thread(lambda: None, timeout=5)  # FIFO: the cancelled one came before this
    assert ran["late"] is False


def test_the_ceiling_waits_for_the_minimum_uptime():
    """Critic M3: no ceiling exit in the first minutes: a fresh daemon cannot exit on tick one."""
    begin = MagicMock(return_value=True)
    assert (
        ed._ceiling_tick(read_mb=lambda: 9000, ceiling_mb=8192, begin_exit=begin, uptime_s=60)
        is False
    )
    begin.assert_not_called()
    assert (
        ed._ceiling_tick(
            read_mb=lambda: 9000,
            ceiling_mb=8192,
            begin_exit=begin,
            uptime_s=ed.CEILING_MIN_UPTIME_S + 1,
        )
        is True
    )


def test_the_ceiling_is_raised_above_the_baseline_of_a_fresh_daemon(capsys):
    """Critic M3: a daemon whose normal size is near the ceiling gets margin above its baseline."""
    assert ed._effective_ceiling_mb(8192, 3000) == 8192
    assert ed._effective_ceiling_mb(4096, 3500) == 3500 + ed.CEILING_MARGIN_MB
    assert "raised" in capsys.readouterr().err
    assert ed._effective_ceiling_mb(8192, None) == 8192


def test_a_failed_commit_read_logs_once(capsys, monkeypatch):
    """Critic m4: a broken psutil turns the ceiling off; say so one time, not every tick."""
    monkeypatch.setattr(ed, "_CEILING_READ_FAILED_LOGGED", False, raising=False)

    def broken():
        raise OSError("no psutil")

    for _ in range(3):
        assert ed._ceiling_tick(read_mb=broken, ceiling_mb=8192, uptime_s=10_000) is False
    assert capsys.readouterr().err.count("commit read failed") == 1


# The child for the subprocess test: a real _run_daemon on temp info and lock paths, a fake
# model, a hung embed.
_CHILD = r"""
import json, sys, threading
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from scripts.core import embedding_daemon as ed
tmp = Path(sys.argv[2])
ed.DAEMON_INFO_PATH = tmp / "info.json"
lock = tmp / "daemon.lock"
ed._acquire_startup_slot = lambda: ed._acquire_exclusive_lock(lock)
ed._hide_own_console_on_windows = lambda: None
ed._start_recall_runtime = lambda: None
ed._start_recall_watchdog = lambda: note_baseline()  # runs after the baseline read
ed._private_commit_mb = lambda: 100 if "warmup" in names else -1
ed.SHUTDOWN_DRAIN_S = 1.0
names = {}
def note(key):
    names[key] = threading.current_thread().name
    (tmp / "names.json").write_text(json.dumps(names))
class FakeModel:
    def encode(self, text, **kw):
        note("warmup")
        return [0.0]
def fake_load():
    note("load")
    return FakeModel()
def note_baseline():
    names["baseline"] = ed._BASELINE_MB
    names["started"] = ed._STARTED_MONO is not None
    (tmp / "names.json").write_text(json.dumps(names))
ed.load_model = fake_load
release = threading.Event()
def hang(text, model=None):
    (tmp / "entered").write_text("1")
    release.wait(600)
    return [0.0]
ed.embed = hang
sys.exit(ed._run_daemon(0))
"""


def _wait_for(pred, timeout: float) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.05)
    return False


def test_a_daemon_with_a_hung_encode_still_exits_and_frees_its_lock(tmp_path):
    """Critic B1: the old encode worker was a non-daemon thread that Python joins before atexit.

    So a hung encode kept the process, its commit and the startup lock alive forever, with no
    discovery file.
    """
    import subprocess

    opc_root = str(Path(__file__).parent.parent.parent)
    # A temp home: the module import makes its run folder under the home, never the live one.
    home = tmp_path / "home"
    home.mkdir()
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home)}
    log = open(tmp_path / "child.log", "wb")
    proc = subprocess.Popen(
        [sys.executable, "-c", _CHILD, opc_root, str(tmp_path)],
        stdout=log,
        stderr=subprocess.STDOUT,
        env=env,
    )
    try:
        info_path = tmp_path / "info.json"
        port_box: list[int] = []

        def _port_written() -> bool:  # the write is not atomic: wait until the file parses
            try:
                port_box.append(int(json.loads(info_path.read_text(encoding="utf-8"))["port"]))
                return True
            except (OSError, ValueError, KeyError, TypeError):
                return False

        assert _wait_for(_port_written, 30), "the scratch daemon never wrote its discovery file"
        port = port_box[0]
        assert _call(port, {"cmd": "ping"})["ok"] is True
        threading.Thread(
            target=lambda: _call_quiet(port, {"cmd": "embed", "text": "hang"}), daemon=True
        ).start()
        assert _wait_for((tmp_path / "entered").exists, 10), (
            "the embed never reached the encode thread"
        )
        assert _call(port, {"cmd": "shutdown"}) == {"ok": True}
        try:
            rc = proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            pytest.fail("the daemon did not exit within 20 s of shutdown while an encode hung")
        assert rc == 0
        assert not (tmp_path / "daemon.lock").exists(), "the startup lock was not released"
        assert not info_path.exists(), "the discovery file was left behind"
        names = json.loads((tmp_path / "names.json").read_text(encoding="utf-8"))
        # The model loads and warms up on the encode thread; the baseline is read after warmup.
        assert names == {
            "load": "ccv3-encode",
            "warmup": "ccv3-encode",
            "baseline": 100,
            "started": True,
        }, names
    finally:
        if proc.poll() is None:
            proc.kill()  # only our own child
            proc.wait(10)
        log.close()


def _call_quiet(port: int, obj: dict) -> None:
    try:
        _call(port, obj, timeout=30)
    except (OSError, EOFError, struct.error, ValueError):
        pass  # the child exits while this call waits


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
        r"\[embedding\] daemon: commit ceiling: private \d+ MB over \d+ MB; "
        r"os threads -?\d+; python threads \d+; draining, then exiting",
        lines[0],
    ), lines[0]
    assert (
        "SECRET" not in lines[0] and "postgresql" not in lines[0] and "db.example" not in lines[0]
    )


# ---------- real torch, by hand only ----------


@pytest.mark.slow
@pytest.mark.skipif(
    os.environ.get("CCV3_EMBED_SLOW") != "1",
    reason="real model; run by hand with CCV3_EMBED_SLOW=1 outside a quiet window",
)
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
    print(
        json.dumps(
            {
                "requests": 50,
                "threadsBefore": threads0,
                "threadGrowth": grew_threads,
                "commitGrowthMB": grew_mb,
            }
        )
    )
    assert grew_threads < 20, (
        f"threads grew by {grew_threads} over 50 requests (old daemon: about 650)"
    )
    assert grew_mb < 200, f"commit grew by {grew_mb} MB over 50 requests"
