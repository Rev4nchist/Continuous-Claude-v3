// Isolated tests for scripts/coordination/reminder-tick.mjs. No database, no clock, no toast, no ~/.claude:
// the db is a scripted fake, the clock and the folders are injected. The database race and the real lane.mjs
// run in reminder-tick-probe.mjs (needs Postgres).
//
// How the tick can fail, one test each below (and the source change that makes the test fail):
//   lock held       a fresh tick.lock must stop the tick before it touches the db      (drop the lock check)
//   lock stale      a lock over 10 minutes old must not block for ever                 (remove the stale rule)
//   lock release    release must not delete a lock another tick took over              (remove the pid check)
//   F3 rollback     an event INSERT error must ROLLBACK the fire, never COMMIT        (COMMIT before the events)
//   events          one broadcast-style event per fired row, on the row's own board   (use a default board)
//   toast gate      P2 never toasts; P0 and P1 do, in ONE toast                       (drop the band filter)
//   toast text      overdue label past 60 min, control characters stripped, 140 chars  (drop sanitise)
//   F17 toast fail  a throwing toast must not change the result or the heartbeat       (drop the try/catch)
//   seam            syncBatch gets the unsynced rows; --no-sync skips it               (call it with no rows)
//   heartbeat       latest.json holds ranAt, fired, unsynced, lastSyncOk, lastError    (drop a field)
//   dry run         --dry-run writes nothing: no BEGIN, no lock, no latest.json        (run the fire path)
//   sync switch     no sync-enabled file: the seam is never called, latest.json says syncEnabled false   (drop the file check)
//   sync verb       remind sync on|off|status makes, removes and reports the file, with no database      (touch the db)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, readState, runTick, syncSwitch, toastText } from './reminder-tick.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'rtick-'));
const syncOn = (dir) => { writeFileSync(join(dir, 'sync-enabled'), 'on'); return dir; }; // the sync switch: the file exists
const NOW = new Date('2026-11-07T15:00:00Z');
const fired = (over = {}) => ({
  id: 'r1', title: 'Re-run harness doctor', project_key: 'board-a', band: 'P1',
  due_at: new Date('2026-11-07T14:58:00Z'), fired_at: NOW, action_id: null, late_min: 2, ...over,
});

/** A scripted db. `firedRows` answers the fire UPDATE; `unsynced` the unsynced SELECT; `failOn` throws on a statement. */
function fakeDb({ firedRows = [], unsynced = [], failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      const sql = String(text).trim();
      calls.push({ sql, params });
      if (failOn && failOn.test(sql)) throw Object.assign(new Error('boom'), { code: 'XX000' });
      if (/notion_page_id IS NULL/.test(sql)) return { rows: unsynced };
      if (/remind_state\s*=\s*'scheduled'/.test(sql)) return { rows: firedRows }; // the fire UPDATE, or the dry-run SELECT
      return { rows: [] };
    },
    verbs: () => calls.map((c) => c.sql.split(/\s+/)[0]),
  };
}

const base = (over = {}) => ({
  now: () => NOW, stateDir: tmp(), toast: () => ({ ok: true }), log: () => {}, ...over,
});

test('a fresh tick.lock stops the tick before it touches the db', async () => {
  const dir = tmp();
  const first = acquireLock(dir, NOW);
  assert.equal(first.ok, true);
  const db = fakeDb({ firedRows: [fired()] });
  const r = await runTick(base({ db, stateDir: dir }));
  assert.equal(r.locked, true);
  assert.equal(db.calls.length, 0);
  first.release();
});

test('a lock over 10 minutes old is taken over, and a fresh one is not', () => {
  const dir = tmp();
  const a = acquireLock(dir, new Date(NOW.getTime() - 11 * 60_000));
  assert.equal(a.ok, true);
  assert.equal(acquireLock(dir, new Date(NOW.getTime() - 9 * 60_000)).ok, false, '9 minutes old is still fresh');
  assert.equal(acquireLock(dir, NOW).ok, true, 'a lock 11 minutes old must be replaced');
  assert.equal(acquireLock(dir, NOW).ok, false, 'the new lock is fresh');
});

