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
//   the checkout is not the PR head, or the reviewed commit is not an ancestor of HEAD,
//     and a billed CLI run still starts                                                -> CF10, CF11
//   an incomplete run prints a paste-ready line on stdout                              -> CF12
//   an unknown or missing finding severity prints clean                                -> CF13
//   a merge inside <from>..HEAD is not named, or the note breaks the stdout line the carry reads -> CF14, CF15
//   CLI spend (Dave, 2026-11-02; the CLI bills usage credits past the free hour with no prompt):
//   a free run writes a ledger row, or a billed run writes none or a wrong one                   -> CF24, CF25
//   a malformed usageCost counts as a charge                                                       -> CF26
//   the cap is reached and the run still starts, or the stop names no total and cap               -> CF27
//   under the cap, or with no cap, the run is blocked                                              -> CF28
//   an unreadable ledger with a cap lets the run go on, or a ledger write error breaks the line   -> CF29, CF30
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as FIX from './cr-fix.mjs';
import { parseCliFixReviews, carryBlockers, newestCodeRabbitRound } from './review-status.mjs';

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

// The GraphQL node review-status pairs with each REST issue comment (body, update stamp, edit history).
const gqlNode = (edits) => (c) => ({ databaseId: c.id, body: c.body, author: { login: 'coderabbitai', __typename: 'Bot' }, lastEditedAt: null, updatedAt: c.updated_at, userContentEdits: { nodes: edits[c.id] ?? [] } });

/** A harness: fake gh (reviews list), fake git head, fake cr runner. Records every call. */
function harness({ cap = null, ledgerRows = null, ledgerOverride = null, merges = [], reviews = [review(1, OLD, '2026-10-30T08:00:00Z')], comments = [], commentEdits = {}, head = HEAD, prHead = head, ancestor = true, run = { status: 0, stdout: ev(CONTEXT, DONE), stderr: '' }, ghError = null, commits = [] } = {}) {
  const calls = { gh: [], runs: [], writes: [], ancestor: [], merges: [] };
  // Never touch Dave's real paid ledger: every harness has its own temp file.
  const ledgerPath = ledgerOverride ?? path.join(mkdtempSync(path.join(os.tmpdir(), 'crfix-ledger-')), 'coderabbit-paid.jsonl');
  if (ledgerRows !== null) writeFileSync(ledgerPath, `${ledgerRows.join('\n')}\n`);
  const deps = {
    ledgerPath,
    cliCap: () => cap,
    branch: () => 'fix/x',
    answerKey: () => null,
    gh: (args) => {
      calls.gh.push(args);
      if (ghError) throw new Error(ghError);
      if (args.includes('graphql')) return { data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false }, nodes: comments.map(gqlNode(commentEdits)) } } } } };
      if (args.some((a) => /issues\/\d+\/comments/.test(a))) return comments;
      if (args.some((a) => /pulls\/\d+\/commits/.test(a))) return commits.map((sha) => ({ sha }));
      return args.some((a) => /pulls\/\d+$/.test(a)) ? { head: { sha: prHead } } : reviews;
    },
    isAncestor: (cwd, from) => { calls.ancestor.push(from); return ancestor; },
    headSha: () => head,
    mergesIn: (cwd, from) => { calls.merges.push(from); return merges; },
    runCr: async (spec) => { calls.runs.push(spec); return typeof run === 'function' ? run(spec) : run; },
    writeOut: (file, text) => { calls.writes.push({ file, text }); },
    now: NOW,
  };
  return { calls, deps, ledgerPath, go: (over = {}) => FIX.crFix({ pr: 219, repo: 'Rev4nchist/Continuous-Claude-v3', cwd: '/repo', ...over }, deps) };
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

test('CF-AK: a range with an answer-key path stops before the CLI starts (the guard of pre-pr.mjs, no run, no output file)', async () => {
  const h = harness();
  h.deps.answerKey = () => 'the diff holds an answer-key path (scripts/eval/review-eval/gold/g.json, 1 in all)';
  const r = await h.go();
  assert.equal(h.calls.runs.length, 0);
  assert.equal(r.exitCode, 2);
  assert.match(r.reason, /answer-key path/);
});

