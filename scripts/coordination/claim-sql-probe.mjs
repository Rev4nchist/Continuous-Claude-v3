#!/usr/bin/env node
/**
 * Proves the atomic claim statement before it goes anywhere near the hook.
 *
 * The claim path used to be three round trips — check, is-the-holder-alive,
 * claim — with two races in the gaps:
 *
 *   1. Two sessions both see an UNCLAIMED file and both write. Last writer wins
 *      silently; both are told they may edit. The load probe cannot see this,
 *      because it always starts from a file that is already held.
 *   2. The holder's liveness is read AFTER the claim row, so the answer can be
 *      stale by the time it is used.
 *
 * One statement closes both. `INSERT ... ON CONFLICT DO UPDATE ... WHERE` takes
 * a row lock and re-evaluates its WHERE against the LATEST committed row, not
 * the statement snapshot, so concurrent callers serialize on the conflicting
 * row. Zero rows returned means somebody else holds it.
 *
 * Case 5 is the one that matters — it is the property that had no test at all.
 *
 * Usage: node scripts/coordination/claim-sql-probe.mjs [--keep]
 * Exits non-zero on any failed case. Removes its own fixtures unless --keep.
 */
import { createRequire } from 'node:module';

// `pg` is a dependency of the hooks package, not of the repo root, and ESM
// resolves from the importing FILE rather than the cwd — so this script cannot
// just `import 'pg'`. Borrow the hooks package's resolution root instead of
// adding a second copy of the driver to the repo.
const require = createRequire(new URL('../../.claude/hooks/package.json', import.meta.url));
const pg = require('pg');

const DB_URL = process.env.CONTINUOUS_CLAUDE_DB_URL
  || process.env.DATABASE_URL
  || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';

const PROJECT = '__step4_claim_probe__';
const STALE_SECS = 300;

/** The statement under test. Kept here verbatim so the probe and the hook cannot drift apart silently. */
export const CLAIM_SQL = `
WITH prior AS (
  SELECT session_id, claimed_at
  FROM file_claims
  WHERE file_path = $1 AND project = $2
),
upsert AS (
  INSERT INTO file_claims (file_path, project, session_id, claimed_at)
  VALUES ($1, $2, $3, NOW())
  ON CONFLICT (file_path, project) DO UPDATE
    SET session_id = EXCLUDED.session_id, claimed_at = NOW()
    WHERE file_claims.session_id = EXCLUDED.session_id
       OR NOT EXISTS (
            SELECT 1 FROM sessions s
            WHERE s.id = file_claims.session_id
              AND s.last_heartbeat >= NOW() - make_interval(secs => $4)
          )
  RETURNING session_id
)
SELECT (SELECT session_id FROM upsert) AS new_owner,
       (SELECT session_id FROM prior)  AS prior_owner,
       (SELECT claimed_at  FROM prior) AS prior_claimed_at
`;

function outcomeOf(row, me) {
  if (row.new_owner === null) return 'blocked';
  if (row.prior_owner === null) return 'granted';
  if (row.prior_owner === me) return 'renewed';
  return 'takeover';
}

async function connect() {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 4000 });
  c.on('error', () => {});
  await c.connect();
  return c;
}

async function resolve(client, filePath, me) {
  const res = await client.query(CLAIM_SQL, [filePath, PROJECT, me, STALE_SECS]);
  return { outcome: outcomeOf(res.rows[0], me), row: res.rows[0] };
}

