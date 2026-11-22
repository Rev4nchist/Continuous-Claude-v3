/**
 * lane-parked-scope.test -- gap 6 (rule M4.12) and the lane half of gap 5 (rule L2.6).
 *
 * Every test spawns the real lane.mjs as a child process against a SCRATCH database that this file creates and drops.
 * The cwd is a temp git repo registered as board PS_BOARD.
 *
 *   node --test scripts/coordination/lane-parked-scope.test.mjs
 *   LANE_CLI=<path to an older lane.mjs> node --test scripts/coordination/lane-parked-scope.test.mjs   # proves the tests fail on old code
 *
 * Design note: .claudedocs/coordination/2026-11-16-coord-parked-claim-design.md (section 3, rows 1 to 15).
 *   say --to   a session quiet over 2 hours (a parked holder) or a name that never existed: the refusal keeps exit 1, no event, and
 *              names SendMessage and Dave as the fallback. Bare name (lane.mjs resolveRecipient, step 2) and name@board (step 1).
 *   add        `--scope` with no `OWNS:` or no `NEVER:` part: one WARNING line on stderr, exit 0, row and event written.
 *              A valid scope, no scope, an empty scope, a refused add and `--json` stay as they are.
 * The file name has no `.db.` part: test CO1 in pre-pr.cases.mjs matches the CI list with scripts/coordination/[\w-]+\.test\.mjs.
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
const LANE = process.env.LANE_CLI ? path.resolve(process.env.LANE_CLI) : path.join(HERE, 'lane.mjs');
const SCRATCH = path.join(HERE, 'scratch-db.mjs');
const { Client } = requireDep('pg', { repoRoot: REPO });

const fwd = (p) => String(p).replace(/\\/g, '/');
const PS_BOARD = 'ps-board';
const s = { url: '', db: null, tmp: '', repo: '', registry: '', idDir: '' };
const sid = () => randomUUID();
const ME = sid();
const HOLDER = sid();

function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'LANE_PROJECT', 'CLAUDE_CODE_ENTRYPOINT', 'LANE_SKIP_HOOK_PRECHECK', 'LANE_ALLOW_AS', 'LANE_CONTEXT_HEADLESS']) delete env[k];
  return env;
}
function laneEnv() {
  assertScratchUrl(s.url);
  return Object.assign(cleanEnv(), {
    CONTINUOUS_CLAUDE_DB_URL: s.url, DATABASE_URL: s.url, OPC_POSTGRES_URL: s.url,
    LANE_REGISTRY_PATH: s.registry, CCV3_IDENTITY_DIR: s.idDir, CLAUDE_CODE_SESSION_ID: ME,
  });
}
/** Run lane.mjs as ME. */
function lane(args) {
  const r = spawnSync(process.execPath, [LANE, ...args], { cwd: s.repo, env: laneEnv(), encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const q = (sql, params) => s.db.query(sql, params);
const one = async (sql, params) => (await q(sql, params)).rows[0];
const idFile = (u, o) => fs.writeFileSync(path.join(s.idDir, `${u}.json`), JSON.stringify({ uuid: u, updatedAt: new Date().toISOString(), ...o }));
const events = async () => (await one(`SELECT count(*)::int AS n FROM agentic_os.lane_event`)).n;
const row = (id) => one(`SELECT id, title, scope, state, owner_session_id AS owner FROM agentic_os.lane WHERE id=$1`, [id]);
let seq = 0;
const nid = (p) => `${p}-${++seq}`;
/** A sessions row whose last heartbeat is `minutesAgo` old and whose last_activity_at is NULL. */
const quiet = (id, minutesAgo) => q(
  `INSERT INTO sessions (id, project, working_on, last_heartbeat, last_activity_at)
   VALUES ($1,'probe','probe', now() - make_interval(mins => $2::int), NULL)`, [id, minutesAgo]);

before(async () => {
  const c = spawnSync(process.execPath, [SCRATCH, 'create', '--through', '6'], { encoding: 'utf8', windowsHide: true });
  assert.equal(c.status, 0, `scratch create failed: ${c.stderr}`);
  s.url = JSON.parse(c.stdout).url;
  assertScratchUrl(s.url);
  s.tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-parked-scope-')));
  s.repo = path.join(s.tmp, 'repo');
  s.idDir = path.join(s.tmp, 'ids');
  for (const d of [s.repo, s.idDir]) fs.mkdirSync(d);
  s.registry = path.join(s.tmp, 'registry.json');
  fs.writeFileSync(s.registry, JSON.stringify({ version: '1.0', projects: [{ name: 'ps-board', key: PS_BOARD, path: fwd(s.repo), status: 'active' }] }));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: s.repo, env: cleanEnv(), windowsHide: true });
  git('init', '-b', 'main'); fs.writeFileSync(path.join(s.repo, 'a.txt'), 'a'); git('add', 'a.txt'); git('commit', '-m', 'a');
  s.db = new Client({ connectionString: s.url });
  await s.db.connect();
  await s.db.query(`SELECT set_config('lane.client_version','test',false)`);
  await q(`INSERT INTO sessions (id, project, working_on, last_heartbeat, last_activity_at) VALUES ($1,'probe','probe',now(),now())`, [ME]);
  await q(`INSERT INTO sessions (id, project, working_on, last_heartbeat, last_activity_at) VALUES ($1,'probe','probe',now(),now())`, [HOLDER]);
});

after(async () => {
  await s.db?.end().catch(() => {});
  if (s.url) { assertScratchUrl(s.url); spawnSync(process.execPath, [SCRATCH, 'drop', s.url], { encoding: 'utf8', windowsHide: true }); }
  if (s.tmp) fs.rmSync(s.tmp, { recursive: true, force: true });
});

const FALLBACK = /SendMessage/;
const FALLBACK2 = /ask Dave/;

describe('say --to: a quiet or parked holder, or an unknown name, names a fallback (gap 6)', () => {
  /** The parked holder of design-note row 1: named, lane in review with a lease 3 h ahead, heartbeat 3 h old, last_activity_at NULL. */
  async function parkedHolder(name) {
    const holder = sid();
    idFile(holder, { name });
    await quiet(holder, 180);
    const id = nid('pk');
    await q(
      `INSERT INTO agentic_os.lane (id,title,track,scope,state,project_key,owner_session_id,lease_expires_at,note)
       VALUES ($1,'parked lane','zz','OWNS: x NEVER: y','review',$2,$3, now() + interval '3 hours','PARKED until later -- test')`,
      [id, PS_BOARD, holder]);
    return { holder, id };
  }

  it('rows 1, 2, 4: bare name of a holder quiet 3 h: exit 1, the old phrase, SendMessage and ask Dave, no REFUSED, no lane note, no event', async () => {
    await parkedHolder('zz-parked-a');
    const n = await events();
    const r = lane(['say', 'hello parked', '--to', 'zz-parked-a']);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /no recent session matching "zz-parked-a"/);
    assert.match(r.err, FALLBACK);
    assert.match(r.err, FALLBACK2);
    assert.match(r.err, /may be parked or quiet over 2 hours/);
    assert.doesNotMatch(r.err, /REFUSED/);
    assert.doesNotMatch(r.err, /lane note/);
    assert.equal(await events(), n, 'a refusal writes no event');
  });

  it('row 3: name@board of a holder quiet 3 h: exit 1, the fallback, no event', async () => {
    await parkedHolder('zz-parked-b');
    const n = await events();
    const r = lane(['say', 'hello parked', '--to', `zz-parked-b@${PS_BOARD}`]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /no live session named "zz-parked-b" on board ps-board/);
    assert.match(r.err, FALLBACK);
    assert.match(r.err, FALLBACK2);
    assert.equal(await events(), n);
  });

  it('row 15: a name that never existed gets the same text and exit 1, bare and name@board', async () => {
    const n = await events();
    const a = lane(['say', 'hello nobody', '--to', 'zz-never-existed']);
    assert.equal(a.code, 1, a.err);
    assert.match(a.err, /no recent session matching "zz-never-existed"/);
    assert.match(a.err, FALLBACK);
    assert.match(a.err, FALLBACK2);
    const b = lane(['say', 'hello nobody', '--to', `zz-never-existed@${PS_BOARD}`]);
    assert.equal(b.code, 1, b.err);
    assert.match(b.err, /no live session named "zz-never-existed" on board ps-board/);
    assert.match(b.err, FALLBACK);
    assert.match(b.err, FALLBACK2);
    assert.equal(await events(), n);
  });

  it('control for rows 1 and 3: the same name with a fresh heartbeat resolves and gets the message (exit 0)', async () => {
    const { holder } = await parkedHolder('zz-parked-c');
    await q(`UPDATE sessions SET last_heartbeat = now(), last_activity_at = now() WHERE id = $1`, [holder]);
    const r = lane(['say', 'hello woken', '--to', 'zz-parked-c']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^sent to /);
  });

  it('row 6 (guard, passes before and after): a live session still gets the message', async () => {
    const live = sid();
    idFile(live, { name: 'zz-live-a' });
    await q(`INSERT INTO sessions (id, project, working_on, last_heartbeat, last_activity_at) VALUES ($1,'probe','probe',now(),now())`, [live]);
    const r = lane(['say', 'hello live', '--to', 'zz-live-a']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^sent to /);
    assert.equal((await q(`SELECT 1 FROM agentic_os.lane_event WHERE body='hello live' AND to_session_id=$1`, [live])).rowCount, 1);
  });
});

