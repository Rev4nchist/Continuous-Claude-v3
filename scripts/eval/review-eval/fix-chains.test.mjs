// Tests for scripts/eval/review-eval/fix-chains.mjs: the CodeRabbit-free escape miner.
// Everything runs on synthetic temp git repos with a fake gh. No network, no live state dir.
// Run: node --test scripts/eval/review-eval/fix-chains.test.mjs
//
// Failure modes and the change that would break each test:
//   F1  the PR list reads the wrong merges, the wrong order, or a wrong range
//                                         -> drop --first-parent, sort newest first, or slice the range by PR number
//   F2  a fix subject is missed, or a feat/docs/merge subject counts      -> change FIX_RE
//   F3  removed-line ranges are wrong (pure additions, "-- a/x" lines)    -> change removedRanges, or read ---/+++ as hunk lines
//   F4  a planted fix commit gives no row, or the wrong blamed PR         -> blame at the fix commit instead of its parent, or drop the gh step
//   F5  a fix in a line no PR in the window changed (T19) gives a row     -> keep PRs outside the window or with no PR
//   F6  a fix of the PR's own new lines gives a row, or counts as no-target -> drop the own-range filter
//   F7  a pure-addition fix is blamed or has the wrong reason             -> blame added lines
//   F8  30 days is in, 31 days is out                                     -> change the window compare
//   F9  gh or git failure is read as "no escape"                          -> swallow the error as outside-window
//   F10 a PR with no fix commit is walked or counted                      -> drop the isFixSubject filter
//   F11 gh is called twice for one sha                                    -> drop the prOfSha cache
//   F12 two blamed PRs give one row, or one blamed PR gives two           -> change the per-blamedPr grouping
//   F13 the fix PR itself is taken as its own cause                       -> drop `p.number !== pr`
//   F14 the band is not read from the blamed PR, or UNKNOWN is not the fallback -> change bandOfPr
//   F15 the cause is not computed from the fix files before the write     -> drop classifyCause or pass the wrong files
//   F16 writeRows adds a row twice, or kills the file on a damaged line   -> change the key or the reader
//   F17 the baseline counts rows of another band, or misses a band        -> change buildBaseline
//   F18 no args or --help walk git or gh                                  -> parse args after the walk
//   F19 a dry run writes a state file; --write does not write; a re-run adds rows
//                                         -> change main()
//   F20 the CLI writes the live state dir, or reads USERPROFILE for the default -> resolve the dir at module load
//   F21 a bad range or unknown flag does not exit 2                       -> change main()
//   F22 the totals miss the no-target count (T19)                         -> change the totals
//   F23 a re-indent PR takes the blame from the PR that wrote the line    -> drop -w from git blame
//   F24 the baseline window is the whole range, or mining stops at the window end -> ignore --window-to-sha, or slice the PRs before mining
//   F25 an unknown --window-to-sha is read as "no window"                 -> return the whole range when the sha is not found
//   F26 the baseline counts non-primary rows, or drops old rows with no primary field -> change the primary filter in buildBaseline
//   F27 a diff or blame failure reads as no-removed-lines, own-PR-only or outside-window -> drop the failure counters in reasonOf
//   F28 a PR git cannot read counts as a fix PR or a reason                -> return noTarget blame-failed from the catch-all
//   F29 primary follows the PR number, or a tie goes to the lower number   -> change pickPrimary
//   F30 a stacked PR (not a main merge) is blamed, or the latest of several is kept -> drop the main-merge filter or the earliest rule
//   F31 the diff path shifts under diff.noprefix                           -> drop --src-prefix/--dst-prefix
//   F32 a failed gh call is repeated for the same sha                      -> cache only successes
//   F33 a 64-digit blame sha is not read                                   -> fix the sha pattern at 40 digits
//   F34 --write --baseline works with no --window-to-sha                   -> drop the check in checkArgs
//   F35 --ref is ignored, head is not printed or not in the json           -> drop --ref or the head line
//   F36 the CLI baseline line hides the all-row count                      -> change printRun
//   F3b/F3c  no-newline marks, deleted file, rename, CRLF, tab suffix, C-quoted paths -> change removedRanges or oldPathOf
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import {
  buildBaseline, escapesForPr, isFixSubject, listMergedPrs, loadRouterConfig, main, makeGit, readMerges, removedRanges, rowsLeftOut, writeBaseline, writeRows,
} from './fix-chains.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const made = [];
const tmp = (label = 'fc') => { const d = mkdtempSync(path.join(os.tmpdir(), `fix-chains-${label}-`)); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

// ---------- a synthetic repo: PRs are merge commits on main, as on GitHub ----------

const EMPTY_CFG = path.join(tmp('cfg'), 'gitconfig');
writeFileSync(EMPTY_CFG, '');
const sh = (dir, args, at) => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: EMPTY_CFG, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir, env, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
};
const lines = (...xs) => `${xs.join('\n')}\n`;

/**
 * steps: [{ direct: { at, subject, files } } | { n, at, commits: [{ subject, files }] }], applied in this order.
 * Returns { dir, git, prs: { n: { mergeSha, shas } }, pullsOf(sha) }.
 */
function build(steps) {
  const dir = tmp('repo');
  sh(dir, ['init', '-q', '-b', 'main'], '2025-12-01T00:00:00Z');
  put(dir, { 'README.md': 'x\n' });
  sh(dir, ['add', '-A'], '2025-12-01T00:00:00Z');
  sh(dir, ['commit', '-q', '-m', 'chore: init'], '2025-12-01T00:00:00Z');
  const prs = {};
  const byBranchSha = {};
  for (const s of steps) {
    if (s.config) { sh(dir, ['config', ...s.config], '2025-12-01T00:00:00Z'); continue; }
    if (s.direct) { put(dir, s.direct.files); sh(dir, ['add', '-A'], s.direct.at); sh(dir, ['commit', '-q', '-m', s.direct.subject], s.direct.at); continue; }
    sh(dir, ['checkout', '-q', '-b', `pr${s.n}`, 'main'], s.at);
    const shas = s.commits.map((c) => {
      for (const gone of c.remove ?? []) rmSync(path.join(dir, gone));
      put(dir, c.files);
      sh(dir, ['add', '-A'], s.at);
      sh(dir, ['commit', '-q', '-m', c.subject], s.at);
      return sh(dir, ['rev-parse', 'HEAD'], s.at);
    });
    sh(dir, ['checkout', '-q', 'main'], s.at);
    sh(dir, ['merge', '-q', '--no-ff', '-m', `Merge pull request #${s.n} from x/pr${s.n}`, `pr${s.n}`], s.at);
    const mergeSha = sh(dir, ['rev-parse', 'HEAD'], s.at);
    prs[s.n] = { mergeSha, shas };
    for (const sha of shas) byBranchSha[sha] = [{ number: s.n, merged_at: s.at, merge_commit_sha: mergeSha }];
  }
  return { dir, git: makeGit(dir), prs, byBranchSha };
}

/** A fake gh: maps a commit sha to the PRs of its branch, like repos/<repo>/commits/<sha>/pulls. Records the calls. */
function fakeGh(built, { fail = false, override } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    if (fail) throw new Error('gh: network down');
    const sha = /commits\/([0-9a-f]+)\/pulls$/.exec(args[1])?.[1];
    return override ? override(sha) : (built.byBranchSha[sha] ?? []);
  };
  return Object.assign(gh, { calls });
}

