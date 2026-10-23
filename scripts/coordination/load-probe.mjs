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
 * MACHINE HEALTH (added 2026-07-27, after this gate cost an evening to a wrong
 * conclusion). On 2026-07-26 the gate read HOLDS 60/60 twice and then FAILS OPEN
 * 11-12/60 an hour later on byte-identical code. The decisive control was rolling
 * the LIVE harness back to the pre-lease hooks and watching those fail open too --
 * code that had passed 60/60 the same day. The variable was the MACHINE: bare
 * `node -e 0` process spawn had degraded to p50 814ms and later 2,167ms, against a
 * healthy 30-80ms, while the claim statement itself costs 3ms.
 *
 * Fail-open here is a TIMEOUT symptom, so spawn starvation manufactures it. A gate
 * that cannot tell "the guard is broken" from "the machine could not spawn the
 * guard in time" is worse than no gate, because it indicts the change under test.
 * So the probe now measures spawn latency before and after the rounds and refuses
 * to render a verdict it cannot support:
 *
 *   allowed > 0, machine healthy   -> FAILS OPEN    (trustworthy; a real defect)
 *   allowed > 0, machine degraded  -> INCONCLUSIVE  (cannot attribute; re-run)
 *   allowed = 0, machine degraded  -> HOLDS         (STRONGER than nominal: the
 *                                    block survived worse-than-normal conditions,
 *                                    and degradation can only ever manufacture
 *                                    fail-opens, never suppress them)
 *
 * Usage:
 *   node scripts/coordination/load-probe.mjs --hook <path/to/file-claims.mjs> [options]
 *
 * Options:
 *   --hook <path>           Hook bundle to exercise (required)
 *   --n <int>               Concurrent intruders per round (default 20)
 *   --rounds <int>          Number of bursts (default 3)
 *   --label <string>        Tag for the report (default "run")
 *   --json <path>           Also write the raw result as JSON
 *   --max-spawn-ms <int>    Spawn-latency ceiling for a trustworthy reading
 *                           (default 250; healthy is 30-80)
 *   --spawn-samples <int>   Samples per health check (default 7)
 *   --ignore-machine-health Take the raw reading anyway, health notwithstanding
 *
 * Exit codes: 0 HOLDS | 1 FAILS OPEN | 2 usage error | 3 INCONCLUSIVE
 */

import { spawn } from 'child_process';
import { execFileSync } from 'child_process';
// The hooks spawned here log their denies. Send that log to a temp file, never the real ~/.claude/logs one.
process.env.CCV3_GUARD_DECISIONS_LOG ??= (process.env.TEMP || process.env.TMPDIR || '/tmp') + '/ccv3-probe-guard-decisions.jsonl';
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
const MAX_SPAWN_MS = parseInt(arg('max-spawn-ms', '250'), 10);
const SPAWN_SAMPLES = parseInt(arg('spawn-samples', '7'), 10);
const IGNORE_HEALTH = args.includes('--ignore-machine-health');

if (!HOOK) {
  console.error('--hook <path> is required');
  process.exit(2);
}

// A real repo path in the real project namespace, so canonicalProject() produces
// the same key the live hooks use. The file is never actually written.
const PROJECT_CWD = 'C:\\Users\\ada.lovelace\\continuous-claude';
const TARGET_FILE = 'C:\\Users\\ada.lovelace\\continuous-claude\\.claude\\hooks\\src\\__loadprobe__.ts';
const CANONICAL_PROJECT = 'c:/users/ada.lovelace/continuous-claude';
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
    INSERT INTO file_claims (file_path, project, session_id, claimed_at, expires_at)
    VALUES ('${TARGET_FILE}', '${CANONICAL_PROJECT}', '${OWNER}', NOW(), NOW() + INTERVAL '30 minutes');
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

/**
 * Cost of creating one bare node process, sequentially, with no work in it.
 * Deliberately the CHEAPEST possible process: whatever this costs is a floor
 * under every hook invocation the rounds are about to make, so if it alone is
 * already near the hook's timeout there is no headroom left to measure a guard in.
 * Measured the same way the 2026-07-26 baseline was, so the numbers are comparable.
 */
