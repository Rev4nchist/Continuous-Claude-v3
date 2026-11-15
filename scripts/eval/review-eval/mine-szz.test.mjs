// Tests for scripts/eval/review-eval/mine-szz.mjs: the SZZ miner for Gold A rows, clean controls and the baseline copy.
// Everything runs on synthetic temp git repos with a fake gh and a fake judge. No live gh, no live `claude -p`, no live state.
// PR numbers are synthetic. Run: node --test scripts/eval/review-eval/mine-szz.test.mjs
//
// Failure modes and the change that would break each test:
//   S01 a fix with a non-fix subject gives a row, or a real fix gives none  -> mine from git subjects, or ignore the state rows
//   S02 an origin commit of the fix PR itself is kept as a target           -> drop the own-PR filter in keepBlamed
//   S03 an open-bug origin maps to the latest main merge, not the earliest  -> take the last of the gh list
//   S04 a line moved before the head is not found by origin                 -> map by line number, not by (sha, origin line)
//   S04b a file moved before the fix is read as a mapped line              -> drop the cat-file check in headLines
//   S05 a cross-file fix gives a row, or is not counted                     -> keep every blamed line, drop the unmapped bucket
//   S06 CodeRabbit comment rule: slack, time, file, user, read failure      -> change crDrops or fail open on a failed read
//   S07 one gh failure kills the other pairs, or is read as "no row"        -> throw out of the pair loop, or swallow it
//   S08 a bad judge answer stores a label                                   -> loosen parseAnswer
//   S09 the daily slot is ignored, or counts the wrong rows                 -> change laneCallsToday or the in-run counter
//   S10 a row that fails validateRow is written, or its values are printed  -> skip validateOutputs, print values
//   S11 the split is not the one of config.json                             -> change goldRowOf
//   S12 suite regression vs capability                                      -> change isRegression
//   S12b the engine record reader takes a trace file or an engine run      -> drop a skip rule in readEngineRecords
//   S12c a capability row with an engine record counts as "no record"      -> count every capability row, or drop the line
//   S12d a no-record count takes rows with a record, or skips the PR key   -> invert the record check, or match the fix PR
//   S13 controls: blamed, near a failed fix, near an unmapped fix, under 30 -> change buildControls or the bar
//   S13c a no-round control is dropped, or kept with no head or a bad one  -> drop the merged-head branch, or skip the sha check
//   S13e a failed round read counts as "no round", or reads a merged head  -> merge roundFailed into noRoundHead
//   S13h the merged head comes from gh, or the gold gate refuses it         -> read the head from the rounds, or revert gold.mjs
//   R18b the report hides the group 2 start or the merged-head count        -> change the controls line or drop NOTES.mergedHead
//   S13f group 2 does not start 2026-06-01 (06-15 out, or 05-31 in)       -> move GROUP2_FROM
//   S13g the report does not name the group 2 start                       -> drop NOTES.group2From
//   S14 the baseline copy is not byte-equal, or a risk band is missing      -> change the copy or baselineProblems
//   S15 a dry run writes, or a write is not all-or-nothing                  -> change main
//   S16 a PR number reaches stdout, the report or the judge prompt          -> change scrubPrs or the report text
//   S17 no args or --help touch git, gh or the file system                  -> parse args after the walk
//   S18 gold-a holds a noise or unclear row                                 -> drop the verdict filter
//   S19 round is not the rank of the head in the CodeRabbit rounds          -> change the rank, or keep a head that is not in the list
//   S20 an oversize hunk shares a call, or a batch passes 10 pairs          -> change batchItems
//   S21 the label cache is not reused, or written without the allow flag    -> change the cache read or write guard
//   L01 the fix subject (the PR title) reaches the judge prompt             -> put the "Fix subject:" line back in itemText
//   L02 a prompt with a PR number, a fix title or a fix sha is sent         -> drop a check in promptGuard, or call the judge first
//   L02b a leaking item alone is sent, takes a slot or is labelled          -> drop the per-item guard (cleanItems)
//   R3-m2 a batch prompt that leaks only when joined is sent or takes a slot -> drop the whole-prompt guard, or push the slot row first
//   L02c one leaking item takes the clean items of its batch down with it   -> guard only the whole batch prompt (drop cleanItems)
//   L03 a fix sha prefix in a diff line reaches the judge                   -> drop maskShas, or mask only full shas
//   L04 the whole fix diff goes in each pair, so a big diff calls alone     -> keep f.hunk whole in runItem
//   L04b hunks cut by head lines pick the wrong hunk after a shift          -> pass the head lines to cutHunks
//   L04c a hunk is split, an adjacent one is lost, or no hunk is kept       -> change the overlap, the slack or the nearest rule
//   L05 an old judge-version label is reused for the new prompt             -> keep JUDGE_VERSION at szz-label-v1
//   L06 the usage or the report hides the gold line numbers or the cut      -> drop the notes
//   P01 the default daily limit is not 30                                   -> keep SZZ_DAILY_CALLS at 6
//   P02 --daily-calls is ignored, or a bad value runs                       -> drop the flag or loosen checkArgs
//   P03 --stop-after is ignored, drops the labels it got, or misnames a stop -> change the label-stage checks
//   P04 a shared-cap refusal is retried, hidden, or the cap is bypassed     -> keep calling after reason cap, or pass a cap to runJudge
// Critic round 3 (R3-<finding>):
//   R3-M1 a fix-chains input that starts after the first group 2 merge writes  -> drop the coverage gate or its dry-run note
//   R3-M2 a fix title with a fix sha prefix escapes the masked-prompt guard    -> keep titles unmasked in leakTerms
//   R3-m1 a lock refusal keeps its slot row, is not retried, or does not stop  -> keep the own row for a refusal with no id
//   R3-m4 a title that is template text refuses every prompt, or is not counted -> drop the template filter or its note
//   R3-m5 an escape row with a bad fixSha or mergeSha reaches git              -> drop the sha check in candidateRows
//   R3-n1 a cache hit reports this run's hunk cut, not the labelled prompt's   -> keep the run counts on a cache hit
//   R3-n2 a 64-hex fix sha in a diff line is not masked                        -> keep HEX_RUN at 7 to 40
//   R3-n3 a non-tip commit of a fix PR reaches the judge unmasked              -> add only fixSha and mergeSha to the leak terms
//   M10b the run's lineSlack does not reach the diff cut                       -> pass 0 or a fixed slack to cutHunks in runItem
// Control mining (--control-since, seat ruling):
//   C01 a June fix before --since does not feed the unmapped-fix rule          -> drop the control pass, or start it at --since
//   C02 the control pass adds candidates, labels or leak terms                 -> mine the control rows through minePair or mineAll
//   C03 a control window after the group 2 start writes                        -> drop the gate, or compare the wrong way
//   C04 a bad --control-since runs                                             -> drop the date check of checkArgs
// Seat diff read of PR 582 (D<item><case>):
//   D1a a failed cat-file read (a time-out) is read as file-gone, so --write goes on -> read any non-zero cat-file status as file-gone
//   D1b git's missing-path text is no longer file-gone                       -> match no stderr text, or the wrong text
//   D2a a missing escapes file reads as 0 rows and --write replaces gold-a       -> drop the missing-file check of the write gate
//   D2b a damaged escapes line is skipped with no count and --write goes on   -> drop the parse check of the write gate
//   D2c --write replaces gold-a with fewer counted rows than the done-when bar -> drop the counted bar, or move it off 15
//   D3a a new label cache row has no promptSha, or a hash of another text     -> drop promptSha, or hash the unmasked or batch text
//   D3b a changed prompt with the same key reuses the old label                -> ignore promptSha on the cache read
//   D3c an old cache row with no promptSha is asked again                     -> treat a missing promptSha as a miss
//   D4a a hit with no promptSha is not back-filled, filled twice, or asked    -> drop the back-fill, skip the hasSha check, or ask the judge
//   D4b the back-fill writes without --allow-label-cache-write                -> drop the flag check of the back-fill
//   D4c after the back-fill a changed prompt for the key is still a hit       -> back-fill a row with no promptSha, or let the old row win
//   D4d two rows of one key: another row than the last one wins               -> prefer a row by promptSha, or keep the first row
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { escapesForPr, listMergedPrs, loadRouterConfig, makeGit, writeRows } from './fix-chains.mjs';
import { loadCleanControls, loadGold, validateRow } from './gold.mjs';
import {
  BATCH_SIZE, CONTROLS_MIN, HUNK_LIMIT, LEDGER_TAG, SZZ_DAILY_CALLS, baselineProblems, batchItems, buildControls, buildPrompt, crDrops, goldRowOf,
  isRegression, keepBlamed, laneCallsToday, main, mapToHead, parseAnswer, parsePorcelain, readEngineRecords, runsOf, scrubPrs, validateOutputs,
} from './mine-szz.mjs';
// The round 2 exports are read through the namespace, so a missing export fails only its own test.
import * as szz from './mine-szz.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const made = [];
const tmp = (label = 'szz') => { const d = mkdtempSync(path.join(os.tmpdir(), `mine-szz-${label}-`)); made.push(d); return d; };
// Retries: Windows can hold a just-closed file (EBUSY, EPERM) for a moment.
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

// ---------- synthetic repos: PRs are merge commits on main, built with one git fast-import ----------

const EMPTY_CFG = path.join(tmp('cfg'), 'gitconfig');
writeFileSync(EMPTY_CFG, '');
const T0 = '2026-07-01T00:00:00Z';
const gitEnv = () => ({ ...process.env, GIT_CONFIG_GLOBAL: EMPTY_CFG, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_AUTHOR_DATE: T0, GIT_COMMITTER_DATE: T0 });
const sh = (dir, args, input) => {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir, env: gitEnv(), encoding: 'utf8', windowsHide: true, input });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const lines = (...xs) => `${xs.join('\n')}\n`;
const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
const data = (s) => `data ${Buffer.byteLength(s)}\n${s}\n`;
const quoted = (p) => (p.startsWith(' ') ? `"${p}"` : p);
/** A file with text is written; a file with null is deleted. */
const fileCmds = (files) => Object.entries(files).map(([p, t]) => (t === null ? `D ${quoted(p)}\n` : `M 100644 inline ${quoted(p)}\n${data(t)}`)).join('');

/**
 * steps: [{ n, at, commits: [{ subject, files }] } | { direct: { at, subject, files } }] in history order.
 * Returns { dir, git, prs: { n: { mergeSha, shas, at } } }. A merge commit holds the final files of its PR.
 */
