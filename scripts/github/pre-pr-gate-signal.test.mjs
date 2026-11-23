// Card coord-prepr-close-in-gate: a terminal closed (or a signal sent) while a pre-pr GATE child runs must still free the run lock and stop the child.
// Before: defaultExec ran each gate with spawnSync, so the event loop was blocked for the whole gate and no signal handler could run. Windows ends node
// about 5 s after CTRL_CLOSE, so the lock was freed only by the dead-pid drop of the next acquire, and the gate child was left (PR 701 Known limit).
// Now: defaultExecAsync (async spawn, same result object) is the exec of a real run, and the handlers of installRunLockHandlers stop the live gate child.
//
// How it can fail, one test each, with the source change that makes it fail:
//   G1 runGate reads a promise as a result       (drop the thenable branch of runGate)
//   G2 the async result differs from spawnSync   (change status, timeout, error, the 64 MB cap or the utf8 decode of defaultExecAsync)
//   G3 the loop is blocked during a gate         (put spawnSync back in defaultExecAsync)
//   G4 a signal during a gate leaves the child, the lock or the END row   (drop the gate stop from the handler, or the registry)
// A real SIGHUP cannot reach a node handler on Windows (process.kill ends the process), so G4 emits the signal with process.emit on Windows, as
// pre-pr-signal.test.mjs does, and also sends a real one on POSIX. The live Windows console close is the conhost proof of the card, not a unit test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as PRE from './pre-pr.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const PRE_PR_URL = pathToFileURL(resolve(HERE, 'pre-pr.mjs')).href;

const made = [];
const mk = (prefix) => { const p = mkdtempSync(join(tmpdir(), prefix)); made.push(p); return p; };
after(() => { for (const p of made) { try { rmSync(p, { recursive: true, force: true }); } catch { /* a leftover shows in the folder count */ } } });

const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitDead(pid, tries = 80) { for (let i = 0; i < tries && isAlive(pid); i += 1) await nap(100); return !isAlive(pid); }

const node = (code, dir) => ({ cmd: 'node', args: ['-e', code], cwd: dir, timeoutMs: 30_000 });
const gateOf = (id = 'g-test') => ({ id, cmd: 'node', args: ['-e', ''], cwd: '.', timeoutMs: 60_000 });
const git0 = () => ({ status: 0, stdout: '', stderr: '' });
const shape = (r) => ({ status: r.status, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut });

// ---------- G1: runGate with an async exec ----------
const G1_CASES = [
  ['exit 0', { status: 0, stdout: 'ran\nTests  1 passed (1)\n', stderr: '' }],
  ['exit 2', { status: 2, stdout: 'bad\n', stderr: 'boom\n' }],
  ['timed out', { status: null, stdout: '', stderr: '', timedOut: true }],
  ['could not start', { status: null, stdout: '', stderr: '', timedOut: false, error: 'spawn nope ENOENT' }],
];
for (const [name, res] of G1_CASES) {
  test(`G1: runGate with an async exec gives the same result as with a sync exec (${name})`, async () => {
    const sync = PRE.runGate(gateOf(), { root: REPO_ROOT, exec: () => res, git: git0 });
    const pending = PRE.runGate(gateOf(), { root: REPO_ROOT, exec: async () => res, git: git0 });
    assert.ok(pending instanceof Promise, 'an async exec makes runGate return a promise');
    assert.ok(!(sync instanceof Promise), 'a sync exec keeps runGate sync (the sync callers stay as they are)');
    const got = await pending;
    assert.equal(got.status, sync.status);
    assert.equal(got.detail, sync.detail);
    assert.deepEqual(got.notes, sync.notes);
  });
}

// ---------- G2: defaultExecAsync equals spawnSync ----------
test('G2: exit 0 gives the same status, stdout and stderr as defaultExec', async () => {
  const dir = mk('gate-g2-');
  const spec = node('process.stdout.write("out\\n"); process.stderr.write("err\\n")', dir);
  assert.deepEqual(shape(await PRE.defaultExecAsync(spec)), shape(PRE.defaultExec(spec)));
});

