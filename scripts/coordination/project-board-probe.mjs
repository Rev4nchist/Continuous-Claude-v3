#!/usr/bin/env node
/**
 * project-board-probe -- the end-to-end gate for per-project lane boards.
 *
 * `lane-project.test.mjs` runs lane.mjs against databases it creates and drops itself.
 * This probe runs the same real `lane.mjs` against WHATEVER database the env points at, so
 * it can prove a live migration the way a user would use it. The plan is
 * .claudedocs/2026-11-04-per-project-lanes-plan.md, section 9 (premortem T1 to T7).
 *
 *   node scripts/coordination/project-board-probe.mjs [--allow-live]
 *
 * Database: CONTINUOUS_CLAUDE_DB_URL, then DATABASE_URL, then OPC_POSTGRES_URL, then the
 * live default. Only a database named `lanes_pr1_*` (see scratch-db.mjs) is accepted without
 * `--allow-live`. A database without migration 0004 is refused too. Both are exit 2, before
 * any fixture is written.
 *
 * Fixtures (all `zz-pbprobe-*`): temp dirs A, B, C, a temp registry through
 * LANE_REGISTRY_PATH (zz-pbprobe-a -> A, zz-pbprobe-b -> B, no entry for C), project rows
 * for both keys, lanes a1 and b1 on their boards, c1 on continuous-claude, sessions sa and sb.
 * Cleanup runs in a finally block, with LIKE patterns, and is itself checked.
 *
 * Assertions:
 *   1  board --json: A lists a1 and not b1; B the reverse
 *   2  next from A never returns b1
 *   3  claim b1 from A is refused and b1 has no owner
 *   4  add b1 from A fails with "belongs to board"; b1 is unchanged
 *   5  a broadcast from A is absent from B's inbox; a DM from sa shows in sb's inbox from B
 *   6  reading A's inbox leaves B's watermark row unchanged
 *   7  cwd C (a planted .git file, no registry entry): exit 1 and the register command
 *   8  a subfolder of A resolves to A
 *   9  an old-style client is refused (42501) on b1 and allowed on a continuous-claude lane
 *  10  the continuous-claude lane count is the same before and after
 *  11  cleanup deletes every fixture
 *  12  hook payloads (T6): SKIP, the hooks change in the next PR
 *
 * Exit: 0 all pass | 1 a check failed | 2 refused or could not run.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dbNameOf, maskUrl } from './scratch-db.mjs';
import { laneEnv, makeBoards } from './probe-boards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LANE = join(HERE, 'lane.mjs');

function loadPg() {
  for (const anchor of [join(REPO, '.claude', 'hooks', 'package.json'), join(REPO, 'apps', 'agentic-os', 'package.json')]) {
    try { return createRequire(pathToFileURL(anchor)).call(null, 'pg'); } catch { /* next */ }
  }
  throw new Error('cannot resolve `pg`. Looked in .claude/hooks and apps/agentic-os.');
}
const { Client } = loadPg();

const URL = process.env.CONTINUOUS_CLAUDE_DB_URL
  || process.env.DATABASE_URL
  || process.env.OPC_POSTGRES_URL
  || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';
const ALLOW_LIVE = process.argv.includes('--allow-live');

const KEY_A = 'zz-pbprobe-a';
const KEY_B = 'zz-pbprobe-b';
const L_A1 = 'zz-pbprobe-a1';
const L_B1 = 'zz-pbprobe-b1';
const L_C1 = 'zz-pbprobe-c1';
const SA = 'zz-pbprobe-sa';
const SB = 'zz-pbprobe-sb';
const DEFAULT_BOARD = 'continuous-claude';
const WM_B = `${SB}@${KEY_B}`;
const WM_A = `${SB}@${KEY_A}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ ok, skip: false });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}\n`);
}
function skip(name, why) {
  results.push({ ok: true, skip: true });
  process.stdout.write(`SKIP  ${name} -- ${why}\n`);
}

function refuse(msg) {
  process.stderr.write(`project-board-probe refused: ${msg}\n`);
  process.exit(2);
}

async function connect(clientVersion = 'probe') {
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 4000 });
  await c.connect();
  // The fixture connection plays a board-aware client. Without this the 0004 trigger would
  // refuse the probe's own cleanup of a foreign-board lane.
  if (clientVersion) await c.query(`SELECT set_config('lane.client_version', $1, false)`, [clientVersion]);
  return c;
}

