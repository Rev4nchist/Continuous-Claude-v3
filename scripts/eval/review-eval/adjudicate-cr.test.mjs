// Tests for adjudicate-cr.mjs. Every call goes through setup() and exec(): temp paths, a fake judge, a fake git, a fake gh and a fake resolver.
// Nothing here reads config.json, the dataset, gold/, linktype-labels.json or the headless ledger, and nothing calls claude, gh or the network.
// Each test names the source change that would break it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { answerKeyHitsOf } from '../../github/lib/answer-key.mjs';
import * as adj from './adjudicate-cr.mjs';
import { JUDGE_VERSION, buildPrompt, defaultJudge, idOf, main, parseAnswer } from './adjudicate-cr.mjs';
import { loadGold, validateRow } from './gold.mjs';
import { writeLinkTypeLabels } from './linktype.mjs';
import { leakTerms, promptGuard } from './mine-szz.mjs';

const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const CFG = { holdoutExclude: [9002], reserve: [{ pr: 9003, answerKeySource: 'fx' }], lineSlack: 3 };
const SHA_A = 'a'.repeat(40);
const CLAUDE = { family: 'anthropic', model: 'opus', effort: 'high' };
const cid = (n) => 700000000 + n;
const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const finding = (n, over = {}) => ({ key: `9001:${cid(n)}`, pr: 9001, round: 1, severity: 'Major', verdict: 'real', source: 'coderabbit', path: `src/f${n}.js`, startLine: 10 * n, endLine: 10 * n + 2, sha40: SHA_A, resolvedBy: 'comment', roundRank: 1, ...over });
const DIFF = (extra = '') => ['diff --git a/src/x.js b/src/x.js', 'index 1234567..89abcde 100644', '--- a/src/x.js', '+++ b/src/x.js', '@@ -1,100 +1,100 @@', ' const a = 1;', '+const b = 2;', extra].join('\n');
const BODY = 'Possible null dereference before use.';

const yes = (extra = {}) => ({ ok: true, result: JSON.stringify({ verdict: 'yes', severity: 'major', why: 'Null is dereferenced.', ...extra }) });
const verdictOnly = (verdict) => ({ ok: true, result: JSON.stringify({ verdict, severity: 'minor', why: 'Handled above.' }) });
const failed = (reason) => ({ ok: false, reason });

/** A judge that returns script[i] for call i (the last entry repeats). An entry may be a function of the prompt. */
function fakeJudge(script) {
  const calls = [];
  const judge = async (prompt) => {
    calls.push(prompt);
    const a = script[calls.length - 1] ?? script.at(-1);
    return typeof a === 'function' ? a(prompt) : a;
  };
  judge.calls = calls;
  return judge;
}

