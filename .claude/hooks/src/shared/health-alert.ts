/**
 * Health alert for the SessionStart memory hook (design 2026-10-31, section 3).
 *
 * The scheduled harness doctor writes ~/.claude/state/health/latest.json. This module reads it
 * and returns one line for Dave, or null when there is nothing to say:
 *   - fresh (under 36 h) with 0 fail and 0 warn: null (silent)
 *   - fresh with problems: "harness: N fail, N warn as of <time> (<age>): <top checks>. Run: ..."
 *   - older than 36 h: "harness doctor has not run since <time>" (the dead-man switch)
 *   - file missing: "harness doctor has never run. ..."
 *   - any read or parse error: null. A session start never breaks on this.
 *
 * The doctor JSON (scripts/harness-doctor.mjs) is
 *   { ts, repo, home, summary: {pass, warn, fail}, checks: [{status: PASS|WARN|FAIL, section, check, detail}] }.
 * Like shared/session-start-output.ts, this file is bundled into the hook, never built alone.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isCompactSource } from './session-source.js';

export const STALE_AFTER_MS = 36 * 3600_000;
const MAX_NAMES = 3;
const RUN_HINT = 'Run: node scripts/harness-doctor.mjs';
/** The hint with an absolute doctor path when the report names its repo; the relative text otherwise. */
const runHintFor = (repo: unknown): string =>
  typeof repo === 'string' && repo.trim() !== '' ? `Run: node "${repo}/scripts/harness-doctor.mjs"` : RUN_HINT;

/** The report path. CCV3_HEALTH_LATEST overrides it, so tests never read the real file. */
export function defaultLatestPath(): string {
  return process.env.CCV3_HEALTH_LATEST || join(homedir(), '.claude', 'state', 'health', 'latest.json');
}

/** Local time as "YYYY-MM-DD HH:MM". */
function formatTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * How old a report is, from the injected clock: "just now" (under 1 min or a future time),
 * "N min ago" (under 1 h), else "N h ago" (whole hours, rounded down).
 */
