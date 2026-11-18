/**
 * Flake ledger (card coord-flake-ledger, design .claudedocs/coordination/2026-11-18-coord-flake-ledger-design.md rev 2).
 *
 * A retry pass is one test that passed only on a retry in one vitest run (TestCase.diagnostic().flaky). Each one is one JSON line in the
 * ledger. A test with a retry pass in THIS run and 2 or more rows in the last 7 days (this run included) fails the run.
 *
 * Plain .mjs outside src on purpose: write-build-inputs.mjs hashes every src/**\/*.ts, so a file there would need a hook build.
 * Printed lines name only <file>:<line> and counts. A test name can hold a listed id; it stays in the local ledger file only.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';

export const WINDOW_MS = 7 * 24 * 3600 * 1000;
export const LIMIT = 2;

/** The ledger file: FLAKE_LEDGER_PATH, else one file for the primary checkout and every worktree. */
export function ledgerPath(env = process.env) {
  return env.FLAKE_LEDGER_PATH || join(homedir(), '.claude', 'state', 'flake-ledger.jsonl');
}

const retryCountOf = (r) => (r && typeof r === 'object' ? Number(r.count ?? 0) : Number(r ?? 0));

/**
 * True when a test's retry came from the run (--retry), false when the test declares its own retry. vitest fills each test's
 * `options.retry` from the run unless the test sets one, so a value other than the run's is the author's choice: a test that fails
 * its first try on purpose to prove a retry works (CHR, RTR in decision-gate-app-repos-*.test.ts). The ledger records only run retries.
 */
export function isRunRetry(ownRetry, runRetry) {
  // No own value: count it (seat 09:00). If a later vitest stops filling options.retry, the ledger records more, never nothing.
  if (ownRetry === undefined || ownRetry === null) return true;
  return retryCountOf(ownRetry) === retryCountOf(runRetry);
}

/** The test file relative to the vitest root, with forward slashes: one value on Windows, Linux, a worktree and the primary. */
export function relFile(root, file) {
  const toSlash = (p) => String(p).replace(/\\/g, '/');
  const r = toSlash(root).replace(/\/+$/, '');
  const f = toSlash(file);
  // path.relative cannot mix a Windows root with a posix file, so strip the prefix by hand when it matches.
  if (f.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return f.slice(r.length + 1);
  return toSlash(relative(root, file));
}

export function recordKey(root, file, fullName) {
  return `${relFile(root, file)} > ${fullName}`;
}

const isRow = (o) => o !== null && typeof o === 'object' && typeof o.key === 'string' && typeof o.at === 'string' && !Number.isNaN(Date.parse(o.at));

/** Rows of the ledger text. A blank line is ignored; any other line that is not a row is skipped and counted in `bad`. */
export function parseLedger(text) {
  const rows = [];
  let bad = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (isRow(o)) rows.push(o);
    else bad += 1;
  }
  return { rows, bad };
}

/** Rows of `key` in the 7 days before `now`. */
export function countInWindow(rows, key, now) {
  return rows.filter((r) => r.key === key && now - Date.parse(r.at) <= WINDOW_MS).length;
}

/**
 * The failing retry passes: each row of THIS run whose key has LIMIT or more rows in the window. `rows` is the whole ledger, this run's rows
 * included. A key with old rows and no retry pass now never fails (seat condition C1).
 */
export function verdict(thisRun, rows, now) {
  const seen = new Set();
  const out = [];
  for (const row of thisRun) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    const count = countInWindow(rows, row.key, now);
    if (count >= LIMIT) out.push({ row, count });
  }
  return out;
}

/** Appends one row. Never throws: { ok: false, error } on any write error (seat Q2: warn and pass). */
export function appendRow(path, row) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.code ?? err?.message ?? err) };
  }
}

const where = (row) => (row.line ? `${row.file}:${row.line}` : row.file);

/** The lines the reporter prints, and the job summary copies. The run line is always last (the pre-pr alsoLine reads it). */
export function printedLines({ thisRun, failing, warn, bad, path }) {
  const lines = failing.map(({ row, count }) => `FLAKE LEDGER FAIL ${where(row)} (${count} in 7 days)`);
  if (warn) lines.push(`FLAKE LEDGER WARN write failed (${warn}); the run result is unchanged`);
  if (bad > 0) lines.push(`FLAKE LEDGER WARN ${bad} unreadable ledger line(s) skipped`);
  lines.push(`FLAKE LEDGER: ${thisRun.length} retry pass(es) this run, ${failing.length} at the limit, ledger ${path}`);
  return lines;
}