const infoOf = (built, n) => listMergedPrs({ git: built.git }).find((p) => p.pr === n);
const CFG = loadRouterConfig();
const run = (built, n, over = {}) => escapesForPr(infoOf(built, n), { git: built.git, gh: fakeGh(built), repo: 'o/r', routerConfig: CFG, ...over });

const A_DAY = '2026-01-10T12:00:00Z';
const B_DAY = '2026-01-11T12:00:00Z';
const planted = (over = {}) => build([
  { n: 1, at: A_DAY, commits: [{ subject: 'feat: add f', files: { 'src/f.txt': lines('alpha', 'buggy', 'omega') } }] },
  { n: 2, at: B_DAY, commits: [{ subject: 'fix: correct f', files: { 'src/f.txt': lines('alpha', 'fixed', 'omega') } }], ...over },
]);

// ---------- F1 to F3: pure helpers ----------

test('F1: listMergedPrs reads first-parent PR merges, oldest first, and slices a range by position (breaks if --first-parent, the order or the slice is wrong)', () => {
  const b = build([
    { n: 3, at: '2026-01-02T00:00:00Z', commits: [{ subject: 'feat: c', files: { 'c.txt': 'c\n' } }] },
    { n: 2, at: '2026-01-03T00:00:00Z', commits: [{ subject: 'feat: b', files: { 'b.txt': 'b\n' } }] },
    { direct: { at: '2026-01-03T06:00:00Z', subject: "Merge branch 'side'", files: { 'd.txt': 'd\n' } } },
    { n: 5, at: '2026-01-04T00:00:00Z', commits: [{ subject: 'feat: e', files: { 'e.txt': 'e\n' } }] },
  ]);
  const all = listMergedPrs({ git: b.git });
  assert.deepEqual(all.map((p) => p.pr), [3, 2, 5], 'merge order, not number order; the non-PR commit is skipped');
  assert.equal(all[0].mergeSha, b.prs[3].mergeSha);
  assert.equal(all[0].base, `${b.prs[3].mergeSha}^1`);
  assert.equal(all[0].head, `${b.prs[3].mergeSha}^2`);
  assert.match(all[0].mergedAt, /^2026-01-02T00:00:00/);
  assert.deepEqual(listMergedPrs({ git: b.git, fromPr: 3, toPr: 2 }).map((p) => p.pr), [3, 2]);
  assert.deepEqual(listMergedPrs({ git: b.git, fromPr: 2, toPr: 5 }).map((p) => p.pr), [2, 5]);
  assert.deepEqual(listMergedPrs({ git: b.git, since: '2026-01-02T12:00:00Z', until: '2026-01-03T12:00:00Z' }).map((p) => p.pr), [2]);
  assert.throws(() => listMergedPrs({ git: b.git, fromPr: 9, toPr: 5 }), /PR #9 is not a first-parent merge/);
});

test('F2: isFixSubject accepts fix, revert and hotfix forms and refuses the rest (breaks if the pattern changes)', () => {
  for (const s of ['fix: a', 'fix(scope): a', 'fix!: a', 'fix(x)!: a', 'revert: a', 'hotfix(y): a', 'Revert "feat: a"', 'Fix: caps']) assert.equal(isFixSubject(s), true, s);
  for (const s of ['feat: a', 'test: fix a', 'docs: fix typo', 'chore: a', 'fixup stuff', 'prefix: a', 'Merge pull request #1 from x/fix-y', "Merge branch 'fix'", '', undefined]) assert.equal(isFixSubject(s), false, String(s));
});

test('F3: removedRanges returns old-side ranges of removed or changed lines, none for additions, and survives a removed "-- a/x" line (breaks if a hunk line is read as a header or counts are off)', () => {
  const diff = [
    'diff --git a/f.txt b/f.txt', '--- a/f.txt', '+++ b/f.txt',
    '@@ -3,2 +3,1 @@', '-one', '-two', '+three',
    '@@ -7 +6 @@', '-seven', '+six',
    '@@ -9,0 +9,2 @@', '+add1', '+add2',
    'diff --git a/g.txt b/g.txt', '--- a/g.txt', '+++ b/g.txt',
    '@@ -1,2 +1 @@', '--- a/x', '-gone', '+kept',
    'diff --git a/new.txt b/new.txt', 'new file mode 100644', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+n1', '+n2',
    'diff --git a/h.txt b/h.txt', '--- a/h.txt', '+++ b/h.txt', '@@ -4,0 +5 @@', '+only an addition',
  ].join('\n');
  assert.deepEqual(removedRanges(diff), [
    { path: 'f.txt', ranges: [[3, 4], [7, 7]] },
    { path: 'g.txt', ranges: [[1, 2]] },
  ]);
  assert.deepEqual(removedRanges(''), []);
});

test('F3b: removedRanges handles "\\ No newline" marks, a deleted file, a rename, CRLF text and a tab-suffixed path (breaks if a marker, /dev/null, a rename header, a CR or a tab-suffix is read wrong)', () => {
  const NO_NL = '\\ No newline at end of file';
  // The marker sits between the removed and the added lines; the last removed and the first added line look like file headers.
  const marked = ['diff --git a/f.txt b/f.txt', '--- a/f.txt', '+++ b/f.txt', '@@ -3,2 +3,1 @@', '-keep', '--- a/x', NO_NL, '+++ b/y', NO_NL, '@@ -9 +9 @@', '-nine', '+ten'];
  assert.deepEqual(removedRanges(marked.join('\n')), [{ path: 'f.txt', ranges: [[3, 4], [9, 9]] }]);
  const deleted = ['diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-a', '-b', '-c'];
  assert.deepEqual(removedRanges(deleted.join('\n')), [{ path: 'gone.txt', ranges: [[1, 3]] }]);
  const renamed = ['diff --git a/old.txt b/new.txt', 'similarity index 80%', 'rename from old.txt', 'rename to new.txt', '--- a/old.txt', '+++ b/new.txt', '@@ -4 +4 @@', '-x', '+y'];
  assert.deepEqual(removedRanges(renamed.join('\n')), [{ path: 'old.txt', ranges: [[4, 4]] }], 'the OLD path is blamed');
  const pure = ['diff --git a/old.txt b/new.txt', 'similarity index 100%', 'rename from old.txt', 'rename to new.txt'];
  assert.deepEqual(removedRanges(pure.join('\n')), [], 'a pure rename removes no line');
  assert.deepEqual(removedRanges(renamed.join('\r\n')), [{ path: 'old.txt', ranges: [[4, 4]] }], 'CRLF line ends');
  const tabbed = ['diff --git a/my file.txt b/my file.txt', '--- a/my file.txt\t', '+++ b/my file.txt\t', '@@ -2 +2 @@', '-x', '+y'];
  assert.deepEqual(removedRanges(tabbed.join('\n')), [{ path: 'my file.txt', ranges: [[2, 2]] }]);
});

test('F3c: removedRanges un-quotes a C-quoted path: \\" \\\\ \\t \\n and octal bytes (breaks if the quoted header is read as text)', () => {
  const hunk = ['+++ b/z', '@@ -5 +5 @@', '-x', '+y'];
  const read = (header) => removedRanges([header, ...hunk].join('\n'));
  assert.deepEqual(read('--- "a/we\\"ird\\tname.txt"'), [{ path: 'we"ird\tname.txt', ranges: [[5, 5]] }]);
  assert.deepEqual(read('--- "a/x\\\\y.txt"'), [{ path: 'x\\y.txt', ranges: [[5, 5]] }]);
  assert.deepEqual(read('--- "a/two\\nlines.txt"'), [{ path: 'two\nlines.txt', ranges: [[5, 5]] }]);
  assert.deepEqual(read('--- "a/caf\\303\\251.txt"'), [{ path: 'café.txt', ranges: [[5, 5]] }], 'octal bytes are UTF-8');
  assert.deepEqual(read('--- "/dev/null"'), [], 'a quoted /dev/null is still no file');
});

// ---------- F4 to F15: escapesForPr ----------

test('F4: a planted fix commit gives one escape row for the PR that wrote the lines (breaks if blame runs at the fix commit, or the gh step goes)', async () => {
  const b = planted();
  const r = await run(b, 2);
  assert.equal(r.noTarget, null);
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.pr, 2);
  assert.equal(row.blamedPr, 1);
  assert.equal(row.mergeSha, b.prs[2].mergeSha);
  assert.equal(row.blamedMergeSha, b.prs[1].mergeSha);
  assert.equal(row.fixSha, b.prs[2].shas[0]);
});

