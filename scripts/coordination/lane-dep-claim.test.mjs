/**
 * lane-dep-claim.test -- end to end tests for the claim rules of contract t2.1 (points 6 and 7, open points 2, 4, 8):
 * the open-dependency refusal, [done], [blocked], [pack-held], [second-re-lane], --dep-override, exit 4 and exit 3.
 *
 * Every test spawns the real `lane.mjs` as a child process against SCRATCH databases that this file creates and drops
 * itself (one through migration 6, one through migration 5 for the "no lane_dep table" floor). The cwd of each run is a
 * temp git repo with a `main` branch, so `done --merged` runs its git steps for real.
 *
 *   node --test scripts/coordination/lane-dep-claim.test.mjs
 *
 * The file name has no `.db.` part: test CO1 in pre-pr.test.mjs matches the CI list with scripts/coordination/[\w-]+\.test\.mjs.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { assertScratchUrl } from './scratch-db.mjs';
import { wmKey } from './lane-board.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const LANE = path.join(HERE, 'lane.mjs');
const SCRATCH = path.join(HERE, 'scratch-db.mjs');
const { Client } = requireDep('pg', { repoRoot: REPO });

const fwd = (p) => String(p).replace(/\\/g, '/');
const BOARD = 'gc-a';
const OTHER = 'gc-b';
const s = { url6: '', url5: '', db6: null, db5: null, tmp: '', repo: '', registry: '', idDir: '', sha: '', dropped: [] };
const sid = () => randomUUID();
const ME = sid();

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

function cleanGitEnv() {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[k];
  return env;
}
const git = (...args) => execFileSync('git',
  ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
  { cwd: s.repo, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true }).trim();

function laneEnv(url) {
  assertScratchUrl(url);
  const env = cleanGitEnv();
  delete env.LANE_PROJECT; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.LANE_SKIP_HOOK_PRECHECK;
  return Object.assign(env, {
    CONTINUOUS_CLAUDE_DB_URL: url, DATABASE_URL: url, OPC_POSTGRES_URL: url,
    LANE_REGISTRY_PATH: s.registry, CCV3_IDENTITY_DIR: s.idDir, CLAUDE_CODE_SESSION_ID: ME,
  });
}
/** Run the worktree lane.mjs in the temp repo against one scratch database. `as` is the session id of the caller. */
function lane(args, { url = s.url6, as = ME, env = {} } = {}) {
  const r = spawnSync(process.execPath, [LANE, ...args, '--as', as], { cwd: s.repo, env: { ...laneEnv(url), ...env }, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout, err: r.stderr, line1: r.stderr.split('\n')[0] };
}
function laneAsync(args, as) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [LANE, ...args, '--as', as], { cwd: s.repo, env: laneEnv(s.url6), windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', () => {});
    p.on('close', (code) => resolve({ code, err }));
  });
}

const q = (sql, params, url = s.url6) => (url === s.url5 ? s.db5 : s.db6).query(sql, params);
const one = async (sql, params, url) => (await q(sql, params, url)).rows[0];
let seq = 0;
/** A lane row. `owner` and `lapsed` make a held lane; a lapsed owner has no sessions row, so it is dead. */
async function mk(prefix, { state = 'backlog', board = BOARD, branch = null, owner = null, lapsed = false, url = s.url6 } = {}) {
  const id = `${prefix}-${++seq}`;
  await q(
    `INSERT INTO agentic_os.lane (id,title,track,state,project_key,branch,owner_session_id,lease_expires_at)
     VALUES ($1,$2,'zz',$3,$4,$5,$6,$7)`,
    [id, `title of ${id}`, state, board, branch, owner, owner ? new Date(Date.now() + (lapsed ? -3600_000 : 3600_000)) : null], url,
  );
  return id;
}
const edge = (lane, dep, board = BOARD) => q(`INSERT INTO agentic_os.lane_dep (lane_id, depends_on, project_key) VALUES ($1,$2,$3)`, [lane, dep, board]);
const row = (id, url) => one(`SELECT * FROM agentic_os.lane WHERE id=$1`, [id], url);
const eventCount = async (url) => (await one(`SELECT count(*)::int AS n FROM agentic_os.lane_event`, [], url)).n;
const eventsOf = async (id, kind) => (await q(`SELECT * FROM agentic_os.lane_event WHERE lane_id=$1 AND kind=$2 ORDER BY id`, [id, kind])).rows;

/** A refusal: exit 4, line 1 `REFUSED claim <id> [<token>] -- ...`, and no lane_event row written. */
function assertRefused(r, id, token, before, after) {
  assert.equal(r.code, 4, `exit code: ${r.err}`);
  assert.match(r.line1, new RegExp(`^REFUSED claim ${id} \\[${token}\\] -- `), r.err);
  assert.equal(after, before, 'a refusal writes no lane_event row');
}
async function refusedClaim(args, id, token, opts) {
  const before = await eventCount(opts?.url);
  const r = lane(args, opts);
  assertRefused(r, id, token, before, await eventCount(opts?.url));
  return r;
}

