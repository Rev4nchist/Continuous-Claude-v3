/**
 * export-dash-data.db.test -- end to end tests for export-dash-data.mjs against a SCRATCH database.
 *
 *   node --test scripts/coordination/export-dash-data.db.test.mjs
 *
 * Pattern: scripts/coordination/lane-project.test.mjs. This file creates a lanes_pr1_* database through
 * scratch-db.mjs, inserts fixture lanes and events directly, runs the REAL export script as a child
 * process, and drops the database. It never reads or writes the live lanes: every URL goes through
 * assertScratchUrl before it is used.
 *
 * Fixtures cover: a repeat done, a done lane that was reopened, a greymatter-design lane (other board),
 * a lane with zero events, a lane created at 23:30 CT on 10-31, a lane done on 11-01 (DST), a note-only lane,
 * a stale lane.note, an ask older than the last claim, a kanban "Waiting on Dave" ask, a reassigned lane,
 * and secrets that must never reach the output.
 * Flow fixtures (px-3 reopened twice, px-4 done before the week and reopened inside it, py-edge 7 days ago, py-early-done,
 * py-quick, py-slow) are dated from the clock, so the flow.json oracles always see events inside the grid, the week and
 * on the edge of the week. px-2 keeps its fixed dates for the lane-state tests; no flow oracle depends on it.
 *
 * Not in package.json test:scripts (it needs a local Postgres), like lane-project.test.mjs.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl } from './scratch-db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const EXPORT = path.join(HERE, 'export-dash-data.mjs');
const SCRATCH = path.join(HERE, 'scratch-db.mjs');
const { Client } = requireDep('pg', { repoRoot: REPO });

const S1 = 'aaaa1111-0000-4000-8000-000000000001';
const S2 = 'bbbb2222-0000-4000-8000-000000000002';
const S3 = 'abcdef12-3456-4890-abcd-ef1234567890';
const HANDLES = ['aaaa1111', 'bbbb2222', 'abcdef12'];

const state = { url: '', tmp: '', db: null, rules: '', ids: '', idRoot: '' };
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** An ISO time `days` days and `hours` hours before the clock. Flow fixtures use it so they stay inside the grid. */
const ago = (days, hours = 0) => new Date(Date.now() - days * DAY_MS + hours * HOUR_MS).toISOString();
/** Chicago noon `days` days ago, plus `hours`, as an ISO time. Noon keeps a fixture on its day: no midnight or DST edge. */
async function noon(days, hours = 0) {
  const { rows } = await q(
    `SELECT ((date_trunc('day', now() AT TIME ZONE 'America/Chicago') - make_interval(days => $1::int) + interval '12 hours') AT TIME ZONE 'America/Chicago')
       + $2::float8 * interval '1 hour' AS t`,
    [days, hours],
  );
  return rows[0].t.toISOString();
}
const q = (sql, params) => state.db.query(sql, params);

function createScratch(through) {
  const r = spawnSync(process.execPath, [SCRATCH, 'create', '--through', String(through)], { encoding: 'utf8' });
  assert.equal(r.status, 0, `scratch create failed: ${r.stderr}`);
  const { url } = JSON.parse(r.stdout);
  assertScratchUrl(url);
  return url;
}
function dropScratch(url) {
  assertScratchUrl(url);
  spawnSync(process.execPath, [SCRATCH, 'drop', url], { encoding: 'utf8' });
}

