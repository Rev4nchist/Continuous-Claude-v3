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
import { readFileSync } from 'node:fs';

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
const TTL_SECS = 600;

/**
 * The statement under test, READ OUT OF THE SOURCE THE HOOK ACTUALLY USES.
 *
 * This used to be a verbatim copy, under a comment asserting that keeping it
 * here meant "the probe and the hook cannot drift apart silently." That was
 * exactly backwards, and it failed the first time it was tested: step 5 changed
 * the real statement to require an expired lease as well as a stale heartbeat,
 * and this probe went on passing 11/11 against the superseded copy. A guard
 * against drift that is itself a copy IS the drift.
 *
 * So the text is extracted from db-utils-pg.ts at run time. If the marker moves
 * or the extraction fails, the probe ABORTS rather than falling back to a
 * literal — a probe with no statement to test must not report success.
 */
function extractClaimSql() {
  const src = readFileSync(
    new URL('../../.claude/hooks/src/shared/db-utils-pg.ts', import.meta.url), 'utf-8');

  const marker = 'const RESOLVE_CLAIM_SQL = `';
  const start = src.indexOf(marker);
  if (start === -1) {
    throw new Error(
      'claim-sql-probe: could not find RESOLVE_CLAIM_SQL in db-utils-pg.ts. ' +
      'If it was renamed or moved, update this extractor -- do NOT paste a copy back in.');
  }

  // Walk to the closing backtick, honouring escapes: the SQL comments contain
  // \` sequences because the whole thing lives inside a template literal.
  let i = start + marker.length;
  let out = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && src[i + 1] === '`') { out += '`'; i++; continue; }
    if (c === '`') break;
    out += c;
  }
  if (i >= src.length) throw new Error('claim-sql-probe: unterminated RESOLVE_CLAIM_SQL literal');

  // The extracted statement must still be the thing this probe thinks it is.
  // Without this, a future edit could silently reduce it to something trivial
  // and every case below would keep passing.
  for (const required of ['ON CONFLICT', 'expires_at < NOW()', 'last_heartbeat', '$7']) {
    if (!out.includes(required)) {
      throw new Error(`claim-sql-probe: extracted SQL is missing ${required} -- refusing to run`);
    }
  }
  return out;
}

export const CLAIM_SQL = extractClaimSql();

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

async function resolve(client, filePath, me, { breakGlass = false } = {}) {
  // $5 lease TTL, $6 lease class, $7 break-glass -- added in step 5. The probe
  // passes the ordinary file-class TTL because these cases are about the
  // reclamation RULE, not about classification; lease-probe.mjs covers the
  // class-to-TTL mapping against the real hook.
  const res = await client.query(CLAIM_SQL,
    [filePath, PROJECT, me, STALE_SECS, TTL_SECS, 'file', breakGlass]);
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

  // --- case 3: a stale session holds it, AND its lease has run out -------
  // Both halves are set explicitly. Since step 5 a stale heartbeat alone is not
  // enough, and expires_at DEFAULTS to a live lease -- so a fixture that omits
  // it silently describes a different situation than its name claims.
  await admin.query(
    `INSERT INTO file_claims (file_path, project, session_id, claimed_at, expires_at)
     VALUES ('/fx/b.ts', $1, 'fxprobe-stale', NOW(), NOW() - INTERVAL '1 minute')
     ON CONFLICT (file_path, project) DO UPDATE
       SET session_id = EXCLUDED.session_id, expires_at = EXCLUDED.expires_at`,
    [PROJECT],
  );
  const c3 = await resolve(admin, '/fx/b.ts', 'fxprobe-me');
  check('3 stale holder with an expired lease is taken over', c3.outcome, 'takeover');
  check('3 prior holder is reported', c3.row.prior_owner, 'fxprobe-stale');

  // --- case 3b: stale holder whose lease is STILL LIVE -------------------
  // The mixed quadrant, at the SQL level. Reclamation needs both conditions.
  await admin.query(
    `INSERT INTO file_claims (file_path, project, session_id, claimed_at, expires_at)
     VALUES ('/fx/b2.ts', $1, 'fxprobe-stale', NOW(), NOW() + INTERVAL '5 minutes')
     ON CONFLICT (file_path, project) DO UPDATE
       SET session_id = EXCLUDED.session_id, expires_at = EXCLUDED.expires_at`,
    [PROJECT],
  );
  check('3b stale holder with a LIVE lease is NOT taken over',
    (await resolve(admin, '/fx/b2.ts', 'fxprobe-me')).outcome, 'blocked');
  check('3b break-glass gets through anyway',
    (await resolve(admin, '/fx/b2.ts', 'fxprobe-me', { breakGlass: true })).outcome, 'takeover');

  // --- case 4: an ACTIVE session holds it -------------------------------
  await admin.query(
    `INSERT INTO file_claims (file_path, project, session_id, claimed_at, expires_at)
     VALUES ('/fx/c.ts', $1, 'fxprobe-active', NOW(), NOW() + INTERVAL '5 minutes')
     ON CONFLICT (file_path, project) DO UPDATE
       SET session_id = EXCLUDED.session_id, expires_at = EXCLUDED.expires_at`,
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
      .then((r) => ({ outcome: r.outcome, row: r.row }))
      .catch((e) => ({ outcome: `error:${e.message}`, row: {} }))),
  );
  await Promise.all(racers.map((c) => c.end().catch(() => {})));

  const outcomes = raced.map((r) => r.outcome);
  const granted = outcomes.filter((o) => o === 'granted').length;
  const blocked = outcomes.filter((o) => o === 'blocked').length;
  const errored = outcomes.filter((o) => String(o).startsWith('error')).length;
  console.log(`      race n=${N}: granted=${granted} blocked=${blocked} errored=${errored}`);
  check('5 exactly one winner on an unclaimed file', granted, 1);
  check('5 everyone else is blocked', blocked, N - 1);
  check('5 nobody errored', errored, 0);

  // --- case 5b: PIN the statement's known blind spot ----------------------
  // This is an assertion that the SQL alone is INSUFFICIENT, which is a strange
  // thing to test until you know why it is here.
  //
  // Case 5 above counted outcomes and passed green while all 23 blocked racers
  // carried prior_owner = NULL. The `prior` CTE reads the statement snapshot,
  // taken before any of them had a row to see; the ON CONFLICT WHERE re-reads
  // the latest committed row. They disagree under exactly this contention. Left
  // there, every blocked session told a human the file was "held by session
  // undefined" and wrote an event whose holder and rule-halves were null.
  //
  // The repair could not go in this statement -- recovering the winner needs a
  // SECOND statement, so that READ COMMITTED gives it a fresh snapshot. It
  // therefore lives in resolveFileClaim, and lease-probe.mjs asserts the
  // recovered behaviour end-to-end against the real hook.
  //
  // What is pinned here is the reason that second read exists. If a future
  // Postgres version or rewrite ever makes `prior` see the winner, this check
  // fails loudly and tells the next person the workaround may be removable --
  // rather than leaving a mysterious extra query nobody dares touch.
  const losers = raced.filter((r) => r.outcome === 'blocked');
  const blindLosers = losers.filter((r) => r.row.prior_owner === null).length;
  check('5b the raw statement CANNOT name the winner (why the 2nd read exists)',
    blindLosers, N - 1);

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