test('F5 (T19): a fix in a line no PR in the window changed gives no row and the reason outside-window (breaks if a row is invented, or the PR-less sha is kept)', async () => {
  const b = build([
    { direct: { at: '2026-01-01T00:00:00Z', subject: 'chore: seed', files: { 'src/g.txt': lines('a', 'old bug', 'z') } } },
    { n: 2, at: B_DAY, commits: [{ subject: 'fix: correct g', files: { 'src/g.txt': lines('a', 'fixed', 'z') } }] },
  ]);
  const r = await run(b, 2);
  assert.deepEqual(r.rows, []);
  assert.equal(r.noTarget, 'outside-window');
  assert.equal(r.fix, true);
});

test('F6: a fix of the PR\'s own new lines gives no row and is not a no-target (breaks if the own-range filter goes)', async () => {
  const b = build([
    { n: 2, at: B_DAY, commits: [
      { subject: 'feat: add g', files: { 'src/g.txt': lines('a', 'draft', 'z') } },
      { subject: 'fix: review', files: { 'src/g.txt': lines('a', 'final', 'z') } },
    ] },
  ]);
  const gh = fakeGh(b);
  const r = await run(b, 2, { gh });
  assert.deepEqual(r.rows, []);
  assert.equal(r.noTarget, null);
  assert.equal(r.inPrOnly, true);
  assert.equal(gh.calls.length, 0, 'no gh call for a sha of the PR itself');
});

test('F7: a pure-addition fix has no blame target, reason no-removed-lines (breaks if added lines are blamed)', async () => {
  const b = build([
    { n: 1, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('a', 'b') } }] },
    { n: 2, at: B_DAY, commits: [{ subject: 'fix: add a guard', files: { 'src/f.txt': lines('a', 'guard', 'b') } }] },
  ]);
  const r = await run(b, 2);
  assert.deepEqual(r.rows, []);
  assert.equal(r.noTarget, 'no-removed-lines');
});

test('F8: a blamed PR merged 30 days before gives a row and 31 days gives none (breaks if the window compare is off by a day)', async () => {
  const mk = (bAt) => build([
    { n: 1, at: '2026-01-01T12:00:00Z', commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy') } }] },
    { n: 2, at: bAt, commits: [{ subject: 'fix: f', files: { 'src/f.txt': lines('alpha', 'fixed') } }] },
  ]);
  const inside = await run(mk('2026-01-31T12:00:00Z'), 2);
  assert.equal(inside.rows.length, 1);
  const outside = await run(mk('2026-02-01T12:00:00Z'), 2);
  assert.deepEqual(outside.rows, []);
  assert.equal(outside.noTarget, 'outside-window');
});

test('F9: a gh failure and a blame failure are named, not read as "no escape" (breaks if an error becomes outside-window)', async () => {
  const b = planted();
  assert.equal((await run(b, 2, { gh: fakeGh(b, { fail: true }) })).noTarget, 'gh-failed');
  const noBlame = (args) => (args[0] === 'blame' ? { status: 128, stdout: '', stderr: 'boom' } : b.git(args));
  assert.equal((await run(b, 2, { git: noBlame })).noTarget, 'blame-failed');
  const r = await escapesForPr(infoOf(b, 2), { git: () => { throw new Error('spawn failed'); }, gh: fakeGh(b) });
  assert.deepEqual(r, { rows: [], noTarget: 'git-failed', fix: null }, 'never throws; a PR that could not be read is not a fix PR');
});

const failOn = (b, test2) => (args) => (test2(args) ? { status: 128, stdout: '', stderr: 'boom' } : b.git(args));

test('F27: a failed diff is not "no removed lines", a failed blame is not "own PR only", and failures without a hit are partial-failure (breaks if reasonOf reads a failure as a quiet outcome)', async () => {
  const b = planted();
  const noDiff = failOn(b, (a) => a[0] === 'diff' && a.includes('--unified=0'));
  assert.equal((await run(b, 2, { git: noDiff })).noTarget, 'diff-failed');
  // PR 2 fixes its own new line (blame ok, no foreign sha), then a line of PR 1 whose blame fails.
  const own = build([
    { n: 1, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('a', 'b') } }] },
    { n: 2, at: B_DAY, commits: [
      { subject: 'feat: g', files: { 'src/g.txt': lines('g1', 'g2') } },
      { subject: 'fix: g', files: { 'src/g.txt': lines('G1', 'g2') } },
      { subject: 'fix: f', files: { 'src/f.txt': lines('a', 'B') } },
    ] },
  ]);
  const quiet = await run(own, 2);
  assert.equal(quiet.rows.length, 1, 'the control: without a failure the f fix is an escape');
  const noBlameF = failOn(own, (a) => a[0] === 'blame' && a.includes('src/f.txt'));
  const partial = await run(own, 2, { git: noBlameF });
  assert.equal(partial.noTarget, 'partial-failure');
  assert.notEqual(partial.inPrOnly, true);
  // One fix commit adds a line (no removed lines), another has a failing diff.
  const mix = build([
    { n: 1, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('a', 'b') } }] },
    { n: 2, at: B_DAY, commits: [
      { subject: 'fix: add guard', files: { 'src/f.txt': lines('a', 'guard', 'b') } },
      { subject: 'fix: second', files: { 'src/f.txt': lines('a', 'guard', 'B') } },
    ] },
  ]);
  const second = mix.prs[2].shas[1];
  const diffFails = failOn(mix, (a) => a[0] === 'diff' && a.includes('--unified=0') && a.includes(second));
  assert.equal((await run(mix, 2, { git: diffFails })).noTarget, 'partial-failure');
});

test('F28: a PR that git cannot read is counted as a git failure, apart from the fix PRs and the no-target reasons (breaks if it is counted as a fix PR or as a reason)', async () => {
  const b = planted();
  const noLog = failOn(b, (a) => a[0] === 'log' && a.includes('--no-merges'));
  const jsonFile = path.join(tmp('out'), 'run.json');
  const r = await cli(['--range', '1..2', '--repo', 'o/r', '--json', jsonFile], { git: noLog, gh: fakeGh(b) });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /git failures: 2/);
  assert.match(r.out, /fix PRs: 0/);
  const j = JSON.parse(readFileSync(jsonFile, 'utf8'));
  assert.equal(j.totals.gitFailures, 2);
  assert.equal(j.totals.fixPrs, 0);
  assert.deepEqual(j.totals.noTarget.byReason, {}, 'git-failed is not a no-target reason');
});