/** Delete every fixture row. LIKE patterns only: `_` never appears in these ids. */
async function cleanup(c) {
  await c.query(
    `DELETE FROM agentic_os.lane_event
      WHERE session_id LIKE 'zz-pbprobe-%' OR to_session_id LIKE 'zz-pbprobe-%'
         OR lane_id LIKE 'zz-pbprobe-%' OR project_key LIKE 'zz-pbprobe-%'`);
  await c.query(`DELETE FROM agentic_os.lane_watermark WHERE session_id LIKE 'zz-pbprobe-%' OR session_id LIKE 'zz-pbprobe-%@%'`);
  await c.query(`DELETE FROM agentic_os.lane WHERE id LIKE 'zz-pbprobe-%'`);
  await c.query(`DELETE FROM agentic_os.project WHERE key LIKE 'zz-pbprobe-%'`);
  await c.query(`DELETE FROM sessions WHERE id LIKE 'zz-pbprobe-%'`);
}

const fixtureCount = async (c) => Number((await c.query(
  `SELECT (SELECT count(*) FROM agentic_os.lane WHERE id LIKE 'zz-pbprobe-%')
        + (SELECT count(*) FROM agentic_os.lane_event WHERE session_id LIKE 'zz-pbprobe-%' OR lane_id LIKE 'zz-pbprobe-%' OR project_key LIKE 'zz-pbprobe-%')
        + (SELECT count(*) FROM agentic_os.lane_watermark WHERE session_id LIKE 'zz-pbprobe-%')
        + (SELECT count(*) FROM agentic_os.project WHERE key LIKE 'zz-pbprobe-%')
        + (SELECT count(*) FROM sessions WHERE id LIKE 'zz-pbprobe-%') AS n`)).rows[0].n);

const defaultBoardCount = async (c) => Number((await c.query(
  `SELECT count(*) AS n FROM agentic_os.lane WHERE project_key = $1`, [DEFAULT_BOARD])).rows[0].n);

/** Migration 0004 is in: both project_key columns and the foreign-board trigger. */
async function migrated(c) {
  const cols = Number((await c.query(
    `SELECT count(*) AS n FROM information_schema.columns
      WHERE table_schema='agentic_os' AND table_name IN ('lane','lane_event') AND column_name='project_key'`)).rows[0].n);
  const trg = Number((await c.query(
    `SELECT count(*) AS n FROM pg_trigger WHERE tgname='lane_guard_foreign_board' AND NOT tgisinternal`)).rows[0].n);
  return { cols, trg, ok: cols === 2 && trg === 1 };
}

