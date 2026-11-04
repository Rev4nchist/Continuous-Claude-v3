#!/usr/bin/env node
/**
 * scan-ratchet.mjs - Fail CI on NEW high-severity scanner findings only.
 *
 * Reads a Trivy (`trivy fs --format json`), Semgrep (`semgrep scan --json`) or osv-scanner
 * (`osv-scanner scan source --format json`) report,
 * keeps the high-severity findings, and compares them with a committed baseline.
 * A finding key that is new, or that occurs more often than in the baseline, fails.
 * Fixed findings pass and are listed so the baseline can shrink (--update).
 *
 * Usage:
 *   node scripts/ratchets/scan-ratchet.mjs --tool trivy   --report trivy.json   --baseline scripts/ratchets/trivy-baseline.json
 *   node scripts/ratchets/scan-ratchet.mjs --tool semgrep --report semgrep.json --baseline scripts/ratchets/semgrep-baseline.json
 *   node scripts/ratchets/scan-ratchet.mjs --tool osv     --report osv.json     --baseline scripts/ratchets/osv-baseline.json --root .
 *     (osv: one key per advisory group with max_severity >= 7 or unscored; --root turns the report's absolute lockfile paths into repo paths)
 *   add --update to write the current findings as the new baseline (needs a reason: --reason "<text>").
 *   add --changed <file> (NUL-separated from `git diff --name-only -z`, or one path per line) on a PR: a new finding
 *   in a file the PR did not change is DRIFT (new CVE or rule against old code), printed, not blocking.
 *
 * Exit: 0 no regression, 1 regression, 2 bad input (unreadable or malformed report or baseline).
 * Node builtins only.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// osv: a group counts when its max CVSS score is at least this, or when it has no usable score.
export const OSV_MIN_SEVERITY = 7;
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

const slashes = (p) => String(p).replace(/\\/g, '/');

/**
 * `p` relative to `root`, with forward slashes and no leading slash; null when `p` is not under `root`.
 * Case-insensitive (Windows). The root must end at a folder boundary: C:/a/bc is not under C:/a/b.
 */
export function relativeTo(p, root) {
  const file = slashes(p);
  const base = slashes(root).replace(/\/+$/, '');
  if (file.toLowerCase() === base.toLowerCase()) return '';
  if (!file.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return null;
  return file.slice(base.length + 1).replace(/^\/+/, '');
}

const osvCounted = (maxSeverity) => {
  if (maxSeverity === undefined || maxSeverity === null || String(maxSeverity).trim() === '') return true;
  const n = Number(maxSeverity);
  return Number.isNaN(n) || n >= OSV_MIN_SEVERITY;
};

/**
 * osv-scanner JSON -> { counts, ids }. counts is { key: count }, one key per advisory group:
 * `osv|<lockfile relative to root>|<first sorted id>|<ecosystem>/<name>`.
 * The version is left out on purpose: a bump that does not fix the advisory keeps the key.
 * A group counts at max_severity >= OSV_MIN_SEVERITY, or when it has no usable score (fail safe).
 * ids is { key: [every id and alias of the group, sorted] }: osv.dev can add an id to a group, which
 * can change the first sorted id, so remapOsvKeys matches a changed key to its baseline key by these ids.
 */
export function osvReport(report, root) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.results)) {
    throw new InputError('not an osv-scanner JSON report (no results array)');
  }
  const counts = {};
  const idSets = {};
  for (const r of report.results) {
    const rel = relativeTo(r.source?.path ?? '', root);
    if (rel === null || rel === '') throw new InputError(`osv source path is not under --root: ${r.source?.path} (root ${root})`);
    for (const pkg of r.packages || []) {
      const who = `${pkg.package?.ecosystem ?? '?'}/${pkg.package?.name ?? '?'}`;
      for (const g of pkg.groups || []) {
        if (!osvCounted(g.max_severity)) continue;
        const ids = [...(g.ids || [])].map(String).sort();
        const key = `osv|${rel}|${ids[0] ?? '?'}|${who}`;
        bump(counts, key);
        idSets[key] ??= new Set();
        for (const id of [...ids, ...(g.aliases || []).map(String)]) idSets[key].add(id);
      }
    }
  }
  return { counts, ids: Object.fromEntries(Object.entries(idSets).map(([k, set]) => [k, [...set].sort()])) };
}