test('F29: the most recently merged blamed PR is primary, the others are not, and a tie goes to the higher PR number (breaks if primary follows the PR number, the tie goes the other way, or the flag is missing)', async () => {
  // PR 3 merges before PR 1: the PR numbers are not the merge order.
  const b = build([
    { n: 3, at: '2026-01-08T12:00:00Z', commits: [{ subject: 'feat: g', files: { 'src/f.txt': lines('c1', 'c2') } }] },
    { n: 1, at: '2026-01-09T12:00:00Z', commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('c1', 'c2', 'a1', 'a2') } }] },
    { n: 4, at: B_DAY, commits: [{ subject: 'fix: both', files: { 'src/f.txt': lines('X1', 'X2', 'Y1', 'Y2') } }] },
  ]);
  const flags = (r) => Object.fromEntries(r.rows.map((x) => [x.blamedPr, x.primary]));
  assert.deepEqual(flags(await run(b, 4)), { 1: true, 3: false });
  const same = (sha) => (b.byBranchSha[sha] ?? []).map((p) => ({ ...p, merged_at: '2026-01-09T12:00:00Z' }));
  assert.deepEqual(flags(await run(b, 4, { gh: fakeGh(b, { override: same }) })), { 1: false, 3: true }, 'tie: the higher PR number wins');
  assert.deepEqual((await run(planted(), 2)).rows.map((x) => x.primary), [true], 'one blamed PR is primary');
  // The lower-numbered PR is blamed first (top lines): a tie must still go to the higher number, not to the first hit.
  const t = build([
    { n: 1, at: '2026-01-08T12:00:00Z', commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('c1', 'c2') } }] },
    { n: 3, at: '2026-01-09T12:00:00Z', commits: [{ subject: 'feat: g', files: { 'src/f.txt': lines('c1', 'c2', 'a1', 'a2') } }] },
    { n: 4, at: B_DAY, commits: [{ subject: 'fix: both', files: { 'src/f.txt': lines('X1', 'X2', 'Y1', 'Y2') } }] },
  ]);
  const tied = (sha) => (t.byBranchSha[sha] ?? []).map((p) => ({ ...p, merged_at: '2026-01-09T12:00:00Z' }));
  assert.deepEqual(flags(await run(t, 4, { gh: fakeGh(t, { override: tied }) })), { 1: false, 3: true });
  assert.deepEqual(flags(await run(t, 4)), { 1: false, 3: true }, 'no tie: the later merge is primary');
});

test('F30: a blamed PR whose merge commit is not a first-parent merge on the ref is dropped, and of several that qualify the earliest merged is kept (breaks if the main-merge filter or the earliest rule goes)', async () => {
  const b = build([
    { n: 1, at: '2026-01-10T12:00:00Z', commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy') } }] },
    { n: 3, at: '2026-01-10T18:00:00Z', commits: [{ subject: 'feat: h', files: { 'src/h.txt': lines('h') } }] },
    { n: 2, at: B_DAY, commits: [{ subject: 'fix: f', files: { 'src/f.txt': lines('alpha', 'fixed') } }] },
  ]);
  const info = (n) => ({ number: n, merged_at: n === 1 ? '2026-01-10T12:00:00Z' : '2026-01-10T18:00:00Z', merge_commit_sha: b.prs[n].mergeSha });
  const stacked = { number: 99, merged_at: '2026-01-10T11:00:00Z', merge_commit_sha: 'f'.repeat(40) };
  const withStacked = await run(b, 2, { gh: fakeGh(b, { override: () => [stacked, info(1)] }) });
  assert.deepEqual(withStacked.rows.map((x) => x.blamedPr), [1], 'PR 99 merged into another branch, not into main');
  const both = await run(b, 2, { gh: fakeGh(b, { override: () => [info(3), info(1)] }) });
  assert.deepEqual(both.rows.map((x) => x.blamedPr), [1], 'two main merges for one sha: the earliest');
  const onlyStacked = await run(b, 2, { gh: fakeGh(b, { override: () => [stacked] }) });
  assert.deepEqual(onlyStacked.rows, []);
  assert.equal(onlyStacked.noTarget, 'outside-window');
  assert.ok(readMerges({ git: b.git }).merges.some((m) => m.mergeSha === b.prs[1].mergeSha));
});

test('F31: the fix diff is read with fixed a/ and b/ prefixes, so a user diff.noprefix setting cannot shift the path (breaks if --src-prefix and --dst-prefix are dropped)', async () => {
  const b = build([
    { n: 1, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'a/f.txt': lines('alpha', 'buggy') } }] },
    { n: 2, at: B_DAY, commits: [{ subject: 'fix: f', files: { 'a/f.txt': lines('alpha', 'fixed') } }] },
  ]);
  sh(b.dir, ['config', 'diff.noprefix', 'true'], A_DAY);
  const r = await run(b, 2);
  assert.deepEqual(r.rows.map((x) => x.blamedPr), [1], 'a file under a/ keeps its whole path');
});

test('F32: a failed gh call is cached for the run and not retried (breaks if only successes are cached)', async () => {
  const b = build([
    { n: 1, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('a', 'b', 'c') } }] },
    { n: 2, at: B_DAY, commits: [
      { subject: 'fix: line a', files: { 'src/f.txt': lines('A', 'b', 'c') } },
      { subject: 'fix: line c', files: { 'src/f.txt': lines('A', 'b', 'C') } },
    ] },
  ]);
  const gh = fakeGh(b, { fail: true });
  const r = await run(b, 2, { gh });
  assert.equal(r.noTarget, 'gh-failed');
  assert.equal(gh.calls.length, 1);
});

test('F33: a blame sha of 64 hex digits (a sha256 repo) is read (breaks if the sha pattern is fixed at 40)', async () => {
  const b = planted();
  const sha = 'ab'.repeat(32);
  const git = (args) => (args[0] === 'blame' ? { status: 0, stdout: `${sha} 1 1 1\nauthor x\n\tline\n`, stderr: '' } : b.git(args));
  const pr = { number: 1, merged_at: A_DAY, merge_commit_sha: b.prs[1].mergeSha };
  const gh = fakeGh(b, { override: (s) => (s === sha ? [pr] : []) });
  const r = await run(b, 2, { git, gh });
  assert.deepEqual(r.rows.map((x) => x.blamedPr), [1]);
  assert.ok(gh.calls[0][1].includes(sha));
});

test('F10: a PR with no fix commit is not walked: no blame, no gh (breaks if the subject filter goes)', async () => {
  const b = build([{ n: 1, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('a') } }] }, { n: 2, at: B_DAY, commits: [{ subject: 'test: more', files: { 'src/f.txt': lines('b') } }] }]);
  const calls = [];
  const spy = (args) => { calls.push(args[0]); return b.git(args); };
  const gh = fakeGh(b);
  const r = await run(b, 2, { git: spy, gh });
  assert.deepEqual(r, { rows: [], noTarget: null, fix: false });
  assert.ok(!calls.includes('blame'));
  assert.equal(gh.calls.length, 0);
});

test('F11: one gh call per blamed sha, also across PRs with a shared cache (breaks if the prOfSha cache goes)', async () => {
  const b = build([
    { n: 1, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('a', 'b', 'c') } }] },
    { n: 2, at: B_DAY, commits: [
      { subject: 'fix: line a', files: { 'src/f.txt': lines('A', 'b', 'c') } },
      { subject: 'fix: line c', files: { 'src/f.txt': lines('A', 'b', 'C') } },
    ] },
  ]);
  const gh = fakeGh(b);
  const cache = new Map();
  const r = await run(b, 2, { gh, prOfSha: cache });
  assert.equal(r.rows.length, 1, 'two fix commits blame one PR: one row');
  assert.equal(gh.calls.length, 1);
  await run(b, 2, { gh, prOfSha: cache });
  assert.equal(gh.calls.length, 1, 'the second run reads the cache');
});

