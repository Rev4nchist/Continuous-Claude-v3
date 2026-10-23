// apply-rows.test.mjs — pure tests for the four approval gates. No ntn, no git, no FS.
// Every test here maps to a gate the premortem said was asserted but unimplemented.
// Run: node --test scripts/work-tracker/test/apply-rows.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseArgs, parseRowSelection, parseSet, applySets, checkFreshness,
  rowsAlreadyLogged, buildProperties, buildProvenanceBlock, listProposalIds,
  TYPES, IMPACTS, SECTIONS,
} from '../apply-rows.mjs';
import {
  inferType, toProposedRow, splitPartial, topLevelDir, groupCommits,
  buriedCommits, lookbackDate,
} from '../propose-rows.mjs';

const row = (over = {}) => ({
  title: 'Did a thing', type: 'Fix', typeInferred: true, impact: 'Mid', impactInferred: true,
  source: 'Code', dashboardSection: 'Deep Dive', date: '2026-07-26', commits: 'abc1234',
  publishedInReport: false, ...over,
});

// --- gate 3: no batch approval ---------------------------------------------------

test('--all is refused, and the refusal explains why', () => {
  assert.throws(() => parseArgs(['--all']), /does not exist, on purpose/);
});

test('row selection accepts lists and ranges, de-duplicated and sorted', () => {
  assert.deepEqual(parseRowSelection('3,1,2'), [1, 2, 3]);
  assert.deepEqual(parseRowSelection('2-4'), [2, 3, 4]);
  assert.deepEqual(parseRowSelection('1,2-3,3'), [1, 2, 3]);
});

test('row selection rejects nonsense rather than silently selecting nothing', () => {
  assert.throws(() => parseRowSelection(''), /needs a value/);
  assert.throws(() => parseRowSelection('0'), /1-based/);
  assert.throws(() => parseRowSelection('x'), /bad row selector/);
  assert.throws(() => parseRowSelection('4-2'), /bad row range/);
});

// --- --set validation ------------------------------------------------------------

test('--set validates against the Notion vocabulary before the API call', () => {
  // Notion CREATES unknown select options instead of rejecting them, so an invalid
  // value would silently pollute the schema. This must fail here, locally.
  assert.throws(() => parseSet('1.type=Nonsense'), /allowed:/);
  assert.throws(() => parseSet('1.impact=Massive'), /allowed:/);
  assert.throws(() => parseSet('1.date=yesterday'), /invalid/);
  assert.throws(() => parseSet('1.commits=deadbee'), /not settable/);
  assert.deepEqual(parseSet('2.impact=High'), { row: 2, key: 'impact', value: 'High' });
});

test('--set accepts a title containing = and spaces', () => {
  assert.equal(parseSet('1.title=Fix a=b parsing').value, 'Fix a=b parsing');
});

// --- gate 4: attribution ---------------------------------------------------------

test('applySets records what changed, and ignores a no-op override', () => {
  const { row: next, corrected } = applySets(row(), [
    { row: 1, key: 'impact', value: 'High' },
    { row: 1, key: 'type', value: 'Fix' }, // same as existing — not a correction
  ]);
  assert.equal(next.impact, 'High');
  assert.deepEqual(corrected, [{ field: 'impact', from: 'Mid', to: 'High' }]);
});

test('provenance distinguishes a corrected field from an accepted guess', () => {
  const b = buildProvenanceBlock({
    approver: 'dave', proposalId: 'p1', baseHead: 'abc1234', commits: 'abc1234',
    corrected: [{ field: 'impact', from: 'Mid', to: 'High' }],
    inferredAccepted: ['Type=Fix'],
  });
  const text = b.paragraph.rich_text[0].text.content;
  assert.match(text, /Applied by dave/);
  assert.match(text, /proposal p1 \(base HEAD abc1234\)/);
  assert.match(text, /Corrected before apply: impact Mid -> High/);
  assert.match(text, /accepted as-is \(treat as weaker evidence\): Type=Fix/);
});

test('provenance is explicit when nothing was reviewed, rather than silent', () => {
  const text = buildProvenanceBlock({
    approver: 'dave', proposalId: 'p1', baseHead: 'abc', commits: '', corrected: [], inferredAccepted: [],
  }).paragraph.rich_text[0].text.content;
  assert.match(text, /No fields corrected/);
  assert.match(text, /No inferred fields accepted unreviewed/);
});