before(async () => {
  s.url6 = createScratch(6);
  s.url5 = createScratch(5);
  s.tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dep-claim-')));
  s.repo = path.join(s.tmp, 'repo');
  s.idDir = path.join(s.tmp, 'ids');
  fs.mkdirSync(s.repo); fs.mkdirSync(s.idDir);
  s.registry = path.join(s.tmp, 'registry.json');
  fs.writeFileSync(s.registry, JSON.stringify({ version: '1.0', projects: [{ name: 'gc', key: BOARD, path: fwd(s.repo), status: 'active' }] }));
  git('init', '-b', 'main');
  fs.writeFileSync(path.join(s.repo, 'a.txt'), 'a');
  git('add', 'a.txt'); git('commit', '-m', 'a');
  s.sha = git('rev-parse', 'HEAD');
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

describe('[open-dependency]', () => {
  it('refuses a backlog lane with an open edge (exit 4), then succeeds after done --merged on the dependency', async () => {
    const dep = await mk('gc-dep', { state: 'active', owner: ME });
    const id = await mk('gc-w'); await edge(id, dep);
    const r = await refusedClaim(['claim', id], id, 'open-dependency');
    assert.match(r.line1, new RegExp(`waits on ${dep}$`));
    assert.match(r.err, new RegExp(`\\n  ${dep}: state active\\n`));
    assert.match(r.err, /A dependency is met when its lane is done with a SHA on main: .* done <dep> --merged <sha>\./);
    assert.equal((await row(id)).owner_session_id, null);
    const d = lane(['done', dep, '--merged', s.sha]);
    assert.equal(d.code, 0, d.err);
    const ok = lane(['claim', id]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal((await row(id)).owner_session_id, ME);
  });

  it('under --json a refusal adds one stderr JSON line with waits_on', async () => {
    const dep = await mk('gc-dep'); const id = await mk('gc-w'); await edge(id, dep);
    const r = lane(['claim', id, '--json']);
    assert.equal(r.code, 4);
    const last = JSON.parse(r.err.trim().split('\n').at(-1));
    assert.deepEqual(last, { refused: true, verb: 'claim', id, rule: 'open-dependency', waits_on: [dep] });
  });

  it('a dependency with no lane row has the status "missing"', async () => {
    const id = await mk('gc-w'); await edge(id, 'gc-nobody-here');
    const r = await refusedClaim(['claim', id], id, 'open-dependency');
    assert.match(r.err, /gc-nobody-here: missing: no lane has this id/);
  });

  it('a dependency on another board has the status "on board <key>"', async () => {
    const dep = await mk('gc-dep', { state: 'done', board: OTHER });
    const id = await mk('gc-w'); await edge(id, dep);
    const r = await refusedClaim(['claim', id], id, 'open-dependency');
    assert.match(r.err, new RegExp(`${dep}: on board ${OTHER}`));
  });

  it('a dependency with a plain done has the status "done, but no SHA on main is recorded"', async () => {
    const dep = await mk('gc-dep', { state: 'active', owner: ME });
    const id = await mk('gc-w'); await edge(id, dep);
    assert.equal(lane(['done', dep]).code, 0);
    const r = await refusedClaim(['claim', id], id, 'open-dependency');
    assert.match(r.err, new RegExp(`${dep}: done, but no SHA on main is recorded`));
  });

  it('state <id> review on an unowned backlog lane with an open edge does not open the gate', async () => {
    const dep = await mk('gc-dep'); const id = await mk('gc-w'); await edge(id, dep);
    assert.equal(lane(['state', id, 'review']).code, 0);
    assert.equal((await row(id)).owner_session_id, null);
    await refusedClaim(['claim', id], id, 'open-dependency');
  });

  it('a lapsed active lane with a dead owner and an open edge is reclaimed (the recovery path of 1.10)', async () => {
    const dep = await mk('gc-dep'); const id = await mk('gc-w', { state: 'active', owner: sid(), lapsed: true }); await edge(id, dep);
    const r = lane(['claim', id]);
    assert.equal(r.code, 0, r.err);
    assert.equal((await row(id)).owner_session_id, ME);
  });
});

describe('[done], [blocked] and the held lane', () => {
  it('a blocked lane gives [blocked], exit 4', async () => {
    const id = await mk('gc-b', { state: 'blocked' });
    await refusedClaim(['claim', id], id, 'blocked');
    assert.equal((await row(id)).state, 'blocked');
  });

  it('a done lane gives [done], exit 4, and the text names state ready then claim', async () => {
    const id = await mk('gc-d', { state: 'done' });
    const r = await refusedClaim(['claim', id], id, 'done');
    assert.match(r.err, new RegExp(`state ${id} ready, then .* claim ${id}`));
  });

  it('a lane held by a live session keeps exit 3 and the old DENIED text, even with an open edge', async () => {
    const holder = sid();
    const dep = await mk('gc-dep'); const id = await mk('gc-h', { state: 'active', owner: holder }); await edge(id, dep);
    const r = lane(['claim', id]);
    assert.equal(r.code, 3, r.err);
    assert.match(r.line1, /^DENIED gc-h-\d+ -- held by /);
    assert.doesNotMatch(r.err, /REFUSED/);
  });

  it('two concurrent claims on one lane: one wins, one gets exit 3', async () => {
    const id = await mk('gc-race', { state: 'ready' });
    const res = await Promise.all([laneAsync(['claim', id], sid()), laneAsync(['claim', id], sid())]);
    assert.deepEqual(res.map((r) => r.code).sort(), [0, 3], res.map((r) => r.err).join('|'));
  });

  it('the caller who already holds the lane gets exit 0, "you already hold"', async () => {
    const id = await mk('gc-mine', { state: 'active', owner: ME });
    const r = lane(['claim', id]);
    assert.equal(r.code, 0);
    assert.match(r.out, /you already hold/);
  });
});

describe('[pack-held] and [second-re-lane]', () => {
  it('session A claims both lanes of a pack; session B gets [pack-held] while A is live', async () => {
    const A = sid(); const B = sid();
    const v = await mk('re-v', { branch: 're/gc-pack-1' }); const f = await mk('re-f', { branch: 're/gc-pack-1' });
    assert.equal(lane(['claim', v], { as: A }).code, 0);
    const r = await refusedClaim(['claim', f], f, 'pack-held', { as: B });
    assert.match(r.line1, new RegExp(`${v} on branch re/gc-pack-1 is held by `));
    const ok = lane(['claim', f], { as: A });
    assert.equal(ok.code, 0, ok.err);
    assert.equal((await row(f)).owner_session_id, A);
  });

  it('two lanes with branch main and one session: the second claim gets [second-re-lane]', async () => {
    const A = sid();
    const one1 = await mk('re-m', { branch: 'main' }); const two = await mk('re-m', { branch: 'main' });
    assert.equal(lane(['claim', one1], { as: A }).code, 0);
    const r = await refusedClaim(['claim', two], two, 'second-re-lane', { as: A });
    assert.match(r.line1, new RegExp(`you hold ${one1}$`));
    assert.match(r.err, new RegExp(`release it \\(.* release ${one1}\\), then claim ${two}`));
  });

  it('when the other lane is in review the text does not suggest release', async () => {
    const A = sid();
    const held = await mk('re-r', { state: 'review', owner: A, branch: 're/gc-solo-1' }); const two = await mk('re-r', { branch: 're/gc-solo-2' });
    const r = await refusedClaim(['claim', two], two, 'second-re-lane', { as: A });
    assert.match(r.err, new RegExp(`done ${held} --merged <sha>\\), or end this session so a fresh session can claim ${two} by id`));
    assert.doesNotMatch(r.err, /release/);
  });

  it('a re- lane held on another board does not trigger [second-re-lane]', async () => {
    const A = sid();
    await mk('re-o', { state: 'active', owner: A, board: OTHER, branch: 're/gc-other-1' });
    const here = await mk('re-o', { branch: 're/gc-other-2' });
    const r = lane(['claim', here], { as: A });
    assert.equal(r.code, 0, r.err);
  });

  it('a lane that is not a re- lane is not limited to one per session', async () => {
    const A = sid();
    const x = await mk('gc-x'); const y = await mk('gc-y');
    assert.equal(lane(['claim', x], { as: A }).code, 0);
    assert.equal(lane(['claim', y], { as: A }).code, 0);
  });
});

describe('--dep-override', () => {
  it('with a reason it claims and writes one dep_override event (to_session_id NULL, body and detail as written)', async () => {
    const dep = await mk('gc-dep'); const id = await mk('gc-w'); await edge(id, dep);
    const r = lane(['claim', id, '--dep-override', '--reason', 'seat says go']);
    assert.equal(r.code, 0, r.err);
    assert.equal((await row(id)).owner_session_id, ME);
    const ev = await eventsOf(id, 'dep_override');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].to_session_id, null);
    assert.equal(ev[0].session_id, ME);
    assert.equal(ev[0].body, `${id} claimed with open dependencies ${dep}: seat says go`);
    assert.deepEqual(ev[0].detail, { waitsOn: [dep], reason: 'seat says go' });
    assert.equal((await eventsOf(id, 'claimed')).length, 1);
  });

  it('B5: an override on a lane with no open edge still writes exactly one dep_override event, with waitsOn []', async () => {
    const lone = await mk('gc-ovlone');
    const met = await mk('gc-ovmet'); const dep = await mk('gc-ovdep', { state: 'done' });
    await edge(met, dep);
    // A dependency is met when it is done AND its latest lifecycle event is a done event with a 40 hex SHA (contract point 3).
    await q(`INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, body, detail, project_key) VALUES ($1,'done',$2,'merged',$3,$4)`,
      [dep, ME, JSON.stringify({ state: 'done', merged: 'a'.repeat(40) }), BOARD]);
    for (const id of [lone, met]) {
      const r = lane(['claim', id, '--dep-override', '--reason', 'no edge is open']);
      assert.equal(r.code, 0, r.err);
      assert.equal((await row(id)).owner_session_id, ME);
      const ev = await eventsOf(id, 'dep_override');
      assert.equal(ev.length, 1, `${id}: one dep_override event`);
      assert.equal(ev[0].to_session_id, null);
      assert.deepEqual(ev[0].detail, { waitsOn: [], reason: 'no edge is open' });
      assert.equal(ev[0].body, `${id} claimed with open dependencies (none): no edge is open`);
    }
  });

  it('without --reason it is a usage error (exit 1) and nothing is written', async () => {
    const dep = await mk('gc-dep'); const id = await mk('gc-w'); await edge(id, dep);
    const before = await eventCount();
    const r = lane(['claim', id, '--dep-override']);
    assert.equal(r.code, 1);
    assert.match(r.err, /--dep-override needs --reason/);
    assert.equal((await row(id)).owner_session_id, null);
    assert.equal(await eventCount(), before);
  });

  it('a --reason with no text is a usage error (exit 1)', async () => {
    const dep = await mk('gc-dep'); const id = await mk('gc-w'); await edge(id, dep);
    const r = lane(['claim', id, '--dep-override', '--reason']);
    assert.equal(r.code, 1);
    assert.equal((await row(id)).owner_session_id, null);
  });

  it('it lifts the dependency refusal only: a second re- lane still gives [second-re-lane]', async () => {
    const A = sid();
    const held = await mk('re-p', { state: 'active', owner: A, branch: 're/gc-ov-1' });
    const two = await mk('re-p', { branch: 're/gc-ov-2' }); await edge(two, 'gc-nobody-here');
    const r = await refusedClaim(['claim', two, '--dep-override', '--reason', 'x'], two, 'second-re-lane', { as: A });
    assert.match(r.line1, new RegExp(`you hold ${held}$`));
    assert.equal((await eventsOf(two, 'dep_override')).length, 0);
  });

  it('it does not lift [blocked]', async () => {
    const id = await mk('gc-b', { state: 'blocked' });
    await refusedClaim(['claim', id, '--dep-override', '--reason', 'x'], id, 'blocked');
  });
});

/** A refusal of a verb other than claim: exit 4, line 1 `REFUSED <verb> <id> [<token>] -- ...`, and no lane_event row written. */
async function refusedVerb(args, verb, id, token, opts) {
  const before = await eventCount(opts?.url);
  const r = lane(args, opts);
  assert.equal(r.code, 4, `exit code: ${r.err}`);
  assert.match(r.line1, new RegExp(`^REFUSED ${verb} ${id} \\[${token}\\] -- `), r.err);
  assert.equal(await eventCount(opts?.url), before, 'a refusal writes no lane_event row');
  return r;
}
const laneEvents = async (id) => (await q(`SELECT * FROM agentic_os.lane_event WHERE lane_id=$1 ORDER BY id`, [id])).rows;
/** Make the insert of an event of this kind fail, run fn, and always take the constraint away again. */
async function withBlockedEventKind(kind, fn) {
  await q(`ALTER TABLE agentic_os.lane_event ADD CONSTRAINT zz_block_kind CHECK (kind <> '${kind}') NOT VALID`);
  try { return await fn(); } finally { await q(`ALTER TABLE agentic_os.lane_event DROP CONSTRAINT IF EXISTS zz_block_kind`); }
}

describe('owner rule: state, release and plain done refuse a caller that is not the holder', () => {
  const HOLDER = sid();

  it('F1: a stranger state change on a lane that a live session holds gives [not-holder], exit 4, and writes nothing', async () => {
    const id = await mk('or-s', { state: 'active', owner: HOLDER });
    const r = await refusedVerb(['state', id, 'review'], 'state', id, 'not-holder');
    assert.match(r.line1, /-- the lane is held by .+/);
    // The recipient is the first 8 hex of the owner id, quoted, with no "#": a bare # starts a shell comment and would turn the DM into a broadcast.
    assert.ok(r.err.includes(`say "..." --to '${HOLDER.slice(0, 8)}'. The seat may add --override --reason "<why>".`), r.err);
    assert.doesNotMatch(r.err, /--to #/);
    const after = await row(id);
    assert.equal(after.state, 'active');
    assert.equal(after.owner_session_id, HOLDER);
  });

  it('F1: under --json a refusal adds the stderr line with the verb, the rule and the holder id', async () => {
    const id = await mk('or-j', { state: 'active', owner: HOLDER });
    const r = lane(['state', id, 'review', '--json']);
    assert.equal(r.code, 4);
    assert.deepEqual(JSON.parse(r.err.trim().split('\n').at(-1)), { refused: true, verb: 'state', id, rule: 'not-holder', holder: HOLDER });
  });

  it('F2 and F8: release and plain done by a stranger are refused with their own verb in line 1, and the holder stays', async () => {
    const a = await mk('or-r', { state: 'active', owner: HOLDER });
    await refusedVerb(['release', a], 'release', a, 'not-holder');
    const b = await mk('or-d', { state: 'active', owner: HOLDER });
    await refusedVerb(['done', b], 'done', b, 'not-holder');
    await refusedVerb(['state', b, 'done'], 'state', b, 'not-holder');
    for (const id of [a, b]) {
      const after = await row(id);
      assert.equal(after.state, 'active');
      assert.equal(after.owner_session_id, HOLDER);
    }
  });

  it('F4: the holder itself may run state, release and done', async () => {
    const a = await mk('or-h', { state: 'active', owner: HOLDER });
    assert.equal(lane(['state', a, 'review'], { as: HOLDER }).code, 0);
    assert.equal((await row(a)).state, 'review');
    assert.equal(lane(['release', a], { as: HOLDER }).code, 0);
    assert.equal((await row(a)).state, 'ready');
    const b = await mk('or-h', { state: 'active', owner: HOLDER });
    assert.equal(lane(['done', b], { as: HOLDER }).code, 0);
    assert.equal((await row(b)).state, 'done');
  });

  it('diagnosis order: a stranger with a wrong --if-state on a held lane gets [not-holder], not [if-state]', async () => {
    const id = await mk('or-o', { state: 'active', owner: HOLDER });
    await refusedVerb(['state', id, 'review', '--if-state', 'ready'], 'state', id, 'not-holder');
  });

  it('F4: a lane with no holder still opens for any session: reopen a done lane, an unowned ready lane, a dead holder with --reason', async () => {
    const done = await mk('or-n', { state: 'done' });
    assert.equal(lane(['state', done, 'ready']).code, 0);
    assert.equal((await row(done)).state, 'ready');
    const free = await mk('or-n', { state: 'ready' });
    assert.equal(lane(['state', free, 'review']).code, 0);
    const dead = await mk('or-n', { state: 'active', owner: sid(), lapsed: true });
    const r = lane(['state', dead, 'ready', '--reason', 'owner is gone']);
    assert.equal(r.code, 0, r.err);
    assert.equal((await row(dead)).state, 'ready');
  });
});

describe('owner rule: --reason, [needs-reason] and --override', () => {
  const HOLDER = sid();

  it('F5: an unowned blocked lane does not open without --reason, for ready and for backlog, and nothing is written', async () => {
    const id = await mk('nr-b', { state: 'blocked' });
    const r = await refusedVerb(['state', id, 'ready'], 'state', id, 'needs-reason');
    assert.match(r.line1, /-- the lane is blocked$/);
    assert.match(r.err, /Add --reason "<why>"\. The change is logged and sent to the board\./);
    await refusedVerb(['state', id, 'backlog'], 'state', id, 'needs-reason');
    assert.equal((await row(id)).state, 'blocked');
  });

  it('F5: with --reason the blocked lane opens, and one board event carries the reason, the old state and the old owner', async () => {
    const id = await mk('nr-o', { state: 'blocked' });
    const r = lane(['state', id, 'ready', '--reason', 'seat takeover']);
    assert.equal(r.code, 0, r.err);
    assert.equal((await row(id)).state, 'ready');
    const evs = await laneEvents(id);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].kind, 'state_changed');
    assert.equal(evs[0].to_session_id, null);
    assert.deepEqual(evs[0].detail, { state: 'ready', from: 'blocked', reason: 'seat takeover', prevOwner: null });
  });

  it('a lane whose holder is quiet and whose lease ended needs --reason, and the text names the holder', async () => {
    const dead = sid();
    const id = await mk('nr-q', { state: 'active', owner: dead, lapsed: true });
    const r = await refusedVerb(['state', id, 'review'], 'state', id, 'needs-reason');
    assert.match(r.line1, /-- its holder .+ is quiet and the lease ended$/);
    const ok = lane(['state', id, 'review', '--reason', 'holder is gone']);
    assert.equal(ok.code, 0, ok.err);
    const ev = (await laneEvents(id)).at(-1);
    assert.equal(ev.to_session_id, null);
    assert.equal(ev.detail.prevOwner, dead);
    assert.equal(ev.detail.from, 'active');
  });

  it('F6: --override --reason changes a held lane and writes exactly two events: a DM to the old owner, then one board broadcast', async () => {
    const id = await mk('ov-a', { state: 'active', owner: HOLDER });
    const r = lane(['state', id, 'review', '--override', '--reason', 'holder stuck']);
    assert.equal(r.code, 0, r.err);
    assert.equal((await row(id)).state, 'review');
    const evs = await laneEvents(id);
    assert.equal(evs.length, 2, JSON.stringify(evs.map((e) => [e.kind, e.to_session_id])));
    const [dm, board] = evs;
    assert.equal(dm.to_session_id, HOLDER);
    assert.equal(dm.kind, 'note');
    assert.match(dm.body, /holder stuck/);
    assert.equal(board.to_session_id, null);
    assert.equal(board.kind, 'state_changed');
    assert.match(board.body, /holder stuck/);
    assert.equal(board.detail.prevOwner, HOLDER);
    assert.equal(board.detail.reason, 'holder stuck');
    assert.ok(dm.id < board.id, 'the lifecycle event is written last');
  });

  it('F6: --override on a lane with no owner writes one board event and no DM', async () => {
    const id = await mk('ov-n', { state: 'blocked' });
    assert.equal(lane(['state', id, 'ready', '--override', '--reason', 'open it']).code, 0);
    const evs = await laneEvents(id);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].to_session_id, null);
  });

  it('F6: --override without --reason is a usage error (exit 1) and nothing is written', async () => {
    const id = await mk('ov-u', { state: 'active', owner: HOLDER });
    const before = await eventCount();
    for (const args of [['state', id, 'review', '--override'], ['release', id, '--override'], ['done', id, '--override']]) {
      const r = lane(args);
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.err}`);
      assert.match(r.err, /--override needs --reason/);
    }
    assert.equal(await eventCount(), before);
    assert.equal((await row(id)).state, 'active');
  });

  it('L10: --override takes no value, so "state --override <id> review" keeps the lane id', async () => {
    const id = await mk('ov-b', { state: 'active', owner: HOLDER });
    const r = lane(['state', '--override', id, 'review', '--reason', 'x']);
    assert.equal(r.code, 0, r.err);
    assert.equal((await row(id)).state, 'review');
  });

  it('F6: an event insert that fails rolls the state change back (the change never lands without its event)', async () => {
    const id = await mk('ov-t', { state: 'ready' });
    await withBlockedEventKind('state_changed', async () => {
      const r = lane(['state', id, 'review']);
      assert.notEqual(r.code, 0, r.err);
      assert.notEqual(r.code, 4);
    });
    assert.equal((await row(id)).state, 'ready', 'no change without its event');
    assert.equal((await laneEvents(id)).length, 0);
  });
});

describe('owner rule: --if-state', () => {
  const HOLDER = sid();

  it('F7: a wrong --if-state gives [if-state], exit 4, names the current state, and writes nothing', async () => {
    const id = await mk('is-w', { state: 'active', owner: ME });
    const r = await refusedVerb(['state', id, 'review', '--if-state', 'ready'], 'state', id, 'if-state');
    assert.match(r.line1, /-- the lane is active, not ready$/);
    assert.equal((await row(id)).state, 'active');
    const j = lane(['state', id, 'review', '--if-state', 'ready', '--json']);
    assert.deepEqual(JSON.parse(j.err.trim().split('\n').at(-1)), { refused: true, verb: 'state', id, rule: 'if-state', state: 'active' });
  });

  it('F7: the right --if-state writes; a wrong one also stops the override path; the blocked-lane path works with --reason', async () => {
    const a = await mk('is-r', { state: 'active', owner: ME });
    assert.equal(lane(['state', a, 'review', '--if-state', 'active']).code, 0);
    const b = await mk('is-o', { state: 'active', owner: HOLDER });
    await refusedVerb(['state', b, 'review', '--if-state', 'ready', '--override', '--reason', 'x'], 'state', b, 'if-state');
    const c = await mk('is-b', { state: 'blocked' });
    assert.equal(lane(['state', c, 'backlog', '--if-state', 'blocked', '--reason', 'program sync']).code, 0);
    assert.equal((await row(c)).state, 'backlog');
  });

  it('F7: a state name that does not exist is a usage error (exit 1), and a bare --if-state too', async () => {
    const id = await mk('is-u', { state: 'active', owner: ME });
    for (const args of [['state', id, 'review', '--if-state', 'nope'], ['state', id, 'review', '--if-state']]) {
      const r = lane(args);
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.err}`);
      assert.doesNotMatch(r.err, /REFUSED/);
    }
    assert.equal((await row(id)).state, 'active');
  });
});

