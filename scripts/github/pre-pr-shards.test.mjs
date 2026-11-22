// Tests for the shards of pre-pr.cases.mjs (card prepr-speed-bundle, O2). Run: node --test scripts/github/pre-pr-shards.test.mjs
// The cases of pre-pr.mjs live in pre-pr.cases.mjs and run in 4 processes (pre-pr-shard-1..4.test.mjs), so node --test runs the four at once. The
// github-tests gate runs the glob scripts/github/*.test.mjs, so each case must run once there: in exactly one shard, and in no other test file.
// How it can fail, one test each, with the source change that makes it fail:
//   SH1  a wrapper has a wrong or doubled index, or a count that differs from the others: a share of the cases runs twice or never   (edit one index)
//   SH2  a *.test.mjs besides the wrappers imports the cases file (a thin pre-pr.test.mjs, an old name kept): all cases run again    (add the import)
//   SH3  the case wrapper (case n runs in shard n % count) is dropped from the cases file                                           (delete the wrapper)
//   SH4  the CI step names an old file or misses a shard: CI runs fewer cases than pre-pr, and gate-coverage sees a gap              (edit ccv3-checks.yml)
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SHARDS = [1, 2, 3, 4].map((n) => `pre-pr-shard-${n}.test.mjs`);
const CASES = 'pre-pr.cases.mjs';

test('SH1: four shard wrappers exist; each imports the cases file; the indexes are 0 to 3 once each and the count is 4 in all', () => {
  assert.ok(existsSync(path.join(HERE, CASES)), `${CASES} exists`);
  const seen = SHARDS.map((f) => {
    assert.ok(existsSync(path.join(HERE, f)), `${f} exists`);
    const text = readFileSync(path.join(HERE, f), 'utf8');
    const m = /globalThis\.PRE_PR_SHARD\s*=\s*\{\s*index:\s*(\d+),\s*count:\s*(\d+)\s*\}/.exec(text);
    assert.ok(m, `${f} sets globalThis.PRE_PR_SHARD = { index, count }`);
    assert.match(text, /await import\('\.\/pre-pr\.cases\.mjs'\)/, `${f} imports the cases file`);
    return { f, index: Number(m[1]), count: Number(m[2]) };
  });
  assert.deepEqual(seen.map((s) => s.count), [4, 4, 4, 4], 'one shared count');
  assert.deepEqual(seen.map((s) => s.index).sort(), [0, 1, 2, 3], 'every index once: the shares add up to every case');
});

test('SH2: the cases file is no *.test.mjs, and no test file besides the four wrappers imports it: the glob runs each case once', () => {
  assert.equal(/\.test\.mjs$/.test(CASES), false);
  assert.equal(existsSync(path.join(HERE, 'pre-pr.test.mjs')), false, 'no pre-pr.test.mjs: a thin file would run every case a second time beside the shards');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name.startsWith('.') ? [] : walk(p);
    return e.name.endsWith('.test.mjs') ? [p] : [];
  });
  const importers = walk(path.join(ROOT, 'scripts')).filter((f) => /pre-pr\.cases\.mjs/.test(readFileSync(f, 'utf8')) && !/pre-pr-shards\.test\.mjs$/.test(f));
  assert.deepEqual(importers.map((f) => path.basename(f)).sort(), [...SHARDS].sort());
});

test('SH3: the cases file registers case n only in shard n % count, and runs every case when no shard is set', () => {
  const text = readFileSync(path.join(HERE, CASES), 'utf8');
  assert.match(text, /globalThis\.PRE_PR_SHARD \?\? \{ index: 0, count: 1 \}/);
  assert.match(text, /caseNo % SHARD\.count === SHARD\.index/);
});

test('SH4: the CI step "pre-pr unit tests" names the four shards and this file, and no pre-pr.test.mjs', () => {
  const wf = readFileSync(path.join(ROOT, '.github/workflows/ccv3-checks.yml'), 'utf8');
  const step = wf.split('\n').find((l) => /run: node --test scripts\/github\/pre-pr/.test(l));
  assert.ok(step, 'a run line of the pre-pr unit tests step');
  const named = step.split(/\s+/).filter((t) => /^scripts\/github\/.+\.mjs$/.test(t));
  for (const f of [...SHARDS, 'pre-pr-shards.test.mjs']) assert.ok(named.includes(`scripts/github/${f}`), `the CI step names ${f}: ${step.trim()}`);
  assert.equal(named.includes('scripts/github/pre-pr.test.mjs'), false, 'the CI step no longer names pre-pr.test.mjs');
  for (const f of named) assert.ok(existsSync(path.join(ROOT, f)), `${f} exists`);
});