test('F12: one row per distinct blamed PR, and two blamed PRs are no merge-interaction (breaks if rows are per line, or a blamedPrCount rule is back)', async () => {
  const b = build([
    { n: 1, at: '2026-01-08T12:00:00Z', commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('a1', 'a2') } }] },
    { n: 3, at: '2026-01-09T12:00:00Z', commits: [{ subject: 'feat: g', files: { 'src/f.txt': lines('a1', 'a2', 'c1', 'c2') } }] },
    { n: 4, at: B_DAY, commits: [{ subject: 'fix: both', files: { 'src/f.txt': lines('X1', 'X2', 'Y1', 'Y2') } }] },
  ]);
  const r = await run(b, 4);
  assert.deepEqual(r.rows.map((x) => x.blamedPr).sort(), [1, 3]);
  assert.deepEqual(r.rows.map((x) => x.cause), ['unclassified', 'unclassified']);
});

test('F13: the fix PR itself is never its own cause (breaks if `p.number !== pr` goes)', async () => {
  const b = planted();
  const own = () => [{ number: 2, merged_at: A_DAY, merge_commit_sha: b.prs[2].mergeSha }];
  const r = await run(b, 2, { gh: fakeGh(b, { override: own }) });
  assert.deepEqual(r.rows, []);
  assert.equal(r.noTarget, 'outside-window');
});

test('F14: the band is the band of the blamed PR from its own files; UNKNOWN when it cannot be told (breaks if the band is read from the fix PR or the fallback goes)', async () => {
  const b = build([
    { n: 1, at: A_DAY, commits: [{ subject: 'feat: f', files: { '.claude/hooks/src/decision-gate.ts': lines('a', 'buggy') } }] },
    { n: 2, at: B_DAY, commits: [{ subject: 'fix: f', files: { '.claude/hooks/src/decision-gate.ts': lines('a', 'fixed') } }] },
  ]);
  const real = (await run(b, 2)).rows[0];
  assert.match(real.band, /^(LOW|MID|ELEVATED|HIGH|CRITICAL)$/);
  assert.notEqual(real.band, 'LOW', 'a decision-gate file is not a LOW change');
  const none = (await run(b, 2, { routerConfig: null })).rows[0];
  assert.equal(none.band, 'UNKNOWN');
});

test('F15: the cause is computed from the fix files before the row is returned (breaks if classifyCause gets the wrong files)', async () => {
  const b = build([
    { n: 1, at: A_DAY, commits: [{ subject: 'feat: r', files: { '.claude/rules-src/r.md': lines('keep', 'bad rule') } }] },
    { n: 2, at: B_DAY, commits: [{ subject: 'fix: r', files: { '.claude/rules-src/r.md': lines('keep', 'good rule') } }] },
  ]);
  assert.equal((await run(b, 2)).rows[0].cause, 'no-behaviour-check');
  assert.equal((await run(planted(), 2)).rows[0].cause, 'unclassified');
});

test('F23: blame ignores whitespace-only changes, so a re-indent PR is not blamed (breaks if -w is dropped from git blame)', async () => {
  const b = build([
    { n: 5, at: '2026-01-05T12:00:00Z', commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy line', 'omega') } }] },
    { n: 6, at: '2026-01-08T12:00:00Z', commits: [{ subject: 'style: indent', files: { 'src/f.txt': lines('alpha', '    buggy line', 'omega') } }] },
    { n: 7, at: B_DAY, commits: [{ subject: 'fix: f', files: { 'src/f.txt': lines('alpha', '    fixed line', 'omega') } }] },
  ]);
  const r = await run(b, 7);
  assert.deepEqual(r.rows.map((x) => x.blamedPr), [5]);
});

// ---------- F16, F17: the state files ----------

const row = (mergeSha, blamedPr, band = 'LOW') => ({ mergeSha, pr: 9, band, blamedPr, cause: 'unclassified' });

test('F16: writeRows appends new rows once, creates the dir, and survives a damaged line (breaks if the key, the reader or the newline guard changes)', () => {
  const dir = path.join(tmp('state'), 'deep', 'er');
  assert.deepEqual(writeRows(dir, [row('m1', 1), row('m1', 2)]), { added: 2, skipped: 0, updated: 0, removed: 0 });
  assert.deepEqual(writeRows(dir, [row('m1', 1), row('m1', 2)]), { added: 0, skipped: 2, updated: 0, removed: 0 });
  assert.deepEqual(writeRows(dir, [row('m2', 1)]), { added: 1, skipped: 0, updated: 0, removed: 0 }, 'same blamed PR, other fix merge: a new key');
  const file = path.join(dir, 'escapes.jsonl');
  writeFileSync(file, `${readFileSync(file, 'utf8')}{damaged`); // no newline at the end
  // m1 is read again with only blamed PR 1: the old m1 row for PR 2 goes. The damaged line stays where it is.
  assert.deepEqual(writeRows(dir, [row('m1', 1), row('m3', 3)]), { added: 1, skipped: 1, updated: 0, removed: 1 });
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 4);
  assert.deepEqual(writeRows(dir, [row('m4', 4), row('m4', 4)]), { added: 1, skipped: 1, updated: 0, removed: 0 }, 'a duplicate inside one call counts once');
});

test('F37: writeRows replaces the rows of a fix PR instead of appending beside them; other rows stay byte-identical and in order; no temp file is left (breaks if a re-run adds a second primary row, rows move, or the rewrite is not tmp plus rename)', () => {
  const dir = tmp('state');
  const file = path.join(dir, 'escapes.jsonl');
  const other1 = '{"mergeSha":"y",  "pr":5,"blamedPr":1,"cause":"unclassified"}'; // odd spacing: must survive byte for byte
  const other2 = JSON.stringify({ mergeSha: 'z', pr: 6, blamedPr: 2, cause: 'unclassified', primary: true });
  const rowP = (blamedPr, primary) => ({ ...row('x', blamedPr), primary });
  writeFileSync(file, [other1, JSON.stringify(rowP(1, true)), JSON.stringify(rowP(3, false)), other2].join('\n') + '\n');
  const r = writeRows(dir, [rowP(1, false), rowP(3, true)]);
  assert.deepEqual(r, { added: 0, skipped: 0, updated: 2, removed: 0 });
  const lines2 = readFileSync(file, 'utf8').split('\n');
  assert.deepEqual(lines2.slice(0, 2), [other1, other2], 'rows of other fix PRs: same bytes, same order');
  const mine = lines2.filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.mergeSha === 'x');
  assert.equal(mine.length, 2);
  assert.deepEqual(mine.filter((x) => x.primary === true).map((x) => x.blamedPr), [3], 'exactly one primary row for the fix PR');
  assert.deepEqual(readdirSync(dir), ['escapes.jsonl'], 'the temp file was renamed away');
  assert.deepEqual(writeRows(dir, [rowP(1, false), rowP(3, true)]), { added: 0, skipped: 2, updated: 0, removed: 0 }, 'the same rows again: no change');
});

