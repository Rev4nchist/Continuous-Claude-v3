/**
 * lane-holder-flags.test -- gap 4, rule L2.10: `--as`, `--override` and `seed` on a held lane.
 *
 * Every test spawns the real lane.mjs as a child process against a SCRATCH database that this file creates and drops. The cwd is a
 * temp git repo. Two boards: GC_PLAIN (no master card) and GC_MASTER (its `re-program` lane is held by SEAT).
 *
 *   node --test scripts/coordination/lane-holder-flags.test.mjs
 *   LANE_CLI=<path to an older lane.mjs> node --test scripts/coordination/lane-holder-flags.test.mjs   # proves the tests fail on old code
 *
 * Failure modes, one group each (design note .claudedocs/coordination/2026-11-16-coord-holder-flags-design.md, section 3):
 *   --as      a stranger id changes a held lane; own id or the flag value "1" refused; "0", "" and "true" count as set;
 *             a read verb breaks; no session env makes --as pass.
 *   --override a stranger overrides a live holder; the seat is refused; another board's seat counts; a seat with no card counts;
 *             a board with no master card cannot reach a quiet holder.
 *   seed      a held lane is rewritten; a file with one held lane writes its other lanes; the holder, the seat, an unowned lane
 *             or a reclaimable lane is refused.
 *   unchanged claim --dep-override, and --as with the caller's own id.
 * The file name has no `.db.` part: test CO1 in pre-pr.cases.mjs matches the CI list with scripts/coordination/[\w-]+\.test\.mjs.
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
const LANE = process.env.LANE_CLI ? path.resolve(process.env.LANE_CLI) : path.join(HERE, 'lane.mjs');
const SCRATCH = path.join(HERE, 'scratch-db.mjs');
const { Client } = requireDep('pg', { repoRoot: REPO });

const fwd = (p) => String(p).replace(/\\/g, '/');
const GC_PLAIN = 'gh-plain';
const GC_MASTER = 'gh-master';
const s = { url: '', db: null, tmp: '', repo: '', registry: '', idDir: '' };
const sid = () => randomUUID();
const ME = sid();
const HOLDER = sid();
const SEAT = sid();

function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'LANE_PROJECT', 'CLAUDE_CODE_ENTRYPOINT', 'LANE_SKIP_HOOK_PRECHECK', 'LANE_ALLOW_AS']) delete env[k];
  return env;
}
function laneEnv() {
  assertScratchUrl(s.url);
  return Object.assign(cleanEnv(), {
    CONTINUOUS_CLAUDE_DB_URL: s.url, DATABASE_URL: s.url, OPC_POSTGRES_URL: s.url,
    LANE_REGISTRY_PATH: s.registry, CCV3_IDENTITY_DIR: s.idDir, CLAUDE_CODE_SESSION_ID: ME,
  });
}
/**
 * Run lane.mjs. `as` adds `--as <id>`; `env` adds or (value undefined) removes env keys; `board` adds `--project`.
 * By default the caller is ME with no --as, and LANE_ALLOW_AS is NOT set.
 */