const results = [];
function check(name, got, want) {
  const ok = got === want;
  results.push({ name, got, want, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got}${ok ? '' : ` (wanted ${want})`}`);
}

async function main() {
  const admin = await connect();

  // --- fixtures ---------------------------------------------------------
  await admin.query(`DELETE FROM file_claims WHERE project = $1`, [PROJECT]);
  await admin.query(`DELETE FROM sessions WHERE id LIKE 'fxprobe-%'`);
  await admin.query(
    `INSERT INTO sessions (id, project, last_heartbeat) VALUES
       ('fxprobe-active', $1, NOW()),
       ('fxprobe-stale',  $1, NOW() - INTERVAL '10 minutes'),
       ('fxprobe-me',     $1, NOW())`,
    [PROJECT],
  );

  // --- case 1: nobody holds it -----------------------------------------
  check('1 unclaimed file is granted', (await resolve(admin, '/fx/a.ts', 'fxprobe-me')).outcome, 'granted');

  // --- case 2: I already hold it (must NOT self-block) ------------------
  check('2 my own claim renews', (await resolve(admin, '/fx/a.ts', 'fxprobe-me')).outcome, 'renewed');

  // --- case 3: a stale session holds it ---------------------------------
  await admin.query(
    `INSERT INTO file_claims (file_path, project, session_id, claimed_at)
     VALUES ('/fx/b.ts', $1, 'fxprobe-stale', NOW())
     ON CONFLICT (file_path, project) DO UPDATE SET session_id = EXCLUDED.session_id`,
    [PROJECT],
  );
  const c3 = await resolve(admin, '/fx/b.ts', 'fxprobe-me');
  check('3 stale holder is taken over', c3.outcome, 'takeover');
  check('3 prior holder is reported', c3.row.prior_owner, 'fxprobe-stale');

  // --- case 4: an ACTIVE session holds it -------------------------------
  await admin.query(
    `INSERT INTO file_claims (file_path, project, session_id, claimed_at)
     VALUES ('/fx/c.ts', $1, 'fxprobe-active', NOW())
     ON CONFLICT (file_path, project) DO UPDATE SET session_id = EXCLUDED.session_id`,
    [PROJECT],
  );
  const c4 = await resolve(admin, '/fx/c.ts', 'fxprobe-me');
  check('4 active holder blocks', c4.outcome, 'blocked');
  check('4 holder is identified', c4.row.prior_owner, 'fxprobe-active');

  const stillHeld = await admin.query(
    `SELECT session_id FROM file_claims WHERE file_path='/fx/c.ts' AND project=$1`, [PROJECT],
  );
  check('4 blocked attempt did NOT steal the claim', stillHeld.rows[0].session_id, 'fxprobe-active');

  // --- case 5: THE RACE. N sessions, one unclaimed file, all at once ----
  // This is the property that never had a test. Under the old three-round-trip
  // path every one of these would be told "no claim exists — go ahead".
  const N = 24;
  const racers = await Promise.all(Array.from({ length: N }, () => connect()));
  await admin.query(
    `INSERT INTO sessions (id, project, last_heartbeat)
     SELECT 'fxprobe-race-' || g, $1, NOW() FROM generate_series(1, $2) g
     ON CONFLICT (id) DO UPDATE SET last_heartbeat = NOW()`,
    [PROJECT, N],
  );

  const raced = await Promise.all(
    racers.map((c, i) => resolve(c, '/fx/race.ts', `fxprobe-race-${i + 1}`)
      .then((r) => r.outcome)
      .catch((e) => `error:${e.message}`)),
  );
  await Promise.all(racers.map((c) => c.end().catch(() => {})));

  const granted = raced.filter((o) => o === 'granted').length;
  const blocked = raced.filter((o) => o === 'blocked').length;
  const errored = raced.filter((o) => String(o).startsWith('error')).length;
  console.log(`      race n=${N}: granted=${granted} blocked=${blocked} errored=${errored}`);
  check('5 exactly one winner on an unclaimed file', granted, 1);
  check('5 everyone else is blocked', blocked, N - 1);
  check('5 nobody errored', errored, 0);

  // --- teardown ---------------------------------------------------------
  if (!process.argv.includes('--keep')) {
    await admin.query(`DELETE FROM file_claims WHERE project = $1`, [PROJECT]);
    await admin.query(`DELETE FROM sessions WHERE id LIKE 'fxprobe-%'`);
    const left = await admin.query(
      `SELECT (SELECT count(*) FROM file_claims WHERE project=$1)
            + (SELECT count(*) FROM sessions WHERE id LIKE 'fxprobe-%') AS n`, [PROJECT],
    );
    check('6 fixtures fully removed', Number(left.rows[0].n), 0);
  }
  await admin.end();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? `FAILED ${failed.length}/${results.length}` : `ALL ${results.length} CASES PASS`}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('probe crashed:', e); process.exit(1); });