describe('owner rule: the hint for a session that lost its own lane (M5)', () => {
  const idFile = (u, o) => fs.writeFileSync(path.join(s.idDir, `${u}.json`), JSON.stringify({ uuid: u, updatedAt: new Date().toISOString(), ...o }));

  it('F15: when the holder has the same name as the caller, the hint names adopt --from <holder uuid>', async () => {
    const holder = sid(); const fresh = sid();
    idFile(holder, { name: 'zz-or-twin' }); idFile(fresh, { name: 'zz-or-twin' });
    const id = await mk('m5-n', { state: 'active', owner: holder });
    const r = await refusedVerb(['state', id, 'review'], 'state', id, 'not-holder', { as: fresh });
    assert.match(r.err, new RegExp(`adopt --from ${holder}`));
  });

  it('F15: when the caller names the holder as previous, the hint names adopt --from <holder uuid>', async () => {
    const holder = sid(); const fresh = sid();
    idFile(fresh, { name: 'zz-or-succ', previous: holder });
    const id = await mk('m5-p', { state: 'active', owner: holder });
    const r = await refusedVerb(['release', id], 'release', id, 'not-holder', { as: fresh });
    assert.match(r.err, new RegExp(`adopt --from ${holder}`));
  });

  it('F15: an unrelated holder gets no adopt hint', async () => {
    const holder = sid(); const other = sid();
    idFile(holder, { name: 'zz-or-a' }); idFile(other, { name: 'zz-or-b' });
    const id = await mk('m5-u', { state: 'active', owner: holder });
    const r = await refusedVerb(['state', id, 'review'], 'state', id, 'not-holder', { as: other });
    assert.doesNotMatch(r.err, /adopt/);
  });
});