function buildRepo(steps) {
  const dir = tmp('repo');
  sh(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(dir, 'README.md'), 'x\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'chore: init']);
  return importSteps({ dir, git: makeGit(dir), prs: {} }, sh(dir, ['rev-parse', 'HEAD']), steps);
}

/** Adds steps on top of main of a built repo, so a file of a later step can name a sha of an earlier one. */
const extendRepo = (b, steps) => importSteps(b, sh(b.dir, ['rev-parse', 'main']), steps);

/** Imports steps from the commit `start` with one git fast-import, and adds their PRs to b.prs. */
function importSteps(b, start, steps) {
  const { dir } = b;
  let main = start;
  let mark = 0;
  let out = '';
  const marks = {};
  const prs = {};
  const commit = (ref, at, subject, from, files, merge) => {
    mark += 1;
    out += `commit ${ref}\nmark :${mark}\ncommitter t <t@x> ${unix(at)} +0000\n${data(subject)}from ${from}\n${merge ? `merge ${merge}\n` : ''}${fileCmds(files)}\n`;
    return `:${mark}`;
  };
  for (const s of steps) {
    if (s.direct) { main = commit('refs/heads/main', s.direct.at, s.direct.subject, main, s.direct.files); continue; }
    let from = main;
    const merged = {};
    const shaMarks = s.commits.map((c) => { from = commit(`refs/heads/pr${s.n}`, s.at, c.subject, from, c.files); Object.assign(merged, c.files); return from; });
    main = commit('refs/heads/main', s.at, `Merge pull request #${s.n} from x/pr${s.n}`, main, merged, from);
    prs[s.n] = { markList: shaMarks, markMerge: main, at: s.at };
  }
  const marksFile = path.join(tmp('marks'), 'marks');
  sh(dir, ['fast-import', '--quiet', '--force', `--export-marks=${marksFile}`], out);
  for (const l of readFileSync(marksFile, 'utf8').split('\n').filter(Boolean)) { const [m, sha] = l.split(' '); marks[m] = sha; }
  sh(dir, ['reset', '-q', '--hard', 'main']);
  for (const p of Object.values(prs)) { p.shas = p.markList.map((m) => marks[m]); p.mergeSha = marks[p.markMerge]; }
  Object.assign(b.prs, prs);
  return b;
}

const A_DAY = '2026-10-10T10:00:00Z';
const B_DAY = '2026-10-11T10:00:00Z';
const FIX_AT = B_DAY;
/** One blamed PR (n=11) with src/f.txt, one fix PR (n=12) that changes the "buggy" line. */
const small = (over = {}) => buildRepo([
  { n: 11, at: A_DAY, commits: [{ subject: 'feat: add f', files: { 'src/f.txt': lines('alpha', 'buggy', 'omega') } }] },
  { n: 12, at: B_DAY, commits: [{ subject: over.fixSubject ?? 'fix: correct f (#9001)', files: { 'src/f.txt': lines('alpha', 'fixed', 'omega') } }] },
]);

const bulkSteps = () => {
  const steps = [];
  for (let i = 0; i < 66; i += 1) {
    const at = new Date(Date.parse('2026-08-01T12:00:00Z') + i * 86_400_000).toISOString();
    steps.push({ n: 100 + i, at, commits: [{ subject: 'feat: bulk', files: { [`bulk/${100 + i}.txt`]: `x${100 + i}\n` } }] });
    if (i === 24) steps.push({ n: 170, at: '2026-08-25T18:00:00Z', commits: [{ subject: 'fix: touch a bulk file', files: { 'bulk/120.txt': lines('x120', 'fixed') } }] });
  }
  return steps;
};

/** The big repo: 66 bulk PRs inside the control window, PR 21 with three files, a direct commit that shifts a line, fix PR 22, and a later fix PR 171. */
const bigSteps = () => [
  ...bulkSteps(),
  { n: 21, at: A_DAY, commits: [
    { subject: 'feat: add files', files: { 's/a.txt': lines('keep-a', 'bad-a', 'end-a'), 's/b.txt': lines('keep-b', 'bad-b', 'end-b'), 's/c.txt': lines('keep-c', 'bad-c', 'end-c') } },
    { subject: 'feat: add header', files: { 's/a.txt': lines('h1', 'h2', 'keep-a', 'bad-a', 'end-a') } },
  ] },
  { direct: { at: '2026-10-10T12:00:00Z', subject: 'chore: prepend to b', files: { 's/b.txt': lines('p1', 'p2', 'p3', 'keep-b', 'bad-b', 'end-b') } } },
  { n: 22, at: B_DAY, commits: [{ subject: 'fix: repair a b c (#9001)', files: { 's/a.txt': lines('h1', 'h2', 'keep-a', 'good-a', 'end-a'), 's/b.txt': lines('p1', 'p2', 'p3', 'keep-b', 'good-b', 'end-b'), 's/c.txt': lines('keep-c', 'good-c', 'end-c') } }] },
  { n: 171, at: '2026-10-12T00:00:00Z', commits: [{ subject: 'fix: partial', files: { 'p/171.txt': 'p\n' } }] },
];
let bigCache = null;
const big = () => (bigCache ??= buildRepo(bigSteps()));

// ---------- state, gh, judge ----------

const BANDS = ['LOW', 'MID', 'ELEVATED', 'HIGH', 'CRITICAL'];
const baselineText = (bands = BANDS) => `${JSON.stringify(bands.map((band) => ({ band, prsMerged: 5, escapes: 1, escapeRows: 1, allRows: 2, window: { from: 'a', to: 'b', toSha: 'c' } })), null, 2)}\n`;
const escRow = (b, { fixPr, blamedPr, fixIdx = 0, band = 'HIGH', cause = 'wrong-surfaces', primary = true, fixMergedAt }) => ({
  mergeSha: b.prs[fixPr].mergeSha, pr: fixPr, band, blamedPr, blamedMergeSha: b.prs[blamedPr].mergeSha, fixSha: b.prs[fixPr].shas[fixIdx], fixMergedAt: fixMergedAt ?? b.prs[fixPr].at, cause, primary,
});
function stateWith(rows, baseline = baselineText()) {
  const dir = tmp('state');
  writeFileSync(path.join(dir, 'escapes.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  if (baseline !== null) writeFileSync(path.join(dir, 'escape-baseline.json'), baseline);
  return dir;
}
const bigRows = (b) => [
  escRow(b, { fixPr: 22, blamedPr: 21 }),
  // two old rows (before --since): they blame bulk PRs, so those PRs are no clean control. They are not mined.
  { ...escRow(b, { fixPr: 22, blamedPr: 100 }), fixMergedAt: '2026-07-15T00:00:00Z' },
  { ...escRow(b, { fixPr: 22, blamedPr: 101 }), fixMergedAt: '2026-07-15T00:00:00Z', primary: false },
];

const CR_USER = { login: 'coderabbitai[bot]', type: 'Bot' };
const pullsOf = (b) => Object.fromEntries(Object.entries(b.prs).flatMap(([n, p]) => p.shas.map((sha) => [sha, [{ number: Number(n), merged_at: p.at, merge_commit_sha: p.mergeSha }]])));
/** A fake gh for the routes of github.mjs (reviews, issue comments, commits, inline comments) and commits/<sha>/pulls. w overrides per route. */
function fakeGh(b, w = {}) {
  const calls = [];
  const pulls = { ...pullsOf(b), ...(w.pulls ?? {}) };
  const gh = async (args) => {
    calls.push(args);
    const route = args.at(-1);
    const sha = /commits\/([0-9a-f]+)\/pulls$/.exec(route)?.[1];
    if (sha) return pulls[sha] ?? [];
    const m = /\/(pulls|issues)\/(\d+)\/(reviews|comments|commits)\?/.exec(route);
    if (!m) throw new Error(`fake gh: unknown route ${route}`);
    const pr = Number(m[2]);
    if (m[1] === 'pulls' && m[3] === 'comments') {
      if (w.failComments?.has(pr)) throw new Error('gh: network down');
      return [w.comments?.[pr] ?? []];
    }
    if (m[1] === 'pulls' && m[3] === 'reviews') {
      if (w.failReviews?.has(pr)) throw new Error('gh: network down');
      const shas = w.reviews?.[pr] ?? (b.prs[pr] ? [b.prs[pr].shas.at(-1)] : []);
      return [shas.map((commit_id, i) => ({ id: pr * 100 + i, user: CR_USER, body: 'Actionable comments posted: 1', commit_id, submitted_at: `2026-10-0${i + 1}T00:00:00Z` }))];
    }
    return [[]];
  };
  return Object.assign(gh, { calls });
}

/** A fake judge: answers every "### Pair k" in the prompt with the k-th entry of verdicts, and records the prompts. */
function fakeJudge(verdicts, { raw } = {}) {
  const prompts = [];
  const judge = async (prompt) => {
    prompts.push(prompt);
    const n = [...prompt.matchAll(/^### Pair (\d+)/gm)].length;
    const answer = Array.from({ length: n }, (_, i) => ({ pair: i + 1, ...(verdicts[i] ?? verdicts[0]) }));
    return { ok: true, result: raw ?? JSON.stringify(answer) };
  };
  return Object.assign(judge, { prompts });
}
const REAL = (severity = 'major') => ({ verdict: 'real', severity });
/** --label with a daily limit of 6 for this run: the slot tests below were written for six calls a day. */
const SIX = ['--label', '--daily-calls', '6'];
const NOW = Date.parse('2026-11-13T18:00:00Z');
const CFG = { holdoutExclude: [21, 11], reserve: [], lineSlack: 3 };
const NO_DATA = { prs: [], findings: [] };

/**
 * countedMin 0: the synthetic repos hold 0 to 3 counted rows, under the real bar (COUNTED_MIN, 15). The D2c test passes
 * countedMin: undefined, so main uses the real bar.
 */
async function run(argv, deps = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, { stdout: (s) => out.push(String(s)), stderr: (s) => err.push(String(s)), cfg: CFG, readRecords: () => [], now: () => NOW, env: {}, dataset: NO_DATA, ledgerPath: path.join(tmp('ledger'), 'ledger.jsonl'), countedMin: 0, sleep: async () => {}, ...deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
/** Common args and deps for one repo. */
const setup = (b, { rows, baseline, extra = [], deps = {} } = {}) => {
  const state = stateWith(rows, baseline);
  const gold = path.join(tmp('gold'), 'gold');
  return { state, gold, argv: ['--since', '2026-08-01', '--repo', 'o/r', '--state-dir', state, '--gold-dir', gold, '--json', ...extra], deps: { git: b.git, gh: fakeGh(b), ...deps } };
};
const report = async (b, opts) => { const s = setup(b, opts); const r = await run(s.argv, s.deps); return { ...s, ...r, json: r.out.startsWith('{') ? JSON.parse(r.out) : null }; };

// ---------- pure helpers ----------

test('S-unit: parsePorcelain reads one header per line, even a 64-digit sha, and no content line (breaks if the pattern drops ^, the tab rule or 64 digits)', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(64);
  const text = [`${a} 2 4 1`, 'author t', 'summary s', `\t${'c'.repeat(40)} 9 9`, `${b} 1 5`, '\tplain'].join('\n');
  assert.deepEqual(parsePorcelain(text), [{ sha: a, origLine: 2, line: 4 }, { sha: b, origLine: 1, line: 5 }]);
  assert.deepEqual(parsePorcelain(''), []);
});

test('S-unit: runsOf groups adjacent lines and sorts them (breaks if adjacency or the sort is wrong)', () => {
  assert.deepEqual(runsOf([8, 2, 3, 4, 7, 8]), [{ line: 2, endLine: 4 }, { line: 7, endLine: 8 }]);
  assert.deepEqual(runsOf([]), []);
});

test('S02: keepBlamed keeps only commits of the blamed PR and drops an origin inside the fix PR (breaks if the fix-PR filter is removed)', () => {
  const blamed = [{ sha: 'p1', origLine: 1, line: 1 }, { sha: 'f1', origLine: 2, line: 2 }, { sha: 'x1', origLine: 3, line: 3 }];
  const r = keepBlamed(blamed, new Set(['p1', 'f1']), new Set(['f1']));
  assert.deepEqual(r.kept.map((k) => k.sha), ['p1']);
  assert.equal(r.own, 1);
});

test('S04: mapToHead finds a line by its origin, and counts a line that is gone before the head (breaks if it maps by line number)', () => {
  const kept = [{ sha: 'p1', origLine: 2, line: 9 }, { sha: 'p1', origLine: 5, line: 12 }];
  const head = [{ sha: 'p1', origLine: 2, line: 2 }, { sha: 'p1', origLine: 7, line: 12 }];
  assert.deepEqual(mapToHead(kept, head), { lines: [2], missing: 1 });
});

test('S16-unit: scrubPrs removes every PR reference form and leaves other text (breaks if a pattern is dropped)', () => {
  const dirty = 'fix: x (#4242)\nsee #4242 and pull/4242 and https://h/o/r/pull/4242\nMerge pull request #4242 from a/b\nPR 4242 and pull request #4242';
  const clean = scrubPrs(dirty);
  assert.equal(/4242/.test(clean), false, clean);
  assert.equal(clean.split('\n')[0], 'fix: x ', 'the (#N) suffix goes with its brackets');
  assert.equal(scrubPrs('const a = 12; // #todo'), 'const a = 12; // #todo');
});

test('G5: the colon forms (PR: N, PR:#N, pull request: N) and the GH-N form are scrubbed and refused by the guard; plain text with a colon and a number is not (breaks if the colon or GH- form is dropped from PR_PATTERNS)', () => {
  const leak = { titles: [], shas: [] };
  for (const form of ['PR: 4242', 'PR:#4242', 'pr : 4242', 'pull request: 4242', 'Pull Request:#4242', 'GH-4242', 'gh-4242', 'see GH-4242.']) {
    assert.equal(/4242/.test(scrubPrs(form)), false, `scrub: ${form}`);
    assert.equal(szz.promptGuard(`text ${form} text`, leak), 'pr-number', `guard: ${form}`);
  }
  for (const plain of ['retries: 3', 'timeout: 4242 ms', 'sprint: 4242', 'PRIME 4242', 'ugh-4242']) assert.equal(szz.promptGuard(plain, leak), null, `not a PR form: ${plain}`);
});

test('S20: batchItems puts up to 10 pairs in a call and an oversize hunk alone (breaks if the size cap or the oversize rule changes)', () => {
  const small = (i) => ({ id: i, hunk: 'x'.repeat(10) });
  const items = [...Array.from({ length: 12 }, (_, i) => small(i)), { id: 'big', hunk: 'y'.repeat(HUNK_LIMIT + 1) }, small(99)];
  const batches = batchItems(items);
  assert.deepEqual(batches.map((b) => b.length), [BATCH_SIZE, 2, 1, 1]);
  assert.equal(batches[2][0].id, 'big');
  assert.equal(BATCH_SIZE, 10);
  const mid = batchItems([small(1), { id: 'big', hunk: 'y'.repeat(HUNK_LIMIT + 1) }, small(2)]);
  assert.deepEqual(mid.map((b) => b.map((i) => i.id)), [[1], ['big'], [2]]);
});

test('S08: parseAnswer takes exact JSON and refuses prose, a missing or extra pair, a duplicate and a bad enum (breaks if any check is loosened)', () => {
  const ok = JSON.stringify([{ pair: 2, verdict: 'noise', severity: 'minor' }, { pair: 1, verdict: 'real', severity: 'major' }]);
  assert.deepEqual(parseAnswer(ok, 2), [{ verdict: 'real', severity: 'major' }, { verdict: 'noise', severity: 'minor' }]);
  assert.deepEqual(parseAnswer(`\`\`\`json\n${ok}\n\`\`\``, 2)?.length, 2, 'one surrounding code fence is allowed');
  const bad = [
    'not json', `Here you go: ${ok}`, '{"pair":1}', '[]',
    JSON.stringify([{ pair: 1, verdict: 'real', severity: 'major' }]),
    JSON.stringify([{ pair: 1, verdict: 'real', severity: 'major' }, { pair: 3, verdict: 'real', severity: 'major' }]),
    JSON.stringify([{ pair: 1, verdict: 'real', severity: 'major' }, { pair: 1, verdict: 'real', severity: 'major' }]),
    JSON.stringify([{ pair: 1, verdict: 'maybe', severity: 'major' }, { pair: 2, verdict: 'real', severity: 'major' }]),
    JSON.stringify([{ pair: 1, verdict: 'real', severity: 'info' }, { pair: 2, verdict: 'real', severity: 'major' }]),
    JSON.stringify([{ pair: '1', verdict: 'real', severity: 'major' }, { pair: 2, verdict: 'real', severity: 'major' }]),
  ];
  for (const text of bad) assert.equal(parseAnswer(text, 2), null, text);
});

test('S09-unit: laneCallsToday counts only start rows of this lane today, by the Chicago day (breaks if the tag, the phase or the day changes)', () => {
  let k = 0;
  const row = (over) => ({ phase: 'start', purpose: 'eval-judge', sessionId: `${LEDGER_TAG}:abc`, ts: '2026-11-13T15:00:00Z', id: `i${(k += 1)}`, ...over });
  const today = [row({}), row({ ts: '2026-11-13T06:00:00Z' }), row({ ts: '2026-11-14T05:59:00Z' })]; // Chicago Nov 13 runs 06:00Z to 05:59Z
  const other = [
    row({ ts: '2026-11-13T05:59:00Z' }), row({ ts: '2026-11-14T06:00:00Z' }), // the minute before and after the day
    row({ sessionId: 'other-session' }), row({ purpose: 'other' }), row({ phase: 'end' }),
  ];
  assert.equal(laneCallsToday([...today, ...other], NOW), 3);
  assert.equal(SZZ_DAILY_CALLS, 30, 'the default daily limit (Dave, pace decision)');
});

test('S06-unit: crDrops drops a CodeRabbit line comment on the file within the slack, made before the fix merge (breaks if slack, time, file or user rule changes)', () => {
  const cand = { file: 's/a.txt', line: 10, endLine: 10, fixMergedAt: '2026-10-11T10:00:00Z' };
  const c = (over) => ({ user: CR_USER, path: 's/a.txt', line: 10, created_at: '2026-10-10T10:00:00Z', ...over });
  assert.equal(crDrops([c({})], cand, 3), true);
  assert.equal(crDrops([c({ line: 13 })], cand, 3), true, 'slack edge is in');
  assert.equal(crDrops([c({ line: 14 })], cand, 3), false, 'one past the slack is out');
  assert.equal(crDrops([c({ line: null, original_line: 8 })], cand, 3), true, 'original_line counts when line is null after a push');
  assert.equal(crDrops([c({ created_at: '2026-10-11T10:00:01Z' })], cand, 3), false, 'after the fix merge');
  assert.equal(crDrops([c({ path: 's/b.txt' })], cand, 3), false, 'other file');
  assert.equal(crDrops([c({ user: { login: 'someone', type: 'User' } })], cand, 3), false, 'other user');
  assert.equal(crDrops([c({ line: 14 })], { ...cand, endLine: 11 }, 3), true, 'a run is widened by the slack past its last line');
  assert.equal(crDrops([c({ created_at: '2030-01-01T00:00:00Z' })], { ...cand, fixMergedAt: undefined }, 3), true, 'no fix (open bug): any time');
});

test('S12: isRegression is true only for an engine record of the blamed PR with a finding on the file near the line (breaks if pr, file or slack is ignored)', () => {
  const rec = (pr, file, s, e) => ({ pr, findings: [{ file, startLine: s, endLine: e }] });
  const t = { pr: 21, file: 's/a.txt', line: 20, endLine: 21 };
  assert.equal(isRegression([rec(21, 's/a.txt', 19, 19)], t, 3), true);
  assert.equal(isRegression([rec(21, 's/a.txt', 24, 30)], t, 3), true, 'slack on the far side');
  assert.equal(isRegression([rec(21, 's/a.txt', 25, 30)], t, 3), false);
  assert.equal(isRegression([rec(22, 's/a.txt', 20, 20)], t, 3), false, 'other PR');
  assert.equal(isRegression([rec(21, 's/b.txt', 20, 20)], t, 3), false, 'other file');
  assert.equal(isRegression([{ pr: 21 }], t, 3), false, 'a record with no findings');
});

test('S11: goldRowOf takes the split from config.json: holdoutExclude is dev, reserve is reserve, the rest is holdout (breaks if setOf is not used)', () => {
  const cfg = { holdoutExclude: [5], reserve: [{ pr: 7, answerKeySource: 'x' }], lineSlack: 3 };
  const cand = (pr) => ({ blamedPr: pr, round: 2, head: 'd'.repeat(40), file: 'a.txt', line: 3, fixSha: 'f'.repeat(40), fixMergeSha: 'e'.repeat(40), blamedMergeSha: 'c'.repeat(40), cause: 'unclassified', primary: true, hunksShown: 1, hunksLeftOut: 2 });
  const label = { verdict: 'real', severity: 'major' };
  assert.deepEqual([5, 7, 9].map((pr) => goldRowOf({ cand: cand(pr), label, n: 1, suite: 'capability', cfg }).split), ['dev', 'reserve', 'holdout']);
  const row = goldRowOf({ cand: cand(5), label, n: 3, suite: 'regression', cfg });
  assert.deepEqual(validateRow(row), []);
  assert.deepEqual(row.target, { pr: 5, round: 2, sha40: 'd'.repeat(40) });
  assert.deepEqual(row.labels, [{ by: 'claude-opus-5-5', verdict: 'real', judgeVersion: 'szz-label-v2' }]);
  assert.deepEqual(row.provenance, { miner: 'mine-szz-v1', fixSha: 'f'.repeat(40), fixMergeSha: 'e'.repeat(40), blamedMergeSha: 'c'.repeat(40), cause: 'unclassified', primary: true, crBefore: false, hunksShown: 1, hunksLeftOut: 2 });
  const open = goldRowOf({ cand: { ...cand(5), kind: 'open-bug', hunksShown: 0, hunksLeftOut: 0 }, label, suite: 'capability', cfg });
  assert.deepEqual(open.provenance, { miner: 'mine-szz-v1', kind: 'open-bug', blamedMergeSha: 'c'.repeat(40), hunksShown: 0, hunksLeftOut: 0 });
  assert.equal(row.linkType, 'within-hunk');
  assert.match(row.id, /^A:[0-9a-f]{12}$/);
  const twin = goldRowOf({ cand: { ...cand(5), blamedPr: 9 }, label, n: 7, suite: 'regression', cfg });
  assert.equal(twin.id, row.id, 'the id comes from the shas, the file and the line: the PR number is not in it');
});

test('S10-unit: validateOutputs returns the problem lines of a bad row and of a bad control, never a value (breaks if validateRow or loadCleanControls is skipped, or a value is printed)', () => {
  const good = goldRowOf({ cand: { blamedPr: 5, round: 1, head: 'd'.repeat(40), file: 'a.txt', line: 3, fixSha: 'f'.repeat(40), fixMergeSha: 'e'.repeat(40), blamedMergeSha: 'c'.repeat(40), cause: 'unclassified', primary: true, hunksShown: 1, hunksLeftOut: 0 }, label: { verdict: 'real', severity: 'major' }, n: 1, suite: 'capability', cfg: CFG });
  const control = { id: 'K:1', split: 'holdout', target: { pr: 3, round: 1, sha40: 'a'.repeat(40) }, provenance: { why: 'dataset-no-finding' } };
  assert.deepEqual(validateOutputs({ goldRows: [good], controls: [control] }), []);
  const bad = validateOutputs({ goldRows: [{ ...good, file: ' secret-name.txt' }], controls: [{ ...control, split: 'bogus-split-value' }] });
  assert.ok(bad.some((p) => /file/.test(p)), bad.join('\n'));
  assert.ok(bad.some((p) => /split/.test(p)), bad.join('\n'));
  assert.equal(bad.some((p) => /secret-name/.test(p)), false, 'no value in a problem line');
});

test('S14-unit: baselineProblems wants one row for each of the five risk bands (breaks if a band is not checked)', () => {
  assert.deepEqual(baselineProblems(Buffer.from(baselineText())), []);
  assert.ok(baselineProblems(Buffer.from(baselineText(['LOW', 'MID', 'HIGH', 'CRITICAL']))).some((p) => /ELEVATED/.test(p)));
  assert.ok(baselineProblems(Buffer.from(baselineText([...BANDS, 'LOW']))).some((p) => /LOW/.test(p)), 'a band twice');
  assert.ok(baselineProblems(Buffer.from('not json')).length > 0);
  assert.ok(baselineProblems(Buffer.from('{}')).length > 0);
  assert.ok(baselineProblems(null).length > 0, 'a missing file');
});

// ---------- controls ----------

const day = (n) => new Date(Date.parse('2026-08-01T12:00:00Z') + n * 86_400_000).toISOString();
const SHA = (n) => String(n).padStart(40, '0');
const merges40 = () => Array.from({ length: 40 }, (_, i) => ({ pr: 100 + i, mergeSha: SHA(100 + i), mergedAt: day(i) }));
/** A stand-in for the merged head that git gives (first-parent merge ^2): f and the last 39 digits of the merge sha. */
const HEAD_OF = (m) => `f${m.mergeSha.slice(1)}`;
const ctl = (over = {}) => buildControls({
  datasetPrs: [], merges: merges40(), escapeRows: [], failedFixShas: new Set(), noTargetFixShas: new Set(), filesOf: () => [], roundOf: async () => ({ round: 1, sha40: 'a'.repeat(40) }), headOf: HEAD_OF, cfg: CFG, ...over,
});

test('S13: buildControls removes a blamed PR, a PR in the 30 days before a failed fix, and a PR before an unmapped fix that shares a file; counts each rule (breaks if a rule, the 30 day edge or the order changes)', async () => {
  const rows = [{ blamedPr: 101, blamedMergeSha: SHA(101), primary: false }];
  const files = { [SHA(110)]: ['x.txt'], [SHA(125)]: ['x.txt'], [SHA(126)]: ['y.txt'] };
  const r = await ctl({
    datasetPrs: [135, 101, 999], escapeRows: rows,
    failedFixShas: new Set([SHA(130)]), noTargetFixShas: new Set([SHA(125)]), filesOf: (m) => files[m] ?? [],
  });
  const prs = r.controls.map((c) => c.target.pr);
  assert.equal(prs.includes(101), false, 'blamed (a non-primary row counts)');
  // PR 130 merged on day 30. The 30 days before it: days 0..30 are in (a PR on day 0 is exactly 30 days before: in).
  assert.equal([...Array(30).keys()].some((i) => prs.includes(100 + i)), false, 'every PR from day 0 to 29 is within 30 days of the failed fix');
  assert.equal(prs.includes(131), true, 'a PR after the failed fix stays');
  assert.equal(prs.includes(130), true, 'the failed fix PR itself stays');
  assert.equal(prs.includes(125), false, 'inside the failed window');
  assert.equal(r.counts.removedBlamed, 1);
  assert.equal(r.counts.removedFailedFix, 29, 'days 0..29 minus the blamed one');
  assert.equal(r.counts.notOnMain, 1);
  assert.equal(r.controls.find((c) => c.target.pr === 135).provenance.why, 'dataset-no-finding');
  assert.equal(r.controls.find((c) => c.target.pr === 131).provenance.why, 'pre-window-no-fix');
  assert.ok(r.controls.every((c) => /^K:[0-9a-f]{12}$/.test(c.id)), r.controls.map((c) => c.id).join(' '));
  assert.equal(new Set(r.controls.map((c) => c.id)).size, r.controls.length, 'ids are unique');
  assert.deepEqual(validateOutputs({ goldRows: [], controls: r.controls }), []);
});

test('S13b: the 30 day edge: 30 days before is in, 31 days is out; the unmapped-fix rule needs a shared file (breaks if the window compare or the file test changes)', async () => {
  const merges = [
    { pr: 1, mergeSha: SHA(1), mergedAt: '2026-08-02T00:00:00Z' }, { pr: 2, mergeSha: SHA(2), mergedAt: '2026-08-03T00:00:00Z' },
    { pr: 3, mergeSha: SHA(3), mergedAt: '2026-08-10T00:00:00Z' }, { pr: 4, mergeSha: SHA(4), mergedAt: '2026-08-11T00:00:00Z' },
    { pr: 9, mergeSha: SHA(9), mergedAt: '2026-09-02T00:00:00Z' },
  ];
  const files = { [SHA(1)]: ['a'], [SHA(2)]: ['a'], [SHA(3)]: ['b'], [SHA(4)]: null, [SHA(9)]: ['a'] };
  const r = await ctl({ merges, noTargetFixShas: new Set([SHA(9)]), filesOf: (m) => files[m] });
  const prs = r.controls.map((c) => c.target.pr).sort();
  // Fix PR 9 is at 09-02. PR 1 (08-02) is exactly 31 days before: out of the window, stays. PR 2 (08-03) is 30 days: in, shares file a: removed.
  // PR 3 is in the window but shares no file: stays. PR 4 has unknown files: removed (fail closed).
  assert.deepEqual(prs, [1, 3, 9]);
  assert.equal(r.counts.removedUnmappedFix, 2);
});

test('S13e: a failed round read drops the control and counts roundFailed, and asks no merged head; no round keeps it on the merged head (breaks if a gh failure reads as "no round")', async () => {
  const asked = [];
  const headOf = (m) => { asked.push(m.pr); return HEAD_OF(m); };
  const r = await ctl({ merges: merges40().slice(0, 3), headOf, roundOf: async (pr) => { if (pr === 101) throw new Error('gh down'); return pr === 102 ? null : { round: 1, sha40: 'a'.repeat(40) }; } });
  assert.deepEqual(r.controls.map((c) => c.target.pr), [100, 102]);
  assert.equal(r.counts.roundFailed, 1);
  assert.equal(r.counts.noRoundHead, 1);
  assert.deepEqual(asked, [102], 'the merged head is read only for a control with no round, never after a failed read');
});

test('S12b: readEngineRecords reads <branch>/<head>/<run>.json with pr and findings, and skips trace files, the engine and cli-pairs folders, bad JSON and files with no findings (breaks if a skip rule is dropped)', () => {
  const dir = tmp('records');
  const put = (rel, body) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body)); };
  const rec = (pr) => ({ pr, findings: [{ file: 'a.txt', startLine: 1, endLine: 2 }] });
  put('feat-x/aaa/run1.json', rec(5));
  put('feat-x/aaa/run1.trace.json', rec(6));
  put('feat-x/aaa/bad.json', 'not json');
  put('feat-x/aaa/nofindings.json', { pr: 8 });
  put('feat-x/bbb/run2.json', rec(7));
  put('engine/ccc/run3.json', rec(9));
  put('cli-pairs/ddd/run4.json', rec(10));
  put('cli-pairs/sweep-runs.jsonl', 'x');
  assert.deepEqual(readEngineRecords(dir).map((r) => r.pr).sort(), [5, 7]);
  assert.deepEqual(readEngineRecords(path.join(dir, 'missing')), []);
});

test('S04b: a file moved by a direct commit after the PR merged is unmapped file-gone, with no label call (breaks if a missing head file is read as a line, or is not counted)', async () => {
  const b = buildRepo([
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: add f', files: { 'src/f.txt': lines('alpha', 'buggy', 'omega') } }] },
    { direct: { at: '2026-10-10T12:00:00Z', subject: 'chore: move f', files: { 'src/f.txt': null, 'src/g.txt': lines('alpha', 'buggy', 'omega') } } },
    { n: 12, at: B_DAY, commits: [{ subject: 'fix: correct g (#9001)', files: { 'src/g.txt': lines('alpha', 'fixed', 'omega') } }] },
  ]);
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.unmapped['file-gone'], 1, JSON.stringify(r.json.unmapped));
  assert.equal(judge.prompts.length, 0);
});

test('S13c: a control with no round is kept on its merged head with round null and counted noRoundHead; no merged head drops it as noHead (breaks if a missing round is dropped, guessed, or kept with no head)', async () => {
  const merges = merges40().slice(0, 4);
  const headOf = (m) => (m.pr === 102 ? null : m.pr === 103 ? 'not-a-sha' : HEAD_OF(m));
  const r = await ctl({ merges, headOf, roundOf: async (pr) => (pr === 100 ? { round: 2, sha40: 'b'.repeat(40) } : null) });
  assert.deepEqual(r.controls.map((c) => c.target.pr), [100, 101]);
  assert.deepEqual(r.controls[0].target, { pr: 100, round: 2, sha40: 'b'.repeat(40) });
  assert.deepEqual(r.controls[0].provenance, { why: 'pre-window-no-fix' }, 'a control with a round has no head marker');
  assert.deepEqual(r.controls[1].target, { pr: 101, round: null, sha40: HEAD_OF(merges[1]) });
  assert.deepEqual(r.controls[1].provenance, { why: 'pre-window-no-fix', head: 'merged-head-no-round' });
  assert.deepEqual([r.counts.noRoundHead, r.counts.noHead, r.counts.group2, r.counts.total], [1, 2, 2, 2]);
  assert.deepEqual(validateOutputs({ goldRows: [], controls: r.controls }), [], 'gold.mjs takes the merged-head control');
  assert.equal(CONTROLS_MIN, 30);
});

test('S13h: end to end, a control whose CodeRabbit rounds miss its head is written with round null and the merged head from git, not a sha from gh (breaks if the head comes from gh or the gold gate refuses it)', async () => {
  const b = big();
  const ghSha = 'e'.repeat(40);
  const r = await bigRun([], { gh: fakeGh(b, { reviews: { 103: [ghSha] } }) });
  assert.equal(r.code, 0, r.err);
  const c = loadCleanControls(r.gold).find((x) => x.target.pr === 103);
  assert.ok(c, 'PR 103 is a control');
  assert.equal(c.target.round, null);
  assert.equal(c.target.sha40, b.prs[103].shas.at(-1), 'the second parent of the merge commit');
  assert.notEqual(c.target.sha40, ghSha);
  assert.deepEqual(c.provenance, { why: 'dataset-no-finding', head: 'merged-head-no-round' });
  assert.equal(r.json.controls.noRoundHead, 1);
  assert.equal(r.json.controls.total, 40);
});

test('S13f: group 2 starts 2026-06-01 by default: a PR merged 2026-06-15 is in it, a PR merged 2026-05-31 is not (breaks if GROUP2_FROM moves after 06-15, or to 05-31 or earlier)', async () => {
  const merges = [
    { pr: 1, mergeSha: SHA(1), mergedAt: '2026-05-31T12:00:00Z' },
    { pr: 2, mergeSha: SHA(2), mergedAt: '2026-06-15T12:00:00Z' },
  ];
  const r = await ctl({ merges });
  const prs = r.controls.map((c) => c.target.pr);
  assert.equal(prs.includes(2), true, `a PR merged 2026-06-15 is a group 2 control: ${JSON.stringify(r.counts)}`);
  assert.equal(prs.includes(1), false, 'a PR merged 2026-05-31 is before group 2');
  assert.equal(r.counts.group2, 1, JSON.stringify(r.counts));
  assert.equal(r.controls.find((c) => c.target.pr === 2).provenance.why, 'pre-window-no-fix');
});

test('S13g: the text and JSON report name the group 2 start (breaks if the note is dropped)', async () => {
  const b = small();
  const s = setup(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })] });
  const text = await run(s.argv.filter((a) => a !== '--json'), s.deps);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /group 2 starts 2026-06-01 \(Dave, 2026-11-14\)/);
  const json = await run(s.argv, s.deps);
  assert.equal(json.code, 0, json.err);
  assert.ok(JSON.parse(json.out).notes.includes('group 2 starts 2026-06-01 (Dave, 2026-11-14)'));
});

