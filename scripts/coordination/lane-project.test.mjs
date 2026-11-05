/**
 * lane-project.test -- end to end tests for per-project lane boards in lane.mjs.
 *
 * Every test spawns the real `lane.mjs` as a child process against a SCRATCH
 * database (lanes_pr1_*) that this file creates and drops itself. It never reads
 * CONTINUOUS_CLAUDE_DB_URL for anything except the server address, and it refuses
 * to hand lane.mjs any URL that assertScratchUrl rejects.
 *
 *   node --test scripts/coordination/lane-project.test.mjs
 *
 * Fixtures: temp dirs A, B, C (boards pb-a, pb-b, continuous-claude), N (no board),
 * a temp registry through LANE_REGISTRY_PATH, sessions and lanes inserted directly.
 * Fixture ids start with `zz-pbprobe-`. `isSafeId` rejects those as identity files,
 * so the two sessions that need a name use random uuids.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertScratchUrl } from './scratch-db.mjs';
import { normalizeRoot } from './lane-board.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const LANE = path.join(HERE, 'lane.mjs');
const SCRATCH = path.join(HERE, 'scratch-db.mjs');

function loadPg() {
  for (const anchor of [path.join(REPO, '.claude', 'hooks', 'package.json'), path.join(REPO, 'apps', 'agentic-os', 'package.json')]) {
    try { return createRequire(pathToFileURL(anchor)).call(null, 'pg'); } catch { /* next */ }
  }
  throw new Error('cannot resolve `pg`');
}
const { Client } = loadPg();

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

// ---- shared state, built in before()
const state = { url: '', url3: '', tmp: '', dirs: {}, registry: '', idDir: '', db: null, cacheRoot: '' };
const SA = 'zz-pbprobe-sa';
const SB = 'zz-pbprobe-sb';
const SD = 'zz-pbprobe-sd';
const TWIN1 = randomUUID();
const TWIN2 = randomUUID();

function baseEnv(url = state.url) {
  const env = { ...process.env };
  delete env.LANE_PROJECT;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.LANE_SKIP_HOOK_PRECHECK;
  return {
    ...env,
    CONTINUOUS_CLAUDE_DB_URL: url, DATABASE_URL: url, OPC_POSTGRES_URL: url,
    LANE_REGISTRY_PATH: state.registry, CCV3_IDENTITY_DIR: state.idDir,
  };
}

