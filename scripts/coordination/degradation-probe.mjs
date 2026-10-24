/**
 * Can the coordination layer's instrumentation break the guard it instruments?
 *
 * Exercises the two paths that would otherwise be VACUOUS guards.
 *
 * Both of these are "cannot happen" paths, which is exactly the kind that has
 * shipped broken here three times. A savepoint nobody has ever rolled back and
 * a fail-open nobody has ever tripped are assertions, not guarantees.
 *
 *   A. DB unreachable  -> the hook must still emit a decision and exit 0.
 *   B. Event table gone -> the CLAIM must still be decided and persisted; only
 *      the event is lost. This is the savepoint doing its job. If the savepoint
 *      were missing, the failed INSERT would poison the transaction and roll
 *      the claim back with it, turning an instrumentation bug into an outage.
 *
 * Guard B renames our own table in agentic_os and restores it in a finally.
 * Verified restored before the process exits, and re-verified independently by
 * a separate to_regclass query rather than trusting the finally block. It never
 * touches anything outside agentic_os.
 *
 * Run after any change to the claim transaction or the event writer.
 *
 *   node scripts/coordination/degradation-probe.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { canonProject, repoPath } from './canon-home.mjs';
// The hooks spawned here log their denies. Send that log to a temp file, never the real ~/.claude/logs one.
process.env.CCV3_GUARD_DECISIONS_LOG ??= (process.env.TEMP || process.env.TMPDIR || '/tmp') + '/ccv3-probe-guard-decisions.jsonl';

const REPO = repoPath();
const CANON = canonProject();
console.log(`canonical project: ${CANON}`);
const TARGET = join(REPO, '.claude', 'hooks', 'src', '__step4guard__.ts');
const HOLDER = 'step4guard-holder-0000-0000-0000000';
const ME = 'step4guard-me-0000-0000-00000000000';

const psql = (sql) => execFileSync('docker',
  ['exec', 'continuous-claude-postgres', 'psql', '-U', 'claude', '-d', 'continuous_claude', '-t', '-A', '-c', sql],
  { encoding: 'utf-8' }).trim();

function runHook(rel, payload, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`${REPO}/${rel}`], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(got)}${ok ? '' : `  (wanted ${JSON.stringify(want)})`}`);
};

const purge = () => psql(`
  DELETE FROM file_claims WHERE file_path = '${TARGET}';
  DELETE FROM sessions WHERE id LIKE 'step4guard-%';
  DELETE FROM agentic_os.coordination_event WHERE session_id LIKE 'step4guard-%';
`);

async function main() {
  purge();

  // ===== GUARD A: the database is unreachable =============================
  // Port 1 is reserved and nothing listens on it.
  const dead = await runHook('.claude/hooks/dist/file-claims.mjs', {
    session_id: ME, cwd: REPO, tool_name: 'Edit', tool_input: { file_path: TARGET },
  }, { CONTINUOUS_CLAUDE_DB_URL: 'postgresql://claude:claude_dev@127.0.0.1:1/continuous_claude' });

  check('A exits 0 with the DB down', dead.code, 0);
  let aj = null;
  try { aj = JSON.parse(dead.out); } catch { /* leave null -> fails below */ }
  check('A still emits a decision', aj?.result, 'continue');
  check('A says the check did not happen', /NOT checked/.test(aj?.message || ''), true);
  check('A does not claim to have denied', aj?.hookSpecificOutput === undefined, true);

  // ===== GUARD B: the event table is gone =================================
  psql(`
    INSERT INTO sessions (id, project, last_heartbeat) VALUES ('${HOLDER}', '${CANON}', NOW());
    INSERT INTO file_claims (file_path, project, session_id, claimed_at)
    VALUES ('${TARGET}', '${CANON}', '${HOLDER}', NOW());
  `);

  let renamed = false;
  try {
    psql(`ALTER TABLE agentic_os.coordination_event RENAME TO coordination_event__guardtest;`);
    renamed = true;
    console.log('      (event table temporarily renamed)');

    const blocked = await runHook('.claude/hooks/dist/file-claims.mjs', {
      session_id: ME, cwd: REPO, tool_name: 'Edit', tool_input: { file_path: TARGET },
    });

    check('B exits 0 with no event table', blocked.code, 0);
    const bj = JSON.parse(blocked.out);
    // THE point: the guard's decision survives the instrumentation failure.
    check('B the BLOCK still happens', bj.hookSpecificOutput?.permissionDecision, 'deny');
    check('B the holder keeps the claim',
      psql(`SELECT session_id FROM file_claims WHERE file_path='${TARGET}'`), HOLDER);
    check('B the loss is announced on stderr', /not recorded|dropped/.test(blocked.err), true);

    // And the claim transaction still committed its OTHER work — the heartbeat
    // renewal — proving the savepoint rolled back only the event insert.
    check('B the heartbeat renewal still committed',
      Number(psql(`SELECT count(*) FROM sessions WHERE id='${ME}'`)), 1);
  } finally {
    if (renamed) {
      psql(`ALTER TABLE agentic_os.coordination_event__guardtest RENAME TO coordination_event;`);
      console.log('      (event table restored)');
    }
  }

  // Independent re-verification, not trusting the finally block.
  check('B table is back',
    psql(`SELECT to_regclass('agentic_os.coordination_event')::text`), 'agentic_os.coordination_event');
  check('B no leftover guardtest table',
    psql(`SELECT coalesce(to_regclass('agentic_os.coordination_event__guardtest')::text,'none')`), 'none');

  // ===== and the normal path still works afterwards ======================
  purge();
  psql(`
    INSERT INTO sessions (id, project, last_heartbeat) VALUES ('${HOLDER}', '${CANON}', NOW());
    INSERT INTO file_claims (file_path, project, session_id, claimed_at)
    VALUES ('${TARGET}', '${CANON}', '${HOLDER}', NOW());
  `);
  const after = await runHook('.claude/hooks/dist/file-claims.mjs', {
    session_id: ME, cwd: REPO, tool_name: 'Edit', tool_input: { file_path: TARGET },
  });
  check('C blocking still works after the rename', JSON.parse(after.out).hookSpecificOutput?.permissionDecision, 'deny');
  check('C and the event is recorded again',
    Number(psql(`SELECT count(*) FROM agentic_os.coordination_event WHERE session_id='${ME}'`)), 1);

  purge();
  check('D fixtures removed',
    Number(psql(`SELECT (SELECT count(*) FROM agentic_os.coordination_event WHERE session_id LIKE 'step4guard-%')
                      + (SELECT count(*) FROM sessions WHERE id LIKE 'step4guard-%')
                      + (SELECT count(*) FROM file_claims WHERE file_path='${TARGET}')`)), 0);

  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed ? `FAILED ${failed}/${results.length}` : `ALL ${results.length} GUARD CHECKS PASS`}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('guard test crashed:', e); process.exit(1); });
