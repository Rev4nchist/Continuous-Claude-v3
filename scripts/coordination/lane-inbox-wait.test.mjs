/**
 * lane-inbox-wait.test -- end to end tests for `lane.mjs inbox --wait [--timeout N]` (card coord-inbox-wait).
 *
 * A builder that waits on the seat runs `inbox --wait` in the background. It exits 0 on the first unread direct message, or the first
 * unread broadcast said with `say`, and 75 at the time limit. It writes no cursor, and it opens and closes the database on each poll.
 *
 * What the seat's filter is built on (rows W2 and W2b check it against the REAL verbs, not a guess): `say` writes kind `note` with
 * lane_id NULL; `note <lane>`, `claim`, `done` and `add` write other rows or kind `note` WITH a lane id. So a board event wakes the wait
 * only when kind = 'note' AND lane_id IS NULL. Known limit: `say --lane <id>` writes the same columns as a lane note, so it does not wake.
 *
 * Ways it can fail, and the source change that makes each row fail:
 *   W1   a DM does not wake it, or the line shows the body                       -> the query drops DMs, or prints the body
 *   W1b  a DM that arrives DURING the wait does not wake it                      -> the loop does not poll again
 *   W2   a broadcast said with `say` does not wake it                            -> the kind filter is wrong
 *   W2b  a peer lane note, a claim or a done wakes it                            -> the kind filter is removed (a builder would wake every few minutes)
 *   W3   another session's DM, another board's broadcast or my own event wakes it -> a condition of UNREAD_SQL is lost
 *   W4   a cursor row changes                                                    -> the verb copies the write of plain `inbox`
 *   W5   the time limit gives the wrong exit code, text or length                -> the loop never ends, or exits 0
 *   W6   a bad --timeout or a bad flag mix runs a query                          -> a bad value is accepted
 *   W7   an event that is unread at the start does not wake it at once           -> the loop sleeps before the first query
 *   W8   the poll count (pure helper)                                            -> two queries per poll, no last poll at the limit, or an error is swallowed
 *   W9   `--as` is refused for --wait, or a write verb stops being refused       -> `wait` is missing from isReadVerb
 *   W10  a connection stays open between polls                                   -> the verb holds one connection for the whole wait
 *
 * Every test spawns the real `lane.mjs` against a SCRATCH database that this file creates and drops.
 *
 *   node --test scripts/coordination/lane-inbox-wait.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
const s = { url: '', db: null, tmp: '', registry: '', idDir: '', projects: [], dropped: [] };
/** Fast polling for tests: honoured only with LANE_ALLOW_AS=1. */
const FAST = { LANE_ALLOW_AS: '1', LANE_WAIT_POLL_MS: '200' };

function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'LANE_PROJECT', 'CLAUDE_CODE_ENTRYPOINT', 'LANE_SKIP_HOOK_PRECHECK', 'LANE_ALLOW_AS', 'LANE_WAIT_POLL_MS']) delete env[k];
  return env;
}
function laneEnv(sessionId, extra = {}) {
  assertScratchUrl(s.url);
  return Object.assign(cleanEnv(), {
    CONTINUOUS_CLAUDE_DB_URL: s.url, DATABASE_URL: s.url, OPC_POSTGRES_URL: s.url,
    LANE_REGISTRY_PATH: s.registry, CCV3_IDENTITY_DIR: s.idDir, CLAUDE_CODE_SESSION_ID: sessionId,
  }, extra);
}

/** One case = one board, one folder, two session ids. A fresh board keeps the unread events of one row away from the next. */
function newCase(tag) {
  const board = `iw-${tag}-${randomUUID().slice(0, 6)}`;
  const repo = path.join(s.tmp, board);
  fs.mkdirSync(repo);
  s.projects.push({ name: board, key: board, path: fwd(repo), status: 'active' });
  fs.writeFileSync(s.registry, JSON.stringify({ version: '1.0', projects: s.projects }));
  return { board, repo, me: randomUUID(), peer: randomUUID() };
}

