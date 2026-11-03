// Tests for intent.mjs (the intent source of the TREX intent arm). Every test imports the real function.
// Git and gh are fakes. Nothing here calls the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTENT_DIR, MAX_BODY, intentFacts, intentLeakHits, loadIntent, prFromSubject, rangeEnd, stripLate } from './intent.mjs';

const tmp = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trex-intent-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const SEP = '\x1f';
const REC = '\x1e';

/** A fake git: handlers are [regex over the joined args, result]. An unhandled call fails loudly. */
const gitFrom = (handlers) => {
  const git = (args) => {
    const key = args.join(' ');
    git.calls.push(key);
    for (const [re, out] of handlers) if (re.test(key)) return { status: 0, stderr: '', stdout: typeof out === 'function' ? out(key) : out };
    return { status: 1, stdout: '', stderr: `unhandled git ${key}` };
  };
  git.calls = [];
  return git;
};
const endLog = (subject, body = '') => [/^log -1 --format=%s%x1f%B abc123$/, `${subject}${SEP}${subject}\n\n${body}`];
const ghFrom = (json) => {
  const gh = (args) => { gh.calls.push(args); return typeof json === 'function' ? json(args) : { status: 0, stdout: JSON.stringify(json), stderr: '' }; };
  gh.calls = [];
  return gh;
};
const PR243 = { number: 243, title: 'feat(checks): turn Majors into checks', body: 'Adds the checks.\nThey run before a PR opens.', merged_at: '2026-11-02T01:19:49Z' };
const load = (t, over = {}) => {
  const root = over.root ?? tmp(t);
  const git = over.git ?? gitFrom([endLog('Merge pull request #243 from Rev4nchist/feat/prepr-checks', 'feat(checks): turn Majors into checks')]);
  const gh = over.gh ?? ghFrom(PR243);
  return { root, git, gh, run: (extra = {}) => loadIntent('S14', 'abc122..abc123', { root, git, gh, now: () => NOW, ...extra }) };
};
const fileOf = (root) => path.join(root, ...INTENT_DIR.split('/'), 'S14.json');

// ---------- rangeEnd and prFromSubject ----------

test('rangeEnd takes the end of a two-dot or three-dot range, and the whole text of a single commit', () => {
  // Breaks when the end is read from the left side: the intent would belong to the commit before the change.
  assert.equal(rangeEnd('beb9d5ef..23b62e5d'), '23b62e5d');
  assert.equal(rangeEnd('707612bd^1..707612bd'), '707612bd');
  assert.equal(rangeEnd('a...b'), 'b');
  assert.equal(rangeEnd('abc'), 'abc');
});

test('prFromSubject reads a GitHub PR merge subject only', () => {
  // Breaks when any "Merge" subject counts: a merge of fork/main would fetch a random PR.
  assert.equal(prFromSubject('Merge pull request #243 from Rev4nchist/feat/prepr-checks'), 243);
  assert.equal(prFromSubject("Merge remote-tracking branch 'fork/main' into chore/remove-maestro"), null);
  assert.equal(prFromSubject('fix: handle Merge pull request #5 text'), null);
});

// ---------- loadIntent: source ----------

test('loadIntent fetches the merged PR once, stores it, and a second call reads the file and never calls gh', (t) => {
  // Breaks when the stored file is not reused: the probe would not be reproducible and every dry run would call the network.
  const s = load(t);
  const first = s.run();
  assert.equal(first.error, undefined);
  assert.equal(first.fetched, true);
  assert.deepEqual(s.gh.calls, [['api', 'repos/Rev4nchist/Continuous-Claude-v3/pulls/243', '--jq', '{title,body,merged_at,number}']]);
  const stored = JSON.parse(readFileSync(fileOf(s.root), 'utf8'));
  assert.equal(stored.pr, 243);
  assert.equal(stored.title, PR243.title);
  assert.equal(stored.body, PR243.body);
  assert.equal(stored.source, 'pr');
  assert.equal(stored.fetchedAt, '2026-11-03T12:00:00.000Z');
  const second = s.run();
  assert.equal(second.fetched, false);
  assert.equal(s.gh.calls.length, 1, 'no second gh call');
  assert.equal(second.intent.title, PR243.title);
});