/** Run the real export script. Refuses any database that is not a scratch one. */
function runExport(args, extraEnv = {}) {
  const url = extraEnv.CONTINUOUS_CLAUDE_DB_URL ?? state.url;
  assertScratchUrl(url);
  // CCV3_IDENTITY_DIR: a temp folder, so the export never reads a live session name.
  const env = { ...process.env, CONTINUOUS_CLAUDE_DB_URL: url, DATABASE_URL: url, OPC_POSTGRES_URL: url, CCV3_IDENTITY_DIR: state.ids, LANE_EXPORT_ID_ROOT: state.idRoot, ...extraEnv };
  const r = spawnSync(process.execPath, [EXPORT, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}
const outDir = (name) => path.join(state.tmp, name);
const readDoc = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
const readAll = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

async function addLane(o) {
  const l = {
    track: 'unsorted', state: 'backlog', priority: 50, scope: null, rationale: null, done_when: null, note: null,
    owner: null, lease: null, band: null, board: 'continuous-claude', ...o,
  };
  await q(
    `INSERT INTO agentic_os.lane (id, title, track, scope, state, priority, owner_session_id, lease_expires_at, note, rationale, done_when, band, project_key, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
    [l.id, l.title ?? `Title of ${l.id}`, l.track, l.scope, l.state, l.priority, l.owner, l.lease, l.note, l.rationale, l.done_when, l.band, l.board, l.created],
  );
}
async function addEvent(laneId, kind, at, o = {}) {
  await q(
    `INSERT INTO agentic_os.lane_event (occurred_at, lane_id, kind, session_id, body, detail, project_key) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [at, laneId, kind, o.session ?? S1, o.body ?? null, JSON.stringify(o.detail ?? {}), o.board ?? 'continuous-claude'],
  );
}

before(async () => {
  state.url = createScratch(5);
  state.tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dash-export-db-')));
  state.db = new Client({ connectionString: state.url });
  await state.db.connect();
  state.rules = path.join(state.tmp, 'rules.json');
  state.ids = path.join(state.tmp, 'identity');
  fs.mkdirSync(state.ids);
  // A listed-id root: one listed sha, 'abcdef1', which is a prefix of the sid8 of S3 ('abcdef12'). A label of S3 must come out masked.
  state.idRoot = path.join(state.tmp, 'idroot');
  fs.mkdirSync(path.join(state.idRoot, '.claudedocs'), { recursive: true });
  fs.mkdirSync(path.join(state.idRoot, 'scripts', 'eval', 'review-eval'), { recursive: true });
  fs.writeFileSync(path.join(state.idRoot, '.claudedocs', '2026-11-01-pr-review-dataset.json'), JSON.stringify({ findings: [{ pr: 4242, round: 'abcdef1' }] }));
  fs.writeFileSync(path.join(state.idRoot, 'scripts', 'eval', 'review-eval', 'config.json'), '{}');
  fs.writeFileSync(path.join(state.ids, `${S1}.json`), JSON.stringify({ uuid: S1, name: 'Builder one' }));
  fs.writeFileSync(path.join(state.ids, `${S3}.json`), JSON.stringify({ uuid: S3, name: 'Gone session' }));
  fs.writeFileSync(state.rules, JSON.stringify({
    version: 1,
    projects: [
      { key: 'proj-x', name: 'X', goal: 'gx', done: 'dx', idRe: '^px-', terminalLanes: ['px-1', 'px-2'] },
      { key: 'proj-y', name: 'Y', goal: 'gy', done: 'dy', idRe: '^py-', next_goal: 'Ship Y next.' },
      { key: 'proj-z', name: 'Z', goal: 'gz', done: 'dz', idRe: '^pz-', terminalLanes: ['pz-1'], parked: true },
    ],
  }));

  // proj-x: px-1 created 23:30 CT on 10-31, done twice (repeat done). px-2 done then reopened.
  await addLane({ id: 'px-1', state: 'done', created: '2026-11-01T04:30:00Z', band: 'P1', done_when: 'SECRET-DONE-WHEN' });
  await addEvent('px-1', 'claimed', '2026-11-01T05:00:00Z', { detail: { fence: 1 } });
  await addEvent('px-1', 'done', '2026-11-01T06:30:00Z');
  await addEvent('px-1', 'done', '2026-11-02T05:30:00Z');
  await addLane({ id: 'px-2', state: 'ready', created: '2026-11-01T18:00:00Z' });
  await addEvent('px-2', 'done', '2026-11-01T18:30:00Z');
  await addEvent('px-2', 'state_changed', '2026-11-02T18:00:00Z', { body: 'px-2 -> ready' });
  // proj-z: finished 2026-10-21.
  await addLane({ id: 'pz-1', state: 'done', created: '2026-10-20T15:00:00Z' });
  await addEvent('pz-1', 'done', '2026-10-21T15:00:00Z');
  // proj-y lanes
  await addLane({ id: 'py-1', created: '2026-11-03T15:00:00Z', band: 'P0' });
  await addLane({ id: 'py-note', created: '2026-11-04T15:00:00Z', scope: 'SECRET-SCOPE', rationale: 'SECRET-RATIONALE', note: 'SECRET-NOTE needs Dave' });
  await addEvent('py-note', 'note', '2026-11-05T15:00:00Z', { body: 'Needs Dave: SECRET-BODY decide' });
  await addLane({ id: 'py-stale', created: '2026-11-04T15:00:00Z', note: 'needs Dave, old' });
  await addLane({ id: 'py-ask-claim', state: 'active', created: '2026-11-02T15:00:00Z', owner: S3, lease: '2026-11-04T11:30:00Z' });
  await addEvent('py-ask-claim', 'note', '2026-11-03T10:00:00Z', { body: 'waiting on Dave for the key' });
  await addEvent('py-ask-claim', 'claimed', '2026-11-04T10:00:00Z', { session: S3, detail: { fence: 2 } });
  await addLane({ id: 'py-ask-latest', created: '2026-11-01T15:00:00Z' });
  await addEvent('py-ask-latest', 'note', '2026-11-02T15:00:00Z', { body: 'Needs Dave: first ask' });
  // The real kanban-apply shape: body "<text> || before: <old note>", detail.text is the reason.
  await addEvent('py-ask-latest', 'kanban', '2026-11-07T15:00:00Z', {
    body: 'Waiting on Dave (kanban) || before: status line', detail: { kind: 'note', to: 'Waiting on Dave (kanban) || before: status line', text: 'moved into waiting' },
  });
  await addEvent('py-ask-latest', 'note', '2026-11-07T16:00:00Z', { body: 'just a status line' });
  // M1: the old note kept after " || before:" is not an ask. A kanban card note is not an ask. A negation is not an ask.
  await addLane({ id: 'py-before-only', created: '2026-11-02T15:00:00Z' });
  await addEvent('py-before-only', 'note', '2026-11-06T15:00:00Z', { body: 'status line || before: Needs Dave: an old ask' });
  await addLane({ id: 'py-kb-card', created: '2026-11-02T15:00:00Z' });
  await addEvent('py-kb-card', 'kanban', '2026-11-06T15:00:00Z', {
    body: 'Needs Dave to pick || before: x', detail: { kind: 'note', to: 'Needs Dave to pick || before: x', text: 'kanban card' },
  });
  await addLane({ id: 'py-negation', created: '2026-11-02T15:00:00Z' });
  await addEvent('py-negation', 'note', '2026-11-06T15:00:00Z', { body: 'This no longer needs Dave' });
  await addEvent('py-negation', 'kanban', '2026-11-06T16:00:00Z', {
    body: 'No longer waiting on Dave', detail: { kind: 'note', to: 'No longer waiting on Dave', text: 'kanban card' },
  });
  await addLane({ id: 'py-notice', created: '2026-11-02T15:00:00Z' });
  await addEvent('py-notice', 'note', '2026-11-06T17:00:00Z', { body: 'Notice: needs Dave to choose' });
  // H1: kanban-apply marks a lane done with kind 'kanban' {kind:'state', to:'done'} and never kind 'done'.
  await addLane({ id: 'py-kdone', state: 'done', created: '2026-11-05T15:00:00Z' });
  await addEvent('py-kdone', 'kanban', '2026-11-06T15:00:00Z', {
    body: 'py-kdone state review -> done', detail: { kind: 'state', from: 'review', to: 'done', text: 'kanban card' },
  });
  // fleetops-category-expand: a held lane with a live lease and a GOAL note; a held parked lane.
  const live = new Date(Date.now() + 2 * HOUR_MS).toISOString();
  await addLane({ id: 'py-held', state: 'active', created: '2026-11-04T15:00:00Z', owner: S1, lease: live,
    note: 'GOAL: build the expand rows. | NEXT: run 34/34 at abc1234 SECRET-TAIL' });
  await addLane({ id: 'py-parked', state: 'review', created: '2026-11-04T15:00:00Z', owner: S1, lease: live,
    note: 'PARKED until 2026-11-20 09:00 CST -- SECRET-REASON || GOAL: wait for the seat.' });
  // M2: a session handle in a title must be masked.
  await addLane({ id: 'py-title', created: '2026-11-04T15:00:00Z', title: `Resume session #aaaa1111 handoff #12 and #abcdef12 ${'tail '.repeat(60)}end` });
  await addLane({ id: 'py-reassign', created: '2026-11-01T15:00:00Z' });
  await addEvent('py-reassign', 'claimed', '2026-11-02T15:00:00Z', { session: S1 });
  await addEvent('py-reassign', 'claimed', '2026-11-03T15:00:00Z', { session: S2 });
  await addEvent('py-reassign', 'claimed', '2026-11-04T15:00:00Z', { session: S2 });
  await addLane({ id: 'py-kanban', created: '2026-11-01T15:00:00Z' });
  await addEvent('py-kanban', 'kanban', '2026-11-06T15:00:00Z', { body: 'x', detail: { text: 'now #0' } });
  await addEvent('py-kanban', 'kanban', '2026-11-06T16:00:00Z', { body: 'x', detail: { text: 'now #1' } });
  // Another board: must not appear anywhere.
  await addLane({ id: 'gm-1', board: 'greymatter-design', created: '2026-11-01T15:00:00Z', state: 'done' });
  await addEvent('gm-1', 'claimed', '2026-11-02T15:00:00Z', { board: 'greymatter-design' });
  await addEvent('gm-1', 'done', '2026-11-03T15:00:00Z', { board: 'greymatter-design' });
  // Flow fixtures, dated from the clock. px-3: done, reopened (state_changed), done again, reopened by a kanban move (state to review).
  await addLane({ id: 'px-3', state: 'ready', created: ago(5) });
  await addEvent('px-3', 'done', ago(4));
  await addEvent('px-3', 'state_changed', ago(4, 1), { body: 'px-3 -> ready' });
  await addEvent('px-3', 'done', ago(3));
  await addEvent('px-3', 'kanban', ago(3, 1), { body: 'px-3 state done -> review', detail: { kind: 'state', from: 'done', to: 'review', text: 'kanban card' } });
  // py-quick and py-slow: done in the week, 1.5 h and 3.5 h after the first claim (an even count: the median is 2.5 h). py-quick is claimed twice on one day.
  await addLane({ id: 'py-quick', state: 'done', created: ago(3) });
  await addEvent('py-quick', 'claimed', ago(2), { detail: { fence: 1 } });
  await addEvent('py-quick', 'claimed', ago(2, 0.25), { detail: { fence: 2 } });
  await addEvent('py-quick', 'done', ago(2, 1.5));
  await addLane({ id: 'py-slow', state: 'done', created: ago(3) });
  await addEvent('py-slow', 'claimed', ago(2), { detail: { fence: 1 } });
  await addEvent('py-slow', 'done', ago(2, 3.5));
  // py-early-done: its done time is before its first claim (left out of the median).
  await addLane({ id: 'py-early-done', state: 'done', created: ago(3) });
  await addEvent('py-early-done', 'done', ago(2, -5));
  await addEvent('py-early-done', 'claimed', ago(1), { detail: { fence: 1 } });
  // px-4 has the px-2 shape on clock dates: done 9 days ago (before the week), reopened 4 days ago (inside it). Its reopen is not in the rework rate.
  await addLane({ id: 'px-4', state: 'ready', created: await noon(10) });
  await addEvent('px-4', 'done', await noon(9));
  await addEvent('px-4', 'state_changed', await noon(4), { body: 'px-4 -> ready' });
  // py-edge: claimed and done 7 days ago. It is in the 14-day grid and one day outside the week, so the week oracles pin the edge.
  await addLane({ id: 'py-edge', state: 'done', created: await noon(9) });
  await addEvent('py-edge', 'claimed', await noon(7, -1), { detail: { fence: 1 } });
  await addEvent('py-edge', 'done', await noon(7));
});

after(async () => {
  await state.db?.end().catch(() => {});
  if (state.url) dropScratch(state.url);
});

const ALLOWED_LANE_KEYS = [
  'band', 'claims', 'created_at', 'created_day', 'dave_ask_at', 'done_at', 'done_day', 'first_claim_at', 'has_done_when',
  'held', 'id', 'last_work_at', 'lease_expires_at', 'priority', 'project', 'state', 'terminal', 'title', 'track',
];
const HELD_LANE_KEYS = [...ALLOWED_LANE_KEYS, 'goal', 'holder', 'holder_label', 'parked'].sort();
/** The keys that may hold a session handle ("name #sid8"). Nothing else in any document may. */
const LABEL_KEYS = ['by', 'closed_by', 'holder_label'];
const laneKeys = (l) => (l.state === 'done' ? [...(l.held ? HELD_LANE_KEYS : ALLOWED_LANE_KEYS), 'closed_by'] : (l.held ? HELD_LANE_KEYS : ALLOWED_LANE_KEYS)).sort();

describe('export-dash-data.mjs against a scratch database', () => {
  let dir;
  let run;
  before(() => {
    dir = outDir('run1');
    run = runExport(['--out', dir, '--rules', state.rules]);
  });

  it('exits 0 and writes the eight documents plus the refresh doc', () => {
    // Breaks if the script fails on the fixture or skips a document (tiles.json and flow.json included).
    assert.equal(run.code, 0, run.all);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['assignments-all.json', 'assignments.json', 'flow.json', 'lanes-all.json', 'lanes.json', 'meta.json', 'projects.json', 'refresh.json', 'snapshots.json', 'targets.json', 'tiles.json']);
  });

  it('tiles.json: flat rows from the real database figures, titles allowed, no handle, TREX name stripped', () => {
    // Breaks if tiles are built from stale data, a title is dropped, or a handle or "(parked)" reaches the tiles.
    const tiles = readDoc(dir, 'tiles');
    const ids = new Set(tiles.rows.map((r) => r.id));
    assert.equal(ids.size, tiles.rows.length);
    const get = (id) => tiles.rows.find((r) => r.id === id);
    const meta = readDoc(dir, 'meta').rows[0];
    assert.equal(tiles.exportedAt, meta.exported_at);
    assert.equal(get('wait.count.label').text, `of ${meta.open_check} open`);
    assert.ok(tiles.rows.some((r) => r.id.startsWith('wait.row.') && r.id.endsWith('.title') && /^Title of /.test(r.text)));
    assert.ok(!/#[0-9a-f]{8}/i.test(JSON.stringify(tiles)));
    assert.ok(!JSON.stringify(tiles).includes('(parked)'));
  });

  it('every document has the same exportedAt and the envelope shape {sql, exportedAt, rows}', () => {
    // Breaks if exportedAt is taken per file instead of once.
    const stamps = new Set();
    for (const d of ['lanes', 'assignments', 'projects', 'targets', 'meta', 'snapshots', 'tiles', 'flow']) {
      const doc = readDoc(dir, d);
      assert.deepEqual(Object.keys(doc).sort(), ['exportedAt', 'rows', 'sql'], d);
      assert.equal(typeof doc.sql, 'string');
      stamps.add(doc.exportedAt);
    }
    assert.equal(stamps.size, 1);
  });

  it('lanes rows have exactly the allowlisted keys and only this board (greymatter-design is absent)', () => {
    // Breaks if a column such as note, scope, rationale or done_when text is added, or the board filter is lost.
    const lanes = readDoc(dir, 'lanes-all').rows;
    for (const l of lanes) assert.deepEqual(Object.keys(l).sort(), laneKeys(l), l.id);
    // The written lanes.json is the open subset of the full list (fleetops-lanes-file-size).
    assert.deepEqual(readDoc(dir, 'lanes').rows.map((l) => l.id).sort(), lanes.filter((l) => l.state !== 'done').map((l) => l.id).sort());
    assert.deepEqual(lanes.map((l) => l.id).sort(), ['px-1', 'px-2', 'px-3', 'px-4', 'py-1', 'py-ask-claim', 'py-ask-latest', 'py-before-only', 'py-early-done', 'py-edge', 'py-held', 'py-kanban', 'py-kb-card', 'py-kdone', 'py-negation', 'py-note', 'py-notice', 'py-parked', 'py-quick', 'py-reassign', 'py-slow', 'py-stale', 'py-title', 'pz-1']);
    assert.ok(!readAll(dir).includes('gm-1'));
  });

  it('privacy: no note, scope, rationale, done_when text, event body or session handle in any document', () => {
    // Breaks if any text column or an 8-hex session handle is exported.
    // lane-export-per-session: a handle may stand only in the three label keys. The text below has those values cut out first.
    const text = readAll(dir).replace(/"(?:by|closed_by|holder_label)":(?:"(?:[^"\\]|\\.)*"|null)/g, '"label":null');
    for (const secret of ['SECRET', ...HANDLES, S1, S2, S3]) assert.ok(!text.includes(secret), `leaked ${secret}`);
    assert.ok(!/"handle"/.test(text));
    for (const raw of [S1, S2, S3]) assert.ok(!readAll(dir).includes(raw), `raw session id in a label key: ${raw}`);
    assert.equal(readDoc(dir, 'lanes-all').rows.find((l) => l.id === 'px-1').has_done_when, true);
  });

  it('a held lane exports only its GOAL sentence and session name; a gone holder is not named; the raw note never passes', () => {
    // Breaks if the note leaks (SHA, test counts, park reason), the uuid leaks, or an ended lease still names the holder.
    const rows = readDoc(dir, 'lanes-all').rows;
    const held = rows.find((l) => l.id === 'py-held');
    assert.deepEqual([held.goal, held.holder, held.parked], ['build the expand rows.', 'Builder one', false]);
    const parked = rows.find((l) => l.id === 'py-parked');
    assert.deepEqual([parked.goal, parked.holder, parked.parked], ['wait for the seat.', 'Builder one', true]);
    const gone = rows.find((l) => l.id === 'py-ask-claim');
    assert.deepEqual([gone.goal, gone.holder, gone.parked], [null, null, false]);
    // lane-export-per-session: a claim label (by, closed_by) names its session on purpose, gone or not. The holder keys stay empty for a gone holder (asserted above).
    const text = readAll(dir).replace(/"sql":\s*"(?:[^"\\]|\\.)*"/g, '').replace(/"(?:by|closed_by|holder_label)":(?:"(?:[^"\\]|\\.)*"|null)/g, '"label":null');
    for (const bad of ['abc1234', '34/34', 'SECRET-TAIL', 'SECRET-REASON', 'Gone session']) assert.ok(!text.includes(bad), `leaked ${bad}`);
  });

  it('projects rows carry next_goal from the rules', () => {
    // Breaks if next_goal is dropped between lane-projects.json and projects.json.
    const p = readDoc(dir, 'projects').rows;
    assert.equal(p.find((r) => r.key === 'proj-y').next_goal, 'Ship Y next.');
    assert.equal(p.find((r) => r.key === 'proj-x').next_goal, '');
  });

  it('masks a #<8 hex> session handle in a title and keeps other #numbers (M2)', () => {
    // Breaks if the title is exported as it is: a handle in a lane title would reach the dashboard.
    const t = readDoc(dir, 'lanes-all').rows.find((l) => l.id === 'py-title').title;
    assert.ok(t.startsWith('Resume session #[handle] handoff #12 and #[handle] tail'), t);
    assert.ok(!/#[0-9a-f]{8}/.test(t));
  });

  it('cuts a long title at a word boundary within TITLE_MAX (not at 110 characters mid-word)', () => {
    // Breaks if the SQL still cuts at 110, the export does not cut at all, or the cut splits a word.
    const t = readDoc(dir, 'lanes-all').rows.find((l) => l.id === 'py-title').title;
    assert.ok(t.length > 110 && t.length <= 160, `length ${t.length}`);
    assert.ok(t.endsWith('…'));
    assert.match(t.slice(0, -1), /\btail$/);
  });

  it('repeat done counts the lane once and takes the latest done event; day buckets are America/Chicago', () => {
    // Breaks if done_at is the first done event, or the day is the UTC date.
    const px1 = readDoc(dir, 'lanes-all').rows.find((l) => l.id === 'px-1');
    assert.equal(px1.state, 'done');
    assert.equal(px1.done_at, '2026-11-02T05:30:00.000Z');
    assert.equal(px1.done_day, '2026-11-01'); // 23:30 CST on 11-01, not 11-02
    assert.equal(px1.created_day, '2026-10-31'); // 23:30 CDT on 10-31, not 11-01
    assert.equal(px1.first_claim_at, '2026-11-01T05:00:00.000Z');
    assert.equal(px1.claims, 1);
    const meta = readDoc(dir, 'meta').rows[0];
    assert.equal(meta.done_check, 7); // px-1, pz-1, py-kdone, py-quick, py-slow, py-early-done and py-edge
    assert.equal(meta.done_event_lanes, 10); // those 7, plus px-2, px-3 and px-4 (reopened): distinct lane ids, not one per event
  });

  it('a done lane that was reopened has done_at null and counts as open', () => {
    // Breaks if done_at is "any done event" instead of "done event while state = done".
    const px2 = readDoc(dir, 'lanes-all').rows.find((l) => l.id === 'px-2');
    assert.equal(px2.state, 'ready');
    assert.equal(px2.done_at, null);
    assert.equal(px2.done_day, null);
    assert.equal(px2.last_work_at, '2026-11-02T18:00:00.000Z');
    assert.equal(readDoc(dir, 'meta').rows[0].open_check, 17);
  });

  it('a lane with zero events has null timestamps and zero claims', () => {
    // Breaks if the events join drops lanes that have no events.
    const l = readDoc(dir, 'lanes-all').rows.find((x) => x.id === 'py-1');
    assert.equal(l.first_claim_at, null);
    assert.equal(l.last_work_at, null);
    assert.equal(l.dave_ask_at, null);
    assert.equal(l.claims, 0);
    assert.equal(l.band, 'P0');
  });

  it('notes do not count as work (defect d)', () => {
    // Breaks if last_work includes kind note (export-c.mjs:27).
    const l = readDoc(dir, 'lanes-all').rows.find((x) => x.id === 'py-note');
    assert.equal(l.last_work_at, null);
  });

  it('dave_ask_at is the time of the latest needs-Dave EVENT, never lane.note (defect c)', () => {
    // Breaks if the export reads lane.note, or takes the earliest ask, or ignores kanban asks, or counts any later note.
    const by = Object.fromEntries(readDoc(dir, 'lanes-all').rows.map((l) => [l.id, l]));
    assert.equal(by['py-note'].dave_ask_at, '2026-11-05T15:00:00.000Z');
    assert.equal(by['py-stale'].dave_ask_at, null, 'lane.note says needs Dave but no event does');
    assert.equal(by['py-ask-latest'].dave_ask_at, '2026-11-07T15:00:00.000Z');
    assert.equal(by['py-ask-claim'].dave_ask_at, '2026-11-03T10:00:00.000Z');
    assert.equal(by['py-ask-claim'].last_work_at, '2026-11-04T10:00:00.000Z', 'the ask is older than the claim but stays exported');
    assert.ok(!('dave_note' in by['py-note']));
  });

  it('dave_ask_at reads only the text before " || before:", and only a "moved into waiting" kanban event (M1)', () => {
    // Breaks if the match runs on the kept old note, a kanban card note counts, or a negation counts.
    const by = Object.fromEntries(readDoc(dir, 'lanes-all').rows.map((l) => [l.id, l]));
    assert.equal(by['py-before-only'].dave_ask_at, null, 'the ask is only in the kept old note');
    assert.equal(by['py-kb-card'].dave_ask_at, null, 'a kanban card note is not a move into waiting');
    assert.equal(by['py-negation'].dave_ask_at, null, '"no longer needs Dave" is not an ask');
    assert.equal(by['py-notice'].dave_ask_at, '2026-11-06T17:00:00.000Z', '"Notice:" holds the letters "not" and is still an ask');
  });

  it('a lane marked done by kanban-apply (kind kanban, state to done) has done_at, done_day and last_work_at (H1)', () => {
    // Breaks if done_ev or last_work read only kind 'done': the lane is state done with no done_at and the open count check fails.
    const l = readDoc(dir, 'lanes-all').rows.find((x) => x.id === 'py-kdone');
    assert.equal(l.state, 'done');
    assert.equal(l.done_at, '2026-11-06T15:00:00.000Z');
    assert.equal(l.done_day, '2026-11-06');
    assert.equal(l.last_work_at, '2026-11-06T15:00:00.000Z');
  });

  it('assignments: no handle key, reassigned computed in SQL, Dave placements de-duplicated per lane and day', () => {
    // Breaks if the handle column returns, reassigned is dropped, or Dave rows are not de-duplicated.
    const rows = readDoc(dir, 'assignments-all').rows; // lane-export-retention: the fixture claims are older than the window, so the full list is read
    for (const r of rows) assert.ok(!('handle' in r), JSON.stringify(r));
    const claims = rows.filter((r) => r.who === 'session');
    assert.equal(claims.length, 10); // px-1, py-ask-claim, 3 on py-reassign, 2 on py-quick, py-slow, py-early-done, py-edge
    assert.deepEqual(claims.filter((r) => r.lane_id === 'py-reassign').map((r) => r.reassigned), [false, true, false]);
    assert.equal(claims.find((r) => r.lane_id === 'py-ask-claim').how, 'reclaim');
    assert.equal(claims.find((r) => r.lane_id === 'px-1').how, 'claim');
    const dave = rows.filter((r) => r.who === 'dave');
    assert.equal(dave.length, 1);
    assert.equal(dave[0].how, 'placed in Now');
    assert.equal(dave[0].day, '2026-11-06');
  });

  it('G6 claim rows carry by = "name #sid8"; Dave rows carry none; the old keys keep their values; a listed sid8 is masked with the name kept', () => {
    // Breaks if a claim loses its session label, a uuid or a bare handle leaks, a Dave row gets a label, or the S3 label bypasses the mask.
    const rows = readDoc(dir, 'assignments-all').rows;
    for (const r of rows) assert.deepEqual(Object.keys(r).sort(), r.who === 'session' ? ['at', 'by', 'day', 'how', 'lane_id', 'reassigned', 'who'] : ['at', 'day', 'how', 'lane_id', 'reassigned', 'who'], JSON.stringify(r));
    const by = (id) => rows.filter((r) => r.who === 'session' && r.lane_id === id).map((r) => r.by);
    assert.deepEqual(by('py-reassign'), ['Builder one #aaaa1111', '#bbbb2222', '#bbbb2222']);
    assert.deepEqual(by('px-1'), ['Builder one #aaaa1111']);
    const gone = by('py-ask-claim');
    assert.equal(gone.length, 1);
    assert.ok(gone[0].startsWith('Gone session '), gone[0]);
    assert.ok(gone[0].includes('masked-id') && !gone[0].includes('abcdef12'), gone[0]);
  });

  it('G7 closed_by is on done lanes only, from the latest done signal (kind done or a kanban move to done), and only in lanes-all', () => {
    // Breaks if closed_by reaches the capped lanes.json, a reopened lane keeps one, or a kanban done is not read.
    const all = readDoc(dir, 'lanes-all').rows;
    const get = (id) => all.find((l) => l.id === id);
    assert.equal(get('px-1').closed_by, 'Builder one #aaaa1111');
    assert.equal(get('py-kdone').closed_by, 'Builder one #aaaa1111');
    assert.equal(get('py-edge').closed_by, 'Builder one #aaaa1111');
    assert.ok(!('closed_by' in get('px-2')), 'px-2 was reopened: no closed_by');
    for (const l of all.filter((x) => x.state !== 'done')) assert.ok(!('closed_by' in l), l.id);
    for (const l of readDoc(dir, 'lanes').rows) assert.ok(!('closed_by' in l), `lanes.json carries closed_by on ${l.id}`);
  });

  it('G8 holder_label is on held lanes: the live lease gives "name #sid8", an ended lease gives null', () => {
    // Breaks if a gone session is named again, or holder (name only, no handle) is changed.
    const all = readDoc(dir, 'lanes-all').rows;
    const get = (id) => all.find((l) => l.id === id);
    assert.equal(get('py-held').holder_label, 'Builder one #aaaa1111');
    assert.equal(get('py-held').holder, 'Builder one');
    assert.equal(get('py-parked').holder_label, 'Builder one #aaaa1111');
    assert.equal(get('py-ask-claim').holder_label, null);
    assert.equal(get('py-ask-claim').holder, null);
    assert.ok(!('holder_label' in get('py-1')), 'a lane with no owner has no holder_label');
    assert.deepEqual(readDoc(dir, 'lanes').rows.find((l) => l.id === 'py-held').holder_label, 'Builder one #aaaa1111');
  });

  it('G9 no label text holds a uuid or a listed id, and a handle stands in no other key of any document', () => {
    // Breaks if a new label bypasses the mask or a handle moves into another key (title, goal, a tile sentence).
    for (const d of ['lanes', 'lanes-all', 'assignments', 'assignments-all', 'tiles', 'flow', 'meta', 'projects', 'targets', 'snapshots']) {
      const walk = (v, key) => {
        if (typeof v === 'string') {
          if (LABEL_KEYS.includes(key)) { assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v), `uuid in ${d}.${key}`); assert.ok(!v.includes('abcdef12'), `listed sid8 in ${d}.${key}`); }
          else assert.ok(!/(?:aaaa1111|bbbb2222|abcdef12)/.test(v), `handle in ${d}.${key}: ${v.slice(0, 60)}`);
        } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
      };
      walk(readDoc(dir, d).rows, '');
    }
  });

  it('G10 the new keys fit the cap: every capped document stays under 256 KB and assignments.json grows by the by keys only', () => {
    // Breaks if a label list or a second copy of the rows is written, which would push a capped file toward the cap.
    for (const d of ['lanes', 'assignments', 'projects', 'targets', 'meta', 'snapshots', 'tiles', 'flow']) {
      assert.ok(fs.statSync(path.join(dir, `${d}.json`)).size < 256 * 1024, d);
    }
    const rows = readDoc(dir, 'assignments').rows;
    const claims = rows.filter((r) => r.who === 'session');
    const bytes = fs.statSync(path.join(dir, 'assignments.json')).size;
    const withoutBy = Buffer.byteLength(JSON.stringify({ ...readDoc(dir, 'assignments'), rows: rows.map(({ by, ...r }) => r) }));
    assert.ok(bytes - withoutBy <= claims.length * 48, `by keys add ${bytes - withoutBy} bytes for ${claims.length} claims`);
  });

  it('G11 with no listed-id list the export still succeeds, writes no label key anywhere, and prints one note line', () => {
    // Breaks if a missing list fails the nightly export, or labels are written unmasked when the mask cannot run.
    const d2 = outDir('run-nolist');
    const empty = path.join(state.tmp, 'emptyroot');
    fs.mkdirSync(empty, { recursive: true });
    const r = runExport(['--out', d2, '--rules', state.rules], { LANE_EXPORT_ID_ROOT: empty });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /listed-id list/);
    const text = readAll(d2);
    for (const k of LABEL_KEYS) assert.ok(!text.includes(`"${k}"`), `${k} written with no list`);
    const a1 = readDoc(dir, 'assignments').rows.map(({ by, ...x }) => x);
    const a2 = readDoc(d2, 'assignments').rows;
    assert.deepEqual(a2, a1, 'the old keys and rows are the same with and without labels');
    const strip = ({ closed_by, holder_label, ...x }) => x;
    assert.deepEqual(readDoc(d2, 'lanes-all').rows.map((l) => l.id), readDoc(dir, 'lanes-all').rows.map((l) => l.id));
    assert.deepEqual(readDoc(d2, 'lanes-all').rows.map((l) => JSON.stringify(strip(l))), readDoc(dir, 'lanes-all').rows.map((l) => JSON.stringify(strip(l))));
  });

  it('R7 assignments.json holds only the last 2 x window_days days; assignments-all.json holds every row; meta counts both (lane-export-retention)', () => {
    // Breaks if the capped file keeps old rows, the archive loses rows, the window is not read from the targets, or the counts are wrong.
    const today = readDoc(dir, 'meta').rows[0].today;
    const days = Number(readDoc(dir, 'targets').rows.find((t) => t.key === 'window_days').value);
    const start = new Date(Date.parse(`${today}T00:00:00Z`) - (2 * days - 1) * 86400000).toISOString().slice(0, 10);
    const all = readDoc(dir, 'assignments-all').rows;
    const cap = readDoc(dir, 'assignments').rows;
    assert.equal(all.length, 11, 'the fixture has 11 rows (10 claims, 1 Dave placement)');
    assert.deepEqual(cap, all.filter((r) => r.day >= start), 'the capped file is the full list cut at the start day, in the same order');
    assert.ok(cap.length < all.length, 'the fixture has claims older than the window, so the cut removes some');
    assert.ok(cap.length > 0, 'the clock-dated fixture claims stay');
    for (const r of cap) assert.ok(r.day >= start, r.day);
    const meta = readDoc(dir, 'meta').rows[0];
    assert.equal(meta.assignments_rows_total, all.length);
    assert.equal(meta.assignments_rows_written, cap.length);
    const refresh = readDoc(dir, 'refresh');
    assert.ok(!refresh.files.includes('assignments-all.json'));
    assert.ok(fs.readFileSync(path.join(dir, 'assignments.json'), 'utf8').length < fs.readFileSync(path.join(dir, 'assignments-all.json'), 'utf8').length);
  });

  it('projects: Done means every terminal lane is done, and a finished project stays in the rows (defect b)', () => {
    // Breaks if project status is "no open lanes" or finished projects are dropped.
    const p = Object.fromEntries(readDoc(dir, 'projects').rows.map((r) => [r.key, r]));
    assert.equal(p['proj-x'].status, 'open');
    assert.equal(p['proj-x'].terminal_done, 1);
    assert.equal(p['proj-x'].terminal_total, 2);
    assert.equal(p['proj-y'].status, 'no_end');
    assert.equal(p['proj-z'].status, 'done');
    assert.equal(p['proj-z'].done_day, '2026-10-21');
    assert.equal(p['proj-z'].visible_until, '2026-11-18');
    assert.equal(p['proj-z'].parked, true);
    assert.ok(p.unassigned);
  });

  it('targets: wip_limit is null (defect a), with a source column', () => {
    // Breaks if the export hard-codes wip_limit 3.
    const t = Object.fromEntries(readDoc(dir, 'targets').rows.map((r) => [r.key, r]));
    assert.equal(t.wip_limit.value, null);
    assert.equal(t.p0_cap.value, 5);
    assert.ok(t.wip_limit.source.length > 0);
    assert.equal(t.trend_min_days.value, 7);
  });

  it('snapshots: one row for today, and a second run the same day replaces it and keeps a .bak', () => {
    // Breaks if the snapshot row is appended twice per day or the previous file is not kept.
    const snaps = readDoc(dir, 'snapshots').rows;
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].open, 17);
    assert.equal(snaps[0].p0_open, 1);
    assert.equal(snaps[0].never_claimed_open, 15); // py-held, py-parked, px-4, px-3, px-2, py-1, py-note, py-notice, py-stale, py-ask-latest, py-kanban, py-before-only, py-kb-card, py-negation, py-title have no claim event
    const second = runExport(['--out', dir, '--rules', state.rules]);
    assert.equal(second.code, 0, second.all);
    assert.equal(readDoc(dir, 'snapshots').rows.length, 1);
    assert.ok(fs.existsSync(path.join(dir, 'snapshots.json.bak')));
  });

  it('the refresh doc is pending with the export stamp; the clearing call resets it, an old key does not (defect g)', () => {
    // Breaks if --clear-refresh ignores the key, or the doc is not written by the export.
    const d = outDir('refresh');
    assert.equal(runExport(['--out', d, '--rules', state.rules]).code, 0);
    const doc = readDoc(d, 'refresh');
    assert.equal(doc.pending, true);
    assert.equal(doc.key, readDoc(d, 'meta').exportedAt);
    const stale = runExport(['--out', d, '--clear-refresh', '2020-01-01T00:00:00.000Z']);
    assert.equal(stale.code, 0, stale.all);
    assert.equal(readDoc(d, 'refresh').pending, true);
    const ok = runExport(['--out', d, '--clear-refresh', doc.key]);
    assert.equal(ok.code, 0, ok.all);
    assert.equal(readDoc(d, 'refresh').pending, false);
    assert.ok(readDoc(d, 'refresh').cleared_at);
  });
});

