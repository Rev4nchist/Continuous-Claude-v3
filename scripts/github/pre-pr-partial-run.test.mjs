/**
 * Rule A of card prflow-cli-partial-run-rule: a partial CLI run that is dealt with earns the cap skip.
 * Own file: pre-pr.test.mjs is held by another lane. Real git repos, a fake CLI runner, the counter in its real shared folder.
 *
 * How the rule can fail, and the test that catches it (written before the code):
 *   - the row of a partial run has no partial fields, or holds finding text   -> PA1, PA12
 *   - partial is set for a timeout, an error, outcome failed or no record     -> PA2
 *   - the cap does not count earning rows                                     -> PA3
 *   - a finding counts as fixed with no line change (or never counts)         -> PA4
 *   - a missing position or an unreadable file counts as fixed                -> PA5
 *   - reviewed 0 earns                                                        -> PA6
 *   - a partial run becomes a PASS or SKIP                                    -> PA7
 *   - a row with no partial field earns                                       -> PA8
 *   - a run head that is not an ancestor earns                                -> PA9
 *   - earning changes the first or second run (read below the cap)            -> PA10
 *   - the body line is not checked, or checked when a finished run earns      -> PA11
 *   - the stamp lacks cr_partial_earned / cr_unreviewed_files                 -> PA11
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crPaths, finishedRuns, runCodeRabbit, runPrePr, STAMP_REL } from './pre-pr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CONFIG = JSON.parse(readFileSync(path.join(REPO_ROOT, 'review-router.config.json'), 'utf8'));
const REVIEW_MD = readFileSync(path.join(REPO_ROOT, 'REVIEW.md'), 'utf8');
// Never write Dave's real gate log or paid ledger.
process.env.PRE_PR_GATE_LOG = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-pa-gatelog-env-')), 'pre-pr-gates.jsonl');
const tmp = (prefix, file) => path.join(mkdtempSync(path.join(os.tmpdir(), prefix)), file);

// ---------- fixtures (the shapes of pre-pr.test.mjs, kept local: that file runs its tests on import) ----------

const ev = (...objs) => `${objs.map((o) => JSON.stringify(o)).join('\n')}\n`;
const CONTEXT = { type: 'review_context', workingDirectory: '/x', currentBranch: 'feat/x', baseBranch: 'main', expectedDuration: 120 };
const MAJOR = { type: 'finding', severity: 'major', fileName: 'src/a.ts', startLine: 10, endLine: 12, title: 'Null check missing', comment: 'c', codegenInstructions: 'fix it' };
const MINOR = { type: 'finding', severity: 'minor', fileName: 'src/b.ts', startLine: 3, endLine: 3, comment: 'rename this' };
const DONE = { type: 'complete', status: 'review_completed', findings: 2, outcome: 'completed' };
const USAGE_OK = ev({ type: 'usage', remaining: 5, fullCapacityInMs: 0 });
const NDJSON_OK = ev(CONTEXT, MAJOR, MINOR, DONE);

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo({ files = { 'docs/a.md': 'hello\n' } } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prepr-pa-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, '.gitignore'), '.claude/cache/\n');
  writeFileSync(path.join(dir, 'README.md'), 'root\n');
  writeFileSync(path.join(dir, 'REVIEW.md'), REVIEW_MD); // the answer-key guard reads it from the root
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/x');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'work');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

const makeGitFn = (root) => (args) => {
  try { return { status: 0, stdout: execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }; } catch (e) { return { status: e.status ?? 1, stdout: '', stderr: String(e.stderr ?? '') }; }
};

/** Options of one runCodeRabbit call in a real repo. */
function crInRepo(repo, runner, extra = {}) {
  return { root: repo.dir, branch: 'feat/x', head: repo.head, base: 'main', now: new Date('2026-10-27T10:00:00Z'), runner, ledgerPath: tmp('prepr-pa-ledger-', 'coderabbit-paid.jsonl'), headGit: makeGitFn(repo.dir), crStore: null, guardPaths: ['src/clean.mjs'], ...extra };
}

const NO_ENV = ({ gates }) => ({ fail: null, others: [], note: null, blocked: new Set(), gates });
const SUMMARY_OK = () => ({ result: { step: 'summary', status: 'PASS', detail: 'stub summary', notes: [] }, sha: 'a'.repeat(64), ok: true });
const okExec = () => () => ({ status: 0, stdout: 'ran\nTests  1 passed (1)\n', stderr: '' });

