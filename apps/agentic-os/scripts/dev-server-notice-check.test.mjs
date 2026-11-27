// Rows for dev-server-notice-check.mjs (card agentic-os-notice-check-fixes). Run: node --test scripts/dev-server-notice-check.test.mjs
// Each row runs the REAL check script against a fake `next` (plain Node, in a temp folder). Nothing here calls the real Next.js.
// The test seam (scaled waits, another port) works only when NOTICE_CHECK_ALLOW_ENV is exactly 1; the script says so in its header.
// Limit: the check reads what the fake server printed in a 2 to 4 second window. N4 and N5 assert on the exit code and the last line
// only. A split write can still merge under heavy load (two writes read as one chunk); the row then proves less but never fails wrongly:
// a merged write still holds the whole phrase, and the expected exit code is the same.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'dev-server-notice-check.mjs');
const WAIT_SCALE = '0.15'; // 26 s of waits become about 4 s

// The fake `next`: a plain Node file. FAKE_MODE picks the behaviour. It reads the port from `-p <port>` like the real one.
const FAKE_NEXT = `
const http = require('node:http');
const mode = process.env.FAKE_MODE;
const port = Number(process.argv[process.argv.indexOf('-p') + 1]);
const HALF_A = 'known security vul';
const HALF_B = 'nerability';
const serve = (status) => http.createServer((q, r) => { r.statusCode = status; r.end('x'); }).listen(port, '127.0.0.1');
if (mode === 'never') process.exit(0);
if (mode === 'status503') serve(503);
if (mode === 'clean') serve(200);
if (mode === 'notice_one') { serve(200); process.stdout.write('warn: known security vulnerability\\n'); }
if (mode === 'split_chunks') { serve(200); process.stdout.write(HALF_A); setTimeout(() => process.stdout.write(HALF_B + '\\n'), 400); }
if (mode === 'split_streams') { serve(200); process.stdout.write(HALF_A); setTimeout(() => process.stderr.write(HALF_B + '\\n'), 400); }
setInterval(() => {}, 1000);
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'notice-check-'));
  const bin = join(dir, 'node_modules', 'next', 'dist', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'next'), FAKE_NEXT);
  return dir;
}

function runCheck(mode, port) {
  const app = makeApp();
  const env = { ...process.env, FAKE_MODE: mode, NOTICE_CHECK_ALLOW_ENV: '1', NOTICE_CHECK_PORT: String(port), NOTICE_CHECK_WAIT_SCALE: WAIT_SCALE };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, app], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const guard = setTimeout(() => child.kill(), 90_000);
    child.on('close', (code) => {
      clearTimeout(guard);
      rmSync(app, { recursive: true, force: true });
      const lines = out.trim().split(/\r?\n/);
      resolve({ code, last: lines[lines.length - 1] ?? '' });
    });
  });
}

// Old script (no seam): it ignores the env and uses port 3013 with 26 s of waits. The rows still run: they fail on the exit code or the last line.
test('N1 the dev server never starts: exit 3, the last line says it stopped before the end', async () => {
  const r = await runCheck('never', await freePort());
  assert.equal(r.code, 3, r.last);
  assert.match(r.last, /proof: missing: dev server stopped before the end/);
});

test('N2 the server stays up but never answers a request: exit 3, the last line says no request got an HTTP answer', async () => {
  const r = await runCheck('mute', await freePort());
  assert.equal(r.code, 3, r.last);
  assert.match(r.last, /proof: missing: no request got an HTTP answer/);
});

test('N2b the server answers 503 (the real answer with the closed database url): that is proof, exit 0', async () => {
  const r = await runCheck('status503', await freePort());
  assert.equal(r.code, 0, r.last);
  assert.match(r.last, /proof: ok/);
});

test('N3 the notice in one chunk: exit 1', async () => {
  const r = await runCheck('notice_one', await freePort());
  assert.equal(r.code, 1, r.last);
  assert.match(r.last, /notice present: true/);
});

test('N4 the notice split across two chunks of one stream: exit 1', async () => {
  const r = await runCheck('split_chunks', await freePort());
  assert.equal(r.code, 1, r.last);
  assert.match(r.last, /notice present: true/);
});

test('N5 the halves on two different streams are NOT one notice: exit 0', async () => {
  const r = await runCheck('split_streams', await freePort());
  assert.equal(r.code, 0, r.last);
  assert.match(r.last, /notice present: false/);
  assert.match(r.last, /proof: ok/);
});

test('N6 a clean run to the end with a 200: exit 0, proof ok', async () => {
  const r = await runCheck('clean', await freePort());
  assert.equal(r.code, 0, r.last);
  assert.match(r.last, /notice present: false/);
  assert.match(r.last, /proof: ok/);
});

test('N7 a busy port: exit 2, the script stops no process it did not start', async () => {
  const port = await freePort();
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(port, '127.0.0.1', resolve));
  try {
    const r = await runCheck('clean', port);
    assert.equal(r.code, 2, r.last);
    assert.match(r.last, /is busy/);
  } finally {
    holder.close();
  }
});
