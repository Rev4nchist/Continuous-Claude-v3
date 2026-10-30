// Tests for cr-fix.mjs. Run: node --test scripts/github/cr-fix.test.mjs
// No network and no CodeRabbit run: gh, git and the cr runner are injected fakes.
//
// How cr-fix.mjs can fail, and the test that catches it (written before the code):
//   the run passes --use-credits or --api-key, or reviews the wrong range           -> CF1, CF9
//   the base is not the NEWEST CodeRabbit review's commit (a person's review,
//     an empty thread-reply review or an older round is used)                        -> CF2
//   the printed line has the wrong shape, so review-status.mjs cannot read it         -> CF3
//   a Major or Critical finding prints "clean"; a Minor-only run prints a count       -> CF4
//   awaiting_confirmation / action_required prints a count or exits 0                  -> CF5
//   a run that did not finish (exit code, timeout, no complete event, error event,
//     failed outcome, unreviewed files, no changes) prints "clean"                     -> CF6
//   the full output is not saved, or saved under a name the PR cannot cite             -> CF3, CF6
//   no CodeRabbit review, the review of the head itself, a gh failure or a bad
//     argument still starts a (billed) CLI run                                         -> CF7, CF8, CF9
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as FIX from './cr-fix.mjs';
import { parseCliFixReviews } from './review-status.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const OLDER = 'd'.repeat(40);
const CR_BOT = { login: 'coderabbitai[bot]', type: 'Bot' };
const review = (id, commit_id, submitted_at, over = {}) => ({ id, user: CR_BOT, commit_id, submitted_at, body: 'Actionable comments posted: 1', ...over });
const NOW = new Date(2026, 9, 30, 9, 0, 0);

const ev = (...objs) => `${objs.map((o) => JSON.stringify(o)).join('\n')}\n`;
const CONTEXT = { type: 'review_context', workingDirectory: '/x', currentBranch: 'feat/x', baseBranch: 'main', expectedDuration: 120 };
const finding = (severity, n = 1) => ({ type: 'finding', severity, fileName: `src/f${n}.ts`, startLine: n, endLine: n, title: `finding ${n}`, comment: 'c' });
const DONE = { type: 'complete', status: 'review_completed', outcome: 'completed' };

/** A harness: fake gh (reviews list), fake git head, fake cr runner. Records every call. */
function harness({ reviews = [review(1, OLD, '2026-10-30T08:00:00Z')], head = HEAD, run = { status: 0, stdout: ev(CONTEXT, DONE), stderr: '' }, ghError = null } = {}) {
  const calls = { gh: [], runs: [], writes: [] };
  const deps = {
    gh: (args) => { calls.gh.push(args); if (ghError) throw new Error(ghError); return reviews; },
    headSha: () => head,
    runCr: async (spec) => { calls.runs.push(spec); return typeof run === 'function' ? run(spec) : run; },
    writeOut: (file, text) => { calls.writes.push({ file, text }); },
    now: NOW,
  };
  return { calls, deps, go: (over = {}) => FIX.crFix({ pr: 219, repo: 'Rev4nchist/Continuous-Claude-v3', cwd: '/repo', ...over }, deps) };
}

test('CF1: the CLI runs `review --agent --committed --base-commit <newest review commit>` in the checkout, with no billing flag', async () => {
  const h = harness();
  await h.go();
  assert.equal(h.calls.runs.length, 1);
  assert.deepEqual(h.calls.runs[0].args, ['review', '--agent', '--committed', '--base-commit', OLD]);
  assert.equal(h.calls.runs[0].cwd, '/repo');
  assert.ok(h.calls.runs[0].timeoutMs >= 15 * 60_000, 'a review needs at least 15 minutes (coderabbit-cli.md)');
  assert.ok(!h.calls.runs[0].args.some((a) => /use-credits|api-key/.test(a)), 'never a billing or key flag');
  assert.ok(FIX.CR_FIX_ARGS(OLD).every((a) => !/use-credits|api-key/.test(a)));
});

