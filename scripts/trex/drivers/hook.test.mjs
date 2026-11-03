import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './hook.mjs';

const PAYLOAD = '{"tool_name":"Bash","tool_input":{"command":"gh pr create --body \\"it\'s\\""}}';
const flow = (extra = {}) => ({ id: 'hook-flow', profile: 'container', limits: { timeoutMs: 30000 }, ...extra });
const action = { hook: '.claude/hooks/dist/pre-pr-gate.mjs', payload: 'fixtures/p.json' };

function setup({ fixture = PAYLOAD, result = { code: 2, stdout: 'BLOCKED', stderr: '' } } = {}) {
  const calls = [];
  const reads = [];
  return {
    calls,
    reads,
    ctx: {
      flow: flow(),
      readFixture: async (rel) => { reads.push(rel); return fixture; },
      exec: async (argv, opts) => { calls.push({ argv, opts }); return result; },
    },
  };
}

test('hook runs node <hook> and sends the payload text on stdin (break: send the payload path instead of its text)', async () => {
  const { ctx, calls, reads } = setup();
  const r = await run(action, ctx);
  assert.deepEqual(reads, ['fixtures/p.json']);
  assert.deepEqual(calls[0].argv, ['node', '.claude/hooks/dist/pre-pr-gate.mjs']);
  assert.equal(calls[0].opts.stdin, PAYLOAD);
  assert.equal(calls[0].opts.timeoutSec, 30);
  assert.equal(calls[0].opts.cwd, '.');
  assert.deepEqual(r, { code: 2, stdout: 'BLOCKED', stderr: '', timedOut: false, files: {} });
});

test('hook payload with quotes reaches exec byte for byte, never through a shell string (break: build sh -c)', async () => {
  const { ctx, calls } = setup();
  await run(action, ctx);
  assert.equal(calls[0].argv.includes('sh'), false);
  assert.equal(calls[0].opts.stdin, PAYLOAD);
});

test('hook with a missing fixture gives a refused result and never calls exec (break: run with empty stdin)', async () => {
  const { ctx, calls } = setup({ fixture: null });
  const r = await run(action, ctx);
  assert.deepEqual(r, { code: null, stdout: '', stderr: '', timedOut: false, files: {}, reason: 'fixture_missing' });
  assert.equal(calls.length, 0);
});

test('hook without ctx.readFixture is refused with fixture_missing', async () => {
  const { ctx } = setup();
  delete ctx.readFixture;
  assert.equal((await run(action, ctx)).reason, 'fixture_missing');
});

test('hook refuses a hook path that starts with a dash so node cannot read it as an option (break: drop the dash check)', async () => {
  const { ctx, calls } = setup();
  const r = await run({ ...action, hook: '--eval=process.exit(0)' }, ctx);
  assert.equal(r.reason, 'action_invalid');
  assert.equal(calls.length, 0);
});

test('hook refuses an action without a payload (break: skip validateAction)', async () => {
  const { ctx } = setup();
  assert.equal((await run({ hook: 'h.mjs' }, ctx)).reason, 'action_invalid');
});

test('hook uses start.cwd as the working directory and collects wanted files', async () => {
  const calls = [];
  const ctx = {
    flow: flow({ start: { cwd: 'apps/x' } }),
    wantFiles: ['out.json'],
    readFixture: async () => PAYLOAD,
    exec: async (argv, opts) => { calls.push({ argv, opts }); return { code: 0, stdout: argv[0] === 'cat' ? '{}' : '', stderr: '' }; },
  };
  const r = await run(action, ctx);
  assert.equal(calls[0].opts.cwd, 'apps/x');
  assert.deepEqual(r.files, { 'out.json': '{}' });
});

test('hook propagates timedOut (break: hard-code false)', async () => {
  const { ctx } = setup({ result: { code: 137, stdout: '', stderr: '', timedOut: true } });
  assert.equal((await run(action, ctx)).timedOut, true);
});
