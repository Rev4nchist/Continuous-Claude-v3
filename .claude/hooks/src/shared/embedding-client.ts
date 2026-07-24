/**
 * BGE Embedding Daemon Client (TypeScript)
 *
 * Talks to the long-lived BGE-large embedding daemon at
 * ``opc/scripts/core/embedding_daemon.py`` (Task #11 Path A).
 *
 * Protocol:
 *   * Transport: TCP loopback on 127.0.0.1:<port>, TCP_NODELAY.
 *   * Framing: 4-byte big-endian uint32 length prefix + JSON UTF-8 payload.
 *   * Frame size cap: 100 MB (mirror of daemon-side sanity cap).
 *
 * Discovery:
 *   * Daemon writes ``~/.claude/run/ccv3-embedding.json`` AFTER the model is loaded.
 *     File contents:
 *       { "pid": int, "port": int, "started_at": float,
 *         "model": "BAAI/bge-large-en-v1.5", "dim": 1024 }
 *   * Clients read this file to find the daemon. Absence (or stale PID)
 *     means "daemon not ready" and we fall back to text-only recall.
 *
 * Commands:
 *   * ``{"cmd":"ping"}`` -> ``{"ok":true,"ready":bool,"model":str,"dim":int}``
 *   * ``{"cmd":"embed","text":str}`` -> ``{"vector":[...],"elapsed_ms":float,"dim":int}``
 *   * ``{"cmd":"embed_batch","texts":[str,...]}`` -> ``{"vectors":[[...]],"count":int}``
 *   * ``{"cmd":"shutdown"}`` -> ``{"ok":true}``
 *
 * NB: This is a separate module from ``daemon-client.ts`` (which talks to
 * the TLDR daemon using newline-delimited JSON, not length-prefixed).
 * The two daemons share neither protocol nor lifecycle so they don't share
 * code -- only conventions.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { spawn, execFileSync } from 'child_process';
import { homedir } from 'os';
import { join, resolve } from 'path';
import * as net from 'net';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Canonical rendezvous directory -- env-independent.
 *
 * ROOT CAUSE (2026-06-03): this used to be `tmpdir()` (Node's os.tmpdir(),
 * which honors TEMP and IGNORES TMPDIR). The Python daemon used
 * `tempfile.gettempdir()` (honors TMPDIR). Inside the Claude Code session
 * TMPDIR != TEMP, so the two resolved DIFFERENT files -- this spawner never
 * saw the daemon it started and re-spawned endlessly (the husk herd).
 *
 * `homedir()` resolves to USERPROFILE on Windows, identical to Python
 * `Path.home()` and PowerShell `$HOME`, regardless of TEMP/TMPDIR. Mirrors
 * `_canonical_run_dir()` in embedding_daemon.py.
 */
const RUN_DIR = join(homedir(), '.claude', 'run');

/**
 * Test seam: when set, ``CCV3_EMBEDDING_RUN_DIR`` overrides the canonical
 * RUN_DIR for the rendezvous + lockfile paths. This lets the fork-based
 * cross-process mutex test point N child processes at a shared temp dir
 * with no live daemon. Read at CALL TIME (not module-init) so a forked
 * child that sets the env before requiring the module is honored.
 *
 * Production never sets this — RUN_DIR (homedir-based) is the only path
 * that matters in the real hook pipeline.
 */
function _runDir(): string {
  return process.env.CCV3_EMBEDDING_RUN_DIR || RUN_DIR;
}

/** Discovery file path. Daemon writes this AFTER warmup. */
function _daemonInfoPath(): string {
  return join(_runDir(), 'ccv3-embedding.json');
}

/**
 * Module-init snapshot of the discovery path. Used by the public surface
 * (readDaemonInfo etc.) which has no test-override requirement. The
 * spawn-mutex code uses ``_daemonInfoPath()`` / ``_spawnLockPath()`` so it
 * honors the test env override.
 */
const DAEMON_INFO_PATH = _daemonInfoPath();

/**
 * Cross-process spawn mutex lockfile. Written before we fire the daemon
 * spawn subprocess; read by sibling hook processes to avoid racing.
 *
 * Contents: JSON { "pid": number, "started_at": number } (epoch seconds).
 * Atime guard: 60 seconds. The BGE model cold-load takes ~30s; 60s gives
 * a safe envelope before we consider a lockfile "stale" and proceed.
 *
 * The lockfile is intentionally never deleted by the spawner — it either
 * ages out (>60s) or is overwritten by the next spawner. Simpler than
 * tracking spawn success/failure across processes.
 */
const SPAWN_LOCK_PATH = join(RUN_DIR, 'ccv3-embedding-spawn.lock');

/** Test-overridable spawn lock path (honors CCV3_EMBEDDING_RUN_DIR). */
function _spawnLockPath(): string {
  return join(_runDir(), 'ccv3-embedding-spawn.lock');
}

/** How long (ms) a spawn lockfile stays valid before we treat it as stale. */
const SPAWN_LOCK_TTL_MS = 60_000;

