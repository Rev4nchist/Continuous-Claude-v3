// Tests for scripts/coordination/run-wrap.mjs (card coord-run-lock-wrapper-loops).
// The wrapper starts a loop, a label run or a pre-pr launch, refuses a duplicate run for one head, registers the REAL child
// (not the shell) with the run lock, stops the child's own tree on a signal, and fails open.
//
// How it can fail, one test each:
//   guard (pure)   findDuplicate: same kind, head and owner is a duplicate; another head, kind or owner is not
//   W1             a second start for the same head and owner exits 75 and its command never runs; another head runs
//   W2             the lock file holds the CHILD pid, not the wrapper pid, with kind, head and holder
//   W3             the exit code of the command is the exit code of the wrapper, and no lock file stays
//   W4             a signal to the wrapper stops the child and frees the lock (exit 143)
//   W5             a lock store that cannot be read: the command still runs, exactly one WARN line, no refusal
//   W6             control: without --once-per two starts for one head both run
//   W7             a loop lock is renewed while the child lives (expiresAt moves)
//   tree (Windows) the stop goes through scripts/lib/Stop-ProcessTree.ps1 and names no taskkill
// Real processes and a scratch RUN_LOCK_DIR. The live store is never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAP = join(HERE, 'run-wrap.mjs');
const TIMEOUT = 150_000;
const kept = [];
const scratch = (name) => { const d = mkdtempSync(join(tmpdir(), `runwrap-${name}-`)); kept.push(d); return d; };
const wrappers = [];

after(() => {
  for (const w of wrappers) { try { w.kill(); } catch { /* gone */ } }
  for (const d of kept) { try { rmSync(d, { recursive: true, force: true }); } catch { /* a handle may still be open */ } }
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 90_000, every = 250) {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(every); }
}