describe('add: a scope with no OWNS: or no NEVER: warns on stderr and still saves (gap 5, lane half)', () => {
  const add = (id, scope, extra = []) => lane(['add', id, '--title', `title ${id}`, ...(scope === undefined ? [] : ['--scope', scope]), ...extra]);
  // Every case that calls warns() expects exit 0, so a crash in add cannot pass as "silent".
  const warns = (r) => { assert.equal(r.code, 0, r.err); return r.err.split('\n').filter((l) => /^WARNING: /.test(l)); };

  it('row 7: OWNS only names NEVER:; NEVER only names OWNS:; RELATES TO only names both', async () => {
    const a = add(nid('ws-a'), 'OWNS: a.txt');
    assert.equal(a.code, 0, a.err);
    assert.equal(warns(a).length, 1, a.err);
    assert.match(warns(a)[0], /scope has no NEVER: part/);
    const b = add(nid('ws-b'), 'NEVER: b.txt');
    assert.match(warns(b)[0] ?? '', /scope has no OWNS: part/, b.err);
    const c = add(nid('ws-c'), 'RELATES TO: re-program');
    assert.match(warns(c)[0] ?? '', /scope has no OWNS: or NEVER: part/, c.err);
  });

  it('row 8: a one-line scope, lower case and a WAITS ON prefix stay silent; WAITS ON with NEVER only warns', async () => {
    assert.equal(warns(add(nid('ws-d'), 'WAITS ON: zz-a OWNS: x NEVER: y')).length, 0);
    assert.equal(warns(add(nid('ws-e'), 'waits on: zz-a owns: x never: y')).length, 0);
    assert.equal(warns(add(nid('ws-e2'), 'OWNS : x NEVER : y')).length, 0, 'a space before the colon counts');
    const w = add(nid('ws-f'), 'WAITS ON: zz-a NEVER: y');
    assert.match(warns(w)[0] ?? '', /scope has no OWNS: part/, w.err);
  });

  it('row 9: KNOWNS: is not OWNS:, WHENEVER: is not NEVER:', async () => {
    const a = add(nid('ws-g'), 'KNOWNS: x NEVER: y');
    assert.match(warns(a)[0] ?? '', /scope has no OWNS: part/, a.err);
    const b = add(nid('ws-h'), 'OWNS: x WHENEVER: y');
    assert.match(warns(b)[0] ?? '', /scope has no NEVER: part/, b.err);
  });

  it('row 10: add with no --scope on a lane whose stored scope is x stays silent and keeps x; the same lane with --scope x warns', async () => {
    const id = nid('ws-i');
    await q(`INSERT INTO agentic_os.lane (id,title,track,scope,state,project_key) VALUES ($1,'t','zz','x','backlog',$2)`, [id, PS_BOARD]);
    const r = add(id, undefined);
    assert.equal(r.code, 0, r.err);
    assert.equal(warns(r).length, 0, r.err);
    assert.equal((await row(id)).scope, 'x');
    const control = add(id, 'x');
    assert.equal(warns(control).length, 1, control.err);
  });

  it('row 11: no --scope, --scope "" and --scope "   " stay silent; the control --scope x warns', async () => {
    assert.equal(warns(add(nid('ws-j'), undefined)).length, 0);
    assert.equal(warns(add(nid('ws-k'), '')).length, 0);
    assert.equal(warns(add(nid('ws-l'), '   ')).length, 0);
    assert.equal(warns(add(nid('ws-m'), 'x')).length, 1);
  });

  it('row 11: a bare --scope (no value) is skipped: exit 0, no WARNING', async () => {
    const r = lane(['add', nid('ws-q'), '--title', 't', '--scope']);
    assert.equal(warns(r).length, 0, r.err);
    assert.doesNotMatch(r.err, /TypeError/);
  });

  it('row 12: with --json stdout is JSON and the WARNING is on stderr only', async () => {
    const id = nid('ws-n');
    const r = add(id, 'OWNS: only', ['--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).id, id);
    assert.doesNotMatch(r.out, /WARNING/);
    assert.equal(warns(r).length, 1, r.err);
  });

  it('row 13: the warning does not block: exit 0, exactly one WARNING line, row written, seeded event logged', async () => {
    const id = nid('ws-o');
    const n0 = await events();
    const r = add(id, 'OWNS: only');
    assert.equal(r.code, 0, r.err);
    assert.equal(warns(r).length, 1, r.err);
    assert.equal((await row(id)).scope, 'OWNS: only');
    assert.equal(await events(), n0 + 1);
    assert.equal((await q(`SELECT 1 FROM agentic_os.lane_event WHERE lane_id=$1 AND kind='seeded'`, [id])).rowCount, 1);
  });

  it('row 14: an add with --scope x on a lane held by another session is REFUSED, exit 4, no WARNING, scope unchanged', async () => {
    const id = nid('ws-p');
    await q(`INSERT INTO agentic_os.lane (id,title,track,scope,state,project_key,owner_session_id,lease_expires_at)
             VALUES ($1,'t','zz','OWNS: x NEVER: y','active',$2,$3, now() + interval '1 hour')`, [id, PS_BOARD, HOLDER]);
    const r = add(id, 'x');
    assert.equal(r.code, 4, r.err);
    assert.match(r.err.split('\n')[0], /^REFUSED add \S+ \[not-holder\] -- /);
    assert.equal(r.err.split('\n').filter((l) => /^WARNING: /.test(l)).length, 0, r.err);
    assert.equal((await row(id)).scope, 'OWNS: x NEVER: y');
  });
});