async function prePr(repo, extra = {}) {
  const crCalls = [];
  const crRunner = extra.crRunner ?? ((o) => (o.args[0] === 'usage' ? { status: 0, stdout: USAGE_OK, stderr: '' } : { status: 0, stdout: NDJSON_OK, stderr: '' }));
  const opts = {
    root: repo.dir, base: 'main', config: CONFIG, now: new Date(), exec: okExec(), fetch: () => null, guardLog: () => {}, envCheck: NO_ENV,
    ledgerPath: tmp('prepr-pa-ledger-', 'coderabbit-paid.jsonl'), crStore: null, gateLogPath: tmp('prepr-pa-gatelog-', 'pre-pr-gates.jsonl'),
    osvLockfiles: [], findOsv: () => null, findPssa: () => null, summaryCheck: SUMMARY_OK, bodyText: 'Proof type: docs\n', ...extra,
    crRunner: (o) => { if (o.args[0] !== 'usage') crCalls.push(o); return crRunner(o); },
  };
  return { result: await runPrePr(opts), crCalls };
}
const crStep = (run) => run.result.results.find((x) => x.step === 'coderabbit');

// ---------- the counter and the partial rows ----------

const PA_LINES = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');
const paRepo = () => makeRepo({ files: { 'src/a.ts': PA_LINES(20), 'docs/a.md': 'hello\n' } });
const paCounter = (repo) => crPaths(repo.dir, 'feat/x').counter;
const paRead = (repo) => JSON.parse(readFileSync(paCounter(repo), 'utf8'));
function paSeed(repo, runs) {
  mkdirSync(path.dirname(paCounter(repo)), { recursive: true });
  writeFileSync(paCounter(repo), JSON.stringify({ branch: 'feat/x', runs }));
}
const PA_AT = '2026-10-27T09:00:00Z';
/** A counter row of a failed run: what pre-pr writes today, with no partial field. */
const paPlain = (head, over = {}) => ({ head, at: PA_AT, outcome: 'failed', complete: false, newCode: true, ...over });
/** A counter row of a partial run, with every field the rule writes. */
const paPartial = (head, over = {}) => paPlain(head, { partial: true, reviewed: 3, unreviewed: 2, findings: [], ...over });
const PA_FILLER = paPlain('f'.repeat(40));
/** A complete record with unreviewed files. */
const paDone = (extra = {}) => ({ ...DONE, outcome: 'completed_with_warnings', unreviewedFileCount: 2, reviewedFiles: ['a', 'b', 'c'], ...extra });
const paStream = (...objs) => ({ status: 0, stdout: ev(CONTEXT, ...objs), stderr: '' });
const withUsage = (out) => (o) => (o.args[0] === 'usage' ? { status: 0, stdout: USAGE_OK, stderr: '' } : out);

/** Commits a change to one line of src/a.ts and returns the new head. */
function paChangeLine(repo, n) {
  const lines = readFileSync(path.join(repo.dir, 'src', 'a.ts'), 'utf8').split('\n');
  lines[n - 1] = `line ${n} CHANGED`;
  writeFileSync(path.join(repo.dir, 'src', 'a.ts'), lines.join('\n'));
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', `change line ${n}`);
  return git(repo.dir, 'rev-parse', 'HEAD');
}

/** Seeds the counter and calls the step at `head`. Two counted rows: the cap is reached, so no CLI call may happen. */
async function paAtCap(repo, rows, head) {
  paSeed(repo, rows);
  const calls = [];
  const runner = (o) => { calls.push(o.args[0]); return { status: 0, stdout: o.args[0] === 'usage' ? USAGE_OK : NDJSON_OK, stderr: '' }; };
  const r = await runCodeRabbit(crInRepo(repo, runner, { head }));
  assert.equal(r.skipReason, 'cap', r.detail);
  assert.deepEqual(calls, [], 'the cap spends no run');
  return r;
}

// ---------- tests ----------

