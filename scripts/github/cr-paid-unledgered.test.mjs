// Tests for `cr-paid.mjs unledgered --pr N --json` and unledgeredPaidOf (paid guard PR 2: the 5-minute watch flags a paid comment with no ledger row).
// Run: node --test scripts/github/cr-paid-unledgered.test.mjs
// No network: gh is an injected fake. The paid ledger is a real file in a temp folder.
//
// How the flag can be wrong, and the test that catches it:
//   a paid comment with no ledger row is missed                                                                      -> UL1
//   a paid comment WITH a ledger row for this PR and head is flagged; a row for another head or PR hides it          -> UL2, UL2b
//   a plain "@coderabbitai review" (no paid word) is flagged                                                         -> UL3
//   a paid comment made before the head commit (an older head) is flagged                                            -> UL4
//   a failed GitHub read, a bad head or a bad ledger throws, or exits non-zero, or flags                              -> UL5
//   the verb accepts a flag other than --pr and --json, or runs with no --pr                                         -> UL6
//   the queue and the verb use two copies of the rule                                                                -> UL7
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as PAID from './cr-paid.mjs';

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const OLD = 'c'.repeat(40);
const NOW = new Date('2026-11-18T15:00:00Z');
const COMMITTED = '2026-11-18T12:00:00Z';
const PAID_WORD = '@coderabbitai review --use-credits';
const human = (id, body, created_at) => ({ id, user: { login: 'dave', type: 'User' }, body, created_at, updated_at: created_at });
const LATE = '2026-11-18T13:00:00Z';
const EARLY = '2026-11-18T11:00:00Z';

/** A fake gh: the pull, the head commit and the issue comments (no bot comments, so the GraphQL page is empty). */
function world({ comments = [], head = HEAD, down = false, headBody } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cr-paid-unledgered-'));
  const ledgerPath = path.join(dir, 'coderabbit-paid.jsonl');
  const gh = (args) => {
    if (down) throw new Error('network down');
    if (args.includes('graphql')) return { data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false }, nodes: [] } } } } };
    if (args.some((a) => /issues\/\d+\/comments/.test(a))) return [comments];
    if (args.some((a) => /\/commits\/[0-9a-f]{40}$/.test(a))) return { commit: { committer: { date: COMMITTED } } };
    return headBody ?? { head: { sha: head }, state: 'open' };
  };
  const deps = { gh, now: () => NOW, ledgerPath, env: {} };
  return { dir, deps, ledgerPath, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const verb = (w, pr = 7) => PAID.unledgeredOf({ pr, repo: REPO }, w.deps);

test('UL1: a paid comment on the head with no ledger row gives its id', () => {
  const w = world({ comments: [human(41, PAID_WORD, LATE)] });
  assert.deepEqual(verb(w), { head: HEAD, ids: [41] });
  w.done();
});

test('UL2: a ledger row for this PR and head hides the comment', () => {
  const w = world({ comments: [human(41, PAID_WORD, LATE)] });
  PAID.recordPaid({ pr: 7, head: HEAD, files: 3 }, w.deps);
  assert.deepEqual(verb(w), { head: HEAD, ids: [] });
  w.done();
});

test('UL2b: a row for another head, or for another PR, does not hide it', () => {
  const w = world({ comments: [human(41, PAID_WORD, LATE)] });
  PAID.recordPaid({ pr: 7, head: OLD, files: 3 }, w.deps);
  PAID.recordPaid({ pr: 8, head: HEAD, files: 3 }, w.deps);
  assert.deepEqual(verb(w), { head: HEAD, ids: [41] });
  w.done();
});

test('UL3: a plain "@coderabbitai review" gives nothing', () => {
  const w = world({ comments: [human(41, '@coderabbitai review', LATE), human(42, 'please use credits for this', LATE)] });
  assert.deepEqual(verb(w), { head: HEAD, ids: [] });
  w.done();
});

test('UL4: a paid comment made before the head commit (an older head) gives nothing; one after it gives its id', () => {
  const w = world({ comments: [human(41, PAID_WORD, EARLY), human(42, PAID_WORD, LATE)] });
  assert.deepEqual(verb(w), { head: HEAD, ids: [42] });
  w.done();
});

test('UL5: a failed read, a bad head and a bad ledger give { head: "", ids: [] } or no flag, and never throw', () => {
  const down = world({ comments: [human(41, PAID_WORD, LATE)], down: true });
  assert.deepEqual(verb(down), { head: '', ids: [] });
  const noHead = world({ comments: [human(41, PAID_WORD, LATE)], headBody: { head: { sha: 'zzz' } } });
  assert.deepEqual(verb(noHead), { head: '', ids: [] });
  const badLedger = world({ comments: [human(41, PAID_WORD, LATE)] });
  writeFileSync(badLedger.ledgerPath, 'not json\n');
  assert.deepEqual(verb(badLedger), { head: HEAD, ids: [] }, 'an unreadable ledger says nothing');
  [down, noHead, badLedger].forEach((x) => x.done());
});

test('UL6: the verb takes --pr N and --json only', () => {
  assert.deepEqual(PAID.parseArgs(['unledgered', '--pr', '7', '--json']).pr, 7);
  assert.equal(PAID.parseArgs(['unledgered', '--pr', '7']).cmd, 'unledgered');
  for (const argv of [
    ['unledgered'], ['unledgered', '--json'], ['unledgered', '--pr', '7', '--repo', 'a/b'], ['unledgered', '--pr', '7', '--head', HEAD],
    ['unledgered', '--pr', '7', '--files', '3'], ['unledgered', '--pr', '7', '--cap', '5'], ['unledgered', '--pr', '0'], ['unledgered', '--pr', '7', 'extra'],
  ]) assert.throws(() => PAID.parseArgs(argv), Error, argv.join(' '));
});

test('UL7: unledgeredPaidOf is the one rule: a head commit date it cannot read keeps every paid comment', () => {
  const w = world();
  const comments = [human(41, PAID_WORD, EARLY), human(42, '@coderabbitai review', LATE)];
  assert.deepEqual(PAID.unledgeredPaidOf(7, HEAD, comments, undefined, w.deps), [41]);
  assert.deepEqual(PAID.unledgeredPaidOf(7, HEAD, comments, COMMITTED, w.deps), []);
  w.done();
});
