// Tests for scripts/coordination/fleetops-auto-tick.mjs. Temp folders only: no ~/.claude, no database, no Docker.
// The export is a fake script (CCV3_FLEETOPS_EXPORT_CMD, array form) that records its argv and acts by FAKE_MODE.
// The dataset files and refresh.json are written by the test, because the fake export only stamps refresh.json.
//
// How the tick can fail, one test each below (and the source change that makes the test fail):
//   switch off      no auto-enabled file: the tick must not export, write state or lock    (drop the switch check)   [real CLI, exit 0]
//   tick lock       a fresh tick.lock stops the tick before the export                     (drop the lock check)
//   stale lock      a lock over 10 minutes old must not block for ever                     (drop the stale rule)
//   lock release    the tick lock is gone after a run, also after an error                 (no finally)
//   export exit 1   Docker down: skip, exit 0, no clear, pending stays true                (treat it as a failure)
//   export lock     "export lock is held" in the output: skip, exit 0, no clear            (ignore the text)
//   unchanged       same hash as the last upload: clear, then pending is false             (never clear)
//   key mismatch    the clear command exits 0 but changed nothing: pending stays true and the result says so
//                                                                                          (trust the exit code)
//   changed         a different hash: no clear call, pending stays true, lastHash stored   (clear anyway)
//   first run       no lastUploadedHash: leave pending                                     (clear on null)
//   missing file    a missing dataset file: error, exit 1, no clear                        (hash "undefined")
//   flow, factory   the tick never reads flow.json or factory.json and they never move the hash   (hash every file)
//   export args     the export gets --out <lane-dash dir> and the clear gets the refresh key       (drop --out)
//   record upload   --record-upload <dir> stores the hash of THAT folder, so the next tick clears
//   record refuse   a bare --record-upload, a copy whose exportedAt is not refresh.key, a missing copy file or no refresh.json: nothing stored
//   bad hash        recordUpload rejects a hash that is not 64 lowercase hex, and stores nothing   (drop the check)
//   race            a --record-upload that lands while the tick exports is not lost            (write the state read before the export)
//   corrupt state   an unparseable latest.json is renamed latest.json.corrupt-<ts> and logged, not silently dropped
//   dataset shape   a null, empty, array or row-less dataset file: error naming the file, exit 1
//   state           latest.json holds lastTickAt, lastExportKey, lastUploadedHash, lastHash, lastResult
//   log             a dated log is written, and dated logs over 14 days old are pruned
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentHash, recordUpload, runTick } from './fleetops-auto-tick.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TICK = join(HERE, 'fleetops-auto-tick.mjs');
const IDS = ['lanes', 'tiles', 'assignments', 'projects', 'targets', 'meta', 'snapshots'];
const KEY = '2026-11-09T14:59:00.000Z';

