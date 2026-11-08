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

const state = { url: '', tmp: '', db: null, rules: '' };
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
  const env = { ...process.env, CONTINUOUS_CLAUDE_DB_URL: url, DATABASE_URL: url, OPC_POSTGRES_URL: url, ...extraEnv };
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
  fs.writeFileSync(state.rules, JSON.stringify({
    version: 1,
    projects: [
      { key: 'proj-x', name: 'X', goal: 'gx', done: 'dx', idRe: '^px-', terminalLanes: ['px-1', 'px-2'] },
      { key: 'proj-y', name: 'Y', goal: 'gy', done: 'dy', idRe: '^py-' },
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
  // M2: a session handle in a title must be masked.
  await addLane({ id: 'py-title', created: '2026-11-04T15:00:00Z', title: 'Resume session #aaaa1111 handoff #12 and #abcdef12' });
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
});

after(async () => {
  await state.db?.end().catch(() => {});
  if (state.url) dropScratch(state.url);
});

const ALLOWED_LANE_KEYS = [
  'band', 'claims', 'created_at', 'created_day', 'dave_ask_at', 'done_at', 'done_day', 'first_claim_at', 'has_done_when',
  'held', 'id', 'last_work_at', 'lease_expires_at', 'priority', 'project', 'state', 'terminal', 'title', 'track',
];

describe('export-dash-data.mjs against a scratch database', () => {
  let dir;
  let run;
  before(() => {
    dir = outDir('run1');
    run = runExport(['--out', dir, '--rules', state.rules]);
  });

  it('exits 0 and writes the six documents plus the refresh doc', () => {
    // Breaks if the script fails on the fixture or skips a document.
    assert.equal(run.code, 0, run.all);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['assignments.json', 'lanes.json', 'meta.json', 'projects.json', 'refresh.json', 'snapshots.json', 'targets.json']);
  });

  it('every document has the same exportedAt and the envelope shape {sql, exportedAt, rows}', () => {
    // Breaks if exportedAt is taken per file instead of once.
    const stamps = new Set();
    for (const d of ['lanes', 'assignments', 'projects', 'targets', 'meta', 'snapshots']) {
      const doc = readDoc(dir, d);
      assert.deepEqual(Object.keys(doc).sort(), ['exportedAt', 'rows', 'sql'], d);
      assert.equal(typeof doc.sql, 'string');
      stamps.add(doc.exportedAt);
    }
    assert.equal(stamps.size, 1);
  });

  it('lanes rows have exactly the allowlisted keys and only this board (greymatter-design is absent)', () => {
    // Breaks if a column such as note, scope, rationale or done_when text is added, or the board filter is lost.
    const lanes = readDoc(dir, 'lanes').rows;
    for (const l of lanes) assert.deepEqual(Object.keys(l).sort(), ALLOWED_LANE_KEYS, l.id);
    assert.deepEqual(lanes.map((l) => l.id).sort(), ['px-1', 'px-2', 'py-1', 'py-ask-claim', 'py-ask-latest', 'py-before-only', 'py-kanban', 'py-kb-card', 'py-kdone', 'py-negation', 'py-note', 'py-notice', 'py-reassign', 'py-stale', 'py-title', 'pz-1']);
    assert.ok(!readAll(dir).includes('gm-1'));
  });

  it('privacy: no note, scope, rationale, done_when text, event body or session handle in any document', () => {
    // Breaks if any text column or an 8-hex session handle is exported.
    const text = readAll(dir);
    for (const secret of ['SECRET', ...HANDLES, S1, S2, S3]) assert.ok(!text.includes(secret), `leaked ${secret}`);
    assert.ok(!/"handle"/.test(text));
    assert.equal(readDoc(dir, 'lanes').rows.find((l) => l.id === 'px-1').has_done_when, true);
  });

  it('masks a #<8 hex> session handle in a title and keeps other #numbers (M2)', () => {
    // Breaks if the title is exported as it is: a handle in a lane title would reach the dashboard.
    const t = readDoc(dir, 'lanes').rows.find((l) => l.id === 'py-title').title;
    assert.equal(t, 'Resume session #[handle] handoff #12 and #[handle]');
  });

  it('repeat done counts the lane once and takes the latest done event; day buckets are America/Chicago', () => {
    // Breaks if done_at is the first done event, or the day is the UTC date.
    const px1 = readDoc(dir, 'lanes').rows.find((l) => l.id === 'px-1');
    assert.equal(px1.state, 'done');
    assert.equal(px1.done_at, '2026-11-02T05:30:00.000Z');
    assert.equal(px1.done_day, '2026-11-01'); // 23:30 CST on 11-01, not 11-02
    assert.equal(px1.created_day, '2026-10-31'); // 23:30 CDT on 10-31, not 11-01
    assert.equal(px1.first_claim_at, '2026-11-01T05:00:00.000Z');
    assert.equal(px1.claims, 1);
    const meta = readDoc(dir, 'meta').rows[0];
    assert.equal(meta.done_check, 3); // px-1, pz-1 and py-kdone
    assert.equal(meta.done_event_lanes, 4); // px-1, px-2 (reopened), pz-1, py-kdone (kanban): distinct lane ids, not 5 events
  });

  it('a done lane that was reopened has done_at null and counts as open', () => {
    // Breaks if done_at is "any done event" instead of "done event while state = done".
    const px2 = readDoc(dir, 'lanes').rows.find((l) => l.id === 'px-2');
    assert.equal(px2.state, 'ready');
    assert.equal(px2.done_at, null);
    assert.equal(px2.done_day, null);
    assert.equal(px2.last_work_at, '2026-11-02T18:00:00.000Z');
    assert.equal(readDoc(dir, 'meta').rows[0].open_check, 13);
  });

  it('a lane with zero events has null timestamps and zero claims', () => {
    // Breaks if the events join drops lanes that have no events.
    const l = readDoc(dir, 'lanes').rows.find((x) => x.id === 'py-1');
    assert.equal(l.first_claim_at, null);
    assert.equal(l.last_work_at, null);
    assert.equal(l.dave_ask_at, null);
    assert.equal(l.claims, 0);
    assert.equal(l.band, 'P0');
  });

  it('notes do not count as work (defect d)', () => {
    // Breaks if last_work includes kind note (export-c.mjs:27).
    const l = readDoc(dir, 'lanes').rows.find((x) => x.id === 'py-note');
    assert.equal(l.last_work_at, null);
  });

  it('dave_ask_at is the time of the latest needs-Dave EVENT, never lane.note (defect c)', () => {
    // Breaks if the export reads lane.note, or takes the earliest ask, or ignores kanban asks, or counts any later note.
    const by = Object.fromEntries(readDoc(dir, 'lanes').rows.map((l) => [l.id, l]));
    assert.equal(by['py-note'].dave_ask_at, '2026-11-05T15:00:00.000Z');
    assert.equal(by['py-stale'].dave_ask_at, null, 'lane.note says needs Dave but no event does');
    assert.equal(by['py-ask-latest'].dave_ask_at, '2026-11-07T15:00:00.000Z');
    assert.equal(by['py-ask-claim'].dave_ask_at, '2026-11-03T10:00:00.000Z');
    assert.equal(by['py-ask-claim'].last_work_at, '2026-11-04T10:00:00.000Z', 'the ask is older than the claim but stays exported');
    assert.ok(!('dave_note' in by['py-note']));
  });

  it('dave_ask_at reads only the text before " || before:", and only a "moved into waiting" kanban event (M1)', () => {
    // Breaks if the match runs on the kept old note, a kanban card note counts, or a negation counts.
    const by = Object.fromEntries(readDoc(dir, 'lanes').rows.map((l) => [l.id, l]));
    assert.equal(by['py-before-only'].dave_ask_at, null, 'the ask is only in the kept old note');
    assert.equal(by['py-kb-card'].dave_ask_at, null, 'a kanban card note is not a move into waiting');
    assert.equal(by['py-negation'].dave_ask_at, null, '"no longer needs Dave" is not an ask');
    assert.equal(by['py-notice'].dave_ask_at, '2026-11-06T17:00:00.000Z', '"Notice:" holds the letters "not" and is still an ask');
  });

  it('a lane marked done by kanban-apply (kind kanban, state to done) has done_at, done_day and last_work_at (H1)', () => {
    // Breaks if done_ev or last_work read only kind 'done': the lane is state done with no done_at and the open count check fails.
    const l = readDoc(dir, 'lanes').rows.find((x) => x.id === 'py-kdone');
    assert.equal(l.state, 'done');
    assert.equal(l.done_at, '2026-11-06T15:00:00.000Z');
    assert.equal(l.done_day, '2026-11-06');
    assert.equal(l.last_work_at, '2026-11-06T15:00:00.000Z');
  });

  it('assignments: no handle key, reassigned computed in SQL, Dave placements de-duplicated per lane and day', () => {
    // Breaks if the handle column returns, reassigned is dropped, or Dave rows are not de-duplicated.
    const rows = readDoc(dir, 'assignments').rows;
    for (const r of rows) assert.ok(!('handle' in r), JSON.stringify(r));
    const claims = rows.filter((r) => r.who === 'session');
    assert.equal(claims.length, 5); // px-1, py-ask-claim, 3 on py-reassign
    assert.deepEqual(claims.filter((r) => r.lane_id === 'py-reassign').map((r) => r.reassigned), [false, true, false]);
    assert.equal(claims.find((r) => r.lane_id === 'py-ask-claim').how, 'reclaim');
    assert.equal(claims.find((r) => r.lane_id === 'px-1').how, 'claim');
    const dave = rows.filter((r) => r.who === 'dave');
    assert.equal(dave.length, 1);
    assert.equal(dave[0].how, 'placed in Now');
    assert.equal(dave[0].day, '2026-11-06');
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
    assert.equal(snaps[0].open, 13);
    assert.equal(snaps[0].p0_open, 1);
    assert.equal(snaps[0].never_claimed_open, 11); // px-2, py-1, py-note, py-notice, py-stale, py-ask-latest, py-kanban, py-before-only, py-kb-card, py-negation, py-title have no claim event
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

describe('failure paths', () => {
  it('a lane created as done (only a seeded event) does not block the export, and gets no invented done time', async () => {
    // Breaks if the born-done lane is counted open by the rebuilt check (export exits non-zero), or if a done time is made up.
    await addLane({ id: 'born-done', state: 'done', created: '2026-11-05T15:00:00Z' });
    await addEvent('born-done', 'seeded', '2026-11-05T15:00:00Z', { body: 'Title of born-done' });
    try {
      const d = outDir('born');
      const r = runExport(['--out', d, '--rules', state.rules]);
      assert.equal(r.code, 0, r.all);
      const row = readDoc(d, 'lanes').rows.find((l) => l.id === 'born-done');
      assert.equal(row.state, 'done');
      assert.equal(row.done_at, null);
      assert.equal(row.done_day, null);
    } finally {
      await q('DELETE FROM agentic_os.lane_event WHERE lane_id = $1', ['born-done']);
      await q('DELETE FROM agentic_os.lane WHERE id = $1', ['born-done']);
    }
  });

  it('exits non-zero and writes nothing when a done lane has no done signal of either kind (open count mismatch)', async () => {
    // Breaks if the rebuilt-versus-direct open count check is removed. The lane has kanban events that are NOT a move to done.
    await addLane({ id: 'bad-done', state: 'done', created: '2026-11-05T15:00:00Z' });
    await addEvent('bad-done', 'kanban', '2026-11-05T16:00:00Z', { body: 'bad-done state ready -> review', detail: { kind: 'state', from: 'ready', to: 'review' } });
    await addEvent('bad-done', 'kanban', '2026-11-05T17:00:00Z', { body: 'a note', detail: { kind: 'note', to: 'done' } });
    try {
      const d = outDir('bad');
      const r = runExport(['--out', d, '--rules', state.rules]);
      assert.notEqual(r.code, 0);
      assert.match(r.all, /open count/);
      assert.equal(fs.existsSync(d) ? fs.readdirSync(d).length : 0, 0);
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
