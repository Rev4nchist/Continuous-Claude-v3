// Card coord-run-lock-and-go-row: a SIGINT or SIGTERM stops the live CodeRabbit child BEFORE pre-pr frees its run lock.
// A real SIGTERM cannot reach a node handler on Windows (process.kill ends the process with no handler and no 'exit' event).
// So the child script below calls process.emit('SIGTERM'), which runs the listeners that installRunLockHandlers added.
// The script runs the same code path as pre-pr: installRunLockHandlers (what takeRunLock calls) and the real defaultCrRunner
// with a fake cr command (a node script that sleeps). Every store is a temp folder (RUN_LOCK_DIR), never the real one.
//
// How the call can fail, one test each, with the source change that makes it fail:
//   no kill      the handler exits at once, the review keeps running, and the lock is freed beside it    (drop killActiveCr from the handler)
//   no registry  defaultCrRunner does not record its child, so the handler has nothing to stop            (drop the activeCr set)
//   stale child  the registry keeps a child that has ended, so the handler kills a reused pid             (drop the clear on close)
// The lock is freed by the 'exit' listener that process.exit runs after the handler, so a kill in the handler always comes first.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultCrRunner, killActiveCr } from './pre-pr.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRE_PR_URL = pathToFileURL(resolve(HERE, 'pre-pr.mjs')).href;
const RUN_LOCK_URL = pathToFileURL(resolve(HERE, '..', 'coordination', 'run-lock.mjs')).href;
const REVIEW = ['review', '--agent', '--committed', '--base', 'main'];

// Test hygiene: every temp folder is made here and removed in the after step. None holds a link, so a plain recursive remove is safe.
const made = [];
const mk = (prefix) => { const p = mkdtempSync(join(tmpdir(), prefix)); made.push(p); return p; };
after(() => {
  for (const p of made) { try { rmSync(p, { recursive: true, force: true }); } catch { /* a leftover shows in the folder count */ } }
});

const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitDead(pid, tries = 80) {
  for (let i = 0; i < tries && isAlive(pid); i += 1) await nap(100);
  return !isAlive(pid);
}

// The fake cr: writes its pid to a file, then sleeps. It ends by itself after 60 seconds, so a failed test leaves no run for ever.
const SLEEPER = (pidFile) => `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => process.exit(0), 60000); setInterval(() => {}, 1000);`;
// The same, plus a grandchild that sleeps too. On Windows libuv puts a normal child in a job object that dies with its parent,
// which would hide a missing kill: the grandchild breaks away (detached) so that only a real tree kill reaches it (as T5 in
// pre-pr.test.mjs does). On POSIX the review child leads a process group and the grandchild stays in it.
const TREE_SLEEPER = (pidFile) => `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(0), 60000); setInterval(() => {}, 1000)', ${JSON.stringify(`${pidFile}.gc`)}], { stdio: 'ignore', detached: process.platform === 'win32' }).unref();
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => process.exit(0), 60000); setInterval(() => {}, 1000);`;