describe('owner rule: the [not-holder] hint recipient works in `say --to`', () => {
  it('the quoted 8 hex of the hint reaches the holder (a DM, to_session_id set), not the whole board', async () => {
    const holder = sid();
    await q(`INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES ($1,'probe','probe',now())`, [holder]);
    const id = await mk('hint-s', { state: 'active', owner: holder });
    const r = lane(['state', id, 'review']);
    const to = /--to '([0-9a-f]{8})'/.exec(r.err)?.[1];
    assert.equal(to, holder.slice(0, 8), r.err);
    const say = lane(['say', 'hint check', '--to', to]);
    assert.equal(say.code, 0, say.err);
    const ev = await one(`SELECT to_session_id FROM agentic_os.lane_event WHERE kind='note' AND body='hint check' ORDER BY id DESC LIMIT 1`);
    assert.equal(ev?.to_session_id, holder);
  });
});

// Wake test 2026-11-13 (.claudedocs/e2e-say-wake-test): a lane DM never starts a turn in an idle session. `say --to`
// prints one note on stdout after "sent to" when the receiver has been idle IDLE_NOTE_MINUTES (2). Failure modes:
// no note for an idle receiver; a note for an active one, a broadcast or a headless run; a failed idle read that
// changes the exit code, drops "sent to" or adds the note; the note before "sent to" or on stderr.
describe('say --to: a note for an idle receiver (wake test)', () => {
  const NOTE = /^note: a lane DM shows at .+'s next turn and does not start one\. To wake an idle session, also use SendMessage; a session in another permission-mode class holds it for Dave\.$/;
  const peer = async (minutesAgo) => {
    const id = sid();
    await q(`INSERT INTO sessions (id, project, working_on, last_heartbeat, last_activity_at)
             VALUES ($1,'probe','probe', now() - make_interval(mins => $2::int), now() - make_interval(mins => $2::int))`, [id, minutesAgo]);
    return id;
  };
  const lines = (r) => r.out.trim().split('\n');

  it('idle receiver (10 min): exit 0, "sent to" first, then the note, on stdout', async () => {
    const to = await peer(10);
    const r = lane(['say', 'idle-1 body', '--to', to.slice(0, 8)], { env: { LANE_CONTEXT_HEADLESS: '' } });
    assert.equal(r.code, 0, r.err);
    assert.match(lines(r)[0], /^sent to /);
    assert.match(lines(r)[1] ?? '', NOTE, r.out);
    assert.doesNotMatch(r.err, /note:/);
    assert.equal((await q(`SELECT 1 FROM agentic_os.lane_event WHERE body='idle-1 body' AND to_session_id=$1`, [to])).rowCount, 1);
  });

  it('active receiver (now): no note', async () => {
    const to = await peer(0);
    const r = lane(['say', 'idle-2 body', '--to', to.slice(0, 8)], { env: { LANE_CONTEXT_HEADLESS: '' } });
    assert.equal(r.code, 0, r.err);
    assert.equal(lines(r).length, 1, r.out);
  });

  it('broadcast: no note', async () => {
    await peer(10);
    const r = lane(['say', 'idle-3 body'], { env: { LANE_CONTEXT_HEADLESS: '' } });
    assert.equal(r.code, 0, r.err);
    assert.equal(lines(r).length, 1, r.out);
  });

  it('headless (LANE_CONTEXT_HEADLESS=1): no note', async () => {
    const to = await peer(10);
    const r = lane(['say', 'idle-4 body', '--to', to.slice(0, 8)], { env: { LANE_CONTEXT_HEADLESS: '1' } });
    assert.equal(r.code, 0, r.err);
    assert.equal(lines(r).length, 1, r.out);
  });

  it('the idle read fails: no note, "sent to" and exit 0, the event is written', async () => {
    const to = await peer(10);
    // sessions becomes a view that raises only inside the query tagged /* say-idle-note */, so the recipient lookup
    // still works. A view, not row security: the local role is a superuser, and a superuser skips row security.
    await q(`CREATE FUNCTION public.zz_idle_boom() RETURNS boolean LANGUAGE plpgsql AS $f$
      BEGIN IF current_query() LIKE '%say-idle-note%' THEN RAISE EXCEPTION 'idle read blocked by test'; END IF; RETURN true; END $f$`);
    await q(`ALTER TABLE sessions RENAME TO zz_sessions_real`);
    await q(`CREATE VIEW sessions AS SELECT * FROM zz_sessions_real WHERE public.zz_idle_boom()`);
    let r;
    try {
      // Control: the fault fires for a tagged read of sessions, so the case below is not vacuous.
      await assert.rejects(q(`/* say-idle-note */ SELECT id FROM sessions WHERE id=$1`, [to]), /idle read blocked by test/);
      r = lane(['say', 'idle-5 body', '--to', to.slice(0, 8)], { env: { LANE_CONTEXT_HEADLESS: '' } });
    } finally {
      await q(`DROP VIEW IF EXISTS sessions`);
      await q(`ALTER TABLE zz_sessions_real RENAME TO sessions`);
      await q(`DROP FUNCTION IF EXISTS public.zz_idle_boom()`);
    }
    assert.equal(r.code, 0, r.err);
    assert.match(lines(r)[0], /^sent to /);
    assert.equal(lines(r).length, 1, r.out);
    assert.equal((await q(`SELECT 1 FROM agentic_os.lane_event WHERE body='idle-5 body'`)).rowCount, 1);
  });
});

describe('say: a note insert that fails is reported, never "sent"', () => {
  it('say-F1: a failed note insert gives exit 1, the "not confirmed" line, no "sent" and no event row', async () => {
    const r = await withBlockedEventKind('note', async () => lane(['say', 'sf1 body']));
    assert.equal(r.code, 1, `stdout: ${r.out} stderr: ${r.err}`);
    assert.match(r.err, /^not confirmed: .+\. It may already be on the board; a resend can post it twice\.\n$/, r.err);
    assert.doesNotMatch(r.out, /sent/);
    assert.equal((await q(`SELECT 1 FROM agentic_os.lane_event WHERE body='sf1 body'`)).rowCount, 0);
  });

  it('say: a missing migration still prints the migration message, unwrapped (guard: passes before and after)', async () => {
    // A trigger raises what Postgres raises for a missing project_key column. The insert of a note fails with 42703.
    await q(`CREATE FUNCTION agentic_os.zz_say_mig() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION USING ERRCODE = '42703', MESSAGE = 'column "project_key" of relation "lane_event" does not exist'; END $f$`);
    await q(`CREATE TRIGGER zz_say_mig BEFORE INSERT ON agentic_os.lane_event FOR EACH ROW WHEN (NEW.kind = 'note') EXECUTE FUNCTION agentic_os.zz_say_mig()`);
    let r;
    try { r = lane(['say', 'smig body']); } finally {
      await q(`DROP TRIGGER IF EXISTS zz_say_mig ON agentic_os.lane_event`);
      await q(`DROP FUNCTION IF EXISTS agentic_os.zz_say_mig()`);
    }
    assert.equal(r.code, 1, r.err);
    assert.equal(r.err, 'migration 0004 is not applied to this database\n');
    assert.equal(r.out, '');
  });
});

