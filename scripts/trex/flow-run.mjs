// Run flows against a started environment: start steps, step drivers, grading, retries, folding.
// Attempt: { state: 'pass'|'fail'|'incomplete', reason?, incomplete?, checks, seconds }.
// Nothing here prints. Child output goes to files (writeStepOutput) and never into a reason code.

import path from 'node:path';
import { gradeCheck, filesWanted } from './checks.mjs';
import { run as runCli } from './drivers/cli.mjs';
import { refused } from './drivers/common.mjs';
import { run as runHook } from './drivers/hook.mjs';
import { run as runModEvent } from './drivers/mod-event.mjs';
import { writeStepOutput } from './report.mjs';

const START_SEC = 300;
const STAMP_DEST = '.claude/cache/pre-pr/stamp.json';
const DRIVER_RUNNERS = Object.freeze({ cli: runCli, hook: runHook, 'mod-event': runModEvent });

/** A start step failed. The attempt is Incomplete start_unreached, never a Fail. */
export class StartError extends Error {
  constructor(message) { super(message); this.name = 'StartError'; }
}

// ---------- folding ----------

/**
 * Folds the attempts of one flow into { state, incomplete?, reason? }.
 * A pass beside any other attempt is Flaky. All pass is Pass. Any fail, with no pass, is Fail
 * (incomplete:true when a check was not attempted). Only incomplete attempts give Incomplete with the last reason.
 */
export function foldAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) throw new TypeError('foldAttempts needs at least one attempt');
  const states = attempts.map((a) => a.state);
  if (states.includes('pass')) return states.every((s) => s === 'pass') ? { state: 'pass' } : { state: 'flaky' };
  if (states.includes('fail')) {
    return attempts.some((a) => a.incomplete || a.state === 'incomplete') ? { state: 'fail', incomplete: true } : { state: 'fail' };
  }
  return { state: 'incomplete', reason: attempts.at(-1).reason ?? 'unknown' };
}

/** The attempt state from its checks: a failed check wins; else a blocked or not attempted check makes it incomplete. */
export function stateOfChecks(checks) {
  const open = checks.filter((c) => c.state === 'blocked' || c.state === 'not_attempted');
  if (checks.some((c) => c.state === 'failed')) return { state: 'fail', ...(open.length > 0 ? { incomplete: true } : {}) };
  if (open.length === 0) return { state: 'pass' };
  const reason = (open.find((c) => c.reason === 'timeout') ?? open[0]).reason ?? 'unknown';
  return { state: 'incomplete', reason };
}

// ---------- start steps ----------

/** exec that turns a spawn error into a throw, so a missing docker never reads as a failed check. */
export function strictExec(exec) {
  return async (argv, opts) => {
    const res = await exec(argv, opts);
    if (res?.error) throw new Error(`exec failed to start: ${String(res.error).split('\n')[0]}`);
    return res;
  };
}

async function must(exec, argv, opts = {}) {
  const res = await exec(argv, { cwd: '.', timeoutSec: START_SEC, ...opts });
  if (res.code !== 0 || res.timedOut) throw new StartError(`start step "${argv.slice(0, 3).join(' ')}" failed (exit ${res.code}${res.timedOut ? ', timed out' : ''})`);
  return res;
}

