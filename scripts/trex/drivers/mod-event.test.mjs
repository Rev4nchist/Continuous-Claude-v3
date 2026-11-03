import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './mod-event.mjs';

const flow = (profile = 'host') => ({ id: 'mod-flow', profile, limits: { timeoutMs: 90000 } });

function setup({ profile = 'host', env, result = { code: 0, stdout: 'ok', stderr: '' }, treeDir = 'C:/tree/abc12345' } = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      flow: flow(profile),
      treeDir,
      env,
      spawn: async (argv, opts) => { calls.push({ argv, opts }); return result; },
    },
  };
}

test('mod-event runs claude plugin test <name> in the tree dir with a timeout in milliseconds', async () => {
  const { ctx, calls } = setup();
  const r = await run({ test: 'my-mod' }, ctx);
  assert.deepEqual(calls[0].argv, ['claude', 'plugin', 'test', 'my-mod']);
  assert.equal(calls[0].opts.cwd, 'C:/tree/abc12345');
  assert.equal(calls[0].opts.timeoutMs, 90000);
  assert.deepEqual(r, { code: 0, stdout: 'ok', stderr: '', timedOut: false, files: {} });
});

test('mod-event strips the Anthropic key, the auth token and CLAUDE_CODE_* but keeps PATH (break: pass ctx.env through)', async () => {
  const env = { PATH: '/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_ENTRYPOINT: 'cli', claude_code_x: '1', HOME: '/h' };
  const { ctx, calls } = setup({ env });
  await run({ test: 'm' }, ctx);
  assert.deepEqual(calls[0].opts.env, { PATH: '/bin', HOME: '/h' });
});

test('mod-event strips process.env when ctx.env is absent (break: default to an empty env or the raw process.env)', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'leak-check';
  try {
    const { ctx, calls } = setup();
    await run({ test: 'm' }, ctx);
    assert.equal('ANTHROPIC_API_KEY' in calls[0].opts.env, false);
    assert.ok(Object.keys(calls[0].opts.env).length > 0);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('mod-event in a container flow is refused and never spawns (break: remove the profile check)', async () => {
  const { ctx, calls } = setup({ profile: 'container' });
  const r = await run({ test: 'm' }, ctx);
  assert.deepEqual(r, { code: null, stdout: '', stderr: '', timedOut: false, files: {}, reason: 'host_only' });
  assert.equal(calls.length, 0);
});

test('mod-event without a tree dir is refused so it cannot run in the live checkout (break: let cwd default)', async () => {
  const { ctx, calls } = setup({ treeDir: null });
  assert.equal((await run({ test: 'm' }, ctx)).reason, 'tree_missing');
  assert.equal(calls.length, 0);
});

test('mod-event refuses a test name that starts with a dash (break: drop the dash check)', async () => {
  const { ctx, calls } = setup();
  assert.equal((await run({ test: '--help' }, ctx)).reason, 'action_invalid');
  assert.equal(calls.length, 0);
});

test('mod-event refuses an invalid action (break: skip validateAction)', async () => {
  const { ctx } = setup();
  assert.equal((await run({}, ctx)).reason, 'action_invalid');
});

test('mod-event propagates timedOut and lets a spawner error reach the caller', async () => {
  const { ctx } = setup({ result: { code: null, stdout: '', stderr: '', timedOut: true } });
  assert.equal((await run({ test: 'm' }, ctx)).timedOut, true);
  ctx.spawn = async () => { throw new Error('spawn ENOENT'); };
  await assert.rejects(run({ test: 'm' }, ctx), /spawn ENOENT/);
});
