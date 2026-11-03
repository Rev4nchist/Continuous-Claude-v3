// mod-event driver: run `claude plugin test <name>` on the HOST, in an archive tree. Host profile only.
// ctx: {spawn(argv, {cwd, env, timeoutMs}) -> {code, stdout, stderr, timedOut}, flow, treeDir, env?, timeoutMs?}.
// The env has the Anthropic credentials and the CLAUDE_CODE_* variables removed. PATH stays.
// The spawner owns command lookup and killTree on timeout. This file never starts a process itself.

import { DEFAULT_LIMITS } from '../flow.mjs';
import { stripEnv } from '../lib/strip-env.mjs';
import { actionProblem, refused, toStepResult } from './common.mjs';

const timeoutMsOf = (ctx) => (Number.isFinite(ctx.timeoutMs) ? ctx.timeoutMs : (ctx.flow?.limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs));

/** The reason this step must not run, or null. */
function refusalFor(action, ctx) {
  if (ctx.flow?.profile !== 'host') return 'host_only';
  if (!ctx.treeDir) return 'tree_missing';
  if (actionProblem('mod-event', action) || action.test.startsWith('-')) return 'action_invalid';
  return null;
}

/** @returns {Promise<{code, stdout, stderr, timedOut, files, reason?}>} */
export async function run(action, ctx) {
  const reason = refusalFor(action, ctx);
  if (reason) return refused(reason);
  const opts = { cwd: ctx.treeDir, env: stripEnv(ctx.env ?? process.env), timeoutMs: timeoutMsOf(ctx) };
  return toStepResult(await ctx.spawn(['claude', 'plugin', 'test', action.test], opts));
}
