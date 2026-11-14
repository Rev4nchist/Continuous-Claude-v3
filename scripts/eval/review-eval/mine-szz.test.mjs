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
//   S13 controls: blamed, near a failed fix, near an unmapped fix, under 30 -> change buildControls or the bar
//   S13e a failed round read counts as "no round"                          -> merge roundFailed into noRound
//   S14 the baseline copy is not byte-equal, or a risk band is missing      -> change the copy or baselineProblems
//   S15 a dry run writes, or a write is not all-or-nothing                  -> change main
//   S16 a PR number reaches stdout, the report or the judge prompt          -> change scrubPrs or the report text
//   S17 no args or --help touch git, gh or the file system                  -> parse args after the walk
//   S18 gold-a holds a noise or unclear row                                 -> drop the verdict filter
//   S19 round is not the rank of the head in the CodeRabbit rounds          -> change the rank, or keep a head that is not in the list
//   S20 an oversize hunk shares a call, or a batch passes 10 pairs          -> change batchItems
//   S21 the label cache is not reused, or written without the allow flag    -> change the cache read or write guard
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  let main = sh(dir, ['rev-parse', 'HEAD']);
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
  return { dir, git: makeGit(dir), prs };
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
const NOW = Date.parse('2026-11-13T18:00:00Z');
const CFG = { holdoutExclude: [21, 11], reserve: [], lineSlack: 3 };
const NO_DATA = { prs: [], findings: [] };

async function run(argv, deps = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, { stdout: (s) => out.push(String(s)), stderr: (s) => err.push(String(s)), cfg: CFG, readRecords: () => [], now: () => NOW, env: {}, dataset: NO_DATA, ledgerPath: path.join(tmp('ledger'), 'ledger.jsonl'), ...deps });
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
  assert.equal(SZZ_DAILY_CALLS, 6);
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
  const cand = (pr) => ({ blamedPr: pr, round: 2, head: 'd'.repeat(40), file: 'a.txt', line: 3, fixSha: 'f'.repeat(40), fixMergeSha: 'e'.repeat(40), blamedMergeSha: 'c'.repeat(40), cause: 'unclassified', primary: true });
  const label = { verdict: 'real', severity: 'major' };
  assert.deepEqual([5, 7, 9].map((pr) => goldRowOf({ cand: cand(pr), label, n: 1, suite: 'capability', cfg }).split), ['dev', 'reserve', 'holdout']);
  const row = goldRowOf({ cand: cand(5), label, n: 3, suite: 'regression', cfg });
  assert.deepEqual(validateRow(row), []);
  assert.deepEqual(row.target, { pr: 5, round: 2, sha40: 'd'.repeat(40) });
  assert.deepEqual(row.labels, [{ by: 'claude-opus-5-5', verdict: 'real', judgeVersion: 'szz-label-v1' }]);
  assert.deepEqual(row.provenance, { miner: 'mine-szz-v1', fixSha: 'f'.repeat(40), fixMergeSha: 'e'.repeat(40), blamedMergeSha: 'c'.repeat(40), cause: 'unclassified', primary: true, crBefore: false });
  assert.equal(row.linkType, 'within-hunk');
  assert.match(row.id, /^A:[0-9a-f]{12}$/);
  const twin = goldRowOf({ cand: { ...cand(5), blamedPr: 9 }, label, n: 7, suite: 'regression', cfg });
  assert.equal(twin.id, row.id, 'the id comes from the shas, the file and the line: the PR number is not in it');
});

