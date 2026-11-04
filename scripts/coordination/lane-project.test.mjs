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
import { spawnSync } from 'node:child_process';
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

  it('a cwd with no board exits 1 with the register hint', () => {
    const r = lane(state.dirs.N, SA, ['board']);
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /no lane board for /);
    assert.match(r.err, /register it: node .*lane\.mjs project register /);
    assert.ok(path.isAbsolute(/node (\S+lane\.mjs)/.exec(r.err)[1].replace(/\//g, path.sep)), r.err);
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
    assert.doesNotMatch(r.out, /dm-1/);
    assert.match(r.out, /bcast-A/);
    assert.deepEqual(await inboxRows(SB), [`${SB}@pb-a`, `${SB}@pb-b`]);
  });

  it('a DM read first on A is not shown on B', () => {
    lane(state.dirs.A, SA, ['say', 'dm-2', '--to', SB]);
    const onA = lane(state.dirs.A, SB, ['inbox']);
    assert.match(onA.out, /dm-2/);
    const onB = lane(state.dirs.B, SB, ['inbox']);
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
    assert.doesNotMatch(r.out, /bcast-A/);
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
  it('copies <old> and <old>@<board> to the new id, moves a foreign-board lane and an unread DM', async () => {
    const oldId = randomUUID();
    const newId = randomUUID();
    const idFile = (u, o) => fs.writeFileSync(path.join(state.idDir, `${u}.json`), JSON.stringify({ uuid: u, name: 'pb-adopt', updatedAt: new Date().toISOString(), ...o }));
    idFile(oldId, { endedAt: new Date().toISOString(), endReason: 'clear' });
    idFile(newId, { previous: oldId });
    await q(`INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES ($1,'x',NULL, now() - interval '1 hour'), ($2,'x',NULL, now())`, [oldId, newId]);
    await q(`INSERT INTO agentic_os.lane (id,title,track,state,project_key,owner_session_id,lease_expires_at)
             VALUES ('zz-pbprobe-ad1','held on B','zz','active','pb-b',$1, now() + interval '30 minutes')`, [oldId]);
    const last = (await one(`SELECT COALESCE(max(id),0)::int AS n FROM agentic_os.lane_event`)).n;
    await q(`INSERT INTO agentic_os.lane_watermark (session_id,last_event_id) VALUES ($1,$3),($2,$3)`, [oldId, `${oldId}@pb-b`, last]);
    await q(`INSERT INTO agentic_os.lane_event (kind,session_id,to_session_id,body,project_key) VALUES ('note',$1,$2,'adopt-dm','pb-a')`, [SA, oldId]);

    const r = lane(state.dirs.N, newId, ['adopt', '--from', oldId]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /1 lane/);
    assert.match(r.out, /1 message/);
    assert.equal((await one(`SELECT owner_session_id FROM agentic_os.lane WHERE id='zz-pbprobe-ad1'`)).owner_session_id, newId);
    assert.equal((await one(`SELECT to_session_id FROM agentic_os.lane_event WHERE body='adopt-dm'`)).to_session_id, newId);
    const rows = (await q(`SELECT session_id FROM agentic_os.lane_watermark WHERE session_id = ANY($1) ORDER BY 1`, [[newId, `${newId}@pb-b`]])).rows.map((x) => x.session_id);
    assert.deepEqual(rows, [newId, `${newId}@pb-b`].sort());
    const again = lane(state.dirs.N, newId, ['adopt', '--from', oldId]);
    assert.match(again.out, /nothing to move/);
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

  it('a real apply does not touch the other board lane', async () => {
    const before = await one(`SELECT priority FROM agentic_os.lane WHERE id='zz-pbprobe-b1'`);
    const r = lane(state.dirs.A, SA, ['apply-kanban', kanban({})]);
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
  const regEnv = (extra = {}) => ({ LANE_REGISTRY_REPO: R(), LANE_REGISTRY_ACTIVE: ACT(), LANE_REGISTRY_PATH: R(), ...extra });
  const reg = (args, extra) => lane(state.cacheRoot, SA, ['project', ...args], regEnv(extra));
  const read = (f) => fs.readFileSync(f, 'utf8');
  const entries = () => JSON.parse(read(R())).projects;
  const fwd = (p) => p.replace(/\\/g, '/');
  let P1;

  before(() => {
    const seedEntries = [
      { name: 'old-one', key: 'old-one', path: 'C:/nowhere/old-one', status: 'inactive', stack: ['x', 'y'] },
      { name: 'zeta', key: 'zeta', path: fwd(dir('zeta')), status: 'active', laneBoard: 'zeta' },
    ];
    fs.writeFileSync(R(), JSON.stringify({ version: '1.0', projects: seedEntries }, null, 2).replace(/\n/g, '\r\n') + '\r\n');
    fs.writeFileSync(ACT(), '{ "stale": true }\n');
    P1 = dir('proj1');
  });

  it('which prints the board, the winning source and the entry; no board is exit 1 with the hint', () => {
    const r = lane(state.dirs.A, SA, ['project', 'which']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /board: pb-a/);
    assert.match(r.out, /source: registry/);
    assert.match(r.out, /entry: pb-a/);
    const none = lane(state.dirs.N, SA, ['project', 'which']);
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
});
