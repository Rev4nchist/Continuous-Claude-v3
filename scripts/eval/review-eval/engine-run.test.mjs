// Tests for engine-run.mjs (a replayed round reviewed by the local review engine). Every test names the source change that would break it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runEngine, toEvalFindings } from './engine-run.mjs';

const SHA = 'c'.repeat(40);
const BASE = '1'.repeat(40);
const CFG = '{"matrix":{}}';
const record = (over = {}) => ({
  runId: 'r1', status: 'ok', coverage: { complete: true }, trusted: false, model: 'grok-4.7-high', cursorAgentVersion: '2026.10.22-x', promptSha256: 'P', problems: [],
  funnel: { raw: 3, withdrawn: 2, dropped: { byReason: { 'no-file': 1 } }, posted: 2 }, withdrawn: [{ id: 'w1', path: 'a.mjs', line: 4, severity: 'major', reason: 'x' }],
  runs: [{ runId: 'r1', durationMs: 900, usage: { inputTokens: 5 }, modelVerified: true }],
  findings: [
    { id: 'f1', file: 'a.mjs', startLine: 10, endLine: 12, severity: 'major', title: 'T1', confidence: 4, status: 'open' },
    { id: 'f2', file: 'b.mjs', startLine: 3, severity: 'minor', title: 'T2', status: 'open' },
    { id: 'f3', file: 'c.mjs', startLine: 1, severity: 'major', title: 'T3', status: 'fixed' },
  ],
  ...over,
});

test('toEvalFindings maps startLine to line, keeps open findings only, and carries the funnel, withdrawn list, model and trace path (breaks if the shape evaluateRuns reads changes)', () => {
  const got = toEvalFindings(record(), { tracePath: '/t/r1.trace.json' });
  assert.deepEqual(got.findings.map((f) => [f.file, f.line, f.lineEnd, f.severity, f.title]), [['a.mjs', 10, 12, 'major', 'T1'], ['b.mjs', 3, 3, 'minor', 'T2']]);
  assert.deepEqual(got.funnel, record().funnel);
  assert.equal(got.withdrawn.length, 1);
  assert.equal(got.tracePath, '/t/r1.trace.json');
  assert.deepEqual([got.durationMs, got.usage, got.modelVerified, got.trusted, got.promptSha256], [900, { inputTokens: 5 }, true, false, 'P']);
});

function harness(over = {}) {
  const seen = { gh: [], readAt: [] };
  const reviewHead = async (opts, deps) => {
    seen.opts = opts;
    seen.deps = deps;
    seen.pull = await deps.gh(['api', 'repos/o/n/pulls/5']);
    seen.other = await deps.gh(['api', 'repos/o/n/issues/5']);
    seen.cfg = deps.readAtSha('.', BASE, 'review-router.config.json');
    seen.rest = deps.readAtSha('.', BASE, 'REVIEW.md');
    return { exit: 0, recordPath: '/s/branch/head/r1.json', status: 'ok', ...(over.res ?? {}) };
  };
  const args = { pr: 5, sha40: SHA, base40: BASE, root: '/repo', stateRoot: '/run/state', stateDir: '/run', ledgerPath: '/led.jsonl', env: { CLAUDE_CODE_SESSION_ID: 'review-eval' }, configText: CFG,
    gh: async (a) => (String(a[1]).endsWith('/pulls/5') ? { head: { sha: 'REAL', ref: 'feat/x' }, base: { sha: 'REALBASE', ref: 'main' }, draft: true, labels: [{ name: 'risk:high' }], title: 'T' } : { other: true }) };
  const deps = { reviewHead, readAtSha: (r, s, p) => { seen.readAt.push(p); return `real:${p}`; }, readFile: () => JSON.stringify(over.record ?? record()) };
  return { seen, args, deps };
}

