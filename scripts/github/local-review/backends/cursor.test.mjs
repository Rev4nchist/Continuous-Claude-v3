// Tests for scripts/github/local-review/backends/cursor.mjs (the Cursor backend of the review engine). Every test names the source change that would break it.
// Run: node --test scripts/github/local-review/backends/cursor.test.mjs
// runAgent and the clock are injected: no test starts cursor-agent or touches the network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReviewOutput } from '../../cursor-review.mjs';
import { run } from './cursor.mjs';

const FENCE = '`'.repeat(3);
const MODEL = 'grok-4.7-high';
const AGENT = { cmd: 'fake-node', prefixArgs: ['fake-index.js'] };
const ARGV = ['Read .review/PROMPT.md and follow it.'];
const ENV = { PATH: 'x', KEEP_ME: '1' };

/** A stream-json stdout whose init event names `model` and whose answer has one finding on a file no tree holds. */
function stdoutFor(model) {
  const answer = `Reviewed.\n${FENCE}json\n${JSON.stringify({ findings: [{ file: 'nowhere/x.mjs', startLine: 1, severity: 'major', title: 'T', body: 'B' }], reviewed: ['src/app.mjs'], prior: {} })}\n${FENCE}`;
  return [
    JSON.stringify({ type: 'system', subtype: 'init', cwd: '/tree', model }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: answer, usage: { inputTokens: 1 }, duration_ms: 5 }),
    '',
  ].join('\n');
}

const input = (over = {}) => ({ promptPath: '/tree/.review/PROMPT.md', reviewDir: '/tree', model: MODEL, effort: null, timeoutMs: 1234, ...over });

/** opts with a recording runAgent. result: the run it returns, or a function (spec) => run. */
function harness(result = { status: 0, stdout: stdoutFor('Grok 4.7 256K High'), stderr: '', timedOut: false, durationMs: 5 }, over = {}) {
  const calls = [];
  let t = 1000;
  const opts = {
    agent: AGENT, env: ENV, promptArgv: ARGV, now: () => (t += 7),
    runAgent: async (...a) => { calls.push(a); return typeof result === 'function' ? result(...a) : result; },
    ...over,
  };
  return { calls, opts };
}

test('the argument list is the one the engine built before the seam: prefix args, ask mode, stream-json, the model, then the prompt argv (breaks if a flag or the order changes)', async () => {
  const { calls, opts } = harness();
  await run(input(), opts);
  assert.deepEqual(calls[0][0].args, ['fake-index.js', '-p', '--mode', 'ask', '--trust', '--output-format', 'stream-json', '--model', MODEL, ...ARGV]);
  const bare = harness(undefined, { agent: { cmd: 'cursor-agent' } });
  await run(input(), bare.opts);
  assert.deepEqual(bare.calls[0][0].args.slice(0, 2), ['-p', '--mode'], 'an agent with no prefixArgs starts at -p');
});

test('runAgent gets exactly one argument, the spec, with command, args, cwd = reviewDir, timeoutMs and env (breaks if a second argument such as gate options is passed, or a spec field changes)', async () => {
  const { calls, opts } = harness();
  await run(input(), opts);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1, 'a second argument would change the grok gate env of runAgent');
  const spec = calls[0][0];
  assert.deepEqual(Object.keys(spec).sort(), ['args', 'command', 'cwd', 'env', 'timeoutMs']);
  assert.equal(spec.command, 'fake-node');
  assert.equal(spec.cwd, '/tree');
  assert.equal(spec.timeoutMs, 1234);
  assert.equal(spec.env, ENV, 'the env the engine built goes through as is');
});

test('a runAgent that throws becomes a failed run with the message and durationMs = now() - t0, and is still parsed (breaks if the catch is dropped or its fields change)', async () => {
  const { opts } = harness(() => { throw new Error('spawn exploded'); });
  const out = await run(input(), opts);
  assert.deepEqual(out.run, { status: null, stdout: '', stderr: '', timedOut: false, error: 'spawn exploded', durationMs: 7 });
  assert.deepEqual(out.parsed, parseReviewOutput('', { expectModel: MODEL }));
  assert.equal(out.exitCode, null);
});

test('the stdout is parsed against the requested model, with no file check (breaks if expectModel or the arguments of parseReviewOutput change)', async () => {
  const good = await run(input(), harness().opts);
  assert.equal(good.parsed.modelVerified, true);
  assert.equal(good.parsed.modelMismatch, false);
  assert.equal(good.parsed.findings.length, 1, 'no exists check: a finding on a file outside the tree is kept, as before the seam');
  assert.deepEqual(good.parsed, parseReviewOutput(good.run.stdout, { expectModel: MODEL }));
  const other = await run(input(), harness({ status: 0, stdout: stdoutFor('Grok 4.7 256K Extra High'), stderr: '', timedOut: false, durationMs: 5 }).opts);
  assert.equal(other.parsed.modelMismatch, true);
});

test('the result has exactly text, traceEvents (null), exitCode (run.status), costTag (cursor), run (the runAgent object) and parsed (breaks if a key is added, dropped or renamed)', async () => {
  const runResult = { status: 3, stdout: stdoutFor('Grok 4.7 256K High'), stderr: 'x', timedOut: false, durationMs: 5 };
  const out = await run(input(), harness(runResult).opts);
  assert.deepEqual(Object.keys(out).sort(), ['costTag', 'exitCode', 'parsed', 'run', 'text', 'traceEvents']);
  assert.equal(out.traceEvents, null);
  assert.equal(out.exitCode, 3);
  assert.equal(out.costTag, 'cursor');
  assert.equal(out.run, runResult, 'the engine reads the run object itself');
  assert.equal(out.text, out.parsed.text);
  assert.match(out.text, /^Reviewed\./);
});

/** An agent whose first read throws: a run that gets past the guards fails with this message, and never reaches a spawn. */
const TRIPWIRE_AGENT = { cmd: 'fake-node', get prefixArgs() { throw new Error('reached the agent'); } };

test('a missing opts.env rejects before the call: runAgent would hand the full parent env (GH_TOKEN, ANTHROPIC_API_KEY) to the agent (breaks if the env guard is removed)', async () => {
  for (const env of [undefined, null, 'PATH=x']) {
    const { calls, opts } = harness(undefined, { agent: TRIPWIRE_AGENT, env });
    await assert.rejects(run(input(), opts), { name: 'TypeError', message: /opts\.env is required/ });
    assert.equal(calls.length, 0);
  }
});

test('a missing opts.runAgent rejects before the call: there is no default that starts a real cursor-agent (breaks if a runAgent default comes back)', async () => {
  const { opts } = harness(undefined, { agent: TRIPWIRE_AGENT });
  delete opts.runAgent;
  await assert.rejects(run(input(), opts), { name: 'TypeError', message: /opts\.runAgent is required/ });
  await assert.rejects(run(input(), { ...opts, runAgent: 'not a function' }), { name: 'TypeError', message: /opts\.runAgent is required/ });
});

test('effort and promptPath are accepted and change nothing: the model id carries the effort and the prompt argv names the file (breaks if either starts to change the call)', async () => {
  const a = harness();
  const b = harness();
  const one = await run(input(), a.opts);
  const two = await run(input({ effort: 'high', promptPath: '/elsewhere/P.md' }), b.opts);
  assert.deepEqual(a.calls, b.calls);
  assert.deepEqual(one, two);
});