// ---------- end to end on temp repos ----------

test('S01: a test(x) subject gives no state row and so no pair; a fix(x) subject gives one pair (breaks if the miner invents rows from git subjects or ignores the state rows)', async () => {
  for (const [subject, pairs] of [['test(x): correct f (#9001)', 0], ['fix(x): correct f (#9001)', 1]]) {
    const b = small({ fixSubject: subject });
    const gh = fakeGh(b);
    const info = listMergedPrs({ git: b.git }).find((p) => p.pr === 12);
    const found = await escapesForPr(info, { git: b.git, gh, repo: 'o/r', routerConfig: loadRouterConfig() });
    const state = tmp('state');
    writeRows(state, found.rows, []);
    const argv = ['--since', '2026-08-01', '--repo', 'o/r', '--state-dir', state, '--gold-dir', path.join(tmp('g'), 'gold'), '--json'];
    const r = await run(argv, { git: b.git, gh });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).pairs, pairs, subject);
  }
});

test('S05: a fix that removes no line of the blamed PR gives no row and is counted as unmapped no-blamed-line (breaks if every blamed line is kept or the bucket is dropped)', async () => {
  const b = buildRepo([
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy') } }] },
    { n: 13, at: A_DAY, commits: [{ subject: 'feat: g', files: { 'src/g.txt': lines('one', 'two') } }] },
    { n: 12, at: B_DAY, commits: [{ subject: 'fix: g (#9001)', files: { 'src/g.txt': lines('one', 'fixed') } }] },
  ]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], deps: { judge: fakeJudge([REAL()]) }, extra: ['--label'] });
  assert.equal(r.json.pairs, 1);
  assert.equal(r.json.unmapped['no-blamed-line'], 1);
  assert.equal(r.deps.judge.prompts.length, 0, 'no label call for an unmapped pair');
});

test('S07: a gh failure on one pair gives no row for it, counts as failed, and the other pair stays (breaks if the failure is swallowed or ends the run)', async () => {
  const b = buildRepo([
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy', 'omega') } }] },
    { n: 13, at: A_DAY, commits: [{ subject: 'feat: g', files: { 'src/g.txt': lines('one', 'bad', 'two') } }] },
    { n: 12, at: B_DAY, commits: [{ subject: 'fix: both (#9001)', files: { 'src/f.txt': lines('alpha', 'fixed', 'omega'), 'src/g.txt': lines('one', 'good', 'two') } }] },
  ]);
  const judge = fakeJudge([REAL()]);
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11, primary: false }), escRow(b, { fixPr: 12, blamedPr: 13 })];
  const r = await report(b, { rows, extra: ['--label'], deps: { judge, gh: fakeGh(b, { failComments: new Set([11]) }) } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.pairs, 2);
  assert.equal(r.json.failed['comments'], 1, JSON.stringify(r.json.failed));
  assert.equal(judge.prompts.length, 1);
  assert.equal([...judge.prompts[0].matchAll(/^### Pair/gm)].length, 1, 'only the pair that read cleanly is labelled');
  assert.equal(r.json.labelled, 1);
});

/** A gh that fails the first `n` calls of one route (a TLS time-out), then answers like inner. */
const flakyGh = (inner, routeRe, n) => {
  let left = n;
  const gh = async (args) => { if (routeRe.test(args.at(-1)) && left > 0) { left -= 1; inner.calls.push(args); throw new Error('net/http: TLS handshake timeout'); } return inner(args); };
  return Object.assign(gh, { calls: inner.calls });
};

test('G7a: a gh read that times out twice and then answers is retried with a growing wait, and the pair is mined (breaks if a time-out fails the pair at once, or the wait does not grow)', async () => {
  const b = small();
  const waits = [];
  const gh = flakyGh(fakeGh(b), /\/pulls\/11\/comments\?/, 2);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge: fakeJudge([REAL()]), gh, sleep: async (ms) => { waits.push(ms); } } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.failed, {}, JSON.stringify(r.json.failed));
  assert.equal(r.json.labelled, 1);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] > 0 && waits[1] > waits[0], `waits ${waits}`);
});

test('G7b: a gh read that still fails after the last try is a failed pair, with a bounded number of tries (breaks if the retry loops on, or a failed read means no comment)', async () => {
  const b = small();
  const gh = flakyGh(fakeGh(b), /\/pulls\/11\/comments\?/, 99);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge: fakeJudge([REAL()]), gh, sleep: async () => {} } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.failed.comments, 1);
  assert.equal(r.json.labelled, 0);
  assert.equal(gh.calls.filter((a) => /\/pulls\/11\/comments\?/.test(a.at(-1))).length, szz.GH_TRIES);
  assert.ok(szz.GH_TRIES >= 2 && szz.GH_TRIES <= 5);
});

test('S06: a CodeRabbit line comment before the fix drops that row and counts it; a comment after the fix, on another file or far away does not (breaks if the drop is skipped or too wide)', async () => {
  const b = big();
  const head = b.prs[21].shas.at(-1);
  const comments = { 21: [
    { user: CR_USER, path: 's/a.txt', line: 6, created_at: '2026-10-10T20:00:00Z' }, // a: row line 4, within slack 3 -> drop
    { user: CR_USER, path: 's/b.txt', line: 2, created_at: '2026-10-12T20:00:00Z' }, // after the fix merge -> no drop
    { user: CR_USER, path: 's/c.txt', line: 40, created_at: '2026-10-10T20:00:00Z' }, // far -> no drop
  ] };
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: bigRows(b), extra: ['--label'], deps: { judge, gh: fakeGh(b, { comments, reviews: { 21: [head] } }) } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.crDropped, 1);
  assert.equal([...judge.prompts[0].matchAll(/^### Pair/gm)].length, 2);
});

test('S06b: a failed comments read writes no row for the pair, it fails closed (breaks if a failed read means "no CodeRabbit comment")', async () => {
  const b = big();
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: bigRows(b), extra: ['--label'], deps: { judge, gh: fakeGh(b, { failComments: new Set([21]) }) } });
  assert.equal(r.json.failed.comments, 1);
  assert.equal(judge.prompts.length, 0);
  assert.equal(r.json.labelled, 0);
});

test('S19: round is the 1-based rank of the head in the CodeRabbit rounds; a head not in the list, or an empty list, is unmapped (breaks if the rank or the unmapped rule changes)', async () => {
  const b = big();
  const [c1, head] = b.prs[21].shas;
  const s = setup(b, { rows: bigRows(b), extra: ['--label', '--allow-label-cache-write', '--write'], deps: { judge: fakeJudge([REAL()]), gh: fakeGh(b, { reviews: { 21: [c1, head] } }), fixChains: FIXES(b), dataset: DATASET } });
  const r = await run(s.argv, s.deps);
  assert.equal(r.code, 0, r.err);
  assert.ok(loadGold(s.gold).rows.length === 3 && loadGold(s.gold).rows.every((x) => x.target.round === 2 && x.target.sha40 === head));
  // A head that is not a round maps to the last earlier round (Q2 option b, seat 2026-11-15) only through B1 below; an empty list,
  // or a list whose rounds are not ancestors of the merged head (here: a commit of the later fix PR), stays unmapped.
  for (const reviews of [{ 21: [] }, { 21: [b.prs[22].shas[0]] }]) {
    const j = await report(b, { rows: bigRows(b), extra: ['--label'], deps: { judge: fakeJudge([REAL()]), gh: fakeGh(b, { reviews }) } });
    assert.equal(j.json.unmapped['head-not-reviewed'], 1, JSON.stringify(reviews));
    assert.equal(j.json.labelled, 0);
  }
});

test('B1: a merged head that is not a round maps to the last round before it when every blamed line is unchanged; the row targets that round, at its line numbers (breaks if option b is dropped, or the line keeps the head numbering)', async () => {
  const b = big();
  const [c1] = b.prs[21].shas; // c1 has a.txt without the two header lines: bad-a is line 2 there, line 4 at the head
  const s = setup(b, { rows: bigRows(b), extra: ['--label', '--allow-label-cache-write', '--write'], deps: { judge: fakeJudge([REAL()]), gh: fakeGh(b, { reviews: { 21: [c1] } }), fixChains: FIXES(b), dataset: DATASET } });
  const r = await run(s.argv, s.deps);
  assert.equal(r.code, 0, r.err);
  const rows = loadGold(s.gold).rows;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((x) => x.target.round === 1 && x.target.sha40 === c1), JSON.stringify(rows.map((x) => x.target)));
  assert.deepEqual(rows.map((x) => [x.file, x.line]).sort(), [['s/a.txt', 2], ['s/b.txt', 2], ['s/c.txt', 2]]);
  assert.ok(rows.every((x) => x.provenance.headMap === 'last-round'), 'the row says it was mapped to an earlier round');
  const rep = JSON.parse(r.out);
  assert.equal(rep.earlierRound, 3);
});

test('B1b: a row whose merged head is a round keeps the exact row of before: no headMap field, the head sha and rank (breaks if option b touches a reviewed head)', async () => {
  const b = big();
  const head = b.prs[21].shas.at(-1);
  const s = setup(b, { rows: bigRows(b), extra: ['--label', '--allow-label-cache-write', '--write'], deps: { judge: fakeJudge([REAL()]), gh: fakeGh(b, { reviews: { 21: [b.prs[21].shas[0], head] } }), fixChains: FIXES(b), dataset: DATASET } });
  const r = await run(s.argv, s.deps);
  assert.equal(r.code, 0, r.err);
  const rows = loadGold(s.gold).rows;
  assert.ok(rows.length === 3 && rows.every((x) => x.target.round === 2 && x.target.sha40 === head && !('headMap' in x.provenance)));
  assert.equal(JSON.parse(r.out).earlierRound, 0);
});

/** PR 31: commit 1 adds f.txt and g.txt; commit 2 changes one line of f.txt (other) or the blamed line (blamed). Fix PR 32 fixes "bug". */
const roundRepo = (second) => buildRepo([
  { n: 31, at: A_DAY, commits: [
    { subject: 'feat: add f', files: { 'src/f.txt': lines('alpha', 'bug', 'omega', 'tail') } },
    { subject: 'feat: tweak f', files: { 'src/f.txt': second === 'blamed' ? lines('alpha', 'bug2', 'omega', 'tail') : lines('alpha', 'bug', 'omega', 'tail2') } },
  ] },
  { n: 32, at: B_DAY, commits: [{ subject: 'fix: f (#9001)', files: { 'src/f.txt': second === 'blamed' ? lines('alpha', 'good', 'omega', 'tail') : lines('alpha', 'good', 'omega', 'tail2') } }] },
]);

test('B2: a blamed line that changed after the last round is not mapped: it counts as lines-changed-after-round, no candidate (breaks if a changed line maps to the old round)', async () => {
  const b = roundRepo('blamed');
  const r = await report(b, { rows: [escRow(b, { fixPr: 32, blamedPr: 31 })], extra: ['--label'], deps: { judge: fakeJudge([REAL()]), gh: fakeGh(b, { reviews: { 31: [b.prs[31].shas[0]] } }) } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.unmapped['lines-changed-after-round'], 1, JSON.stringify(r.json.unmapped));
  assert.equal(r.json.labelled, 0);
});

test('B2b: two blamed lines, one changed after the last round and one not: the pair is not mapped (all lines, seat point 3) (breaks if one unchanged line is enough)', async () => {
  const b = buildRepo([
    { n: 31, at: A_DAY, commits: [
      { subject: 'feat: add f', files: { 'src/f.txt': lines('alpha', 'bug', 'bugB', 'omega') } },
      { subject: 'feat: tweak f', files: { 'src/f.txt': lines('alpha', 'bug', 'bugB2', 'omega') } },
    ] },
    { n: 32, at: B_DAY, commits: [{ subject: 'fix: f (#9001)', files: { 'src/f.txt': lines('alpha', 'good', 'goodB', 'omega') } }] },
  ]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 32, blamedPr: 31 })], extra: ['--label'], deps: { judge: fakeJudge([REAL()]), gh: fakeGh(b, { reviews: { 31: [b.prs[31].shas[0]] } }) } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.unmapped['lines-changed-after-round'], 1, JSON.stringify(r.json.unmapped));
  assert.equal(r.json.labelled, 0);
});

test('B3: another line of the file changed after the last round, the blamed line did not: the pair maps to that round (breaks if the rule is file-level)', async () => {
  const b = roundRepo('other');
  const c1 = b.prs[31].shas[0];
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 32, blamedPr: 31 })], extra: ['--label'], deps: { judge, gh: fakeGh(b, { reviews: { 31: [c1] } }) } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.labelled, 1, JSON.stringify(r.json.unmapped));
  assert.equal(r.json.earlierRound, 1);
  assert.match(judge.prompts[0], /> {4}2\| bug/, 'the judge sees the round tree');
});

test('B4: the last ancestor round is taken, not the first; a later round that is not an ancestor is skipped (breaks if the scan starts at the first round or skips the ancestor test)', async () => {
  const b = buildRepo([
    { n: 31, at: A_DAY, commits: [
      { subject: 'feat: add f', files: { 'src/f.txt': lines('alpha', 'bug', 'omega', 'tail') } },
      { subject: 'feat: context', files: { 'src/f.txt': lines('alpha', 'bug', 'omega2', 'tail') } },
      { subject: 'feat: tail', files: { 'src/f.txt': lines('alpha', 'bug', 'omega2', 'tail2') } },
    ] },
    { n: 32, at: B_DAY, commits: [{ subject: 'fix: f (#9001)', files: { 'src/f.txt': lines('alpha', 'good', 'omega2', 'tail2') } }] },
  ]);
  const [c1, c2] = b.prs[31].shas;
  const later = b.prs[32].shas[0];
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 32, blamedPr: 31 })], extra: ['--label'], deps: { judge, gh: fakeGh(b, { reviews: { 31: [c1, c2, later] } }) } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.earlierRound, 1, JSON.stringify(r.json.unmapped));
  assert.match(judge.prompts[0], /omega2/, 'the blamed text comes from the second round (c2), not the first');
});

test('B5: a CodeRabbit comment 2 lines from the open bug does not drop it (rule i, open-bug rows only); the same comment drops a fix pair, and rule ii (same line range) is only counted (breaks if rule i is wider, or the count is wrong)', async () => {
  const b = roundRepo('other');
  const c1 = b.prs[31].shas[0];
  const near = { user: CR_USER, path: 'src/f.txt', line: 4, created_at: '2026-10-10T11:00:00Z' }; // the blamed line is 2
  const gh = () => fakeGh(b, { reviews: { 31: [c1] }, comments: { 31: [near] } });
  const fix = await report(b, { rows: [escRow(b, { fixPr: 32, blamedPr: 31 })], extra: ['--label'], deps: { judge: fakeJudge([REAL()]), gh: gh() } });
  assert.equal(fix.json.crDropped, 1);
  assert.equal(fix.json.crSameRangeKept, 1, 'rule ii would keep it: the comment is not on the blamed line');
  const ob = buildRepo([{ n: 31, at: A_DAY, commits: [
    { subject: 'feat: add f', files: { 'src/f.txt': lines('alpha', 'bug', 'omega', 'tail') } },
    { subject: 'feat: tweak f', files: { 'src/f.txt': lines('alpha', 'bug', 'omega', 'tail2') } },
  ] }]);
  const judge = fakeJudge([REAL()]);
  const open = await report(ob, { rows: [], extra: ['--label', '--open-bug', 'src/f.txt:2', '--open-bug-note', 'the wait never ends'], deps: { judge, gh: fakeGh(ob, { reviews: { 31: [ob.prs[31].shas[0]] }, comments: { 31: [near] } }) } });
  assert.equal(open.code, 0, open.err);
  assert.equal(open.json.crDropped, 0, 'rule i: an open-bug row is never dropped by a nearby comment');
  assert.equal(open.json.labelled, 1);
  assert.equal(open.json.earlierRound, 1, 'the open bug maps to the last round too');
});

