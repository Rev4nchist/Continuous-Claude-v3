// Failure modes of dispositions.mjs (lane re-dispositions). All values are made up: PR numbers from 90001, small ids, no real text.
//  F1  a paged result is not flattened               -> take pages[0] only in ghList use
//  F2  a page that is not an array passes            -> drop the shape check in pagedRows
//  F3  a gh error writes a file or kills an old one  -> write before the sweep ends, or write over --out on failure
//  F4  a gh error in the middle leaves a file        -> write the summary before the comments call
//  F6  a deleted user (null, ghost) gives a signal   -> drop the unknown arm in authorKind
//  F7  login variants count as CodeRabbit or trusted -> match the login without the type check
//  F8  the bot's own "Fixed in <sha>" decides        -> let authorKind cr count as trusted
//  F9  hex-only words or digit-only runs pass as SHA -> drop a SHA lookahead (digit or a-f letter)
//  F10 conflicting thumbs label                      -> label when both counts are above 0
//  F11 any thumbs give a disposition                 -> map thumbs_down_unverified to wrong
//  F12 a marker loses to a thumbs-down               -> check thumbs before the marker
//  F13 a marker beats a human reply                  -> check the marker before the trusted replies
//  F14 the oldest or last-in-array reply wins        -> sort by array order, or drop the (created_at, id) sort
//  F15 an untrusted human reply labels               -> treat every human as trusted
//  F16 quoted or fenced text is read                 -> drop the quote and fence filter in cleanReply
//  F17 "won't fix" (or a curly apostrophe) is fixed  -> drop the apostrophe fold or the neg_fix rule
//  F18 an outdated thread gets a label               -> let line == null decide
//  F19 an open finding turns negative                -> map no_signal to a disposition
//  F20 unmerged PRs count in the denominator         -> drop the merged_at filter
//  F21 an open PR moves the default --to             -> take the highest number of any state
//  F22 comments outside the range stay              -> drop the range filter; since from the wrong PR
//  F23 a comment on an unlisted PR vanishes          -> drop the pr_unknown branch
//  F24 an orphan bot reply counts as parsed          -> count every bot reply as parsed
//  F25 a root with no commit counts as parsed        -> drop the 40-hex check in isRootShape
//  F26 non-ASCII text or a zero-width char breaks    -> drop the zero-width strip in cleanReply
//  F27 a 1 MB body hangs                             -> add a nested quantifier to a rule or the marker
//  F28 zero comments pass                            -> let share null count as met
//  F29 a share below the bar passes                  -> compare with > 0 and not with BAR
//  F30 a replied finding with no match is lost       -> drop the reply_unmatched branch
//  F31 the summary leaks ids or the findings         -> spread the file into the summary
//  F32 a verdict outside VERDICTS                    -> change a VERDICT_OF value
//  F33 no arguments run a sweep or make a gh call    -> default the command to sweep; broken entry guard
//  F34 a bad flag reaches gh                         -> drop a check in parseArgs
//  F35 the clock is read outside main                -> call Date.now in summarize or sweep
//  F36 findings follow the input order               -> drop the sort in findingsForPr
//  Seat contract (2026-11-11)
//  S1  the marker counts as a human fix              -> tally fixedHuman by disposition only
//  S2  a rule change keeps the old rulesVersion      -> hash the rule ids only
//  S3  the full file lands in another state folder   -> change the default folder name
//  Reviewer blockers (every one has a test below)
//  B1  a thumbs reaction labels                      -> return wrong for a thumbs-down only
//  B2  "Fixed the incorrect check" is wrong          -> restore the bare word incorrect in the wrong rule
//  B3  "not fixed yet" is wont_fix, "will be addressed later" is fixed -> restore the not-fixed arm; drop the guard in fixHit
//  B4  an all-digit token is a SHA                   -> drop the digit-and-letter lookaheads
//  B5  --out under the repo is written               -> drop outRefused
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BAR, BY, REPLY_RULES, RULES_VERSION, SweepError, VERDICT_OF, authorKind, cleanReply, decide, findSha, findingsForPr, gateOf, main, parseMarker,
  parseReply, prOf, rulesVersionOf, summarize, sweep, thumbsOf, trustedSet, verdictOf,
} from './dispositions.mjs';
import { VERDICTS } from './labels.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(HERE, 'dispositions.mjs');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const REPO = 'acme/widgets';
const CR = { login: 'coderabbitai[bot]', type: 'Bot' };
const OWNER = { login: 'acme', type: 'User' };
const DEV = { login: 'pat', type: 'User' };
const STRANGER = { login: 'stranger', type: 'User' };
const OTHER_BOT = { login: 'github-actions[bot]', type: 'Bot' };
const TRUSTED = new Set(['acme', 'pat']);
const sha = (c) => c.repeat(40);
const LONG_SHA = '1'.concat('a'.repeat(39));

const pullUrl = (pr) => `https://api.github.com/repos/${REPO}/pulls/${pr}`;
const root = ({ id, pr = 90001, body = '**\u{1F7E0} Major**\n\nmade-up finding', reactions, line = 5, user = CR, file = 'src/a.js', commit = sha('c'), ...rest }) => ({
  id, pull_request_url: pullUrl(pr), in_reply_to_id: null, user, body, path: file, line, original_line: 7, original_commit_id: commit, reactions, created_at: '2026-01-01T00:00:00Z', ...rest,
});
const reply = ({ id, pr = 90001, to, user = OWNER, body, at = '2026-01-02T00:00:00Z', assoc = 'NONE' }) => ({
  id, pull_request_url: pullUrl(pr), in_reply_to_id: to, user, body, created_at: at, author_association: assoc,
});
const prRow = (n, { merged = true, created = '2026-01-01T00:00:00Z', author = 'pat' } = {}) => ({
  id: n + 5000, number: n, state: merged ? 'closed' : 'open', merged_at: merged ? '2026-01-03T00:00:00Z' : null, created_at: created, user: { login: author },
});

function makeGh({ prs = [], comments = [], prPages, commentPages, failOn, failMessage = 'API rate limit exceeded' } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    const route = args.find((a) => /^repos\//.test(a));
    if (/\/pulls\?state=all/.test(route)) {
      if (failOn === 'prs') throw new Error(failMessage);
      return prPages ?? [prs];
    }
    if (/\/pulls\/comments\?/.test(route)) {
      if (failOn === 'comments') throw new Error(failMessage);
      return commentPages ?? [comments];
    }
    throw new Error(`no route ${route}`);
  };
  gh.calls = calls;
  return gh;
}

const temps = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(process.env.REVIEW_EVAL_TMP || os.tmpdir(), 'dispositions-'));
  temps.push(dir);
  return dir;
};
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const NOW = new Date(2026, 10, 11, 12, 0, 0).getTime();
async function run(argv, { gh, home = tmp(), now = NOW } = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, { gh, homedir: home, now: () => now, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, out, err, home };
}
const walk = (dir) => readdirSync(dir, { recursive: true });

// One merged PR with a mix of findings. 7 CodeRabbit roots, 1 CodeRabbit reply, 1 human root.
const STD_COMMENTS = [
  root({ id: 31001 }),
  reply({ id: 32001, to: 31001, body: 'Fixed in a1b2c3d' }),
  reply({ id: 32002, to: 31001, user: CR, body: 'Thanks for the update' }),
  root({ id: 31002 }),
  reply({ id: 32003, to: 31002, body: 'False positive' }),
  root({ id: 31003, body: '**\u{1F7E0} Major**\n\nmade-up finding\n\nAddressed in commit b2c3d4e' }),
  root({ id: 31004 }),
  root({ id: 31005, reactions: { '-1': 1 } }),
  root({ id: 31006 }),
  reply({ id: 32004, to: 31006, body: 'Thanks, will look' }),
  root({ id: 31007 }),
  reply({ id: 32005, to: 31007, body: 'Fixed; follow-up for the rest' }),
  root({ id: 31008, user: DEV, body: 'a human note' }),
];
const stdGh = () => makeGh({ prs: [prRow(90001)], comments: STD_COMMENTS });