/** Run the worktree lane.mjs as `as` in the folder of case `c`. */
function lane(c, args, { as = c.me, extra = {}, cwd = c.repo } = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [LANE, ...args], { cwd, env: laneEnv(as, extra), windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 24 });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t0 };
}
/** The same, started in the background: { done: Promise<result> }. */
function laneBg(c, args, { as = c.me, extra = {} } = {}) {
  const t0 = Date.now();
  const child = spawn(process.execPath, [LANE, ...args], { cwd: c.repo, env: laneEnv(as, extra), windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t0 })));
  return { child, done };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createScratch(through) {
  const r = spawnSync(process.execPath, [SCRATCH, 'create', '--through', String(through)], { encoding: 'utf8' });
  assert.equal(r.status, 0, `scratch create failed: ${r.stderr}`);
  const { url } = JSON.parse(r.stdout);
  assertScratchUrl(url);
  return url;
}

/** An event row. `to` null makes a broadcast of `board`. Returns the new id as a string. */
async function ev({ from, to = null, board, kind = 'note', lane: laneId = null, body = 'secret body text' }) {
  const r = await s.db.query(
    `INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, to_session_id, body, detail, project_key)
     VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6) RETURNING id::text AS id`,
    [laneId, kind, from, to, body, board],
  );
  return r.rows[0].id;
}
const watermarks = async () => (await s.db.query(`SELECT session_id, last_event_id::text AS last_event_id, updated_at::text AS updated_at FROM agentic_os.lane_watermark ORDER BY session_id`)).rows;
const WAIT_LINE = /^inbox wait: event (\d+) from \S.* kind (\S+)$/;

before(async () => {
  s.url = createScratch(6);
  s.tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-inbox-wait-')));
  s.idDir = path.join(s.tmp, 'ids');
  fs.mkdirSync(s.idDir);
  s.registry = path.join(s.tmp, 'registry.json');
  fs.writeFileSync(s.registry, JSON.stringify({ version: '1.0', projects: [] }));
  s.db = new Client({ connectionString: s.url });
  await s.db.connect();
  await s.db.query(`SELECT set_config('lane.client_version','test',false)`);
});

after(async () => {
  await s.db?.end().catch(() => {});
  if (s.url) {
    const r = spawnSync(process.execPath, [SCRATCH, 'drop', s.url], { encoding: 'utf8' });
    s.dropped.push(`${new URL(s.url).pathname.slice(1)} status ${r.status}`);
  }
  if (s.tmp) fs.rmSync(s.tmp, { recursive: true, force: true });
  console.log(`scratch database dropped: ${s.dropped.join('; ')}`);
});