function lane(args, { as, env = {}, board } = {}) {
  const argv = [LANE, ...args, ...(as ? ['--as', as] : []), ...(board ? ['--project', board] : [])];
  const e = { ...laneEnv(), ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const r = spawnSync(process.execPath, argv, { cwd: s.repo, env: e, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout, err: r.stderr, line1: r.stderr.split('\n')[0] };
}
/** The same run as `lane`, as a promise, so a test can do other work while the child waits. */
lane.async = (args, { as, env = {}, board } = {}) => new Promise((resolve) => {
  const argv = [LANE, ...args, ...(as ? ['--as', as] : []), ...(board ? ['--project', board] : [])];
  const p = spawn(process.execPath, argv, { cwd: s.repo, env: { ...laneEnv(), ...env }, windowsHide: true });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.stdout.on('data', () => {});
  p.on('close', (code) => resolve({ code, err }));
});
const q = (sql, params) => s.db.query(sql, params);
const one = async (sql, params) => (await q(sql, params)).rows[0];
let seq = 0;
async function mk(prefix, { state = 'active', board = GC_PLAIN, owner = null, lapsed = false } = {}) {
  const id = `${prefix}-${++seq}`;
  await q(
    `INSERT INTO agentic_os.lane (id,title,track,scope,state,project_key,owner_session_id,lease_expires_at)
     VALUES ($1,$2,'zz','OWNS: x NEVER: y',$3,$4,$5,$6)`,
    [id, `title of ${id}`, state, board, owner, owner ? new Date(Date.now() + (lapsed ? -3600_000 : 3600_000)) : null],
  );
  return id;
}
/** A sessions row that beat `minutesAgo` minutes ago (0 = live). */
const session = (id, minutesAgo = 0) => q(
  `INSERT INTO sessions (id, project, working_on, last_heartbeat, last_activity_at)
   VALUES ($1,'probe','probe', now() - make_interval(mins => $2::int), now() - make_interval(mins => $2::int))
   ON CONFLICT (id) DO UPDATE SET last_heartbeat = EXCLUDED.last_heartbeat, last_activity_at = EXCLUDED.last_activity_at`, [id, minutesAgo]);
const row = (id) => one(`SELECT id, title, scope, state, owner_session_id AS owner, note FROM agentic_os.lane WHERE id=$1`, [id]);
const events = async () => (await one(`SELECT count(*)::int AS n FROM agentic_os.lane_event`)).n;
/**
 * True when a backend of the scratch database waits on a lock in a statement that holds `fragment` (card coord-lane-cli-followups, item 2:
 * a fixed sleep proves nothing under load). Polls every 50 ms for up to 15 s and returns at the first hit; false when none was seen.
 */
async function seenWaiting(fragment, timeoutMs = 15000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await new Promise((ok) => setTimeout(ok, 50))) {
    const n = (await one(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND pid <> pg_backend_pid() AND query LIKE $1`, [`%${fragment}%`])).n;
    if (n > 0) return true;
  }
  return false;
}

/** exit 4, line 1 `REFUSED <verb> ... [token] -- `, the row unchanged and no event written. */
async function assertRefused(args, token, id, opts) {
  const before = id ? await row(id) : null;
  const n = await events();
  const r = lane(args, opts);
  assert.equal(r.code, 4, `exit code: ${r.err}`);
  assert.match(r.line1, new RegExp(`^REFUSED \\S+ \\S+ \\[${token}\\] -- `), r.err);
  if (id) assert.deepEqual(await row(id), before, 'a refusal leaves the lane row as it was');
  assert.equal(await events(), n, 'a refusal writes no event');
  return r;
}

before(async () => {
  const c = spawnSync(process.execPath, [SCRATCH, 'create', '--through', '6'], { encoding: 'utf8' });
  assert.equal(c.status, 0, `scratch create failed: ${c.stderr}`);
  s.url = JSON.parse(c.stdout).url;
  assertScratchUrl(s.url);
  s.tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-holder-flags-')));
  s.repo = path.join(s.tmp, 'repo');
  const repoM = path.join(s.tmp, 'repo-master');
  s.idDir = path.join(s.tmp, 'ids');
  for (const d of [s.repo, repoM, s.idDir]) fs.mkdirSync(d);
  s.registry = path.join(s.tmp, 'registry.json');
  fs.writeFileSync(s.registry, JSON.stringify({ version: '1.0', projects: [
    { name: 'gh-plain', key: GC_PLAIN, path: fwd(s.repo), status: 'active' },
    { name: 'gh-master', key: GC_MASTER, path: fwd(repoM), status: 'active' },
  ] }));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: s.repo, env: cleanEnv(), windowsHide: true });
  git('init', '-b', 'main'); fs.writeFileSync(path.join(s.repo, 'a.txt'), 'a'); git('add', 'a.txt'); git('commit', '-m', 'a');
  s.db = new Client({ connectionString: s.url });
  await s.db.connect();
  await s.db.query(`SELECT set_config('lane.client_version','test',false)`);
  for (const id of [ME, HOLDER, SEAT]) await session(id);
  await q(
    `INSERT INTO agentic_os.lane (id,title,track,state,project_key,owner_session_id,lease_expires_at)
     VALUES ('re-program','master card','zz','active',$1,$2, now() + interval '1 hour')`, [GC_MASTER, SEAT]);
});

after(async () => {
  await s.db?.end().catch(() => {});
  if (s.url) { assertScratchUrl(s.url); spawnSync(process.execPath, [SCRATCH, 'drop', s.url], { encoding: 'utf8' }); }
  if (s.tmp) fs.rmSync(s.tmp, { recursive: true, force: true });
});

describe('--as on a write verb', () => {
  it('a stranger id is refused with [as-refused] and the lane stays', async () => {
    const id = await mk('as-a', { owner: HOLDER });
    await assertRefused(['note', id, 'hijack'], 'as-refused', id, { as: HOLDER });
  });
  it('the caller own id passes with no flag', async () => {
    const id = await mk('as-b', { owner: ME });
    const r = lane(['note', id, 'mine'], { as: ME });
    assert.equal(r.code, 0, r.err);
    assert.equal((await row(id)).note, 'mine');
  });
  it('LANE_ALLOW_AS=1 lets a stranger id through (drills and probes)', async () => {
    const id = await mk('as-c', { owner: HOLDER });
    const r = lane(['note', id, 'drill'], { as: HOLDER, env: { LANE_ALLOW_AS: '1' } });
    assert.equal(r.code, 0, r.err);
  });
  for (const bad of ['0', '', 'true', 'yes']) {
    it(`LANE_ALLOW_AS=${JSON.stringify(bad)} does not count as set`, async () => {
      const id = await mk('as-d', { owner: HOLDER });
      await assertRefused(['note', id, 'x'], 'as-refused', id, { as: HOLDER, env: { LANE_ALLOW_AS: bad } });
    });
  }
  it('no CLAUDE_CODE_SESSION_ID and --as on a write verb is refused', async () => {
    const id = await mk('as-e', { owner: HOLDER });
    await assertRefused(['note', id, 'x'], 'as-refused', id, { as: HOLDER, env: { CLAUDE_CODE_SESSION_ID: undefined } });
  });
  it('plain inbox moves a read cursor, so --as <other> is refused; inbox --peek and inbox --id stay open', async () => {
    const n = await events();
    const r = lane(['inbox'], { as: HOLDER });
    assert.equal(r.code, 4, r.err);
    assert.match(r.line1, /^REFUSED inbox \S+ \[as-refused\] -- /, r.err);
    assert.equal(await events(), n);
    assert.equal(lane(['inbox', '--peek'], { as: HOLDER }).code, 0);
  });
  it('a read verb keeps --as with no flag, also with no session env (the /os pane)', () => {
    for (const env of [{}, { CLAUDE_CODE_SESSION_ID: undefined }]) {
      const r = lane(['board', '--json'], { as: HOLDER, env });
      assert.equal(r.code, 0, r.err);
      assert.equal(JSON.parse(r.out).me, HOLDER);
    }
  });
});

describe('--override', () => {
  it('a plain board: a stranger is refused on a LIVE holder, and the text says the holder is live', async () => {
    const id = await mk('ov-a', { owner: HOLDER });
    const r = await assertRefused(['state', id, 'review', '--override', '--reason', 'x'], 'override-not-seat', id);
    assert.match(r.line1, /live/, r.err);
  });
  it('a plain board: a stranger passes on a QUIET parked holder (the way out of a park, lease still running)', async () => {
    const gone = sid();
    await session(gone, 30);
    const id = await mk('ov-b', { owner: gone });
    const r = lane(['release', id, '--override', '--reason', 'handover']);
    assert.equal(r.code, 0, r.err);
    assert.equal((await row(id)).owner, null);
  });
  it('a master board: a stranger is refused even on a quiet holder', async () => {
    const gone = sid();
    await session(gone, 30);
    const id = await mk('ov-c', { board: GC_MASTER, owner: gone });
    const r = await assertRefused(['state', id, 'review', '--override', '--reason', 'x'], 'override-not-seat', id, { board: GC_MASTER });
    assert.match(r.line1, /re-program/, r.err);
  });
  it('a master board: the holder of the master card passes on state, release, done and release --blocked, with the DM and the board event', async () => {
    for (const args of [['state', 'review'], ['release'], ['release', '--blocked'], ['done']]) {
      const id = await mk('ov-d', { board: GC_MASTER, owner: HOLDER });
      const before = await events();
      const r = lane([args[0], id, ...args.slice(1), '--override', '--reason', 'seat'], { as: SEAT, env: { LANE_ALLOW_AS: '1' }, board: GC_MASTER });
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
      assert.ok((await events()) >= before + 2, `${args.join(' ')} writes the DM and the board event`);
    }
  });
  it('every write path refuses a stranger --override on a live holder: release, release --blocked, done, done --merged, done --no-pr', async () => {
    const forms = [['release'], ['release', '--blocked'], ['done'], ['done', '--merged', '1234567'], ['done', '--no-pr', '--evidence', 'x']];
    for (const f of forms) {
      const id = await mk('ov-w', { owner: HOLDER });
      await assertRefused([f[0], id, ...f.slice(1), '--override', '--reason', 'x'], 'override-not-seat', id);
    }
  });
  it('a holder who adds --override to their own done --merged keeps the plain-call answer, not [override-not-seat]', async () => {
    const id = await mk('ov-h', { board: GC_MASTER, owner: ME });
    const r = lane(['done', id, '--merged', '1234567', '--override', '--reason', 'x'], { board: GC_MASTER });
    assert.doesNotMatch(r.err, /override-not-seat/, r.err);
  });
  it('the seat of one board gets nothing on a plain board with a live holder', async () => {
    const id = await mk('ov-e', { owner: HOLDER });
    await assertRefused(['state', id, 'review', '--override', '--reason', 'x'], 'override-not-seat', id, { as: SEAT, env: { LANE_ALLOW_AS: '1' } });
  });
  it('a seat that released the master card is refused (the card exists and has no holder)', async () => {
    const id = await mk('ov-f', { board: GC_MASTER, owner: HOLDER });
    await q(`UPDATE agentic_os.lane SET owner_session_id = NULL WHERE id = 're-program'`);
    try {
      await assertRefused(['state', id, 'review', '--override', '--reason', 'x'], 'override-not-seat', id, { as: SEAT, env: { LANE_ALLOW_AS: '1' }, board: GC_MASTER });
    } finally {
      await q(`UPDATE agentic_os.lane SET owner_session_id = $1 WHERE id = 're-program'`, [SEAT]);
    }
  });
});

describe('seed on a held lane', () => {
  const file = (name, content) => { const f = path.join(s.tmp, name); fs.writeFileSync(f, JSON.stringify(content)); return f; };
  const newId = () => `sd-new-${++seq}`;
  for (const form of ['array', 'object']) {
    const body = (lanes) => (form === 'array' ? lanes : { lanes, edges: [] });
    it(`${form} form: a stranger is refused and no lane of the file is written`, async () => {
      const held = await mk('sd-a', { owner: HOLDER });
      const fresh = newId();
      const f = file(`${form}-1.json`, body([{ id: held, title: 'rewritten', track: 'zz', scope: 'NEW' }, { id: fresh, title: 'new', track: 'zz' }]));
      const before = await row(held);
      const n = await events();
      const r = lane(['seed', f]);
      assert.equal(r.code, 4, r.err);
      assert.match(r.line1, new RegExp(`^REFUSED seed ${held} \\[not-holder\\] -- `), r.err);
      assert.deepEqual(await row(held), before);
      assert.equal(await row(fresh), undefined, 'the other lane of the file is not written');
      assert.equal(await events(), n);
    });
    it(`${form} form: the holder, an unowned lane, a reclaimable lane and a new id pass`, async () => {
      const mine = await mk('sd-b', { owner: ME });
      const free = await mk('sd-c', { state: 'ready' });
      const dead = await mk('sd-d', { owner: sid(), lapsed: true });
      const fresh = newId();
      // A band on every item runs the withBand conflict clause (the caller id is $15 there, $13 without a band): the holder passes only with the right index.
      const f = file(`${form}-2.json`, body([mine, free, dead, fresh].map((id) => ({ id, title: `t ${id}`, track: 'zz', scope: 'SEEDED', band: 'P1' }))));
      const r = lane(['seed', f]);
      assert.equal(r.code, 0, r.err);
      for (const id of [mine, free, dead, fresh]) assert.equal((await row(id)).scope, 'SEEDED', id);
    });
    it(`${form} form: the master card holder seeds a lane a builder holds`, async () => {
      const held = await mk('sd-e', { board: GC_MASTER, owner: HOLDER });
      const f = file(`${form}-3.json`, body([{ id: held, title: 'by the seat', track: 'zz', scope: 'SEAT', band: 'P2' }])); // with a band: the withBand parameter index
      const r = lane(['seed', f], { as: SEAT, env: { LANE_ALLOW_AS: '1' }, board: GC_MASTER });
      assert.equal(r.code, 0, r.err);
      assert.equal((await row(held)).scope, 'SEAT');
    });
    it(`${form} form: a claim that commits while the seed waits is seen by the holder test (the lock covers unowned lanes too)`, async () => {
      const free = await mk('sd-r', { state: 'ready' });
      const f = file(`${form}-race.json`, body([{ id: free, title: 'rewritten', track: 'zz', scope: 'RACE' }]));
      const holdTx = new Client({ connectionString: s.url });
      await holdTx.connect();
      await holdTx.query(`SELECT set_config('lane.client_version','test',false)`);
      await holdTx.query('BEGIN');
      await holdTx.query(`SELECT 1 FROM agentic_os.lane WHERE id=$1 FOR UPDATE`, [free]);
      const seeding = lane.async(['seed', f]);
      const waiting = await seenWaiting('FOR UPDATE OF l'); // the seed is waiting on the row lock: seen, not guessed (item 2)
      await holdTx.query(`UPDATE agentic_os.lane SET owner_session_id=$1, state='active', lease_expires_at = now() + interval '1 hour' WHERE id=$2`, [HOLDER, free]);
      await holdTx.query('COMMIT');
      await holdTx.end();
      const r = await seeding;
      assert.ok(waiting, 'the seed was never seen waiting on the row lock: the test would prove nothing');
      assert.equal(r.code, 4, r.err);
      assert.notEqual((await row(free)).scope, 'RACE');
    });
    it(`${form} form: a peer that creates and claims a NEW id while the seed waits keeps its title, track and scope (item 1)`, async () => {
      // Two ids: `early` sorts before `fresh`, so it is written first in the seed transaction; the refusal on `fresh` must roll it back (array and object form).
      const early = `sd-na-${++seq}`;
      const fresh = `sd-nb-${++seq}`;
      const f = file(`${form}-newrace.json`, body([
        { id: early, title: 'early', track: 'zz', scope: 'EARLY' },
        { id: fresh, title: 'rewritten', track: 'zz', scope: 'RACE' },
      ]));
      const peer = new Client({ connectionString: s.url });
      await peer.connect();
      await peer.query(`SELECT set_config('lane.client_version','test',false)`);
      await peer.query('BEGIN');
      // The id has no row yet, so the holder test of the seed has nothing to lock. The peer's insert (not committed) makes the seed INSERT wait.
      await peer.query(
        `INSERT INTO agentic_os.lane (id,title,track,scope,state,project_key,owner_session_id,lease_expires_at)
         VALUES ($1,'peer title','peer-track','PEER SCOPE','active',$2,$3, now() + interval '1 hour')`, [fresh, GC_PLAIN, HOLDER]);
      const seeding = lane.async(['seed', f]);
      const waiting = await seenWaiting('INSERT INTO agentic_os.lane'); // the seed INSERT, old text and the text with an alias alike
      await peer.query('COMMIT');
      await peer.end();
      const r = await seeding;
      assert.ok(waiting, 'the seed INSERT was never seen waiting on the peer row: the test would prove nothing');
      assert.equal(r.code, 4, r.err);
      assert.match(r.err.split('\n')[0], /^REFUSED seed \S+ \[not-holder\] -- /, r.err);
      const after = await row(fresh);
      assert.equal(after.title, 'peer title');
      assert.equal(after.scope, 'PEER SCOPE');
      assert.equal(after.owner, HOLDER);
      assert.equal(await row(early), undefined, 'the first lane of the file is rolled back with the refusal');
    });
    it(`${form} form: a peer that creates the id on ANOTHER board while the seed waits gives the foreign-id error, not not-holder (item 1)`, async () => {
      const fresh = newId();
      const f = file(`${form}-foreignrace.json`, body([{ id: fresh, title: 'rewritten', track: 'zz', scope: 'RACE' }]));
      const peer = new Client({ connectionString: s.url });
      await peer.connect();
      await peer.query(`SELECT set_config('lane.client_version','test',false)`);
      await peer.query('BEGIN');
      // The checks before the transaction see no row, so the INSERT meets the peer's row (another board, held) only after the wait.
      await peer.query(
        `INSERT INTO agentic_os.lane (id,title,track,scope,state,project_key,owner_session_id,lease_expires_at)
         VALUES ($1,'peer title','peer-track','PEER SCOPE','active',$2,$3, now() + interval '1 hour')`, [fresh, GC_MASTER, HOLDER]);
      const seeding = lane.async(['seed', f]);
      const waiting = await seenWaiting('INSERT INTO agentic_os.lane');
      await peer.query('COMMIT');
      await peer.end();
      const r = await seeding;
      assert.ok(waiting, 'the seed INSERT was never seen waiting on the peer row: the test would prove nothing');
      assert.notEqual(r.code, 0, r.err);
      assert.doesNotMatch(r.err, /\[not-holder\]/, r.err);
      assert.match(r.err, /belongs to board/, r.err);
      assert.equal((await row(fresh)).scope, 'PEER SCOPE');
    });
    it(`${form} form: the lanes of a seed are written in id order, so two files with the same new ids in opposite order cannot deadlock (item 1, critic finding)`, async () => {
      const a = `sd-oa-${++seq}`;
      const b = `sd-ob-${++seq}`;
      const f = file(`${form}-order.json`, body([{ id: b, title: 'b', track: 'zz', scope: 'B' }, { id: a, title: 'a', track: 'zz', scope: 'A' }])); // file order: b, a
      const peer = new Client({ connectionString: s.url });
      const peer2 = new Client({ connectionString: s.url });
      await peer.connect();
      await peer2.connect();
      let second = null;
      try {
        for (const c of [peer, peer2]) await c.query(`SELECT set_config('lane.client_version','test',false)`);
        // The peer holds an uncommitted row for `b`. In id order the seed writes `a` first and then waits on `b`; in file order it waits on `b` at once and never writes `a`.
        await peer.query('BEGIN');
        await peer.query(`INSERT INTO agentic_os.lane (id,title,track,state,project_key) VALUES ($1,'peer','zz','ready',$2)`, [b, GC_PLAIN]);
        const seeding = lane.async(['seed', f]);
        // A second writer wants `a`: it waits only when the seed has already written `a` (and holds it uncommitted).
        assert.ok(await seenWaiting('INSERT INTO agentic_os.lane'), 'the seed INSERT was never seen waiting on the peer row: the test would prove nothing');
        second = peer2.query(`/* order-probe */ INSERT INTO agentic_os.lane (id,title,track,state,project_key) VALUES ($1,'second','zz','ready',$2) ON CONFLICT (id) DO NOTHING`, [a, GC_PLAIN]);
        const sawIt = await seenWaiting('/* order-probe */', 6000);
        await peer.query('ROLLBACK'); // the seed can now write `b` and commit
        const r = await seeding;
        await second;
        assert.ok(sawIt, 'the seed did not write the lane that sorts first before it waited: the lanes are not written in id order');
        assert.equal(r.code, 0, r.err);
        assert.equal((await row(a)).title, 'a');
        assert.equal((await row(b)).title, 'b');
      } finally {
        await peer.query('ROLLBACK').catch(() => {});
        await Promise.resolve(second).catch(() => {});
        await peer.end().catch(() => {});
        await peer2.end().catch(() => {});
      }
    });
    it(`${form} form: an id that another board owns is still the foreign-id error, not not-holder (item 1)`, async () => {
      const other = await mk('sd-g', { board: GC_MASTER, owner: HOLDER });
      const f = file(`${form}-foreign.json`, body([{ id: other, title: 'x', track: 'zz', scope: 'NO' }]));
      const r = lane(['seed', f]); // the caller's board is GC_PLAIN
      assert.notEqual(r.code, 0, r.err);
      assert.doesNotMatch(r.err, /\[not-holder\]/, r.err);
      assert.notEqual((await row(other)).scope, 'NO');
    });
    it(`${form} form: on a master board a stranger is refused`, async () => {
      const held = await mk('sd-f', { board: GC_MASTER, owner: HOLDER });
      const f = file(`${form}-4.json`, body([{ id: held, title: 'x', track: 'zz', scope: 'NO' }]));
      const r = lane(['seed', f], { board: GC_MASTER });
      assert.equal(r.code, 4, r.err);
      assert.notEqual((await row(held)).scope, 'NO');
    });
  }
});

describe('unchanged', () => {
  it('claim --dep-override still works with --as the caller own id', async () => {
    const dep = await mk('un-dep', { state: 'backlog' });
    const id = await mk('un-a', { state: 'backlog' });
    await q(`INSERT INTO agentic_os.lane_dep (lane_id, depends_on, project_key) VALUES ($1,$2,$3)`, [id, dep, GC_PLAIN]);
    const r = lane(['claim', id, '--dep-override', '--reason', 'test'], { as: ME });
    assert.equal(r.code, 0, r.err);
    assert.equal((await row(id)).owner, ME);
  });
});