test('SIGTERM: the handler stops the live CodeRabbit child, and the lock is freed at exit', { timeout: 120_000 }, async () => {
  const dir = mk('prepr-signal-');
  const store = join(dir, 'store');
  const pidFile = join(dir, 'cr.pid');
  const sleeper = join(dir, 'fake-cr.mjs');
  writeFileSync(sleeper, TREE_SLEEPER(pidFile));
  const script = join(dir, 'child.mjs');
  writeFileSync(script, `import { existsSync, readFileSync } from 'node:fs';
import { installRunLockHandlers, defaultCrRunner } from ${JSON.stringify(PRE_PR_URL)};
import { register } from ${JSON.stringify(RUN_LOCK_URL)};
const [pidFile, sleeper, cwd] = process.argv.slice(2);
await register({ kind: 'pre-pr', pid: process.pid, holder: 'signal-test' });
installRunLockHandlers();
defaultCrRunner({ cwd, args: ${JSON.stringify(REVIEW)}, timeoutMs: 60000 }, { command: process.execPath, prefixArgs: [sleeper] });
const written = (f) => existsSync(f) && Number(readFileSync(f, 'utf8')) > 0;
while (!written(pidFile) || !written(pidFile + '.gc')) await new Promise((r) => setTimeout(r, 50));
console.log('READY');
process.emit('SIGTERM');
await new Promise((r) => setTimeout(r, 30000)); // the handler exits first; a missing handler would fall through to here and the test fails on the exit code
`);
  const r = spawnSync(process.execPath, [script, pidFile, sleeper, dir], {
    encoding: 'utf8', timeout: 100_000, env: { ...process.env, RUN_LOCK_DIR: store },
  });
  const out = `${r.stdout}\n${r.stderr}`;
  const pidOf = (f) => (existsSync(f) ? Number(readFileSync(f, 'utf8')) || 0 : 0);
  const crPid = pidOf(pidFile);
  const gcPid = pidOf(`${pidFile}.gc`);
  try {
    assert.match(r.stdout, /READY/, out);
    assert.equal(r.status, 143, out);
    assert.ok(crPid > 0 && gcPid > 0, 'the fake cr and its grandchild started');
    assert.equal(await waitDead(crPid), true, `the fake cr (pid ${crPid}) is still running after the handler`);
    assert.equal(await waitDead(gcPid), true, `the grandchild of the fake cr (pid ${gcPid}) is still running after the handler`);
    const locks = existsSync(store) ? readdirSync(store).filter((f) => f.endsWith('.lock') && f !== 'gate.lock') : [];
    assert.deepEqual(locks, [], 'the lock is freed at exit');
  } finally {
    // Each pid was read from a file our own fake cr wrote a moment ago: stop only those exact pids.
    for (const p of [crPid, gcPid]) if (p > 0 && isAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  }
});

test('the registry holds the child only while it runs: after the child ends there is nothing to stop', async () => {
  const dir = mk('prepr-signal-');
  const script = join(dir, 'quick.mjs');
  writeFileSync(script, 'console.log("done");');
  const r = await defaultCrRunner({ cwd: dir, args: REVIEW, timeoutMs: 20_000 }, { command: process.execPath, prefixArgs: [script] });
  assert.equal(r.status, 0);
  let killed = 0;
  assert.equal(killActiveCr(() => { killed += 1; }), false, 'no live child');
  assert.equal(killed, 0);
});

test('the registry holds the child while it runs: killActiveCr stops that child and forgets it', async () => {
  const dir = mk('prepr-signal-');
  const pidFile = join(dir, 'cr.pid');
  const sleeper = join(dir, 'fake-cr.mjs');
  writeFileSync(sleeper, SLEEPER(pidFile));
  const run = defaultCrRunner({ cwd: dir, args: REVIEW, timeoutMs: 60_000 }, { command: process.execPath, prefixArgs: [sleeper], tickMs: 1000 });
  const pidNow = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) || 0 : 0); // an empty file reads as 0
  for (let i = 0; i < 100 && pidNow() <= 0; i += 1) await nap(50);
  const crPid = pidNow();
  assert.ok(crPid > 0, 'the fake cr started'); // pid 0 would name our own process group: never signal it
  try {
    assert.equal(killActiveCr((child) => process.kill(child.pid, 'SIGKILL')), true, 'a live child was registered');
    assert.equal(killActiveCr(() => { throw new Error('a second kill must not run'); }), false, 'forgotten after the kill');
    assert.equal(await waitDead(crPid), true);
    await run;
  } finally {
    if (isAlive(crPid)) { try { process.kill(crPid, 'SIGKILL'); } catch { /* gone */ } }
  }
});

test('the registry forgets the child when the run settles by timeout, even if the child never closes', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const dir = mk('prepr-signal-');
  const child = Object.assign(new EventEmitter(), { pid: 1, stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const r = await defaultCrRunner(
    { cwd: dir, args: REVIEW, timeoutMs: 50 },
    { spawnFn: () => child, killer: () => {}, killGraceMs: 50, tickMs: 1000 },
  );
  assert.equal(r.timedOut, true, 'the run settled by the timeout; the child never emitted close');
  let killed = 0;
  assert.equal(killActiveCr(() => { killed += 1; }), false, 'a settled run leaves no child in the registry');
  assert.equal(killed, 0);
});
