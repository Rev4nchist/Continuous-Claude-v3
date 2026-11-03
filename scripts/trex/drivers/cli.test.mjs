import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './cli.mjs';

// A fake exec records each call and answers from a table keyed by argv[0] (or the whole argv).
function fakeExec(answers = {}) {
  const calls = [];
  const exec = async (argv, opts) => {
    calls.push({ argv, opts });
    const a = answers[argv.join(' ')] ?? answers[argv[0]] ?? { code: 0, stdout: '', stderr: '' };
    if (a instanceof Error) throw a;
    return a;
  };
  return { exec, calls };
}

const flow = (extra = {}) => ({ id: 'a-flow', profile: 'container', limits: { timeoutMs: 45500 }, ...extra });

test('cli hands the argv to exec unchanged, with no shell join (break: join the argv into one string)', async () => {
  const { exec, calls } = fakeExec({ node: { code: 3, stdout: 'out', stderr: 'err' } });
  const cmd = ['node', '-e', 'console.log("a b; rm -rf /")'];
  const r = await run({ cmd }, { exec, flow: flow() });
  assert.deepEqual(calls[0].argv, cmd);
  assert.deepEqual(r, { code: 3, stdout: 'out', stderr: 'err', timedOut: false, files: {} });
});

test('cli passes cwd, env, stdin and a whole-second timeout from the flow limit (break: pass milliseconds)', async () => {
  const { exec, calls } = fakeExec();
  await run({ cmd: ['x'], cwd: 'sub', env: { A: '1' }, stdin: 'in' }, { exec, flow: flow({ start: { cwd: 'apps' } }) });
  assert.deepEqual(calls[0].opts, { cwd: 'apps/sub', env: { A: '1' }, stdin: 'in', timeoutSec: 46 });
});

test('cli uses cwd "." with no start.cwd and no action cwd; ctx.timeoutSec wins over the flow limit', async () => {
  const { exec, calls } = fakeExec();
  await run({ cmd: ['x'] }, { exec, flow: flow(), timeoutSec: 7 });
  assert.equal(calls[0].opts.cwd, '.');
  assert.equal(calls[0].opts.timeoutSec, 7);
});

test('cli refuses a cwd that leaves the tree and never calls exec (break: skip validateAction)', async () => {
  const { exec, calls } = fakeExec();
  const r = await run({ cmd: ['x'], cwd: 'a/../../..' }, { exec, flow: flow() });
  assert.equal(r.reason, 'action_invalid');
  assert.equal(calls.length, 0);
});

test('cli refuses an invalid action with reason action_invalid (break: skip validateAction)', async () => {
  const { exec, calls } = fakeExec();
  const r = await run({ cmd: [] }, { exec, flow: flow() });
  assert.equal(r.reason, 'action_invalid');
  assert.equal(r.code, null);
  assert.equal(calls.length, 0);
});

test('cli propagates timedOut and skips file collection after a timeout (break: hard-code timedOut false)', async () => {
  const { exec, calls } = fakeExec({ x: { code: 137, stdout: '', stderr: '', timedOut: true } });
  const r = await run({ cmd: ['x'] }, { exec, flow: flow(), wantFiles: ['o.txt'] });
  assert.equal(r.timedOut, true);
  assert.deepEqual(r.files, {});
  assert.equal(calls.length, 1);
});

test('cli reads each wanted file with cat in the same cwd; a failed cat gives null (break: store stdout on failure)', async () => {
  const { exec, calls } = fakeExec({
    'cat -- ok.txt': { code: 0, stdout: 'body', stderr: '' },
    'cat -- gone.txt': { code: 1, stdout: 'cat: no such file', stderr: '' },
  });
  const r = await run({ cmd: ['x'], cwd: 'sub' }, { exec, flow: flow(), wantFiles: ['ok.txt', 'gone.txt'] });
  assert.deepEqual(r.files, { 'ok.txt': 'body', 'gone.txt': null });
  assert.equal(calls[1].opts.cwd, 'sub');
  assert.equal(calls[1].opts.stdin, undefined);
  assert.equal(calls[1].opts.env, undefined);
});

test('cli turns an odd exec result into the StepResult shape (break: pass the raw result on)', async () => {
  const { exec } = fakeExec({ x: { code: 'bad', stdout: null } });
  const r = await run({ cmd: ['x'] }, { exec, flow: flow() });
  assert.deepEqual(r, { code: null, stdout: '', stderr: '', timedOut: false, files: {} });
});

test('cli lets an exec error reach the caller (break: swallow the error as a failed step)', async () => {
  const { exec } = fakeExec({ x: new Error('docker is down') });
  await assert.rejects(run({ cmd: ['x'] }, { exec, flow: flow() }), /docker is down/);
});