/** Run lane.mjs. `as` is the session id; `extra` overrides env. */
function lane(cwd, as, args, extra = {}) {
  assertScratchUrl(baseEnv().CONTINUOUS_CLAUDE_DB_URL);
  const env = { ...baseEnv(), ...extra };
  assertScratchUrl(env.CONTINUOUS_CLAUDE_DB_URL);
  if (as) env.CLAUDE_CODE_SESSION_ID = as;
  const r = spawnSync(process.execPath, [LANE, ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}
const q = (sql, params) => state.db.query(sql, params);
/** A directory outside every registry root that register would accept (not home, not ~/.claude, not the OS temp dir). */
const noBoardDir = () => { const d = path.join(state.cacheRoot, 'no-board'); fs.mkdirSync(d, { recursive: true }); return d; };
const one = async (sql, params) => (await q(sql, params)).rows[0];

before(async () => {
  state.url = createScratch(4);
  state.url3 = createScratch(3);
  state.tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-project-')));
  for (const n of ['A', 'B', 'C', 'N']) {
    state.dirs[n] = path.join(state.tmp, 'proj' + n);
    fs.mkdirSync(state.dirs[n], { recursive: true });
  }
  fs.mkdirSync(path.join(state.dirs.A, 'sub', 'deep'), { recursive: true });
  state.idDir = path.join(state.tmp, 'ids');
  fs.mkdirSync(state.idDir);
  state.registry = path.join(state.tmp, 'registry.json');
  const entry = (name, key, dir) => ({ name, key, path: dir.replace(/\\/g, '/'), status: 'active' });
  fs.writeFileSync(state.registry, JSON.stringify({
    version: '1.0',
    projects: [entry('A', 'pb-a', state.dirs.A), entry('B', 'pb-b', state.dirs.B), entry('C', 'continuous-claude', state.dirs.C)],
  }));
  state.db = new Client({ connectionString: state.url });
  await state.db.connect();
  // The fixture connection plays a board-aware client; the fence test below uses its own, plain connection.
  await state.db.query(`SELECT set_config('lane.client_version','test',false)`);

  const proj = (d) => normalizeRoot(d);
  const sess = (id, project) => q(
    `INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES ($1,$2,'fixture',now())`, [id, project]);
  await sess(SA, proj(state.dirs.A));
  await sess(SB, proj(state.dirs.B));
  await sess(SD, 'c:/somewhere/else');
  await sess(TWIN1, proj(state.dirs.A));
  await sess(TWIN2, proj(state.dirs.B));
  for (const t of [TWIN1, TWIN2]) {
    fs.writeFileSync(path.join(state.idDir, `${t}.json`), JSON.stringify({ uuid: t, name: 'pb-twin', updatedAt: new Date().toISOString() }));
  }
  const mk = (id, board, st, owner = null) => q(
    `INSERT INTO agentic_os.lane (id,title,track,state,project_key,owner_session_id,lease_expires_at)
     VALUES ($1,$2,'zz',$3,$4,$5::text, CASE WHEN $5::text IS NULL THEN NULL ELSE now() + interval '30 minutes' END)`,
    [id, `title of ${id}`, st, board, owner]);
  await mk('zz-pbprobe-a1', 'pb-a', 'ready');
  await mk('zz-pbprobe-b1', 'pb-b', 'ready');
  await mk('zz-pbprobe-c1', 'continuous-claude', 'ready');
  await mk('zz-pbprobe-d1', 'pb-a', 'active', SD);
  state.cacheRoot = path.join(REPO, '.claude', 'cache', 'e2e', `lane-project-test-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(state.cacheRoot, { recursive: true });
});

after(async () => {
  await state.db?.end().catch(() => {});
  if (state.url) dropScratch(state.url);
  if (state.url3) dropScratch(state.url3);
  if (state.tmp) fs.rmSync(state.tmp, { recursive: true, force: true });
  if (state.cacheRoot) fs.rmSync(state.cacheRoot, { recursive: true, force: true });
});

describe('board scoping', () => {
  it('a board lists only its own lanes, with the board in the header', () => {
    const a = lane(state.dirs.A, SA, ['board']);
    assert.equal(a.code, 0, a.all);
    assert.match(a.out, /board pb-a/);
    assert.match(a.out, /zz-pbprobe-a1/);
    assert.doesNotMatch(a.out, /zz-pbprobe-b1|zz-pbprobe-c1/);
    const b = lane(state.dirs.B, SB, ['board']);
    assert.equal(b.code, 0, b.all);
    assert.match(b.out, /board pb-b/);
    assert.match(b.out, /zz-pbprobe-b1/);
    assert.doesNotMatch(b.out, /zz-pbprobe-a1|zz-pbprobe-c1/);
  });

  it('a subfolder of A resolves to A', () => {
    const r = lane(path.join(state.dirs.A, 'sub', 'deep'), SA, ['board']);
    assert.match(r.out, /board pb-a/);
  });

  it('--all shows every board and names the board of each lane', () => {
    const r = lane(state.dirs.A, SA, ['board', '--all']);
    assert.equal(r.code, 0, r.all);
    for (const id of ['a1', 'b1', 'c1']) assert.match(r.out, new RegExp(`zz-pbprobe-${id}`));
    assert.match(r.out, /pb-b/);
  });

  it('--all works from a directory with no board (read-only global view)', () => {
    const r = lane(state.dirs.N, SA, ['board', '--all']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /zz-pbprobe-b1/);
  });

  it('next never offers the other board lane', () => {
    const r = lane(state.dirs.A, SA, ['next', '--json']);
    assert.equal(r.code, 0, r.all);
    const ids = JSON.parse(r.out).map((l) => l.id);
    assert.ok(ids.includes('zz-pbprobe-a1'), ids.join());
    assert.ok(!ids.includes('zz-pbprobe-b1') && !ids.includes('zz-pbprobe-c1'), ids.join());
  });

  it('a registrable cwd with no board exits 1 with the register hint', () => {
    const r = lane(noBoardDir(), SA, ['board']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /no lane board for /);
    assert.match(r.err, /register it: node \S*\/\.claude\/scripts\/lane\.mjs project register /, 'the hint names the shim, not the primary lane.mjs');
    assert.doesNotMatch(r.err, /scripts\/coordination\/lane\.mjs/);
    assert.ok(path.isAbsolute(/node (\S+lane\.mjs)/.exec(r.err)[1].replace(/\//g, path.sep)), r.err);
  });

  it('M1: a cwd that can never be registered (the OS temp dir) is told to pass --project continuous-claude or set LANE_PROJECT', () => {
    const r = lane(state.dirs.N, SA, ['board']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /no lane board for /);
    assert.match(r.err, /cannot be registered/);
    assert.match(r.err, /--project continuous-claude/);
    assert.match(r.err, /LANE_PROJECT/);
    assert.doesNotMatch(r.err, /register it: node/);
    const viaFlag = lane(state.dirs.N, SA, ['board', '--project', 'continuous-claude']);
    assert.equal(viaFlag.code, 0, viaFlag.all);
    assert.match(viaFlag.out, /board continuous-claude/);
    const viaEnv = lane(state.dirs.N, SA, ['board'], { LANE_PROJECT: 'continuous-claude' });
    assert.equal(viaEnv.code, 0, viaEnv.all);
  });

  it('an unknown --project is an error that lists the registered keys', () => {
    const r = lane(state.dirs.A, SA, ['board', '--project', 'nope']);
    assert.equal(r.code, 1);
    assert.match(r.err, /unknown board 'nope'; registered: pb-a, pb-b, continuous-claude/);
  });

  it('--project picks a board from any cwd', () => {
    const r = lane(state.dirs.N, SA, ['board', '--project', 'pb-b']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /zz-pbprobe-b1/);
  });
});

describe('claim, note, state across boards', () => {
  it('claim of the other board lane is refused and changes nothing', async () => {
    const r = lane(state.dirs.A, SA, ['claim', 'zz-pbprobe-b1']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /no lane zz-pbprobe-b1 on board pb-a/);
    assert.match(r.err, /pb-b/);
    const row = await one(`SELECT owner_session_id, state FROM agentic_os.lane WHERE id='zz-pbprobe-b1'`);
    assert.equal(row.owner_session_id, null);
    assert.equal(row.state, 'ready');
  });

  it('claim of an own-board lane wins and the event carries the board', async () => {
    const r = lane(state.dirs.A, SA, ['claim', 'zz-pbprobe-a1']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /CLAIMED zz-pbprobe-a1/);
    const ev = await one(`SELECT project_key FROM agentic_os.lane_event WHERE lane_id='zz-pbprobe-a1' AND kind='claimed'`);
    assert.equal(ev.project_key, 'pb-a');
  });

  it('note and state on the other board lane are refused', async () => {
    const n = lane(state.dirs.A, SA, ['note', 'zz-pbprobe-b1', 'hello']);
    assert.equal(n.code, 1);
    assert.match(n.err, /no lane zz-pbprobe-b1 on board pb-a/);
    const s = lane(state.dirs.A, SA, ['state', 'zz-pbprobe-b1', 'done']);
    assert.equal(s.code, 1);
    const row = await one(`SELECT state, note FROM agentic_os.lane WHERE id='zz-pbprobe-b1'`);
    assert.equal(row.state, 'ready');
    assert.equal(row.note, null);
  });

  it('note on an own-board lane works', async () => {
    const r = lane(state.dirs.A, SA, ['note', 'zz-pbprobe-a1', 'status one']);
    assert.equal(r.code, 0, r.all);
    assert.equal((await one(`SELECT note FROM agentic_os.lane WHERE id='zz-pbprobe-a1'`)).note, 'status one');
  });
});

describe('add and seed', () => {
  it('add of the other board id errors "belongs to board" and leaves the row unchanged', async () => {
    const before = await one(`SELECT title, track, priority, project_key FROM agentic_os.lane WHERE id='zz-pbprobe-b1'`);
    const r = lane(state.dirs.A, SA, ['add', 'zz-pbprobe-b1', '--title', 'hijacked', '--track', 'evil', '--priority', '1']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /lane id 'zz-pbprobe-b1' belongs to board 'pb-b'/);
    assert.deepEqual(await one(`SELECT title, track, priority, project_key FROM agentic_os.lane WHERE id='zz-pbprobe-b1'`), before);
  });

  it('add on the own board inserts with the board key and upserts on a repeat', async () => {
    const r = lane(state.dirs.A, SA, ['add', 'zz-pbprobe-a2', '--title', 'first']);
    assert.equal(r.code, 0, r.all);
    const r2 = lane(state.dirs.A, SA, ['add', 'zz-pbprobe-a2', '--title', 'second']);
    assert.equal(r2.code, 0, r2.all);
    const row = await one(`SELECT title, project_key FROM agentic_os.lane WHERE id='zz-pbprobe-a2'`);
    assert.deepEqual(row, { title: 'second', project_key: 'pb-a' });
  });

  it('add rejects ids that break ^[a-z0-9][a-z0-9-]*$', async () => {
    for (const bad of ['Bad_Id', '-lead', 'has space', 'a@b', 'UPPER']) {
      const r = lane(state.dirs.A, SA, ['add', bad, '--title', 'x']);
      assert.equal(r.code, 1, `${bad}: ${r.all}`);
      assert.match(r.err, /lane id/);
    }
    assert.equal((await one(`SELECT count(*)::int AS n FROM agentic_os.lane WHERE id IN ('Bad_Id','-lead','UPPER')`)).n, 0);
  });

  it('seed inserts on the resolved board and refuses a foreign id', async () => {
    const f = path.join(state.tmp, 'seed.json');
    fs.writeFileSync(f, JSON.stringify([{ id: 'zz-pbprobe-a3', title: 'seeded' }]));
    const ok = lane(state.dirs.A, SA, ['seed', f]);
    assert.equal(ok.code, 0, ok.all);
    assert.equal((await one(`SELECT project_key FROM agentic_os.lane WHERE id='zz-pbprobe-a3'`)).project_key, 'pb-a');
    fs.writeFileSync(f, JSON.stringify([{ id: 'zz-pbprobe-b1', title: 'hijack' }]));
    const bad = lane(state.dirs.A, SA, ['seed', f]);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /belongs to board 'pb-b'/);
    assert.equal((await one(`SELECT title FROM agentic_os.lane WHERE id='zz-pbprobe-b1'`)).title, 'title of zz-pbprobe-b1');
  });

  it('seed refuses an item whose own project differs from the resolved board, and writes nothing', async () => {
    const f = path.join(state.tmp, 'seed2.json');
    fs.writeFileSync(f, JSON.stringify([{ id: 'zz-pbprobe-a4', title: 'ok item' }, { id: 'zz-pbprobe-a5', title: 'x', project: 'pb-b' }]));
    const r = lane(state.dirs.A, SA, ['seed', f]);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /project 'pb-b'.*board 'pb-a'|board 'pb-a'.*pb-b/);
    assert.equal((await one(`SELECT count(*)::int AS n FROM agentic_os.lane WHERE id IN ('zz-pbprobe-a4','zz-pbprobe-a5')`)).n, 0);
  });
});

describe('messages: broadcast per board, DM across boards, cursors', () => {
  const inboxRows = async (sid) => (await q(`SELECT session_id FROM agentic_os.lane_watermark WHERE session_id LIKE $1 ORDER BY 1`, [`${sid}%`])).rows.map((r) => r.session_id);

  it('a broadcast on A is absent from the inbox on B', async () => {
    const s = lane(state.dirs.A, SA, ['say', 'bcast-A']);
    assert.equal(s.code, 0, s.all);
    assert.match(s.out, /sent to board pb-a/);
    const ev = await one(`SELECT project_key, to_session_id FROM agentic_os.lane_event WHERE body='bcast-A'`);
    assert.deepEqual(ev, { project_key: 'pb-a', to_session_id: null });
    const b = lane(state.dirs.B, SB, ['inbox', '--peek']);
    assert.equal(b.code, 0, b.all);
    assert.match(b.out, /inbox empty/);
    assert.doesNotMatch(b.out, /bcast-A/);
  });

  it('a DM crosses boards, is tagged, and --peek writes no cursor', async () => {
    const s = lane(state.dirs.A, SA, ['say', 'dm-1', '--to', SB]);
    assert.equal(s.code, 0, s.all);
    const peek = lane(state.dirs.B, SB, ['inbox', '--peek']);
    assert.match(peek.out, /dm-1/);
    assert.match(peek.out, /\[from pb-a\]/);
    assert.deepEqual(await inboxRows(SB), []);
  });

  it('reading on B writes the <id>@pb-b row, never the bare id', async () => {
    const r = lane(state.dirs.B, SB, ['inbox']);
    assert.match(r.out, /dm-1/);
    assert.deepEqual(await inboxRows(SB), [`${SB}@pb-b`]);
  });

  it('the same DM is not shown again on A (T4), but the A broadcast is', async () => {
    const r = lane(state.dirs.A, SB, ['inbox']);
    assert.equal(r.code, 0, r.all);
    assert.doesNotMatch(r.out, /dm-1/);
    assert.match(r.out, /bcast-A/);
    assert.deepEqual(await inboxRows(SB), [`${SB}@pb-a`, `${SB}@pb-b`]);
  });

  it('a DM read first on A is not shown on B', () => {
    lane(state.dirs.A, SA, ['say', 'dm-2', '--to', SB]);
    const onA = lane(state.dirs.A, SB, ['inbox']);
    assert.equal(onA.code, 0, onA.all);
    assert.match(onA.out, /dm-2/);
    const onB = lane(state.dirs.B, SB, ['inbox']);
    assert.equal(onB.code, 0, onB.all);
    assert.doesNotMatch(onB.out, /dm-2/);
    assert.match(onB.out, /inbox empty/);
  });

  it('the continuous-claude board keeps the bare session id as its cursor key', async () => {
    const s = lane(state.dirs.C, SA, ['say', 'bcast-C']);
    assert.match(s.out, /sent to board continuous-claude/);
    const r = lane(state.dirs.C, SB, ['inbox']);
    assert.match(r.out, /bcast-C/);
    assert.ok((await inboxRows(SB)).includes(SB), 'bare row missing');
  });

  it('own events are never shown', () => {
    const r = lane(state.dirs.A, SA, ['inbox', '--peek']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /inbox empty|-> /);
    assert.doesNotMatch(r.out, /bcast-A\b/);
  });

  it('the unread count on board uses the same cursor rules', () => {
    lane(state.dirs.A, SA, ['say', 'bcast-A2']);
    const b = lane(state.dirs.A, SB, ['board']);
    assert.match(b.out, /1 unread/);
    const other = lane(state.dirs.B, SB, ['board']);
    assert.match(other.out, /inbox empty/);
  });

  it('--to <name> prefers the session on this board; name@board picks the other; no match asks for name@board', async () => {
    const same = lane(state.dirs.A, SA, ['say', 'to-twin-A', '--to', 'pb-twin']);
    assert.equal(same.code, 0, same.all);
    assert.equal((await one(`SELECT to_session_id FROM agentic_os.lane_event WHERE body='to-twin-A'`)).to_session_id, TWIN1);
    const other = lane(state.dirs.A, SA, ['say', 'to-twin-B', '--to', 'pb-twin@pb-b']);
    assert.equal(other.code, 0, other.all);
    assert.equal((await one(`SELECT to_session_id FROM agentic_os.lane_event WHERE body='to-twin-B'`)).to_session_id, TWIN2);
    const amb = lane(state.dirs.C, SA, ['say', 'to-twin-C', '--to', 'pb-twin']);
    assert.equal(amb.code, 1, amb.all);
    assert.match(amb.err, /name@board/);
  });
});

describe('a name that matches two sessions', () => {
  it('owning a lane on this board does not make a session the preferred one (only its project root does)', async () => {
    const t3 = randomUUID();
    const t4 = randomUUID();
    for (const t of [t3, t4]) {
      fs.writeFileSync(path.join(state.idDir, `${t}.json`), JSON.stringify({ uuid: t, name: 'pb-lanetwin', updatedAt: new Date().toISOString() }));
      await q(`INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES ($1,'c:/elsewhere',NULL, now())`, [t]);
    }
    await q(`INSERT INTO agentic_os.lane (id,title,track,state,project_key,owner_session_id,lease_expires_at)
             VALUES ('zz-pbprobe-lt1','held','zz','active','pb-a',$1, now() + interval '30 minutes')`, [t3]);
    const r = lane(state.dirs.A, SA, ['say', 'who', '--to', 'pb-lanetwin']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /names 2 live sessions/);
    assert.match(r.err, /name@board/);
  });
});

describe('board header: active (5 min) and open, quiet', () => {
  // Same three quiet sessions as render-board.test.mjs: 30 min, 3 h, and 5 h with an open lane. Board C has no other session.
  const QUIET = ['zz-pbprobe-q30', 'zz-pbprobe-q3h', 'zz-pbprobe-qhold', 'zz-pbprobe-qend'];
  it('counts a session seen 30 min ago and a quiet lane holder, not one seen 3 h ago; the JSON carries the same number', async () => {
    const root = normalizeRoot(state.dirs.C);
    try {
      for (const [id, ago] of [[QUIET[0], '30 minutes'], [QUIET[1], '3 hours'], [QUIET[2], '5 hours'], [QUIET[3], '20 minutes']]) {
        await q(`INSERT INTO sessions (id, project, working_on, last_heartbeat, last_activity_at)
                 VALUES ($1,$2,'fixture quiet', now() - $3::interval, now() - $3::interval)`, [id, root, ago]);
      }
      await q(`INSERT INTO agentic_os.lane (id,title,track,state,project_key,owner_session_id,lease_expires_at)
               VALUES ('zz-pbprobe-qlane','held by a sleeper','zz','backlog','continuous-claude',$1,now() + interval '30 minutes')`, [QUIET[2]]);
      // An ended session that still holds an open lane is not open.
      await q(`UPDATE sessions SET ended_at = now() - interval '10 minutes' WHERE id = $1`, [QUIET[3]]);
      await q(`INSERT INTO agentic_os.lane (id,title,track,state,project_key,owner_session_id,lease_expires_at)
               VALUES ('zz-pbprobe-qlane2','held by an ended session','zz','backlog','continuous-claude',$1,now() - interval '5 minutes')`, [QUIET[3]]);
      const text = lane(state.dirs.C, SA, ['board']);
      assert.equal(text.code, 0, text.all);
      assert.match(text.out, /0 active \(5 min\), 2 open, quiet/);
      assert.doesNotMatch(text.out, /live session/);
      const json = lane(state.dirs.C, SA, ['board', '--json']);
      assert.equal(JSON.parse(json.out).quiet, 2);
      // Another board does not see them.
      assert.equal(JSON.parse(lane(state.dirs.B, SB, ['board', '--json']).out).quiet, 0);
    } finally {
      await q(`DELETE FROM agentic_os.lane WHERE id = ANY($1)`, [['zz-pbprobe-qlane', 'zz-pbprobe-qlane2']]).catch(() => {});
      await q(`DELETE FROM sessions WHERE id = ANY($1)`, [QUIET]).catch(() => {});
    }
  });
});

describe('peers', () => {
  const peerIds = (r) => JSON.parse(r.out).map((p) => p.id);

  it('lists sessions under the board root or owning a lane on it, not the others', () => {
    const r = lane(state.dirs.A, SA, ['peers', '--json']);
    assert.equal(r.code, 0, r.all);
    const ids = peerIds(r);
    assert.ok(ids.includes(SA), 'session under root');
    assert.ok(ids.includes(SD), 'session elsewhere that owns a lane on this board (T7)');
    assert.ok(!ids.includes(SB), 'session on board B');
  });

  it('--all lists every live session', () => {
    const ids = peerIds(lane(state.dirs.A, SA, ['peers', '--json', '--all']));
    for (const s of [SA, SB, SD]) assert.ok(ids.includes(s), s);
  });
});

describe('mine, whoami, renew stay keyed on the owner and show the board', () => {
  it('mine works from a directory with no board and prints the board', () => {
    const r = lane(state.dirs.N, SA, ['mine']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /zz-pbprobe-a1/);
    assert.match(r.out, /pb-a/);
  });

  it('whoami lists the board of each lane', () => {
    const r = lane(state.dirs.N, SA, ['whoami']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /zz-pbprobe-a1.*pb-a/);
  });

  it('renew pushes the lease of a lane on another board', async () => {
    await q(`UPDATE agentic_os.lane SET lease_expires_at = now() + interval '1 minute' WHERE id='zz-pbprobe-d1'`);
    const r = lane(state.dirs.B, SD, ['renew']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /zz-pbprobe-d1/);
    assert.match(r.out, /pb-a/);
    const row = await one(`SELECT extract(epoch FROM lease_expires_at - now())::int AS s FROM agentic_os.lane WHERE id='zz-pbprobe-d1'`);
    assert.ok(row.s > 60 * 60, `lease only ${row.s}s`);
  });
});

describe('adopt moves lanes, DMs and every cursor row across boards', () => {
  // Distinct cursor values on purpose (offsets from the highest event id now): a copy that mixed up the
  // bare row and the @board row, or compared the DM against the wrong cursor, would show a wrong number.
  const idFile = (u, o) => fs.writeFileSync(path.join(state.idDir, `${u}.json`), JSON.stringify({ uuid: u, name: 'pb-adopt', updatedAt: new Date().toISOString(), ...o }));
  const pair = async () => {
    const oldId = randomUUID();
    const newId = randomUUID();
    idFile(oldId, { endedAt: new Date().toISOString(), endReason: 'clear' });
    idFile(newId, { previous: oldId });
    await q(`INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES ($1,'x',NULL, now() - interval '1 hour'), ($2,'x',NULL, now())`, [oldId, newId]);
    return { oldId, newId };
  };
  const heldOnB = (id, owner) => q(`INSERT INTO agentic_os.lane (id,title,track,state,project_key,owner_session_id,lease_expires_at)
    VALUES ($1,'held on B','zz','active','pb-b',$2, now() + interval '30 minutes')`, [id, owner]);
  /** The highest event id now; explicit ids go above it and the sequence is moved past them. */
  const baseId = async () => Number((await one(`SELECT COALESCE(max(id),0) AS n FROM agentic_os.lane_event`)).n);
  const reserve = (hi) => q(`SELECT setval(pg_get_serial_sequence('agentic_os.lane_event','id'), $1::bigint)`, [hi]);
  const dm = (id, to, body) => q(`INSERT INTO agentic_os.lane_event (id,kind,session_id,to_session_id,body,project_key) VALUES ($1,'note',$2,$3,$4,'pb-a')`, [id, SA, to, body]);
  const wm = async (sid) => (await q(`SELECT session_id, last_event_id::int AS n FROM agentic_os.lane_watermark WHERE session_id = $1 OR starts_with(session_id, $1 || '@') ORDER BY 1`, [sid])).rows;

  it('carries <old>=10 and <old>@pb-b=100 to the new id, moves the foreign-board lane, and leaves a DM at 50 (below the old cursor) where it is', async () => {
    const { oldId, newId } = await pair();
    await heldOnB('zz-pbprobe-ad1', oldId);
    const base = await baseId();
    await reserve(base + 200);
    await q(`INSERT INTO agentic_os.lane_watermark (session_id,last_event_id) VALUES ($1,$3),($2,$4)`, [oldId, `${oldId}@pb-b`, base + 10, base + 100]);
    await dm(base + 50, oldId, 'adopt-dm-old');

    const r = lane(state.dirs.N, newId, ['adopt', '--from', oldId, '--project', 'pb-a']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /1 lane/);
    assert.match(r.out, /0 message/);
    assert.match(r.out, /cursor carried/);
    assert.equal((await one(`SELECT owner_session_id FROM agentic_os.lane WHERE id='zz-pbprobe-ad1'`)).owner_session_id, newId);
    assert.equal((await one(`SELECT to_session_id FROM agentic_os.lane_event WHERE body='adopt-dm-old'`)).to_session_id, oldId, 'the DM is older than the old cursor: it was already read and must stay');
    assert.deepEqual(await wm(newId), [
      { session_id: newId, n: base + 10 },
      { session_id: `${newId}@pb-b`, n: base + 100 },
    ].sort((a, b) => a.session_id.localeCompare(b.session_id)));
    assert.match(lane(state.dirs.N, newId, ['adopt', '--from', oldId, '--project', 'pb-a']).out, /nothing to move/);
  });

  it('moves a DM above the old cursor (id 50 over cursor 20) to the new id and carries both cursor rows', async () => {
    const { oldId, newId } = await pair();
    const base = await baseId();
    await reserve(base + 200);
    await q(`INSERT INTO agentic_os.lane_watermark (session_id,last_event_id) VALUES ($1,$3),($2,$4)`, [oldId, `${oldId}@pb-b`, base + 10, base + 20]);
    await dm(base + 50, oldId, 'adopt-dm-new');
    const r = lane(state.dirs.N, newId, ['adopt', '--from', oldId, '--project', 'pb-a']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /1 message/);
    assert.equal((await one(`SELECT to_session_id FROM agentic_os.lane_event WHERE body='adopt-dm-new'`)).to_session_id, newId);
    assert.deepEqual((await wm(newId)).map((x) => x.n), [base + 10, base + 20]);
  });

  it('steps the new cursor back when it already read past a moved DM: new bare 80 and new@pb-b 90 become 49, a row at 20 stays', async () => {
    const { oldId, newId } = await pair();
    const base = await baseId();
    await reserve(base + 200);
    await q(`INSERT INTO agentic_os.lane_watermark (session_id,last_event_id) VALUES ($1,$4),($2,$5),($3,$6)`,
      [oldId, newId, `${newId}@pb-b`, base + 10, base + 80, base + 90]);
    await q(`INSERT INTO agentic_os.lane_watermark (session_id,last_event_id) VALUES ($1,$2)`, [`${newId}@pb-a`, base + 20]);
    await dm(base + 50, oldId, 'adopt-dm-stepback');
    const r = lane(state.dirs.N, newId, ['adopt', '--from', oldId, '--project', 'pb-a']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /1 message/);
    assert.match(r.out, /cursor stepped back/);
    assert.equal((await one(`SELECT to_session_id FROM agentic_os.lane_event WHERE body='adopt-dm-stepback'`)).to_session_id, newId);
    const got = Object.fromEntries((await wm(newId)).map((x) => [x.session_id, x.n]));
    assert.deepEqual(got, { [newId]: base + 49, [`${newId}@pb-b`]: base + 49, [`${newId}@pb-a`]: base + 20 });
  });

  it('LOW: a board that cannot be resolved is found BEFORE the move, so a failed adopt moves nothing', async () => {
    const { oldId, newId } = await pair();
    await heldOnB('zz-pbprobe-ad2', oldId);
    const r = lane(state.dirs.N, newId, ['adopt', '--from', oldId], { LANE_PROJECT: 'no-such-board' });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /unknown board 'no-such-board'/);
    assert.equal((await one(`SELECT owner_session_id FROM agentic_os.lane WHERE id='zz-pbprobe-ad2'`)).owner_session_id, oldId, 'the lane moved although the command failed');
  });

  it('adopt from a directory with no board still works and writes its audit event on continuous-claude', async () => {
    const { oldId, newId } = await pair();
    await heldOnB('zz-pbprobe-ad3', oldId);
    const r = lane(state.dirs.N, newId, ['adopt', '--from', oldId]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /adopted from .*1 lane/);
    assert.equal((await one(`SELECT project_key FROM agentic_os.lane_event WHERE kind='note' AND to_session_id=$1 AND detail->>'adopted'='true'`, [newId])).project_key, 'continuous-claude');
  });
});

describe('M1: owner-keyed verbs from a directory with no board', () => {
  const held = (id, owner = SD) => q(`INSERT INTO agentic_os.lane (id,title,track,state,project_key,owner_session_id,lease_expires_at)
    VALUES ($1,'owned on A','zz','active','pb-a',$2, now() + interval '30 minutes')`, [id, owner]);

  it('note, state, release and done work for the owner and log on the lane board', async () => {
    for (const id of ['zz-pbprobe-o1', 'zz-pbprobe-o2', 'zz-pbprobe-o3', 'zz-pbprobe-o4']) await held(id);
    const note = lane(state.dirs.N, SD, ['note', 'zz-pbprobe-o1', 'from-nowhere']);
    assert.equal(note.code, 0, note.all);
    assert.match(note.out, /noted on zz-pbprobe-o1/);
    const st = lane(state.dirs.N, SD, ['state', 'zz-pbprobe-o4', 'review']);
    assert.equal(st.code, 0, st.all);
    assert.match(st.out, /zz-pbprobe-o4 -> review/);
    const rel = lane(state.dirs.N, SD, ['release', 'zz-pbprobe-o2']);
    assert.equal(rel.code, 0, rel.all);
    assert.match(rel.out, /-> ready \(released\)/);
    const done = lane(state.dirs.N, SD, ['done', 'zz-pbprobe-o3', '--note', 'finished']);
    assert.equal(done.code, 0, done.all);
    assert.match(done.out, /-> done \(released\)/);
    assert.equal((await one(`SELECT state, owner_session_id FROM agentic_os.lane WHERE id='zz-pbprobe-o3'`)).state, 'done');
    const evs = (await q(`SELECT lane_id, project_key FROM agentic_os.lane_event WHERE lane_id LIKE 'zz-pbprobe-o_' AND session_id=$1 ORDER BY lane_id`, [SD])).rows;
    assert.deepEqual(evs.map((e) => e.lane_id), ['zz-pbprobe-o1', 'zz-pbprobe-o2', 'zz-pbprobe-o3', 'zz-pbprobe-o4']);
    assert.ok(evs.every((e) => e.project_key === 'pb-a'), JSON.stringify(evs));
  });

  it('a session that does NOT own the lane still gets the hint, and the lane is unchanged', async () => {
    await held('zz-pbprobe-o5');
    const r = lane(state.dirs.N, SA, ['note', 'zz-pbprobe-o5', 'not mine']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /no lane board for /);
    assert.match(r.err, /--project continuous-claude/);
    assert.equal((await one(`SELECT note FROM agentic_os.lane WHERE id='zz-pbprobe-o5'`)).note, null);
    const s = lane(state.dirs.N, SA, ['done', 'zz-pbprobe-o5']);
    assert.equal(s.code, 1, s.all);
    assert.equal((await one(`SELECT state FROM agentic_os.lane WHERE id='zz-pbprobe-o5'`)).state, 'active');
  });

  it('an explicit --project still wins over the owner lookup (a lane of another board is refused)', () => {
    const r = lane(state.dirs.N, SD, ['note', 'zz-pbprobe-o5', 'wrong board', '--project', 'pb-b']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /no lane zz-pbprobe-o5 on board pb-b/);
  });
});

describe('say --lane names a lane of this board only', () => {
  it('a lane id from another board is refused and nothing is sent', async () => {
    const r = lane(state.dirs.A, SA, ['say', 'tagged-foreign', '--lane', 'zz-pbprobe-b1']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /no lane zz-pbprobe-b1 on board pb-a/);
    assert.equal((await q(`SELECT 1 FROM agentic_os.lane_event WHERE body='tagged-foreign'`)).rowCount, 0);
  });

  it('a lane id of this board is tagged', async () => {
    const r = lane(state.dirs.A, SA, ['say', 'tagged-own', '--lane', 'zz-pbprobe-a1']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /re zz-pbprobe-a1/);
    assert.equal((await one(`SELECT lane_id FROM agentic_os.lane_event WHERE body='tagged-own'`)).lane_id, 'zz-pbprobe-a1');
  });
});

describe('peers: sessions.project in odd spellings still folds to the board root', () => {
  it('doubled slashes, capitals and the extended-length prefix all match; a lookalike root does not', async () => {
    const root = normalizeRoot(state.dirs.A);
    const spell = {
      'zz-pbprobe-sp-dbl': `${root.toUpperCase().replace(/\//g, '//')}//deep//`,
      'zz-pbprobe-sp-ext': `\\\\?\\${root.replace(/\//g, '\\').toUpperCase()}`,
      'zz-pbprobe-sp-bad': `${root}x//deep`,
    };
    for (const [id, project] of Object.entries(spell)) {
      await q(`INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES ($1,$2,'fixture',now())`, [id, project]);
    }
    const r = lane(state.dirs.A, SA, ['peers', '--json']);
    assert.equal(r.code, 0, r.all);
    const ids = JSON.parse(r.out).map((p) => p.id);
    assert.ok(ids.includes('zz-pbprobe-sp-dbl'), 'doubled slashes');
    assert.ok(ids.includes('zz-pbprobe-sp-ext'), 'extended-length prefix');
    assert.ok(!ids.includes('zz-pbprobe-sp-bad'), 'a root that only starts with the same letters is another project');
  });
});

describe('item 1: a database without migration 0004 fails first, loud, and writes nothing', () => {
  const noMig = (cwd, as, args) => lane(cwd, as, args, { CONTINUOUS_CLAUDE_DB_URL: state.url3, DATABASE_URL: state.url3, OPC_POSTGRES_URL: state.url3 });

  it('every verb that opens the database exits 1 with the one clear message', () => {
    const verbs = [['mine'], ['renew'], ['whoami'], ['board'], ['peers'], ['next'], ['inbox'], ['say', 'hi'], ['note', 'x', 'y'],
      ['claim', 'x'], ['add', 'x', '--title', 't'], ['adopt', '--from', randomUUID()], ['project', 'unregister', 'nope']];
    for (const args of verbs) {
      const r = noMig(state.dirs.A, SA, args);
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.all}`);
      assert.match(r.err, /migration 0004 is not applied to this database/, args.join(' '));
      assert.doesNotMatch(r.all, /undefined/, args.join(' '));
    }
  });

  it('adopt moves nothing: the lanes of the old session stay with it', async () => {
    const c3 = new Client({ connectionString: state.url3 });
    await c3.connect();
    const oldId = randomUUID();
    const newId = randomUUID();
    try {
      for (const [u, o] of [[oldId, { endedAt: new Date().toISOString() }], [newId, { previous: oldId }]]) {
        fs.writeFileSync(path.join(state.idDir, `${u}.json`), JSON.stringify({ uuid: u, name: 'pb-nomig', updatedAt: new Date().toISOString(), ...o }));
      }
      await c3.query(`INSERT INTO agentic_os.lane (id,title,track,state,owner_session_id,lease_expires_at)
                      VALUES ('zz-nomig-1','x','zz','active',$1, now() + interval '30 minutes')`, [oldId]);
      const r = noMig(state.dirs.A, newId, ['adopt', '--from', oldId]);
      assert.equal(r.code, 1, r.all);
      assert.match(r.err, /migration 0004 is not applied/);
      assert.equal((await c3.query(`SELECT owner_session_id FROM agentic_os.lane WHERE id='zz-nomig-1'`)).rows[0].owner_session_id, oldId);
    } finally { await c3.end(); }
  });

  it('project which needs no database: it answers with an unreachable URL', () => {
    const dead = 'postgresql://claude:x@127.0.0.1:1/lanes_pr1_unreachable';
    const r = lane(state.dirs.A, SA, ['project', 'which'], { CONTINUOUS_CLAUDE_DB_URL: dead, DATABASE_URL: dead, OPC_POSTGRES_URL: dead });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /board: pb-a/);
  });
});

describe('apply-kanban', () => {
  const kanban = (extra) => {
    const f = path.join(state.tmp, `k-${Math.random().toString(36).slice(2)}.json`);
    const now = new Date().toISOString();
    fs.writeFileSync(f, JSON.stringify({
      board: { columns: { now: ['zz-pbprobe-a2', 'zz-pbprobe-b1'], next: [], later: [], waiting: [] }, updatedAt: now },
      cards: [], readAt: now, ...extra,
    }));
    return f;
  };

  it('a file for another board is refused', () => {
    const r = lane(state.dirs.A, SA, ['apply-kanban', kanban({ project: 'pb-b' }), '--dry-run']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /board 'pb-b'.*board 'pb-a'|pb-b.*pb-a/);
  });

  it('plans only the lanes of the resolved board', () => {
    const r = lane(state.dirs.A, SA, ['apply-kanban', kanban({ project: 'pb-a' }), '--dry-run', '--json']);
    assert.equal(r.code, 0, r.all);
    const plan = JSON.parse(r.out);
    const ids = new Set(plan.actions.map((a) => a.laneId));
    assert.ok(ids.has('zz-pbprobe-a2'), [...ids].join());
    assert.ok(!ids.has('zz-pbprobe-b1'));
  });

  // Lane board per board (PR C): a file that does not say its board could be another board's page db. A non-default
  // board refuses it. The default board keeps today's behaviour so old input files still work.
  it('a file that declares no board is refused on a non-default board, names the key and the fix, and writes nothing', async () => {
    const before = await one(`SELECT priority FROM agentic_os.lane WHERE id='zz-pbprobe-a1'`);
    const dry = lane(state.dirs.A, SA, ['apply-kanban', kanban({}), '--dry-run']);
    assert.equal(dry.code, 1, dry.all);
    assert.match(dry.err, /does not declare its board/);
    assert.match(dry.err, /pb-a/);
    assert.match(dry.err, /"project"/);
    const real = lane(state.dirs.A, SA, ['apply-kanban', kanban({})]);
    assert.equal(real.code, 1, real.all);
    assert.deepEqual(await one(`SELECT priority FROM agentic_os.lane WHERE id='zz-pbprobe-a1'`), before);
  });

  it('every declaration form the planner accepts still passes on a non-default board', () => {
    for (const extra of [{ project: 'pb-a' }, { board: 'pb-a', cards: [{ id: 'zz-pbprobe-a1', status: 'ready', updatedAt: new Date().toISOString() }] }, { board: { columns: { now: [], next: [], later: [], waiting: [] }, updatedAt: new Date().toISOString(), project: 'pb-a' } }]) {
      const r = lane(state.dirs.A, SA, ['apply-kanban', kanban(extra), '--dry-run']);
      assert.equal(r.code, 0, `${JSON.stringify(Object.keys(extra))}: ${r.all}`);
    }
  });

  it('the default board still takes a file with no declaration (old input files keep working)', () => {
    const r = lane(state.dirs.C, SA, ['apply-kanban', kanban({}), '--dry-run']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /dry run/);
  });

  it('a real apply does not touch the other board lane', async () => {
    const before = await one(`SELECT priority FROM agentic_os.lane WHERE id='zz-pbprobe-b1'`);
    const r = lane(state.dirs.A, SA, ['apply-kanban', kanban({ project: 'pb-a' })]);
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(await one(`SELECT priority FROM agentic_os.lane WHERE id='zz-pbprobe-b1'`), before);
    assert.equal((await one(`SELECT priority FROM agentic_os.lane WHERE id='zz-pbprobe-a2'`)).priority, 1);
  });
});

describe('the migration fence and the missing migration', () => {
  it('an old-style client (no lane.client_version) is refused on a foreign lane and allowed on a continuous-claude lane', async () => {
    const old = new Client({ connectionString: state.url });
    await old.connect();
    try {
      await assert.rejects(
        old.query(`UPDATE agentic_os.lane SET note='old writer' WHERE id='zz-pbprobe-b1'`),
        (e) => e.code === '42501' && /predates per-project boards/.test(e.message),
      );
      await assert.rejects(old.query(`DELETE FROM agentic_os.lane WHERE id='zz-pbprobe-b1'`), (e) => e.code === '42501');
      const ok = await old.query(`UPDATE agentic_os.lane SET note='old writer' WHERE id='zz-pbprobe-c1'`);
      assert.equal(ok.rowCount, 1);
      await old.query(`SELECT set_config('lane.client_version','2',false)`);
      assert.equal((await old.query(`UPDATE agentic_os.lane SET note='new writer' WHERE id='zz-pbprobe-b1'`)).rowCount, 1);
    } finally { await old.end(); }
  });

  // The last commit before per-project boards. Pinned, not `main`: once PR1 merges, main's lane.mjs is the new one.
  const OLD_COMMIT = 'ec0417fe';

  it('T3: a REAL old lane.mjs is refused (42501, with the rebase hint) on a foreign-board lane and still claims a continuous-claude lane', async (t) => {
    const oldDir = fs.mkdtempSync(path.join(state.tmp, 'oldlane-'));
    const dest = path.join(oldDir, 'scripts', 'coordination');
    fs.mkdirSync(dest, { recursive: true });
    try {
      // Every relative module the old lane.mjs imports, taken from git, so the copy is the real old program.
      const queue = ['lane.mjs'];
      const seen = new Set();
      while (queue.length) {
        const f = queue.pop();
        if (seen.has(f)) continue;
        seen.add(f);
        const text = execFileSync('git', ['-C', REPO, 'show', `${OLD_COMMIT}:scripts/coordination/${f}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        fs.writeFileSync(path.join(dest, f), text);
        for (const m of text.matchAll(/from '\.\/([\w.-]+\.mjs)'/g)) queue.push(m[1]);
      }
    } catch (e) {
      t.skip(`cannot read ${OLD_COMMIT} from git (shallow clone?): ${e.message.split('\n')[0]}`);
      return;
    }
    assert.ok(['lane.mjs', 'kanban-apply.mjs', 'session-label.mjs'].every((f) => fs.existsSync(path.join(dest, f))), 'the old program and its modules were copied');
    assert.doesNotMatch(fs.readFileSync(path.join(dest, 'lane.mjs'), 'utf8'), /client_version/, 'this is not the old program');
    assertScratchUrl(state.url);
    const old = (args) => {
      const r = spawnSync(process.execPath, [path.join(dest, 'lane.mjs'), ...args], {
        cwd: oldDir, encoding: 'utf8',
        env: {
          ...baseEnv(), CLAUDE_CODE_SESSION_ID: SA,
          // The old file looks for `pg` beside itself; it is not in the temp folder.
          NODE_PATH: path.join(REPO, '.claude', 'hooks', 'node_modules'),
        },
      });
      return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
    };
    const before = await one(`SELECT title, note, owner_session_id, state FROM agentic_os.lane WHERE id='zz-pbprobe-b1'`);
    const claim = old(['claim', 'zz-pbprobe-b1']);
    assert.equal(claim.code, 1, claim.all);
    assert.match(claim.err, /lane zz-pbprobe-b1 belongs to board pb-b: this lane\.mjs predates per-project boards; rebase the worktree onto main/);
    const add = old(['add', 'zz-pbprobe-b1', '--title', 'old copy overwrite']);
    assert.equal(add.code, 1, add.all);
    assert.match(add.err, /predates per-project boards/);
    assert.deepEqual(await one(`SELECT title, note, owner_session_id, state FROM agentic_os.lane WHERE id='zz-pbprobe-b1'`), before, 'the foreign lane changed');
    const own = old(['claim', 'zz-pbprobe-c1']);
    assert.equal(own.code, 0, own.all);
    assert.match(own.out, /CLAIMED zz-pbprobe-c1/);
    assert.equal((await one(`SELECT owner_session_id FROM agentic_os.lane WHERE id='zz-pbprobe-c1'`)).owner_session_id, SA);
  });

  it('a database without migration 0004 gets a clear message and exit 1', () => {
    const r = lane(state.dirs.A, SA, ['board'], { CONTINUOUS_CLAUDE_DB_URL: state.url3, DATABASE_URL: state.url3, OPC_POSTGRES_URL: state.url3 });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /migration 0004 is not applied to this database/);
  });
});

