// Tests for flow-run.mjs: the host cli path (H3) and the 137/OOM result (blocker). They import the real runFlow.
// The host tree is a real temp folder. spawn and exec are fakes that record their calls: no process starts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyExec } from './env.mjs';
import { runFlow } from './flow-run.mjs';

const PS1 = ['pwsh', '-NoProfile', '-File', 'scripts/ok.ps1'];
const ok = { code: 0, stdout: 'fine', stderr: '', timedOut: false };

function makeTree() {
  const dir = mkdtempSync(path.join(tmpdir(), 'trex-host-'));
  for (const rel of ['scripts/ok.ps1', '.trex/mine.ps1', 'scripts/trex/bench/flows/mine.ps1']) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), 'exit 0\n');
  }
  return dir;
}

const flowOf = (cmd, extra = {}) => ({
  id: 'host-demo', profile: 'host', driver: 'cli', severity: 'P1', limits: { timeoutMs: 60_000, retries: 0 },
  steps: [{ action: { cmd }, checks: [{ exit: 0 }] }], ...extra,
});

function hostCtx(treeDir, answer = ok) {
  const calls = { spawn: [], steps: [] };
  const ctx = {
    now: () => new Date('2026-11-02T12:00:00Z'), treeDir, hostEnv: { PATH: 'p', ANTHROPIC_API_KEY: 'secret', CLAUDE_CODE_X: '1' },
    spawn: async (argv, opts) => { calls.spawn.push({ argv, opts }); return answer; },
    writeStep: (a) => { calls.steps.push(a.result); return []; },
  };
  return { ctx, calls };
}

// Breaks if: a host cli flow is refused again (the old driver_unsupported line), or the spawn gets another cwd or env.
test('H3: an allowed pwsh -File shape runs through spawn in the host tree with a stripped env', async () => {
  const tree = makeTree();
  const { ctx, calls } = hostCtx(tree);
  const out = await runFlow(flowOf(PS1), ctx);
  assert.equal(out.state, 'pass');
  assert.equal(calls.spawn.length, 1);
  assert.deepEqual(calls.spawn[0].argv, PS1);
  assert.equal(calls.spawn[0].opts.cwd, tree);
  assert.equal(calls.spawn[0].opts.env.PATH, 'p');
  assert.equal('ANTHROPIC_API_KEY' in calls.spawn[0].opts.env, false);
  assert.equal('CLAUDE_CODE_X' in calls.spawn[0].opts.env, false);
  assert.ok(calls.spawn[0].opts.timeoutMs > 0 && calls.spawn[0].opts.timeoutMs <= 60_000);
});

// Breaks if: the run time check is dropped and only the lint guards the argv.
test('H3: any other host argv is blocked with host_argv_refused and never spawns', async () => {
  const bad = [
    ['node', '-e', 'process.exit(0)'],
    ['pwsh', '-Command', 'Get-Date'],
    ['pwsh', '-NoProfile', '-File', 'scripts/ok.ps1', 'extra'],
    ['pwsh', '-NoProfile', '-File', '.trex/mine.ps1'],
    ['pwsh', '-NoProfile', '-File', 'scripts/trex/bench/flows/mine.ps1'],
    ['pwsh', '-NoProfile', '-File', 'scripts/missing.ps1'],
    ['pwsh', '-NoProfile', '-File', '../outside.ps1'],
    ['pwsh', '-NoProfile', '-File', 'scripts'],
  ];
  for (const cmd of bad) {
    const { ctx, calls } = hostCtx(makeTree());
    const out = await runFlow(flowOf(cmd), ctx);
    assert.equal(calls.spawn.length, 0, `spawned ${cmd.join(' ')}`);
    assert.equal(out.state, 'incomplete', cmd.join(' '));
    assert.equal(out.reason, 'host_argv_refused', cmd.join(' '));
    assert.match(calls.steps[0].stderr, /\S/, 'the prose reason goes to the step stderr file');
  }
});

// Breaks if: a cli action with a cwd, env or stdin key reaches the host (hostActionOk allows only cmd).
test('H3: a host cli action with an extra key is blocked', async () => {
  const { ctx, calls } = hostCtx(makeTree());
  const flow = flowOf(PS1);
  flow.steps[0].action = { cmd: PS1, env: { A: '1' } };
  const out = await runFlow(flow, ctx);
  assert.equal(out.reason, 'host_argv_refused');
  assert.equal(calls.spawn.length, 0);
});

// Breaks if: a host cli step with no treeDir spawns in the current folder.
test('H3: a host cli step without a tree is blocked tree_missing', async () => {
  const { ctx, calls } = hostCtx(undefined);
  const out = await runFlow(flowOf(PS1), ctx);
  assert.equal(out.reason, 'tree_missing');
  assert.equal(calls.spawn.length, 0);
});

// Breaks if: the host change leaks into the container path (exec must still get the argv, spawn must stay unused).
test('H3: a container cli flow still goes to exec with the argv unchanged and never to spawn', async () => {
  const execCalls = [];
  const exec = async (argv, opts) => { execCalls.push({ argv, opts }); return ok; };
  const spawn = async () => { throw new Error('spawn must not run for a container flow'); };
  const flow = flowOf(['node', '-e', '1'], { profile: 'container' });
  const ctx = { now: () => new Date('2026-11-02T12:00:00Z'), exec, spawn, writeStep: () => [], readFixture: () => null };
  const out = await runFlow(flow, ctx);
  assert.equal(out.state, 'pass');
  assert.deepEqual(execCalls[0].argv, ['node', '-e', '1']);
});

// ---------- exit 137 / out of memory ----------

const containerCtx = (answer) => ({
  now: () => new Date('2026-11-02T12:00:00Z'), writeStep: () => [], readFixture: () => null,
  exec: async () => answer,
});
const containerFlow = (checks) => ({
  id: 'oom-demo', profile: 'container', driver: 'cli', severity: 'P1', limits: { timeoutMs: 60_000, retries: 1 },
  steps: [{ action: { cmd: ['node', 'x.js'] }, checks }, { action: { cmd: ['node', 'y.js'] }, checks: [{ exit: 0 }] }],
});

// Breaks if: an OOM kill (exec result oom:true, code 137) reads as a Fail, which would make a bench row look like a fire.
test('OOM: a real classifyExec early-137 result blocks the flow at stage start and is not retried', async () => {
  let runs = 0;
  const ctx = containerCtx(null);
  ctx.exec = async () => { runs += 1; return classifyExec({ code: 137, stdout: '', stderr: '', timedOut: false }, 60, 5000); };
  const out = await runFlow(containerFlow([{ exit: 137 }]), ctx);
  assert.equal(out.state, 'blocked');
  assert.equal(out.reason, 'start');
  assert.deepEqual(out.blocker, { stage: 'start', text: 'out of memory (exit 137)' });
  assert.equal(out.attempts, 1);
  assert.equal(runs, 1, 'the second step must not run');
});

// Breaks if: a timed-out exec reads as a Fail instead of a check that was not attempted for reason timeout.
test('OOM: an exec result with timedOut:true is not_attempted/timeout, never a Fail', async () => {
  const ctx = containerCtx({ code: 137, stdout: '', stderr: '', timedOut: true });
  const out = await runFlow(containerFlow([{ exit: 0 }]), ctx);
  assert.equal(out.state, 'incomplete');
  assert.equal(out.reason, 'timeout');
  assert.equal(out.checks[0].state, 'not_attempted');
});
