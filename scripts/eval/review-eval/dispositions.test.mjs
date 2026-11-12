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
//  Seat check of 3ead9f63 (R1 to R20; in doubt, unlabeled)
//  R1  a negated or asked negative phrase labels     -> skip the guard for neg_fix, wrong and decline
//  R2  "this is wrong" (agreement) gives wrong       -> restore the bare this/that/it subject in the wrong rule
//  R3  a modal or a negation after the word, or a new block word, still labels -> read only the text before the hit; drop a word from BLOCK_WORDS
//  R4  "done? no" or "Fixed in <sha>? No" is fixed   -> drop the bare-negative answer check
//  R5  "I'm done reviewing" is fixed                 -> put done and applied back into the general fix word rule
//  R6  a conflict reply loses to the marker or an earlier clean reply -> skip conflict replies in decide
//  R7  the SHA fix rule skips the guard              -> read fix_sha without the sentence guard
//  R8  "NOT addressed in commit <sha>" or an unmatched reply gives cr_marker -> drop the ^ anchor; check the marker before reply_unmatched
//  R9  a later "not fixed" keeps an earlier fix      -> skip blocked replies in latestDecision
//  R10 tilde fences or struck text are read          -> drop the ~~~ fence or the strike filter in cleanReply
//  R11 a constant, a Set, a function or CRLF changes the hash wrongly -> hash a Set or a RegExp as {}; skip the CRLF fold
//  R12 a rule change keeps the pinned version        -> any change of a label function or constant
//  R13 --out in another repo, a .git file tree or the primary checkout is written -> drop the .git ancestor walk
//  R14 a long-path or a share form of a repo path is written -> skip the prefix strip or the UNC refusal
//  R15 --summary-out over --out overwrites the full file -> drop the same-file check
//  R16 the default path inside a repo tree is written -> skip outRefused for the default path
//  R17 --repo ../x, x/.. or the upstream owner reaches gh -> drop the dot-segment or the owner check
//  R18 bad JSON or an uncaught error prints response text or a stack -> print e.message for SyntaxError; rethrow in main
//  R19 open and closed-unmerged PRs share one count -> count unmerged PRs in one field
//  R20 the bar is compared with itself              -> change BAR (the literal 0.9 test fails)
//  Fix round on the R1-R20 work (X<n> is review finding n; in doubt, unlabeled)
//  X1  a hedge, ask, partial or revert word does not block -> drop a word from BLOCK_WORDS
//  X2  a bare "follow-up" or "separate PR" gives wont_fix -> let the decline rule match the noun with no defer verb
//  X3  a fix word that matches no fix rule beside a negative hit labels -> drop the fixMention conflict
//  X4  "the suggestion is not a problem" (agreement) or an off-start subject gives wrong -> restore the is-not-a-bug arm; drop the start check
//  X5  an apostrophe run inside a word is quadratic  -> trim apostrophes with a regex again
//  X6  single-tilde strike or a <del> that holds a tag is read -> drop the ~ arm or the inner tag strip
//  X7  "Fixed?No" is fixed                           -> cut after ? only before a space
//  X8  "un-fixed" is fixed                           -> drop un from BLOCK_WORDS
//  X9  a wrong or wont_fix record carries the marker SHA -> fill sha from the marker for every disposition
//  X10 a marker line inside a fence in the bot body counts -> scan the marker on the raw body
//  X12 the alone flag is outside the hash            -> drop alone from rulesVersionOf
//  X13 a failed rename leaves the .tmp file          -> drop the rmSync in writeJson
//  X15 an alternate data stream on a repo folder is written -> drop the colon check in plainPath
//  X16 a gh error prints gh's stderr text            -> print e.message for a gh error
//  X17 a CLI test falls back to the live gh          -> let run() pass a missing gh through
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
const prRow = (n, { merged = true, closed = false, created = '2026-01-01T00:00:00Z', author = 'pat' } = {}) => ({
  id: n + 5000, number: n, state: merged || closed ? 'closed' : 'open', merged_at: merged ? '2026-01-03T00:00:00Z' : null, created_at: created, user: { login: author },
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
  // X17: a test with no stub gh must fail here, never reach the live gh.
  if (typeof gh !== 'function') throw new Error('run() needs a stub gh');
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

  for (const t of ['Fixed the incorrect check', 'Fixed the invalid input path', 'Addressed the misread', 'Resolved, the already handled case too', 'Fixed the case that was wrong']) {
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
    for (const t of ['False positive.', 'The finding is incorrect', 'the finding was invalid', 'This comment does not apply here', 'Not applicable', "the suggestion doesn't apply", 'CodeRabbit is wrong here', 'The bot was incorrect', 'No, the finding is wrong', 'Nah, the comment does not apply']) {
      assert.deepEqual([parseReply(t).disposition, parseReply(t).evidence], ['wrong', 'reply_wrong'], t);
    }
  });

  test('decline rule: wont_fix with reply_decline', () => {
    // Breaks when: a decline pattern is removed, or decline maps to wrong.
    for (const t of ['Out of scope for this PR', 'By design', 'Intentionally left', 'Deferred', 'Deferred to a follow-up', 'Moved to a follow-up PR', 'Left for a follow-up issue', 'Tracked in a separate issue', 'Keeping it as is']) {
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
    const bodies = [
      'fixed '.repeat(180000), `fixed ${'deadbeef '.repeat(120000)}`, `${'a'.repeat(1_000_000)} fixed`, 'x\n'.repeat(500000), `${' '.repeat(1_000_000)}Addressed`,
      '~'.repeat(1_000_000), `fixed ${'~~a'.repeat(333000)}`, `fixed ${'?'.repeat(1_000_000)}x`, `fixed${' '.repeat(1_000_000)}?x`, '. '.repeat(500000), "n't ".repeat(250000),
      'fixed. '.repeat(140000), 'Done. No. '.repeat(100000), `${'```\n~~~\n'.repeat(120000)}fixed`, `won't fix ${'not '.repeat(240000)}`,
      // X5 X6: an apostrophe run inside a word, unclosed strike and tag runs on one line.
      `fixed a${"'".repeat(1_000_000)}b`, '<del>'.repeat(200000), '~a'.repeat(500000), '<s '.repeat(333000), '<b'.repeat(500000), `fixed ${'<del x>a'.repeat(120000)}`,
      `fixed ${'?a'.repeat(500000)}`, `Ignoring ${'the finding is wrong '.repeat(50000)}`,
    ];
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
    assert.deepEqual(REPLY_RULES.map((r) => r.id), ['neg_fix', 'fix_sha', 'wrong', 'decline', 'fix_word', 'fix_done']);
  });

  test('parseReply on empty or non-string input is null and never throws', () => {
    // Breaks when: cleanReply or parseReply assumes a string.
    for (const v of [undefined, null, '', '   ', 42, {}]) assert.equal(parseReply(v), null);
  });

  const CONFLICT_OF = { disposition: 'unlabeled', evidence: null, rule: 'reply_conflict', sha: null };

  const r1Conflicts = [
    'This is not a false positive', 'Is this a false positive?', 'That was not intentional', 'not out of scope', 'Will you wontfix this?',
    "It isn't out of scope", 'Maybe a false positive', 'Should we defer this?', 'If this is by design, say so', 'Not by design, I think', 'Will move this to a follow-up PR',
  ];
  for (const t of r1Conflicts) {
    test(`R1 "${t}" gives unlabeled reply_conflict`, () => {
      // Breaks when: the negative rules (neg_fix, wrong, decline) skip the sentence guard or the question check.
      assert.deepEqual(parseReply(t), CONFLICT_OF);
    });
  }

  test('R1 a negation inside the negative phrase itself does not block it', () => {
    // Breaks when: the guard reads the matched phrase (won't, will not, not going to, does not, not applicable) as a blocker.
    const cases = [["won't fix", 'reply_wont_fix'], ['We will not fix this', 'reply_wont_fix'], ['Not applicable', 'reply_wrong'], ['The finding does not apply', 'reply_wrong'], ["Out of scope, won't fix", 'reply_wont_fix']];
    for (const [t, evidence] of cases) assert.equal(parseReply(t)?.evidence, evidence, t);
  });

  for (const t of ["You're right, this is wrong", 'that was wrong', 'It is incorrect', 'this is invalid', "it doesn't apply"]) {
    test(`R2 "${t}" (a bare pronoun) is not wrong`, () => {
      // Breaks when: the wrong rule takes a bare this, that or it as its subject again.
      assert.equal(parseReply(t), null);
    });
  }

  const r3NoLabel = [
    "I'll get it done", 'Nothing done yet', 'If applied, this would break the build', "I'll get it fixed", "I'd say fixed", 'Must be fixed first', 'Whether this is fixed is unclear',
    'Unsure it is resolved', 'Maybe fixed', 'It might be addressed', 'Nothing fixed yet', 'Need to get this fixed', 'Going to get it fixed', 'Plan to have it resolved',
    'Fixed once CI passes, maybe', 'Fixed, but it is unclear', 'Fixed, if the build passes', 'Fixed yet the test still fails', 'that did not fix it', 'It could be resolved',
    'Whether it is fixed', 'Nothing is fixed',
  ];
  for (const t of r3NoLabel) {
    test(`R3 "${t}" gives no label`, () => {
      // Breaks when: the guard reads only the text before the fix word, or a block word ('ll, 'd, must, if, whether, unsure, unclear, maybe, might, could, nothing, yet, need to, going to, plan to) is dropped.
      assert.equal(parseReply(t), null);
    });
  }

  for (const t of ['done? no', 'Fixed in a1b2c3d? No', 'Was this done? Not yet', 'Fixed? Nope.', 'Resolved? Not really', 'Fixed. No.', 'Fixed in a1b2c3d.\nNo, not yet']) {
    test(`R4 "${t}" (a hit, then a bare no) gives reply_conflict`, () => {
      // Breaks when: the bare-negative answer after a hit sentence is not read.
      assert.deepEqual(parseReply(t), CONFLICT_OF);
    });
  }

  test('R4 a question hit alone is no hit; a "no" before the hit or a longer answer does not block', () => {
    // Breaks when: a question sentence counts as a fix hit, or any sentence that starts with no counts as an answer.
    for (const t of ['Fixed in a1b2c3d?', 'Is this resolved?', 'Done?']) assert.equal(parseReply(t), null, t);
    assert.equal(parseReply('No. Fixed in a1b2c3d').evidence, 'reply_sha');
    assert.equal(parseReply('Fixed. No problem').disposition, 'fixed');
  });

  test('R5 done and applied count only as a short sentence with no object', () => {
    // Breaks when: done or applied return to the general fix word rule, or the 4-word limit or the word list is dropped.
    for (const t of ['Done.', 'Done, thanks.', 'Applied.', 'All done now', 'Done \u2705', 'Ok, applied. Thanks!']) {
      assert.deepEqual(parseReply(t), { disposition: 'fixed', evidence: 'reply_no_sha', rule: 'fix_done', sha: null }, t);
    }
    for (const t of ["I'm done reviewing", 'applied to another file', 'Done with the first pass of the review', 'Done reviewing this one', 'done now thanks all ok']) assert.equal(parseReply(t), null, t);
    assert.equal(parseReply('Done in a1b2c3d').evidence, 'reply_sha');
  });

  test('R7 the SHA fix rule has the sentence guard, after the SHA too', () => {
    // Breaks when: fix_sha is read without the guard.
    for (const t of ['Fixed in a1b2c3d, will push the rest', 'Should be fixed in a1b2c3d', 'Fixed in a1b2c3d if CI agrees', 'Not yet fixed in a1b2c3d']) assert.equal(parseReply(t), null, t);
  });

  test('R10 tilde fences and struck-through text are not read', () => {
    // Breaks when: cleanReply keeps a ~~~ fence or ~~struck~~ or <del> text.
    assert.equal(parseReply("~~~\nwon't fix\n~~~\nFixed in a1b2c3d").evidence, 'reply_sha');
    assert.equal(parseReply("~~Won't fix~~ Fixed in a1b2c3d").evidence, 'reply_sha');
    assert.equal(parseReply('~~Fixed in a1b2c3d~~'), null);
    assert.equal(parseReply("<del>Won't fix</del> Fixed").disposition, 'fixed');
    assert.equal(parseReply("```\n~~~\nwon't fix\n```\nFixed").disposition, 'fixed');
    assert.equal(cleanReply('a\n~~~\nb\n~~~\nc'), 'a\nc');
    assert.equal(cleanReply('a\n~~~ js\nb\n```\nc\n~~~\nd'), 'a\nd');
  });

  const hedged = [
    ['can', 'Can be fixed later'], ['may', 'May be fixed in a1b2c3d'], ['ought', 'Fixed, ought I add'], ['probably', 'Probably fixed in a1b2c3d'],
    ['possibly', 'Possibly resolved'], ['perhaps', 'Perhaps addressed'], ['likely', 'Likely fixed by the rebase'], ['hopefully', 'Hopefully resolved'],
    ['think', 'I think it is fixed'], ['guess', 'I guess this is resolved'], ['seems', 'Seems fixed'], ['please', 'Please get this fixed'],
    ['confirm', 'Confirm this is resolved'], ['partly', 'Partly fixed in a1b2c3d'], ['partially', 'Partially addressed'], ['partial', 'Partial: fixed the main path'],
    ['half', 'Half fixed'], ['most', 'Fixed most of it'], ['some', 'Fixed some of it'], ['except', 'Fixed except the test'],
    ['still', 'Fixed in a1b2c3d, the test still fails'], ['revert', 'Fixed, then had to revert'], ['reverted', 'Fixed in a1b2c3d, then reverted in b2c3d4e'],
    ['undo', 'Fixed in a1b2c3d, undo pending'], ['undid', 'Fixed, then undid it'], ['un', 'un-fixed'], ['un', 'un-fixed in a1b2c3d'], ['un', 'un-resolved'], ['non', 'non-resolved'],
  ];
  for (const [word, t] of hedged) {
    test(`X1 X8 "${t}" (block word ${word}) gives no label`, () => {
      // Breaks when: ${word} is dropped from BLOCK_WORDS.
      assert.equal(parseReply(t), null);
    });
  }

  test('X1 a new block word beside a negative phrase gives reply_conflict', () => {
    // Breaks when: may or still is dropped from BLOCK_WORDS (the negative rule would label).
    for (const t of ['This may be a false positive', 'Still out of scope', 'Probably by design']) assert.deepEqual(parseReply(t), CONFLICT_OF, t);
  });

  test('X2 a bare follow-up or separate PR does not decline; a defer verb does; a fix beside the bare noun is a conflict', () => {
    // Breaks when: the decline rule matches the noun alone again, or the bare noun stops making a conflict with a fix hit.
    for (const t of ['Thanks for the follow-up', 'Thanks for the follow-up PR', 'I saw the follow-up issue', 'a separate PR', 'Done in a separate PR']) assert.equal(parseReply(t), null, t);
    // A defer verb with a code noun (file, function, commit) describes a fix, not a decline; a bare follow-up has no noun.
    for (const t of ['Moved to a separate file', 'Split into a separate function', 'Moved this into a separate commit', 'Moved to a follow-up commit', 'Moved to a follow-up']) assert.equal(parseReply(t), null, t);
    for (const t of ['Fixed; follow-up for the rest', 'Fixed, thanks for the follow-up', 'Addressed in a separate PR', 'Fixed in a1b2c3d, the rest in a separate PR']) assert.deepEqual(parseReply(t), CONFLICT_OF, t);
  });

  test('X3 a fix-family word that matches no fix rule, beside a negative hit, is a conflict', () => {
    // Breaks when: readReply ignores a fix word that no fix rule matched.
    for (const t of ['Done, but out of scope for the rest', 'Out of scope. Applied the rename though.', 'By design; done with the other part']) assert.deepEqual(parseReply(t), CONFLICT_OF, t);
  });

  test('X4 agreement or a subject that does not start the sentence never gives wrong', () => {
    // Breaks when: the is-not-a-bug arm returns, or the wrong subject arm counts away from the sentence start.
    for (const t of ['Taking the suggestion is not a problem', 'The suggestion is not a problem', 'the comment is not a bug', 'The finding is not an issue']) assert.equal(parseReply(t), null, t);
    for (const t of ['Ignoring the suggestion was wrong', 'Agreed, the finding is wrong', 'I agree the comment does not apply']) assert.deepEqual(parseReply(t), CONFLICT_OF, t);
  });

  test('X6 single-tilde strike and a <del> that holds a tag or attributes are not read', () => {
    // Breaks when: the ~ arm or the inner tag strip is dropped from cleanReply.
    assert.equal(parseReply('~Fixed in a1b2c3d~'), null);
    assert.equal(parseReply('<del class="x">Fixed in <b>a1b2c3d</b></del>'), null);
    assert.equal(parseReply('<s>Fixed</s> not yet'), null);
    assert.equal(parseReply("~Won't fix~ Fixed in a1b2c3d").evidence, 'reply_sha');
    assert.equal(parseReply('Fixed in <code>a1b2c3d</code>').sha, 'a1b2c3d');
    assert.equal(parseReply('Fixed ~3 of 4, ~1 left').disposition, 'fixed');
  });

  test('X7 a ? with no space after it makes its sentence a question; it never cuts a block word away', () => {
    // Breaks when: an inner ? is not read as a question, or it cuts the sentence (a URL query would part a block word from the fix word).
    for (const t of ['Fixed?No', 'Done?no', 'Fixed in a1b2c3d?Not yet', 'Fixed (see https://x.test/a?b=1)']) assert.equal(parseReply(t), null, t);
    for (const t of ["This won't be fixed until https://x.test/issue?id=5 is resolved", 'Could not reproduce at https://x.test/y?z=1 so marked resolved']) assert.equal(parseReply(t), null, t);
    assert.equal(parseReply('See https://x.test/a?b=1. Fixed in a1b2c3d').evidence, 'reply_sha');
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

  test('R8 the marker counts only on its own line', () => {
    // Breaks when: the ^ anchor or the end-of-line anchor is dropped from the marker pattern.
    const refused = [
      'x\nThe issue is NOT addressed in commit a1b2c3d', 'x\nNot addressed in commit a1b2c3d', 'x\n> Addressed in commit a1b2c3d', 'Still open: Addressed in commit a1b2c3d',
      'x\nAddressed in commit a1b2c3d, but the test still fails', 'x\nAddressed in commit a1b2c3d? not really',
    ];
    for (const b of refused) assert.equal(parseMarker(b), null, b);
    assert.equal(parseMarker('x\n\u2705 Addressed in commit a1b2c3d'), 'a1b2c3d');
    assert.equal(parseMarker('x\n  Addressed in commits `a1b2c3d` to `b2c3d4e`.'), 'b2c3d4e');
  });

  test('X10 a marker line inside a fenced block of the bot body does not count', () => {
    // Breaks when: parseMarker scans the raw body with its fences.
    for (const b of ['x\n```suggestion\nAddressed in commit a1b2c3d\n```', 'x\n~~~\nAddressed in commit a1b2c3d\n~~~', 'x\n```\nAddressed in commit a1b2c3d']) assert.equal(parseMarker(b), null, b);
    assert.equal(parseMarker('x\n```\ncode\n```\nAddressed in commit a1b2c3d'), 'a1b2c3d');
    assert.equal(parseMarker('x\r\nAddressed in commit a1b2c3d\r\n'), 'a1b2c3d');
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

  test('decide: a trusted reply decides, with its SHA and id', () => {
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

  test('X9 a wrong or wont_fix reply does not take the marker SHA', () => {
    // Breaks when: decide fills sha from the marker for every disposition.
    const body = 'finding\nAddressed in commit b2c3d4e';
    for (const text of ['False positive', "Won't fix", 'By design']) {
      const d = decide({ root: root({ id: 1, body }), replies: [reply({ id: 9, to: 1, body: text })], trusted: TRUSTED });
      assert.notEqual(d.disposition, 'fixed', text);
      assert.equal(d.sha, null, text);
    }
  });

  test('X8 R9 a later "un-fixed" reply undoes an earlier trusted fix', () => {
    // Breaks when: un is dropped from BLOCK_WORDS (the reply would be no hit and keep the fix).
    const d = decideOf([reply({ id: 1, body: 'Fixed in a1b2c3d', at: '2026-01-02T00:00:00Z' }), reply({ id: 2, body: 'This got un-fixed by the merge', at: '2026-01-03T00:00:00Z' })]);
    assert.deepEqual([d.disposition, d.reason, d.replyId], ['unlabeled', 'reply_conflict', 2]);
  });

  test('F12 R8 the marker alone gives fixed with cr_marker and its SHA', () => {
    // Breaks when: the marker arm is dropped.
    const d = decide({ root: root({ id: 1, body: 'x\nAddressed in commit a1b2c3d' }), replies: [], trusted: TRUSTED });
    assert.deepEqual(d, { disposition: 'fixed', evidence: 'cr_marker', reason: null, rule: null, sha: 'a1b2c3d', replyId: null });
  });

  test('R8 an unmatched trusted reply beats the marker: unlabeled reply_unmatched', () => {
    // Breaks when: the marker is checked before reply_unmatched (the marker must rank below every trusted reply).
    const d = decide({ root: root({ id: 1, body: 'x\nAddressed in commit a1b2c3d' }), replies: [reply({ id: 9, to: 1, body: 'Thanks' })], trusted: TRUSTED });
    assert.deepEqual([d.disposition, d.evidence, d.reason], ['unlabeled', null, 'reply_unmatched']);
    const blocked = decide({ root: root({ id: 1, body: 'x\nAddressed in commit a1b2c3d' }), replies: [reply({ id: 9, to: 1, body: 'not fixed yet' })], trusted: TRUSTED });
    assert.deepEqual([blocked.disposition, blocked.reason], ['unlabeled', 'reply_unmatched']);
  });

  test('R9 a later blocked fix reply undoes an earlier trusted fix; a later "thanks" keeps it', () => {
    // Breaks when: latestDecision skips a reply whose fix hit the guard blocked, or a no-hit reply erases the label.
    const fix = reply({ id: 1, body: 'Fixed in a1b2c3d', at: '2026-01-02T00:00:00Z' });
    for (const body of ['not fixed', 'that did not fix it', 'Hm, this is not resolved yet']) {
      const d = decideOf([fix, reply({ id: 2, body, at: '2026-01-03T00:00:00Z' })]);
      assert.deepEqual([d.disposition, d.reason, d.rule, d.replyId], ['unlabeled', 'reply_conflict', 'reply_conflict', 2], body);
    }
    const kept = decideOf([fix, reply({ id: 2, body: 'thanks', at: '2026-01-03T00:00:00Z' })]);
    assert.deepEqual([kept.disposition, kept.replyId], ['fixed', 1]);
    const before = decideOf([reply({ id: 2, body: 'not fixed', at: '2026-01-01T00:00:00Z' }), fix]);
    assert.deepEqual([before.disposition, before.replyId], ['fixed', 1]);
    const wrongKept = decideOf([reply({ id: 1, body: 'False positive', at: '2026-01-02T00:00:00Z' }), reply({ id: 2, body: 'not fixed', at: '2026-01-03T00:00:00Z' })]);
    assert.deepEqual([wrongKept.disposition, wrongKept.replyId], ['wrong', 1]);
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
      replies: { trusted: 1, human: 0, bot: 0, unknown: 0, cr: 1 }, outdated: false, parsed: true, marker: false,
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

  test('R8 a record carries marker true or false; fixedMarker counts marker roots with no trusted reply only', () => {
    // Breaks when: the marker field is dropped or read from the decision, or unlabeledWithMarker is not counted.
    const mk = 'x\nAddressed in commit a1b2c3d';
    const out = one([
      root({ id: 1, body: mk }), reply({ id: 11, to: 1, body: 'Thanks' }), root({ id: 2, body: mk }), root({ id: 3, body: mk }), reply({ id: 13, to: 3, body: 'Fixed' }),
      root({ id: 4 }), root({ id: 5, body: mk }), reply({ id: 15, to: 5, user: STRANGER, body: 'Thanks' }),
    ]);
    assert.deepEqual(out.records.map((r) => [r.disposition, r.evidence, r.reason, r.marker]), [
      ['unlabeled', null, 'reply_unmatched', true], ['fixed', 'cr_marker', null, true], ['fixed', 'reply_no_sha', null, true], ['unlabeled', null, 'no_signal', false], ['fixed', 'cr_marker', null, true],
    ]);
    const s = summarize({ ...out, excluded: {}, range: { from: 90000, to: 90001 }, repo: REPO, generatedAt: 'T' });
    assert.deepEqual([s.counts.fixedMarker, s.counts.fixedHuman, s.counts.unlabeledWithMarker], [2, 1, 1]);
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
    return summarize({ records: f.records, unparsed: f.unparsed, botReplies: f.botReplies, excluded: {}, range: { from: 90000, to: 90001 }, repo: REPO, generatedAt: 'T', ...over });
  };

  test('the counts, evidence, reasons and the replied numbers on a mixed PR', () => {
    // Breaks when: a tally reads the wrong field or a branch of decide changes.
    const s = sumOf();
    assert.deepEqual(s.denominator, { rule: 'REST pulls/comments by coderabbitai[bot] (type Bot) on merged PRs in range; review-body findings are outside pulls/comments', all: 8, roots: 7, replies: 1 });
    assert.deepEqual(s.counts, { fixed: 2, fixedHuman: 1, fixedMarker: 1, wont_fix: 0, wrong: 1, unlabeled: 4, unlabeledWithMarker: 0 });
    assert.deepEqual(s.excluded, { openPrs: 0, closedUnmergedPrs: 0, openComments: 0, closedUnmergedComments: 0 });
    assert.deepEqual(s.evidence, { reply_wont_fix: 0, reply_sha: 1, reply_wrong: 1, reply_decline: 0, reply_no_sha: 0, cr_marker: 1 });
    assert.deepEqual(s.reasons, { reply_unmatched: 1, reply_conflict: 1, thumbs_up_only: 0, thumbs_down_unverified: 1, thumbs_conflict: 0, no_signal: 1 });
    assert.deepEqual(s.replied, { findings: 4, anyReply: 4, labeled: 2, unlabeled: 2, share: 0.5 });
    assert.deepEqual(s.labeled, { count: 3, share: 3 / 7 });
    assert.deepEqual(s.parsed, { all: 8, roots: 7, replies: 1, share: 1, rootShare: 1, bar: 0.9, met: true });
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

  test('R11 rulesVersionOf reads a Set, a RegExp, a function and the fix flag; CRLF folds to LF', () => {
    // Breaks when: a Set or a RegExp is hashed as {} by JSON, a function is hashed by name, the fix flag is left out, or CRLF is not folded.
    const base = [{ id: 'a', re: /x/i, disposition: 'fixed', evidence: 'e' }];
    const v = (extra, rules = base) => rulesVersionOf(rules, extra);
    assert.notEqual(v([new Set(['will', 'not'])]), v([new Set(['will'])]));
    assert.equal(v([new Set(['will', 'not'])]), v([new Set(['not', 'will'])]));
    assert.notEqual(v([/a/g]), v([/b/g]));
    assert.notEqual(v([/a/g]), v([/a/i]));
    assert.notEqual(v([function f() { return 1; }]), v([function f() { return 2; }]));
    assert.notEqual(v([], [{ ...base[0], fix: true }]), v([]));
    // X12: the alone flag is hashed.
    assert.notEqual(v([], [{ ...base[0], alone: true }]), v([]));
    assert.equal(v(['line one\r\nline two']), v(['line one\nline two']));
    assert.equal(v([new Function('a', 'return a;\r\n')]), v([new Function('a', 'return a;\n')]));
    assert.notEqual(v([[1, 2]]), v([[1, 3]]));
  });

  test('R12 RULES_VERSION is pinned: a rule change needs a visible test edit', () => {
    // Breaks when: any reply rule, block word, marker pattern or label function changes (then update this literal with the seat's word).
    assert.equal(RULES_VERSION, '6078875a607ae18d');
  });

  test('replied.unlabeled equals reply_unmatched plus reply_conflict', () => {
    // Breaks when: a replied finding is unlabeled for a reason outside those two, or the replied count reads another field.
    const s = sumOf();
    assert.equal(s.replied.unlabeled, s.reasons.reply_unmatched + s.reasons.reply_conflict);
  });

  test('F28 zero comments: share null, met false, gate 3 (no vacuous pass)', () => {
    // Breaks when: a null share counts as met.
    const s = summarize({ records: [], unparsed: [], botReplies: { all: 0, parsed: 0 }, excluded: {}, range: { from: 90000, to: null }, repo: REPO, generatedAt: 'T' });
    assert.deepEqual([s.parsed.share, s.parsed.rootShare, s.parsed.met, s.replied.share, s.labeled.share], [null, null, false, null, null]);
    assert.equal(gateOf(s), 3);
  });

  const parsedRoots = (n) => Array.from({ length: n }, (_, i) => findingsForPr({ pr: 90001, comments: [root({ id: 100 + i })], prFact: {}, repo: REPO }).records[0]);
  const badRoots = (n) => Array.from({ length: n }, (_, i) => ({ key: `90001:${900 + i}`, reason: 'bad_shape', kind: 'root' }));

  test('F29 below the bar gives gate 3; at the bar gives gate 0', () => {
    // Breaks when: the compare is > 0, or > BAR instead of >= BAR, or BAR is not 0.9 (R20: a literal, not BAR against itself).
    assert.equal(BAR, 0.9);
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

  test('F4 X16 a gh error in the middle is a gh_error with a fixed text and only the HTTP status', async () => {
    // Breaks when: a gh throw is swallowed or given another kind, or the gh message (command, stderr, API text) reaches the error.
    await assert.rejects(go(makeGh({ prs: [prRow(90001)], failOn: 'comments' })), (e) => e instanceof SweepError && e.kind === 'gh_error' && e.message === 'gh api call failed');
    const msg = 'Command failed: gh api repos/acme/widgets/pulls\ngh: made-up api text (HTTP 403)';
    await assert.rejects(go(makeGh({ failOn: 'prs', failMessage: msg })), (e) => e.kind === 'gh_error' && e.message === 'gh api call failed (HTTP 403)');
  });

  test('the same id on two pages is counted once', async () => {
    // Breaks when: rows are not deduplicated by id.
    const gh = makeGh({ prs: [prRow(90001)], commentPages: [[root({ id: 1 }), root({ id: 2 })], [root({ id: 2 }), root({ id: 3 })]] });
    const { summary, file } = await go(gh);
    assert.equal(summary.denominator.roots, 3);
    assert.deepEqual(file.findings.map((f) => f.commentId), [1, 2, 3]);
  });

  test('F20 R19 R20 open and closed-unmerged PRs are excluded and counted apart, in range only', async () => {
    // Breaks when: the merged_at filter is dropped, the excluded counts read the wrong list, or open and closed-unmerged share one count.
    const gh = makeGh({
      prs: [prRow(89990, { merged: false }), prRow(90001), prRow(90002, { merged: false }), prRow(90003, { merged: false, closed: true }), prRow(90004, { merged: false, closed: true }), prRow(90005)],
      comments: [root({ id: 1 }), root({ id: 2, pr: 90002 }), root({ id: 3, pr: 90002 }), root({ id: 4, pr: 90003 }), reply({ id: 5, pr: 90003, to: 4, user: CR, body: 'x' }), root({ id: 6, pr: 90005 })],
    });
    const { summary } = await go(gh);
    assert.equal(prRow(90003, { merged: false, closed: true }).state, 'closed');
    assert.equal(summary.denominator.roots, 2);
    assert.deepEqual(summary.excluded, { openPrs: 1, closedUnmergedPrs: 2, openComments: 2, closedUnmergedComments: 2 });
  });

  test('F21 an open PR with a higher number does not move the default to', async () => {
    // Breaks when: the default to takes the highest number of any state.
    const gh = makeGh({ prs: [prRow(90001), prRow(90002), prRow(90003, { merged: false })], comments: [root({ id: 1, pr: 90001 }), root({ id: 2, pr: 90003 })] });
    const { summary } = await go(gh);
    assert.deepEqual(summary.range, { from: 90000, to: 90002 });
    assert.equal(summary.denominator.roots, 1);
    assert.deepEqual([summary.excluded.openPrs, summary.excluded.closedUnmergedPrs], [0, 0]);
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
    assert.deepEqual(summary.counts, { fixed: 2, fixedHuman: 1, fixedMarker: 1, wont_fix: 0, wrong: 1, unlabeled: 4, unlabeledWithMarker: 0 });
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

  for (const bad of [['--from', 'x'], ['--from', '0'], ['--from', '1.5'], ['--to', '-1'], ['--to', '0'], ['--from', '90005', '--to', '90001'], ['--bar', '0.5'], ['--bar', '0'], ['--repo', 'bad'], ['--repo', 'a/b/c'], ['--nope'], ['--from'], ['--out'], ['--summary-out'], ['--repo'],
    ['--repo', '../graphql'], ['--repo', 'acme/..'], ['--repo', './widgets'], ['--repo', 'acme/.'], ['--repo', '.../x'], ['--repo', 'parcadei/x'], ['--repo', 'Parcadei/widgets'], ['--repo', 'PARCADEI/y']]) {
    test(`F34 R17 bad flags "${bad.join(' ')}" exit 2 with no gh call and no file`, async () => {
      // Breaks when: a check in parseArgs is dropped, --bar is accepted again, or the dot-segment or upstream-owner check on --repo is dropped.
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

  test('R17 a repo name with inner dots is accepted and reaches the route', async () => {
    // Breaks when: the --repo check refuses every dot.
    const gh = makeGh({ prs: [prRow(90001)], comments: [root({ id: 1 })] });
    const r = await run(['sweep', '--from', '90000', '--repo', 'acme/wid.gets', '--out', path.join(tmp(), 'd.json')], { gh });
    assert.equal(r.code, 0);
    assert.ok(gh.calls[0].some((a) => a.startsWith('repos/acme/wid.gets/pulls?')));
  });

  /** A temp folder that holds a fake repo: `.git` as a folder (kind dir) or as a file (kind file, the worktree form). */
  const fakeRepo = (kind = 'dir', base = tmp()) => {
    if (kind === 'dir') mkdirSync(path.join(base, '.git'), { recursive: true });
    else writeFileSync(path.join(base, '.git'), 'gitdir: ../elsewhere\n');
    return base;
  };
  async function refusedOut(target, { home } = {}) {
    const gh = stdGh();
    const r = await run([...sweepArgs, '--out', target], { gh, home });
    assert.equal(r.code, 2, target);
    assert.equal(gh.calls.length, 0, target);
    assert.ok(r.err.join('\n').includes('Usage'));
    return r;
  }

  test('R13 R16 --out inside another repository (a .git folder) is refused, at any depth', async () => {
    // Breaks when: the .git ancestor walk is dropped (only this script's own repo root is refused).
    const repo = fakeRepo('dir');
    await refusedOut(path.join(repo, 'x.json'));
    await refusedOut(path.join(repo, 'a', 'b', 'c', 'x.json'));
    assert.deepEqual(walk(repo), ['.git']);
  });

  test('R13 R16 --out inside a tree with a .git file (a worktree anywhere) is refused', async () => {
    // Breaks when: the walk tests for a .git folder only.
    const wt = fakeRepo('file');
    await refusedOut(path.join(wt, 'notes', 'x.json'));
    assert.deepEqual(walk(wt), ['.git']);
  });

  test('R13 R16 --out in the primary checkout, seen from a worktree, is refused', async () => {
    // Breaks when: only the worktree root and .claude/worktrees count, not the primary tree above them.
    const primary = fakeRepo('dir');
    const worktree = path.join(primary, '.claude', 'worktrees', 'wt');
    mkdirSync(worktree, { recursive: true });
    fakeRepo('file', worktree);
    await refusedOut(path.join(primary, 'docs', 'x.json'));
    assert.ok(!existsSync(path.join(primary, 'docs')));
  });

  test('R14 R16 a long-path form of a path in a repo is refused; outside every repo it is written at the plain path', { skip: process.platform !== 'win32' }, async () => {
    // Breaks when: the long-path prefix is not stripped before the check (the prefix hides the .git ancestor).
    const repo = fakeRepo('dir');
    await refusedOut(`\\\\?\\${path.join(repo, 'x.json')}`);
    assert.deepEqual(walk(repo), ['.git']);
    const home = tmp();
    const plain = path.join(home, 'ok', 'd.json');
    const r = await run([...sweepArgs, '--out', `\\\\?\\${plain}`], { gh: stdGh(), home });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(readFileSync(plain, 'utf8')).findings.length, 7);
  });

  test('R14 R16 every UNC form is refused, inside or outside a repo, before any file read', async () => {
    // Breaks when: a share path, a device path or the long-path UNC form passes the check.
    // Every target maps to a temp folder, so a broken guard writes only there.
    const outside = tmp();
    const rest = (p) => p.slice(3);
    const drive = (p) => p.slice(0, 1);
    const inside = path.join(fakeRepo('dir', outside), 'x.json');
    const targets = [
      `\\\\localhost\\${drive(inside)}$\\${rest(inside)}`, `//localhost/${drive(inside)}$/${rest(inside).replace(/\\/g, '/')}`,
      `\\\\?\\UNC\\localhost\\${drive(inside)}$\\${rest(inside)}`, `\\\\.\\${inside}`, `\\\\127.0.0.1\\${drive(inside)}$\\${rest(inside)}`,
    ];
    for (const t of targets) await refusedOut(t);
    assert.deepEqual(walk(outside), ['.git']);
    const plainOutside = path.join(tmp(), 'y.json');
    await refusedOut(`\\\\localhost\\${drive(plainOutside)}$\\${rest(plainOutside)}`);
    assert.ok(!existsSync(plainOutside));
  });

  test('R16 the default path is checked too: a home inside a repo tree is refused', async () => {
    // Breaks when: the default path skips outRefused.
    const home = fakeRepo('dir');
    const r = await run(sweepArgs, { gh: stdGh(), home });
    assert.equal(r.code, 2);
    assert.deepEqual(walk(home), ['.git']);
  });

  test('R16 the default path follows a changed USERPROFILE (no injected home) and is refused in a repo tree', async () => {
    // Breaks when: the default path skips outRefused, or reads a home other than os.homedir().
    const home = fakeRepo('dir');
    const keep = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    try {
      assert.equal(os.homedir(), home);
      const gh = stdGh();
      const err = [];
      const code = await main(sweepArgs, { gh, now: () => NOW, stdout: () => {}, stderr: (s) => err.push(s) });
      assert.equal(code, 2);
      assert.equal(gh.calls.length, 0);
      assert.deepEqual(walk(home), ['.git']);
    } finally {
      for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  test('R15 --summary-out on the same file as --out (or the default path) exits 2 with no gh call', async () => {
    // Breaks when: the same-file check is dropped (the summary would overwrite the full file).
    const home = tmp();
    const out = path.join(home, 'd.json');
    const variants = [out, `${home}${path.sep}.${path.sep}d.json`, `${home}${path.sep}sub${path.sep}..${path.sep}d.json`];
    if (process.platform === 'win32') variants.push(path.join(home, 'D.JSON'));
    for (const s of variants) {
      const gh = stdGh();
      const r = await run([...sweepArgs, '--out', out, '--summary-out', s], { gh, home });
      assert.equal(r.code, 2, s);
      assert.equal(gh.calls.length, 0);
    }
    const gh = stdGh();
    const def = path.join(home, '.claude', 'state', 'review-engine', '2026-11-11-dispositions.json');
    assert.equal((await run([...sweepArgs, '--summary-out', def], { gh, home })).code, 2);
    assert.deepEqual(walk(home), []);
  });

  test('R18 bad JSON from gh prints a fixed line, no response text', async () => {
    // Breaks when: the SyntaxError message (which quotes the response) is printed.
    const home = tmp();
    const gh = async () => JSON.parse('<html>made-up secret response page</html>');
    const r = await run([...sweepArgs, '--out', path.join(home, 'd.json')], { gh, home });
    assert.equal(r.code, 1);
    assert.deepEqual(r.err, ['dispositions failed (bad_shape): gh output is not JSON']);
    assert.deepEqual(walk(home), []);
  });

  test('R18 an uncaught error prints one fixed line: no stack, no path, no file left', async () => {
    // Breaks when: main rethrows a non-SweepError, or prints its message or stack.
    const home = tmp();
    writeFileSync(path.join(home, 'a-file'), 'x');
    const out = path.join(home, 'a-file', 'd.json');
    const r = await run([...sweepArgs, '--out', out, '--summary-out', path.join(home, 's.json')], { gh: stdGh(), home });
    assert.equal(r.code, 1);
    assert.deepEqual(r.err, ['dispositions failed (internal): unexpected error']);
    assert.deepEqual(walk(home), ['a-file']);
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
    assert.deepEqual(missing.err, ['dispositions failed (gh_error): gh api call failed']);
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

  test('X16 a gh error prints no gh text: one fixed line with the HTTP status only', async () => {
    // Breaks when: the gh message (its command line, stderr or API text) is printed.
    const failMessage = `Command failed: gh api x\nmade-up api text ${'x'.repeat(500)} (HTTP 502)`;
    const r = await run([...sweepArgs, '--out', path.join(tmp(), 'd.json')], { gh: makeGh({ prs: [prRow(90001)], failOn: 'comments', failMessage }) });
    assert.equal(r.code, 1);
    assert.deepEqual(r.err, ['dispositions failed (gh_error): gh api call failed (HTTP 502)']);
  });

  test('X13 a failed rename (--out is a folder) leaves no .tmp file and prints the fixed line', async () => {
    // Breaks when: writeJson drops the rmSync of the .tmp file on failure.
    const home = tmp();
    const out = path.join(home, 'out-folder');
    mkdirSync(out);
    const r = await run([...sweepArgs, '--out', out], { gh: stdGh(), home });
    assert.equal(r.code, 1);
    assert.deepEqual(r.err, ['dispositions failed (internal): unexpected error']);
    assert.deepEqual(walk(home), ['out-folder']);
  });

  test('X15 an alternate data stream path is refused, on a repo folder or anywhere', { skip: process.platform !== 'win32' }, async () => {
    // Breaks when: plainPath lets a colon after the drive through (the write lands in a stream of the repo folder).
    const repo = fakeRepo('dir');
    await refusedOut(`${repo}:x`);
    await refusedOut(`${path.join(repo, '.git')}:x.json`);
    await refusedOut(`${path.join(tmp(), 'd.json')}:s`);
    assert.deepEqual(walk(repo), ['.git']);
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
