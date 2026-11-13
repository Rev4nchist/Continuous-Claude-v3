/**
 * Does the two-condition reclamation rule actually hold?
 *
 * THE PROPERTY UNDER TEST
 * -----------------------
 * A claim may be taken from its holder only when BOTH:
 *   1. the holder's LEASE has expired, and
 *   2. the holder's session HEARTBEAT is stale.
 *
 * Either condition alone is what produced the original false positives, so the
 * interesting cases are not the two obvious ones — they are the two MIXED
 * quadrants, where exactly one condition holds and the answer must still be
 * "no". Those two are the whole point of the change and nothing else tests them:
 *
 *   B (lease live, holder stale)  — the OLD code took the file here.
 *   C (lease expired, holder alive) — the "long build / long prompt / sleep and
 *     resume" case the plan required be tested BEFORE reclamation was enabled.
 *
 * This drives the REAL dist/file-claims.mjs over stdin, exactly as Claude Code
 * does, and then asks the database what it did. A unit test against the SQL
 * would not catch a hook that was built but never wired, or one whose decision
 * and recorded event disagree.
 *
 * Run after any change to leases.ts, db-utils-pg.ts, or file-claims.ts.
 * Cleans up its own fixtures.
 *
 *   node scripts/coordination/lease-probe.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { canonProject, repoPath } from './canon-home.mjs';
import { assertScratchUrl, dbNameOf } from './scratch-db.mjs';

// Rule O3.9: this probe writes, so it runs on a scratch database only. Refuse before any psql call or child process.
const DB_URL = process.env.CONTINUOUS_CLAUDE_DB_URL || process.env.DATABASE_URL || process.env.OPC_POSTGRES_URL || '';
let DB_NAME;
try { DB_NAME = assertScratchUrl(DB_URL); } catch {
  process.stderr.write(`lease-probe: refusing to run: database '${dbNameOf(DB_URL) || '(no name)'}' is not a scratch database. `
    + "Set CONTINUOUS_CLAUDE_DB_URL to one made by 'node scripts/coordination/scratch-db.mjs create --through 6' (name starts with lanes_pr1_).\n");
  process.exit(2);
}
// psql below takes DB_NAME, the value assertScratchUrl returned. The hooks this probe starts read the same scratch database.
process.env.CONTINUOUS_CLAUDE_DB_URL = DB_URL;
process.env.DATABASE_URL = DB_URL;
process.env.OPC_POSTGRES_URL = DB_URL;
// The hooks spawned here log their denies. Send that log to a temp file, never the real ~/.claude/logs one.
process.env.CCV3_GUARD_DECISIONS_LOG ||= (process.env.TEMP || process.env.TMPDIR || '/tmp') + `/ccv3-probe-guard-decisions-${process.pid}.jsonl`; // one file per run, so two runs never mix rows

const REPO = repoPath();
const CANON = canonProject();
console.log(`canonical project: ${CANON}`);

// One harness-class path and one ordinary path, so the class distinction is
// exercised rather than assumed. Neither file exists; the hook never opens it.
const HARNESS_FILE = join(REPO, '.claude', 'hooks', 'src', '__step5probe__.ts');
const PLAIN_FILE = join(REPO, 'docs', '__step5probe__.md');

const HOLDER = 'step5-holder-0000-0000-000000000000';
const INTRUDER = 'step5-intruder-0000-0000-00000000000';

function psql(sql) {
  return execFileSync('docker',
    ['exec', 'continuous-claude-postgres', 'psql', '-U', 'claude', '-d', DB_NAME,
      '-t', '-A', '-c', sql],
    { encoding: 'utf-8' }).trim();
}

function runClaim(sessionId, filePath, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`${REPO}/.claude/hooks/dist/file-claims.mjs`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    child.stdin.end(JSON.stringify({
      session_id: sessionId, cwd: REPO, tool_name: 'Edit', tool_input: { file_path: filePath },
    }));
  });
}

/** 'deny' or 'continue' — the only thing the caller of a PreToolUse hook sees. */
function verdict(res) {
  try {
    const j = JSON.parse(res.out);
    return j.hookSpecificOutput?.permissionDecision ?? j.result ?? 'malformed';
  } catch {
    return `unparseable:${res.out.slice(0, 40)}`;
  }
}

/** The prose a blocked human actually reads. Untested prose lies. */
function denyReason(res) {
  try {
    return JSON.parse(res.out).hookSpecificOutput?.permissionDecisionReason ?? '';
  } catch {
    return '';
  }
}

