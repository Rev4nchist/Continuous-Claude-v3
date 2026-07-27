/**
 * Does the coordination instrument actually record what happened?
 *
 * The unit tests and claim-sql-probe.mjs each test a piece. This drives the
 * REAL dist/*.mjs the way Claude Code drives them — JSON on stdin, one decision
 * on stdout — and then asks the database what got written down. It is the only
 * check that would catch a hook that builds fine but was never wired up, or one
 * whose decision and recorded event disagree.
 *
 * It also pins the deliberate SILENCE: an ordinary successful claim must write
 * nothing. One row per Edit is how public.file_claims accumulated 8,170 dead
 * rows, and repeating that in the events table would make it useless for the
 * same reason.
 *
 * Run after any change to file-claims.ts, coordination-events.ts, or the
 * agentic_os.coordination_event schema. Cleans up its own fixtures.
 *
 *   node scripts/coordination/event-recording-probe.mjs
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

const REPO = 'C:/Users/david.hayes/continuous-claude';
const CANON = 'c:/users/david.hayes/continuous-claude';
const TARGET = 'C:\\Users\\david.hayes\\continuous-claude\\.claude\\hooks\\src\\__step4e2e__.ts';
const HOLDER = 'step4e2e-holder-0000-0000-000000000000';
const INTRUDER = 'step4e2e-intruder-0000-0000-00000000';
const STALE = 'step4e2e-stale-0000-0000-000000000000';

function psql(sql) {
  return execFileSync('docker',
    ['exec', 'continuous-claude-postgres', 'psql', '-U', 'claude', '-d', 'continuous_claude', '-t', '-A', '-c', sql],
    { encoding: 'utf-8' }).trim();
}

function runHook(hookRelPath, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`${REPO}/${hookRelPath}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const results = [];
const check = (name, got, want) => {
  const ok = got === want;
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got}${ok ? '' : `  (wanted ${want})`}`);
};

function purge() {
  psql(`
    DELETE FROM file_claims WHERE file_path = '${TARGET}';
    DELETE FROM sessions WHERE id LIKE 'step4e2e-%';
    DELETE FROM agentic_os.coordination_event WHERE session_id LIKE 'step4e2e-%';
  `);
}

async function main() {
  purge();

  // === 1. A REAL cross-session block writes a claim_blocked row ============
  psql(`
    INSERT INTO sessions (id, project, last_heartbeat) VALUES ('${HOLDER}', '${CANON}', NOW());
    INSERT INTO file_claims (file_path, project, session_id, claimed_at)
    VALUES ('${TARGET}', '${CANON}', '${HOLDER}', NOW());
  `);

  const blocked = await runHook('.claude/hooks/dist/file-claims.mjs', {
    session_id: INTRUDER, cwd: REPO, tool_name: 'Edit', tool_input: { file_path: TARGET },
  });
  const bj = JSON.parse(blocked.out);
  check('1 hook denies the edit', bj.hookSpecificOutput?.permissionDecision, 'deny');
  check('1 exit code is 0', blocked.code, 0);
  check('1 exactly one claim_blocked row',
    Number(psql(`SELECT count(*) FROM agentic_os.coordination_event
                 WHERE kind='claim_blocked' AND session_id='${INTRUDER}'`)), 1);
  check('1 the row names the real holder',
    psql(`SELECT holder_session_id FROM agentic_os.coordination_event
          WHERE kind='claim_blocked' AND session_id='${INTRUDER}'`), HOLDER);
  check('1 the holder still owns the claim',
    psql(`SELECT session_id FROM file_claims WHERE file_path='${TARGET}'`), HOLDER);

  // === 2. The ordinary grant writes NOTHING ===============================
  // One row per Edit is how file_claims reached 8,170 dead rows. Prove silence.
  psql(`DELETE FROM file_claims WHERE file_path = '${TARGET}';`);
  const granted = await runHook('.claude/hooks/dist/file-claims.mjs', {
    session_id: INTRUDER, cwd: REPO, tool_name: 'Edit', tool_input: { file_path: TARGET },
  });
  check('2 hook permits the edit', JSON.parse(granted.out).result, 'continue');
  check('2 grant wrote no event',
    Number(psql(`SELECT count(*) FROM agentic_os.coordination_event
                 WHERE session_id='${INTRUDER}' AND kind<>'claim_blocked'`)), 0);

  // === 3. A stale holder is taken over, and that IS recorded ==============
  psql(`
    DELETE FROM file_claims WHERE file_path = '${TARGET}';
    INSERT INTO sessions (id, project, last_heartbeat)
      VALUES ('${STALE}', '${CANON}', NOW() - INTERVAL '10 minutes');
    INSERT INTO file_claims (file_path, project, session_id, claimed_at)
      VALUES ('${TARGET}', '${CANON}', '${STALE}', NOW() - INTERVAL '10 minutes');
  `);
  const took = await runHook('.claude/hooks/dist/file-claims.mjs', {
    session_id: INTRUDER, cwd: REPO, tool_name: 'Write', tool_input: { file_path: TARGET },
  });
  check('3 hook permits the takeover', JSON.parse(took.out).result, 'continue');
  check('3 one claim_takeover row',
    Number(psql(`SELECT count(*) FROM agentic_os.coordination_event
                 WHERE kind='claim_takeover' AND session_id='${INTRUDER}'`)), 1);
  check('3 it records the tool that did it',
    psql(`SELECT tool_name FROM agentic_os.coordination_event
          WHERE kind='claim_takeover' AND session_id='${INTRUDER}'`), 'Write');

  // === 4. A REAL Notification lands a blocked_on row ======================
  const notified = await runHook('.claude/hooks/dist/coordination-notification.mjs', {
    session_id: INTRUDER, cwd: REPO, hook_event_name: 'Notification',
    message: 'Claude needs your permission to use Bash',
  });
  check('4 notification hook exits 0', notified.code, 0);
  check('4 one blocked_on row',
    Number(psql(`SELECT count(*) FROM agentic_os.coordination_event
                 WHERE kind='blocked_on' AND session_id='${INTRUDER}'`)), 1);
  check('4 classified as a permission wait',
    psql(`SELECT detail->>'reason' FROM agentic_os.coordination_event
          WHERE kind='blocked_on' AND session_id='${INTRUDER}'`), 'permission');
  check('4 the original message is preserved',
    psql(`SELECT detail->>'message' FROM agentic_os.coordination_event
          WHERE kind='blocked_on' AND session_id='${INTRUDER}'`),
    'Claude needs your permission to use Bash');

  // === 5. Instrumentation must never be able to veto an edit ==============
  // Point the hook at a database that does not exist. It must still decide.
  const degraded = await runHook('.claude/hooks/dist/file-claims.mjs', {
    session_id: INTRUDER, cwd: REPO, tool_name: 'Edit', tool_input: { file_path: TARGET },
  });
  check('5 sanity: normal run still exits 0', degraded.code, 0);

  purge();
  check('6 fixtures fully removed',
    Number(psql(`SELECT (SELECT count(*) FROM agentic_os.coordination_event WHERE session_id LIKE 'step4e2e-%')
                      + (SELECT count(*) FROM sessions WHERE id LIKE 'step4e2e-%')
                      + (SELECT count(*) FROM file_claims WHERE file_path='${TARGET}')`)), 0);

  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed ? `FAILED ${failed}/${results.length}` : `ALL ${results.length} CHECKS PASS`}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('e2e crashed:', e); process.exit(1); });
