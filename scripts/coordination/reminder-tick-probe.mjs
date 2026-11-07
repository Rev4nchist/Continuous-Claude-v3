#!/usr/bin/env node
/**
 * reminder-tick-probe -- the end-to-end gate for `lane.mjs remind tick` (lane reminders, phase 5, part A).
 *
 * Runs the REAL scripts/coordination/lane.mjs of THIS checkout as a child process against SCRATCH databases
 * (lanes_pr1_*, migrations through 5, and one through 4) that this probe creates and drops. It never touches the
 * live database, the live Notion, Task Scheduler or the real ~/.claude: every child gets its own
 * CCV3_REMINDER_STATE_DIR and the toast runs with -DryRun, so it prints a line and shows nothing.
 *
 *   node scripts/coordination/reminder-tick-probe.mjs
 *
 * The transcript goes to .claude/cache/e2e/2026-11-07-pr-e-tick-probe.txt, or to REMINDER_TICK_PROBE_OUT.
 * Exit 0: all checks pass. Exit 1: a check failed. Exit 2: pg is missing.
 * Design: .claudedocs/2026-11-06-lane-reminders-design.md, "Trigger and run".
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl, maskUrl } from './scratch-db.mjs';
import { laneEnv, makeBoards } from './probe-boards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LANE = join(HERE, 'lane.mjs');
const SCRATCH = join(HERE, 'scratch-db.mjs');
const TOAST = join(REPO, '.claude', 'scripts', 'scheduled', 'reminder-toast.ps1');
const OUT = process.env.REMINDER_TICK_PROBE_OUT || join(REPO, '.claude', 'cache', 'e2e', '2026-11-07-pr-e-tick-probe.txt');

let Client;
try {
  ({ Client } = requireDep('pg', { repoRoot: REPO }));
} catch (e) {
  console.error(`reminder-tick-probe: the pg package is not available (${e.message}). Set NODE_PATH to a folder that holds pg.`);
  process.exit(2);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, '');

const log = (s = '') => { const t = String(s).replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/g, '$1***@'); appendFileSync(OUT, t + '\n'); console.log(t); };
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };
const scratch = (...args) => spawnSync(process.execPath, [SCRATCH, ...args], { encoding: 'utf8' });
const minutes = (m) => new Date(Date.now() + m * 60_000).toISOString();
const noStack = (s) => !/\n\s+at \S/.test(s) && !/Error:/.test(s);

// The stub claude. It reads the prompt on stdin, records argv/env/prompt, and prints one result line in the shape of
// `claude -p --output-format json`. STUB_MODE: ok (every lane count 1), dup (count 2), done (ok + every polled lane is Done), bad (not JSON).
const STUB_SOURCE = `import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const mode = process.env.STUB_MODE || 'ok';
  const m = /<<<DATA_BEGIN>>>\\n([\\s\\S]*?)\\n<<<DATA_END>>>/.exec(input);
  const payload = m ? JSON.parse(m[1]) : { upserts: [], poll: [] };
  appendFileSync(process.env.STUB_DUMP, JSON.stringify({
    argv: process.argv.slice(2), ci: process.env.CI ?? null, notion: process.env.NOTION_API_TOKEN ?? null, skip: process.env.SKIP_PACKAGE_GUARD ?? null,
    anthropic: process.env.ANTHROPIC_API_KEY ?? null, upserts: payload.upserts.map((u) => u.laneId), poll: payload.poll.map((p) => p.laneId), mode,
    items: payload.upserts.map((u) => ({ laneId: u.laneId, status: u.setStatus ?? null, task: u.properties.Task })),
  }) + '\\n');
  if (mode === 'bad') { console.log('I could not reach Notion.'); return; }
  const id = (k) => { const h = createHash('sha1').update(k).digest('hex'); return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-'); };
  const results = Object.fromEntries(payload.upserts.map((u) => [u.laneId, mode === 'dup' ? { count: 2, pageId: null } : { count: 1, pageId: id(u.laneId) }]));
  const doneIds = mode === 'done' ? payload.poll.map((p) => p.laneId) : [];
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ results, doneIds }) }));
});
`;

let boards = null; let urlA = null; let urlOld = null; let db = null;
try {
  log('# lane remind tick: scratch database probe, 2026-11-07');
  log('# Live database, live Notion, Task Scheduler: NOT touched. Real lane.mjs of this checkout, scratch URL below.');
  const created = scratch('create', '--through', '5');
  if (created.status !== 0) throw new Error(`scratch create failed: ${created.stderr}`);
  urlA = JSON.parse(created.stdout).url;
  assertScratchUrl(urlA);
  log(`scratch database: ${maskUrl(urlA)}`);
  boards = makeBoards('zz-tkprobe', ['a', 'b']);
  const A = boards.boards.a; const B = boards.boards.b;
  const neutral = mkdtempSync(join(tmpdir(), 'tkprobe-cwd-')); // a folder that resolves to no board: the tick is cross-board
  db = new Client({ connectionString: urlA });
  await db.connect();
  await db.query(`SELECT set_config('lane.client_version', '2', false)`);

  // The Notion sync never starts the real claude here: CCV3_REMINDER_CLAUDE points at a stub that records what it was given
  // and answers from STUB_MODE. The headless ledger is a temp file, so the live ledger and its daily cap stay untouched.
  const stubDir = mkdtempSync(join(tmpdir(), 'tkprobe-stub-'));
  const STUB = join(stubDir, 'stub-claude.mjs');
  const STUB_DUMP = join(stubDir, 'calls.jsonl');
  const LEDGER = join(stubDir, 'ledger.jsonl');
  writeFileSync(STUB, STUB_SOURCE);
  const envFor = (url, stateDir, extra = {}) => laneEnv(url, boards, {
    CCV3_REMINDER_STATE_DIR: stateDir, CCV3_REMINDER_TOAST_SCRIPT: TOAST, CCV3_REMINDER_TOAST_ARGS: '-DryRun',
    CCV3_REMINDER_CLAUDE: STUB, CCV3_HEADLESS_LEDGER: LEDGER, STUB_DUMP, STUB_MODE: 'ok', ...extra,
  });
  const stubCalls = () => (existsSync(STUB_DUMP) ? readFileSync(STUB_DUMP, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  // The Notion sync is off unless <state dir>/sync-enabled exists. newState(true) turns it on, as `lane.mjs remind sync on` does.
  const newState = (syncOn = false) => { const d = mkdtempSync(join(tmpdir(), 'tkprobe-state-')); if (syncOn) writeFileSync(join(d, 'sync-enabled'), 'on'); return d; };
  const lane = (dir, args, extra = {}) => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [LANE, ...args], { cwd: dir, encoding: 'utf8', env: laneEnv(urlA, boards, { CLAUDE_CODE_SESSION_ID: 'zz-tkprobe', ...extra }), timeout: 60_000 });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), ms: Date.now() - t0 };
  };
  const tick = (stateDir, args = [], url = urlA, extra = {}) => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [LANE, 'remind', 'tick', ...args], { cwd: neutral, encoding: 'utf8', env: envFor(url, stateDir, extra), timeout: 60_000 });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), ms: Date.now() - t0 };
  };
  const tickAsync = (stateDir, args = []) => new Promise((resolve) => {
    const c = spawn(process.execPath, [LANE, 'remind', 'tick', ...args], { cwd: neutral, env: envFor(urlA, stateDir) });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
  const mapSeq = async (ids, fn) => { const out = []; for (const id of ids) out.push(await fn(id)); return out; }; // one pg client runs one query at a time
  const row = async (id) => (await db.query(`SELECT id, project_key, band, state, remind_state, fired_at, updated_at, due_at FROM agentic_os.lane WHERE id=$1`, [id])).rows[0] ?? null;
  const fireEvents = async (id) => (await db.query(
    `SELECT kind, session_id, to_session_id, project_key, body, detail FROM agentic_os.lane_event WHERE lane_id=$1 AND kind='reminder' AND detail->>'op'='fire' ORDER BY id`, [id])).rows;
  const nFire = async () => (await db.query(`SELECT count(*)::int AS n FROM agentic_os.lane_event WHERE kind='reminder' AND detail->>'op'='fire'`)).rows[0].n;
  const state = (dir) => JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
  const setA = (id, at, ...more) => lane(A.dir, ['remind', 'set', id, '--title', `T ${id}`, '--at', at, '--allow-past', ...more]);
  const setB = (id, at, ...more) => lane(B.dir, ['remind', 'set', id, '--title', `T ${id}`, '--at', at, '--allow-past', ...more]);

  // ------------------------------------------------------------------ idle
  log('\n## idle tick');
  const idleDir = newState();
  let r = tick(idleDir);
  check('an idle tick (no lanes) exits 0, prints one summary line, and writes latest.json', r.code === 0 && /^tick: fired 0, unsynced 0, sync off$/.test(r.out) && existsSync(join(idleDir, 'latest.json')), `exit ${r.code}: ${r.out} ${r.err}`);
  check('F6: the idle tick takes under 2500 ms (node start, connect, three queries) and starts no claude', r.ms < 2500, `${r.ms} ms`);
  const s0 = state(idleDir);
  check('latest.json has ranAt, fired, unsynced, syncEnabled false, lastSyncOk and lastError', typeof s0.ranAt === 'string' && s0.fired === 0 && s0.unsynced === 0 && s0.syncEnabled === false && 'lastSyncOk' in s0 && 'lastError' in s0, JSON.stringify(s0));

  // ------------------------------------------------------------------ fire
  log('\n## fire, events, toast');
  setA('zz-tk-p0', minutes(-90), '--pri', 'P0'); setA('zz-tk-p1', minutes(-3)); setA('zz-tk-p2', minutes(-1), '--pri', 'P2');
  setA('zz-tk-fut', minutes(60 * 24)); setB('zz-tk-b', minutes(-5));
  setA('zz-tk-done', minutes(-20)); lane(A.dir, ['state', 'zz-tk-done', 'done']);
  setA('zz-tk-acked', minutes(-20)); lane(A.dir, ['remind', 'ack', 'zz-tk-acked']);
  const before = Object.fromEntries(await mapSeq(['zz-tk-p0', 'zz-tk-p1', 'zz-tk-b'], async (id) => [id, await row(id)]));
  const dir1 = newState();
  r = tick(dir1);
  const fireIds = ['zz-tk-p0', 'zz-tk-p1', 'zz-tk-p2', 'zz-tk-b'];
  const rows = Object.fromEntries(await mapSeq([...fireIds, 'zz-tk-fut', 'zz-tk-done', 'zz-tk-acked'], async (id) => [id, await row(id)]));
  check('the tick exits 0 and says fired 4', r.code === 0 && /tick: fired 4, /.test(r.out), `exit ${r.code}: ${r.out} ${r.err}`);
  check('four due reminders on two boards are now remind_state due, with fired_at set', fireIds.every((id) => rows[id].remind_state === 'due' && rows[id].fired_at), JSON.stringify(fireIds.map((id) => rows[id].remind_state)));
  check('a future reminder, a done lane and an acked reminder did not fire', rows['zz-tk-fut'].remind_state === 'scheduled' && rows['zz-tk-done'].remind_state === 'scheduled' && rows['zz-tk-acked'].remind_state === 'acked' && rows['zz-tk-done'].fired_at === null);
  const evs = await mapSeq(fireIds, fireEvents);
  check('F4: each fired row has exactly one fire event, on its OWN board, from session reminder-tick, broadcast', evs.every((e) => e.length === 1)
    && evs[0][0].project_key === A.key && evs[3][0].project_key === B.key && evs.every((e) => e[0].session_id === 'reminder-tick' && e[0].to_session_id === null), JSON.stringify(evs.map((e) => e[0]?.project_key)));
  const d0 = evs[0][0].detail;
  check('the fire event detail has op, due_at, pri, late_min and via tick; late_min is about 90 for the P0', d0.op === 'fire' && d0.pri === 'P0' && d0.via === 'tick' && typeof d0.due_at === 'string' && Math.abs(d0.late_min - 90) <= 2, JSON.stringify(d0));
  check('the P0 event body says OVERDUE (90 min late); the P1 body does not', /OVERDUE 1h/.test(evs[0][0].body) && !/OVERDUE/.test(evs[1][0].body), `${evs[0][0].body} | ${evs[1][0].body}`);
  check('F2: updated_at moved on every fired row (the Notion sync keys on updated_at)', ['zz-tk-p0', 'zz-tk-p1', 'zz-tk-b'].every((id) => rows[id].updated_at > before[id].updated_at));
  check('F5: the toast is ONE line for P0 and P1 only (3 rows), and P2 is absent', (r.out.match(/TOAST: /g) || []).length === 1 && /TOAST: CCv3 reminders: 3 due \|/.test(r.out) && !/zz-tk-p2/.test(r.out), r.out.split('\n').join(' // '));
  log(`tick stdout:\n${r.out}`);
  const s1 = state(dir1);
  check('latest.json after the fire says fired 4 and unsynced is the real count (every reminder lacks a Notion page)', s1.fired === 4 && s1.unsynced >= 4, JSON.stringify(s1));

  log('\n## a second tick fires nothing');
  const n1 = await nFire();
  r = tick(newState());
  check('a second tick says fired 0 and writes no new fire event', r.code === 0 && /tick: fired 0, /.test(r.out) && (await nFire()) === n1, `${r.out} events ${n1} -> ${await nFire()}`);

  // ------------------------------------------------------------------ races and locks
  log('\n## F1: two ticks at once');
  setA('zz-tk-race1', minutes(-2)); setB('zz-tk-race2', minutes(-2)); setA('zz-tk-race3', minutes(-2), '--pri', 'P2');
  const nBefore = await nFire();
  const [t1, t2] = await Promise.all([tickAsync(newState()), tickAsync(newState())]); // different state dirs: both pass the lock, the UPDATE gate decides
  const raced = await mapSeq(['zz-tk-race1', 'zz-tk-race2', 'zz-tk-race3'], async (id) => (await fireEvents(id)).length);
  check('two parallel ticks (separate lock files) write exactly one fire event per reminder', t1.code === 0 && t2.code === 0 && raced.every((n) => n === 1) && (await nFire()) === nBefore + 3, `codes ${t1.code},${t2.code} events ${raced} total +${(await nFire()) - nBefore}`);
  const fired2 = [t1.out, t2.out].map((o) => Number(/fired (\d+)/.exec(o)?.[1]));
  check('the fired counts of the two ticks add up to 3', fired2[0] + fired2[1] === 3, fired2.join('+'));

  log('\n## F14: a held lock');
  setA('zz-tk-locked', minutes(-2));
  const lockDir = newState();
  writeFileSync(join(lockDir, 'tick.lock'), JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
  r = tick(lockDir);
  check('a fresh tick.lock: exit 0, "locked", nothing fired', r.code === 0 && /locked/.test(r.out) && (await row('zz-tk-locked')).remind_state === 'scheduled', `${r.code}: ${r.out}`);
  check('the held lock file is left alone', existsSync(join(lockDir, 'tick.lock')));
  writeFileSync(join(lockDir, 'tick.lock'), JSON.stringify({ pid: 999999, ts: new Date(Date.now() - 11 * 60_000).toISOString() }));
  r = tick(lockDir);
  check('a lock over 10 minutes old is taken over: the reminder fires and the lock file is gone', r.code === 0 && (await row('zz-tk-locked')).remind_state === 'due' && !existsSync(join(lockDir, 'tick.lock')), `${r.code}: ${r.out}`);

  // ------------------------------------------------------------------ flags
  log('\n## --dry-run and --no-sync');
  setA('zz-tk-dry', minutes(-2));
  const dryDir = newState(); const nDry = await nFire();
  r = tick(dryDir, ['--dry-run']);
  check('--dry-run names the reminder, fires nothing, writes no event, no heartbeat', r.code === 0 && /zz-tk-dry/.test(r.out) && (await row('zz-tk-dry')).remind_state === 'scheduled' && (await nFire()) === nDry && !existsSync(join(dryDir, 'latest.json')), r.out);
  r = tick(newState(true), ['--no-sync']);
  check('--no-sync still fires and reports "sync skipped"', r.code === 0 && (await row('zz-tk-dry')).remind_state === 'due' && /sync skipped/.test(r.out), r.out);

  // ------------------------------------------------------------------ cleared reminder, snooze again
  log('\n## reverse: snooze after a fire arms it again');
  lane(A.dir, ['remind', 'snooze', 'zz-tk-dry', '--for', '30m']);
  check('snooze after a fire returns it to scheduled with fired_at NULL, and the next tick leaves it alone', (await row('zz-tk-dry')).remind_state === 'scheduled' && tick(newState()).out.includes('fired 0') && (await row('zz-tk-dry')).remind_state === 'scheduled');

  // ------------------------------------------------------------------ Notion sync, stub claude (phase 7)
  log('\n## Notion sync through a stub claude (no live Notion, no real claude)');
  const syncRow = async (id) => (await db.query(
    `SELECT notion_page_id, (notion_synced_at >= updated_at) AS in_sync, remind_state, state, owner_session_id FROM agentic_os.lane WHERE id=$1`, [id])).rows[0];
  const canary = { NOTION_API_TOKEN: 'probe-canary-not-a-token', SKIP_PACKAGE_GUARD: '1' };
  let before0 = stubCalls().length;
  writeFileSync(LEDGER, ''); // the sync sub-cap (12 a day) counts the ticks above too; this section starts from an empty ledger
  // The switch is off by default: unsynced rows exist (nothing above reached Notion), yet no claude starts and the ledger stays empty.
  const offDir = newState();
  r = tick(offDir, [], urlA, canary);
  const ledgerOff = existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').trim() : '';
  check('W1: switch off (no sync-enabled file): the tick starts no claude, takes no ledger row, prints "sync off", and latest.json says syncEnabled false with unsynced above 0',
    r.code === 0 && stubCalls().length === before0 && ledgerOff === '' && /sync off/.test(r.out) && state(offDir).syncEnabled === false && state(offDir).unsynced > 0, `exit ${r.code}: ${r.out.split('\n').pop()} calls ${stubCalls().length - before0} ledger ${JSON.stringify(ledgerOff)}`);
  const verbDir = newState();
  const verbRun = (sub) => lane(neutral, ['remind', 'sync', sub], { CCV3_REMINDER_STATE_DIR: verbDir });
  r = verbRun('on');
  check('W2: "remind sync on" creates the switch file (real lane.mjs, state folder only)', r.code === 0 && existsSync(join(verbDir, 'sync-enabled')) && /sync on/.test(r.out), `${r.code}: ${r.out} ${r.err}`);
  r = verbRun('off');
  check('W4: "remind sync off" removes the file and "status" says off', r.code === 0 && !existsSync(join(verbDir, 'sync-enabled')) && /sync off/.test(verbRun('status').out), `${r.code}: ${r.out}`);
  // The ticks above ran with the switch off, so a backlog of unsynced rows exists. Drain it with the switch on (6 ticks at most),
  // so that S1 sees only its own rows. The ledger and the call count start again after it.
  for (let i = 0; i < 6; i++) if (/unsynced 0,/.test(tick(newState(true), [], urlA, canary).out)) break;
  writeFileSync(LEDGER, '');
  before0 = stubCalls().length;
  setA('zz-sy-1', minutes(-2)); setB('zz-sy-2', minutes(-2)); setA('zz-sy-held', minutes(-2)); setA('zz-sy-fut', minutes(60 * 24));
  const syDir = newState(true);
  r = tick(syDir, [], urlA, canary);
  const c1 = stubCalls().slice(before0);
  const s1row = await syncRow('zz-sy-1');
  check('S1: a tick with unsynced rows starts the stub exactly once, for all of them', r.code === 0 && c1.length === 1 && c1[0].upserts.includes(`${A.key}/zz-sy-1`) && c1[0].upserts.includes(`${B.key}/zz-sy-2`), `exit ${r.code} calls ${c1.length}: ${r.out.split('\n').pop()}`);
  check('S2: the stub got a clean env (no NOTION_*, no SKIP_*, no ANTHROPIC_API_KEY, CI=true) and the pinned argv', c1[0].notion === null && c1[0].skip === null && c1[0].anthropic === null && c1[0].ci === 'true'
    && c1[0].argv.includes('--effort') && c1[0].argv[c1[0].argv.indexOf('--allowedTools') + 1].split(',').length === 3 && !c1[0].argv.includes('--bare')
    && c1[0].argv[c1[0].argv.indexOf('--tools') + 1] === '', JSON.stringify({ ...c1[0], upserts: undefined }));
  check('S3: count 1 stored notion_page_id, and notion_synced_at is not older than updated_at (the text round trip is exact)', Boolean(s1row.notion_page_id) && s1row.in_sync === true, JSON.stringify(s1row));
  check('S4: "sync ok" is printed and latest.json has lastSyncOk true, failCount 0 and a lastDonePollAt', /sync ok/.test(r.out) && state(syDir).lastSyncOk === true && state(syDir).failCount === 0 && typeof state(syDir).lastDonePollAt === 'string', JSON.stringify(state(syDir)));
  const ledgerRows = existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  check('S5: the run is in the headless ledger (start row with purpose reminder-sync, end row with keyStripped)', ledgerRows.some((e) => e.phase === 'start' && e.purpose === 'reminder-sync') && ledgerRows.some((e) => e.phase === 'end' && e.keyStripped === true), `${ledgerRows.length} rows`);
  const sn1 = stubCalls().length;
  r = tick(syDir, [], urlA, canary);
  check('S6: a second tick over the same state starts no claude (nothing unsynced, poll not due)', r.code === 0 && stubCalls().length === sn1 && /sync skipped/.test(r.out), `${stubCalls().length - sn1} calls: ${r.out}`);

  setA('zz-sy-dup', minutes(-2));
  const dupDir = newState(true);
  r = tick(dupDir, [], urlA, { ...canary, STUB_MODE: 'dup' });
  const dupRow = await syncRow('zz-sy-dup');
  check('S7: count 2 stores no page id, sets the lane remind_state failed, prints "sync failed", and stores a failCount 1 backoff', r.code === 0 && dupRow.notion_page_id === null && dupRow.remind_state === 'failed' && /sync failed/.test(r.out) && state(dupDir).failCount === 1 && typeof state(dupDir).nextSyncAt === 'string', `${r.out.split('\n').pop()} ${JSON.stringify(dupRow)}`);
  const sn2 = stubCalls().length;
  r = tick(dupDir, [], urlA, canary);
  check('S8: inside the 5 minute backoff the next tick starts no claude', r.code === 0 && stubCalls().length === sn2, `${stubCalls().length - sn2} calls`);
  const stuck = state(dupDir); delete stuck.nextSyncAt; stuck.failCount = 0; writeFileSync(join(dupDir, 'latest.json'), JSON.stringify(stuck));
  r = tick(dupDir, [], urlA, canary);
  const callsAfter = stubCalls().slice(sn2);
  check('S9: after the backoff, the duplicate lane is NOT sent again (the unchanged lane is skipped; the rest may go)', callsAfter.every((c) => !c.upserts.includes(`${A.key}/zz-sy-dup`)), JSON.stringify(callsAfter.map((c) => c.upserts)));

  lane(A.dir, ['claim', 'zz-sy-held']);
  const heldRow0 = await syncRow('zz-sy-held');
  r = tick(newState(true), [], urlA, canary); // stub ok: stores a page id for zz-sy-held, so the Done-poll can see it
  const sn3 = stubCalls().length;
  const doneDir = newState(true);
  r = tick(doneDir, [], urlA, { ...canary, STUB_MODE: 'done' });
  const c3 = stubCalls().slice(sn3);
  const doneFree = await syncRow('zz-sy-1'); const doneHeld = await syncRow('zz-sy-held');
  check('S10: the Done-poll polls the open reminders that have a Notion page, in the same single call', c3.length === 1 && c3[0].poll.includes(`${A.key}/zz-sy-1`) && c3[0].poll.includes(`${A.key}/zz-sy-held`), JSON.stringify(c3.map((c) => c.poll)));
  check('F1: a FUTURE reminder that already has a Notion page is not in the poll (only fired reminders are polled)', Boolean((await syncRow('zz-sy-fut')).notion_page_id) && !c3[0].poll.includes(`${A.key}/zz-sy-fut`), JSON.stringify(c3.map((c) => c.poll)));
  check('S11: Done in Notion on an unheld reminders lane: acked and closed (state done, no owner)', doneFree.remind_state === 'acked' && doneFree.state === 'done' && doneFree.owner_session_id === null, JSON.stringify(doneFree));
  check('S12: Done in Notion on a HELD lane: acked, NOT closed, the owner is unchanged, and a note event names the holder', doneHeld.remind_state === 'acked' && doneHeld.state !== 'done' && doneHeld.owner_session_id === heldRow0.owner_session_id
    && (await db.query(`SELECT 1 FROM agentic_os.lane_event WHERE lane_id='zz-sy-held' AND kind='note' AND body LIKE '%not closed%'`)).rowCount === 1, JSON.stringify(doneHeld));
  const sn4 = stubCalls().length;
  r = tick(doneDir, [], urlA, { ...canary, STUB_MODE: 'done' });
  check('S13: the Done-poll is not due again inside 2 hours: any later call (the acked rows go to Notion) carries no poll list', stubCalls().slice(sn4).every((c) => c.poll.length === 0), `${stubCalls().length - sn4} calls`);
  setA('zz-sy-bad', minutes(-2));
  r = tick(newState(true), [], urlA, { ...canary, STUB_MODE: 'bad' });
  check('S14: a result that is not JSON stores nothing and the tick still exits 0', r.code === 0 && /sync failed/.test(r.out) && (await syncRow('zz-sy-bad')).notion_page_id === null, r.out.split('\n').pop());

  // ------------------------------------------------------------------ a cleared reminder closes its card, once (critic F5)
  log('\n## F5: remind clear on a synced reminder closes the Notion card, once');
  setA('zz-sy-clr', minutes(-2));
  tick(newState(true), [], urlA, canary); // the stub gives it a page id
  const clrPage = (await syncRow('zz-sy-clr')).notion_page_id;
  lane(A.dir, ['remind', 'clear', 'zz-sy-clr']);
  const snC = stubCalls().length;
  r = tick(newState(true), [], urlA, canary);
  const clrItem = stubCalls().slice(snC).flatMap((c) => c.items).find((i) => i.laneId === `${A.key}/zz-sy-clr`);
  check('F5a: a page-backed reminder that was cleared is sent to the sync with Done and a CLEARED title', Boolean(clrPage) && clrItem?.status === 'Done' && /^CLEARED · /.test(clrItem?.task ?? ''), JSON.stringify({ clrPage, clrItem, out: r.out.split('\n').pop() }));
  check('F5b: after the card is closed the lane releases the page id and is in sync', (await syncRow('zz-sy-clr')).notion_page_id === null, JSON.stringify(await syncRow('zz-sy-clr')));
  const snD = stubCalls().length;
  lane(A.dir, ['state', 'zz-sy-clr', 'done']); // any later edit of the lane row bumps updated_at
  tick(newState(true), [], urlA, canary);
  check('F5c: a later edit of the cleared lane does not send it again', stubCalls().slice(snD).every((c) => !c.upserts.includes(`${A.key}/zz-sy-clr`)), `${stubCalls().length - snD} calls`);

  // ------------------------------------------------------------------ database errors (F13)
  log('\n## F13: the database is down, or lacks migration 0005');
  r = tick(newState(), [], 'postgresql://claude:nope@127.0.0.1:1/lanes_pr1_none');
  check('an unreachable database exits 2 with one message line and no stack trace', r.code === 2 && r.err.split('\n').length === 1 && noStack(r.err), `exit ${r.code}: ${r.err.split('\n')[0]}`);
  const old4 = scratch('create', '--through', '4');
  if (old4.status !== 0) throw new Error(`scratch create (through 4) failed: ${old4.stderr}`);
  urlOld = JSON.parse(old4.stdout).url;
  assertScratchUrl(urlOld);
  r = tick(newState(), [], urlOld);
  check('a database with migration 0004 only exits 2 and names migration 0005, one line', r.code === 2 && /migration 0005/.test(r.err) && r.err.split('\n').length === 1 && noStack(r.err), `exit ${r.code}: ${r.err.split('\n')[0]}`);
  r = lane(neutral, ['remind', 'bogus-verb']);
  check('regression: another remind error still exits 1 (only tick maps to 2)', r.code === 1, `exit ${r.code}`);
} catch (e) {
  log(`ERROR: ${e.stack || e.message}`);
  results.push(['driver error', false]);
} finally {
  if (db) await db.end().catch(() => {});
  for (const u of [urlA, urlOld]) {
    if (!u) continue;
    try { assertScratchUrl(u); const d = scratch('drop', u); log(`drop: ${d.stdout.trim() || d.stderr.trim()}`); } catch (e) { log(`drop failed: ${e.message}`); results.push(['drop', false]); }
  }
  if (boards) boards.cleanup();
  const failed = results.filter((x) => !x[1]).length;
  log(`\nSUMMARY: ${results.length - failed} passed, ${failed} failed (of ${results.length} checks)`);
  process.exitCode = failed ? 1 : 0;
}