const results = [];
const check = (name, got, want) => {
  const ok = got === want;
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(got)}${ok ? '' : `  (wanted ${JSON.stringify(want)})`}`);
};
const checkNear = (name, got, want, tol) => {
  const ok = Number.isFinite(got) && Math.abs(got - want) <= tol;
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got}${ok ? '' : `  (wanted ${want} +/- ${tol})`}`);
};

const sqlLit = (s) => s.replace(/'/g, "''");

function purge() {
  psql(`
    DELETE FROM file_claims WHERE file_path IN ('${sqlLit(HARNESS_FILE)}', '${sqlLit(PLAIN_FILE)}');
    DELETE FROM sessions WHERE id LIKE 'step5-%';
    DELETE FROM agentic_os.coordination_event WHERE session_id LIKE 'step5-%';
  `);
}

/**
 * Put the world in a known state: a holder with a chosen heartbeat age, holding
 * a chosen file with a chosen lease age. Both offsets are applied by the
 * DATABASE, against the same clock the rule is evaluated on — computing them
 * here would put a UTC-5 machine clock on one side of a UTC comparison.
 */
function given({ file, leaseOffset, heartbeatOffset }) {
  psql(`
    DELETE FROM file_claims WHERE file_path = '${sqlLit(file)}';
    INSERT INTO sessions (id, project, last_heartbeat)
      VALUES ('${HOLDER}', '${CANON}', NOW() + INTERVAL '${heartbeatOffset}')
      ON CONFLICT (id) DO UPDATE SET last_heartbeat = NOW() + INTERVAL '${heartbeatOffset}';
    INSERT INTO file_claims (file_path, project, session_id, claimed_at, expires_at, fence, lease_class)
      VALUES ('${sqlLit(file)}', '${CANON}', '${HOLDER}', NOW(),
              NOW() + INTERVAL '${leaseOffset}', nextval('coordination_fence_seq'), 'file');
  `);
}

const owner = (file) =>
  psql(`SELECT coalesce(session_id,'none') FROM file_claims WHERE file_path='${sqlLit(file)}'`);
const fenceOf = (file) =>
  Number(psql(`SELECT coalesce(fence,-1) FROM file_claims WHERE file_path='${sqlLit(file)}'`));
const ttlLeft = (file) =>
  Number(psql(`SELECT coalesce(EXTRACT(EPOCH FROM (expires_at - NOW()))::int, -99999)
               FROM file_claims WHERE file_path='${sqlLit(file)}'`));

async function main() {
  purge();

  // ===================================================================
  // THE FOUR QUADRANTS
  // ===================================================================

  // --- A: lease live, holder alive -> deny (the obvious one) ---------
  given({ file: PLAIN_FILE, leaseOffset: '5 minutes', heartbeatOffset: '0 seconds' });
  const aRes = await runClaim(INTRUDER, PLAIN_FILE);
  check('A live lease + live holder denies', verdict(aRes), 'deny');
  check('A holder keeps the claim', owner(PLAIN_FILE), HOLDER);
  // The live-lease message must still quote a concrete wait -- otherwise the
  // expired-lease fix below could have been "delete the useful sentence".
  check('A the message quotes a concrete wait',
    /runs for another \d+ minutes?/.test(denyReason(aRes)), true);

  // --- B: lease live, holder STALE -> deny (BEHAVIOUR CHANGE) --------
  // The old rule reclaimed here on the heartbeat alone. A session mid-way
  // through a long agent turn looks exactly like this, and used to have its own
  // file taken while it was actively editing.
  given({ file: PLAIN_FILE, leaseOffset: '5 minutes', heartbeatOffset: '-30 minutes' });
  check('B live lease + STALE holder still denies',
    verdict(await runClaim(INTRUDER, PLAIN_FILE)), 'deny');
  check('B holder keeps the claim', owner(PLAIN_FILE), HOLDER);
  check('B the block says the lease was NOT expired',
    psql(`SELECT detail->>'leaseExpired' FROM agentic_os.coordination_event
          WHERE kind='claim_blocked' AND session_id='${INTRUDER}'
          ORDER BY id DESC LIMIT 1`), 'false');
  check('B ... and that the holder WAS stale',
    psql(`SELECT detail->>'holderStale' FROM agentic_os.coordination_event
          WHERE kind='claim_blocked' AND session_id='${INTRUDER}'
          ORDER BY id DESC LIMIT 1`), 'true');

  // --- C: lease EXPIRED, holder alive -> deny (the required test) ----
  // Long build, long prompt, sleep-and-resume: idle enough for a 10-minute lease
  // to lapse, but demonstrably alive. Must never be preempted.
  given({ file: PLAIN_FILE, leaseOffset: '-1 minutes', heartbeatOffset: '-10 seconds' });
  const cRes = await runClaim(INTRUDER, PLAIN_FILE);
  check('C expired lease + LIVE holder still denies', verdict(cRes), 'deny');

  // The MESSAGE, not just the verdict. In this quadrant holderExpiresAt is in
  // the PAST, and a naive "time until expiry" render produced the sentence
  // "Their file lease runs for another now" -- broken English promising the
  // wait was over when it had not started. What actually governs the wait here
  // is the heartbeat, so the message has to say so.
  check('C the message does not claim the lease still has time left',
    /runs for another/.test(denyReason(cRes)), false);
  check('C the message names what the wait ACTUALLY depends on',
    /heartbeat/i.test(denyReason(cRes)), true);
  check('C the message never renders the empty duration "now"',
    /another now|for now\b/.test(denyReason(cRes)), false);

  check('C holder keeps the claim', owner(PLAIN_FILE), HOLDER);
  check('C the block says the lease WAS expired',
    psql(`SELECT detail->>'leaseExpired' FROM agentic_os.coordination_event
          WHERE kind='claim_blocked' AND session_id='${INTRUDER}'
          ORDER BY id DESC LIMIT 1`), 'true');
  check('C ... and that the holder was NOT stale',
    psql(`SELECT detail->>'holderStale' FROM agentic_os.coordination_event
          WHERE kind='claim_blocked' AND session_id='${INTRUDER}'
          ORDER BY id DESC LIMIT 1`), 'false');

  // --- D: both -> takeover (the only permitted reclamation) ----------
  given({ file: PLAIN_FILE, leaseOffset: '-1 minutes', heartbeatOffset: '-30 minutes' });
  const fenceBefore = fenceOf(PLAIN_FILE);
  check('D expired lease + stale holder takes over',
    verdict(await runClaim(INTRUDER, PLAIN_FILE)), 'continue');
  check('D the intruder now owns it', owner(PLAIN_FILE), INTRUDER);
  check('D exactly one takeover was recorded',
    Number(psql(`SELECT count(*) FROM agentic_os.coordination_event
                 WHERE kind='claim_takeover' AND session_id='${INTRUDER}'`)), 1);
  check('D the fence advanced', fenceOf(PLAIN_FILE) > fenceBefore, true);
  check('D the event records the generation it replaced',
    Number(psql(`SELECT detail->>'fenceFrom' FROM agentic_os.coordination_event
                 WHERE kind='claim_takeover' AND session_id='${INTRUDER}'
                 ORDER BY id DESC LIMIT 1`)), fenceBefore);

  // ===================================================================
  // LEASE MECHANICS
  // ===================================================================

  // --- renewal keeps the generation and pushes the expiry out --------
  purge();
  await runClaim(HOLDER, PLAIN_FILE);
  const f1 = fenceOf(PLAIN_FILE);
  psql(`UPDATE file_claims SET expires_at = NOW() + INTERVAL '30 seconds'
        WHERE file_path='${sqlLit(PLAIN_FILE)}'`);
  await runClaim(HOLDER, PLAIN_FILE);
  check('renewal keeps the same lease generation', fenceOf(PLAIN_FILE), f1);
  checkNear('renewal pushes the expiry back out', ttlLeft(PLAIN_FILE), 600, 30);

  // --- TTL comes from the lease CLASS, not a constant ----------------
  purge();
  await runClaim(HOLDER, PLAIN_FILE);
  check('an ordinary file is class file', psql(
    `SELECT lease_class FROM file_claims WHERE file_path='${sqlLit(PLAIN_FILE)}'`), 'file');
  checkNear('... and leases for 10 minutes', ttlLeft(PLAIN_FILE), 600, 30);

  await runClaim(HOLDER, HARNESS_FILE);
  check('harness source is class harness:src', psql(
    `SELECT lease_class FROM file_claims WHERE file_path='${sqlLit(HARNESS_FILE)}'`), 'harness:src');
  checkNear('... and leases for 60 minutes', ttlLeft(HARNESS_FILE), 3600, 60);

  // --- a claim with NO lease must not wedge the file forever ---------
  // NULL < NOW() is NULL, so an unguarded rule would leave this file blocked
  // permanently: no expiry, no heartbeat and no release could free it.
  purge();
  psql(`
    INSERT INTO sessions (id, project, last_heartbeat)
      VALUES ('${HOLDER}', '${CANON}', NOW() - INTERVAL '30 minutes');
    INSERT INTO file_claims (file_path, project, session_id, claimed_at, expires_at)
      VALUES ('${sqlLit(PLAIN_FILE)}', '${CANON}', '${HOLDER}', NOW(), NULL);
  `);
  check('a NULL lease degrades to the heartbeat rule instead of wedging',
    verdict(await runClaim(INTRUDER, PLAIN_FILE)), 'continue');

  // --- the timestamps we hand out are the RIGHT INSTANT ---------------
  // These columns are `timestamp without time zone` holding UTC, and node-pg
  // reads that type as LOCAL time -- a five-hour error on this machine that has
  // already shipped twice (a future-dated lane board, and the holderClaimedAt
  // in every event before this change). Assert the round trip rather than
  // trusting the cast.
  purge();
  given({ file: PLAIN_FILE, leaseOffset: '5 minutes', heartbeatOffset: '0 seconds' });
  await runClaim(INTRUDER, PLAIN_FILE);
  const skewSecs = Number(psql(
    `SELECT abs(EXTRACT(EPOCH FROM (
        ((detail->>'holderExpiresAt')::timestamptz) - (NOW() + INTERVAL '5 minutes')
     )))::int
     FROM agentic_os.coordination_event
     WHERE kind='claim_blocked' AND session_id='${INTRUDER}' ORDER BY id DESC LIMIT 1`));
  checkNear('the recorded lease expiry is the real instant, not off by a timezone',
    skewSecs, 0, 30);

  // ===================================================================
  // CONTENTION -- a blocked session must know WHO blocked it
  // ===================================================================
  // The regression this guards was found by adversarial review and then
  // reproduced: racing N sessions for an UNCLAIMED file, every loser's `prior`
  // CTE was empty (they all snapshot before anyone had a row), so the deny
  // message read "held by session undefined" and the event recorded a null
  // holder and null rule-halves. Counting granted-vs-blocked passed green
  // throughout. Only asking the losers WHO holds it catches this.
  purge();
  // Deliberately small. Each racer is a full node process, and a bare
  // `node -e 0` costs ~814ms p50 on this machine (measured 2026-07-26), so the
  // spawn storm -- not the DB -- is the cost. Four is enough to make the
  // snapshot race happen: the property needs a loser, not a crowd.
  // Override with `--racers N` when investigating.
  const racersArg = process.argv.indexOf('--racers');
  const RACERS = racersArg > -1 ? Number(process.argv[racersArg + 1]) : 4;
  const raceResults = await Promise.all(
    Array.from({ length: RACERS }, (_, i) =>
      runClaim(`step5-race-${i + 1}-0000-0000-0000000`, PLAIN_FILE)),
  );
  const verdicts = raceResults.map(verdict);
  const wonCount = verdicts.filter((v) => v === 'continue').length;
  check('race: exactly one session wins an unclaimed file', wonCount, 1);
  check('race: every other session is denied', verdicts.filter((v) => v === 'deny').length,
    RACERS - 1);

  const trueOwner = owner(PLAIN_FILE);
  const reasons = raceResults.map(denyReason).filter(Boolean);
  check('race: no blocked session is told the holder is "undefined"',
    reasons.some((r) => /session undefined/.test(r)), false);
  check('race: every blocked session names the ACTUAL winner',
    reasons.filter((r) => r.includes(trueOwner)).length, RACERS - 1);
  check('race: every blocked event records a real holder',
    Number(psql(`SELECT count(*) FROM agentic_os.coordination_event
                 WHERE kind='claim_blocked' AND session_id LIKE 'step5-race-%'
                   AND holder_session_id IS NOT NULL`)), RACERS - 1);
  check('race: every blocked event records both halves of the rule',
    Number(psql(`SELECT count(*) FROM agentic_os.coordination_event
                 WHERE kind='claim_blocked' AND session_id LIKE 'step5-race-%'
                   AND detail->>'leaseExpired' IS NOT NULL
                   AND detail->>'holderStale' IS NOT NULL`)), RACERS - 1);
  psql(`DELETE FROM sessions WHERE id LIKE 'step5-race-%';
        DELETE FROM agentic_os.coordination_event WHERE session_id LIKE 'step5-race-%';`);

  // ===================================================================
  // BREAK-GLASS -- refuses to be silent
  // ===================================================================
  given({ file: PLAIN_FILE, leaseOffset: '5 minutes', heartbeatOffset: '0 seconds' });
  const forced = await runClaim(INTRUDER, PLAIN_FILE, { COORDINATION_BREAK_GLASS: '1' });
  check('break-glass overrides a live lease AND a live holder', verdict(forced), 'continue');
  check('break-glass hands over ownership', owner(PLAIN_FILE), INTRUDER);
  check('break-glass is recorded as its OWN kind, not as a takeover',
    Number(psql(`SELECT count(*) FROM agentic_os.coordination_event
                 WHERE kind='claim_break_glass' AND session_id='${INTRUDER}'`)), 1);
  check('break-glass did NOT inflate the ordinary takeover count',
    Number(psql(`SELECT count(*) FROM agentic_os.coordination_event
                 WHERE kind='claim_takeover' AND session_id='${INTRUDER}'`)), 0);

  // A legitimate reclamation with the variable set must still read as a plain
  // takeover -- otherwise the flag, not the situation, decides the event kind
  // and the break-glass count becomes meaningless.
  purge();
  given({ file: PLAIN_FILE, leaseOffset: '-1 minutes', heartbeatOffset: '-30 minutes' });
  await runClaim(INTRUDER, PLAIN_FILE, { COORDINATION_BREAK_GLASS: '1' });
  check('a LEGITIMATE reclaim with the flag set is still a plain takeover',
    Number(psql(`SELECT count(*) FROM agentic_os.coordination_event
                 WHERE kind='claim_takeover' AND session_id='${INTRUDER}'`)), 1);
  check('... and is not counted as break-glass',
    Number(psql(`SELECT count(*) FROM agentic_os.coordination_event
                 WHERE kind='claim_break_glass' AND session_id='${INTRUDER}'`)), 0);

  // ===================================================================
  // RELEASE -- what pays for the long leases
  // ===================================================================
  purge();
  await runClaim(HOLDER, PLAIN_FILE);
  await runClaim(HOLDER, HARNESS_FILE);
  check('holder is holding two files',
    Number(psql(`SELECT count(*) FROM file_claims WHERE session_id='${HOLDER}'`)), 2);

  const released = await new Promise((resolve) => {
    const child = spawn(process.execPath,
      [`${REPO}/.claude/hooks/dist/coordination-release.mjs`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    child.stdin.end(JSON.stringify({ session_id: HOLDER, cwd: REPO, reason: 'probe' }));
  });
  check('release exits 0', released.code, 0);
  check('release frees every claim',
    Number(psql(`SELECT count(*) FROM file_claims WHERE session_id='${HOLDER}'`)), 0);
  check('release records one event for the session, not one per file',
    Number(psql(`SELECT count(*) FROM agentic_os.coordination_event
                 WHERE kind='claim_released' AND session_id='${HOLDER}'`)), 1);
  check('... naming how many it gave back',
    psql(`SELECT detail->>'count' FROM agentic_os.coordination_event
          WHERE kind='claim_released' AND session_id='${HOLDER}'`), '2');

  // A released file is immediately claimable by anyone -- that is the point.
  check('the freed file is immediately available to another session',
    verdict(await runClaim(INTRUDER, PLAIN_FILE)), 'continue');

  // Releasing with nothing held must stay silent, or every session exit writes
  // a row and the events table grows without bound the way file_claims did.
  purge();
  await new Promise((resolve) => {
    const child = spawn(process.execPath,
      [`${REPO}/.claude/hooks/dist/coordination-release.mjs`], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('close', resolve);
    child.stdin.end(JSON.stringify({ session_id: HOLDER, cwd: REPO, reason: 'probe-empty' }));
  });
  check('releasing nothing writes nothing',
    Number(psql(`SELECT count(*) FROM agentic_os.coordination_event
                 WHERE kind='claim_released' AND session_id='${HOLDER}'`)), 0);

  purge();

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  console.log(JSON.stringify({ verdict: failed === 0 ? 'HOLDS' : 'BROKEN', failed }));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('probe crashed:', err);
  try { purge(); } catch { /* best effort */ }
  process.exit(1);
});