describe('reply rules', () => {
  test('F9 hex-only words are no SHA', () => {
    // Breaks when: the digit lookahead is dropped from the SHA token.
    for (const w of ['facade', 'deadbeef', 'decade', 'abcdefab', 'fixed in deadbeef']) assert.equal(findSha(w), null, w);
  });

  test('B4 an all-digit token is no SHA (a number, a comment id, a date)', () => {
    // Breaks when: the a-f letter lookahead is dropped from the SHA token.
    for (const w of ['1234567', '1234567890', '20261111', 'Fixed in 1234567', 'id 9876543210 here']) assert.equal(findSha(w), null, w);
  });

  test('F9 a SHA needs 7 to 40 hex characters with clean edges', () => {
    // Breaks when: the length bounds or the (?![0-9a-z]) edge change.
    assert.equal(findSha('abc123'), null);
    assert.equal(findSha('1a'.repeat(20).concat('1')), null);
    assert.equal(findSha('a1b2c3dz'), null);
    assert.equal(findSha('Fixed in `a1b2c3d`'), 'a1b2c3d');
    assert.equal(findSha('Fixed in A1B2C3D.'), 'a1b2c3d');
    assert.equal(findSha(LONG_SHA), LONG_SHA);
  });

  test('F9 "Fixed the facade" is fixed with no SHA; "Fixed in `a1b2c3d`" carries it', () => {
    // Breaks when: a hex-only word is read as a SHA, or the SHA is not captured.
    assert.deepEqual(parseReply('Fixed the facade'), { disposition: 'fixed', evidence: 'reply_no_sha', rule: 'fix_word', sha: null });
    assert.deepEqual(parseReply('Fixed in `a1b2c3d`'), { disposition: 'fixed', evidence: 'reply_sha', rule: 'fix_sha', sha: 'a1b2c3d' });
    assert.equal(parseReply('Fixed in 1234567').sha, null);
  });

  test('F17 "won\'t fix" is wont_fix, also with a curly apostrophe and a zero-width char', () => {
    // Breaks when: the apostrophe fold or the zero-width strip is dropped, or neg_fix loses to fix_word.
    for (const t of ["won't fix", 'won\u2019t fix', 'Won\u200B\u2019t fix this', 'wontfix', 'will not fix it', "I'm not going to change it"]) {
      const p = parseReply(t);
      assert.equal(p.disposition, 'wont_fix', t);
      assert.equal(p.evidence, 'reply_wont_fix', t);
    }
  });

  for (const phrase of ['not fixed yet, next push', 'will be addressed later', "can't be fixed", 'Is this fixed?', "won't be fixed", "isn't fixed", "hasn't been addressed", 'to be resolved soon', 'not fixed in a1b2c3d', 'will be fixed in a1b2c3d']) {
    test(`B3 "${phrase}" gives no label`, () => {
      // Breaks when: the modal, negation or question guard is dropped from fixHit, or a not-fixed arm returns to neg_fix.
      assert.equal(parseReply(phrase), null);
    });
  }

  test('B3 a fix word after sentence punctuation is not blocked by an earlier modal', () => {
    // Breaks when: the guard window ignores sentence punctuation.
    assert.equal(parseReply('Should have caught that. Fixed.').disposition, 'fixed');
    assert.equal(parseReply('Is this fixed?\nFixed in a1b2c3d').evidence, 'reply_sha');
  });

  for (const t of ['Fixed the incorrect check', 'Fixed the invalid input path', 'Addressed the misread', 'Done, the already handled case too', 'Fixed what does not apply']) {
    test(`B2 "${t}" is fixed`, () => {
      // Breaks when: a bare incorrect, invalid, misread, already handled or does-not-apply word returns to the wrong rule.
      const p = parseReply(t);
      assert.equal(p.disposition, 'fixed');
      assert.equal(p.evidence, 'reply_no_sha');
    });
  }

  test('B2 a bare negative word with no fix word gives no label', () => {
    // Breaks when: the wrong rule matches a bare word again.
    for (const t of ['incorrect', 'invalid', 'misread', 'already handled', 'invalid input path']) assert.equal(parseReply(t), null, t);
  });

  test('wrong rule: tied to the finding', () => {
    // Breaks when: a wrong pattern is removed or loses its anchor.
    for (const t of ['False positive.', 'This is incorrect', 'the finding was invalid', 'It does not apply here', 'Not applicable', "that doesn't apply", 'this is not a bug']) {
      assert.deepEqual([parseReply(t).disposition, parseReply(t).evidence], ['wrong', 'reply_wrong'], t);
    }
  });

  test('decline rule: wont_fix with reply_decline', () => {
    // Breaks when: a decline pattern is removed, or decline maps to wrong.
    for (const t of ['Out of scope for this PR', 'By design', 'Intentionally left', 'Deferred', 'Will do a follow-up', 'a separate PR', 'Keeping it as is']) {
      const p = parseReply(t);
      assert.deepEqual([p.disposition, p.evidence], ['wont_fix', 'reply_decline'], t);
    }
  });

  test('B2 a fix word plus a negative rule gives unlabeled reply_conflict', () => {
    // Breaks when: the conflict branch in parseReply is dropped (the first rule would win).
    for (const t of ['Fixed; follow-up for the rest', 'Fixed in a1b2c3d, the rest is out of scope', 'Fixed, but this is a false positive', "Done. Won't fix the other one"]) {
      assert.deepEqual(parseReply(t), { disposition: 'unlabeled', evidence: null, rule: 'reply_conflict', sha: null }, t);
    }
  });

  test('F16 quoted lines and fenced blocks are not read', () => {
    // Breaks when: cleanReply keeps quoted lines or fenced code.
    assert.equal(parseReply("> won't fix\nFixed in a1b2c3d").disposition, 'fixed');
    assert.equal(parseReply("```\nwon't fix\n```\nFixed in a1b2c3d").evidence, 'reply_sha');
    assert.equal(parseReply("> Fixed in a1b2c3d\nwhy?"), null);
    assert.equal(cleanReply('a\n> b\n```\nc\n```\nd'), 'a\nd');
  });

  test('F26 non-ASCII text and a zero-width char still parse', () => {
    // Breaks when: the zero-width strip is dropped, or a rule needs an ASCII word edge next to a symbol.
    assert.equal(parseReply('Fi\u200Bxed').disposition, 'fixed');
    assert.equal(parseReply('\u{1F389} fixed in a1b2c3d \u2705').sha, 'a1b2c3d');
    assert.equal(parseReply('\u5DF2\u4FEE\u590D fixed in a1b2c3d').evidence, 'reply_sha');
    assert.equal(parseReply('R\u00E9gl\u00E9 : fixed').disposition, 'fixed');
    assert.equal(parseReply('Fixed in\u00A0a1b2c3d').sha, 'a1b2c3d');
  });

  test('F27 a 1 MB reply does not hang', () => {
    // Breaks when: a rule gets a nested quantifier or the guard scans the whole prefix for each fix word.
    const bodies = ['fixed '.repeat(180000), `fixed ${'deadbeef '.repeat(120000)}`, `${'a'.repeat(1_000_000)} fixed`, 'x\n'.repeat(500000), `${' '.repeat(1_000_000)}Addressed`];
    for (const b of bodies) {
      const t0 = Date.now();
      parseReply(b);
      assert.ok(Date.now() - t0 < 5000, `slow on a ${b.length} char body`);
    }
  });

  test('REPLY_RULES is frozen, in the fixed order', () => {
    // Breaks when: the array or a rule is left mutable, or the order changes (the freeze is the holdout guard).
    assert.ok(Object.isFrozen(REPLY_RULES));
    assert.ok(REPLY_RULES.every((r) => Object.isFrozen(r)));
    assert.deepEqual(REPLY_RULES.map((r) => r.id), ['neg_fix', 'fix_sha', 'wrong', 'decline', 'fix_word']);
  });

  test('parseReply on empty or non-string input is null and never throws', () => {
    // Breaks when: cleanReply or parseReply assumes a string.
    for (const v of [undefined, null, '', '   ', 42, {}]) assert.equal(parseReply(v), null);
  });
});

