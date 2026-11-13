/**
 * coord-drill-2 / lib.test.mjs -- the read-error paths of the two real-home proofs (review 4, lib.mjs:370 and :428).
 *
 *   node --test scripts/coordination/coord-drill-2/lib.test.mjs
 *
 * Each test builds a temp "home" in os.tmpdir() and passes it as `homes`, so no real home is read or written.
 * A read error is made with a deny of read-data on one file (icacls on Windows, chmod 000 elsewhere).
 * Failure modes these tests catch:
 *   1. gainedText returns '' on a read error again: diffRealHome then reports nothing for a changed, unreadable file.
 *   2. tailText returns '' on a read error again: scanRealHomeChanged counts the file as scanned, not unreadable.
 *   3. scanIncomplete is not set when a changed file is unreadable: run.mjs would print "SANDBOX: 0 writes".
 * childEnv, the guard that keeps every child off the live database (seat review 2026-11-13):
 *   4. one of the three database variables keeps the inherited (live) url, or is missing.
 *   5. childEnv accepts a url that is not a scratch database.
 *   6. a caller's `extra` (any letter case) moves a sandbox or database key.
 *   7. a sandbox key (HOME, USERPROFILE, trace dir, guard log) is not the sandbox path.
 * result(), the row object:
 *   8. a broken or missing positive control lets a PASS or FAIL through instead of ERROR.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HarnessError, childEnv, diffRealHome, makeSandbox, result, scanRealHomeChanged, snapshotRealHome } from './lib.mjs';

const MARKER = 'drill-test-marker-0001';
const isWin = process.platform === 'win32';
const isRoot = !isWin && typeof process.getuid === 'function' && process.getuid() === 0;

function denyRead(file) {
  if (isWin) {
    const r = spawnSync('icacls', [file, '/deny', `${os.userInfo().username}:(RD)`], { windowsHide: true, encoding: 'utf8' });
    assert.equal(r.status, 0, `icacls deny failed: ${r.stderr || r.stdout}`);
  } else {
    fs.chmodSync(file, 0o000);
  }
}

function allowRead(file) {
  if (isWin) spawnSync('icacls', [file, '/remove:d', os.userInfo().username], { windowsHide: true });
  else { try { fs.chmodSync(file, 0o644); } catch { /* ignore */ } }
}

/** A temp home with the watched session-id file. Returns { dir, home, sid }. */
function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-drill-2-libtest-'));
  const home = path.join(dir, 'home');
  const sid = path.join(home, '.claude', '.coordination-session-id');
  fs.mkdirSync(path.dirname(sid), { recursive: true });
  fs.writeFileSync(sid, '0'.repeat(36));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(sid, old, old);
  return { dir, home, sid };
}

function readFails(file) {
  try { fs.readFileSync(file); return false; } catch { return true; }
}

test('diffRealHome reports a changed watched file that cannot be read', { skip: isRoot && 'root ignores chmod 000' }, (t) => {
  const { dir, home, sid } = tempHome();
  t.after(() => { allowRead(sid); fs.rmSync(dir, { recursive: true, force: true }); });
  const before = snapshotRealHome([home]);
  fs.writeFileSync(sid, MARKER.padEnd(36, '-')); // same size: only a whole-file read could see the marker
  denyRead(sid);
  assert.ok(readFails(sid), 'setup: the deny did not stop the read');
  const changed = diffRealHome(before, [MARKER], [home]);
  assert.equal(changed.length, 1, `expected one report, got ${JSON.stringify(changed)}`);
  assert.match(changed[0], /could not be read/);
});

test('scanRealHomeChanged counts an unreadable changed file as unreadable and marks the scan incomplete', { skip: isRoot && 'root ignores chmod 000' }, (t) => {
  const { dir, home } = tempHome();
  const idFile = path.join(home, '.claude', 'state', 'identity', 'locked.json');
  t.after(() => { allowRead(idFile); fs.rmSync(dir, { recursive: true, force: true }); });
  const before = snapshotRealHome([home]);
  fs.mkdirSync(path.dirname(idFile), { recursive: true });
  fs.writeFileSync(idFile, `{"uuid":"${MARKER}"}\n`);
  denyRead(idFile);
  assert.ok(readFails(idFile), 'setup: the deny did not stop the read');
  const scan = scanRealHomeChanged(before, [MARKER], [home]);
  assert.equal(scan.unreadable, 1);
  assert.equal(scan.scanned, 0);
  assert.equal(scan.hits.length, 0);
  assert.equal(scan.scanIncomplete, true);
});