test('loadIntent reads a hand-edited stored file, not a fresh fetch', (t) => {
  // Breaks when an existing file is overwritten: a human edit that removed a leak would come back.
  const s = load(t);
  s.run();
  const file = fileOf(s.root);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), title: 'edited title' }));
  assert.equal(s.run().intent.title, 'edited title');
});

test('loadIntent with refetch calls gh again and replaces the file', (t) => {
  // Breaks when --refetch-intent is ignored: a bad stored intent could never be replaced from GitHub.
  const s = load(t);
  s.run();
  writeFileSync(fileOf(s.root), JSON.stringify({ pr: 243, title: 'old', body: 'old', source: 'pr', fetchedAt: 'x' }));
  const r = s.run({ refetch: true });
  assert.equal(s.gh.calls.length, 2);
  assert.equal(r.fetched, true);
  assert.equal(JSON.parse(readFileSync(fileOf(s.root), 'utf8')).title, PR243.title);
});

test('loadIntent uses the range end commit message when the end is not a PR merge, and calls no gh', (t) => {
  // Breaks when a non-PR end still calls gh: S1 and S8 end on a plain commit and a fork/main merge.
  const s = load(t, { git: gitFrom([endLog('fix(agentic-os): keep the words around a path', 'The path scrub ran to the end of the line.\n\nRED: the new spec failed.')]) });
  const r = s.run();
  assert.equal(r.error, undefined);
  assert.equal(s.gh.calls.length, 0);
  assert.equal(r.intent.pr, null);
  assert.equal(r.intent.source, 'commit');
  assert.equal(r.intent.title, 'fix(agentic-os): keep the words around a path');
  assert.equal(r.intent.body, 'The path scrub ran to the end of the line.\n\nRED: the new spec failed.');
});

test('loadIntent trims the body to 4000 characters in the stored file', (t) => {
  // Breaks when the trim is missing: a 30k PR body would push the prompt over its limit.
  const s = load(t, { gh: ghFrom({ ...PR243, body: 'x'.repeat(9000) }) });
  s.run();
  assert.equal(JSON.parse(readFileSync(fileOf(s.root), 'utf8')).body.length, MAX_BODY);
  assert.equal(MAX_BODY, 4000);
});

test('loadIntent stores a PR with a null body as an empty string', (t) => {
  // Breaks when a null body is stored as null: the prompt would print "null".
  const s = load(t, { gh: ghFrom({ ...PR243, body: null }) });
  assert.equal(s.run().intent.body, '');
});

// ---------- loadIntent: failures ----------

test('loadIntent reports a gh failure, a bad answer and a wrong PR number, and writes no file', (t) => {
  // Breaks when a failed fetch stores an empty intent: the probe would run blind and look like an intent run.
  const cases = [
    ghFrom(() => ({ status: 1, stdout: '', stderr: 'gh: HTTP 404' })),
    ghFrom(() => ({ status: 0, stdout: 'not json', stderr: '' })),
    ghFrom({ ...PR243, number: 999 }),
    ghFrom({ number: 243, body: 'no title' }),
  ];
  for (const gh of cases) {
    const s = load(t, { gh });
    const r = s.run();
    assert.ok(r.error, 'error');
    assert.ok(!existsSync(fileOf(s.root)), 'no file');
  }
  assert.match(load(t, { gh: cases[0] }).run().error, /404/);
});

test('loadIntent reports a git failure on the range end', (t) => {
  const s = load(t, { git: gitFrom([]) });
  assert.match(s.run().error, /abc123/);
});

