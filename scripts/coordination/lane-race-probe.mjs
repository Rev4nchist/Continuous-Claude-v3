#!/usr/bin/env node
/**
 * lane-race-probe -- does the lane claim actually admit exactly one winner?
 *
 * WHY THIS EXISTS
 * ---------------
 * The entire value of the lane layer rests on one property: when two sessions
 * reach for the same lane at the same moment, exactly one gets it and the other
 * is TOLD. Everything else -- the board, the notes, the injection -- is
 * presentation. If this property is wrong, the board is worse than nothing,
 * because it would report a coordination that did not happen.
 *
 * This project has already shipped a coordination layer that passed its tests
 * while being broken, twice: the identity repair was verified single-shot and
 * still admitted 6 of 60 intruders under concurrency, and before that a lock
 * that "worked" was blocking sessions against themselves. So this probe runs
 * REAL concurrent processes rather than sequential calls in one event loop --
 * an in-process loop would serialize on the single connection and prove nothing.
 *
 * It also verifies the NEGATIVE cases, because a claim that always succeeds and
 * a claim that always fails both produce a green count if you only test one
 * direction:
 *
 *   1. N racers, one lane            -> exactly 1 win, N-1 denials, fence +1
 *   2. holder alive, lease expired   -> DENIED (both conditions are required)
 *   3. holder gone, lease expired    -> GRANTED (reclamation works at all)
 *   4. holder gone, lease live       -> DENIED (the lease alone still protects)
 *
 * Cases 2 and 4 are the ones that matter. Reclaiming on either condition alone
 * is the exact bug that made the file lock steal files from sessions that were
 * merely mid-turn.
 *
 * Usage: node scripts/coordination/lane-race-probe.mjs [--racers 24]
 * Exit 0 all properties hold | 1 a property failed | 2 could not run.
 */

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CLI = join(HERE, 'lane.mjs');

/** Every artifact this probe creates carries this prefix, so cleanup is a
 *  pattern delete and nothing it leaves behind can be mistaken for real work.
 *  Earlier probes in this repo left fixtures like `z | C:/x.md` in file_claims,
 *  which is exactly the "probe exhaust indistinguishable from a real conflict"
 *  problem that made the coordination tables hard to read. */
const PREFIX = '__laneprobe__';

const args = process.argv.slice(2);
const RACERS = Number(args[args.indexOf('--racers') + 1]) || 24;

function loadPg() {
  for (const a of [join(REPO, '.claude', 'hooks', 'package.json'), join(REPO, 'apps', 'agentic-os', 'package.json')]) {
    try { return createRequire(pathToFileURL(a)).call(null, 'pg'); } catch { /* next */ }
  }
  throw new Error('cannot resolve pg');
}
const { Client } = loadPg();

function db() {
  return new Client({
    connectionString: process.env.CONTINUOUS_CLAUDE_DB_URL || process.env.DATABASE_URL
      || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude',
    connectionTimeoutMillis: 4000,
  });
}

