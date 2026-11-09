/**
 * Tests for the Unix-socket liveness probe in daemon-client.
 *
 * Bug: the probe spawned the external `nc` binary. With no `nc` (Windows,
 * minimal Linux) it reported a LIVE socket as dead, and isDaemonReachable then
 * unlinked it when no PID file existed. A busy daemon (ping timeout) got the
 * same treatment.
 *
 * Rule under test: only ECONNREFUSED / ENOENT mean "stale" and allow an
 * unlink. A successful connect is "live". A timeout or any other error is
 * "unknown": keep the socket.
 *
 * Platform: the unix branch of getConnectionInfo is dead code on win32 (TCP).
 * To still run it there, the reachability tests below switch process.platform
 * to 'linux' and point TEMP at the named-pipe namespace (\\.\pipe\...), so
 * the derived "socket path" is a real Windows named pipe that node can listen
 * on. A pipe disappears when its owner dies, so the stale-file tests are
 * POSIX only (it.skipIf(IS_WINDOWS)).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { tmpdir } from 'os';

// Hoisted so the vi.mock factory below can read it. Default = pass through.
const state = vi.hoisted(() => ({
  ncEnoent: false,
  probeSpawn: null as null | 'error' | 'throw',
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const spawnSync = ((file: string, args: string[], opts: unknown) => {
    // Simulate a host with no `nc` binary.
    if (state.ncEnoent && file === 'nc') {
      return {
        error: Object.assign(new Error('spawnSync nc ENOENT'), { code: 'ENOENT' }),
        status: null, signal: null, stdout: '', stderr: '', output: null, pid: 0,
      };
    }
    // Simulate the probe's own child failing (node spawn error, or a throw).
    if (state.probeSpawn && file === process.execPath && args?.[0] === '-e') {
      if (state.probeSpawn === 'throw') throw new Error('spawn exploded');
      return {
        error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        status: null, signal: 'SIGTERM', stdout: '', stderr: '', output: null, pid: 0,
      };
    }
    return (actual.spawnSync as Function)(file, args, opts);
  }) as typeof actual.spawnSync;
  return { ...actual, spawnSync };
});

import { probeUnixSocket, tryStartDaemon, getConnectionInfo } from '../lib/daemon-client.js';

// tryStartDaemon would spawn a real daemon for an unreachable socket.
process.env.CCV3_DAEMON_NO_AUTOSTART = '1';

const IS_WINDOWS = process.platform === 'win32';
const REAL_PLATFORM = process.platform;
const REAL_TEMP = { TEMP: process.env.TEMP, TMP: process.env.TMP };
// Computed with the real tmpdir, before any override.
const PROJECT_DIR = join(tmpdir(), `daemon-client-ping-${process.pid}`);

let endpointCounter = 0;

/** A unique endpoint a node server can listen on, per platform. */
function uniqueEndpoint(): string {
  const name = `ccv3-ping-${process.pid}-${Date.now()}-${endpointCounter++}.sock`;
  return IS_WINDOWS ? `\\\\.\\pipe\\${name}` : join(tmpdir(), name);
}

type ServerMode = 'answer' | 'silent';

/**
 * Host a mock daemon in a CHILD process. The probe blocks the test's event
 * loop (spawnSync), so an in-process server could not accept. 'answer' replies
 * to any request line with {"status":"ok"}; 'silent' accepts and never replies.
 */