test('F6: two ticks that both saw the same stale lock: the second one finds the lock fresh and does NOT take it', () => {
  const dir = tmp();
  const stale = new Date(NOW.getTime() - 11 * 60_000);
  assert.equal(acquireLock(dir, stale).ok, true); // the crashed tick left this behind
  const winner = [];
  // Tick B has read the stale time. Before it takes over, tick A finishes its whole takeover.
  const b = acquireLock(dir, NOW, undefined, { beforeTakeover: () => winner.push(acquireLock(dir, NOW)) });
  assert.equal(winner[0].ok, true, 'tick A took the stale lock');
  assert.equal(b.ok, false, 'tick B must see the fresh lock and stop');
  assert.equal(JSON.parse(readFileSync(join(dir, 'tick.lock'), 'utf8')).ts, NOW.toISOString(), 'A lock is still in place');
});

test('F6: while another tick holds the takeover guard, a stale lock is left alone; a guard older than 2 minutes is dead and does not block', () => {
  const dir = tmp();
  const stale = new Date(NOW.getTime() - 11 * 60_000);
  acquireLock(dir, stale);
  writeFileSync(join(dir, 'tick.lock.takeover'), JSON.stringify({ pid: 1, ts: NOW.toISOString() }));
  assert.equal(acquireLock(dir, NOW).ok, false, 'a fresh guard means another tick is replacing the lock');
  assert.ok(existsSync(join(dir, 'tick.lock')));
  writeFileSync(join(dir, 'tick.lock.takeover'), JSON.stringify({ pid: 1, ts: new Date(NOW.getTime() - 3 * 60_000).toISOString() }));
  assert.equal(acquireLock(dir, NOW).ok, true, 'a dead guard is replaced');
  assert.ok(!existsSync(join(dir, 'tick.lock.takeover')), 'the guard is removed after the takeover');
});

test('release removes only a lock that still holds our pid', () => {
  const dir = tmp();
  const a = acquireLock(dir, NOW);
  writeFileSync(join(dir, 'tick.lock'), JSON.stringify({ pid: 999999999, ts: NOW.toISOString() }));
  a.release();
  assert.ok(existsSync(join(dir, 'tick.lock')), 'another tick took the lock over: leave it');
});

test('F3: an event INSERT error rolls the fire back and never commits', async () => {
  const db = fakeDb({ firedRows: [fired()], failOn: /^INSERT INTO agentic_os\.lane_event/ });
  await assert.rejects(runTick(base({ db })), /boom/);
  const verbs = db.verbs();
  assert.ok(verbs.includes('ROLLBACK'), verbs.join(','));
  assert.ok(!verbs.includes('COMMIT'), verbs.join(','));
});

test('one reminder event per fired row, on the row own board, from session reminder-tick', async () => {
  const rows = [fired(), fired({ id: 'r2', project_key: 'board-b', band: 'P0', late_min: 125 })];
  const db = fakeDb({ firedRows: rows });
  await runTick(base({ db }));
  const ev = db.calls.filter((c) => /^INSERT INTO agentic_os\.lane_event/.test(c.sql));
  assert.equal(ev.length, 2);
  const joined = ev.map((c) => JSON.stringify(c.params));
  assert.ok(joined[0].includes('"board-a"') && joined[0].includes('"r1"') && joined[0].includes('reminder-tick'), joined[0]);
  assert.ok(joined[1].includes('"board-b"'), joined[1]);
  assert.match(joined[1], /OVERDUE 2h/);
  assert.match(joined[0], /\\"op\\":\\"fire\\".*\\"via\\":\\"tick\\"/);
  assert.deepEqual(db.verbs().slice(0, 1), ['BEGIN']);
  assert.equal(db.verbs().at(db.verbs().indexOf('COMMIT') - 1), 'INSERT');
});

test('toast: P2 alone never toasts; P0 and P1 give ONE toast with a count', () => {
  assert.equal(toastText([fired({ band: 'P2' })]), null);
  const t = toastText([fired(), fired({ id: 'r2', band: 'P0' }), fired({ id: 'r3', band: 'P2' })]);
  assert.equal(t.title, 'CCv3 reminders: 2 due');
  assert.match(t.message, /P0 r2/);
  assert.doesNotMatch(t.message, /r3/);
});