test('PA1: a partial record writes partial, reviewed, unreviewed and finding positions to the row', async () => {
  // Breaks when: reviewUnderLock does not write the partial fields on the run row (today it writes only outcome and complete).
  const repo = paRepo();
  const r = await runCodeRabbit(crInRepo(repo, withUsage(paStream(MAJOR, MINOR, paDone()))));
  assert.equal(r.status, 'FAIL');
  const row = paRead(repo).runs.at(-1);
  assert.equal(row.partial, true);
  assert.equal(row.reviewed, 3, 'the length of reviewedFiles');
  assert.equal(row.unreviewed, 2);
  assert.deepEqual(row.findings, [{ file: 'src/a.ts', start: 10, end: 12 }, { file: 'src/b.ts', start: 3, end: 3 }]);
  assert.equal(row.complete, false);
  // No reviewedFiles: the changed-path count minus the unreviewed count. Neither known: 0.
  for (const [paths, want] of [[['a', 'b', 'c', 'd', 'e'], 3], [null, 0]]) {
    const again = paRepo();
    const rr = await runCodeRabbit(crInRepo(again, withUsage(paStream(paDone({ reviewedFiles: undefined }))), { changedPaths: paths }));
    assert.equal(rr.status, 'FAIL');
    assert.equal(paRead(again).runs.at(-1).reviewed, want, JSON.stringify(paths));
  }
});

test('PA2: a timeout, an error event, outcome failed, exit 2, an awaiting status or a missing record write no partial field', async () => {
  // Breaks when: partial is set from unreviewedFileCount alone, without the error, exit, outcome and record checks.
  const cases = {
    timeout: { status: null, stdout: ev(CONTEXT, paDone()), stderr: '', timedOut: true },
    'error event': paStream({ type: 'error', errorType: 'server', message: 'boom' }, paDone()),
    'outcome failed': paStream(paDone({ outcome: 'failed' })),
    'exit 2': { status: 2, stdout: ev(CONTEXT, paDone()), stderr: '' },
    awaiting: paStream({ type: 'status', status: 'awaiting_confirmation' }, paDone()),
    'no record': paStream(MAJOR),
    'zero unreviewed': paStream(paDone({ unreviewedFileCount: 0 })),
    'non-integer unreviewed': paStream(paDone({ unreviewedFileCount: 2.5 })),
  };
  for (const [name, out] of Object.entries(cases)) {
    const repo = paRepo();
    await runCodeRabbit(crInRepo(repo, withUsage(out)));
    const row = paRead(repo).runs.at(-1);
    assert.equal(row.partial, undefined, name);
    assert.equal('reviewed' in row || 'unreviewed' in row || 'findings' in row, false, name);
  }
  // The control: exit 1 is allowed (the real CLI exits 1 on some complete runs) and still writes the partial row.
  const one = paRepo();
  await runCodeRabbit(crInRepo(one, withUsage({ status: 1, stdout: ev(CONTEXT, paDone()), stderr: '' })));
  assert.equal(paRead(one).runs.at(-1).partial, true);
});

test('PA3: at the cap, partial rows with no findings and reviewed >= 1 give partialEarned and the largest unreviewed count', async () => {
  // Breaks when: the cap branch does not count earning rows (no partialEarned / unreviewedFiles on the cap step).
  const repo = paRepo();
  const one = await paAtCap(repo, [paPartial(repo.head), PA_FILLER], repo.head);
  assert.equal(one.partialEarned, 1);
  assert.equal(one.unreviewedFiles, 2);
  const two = await paAtCap(repo, [paPartial(repo.head, { unreviewed: 7 }), paPartial(repo.head, { unreviewed: 4 })], repo.head);
  assert.equal(two.partialEarned, 2);
  assert.equal(two.unreviewedFiles, 7, 'the largest of the earning rows');
  const none = await paAtCap(repo, [PA_FILLER, PA_FILLER], repo.head);
  assert.equal(none.partialEarned, 0);
  assert.equal(none.unreviewedFiles, 0);
});

test('PA4: a finding whose lines changed in a later commit earns; one with untouched lines (a false finding left as is) does not', async () => {
  // Breaks when: the earn check skips the git diff old-side overlap (a row with findings would earn with no fix, or never).
  const repo = paRepo();
  const finding = { file: 'src/a.ts', start: 10, end: 12 };
  const row = paPartial(repo.head, { findings: [finding] });
  const untouched = paChangeLine(repo, 18);
  assert.equal((await paAtCap(repo, [row, PA_FILLER], untouched)).partialEarned, 0, 'line 18 is outside 10-12');
  const fixed = paChangeLine(repo, 11);
  assert.equal((await paAtCap(repo, [row, PA_FILLER], fixed)).partialEarned, 1, 'line 11 is inside 10-12');
  // Two findings: every one must be fixed.
  const both = paPartial(repo.head, { findings: [finding, { file: 'src/a.ts', start: 2, end: 2 }] });
  assert.equal((await paAtCap(repo, [both, PA_FILLER], fixed)).partialEarned, 0, 'line 2 never changed');
  // A head with no change since the run fixes nothing.
  assert.equal((await paAtCap(repo, [paPartial(fixed, { findings: [finding] }), PA_FILLER], fixed)).partialEarned, 0);
});

