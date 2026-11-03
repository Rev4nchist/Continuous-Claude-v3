// Failure modes (P0 F1, F2, F3, F6, F8, F9/F10 budget, shadow F10).
//  F1  sha unreachable after fetch      -> drop the cat-file check in ensureCommits
//  F2  round-1 base from today's main   -> use pull.base.sha in roundRange (a real merge repo proves merge^1)
//  F3  round k parent not an ancestor   -> drop the --is-ancestor branch
//  F6  open PR has no merge sha         -> dereference mergeSha^1 with no check
//  F8  prompt changed after the freeze  -> skip checkFreeze in replayRun
//  F9  budget used                      -> skip cursorBudget in replayRun
//  sF10 replay never writes under local-review/ -> let outDir or the runs file sit under state/local-review
//  build-only starts no agent and writes no ledger line -> call runReview in build-only mode
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeGit, replayRun, roundRange } from './replay.mjs';
import { promptSha256 } from './freeze.mjs';

const sha = (c) => c.repeat(40);
const tmp = () => mkdtempSync(path.join(process.env.REVIEW_EVAL_TMP || os.tmpdir(), 'replay-'));
const cfg = { cursorEvalBudget: 40, cursorHeadroom: 60, shadow: { dailyMax: 6 }, freeze: { promptSha256: 'frozen' } };
const okFreeze = () => ({ ok: true, promptSha256: 'frozen' });

// A scripted git: records each call, answers merge-base with `base`.
function scriptedGit({ base = sha('0'), ancestor = true, have = true } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return { status: ancestor ? 0 : 1, stdout: '' };
    if (args[0] === 'merge-base') return { status: 0, stdout: `${base}\n` };
    if (args[0] === 'cat-file') return { status: have ? 0 : 128, stdout: '' };
    return { status: 0, stdout: '' };
  };
  return { git, calls };
}

test('F2 round 1 of a merged PR takes its base from merge^1, never from pull.base.sha', () => {
  // Breaks when: roundRange uses pull.base.sha (BASEBASE) for a merged PR.
  const { git, calls } = scriptedGit({ base: sha('1') });
  const pull = { merged: true, mergeSha: sha('9'), baseSha: sha('b'), rounds: [{ sha40: sha('c') }] };
  const r = roundRange(5, 1, { git, pull });
  assert.equal(r.base, sha('1'));
  assert.equal(r.range, 'normal');
  const mb = calls.find((c) => c[0] === 'merge-base');
  assert.deepEqual(mb, ['merge-base', sha('c'), `${sha('9')}^1`]);
  assert.equal(calls.flat().includes(sha('b')), false);
});

test('F2 with a real merge repo: the base is merge-base(head, merge^1), not the PR base sha', () => {
  // Breaks when: roundRange uses pull.base.sha (the branch point c1) instead of merge-base(head, merge^1) (c2, where the PR merged main in).
  const dir = tmp();
  const run = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
  mkdirSync(dir, { recursive: true });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@t'); run('config', 'user.name', 't'); run('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'f.txt'), '1'); run('add', '.'); run('commit', '-qm', 'c1');
  const c1 = run('rev-parse', 'HEAD');
  run('checkout', '-qb', 'feat');
  writeFileSync(path.join(dir, 'g.txt'), '1'); run('add', '.'); run('commit', '-qm', 'feat1');
  run('checkout', '-q', 'main');
  writeFileSync(path.join(dir, 'f.txt'), '2'); run('commit', '-qam', 'c2');
  const c2 = run('rev-parse', 'HEAD');
  run('checkout', '-q', 'feat');
  run('merge', '--no-ff', '-qm', 'update from main', 'main');
  writeFileSync(path.join(dir, 'g.txt'), '2'); run('commit', '-qam', 'feat2');
  const head = run('rev-parse', 'HEAD');
  run('checkout', '-q', 'main');
  writeFileSync(path.join(dir, 'h.txt'), '3'); run('add', '.'); run('commit', '-qm', 'c3');
  run('merge', '--no-ff', '-qm', 'Merge PR', 'feat');
  const mergeSha = run('rev-parse', 'HEAD');
  const r = roundRange(1, 1, { git: makeGit(dir), pull: { merged: true, mergeSha, baseSha: c1, rounds: [{ sha40: head }] } });
  assert.equal(r.base, c2);
  assert.notEqual(r.base, c1);
});