export function formatAge(reportTime: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - reportTime.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/** "YYYY-MM-DD HH:MM (3 h ago)": the time and its age, for a line that says "as of". */
const timeWithAge = (when: Date, now: Date): string => `${formatTime(when)} (${formatAge(when, now)})`;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

interface Problem { status: 'FAIL' | 'WARN'; name: string; detail: string }

function problemsOf(checks: unknown): Problem[] {
  if (!Array.isArray(checks)) return [];
  const out: Problem[] = [];
  for (const c of checks) {
    const rec = asRecord(c);
    const status = typeof rec?.status === 'string' ? rec.status.toUpperCase() : '';
    if (!rec || (status !== 'FAIL' && status !== 'WARN')) continue;
    out.push({
      status,
      name: `${String(rec.section ?? '?')}:${String(rec.check ?? '?')}`,
      detail: typeof rec.detail === 'string' ? rec.detail : '',
    });
  }
  return out;
}

/** The report's own `ts`, else the file time. Undefined when neither is a valid date. */
function reportTime(rec: Record<string, unknown>, fallbackTime?: Date): Date | undefined {
  const parsed = typeof rec.ts === 'string' ? new Date(rec.ts) : null;
  const when = parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallbackTime;
  return when && !Number.isNaN(when.getTime()) ? when : undefined;
}

const asCount =(v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Pure core. `doc` is the parsed JSON, `fallbackTime` the file's mtime for a report whose `ts`
 * is missing or invalid. Returns null for silence or for a document it cannot read.
 */
export function formatHealthAlert(doc: unknown, now: Date, fallbackTime?: Date): string | null {
  const rec = asRecord(doc);
  if (!rec || !Array.isArray(rec.checks)) return null;

  const when = reportTime(rec, fallbackTime);
  if (!when) return null;

  if (now.getTime() - when.getTime() > STALE_AFTER_MS) {
    return `harness doctor has not run since ${formatTime(when)}`;
  }

  const problems = problemsOf(rec.checks);
  const fails = problems.filter((p) => p.status === 'FAIL');
  const warns = problems.filter((p) => p.status === 'WARN');
  const summary = asRecord(rec.summary);
  const failCount = asCount(summary?.fail) ?? fails.length;
  const warnCount = asCount(summary?.warn) ?? warns.length;
  if (failCount === 0 && warnCount === 0) return null;

  const names = [...fails, ...warns].map((p) => p.name);
  const shown = names.slice(0, MAX_NAMES).join(', ');
  const more = names.length > MAX_NAMES ? ` and ${names.length - MAX_NAMES} more` : '';
  const list = names.length > 0 ? `: ${shown}${more}` : '';
  return `harness: ${failCount} fail, ${warnCount} warn as of ${timeWithAge(when, now)}${list}. ${runHintFor(rec.repo)}`;
}

type Report = { kind: 'missing' } | { kind: 'error' } | { kind: 'ok'; doc: unknown; mtime: Date };

/** Read and parse the report. Never throws. */
function loadReport(path: string): Report {
  try {
    const text = readFileSync(path, 'utf-8');
    const mtime = statSync(path).mtime;
    return { kind: 'ok', doc: JSON.parse(text), mtime };
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error' };
  }
}

const neverRunLine = (): string => `harness doctor has never run. ${RUN_HINT}`;

/** Read the report and build the line. Never throws. */
export function healthAlertLine(opts: { path?: string; now?: Date } = {}): string | null {
  const report = loadReport(opts.path ?? defaultLatestPath());
  if (report.kind === 'missing') return neverRunLine();
  if (report.kind === 'error') return null;
  return formatHealthAlert(report.doc, opts.now ?? new Date(), report.mtime);
}

// ---------------------------------------------------------------------------
// After /compact: print only a failing, stale or changed report (B5)
// ---------------------------------------------------------------------------

const MAX_DETAIL = 120;

/** Where the hash of the last printed problem set lives. Beside the report, so CCV3_HEALTH_LATEST moves both. */
export function defaultPrintStatePath(): string {
  return join(dirname(defaultLatestPath()), 'last-session-print.txt');
}

/** Index of the first (outermost) "(" that has no closing ")" in `s`, or -1. */
function firstOpenParen(s: string): number {
  const open: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') open.push(i);
    else if (s[i] === ')') open.pop();
  }
  return open.length > 0 ? open[0] : -1;
}

/**
 * Cut `flat` to at most `max` characters including a "..." tail. The cut falls on a word
 * boundary and never leaves an open "(" group, unless that would leave nothing: a single
 * long token is then cut hard.
 */
function cutAtWord(flat: string, max: number): string {
  if (flat.length <= max) return flat;
  let head = flat.slice(0, max - 3);
  const space = flat[head.length] === ' ' ? head.length : head.lastIndexOf(' ');
  if (space > 0) head = head.slice(0, space);
  const paren = firstOpenParen(head);
  if (paren > 0) head = head.slice(0, paren);
  return `${head.trimEnd().replace(/[,;:]+$/, '')}...`;
}

/** The first non-empty line, whitespace folded, cut at MAX_DETAIL on a word boundary. */
function oneLine(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return cutAtWord(first.replace(/\s+/g, ' ').trim(), MAX_DETAIL);
}

/**
 * Hash of the sorted FAIL/WARN names. Order and detail text do not matter. Empty string when
 * the report has no problem (or is not a report), so a healthy report clears the state.
 */
export function problemSetHash(doc: unknown): string {
  const rec = asRecord(doc);
  const lines = problemsOf(rec?.checks).map((p) => `${p.status} ${p.name}`).sort();
  return lines.length === 0 ? '' : createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Compact form of the alert. `line` is null when there is nothing new to say; `hash` is the
 * value to store as "last printed". A FAIL or a stale report prints every time. A WARN-only
 * report prints only when its set differs from `lastHash`. Shows the worst item and its detail.
 * A document it cannot read gives no line and leaves `lastHash` as it was.
 */
export function formatCompactAlert(
  doc: unknown,
  now: Date,
  fallbackTime: Date | undefined,
  lastHash: string,
): { line: string | null; hash: string } {
  const rec = asRecord(doc);
  if (!rec || !Array.isArray(rec.checks)) return { line: null, hash: lastHash };
  const when = reportTime(rec, fallbackTime);
  if (!when) return { line: null, hash: lastHash };
  if (now.getTime() - when.getTime() > STALE_AFTER_MS) {
    return { line: `harness doctor has not run since ${formatTime(when)}`, hash: lastHash };
  }

  const problems = problemsOf(rec.checks);
  const fails = problems.filter((p) => p.status === 'FAIL');
  const warns = problems.filter((p) => p.status === 'WARN');
  const summary = asRecord(rec.summary);
  const failCount = asCount(summary?.fail) ?? fails.length;
  const warnCount = asCount(summary?.warn) ?? warns.length;
  if (failCount === 0 && warnCount === 0) return { line: null, hash: '' };

  const hash = problemSetHash(rec);
  if (failCount === 0 && hash === lastHash) return { line: null, hash };

  const worst = fails[0] ?? warns[0];
  const rest = problems.length - 1;
  let tail = '';
  if (worst) {
    const detail = oneLine(worst.detail);
    tail = `: ${worst.name}${detail ? ` (${detail})` : ''}${rest > 0 ? ` and ${rest} more` : ''}`;
  }
  const line = `harness: ${failCount} fail, ${warnCount} warn as of ${timeWithAge(when, now)}${tail}. ${runHintFor(rec.repo)}`;
  return { line, hash };
}

function readPrintState(path: string): string {
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return '';
  }
}

/** Atomic write (temp file, then rename). Never throws: a lost write only means one repeat print. */
function writePrintState(path: string, hash: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, hash);
    renameSync(tmp, path);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch { /* nothing to clean */ }
  }
}

/**
 * The harness line for one SessionStart. At startup it is the full line (as healthAlertLine)
 * and the printed problem set is stored. After compact it is the compact line, or null when
 * nothing failed, went stale or changed. Never throws.
 */
export function healthAlertForSource(
  source: string | undefined,
  opts: { path?: string; now?: Date; statePath?: string } = {},
): string | null {
  try {
    const now = opts.now ?? new Date();
    const report = loadReport(opts.path ?? defaultLatestPath());
    if (report.kind === 'missing') return neverRunLine();
    if (report.kind === 'error') return null;

    const statePath = opts.statePath ?? defaultPrintStatePath();
    const last = readPrintState(statePath);
    const next = formatCompactAlert(report.doc, now, report.mtime, last);
    if (next.hash !== last) writePrintState(statePath, next.hash);
    return isCompactSource(source) ? next.line : formatHealthAlert(report.doc, now, report.mtime);
  } catch {
    return null;
  }
}

