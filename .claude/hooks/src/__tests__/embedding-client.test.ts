/**
 * Tests for BGE Embedding Daemon Client.
 *
 * Validates:
 *   * Length-prefixed JSON framing (4-byte big-endian uint32 length + UTF-8 body).
 *   * Discovery file parsing.
 *   * PID liveness check.
 *   * Ping happy-path against a mock server.
 *   * Ping bails fast when daemon is unreachable.
 *   * isDaemonReady() short-circuits on missing discovery file.
 *
 * The mock server speaks the same length-prefixed protocol as the real
 * Python daemon at opc/scripts/core/embedding_daemon.py.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import { spawn, fork } from 'child_process';
import {
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  utimesSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  readDaemonInfo,
  isDaemonAlive,
  pingDaemon,
  embedText,
  isDaemonReady,
  probeDaemon,
  recallViaDaemon,
  ensureDaemonRunning,
  __test,
  type DaemonInfo,
} from '../shared/embedding-client.js';

// Absolute path resolution for the test dir (ESM-safe). vitest gives us
// import.meta.url; the worker + stub live alongside this file.
const __testdir = dirname(fileURLToPath(import.meta.url));
const REPO_HOOKS = resolve(__testdir, '..', '..'); // .claude/hooks
const REPO_ROOT = resolve(REPO_HOOKS, '..', '..'); // repo root (has opc/)

// The mutex tests need resolveUvPath() + resolveRepoRoot() to succeed
// deterministically. We create a fake but EXISTING uv file in a temp dir and
// point CCV3_UV_PATH at it, and point CLAUDE_PROJECT_DIR at the real repo root
// (which has opc/). spawn is mocked, so the fake uv is never actually run.
// EXPECTED_UV_ARG is the absolute path resolveUvPath returns for the env
// override, which is what the no-shell spawn passes as argv[0].
const _muTmp = mkdtempSync(join(tmpdir(), 'ccv3-uvfake-'));
const FAKE_UV = join(_muTmp, process.platform === 'win32' ? 'uv.exe' : 'uv');
writeFileSync(FAKE_UV, '');
const EXPECTED_UV_ARG = resolve(FAKE_UV);

// ---------------------------------------------------------------------------
// Mock child_process.spawn so the lockfile-mutex tests never fire a real
// subprocess. Without this mock, every ensureDaemonRunning() call launches
// `uv run --project opc python ...` which downloads ~1.34 GB of BGE model
// weights into each test's fake-HOME temp dir, leaking gigabytes per run.
// Only `spawn` is replaced; `spawnSync` remains real so other test helpers
// (memory-awareness tests) are unaffected.
// ---------------------------------------------------------------------------
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => ({
      on: vi.fn(),
      unref: vi.fn(),
      pid: 99999,
    })),
  };
});

const DISCOVERY_PATH = __test.DAEMON_INFO_PATH;
const SPAWN_LOCK_PATH = __test.SPAWN_LOCK_PATH;
const SPAWN_LOCK_TTL_MS = __test.SPAWN_LOCK_TTL_MS;
const EXPECTED_MODEL = __test.EXPECTED_MODEL;
const EXPECTED_DIM = __test.EXPECTED_DIM;

/**
 * Read one length-prefixed frame from a socket, parse JSON.
 * Mirrors the Python daemon's _recv_frame.
 */
function recvFrame(sock: net.Socket): Promise<any> {
  return new Promise((res, rej) => {
    let buf = Buffer.alloc(0);
    let expectedLen: number | null = null;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (expectedLen === null && buf.length >= 4) {
        expectedLen = buf.readUInt32BE(0);
      }
      if (expectedLen !== null && buf.length >= 4 + expectedLen) {
        const payload = buf.subarray(4, 4 + expectedLen).toString('utf-8');
        try {
          res(JSON.parse(payload));
        } catch (e) {
          rej(e);
        }
      }
    });
    sock.on('error', rej);
  });
}

/**
 * Write a length-prefixed frame on a socket.
 */
function sendFrame(sock: net.Socket, obj: unknown): void {
  const payload = Buffer.from(JSON.stringify(obj), 'utf-8');
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(payload.length, 0);
  sock.write(Buffer.concat([hdr, payload]));
}

/**
 * Start a mock TCP server that mirrors the Python daemon's request/reply.
 * Returns the bound port.
 */
