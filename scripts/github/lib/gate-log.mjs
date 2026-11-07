// The gate-outcome log: one JSON line per pre-pr step, appended to one file (default ~/.claude/logs/pre-pr-gates.jsonl).
// Fields: ts, branch, head, base, run_id, step, status, ms, detail. No PR body, no file contents, no step output.
// Reader: scripts/github/pre-pr-gate-stats.mjs. Design: .claudedocs/2026-11-07-prepr-checks-effectiveness.md, change 3.
import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DETAIL_MAX = 200;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const TOKEN = /\b(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-|AKIA)[A-Za-z0-9_-]{8,}/g;
const ASSIGNED = /\b((?:[A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|apikey|authorization))\s*[=:]\s*)\S+/gi;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g;

/** The ~/.claude/logs folder (USERPROFILE, then HOME, then the OS home). */
export function logsDir(env = process.env) {
  return path.join(env.USERPROFILE || env.HOME || os.homedir(), '.claude', 'logs');
}

/** The log file: PRE_PR_GATE_LOG when set (tests use it), else <logs dir>/pre-pr-gates.jsonl. */
export function gateLogPath(env = process.env) {
  return env.PRE_PR_GATE_LOG || path.join(logsDir(env), 'pre-pr-gates.jsonl');
}

/** One line of detail: no colour codes, one space between words, secrets masked, at most DETAIL_MAX chars. */
export function cleanDetail(detail) {
  const text = String(detail ?? '').replace(ANSI, '').replace(TOKEN, '[redacted]').replace(BEARER, '$1[redacted]').replace(ASSIGNED, '$1[redacted]').replace(/\s+/g, ' ').trim();
  return text.length <= DETAIL_MAX ? text : `${text.slice(0, DETAIL_MAX - 3)}...`;
}

/** The rows of one run: one per result, in order. `durations` is a WeakMap from a result to its wall time in ms. */
export function gateRows({ results, durations, runId, now, branch, head, base }) {
  return results.map((r) => ({
    ts: now.toISOString(), branch, head, base, run_id: runId, step: r.step, status: r.status,
    ms: durations.has(r) ? durations.get(r) : null, detail: cleanDetail(r.detail),
  }));
}

/** Appends the rows in one write. Never throws: a log problem must not fail or slow a pre-pr run. Returns true when written. */
export function appendGateRows(file, rows) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
    return true;
  } catch { return false; }
}