test('G2: exit 3 with stderr gives the same result as defaultExec', async () => {
  const dir = mk('gate-g2-');
  const spec = node('process.stderr.write("nope\\n"); process.exit(3)', dir);
  const got = await PRE.defaultExecAsync(spec);
  assert.equal(got.status, 3);
  assert.deepEqual(shape(got), shape(PRE.defaultExec(spec)));
});

test('G2: a gate over its time limit ends with timedOut true and a null status, and its child is stopped', async () => {
  const dir = mk('gate-g2-');
  const pidFile = join(dir, 'p.pid');
  const spec = { ...node(`require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`, dir), timeoutMs: 1500 };
  const got = await PRE.defaultExecAsync(spec);
  assert.equal(got.timedOut, true);
  assert.equal(got.status, null);
  assert.equal(got.error, undefined, 'a timeout is not a start error');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.equal(await waitDead(pid), true, `the timed out gate child (pid ${pid}) still runs`);
});

test('G2: a command that does not exist gives an error and a null status', async () => {
  const dir = mk('gate-g2-');
  const got = await PRE.defaultExecAsync({ cmd: 'definitely-not-a-command-xyz', args: [], cwd: dir, timeoutMs: 10_000 });
  assert.equal(got.status, null);
  assert.match(String(got.error), /ENOENT/);
  assert.equal(got.timedOut, false);
});

// Seat ruling 11:56: spawnSync ends the child over the cap and gives ENOBUFS with a null status. The async path does the same (spec.maxBuffer is a test seam; default 64 MB).
test('G2: output over the cap ends the child with an ENOBUFS error and a null status, like spawnSync', async () => {
  const dir = mk('gate-g2-');
  const code = 'const b = "x".repeat(65536); const t = setInterval(() => process.stdout.write(b), 1); setTimeout(() => clearInterval(t), 20000)';
  const sync = spawnSync(process.execPath, ['-e', code], { cwd: dir, encoding: 'utf8', maxBuffer: 1_000_000, timeout: 30_000, windowsHide: true });
  assert.equal(sync.error?.code, 'ENOBUFS', 'the reference: spawnSync reports ENOBUFS');
  const got = await PRE.defaultExecAsync({ ...node(code, dir), maxBuffer: 1_000_000 });
  assert.equal(got.status, null);
  assert.match(String(got.error), /ENOBUFS/);
  assert.equal(got.timedOut, false);
  assert.ok(got.stdout.length <= 1_000_000, `stdout is cut at the cap (${got.stdout.length})`);
  assert.ok(got.stdout.length > 0, 'the partial output before the cap is kept');
});

// Seat ruling 11:56: collect Buffers and decode once. A decode per chunk turns a character cut at a chunk edge into U+FFFD.
test('G2: a multibyte character split across two chunks stays whole', async () => {
  const dir = mk('gate-g2-');
  const code = 'process.stdout.write(Buffer.from([0xe2, 0x82])); setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x0a])), 300)';
  const got = await PRE.defaultExecAsync(node(code, dir));
  assert.equal(got.stdout, '€\n');
  assert.ok(!got.stdout.includes('�'));
});

// ---------- G3: the loop is free during a gate ----------
test('G3: timers run while a gate runs (the event loop is not blocked)', async () => {
  const dir = mk('gate-g3-');
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 50);
  try {
    const got = await PRE.defaultExecAsync(node('setTimeout(() => {}, 1200)', dir));
    assert.equal(got.status, 0);
  } finally { clearInterval(timer); }
  assert.ok(ticks >= 8, `a 50 ms timer ticked ${ticks} times during a 1.2 s gate; a blocked loop gives 0 or 1`);
});