// The done and reopen signals, written once here for the oracles. They are the definitions in the design, not a copy of the export SQL.
const ORACLE_DONE = `(e.kind = 'done' OR (e.kind = 'kanban' AND e.detail->>'kind' = 'state' AND e.detail->>'to' = 'done'))`;
const ORACLE_REOPEN = `(e.kind = 'state_changed' OR (e.kind = 'kanban' AND e.detail->>'kind' = 'state' AND e.detail->>'to' <> 'done'))`;
const CHI = `AT TIME ZONE 'America/Chicago'`;

describe('flow.json against a scratch database', () => {
  let dir;
  let flow;
  let today;
  const rowsById = () => Object.fromEntries(flow.rows.map((r) => [r.id, r]));
  const get = (id) => rowsById()[id];
  before(() => {
    dir = outDir('flow');
    const r = runExport(['--out', dir, '--rules', state.rules]);
    assert.equal(r.code, 0, r.all);
    flow = readDoc(dir, 'flow');
    today = readDoc(dir, 'meta').rows[0].today;
  });

  it('flow.json has the envelope, the shared exportedAt, 14 day rows and stays under the cap; refresh.json lists it', () => {
    // Breaks if DATASETS misses 'flow', the stamp is taken separately, or the file grows past 256 KB.
    assert.deepEqual(Object.keys(flow).sort(), ['exportedAt', 'rows', 'sql']);
    assert.equal(flow.exportedAt, readDoc(dir, 'meta').rows[0].exported_at);
    assert.ok(fs.statSync(path.join(dir, 'flow.json')).size < 256 * 1024);
    assert.equal(flow.rows.filter((r) => r.kind === 'day').length, 14);
    assert.ok(readDoc(dir, 'refresh').files.includes('flow.json'));
    assert.equal(readDoc(dir, 'refresh').files.length, 8);
  });

  it('oracle: claimed, done and created per day equal the raw SQL, and the fixture makes them non-zero', async () => {
    // Breaks on any day-bucket (UTC instead of Chicago), distinct-count (events instead of lanes) or done-day (first instead of latest done) drift.
    const { rows } = await q(
      `WITH g AS (SELECT r, ($1::date - (14 - r))::date AS day FROM generate_series(1, 14) r),
            dn AS (SELECT l.id, max(e.occurred_at) AS done_ev FROM agentic_os.lane l JOIN agentic_os.lane_event e ON e.lane_id = l.id
                   WHERE l.project_key = 'continuous-claude' AND l.state = 'done' AND ${ORACLE_DONE} GROUP BY l.id)
       SELECT g.r,
         (SELECT count(DISTINCT e.lane_id) FROM agentic_os.lane_event e JOIN agentic_os.lane l ON l.id = e.lane_id
           WHERE l.project_key = 'continuous-claude' AND e.kind = 'claimed' AND (e.occurred_at ${CHI})::date = g.day)::int AS claimed,
         (SELECT count(*) FROM dn WHERE (dn.done_ev ${CHI})::date = g.day)::int AS done,
         (SELECT count(*) FROM agentic_os.lane l WHERE l.project_key = 'continuous-claude' AND (l.created_at ${CHI})::date = g.day)::int AS created
       FROM g ORDER BY g.r`,
      [today],
    );
    assert.equal(rows.length, 14);
    for (const o of rows) {
      for (const s of ['claimed', 'done', 'created']) assert.equal(get(`flow.bar.${o.r}.${s}`).value, o[s], `${s} on rank ${o.r}`);
    }
    for (const s of ['claimed', 'done', 'created']) assert.ok(rows.reduce((n, o) => n + o[s], 0) > 0, `the fixture has no ${s} lane in the grid`);
    // py-quick is claimed twice on one day: the bar counts the lane once, the events twice.
    const ev = await q(`SELECT count(*)::int AS n FROM agentic_os.lane_event WHERE lane_id = 'py-quick' AND kind = 'claimed'`);
    assert.equal(ev.rows[0].n, 2);
  });

  it('oracle: week claimed, done, created and net equal the raw SQL', async () => {
    // Breaks if the week window is off by a day or the week claimed figure sums the days instead of counting lanes once.
    const { rows } = await q(
      `WITH w AS (SELECT ($1::date - 6) AS a, $1::date AS b),
            dn AS (SELECT l.id, max(e.occurred_at) AS done_ev FROM agentic_os.lane l JOIN agentic_os.lane_event e ON e.lane_id = l.id
                   WHERE l.project_key = 'continuous-claude' AND l.state = 'done' AND ${ORACLE_DONE} GROUP BY l.id)
       SELECT
         (SELECT count(DISTINCT e.lane_id) FROM agentic_os.lane_event e JOIN agentic_os.lane l ON l.id = e.lane_id, w
           WHERE l.project_key = 'continuous-claude' AND e.kind = 'claimed' AND (e.occurred_at ${CHI})::date BETWEEN w.a AND w.b)::int AS claimed,
         (SELECT count(*) FROM dn, w WHERE (dn.done_ev ${CHI})::date BETWEEN w.a AND w.b)::int AS done,
         (SELECT count(*) FROM agentic_os.lane l, w WHERE l.project_key = 'continuous-claude' AND (l.created_at ${CHI})::date BETWEEN w.a AND w.b)::int AS created`,
      [today],
    );
    const o = rows[0];
    assert.equal(get('flow.week.claimed').value, o.claimed);
    assert.equal(get('flow.week.done').value, o.done);
    assert.equal(get('flow.week.created').value, o.created);
    assert.equal(get('flow.week.net').value, o.created - o.done);
    assert.ok(o.claimed > 0 && o.done > 0 && o.created > 0);
  });

  it('oracle: percentile_cont(0.5) equals flow.week.median_h to 2 decimals; counts equal median_n, skipped and negative', async () => {
    // Breaks when Node and SQL disagree on the median (lower middle instead of the mean), or the skipped and negative lanes enter it.
    const { rows } = await q(
      `WITH ev AS (SELECT e.lane_id, min(e.occurred_at) FILTER (WHERE e.kind = 'claimed') AS first_claim,
                     max(e.occurred_at) FILTER (WHERE ${ORACLE_DONE}) AS done_ev
                   FROM agentic_os.lane_event e JOIN agentic_os.lane l ON l.id = e.lane_id WHERE l.project_key = 'continuous-claude' GROUP BY e.lane_id),
            dw AS (SELECT ev.* FROM agentic_os.lane l JOIN ev ON ev.lane_id = l.id
                   WHERE l.project_key = 'continuous-claude' AND l.state = 'done' AND (ev.done_ev ${CHI})::date BETWEEN $1::date - 6 AND $1::date)
       SELECT count(*) FILTER (WHERE first_claim IS NOT NULL AND done_ev >= first_claim)::int AS n,
         count(*) FILTER (WHERE first_claim IS NULL)::int AS skipped,
         count(*) FILTER (WHERE first_claim IS NOT NULL AND done_ev < first_claim)::int AS negative,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (done_ev - first_claim)) / 3600)
           FILTER (WHERE first_claim IS NOT NULL AND done_ev >= first_claim))::numeric, 2)::float8 AS median_h
       FROM dw`,
      [today],
    );
    const o = rows[0];
    assert.ok(o.n >= 2, 'the fixture needs two timed lanes in the week');
    assert.equal(get('flow.week.median_n').value, o.n);
    assert.equal(get('flow.week.median_skipped').value, o.skipped);
    assert.equal(get('flow.week.median_negative').value, o.negative);
    assert.ok(o.negative >= 1, 'py-early-done is done before its first claim');
    assert.equal(get('flow.week.median_h').value.toFixed(2), o.median_h.toFixed(2));
    assert.equal(get('flow.week.median_h').text, `${o.median_h.toFixed(2)} h`);
  });

  it('oracle: the rework pairs SQL equals rework.done, rework.lanes and the reopened bars (state_changed and kanban arms)', async () => {
    // Breaks if SQL_REWORK misses the state_changed or the kanban "to not done" arm, pairs a reopen with an earlier done, counts pairs,
    // or the numerator counts a lane done before the week (px-4).
    const pairs = `WITH d AS (SELECT e.lane_id, e.occurred_at AS done_at FROM agentic_os.lane_event e JOIN agentic_os.lane l ON l.id = e.lane_id
                              WHERE l.project_key = 'continuous-claude' AND ${ORACLE_DONE}),
                        r AS (SELECT e.lane_id, e.occurred_at AS reopen_at FROM agentic_os.lane_event e JOIN agentic_os.lane l ON l.id = e.lane_id
                              WHERE l.project_key = 'continuous-claude' AND ${ORACLE_REOPEN}),
                        pairs AS (SELECT d.lane_id, d.done_at, min(r.reopen_at) AS reopen_at FROM d JOIN r ON r.lane_id = d.lane_id AND r.reopen_at > d.done_at GROUP BY d.lane_id, d.done_at)`;
    const week = await q(
      `${pairs}
       SELECT (SELECT count(DISTINCT lane_id) FROM d WHERE (done_at ${CHI})::date BETWEEN $1::date - 6 AND $1::date)::int AS done_lanes,
              (SELECT count(DISTINCT lane_id) FROM pairs WHERE (done_at ${CHI})::date BETWEEN $1::date - 6 AND $1::date)::int AS reopen_lanes,
              (SELECT count(DISTINCT lane_id) FROM pairs WHERE (reopen_at ${CHI})::date BETWEEN $1::date - 6 AND $1::date)::int AS reopen_any,
              (SELECT count(*) FROM pairs WHERE lane_id IN ('px-3', 'px-4'))::int AS dated_pairs,
              (SELECT count(DISTINCT lane_id) FROM pairs WHERE lane_id IN ('px-3', 'px-4'))::int AS dated_lanes`,
      [today],
    );
    const o = week.rows[0];
    assert.equal(o.dated_lanes, 2, 'px-3 and px-4 are the clock-dated reopened lanes');
    assert.ok(o.dated_pairs >= 3, 'px-3 has two pairs and px-4 has one');
    assert.ok(o.reopen_lanes >= 1, 'px-3 is done and reopened inside the week');
    assert.ok(o.reopen_any > o.reopen_lanes, 'px-4 is reopened in the week but done before it: the fixture separates the two rules');
    assert.equal(get('flow.week.rework.done').value, o.done_lanes);
    assert.equal(get('flow.week.rework.lanes').value, o.reopen_lanes);
    assert.ok(get('flow.week.rework.lanes').value <= get('flow.week.rework.done').value);
    assert.equal(get('flow.week.rework.pct').text, `${((o.reopen_lanes / o.done_lanes) * 100).toFixed(1)}%`);
    const days = await q(
      `${pairs}
       SELECT g.r, (SELECT count(DISTINCT lane_id) FROM pairs WHERE (reopen_at ${CHI})::date = g.day)::int AS reopened
       FROM (SELECT r, ($1::date - (14 - r))::date AS day FROM generate_series(1, 14) r) g ORDER BY g.r`,
      [today],
    );
    for (const row of days.rows) assert.equal(get(`flow.bar.${row.r}.reopened`).value, row.reopened, `reopened on rank ${row.r}`);
    assert.ok(days.rows.reduce((n, row) => n + row.reopened, 0) >= 3, 'px-3 is reopened on two grid days and px-4 on a third');
  });

  it('privacy: no secret, session id, handle, lane id, title or other-board lane in flow.json', () => {
    // Breaks if SQL_REWORK returns a body or a session, or a row writes a lane id or title.
    const text = JSON.stringify(flow);
    for (const secret of ['SECRET', ...HANDLES, S1, S2, S3, 'gm-1', 'Title of', 'greymatter']) assert.ok(!text.includes(secret), `leaked ${secret}`);
    for (const l of readDoc(dir, 'lanes-all').rows) assert.ok(!text.includes(l.id), `leaked lane id ${l.id}`);
    for (const r of flow.rows) assert.equal(r.tone, null, r.id);
    assert.equal(get('flow.week.claimed.label').text, 'lanes claimed, not claim events');
    assert.equal(get('flow.week.rework.done.label').text, 'done lanes, including reopened');
  });

  it('SQL_REWORK is a SELECT with no write keyword, filtered to the board', async () => {
    // Breaks if a write statement slips into the rework query, or the board filter is dropped.
    const { SQL_REWORK } = await import('./export-dash-data.mjs');
    assert.match(SQL_REWORK.trim(), /^(WITH|SELECT)\b/i);
    assert.doesNotMatch(SQL_REWORK, /\b(insert|update|delete|drop|alter|create|truncate|grant)\b/i);
    assert.match(SQL_REWORK, /project_key = \$1/);
    assert.ok(flow.sql.includes('agentic_os.lane_event'));
  });
});