test('S03: an open bug maps to the EARLIEST main merge that holds the origin commit, in either list order (breaks if the last or the latest merge is taken)', async () => {
  const b = buildRepo([
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy', 'omega') } }] },
    { n: 13, at: B_DAY, commits: [{ subject: 'feat: other', files: { 'src/o.txt': 'o\n' } }] },
  ]);
  const origin = b.prs[11].shas[0];
  const e11 = { number: 11, merged_at: A_DAY, merge_commit_sha: b.prs[11].mergeSha };
  const e13 = { number: 13, merged_at: B_DAY, merge_commit_sha: b.prs[13].mergeSha };
  for (const list of [[e13, e11], [e11, e13]]) {
    const r = await report(b, { rows: [], extra: ['--label', '--allow-label-cache-write', '--open-bug', 'src/f.txt:2', '--open-bug-note', 'the wait never ends'], deps: { judge: fakeJudge([REAL()]), gh: fakeGh(b, { pulls: { [origin]: list } }) } });
    assert.equal(r.code, 0, r.err);
    const cached = readFileSync(path.join(r.state, 'szz-labels.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(cached.length, 1);
    assert.equal(cached[0].blamedMergeSha, b.prs[11].mergeSha);
    assert.equal(cached[0].fixSha, 'open-bug');
    assert.deepEqual([cached[0].hunksShown, cached[0].hunksLeftOut], [0, 0], 'an open bug has no fix diff');
    assert.equal(r.deps.judge.prompts[0].includes('the wait never ends'), true, 'the card text is in the prompt');
  }
});

test('S09: with --daily-calls 6 and the six lane calls of today used, no call starts; rows of another lane or day do not count; a run cannot pass the slot (breaks if the ledger or the in-run counter is ignored)', async () => {
  const ledger = path.join(tmp('led'), 'ledger.jsonl');
  const row = (over) => `${JSON.stringify({ phase: 'start', purpose: 'eval-judge', sessionId: `${LEDGER_TAG}:s`, ts: '2026-11-13T15:00:00Z', id: `i${Math.random()}`, ...over })}\n`;
  const b = small();
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11 })];
  writeFileSync(ledger, Array.from({ length: 6 }, () => row({})).join(''));
  const full = await report(b, { rows, extra: SIX, deps: { judge: fakeJudge([REAL()]), ledgerPath: ledger } });
  assert.equal(full.deps.judge.prompts.length, 0);
  assert.equal(full.json.labelCalls.used, 6);
  assert.equal(full.json.labelled, 0);
  writeFileSync(ledger, [...Array.from({ length: 5 }, () => row({})), ...Array.from({ length: 4 }, () => row({ sessionId: 'other' })), row({ ts: '2026-11-12T05:00:00Z' })].join(''));
  const some = await report(b, { rows, extra: SIX, deps: { judge: fakeJudge([REAL()]), ledgerPath: ledger } });
  assert.equal(some.deps.judge.prompts.length, 1);
  // Two oversize hunks need two calls; five are used, so only one call may run, though the fake judge writes no ledger row.
  const huge = 'q'.repeat(HUNK_LIMIT + 500);
  const b2 = buildRepo([
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'a.txt': lines('keep', `bad ${huge}`), 'b.txt': lines('keep', `bad ${huge}`) } }] },
    { n: 12, at: B_DAY, commits: [{ subject: 'fix: both (#9001)', files: { 'a.txt': lines('keep', 'good'), 'b.txt': lines('keep', 'good') } }] },
  ]);
  writeFileSync(ledger, Array.from({ length: 5 }, () => row({})).join(''));
  const j2 = fakeJudge([REAL()]);
  const two = await report(b2, { rows: [escRow(b2, { fixPr: 12, blamedPr: 11 })], extra: SIX, deps: { judge: j2, ledgerPath: ledger } });
  assert.equal(j2.prompts.length, 1);
  assert.equal([...j2.prompts[0].matchAll(/^### Pair/gm)].length, 1, 'an oversize hunk is alone in its call');
  assert.equal(two.json.labelCalls.used, 6);
});

test('S08b: a bad judge answer stores no label, counts the batch as failed, and writes no cache row (breaks if a bad batch is partly kept)', async () => {
  const b = big();
  for (const raw of ['sorry, no', JSON.stringify([{ pair: 1, verdict: 'real', severity: 'major' }, { pair: 9, verdict: 'real', severity: 'major' }])]) {
    const r = await report(b, { rows: bigRows(b), extra: ['--label', '--allow-label-cache-write'], deps: { judge: fakeJudge([REAL()], { raw }) } });
    assert.equal(r.json.labelled, 0);
    assert.equal(r.json.failed.label, 1);
    assert.equal(existsSync(path.join(r.state, 'szz-labels.jsonl')), false);
  }
});

test('S21: the label cache is reused by a second run, and written only with the allow flag (breaks if the cache is not read, or is written without the flag)', async () => {
  const b = big();
  const base = setup(b, { rows: bigRows(b), extra: ['--label', '--allow-label-cache-write'] });
  const j1 = fakeJudge([REAL()]);
  const r1 = await run(base.argv, { ...base.deps, judge: j1 });
  assert.equal(r1.code, 0, r1.err);
  assert.equal(j1.prompts.length, 1);
  const cacheFile = path.join(base.state, 'szz-labels.jsonl');
  const cached = readFileSync(cacheFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(cached.length, 3);
  assert.deepEqual(Object.keys(cached[0]).sort(), ['blamedMergeSha', 'file', 'fixSha', 'hunksLeftOut', 'hunksShown', 'key', 'line', 'promptSha', 'severity', 'verdict']);
  assert.deepEqual(cached.map((c) => [c.hunksShown, c.hunksLeftOut]), [[1, 0], [1, 0], [1, 0]], 'one hunk per file in the big repo');
  const j2 = fakeJudge([REAL()]);
  const r2 = await run(base.argv, { ...base.deps, judge: j2 });
  assert.equal(j2.prompts.length, 0, 'a cached label is not asked again');
  assert.equal(JSON.parse(r2.out).labelled, 3);
  assert.equal(readFileSync(cacheFile, 'utf8').trim().split('\n').length, 3, 'no duplicate cache rows');
  const noFlag = setup(b, { rows: bigRows(b), extra: ['--label'] });
  const j3 = fakeJudge([REAL()]);
  const r3 = await run(noFlag.argv, { ...noFlag.deps, judge: j3 });
  assert.equal(j3.prompts.length, 1);
  assert.equal(existsSync(path.join(noFlag.state, 'szz-labels.jsonl')), false, 'no flag, no cache file');
  assert.equal(JSON.parse(r3.out).labelled, 3);
});

// ---------- the three gold files ----------

const DATASET = { prs: [101, 102, 103, 21, 999].map((pr) => ({ pr })), findings: [] };
/**
 * The fix-chains --json shape: perPr results, one for each PR it walked. PR 100 (the first merge, 08-01) is a PR with no fix,
 * so the input covers group 2 (R3-M1). PR 171 is a partial-failure fix, PR 170 a fix with no target.
 */
const FIXES = (b) => ({ perPr: [
  { pr: 100, mergeSha: b.prs[100].mergeSha, rows: [], noTarget: null, fix: false },
  { pr: 171, mergeSha: b.prs[171].mergeSha, rows: [], fix: true, noTarget: 'partial-failure', failed: true },
  { pr: 170, mergeSha: b.prs[170].mergeSha, rows: [], fix: true, noTarget: 'no-removed-lines' },
] });
const writeArgs = ['--label', '--allow-label-cache-write', '--write'];
const bigRun = (extra = [], over = {}) => {
  const b = big();
  return report(b, { rows: bigRows(b), extra: [...writeArgs, ...extra], deps: { judge: fakeJudge([REAL('major'), REAL('critical'), REAL('minor')]), fixChains: FIXES(b), dataset: DATASET, readRecords: () => [{ pr: 21, findings: [{ file: 's/a.txt', startLine: 3, endLine: 4 }] }], ...over } });
};

test('S15/S04/S11/S12: --write makes gold-a.json, clean-controls.json and escape-baseline.json; rows have the mapped line, split, suite, round and provenance (breaks if the line map, split, suite or the writer changes)', async () => {
  const r = await bigRun();
  assert.equal(r.code, 0, r.err);
  const { rows } = loadGold(r.gold);
  assert.deepEqual(rows.map((x) => [x.file, x.line]), [['s/a.txt', 4], ['s/b.txt', 2], ['s/c.txt', 2]], 'a: moved by a header in the PR; b: shifted by a later direct commit, found by origin');
  assert.ok(rows.every((x) => /^A:[0-9a-f]{12}$/.test(x.id)), rows.map((x) => x.id).join(' '));
  assert.equal(new Set(rows.map((x) => x.id)).size, 3, 'ids are unique');
  assert.deepEqual(rows.map((x) => x.severity), ['major', 'critical', 'minor']);
  assert.deepEqual(rows.map((x) => x.suite), ['regression', 'capability', 'capability']);
  assert.deepEqual(new Set(rows.map((x) => x.split)), new Set(['dev']), '21 is in holdoutExclude');
  const b = big();
  assert.equal(rows[0].target.sha40, b.prs[21].shas.at(-1));
  assert.equal(rows[0].target.round, 1);
  assert.equal(rows[0].provenance.fixSha, b.prs[22].shas[0]);
  assert.equal(rows[0].provenance.blamedMergeSha, b.prs[21].mergeSha);
  assert.equal(rows[0].provenance.cause, 'wrong-surfaces');
  assert.deepEqual(rows.map((x) => [x.provenance.hunksShown, x.provenance.hunksLeftOut]), [[1, 0], [1, 0], [1, 0]], 'the hunk counts reach gold-a.json');
  for (const x of rows) assert.deepEqual(validateRow(x), []);
  assert.equal(loadCleanControls(r.gold).length, 40);
  assert.deepEqual(r.json.controls, { group1: 2, group2: 38, removedBlamed: 3, removedFailedFix: 24, removedUnmappedFix: 1, noRoundHead: 0, noHead: 0, roundFailed: 0, notOnMain: 1, total: 40 });
  assert.deepEqual(readFileSync(path.join(r.gold, 'escape-baseline.json')), readFileSync(path.join(r.state, 'escape-baseline.json')), 'byte equal');
  assert.deepEqual(readdirSync(r.gold).sort(), ['clean-controls.json', 'escape-baseline.json', 'gold-a.json'], 'no temp file is left');
  assert.equal(r.json.counted, 2);
  assert.deepEqual(r.json.countedByBand, { HIGH: 2 });
  assert.deepEqual(r.json.yield, { 'wrong-surfaces': 2 });
});

test('S18: gold-a holds only verdict real; noise and unclear stay in the counts and the cache (breaks if the verdict filter is dropped)', async () => {
  const r = await bigRun([], { judge: fakeJudge([REAL('critical'), { verdict: 'noise', severity: 'minor' }, { verdict: 'unclear', severity: 'minor' }]) });
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(path.join(r.gold, 'gold-a.json'), 'utf8');
  assert.equal(JSON.parse(text).length, 1);
  assert.equal(/noise|unclear/.test(text), false);
  assert.deepEqual([r.json.verdicts.real, r.json.verdicts.noise, r.json.verdicts.unclear, r.json.counted, r.json.labelled], [1, 1, 1, 1, 3]);
  const cache = readFileSync(path.join(r.state, 'szz-labels.jsonl'), 'utf8');
  assert.equal(/noise/.test(cache) && /unclear/.test(cache), true);
});

test('S15b: a dry run writes nothing, and a failed gate leaves the old files as they were (breaks if a dry run writes or a gate failure writes part of the files)', async () => {
  const b = small();
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11 })];
  const dry = setup(b, { rows, extra: ['--label'], deps: { judge: fakeJudge([REAL()]), fixChains: { perPr: [] } } });
  assert.equal((await run(dry.argv, dry.deps)).code, 0);
  assert.equal(existsSync(dry.gold), false, 'no gold dir');
  const s = setup(b, { rows, extra: writeArgs, deps: { judge: fakeJudge([REAL()]), fixChains: { perPr: [] } } });
  mkdirSync(s.gold, { recursive: true });
  writeFileSync(path.join(s.gold, 'gold-a.json'), '[]\n');
  const bad = await run(s.argv, s.deps);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /controls under 30: \d+/);
  assert.equal(readFileSync(path.join(s.gold, 'gold-a.json'), 'utf8'), '[]\n', 'the old file stays');
  assert.deepEqual(readdirSync(s.gold), ['gold-a.json'], 'no other file and no temp file');
});

test('S14b: the baseline status compares the rows, not the bytes: a CRLF copy of the state rows is identical, a changed row differs (breaks if the compare goes back to bytes)', async () => {
  const ok = await bigRun();
  const b = big();
  const status = async () => JSON.parse((await run(['--since', '2026-08-01', '--repo', 'o/r', '--state-dir', ok.state, '--gold-dir', ok.gold, '--json'], { git: b.git, gh: fakeGh(b), fixChains: FIXES(b), dataset: DATASET })).out).baseline;
  const dest = path.join(ok.gold, 'escape-baseline.json');
  writeFileSync(dest, readFileSync(path.join(ok.state, 'escape-baseline.json'), 'utf8').replace(/\r?\n/g, '\r\n'));
  assert.equal(await status(), 'identical', 'a CRLF checkout of the same rows');
  writeFileSync(dest, baselineText().replace('"prsMerged": 5', '"prsMerged": 7'));
  assert.equal(await status(), 'differs', 'a changed row');
});

test('G6: a byte-order mark at the start of the gold copy (an editor save) is identical for the same rows; a changed row with a mark still differs (breaks if the mark is not stripped before the parse)', async () => {
  const ok = await bigRun();
  const b = big();
  const status = async () => JSON.parse((await run(['--since', '2026-08-01', '--repo', 'o/r', '--state-dir', ok.state, '--gold-dir', ok.gold, '--json'], { git: b.git, gh: fakeGh(b), fixChains: FIXES(b), dataset: DATASET })).out).baseline;
  const dest = path.join(ok.gold, 'escape-baseline.json');
  const src = readFileSync(path.join(ok.state, 'escape-baseline.json'), 'utf8');
  writeFileSync(dest, `﻿${src}`);
  assert.equal(await status(), 'identical', 'a mark on the same rows');
  writeFileSync(dest, `﻿${src.replace(/\r?\n/g, '\r\n')}`);
  assert.equal(await status(), 'identical', 'a mark and CRLF on the same rows');
  writeFileSync(dest, `﻿${baselineText().replace('"prsMerged": 5', '"prsMerged": 7')}`);
  assert.equal(await status(), 'differs', 'a changed row with a mark');
});

test('S13d: --write without a fix-chains input refuses to write controls (breaks if the partial-failure source is optional for a write)', async () => {
  const b = big();
  const s = setup(b, { rows: bigRows(b), extra: writeArgs, deps: { judge: fakeJudge([REAL()]), dataset: DATASET } });
  const r = await run(s.argv, s.deps);
  assert.equal(r.code, 1);
  assert.match(r.err, /fix-chains/);
  assert.equal(existsSync(s.gold), false);
});

test('S14: a changed baseline in the state dir is reported as differing, and a missing risk band stops the write with nothing written (breaks if the copy is not compared or the bands are not checked)', async () => {
  const ok = await bigRun();
  assert.equal(ok.json.baseline, 'copied');
  writeFileSync(path.join(ok.state, 'escape-baseline.json'), baselineText().replace('"prsMerged": 5', '"prsMerged": 6'));
  const b = big();
  const again = await run(['--since', '2026-08-01', '--repo', 'o/r', '--state-dir', ok.state, '--gold-dir', ok.gold, '--json'], { git: b.git, gh: fakeGh(b), fixChains: FIXES(b), dataset: DATASET });
  assert.equal(JSON.parse(again.out).baseline, 'differs');
  const short = await bigRunWith({ baseline: baselineText(['LOW', 'MID', 'HIGH', 'CRITICAL']) });
  assert.equal(short.code, 1);
  assert.match(short.err, /ELEVATED/);
  assert.equal(existsSync(short.gold), false, 'nothing is written when one gate fails');
});
async function bigRunWith({ baseline }) {
  const b = big();
  return report(b, { rows: bigRows(b), baseline, extra: writeArgs, deps: { judge: fakeJudge([REAL()]), fixChains: FIXES(b), dataset: DATASET } });
}

test('S10: a row that fails validateRow writes nothing, exits 1 and prints problem lines with no value (breaks if validation is skipped or a value is printed)', async () => {
  const b = buildRepo([
    ...bulkSteps(),
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { ' secret-name.txt': lines('alpha', 'buggy', 'omega') } }] },
    { n: 12, at: B_DAY, commits: [{ subject: 'fix: f (#9001)', files: { ' secret-name.txt': lines('alpha', 'fixed', 'omega') } }] },
  ]);
  const s = setup(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: writeArgs, deps: { judge: fakeJudge([REAL()]), fixChains: { perPr: [] }, dataset: NO_DATA } });
  const r = await run(s.argv, s.deps);
  assert.equal(r.code, 1, r.err + r.out);
  assert.match(r.err, /file:/);
  assert.equal(/secret-name/.test(r.err + r.out), false, 'no value printed');
  assert.equal(existsSync(s.gold), false);
});

test('S16: a planted PR number never reaches stdout, the report file or the judge prompt, also not through a subject, a hunk header or a pull url (breaks if scrubPrs or the report text lets it through)', async () => {
  const PLANT = 987654;
  const b = buildRepo([
    { n: PLANT, at: A_DAY, commits: [{ subject: `feat: add secretname (#${PLANT})`, files: { 'src/secretname.txt': lines(`header see #${PLANT} note`, ' good', `bad pull/${PLANT}`, 'tail') } }] },
    { n: PLANT + 1, at: B_DAY, commits: [{ subject: `fix: y (#${PLANT})`, files: { 'src/secretname.txt': lines(`header see #${PLANT} note`, ' good', 'fixed', 'tail') } }] },
  ]);
  const judge = fakeJudge([REAL()]);
  const reportFile = path.join(tmp('rep'), 'report.txt');
  const s = setup(b, { rows: [escRow(b, { fixPr: PLANT + 1, blamedPr: PLANT })], extra: ['--label', '--report', reportFile], deps: { judge } });
  const json = await run(s.argv, s.deps);
  const text = await run(s.argv.filter((a) => a !== '--json'), { ...s.deps, judge: fakeJudge([REAL()]) });
  assert.equal(json.code, 0, json.err);
  assert.equal(text.code, 0, text.err);
  const prompt = judge.prompts.join('\n');
  assert.equal(prompt.includes('fixed'), true, 'the prompt holds the fix hunk: the check is not vacuous');
  assert.equal(prompt.includes('header see'), true, 'the hunk header text stays, scrubbed');
  const seen = { prompt, json: json.out + json.err, text: text.out + text.err, report: readFileSync(reportFile, 'utf8') };
  for (const [where, s2] of Object.entries(seen)) {
    assert.equal(s2.includes(String(PLANT)), false, `${where} holds the planted PR number`);
    assert.equal(s2.includes(String(PLANT + 1)), false, `${where} holds the fix PR number`);
  }
  for (const where of ['json', 'text', 'report']) assert.equal(seen[where].includes('secretname'), false, `${where} holds a file name`);
  assert.match(seen.text, /one model family \(claude-opus-5-5\)/);
  assert.match(seen.text, /review-body CodeRabbit findings are not read \(named limit\)/);
});

test('S16b: --report inside the gold dir or inside the repo is refused (breaks if the report path is not checked)', async () => {
  const b = small();
  const s = setup(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })] });
  assert.equal((await run([...s.argv, '--report', path.join(s.gold, 'r.txt')], s.deps)).code, 2);
  assert.equal((await run([...s.argv, '--report', path.join(HERE, 'r.txt')], s.deps)).code, 2);
  assert.equal(existsSync(path.join(HERE, 'r.txt')), false);
});

test('S17: no args and --help print the usage, exit 0, and touch no git, no gh, no state and no file in HOME (breaks if args are parsed after the walk)', async () => {
  const boom = () => { throw new Error('must not be called'); };
  for (const argv of [[], ['--help']]) {
    const r = await run(argv, { git: boom, gh: boom, judge: boom });
    assert.equal(r.code, 0);
    assert.match(r.out, /usage: node scripts\/eval\/review-eval\/mine-szz\.mjs/);
  }
  const home = tmp('home');
  for (const argv of [[], ['--help']]) {
    const r = spawnSync(process.execPath, [path.join(HERE, 'mine-szz.mjs'), ...argv], { encoding: 'utf8', env: { PATH: '', HOME: home, USERPROFILE: home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /usage: /);
    assert.deepEqual(readdirSync(home), [], 'the temp HOME is still empty');
  }
});

test('S17b: an unknown flag exits 2 and a bad --open-bug is refused before any git call (breaks if args are not checked first)', async () => {
  const boom = () => { throw new Error('must not be called'); };
  assert.equal((await run(['--nope'], { git: boom, gh: boom })).code, 2);
  assert.equal((await run(['--open-bug', 'nocolon'], { git: boom, gh: boom })).code, 2);
  assert.equal((await run(['--open-bug', 'a.txt:zero'], { git: boom, gh: boom })).code, 2);
});

// ---------- critic round 1: one test per finding (R<item>) ----------

test('R01: crDrops reads the whole range of a multi-line CodeRabbit comment, through start_line..line or original_start_line..original_line (breaks if only the end line is read)', () => {
  const cand = { file: 's/a.txt', line: 10, endLine: 10, fixMergedAt: '2026-10-11T10:00:00Z' };
  const c = (over) => ({ user: CR_USER, path: 's/a.txt', created_at: '2026-10-10T10:00:00Z', ...over });
  assert.equal(crDrops([c({ start_line: 2, line: 20 })], cand, 3), true, 'the range covers the run, both ends far');
  assert.equal(crDrops([c({ line: null, start_line: null, original_start_line: 2, original_line: 20 })], cand, 3), true, 'original range after a push');
  assert.equal(crDrops([c({ start_line: 30, line: 40, original_start_line: 5, original_line: 15 })], cand, 3), true, 'either range counts');
  assert.equal(crDrops([c({ start_line: 1, line: 7 })], cand, 3), true, 'the range end at the slack edge is in');
  assert.equal(crDrops([c({ start_line: 1, line: 6 })], cand, 3), false, 'the range ends one line before the slack');
  assert.equal(crDrops([c({ start_line: 14, line: 20 })], cand, 3), false, 'the range starts one line after the slack');
});

/** The big repo set up for a --write run. deps override the defaults. */
const writeSetup = (deps = {}, extra = writeArgs) => {
  const b = big();
  return setup(b, { rows: bigRows(b), extra, deps: { judge: fakeJudge([REAL()]), fixChains: FIXES(b), dataset: DATASET, ...deps } });
};
const GOLD_FILES = ['clean-controls.json', 'escape-baseline.json', 'gold-a.json'];
const plantOld = (gold) => { mkdirSync(gold, { recursive: true }); for (const n of GOLD_FILES) writeFileSync(path.join(gold, n), `OLD ${n}\n`); };
const failRenameInto = (name) => (from, to) => {
  if (from.endsWith('.tmp') && path.basename(to) === name) throw Object.assign(new Error('EPERM: rename refused'), { code: 'EPERM' });
  renameSync(from, to);
};

test('R02: a failed rename of the second gold file restores all three old files; with no old files it leaves none; no .bak or .tmp stays (breaks if the renames have no rollback)', async () => {
  const s = writeSetup({ rename: failRenameInto('clean-controls.json') });
  plantOld(s.gold);
  const r = await run(s.argv, s.deps);
  assert.equal(r.code, 2, `the failed write is reported, not a gate refusal: ${r.err}`);
  for (const n of GOLD_FILES) assert.equal(readFileSync(path.join(s.gold, n), 'utf8'), `OLD ${n}\n`, `${n} is the old file`);
  assert.deepEqual(readdirSync(s.gold).sort(), GOLD_FILES, 'no .bak and no .tmp');
  const fresh = writeSetup({ rename: failRenameInto('clean-controls.json') });
  const r2 = await run(fresh.argv, fresh.deps);
  assert.equal(r2.code, 2, r2.err);
  assert.deepEqual(existsSync(fresh.gold) ? readdirSync(fresh.gold) : [], [], 'the file renamed in first is removed again');
});

test('R03: --write refuses a run with an unlabelled candidate or a failed pair, unless --allow-partial is given (breaks if the gate ignores either count)', async () => {
  const noLabel = writeSetup({}, ['--allow-label-cache-write', '--write']);
  const r1 = await run(noLabel.argv, noLabel.deps);
  assert.equal(r1.code, 1, r1.err);
  assert.match(r1.err, /unlabelled/);
  assert.equal(existsSync(noLabel.gold), false, 'nothing written');
  const b = big();
  const failed = writeSetup({ gh: fakeGh(b, { failComments: new Set([21]) }) });
  const r2 = await run(failed.argv, failed.deps);
  assert.equal(r2.code, 1, r2.err);
  assert.match(r2.err, /failed pairs: 1/);
  assert.equal(existsSync(failed.gold), false, 'nothing written');
  const allowed = writeSetup({ gh: fakeGh(b, { failComments: new Set([21]) }) }, [...writeArgs, '--allow-partial']);
  const r3 = await run(allowed.argv, allowed.deps);
  assert.equal(r3.code, 0, r3.err);
  assert.deepEqual(JSON.parse(readFileSync(path.join(allowed.gold, 'gold-a.json'), 'utf8')), []);
});

test('R03b: --write refuses a run with a failed control round read, unless --allow-partial is given (breaks if a failed read only shrinks the controls)', async () => {
  const b = big();
  // PR 103 is a group 1 control (in the dataset, no finding); its rounds read fails.
  const failed = writeSetup({ gh: fakeGh(b, { failReviews: new Set([103]) }) }, [...writeArgs]);
  const r1 = await run(failed.argv, failed.deps);
  assert.equal(r1.code, 1, r1.err);
  assert.match(r1.err, /failed control round reads: 1/);
  assert.equal(existsSync(failed.gold), false, 'nothing written');
  const allowed = writeSetup({ gh: fakeGh(b, { failReviews: new Set([103]) }) }, [...writeArgs, '--allow-partial']);
  const r2 = await run(allowed.argv, allowed.deps);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(loadCleanControls(allowed.gold).some((c) => c.target.pr === 103), false, 'the failed control is not written');
});

test('R03c: a PR that is a gold target in this run (an open bug, not in the escape rows) is never a clean control (breaks if the controls read only the escape rows)', async () => {
  const b = small();
  // Line 2 of src/f.txt on main is the line that PR 12 wrote, so the open bug maps to PR 12; PR 12 is in the dataset.
  const r = await report(b, { rows: [], extra: ['--label', '--open-bug', 'src/f.txt:2', '--open-bug-note', 'n'], deps: { judge: fakeJudge([REAL()]), dataset: { prs: [{ pr: 12 }], findings: [] } } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.labelled, 1, 'the open bug is a candidate of this run');
  assert.equal(r.json.controls.group1, 0, JSON.stringify(r.json.controls));
  assert.equal(r.json.controls.removedBlamed, 1, JSON.stringify(r.json.controls));
});

test('R04: defaultJudge passes a sessionId that starts with the lane marker, the ledger path and the judge timeout to its runner (breaks if the marker is dropped: the daily slot no longer counts the lane)', async () => {
  const seen = [];
  const runner = async (prompt, opts) => { seen.push({ prompt, opts }); return { ok: true, result: '[]' }; };
  const judge = szz.defaultJudge({ ledgerPath: 'L.jsonl', now: () => NOW }, runner);
  await judge('the prompt');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].prompt, 'the prompt');
  assert.ok(String(seen[0].opts.sessionId).startsWith('szz-miner:'), String(seen[0].opts.sessionId));
  assert.equal(seen[0].opts.ledgerPath, 'L.jsonl');
  assert.equal(seen[0].opts.timeoutMs, 300_000);
});

test('R05: a removed line written by an EARLIER PR is not a line of the blamed PR, though it is an ancestor of the blamed head (breaks if the blamed set is every ancestor of the head)', async () => {
  const b = buildRepo([
    { n: 10, at: '2026-10-09T10:00:00Z', commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy', 'omega') } }] },
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: more f', files: { 'src/f.txt': lines('alpha', 'buggy', 'omega', 'extra') } }] },
    { n: 12, at: B_DAY, commits: [{ subject: 'fix: f (#9001)', files: { 'src/f.txt': lines('alpha', 'fixed', 'omega', 'extra') } }] },
  ]);
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.unmapped['no-blamed-line'], 1, JSON.stringify(r.json.unmapped));
  assert.equal(judge.prompts.length, 0);
});

test('R06: a line re-indented inside the blamed PR and again on main is still found, on both blames (breaks if -w is dropped from either blame)', async () => {
  const b = buildRepo([
    { n: 11, at: A_DAY, commits: [
      { subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy', 'omega') } },
      { subject: 'style: indent', files: { 'src/f.txt': lines('alpha', '  buggy', 'omega') } },
    ] },
    { direct: { at: '2026-10-10T12:00:00Z', subject: 'style: tabs', files: { 'src/f.txt': lines('alpha', '\tbuggy', 'omega') } } },
    { n: 12, at: B_DAY, commits: [{ subject: 'fix: f (#9001)', files: { 'src/f.txt': lines('alpha', 'fixed', 'omega') } }] },
  ]);
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.unmapped, {}, JSON.stringify(r.json.unmapped));
  assert.equal(r.json.labelled, 1);
});

test('R07: a removed line that the fix PR wrote itself is unmapped own-pr, end to end, with no label call (breaks if the own-pr reason is lost)', async () => {
  const b = buildRepo([
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy', 'omega') } }] },
    { n: 12, at: B_DAY, commits: [
      { subject: 'wip: try', files: { 'src/f.txt': lines('alpha', 'wip', 'omega') } },
      { subject: 'fix: f (#9001)', files: { 'src/f.txt': lines('alpha', 'fixed', 'omega') } },
    ] },
  ]);
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11, fixIdx: 1 })], extra: ['--label'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.unmapped, { 'own-pr': 1 });
  assert.equal(judge.prompts.length, 0);
});