test('CF2: the base is the NEWEST CodeRabbit review with a body; people, empty thread replies and older rounds are skipped', async () => {
  const reviews = [
    review(1, OLDER, '2026-10-29T08:00:00Z'),
    review(2, OLD, '2026-10-30T08:00:00Z'),
    review(3, 'c'.repeat(40), '2026-10-30T09:30:00Z', { body: '' }),
    { id: 4, user: { login: 'Rev4nchist', type: 'User' }, commit_id: 'e'.repeat(40), submitted_at: '2026-10-30T09:40:00Z', body: 'x' },
  ];
  const h = harness({ reviews });
  const r = await h.go();
  assert.equal(h.calls.runs[0].args.at(-1), OLD);
  assert.equal(r.from, OLD);
  assert.ok(h.calls.gh[0].some((a) => /pulls\/219\/reviews/.test(a)), `gh reads the PR reviews: ${h.calls.gh[0].join(' ')}`);
});

test('CF3: a clean run prints ONE line `CLI fix review: <from7>..<head7> clean`, exits 0 and saves the full output; review-status.mjs reads the line', async () => {
  const stdout = ev(CONTEXT, finding('minor'), DONE);
  const h = harness({ run: { status: 0, stdout, stderr: '' } });
  const r = await h.go();
  assert.equal(r.line, 'CLI fix review: bbbbbbb..aaaaaaa clean');
  assert.equal(r.exitCode, 0);
  assert.equal(h.calls.writes.length, 1);
  assert.match(h.calls.writes[0].file.replace(/\\/g, '/'), /\.claude\/cache\/e2e\/2026-10-30-cr-fix-aaaaaaa\.txt$/);
  assert.ok(h.calls.writes[0].text.includes('"finding"'), 'the full stream is saved');
  assert.equal(r.outFile, h.calls.writes[0].file);
  assert.deepEqual(parseCliFixReviews(r.line), [{ from: 'bbbbbbb', head: 'aaaaaaa', verdict: 'clean' }]);
  assert.ok(!r.line.includes('\n'), 'one line');
});

test('CF4: a Major prints `N major`, a Critical prints `N critical` (Critical wins), a Minor-only run is clean', async () => {
  const line = async (...findings) => (await harness({ run: { status: 0, stdout: ev(CONTEXT, ...findings, DONE), stderr: '' } }).go()).line;
  assert.equal(await line(finding('major', 1)), 'CLI fix review: bbbbbbb..aaaaaaa 1 major');
  assert.equal(await line(finding('major', 1), finding('major', 2), finding('minor', 3)), 'CLI fix review: bbbbbbb..aaaaaaa 2 major');
  assert.equal(await line(finding('critical', 1), finding('major', 2)), 'CLI fix review: bbbbbbb..aaaaaaa 1 critical');
  assert.equal(await line(finding('minor', 1), finding('trivial', 2), finding('info', 3)), 'CLI fix review: bbbbbbb..aaaaaaa clean');
  const major = await harness({ run: { status: 0, stdout: ev(CONTEXT, finding('major'), DONE), stderr: '' } }).go();
  assert.equal(major.exitCode, 0, 'a finished review exits 0; the line says what it found');
  assert.deepEqual(parseCliFixReviews(major.line)[0].verdict, '1 major');
});

test('CF5: awaiting_confirmation and action_required print `incomplete` with the reason and exit non-zero; credits are never passed', async () => {
  for (const word of ['awaiting_confirmation', 'action_required']) {
    for (const where of ['status', 'complete']) {
      const stream = where === 'status' ? ev(CONTEXT, { type: 'status', status: word }, finding('major')) : ev(CONTEXT, { type: 'complete', status: word });
      const h = harness({ run: { status: 0, stdout: stream, stderr: '' } });
      const r = await h.go();
      assert.equal(r.line, 'CLI fix review: bbbbbbb..aaaaaaa incomplete', `${word} in ${where}`);
      assert.notEqual(r.exitCode, 0, `${word} in ${where}`);
      assert.ok(r.reason.includes(word), r.reason);
      assert.match(r.reason, /Dave/);
      assert.equal(h.calls.runs.length, 1, 'no retry with credits');
    }
  }
  const quoted = harness({ run: { status: 0, stdout: ev(CONTEXT, { ...finding('minor'), comment: 'the state awaiting_confirmation is reserved' }, DONE), stderr: '' } });
  assert.equal((await quoted.go()).line, 'CLI fix review: bbbbbbb..aaaaaaa clean', 'text inside a finding is not a status');
});