test('F17: buildBaseline has one row per band of the window PRs; escapes are distinct window PRs with a row, in the band of the window PR, and escapes never pass prsMerged (breaks if rows are counted, the row band is used, or an outside PR is counted)', () => {
  const merged = [{ pr: 1, band: 'LOW', mergeSha: 's1' }, { pr: 2, band: 'LOW', mergeSha: 's2' }, { pr: 3, band: 'HIGH', mergeSha: 's3' }, { pr: 4, band: 'UNKNOWN', mergeSha: 's4' }];
  const rows = [
    { ...row('a', 1, 'CRITICAL'), blamedMergeSha: 's1' }, // the row band is not the window PR band
    { ...row('b', 1, 'LOW'), blamedMergeSha: 's1' }, // a second fix of the same PR: one escape, two rows
    { ...row('c', 3, 'HIGH') }, // matched by PR number
    { ...row('e', 55, 'LOW'), blamedMergeSha: 's2' }, // matched by merge sha
    { ...row('d', 99, 'CRITICAL'), blamedMergeSha: 'sx' }, // blamed PR outside the window
  ];
  const window = { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', toSha: 'abc' };
  const base = buildBaseline(rows, merged, window);
  assert.deepEqual(base.map((r) => [r.band, r.prsMerged, r.escapes, r.escapeRows]), [['LOW', 2, 2, 3], ['HIGH', 1, 1, 1], ['UNKNOWN', 1, 0, 0]]);
  assert.ok(base.every((r) => r.escapes <= r.prsMerged));
  assert.ok(base.every((r) => r.window.toSha === 'abc'));
  assert.equal(rowsLeftOut(rows, merged), 1, 'only the row blamed to a PR outside the window is left out');
  const dir = tmp('state');
  writeBaseline(dir, base);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'escape-baseline.json'), 'utf8')), base);
});

// ---------- F18 to F22: the CLI ----------

const cli = async (argv, deps = {}) => {
  const out = [];
  const err = [];
  const code = await main(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: { REVIEW_ENGINE_STATE_DIR: tmp('state') }, routerConfig: CFG, ...deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
};
const boom = () => { throw new Error('must not be called'); };

test('F18: no args and --help print usage, exit 0, and call neither git nor gh (breaks if the walk starts before the args are read)', async () => {
  for (const argv of [[], ['--help']]) {
    const r = await cli(argv, { git: boom, gh: boom });
    assert.equal(r.code, 0);
    assert.match(r.out, /usage: node scripts\/eval\/review-eval\/fix-chains\.mjs/);
  }
});

test('F18b: the real script with --help and with no args, under a temp HOME, exits 0 and creates nothing in it (breaks if the state dir is made at load)', () => {
  const home = tmp('home');
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const args of [['--help'], []]) {
    const r = spawnSync(process.execPath, [path.join(HERE, 'fix-chains.mjs'), ...args], { env, encoding: 'utf8', windowsHide: true, cwd: home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /usage: node scripts\/eval\/review-eval\/fix-chains\.mjs/);
  }
  assert.equal(existsSync(path.join(home, '.claude')), false);
});

const twoPrRepo = () => planted();
const rangeArgs = ['--range', '1..2', '--repo', 'o/r'];

test('F19: a dry run writes nothing; --write writes the rows; a re-run adds none; --baseline writes the baseline only with --write (breaks if main writes in a dry run or the key is lost)', async () => {
  const b = twoPrRepo();
  const dir = path.join(tmp('state'), 'se');
  const deps = { git: b.git, gh: fakeGh(b) };
  const dry = await cli([...rangeArgs, '--baseline', '--state-dir', dir], deps);
  assert.equal(dry.code, 0, dry.err);
  assert.equal(existsSync(dir), false, 'a dry run makes no state dir');
  const w1 = await cli([...rangeArgs, '--baseline', '--window-to-sha', b.prs[2].mergeSha, '--write', '--state-dir', dir], deps);
  assert.match(w1.out, /rows written: 1 added, 0 skipped/);
  assert.equal(readFileSync(path.join(dir, 'escapes.jsonl'), 'utf8').trim().split('\n').length, 1);
  const base = JSON.parse(readFileSync(path.join(dir, 'escape-baseline.json'), 'utf8'));
  assert.ok(base.length >= 1 && base.every((r) => r.window.toSha === b.prs[2].mergeSha));
  const w2 = await cli([...rangeArgs, '--write', '--state-dir', dir], deps);
  assert.match(w2.out, /rows written: 0 added, 1 skipped/);
  assert.equal(readFileSync(path.join(dir, 'escapes.jsonl'), 'utf8').trim().split('\n').length, 1);
});

/** Three PRs: #2 fixes a line of #1 (inside the window), #3 fixes a line of #2 (after the window). */
const chainRepo = () => build([
  { n: 1, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy', 'omega') } }] },
  { n: 2, at: B_DAY, commits: [{ subject: 'fix: f', files: { 'src/f.txt': lines('alpha', 'fixed', 'omega') } }] },
  { n: 3, at: '2026-01-12T12:00:00Z', commits: [{ subject: 'fix: f again', files: { 'src/f.txt': lines('alpha', 'final', 'omega') } }] },
]);
const sumOf = (base, key) => base.reduce((n, r) => n + r[key], 0);
const dryJson = async (b, extra) => {
  const jsonFile = path.join(tmp('out'), 'run.json');
  const r = await cli(['--range', '1..3', '--repo', 'o/r', '--baseline', '--json', jsonFile, ...extra], { git: b.git, gh: fakeGh(b) });
  return { r, run: existsSync(jsonFile) ? JSON.parse(readFileSync(jsonFile, 'utf8')) : null };
};

test('F24: --window-to-sha ends the baseline window at that PR, but fix PRs are mined over the whole range (breaks if the window is the range, or mining stops at the window)', async () => {
  const b = chainRepo();
  const split = await dryJson(b, ['--window-to-sha', b.prs[2].mergeSha]);
  assert.equal(split.r.code, 0, split.r.err);
  assert.equal(sumOf(split.run.baseline, 'prsMerged'), 2, 'the window holds #1 and #2');
  assert.equal(sumOf(split.run.baseline, 'escapes'), 2, 'a fix after the window (#3) that blames a window PR (#2) counts');
  assert.equal(sumOf(split.run.baseline, 'escapeRows'), 2);
  assert.equal(split.run.baselineRowsLeftOut, 0);
  assert.equal(split.run.rows.length, 2, 'both fix PRs were mined');
  const w = split.run.baseline[0].window;
  assert.equal(w.toSha, b.prs[2].mergeSha);
  assert.match(w.to, /^2026-01-11T12:00:00/);
  assert.match(w.from, /^2026-01-10T12:00:00/);
  const whole = await dryJson(b, []);
  assert.equal(sumOf(whole.run.baseline, 'prsMerged'), 3, 'no --window-to-sha: the window is the whole range');
  assert.equal(sumOf(whole.run.baseline, 'escapes'), 2);
  assert.equal(whole.run.baseline[0].window.toSha, b.prs[3].mergeSha);
  const early = await dryJson(b, ['--window-to-sha', b.prs[1].mergeSha]);
  assert.equal(sumOf(early.run.baseline, 'prsMerged'), 1);
  assert.equal(sumOf(early.run.baseline, 'escapes'), 1, 'only #1 is a window PR; the row blamed to #2 is left out');
  assert.equal(early.run.baselineRowsLeftOut, 1);
});

test('F25: a --window-to-sha that is not a merge in the listed range exits 2 (breaks if an unknown sha is read as the whole range)', async () => {
  const b = chainRepo();
  const deps = { git: b.git, gh: fakeGh(b) };
  for (const sha of ['deadbeef', b.prs[1].mergeSha, b.prs[2].shas[0]]) {
    const argv = sha === b.prs[1].mergeSha ? ['--range', '2..3'] : ['--range', '1..3'];
    const r = await cli([...argv, '--repo', 'o/r', '--baseline', '--window-to-sha', sha], deps);
    assert.equal(r.code, 2, sha);
    assert.match(r.err, /window-to-sha/);
  }
});

test('F26: the baseline counts primary rows only for escapes and escapeRows, keeps the all-row count, and treats a row with no primary field as primary (breaks if non-primary rows are counted or old rows are dropped)', () => {
  const merged = [{ pr: 1, band: 'LOW', mergeSha: 's1' }, { pr: 2, band: 'LOW', mergeSha: 's2' }, { pr: 3, band: 'HIGH', mergeSha: 's3' }];
  const rows = [
    { ...row('a', 1), primary: true },
    { ...row('b', 2), primary: false }, // PR 2 has only a non-primary row: not an escape
    { ...row('c', 1), primary: false },
    row('d', 3, 'HIGH'), // an old row, no primary field
  ];
  const base = buildBaseline(rows, merged, { from: null, to: null, toSha: 'x' });
  const low = base.find((r) => r.band === 'LOW');
  assert.deepEqual([low.prsMerged, low.escapes, low.escapeRows, low.allRows], [2, 1, 1, 3]);
  const high = base.find((r) => r.band === 'HIGH');
  assert.deepEqual([high.escapes, high.escapeRows, high.allRows], [1, 1, 1]);
  assert.equal(rowsLeftOut(rows, merged), 0);
});

test('F34: --write with --baseline needs --window-to-sha (exit 2), a dry run does not (breaks if the pin is optional on a write)', async () => {
  const b = twoPrRepo();
  const dir = path.join(tmp('state'), 'pin');
  const deps = { git: b.git, gh: fakeGh(b) };
  const bad = await cli([...rangeArgs, '--baseline', '--write', '--state-dir', dir], deps);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /window-to-sha/);
  assert.equal(existsSync(dir), false);
  assert.equal((await cli([...rangeArgs, '--baseline', '--state-dir', dir], deps)).code, 0);
  assert.equal((await cli([...rangeArgs, '--write', '--state-dir', dir], deps)).code, 0, 'rows alone need no window');
});

test('F35: --ref picks the branch (default main), prints the resolved head sha, and puts head in the --json output; an option is no ref (breaks if the ref is fixed to main or head is missing)', async () => {
  const b = chainRepo();
  sh(b.dir, ['branch', 'alt', b.prs[2].mergeSha], A_DAY);
  const headOf = (ref) => sh(b.dir, ['rev-parse', ref], A_DAY);
  const jsonFile = path.join(tmp('out'), 'run.json');
  const main1 = await cli(['--range', '1..3', '--repo', 'o/r', '--json', jsonFile], { git: b.git, gh: fakeGh(b) });
  assert.match(main1.out, new RegExp(`head: ${headOf('main')} \\(main\\)`));
  assert.equal(JSON.parse(readFileSync(jsonFile, 'utf8')).head, headOf('main'));
  const alt = await cli(['--range', '1..2', '--ref', 'alt', '--repo', 'o/r', '--json', jsonFile], { git: b.git, gh: fakeGh(b) });
  assert.equal(alt.code, 0, alt.err);
  assert.match(alt.out, new RegExp(`head: ${headOf('alt')} \\(alt\\)`));
  assert.equal(JSON.parse(readFileSync(jsonFile, 'utf8')).head, b.prs[2].mergeSha);
  const missing = await cli(['--range', '1..3', '--ref', 'alt', '--repo', 'o/r'], { git: b.git, gh: fakeGh(b) });
  assert.equal(missing.code, 2, 'PR 3 is not on alt');
  assert.equal((await cli(['--range', '1..3', '--ref', '-x', '--repo', 'o/r'], { git: b.git, gh: fakeGh(b) })).code, 2);
  assert.equal((await cli(['--range', '1..3', '--ref', 'no-such-ref', '--repo', 'o/r'], { git: b.git, gh: fakeGh(b) })).code, 2);
});

test('F36: the CLI baseline line prints the all-row count next to the primary count (breaks if the all-row count is not printed)', async () => {
  const b = build([
    { n: 3, at: '2026-01-08T12:00:00Z', commits: [{ subject: 'feat: g', files: { 'src/f.txt': lines('c1', 'c2') } }] },
    { n: 1, at: '2026-01-09T12:00:00Z', commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('c1', 'c2', 'a1', 'a2') } }] },
    { n: 4, at: B_DAY, commits: [{ subject: 'fix: both', files: { 'src/f.txt': lines('X1', 'X2', 'Y1', 'Y2') } }] },
  ]);
  const r = await cli(['--range', '3..4', '--repo', 'o/r', '--baseline'], { git: b.git, gh: fakeGh(b) });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /baseline \(primary rows: a rule of thumb, not a proven cause\): .*1\/3 \(1 primary row\(s\), 2 all\)/);
});