/** PR 11 brings "buggy"; fix PR 12 only touches its whitespace (blame -w keeps PR 11 as origin); fix PR 13 really fixes it. */
const twoFixes = () => buildRepo([
  { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy', 'omega') } }] },
  { n: 12, at: B_DAY, commits: [{ subject: 'fix: spacing (#9001)', files: { 'src/f.txt': lines('alpha', 'buggy  ', 'omega') } }] },
  { n: 13, at: '2026-10-12T10:00:00Z', commits: [{ subject: 'fix: the real one (#9002)', files: { 'src/f.txt': lines('alpha', 'fixed', 'omega') } }] },
]);

test('G1: two fixes of one blamed line are both judged; the real verdict wins over noise, in either order; one duplicate is counted (breaks if duplicates go before labelling)', async () => {
  for (const verdicts of [[{ verdict: 'noise', severity: 'minor' }, REAL()], [REAL(), { verdict: 'noise', severity: 'minor' }]]) {
    const b = twoFixes();
    const judge = fakeJudge(verdicts);
    const rows = [escRow(b, { fixPr: 12, blamedPr: 11 }), escRow(b, { fixPr: 13, blamedPr: 11 })];
    const r = await report(b, { rows, extra: ['--label'], deps: { judge } });
    assert.equal(r.code, 0, r.err);
    assert.equal([...judge.prompts.join('\n').matchAll(/^### Pair/gm)].length, 2, 'both fixes reach the judge');
    assert.equal(r.json.duplicates, 1);
    assert.equal(r.json.verdicts.real, 1, JSON.stringify(r.json.verdicts));
    assert.equal(r.json.goldRows, 1);
    assert.equal(r.json.counted, 1);
  }
});

test('G1b: when no fix of the line is real and one is still unlabelled, the unlabelled one is kept, so the write gate still sees it (breaks if a noise label outranks a missing one)', async () => {
  const b = twoFixes();
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11 }), escRow(b, { fixPr: 13, blamedPr: 11 })];
  const s = setup(b, { rows });
  const hit = { fixSha: b.prs[12].shas[0], blamedMergeSha: b.prs[11].mergeSha, file: 'src/f.txt', line: 2 };
  writeFileSync(path.join(s.state, 'szz-labels.jsonl'), `${JSON.stringify({ key: szz.labelKey(hit), ...hit, verdict: 'noise', severity: 'minor' })}
`);
  const r = { ...(await run(s.argv, s.deps)) };
  r.json = JSON.parse(r.out);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.labelled, 0, 'the noise label of fix 12 is not the kept candidate');
  assert.equal(r.json.unlabelled, 1, JSON.stringify(r.json));
  assert.equal(r.json.duplicates, 1);
});

test('R08: two escape rows that map to the same head line give one candidate and one duplicate (breaks if the dedup is dropped)', async () => {
  const b = small();
  const judge = fakeJudge([REAL()]);
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11 }), escRow(b, { fixPr: 12, blamedPr: 11, primary: false, cause: 'other' })];
  const r = await report(b, { rows, extra: ['--label'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.pairs, 2);
  assert.equal(r.json.duplicates, 1);
  assert.equal([...judge.prompts[0].matchAll(/^### Pair/gm)].length, 1);
  assert.equal(r.json.labelled, 1);
});

test('R09: a CodeRabbit comment with an unreadable or missing created_at drops the pair: it fails closed (breaks if an unreadable time reads as "after the fix")', () => {
  const cand = { file: 's/a.txt', line: 10, endLine: 10, fixMergedAt: '2026-10-11T10:00:00Z' };
  const c = (over) => ({ user: CR_USER, path: 's/a.txt', line: 10, ...over });
  assert.equal(crDrops([c({ created_at: 'garbage' })], cand, 3), true);
  assert.equal(crDrops([c({})], cand, 3), true, 'no created_at');
  assert.equal(crDrops([c({ created_at: 'garbage' })], { ...cand, fixMergedAt: undefined }, 3), true, 'open bug');
});

test('R10: scrubPrs removes PR-N, pr N, pulls/N, issues/N, pull/N and #N, and keeps hex colours (breaks if a form is missed or a colour is cut)', () => {
  const dirty = ['PR-4242', 'pr 4242', 'Pr#4242', 'see pulls/4242', 'issues/4242', 'pull/4242', 'x #4242 y', '(#4242)', 'pull request 4242'].join('\n');
  const clean = scrubPrs(dirty);
  assert.equal(/4242/.test(clean), false, clean);
  for (const keep of ['color: #fff;', 'color: #a1b2c3;', 'color: #123abc;', 'color: #1a2b3c;']) assert.equal(scrubPrs(keep), keep);
  assert.equal(scrubPrs('a #123456 b'), 'a  b', 'an all-digit #N is a PR reference: the leak guard wins');
});

/** A fake judge that writes a lane start row in the ledger for each call, as runJudge does, and returns its id. */
function ledgerJudge(ledger, clock, onCall = () => {}) {
  const prompts = [];
  const judge = async (prompt) => {
    prompts.push(prompt);
    const id = `own-${prompts.length}-${Math.random()}`;
    appendFileSync(ledger, laneRow({ id, ts: new Date(clock()).toISOString() }));
    onCall(prompts.length);
    const n = [...prompt.matchAll(/^### Pair (\d+)/gm)].length;
    return { ok: true, id, result: JSON.stringify(Array.from({ length: n }, (_, i) => ({ pair: i + 1, ...REAL() }))) };
  };
  return Object.assign(judge, { prompts });
}
const laneRow = (over) => `${JSON.stringify({ phase: 'start', purpose: 'eval-judge', sessionId: `${LEDGER_TAG}:s`, ts: '2026-11-13T15:00:00Z', id: `i${Math.random()}`, ...over })}\n`;
const HUGE = 'q'.repeat(HUNK_LIMIT + 500);
/** Two files with one oversize hunk each: two judge calls. */
const twoHuge = () => buildRepo([
  { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'a.txt': lines('keep', `bad ${HUGE}`), 'b.txt': lines('keep', `bad ${HUGE}`) } }] },
  { n: 12, at: B_DAY, commits: [{ subject: 'fix: both (#9001)', files: { 'a.txt': lines('keep', 'good'), 'b.txt': lines('keep', 'good') } }] },
]);

test('R11: the slot is counted again before each call: a call of another run, or a new Chicago day, is seen (breaks if the ledger is read once per run)', async () => {
  const b = twoHuge();
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11 })];
  // Another run takes a lane call while this run waits on its first answer: 4 old + 1 own + 1 other = 6.
  const ledger = path.join(tmp('led'), 'ledger.jsonl');
  writeFileSync(ledger, Array.from({ length: 4 }, () => laneRow({})).join(''));
  let t = NOW;
  const j1 = ledgerJudge(ledger, () => t, (k) => { if (k === 1) appendFileSync(ledger, laneRow({ ts: '2026-11-13T15:30:00Z' })); });
  const r1 = await report(b, { rows, extra: SIX, deps: { judge: j1, ledgerPath: ledger, now: () => t } });
  assert.equal(r1.code, 0, r1.err);
  assert.equal(j1.prompts.length, 1, 'the second call does not start');
  assert.equal(r1.json.labelCalls.used, 6, 'the own call is counted once: its ledger row and the in-run count share an id');
  assert.equal(r1.json.labelCalls.stopped, true);
  // A run that passes midnight (Chicago): the new day already holds six lane calls.
  const ledger2 = path.join(tmp('led'), 'ledger.jsonl');
  writeFileSync(ledger2, Array.from({ length: 6 }, () => laneRow({ ts: '2026-11-14T07:00:00Z' })).join(''));
  t = Date.parse('2026-11-14T05:50:00Z'); // 23:50 on Nov 13 in Chicago
  const j2 = ledgerJudge(ledger2, () => t, (k) => { if (k === 1) t = Date.parse('2026-11-14T06:30:00Z'); });
  const r2 = await report(b, { rows, extra: SIX, deps: { judge: j2, ledgerPath: ledger2, now: () => t } });
  assert.equal(r2.code, 0, r2.err);
  assert.equal(j2.prompts.length, 1, 'after midnight the new day is full');
});

// ---------- pace: the daily limit, the checkpoint and the shared cap (P<item>) ----------

const textOf = (out) => out.split('\n');
const stopLines = (out) => textOf(out).filter((l) => l.startsWith('labelling stopped: '));

test('P01: the daily limit is 30 by default: six lane calls today still let a call start, thirty stop it with the daily-limit line (breaks if the default stays 6)', async () => {
  const b = small();
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11 })];
  const ledger = path.join(tmp('led'), 'ledger.jsonl');
  writeFileSync(ledger, Array.from({ length: 6 }, () => laneRow({})).join(''));
  const j1 = fakeJudge([REAL()]);
  const r1 = await report(b, { rows, extra: ['--label'], deps: { judge: j1, ledgerPath: ledger } });
  assert.equal(r1.code, 0, r1.err);
  assert.equal(j1.prompts.length, 1);
  assert.equal(r1.json.labelCalls.max, 30);
  writeFileSync(ledger, Array.from({ length: 30 }, () => laneRow({})).join(''));
  const s = setup(b, { rows, extra: ['--label'], deps: { judge: fakeJudge([REAL()]), ledgerPath: ledger } });
  const text = await run(s.argv.filter((a) => a !== '--json'), s.deps);
  assert.equal(text.code, 0, text.err);
  assert.equal(s.deps.judge.prompts.length, 0);
  assert.deepEqual(stopLines(text.out), ['labelling stopped: daily limit reached (30)']);
});

test('P02: --daily-calls N sets the daily limit of the run; a value that is not a positive integer, or no value, is a usage error before any git call (breaks if the flag is ignored or loosely parsed)', async () => {
  const b = small();
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11 })];
  const ledger = path.join(tmp('led'), 'ledger.jsonl');
  writeFileSync(ledger, Array.from({ length: 2 }, () => laneRow({})).join(''));
  const j = fakeJudge([REAL()]);
  const r = await report(b, { rows, extra: ['--label', '--daily-calls', '2'], deps: { judge: j, ledgerPath: ledger } });
  assert.equal(r.code, 0, r.err);
  assert.equal(j.prompts.length, 0, 'two used of two');
  assert.deepEqual([r.json.labelCalls.max, r.json.labelCalls.stop], [2, 'daily-limit']);
  const boom = () => { throw new Error('must not be called'); };
  for (const flag of ['--daily-calls', '--stop-after']) {
    for (const v of ['0', '-1', '1.5', 'x', '', '1e3', '01', '99999999999999999999']) {
      const bad = await run([flag, v], { git: boom, gh: boom });
      assert.equal(bad.code, 2, `${flag} ${JSON.stringify(v)}`);
      assert.match(bad.err, new RegExp(`${flag} .*positive integer`), bad.err);
      assert.match(bad.err, /usage: /);
    }
    assert.equal((await run([flag], { git: boom, gh: boom })).code, 2, `${flag} with no value`);
  }
});

test('P03: --stop-after N stops the label stage after N calls of this run, keeps the labels of those calls, and says so; the first limit reached names itself (breaks if the checkpoint is ignored or drops the labels it got)', async () => {
  const b = twoHuge();
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11 })];
  const j = fakeJudge([REAL()]);
  const s = setup(b, { rows, extra: ['--label', '--allow-label-cache-write', '--stop-after', '1'], deps: { judge: j } });
  const r = await run(s.argv, s.deps);
  assert.equal(r.code, 0, r.err);
  const json = JSON.parse(r.out);
  assert.equal(j.prompts.length, 1, 'two calls are needed; the checkpoint stops after one');
  assert.deepEqual([json.labelled, json.unlabelled], [1, 1]);
  assert.deepEqual([json.labelCalls.stopped, json.labelCalls.stop], [true, 'checkpoint']);
  assert.equal(cacheRows(s.state).length, 1, 'the label of the one call is kept');
  const text = await run(s.argv.filter((a) => a !== '--json'), { ...s.deps, judge: fakeJudge([REAL()]) });
  assert.equal(text.code, 0, text.err);
  assert.deepEqual(stopLines(text.out), [], 'the cached pair needs no call; the second call is the first of this run');
  // Both limits: five lane calls used of six, checkpoint 2. The daily limit comes first and names itself.
  const ledger = path.join(tmp('led'), 'ledger.jsonl');
  writeFileSync(ledger, Array.from({ length: 5 }, () => laneRow({})).join(''));
  const j2 = fakeJudge([REAL()]);
  const both = setup(b, { rows, extra: ['--label', '--daily-calls', '6', '--stop-after', '2'], deps: { judge: j2, ledgerPath: ledger } });
  const r2 = await run(both.argv.filter((a) => a !== '--json'), both.deps);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(j2.prompts.length, 1);
  assert.deepEqual(stopLines(r2.out), ['labelling stopped: daily limit reached (6)']);
  const j3 = fakeJudge([REAL()]);
  const ck = setup(b, { rows, extra: ['--label', '--stop-after', '1'], deps: { judge: j3 } });
  const r3 = await run(ck.argv.filter((a) => a !== '--json'), ck.deps);
  assert.equal(r3.code, 0, r3.err);
  assert.deepEqual(stopLines(r3.out), ['labelling stopped: stopped after 1 calls (checkpoint)']);
});

test('P04: a shared-cap refusal of the runner is a failed batch, stops further calls, takes no lane slot, and prints the shared-cap line; defaultJudge passes no cap of its own (breaks if the cap refusal is retried, hidden or bypassed)', async () => {
  const b = twoHuge();
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11 })];
  const calls = [];
  const runner = async (prompt, opts) => { calls.push(opts); return { ok: false, reason: 'cap', count: 30 }; };
  const ledgerPath = path.join(tmp('led'), 'ledger.jsonl');
  const judge = szz.defaultJudge({ ledgerPath, now: () => NOW }, runner);
  const s = setup(b, { rows, extra: ['--label', '--daily-calls', '99'], deps: { judge, ledgerPath } });
  const json = JSON.parse((await run(s.argv, s.deps)).out);
  assert.equal(calls.length, 1, 'no call after the cap refusal');
  assert.equal(Object.hasOwn(calls[0], 'cap'), false, '--daily-calls never reaches the shared cap');
  assert.equal(json.failed.label, 1, JSON.stringify(json.failed));
  assert.deepEqual([json.labelled, json.labelCalls.used, json.labelCalls.stop], [0, 0, 'shared-cap']);
  calls.length = 0;
  const text = await run(s.argv.filter((a) => a !== '--json'), s.deps);
  assert.equal(text.code, 0, text.err);
  assert.deepEqual(stopLines(text.out), ['labelling stopped: shared headless cap reached (30)']);
});

test('R13: reportPathProblem allows .claudedocs and .claude/cache/e2e of the repo, and refuses the rest of the repo, the gold dir and the state dir (breaks if an allowed folder is refused or a repo path passes)', () => {
  const root = tmp('root');
  const gold = path.join(root, 'scripts', 'gold');
  const state = tmp('st');
  const p = (f, g = gold) => szz.reportPathProblem({ report: f }, g, state, root);
  assert.equal(p(path.join(root, '.claudedocs', 'e2e-x', 'r.txt')), null);
  assert.equal(p(path.join(root, '.claude', 'cache', 'e2e', 'r.txt')), null);
  assert.equal(p(path.join(tmp('else'), 'r.txt')), null, 'outside the repo');
  for (const f of [
    path.join(root, 'scripts', 'r.txt'), path.join(root, '.claudedocs', '..', 'scripts', 'r.txt'), path.join(root, '.claudedocsx', 'r.txt'),
    path.join(root, '.claude', 'cache', 'e2e-other', 'r.txt'), path.join(root, '..x', 'r.txt'), path.join(gold, 'r.txt'), path.join(state, 'r.txt'),
  ]) assert.notEqual(p(f), null, f);
  const goldInDocs = path.join(root, '.claudedocs', 'gold');
  assert.notEqual(p(path.join(goldInDocs, 'r.txt'), goldInDocs), null, 'the gold dir stays refused inside an allowed folder');
});

