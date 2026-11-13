/**
 * coord-drill-2 / abort.test.mjs -- after a scenario timeout (abortDrill) the s2 helpers must not make folders (F3).
 *
 *   node --test scripts/coordination/coord-drill-2/abort.test.mjs
 *
 * Own file because abortDrill sets module state that never resets: each test file is its own process.
 * Failure modes: git(), makeRepo() or extractOldHook() still create or write under a removed sandbox after the abort.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HarnessError, abortDrill, makeSandbox } from './lib.mjs';
import * as s2 from './s2-worktree-claim.mjs';

function abortedCtx(t) {
  const sandbox = makeSandbox(`abort${process.pid}`);
  t.after(() => sandbox.cleanup());
  const ctx = { sandbox, env: { ...process.env }, runId: 'abort', aborted: false };
  abortDrill(ctx, 'test timeout');
  return ctx;
}

const entries = (dir) => fs.readdirSync(dir).sort();

test('after an abort, makeRepo makes no folder and runs no git', (t) => {
  const ctx = abortedCtx(t);
  const before = entries(ctx.sandbox.dir);
  assert.throws(() => s2.makeRepo(ctx, 'late'), HarnessError);
  assert.deepEqual(entries(ctx.sandbox.dir), before, 'makeRepo created something under the sandbox');
});

test('after an abort, git() refuses before it spawns', (t) => {
  const ctx = abortedCtx(t);
  assert.throws(() => s2.git(ctx, ctx.sandbox.dir, ['--version']), HarnessError);
});

test('after an abort, extractOldHook writes no hook file', (t) => {
  const ctx = abortedCtx(t);
  assert.throws(() => s2.extractOldHook(ctx), HarnessError);
  assert.ok(!fs.existsSync(path.join(ctx.sandbox.dir, 's2-old-hook')), 'the old hook folder was made after the abort');
});
