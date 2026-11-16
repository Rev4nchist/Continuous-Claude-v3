// Tests for lib/holdout-ids.mjs (card prflow-push-blocks). Run: node --test scripts/github/lib/holdout-ids.test.mjs
// All ids are synthetic. No real id and no real dataset value is read.
//
// How the unit can fail, and the test that catches it:
//   the set rule differs from setOf of dataset.mjs (a dev or reserve PR is scanned, or a holdout PR is not)  -> HS2
//   a form is missed or a bare small number matches                                                            -> HS1
//   the lib has an import, an entry guard or a file read (it is bundled into a hook)                          -> HS3
//   the matcher returns an id instead of a count                                                               -> HS4
//   a short sha form is missed, in either direction (card coord-decision-gate-round3-content-scan, F1)         -> HS5
//   a dataset or config of the wrong shape gives a short list instead of a throw (item 14)                     -> HS6
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setOf } from '../../eval/review-eval/dataset.mjs';
import { checkHoldoutShape, countIdsIn, holdoutIdsOf } from './holdout-ids.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('HS1: each id form matches in its own way, a bare small number never matches', () => {
  // Breaks when: a PR number matches with no context word, a comment id needs one, or a key or sha is not a whole token.
  const ids = ['9990001', '42', '5550002:8880003', 'abcdef1234', '8880003'];
  assert.equal(countIdsIn('see PR 42 and #9990001', ids), 2, 'PR number after a context word, comment-id sized number');
  assert.equal(countIdsIn('const answer = 42; const t = 1042; x = 420', ids), 0, 'bare small number, longer numbers');
  assert.equal(countIdsIn('https://github.com/x/y/pull/42', ids), 1, 'pull/ form');
  assert.equal(countIdsIn('comment 8880003 was wrong', ids), 1, 'a long digit run matches bare');
  assert.equal(countIdsIn('key 5550002:8880003 here', ids), 2, 'a key and its comment id');
  assert.equal(countIdsIn('hash abcdef1234 and abcdef12345', ids), 1, 'a sha is a whole token, a longer hex run is another token');
  assert.equal(countIdsIn('PR 42 PR 42 #42', ids), 1, 'each id counts once');
});

test('HS2: the set rule equals setOf of dataset.mjs for synthetic PRs', () => {
  // Breaks when: the lib and dataset.mjs disagree on dev (holdoutExclude), reserve and holdout.
  const cfg = { holdoutExclude: [101, 102], reserve: [{ pr: 103, answerKeySource: 'x' }] };
  const ds = { prs: [101, 102, 103, 104, 105].map((pr) => ({ pr })), findings: [{ pr: 104, comment_id: 777, round: 'ABCDEF1234' }, { pr: 101, comment_id: 888 }, { pr: 103, comment_id: 999 }] };
  const ids = new Set(holdoutIdsOf(ds, cfg));
  for (const pr of [101, 102, 103, 104, 105]) assert.equal(ids.has(String(pr)), setOf(pr, cfg) === 'holdout', `pr ${pr}`);
  assert.ok(ids.has('777') && ids.has('104:777') && ids.has('abcdef1234'), 'comment id, key and sha of a holdout finding');
  assert.equal(ids.has('888') || ids.has('999'), false, 'no id of a dev or reserve finding');
});

test('HS3: the lib has no import, no entry code, no file or process access', () => {
  // Breaks when: someone adds an import or a read (esbuild bundles the file into a hook).
  const text = readFileSync(path.join(HERE, 'holdout-ids.mjs'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const bad of [/^\s*import\s/m, /process\./, /import\.meta/, /readFileSync|writeFileSync|fs\./, /require\(/]) assert.equal(bad.test(text), false, String(bad));
});

test('HS4: the matcher returns a count, never an id', () => {
  // Breaks when: the return value carries the matched text.
  const n = countIdsIn('PR 9990001', ['9990001']);
  assert.equal(typeof n, 'number');
  assert.equal(n, 1);
});

test('HS5: a sha matches by prefix in both directions, with a 7-hex floor', () => {
  // Breaks when: a stored sha matches only as a whole token (a commit message cites the first 8 hex).
  const full = 'abcdef0123456789abcdef0123456789abcdef01';
  assert.equal(countIdsIn('merge of abcdef01 done', [full]), 1, 'text holds a prefix of the stored sha');
  assert.equal(countIdsIn(`merge of ${full} done`, ['abcdef0']), 1, 'stored short sha is a prefix of the text sha');
  assert.equal(countIdsIn('merge of abcdef done', [full]), 0, 'six hex is under the floor');
  assert.equal(countIdsIn('merge of abcdef0aaaa done', [full]), 0, 'a run that is not a prefix');
  assert.equal(countIdsIn(`hash ${'9'.repeat(12)}${full}${'8'.repeat(12)} end`, [full]), 1, 'a sha inside a hex run longer than 40');
});

test('HS6: the shape check throws on a dataset or config that would give a short list', () => {
  // Breaks when: a missing findings key, an empty list, a string pr or a non-array config field passes the check.
  const good = { prs: [{ pr: 9001 }], findings: [{ pr: 9001, comment_id: 5 }] };
  assert.doesNotThrow(() => checkHoldoutShape(good, { reserve: [], holdoutExclude: [] }));
  assert.doesNotThrow(() => checkHoldoutShape(good, undefined));
  const bad = [
    [{ prs: [{ pr: 9001 }] }, {}],
    [{ prs: [], findings: good.findings }, {}],
    [{ prs: good.prs, findings: [] }, {}],
    [{ prs: [{ pr: '9001' }], findings: good.findings }, {}],
    [{ prs: good.prs, findings: [{ pr: 0 }] }, {}],
    [null, {}],
    [[], {}],
    [good, { reserve: { pr: 1 } }],
    [good, { holdoutExclude: 'x' }],
    [good, []],
    // Seat read 2, item 4: a renamed comment id key, a comment id of the wrong type, a round of the wrong type.
    [{ prs: good.prs, findings: [{ pr: 9001, commentId: 5 }] }, {}],
    [{ prs: good.prs, findings: [{ pr: 9001, comment_id: { id: 5 } }] }, {}],
    [{ prs: good.prs, findings: [{ pr: 9001, comment_id: 5, round: { sha: 'x' } }] }, {}],
  ];
  // The real shapes pass: a finding with no comment id, a non-digit comment id string, an integer round (2026-11-15 dataset).
  assert.doesNotThrow(() => checkHoldoutShape({ prs: good.prs, findings: [{ pr: 9001, comment_id: '5', round: 2 }, { pr: 9001 }, { pr: 9001, comment_id: 'r-abc' }] }, {}));
  for (const [ds, cfg] of bad) assert.throws(() => checkHoldoutShape(ds, cfg), /wrong shape/, JSON.stringify([ds, cfg]));
});