/** Frame size cap (matches Python daemon's 100 MB sanity check). */
const FRAME_SIZE_CAP_BYTES = 100 * 1024 * 1024;

/**
 * Default ping timeout: 1500ms.
 *
 * Ping must tolerate cold-cache misses on multi-session systems; 200ms
 * produced false-negative cascades pre-fix because the 1.5GB resident
 * model can briefly stall under multi-session memory pressure. The hot
 * embed path budget is also 1500ms (DEFAULT_EMBED_TIMEOUT_MS), so we
 * match that ceiling here.
 */
const DEFAULT_PING_TIMEOUT_MS = 1500;

/** Default embed timeout: 1500ms (hot encode is ~30-100ms, slack for cold cases). */
const DEFAULT_EMBED_TIMEOUT_MS = 1500;

/**
 * Default recall timeout: 7000ms (2026-07-24, proposal 07-12 R1). Was 3000ms —
 * live telemetry showed 47% of recall_ready fires still fell back to the ~12s uv
 * subprocess, and whole-hook elapsed for daemon-served fires ran p50 2.4s / p99
 * 6.2s, so the 3s ceiling sat inside the observed service tail. New value =
 * observed p99 + margin (degrading to a SLOWER fallback path is never worth
 * saving <4s here). Still deliberately ABOVE the daemon's own internal recall
 * cap (RECALL_TIMEOUT_S = 2.5s) so a daemon-side slow query returns a structured
 * {ok:false} (clean fallback) rather than tripping a raw socket timeout. The
 * companion `reasonRef` telemetry distinguishes client timeout from daemon-side
 * ok:false so the next re-baseline can attribute residual fallbacks.
 */
const DEFAULT_RECALL_TIMEOUT_MS = 7000;

/**
 * Why a recallViaDaemon call returned null (proposal 07-12 R1 reason codes).
 * 'timeout' = client-side overall timer fired; 'transport' = socket error /
 * frame send/recv failure; 'ok_false' = daemon replied but not ok/malformed;
 * 'model_mismatch' = H6 wrong model/dim; 'empty_query' = caller passed blank.
 */
export type RecallFailReason =
  | 'timeout'
  | 'transport'
  | 'ok_false'
  | 'model_mismatch'
  | 'empty_query';

/** Expected model + dim for sanity-check. */
const EXPECTED_MODEL = 'BAAI/bge-large-en-v1.5';
const EXPECTED_DIM = 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Contents of the daemon discovery file. Matches the Python daemon's
 * ``_write_daemon_info`` output.
 */
export interface DaemonInfo {
  pid: number;
  port: number;
  started_at: number;
  model: string;
  dim: number;
}

/**
 * Response from the daemon's ``ping`` command.
 */
export interface PingResponse {
  ok: boolean;
  ready: boolean;
  model?: string;
  dim?: number;
  /** ST-05: true when the resident recall op (asyncpg pool) is initialized. */
  recall_ready?: boolean;
  /** ST-05: false signals a dead/closed background asyncio loop (H2 watchdog). */
  loop_ok?: boolean;
}

/**
 * ST-05: validated handle for routing a resident recall. `info` is the
 * discovery tuple that has ALREADY passed file/PID/model/dim validation + a live
 * ping, so `recallViaDaemon` reuses it WITHOUT a second discovery read (H5 TOCTOU
 * guard). `ready` = embed-ready (gates hybrid-vs-text uv mode); `recallReady` =
 * the resident recall op is up AND the background loop is healthy.
 */
export interface RecallProbe {
  info: DaemonInfo;
  ready: boolean;
  recallReady: boolean;
}

// ---------------------------------------------------------------------------
// Frame protocol helpers (length-prefixed JSON)
// ---------------------------------------------------------------------------

/**
 * Send a length-prefixed JSON frame on a connected socket.
 *
 * Frame layout: 4-byte big-endian uint32 length + UTF-8 JSON payload.
 */
