#!/usr/bin/env node
/**
 * Coordination load probe -- does the file-claims block hold under concurrency?
 *
 * Codex review finding #11 predicted that the 3-second `uv run python` subprocess
 * on the claim path would make the block FAIL OPEN under load: when the subprocess
 * misses its timeout, runPgQuery returns success=false, checkFileClaim swallows it
 * as `{claimed: false}`, and the edit is permitted. A single unloaded invocation
 * cannot see this -- it always has the whole machine to itself.
 *
 * The probe therefore measures the one number that matters: how many concurrent
 * intruders were ALLOWED to edit a file that an active session already holds.
 *
 *   Correct behaviour: 0 allowed, N denied, at any concurrency.
 *   Fail-open:         allowed > 0.
 *
 * Setup and teardown go through `docker exec psql`, NOT through the hook's own
 * transport, so the harness stays honest across the transport swap it is measuring.
 *
 * Usage:
 *   node scripts/coordination/load-probe.mjs --hook <path/to/file-claims.mjs> [options]
 *
 * Options:
 *   --hook <path>     Hook bundle to exercise (required)
 *   --n <int>         Concurrent intruders per round (default 20)
 *   --rounds <int>    Number of bursts (default 3)
 *   --label <string>  Tag for the report (default "run")
 *   --json <path>     Also write the raw result as JSON
 */

import { spawn } from 'child_process';
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const HOOK = arg('hook', null);
const N = parseInt(arg('n', '20'), 10);
const ROUNDS = parseInt(arg('rounds', '3'), 10);
const LABEL = arg('label', 'run');
const JSON_OUT = arg('json', null);

if (!HOOK) {
  console.error('--hook <path> is required');
  process.exit(2);
}

// A real repo path in the real project namespace, so canonicalProject() produces
// the same key the live hooks use. The file is never actually written.
const PROJECT_CWD = 'C:\\Users\\david.hayes\\continuous-claude';
const TARGET_FILE = 'C:\\Users\\david.hayes\\continuous-claude\\.claude\\hooks\\src\\__loadprobe__.ts';
const CANONICAL_PROJECT = 'c:/users/david.hayes/continuous-claude';
const OWNER = 'loadprobe-owner-0000-0000-000000000000';

function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', 'continuous-claude-postgres', 'psql', '-U', 'claude', '-d', 'continuous_claude', '-t', '-A', '-c', sql],
    { encoding: 'utf-8' }
  ).trim();
}

/**
 * Put the DB in the one state the block is supposed to defend:
 * an ACTIVE owner session holding the claim on TARGET_FILE.
 */
// standard_conforming_strings is on by default, so a backslash inside a
// single-quoted literal is already a literal backslash. Escaping it here would
// store C:\\Users\\... and silently never match the row the hook writes.
/**
 * Since step 4 the hook WRITES a coordination_event per blocked decision, so a
 * single n=20/rounds=3 run leaves 60 synthetic rows behind. Left alone the gate
 * would slowly poison the exact table it exists to make trustworthy, and a real
 * conflict would be indistinguishable from probe exhaust. Scoped by session id
 * prefix so it can never touch a genuine event.
 */
const PURGE_EVENTS =
  `DELETE FROM agentic_os.coordination_event WHERE session_id LIKE 'loadprobe-%';`;

function setup() {
  psql(`
    DELETE FROM file_claims WHERE file_path = '${TARGET_FILE}';
    DELETE FROM sessions WHERE id LIKE 'loadprobe-%';
    ${PURGE_EVENTS}
    INSERT INTO sessions (id, project, working_on, started_at, last_heartbeat)
    VALUES ('${OWNER}', '${CANONICAL_PROJECT}', 'load probe owner', NOW(), NOW());
    INSERT INTO file_claims (file_path, project, session_id, claimed_at)
    VALUES ('${TARGET_FILE}', '${CANONICAL_PROJECT}', '${OWNER}', NOW());
  `);
}

function teardown() {
  psql(`
    DELETE FROM file_claims WHERE file_path = '${TARGET_FILE}';
    DELETE FROM sessions WHERE id LIKE 'loadprobe-%';
    ${PURGE_EVENTS}
  `);
}

/** One intruder: a distinct session id asking to edit the file the owner holds. */
function invoke(sessionId) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      const ms = Date.now() - started;
      let decision = 'unparsed';
      try {
        const out = JSON.parse(stdout.trim());
        if (out?.hookSpecificOutput?.permissionDecision === 'deny') decision = 'deny';
        else if (out?.result === 'continue') {
          decision = /stale file lock/i.test(out.message || '') ? 'allow_stale_takeover' : 'allow';
        }
      } catch {
        decision = 'crash';
      }
      resolve({ sessionId, decision, ms, code, stderr: stderr.slice(0, 400) });
    });
    child.stdin.end(
      JSON.stringify({
        session_id: sessionId,
        cwd: PROJECT_CWD,
        tool_name: 'Edit',
        tool_input: { file_path: TARGET_FILE },
      })
    );
  });
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const all = [];
for (let round = 1; round <= ROUNDS; round++) {
  setup();
  // Distinct intruder ids so a single fail-open cannot mask the others by
  // handing the claim to the very session that is being tested next.
  const ids = Array.from({ length: N }, (_, i) => `loadprobe-intruder-${round}-${String(i).padStart(3, '0')}`);
  const t0 = Date.now();
  const results = await Promise.all(ids.map(invoke));
  const wall = Date.now() - t0;
  all.push({ round, wall, results });
  const allowed = results.filter((r) => r.decision.startsWith('allow')).length;
  process.stderr.write(`  round ${round}: ${wall}ms wall, ${allowed}/${N} allowed\n`);
}
teardown();

const flat = all.flatMap((r) => r.results);
const lat = flat.map((r) => r.ms).sort((a, b) => a - b);
const counts = flat.reduce((acc, r) => ((acc[r.decision] = (acc[r.decision] || 0) + 1), acc), {});
const allowed = flat.filter((r) => r.decision.startsWith('allow')).length;

const report = {
  label: LABEL,
  hook: HOOK,
  concurrency: N,
  rounds: ROUNDS,
  total_invocations: flat.length,
  decisions: counts,
  fail_open_count: allowed,
  fail_open_rate: +(allowed / flat.length).toFixed(4),
  latency_ms: { p50: pct(lat, 50), p90: pct(lat, 90), p99: pct(lat, 99), max: lat[lat.length - 1] },
  wall_ms_per_round: all.map((r) => r.wall),
  verdict: allowed === 0 ? 'HOLDS' : 'FAILS OPEN',
};

console.log(JSON.stringify(report, null, 2));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ report, rounds: all }, null, 2));
process.exit(allowed === 0 ? 0 : 1);
