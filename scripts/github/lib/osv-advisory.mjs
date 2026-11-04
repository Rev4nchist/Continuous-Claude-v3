// osv-scanner advisory step for pre-pr (a one-week trial, Dave 2026-11-03). It never fails pre-pr: every problem is a NOTE.
//   findOsv({ env, home })                           the binary: CCV3_OSV (a path; "off" disables the step), else the newest ~/tools/review-scanners/osv-scanner/<ver>/osv-scanner_windows_amd64.exe
//   lockfilesIn(root, list)                          the tracked package-lock.json, uv.lock and requirements.txt that still exist (list defaults to `git ls-files`)
//   osvAdvisory({ root, paths, bin, run, lockfiles }) a pre-pr step { step: 'osv', status: 'NOTE', detail, notes }, or null when no lockfile is tracked
// It runs on every pre-pr, not only when a lockfile changed: the 11-10 decision needs a week of data.
// The report is compared with scripts/ratchets/osv-baseline.json by the same code as the CI ratchet (scan-ratchet.mjs).
// `paths` (the PR's changed files) splits a new advisory into new (its lockfile changed) and drift (it did not).
// CCV3_OSV=off turns the step into a skip NOTE (a bad network day). osv-scanner needs the network (osv.dev). Exit 0 or 1 means it ran; any other exit, a spawn error or a time-out is a skip NOTE.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { compare, osvReport, remapOsvKeys } from '../../ratchets/scan-ratchet.mjs';
import { scannerBase, versionFoldersNewestFirst } from './scanner-bin.mjs';

const EXE = 'osv-scanner_windows_amd64.exe';
const LOCKFILE = /(^|\/)(package-lock\.json|uv\.lock|requirements\.txt)$/;
const BASELINE_REL = 'scripts/ratchets/osv-baseline.json';
const TOP = 3;
const TAG = 'advisory only (one-week trial, never fails pre-pr)';
const note = (detail) => ({ step: 'osv', status: 'NOTE', detail: `${detail}; ${TAG}`, notes: [] });

const isOff = (env) => String(env.CCV3_OSV ?? '').toLowerCase() === 'off';

export function findOsv({ env = process.env, home = homedir() } = {}) {
  if (isOff(env)) return null;
  if (env.CCV3_OSV && existsSync(env.CCV3_OSV)) return env.CCV3_OSV;
  const base = scannerBase('osv-scanner', home);
  return versionFoldersNewestFirst(base).map((v) => path.join(base, v, EXE)).find((p) => existsSync(p)) ?? null;
}

function trackedFiles(root) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? String(r.stdout).split('\0').filter(Boolean) : [];
}

export function lockfilesIn(root, list = trackedFiles(root)) {
  return list.map((f) => String(f).replace(/\\/g, '/')).filter((f) => LOCKFILE.test(f) && existsSync(path.join(root, f)));
}

function readBaseline(root) {
  try {
    const b = JSON.parse(readFileSync(path.join(root, BASELINE_REL), 'utf8'));
    return b && b.tool === 'osv' && b.counts && typeof b.counts === 'object' ? b : null;
  } catch { return null; }
}

/** The line of stderr that says what went wrong: the first with error/fail in it, else the last non-empty line. */
function reason(r) {
  if (r.timedOut) return 'timed out';
  if (r.error) return String(r.error.message ?? r.error).split('\n')[0];
  const lines = String(r.stderr ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error|fail/i.test(l)) ?? lines.at(-1) ?? `exit ${r.status}`;
}

const defaultRun = (bin, args, { cwd }) => spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

function summarize({ counts, ids }, base, paths, lockfiles) {
  const changed = new Set(paths.map((p) => String(p).replace(/\\/g, '/')));
  const { regressions, drift, fixed } = compare(remapOsvKeys(counts, ids, base), base.counts, changed);
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const top = regressions.slice(0, TOP).map((x) => x.key).join(', ') || 'none';
  return `${total} high/unscored advisory group(s) in ${lockfiles.length} lockfile(s), baseline ${base.total}, new ${regressions.length}, drift ${drift.length}, fixed ${fixed.length}; top new: ${top}`;
}

export function osvAdvisory({ root, paths = [], bin, run = defaultRun, lockfiles = lockfilesIn(root), env = process.env }) {
  const files = lockfilesIn(root, lockfiles);
  if (files.length === 0) return null;
  if (isOff(env)) return note('skipped: CCV3_OSV=off');
  if (!bin) return note('skipped: osv-scanner not found (set CCV3_OSV or install under ~/tools/review-scanners/osv-scanner)');
  const base = readBaseline(root);
  if (!base) return note(`skipped: no baseline (${BASELINE_REL} is missing or not an osv baseline)`);
  let r;
  try {
    r = run(bin, ['scan', 'source', '--format', 'json', ...files.flatMap((f) => ['-L', f])], { cwd: root });
  } catch (err) {
    r = { error: err };
  }
  if (r.error || r.timedOut || (r.status !== 0 && r.status !== 1)) return note(`skipped: osv-scanner could not run (${reason(r)})`);
  try {
    return note(summarize(osvReport(JSON.parse(String(r.stdout ?? '')), root), base, paths, files));
  } catch (err) {
    return note(`skipped: osv-scanner output could not be read (${String(err.message).split('\n')[0]})`);
  }
}