// --- gate 2: freshness -----------------------------------------------------------

const basis = { watermark: '2026-07-25', headSha: 'aaa1111', trackerRowCount: 77 };

test('freshness passes only when the world is unchanged', () => {
  assert.deepEqual(checkFreshness(basis, { watermark: '2026-07-25', headSha: 'aaa1111', trackerRowCount: 77 }), []);
});

test('freshness catches each kind of drift independently', () => {
  assert.match(checkFreshness(basis, { ...basis, headSha: 'bbb2222' })[0], /git HEAD moved/);
  assert.match(checkFreshness(basis, { ...basis, trackerRowCount: 78 })[0], /Tracker row count moved/);
  assert.match(checkFreshness(basis, { ...basis, watermark: '2026-07-27' })[0], /watermark moved/);
});

test('freshness reports every drift at once, not just the first', () => {
  assert.equal(checkFreshness(basis, { watermark: '2026-07-27', headSha: 'bbb2222', trackerRowCount: 80 }).length, 3);
});

// --- double-log guard ------------------------------------------------------------

test('a row whose commit is already logged is caught, by short sha', () => {
  const logged = new Set(['abc1234']);
  const hits = rowsAlreadyLogged([{ n: 1, row: row() }, { n: 2, row: row({ commits: 'fff9999' }) }], logged);
  assert.deepEqual(hits, [{ n: 1, dup: ['abc1234'] }]);
});

test('multi-commit rows are checked commit by commit', () => {
  const hits = rowsAlreadyLogged([{ n: 1, row: row({ commits: 'aaa1111, bbb2222' }) }], new Set(['bbb2222']));
  assert.deepEqual(hits, [{ n: 1, dup: ['bbb2222'] }]);
});

// --- write shape -----------------------------------------------------------------

test('buildProperties produces the Tracker schema exactly', () => {
  const p = buildProperties(row(), { projectRow: 'proj-1' });
  assert.equal(p.Title.title[0].text.content, 'Did a thing');
  assert.equal(p.Type.select.name, 'Fix');
  assert.equal(p.Impact.select.name, 'Mid');
  assert.equal(p.Source.select.name, 'Code');
  assert.equal(p['Dashboard Section'].select.name, 'Deep Dive');
  assert.equal(p['Published in Report'].checkbox, false);
  assert.equal(p.Date.date.start, '2026-07-26');
  assert.equal(p.Commits.rich_text[0].text.content, 'abc1234');
  assert.equal(p.Project.relation[0].id, 'proj-1');
});

test('buildProperties rejects every invalid select value', () => {
  assert.throws(() => buildProperties(row({ type: 'Deploying' }), {}), /invalid Type/);
  assert.throws(() => buildProperties(row({ impact: 'Huge' }), {}), /invalid Impact/);
  assert.throws(() => buildProperties(row({ dashboardSection: 'Nope' }), {}), /invalid Dashboard Section/);
  assert.throws(() => buildProperties(row({ source: 'Robot' }), {}), /invalid Source/);
  assert.throws(() => buildProperties(row({ title: '  ' }), {}), /no title/);
});

test('every Type propose-rows can infer is a Type apply-rows will accept', () => {
  // The two files carry separate vocabularies; a drift between them would only surface
  // as a polluted Notion schema in production. Pin them together here.
  for (const prefix of ['feat', 'fix', 'docs', 'refactor', 'perf', 'build', 'ci', 'test', 'chore', 'unknown']) {
    assert.ok(TYPES.includes(inferType(prefix)), `inferType("${prefix}") -> ${inferType(prefix)} not in TYPES`);
  }
});

test('a default proposed row is directly writable — the two files agree end to end', () => {
  const group = { scope: 'coordination', prefix: 'fix', date: '2026-07-26', topDir: 'scripts', commits: [{ sha: 'abc1234', description: 'did it' }] };
  const proposed = toProposedRow(group);
  assert.ok(IMPACTS.includes(proposed.impact));
  assert.ok(SECTIONS.includes(proposed.dashboardSection));
  assert.doesNotThrow(() => buildProperties(proposed, {}));
});

