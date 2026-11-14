#!/usr/bin/env python3
"""Persistent BGE-large embedding daemon (Task 11 Path A).

Wraps ``BAAI/bge-large-en-v1.5`` via ``sentence-transformers.SentenceTransformer``
in a long-lived process so the ``memory-awareness`` UserPromptSubmit hook and
``recall_learnings.py`` can do query-time embedding within the 2s budget.

The bottleneck the daemon solves is **subprocess startup**: importing
``sentence_transformers`` + ``torch`` and loading bge-large is ~30-45s cold
on Windows CPU, but a hot ``model.encode`` is ~30-100ms. A daemon loaded
once eliminates the 30s import tax on every recall call.

Two execution modes:

* **One-shot** (stdin -> stdout). Reads a text from stdin, prints the JSON
  vector to stdout. Used for debug / smoke checks. Pays the full cold
  start each invocation.

* **Daemon** (long-lived process, TCP loopback, length-prefixed JSON frames).
  Pre-warms the model at startup, then services embed/ping/shutdown
  requests with hot-path latency. PID/port written to
  ``~/.claude/run/ccv3-embedding.json`` so clients can find the daemon. Mirrors
  the Phase 2 rerank daemon protocol (TCP, ``TCP_NODELAY``, 4-byte
  big-endian length prefix, JSON UTF-8 payload, 100MB sanity cap).

Locked decisions (Task 1.1 + user, 2026-05-18):
* Model: ``BAAI/bge-large-en-v1.5`` (1024-dim; bound by archival_memory
  schema -- DO NOT change without a re-embed migration).
* Wrapper: ``SentenceTransformer.encode(text, convert_to_numpy=True).tolist()``
  to byte-for-byte match what ``LocalEmbeddingProvider`` writes today.
* Lifecycle: spawn-on-first-hit detached. Daemon stays loaded across calls.
* Discovery file path: ``~/.claude/run/ccv3-embedding.json`` (env-independent;
  see ``_canonical_run_dir`` -- NOT a temp dir, so Node and Python agree).
* Transport: TCP loopback on 127.0.0.1, port 0 (OS-assigned), ``TCP_NODELAY``.

Usage::

    # Daemon
    uv run --project opc python opc/scripts/core/embedding_daemon.py --daemon
    # ... writes {pid, port, model, dim} to ~/.claude/run/ccv3-embedding.json
    #     AFTER the model is fully loaded.

    # One-shot
    echo "memory hardening" | \\
        uv run --project opc python opc/scripts/core/embedding_daemon.py

    # Bench
    uv run --project opc python opc/scripts/core/embedding_daemon.py --bench
"""

from __future__ import annotations

import argparse
import asyncio
import atexit
import concurrent.futures as _cf
import json
import math
import os
import signal
import socket
import socketserver
import struct
import sys
import threading
import time
from pathlib import Path
from typing import Any

# Module-level state. The model is loaded LAZILY via load_model() -- do NOT
# import torch / sentence_transformers at module import time so callers that
# only need the constants / metadata path can import cheaply.
_MODEL: Any | None = None
_MODEL_LOCK = threading.Lock()

MODEL_NAME = "BAAI/bge-large-en-v1.5"
EMBEDDING_DIM = 1024

# ST-05: resident recall op timeouts. The recall query runs on a background
# asyncio loop (in a daemon thread) that owns the asyncpg pool; these bounds
# guarantee the socketserver thread never blocks indefinitely (premortem
# R6/H2/H7). RECALL_TIMEOUT_S mirrors the TS client's hard budget so a slow /
# contended call times out here and the client falls back to the uv path.
RECALL_TIMEOUT_S = 2.5
RECALL_POOL_INIT_TIMEOUT_S = 10.0

# Canonical rendezvous directory for the discovery + lock files.
#
# ROOT CAUSE (2026-06-03): these paths used to derive from
# ``tempfile.gettempdir()``, which on Windows honors ``TMPDIR``. The Node hook
# client (``embedding-client.ts``) uses ``os.tmpdir()``, which honors ``TEMP``
# and IGNORES ``TMPDIR``. Inside the Claude Code session ``TMPDIR`` is set to a
# ``...\Temp\claude`` subdir while ``TEMP`` stays ``...\Temp`` -- so the Node
# spawner and this Python daemon resolved DIFFERENT files. The spawner never
# saw the daemon it started (-> a thundering herd of husk daemons) and recall
# fell back to the multi-second in-process embed.
#
# Fix: anchor to ``~/.claude/run/``. Node ``os.homedir()``, Python
# ``Path.home()`` and PowerShell ``$HOME`` all resolve to ``USERPROFILE``
# identically on Windows, regardless of ``TEMP``/``TMPDIR``. The client
# (embedding-client.ts), the launcher (start-embedding-daemon.ps1) and the
# quality gate (bus-quality-gate.mjs) compute the SAME path.
def _canonical_run_dir() -> Path:
    """Return ``~/.claude/run`` (created), independent of TEMP/TMPDIR.

    Uses ``Path.home()`` (USERPROFILE on Windows) so every spawner -- Node
    hook, PowerShell task, uv/bash CLI -- resolves the identical directory.
    """
    d = Path.home() / ".claude" / "run"
    d.mkdir(parents=True, exist_ok=True)
    return d


# Daemon discovery file. Environment-independent (see _canonical_run_dir).
DAEMON_INFO_PATH = _canonical_run_dir() / "ccv3-embedding.json"

# BLOCKER-1 (memory-system-next-steps-2026-05-21): cross-process exclusive
# lock used to serialize daemon startup across non-TS spawn paths (Windows
# Task Scheduler pre-warm, direct CLI invocations). The TS-side spawn lock
# in embedding-client.ts covers the hook path; this closes the gap for
# everything else. MUST share the canonical dir with the TS lock so the two
# languages actually mutually exclude.
DAEMON_LOCK_PATH = _canonical_run_dir() / "ccv3-embedding-daemon.lock"