describe('inbox: the cursor never moves back (row 49)', () => {
  it('F49: an inbox that waited on the cursor row while a higher cursor committed leaves the higher cursor', async () => {
    const reader = sid();
    const key = wmKey(reader, BOARD);
    const base = (await one(`SELECT COALESCE(max(id),0)::int AS n FROM agentic_os.lane_event`)).n;
    const high = base + 1000;
    // The cursor row exists first, below the broadcast the inbox will read.
    await q(`INSERT INTO agentic_os.lane_watermark (session_id, last_event_id) VALUES ($1,$2)`, [key, base]);
    await q(`INSERT INTO agentic_os.lane_event (kind, session_id, body, project_key) VALUES ('note',$1,'f49 broadcast',$2)`, [sid(), BOARD]);
    const holder = new Client({ connectionString: s.url6 });
    await holder.connect();
    let child = null;
    let waiting = false;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM agentic_os.lane_watermark WHERE session_id=$1 FOR UPDATE`, [key]);
      child = laneAsync(['inbox'], reader);
      // 15 s: the test files run in parallel, so a slow runner can need more than 5 s. The loop exits at the first hit.
      for (const end = Date.now() + 15000; !waiting && Date.now() < end; await new Promise((ok) => setTimeout(ok, 50))) {
        waiting = (await one(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND pid <> pg_backend_pid() AND query LIKE '%INTO agentic_os.lane_watermark%'`)).n > 0;
      }
      if (waiting) {
        await holder.query(`UPDATE agentic_os.lane_watermark SET last_event_id=$2 WHERE session_id=$1`, [key, high]);
        await holder.query('COMMIT');
      }
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end().catch(() => {});
    }
    const r = child ? await child : { code: null, err: 'inbox was never started' };
    assert.ok(waiting, 'the inbox upsert was never seen waiting on the cursor row: the test would prove nothing');
    assert.equal(r.code, 0, r.err);
    const wm = await one(`SELECT last_event_id::int AS n FROM agentic_os.lane_watermark WHERE session_id=$1`, [key]);
    assert.equal(wm.n, high, 'the cursor must keep the higher value');
  });
});

describe('owner rule: a flag the verb does not take is a usage error (exit 1) before any write', () => {
  const HOLDER = sid();
  /** Run each arg list as the holder: exit 1, the usage text names the flag and the verb, nothing is written. */
  async function usageErrors(id, lists, flag) {
    const before = await row(id);
    const events = await eventCount();
    for (const [verb, ...args] of lists) {
      const r = lane([verb, ...args], { as: HOLDER });
      assert.equal(r.code, 1, `${verb} ${flag}: ${r.err}`);
      assert.match(r.err, new RegExp(`--${flag} does not apply to ${verb}`), r.err);
      assert.doesNotMatch(r.err, /REFUSED/);
    }
    assert.deepEqual(await row(id), before, `${flag} changed the lane`);
    assert.equal(await eventCount(), events, `${flag} wrote an event`);
  }

  it('--if-state on release, done (all three forms) and park', async () => {
    const id = await mk('fl-i', { state: 'active', owner: HOLDER });
    await usageErrors(id, [
      ['release', id, '--if-state', 'blocked'], ['done', id, '--if-state', 'blocked'],
      ['done', id, '--merged', s.sha, '--if-state', 'blocked'],
      ['done', id, '--no-pr', '--evidence', 'x.md', '--if-state', 'blocked'],
      ['park', id, '--for', '3h', ...WHY, '--if-state', 'active'],
    ], 'if-state');
  });

  it('--blocked on state and done (all three forms)', async () => {
    const id = await mk('fl-b', { state: 'active', owner: HOLDER });
    await usageErrors(id, [
      ['state', id, 'review', '--blocked', '--reason', 'x'], ['done', id, '--blocked', '--reason', 'x'],
      ['done', id, '--merged', s.sha, '--blocked', '--reason', 'x'],
    ], 'blocked');
  });

  it('--override on note, add, park and claim (it is --dep-override for claim)', async () => {
    const id = await mk('fl-o', { state: 'active', owner: HOLDER });
    const free = await mk('fl-o', { state: 'ready' });
    await usageErrors(id, [
      ['note', id, 'x', '--override', '--reason', 'y'], ['add', id, '--title', 'new title', '--override', '--reason', 'y'],
      ['park', id, '--for', '3h', ...WHY, '--override'], ['claim', free, '--override', '--reason', 'y'],
    ], 'override');
    assert.equal((await row(free)).owner_session_id, null, 'the refused claim took nothing');
    assert.equal((await row(id)).title, `title of ${id}`);
  });
});

describe('owner rule: usage lines of release and done name their flags', () => {
  it('release with no id names --blocked, --reason and --override; done with no id names --merged, --no-pr --evidence, --reason and --override', () => {
    const rel = lane(['release']);
    assert.equal(rel.code, 1, rel.err);
    for (const w of ['usage: lane.mjs release', '--blocked', '--reason', '--override']) assert.ok(rel.err.includes(w), `release usage lacks ${w}: ${rel.err}`);
    const done = lane(['done']);
    assert.equal(done.code, 1, done.err);
    for (const w of ['usage: lane.mjs done', '--merged', '--no-pr', '--evidence', '--reason', '--override']) assert.ok(done.err.includes(w), `done usage lacks ${w}: ${done.err}`);
    const merged = lane(['done', '--merged', s.sha]);
    assert.equal(merged.code, 1, merged.err);
    assert.ok(merged.err.includes('--override'), merged.err);
  });
});

describe('claim DENIED names adopt --from when the caller may adopt the holder (M5)', () => {
  const idFile = (u, o) => fs.writeFileSync(path.join(s.idDir, `${u}.json`), JSON.stringify({ uuid: u, updatedAt: new Date().toISOString(), ...o }));

  it('a fresh session with the same name as a live holder: exit 3 and the text names adopt --from <holder uuid>', async () => {
    const holder = sid(); const fresh = sid();
    idFile(holder, { name: 'zz-den-twin' }); idFile(fresh, { name: 'zz-den-twin' });
    const id = await mk('den-a', { state: 'active', owner: holder });
    const r = lane(['claim', id], { as: fresh });
    assert.equal(r.code, 3, r.err);
    assert.match(r.err, /^DENIED /);
    assert.ok(r.err.includes(`adopt --from ${holder}`), r.err);
  });

  it('an unrelated caller gets the plain DENIED text with no adopt hint', async () => {
    const holder = sid(); const other = sid();
    idFile(holder, { name: 'zz-den-a' }); idFile(other, { name: 'zz-den-b' });
    const id = await mk('den-u', { state: 'active', owner: holder });
    const r = lane(['claim', id], { as: other });
    assert.equal(r.code, 3, r.err);
    assert.doesNotMatch(r.err, /adopt/);
  });
});

describe('owner rule: release --blocked --reason (S1)', () => {
  const HOLDER = sid();

  it('F16: the holder gets state blocked, no owner, no lease and the note, in one statement, with one board event', async () => {
    const id = await mk('rb-h', { state: 'active', owner: HOLDER });
    const r = lane(['release', id, '--blocked', '--reason', 'waits on O1'], { as: HOLDER });
    assert.equal(r.code, 0, r.err);
    const after = await row(id);
    assert.equal(after.state, 'blocked');
    assert.equal(after.owner_session_id, null);
    assert.equal(after.lease_expires_at, null);
    assert.equal(after.note, 'waits on O1');
    const evs = await laneEvents(id);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].kind, 'state_changed');
    assert.equal(evs[0].to_session_id, null);
    assert.deepEqual(evs[0].detail, { state: 'blocked', from: 'active', reason: 'waits on O1', released: true, prevOwner: HOLDER });
    await refusedClaim(['claim', id], id, 'blocked');
  });

  it('F16: the lane is never ready and never keeps its owner: a failed event insert leaves it active and held', async () => {
    const id = await mk('rb-f', { state: 'active', owner: HOLDER });
    await withBlockedEventKind('state_changed', async () => {
      const r = lane(['release', id, '--blocked', '--reason', 'x'], { as: HOLDER });
      assert.notEqual(r.code, 0);
    });
    const after = await row(id);
    assert.equal(after.state, 'active');
    assert.equal(after.owner_session_id, HOLDER);
  });

  it('F16: a non-holder is refused, also when the holder is quiet and --reason is given', async () => {
    const live = await mk('rb-s', { state: 'active', owner: HOLDER });
    await refusedVerb(['release', live, '--blocked', '--reason', 'x'], 'release', live, 'not-holder');
    const quiet = await mk('rb-q', { state: 'active', owner: sid(), lapsed: true });
    await refusedVerb(['release', quiet, '--blocked', '--reason', 'x'], 'release', quiet, 'not-holder');
    assert.equal((await row(live)).state, 'active');
    assert.equal((await row(quiet)).state, 'active');
  });

  it('F16: --blocked without --reason is a usage error (exit 1) and the lane stays held', async () => {
    const id = await mk('rb-u', { state: 'active', owner: HOLDER });
    const r = lane(['release', id, '--blocked'], { as: HOLDER });
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /--blocked needs --reason/);
    assert.equal((await row(id)).owner_session_id, HOLDER);
  });

  it('F16: with --override --reason a stranger can do it, and the old owner gets a DM besides the board event', async () => {
    const id = await mk('rb-o', { state: 'active', owner: HOLDER });
    assert.equal(lane(['release', id, '--blocked', '--override', '--reason', 'handover']).code, 0);
    assert.equal((await row(id)).owner_session_id, null);
    const evs = await laneEvents(id);
    assert.deepEqual(evs.map((e) => e.to_session_id), [HOLDER, null]);
  });

  it('a plain release stays state ready', async () => {
    const id = await mk('rb-p', { state: 'active', owner: HOLDER });
    assert.equal(lane(['release', id], { as: HOLDER }).code, 0);
    assert.equal((await row(id)).state, 'ready');
  });
});