// ---------- G4: a signal during a gate ----------
// The fake gate: writes its pid, starts a grandchild that breaks away on Windows (only a real tree kill reaches it), sleeps up to 60 s.
const GATE_SLEEPER = (pidFile) => `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(0), 60000); setInterval(() => {}, 1000)', ${JSON.stringify(`${pidFile}.gc`)}], { stdio: 'ignore', detached: process.platform === 'win32' }).unref();
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => process.exit(0), 60000); setInterval(() => {}, 1000);`;

async function gateSignalCase(signal, expectedCode, { real = false } = {}) {
  const dir = mk('gate-g4-');
  const store = join(dir, 'store');
  const pidFile = join(dir, 'gate.pid');
  const sleeper = join(dir, 'fake-gate.mjs');
  writeFileSync(sleeper, GATE_SLEEPER(pidFile));
  const script = join(dir, 'child.mjs');
  writeFileSync(script, `import { existsSync, readFileSync } from 'node:fs';
import { takeRunLock, defaultExecAsync } from ${JSON.stringify(PRE_PR_URL)};
const [pidFile, sleeper, cwd, signal, how] = process.argv.slice(2);
const got = await takeRunLock({ bodyPath: 'gate-test.md', wait: false, factsOf: () => ({ head: 'abc1234', heavy: false }), say: () => {} });
if (!got) process.exit(9);
defaultExecAsync({ cmd: 'node', args: [sleeper], cwd, timeoutMs: 60000 });
const written = (f) => existsSync(f) && Number(readFileSync(f, 'utf8')) > 0;
while (!written(pidFile) || !written(pidFile + '.gc')) await new Promise((r) => setTimeout(r, 50));
console.log('READY');
if (how === 'real') process.kill(process.pid, signal); else process.emit(signal);
await new Promise((r) => setTimeout(r, 30000)); // the handler exits first; a missing or blocked handler falls through to here
`);
  const r = spawnSync(process.execPath, [script, pidFile, sleeper, dir, signal, real ? 'real' : 'emit'], {
    encoding: 'utf8', timeout: 100_000,
    env: { ...process.env, RUN_LOCK_DIR: store, RUN_LOCK_TEST_SAMPLES: '{"free":[8,8,8],"load":[10,10,10]}' },
  });
  const out = `${r.stdout}\n${r.stderr}`;
  const pidOf = (f) => (existsSync(f) ? Number(readFileSync(f, 'utf8')) || 0 : 0);
  const gatePid = pidOf(pidFile);
  const gcPid = pidOf(`${pidFile}.gc`);
  try {
    assert.match(r.stdout, /READY/, out);
    assert.equal(r.status, expectedCode, out);
    assert.equal(await waitDead(gatePid), true, `the gate child (pid ${gatePid}) is still running after the handler`);
    assert.equal(await waitDead(gcPid), true, `the grandchild of the gate (pid ${gcPid}) is still running after the handler`);
    const locks = existsSync(store) ? readdirSync(store).filter((f) => f.endsWith('.lock') && f !== 'gate.lock') : [];
    assert.deepEqual(locks, [], 'the lock is freed');
    const rows = readFileSync(join(store, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const end = rows.filter((x) => x.event === 'end');
    assert.equal(end.length, 1, 'one END row');
    assert.equal(end[0].result, 'ERROR');
    assert.equal(end[0].exitCode, expectedCode);
  } finally {
    for (const p of [gatePid, gcPid]) if (p > 0 && isAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  }
}

test('G4: SIGTERM during a gate stops the gate child and its tree, frees the lock and writes the END row', { timeout: 120_000 }, () => gateSignalCase('SIGTERM', 143));
test('G4: SIGHUP (a closed terminal) during a gate stops the gate child, frees the lock and exits 129', { timeout: 120_000 }, () => gateSignalCase('SIGHUP', 129));
test('G4: SIGBREAK during a gate exits 149 (Windows only)', { timeout: 120_000, skip: process.platform !== 'win32' }, () => gateSignalCase('SIGBREAK', 149));
test('G4: SIGHUP, real signal during a gate (POSIX only)', { timeout: 120_000, skip: process.platform === 'win32' }, () => gateSignalCase('SIGHUP', 129, { real: true }));
