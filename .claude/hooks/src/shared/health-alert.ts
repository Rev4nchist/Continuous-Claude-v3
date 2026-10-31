/**
 * Health alert for the SessionStart memory hook (design 2026-10-31, section 3).
 *
 * The scheduled harness doctor writes ~/.claude/state/health/latest.json. This module reads it
 * and returns one line for Dave, or null when there is nothing to say:
 *   - fresh (under 36 h) with 0 fail and 0 warn: null (silent)
 *   - fresh with problems: "harness: N fail, N warn as of <time>: <top checks>. Run: ..."
 *   - older than 36 h: "harness doctor has not run since <time>" (the dead-man switch)
 *   - file missing: "harness doctor has never run. ..."
 *   - any read or parse error: null. A session start never breaks on this.
 *
 * The doctor JSON (scripts/harness-doctor.mjs) is
 *   { ts, repo, home, summary: {pass, warn, fail}, checks: [{status: PASS|WARN|FAIL, section, check, detail}] }.
 * Like shared/session-start-output.ts, this file is bundled into the hook, never built alone.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

interface Problem { status: 'FAIL' | 'WARN'; name: string }

function problemsOf(checks: unknown): Problem[] {
  if (!Array.isArray(checks)) return [];
  const out: Problem[] = [];
  for (const c of checks) {
    const rec = asRecord(c);
    const status = typeof rec?.status === 'string' ? rec.status.toUpperCase() : '';
    if (!rec || (status !== 'FAIL' && status !== 'WARN')) continue;
    out.push({ status, name: `${String(rec.section ?? '?')}:${String(rec.check ?? '?')}` });
  }
  return out;
}

const asCount = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Pure core. `doc` is the parsed JSON, `fallbackTime` the file's mtime for a report whose `ts`
 * is missing or invalid. Returns null for silence or for a document it cannot read.
 */
export function formatHealthAlert(doc: unknown, now: Date, fallbackTime?: Date): string | null {
  const rec = asRecord(doc);
  if (!rec || !Array.isArray(rec.checks)) return null;

  const parsed = typeof rec.ts === 'string' ? new Date(rec.ts) : null;
  const when = parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallbackTime;
  if (!when || Number.isNaN(when.getTime())) return null;

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
  return `harness: ${failCount} fail, ${warnCount} warn as of ${formatTime(when)}${list}. ${runHintFor(rec.repo)}`;
}

/** Read the report and build the line. Never throws. */
export function healthAlertLine(opts: { path?: string; now?: Date } = {}): string | null {
  try {
    const path = opts.path ?? defaultLatestPath();
    let text: string;
    let mtime: Date;
    try {
      text = readFileSync(path, 'utf-8');
      mtime = statSync(path).mtime;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return `harness doctor has never run. ${RUN_HINT}`;
      return null;
    }
    return formatHealthAlert(JSON.parse(text), opts.now ?? new Date(), mtime);
  } catch {
    return null;
  }
}