test('toast text: OVERDUE label past 60 min, control characters stripped, 140 characters at most', () => {
  const late = toastText([fired({ late_min: 125, due_at: new Date(NOW.getTime() - 125 * 60_000) })]);
  assert.match(late.message, /OVERDUE 2h/);
  const onTime = toastText([fired({ late_min: 60 })]);
  assert.doesNotMatch(onTime.message, /OVERDUE/);
  const nasty = toastText([fired({ title: 'a\u0007b\nc' + 'x'.repeat(300) })]);
  assert.doesNotMatch(nasty.message, /[\u0000-\u001f]/);
  assert.ok(nasty.message.length <= 140);
  const many = toastText(Array.from({ length: 6 }, (_, i) => fired({ id: `m${i}` })));
  assert.equal((many.message.match(/P1 m/g) || []).length, 3);
});

test('F17: a throwing toast changes nothing: the event is written and the heartbeat is stored', async () => {
  const db = fakeDb({ firedRows: [fired()] });
  const stateDir = tmp();
  const r = await runTick(base({ db, stateDir, toast: () => { throw new Error('no desktop'); } }));
  assert.equal(r.fired.length, 1);
  assert.equal(r.toasted, false);
  assert.equal(readState(stateDir).fired, 1);
});

test('toast is not called when only a P2 fired, and not when nothing fired', async () => {
  let calls = 0;
  const toast = () => { calls++; return { ok: true }; };
  await runTick(base({ db: fakeDb({ firedRows: [fired({ band: 'P2' })] }), toast }));
  await runTick(base({ db: fakeDb(), toast }));
  assert.equal(calls, 0);
});

test('seam: syncBatch gets the unsynced rows; --no-sync does not call it; the idle tick writes the heartbeat', async () => {
  const seen = [];
  const syncBatch = async (rows) => { seen.push(rows); return { skipped: true }; };
  const unsynced = [{ id: 'u1', project_key: 'board-a', total: 3 }];
  const stateDir = syncOn(tmp());
  const r = await runTick(base({ db: fakeDb({ unsynced }), stateDir, syncBatch }));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].map((x) => x.id), ['u1']);
  assert.equal(r.sync.status, 'skipped');
  assert.equal(readState(stateDir).unsynced, 3);
  await runTick(base({ db: fakeDb({ unsynced }), syncBatch, stateDir, noSync: true }));
  assert.equal(seen.length, 1, '--no-sync must not call the seam');
  const recent = syncOn(tmp());
  writeFileSync(join(recent, 'latest.json'), JSON.stringify({ lastDonePollAt: new Date(NOW.getTime() - 60_000).toISOString() }));
  await runTick(base({ db: fakeDb(), syncBatch, stateDir: recent }));
  assert.equal(seen.length, 1, 'nothing unsynced and the Done-poll ran a minute ago: no call');
  await runTick(base({ db: fakeDb(), syncBatch, stateDir: syncOn(tmp()) }));
  assert.equal(seen.length, 2, 'nothing unsynced but the Done-poll never ran: the sync is asked (it decides whether to start claude)');
});

test('sync switch: with no sync-enabled file the seam is never called, even with unsynced rows and a due poll; the tick still fires', async () => {
  let calls = 0;
  const syncBatch = async () => { calls++; return { ok: true }; };
  const stateDir = tmp();
  const db = fakeDb({ firedRows: [fired()], unsynced: [{ id: 'u1', project_key: 'board-a', total: 3 }] });
  const r = await runTick(base({ db, stateDir, syncBatch }));
  assert.equal(calls, 0);
  assert.equal(r.fired.length, 1, 'the reminder still fires');
  assert.equal(r.sync.status, 'off');
  const s = readState(stateDir);
  assert.equal(s.syncEnabled, false);
  assert.equal(s.fired, 1);
  assert.equal(s.unsynced, 3, 'the count is still recorded');
  assert.ok(db.verbs().includes('COMMIT'));
});

