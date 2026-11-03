// Shared parts of the TREX drivers. A driver builds argv and options, then calls an injected function.
// It never runs docker or a shell itself, so tests run without Docker.
// StepResult: {code, stdout, stderr, timedOut, files, reason?, blocker?}. `reason` marks a step the driver refused to run.
// An exec answer with oom:true (the container was killed for memory, exit 137) gives reason 'oom' and a `blocker`:
// the environment broke, so the flow is Blocked, not Failed. A timedOut answer stays a not_attempted/timeout check.

import path from 'node:path';
import { DEFAULT_LIMITS, validateAction } from '../flow.mjs';

/** A step the driver did not run. gradeCheck reads `reason` and blocks every check of the step. */
export function refused(reason) {
  return { code: null, stdout: '', stderr: '', timedOut: false, files: {}, reason };
}

/** Errors for the action as `reason: 'action_invalid'`, or null when the action is fine. */
export function actionProblem(driver, action) {
  return validateAction(driver, action).length > 0 ? 'action_invalid' : null;
}

/** Make an exec or spawn answer into a StepResult. A bad field becomes null, '' or false. */
export function toStepResult(raw, files = {}) {
  const code = Number.isInteger(raw?.code) ? raw.code : null;
  const str = (v) => (typeof v === 'string' ? v : '');
  const oom = raw?.oom === true && raw?.timedOut !== true ? { oom: true } : {};
  return { code, stdout: str(raw?.stdout), stderr: str(raw?.stderr), timedOut: raw?.timedOut === true, files, ...oom };
}

export const OOM_BLOCKER = Object.freeze({ stage: 'start', text: 'out of memory (exit 137)' });

/** Working dir inside the tree: start.cwd, then the action cwd, as a normalized posix path. */
export function stepCwd(flow, actionCwd) {
  return path.posix.normalize(path.posix.join(flow?.start?.cwd ?? '.', actionCwd ?? '.'));
}

/** Seconds for `timeout -s KILL`. ctx.timeoutSec wins; else the flow limit, rounded up. */
export function timeoutSecOf(ctx) {
  if (Number.isFinite(ctx.timeoutSec)) return ctx.timeoutSec;
  return Math.ceil((ctx.flow?.limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs) / 1000);
}

/** Read the wanted files with `cat`, one exec each. An absent file gives null. An exec error reaches the caller. */
async function collectFiles(ctx, wanted, { cwd, timeoutSec }) {
  const files = {};
  for (const name of wanted) {
    const r = await ctx.exec(['cat', '--', name], { cwd, timeoutSec });
    files[name] = r?.code === 0 && r.timedOut !== true && typeof r.stdout === 'string' ? r.stdout : null;
  }
  return files;
}

/** Turn the raw exec answer into a StepResult. After a timeout it reads no files, because every check reads timeout. */
export async function finishStep(ctx, raw, opts) {
  const result = toStepResult(raw);
  if (result.oom) return { ...result, reason: 'oom', blocker: { ...OOM_BLOCKER } };
  if (result.timedOut || !ctx.wantFiles?.length) return result;
  return { ...result, files: await collectFiles(ctx, ctx.wantFiles, opts) };
}