test('scanRealHomeChanged on readable files is complete (control for the test above)', (t) => {
  const { dir, home } = tempHome();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = snapshotRealHome([home]);
  const idFile = path.join(home, '.claude', 'state', 'identity', 'open.json');
  fs.mkdirSync(path.dirname(idFile), { recursive: true });
  fs.writeFileSync(idFile, `{"uuid":"${MARKER}"}\n`);
  const scan = scanRealHomeChanged(before, [MARKER], [home]);
  assert.equal(scan.unreadable, 0);
  assert.equal(scan.scanned, 1);
  assert.equal(scan.hits.length, 1);
  assert.equal(scan.scanIncomplete, false);
});

// ---------------------------------------------------------------- childEnv

const SCRATCH = 'postgresql://u:p@localhost:5432/lanes_pr1_deadbeef';
const LIVE = 'postgresql://u:p@localhost:5432/continuous_claude';
const DB_VARS = ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL'];

/** Run fn with the three database variables set to the live-looking url, then restore them. */
function withLiveEnv(fn) {
  const saved = Object.fromEntries(DB_VARS.map((k) => [k, process.env[k]]));
  for (const k of DB_VARS) process.env[k] = LIVE;
  try { return fn(); } finally {
    for (const k of DB_VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function sandboxFor(t) {
  const sb = makeSandbox(`t${process.pid}`);
  t.after(() => sb.cleanup());
  return sb;
}

test('childEnv sets all three database variables to the scratch url, over an inherited live url', (t) => {
  const sb = sandboxFor(t);
  const env = withLiveEnv(() => childEnv(SCRATCH, sb));
  for (const k of DB_VARS) assert.equal(env[k], SCRATCH, `${k} is not the scratch url`);
});

test('childEnv refuses a url that is not a scratch database, and a missing url', (t) => {
  const sb = sandboxFor(t);
  assert.throws(() => childEnv(LIVE, sb), HarnessError);
  assert.throws(() => childEnv(null, sb), HarnessError);
});

test('childEnv refuses an extra that names a sandbox or database key, in any letter case', (t) => {
  const sb = sandboxFor(t);
  for (const k of ['DATABASE_URL', 'database_url', 'Home', 'USERPROFILE', 'ccv3_guard_decisions_log']) {
    assert.throws(() => childEnv(SCRATCH, sb, { [k]: LIVE }), HarnessError, `extra ${k} was accepted`);
  }
});

test('childEnv points the home and the hook logs into the sandbox', (t) => {
  const sb = sandboxFor(t);
  const env = childEnv(SCRATCH, sb);
  assert.equal(env.HOME, sb.homeDir);
  assert.equal(env.USERPROFILE, sb.homeDir);
  assert.equal(env.CCV3_GUARD_DECISIONS_LOG, sb.guardLog);
  assert.equal(env.CCV3_HOOK_TRACE_DIR, sb.traceDir);
  for (const k of ['HOME', 'CCV3_GUARD_DECISIONS_LOG', 'CCV3_HOOK_TRACE_DIR']) {
    assert.ok(path.resolve(env[k]).startsWith(path.resolve(sb.dir)), `${k} is outside the sandbox`);
  }
});

// ---------------------------------------------------------------- result()

test('a broken or missing positive control makes the row ERROR, whatever verdict was asked', () => {
  for (const verdict of ['PASS', 'FAIL']) {
    const broken = result({ id: 't', verdict, reason: 'r', control: { name: 'c', ok: false, detail: 'd' } });
    assert.equal(broken.verdict, 'ERROR', `${verdict} with a broken control`);
    const none = result({ id: 't', verdict, reason: 'r' });
    assert.equal(none.verdict, 'ERROR', `${verdict} with no control`);
  }
  assert.equal(result({ id: 't', verdict: 'FAIL', reason: 'r', control: { name: 'c', ok: true } }).verdict, 'FAIL');
});

// ---------------------------------------------------------------- guards: withPg, runNode, env scrub, timeout, track

// A url on a closed port: even if the guard were gone, no server would answer (the test never reaches a real database).
const CLOSED_LIVE = 'postgresql://u:p@127.0.0.1:1/continuous_claude';

test('withPg refuses a url that is not a scratch database, and a missing url, before it connects', async () => {
  const { withPg } = await import('./lib.mjs');
  let ran = false;
  await assert.rejects(withPg(CLOSED_LIVE, async () => { ran = true; }), /not a scratch database/);
  await assert.rejects(withPg(null, async () => { ran = true; }), /no database url/);
  assert.equal(ran, false);
});

test('runNode refuses a call with no env (a child with no env would inherit the live database url)', async () => {
  const { runNode } = await import('./lib.mjs');
  const missing = path.join(os.tmpdir(), 'coord-drill-2-no-such-script.mjs');
  assert.throws(() => runNode(missing, []), /env is missing/);
  assert.throws(() => runNode(missing, [], { env: null }), /env is missing/);
});

test('childEnv removes every CLAUDE_CODE_*, GIT_* and CLAUDECODE name, in any case, and keeps unrelated names', (t) => {
  const sb = sandboxFor(t);
  const set = {
    CLAUDE_CODE_SESSION_ID: 'a', CLAUDE_CODE_FUTURE_THING: 'b', Claude_Code_Mixed: 'c', CLAUDECODE: '1',
    GIT_DIR: 'x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_SSH_COMMAND: 'x', GIT_AUTHOR_NAME: 'x',
    LANE_PROJECT: 'live', COORDINATION_BREAK_GLASS: '1', COORDINATION_SESSION_ID: 's', CLAUDE_PROJECT_DIR: 'p',
    DRILL_KEEP_ME: 'kept',
  };
  const saved = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
  Object.assign(process.env, set);
  try {
    const env = childEnv(SCRATCH, sb);
    const left = Object.keys(env).filter((k) => /^(CLAUDE_CODE_|GIT_)/i.test(k) || k.toUpperCase() === 'CLAUDECODE');
    assert.deepEqual(left, ['GIT_CEILING_DIRECTORIES'], `names left in the child env: ${left}`);
    for (const k of ['LANE_PROJECT', 'COORDINATION_BREAK_GLASS', 'COORDINATION_SESSION_ID', 'CLAUDE_PROJECT_DIR']) assert.equal(env[k], undefined, k);
    assert.equal(env.DRILL_KEEP_ME, 'kept');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('childEnv sets GIT_CEILING_DIRECTORIES to the sandbox folder, and extra cannot move it', (t) => {
  const sb = sandboxFor(t);
  assert.equal(childEnv(SCRATCH, sb).GIT_CEILING_DIRECTORIES, sb.dir);
  assert.throws(() => childEnv(SCRATCH, sb, { GIT_CEILING_DIRECTORIES: '/' }), HarnessError);
});

test('runNode on a harness call that times out throws a HarnessError that carries the output so far', async (t) => {
  const { runNode } = await import('./lib.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-drill-2-libtest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'slow.mjs');
  fs.writeFileSync(script, "console.log('out lanes_pr1_aaaa1111'); console.error('err lanes_pr1_aaaa1111'); setTimeout(() => {}, 20000);\n");
  let caught;
  try { runNode(script, [], { env: { ...process.env }, harness: true, timeoutMs: 1500 }); } catch (e) { caught = e; }
  assert.ok(caught instanceof HarnessError, 'no HarnessError');
  assert.match(String(caught.out), /lanes_pr1_aaaa1111/);
  assert.match(String(caught.err), /lanes_pr1_aaaa1111/);
});

test('track keeps a claim as a project and file pair, and does not add it twice', async () => {
  const { track } = await import('./lib.mjs');
  const ctx = {};
  track(ctx, 'claim', { project: 'p', file: 'src/x.ts' });
  track(ctx, 'claim', { project: 'p', file: 'src/x.ts' });
  track(ctx, 'claim', { project: 'q', file: 'src/x.ts' });
  assert.deepEqual(ctx.tracked.claim, [{ project: 'p', file: 'src/x.ts' }, { project: 'q', file: 'src/x.ts' }]);
});