test('sync switch: with the file present the seam is called and latest.json says syncEnabled true', async () => {
  let calls = 0;
  const syncBatch = async () => { calls++; return { ok: true }; };
  const stateDir = syncOn(tmp());
  await runTick(base({ db: fakeDb({ unsynced: [{ id: 'u1', project_key: 'board-a', total: 1 }] }), stateDir, syncBatch }));
  assert.equal(calls, 1);
  assert.equal(readState(stateDir).syncEnabled, true);
});

const LANE = join(dirname(fileURLToPath(import.meta.url)), 'lane.mjs');
// A database URL that cannot connect: the verb must not need one.
const BAD_DB = 'postgresql://x:y@127.0.0.1:1/none';
const verb = (dir, sub) => spawnSync(process.execPath, [LANE, 'remind', 'sync', ...(sub ? [sub] : [])], {
  encoding: 'utf8', timeout: 30_000, env: { ...process.env, CCV3_REMINDER_STATE_DIR: dir, DATABASE_URL: BAD_DB, CONTINUOUS_CLAUDE_DB_URL: BAD_DB, OPC_POSTGRES_URL: BAD_DB },
});

test('sync verb: status, on, on again, off, off again round trip on the state folder only, with no database', () => {
  const dir = tmp();
  const file = join(dir, 'sync-enabled');
  const say = (r) => (r.stdout + r.stderr).trim();
  let r = verb(dir, 'status');
  assert.equal(r.status, 0, say(r));
  assert.match(r.stdout, /sync off/);
  assert.ok(!existsSync(file));
  r = verb(dir, 'on');
  assert.equal(r.status, 0, say(r));
  assert.match(r.stdout, /sync on/);
  assert.ok(existsSync(file));
  assert.match(verb(dir, 'status').stdout, /sync on/);
  assert.equal(verb(dir, 'on').status, 0, 'on twice is fine');
  r = verb(dir, 'off');
  assert.equal(r.status, 0, say(r));
  assert.match(r.stdout, /sync off/);
  assert.ok(!existsSync(file));
  assert.equal(verb(dir, 'off').status, 0, 'off twice is fine');
  assert.match(verb(dir, 'status').stdout, /sync off/);
});

test('sync verb: an unknown or missing argument exits 1 and names the choices; syncSwitch rejects it too', () => {
  const dir = tmp();
  for (const sub of ['maybe', undefined]) {
    const r = verb(dir, sub);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /on\|off\|status/);
  }
  assert.throws(() => syncSwitch(dir, 'maybe'), /on\|off\|status/);
});

test('the heartbeat holds ranAt, fired, unsynced, lastSyncOk and lastError, and keeps keys part B adds', async () => {
  const stateDir = tmp();
  writeFileSync(join(stateDir, 'latest.json'), JSON.stringify({ failCount: 2, nextSyncAt: 'x' }));
  await runTick(base({ db: fakeDb({ firedRows: [fired()] }), stateDir }));
  const s = readState(stateDir);
  assert.equal(s.ranAt, NOW.toISOString());
  assert.equal(s.fired, 1);
  assert.equal(s.unsynced, 0);
  assert.ok('lastSyncOk' in s && 'lastError' in s);
  assert.equal(s.failCount, 2);
});

test('--dry-run lists what would fire and writes nothing: no transaction, no lock, no heartbeat', async () => {
  const dir = tmp();
  const db = fakeDb({ firedRows: [fired()] });
  const lines = [];
  await runTick(base({ db, stateDir: dir, dryRun: true, log: (l) => lines.push(l) }));
  assert.ok(!db.verbs().includes('BEGIN') && !db.verbs().includes('UPDATE'), db.verbs().join(','));
  assert.ok(!existsSync(join(dir, 'tick.lock')) && !existsSync(join(dir, 'latest.json')));
  assert.ok(lines.join('\n').includes('r1'));
});

test('readState gives {} for a missing or broken latest.json', () => {
  const dir = tmp();
  assert.deepEqual(readState(dir), {});
  writeFileSync(join(dir, 'latest.json'), '{broken');
  assert.deepEqual(readState(dir), {});
  assert.equal(readFileSync(join(dir, 'latest.json'), 'utf8'), '{broken');
});
