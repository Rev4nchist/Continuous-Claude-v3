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
import { readFileSync } from 'node:fs';
import { requireDep } from '../lib/resolve-deps.mjs';

// `pg` is a dependency of the hooks package, not of the repo root, and ESM
// resolves from the importing FILE rather than the cwd — so this script cannot
// just `import 'pg'`. The shared resolver (scripts/lib/resolve-deps.mjs) finds it
// in this checkout or the primary one, so no second copy of the driver is added.
let pg;
try { pg = requireDep('pg'); } catch (e) { console.error(`claim-sql-probe: ${e.message}`); process.exit(2); }

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
  //
  // These tokens are chosen to span the WHOLE statement, head to tail, because
  // the realistic failure is TRUNCATION, not replacement. It happened: an
  // unescaped backtick in a SQL comment ended the TS template early, extraction
  // stopped mid-sentence, and the fragment still contained $7 and ON CONFLICT
  // from the head -- so an earlier version of this guard passed it straight
  // through to Postgres, which answered with a bare syntax error.
  //
  // RETURNING and the final projection are last in the text, so requiring them
  // proves the tail arrived. The trailing-newline check catches a truncation
  // that happens to land after them.
  const required = [
    'ON CONFLICT',        // head
    'expires_at < NOW()', // the reclamation rule
    'last_heartbeat',     // the other half
    // ...and it must be the CORRECT other half. Bare last_heartbeat measures the
    // human typing, not the agent working, so the lock classified a session that
    // had been editing for 25 minutes as dead and offered its claims to anyone
    // (verified on session 079ae1e7, 2026-07-28). Requiring the token here means
    // a revert to the bare column cannot reach Postgres through this probe.
    // Structural enforcement across all call sites:
    // scripts/coordination/liveness-predicate-guard.mjs
    'last_activity_at',
    '$7',                 // break-glass param
    'RETURNING',          // tail of the upsert CTE
    'prior_holder_stale', // the very last projection
  ];
  for (const token of required) {
    if (!out.includes(token)) {
      throw new Error(
        `claim-sql-probe: extracted SQL is missing ${token} -- refusing to run. ` +
        `This usually means the literal was TRUNCATED (an unescaped backtick in a ` +
        `SQL comment will do it), not that the statement changed.`);
    }
  }
  // A statement that ends mid-comment has no business reaching the database.
  if (/--[^\n]*$/.test(out.trimEnd())) {
    throw new Error('claim-sql-probe: extracted SQL ends inside a comment -- truncated');
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
    `INSERT INTO sessions (id, project, last_heartbeat, last_activity_at) VALUES
       ('fxprobe-active',  $1, NOW(),                        NOW()),
       ('fxprobe-stale',   $1, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes'),
       ('fxprobe-me',      $1, NOW(),                        NOW()),
       -- The session the lock used to get WRONG: its human stopped typing 25
       -- minutes ago, so last_heartbeat is long stale, but the agent has been
       -- editing continuously and last_activity_at is current. Under the old
       -- bare-heartbeat rule this session reads as DEAD and its claims were
       -- offered to anyone. Case 3c is the assertion that it no longer is.
       ('fxprobe-working', $1, NOW() - INTERVAL '25 minutes', NOW())`,
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

  // --- case 3c: the holder is WORKING but its human is not typing ---------
  // Lease EXPIRED and heartbeat STALE -- i.e. every condition the old rule
  // required for takeover -- but last_activity_at is current, so the holder is
  // alive and must keep its claim. This is the regression the whole fix is
  // about, and it is deliberately the mirror image of case 3: identical setup,
  // opposite expected outcome, and the ONLY difference is last_activity_at.
  //
  // NEGATIVE CONTROL, actually run on 2026-07-28 rather than asserted: reverting
  // ONLY the ON CONFLICT predicate to bare last_heartbeat makes this case return
  // 'takeover' -- FAILED 1/16. So the fix is load-bearing and this case can fail.
  //
  // Worth knowing what that run also showed: `prior_holder_stale` stayed FALSE
  // while the statement handed the claim away, because the classifier at the
  // tail of the statement had already been fixed and the ON CONFLICT branch had
  // not. The recorded facts contradicted the action taken. That is why the
  // second assertion below checks the classifier SEPARATELY from the outcome --
  // either one alone can agree with you while the other is wrong.
  await admin.query(
    `INSERT INTO file_claims (file_path, project, session_id, claimed_at, expires_at)
     VALUES ('/fx/b3.ts', $1, 'fxprobe-working', NOW(), NOW() - INTERVAL '1 minute')
     ON CONFLICT (file_path, project) DO UPDATE
       SET session_id = EXCLUDED.session_id, expires_at = EXCLUDED.expires_at`,
    [PROJECT],
  );
  const c3c = await resolve(admin, '/fx/b3.ts', 'fxprobe-me');
  check('3c working holder (stale heartbeat, live activity) is NOT taken over',
    c3c.outcome, 'blocked');
  check('3c and it is classified as alive, not merely lease-protected',
    c3c.row.prior_holder_stale, false);

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
  // How MANY losers are blind is timing-dependent, and measuring it taught me
  // my own first guess was wrong: I asserted all 23 and observed 4. A racer is
  // blind only if its snapshot was taken before the winner COMMITTED; racers
  // that arrive later see the row and report it correctly. So the honest
  // assertion is that the blind spot is demonstrable, not that it is universal.
  const losers = raced.filter((r) => r.outcome === 'blocked');
  const blindLosers = losers.filter((r) => r.row.prior_owner === null).length;
  console.log(`      of ${losers.length} blocked racers, ${blindLosers} could not name the winner`);
  check('5b at least one racer proves the raw statement CANNOT name the winner',
    blindLosers >= 1, true);

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