/** linkTypes: { key: class } written by writeLinkTypeLabels; the default labels every finding within-hunk. */
function setup(findings, { linkTypes, records = [], body = () => BODY, script = [yes()] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adj-'));
  made.push(dir);
  const out = path.join(dir, 'gold', 'adjudicated-cr.json');
  const files = { dataset: path.join(dir, 'ds.json'), out, state: path.join(dir, 'gold', 'adjudicated-cr.state'), linktype: path.join(dir, 'lt.json') };
  writeFileSync(files.dataset, JSON.stringify({ prs: [], findings: [] }));
  writeLinkTypeLabels(files.linktype, linkTypes ?? Object.fromEntries(findings.map((f) => [f.key, 'within-hunk'])), { 'agent-claude': CLAUDE });
  const gh = async (args) => ({ body: body(String(args.at(-1)).split('/').at(-1)) });
  return { dir, files, findings, records, judge: fakeJudge(script), gitCalls: [], diffOf: () => DIFF(), gh };
}

const okDiff = (text) => ({ status: 0, stdout: text, stderr: '' });

async function exec(h, sub, flags = [], over = {}) {
  const out = [];
  const err = [];
  const argv = [sub, '--dataset', h.files.dataset, '--out', h.files.out, '--linktype', h.files.linktype, '--records-dir', h.dir, ...flags];
  const deps = { stdout: (s) => out.push(s), stderr: (s) => err.push(s), cfg: CFG, judge: h.judge, git: (a) => okDiff(DIFF()), gh: h.gh, resolveFindings: async () => h.findings, readRecords: async () => h.records, ...over };
  const code = await main(argv, deps);
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const gitOf = (h) => (args) => { h.gitCalls.push(args); return okDiff(h.diffOf(args)); };
const runWith = (h, flags = ['--limit', '10', '--confirm-headless'], over = {}) => exec(h, 'run', flags, { git: gitOf(h), ...over });
const rowsOf = (h) => (existsSync(h.files.out) ? JSON.parse(readFileSync(h.files.out, 'utf8')) : null);
const stateOf = (h) => (existsSync(h.files.state) ? JSON.parse(readFileSync(h.files.state, 'utf8')) : null);
const diffPer = (h, perPath = {}) => { h.diffOf = (args) => (perPath[args.at(-1)] ?? DIFF()); return h; };

// ---------- 1 and 2: the prompt and the guard ----------

const PLANTS = {
  'a PR number in the hunk': { diff: () => DIFF('+// fixes PR #9001') },
  'a 40-hex sha that is not the finding sha in the hunk': { diff: () => DIFF(`+// ${'b'.repeat(40)}`) },
  'a repo url in the hunk': { diff: () => DIFF('+// https://github.com/someone/somerepo') },
  'the comment id in the comment text': { body: () => `Same as ${cid(1)} above.` },
  'the finding key in the comment text': { body: () => `Key 9001:${cid(1)} here.` },
  'the finding PR in a code comment (see #N)': { diff: () => DIFF('+// see #9001') },
  'the finding PR as pr_N': { diff: () => DIFF('+const x = pr_9001;') },
  'the finding PR as PR(N)': { diff: () => DIFF('+// PR(9001) fixed it') },
  'the finding PR as pull-N': { diff: () => DIFF('+// from pull-9001') },
  'the finding PR as issue N': { diff: () => DIFF('+// issue 9001 again') },
};
for (const [name, plant] of Object.entries(PLANTS)) {
  test(`the guard refuses a prompt with ${name}, and the judge is never called (breaks if that check is removed from the send path)`, async () => {
    const h = diffPer(setup([finding(1)], { body: plant.body }), { 'src/f1.js': (plant.diff ?? (() => DIFF()))() });
    const res = await runWith(h);
    assert.equal(res.code, 1);
    assert.equal(h.judge.calls.length, 0);
    assert.match(res.err + res.out, /refused/);
    assert.equal(rowsOf(h), null);
    assert.equal((res.out + res.err + JSON.stringify(stateOf(h))).includes('9001'), false, 'the refusal kind and the marker hold no PR number');
    const marker = stateOf(h)[idOf(finding(1).key)];
    assert.deepEqual(Object.keys(marker).sort(), ['kind', 'verdict']);
    assert.ok(adj.REFUSAL_KINDS.includes(marker.kind), `kind ${marker.kind} is on the list`);
  });
}

test('the prompt holds no disposition word: a finding with disposition fixed gets a prompt without fixed, wrong, wont_fix, disposition or outcome (breaks if the outcome line or a template word is back)', async () => {
  const h = diffPer(setup([finding(1)]));
  assert.equal((await runWith(h, ['--limit', '1', '--confirm-headless'], { dispositionOf: () => 'fixed' })).code, 0);
  assert.doesNotMatch(h.judge.calls[0], /fixed|wrong|wont_fix|disposition|outcome/i);
  assert.equal(stateOf(h)[idOf(finding(1).key)].disposition, 'fixed', 'the sidecar keeps the disposition');
});

test('the summary and --json count agreement between the judge verdict and the disposition, counts only (breaks if a pair is counted in the wrong bucket or the disposition is not kept for no and unclear)', async () => {
  const dispo = { 'src/f1.js': 'fixed', 'src/f2.js': 'wrong', 'src/f3.js': 'wrong', 'src/f4.js': 'fixed', 'src/f5.js': 'fixed' };
  const script = [yes(), verdictOnly('no'), yes(), verdictOnly('no'), verdictOnly('unclear'), yes()];
  const h = diffPer(setup([1, 2, 3, 4, 5, 6].map((n) => finding(n)), { script }));
  const res = await runWith(h, ['--limit', '10', '--confirm-headless', '--json'], { dispositionOf: (f) => dispo[f.path] });
  assert.equal(res.code, 0);
  assert.deepEqual(JSON.parse(res.out).agreement, { yesFixed: 1, noWrong: 1, yesWrong: 1, noFixed: 1, unclear: 1, none: 1, other: 0 });
  const text = (await runWith(setup2(), ['--limit', '10', '--confirm-headless'])).out;
  assert.match(text, /agreement[^\n]*yes&fixed 0, no&wrong 0, yes&wrong 0, no&fixed 0, unclear 0, none 1/);
  assert.equal(stateOf(h)[idOf(finding(2).key)].disposition, 'wrong');
  assert.equal(rowsOf(h)[0].provenance.disposition, 'fixed');
});

function setup2() {
  return diffPer(setup([finding(1)]));
}

test('buildPrompt holds path, hunk, comment text, severity, the neutral index and the outcome word, and none of the ids (breaks if a field is dropped or an id or the github url is left in)', () => {
  const body = 'Fix the null check. See PR #9001 and https://github.com/someone/somerepo/pull/9001 for more.';
  const p = buildPrompt({ label: 'abcd1234', file: 'src/f1.js', hunk: '@@ -1 +1 @@\n+const b = 2;', body, severity: 'major', disposition: 'fixed', sha: SHA_A });
  for (const want of ['src/f1.js', '+const b = 2;', 'Fix the null check', 'major']) assert.ok(p.includes(want), `missing ${want}`);
  assert.match(p, /### Finding abcd1234\n/);
  for (const nope of ['9001', 'github.com', SHA_A]) assert.equal(p.includes(nope), false, `leaked ${nope}`);
  assert.equal(promptGuard(p, leakTerms([SHA_A], [])), null);
  assert.doesNotMatch(buildPrompt({ label: 'abcd1234', file: 'a.js', hunk: '@@', body: 'x', severity: 'minor', sha: SHA_A }), /outcome/i);
});

test('the prompt sent to the judge is the diff from the first @@ line, with a scrubbed comment, labelled by the id hash and with no count (breaks if the diff header is kept, the body is not scrubbed, or a run number or total is back)', async () => {
  const h = diffPer(setup([finding(1), finding(2), finding(3)], { body: () => `${BODY} Related to PR #9001.`, script: [verdictOnly('no')] }));
  const res = await runWith(h, ['--limit', '2', '--confirm-headless']);
  assert.equal(res.code, 0);
  assert.equal(h.judge.calls.length, 2);
  const [first, second] = h.judge.calls;
  assert.ok(first.includes(`### Finding ${idOf(finding(1).key).slice(3, 11)}\n`));
  assert.ok(second.includes(`### Finding ${idOf(finding(2).key).slice(3, 11)}\n`));
  assert.doesNotMatch(first, /Finding [^\n]* of \d/);
  assert.ok(first.includes('+const b = 2;') && first.includes('src/f1.js') && first.includes('Possible null dereference'));
  for (const nope of ['1234567', 'diff --git', '9001', String(cid(1)), SHA_A]) assert.equal(first.includes(nope), false, `leaked ${nope}`);
});

// ---------- 3: the confirm flag ----------

test('run without --confirm-headless exits 2 and never calls the judge, git or gh (breaks if the confirm check moves after the loop or is dropped)', async () => {
  const h = diffPer(setup([finding(1)]));
  const res = await runWith(h, ['--limit', '1']);
  assert.equal(res.code, 2);
  assert.equal(h.judge.calls.length, 0);
  assert.equal(rowsOf(h), null);
  assert.equal((await runWith(h, ['--confirm-headless'])).code, 2, 'run also needs --limit');
});

// ---------- 4 and 5: stops ----------

test('a refused prompt stops the run with exit 1, is not retried, and the rows done before it are written (breaks if the loop goes on after a refusal or drops the earlier rows)', async () => {
  const h = diffPer(setup([finding(1), finding(2), finding(3)]), { 'src/f2.js': DIFF('+// fixes PR #9001') });
  const res = await runWith(h);
  assert.equal(res.code, 1);
  assert.equal(h.judge.calls.length, 1);
  assert.equal(h.gitCalls.length, 2, 'git read the hunk of finding 1 and of finding 2 only');
  const rows = rowsOf(h);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, 'src/f1.js');
  assert.match(res.err + res.out, /stop[^\n]*refused/i);
});

test('a refused finding is marked in the state (kind only), a re-run skips it with no judge call and goes on to the next finding (breaks if a refusal blocks the queue or the marker keeps text)', async () => {
  const h = diffPer(setup([finding(1), finding(2), finding(3)]), { 'src/f2.js': DIFF('+// fixes PR #9001') });
  assert.equal((await runWith(h)).code, 1);
  assert.deepEqual(stateOf(h)[idOf(finding(2).key)], { verdict: 'refused', kind: 'pr-number' });
  const again = await runWith(h);
  assert.equal(again.code, 0);
  assert.equal(h.judge.calls.length, 2, 'finding 3 was judged, finding 2 was not asked again');
  assert.deepEqual(rowsOf(h).map((r) => r.file), ['src/f1.js', 'src/f3.js']);
  assert.match(again.out, /skipped refusals: 1/);
  const asJson = JSON.parse((await runWith(h, ['--limit', '10', '--confirm-headless', '--json'])).out);
  assert.equal(asJson.skippedRefusals, 1);
  const plan = JSON.parse((await exec(h, 'plan', ['--json'])).out);
  assert.deepEqual({ adjudicated: plan.adjudicated, refused: plan.refused, pending: plan.pending }, { adjudicated: 2, refused: 1, pending: 0 });
});

test('--limit counts judge calls, not findings: findings with no hunk do not use it up (breaks if the list is cut to N before the evidence is read)', async () => {
  const h = diffPer(setup([finding(1), finding(2), finding(3)]), { 'src/f1.js': '' });
  const res = await runWith(h, ['--limit', '1', '--confirm-headless']);
  assert.equal(res.code, 0);
  assert.equal(h.judge.calls.length, 1);
  assert.ok(h.judge.calls[0].includes(`### Finding ${idOf(finding(2).key).slice(3, 11)}\n`));
  assert.deepEqual(rowsOf(h).map((r) => r.file), ['src/f2.js']);
  assert.match(res.out, /evidence-failed 1/);
});

test('the hunk of the prompt is the one near the finding lines, not the first hunk of the diff (breaks if the diff is only cut to a length)', async () => {
  const two = ['diff --git a/x b/x', '@@ -1,2 +1,3 @@', ' a', '+FIRSTHUNKMARK', '@@ -40,2 +41,3 @@', ' b', '+SECONDHUNKMARK'].join('\n');
  const h = diffPer(setup([finding(4, { startLine: 42, endLine: 43 })]), { 'src/f4.js': two });
  assert.equal((await runWith(h)).code, 0);
  assert.ok(h.judge.calls[0].includes('SECONDHUNKMARK') && !h.judge.calls[0].includes('FIRSTHUNKMARK'));
  const whole = adj.hunksNear(two.slice(two.indexOf('@@')), { startLine: null, endLine: null }, 3);
  assert.ok(whole.includes('FIRSTHUNKMARK') && whole.includes('SECONDHUNKMARK'), 'a finding with no line gets the whole diff (a run no longer sends such a finding)');
});

test('run and plan without --dataset read the default dataset path under the home folder (breaks if --dataset is required again)', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'adj-home-'));
  made.push(home);
  const file = path.join(home, 'continuous-claude', '.claudedocs', '2026-11-01-pr-review-dataset.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ prs: [], findings: [] }));
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    assert.equal(os.homedir(), home, 'the home override works, so the real dataset cannot be read');
    const h = diffPer(setup([finding(1)]));
    const argv = ['plan', '--out', h.files.out, '--json'];
    const out = [];
    const code = await main(argv, { stdout: (s) => out.push(s), stderr: (s) => out.push(s), cfg: CFG, resolveFindings: async () => h.findings });
    assert.equal(code, 0);
    assert.equal(JSON.parse(out.join('\n')).candidates, 1);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

for (const reason of ['cap', 'served-model', 'no-claude', 'lock']) {
  test(`a judge error ${reason} stops the run at the first one; that finding gets no row and no state entry (breaks if the error is skipped, retried or recorded as an answer)`, async () => {
    const h = diffPer(setup([finding(1), finding(2), finding(3)], { script: [yes(), failed(reason), yes()] }));
    const res = await runWith(h);
    assert.equal(res.code, 1);
    assert.equal(h.judge.calls.length, 2);
    assert.deepEqual(rowsOf(h).map((r) => r.file), ['src/f1.js']);
    assert.deepEqual(Object.keys(stateOf(h)), [idOf(finding(1).key)]);
    assert.ok(res.out.includes(reason));
  });
}

test('a judge timeout does not stop the run: the finding stays unjudged for a later run (breaks if every failure stops the run)', async () => {
  const h = diffPer(setup([finding(1), finding(2), finding(3)], { script: [yes(), failed('timeout'), yes()] }));
  const res = await runWith(h);
  assert.equal(res.code, 0);
  assert.equal(h.judge.calls.length, 3);
  assert.deepEqual(rowsOf(h).map((r) => r.file), ['src/f1.js', 'src/f3.js']);
  assert.match(res.out, /judge-failed 1/);
});

// ---------- 6: the rows ----------

test('verdict yes gives one valid CR row; no and unclear give no row, a state entry, and a re-run skips them (breaks if a no becomes a row, the row shape drifts, or a re-run asks again)', async () => {
  const h = diffPer(setup([finding(1), finding(2), finding(3)], { script: [yes({ severity: 'critical' }), verdictOnly('no'), verdictOnly('unclear')] }));
  const res = await runWith(h);
  assert.equal(res.code, 0);
  const rows = rowsOf(h);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.deepEqual(validateRow(row), []);
  assert.equal(row.id, idOf(finding(1).key));
  assert.match(row.id, /^cr-[0-9a-f]{12}$/);
  assert.deepEqual({ source: row.source, split: row.split, severity: row.severity, linkType: row.linkType, file: row.file, line: row.line, target: row.target }, { source: 'CR', split: 'holdout', severity: 'critical', linkType: 'within-hunk', file: 'src/f1.js', line: 10, target: { pr: 9001, round: 1, sha40: SHA_A } });
  assert.deepEqual(row.labels, [{ by: 'claude', verdict: 'real', judgeVersion: JUDGE_VERSION }]);
  assert.deepEqual({ adjudicator: row.provenance.adjudicator, model: row.provenance.model, effort: row.provenance.effort }, { adjudicator: 'adjudicate-cr', model: 'opus', effort: 'high' });
  assert.ok(row.provenance.promptVersion);
  const state = stateOf(h);
  assert.equal(state[idOf(finding(2).key)].verdict, 'no');
  assert.equal(state[idOf(finding(3).key)].verdict, 'unclear');
  assert.equal(loadGold(path.dirname(h.files.out)).rows.length, 1, 'the sidecar must not break loadGold of the folder');
  const again = await runWith(h);
  assert.equal(again.code, 0);
  assert.equal(h.judge.calls.length, 3, 'the second run made no judge call');
  assert.equal(rowsOf(h).length, 1);
});

test('the split comes from config.json holdoutExclude and reserve through setOf (breaks if the row split is copied from the dataset or defaulted)', async () => {
  const fs = [finding(1), finding(2, { pr: 9002, key: `9002:${cid(2)}` }), finding(3, { pr: 9003, key: `9003:${cid(3)}` })];
  const h = diffPer(setup(fs));
  assert.equal((await runWith(h)).code, 0);
  assert.deepEqual(rowsOf(h).map((r) => r.split), ['holdout', 'dev', 'reserve']);
});

// ---------- 7: the suite ----------

test('suite is regression only when an engine record of the PR has a finding near the lines, else capability (breaks if every row is regression or capability, or the PR, file or slack is ignored)', async () => {
  const records = [
    { pr: 9001, findings: [{ file: 'src/f1.js', startLine: 11, endLine: 12 }, { file: 'src/f3.js', startLine: 500, endLine: 501 }] },
    { pr: 9999, findings: [{ file: 'src/f4.js', startLine: 40, endLine: 42 }] },
  ];
  const h = diffPer(setup([finding(1), finding(2), finding(3), finding(4)], { records }));
  assert.equal((await runWith(h)).code, 0);
  assert.deepEqual(rowsOf(h).map((r) => [r.file, r.suite]), [['src/f1.js', 'regression'], ['src/f2.js', 'capability'], ['src/f3.js', 'capability'], ['src/f4.js', 'capability']]);
});

test('a yes already in the sidecar for a finding with no line becomes a capability row with no line field (breaks if a null line is written or a file-only finding counts as regression)', async () => {
  const records = [{ pr: 9001, findings: [{ file: 'src/f1.js', startLine: 1, endLine: 99 }] }];
  const h = diffPer(setup([finding(1, { startLine: null, endLine: null })], { records }));
  mkdirSync(path.dirname(h.files.state), { recursive: true });
  writeFileSync(h.files.state, JSON.stringify({ [idOf(finding(1).key)]: { verdict: 'yes', severity: 'major', answerSha256: sha256('fx') } }));
  assert.equal((await runWith(h)).code, 0);
  assert.equal(h.judge.calls.length, 0);
  const [row] = rowsOf(h);
  assert.equal(row.suite, 'capability');
  assert.equal(Object.hasOwn(row, 'line'), false);
  assert.deepEqual(validateRow(row), []);
});

// ---------- 8: linkType ----------

test('a yes with no linkType final waits: no row, counted waiting-linktype, and once the label exists the next run writes the row with no new judge call (breaks if a row is written without a class or the yes is judged again)', async () => {
  const h = diffPer(setup([finding(1), finding(2)], { linkTypes: { [finding(1).key]: 'within-hunk' } }));
  const first = await runWith(h);
  assert.equal(first.code, 0);
  assert.match(first.out, /waiting-linktype 1/);
  assert.deepEqual(rowsOf(h).map((r) => r.file), ['src/f1.js']);
  assert.equal(stateOf(h)[idOf(finding(2).key)].verdict, 'yes');
  writeLinkTypeLabels(h.files.linktype, { [finding(2).key]: 'same-file' }, { 'agent-claude': CLAUDE });
  const second = await runWith(h);
  assert.equal(second.code, 0);
  assert.equal(h.judge.calls.length, 2);
  assert.deepEqual(rowsOf(h).map((r) => [r.file, r.linkType]), [['src/f1.js', 'within-hunk'], ['src/f2.js', 'same-file']]);
  assert.match(second.out, /waiting-linktype 0/);
});

// ---------- 9: validation ----------

test('a row that fails validateRow is skipped and counted (rows invalid N); the valid rows and the whole state, refusal markers included, are still written; exit 1 (breaks if one bad row drops the verdicts or the markers)', async () => {
  const h = diffPer(setup([finding(1), finding(2, { path: 'C:\\bad\\x.js' }), finding(3)], { script: [yes(), yes(), yes()] }), { 'src/f3.js': DIFF('+// fixes PR #9001') });
  const res = await runWith(h);
  assert.equal(res.code, 1);
  assert.deepEqual(rowsOf(h).map((r) => r.file), ['src/f1.js']);
  const state = stateOf(h);
  assert.deepEqual([state[idOf(finding(1).key)].verdict, state[idOf(finding(2).key)].verdict, state[idOf(finding(3).key)].verdict], ['yes', 'yes', 'refused']);
  assert.match(res.out, /rows invalid 1/);
  assert.match(res.err, /validat/i);
  assert.equal((res.out + res.err).includes('bad'), false);
  const alone = diffPer(setup([finding(1), finding(2, { path: 'C:\\bad\\x.js' })]));
  const second = await runWith(alone);
  assert.equal(second.code, 1);
  assert.equal(Object.keys(stateOf(alone)).length, 2);
});

// ---------- the state is saved after each call ----------

test('the state is saved after each judge call: a crash before call 3 keeps verdicts 1 and 2, and the resumed run asks only for the rest (breaks if the state is written once at the end)', async () => {
  const fs = [1, 2, 3, 4].map((n) => finding(n));
  const h = diffPer(setup(fs, { script: [yes(), verdictOnly('no'), yes(), yes()] }));
  const crash = await runWith(h, undefined, { dispositionOf: (f) => { if (f.path === 'src/f3.js') throw new Error('crash'); return undefined; } });
  assert.equal(crash.code, 2);
  assert.equal(h.judge.calls.length, 2);
  assert.deepEqual(Object.keys(stateOf(h)).sort(), [idOf(fs[0].key), idOf(fs[1].key)].sort());
  assert.equal((await runWith(h)).code, 0);
  assert.equal(h.judge.calls.length, 4, 'only findings 3 and 4 were asked on the resumed run');
  assert.deepEqual(rowsOf(h).map((r) => r.file), ['src/f1.js', 'src/f3.js', 'src/f4.js']);
});

test('a judge that throws is counted as a failed call, the state of the earlier calls stays, and the run goes on (breaks if a throw ends the run or drops the verdicts)', async () => {
  const h = diffPer(setup([1, 2, 3].map((n) => finding(n)), { script: [yes(), () => { throw new Error('boom'); }, yes()] }));
  const res = await runWith(h);
  assert.equal(res.code, 0);
  assert.match(res.out, /judge-failed 1/);
  assert.deepEqual(rowsOf(h).map((r) => r.file), ['src/f1.js', 'src/f3.js']);
});

test('the engine records are loaded before the first judge call, so a failed read loses no paid call (breaks if the records are read after the loop)', async () => {
  const h = diffPer(setup([finding(1), finding(2)]));
  const res = await runWith(h, undefined, { readRecords: async () => { throw new Error('records'); } });
  assert.equal(res.code, 2);
  assert.equal(h.judge.calls.length, 0);
});

test('the prompt of one finding is the same text in every run, whatever the other candidates are (breaks if a run number or a total is in the prompt)', async () => {
  const alone = diffPer(setup([finding(1)]));
  await runWith(alone);
  const crowd = diffPer(setup([finding(2), finding(3), finding(1)]));
  await runWith(crowd);
  assert.equal(crowd.judge.calls.find((p) => p.includes('src/f1.js')), alone.judge.calls[0]);
});

test('a finding with a line and no hunk near it is not sent and not given the whole diff: no judge call, counted as skipped: no hunk near the line (breaks if the whole commit is sent)', async () => {
  const h = diffPer(setup([finding(1, { startLine: 500, endLine: 502 }), finding(2)]));
  const res = await runWith(h);
  assert.equal(res.code, 0);
  assert.equal(h.judge.calls.length, 1);
  assert.match(res.out, /skipped: no hunk near the line 1/);
  assert.match(res.out, /evidence-failed 0/);
  assert.deepEqual(rowsOf(h).map((r) => r.file), ['src/f2.js']);
});

test('the refusal kind of the sidecar is from a frozen list and is never free text (breaks if a kind outside the list can be written, or the marker holds another field)', () => {
  assert.ok(Object.isFrozen(adj.REFUSAL_KINDS));
  assert.deepEqual([...adj.REFUSAL_KINDS].sort(), ['comment-id', 'finding-key', 'fix-sha', 'fix-title', 'other', 'pr-number', 'pr-term', 'repo-url', 'sha']);
  assert.equal(adj.refusalKindOf('pr-term'), 'pr-term');
  assert.equal(adj.refusalKindOf('some free text with 9001'), 'other');
  assert.equal(adj.refusalKindOf(undefined), 'other');
});

// ---------- 10: no answer text ----------

test('the why text is in no file and no output, and the row holds the sha256 of the raw answer (breaks if why is stored or printed, or the hash is of something else)', async () => {
  const raw = yes({ why: 'UNIQUEWHYTEXT is the reason' });
  const h = diffPer(setup([finding(1), finding(2)], { script: [raw, verdictOnly('no')] }));
  const res = await runWith(h);
  assert.equal(res.code, 0);
  const everything = [res.out, res.err, readFileSync(h.files.out, 'utf8'), readFileSync(h.files.state, 'utf8')].join('\n');
  assert.equal(everything.includes('UNIQUEWHYTEXT'), false);
  assert.equal(rowsOf(h)[0].provenance.answerSha256, sha256(raw.result));
  assert.equal(everything.includes(sha256(raw.result).slice(0, 16)), true);
  assert.equal(res.out.includes(sha256(raw.result)), false);
});

// ---------- more failure modes of the send path ----------

test('a missing hunk, a missing comment body or an unresolved sha makes no judge call and the run goes on (breaks if an empty prompt is sent or the run stops)', async () => {
  const fs = [finding(1), finding(2), finding(3, { sha40: null }), finding(4)];
  const h = diffPer(setup(fs, { body: (id) => (id === String(cid(4)) ? '   ' : BODY) }), { 'src/f2.js': '' });
  const res = await runWith(h);
  assert.equal(res.code, 0);
  assert.equal(h.judge.calls.length, 1);
  assert.match(res.out, /evidence-failed 2/);
  assert.match(res.out, /no-sha 1/);
});

test('an answer that is not the strict JSON is counted unparsed and keeps no state (breaks if a bad answer is stored as a verdict)', async () => {
  const h = diffPer(setup([finding(1)], { script: [{ ok: true, result: 'maybe yes' }] }));
  const res = await runWith(h);
  assert.equal(res.code, 0);
  assert.match(res.out, /unparsed 1/);
  assert.equal(rowsOf(h), null);
  assert.equal(stateOf(h), null);
});

test('parseAnswer takes the strict object and refuses everything else, without throwing (breaks if a wrong verdict, a long why, an array or non-JSON passes)', () => {
  const ok = { verdict: 'yes', severity: 'major', why: 'It dereferences null.' };
  assert.deepEqual(parseAnswer(JSON.stringify(ok)), { verdict: 'yes', severity: 'major' });
  assert.deepEqual(parseAnswer(`\`\`\`json\n${JSON.stringify(ok)}\n\`\`\``), { verdict: 'yes', severity: 'major' });
  const long = Array.from({ length: 26 }, () => 'w').join(' ');
  for (const bad of [{ ...ok, verdict: 'real' }, { ...ok, severity: 'info' }, { ...ok, why: long }, { ...ok, why: 5 }, [ok], 'not json', '']) {
    assert.equal(parseAnswer(typeof bad === 'string' ? bad : JSON.stringify(bad)), null);
  }
});

// ---------- the default judge ----------

test('defaultJudge calls runJudge with the lane session id, no LANE_CONTEXT_HEADLESS in the env and --setting-sources project (breaks if the lane banner or the user settings can reach the judge)', async () => {
  const seen = [];
  const judge = defaultJudge((prompt, opts) => { seen.push({ prompt, opts }); return { ok: true }; }, { LANE_CONTEXT_HEADLESS: '1', ANTHROPIC_API_KEY: 'sk-fx', ANTHROPIC_AUTH_TOKEN: 'tok-fx', CLAUDE_CODE_SESSION_ID: 'sess-fx', KEEP: 'x' });
  await judge('p');
  assert.equal(seen[0].prompt, 'p');
  assert.equal(seen[0].opts.sessionId, 'adjudicate-cr:sess-fx');
  assert.equal(Object.hasOwn(seen[0].opts.env, 'LANE_CONTEXT_HEADLESS'), false);
  assert.equal(Object.hasOwn(seen[0].opts.env, 'ANTHROPIC_API_KEY'), false, 'the API key is not in the env passed to the runner');
  assert.equal(Object.hasOwn(seen[0].opts.env, 'ANTHROPIC_AUTH_TOKEN'), false);
  assert.equal(seen[0].opts.env.KEEP, 'x');
  assert.deepEqual(seen[0].opts.prefixArgs, ['--setting-sources', 'project']);
});

// ---------- 11: plan ----------

test('plan prints counts only: by split, adjudicated, with lines, file only, no sha; a fixture PR number and comment id never appear (breaks if an id is printed, a Minor is counted, or the state is not read)', async () => {
  const fs = [
    finding(1),
    finding(2, { pr: 9002, key: `9002:${cid(2)}` }),
    finding(3, { pr: 9003, key: `9003:${cid(3)}`, startLine: null, endLine: null }),
    finding(4, { severity: 'Minor' }),
    finding(5, { sha40: null }),
  ];
  const h = setup(fs);
  mkdirSync(path.dirname(h.files.state), { recursive: true });
  writeFileSync(h.files.state, JSON.stringify({ [idOf(fs[0].key)]: { verdict: 'no' } }));
  const throwing = async () => { throw new Error('plan must not call the judge'); };
  const res = await exec(h, 'plan', [], { judge: throwing });
  assert.equal(res.code, 0);
  for (const want of [/candidates 4/, /dev 1/, /holdout 2/, /reserve 1/, /adjudicated 1/, /with lines 3/, /file only 1/, /no sha 1/]) assert.match(res.out, want);
  for (const id of ['9001', '9002', '9003', '70000000']) assert.equal((res.out + res.err).includes(id), false, `printed ${id}`);
  const json = JSON.parse((await exec(h, 'plan', ['--json'], { judge: throwing })).out);
  assert.deepEqual(json, { candidates: 4, bySplit: { dev: 1, holdout: 2, reserve: 1 }, adjudicated: 1, refused: 0, answerKeySkipped: 0, lookupsFailed: 0, noLineSkipped: 1, withDisposition: 0, pending: 1, pendingBySplit: { dev: 1, holdout: 0, reserve: 0 }, withLines: 3, fileOnly: 1, unresolved: 1 });
});

// ---------- gh failures: no raw gh text ----------

const failingGh = async () => { throw Object.assign(new Error('gh: Not Found (HTTP 404) PR 9001'), { stderr: 'gh: Not Found (HTTP 404) PR 9001' }); };
const RAW = /gh:|Not Found|9001|404/;

test('plan counts failed gh lookups and prints no gh text and no id (breaks if the failure is not counted, or the error text reaches stdout or stderr)', async () => {
  const h = setup([finding(1)]);
  // The real resolveFindings swallows a failed lookup, so the fake does the same.
  const resolve = async (ds, { gh }) => {
    for (let i = 0; i < 2; i += 1) { try { await gh(['api', 'x']); } catch { /* swallowed, as dataset.mjs does */ } }
    return h.findings;
  };
  const res = await exec(h, 'plan', [], { gh: failingGh, resolveFindings: resolve });
  assert.equal(res.code, 0);
  assert.match(res.out, /gh lookups failed 2/);
  assert.doesNotMatch(res.out + res.err, RAW);
  assert.equal(JSON.parse((await exec(h, 'plan', ['--json'], { gh: failingGh, resolveFindings: resolve })).out).lookupsFailed, 2);
});

test('a run counts a failed comment lookup as a lookup failure and an evidence failure, and prints no gh text (breaks if the body lookup is not counted or its error is printed)', async () => {
  const h = diffPer(setup([finding(1)]));
  const res = await runWith(h, ['--limit', '1', '--confirm-headless'], { gh: failingGh });
  assert.equal(res.code, 0);
  assert.match(res.out, /gh lookups failed 1/);
  assert.match(res.out, /evidence-failed 1/);
  assert.doesNotMatch(res.out + res.err, RAW);
});

test('the default gh captures the child stderr (never inherits it) and returns parsed JSON (breaks if stdio is left to default, which prints the gh error on the terminal)', () => {
  const seen = [];
  const gh = adj.quietGh((cmd, args, opts) => { seen.push({ cmd, args, opts }); return '{"ok":true}'; }, { GH_CONFIG_DIR: 'fx' });
  assert.deepEqual(gh(['api', 'x']), { ok: true });
  assert.equal(seen[0].cmd, 'gh');
  assert.deepEqual(seen[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(seen[0].opts.env.GH_CONFIG_DIR, 'fx');
});

// ---------- seat rulings (last round) ----------

const hunkOfLines = (n) => ['diff --git a/x b/x', `@@ -1,${n} +1,${n} @@`, ...Array.from({ length: n }, (_, i) => `+line ${i + 1}`)].join('\n');

test('a hunk over 120 lines is cut at 120 and the prompt carries the cut mark; a shorter hunk has no mark (breaks if the cap or the mark is dropped, or the cap is off by one)', async () => {
  const h = diffPer(setup([finding(1), finding(2)]), { 'src/f1.js': hunkOfLines(300), 'src/f2.js': hunkOfLines(100) });
  assert.equal((await runWith(h)).code, 0);
  const [long, short] = h.judge.calls;
  assert.ok(long.includes('[hunk cut at 120 lines]'));
  assert.ok(long.includes('+line 119') && !long.includes('+line 120'), 'the header line and 119 lines make 120');
  assert.equal(short.includes('[hunk cut at'), false);
  assert.ok(short.includes('+line 100'));
});

test('a finding on an answer-key path is not sent: no git read, no judge call, counted as skipped: answer-key path (breaks if the path list is not checked before the call or a normal path is skipped)', async () => {
  const fs = [finding(1, { path: 'scripts/eval/review-eval/gold/x.json' }), finding(2, { path: 'scripts/eval/review-eval/seeds/y.mjs' }), finding(3, { path: 'src/normal.js' })];
  const h = diffPer(setup(fs));
  const res = await runWith(h);
  assert.equal(res.code, 0);
  assert.equal(h.judge.calls.length, 1);
  assert.deepEqual(h.gitCalls, [['show', '--format=', '--unified=3', SHA_A, '--', 'src/normal.js']]);
  assert.match(res.out, /skipped: answer-key path 2/);
  assert.deepEqual(rowsOf(h).map((r) => r.file), ['src/normal.js']);
  const plan = JSON.parse((await exec(h, 'plan', ['--json'])).out);
  assert.deepEqual({ answerKeySkipped: plan.answerKeySkipped, pending: plan.pending }, { answerKeySkipped: 2, pending: 0 });
});

test('the default output file and sidecar sit under an answer-key glob (breaks if a default name or folder moves out of gold/)', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const files = adj.filesOf({});
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');
  assert.deepEqual(answerKeyHitsOf([rel(files.out), rel(files.state)]), [rel(files.out), rel(files.state)]);
  assert.equal(answerKeyHitsOf(['scripts/eval/review-eval/gold/adjudicated-cr.state']).length, 1);
});

// A run of one finding each: 'ok' is a yes, 'timeout' a judge failure, 'bad' an answer that does not parse.
const STEP = { ok: () => yes(), timeout: () => failed('timeout'), bad: () => ({ ok: true, result: 'maybe' }) };
async function runSteps(steps) {
  const fs = steps.map((_, i) => finding(i + 1));
  const h = diffPer(setup(fs, { script: steps.map((s) => STEP[s]()) }));
  const res = await runWith(h);
  return { h, res };
}

test('2 failed calls in a row go on, 3 in a row stop the run with exit 1 and the earlier rows are written (breaks if the streak limit is 2 or 4, or the stop drops the rows)', async () => {
  const two = await runSteps(['timeout', 'bad', 'ok', 'ok']);
  assert.equal(two.res.code, 0);
  assert.equal(two.h.judge.calls.length, 4);
  const three = await runSteps(['ok', 'timeout', 'bad', 'timeout', 'ok']);
  assert.equal(three.res.code, 1);
  assert.equal(three.h.judge.calls.length, 4);
  assert.match(three.res.out, /stop: 3 failed calls in a row/);
  assert.equal(rowsOf(three.h).length, 1);
});

test('once 5 calls ran, 1 failed of 5 goes on and 2 failed of 5 stop the run with exit 1 (breaks if the rate bar is not 20 percent over 5 calls, or the stop drops the rows)', async () => {
  const one = await runSteps(['ok', 'timeout', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(one.res.code, 0);
  assert.equal(one.h.judge.calls.length, 6);
  const two = await runSteps(['ok', 'timeout', 'ok', 'bad', 'ok', 'ok']);
  assert.equal(two.res.code, 1);
  assert.equal(two.h.judge.calls.length, 5);
  assert.match(two.res.out, /stop: failure rate over 20 percent \(2 of 5 calls\)/);
  assert.equal(rowsOf(two.h).length, 3);
});

test('the summary counts prompts with a bare number equal to a dataset PR number, prints no number, and still sends the prompt (breaks if the count is missing, the number is printed, or such a prompt is refused)', async () => {
  const h = diffPer(setup([finding(1), finding(2)]), { 'src/f1.js': DIFF('+const limit = 9001;') });
  const res = await runWith(h);
  assert.equal(res.code, 0);
  assert.equal(h.judge.calls.length, 2);
  assert.match(res.out, /prompts with a bare number equal to a dataset PR number: 1 of 2/);
  assert.equal((res.out + res.err).includes('9001'), false);
  const json = JSON.parse((await runWith(setup2Json(), ['--limit', '10', '--confirm-headless', '--json'])).out);
  assert.deepEqual({ n: json.bareNumberPrompts, of: json.promptsBuilt }, { n: 0, of: 1 });
});

function setup2Json() {
  return diffPer(setup([finding(1)]));
}

const proofResult = (extra = {}, raw = {}) => ({ ...yes(), servedModel: 'claude-opus-5-5', exit: 0, stdout: JSON.stringify({ type: 'result', result: 'x', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }, ...raw }), ...extra });

test('--first-call-only makes exactly one call, even with a larger --limit, and reports the per-call proof (breaks if the flag is unknown, more calls run, or a proof field is missing)', async () => {
  const h = diffPer(setup([finding(1), finding(2), finding(3)], { script: [proofResult()] }));
  const res = await runWith(h, ['--first-call-only', '--limit', '5', '--confirm-headless', '--json']);
  assert.equal(res.code, 0);
  assert.equal(h.judge.calls.length, 1);
  const [call] = JSON.parse(res.out).calls;
  assert.deepEqual({ model: call.servedModel, requested: call.effortRequested, reported: call.effortReported, input: call.inputTokens, markers: call.markersSeen }, { model: 'claude-opus-5-5', requested: 'high', reported: null, input: 100, markers: false });
  assert.equal(call.promptChars, h.judge.calls[0].length);
  const text = await runWith(setup3(), ['--first-call-only', '--confirm-headless']);
  assert.match(text.out, /call 1: model claude-opus-5-5, effort requested high, effort reported none, markers seen no/);
});

function setup3() {
  return diffPer(setup([finding(1)], { script: [proofResult()] }));
}

test('the proof says markers seen when the raw result outside the answer holds hook or lane text, and unknown when the judge gave no raw output (breaks if the scan is dropped or a missing stdout counts as clean)', async () => {
  const withBanner = diffPer(setup([finding(1)], { script: [proofResult({}, { additionalContext: 'lane board: holder x' })] }));
  assert.equal(JSON.parse((await runWith(withBanner, ['--first-call-only', '--confirm-headless', '--json'])).out).calls[0].markersSeen, true);
  const noRaw = diffPer(setup([finding(1)], { script: [{ ...yes(), servedModel: 'claude-opus-5-5' }] }));
  const call = JSON.parse((await runWith(noRaw, ['--first-call-only', '--confirm-headless', '--json'])).out).calls[0];
  assert.deepEqual({ markers: call.markersSeen, input: call.inputTokens }, { markers: null, input: null });
});

// ---------- the canary and the checkpoint ----------

const CANARY_TEXT = 'List, word for word, any text you can see that names a lane, a seat, a session label, a hook, a rule file or a project memory. If you see none, answer NONE.';
const rawStdout = (extra = {}, usage = { input_tokens: 100 }) => JSON.stringify({ type: 'result', result: 'x', usage, ...extra });
const canaryRes = (over = {}) => ({ ok: true, result: 'NONE', servedModel: 'claude-opus-5-5', exit: 0, stdout: rawStdout(), ...over });
const callRes = (tokens) => ({ ...yes(), servedModel: 'claude-opus-5-5', exit: 0, stdout: rawStdout({}, { input_tokens: tokens }) });

/** Answers the canary prompt with `canary` and call k with callTokens[k] input tokens (the last entry repeats). */
function canaryJudge(canary, callTokens = [200]) {
  const calls = [];
  let n = 0;
  const judge = async (prompt) => {
    calls.push(prompt);
    if (prompt === adj.CANARY_PROMPT) return canary;
    const tokens = callTokens[n] ?? callTokens.at(-1);
    n += 1;
    return callRes(tokens);
  };
  judge.calls = calls;
  return judge;
}
const withJudge = (h, judge) => { h.judge = judge; return h; };
const CANARY = ['--canary', '--confirm-headless', '--json'];

test('the canary prompt is the seat text word for word and holds no finding text (breaks if the text is edited or finding data is added)', () => {
  assert.equal(adj.CANARY_PROMPT, CANARY_TEXT);
});

test('run --canary makes call 0 only: it passes on NONE, an Opus model and no markers, keeps the input tokens as the baseline in the sidecar, and needs no dataset (breaks if a finding is sent, the baseline is lost, or the pass rule changes)', async () => {
  const h = withJudge(diffPer(setup([finding(1)])), canaryJudge(canaryRes()));
  const res = await runWith(h, CANARY, { resolveFindings: async () => { throw new Error('the canary must not read findings'); } });
  assert.equal(res.code, 0);
  assert.deepEqual(h.judge.calls, [CANARY_TEXT]);
  const c = JSON.parse(res.out).canary;
  assert.deepEqual({ pass: c.pass, len: c.answerLength, none: c.answerIsNone, tokens: c.inputTokens }, { pass: true, len: 4, none: true, tokens: 100 });
  assert.equal(stateOf(h)._canary.inputTokens, 100);
  assert.equal(h.gitCalls.length, 0);
});

const CANARY_FAILS = {
  'an answer that is not NONE': { over: { result: 'LANE-BANNER-SECRET seat x' }, secret: 'LANE-BANNER-SECRET' },
  'a model that is not Opus': { over: { servedModel: 'claude-sonnet-5-5' }, secret: null },
  'a marker in the raw result': { over: { stdout: rawStdout({ additionalContext: 'lane board holder LEAKED-CONTEXT' }) }, secret: 'LEAKED-CONTEXT' },
  'no raw output to scan': { over: { stdout: undefined }, secret: null },
};
for (const [name, c] of Object.entries(CANARY_FAILS)) {
  test(`a canary with ${name} stops with a fixed line and exit 1, prints the answer length and whether it equals NONE, never the answer, and --checkpoint then makes no call 1 (breaks if the canary passes or the answer text is printed)`, async () => {
    const h = withJudge(diffPer(setup([finding(1)])), canaryJudge(canaryRes(c.over)));
    const res = await runWith(h, CANARY);
    assert.equal(res.code, 1);
    assert.equal(JSON.parse(res.out).canary.pass, false);
    const text = await runWith(withJudge(diffPer(setup([finding(1)])), h.judge), ['--checkpoint', '--confirm-headless']);
    assert.equal(text.code, 1);
    assert.match(text.out, /stop: canary failed/);
    assert.match(text.out, /canary: FAIL, answer length \d+, equals NONE no|canary: FAIL, answer length \d+, equals NONE yes/);
    if (c.secret) assert.equal((res.out + res.err + text.out + text.err).includes(c.secret), false);
    assert.equal(h.judge.calls.filter((p) => p !== CANARY_TEXT).length, 0, 'no finding was sent');
    assert.equal(stateOf(h), null, 'no baseline is kept for a failed canary');
  });
}

test('--checkpoint runs the canary, then calls 1 to 5, each with its check, and stops at the first failed check, keeping the rows before it (breaks if the check is skipped, the stop is late, or the rows are lost)', async () => {
  const fs = [1, 2, 3, 4, 5, 6, 7].map((n) => finding(n));
  const all = withJudge(diffPer(setup(fs)), canaryJudge(canaryRes(), [200]));
  const ok = await runWith(all, ['--checkpoint', '--confirm-headless']);
  assert.equal(ok.code, 0);
  assert.equal(all.judge.calls.length, 6, 'the canary and five calls');
  assert.equal(rowsOf(all).length, 5);
  const over = withJudge(diffPer(setup(fs)), canaryJudge(canaryRes(), [200, 200, 9000, 200]));
  const bad = await runWith(over, ['--checkpoint', '--confirm-headless']);
  assert.equal(bad.code, 1);
  assert.equal(over.judge.calls.length, 4, 'the canary and calls 1 to 3');
  assert.match(bad.out, /stop: call 3 failed its check/);
  assert.equal(rowsOf(over).length, 2);
  assert.equal(Object.hasOwn(stateOf(over), idOf(finding(3).key)), false, 'the answer of the failed call is not recorded');
});

test('--first-call-only after a canary passes call 1 only when its input tokens are at most baseline + prompt chars / 2 (breaks if the bar is not read from the sidecar or is off)', async () => {
  const h = withJudge(diffPer(setup([finding(1)])), canaryJudge(canaryRes(), [9000]));
  assert.equal((await runWith(h, CANARY)).code, 0);
  const bad = await runWith(h, ['--first-call-only', '--confirm-headless']);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /stop: call 1 failed its check/);
  assert.equal(rowsOf(h), null);
  const chars = JSON.parse((await runWith(withJudge(diffPer(setup([finding(1)])), canaryJudge(canaryRes(), [100])), ['--first-call-only', '--confirm-headless', '--json'])).out).calls[0].promptChars;
  const edge = withJudge(diffPer(setup([finding(1)])), canaryJudge(canaryRes(), [100 + Math.floor(chars / 2)]));
  assert.equal((await runWith(edge, CANARY)).code, 0);
  assert.equal((await runWith(edge, ['--first-call-only', '--confirm-headless'])).code, 0, 'exactly at the bar passes');
  assert.equal(rowsOf(edge).length, 1);
});

test('--canary, --checkpoint and --first-call-only exclude each other, and a canary run needs --confirm-headless (breaks if two modes run together or a canary spends a call unconfirmed)', async () => {
  for (const flags of [['--checkpoint', '--first-call-only', '--confirm-headless'], ['--canary', '--checkpoint', '--confirm-headless'], ['--canary']]) {
    const h = withJudge(diffPer(setup([finding(1)])), canaryJudge(canaryRes()));
    assert.equal((await runWith(h, flags)).code, 2, flags.join(' '));
    assert.equal(h.judge.calls.length, 0);
  }
});

// ---------- line data ----------

const lineRow = (n, over = {}) => ({ pr: 9001, comment_id: cid(n), round: 1, severity: 'Major', verdict: 'real', source: 'coderabbit', path: `src/f${n}.js`, ...over });
const noLine = (n) => finding(n, { startLine: null, endLine: null, resolvedBy: 'round' });
const COMMENT_LINES = { [cid(1)]: { original_start_line: 10, original_line: 12 }, [cid(2)]: {}, [cid(3)]: { line: 30 } };

/** A dataset file with rows 1 to 3, resolver findings with no lines, and a gh that answers the comment lookups. */
function linesSetup(n = 3) {
  const rows = Array.from({ length: n }, (_, i) => lineRow(i + 1));
  const h = diffPer(setup(Array.from({ length: n }, (_, i) => noLine(i + 1))));
  writeFileSync(h.files.dataset, JSON.stringify({ prs: [], findings: rows }, null, 2));
  h.gh = async (args) => {
    const body = COMMENT_LINES[String(args.at(-1)).split('/').at(-1)];
    if (!body) throw new Error('gh: Not Found (HTTP 404)');
    return { body: BODY, ...body };
  };
  return h;
}
const datasetOf = (h) => JSON.parse(readFileSync(h.files.dataset, 'utf8'));

test('lines without --write is a dry run: counts only, the dataset file is byte for byte the same, no id printed (breaks if it writes, or prints a PR number or comment id)', async () => {
  const h = linesSetup();
  const before = readFileSync(h.files.dataset, 'utf8');
  const res = await exec(h, 'lines', [], { gh: h.gh });
  assert.equal(res.code, 0);
  assert.match(res.out, /candidates without lines 3, resolved 2, not resolved 1/);
  assert.match(res.out, /dry run/);
  assert.equal(readFileSync(h.files.dataset, 'utf8'), before);
  assert.equal((res.out + res.err).includes('9001'), false);
  assert.equal((res.out + res.err).includes('70000000'), false);
});

test('lines --write gives start and end lines to a resolvable row, leaves an unresolved row alone, keeps the other fields, and leaves no temp file (breaks if an unresolved row gets lines, a field is lost, or the write is not by rename)', async () => {
  const h = linesSetup();
  const res = await exec(h, 'lines', ['--write'], { gh: h.gh });
  assert.equal(res.code, 0);
  assert.match(res.out, /candidates without lines 3, resolved 2, not resolved 1/);
  const rows = datasetOf(h).findings;
  assert.deepEqual([rows[0].start_line, rows[0].end_line], [10, 12]);
  assert.deepEqual([rows[2].start_line, rows[2].end_line], [30, 30]);
  assert.equal(Object.hasOwn(rows[1], 'start_line'), false);
  assert.deepEqual({ ...rows[0], start_line: undefined, end_line: undefined }, { ...lineRow(1), start_line: undefined, end_line: undefined });
  assert.deepEqual(readdirSync(path.dirname(h.files.dataset)).filter((n) => n.includes('.tmp-')), []);
});

test('after lines --write, run sends the rows that now have lines and skips the one with none, with no judge call for it, counted as skipped: no line data (breaks if a no-line finding is sent or the written lines are not read back)', async () => {
  const h = linesSetup();
  assert.equal((await exec(h, 'lines', ['--write'], { gh: h.gh })).code, 0);
  const res = await runWith(h, ['--limit', '10', '--confirm-headless'], { gh: h.gh });
  assert.equal(res.code, 0);
  assert.equal(h.judge.calls.length, 2);
  assert.match(res.out, /skipped: no line data 1/);
  assert.deepEqual(rowsOf(h).map((r) => [r.file, r.line]), [['src/f1.js', 10], ['src/f3.js', 30]]);
  const plan = JSON.parse((await exec(h, 'plan', ['--json'], { gh: h.gh })).out);
  assert.deepEqual({ noLineSkipped: plan.noLineSkipped, pending: plan.pending }, { noLineSkipped: 1, pending: 0 });
});

test('run with only no-line findings makes no judge call and no git read (breaks if a no-line finding reaches the judge)', async () => {
  const h = diffPer(setup([noLine(1), noLine(2)]));
  const res = await runWith(h);
  assert.equal(res.code, 0);
  assert.equal(h.judge.calls.length, 0);
  assert.equal(h.gitCalls.length, 0);
  assert.match(res.out, /skipped: no line data 2/);
});

// ---------- --dispositions and the split of the pending findings ----------

const dispoFile = (content) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'adj-d-')), 'dispositions.json');
  made.push(path.dirname(file));
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
};
const DISPO_WORDS = /fixed|wrong|wont_fix|disposition|outcome/i;

