#!/usr/bin/env node
/**
 * tldr-savings-probe — does the TLDR read-enforcer actually save tokens, and
 * what does it cost to do so?
 *
 * The `95% token savings` claim in the (since retired) tldr-cli rule, now .claude/skills/tldr-code/SKILL.md, has no measurement
 * behind it anywhere in the repo. This measures it, on the real hook, with real
 * payloads, against real files.
 *
 * Deliberately NOT a probe-payload benchmark. The Q3 refutation in this
 * lineage was exactly that mistake: synthetic `__probe__` payloads trip each
 * hook's first guard, so you measure the guard and report it as the feature.
 * Every payload here is a payload the hook will actually process to completion.
 *
 * For each candidate file we record which of two things happened:
 *   DENIED  — hook substituted TLDR context. saving = raw - injected.
 *   ALLOWED — hook passed the read through. saving = 0, cost = latency.
 * A file that is ALLOWED still costs the full hook latency, so it belongs in
 * the denominator. Reporting only the DENIED files is how you get 95%.
 *
 * CORPUS MATTERS MORE THAN THE PROBE. Run with --from-transcripts to replay the
 * files real sessions actually Read (via tldr-read-corpus.mjs). The default
 * on-disk walk is kept only as a contrast case: it is dominated by .venv /
 * site-packages third-party code that nobody ever opens, and "blocking" a 5MB
 * minified bundle no one would have read is a saving of zero real tokens that
 * reports as ~100%. That contrast is itself a finding — do not quote the
 * on-disk number as the savings figure.
 *
 * Usage:
 *   node scripts/hooks/tldr-savings-probe.mjs --from-transcripts [--json]
 *   node scripts/hooks/tldr-savings-probe.mjs [--json] [--limit N]   # on-disk contrast
 */

import { spawnSync, execFileSync } from 'node:child_process';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { homedir } from 'node:os';
// The hooks spawned here log their denies. Send that log to a temp file, never the real ~/.claude/logs one.
process.env.CCV3_GUARD_DECISIONS_LOG ||= (process.env.TEMP || process.env.TMPDIR || '/tmp') + `/ccv3-probe-guard-decisions-${process.pid}.jsonl`; // one file per run, so two runs never mix rows

const PROJECT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const HOOK = join(homedir(), '.claude', 'hooks', 'dist', 'tldr-read-enforcer.mjs');
const JSON_OUT = process.argv.includes('--json');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? parseInt(process.argv[i + 1], 10) : 40;
})();

// Bytes/4 is the same estimator the plan used for every other token figure.
// It is an estimator, not a measurement — labelled as such in the output so it
// does not get quoted later as if it came from /context.
const tok = (bytes) => Math.round(bytes / 4);

const CODE_EXT = new Set(['.py', '.ts', '.tsx', '.js', '.jsx', '.go', '.rs']);
const SKIP_DIR = /node_modules|[\\/]\.git[\\/]|[\\/]\.next[\\/]|[\\/]dist[\\/]|_snapshots|_archive|[\\/]\.agents[\\/]/;

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (SKIP_DIR.test(full)) continue;
    if (e.isDirectory()) walk(full, out);
    else if (CODE_EXT.has(extname(e.name))) {
      let size;
      try { size = statSync(full).size; } catch { continue; }
      out.push({ path: full, size });
    }
  }
  return out;
}

function runHook(filePath) {
  const payload = JSON.stringify({
    session_id: 'tldr-savings-probe',
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: filePath },
    cwd: PROJECT,
  });
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  let decision = 'ALLOWED';
  let injected = 0;
  try {
    const out = JSON.parse(r.stdout || '{}');
    const hso = out.hookSpecificOutput;
    if (hso && hso.permissionDecision === 'deny') {
      decision = 'DENIED';
      injected = Buffer.byteLength(hso.permissionDecisionReason || '', 'utf8');
    }
  } catch {
    decision = 'PARSE_FAIL';
  }
  return { ms, decision, injected, status: r.status };
}

const FROM_TRANSCRIPTS = process.argv.includes('--from-transcripts');