describe('marker and sha', () => {
  test('F9 the marker returns the SHA; "a to b" returns b; the last marker wins', () => {
    // Breaks when: the first match or the first SHA is returned.
    assert.equal(parseMarker('Addressed in commit a1b2c3d'), 'a1b2c3d');
    assert.equal(parseMarker('Addressed in commits `a1b2c3d` to `b2c3d4e`'), 'b2c3d4e');
    assert.equal(parseMarker('Addressed in commit a1b2c3d\n\nlater\n\nAddressed in commit c3d4e5f6'), 'c3d4e5f6');
    assert.equal(parseMarker('x'), null);
    assert.equal(parseMarker(undefined), null);
  });

  test('F9 a hex-only or digit-only token is no marker', () => {
    // Breaks when: the marker SHA skips the SHA-token rule.
    for (const b of ['Addressed in commit deadbeef', 'Addressed in commit 1234567', 'Addressed in commit a1b2c3', `Addressed in commit ${'1a'.repeat(20)}1`]) assert.equal(parseMarker(b), null, b);
  });

  test('F27 a 1 MB root body with the marker at the end is found in time', () => {
    // Breaks when: the marker regex goes quadratic.
    const body = `${'filler line with words\n'.repeat(45000)}Addressed in commit a1b2c3d`;
    const t0 = Date.now();
    assert.equal(parseMarker(body), 'a1b2c3d');
    assert.ok(Date.now() - t0 < 5000);
    const spaces = `Addressed in commit ${' '.repeat(1_000_000)}`;
    const t1 = Date.now();
    assert.equal(parseMarker(spaces), null);
    assert.ok(Date.now() - t1 < 5000);
  });
});

describe('authors and trust', () => {
  test('F6 F7 authorKind', () => {
    // Breaks when: the unknown arm, the type check on CodeRabbit, or the bot arm is dropped.
    assert.equal(authorKind(null, TRUSTED), 'unknown');
    assert.equal(authorKind({ login: 'ghost', type: 'User' }, TRUSTED), 'unknown');
    assert.equal(authorKind({ type: 'User' }, TRUSTED), 'unknown');
    assert.equal(authorKind(CR, TRUSTED), 'cr');
    assert.equal(authorKind({ login: 'coderabbitai[bot]', type: 'User' }, TRUSTED), 'bot');
    assert.equal(authorKind(OTHER_BOT, TRUSTED), 'bot');
    assert.equal(authorKind({ login: 'Acme', type: 'User' }, TRUSTED), 'trusted');
    assert.equal(authorKind(STRANGER, TRUSTED), 'human');
  });

  test('trustedSet: owner, PR author, and OWNER MEMBER COLLABORATOR commenters, lowercase', () => {
    // Breaks when: an association is added or dropped, or logins keep their case.
    const comments = [
      { user: { login: 'Helper' }, author_association: 'MEMBER' }, { user: { login: 'Boss' }, author_association: 'OWNER' },
      { user: { login: 'Friend' }, author_association: 'COLLABORATOR' }, { user: { login: 'Drive' }, author_association: 'CONTRIBUTOR' },
      { user: { login: 'Rando' }, author_association: 'NONE' }, { user: null, author_association: 'OWNER' },
    ];
    assert.deepEqual([...trustedSet({ repo: 'Acme/widgets', prAuthor: 'Pat', comments })].sort(), ['acme', 'boss', 'friend', 'helper', 'pat']);
    assert.deepEqual([...trustedSet({ repo: REPO })], ['acme']);
  });

  test('thumbsOf reads the rollup as integers; missing or odd values are 0', () => {
    // Breaks when: a string or negative count passes, or a missing field throws.
    assert.deepEqual(thumbsOf({ '+1': 2, '-1': 1 }), { up: 2, down: 1 });
    assert.deepEqual(thumbsOf(undefined), { up: 0, down: 0 });
    assert.deepEqual(thumbsOf({ '+1': '3', '-1': -2 }), { up: 0, down: 0 });
  });

  test('prOf reads the PR number from pull_request_url', () => {
    // Breaks when: the pattern is not anchored on /pulls/<n> at the end.
    assert.equal(prOf({ pull_request_url: pullUrl(90007) }), 90007);
    assert.equal(prOf({ pull_request_url: `${pullUrl(90007)}/comments` }), null);
    assert.equal(prOf({}), null);
    assert.equal(prOf(null), null);
  });
});