/** PR 1 wrote the top lines, PR 3 the bottom lines, fix PR 4 changes all four: PR 3 (the later merge) is the true primary. */
const partialRepo = () => build([
  { n: 1, at: '2026-01-08T12:00:00Z', commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('c1', 'c2') } }] },
  { n: 3, at: '2026-01-09T12:00:00Z', commits: [{ subject: 'feat: g', files: { 'src/f.txt': lines('c1', 'c2', 'a1', 'a2') } }] },
  { n: 4, at: B_DAY, commits: [{ subject: 'fix: both', files: { 'src/f.txt': lines('X1', 'X2', 'Y1', 'Y2') } }] },
]);
/** A gh that fails for the one sha of PR 3 and answers for the rest. */
const flakyGh = (b) => fakeGh(b, { override: (sha) => { if (sha === b.prs[3].shas[0]) throw new Error('gh: 502'); return b.byBranchSha[sha] ?? []; } });
const primaryRows = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.primary === true);

test('F38: a diff, blame or gh failure sets failed:true with its steps, also when rows exist (breaks if the failure is dropped once a row is found)', async () => {
  const b = partialRepo();
  const r = await run(b, 4, { gh: flakyGh(b) });
  assert.equal(r.failed, true);
  assert.deepEqual(r.failures, ['gh']);
  assert.equal(r.rows.length, 1, 'PR 1 still gives a row, and it holds the wrong primary flag');
  const clean = await run(b, 4);
  assert.equal(clean.failed, undefined, 'a clean run has no failed flag');
  const noBlame = await run(b, 4, { git: failOn(b, (a) => a[0] === 'blame') });
  assert.equal(noBlame.failed, true);
  assert.ok(noBlame.failures.includes('blame'));
  const noDiff = await run(b, 4, { git: failOn(b, (a) => a[0] === 'diff' && a.includes('--unified=0')) });
  assert.deepEqual([noDiff.failed, noDiff.failures], [true, ['diff']]);
});