describe('failure paths', () => {
  it('a lane created as done (only a seeded event) does not block the export, and gets no invented done time', async () => {
    // Breaks if the born-done lane is counted open by the rebuilt check (export exits non-zero), or if a done time is made up.
    await addLane({ id: 'born-done', state: 'done', created: '2026-11-05T15:00:00Z' });
    await addEvent('born-done', 'seeded', '2026-11-05T15:00:00Z', { body: 'Title of born-done' });
    try {
      const d = outDir('born');
      const r = runExport(['--out', d, '--rules', state.rules]);
      assert.equal(r.code, 0, r.all);
      const row = readDoc(d, 'lanes-all').rows.find((l) => l.id === 'born-done');
      assert.equal(row.state, 'done');
      assert.equal(row.done_at, null);
      assert.equal(row.done_day, null);
    } finally {
      await q('DELETE FROM agentic_os.lane_event WHERE lane_id = $1', ['born-done']);
      await q('DELETE FROM agentic_os.lane WHERE id = $1', ['born-done']);
    }
  });

  it('exits non-zero and writes no data file (only export-error.json) when a done lane has no done signal of either kind (open count mismatch)', async () => {
    // Breaks if the rebuilt-versus-direct open count check is removed. The lane has kanban events that are NOT a move to done.
    await addLane({ id: 'bad-done', state: 'done', created: '2026-11-05T15:00:00Z' });
    await addEvent('bad-done', 'kanban', '2026-11-05T16:00:00Z', { body: 'bad-done state ready -> review', detail: { kind: 'state', from: 'ready', to: 'review' } });
    await addEvent('bad-done', 'kanban', '2026-11-05T17:00:00Z', { body: 'a note', detail: { kind: 'note', to: 'done' } });
    try {
      const d = outDir('bad');
      const r = runExport(['--out', d, '--rules', state.rules]);
      assert.notEqual(r.code, 0);
      assert.match(r.all, /open count/);
      assert.deepEqual(fs.existsSync(d) ? fs.readdirSync(d) : [], ['export-error.json']);
    } finally {
      await q('DELETE FROM agentic_os.lane WHERE id = $1', ['bad-done']);
    }
  });

  it('exits non-zero for a rules file with an idRe that does not start with ^, and for a missing rules file', () => {
    // Breaks if a bad rule is skipped silently and lanes get the wrong project.
    const bad = path.join(state.tmp, 'bad-rules.json');
    fs.writeFileSync(bad, JSON.stringify({ version: 1, projects: [{ key: 'loose', idRe: 'guard' }] }));
    const r = runExport(['--out', outDir('badrules'), '--rules', bad]);
    assert.notEqual(r.code, 0);
    assert.match(r.all, /loose/);
    const missing = runExport(['--out', outDir('norules'), '--rules', path.join(state.tmp, 'nope.json')]);
    assert.notEqual(missing.code, 0);
  });

  it('exits non-zero when the config sets wip_limit to a string', () => {
    // Breaks if the export accepts a non-number limit.
    const cfg = path.join(state.tmp, 'cfg.json');
    fs.writeFileSync(cfg, JSON.stringify({ version: 1, targets: [{ key: 'wip_limit', value: '3', label: 'w', source: 's' }] }));
    const r = runExport(['--out', outDir('badcfg'), '--rules', state.rules, '--config', cfg]);
    assert.notEqual(r.code, 0);
    assert.match(r.all, /wip_limit/);
  });

  it('a config that sets wip_limit to a number reaches the targets document', () => {
    // Breaks if the config value is ignored (the limit would stay null forever).
    const cfg = path.join(state.tmp, 'cfg-ok.json');
    fs.writeFileSync(cfg, JSON.stringify({ version: 1, targets: [{ key: 'wip_limit', value: 4, label: 'w', source: 'Dave' }] }));
    const d = outDir('okcfg');
    const r = runExport(['--out', d, '--rules', state.rules, '--config', cfg]);
    assert.equal(r.code, 0, r.all);
    assert.equal(readDoc(d, 'targets').rows.find((t) => t.key === 'wip_limit').value, 4);
  });

  it('exits non-zero when an explicit --config path does not exist (L)', () => {
    // Breaks if a typo in --config silently gives the defaults.
    const r = runExport(['--out', outDir('nocfg'), '--rules', state.rules, '--config', path.join(state.tmp, 'no-such-config.json')]);
    assert.notEqual(r.code, 0);
    assert.match(r.all, /no-such-config/);
  });

  it('refuses an unknown flag', () => {
    // Breaks if a typo such as --upload is silently ignored.
    const r = runExport(['--out', outDir('flag'), '--upload']);
    assert.notEqual(r.code, 0);
    assert.match(r.all, /--upload/);
  });
});

describe('read-only connection', () => {
  it('openReadOnly rejects an INSERT inside the export transaction', async () => {
    // Breaks if BEGIN READ ONLY / default_transaction_read_only is dropped.
    const { openReadOnly } = await import('./export-dash-data.mjs');
    const client = await openReadOnly(state.url);
    try {
      await assert.rejects(
        client.query(`INSERT INTO agentic_os.lane (id, title) VALUES ('ro-probe', 'x')`),
        /read-only/i,
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
    const { rows } = await q(`SELECT count(*)::int AS n FROM agentic_os.lane WHERE id = 'ro-probe'`);
    assert.equal(rows[0].n, 0);
  });
});
