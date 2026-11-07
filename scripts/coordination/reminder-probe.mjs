#!/usr/bin/env node
/**
 * reminder-probe -- the end-to-end gate for the lane `remind` verbs and the SessionStart "Reminders due" block
 * (lane reminders, phases 2 and 3).
 *
 * Runs the REAL scripts/coordination/lane.mjs of THIS checkout as a child process, and the REAL built
 * .claude/hooks/dist/lane-context.mjs, against SCRATCH databases (lanes_pr1_*, migrations through 5, and one
 * through 4) that this probe creates and drops. It never touches the live database. Boards come from a temp
 * registry (probe-boards.mjs), never the real one.
 *
 * It runs this checkout's lane.mjs and not the shim on purpose: the shim runs the primary's lane.mjs, which has
 * no remind verbs until the PR merges and forward sync runs (the same reason lane-band-probe.mjs does it).
 *
 *   node scripts/coordination/reminder-probe.mjs        (run `npm run build` in .claude/hooks first)
 *
 * The transcript goes to .claude/cache/e2e/2026-11-06-lane-prb-e2e.txt (overwrite), or to REMINDER_PROBE_OUT.
 * Exit 0: all checks pass. Exit 1: a check failed. Exit 2: pg is missing.
 * Design: .claudedocs/2026-11-06-lane-reminders-design.md, "Build phases", phases 2 and 3.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl, maskUrl } from './scratch-db.mjs';
import { laneEnv, makeBoards } from './probe-boards.mjs';
import { laneOrderSql } from './lane-sort.mjs';

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  console.log('usage: node scripts/coordination/reminder-probe.mjs\n'
    + 'Proves the lane remind verbs and the SessionStart Reminders block on throwaway lanes_pr1_* databases with the real\n'
    + 'lane.mjs and the built dist/lane-context.mjs. Needs a reachable Postgres, the pg package (set NODE_PATH to a folder\n'
    + 'that holds pg) and `npm run build` in .claude/hooks. Takes no other arguments.\n'
    + 'Exit 1 if a check fails, 2 if pg is missing.');
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LANE = join(HERE, 'lane.mjs');
const SCRATCH = join(HERE, 'scratch-db.mjs');
const HOOK = join(REPO, '.claude', 'hooks', 'dist', 'lane-context.mjs');
const HOOK_SRC = join(REPO, '.claude', 'hooks', 'src', 'lane-context.ts');
const OUT = process.env.REMINDER_PROBE_OUT || join(REPO, '.claude', 'cache', 'e2e', '2026-11-06-lane-prb-e2e.txt');

let Client;
try {
  ({ Client } = requireDep('pg', { repoRoot: REPO }));
} catch (e) {
  console.error(`reminder-probe: the pg package is not available (${e.message}). Set NODE_PATH to a folder that holds pg.`);
  process.exit(2);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, '');

const log = (s = '') => { const t = String(s).replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/g, '$1***@'); appendFileSync(OUT, t + '\n'); console.log(t); };
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };

const SESSION = 'zz-rmprobe-session';
const scratch = (...args) => spawnSync(process.execPath, [SCRATCH, ...args], { encoding: 'utf8' });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const minutes = (m) => new Date(Date.now() + m * 60_000).toISOString();
const near = (iso, expectMs, tolMs = 120_000) => Math.abs(new Date(iso).getTime() - expectMs) <= tolMs;
const noStack = (s) => !/\n\s+at \S/.test(s) && !/Error:/.test(s);

let boards = null; let urlA = null; let urlOld = null; let db = null; let plain = null;
try {
  log('# lane remind verbs and the Reminders due block: scratch database probe, 2026-11-06');
  log('# Live database: NOT touched. The real lane.mjs and the built dist/lane-context.mjs run against the scratch URL below.');
  const created = scratch('create', '--through', '5');
  if (created.status !== 0) throw new Error(`scratch create failed: ${created.stderr}`);
  urlA = JSON.parse(created.stdout).url;
  assertScratchUrl(urlA);
  log(`scratch database: ${maskUrl(urlA)}`);
  boards = makeBoards('zz-rmprobe', ['a', 'b', 'c']);
  const A = boards.boards.a; const B = boards.boards.b; const C = boards.boards.c;
  db = new Client({ connectionString: urlA });
  await db.connect();
  // A plain client: it never sets lane.client_version, like a lane.mjs that predates per-project boards.
  plain = new Client({ connectionString: urlA });
  await plain.connect();

  const lane = (url, dir, args, session = SESSION) => {
    const r = spawnSync(process.execPath, [LANE, ...args], {
      cwd: dir, encoding: 'utf8', env: laneEnv(url, boards, { CLAUDE_CODE_SESSION_ID: session }),
    });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), all: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  };
  const a = (...args) => lane(urlA, A.dir, args);
  const b = (...args) => lane(urlA, B.dir, args);
  const c = (...args) => lane(urlA, C.dir, args);
  const other = (...args) => lane(urlA, A.dir, args, 'zz-rmprobe-other');
  const row = async (id) => (await db.query(
    `SELECT id, title, track, state, band, priority, due_at, remind_state, fired_at, action_id, notion_page_id, project_key, owner_session_id
       FROM agentic_os.lane WHERE id=$1`, [id])).rows[0] ?? null;
  const snap = async (id) => (await db.query('SELECT row_to_json(l)::text AS j FROM agentic_os.lane l WHERE id=$1', [id])).rows[0]?.j ?? null;
  const events = async (id) => (await db.query(
    `SELECT kind, to_session_id, project_key, detail, body FROM agentic_os.lane_event WHERE lane_id=$1 AND kind='reminder' ORDER BY id`, [id])).rows;
  const nEvents = async () => (await db.query(`SELECT count(*)::int AS n FROM agentic_os.lane_event WHERE kind='reminder'`)).rows[0].n;
  const jsonOf = (r) => { try { return JSON.parse(r.out); } catch { return null; } };

  // ------------------------------------------------------------------ set
  log('\n## set');
  let r = a('remind', 'set', 'zz-rm-new', '--at', minutes(60 * 24));
  check('set on a new id with no --title exits 1 and creates no row', r.code === 1 && /--title/.test(r.err) && (await row('zz-rm-new')) === null, `exit ${r.code}: ${r.err.split('\n')[0]}`);
  r = a('remind', 'set', 'zz-rm-new', '--title', 'New one');
  check('set with no --at exits 1 with "--at <time> is required" and creates no row', r.code === 1 && /--at <time> is required/.test(r.err) && !/undefined/.test(r.err) && (await row('zz-rm-new')) === null, `exit ${r.code}: ${r.err.split('\n')[0]}`);
  r = a('remind', 'set', 'zz-rm-new', '--title', 'New one', '--at', minutes(-60));
  check('set --at in the past exits 1 and writes nothing', r.code === 1 && /past/.test(r.err) && (await row('zz-rm-new')) === null, `exit ${r.code}: ${r.err.split('\n')[0]}`);
  r = a('remind', 'set', 'zz-rm-past', '--title', 'Past one', '--at', minutes(-180), '--allow-past');
  const past = await row('zz-rm-past');
  check('set --allow-past writes: P1, track reminders, state backlog, scheduled',
    r.code === 0 && past?.band === 'P1' && past?.track === 'reminders' && past?.state === 'backlog' && past?.remind_state === 'scheduled' && past?.fired_at === null && near(past?.due_at, Date.now() - 180 * 60_000), `${r.all} ${JSON.stringify(past)}`);
  r = a('remind', 'set', 'zz-rm-p0', '--title', 'P0 one', '--at', minutes(60 * 48), '--pri', 'P0');
  check('set --pri P0 is accepted', r.code === 0 && (await row('zz-rm-p0'))?.band === 'P0', r.all);
  r = a('remind', 'set', 'zz-rm-fut', '--title', 'Future P1', '--at', minutes(60 * 30));
  check('set with no --pri on a new lane gives P1', r.code === 0 && (await row('zz-rm-fut'))?.band === 'P1', r.all);
  r = a('remind', 'set', 'zz-rm-p2', '--title', 'Future P2', '--at', minutes(60 * 40), '--pri', 'P2');
  check('set --pri P2 is accepted', r.code === 0 && (await row('zz-rm-p2'))?.band === 'P2', r.all);
  r = a('remind', 'set', 'zz-rm-p0', '--at', minutes(60 * 72));
  check('set with no --pri on an existing P0 lane keeps P0 (P0 is never lost or made by default)', r.code === 0 && (await row('zz-rm-p0'))?.band === 'P0', r.all);
  await a('add', 'zz-rm-nullband', '--title', 'No band');
  r = a('remind', 'set', 'zz-rm-nullband', '--at', minutes(60 * 20));
  check('set with no --pri on a NULL-band lane writes P1 (title kept)', r.code === 0 && (await row('zz-rm-nullband'))?.band === 'P1' && (await row('zz-rm-nullband'))?.title === 'No band', r.all);
  for (const [label, args] of [['--pri none', ['--pri', 'none']], ['--pri p0', ['--pri', 'p0']], ['--pri (no value)', ['--pri']], ['--action rm -rf /', ['--action', 'rm -rf /']]]) {
    const before = await snap('zz-rm-p0'); const n = await nEvents();
    r = a('remind', 'set', 'zz-rm-p0', '--at', minutes(60 * 72), ...args);
    check(`set ${label}: exit 1, nothing written, no event`, r.code === 1 && before === (await snap('zz-rm-p0')) && n === (await nEvents()), `exit ${r.code}: ${r.err.split('\n')[0]}`);
  }
  r = a('remind', 'set', 'zz-rm-act', '--title', 'With action', '--at', minutes(60 * 22), '--action', 'doctor.run', '--done-when', 'doctor green');
  const act = await row('zz-rm-act');
  check('set --action <id> --done-when stores the action id as text', r.code === 0 && act?.action_id === 'doctor.run', r.all);

  log('\n## set: the P0 soft cap (5)');
  for (const i of [1, 2, 3]) await a('remind', 'set', `zz-rm-cap${i}`, '--title', `cap ${i}`, '--at', minutes(60 * 50), '--pri', 'P0');
  r = a('remind', 'set', 'zz-rm-cap4', '--title', 'cap 4', '--at', minutes(60 * 50), '--pri', 'P0');
  check('the fifth open P0 on the board prints no warning', r.code === 0 && !/cap|WARNING/i.test(r.err), r.err);
  r = a('remind', 'set', 'zz-rm-cap5', '--title', 'cap 5', '--at', minutes(60 * 50), '--pri', 'P0');
  check('the sixth open P0 prints the cap warning on stderr and still exits 0', r.code === 0 && /P0/.test(r.err) && /5/.test(r.err) && (await row('zz-rm-cap5'))?.band === 'P0', `exit ${r.code}: ${r.err}`);

  log('\n## set: a lane in state done, and the board fence');
  await a('remind', 'set', 'zz-rm-done', '--title', 'Will be done', '--at', minutes(60 * 24));
  await a('state', 'zz-rm-done', 'done');
  const doneSnap = await snap('zz-rm-done');
  r = a('remind', 'set', 'zz-rm-done', '--at', minutes(60 * 48));
  check('set on a state=done lane exits 1, names `state zz-rm-done backlog`, writes nothing',
    r.code === 1 && r.err.includes('state zz-rm-done backlog') && doneSnap === (await snap('zz-rm-done')), `exit ${r.code}: ${r.err}`);
  await b('add', 'zz-rm-foreign', '--title', 'Foreign on b');
  const fSnap = await snap('zz-rm-foreign');
  r = a('remind', 'set', 'zz-rm-foreign', '--title', 'hijack', '--at', minutes(60 * 24), '--pri', 'P0');
  check('set on an id owned by another board exits 1 (belongs to board) and leaves the row byte for byte unchanged',
    r.code === 1 && /belongs to board/.test(r.err) && r.err.includes(B.key) && fSnap === (await snap('zz-rm-foreign')), `exit ${r.code}: ${r.err}`);
  for (const verb of [['snooze', 'zz-rm-foreign', '--for', '2h'], ['ack', 'zz-rm-foreign'], ['clear', 'zz-rm-foreign']]) {
    r = a('remind', ...verb);
    check(`remind ${verb[0]} on a lane of another board exits 1, row unchanged`, r.code === 1 && fSnap === (await snap('zz-rm-foreign')), `exit ${r.code}: ${r.err.split('\n')[0]}`);
  }
  let denied = null;
  try { await plain.query(`UPDATE agentic_os.lane SET updated_at = now() WHERE id = $1`, ['zz-rm-foreign']); } catch (e) { denied = e; }
  check('a plain client with no lane.client_version is denied a foreign-board UPDATE with 42501 (the 0004 fence still holds)',
    denied?.code === '42501' && fSnap === (await snap('zz-rm-foreign')), denied ? `${denied.code}` : 'no error');

  log('\n## set: a lane held by another session');
  await a('add', 'zz-rm-held', '--title', 'Held work', '--track', 'work');
  const claimed = other('claim', 'zz-rm-held');
  const heldBefore = await snap('zz-rm-held'); const heldN = await nEvents();
  check('setup: another session holds zz-rm-held with no band', claimed.code === 0 && (await row('zz-rm-held'))?.owner_session_id === 'zz-rmprobe-other' && (await row('zz-rm-held'))?.band === null, claimed.all);
  for (const [label, args, re] of [
    ['a --title', ['--title', 'hijacked'], /held by/],
    ['--pri P0', ['--pri', 'P0'], /held by/],
    ['no --pri on a NULL-band lane (it would write P1)', [], /held by[^\n]*band/],
  ]) {
    r = a('remind', 'set', 'zz-rm-held', '--at', minutes(60 * 24), ...args);
    check(`set ${label} on a lane another session holds: exit 1, row unchanged, no event`,
      r.code === 1 && re.test(r.err) && heldBefore === (await snap('zz-rm-held')) && heldN === (await nEvents()), `exit ${r.code}: ${r.err.split('\n')[0]}`);
  }
  await a('band', 'zz-rm-held', 'P2');
  r = a('remind', 'set', 'zz-rm-held', '--at', minutes(60 * 24), '--pri', 'P2');
  const heldRow = await row('zz-rm-held');
  check('once the band is set, set with the same --pri works on the held lane and keeps title, band and holder',
    r.code === 0 && heldRow?.title === 'Held work' && heldRow.band === 'P2' && heldRow.owner_session_id === 'zz-rmprobe-other' && heldRow.remind_state === 'scheduled' && heldRow.due_at !== null, `${r.all} ${JSON.stringify(heldRow)}`);
  r = a('remind', 'set', 'zz-rm-held', '--at', minutes(60 * 26));
  check('set with no flags on a held lane that has a band works', r.code === 0 && (await row('zz-rm-held'))?.band === 'P2', r.all);

  // The probe's own writes (simulating the tick) must carry the client version too, or the trigger denies them.
  await db.query(`SELECT set_config('lane.client_version', '2', false)`);
  await a('add', 'zz-rm-plain', '--title', 'Not a reminder');

  // ------------------------------------------------------------------ list
  log('\n## list');
  const rank = (x) => ({ P0: 0, P1: 1, P2: 2 }[x] ?? 3);
  const expectedOpen = async (withAcked) => (await db.query(
    `SELECT id, band, due_at, priority FROM agentic_os.lane WHERE project_key=$1 AND state <> 'done' AND remind_state IS NOT NULL
       ${withAcked ? '' : `AND remind_state <> 'acked'`}`, [A.key])).rows
    .sort((x, y) => rank(x.band) - rank(y.band) || x.due_at - y.due_at || x.priority - y.priority || (x.id < y.id ? -1 : 1)).map((x) => x.id);
  r = a('remind', 'list', '--json');
  let listed = jsonOf(r);
  check('list --json is valid JSON and orders P0, P1, P2, then due_at, priority, id',
    r.code === 0 && Array.isArray(listed) && same(listed.map((l) => l.id), await expectedOpen(false)) && listed.length >= 10, `${listed?.map?.((l) => l.id)}`);
  const bands = (listed ?? []).map((l) => rank(l.band));
  check('the list never puts a lower band before a higher one', bands.length > 0 && bands.every((x, i) => i === 0 || bands[i - 1] <= x), bands.join(','));
  check('list hides a state=done lane and a lane that is not a reminder', !listed?.some((l) => l.id === 'zz-rm-done' || l.id === 'zz-rm-plain'));
  r = a('remind', 'list');
  check('list prints a line per reminder with the band, the id and a Chicago time', r.code === 0 && /P0 +zz-rm-p0/.test(r.out) && /\b(CST|CDT)\b/.test(r.out), r.out.split('\n')[0]);
  r = c('remind', 'list');
  check('a board with no reminders prints a plain "no reminders" line', r.code === 0 && /no reminders/i.test(r.out), r.all);
  r = c('remind', 'list', '--json');
  check('a board with no reminders gives [] with --json', r.code === 0 && same(jsonOf(r), []), r.out);

  // ------------------------------------------------------------------ snooze
  log('\n## snooze');
  await db.query(`UPDATE agentic_os.lane SET remind_state='due', fired_at=now() WHERE id=$1`, ['zz-rm-past']);
  const beforeSnooze = await row('zz-rm-past');
  r = a('remind', 'snooze', 'zz-rm-past', '--for', '2h');
  let s = await row('zz-rm-past');
  check('snooze --for 2h: new due_at about 2h out, remind_state scheduled, fired_at NULL',
    r.code === 0 && s?.remind_state === 'scheduled' && s?.fired_at === null && near(s?.due_at, Date.now() + 2 * 3_600_000), `${r.all} ${JSON.stringify(s)}`);
  let ev = await events('zz-rm-past');
  const lastEv = ev[ev.length - 1];
  check('the snooze event logs the old due_at', lastEv?.detail?.op === 'snooze' && new Date(lastEv.detail.from_due_at).getTime() === beforeSnooze.due_at.getTime(), JSON.stringify(lastEv?.detail));
  r = a('remind', 'snooze', 'zz-rm-past', '--at', minutes(60 * 5));
  check('snooze --at <future> works', r.code === 0 && near((await row('zz-rm-past'))?.due_at, Date.now() + 5 * 3_600_000), r.all);
  for (const [label, args] of [
    ['--for and --at together', ['snooze', 'zz-rm-past', '--for', '2h', '--at', minutes(300)]],
    ['neither --for nor --at', ['snooze', 'zz-rm-past']],
    ['--for 90d', ['snooze', 'zz-rm-past', '--for', '90d']],
    ['--at in the past', ['snooze', 'zz-rm-past', '--at', minutes(-30)]],
    ['a lane with no reminder', ['snooze', 'zz-rm-plain', '--for', '2h']],
  ]) {
    const before = await snap('zz-rm-past'); const n = await nEvents();
    r = a('remind', ...args);
    check(`snooze ${label}: exit 1, nothing written`, r.code === 1 && before === (await snap('zz-rm-past')) && n === (await nEvents()), `exit ${r.code}: ${r.err.split('\n')[0]}`);
  }
  r = a('remind', 'snooze', 'zz-rm-plain', '--for', '2h');
  check('snooze on a lane with no reminder names `remind set`', /remind set/.test(r.err), r.err);

  // ------------------------------------------------------------------ ack
  log('\n## ack');
  const beforeAck = await row('zz-rm-fut');
  let n0 = await nEvents();
  r = a('remind', 'ack', 'zz-rm-fut');
  s = await row('zz-rm-fut');
  check('ack sets remind_state acked and leaves state, band and due_at alone',
    r.code === 0 && s?.remind_state === 'acked' && s.state === beforeAck.state && s.band === beforeAck.band && s.due_at.getTime() === beforeAck.due_at.getTime(), `${r.all} ${JSON.stringify(s)}`);
  check('that ack wrote one event', (await nEvents()) === n0 + 1);
  n0 = await nEvents();
  r = a('remind', 'ack', 'zz-rm-fut');
  check('a second ack says unchanged and logs no second event', r.code === 0 && /unchanged/.test(r.out) && (await nEvents()) === n0, r.all);
  r = a('remind', 'ack', 'zz-rm-plain');
  check('ack on a lane with no reminder exits 1', r.code === 1 && /remind set/.test(r.err), `exit ${r.code}: ${r.err}`);
  r = a('remind', 'snooze', 'zz-rm-fut', '--for', '2h');
  check('snooze on an acked reminder exits 1 and names `remind set`', r.code === 1 && /remind set/.test(r.err) && (await row('zz-rm-fut'))?.remind_state === 'acked', `exit ${r.code}: ${r.err}`);
  r = a('remind', 'set', 'zz-rm-fut', '--at', minutes(60 * 30));
  s = await row('zz-rm-fut');
  check('reverse: set after ack reopens it to scheduled with fired_at NULL', r.code === 0 && s?.remind_state === 'scheduled' && s.fired_at === null, r.all);
  a('remind', 'ack', 'zz-rm-p2');
  listed = jsonOf(a('remind', 'list', '--json')) ?? [];
  check('list hides an acked reminder by default', !listed.some((l) => l.id === 'zz-rm-p2'));
  listed = jsonOf(a('remind', 'list', '--all', '--json')) ?? [];
  check('list --all shows an acked reminder', listed.some((l) => l.id === 'zz-rm-p2' && l.remind_state === 'acked'));

  // ------------------------------------------------------------------ clear
  log('\n## clear');
  await db.query(`UPDATE agentic_os.lane SET notion_page_id='pg-1', fired_at=now(), remind_state='due' WHERE id=$1`, ['zz-rm-act']);
  r = a('remind', 'clear', 'zz-rm-act');
  s = await row('zz-rm-act');
  check('clear NULLs due_at, remind_state, fired_at and action_id, and keeps band and notion_page_id',
    r.code === 0 && s?.due_at === null && s.remind_state === null && s.fired_at === null && s.action_id === null && s.band === 'P1' && s.notion_page_id === 'pg-1', `${r.all} ${JSON.stringify(s)}`);
  n0 = await nEvents();
  r = a('remind', 'clear', 'zz-rm-act');
  check('a second clear says unchanged and logs no event', r.code === 0 && /unchanged/.test(r.out) && (await nEvents()) === n0, r.all);
  r = a('remind', 'clear', 'zz-rm-plain');
  check('clear on a lane that is not a reminder says unchanged', r.code === 0 && /unchanged/.test(r.out) && (await nEvents()) === n0, r.all);
  r = a('remind', 'set', 'zz-rm-act', '--at', minutes(60 * 22));
  s = await row('zz-rm-act');
  check('reverse: set after clear works (scheduled, band P1 kept, notion_page_id kept)', r.code === 0 && s?.remind_state === 'scheduled' && s.band === 'P1' && s.notion_page_id === 'pg-1' && s.due_at !== null, r.all);

  // ------------------------------------------------------------------ events
  log('\n## events: one broadcast event per real change');
  await a('remind', 'set', 'zz-rm-ev', '--title', 'Event lane', '--at', minutes(600));
  await a('remind', 'snooze', 'zz-rm-ev', '--for', '1h');
  await a('remind', 'ack', 'zz-rm-ev');
  await a('remind', 'ack', 'zz-rm-ev');
  await a('remind', 'clear', 'zz-rm-ev');
  await a('remind', 'clear', 'zz-rm-ev');
  ev = await events('zz-rm-ev');
  check('set, snooze, ack and clear wrote exactly four events, in order; the two no-ops wrote none',
    same(ev.map((e) => e.detail.op), ['set', 'snooze', 'ack', 'clear']), JSON.stringify(ev.map((e) => e.detail.op)));
  check('each event is a broadcast of kind reminder on board a', ev.length === 4 && ev.every((e) => e.kind === 'reminder' && e.to_session_id === null && e.project_key === A.key));
  check('the set event detail carries due_at and pri and no undefined keys', typeof ev[0]?.detail?.due_at === 'string' && ev[0].detail.pri === 'P1' && !('via' in ev[0].detail && ev[0].detail.via === undefined), JSON.stringify(ev[0]?.detail));
  a('remind', 'set', 'zz-rm-ev', '--at', minutes(600));
  check('reverse: set after clear works again', (await row('zz-rm-ev'))?.remind_state === 'scheduled');

  // ------------------------------------------------------------------ usage errors
  log('\n## usage');
  for (const [label, args] of [['no sub-verb', ['remind']], ['an unknown sub-verb', ['remind', 'frobnicate', 'x']], ['tick (phase 5)', ['remind', 'tick']]]) {
    r = a(...args);
    check(`remind ${label}: exit 1 with a usage line`, r.code === 1 && /remind/.test(r.err) && noStack(r.err), `exit ${r.code}: ${r.err.split('\n')[0]}`);
  }

  // ------------------------------------------------------------------ next
  log('\n## next hides a lane whose reminder is not due yet');
  await a('add', 'zz-rm-nx-fut', '--title', 'Ready, due later', '--state', 'ready');
  await a('add', 'zz-rm-nx-plain', '--title', 'Ready, no reminder', '--state', 'ready');
  await a('remind', 'set', 'zz-rm-nx-fut', '--at', minutes(60 * 24));
  let nextIds = (jsonOf(a('next', '--json', '--n', '200')) ?? []).map((l) => l.id);
  check('next skips a ready lane whose due_at is in the future, and offers one with no reminder',
    !nextIds.includes('zz-rm-nx-fut') && nextIds.includes('zz-rm-nx-plain'), nextIds.join(','));
  await db.query(`UPDATE agentic_os.lane SET due_at = now() - interval '1 minute' WHERE id=$1`, ['zz-rm-nx-fut']);
  nextIds = (jsonOf(a('next', '--json', '--n', '200')) ?? []).map((l) => l.id);
  check('next returns a work lane (not track reminders) once its due_at has passed', nextIds.includes('zz-rm-nx-fut'), nextIds.join(','));

  log('\n## next never offers a reminder lane as work');
  await a('remind', 'set', 'zz-rm-nx-open', '--title', 'Due reminder, open', '--at', minutes(-90), '--allow-past', '--pri', 'P0');
  await a('remind', 'set', 'zz-rm-nx-acked', '--title', 'Due reminder, acked', '--at', minutes(-90), '--allow-past', '--pri', 'P0');
  await a('remind', 'ack', 'zz-rm-nx-acked');
  const reminderRows = await db.query(`SELECT id, state, owner_session_id, remind_state FROM agentic_os.lane WHERE id = ANY($1)`, [['zz-rm-nx-open', 'zz-rm-nx-acked']]);
  check('setup: both are unheld backlog reminder lanes, past due, one acked',
    reminderRows.rows.length === 2 && reminderRows.rows.every((x) => x.state === 'backlog' && x.owner_session_id === null) && reminderRows.rows.some((x) => x.remind_state === 'acked'), JSON.stringify(reminderRows.rows));
  nextIds = (jsonOf(a('next', '--json', '--n', '200')) ?? []).map((l) => l.id);
  check('next skips an open past-due reminder lane and an acked past-due reminder lane, and still offers plain work',
    !nextIds.includes('zz-rm-nx-open') && !nextIds.includes('zz-rm-nx-acked') && nextIds.includes('zz-rm-nx-plain'), nextIds.join(','));
  r = a('next');
  check('next in text form does not print them either', !/zz-rm-nx-open|zz-rm-nx-acked/.test(r.out), r.out.split('\n').slice(0, 3).join(' | '));
  check('remind list --due still shows the open one (the Reminders due view is the place for it)',
    (jsonOf(a('remind', 'list', '--due', '--json')) ?? []).some((l) => l.id === 'zz-rm-nx-open'));

  // ------------------------------------------------------------------ a database without 0005
  log('\n## a database with migration 0004 only (deploy order)');
  const old = scratch('create', '--through', '4');
  if (old.status !== 0) throw new Error(`scratch create (through 4) failed: ${old.stderr}`);
  urlOld = JSON.parse(old.stdout).url;
  assertScratchUrl(urlOld);
  const o = (...args) => lane(urlOld, A.dir, args);
  for (const args of [['set', 'zz-rm-old', '--title', 'old', '--at', minutes(600)], ['list'], ['snooze', 'zz-rm-old', '--for', '2h'], ['ack', 'zz-rm-old'], ['clear', 'zz-rm-old']]) {
    r = o('remind', ...args);
    check(`remind ${args[0]} on a 0004 database gives the one "migration 0005" message, no stack trace`,
      r.code === 1 && /migration 0005/.test(r.err) && r.err.split('\n').length === 1 && noStack(r.err), `exit ${r.code}: ${r.err.split('\n')[0]}`);
  }

  // ------------------------------------------------------------------ the SessionStart block
  log('\n## SessionStart: the Reminders due block (real dist/lane-context.mjs as a child process)');
  let hookSeq = 0;
  const hook = (url, dir, extraEnv = {}) => {
    const t0 = Date.now();
    const h = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: `zz-rmprobe-hook-${process.pid}-${++hookSeq}`, hook_event_name: 'SessionStart', cwd: dir }),
      encoding: 'utf8', timeout: 20_000,
      env: laneEnv(url, boards, { LANE_BOARD_CACHE: '0', LANE_CONTEXT_ERROR_LOG: join(boards.tmp, 'hook-errors.jsonl'), ...extraEnv }),
    });
    let ctx = null; let raw = (h.stdout || '').trim();
    try { const j = JSON.parse(raw); ctx = j.hookSpecificOutput?.additionalContext ?? ''; } catch { /* ctx stays null */ }
    return { code: h.status, raw, ctx, ms: Date.now() - t0, err: (h.stderr || '').trim() };
  };
  const block = (ctx) => /## Reminders due[\s\S]*?(?:\n\n|$)/.exec(ctx ?? '')?.[0] ?? '';
  const claimBlock = (ctx) => /Claimable next:[\s\S]*?(?:\n\n|$)/.exec(ctx ?? '')?.[0] ?? '';
  const blockRows = (ctx) => block(ctx).split('\n').filter((l) => /^ {2}(P0|P1|P2|--) /.test(l));

  let h = hook(urlA, C.dir);
  check('an empty board prints the banner and no Reminders heading', h.code === 0 && h.ctx !== null && h.ctx.includes(`## Lane board ${C.key}`) && !h.ctx.includes('Reminders due'), `${h.raw.slice(0, 120)}`);

  await c('add', 'zz-rmc-claim', '--title', 'Claim me', '--state', 'ready');
  await c('remind', 'set', 'zz-rmc-p1due', '--title', 'P1 due', '--at', minutes(-180), '--allow-past');
  await c('remind', 'set', 'zz-rmc-p0due', '--title', 'P0 due', '--at', minutes(-10), '--allow-past', '--pri', 'P0');
  await c('remind', 'set', 'zz-rmc-p2due', '--title', 'P2 due', '--at', minutes(-5), '--allow-past', '--pri', 'P2');
  await c('remind', 'set', 'zz-rmc-p0fut', '--title', 'P0 later', '--at', minutes(60 * 48), '--pri', 'P0');
  await c('remind', 'set', 'zz-rmc-p1fut', '--title', 'P1 later', '--at', minutes(60 * 30));
  h = hook(urlA, C.dir);
  const rows3 = blockRows(h.ctx);
  log(`dist/lane-context.mjs stdout for a real SessionStart payload (board ${C.key}, three due reminders):\n${h.raw}`);
  check('three due reminders print "## Reminders due (3)"', h.ctx?.includes('## Reminders due (3)'), block(h.ctx).split('\n')[0]);
  check('the heading sits above "Claimable next"', h.ctx !== null && h.ctx.indexOf('## Reminders due') > -1 && h.ctx.indexOf('## Reminders due') < h.ctx.indexOf('Claimable next'));
  check('the P0 row is first, then P1, then P2 (band order, not due order)',
    rows3.length === 3 && /zz-rmc-p0due/.test(rows3[0]) && /zz-rmc-p1due/.test(rows3[1]) && /zz-rmc-p2due/.test(rows3[2]), rows3.join(' | '));
  check('a reminder whose due_at is in the future is absent from the block and from Claimable next',
    !/zz-rmc-p0fut|zz-rmc-p1fut/.test(block(h.ctx)) && !/zz-rmc-p0fut|zz-rmc-p1fut/.test(claimBlock(h.ctx)) && /zz-rmc-claim/.test(claimBlock(h.ctx)), claimBlock(h.ctx).split('\n').slice(0, 4).join(' | '));
  check('the hint names the shim path, never a relative lane.mjs', /lane\.mjs remind ack <id>/.test(h.ctx ?? '') && !/node scripts\/coordination\/lane\.mjs/.test(h.ctx ?? ''));
  check('the P1 row 3 hours late says OVERDUE', /zz-rmc-p1due[^\n]*OVERDUE 3h/.test(block(h.ctx)), rows3[1]);
  check('Claimable next offers the work lane and none of the due reminder lanes',
    /zz-rmc-claim/.test(claimBlock(h.ctx)) && !/zz-rmc-p\d/.test(claimBlock(h.ctx)), claimBlock(h.ctx).split('\n').slice(0, 5).join(' | '));
  await c('remind', 'ack', 'zz-rmc-p1due');
  h = hook(urlA, C.dir);
  check('an acked past-due reminder lane is absent from Claimable next, and from the Reminders due block',
    !/zz-rmc-p1due/.test(claimBlock(h.ctx)) && !/zz-rmc-p1due/.test(block(h.ctx)) && /zz-rmc-claim/.test(claimBlock(h.ctx)), claimBlock(h.ctx).split('\n').slice(0, 5).join(' | '));
  await c('remind', 'set', 'zz-rmc-p1due', '--at', minutes(-180), '--allow-past');

  await db.query(
    `INSERT INTO agentic_os.lane (id, title, track, state, priority, project_key, band, due_at, remind_state)
     SELECT 'zz-rm-bulk-' || g, 'bulk ' || g, 'reminders', 'backlog', g, $1,
            CASE WHEN g % 3 = 0 THEN 'P0' WHEN g % 3 = 1 THEN 'P1' ELSE 'P2' END,
            CASE WHEN g <= 12 THEN now() - (g || ' minutes')::interval ELSE now() + interval '2 days' END, 'scheduled'
       FROM generate_series(1, 200) g`, [C.key]);
  h = hook(urlA, C.dir);
  const rows5 = blockRows(h.ctx);
  check('with 15 due reminders and 200 open lanes the block shows at most 5 rows, P0 first, and a "+N more" line naming `remind list`',
    rows5.length === 5 && /^ {2}P0 /.test(rows5[0]) && /\+10 more[^\n]*remind list/.test(block(h.ctx)) && h.ctx.includes('## Reminders due (15)'), `${rows5.length} rows; ${block(h.ctx).split('\n').slice(-3).join(' | ')}`);
  log(`hook wall time with 200 seeded lanes (process start, connect, all queries): ${h.ms} ms`);
  h = hook('postgresql://claude:nope@127.0.0.1:1/lanes_pr1_none', C.dir);
  check('a bad database URL prints {} and exits 0', h.code === 0 && h.raw === '{}', `exit ${h.code}: ${h.raw.slice(0, 80)}`);

  // The reminders query on its own: wall time and plan, from the SQL text in the hook source.
  const src = readFileSync(HOOK_SRC, 'utf8');
  const pred = /const REMINDER_DUE_PRED = `([\s\S]*?)`;/.exec(src)?.[1];
  const tpl = /const REMINDERS_SQL = `([\s\S]*?)`;/.exec(src)?.[1];
  const sql = pred && tpl ? tpl.replace('${REMINDER_DUE_PRED}', pred).replace("${laneOrderSql('l')}", laneOrderSql('l')) : null;
  check('the hook source defines REMINDERS_SQL and every placeholder resolves', !!sql && !sql.includes('${'), sql ? '' : 'REMINDERS_SQL not found in lane-context.ts');
  if (sql && !sql.includes('${')) {
    const t0 = performance.now();
    const res = await db.query(sql, [C.key]);
    const wall = performance.now() - t0;
    const plan = (await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, [C.key])).rows[0]['QUERY PLAN'][0];
    const uses = JSON.stringify(plan).includes('lane_due_idx');
    log(`reminders query: ${wall.toFixed(1)} ms wall, execution ${plan['Execution Time']} ms, ${res.rows.length} rows, plan uses lane_due_idx: ${uses}${uses ? '' : ' (200 rows: a sequential scan is expected on a table this small; recorded, not gated)'}`);
    check('the reminders query takes under 300 ms with 200 seeded open lanes', wall < 300 && res.rows.length === 5 && Number(res.rows[0].total) === 15, `${wall.toFixed(1)} ms, ${res.rows.length} rows`);
  }
} catch (e) {
  log(`ERROR: ${e.stack || e.message}`);
  results.push(['driver error', false]);
} finally {
  if (plain) await plain.end().catch(() => {});
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
