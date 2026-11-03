// cli driver: run an argv in the app container. ctx.exec does the docker exec and the in-container `timeout -s KILL`.
// ctx: {exec(argv, {cwd, env, stdin, timeoutSec}) -> {code, stdout, stderr, timedOut}, flow, timeoutSec?, wantFiles?}.
// cwd is tree-relative. exec resolves it against /app.
// A host flow runs the argv on the real machine through ctx.spawn(argv, {cwd, env, timeoutMs}) instead, and only when
// hostActionOk allows it (13.2). The spawner owns command lookup, windowsHide and killTree on timeout.

import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_LIMITS } from '../flow.mjs';
import { hostActionOk } from '../host-allow.mjs';
import { stripEnv } from '../lib/strip-env.mjs';
import { actionProblem, finishStep, refused, stepCwd, timeoutSecOf, toStepResult } from './common.mjs';

/** True when rel is a regular file inside treeDir (a link, a folder or a path out of the tree gives false). */
function treeHasFile(treeDir, rel) {
  try {
    const file = path.join(treeDir, rel);
    if (!lstatSync(file).isFile()) return false;
    const inside = path.relative(realpathSync(treeDir), realpathSync(file));
    return inside !== '' && !inside.startsWith('..') && !path.isAbsolute(inside);
  } catch { return false; }
}

const timeoutMsOf = (ctx) => (Number.isFinite(ctx.timeoutMs) ? ctx.timeoutMs : (ctx.flow?.limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs));

/** The refusal for a host step, or null. The prose reason goes to stderr, which becomes the step evidence file. */
function hostRefusal(action, ctx) {
  if (!ctx.treeDir) return refused('tree_missing');
  const why = hostActionOk('cli', action, { treeHas: (rel) => treeHasFile(ctx.treeDir, rel) });
  if (why !== null) return { ...refused('host_argv_refused'), stderr: why };
  if (ctx.wantFiles?.length > 0) return refused('files_unsupported_on_host');
  return null;
}

async function runOnHost(action, ctx) {
  const refusal = hostRefusal(action, ctx);
  if (refusal) return refusal;
  const opts = { cwd: ctx.treeDir, env: stripEnv(ctx.env ?? process.env), timeoutMs: timeoutMsOf(ctx) };
  return toStepResult(await ctx.spawn(action.cmd, opts));
}

/** @returns {Promise<{code, stdout, stderr, timedOut, files, reason?}>} */
export async function run(action, ctx) {
  if (ctx.flow?.profile === 'host') return runOnHost(action, ctx);
  const problem = actionProblem('cli', action);
  if (problem) return refused(problem);
  const opts = { cwd: stepCwd(ctx.flow, action.cwd), env: action.env, stdin: action.stdin, timeoutSec: timeoutSecOf(ctx) };
  const raw = await ctx.exec(action.cmd, opts);
  return finishStep(ctx, raw, opts);
}