describe('decide table', () => {
  const decideOf = (replies, rootOver = {}) => decide({ root: root({ id: 1, ...rootOver }), replies: replies.map((r) => ({ ...r, to: 1 })), trusted: TRUSTED });

  test('R1 a trusted reply decides, with its SHA and id', () => {
    // Breaks when: replyId or sha is not carried.
    const d = decide({ root: root({ id: 1 }), replies: [reply({ id: 9, to: 1, body: 'Fixed in a1b2c3d' })], trusted: TRUSTED });
    assert.deepEqual(d, { disposition: 'fixed', evidence: 'reply_sha', reason: null, rule: 'fix_sha', sha: 'a1b2c3d', replyId: 9 });
  });

  test('F13 a human reply beats the marker; the marker SHA fills a missing reply SHA', () => {
    // Breaks when: the marker is checked before the trusted replies.
    const body = 'finding\nAddressed in commit b2c3d4e';
    const wrong = decide({ root: root({ id: 1, body }), replies: [reply({ id: 9, to: 1, body: 'False positive' })], trusted: TRUSTED });
    assert.deepEqual([wrong.disposition, wrong.evidence], ['wrong', 'reply_wrong']);
    const noSha = decide({ root: root({ id: 1, body }), replies: [reply({ id: 9, to: 1, body: 'Fixed' })], trusted: TRUSTED });
    assert.deepEqual([noSha.evidence, noSha.sha], ['reply_no_sha', 'b2c3d4e']);
  });

  test('F14 the latest matched reply wins, by created_at then id, not array order', () => {
    // Breaks when: replies are read in array order or the (created_at, id) sort is dropped.
    const early = reply({ id: 50, to: 1, body: "Won't fix", at: '2026-01-02T00:00:00Z' });
    const late = reply({ id: 40, to: 1, body: 'Fixed in a1b2c3d', at: '2026-01-03T00:00:00Z' });
    assert.equal(decide({ root: root({ id: 1 }), replies: [late, early], trusted: TRUSTED }).evidence, 'reply_sha');
    assert.equal(decide({ root: root({ id: 1 }), replies: [early, late], trusted: TRUSTED }).evidence, 'reply_sha');
    const sameTimeLow = reply({ id: 41, to: 1, body: "Won't fix", at: '2026-01-03T00:00:00Z' });
    assert.equal(decide({ root: root({ id: 1 }), replies: [sameTimeLow, late], trusted: TRUSTED }).evidence, 'reply_wont_fix');
  });

  test('F14 a later unmatched reply does not erase an earlier match', () => {
    // Breaks when: the last reply decides even when it has no match.
    const d = decideOf([reply({ id: 1, body: 'False positive', at: '2026-01-02T00:00:00Z' }), reply({ id: 2, body: 'Thanks!', at: '2026-01-03T00:00:00Z' })]);
    assert.deepEqual([d.disposition, d.replyId], ['wrong', 1]);
  });

  test('F15 an untrusted human reply is no signal', () => {
    // Breaks when: every human counts as trusted.
    const d = decideOf([reply({ id: 1, user: STRANGER, body: 'False positive' })]);
    assert.deepEqual([d.disposition, d.reason, d.replyId], ['unlabeled', 'no_signal', null]);
  });

  test('F6 F7 F8 deleted users, other bots and the bot itself never decide', () => {
    // Breaks when: authorKind lets unknown, bot or cr replies count as trusted.
    for (const user of [null, { login: 'ghost', type: 'User' }, OTHER_BOT, CR]) {
      const d = decideOf([reply({ id: 1, user, body: 'Fixed in a1b2c3d' })]);
      assert.deepEqual([d.disposition, d.reason], ['unlabeled', 'no_signal'], String(user?.login));
    }
  });

  test('R2 the marker alone gives fixed with cr_marker and its SHA', () => {
    // Breaks when: the marker arm is dropped.
    const d = decide({ root: root({ id: 1, body: 'x\nAddressed in commit a1b2c3d' }), replies: [], trusted: TRUSTED });
    assert.deepEqual(d, { disposition: 'fixed', evidence: 'cr_marker', reason: null, rule: null, sha: 'a1b2c3d', replyId: null });
  });

  test('R2 an unmatched trusted reply does not hide the marker', () => {
    // Breaks when: reply_unmatched is checked before the marker.
    const d = decide({ root: root({ id: 1, body: 'x\nAddressed in commit a1b2c3d' }), replies: [reply({ id: 9, to: 1, body: 'Thanks' })], trusted: TRUSTED });
    assert.deepEqual([d.disposition, d.evidence], ['fixed', 'cr_marker']);
  });

  test('B2 a conflict reply decides: it beats the marker and an earlier clean match', () => {
    // Breaks when: a conflict reply is skipped like an unmatched one.
    const body = 'x\nAddressed in commit a1b2c3d';
    const conflict = reply({ id: 9, to: 1, body: 'Fixed; follow-up for the rest', at: '2026-01-04T00:00:00Z' });
    const clean = reply({ id: 8, to: 1, body: 'Fixed in b2c3d4e', at: '2026-01-03T00:00:00Z' });
    const d = decide({ root: root({ id: 1, body }), replies: [clean, conflict], trusted: TRUSTED });
    assert.deepEqual([d.disposition, d.evidence, d.reason, d.replyId], ['unlabeled', null, 'reply_conflict', 9]);
  });

  test('F30 R4 a replied finding with no match is unlabeled reply_unmatched', () => {
    // Breaks when: the reply_unmatched branch is dropped (the reason would be no_signal).
    const d = decideOf([reply({ id: 1, body: 'Thanks for the review' })]);
    assert.deepEqual([d.disposition, d.reason], ['unlabeled', 'reply_unmatched']);
  });

  test('B3 "not fixed yet" is unlabeled, never wont_fix', () => {
    // Breaks when: a not-fixed arm returns to the negative rule.
    const d = decideOf([reply({ id: 1, body: 'not fixed yet' })]);
    assert.deepEqual([d.disposition, d.reason], ['unlabeled', 'reply_unmatched']);
  });

  test('B1 F11 thumbs never give a disposition', () => {
    // Breaks when: any thumbs count maps to wrong, fixed or wont_fix.
    for (const up of [0, 1, 3]) {
      for (const down of [0, 1, 4]) {
        const d = decideOf([], { reactions: { '+1': up, '-1': down } });
        assert.equal(d.disposition, 'unlabeled', `up ${up} down ${down}`);
        assert.equal(d.evidence, null);
      }
    }
  });

  test('B1 F10 F11 the thumbs reasons', () => {
    // Breaks when: a reason is swapped or the unverified thumbs-down becomes a label.
    assert.equal(decideOf([], { reactions: { '-1': 1 } }).reason, 'thumbs_down_unverified');
    assert.equal(decideOf([], { reactions: { '+1': 2 } }).reason, 'thumbs_up_only');
    assert.equal(decideOf([], { reactions: { '+1': 1, '-1': 1 } }).reason, 'thumbs_conflict');
  });

  test('F12 a marker beats a thumbs-down', () => {
    // Breaks when: thumbs are checked before the marker.
    const d = decideOf([], { body: 'x\nAddressed in commit a1b2c3d', reactions: { '-1': 2 } });
    assert.deepEqual([d.disposition, d.evidence], ['fixed', 'cr_marker']);
  });

  test('F18 F19 an outdated or open finding with no signal stays unlabeled no_signal', () => {
    // Breaks when: the outdated flag or an open state decides a label.
    for (const over of [{ line: null }, {}]) {
      const d = decideOf([], over);
      assert.deepEqual([d.disposition, d.evidence, d.reason, d.rule, d.sha, d.replyId], ['unlabeled', null, 'no_signal', null, null, null]);
    }
  });
});