test('PA5: a finding with no file, no line or an unreadable file does not earn', async () => {
  // Breaks when: a missing position or a failed git read counts as fixed (fail open).
  const repo = paRepo();
  const head = paChangeLine(repo, 11);
  const bad = [
    [{ file: null, start: 10, end: 12 }], [{ start: 10, end: 12 }], [{ file: '', start: 10, end: 12 }], [{ file: '?', start: 10, end: 12 }],
    [{ file: 'src/a.ts', start: null, end: null }], [{ file: 'src/a.ts' }], [{ file: 'src/a.ts', start: 'ten', end: 12 }], [{}],
    [{ file: 'src/does-not-exist.ts', start: 1, end: 1 }], [{ file: 'docs/a.md', start: 1, end: 1 }],
  ];
  for (const findings of bad) {
    assert.equal((await paAtCap(repo, [paPartial(repo.head, { findings }), PA_FILLER], head)).partialEarned, 0, JSON.stringify(findings));
  }
  const noList = paPartial(repo.head);
  delete noList.findings;
  assert.equal((await paAtCap(repo, [noList, PA_FILLER], head)).partialEarned, 0, 'a row with no findings list');
  // The control: the same shape with a real position earns, so the cases above fail for their own reason.
  assert.equal((await paAtCap(repo, [paPartial(repo.head, { findings: [{ file: 'src/a.ts', start: 11, end: 11 }] }), PA_FILLER], head)).partialEarned, 1);
});

test('PA6: a partial row with reviewed 0 (or a missing or non-integer reviewed) does not earn', async () => {
  // Breaks when: the reviewed >= 1 rule is dropped.
  const repo = paRepo();
  for (const reviewed of [0, -1, '3', 1.5, null, undefined]) {
    assert.equal((await paAtCap(repo, [paPartial(repo.head, { reviewed }), PA_FILLER], repo.head)).partialEarned, 0, String(reviewed));
  }
  assert.equal((await paAtCap(repo, [paPartial(repo.head, { reviewed: 1 }), PA_FILLER], repo.head)).partialEarned, 1);
});

test('PA7: a partial run is still a FAIL step, never a PASS or a SKIP (N3 stays)', async () => {
  // Breaks when: the verdict of a complete record with unreviewed files becomes PASS or SKIP.
  const repo = paRepo();
  const r = await runCodeRabbit(crInRepo(repo, withUsage(paStream(paDone()))));
  assert.equal(r.status, 'FAIL');
  assert.match(r.detail, /INCOMPLETE/);
  assert.equal(r.skipReason, undefined);
  assert.equal(finishedRuns(repo.dir, 'feat/x'), 0, 'a partial run is not a finished run');
});

test('PA8: a row with no partial field never earns, even with every other field', async () => {
  // Breaks when: the earn check reads reviewed/unreviewed/findings without requiring partial === true (the rows today\'s pre-pr wrote must never earn).
  const repo = paRepo();
  const { partial, ...noFlag } = paPartial(repo.head);
  void partial;
  for (const row of [noFlag, paPartial(repo.head, { partial: 'true' }), paPartial(repo.head, { partial: 1 }), paPlain(repo.head)]) {
    assert.equal((await paAtCap(repo, [row, PA_FILLER], repo.head)).partialEarned, 0, JSON.stringify(row));
  }
});

test('PA9: a run head that is not an ancestor of the head, or not a commit, never earns', async () => {
  // Breaks when: the merge-base --is-ancestor check is dropped or a failed check counts as earned.
  const repo = paRepo();
  git(repo.dir, 'checkout', '-q', '-b', 'side', 'main');
  writeFileSync(path.join(repo.dir, 'side.txt'), 'side\n');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'side');
  const side = git(repo.dir, 'rev-parse', 'HEAD');
  git(repo.dir, 'checkout', '-q', 'feat/x');
  for (const runHead of [side, 'b'.repeat(40), 'not-a-sha', '', undefined]) {
    assert.equal((await paAtCap(repo, [paPartial(runHead), PA_FILLER], repo.head)).partialEarned, 0, String(runHead));
  }
  assert.equal((await paAtCap(repo, [paPartial(repo.head), PA_FILLER], repo.head)).partialEarned, 1, 'the control: an ancestor earns');
});

