/**
 * lane-dep-seed.test -- end to end tests for `lane.mjs seed` (object form), the waits_on field of `board`, the
 * dependency filter of `next`, and the "no lane_dep table" floor (contract t2.1, points 2, 4 "Database floor" and 5).
 *
 * Every test spawns the real `lane.mjs` as a child process against SCRATCH databases that this file creates and drops
 * itself (one through migration 6, one through migration 5 for the floor). The cwd of each run is a temp git repo with
 * a `main` branch, so `done --merged` (which meets a dependency) runs for real.
 *
 * The file name has no `.db.` part: the CO1 test of pre-pr.test.mjs matches CI test files with
 * `scripts/coordination/[\w-]+\.test\.mjs`.
 *
 *   node --test scripts/coordination/lane-dep-seed.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl } from './scratch-db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const LANE = path.join(HERE, 'lane.mjs');
const SCRATCH = path.join(HERE, 'scratch-db.mjs');
const { Client } = requireDep('pg', { repoRoot: REPO });

const fwd = (p) => String(p).replace(/\\/g, '/');
const BOARD = 'ds-a';
const OTHER = 'ds-other';
const ME = randomUUID();
const WARN = '[lane] warn: migration 0006 (lane_dep) is not applied; the dependency gate is off';
const s = { url6: '', url5: '', db6: null, db5: null, tmp: '', repo: '', registry: '', idDir: '', A: '', dropped: [] };

function createScratch(through) {
  const r = spawnSync(process.execPath, [SCRATCH, 'create', '--through', String(through)], { encoding: 'utf8' });
  assert.equal(r.status, 0, `scratch create failed: ${r.stderr}`);
  const { url } = JSON.parse(r.stdout);
  assertScratchUrl(url);
  return url;
}
function dropScratch(url) {
  if (!url) return;
  assertScratchUrl(url);
  const r = spawnSync(process.execPath, [SCRATCH, 'drop', url], { encoding: 'utf8' });
  s.dropped.push(`${new URL(url).pathname.slice(1)} status ${r.status}`);
}

/** Git env without the variables a parent git process (a hook) can leak into a child. */
function cleanGitEnv() {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[k];
  return env;
}
const git = (...args) => execFileSync('git',
  ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
  { cwd: s.repo, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true }).trim();