test('G4: --report refuses a path into a gold folder through a trailing dot or space, a junction, or a gold folder of another checkout (breaks if the check compares the raw text only)', () => {
  const root = tmp('root');
  const gold = path.join(root, 'scripts', 'gold');
  mkdirSync(gold, { recursive: true });
  const state = tmp('st');
  const p = (f, g = gold) => szz.reportPathProblem({ report: f }, g, state, root);
  const scratchGold = path.join(tmp('scratch'), 'gold');
  mkdirSync(scratchGold);
  assert.notEqual(p(`${scratchGold}.${path.sep}r.txt`, scratchGold), null, 'trailing dot, gold dir outside the repo');
  assert.notEqual(p(`${scratchGold} ${path.sep}r.txt`, scratchGold), null, 'trailing space, gold dir outside the repo');
  const outside = tmp('outside');
  const link = path.join(outside, 'link');
  symlinkSync(gold, link, 'junction');
  const other = path.join(tmp('primary'), 'scripts', 'eval', 'review-eval', 'gold');
  mkdirSync(other, { recursive: true });
  for (const [name, f] of [
    ['trailing dot', `${gold}.${path.sep}r.txt`], ['trailing space', `${gold} ${path.sep}r.txt`], ['junction', path.join(link, 'r.txt')],
    ['another checkout gold', path.join(other, 'gold-a.json')], ['another checkout gold, upper case', path.join(other.toUpperCase(), 'R.TXT')],
  ]) assert.notEqual(p(f), null, name);
  assert.equal(p(path.join(outside, 'r.txt')), null, 'a plain path outside the repo stays allowed');
  assert.equal(p(path.join(root, '.claudedocs', 'e2e-gold-a-x', 'r.txt')), null, 'a folder name that only holds "gold" stays allowed');
});

test('R14: ids are stable between runs: a row or control dropped before another does not change its id; the label key holds the judge version (breaks if ids are counters or the key has no version)', async () => {
  const all = await bigRun();
  assert.equal(all.code, 0, all.err);
  const ids = loadGold(all.gold).rows.map((x) => x.id);
  const less = await bigRun([], { judge: fakeJudge([{ verdict: 'noise', severity: 'minor' }, REAL('critical'), REAL('minor')]) });
  assert.equal(less.code, 0, less.err);
  assert.deepEqual(loadGold(less.gold).rows.map((x) => x.id), ids.slice(1));
  const k1 = await ctl();
  const k2 = await ctl({ escapeRows: [{ blamedPr: 139, blamedMergeSha: SHA(139) }] });
  const idOf = (r) => new Map(r.controls.map((c) => [c.target.pr, c.id]));
  assert.ok(k2.controls.length < k1.controls.length);
  for (const [pr, id] of idOf(k2)) assert.equal(idOf(k1).get(pr), id, `control ${pr}`);
  // An old cache row (key without the judge version) is not reused.
  const b = small();
  const s = setup(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge: fakeJudge([REAL()]) } });
  const old = { key: `${b.prs[12].shas[0]}:${b.prs[11].mergeSha}:src/f.txt:2`, verdict: 'real', severity: 'major' };
  writeFileSync(path.join(s.state, 'szz-labels.jsonl'), `${JSON.stringify(old)}\n`);
  const r = await run(s.argv, s.deps);
  assert.equal(r.code, 0, r.err);
  assert.equal(s.deps.judge.prompts.length, 1, 'a label of another judge version is asked again');
});

test('R15: a batch prompt stays under BATCH_CHAR_LIMIT; an item over the limit goes alone (breaks if there is no per-batch character cap)', () => {
  assert.equal(szz.BATCH_CHAR_LIMIT, 24_000);
  const item = (i, n) => ({ id: i, kind: 'fix', subject: 's', hunk: 'h', blamed: 'b'.repeat(n) });
  const items = Array.from({ length: 10 }, (_, i) => item(i, 3000));
  const batches = batchItems(items);
  assert.ok(batches.length >= 2, `${batches.length} batch`);
  assert.deepEqual(batches.flat().map((x) => x.id), items.map((x) => x.id), 'order and items are kept');
  for (const bt of batches) assert.ok(buildPrompt(bt).length <= szz.BATCH_CHAR_LIMIT, `${buildPrompt(bt).length} chars`);
  const big1 = item('big', 30_000);
  const mixed = batchItems([item(1, 10), big1, item(2, 10)]);
  assert.deepEqual(mixed.map((bt) => bt.map((x) => x.id)), [[1], ['big'], [2]]);
});

test('R16: two runs in one file whose last line is blank both see that line: the cached file is not cut twice (breaks if pop mutates the cached lines)', async () => {
  const b = buildRepo([
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('a', 'bad1', 'x', 'bad2', '') } }] },
    { n: 12, at: B_DAY, commits: [{ subject: 'fix: f (#9001)', files: { 'src/f.txt': lines('a', 'good1', 'x', 'good2', '') } }] },
  ]);
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  const pair2 = judge.prompts[0].split('### Pair 2')[1];
  assert.ok(pair2, judge.prompts[0]);
  assert.ok(pair2.includes('    5| '), pair2);
});

test('R17: a blamed run longer than the cap shows 40 numbered lines and a cut marker (breaks if the cap is off by one or the marker is missing)', async () => {
  const n = Array.from({ length: 60 }, (_, i) => i + 1);
  const b = buildRepo([
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines(...n.map((i) => `bad-${i}`)) } }] },
    { n: 12, at: B_DAY, commits: [{ subject: 'fix: f (#9001)', files: { 'src/f.txt': lines(...n.map((i) => `good-${i}`)) } }] },
  ]);
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  const numbered = judge.prompts[0].split('\n').filter((l) => /^[> ] +\d+\| /.test(l));
  assert.equal(numbered.length, 40);
  assert.match(judge.prompts[0], /more lines cut/);
});

test('R18: the text report shows the failed control round reads (breaks if roundFailed is left out)', async () => {
  const b = small();
  const s = setup(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })] });
  const r = await run(s.argv.filter((a) => a !== '--json'), s.deps);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /round failed \d+/);
});

test('R18b: the text report names the group 2 start and the merged-head count in the controls line, and the merged-head note (breaks if the line or the note is dropped)', async () => {
  const b = small();
  const s = setup(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })] });
  const r = await run(s.argv.filter((a) => a !== '--json'), s.deps);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^controls: group1 \d+, group2 \d+ \(from 06-01\), merged head without round \d+, no merged head \d+, removed blamed \d+, /m);
  assert.match(r.out, /a control with no CodeRabbit round uses its merged head \(Dave, 2026-11-14\)/);
});

/** Two blamed PRs (11: src/f.txt, 13: src/g.txt) and one fix PR 12 for both. Both rows are real and major, so both are counted. */
async function noRecordRun(records) {
  const b = buildRepo([
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy', 'omega') } }] },
    { n: 13, at: A_DAY, commits: [{ subject: 'feat: g', files: { 'src/g.txt': lines('one', 'bad', 'two') } }] },
    { n: 12, at: B_DAY, commits: [{ subject: 'fix: both (#9001)', files: { 'src/f.txt': lines('alpha', 'fixed', 'omega'), 'src/g.txt': lines('one', 'good', 'two') } }] },
  ]);
  const reportFile = path.join(tmp('rep'), 'report.txt');
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11, primary: false }), escRow(b, { fixPr: 12, blamedPr: 13 })];
  const r = await report(b, { rows, extra: ['--label', '--report', reportFile], deps: { judge: fakeJudge([REAL('major')]), readRecords: () => records } });
  const text = readFileSync(reportFile, 'utf8').split('\n');
  const at = text.findIndex((l) => l.startsWith('counted by suite: '));
  return { ...r, text, at };
}

test('S12c: a counted capability row counts as "no engine record" only when its blamed PR has no record at all, in the JSON and the text line right after "counted by suite" (breaks if every capability row is counted, or the line is dropped or moved)', async () => {
  const r = await noRecordRun([{ pr: 11, findings: [{ file: 'src/other.txt', startLine: 50 }] }]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.countedBySuite, { capability: 2 }, 'both rows are capability: the check is not vacuous');
  assert.equal(r.json.capabilityNoRecord, 1);
  assert.ok(r.at >= 0, r.text.join('\n'));
  assert.equal(r.text[r.at + 1], 'capability, no engine record for the PR: 1');
});

test('S12d: a regression row is never in the no-record count (breaks if the count takes rows that have a record, or keys the record by another PR)', async () => {
  const r = await noRecordRun([{ pr: 11, findings: [{ file: 'src/f.txt', startLine: 2, endLine: 2 }] }]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.countedBySuite, { regression: 1, capability: 1 }, 'one row of each suite: the check is not vacuous');
  assert.equal(r.json.capabilityNoRecord, 1, 'only the capability row of the PR with no record');
  assert.equal(r.text[r.at + 1], 'capability, no engine record for the PR: 1');
});

test('R19: a written file that is not byte-equal to its staged content rolls back all three files (breaks if the byte check runs after the old files are gone)', async () => {
  const corrupt = (from, to) => { renameSync(from, to); if (from.endsWith('.tmp') && path.basename(to) === 'escape-baseline.json') writeFileSync(to, 'corrupt'); };
  const s = writeSetup({ rename: corrupt });
  plantOld(s.gold);
  const r = await run(s.argv, s.deps);
  assert.equal(r.code, 2, `the failed write is reported, not a gate refusal: ${r.err}`);
  for (const f of GOLD_FILES) assert.equal(readFileSync(path.join(s.gold, f), 'utf8'), `OLD ${f}\n`, `${f} is the old file`);
  assert.deepEqual(readdirSync(s.gold).sort(), GOLD_FILES);
});

test('R19b: a rollback step that fails is named in the thrown error with the .bak hint (breaks if undo errors are swallowed)', () => {
  const dir = tmp('rollback');
  writeFileSync(path.join(dir, 'a.json'), 'OLD a\n');
  writeFileSync(path.join(dir, 'b.json'), 'OLD b\n');
  const rename = (from, to) => {
    if (from.endsWith('.tmp') && path.basename(to) === 'b.json') throw new Error('rename in failed');
    if (from.endsWith('a.json.bak')) throw new Error('restore of a failed');
    renameSync(from, to);
  };
  assert.throws(
    () => szz.writeAll(dir, [{ name: 'a.json', content: 'NEW a\n' }, { name: 'b.json', content: 'NEW b\n' }], { rename }),
    (err) => /rename in failed/.test(err.message) && /rollback failed \(1\): restore of a failed/.test(err.message) && /\.bak files in/.test(err.message),
  );
  assert.equal(readFileSync(path.join(dir, 'b.json'), 'utf8'), 'OLD b\n', 'the other old file is restored');
});

test('G3: a .bak file left by a failed rollback is never overwritten: the next write refuses, writes nothing and keeps the .bak (breaks if writeAll renames over a left .bak)', async () => {
  const dir = tmp('leftbak');
  writeFileSync(path.join(dir, 'a.json'), 'NEW-ish a\n');
  writeFileSync(path.join(dir, 'a.json.bak'), 'ONLY COPY of old a\n');
  assert.throws(() => szz.writeAll(dir, [{ name: 'a.json', content: 'NEWER a\n' }, { name: 'b.json', content: 'NEW b\n' }]), /a\.json\.bak/);
  assert.equal(readFileSync(path.join(dir, 'a.json.bak'), 'utf8'), 'ONLY COPY of old a\n', 'the .bak is kept');
  assert.equal(readFileSync(path.join(dir, 'a.json'), 'utf8'), 'NEW-ish a\n', 'the file is not replaced');
  assert.deepEqual(readdirSync(dir).sort(), ['a.json', 'a.json.bak'], 'no b.json, no .tmp');
  const s = writeSetup();
  plantOld(s.gold);
  writeFileSync(path.join(s.gold, 'gold-a.json.bak'), 'ONLY COPY\n');
  const r = await run(s.argv, s.deps);
  assert.notEqual(r.code, 0, 'the run reports the refusal');
  assert.match(r.err, /gold-a\.json\.bak/);
  assert.equal(readFileSync(path.join(s.gold, 'gold-a.json.bak'), 'utf8'), 'ONLY COPY\n');
  for (const n of GOLD_FILES) assert.equal(readFileSync(path.join(s.gold, n), 'utf8'), `OLD ${n}\n`, `${n} is the old file`);
});

test('R20: an escape row with an unreadable fix time is counted as failed, not dropped silently (breaks if the row is filtered out uncounted)', async () => {
  const b = small();
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11 }), escRow(b, { fixPr: 12, blamedPr: 11, fixMergedAt: 'garbage' })];
  const r = await report(b, { rows });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.failed['fix-time'], 1, JSON.stringify(r.json.failed));
  assert.equal(r.json.pairs, 2);
});

// ---------- leak round: safe and small judge prompts (L<item>) ----------
// The new exports are read through the namespace (szz.), so on the old code each test fails alone and the file still loads.

const ODD = ['zanzibar', 'quokka', 'telemetry'];
const SHA_A = 'abcdef0123456789abcdef0123456789abcdef01';
const SHA_B = '0123456789abcdef0123456789abcdef01234567';
const TITLE = 'fix: quokka drift in the parser';
const leakOf = () => szz.leakTerms([SHA_A, SHA_B, 'open-bug', undefined], [`${TITLE} (#4242)`, 'Merge pull request #4242 from x/y', 'wip']);
const cacheRows = (state) => readFileSync(path.join(state, 'szz-labels.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('L01: the judge prompt holds no part of the fix subject, in a built prompt and end to end (breaks if the "Fix subject:" line comes back)', async () => {
  const built = buildPrompt([{ kind: 'fix', subject: `fix: ${ODD.join(' ')}`, hunk: '@@ -2 +2 @@\n-buggy\n+fixed', blamed: '>    2| buggy' }]);
  assert.equal(built.includes('+fixed'), true, 'the hunk is in: the check is not vacuous');
  for (const w of [...ODD, 'Fix subject']) assert.equal(built.includes(w), false, w);
  const b = small({ fixSubject: `fix: ${ODD.join(' ')} (#9001)` });
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  assert.equal(judge.prompts.length, 1);
  for (const w of [...ODD, 'Fix subject']) assert.equal(judge.prompts[0].includes(w), false, w);
  assert.equal(r.json.labelled, 1);
});

test('L02: leakTerms keeps scrubbed fix titles and fix shas; promptGuard and sendGuarded refuse each leak kind and never call the judge; a clean prompt is sent (breaks if a check is dropped or the judge is called first)', async () => {
  const leak = leakOf();
  assert.deepEqual(leak.titles, [TITLE], 'the merge subject scrubs to nothing and a short title is not guarded');
  assert.deepEqual(leak.shas, [SHA_A, SHA_B]);
  const hits = [
    ...['see #4242 here', 'PR-4242', 'PR 4242', 'pr 4242', 'pulls/4242', 'pull/4242', 'issues/4242'].map((t) => [t, 'pr-number']),
    ['log("FIX: Quokka drift in the parser")', 'fix-title'],
    [`ref ${SHA_A.slice(0, 7)} x`, 'fix-sha'], [`ref ${SHA_B} x`, 'fix-sha'], [`id_e${SHA_A.slice(0, 9)}`, 'fix-sha'],
  ];
  for (const [text, kind] of hits) {
    const prompt = `clean text\n${text}\nmore clean text`;
    assert.equal(szz.promptGuard(prompt, leak), kind, text);
    let calls = 0;
    const sent = await szz.sendGuarded(prompt, leak, async () => { calls += 1; return { ok: true }; });
    assert.deepEqual(sent, { refused: kind }, text);
    assert.equal(calls, 0, `the judge is not called: ${text}`);
  }
  const clean = 'a clean prompt: the parser drifts, color #fff, sha fedcba9876 of another commit';
  assert.equal(szz.promptGuard(clean, leak), null);
  let calls = 0;
  const sent = await szz.sendGuarded(clean, leak, async (p) => { calls += 1; return { ok: true, result: p }; });
  assert.equal(calls, 1);
  assert.deepEqual(sent, { res: { ok: true, result: clean } });
});

test('L02b: a fix title in a diff line refuses the item end to end: the per-item guard leaves it out, no judge call, no slot taken, prompt-guard counts it, the pair stays unlabelled (breaks if the per-item guard is dropped)', async () => {
  const b = buildRepo([
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', `log("${TITLE}")`, 'omega') } }] },
    { n: 12, at: B_DAY, commits: [{ subject: `${TITLE} (#9001)`, files: { 'src/f.txt': lines('alpha', 'fixed', 'omega') } }] },
  ]);
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  assert.equal(judge.prompts.length, 0);
  assert.equal(r.json.failed['prompt-guard'], 1, JSON.stringify(r.json.failed));
  assert.equal(r.json.labelCalls.used, 0, 'a refused prompt takes no daily slot');
  assert.deepEqual([r.json.labelled, r.json.unlabelled], [0, 1]);
});

test('L02c: of 3 items where 1 holds the fix title, one call goes with the 2 clean items, prompt-guard counts 1, the leaking item stays unlabelled (breaks if the guard runs only on the whole batch prompt)', async () => {
  const body = (b2) => Array.from({ length: 30 }, (_, i) => ({ 4: b2 ? 'good-a' : 'bad-a', 14: b2 ? 'good-b' : `log("${TITLE}")`, 24: b2 ? 'good-c' : 'bad-c' }[i] ?? `c${i}`));
  const b = buildRepo([
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines(...body(false)) } }] },
    { n: 12, at: B_DAY, commits: [{ subject: `${TITLE} (#9001)`, files: { 'src/f.txt': lines(...body(true)) } }] },
  ]);
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  assert.equal(judge.prompts.length, 1, JSON.stringify(r.json.failed));
  const p = judge.prompts[0];
  assert.equal([...p.matchAll(/^### Pair/gm)].length, 2);
  assert.equal(p.includes('+good-a') && p.includes('+good-c'), true, p);
  assert.equal(p.toLowerCase().includes(TITLE) || p.includes('good-b'), false, 'the leaking item is not in the call');
  assert.equal(r.json.failed['prompt-guard'], 1, JSON.stringify(r.json.failed));
  assert.deepEqual([r.json.labelled, r.json.unlabelled], [2, 1]);
  assert.equal(r.json.labelCalls.used, 1);
});

test('L03: maskShas masks each hex run that is a prefix of a fix sha, short, full or upper case; the guard then passes; a prefix inside a longer hex run stays and is refused (breaks if the mask is dropped or masks only full shas)', () => {
  const leak = leakOf();
  const text = `-ref ${SHA_A.slice(0, 12)} and ${SHA_B}\n+ref (${SHA_A.slice(0, 7).toUpperCase()}) other deadbeef1`;
  const masked = szz.maskShas(text, leak.shas);
  assert.equal(masked, '-ref <sha> and <sha>\n+ref (<sha>) other deadbeef1');
  assert.equal(szz.promptGuard(masked, leak), null);
  const glued = `x e${SHA_A.slice(0, 7)} y`;
  assert.equal(szz.maskShas(glued, leak.shas), glued, 'e + the prefix is one hex run, and it is no prefix');
  assert.equal(szz.promptGuard(glued, leak), 'fix-sha');
});

test('L03b: a diff line that names a fix sha of the run comes out masked end to end, and the guard passes (breaks if the mask does not run before the guard)', async () => {
  const b = small();
  const fixSha = b.prs[12].shas[0];
  const mergeSha = b.prs[12].mergeSha;
  extendRepo(b, [
    { n: 13, at: '2026-10-12T10:00:00Z', commits: [{ subject: 'feat: g', files: { 'src/g.txt': lines('one', `ref ${fixSha.slice(0, 12)} and ${mergeSha}`, 'two') } }] },
    { n: 14, at: '2026-10-13T10:00:00Z', commits: [{ subject: 'fix: g ref', files: { 'src/g.txt': lines('one', 'ref none', 'two') } }] },
  ]);
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 }), escRow(b, { fixPr: 14, blamedPr: 13 })], extra: ['--label'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  assert.equal(judge.prompts.length, 1, JSON.stringify(r.json.failed));
  const prompt = judge.prompts[0];
  assert.equal(prompt.includes('-ref <sha> and <sha>'), true, prompt);
  for (const s of [fixSha, mergeSha]) assert.equal(prompt.includes(s.slice(0, 7)), false, 'no fix sha prefix is left');
  assert.equal(r.json.failed['prompt-guard'], undefined);
  assert.equal(r.json.labelled, 2);
});

/** A hunk head line with text after the second @@, and its body lines. */
const H = (start, count, body) => [`@@ -${start}${count === undefined ? '' : `,${count}`} +${start} @@ fn()`, ...body];

test('L04c: cutHunks keeps whole hunks whose old range is within the slack of the blamed lines, keeps the lines before the first hunk, keeps the nearest hunk when none is in reach, and reads -a,0 as after line a (breaks if a hunk is split, the slack is off by one, or no hunk is kept)', () => {
  const top = H(5, undefined, ['-top', '+top2']);
  const mid = H(20, 2, ['-m1', '-@@ -99 +99 @@ removed text, not a hunk head', '+n1']);
  const near = H(24, undefined, ['-near', '+near2']);
  const far = H(28, undefined, ['-far', '+far2']);
  const three = szz.cutHunks([...top, ...mid, ...far].join('\n'), { line: 21, endLine: 21 }, 3);
  assert.equal(three.hunk, mid.join('\n'), 'only the middle hunk, whole: line 20 and the -@@ line stay though only line 21 is blamed');
  assert.deepEqual([three.hunksShown, three.hunksLeftOut], [1, 2]);
  const diff = [...top, ...mid, ...near, ...far].join('\n');
  const adj = szz.cutHunks(diff, { line: 20, endLine: 21 }, 3);
  assert.equal(adj.hunk, [...mid, ...near].join('\n'), 'a hunk 3 lines past the run is next to it');
  assert.deepEqual([adj.hunksShown, adj.hunksLeftOut], [2, 2]);
  assert.equal(szz.cutHunks(diff, { line: 20, endLine: 21 }, 2).hunk, mid.join('\n'), 'one line past the slack is out');
  const none = szz.cutHunks(diff, { line: 12, endLine: 12 }, 0);
  assert.equal(none.hunk, top.join('\n'), 'no hunk in reach: the nearest one hunk');
  assert.deepEqual([none.hunksShown, none.hunksLeftOut], [1, 3]);
  const ins = H(12, 0, ['+new1', '+new2']);
  const after = H(19, undefined, ['-x', '+y']);
  const pair = [...ins, ...after].join('\n');
  assert.equal(szz.cutHunks(pair, { line: 15, endLine: 15 }, 3).hunk, ins.join('\n'), '-12,0 sits after line 12: in reach of line 15 with slack 3');
  assert.equal(szz.cutHunks(pair, { line: 16, endLine: 16 }, 3).hunk, after.join('\n'), 'and out of reach of line 16');
  const head = ['diff --git a/f b/f', '--- a/f', '+++ b/f'];
  assert.equal(szz.cutHunks([...head, ...top, ...far].join('\n'), { line: 5, endLine: 5 }, 3).hunk, [...head, ...top].join('\n'), 'the lines before the first hunk stay');
});

