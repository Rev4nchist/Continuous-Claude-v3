// zizmor advisory step for pre-pr (a one-week trial, Dave 2026-11-03). It never fails pre-pr: every problem is a NOTE.
//   findZizmor({ env, home })                 the binary: CCV3_ZIZMOR, else the newest ~/tools/review-scanners/zizmor/<ver>/bin/zizmor.exe
//   workflowFiles(paths, root)                the changed workflow files that still exist
//   zizmorAdvisory({ root, paths, bin, run }) a pre-pr step { step, status: 'NOTE', detail, notes }, or null when no workflow changed
// zizmor exits 14 on a High finding in json mode, so the exit code is ignored. Only the JSON is read.
// The repo config is .github/zizmor.yml; zizmor finds it from the input files.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { scannerBase, versionFoldersNewestFirst } from './scanner-bin.mjs';

const SEVERITIES = ['High', 'Medium', 'Low', 'Informational', 'Unknown'];
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const TOP = 3;
const note = (detail) => ({ step: 'zizmor', status: 'NOTE', detail, notes: [] });
// What zizmor prints when it cannot read an input: --strict-collection stops with 'failed to load file://<path> as workflow'; without it a WARN says 'failed to parse input'.
const LOAD_FAILURE = /failed to load (?:file:\/\/)?(\S+) as /;
const COLLECT_WARNING = /WARN.*failed to (?:parse|load|collect)/i;

export function findZizmor({ env = process.env, home = homedir() } = {}) {
  if (env.CCV3_ZIZMOR && existsSync(env.CCV3_ZIZMOR)) return env.CCV3_ZIZMOR;
  const base = scannerBase('zizmor', home);
  return versionFoldersNewestFirst(base).map((v) => path.join(base, v, 'bin', 'zizmor.exe')).find((p) => existsSync(p)) ?? null;
}

export function workflowFiles(paths, root) {
  return paths.map((p) => String(p).replace(/\\/g, '/')).filter((p) => WORKFLOW.test(p) && existsSync(path.join(root, p)));
}

/** { severity, where: 'file:line', ident } for one zizmor finding. Lines are 1-based; zizmor counts rows from 0. */
function describe(f) {
  const loc = (f.locations ?? []).find((l) => l.symbolic?.kind === 'Primary') ?? f.locations?.[0];
  const file = loc?.symbolic?.key?.Local?.verbatim_path ?? '(unknown)';
  const row = loc?.concrete?.location?.start_point?.row;
  const severity = SEVERITIES.includes(f.determinations?.severity) ? f.determinations.severity : 'Unknown';
  return { severity, where: `${String(file).replace(/\\/g, '/')}${Number.isInteger(row) ? `:${row + 1}` : ''}`, ident: String(f.ident ?? '?') };
}

const rank = (s) => SEVERITIES.indexOf(s);
const order = (a, b) => rank(a.severity) - rank(b.severity) || a.where.localeCompare(b.where, 'en', { numeric: true });

function summary(findings) {
  if (findings.length === 0) return 'no findings';
  const counts = SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]).filter(([, n]) => n > 0);
  const top = [...findings].sort(order).slice(0, TOP).map((f) => `${f.where} ${f.ident} (${f.severity})`);
  return `${findings.length} finding(s): ${counts.map(([s, n]) => `${n} ${s}`).join(', ')}; top: ${top.join('; ')}`;
}

const defaultRun = (bin, args, { cwd }) => spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

export function zizmorAdvisory({ root, paths, bin, run = defaultRun }) {
  const files = workflowFiles(paths, root);
  if (files.length === 0) return null;
  const tag = 'advisory only (one-week trial, never fails pre-pr)';
  if (!bin) return note(`skipped: zizmor not found (set CCV3_ZIZMOR or install under ~/tools/review-scanners/zizmor); ${tag}`);
  try {
    const r = run(bin, ['--offline', '--strict-collection', '--format', 'json', ...files], { cwd: root });
    if (r.error || r.timedOut) return note(`skipped: zizmor could not run (${r.timedOut ? 'timed out' : r.error}); ${tag}`);
    const bad = LOAD_FAILURE.exec(String(r.stderr ?? ''));
    if (bad) return note(`incomplete scan: zizmor could not read ${bad[1].replace(/\\/g, '/')}, so no workflow was audited; ${tag}`);
    const parsed = JSON.parse(String(r.stdout ?? ''));
    if (!Array.isArray(parsed)) throw new Error('output is not a findings list');
    const partial = COLLECT_WARNING.test(String(r.stderr ?? '')) ? 'incomplete scan (zizmor could not parse an input): ' : '';
    return note(`${partial}${summary(parsed.map(describe))} in ${files.length} workflow file(s); ${tag}`);
  } catch (err) {
    return note(`skipped: zizmor output could not be read (${String(err.message).split('\n')[0]}); ${tag}`);
  }
}