// --- gate 1: named proposal ------------------------------------------------------

test('proposal ids are discovered from filenames, not guessed', () => {
  const ids = listProposalIds('/fake', {
    readdir: () => ['work-rows-proposal-2026-07-25-30c.json', 'work-rows-proposal-a.json', 'unrelated.json'],
  });
  assert.deepEqual(ids, ['2026-07-25-30c', 'a']);
});

test('parseArgs requires a value for --proposal and rejects unknown flags', () => {
  assert.equal(parseArgs(['--proposal', 'p1']).proposal, 'p1');
  assert.throws(() => parseArgs(['--wat']), /unknown flag/);
});

// --- the grouping invariant the premortem flagged, verified end to end -------------

test('a group can never span two days or two top-level directories', () => {
  // predicted this and it fired on the very first live run: a Decision and a Fix
  // were fused because they shared a scope. Scope alone is not a work-unit boundary.
  const commits = [
    { sha: 'a', scope: 'coord', prefix: 'fix', date: '2026-07-26', topDir: 'scripts', description: 'x' },
    { sha: 'b', scope: 'coord', prefix: 'fix', date: '2026-07-27', topDir: 'scripts', description: 'y' },
    { sha: 'c', scope: 'coord', prefix: 'fix', date: '2026-07-26', topDir: 'docs', description: 'z' },
  ];
  const groups = groupCommits(commits);
  assert.equal(groups.length, 3, 'same scope must still split on date and directory');
  for (const g of groups) {
    assert.equal(new Set(g.commits.map((c) => c.date)).size, 1);
    assert.equal(new Set(g.commits.map((c) => c.topDir)).size, 1);
  }
});

test('a partly-logged group is split, never suppressed and never re-proposed whole', () => {
  const group = { scope: 's', prefix: 'fix', date: '2026-07-26', topDir: 'scripts', commits: [{ sha: 'aaa1111' }, { sha: 'bbb2222' }] };
  const split = splitPartial(group, new Set(['aaa1111']));
  assert.deepEqual(split.commits.map((c) => c.sha), ['bbb2222'], 'the unlogged commit survives');
  assert.deepEqual(split.alreadyLogged, ['aaa1111']);
  assert.equal(split.partiallyLogged, true);
  assert.equal(splitPartial(group, new Set(['aaa1111', 'bbb2222'])), null, 'fully logged -> nothing proposed');
});

// --- the watermark hole ----------------------------------------------------------

test('work below the watermark that no row records is surfaced, not swallowed', () => {
  // Observed for real on 2026-07-27: applying one row dated 07-26 advanced the
  // watermark past three unlogged 07-25 commits, leaving them neither proposed nor
  // logged. A high-water mark cannot see behind itself, so something else must.
  const commits = [
    { sha: 'old1111', date: '2026-07-25', subject: 'unlogged, below watermark' },
    { sha: 'old2222', date: '2026-07-25', subject: 'logged, below watermark' },
    { sha: 'new3333', date: '2026-07-26', subject: 'at the watermark' },
  ];
  const buried = buriedCommits(commits, new Set(['old2222']), '2026-07-26');
  assert.deepEqual(buried.map((c) => c.sha), ['old1111']);
});

test('buried detection excludes the watermark day itself — that day is already proposed', () => {
  const commits = [{ sha: 'a', date: '2026-07-26', subject: 'x' }];
  assert.deepEqual(buriedCommits(commits, new Set(), '2026-07-26'), []);
});

test('lookbackDate walks back real calendar days across a month boundary', () => {
  assert.equal(lookbackDate('2026-07-26', 14), '2026-07-12');
  assert.equal(lookbackDate('2026-08-05', 14), '2026-07-22');
  assert.equal(lookbackDate('2026-03-01', 1), '2026-02-28');
  assert.equal(lookbackDate('not-a-date', 14), 'not-a-date', 'a bad watermark degrades, it does not throw');
});

test('topLevelDir picks the dominant directory deterministically', () => {
  assert.equal(topLevelDir(['scripts/a.mjs', 'scripts/b.mjs', 'docs/c.md']), 'scripts');
  assert.equal(topLevelDir(['a/x', 'b/y']), 'a', 'ties break alphabetically, not by insertion order');
  assert.equal(topLevelDir([]), '');
});