test('CF-AK2: with no stub the real guard is wired in and fails closed on a checkout git cannot read: no CLI run', async () => {
  const h = harness();
  delete h.deps.answerKey;
  const r = await h.go({ cwd: path.join(os.tmpdir(), 'crfix-no-such-dir') });
  assert.equal(h.calls.runs.length, 0);
  assert.equal(r.exitCode, 2);
  assert.match(r.reason, /could not check the diff/);
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

test('CF10: the PR head must be the checkout HEAD; a stale checkout, another branch or an unreadable PR head ends with exit 2 and starts no CLI run', async () => {
  const other = harness({ prHead: 'c'.repeat(40) });
  const r = await other.go();
  assert.equal(r.exitCode, 2);
  assert.equal(other.calls.runs.length, 0);
  assert.equal(r.line, null);
  assert.match(r.reason, /PR head/);
  assert.ok(other.calls.gh.some((a) => a.some((x) => /pulls\/219$/.test(x))), 'gh reads pulls/219');
  const upper = harness({ prHead: HEAD.toUpperCase() });
  assert.equal((await upper.go()).exitCode, 0, 'sha case does not matter');
  const none = harness({ prHead: '' });
  assert.equal((await none.go()).exitCode, 2, 'a PR with no head sha');
  assert.equal(none.calls.runs.length, 0);
});

test('CF11: the reviewed commit must be an ancestor of HEAD; a force-push or a missing commit ends with exit 2 and starts no CLI run', async () => {
  const h = harness({ ancestor: false });
  const r = await h.go();
  assert.equal(r.exitCode, 2);
  assert.equal(h.calls.runs.length, 0);
  assert.deepEqual(h.calls.ancestor, [OLD]);
  assert.match(r.reason, /ancestor/);
  const ok = harness();
  assert.equal((await ok.go()).exitCode, 0);
  assert.equal(ok.calls.runs.length, 1);
});

test('CF12: a finished run prints its line on stdout; an incomplete run prints nothing on stdout (stderr only)', async () => {
  const done = await harness().go();
  assert.deepEqual(FIX.reportOf(done).out, [done.line]);
  const inc = await harness({ run: { status: 1, stdout: ev(CONTEXT), stderr: 'x' } }).go();
  assert.equal(inc.verdict, 'incomplete');
  assert.deepEqual(FIX.reportOf(inc).out, [], 'no paste-ready line on stdout');
  assert.ok(FIX.reportOf(inc).err.some((l) => l.includes(inc.line)), 'the line is still shown on stderr');
  const stopped = await harness({ reviews: [] }).go();
  assert.deepEqual(FIX.reportOf(stopped).out, []);
});

test('CF13b: a finding with an empty, blank or non-string severity counts once, as major (not once as an unknown key and once as no severity)', async () => {
  const line = async (...findings) => (await harness({ run: { status: 0, stdout: ev(CONTEXT, ...findings, DONE), stderr: '' } }).go()).line;
  for (const severity of ['', '  ', 5, false, {}]) {
    assert.equal(await line({ ...finding('x'), severity }), 'CLI fix review: bbbbbbb..aaaaaaa 1 major', JSON.stringify(severity));
  }
  assert.equal(await line({ ...finding('x', 1), severity: '' }, { ...finding('x', 2), severity: undefined }, finding('high', 3)), 'CLI fix review: bbbbbbb..aaaaaaa 3 major', 'three findings read 3, not 4 or 5');
});

test('CF13: a finding with an unknown or missing severity counts as major, as in the PR review carry', async () => {
  const line = async (...findings) => (await harness({ run: { status: 0, stdout: ev(CONTEXT, ...findings, DONE), stderr: '' } }).go()).line;
  assert.equal(await line(finding('high')), 'CLI fix review: bbbbbbb..aaaaaaa 1 major');
  assert.equal(await line(finding('blocker', 1), finding('minor', 2)), 'CLI fix review: bbbbbbb..aaaaaaa 1 major');
  assert.equal(await line({ ...finding('x'), severity: undefined }), 'CLI fix review: bbbbbbb..aaaaaaa 1 major', 'no severity');
  assert.equal(await line({ ...finding('x'), severity: null }), 'CLI fix review: bbbbbbb..aaaaaaa 1 major', 'null severity');
  assert.equal(await line(finding('critical', 1), finding('high', 2)), 'CLI fix review: bbbbbbb..aaaaaaa 1 critical', 'critical still wins');
  assert.equal(await line(finding('Minor', 1), finding('TRIVIAL', 2), finding('info', 3), finding('none', 4)), 'CLI fix review: bbbbbbb..aaaaaaa clean', 'known severities in any case');
});

const MERGE = 'f'.repeat(40);

test('CF14: a merge commit inside <from>..HEAD is named on stderr; a range without one prints no merge note', async () => {
  const withMerge = harness({ merges: [MERGE] });
  const r = await withMerge.go();
  assert.deepEqual(withMerge.calls.merges, [OLD], 'merges are looked up in <from>..HEAD');
  assert.equal(r.exitCode, 0, 'a merge never refuses the run');
  assert.equal(withMerge.calls.runs.length, 1, 'the review still runs');
  const { err } = FIX.reportOf(r);
  assert.ok(err.some((l) => l.includes(MERGE.slice(0, 7)) && /merge/i.test(l)), `stderr names the merge sha: ${err.join(' | ')}`);
  const plain = await harness().go();
  assert.ok(!FIX.reportOf(plain).err.some((l) => /merge/i.test(l)), 'no merge, no note');
});

test('CF15: with a merge in the range the stdout line is unchanged and still reads as clean in review-status.mjs', async () => {
  const r = await harness({ merges: [MERGE, '9'.repeat(40)] }).go();
  const { out } = FIX.reportOf(r);
  assert.deepEqual(out, ['CLI fix review: bbbbbbb..aaaaaaa clean']);
  assert.deepEqual(parseCliFixReviews(out[0]), [{ from: 'bbbbbbb', head: 'aaaaaaa', verdict: 'clean' }]);
  const inc = FIX.reportOf(await harness({ merges: [MERGE], run: { status: 1, stdout: ev(CONTEXT), stderr: 'x' } }).go());
  assert.ok(inc.err.some((l) => l.includes(MERGE.slice(0, 7))), 'an incomplete run names the merge too');
});

test('CF16: gitMergesIn lists the merge commits of <from>..HEAD in a real repo, and none for a linear range', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cr-fix-merge-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    const commit = (f) => { writeFileSync(path.join(dir, f), f); git('add', f); git('commit', '-q', '-m', f); return git('rev-parse', 'HEAD'); };
    const base = commit('a');
    git('checkout', '-q', '-b', 'feat');
    commit('b');
    const linear = FIX.gitMergesIn(dir, base);
    assert.deepEqual(linear, [], 'a linear range holds no merge');
    git('checkout', '-q', 'main');
    commit('c');
    git('checkout', '-q', 'feat');
    git('merge', '-q', '--no-ff', '-m', 'merge main', 'main');
    commit('d');
    assert.deepEqual(FIX.gitMergesIn(dir, base), [git('rev-parse', 'HEAD~1')]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------
// Verifier round 2 (2026-10-30), item 1: cr-fix and review-status must pick the same carry source (newestCodeRabbitRound).
// Ways it can fail:
//   PR 213 shape (0 review objects, a clean summary comment): cr-fix stops "no CodeRabbit review"    -> CF17
//   an older review object A and a newer clean summary B: cr-fix prints A..head, which never matches -> CF18
//   a summary the carry does not trust (edited by a person) still picks the summary                  -> CF19
//   a clean summary of the head itself, or an unreadable comment read, starts a CLI run               -> CF20
// ---------------------------------------------------------------------------------------------
const SUMMARY_MARKER = '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->';
const BASE = 'e'.repeat(40);
// The live PR 213 summary shape, cut to what the reader uses: the marker, the clean sentence, the "between" line and the coverage marker.
const cleanSummary = (covered, at, id = 800) => ({
  id, user: CR_BOT, created_at: at, updated_at: at,
  body: `<!-- coderabbit-ai-generated:v1 -->\n\n${SUMMARY_MARKER}\n\nNo actionable comments were generated in the recent review.\n\n`
    + `Reviewing files that changed from the base of the PR and between ${BASE} and ${covered}.\n\n`
    + `<!-- final_review_risk_coverage:{"sourceCommitId":"${covered}","coveredCommitId":"${covered}","kind":"reviewed"} -->\n`,
});

/** The CLI fix review blockers of review-status for this source and this printed line (carryBlockers with all other inputs left out). */
function cliBlockers({ reviews, comments, commentEdits }, line) {
  const newest = newestCodeRabbitRound({ reviews, comments, commentEdits, head: HEAD });
  return carryBlockers({ head: HEAD, newest, body: line }).filter((b) => /CLI fix review/.test(b));
}

test('CF17: no review object, only a clean summary comment (live PR 213 shape): the range starts at the commit the summary covers', async () => {
  const comments = [cleanSummary(OLD, '2026-10-30T08:00:00Z')];
  const commentEdits = { 800: [] };
  const h = harness({ reviews: [], comments, commentEdits });
  const r = await h.go();
  assert.equal(r.exitCode, 0, r.reason ?? '');
  assert.deepEqual(h.calls.runs[0].args, ['review', '--agent', '--committed', '--base-commit', OLD]);
  assert.equal(r.line, 'CLI fix review: bbbbbbb..aaaaaaa clean');
  assert.deepEqual(parseCliFixReviews(r.line), [{ from: 'bbbbbbb', head: 'aaaaaaa', verdict: 'clean' }]);
  assert.deepEqual(cliBlockers({ reviews: [], comments, commentEdits }, r.line), [], 'review-status accepts the printed line for this source');
});

test('CF18: an older review object A and a newer clean summary B: the range starts at B, and review-status accepts that line, not an A line', async () => {
  const reviews = [review(1, OLDER, '2026-10-30T07:00:00Z')];
  const comments = [cleanSummary(OLD, '2026-10-30T08:00:00Z')];
  const commentEdits = { 800: [] };
  const h = harness({ reviews, comments, commentEdits });
  const r = await h.go();
  assert.equal(r.exitCode, 0, r.reason ?? '');
  assert.equal(r.from, OLD, 'B, the newer source');
  assert.deepEqual(cliBlockers({ reviews, comments, commentEdits }, r.line), []);
  assert.equal(cliBlockers({ reviews, comments, commentEdits }, `CLI fix review: ${OLDER.slice(0, 7)}..aaaaaaa clean`).length, 1, 'control: an A..head line does not match the source');
});

test('CF19: a summary the carry does not trust is not a source: the newest review object is', async () => {
  const reviews = [review(1, OLDER, '2026-10-30T07:00:00Z')];
  const comments = [cleanSummary(OLD, '2026-10-30T08:00:00Z')];
  const person = { 800: [{ editor: { login: 'someone', __typename: 'User' }, editedAt: '2026-10-30T08:30:00Z' }] };
  const h = harness({ reviews, comments, commentEdits: person });
  const r = await h.go();
  assert.equal(r.from, OLDER);
  assert.deepEqual(cliBlockers({ reviews, comments, commentEdits: { 800: person[800] } }, r.line), []);
});

test('CF20: a clean summary of the head itself leaves no fix commit; a failed comment read ends with exit 2 and starts no CLI run', async () => {
  const same = harness({ reviews: [], comments: [cleanSummary(HEAD, '2026-10-30T08:00:00Z')], commentEdits: { 800: [] } });
  const r = await same.go();
  assert.equal(r.exitCode, 2);
  assert.equal(same.calls.runs.length, 0);
  const failing = harness({ reviews: [review(1, OLD, '2026-10-30T08:00:00Z')] });
  const orig = failing.deps.gh;
  failing.deps.gh = (args) => { if (args.includes('graphql')) throw new Error('HTTP 502 graphql'); return orig(args); };
  const r2 = await failing.go();
  assert.equal(r2.exitCode, 2);
  assert.equal(failing.calls.runs.length, 0);
  assert.match(r2.reason, /HTTP 502 graphql/);
});

// ---------------------------------------------------------------------------------------------
// Verifier round 3 (2026-10-30): a head that already has a clean CodeRabbit summary needs no CLI run.
// Ways it can fail:
//   live PR #211 shape: review object R1 of an earlier head, a trusted clean summary that covers the head -> CF21
//   the stop also hits a summary the carry does not trust, which would hide a real fix range               -> CF21 (control)
// ---------------------------------------------------------------------------------------------
test('CF21: an older review object plus a trusted clean summary that covers the head (live PR #211 shape) ends with exit 2 and starts no CLI run', async () => {
  const reviews = [review(1, OLD, '2026-10-30T07:00:00Z')];
  const comments = [cleanSummary(HEAD, '2026-10-30T08:00:00Z')];
  const h = harness({ reviews, comments, commentEdits: { 800: [] } });
  const r = await h.go();
  assert.equal(r.exitCode, 2);
  assert.equal(h.calls.runs.length, 0, 'no CLI run is spent');
  assert.match(r.reason, /CodeRabbit already reviewed the head; no CLI run needed/);
  // Control: the same summary edited by a person is not trusted, so the head is not reviewed and the fix range is reviewed.
  const person = { 800: [{ editor: { login: 'someone', __typename: 'User' }, editedAt: '2026-10-30T08:30:00Z' }] };
  const control = harness({ reviews, comments, commentEdits: person });
  assert.equal((await control.go()).exitCode, 0);
  assert.equal(control.calls.runs.length, 1);
});

// ---------------------------------------------------------------------------------------------
// CodeRabbit CLI review of fix round (2026-10-30), item 2: more than 100 issue comments.
// Ways it can fail:
//   a second page of GraphQL comments is not read, so the summary on it is missing from the carry source      -> CF22
//   cr-fix throws on hasNextPage and cannot print a carry line on a long PR                                   -> CF22
//   an error on page 2 is swallowed: a partial comment set starts a billed CLI run                           -> CF23
// ---------------------------------------------------------------------------------------------
/** A fake gh that serves the GraphQL comments in pages of one node. `failOn` is the cursor whose page throws. */
function pagedGh(h, comments, commentEdits, { failOn = null } = {}) {
  const orig = h.deps.gh;
  const calls = [];
  h.deps.gh = (args) => {
    if (!args.includes('graphql')) return orig(args);
    const cursor = args.find((a) => /^c=/.test(a))?.slice(2) ?? null;
    calls.push(cursor);
    if (cursor !== null && cursor === failOn) throw new Error('HTTP 502 page 2');
    const at = cursor === null ? 0 : Number(cursor.slice(1));
    const node = gqlNode(commentEdits)(comments[at]);
    const last = at === comments.length - 1;
    return { data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: !last, endCursor: `C${at + 1}` }, nodes: [node] } } } } };
  };
  return calls;
}