def load_model() -> Any:
    """Load the bge-large embedding model (cached at module level).

    Lazy import of ``sentence_transformers`` + ``torch`` so the module is
    cheap to import. Subsequent calls return the cached instance.

    Returns:
        Loaded ``SentenceTransformer`` instance for ``BAAI/bge-large-en-v1.5``.
    """
    global _MODEL
    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL
        t0 = time.perf_counter()
        print(f"[embedding] loading {MODEL_NAME}...", file=sys.stderr, flush=True)
        # Lazy imports so the module is cheap when only metadata is needed.
        from sentence_transformers import SentenceTransformer  # noqa: PLC0415

        # device=None lets sentence-transformers pick (cuda > mps > cpu).
        # Matches what LocalEmbeddingProvider does when device is None.
        model = SentenceTransformer(MODEL_NAME, device=None)
        elapsed = time.perf_counter() - t0
        # Sanity check: dim must match what's stored in archival_memory.
        actual_dim = model.get_sentence_embedding_dimension()
        if actual_dim != EMBEDDING_DIM:
            raise RuntimeError(
                f"[embedding] model dim mismatch: got {actual_dim}, "
                f"expected {EMBEDDING_DIM} for {MODEL_NAME}"
            )
        print(
            f"[embedding] loaded {MODEL_NAME} (dim={actual_dim}) in {elapsed:.2f}s",
            file=sys.stderr,
            flush=True,
        )
        _MODEL = model
        return model


def embed(text: str, model: Any | None = None) -> list[float]:
    """Embed a single text into a 1024-dim vector.

    Mirrors ``LocalEmbeddingProvider.embed`` byte-for-byte: calls
    ``model.encode(text, convert_to_numpy=True).tolist()`` with no extra
    normalization. The output vector must match what ``recall_learnings.py``
    currently produces in-process so that cosine similarity against rows
    stored in ``archival_memory.embedding`` is preserved.

    Args:
        text: Text to embed.
        model: Optional preloaded SentenceTransformer. When None, calls
            ``load_model()``. Used by the daemon to share the pre-warmed
            instance.

    Returns:
        List of 1024 Python floats.
    """
    if model is None:
        model = load_model()
    # The model is NOT thread-safe for concurrent ``encode`` on the same
    # instance (PyTorch model state, ndarray reuse, etc.). The daemon
    # serialises calls via _MODEL_LOCK below; here we just compute.
    # NOTE: parallel embed_batch calls from different threads will queue up
    # at the lock in the daemon path; that's intentional.
    vec = model.encode(text, convert_to_numpy=True).tolist()
    return vec


def embed_batch(texts: list[str], model: Any | None = None) -> list[list[float]]:
    """Embed a list of texts. Mirrors ``LocalEmbeddingProvider.embed_batch``."""
    if model is None:
        model = load_model()
    if not texts:
        return []
    vecs = model.encode(texts, convert_to_numpy=True).tolist()
    return vecs


# ---------------------------------------------------------------------------
# One-shot CLI mode
# ---------------------------------------------------------------------------

def _run_oneshot() -> int:
    """One-shot mode: read text from stdin, print JSON vector to stdout."""
    text = sys.stdin.read()
    # Strip a trailing newline added by `echo`. Preserve internal whitespace
    # because embeddings DO depend on text shape.
    if text.endswith("\n"):
        text = text[:-1]
    if not text:
        print("[embedding] no text on stdin", file=sys.stderr)
        return 0
    t0 = time.perf_counter()
    vec = embed(text)
    elapsed_ms = (time.perf_counter() - t0) * 1000
    print(
        f"[embedding] oneshot embed: {elapsed_ms:.1f}ms (dim={len(vec)})",
        file=sys.stderr,
        flush=True,
    )
    print(json.dumps({"vector": vec}))
    return 0


# ---------------------------------------------------------------------------
# Daemon mode (TCP loopback, length-prefixed JSON frames)
# ---------------------------------------------------------------------------

# Length-prefix framing: 4-byte big-endian uint32 payload length, then
# `length` UTF-8 bytes of JSON. Mirrors the Phase 2 rerank daemon protocol.

# Serialises model.encode calls -- sentence-transformers + torch are NOT
# thread-safe for concurrent inference on the same model instance. Same
# lesson kraken hit on the Phase 2 rerank daemon.
_EMBED_CALL_LOCK = threading.Lock()

# ONE long-lived encode thread (embedding-daemon-commit-leak, 2026-11-13).
# ROOT CAUSE: socketserver.ThreadingTCPServer runs each request on a NEW thread. torch runs its CPU
# kernels on OpenMP (MSVC vcomp, 14 threads here), which builds a thread team for EVERY calling thread
# and never frees it when that thread exits. Each request left a 13-thread team with committed buffers
# behind: the live daemon reached 97.3 GB of private commit in about 36 hours (working set 1.7 GB).
# Measured: 200 encodes on fresh threads took the process from 46 to 2667 threads; on one thread it
# stayed flat (.claudedocs/e2e-embedding-daemon-commit-leak/). So every model.encode of the daemon runs
# on this one thread, and torch keeps one team for the life of the process. ping and shutdown never
# go through it, so a hung encode cannot block them.
ENCODE_WAIT_S = 120.0
_ENCODE_EXECUTOR: _cf.ThreadPoolExecutor | None = None
_ENCODE_EXECUTOR_LOCK = threading.Lock()


def _encode_executor() -> _cf.ThreadPoolExecutor:
    """The one encode thread (created on first use; its worker never exits while the daemon runs)."""
    global _ENCODE_EXECUTOR
    with _ENCODE_EXECUTOR_LOCK:
        if _ENCODE_EXECUTOR is None:
            _ENCODE_EXECUTOR = _cf.ThreadPoolExecutor(max_workers=1, thread_name_prefix="ccv3-encode")
        return _ENCODE_EXECUTOR


def _on_encode_thread(fn: Any, *args: Any, timeout: float = ENCODE_WAIT_S) -> Any:
    """Run ``fn(*args)`` on the encode thread under _EMBED_CALL_LOCK and return its result.

    Raises fn's own exception, or concurrent.futures.TimeoutError after ``timeout`` seconds
    (the encode keeps running; the caller gets an error frame and is not held).
    """
    def _locked() -> Any:
        with _EMBED_CALL_LOCK:
            return fn(*args)

    return _encode_executor().submit(_locked).result(timeout=timeout)


def _daemon_embed(text: str) -> list[float]:
    """``embed`` on the encode thread. ``embed`` is looked up at call time (tests patch it)."""
    return _on_encode_thread(lambda: embed(text, model=None))


def _daemon_embed_batch(texts: list[str]) -> list[list[float]]:
    """``embed_batch`` on the encode thread."""
    return _on_encode_thread(lambda: embed_batch(texts, model=None))


# Set by the commit-ceiling exit: the daemon takes no new encode work and ping reports not ready.
_DRAINING = threading.Event()


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    """Read exactly `n` bytes or raise EOFError on short read."""
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise EOFError(f"socket closed after {len(buf)}/{n} bytes")
        buf.extend(chunk)
    return bytes(buf)


