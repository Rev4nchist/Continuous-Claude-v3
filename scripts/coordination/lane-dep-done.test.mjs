/**
 * lane-dep-done.test -- end to end tests for `lane.mjs done --merged`, `done --no-pr --evidence`, the plain done
 * guard and the met test (contract t2.1, points 3 and 4, "Database floor").
 *
 * Every test spawns the real `lane.mjs` as a child process against SCRATCH databases that this file creates and drops
 * itself (one through migration 6, one through migration 5 for the "no lane_dep table" floor). The cwd of each run is a
 * temp git repo with a `main` branch and a `side` branch, so the 4 git steps of `done --merged` run for real.
 * The met test is read through the real `laneMetSql` from lane-dep.mjs.
 *
 *   node --test scripts/coordination/lane-dep-done.test.mjs
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
import { laneMetSql } from './lane-dep.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const LANE = path.join(HERE, 'lane.mjs');
const SCRATCH = path.join(HERE, 'scratch-db.mjs');
const { Client } = requireDep('pg', { repoRoot: REPO });

const fwd = (p) => String(p).replace(/\\/g, '/');
const BOARD = 'gd-a';
const ME = randomUUID();
const HINT = '[lane] note: a done without --merged meets no dependency';
const s = { url6: '', url5: '', db6: null, db5: null, tmp: '', repo: '', repo2: '', nogit: '', X: '', registry: '', idDir: '', A: '', B: '', C: '', dropped: [] };

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
const gitIn = (cwd, ...args) => execFileSync('git',
  ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
  { cwd, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true }).trim();
const git = (...args) => gitIn(s.repo, ...args);

/** Run the worktree lane.mjs in the temp repo against one scratch database. */
function lane(args, { url = s.url6, cwd = s.repo, as = ME } = {}) {
  assertScratchUrl(url);
  const env = cleanGitEnv();
  delete env.LANE_PROJECT; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.LANE_SKIP_HOOK_PRECHECK;
  Object.assign(env, {
    CONTINUOUS_CLAUDE_DB_URL: url, DATABASE_URL: url, OPC_POSTGRES_URL: url,
    LANE_REGISTRY_PATH: s.registry, CCV3_IDENTITY_DIR: s.idDir, CLAUDE_CODE_SESSION_ID: as,
  });
  const r = spawnSync(process.execPath, [LANE, ...args], { cwd, env, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}`, line1: r.stderr.split('\n')[0] };
}
const dbOf = (url) => (url === s.url5 ? s.db5 : s.db6);
const q = (url, sql, params) => dbOf(url).query(sql, params);
const one = async (url, sql, params) => (await q(url, sql, params)).rows[0];

let seq = 0;
/** A lane on the test board. Returns its id. */
async function mk(name, state = 'active', url = s.url6, board = BOARD) {
  const id = `gd-${name}-${++seq}`;
  await q(url, `INSERT INTO agentic_os.lane (id,title,track,state,project_key) VALUES ($1,$2,'zz',$3,$4)`, [id, `title of ${id}`, state, board]);
  return id;
}
const met = async (id, url = s.url6) => (await one(url, `SELECT ${laneMetSql('l')} AS met FROM agentic_os.lane l WHERE l.id=$1`, [id])).met;
const events = async (id, url = s.url6) => (await q(url, `SELECT * FROM agentic_os.lane_event WHERE lane_id=$1 ORDER BY id`, [id])).rows;
const stateOf = async (id, url = s.url6) => (await one(url, `SELECT state FROM agentic_os.lane WHERE id=$1`, [id])).state;
const lastLine = (text) => text.trim().split('\n').at(-1);

/** A file under .claudedocs/e2e-<id>/ in the temp repo. Returns the repo-relative path. */
function evidenceFile(id, name = 'out.txt') {
  const dir = path.join(s.repo, '.claudedocs', `e2e-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), 'evidence\n');
  return `.claudedocs/e2e-${id}/${name}`;
}