test('CF22: a second page of GraphQL comments is read and merged: a clean summary on page 2 is the carry source', async () => {
  const reviews = [review(1, OLDER, '2026-10-30T07:00:00Z')];
  const filler = { id: 799, user: { login: 'someone', type: 'User' }, created_at: '2026-10-30T07:30:00Z', updated_at: '2026-10-30T07:30:00Z', body: 'thanks' };
  const comments = [filler, cleanSummary(OLD, '2026-10-30T08:00:00Z')];
  const h = harness({ reviews, comments });
  const edits = { 799: [], 800: [] };
  const cursors = pagedGh(h, comments, edits);
  const r = await h.go();
  assert.deepEqual(cursors, [null, 'C1'], 'page 1 has no cursor, page 2 uses the end cursor of page 1');
  assert.equal(r.exitCode, 0, r.reason ?? '');
  assert.equal(r.from, OLD, 'the summary on page 2 is the newer source');
  assert.equal(h.calls.runs.length, 1);
});

test('CF23: an error on page 2 of the GraphQL comments ends with exit 2 and starts no CLI run', async () => {
  const reviews = [review(1, OLDER, '2026-10-30T07:00:00Z')];
  const filler = { id: 799, user: { login: 'someone', type: 'User' }, created_at: '2026-10-30T07:30:00Z', updated_at: '2026-10-30T07:30:00Z', body: 'thanks' };
  const comments = [filler, cleanSummary(OLD, '2026-10-30T08:00:00Z')];
  const h = harness({ reviews, comments });
  pagedGh(h, comments, { 799: [], 800: [] }, { failOn: 'C1' });
  const r = await h.go();
  assert.equal(r.exitCode, 2);
  assert.equal(h.calls.runs.length, 0, 'no CLI run is spent');
  assert.match(r.reason, /HTTP 502 page 2/);
});