test('runEngine reviews the round sha and base, fresh, untrusted, with the run state folder and the eval ledger (breaks if the PR head is used or the run is not fresh)', async () => {
  const { seen, args, deps } = harness();
  const r = await runEngine(args, deps);
  assert.deepEqual([seen.opts.pr, seen.opts.fresh, seen.opts.engineHere], [5, true, true]);
  assert.equal(seen.pull.head.sha, SHA);
  assert.equal(seen.pull.base.sha, BASE);
  assert.equal(seen.pull.head.ref, 'feat/x', 'the branch name stays: the record folder keys on it');
  assert.deepEqual([seen.pull.draft, seen.pull.labels], [false, []]);
  assert.deepEqual(seen.other, { other: true }, 'a gh call that is not the PR read passes through');
  assert.deepEqual([seen.deps.stateRoot, seen.deps.stateDir, seen.deps.cursorLedger], ['/run/state', '/run', '/led.jsonl']);
  assert.equal(seen.deps.env.CLAUDE_CODE_SESSION_ID, 'review-eval');
  assert.equal(r.status, 'ok');
  assert.equal(r.tracePath, '/s/branch/head/r1.trace.json');
});

test('runEngine gives the band config from the current checkout and records its sha256, and reads every other base file as usual (breaks if the old base config is read or the override leaks to other files)', async () => {
  const { seen, args, deps } = harness();
  const r = await runEngine(args, deps);
  assert.equal(seen.cfg, CFG);
  assert.equal(seen.rest, 'real:REVIEW.md');
  assert.deepEqual(seen.readAt, ['REVIEW.md']);
  assert.equal(r.baseConfig.source, 'current checkout');
  assert.match(r.baseConfig.sha256, /^[0-9a-f]{64}$/);
});

test('runEngine maps a skip, a cap, a failed record and a throw to a status and a reason, and never throws (breaks if a skip counts as ok)', async () => {
  const skipped = await runEngine(...Object.values(harness({ res: { exit: 0, recordPath: null, skipReason: 'band LOW is not reviewed' } })).slice(1));
  assert.deepEqual([skipped.status, skipped.reason], ['failed', 'skipped: band LOW is not reviewed']);
  const cap = await runEngine(...Object.values(harness({ res: { exit: 3, recordPath: null, reason: '8 reached' } })).slice(1));
  assert.equal(cap.status, 'cap');
  const bad = await runEngine(...Object.values(harness({ res: { exit: 1 }, record: record({ status: 'failed', problems: ['TIMED OUT after 1200 s'] }) })).slice(1));
  assert.deepEqual([bad.status, bad.reason], ['failed', 'TIMED OUT after 1200 s']);
  const h = harness();
  const threw = await runEngine(h.args, { ...h.deps, reviewHead: async () => { throw new Error('boom'); } });
  assert.deepEqual([threw.status, threw.reason], ['failed', 'reviewHead threw: boom']);
});

test('runEngine withholds the PR body by default and keeps it only when bodyMode is full (breaks if an eval run lets the merged PR body reach the reviewer)', async () => {
  const a = harness();
  await runEngine(a.args, a.deps);
  assert.equal(a.seen.opts.withholdBody, true);
  const b = harness();
  await runEngine({ ...b.args, bodyMode: 'full' }, b.deps);
  assert.equal(b.seen.opts.withholdBody, false);
});

test('runEngine marks the engine run as an eval run, so reviewHead keys its cap on eval-<pr>-<sha8> (breaks if evalRun is dropped)', async () => {
  const a = harness();
  await runEngine(a.args, a.deps);
  assert.equal(a.seen.opts.evalRun, true);
});

test('runEngine: a record with coverage.complete not true is not ok, even with record status ok and exit 0 (breaks if only record.status is read)', async () => {
  for (const coverage of [{ complete: false }, {}, undefined]) {
    const h = harness({ record: record({ status: 'ok', coverage, problems: ['2 files not covered'] }) });
    const r = await runEngine(h.args, h.deps);
    assert.equal(r.status, 'incomplete', JSON.stringify(coverage));
    assert.match(r.reason, /not covered/);
  }
  const full = harness({ record: record({ coverage: { complete: true } }) });
  assert.equal((await runEngine(full.args, full.deps)).status, 'ok');
});