test('L04: a fix diff of 12 one-line hunks, over HUNK_LIMIT as a whole, gives 12 small items packed 10 to a call, each with 1 hunk shown and 11 left out (breaks if each item keeps the whole file diff)', async () => {
  const Q = 'q'.repeat(300);
  const body = (word) => Array.from({ length: 120 }, (_, i) => (i % 10 === 4 ? `${word}-${i} ${Q}` : `c${i}`));
  const b = buildRepo([
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines(...body('bad')) } }] },
    { n: 12, at: B_DAY, commits: [{ subject: 'fix: f (#9001)', files: { 'src/f.txt': lines(...body('good')) } }] },
  ]);
  const fixSha = b.prs[12].shas[0];
  const whole = sh(b.dir, ['diff', '--unified=0', `${fixSha}^`, fixSha]);
  assert.ok(whole.length > HUNK_LIMIT, `the whole diff is ${whole.length} chars: the check is not vacuous`);
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label', '--allow-label-cache-write'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(judge.prompts.map((p) => [...p.matchAll(/^### Pair/gm)].length), [BATCH_SIZE, 2]);
  assert.deepEqual(judge.prompts.map((p) => [...p.matchAll(/^@@ -/gm)].length), [BATCH_SIZE, 2], 'one hunk for each pair');
  assert.equal(r.json.labelled, 12);
  const cached = cacheRows(r.state);
  assert.ok(cached.length === 12 && cached.every((c) => c.hunksShown === 1 && c.hunksLeftOut === 11), JSON.stringify(cached.map((c) => [c.hunksShown, c.hunksLeftOut])));
});

test('L04b: the diff is cut by the blamed lines at the parent of the fix, not by their head lines: after a 10-line shift the middle hunk is still the one shown; the counts go in the cache row (breaks if cutHunks gets the head lines)', async () => {
  const base = Array.from({ length: 40 }, (_, i) => `n${i + 1}`);
  const withMid = base.map((l, i) => (i === 19 ? 'mid-bad' : l));
  const pre = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);
  const fixed = withMid.map((l, i) => ({ 4: 'top-fix', 19: 'mid-fix', 34: 'bot-fix' }[i] ?? l));
  const b = buildRepo([
    { n: 10, at: '2026-10-09T10:00:00Z', commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines(...base) } }] },
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: mid', files: { 'src/f.txt': lines(...withMid) } }] },
    { direct: { at: '2026-10-10T12:00:00Z', subject: 'chore: prepend', files: { 'src/f.txt': lines(...pre, ...withMid) } } },
    { n: 12, at: B_DAY, commits: [{ subject: 'fix: f (#9001)', files: { 'src/f.txt': lines(...pre, ...fixed) } }] },
  ]);
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label', '--allow-label-cache-write'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  assert.equal(judge.prompts.length, 1);
  const p = judge.prompts[0];
  assert.equal(p.includes('+mid-fix'), true, p);
  assert.equal(p.includes('top-fix') || p.includes('bot-fix'), false, p);
  assert.match(p, /^> +20\| mid-bad$/m, 'the blamed line is line 20 at the head and line 30 at the parent of the fix');
  const [row] = cacheRows(r.state);
  assert.deepEqual([row.line, row.hunksShown, row.hunksLeftOut], [20, 1, 2]);
});

test('M10b: the lineSlack of the run reaches the diff cut end to end: a pure insertion 2 lines past the blamed line is shown with slack 2 and left out with slack 1 (breaks if runItem passes 0 or a fixed slack to cutHunks)', async () => {
  const b = buildRepo([
    { n: 10, at: '2026-10-09T10:00:00Z', commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7') } }] },
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: bad', files: { 'src/f.txt': lines('l1', 'l2', 'bad', 'l4', 'l5', 'l6', 'l7') } }] },
    // The fix changes line 3 and inserts a line after line 5: a -5,0 hunk that holds no blamed line.
    { n: 12, at: B_DAY, commits: [{ subject: 'fix: f (#9001)', files: { 'src/f.txt': lines('l1', 'l2', 'good', 'l4', 'l5', 'inserted', 'l6', 'l7') } }] },
  ]);
  const fixSha = b.prs[12].shas[0];
  assert.match(sh(b.dir, ['diff', '--unified=0', `${fixSha}^`, fixSha]), /^@@ -5,0 /m, 'the second hunk is a pure insertion after line 5: the check is not vacuous');
  for (const [slack, shown] of [[2, [2, 0]], [1, [1, 1]]]) {
    const judge = fakeJudge([REAL()]);
    const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label', '--allow-label-cache-write'], deps: { judge, cfg: { ...CFG, lineSlack: slack } } });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([r.json.pairs, r.json.labelled, Object.keys(r.json.failed).length], [1, 1, 0], JSON.stringify(r.json));
    assert.equal(judge.prompts.length, 1);
    const p = judge.prompts[0];
    assert.equal(p.includes('+good'), true, p);
    assert.equal(p.includes('+inserted'), shown[0] === 2, `slack ${slack}: ${p}`);
    const [row] = cacheRows(r.state);
    assert.deepEqual([row.line, row.hunksShown, row.hunksLeftOut], [3, ...shown], `slack ${slack}`);
  }
});

test('L05: JUDGE_VERSION is szz-label-v2 and labelKey carries it, so a szz-label-v1 cache row is asked again (breaks if the version is not bumped)', async () => {
  assert.equal(szz.JUDGE_VERSION, 'szz-label-v2');
  const c = { fixSha: 'f'.repeat(40), blamedMergeSha: 'c'.repeat(40), file: 'a.txt', line: 3 };
  assert.equal(szz.labelKey(c), `szz-label-v2:${'f'.repeat(40)}:${'c'.repeat(40)}:a.txt:3`);
  const b = small();
  const s = setup(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge: fakeJudge([REAL()]) } });
  const v1 = { key: `szz-label-v1:${b.prs[12].shas[0]}:${b.prs[11].mergeSha}:src/f.txt:2`, verdict: 'noise', severity: 'minor' };
  writeFileSync(path.join(s.state, 'szz-labels.jsonl'), `${JSON.stringify(v1)}\n`);
  const r = await run(s.argv, s.deps);
  assert.equal(r.code, 0, r.err);
  assert.equal(s.deps.judge.prompts.length, 1, 'the v1 label is not reused');
  assert.equal(JSON.parse(r.out).verdicts.real, 1);
});

test('L06: the usage and the text report say the judge prompt shows gold line numbers by design and the fix diff is cut near the blamed lines (breaks if a note is dropped)', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  const b = small();
  const s = setup(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })] });
  const text = await run(s.argv.filter((a) => a !== '--json'), s.deps);
  assert.equal(text.code, 0, text.err);
  for (const out of [help.out, text.out]) {
    assert.match(out, /the judge prompt shows gold line numbers by design/i);
    assert.match(out, /the fix diff is cut to the hunks near the blamed lines/i);
    assert.match(out, /titles under 8 characters are not guarded/i);
  }
});

// ---------- critic round 3: one test per finding (R3-<finding>) ----------

test('R3-M1: --write refuses a fix-chains input that starts after the first group 2 merge and names its start; a dry run prints the same line as a note; an input from 06-01 writes (breaks if the coverage gate or its note is dropped)', async () => {
  // A PR merged 2026-06-15 is the first group 2 merge. FIXES starts at PR 100 (2026-08-01): it misses fixes that could remove PR 90.
  const b = buildRepo([{ n: 90, at: '2026-06-15T12:00:00Z', commits: [{ subject: 'feat: june', files: { 'june/90.txt': 'j\n' } }] }, ...bigSteps()]);
  const LINE = 'fix-chains input does not cover group 2 (starts 2026-08-01)';
  const late = FIXES(b);
  const bad = await report(b, { rows: bigRows(b), extra: writeArgs, deps: { judge: fakeJudge([REAL()]), fixChains: late, dataset: DATASET } });
  assert.equal(bad.code, 1, bad.err);
  assert.ok(bad.err.split('\n').includes(`mine-szz: ${LINE}`), bad.err);
  assert.equal(existsSync(bad.gold), false, 'nothing written');
  const dry = setup(b, { rows: bigRows(b), deps: { fixChains: late, dataset: DATASET } });
  const text = await run(dry.argv.filter((a) => a !== '--json'), dry.deps);
  assert.equal(text.code, 0, text.err);
  assert.ok(textOf(text.out).includes(LINE), text.out);
  // A walk with --since 2026-06-01: its first PR is PR 90, the first group 2 merge.
  const from0601 = { perPr: [{ pr: 90, mergeSha: b.prs[90].mergeSha, rows: [], noTarget: null, fix: false }, ...late.perPr] };
  const ok = await report(b, { rows: bigRows(b), extra: writeArgs, deps: { judge: fakeJudge([REAL()]), fixChains: from0601, dataset: DATASET } });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.json.notes.some((n) => n.startsWith('fix-chains input does not cover')), false, JSON.stringify(ok.json.notes));
});

test('R3-M2: a fix title that holds a fix sha prefix is masked like the prompt, so the guard still finds it after the mask (breaks if leakTerms keeps titles unmasked)', () => {
  const title = `revert ${SHA_A.slice(0, 10)}: quokka drift parser`;
  const leak = szz.leakTerms([SHA_A], [title]);
  const prompt = szz.maskShas(buildPrompt([{ kind: 'fix', hunk: `@@ -2 +2 @@\n-log("${title}")\n+fixed`, blamed: '>    2| fixed' }]), leak.shas);
  assert.equal(prompt.includes(SHA_A.slice(0, 7)), false, 'the sha of the diff line is masked: the check is not vacuous');
  assert.equal(szz.promptGuard(prompt, leak), 'fix-title');
});

test('R3-m1: a shared-lock refusal (no ledger id) takes no slot, is tried once more with the same prompt, then stops the run with the lock line; a lock then an answer labels the batch (breaks if the own row stays or the lock is not retried)', async () => {
  const b = twoHuge();
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11 })];
  const prompts = [];
  const locked = async (prompt) => { prompts.push(prompt); return { ok: false, reason: 'lock' }; };
  const ledgerPath = path.join(tmp('led'), 'ledger.jsonl');
  const s = setup(b, { rows, extra: ['--label', '--daily-calls', '99'], deps: { judge: szz.defaultJudge({ ledgerPath, now: () => NOW }, locked), ledgerPath } });
  const json = JSON.parse((await run(s.argv, s.deps)).out);
  assert.equal(prompts.length, 2, 'one call and one retry, then the stop');
  assert.equal(prompts[0], prompts[1], 'the retry sends the same batch');
  assert.deepEqual([json.labelled, json.labelCalls.used, json.labelCalls.stop], [0, 0, 'shared-lock']);
  assert.equal(json.failed.label, 1, JSON.stringify(json.failed));
  const text = await run(s.argv.filter((a) => a !== '--json'), s.deps);
  assert.equal(text.code, 0, text.err);
  assert.deepEqual(stopLines(text.out), ['labelling stopped: shared headless lock busy']);
  let k = 0;
  const once = async (prompt) => {
    k += 1;
    if (k === 1) return { ok: false, reason: 'lock' };
    const n = [...prompt.matchAll(/^### Pair (\d+)/gm)].length;
    return { ok: true, id: `id-${k}`, result: JSON.stringify(Array.from({ length: n }, (_, i) => ({ pair: i + 1, ...REAL() }))) };
  };
  const s2 = setup(b, { rows, extra: ['--label', '--daily-calls', '99'], deps: { judge: szz.defaultJudge({ ledgerPath, now: () => NOW }, once), ledgerPath } });
  const j2 = JSON.parse((await run(s2.argv, s2.deps)).out);
  assert.equal(k, 3, 'a lock, its retry, the second batch');
  assert.deepEqual([j2.labelled, j2.labelCalls.used, j2.labelCalls.stopped ?? false], [2, 2, false]);
});

test('R3-m2: when only the batch prompt leaks (each item is clean alone, the joined text holds the title), the whole-prompt guard refuses it: no judge call, no slot, prompt-guard counts the batch once (breaks if the whole-prompt guard is dropped or the slot row is pushed before it)', async () => {
  // A fix title that matches the header of the second pair only: an item alone is always "### Pair 1".
  const title = '## Pair 2';
  assert.deepEqual(szz.leakTerms([], [title]).titles, ['## pair 2'], 'the title is guarded: the check is not vacuous');
  const body = (fixed) => Array.from({ length: 20 }, (_, i) => ({ 4: fixed ? 'good-a' : 'bad-a', 14: fixed ? 'good-b' : 'bad-b' }[i] ?? `c${i}`));
  const b = buildRepo([
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines(...body(false)) } }] },
    { n: 12, at: B_DAY, commits: [{ subject: title, files: { 'src/f.txt': lines(...body(true)) } }] },
  ]);
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  assert.equal(judge.prompts.length, 0);
  assert.equal(r.json.failed['prompt-guard'], 1, JSON.stringify(r.json.failed));
  assert.equal(r.json.labelCalls.used, 0, 'a refused batch takes no daily slot');
  assert.deepEqual([r.json.labelled, r.json.unlabelled], [0, 2]);
});

test('R3-m4: a fix title that occurs in the prompt template is not guarded, so a clean item is still labelled, and the report counts it (breaks if template text refuses every prompt or the note is dropped)', async () => {
  const b = small({ fixSubject: 'You label code defects' });
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  assert.equal(judge.prompts.length, 1, JSON.stringify(r.json.failed));
  assert.equal(r.json.labelled, 1);
  assert.ok(r.json.notes.includes('fix titles that occur in the prompt template are not guarded: 1'), JSON.stringify(r.json.notes));
});