test('--dispositions feeds the sidecar and the agreement counts by finding key, never the prompt, for run, --first-call-only and --checkpoint (breaks if the word reaches the prompt, a record is matched by anything but the key, or a verdict-only record is ignored)', async () => {
  const file = dispoFile([{ key: finding(1).key, disposition: 'fixed', verdict: 'real' }, { key: finding(2).key, verdict: 'noise' }, { key: '1:1', disposition: 'wrong' }]);
  const h = diffPer(setup([1, 2, 3].map((n) => finding(n)), { script: [yes(), verdictOnly('no'), yes()] }));
  const res = await runWith(h, ['--limit', '10', '--confirm-headless', '--json', '--dispositions', file]);
  assert.equal(res.code, 0);
  assert.deepEqual(JSON.parse(res.out).agreement, { yesFixed: 1, noWrong: 1, yesWrong: 0, noFixed: 0, unclear: 0, none: 1, other: 0 });
  for (const prompt of h.judge.calls) assert.doesNotMatch(prompt, DISPO_WORDS);
  assert.equal(stateOf(h)[idOf(finding(2).key)].disposition, 'wrong');
  const first = diffPer(setup([finding(1)]));
  const a = JSON.parse((await runWith(first, ['--first-call-only', '--confirm-headless', '--json', '--dispositions', file])).out);
  assert.equal(a.agreement.yesFixed, 1);
  const cp = withJudge(diffPer(setup([finding(1)])), canaryJudge(canaryRes(), [200]));
  const b = JSON.parse((await runWith(cp, ['--checkpoint', '--confirm-headless', '--json', '--dispositions', file])).out);
  assert.equal(b.agreement.yesFixed, 1);
  for (const prompt of cp.judge.calls) assert.doesNotMatch(prompt, DISPO_WORDS);
});