/** Run the worktree lane.mjs in the temp repo against one scratch database. */
function lane(args, { url = s.url6, cwd = s.repo } = {}) {
  assertScratchUrl(url);
  const env = cleanGitEnv();
  delete env.LANE_PROJECT; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.LANE_SKIP_HOOK_PRECHECK;
  Object.assign(env, {
    CONTINUOUS_CLAUDE_DB_URL: url, DATABASE_URL: url, OPC_POSTGRES_URL: url,
    LANE_REGISTRY_PATH: s.registry, CCV3_IDENTITY_DIR: s.idDir, CLAUDE_CODE_SESSION_ID: ME,
  });
  const r = spawnSync(process.execPath, [LANE, ...args], { cwd, env, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}
const dbOf = (url) => (url === s.url5 ? s.db5 : s.db6);
const q = (url, sql, params) => dbOf(url).query(sql, params);
const warnCount = (text) => text.split('\n').filter((l) => l === WARN).length;

let fileSeq = 0;
/** Write a seed file (any JSON value) and return its path. */
function seedFile(value) {
  const f = path.join(s.tmp, `seed-${++fileSeq}.json`);
  fs.writeFileSync(f, JSON.stringify(value));
  return f;
}
const item = (id, extra = {}) => ({ id, title: `title of ${id}`, track: 'zz', state: 'blocked', ...extra });
const kanbanFile = () => seedFile({ project: BOARD, board: { columns: {} }, cards: [] });
const edge = (laneId, dependsOn) => ({ lane: laneId, dependsOn });
const seed = (value, url = s.url6) => lane(['seed', seedFile(value)], { url });

const edgesOf = async (ids, url = s.url6) =>
  (await q(url, `SELECT lane_id, depends_on, project_key FROM agentic_os.lane_dep WHERE lane_id = ANY($1) ORDER BY lane_id, depends_on`, [ids])).rows;
const laneRows = async (ids, url = s.url6) =>
  (await q(url, `SELECT id, state, project_key FROM agentic_os.lane WHERE id = ANY($1) ORDER BY id`, [ids])).rows;
const seededEvents = async (url = s.url6) =>
  (await q(url, `SELECT * FROM agentic_os.lane_event WHERE kind = 'seeded' ORDER BY id`)).rows;
const mkLane = (id, state = 'backlog', board = BOARD, url = s.url6) =>
  q(url, `INSERT INTO agentic_os.lane (id,title,track,state,project_key) VALUES ($1,$2,'zz',$3,$4)`, [id, `title of ${id}`, state, board]);

before(async () => {
  s.url6 = createScratch(6);
  s.url5 = createScratch(5);
  s.tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dep-seed-')));
  s.repo = path.join(s.tmp, 'repo');
  s.idDir = path.join(s.tmp, 'ids');
  fs.mkdirSync(s.repo); fs.mkdirSync(s.idDir);
  s.registry = path.join(s.tmp, 'registry.json');
  fs.writeFileSync(s.registry, JSON.stringify({ version: '1.0', projects: [{ name: 'ds', key: BOARD, path: fwd(s.repo), status: 'active' }] }));
  git('init', '-b', 'main');
  fs.writeFileSync(path.join(s.repo, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('commit', '-m', 'a');
  s.A = git('rev-parse', 'HEAD');
  for (const [k, url] of [['db6', s.url6], ['db5', s.url5]]) {
    s[k] = new Client({ connectionString: url });
    await s[k].connect();
    await s[k].query(`SELECT set_config('lane.client_version','test',false)`);
  }
});

after(async () => {
  await s.db6?.end().catch(() => {});
  await s.db5?.end().catch(() => {});
  dropScratch(s.url6);
  dropScratch(s.url5);
  if (s.tmp) fs.rmSync(s.tmp, { recursive: true, force: true });
  console.log(`scratch databases dropped: ${s.dropped.join('; ')}`);
});

describe('object seed: lanes, edges, event, output', () => {
  it('writes the lanes and the edges, and records the seeded event', async () => {
    const [a, b, c] = ['ds-w-a', 'ds-w-b', 'ds-w-c'];
    const r = seed({ lanes: [item(a), item(b), item(c)], edges: [edge(a, b), edge(a, 'ds-w-ext'), edge(b, c)] });
    assert.equal(r.code, 0, r.all);
    assert.ok(r.out.startsWith(`seeded 3 lane(s) and 3 edge(s) on board ${BOARD}`), r.out);
    assert.deepEqual(await edgesOf([a, b, c]), [
      { lane_id: a, depends_on: 'ds-w-b', project_key: BOARD },
      { lane_id: a, depends_on: 'ds-w-ext', project_key: BOARD },
      { lane_id: b, depends_on: c, project_key: BOARD },
    ]);
    assert.deepEqual((await laneRows([a, b, c])).map((x) => [x.id, x.state, x.project_key]), [[a, 'blocked', BOARD], [b, 'blocked', BOARD], [c, 'blocked', BOARD]]);
    const ev = (await seededEvents()).find((e) => /ds-w-a|3 edges/.test(e.body ?? '') && e.detail?.edges === 3);
    assert.ok(ev, 'a seeded event with 3 edges');
    assert.equal(ev.lane_id, null);
    assert.equal(ev.to_session_id, null);
    assert.equal(ev.session_id, ME);
    assert.equal(ev.project_key, BOARD);
    assert.match(ev.body, /^seeded 3 lanes and 3 edges from .*seed-\d+\.json$/);
    assert.deepEqual(ev.detail, { lanes: 3, edges: 3 });
  });

  it('a duplicate edge in the file is dropped and counted; the missing dependency is a warning and an open edge', async () => {
    const r = seed({ lanes: [item('ds-d-a')], edges: [edge('ds-d-a', 'ds-d-ghost'), edge('ds-d-a', 'ds-d-ghost')] });
    assert.equal(r.code, 0, r.all);
    const lines = r.out.trim().split('\n');
    assert.equal(lines[0], `seeded 1 lane(s) and 1 edge(s) on board ${BOARD}`);
    assert.ok(lines.includes('  dropped 1 duplicate edge(s)'), r.out);
    assert.ok(lines.includes('  warning: ds-d-a -> ds-d-ghost: no lane has this id; it counts as open'), r.out);
    assert.equal(lines.length, 3);
    assert.equal((await edgesOf(['ds-d-a'])).length, 1);
  });

  it('a dependency that is in lanes[] or on this board is no warning', async () => {
    await mkLane('ds-nw-ext');
    const r = seed({ lanes: [item('ds-nw-a'), item('ds-nw-b')], edges: [edge('ds-nw-a', 'ds-nw-b'), edge('ds-nw-a', 'ds-nw-ext')] });
    assert.equal(r.code, 0, r.all);
    assert.equal(r.out.trim(), `seeded 2 lane(s) and 2 edge(s) on board ${BOARD}`);
  });

  it('every new lane keeps the state the file gives; an existing lane keeps its own state', async () => {
    await mkLane('ds-st-old', 'active');
    const r = seed({ lanes: [item('ds-st-old', { state: 'backlog' }), item('ds-st-new', { state: 'ready' }), item('ds-st-blk', { state: 'blocked' })], edges: [] });
    assert.equal(r.code, 0, r.all);
    assert.deepEqual((await laneRows(['ds-st-old', 'ds-st-new', 'ds-st-blk'])).map((x) => [x.id, x.state]),
      [['ds-st-blk', 'blocked'], ['ds-st-new', 'ready'], ['ds-st-old', 'active']]);
  });
});

describe('object seed: the replace set', () => {
  it('a second seed with fewer edges removes the dropped edges', async () => {
    const ids = ['ds-r-a', 'ds-r-b', 'ds-r-c', 'ds-r-d'];
    assert.equal(seed({ lanes: ids.map((i) => item(i)), edges: [edge('ds-r-a', 'ds-r-b'), edge('ds-r-a', 'ds-r-c'), edge('ds-r-b', 'ds-r-d')] }).code, 0);
    assert.equal((await edgesOf(ids)).length, 3);
    const r = seed({ lanes: ids.map((i) => item(i)), edges: [edge('ds-r-a', 'ds-r-b')] });
    assert.equal(r.code, 0, r.all);
    assert.deepEqual((await edgesOf(ids)).map((e) => `${e.lane_id}>${e.depends_on}`), ['ds-r-a>ds-r-b']);
  });

  it('a lane with zero edges in lanes[] loses its old edges', async () => {
    assert.equal(seed({ lanes: [item('ds-z-a'), item('ds-z-b')], edges: [edge('ds-z-a', 'ds-z-b'), edge('ds-z-b', 'ds-z-ext')] }).code, 0);
    const r = seed({ lanes: [item('ds-z-a'), item('ds-z-b')], edges: [] });
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(await edgesOf(['ds-z-a', 'ds-z-b']), []);
  });

  it('a lane that is NOT in lanes[] keeps its edges', async () => {
    assert.equal(seed({ lanes: [item('ds-k-a'), item('ds-k-b')], edges: [edge('ds-k-a', 'ds-k-x'), edge('ds-k-b', 'ds-k-x')] }).code, 0);
    assert.equal(seed({ lanes: [item('ds-k-a')], edges: [] }).code, 0);
    assert.deepEqual((await edgesOf(['ds-k-a', 'ds-k-b'])).map((e) => e.lane_id), ['ds-k-b']);
  });

  it('the replace has no project_key filter: an edge row with a stale board is replaced', async () => {
    await mkLane('ds-s-a');
    await q(s.url6, `INSERT INTO agentic_os.lane_dep (lane_id, depends_on, project_key) VALUES ('ds-s-a','ds-s-old','stale-board')`);
    const r = seed({ lanes: [item('ds-s-a')], edges: [edge('ds-s-a', 'ds-s-new')] });
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(await edgesOf(['ds-s-a']), [{ lane_id: 'ds-s-a', depends_on: 'ds-s-new', project_key: BOARD }]);
  });

  it('an array seed after an object seed leaves every edge', async () => {
    const ids = ['ds-ar-a', 'ds-ar-b'];
    assert.equal(seed({ lanes: ids.map((i) => item(i)), edges: [edge('ds-ar-a', 'ds-ar-b')] }).code, 0);
    const r = seed(ids.map((i) => item(i, { title: `renamed ${i}` })));
    assert.equal(r.code, 0, r.all);
    assert.equal(r.out.trim(), `seeded 2 lane(s) on board ${BOARD}`);
    assert.equal((await edgesOf(ids)).length, 1);
    assert.equal((await laneRows(ids)).length, 2);
  });
});

describe('object seed: a failure rolls everything back', () => {
  const noTrace = async (ids, events0) => {
    assert.deepEqual(await laneRows(ids), [], 'no new lane row');
    assert.deepEqual(await edgesOf(ids), [], 'no edge');
    assert.equal((await seededEvents()).length, events0, 'no seeded event');
  };

  it('a cycle in the file: exit 1, the message names the cycle, nothing is written', async () => {
    const before = (await seededEvents()).length;
    const r = seed({ lanes: [item('ds-cy-a'), item('ds-cy-b')], edges: [edge('ds-cy-a', 'ds-cy-b'), edge('ds-cy-b', 'ds-cy-a')] });
    assert.equal(r.code, 1, r.all);
    assert.ok(r.err.includes('seed refused: cycle ds-cy-a -> ds-cy-b -> ds-cy-a'), r.err);
    await noTrace(['ds-cy-a', 'ds-cy-b'], before);
  });

  it('a cycle that closes through an edge already in the database (the board full edge set)', async () => {
    await mkLane('ds-cd-b');
    await q(s.url6, `INSERT INTO agentic_os.lane_dep (lane_id, depends_on, project_key) VALUES ('ds-cd-b','ds-cd-a',$1)`, [BOARD]);
    const before = (await seededEvents()).length;
    const r = seed({ lanes: [item('ds-cd-a')], edges: [edge('ds-cd-a', 'ds-cd-b')] });
    assert.equal(r.code, 1, r.all);
    assert.ok(/seed refused: cycle ds-cd-a -> ds-cd-b -> ds-cd-a/.test(r.err), r.err);
    assert.deepEqual(await laneRows(['ds-cd-a']), [], 'the upserted lane rolled back');
    assert.deepEqual(await edgesOf(['ds-cd-a']), []);
    assert.equal((await seededEvents()).length, before);
  });

  it('an edge to a lane of another board: exit 1, the rule 7 message, nothing is written', async () => {
    await mkLane('ds-xb-other', 'backlog', OTHER);
    const before = (await seededEvents()).length;
    const r = seed({ lanes: [item('ds-xb-a')], edges: [edge('ds-xb-a', 'ds-xb-other')] });
    assert.equal(r.code, 1, r.all);
    assert.ok(r.err.includes(`edge ds-xb-a -> ds-xb-other: lane 'ds-xb-other' belongs to board '${OTHER}'`), r.err);
    await noTrace(['ds-xb-a'], before);
  });

  it('a lane id twice in lanes[]: exit 1, nothing is written', async () => {
    const before = (await seededEvents()).length;
    const r = seed({ lanes: [item('ds-dup-a'), item('ds-dup-a')], edges: [] });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /duplicate lane id "ds-dup-a"/);
    await noTrace(['ds-dup-a'], before);
  });

  it('a lane id that another board owns: exit 1, no edge and no lane written', async () => {
    await mkLane('ds-fo-theirs', 'backlog', OTHER);
    const before = (await seededEvents()).length;
    const r = seed({ lanes: [item('ds-fo-a'), item('ds-fo-theirs')], edges: [edge('ds-fo-a', 'ds-fo-x')] });
    assert.equal(r.code, 1, r.all);
    assert.ok(r.err.includes(`lane id 'ds-fo-theirs' belongs to board '${OTHER}'`), r.err);
    await noTrace(['ds-fo-a'], before);
  });

  it('a failing seed leaves the edges of an earlier seed in place', async () => {
    assert.equal(seed({ lanes: [item('ds-keep-a')], edges: [edge('ds-keep-a', 'ds-keep-b')] }).code, 0);
    const r = seed({ lanes: [item('ds-keep-a'), item('ds-keep-c')], edges: [edge('ds-keep-a', 'ds-keep-c'), edge('ds-keep-c', 'ds-keep-a')] });
    assert.equal(r.code, 1, r.all);
    assert.deepEqual((await edgesOf(['ds-keep-a'])).map((e) => e.depends_on), ['ds-keep-b']);
    assert.deepEqual(await laneRows(['ds-keep-c']), []);
  });
});

describe('board: waits_on', () => {
  it('board --json: waits_on holds the open edges only, sorted; [] when none; board text prints the line after scope', async () => {
    await mkLane('ds-bd-m', 'active');
    await mkLane('ds-bd-p', 'backlog');
    assert.equal(lane(['done', 'ds-bd-m', '--merged', s.A]).code, 0);
    assert.equal(seed({
      lanes: [item('ds-bd-w', { scope: 'OWNS: x' }), item('ds-bd-free')],
      edges: [edge('ds-bd-w', 'ds-bd-zmissing'), edge('ds-bd-w', 'ds-bd-p'), edge('ds-bd-w', 'ds-bd-m')],
    }).code, 0);
    const j = lane(['board', '--json']);
    assert.equal(j.code, 0, j.all);
    const lanes = JSON.parse(j.out).lanes;
    assert.deepEqual(lanes.find((l) => l.id === 'ds-bd-w').waits_on, ['ds-bd-p', 'ds-bd-zmissing']);
    assert.deepEqual(lanes.find((l) => l.id === 'ds-bd-free').waits_on, []);
    assert.equal(warnCount(j.err), 0);
    const t = lane(['board']);
    assert.equal(t.code, 0, t.all);
    assert.match(t.out, /scope: OWNS: x\n\s+waits on: ds-bd-p, ds-bd-zmissing\n/);
    const rows = t.out.split('\n');
    const at = rows.findIndex((l) => l.includes('ds-bd-free'));
    assert.ok(at >= 0, 'the free lane is on the board');
    assert.ok(!/waits on:/.test(rows[at + 1] ?? ''), 'a lane with no open edge gets no waits on line');
  });

  it('waits_on empties when the dependency is met', async () => {
    await mkLane('ds-bm-d', 'active');
    assert.equal(seed({ lanes: [item('ds-bm-w')], edges: [edge('ds-bm-w', 'ds-bm-d')] }).code, 0);
    const open = JSON.parse(lane(['board', '--json']).out).lanes.find((l) => l.id === 'ds-bm-w');
    assert.deepEqual(open.waits_on, ['ds-bm-d']);
    assert.equal(lane(['done', 'ds-bm-d', '--merged', s.A]).code, 0);
    const met = JSON.parse(lane(['board', '--json']).out).lanes.find((l) => l.id === 'ds-bm-w');
    assert.deepEqual(met.waits_on, []);
  });
});

describe('next: the dependency filter', () => {
  const nextIds = () => JSON.parse(lane(['next', '--json', '--n', '500']).out).map((l) => l.id);

  it('never offers a lane with an open edge; offers it after done --merged on the dependency', async () => {
    await mkLane('ds-nx-dep', 'active');
    assert.equal(seed({ lanes: [item('ds-nx-w', { state: 'backlog' }), item('ds-nx-free', { state: 'backlog' })], edges: [edge('ds-nx-w', 'ds-nx-dep')] }).code, 0);
    // a new lane gets the state of the file; this file gave backlog, so only the edge can hold it back
    const before = nextIds();
    assert.ok(!before.includes('ds-nx-w'), 'open edge: not offered');
    assert.ok(before.includes('ds-nx-free'), 'no edge: offered');
    // a plain done meets nothing
    assert.equal(lane(['done', 'ds-nx-dep']).code, 0);
    assert.ok(!nextIds().includes('ds-nx-w'), 'plain done: still not offered');
    assert.equal(lane(['done', 'ds-nx-dep', '--merged', s.A]).code, 0);
    assert.ok(nextIds().includes('ds-nx-w'), 'met: offered');
  });

  it('a dependency with no lane row keeps the lane out of next', async () => {
    assert.equal(seed({ lanes: [item('ds-nm-w', { state: 'ready' })], edges: [edge('ds-nm-w', 'ds-nm-ghost')] }).code, 0);
    assert.ok(!nextIds().includes('ds-nm-w'));
  });
});

describe('apply-kanban reads the lanes with waits_on', () => {
  it('a dry run works on a database with lane_dep and prints no warning', () => {
    const r = lane(['apply-kanban', kanbanFile(), '--dry-run']);
    assert.equal(r.code, 0, r.all);
    assert.equal(warnCount(r.err), 0);
  });
});

describe('the floor: a database without lane_dep (migration 0006)', () => {
  const lanes5 = ['ds-f-a', 'ds-f-b'];
  before(async () => { for (const id of lanes5) await mkLane(id, 'backlog', BOARD, s.url5); });
  const on5 = (args) => lane(args, { url: s.url5 });

  it('there really is no lane_dep table', async () => {
    assert.equal((await q(s.url5, `SELECT to_regclass('agentic_os.lane_dep') IS NOT NULL AS has`)).rows[0].has, false);
  });

  it('next works and prints the warning once', () => {
    const r = on5(['next', '--json', '--n', '50']);
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(JSON.parse(r.out).map((l) => l.id), lanes5);
    assert.equal(warnCount(r.err), 1, r.err);
  });

  it('board --json works, prints the warning once and has NO waits_on key', () => {
    const r = on5(['board', '--json']);
    assert.equal(r.code, 0, r.all);
    const lanes = JSON.parse(r.out).lanes;
    assert.equal(lanes.length, 2);
    for (const l of lanes) assert.equal('waits_on' in l, false, `${l.id} has waits_on`);
    assert.equal(warnCount(r.err), 1, r.err);
  });

  it('board text works and prints the warning once', () => {
    const r = on5(['board']);
    assert.equal(r.code, 0, r.all);
    assert.ok(r.out.includes('ds-f-a'));
    assert.ok(!r.out.includes('waits on:'));
    assert.equal(warnCount(r.err), 1, r.err);
  });

  it('apply-kanban (KANBAN_LANES) works and prints the warning once', () => {
    const r = on5(['apply-kanban', kanbanFile(), '--dry-run']);
    assert.equal(r.code, 0, r.all);
    assert.equal(warnCount(r.err), 1, r.err);
  });

  it('an object-form seed fails with exit 1 and writes nothing', async () => {
    const r = on5(['seed', seedFile({ lanes: [item('ds-f-new')], edges: [edge('ds-f-new', 'ds-f-a')] })]);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /migration 0006/);
    assert.deepEqual(await laneRows(['ds-f-new'], s.url5), []);
  });

  it('an array seed still works', async () => {
    const r = on5(['seed', seedFile([item('ds-f-arr')])]);
    assert.equal(r.code, 0, r.all);
    assert.equal(r.out.trim(), `seeded 1 lane(s) on board ${BOARD}`);
    assert.equal(warnCount(r.err), 0);
  });
});