/** Start the wrapper CLI. Returns { proc, out(), done: Promise<exit code> }. */
function wrap(args, env = {}) {
  const proc = spawn(process.execPath, [WRAP, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  wrappers.push(proc);
  let text = '';
  proc.stdout.on('data', (b) => { text += b; });
  proc.stderr.on('data', (b) => { text += b; });
  const done = new Promise((res) => proc.on('close', (code) => res(code)));
  return { proc, out: () => text, done };
}

/** A command that writes its pid to a marker file and lives until killed. */
const longChild = (marker) => ['node', '-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", marker];
const quickChild = (marker, code = 0) => ['node', '-e', `require('fs').writeFileSync(process.argv[1], 'ran'); process.exit(${code})`, marker];
const locks = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.lock') && f !== 'gate.lock') : []);
const lockOf = (dir) => { const f = locks(dir)[0]; return f ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null; };

test('guard: findDuplicate matches kind, head and owner only', async () => {
  const { findDuplicate } = await import(pathToFileURL(WRAP).href);
  const live = [{ kind: 'loop', pid: 11, head: 'aaa', holder: 'h1', session: '#s1' }];
  assert.equal(findDuplicate(live, { kind: 'loop', head: 'aaa', holder: 'h1', session: '#s1' })?.pid, 11);
  assert.equal(findDuplicate(live, { kind: 'loop', head: 'bbb', holder: 'h1', session: '#s1' }), null, 'another head');
  assert.equal(findDuplicate(live, { kind: 'label-run', head: 'aaa', holder: 'h1', session: '#s1' }), null, 'another kind');
  assert.equal(findDuplicate(live, { kind: 'loop', head: 'aaa', holder: 'h2', session: '#s2' }), null, 'another owner');
  assert.equal(findDuplicate(live, { kind: 'loop', head: null, holder: 'h1', session: '#s1' }), null, 'no head, no guard');
});

test('W1 + W2 + W6: duplicate refused, child pid registered, guard off runs', { timeout: TIMEOUT }, async () => {
  const store = scratch('store'); const files = scratch('files');
  const env = { RUN_LOCK_DIR: store };
  const mA = join(files, 'a.pid'); const mB = join(files, 'b.ran'); const mC = join(files, 'c.ran'); const mD = join(files, 'd.ran');
  const base = ['--kind', 'loop', '--once-per', 'head', '--holder', 'tA', '--minutes', '5'];
  const A = wrap([...base, '--head', 'H1', '--', ...longChild(mA)], env);
  await until(() => existsSync(mA) && locks(store).length > 0);
  const rec = lockOf(store);
  const childPid = Number(readFileSync(mA, 'utf8'));
  // W2: the lock names the child, not the wrapper
  assert.equal(rec.pid, childPid, 'the lock holds the child pid');
  assert.notEqual(rec.pid, A.proc.pid, 'the lock does not hold the wrapper pid');
  assert.equal(rec.kind, 'loop'); assert.equal(rec.head, 'H1'); assert.equal(rec.holder, 'tA');
  // W1: same head and owner: refused, the command never runs
  const B = wrap([...base, '--head', 'H1', '--', ...quickChild(mB)], env);
  assert.equal(await B.done, 75, B.out());
  assert.match(B.out(), /DUPLICATE/);
  assert.equal(existsSync(mB), false, 'the refused command ran');
  // W1: another head runs
  const C = wrap([...base, '--head', 'H2', '--', ...quickChild(mC)], env);
  assert.equal(await C.done, 0, C.out());
  assert.equal(existsSync(mC), true);
  // W6: control, guard off, same head: runs
  const D = wrap(['--kind', 'loop', '--holder', 'tA', '--head', 'H1', '--', ...quickChild(mD)], env);
  assert.equal(await D.done, 0, D.out());
  assert.equal(existsSync(mD), true, 'without --once-per a second run must start');
  process.kill(childPid);
  await A.done;
});

test('W3: the exit code passes through and no lock stays', { timeout: TIMEOUT }, async () => {
  const store = scratch('store'); const files = scratch('files');
  const W = wrap(['--kind', 'label-run', '--holder', 'tW', '--head', 'H3', '--', ...quickChild(join(files, 'x.ran'), 3)], { RUN_LOCK_DIR: store });
  assert.equal(await W.done, 3, W.out());
  assert.deepEqual(locks(store), []);
});

test('W4: a signal to the wrapper stops the child and frees the lock', { timeout: TIMEOUT }, async () => {
  const store = scratch('store'); const files = scratch('files');
  const mark = join(files, 'k.pid');
  const W = wrap(['--kind', 'loop', '--holder', 'tK', '--head', 'H4', '--', ...longChild(mark)], { RUN_LOCK_DIR: store, RUN_WRAP_SELF_SIGNAL_MS: '500' });
  await until(() => existsSync(mark));
  const childPid = Number(readFileSync(mark, 'utf8'));
  const code = await W.done;
  assert.equal(code, 143, W.out());
  await until(() => !alive(childPid), 30_000);
  assert.equal(alive(childPid), false, 'the child lives after the signal');
  assert.deepEqual(locks(store), [], 'the lock stays after the signal');
});

test('W5: an unreadable lock store fails open with one WARN line and no refusal', { timeout: TIMEOUT }, async () => {
  const files = scratch('files');
  const notADir = join(files, 'store-is-a-file'); writeFileSync(notADir, 'x');
  const mark = join(files, 'f.ran');
  const W = wrap(['--kind', 'loop', '--once-per', 'head', '--holder', 'tF', '--head', 'H5', '--', ...quickChild(mark)], { RUN_LOCK_DIR: notADir });
  assert.equal(await W.done, 0, W.out());
  assert.equal(existsSync(mark), true, 'the command must run');
  const warns = W.out().split(/\r?\n/).filter((l) => /^WARN/.test(l));
  assert.equal(warns.length, 1, `expected one WARN line, got ${warns.length}:\n${W.out()}`);
  assert.doesNotMatch(W.out(), /DUPLICATE/);
});

test('W7: a loop lock is renewed while the child lives', { timeout: TIMEOUT }, async () => {
  const store = scratch('store'); const files = scratch('files');
  const mark = join(files, 'r.pid');
  const W = wrap(['--kind', 'loop', '--holder', 'tR', '--head', 'H7', '--', ...longChild(mark)], { RUN_LOCK_DIR: store, RUN_WRAP_RENEW_MS: '2000' });
  await until(() => existsSync(mark) && lockOf(store));
  const first = lockOf(store).expiresAt;
  await until(() => (lockOf(store)?.expiresAt ?? 0) > first, 60_000);
  assert.ok(lockOf(store).expiresAt > first);
  process.kill(Number(readFileSync(mark, 'utf8')));
  await W.done;
});

test('tree: Windows stop uses Stop-ProcessTree.ps1 and the source names no taskkill', () => {
  const src = readFileSync(WRAP, 'utf8');
  assert.match(src, /Stop-ProcessTree\.ps1/);
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''), /taskkill/i);
});