describe('findingsForPr', () => {
  const one = (comments, prFact = { author: 'pat' }) => findingsForPr({ pr: 90001, comments, prFact, repo: REPO });

  test('a record holds the fields, the key and the verdict; no body text', () => {
    // Breaks when: a field is renamed or dropped, or body text is copied into the record.
    const out = one([root({ id: 31001 }), reply({ id: 32001, to: 31001, body: 'Fixed in a1b2c3d' }), reply({ id: 32002, to: 31001, user: CR, body: 'bot words' })]);
    assert.equal(out.records.length, 1);
    assert.deepEqual(out.records[0], {
      key: '90001:31001', pr: 90001, commentId: 31001, path: 'src/a.js', line: 7, originalCommit: sha('c'), severity: 'major', disposition: 'fixed', verdict: 'real',
      by: BY, evidence: 'reply_sha', reason: null, rule: 'fix_sha', sha: 'a1b2c3d', replyId: 32001, thumbs: { up: 0, down: 0 },
      replies: { trusted: 1, human: 0, bot: 0, unknown: 0, cr: 1 }, outdated: false, parsed: true,
    });
    const text = JSON.stringify(out);
    for (const bad of ['made-up finding', 'Fixed in a1b2c3d', 'bot words']) assert.ok(!text.includes(bad), bad);
    assert.deepEqual(out.botReplies, { all: 1, parsed: 1 });
  });

  test('the verdict follows the disposition; cr_marker and unlabeled have none', () => {
    // Breaks when: VERDICT_OF is changed, or a marker maps to real.
    const out = one([
      root({ id: 1 }), reply({ id: 11, to: 1, body: 'Fixed' }), root({ id: 2 }), reply({ id: 12, to: 2, body: 'False positive' }), root({ id: 3 }), reply({ id: 13, to: 3, body: 'By design' }),
      root({ id: 4, body: 'x\nAddressed in commit a1b2c3d' }), root({ id: 5 }),
    ]);
    assert.deepEqual(out.records.map((r) => [r.disposition, r.verdict, r.by]), [
      ['fixed', 'real', BY], ['wrong', 'noise', BY], ['wont_fix', 'unclear', BY], ['fixed', null, BY], ['unlabeled', null, BY],
    ]);
  });

  test('B13 outdated reads the raw line field; line is the original line', () => {
    // Breaks when: outdated tests original_line, or line reads the raw line.
    const [r] = one([root({ id: 1, line: null })]).records;
    assert.equal(r.outdated, true);
    assert.equal(r.line, 7);
    assert.equal(r.reason, 'no_signal');
    assert.equal(one([root({ id: 1, line: 3 })]).records[0].outdated, false);
  });

  test('F7 a bot-named login with type User, and other bots, are not findings', () => {
    // Breaks when: the CodeRabbit check drops the type test.
    const out = one([root({ id: 1, user: { login: 'coderabbitai[bot]', type: 'User' } }), root({ id: 2, user: OTHER_BOT })]);
    assert.deepEqual([out.records.length, out.unparsed.length, out.botReplies.all], [0, 0, 0]);
  });

  test('F24 an orphan bot reply is unparsed and not parsed', () => {
    // Breaks when: every bot reply counts as parsed.
    const out = one([root({ id: 1 }), reply({ id: 11, to: 1, user: CR, body: 'ok' }), reply({ id: 12, to: 999, user: CR, body: 'lost' })]);
    assert.deepEqual(out.botReplies, { all: 2, parsed: 1 });
    assert.deepEqual(out.unparsed.map((u) => [u.key, u.reason]), [['90001:12', 'orphan_reply']]);
  });

  test('F25 a root with a bad shape is unparsed bad_shape and has no record', () => {
    // Breaks when: the 40-hex commit, the path or the integer id check is dropped.
    const bad = [
      root({ id: 1, commit: null }), root({ id: 2, commit: 'abc' }), root({ id: 3, commit: sha('z') }), root({ id: 4, file: '' }), root({ id: 5, file: null }),
      root({ id: '6' }),
    ];
    const out = one([...bad, root({ id: 7 })]);
    assert.deepEqual(out.records.map((r) => r.commentId), [7]);
    assert.equal(out.unparsed.length, 6);
    assert.ok(out.unparsed.every((u) => u.reason === 'bad_shape' && u.kind === 'root'));
  });

  test('F36 records are sorted by comment id, whatever the input order', () => {
    // Breaks when: the sort is dropped.
    const out = one([root({ id: 31 }), root({ id: 4 }), root({ id: 12 })]);
    assert.deepEqual(out.records.map((r) => r.commentId), [4, 12, 31]);
  });

  test('the reply counts split by author kind; the PR author is trusted', () => {
    // Breaks when: a kind is counted in the wrong bucket.
    const out = one([
      root({ id: 1 }), reply({ id: 11, to: 1, user: DEV, body: 'hm' }), reply({ id: 12, to: 1, user: STRANGER, body: 'hm' }), reply({ id: 13, to: 1, user: OTHER_BOT, body: 'hm' }),
      reply({ id: 14, to: 1, user: null, body: 'hm' }), reply({ id: 15, to: 1, user: CR, body: 'hm' }),
    ]);
    assert.deepEqual(out.records[0].replies, { trusted: 1, human: 1, bot: 1, unknown: 1, cr: 1 });
  });

  test('a reply from another PR thread id is not attached', () => {
    // Breaks when: replies are grouped by anything but in_reply_to_id.
    const out = one([root({ id: 1 }), root({ id: 2 }), reply({ id: 11, to: 2, body: 'False positive' })]);
    assert.deepEqual(out.records.map((r) => r.disposition), ['unlabeled', 'wrong']);
  });
});

describe('summarize', () => {
  const std = () => findingsForPr({ pr: 90001, comments: STD_COMMENTS, prFact: { author: 'pat' }, repo: REPO });
  const sumOf = (over = {}) => {
    const f = std();
    return summarize({ records: f.records, unparsed: f.unparsed, botReplies: f.botReplies, excluded: { unmergedPrs: 0, unmergedComments: 0 }, range: { from: 90000, to: 90001 }, repo: REPO, generatedAt: 'T', ...over });
  };

  test('the counts, evidence, reasons and the replied numbers on a mixed PR', () => {
    // Breaks when: a tally reads the wrong field or a branch of decide changes.
    const s = sumOf();
    assert.deepEqual(s.denominator, { rule: 'REST pulls/comments by coderabbitai[bot] (type Bot) on merged PRs in range; review-body findings are outside pulls/comments', all: 8, roots: 7, replies: 1 });
    assert.deepEqual(s.counts, { fixed: 2, fixedHuman: 1, fixedMarker: 1, wont_fix: 0, wrong: 1, unlabeled: 4 });
    assert.deepEqual(s.evidence, { reply_wont_fix: 0, reply_sha: 1, reply_wrong: 1, reply_decline: 0, reply_no_sha: 0, cr_marker: 1 });
    assert.deepEqual(s.reasons, { reply_unmatched: 1, reply_conflict: 1, thumbs_up_only: 0, thumbs_down_unverified: 1, thumbs_conflict: 0, no_signal: 1 });
    assert.deepEqual(s.replied, { findings: 4, anyReply: 4, labeled: 2, unlabeled: 2, share: 0.5 });
    assert.deepEqual(s.labeled, { count: 3, share: 3 / 7 });
    assert.deepEqual(s.parsed, { all: 8, roots: 7, replies: 1, share: 1, rootShare: 1, bar: BAR, met: true });
  });

  test('S1 counts.fixed splits into a human part and a marker part, and a marker record has no verdict', () => {
    // Breaks when: fixedMarker counts by disposition and not by the cr_marker evidence, or a marker record gets a verdict.
    const s = sumOf();
    assert.equal(s.counts.fixed, s.counts.fixedHuman + s.counts.fixedMarker);
    assert.equal(s.counts.fixedMarker, s.evidence.cr_marker);
    const marked = std().records.filter((r) => r.evidence === 'cr_marker');
    assert.equal(marked.length, 1);
    assert.deepEqual(marked.map((r) => [r.disposition, r.verdict, r.by]), [['fixed', null, 'cr-disposition']]);
  });

  test('S2 rulesVersion: in the summary, stable, and changed by any change of a rule', () => {
    // Breaks when: the hash leaves out the regex source, the flags, the order, a rule field or the extra patterns.
    const base = [{ id: 'a', re: /x/i, disposition: 'fixed', evidence: 'e' }, { id: 'b', re: /y/, disposition: 'wrong', evidence: 'f' }];
    const v = rulesVersionOf(base, ['m']);
    assert.match(v, /^[0-9a-f]{16}$/);
    assert.equal(rulesVersionOf(base, ['m']), v);
    assert.notEqual(rulesVersionOf([{ ...base[0], re: /xx/i }, base[1]], ['m']), v);
    assert.notEqual(rulesVersionOf([{ ...base[0], re: /x/ }, base[1]], ['m']), v);
    assert.notEqual(rulesVersionOf([base[1], base[0]], ['m']), v);
    assert.notEqual(rulesVersionOf([{ ...base[0], disposition: 'wrong' }, base[1]], ['m']), v);
    assert.notEqual(rulesVersionOf(base, ['n']), v);
    assert.equal(sumOf().rulesVersion, RULES_VERSION);
    assert.match(RULES_VERSION, /^[0-9a-f]{16}$/);
  });

  test('replied.unlabeled equals reply_unmatched plus reply_conflict', () => {
    // Breaks when: a replied finding is unlabeled for a reason outside those two, or the replied count reads another field.
    const s = sumOf();
    assert.equal(s.replied.unlabeled, s.reasons.reply_unmatched + s.reasons.reply_conflict);
  });

  test('F28 zero comments: share null, met false, gate 3 (no vacuous pass)', () => {
    // Breaks when: a null share counts as met.
    const s = summarize({ records: [], unparsed: [], botReplies: { all: 0, parsed: 0 }, excluded: { unmergedPrs: 0, unmergedComments: 0 }, range: { from: 90000, to: null }, repo: REPO, generatedAt: 'T' });
    assert.deepEqual([s.parsed.share, s.parsed.rootShare, s.parsed.met, s.replied.share, s.labeled.share], [null, null, false, null, null]);
    assert.equal(gateOf(s), 3);
  });

  const parsedRoots = (n) => Array.from({ length: n }, (_, i) => findingsForPr({ pr: 90001, comments: [root({ id: 100 + i })], prFact: {}, repo: REPO }).records[0]);
  const badRoots = (n) => Array.from({ length: n }, (_, i) => ({ key: `90001:${900 + i}`, reason: 'bad_shape', kind: 'root' }));

  test('F29 below the bar gives gate 3; at the bar gives gate 0', () => {
    // Breaks when: the compare is > 0, or > BAR instead of >= BAR.
    const make = (good, bad) => summarize({ records: parsedRoots(good), unparsed: badRoots(bad), botReplies: { all: 0, parsed: 0 }, excluded: {}, range: { from: 90000, to: 90001 }, repo: REPO, generatedAt: 'T' });
    assert.deepEqual([make(8, 2).parsed.share, make(8, 2).parsed.met, gateOf(make(8, 2))], [0.8, false, 3]);
    assert.deepEqual([make(9, 1).parsed.share, make(9, 1).parsed.met, gateOf(make(9, 1))], [0.9, true, 0]);
  });

  test('F29 many parsed replies cannot hide a low root share', () => {
    // Breaks when: met tests share only.
    const s = summarize({ records: parsedRoots(1), unparsed: badRoots(3), botReplies: { all: 100, parsed: 100 }, excluded: {}, range: { from: 90000, to: 90001 }, repo: REPO, generatedAt: 'T' });
    assert.ok(s.parsed.share > BAR);
    assert.equal(s.parsed.rootShare, 0.25);
    assert.equal(s.parsed.met, false);
  });

  test('unparsedReasons are tallied', () => {
    // Breaks when: a reason key is dropped or misspelled.
    const s = sumOf({ unparsed: [{ key: 'a', reason: 'bad_shape', kind: 'root' }, { key: 'b', reason: 'pr_unknown', kind: 'root' }, { key: 'c', reason: 'no_pr_url', kind: 'root' }, { key: 'd', reason: 'orphan_reply', kind: 'reply' }, { key: 'e', reason: 'orphan_reply', kind: 'reply' }] });
    assert.deepEqual(s.unparsedReasons, { bad_shape: 1, orphan_reply: 2, pr_unknown: 1, no_pr_url: 1 });
  });

  test('F31 the summary has no findings, no unparsed list, no complete flag, no id', () => {
    // Breaks when: the file body is spread into the summary, or an id or key is added.
    const s = sumOf();
    for (const k of ['findings', 'unparsed', 'complete']) assert.ok(!(k in s), k);
    assert.ok(!('thumbs_down' in s.evidence));
    const text = JSON.stringify(s);
    for (const id of ['31001', '31005', '32001', '90001:']) assert.ok(!text.includes(id), id);
    assert.deepEqual([s.v, s.kind, s.repo, s.range], [1, 'cr-dispositions', REPO, { from: 90000, to: 90001 }]);
  });

  test('F35 generatedAt is the value passed in; the same input gives the same summary', () => {
    // Breaks when: summarize reads the clock.
    assert.equal(sumOf({ generatedAt: 'stamp-1' }).generatedAt, 'stamp-1');
    assert.deepEqual(sumOf(), sumOf());
  });

  test('F32 every VERDICT_OF value is a known verdict; unlabeled and cr_marker have none', () => {
    // Breaks when: a VERDICT_OF value is renamed outside VERDICTS, or cr_marker maps to a verdict.
    for (const v of Object.values(VERDICT_OF)) assert.ok(v === null || VERDICTS.includes(v), String(v));
    assert.equal(VERDICT_OF.unlabeled, null);
    assert.deepEqual(Object.keys(VERDICT_OF).sort(), ['fixed', 'unlabeled', 'wont_fix', 'wrong']);
    assert.equal(verdictOf('fixed', 'cr_marker'), null);
    assert.equal(verdictOf('fixed', 'reply_sha'), 'real');
    assert.equal(verdictOf('unlabeled', null), null);
    assert.ok(/^[a-z][a-z0-9.-]*$/.test(BY));
  });
});

