#!/usr/bin/env node
/**
 * band-backfill-probe -- the end-to-end gate for `lane.mjs band-backfill` (phase 6 of the lane priority design).
 *
 * Runs the REAL scripts/coordination/lane.mjs of THIS checkout as a child process against SCRATCH databases
 * (lanes_pr1_*, migrations through 5, and one through 4) that this probe creates and drops. It never touches the
 * live database. Boards come from a temp registry (probe-boards.mjs), never the real one.
 *
 *   node scripts/coordination/band-backfill-probe.mjs
 *
 * The transcript goes to .claude/cache/e2e/2026-11-06-band-backfill-e2e.txt (overwrite), or to BAND_BACKFILL_PROBE_OUT.
 * Exit 0: all checks pass. Exit 1: a check failed. Exit 2: pg is missing.
 * Design: .claudedocs/2026-11-06-lane-priority-design.md, "Backfill plan" and "Build phases", phase 6.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl, maskUrl } from './scratch-db.mjs';
import { laneEnv, makeBoards } from './probe-boards.mjs';

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  console.log('usage: node scripts/coordination/band-backfill-probe.mjs\n'
    + 'Proves lane.mjs band-backfill on throwaway lanes_pr1_* databases with the real lane.mjs. Needs a reachable\n'
    + 'Postgres and the pg package (set NODE_PATH to a folder that holds pg). Takes no other arguments.\n'
    + 'Exit 1 if a check fails, 2 if pg is missing.');
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LANE = join(HERE, 'lane.mjs');
const SCRATCH = join(HERE, 'scratch-db.mjs');
const OUT = process.env.BAND_BACKFILL_PROBE_OUT || join(REPO, '.claude', 'cache', 'e2e', '2026-11-06-band-backfill-e2e.txt');

let Client;
try {
  ({ Client } = requireDep('pg', { repoRoot: REPO }));
} catch (e) {
  console.error(`band-backfill-probe: the pg package is not available (${e.message}). Set NODE_PATH to a folder that holds pg.`);
  process.exit(2);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, '');

const log = (s = '') => { const t = String(s).replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/g, '$1***@'); appendFileSync(OUT, t + '\n'); console.log(t); };
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };

const SESSION = 'zz-bbprobe-session';
const scratch = (...args) => spawnSync(process.execPath, [SCRATCH, ...args], { encoding: 'utf8' });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const firstLine = (s) => String(s).split('\n')[0];

let boards = null; let urlA = null; let urlOld = null; let db = null;
try {
  log('# lane band-backfill: scratch database probe, 2026-11-06');
  log('# Live database: NOT touched. The real lane.mjs runs against the scratch URL below.');
  const created = scratch('create', '--through', '5');
  if (created.status !== 0) throw new Error(`scratch create failed: ${created.stderr}`);
  urlA = JSON.parse(created.stdout).url;
  assertScratchUrl(urlA);
  log(`scratch database: ${maskUrl(urlA)}`);
  boards = makeBoards('zz-bbprobe', ['a', 'b']);
  const A = boards.boards.a; const B = boards.boards.b;
  db = new Client({ connectionString: urlA });
  await db.connect();
  // The probe writes lanes directly too (a reset between checks): it says it knows about boards, like every lane writer.
  await db.query(`SELECT set_config('lane.client_version', '2', false)`);

  /** Run the real lane.mjs. `dir` is the cwd, which picks the board through the temp registry. `session` null = no session id. */
  const lane = (url, dir, args, session = SESSION) => {
    const r = spawnSync(process.execPath, [LANE, ...args], {
      cwd: dir, encoding: 'utf8', env: laneEnv(url, boards, session ? { CLAUDE_CODE_SESSION_ID: session } : {}),
    });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), all: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  };
  const a = (...args) => lane(urlA, A.dir, args);
  const aNoSession = (...args) => lane(urlA, A.dir, args, null);
  const json = (r) => { try { return JSON.parse(r.out); } catch { return null; } };

  /** Insert a lane with exact values. updated_at is pinned 30 days back, so any write that touches it shows. */
  const seed = async (id, o) => db.query(
    `INSERT INTO agentic_os.lane (id, title, track, state, priority, project_key, band, owner_session_id, lease_expires_at, updated_at)
     VALUES ($1, $2, 'zz', $3, $4, $5, $6, $7, $8, now() - interval '30 days')`,
    [id, `title ${id}`, o.state ?? 'backlog', o.priority, o.key ?? A.key, o.band ?? null, o.owner ?? null,
     o.owner ? new Date(Date.now() + 3600e3) : null],
  );
  const snapshot = async () => (await db.query(
    `SELECT id, state, priority, band, project_key, owner_session_id, updated_at::text AS updated_at FROM agentic_os.lane ORDER BY id`)).rows;
  const events = async () => (await db.query(
    `SELECT lane_id, session_id, to_session_id, body, detail, project_key FROM agentic_os.lane_event WHERE kind='band' ORDER BY id`)).rows;
  const bandOf = async (id) => (await db.query('SELECT band FROM agentic_os.lane WHERE id=$1', [id])).rows[0]?.band ?? null;
  const dist = async (key) => Object.fromEntries((await db.query(
    `SELECT COALESCE(band,'Unsorted') AS b, count(*)::int AS n FROM agentic_os.lane WHERE project_key=$1 AND state <> 'done' GROUP BY 1`, [key])).rows.map((r) => [r.b, r.n]));

  // Board a. Priority edges 1, 9, 10, 40, 41, 50, 999; a done lane; a pre-banded lane; a held lane; a lane Dave names.
  const P = (n) => `zz-bb-p${n}`;
  for (const n of [1, 9, 10, 40, 41, 50, 999]) await seed(P(n), { priority: n });
  await seed('zz-bb-done5', { priority: 5, state: 'done' });
  await seed('zz-bb-donebanded', { priority: 5, state: 'done', band: 'P2' });
  await seed('zz-bb-prebanded', { priority: 5, state: 'ready', band: 'P2' });
  await seed('zz-bb-named', { priority: 5, state: 'active', band: 'P1' });
  await seed('zz-bb-held', { priority: 7, state: 'active', owner: 'zz-bb-owner' });
  await seed('zz-bb-review12', { priority: 12, state: 'review' });
  await seed('zz-bb-blocked60', { priority: 60, state: 'blocked' });
  await seed('zz-bb-foreign', { priority: 5, key: B.key });
  const NAMED = 'zz-bb-named,zz-bb-p50';

  log('\n## refuses without a mode');
  let snap0 = await snapshot(); let ev0 = (await events()).length;
  let r = a('band-backfill');
  check('no flag: exit 1, says to use --dry-run or --apply', r.code === 1 && /--dry-run|--apply/.test(r.err), `exit ${r.code}: ${firstLine(r.err)}`);
  r = a('band-backfill', '--dry-run', '--apply', '--p0', 'none');
  check('both --dry-run and --apply: exit 1', r.code === 1 && /--dry-run|--apply/.test(r.err), `exit ${r.code}: ${firstLine(r.err)}`);
  r = a('band-backfill', '--apply', '--expect', '0');
  check('--apply without --p0: exit 1 and names --p0', r.code === 1 && /--p0/.test(r.err), `exit ${r.code}: ${firstLine(r.err)}`);
  r = a('band-backfill', '--apply', '--p0', '--expect', '0');
  check('--apply with a bare --p0: exit 1', r.code === 1 && /--p0/.test(r.err), `exit ${r.code}: ${firstLine(r.err)}`);
  r = a('band-backfill', '--apply', '--p0', '', '--expect', '0');
  check('--apply with an empty --p0 string: exit 1 (an empty list is spelled none)', r.code === 1, `exit ${r.code}: ${firstLine(r.err)}`);
  r = a('band-backfill', '--apply', '--p0', NAMED);
  check('--apply without --expect: exit 1 and names --expect', r.code === 1 && /--expect/.test(r.err), `exit ${r.code}: ${firstLine(r.err)}`);
  for (const bad of ['abc', '-1', '1.5', '']) {
    r = a('band-backfill', '--apply', '--p0', NAMED, '--expect', bad);
    check(`--apply with --expect ${JSON.stringify(bad)}: exit 1`, r.code === 1 && /--expect/.test(r.err), `exit ${r.code}: ${firstLine(r.err)}`);
  }
  r = a('band-backfill', '--apply', '--p0', NAMED, '--expect');
  check('--apply with a bare --expect: exit 1', r.code === 1 && /--expect/.test(r.err), `exit ${r.code}: ${firstLine(r.err)}`);
  check('the refusals wrote nothing', same(await snapshot(), snap0) && (await events()).length === ev0);

  log('\n## dry run: changes nothing');
  r = aNoSession('band-backfill', '--dry-run');
  check('--dry-run exits 0 with no session id (read-only)', r.code === 0, r.all);
  check('--dry-run changed no row (all columns, updated_at included) and logged no event', same(await snapshot(), snap0) && (await events()).length === ev0);
  check('the text has a band table, a triage list and says nothing was written',
    /nothing written/.test(r.out) && /Unsorted/.test(r.out) && /triage/i.test(r.out), firstLine(r.out));
  r = aNoSession('band-backfill', '--dry-run', '--json');
  const dj = json(r);
  check('--dry-run --json parses and names the board and mode', r.code === 0 && dj?.board === A.key && dj?.mode === 'dry-run', firstLine(r.out));
  const rowOf = (j, band) => j?.table?.find((x) => x.band === band);
  // Open lanes on board a: p1 p9 p10 p40 p41 p50 p999 prebanded named held review12 blocked60 = 12.
  // After the map (no --p0): P1 = p1 p9 named held (4); P2 = p10 p40 prebanded review12 (4); Unsorted = p41 p50 p999 blocked60 (4).
  check('dry-run table: now = 12 open lanes, P1 1, P2 1, Unsorted 10',
    rowOf(dj, 'P1')?.now === 1 && rowOf(dj, 'P2')?.now === 1 && rowOf(dj, 'Unsorted')?.now === 10 && rowOf(dj, 'P0')?.now === 0, JSON.stringify(dj?.table));
  check('dry-run table: after = P0 0, P1 4, P2 4, Unsorted 4 (priority edges 9 -> P1, 10 -> P2, 40 -> P2, 41 stays Unsorted)',
    rowOf(dj, 'P0')?.after === 0 && rowOf(dj, 'P1')?.after === 4 && rowOf(dj, 'P2')?.after === 4 && rowOf(dj, 'Unsorted')?.after === 4, JSON.stringify(dj?.table));
  const triageIds = (dj?.triage ?? []).map((t) => t.id);
  check('triage lists the active, ready and blocked lanes and the P1 candidates',
    ['zz-bb-named', 'zz-bb-held', 'zz-bb-prebanded', 'zz-bb-blocked60', 'zz-bb-p1', 'zz-bb-p9'].every((id) => triageIds.includes(id)), triageIds.join(','));
  check('triage leaves out done lanes, a backlog lane at priority 999 and another board', !triageIds.includes('zz-bb-done5') && !triageIds.includes('zz-bb-p999') && !triageIds.includes('zz-bb-foreign'), triageIds.join(','));
  check('the held lane is flagged held in the triage', dj?.triage?.find((t) => t.id === 'zz-bb-held')?.held === true);
  check('the done count in the dry run: 2 done lanes, 1 with a band', dj?.done?.total === 2 && dj?.done?.banded === 1, JSON.stringify(dj?.done));
  r = aNoSession('band-backfill', '--dry-run', '--p0', NAMED, '--json');
  const dp = json(r);
  check('--dry-run --p0 previews P0: P0 2, P1 3 (named leaves P1 for P0), Unsorted 3', rowOf(dp, 'P0')?.after === 2 && rowOf(dp, 'P1')?.after === 3 && rowOf(dp, 'Unsorted')?.after === 3, JSON.stringify(dp?.table));
  check('the preview says the named lane already had a band', dp?.changes?.find((c) => c.id === 'zz-bb-named')?.note && /already/.test(dp.changes.find((c) => c.id === 'zz-bb-named').note), JSON.stringify(dp?.changes?.find((c) => c.id === 'zz-bb-named')));
  check('the --p0 preview wrote nothing', same(await snapshot(), snap0) && (await events()).length === ev0);
  r = aNoSession('band-backfill', '--dry-run', '--p0', NAMED);
  check('the dry run prints the exact apply line with the change count (8) as --expect',
    /^to apply: node C:\/Users\/dkhay\/\.claude\/scripts\/lane\.mjs band-backfill --apply --p0 zz-bb-named,zz-bb-p50 --expect 8$/m.test(r.out), r.out.split('\n').filter((l) => /to apply/.test(l)).join(' | '));
  check('the --json dry run carries the same command', dp?.apply_command?.endsWith('--apply --p0 zz-bb-named,zz-bb-p50 --expect 8'), String(dp?.apply_command));
  r = aNoSession('band-backfill', '--dry-run');
  check('a dry run with no --p0 prints an apply line with --p0 none and its own count (6)', /--apply --p0 none --expect 6$/m.test(r.out), r.out.split('\n').filter((l) => /to apply/.test(l)).join(' | '));

  log('\n## a bad --p0 fails the whole run before any write');
  const badLists = [
    ['an unknown id', `${NAMED},zz-bb-nosuch`, /zz-bb-nosuch/],
    ['a done lane', `${NAMED},zz-bb-done5`, /zz-bb-done5/],
    ['a lane of another board', `${NAMED},zz-bb-foreign`, /zz-bb-foreign/],
    ['a duplicate id', 'zz-bb-p50,zz-bb-p50', /duplicate/],
    ['none mixed with an id', 'none,zz-bb-p50', /none/],
    ['an invalid id', 'Zz Bad', /not a valid lane id/],
  ];
  for (const [label, list, re] of badLists) {
    r = a('band-backfill', '--apply', '--p0', list, '--expect', '8');
    check(`${label}: exit 1, names the problem, nothing written (no auto-mapped lane either)`,
      r.code === 1 && re.test(r.err) && same(await snapshot(), snap0) && (await events()).length === ev0, `exit ${r.code}: ${firstLine(r.err)}`);
  }
  r = a('band-backfill', '--dry-run', '--p0', 'zz-bb-nosuch');
  check('a bad --p0 also fails the dry run', r.code === 1 && /zz-bb-nosuch/.test(r.err), `exit ${r.code}: ${firstLine(r.err)}`);

  log('\n## --expect: the board changed since the dry run');
  for (const wrong of ['7', '9', '0']) {
    r = a('band-backfill', '--apply', '--p0', NAMED, '--expect', wrong);
    check(`--expect ${wrong} while the plan changes 8 lanes: exit 1, says the board changed since the dry run, 0 writes`,
      r.code === 1 && /changed since the dry run/.test(r.err) && /\b8\b/.test(r.err) && same(await snapshot(), snap0) && (await events()).length === ev0,
      `exit ${r.code}: ${firstLine(r.err)}`);
  }

  log('\n## apply');
  r = a('band-backfill', '--apply', '--p0', NAMED, '--expect', '8');
  check('apply exits 0', r.code === 0, r.all);
  check('apply reports 8 rows changed and says the named lane already had a band', /8 rows? changed/.test(r.out) && /zz-bb-named.*already/.test(r.out), r.out.split('\n').slice(0, 3).join(' | '));
  check('no soft-cap warning with 2 P0 lanes', !/soft cap/i.test(r.err), r.err);
  const want = {
    'zz-bb-p1': 'P1', 'zz-bb-p9': 'P1', 'zz-bb-p10': 'P2', 'zz-bb-p40': 'P2', 'zz-bb-p41': null, 'zz-bb-p50': 'P0', 'zz-bb-p999': null,
    'zz-bb-named': 'P0', 'zz-bb-prebanded': 'P2', 'zz-bb-held': 'P1', 'zz-bb-review12': 'P2', 'zz-bb-blocked60': null,
    'zz-bb-done5': null, 'zz-bb-donebanded': 'P2', 'zz-bb-foreign': null,
  };
  const got = {}; for (const id of Object.keys(want)) got[id] = await bandOf(id);
  check('every lane has the band the map and the --p0 list give (edges 9/10/40/41, named P1 -> P0, pre-banded untouched, done untouched)', same(got, want), JSON.stringify(got));
  const snap1 = await snapshot();
  const strip = (rows) => rows.map(({ band, ...rest }) => rest);
  check('updated_at, state, priority and owner of every row are unchanged (only band moved)', same(strip(snap1), strip(snap0)));
  check('the held lane keeps its owner and state and still got a band', snap1.find((x) => x.id === 'zz-bb-held')?.owner_session_id === 'zz-bb-owner' && snap1.find((x) => x.id === 'zz-bb-held')?.state === 'active' && got['zz-bb-held'] === 'P1');
  const evAll = await events();
  const ev1 = evAll.filter((e) => e.lane_id !== null);
  const sum1 = evAll.filter((e) => e.lane_id === null);
  check('one band event per changed lane (8), none for the others', ev1.length === 8 && new Set(ev1.map((e) => e.lane_id)).size === 8, `${ev1.length} events`);
  check('each per-lane event is addressed to the caller (to_session_id = caller), so no other session reads it as unread',
    ev1.every((e) => e.to_session_id === SESSION && e.session_id === SESSION), JSON.stringify(ev1[0]));
  check('ONE broadcast summary event: kind band, no lane, no recipient, actor backfill, counts in the body',
    sum1.length === 1 && sum1[0].to_session_id === null && sum1[0].project_key === A.key && sum1[0].detail?.actor === 'backfill'
      && sum1[0].body === 'band backfill: 8 lanes banded (P0 2, P1 3, P2 3)', JSON.stringify(sum1));
  check('every per-lane event has actor backfill, kind band, the board key', ev1.every((e) => e.detail?.actor === 'backfill' && e.project_key === A.key), JSON.stringify(ev1[0]));
  const evNamed = ev1.find((e) => e.lane_id === 'zz-bb-named');
  check('the named lane event is P1 -> P0', evNamed?.detail?.from === 'P1' && evNamed?.detail?.to === 'P0', JSON.stringify(evNamed));
  const evP50 = ev1.find((e) => e.lane_id === 'zz-bb-p50');
  check('the priority-50 lane named for P0 has ONE event, none -> P0', ev1.filter((e) => e.lane_id === 'zz-bb-p50').length === 1 && evP50?.detail?.from === null && evP50?.detail?.to === 'P0', JSON.stringify(evP50));
  const after = await dist(A.key);
  check('SELECT band, count(*) over open lanes equals the dry-run "after" table with --p0',
    after.P0 === 2 && after.P1 === 3 && after.P2 === 4 && after.Unsorted === 3, JSON.stringify(after));
  check('done lanes with a band are unchanged: still 1 (the one seeded P2, still P2); the done lane at priority 5 is still NULL',
    (await db.query(`SELECT count(*)::int AS n FROM agentic_os.lane WHERE state='done' AND band IS NOT NULL`)).rows[0].n === 1 && got['zz-bb-done5'] === null);
  check('board b is untouched (its lane has no band and no event)', (await bandOf('zz-bb-foreign')) === null && ev1.every((e) => e.lane_id !== 'zz-bb-foreign'));

  log('\n## inbox: another session sees the one summary line, not 8 lines');
  const OTHER = 'zz-bbprobe-other';
  r = lane(urlA, A.dir, ['inbox', '--peek', '--json'], OTHER);
  const inboxO = json(r);
  const bandO = (inboxO ?? []).filter((e) => e.kind === 'band');
  check('another session on the board has exactly one unread band event: the summary', r.code === 0 && bandO.length === 1 && /^band backfill: 8 lanes banded/.test(bandO[0].body || ''), `${bandO.length} band events: ${JSON.stringify(bandO.map((e) => e.body))}`);
  r = lane(urlA, A.dir, ['inbox', '--peek', '--json']);
  check('the caller has no unread band event (its own events are never unread)', r.code === 0 && (json(r) ?? []).filter((e) => e.kind === 'band').length === 0, r.out.slice(0, 120));

  log('\n## second apply with the same --p0 list: idempotent');
  r = a('band-backfill', '--apply', '--p0', NAMED, '--expect', '0');
  check('second apply exits 0 and says 0 rows changed', r.code === 0 && /\b0 rows? changed/.test(r.out), r.out.split('\n')[0]);
  check('second apply changed no row, no updated_at and logged no event', same(await snapshot(), snap1) && (await events()).length === 9);
  r = a('band-backfill', '--apply', '--p0', 'none', '--expect', '0');
  check('apply with --p0 none after the backfill also changes 0 rows', r.code === 0 && /\b0 rows? changed/.test(r.out) && same(await snapshot(), snap1) && (await events()).length === 9, r.out.split('\n')[0]);
  r = a('band-backfill', '--apply', '--p0', 'none', '--expect', '0', '--json');
  const ij = json(r);
  check('apply --json: mode apply, changed 0, p0 empty', ij?.mode === 'apply' && ij?.changed === 0 && same(ij?.p0, []), firstLine(r.out));
  r = aNoSession('band-backfill', '--dry-run', '--json');
  const d2 = json(r);
  check('a dry run after the backfill shows now = after in every band', (d2?.table ?? []).length === 4 && d2.table.every((x) => x.now === x.after) && (d2?.changes ?? []).length === 0, JSON.stringify(d2?.table));

  log('\n## apply needs a session id (it logs events under it), a dry run does not');
  r = aNoSession('band-backfill', '--apply', '--p0', 'none', '--expect', '0');
  check('apply with no session id exits 1', r.code === 1 && /session id/i.test(r.err), `exit ${r.code}: ${firstLine(r.err)}`);

  log('\n## P0 over the soft cap of 5: warn on stderr, still apply');
  for (const n of [1, 2, 3, 4, 5]) await seed(`zz-bb-cap${n}`, { priority: 80 });
  r = a('band-backfill', '--apply', '--p0', 'zz-bb-cap1,zz-bb-cap2,zz-bb-cap3,zz-bb-cap4,zz-bb-cap5', '--expect', '5');
  check('7 open P0 lanes (2 already + 5 named): exit 0 and a stderr warning that names the cap', r.code === 0 && /soft cap/i.test(r.err) && /7/.test(r.err), `exit ${r.code}: ${firstLine(r.err)}`);
  check('the over-cap run still wrote the 5 P0 bands', (await dist(A.key)).P0 === 7);
  r = aNoSession('band-backfill', '--dry-run');
  check('a dry run also warns when P0 is over the cap', /soft cap/i.test(r.err), r.err);

  log('\n## a row lock held by another transaction: apply gives up in seconds and writes nothing');
  await seed('zz-bb-lk', { priority: 5 });
  const lockSnap = await snapshot(); const lockEv = (await events()).length;
  const holdLock = async (id) => {
    const h = new Client({ connectionString: urlA });
    await h.connect();
    await h.query('BEGIN');
    await h.query('SELECT 1 FROM agentic_os.lane WHERE id=$1 FOR UPDATE', [id]);
    return { release: async () => { await h.query('ROLLBACK'); await h.end(); } };
  };
  let held = await holdLock('zz-bb-done5');
  let t0 = Date.now();
  r = a('band-backfill', '--apply', '--p0', 'none', '--expect', '1');
  let secs = (Date.now() - t0) / 1000;
  await held.release();
  check('a lock on a DONE lane does not block the apply (only open rows are locked)', r.code === 0 && /1 row changed/.test(r.out) && secs < 4, `exit ${r.code}, ${secs}s: ${firstLine(r.all)}`);
  await db.query(`UPDATE agentic_os.lane SET band=NULL WHERE id='zz-bb-lk'`);
  await db.query(`DELETE FROM agentic_os.lane_event WHERE lane_id='zz-bb-lk' OR (lane_id IS NULL AND kind='band' AND body LIKE 'band backfill: 1 lane%')`);
  held = await holdLock('zz-bb-lk');
  t0 = Date.now();
  r = a('band-backfill', '--apply', '--p0', 'none', '--expect', '1');
  secs = (Date.now() - t0) / 1000;
  await held.release();
  check('a lock on an OPEN lane: apply exits 1 within 8s, says another transaction holds a lock, wrote nothing',
    r.code === 1 && /lock/i.test(r.err) && /nothing was written/i.test(r.err) && secs < 8 && same(await snapshot(), lockSnap) && (await events()).length === lockEv, `exit ${r.code}, ${secs}s: ${firstLine(r.err)}`);
  r = a('band-backfill', '--apply', '--p0', 'none', '--expect', '1');
  check('with the lock released, the same apply works', r.code === 0 && /1 row changed/.test(r.out) && (await bandOf('zz-bb-lk')) === 'P1', r.all);

  log('\n## a database without migration 0005');
  const old = scratch('create', '--through', '4');
  if (old.status !== 0) throw new Error(`scratch create (through 4) failed: ${old.stderr}`);
  urlOld = JSON.parse(old.stdout).url;
  assertScratchUrl(urlOld);
  const o = (args, session) => lane(urlOld, A.dir, args, session);
  o(['add', 'zz-bb-old', '--title', 'old db', '--priority', '5']);
  r = o(['band-backfill', '--dry-run'], null);
  check('dry run on a 0004 database works and says migration 0005 is not applied', r.code === 0 && /0005/.test(r.all), `exit ${r.code}: ${firstLine(r.all)}`);
  r = o(['band-backfill', '--apply', '--p0', 'none', '--expect', '0']);
  check('apply on a 0004 database exits 1 and says migration 0005 is not applied', r.code === 1 && /0005/.test(r.err), `exit ${r.code}: ${firstLine(r.err)}`);
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