// Lane review-status-bugs, bug 2: the round order is the reviewed commit (the PR commit list), not the summary comment's updated_at.
// cr-fix must read the same list, or it prints a range review-status.mjs does not accept.
test('CF21: an older clean summary edited after a newer review object is not the source: the newer commit is, as in review-status', async () => {
  const reviews = [review(1, OLD, '2026-10-30T07:00:00Z')]; // OLD is the newer commit
  const comments = [cleanSummary(OLDER, '2026-10-30T09:00:00Z')]; // covers the older commit, edited last
  const commentEdits = { 800: [] };
  const commits = [OLDER, OLD, HEAD];
  const h = harness({ reviews, comments, commentEdits, commits });
  const r = await h.go();
  assert.equal(r.exitCode, 0, r.reason ?? '');
  assert.equal(r.from, OLD, 'the review of the newer commit');
  assert.deepEqual(h.calls.runs[0].args, ['review', '--agent', '--committed', '--base-commit', OLD]);
  assert.equal(newestCodeRabbitRound({ reviews, comments, commentEdits, head: HEAD, commits: commits.map((sha) => ({ sha })) }).commit_id, OLD, 'review-status names the same source');
});

// ---------- CLI spend log and daily cap ----------

const BILLED = { ...DONE, usageCost: { billedFilesCount: 2, costCents: 50, unitPriceCents: 25, billingMethod: 'usage_credits' } };
const ledgerRows = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const cliRow = (cost, date) => JSON.stringify({ ts: `${date}T10:00:00.000Z`, date, kind: 'cli', branch: 'feat/y', head: HEAD, files: 4, cost, session: 's' });
// NOW is 2026-10-30 09:00 local (the Chicago day of the paid ledger is read through deps.now below).
const TODAY = '2026-10-30';