function sendFrame(sock: net.Socket, obj: unknown): void {
  const payload = Buffer.from(JSON.stringify(obj), 'utf-8');
  if (payload.length > FRAME_SIZE_CAP_BYTES) {
    throw new Error(`frame too large: ${payload.length} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  sock.write(Buffer.concat([header, payload]));
}

/**
 * Read a length-prefixed JSON frame from a socket. Resolves with the
 * parsed object once the full payload arrives or rejects on timeout/error.
 *
 * The socket is left open by this helper; the caller closes it when done.
 */
function recvFrame(sock: net.Socket, timeoutMs: number): Promise<any> {
  return new Promise((res, rej) => {
    let received = Buffer.alloc(0);
    let expectedLen: number | null = null;
    let settled = false;

    const finish = (cb: () => void) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners('data');
      sock.removeAllListeners('error');
      sock.removeAllListeners('close');
      sock.removeAllListeners('timeout');
      sock.setTimeout(0);
      cb();
    };

    sock.setTimeout(timeoutMs, () => {
      finish(() => rej(new Error('frame read timeout')));
    });

    sock.on('error', (err) => {
      finish(() => rej(err));
    });

    sock.on('close', () => {
      finish(() =>
        rej(new Error(`socket closed after ${received.length} bytes`)),
      );
    });

    sock.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      // Read the 4-byte header once enough data has arrived.
      if (expectedLen === null && received.length >= 4) {
        expectedLen = received.readUInt32BE(0);
        if (expectedLen > FRAME_SIZE_CAP_BYTES) {
          finish(() => rej(new Error(`frame too large: ${expectedLen} bytes`)));
          return;
        }
      }
      if (expectedLen !== null && received.length >= 4 + expectedLen) {
        const payload = received.subarray(4, 4 + expectedLen);
        try {
          const parsed = JSON.parse(payload.toString('utf-8'));
          finish(() => res(parsed));
        } catch (err) {
          finish(() => rej(err as Error));
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Discovery + liveness
// ---------------------------------------------------------------------------

/**
 * Read the daemon discovery file. Returns ``null`` if it's missing,
 * unreadable, or fails JSON parse.
 *
 * Does NOT check that the PID is alive -- use ``isDaemonAlive`` for that.
 */
export function readDaemonInfo(): DaemonInfo | null {
  if (!existsSync(DAEMON_INFO_PATH)) return null;
  try {
    const raw = readFileSync(DAEMON_INFO_PATH, 'utf-8');
    const obj = JSON.parse(raw);
    if (
      typeof obj !== 'object' ||
      obj === null ||
      typeof obj.pid !== 'number' ||
      typeof obj.port !== 'number' ||
      typeof obj.started_at !== 'number' ||
      typeof obj.model !== 'string' ||
      typeof obj.dim !== 'number'
    ) {
      return null;
    }
    return obj as DaemonInfo;
  } catch {
    return null;
  }
}

/**
 * Check if the daemon PID is alive. Cross-platform.
 *
 * On Node, ``process.kill(pid, 0)`` works on both Unix and Windows
 * (it returns a stat probe, never sends a signal). On Unix it raises
 * ESRCH for dead PIDs. On Windows it raises ENOENT for dead PIDs.
 * In both cases the throw means "not alive".
 */
export function isDaemonAlive(info: DaemonInfo): boolean {
  if (info.pid <= 0) return false;
  try {
    process.kill(info.pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but we lack permission to signal it;
    // treat that as alive (rare in practice for a daemon we just spawned).
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

/**
 * Probe the daemon over TCP with a ping. Resolves with the ping response
 * or ``null`` on connect error / timeout / malformed reply.
 *
 * Returns ``ready=true`` only when the model is fully loaded daemon-side
 * (i.e. embed calls will run at hot-path latency).
 */
export async function pingDaemon(
  info: DaemonInfo,
  timeoutMs: number = DEFAULT_PING_TIMEOUT_MS,
): Promise<PingResponse | null> {
  return new Promise<PingResponse | null>((res) => {
    const sock = new net.Socket();
    let settled = false;

    const cleanup = (val: PingResponse | null) => {
      if (settled) return;
      settled = true;
      try {
        sock.setTimeout(0);
        sock.destroy();
      } catch {
        /* socket already closed */
      }
      res(val);
    };

    // Single overall timer covering connect + send + recv. Previously two
    // independent timers (connectTimer + recvFrame timeout) caused a
    // worst-case wall time of 2 * timeoutMs. One timer means the budget is
    // always respected end-to-end. (T#11 HIGH-2)
    const overallTimer = setTimeout(() => cleanup(null), timeoutMs);

    sock.once('error', () => {
      clearTimeout(overallTimer);
      cleanup(null);
    });

    sock.connect(info.port, '127.0.0.1', () => {
      // Connect succeeded. overallTimer is still running — it now covers
      // send + recv as well. Do NOT reset it here.
      try {
        sock.setNoDelay(true);
      } catch {
        /* setNoDelay can throw on some Windows builds; safe to ignore */
      }
      try {
        sendFrame(sock, { cmd: 'ping' });
      } catch {
        clearTimeout(overallTimer);
        cleanup(null);
        return;
      }
      // Pass 0 to recvFrame so it has no internal timeout — the overall
      // timer above is the single budget for the whole operation.
      recvFrame(sock, 0)
        .then((reply) => {
          clearTimeout(overallTimer);
          if (
            reply &&
            typeof reply === 'object' &&
            typeof reply.ok === 'boolean' &&
            typeof reply.ready === 'boolean'
          ) {
            cleanup(reply as PingResponse);
          } else {
            cleanup(null);
          }
        })
        .catch(() => {
          clearTimeout(overallTimer);
          cleanup(null);
        });
    });
  });
}

/**
 * Embed a single string via the daemon. Returns the vector or ``null``
 * on any failure (no daemon, dim mismatch, timeout, transport error).
 *
 * Callers that get ``null`` should fall back to text-only recall (or
 * in-process embedding, depending on context). We never throw from this
 * helper -- the hook budget is too tight to let an embedding bug crash
 * the prompt pipeline.
 */
export async function embedText(
  text: string,
  opts: { timeoutMs?: number } = {},
): Promise<number[] | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
  const info = readDaemonInfo();
  if (!info) return null;
  if (!isDaemonAlive(info)) return null;

  return new Promise<number[] | null>((res) => {
    const sock = new net.Socket();
    let settled = false;

    const cleanup = (val: number[] | null) => {
      if (settled) return;
      settled = true;
      try {
        sock.setTimeout(0);
        sock.destroy();
      } catch {
        /* socket already closed */
      }
      res(val);
    };

    // Single overall timer covering connect + send + recv -- mirrors the
    // pingDaemon fix above. Previously a connectTimer + recvFrame(timeoutMs)
    // pair allowed a worst-case wall time of 2 * timeoutMs on a slow connect.
    const overallTimer = setTimeout(() => cleanup(null), timeoutMs);

    sock.once('error', () => {
      clearTimeout(overallTimer);
      cleanup(null);
    });

    sock.connect(info.port, '127.0.0.1', () => {
      // Connect succeeded. overallTimer keeps running -- it now covers
      // send + recv too. Do NOT reset it here.
      try {
        sock.setNoDelay(true);
      } catch {
        /* ignore */
      }
      try {
        sendFrame(sock, { cmd: 'embed', text });
      } catch {
        clearTimeout(overallTimer);
        cleanup(null);
        return;
      }
      // Pass 0 to recvFrame so the single overallTimer is the only budget.
      recvFrame(sock, 0)
        .then((reply) => {
          clearTimeout(overallTimer);
          if (
            reply &&
            typeof reply === 'object' &&
            Array.isArray(reply.vector) &&
            reply.vector.every((v: unknown) => typeof v === 'number')
          ) {
            cleanup(reply.vector as number[]);
          } else {
            cleanup(null);
          }
        })
        .catch(() => {
          clearTimeout(overallTimer);
          cleanup(null);
        });
    });
  });
}

/**
 * One-call helper: returns ``true`` only when the daemon is alive AND
 * ready to serve embed requests at hot-path latency.
 *
 * Use this to gate "do hybrid (vector + FTS) recall this prompt vs fall
 * back to text-only".
 */
/**
 * Remove the daemon discovery file. Called when the daemon is confirmed dead
 * to prevent stale files from blocking future liveness checks. Best-effort:
 * file may not exist, or we may lack permission. (T#11 LOW-2)
 */
function _cleanupDiscoveryFile(): void {
  try {
    if (existsSync(DAEMON_INFO_PATH)) {
      unlinkSync(DAEMON_INFO_PATH);
    }
  } catch {
    /* best-effort cleanup — permissions or race with daemon restart */
  }
}

export async function isDaemonReady(): Promise<boolean> {
  const info = readDaemonInfo();
  if (!info) return false;
  if (!isDaemonAlive(info)) {
    // PID is dead. Remove the stale discovery file so the next caller
    // doesn't repeat the liveness check against an already-dead PID.
    // (T#11 LOW-2: daemon SIGKILLed skips the Python finally block that
    // normally calls _delete_daemon_info(), leaving a stale file behind.)
    _cleanupDiscoveryFile();
    return false;
  }
  // Sanity-check model + dim before doing the network ping. A daemon
  // running a different model would silently produce vectors that don't
  // match the archival_memory schema.
  if (info.model !== EXPECTED_MODEL || info.dim !== EXPECTED_DIM) return false;
  const reply = await pingDaemon(info);
  if (!reply) {
    // Ping returned null — either a transient TCP hiccup (200ms→1500ms budget
    // still exceeded under multi-session load) or the daemon is temporarily
    // unresponsive. We do NOT delete the discovery file here: a transient ping
    // miss is not evidence that the daemon is dead. Deleting the file would
    // cause the next hook fire to see "no daemon" and call ensureDaemonRunning(),
    // spawning a duplicate process — the exact cascade we're fixing.
    //
    // We clean up the discovery file only on confirmed-dead PID (above) or
    // model/dim mismatch (above). Transient TCP failures → return false so the
    // caller falls back to text-only, but leave the file intact for retry.
    return false;
  }
  if (!reply.ok || !reply.ready) return false;
  // Optional: re-verify the model from the ping reply (defends against
  // a daemon that wrote a stale discovery file).
  if (reply.model && reply.model !== EXPECTED_MODEL) return false;
  if (reply.dim && reply.dim !== EXPECTED_DIM) return false;
  return true;
}

/**
 * ST-05: one-shot probe that returns the VALIDATED daemon handle plus both
 * readiness flags (embed-ready + recall-ready) from a SINGLE ping. The returned
 * `info` is what `recallViaDaemon` should be handed (H5: avoids a second
 * discovery-file read that could race a daemon restart onto a recycled port).
 *
 * Returns null on the same conditions `isDaemonReady` returns false (missing/
 * dead/wrong-model daemon, or ping failure). `recallReady` is true ONLY when the
 * daemon reports `recall_ready` AND a healthy loop (`loop_ok !== false`) — so a
 * daemon whose recall pool failed to init, or whose background loop died, routes
 * recall to the uv fallback. Kept SEPARATE from isDaemonReady (which has its own
 * test suite) to avoid disturbing that surface.
 */
export async function probeDaemon(): Promise<RecallProbe | null> {
  const info = readDaemonInfo();
  if (!info) return null;
  if (!isDaemonAlive(info)) {
    _cleanupDiscoveryFile();
    return null;
  }
  if (info.model !== EXPECTED_MODEL || info.dim !== EXPECTED_DIM) return null;
  const reply = await pingDaemon(info);
  if (!reply || !reply.ok || !reply.ready) return null;
  if (reply.model && reply.model !== EXPECTED_MODEL) return null;
  if (reply.dim && reply.dim !== EXPECTED_DIM) return null;
  const recallReady = reply.recall_ready === true && reply.loop_ok !== false;
  return { info, ready: reply.ready, recallReady };
}

/**
 * ST-05: run a full hybrid-RRF recall on the resident daemon. Returns the raw
 * results array (the same shape `recall_learnings.py --json` emits, so the caller
 * maps it identically to the uv path) or `null` to signal "fall back to uv".
 *
 * `info` MUST be the validated handle from `probeDaemon` (H5). We reuse the
 * existing length-prefixed sendFrame/recvFrame (exact-length recv — H9) and a
 * single hard timeout (connect+send+recv). Fallback rules (H1):
 *   - `ok === true` + array results  -> return results (an EMPTY array is a real
 *     "no match" and is returned as-is; the caller does NOT fall back on empty).
 *   - `ok !== true` / malformed / transport error / timeout -> return null (the
 *     caller falls back to the uv path). An error NEVER masquerades as "no match".
 *   - H6: if `_meta` reports a model/dim other than expected, reject -> null.
 * Scope: we send NO project_id/scope_mode, so the daemon defaults to opc-dir
 * scope — byte-identical to what the uv `checkDbMemory` fallback does today.
 */
export async function recallViaDaemon(
  info: DaemonInfo,
  query: string,
  k: number,
  opts: { timeoutMs?: number; mode?: string; reasonRef?: { reason?: RecallFailReason } } = {},
): Promise<any[] | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS;
  const mode = opts.mode ?? 'hybrid';
  const fail = (reason: RecallFailReason) => {
    if (opts.reasonRef) opts.reasonRef.reason = reason;
  };
  if (!query || !query.trim()) {
    fail('empty_query');
    return null;
  }

  return new Promise<any[] | null>((res) => {
    const sock = new net.Socket();
    let settled = false;

    const cleanup = (val: any[] | null) => {
      if (settled) return;
      settled = true;
      try {
        sock.setTimeout(0);
        sock.destroy();
      } catch {
        /* socket already closed */
      }
      res(val);
    };

    // Single overall timer covering connect + send + recv (mirrors embedText).
    const overallTimer = setTimeout(() => {
      fail('timeout');
      cleanup(null);
    }, timeoutMs);

    sock.once('error', () => {
      clearTimeout(overallTimer);
      fail('transport');
      cleanup(null);
    });

    sock.connect(info.port, '127.0.0.1', () => {
      try {
        sock.setNoDelay(true);
      } catch {
        /* ignore */
      }
      try {
        sendFrame(sock, { cmd: 'recall', query, k, mode });
      } catch {
        clearTimeout(overallTimer);
        fail('transport');
        cleanup(null);
        return;
      }
      recvFrame(sock, 0)
        .then((reply) => {
          clearTimeout(overallTimer);
          if (
            reply &&
            typeof reply === 'object' &&
            reply.ok === true &&
            Array.isArray(reply.results)
          ) {
            // H6 belt-and-suspenders: reject a wrong-model/dim daemon response.
            const meta = reply._meta;
            if (
              meta &&
              typeof meta === 'object' &&
              ((meta.model && meta.model !== EXPECTED_MODEL) ||
                (meta.dim && meta.dim !== EXPECTED_DIM))
            ) {
              fail('model_mismatch');
              cleanup(null);
              return;
            }
            cleanup(reply.results as any[]);
          } else {
            // ok:false / malformed -> fall back to uv (never treat as "no match").
            fail('ok_false');
            cleanup(null);
          }
        })
        .catch(() => {
          clearTimeout(overallTimer);
          fail('transport');
          cleanup(null);
        });
    });
  });
}

// ---------------------------------------------------------------------------
// Daemon spawn (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the repo root containing the ``opc/``
 * project. We try, in order:
 *   1. ``$CLAUDE_PROJECT_DIR`` (set by Claude Code at session start).
 *   2. Walk up from this module's location looking for an ``opc/`` sibling.
 *
 * Returns ``null`` if we can't find a repo with ``opc/`` -- caller should
 * skip the spawn attempt.
 */
function resolveRepoRoot(): string | null {
  const envDir = process.env.CLAUDE_PROJECT_DIR;
  if (envDir && existsSync(join(envDir, 'opc'))) {
    return resolve(envDir);
  }
  // Walk up from this module's location. After esbuild bundling, the
  // ``__filename`` of the dist module will be something like
  // ``<repo>/.claude/hooks/dist/memory-awareness.mjs``. The repo root is
  // 3 levels up from there.
  //
  // We can't use ``__filename`` directly in ESM (esbuild emits ESM),
  // so we use ``import.meta.url`` via a workaround safe under both
  // bundler modes.
  try {
    // process.argv[1] is the entry script (dist/memory-awareness.mjs).
    const entry = process.argv[1];
    if (entry) {
      // Walk up looking for opc/
      let dir = resolve(entry);
      for (let i = 0; i < 10; i++) {
        const parent = resolve(dir, '..');
        if (parent === dir) break;
        dir = parent;
        if (existsSync(join(dir, 'opc', 'scripts', 'core', 'embedding_daemon.py'))) {
          return dir;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Module-level cache for the resolved uv path.
 *
 * ``undefined`` = not yet probed; ``null`` = probed and not found (cached so
 * we don't re-run the ``where``/``which`` probe on every hook call); a string
 * = the resolved absolute path. Resettable via ``__test.resetUvPathCache``.
 */
let _uvPathCache: string | null | undefined = undefined;

/**
 * Resolve the absolute path to the ``uv`` executable. Returns ``null`` if it
 * cannot be located.
 *
 * Why this exists: ``uv`` is installed as a PATH shim. A bare
 * ``spawn('uv', ..., { detached: true })`` ENOENTs from a detached process
 * on Windows, so the old code used ``shell: true`` — which launches
 * ``cmd.exe /c uv ...`` and flashes a visible console window per spawn (the
 * thundering-herd symptom). Resolving uv to an absolute path lets us spawn
 * with no shell and ``windowsHide: true`` — the same approach the proven
 * scripts/start-embedding-daemon.ps1 launcher uses
 * (UseShellExecute=$false + CreateNoWindow=$true).
 *
 * Resolution order:
 *   (a) ``$CCV3_UV_PATH`` env override, if it points at an existing file.
 *   (b) ``where uv`` (win32) / ``which uv`` (POSIX) — parsed carefully
 *       because ``where`` returns MULTIPLE CRLF-separated lines and may list
 *       a ``.cmd`` shim before the real ``uv.exe``; we prefer ``uv.exe``.
 *   (c) Common install locations: ``%USERPROFILE%\.local\bin\uv.exe`` and
 *       the cargo bin ``~/.cargo/bin/uv.exe`` (``uv`` on POSIX).
 */
function resolveUvPath(): string | null {
  if (_uvPathCache !== undefined) return _uvPathCache;

  const isWin = process.platform === 'win32';
  const resolved = _probeUvPath(isWin);
  _uvPathCache = resolved;
  return resolved;
}

/**
 * Pure-ish probe used by resolveUvPath (split out for cache control and to
 * keep the cache logic trivially testable).
 */
function _probeUvPath(isWin: boolean): string | null {
  // (a) Explicit env override.
  const envOverride = process.env.CCV3_UV_PATH;
  if (envOverride && existsSync(envOverride)) {
    return resolve(envOverride);
  }

  // (b) where/which lookup.
  try {
    const finder = isWin ? 'where' : 'which';
    const out = execFileSync(finder, ['uv'], {
      windowsHide: true,
      timeout: 2000,
      encoding: 'utf-8',
    });
    const parsed = _parseWhereOutput(String(out));
    if (parsed) return parsed;
  } catch {
    /* not found on PATH — fall through to known locations */
  }

  // (c) Common install locations.
  const home = homedir();
  const candidates = isWin
    ? [
        join(home, '.local', 'bin', 'uv.exe'),
        join(home, '.cargo', 'bin', 'uv.exe'),
      ]
    : [
        join(home, '.local', 'bin', 'uv'),
        join(home, '.cargo', 'bin', 'uv'),
      ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  return null;
}

/**
 * Parse the multi-line output of ``where uv`` (or ``which uv``).
 *
 * ``where`` on Windows returns one path per line with CRLF line endings and
 * can list a ``.cmd``/``.bat`` shim before the real ``uv.exe``. We split on
 * any newline form, trim, drop blanks, keep only paths that exist on disk,
 * then PREFER one ending in ``uv.exe`` over a ``.cmd``/``.bat`` shim. Falls
 * back to the first existing candidate if none ends in ``uv.exe``.
 *
 * Returns null if no candidate line resolves to an existing file.
 */
function _parseWhereOutput(out: string): string | null {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => existsSync(l));
  if (lines.length === 0) return null;
  const exe = lines.find((l) => l.toLowerCase().endsWith('uv.exe'));
  return exe ?? lines[0];
}

/**
 * Append a durable line to ~/.claude/logs/embedding-daemon-launcher.log so
 * spawn-skip decisions (no uv, no repo root) leave a forensic trail. Mirrors
 * the launcher log the PowerShell scheduled task writes. Best-effort: never
 * throws (the hook budget is too tight to risk a logging failure).
 *
 * ASCII only in the message — the launcher log is read on Windows where a
 * stray non-ASCII byte under cp1252 can corrupt the file.
 */
function _logLauncher(msg: string): void {
  try {
    const logDir = join(homedir(), '.claude', 'logs');
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, 'embedding-daemon-launcher.log');
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    // appendFileSync via writeSync-on-append fd keeps the import surface small;
    // openSync with 'a' is the append mode.
    const fd = openSync(logFile, 'a');
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best-effort logging — never let a log write break the hook */
  }
}

/**
 * Single-process guard for the spawn helper. If another hook call already
 * triggered a spawn in this Node process, we don't try again. The Python
 * daemon itself is idempotent across processes (the port is already in
 * use, so a second daemon would fail to bind), but skipping the spawn
 * call avoids the subprocess overhead.
 *
 * This is a fast-path optimization only. The cross-process source of truth
 * is the SPAWN_LOCK_PATH filesystem lockfile — see ensureDaemonRunning().
 */
let _spawnAttempted = false;

/**
 * Fire-and-forget: spawn the embedding daemon detached, if it isn't
 * already running. Returns immediately -- does NOT wait for warmup.
 *
 * Strategy: this call is the "warm cache for the NEXT prompt" lever.
 * The caller has already decided to fall back to text-only for THIS
 * prompt because the daemon isn't ready.
 *
 * Idempotent: no-op if the discovery file is present and PID is alive
 * (the daemon is up). If the discovery file is present but PID is dead,
 * we still spawn -- the new daemon will overwrite the stale info file
 * after warmup.
 *
 * Cross-process spawn mutex: every hook invocation is a separate Node
 * subprocess, so the module-level _spawnAttempted flag always starts
 * false. With 2+ Claude sessions open (or a burst of prompts), every
 * prompt would race to spawn — the "thundering herd" (2026-06-05: 40+
 * cmd.exe -> uv -> python trees in ~10s). The fix is an ATOMIC filesystem
 * lock: openSync(path, 'wx') is create-or-fail at the OS level, so only
 * ONE of N racing processes wins the create — the rest see EEXIST and bail.
 * This replaces the old read-check-then-write guard, which was a TOCTOU
 * race (all N read the stale lock, all N passed, all N spawned).
 */
export function ensureDaemonRunning(): void {
  // Step 0: kill-switch. Tests/CI set CCV3_EMBEDDING_NO_SPAWN=1 so this hook
  // NEVER launches a real model-loading daemon. Without it, a herd of cmd.exe
  // windows appears during `npm test`: memory-awareness.test.ts spawns the REAL
  // built hook with a fake HOME, and resolveRepoRoot() walks process.argv[1] up
  // to the REAL repo's opc/ (HOME/CLAUDE_PROJECT_DIR don't gate it), so every
  // test case launches a real `uv run embedding_daemon.py --daemon`
  // (2026-06-05). Production leaves this unset — no behavior change.
  if (process.env.CCV3_EMBEDDING_NO_SPAWN === '1') return;

  // Step 1: fast-path — already attempted in this Node process.
  if (_spawnAttempted) return;
  _spawnAttempted = true;

  // Step 2: bail if a healthy daemon is already running (PID-alive, not a
  // ping gate — a transient ping miss must not trigger a respawn).
  const info = readDaemonInfo();
  if (info && isDaemonAlive(info)) return;

  // Step 3: pre-validate BEFORE acquiring the lock (mitigation F4). Resolving
  // repoRoot + uvPath first means that if either is missing we return WITHOUT
  // writing a lock — a lock we couldn't act on would suppress retries for the
  // full 60s TTL for no reason.
  const repoRoot = resolveRepoRoot();
  if (!repoRoot) {
    _logLauncher(
      'embedding-client: repo root not resolvable; skipping spawn',
    );
    return;
  }
  const uvPath = resolveUvPath();
  if (!uvPath) {
    // F3: no silent shell fallback. Skip the spawn and leave a durable trail.
    // The scheduled-task PowerShell launcher will start the daemon at next
    // logon, so this is a degraded-but-safe state, not a hard failure.
    _logLauncher(
      'embedding-client: uv not resolvable; skipping spawn (scheduled task will start daemon at next logon)',
    );
    return;
  }

  // Step 4: atomic acquire (replaces read-check-write). openSync(..., 'wx')
  // creates the file or throws EEXIST — atomic at the OS layer.
  const lockPath = _spawnLockPath();
  let acquired = false;
  try {
    acquired = _acquireSpawnLock(lockPath);
  } catch {
    // Any unexpected lock error: fail open by NOT spawning (we can't prove we
    // hold the mutex, so spawning could re-create the herd). The 60s TTL +
    // next hook fire will retry. Never throw into the hook.
    return;
  }
  if (!acquired) {
    // Another process owns the spawn (fresh lock) or won the stale-reclaim.
    return;
  }

  // Step 5: spawn with NO shell. uv resolved to an absolute path means a
  // detached spawn no longer ENOENTs, so we can drop shell:true (which on
  // Windows launched cmd.exe and flashed a console window per spawn — the
  // herd symptom). windowsHide:true + no shell mirrors the proven
  // scripts/start-embedding-daemon.ps1 launcher (UseShellExecute=$false +
  // CreateNoWindow=$true). uv with cwd=repoRoot resolves `--project opc`.
  try {
    const child = spawn(
      uvPath,
      ['run', '--project', 'opc', 'python', 'opc/scripts/core/embedding_daemon.py', '--daemon'],
      {
        cwd: repoRoot,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.on('error', (err) => {
      // F6/T2 (accepted risk): we do NOT unlink the lock from this async error
      // path. By the time 'error' fires, a newer spawner may already hold a
      // fresh lock with the same path; deleting it would re-open the herd
      // window. The 60s TTL self-heals this bounded (<=60s) window instead.
      console.error(
        `[embedding-client] daemon spawn error: ${err.message ?? err}`,
      );
    });
    child.unref();
  } catch (err: any) {
    // F4: synchronous spawn failure (e.g. uv path went away between probe and
    // spawn). Unlink the lock best-effort so the NEXT hook retries immediately
    // rather than waiting out the 60s TTL.
    try {
      unlinkSync(lockPath);
    } catch {
      /* tolerate ENOENT / permission — TTL self-heals */
    }
    console.error(
      `[embedding-client] daemon spawn failed: ${err?.message ?? err}`,
    );
  }
}

/**
 * Atomically acquire the spawn lock. Returns ``true`` if THIS process won the
 * spawn (caller should proceed to spawn), ``false`` if another process owns
 * it (caller should bail).
 *
 *   * openSync(path, 'wx') — atomic create-or-fail. On success we own the lock.
 *   * EEXIST — a lock already exists. Stat it: if younger than the TTL, another
 *     process owns it (return false). If stale, unlink (best-effort) and retry
 *     the wx open ONCE. If the retry also EEXISTs, someone else won the
 *     reclaim race (return false).
 *
 * Throws only on truly unexpected fs errors — the caller fails open on throw.
 */
function _acquireSpawnLock(lockPath: string): boolean {
  mkdirSync(_runDir(), { recursive: true });
  const payload = JSON.stringify({
    pid: process.pid,
    started_at: Math.floor(Date.now() / 1000),
  });

  const tryCreate = (): boolean => {
    const fd = openSync(lockPath, 'wx');
    try {
      writeSync(fd, payload);
    } finally {
      closeSync(fd);
    }
    return true;
  };

  try {
    return tryCreate();
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }

  // Lock exists — is it stale?
  let ageMs: number;
  try {
    const st = statSync(lockPath);
    ageMs = Date.now() - st.mtimeMs;
  } catch {
    // Lock vanished between open and stat (another process reclaimed/removed
    // it). Retry the create once.
    try {
      return tryCreate();
    } catch (err2: any) {
      if (err2?.code === 'EEXIST') return false;
      throw err2;
    }
  }

  if (ageMs < SPAWN_LOCK_TTL_MS) {
    // Fresh lock — another process owns the spawn.
    return false;
  }

  // Stale lock — reclaim it. Unlink best-effort, then retry create ONCE.
  try {
    unlinkSync(lockPath);
  } catch {
    /* tolerate ENOENT — another process may have just removed it */
  }
  try {
    return tryCreate();
  } catch (err3: any) {
    if (err3?.code === 'EEXIST') return false; // someone else won the reclaim
    throw err3;
  }
}

// ---------------------------------------------------------------------------
// Exports for tests
// ---------------------------------------------------------------------------

/**
 * Internal helpers exposed for tests. Not part of the public hook surface.
 */
export const __test = {
  DAEMON_INFO_PATH,
  SPAWN_LOCK_PATH,
  SPAWN_LOCK_TTL_MS,
  FRAME_SIZE_CAP_BYTES,
  DEFAULT_PING_TIMEOUT_MS,
  DEFAULT_EMBED_TIMEOUT_MS,
  EXPECTED_MODEL,
  EXPECTED_DIM,
  sendFrame,
  recvFrame,
  resetSpawnAttempted: () => {
    _spawnAttempted = false;
  },
  // --- herd-fix seams ---
  /** Env-overridable spawn lock path (honors CCV3_EMBEDDING_RUN_DIR). */
  spawnLockPath: _spawnLockPath,
  /** Env-overridable discovery path (honors CCV3_EMBEDDING_RUN_DIR). */
  daemonInfoPath: _daemonInfoPath,
  /** uv resolution + the multi-line `where` parser, exposed for unit tests. */
  resolveUvPath,
  parseWhereOutput: _parseWhereOutput,
  /** Reset the cached uv path so a test can re-probe with a fresh env. */
  resetUvPathCache: () => {
    _uvPathCache = undefined;
  },
  /** Direct access to the atomic lock acquirer for stale-reclaim tests. */
  acquireSpawnLock: _acquireSpawnLock,
};
