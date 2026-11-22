#!/usr/bin/env node
/**
 * wait-ready.mjs: one READY wait for a builder (rule V7.12; card prepr-speed-bundle, L3).
 *
 * Usage: node scripts/coordination/wait-ready.mjs <pr-number> [--repo owner/name] [--interval seconds] [--max minutes]
 * Run it with run_in_background; it ends when the wait ends, then the builder sends READY to the seat by SendMessage.
 *
 * Every 30 s it runs `review-status.mjs <pr> --json`. Exits:
 *   0  prints `READY <pr> <head>`: review-status exited 0 AND its JSON says ready: true. Nothing else prints READY.
 *   1  prints `FAILED <pr> <reason>`: a check of the PR ended failed, cancelled or timed out. Waiting longer cannot make it ready.
 *   2  prints `ERROR <pr> <why>`: review-status could not tell (exit 2, no start, JSON that does not parse), or a usage error.
 *   3  prints `TIMEOUT <pr> ...`: not ready after --max minutes (default 60).
 * A check that runs or waits, a missing review and an unstable merge state are not failures: the wait goes on.
 * The READY line is the builder's report. The seat still reads GitHub itself and checks the head before any land word.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEW_STATUS = path.resolve(HERE, '..', 'github', 'review-status.mjs');
const USAGE = 'usage: wait-ready.mjs <pr-number> [--repo owner/name] [--interval seconds] [--max minutes]';
/** A reason of review-status that names a check that ended badly. A check that only runs or queues does not match. */
const FAILED_CHECK = /^check ".*" is completed\/(failure|cancelled|timed_out|action_required|startup_failure|stale)$/;

/** The argument list of the review-status call: the script, the PR, --json, and --repo when given. */
export function reviewStatusArgs(pr, repo) {
  return [REVIEW_STATUS, String(pr), '--json', ...(repo ? ['--repo', repo] : [])];
}

const defaultRun = (pr, repo) => () => {
  const r = spawnSync(process.execPath, reviewStatusArgs(pr, repo), { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? ` ${r.error.message}` : ''}` };
};
const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const firstLine = (text) => String(text ?? '').trim().split('\n')[0].slice(0, 160);

/**
 * Polls until the PR is ready, a check failed, review-status cannot tell, or the time is up. Returns the exit code.
 * `run` returns { status, stdout, stderr }; `sleep`, `now` and `out` are fakes in the tests.
 */
export async function waitReady({ pr, repo, run = defaultRun(pr, repo), sleep = sleepReal, now = Date.now, out = (l) => console.log(l), intervalMs = 30_000, maxMs = 60 * 60_000 }) {
  const start = now();
  for (;;) {
    const r = run();
    if (r.status !== 0 && r.status !== 1) { out(`ERROR ${pr} review-status exit ${r.status}: ${firstLine(r.stderr) || firstLine(r.stdout) || 'no output'}`); return 2; }
    let state;
    try { state = JSON.parse(r.stdout); } catch { out(`ERROR ${pr} review-status gave no JSON (exit ${r.status}): ${firstLine(r.stdout) || firstLine(r.stderr) || 'no output'}`); return 2; }
    if (!state || typeof state !== 'object') { out(`ERROR ${pr} review-status JSON is not an object`); return 2; }
    if (r.status === 0 && state.ready === true) { out(`READY ${pr} ${state.headShort ?? String(state.head ?? '').slice(0, 8)}`); return 0; }
    const failed = Array.isArray(state.reasons) ? state.reasons.find((x) => FAILED_CHECK.test(String(x))) : undefined;
    if (failed) { out(`FAILED ${pr} ${failed}`); return 1; }
    const left = maxMs - (now() - start);
    if (left <= 0) { out(`TIMEOUT ${pr} not ready after ${Math.round(maxMs / 60_000)} min`); return 3; }
    await sleep(Math.min(intervalMs, left)); // the last sleep ends at --max: the wait never runs one interval past it
  }
}

/** Reads the command line. Returns { pr, repo, intervalMs, maxMs } or null for a usage error. */
export function parseArgs(argv) {
  const pr = argv[0];
  if (!pr || !/^\d+$/.test(pr) || Number(pr) <= 0) return null;
  const opts = { pr: Number(pr), repo: undefined, intervalMs: 30_000, maxMs: 60 * 60_000 };
  for (let i = 1; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--repo' && value) opts.repo = value;
    else if (flag === '--interval' && Number(value) > 0) opts.intervalMs = Number(value) * 1000;
    else if (flag === '--max' && Number(value) > 0) opts.maxMs = Number(value) * 60_000;
    else return null;
  }
  return opts;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isDirectRun()) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) { console.error(USAGE); process.exit(2); }
  process.exit(await waitReady(opts));
}
