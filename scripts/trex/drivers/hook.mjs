// hook driver: run `node <hook>` in the app container with the payload on stdin.
// ctx: {exec, flow, readFixture(relPath) -> string|null, timeoutSec?, wantFiles?}.
// readFixture reads the payload from the grading SHA (configSha). The payload text goes to exec as stdin, never through a shell.

import { actionProblem, finishStep, refused, stepCwd, timeoutSecOf } from './common.mjs';

/** A payload text, or null when the fixture cannot be read. */
async function loadPayload(action, ctx) {
  if (typeof ctx.readFixture !== 'function') return null;
  const payload = await ctx.readFixture(action.payload);
  return typeof payload === 'string' ? payload : null;
}

/** @returns {Promise<{code, stdout, stderr, timedOut, files, reason?}>} */
export async function run(action, ctx) {
  const problem = actionProblem('hook', action);
  if (problem || action.hook.startsWith('-')) return refused('action_invalid');
  const payload = await loadPayload(action, ctx);
  if (payload === null) return refused('fixture_missing');
  const opts = { cwd: stepCwd(ctx.flow), stdin: payload, timeoutSec: timeoutSecOf(ctx) };
  const raw = await ctx.exec(['node', action.hook], opts);
  return finishStep(ctx, raw, opts);
}