def _recv_frame(sock: socket.socket) -> dict[str, Any]:
    """Receive a single length-prefixed JSON frame."""
    header = _recv_exact(sock, 4)
    (length,) = struct.unpack(">I", header)
    if length > 100 * 1024 * 1024:  # 100 MB sanity limit
        raise ValueError(f"frame too large: {length} bytes")
    payload = _recv_exact(sock, length)
    return json.loads(payload.decode("utf-8"))


def _send_frame(sock: socket.socket, obj: dict[str, Any]) -> None:
    """Send a single length-prefixed JSON frame."""
    payload = json.dumps(obj, default=str).encode("utf-8")
    sock.sendall(struct.pack(">I", len(payload)) + payload)


def _model_ready() -> bool:
    """Return True if the model has been loaded into the cache."""
    return _MODEL is not None


# ---------------------------------------------------------------------------
# ST-05: resident recall runtime (background asyncio loop + asyncpg pool)
# ---------------------------------------------------------------------------
#
# ADDITIVE-ONLY. The `recall` op embeds the query IN-PROCESS with the resident
# model (H6 — same vector space as `embed`), then runs the EXISTING hybrid RRF
# (recall_learnings.do_recall) on a background event loop that exclusively owns
# the asyncpg pool (via db.postgres_pool.get_pool() — NO second pool, NO second
# model). embed / embed_batch / ping / shutdown are untouched. If the pool
# never comes up, _RECALL_READY stays False and the daemon still serves
# embedding normally; recall callers fall back to the uv path (R2/R9).

_RECALL_LOOP: asyncio.AbstractEventLoop | None = None
_RECALL_THREAD: threading.Thread | None = None
_RECALL_POOL: Any = None
_RECALL_READY: bool = False
_RECALL_RUNTIME_LOCK = threading.Lock()


def _recall_loop_ok() -> bool:
    """True iff the background recall loop is live (running and not closed)."""
    loop = _RECALL_LOOP
    return bool(loop is not None and loop.is_running() and not loop.is_closed())


def _set_recall_ready(value: bool) -> None:
    """Set the recall-ready flag (the H2 watchdog clears it on a dead loop)."""
    global _RECALL_READY
    _RECALL_READY = value


def _get_do_recall():
    """Resolve ``recall_learnings.do_recall``.

    Indirected so the recall handler does not hard-bind the import path and so
    tests can patch this seam. The LIVE daemon runs as a SCRIPT
    (``sys.path[0] == .../opc/scripts/core``), so the sibling form resolves —
    the SAME style as _init_recall_pool's ``from db.postgres_pool import …`` and
    recall_learnings' own ``from db.…`` imports. The pytest context imports the
    daemon as ``core.embedding_daemon`` with opc/scripts on the path, where only
    the ``core.`` package form resolves. Try the sibling form first, fall back to
    the package form (fixes ModuleNotFoundError: No module named 'core' in the
    real ``uv run --project opc`` launch — the earlier claim was test-context only).
    """
    try:
        from recall_learnings import do_recall  # noqa: PLC0415  (script context — live daemon)
    except ModuleNotFoundError:
        from core.recall_learnings import do_recall  # noqa: PLC0415  (package context — pytest)
    return do_recall


def _start_recall_loop() -> asyncio.AbstractEventLoop:
    """Start the background asyncio loop in a daemon thread (idempotent)."""
    global _RECALL_LOOP, _RECALL_THREAD
    if _RECALL_THREAD is not None and _RECALL_THREAD.is_alive() and _recall_loop_ok():
        return _RECALL_LOOP  # type: ignore[return-value]
    loop = asyncio.new_event_loop()

    def _run() -> None:
        asyncio.set_event_loop(loop)
        loop.run_forever()

    thread = threading.Thread(target=_run, name="ccv3-recall-loop", daemon=True)
    thread.start()
    # Wait briefly for the loop to actually start running before we submit to it.
    for _ in range(200):
        if loop.is_running():
            break
        time.sleep(0.005)
    _RECALL_LOOP = loop
    _RECALL_THREAD = thread
    return loop


def _init_recall_pool(timeout_s: float = RECALL_POOL_INIT_TIMEOUT_S) -> bool:
    """Create + hold the asyncpg pool on the recall loop; set ``_RECALL_READY``.

    Reuses the process-singleton ``db.postgres_pool.get_pool()`` — no second
    pool. Returns True iff the pool is live. On ANY failure leaves
    ``_RECALL_READY=False`` and returns False (embed/ping keep working — the
    recall op is purely additive).
    """
    global _RECALL_POOL
    loop = _RECALL_LOOP
    if loop is None or not _recall_loop_ok():
        _set_recall_ready(False)
        return False

    async def _make_pool() -> Any:
        from db.postgres_pool import get_pool  # noqa: PLC0415
        return await get_pool()

    try:
        fut = asyncio.run_coroutine_threadsafe(_make_pool(), loop)
        pool = fut.result(timeout=timeout_s)
    except Exception as exc:  # noqa: BLE001
        print(
            f"[embedding] daemon: recall pool init failed "
            f"({type(exc).__name__}: {exc}) — recall disabled, embed/ping unaffected",
            file=sys.stderr,
            flush=True,
        )
        _set_recall_ready(False)
        return False

    _RECALL_POOL = pool
    _set_recall_ready(True)
    print("[embedding] daemon: recall ready (asyncpg pool live)", file=sys.stderr, flush=True)
    return True


def _start_recall_runtime() -> bool:
    """Stand up the recall loop + pool. Called once, AFTER model warmup.

    Idempotent + serialized. Best-effort: a failure to create the pool does
    NOT break the daemon (embed/ping/shutdown unaffected; R9 fallback intact).
    """
    with _RECALL_RUNTIME_LOCK:
        try:
            _start_recall_loop()
            return _init_recall_pool()
        except Exception as exc:  # noqa: BLE001
            print(
                f"[embedding] daemon: recall runtime start failed "
                f"({type(exc).__name__}: {exc}) — recall disabled",
                file=sys.stderr,
                flush=True,
            )
            _set_recall_ready(False)
            return False


# A3 (2026-06-29): in-process recall-loop watchdog. H2 clears _RECALL_READY on a
# dead loop at REQUEST time (clients then fall back to the uv path), but nothing
# RESTARTS the loop short of a full daemon restart. Over a weeks-long unattended
# uptime the loop could die (or Postgres could bounce, leaving the pool down at
# launch) and the resident fast path would stay degraded until the next daemon
# restart. This watchdog PROACTIVELY re-stands-up the runtime so it self-heals.
_RECALL_WATCHDOG_STARTED = False