/** Minutes from now to the stored lease. */
const leaseMin = async (id) => Number((await one(`SELECT extract(epoch FROM (lease_expires_at - now())) / 60 AS m FROM agentic_os.lane WHERE id=$1`, [id])).m);
const setLease = (id, minutes) => q(`UPDATE agentic_os.lane SET lease_expires_at = now() + ($2::int * interval '1 minute') WHERE id=$1`, [id, minutes]);
const setNote = (id, note) => q(`UPDATE agentic_os.lane SET note=$2 WHERE id=$1`, [id, note]);
const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +-${tol}`);
const WHY = ['--reason', 'waits on Dave'];

describe('park: who may park, the storage, the bounds', () => {
  const HOLDER = sid();

  it('the holder parks: lease = the end, owner kept, state review, the old note after the separator, one board event with the L9 detail', async () => {
    const id = await mk('pk-h', { state: 'active', owner: HOLDER });
    await setNote(id, 'WAITS ON x; NEXT y');
    const r = lane(['park', id, '--for', '5h', ...WHY], { as: HOLDER });
    assert.equal(r.code, 0, r.err);
    const after = await row(id);
    assert.equal(after.state, 'review');
    assert.equal(after.owner_session_id, HOLDER);
    near(await leaseMin(id), 300, 1, 'lease minutes');
    assert.match(after.note, /^PARKED until \w{3} \d\d-\d\d \d\d:\d\d C[SD]T -- waits on Dave \|\| WAITS ON x; NEXT y$/);
    const evs = await laneEvents(id);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].kind, 'state_changed');
    assert.equal(evs[0].to_session_id, null);
    assert.deepEqual(evs[0].detail, { state: 'review', parked: true, until: new Date(after.lease_expires_at).toISOString(), reason: 'waits on Dave', fromState: 'active' });
  });

  it('a blocked lane stays blocked; a lane with no old note gets a note with no separator', async () => {
    const id = await mk('pk-b', { state: 'blocked', owner: HOLDER });
    assert.equal(lane(['park', id, '--for', '3h', ...WHY], { as: HOLDER }).code, 0);
    const after = await row(id);
    assert.equal(after.state, 'blocked');
    assert.match(after.note, /^PARKED until [^|]+ -- waits on Dave$/);
    assert.equal((await laneEvents(id))[0].detail.state, 'blocked');
  });

  it('the default is 24h; a "||" in the reason cannot hide the old note', async () => {
    const id = await mk('pk-d', { state: 'active', owner: HOLDER });
    await setNote(id, 'old');
    assert.equal(lane(['park', id, '--reason', 'a || b'], { as: HOLDER }).code, 0);
    near(await leaseMin(id), 1440, 1, 'default lease minutes');
    assert.equal(lane(['state', id, 'active'], { as: HOLDER }).code, 0);
    assert.equal((await row(id)).note, 'old');
  });

  it('bounds: 2h to 7d pass at the edges, 119m and 10081m and a past time are usage errors (exit 1) that write nothing', async () => {
    for (const [arg, want] of [['120m', 120], ['2h', 120], ['7d', 10080]]) {
      const id = await mk('pk-ok', { state: 'active', owner: HOLDER });
      const r = lane(['park', id, '--for', arg, ...WHY], { as: HOLDER });
      assert.equal(r.code, 0, `${arg}: ${r.err}`);
      near(await leaseMin(id), want, 1, `--for ${arg}`);
    }
    const bad = [['--for', '119m'], ['--for', '1m'], ['--for', '10081m'], ['--for', '8d'], ['--for', 'soon'],
      ['--until', '2020-01-01T00:00:00Z'], ['--until', 'tomorrow'], ['--for', '3h', '--until', new Date(Date.now() + 5 * 3600_000).toISOString()]];
    for (const extra of bad) {
      const id = await mk('pk-bad', { state: 'active', owner: HOLDER });
      const before = await row(id);
      const events = await eventCount();
      const r = lane(['park', id, ...extra, ...WHY], { as: HOLDER });
      assert.equal(r.code, 1, `${extra.join(' ')}: ${r.err}`);
      assert.deepEqual(await row(id), before, `${extra.join(' ')} changed the lane`);
      assert.equal(await eventCount(), events);
    }
  });

  it('--until takes an exact end, and a missing --reason is a usage error', async () => {
    const id = await mk('pk-u', { state: 'active', owner: HOLDER });
    const end = new Date(Math.round((Date.now() + 6 * 3600_000) / 1000) * 1000);
    assert.equal(lane(['park', id, '--until', end.toISOString(), ...WHY], { as: HOLDER }).code, 0);
    near(+(await row(id)).lease_expires_at, +end, 1000, 'lease against --until');
    const other = await mk('pk-u', { state: 'active', owner: HOLDER });
    const r = lane(['park', other, '--for', '3h'], { as: HOLDER });
    assert.equal(r.code, 1);
    assert.match(r.err, /park needs --reason/);
    assert.equal((await row(other)).state, 'active');
  });

  it('F10: a stranger cannot park: a lane with a live holder, with no holder, with a quiet holder (all [not-holder], exit 4, nothing written)', async () => {
    const live = await mk('pk-s', { state: 'active', owner: HOLDER });
    const r = await refusedVerb(['park', live, '--for', '3h', ...WHY], 'park', live, 'not-holder');
    assert.match(r.line1, /-- the lane is held by .+/);
    assert.doesNotMatch(r.err, /--override/);
    const free = await mk('pk-s', { state: 'ready' });
    const r2 = await refusedVerb(['park', free, '--for', '3h', ...WHY], 'park', free, 'not-holder');
    assert.match(r2.line1, /-- the lane has no holder; claim it first$/);
    const quiet = await mk('pk-s', { state: 'active', owner: sid(), lapsed: true });
    await refusedVerb(['park', quiet, '--for', '3h', ...WHY], 'park', quiet, 'not-holder');
    for (const id of [live, free, quiet]) assert.notEqual((await row(id)).state, 'review');
  });

  it('park on a done lane: with no holder it is [not-holder], held by the caller it is [done]', async () => {
    const id = await mk('pk-x', { state: 'done' });
    await refusedVerb(['park', id, '--for', '3h', ...WHY], 'park', id, 'not-holder');
    const held = await mk('pk-x', { state: 'active', owner: HOLDER });
    await q(`UPDATE agentic_os.lane SET state='done' WHERE id=$1`, [held]);
    await refusedVerb(['park', held, '--for', '3h', ...WHY], 'park', held, 'done', { as: HOLDER });
  });

  it('under --json the refusal adds the stderr line with the holder', async () => {
    const id = await mk('pk-j', { state: 'active', owner: HOLDER });
    const r = lane(['park', id, '--for', '3h', ...WHY, '--json']);
    assert.equal(r.code, 4);
    assert.deepEqual(JSON.parse(r.err.trim().split('\n').at(-1)), { refused: true, verb: 'park', id, rule: 'not-holder', holder: HOLDER });
  });

  it('F11/H2: with a dead owner, 91 minutes later the control lane is claimable and the parked lane is not (exit 3)', async () => {
    const X = sid();
    const control = await mk('pk-c', { state: 'ready' });
    const parked = await mk('pk-p', { state: 'ready' });
    assert.equal(lane(['claim', control], { as: X }).code, 0);
    assert.equal(lane(['claim', parked], { as: X }).code, 0);
    assert.equal(lane(['park', parked, '--for', '24h', ...WHY], { as: X }).code, 0);
    near(await leaseMin(parked), 1440, 1, 'stored lease against the requested end');
    await q(`UPDATE agentic_os.lane SET lease_expires_at = lease_expires_at - interval '91 minutes' WHERE id = ANY($1)`, [[control, parked]]);
    const C = sid();
    assert.equal(lane(['claim', control], { as: C }).code, 0, 'the control lane is reclaimable');
    const d = lane(['claim', parked], { as: C });
    assert.equal(d.code, 3, d.err);
    assert.match(d.err, /DENIED .* held by/);
    assert.match(d.err, /their note: PARKED until /);
  });

  it('the board line says "parked to <time>" from the lease only, and a normal held lane does not', async () => {
    const parked = await mk('pk-l', { state: 'active', owner: HOLDER });
    const plain = await mk('pk-n', { state: 'active', owner: HOLDER });
    await setLease(plain, 90);
    assert.equal(lane(['park', parked, '--for', '4h', ...WHY], { as: HOLDER }).code, 0);
    const board = lane(['board']).out.split('\n');
    const line = (id) => board.find((l) => l.includes(` ${id} `));
    assert.match(line(parked), /parked to \w{3} \d\d-\d\d \d\d:\d\d C[SD]T/);
    assert.doesNotMatch(line(plain), /parked to/);
    assert.match(line(plain), / (90|89)m/);
  });

  it('F1: the parked tag comes from the lease only: a 2h park whose lease is 30 minutes ahead shows a plain lease, though the note still starts with "PARKED until "', async () => {
    const id = await mk('pk-t', { state: 'active', owner: HOLDER });
    assert.equal(lane(['park', id, '--for', '2h', ...WHY], { as: HOLDER }).code, 0);
    await setLease(id, 30);
    assert.match((await row(id)).note, /^PARKED until /);
    const board = lane(['board']).out.split('\n');
    const line = board.find((l) => l.includes(` ${id} `));
    assert.doesNotMatch(line, /parked to/);
    assert.match(line, / (29|30)m/);
    assert.ok(board.some((l) => l.includes('PARKED until ')), 'the note line under the lane still shows the PARKED text');
  });

  it('F1(a): after the park end the holder renews: the lease is one lease ahead, the note keeps the prefix, and the board line has no "parked to"', async () => {
    const id = await mk('pk-t', { state: 'active', owner: HOLDER });
    assert.equal(lane(['park', id, '--for', '2h', ...WHY], { as: HOLDER }).code, 0);
    await setLease(id, -5);
    assert.equal(lane(['renew'], { as: HOLDER }).code, 0);
    assert.match((await row(id)).note, /^PARKED until /);
    const line = lane(['board']).out.split('\n').find((l) => l.includes(` ${id} `));
    assert.doesNotMatch(line, /parked to/);
    assert.match(line, / (89|90)m/);
  });

  it('F1(b): a reclaim strips the PARKED prefix from the stored note (the old text stays) and the new holder\'s board line has no "parked to"', async () => {
    const id = await mk('pk-t', { state: 'active', owner: HOLDER });
    await setNote(id, 'WAITS ON x; NEXT y');
    assert.equal(lane(['park', id, '--for', '2h', ...WHY], { as: HOLDER }).code, 0);
    assert.match((await row(id)).note, /^PARKED until .* \|\| WAITS ON x; NEXT y$/);
    await setLease(id, -5);
    const C = sid();
    const r = lane(['claim', id], { as: C });
    assert.equal(r.code, 0, r.err);
    const after = await row(id);
    assert.equal(after.owner_session_id, C);
    assert.equal(after.note, 'WAITS ON x; NEXT y');
    const line = lane(['board']).out.split('\n').find((l) => l.includes(` ${id} `));
    assert.doesNotMatch(line, /parked to/);
    const bare = await mk('pk-t', { state: 'active', owner: HOLDER });
    assert.equal(lane(['park', bare, '--for', '2h', ...WHY], { as: HOLDER }).code, 0);
    await setLease(bare, -5);
    assert.equal(lane(['claim', bare], { as: C }).code, 0);
    assert.ok(!(await row(bare)).note, 'a note that was only the prefix is empty after the reclaim');
    const kept = await mk('pk-t', { state: 'active', owner: HOLDER });
    await setNote(kept, 'plain note');
    await setLease(kept, -5);
    assert.equal(lane(['claim', kept], { as: C }).code, 0);
    assert.equal((await row(kept)).note, 'plain note');
  });

  it('the parked tag does not show for a lease that ended or a normal note on a short lease; a long lease shows it with no PARKED note (the lease is the park)', async () => {
    const lapsed = await mk('pk-t', { state: 'active', owner: HOLDER });
    assert.equal(lane(['park', lapsed, '--for', '2h', ...WHY], { as: HOLDER }).code, 0);
    await setLease(lapsed, -5);
    const short = await mk('pk-t', { state: 'active', owner: HOLDER });
    await setNote(short, 'PARKED by hand');
    await setLease(short, 30);
    const long = await mk('pk-t', { state: 'active', owner: HOLDER });
    await setNote(long, 'plain note');
    await setLease(long, 600);
    const board = lane(['board']).out.split('\n');
    const line = (id) => board.find((l) => l.includes(` ${id} `));
    assert.match(line(lapsed), /LAPSED/);
    assert.doesNotMatch(line(lapsed), /parked to/);
    assert.doesNotMatch(line(short), /parked to/);
    assert.match(line(long), /parked to/);
  });

  it('L11: park warns on stderr after the commit when EITHER active hook bundle lacks GREATEST(lease_expires_at, and stays quiet when both have it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'park-home-'));
    const dist = path.join(home, '.claude', 'hooks', 'dist');
    const good = 'UPDATE agentic_os.lane SET lease_expires_at = GREATEST(lease_expires_at, now())';
    const old = 'UPDATE agentic_os.lane SET lease_expires_at = now() + interval';
    const warn = (r) => r.err.split('\n').find((l) => l.includes('warn:')) ?? '';
    const parkAs = async (env) => lane(['park', await mk('pk-w', { state: 'active', owner: HOLDER }), '--for', '3h', ...WHY], { as: HOLDER, env: { CCV3_USER_HOME: env } });
    try {
      const none = await parkAs(home);
      assert.equal(none.code, 0, none.err);
      assert.ok(warn(none).includes('lane-context.mjs') && warn(none).includes('prompt-submit.mjs'), `neither bundle: ${none.err}`);
      assert.ok(warn(none).includes('GREATEST(lease_expires_at'), none.err);
      fs.mkdirSync(dist, { recursive: true });
      fs.writeFileSync(path.join(dist, 'lane-context.mjs'), good);
      const onlyCtx = await parkAs(home);
      assert.equal(onlyCtx.code, 0, onlyCtx.err);
      assert.ok(warn(onlyCtx).includes('prompt-submit.mjs'), `lane-context.mjs alone is not enough: ${onlyCtx.err}`);
      assert.ok(!warn(onlyCtx).includes('lane-context.mjs'), 'the warning names only the bundle that lacks the fix');
      fs.rmSync(path.join(dist, 'lane-context.mjs'));
      fs.writeFileSync(path.join(dist, 'prompt-submit.mjs'), good);
      const onlyPrompt = await parkAs(home);
      assert.ok(warn(onlyPrompt).includes('lane-context.mjs'), `prompt-submit.mjs alone is not enough: ${onlyPrompt.err}`);
      fs.writeFileSync(path.join(dist, 'lane-context.mjs'), old);
      assert.ok(warn(await parkAs(home)).includes('lane-context.mjs'), 'a bundle with the old SQL warns');
      fs.writeFileSync(path.join(dist, 'lane-context.mjs'), good);
      const ok = await parkAs(home);
      assert.equal(ok.code, 0, ok.err);
      assert.equal(warn(ok), '', ok.err);
      const c = await mk('pk-w', { state: 'active', owner: HOLDER });
      const stranger = lane(['park', c, '--for', '3h', ...WHY], { env: { CCV3_USER_HOME: path.join(home, 'none') } });
      assert.equal(stranger.code, 4);
      assert.match(stranger.line1, /^REFUSED park /, 'no warning before a refusal');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe('park: the lease writers keep the later lease (F9) and what ends a park (F12)', () => {
  const HOLDER = sid();

  for (const [verb, args] of [['renew', ['renew']], ['note', ['note', '#ID', 'status']], ['compact', ['compact', '#ID', 'compacting']]]) {
    it(`F9: ${verb} by the owner keeps a lease that ends later than now+90m, and still sets now+90m on a shorter or empty one`, async () => {
      const long = await mk('lw', { state: 'review', owner: HOLDER });
      await setLease(long, 600);
      const run = (id) => lane(args.map((a) => (a === '#ID' ? id : a)), { as: HOLDER });
      assert.equal(run(long).code, 0);
      near(await leaseMin(long), 600, 1, `${verb} on a parked lane`);
      const short = await mk('lw', { state: 'active', owner: HOLDER });
      await setLease(short, 10);
      assert.equal(run(short).code, 0);
      near(await leaseMin(short), 90, 1, `${verb} on a short lease`);
      const none = await mk('lw', { state: 'active', owner: HOLDER });
      await q(`UPDATE agentic_os.lane SET lease_expires_at = NULL WHERE id=$1`, [none]);
      assert.equal(run(none).code, 0);
      near(await leaseMin(none), 90, 1, `${verb} on an empty lease`);
    });
  }

  it('F9: a stranger note on a parked lane is refused and the lease stays', async () => {
    const id = await mk('lw-s', { state: 'review', owner: HOLDER });
    await setLease(id, 600);
    await refusedVerb(['note', id, 'x'], 'note', id, 'not-holder');
    near(await leaseMin(id), 600, 1, 'lease');
  });

  it('F12: the owner state change ends the park: the lease is now+90m and the PARKED prefix is gone, the old note is back', async () => {
    const id = await mk('ep-s', { state: 'active', owner: HOLDER });
    await setNote(id, 'WAITS ON a');
    assert.equal(lane(['park', id, '--for', '5h', ...WHY], { as: HOLDER }).code, 0);
    assert.equal(lane(['state', id, 'active'], { as: HOLDER }).code, 0);
    const after = await row(id);
    assert.equal(after.state, 'active');
    assert.equal(after.owner_session_id, HOLDER);
    assert.equal(after.note, 'WAITS ON a');
    near(await leaseMin(id), 90, 1, 'lease after state active');
  });

  it('F12: a new --note on state replaces the note; park with no old note leaves the note NULL after the state change', async () => {
    const id = await mk('ep-n', { state: 'active', owner: HOLDER });
    assert.equal(lane(['park', id, '--for', '3h', ...WHY], { as: HOLDER }).code, 0);
    assert.equal(lane(['state', id, 'active'], { as: HOLDER }).code, 0);
    assert.equal((await row(id)).note, null);
    const other = await mk('ep-n', { state: 'active', owner: HOLDER });
    assert.equal(lane(['park', other, '--for', '3h', ...WHY], { as: HOLDER }).code, 0);
    assert.equal(lane(['state', other, 'active', '--note', 'back'], { as: HOLDER }).code, 0);
    assert.equal((await row(other)).note, 'back');
  });

  it('F12: release and done by the owner end the park and drop the prefix', async () => {
    for (const [verb, state] of [['release', 'ready'], ['done', 'done']]) {
      const id = await mk('ep-r', { state: 'active', owner: HOLDER });
      await setNote(id, 'keep');
      assert.equal(lane(['park', id, '--for', '3h', ...WHY], { as: HOLDER }).code, 0);
      assert.equal(lane([verb, id], { as: HOLDER }).code, 0);
      const after = await row(id);
      assert.equal(after.state, state);
      assert.equal(after.owner_session_id, null);
      assert.equal(after.lease_expires_at, null);
      assert.equal(after.note, 'keep');
    }
  });

  it('F12: a new park sets the new end exactly (it may be shorter) and the prefix does not stack', async () => {
    const id = await mk('ep-p', { state: 'active', owner: HOLDER });
    await setNote(id, 'base');
    assert.equal(lane(['park', id, '--for', '5h', '--reason', 'first'], { as: HOLDER }).code, 0);
    assert.equal(lane(['park', id, '--for', '3h', '--reason', 'second'], { as: HOLDER }).code, 0);
    near(await leaseMin(id), 180, 1, 'lease after the second park');
    const note = (await row(id)).note;
    assert.match(note, /^PARKED until [^|]+ -- second \|\| base$/);
    assert.equal(note.split('PARKED until').length, 2);
  });

  it('F12: the end time passes: the next renew by the owner gives now+90m, and a stranger can claim once the owner is dead', async () => {
    const id = await mk('ep-t', { state: 'active', owner: HOLDER });
    assert.equal(lane(['park', id, '--for', '3h', ...WHY], { as: HOLDER }).code, 0);
    await setLease(id, -5);
    assert.equal(lane(['renew'], { as: HOLDER }).code, 0);
    near(await leaseMin(id), 90, 1, 'lease after renew past the end');
    const dead = await mk('ep-t', { state: 'ready' });
    const X = sid();
    assert.equal(lane(['claim', dead], { as: X }).code, 0);
    assert.equal(lane(['park', dead, '--for', '3h', ...WHY], { as: X }).code, 0);
    await setLease(dead, -5);
    assert.equal(lane(['claim', dead]).code, 0, 'after the end a dead owner no longer holds the lane');
  });

  it('F12/H1: a stranger handover of a parked lane (release --override) frees it with the old note, and a claim then works', async () => {
    const id = await mk('ep-h', { state: 'active', owner: HOLDER });
    await setNote(id, 'WAITS ON h');
    assert.equal(lane(['park', id, '--for', '5h', ...WHY], { as: HOLDER }).code, 0);
    const r = lane(['release', id, '--override', '--reason', 'handover to the next builder']);
    assert.equal(r.code, 0, r.err);
    const after = await row(id);
    assert.equal(after.state, 'ready');
    assert.equal(after.owner_session_id, null);
    assert.equal(after.lease_expires_at, null);
    assert.equal(after.note, 'WAITS ON h');
    assert.equal(lane(['claim', id], { as: sid() }).code, 0);
  });

  it('F12: a stranger state change with --override --reason ends the park: the lease is at most 90 minutes ahead, the PARKED prefix is gone, the owner stays', async () => {
    const id = await mk('ep-o', { state: 'active', owner: HOLDER });
    await setNote(id, 'WAITS ON o');
    assert.equal(lane(['park', id, '--for', '48h', ...WHY], { as: HOLDER }).code, 0);
    near(await leaseMin(id), 2880, 1, 'lease after the park');
    const r = lane(['state', id, 'blocked', '--override', '--reason', 'the owner is gone'], { as: sid() });
    assert.equal(r.code, 0, r.err);
    const after = await row(id);
    assert.equal(after.state, 'blocked');
    assert.equal(after.owner_session_id, HOLDER, 'an override changes the state; the owner stays until the lease and quiet time end');
    assert.ok(await leaseMin(id) <= 90.5, 'the park lease is capped at one lease');
    near(await leaseMin(id), 90, 1, 'lease after the override');
    assert.equal(after.note, 'WAITS ON o', 'the PARKED prefix is gone and the old note is back');
  });

  it('F12: a stranger override on a lane that is not parked keeps a shorter lease and an empty lease as they are', async () => {
    const short = await mk('ep-q', { state: 'active', owner: HOLDER });
    await setLease(short, 60);
    assert.equal(lane(['state', short, 'review', '--override', '--reason', 'x'], { as: sid() }).code, 0);
    near(await leaseMin(short), 60, 1, 'a 60 minute lease is not lengthened');
    const none = await mk('ep-q', { state: 'active', owner: HOLDER });
    await q(`UPDATE agentic_os.lane SET lease_expires_at = NULL WHERE id=$1`, [none]);
    assert.equal(lane(['state', none, 'review', '--override', '--reason', 'x'], { as: sid() }).code, 0);
    assert.equal((await row(none)).lease_expires_at, null, 'an empty lease stays empty');
    const strange = await mk('ep-q', { state: 'active', owner: HOLDER });
    await setNote(strange, 'plain || note');
    assert.equal(lane(['state', strange, 'review', '--override', '--reason', 'x'], { as: sid() }).code, 0);
    assert.equal((await row(strange)).note, 'plain || note', 'a note with no PARKED prefix is not cut');
  });

  it('F12: a stranger override to ready frees the lane and drops the prefix too (the old path stays)', async () => {
    const id = await mk('ep-f', { state: 'active', owner: HOLDER });
    await setNote(id, 'keep f');
    assert.equal(lane(['park', id, '--for', '48h', ...WHY], { as: HOLDER }).code, 0);
    assert.equal(lane(['state', id, 'ready', '--override', '--reason', 'x'], { as: sid() }).code, 0);
    const after = await row(id);
    assert.equal(after.owner_session_id, null);
    assert.equal(after.lease_expires_at, null);
    assert.equal(after.note, 'keep f');
  });

  it('F12: done --merged by the owner drops the PARKED prefix too (the writeDone path)', async () => {
    const id = await mk('ep-m', { state: 'active', owner: HOLDER });
    await setNote(id, 'MS: m');
    assert.equal(lane(['park', id, '--for', '3h', ...WHY], { as: HOLDER }).code, 0);
    const r = lane(['done', id, '--merged', s.sha], { as: HOLDER });
    assert.equal(r.code, 0, r.err);
    const after = await row(id);
    assert.equal(after.state, 'done');
    assert.equal(after.note, 'MS: m');
  });

  it('F12: an owner state change with a note that has no PARKED prefix keeps its note (the strip needs the prefix)', async () => {
    const id = await mk('ep-k', { state: 'active', owner: HOLDER });
    await setNote(id, 'MS: a || b');
    assert.equal(lane(['state', id, 'review'], { as: HOLDER }).code, 0);
    assert.equal((await row(id)).note, 'MS: a || b');
  });
});

describe('a database without table lane_dep (migration 5)', () => {
  it('the claim works with one warning, and the done and blocked refusals still apply', async () => {
    const a = await mk('gc-n', { url: s.url5 });
    const ok = lane(['claim', a], { url: s.url5 });
    assert.equal(ok.code, 0, ok.err);
    assert.equal(ok.err.split('\n').filter((l) => l.includes('migration 0006 (lane_dep) is not applied')).length, 1);
    const b = await mk('gc-n', { state: 'blocked', url: s.url5 });
    const r = lane(['claim', b], { url: s.url5 });
    assert.equal(r.code, 4);
    // B7: line 1 of a refusal is always the REFUSED line; the floor warning comes after it.
    assert.match(r.line1, new RegExp(`^REFUSED claim ${b} \\[blocked\\] -- `));
    assert.equal(r.err.split('\n').filter((l) => l.includes('migration 0006 (lane_dep) is not applied')).length, 1, 'the one warning is still printed');
  });
});

describe('B8: lane-race-probe refuses a database that is not a scratch database', () => {
  it('exits non-zero before it connects, names the problem and never prints the password', () => {
    const secret = 'hunter2-not-a-real-secret';
    const url = `postgresql://x:${secret}@localhost:5432/not_scratch`;
    const env = { ...process.env, CONTINUOUS_CLAUDE_DB_URL: url, DATABASE_URL: url, OPC_POSTGRES_URL: url };
    const r = spawnSync(process.execPath, [path.join(HERE, 'lane-race-probe.mjs')], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const all = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, all);
    assert.notEqual(r.status, null, 'the probe must exit by itself');
    assert.match(all, /lanes_pr1_/);
    assert.ok(!all.includes(secret), 'the password must not be printed');
    assert.doesNotMatch(all, /PASS|ECONNREFUSED|password authentication/i, 'it refuses before it connects');
  });
});