test('CF6: a run that did not finish prints `incomplete`, never clean, and still saves what it got', async () => {
  const cases = [
    ['non-zero exit', { status: 1, stdout: ev(CONTEXT, DONE), stderr: 'boom' }],
    ['timeout', { status: null, stdout: ev(CONTEXT), stderr: '', timedOut: true }],
    ['no complete event', { status: 0, stdout: ev(CONTEXT, finding('minor')), stderr: '' }],
    ['error event', { status: 0, stdout: ev(CONTEXT, { type: 'error', errorType: 'auth', message: 'not logged in' }), stderr: '' }],
    ['failed outcome', { status: 0, stdout: ev(CONTEXT, { ...DONE, outcome: 'failed' }), stderr: '' }],
    ['unreviewed files', { status: 0, stdout: ev(CONTEXT, { ...DONE, unreviewedFileCount: 2 }), stderr: '' }],
    ['review_skipped', { status: 0, stdout: ev(CONTEXT, { type: 'complete', status: 'review_skipped' }), stderr: '' }],
    ['spawn error', { status: null, stdout: '', stderr: '', error: 'spawn cr ENOENT', errorCode: 'ENOENT' }],
    ['empty output', { status: 0, stdout: '', stderr: '' }],
  ];
  for (const [name, run] of cases) {
    const h = harness({ run });
    const r = await h.go();
    assert.equal(r.line, 'CLI fix review: bbbbbbb..aaaaaaa incomplete', name);
    assert.notEqual(r.exitCode, 0, name);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, name);
    assert.equal(h.calls.writes.length, 1, `${name}: the output is saved`);
  }
});

test('CF7: no CodeRabbit review, or a newest review of the head itself, ends with exit 2 and starts no CLI run', async () => {
  const none = harness({ reviews: [] });
  const r1 = await none.go();
  assert.equal(r1.exitCode, 2);
  assert.equal(none.calls.runs.length, 0);
  assert.match(r1.reason, /CodeRabbit review/);
  const same = harness({ reviews: [review(1, HEAD, '2026-10-30T08:00:00Z')] });
  const r2 = await same.go();
  assert.equal(r2.exitCode, 2);
  assert.equal(same.calls.runs.length, 0);
  assert.match(r2.reason, /head/);
  const badSha = harness({ reviews: [review(1, 'zz', '2026-10-30T08:00:00Z')] });
  assert.equal((await badSha.go()).exitCode, 2);
  assert.equal(badSha.calls.runs.length, 0);
});

test('CF8: a gh failure or an unreadable head ends with exit 2 and starts no CLI run', async () => {
  const gh = harness({ ghError: 'HTTP 502' });
  const r = await gh.go();
  assert.equal(r.exitCode, 2);
  assert.equal(gh.calls.runs.length, 0);
  assert.match(r.reason, /HTTP 502/);
  const noHead = harness({ head: '' });
  assert.equal((await noHead.go()).exitCode, 2);
  assert.equal(noHead.calls.runs.length, 0);
});

test('CF9: parseArgs reads --pr, --repo and --timeout-min; --use-credits, --api-key and anything unknown are refused', () => {
  assert.deepEqual(FIX.parseArgs(['--pr', '219']).pr, 219);
  assert.equal(FIX.parseArgs(['219']).pr, 219, 'a bare number is the PR');
  assert.equal(FIX.parseArgs(['--pr', '5', '--repo', 'o/r']).repo, 'o/r');
  assert.equal(FIX.parseArgs(['--pr', '5', '--timeout-min', '40']).timeoutMs, 40 * 60_000);
  assert.equal(FIX.parseArgs(['--pr', '5', '--timeout-min', '3']).timeoutMs, 30 * 60_000, 'under 15 minutes falls back to the default');
  for (const bad of [['--pr', '5', '--use-credits'], ['--pr', '5', '--api-key', 'k'], ['--pr', '5', '--api-key=k'], ['--pr', '5', '--base-commit', 'abc'], ['--pr', 'x'], []]) {
    assert.throws(() => FIX.parseArgs(bad), undefined, bad.join(' '));
  }
});