def _recall_watchdog_tick(was_ready: bool) -> bool:
    """One watchdog iteration: if the recall runtime is down, restart it.

    ``_start_recall_runtime`` is idempotent + lock-serialized, so re-invoking it
    is always safe. Logs ONLY on health transitions (avoids per-minute log spam
    over a long uptime). Never raises. Returns the new ``was_ready`` state.
    """
    try:
        if _recall_loop_ok() and _RECALL_READY:
            if not was_ready:
                print(
                    "[embedding] daemon: recall watchdog — runtime healthy again",
                    file=sys.stderr,
                    flush=True,
                )
            return True
        if was_ready:
            print(
                "[embedding] daemon: recall watchdog — runtime down, restarting",
                file=sys.stderr,
                flush=True,
            )
        _start_recall_runtime()
        return False
    except Exception:  # noqa: BLE001 — a watchdog must never crash the daemon
        return False


# ---------------------------------------------------------------------------
# Commit ceiling (embedding-daemon-commit-leak B'): a bound on ANY future leak.
# ---------------------------------------------------------------------------
# The watchdog reads the daemon's private commit every tick. Over the ceiling the daemon drains:
# it takes no new encode work, removes its discovery file, lets the encode in progress finish (or
# CEILING_DRAIN_S pass), then shuts down. The next client call starts a fresh daemon on demand.
# A fresh daemon holds about 3 GB, so a ceiling under CEILING_FLOOR_MB would restart in a loop:
# such a value, 0, or a value that is not a whole number falls back to the default with one log line.
COMMIT_CEILING_ENV = "CCV3_EMBED_COMMIT_CEILING_MB"
COMMIT_CEILING_DEFAULT_MB = 8192
CEILING_FLOOR_MB = 4096
CEILING_DRAIN_S = 30.0
_SERVER: Any = None
_CEILING_EXIT_STARTED = threading.Event()


def _commit_ceiling_mb(env: Any = None) -> int:
    """The ceiling in MB from COMMIT_CEILING_ENV, else the default. Logs once per call on a bad value."""
    raw = (os.environ if env is None else env).get(COMMIT_CEILING_ENV)
    if raw is None or str(raw).strip() == "":
        return COMMIT_CEILING_DEFAULT_MB
    try:
        value = int(str(raw).strip())
    except ValueError:
        value = None
    if value is None or value < CEILING_FLOOR_MB:
        print(
            f"[embedding] daemon: {COMMIT_CEILING_ENV} is not a whole number of at least "
            f"{CEILING_FLOOR_MB}; using {COMMIT_CEILING_DEFAULT_MB} MB",
            file=sys.stderr,
            flush=True,
        )
        return COMMIT_CEILING_DEFAULT_MB
    return value