test('S10-unit: validateOutputs returns the problem lines of a bad row and of a bad control, never a value (breaks if validateRow or loadCleanControls is skipped, or a value is printed)', () => {
  const good = goldRowOf({ cand: { blamedPr: 5, round: 1, head: 'd'.repeat(40), file: 'a.txt', line: 3, fixSha: 'f'.repeat(40), fixMergeSha: 'e'.repeat(40), blamedMergeSha: 'c'.repeat(40), cause: 'unclassified', primary: true }, label: { verdict: 'real', severity: 'major' }, n: 1, suite: 'capability', cfg: CFG });
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
const ctl = (over = {}) => buildControls({
  datasetPrs: [], merges: merges40(), escapeRows: [], failedFixShas: new Set(), noTargetFixShas: new Set(), filesOf: () => [], roundOf: async () => ({ round: 1, sha40: 'a'.repeat(40) }), cfg: CFG, ...over,
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

test('S13e: a failed round read is counted as roundFailed, apart from no round (breaks if a gh failure reads as "no round")', async () => {
  const r = await ctl({ merges: merges40().slice(0, 3), roundOf: async (pr) => { if (pr === 101) throw new Error('gh down'); return pr === 102 ? null : { round: 1, sha40: 'a'.repeat(40) }; } });
  assert.deepEqual(r.controls.map((c) => c.target.pr), [100]);
  assert.equal(r.counts.roundFailed, 1);
  assert.equal(r.counts.noRound, 1);
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

test('S13c: a control with no round is dropped and counted (breaks if a missing round is kept with a guess)', async () => {
  const r = await ctl({ merges: merges40().slice(0, 3), roundOf: async (pr) => (pr === 101 ? null : { round: 2, sha40: 'b'.repeat(40) }) });
  assert.deepEqual(r.controls.map((c) => c.target.pr), [100, 102]);
  assert.equal(r.counts.noRound, 1);
  assert.equal(r.controls[0].target.round, 2);
  assert.equal(CONTROLS_MIN, 30);
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
  for (const reviews of [{ 21: [c1] }, { 21: [] }]) {
    const j = await report(b, { rows: bigRows(b), extra: ['--label'], deps: { judge: fakeJudge([REAL()]), gh: fakeGh(b, { reviews }) } });
    assert.equal(j.json.unmapped['head-not-reviewed'], 1, JSON.stringify(reviews));
    assert.equal(j.json.labelled, 0);
  }
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
    assert.equal(r.deps.judge.prompts[0].includes('the wait never ends'), true, 'the card text is in the prompt');
  }
});

test('S09: with the six lane calls of today used, no call starts; rows of another lane or day do not count; a run cannot pass the slot (breaks if the ledger or the in-run counter is ignored)', async () => {
  const ledger = path.join(tmp('led'), 'ledger.jsonl');
  const row = (over) => `${JSON.stringify({ phase: 'start', purpose: 'eval-judge', sessionId: `${LEDGER_TAG}:s`, ts: '2026-11-13T15:00:00Z', id: `i${Math.random()}`, ...over })}\n`;
  const b = small();
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11 })];
  writeFileSync(ledger, Array.from({ length: 6 }, () => row({})).join(''));
  const full = await report(b, { rows, extra: ['--label'], deps: { judge: fakeJudge([REAL()]), ledgerPath: ledger } });
  assert.equal(full.deps.judge.prompts.length, 0);
  assert.equal(full.json.labelCalls.used, 6);
  assert.equal(full.json.labelled, 0);
  writeFileSync(ledger, [...Array.from({ length: 5 }, () => row({})), ...Array.from({ length: 4 }, () => row({ sessionId: 'other' })), row({ ts: '2026-11-12T05:00:00Z' })].join(''));
  const some = await report(b, { rows, extra: ['--label'], deps: { judge: fakeJudge([REAL()]), ledgerPath: ledger } });
  assert.equal(some.deps.judge.prompts.length, 1);
  // Two oversize hunks need two calls; five are used, so only one call may run, though the fake judge writes no ledger row.
  const huge = 'q'.repeat(HUNK_LIMIT + 500);
  const b2 = buildRepo([
    { n: 11, at: A_DAY, commits: [{ subject: 'feat: f', files: { 'a.txt': lines('keep', `bad ${huge}`), 'b.txt': lines('keep', `bad ${huge}`) } }] },
    { n: 12, at: B_DAY, commits: [{ subject: 'fix: both (#9001)', files: { 'a.txt': lines('keep', 'good'), 'b.txt': lines('keep', 'good') } }] },
  ]);
  writeFileSync(ledger, Array.from({ length: 5 }, () => row({})).join(''));
  const j2 = fakeJudge([REAL()]);
  const two = await report(b2, { rows: [escRow(b2, { fixPr: 12, blamedPr: 11 })], extra: ['--label'], deps: { judge: j2, ledgerPath: ledger } });
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
  assert.deepEqual(Object.keys(cached[0]).sort(), ['blamedMergeSha', 'file', 'fixSha', 'key', 'line', 'severity', 'verdict']);
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
/** The fix-chains --json shape: perPr results. PR 171 is a partial-failure fix, PR 170 a fix with no target. */
const FIXES = (b) => ({ perPr: [
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
  for (const x of rows) assert.deepEqual(validateRow(x), []);
  assert.equal(loadCleanControls(r.gold).length, 40);
  assert.deepEqual(r.json.controls, { group1: 2, group2: 38, removedBlamed: 3, removedFailedFix: 24, removedUnmappedFix: 1, noRound: 0, roundFailed: 0, notOnMain: 1, total: 40 });
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
  assert.notEqual(r.code, 0, 'the failed write is reported');
  for (const n of GOLD_FILES) assert.equal(readFileSync(path.join(s.gold, n), 'utf8'), `OLD ${n}\n`, `${n} is the old file`);
  assert.deepEqual(readdirSync(s.gold).sort(), GOLD_FILES, 'no .bak and no .tmp');
  const fresh = writeSetup({ rename: failRenameInto('clean-controls.json') });
  const r2 = await run(fresh.argv, fresh.deps);
  assert.notEqual(r2.code, 0);
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
  const r1 = await report(b, { rows, extra: ['--label'], deps: { judge: j1, ledgerPath: ledger, now: () => t } });
  assert.equal(r1.code, 0, r1.err);
  assert.equal(j1.prompts.length, 1, 'the second call does not start');
  assert.equal(r1.json.labelCalls.used, 6, 'the own call is counted once: its ledger row and the in-run count share an id');
  assert.equal(r1.json.labelCalls.stopped, true);
  // A run that passes midnight (Chicago): the new day already holds six lane calls.
  const ledger2 = path.join(tmp('led'), 'ledger.jsonl');
  writeFileSync(ledger2, Array.from({ length: 6 }, () => laneRow({ ts: '2026-11-14T07:00:00Z' })).join(''));
  t = Date.parse('2026-11-14T05:50:00Z'); // 23:50 on Nov 13 in Chicago
  const j2 = ledgerJudge(ledger2, () => t, (k) => { if (k === 1) t = Date.parse('2026-11-14T06:30:00Z'); });
  const r2 = await report(b, { rows, extra: ['--label'], deps: { judge: j2, ledgerPath: ledger2, now: () => t } });
  assert.equal(r2.code, 0, r2.err);
  assert.equal(j2.prompts.length, 1, 'after midnight the new day is full');
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

test('R19: a written file that is not byte-equal to its staged content rolls back all three files (breaks if the byte check runs after the old files are gone)', async () => {
  const corrupt = (from, to) => { renameSync(from, to); if (from.endsWith('.tmp') && path.basename(to) === 'escape-baseline.json') writeFileSync(to, 'corrupt'); };
  const s = writeSetup({ rename: corrupt });
  plantOld(s.gold);
  const r = await run(s.argv, s.deps);
  assert.notEqual(r.code, 0);
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

test('R20: an escape row with an unreadable fix time is counted as failed, not dropped silently (breaks if the row is filtered out uncounted)', async () => {
  const b = small();
  const rows = [escRow(b, { fixPr: 12, blamedPr: 11 }), escRow(b, { fixPr: 12, blamedPr: 11, fixMergedAt: 'garbage' })];
  const r = await report(b, { rows });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.failed['fix-time'], 1, JSON.stringify(r.json.failed));
  assert.equal(r.json.pairs, 2);
});
