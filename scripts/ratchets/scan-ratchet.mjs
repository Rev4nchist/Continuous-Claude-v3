#!/usr/bin/env node
/**
 * scan-ratchet.mjs - Fail CI on NEW high-severity scanner findings only.
 *
 * Reads a Trivy (`trivy fs --format json`) or Semgrep (`semgrep scan --json`) report,
 * keeps the high-severity findings, and compares them with a committed baseline.
 * A finding key that is new, or that occurs more often than in the baseline, fails.
 * Fixed findings pass and are listed so the baseline can shrink (--update).
 *
 * Usage:
 *   node scripts/ratchets/scan-ratchet.mjs --tool trivy   --report trivy.json   --baseline scripts/ratchets/trivy-baseline.json
 *   node scripts/ratchets/scan-ratchet.mjs --tool semgrep --report semgrep.json --baseline scripts/ratchets/semgrep-baseline.json
 *   add --update to write the current findings as the new baseline (needs a reason: --reason "<text>").
 *   add --changed <file> (NUL-separated from `git diff --name-only -z`, or one path per line) on a PR: a new finding
 *   in a file the PR did not change is DRIFT (new CVE or rule against old code), printed, not blocking.
 *
 * Exit: 0 no regression, 1 regression, 2 bad input (unreadable or malformed report or baseline).
 * Node builtins only.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TRIVY_LEVELS = new Set(['HIGH', 'CRITICAL']);
// Semgrep uses ERROR/WARNING/INFO; newer rule packs may also use CRITICAL/HIGH.
export const SEMGREP_LEVELS = new Set(['ERROR', 'CRITICAL', 'HIGH']);

export class InputError extends Error {}

function bump(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

/** Trivy JSON -> { key: count } for HIGH/CRITICAL vulns, failed misconfigs and secrets. */
export function trivyCounts(report) {
  if (!report || typeof report !== 'object' || !('SchemaVersion' in report)) {
    throw new InputError('not a Trivy JSON report (no SchemaVersion)');
  }
  const counts = {};
  for (const r of report.Results || []) {
    const target = r.Target || '?';
    for (const v of r.Vulnerabilities || []) {
      if (TRIVY_LEVELS.has(v.Severity)) bump(counts, `vuln|${target}|${v.VulnerabilityID}|${v.PkgName}`);
    }
    for (const m of r.Misconfigurations || []) {
      if (m.Status === 'FAIL' && TRIVY_LEVELS.has(m.Severity)) bump(counts, `misconf|${target}|${m.ID}`);
    }
    for (const s of r.Secrets || []) {
      if (TRIVY_LEVELS.has(s.Severity)) bump(counts, `secret|${target}|${s.RuleID}`);
    }
  }
  return counts;
}

/**
 * Semgrep JSON -> { key: count } for ERROR-level results. Line numbers are left out on purpose.
 * A file Semgrep could not fully scan (parse error, timeout) gets one `scan-error|<path>` key, so a
 * partial report cannot look clean: a NEW scan error in a changed file blocks like a new finding.
 * Presence only (count 1 per file): timeout counts vary with machine speed.
 */
export function semgrepCounts(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.results)) {
    throw new InputError('not a Semgrep JSON report (no results array)');
  }
  const counts = {};
  for (const r of report.results) {
    const sev = String(r.extra?.severity || '').toUpperCase();
    if (SEMGREP_LEVELS.has(sev)) bump(counts, `${r.check_id}|${r.path}`);
  }
  for (const e of report.errors || []) {
    if (e?.path) counts[`scan-error|${e.path}`] = 1;
  }
  return counts;
}

/** The file a key belongs to: field 2 for both formats (trivy kind|target|..., semgrep rule|path). */
export function keyFile(key) {
  return key.split('|')[1] || '';
}

/**
 * Compare current counts with the baseline counts.
 * With `changed` (a Set of repo paths), a regression in a file the change did not touch is
 * drift (a new CVE or a new rule against old code): reported, not blocking.
 */