test('F6 an open PR (no merge sha) uses pull.base.sha and does not throw', () => {
  // Breaks when: roundRange builds `${mergeSha}^1` from undefined.
  const { git, calls } = scriptedGit({ base: sha('2') });
  const r = roundRange(5, 1, { git, pull: { merged: false, mergeSha: null, baseSha: sha('b'), rounds: [{ sha40: sha('c') }] } });
  assert.equal(r.base, sha('2'));
  assert.deepEqual(calls.find((c) => c[0] === 'merge-base'), ['merge-base', sha('c'), sha('b')]);
  assert.equal(calls.flat().some((a) => String(a).includes('undefined') || String(a).includes('null')), false);
});

test('F3 round k uses the previous round sha when it is an ancestor, and range:rebased when it is not', () => {
  // Breaks when: the --is-ancestor branch is dropped (a force-pushed round would diff against a missing parent).
  const pull = { merged: true, mergeSha: sha('9'), baseSha: sha('b'), rounds: [{ sha40: sha('c') }, { sha40: sha('d') }] };
  const ok = roundRange(5, 2, { git: scriptedGit({ ancestor: true }).git, pull });
  assert.deepEqual([ok.range, ok.base], ['normal', sha('c')]);
  const { git, calls } = scriptedGit({ ancestor: false, base: sha('1') });
  const rebased = roundRange(5, 2, { git, pull });
  assert.deepEqual([rebased.range, rebased.base], ['rebased', sha('1')]);
  assert.ok(calls.some((c) => c[0] === 'merge-base' && c[1] !== '--is-ancestor' && c[2] === `${sha('9')}^1`));
});

function baseDeps(dir, over = {}) {
  const calls = { runReview: [], prepare: 0, cleanup: 0 };
  const { git } = scriptedGit({ base: sha('1') });
  return {
    calls,
    deps: {
      root: dir, cfg, git, tmpRoot: dir,
      checkFreeze: okFreeze,
      fetchPrFn: async () => ({ merged: true, mergeSha: sha('9'), baseSha: sha('b'), headSha: sha('c'), rounds: [{ sha40: sha('c') }, { sha40: sha('d') }], set: 'holdout' }),
      ledgerPath: path.join(dir, 'cursor-ledger.jsonl'),
      runsPath: path.join(dir, 'e2e', 'review-eval', 'runs.jsonl'),
      outRoot: path.join(dir, 'e2e', 'review-eval'),
      prepare: async () => { calls.prepare += 1; return { ref: 'range-x', dir: path.join(dir, 'tree'), files: ['a.mjs'], cleanup: () => { calls.cleanup += 1; } }; },
      runReview: async (opts, d) => { calls.runReview.push({ opts, d }); return { exit: 0, runId: 'run-1', findingsPath: path.join(opts.outDir, 'x.findings.json') }; },
      readFindings: () => ({ findings: [{ file: 'a.mjs' }], usage: { in: 1 } }),
      now: () => Date.parse('2026-11-02T18:00:00Z'),
      ...over,
    },
  };
}

test('replayRun calls runReview with the grok model, band MID, session review-eval and an out dir under e2e/review-eval', async () => {
  // Breaks when: the session id is not review-eval (budget would not count the run) or the out dir leaves e2e/review-eval.
  const dir = tmp();
  const { deps, calls } = baseDeps(dir);
  const r = await replayRun({ pr: 207, round: 1 }, deps);
  assert.equal(r.status, 'ok');
  assert.equal(calls.runReview.length, 1);
  const { opts, d } = calls.runReview[0];
  assert.equal(opts.model, 'grok-4.7-high');
  assert.equal(opts.band, 'MID');
  assert.equal(d.env.CLAUDE_CODE_SESSION_ID, 'review-eval');
  assert.match(opts.input.range, new RegExp(`^${sha('1')}\\.\\.${sha('c')}$`));
  assert.ok(opts.outDir.startsWith(path.join(dir, 'e2e', 'review-eval')));
  const rec = JSON.parse(readFileSync(deps.runsPath, 'utf8').trim());
  assert.deepEqual([rec.schema, rec.pr, rec.round, rec.status, rec.sha40, rec.base40, rec.range], [1, 207, 1, 'ok', sha('c'), sha('1'), 'normal']);
  assert.equal(rec.cursorRunId, 'run-1');
  assert.equal(rec.findingCount, 1);
});