describe('sweep with a stub gh', () => {
  const go = (gh, over = {}) => sweep({ from: 90000, repo: REPO, generatedAt: 'T', ...over }, { gh });

  test('F1 paged results are flattened: both pages count; two paged calls in all', async () => {
    // Breaks when: only the first page is read, or a gh call is made per PR.
    const gh = makeGh({ prs: [prRow(90001), prRow(90002)], commentPages: [[root({ id: 1 })], [root({ id: 2, pr: 90002 })]] });
    const { summary } = await go(gh);
    assert.equal(summary.denominator.roots, 2);
    assert.equal(gh.calls.length, 2);
    for (const args of gh.calls) assert.ok(!args.some((a) => /^(-X|--method|--input|-f|-F|--field|--raw-field)$/.test(a)), 'a gh call must be a read');
  });

  test('F2 a page that is not an array is a bad_shape error', async () => {
    // Breaks when: the shape check is dropped (the object would pass through as a row list).
    await assert.rejects(go(makeGh({ prs: [prRow(90001)], commentPages: [[root({ id: 1 })], { message: 'cut' }] })), (e) => e instanceof SweepError && e.kind === 'bad_shape');
    await assert.rejects(go(makeGh({ prPages: [[prRow(90001)], { message: 'cut' }] })), (e) => e.kind === 'bad_shape');
    await assert.rejects(go(makeGh({ prs: [prRow(90001)], commentPages: { message: 'x' } })), (e) => e.kind === 'bad_shape');
    await assert.rejects(go(makeGh({ prs: [prRow(90001)], comments: [{ body: 'no id' }] })), (e) => e.kind === 'bad_shape');
  });

  test('F4 a gh error in the middle is a gh_error', async () => {
    // Breaks when: a gh throw is swallowed or given another kind.
    await assert.rejects(go(makeGh({ prs: [prRow(90001)], failOn: 'comments' })), (e) => e instanceof SweepError && e.kind === 'gh_error' && /rate limit/.test(e.message));
    await assert.rejects(go(makeGh({ failOn: 'prs' })), (e) => e.kind === 'gh_error');
  });

  test('the same id on two pages is counted once', async () => {
    // Breaks when: rows are not deduplicated by id.
    const gh = makeGh({ prs: [prRow(90001)], commentPages: [[root({ id: 1 }), root({ id: 2 })], [root({ id: 2 }), root({ id: 3 })]] });
    const { summary, file } = await go(gh);
    assert.equal(summary.denominator.roots, 3);
    assert.deepEqual(file.findings.map((f) => f.commentId), [1, 2, 3]);
  });

  test('F20 unmerged PRs are excluded and counted, in range only', async () => {
    // Breaks when: the merged_at filter is dropped, or the excluded counts read the wrong list.
    const gh = makeGh({
      prs: [prRow(89990, { merged: false }), prRow(90001), prRow(90002, { merged: false }), prRow(90003)],
      comments: [root({ id: 1 }), root({ id: 2, pr: 90002 }), root({ id: 3, pr: 90002 }), root({ id: 4, pr: 90003 })],
    });
    const { summary } = await go(gh);
    assert.equal(summary.denominator.roots, 2);
    assert.deepEqual(summary.excluded, { unmergedPrs: 1, unmergedComments: 2 });
  });

  test('F21 an open PR with a higher number does not move the default to', async () => {
    // Breaks when: the default to takes the highest number of any state.
    const gh = makeGh({ prs: [prRow(90001), prRow(90002), prRow(90003, { merged: false })], comments: [root({ id: 1, pr: 90001 }), root({ id: 2, pr: 90003 })] });
    const { summary } = await go(gh);
    assert.deepEqual(summary.range, { from: 90000, to: 90002 });
    assert.equal(summary.denominator.roots, 1);
    assert.equal(summary.excluded.unmergedPrs, 0);
  });

  test('F22 comments below from or above to are dropped; since comes from the lowest PR at or above from', async () => {
    // Breaks when: the range filter is dropped, or since is read from the first PR of the list.
    const gh = makeGh({
      prs: [prRow(89990, { created: '2025-12-01T00:00:00Z' }), prRow(90001, { created: '2026-01-05T00:00:00Z' }), prRow(90003, { created: '2026-01-07T00:00:00Z' }), prRow(90004, { created: '2026-01-08T00:00:00Z' })],
      comments: [root({ id: 1, pr: 89990 }), root({ id: 2, pr: 90001 }), root({ id: 3, pr: 90003 }), root({ id: 4, pr: 90004 })],
    });
    const { summary } = await go(gh, { from: 90001, to: 90003 });
    assert.equal(summary.denominator.roots, 2);
    assert.ok(gh.calls[1].some((a) => a.includes('since=2026-01-05T00:00:00Z')));
    const gh2 = makeGh({ prs: [prRow(90001, { created: '2026-01-05T00:00:00Z' }), prRow(90003, { created: '2026-01-07T00:00:00Z' })], comments: [root({ id: 3, pr: 90003 })] });
    await go(gh2, { from: 90002 });
    assert.ok(gh2.calls[1].some((a) => a.includes('since=2026-01-07T00:00:00Z')));
  });

  test('F23 a comment on a PR missing from the PR list is unparsed pr_unknown, in the denominator', async () => {
    // Breaks when: the pr_unknown branch is dropped (the comment would vanish).
    const gh = makeGh({ prs: [prRow(90001)], comments: [root({ id: 1 }), root({ id: 2, pr: 90002 }), reply({ id: 3, pr: 90002, to: 2, user: CR, body: 'x' })] });
    const { summary, file } = await go(gh, { to: 90005 });
    assert.deepEqual([summary.denominator.roots, summary.denominator.replies, summary.denominator.all], [2, 1, 3]);
    assert.equal(summary.unparsedReasons.pr_unknown, 2);
    assert.equal(summary.parsed.met, false);
    assert.deepEqual(file.unparsed.map((u) => u.reason), ['pr_unknown', 'pr_unknown']);
    assert.ok(file.unparsed.every((u) => Object.keys(u).sort().join() === 'key,reason'));
  });

  test('a comment with no pull_request_url is unparsed no_pr_url', async () => {
    // Breaks when: a null prOf is dropped or throws.
    const stray = root({ id: 9 });
    delete stray.pull_request_url;
    const { summary, file } = await go(makeGh({ prs: [prRow(90001)], comments: [root({ id: 1 }), stray] }));
    assert.equal(summary.unparsedReasons.no_pr_url, 1);
    assert.equal(summary.denominator.roots, 2);
    assert.equal(file.unparsed[0].reason, 'no_pr_url');
  });

  test('no PR at or above from: one gh call, denominator 0, gate 3', async () => {
    // Breaks when: the comments call is made with no start point.
    const gh = makeGh({ prs: [prRow(89990)], comments: [root({ id: 1, pr: 89990 })] });
    const { summary } = await go(gh);
    assert.equal(gh.calls.length, 1);
    assert.equal(summary.denominator.all, 0);
    assert.equal(gateOf(summary), 3);
    const gh2 = makeGh({ prs: [prRow(90001)] });
    const out = await go(gh2, { from: 90005 });
    assert.equal(gh2.calls.length, 1);
    assert.equal(out.summary.denominator.all, 0);
  });

  test('the file holds the findings sorted by PR then comment id, and the unparsed keys', async () => {
    // Breaks when: the sort is dropped or the file lacks the findings.
    const gh = makeGh({ prs: [prRow(90001), prRow(90002)], comments: [root({ id: 5, pr: 90002 }), root({ id: 9, pr: 90001 }), root({ id: 2, pr: 90002 }), root({ id: 7, pr: 90001 })] });
    const { file, summary } = await go(gh);
    assert.deepEqual(file.findings.map((f) => f.key), ['90001:7', '90001:9', '90002:2', '90002:5']);
    assert.deepEqual({ ...file, findings: undefined, unparsed: undefined }, { ...summary, findings: undefined, unparsed: undefined });
  });

  test('the PR author from the PR list is trusted; other humans are not', async () => {
    // Breaks when: the PR author is not read from the PR row.
    const gh = makeGh({
      prs: [prRow(90001, { author: 'lee' })],
      comments: [root({ id: 1 }), reply({ id: 11, to: 1, user: { login: 'lee', type: 'User' }, body: 'False positive' }), root({ id: 2 }), reply({ id: 12, to: 2, user: STRANGER, body: 'False positive' })],
    });
    const { file } = await go(gh);
    assert.deepEqual(file.findings.map((f) => f.disposition), ['wrong', 'unlabeled']);
  });

  test('the mixed PR end to end', async () => {
    // Breaks when: sweep and findingsForPr disagree on a number.
    const { summary } = await go(stdGh());
    assert.deepEqual(summary.counts, { fixed: 2, fixedHuman: 1, fixedMarker: 1, wont_fix: 0, wrong: 1, unlabeled: 4 });
    assert.equal(summary.parsed.met, true);
  });
});