async function main() {
  const dbName = dbNameOf(URL);
  process.stdout.write(`project-board-probe target: ${maskUrl(URL)} (database ${dbName || '?'})\n`);
  if (!dbName.startsWith('lanes_pr1_') && !ALLOW_LIVE) {
    refuse(`database '${dbName}' is not a scratch database (lanes_pr1_*). Create one with:\n` +
      '  node scripts/coordination/scratch-db.mjs create --through 4\n  or pass --allow-live to run on this database.');
  }

  const probe = await connect();
  const state = await migrated(probe).catch((e) => { refuse(`cannot read the schema: ${e.message}`); });
  if (!state.ok) {
    await probe.end().catch(() => {});
    refuse(`migration 0004 is absent or partial in '${dbName}' (project_key columns ${state.cols} of 2, foreign-board trigger ${state.trg} of 1)`);
  }

  const bx = makeBoards('zz-pbprobe', ['a', 'b']);
  const dirA = bx.boards.a.dir;
  const dirB = bx.boards.b.dir;
  const dirC = path.join(bx.tmp, 'proj-c');
  fs.mkdirSync(dirC);
  // A repo-looking dir with no registry entry: lane.mjs must not follow this file to the CCv3 repo.
  fs.writeFileSync(path.join(dirC, '.git'), 'gitdir: C:/Users/dkhay/continuous-claude/.git\n');
  const deep = path.join(dirA, 'sub', 'deep');
  fs.mkdirSync(deep, { recursive: true });

  const lane = (cwd, as, args) => {
    const r = spawnSync(process.execPath, [LANE, ...args], {
      cwd, env: laneEnv(URL, bx, { CLAUDE_CODE_SESSION_ID: as }), encoding: 'utf8', timeout: 60000,
    });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const json = (r) => { try { return JSON.parse(r.out); } catch { return null; } };
  const one = async (sql, p) => (await probe.query(sql, p)).rows[0];
  const wmRow = (id) => one(`SELECT last_event_id::text AS n, updated_at::text AS t FROM agentic_os.lane_watermark WHERE session_id=$1`, [id]);

  let before = null;
  let after = null;
  try {
    await cleanup(probe); // a killed earlier run may have left rows
    before = await defaultBoardCount(probe);

    for (const [key, name, dir] of [[KEY_A, 'zz-pbprobe A', dirA], [KEY_B, 'zz-pbprobe B', dirB]]) {
      await probe.query(
        `INSERT INTO agentic_os.project (key, display_name, root_path, root_path_norm, status, registry_source, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,'active','project-board-probe', now(), now())`,
        [key, name, dir.replace(/\\/g, '/'), dir.replace(/\\/g, '/').toLowerCase()]);
    }
    for (const [id, dir] of [[SA, dirA], [SB, dirB]]) {
      await probe.query(
        `INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES ($1,$2,'project-board-probe fixture',now())`,
        [id, dir.replace(/\\/g, '/').toLowerCase()]);
    }
    const mk = (id, board) => probe.query(
      `INSERT INTO agentic_os.lane (id,title,track,state,project_key) VALUES ($1,$2,'zz','ready',$3)`, [id, `title of ${id}`, board]);
    await mk(L_A1, KEY_A);
    await mk(L_B1, KEY_B);
    await mk(L_C1, DEFAULT_BOARD);

    // 1. board --json is scoped
    const bA = json(lane(dirA, SA, ['board', '--json']));
    const bB = json(lane(dirB, SB, ['board', '--json']));
    const idsOf = (j) => (j?.lanes ?? []).map((l) => l.id);
    check('(1a) board --json from A lists a1 and not b1', bA?.board === KEY_A && idsOf(bA).includes(L_A1) && !idsOf(bA).includes(L_B1),
      bA ? `board=${bA.board} lanes=${idsOf(bA).join(',')}` : 'no JSON');
    check('(1b) board --json from B lists b1 and not a1', bB?.board === KEY_B && idsOf(bB).includes(L_B1) && !idsOf(bB).includes(L_A1),
      bB ? `board=${bB.board} lanes=${idsOf(bB).join(',')}` : 'no JSON');

    // 2. next
    const nx = json(lane(dirA, SA, ['next', '--json']));
    const nxIds = Array.isArray(nx) ? nx.map((l) => l.id) : [];
    check('(2) next from A offers a1 and never b1', nxIds.includes(L_A1) && !nxIds.includes(L_B1), `next=${nxIds.join(',') || '(none)'}`);

    // 3. claim a foreign lane
    const fence0 = (await one(`SELECT fence::text AS f FROM agentic_os.lane WHERE id=$1`, [L_B1])).f;
    const cl = lane(dirA, SA, ['claim', L_B1]);
    const b1 = await one(`SELECT owner_session_id AS o, fence::text AS f, state FROM agentic_os.lane WHERE id=$1`, [L_B1]);
    check('(3) claim b1 from A is refused and b1 has no owner', cl.code !== 0 && !/CLAIMED/.test(cl.out) && b1.o === null && b1.f === fence0,
      `exit ${cl.code}, owner=${b1.o}, fence ${fence0}->${b1.f}; ${cl.err.split('\n')[0]}`);

    // 4. add a foreign id
    const ad = lane(dirA, SA, ['add', L_B1, '--title', 'hijacked by A']);
    const b1b = await one(`SELECT project_key AS k, title FROM agentic_os.lane WHERE id=$1`, [L_B1]);
    check('(4) add b1 from A fails with "belongs to board" and b1 is unchanged',
      ad.code === 1 && /belongs to board/.test(ad.err) && b1b.k === KEY_B && b1b.title === `title of ${L_B1}`,
      `exit ${ad.code}, project_key=${b1b.k}, title=${JSON.stringify(b1b.title)}; ${ad.err.split('\n')[0]}`);

    // 5. messages. sa broadcasts and sends a DM from A; sb reads on B.
    const bc = lane(dirA, SA, ['say', 'PBPROBE-BROADCAST from A']);
    // Absence on B proves isolation only if the broadcast exists on A. Query the table: an inbox read as SB would move A's watermark, which (6) checks.
    const bcRow = await one(
      `SELECT count(*)::int AS n FROM agentic_os.lane_event
        WHERE session_id=$1 AND to_session_id IS NULL AND project_key=$2 AND body=$3`, [SA, KEY_A, 'PBPROBE-BROADCAST from A']);
    const dm = lane(dirA, SA, ['say', 'PBPROBE-DM from sa', '--to', SB]);
    const inB = json(lane(dirB, SB, ['inbox', '--json'])) ?? [];
    const bodiesB = inB.map((e) => e.body);
    check('(5a) a broadcast from A exists on board A and is absent from B\'s inbox',
      bc.code === 0 && bcRow.n === 1 && bodiesB.length > 0 && !bodiesB.includes('PBPROBE-BROADCAST from A'),
      `say exit ${bc.code}, ${bcRow.n} broadcast row(s) on A; B inbox: ${bodiesB.join(' | ') || '(empty)'}`);
    const dmRow = inB.find((e) => e.body === 'PBPROBE-DM from sa');
    check('(5b) a DM from sa to sb shows in sb\'s inbox from B, from board A', !!dmRow && dmRow.project_key === KEY_A && dm.code === 0,
      dmRow ? `from board ${dmRow.project_key}` : `say exit ${dm.code}: ${dm.all.trim().split('\n')[0]}`);

    // 6. A's inbox must not move B's cursor
    const wmB0 = await wmRow(WM_B);
    const inA = json(lane(dirA, SB, ['inbox', '--json'])) ?? [];
    const wmB1 = await wmRow(WM_B);
    const wmA = await wmRow(WM_A);
    check('(6) reading A\'s inbox leaves B\'s watermark row unchanged',
      !!wmB0 && !!wmB1 && wmB0.n === wmB1.n && wmB0.t === wmB1.t && !!wmA && inA.some((e) => e.body === 'PBPROBE-BROADCAST from A'),
      wmB0 ? `${WM_B}=${wmB0.n}${wmB1 && wmB1.n === wmB0.n ? ' unchanged' : ' CHANGED'}; ${WM_A}=${wmA ? wmA.n : 'missing'}; A inbox ${inA.length} event(s)`
        : `no ${WM_B} row after the B read: the check would be vacuous`);

    // 7. a dir with no board
    const noBoard = lane(dirC, SA, ['board']);
    // C sits in the OS temp dir, which register refuses, so the hint is the --project escape and not the register command.
    check('(7) cwd C (planted .git file, in the temp dir) exits 1 and names --project continuous-claude',
      noBoard.code === 1 && /no lane board for/.test(noBoard.err) && /--project continuous-claude/.test(noBoard.err),
      `exit ${noBoard.code}; ${noBoard.err.trim().split('\n')[0]}`);
    skip('(7b) the lane-context hook returns {} for cwd C', 'the hooks change in the next PR');

    // 8. subfolder
    const sub = json(lane(deep, SA, ['board', '--json']));
    check('(8) a subfolder of A resolves to A', sub?.board === KEY_A, `board=${sub?.board}`);

    // 9. old-style client: no lane.client_version
    const old = await connect(null);
    try {
      const setting = (await old.query(`SELECT coalesce(current_setting('lane.client_version', true), '') AS v`)).rows[0].v;
      let code = null;
      try { await old.query(`UPDATE agentic_os.lane SET note='old client' WHERE id=$1`, [L_B1]); } catch (e) { code = e.code; }
      const own = await old.query(`UPDATE agentic_os.lane SET note='old client ok' WHERE id=$1`, [L_C1]);
      check('(9a) an old-style client is refused with SQLSTATE 42501 on b1', setting === '' && code === '42501', `client_version='${setting}', code=${code}`);
      check('(9b) an old-style client may still update a continuous-claude lane', own.rowCount === 1, `rowCount=${own.rowCount}`);
    } finally { await old.end().catch(() => {}); }

    skip('(12) T6 hook test: a lane owner under an sdk entrypoint gets {} and a moved lease', 'the hooks change in the next PR');
  } finally {
    // 11. cleanup, on a fresh connection
    let cleanErr = null;
    await probe.end().catch(() => {});
    const c2 = await connect().catch((e) => { cleanErr = e; return null; });
    if (c2) {
      try {
        await cleanup(c2);
        after = await defaultBoardCount(c2);
        const left = await fixtureCount(c2);
        check('(11) cleanup removed every zz-pbprobe fixture', left === 0, `${left} row(s) remain`);
      } catch (e) { cleanErr = e; } finally { await c2.end().catch(() => {}); }
    }
    if (cleanErr) check('(11) cleanup removed every zz-pbprobe fixture', false, `cleanup failed: ${cleanErr.message}`);
    bx.cleanup();
  }
  if (before !== null) {
    check('(10) the continuous-claude lane count is the same before and after', after !== null && before === after, `before=${before} after=${after}`);
  }
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; }
if (crashed) {
  process.stderr.write(`project-board-probe could not run: ${crashed.message}\n`);
  process.exit(2);
}
const failed = results.filter((r) => !r.ok).length;
const skipped = results.filter((r) => r.skip).length;
const passed = results.length - failed - skipped;
process.stdout.write(`\nproject-board-probe: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
process.exit(failed ? 1 : 0);