function startChildServer(
  endpoint: string,
  mode: ServerMode,
): Promise<{ stop: () => Promise<void>; kill: () => Promise<void> }> {
  const script = [
    "const net=require('net');",
    'const s=net.createServer(c=>{',
    '  c.on("error",()=>{});',
    '  c.on("data",()=>{',
    '    if(process.env.MOCK_MODE==="answer"){c.write(\'{"status":"ok"}\\n\');c.end();}',
    '  });',
    '});',
    's.listen(process.env.MOCK_SOCKET,()=>console.log("ready"));',
  ].join('\n');
  const child: ChildProcess = spawn(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      TEMP: REAL_TEMP.TEMP,
      TMP: REAL_TEMP.TMP,
      MOCK_SOCKET: endpoint,
      MOCK_MODE: mode,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exit = (signal: NodeJS.Signals): Promise<void> =>
    new Promise<void>((res) => {
      if (child.exitCode !== null || child.signalCode !== null) return res();
      child.once('exit', () => res());
      child.kill(signal);
    });
  return new Promise((res, rej) => {
    child.once('error', rej);
    child.once('exit', (code) => rej(new Error(`mock daemon exited early (${code})`)));
    child.stdout!.once('data', () => {
      child.removeAllListeners('exit');
      // SIGKILL leaves a POSIX socket file behind: a stale socket.
      res({ stop: () => exit('SIGTERM'), kill: () => exit('SIGKILL') });
    });
  });
}

describe('probeUnixSocket', () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => {
    state.probeSpawn = null;
    if (stop) await stop();
    stop = null;
  });

  it("returns 'stale' when nothing exists at the endpoint (ENOENT)", () => {
    expect(probeUnixSocket(uniqueEndpoint(), 500)).toBe('stale');
  });

  it("returns 'live' for a listener that answers", { timeout: 15000 }, async () => {
    const ep = uniqueEndpoint();
    ({ stop } = await startChildServer(ep, 'answer'));
    expect(probeUnixSocket(ep, 1000)).toBe('live');
  });

  it("returns 'live' for a busy listener that accepts but never answers", { timeout: 15000 }, async () => {
    const ep = uniqueEndpoint();
    ({ stop } = await startChildServer(ep, 'silent'));
    const t0 = Date.now();
    expect(probeUnixSocket(ep, 400)).toBe('live');
    // Budget: inner timeout (400) plus node start-up and the 750 ms kill slack.
    expect(Date.now() - t0).toBeLessThan(400 + 750 + 1500);
  });

  it("returns 'unknown', not 'stale', when the probe child fails to run", () => {
    state.probeSpawn = 'error';
    expect(probeUnixSocket(uniqueEndpoint(), 500)).toBe('unknown');
  });

  it("returns 'unknown' and does not throw when the probe spawn throws", () => {
    state.probeSpawn = 'throw';
    expect(() => probeUnixSocket(uniqueEndpoint(), 500)).not.toThrow();
    expect(probeUnixSocket(uniqueEndpoint(), 500)).toBe('unknown');
  });

  it('passes a hostile path as data, never as code', () => {
    // A path holding quotes and a command substitution must not run anything.
    const hostile = `/tmp/x'); process.exit(0); ('$(id)\`whoami\`.sock`;
    expect(probeUnixSocket(hostile, 500)).not.toBe('live');
  });
});

describe('tryStartDaemon: a live Unix socket is never unlinked or reported dead', () => {
  let stop: (() => Promise<void>) | null = null;

  beforeEach(() => {
    state.ncEnoent = true; // host without `nc`
    if (IS_WINDOWS) {
      // Run the unix branch on win32 over a named pipe (see file header).
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      process.env.TEMP = process.env.TMP = `\\\\.\\pipe\\ccv3-ping-${process.pid}`;
    }
  });

  afterEach(async () => {
    state.ncEnoent = false;
    state.probeSpawn = null;
    if (IS_WINDOWS) {
      Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true });
      if (REAL_TEMP.TEMP === undefined) delete process.env.TEMP; else process.env.TEMP = REAL_TEMP.TEMP;
      if (REAL_TEMP.TMP === undefined) delete process.env.TMP; else process.env.TMP = REAL_TEMP.TMP;
    }
    if (stop) await stop();
    stop = null;
  });

  function endpoint(): string {
    const info = getConnectionInfo(PROJECT_DIR);
    expect(info.type).toBe('unix');
    return info.path!;
  }

  it('answering daemon, no PID file, no nc: reachable and the socket stays', { timeout: 15000 }, async () => {
    const ep = endpoint();
    ({ stop } = await startChildServer(ep, 'answer'));
    expect(tryStartDaemon(PROJECT_DIR)).toBe(true);
    expect(existsSync(ep)).toBe(true);
  });

  it('busy daemon (accepts, no reply), no PID file: socket stays', { timeout: 15000 }, async () => {
    const ep = endpoint();
    ({ stop } = await startChildServer(ep, 'silent'));
    expect(tryStartDaemon(PROJECT_DIR)).toBe(true);
    expect(existsSync(ep)).toBe(true);
  });

  it.skipIf(IS_WINDOWS)('stale socket file (listener dead, ECONNREFUSED): unlinked, not reachable', { timeout: 15000 }, async () => {
    const ep = endpoint();
    const server = await startChildServer(ep, 'answer');
    await server.kill();
    expect(existsSync(ep)).toBe(true); // precondition: a dead socket file remains
    expect(tryStartDaemon(PROJECT_DIR)).toBe(false);
    expect(existsSync(ep)).toBe(false);
  });

  it.skipIf(IS_WINDOWS)('probe that cannot decide (unknown): socket file is kept', { timeout: 15000 }, async () => {
    const ep = endpoint();
    const server = await startChildServer(ep, 'answer');
    await server.kill();
    expect(existsSync(ep)).toBe(true);
    state.probeSpawn = 'error';
    try {
      expect(tryStartDaemon(PROJECT_DIR)).toBe(false);
      expect(existsSync(ep)).toBe(true);
    } finally {
      state.probeSpawn = null;
      try { unlinkSync(ep); } catch { /* cleanup */ }
    }
  });
});