describe('main CLI', () => {
  const sweepArgs = ['sweep', '--from', '90000', '--repo', REPO];

  test('F33 no arguments or an unknown command: exit 2, usage on stderr, no gh call, no file', async () => {
    // Breaks when: the command defaults to sweep.
    for (const argv of [[], ['nope'], ['--nope']]) {
      const gh = stdGh();
      const r = await run(argv, { gh });
      assert.equal(r.code, 2, argv.join(' '));
      assert.ok(r.err.join('\n').includes('Usage'));
      assert.equal(gh.calls.length, 0);
      assert.deepEqual(walk(r.home), []);
    }
  });

  test('F33 --help and -h exit 0 with usage on stdout and no gh call', async () => {
    // Breaks when: help falls through to the sweep.
    for (const flag of ['--help', '-h']) {
      const gh = stdGh();
      const r = await run([flag], { gh });
      assert.equal(r.code, 0);
      assert.ok(r.out.join('\n').includes('Usage'));
      assert.equal(gh.calls.length, 0);
      assert.deepEqual(walk(r.home), []);
    }
  });

  test('F33 the entry guard runs main when the file is the script', () => {
    // Breaks when: the entry guard compares paths that differ (the script would do nothing and exit 0).
    const home = tmp();
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const none = spawnSync(process.execPath, [MODULE], { env, encoding: 'utf8', cwd: home });
    assert.equal(none.status, 2);
    assert.ok(none.stderr.includes('Usage'));
    const help = spawnSync(process.execPath, [MODULE, '--help'], { env, encoding: 'utf8', cwd: home });
    assert.equal(help.status, 0);
    assert.ok(help.stdout.includes('Usage'));
    assert.equal(spawnSync(process.execPath, [MODULE, 'sweep', '--from', 'x'], { env, encoding: 'utf8', cwd: home }).status, 2);
    assert.deepEqual(walk(home), []);
  });

  for (const bad of [['--from', 'x'], ['--from', '0'], ['--from', '1.5'], ['--to', '-1'], ['--to', '0'], ['--from', '90005', '--to', '90001'], ['--bar', '0.5'], ['--bar', '0'], ['--repo', 'bad'], ['--repo', 'a/b/c'], ['--nope'], ['--from'], ['--out'], ['--summary-out'], ['--repo']]) {
    test(`F34 bad flags "${bad.join(' ')}" exit 2 with no gh call and no file`, async () => {
      // Breaks when: a check in parseArgs is dropped, or --bar is accepted again.
      const gh = stdGh();
      const r = await run(['sweep', ...bad], { gh });
      assert.equal(r.code, 2);
      assert.equal(gh.calls.length, 0);
      assert.deepEqual(walk(r.home), []);
      assert.ok(r.err.length > 0);
    });
  }

  test('B5 --out under the repo root is refused before any gh call', async () => {
    // Breaks when: outRefused is dropped or does not compare against the repo root.
    const dir = path.join(REPO_ROOT, `disp-test-${process.pid}`);
    try {
      const gh = stdGh();
      const r = await run([...sweepArgs, '--out', path.join(dir, 'x.json')], { gh });
      assert.equal(r.code, 2);
      assert.equal(gh.calls.length, 0);
      assert.ok(!existsSync(dir));
      const rel = await run([...sweepArgs, '--out', path.join(path.relative(process.cwd(), REPO_ROOT), `disp-test-${process.pid}`, 'y.json')], { gh });
      assert.equal(rel.code, 2);
      assert.ok(!existsSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('B5 --out inside any .claude/worktrees folder is refused', async () => {
    // Breaks when: the worktrees rule is dropped.
    const home = tmp();
    const target = path.join(home, '.claude', 'worktrees', 'other', 'x.json');
    const gh = stdGh();
    const r = await run([...sweepArgs, '--out', target], { gh });
    assert.equal(r.code, 2);
    assert.equal(gh.calls.length, 0);
    assert.ok(!existsSync(path.dirname(target)));
  });

  test('F35 the default file lives under the home state folder, named from the injected clock', async () => {
    // Breaks when: the default path uses another folder, or the date comes from the real clock.
    const r = await run(sweepArgs, { gh: stdGh() });
    assert.equal(r.code, 0);
    const file = path.join(r.home, '.claude', 'state', 'review-engine', '2026-11-11-dispositions.json');
    assert.deepEqual(walk(r.home).filter((p) => !p.endsWith('review-engine') && !p.endsWith('state') && p !== '.claude'), [path.join('.claude', 'state', 'review-engine', '2026-11-11-dispositions.json')]);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(data.generatedAt, new Date(NOW).toISOString());
    assert.equal(data.findings.length, 7);
    assert.ok(readFileSync(file, 'utf8').endsWith('}\n'));
  });

  test('exit 0: one stdout line, both files written, no tmp left, the summary has counts only', async () => {
    // Breaks when: the stdout format changes, a write skips the rename, or the summary file gets the findings.
    const home = tmp();
    const out = path.join(home, 'full', 'd.json');
    const summaryOut = path.join(home, 'sum', 's.json');
    const r = await run([...sweepArgs, '--out', out, '--summary-out', summaryOut], { gh: stdGh(), home });
    assert.equal(r.code, 0);
    assert.deepEqual(r.out, ['dispositions: 8 bot comments, parsed 100.0%, replied labeled 2/4, fixed 2 wont_fix 0 wrong 1 unlabeled 4']);
    const sum = JSON.parse(readFileSync(summaryOut, 'utf8'));
    assert.ok(!('findings' in sum));
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).findings.length, 7);
    assert.ok(walk(home).every((p) => !p.endsWith('.tmp')));
  });

  test('--json prints the summary JSON instead of the line', async () => {
    // Breaks when: --json is ignored.
    const r = await run([...sweepArgs, '--json', '--out', path.join(tmp(), 'd.json')], { gh: stdGh() });
    assert.equal(r.code, 0);
    const s = JSON.parse(r.out.join('\n'));
    assert.deepEqual([s.kind, s.parsed.met, 'findings' in s], ['cr-dispositions', true, false]);
  });

  test('F3 F4 a gh error exits 1 with one stderr line and writes nothing; an older file keeps its bytes', async () => {
    // Breaks when: a failed sweep writes either file, or truncates the file at --out.
    const home = tmp();
    const out = path.join(home, 'd.json');
    const summaryOut = path.join(home, 's.json');
    const missing = await run([...sweepArgs, '--out', out, '--summary-out', summaryOut], { gh: makeGh({ prs: [prRow(90001)], failOn: 'comments' }), home });
    assert.equal(missing.code, 1);
    assert.deepEqual(missing.err.length, 1);
    assert.ok(/^dispositions failed \(gh_error\): .*rate limit/.test(missing.err[0]));
    assert.deepEqual(walk(home), []);
    writeFileSync(out, 'OLD BYTES');
    const kept = await run([...sweepArgs, '--out', out, '--summary-out', summaryOut], { gh: makeGh({ prs: [prRow(90001)], failOn: 'comments' }), home });
    assert.equal(kept.code, 1);
    assert.equal(readFileSync(out, 'utf8'), 'OLD BYTES');
    assert.deepEqual(walk(home), ['d.json']);
  });

  test('F2 a cut page exits 1 with bad_shape and writes nothing', async () => {
    // Breaks when: a bad shape is written as a result.
    const home = tmp();
    const r = await run([...sweepArgs, '--out', path.join(home, 'd.json')], { gh: makeGh({ prs: [prRow(90001)], commentPages: [[root({ id: 1 })], { message: 'cut' }] }), home });
    assert.equal(r.code, 1);
    assert.ok(r.err[0].startsWith('dispositions failed (bad_shape):'));
    assert.deepEqual(walk(home), []);
  });

  test('the error message is cut to 200 characters', async () => {
    // Breaks when: the message is printed whole.
    const r = await run([...sweepArgs, '--out', path.join(tmp(), 'd.json')], { gh: makeGh({ prs: [prRow(90001)], failOn: 'comments', failMessage: `rate limit ${'x'.repeat(500)}` }) });
    assert.equal(r.code, 1);
    assert.ok(r.err[0].length < 260);
    assert.ok(!r.err[0].includes('\n'));
  });

  test('F28 zero comments exit 3 and the summary is written', async () => {
    // Breaks when: an empty run exits 0 or writes nothing.
    const home = tmp();
    const summaryOut = path.join(home, 's.json');
    const r = await run([...sweepArgs, '--out', path.join(home, 'd.json'), '--summary-out', summaryOut], { gh: makeGh({ prs: [prRow(90001)], comments: [] }), home });
    assert.equal(r.code, 3);
    const s = JSON.parse(readFileSync(summaryOut, 'utf8'));
    assert.deepEqual([s.denominator.all, s.parsed.share, s.parsed.met], [0, null, false]);
    assert.ok(existsSync(path.join(home, 'd.json')));
    assert.ok(r.out[0].includes('0 bot comments'));
  });

  test('F29 a share below the bar exits 3 and both files are written', async () => {
    // Breaks when: a low share exits 0, or the files are skipped.
    const home = tmp();
    const comments = [...Array.from({ length: 8 }, (_, i) => root({ id: i + 1 })), root({ id: 20, commit: null }), root({ id: 21, commit: null })];
    const r = await run([...sweepArgs, '--out', path.join(home, 'd.json'), '--summary-out', path.join(home, 's.json')], { gh: makeGh({ prs: [prRow(90001)], comments }), home });
    assert.equal(r.code, 3);
    assert.ok(existsSync(path.join(home, 'd.json')) && existsSync(path.join(home, 's.json')));
    assert.equal(JSON.parse(readFileSync(path.join(home, 's.json'), 'utf8')).parsed.share, 0.8);
  });

  test('--to defaults to the highest merged PR', async () => {
    // Breaks when: the default to is not computed from the PR list.
    const r = await run([...sweepArgs, '--json', '--out', path.join(tmp(), 'd.json')], { gh: makeGh({ prs: [prRow(90001), prRow(90004), prRow(90007, { merged: false })], comments: [root({ id: 1, pr: 90004 })] }) });
    assert.deepEqual(JSON.parse(r.out.join('\n')).range, { from: 90000, to: 90004 });
  });
});
