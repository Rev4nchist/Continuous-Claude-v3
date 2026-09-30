#!/usr/bin/env node
/**
 * WS-2 Phase B.3 quality gate (#12) -- recall WITHOUT bus-bias vs WITH bus-bias.
 *
 * Mirrors the production read path (memory-awareness / agent-recall-injector):
 * calls recall_learnings.py --json --text-only with the BARE intent (baseline)
 * vs intent + session focus terms (biased), exactly as the B.3 hooks build
 * `recallQuery = intent + ' ' + focusTerms.join(' ')`. Reports mean top-score,
 * hit-rate, and latency, then a rollback verdict against plan section-8 thresholds.
 *
 * Run: node scripts/bus-quality-gate.mjs   (needs CLAUDE_OPC_DIR + the memory DB)
 *
 * NOTE: text-only mode (floor 0.05) is the deterministic, daemon-free gate. A
 * hybrid (vector+FTS, floor 0.01) run is a follow-up if the daemon is warmed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OPC = process.env.CLAUDE_OPC_DIR;
if (!OPC) {
  console.error('CLAUDE_OPC_DIR is unset -- cannot locate recall_learnings.py');
  process.exit(2);
}
const MODE = process.argv[2] === 'hybrid' ? 'hybrid' : 'text-only';
const FLOOR = MODE === 'hybrid' ? 0.01 : 0.05; // HYBRID_FLOOR vs TEXT_ONLY_FLOOR

// --- B.3.3 read-only safety: pre-mortem #8 says the eval must NOT write to archival_memory.
// We invoke ONLY recall_learnings.py (a SELECT-only read path) -- never store_learning.py. As a
// belt-and-suspenders PROOF, we count archival_memory rows before and after and assert no change.
// count(*) (not pg_stat) per the ROADMAP data note. Best-effort: if docker/psql is unavailable
// the assertion is skipped with a warning (the eval still runs -- it is read-only by construction).
function dbRowCount() {
  const res = spawnSync(
    'docker',
    ['exec', 'continuous-claude-postgres', 'psql', '-U', 'claude', '-d', 'continuous_claude', '-t', '-A', '-c', 'SELECT count(*) FROM archival_memory;'],
    { encoding: 'utf-8', timeout: 15000, windowsHide: true },
  );
  if (res.status !== 0 || !res.stdout) return null;
  const n = parseInt(res.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// Embedding-daemon warmth signal (recall_learnings.py:241). When cold, the hybrid leg still runs
// but embeds locally (slower, less production-realistic). We RECORD which leg ran (pre-mortem M1/M2).
function daemonWarm() {
  // Canonical, env-independent rendezvous dir -- mirrors embedding_daemon.py
  // _canonical_run_dir() and embedding-client.ts RUN_DIR. (Was process.env.TEMP,
  // which diverged from the Python daemon's TMPDIR-based path -- the root-cause bug.)
  return existsSync(join(homedir(), '.claude', 'run', 'ccv3-embedding.json'));
}

// Representative (intent, focus) cases. The focus terms model a real session
// working set (symbol names + file basenames), mostly RELATED to the intent (as
// in production) with a couple of tangential sets to probe dilution risk.
const CASES = [
  { intent: 'fix the context bus write path drop handling', focus: ['context-bus', 'mutateViaLock', 'atomic-write'] },
  { intent: 'redact secrets in telemetry before they reach disk', focus: ['intel-bus', 'redactSecretsDeep', 'appendIntelBus'] },
  { intent: 'bias memory recall with the session working set', focus: ['bus-focus', 'extractBusFocus', 'memory-awareness'] },
  { intent: 'agent recall injector should read the context bus', focus: ['agent-recall-injector', 'handleAgentTask', 'readBus'] },
  { intent: 'knowledge tree regeneration unicode crash on windows', focus: ['knowledge_tree', 'tree_schema'] },
  { intent: 'ralph state checkpoint and scheduler', focus: ['ralph-state', 'ralph-checkpoint', 'ralph-scheduler'] },
  { intent: 'codex adversary cross model review setup', focus: ['codex-adversary', 'review'] },
];

// B.3.3: KNOWN-STRONG-MATCH cases. These intents target learnings ALREADY PRESENT in the live
// corpus (574 rows at authoring) -- e.g. the Nia MCP config-priority fix, the hook-source
// regression dual-cause, the Windows knowledge-tree unicode crash, the no-haiku rule. The point
// is a baseline that is NOT sub-floor for most cases (plan #12), so a bias regression is visible
// against a real signal rather than against noise. NO rows are inserted -- recall is read-only;
// these reference existing content by topic (provenance: this project's own MEMORY.md learnings).
const STRONG_CASES = [
  { intent: 'Nia MCP config priority mcp.json overrides claude mcp.json', focus: ['nia-mcp', 'mcp.json'] },
  { intent: 'hook source regression dual cause ralph loop sync asymmetry', focus: ['memory-awareness', 'sync-claude'] },
  { intent: 'knowledge tree unicode crash windows cp1252 ascii only', focus: ['knowledge_tree', 'PYTHONUTF8'] },
  { intent: 'never use haiku model for agents inherit opus', focus: ['no-haiku', 'agent-model-selection'] },
  { intent: 'paste ready deliverables no blockquote markdown for slack', focus: ['paste-ready-deliverables'] },
];

// Run the existing representative cases plus the known-strong cases (labeled for the report).
const ALL_CASES = [
  ...CASES.map((c) => ({ ...c, kind: 'repr' })),
  ...STRONG_CASES.map((c) => ({ ...c, kind: 'strong' })),
];

function recall(query) {
  const t0 = Date.now();
  const args = ['run', 'python', 'scripts/core/recall_learnings.py', '--query', query, '--k', '5', '--json'];
  if (MODE === 'text-only') args.push('--text-only');
  const res = spawnSync('uv', args, { cwd: OPC, env: { ...process.env, PYTHONPATH: OPC }, encoding: 'utf-8', timeout: 90000 });
  const ms = Date.now() - t0;
  if (res.status !== 0 || !res.stdout) return { top: 0, hits: 0, ms, ok: false };
  let data;
  try { data = JSON.parse(res.stdout); } catch { return { top: 0, hits: 0, ms, ok: false }; }
  const results = Array.isArray(data?.results) ? data.results : [];
  const scores = results.map((r) => r.score ?? r.final_score ?? 0);
  const top = scores.length ? Math.max(...scores) : 0;
  const hits = scores.filter((s) => s >= FLOOR).length;
  return { top, hits, ms, ok: true };
}

// Read-only proof: snapshot the corpus size BEFORE the run.
const countBefore = dbRowCount();
const daemon = daemonWarm();
if (MODE === 'hybrid' && !daemon) {
  console.warn('NOTE: hybrid mode requested but the embedding daemon discovery file is ABSENT -- the hybrid leg runs COLD (local embed). Warm the daemon for production-realistic latency/scores.');
}

const rows = [];
for (const c of ALL_CASES) {
  const base = recall(c.intent);
  const biased = recall(`${c.intent} ${c.focus.join(' ')}`);
  rows.push({ intent: c.intent, kind: c.kind, base, biased });
}

// Read-only proof: corpus size AFTER must equal BEFORE (0 net DB writes).
const countAfter = dbRowCount();

// CodeRabbit PR#5: recall() fails soft (returns ok:false on subprocess/JSON
// error). Without this guard a total failure (DB down, `uv` missing) would make
// every score 0 -> no rollback threshold trips -> a MISLEADING "KEEP ENABLED".
// Count failed CALLS and refuse to emit a verdict when the run is unreliable.
const failedCalls = rows.reduce((acc, r) => acc + (r.base.ok ? 0 : 1) + (r.biased.ok ? 0 : 1), 0);
const totalCalls = rows.length * 2;
if (failedCalls > totalCalls / 2) {
  console.error(`\nABORT: ${failedCalls}/${totalCalls} recall calls FAILED (DB/subprocess issue?) -- gate result is unreliable; not emitting a verdict.`);
  process.exit(2);
}
if (failedCalls > 0) {
  console.warn(`\nWARNING: ${failedCalls}/${totalCalls} recall calls failed; the aggregates below may be skewed.`);
}

const n = rows.length;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const baseTop = mean(rows.map((r) => r.base.top));
const biasedTop = mean(rows.map((r) => r.biased.top));
const baseHit = mean(rows.map((r) => (r.base.hits > 0 ? 1 : 0)));
const biasedHit = mean(rows.map((r) => (r.biased.hits > 0 ? 1 : 0)));
const baseMs = mean(rows.map((r) => r.base.ms));
const biasedMs = mean(rows.map((r) => r.biased.ms));
const topDeltaPct = baseTop > 0 ? ((biasedTop - baseTop) / baseTop) * 100 : 0;

console.log(`\nWS-2 B.3 QUALITY GATE -- recall WITHOUT vs WITH bus-bias (${MODE}, floor=${FLOOR})`);
console.log(`embedding daemon: ${daemon ? 'WARM' : 'COLD'}${MODE === 'hybrid' && !daemon ? ' (hybrid leg ran cold -- not production-realistic)' : ''}\n`);
console.log('kind  ' + 'intent'.padEnd(48) + 'base_top  bias_top  b_hit  x_hit');
for (const r of rows) {
  console.log(
    (r.kind === 'strong' ? 'STRG  ' : 'repr  ') +
      r.intent.slice(0, 46).padEnd(48) +
      r.base.top.toFixed(4).padStart(8) + '  ' +
      r.biased.top.toFixed(4).padStart(8) + '  ' +
      String(r.base.hits).padStart(5) + '  ' +
      String(r.biased.hits).padStart(5),
  );
}
console.log(`\n--- AGGREGATE (n=${n}) ---`);
console.log(`mean top-score : base ${baseTop.toFixed(4)} -> biased ${biasedTop.toFixed(4)} (${topDeltaPct >= 0 ? '+' : ''}${topDeltaPct.toFixed(1)}%)`);
console.log(`hit-rate       : base ${(baseHit * 100).toFixed(0)}% -> biased ${(biasedHit * 100).toFixed(0)}%`);
console.log(`mean latency   : base ${baseMs.toFixed(0)}ms -> biased ${biasedMs.toFixed(0)}ms`);

const fails = [];
if (biasedHit < baseHit) fails.push(`hit-rate dropped (${(baseHit * 100).toFixed(0)}% -> ${(biasedHit * 100).toFixed(0)}%)`);
if (topDeltaPct < -10) fails.push(`mean top-score regressed >10% (${topDeltaPct.toFixed(1)}%)`);
// B.3.3 read-only proof: assert the corpus did not grow during the eval (0 net DB writes).
console.log('\n--- READ-ONLY ASSERTION (0 DB writes, pre-mortem #8) ---');
if (countBefore === null || countAfter === null) {
  console.log('SKIPPED -- could not count archival_memory (docker/psql unavailable). Eval is read-only by construction (recall_learnings.py only; no store_learning.py).');
} else if (countBefore === countAfter) {
  console.log(`PASS -- archival_memory row count unchanged (${countBefore} -> ${countAfter}). The eval wrote 0 rows.`);
} else {
  console.error(`FAIL -- archival_memory row count CHANGED (${countBefore} -> ${countAfter}). The eval must be read-only; investigate before trusting results.`);
  process.exitCode = 3;
}

console.log('\n--- ROLLBACK VERDICT (plan section 8) ---');
if (fails.length) console.log('ROLL BACK -- ' + fails.join('; '));
else console.log('KEEP ENABLED -- no rollback threshold tripped (hit-rate held; top-score within -10%).');