test('loadIntent refuses a stored file that is not valid intent JSON', (t) => {
  // Breaks when a damaged file is read as an empty intent.
  const s = load(t);
  mkdirSync(path.dirname(fileOf(s.root)), { recursive: true });
  for (const text of ['{broken', JSON.stringify({ title: 'only title' }), JSON.stringify({ title: 1, body: 'b' })]) {
    writeFileSync(fileOf(s.root), text);
    assert.match(s.run().error, /S14\.json/);
  }
  assert.equal(s.gh.calls.length, 0);
});

// ---------- stripLate ----------

test('stripLate drops lines that name a later PR, a follow-up or a "fixed in", and keeps the others', () => {
  // Breaks when > becomes >=: the PR itself ("#243") would lose its own lines. Breaks when the rules are missing: post-merge notes reach the author.
  const body = [
    'Adds the checks (see #200 for the design).',
    'Closes #243.',
    'Later: fixed in #260.',
    'Follow-up: handle spaces.',
    'See https://github.com/Rev4nchist/Continuous-Claude-v3/pull/301 for more.',
    'It runs before a PR opens.',
  ].join('\n');
  const r = stripLate({ pr: 243, title: 't', body });
  assert.equal(r.body, 'Adds the checks (see #200 for the design).\nCloses #243.\nIt runs before a PR opens.');
  assert.equal(r.stripped.length, 3);
});

test('stripLate drops a post-merge section up to the next heading of the same or a higher level', () => {
  // Breaks when only single lines are removed: an "Update after merge" section keeps its other lines.
  const body = '## What\nAdds a gate.\n\n## Update after merge\nThe gate broke on spaces.\nSecond line.\n### Detail\nmore\n\n## Testing\nRun it.';
  const r = stripLate({ pr: 10, title: 't', body });
  assert.equal(r.body, '## What\nAdds a gate.\n\n## Testing\nRun it.');
  assert.ok(r.stripped.length >= 5);
});

test('stripLate with no PR number applies the text rules only', () => {
  // Breaks when a null pr crashes the comparison or strips every "#" number.
  const r = stripLate({ pr: null, title: 't', body: 'Per #200 review.\nfixed in the next commit' });
  assert.equal(r.body, 'Per #200 review.');
});

test('stripLate leaves a clean body unchanged', () => {
  const body = 'One.\n\nTwo.';
  assert.deepEqual(stripLate({ pr: 5, title: 't', body }), { title: 't', body, stripped: [] });
});

// ---------- intentFacts ----------

const MERGE_LIST = [
  ["Merge remote-tracking branch 'fork/main' into feat/x", ''],
  ['Merge pull request #197 from Rev4nchist/fix/pre-pr-gate-findings', 'fix: the gate findings'],
  ['Merge pull request #198 from Rev4nchist/feat/y', 'feat: y'],
].map((r) => `${r[0]}${SEP}${r[1]}${REC}`).join('\n');

test('intentFacts finds the PR that contains the fix: the first PR merge on the ancestry path, not a fork/main merge', () => {
  // Breaks when a "Merge remote-tracking branch" counts as the PR, or when the newest merge is taken instead of the oldest.
  const git = gitFrom([
    [/^log -1 --format=%s%x1f%b fixsha$/, `fix: a thing${SEP}`],
    [/^log --merges --ancestry-path --reverse --format=%s%x1f%b%x1e fixsha\.\.HEAD$/, MERGE_LIST],
    [/^log --merges --ancestry-path --reverse --format=%s%x1f%b%x1e endsha\.\.HEAD$/, MERGE_LIST],
    [/^log --format=%s endsha\.\.fixsha$/, 'a later commit subject here\nshort\n'],
  ]);
  const f = intentFacts(git, { end: 'endsha', fix: 'fixsha' });
  assert.deepEqual(f.fixPr, { n: 197, title: 'fix: the gate findings' });
  assert.equal(f.endPr, 197);
  assert.deepEqual(f.later, ['a later commit subject here', 'short']);
});