export function compare(current, baseline, changed = null) {
  const regressions = [];
  const drift = [];
  const fixed = [];
  for (const [key, n] of Object.entries(current)) {
    const was = baseline[key] || 0;
    if (n <= was) continue;
    const item = { key, was, now: n };
    if (changed && !changed.has(keyFile(key))) drift.push(item);
    else regressions.push(item);
  }
  for (const [key, was] of Object.entries(baseline)) {
    const n = current[key] || 0;
    if (n < was) fixed.push({ key, was, now: n });
  }
  return { regressions, drift, fixed };
}

function readChanged(path) {
  if (!existsSync(path)) throw new InputError(`changed-files list not found: ${path}`);
  const text = readFileSync(path, 'utf8');
  // `git diff --name-only -z` (CI) is NUL-separated and never quotes non-ASCII names: keep bytes as-is.
  // A hand-written list is one path per line.
  const paths = text.includes('\0') ? text.split('\0') : text.split(/\r?\n/).map((l) => l.trim());
  return new Set(paths.filter(Boolean));
}

function readJson(path, what) {
  if (!existsSync(path)) throw new InputError(`${what} not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new InputError(`${what} is not valid JSON: ${path} (${err.message})`);
  }
}

function parseArgs(argv) {
  const opts = { update: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update') opts.update = true;
    else if (['--tool', '--report', '--baseline', '--reason', '--changed'].includes(a)) opts[a.slice(2)] = argv[++i];
    else throw new InputError(`unknown argument: ${a}`);
  }
  if (!['trivy', 'semgrep'].includes(opts.tool)) throw new InputError('--tool must be trivy or semgrep');
  if (!opts.report || !opts.baseline) throw new InputError('--report and --baseline are required');
  if (opts.update && !opts.reason) throw new InputError('--update needs --reason "<why these findings are accepted>"');
  return opts;
}

export function run(argv, log = console.log) {
  const opts = parseArgs(argv);
  const report = readJson(opts.report, 'report');
  const current = opts.tool === 'trivy' ? trivyCounts(report) : semgrepCounts(report);
  if (opts.update) {
    const keys = Object.keys(current).sort();
    const counts = Object.fromEntries(keys.map((k) => [k, current[k]]));
    const out = { tool: opts.tool, reason: opts.reason, total: keys.reduce((s, k) => s + counts[k], 0), counts };
    writeFileSync(opts.baseline, JSON.stringify(out, null, 2) + '\n', 'utf8');
    log(`${opts.tool} baseline written: ${out.total} findings, ${keys.length} keys -> ${opts.baseline}`);
    return 0;
  }
  const base = readJson(opts.baseline, 'baseline');
  if (!base || typeof base.counts !== 'object' || base.tool !== opts.tool) {
    throw new InputError(`baseline is not a ${opts.tool} scan-ratchet baseline: ${opts.baseline}`);
  }
  const changed = opts.changed ? readChanged(opts.changed) : null;
  const { regressions, drift, fixed } = compare(current, base.counts, changed);
  const total = Object.values(current).reduce((s, n) => s + n, 0);
  for (const r of regressions) log(`NEW  ${r.key}  (baseline ${r.was}, now ${r.now})`);
  for (const d of drift) log(`DRIFT ${d.key}  (baseline ${d.was}, now ${d.now}; file not changed here, not blocking)`);
  for (const f of fixed) log(`FIXED ${f.key}  (baseline ${f.was}, now ${f.now})`);
  if (fixed.length && !regressions.length) log('Findings went down: run with --update to shrink the baseline.');
  const verdict = regressions.length ? 'FAIL' : 'OK';
  log(`${opts.tool} ratchet ${verdict}: ${total} high-severity findings, baseline ${base.total}, new ${regressions.length}, drift ${drift.length}, fixed ${fixed.length}`);
  return regressions.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (err) {
    console.error(`scan-ratchet: ${err.message}`);
    process.exit(2);
  }
}
