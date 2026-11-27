/**
 * wait-ci -- a builder's wait that ends at READY (card coord-ci-green-wake).
 *
 * Usage: node scripts/github/wait-ci.mjs <pr> [--timeout N] [--repo owner/name]
 *   N is a whole number of seconds from 1 to 7200 (default 3600).
 *
 * A builder starts it with run_in_background after pr_watch and pr_checkpoint. When it ends, the harness starts a turn in the builder,
 * and the builder sends READY (or the failure) to the seat by SendMessage (rule V7.12). The seat still reads GitHub before any land word (V7.4).
 *
 * READY has one definition: review-status.mjs, the reader land-pr.ps1 trusts. This script runs `review-status.mjs <pr> --json` every
 * 60 s and never decides READY on its own. It reads no other thing from GitHub.
 *   exit 0   READY. One line on stdout: `wait-ci: PR <n> READY at <head7>`.
 *   exit 1   a check ended failed (failure, cancelled, timed_out, action_required, startup_failure, stale). One line on stdout names it.
 *            A pending or queued check, an open thread, a proof problem and a new head are not failures: the wait goes on.
 *   exit 75  no READY in the time limit. One line on stderr.
 *   exit 2   a usage error (before any read), or the read broke 3 times in a row (the error text is on stderr).
 * It prints no body, takes no lock and writes nothing.
 *
 * Tests: scripts/github/wait-ci.test.mjs. The test env (WAIT_CI_POLL_MS, WAIT_CI_REVIEW_STATUS) works only when WAIT_CI_ALLOW_ENV is "1".
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WAIT_DEFAULT_S = 3600;
export const WAIT_MAX_S = 7200;
export const POLL_MS = 60000;
export const MAX_ERRORS = 3;
const USAGE = 'usage: wait-ci.mjs <pr> [--timeout N] [--repo owner/name] (N is a whole number of seconds from 1 to 7200, default 3600; nothing was run)';

/** A check that ended in one of these states is a failure. A check that is queued or in progress is not. */
const FAILED_CHECK = /^check "(.+)" is completed\/(failure|cancelled|timed_out|action_required|startup_failure|stale)$/;

const testEnvOn = (env) => env.WAIT_CI_ALLOW_ENV === '1';

/** The poll step in ms: 60 s, or WAIT_CI_POLL_MS (a whole number) when WAIT_CI_ALLOW_ENV is exactly "1". */
export function stepMs(env = process.env) {
  const raw = env.WAIT_CI_POLL_MS;
  if (testEnvOn(env) && typeof raw === 'string' && /^[1-9]\d{0,6}$/.test(raw)) return Number(raw);
  return POLL_MS;
}

/** The review-status script to run: the real one, or WAIT_CI_REVIEW_STATUS when WAIT_CI_ALLOW_ENV is exactly "1". */
export function reviewStatusPath(env = process.env) {
  if (testEnvOn(env) && typeof env.WAIT_CI_REVIEW_STATUS === 'string' && env.WAIT_CI_REVIEW_STATUS !== '') return env.WAIT_CI_REVIEW_STATUS;
  return path.join(HERE, 'review-status.mjs');
}

/** Parse argv. Returns { pr, timeoutS, repo }. Throws the usage error for anything else, before any read. */
export function parseArgs(argv) {
  let pr = null;
  let timeoutS = WAIT_DEFAULT_S;
  let repo = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--timeout') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || !/^[1-9]\d{0,3}$/.test(v) || Number(v) > WAIT_MAX_S) throw new Error(USAGE);
      timeoutS = Number(v);
      i += 1;
    } else if (a === '--repo') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(v)) throw new Error(USAGE);
      repo = v;
      i += 1;
    } else if (/^[1-9]\d{0,8}$/.test(a) && pr === null) {
      pr = Number(a);
    } else {
      throw new Error(USAGE);
    }
  }
  if (pr === null) throw new Error(USAGE);
  return { pr, timeoutS, repo };
}

/**
 * Maps one answer of review-status to a kind: ready, failed, wait or error. Pure.
 * Exit 0 counts as READY only with `ready: true` in the JSON. A silent exit 0, an unknown exit code or a bad JSON is an error, never "wait".
 */
export function classify({ code, json, stderr = '' }) {
  const text = String(stderr || '').trim().split('\n')[0] || `review-status exit ${code}`;
  if (code === 0) return json && json.ready === true ? { kind: 'ready', head: json.headShort } : { kind: 'error', text: `review-status exit 0 without ready: true (${text})` };
  if (code === 1 && json && typeof json === 'object' && json.ready !== true) {
    for (const reason of Array.isArray(json.reasons) ? json.reasons : []) {
      const m = FAILED_CHECK.exec(String(reason));
      if (m) return { kind: 'failed', head: json.headShort, check: m[1] };
    }
    return { kind: 'wait', head: json.headShort };
  }
  return { kind: 'error', text };
}

/** Runs review-status once. Returns the input of classify. */
export function readStatus({ pr, repo, env = process.env, spawn = spawnSync }) {
  const argv = [reviewStatusPath(env), String(pr), '--json', ...(repo ? ['--repo', repo] : [])];
  const r = spawn(process.execPath, argv, { encoding: 'utf8', env, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) return { code: -1, json: null, stderr: String(r.error.message) };
  let json = null;
  try { json = JSON.parse(String(r.stdout || '').trim()); } catch { json = null; }
  return { code: r.status ?? -1, json, stderr: r.stderr };
}

/**
 * Polls until READY, a failed check, the limit, or MAX_ERRORS broken reads in a row. The first poll runs at once, then one every `step` ms,
 * and one more at the limit. Returns { exit, out, err }: the exit code, the stdout line and the stderr lines. `say` prints progress lines.
 */
export async function waitForReady({ pr, timeoutS, poll, sleep, now, step, say = () => {} }) {
  const start = now();
  let errors = 0;
  let lastHead = null;
  for (;;) {
    const k = classify(poll());
    if (k.kind === 'error') {
      errors += 1;
      say(`wait-ci: read failed (${errors} of ${MAX_ERRORS}): ${k.text}`);
      if (errors >= MAX_ERRORS) return { exit: 2, out: '', err: `wait-ci: stopped after ${MAX_ERRORS} broken reads in a row: ${k.text}` };
    } else {
      errors = 0;
      if (k.head && lastHead && k.head !== lastHead) say(`wait-ci: new head ${k.head}; an earlier READY is void`);
      if (k.head) lastHead = k.head;
      if (k.kind === 'ready') return { exit: 0, out: `wait-ci: PR ${pr} READY at ${k.head}`, err: '' };
      if (k.kind === 'failed') return { exit: 1, out: `wait-ci: PR ${pr} FAILED check "${k.check}" at ${k.head}`, err: '' };
    }
    const left = timeoutS * 1000 - (now() - start);
    if (left <= 0) return { exit: 75, out: '', err: `wait-ci: no READY in ${timeoutS} s (PR ${pr})` };
    await sleep(Math.min(step, left));
  }
}

async function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 2; return; }
  const r = await waitForReady({
    pr: a.pr,
    timeoutS: a.timeoutS,
    poll: () => readStatus({ pr: a.pr, repo: a.repo }),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
    step: stepMs(),
    say: (line) => console.error(line),
  });
  if (r.out) console.log(r.out);
  if (r.err) console.error(r.err);
  process.exitCode = r.exit;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) {
  main().catch((err) => {
    console.error(`wait-ci: ${String(err?.message).split('\n')[0]}`);
    process.exitCode = 2;
  });
}