before(async () => {
  s.url6 = createScratch(6);
  s.url5 = createScratch(5);
  s.tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dep-done-')));
  s.repo = path.join(s.tmp, 'repo');
  s.idDir = path.join(s.tmp, 'ids');
  fs.mkdirSync(s.repo); fs.mkdirSync(s.idDir);
  s.registry = path.join(s.tmp, 'registry.json');
  // gd-ng: a board whose root is a folder that is not a git repo. repo2: an unrelated repo that no board names.
  s.nogit = path.join(s.tmp, 'nogit');
  s.repo2 = path.join(s.tmp, 'repo2');
  fs.mkdirSync(s.nogit); fs.mkdirSync(s.repo2);
  fs.writeFileSync(s.registry, JSON.stringify({
    version: '1.0',
    projects: [{ name: 'gd', key: BOARD, path: fwd(s.repo), status: 'active' }, { name: 'ng', key: 'gd-ng', path: fwd(s.nogit), status: 'active' }],
  }));
  gitIn(s.repo2, 'init', '-b', 'main');
  fs.writeFileSync(path.join(s.repo2, 'x.txt'), 'only in repo2');
  gitIn(s.repo2, 'add', 'x.txt'); gitIn(s.repo2, 'commit', '-m', 'x');
  s.X = gitIn(s.repo2, 'rev-parse', 'HEAD');
  git('init', '-b', 'main');
  const commit = (file, msg) => { fs.writeFileSync(path.join(s.repo, file), msg); git('add', file); git('commit', '-m', msg); return git('rev-parse', 'HEAD'); };
  s.A = commit('a.txt', 'a');
  s.B = commit('b.txt', 'b');
  git('switch', '-c', 'side');
  s.C = commit('c.txt', 'c');
  git('switch', 'main');
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

describe('the Met table of contract point 3, read through laneMetSql', () => {
  it('row 1: done --merged is met', async () => {
    const id = await mk('r1');
    const r = lane(['done', id, '--merged', s.A]);
    assert.equal(r.code, 0, r.all);
    assert.equal(r.out.trim(), `${id} -> done (merged ${s.A.slice(0, 12)} on main; released)`);
    assert.equal(await met(id), true);
  });

  it('row 2: plain done is not met', async () => {
    const id = await mk('r2');
    assert.equal(lane(['done', id]).code, 0);
    assert.equal(await stateOf(id), 'done');
    assert.equal(await met(id), false);
  });

  it('row 3: done --merged, then plain done: still met, plain done writes nothing and says already met', async () => {
    const id = await mk('r3');
    assert.equal(lane(['done', id, '--merged', s.A]).code, 0);
    const before = (await events(id)).length;
    const r = lane(['done', id]);
    assert.equal(r.code, 0, r.all);
    assert.equal(r.out.trim(), `${id} already met (merged ${s.A.slice(0, 12)}); nothing written`);
    assert.equal((await events(id)).length, before, 'plain done on a met lane must write no event');
    assert.equal(await met(id), true);
    const viaState = lane(['state', id, 'done']);
    assert.equal(viaState.out.trim(), `${id} already met (merged ${s.A.slice(0, 12)}); nothing written`);
    assert.equal((await events(id)).length, before);
  });

  it('row 3b: state done --if-state review on a met lane is refused [if-state], exit 4, writes nothing, and the lane stays met', async () => {
    const id = await mk('r3b');
    assert.equal(lane(['done', id, '--merged', s.A]).code, 0);
    const before = (await events(id)).length;
    const r = lane(['state', id, 'done', '--if-state', 'review']);
    assert.equal(r.code, 4, r.all);
    assert.match(r.line1, new RegExp(`^REFUSED state ${id} \\[if-state\\] -- the lane is done, not review`));
    assert.doesNotMatch(r.out, /already met/);
    assert.equal((await events(id)).length, before, 'a refusal writes no event');
    assert.equal(await met(id), true);
    const j = lane(['state', id, 'done', '--if-state', 'review', '--json']);
    assert.equal(j.code, 4, j.all);
    assert.deepEqual(JSON.parse(lastLine(j.err)), { refused: true, verb: 'state', id, rule: 'if-state', state: 'done' });
  });

  it('row 3b guard: state done --if-state done on a met lane is still already met, exit 0 (passes before and after)', async () => {
    const id = await mk('r3g');
    assert.equal(lane(['done', id, '--merged', s.A]).code, 0);
    const before = (await events(id)).length;
    const r = lane(['state', id, 'done', '--if-state', 'done']);
    assert.equal(r.code, 0, r.all);
    assert.equal(r.out.trim(), `${id} already met (merged ${s.A.slice(0, 12)}); nothing written`);
    assert.equal((await events(id)).length, before);
  });

  it('row 4: done --merged, state ready, done --merged is met', async () => {
    const id = await mk('r4');
    assert.equal(lane(['done', id, '--merged', s.A]).code, 0);
    assert.equal(lane(['state', id, 'ready']).code, 0);
    assert.equal(await met(id), false, 'a lane that left done is not met');
    assert.equal(lane(['done', id, '--merged', s.B]).code, 0);
    assert.equal(await met(id), true);
  });

  it('row 5: done --merged, state ready, plain done is not met', async () => {
    const id = await mk('r5');
    assert.equal(lane(['done', id, '--merged', s.A]).code, 0);
    assert.equal(lane(['state', id, 'ready']).code, 0);
    const r = lane(['done', id]);
    assert.equal(r.code, 0, r.all);
    assert.doesNotMatch(r.out, /already met/);
    assert.equal(await stateOf(id), 'done');
    assert.equal(await met(id), false);
  });

  it('row 6: done --merged, reopen, then a kanban Done tap is not met (the latest event is a kanban state event)', async () => {
    const id = await mk('r6');
    assert.equal(lane(['done', id, '--merged', s.A]).code, 0);
    assert.equal(lane(['state', id, 'ready']).code, 0);
    const file = path.join(s.tmp, `kanban-${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ project: BOARD, cards: [{ id, status: 'done', updatedAt: new Date().toISOString() }] }));
    const r = lane(['apply-kanban', file]);
    assert.equal(r.code, 0, r.all);
    assert.equal(await stateOf(id), 'done');
    const last = (await events(id)).at(-1);
    assert.equal(last.kind, 'kanban');
    assert.equal(last.detail.kind, 'state');
    assert.equal(await met(id), false);
  });

  it('row 7: a lane seeded with state done and no event is not met', async () => {
    const id = await mk('r7', 'done');
    assert.equal(await met(id), false);
  });

  it('row 8: a lane closed by reminder-sync (kind done, via notion, no merged) is not met', async () => {
    const id = await mk('r8', 'done');
    await q(s.url6,
      `INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, body, detail, project_key) VALUES ($1,'done',$2,$3,$4,$5)`,
      [id, ME, `${id} -> done (Done in Notion)`, JSON.stringify({ state: 'done', via: 'notion' }), BOARD]);
    assert.equal(await met(id), false);
  });
});

describe('k36: a kanban move on a lane whose park ended drops the PARKED prefix', () => {
  const PARKED = 'PARKED until 2026-11-01 10:00 -- waiting on x || old';
  const OLD_OWNER = randomUUID();
  /** A lane in review with the PARKED note. Reclaimable: a dead owner (no session row) and a lapsed lease. `held`: the lease is live. */
  async function parkedLane(name, held = false, note = PARKED) {
    const id = await mk(name, 'review');
    await q(s.url6, `UPDATE agentic_os.lane SET owner_session_id=$2, lease_expires_at=now() + ($3 || ' minutes')::interval, note=$4 WHERE id=$1`,
      [id, OLD_OWNER, held ? '180' : '-1', note]);
    return id;
  }
  const laneRow = (id) => one(s.url6, `SELECT state, note, owner_session_id AS owner, lease_expires_at AS lease FROM agentic_os.lane WHERE id=$1`, [id]);
  function kanban(id, input) {
    const file = path.join(s.tmp, `k36-${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ project: BOARD, ...input }));
    const r = lane(['apply-kanban', file, '--json']);
    assert.equal(r.code, 0, r.all);
    return JSON.parse(r.out);
  }
  const card = (id, f) => ({ id, updatedAt: new Date().toISOString(), ...f });
  const action = (out, kind) => out.actions.find((a) => a.kind === kind);

  it('k36: a status card ready writes the note without the prefix, and frees the owner and the lease', async () => {
    const id = await parkedLane('k36r');
    const out = kanban(id, { cards: [card(id, { status: 'ready' })] });
    assert.equal(action(out, 'state').to, 'ready');
    assert.deepEqual({ ...(await laneRow(id)) }, { state: 'ready', note: 'old', owner: null, lease: null });
  });

  it('k36: a status card backlog writes the note without the prefix and keeps the owner', async () => {
    const id = await parkedLane('k36b');
    kanban(id, { cards: [card(id, { status: 'backlog' })] });
    const row = await laneRow(id);
    assert.equal(row.state, 'backlog');
    assert.equal(row.note, 'old');
    assert.equal(row.owner, OLD_OWNER);
  });

  it('k36: a note-only card on a reclaimable lane strips the prefix, and the action shows the stripped note as its from value', async () => {
    const id = await parkedLane('k36n');
    const out = kanban(id, { cards: [card(id, { note: 'hi' })] });
    assert.equal(action(out, 'note').from, 'old');
    assert.equal(action(out, 'note').to, 'Dave (kanban): hi || before: old');
    const row = await laneRow(id);
    assert.equal(row.note, 'Dave (kanban): hi || before: old');
    assert.equal(row.state, 'review');
  });

  it('k36: a note-only card on a PARKED note with no tail strips it to nothing, and the action has no from value', async () => {
    const id = await parkedLane('k36t', false, 'PARKED until 2026-11-01 10:00 -- waiting on x');
    const out = kanban(id, { cards: [card(id, { note: 'hi' })] });
    assert.equal(action(out, 'note').from, null);
    assert.equal(action(out, 'note').to, 'Dave (kanban): hi');
    assert.equal((await laneRow(id)).note, 'Dave (kanban): hi');
  });

  it('k36: a move into the waiting column keeps the stripped note behind the waiting marker', async () => {
    const id = await parkedLane('k36w');
    kanban(id, { board: { columns: { next: [], later: [], waiting: [id] }, updatedAt: new Date().toISOString() } });
    const row = await laneRow(id);
    assert.equal(row.state, 'blocked');
    assert.equal(row.note, 'Waiting on Dave (kanban) || before: old');
  });

  it('k36 guard: a status card on a held lane (live lease) is skipped held, and the whole row, note included, is unchanged', async () => {
    const id = await parkedLane('k36g', true);
    const before = await laneRow(id);
    const out = kanban(id, { cards: [card(id, { status: 'ready' })] });
    assert.deepEqual(out.skipped, [{ laneId: id, reason: 'held' }]);
    assert.equal(action(out, 'state'), undefined);
    assert.deepEqual({ ...(await laneRow(id)) }, { ...before });
    assert.equal(before.note, PARKED);
  });

  it('k36 guard: a card note on a held lane still sits behind the unstripped note (the ELSE branch of the read)', async () => {
    const id = await parkedLane('k36h', true);
    const before = await laneRow(id);
    const out = kanban(id, { cards: [card(id, { status: 'ready', note: 'hi' })] });
    assert.deepEqual(out.skipped, [{ laneId: id, reason: 'held' }]);
    assert.equal(action(out, 'state'), undefined);
    assert.equal(action(out, 'note').from, PARKED, 'a held lane keeps its note as it is');
    const after = await laneRow(id);
    assert.deepEqual({ ...after, note: null }, { ...before, note: null }, 'state, owner and lease are unchanged');
    assert.equal(after.note, `Dave (kanban): hi || before: ${PARKED}`);
  });
});

describe('done --merged: the event row and the SHA that is stored', () => {
  it('writes the exact event row, releases the lane and keeps the note', async () => {
    const id = await mk('ev');
    await q(s.url6, `UPDATE agentic_os.lane SET owner_session_id=$2, lease_expires_at=now() + interval '10 minutes' WHERE id=$1`, [id, ME]);
    const r = lane(['done', id, '--merged', s.A, '--note', 'shipped it']);
    assert.equal(r.code, 0, r.all);
    const evs = await events(id);
    assert.equal(evs.length, 1);
    const e = evs[0];
    assert.equal(e.kind, 'done');
    assert.equal(e.lane_id, id);
    assert.equal(e.session_id, ME);
    assert.equal(e.to_session_id, null);
    assert.equal(e.body, `${id} -> done (merged ${s.A.slice(0, 12)}) (shipped it)`);
    assert.deepEqual(e.detail, { state: 'done', merged: s.A, main: s.B });
    assert.equal(e.project_key, BOARD);
    const row = await one(s.url6, `SELECT state, note, owner_session_id, lease_expires_at FROM agentic_os.lane WHERE id=$1`, [id]);
    assert.deepEqual({ ...row }, { state: 'done', note: 'shipped it', owner_session_id: null, lease_expires_at: null });
  });

  it('stores the full lower case SHA that git resolved, for a short and for an upper case argument', async () => {
    const short = await mk('short');
    assert.equal(lane(['done', short, '--merged', s.A.slice(0, 7)]).code, 0);
    assert.equal((await events(short))[0].detail.merged, s.A);
    assert.equal(await met(short), true);
    const upper = await mk('upper');
    assert.equal(lane(['done', upper, '--merged', s.A.toUpperCase()]).code, 0);
    assert.equal((await events(upper))[0].detail.merged, s.A);
    assert.equal(await met(upper), true);
  });

  it('is allowed on a lane that is already done', async () => {
    const id = await mk('again');
    assert.equal(lane(['done', id]).code, 0);
    assert.equal(await met(id), false);
    const r = lane(['done', id, '--merged', s.B]);
    assert.equal(r.code, 0, r.all);
    assert.equal(await met(id), true);
  });

  it('an unknown lane exits 1 with the noLane text and writes nothing', async () => {
    const r = lane(['done', 'gd-no-such-lane', '--merged', s.A]);
    assert.equal(r.code, 1);
    assert.match(r.err, /no lane gd-no-such-lane on board gd-a/);
    assert.equal((await events('gd-no-such-lane')).length, 0);
  });

  it('a value that is not 7 to 40 hex characters is a usage error (exit 1), not a refusal', async () => {
    const id = await mk('badsha');
    for (const bad of ['abc', 'zzzzzzz', 'main', `${s.A}0`]) {
      const r = lane(['done', id, '--merged', bad]);
      assert.equal(r.code, 1, `${bad}: ${r.all}`);
      assert.doesNotMatch(r.all, /REFUSED/);
    }
    assert.equal((await events(id)).length, 0);
    assert.equal(await stateOf(id), 'active');
  });
});

describe('done --merged refusals: token, exit 4, nothing written', () => {
  const refused = async (id, args, token, textRe) => {
    const before = { n: (await events(id)).length, st: await stateOf(id) };
    const r = lane(args);
    assert.equal(r.code, 4, r.all);
    assert.match(r.line1, new RegExp(`^REFUSED done ${id} \\[${token}\\] -- `));
    assert.match(r.line1, textRe);
    assert.doesNotMatch(r.all, /land-pr/);
    assert.equal((await events(id)).length, before.n, 'a refusal writes no event');
    assert.equal(await stateOf(id), before.st, 'a refusal leaves the lane as it was');
    return r;
  };

  it('[not-a-commit]: a hex value that names no commit', async () => {
    const id = await mk('nac');
    const r = await refused(id, ['done', id, '--merged', 'deadbeef'], 'not-a-commit', /deadbeef is not a commit in .+/);
    assert.ok(r.line1.includes(fwd(s.repo)), 'the text names the directory');
    assert.match(r.err, /Run done from the repo of the lane, with the merge commit on main\./);
    assert.match(r.err, /Fetch and update local main first\./, 'B6: the hint tells the caller to update local main');
  });

  it('[not-on-main]: a commit on the side branch only, with the main tip in the text', async () => {
    const id = await mk('nom');
    const r = await refused(id, ['done', id, '--merged', s.C], 'not-on-main',
      new RegExp(`${s.C.slice(0, 12)} is not on main \\(main is ${s.B.slice(0, 12)}\\)`));
    assert.match(r.err, /Land the PR, update local main, then run done again\./);
  });

  it('a refused done on a met lane does not unmeet it', async () => {
    const id = await mk('keep');
    assert.equal(lane(['done', id, '--merged', s.A]).code, 0);
    await refused(id, ['done', id, '--merged', s.C], 'not-on-main', /is not on main/);
    assert.equal(await met(id), true);
  });

  it('--json adds one stderr JSON line with the verb, id and rule', async () => {
    const id = await mk('json');
    const r = lane(['done', id, '--merged', s.C, '--json']);
    assert.equal(r.code, 4, r.all);
    assert.match(r.line1, /^REFUSED done .* \[not-on-main\] -- /);
    assert.deepEqual(JSON.parse(lastLine(r.err)), { refused: true, verb: 'done', id, rule: 'not-on-main' });
    const nac = lane(['done', id, '--merged', 'deadbeef', '--json']);
    assert.deepEqual(JSON.parse(lastLine(nac.err)), { refused: true, verb: 'done', id, rule: 'not-a-commit' });
  });
});

describe('owner rule on done: F3 and S3', () => {
  const HOLDER = randomUUID();
  /** Give a lane an owner. A live holder has a future lease; a quiet one has a lapsed lease and no sessions row. */
  const hold = (id, owner, lapsed = false) => q(s.url6,
    `UPDATE agentic_os.lane SET owner_session_id=$2, lease_expires_at=now() + ($3 || ' minutes')::interval WHERE id=$1`, [id, owner, lapsed ? '-60' : '60']);
  const refusedDone = async (id, args, token, opts) => {
    const before = (await events(id)).length;
    const r = lane(args, opts);
    assert.equal(r.code, 4, r.all);
    assert.match(r.line1, new RegExp(`^REFUSED done ${id} \\[${token}\\] -- `));
    assert.equal((await events(id)).length, before, 'a refusal writes no event');
    return r;
  };

  it('F3: done --merged and done --no-pr by a stranger on a lane that a live session holds give [not-holder] and write nothing', async () => {
    const a = await mk('f3a'); await hold(a, HOLDER);
    await refusedDone(a, ['done', a, '--merged', s.A], 'not-holder');
    const b = await mk('f3b'); await hold(b, HOLDER);
    await refusedDone(b, ['done', b, '--no-pr', '--evidence', evidenceFile(b)], 'not-holder');
    for (const id of [a, b]) {
      assert.equal(await stateOf(id), 'active');
      assert.equal((await one(s.url6, `SELECT owner_session_id AS o FROM agentic_os.lane WHERE id=$1`, [id])).o, HOLDER);
      assert.equal(await met(id), false);
    }
  });

  it('F3: the holder may run done --merged', async () => {
    const id = await mk('f3h'); await hold(id, HOLDER);
    const r = lane(['done', id, '--merged', s.A], { as: HOLDER });
    assert.equal(r.code, 0, r.all);
    assert.equal(await met(id), true);
  });

  it('F3b: a stranger with a SHA that is no commit, or with evidence that does not exist, gets [not-holder] before any git or evidence step', async () => {
    const a = await mk('f3ba'); await hold(a, HOLDER);
    await refusedDone(a, ['done', a, '--merged', 'deadbeef'], 'not-holder');
    await refusedDone(a, ['done', a, '--no-pr', '--evidence', 'nope.md'], 'not-holder');
    assert.equal(await stateOf(a), 'active');
  });

  it('F3b: a quiet holder with no --reason gets [needs-reason] before the git step', async () => {
    const b = await mk('f3bb'); await hold(b, HOLDER, true);
    await refusedDone(b, ['done', b, '--merged', 'deadbeef'], 'needs-reason');
  });

  it('F3b guard: the holder with a SHA that is no commit still gets [not-a-commit] (passes before and after)', async () => {
    const a = await mk('f3bg'); await hold(a, HOLDER);
    await refusedDone(a, ['done', a, '--merged', 'deadbeef'], 'not-a-commit', { as: HOLDER });
  });

  it('R3: a stranger with a malformed SHA gets the usage error (exit 1), not [not-holder], and nothing is written', async () => {
    const a = await mk('r3m'); await hold(a, HOLDER);
    const r = lane(['done', a, '--merged', 'abc']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /--merged needs a commit SHA of 7 to 40 hex characters; got 'abc'/);
    assert.doesNotMatch(r.err, /REFUSED/);
    assert.equal((await events(a)).length, 0);
  });

  it('F3b: an unknown lane with a SHA that is no commit gets the no-lane error (exit 1) before git', async () => {
    const r = lane(['done', 'gd-no-such-lane', '--merged', 'deadbeef']);
    assert.equal(r.code, 1, r.all);
    assert.doesNotMatch(r.err, /REFUSED/);
    assert.match(r.err, /^no lane gd-no-such-lane on board /);
  });

  it('S3: plain done on an unowned blocked lane needs --reason; with it the lane is done', async () => {
    const id = await mk('s3p', 'blocked');
    const r = await refusedDone(id, ['done', id], 'needs-reason');
    assert.match(r.line1, /-- the lane is blocked$/);
    assert.equal(await stateOf(id), 'blocked');
    const ok = lane(['done', id, '--reason', 'closed by hand']);
    assert.equal(ok.code, 0, ok.all);
    assert.equal(await stateOf(id), 'done');
  });

  it('S3: done --merged and done --no-pr --evidence on an unowned blocked lane need no --reason', async () => {
    const a = await mk('s3m', 'blocked');
    assert.equal(lane(['done', a, '--merged', s.A]).code, 0);
    assert.equal(await met(a), true);
    const b = await mk('s3n', 'blocked');
    assert.equal(lane(['done', b, '--no-pr', '--evidence', evidenceFile(b)]).code, 0);
    assert.equal(await met(b), true);
  });

  it('a quiet holder (lease ended, no live session): done --merged needs --reason, with it the lane is met', async () => {
    const id = await mk('s3q'); await hold(id, HOLDER, true);
    const r = await refusedDone(id, ['done', id, '--merged', s.A], 'needs-reason');
    assert.match(r.line1, /-- its holder .+ is quiet and the lease ended$/);
    const ok = lane(['done', id, '--merged', s.A, '--reason', 'builder is gone']);
    assert.equal(ok.code, 0, ok.all);
    assert.equal(await met(id), true);
    assert.equal((await events(id)).at(-1).detail.prevOwner, HOLDER);
  });

  it('F6 and met: done --merged --override on a lane held by a QUIET holder (no sessions row; a plain board) writes the DM first and the done event last, and the lane is met', async () => {
    const id = await mk('ovm'); await hold(id, HOLDER);
    const r = lane(['done', id, '--merged', s.A, '--override', '--reason', 'builder idle']);
    assert.equal(r.code, 0, r.all);
    const evs = await events(id);
    assert.equal(evs.length, 2);
    assert.deepEqual(evs.map((e) => [e.kind, e.to_session_id]), [['note', HOLDER], ['done', null]]);
    assert.equal(await met(id), true, 'the DM must not be a lifecycle event after the merged done');
  });

  it('--override on done without --reason is a usage error (exit 1) before any git step', async () => {
    const id = await mk('ovu'); await hold(id, HOLDER);
    for (const args of [['done', id, '--merged', s.A, '--override'], ['done', id, '--override']]) {
      const r = lane(args);
      assert.equal(r.code, 1, r.all);
      assert.match(r.err, /--override needs --reason/);
    }
    assert.equal((await events(id)).length, 0);
  });
});

describe('B6: only "git says it is not a commit" is a refusal; a git failure is an error (exit 1)', () => {
  it('a board root that is not a git repo gives exit 1 and no REFUSED line, and writes nothing', async () => {
    const id = await mk('ngit', 'active', s.url6, 'gd-ng');
    for (const args of [['done', id, '--merged', s.A], ['done', id, '--merged', 'deadbeef']]) {
      const r = lane([...args, '--project', 'gd-ng']);
      assert.equal(r.code, 1, r.all);
      assert.doesNotMatch(r.all, /REFUSED/);
      assert.match(r.err, /not a git repository|failed/i);
    }
    assert.equal((await events(id)).length, 0);
    assert.equal(await stateOf(id), 'active');
  });
});

describe('B2: done --merged and --no-pr run git in the board root, not in the cwd', () => {
  it('a SHA that only an unrelated cwd repo holds is refused for a board whose root does not hold it', async () => {
    const id = await mk('b2ref');
    const r = lane(['done', id, '--merged', s.X, '--project', BOARD], { cwd: s.repo2 });
    assert.equal(r.code, 4, r.all);
    assert.match(r.line1, new RegExp(`^REFUSED done ${id} \\[not-a-commit\\] -- ${s.X} is not a commit in `));
    assert.ok(r.line1.includes(fwd(s.repo)), 'the text names the board root, not the cwd');
    assert.equal(await met(id), false);
    assert.equal((await events(id)).length, 0);
    assert.equal(await stateOf(id), 'active');
  });

  it('a SHA that the board root holds is accepted from an unrelated cwd', async () => {
    const id = await mk('b2ok');
    const r = lane(['done', id, '--merged', s.A, '--project', BOARD], { cwd: s.repo2 });
    assert.equal(r.code, 0, r.all);
    assert.equal((await events(id))[0].detail.main, s.B, 'main is the main of the board root');
    assert.equal(await met(id), true);
  });

  it('--no-pr records the main of the board root, not of the cwd repo', async () => {
    const id = await mk('b2nopr');
    const rel = evidenceFile(id);
    const r = lane(['done', id, '--no-pr', '--evidence', path.join(s.repo, rel), '--project', BOARD], { cwd: s.repo2 });
    assert.equal(r.code, 0, r.all);
    const d = (await events(id))[0].detail;
    assert.equal(d.merged, s.B);
    assert.notEqual(d.merged, s.X);
  });

  it('a board with no root (the caller owns the lane, the cwd has no board) falls back to the cwd', async () => {
    const id = await mk('b2cwd');
    await q(s.url6, `UPDATE agentic_os.lane SET owner_session_id=$2, lease_expires_at=now() + interval '10 minutes' WHERE id=$1`, [id, ME]);
    const r = lane(['done', id, '--merged', s.X], { cwd: s.repo2 });
    assert.equal(r.code, 0, r.all);
    assert.equal((await events(id))[0].detail.merged, s.X);
  });
});

describe('done --no-pr --evidence', () => {
  it('records the main SHA, noPr and the absolute evidence path; the lane is met', async () => {
    const id = await mk('nopr');
    const rel = evidenceFile(id);
    const r = lane(['done', id, '--no-pr', '--evidence', rel]);
    assert.equal(r.code, 0, r.all);
    const e = (await events(id))[0];
    assert.equal(e.kind, 'done');
    assert.equal(e.body, `${id} -> done (no PR, evidence ${rel})`);
    assert.deepEqual(e.detail, { state: 'done', merged: s.B, main: s.B, noPr: true, evidence: fwd(path.join(s.repo, rel)) });
    assert.equal(await met(id), true);
  });

  it('the boolean flag does not swallow the lane id: "done --no-pr <id> --evidence <path>"', async () => {
    const id = await mk('noprorder');
    const rel = evidenceFile(id);
    const r = lane(['done', '--no-pr', id, '--evidence', rel]);
    assert.equal(r.code, 0, r.all);
    assert.equal(await met(id), true);
  });

  it('[no-evidence]: a path outside the lane folder, a missing file, a folder, another lane, a .. escape', async () => {
    const id = await mk('noev');
    const other = evidenceFile(`${id}-other`);
    fs.writeFileSync(path.join(s.repo, 'plain.txt'), 'x');
    fs.mkdirSync(path.join(s.repo, '.claudedocs', `e2e-${id}`, 'sub'), { recursive: true });
    const escape = `.claudedocs/e2e-${id}/../e2e-${id}-other/out.txt`;
    for (const p of ['plain.txt', `.claudedocs/e2e-${id}/missing.txt`, `.claudedocs/e2e-${id}/sub`, other, escape]) {
      const r = lane(['done', id, '--no-pr', '--evidence', p]);
      assert.equal(r.code, 4, `${p}: ${r.all}`);
      assert.match(r.line1, new RegExp(`^REFUSED done ${id} \\[no-evidence\\] -- .+ is not a file under \\.claudedocs/e2e-${id}/$`), p);
      assert.match(r.err, /Save the evidence there first, then run done again\./);
    }
    assert.equal((await events(id)).length, 0);
    assert.equal(await stateOf(id), 'active');
  });
});

describe('B3: the evidence file must have its real path under <board root>/.claudedocs/e2e-<id>/', () => {
  const refusedEvidence = async (id, p, opts) => {
    const r = lane(['done', id, '--no-pr', '--evidence', p], opts);
    assert.equal(r.code, 4, `${p}: ${r.all}`);
    assert.match(r.line1, new RegExp(`^REFUSED done ${id} \\[no-evidence\\] -- `), p);
    assert.equal(await stateOf(id), 'active', 'a refusal leaves the lane as it was');
    assert.equal((await events(id)).length, 0);
  };

  it('a file in another folder that only contains the segment in its path is refused', async () => {
    const id = await mk('b3foreign');
    const dir = path.join(s.tmp, 'elsewhere', '.claudedocs', `e2e-${id}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'out.txt'), 'x');
    await refusedEvidence(id, path.join(dir, 'out.txt'));
    const inOtherRepo = path.join(s.repo2, '.claudedocs', `e2e-${id}`);
    fs.mkdirSync(inOtherRepo, { recursive: true });
    fs.writeFileSync(path.join(inOtherRepo, 'out.txt'), 'x');
    await refusedEvidence(id, path.join(inOtherRepo, 'out.txt'));
  });

  it('a .. escape out of the lane folder is refused, also when it ends on a real file', async () => {
    const id = await mk('b3dots');
    evidenceFile(id);
    fs.writeFileSync(path.join(s.repo, 'root-file.txt'), 'x');
    await refusedEvidence(id, `.claudedocs/e2e-${id}/../../root-file.txt`);
    await refusedEvidence(id, `.claudedocs/e2e-${id}/../e2e-${id}x/out.txt`);
  });

  it('a file in a sub folder of the lane folder is accepted (segments, not a flat compare)', async () => {
    const id = await mk('b3sub');
    const dir = path.join(s.repo, '.claudedocs', `e2e-${id}`, 'sub');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'deep.txt'), 'x');
    const r = lane(['done', id, '--no-pr', '--evidence', `.claudedocs/e2e-${id}/sub/deep.txt`]);
    assert.equal(r.code, 0, r.all);
  });

  it('a folder link inside the lane folder that points outside is refused', async (t) => {
    const id = await mk('b3link');
    const outside = path.join(s.tmp, 'outside-target');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'out.txt'), 'x');
    const dir = path.join(s.repo, '.claudedocs', `e2e-${id}`);
    fs.mkdirSync(dir, { recursive: true });
    try { fs.symlinkSync(outside, path.join(dir, 'link'), 'junction'); } catch (e) {
      t.skip(`this platform did not let the test make a link or junction (${e.code}); the real path check is covered by the cases above`);
      return;
    }
    await refusedEvidence(id, `.claudedocs/e2e-${id}/link/out.txt`);
  });
});

describe('flag parser', () => {
  it('"done re-x --merged" with no value is a usage error (exit 1) and writes nothing', async () => {
    const id = await mk('nov');
    for (const args of [['done', id, '--merged'], ['done', id, '--merged', '--note', 'x'], ['done', id, '--no-pr', '--evidence']]) {
      const r = lane(args);
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.all}`);
      assert.match(r.err, /--(merged|evidence) needs a value/);
    }
    assert.equal((await events(id)).length, 0);
  });

  it('--reason with no value is a usage error on any verb', () => {
    const r = lane(['board', '--reason']);
    assert.equal(r.code, 1);
    assert.match(r.err, /--reason needs a value/);
  });

  it('"done --no-pr re-x --evidence p": --no-pr takes no value, so re-x stays the lane id', async () => {
    const id = await mk('bool');
    const rel = evidenceFile(id);
    assert.equal(lane(['done', '--no-pr', id, '--evidence', rel]).code, 0);
    const id2 = await mk('bool2');
    assert.equal(lane(['done', '--dep-override', id2, '--merged', s.A]).code, 0, '--dep-override is boolean too');
    assert.equal(await met(id2), true);
  });

  it('the forms do not mix: --merged with --no-pr, --no-pr without --evidence, --evidence without --no-pr', async () => {
    const id = await mk('mix');
    const rel = evidenceFile(id);
    for (const args of [['done', id, '--merged', s.A, '--no-pr', '--evidence', rel], ['done', id, '--no-pr'], ['done', id, '--evidence', rel]]) {
      const r = lane(args);
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.all}`);
      assert.doesNotMatch(r.all, /REFUSED/);
    }
    assert.equal((await events(id)).length, 0);
  });
});

describe('plain done: the hint, and the database floor', () => {
  it('prints the hint only when a lane_dep row names this lane in depends_on', async () => {
    const dep = await mk('hintdep');
    const waiter = await mk('hintwaiter', 'backlog');
    const lone = await mk('hintlone');
    await q(s.url6, `INSERT INTO agentic_os.lane_dep (lane_id, depends_on, project_key) VALUES ($1,$2,$3)`, [waiter, dep, BOARD]);
    const withDependent = lane(['done', dep]);
    assert.equal(withDependent.code, 0, withDependent.all);
    assert.ok(withDependent.err.includes(HINT), withDependent.err);
    const noDependent = lane(['done', lone]);
    assert.equal(noDependent.code, 0);
    assert.ok(!noDependent.err.includes(HINT), 'a lane with no dependent gets no hint');
    const dep2 = await mk('hintdep2');
    await q(s.url6, `INSERT INTO agentic_os.lane_dep (lane_id, depends_on, project_key) VALUES ($1,$2,$3)`, [waiter, dep2, BOARD]);
    const merged = lane(['done', dep2, '--merged', s.A]);
    assert.ok(!merged.err.includes(HINT), 'done --merged needs no hint');
  });

  it('works on a database without lane_dep (through 5): done --merged, already met, plain done, no hint, no crash', async () => {
    const id = await mk('floor', 'active', s.url5);
    const opts = { url: s.url5 };
    const m = lane(['done', id, '--merged', s.A], opts);
    assert.equal(m.code, 0, m.all);
    assert.equal(await met(id, s.url5), true);
    const again = lane(['done', id], opts);
    assert.equal(again.code, 0, again.all);
    assert.equal(again.out.trim(), `${id} already met (merged ${s.A.slice(0, 12)}); nothing written`);
    const plain = await mk('floorplain', 'active', s.url5);
    const p = lane(['done', plain], opts);
    assert.equal(p.code, 0, p.all);
    assert.ok(!p.err.includes(HINT));
    assert.equal(await met(plain, s.url5), false);
  });
});