test('CF24: a billed run writes one cli row, prints the cost on stderr only, and leaves the stdout line unchanged', async () => {
  const h = harness({ run: { status: 0, stdout: ev(CONTEXT, finding('minor'), BILLED), stderr: '' } });
  const r = await h.go();
  assert.equal(r.line, 'CLI fix review: bbbbbbb..aaaaaaa clean');
  assert.equal(r.exitCode, 0);
  const rows = ledgerRows(h.ledgerPath);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], ts: undefined, date: undefined, session: undefined }, { ts: undefined, date: undefined, kind: 'cli', branch: 'fix/x', head: HEAD, files: 2, cost: 0.5, session: undefined });
  const { out, err } = FIX.reportOf(r);
  assert.deepEqual(out, ['CLI fix review: bbbbbbb..aaaaaaa clean']);
  assert.ok(err.some((l) => /billed \$0\.50 \(usage credits\)/.test(l)), err.join('|'));
});

test('CF25: a free run writes no ledger row and prints no cost', async () => {
  const h = harness({ cap: 3 });
  const r = await h.go();
  assert.equal(r.exitCode, 0);
  assert.equal(existsSync(h.ledgerPath), false);
  assert.ok(!FIX.reportOf(r).err.some((l) => /billed/.test(l)));
});