function measureSpawn(samples = SPAWN_SAMPLES) {
  const ms = [];
  for (let i = 0; i < samples; i++) {
    const t = Date.now();
    try {
      execFileSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    } catch {
      /* a failed spawn still took time, and that time is the signal */
    }
    ms.push(Date.now() - t);
  }
  ms.sort((a, b) => a - b);
  return { samples, p50: pct(ms, 50), min: ms[0], max: ms[ms.length - 1], all: ms };
}

const healthBefore = measureSpawn();
const degradedBefore = healthBefore.p50 > MAX_SPAWN_MS;

if (degradedBefore && !IGNORE_HEALTH) {
  const report = {
    label: LABEL,
    hook: HOOK,
    verdict: 'INCONCLUSIVE',
    reason:
      `bare process spawn p50 is ${healthBefore.p50}ms, over the ${MAX_SPAWN_MS}ms ceiling ` +
      `(healthy is 30-80ms). Fail-open on the claim path is a timeout symptom, so on a machine ` +
      `this starved the gate cannot distinguish a broken guard from a starved one. Refusing to ` +
      `render a verdict rather than indicting the code under test. No rounds were run and no ` +
      `coordination_event rows were written.`,
    machine_health: { before: healthBefore, ceiling_ms: MAX_SPAWN_MS },
    remedy:
      'Find what is consuming process creation (on 2026-07-26 it was a third-party ' +
      'agent IDE running an unbounded git crawl, ~1.6-4 git spawns/sec with 40-217 ' +
      'concurrent), then re-run. Use --ignore-machine-health to force a raw reading.',
  };
  console.log(JSON.stringify(report, null, 2));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ report }, null, 2));
  process.exit(3);
}

process.stderr.write(
  `  machine health: spawn p50 ${healthBefore.p50}ms (ceiling ${MAX_SPAWN_MS}ms)` +
    `${degradedBefore ? ' -- DEGRADED, forced past by --ignore-machine-health' : ' -- ok'}\n`
);

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

// Re-measure AFTER the rounds. A machine can be healthy at the start and starved
// by the end -- that is precisely the 2026-07-26 shape, where the gate's own p50
// climbed 1,583 -> 3,828 -> 8,045ms across the evening. Without this second read a
// mid-run collapse is indistinguishable from a defect in the hook.
const healthAfter = measureSpawn();
const degraded = degradedBefore || healthAfter.p50 > MAX_SPAWN_MS;

// Degradation can only ever MANUFACTURE a fail-open (a starved spawn misses its
// timeout and the hook permits), never suppress one. So a clean sweep on a sick
// machine is a stronger pass than a clean sweep on a healthy one, and only the
// allowed>0 case is ambiguous enough to withhold a verdict.
let verdict;
if (allowed === 0) verdict = 'HOLDS';
else if (degraded && !IGNORE_HEALTH) verdict = 'INCONCLUSIVE';
else verdict = 'FAILS OPEN';

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
  machine_health: {
    before: healthBefore,
    after: healthAfter,
    ceiling_ms: MAX_SPAWN_MS,
    degraded,
  },
  verdict,
};

if (verdict === 'INCONCLUSIVE') {
  report.reason =
    `${allowed}/${flat.length} intruders were permitted, but bare process spawn measured ` +
    `p50 ${healthBefore.p50}ms before and ${healthAfter.p50}ms after these rounds, against a ` +
    `${MAX_SPAWN_MS}ms ceiling. A starved spawn manufactures exactly this symptom, so this run ` +
    `cannot tell a broken guard from a starved one. Re-run on a healthy machine before ` +
    `concluding anything about the code. Raw counts are reported above, nothing is hidden.`;
} else if (verdict === 'HOLDS' && degraded) {
  report.note =
    `Held with 0 fail-opens despite the machine being degraded (spawn p50 ` +
    `${healthBefore.p50} -> ${healthAfter.p50}ms vs a ${MAX_SPAWN_MS}ms ceiling). Degradation can ` +
    `only manufacture fail-opens, never hide them, so this is a STRONGER pass than nominal.`;
}

console.log(JSON.stringify(report, null, 2));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ report, rounds: all }, null, 2));
process.exit(verdict === 'HOLDS' ? 0 : verdict === 'INCONCLUSIVE' ? 3 : 1);