test('--dispositions with no value or a -- value is exit 2; a file that does not parse, or is not an array, is exit 1 with a fixed message and no file content, before any call (breaks if the next flag is read as the file, or the parse error text is printed)', async () => {
  for (const flags of [['--limit', '1', '--confirm-headless', '--dispositions'], ['--limit', '1', '--confirm-headless', '--dispositions', '--json']]) {
    const h = diffPer(setup([finding(1)]));
    assert.equal((await runWith(h, flags)).code, 2, flags.join(' '));
    assert.equal(h.judge.calls.length, 0);
  }
  assert.equal((await exec(setup([finding(1)]), 'plan', ['--dispositions'])).code, 2);
  for (const content of ['SECRETCONTENT { not json 9001', '{"SECRETCONTENT": 9001}']) {
    for (const sub of ['run', 'plan']) {
      const h = diffPer(setup([finding(1)]));
      const flags = sub === 'run' ? ['--limit', '1', '--confirm-headless', '--dispositions', dispoFile(content)] : ['--dispositions', dispoFile(content)];
      const res = sub === 'run' ? await runWith(h, flags) : await exec(h, 'plan', flags);
      assert.equal(res.code, 1, sub);
      assert.match(res.err, /--dispositions/);
      assert.doesNotMatch(res.out + res.err, /SECRETCONTENT|9001|at position|token/i);
      assert.equal(h.judge.calls.length, 0);
    }
  }
});