def _private_commit_mb() -> int:
    """This process's private commit in MB (psutil: PrivateUsage on Windows, uss elsewhere)."""
    import psutil  # noqa: PLC0415  (only the daemon path needs it)

    proc = psutil.Process()
    private = getattr(proc.memory_info(), "private", None)
    if private is None:
        private = proc.memory_full_info().uss
    return int(private // (1024 * 1024))


def _os_thread_count() -> int:
    try:
        import psutil  # noqa: PLC0415

        return int(psutil.Process().num_threads())
    except Exception:  # noqa: BLE001
        return -1


def _begin_ceiling_exit(size_mb: int, ceiling_mb: int, *, shutdown: Any = None, drain_s: float = CEILING_DRAIN_S) -> bool:
    """Drain and stop the daemon once. Never cuts the encode in progress short of ``drain_s``.

    The log line holds sizes and counts only: no request text, no database address.
    Returns True when this call started the exit, False when one was already started.
    """
    if _CEILING_EXIT_STARTED.is_set():
        return False
    _CEILING_EXIT_STARTED.set()
    _DRAINING.set()
    print(
        f"[embedding] daemon: commit ceiling: private {int(size_mb)} MB over {int(ceiling_mb)} MB; "
        f"os threads {_os_thread_count()}; python threads {threading.active_count()}; draining, then exiting",
        file=sys.stderr,
        flush=True,
    )
    _delete_own_daemon_info()
    # The encode thread is FIFO with one worker: a no-op completes after the encode in progress and any queued one.
    try:
        _encode_executor().submit(lambda: None).result(timeout=drain_s)
    except Exception:  # noqa: BLE001  (a hung encode: stop anyway after drain_s)
        pass
    stop = shutdown if shutdown is not None else (_SERVER.shutdown if _SERVER is not None else None)
    if stop is not None:
        threading.Thread(target=stop, name="ccv3-ceiling-exit", daemon=True).start()
    return True


def _ceiling_tick(*, read_mb: Any = None, ceiling_mb: int | None = None, begin_exit: Any = None) -> bool:
    """One ceiling check. Never raises. Returns True when the exit was started by this tick."""
    try:
        limit = _commit_ceiling_mb() if ceiling_mb is None else ceiling_mb
        size = (read_mb or _private_commit_mb)()
        if size <= limit:
            return False
        return bool((begin_exit or _begin_ceiling_exit)(size, limit))
    except Exception:  # noqa: BLE001 — a watchdog must never crash the daemon
        return False


def _recall_watchdog(interval_s: float = 60.0) -> None:
    """Background loop: re-check + heal the recall runtime, and check the commit ceiling, every ``interval_s``."""
    was_ready = True
    ceiling = _commit_ceiling_mb()  # read once: a bad value logs one line, not one per tick
    while True:
        time.sleep(interval_s)
        was_ready = _recall_watchdog_tick(was_ready)
        if _SERVER is not None:
            _ceiling_tick(ceiling_mb=ceiling)


def _start_recall_watchdog() -> None:
    """Start the recall watchdog daemon thread once (idempotent)."""
    global _RECALL_WATCHDOG_STARTED
    if _RECALL_WATCHDOG_STARTED:
        return
    _RECALL_WATCHDOG_STARTED = True
    threading.Thread(
        target=_recall_watchdog, name="ccv3-recall-watchdog", daemon=True
    ).start()


def _stop_recall_runtime() -> None:
    """Best-effort, non-blocking stop of the recall loop (on daemon shutdown).

    The loop thread is a daemon thread, so process exit also reclaims it; this
    just clears the ready flag and asks the loop to stop. Never raises.
    """
    _set_recall_ready(False)
    loop = _RECALL_LOOP
    if loop is not None:
        try:
            loop.call_soon_threadsafe(loop.stop)
        except Exception:  # noqa: BLE001
            pass


def _build_ping_response() -> dict[str, Any]:
    """Build the ``ping`` reply.

    BACKWARD-COMPATIBLE (ST-05): the legacy ``ok`` / ``ready`` / ``model`` /
    ``dim`` fields are unchanged; this ONLY ADDS ``recall_ready`` + ``loop_ok``
    so a client can route a recall precisely (and watchdog a dead loop).
    """
    return {
        "ok": True,
        # A draining daemon (commit-ceiling exit) is not ready: clients fall back, then spawn a fresh one.
        "ready": _model_ready() and not _DRAINING.is_set(),
        "model": MODEL_NAME,
        "dim": EMBEDDING_DIM,
        "recall_ready": bool(_RECALL_READY),
        "loop_ok": _recall_loop_ok(),
    }


def _handle_recall_request(req: dict[str, Any]) -> dict[str, Any]:
    """Process a ``recall`` request; return the full response payload dict.

    H1: the WHOLE body is wrapped in try/except — ANY internal error returns
    ``{ok:false, error}``. ``ok:true`` is returned ONLY for a genuinely
    completed query (even when ``results == []``). An error NEVER masquerades
    as a "no match".

    Response (success)::

        {ok:true, results:[...--json entries...],
         _meta:{vector_count, fts_count, threshold_drops, model, dim, db_error?},
         elapsed_ms}

    Response (failure)::

        {ok:false, error:"<reason>"}
    """
    t0 = time.perf_counter()
    try:
        query = req.get("query", "")
        if not isinstance(query, str) or not query.strip():
            return {"ok": False, "error": "query must be a non-empty string"}
        try:
            k = int(req.get("k", 5))
        except (TypeError, ValueError):
            k = 5
        mode = req.get("mode", "hybrid")
        if not isinstance(mode, str):
            mode = "hybrid"
        # Optional caller-forwarded scope (ST-05 cross-project parity). The TS
        # client SHOULD pass these so the daemon recall scopes to the CALLER's
        # project rather than the daemon's launch CWD. When absent, do_recall
        # falls back to opc-dir scope (matching the uv fallback's cwd=<opc>).
        req_project_id = req.get("project_id")
        req_scope_mode = req.get("scope_mode")
        if not isinstance(req_project_id, str):
            req_project_id = None
        if not isinstance(req_scope_mode, str):
            req_scope_mode = None

        # R2: never serve recall before the pool is live.
        if not _RECALL_READY:
            return {"ok": False, "error": "recall_not_ready"}
        loop = _RECALL_LOOP
        if loop is None or not _recall_loop_ok():
            _set_recall_ready(False)  # H2 watchdog
            return {"ok": False, "error": "recall_loop_dead"}

        # H6: embed IN-PROCESS with the resident model (same vector space as
        # `embed`), on the one encode thread (serialized by _EMBED_CALL_LOCK).
        if _DRAINING.is_set():
            return {"ok": False, "error": "daemon_draining"}
        query_vector = _daemon_embed(query)

        do_recall = _get_do_recall()

        # H2: run_coroutine_threadsafe raises RuntimeError SYNCHRONOUSLY when
        # the loop is closed/dead — wrap the SUBMIT separately from the wait.
        try:
            fut = asyncio.run_coroutine_threadsafe(
                do_recall(query_vector, query, k, mode,
                          project_id=req_project_id, scope_mode=req_scope_mode),
                loop,
            )
        except RuntimeError as exc:
            _set_recall_ready(False)
            return {"ok": False, "error": f"recall_submit_failed: {exc}"}

        # H2: bound the wait — a dead loop or slow/contended query must not
        # hang the socketserver thread. concurrent.futures.TimeoutError on
        # timeout; RuntimeError if the loop dies while we wait.
        try:
            result = fut.result(timeout=RECALL_TIMEOUT_S)
        except (_cf.TimeoutError, asyncio.TimeoutError):
            return {"ok": False, "error": "recall_timeout"}
        except RuntimeError as exc:
            _set_recall_ready(False)
            return {"ok": False, "error": f"recall_loop_died: {exc}"}

        elapsed_ms = (time.perf_counter() - t0) * 1000
        # H6: stamp the resident model identity + dim onto _meta so the client
        # can sanity-check vector-space parity before trusting the results.
        meta = dict(result.get("_meta", {}))
        meta["model"] = MODEL_NAME
        meta["dim"] = EMBEDDING_DIM
        return {
            "ok": True,
            "results": result.get("results", []),
            "_meta": meta,
            "elapsed_ms": elapsed_ms,
        }
    except Exception as exc:  # noqa: BLE001  # H1: any error -> ok:false
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


class _EmbeddingHandler(socketserver.BaseRequestHandler):
    """Handle one embedding request per connection."""

    def handle(self) -> None:  # noqa: D401 (socketserver API)
        try:
            self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        try:
            req = _recv_frame(self.request)
            cmd = req.get("cmd", "embed")
            if cmd == "ping":
                # ST-05: backward-compatible — adds recall_ready + loop_ok only.
                _send_frame(self.request, _build_ping_response())
                return
            if cmd == "recall":
                # ST-05: resident recall op. Self-contained, never raises
                # (H1) — returns {ok:false, error} on any failure so the
                # client falls back to the uv path without hanging.
                _send_frame(self.request, _handle_recall_request(req))
                return
            if cmd == "shutdown":
                _send_frame(self.request, {"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if cmd == "embed":
                text = req.get("text", "")
                if not isinstance(text, str):
                    _send_frame(self.request, {"error": "text must be a string"})
                    return
                if _DRAINING.is_set():
                    _send_frame(self.request, {"error": "daemon_draining"})
                    return
                t0 = time.perf_counter()
                vec = _daemon_embed(text)
                elapsed_ms = (time.perf_counter() - t0) * 1000
                _send_frame(self.request, {
                    "vector": vec,
                    "elapsed_ms": elapsed_ms,
                    "dim": len(vec),
                })
                return
            if cmd == "embed_batch":
                texts = req.get("texts", [])
                if not isinstance(texts, list):
                    _send_frame(self.request, {"error": "texts must be a list"})
                    return
                if not all(isinstance(t, str) for t in texts):
                    _send_frame(self.request, {"error": "all texts must be strings"})
                    return
                if _DRAINING.is_set():
                    _send_frame(self.request, {"error": "daemon_draining"})
                    return
                t0 = time.perf_counter()
                vecs = _daemon_embed_batch(texts)
                elapsed_ms = (time.perf_counter() - t0) * 1000
                _send_frame(self.request, {
                    "vectors": vecs,
                    "elapsed_ms": elapsed_ms,
                    "count": len(vecs),
                })
                return
            _send_frame(self.request, {"error": f"unknown cmd: {cmd!r}"})
        except (EOFError, ConnectionResetError, BrokenPipeError):
            # Client disconnected before we could reply -- nothing useful to do.
            return
        except Exception as exc:  # noqa: BLE001
            try:
                _send_frame(self.request, {"error": str(exc)})
            except OSError:
                pass


class _ThreadingTCPServer(socketserver.ThreadingTCPServer):
    """Threading TCP server with SO_REUSEADDR and faster shutdown."""

    allow_reuse_address = True
    daemon_threads = True


def _write_daemon_info(pid: int, port: int) -> None:
    """Write daemon discovery file. Called AFTER model is loaded.

    Clients should treat the file's absence (or stale PID) as
    "daemon not ready" and fall back to in-process embedding.
    """
    info = {
        "pid": pid,
        "port": port,
        "started_at": time.time(),
        "model": MODEL_NAME,
        "dim": EMBEDDING_DIM,
    }
    DAEMON_INFO_PATH.write_text(json.dumps(info), encoding="utf-8")


def _delete_daemon_info() -> None:
    """Remove daemon discovery file (best-effort)."""
    try:
        DAEMON_INFO_PATH.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _delete_own_daemon_info(path: Path | None = None) -> bool:
    """Remove the discovery file only when it names THIS process. Never another daemon's file. Never raises."""
    p = DAEMON_INFO_PATH if path is None else path
    try:
        info = json.loads(p.read_text(encoding="utf-8"))
        if int(info.get("pid", -1)) != os.getpid():
            return False
        p.unlink()
        return True
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def _check_existing_daemon() -> bool:
    """Return True if another healthy daemon instance is already running.

    Defense-in-depth startup guard (Task #21). Called at the top of
    ``_run_daemon`` BEFORE the 30s model load.  If this returns True the
    caller should ``sys.exit(0)`` cleanly without loading the model.

    Decision table
    ~~~~~~~~~~~~~~
    * Discovery file absent                    → False (proceed, we're first)
    * File present, PID dead                   → False (stale; proceed)
    * File present, PID alive, ping fails      → False (broken instance; take over)
    * File present, PID alive, wrong model     → False (different model; take over)
    * File present, PID alive, ping ok, model matches → True (exit cleanly)

    The discovery file is NOT deleted on a dead-PID find — we let the normal
    startup path overwrite it, avoiding a delete-then-crash race.
    """
    info = read_daemon_info()
    if not info:
        return False

    pid = int(info.get("pid", 0))
    port = int(info.get("port", 0))

    if not _pid_alive(pid):
        return False

    # PID is alive — try a ping with 1500ms timeout.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(1.5)
            sock.connect(("127.0.0.1", port))
            _send_frame(sock, {"cmd": "ping"})
            reply = _recv_frame(sock)
    except (OSError, ConnectionRefusedError, EOFError, ValueError, json.JSONDecodeError):
        # Any failure: can't reach the daemon — proceed (it's broken).
        return False

    # Ping succeeded — check that the model matches.
    if reply.get("model") != MODEL_NAME:
        return False

    # Another healthy instance is running.
    print(
        f"[embedding] daemon: another instance alive (pid={pid} port={port}) — exiting",
        file=sys.stderr,
        flush=True,
    )
    return True


def _acquire_exclusive_lock(lock_path: Path = DAEMON_LOCK_PATH) -> int | None:
    """Cross-process exclusive lock on the daemon startup path.

    Returns an open file descriptor on success (caller must keep it open for
    the lifetime of the daemon). Returns ``None`` if another process already
    holds the lock.

    Why this exists (BLOCKER-1): two daemon spawners that both pass
    ``_check_existing_daemon()`` at the same instant can race and end up
    with two model-load processes, two port binds, and a stomped discovery
    file. The TS-side spawn lock in ``embedding-client.ts`` covers the
    hook path; this OS-level lock covers Windows Task Scheduler pre-warm,
    direct CLI starts, and any other path the TS lock doesn't see.

    Implementation:
        * Windows uses ``msvcrt.locking(fd, LK_NBLCK, 1)`` on byte 0.
        * POSIX uses ``fcntl.flock(fd, LOCK_EX | LOCK_NB)``.
        * On success we register an ``atexit`` hook to close the fd and
          unlink the lock file. Lock contents are the holder's PID for
          debugging — never load-bearing, since the OS owns the actual lock.
        * Failure modes (file-open error, lock contention) return ``None``
          and do NOT register cleanup, so a losing acquirer never deletes
          the winning daemon's lock file.

    Args:
        lock_path: Path of the lock file. Defaults to DAEMON_LOCK_PATH but
            tests can pass a temp path to avoid cross-test interference.

    Returns:
        Open file descriptor, or ``None`` if another holder exists.
    """
    try:
        fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o644)
    except OSError as exc:
        print(
            f"[embedding] daemon: lock open failed: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return None

    try:
        if sys.platform == "win32":
            import msvcrt  # noqa: PLC0415
            try:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            except OSError:
                os.close(fd)
                return None
        else:
            import fcntl  # noqa: PLC0415
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os.close(fd)
                return None
    except Exception:
        # Defensive: any unexpected error releasing the lock-related
        # imports/syscalls. Treat as "couldn't acquire" so we don't half-hold.
        try:
            os.close(fd)
        except OSError:
            pass
        return None

    # Write the holder PID for debugging. Best-effort — failure here does
    # NOT release the lock (the OS still owns it via the fd).
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, f"{os.getpid()}\n".encode("utf-8"))
        try:
            os.fsync(fd)
        except OSError:
            # Some filesystems (e.g. some Windows temp filesystems) don't
            # support fsync on this kind of handle. Not fatal.
            pass
    except OSError:
        pass

    # Register cleanup ONLY on the success path. A loser that already
    # returned None never reaches this line, so it can't unlink the
    # winner's lock file.
    def _cleanup(_fd: int = fd, _path: Path = lock_path) -> None:
        try:
            os.close(_fd)
        except OSError:
            pass
        try:
            os.unlink(str(_path))
        except OSError:
            pass

    atexit.register(_cleanup)
    return fd


def _hide_own_console_on_windows() -> None:
    """Hide our own console window on Windows so a Bash-spawned or
    Task-Scheduler-spawned daemon doesn't clutter the taskbar.

    No-op on POSIX. Fail-open if the Win32 call doesn't work (e.g., daemon
    launched without an attached console). The hook spawn path already passes
    ``windowsHide: true``; this protects the non-hook paths.
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes  # noqa: PLC0415
        hwnd = ctypes.windll.kernel32.GetConsoleWindow()  # type: ignore[attr-defined]
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 0)  # type: ignore[attr-defined]  # SW_HIDE
    except Exception:
        # Don't break the daemon over a UX nicety.
        pass


def _acquire_startup_slot() -> int | None:
    """Return a held exclusive-lock fd if THIS process should become the
    daemon, or ``None`` if it should exit cleanly WITHOUT loading the model.

    Order (storm hardening, 2026-06-29): check for an existing HEALTHY peer
    FIRST via the cheap ``_check_existing_daemon`` ping, so a redundant spawn
    -- the common case when a hook fires ``ensureDaemonRunning`` while the
    daemon is already up -- exits without opening or contending for the OS
    lock file. Only a genuine cold start (no healthy peer) proceeds to
    ``_acquire_exclusive_lock``, which stays the authoritative anti-double-load
    guard: a cold-start race still resolves to exactly one model-loading
    daemon (losers get ``None`` and exit before the ~30s model load).

    Verified 2026-06-29: the OS lock serializes correctly on Windows
    (``msvcrt.locking`` LK_NBLCK -- 1 ACQUIRED / 2 BLOCKED under 3 concurrent
    acquirers), so this function can NEVER hand a second process a slot while
    a model-loading daemon holds the lock. The bounded residual is a redundant
    ``uv run`` startup under a concurrency burst, which exits here cheaply.
    """
    if _check_existing_daemon():
        return None
    return _acquire_exclusive_lock()


def _run_daemon(port: int) -> int:
    """Run the embedding daemon on 127.0.0.1:port (port=0 means pick free)."""
    # UX: hide our console window on Windows regardless of who spawned us.
    _hide_own_console_on_windows()

    # Startup slot (storm hardening): check for a healthy peer FIRST (cheap
    # ping -> redundant spawns exit before touching the lock), THEN contend for
    # the cross-process exclusive lock. The lock stays the authoritative
    # anti-double-load guard (BLOCKER-1): two cold-start spawners still collapse
    # to exactly one model-loading daemon. We keep the fd alive for the daemon's
    # lifetime -- closing it (via atexit) releases the OS-level lock.
    _lock_fd = _acquire_startup_slot()
    if _lock_fd is None:
        print(
            "[embedding] daemon: another daemon serves or holds the startup "
            "lock — exiting",
            file=sys.stderr,
            flush=True,
        )
        return 0

    # Pre-load the model BEFORE binding the port AND BEFORE writing the
    # discovery file. Clients that see the discovery file assume the
    # daemon is hot and ready to serve.
    print("[embedding] daemon: pre-loading model...", file=sys.stderr, flush=True)
    model = load_model()
    # Warm-up encode pass to compile internal caches (kernel autotune etc).
    # On the encode thread, so the one OpenMP team the daemon keeps is built here, not per request.
    t_warm = time.perf_counter()
    _ = _on_encode_thread(lambda: model.encode("warmup", convert_to_numpy=True))
    print(
        f"[embedding] daemon: warmup encode: "
        f"{(time.perf_counter() - t_warm) * 1000:.1f}ms",
        file=sys.stderr,
        flush=True,
    )

    # ST-05: stand up the resident recall runtime AFTER the model warmup
    # (background asyncio loop + asyncpg pool). Best-effort + additive — a
    # failure here disables recall (recall_ready stays False) but leaves
    # embed / embed_batch / ping / shutdown fully functional.
    _start_recall_runtime()
    # A3: keep the resident recall runtime healthy over a long uptime (restart a
    # dead loop / bring the pool up if Postgres was down at launch). Idempotent.
    _start_recall_watchdog()

    server = _ThreadingTCPServer(("127.0.0.1", port), _EmbeddingHandler)
    global _SERVER
    _SERVER = server  # the commit-ceiling exit stops it (see _begin_ceiling_exit)
    actual_port = server.server_address[1]
    pid = os.getpid()
    _write_daemon_info(pid, actual_port)
    print(
        f"[embedding] daemon: listening on 127.0.0.1:{actual_port} (pid={pid})",
        file=sys.stderr,
        flush=True,
    )
    print(
        f"[embedding] daemon: info file: {DAEMON_INFO_PATH}",
        file=sys.stderr,
        flush=True,
    )

    def _shutdown_handler(signum, _frame):  # noqa: ANN001
        print(
            f"[embedding] daemon: received signal {signum}, shutting down...",
            file=sys.stderr,
            flush=True,
        )
        threading.Thread(target=server.shutdown, daemon=True).start()

    # SIGTERM is the standard shutdown signal. SIGINT (Ctrl+C) likewise.
    # Windows additionally exposes SIGBREAK for Ctrl+Break.
    for sig_name in ("SIGTERM", "SIGINT", "SIGBREAK"):
        sig = getattr(signal, sig_name, None)
        if sig is not None:
            try:
                signal.signal(sig, _shutdown_handler)
            except (ValueError, OSError):
                # Some signals can't be installed on the main thread on
                # Windows (e.g. when running under certain harnesses). Skip.
                pass

    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        # ST-05: best-effort, non-blocking stop of the recall loop.
        _stop_recall_runtime()
        try:
            server.server_close()
        finally:
            _delete_daemon_info()
            print(
                "[embedding] daemon: stopped, info file cleaned up",
                file=sys.stderr,
                flush=True,
            )
    return 0


# ---------------------------------------------------------------------------
# Daemon client helpers (used by recall_learnings.py)
# ---------------------------------------------------------------------------

def read_daemon_info() -> dict[str, Any] | None:
    """Read daemon discovery file; return None if missing or invalid."""
    if not DAEMON_INFO_PATH.exists():
        return None
    try:
        return json.loads(DAEMON_INFO_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _pid_alive(pid: int) -> bool:
    """Return True if the given PID is alive (cross-platform).

    Windows note: ``os.kill(pid, 0)`` raises ``OSError [WinError 87]`` on
    Windows for ANY pid -- the kernel rejects signal 0 -- so we can't
    distinguish alive from dead via os.kill there. We use
    ``OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, ...)`` via ctypes
    instead.
    """
    if pid <= 0:
        return False
    if sys.platform == "win32":
        # Windows-native check via OpenProcess.
        try:
            import ctypes  # noqa: PLC0415
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            handle = kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, pid
            )
            if not handle:
                return False
            # Holding a handle is enough -- if the pid is reused by a brand
            # new process we'd false-positive, but for our daemon discovery
            # this is acceptable (worst case: send to dead-pid daemon,
            # connect fails, fall back to in-process embedding).
            kernel32.CloseHandle(handle)
            return True
        except Exception:  # noqa: BLE001
            return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # Process exists but we don't own it -- treat as alive.
        return True
    except OSError:
        return False


def daemon_is_alive() -> tuple[bool, dict[str, Any] | None]:
    """Return (alive, info) for the embedding daemon."""
    info = read_daemon_info()
    if not info:
        return False, None
    pid = int(info.get("pid", 0))
    if not _pid_alive(pid):
        return False, info
    return True, info


def embed_via_daemon(
    text: str,
    timeout_s: float = 30.0,
) -> dict[str, Any] | None:
    """Send an embed request to the daemon, return its response.

    Returns ``None`` if the daemon is unreachable / not ready (caller
    should fall back to in-process embedding).
    """
    alive, info = daemon_is_alive()
    if not alive or not info:
        return None
    port = int(info.get("port", 0))
    if port <= 0:
        return None
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout_s) as sock:
            try:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
            sock.settimeout(timeout_s)
            _send_frame(sock, {"cmd": "embed", "text": text})
            return _recv_frame(sock)
    except (OSError, EOFError, json.JSONDecodeError):
        return None


def embed_batch_via_daemon(
    texts: list[str],
    timeout_s: float = 60.0,
) -> dict[str, Any] | None:
    """Send an embed_batch request to the daemon, return its response.

    Returns ``None`` if the daemon is unreachable.
    """
    alive, info = daemon_is_alive()
    if not alive or not info:
        return None
    port = int(info.get("port", 0))
    if port <= 0:
        return None
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout_s) as sock:
            try:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
            sock.settimeout(timeout_s)
            _send_frame(sock, {"cmd": "embed_batch", "texts": texts})
            return _recv_frame(sock)
    except (OSError, EOFError, json.JSONDecodeError):
        return None


def ping_daemon(timeout_s: float = 2.0) -> dict[str, Any] | None:
    """Ping the daemon. Returns the response dict, or None if unreachable.

    Lighter-weight than ``daemon_is_alive`` for liveness probes: it actually
    talks to the daemon so we know the TCP socket is accepting AND the
    model is loaded (``ready=True`` flag).
    """
    alive, info = daemon_is_alive()
    if not alive or not info:
        return None
    port = int(info.get("port", 0))
    if port <= 0:
        return None
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout_s) as sock:
            try:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
            sock.settimeout(timeout_s)
            _send_frame(sock, {"cmd": "ping"})
            return _recv_frame(sock)
    except (OSError, EOFError, json.JSONDecodeError):
        return None


# ---------------------------------------------------------------------------
# Bench mode (verification gate for the latency budget)
# ---------------------------------------------------------------------------

def _run_bench() -> int:
    """Internal hot-loop bench: 10 single-text embeds.

    Reports cold-load time, warmup time, and p50/p95 of hot embeds. JSON
    to stdout. Percentile method matches rerank.py's bench (true median
    for p50, ceil nearest-rank for p95) -- which is the post-fix version
    from commit 83d1308.
    """
    texts = [
        "Phase 2 of the memory system adds a cross-encoder reranker on top of hybrid RRF.",
        "BGE-large-en-v1.5 produces 1024-dim embeddings that match the archival_memory schema.",
        "Cold model load on Windows CPU is ~30-45s; warm encode is ~30-100ms per query.",
        "A long-lived daemon eliminates the sentence-transformers import tax on every recall.",
        "Length-prefixed JSON frames over TCP loopback mirror the Phase 2 rerank protocol.",
        "Discovery file ~/.claude/run/ccv3-embedding.json gives clients PID+port after warmup.",
        "Spawn-on-first-hit detached lifecycle: cold start blocks first caller, then warm.",
        "The query embedding must byte-for-byte match LocalEmbeddingProvider for cosine recall.",
        "TCP_NODELAY is set on both daemon and client sockets to minimise small-frame latency.",
        "Threading.Lock around model.encode serialises calls -- model is not thread-safe.",
    ]

    # Cold-load timing
    t_cold = time.perf_counter()
    model = load_model()
    cold_ms = (time.perf_counter() - t_cold) * 1000

    # Single warmup
    t_warm = time.perf_counter()
    _ = model.encode("warmup", convert_to_numpy=True)
    warmup_ms = (time.perf_counter() - t_warm) * 1000

    # 10 hot embeds (single-text)
    times: list[float] = []
    for i in range(10):
        text = texts[i % len(texts)]
        t0 = time.perf_counter()
        embed(text, model=model)
        times.append((time.perf_counter() - t0) * 1000)

    times.sort()
    # Delegate to shared helpers in core.utils so all bench modes stay in sync.
    # (Phase 2 MEDIUM-4: previously duplicated across rerank.py, eval_recall.py,
    # and embedding_daemon.py.)
    from core.utils import percentile as _pct, median as _median  # noqa: PLC0415
    p50_ms = _median(times)
    p95_ms = _pct(times, 95)
    out = {
        "cold_ms": cold_ms,
        "warmup_ms": warmup_ms,
        "p50_ms": p50_ms,
        "p95_ms": p95_ms,
        "all_ms": times,
        "iterations": len(times),
        "model": MODEL_NAME,
        "dim": EMBEDDING_DIM,
    }
    print(json.dumps(out, indent=2))
    return 0


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    """Build the argparse CLI."""
    p = argparse.ArgumentParser(
        prog="embedding_daemon.py",
        description="Persistent BGE-large embedding daemon for memory recall.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--daemon",
        action="store_true",
        help="Run as a long-lived TCP daemon on 127.0.0.1.",
    )
    p.add_argument(
        "--port",
        type=int,
        default=0,
        help="TCP port for daemon mode (0 = pick free port).",
    )
    p.add_argument(
        "--bench",
        action="store_true",
        help="Run internal hot-loop bench (10x embed of dummy texts).",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint."""
    args = _build_parser().parse_args(argv)
    if args.daemon:
        return _run_daemon(args.port)
    if args.bench:
        return _run_bench()
    # Default: one-shot mode -- read stdin, embed, print vector.
    return _run_oneshot()


if __name__ == "__main__":
    sys.exit(main())