test('F1 a sha that is still missing after the fetch gives tree_unbuildable and no throw', async () => {
  // Breaks when: the cat-file check is dropped from ensureCommits (prepare would throw or run on a missing sha).
  const dir = tmp();
  const { git } = scriptedGit({ have: false });
  const { deps, calls } = baseDeps(dir, { git });
  const r = await replayRun({ pr: 207, round: 1 }, deps);
  assert.equal(r.status, 'tree_unbuildable');
  assert.equal(calls.runReview.length, 0);
  assert.equal(JSON.parse(readFileSync(deps.runsPath, 'utf8').trim()).status, 'tree_unbuildable');
});

test('F8 a changed prompt stops the replay with exit 2 and starts no agent', async () => {
  // Breaks when: replayRun skips checkFreeze.
  const dir = tmp();
  const { deps, calls } = baseDeps(dir, { checkFreeze: () => ({ ok: false, reason: 'prompt changed since the freeze' }) });
  const r = await replayRun({ pr: 207, round: 1 }, deps);
  assert.equal(r.exit, 2);
  assert.equal(r.status, 'frozen');
  assert.equal(calls.runReview.length, 0);
});

test('F9 a used eval budget stops the replay with exit 3 and status cap', async () => {
  // Breaks when: replayRun skips cursorBudget.
  const dir = tmp();
  const ledger = path.join(dir, 'cursor-ledger.jsonl');
  const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify({ ts: '2026-11-02T10:00:00.000Z', phase: 'start', id: `i${i}`, ref: `r${i}`, sessionId: 'review-eval' }));
  writeFileSync(ledger, `${lines.join('\n')}\n`);
  const { deps, calls } = baseDeps(dir, { ledgerPath: ledger });
  const r = await replayRun({ pr: 207, round: 1 }, deps);
  assert.deepEqual([r.exit, r.status], [3, 'cap']);
  assert.equal(calls.runReview.length, 0);
});

test('sF10 replay refuses an out dir or runs file under a local-review folder and writes nothing there', async () => {
  // Breaks when: the guard on output paths is removed (a replay would write under state/local-review, where LR-PIN reads).
  const dir = tmp();
  const bad = path.join(dir, 'state', 'local-review', 'branch');
  const { deps, calls } = baseDeps(dir, { outRoot: bad, runsPath: path.join(bad, 'runs.jsonl') });
  const r = await replayRun({ pr: 207, round: 1 }, deps);
  assert.equal(r.exit, 2);
  assert.equal(calls.runReview.length, 0);
  assert.equal(existsSync(bad), false);
  // local-review-shadow is a different folder and stays allowed.
  const ok = path.join(dir, 'state', 'local-review-shadow', 'x');
  const { deps: d2 } = baseDeps(dir, { outRoot: ok, runsPath: path.join(ok, 'runs.jsonl') });
  assert.equal((await replayRun({ pr: 207, round: 1 }, d2)).status, 'ok');
});

test('--build-only builds and cleans the tree, starts no agent and writes no run line or ledger', async () => {
  // Breaks when: buildOnly still calls runReview, skips cleanup, or reserves a ledger run.
  const dir = tmp();
  const { deps, calls } = baseDeps(dir);
  const r = await replayRun({ pr: 207, round: 1, buildOnly: true }, deps);
  assert.equal(r.status, 'built');
  assert.equal(calls.prepare, 1);
  assert.equal(calls.cleanup, 1);
  assert.equal(calls.runReview.length, 0);
  assert.equal(existsSync(deps.ledgerPath), false);
  assert.equal(existsSync(deps.runsPath), false);
});

test('a prepare failure in build-only gives tree_unbuildable with the reason', async () => {
  // Breaks when: buildOnly lets the prepareReview error escape.
  const dir = tmp();
  const { deps } = baseDeps(dir, { prepare: async () => { throw new Error('the review tree is missing 1 changed file(s): x'); } });
  const r = await replayRun({ pr: 207, round: 1, buildOnly: true }, deps);
  assert.equal(r.status, 'tree_unbuildable');
  assert.match(r.reason, /missing 1 changed file/);
});

test('promptSha256 of the stubbed prompt is stable (guards the frozen compare used above)', () => {
  // Breaks when: promptSha256 stops being a pure hash of the build output.
  assert.equal(promptSha256({ build: () => 'a' }), promptSha256({ build: () => 'a' }));
});