test('PA10: below the cap one partial run causes no skip and a second run is allowed; earning is read only at the cap', async () => {
  // Breaks when: an earning partial row makes the first or second run a skip.
  const repo = paRepo();
  const calls = [];
  const runner = (o) => { if (o.args[0] === 'usage') return { status: 0, stdout: USAGE_OK, stderr: '' }; calls.push(o); return paStream(paDone()); };
  const first = await runCodeRabbit(crInRepo(repo, runner));
  assert.equal(first.status, 'FAIL');
  const second = await runCodeRabbit(crInRepo(repo, runner));
  assert.equal(second.status, 'FAIL', 'the second run still runs the CLI');
  assert.equal(second.skipReason, undefined);
  assert.equal(calls.length, 2);
  const third = await runCodeRabbit(crInRepo(repo, runner));
  assert.equal(third.skipReason, 'cap');
  assert.equal(third.partialEarned, 2, 'both runs earn at the cap (no findings, reviewed 3)');
  assert.equal(calls.length, 2);
});

// The whole run: real git, fake CLI. The stamp fields and the PR body line.
const paEveStream = (text) => paStream({ ...MAJOR, fileName: 'docs/a.md', startLine: 1, endLine: 1, title: text, comment: `${text} comment`, codegenInstructions: `${text} fix` }, paDone({ unreviewedFileCount: 3 }));
const paBody = (n) => `Proof type: docs\n${n === undefined ? '' : `CLI unreviewed files: ${n}\n`}`;

/** Two partial runs on one head, then a commit that changes the finding's line: the next pre-pr is at the cap with a fixed finding. */
async function paCappedByPartial(text) {
  const repo = makeRepo();
  const crRunner = withUsage(paEveStream(text));
  for (let i = 0; i < 2; i += 1) {
    const run = await prePr(repo, { crRunner });
    assert.equal(crStep(run).status, 'FAIL', crStep(run).detail);
  }
  writeFileSync(path.join(repo.dir, 'docs', 'a.md'), 'hello fixed\n');
  git(repo.dir, 'add', '.');
  git(repo.dir, 'commit', '-q', '-m', 'fix the finding');
  return { repo, crRunner };
}

test('PA11: at a cap earned by a partial run, the PR body needs one "CLI unreviewed files: <n>" line with the right count', async () => {
  // Breaks when: pre-pr does not check the body line (a missing or wrong count passes), checks it when a finished run earns, or the stamp lacks the two fields.
  const { repo, crRunner } = await paCappedByPartial('finding text');
  const missing = await prePr(repo, { crRunner, bodyText: paBody() });
  assert.equal(crStep(missing).skipReason, 'cap');
  assert.equal(missing.result.ok, false, missing.result.lines.join('\n'));
  assert.match(missing.result.results.find((r) => r.status === 'FAIL').detail, /CLI unreviewed files: 3/);
  const wrong = await prePr(repo, { crRunner, bodyText: paBody(2) });
  assert.equal(wrong.result.ok, false);
  assert.match(wrong.result.results.find((r) => r.status === 'FAIL').detail, /CLI unreviewed files/);
  const right = await prePr(repo, { crRunner, bodyText: paBody(3) });
  assert.equal(right.result.ok, true, right.result.lines.join('\n'));
  const stamp = JSON.parse(readFileSync(path.join(repo.dir, STAMP_REL), 'utf8'));
  assert.equal(stamp.cr_skip_reason, 'cap');
  assert.equal(stamp.cr_finished_runs, 0);
  assert.equal(stamp.cr_partial_earned, 2);
  assert.equal(stamp.cr_unreviewed_files, 3);
  assert.equal(right.crCalls.length, 0, 'the cap spends no run');
  // An earn by a finished run needs no line, even with an earning partial row beside it.
  const done = makeRepo();
  paSeed(done, [paPlain(done.head, { outcome: 'finished', complete: true }), paPartial(done.head), PA_FILLER]);
  const byFinished = await prePr(done, { bodyText: 'Proof type: docs\n' });
  assert.equal(byFinished.result.ok, true, byFinished.result.lines.join('\n'));
  const second = JSON.parse(readFileSync(path.join(done.dir, STAMP_REL), 'utf8'));
  assert.equal(second.cr_finished_runs, 1);
  assert.equal(second.cr_skip_reason, 'cap');
});

