// Failure modes of dispositions.mjs (lane re-dispositions). All values are made up: PR numbers from 90001, small ids, no real text.
// Every git is a scripted function; every gh is a stub; every main() run gets a temp home. No test reaches the network.
//  F1  a paged result is not flattened               -> take pages[0] only in ghList use
//  F2  a page that is not an array passes            -> drop the shape check in pagedRows
//  F3  a gh error writes a file or kills an old one  -> write before the sweep ends, or write over --out on failure
//  F4  a gh error in the middle leaves a file        -> write the summary before the comments call
//  F6  a deleted user (null, ghost) gives a signal   -> drop the unknown arm in authorKind
//  F7  login variants count as CodeRabbit or trusted -> match the login without the type check
//  F8  the bot's own "Fixed in <sha>" decides        -> let authorKind cr count as trusted
//  F10 conflicting thumbs label                      -> label when both counts are above 0
//  F11 any thumbs give a disposition                 -> map thumbs_down_unverified to wrong
//  F12 a marker loses to a thumbs-down               -> check thumbs before the marker
//  F13 a marker beats a human reply                  -> check the marker before the trusted replies
//  F15 an untrusted human reply labels               -> treat every human as trusted
//  F16 quoted or fenced text is read                 -> drop the quote and fence filter in cleanReply
//  F18 an outdated thread gets a label               -> let line == null decide
//  F19 an open finding turns negative                -> map no_signal to a disposition
//  F20 unmerged PRs count in the denominator         -> drop the merged_at filter
//  F21 an open PR moves the default --to             -> take the highest number of any state
//  F22 comments outside the range stay              -> drop the range filter; since from the wrong PR
//  F23 a comment on an unlisted PR vanishes          -> drop the pr_unknown branch
//  F24 an orphan bot reply counts as parsed          -> count every bot reply as parsed
//  F25 a root with no commit counts as parsed        -> drop the 40-hex check in isRootShape
//  F27 a 1 MB body hangs                             -> add a nested quantifier to the grammar or the marker
//  F28 zero comments pass                            -> let share null count as met
//  F29 a share below the bar passes                  -> compare with > 0 and not with BAR
//  F31 the summary leaks ids or the findings         -> spread the file into the summary
//  F32 a verdict outside VERDICTS                    -> change a VERDICT_OF value
//  F33 no arguments run a sweep or make a gh call    -> default the command to sweep; broken entry guard
//  F34 a bad flag reaches gh                         -> drop a check in parseArgs
//  F35 the clock is read outside main                -> call Date.now in summarize or sweep
//  F36 findings follow the input order               -> drop the sort in findingsForPr
//  Seat check of d0bc9b6f: a closed grammar (G1 G2), later replies (G3), the marker (G4), closed items (C1 to C4), tests (T1 to T3)
//  G1  a reply outside "<start> <link> [commit] <sha>" labels, or a SHA labels with no git proof -> loosen the anchor; skip a git check
//  G2  a reply that is not exactly one list sentence (plus courtesy) labels -> compare with startsWith or includes; drop the markup check
//  G3  a later doubt or a second label is ignored    -> let the last label win over a later non-grammar reply
//  G4  the marker beats a trusted reply              -> check the marker before the trusted replies
//  C1  a change of collect or prOf keeps the version -> leave a label function out of VERSION_PARTS
//  C2  a share form of --summary-out passes          -> fall back to path.resolve for a summary path with no plain form
//  C3  a junction into a repo is written             -> drop the real-path walk in outRefused
//  C4  a GLOBALROOT form or a dangling link is written -> accept any long-path tail; skip the dangling-link check
//  R8 R11 R12 R13 to R20 (seat check of 3ead9f63) keep their tests below.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPO } from '../../github/cursor-review.mjs';
import * as D from './dispositions.mjs';
import { VERDICTS } from './labels.mjs';

// A namespace import: a missing export fails its own tests, not the whole file.
const {
  BAR, BY, GRAMMAR, RULES_VERSION, SweepError, VERDICT_OF, VERSION_PARTS, authorKind, cleanReply, decide, findingsForPr, gateOf, main, mainShaOf,
  parseMarker, parseReply, prOf, rulesVersionOf, shaEvidence, summarize, sweep, thumbsOf, trustedSet, verdictOf,
} = D;

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
const full = (p) => p.toLowerCase().padEnd(40, '0');
const MAIN = sha('e');

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

// ---- a scripted git ---------------------------------------------------------------------------------------------------------

const HEX_REF = /^[0-9a-f]{7,40}$/i;

/**
 * rev-parse --verify <x>^{commit}: a ref name, else the one commit whose SHA starts with x (none: 1). Two matches: status 128
 * with a candidate on stdout, so that only the exit status, never the output, can make the check pass.
 */
function revParse(commits, refs, args) {
  const arg = String(args.at(-1));
  if (!args.includes('--verify') || !arg.endsWith('^{commit}')) return { status: 129, stdout: '' };
  const ref = arg.slice(0, -'^{commit}'.length);
  if (refs[ref]) return { status: 0, stdout: `${refs[ref]}\n` };
  const hits = HEX_REF.test(ref) ? Object.keys(commits).filter((k) => k.startsWith(ref.toLowerCase())) : [];
  if (hits.length > 1) return { status: 128, stdout: `${hits[0]}\n` };
  return hits.length === 1 ? { status: 0, stdout: `${hits[0]}\n` } : { status: 1, stdout: '' };
}

/** diff-tree: the files only with -r (else the top folder), a merge only with -m, a root commit only with --root, NUL ends only with -z. */
function diffTree(c, args) {
  if (!c) return { status: 128, stdout: '' };
  if ((c.merge && !args.includes('-m')) || (c.root && !args.includes('--root'))) return { status: 0, stdout: '' };
  const names = args.includes('-r') ? c.files : [...new Set(c.files.map((f) => f.split('/')[0]))];
  if (args.includes('-z')) return { status: 0, stdout: names.map((n) => `${n}\0`).join('') };
  return { status: 0, stdout: `${names.map((n) => (/[^\x20-\x7e]/.test(n) ? JSON.stringify(n) : n)).join('\n')}\n` };
}

const HEX40_LOWER = /^[0-9a-f]{40}$/;

/**
 * merge-base --is-ancestor <a> <b>. The second commit tells the two checks apart: a ref value is the main check (onMain), a
 * 40-hex id is the finding commit (exit 0 only when a lists b in ancestorOf, else 1). newer: the answer of the second check
 * alone, a status, 'null' or 'throw'.
 */
function mergeBase(commits, refs, args, newer) {
  const [, flag, a, b] = args;
  if (flag !== '--is-ancestor' || !commits[a]) return { status: 128, stdout: '' };
  if (Object.values(refs).includes(b)) return { status: commits[a].onMain === false ? 1 : 0, stdout: '' };
  if (!HEX40_LOWER.test(String(b))) return { status: 128, stdout: '' };
  if (newer === 'throw') throw new Error('spawn git ENOENT');
  if (newer === 'null') return null;
  if (newer !== null) return { status: newer, stdout: '' };
  return { status: (commits[a].ancestorOf ?? []).includes(b) ? 0 : 1, stdout: '' };
}

/**
 * commits: { <full sha>: { files, onMain = true, ancestorOf, merge, root } }; refs: name -> full sha. fail: a git verb that exits 128,
 * or 'throw'. newer: see mergeBase.
 */
function scriptGit(commits = {}, { refs = { main: MAIN }, fail = null, newer = null } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (fail === 'throw') throw new Error('spawn git ENOENT');
    if (fail === args[0]) return { status: 128, stdout: '' };
    if (args[0] === 'rev-parse') return revParse(commits, refs, args);
    if (args[0] === 'merge-base') return mergeBase(commits, refs, args, newer);
    if (args[0] === 'diff-tree') return diffTree(commits[args.at(-1)], args);
    return { status: 129, stdout: '' };
  };
  git.calls = calls;
  return git;
}

const STD_COMMITS = {
  [full('a1b2c3d')]: { files: ['src/a.js'] },
  [full('b2c3d4e')]: { files: ['src/other.js', 'src/a.jsx'] },
  [full('c3d4e5f')]: { files: ['src/a.js'], onMain: false },
  [full('d4e5f6a1')]: { files: ['src/a.js'] },
  [full('d4e5f6a2')]: { files: ['src/a.js'] },
  [full('e5f6a7b')]: { files: ['src/a.js'], merge: true },
  [full('f6a7b8c')]: { files: ['src/a.js'], root: true },
  [full('a7b8c9d')]: { files: ['src/caf\u00E9.js'] },
  // Older than the finding commit of root() (sha('c')): one changes the file, one another file.
  [full('9a8b7c6')]: { files: ['src/a.js'], ancestorOf: [sha('c')] },
  [full('8b7c6d5')]: { files: ['src/other.js'], ancestorOf: [sha('c')] },
};
const stdGit = () => scriptGit(STD_COMMITS);
const stdProof = (git = stdGit()) => ({ git, mainSha: MAIN });

/** A git that proves every SHA on main for src/a.js, and one that knows none (T1 runs under both). */
function yesGit(args) {
  if (args[0] === 'rev-parse') {
    const ref = String(args.at(-1)).replace(/\^\{commit\}$/, '');
    if (ref === 'main') return { status: 0, stdout: `${MAIN}\n` };
    return HEX_REF.test(ref) ? { status: 0, stdout: `${full(ref)}\n` } : { status: 1, stdout: '' };
  }
  // The main check passes; the finding-commit check (any other second commit) says "not an ancestor".
  if (args[0] === 'merge-base') return { status: args[3] === MAIN ? 0 : 1, stdout: '' };
  return args[0] === 'diff-tree' ? { status: 0, stdout: 'src/a.js\0' } : { status: 129, stdout: '' };
}
const noneGit = (args) => (args[0] === 'rev-parse' && args.at(-1) === 'main^{commit}' ? { status: 0, stdout: `${MAIN}\n` } : { status: 1, stdout: '' });

