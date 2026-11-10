/**
 * queryDaemonSync Unix transport: Node-native, no `nc`.
 *
 * buildDaemonInvocation (Unix branch) used to return `nc -U <path>`. A host
 * without `nc` could not query a LIVE daemon. The Unix invocation now runs
 * node itself (process.execPath) with a tiny client script. These tests run
 * the REAL invocation that buildDaemonInvocation returns against a fake local
 * daemon: a unix socket on POSIX, a named pipe on Windows (both are what
 * node's net.connect(path) accepts).
 *
 * The invocation runs in a child process (async spawn) so the in-process fake
 * server can answer while the test awaits.
 *
 * Failure modes covered, one test each:
 *  1. the invocation still names `nc`
 *  2. the model-controlled payload leaks into argv (injection) instead of stdin
 *  3. the daemon's reply is not returned as one JSON line on stdout
 *  4. a large multi-chunk reply with split multibyte chars is truncated/corrupted
 *  5. a reply without a trailing newline (close-delimited) is lost
 *  6. the daemon closes with no reply -> must be a non-zero exit (unavailable)
 *  7. nothing listens on the path -> must be a non-zero exit (unavailable)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';
import * as net from 'net';
import { buildDaemonInvocation, type DaemonInvocation } from '../lib/daemon-client.js';

const IS_WINDOWS = process.platform === 'win32';

let seq = 0;
function freshEndpoint(): string {
  const name = `ccv3-qds-${process.pid}-${Date.now()}-${seq++}`;
  return IS_WINDOWS ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

interface RunResult {
  status: number | null;
  stdout: string;
}

function runInvocation(inv: DaemonInvocation, timeoutMs = 8000): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(inv.file, inv.args, { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    let stdout = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d) => { stdout += d; });
    const timer = setTimeout(() => {
      child.kill();
      rejectRun(new Error('invocation did not exit in time'));
    }, timeoutMs);
    child.once('error', (e) => { clearTimeout(timer); rejectRun(e); });
    child.once('close', (status) => { clearTimeout(timer); resolveRun({ status, stdout }); });
    child.stdin!.end(inv.stdin);
  });
}

describe('buildDaemonInvocation Unix branch: Node-native', () => {
  const servers: net.Server[] = [];
  const endpoints: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    for (const p of endpoints.splice(0)) {
      if (!IS_WINDOWS) { try { unlinkSync(p); } catch { /* already gone */ } }
    }
  });

  function serve(handler: (conn: net.Socket, request: string) => void): Promise<string> {
    const path = freshEndpoint();
    endpoints.push(path);
    const server = net.createServer((conn) => {
      let buf = '';
      conn.on('error', () => {});
      conn.on('data', (d) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        handler(conn, buf.slice(0, nl));
      });
    });
    servers.push(server);
    return new Promise((res, rej) => {
      server.once('error', rej);
      server.listen(path, () => res(path));
    });
  }

  it('does not use nc', () => {
    const inv = buildDaemonInvocation({ type: 'unix', path: '/tmp/tldr-abc.sock' }, '{"cmd":"ping"}');
    expect(inv.file).not.toBe('nc');
    expect(inv.file).toBe(process.execPath);
  });

  it('keeps the payload on stdin and out of argv', () => {
    const payload = JSON.stringify({ cmd: 'search', pattern: `x"; calc & rm -rf / ; $(id) \`whoami\` '` });
    const inv = buildDaemonInvocation({ type: 'unix', path: '/tmp/tldr-abc.sock' }, payload);
    expect(inv.stdin).toBe(payload);
    expect(inv.args.some((a) => a.includes('calc') || a.includes('rm -rf') || a.includes(payload))).toBe(false);
    expect(inv.args).toContain('/tmp/tldr-abc.sock');
  });

  it('returns the daemon reply as one JSON line and sends the payload verbatim', async () => {
    const payload = JSON.stringify({ cmd: 'search', pattern: `q"uo'te $(id) \`x\` \\ é` });
    let seen = '';
    const path = await serve((conn, request) => {
      seen = request;
      conn.write(JSON.stringify({ status: 'ok', echoed: request }) + '\n');
      conn.end();
    });
    const r = await runInvocation(buildDaemonInvocation({ type: 'unix', path }, payload));
    expect(r.status).toBe(0);
    expect(seen).toBe(payload);
    expect(JSON.parse(r.stdout.trim())).toEqual({ status: 'ok', echoed: payload });
  });

  it('returns a large multi-chunk reply with split multibyte characters intact', async () => {
    const results = Array.from({ length: 4000 }, (_, i) => ({ file: `f${i}.ts`, content: '€€€ é 日本' }));
    const body = Buffer.from(JSON.stringify({ status: 'ok', results }) + '\n', 'utf8');
    const path = await serve((conn) => {
      // 1001-byte slices never align with the 3-byte euro sign: chunks split mid-character.
      let off = 0;
      const pump = () => {
        if (off >= body.length) { conn.end(); return; }
        conn.write(body.subarray(off, off + 1001), pump);
        off += 1001;
      };
      pump();
    });
    const r = await runInvocation(buildDaemonInvocation({ type: 'unix', path }, '{"cmd":"search"}'));
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.results).toHaveLength(4000);
    expect(parsed.results[3999].content).toBe('€€€ é 日本');
  });

  it('returns a reply that has no trailing newline when the daemon closes', async () => {
    const path = await serve((conn) => {
      conn.end(JSON.stringify({ status: 'ok', n: 1 }));
    });
    const r = await runInvocation(buildDaemonInvocation({ type: 'unix', path }, '{"cmd":"ping"}'));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ status: 'ok', n: 1 });
  });

  it('exits non-zero with no stdout when the daemon closes without replying', async () => {
    const path = await serve((conn) => { conn.end(); });
    const r = await runInvocation(buildDaemonInvocation({ type: 'unix', path }, '{"cmd":"ping"}'));
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('exits non-zero with no stdout when nothing listens on the path', async () => {
    const r = await runInvocation(buildDaemonInvocation({ type: 'unix', path: freshEndpoint() }, '{"cmd":"ping"}'));
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});