const FAKE_EXPORT = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + '\\n');
const mode = process.env.FAKE_MODE || 'ok';
const out = args[args.indexOf('--out') + 1];
const iClear = args.indexOf('--clear-refresh');
if (iClear >= 0) {
  if (mode === 'ignore-clear') { console.log('refresh doc: pending=true'); process.exit(0); }
  const f = join(out, 'refresh.json');
  const d = JSON.parse(readFileSync(f, 'utf8'));
  if (d.key === args[iClear + 1]) { d.pending = false; writeFileSync(f, JSON.stringify(d)); }
  process.exit(0);
}
if (mode === 'exit1') { console.error('export-dash-data: connect ECONNREFUSED'); process.exit(1); }
if (mode === 'lock') { console.error('export-dash-data: export lock is held: x'); process.exit(1); }
if (mode === 'lock0') { console.log('export lock is held: x'); process.exit(0); }
if (mode === 'bump') {
  const f = join(process.env.FAKE_STATE, 'latest.json');
  let cur = {};
  try { cur = JSON.parse(readFileSync(f, 'utf8')); } catch { /* none yet */ }
  writeFileSync(f, JSON.stringify({ ...cur, lastUploadedHash: process.env.FAKE_BUMP }));
}
writeFileSync(join(out, 'refresh.json'), JSON.stringify({ pending: true, key: process.env.FAKE_KEY || '${KEY}', cleared_at: null }));
process.exit(0);
`;

const doc = (rows = [], exportedAt = KEY) => ({ sql: 'x', exportedAt, rows });

/** A temp world: state dir, lane-dash dir with the 7 sets + flow + factory + refresh.json, log dir, fake export. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fleetops-auto-'));
  const fx = { root, state: join(root, 'state'), dash: join(root, 'dash'), logs: join(root, 'logs'), calls: join(root, 'calls.log'), fake: join(root, 'fake-export.mjs') };
  mkdirSync(fx.dash, { recursive: true });
  writeFileSync(fx.fake, FAKE_EXPORT);
  writeFileSync(fx.calls, '');
  for (const id of IDS) put(fx, `${id}.json`, doc([{ id, n: 1 }]));
  put(fx, 'flow.json', doc([{ flow: 1 }]));
  put(fx, 'factory.json', doc([{ factory: 1 }]));
  put(fx, 'refresh.json', { pending: true, key: KEY, cleared_at: null });
  return fx;
}
const put = (fx, name, obj) => writeFileSync(join(fx.dash, name), JSON.stringify(obj));
const readDash = (fx, name) => JSON.parse(readFileSync(join(fx.dash, name), 'utf8'));
const switchOn = (fx) => { mkdirSync(fx.state, { recursive: true }); writeFileSync(join(fx.state, 'auto-enabled'), 'on'); };
const envOf = (fx, extra = {}) => ({
  ...process.env,
  CCV3_FLEETOPS_AUTO_DIR: fx.state, CCV3_LANE_DASH_DIR: fx.dash, CCV3_FLEETOPS_AUTO_LOG_DIR: fx.logs,
  CCV3_FLEETOPS_EXPORT_CMD: JSON.stringify([process.execPath, fx.fake]), FAKE_CALLS: fx.calls, FAKE_MODE: 'ok', ...extra,
});
const calls = (fx) => readFileSync(fx.calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const clears = (fx) => calls(fx).filter((a) => a.includes('--clear-refresh'));
const state = (fx) => JSON.parse(readFileSync(join(fx.state, 'latest.json'), 'utf8'));
const NOW = new Date('2026-11-09T15:00:00Z');
const tick = (fx, extra = {}, deps = {}) => runTick({ env: envOf(fx, extra), now: () => NOW, ...deps });
/** Make the data "already uploaded": store the hash of the files now. */
const uploaded = (fx) => recordUpload(currentHash({ env: envOf(fx) }), { env: envOf(fx), now: () => NOW });

// ---------------------------------------------------------------- no-op exits

test('switch off: the real CLI exits 0 and does nothing (no export, no state, no lock)', () => {
  const fx = fixture();
  const r = spawnSync(process.execPath, [TICK], { env: envOf(fx), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls(fx).length, 0, 'the export must not run');
  assert.ok(!existsSync(join(fx.state, 'latest.json')), 'no state write');
  assert.ok(!existsSync(join(fx.state, 'tick.lock')), 'no lock');
  assert.equal(readDash(fx, 'refresh.json').pending, true);
});

test('switch off: runTick returns a skip result', async () => {
  const fx = fixture();
  const r = await tick(fx);
  assert.equal(r.code, 0);
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /switch/i);
});

test('tick lock held and fresh: skip, no export', async () => {
  const fx = fixture();
  switchOn(fx);
  writeFileSync(join(fx.state, 'tick.lock'), JSON.stringify({ pid: 999999, ts: NOW.toISOString() }));
  const r = await tick(fx);
  assert.equal(r.code, 0);
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /lock/i);
  assert.equal(calls(fx).length, 0);
});

test('stale tick lock (11 minutes old) is taken over and the tick runs', async () => {
  const fx = fixture();
  switchOn(fx);
  const old = new Date(NOW.getTime() - 11 * 60_000);
  const lock = join(fx.state, 'tick.lock');
  writeFileSync(lock, JSON.stringify({ pid: 999999, ts: old.toISOString() }));
  utimesSync(lock, old, old);
  const r = await tick(fx);
  assert.equal(r.code, 0);
  assert.ok(!/lock/i.test(r.reason ?? ''), r.reason);
  assert.ok(calls(fx).length >= 1, 'the export must run');
});

test('the tick lock is released after a normal run and after an error', async () => {
  const fx = fixture();
  switchOn(fx);
  await tick(fx);
  assert.ok(!existsSync(join(fx.state, 'tick.lock')), 'released after a run');
  writeFileSync(join(fx.dash, 'tiles.json'), '{ not json');
  const r = await tick(fx);
  assert.equal(r.code, 1);
  assert.ok(!existsSync(join(fx.state, 'tick.lock')), 'released after an error');
});

test('export exit 1 (Docker down): skip, exit 0, no clear, pending stays true', async () => {
  const fx = fixture();
  switchOn(fx);
  uploaded(fx);
  const r = await tick(fx, { FAKE_MODE: 'exit1' });
  assert.equal(r.code, 0);
  assert.equal(r.action, 'skip');
  assert.equal(clears(fx).length, 0);
  assert.equal(readDash(fx, 'refresh.json').pending, true);
});

test('"export lock is held" in the output (exit 1 or exit 0): skip, exit 0, no clear', async () => {
  for (const mode of ['lock', 'lock0']) {
    const fx = fixture();
    switchOn(fx);
    uploaded(fx);
    const r = await tick(fx, { FAKE_MODE: mode });
    assert.equal(r.code, 0, mode);
    assert.equal(r.action, 'skip', mode);
    assert.match(r.reason, /export lock/i, mode);
    assert.equal(clears(fx).length, 0, mode);
  }
});

// ---------------------------------------------------------------- the gate

test('unchanged data: the tick clears, and pending is false after the re-read', async () => {
  const fx = fixture();
  switchOn(fx);
  uploaded(fx);
  const r = await tick(fx);
  assert.equal(r.code, 0);
  assert.equal(r.action, 'clear');
  assert.deepEqual(clears(fx).map((a) => a[a.indexOf('--clear-refresh') + 1]), [KEY]);
  assert.equal(readDash(fx, 'refresh.json').pending, false);
  assert.equal(state(fx).lastResult, 'cleared');
});

test('clear with a key mismatch (command exits 0, nothing changed): pending stays true and the result says so', async () => {
  const fx = fixture();
  switchOn(fx);
  uploaded(fx);
  const r = await tick(fx, { FAKE_MODE: 'ignore-clear' });
  assert.equal(r.code, 0, 'a mismatch is not a failure: the next tick tries again');
  assert.equal(clears(fx).length, 1);
  assert.equal(readDash(fx, 'refresh.json').pending, true);
  assert.equal(state(fx).lastResult, 'clear-mismatch');
});

test('changed data: no clear, pending stays true, lastHash is stored, lastUploadedHash is not', async () => {
  const fx = fixture();
  switchOn(fx);
  uploaded(fx);
  const before = state(fx).lastUploadedHash;
  put(fx, 'lanes.json', doc([{ id: 'lanes', n: 2 }]));
  const r = await tick(fx);
  assert.equal(r.action, 'leave-pending');
  assert.equal(clears(fx).length, 0);
  assert.equal(readDash(fx, 'refresh.json').pending, true);
  const s = state(fx);
  assert.equal(s.lastUploadedHash, before);
  assert.notEqual(s.lastHash, before);
  assert.equal(s.lastResult, 'changed-pending');
});

test('a new exportedAt alone (masked field) still clears', async () => {
  const fx = fixture();
  switchOn(fx);
  uploaded(fx);
  for (const id of IDS) put(fx, `${id}.json`, doc([{ id, n: 1 }], '2026-11-09T15:30:00.000Z'));
  const r = await tick(fx, { FAKE_KEY: '2026-11-09T15:30:00.000Z' });
  assert.equal(r.action, 'clear');
  assert.equal(readDash(fx, 'refresh.json').pending, false);
});

test('first run, no lastUploadedHash: leave pending, no clear', async () => {
  const fx = fixture();
  switchOn(fx);
  const r = await tick(fx);
  assert.equal(r.action, 'leave-pending');
  assert.equal(clears(fx).length, 0);
  assert.equal(readDash(fx, 'refresh.json').pending, true);
});

test('a missing dataset file: exit 1, an error result naming the file, no clear', async () => {
  const fx = fixture();
  switchOn(fx);
  uploaded(fx);
  rmSync(join(fx.dash, 'targets.json'));
  const r = await tick(fx);
  assert.equal(r.code, 1);
  assert.match(r.reason, /targets\.json/);
  assert.equal(clears(fx).length, 0);
  assert.match(state(fx).lastResult, /^error/);
});

test('flow.json and factory.json are never read, and changing them does not change the hash', async () => {
  const fx = fixture();
  switchOn(fx);
  const reads = [];
  const readFile = (p, ...rest) => { reads.push(String(p)); return readFileSync(p, ...rest); };
  await tick(fx, {}, { readFile });
  assert.ok(reads.length >= 8, `the tick must read the 7 sets and refresh.json, read ${reads.length}`);
  assert.ok(!reads.some((p) => /(flow|factory)\.json$/.test(p)), reads.join('\n'));
  const h1 = state(fx).lastHash;
  put(fx, 'flow.json', doc([{ flow: 99 }]));
  put(fx, 'factory.json', doc([{ factory: 99 }]));
  await tick(fx);
  assert.equal(state(fx).lastHash, h1);
});

test('the export runs with --out <lane-dash dir>', async () => {
  const fx = fixture();
  switchOn(fx);
  await tick(fx);
  const a = calls(fx)[0];
  assert.equal(a[a.indexOf('--out') + 1], fx.dash);
  assert.ok(!a.includes('--clear-refresh'));
});

// ---------------------------------------------------------------- record upload, state, log

test('recordUpload stores the hash: the next tick on the same data clears', async () => {
  const fx = fixture();
  switchOn(fx);
  assert.equal((await tick(fx)).action, 'leave-pending');
  const h = currentHash({ env: envOf(fx) });
  recordUpload(h, { env: envOf(fx), now: () => NOW });
  assert.equal(state(fx).lastUploadedHash, h);
  assert.equal((await tick(fx)).action, 'clear');
});

/** A folder like the skill's scratchpad copy: the 7 sets from the lane-dash folder. `over` = {id: doc} replaces a file; null removes it. */
function copyDir(fx, over = {}) {
  const dir = mkdtempSync(join(fx.root, 'copy-'));
  for (const id of IDS) {
    if (over[id] === null) continue;
    if (over[id]) writeFileSync(join(dir, `${id}.json`), JSON.stringify(over[id]));
    else copyFileSync(join(fx.dash, `${id}.json`), join(dir, `${id}.json`));
  }
  return dir;
}
const cli = (fx, args, extra = {}) => spawnSync(process.execPath, [TICK, ...args], { env: envOf(fx, extra), encoding: 'utf8', windowsHide: true, timeout: 60000 });
const stored = (fx) => { try { return state(fx).lastUploadedHash; } catch { return undefined; } };

test('--record-upload <dir> stores the hash of THAT folder, not of the lane-dash folder, even with the switch off', () => {
  const fx = fixture();
  const dir = copyDir(fx, { lanes: doc([{ id: 'lanes', n: 2 }]) }); // the copy differs from the live files: a newer export would too
  const r = cli(fx, ['--record-upload', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stored(fx), currentHash({ env: envOf(fx), dir }));
  assert.notEqual(stored(fx), currentHash({ env: envOf(fx) }));
  assert.equal(calls(fx).length, 0, 'it must not run the export');
});

test('--record-upload <dir>: the next tick clears when the live files equal the copy', async () => {
  const fx = fixture();
  switchOn(fx);
  assert.equal(cli(fx, ['--record-upload', copyDir(fx)]).status, 0);
  assert.equal((await tick(fx)).action, 'clear');
});

test('--record-upload with no folder is refused and stores nothing', () => {
  const fx = fixture();
  const r = cli(fx, ['--record-upload']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /folder|<dir>/i);
  assert.equal(stored(fx), undefined);
});

test('--record-upload refuses a copy whose exportedAt is not refresh.key (a newer export ran), naming the file', () => {
  const fx = fixture();
  const r = cli(fx, ['--record-upload', copyDir(fx, { tiles: doc([{ id: 'tiles', n: 1 }], '2026-11-09T15:30:00.000Z') })]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /tiles\.json/);
  assert.equal(stored(fx), undefined);
});

test('--record-upload refuses a copy with a missing file, an unreadable folder, or no refresh.json', () => {
  const fx = fixture();
  assert.notEqual(cli(fx, ['--record-upload', copyDir(fx, { targets: null })]).status, 0);
  assert.notEqual(cli(fx, ['--record-upload', join(fx.root, 'no-such-folder')]).status, 0);
  rmSync(join(fx.dash, 'refresh.json'));
  const r = cli(fx, ['--record-upload', copyDir(fx)]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refresh/i);
  assert.equal(stored(fx), undefined);
});

test('--record-upload never opens flow.json or factory.json in the copy', () => {
  const fx = fixture();
  const dir = copyDir(fx);
  writeFileSync(join(dir, 'flow.json'), '{ not json');
  writeFileSync(join(dir, 'factory.json'), '{ not json');
  assert.equal(cli(fx, ['--record-upload', dir]).status, 0);
  assert.ok(readdirSync(dir).includes('flow.json'));
});

test('recordUpload keeps the other fields of latest.json', () => {
  const fx = fixture();
  mkdirSync(fx.state, { recursive: true });
  writeFileSync(join(fx.state, 'latest.json'), JSON.stringify({ lastResult: 'cleared', lastExportKey: KEY }));
  recordUpload('ab'.repeat(32), { env: envOf(fx), now: () => NOW });
  const s = state(fx);
  assert.equal(s.lastUploadedHash, 'ab'.repeat(32));
  assert.equal(s.lastResult, 'cleared');
  assert.equal(s.lastExportKey, KEY);
});

test('latest.json holds lastTickAt, lastExportKey, lastUploadedHash, lastHash, lastResult', async () => {
  const fx = fixture();
  switchOn(fx);
  uploaded(fx);
  await tick(fx);
  const s = state(fx);
  assert.equal(s.lastTickAt, NOW.toISOString());
  assert.equal(s.lastExportKey, KEY);
  assert.match(s.lastUploadedHash, /^[0-9a-f]{64}$/);
  assert.equal(s.lastHash, s.lastUploadedHash);
  assert.equal(s.lastResult, 'cleared');
});

test('a dated log is written and dated logs over 14 days old are pruned', async () => {
  const fx = fixture();
  switchOn(fx);
  mkdirSync(fx.logs, { recursive: true });
  const oldLog = join(fx.logs, '2026-10-01.log');
  const newLog = join(fx.logs, '2026-11-05.log');
  const other = join(fx.logs, 'notes.txt');
  for (const f of [oldLog, newLog, other]) writeFileSync(f, 'x');
  const ago = (d) => new Date(Date.now() - d * 86_400_000);
  utimesSync(oldLog, ago(40), ago(40)); utimesSync(newLog, ago(2), ago(2)); utimesSync(other, ago(40), ago(40));
  await tick(fx);
  const today = join(fx.logs, '2026-11-09.log');
  assert.ok(existsSync(today), 'dated log for the tick day');
  assert.match(readFileSync(today, 'utf8'), /leave-pending|changed/i);
  assert.ok(!existsSync(oldLog));
  assert.ok(existsSync(newLog));
  assert.ok(existsSync(other));
});

// ---------------------------------------------------------------- bad hash, race, corrupt state, dataset shape

test('recordUpload rejects a hash that is not 64 lowercase hex and stores nothing', () => {
  const fx = fixture();
  for (const bad of ['abc', '', null, undefined, 'g'.repeat(64), 'AB'.repeat(32), 'ab'.repeat(33), 5]) {
    assert.throws(() => recordUpload(bad, { env: envOf(fx), now: () => NOW }), /sha256|hash/i, String(bad));
  }
  assert.equal(stored(fx), undefined);
});

test('a recordUpload that lands while the tick runs its export is not lost', async () => {
  const fx = fixture();
  switchOn(fx);
  const bump = 'cd'.repeat(32);
  const r = await tick(fx, { FAKE_MODE: 'bump', FAKE_STATE: fx.state, FAKE_BUMP: bump });
  assert.equal(r.code, 0);
  assert.equal(state(fx).lastUploadedHash, bump, 'the tick must re-read latest.json before it writes');
  assert.equal(state(fx).lastResult, 'changed-pending');
});

test('an unparseable latest.json is renamed to latest.json.corrupt-<time> and logged, and the tick still runs', async () => {
  const fx = fixture();
  switchOn(fx);
  writeFileSync(join(fx.state, 'latest.json'), '{"lastUploadedHash": "ab');
  const r = await tick(fx);
  assert.equal(r.code, 0);
  const moved = readdirSync(fx.state).filter((n) => /^latest\.json\.corrupt-/.test(n));
  assert.equal(moved.length, 1, readdirSync(fx.state).join(','));
  assert.equal(readFileSync(join(fx.state, moved[0]), 'utf8'), '{"lastUploadedHash": "ab');
  assert.match(readFileSync(join(fx.logs, '2026-11-09.log'), 'utf8'), /corrupt/i);
  assert.equal(state(fx).lastResult, 'changed-pending');
});

test('a dataset file that is null, empty, an array, a number or has no rows: exit 1, the error names the file, no clear', async () => {
  const bad = { null: 'null', empty: '', array: '[]', number: '5', 'no rows': '{"exportedAt":"K"}', 'no exportedAt': '{"rows":[]}',
    'exportedAt not a string': '{"exportedAt":5,"rows":[]}', 'rows not an array': '{"exportedAt":"K","rows":{}}' };
  for (const [label, text] of Object.entries(bad)) {
    const fx = fixture();
    switchOn(fx);
    uploaded(fx);
    writeFileSync(join(fx.dash, 'meta.json'), text);
    const r = await tick(fx);
    assert.equal(r.code, 1, label);
    assert.match(r.reason, /meta\.json/, label);
    assert.doesNotMatch(r.reason, /is missing/, label);
    assert.equal(clears(fx).length, 0, label);
  }
});