test('R3-m5: an escape row whose fixSha or mergeSha is not 40 lower-case hex is not mined and counts failed fix-sha; git never sees it (breaks if the sha check is dropped)', async () => {
  const b = small();
  const good = escRow(b, { fixPr: 12, blamedPr: 11 });
  const rows = [good, { ...good, fixSha: 'not-a-sha' }, { ...good, fixSha: '--all' }, { ...good, mergeSha: good.mergeSha.toUpperCase() }];
  const seen = [];
  const git = (args) => { seen.push(args); return b.git(args); };
  const r = await report(b, { rows, deps: { git } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.failed['fix-sha'], 3, JSON.stringify(r.json.failed));
  assert.equal(r.json.pairs, 4);
  const upper = good.mergeSha.toUpperCase();
  assert.equal(seen.some((a) => a.some((x) => x.includes('not-a-sha') || x.startsWith('--all') || x.includes(upper))), false, 'no bad sha reaches git');
});

test('G2: an escape row whose blamedMergeSha is not 40 lower-case hex, or whose blamedPr is not a positive integer, is not mined and counts failed blamed-target; git and gh never see it (breaks if the blamed check is dropped)', async () => {
  const b = small();
  const good = escRow(b, { fixPr: 12, blamedPr: 11 });
  const bad = [
    { ...good, blamedMergeSha: '--output=x' }, { ...good, blamedMergeSha: good.blamedMergeSha.toUpperCase() }, { ...good, blamedMergeSha: undefined },
    { ...good, blamedPr: 0 }, { ...good, blamedPr: -3 }, { ...good, blamedPr: 1.5 }, { ...good, blamedPr: '11' }, { ...good, blamedPr: '11/../x' },
  ];
  const seen = [];
  const git = (args) => { seen.push(args); return b.git(args); };
  const inner = fakeGh(b);
  const gh = Object.assign(async (args) => inner(args), { calls: inner.calls });
  const r = await report(b, { rows: [good, ...bad], deps: { git, gh } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.failed['blamed-target'], bad.length, JSON.stringify(r.json.failed));
  assert.equal(r.json.pairs, bad.length + 1);
  const upper = good.blamedMergeSha.toUpperCase();
  assert.equal(seen.some((a) => a.some((x) => x.includes('--output=x') || x.includes(upper) || x.includes('undefined'))), false, 'no bad blamed sha reaches git');
  assert.equal(inner.calls.some((a) => /\/pulls\/(0|-3|1\.5|11\/\.\.)/.test(a.at(-1))), false, 'no bad PR number reaches gh');
});

test('G2b: an open bug whose gh PR list gives a number that is not a positive integer maps to no PR (breaks if the open-bug PR number is not checked)', async () => {
  const b = buildRepo([{ n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy', 'omega') } }] }]);
  const origin = b.prs[11].shas[0];
  const pulls = { [origin]: [{ number: '11', merged_at: A_DAY, merge_commit_sha: b.prs[11].mergeSha }] };
  const r = await report(b, { rows: [], extra: ['--open-bug', 'src/f.txt:2', '--open-bug-note', 'the wait never ends'], deps: { gh: fakeGh(b, { pulls }) } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.unmapped['open-bug-no-pr'], 1, JSON.stringify(r.json));
});

test('R3-n1: on a label cache hit the hunk counts come from the cache row (the labelled prompt), not from this run\'s cut (breaks if a cache hit keeps the run counts)', async () => {
  const b = big();
  const s = writeSetup();
  const hit = { fixSha: b.prs[22].shas[0], blamedMergeSha: b.prs[21].mergeSha, file: 's/a.txt', line: 4 };
  writeFileSync(path.join(s.state, 'szz-labels.jsonl'), `${JSON.stringify({ key: szz.labelKey(hit), ...hit, hunksShown: 7, hunksLeftOut: 9, verdict: 'real', severity: 'major' })}\n`);
  const r = await run(s.argv, s.deps);
  assert.equal(r.code, 0, r.err);
  const rows = loadGold(s.gold).rows;
  assert.deepEqual(rows.map((x) => [x.file, x.provenance.hunksShown, x.provenance.hunksLeftOut]), [['s/a.txt', 7, 9], ['s/b.txt', 1, 0], ['s/c.txt', 1, 0]]);
});

test('R3-n2: a 64-hex fix sha in a diff line is masked whole, also a 50-hex prefix of it, and the guard passes (breaks if HEX_RUN stops at 40)', () => {
  const SHA64 = `${SHA_A}0123456789abcdef01234567`;
  assert.equal(SHA64.length, 64);
  const leak = szz.leakTerms([SHA64], []);
  assert.deepEqual(leak.shas, [SHA64]);
  const masked = szz.maskShas(`-ref ${SHA64} x\n+ref ${SHA64.slice(0, 50)} y`, leak.shas);
  assert.equal(masked, '-ref <sha> x\n+ref <sha> y');
  assert.equal(szz.promptGuard(masked, leak), null);
});

test('R3-n3: a diff line that names a non-tip commit of a fix PR comes out masked and the guard passes; a fix title that holds such a prefix is still refused (breaks if only fixSha and mergeSha are leak terms)', async () => {
  const b = buildRepo([
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: add f', files: { 'src/f.txt': lines('alpha', 'buggy', 'omega') } }] },
    { n: 12, at: B_DAY, commits: [{ subject: 'wip: start', files: { 'src/w.txt': 'w\n' } }, { subject: 'fix: correct f', files: { 'src/f.txt': lines('alpha', 'fixed', 'omega') } }] },
  ]);
  const wip = b.prs[12].shas[0];
  const revert = `revert ${wip.slice(0, 10)}: quokka drift parser`;
  extendRepo(b, [
    { n: 13, at: '2026-10-12T10:00:00Z', commits: [{ subject: 'feat: g', files: { 'src/g.txt': lines('one', `ref ${wip.slice(0, 12)}`, 'two') } }] },
    { n: 14, at: '2026-10-13T10:00:00Z', commits: [{ subject: 'fix: g ref', files: { 'src/g.txt': lines('one', 'ref none', 'two') } }] },
    { n: 15, at: '2026-10-14T10:00:00Z', commits: [{ subject: 'feat: h', files: { 'src/h.txt': lines('one', `log("${revert}")`, 'two') } }] },
    { n: 16, at: '2026-10-15T10:00:00Z', commits: [{ subject: revert, files: { 'src/h.txt': lines('one', 'log("none")', 'two') } }] },
  ]);
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11, fixIdx: 1 }), escRow(b, { fixPr: 14, blamedPr: 13 }), escRow(b, { fixPr: 16, blamedPr: 15 })];
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows, extra: ['--label'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  assert.equal(judge.prompts.length, 1, JSON.stringify(r.json.failed));
  const prompt = judge.prompts[0];
  assert.equal(prompt.includes('-ref <sha>'), true, prompt);
  assert.equal(prompt.includes(wip.slice(0, 7)), false, 'no prefix of the non-tip commit is left');
  assert.equal(prompt.includes('quokka'), false, 'the item with the title is not in the call');
  assert.equal(r.json.failed['prompt-guard'], 1, JSON.stringify(r.json.failed));
  assert.deepEqual([r.json.labelled, r.json.unlabelled], [2, 1]);
});

// ---------- control mining (--control-since): escape rows before --since feed only the unmapped-fix control rule ----------

/** June: blamed PR 79 (another file), control candidate PR 80 (src/j.txt), fix PR 82 that removes a line PR 80 wrote: its row does not map. */
const juneRepo = () => buildRepo([
  { n: 79, at: '2026-06-02T12:00:00Z', commits: [{ subject: 'feat: x', files: { 'src/x.txt': lines('x1', 'x2') } }] },
  { n: 80, at: '2026-06-05T12:00:00Z', commits: [{ subject: 'feat: j', files: { 'src/j.txt': lines('a', 'b', 'c') } }] },
  { n: 82, at: '2026-06-20T12:00:00Z', commits: [{ subject: 'fix: j', files: { 'src/j.txt': lines('a', 'B', 'c') } }] },
]);

test('C01: with the default --control-since (the group 2 start) a June control merged 15 days before an unmapped June fix on the same file is removed; the report line names the window; a failed map fails closed (breaks if the control pass is dropped, starts at --since, or skips a failed row)', async () => {
  const b = juneRepo();
  const rows = [escRow(b, { fixPr: 82, blamedPr: 79 })];
  const r = await report(b, { rows });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.controls.removedUnmappedFix, 1, `PR 80 is near the unmapped June fix: ${JSON.stringify(r.json.controls)}`);
  assert.equal(r.json.controls.removedBlamed, 1);
  assert.deepEqual(r.json.controlMining, { from: '2026-06-01', pairs: 1, unmappedFixes: 1, failed: 0 });
  assert.deepEqual([r.json.pairs, r.json.labelled, r.json.unmapped, r.json.failed], [0, 0, {}, {}], 'the main counts do not see the control pass');
  const text = await run(r.argv.filter((a) => a !== '--json'), r.deps);
  assert.equal(text.code, 0, text.err);
  const out = textOf(text.out);
  assert.equal(out[out.findIndex((l) => l.startsWith('controls: ')) + 1], 'control mining from 2026-06-01: pairs 1, unmapped fixes 1', text.out);
  // A window that starts after the fix: no control pair, PR 80 stays.
  const late = await report(b, { rows, extra: ['--control-since', '2026-06-21'] });
  assert.equal(late.code, 0, late.err);
  assert.deepEqual([late.json.controls.removedUnmappedFix, late.json.controlMining.pairs], [0, 0]);
  // A row whose fix commit git cannot read counts failed in the control pass and as an unmapped fix: fail closed.
  const broken = await report(b, { rows: [{ ...rows[0], fixSha: 'e'.repeat(40) }] });
  assert.equal(broken.code, 0, broken.err);
  assert.deepEqual(broken.json.controlMining, { from: '2026-06-01', pairs: 1, unmappedFixes: 1, failed: 1 });
  assert.equal(broken.json.controls.removedUnmappedFix, 1);
  assert.deepEqual(broken.json.failed, {}, 'a control pass failure is not a failed pair of the run');
});

test('C02: extra June escape rows change neither the judge prompts, the label cache nor gold-a.json, though a June fix title is text of an October item and a June row maps (breaks if the control pass adds candidates, labels or leak terms)', async () => {
  const QUOKKA = 'zanzibar quokka telemetry';
  const b = buildRepo([
    { n: 60, at: '2026-06-03T12:00:00Z', commits: [{ subject: 'feat: m', files: { 'src/m.txt': lines('m1', 'mbad', 'm3') } }] },
    { n: 61, at: '2026-06-10T12:00:00Z', commits: [{ subject: QUOKKA, files: { 'src/m.txt': lines('m1', 'mgood', 'm3') } }] },
    ...bigSteps(),
    { n: 31, at: '2026-10-13T10:00:00Z', commits: [{ subject: 'feat: q', files: { 'src/q.txt': lines('q1', QUOKKA, 'q3') } }] },
    { n: 32, at: '2026-10-14T10:00:00Z', commits: [{ subject: 'fix: q (#9001)', files: { 'src/q.txt': lines('q1', 'calm', 'q3') } }] },
  ]);
  const fixChains = { perPr: [{ pr: 60, mergeSha: b.prs[60].mergeSha, rows: [], noTarget: null, fix: false }, ...FIXES(b).perPr] };
  const base = [...bigRows(b), escRow(b, { fixPr: 32, blamedPr: 31 })];
  const june = escRow(b, { fixPr: 61, blamedPr: 60 });
  const once = async (rows) => {
    const judge = fakeJudge([REAL('major')]);
    const r = await report(b, { rows, extra: writeArgs, deps: { judge, fixChains, dataset: DATASET } });
    assert.equal(r.code, 0, r.err);
    return { r, prompts: judge.prompts, cache: readFileSync(path.join(r.state, 'szz-labels.jsonl')), gold: readFileSync(path.join(r.gold, 'gold-a.json')) };
  };
  const without = await once(base);
  const withJune = await once([...base, june]);
  assert.equal(without.prompts.some((p) => p.includes(QUOKKA)), true, 'the October item that holds the June title is labelled: the check is not vacuous');
  assert.equal(withJune.r.json.controlMining.pairs, without.r.json.controlMining.pairs + 1, 'the June row went through the control pass');
  assert.deepEqual(withJune.prompts, without.prompts);
  assert.ok(withJune.cache.equals(without.cache), 'the label cache is byte-equal');
  assert.ok(withJune.gold.equals(without.gold), 'gold-a.json is byte-equal');
  assert.deepEqual([withJune.r.json.pairs, withJune.r.json.labelled, withJune.r.json.counted], [without.r.json.pairs, without.r.json.labelled, without.r.json.counted]);
});

test('C03: --write refuses a --control-since later than the group 2 start with the window line and writes nothing; the group 2 start itself writes (breaks if the gate is dropped or compares the wrong way)', async () => {
  const bad = await bigRun(['--control-since', '2026-06-02']);
  assert.equal(bad.code, 1, bad.err);
  assert.ok(bad.err.split('\n').includes('mine-szz: control mining window starts after group 2 (2026-06-02)'), bad.err);
  assert.equal(existsSync(bad.gold), false, 'nothing written');
  const edge = await bigRun(['--control-since', '2026-06-01T00:00:00Z']);
  assert.equal(edge.code, 0, edge.err);
});

test('C04: a --control-since that is not a date, or has no value, is a usage error before any git call; the usage names the flag (breaks if the flag is not checked)', async () => {
  const boom = () => { throw new Error('must not be called'); };
  const bad = await run(['--control-since', 'x'], { git: boom, gh: boom });
  assert.equal(bad.code, 2, bad.err);
  assert.match(bad.err, /--control-since "x" is not a date/);
  assert.match(bad.err, /usage: /);
  const none = await run(['--control-since'], { git: boom, gh: boom });
  assert.equal(none.code, 2);
  assert.match(none.err, /--control-since needs a value/);
  assert.match((await run(['--help'])).out, /--control-since <iso>/);
});

// ---------- seat diff read of PR 582: one test per finding (D<item><case>) ----------

/** A git that answers `cat-file -e <head>:<file>` with status 1 and the given stderr. Every other call goes to the real git. */
const catFileGit = (git, file, stderr) => (args) => (args[0] === 'cat-file' && String(args.at(-1)).endsWith(`:${file}`) ? { status: 1, stdout: '', stderr } : git(args));
const oldFilesStay = (gold) => {
  for (const n of GOLD_FILES) assert.equal(readFileSync(path.join(gold, n), 'utf8'), `OLD ${n}\n`, `${n} is the old file`);
  assert.deepEqual(readdirSync(gold).sort(), GOLD_FILES, 'no .bak and no .tmp');
};
const errLines = (r) => r.err.split('\n');

test('D1a: a cat-file read that times out (status 1, the makeGit time-out text) is 1 failed pair and --write refuses; the old gold files stay (breaks if any non-zero cat-file status reads as file-gone)', async () => {
  const b = big();
  const s = writeSetup({ git: catFileGit(b.git, 's/a.txt', 'spawnSync git ETIMEDOUT') });
  plantOld(s.gold);
  const r = await run(s.argv, s.deps);
  assert.equal(r.code, 1, r.err);
  assert.deepEqual(JSON.parse(r.out).failed, { 'cat-file': 1 }, r.out);
  assert.ok(errLines(r).includes('mine-szz: failed pairs: 1 (--allow-partial writes anyway)'), r.err);
  oldFilesStay(s.gold);
});

test('D1b: git\'s own missing-path texts, also with status 1, still read as file-gone: the other files of the pair are mined and no pair fails (breaks if the stderr match is dropped or wrong)', async () => {
  const b = big();
  const head = b.prs[21].shas.at(-1);
  for (const text of [`fatal: path 's/a.txt' does not exist in '${head}'`, `fatal: path 's/a.txt' exists on disk, but not in '${head}'`]) {
    const s = writeSetup({ git: catFileGit(b.git, 's/a.txt', text) });
    const r = await run(s.argv, s.deps);
    assert.equal(r.code, 0, `${text}: ${r.err}`);
    assert.deepEqual(JSON.parse(r.out).failed, {}, text);
    assert.deepEqual(loadGold(s.gold).rows.map((x) => x.file), ['s/b.txt', 's/c.txt'], text);
  }
});

const escapesOf = (state) => path.join(state, 'escapes.jsonl');

test('D2a: --write refuses a state dir with no escapes file and the old gold files stay (breaks if the write gate reads a missing file as 0 rows)', async () => {
  const s = writeSetup();
  rmSync(escapesOf(s.state));
  plantOld(s.gold);
  const r = await run(s.argv, s.deps);
  assert.equal(r.code, 1, r.err);
  assert.ok(errLines(r).includes('mine-szz: escapes file missing'), r.err);
  oldFilesStay(s.gold);
});

test('D2b: --write refuses an escapes file with a line that does not parse and counts it; blank lines do not count; the old gold files stay (breaks if the gate skips a damaged line)', async () => {
  const s = writeSetup();
  appendFileSync(escapesOf(s.state), '\n   \n{"fixSha": "broken\n');
  plantOld(s.gold);
  const r = await run(s.argv, s.deps);
  assert.equal(r.code, 1, r.err);
  assert.ok(errLines(r).includes('mine-szz: escapes file has 1 line(s) that do not parse'), r.err);
  oldFilesStay(s.gold);
  const blank = writeSetup();
  appendFileSync(escapesOf(blank.state), '\n   \r\n');
  const ok = await run(blank.argv, blank.deps);
  assert.equal(ok.code, 0, `blank lines are no damage: ${ok.err}`);
});

test('D2c: --write refuses a run whose counted rows are under the done-when bar of 15, with the count in the line, also with --allow-partial; the old gold files stay (breaks if the bar is dropped or moved off 15)', async () => {
  for (const [judge, n, extra] of [[fakeJudge([{ verdict: 'noise', severity: 'minor' }]), 0, []], [fakeJudge([REAL('major')]), 3, ['--allow-partial']]]) {
    // countedMin undefined: main uses the real bar, COUNTED_MIN.
    const s = writeSetup({ judge, countedMin: undefined }, [...writeArgs, ...extra]);
    plantOld(s.gold);
    const r = await run(s.argv, s.deps);
    assert.equal(r.code, 1, r.err);
    assert.equal(JSON.parse(r.out).counted, n);
    assert.ok(errLines(r).includes(`mine-szz: counted rows ${n} is under the bar 15`), r.err);
    oldFilesStay(s.gold);
  }
  assert.equal(szz.COUNTED_MIN, 15);
});

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const smallKey = (b) => szz.labelKey({ fixSha: b.prs[12].shas[0], blamedMergeSha: b.prs[11].mergeSha, file: 'src/f.txt', line: 2 });

test('D3a: a new label cache row carries promptSha, the sha256 of the single-item prompt the judge got; the label key does not change (breaks if promptSha is dropped or hashes another text)', async () => {
  const b = small();
  const judge = fakeJudge([REAL()]);
  const r = await report(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label', '--allow-label-cache-write'], deps: { judge } });
  assert.equal(r.code, 0, r.err);
  assert.equal(judge.prompts.length, 1, 'one item, one call: the batch prompt is the single-item prompt');
  const [row] = cacheRows(r.state);
  assert.equal(row.promptSha, sha256(judge.prompts[0]));
  assert.equal(row.key, `szz-label-v2:${b.prs[12].shas[0]}:${b.prs[11].mergeSha}:src/f.txt:2`, 'promptSha is not part of the key');
});

test('D3a2: promptShaOf (the back-fill helper) hashes the masked single-item prompt that is sent, not the unmasked text (breaks if the helper skips the mask or the item text)', () => {
  const leak = szz.leakTerms([SHA_A], []);
  const item = { kind: 'fix', hunk: `@@ -2 +2 @@\n-log("${SHA_A.slice(0, 10)}")\n+fixed`, blamed: '>    2| fixed' };
  const sent = szz.maskShas(buildPrompt([item]), leak.shas);
  assert.notEqual(sent, buildPrompt([item]), 'the mask changes the text: the check is not vacuous');
  assert.equal(szz.promptShaOf(item, leak), sha256(sent));
});

/** The M10b repo: the lineSlack of the run changes the diff cut, so it changes the prompt of the one item, not its key. */
const slackRepo = () => buildRepo([
  { n: 10, at: '2026-10-09T10:00:00Z', commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7') } }] },
  { n: 11, at: A_DAY, commits: [{ subject: 'feat: bad', files: { 'src/f.txt': lines('l1', 'l2', 'bad', 'l4', 'l5', 'l6', 'l7') } }] },
  { n: 12, at: B_DAY, commits: [{ subject: 'fix: f (#9001)', files: { 'src/f.txt': lines('l1', 'l2', 'good', 'l4', 'l5', 'inserted', 'l6', 'l7') } }] },
]);

test('D3b: a changed prompt with the same key is a miss: the item is asked again and its new row wins; the same prompt again is a hit (breaks if the cache read ignores promptSha)', async () => {
  const b = slackRepo();
  const s = setup(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label', '--allow-label-cache-write'] });
  const go = async (slack) => {
    const judge = fakeJudge([REAL()]);
    const r = await run(s.argv, { ...s.deps, judge, cfg: { ...CFG, lineSlack: slack } });
    assert.equal(r.code, 0, r.err);
    return judge.prompts;
  };
  const first = await go(2);
  assert.equal(first.length, 1);
  const second = await go(1);
  assert.equal(second.length, 1, 'the cut changed the prompt: the old label is not reused');
  assert.notEqual(second[0], first[0]);
  const rows = cacheRows(s.state);
  assert.deepEqual(rows.map((x) => x.key), [rows[0].key, rows[0].key], 'one key, two rows');
  assert.deepEqual(rows.map((x) => x.promptSha), [sha256(first[0]), sha256(second[0])]);
  assert.equal((await go(1)).length, 0, 'the same prompt again is a hit: the last row of the key wins');
});

test('D3c: an old cache row with no promptSha is a hit (no call, its label used); a row whose promptSha differs is a miss (breaks if a missing promptSha is a miss, or a differing one a hit)', async () => {
  const b = small();
  const once = async (row) => {
    const s = setup(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge: fakeJudge([REAL()]) } });
    writeFileSync(path.join(s.state, 'szz-labels.jsonl'), `${JSON.stringify(row)}\n`);
    const r = await run(s.argv, s.deps);
    assert.equal(r.code, 0, r.err);
    return { calls: s.deps.judge.prompts.length, verdicts: JSON.parse(r.out).verdicts };
  };
  const old = { key: smallKey(b), verdict: 'noise', severity: 'minor' };
  assert.deepEqual(await once(old), { calls: 0, verdicts: { real: 0, noise: 1, unclear: 0 } });
  assert.deepEqual(await once({ ...old, promptSha: '0'.repeat(64) }), { calls: 1, verdicts: { real: 1, noise: 0, unclear: 0 } });
});

/** The S07 repo: one fix PR repairs a line of PR 11 and a line of PR 13, so a run has two candidates. */
const twoRepo = () => buildRepo([
  { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'src/f.txt': lines('alpha', 'buggy', 'omega') } }] },
  { n: 13, at: A_DAY, commits: [{ subject: 'feat: g', files: { 'src/g.txt': lines('one', 'bad', 'two') } }] },
  { n: 12, at: B_DAY, commits: [{ subject: 'fix: both (#9001)', files: { 'src/f.txt': lines('alpha', 'fixed', 'omega'), 'src/g.txt': lines('one', 'good', 'two') } }] },
]);
const twoRows = (b) => [escRow(b, { fixPr: 12, blamedPr: 11 }), escRow(b, { fixPr: 12, blamedPr: 13, primary: false })];
/** A label cache row as the miner wrote it before promptSha. */
const oldRow = (b, blamedPr, file, verdict = 'noise') => {
  const c = { fixSha: b.prs[12].shas[0], blamedMergeSha: b.prs[blamedPr].mergeSha, file, line: 2 };
  return { key: szz.labelKey(c), ...c, hunksShown: 1, hunksLeftOut: 0, verdict, severity: 'minor' };
};
const BACKFILL = 'label cache back-filled with promptSha: ';
const backfillLine = (out) => textOf(out).find((l) => l.startsWith(BACKFILL));

test('D4a: two cache hits with no promptSha and the write flag append two rows with this run\'s hash, the same label fields, no judge call and no slot; a second run appends none (breaks if the back-fill is dropped, runs twice or asks the judge)', async () => {
  const b = twoRepo();
  // The hashes a labelled run writes for the same two items: the back-fill must write the same ones.
  const fresh = await report(b, { rows: twoRows(b), extra: ['--label', '--allow-label-cache-write'], deps: { judge: fakeJudge([REAL()]) } });
  assert.equal(fresh.code, 0, fresh.err);
  const want = Object.fromEntries(cacheRows(fresh.state).map((x) => [x.key, x.promptSha]));
  const s = setup(b, { rows: twoRows(b), extra: ['--label', '--allow-label-cache-write'] });
  const olds = [oldRow(b, 11, 'src/f.txt'), oldRow(b, 13, 'src/g.txt')];
  writeFileSync(path.join(s.state, 'szz-labels.jsonl'), olds.map((x) => `${JSON.stringify(x)}\n`).join(''));
  const go = async () => {
    const judge = fakeJudge([REAL()]);
    const text = await run(s.argv.filter((a) => a !== '--json'), { ...s.deps, judge });
    assert.equal(text.code, 0, text.err);
    return { calls: judge.prompts.length, line: backfillLine(text.out) };
  };
  assert.deepEqual(await go(), { calls: 0, line: `${BACKFILL}2` });
  const rows = cacheRows(s.state);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.slice(2), olds.map((x) => ({ ...x, promptSha: want[x.key] })), 'the old fields plus the hash a labelled run writes');
  assert.equal(Object.keys(want).length, 2);
  assert.deepEqual(await go(), { calls: 0, line: `${BACKFILL}0` }, 'the second run finds the hash: nothing to fill');
  assert.equal(cacheRows(s.state).length, 4);
  const json = await run(s.argv, s.deps);
  assert.deepEqual([JSON.parse(json.out).labelCacheBackfilled, JSON.parse(json.out).labelCalls.used], [0, 0]);
});

test('D4b: without --allow-label-cache-write a hit with no promptSha is used and nothing is appended (breaks if the back-fill ignores the flag)', async () => {
  const b = twoRepo();
  const s = setup(b, { rows: twoRows(b), extra: ['--label'], deps: { judge: fakeJudge([REAL()]) } });
  const file = path.join(s.state, 'szz-labels.jsonl');
  writeFileSync(file, [oldRow(b, 11, 'src/f.txt'), oldRow(b, 13, 'src/g.txt')].map((x) => `${JSON.stringify(x)}\n`).join(''));
  const before = readFileSync(file);
  const r = await run(s.argv.filter((a) => a !== '--json'), s.deps);
  assert.equal(r.code, 0, r.err);
  assert.equal(s.deps.judge.prompts.length, 0);
  assert.equal(backfillLine(r.out), `${BACKFILL}0`);
  assert.ok(readFileSync(file).equals(before), 'the cache file is byte-equal');
});

test('D4c: after the back-fill a changed prompt for that key is a miss; without the back-fill the old row would still be a hit (breaks if the back-filled row holds no hash or loses to the old row)', async () => {
  const b = slackRepo();
  const s = setup(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label', '--allow-label-cache-write'] });
  const c = { fixSha: b.prs[12].shas[0], blamedMergeSha: b.prs[11].mergeSha, file: 'src/f.txt', line: 3 };
  writeFileSync(path.join(s.state, 'szz-labels.jsonl'), `${JSON.stringify({ key: szz.labelKey(c), ...c, verdict: 'noise', severity: 'minor' })}\n`);
  const go = async (slack) => {
    const judge = fakeJudge([REAL()]);
    const r = await run(s.argv, { ...s.deps, judge, cfg: { ...CFG, lineSlack: slack } });
    assert.equal(r.code, 0, r.err);
    return [judge.prompts.length, JSON.parse(r.out).labelCacheBackfilled];
  };
  assert.deepEqual(await go(2), [0, 1], 'slack 2: a hit, back-filled with the slack 2 prompt');
  assert.deepEqual(await go(1), [1, 0], 'slack 1: the prompt changed, so the item is asked again');
});

test('D4d: of two rows with one key the last row wins, with or without promptSha (breaks if a row is preferred by promptSha or the first row wins)', async () => {
  const b = small();
  const key = smallKey(b);
  const once = async (rows) => {
    const s = setup(b, { rows: [escRow(b, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge: fakeJudge([REAL()]) } });
    writeFileSync(path.join(s.state, 'szz-labels.jsonl'), rows.map((x) => `${JSON.stringify({ key, ...x })}\n`).join(''));
    const r = await run(s.argv, s.deps);
    assert.equal(r.code, 0, r.err);
    return [s.deps.judge.prompts.length, JSON.parse(r.out).verdicts.noise];
  };
  const noSha = { verdict: 'noise', severity: 'minor' };
  const wrongSha = { verdict: 'unclear', severity: 'minor', promptSha: '0'.repeat(64) };
  assert.deepEqual(await once([wrongSha, noSha]), [0, 1], 'the last row (no promptSha) is a hit');
  assert.deepEqual(await once([noSha, wrongSha]), [1, 0], 'the last row (another prompt) is a miss');
});