describe('inbox --wait: what wakes it', () => {
  it('W1: a direct message wakes it: exit 0, one line with event id, sender and kind, and no body', async () => {
    const c = newCase('w1');
    // A DM of ANY kind, with a lane id: it must not depend on the say filter (kind note, no lane id).
    const id = await ev({ from: c.peer, to: c.me, board: c.board, kind: 'handoff', lane: 'some-lane', body: 'SECRET-BODY-W1' });
    const r = lane(c, ['inbox', '--wait', '--timeout', '30'], { extra: FAST });
    assert.equal(r.code, 0, r.err);
    const m = WAIT_LINE.exec(r.out.trim());
    assert.ok(m, `one wait line, got: ${JSON.stringify(r.out)}`);
    assert.equal(m[1], id);
    assert.equal(m[2], 'handoff');
    assert.ok(!r.out.includes('SECRET-BODY-W1'), 'the body is not printed');
    assert.equal(r.out.trim().split('\n').length, 1);
  });

  it('W1b: a direct message that arrives during the wait wakes it', async () => {
    const c = newCase('w1b');
    const bg = laneBg(c, ['inbox', '--wait', '--timeout', '30'], { extra: FAST });
    await sleep(1200);
    const id = await ev({ from: c.peer, to: c.me, board: c.board });
    const r = await bg.done;
    assert.equal(r.code, 0, r.err);
    assert.equal(WAIT_LINE.exec(r.out.trim())?.[1], id, r.out);
    assert.ok(r.ms < 15000, `woke within a few polls, took ${r.ms} ms`);
  });

  it('W2: a broadcast said with the real `say` verb wakes it (say writes kind note, lane_id NULL)', async () => {
    const c = newCase('w2');
    const said = lane(c, ['say', 'LAND DONE 000 test broadcast'], { as: c.peer });
    assert.equal(said.code, 0, said.err);
    const row = (await s.db.query(`SELECT id::text AS id, kind, lane_id, to_session_id FROM agentic_os.lane_event WHERE project_key = $1 ORDER BY id DESC LIMIT 1`, [c.board])).rows[0];
    assert.deepEqual({ kind: row.kind, lane_id: row.lane_id, to: row.to_session_id }, { kind: 'note', lane_id: null, to: null }, 'the premise of the filter');
    const r = lane(c, ['inbox', '--wait', '--timeout', '30'], { extra: FAST });
    assert.equal(r.code, 0, r.err);
    assert.equal(WAIT_LINE.exec(r.out.trim())?.[1], row.id, r.out);
  });

  it('W2b: a peer lane note, a claim and a done on the board do not wake it (exit 75)', async () => {
    const c = newCase('w2b');
    for (const args of [['add', 'w2b-lane', '--title', 'wait test lane', '--scope', 'OWNS: x. NEVER: y.'], ['claim', 'w2b-lane'], ['note', 'w2b-lane', 'a peer status note'], ['done', 'w2b-lane']]) {
      const r = lane(c, args, { as: c.peer });
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
    }
    const noteRow = (await s.db.query(`SELECT kind, lane_id FROM agentic_os.lane_event WHERE project_key = $1 AND body LIKE '%a peer status note%'`, [c.board])).rows[0];
    assert.deepEqual(noteRow, { kind: 'note', lane_id: 'w2b-lane' }, 'a lane note has kind note WITH a lane id: that is what tells it from say');
    const kinds = (await s.db.query(`SELECT DISTINCT kind FROM agentic_os.lane_event WHERE project_key = $1`, [c.board])).rows.map((x) => x.kind);
    assert.ok(kinds.length >= 3, `the peer wrote several kinds: ${kinds}`);
    const r = lane(c, ['inbox', '--wait', '--timeout', '1'], { extra: FAST });
    assert.equal(r.code, 75, `no wake on board events of a lane: ${r.out}${r.err}`);
    assert.equal(r.out, '');
  });

  it('W3: another session\'s DM, another board\'s broadcast and my own event do not wake it (exit 75)', async () => {
    const c = newCase('w3');
    const other = newCase('w3other');
    await ev({ from: c.peer, to: randomUUID(), board: c.board });
    await ev({ from: other.peer, board: other.board });
    await ev({ from: c.me, board: c.board });
    await ev({ from: c.me, to: c.peer, board: c.board });
    const r = lane(c, ['inbox', '--wait', '--timeout', '1'], { extra: FAST });
    assert.equal(r.code, 75, `${r.out}${r.err}`);
    assert.equal(r.out, '');
  });

  it('W7: an event that is unread at the start wakes it at once, before the first sleep', async () => {
    const c = newCase('w7');
    const id = await ev({ from: c.peer, to: c.me, board: c.board });
    const r = lane(c, ['inbox', '--wait', '--timeout', '600']); // the default 15 s poll
    assert.equal(r.code, 0, r.err);
    assert.equal(WAIT_LINE.exec(r.out.trim())?.[1], id, `a wait line, got: ${JSON.stringify(r.out)}`);
    assert.ok(r.ms < 8000, `woke at once, took ${r.ms} ms`);
  });
});

describe('inbox --wait: what it never does', () => {
  it('W4: it writes no cursor: the watermark rows are identical after a wake and after a time-out', async () => {
    const c = newCase('w4');
    await s.db.query(`INSERT INTO agentic_os.lane_watermark (session_id, last_event_id, updated_at) VALUES ($1, 1, now()) ON CONFLICT (session_id) DO NOTHING`, [c.me]);
    const before = await watermarks();
    await ev({ from: c.peer, to: c.me, board: c.board });
    assert.equal(lane(c, ['inbox', '--wait', '--timeout', '30'], { extra: FAST }).code, 0);
    assert.deepEqual(await watermarks(), before, 'no cursor moved after a wake');
    const d = newCase('w4b');
    assert.equal(lane(d, ['inbox', '--wait', '--timeout', '1'], { extra: FAST }).code, 75);
    assert.deepEqual(await watermarks(), before, 'no cursor moved after a time-out');
  });

  it('W10: no connection stays open between polls', async () => {
    const c = newCase('w10');
    const bg = laneBg(c, ['inbox', '--wait', '--timeout', '6'], { extra: { LANE_ALLOW_AS: '1', LANE_WAIT_POLL_MS: '2500' } });
    await sleep(1500); // after the first poll, inside the first sleep
    const dbName = new URL(s.url).pathname.slice(1);
    const open = (await s.db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName])).rows[0].n;
    const r = await bg.done;
    assert.equal(r.code, 75, r.err);
    assert.equal(open, 0, 'the wait holds no database connection while it sleeps');
  });
});