describe('project which / register / unregister', () => {
  const R = () => path.join(state.cacheRoot, 'repo-registry.json');
  const ACT = () => path.join(state.cacheRoot, 'active-registry.json');
  const dir = (n) => { const d = path.join(state.cacheRoot, n); fs.mkdirSync(d, { recursive: true }); return d; };
  // LANE_SKIP_HOOK_PRECHECK: the live lane-context hook does not set lane.client_version yet (PR2); tests that are not about that check skip it.
  const regEnv = (extra = {}) => ({ LANE_REGISTRY_REPO: R(), LANE_REGISTRY_ACTIVE: ACT(), LANE_REGISTRY_PATH: R(), LANE_SKIP_HOOK_PRECHECK: '1', ...extra });
  const reg = (args, extra) => lane(state.cacheRoot, SA, ['project', ...args], regEnv(extra));
  const read = (f) => fs.readFileSync(f, 'utf8');
  const entries = () => JSON.parse(read(R())).projects;
  const fwd = (p) => p.replace(/\\/g, '/');
  let P1;

  before(() => {
    const seedEntries = [
      { name: 'old-one', key: 'old-one', path: 'C:/nowhere/old-one', status: 'inactive', stack: ['x', 'y'] },
      { name: 'zeta', key: 'zeta', path: fwd(dir('zeta')), status: 'active', laneBoard: 'zeta' },
      { name: 'continuous-claude', key: 'continuous-claude', path: fwd(dir('ccroot')), status: 'active' },
    ];
    const seed = JSON.stringify({ version: '1.0', projects: seedEntries }, null, 2).replace(/\n/g, '\r\n') + '\r\n';
    fs.writeFileSync(R(), seed);
    fs.writeFileSync(ACT(), seed.replace(/\r\n/g, '\n')); // equal beyond line endings: register may start
    P1 = dir('proj1');
  });

  it('which prints the board, the winning source and the entry; no board is exit 1 with the hint', () => {
    const r = lane(state.dirs.A, SA, ['project', 'which']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /board: pb-a/);
    assert.match(r.out, /source: registry/);
    assert.match(r.out, /entry: pb-a/);
    const none = lane(noBoardDir(), SA, ['project', 'which']);
    assert.equal(none.code, 1);
    assert.match(none.all, /no lane board for .*project register/);
    const flag = lane(state.dirs.N, SA, ['project', 'which', '--project', 'pb-b']);
    assert.match(flag.out, /source: flag/);
  });

  it('register writes both copies byte-identical, keeps CRLF and key order, and upserts the project row', async () => {
    const before = entries();
    const r = reg(['register', P1]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /registered proj1/);
    assert.match(r.out, /commit/i);
    assert.equal(read(R()), read(ACT()), 'copies differ');
    assert.ok(!/(?<!\r)\n/.test(read(R())), 'a bare LF crept in');
    assert.ok(read(R()).endsWith('\r\n'));
    const after = entries();
    assert.deepEqual(after.slice(0, before.length), before);
    assert.deepEqual(after[after.length - 1], { name: 'proj1', key: 'proj1', path: fwd(fs.realpathSync.native(P1)), status: 'active' });
    const row = await one(`SELECT key, display_name, root_path_norm, status, registry_source FROM agentic_os.project WHERE key='proj1'`);
    assert.deepEqual(row, {
      key: 'proj1', display_name: 'proj1', root_path_norm: normalizeRoot(fs.realpathSync.native(P1)),
      status: 'active', registry_source: 'lane.mjs project register',
    });
  });

  it('the new board works at once: add a lane there', async () => {
    const r = lane(P1, SA, ['add', 'zz-pbprobe-p1', '--title', 'on the new board'], regEnv());
    assert.equal(r.code, 0, r.all);
    assert.equal((await one(`SELECT project_key FROM agentic_os.lane WHERE id='zz-pbprobe-p1'`)).project_key, 'proj1');
  });

  it('registering the same key again is refused', () => {
    const r = reg(['register', dir('proj1b'), '--key', 'proj1']);
    assert.equal(r.code, 1);
    assert.match(r.err, /already registered/);
  });

  it('unregister sets inactive in both copies and the row, keeps every lane, and the board goes away', async () => {
    const r = reg(['unregister', 'proj1']);
    assert.equal(r.code, 0, r.all);
    assert.equal(read(R()), read(ACT()));
    assert.equal(entries().find((e) => e.key === 'proj1').status, 'inactive');
    assert.equal((await one(`SELECT status FROM agentic_os.project WHERE key='proj1'`)).status, 'inactive');
    assert.equal((await one(`SELECT count(*)::int AS n FROM agentic_os.lane WHERE project_key='proj1'`)).n, 1);
    const b = lane(P1, SA, ['board'], regEnv());
    assert.equal(b.code, 1);
    assert.match(b.err, /no lane board for/);
  });

  it('register after unregister reactivates the entry (no duplicate) and the lanes come back', async () => {
    const r = reg(['register', P1]);
    assert.equal(r.code, 0, r.all);
    assert.equal(entries().filter((e) => e.key === 'proj1').length, 1);
    assert.equal(entries().find((e) => e.key === 'proj1').status, 'active');
    assert.equal(read(R()), read(ACT()));
    assert.equal((await one(`SELECT status FROM agentic_os.project WHERE key='proj1'`)).status, 'active');
    const b = lane(P1, SA, ['board'], regEnv());
    assert.equal(b.code, 0, b.all);
    assert.match(b.out, /zz-pbprobe-p1/);
  });

  it('unregister of an unknown key is an error', () => {
    const r = reg(['unregister', 'no-such-key']);
    assert.equal(r.code, 1);
    assert.match(r.err, /no registry entry/);
  });

  it('refuses a missing path, a file, the home dir, ~/.claude and the temp dir', () => {
    const home = dir('fakehome');
    const claudeDir = path.join(home, '.claude');
    fs.mkdirSync(path.join(claudeDir, 'sub'), { recursive: true });
    const file = path.join(state.cacheRoot, 'afile.txt');
    fs.writeFileSync(file, 'x');
    const homeEnv = { USERPROFILE: home, HOME: home };
    const tmpChild = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-project-reg-'));
    try {
      const cases = [
        [path.join(state.cacheRoot, 'does-not-exist'), {}, /does not exist/],
        [file, {}, /not a directory/],
        [home, homeEnv, /home/i],
        [claudeDir, homeEnv, /\.claude/],
        [path.join(claudeDir, 'sub'), homeEnv, /\.claude/],
        [tmpChild, {}, /temp/i],
        [os.tmpdir(), {}, /temp/i],
      ];
      for (const [p, env, re] of cases) {
        const r = reg(['register', p], env);
        assert.equal(r.code, 1, `${p}: ${r.all}`);
        assert.match(r.err, re, p);
      }
    } finally { fs.rmSync(tmpChild, { recursive: true, force: true }); }
    assert.equal(entries().some((e) => /fakehome|afile/.test(e.path)), false);
  });

  it('refuses a root that overlaps an existing root unless --board names that board', () => {
    const inner = dir('proj1/inner');
    const refused = reg(['register', inner]);
    assert.equal(refused.code, 1, refused.all);
    assert.match(refused.err, /overlap|inside/i);
    const wrongBoard = reg(['register', inner, '--board', 'zeta']);
    assert.equal(wrongBoard.code, 1, wrongBoard.all);
    const unknownBoard = reg(['register', inner, '--board', 'no-board']);
    assert.equal(unknownBoard.code, 1);
    const ok = reg(['register', inner, '--board', 'proj1']);
    assert.equal(ok.code, 0, ok.all);
    const e = entries().find((x) => x.key === 'inner');
    assert.equal(e.laneBoard, 'proj1');
    const w = lane(inner, SA, ['project', 'which'], regEnv());
    assert.match(w.out, /board: proj1/);
    const parent = reg(['register', state.cacheRoot, '--key', 'bigger']);
    assert.equal(parent.code, 1, 'a root that contains an existing root is refused too');
  });

  const files = () => ({ repo: read(R()), act: read(ACT()) });
  const tmpLeft = () => fs.readdirSync(state.cacheRoot).filter((f) => f.endsWith('.tmp'));

  it('MEDIUM 2: continuous-claude cannot be unregistered, because no path could register it again', () => {
    const before = files();
    const r = reg(['unregister', 'continuous-claude']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /default board/);
    assert.deepEqual(files(), before);
    assert.equal(entries().find((e) => e.key === 'continuous-claude').status, 'active');
  });

  it('MEDIUM 10: unregister of a nested entry says it joined a board and does not report that board\'s lane count', () => {
    const r = reg(['unregister', 'inner']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /unregistered inner/);
    assert.match(r.out, /joined board proj1/);
    assert.doesNotMatch(r.out, /lane row/);
    assert.equal(entries().find((e) => e.key === 'inner').status, 'inactive');
  });

  it('MEDIUM 2: after proj1 is unregistered, registering it again is not blocked by its own nested entry; --board <own key> is accepted and writes no laneBoard', async () => {
    const innerAgain = reg(['register', path.join(P1, 'inner'), '--key', 'inner', '--board', 'proj1']);
    assert.equal(innerAgain.code, 0, innerAgain.all);
    const off = reg(['unregister', 'proj1']);
    assert.equal(off.code, 0, off.all);
    assert.match(off.out, /lane row/, 'the entry that owns the board reports its lanes');
    const on = reg(['register', P1]);
    assert.equal(on.code, 0, on.all);
    const self = reg(['register', P1, '--board', 'proj1']);
    assert.equal(self.code, 0, self.all);
    assert.equal(entries().filter((e) => e.key === 'proj1').length, 1);
    assert.equal('laneBoard' in entries().find((e) => e.key === 'proj1'), false);
    assert.equal(read(R()), read(ACT()));
    assert.equal((await one(`SELECT status FROM agentic_os.project WHERE key='proj1'`)).status, 'active');
  });

  it('MEDIUM 4: registering the same key, path and board again is idempotent and rewrites both copies', () => {
    const a = reg(['register', P1]);
    assert.equal(a.code, 0, a.all);
    const before = read(R());
    const b = reg(['register', P1]);
    assert.equal(b.code, 0, b.all);
    assert.equal(read(R()), before);
    assert.equal(read(R()), read(ACT()));
    assert.deepEqual(tmpLeft(), []);
  });

  it('MEDIUM 3: register and unregister refuse when the repo and live registry copies differ, name both files, and change nothing', () => {
    const repoFile = path.join(state.cacheRoot, 'diff-repo.json');
    const actFile = path.join(state.cacheRoot, 'diff-active.json');
    fs.writeFileSync(repoFile, read(R()));
    fs.writeFileSync(actFile, '{ "projects": [] }\n');
    const env = { LANE_REGISTRY_REPO: repoFile, LANE_REGISTRY_ACTIVE: actFile };
    const before = { repo: read(repoFile), act: read(actFile) };
    for (const args of [['register', dir('proj-diff')], ['unregister', 'zeta']]) {
      const r = reg(args, env);
      assert.equal(r.code, 1, r.all);
      assert.match(r.err, /differ/);
      assert.ok(r.err.includes(fwd(repoFile)) && r.err.includes(fwd(actFile)), r.err);
      assert.deepEqual({ repo: read(repoFile), act: read(actFile) }, before);
    }
    assert.deepEqual(tmpLeft(), []);
  });

  it('MEDIUM 3: the default repo registry is the PRIMARY checkout (CCV3_USER_HOME), never the copy beside the running script; the hint names the primary too', () => {
    const fakeHome = dir('primary-home');
    const fakeUser = dir('live-home');
    const primaryReg = path.join(fakeHome, 'continuous-claude', '.claude', 'project-registry.json');
    const liveReg = path.join(fakeUser, '.claude', 'project-registry.json');
    fs.mkdirSync(path.dirname(primaryReg), { recursive: true });
    fs.mkdirSync(path.dirname(liveReg), { recursive: true });
    fs.writeFileSync(primaryReg, '{\n  "projects": []\n}\n');
    fs.writeFileSync(liveReg, '{\n  "projects": []\n}\n');
    const own = path.join(REPO, '.claude', 'project-registry.json');
    const ownBefore = fs.readFileSync(own);
    const env = { LANE_REGISTRY_REPO: '', LANE_REGISTRY_ACTIVE: '', CCV3_USER_HOME: fakeHome, USERPROFILE: fakeUser, HOME: fakeUser };
    const r = reg(['register', dir('proj-primary')], env);
    assert.equal(r.code, 0, r.all);
    assert.ok(JSON.parse(read(primaryReg)).projects.some((e) => e.key === 'proj-primary'), 'the primary copy was not edited');
    assert.equal(read(primaryReg), read(liveReg));
    assert.deepEqual(fs.readFileSync(own), ownBefore, 'the copy beside the script was edited');
    assert.ok(r.out.includes(fwd(primaryReg)), r.out);
    assert.ok(!r.out.includes(fwd(own)) || fwd(own) === fwd(primaryReg), r.out);
    assert.match(r.out, /This edits the repo registry in the primary checkout \(an uncommitted change on main\) and the live copy\. The next sync removes the live copy unless the change is committed to main\./);
    const hint = lane(noBoardDir(), SA, ['board'], { CCV3_USER_HOME: fakeHome });
    assert.equal(hint.code, 1, hint.all);
    assert.ok(hint.err.includes(`node ${fwd(fakeHome)}/.claude/scripts/lane.mjs project register `), hint.err);
  });

  it('PR 297 F1: a board resolved from a home mirror that differs from the primary repo copy prints one WARNING and still works; equal copies and an explicit LANE_REGISTRY_PATH print none', () => {
    const fakeHome = dir('mirror-primary');
    const fakeUser = dir('mirror-live');
    const repoReg = path.join(fakeHome, 'continuous-claude', '.claude', 'project-registry.json');
    const mirrorReg = path.join(fakeUser, '.claude', 'project-registry.json');
    fs.mkdirSync(path.dirname(repoReg), { recursive: true });
    fs.mkdirSync(path.dirname(mirrorReg), { recursive: true });
    const entryA = (extra = {}) => ({ name: 'pb-a', key: 'pb-a', path: fwd(state.dirs.A), status: 'active', ...extra });
    const put = (f, projects) => fs.writeFileSync(f, JSON.stringify({ version: '1.0', projects }));
    const mirrorEnv = { LANE_REGISTRY_PATH: '', LANE_REGISTRY_REPO: '', LANE_REGISTRY_ACTIVE: '', CCV3_USER_HOME: fakeHome, USERPROFILE: fakeUser, HOME: fakeUser };
    const warnings = (r) => r.err.split(/\r?\n/).filter((l) => /WARNING/.test(l));

    put(repoReg, [entryA({ laneBoard: 'continuous-claude' })]);
    put(mirrorReg, [entryA()]); // the stale mirror: no laneBoard, so the board is 'pb-a'
    const stale = lane(state.dirs.A, SA, ['board', '--json'], mirrorEnv);
    assert.equal(stale.code, 0, stale.all);
    assert.equal(JSON.parse(stale.out).board, 'pb-a', 'the stale mirror still decides the board: the warning does not block');
    assert.equal(warnings(stale).length, 1, stale.err);
    assert.ok(warnings(stale)[0].includes('pb-a: board repo=continuous-claude mirror=pb-a'), stale.err);
    assert.ok(stale.err.includes(fwd(mirrorReg)) && stale.err.includes(fwd(repoReg)), stale.err);

    put(mirrorReg, [entryA({ laneBoard: 'continuous-claude' })]);
    const same = lane(state.dirs.A, SA, ['board', '--json'], mirrorEnv);
    assert.equal(same.code, 0, same.all);
    assert.deepEqual(warnings(same), [], same.err);

    put(mirrorReg, [entryA()]);
    const explicit = lane(state.dirs.A, SA, ['board', '--json'], { ...mirrorEnv, LANE_REGISTRY_PATH: state.registry });
    assert.equal(explicit.code, 0, explicit.all);
    assert.deepEqual(warnings(explicit), [], 'an explicit LANE_REGISTRY_PATH is a deliberate override, not a stale mirror');
  });

  it('MEDIUM 4: a database failure after the files are written restores both copies byte for byte and leaves no temp file, and a retry works', async () => {
    const before = files();
    await q(`ALTER TABLE agentic_os.project RENAME TO project_off`);
    let r;
    try { r = reg(['register', dir('proj-dbfail')]); } finally { await q(`ALTER TABLE agentic_os.project_off RENAME TO project`); }
    assert.equal(r.code, 1, r.all);
    assert.deepEqual(files(), before);
    assert.deepEqual(tmpLeft(), []);
    const retry = reg(['register', dir('proj-dbfail')]);
    assert.equal(retry.code, 0, retry.all);
    assert.equal(read(R()), read(ACT()));
  });

  it('MEDIUM 4: when the second rename fails the repo copy is put back and no temp file stays', { skip: process.platform !== 'win32' && 'a read-only target blocks a rename only on Windows' }, () => {
    const before = files();
    fs.chmodSync(ACT(), 0o444);
    let r;
    try { r = reg(['register', dir('proj-renamefail')]); } finally { fs.chmodSync(ACT(), 0o666); }
    assert.equal(r.code, 1, r.all);
    assert.deepEqual(files(), before);
    assert.deepEqual(tmpLeft(), []);
    assert.equal(entries().some((e) => e.key === 'proj-renamefail'), false);
    const retry = reg(['register', dir('proj-renamefail')]);
    assert.equal(retry.code, 0, retry.all);
  });

  it('M3: a board other than continuous-claude is refused while the live lane-context hook lacks lane.client_version; a joined continuous-claude entry is not', async () => {
    const userHome = dir('hook-home');
    const hookFile = path.join(userHome, '.claude', 'hooks', 'dist', 'lane-context.mjs');
    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    fs.writeFileSync(hookFile, "// an old build\nawait client.query('SELECT 1');\n");
    const env = { USERPROFILE: userHome, HOME: userHome, LANE_SKIP_HOOK_PRECHECK: '' };
    const before = files();
    const refused = reg(['register', dir('proj-hook')], env);
    assert.equal(refused.code, 1, refused.all);
    assert.match(refused.err, /lane\.client_version/);
    assert.match(refused.err, /PR2/);
    assert.deepEqual(files(), before);
    assert.equal((await q(`SELECT 1 FROM agentic_os.project WHERE key='proj-hook'`)).rowCount, 0);
    const joined = reg(['register', dir('ccroot/sub'), '--key', 'ccsub', '--board', 'continuous-claude'], env);
    assert.equal(joined.code, 0, joined.all);
    fs.writeFileSync(hookFile, "await c.query(\"SELECT set_config('lane.client_version', '2', false)\");\n");
    const ok = reg(['register', dir('proj-hook')], env);
    assert.equal(ok.code, 0, ok.all);
    const missing = reg(['register', dir('proj-hook2')], { ...env, USERPROFILE: dir('no-hook-home'), HOME: dir('no-hook-home') });
    assert.equal(missing.code, 1, missing.all);
    assert.match(missing.err, /lane-context\.mjs/);
  });

  // Phone page per board (PR C). register never publishes: it prints one hint for a new owner board, keeps a recorded
  // laneArtifact on re-register (and says so, so a dead url is visible), and unregister says the url stays in the entry.
  describe('phone page hint and laneArtifact', () => {
    const URL_KEPT = 'https://claude.ai/artifact/KeptPage_1-x';
    let pair;
    const lines = (r) => r.out.split(/\r?\n/);
    const hint = (r, key) => lines(r).filter((l) => /^Phone page:/.test(l)).map((l) => l.trim()).filter((l) => l === `Phone page: run /publish-board ${key}`);
    const hintLines = (r) => lines(r).filter((l) => /Phone page/i.test(l));
    const preg = (args) => lane(state.cacheRoot, SA, ['project', ...args], regEnv({ LANE_REGISTRY_REPO: pair.repo, LANE_REGISTRY_ACTIVE: pair.act, LANE_REGISTRY_PATH: pair.repo }));
    const pentries = () => JSON.parse(read(pair.repo)).projects;

    before(() => {
      const d = (n) => fwd(dir(`ph-${n}`));
      const seedEntries = [
        { name: 'zeta2', key: 'zeta2', path: d('zeta2'), status: 'active', laneBoard: 'zeta2' },
        { name: 'continuous-claude', key: 'continuous-claude', path: d('cc'), status: 'active' },
        { name: 'dormant', key: 'dormant', path: d('dormant'), status: 'inactive', laneArtifact: URL_KEPT },
        { name: 'phoned', key: 'phoned', path: d('phoned'), status: 'active', laneArtifact: URL_KEPT.replace('KeptPage_1-x', 'Other_2-y') },
      ];
      const seed = JSON.stringify({ version: '1.0', projects: seedEntries }, null, 2) + '\n';
      pair = { repo: path.join(state.cacheRoot, 'ph-repo.json'), act: path.join(state.cacheRoot, 'ph-active.json') };
      fs.writeFileSync(pair.repo, seed);
      fs.writeFileSync(pair.act, seed);
    });

    it('a new owner board with no laneArtifact prints exactly one hint line and adds no laneArtifact', () => {
      const r = preg(['register', dir('ph-new')]);
      assert.equal(r.code, 0, r.all);
      assert.equal(hint(r, 'ph-new').length, 1, r.out);
      assert.equal(hintLines(r).length, 1, r.out);
      assert.equal('laneArtifact' in pentries().find((e) => e.key === 'ph-new'), false);
      assert.equal(read(pair.repo), read(pair.act));
    });

    it('no hint for a nested entry (it joins a board) or for the default board', () => {
      const nested = preg(['register', dir('ph-zeta2/inner'), '--key', 'ph-inner', '--board', 'zeta2']);
      assert.equal(nested.code, 0, nested.all);
      assert.equal(hintLines(nested).length, 0, nested.out);
      const dflt = preg(['register', dir('ph-cc'), '--key', 'continuous-claude']);
      assert.equal(dflt.code, 0, dflt.all);
      assert.equal(hintLines(dflt).length, 0, dflt.out);
    });

    it('re-register of a board that has a laneArtifact keeps it, prints the kept url, and gives no hint', () => {
      const r = preg(['register', dir('ph-dormant'), '--key', 'dormant']);
      assert.equal(r.code, 0, r.all);
      assert.equal(pentries().find((e) => e.key === 'dormant').laneArtifact, URL_KEPT);
      assert.equal(pentries().find((e) => e.key === 'dormant').status, 'active');
      assert.equal(hint(r, 'dormant').length, 0, r.out);
      assert.equal(hintLines(r).length, 1, r.out);
      assert.ok(r.out.includes(URL_KEPT), r.out);
      assert.match(r.out, /kept/i);
      assert.equal(read(pair.repo), read(pair.act));
    });

    it('unregister of a board with a laneArtifact says the url stays in the entry, and the entry still holds it', () => {
      const r = preg(['unregister', 'phoned']);
      assert.equal(r.code, 0, r.all);
      assert.ok(r.out.includes('https://claude.ai/artifact/Other_2-y'), r.out);
      assert.match(r.out, /stays in the (registry )?entry/i);
      const e = pentries().find((x) => x.key === 'phoned');
      assert.equal(e.status, 'inactive');
      assert.equal(e.laneArtifact, 'https://claude.ai/artifact/Other_2-y');
    });

    it('unregister of a board with no laneArtifact prints no phone page line', () => {
      const r = preg(['unregister', 'ph-new']);
      assert.equal(r.code, 0, r.all);
      assert.equal(hintLines(r).length, 0, r.out);
    });

    it('which --json exposes the recorded laneArtifact as entry.artifact (the url the skills read)', () => {
      const r = lane(state.cacheRoot, SA, ['project', 'which', '--json', '--project', 'dormant'], regEnv({ LANE_REGISTRY_REPO: pair.repo, LANE_REGISTRY_ACTIVE: pair.act, LANE_REGISTRY_PATH: pair.repo }));
      assert.equal(r.code, 0, r.all);
      assert.equal(JSON.parse(r.out).entry.artifact, URL_KEPT);
    });
  });
});