/** Run the real CLI in its own process, so N racers are N OS processes. */
function claim(laneId, asSession) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'claim', laneId, '--as', asSession],
      { cwd: REPO }, (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout), err: String(stderr) });
      });
  });
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}\n`);
};

const c = db();
await c.connect();

const LANE = `${PREFIX}lane`;
const cleanup = async () => {
  await c.query(`DELETE FROM agentic_os.lane_event WHERE lane_id LIKE $1 OR session_id LIKE $1`, [`${PREFIX}%`]);
  await c.query(`DELETE FROM agentic_os.lane WHERE id LIKE $1`, [`${PREFIX}%`]);
  await c.query(`DELETE FROM agentic_os.lane_watermark WHERE session_id LIKE $1`, [`${PREFIX}%`]);
  await c.query(`DELETE FROM sessions WHERE id LIKE $1`, [`${PREFIX}%`]);
};

try {
  await cleanup();

  // ---------------------------------------------------------------- 1. race
  await c.query(
    `INSERT INTO agentic_os.lane (id,title,track,state,priority) VALUES ($1,'race probe','probe','ready',99)`,
    [LANE],
  );
  const fence0 = (await c.query(`SELECT fence FROM agentic_os.lane WHERE id=$1`, [LANE])).rows[0].fence;

  const racers = Array.from({ length: RACERS }, (_, i) => `${PREFIX}r${i}`);
  const settled = await Promise.all(racers.map((s) => claim(LANE, s)));

  const winners = settled.filter((r) => r.code === 0);
  const denied = settled.filter((r) => r.code === 3);
  const broken = settled.filter((r) => r.code !== 0 && r.code !== 3);

  check('exactly one racer wins', winners.length === 1, `${winners.length} won of ${RACERS}`);
  check('every loser is denied cleanly (exit 3)', denied.length === RACERS - 1 && broken.length === 0,
    `${denied.length} denied, ${broken.length} errored`);

  const row = (await c.query(`SELECT * FROM agentic_os.lane WHERE id=$1`, [LANE])).rows[0];
  check('DB agrees exactly one owner', racers.includes(row.owner_session_id), `owner=${row.owner_session_id}`);
  check('fence advanced exactly once', row.fence === fence0 + 1, `${fence0} -> ${row.fence}`);

  // The denial must NAME the holder. "Denied" without a who sends the loser
  // hunting for a bug instead of talking to a person -- and a null holder in
  // the block message is a defect this project has already shipped once.
  // `every` on an empty array is true, so this assertion passed VACUOUSLY under
  // a sabotage run that produced zero denials -- a green line for a property
  // that was never exercised. Require at least one denial before believing it.
  const namesHolder = denied.length > 0
    && denied.every((r) => r.err.includes(row.owner_session_id.slice(0, 8)));
  check('every denial names the real holder', namesHolder,
    denied.length === 0 ? 'no denials produced -- nothing to check' : (namesHolder ? '' : `sample: ${denied[0]?.err.split('\n')[0]}`));

  // ------------------------------------------- 2. live holder, expired lease
  await c.query(
    `INSERT INTO sessions (id, project, working_on, last_heartbeat)
     VALUES ($1,'probe','probe',now())
     ON CONFLICT (id) DO UPDATE SET last_heartbeat=now()`, [row.owner_session_id],
  );
  await c.query(`UPDATE agentic_os.lane SET lease_expires_at = now() - interval '1 hour' WHERE id=$1`, [LANE]);
  const r2 = await claim(LANE, `${PREFIX}intruder`);
  check('live holder + expired lease -> DENIED', r2.code === 3,
    r2.code === 0 ? 'STOLE a lane from a live session' : `exit ${r2.code}`);

  // ------------------------------------------- 3. holder gone, lease expired
  await c.query(`DELETE FROM sessions WHERE id=$1`, [row.owner_session_id]);
  const r3 = await claim(LANE, `${PREFIX}reclaimer`);
  check('dead holder + expired lease -> GRANTED', r3.code === 0, `exit ${r3.code}`);
  const row3 = (await c.query(`SELECT * FROM agentic_os.lane WHERE id=$1`, [LANE])).rows[0];
  check('reclaim advanced the fence', row3.fence === fence0 + 2, `${row.fence} -> ${row3.fence}`);

  // ---------------------------------------------- 4. holder gone, lease live
  // The reclaimer holds it with a fresh 90m lease and has no sessions row.
  const r4 = await claim(LANE, `${PREFIX}latecomer`);
  check('dead holder + live lease -> DENIED', r4.code === 3,
    r4.code === 0 ? 'lease alone did not protect the claim' : `exit ${r4.code}`);

} catch (e) {
  process.stderr.write(`probe could not run: ${e.message}\n`);
  await cleanup().catch(() => {});
  await c.end().catch(() => {});
  process.exit(2);
}

await cleanup();
const left = (await c.query(
  `SELECT (SELECT count(*) FROM agentic_os.lane WHERE id LIKE $1)::int
        + (SELECT count(*) FROM sessions WHERE id LIKE $1)::int AS n`, [`${PREFIX}%`],
)).rows[0].n;
check('probe left no fixtures behind', left === 0, `${left} row(s) remain`);
await c.end();

const failed = results.filter((r) => !r.pass);
process.stdout.write(`\n${results.length - failed.length}/${results.length} properties hold\n`);
process.exit(failed.length ? 1 : 0);
