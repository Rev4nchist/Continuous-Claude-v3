/**
 * lane-done-frees-claims.test -- `lane.mjs done --merged` frees the CALLER's own file claims on the merged files
 * (card coord-land-frees-claims).
 *
 * The real case of 2026-11-15: session X edits a file from worktree W (the built file-claims hook writes the claim),
 * W lands and is removed, session Y in another worktree is refused on that file. X runs done --merged. Y is granted.
 *
 * Every test spawns the real `lane.mjs` and the real built `file-claims.mjs` against a SCRATCH database that this file
 * creates and drops. The claims are written by the hook, never by hand, so the key form is the one the hook makes.
 *
 *   node --test scripts/coordination/lane-done-frees-claims.test.mjs
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
const HOOK = path.join(REPO, '.claude', 'hooks', 'dist', 'file-claims.mjs');
const { Client } = requireDep('pg', { repoRoot: REPO });

const fwd = (p) => String(p).replace(/\\/g, '/');
const BOARD = 'fc-a';
const X = randomUUID();
const Y = randomUUID();
const Z = randomUUID();
const s = { url: '', db: null, tmp: '', repo: '', home: '', registry: '', idDir: '', failBin: '', dropped: '' };

function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'LANE_PROJECT', 'CLAUDE_CODE_ENTRYPOINT',
    'LANE_SKIP_HOOK_PRECHECK', 'COORDINATION_SESSION_ID', 'COORDINATION_BREAK_GLASS', 'LANE_RELEASE_CLAIM_BIN', 'LANE_CLAIMS_FREE_BUDGET_MS']) delete env[k];
  return Object.assign(env, { CONTINUOUS_CLAUDE_DB_URL: s.url, DATABASE_URL: s.url, OPC_POSTGRES_URL: s.url });
}
const gitIn = (cwd, ...args) => execFileSync('git',
  ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
  { cwd, env: cleanEnv(), encoding: 'utf8', windowsHide: true }).trim();

/** The real lane.mjs, as session `as`, in the main checkout of the temp repo. */
function lane(args, { as = X, env: extra = {} } = {}) {
  assertScratchUrl(s.url);
  const env = Object.assign(cleanEnv(), { LANE_REGISTRY_PATH: s.registry, CCV3_IDENTITY_DIR: s.idDir, CLAUDE_CODE_SESSION_ID: as }, extra);
  const r = spawnSync(process.execPath, [LANE, ...args], { cwd: s.repo, env, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}

/** One Edit through the real built file-claims hook. Returns 'allow' or 'deny'. HOME is a temp folder: no live log lines. */
function edit(session, cwd, rel) {
  assertScratchUrl(s.url);
  const env = Object.assign(cleanEnv(), { HOME: s.home, USERPROFILE: s.home, CLAUDE_CODE_SESSION_ID: session });
  const input = JSON.stringify({
    session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd,
    tool_input: { file_path: path.join(cwd, rel), old_string: 'x', new_string: 'y' },
  });
  const r = spawnSync(process.execPath, [HOOK], { cwd, env, input, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `hook failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  return out?.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow';
}

const holds = async (session, rel) =>
  (await s.db.query(`SELECT 1 FROM file_claims WHERE session_id=$1 AND file_path=$2`, [session, rel])).rowCount === 1;

let seq = 0;
async function mkLane(name) {
  const id = `fc-${name}-${++seq}`;
  await s.db.query(`INSERT INTO agentic_os.lane (id,title,track,state,project_key) VALUES ($1,$2,'zz','active',$3)`, [id, `title of ${id}`, BOARD]);
  return id;
}

/** A linked worktree on a new branch off main. Returns its folder. */
function worktree(name) {
  const dir = path.join(s.tmp, `wt-${name}`);
  gitIn(s.repo, 'worktree', 'add', '-b', `b-${name}`, dir, 'main');
  return dir;
}
/** Commit `files` in worktree `dir`, merge its branch into main with a merge commit, remove the worktree. Returns the merge SHA. */
function land(dir, name, files) {
  for (const f of files) fs.writeFileSync(path.join(dir, f), `${name} ${f}\n`);
  gitIn(dir, 'add', ...files);
  gitIn(dir, 'commit', '-m', `change ${name}`);
  gitIn(s.repo, 'merge', '--no-ff', '-m', `Merge ${name}`, `b-${name}`);
  gitIn(s.repo, 'worktree', 'remove', dir);
  return gitIn(s.repo, 'rev-parse', 'HEAD');
}

before(async () => {
  const r = spawnSync(process.execPath, [SCRATCH, 'create', '--through', '6'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `scratch create failed: ${r.stderr}`);
  s.url = JSON.parse(r.stdout).url;
  assertScratchUrl(s.url);
  s.tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-done-claims-')));
  s.repo = path.join(s.tmp, 'repo');
  s.home = path.join(s.tmp, 'home');
  s.idDir = path.join(s.tmp, 'ids');
  for (const d of [s.repo, s.home, s.idDir]) fs.mkdirSync(d);
  s.registry = path.join(s.tmp, 'registry.json');
  fs.writeFileSync(s.registry, JSON.stringify({ version: '1.0', projects: [{ name: 'fc', key: BOARD, path: fwd(s.repo), status: 'active' }] }));
  s.failBin = path.join(s.tmp, 'fail-release.mjs');
  fs.writeFileSync(s.failBin, "console.error('release-claim: database unavailable, nothing was changed'); process.exit(1);\n");
  gitIn(s.repo, 'init', '-b', 'main');
  for (const f of ['f.txt', 'g.txt', 'h.txt', 'd.txt', 'k.txt', 'm.txt', 'n.txt', 'p.txt']) fs.writeFileSync(path.join(s.repo, f), `${f}\n`);
  gitIn(s.repo, 'add', '.');
  gitIn(s.repo, 'commit', '-m', 'base');
  s.db = new Client({ connectionString: s.url });
  await s.db.connect();
  await s.db.query(`SELECT set_config('lane.client_version','test',false)`);
  for (const id of [X, Y, Z]) {
    await s.db.query(`INSERT INTO sessions (id, project, last_heartbeat, last_activity_at) VALUES ($1, 'fc', NOW(), NOW())`, [id]);
  }
});

after(async () => {
  await s.db?.end().catch(() => {});
  if (s.url) {
    assertScratchUrl(s.url);
    const r = spawnSync(process.execPath, [SCRATCH, 'drop', s.url], { encoding: 'utf8' });
    s.dropped = `status ${r.status}`;
  }
  if (s.tmp) fs.rmSync(s.tmp, { recursive: true, force: true });
  console.log(`scratch database dropped: ${s.dropped}`);
});

describe('done --merged frees the caller\'s claims on the merged files', () => {
  it('the real case: X claims f from worktree W, W lands and is removed, Y is refused, X runs done --merged, Y is granted', async () => {
    const w = worktree('w');
    const v = worktree('v');
    assert.equal(edit(X, w, 'f.txt'), 'allow');
    assert.equal(edit(X, w, 'g.txt'), 'allow');
    assert.equal(edit(X, w, 'd.txt'), 'allow');
    assert.equal(edit(Z, v, 'h.txt'), 'allow');
    // The key the hook made in W is the repo-relative name: the same key from the main checkout (seat item 2).
    assert.equal(await holds(X, 'f.txt'), true);
    assert.equal(edit(Y, v, 'f.txt'), 'deny', 'Y is refused while X holds f');
    fs.writeFileSync(path.join(v, 'd.txt'), 'uncommitted work in v\n');
    const sha = land(w, 'w', ['f.txt', 'd.txt', 'h.txt']);
    const id = await mkLane('real');
    const r = lane(['done', id, '--merged', sha]);
    assert.equal(r.code, 0, r.all);
    assert.equal(r.out.trim(), `${id} -> done (merged ${sha.slice(0, 12)} on main; released)`, 'the done line is unchanged');
    assert.equal(await holds(X, 'f.txt'), false, 'X\'s claim on the merged file f is freed');
    assert.equal(edit(Y, v, 'f.txt'), 'allow', 'Y is granted f after the done');
    assert.equal(await holds(X, 'g.txt'), true, 'g is not in the merge: X keeps it');
    assert.equal(await holds(X, 'd.txt'), true, 'd is dirty in a live worktree: X keeps it');
    assert.equal(await holds(Z, 'h.txt'), true, 'another live session\'s claim is never freed');
    assert.match(r.err, new RegExp(`^\\[lane\\] note: freed 1 of your file claims on the merged files`, 'm'));
    assert.match(r.err, new RegExp(`^\\[lane\\] note: .*#${Z.slice(0, 8)}.* holds 1 merged file`, 'm'), 'the live holder is named with its count');
  });

  it('--json adds the claim counts', async () => {
    const w = worktree('j');
    assert.equal(edit(X, w, 'k.txt'), 'allow');
    const sha = land(w, 'j', ['k.txt']);
    const id = await mkLane('json');
    const r = lane(['done', id, '--merged', sha, '--json']);
    assert.equal(r.code, 0, r.all);
    const j = JSON.parse(r.out);
    assert.equal(j.state, 'done');
    assert.deepEqual(j.claims, { freed: 1, kept: 0, dirty: 0, others: [] });
  });

  it('a failed free never fails the done: exit 0, lane done, one note line, the claim stays', async () => {
    const w = worktree('fail');
    assert.equal(edit(X, w, 'm.txt'), 'allow');
    const sha = land(w, 'fail', ['m.txt']);
    const id = await mkLane('fail');
    const r = lane(['done', id, '--merged', sha], { env: { LANE_RELEASE_CLAIM_BIN: s.failBin } });
    assert.equal(r.code, 0, r.all);
    assert.equal((await s.db.query(`SELECT state FROM agentic_os.lane WHERE id=$1`, [id])).rows[0].state, 'done');
    const notes = r.err.split('\n').filter((l) => l.startsWith('[lane] note: file claims not freed'));
    assert.equal(notes.length, 1, r.err);
    assert.equal(await holds(X, 'm.txt'), true);
  });

  it('past the time budget the free stops: exit 0, lane done, one budget note, the claim stays', async () => {
    const w = worktree('slow');
    assert.equal(edit(X, w, 'p.txt'), 'allow');
    const sha = land(w, 'slow', ['p.txt']);
    const id = await mkLane('slow');
    // A 1 ms budget: the first git child outlives it, the same path a slow git takes against the 20 s budget.
    const r = lane(['done', id, '--merged', sha], { env: { LANE_CLAIMS_FREE_BUDGET_MS: '1' } });
    assert.equal(r.code, 0, r.all);
    assert.equal((await s.db.query(`SELECT state FROM agentic_os.lane WHERE id=$1`, [id])).rows[0].state, 'done');
    const notes = r.err.split('\n').filter((l) => l.startsWith('[lane] note: file claims not freed (time budget'));
    assert.equal(notes.length, 1, r.err);
    assert.equal(await holds(X, 'p.txt'), true);
  });

  it('done --no-pr and a plain done free nothing (passes before and after)', async () => {
    assert.equal(edit(X, s.repo, 'n.txt'), 'allow');
    const plain = await mkLane('plain');
    assert.equal(lane(['done', plain]).code, 0);
    assert.equal(await holds(X, 'n.txt'), true);
    const noPr = await mkLane('nopr');
    const dir = path.join(s.repo, '.claudedocs', `e2e-${noPr}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'out.txt'), 'evidence\n');
    const r = lane(['done', noPr, '--no-pr', '--evidence', `.claudedocs/e2e-${noPr}/out.txt`]);
    assert.equal(r.code, 0, r.all);
    assert.equal(await holds(X, 'n.txt'), true);
  });
});