test('F39: the CLI writes no rows for a fix PR whose run had a failure, counts it as partial-failure and prints it; a later clean run leaves exactly one primary row; a later failed run changes nothing (breaks if a partial row is written or kept beside the true one)', async () => {
  const b = partialRepo();
  const dir = path.join(tmp('state'), 'partial');
  const file = path.join(dir, 'escapes.jsonl');
  const args = ['--range', '1..4', '--repo', 'o/r', '--write', '--state-dir', dir];
  const jsonFile = path.join(tmp('out'), 'run.json');
  const bad = await cli([...args, '--json', jsonFile], { git: b.git, gh: flakyGh(b) });
  assert.equal(bad.code, 0, bad.err);
  assert.match(bad.out, /PR #4: .*partial-failure/);
  assert.match(bad.out, /no blame target: 1 \(partial-failure 1\)/);
  assert.equal(existsSync(file), false, 'nothing written for a partial run');
  const j = JSON.parse(readFileSync(jsonFile, 'utf8'));
  assert.deepEqual(j.rows, []);
  assert.deepEqual(j.totals.noTarget.byReason, { 'partial-failure': 1 });
  const good = await cli(args, { git: b.git, gh: fakeGh(b) });
  assert.match(good.out, /rows written: 2 added/);
  assert.deepEqual(primaryRows(file).map((x) => x.blamedPr), [3], 'the true primary only');
  const before = readFileSync(file, 'utf8');
  await cli(args, { git: b.git, gh: flakyGh(b) });
  assert.equal(readFileSync(file, 'utf8'), before, 'a failed run does not touch the file');
});

test('F40: the earliest main merge of a commit is picked before the window test, so a commit under two main merges is not blamed on the newer one (breaks if the window filter runs first)', async () => {
  const b = build([
    { n: 1, at: '2026-01-01T12:00:00Z', commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy') } }] },
    { n: 3, at: '2026-01-31T12:00:00Z', commits: [{ subject: 'feat: h', files: { 'src/h.txt': lines('h') } }] },
    { n: 2, at: '2026-02-10T12:00:00Z', commits: [{ subject: 'fix: f', files: { 'src/f.txt': lines('alpha', 'fixed') } }] },
  ]);
  const info = (n, at) => ({ number: n, merged_at: at, merge_commit_sha: b.prs[n].mergeSha });
  const both = await run(b, 2, { gh: fakeGh(b, { override: () => [info(3, '2026-01-31T12:00:00Z'), info(1, '2026-01-01T12:00:00Z')] }) });
  assert.deepEqual(both.rows, [], 'the earliest merge is 40 days old: outside the window');
  assert.equal(both.noTarget, 'outside-window');
  const only = await run(b, 2, { gh: fakeGh(b, { override: () => [info(3, '2026-01-31T12:00:00Z')] }) });
  assert.deepEqual(only.rows.map((x) => x.blamedPr), [3], 'control: the 10-day merge alone is in the window');
});

test('F41: a git call that times out is a failure (breaks if makeGit has no timeout, so a hung git hangs the run)', () => {
  const b = planted();
  assert.equal(makeGit(b.dir)(['log', '--oneline']).status, 0, 'control: the default timeout is long');
  const slow = makeGit(b.dir, { timeoutMs: 1 })(['log', '--oneline']);
  assert.notEqual(slow.status, 0);
});

test('F42: --json may not resolve inside the state dir, also for a dry run; another place is fine, also a folder that only shares the name prefix (breaks if --json can overwrite a state file)', async () => {
  const b = twoPrRepo();
  const dir = path.join(tmp('state'), 'se');
  const deps = () => ({ git: b.git, gh: fakeGh(b) });
  for (const inside of [path.join(dir, 'escapes.jsonl'), path.join(dir, 'sub', 'run.json'), dir, path.join(dir, '..', 'se', 'x.json')]) {
    const r = await cli([...rangeArgs, '--state-dir', dir, '--json', inside], deps());
    assert.equal(r.code, 2, inside);
    assert.match(r.err, /--json/);
    assert.equal(existsSync(dir), false, 'nothing was made');
  }
  const viaEnv = await cli([...rangeArgs, '--json', path.join(dir, 'run.json')], { ...deps(), env: { REVIEW_ENGINE_STATE_DIR: dir } });
  assert.equal(viaEnv.code, 2, 'the env state dir counts too');
  const near = path.join(`${dir}-near`, 'run.json');
  assert.equal((await cli([...rangeArgs, '--state-dir', dir, '--json', near], deps())).code, 0);
  assert.equal(existsSync(near), true);
  assert.equal(existsSync(dir), false, 'a dry run still writes no state dir');
});

test('F43: the fix diff pins rename detection with -M, so a user diff.renames=false cannot turn a rename into a whole-file removal (breaks if -M is dropped)', async () => {
  const b = build([
    { n: 1, at: '2026-01-08T12:00:00Z', commits: [{ subject: 'feat: f', files: { 'old.txt': lines('a1', 'a2') } }] },
    { n: 3, at: '2026-01-09T12:00:00Z', commits: [{ subject: 'feat: g', files: { 'old.txt': lines('a1', 'a2', 'a3', 'a4') } }] },
    { config: ['diff.renames', 'false'] },
    { n: 4, at: B_DAY, commits: [{ subject: 'fix: move and change', remove: ['old.txt'], files: { 'new.txt': lines('a1', 'a2', 'a3', 'A4') } }] },
  ]);
  const r = await run(b, 4);
  assert.deepEqual(r.rows.map((x) => x.blamedPr), [3], 'only the changed line of the renamed file is blamed');
});

test('F20: the CLI with --state-dir leaves the live escapes file as it was, also when it does not exist (breaks if the default dir is read or written)', async () => {
  const live = path.join(os.homedir(), '.claude', 'state', 'review-engine', 'escapes.jsonl');
  const stat = () => (existsSync(live) ? statSync(live) : null);
  const before = stat();
  const b = twoPrRepo();
  const dir = tmp('state');
  const r = await cli([...rangeArgs, '--write', '--state-dir', dir], { git: b.git, gh: fakeGh(b) });
  assert.equal(r.code, 0, r.err);
  const after2 = stat();
  assert.equal(after2 === null, before === null);
  if (before) { assert.equal(after2.size, before.size); assert.equal(after2.mtimeMs, before.mtimeMs); }
  const viaEnv = await cli(rangeArgs.concat('--write'), { git: b.git, gh: fakeGh(b), env: { REVIEW_ENGINE_STATE_DIR: dir } });
  assert.match(viaEnv.out, /rows written: 0 added, 1 skipped/, 'the env var picks the dir');
});

test('F21: a bad range, an unknown PR, an unknown flag or no range exit 2 with a message (breaks if main treats them as an empty walk)', async () => {
  const b = twoPrRepo();
  const deps = { git: b.git, gh: fakeGh(b) };
  for (const argv of [['--range', '2..x'], ['--range', '1..99', '--repo', 'o/r'], ['--nope'], ['--write'], ['--range', '1..2', '--since', 'not-a-date']]) {
    const r = await cli(argv, deps);
    assert.equal(r.code, 2, argv.join(' '));
    assert.ok(r.err.length > 0);
  }
});

test('F22 (T19): the totals count fix PRs, escape rows and the no-target fixes by reason; --json writes them (breaks if the no-target count is dropped)', async () => {
  const b = build([
    { direct: { at: '2026-01-01T00:00:00Z', subject: 'chore: seed', files: { 'src/g.txt': lines('a', 'old bug') } } },
    { n: 1, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy') } }] },
    { n: 2, at: B_DAY, commits: [{ subject: 'fix: f', files: { 'src/f.txt': lines('alpha', 'fixed') } }] },
    { n: 3, at: '2026-01-12T12:00:00Z', commits: [{ subject: 'fix: g', files: { 'src/g.txt': lines('a', 'fixed') } }] },
  ]);
  const jsonFile = path.join(tmp('out'), 'run.json');
  const r = await cli(['--range', '1..3', '--repo', 'o/r', '--json', jsonFile], { git: b.git, gh: fakeGh(b) });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /fix PRs: 2/);
  assert.match(r.out, /escape rows: 1/);
  assert.match(r.out, /no blame target: 1 \(outside-window 1\)/);
  const j = JSON.parse(readFileSync(jsonFile, 'utf8'));
  assert.equal(j.totals.noTarget.total, 1);
  assert.deepEqual(j.totals.noTarget.byReason, { 'outside-window': 1 });
  assert.equal(j.rows.length, 1);
});