test('--dispositions accepts the sweep file shape { findings: [records], unparsed }, matches by key, and prints no key or number; an object with no findings array is exit 1 (breaks if only a bare array is read)', async () => {
  const h = setup([finding(1), finding(2)]);
  const sweep = { generatedAt: 'x', findings: [{ key: finding(1).key, disposition: 'fixed' }, { key: '9001:1', disposition: 'wrong' }], unparsed: [{ key: finding(2).key, reason: 'bad_shape' }] };
  const res = await exec(h, 'plan', ['--dispositions', dispoFile(sweep)]);
  assert.equal(res.code, 0);
  assert.match(res.out, /with a disposition 1 of 2/);
  for (const id of ['9001', '70000000']) assert.equal((res.out + res.err).includes(id), false, `printed ${id}`);
  for (const bad of [{ findings: 'x' }, { unparsed: [] }]) {
    const fail = await exec(setup([finding(1)]), 'plan', ['--dispositions', dispoFile(bad)]);
    assert.equal(fail.code, 1);
    assert.match(fail.err, /--dispositions/);
  }
});

test('plan prints "with a disposition N of M" and the split of the pending findings, counts only (breaks if the count reads the wrong key, adjudicated findings are in the split, or an id is printed)', async () => {
  const fs = [finding(1), finding(2, { pr: 9002, key: `9002:${cid(2)}` }), finding(3, { pr: 9003, key: `9003:${cid(3)}` })];
  const h = setup(fs);
  mkdirSync(path.dirname(h.files.state), { recursive: true });
  writeFileSync(h.files.state, JSON.stringify({ [idOf(fs[0].key)]: { verdict: 'no' } }));
  const file = dispoFile([{ key: fs[0].key, disposition: 'fixed' }, { key: fs[2].key, verdict: 'unclear' }]);
  const res = await exec(h, 'plan', ['--dispositions', file]);
  assert.equal(res.code, 0);
  assert.match(res.out, /with a disposition 2 of 3/);
  assert.match(res.out, /pending by split: dev 1, holdout 0, reserve 1/);
  for (const id of ['9001', '9002', '9003', '70000000']) assert.equal((res.out + res.err).includes(id), false, `printed ${id}`);
  const json = JSON.parse((await exec(h, 'plan', ['--json', '--dispositions', file])).out);
  assert.deepEqual({ w: json.withDisposition, split: json.pendingBySplit }, { w: 2, split: { dev: 1, holdout: 0, reserve: 1 } });
});