test('CF26: a malformed usageCost (text, zero, negative) writes no row', async () => {
  for (const bad of [{ costCents: '50' }, { costCents: 0 }, { costCents: -25 }, 'x', []]) {
    const h = harness({ run: { status: 0, stdout: ev(CONTEXT, { ...DONE, usageCost: bad }), stderr: '' } });
    assert.equal((await h.go()).exitCode, 0);
    assert.equal(existsSync(h.ledgerPath), false, JSON.stringify(bad));
  }
});

test('CF27: at the cap the run stops with exit 2 before any CLI run, and the reason names the total and the cap', async () => {
  const h = harness({ cap: 3, ledgerRows: [cliRow(2, TODAY), cliRow(1, TODAY), cliRow(9, '2026-10-29')] });
  const r = await h.go();
  assert.equal(r.exitCode, 2);
  assert.equal(r.line, null);
  assert.match(r.reason, /cli-cap/);
  assert.match(r.reason, /\$3\.00/);
  assert.equal(h.calls.runs.length, 0);
  assert.deepEqual(FIX.reportOf(r).out, []);
});

test('CF28: under the cap the run goes ahead; with no cap a full or unreadable ledger does not stop it', async () => {
  const under = harness({ cap: 3, ledgerRows: [cliRow(2.75, TODAY)] });
  assert.equal((await under.go()).exitCode, 0);
  assert.equal(under.calls.runs.length, 1);
  const noCap = harness({ cap: null, ledgerRows: [cliRow(50, TODAY), 'not json'] });
  assert.equal((await noCap.go()).exitCode, 0);
  assert.equal(noCap.calls.runs.length, 1);
});

test('CF29: an unreadable ledger with a cap stops the run with exit 2 and starts no CLI run', async () => {
  const h = harness({ cap: 3, ledgerRows: ['not json'] });
  const r = await h.go();
  assert.equal(r.exitCode, 2);
  assert.match(r.reason, /ledger/i);
  assert.equal(h.calls.runs.length, 0);
});

test('CF30: a ledger that cannot be written leaves the line and exit code alone and adds a stderr note', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'crfix-ledgerdir-'));
  const h = harness({ ledgerOverride: dir, run: { status: 0, stdout: ev(CONTEXT, BILLED), stderr: '' } });
  const r = await h.go();
  assert.equal(r.line, 'CLI fix review: bbbbbbb..aaaaaaa clean');
  assert.equal(r.exitCode, 0);
  const { err } = FIX.reportOf(r);
  assert.ok(err.some((l) => /could not log/i.test(l) && /\$0\.50/.test(l)), err.join('|'));
});