/** osv-scanner JSON -> { key: count } (see osvReport). */
export function osvCounts(report, root) {
  return osvReport(report, root).counts;
}

/**
 * Give a current key that is not in the baseline the baseline key of the same advisory: same lockfile and package,
 * and at least one id (or alias) in common with the ids stored in the baseline. A baseline without `ids` changes nothing.
 */
export function remapOsvKeys(counts, ids, baseline) {
  const known = baseline?.counts ?? {};
  const stored = baseline?.ids;
  if (!stored || typeof stored !== 'object') return counts;
  const slot = (key) => { const f = key.split('|'); return `${f[1]}|${f[3]}`; };
  const bySlot = new Map();
  for (const key of Object.keys(stored)) {
    if (!(key in known)) continue;
    bySlot.set(slot(key), [...(bySlot.get(slot(key)) ?? []), key]);
  }
  const out = {};
  for (const [key, n] of Object.entries(counts)) {
    let target = key;
    if (!(key in known)) {
      const mine = new Set(ids[key] ?? []);
      const hit = (bySlot.get(slot(key)) ?? []).find((b) => (stored[b] ?? []).some((id) => mine.has(id)));
      if (hit) target = hit;
    }
    out[target] = (out[target] || 0) + n;
  }
  return out;
}

/** The file a key belongs to: field 2 for all formats (trivy kind|target|..., semgrep rule|path, osv osv|lockfile|...). */
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
    else if (['--tool', '--report', '--baseline', '--reason', '--changed', '--root'].includes(a)) opts[a.slice(2)] = argv[++i];
    else throw new InputError(`unknown argument: ${a}`);
  }
  if (!['trivy', 'semgrep', 'osv'].includes(opts.tool)) throw new InputError('--tool must be trivy, semgrep or osv');
  opts.root = path.resolve(opts.root || process.cwd());
  if (!opts.report || !opts.baseline) throw new InputError('--report and --baseline are required');
  if (opts.update && !opts.reason) throw new InputError('--update needs --reason "<why these findings are accepted>"');
  return opts;
}

export function run(argv, log = console.log) {
  const opts = parseArgs(argv);
  const report = readJson(opts.report, 'report');
  const osv = opts.tool === 'osv' ? osvReport(report, opts.root) : null;
  const current = osv ? osv.counts : opts.tool === 'trivy' ? trivyCounts(report) : semgrepCounts(report);
  if (opts.update) {
    const keys = Object.keys(current).sort();
    const counts = Object.fromEntries(keys.map((k) => [k, current[k]]));
    const out = { tool: opts.tool, reason: opts.reason, total: keys.reduce((s, k) => s + counts[k], 0), counts };
    // osv: every id of each key, so a group that gains an id later still matches (remapOsvKeys).
    if (osv) out.ids = Object.fromEntries(keys.map((k) => [k, osv.ids[k]]));
    writeFileSync(opts.baseline, JSON.stringify(out, null, 2) + '\n', 'utf8');
    log(`${opts.tool} baseline written: ${out.total} findings, ${keys.length} keys -> ${opts.baseline}`);
    return 0;
  }
  const base = readJson(opts.baseline, 'baseline');
  if (!base || typeof base.counts !== 'object' || base.tool !== opts.tool) {
    throw new InputError(`baseline is not a ${opts.tool} scan-ratchet baseline: ${opts.baseline}`);
  }
  const changed = opts.changed ? readChanged(opts.changed) : null;
  const matched = osv ? remapOsvKeys(current, osv.ids, base) : current;
  const { regressions, drift, fixed } = compare(matched, base.counts, changed);
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