// Replay the real Read distribution. Weight is the call count, so a file read
// 30 times counts 30 times toward savings and toward latency — a per-distinct-
// path average would understate both.
function transcriptCorpus() {
  const out = execFileSync(
    process.execPath,
    [join(PROJECT, 'scripts', 'hooks', 'tldr-read-corpus.mjs'), '--json'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const { rows } = JSON.parse(out);
  const files = [];
  for (const r of rows) {
    if (!CODE_EXT.has(extname(r.path))) continue; // non-code never reaches TLDR
    if (!existsSync(r.path)) continue;            // deleted/moved since
    let size;
    try { size = statSync(r.path).size; } catch { continue; }
    // CORRECTION (2026-07-29): the first version of this probe replayed every
    // recorded path as a FULL read, stripping the offset/limit the real call
    // carried. offset/limit bypasses the enforcer by design, so that inflated
    // the measured interception rate to 34.4% when real transcripts show 27
    // denies in 1257 reads (~2%). Weight only the calls that were actually
    // eligible to be intercepted. Same defect shape as the four in the handoff:
    // a query narrower (here: wider) than the question, returning a number that
    // looked like an answer.
    const eligible = r.count - r.bypass_offset_limit;
    if (eligible <= 0) continue;
    files.push({ path: r.path, size, weight: eligible, bypassed: r.bypass_offset_limit });
  }
  return files;
}

const files = FROM_TRANSCRIPTS
  ? transcriptCorpus()
  : walk(PROJECT)
      .filter((f) => f.size >= 3000)
      .sort((a, b) => b.size - a.size)
      .slice(0, LIMIT)
      .map((f) => ({ ...f, weight: 1, bypassed: 0 }));

if (files.length === 0) {
  console.error('no candidate files found');
  process.exit(2);
}

const rows = [];
for (const f of files) {
  const r = runHook(f.path);
  rows.push({
    path: relative(PROJECT, f.path),
    raw: f.size,
    weight: f.weight,
    bypassed: f.bypassed,
    ...r,
  });
}

const denied = rows.filter((r) => r.decision === 'DENIED');
const allowed = rows.filter((r) => r.decision === 'ALLOWED');
// Weighted: a file read 30 times contributes 30x to both savings and cost.
const sum = (a, k) => a.reduce((n, r) => n + r[k] * r.weight, 0);
const calls = (a) => a.reduce((n, r) => n + r.weight, 0);
const totalCalls = calls(rows);

const rawDenied = sum(denied, 'raw');
const injDenied = sum(denied, 'injected');
// Net saving counts ONLY the denied files' delta, but the latency cost is paid
// on every file the hook saw. That asymmetry is the whole question.
const netSavedBytes = rawDenied - injDenied;
const totalMs = sum(rows, 'ms');

const report = {
  measured_at: new Date().toISOString(),
  project: PROJECT,
  corpus: FROM_TRANSCRIPTS ? 'real Read calls from session transcripts' : 'on-disk walk (CONTRAST ONLY)',
  files_probed: rows.length,
  read_calls_represented: totalCalls,
  denied: denied.length,
  denied_calls: calls(denied),
  allowed: allowed.length,
  interception_rate_pct: +((calls(denied) / totalCalls) * 100).toFixed(1),
  denied_raw_bytes: rawDenied,
  denied_injected_bytes: injDenied,
  savings_on_denied_pct: rawDenied ? +(((rawDenied - injDenied) / rawDenied) * 100).toFixed(1) : null,
  net_saved_tokens_est: tok(netSavedBytes),
  latency_total_ms: +totalMs.toFixed(0),
  latency_mean_ms: +(totalMs / rows.length).toFixed(0),
  latency_weighted_total_ms: +sum(rows, 'ms').toFixed(0),
  latency_p50_ms: +[...rows].sort((a, b) => a.ms - b.ms)[Math.floor(rows.length / 2)].ms.toFixed(0),
  latency_max_ms: +Math.max(...rows.map((r) => r.ms)).toFixed(0),
  token_estimator: 'bytes/4 (ESTIMATE, not /context)',
};

if (JSON_OUT) {
  console.log(JSON.stringify({ report, rows }, null, 2));
  process.exit(0);
}

console.log('TLDR read-enforcer — measured savings vs cost');
console.log('='.repeat(64));
console.log(`corpus: ${report.corpus}`);
console.log(`${report.files_probed} distinct code files, representing ${totalCalls} real Read calls`);
console.log('');
console.log(`  intercepted (DENIED) : ${calls(denied)}/${totalCalls} calls  (${report.interception_rate_pct}%)`);
console.log(`  passed through       : ${calls(allowed)}/${totalCalls} calls`);
if (rows.some((r) => r.decision === 'PARSE_FAIL')) {
  console.log(`  PARSE_FAIL           : ${rows.filter((r) => r.decision === 'PARSE_FAIL').length}`);
}
console.log('');
if (denied.length) {
  console.log(`  raw bytes (denied)   : ${rawDenied.toLocaleString()}  (~${tok(rawDenied).toLocaleString()} tok est)`);
  console.log(`  injected instead     : ${injDenied.toLocaleString()}  (~${tok(injDenied).toLocaleString()} tok est)`);
  console.log(`  savings on denied    : ${report.savings_on_denied_pct}%   <-- the number the rule claims is 95%`);
  console.log(`  net saved            : ~${report.net_saved_tokens_est.toLocaleString()} tok est`);
} else {
  console.log('  NOTHING WAS INTERCEPTED. Savings on this corpus = 0.');
}
console.log('');
console.log(`  latency mean         : ${report.latency_mean_ms}ms/call   p50 ${report.latency_p50_ms}ms   max ${report.latency_max_ms}ms`);
console.log(`  latency total        : ${report.latency_total_ms}ms across ${rows.length} calls`);
console.log('');
console.log('  NOTE: latency is paid on EVERY Read, including the passed-through ones.');
console.log(`  token figures are ${report.token_estimator}.`);
console.log('');
console.log('per-file:');
for (const r of rows.slice(0, 20)) {
  const pct = r.decision === 'DENIED' && r.raw ? `${(((r.raw - r.injected) / r.raw) * 100).toFixed(0)}%` : '-';
  console.log(`  ${r.decision.padEnd(8)} ${String(r.raw).padStart(7)}B -> ${String(r.injected).padStart(6)}B  ${pct.padStart(5)}  ${String(Math.round(r.ms)).padStart(5)}ms  ${r.path}`);
}