/** A fresh git repo of the head tree, with one commit. Returns the in-container HEAD. */
async function gitCommit(exec, remote) {
  await must(exec, ['rm', '-rf', '--', '.git']);
  await must(exec, ['git', 'init', '-q']);
  await must(exec, ['git', 'add', '-A']);
  await must(exec, ['git', '-c', 'user.name=trex', '-c', 'user.email=trex@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'trex']);
  if (remote) await must(exec, ['git', 'remote', 'add', 'origin', remote]);
  return (await must(exec, ['git', 'rev-parse', 'HEAD'])).stdout.trim();
}

/** {{HEAD}} becomes the in-container HEAD. {{NOW}} becomes the run time (the gate refuses a stamp older than 24 hours). */
export function fillStamp(text, head, now) {
  if (head === null && text.includes('{{HEAD}}')) throw new StartError('the stamp needs {{HEAD}} but the flow has no start.git');
  return text.replaceAll('{{HEAD}}', head ?? '').replaceAll('{{NOW}}', now.toISOString());
}

async function writeStamp(exec, flow, ctx, head) {
  const text = await ctx.readFixture(flow.start.stamp);
  if (typeof text !== 'string') throw new StartError(`stamp fixture ${flow.start.stamp} cannot be read`);
  const body = fillStamp(text, head, ctx.now());
  await must(exec, ['sh', '-c', `mkdir -p ${path.posix.dirname(STAMP_DEST)} && cat > ${STAMP_DEST}`], { stdin: body });
}

/** Runs the start block of a flow in the container. Throws StartError. db is loaded by env.mjs, not here. */
export async function applyStart(flow, exec, ctx) {
  const start = flow.start ?? {};
  if (start.serve) throw new StartError('start.serve is not built in P0');
  const head = start.git === 'commit' ? await gitCommit(exec, start.remote) : null;
  if (start.stamp) await writeStamp(exec, flow, ctx, head);
  if (start.run) await must(exec, start.run, { cwd: start.cwd ?? '.' });
  return { head };
}

// ---------- steps ----------

function secondsLeft(flow, startedMs, nowMs) {
  return Math.ceil((flow.limits.timeoutMs - (nowMs - startedMs)) / 1000);
}

function driverCtx(flow, step, ctx, left) {
  const base = { flow, timeoutSec: Math.max(left, 1), wantFiles: filesWanted(step.checks), readFixture: ctx.readFixture };
  if (flow.profile === 'host') return { ...base, spawn: ctx.spawn, treeDir: ctx.treeDir, env: ctx.hostEnv, timeoutMs: Math.max(left, 1) * 1000 };
  return { ...base, exec: ctx.exec };
}

/** One step. A spent flow budget gives a timed-out result without running. */
async function runStep(flow, step, ctx, startedMs) {
  const left = secondsLeft(flow, startedMs, ctx.now().getTime());
  if (left <= 0) return { code: null, stdout: '', stderr: '', timedOut: true, files: {} };
  const runner = DRIVER_RUNNERS[flow.driver];
  const hostCli = flow.profile === 'host' && flow.driver !== 'mod-event';
  if (!runner || hostCli) return refused('driver_unsupported');
  return runner(step.action, driverCtx(flow, step, ctx, left));
}

function gradeStep(step, stepNo, result, files) {
  return step.checks.map((check, j) => {
    const g = gradeCheck(check, result);
    return { step: stepNo, check: j + 1, text: check.text, state: g.state, ...(g.reason ? { reason: g.reason } : {}), evidence: files };
  });
}

function skippedChecks(step, stepNo) {
  return step.checks.map((check, j) => {
    const g = gradeCheck(check, null);
    return { step: stepNo, check: j + 1, text: check.text, state: g.state, reason: g.reason, evidence: [] };
  });
}

async function runSteps(flow, attemptNo, ctx) {
  const startedMs = ctx.now().getTime();
  const checks = [];
  let stopped = false;
  for (const [i, step] of flow.steps.entries()) {
    if (stopped) { checks.push(...skippedChecks(step, i + 1)); continue; }
    const result = await runStep(flow, step, ctx, startedMs);
    const files = ctx.writeStep({ flowId: flow.id, attempt: attemptNo, step: i + 1, result });
    const graded = gradeStep(step, i + 1, result, files);
    checks.push(...graded);
    stopped = graded.some((c) => c.state !== 'passed');
  }
  return checks;
}

// ---------- attempts and flows ----------

/** One attempt: start block, then the steps. A thrown error never reaches stdout: it is a reason code plus an error file. */
export async function runAttempt(flow, attemptNo, ctx) {
  const t0 = ctx.now().getTime();
  const seconds = () => Math.round((ctx.now().getTime() - t0) / 1000);
  try {
    if (flow.profile !== 'host') await applyStart(flow, ctx.exec, ctx);
    const checks = await runSteps(flow, attemptNo, ctx);
    return { ...stateOfChecks(checks), checks, seconds: seconds() };
  } catch (err) {
    ctx.noteError?.({ flowId: flow.id, attempt: attemptNo, err });
    const reason = err instanceof StartError ? 'start_unreached' : 'driver_error';
    return { state: 'incomplete', reason, checks: [], seconds: seconds() };
  }
}

const retryable = (a) => a.state === 'fail' || a.reason === 'timeout';

/** The checks to show for a folded flow: the last attempt that explains the state. */
function checksFor(folded, attempts) {
  const wanted = folded.state === 'flaky' || folded.state === 'fail' ? 'fail' : null;
  const match = wanted ? attempts.filter((a) => a.state === wanted) : attempts;
  return (match.at(-1) ?? attempts.at(-1)).checks;
}

/** Runs one flow with its retries. Returns the flow entry for buildReport. */
export async function runFlow(flow, ctx) {
  const t0 = ctx.now().getTime();
  const attempts = [];
  for (let n = 1; n <= 1 + flow.limits.retries; n += 1) {
    attempts.push(await runAttempt(flow, n, ctx));
    if (!retryable(attempts.at(-1))) break;
  }
  const folded = foldAttempts(attempts);
  return {
    id: flow.id, ...folded, severity: flow.severity, attempts: attempts.length,
    seconds: Math.round((ctx.now().getTime() - t0) / 1000), tokens: 0, checks: checksFor(folded, attempts),
  };
}

/**
 * Runs flows one after another. env is the started Env ({exec}), or null for host-only flows.
 * deps: { now, readFixture, writeStep, spawn, treeDir, hostEnv, noteError }.
 */
export async function runFlows(flows, env, deps) {
  const ctx = { ...deps, exec: env ? strictExec(env.exec) : undefined, writeStep: deps.writeStep ?? ((a) => writeStepOutput(deps.evidenceDir, a)) };
  const out = [];
  for (const flow of flows) out.push(await runFlow(flow, ctx));
  return out;
}