test('PA12: the counter and the stamp hold positions and counts only, no finding text', async () => {
  // Breaks when: the row or the stamp copies a finding's title, comment or codegenInstructions.
  const text = 'SECRET-FINDING-TEXT-7731';
  const { repo, crRunner } = await paCappedByPartial(text);
  const run = await prePr(repo, { crRunner, bodyText: paBody(3) });
  assert.equal(run.result.ok, true, run.result.lines.join('\n'));
  const counterText = readFileSync(paCounter(repo), 'utf8');
  assert.match(counterText, /"partial": true/, 'the rows are partial (the control for the search below)');
  assert.match(counterText, /docs\/a\.md/, 'positions are kept');
  assert.equal(counterText.includes(text), false, 'counter');
  const stampText = readFileSync(path.join(repo.dir, STAMP_REL), 'utf8');
  assert.equal(stampText.includes(text), false, 'stamp');
  assert.equal(existsSync(path.join(repo.dir, STAMP_REL)), true);
});

// Round 1 of the CodeRabbit CLI review of pre-pr.mjs (15b4a114): three holes in the earn rule.

test('PA13: a finding file name with git pathspec magic counts as a literal path, never as fixed', async () => {
  // Breaks when: findingFixed passes the file name to git as a pathspec (":(top)src/a.ts" and "src/*.ts" match the changed file).
  const repo = paRepo();
  const head = paChangeLine(repo, 11);
  for (const file of [':(top)src/a.ts', ':/src/a.ts', 'src/*.ts', ':(glob)src/**', ':(icase)SRC/A.TS']) {
    const row = paPartial(repo.head, { findings: [{ file, start: 11, end: 11 }] });
    assert.equal((await paAtCap(repo, [row, PA_FILLER], head)).partialEarned, 0, file);
  }
  // The control: the literal name of the same changed file earns, so the cases above fail for their own reason.
  assert.equal((await paAtCap(repo, [paPartial(repo.head, { findings: [{ file: 'src/a.ts', start: 11, end: 11 }] }), PA_FILLER], head)).partialEarned, 1);
});

test('PA14: a stream with a line that is not JSON writes no partial field (the stream may have lost a finding)', async () => {
  // Breaks when: partialRowOf ignores parsed.unparsed (a lost finding line would leave the row with fewer findings, so it could earn).
  const repo = paRepo();
  const lost = { status: 0, stdout: `${ev(CONTEXT, MAJOR)}this line is not json\n${ev(paDone())}`, stderr: '' };
  const r = await runCodeRabbit(crInRepo(repo, withUsage(lost)));
  assert.equal(r.status, 'FAIL');
  const row = paRead(repo).runs.at(-1);
  assert.equal(row.partial, undefined);
  assert.equal('reviewed' in row || 'unreviewed' in row || 'findings' in row, false);
  // The control: the same stream without the bad line writes the partial row.
  const clean = paRepo();
  await runCodeRabbit(crInRepo(clean, withUsage(paStream(MAJOR, paDone()))));
  assert.equal(paRead(clean).runs.at(-1).partial, true);
});

test('PA15: a user git setting that merges hunks (diff.interHunkContext) cannot make an untouched finding line count as fixed', async () => {
  // Breaks when: the findingFixed diff does not pass --inter-hunk-context=0 (two far changes merge into one hunk that covers line 15).
  const repo = paRepo();
  git(repo.dir, 'config', 'diff.interHunkContext', '10');
  paChangeLine(repo, 11);
  const head = paChangeLine(repo, 19);
  const row = paPartial(repo.head, { findings: [{ file: 'src/a.ts', start: 15, end: 15 }] });
  assert.equal((await paAtCap(repo, [row, PA_FILLER], head)).partialEarned, 0, 'line 15 was never changed');
  const near = paPartial(repo.head, { findings: [{ file: 'src/a.ts', start: 19, end: 19 }] });
  assert.equal((await paAtCap(repo, [near, PA_FILLER], head)).partialEarned, 1, 'the control: line 19 was changed');
});
