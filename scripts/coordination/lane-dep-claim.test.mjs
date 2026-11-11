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
function lane(args, { url = s.url6, as = ME } = {}) {
  const r = spawnSync(process.execPath, [LANE, ...args, '--as', as], { cwd: s.repo, env: laneEnv(url), encoding: 'utf8', windowsHide: true });
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