test('intentFacts reads a fix that is itself a PR merge', () => {
  const git = gitFrom([
    [/^log -1 --format=%s%x1f%b fixsha$/, `Merge pull request #12 from a/b${SEP}the title of twelve\n`],
    [/^log -1 --format=%s%x1f%b endsha$/, `Merge pull request #11 from a/c${SEP}the title of eleven\n`],
    [/^log --format=%s endsha\.\.fixsha$/, ''],
  ]);
  const f = intentFacts(git, { end: 'endsha', fix: 'fixsha' });
  assert.deepEqual(f.fixPr, { n: 12, title: 'the title of twelve' });
  assert.equal(f.endPr, 11);
});

test('intentFacts returns no fix PR and no later commits for a group without a fix, and survives git errors', () => {
  // Breaks when a git failure throws: a dry run must still report the leak scan it could do.
  assert.deepEqual(intentFacts(gitFrom([]), { end: 'e', fix: null }), { fixPr: null, endPr: null, later: [] });
  assert.deepEqual(intentFacts(gitFrom([]), { end: 'e', fix: 'f' }), { fixPr: null, endPr: null, later: [] });
});

// ---------- intentLeakHits ----------

const FACTS = { fixPr: { n: 200, title: 'fix: stop the space-path leak in safe-message' }, endPr: 190, later: ['a later commit that repairs the scrub', 'tiny'] };

test('intentLeakHits flags the fix PR number, the fix PR title, a later commit subject and a later PR number', () => {
  // Breaks when one of the four rules is missing: that kind of leak reaches the author.
  const hit = (text, pr = 190) => intentLeakHits(text, { pr, facts: FACTS });
  assert.equal(hit('see #200 for details').length, 1);
  assert.equal(hit('see PR 200 for details').length, 1);
  assert.equal(hit('Fix: Stop the space-path leak in safe-message').length, 1);
  assert.equal(hit('then A later commit that repairs the scrub').length, 1);
  assert.equal(hit('also see #250').length, 1);
});

test('intentLeakHits ignores near misses: #2000, a short later subject, the intent own PR and an earlier PR', () => {
  // Breaks when the number match has no word edge, when a 4-character subject matches, or when #190 counts as later.
  assert.deepEqual(intentLeakHits('see #2000 and tiny and PR 2001', { pr: null, facts: { ...FACTS, endPr: null } }), []);
  assert.deepEqual(intentLeakHits('see #190 and #150 and tiny', { pr: 190, facts: FACTS }), []);
});

test('intentLeakHits skips the fix PR rules when the fix is in the same PR as the intent', () => {
  // Breaks when S1 (fix and bug in PR #200) refuses its own commit message for citing #200.
  const same = { ...FACTS, endPr: 200 };
  assert.deepEqual(intentLeakHits('review finding on #200: stop the space-path leak in safe-message', { pr: null, facts: same }), []);
  assert.equal(intentLeakHits('then a later commit that repairs the scrub', { pr: null, facts: same }).length, 1, 'later commits still count');
});

test('intentLeakHits counts a number once, and a commit-source intent compares later PRs with the PR that contains the commit', () => {
  // Breaks when the fix PR is also reported as a later PR, or when a null pr turns the later-PR rule off for a commit message.
  assert.equal(intentLeakHits('see #200', { pr: 190, facts: FACTS }).length, 1);
  assert.equal(intentLeakHits('see #195', { pr: null, facts: FACTS }).length, 1);
  assert.deepEqual(intentLeakHits('see #180', { pr: null, facts: FACTS }), []);
});

test('intentLeakHits with no facts and no PR finds nothing', () => {
  assert.deepEqual(intentLeakHits('anything #999', { pr: null, facts: { fixPr: null, endPr: null, later: [] } }), []);
});
