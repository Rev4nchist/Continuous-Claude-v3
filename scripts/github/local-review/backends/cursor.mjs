// The Cursor backend of the review engine: one cursor-agent run and its parse. local-review.mjs keeps the env, the agent lookup, the slot,
// the cap reservation, the retry rule and runError; this file only makes the call (moved from runOnce, output unchanged).
// Contract: run(input, opts) -> { text, traceEvents, exitCode, costTag, run, parsed }.
//   input: { promptPath, reviewDir, model, effort, timeoutMs }. effort and promptPath are not read: the model id carries the effort,
//   and the prompt argv names the prompt file.
//   opts: { agent, env, promptArgv, runAgent, now }, computed by the engine. env (buildEngineEnv) and runAgent are required: with no env
//   runAgent hands the full parent env to the agent, and there is no default runAgent that could start a real cursor-agent.
//   run and parsed are the runAgent result and the parseReviewOutput result, unchanged: the engine reads its fields from them.
//   parsed.modelVerified and parsed.modelMismatch are computed against input.model.
//   run never rejects on an agent failure: a throw of runAgent is a run with error set. It rejects only on a missing env or runAgent.
import { parseReviewOutput } from '../../cursor-review.mjs';

export async function run({ reviewDir, model, timeoutMs }, { agent, env, promptArgv, runAgent, now = Date.now }) {
  if (!env || typeof env !== 'object') throw new TypeError('backends/cursor run: opts.env is required (buildEngineEnv)');
  if (typeof runAgent !== 'function') throw new TypeError('backends/cursor run: opts.runAgent is required');
  const args = [...(agent.prefixArgs ?? []), '-p', '--mode', 'ask', '--trust', '--output-format', 'stream-json', '--model', model, ...promptArgv];
  const spec = { command: agent.cmd, args, cwd: reviewDir, timeoutMs, env };
  const t0 = now();
  let result;
  // One argument only: a second one would set the grok gate env of runAgent.
  try { result = await runAgent(spec); } catch (err) { result = { status: null, stdout: '', stderr: '', timedOut: false, error: String(err.message), durationMs: now() - t0 }; }
  const parsed = parseReviewOutput(result.stdout, { expectModel: model });
  return { text: parsed.text, traceEvents: null, exitCode: result.status, costTag: 'cursor', run: result, parsed };
}
