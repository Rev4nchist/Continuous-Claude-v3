// cli driver: run an argv in the app container. ctx.exec does the docker exec and the in-container `timeout -s KILL`.
// ctx: {exec(argv, {cwd, env, stdin, timeoutSec}) -> {code, stdout, stderr, timedOut}, flow, timeoutSec?, wantFiles?}.
// cwd is tree-relative. exec resolves it against /app.

import { actionProblem, finishStep, refused, stepCwd, timeoutSecOf } from './common.mjs';

/** @returns {Promise<{code, stdout, stderr, timedOut, files, reason?}>} */
export async function run(action, ctx) {
  const problem = actionProblem('cli', action);
  if (problem) return refused(problem);
  const opts = { cwd: stepCwd(ctx.flow, action.cwd), env: action.env, stdin: action.stdin, timeoutSec: timeoutSecOf(ctx) };
  const raw = await ctx.exec(action.cmd, opts);
  return finishStep(ctx, raw, opts);
}