const temps = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(process.env.REVIEW_EVAL_TMP || os.tmpdir(), 'dispositions-'));
  temps.push(dir);
  return dir;
};
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const NOW = new Date(2026, 10, 11, 12, 0, 0).getTime();
async function run(argv, { gh, git, home = tmp(), now = NOW } = {}) {
  // A test with no stub gh or no stub git must fail here, never reach the live gh or the real repo.
  if (typeof gh !== 'function') throw new Error('run() needs a stub gh');
  if (typeof git !== 'function') throw new Error('run() needs a stub git');
  const out = [];
  const err = [];
  const code = await main(argv, { gh, git, homedir: home, now: () => now, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
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
  reply({ id: 32005, to: 31007, body: 'Done.' }),
  reply({ id: 32006, to: 31007, body: 'Not yet.' }),
  root({ id: 31008, user: DEV, body: 'a human note' }),
];
const stdGh = () => makeGh({ prs: [prRow(90001)], comments: STD_COMMENTS });

/** The decision for one finding (path src/a.js) with these trusted reply bodies, in time order. */
function decideBodies(bodies, { proof = stdProof(), body } = {}) {
  const replies = bodies.map((b, i) => reply({ id: i + 1, to: 1, body: b, at: `2026-01-0${2 + Math.min(i, 7)}T00:00:00Z` }));
  return decide({ root: root({ id: 1, ...(body ? { body } : {}) }), replies, trusted: TRUSTED, proof });
}
const brief = (d) => [d.disposition, d.evidence, d.reason];
const G1_FORM = (s) => ({ form: 'g1', sha: s });
const G2_FORM = (disposition) => ({ form: 'g2', disposition, evidence: { fixed: 'reply_no_sha', wont_fix: 'reply_wont_fix', wrong: 'reply_wrong' }[disposition] });
const NONE = (reason) => ({ form: null, reason });
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// ---- T1: the corpus of both seat review rounds ------------------------------------------------------------------------------

// Made-up reply sentences from the two review rounds (wf_b0755f06-536, wf_54659a5e-94d). Each with the outcome of the grammar:
// U unlabeled, F fixed (G2, no SHA), W wont_fix, X wrong, G fixed with a SHA that git proves (G1).
// S: G1 where the words after the SHA cast doubt; the seat's G1 ruling labels them (the commit changed the file: verdict real).
const U = 'unlabeled';
const F = 'fixed';
const W = 'wont_fix';
const X = 'wrong';
const G = 'fixed (git)';
const S = 'fixed (git, seat G1 ruling)';
const CORPUS = [
  ['This is not a false positive', U], ['Is this a false positive?', U], ["I don't think it's a false positive", U], ['That was not intentional', U],
  ['No follow-up needed', U], ['not out of scope', U], ['Is this out of scope?', U], ['Will you wontfix this?', U], ['done? no', U],
  ['applied to another file', U], ['Fixed in a1b2c3d? No', U], ['Was this done? Not yet', U], ['Done? No.', U], ['Fixed? Not really.', U],
  ['Nothing done yet', U], ['If applied, this would break the build', U], ["I'm done reviewing", U], ['not fixed', U], ['Is it fixed?', U],
  ['Fixed; out of scope for the rest', U], ['wontfix', W], ['Fi\u200Bxed', F], ['Addressed in commit deadbeef', G], ['Addressed in commit a1b2c3d', G],
  ['not fixed yet', U], ['will be fixed in a1b2c3d', U], ['Is this fixed?', U], ['Not fixed', U], ['Will fix later', U],
  ["I don't think this is wrong", U], ['not a false positive', U], ['Is it a false positive?', U], ['This is a false-positive? No, real.', U],
  ["You're right, this is incorrect.", U], ["Good catch, it doesn't apply the limit there", U], ['Good catch, that is wrong', U],
  ['Agreed: this was wrong. Will push a change.', U], ['This is not intentional', U], ['It is not out of scope', U], ["This won't change behavior", U],
  ['Not deferred', U], ['We will not defer this', U], ['fixed? no.', U], ['Was this fixed in a1b2c3d? Checking.', U], ['Unsure if fixed', U],
  ['This must be fixed', U], ['I am done reviewing', U], ['~~Fixed~~ not yet', U], ['Done? Not yet', U], ['No idea if this got fixed', U],
  ['Fixed the other one, not this', U], ['**Major**\n\nThe earlier issue is still not addressed in commit a1b2c3d.', U], ['Not addressed in commit a1b2c3d', U],
  ['Fixed in a1b2c3d', G], ['Sorry, not fixed yet, reverted', U], ['Reverted that commit', U], ['Actually this is still broken', U],
  ['WONT FIX', W], ['wont fix', W], ["won't-fix", U], ['Not fixing this', U], ['Not a bug', U], ['False alarm', U], ['Corrig\u00E9', U],
  ['Corregido en a1b2c3d', U], ['\u4FEE\u6B63\u3057\u307E\u3057\u305F', U], ['Fixed, I moved the defer statement', U],
  ['Fixed in a1b2c3d (follow-up to the earlier change)', G], ["Fixed in a1b2c3d. This won't change the public API.", G],
  ['Good catch, this is incorrect. Fixed in a1b2c3d', U], ['Fixed the color to #ff00ff80', U], ['Fixed for row 3f2a9c1e-77aa-...', U],
  ['Fixed (see e2e2e2e run)', U], ['fixed in https://github.com/other/repo/commit/a1b2c3d', U], ['Addressed in commit 4790123', G],
  ['Partially fixed', U], ['Maybe fixed', U], ['I think this is fixed', U], ['This was already fixed', U],
  ['This is incorrect', U], ["won't fix", W], ['<!-- fixed --> thanks', U],
  ['will fix later', U], ['should be fixed in a1b2c3d', U], ['is this fixed?', U], ['this is not wrong', U], ["Why won't you fix this?", U],
  ['Not a false positive, fixing now', U], ['This is not by design', U], ['Is this intentional?', U], ['Is this not applicable?', U],
  ['Good catch, it does not apply the cap. Fixed in abc1234', U], ["Yes, this is wrong, I'll change it", U], ['false positive', X],
  ['Not a false positive', U], ["This isn't a false positive, good catch", U], ['False positive', X], ['That was not intentional, thanks', U],
  ['I will get it done', U], ["I'll get it done", U], ["We'll have this resolved in the next release", U], ['Please confirm this is fixed.', U],
  ['Has this been resolved', U], ['Let me know once it is applied', U], ['to be resolved soon', U], ['Is it fixed? I think not', U],
  ['Has this been fixed', U], ['Once this is fixed we can merge', U], ['Please confirm if fixed', U], ['Not sure this is fixed', U],
  ['Not yet fixed', U], ['done reviewing', U], ['must be fixed', U], ["This isn't a false positive", U], ['this is wrong', U], ["It's not wrong", U],
  ["It's not intentional, good catch", U], ["won't change behavior", U], ['Not intentional, fixed in a1b2c3d', U], ["This isn't by design", U],
  ['Not a follow-up', U], ["This won't change the public API", U], ['Intentional', W], ['Out of scope', W], ["We won't change it", U],
  ["won't address in this PR", U], ['will be addressed later', U], ["It'll be addressed in a follow-up commit", U],
  ['We will have this resolved in the next release', U], ["I'll get it fixed later", U], ["they'll be fixed soon", U], ["I'd have it done", U],
  ['not intentional', U], ['Not by design', U], ['Not out of scope', U], ['Fixed. Not a false positive', U], ['Not a false positive, will fix next PR', U],
  ['Not out of scope, good catch', U], ['Not by design, my mistake', U], ['Addressed in commits 1a2b3c4 to 5d6e7f8', U], ['This is not\nfixed', U],
  ['Thanks. I looked again and the change has not\nfixed the null path in a1b2c3d, reopening.', U], ['Nothing here is\nresolved', U],
  ['Done\nreviewing this file, more later', U], ['Done. Wait, the test fails.', U], ['I thought this was fixed. It is not.', U],
  ['Fixed in a1b2c3d. Actually, it is broken again.', S], ['Fixed. Never mind, wrong thread.', U], ['Done. Oops, wrong thread.', U],
  ['Resolved. Nope, it came back.', U], ['Done. No wait.', U], ['Was hoping a1b2c3d fixed it; it did not', U], ['resolved without a change', U],
  ['no change needed', U], ['isnt fixed', U], ['wasnt addressed', U], ['havent fixed it', U], ['Hasnt been fixed', U], ['isn\u00B4t fixed', U],
  ['isn\u02BCt fixed', U], ['Fixed none of it', U], ['Fixed neither case', U], ['I doubt this is resolved', U], ['The fix in a1b2c3d failed', U],
  ['Resolved without a change: the value is validated above.', U], ['Resolved; no change needed.', U], ['Resolved. Keeping the current code.', U],
  ['Fixed the wrong file, sorry', U], ['Is this fixed', U], ['Was this addressed', U], ['Any chance this got fixed', U], ['Fixed\uFF1F', U],
  ['Fixed in a1b2c3d\uFF1F', U], ['Was this by design', U], ['`Addressed in commit a1b2c3d` is what the bot claims; still broken.', U],
  ['<details><summary>bot</summary>\n\nAddressed in commit a1b2c3d\n</details>\nStill seeing this.', U],
  ['<blockquote>\nAddressed in commit a1b2c3d\n</blockquote>\nThis is still open.', U], ['x\n\n    Addressed in commit a1b2c3d\n\nStill open.', U],
  ['- > Fixed in a1b2c3d\n\nStill open.', U], ['~~Done.\nApplied.~~\nNot yet, sorry.', U], ['<del>\nFixed in a1b2c3d\n</del>\nNot yet.', U],
  ['No false positive, good catch!', U], ['Hardly a false positive', U], ['No false positive here.', U], ['none of this is by design', U],
  ['Far from intentional', U], ['Defer to the suggestion; updated.', U], ['I defer to the bot here', U],
  ["Your suggestion won't fix it; went with a different approach in a1b2c3d", U], ["The comment doesn't apply anymore", U],
  ['This comment does not apply after the refactor', U], ['Not applicable anymore, the function was removed in a1b2c3d', U],
  ['The suggestion is wrong, but the issue it points to is real.', U], ['The review is wrong on the line number only; the bug is real.', U],
  ['The finding was wrong about the cause but right about the bug.', U], ['Done reviewing a1b2c3d; the issue remains', U],
  ['Applied a1b2c3d locally, the warning remains.', U], ['Resolved conflicts in a1b2c3d', U], ['fix in decaf00 broke it', U],
  ['Done, ticket abc1234 tracks the rest', U], ['Done 1/3', U], ['2/3 done', U], ['Done 50%', U], ['Applied 0/2', U], ['Done \u274C', U],
  ['Fixed 0 of 3', U], ['Fixed ~3 of 4, ~1 left', U], ['By design.\n\nEdit: changed my mind, updated in a1b2c3d.', U],
  ['Out of scope.\n\nEdit: went ahead and did it in a1b2c3d', U], ['Leaving it as is. Actually no, changed it in a1b2c3d', U], ['By design', W],
  ['Changed my mind, updated in a1b2c3d', U], ['thanks', U], ['Is this really fixed?', U], ['Reverted in b2c3d4e, this broke prod.', U],
  ['Still broken.', U], ['That commit was dropped in the rebase', U], ['ok', U], ['Done.', F], ['Oops, wrong thread.', U],
  ['Thanks, applied the suggestion.', U], ['Good catch, done.', U], ['Nice catch, done', U], ['Applied the suggested change.', U],
  ['Updated, thanks.', U], ['applied the suggestion', U], ['Fixed? No', U], ['Reopening: the fix did not hold', U], ['x\n    Addressed in commit a1b2c3d', U],
  ['Fixed upstream in https://github.com/other/lib/commit/a1b2c3d4e5f6', U], ['Fixed in build 20261111a', U],
  ['Same bug as https://github.com/other/lib/commit/a1b2c3d4e5f6, which fixed it there; here it stays', U], ['Fixed in abc1234.', G],
  ['Good catch, fixed.', U], ["Won't fix, by design.", U], ['False positive, the value is validated above.', U], ['Fixed, thanks!', U],
  ['Addressed in a1b2c3d.', G], ['Out of scope for this PR.', U], ['Resolved.', F], ['This is intentional.', W], ['Not applicable here.', U],
  ['Done in a1b2c3d', G], ['It is not.', U], ['Actually, it is broken again.', U], ['Nope, it came back.', U], ['Fixed. Not really.', U],
  ['Fixed. It is not fixed.', U], ['I thought this was fixed', U], ['doesnt look fixed', U], ['Resolved; no change needed', U], ["isn't fixed", U],
  ['Fixed nothing', U], ['Fixed none of them', U], ['still not\nfixed', U], ['Not sure this is; fixed', U], ['Is this fixed?\nFixed in a1b2c3d', U],
  ['Fixed in a1b2c3d.\nNo, not yet', S], ['- Fixed in a1b2c3d\n- the rest is fine', U], ['This is not fixed', U], ['This is not\r\nfixed', U],
  ['I pulled the branch again and after the last push the null path is still not\nfixed, so I am reopening this thread for another pass.', U],
  ['Thanks for the catch. I looked at this again and I do not think this one is a\nfalse positive after all, the guard really is missing here.', U],
  ['This is not\na false positive', U], ['This was not\nintentional', U], ["I don't think this got\nfixed by the last push.", U],
  ['@coderabbitai is this fixed now', U], ['Is this out of scope', U], ['Is this a false positive', U], ['Was this addressed?', U],
  ['Was this by design?', U], ['Fixed in a1b2c3d?', U], ['@coderabbitai is this fixed now?', U], ['Did this get addressed', U],
  ['Is this intentional', U], ['This is no longer fixed after the rebase', U], ['Done. Wait, not yet.', U], ['Fixed. Actually no, not yet.', U],
  ['This suggestion does not apply after the refactor', U], ['Not applicable anymore', U], ['Fixed in a1b2c3d. The other case still fails.', S],
  ["You're right, this is wrong", U], ["You're right, the finding is wrong", U], ['Fixed?', U], ['Done, thanks.', U], ['Applied.', F],
  ['x\nThe issue is NOT addressed in commit a1b2c3d', U], ['that did not fix it', U], ['<del>Fixed</del>', U],
  ['The finding no longer applies', U], ['This comment does not apply here', U], ['Not applicable', X], ['does not apply here', U],
  ['This comment does not apply now', U], ['Not applicable after the rewrite', U], ['Fixed', F], ['This is not fixed after the rebase', U],
  ['Not fixed anymore...', U], ['No longer fixed after the rebase.', U], ['The fix no longer works; it was resolved before but broke again', U],
  ['Not fixed anymore after the rebase', U], ['Fixed in a1b2c3d. Reverted in b2c3d4e because it broke the build.', S], ['Done. Not yet.', U],
  ['Fixed. No.', U], ['Done. Nope, not yet.', U], ['Fixed. Never mind, not fixed.', U], ['Done. Sorry, not done yet.', U], ['Fixed. Actually, not yet.', U],
  ['Done. Oops, not yet.', U], ['Done! Wait, no.', U], ['Fixed. Sorry, no.', U], ['Fixed. Still broken.', U], ['Fixed. Hmm, not really.', U],
  ['Fixed in a1b2c3d. Actually no, reverted.', S], ['Fixed in a1b2c3d. Then reverted it in b2c3d4e.', S],
  ['Addressed in a1b2c3d. Actually no, that commit was dropped.', S], ['Done. Actually not yet, will push soon.', U],
  ['Fixed. Actually no, I was wrong, it is still there.', U], ['~~Fixed in a1b2c3d~~', U], ['~~Fixed in a1b2c3d.\nAlso updated the tests.~~', U],
  ['~~Fixed in a1b2c3d.\nAlso updated the tests.~~\nReverted, this is back.', U], ['Fixed in a1b2c3d\nNot yet.', S],
  ['> Addressed in commit a1b2c3d\nStill seeing this.', U],
  ['Fixed in `a1b2c3d`', G], ['Addressed in commit a1b2c3d\nStill seeing this.', S], ['Fixed in a1b2c3d\n\nStill open.', S], ['Not yet, sorry.', U],
  ['Not yet.', U], ['~~Done.~~\nNot yet, sorry.', U], ['<del>Fixed in a1b2c3d</del>\nNot yet.', U], ['Fixed in a1b2c3d4e5', G],
  ['_Addressed in commit a1b2c3d_', U], ['Is it resolved now?', U], ['\u2705 Addressed in commit a1b2c3d', U],
  ['<!-- auto-generated -->\n\n\u2705 Addressed in commit a1b2c3d', U],
  // G1: the label means a trusted reply names a commit on main that changes the file; it does not mean the defect is gone.
  ['Fixed in a1b2c3d, maybe', S], ['Fixed in a1b2c3d, then reverted in b2c3d4e', S], ['Addressed in commit a1b2c3d is what the bot claims; still broken.', S],
  // Seat ruling of 2026-11-12: a colon and white space after the SHA ends the token; a colon and any other character does not.
  ['Fixed in a1b2c3d: moved the guard up.', G], ['Fixed in a1b2c3d:src/a.js', U],
];

describe('T1 corpus of both review rounds', () => {
  test('T1 the corpus holds at least 80 distinct sentences', () => {
    // Breaks when: the table is cut or a sentence is listed twice.
    const texts = CORPUS.map(([t]) => t);
    assert.equal(new Set(texts).size, texts.length);
    assert.ok(texts.length >= 80, String(texts.length));
  });

  for (const [text, expect] of CORPUS) {
    test(`T1 ${JSON.stringify(text)} -> ${expect}`, () => {
      // Breaks when: a reply outside G1 or G2 labels, a G2 form stops labeling, or G1 labels with no git proof.
      const yes = decideBodies([text], { proof: { git: yesGit, mainSha: MAIN } });
      const none = decideBodies([text], { proof: { git: noneGit, mainSha: MAIN } });
      const viaGit = expect === G || expect === S;
      assert.equal(yes.disposition, viaGit ? 'fixed' : expect);
      if (viaGit) assert.deepEqual([yes.evidence, yes.rule, none.disposition, none.reason], ['reply_sha_verified', 'g1', 'unlabeled', 'sha_unknown']);
      else assert.deepEqual(brief(none), brief(yes));
      if (expect === F) assert.equal(yes.evidence, 'reply_no_sha');
      if (yes.disposition === 'unlabeled') assert.ok(['reply_extra_text', 'reply_unmatched'].includes(yes.reason), yes.reason);
    });
  }
});

// ---- T2: each grammar form labels; a one-word change does not ----------------------------------------------------------------

describe('T2 grammar forms', () => {
  test('T2 GRAMMAR holds exactly the seat lists, frozen', () => {
    // Breaks when: a list entry is added, dropped or changed without the seat's word.
    assert.deepEqual(GRAMMAR, {
      start: ['fixed', 'addressed', 'resolved', 'done', 'applied'], link: ['in', 'by', 'with', 'via'],
      fixed: ['fixed', 'done', 'applied', 'addressed', 'resolved'],
      wont_fix: ["won't fix", 'wont fix', 'wontfix', 'will not fix', 'by design', 'this is by design', 'intentional', 'this is intentional', 'out of scope'],
      wrong: ['false positive', 'this is a false positive', 'not applicable'],
      courtesy: ['thanks', 'thank you', 'good catch', 'nice catch', 'great catch', 'agreed'],
    });
    assert.ok(Object.isFrozen(GRAMMAR) && Object.values(GRAMMAR).every((l) => Object.isFrozen(l)));
  });

  for (const [word, near] of [['fixed', 'fix'], ['addressed', 'address'], ['resolved', 'resolve'], ['done', 'doing'], ['applied', 'apply']]) {
    test(`T2 G1 start word "${word}" labels; "${near}" does not`, () => {
      // Breaks when: ${word} leaves the start list, or the start word is not anchored to the list.
      assert.deepEqual(parseReply(`${cap(word)} in a1b2c3d`), G1_FORM('a1b2c3d'));
      assert.deepEqual(parseReply(`${word.toUpperCase()} IN A1B2C3D`), G1_FORM('a1b2c3d'));
      assert.deepEqual(brief(decideBodies([`${cap(word)} in a1b2c3d`])), ['fixed', 'reply_sha_verified', null]);
      assert.deepEqual(parseReply(`${cap(near)} in a1b2c3d`), NONE('reply_unmatched'));
    });
  }

  for (const [word, near] of [['in', 'into'], ['by', 'after'], ['with', 'within'], ['via', 'from']]) {
    test(`T2 G1 link word "${word}" labels; "${near}" does not`, () => {
      // Breaks when: ${word} leaves the link list, or any word passes as the link.
      assert.deepEqual(parseReply(`Fixed ${word} a1b2c3d`), G1_FORM('a1b2c3d'));
      assert.deepEqual(parseReply(`Fixed ${near} a1b2c3d`), NONE('reply_unmatched'));
    });
  }

  test('T2 G1 the optional word commit; "commits" does not pass', () => {
    // Breaks when: the commit word is required, or a plural slips in.
    assert.deepEqual(parseReply('Addressed in commit a1b2c3d'), G1_FORM('a1b2c3d'));
    assert.deepEqual(parseReply('Fixed in commits a1b2c3d'), NONE('reply_unmatched'));
  });

  test('T2 G1 the SHA in one pair of backticks labels; a lone, a doubled or a wider pair does not', () => {
    // Breaks when: the backtick pair is dropped from the pattern, or other markup is let in (seat ruling of 2026-11-12: one pair around the SHA).
    assert.deepEqual(parseReply('Fixed in `a1b2c3d`'), G1_FORM('a1b2c3d'));
    assert.deepEqual(parseReply('Fixed in commit `A1B2C3D`.'), G1_FORM('a1b2c3d'));
    for (const t of ['Fixed in `a1b2c3d', 'Fixed in a1b2c3d`', 'Fixed in ``a1b2c3d``', 'Fixed `in a1b2c3d`', 'Fixed in `a1b2c3d` and `b2c3d4e`', 'Fixed in `commit a1b2c3d`']) {
      assert.deepEqual(parseReply(t), NONE('reply_extra_text'), t);
    }
  });

  test('T2 G1 the SHA is 7 to 40 hex characters with a clean end', () => {
    // Breaks when: the length bounds or the end check after the hex run change.
    assert.deepEqual(parseReply(`Fixed in ${'a1'.repeat(20)}`), G1_FORM('a1'.repeat(20)));
    for (const t of ['Fixed in a1b2c3', `Fixed in ${'a1'.repeat(20)}a`, 'Fixed in a1b2c3dz', 'Fixed in a1b2c3d-x']) assert.notEqual(parseReply(t).form, 'g1', t);
  });

  test('T2 G1 is anchored at the start of the cleaned reply', () => {
    // Breaks when: the ^ anchor is dropped (a fix phrase inside a sentence would label).
    for (const t of ['Yes. Fixed in a1b2c3d', 'I fixed in a1b2c3d', 'Not fixed in a1b2c3d', 'Was this fixed in a1b2c3d']) assert.deepEqual(parseReply(t), NONE('reply_unmatched'), t);
    assert.deepEqual(parseReply('\n\n  Fixed in a1b2c3d'), G1_FORM('a1b2c3d'));
  });

  test('T2 G1 refuses a question mark (ASCII or fullwidth) or a markup character in the first sentence', () => {
    // Breaks when: the first-sentence check of G1 is dropped or misses a character.
    const bad = ['Fixed in a1b2c3d?', 'Fixed in a1b2c3d\uFF1F', 'Fixed in a1b2c3d, right?', 'Fixed in a1b2c3d see `x`', 'Fixed in a1b2c3d <b>', 'Fixed in a1b2c3d >',
      'Fixed in a1b2c3d ~ok', 'Fixed in a1b2c3d *now*', 'Fixed in a1b2c3d _now_', 'Fixed in **a1b2c3d**'];
    for (const t of bad) assert.deepEqual(parseReply(t), NONE('reply_extra_text'), t);
  });

  test('T2 G1 refuses an HTML entity and every other question mark that GitHub shows', () => {
    // Breaks when: & leaves the markup class, or a question mark leaves the ASK class.
    const marks = ['\u00BF', '\u037E', '\u061F', '\u203D', '\u2047', '\u2048', '\u2049', '\u2E2E', '\uFE56'];
    for (const t of ['Fixed in a1b2c3d&#63;', 'Fixed in a1b2c3d &#x3F;', 'Fixed in a1b2c3d &quest;', ...marks.map((m) => `Fixed in a1b2c3d${m}`), ...marks.map((m) => `Fixed in a1b2c3d, ok${m}`)]) {
      assert.deepEqual(parseReply(t), NONE('reply_extra_text'), JSON.stringify(t));
    }
    assert.equal(parseReply('Done &amp; thanks').form, null);
  });

  test('T2 G1 the SHA ends at white space, a comma, a semicolon, a closing parenthesis, or a final . or !', () => {
    // Breaks when: the token end check after the SHA is dropped (a parent, a range or a path would label on the first SHA).
    for (const t of ['Fixed in a1b2c3d^', 'Fixed in a1b2c3d^2', 'Fixed in a1b2c3d..b2c3d4e', 'Fixed in a1b2c3d...b2c3d4e', 'Fixed in a1b2c3d:src/a.js', 'Fixed in a1b2c3d@{1}',
      'Fixed in a1b2c3d.b', 'Fixed in a1b2c3d=', "Fixed in a1b2c3d'", 'Fixed in a1b2c3d~1', 'Fixed in `a1b2c3d`^']) {
      assert.deepEqual(parseReply(t), NONE('reply_extra_text'), t);
    }
    for (const t of ['Fixed in a1b2c3d', 'Fixed in a1b2c3d.', 'Fixed in a1b2c3d!', 'Fixed in a1b2c3d (x)', 'Fixed in a1b2c3d)', 'Fixed in a1b2c3d\tok', 'Fixed in a1b2c3d.\nNo.', 'Fixed in `a1b2c3d`.']) {
      assert.deepEqual(parseReply(t), G1_FORM('a1b2c3d'), t);
    }
  });

  test('T2 G1 a colon then white space or the end of the first sentence ends the SHA: it labels when git proves it', () => {
    // Breaks when: the colon form leaves SHA_END (seat ruling of 2026-11-12), or it needs more than white space or the end after it.
    for (const t of ['Fixed in a1b2c3d: moved the guard up', 'Fixed in a1b2c3d:\tok', 'Fixed in a1b2c3d:', 'Fixed in a1b2c3d:\nmore text', 'Fixed in `a1b2c3d`: moved it']) {
      assert.deepEqual(parseReply(t), G1_FORM('a1b2c3d'), JSON.stringify(t));
    }
    const d = decideBodies(['Fixed in a1b2c3d: moved the guard up']);
    assert.deepEqual([d.disposition, d.evidence, d.rule, d.sha], ['fixed', 'reply_sha_verified', 'g1', full('a1b2c3d')]);
  });

  test('T2 G1 a colon then a non-space character is reply_extra_text (a path or a second SHA)', () => {
    // Breaks when: the colon form passes without the white space or end check (a1b2c3d:path names a blob, not one commit).
    for (const t of ['Fixed in a1b2c3d:path/x.js', 'Fixed in a1b2c3d:b2c3d4e', 'Fixed in a1b2c3d::', 'Fixed in a1b2c3d:.', 'Fixed in `a1b2c3d`:x']) {
      assert.deepEqual(parseReply(t), NONE('reply_extra_text'), t);
    }
    assert.deepEqual(brief(decideBodies(['Fixed in a1b2c3d:path/x.js'])), ['unlabeled', null, 'reply_extra_text']);
  });

  test('T2 G1 does not read past the first sentence', () => {
    // Breaks when: the first sentence ends at a comma or a semicolon, or the rest is read (seat: the label rests on the commit).
    for (const t of ['Fixed in a1b2c3d. Is this ok?', 'Fixed in a1b2c3d.\n`code` here', 'Fixed in a1b2c3d!\nNo.', 'Fixed in a1b2c3d\n> quoted?']) {
      assert.deepEqual(parseReply(t), G1_FORM('a1b2c3d'), t);
    }
    assert.deepEqual(parseReply('Fixed in a1b2c3d, ok? yes.'), NONE('reply_extra_text'));
    assert.deepEqual(parseReply('Fixed in a1b2c3d; really?'), NONE('reply_extra_text'));
  });

  const LISTS = [
    ['fixed', 'fixed'], ['done', 'fixed'], ['applied', 'fixed'], ['addressed', 'fixed'], ['resolved', 'fixed'],
    ["won't fix", 'wont_fix'], ['wont fix', 'wont_fix'], ['wontfix', 'wont_fix'], ['will not fix', 'wont_fix'], ['by design', 'wont_fix'],
    ['this is by design', 'wont_fix'], ['intentional', 'wont_fix'], ['this is intentional', 'wont_fix'], ['out of scope', 'wont_fix'],
    ['false positive', 'wrong'], ['this is a false positive', 'wrong'], ['not applicable', 'wrong'],
  ];
  for (const [entry, disposition] of LISTS) {
    test(`T2 G2 "${entry}" gives ${disposition}; "${entry} here" does not`, () => {
      // Breaks when: the entry leaves its list or moves to another, or the compare is not on the whole reply.
      for (const t of [entry, cap(entry), `${cap(entry)}.`, `${cap(entry)}!`, `  ${entry.toUpperCase()}  `]) assert.deepEqual(parseReply(t), G2_FORM(disposition), t);
      assert.deepEqual(brief(decideBodies([`${cap(entry)}.`])), [disposition, G2_FORM(disposition).evidence, null]);
      assert.equal(parseReply(`${entry} here`).form, null);
    });
  }

  for (const c of ['thanks', 'thank you', 'good catch', 'nice catch', 'great catch', 'agreed']) {
    test(`T2 G2 courtesy "${c}" may stand before or after; "${c} all" may not`, () => {
      // Breaks when: ${c} leaves the courtesy list, or courtesy is matched as a prefix.
      assert.deepEqual(parseReply(`${cap(c)}. Done.`), G2_FORM('fixed'));
      assert.deepEqual(parseReply(`False positive.\n${cap(c)}!`), G2_FORM('wrong'));
      assert.deepEqual(parseReply(`${cap(c)}!`), { form: 'courtesy' });
      assert.deepEqual(parseReply(`${cap(c)} all. Done.`), NONE('reply_unmatched'));
    });
  }

  for (const [name, mark] of [['U+0027', "'"], ['U+2018', '\u2018'], ['U+2019', '\u2019'], ['U+00B4', '\u00B4'], ['U+02BC', '\u02BC']]) {
    test(`T2 G2 the apostrophe ${name} folds: "won${mark}t fix" gives wont_fix; "won${mark}t fix it" does not`, () => {
      // Breaks when: ${name} is dropped from the apostrophe fold.
      assert.deepEqual(parseReply(`Won${mark}t fix.`), G2_FORM('wont_fix'));
      assert.equal(parseReply(`Won${mark}t fix it.`).form, null);
    });
  }

  test('T2 G2 exactly one list sentence: a second list sentence or extra text gives reply_extra_text', () => {
    // Breaks when: G2 takes the first list sentence and ignores the rest.
    for (const t of ['Done. Not yet.', 'Done. Fixed.', "Won't fix. By design.", 'Thanks. Done. Wait, no.', 'Good catch.\nFixed.\nNot yet.']) assert.deepEqual(parseReply(t), NONE('reply_extra_text'), t);
  });

  test('T2 G2 a comma or a semicolon is no sentence break', () => {
    // Breaks when: the sentence cut takes a comma or a semicolon (the grammar would widen without the seat's word).
    for (const t of ['Done, thanks.', 'Good catch, done.', "Won't fix, by design.", 'Resolved; no change needed.']) assert.equal(parseReply(t).form, null, t);
  });

  test('T2 G2 any markup character in the reply gives no G2', () => {
    // Breaks when: the markup check of G2 is dropped.
    for (const t of ['`Done`', '**Done**', 'Done. <!-- x -->', '_Done_', '~Done~ ok', 'Done. a > b']) assert.notEqual(parseReply(t).form, 'g2', t);
    assert.deepEqual(parseReply('`Done`'), NONE('reply_extra_text'));
  });

  test('T2 parseReply on empty or non-string input is unmatched and never throws', () => {
    // Breaks when: cleanReply or parseReply assumes a string.
    for (const v of [undefined, null, '', '   ', 42, {}]) assert.deepEqual(parseReply(v), NONE('reply_unmatched'));
  });
});

// ---- cleaning ---------------------------------------------------------------------------------------------------------------

describe('cleanReply', () => {
  test('F16 quoted lines and fenced blocks are not read', () => {
    // Breaks when: cleanReply keeps quoted lines or fenced code.
    assert.equal(cleanReply('a\n> b\n```\nc\n```\nd'), 'a\n\nd');
    assert.deepEqual(parseReply("> won't fix\n\nFixed in a1b2c3d"), G1_FORM('a1b2c3d'));
    assert.deepEqual(parseReply("```\nwon't fix\n```\nDone"), G2_FORM('fixed'));
    assert.deepEqual(parseReply('> Fixed in a1b2c3d\nwhy?'), NONE('reply_unmatched'));
  });

  test('a quoted paragraph runs on to the next blank line or fence: its lazy lines are not read', () => {
    // Breaks when: only the > line is dropped (GitHub shows the next line inside the quote, but G1 or G2 reads it).
    for (const t of ['> quoted text\nFixed in a1b2c3d', "> won't fix\nFixed in a1b2c3d"]) assert.deepEqual(parseReply(t), NONE('reply_unmatched'), t);
    assert.deepEqual(parseReply('Thanks!\n> quote\nFalse positive'), { form: 'courtesy' });
    assert.deepEqual(brief(decideBodies(['Thanks!\n> quote\nFalse positive'])), ['unlabeled', null, 'reply_unmatched']);
    assert.equal(cleanReply('a\n> b\nc\n\nd'), 'a\n\nd');
    assert.deepEqual(parseReply('> q\n\nFixed in a1b2c3d'), G1_FORM('a1b2c3d'));
    assert.deepEqual(parseReply('> q\n```\nx\n```\nDone'), G2_FORM('fixed'));
    assert.deepEqual(brief(decideBodies(['> quoted text\nFixed in a1b2c3d'])), ['unlabeled', null, 'reply_unmatched']);
  });

  test('a quote ends only at a raw line of spaces and tabs: a zero-width or no-break space line is quote text', () => {
    // Breaks when: the blank test runs after the zero-width strip, or takes any white space (\s holds U+00A0 and U+FEFF).
    for (const t of ['> q\n\u200B\nFixed in a1b2c3d', '> q\n\u00A0\nFixed in a1b2c3d', '> q\n\uFEFF\nFixed in a1b2c3d']) assert.deepEqual(parseReply(t), NONE('reply_unmatched'), JSON.stringify(t));
    assert.deepEqual(parseReply('> q\n \t\nFixed in a1b2c3d'), G1_FORM('a1b2c3d'));
  });

  test('a fence is a CommonMark fence: up to three spaces, no backtick in a backtick info string, a close as long and with no info', () => {
    // Breaks when: fenceOf takes any indent or any line with three marks, or a close may be shorter or hold text (GitHub shows
    // the lines as prose or as code, and the reply would be read the other way).
    for (const t of ['> q\n``` ```\nFixed in a1b2c3d', '> q\n    ```\nx\n    ```\nFixed in a1b2c3d', '~~~ x ~~~\nFixed in a1b2c3d', '```\n``` x\nFixed in a1b2c3d\n```',
      '````\n```\nFixed in a1b2c3d\n````', '\u200B```\nx\n```\nFixed in a1b2c3d']) {
      assert.notEqual(parseReply(t).form, 'g1', JSON.stringify(t));
    }
    assert.deepEqual(parseReply('Done.\n``` not yet ```'), NONE('reply_extra_text'));
    assert.deepEqual(parseReply('Done.\n    ```\nNot yet\n    ```'), NONE('reply_extra_text'));
    assert.deepEqual(parseReply('   ```\nx\n   ```\nDone'), G2_FORM('fixed'));
    assert.deepEqual(parseReply('```js\nx\n```  \nDone'), G2_FORM('fixed'));
  });

  test('an indented code block (four spaces or a tab, at the start, after a blank line or after a fence) is not read', () => {
    // Breaks when: the indented-code drop is missing (trim would lift the code block into the reply) or it takes an indented paragraph line.
    const code = ['    Addressed in commit a1b2c3d', '\tFixed in a1b2c3d', '  \tFixed in a1b2c3d', '    False positive', '\n    Done.', 'Thanks.\n\n    Fixed in a1b2c3d',
      'Thanks!\n```\nx\n```\n    False positive', '    x\n    Done.'];
    for (const t of code) assert.ok(['reply_unmatched', undefined].includes(parseReply(t).reason) && !['g1', 'g2'].includes(parseReply(t).form), JSON.stringify(t));
    assert.deepEqual(brief(decideBodies(['    False positive'])), ['unlabeled', null, 'reply_unmatched']);
    assert.deepEqual(brief(decideBodies(['    Fixed in a1b2c3d'])), ['unlabeled', null, 'reply_unmatched']);
    assert.equal(cleanReply('a\n\n    code\n    more\n\n    again\nb\n    lazy'), 'a\n\n\nb\n    lazy');
    for (const t of ['   Fixed in a1b2c3d', '\n\n  Fixed in a1b2c3d']) assert.deepEqual(parseReply(t), G1_FORM('a1b2c3d'), t);
    assert.deepEqual(parseReply('   False positive'), G2_FORM('wrong'));
    // A zero-width space before the indent makes a paragraph line: GitHub shows "Done." as prose, so it reads as prose.
    assert.deepEqual(parseReply('\u200B    Done.'), G2_FORM('fixed'));
  });

  test('R10 tilde fences and struck-through text are not read', () => {
    // Breaks when: cleanReply keeps a ~~~ fence or ~~struck~~ or <del> text.
    assert.equal(cleanReply('a\n~~~\nb\n~~~\nc'), 'a\n\nc');
    assert.equal(cleanReply('a\n~~~ js\nb\n```\nc\n~~~\nd'), 'a\n\nd');
    assert.deepEqual(parseReply("~~Won't fix~~ Done"), G2_FORM('fixed'));
    assert.deepEqual(parseReply("<del>Won't fix</del> Done"), G2_FORM('fixed'));
    assert.deepEqual(parseReply('~~Fixed in a1b2c3d~~'), NONE('reply_unmatched'));
    assert.deepEqual(parseReply('<del class="x">Fixed in <b>a1b2c3d</b></del>'), NONE('reply_unmatched'));
  });

  test('a zero-width character and the four apostrophe forms are folded', () => {
    // Breaks when: the zero-width strip or an apostrophe fold is dropped from cleanReply.
    assert.equal(cleanReply('Fi\u200Bxed won\u2018t won\u2019t won\u00B4t won\u02BCt'), "Fixed won't won't won't won't");
  });
});

// ---- T3: G1 and its git evidence --------------------------------------------------------------------------------------------

describe('T3 G1 git evidence', () => {
  // original: the finding's original_commit_id (root() uses sha('c')).
  const ev = (s, { git = stdGit(), file = 'src/a.js', mainSha = MAIN, original = sha('c') } = {}) => shaEvidence({ git, sha: s, file, mainSha, original });

  test('T3 found, on main, newer than the finding commit, and it changes the file: fixed reply_sha_verified with the full SHA', () => {
    // Breaks when: a git check passes on the wrong status, or the full SHA is not kept.
    const git = stdGit();
    assert.deepEqual(ev('a1b2c3d', { git }), { sha: full('a1b2c3d') });
    assert.deepEqual(git.calls, [
      ['rev-parse', '--verify', '--quiet', 'a1b2c3d^{commit}'], ['merge-base', '--is-ancestor', full('a1b2c3d'), MAIN],
      ['merge-base', '--is-ancestor', full('a1b2c3d'), sha('c')], ['diff-tree', '-r', '-m', '--root', '--no-commit-id', '--name-only', '-z', full('a1b2c3d')],
    ]);
    const d = decideBodies(['Fixed in a1b2c3d']);
    assert.deepEqual([d.disposition, d.evidence, d.sha, d.rule, d.replyId], ['fixed', 'reply_sha_verified', full('a1b2c3d'), 'g1', 1]);
  });

  test('T3 found, but the commit changes other files only: sha_other_file (exact path compare)', () => {
    // Breaks when: the file check is dropped, or it compares a prefix (src/a.jsx is not src/a.js).
    assert.deepEqual(ev('b2c3d4e'), { reason: 'sha_other_file' });
    assert.deepEqual(brief(decideBodies(['Fixed in b2c3d4e'])), ['unlabeled', null, 'sha_other_file']);
  });

  test('T3 a commit that is not an ancestor of the main ref: sha_unknown', () => {
    // Breaks when: the ancestor check is dropped, or status 1 passes.
    assert.deepEqual(ev('c3d4e5f'), { reason: 'sha_unknown' });
    assert.deepEqual(brief(decideBodies(['Fixed in c3d4e5f'])), ['unlabeled', null, 'sha_unknown']);
  });

  test('T3 a SHA that names no commit: sha_unknown', () => {
    // Breaks when: a failed rev-parse passes.
    assert.deepEqual(ev('fffffff'), { reason: 'sha_unknown' });
    assert.deepEqual(brief(decideBodies(['Fixed in fffffff'])), ['unlabeled', null, 'sha_unknown']);
  });

  test('T3 a short SHA that two commits match: sha_unknown', () => {
    // Breaks when: an ambiguous rev-parse is read as a hit.
    assert.deepEqual(ev('d4e5f6a'), { reason: 'sha_unknown' });
    assert.deepEqual(ev('d4e5f6a1'), { sha: full('d4e5f6a1') });
  });

  test('T3 a ref that resolves to a commit with another SHA is no proof', () => {
    // Breaks when: the full SHA is not checked against the SHA of the reply (a branch named like a hex word).
    const git = scriptGit(STD_COMMITS, { refs: { main: MAIN, abcdef1: full('a1b2c3d') } });
    assert.deepEqual(ev('abcdef1', { git }), { reason: 'sha_unknown' });
  });

  test('T3 a merge commit: its files count through -m', () => {
    // Breaks when: -m is dropped (diff-tree lists nothing for a merge).
    assert.deepEqual(ev('e5f6a7b'), { sha: full('e5f6a7b') });
  });

  test('T3 a root commit, a nested path and a non-ASCII path count (--root, -r, -z)', () => {
    // Breaks when: --root, -r or -z is dropped (no list, the top folder only, or a quoted name).
    assert.deepEqual(ev('f6a7b8c'), { sha: full('f6a7b8c') });
    assert.deepEqual(ev('a7b8c9d', { file: 'src/caf\u00E9.js' }), { sha: full('a7b8c9d') });
    assert.deepEqual(ev('a1b2c3d', { file: 'src' }), { reason: 'sha_other_file' });
  });

  test('T3 git itself fails: sha_unknown, never a label', () => {
    // Breaks when: a failed or thrown git call reads as a pass or as sha_other_file.
    for (const fail of ['rev-parse', 'merge-base', 'diff-tree', 'throw']) {
      assert.deepEqual(ev('a1b2c3d', { git: scriptGit(STD_COMMITS, { fail }) }), { reason: 'sha_unknown' }, fail);
      assert.deepEqual(brief(decideBodies(['Fixed in a1b2c3d'], { proof: stdProof(scriptGit(STD_COMMITS, { fail })) })), ['unlabeled', null, 'sha_unknown'], fail);
    }
    assert.deepEqual(ev('a1b2c3d', { git: null }), { reason: 'sha_unknown' });
    assert.deepEqual(ev('a1b2c3d', { mainSha: null }), { reason: 'sha_unknown' });
    assert.deepEqual(brief(decideBodies(['Fixed in a1b2c3d'], { proof: null })), ['unlabeled', null, 'sha_unknown']);
  });

  test('T3 an empty or odd file or SHA is no proof', () => {
    // Breaks when: an empty path matches the empty tail of the NUL list, or a non-hex SHA reaches git.
    assert.deepEqual(ev('a1b2c3d', { file: '' }), { reason: 'sha_unknown' });
    const git = stdGit();
    assert.deepEqual(ev('--all', { git }), { reason: 'sha_unknown' });
    assert.equal(git.calls.length, 0);
  });

  test('T3 N1 the SHA is the finding commit itself: sha_not_newer, with no git call on the finding commit', () => {
    // Breaks when: the equal check is dropped (real git answers 0 for a commit against itself; the call list pins the check).
    const git = stdGit();
    assert.deepEqual(ev('a1b2c3d', { git, original: full('a1b2c3d') }), { reason: 'sha_not_newer' });
    assert.deepEqual(git.calls, [['rev-parse', '--verify', '--quiet', 'a1b2c3d^{commit}'], ['merge-base', '--is-ancestor', full('a1b2c3d'), MAIN]]);
    assert.deepEqual(ev('a1b2c3d', { original: full('a1b2c3d').toUpperCase() }), { reason: 'sha_not_newer' });
    // decide passes root.original_commit_id: a reply that names the commit the bot reviewed is not a fix.
    const d = decide({ root: root({ id: 1, commit: full('a1b2c3d') }), replies: [reply({ id: 2, to: 1, body: 'Fixed in a1b2c3d' })], trusted: TRUSTED, proof: stdProof() });
    assert.deepEqual(brief(d), ['unlabeled', null, 'sha_not_newer']);
  });

  test('T3 N2 an ancestor of the finding commit (exit 0): sha_not_newer, before the file check', () => {
    // Breaks when: exit 0 of the finding-commit check passes, or the file check runs first (an older commit on another file is not sha_other_file).
    const git = stdGit();
    assert.deepEqual(ev('9a8b7c6', { git }), { reason: 'sha_not_newer' });
    assert.deepEqual(git.calls.at(-1), ['merge-base', '--is-ancestor', full('9a8b7c6'), sha('c')]);
    assert.ok(!git.calls.some((a) => a[0] === 'diff-tree'));
    assert.deepEqual(ev('8b7c6d5'), { reason: 'sha_not_newer' });
    assert.deepEqual(brief(decideBodies(['Fixed in 9a8b7c6'])), ['unlabeled', null, 'sha_not_newer']);
  });

  test('T3 N3 not an ancestor of the finding commit (exit 1): the check passes and the reply labels fixed', () => {
    // Breaks when: exit 1 of the finding-commit check is read as a failure, or the check asks about another commit.
    const git = scriptGit(STD_COMMITS, { newer: 1 });
    assert.deepEqual(ev('a1b2c3d', { git }), { sha: full('a1b2c3d') });
    assert.ok(git.calls.some((a) => a.join(' ') === `merge-base --is-ancestor ${full('a1b2c3d')} ${sha('c')}`));
    assert.deepEqual(brief(decideBodies(['Fixed in a1b2c3d'], { proof: stdProof(scriptGit(STD_COMMITS, { newer: 1 })) })), ['fixed', 'reply_sha_verified', null]);
  });

  test('T3 N4 the finding-commit check fails (exit 128, exit 2, a null result, a throw): sha_unknown, never a pass', () => {
    // Breaks when: every non-zero status passes (tryGit folds 128 and 1 to one value), or a throw or a null result passes.
    for (const newer of [128, 2, -1, 'null', 'throw']) {
      assert.deepEqual(ev('a1b2c3d', { git: scriptGit(STD_COMMITS, { newer }) }), { reason: 'sha_unknown' }, String(newer));
      assert.deepEqual(brief(decideBodies(['Fixed in a1b2c3d'], { proof: stdProof(scriptGit(STD_COMMITS, { newer })) })), ['unlabeled', null, 'sha_unknown'], String(newer));
    }
    const odd = (r) => (args) => (args[0] === 'merge-base' && args[3] === sha('c') ? r : stdGit()(args));
    for (const r of [{ status: null, stdout: '' }, { status: '1', stdout: '' }, { stdout: '' }, undefined]) {
      assert.deepEqual(ev('a1b2c3d', { git: odd(r) }), { reason: 'sha_unknown' }, JSON.stringify(r));
    }
  });

  test('T3 N5 no original_commit_id or a malformed one: sha_unknown, and the id never reaches git', () => {
    // Breaks when: a missing or odd id is skipped (the check would pass on no proof), or an id that is not 40 lowercase hex reaches git.
    // shaEvidence direct: the ev helper fills a missing original with sha('c').
    for (const original of [undefined, null, '', 'abc', sha('z'), 'c'.repeat(39), 'c'.repeat(41), ` ${sha('c')}`, `${sha('c')}\n`, '--all', 7, ['c'.repeat(40)]]) {
      const git = stdGit();
      assert.deepEqual(shaEvidence({ git, sha: 'a1b2c3d', file: 'src/a.js', mainSha: MAIN, original }), { reason: 'sha_unknown' }, JSON.stringify(original));
      assert.equal(git.calls.length, 0, JSON.stringify(original));
    }
    assert.deepEqual(shaEvidence({ git: stdGit(), sha: 'a1b2c3d', file: 'src/a.js', mainSha: MAIN }), { reason: 'sha_unknown' });
    const git = stdGit();
    assert.deepEqual(ev('a1b2c3d', { git, original: sha('C') }), { sha: full('a1b2c3d') });
    assert.ok(git.calls.some((a) => a[0] === 'merge-base' && a[3] === sha('c')));
    assert.deepEqual(brief(decide({ root: root({ id: 1, commit: null }), replies: [reply({ id: 2, to: 1, body: 'Fixed in a1b2c3d' })], trusted: TRUSTED, proof: stdProof() })), ['unlabeled', null, 'sha_unknown']);
  });

  test('mainShaOf resolves the ref once to a full SHA; a bad name or a failed git gives null', () => {
    // Breaks when: the ref is passed without ^{commit}, a name that starts with - reaches git, or a failure passes.
    const git = scriptGit(STD_COMMITS, { refs: { main: MAIN, 'origin/main': sha('d') } });
    assert.equal(mainShaOf(git, 'main'), MAIN);
    assert.equal(mainShaOf(git, 'origin/main'), sha('d'));
    assert.equal(mainShaOf(git, 'nope'), null);
    const before = git.calls.length;
    for (const bad of ['-x', '--all', '', 'a b']) assert.equal(mainShaOf(git, bad), null, bad);
    assert.equal(git.calls.length, before);
    assert.equal(mainShaOf(scriptGit({}, { fail: 'throw' }), 'main'), null);
  });

  test('defaultGit runs git on the repo root, with no replace objects and without the variables that move the repo', () => {
    // Breaks when: GIT_DIR (or a sibling) reaches git and beats -C, the name match is case-sensitive, or --no-replace-objects is dropped.
    const calls = [];
    const spawn = (cmd, argv, opts) => { calls.push({ cmd, argv, opts }); return { status: null, stdout: null }; };
    const moved = ['GIT_DIR', 'Git_Work_Tree', 'git_index_file', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_REPLACE_REF_BASE', 'GIT_NAMESPACE', 'GIT_COMMON_DIR'];
    const env = { PATH: 'p', GIT_AUTHOR_NAME: 'kept', GIT_TERMINAL_PROMPT: '1', ...Object.fromEntries(moved.map((k) => [k, 'x'])) };
    // A spawn with no exit status (an error or a signal) is no status: as exit 1 it would pass the finding-commit check.
    assert.deepEqual(D.defaultGit(['rev-parse', 'x'], { spawn, env }), { status: null, stdout: '' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'git');
    assert.deepEqual(calls[0].argv, ['-C', REPO_ROOT, '--no-replace-objects', 'rev-parse', 'x']);
    assert.deepEqual(calls[0].opts.env, { PATH: 'p', GIT_AUTHOR_NAME: 'kept', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' });
    assert.ok(calls[0].opts.windowsHide && !calls[0].opts.shell);
    assert.equal(env.GIT_DIR, 'x');
  });
});

// ---- G3: later replies, G4: the marker --------------------------------------------------------------------------------------

describe('G3 later trusted replies', () => {
  test('G3 the last grammar reply decides when the labels agree', () => {
    // Breaks when: the first grammar reply decides.
    const d = decideBodies(['Done.', 'Fixed in a1b2c3d']);
    assert.deepEqual([d.disposition, d.evidence, d.replyId], ['fixed', 'reply_sha_verified', 2]);
    const back = decideBodies(['Fixed in a1b2c3d', 'Done.']);
    assert.deepEqual([back.disposition, back.evidence, back.replyId], ['fixed', 'reply_no_sha', 2]);
  });

  test('G3 a later courtesy-only reply keeps the label', () => {
    // Breaks when: a courtesy reply counts as a conflict.
    const d = decideBodies(['False positive', 'Thanks!', 'Good catch.\nAgreed.']);
    assert.deepEqual([d.disposition, d.replyId], ['wrong', 1]);
  });

  test('G3 a later trusted reply outside the grammar gives reply_conflict', () => {
    // Breaks when: a later doubt is skipped (the earlier label would stand).
    for (const later of ['Not yet.', 'that did not fix it', 'Thanks, will look', 'Done, thanks.', '`Done`', '> quote only']) {
      const d = decideBodies(['Fixed in a1b2c3d', later]);
      assert.deepEqual([d.disposition, d.reason, d.rule, d.replyId], ['unlabeled', 'reply_conflict', null, 2], later);
    }
  });

  test('G3 a later G1 reply that git does not prove is a conflict, never skipped', () => {
    // Breaks when: a G1-shaped reply that fails the git check is treated as absent.
    assert.deepEqual(brief(decideBodies(["Won't fix", 'Fixed in fffffff'])), ['unlabeled', null, 'reply_conflict']);
    assert.deepEqual(brief(decideBodies(['Done.', 'Fixed in b2c3d4e'])), ['unlabeled', null, 'reply_conflict']);
  });

  test('G3 two grammar replies with different labels give reply_conflict, in any order', () => {
    // Breaks when: the last label wins over an earlier different one.
    for (const bodies of [["Won't fix", 'Fixed in a1b2c3d'], ['Fixed in a1b2c3d', 'False positive'], ['False positive', 'Thanks', 'By design'], ['Done.', 'Not applicable']]) {
      const d = decideBodies(bodies);
      assert.deepEqual([d.disposition, d.reason, d.replyId], ['unlabeled', 'reply_conflict', bodies.length], bodies.join(' | '));
    }
  });

  test('G3 an earlier reply outside the grammar does not block a later label', () => {
    // Breaks when: any non-grammar reply anywhere gives a conflict.
    assert.deepEqual(brief(decideBodies(['Not yet.', 'Done.'])), ['fixed', 'reply_no_sha', null]);
  });

  test('G3 the order is created_at then id, not array order', () => {
    // Breaks when: replies are read in array order or the (created_at, id) sort is dropped.
    const early = reply({ id: 50, to: 1, body: 'Done.', at: '2026-01-02T00:00:00Z' });
    const late = reply({ id: 40, to: 1, body: 'Not yet.', at: '2026-01-03T00:00:00Z' });
    const sameTimeHigh = reply({ id: 41, to: 1, body: 'Done.', at: '2026-01-03T00:00:00Z' });
    for (const replies of [[late, early], [early, late]]) assert.equal(decide({ root: root({ id: 1 }), replies, trusted: TRUSTED, proof: stdProof() }).reason, 'reply_conflict');
    assert.equal(decide({ root: root({ id: 1 }), replies: [sameTimeHigh, late, early], trusted: TRUSTED, proof: stdProof() }).disposition, 'fixed');
  });

  test('G3 with no label: the reason of the last reply that is not courtesy only; all courtesy is reply_unmatched', () => {
    // Breaks when: the reason comes from the first reply, or a courtesy reply hides a G1 failure.
    assert.deepEqual([...brief(decideBodies(['Fixed in fffffff', 'Thanks'])), decideBodies(['Fixed in fffffff', 'Thanks']).replyId], ['unlabeled', null, 'sha_unknown', 1]);
    assert.deepEqual(brief(decideBodies(['Fixed in fffffff', 'Done. Not yet.'])), ['unlabeled', null, 'reply_extra_text']);
    assert.deepEqual([...brief(decideBodies(['Thanks'])), decideBodies(['Thanks']).replyId], ['unlabeled', null, 'reply_unmatched', null]);
  });

  test('F15 an untrusted human reply is not read', () => {
    // Breaks when: every human counts as trusted.
    const d = decide({ root: root({ id: 1 }), replies: [reply({ id: 1, to: 1, user: STRANGER, body: 'False positive' })], trusted: TRUSTED, proof: stdProof() });
    assert.deepEqual([d.disposition, d.reason, d.replyId], ['unlabeled', 'no_signal', null]);
    const later = decide({ root: root({ id: 1 }), replies: [reply({ id: 1, to: 1, body: 'Done.' }), reply({ id: 2, to: 1, user: STRANGER, body: 'Not yet', at: '2026-01-05T00:00:00Z' })], trusted: TRUSTED, proof: stdProof() });
    assert.equal(later.disposition, 'fixed');
  });

  test('F6 F7 F8 deleted users, other bots and the bot itself never decide', () => {
    // Breaks when: authorKind lets unknown, bot or cr replies count as trusted.
    for (const user of [null, { login: 'ghost', type: 'User' }, OTHER_BOT, CR]) {
      const d = decide({ root: root({ id: 1 }), replies: [reply({ id: 1, to: 1, user, body: 'Fixed in a1b2c3d' })], trusted: TRUSTED, proof: stdProof() });
      assert.deepEqual([d.disposition, d.reason], ['unlabeled', 'no_signal'], String(user?.login));
    }
  });
});

describe('G4 the marker', () => {
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

  test('R8 G4 the marker counts only on its own line', () => {
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

  const MK = 'x\nAddressed in commit a1b2c3d';

  test('F12 G4 the marker alone gives fixed with cr_marker and its SHA; it beats a thumbs-down', () => {
    // Breaks when: the marker arm is dropped, or thumbs are checked before the marker.
    const d = decide({ root: root({ id: 1, body: MK }), replies: [], trusted: TRUSTED, proof: stdProof() });
    assert.deepEqual(d, { disposition: 'fixed', evidence: 'cr_marker', reason: null, rule: null, sha: 'a1b2c3d', replyId: null });
    assert.deepEqual(brief(decide({ root: root({ id: 1, body: MK, reactions: { '-1': 2 } }), replies: [], trusted: TRUSTED })), ['fixed', 'cr_marker', null]);
  });

  test('R8 G4 the marker ranks below every trusted reply, a courtesy-only one too', () => {
    // Breaks when: the marker is checked before the trusted replies or before reply_unmatched.
    for (const body of ['Thanks', 'not fixed yet', 'Fixed in fffffff']) assert.equal(decideBodies([body], { body: MK }).disposition, 'unlabeled', body);
    assert.equal(decideBodies(['Thanks'], { body: MK }).reason, 'reply_unmatched');
    assert.deepEqual(brief(decideBodies(['False positive'], { body: MK })), ['wrong', 'reply_wrong', null]);
  });

  test('F13 a G2 fix with no SHA takes the marker SHA; a wrong or wont_fix reply does not', () => {
    // Breaks when: the marker SHA fills every disposition, or no disposition.
    assert.deepEqual([decideBodies(['Done.'], { body: MK }).sha, decideBodies(['Done.'], { body: MK }).evidence], ['a1b2c3d', 'reply_no_sha']);
    for (const t of ['False positive', "Won't fix", 'By design']) assert.equal(decideBodies([t], { body: MK }).sha, null, t);
  });
});

describe('decide: thumbs and no signal', () => {
  const decideOf = (rootOver = {}) => decide({ root: root({ id: 1, ...rootOver }), replies: [], trusted: TRUSTED, proof: stdProof() });

  test('B1 F11 thumbs never give a disposition', () => {
    // Breaks when: any thumbs count maps to wrong, fixed or wont_fix.
    for (const up of [0, 1, 3]) {
      for (const down of [0, 1, 4]) {
        const d = decideOf({ reactions: { '+1': up, '-1': down } });
        assert.equal(d.disposition, 'unlabeled', `up ${up} down ${down}`);
        assert.equal(d.evidence, null);
      }
    }
  });

  test('B1 F10 F11 the thumbs reasons', () => {
    // Breaks when: a reason is swapped or the unverified thumbs-down becomes a label.
    assert.equal(decideOf({ reactions: { '-1': 1 } }).reason, 'thumbs_down_unverified');
    assert.equal(decideOf({ reactions: { '+1': 2 } }).reason, 'thumbs_up_only');
    assert.equal(decideOf({ reactions: { '+1': 1, '-1': 1 } }).reason, 'thumbs_conflict');
  });

  test('F18 F19 an outdated or open finding with no signal stays unlabeled no_signal', () => {
    // Breaks when: the outdated flag or an open state decides a label.
    for (const over of [{ line: null }, {}]) {
      const d = decideOf(over);
      assert.deepEqual([d.disposition, d.evidence, d.reason, d.rule, d.sha, d.replyId], ['unlabeled', null, 'no_signal', null, null, null]);
    }
  });
});

describe('F27 a 1 MB body does not hang', () => {
  test('F27 parseReply and decide on 1 MB bodies', () => {
    // Breaks when: the grammar, the sentence cut or the clean step gets a nested quantifier or a rescan per character.
    const bodies = [
      `Fixed in ${'a'.repeat(1_000_000)}`, 'Done. '.repeat(170000), '`'.repeat(1_000_000), `Fixed in a1b2c3d${' x'.repeat(500000)}`, '.'.repeat(1_000_000),
      `${' '.repeat(1_000_000)}Done`, 'thanks\n'.repeat(140000), `Fixed in ${'`'.repeat(1_000_000)}`, '?'.repeat(1_000_000), 'fixed '.repeat(180000),
      `Fixed in a1b2c3d ${'?'.repeat(1_000_000)}`, `${'Thanks. '.repeat(120000)}Done.`, '~'.repeat(1_000_000), `fixed ${'~~a'.repeat(333000)}`,
      `${'```\n~~~\n'.repeat(120000)}fixed`, '<del>'.repeat(200000), '~a'.repeat(500000), '<s '.repeat(333000), `fixed ${'<del x>a'.repeat(120000)}`,
      `Fixed${' \t'.repeat(500000)}in a1b2c3d`, `${'\n'.repeat(1_000_000)}Fixed in a1b2c3d`, '!'.repeat(1_000_000),
      `${'    x\n'.repeat(170000)}Done`, `${'> q\n'.repeat(250000)}Done`, `${'\t\n\n'.repeat(330000)}Done`, `Fixed in a1b2c3d${'^'.repeat(1_000_000)}`,
      '&#63;'.repeat(200000), `Fixed in a1b2c3d ${'\u203D'.repeat(1_000_000)}`,
    ];
    for (const b of bodies) {
      const t0 = Date.now();
      parseReply(b);
      decideBodies([b, 'Done.']);
      assert.ok(Date.now() - t0 < 5000, `slow on a ${b.length} char body`);
    }
  });

  test('F27 a 1 MB root body with the marker at the end is found in time', () => {
    // Breaks when: the marker regex goes quadratic.
    const body = `${'filler line with words\n'.repeat(45000)}Addressed in commit a1b2c3d`;
    const t0 = Date.now();
    assert.equal(parseMarker(body), 'a1b2c3d');
    assert.ok(Date.now() - t0 < 5000);
    const t1 = Date.now();
    assert.equal(parseMarker(`Addressed in commit ${' '.repeat(1_000_000)}`), null);
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

describe('findingsForPr', () => {
  const one = (comments, prFact = { author: 'pat' }) => findingsForPr({ pr: 90001, comments, prFact, repo: REPO, proof: stdProof() });

  test('a record holds the fields, the key and the verdict; no body text', () => {
    // Breaks when: a field is renamed or dropped, or body text is copied into the record.
    const out = one([root({ id: 31001 }), reply({ id: 32001, to: 31001, body: 'Fixed in a1b2c3d' }), reply({ id: 32002, to: 31001, user: CR, body: 'bot words' })]);
    assert.equal(out.records.length, 1);
    assert.deepEqual(out.records[0], {
      key: '90001:31001', pr: 90001, commentId: 31001, path: 'src/a.js', line: 7, originalCommit: sha('c'), severity: 'major', disposition: 'fixed', verdict: 'real',
      by: BY, evidence: 'reply_sha_verified', reason: null, rule: 'g1', sha: full('a1b2c3d'), replyId: 32001, thumbs: { up: 0, down: 0 },
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

  test('G1 the git check reads the path of the bot comment', () => {
    // Breaks when: decide checks another path than root.path.
    const out = one([root({ id: 1, file: 'src/other.js' }), reply({ id: 11, to: 1, body: 'Fixed in b2c3d4e' }), root({ id: 2 }), reply({ id: 12, to: 2, body: 'Fixed in b2c3d4e' })]);
    assert.deepEqual(out.records.map((r) => [r.disposition, r.reason]), [['fixed', null], ['unlabeled', 'sha_other_file']]);
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
  const std = () => findingsForPr({ pr: 90001, comments: STD_COMMENTS, prFact: { author: 'pat' }, repo: REPO, proof: stdProof() });
  const sumOf = (over = {}) => {
    const f = std();
    return summarize({ records: f.records, unparsed: f.unparsed, botReplies: f.botReplies, excluded: {}, range: { from: 90000, to: 90001 }, repo: REPO, generatedAt: 'T', mainRef: 'main', mainSha: MAIN, ...over });
  };

  test('the counts, evidence, reasons and the replied numbers on a mixed PR', () => {
    // Breaks when: a tally reads the wrong field or a branch of decide changes.
    const s = sumOf();
    assert.deepEqual(s.denominator, { rule: 'REST pulls/comments by coderabbitai[bot] (type Bot) on merged PRs in range; review-body findings are outside pulls/comments', all: 8, roots: 7, replies: 1 });
    assert.deepEqual(s.counts, { fixed: 2, fixedHuman: 1, fixedMarker: 1, wont_fix: 0, wrong: 1, unlabeled: 4, unlabeledWithMarker: 0 });
    assert.deepEqual(s.excluded, { openPrs: 0, closedUnmergedPrs: 0, openComments: 0, closedUnmergedComments: 0 });
    assert.deepEqual(s.evidence, { reply_sha_verified: 1, reply_no_sha: 0, reply_wont_fix: 0, reply_wrong: 1, cr_marker: 1 });
    assert.deepEqual(s.reasons, {
      reply_extra_text: 0, reply_unmatched: 1, sha_unknown: 0, sha_not_newer: 0, sha_other_file: 0, reply_conflict: 1, thumbs_up_only: 0, thumbs_down_unverified: 1, thumbs_conflict: 0, no_signal: 1,
    });
    assert.deepEqual(s.replied, { findings: 4, anyReply: 4, labeled: 2, unlabeled: 2, share: 0.5 });
    assert.deepEqual(s.labeled, { count: 3, share: 3 / 7 });
    assert.deepEqual(s.parsed, { all: 8, roots: 7, replies: 1, share: 1, rootShare: 1, bar: 0.9, met: true });
    assert.deepEqual([s.v, s.mainRef, s.mainSha], [2, 'main', MAIN]);
  });

  test('every reason and every evidence is counted in the summary', () => {
    // Breaks when: a reason or an evidence key is missing from the tally.
    const pairs = [
      ['Done. Not yet.', 'reply_extra_text'], ['Thanks, will look', 'reply_unmatched'], ['Fixed in fffffff', 'sha_unknown'], ['Fixed in b2c3d4e', 'sha_other_file'],
      ['Fixed in 9a8b7c6', 'sha_not_newer'], ['Done.\n\nTwo', 'reply_extra_text'], ['Fixed in a1b2c3d', 'reply_sha_verified'], ['Done', 'reply_no_sha'], ["Won't fix", 'reply_wont_fix'], ['Not applicable', 'reply_wrong'],
    ];
    const comments = pairs.flatMap(([body], i) => [root({ id: 100 + i }), reply({ id: 200 + i, to: 100 + i, body })]);
    comments.push(root({ id: 300 }), reply({ id: 301, to: 300, body: 'Done.' }), reply({ id: 302, to: 300, body: 'False positive', at: '2026-01-04T00:00:00Z' }));
    comments.push(root({ id: 400, body: 'x\nAddressed in commit a1b2c3d' }));
    const f = findingsForPr({ pr: 90001, comments, prFact: { author: 'pat' }, repo: REPO, proof: stdProof() });
    const s = summarize({ ...f, excluded: {}, range: { from: 90000, to: 90001 }, repo: REPO, generatedAt: 'T' });
    assert.deepEqual([s.reasons.reply_extra_text, s.reasons.reply_unmatched, s.reasons.sha_unknown, s.reasons.sha_not_newer, s.reasons.sha_other_file, s.reasons.reply_conflict], [2, 1, 1, 1, 1, 1]);
    assert.deepEqual(f.records.find((r) => r.commentId === 104).reason, 'sha_not_newer');
    assert.deepEqual(s.evidence, { reply_sha_verified: 1, reply_no_sha: 1, reply_wont_fix: 1, reply_wrong: 1, cr_marker: 1 });
    assert.deepEqual([s.mainRef, s.mainSha], [null, null]);
  });

  test('replied.unlabeled equals the sum of the six reply reasons', () => {
    // Breaks when: a replied finding is unlabeled for a reason outside the six, or the replied count reads another field.
    const s = sumOf();
    const r = s.reasons;
    assert.equal(s.replied.unlabeled, r.reply_extra_text + r.reply_unmatched + r.sha_unknown + r.sha_not_newer + r.sha_other_file + r.reply_conflict);
  });

  test('N6 sha_not_newer reaches the record, the summary count and the replied unlabeled count', () => {
    // Breaks when: the new reason is left out of REASON_KEYS, or decide does not pass root.original_commit_id to the git check.
    const comments = [
      root({ id: 1 }), reply({ id: 11, to: 1, body: 'Fixed in 9a8b7c6' }), root({ id: 2, commit: full('a1b2c3d') }), reply({ id: 12, to: 2, body: 'Fixed in a1b2c3d' }),
      root({ id: 3 }), reply({ id: 13, to: 3, body: 'Fixed in a1b2c3d' }),
    ];
    const f = findingsForPr({ pr: 90001, comments, prFact: { author: 'pat' }, repo: REPO, proof: stdProof() });
    assert.deepEqual(f.records.map((r) => [r.disposition, r.reason]), [['unlabeled', 'sha_not_newer'], ['unlabeled', 'sha_not_newer'], ['fixed', null]]);
    const s = summarize({ ...f, excluded: {}, range: { from: 90000, to: 90001 }, repo: REPO, generatedAt: 'T' });
    assert.deepEqual([s.reasons.sha_not_newer, s.reasons.sha_unknown, s.reasons.sha_other_file, s.replied.unlabeled], [2, 0, 0, 2]);
  });

  test('S1 counts.fixed splits into a human part and a marker part, and a marker record has no verdict', () => {
    // Breaks when: fixedMarker counts by disposition and not by the cr_marker evidence, or a marker record gets a verdict.
    const s = sumOf();
    assert.equal(s.counts.fixed, s.counts.fixedHuman + s.counts.fixedMarker);
    assert.equal(s.counts.fixedMarker, s.evidence.cr_marker);
    const marked = std().records.filter((r) => r.evidence === 'cr_marker');
    assert.deepEqual(marked.map((r) => [r.disposition, r.verdict, r.by]), [['fixed', null, 'cr-disposition']]);
  });

  test('R11 rulesVersionOf reads a Set, a Map, a RegExp, a function and an array; CRLF folds to LF', () => {
    // Breaks when: a Set, a Map or a RegExp is hashed as {} by JSON, a function is hashed by name, or CRLF is not folded.
    const v = (parts) => rulesVersionOf(parts);
    assert.match(v(['m']), /^[0-9a-f]{16}$/);
    assert.equal(v(['m']), v(['m']));
    assert.notEqual(v(['m']), v(['n']));
    assert.notEqual(v([new Set(['will', 'not'])]), v([new Set(['will'])]));
    assert.equal(v([new Set(['will', 'not'])]), v([new Set(['not', 'will'])]));
    assert.notEqual(v([new Map([['a', 'fixed']])]), v([new Map([['a', 'wrong']])]));
    assert.notEqual(v([/a/g]), v([/b/g]));
    assert.notEqual(v([/a/g]), v([/a/i]));
    assert.notEqual(v([function f() { return 1; }]), v([function f() { return 2; }]));
    assert.equal(v(['line one\r\nline two']), v(['line one\nline two']));
    assert.equal(v([new Function('a', 'return a;\r\n')]), v([new Function('a', 'return a;\n')]));
    assert.notEqual(v([[1, 2]]), v([[1, 3]]));
    assert.notEqual(v([{ a: ['x'] }]), v([{ a: ['y'] }]));
  });

  test('C1 the version covers the grammar lists and every label function, collect and prOf too', () => {
    // Breaks when: a label function or a grammar list is left out of VERSION_PARTS.
    assert.ok(Object.isFrozen(VERSION_PARTS));
    const names = VERSION_PARTS.filter((p) => typeof p === 'function').map((f) => f.name);
    const want = ['collect', 'prOf', 'groupByPr', 'sweep', 'findingsForPr', 'recordOf', 'decide', 'readThread', 'outcomeOf', 'parseReply', 'g1Of', 'g2Of', 'startsG2', 'partsOf',
      'firstSentence', 'cleanReply', 'dropFences', 'dropBlocks', 'cutStrikeTags', 'shaEvidence', 'mainShaOf', 'tryGit', 'memoGit', 'gitEnvOf', 'defaultGit', 'parseMarker',
      'authorKind', 'trustedSet', 'byTime', 'gitStatus', 'notNewer'];
    for (const n of want) assert.ok(names.includes(n), n);
    assert.ok(VERSION_PARTS.includes(GRAMMAR));
    // The new patterns join too: the SHA end check, the question marks, the markup class and the quote and indent rules.
    const sources = VERSION_PARTS.filter((p) => p instanceof RegExp).map((r) => r.source);
    for (const s of ['\\u203D', '&', '[.!](?:\\s|$)', '^(?: {4}| {0,3}\\t)', '^ {0,3}>', '^[ \\t]*$', '`{3,}|~{3,}']) assert.ok(sources.some((x) => x.includes(s)), s);
    for (const n of ['fenceOf', 'closesFence']) assert.ok(names.includes(n), n);
    assert.ok(VERSION_PARTS.some((p) => p instanceof Set && p.has('GIT_DIR')));
    // The constant results join too: UNKNOWN given a sha would label every unproved G1 reply.
    for (const reason of ['sha_unknown', 'sha_not_newer', 'reply_extra_text']) assert.ok(VERSION_PARTS.some((p) => p && typeof p === 'object' && p.reason === reason), reason);
    assert.equal(sumOf().rulesVersion, RULES_VERSION);
  });

  test('R12 RULES_VERSION is pinned: a rule change needs a visible test edit', () => {
    // Breaks when: any grammar list, git check, marker pattern or label function changes (then update this literal with the seat's word).
    assert.equal(RULES_VERSION, 'd4d435f2c90cf39d');
  });

  test('F28 zero comments: share null, met false, gate 3 (no vacuous pass)', () => {
    // Breaks when: a null share counts as met.
    const s = summarize({ records: [], unparsed: [], botReplies: { all: 0, parsed: 0 }, excluded: {}, range: { from: 90000, to: null }, repo: REPO, generatedAt: 'T' });
    assert.deepEqual([s.parsed.share, s.parsed.rootShare, s.parsed.met, s.replied.share, s.labeled.share], [null, null, false, null, null]);
    assert.equal(gateOf(s), 3);
  });

  const parsedRoots = (n) => Array.from({ length: n }, (_, i) => findingsForPr({ pr: 90001, comments: [root({ id: 100 + i })], prFact: {}, repo: REPO }).records[0]);
  const badRoots = (n) => Array.from({ length: n }, (_, i) => ({ key: `90001:${900 + i}`, reason: 'bad_shape', kind: 'root' }));

  test('F29 R20 below the bar gives gate 3; at the bar gives gate 0', () => {
    // Breaks when: the compare is > 0, or > BAR instead of >= BAR, or BAR is not 0.9 (a literal, not BAR against itself).
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
    const text = JSON.stringify(s);
    for (const id of ['31001', '31005', '32001', '90001:']) assert.ok(!text.includes(id), id);
    assert.deepEqual([s.v, s.kind, s.repo, s.range], [2, 'cr-dispositions', REPO, { from: 90000, to: 90001 }]);
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
    assert.equal(verdictOf('fixed', 'reply_sha_verified'), 'real');
    assert.equal(verdictOf('unlabeled', null), null);
    assert.ok(/^[a-z][a-z0-9.-]*$/.test(BY));
  });
});

describe('sweep with a stub gh and a scripted git', () => {
  const go = (gh, over = {}, git = stdGit()) => sweep({ from: 90000, repo: REPO, generatedAt: 'T', mainRef: 'main', mainSha: MAIN, ...over }, { gh, git });

  test('F1 paged results are flattened: both pages count; two paged calls in all', async () => {
    // Breaks when: only the first page is read, or a gh call is made per PR.
    const gh = makeGh({ prs: [prRow(90001), prRow(90002)], commentPages: [[root({ id: 1 })], [root({ id: 2, pr: 90002 })]] });
    const { summary } = await go(gh);
    assert.equal(summary.denominator.roots, 2);
    assert.equal(gh.calls.length, 2);
    for (const args of gh.calls) assert.ok(!args.some((a) => /^(-X|--method|--input|-f|-F|--field|--raw-field)$/.test(a)), 'a gh call must be a read');
  });

  test('G1 a sweep reads each distinct git question once, and runs only read verbs', async () => {
    // Breaks when: the git memo is dropped (one rev-parse per finding), or a write or network verb is used.
    const comments = [1, 2, 3].flatMap((i) => [root({ id: i }), reply({ id: 10 + i, to: i, body: 'Fixed in a1b2c3d' })]);
    const git = stdGit();
    const { file } = await go(makeGh({ prs: [prRow(90001)], comments }), {}, git);
    assert.deepEqual(file.findings.map((f) => f.evidence), ['reply_sha_verified', 'reply_sha_verified', 'reply_sha_verified']);
    assert.equal(git.calls.length, 4);
    assert.ok(git.calls.every((a) => ['rev-parse', 'merge-base', 'diff-tree'].includes(a[0])));
  });

  test('a sweep with no git labels no G1 reply', async () => {
    // Breaks when: a missing git counts as proof.
    const { file } = await sweep({ from: 90000, repo: REPO, generatedAt: 'T' }, { gh: stdGh() });
    assert.deepEqual([file.findings[0].disposition, file.findings[0].reason, file.mainSha], ['unlabeled', 'sha_unknown', null]);
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
    assert.deepEqual([summary.parsed.met, summary.mainRef, summary.mainSha], [true, 'main', MAIN]);
  });
});

describe('main CLI', () => {
  const sweepArgs = ['sweep', '--from', '90000', '--repo', REPO];

  test('the run helper refuses a test with no stub gh or no stub git', async () => {
    // Breaks when: run() passes a missing gh or git through to the live one.
    await assert.rejects(run(sweepArgs, { git: stdGit() }), /stub gh/);
    await assert.rejects(run(sweepArgs, { gh: stdGh() }), /stub git/);
  });

  test('F33 no arguments or an unknown command: exit 2, usage on stderr, no gh or git call, no file', async () => {
    // Breaks when: the command defaults to sweep.
    for (const argv of [[], ['nope'], ['--nope']]) {
      const gh = stdGh();
      const git = stdGit();
      const r = await run(argv, { gh, git });
      assert.equal(r.code, 2, argv.join(' '));
      assert.ok(r.err.join('\n').includes('Usage'));
      assert.deepEqual([gh.calls.length, git.calls.length], [0, 0]);
      assert.deepEqual(walk(r.home), []);
    }
  });

  test('F33 --help and -h exit 0 with usage on stdout and no gh or git call', async () => {
    // Breaks when: help falls through to the sweep.
    for (const flag of ['--help', '-h']) {
      const gh = stdGh();
      const git = stdGit();
      const r = await run([flag], { gh, git });
      assert.equal(r.code, 0);
      assert.ok(r.out.join('\n').includes('Usage'));
      assert.ok(r.out.join('\n').includes('--main-ref'));
      assert.deepEqual([gh.calls.length, git.calls.length], [0, 0]);
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
    ['--repo', '../graphql'], ['--repo', 'acme/..'], ['--repo', './widgets'], ['--repo', 'acme/.'], ['--repo', '.../x'], ['--repo', 'parcadei/x'], ['--repo', 'Parcadei/widgets'], ['--repo', 'PARCADEI/y'],
    ['--main-ref'], ['--main-ref', '-x'], ['--main-ref', 'a b'], ['--main-ref', '']]) {
    test(`F34 R17 bad flags "${bad.join(' ')}" exit 2 with no gh or git call and no file`, async () => {
      // Breaks when: a check in parseArgs is dropped, --bar is accepted again, or the --repo or --main-ref check is dropped.
      const gh = stdGh();
      const git = stdGit();
      const r = await run(['sweep', ...bad], { gh, git });
      assert.equal(r.code, 2);
      assert.deepEqual([gh.calls.length, git.calls.length], [0, 0]);
      assert.deepEqual(walk(r.home), []);
      assert.ok(r.err.length > 0);
    });
  }

  test('--main-ref defaults to main; the summary records the ref and its SHA; the full file carries the git evidence', async () => {
    // Breaks when: the main ref is not resolved once before the sweep, or its name or SHA is not in the summary.
    const home = tmp();
    const git = stdGit();
    const r = await run([...sweepArgs, '--json', '--out', path.join(home, 'd.json')], { gh: stdGh(), git, home });
    assert.equal(r.code, 0);
    const s = JSON.parse(r.out.join('\n'));
    assert.deepEqual([s.mainRef, s.mainSha, s.v], ['main', MAIN, 2]);
    assert.deepEqual(git.calls[0], ['rev-parse', '--verify', '--quiet', 'main^{commit}']);
    const f = JSON.parse(readFileSync(path.join(home, 'd.json'), 'utf8'));
    assert.deepEqual([f.findings[0].evidence, f.findings[0].sha, f.mainSha], ['reply_sha_verified', full('a1b2c3d'), MAIN]);
  });

  test('--main-ref names another ref; its SHA is the ancestor target', async () => {
    // Breaks when: the flag is ignored, or the ancestor check uses the name and not the resolved SHA.
    const other = full('ab12');
    const git = scriptGit(STD_COMMITS, { refs: { main: MAIN, 'fork/main': other } });
    const r = await run([...sweepArgs, '--json', '--main-ref', 'fork/main', '--out', path.join(tmp(), 'd.json')], { gh: stdGh(), git });
    assert.equal(r.code, 0);
    const s = JSON.parse(r.out.join('\n'));
    assert.deepEqual([s.mainRef, s.mainSha], ['fork/main', other]);
    assert.ok(git.calls.some((a) => a[0] === 'merge-base' && a.at(-1) === other));
  });

  test('a --main-ref that names no commit exits 2 before any gh call, with one fixed line and no file', async () => {
    // Breaks when: an unresolved main ref runs the sweep (every G1 reply would be a quiet sha_unknown).
    for (const git of [stdGit(), scriptGit({}, { fail: 'throw' }), scriptGit({}, { fail: 'rev-parse' })]) {
      const gh = stdGh();
      const r = await run([...sweepArgs, '--main-ref', 'nope'], { gh, git });
      assert.equal(r.code, 2);
      assert.equal(gh.calls.length, 0);
      assert.ok(r.err[0].startsWith('dispositions: --main-ref does not name a commit'));
      assert.deepEqual(walk(r.home), []);
    }
  });

  test('B5 --out under the repo root is refused (a pure check: no main run, no write near the repo)', () => {
    // Breaks when: outRefused is dropped or does not compare against the repo root (a temp root with no .git isolates that compare).
    assert.equal(D.outRefused(path.join(REPO_ROOT, 'disp-test', 'x.json')), true);
    assert.equal(D.outRefused(path.join(path.relative(process.cwd(), REPO_ROOT), 'disp-test', 'y.json')), true);
    const root = tmp();
    assert.equal(D.outRefused(path.join(root, 'a', 'x.json'), root), true);
    assert.equal(D.outRefused(path.join(tmp(), 'x.json'), root), false);
  });

  test('B5 --out inside any .claude/worktrees folder is refused', async () => {
    // Breaks when: the worktrees rule is dropped.
    const home = tmp();
    const target = path.join(home, '.claude', 'worktrees', 'other', 'x.json');
    const gh = stdGh();
    const r = await run([...sweepArgs, '--out', target], { gh, git: stdGit() });
    assert.equal(r.code, 2);
    assert.equal(gh.calls.length, 0);
    assert.ok(!existsSync(path.dirname(target)));
  });

  test('a --repo other than the repo whose history git reads exits 2 before any gh or git call', async () => {
    // Breaks when: the default git (the history of this checkout) proves SHAs for another repo's replies, or the check is case-sensitive.
    assert.equal(D.defaultGit.repo, DEFAULT_REPO);
    const tagged = () => Object.assign(stdGit(), { repo: REPO });
    for (const other of ['acme/other', 'other/widgets']) {
      const gh = stdGh();
      const git = tagged();
      const r = await run(['sweep', '--from', '90000', '--repo', other, '--out', path.join(tmp(), 'd.json')], { gh, git });
      assert.equal(r.code, 2, other);
      assert.deepEqual([gh.calls.length, git.calls.length], [0, 0], other);
      assert.ok(r.err[0].startsWith('dispositions: --repo must be the repo whose history git reads'), r.err[0]);
      assert.deepEqual(walk(r.home), []);
    }
    const ok = await run(['sweep', '--from', '90000', '--repo', 'ACME/Widgets', '--out', path.join(tmp(), 'd.json')], { gh: stdGh(), git: tagged() });
    assert.equal(ok.code, 0);
  });

  test('R17 a repo name with inner dots is accepted and reaches the route', async () => {
    // Breaks when: the --repo check refuses every dot.
    const gh = makeGh({ prs: [prRow(90001)], comments: [root({ id: 1 })] });
    const r = await run(['sweep', '--from', '90000', '--repo', 'acme/wid.gets', '--out', path.join(tmp(), 'd.json')], { gh, git: stdGit() });
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
    const git = stdGit();
    const r = await run([...sweepArgs, '--out', target], { gh, git, home });
    assert.equal(r.code, 2, target);
    assert.deepEqual([gh.calls.length, git.calls.length], [0, 0], target);
    assert.ok(r.err.join('\n').includes('Usage'));
    return r;
  }
  /** A directory link (a junction on Windows) made in a temp folder; removed by the caller, never followed by the cleanup. */
  const links = [];
  const linkDir = (target, link) => {
    symlinkSync(target, link, 'junction');
    links.push(link);
    return link;
  };
  after(() => { for (const l of links) { try { unlinkSync(l); } catch { try { rmdirSync(l); } catch { /* gone */ } } } });
  /** Runs fn with a temp folder as the working folder: a guard that reads a path as relative then writes only under temp. */
  async function inTempCwd(fn) {
    const cwd = process.cwd();
    const work = tmp();
    process.chdir(work);
    try {
      await fn(work);
    } finally {
      process.chdir(cwd);
    }
    return work;
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

  test('C3 --out through a junction into a repository sub folder is refused (the real-path walk)', async () => {
    // Breaks when: outRefused drops the walk of the real path (the plain path has no .git ancestor).
    const base = tmp();
    const repo = fakeRepo('dir', path.join(base, 'repo'));
    const sub = path.join(repo, 'sub');
    mkdirSync(sub);
    mkdirSync(path.join(base, 'out'));
    const link = linkDir(sub, path.join(base, 'out', 'jn'));
    await refusedOut(path.join(link, 'x.json'));
    assert.deepEqual(readdirSync(sub), []);
  });

  test('C4 --out under a dangling link is refused before the sweep', async () => {
    // Breaks when: the dangling-link check is dropped (the sweep runs, then the write fails with exit 1).
    const base = tmp();
    const gone = path.join(base, 'gone');
    mkdirSync(gone);
    const link = linkDir(gone, path.join(base, 'jn'));
    rmdirSync(gone);
    await refusedOut(path.join(link, 'x.json'));
    await refusedOut(path.join(link, 'deep', 'x.json'));
    assert.deepEqual(readdirSync(base), ['jn']);
  });

  test('R14 R16 a long-path form of a path in a repo is refused; outside every repo it is written at the plain path', { skip: process.platform !== 'win32' }, async () => {
    // Breaks when: the long-path prefix is not stripped before the check (the prefix hides the .git ancestor).
    const repo = fakeRepo('dir');
    await refusedOut(`\\\\?\\${path.join(repo, 'x.json')}`);
    assert.deepEqual(walk(repo), ['.git']);
    const home = tmp();
    const plain = path.join(home, 'ok', 'd.json');
    const r = await run([...sweepArgs, '--out', `\\\\?\\${plain}`], { gh: stdGh(), git: stdGit(), home });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(readFileSync(plain, 'utf8')).findings.length, 7);
  });

  test('C4 a long-path form whose tail is not <drive>:\\ (GLOBALROOT, a bare name) is refused', { skip: process.platform !== 'win32' }, async () => {
    // Breaks when: plainPath reads any long-path tail as a path (the tail lands under the working folder).
    const work = await inTempCwd(async () => {
      for (const t of ['\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\d.json', '\\\\?\\relative\\d.json', '//?/GLOBALROOT/Device/x/d.json', '\\\\?\\C\\d.json']) await refusedOut(t);
    });
    assert.deepEqual(walk(work), []);
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
    const work = await inTempCwd(async () => { for (const t of targets) await refusedOut(t); });
    assert.deepEqual(walk(work), []);
    assert.deepEqual(walk(outside), ['.git']);
    const plainOutside = path.join(tmp(), 'y.json');
    await refusedOut(`\\\\localhost\\${drive(plainOutside)}$\\${rest(plainOutside)}`);
    assert.ok(!existsSync(plainOutside));
  });

  test('R16 the default path is checked too: a home inside a repo tree is refused', async () => {
    // Breaks when: the default path skips outRefused.
    const home = fakeRepo('dir');
    const r = await run(sweepArgs, { gh: stdGh(), git: stdGit(), home });
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
      // The guard of this test: main() runs with no homedir on purpose, so the assert above must hold (os.homedir() is the temp repo)
      // before the call. A stub gh and a scripted git are passed, and the expected exit 2 comes before any gh or git call.
      assert.equal(os.homedir(), home);
      const gh = stdGh();
      const git = stdGit();
      const err = [];
      const code = await main(sweepArgs, { gh, git, now: () => NOW, stdout: () => {}, stderr: (s) => err.push(s) });
      assert.equal(code, 2);
      assert.deepEqual([gh.calls.length, git.calls.length], [0, 0]);
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
    if (process.platform === 'win32') variants.push(path.join(home, 'D.JSON'), `\\\\?\\${out}`);
    for (const s of variants) {
      const gh = stdGh();
      const r = await run([...sweepArgs, '--out', out, '--summary-out', s], { gh, git: stdGit(), home });
      assert.equal(r.code, 2, s);
      assert.equal(gh.calls.length, 0);
    }
    const gh = stdGh();
    const def = path.join(home, '.claude', 'state', 'review-engine', '2026-11-11-dispositions.json');
    assert.equal((await run([...sweepArgs, '--summary-out', def], { gh, git: stdGit(), home })).code, 2);
    assert.deepEqual(walk(home), []);
  });

  test('C2 C3 --summary-out with no plain path (a share, a device, a long UNC form) exits 2 before any write', async () => {
    // Breaks when: a --summary-out with no plain form falls back to path.resolve (the share form of --out passes the same-file check).
    const home = tmp();
    const out = path.join(home, 'd.json');
    const rest = (p) => p.slice(3);
    const drive = (p) => p.slice(0, 1);
    const other = path.join(home, 'other.json');
    const forms = [
      `\\\\localhost\\${drive(out)}$\\${rest(out)}`, `//localhost/${drive(out)}$/${rest(out).replace(/\\/g, '/')}`, `\\\\127.0.0.1\\${drive(out)}$\\${rest(out)}`,
      `\\\\?\\UNC\\localhost\\${drive(out)}$\\${rest(out)}`, `\\\\.\\${out}`, `\\\\localhost\\${drive(other)}$\\${rest(other)}`,
    ];
    const work = await inTempCwd(async () => {
      for (const s of forms) {
        const gh = stdGh();
        const r = await run([...sweepArgs, '--out', out, '--summary-out', s], { gh, git: stdGit(), home });
        assert.equal(r.code, 2, s);
        assert.equal(gh.calls.length, 0, s);
        assert.ok(r.err[0].startsWith('dispositions: --summary-out must not be a UNC or stream path'), s);
        assert.ok(!existsSync(out), s);
      }
    });
    assert.deepEqual(walk(home), []);
    assert.deepEqual(walk(work), []);
  });

  test('R18 bad JSON from gh prints a fixed line, no response text', async () => {
    // Breaks when: the SyntaxError message (which quotes the response) is printed.
    const home = tmp();
    const gh = async () => JSON.parse('<html>made-up secret response page</html>');
    const r = await run([...sweepArgs, '--out', path.join(home, 'd.json')], { gh, git: stdGit(), home });
    assert.equal(r.code, 1);
    assert.deepEqual(r.err, ['dispositions failed (bad_shape): gh output is not JSON']);
    assert.deepEqual(walk(home), []);
  });

  test('R18 an uncaught error prints one fixed line: no stack, no path, no file left', async () => {
    // Breaks when: main rethrows a non-SweepError, or prints its message or stack.
    const home = tmp();
    writeFileSync(path.join(home, 'a-file'), 'x');
    const out = path.join(home, 'a-file', 'd.json');
    const r = await run([...sweepArgs, '--out', out, '--summary-out', path.join(home, 's.json')], { gh: stdGh(), git: stdGit(), home });
    assert.equal(r.code, 1);
    assert.deepEqual(r.err, ['dispositions failed (internal): unexpected error']);
    assert.deepEqual(walk(home), ['a-file']);
  });

  test('F35 the default file lives under the home state folder, named from the injected clock', async () => {
    // Breaks when: the default path uses another folder, or the date comes from the real clock.
    const r = await run(sweepArgs, { gh: stdGh(), git: stdGit() });
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
    const r = await run([...sweepArgs, '--out', out, '--summary-out', summaryOut], { gh: stdGh(), git: stdGit(), home });
    assert.equal(r.code, 0);
    assert.deepEqual(r.out, ['dispositions: 8 bot comments, parsed 100.0%, replied labeled 2/4, fixed 2 wont_fix 0 wrong 1 unlabeled 4']);
    const sum = JSON.parse(readFileSync(summaryOut, 'utf8'));
    assert.ok(!('findings' in sum));
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).findings.length, 7);
    assert.ok(walk(home).every((p) => !p.endsWith('.tmp')));
  });

  test('--json prints the summary JSON instead of the line', async () => {
    // Breaks when: --json is ignored.
    const r = await run([...sweepArgs, '--json', '--out', path.join(tmp(), 'd.json')], { gh: stdGh(), git: stdGit() });
    assert.equal(r.code, 0);
    const s = JSON.parse(r.out.join('\n'));
    assert.deepEqual([s.kind, s.parsed.met, 'findings' in s], ['cr-dispositions', true, false]);
  });

  test('F3 F4 a gh error exits 1 with one stderr line and writes nothing; an older file keeps its bytes', async () => {
    // Breaks when: a failed sweep writes either file, or truncates the file at --out.
    const home = tmp();
    const out = path.join(home, 'd.json');
    const summaryOut = path.join(home, 's.json');
    const missing = await run([...sweepArgs, '--out', out, '--summary-out', summaryOut], { gh: makeGh({ prs: [prRow(90001)], failOn: 'comments' }), git: stdGit(), home });
    assert.equal(missing.code, 1);
    assert.deepEqual(missing.err, ['dispositions failed (gh_error): gh api call failed']);
    assert.deepEqual(walk(home), []);
    writeFileSync(out, 'OLD BYTES');
    const kept = await run([...sweepArgs, '--out', out, '--summary-out', summaryOut], { gh: makeGh({ prs: [prRow(90001)], failOn: 'comments' }), git: stdGit(), home });
    assert.equal(kept.code, 1);
    assert.equal(readFileSync(out, 'utf8'), 'OLD BYTES');
    assert.deepEqual(walk(home), ['d.json']);
  });

  test('F2 a cut page exits 1 with bad_shape and writes nothing', async () => {
    // Breaks when: a bad shape is written as a result.
    const home = tmp();
    const r = await run([...sweepArgs, '--out', path.join(home, 'd.json')], { gh: makeGh({ prs: [prRow(90001)], commentPages: [[root({ id: 1 })], { message: 'cut' }] }), git: stdGit(), home });
    assert.equal(r.code, 1);
    assert.ok(r.err[0].startsWith('dispositions failed (bad_shape):'));
    assert.deepEqual(walk(home), []);
  });

  test('X16 a gh error prints no gh text: one fixed line with the HTTP status only', async () => {
    // Breaks when: the gh message (its command line, stderr or API text) is printed.
    const failMessage = `Command failed: gh api x\nmade-up api text ${'x'.repeat(500)} (HTTP 502)`;
    const r = await run([...sweepArgs, '--out', path.join(tmp(), 'd.json')], { gh: makeGh({ prs: [prRow(90001)], failOn: 'comments', failMessage }), git: stdGit() });
    assert.equal(r.code, 1);
    assert.deepEqual(r.err, ['dispositions failed (gh_error): gh api call failed (HTTP 502)']);
  });

  test('X13 a failed rename (--out is a folder) leaves no .tmp file and prints the fixed line', async () => {
    // Breaks when: writeJson drops the rmSync of the .tmp file on failure.
    const home = tmp();
    const out = path.join(home, 'out-folder');
    mkdirSync(out);
    const r = await run([...sweepArgs, '--out', out], { gh: stdGh(), git: stdGit(), home });
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
    const r = await run([...sweepArgs, '--out', path.join(home, 'd.json'), '--summary-out', summaryOut], { gh: makeGh({ prs: [prRow(90001)], comments: [] }), git: stdGit(), home });
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
    const r = await run([...sweepArgs, '--out', path.join(home, 'd.json'), '--summary-out', path.join(home, 's.json')], { gh: makeGh({ prs: [prRow(90001)], comments }), git: stdGit(), home });
    assert.equal(r.code, 3);
    assert.ok(existsSync(path.join(home, 'd.json')) && existsSync(path.join(home, 's.json')));
    assert.equal(JSON.parse(readFileSync(path.join(home, 's.json'), 'utf8')).parsed.share, 0.8);
  });

  test('--to defaults to the highest merged PR', async () => {
    // Breaks when: the default to is not computed from the PR list.
    const r = await run([...sweepArgs, '--json', '--out', path.join(tmp(), 'd.json')], { gh: makeGh({ prs: [prRow(90001), prRow(90004), prRow(90007, { merged: false })], comments: [root({ id: 1, pr: 90004 })] }), git: stdGit() });
    assert.deepEqual(JSON.parse(r.out.join('\n')).range, { from: 90000, to: 90004 });
  });
});