describe('inbox --wait: the time limit and the flags', () => {
  it('W5: the time limit gives exit 75, one line on stderr, nothing on stdout, after the limit and before limit plus one poll', () => {
    const c = newCase('w5');
    const r = lane(c, ['inbox', '--wait', '--timeout', '2'], { extra: FAST });
    assert.equal(r.code, 75, `${r.out}${r.err}`);
    assert.equal(r.out, '');
    assert.match(r.err.trim(), /^inbox wait: no new event in 2 s$/);
    assert.ok(r.ms >= 2000 && r.ms < 9000, `took ${r.ms} ms`);
  });

  it('W6: a bad --timeout or a bad flag mix is a usage error, exit 1, before any query', () => {
    const c = newCase('w6');
    // A database that does not exist: a verb that queried first would fail with a connection error, not a usage line.
    const dead = { CONTINUOUS_CLAUDE_DB_URL: 'postgresql://nobody:x@127.0.0.1:1/none', DATABASE_URL: 'postgresql://nobody:x@127.0.0.1:1/none', OPC_POSTGRES_URL: 'postgresql://nobody:x@127.0.0.1:1/none' };
    const bad = [['--timeout', '0'], ['--timeout', '3601'], ['--timeout', 'abc'], ['--timeout', '1.5'], ['--timeout', '-3'], ['--timeout'], ['--peek'], ['--id', '5'], ['--wait=5']];
    for (const extraArgs of bad) {
      const args = extraArgs[0] === '--wait=5' ? ['inbox', '--wait=5'] : ['inbox', '--wait', ...extraArgs];
      const r = lane(c, args, { extra: dead });
      assert.equal(r.code, 1, `${args.join(' ')}: exit ${r.code} ${r.err}`);
      assert.match(r.err, /usage/i, `${args.join(' ')}: ${r.err}`);
      assert.equal(r.out, '');
    }
  });

  it('W9: --as is accepted for --wait (a read verb) and a write verb is still refused', () => {
    const c = newCase('w9');
    const other = randomUUID();
    const r = lane(c, ['inbox', '--wait', '--timeout', '1', '--as', other]);
    assert.equal(r.code, 75, `--wait with --as acts as a read verb: ${r.out}${r.err}`);
    const w = lane(c, ['inbox', '--as', other]);
    assert.equal(w.code, 4, `a plain inbox is a write: ${w.out}${w.err}`);
  });
});

describe('the poll loop (pure helper)', () => {
  it('W8: queries at 0, every poll and once at the limit; stops at the first event; an error is not swallowed', async () => {
    const wait = await import('./lane-inbox-wait.mjs');
    const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; }, at: () => t }; };

    const a = clock();
    const times = [];
    const none = await wait.waitForEvent({ poll: async () => { times.push(a.at()); return null; }, sleep: a.sleep, now: a.now, timeoutS: 50, pollS: 15 });
    assert.equal(none.timedOut, true);
    assert.deepEqual(times, [0, 15000, 30000, 45000, 50000], 'one query at each poll and one at the limit');

    const b = clock();
    let n = 0;
    const row = { id: '7', kind: 'note' };
    const got = await wait.waitForEvent({ poll: async () => (++n === 3 ? row : null), sleep: b.sleep, now: b.now, timeoutS: 600, pollS: 15 });
    assert.deepEqual(got.event, row);
    assert.equal(n, 3, 'it stops at the first event');

    const d = clock();
    await assert.rejects(() => wait.waitForEvent({ poll: async () => { throw new Error('db down'); }, sleep: d.sleep, now: d.now, timeoutS: 30, pollS: 15 }), /db down/);
  });
});
