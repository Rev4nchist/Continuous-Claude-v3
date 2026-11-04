// PSScriptAnalyzer advisory step for pre-pr (a one-week trial, Dave 2026-11-03). It never fails pre-pr: every problem is a NOTE.
//   findPssa({ env, home })                           the module: CCV3_PSSA, else the newest ~/tools/review-scanners/PSScriptAnalyzer/<ver>/PSScriptAnalyzer/<ver>/PSScriptAnalyzer.psd1
//   psFiles(paths, root)                              the changed .ps1 files that still exist
//   pssaAdvisory({ root, paths, module, run })        a pre-pr step { step: 'pssa', status: 'NOTE', detail, notes }, or null when no existing .ps1 changed
// Rules come from PSScriptAnalyzerSettings.psd1 at the repo root. Invoke-ScriptAnalyzer -Path <file> does not find that file
// by itself, and a PathInfo object is ignored, so the script passes -Settings <absolute path string>.
// -Path takes one file, so the script loops. File paths, the settings path and the module path go in through the
// environment (CCV3_PSSA_FILES, CCV3_PSSA_SETTINGS, CCV3_PSSA_MODULE): nothing is put into the script text.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { relativeTo } from '../../ratchets/scan-ratchet.mjs';
import { scannerBase, versionFoldersNewestFirst } from './scanner-bin.mjs';

const SEVERITIES = ['Error', 'ParseError', 'Warning', 'Information', 'Unknown'];
const TOP = 3;
const TAG = 'advisory only (one-week trial, never fails pre-pr)';
const SETTINGS_REL = 'PSScriptAnalyzerSettings.psd1';
// The script prints this line, then the JSON. Anything on stdout before the marker (module or rule noise) is ignored.
export const MARKER = '@@CCV3_PSSA_JSON@@';
const note = (detail) => ({ step: 'pssa', status: 'NOTE', detail: `${detail}; ${TAG}`, notes: [] });

// Fixed text. The preferences keep warnings, information and progress out of the output. -Path takes wildcards, so each name is escaped. ConvertTo-Json -InputObject @(...) keeps a single finding inside an array; Severity is an enum, so it is written as a string.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$WarningPreference = 'SilentlyContinue'",
  "$InformationPreference = 'SilentlyContinue'",
  "$ProgressPreference = 'SilentlyContinue'",
  'Import-Module $env:CCV3_PSSA_MODULE',
  '$out = @()',
  'foreach ($f in ($env:CCV3_PSSA_FILES -split "`n")) {',
  '  if (-not $f) { continue }',
  '  foreach ($r in @(Invoke-ScriptAnalyzer -Path ([WildcardPattern]::Escape($f)) -Settings $env:CCV3_PSSA_SETTINGS)) {',
  '    $out += [pscustomobject]@{ RuleName = $r.RuleName; Severity = $r.Severity.ToString(); ScriptPath = $r.ScriptPath; Line = $r.Line }',
  '  }',
  '}',
  `Write-Output '${MARKER}'`,
  'ConvertTo-Json -InputObject @($out) -Compress -Depth 3',
].join('\n');

export function findPssa({ env = process.env, home = homedir() } = {}) {
  if (env.CCV3_PSSA && existsSync(env.CCV3_PSSA)) return env.CCV3_PSSA;
  const base = scannerBase('PSScriptAnalyzer', home);
  return versionFoldersNewestFirst(base).map((v) => path.join(base, v, 'PSScriptAnalyzer', v, 'PSScriptAnalyzer.psd1')).find((p) => existsSync(p)) ?? null;
}

export function psFiles(paths, root) {
  const files = paths.map((p) => String(p).replace(/\\/g, '/')).filter((p) => /\.ps1$/i.test(p) && existsSync(path.join(root, p)));
  return [...new Set(files)];
}

function describe(f, root) {
  const severity = SEVERITIES.includes(f.Severity) ? f.Severity : 'Unknown';
  const file = String(f.ScriptPath ?? '(unknown)');
  const where = `${relativeTo(file, root) ?? file.replace(/\\/g, '/')}${Number.isInteger(f.Line) ? `:${f.Line}` : ''}`;
  return { severity, where, rule: String(f.RuleName ?? '?') };
}

const order = (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.where.localeCompare(b.where, 'en', { numeric: true });

function summary(findings, fileCount) {
  if (findings.length === 0) return `no findings in ${fileCount} .ps1 file(s)`;
  const counts = SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]).filter(([, n]) => n > 0);
  const top = [...findings].sort(order).slice(0, TOP).map((f) => `${f.where} ${f.rule} (${f.severity})`);
  return `${findings.length} finding(s): ${counts.map(([s, n]) => `${n} ${s}`).join(', ')}; top: ${top.join('; ')} in ${fileCount} .ps1 file(s)`;
}

/** The stderr line that says what went wrong: the first with error/exception/not in it, else the last non-empty line. */
function reason(r) {
  if (r.timedOut) return 'timed out';
  if (r.error) return String(r.error.message ?? r.error).split('\n')[0];
  const lines = String(r.stderr ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error|exception|fail|not /i.test(l)) ?? lines.at(-1) ?? `exit ${r.status}`;
}

const defaultRun = (bin, args, { cwd, env }) => spawnSync(bin, args, { cwd, env, encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

export function pssaAdvisory({ root, paths = [], module, run = defaultRun }) {
  const files = psFiles(paths, root);
  if (files.length === 0) return null;
  if (!module) return note('skipped: PSScriptAnalyzer not found (set CCV3_PSSA or install under ~/tools/review-scanners/PSScriptAnalyzer)');
  const env = {
    ...process.env,
    CCV3_PSSA_MODULE: module,
    CCV3_PSSA_SETTINGS: path.join(root, SETTINGS_REL),
    CCV3_PSSA_FILES: files.map((f) => path.join(root, f)).join('\n'),
  };
  let r;
  try {
    r = run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { cwd: root, env });
  } catch (err) {
    r = { error: err };
  }
  if (r.error || r.timedOut || r.status !== 0) return note(`skipped: PSScriptAnalyzer could not run (${reason(r)})`);
  try {
    const text = String(r.stdout ?? '');
    const at = text.indexOf(MARKER);
    if (at < 0) throw new Error('no marker line in the output');
    const parsed = JSON.parse(text.slice(at + MARKER.length));
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && 'RuleName' in parsed ? [parsed] : null;
    if (!list) throw new Error('output is not a findings list');
    return note(summary(list.map((f) => describe(f, root)), files.length));
  } catch (err) {
    return note(`skipped: PSScriptAnalyzer output could not be read (${String(err.message).split('\n')[0]})`);
  }
}