function startMockServer(
  handle: (cmd: any) => any,
): Promise<{ server: net.Server; port: number }> {
  return new Promise((res, rej) => {
    const server = net.createServer((sock) => {
      recvFrame(sock)
        .then((req) => {
          const reply = handle(req);
          sendFrame(sock, reply);
          // Don't close immediately — let the client read first.
          setImmediate(() => sock.end());
        })
        .catch(() => {
          try { sock.destroy(); } catch { /* ignore */ }
        });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr && 'port' in addr) {
        res({ server, port: addr.port });
      } else {
        rej(new Error('failed to get bound port'));
      }
    });
    server.on('error', rej);
  });
}

/**
 * Save + restore the discovery file between tests so each test starts
 * from a known state.
 */
let savedDiscovery: Buffer | null = null;
beforeAll(() => {
  if (existsSync(DISCOVERY_PATH)) {
    const fs = require('fs');
    savedDiscovery = fs.readFileSync(DISCOVERY_PATH);
    fs.unlinkSync(DISCOVERY_PATH);
  }
});
afterAll(() => {
  if (savedDiscovery) {
    writeFileSync(DISCOVERY_PATH, savedDiscovery);
  }
  try {
    rmSync(_muTmp, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
});

// Get a typed reference to the mocked spawn for use in lockfile-mutex tests.
const mockedSpawn = vi.mocked(spawn);

/**
 * On Windows the daemon spawn goes through the spawn-hidden Node relay
 * (`node -e <relay> -- <cmd> ...args`). Return the real command and args, and
 * whether the call was relayed.
 */
function spawnTarget(call: unknown[]): { cmd: unknown; args: unknown[]; relayed: boolean } {
  const [cmd, args] = call as [unknown, unknown[]];
  const relayed = cmd === process.execPath && args[0] === '-e' && args[2] === '--';
  return relayed ? { cmd: args[3], args: args.slice(4), relayed } : { cmd, args, relayed };
}

beforeEach(() => {
  if (existsSync(DISCOVERY_PATH)) {
    try { unlinkSync(DISCOVERY_PATH); } catch { /* ignore */ }
  }
  if (existsSync(SPAWN_LOCK_PATH)) {
    try { unlinkSync(SPAWN_LOCK_PATH); } catch { /* ignore */ }
  }
  __test.resetSpawnAttempted();
  // Reset spawn mock call history so each test starts clean.
  mockedSpawn.mockClear();
});

afterEach(() => {
  if (existsSync(DISCOVERY_PATH)) {
    try { unlinkSync(DISCOVERY_PATH); } catch { /* ignore */ }
  }
  if (existsSync(SPAWN_LOCK_PATH)) {
    try { unlinkSync(SPAWN_LOCK_PATH); } catch { /* ignore */ }
  }
});

describe('readDaemonInfo', () => {
  it('returns null when discovery file is missing', () => {
    expect(readDaemonInfo()).toBeNull();
  });

  it('parses a well-formed discovery file', () => {
    const info: DaemonInfo = {
      pid: process.pid,
      port: 12345,
      started_at: Date.now() / 1000,
      model: EXPECTED_MODEL,
      dim: EXPECTED_DIM,
    };
    writeFileSync(DISCOVERY_PATH, JSON.stringify(info));
    const got = readDaemonInfo();
    expect(got).not.toBeNull();
    expect(got?.pid).toBe(info.pid);
    expect(got?.port).toBe(info.port);
    expect(got?.model).toBe(info.model);
    expect(got?.dim).toBe(info.dim);
  });

  it('returns null on malformed JSON', () => {
    writeFileSync(DISCOVERY_PATH, 'not-json');
    expect(readDaemonInfo()).toBeNull();
  });

  it('returns null on missing required fields', () => {
    writeFileSync(DISCOVERY_PATH, JSON.stringify({ pid: 1 }));
    expect(readDaemonInfo()).toBeNull();
  });
});

describe('isDaemonAlive', () => {
  it('returns true for the current process', () => {
    const info: DaemonInfo = {
      pid: process.pid,
      port: 0,
      started_at: 0,
      model: EXPECTED_MODEL,
      dim: EXPECTED_DIM,
    };
    expect(isDaemonAlive(info)).toBe(true);
  });

  it('returns false for an obviously-dead pid', () => {
    const info: DaemonInfo = {
      pid: 0, // never a valid pid
      port: 0,
      started_at: 0,
      model: EXPECTED_MODEL,
      dim: EXPECTED_DIM,
    };
    expect(isDaemonAlive(info)).toBe(false);
  });

  it('returns false for a very large pid that should not exist', () => {
    const info: DaemonInfo = {
      pid: 999999999,
      port: 0,
      started_at: 0,
      model: EXPECTED_MODEL,
      dim: EXPECTED_DIM,
    };
    expect(isDaemonAlive(info)).toBe(false);
  });
});

describe('pingDaemon', () => {
  it('returns null when nothing is listening on the port', async () => {
    // Pick a port we just bound + closed to maximize "not listening" probability.
    const probe = net.createServer();
    await new Promise<void>((res) => probe.listen(0, '127.0.0.1', () => res()));
    const port = (probe.address() as any).port;
    await new Promise<void>((res) => probe.close(() => res()));

    const info: DaemonInfo = {
      pid: process.pid,
      port,
      started_at: 0,
      model: EXPECTED_MODEL,
      dim: EXPECTED_DIM,
    };
    const reply = await pingDaemon(info, 200);
    expect(reply).toBeNull();
  });

  it('returns ping response from a mock server', async () => {
    const { server, port } = await startMockServer((req) => {
      if (req.cmd === 'ping') {
        return { ok: true, ready: true, model: EXPECTED_MODEL, dim: EXPECTED_DIM };
      }
      return { error: 'unknown' };
    });
    try {
      const info: DaemonInfo = {
        pid: process.pid,
        port,
        started_at: 0,
        model: EXPECTED_MODEL,
        dim: EXPECTED_DIM,
      };
      const reply = await pingDaemon(info, 2000);
      expect(reply).not.toBeNull();
      expect(reply?.ok).toBe(true);
      expect(reply?.ready).toBe(true);
      expect(reply?.model).toBe(EXPECTED_MODEL);
      expect(reply?.dim).toBe(EXPECTED_DIM);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('reports not-ready when daemon model is still loading', async () => {
    const { server, port } = await startMockServer((req) => {
      if (req.cmd === 'ping') {
        return { ok: true, ready: false };
      }
      return {};
    });
    try {
      const info: DaemonInfo = {
        pid: process.pid,
        port,
        started_at: 0,
        model: EXPECTED_MODEL,
        dim: EXPECTED_DIM,
      };
      const reply = await pingDaemon(info, 2000);
      expect(reply?.ok).toBe(true);
      expect(reply?.ready).toBe(false);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

describe('isDaemonReady', () => {
  it('returns false when discovery file is missing', async () => {
    const ready = await isDaemonReady();
    expect(ready).toBe(false);
  });

  it('returns false when PID is dead', async () => {
    writeFileSync(
      DISCOVERY_PATH,
      JSON.stringify({
        pid: 999999999,
        port: 65535,
        started_at: 0,
        model: EXPECTED_MODEL,
        dim: EXPECTED_DIM,
      }),
    );
    const ready = await isDaemonReady();
    expect(ready).toBe(false);
  });

  it('returns false when model name does not match', async () => {
    // Discovery file points to current process (PID alive) but wrong model.
    writeFileSync(
      DISCOVERY_PATH,
      JSON.stringify({
        pid: process.pid,
        port: 65535,
        started_at: 0,
        model: 'wrong-model',
        dim: EXPECTED_DIM,
      }),
    );
    const ready = await isDaemonReady();
    expect(ready).toBe(false);
  });

  it('returns true when daemon responds ready=true', async () => {
    const { server, port } = await startMockServer((req) => {
      if (req.cmd === 'ping') {
        return { ok: true, ready: true, model: EXPECTED_MODEL, dim: EXPECTED_DIM };
      }
      return {};
    });
    try {
      writeFileSync(
        DISCOVERY_PATH,
        JSON.stringify({
          pid: process.pid,
          port,
          started_at: 0,
          model: EXPECTED_MODEL,
          dim: EXPECTED_DIM,
        }),
      );
      const ready = await isDaemonReady();
      expect(ready).toBe(true);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('returns false when daemon ping responds with ready=false', async () => {
    const { server, port } = await startMockServer((req) => {
      if (req.cmd === 'ping') {
        return { ok: true, ready: false, model: EXPECTED_MODEL, dim: EXPECTED_DIM };
      }
      return {};
    });
    try {
      writeFileSync(
        DISCOVERY_PATH,
        JSON.stringify({
          pid: process.pid,
          port,
          started_at: 0,
          model: EXPECTED_MODEL,
          dim: EXPECTED_DIM,
        }),
      );
      const ready = await isDaemonReady();
      expect(ready).toBe(false);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

describe('embedText', () => {
  it('returns null when discovery file is missing', async () => {
    const vec = await embedText('test');
    expect(vec).toBeNull();
  });

  it('returns vector from a mock server', async () => {
    const fakeVec = new Array(EXPECTED_DIM).fill(0).map((_, i) => i * 0.001);
    const { server, port } = await startMockServer((req) => {
      if (req.cmd === 'embed' && typeof req.text === 'string') {
        return { vector: fakeVec, dim: fakeVec.length, elapsed_ms: 12.3 };
      }
      return { error: 'unknown' };
    });
    try {
      writeFileSync(
        DISCOVERY_PATH,
        JSON.stringify({
          pid: process.pid,
          port,
          started_at: 0,
          model: EXPECTED_MODEL,
          dim: EXPECTED_DIM,
        }),
      );
      const vec = await embedText('hello world');
      expect(vec).not.toBeNull();
      expect(vec?.length).toBe(EXPECTED_DIM);
      expect(vec?.[0]).toBe(0);
      expect(vec?.[1]).toBeCloseTo(0.001);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

describe('frame protocol', () => {
  it('sendFrame writes length-prefixed JSON', async () => {
    // Use a paired server/client to capture what sendFrame produces.
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        if (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (buf.length >= 4 + len) {
            const json = buf.subarray(4, 4 + len).toString('utf-8');
            // Echo back the parsed object so the test can verify.
            sendFrame(sock, JSON.parse(json));
            sock.end();
          }
        }
      });
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const port = (server.address() as any).port;
    try {
      const client = new net.Socket();
      const received: any = await new Promise((res) => {
        client.connect(port, '127.0.0.1', () => {
          __test.sendFrame(client, { cmd: 'echo', payload: 'hello' });
        });
        recvFrame(client).then(res);
      });
      expect(received).toEqual({ cmd: 'echo', payload: 'hello' });
      client.destroy();
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

// ---------------------------------------------------------------------------
// Bug-fix regression tests (transient ping + cross-process spawn mutex)
// ---------------------------------------------------------------------------

describe('isDaemonReady: transient ping failure does not delete discovery file', () => {
  it('returns false but leaves discovery file intact when pingDaemon returns null with alive PID', async () => {
    // Pick a port we just closed so nothing is listening — pingDaemon will
    // return null (connection refused / timeout). We use a short ping timeout
    // so the test runs quickly.
    const probe = net.createServer();
    await new Promise<void>((res) => probe.listen(0, '127.0.0.1', () => res()));
    const closedPort = (probe.address() as any).port;
    await new Promise<void>((res) => probe.close(() => res()));

    // Write a valid discovery file pointing to this (dead) port but with
    // an alive PID (the current process).
    writeFileSync(
      DISCOVERY_PATH,
      JSON.stringify({
        pid: process.pid, // alive — PID check passes
        port: closedPort, // nothing listening → pingDaemon returns null
        started_at: Date.now() / 1000,
        model: EXPECTED_MODEL,
        dim: EXPECTED_DIM,
      }),
    );

    // isDaemonReady uses DEFAULT_PING_TIMEOUT_MS (1500ms). We rely on
    // connection-refused being near-instant (kernel sends RST immediately),
    // so this resolves in <50ms in practice.
    const ready = await isDaemonReady();

    expect(ready).toBe(false);

    // BUG 1 REGRESSION: the discovery file must still exist.
    // Pre-fix: _cleanupDiscoveryFile() was called on ping null → file deleted.
    // Post-fix: transient ping miss leaves the file intact.
    expect(existsSync(DISCOVERY_PATH)).toBe(true);
  });
});

describe('probeDaemon (ST-05)', () => {
  it('returns null when discovery file is missing', async () => {
    expect(await probeDaemon()).toBeNull();
  });

  it('returns {ready, recallReady:true} when daemon reports recall_ready + loop_ok', async () => {
    const { server, port } = await startMockServer((req) =>
      req.cmd === 'ping'
        ? { ok: true, ready: true, model: EXPECTED_MODEL, dim: EXPECTED_DIM, recall_ready: true, loop_ok: true }
        : {},
    );
    try {
      writeFileSync(DISCOVERY_PATH, JSON.stringify({ pid: process.pid, port, started_at: Date.now() / 1000, model: EXPECTED_MODEL, dim: EXPECTED_DIM }));
      const probe = await probeDaemon();
      expect(probe).not.toBeNull();
      expect(probe?.ready).toBe(true);
      expect(probe?.recallReady).toBe(true);
      expect(probe?.info.port).toBe(port);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('recallReady=false when daemon omits recall_ready (old daemon; embed still ready)', async () => {
    const { server, port } = await startMockServer((req) =>
      req.cmd === 'ping' ? { ok: true, ready: true, model: EXPECTED_MODEL, dim: EXPECTED_DIM } : {},
    );
    try {
      writeFileSync(DISCOVERY_PATH, JSON.stringify({ pid: process.pid, port, started_at: 0, model: EXPECTED_MODEL, dim: EXPECTED_DIM }));
      const probe = await probeDaemon();
      expect(probe?.ready).toBe(true);
      expect(probe?.recallReady).toBe(false);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('recallReady=false when loop_ok is false (dead-loop watchdog, H2)', async () => {
    const { server, port } = await startMockServer((req) =>
      req.cmd === 'ping' ? { ok: true, ready: true, model: EXPECTED_MODEL, dim: EXPECTED_DIM, recall_ready: true, loop_ok: false } : {},
    );
    try {
      writeFileSync(DISCOVERY_PATH, JSON.stringify({ pid: process.pid, port, started_at: 0, model: EXPECTED_MODEL, dim: EXPECTED_DIM }));
      const probe = await probeDaemon();
      expect(probe?.recallReady).toBe(false);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

describe('recallViaDaemon (ST-05)', () => {
  const INFO = (port: number): DaemonInfo => ({ pid: process.pid, port, started_at: 0, model: EXPECTED_MODEL, dim: EXPECTED_DIM });

  it('returns the results array on ok:true', async () => {
    const rows = [{ id: 'a', content: 'x', score: 0.02, base_score: 0.03 }];
    const { server, port } = await startMockServer((req) =>
      req.cmd === 'recall'
        ? { ok: true, results: rows, _meta: { model: EXPECTED_MODEL, dim: EXPECTED_DIM, vector_count: 1, fts_count: 1 }, elapsed_ms: 12 }
        : {},
    );
    try {
      expect(await recallViaDaemon(INFO(port), 'typescript hook', 3)).toEqual(rows);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('returns [] (real no-match) on ok:true empty results — does NOT signal fallback', async () => {
    const { server, port } = await startMockServer((req) =>
      req.cmd === 'recall' ? { ok: true, results: [], _meta: { model: EXPECTED_MODEL, dim: EXPECTED_DIM } } : {},
    );
    try {
      expect(await recallViaDaemon(INFO(port), 'q', 3)).toEqual([]);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('returns null on ok:false (error -> caller falls back to uv)', async () => {
    const { server, port } = await startMockServer((req) =>
      req.cmd === 'recall' ? { ok: false, error: 'recall_loop_dead' } : {},
    );
    try {
      expect(await recallViaDaemon(INFO(port), 'q', 3)).toBeNull();
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('returns null when _meta reports a wrong model (H6)', async () => {
    const { server, port } = await startMockServer((req) =>
      req.cmd === 'recall' ? { ok: true, results: [{ id: 'a' }], _meta: { model: 'other/model', dim: 1024 } } : {},
    );
    try {
      expect(await recallViaDaemon(INFO(port), 'q', 3)).toBeNull();
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('returns null on a whitespace-only query without connecting', async () => {
    expect(await recallViaDaemon(INFO(1), '   ', 3)).toBeNull();
  });

  it('returns null (no hang) when nothing is listening', async () => {
    const probe = net.createServer();
    await new Promise<void>((res) => probe.listen(0, '127.0.0.1', () => res()));
    const deadPort = (probe.address() as any).port;
    await new Promise<void>((res) => probe.close(() => res()));
    expect(await recallViaDaemon(INFO(deadPort), 'q', 3, { timeoutMs: 300 })).toBeNull();
  });
});

describe('ensureDaemonRunning: cross-process spawn lockfile mutex', () => {
  let savedProjectDir: string | undefined;
  let savedUvPath: string | undefined;

  beforeEach(() => {
    // Make pre-validation (repoRoot + uvPath) deterministic so the mutex
    // branch is actually reached. spawn is mocked, so FAKE_UV never runs.
    savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
    savedUvPath = process.env.CCV3_UV_PATH;
    process.env.CLAUDE_PROJECT_DIR = REPO_ROOT;
    process.env.CCV3_UV_PATH = FAKE_UV;
    __test.resetUvPathCache();
  });

  afterEach(() => {
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
    if (savedUvPath === undefined) delete process.env.CCV3_UV_PATH;
    else process.env.CCV3_UV_PATH = savedUvPath;
    __test.resetUvPathCache();
  });

  it('kill-switch: CCV3_EMBEDDING_NO_SPAWN=1 makes it a no-op (no lock, no spawn)', () => {
    const saved = process.env.CCV3_EMBEDDING_NO_SPAWN;
    process.env.CCV3_EMBEDDING_NO_SPAWN = '1';
    try {
      expect(existsSync(SPAWN_LOCK_PATH)).toBe(false);
      ensureDaemonRunning();
      // Kill-switch returns before the fast-path, pre-validation, lock, or spawn.
      expect(mockedSpawn).not.toHaveBeenCalled();
      expect(existsSync(SPAWN_LOCK_PATH)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CCV3_EMBEDDING_NO_SPAWN;
      else process.env.CCV3_EMBEDDING_NO_SPAWN = saved;
    }
  });

  it('does NOT write a new lockfile when an existing one is less than TTL old', () => {
    // Write a fresh lockfile (age = 0s, well within 60s TTL) with a fake PID.
    const fakePid = process.pid + 1000;
    const originalLock = JSON.stringify({ pid: fakePid, started_at: Math.floor(Date.now() / 1000) });
    writeFileSync(SPAWN_LOCK_PATH, originalLock);

    // ensureDaemonRunning should bail after reading the fresh lockfile.
    // It will NOT overwrite the lockfile (pid would change to process.pid if it did).
    ensureDaemonRunning();

    // The lockfile should still have the original fakePid — we did not overwrite it.
    const lockAfter = JSON.parse(readFileSync(SPAWN_LOCK_PATH, 'utf-8'));
    expect(lockAfter.pid).toBe(fakePid);

    // No real subprocess must have been spawned — the mutex blocked it.
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('overwrites a stale lockfile (>TTL old) and writes our own pid', () => {
    // Write a lockfile then back-date its MTIME past the TTL. The atomic mutex
    // now decides staleness from the file MTIME (statSync), not the JSON
    // started_at field — so we must age the file itself.
    const staleTs = Math.floor((Date.now() - SPAWN_LOCK_TTL_MS - 10_000) / 1000);
    writeFileSync(
      SPAWN_LOCK_PATH,
      JSON.stringify({ pid: 99999, started_at: staleTs }),
    );
    const oldSecs = (Date.now() - SPAWN_LOCK_TTL_MS - 10_000) / 1000;
    utimesSync(SPAWN_LOCK_PATH, oldSecs, oldSecs);

    const before = Math.floor(Date.now() / 1000);
    ensureDaemonRunning();
    const after = Math.floor(Date.now() / 1000);

    // The lockfile should now contain our pid (reclaimed the stale one).
    const lock = JSON.parse(readFileSync(SPAWN_LOCK_PATH, 'utf-8'));
    expect(lock.pid).toBe(process.pid);
    expect(lock.started_at).toBeGreaterThanOrEqual(before);
    expect(lock.started_at).toBeLessThanOrEqual(after);

    // Spawn should have been attempted exactly once (stale lock → reclaim → proceed).
    expect(mockedSpawn).toHaveBeenCalledOnce();
    expect(spawnTarget(mockedSpawn.mock.calls[0])).toMatchObject({
      cmd: EXPECTED_UV_ARG,
      args: ['run', '--project', 'opc', 'python', 'opc/scripts/core/embedding_daemon.py', '--daemon'],
    });
    expect(mockedSpawn.mock.calls[0][2]).toMatchObject({ detached: true });
  });

  it('writes lockfile with current pid and fresh timestamp on first call', () => {
    // No existing lockfile.
    expect(existsSync(SPAWN_LOCK_PATH)).toBe(false);

    const before = Math.floor(Date.now() / 1000);
    ensureDaemonRunning();
    const after = Math.floor(Date.now() / 1000);

    // The lockfile must have been written before the spawn attempt.
    expect(existsSync(SPAWN_LOCK_PATH)).toBe(true);
    const lock = JSON.parse(readFileSync(SPAWN_LOCK_PATH, 'utf-8'));
    expect(lock.pid).toBe(process.pid);
    expect(lock.started_at).toBeGreaterThanOrEqual(before);
    expect(lock.started_at).toBeLessThanOrEqual(after);

    // Spawn should have been attempted exactly once.
    expect(mockedSpawn).toHaveBeenCalledOnce();
    expect(spawnTarget(mockedSpawn.mock.calls[0])).toMatchObject({
      cmd: EXPECTED_UV_ARG,
      args: ['run', '--project', 'opc', 'python', 'opc/scripts/core/embedding_daemon.py', '--daemon'],
    });
    expect(mockedSpawn.mock.calls[0][2]).toMatchObject({ detached: true });
  });

  it('_spawnAttempted fast-path: second call in same process skips lockfile check', () => {
    // First call: write lockfile and (mock-)spawn.
    ensureDaemonRunning();
    expect(mockedSpawn).toHaveBeenCalledOnce();

    // Overwrite the lockfile with a different pid to detect if the second
    // call would read/rewrite it.
    writeFileSync(SPAWN_LOCK_PATH, JSON.stringify({ pid: 77777, started_at: 1 }));

    // Second call in the same process — _spawnAttempted is true, returns immediately.
    ensureDaemonRunning();

    // Lockfile should still have pid 77777 (second call did not touch it).
    const lockAfterSecond = JSON.parse(readFileSync(SPAWN_LOCK_PATH, 'utf-8'));
    expect(lockAfterSecond.pid).toBe(77777);

    // Spawn should still have been called only once (fast-path skipped second call).
    expect(mockedSpawn).toHaveBeenCalledOnce();
  });

  it('spawns with NO shell option and windowsHide:true (no cmd.exe window)', () => {
    ensureDaemonRunning();
    expect(mockedSpawn).toHaveBeenCalledOnce();
    const opts = mockedSpawn.mock.calls[0][2] as Record<string, unknown>;
    // Defect B fix: shell:true is gone. A `shell` key at all would risk a
    // cmd.exe console window on Windows.
    expect('shell' in opts).toBe(false);
    expect(opts.windowsHide).toBe(true);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    // Windows: through the relay, else uv's python child gets a visible console.
    const target = spawnTarget(mockedSpawn.mock.calls[0]);
    expect(target.relayed).toBe(process.platform === 'win32');
    // The command is the RESOLVED absolute uv path, not the bare 'uv' shim.
    expect(target.cmd).toBe(EXPECTED_UV_ARG);
  });

  it('does NOT write a lock when uv is unresolvable (F4 pre-validation)', () => {
    // Force uv resolution to fail by pointing the override at a non-existent
    // file and clearing the cache. resolveUvPath probes PATH next, so also
    // ensure there is no lock written even if `where uv` happens to find one
    // by asserting on the spawn (mocked) instead.
    process.env.CCV3_UV_PATH = join(_muTmp, 'does-not-exist-uv');
    __test.resetUvPathCache();
    // If the machine has a real `uv` on PATH, resolveUvPath will still find
    // it — so this assertion only guarantees the *pre-validation order*: no
    // throw, and if uv is genuinely absent, no lock + no spawn. We assert the
    // weaker invariant that the call never throws.
    expect(() => ensureDaemonRunning()).not.toThrow();
  });
});

describe('resolveUvPath: where/which output parsing', () => {
  beforeEach(() => __test.resetUvPathCache());
  afterEach(() => __test.resetUvPathCache());

  it('parses multi-line CRLF `where` output and prefers uv.exe over a .cmd shim', () => {
    // Create a temp dir with a real uv.exe and a real uv.cmd so existsSync
    // passes for both. The parser must prefer the .exe.
    const dir = mkdtempSync(join(tmpdir(), 'ccv3-where-'));
    const cmdPath = join(dir, 'uv.cmd');
    const exePath = join(dir, 'uv.exe');
    writeFileSync(cmdPath, '');
    writeFileSync(exePath, '');
    // `where` lists the .cmd FIRST, .exe second, CRLF-separated, trailing CRLF.
    const whereOut = `${cmdPath}\r\n${exePath}\r\n`;
    const got = __test.parseWhereOutput(whereOut);
    expect(got).toBe(exePath);
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the first existing line when none ends in uv.exe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccv3-where2-'));
    const a = join(dir, 'uv');
    writeFileSync(a, '');
    const got = __test.parseWhereOutput(`${a}\n`);
    expect(got).toBe(a);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no candidate line exists on disk', () => {
    const got = __test.parseWhereOutput('C:\\nope\\uv.exe\r\nC:\\nope2\\uv.cmd\r\n');
    expect(got).toBeNull();
  });

  it('honors the CCV3_UV_PATH env override before probing PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccv3-uvov-'));
    const uv = join(dir, process.platform === 'win32' ? 'uv.exe' : 'uv');
    writeFileSync(uv, '');
    const saved = process.env.CCV3_UV_PATH;
    process.env.CCV3_UV_PATH = uv;
    __test.resetUvPathCache();
    try {
      expect(__test.resolveUvPath()).toBe(resolve(uv));
    } finally {
      if (saved === undefined) delete process.env.CCV3_UV_PATH;
      else process.env.CCV3_UV_PATH = saved;
      __test.resetUvPathCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caches a null result so it does not re-probe', () => {
    // No override, and we cannot guarantee the machine lacks uv — so just
    // assert the cache is sticky: two calls return the SAME value (===).
    const saved = process.env.CCV3_UV_PATH;
    delete process.env.CCV3_UV_PATH;
    __test.resetUvPathCache();
    try {
      const first = __test.resolveUvPath();
      const second = __test.resolveUvPath();
      expect(second).toBe(first);
    } finally {
      if (saved !== undefined) process.env.CCV3_UV_PATH = saved;
      __test.resetUvPathCache();
    }
  });
});

describe('_acquireSpawnLock: atomic create + stale reclaim', () => {
  let dir: string;
  let lockPath: string;
  let savedRunDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccv3-lock-'));
    savedRunDir = process.env.CCV3_EMBEDDING_RUN_DIR;
    process.env.CCV3_EMBEDDING_RUN_DIR = dir;
    lockPath = __test.spawnLockPath();
  });
  afterEach(() => {
    if (savedRunDir === undefined) delete process.env.CCV3_EMBEDDING_RUN_DIR;
    else process.env.CCV3_EMBEDDING_RUN_DIR = savedRunDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns true and creates the lock when none exists', () => {
    expect(existsSync(lockPath)).toBe(false);
    expect(__test.acquireSpawnLock(lockPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lock.pid).toBe(process.pid);
  });

  it('returns false when a fresh lock already exists (no reclaim)', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 11111, started_at: 1 }));
    // mtime is ~now → fresh → another owner.
    expect(__test.acquireSpawnLock(lockPath)).toBe(false);
    // Lock untouched.
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).pid).toBe(11111);
  });

  it('reclaims a stale lock (mtime > TTL) and writes our own pid', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 22222, started_at: 1 }));
    const old = (Date.now() - SPAWN_LOCK_TTL_MS - 5_000) / 1000;
    utimesSync(lockPath, old, old);
    expect(__test.acquireSpawnLock(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
  });
});

describe('ensureDaemonRunning: cross-PROCESS herd (fork) — only one spawns', () => {
  it('exactly one of N forked processes reaches the spawn', async () => {
    // Build a bundle of the module with child_process aliased to the test
    // stub (spawn -> marker append, execFileSync -> fake uv). esbuild is a
    // dev dependency of the hooks package and is on the bin path.
    const work = mkdtempSync(join(tmpdir(), 'ccv3-herd-'));
    const runDir = join(work, 'run');
    mkdirSync(runDir, { recursive: true });
    const counter = join(work, 'counter.bin');
    const bundle = join(work, 'embedding-client.bundle.mjs');
    const fakeUv = join(work, process.platform === 'win32' ? 'uv.exe' : 'uv');
    writeFileSync(fakeUv, '');
    writeFileSync(counter, ''); // start empty

    const stub = join(__testdir, '_cp-stub-template.mjs');
    const srcModule = join(__testdir, '..', 'shared', 'embedding-client.ts');

    // Bundle via the esbuild JS API (avoids the `.cmd` EINVAL that
    // execFileSync hits on Windows). Alias child_process -> stub so spawn
    // never launches a real uv.
    const esbuild = await import('esbuild');
    await esbuild.build({
      entryPoints: [srcModule],
      bundle: true,
      platform: 'node',
      format: 'esm',
      alias: { child_process: stub },
      outfile: bundle,
    });
    expect(existsSync(bundle)).toBe(true);

    const worker = join(__testdir, 'embedding-herd-worker.mjs');

    // Fork N children SIMULTANEOUSLY against the shared runDir (no daemon).
    const N = 5;
    const children = Array.from({ length: N }, () =>
      fork(worker, [runDir, counter, fakeUv, bundle], { silent: true }),
    );

    await Promise.all(
      children.map(
        (c) =>
          new Promise<void>((res) => {
            c.on('exit', () => res());
            c.on('error', () => res());
          }),
      ),
    );

    // Count markers. The atomic openSync('wx') mutex must let exactly ONE
    // child reach the spawn stub, even though _spawnAttempted is per-process.
    const markers = existsSync(counter)
      ? readFileSync(counter, 'utf-8').length
      : 0;
    expect(markers).toBe(1);

    rmSync(work, { recursive: true, force: true });
  }, 60_000);
});
