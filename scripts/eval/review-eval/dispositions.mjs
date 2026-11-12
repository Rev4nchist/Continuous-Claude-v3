#!/usr/bin/env node
// What happened to each CodeRabbit inline finding on merged PRs: fixed, wont_fix, wrong or unlabeled.
// A disposition comes only from a trusted human's reply in a closed grammar (G1, G2), or from CodeRabbit's own
// "Addressed in commit" marker (no verdict). Every other reply leaves the finding unlabeled, with a reason.
// G1 "<fixed|addressed|resolved|done|applied> <in|by|with|via> [commit] <sha>" labels only when git proves the SHA: one commit,
// an ancestor of the main ref, newer than the commit the finding was made on, and it changes the file of the finding. G2: the whole reply is one sentence of a closed list.
// G1: the label means a trusted reply names a commit on main that changes the file; it does not mean the defect is gone.
// Thumbs never label: the REST rollup does not say who reacted. An open finding is never negative.
// Read-only: two paged `gh api` GET calls in all, and local git reads (rev-parse, merge-base, diff-tree); no fetch.
// `gh` is injectable: async (args) => parsed JSON (as github.mjs). `git` is injectable: (args) => { status, stdout } (as read-audit.mjs).
// The full file holds PR numbers and comment ids, so --out (and the default path) is refused inside every repo tree, on a UNC
// path, on a stream path and under a dangling link. --summary-out holds counts only; it must be a plain path and not the --out file.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPO } from '../../github/cursor-review.mjs';
import { CODERABBIT_LOGIN, inlineCommentSeverity, isCodeRabbitUser } from '../../github/review-status.mjs';
import { defaultGh, ghList } from './github.mjs';

export const BY = 'cr-disposition';
export const BAR = 0.9;
const DEFAULT_FROM = 188;
const DEFAULT_MAIN_REF = 'main';
const DENOMINATOR_RULE = 'REST pulls/comments by coderabbitai[bot] (type Bot) on merged PRs in range; review-body findings are outside pulls/comments';
const STATE_FOLDER = 'review-engine';

export const VERDICT_OF = Object.freeze({ fixed: 'real', wrong: 'noise', wont_fix: 'unclear', unlabeled: null });
/** A bot's own "Addressed in commit" claim is not a label: no verdict. */
export const verdictOf = (disposition, evidence) => (evidence === 'cr_marker' ? null : (VERDICT_OF[disposition] ?? null));

// ---- clean text -----------------------------------------------------------------------------------------------------------------

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const APOSTROPHES = /[\u2018\u2019\u00B4\u02BC]/g;
// GFM strike-through with one or two tildes, on one line, with no space inside either edge.
const STRUCK = /(~~?)(?=[^\s~])[^~\n]*?[^\s~]\1/g;
// An open or close tag of <del>, <s> or <strike>, attributes allowed. Bounded: it stops at the next < or >.
const STRIKE_TAG = /<(\/?)(del|s|strike)\b[^<>\n]{0,200}>/gi;

/** The line with each <del|s|strike> ... </same> run cut out; inner tags are kept inside the run. One pass: linear. */
function cutStrikeTags(line) {
  let out = '';
  let at = 0;
  let open = null;
  for (const m of line.matchAll(STRIKE_TAG)) {
    const name = m[2].toLowerCase();
    if (open === null && m[1] === '') open = { name, start: m.index };
    else if (open !== null && m[1] === '/' && name === open.name) {
      out += `${line.slice(at, open.start)} `;
      at = m.index + m[0].length;
      open = null;
    }
  }
  return out + line.slice(at);
}

// A fence line as CommonMark reads it: up to three spaces, then three or more backticks or tildes, then the info text.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** { char, size, info } of a fence line, or null. A backtick fence has no backtick in its info text (that is inline code). */
function fenceOf(line) {
  const m = FENCE.exec(line);
  if (!m || (m[1][0] === '`' && m[2].includes('`'))) return null;
  return { char: m[1][0], size: m[1].length, info: m[2] };
}

/** True when fence f closes the open fence: the same mark, at least as long, and no info text. */
const closesFence = (f, open) => f !== null && f.char === open.char && f.size >= open.size && /^[ \t]*$/.test(f.info);

/** The lines outside fenced blocks (``` and ~~~); each block, fence lines too, leaves one blank line. An unclosed fence drops the rest. */
function dropFences(text) {
  const keep = [];
  let open = null;
  for (const line of text.split(/\r?\n/)) {
    const f = fenceOf(line);
    if (open !== null) {
      if (closesFence(f, open)) open = null;
    } else if (f !== null) {
      keep.push('');
      open = f;
    } else keep.push(line);
  }
  return keep;
}

// Block rules read the raw line (before the zero-width strip): only spaces and tabs count as blank or as indent.
const BLANK = /^[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const INDENTED = /^(?: {4}| {0,3}\t)/;

/**
 * The lines GitHub shows outside a quote or an indented code block. A quote runs from a > line to the next blank line (its
 * lazy lines too). A code line is indented by four spaces or a tab, at the start, after a blank line or after a code line.
 */
function dropBlocks(lines) {
  const keep = [];
  let quote = false;
  let code = false;
  let blank = true;
  for (const line of lines) {
    if (BLANK.test(line)) {
      keep.push(line);
      quote = false;
      blank = true;
      continue;
    }
    if (QUOTE.test(line)) quote = true;
    code = !quote && INDENTED.test(line) && (blank || code);
    if (!quote && !code) keep.push(line);
    blank = false;
  }
  return keep;
}

/**
 * Fenced blocks, quotes and indented code dropped (read on the raw lines, as GitHub reads them); then in each kept line the
 * zero-width characters out, four apostrophe forms folded to ', and struck text dropped.
 */
export function cleanReply(text) {
  const fold = (line) => line.replace(ZERO_WIDTH, '').replace(APOSTROPHES, "'");
  return dropBlocks(dropFences(String(text ?? ''))).map((line) => cutStrikeTags(fold(line)).replace(STRUCK, ' ')).join('\n');
}

// ---- the closed grammar (seat check of d0bc9b6f; a new form needs the seat's word) -------------------------------------------

export const GRAMMAR = Object.freeze({
  start: Object.freeze(['fixed', 'addressed', 'resolved', 'done', 'applied']),
  link: Object.freeze(['in', 'by', 'with', 'via']),
  fixed: Object.freeze(['fixed', 'done', 'applied', 'addressed', 'resolved']),
  wont_fix: Object.freeze(["won't fix", 'wont fix', 'wontfix', 'will not fix', 'by design', 'this is by design', 'intentional', 'this is intentional', 'out of scope']),
  wrong: Object.freeze(['false positive', 'this is a false positive', 'not applicable']),
  courtesy: Object.freeze(['thanks', 'thank you', 'good catch', 'nice catch', 'great catch', 'agreed']),
});
const EVIDENCE_OF = Object.freeze({ fixed: 'reply_no_sha', wont_fix: 'reply_wont_fix', wrong: 'reply_wrong' });
const G2_LABEL = new Map(['fixed', 'wont_fix', 'wrong'].flatMap((d) => GRAMMAR[d].map((s) => [s, d])));
const COURTESY = new Set(GRAMMAR.courtesy);

// G1, anchored: a start word, a link word, an optional "commit", then 7 to 40 hex, bare or in one pair of backticks, with a clean end.
// No nested quantifier: one attempt at index 0, at most 34 steps back on the hex run.
const G1 = new RegExp(`^(?:${GRAMMAR.start.join('|')})[ \\t]+(?:${GRAMMAR.link.join('|')})[ \\t]+(?:commit[ \\t]+)?(?:\`([0-9a-f]{7,40})\`|([0-9a-f]{7,40}))(?![\\w/-])`, 'i');
// & is markup: an HTML entity such as &#63; shows as another character on GitHub.
const MARKUP = /[`<>~*_&]/;
const MARKUP_ALL = new RegExp(MARKUP.source, 'g');
// Every question mark GitHub can show: ASCII, inverted, Greek, Arabic, interrobang, double forms, reversed, small, fullwidth.
const ASK = /[?\u00BF\u037E\u061F\u203D\u2047-\u2049\u2E2E\uFE56\uFF1F]/;
// What may follow the SHA token: the end, white space, a comma, a semicolon, a closing parenthesis, a . or ! that ends the
// sentence, or a colon before white space or the end (seat ruling of 2026-11-12). Anything else (^, .., :path, :sha, @, =)
// makes the token a revision expression, a range or a path, not one commit.
const SHA_END = /^(?:$|[\s,;)]|[.!](?:\s|$)|:(?:\s|$))/;

/** The text up to the first . or ! before white space or the end, or up to the first line break. A comma or ; does not end it. */
function firstSentence(text) {
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\n') return text.slice(0, i);
    if ((c === '.' || c === '!') && (i + 1 === text.length || /\s/.test(text[i + 1]))) return text.slice(0, i + 1);
  }
  return text;
}

const EXTRA = Object.freeze({ form: null, reason: 'reply_extra_text' });

/**
 * G1 on the cleaned text: { form: 'g1', sha }, EXTRA (a G1 start with a ? or markup in the first sentence, or a SHA token
 * that does not end cleanly), or null.
 */
function g1Of(text) {
  const first = firstSentence(text);
  const m = G1.exec(first);
  if (!m) return G1.test(firstSentence(text.replace(MARKUP_ALL, ''))) ? EXTRA : null;
  const rest = first.slice(m[0].length);
  return MARKUP.test(rest) || ASK.test(rest) || !SHA_END.test(rest) ? EXTRA : { form: 'g1', sha: (m[1] ?? m[2]).toLowerCase() };
}

/** Lower case, trim, one final . or ! cut. */
const normal = (s) => s.toLowerCase().trim().replace(/[.!]$/, '');
/** The G2 sentences: cut at a line break and after . or ! before white space; empty ones dropped. Linear. */
const partsOf = (text) => text.split(/\n|(?<=[.!])[ \t]+/).map(normal).filter(Boolean);

/** G2: { form: 'g2', disposition, evidence } for exactly one list sentence plus courtesy, { form: 'courtesy' }, or null. */
function g2Of(text) {
  if (MARKUP.test(text)) return null;
  const parts = partsOf(text);
  const rest = parts.filter((p) => !COURTESY.has(p));
  if (parts.length > 0 && rest.length === 0) return { form: 'courtesy' };
  if (rest.length !== 1 || !G2_LABEL.has(rest[0])) return null;
  const disposition = G2_LABEL.get(rest[0]);
  return { form: 'g2', disposition, evidence: EVIDENCE_OF[disposition] };
}

/** True when the reply, markup taken out and leading courtesy skipped, starts with a G2 list sentence. */
function startsG2(text) {
  const head = partsOf(text.replace(MARKUP_ALL, '')).find((p) => !COURTESY.has(p));
  return head !== undefined && G2_LABEL.has(head);
}

/**
 * What the words of one reply say: { form: 'g1', sha } (git decides), { form: 'g2', disposition, evidence },
 * { form: 'courtesy' }, or { form: null, reason: 'reply_extra_text' | 'reply_unmatched' }.
 */
export function parseReply(text) {
  const clean = cleanReply(text).trim();
  const g1 = g1Of(clean);
  if (g1) return { ...g1 };
  const g2 = g2Of(clean);
  if (g2) return g2;
  return { form: null, reason: startsG2(clean) ? 'reply_extra_text' : 'reply_unmatched' };
}

// ---- git evidence for G1 ------------------------------------------------------------------------------------------------------

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHORT_SHA = /^[0-9a-f]{7,40}$/;
const MAIN_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const UNKNOWN = Object.freeze({ reason: 'sha_unknown' });
const NOT_NEWER = Object.freeze({ reason: 'sha_not_newer' });

/** stdout of a git call with status 0, else null. A throw is a failure, never a pass. */
const tryGit = (git, args) => {
  try {
    const r = git(args);
    return r && r.status === 0 ? String(r.stdout ?? '') : null;
  } catch {
    return null;
  }
};

/** The integer exit status of a git call, or null for a throw, a null result or no integer status. */
const gitStatus = (git, args) => {
  try {
    const r = git(args);
    return r && Number.isInteger(r.status) ? r.status : null;
  } catch {
    return null;
  }
};

/**
 * null when commit `full` is newer than the finding commit `original`: it is not that commit and not its ancestor (exit 1).
 * NOT_NEWER when it is the commit or an ancestor (exit 0). UNKNOWN for any other status, a null result or a throw.
 */
function notNewer(git, full, original) {
  if (full === original) return NOT_NEWER;
  const status = gitStatus(git, ['merge-base', '--is-ancestor', full, original]);
  return status === 1 ? null : status === 0 ? NOT_NEWER : UNKNOWN;
}

/** The full SHA of the commit a ref names, or null (a bad name never reaches git). */
export function mainShaOf(git, ref) {
  if (typeof git !== 'function' || !MAIN_REF.test(String(ref ?? ''))) return null;
  const out = tryGit(git, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim().toLowerCase();
  return out && FULL_SHA.test(out) ? out : null;
}

/**
 * { sha: <full> } when git proves the SHA: it names exactly one commit, that commit is an ancestor of mainSha, it is newer
 * than `original` (the finding's original_commit_id: not that commit, not its ancestor), and its diff-tree (every parent: -m)
 * lists `file` exactly. { reason: 'sha_not_newer' } when the commit is `original` or its ancestor. { reason: 'sha_other_file' }
 * when only the file check fails: the newer check runs first, so that reason counts only commits that could be the fix.
 * { reason: 'sha_unknown' } for every other case, a git failure and an `original` that is not 40 hex included.
 */
export function shaEvidence({ git, sha, file, mainSha, original }) {
  const want = String(sha ?? '').toLowerCase();
  const orig = typeof original === 'string' ? original.toLowerCase() : '';
  if (typeof git !== 'function' || !FULL_SHA.test(String(mainSha ?? '')) || !SHORT_SHA.test(want) || typeof file !== 'string' || file === '') return UNKNOWN;
  if (!FULL_SHA.test(orig)) return UNKNOWN;
  const full = tryGit(git, ['rev-parse', '--verify', '--quiet', `${want}^{commit}`])?.trim().toLowerCase() ?? '';
  if (!FULL_SHA.test(full) || !full.startsWith(want)) return UNKNOWN;
  if (tryGit(git, ['merge-base', '--is-ancestor', full, mainSha]) === null) return UNKNOWN;
  const older = notNewer(git, full, orig);
  if (older !== null) return older;
  const names = tryGit(git, ['diff-tree', '-r', '-m', '--root', '--no-commit-id', '--name-only', '-z', full]);
  if (names === null) return UNKNOWN;
  return names.split('\0').includes(file) ? { sha: full } : { reason: 'sha_other_file' };
}

/** The same git question asked twice in one sweep runs once. */
function memoGit(git) {
  const seen = new Map();
  return (args) => {
    const key = args.join('\0');
    if (!seen.has(key)) seen.set(key, git(args));
    return seen.get(key);
  };
}

// Variables that point git at another repo, object store, index or ref view. GIT_DIR beats -C (a run from a git hook has it set).
const GIT_MOVES = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_REPLACE_REF_BASE', 'GIT_NAMESPACE', 'GIT_COMMON_DIR']);

/** The env for git: those variables out (any case: a copy of the Windows env keeps the case of each name), no prompt, no lazy fetch. */
const gitEnvOf = (env) => ({
  ...Object.fromEntries(Object.entries(env).filter(([k]) => !GIT_MOVES.has(k.toUpperCase()))), GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
});

/** git with -C on the repo root of this file and no replace objects. Its stderr is captured, never printed. spawn and env: for tests. */
export function defaultGit(args, { spawn = spawnSync, env = process.env } = {}) {
  const r = spawn('git', ['-C', REPO_ROOT, '--no-replace-objects', ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: gitEnvOf(env) });
  // No exit status (a spawn error or a signal) stays null: as exit 1 it would pass the newer check of shaEvidence.
  return { status: r.status ?? null, stdout: r.stdout ?? '' };
}
/** The GitHub repo whose history defaultGit reads: a sweep of another --repo is refused (its SHAs are not in this history). */
defaultGit.repo = DEFAULT_REPO;

// ---- the bot marker (G4, as R8) -----------------------------------------------------------------------------------------------

const SHA_WHOLE = /^(?=[0-9a-f]{0,39}[0-9])(?=[0-9a-f]{0,39}[a-f])[0-9a-f]{7,40}$/i;
// The bot's own marker line: the line holds only "Addressed in commit(s) <sha> [to <sha>]", with an optional check mark.
const MARKER = /^[ \t]*(?:\u2705\uFE0F?[ \t]*)?Addressed in commits?[ \t]+`?([0-9a-f]{7,40})(?![0-9a-z])`?(?:[ \t]+to[ \t]+`?([0-9a-f]{7,40})(?![0-9a-z])`?)?[ \t.]*$/gim;

/** The SHA of the last "Addressed in commit(s) ..." marker line outside fenced blocks of a CodeRabbit root body ("a to b" gives b), or null. */
export function parseMarker(body) {
  let found = null;
  for (const m of dropFences(String(body ?? '')).join('\n').matchAll(MARKER)) {
    const candidate = m[2] ?? m[1];
    if (SHA_WHOLE.test(candidate)) found = candidate.toLowerCase();
  }
  return found;
}

// ---- authors, trust, rollups --------------------------------------------------------------------------------------------------

export function authorKind(user, trusted = new Set()) {
  const login = typeof user?.login === 'string' ? user.login : '';
  if (!login || login.toLowerCase() === 'ghost') return 'unknown';
  if (isCodeRabbitUser(user)) return 'cr';
  if (user.type === 'Bot' || login.toLowerCase().endsWith('[bot]')) return 'bot';
  return trusted.has(login.toLowerCase()) ? 'trusted' : 'human';
}

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Lowercase logins: the repo owner, the PR author, and each commenter who is OWNER, MEMBER or COLLABORATOR. */
export function trustedSet({ repo, prAuthor, comments = [] }) {
  const set = new Set();
  const add = (login) => { if (typeof login === 'string' && login !== '') set.add(login.toLowerCase()); };
  add(String(repo ?? '').split('/')[0]);
  add(prAuthor);
  for (const c of comments) if (TRUSTED_ASSOCIATIONS.has(c?.author_association)) add(c?.user?.login);
  return set;
}

const count = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
export const thumbsOf = (reactions) => ({ up: count(reactions?.['+1']), down: count(reactions?.['-1']) });

export function prOf(comment) {
  const m = /\/pulls\/(\d+)$/.exec(String(comment?.pull_request_url ?? ''));
  return m ? Number(m[1]) : null;
}

// ---- the decision for one bot root --------------------------------------------------------------------------------------------

const byTime = (a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0) || (a.id ?? 0) - (b.id ?? 0);
const result = (over) => ({ disposition: 'unlabeled', evidence: null, reason: null, rule: null, sha: null, replyId: null, ...over });
const thumbsReason = ({ up, down }) => (up && down ? 'thumbs_conflict' : down ? 'thumbs_down_unverified' : up ? 'thumbs_up_only' : 'no_signal');

/** One trusted reply: { label }, { courtesy: true } or { reason }. G1 asks git about the file and the original commit of the finding. */
function outcomeOf(reply, { file, original }, proof) {
  const p = parseReply(reply.body);
  if (p.form === 'g1') {
    const e = shaEvidence({ git: proof?.git, sha: p.sha, file, mainSha: proof?.mainSha, original });
    return e.sha ? { label: { disposition: 'fixed', evidence: 'reply_sha_verified', rule: 'g1', sha: e.sha } } : { reason: e.reason };
  }
  if (p.form === 'g2') return { label: { disposition: p.disposition, evidence: p.evidence, rule: 'g2', sha: null } };
  return p.form === 'courtesy' ? { courtesy: true } : { reason: p.reason };
}

/**
 * G3 over the trusted replies in time order. The last label decides; two labels that differ, or a later reply that is
 * neither a label nor courtesy only, give reply_conflict. With no label: the reason of the last reply that is not
 * courtesy only. { label, reply }, { reason, reply }, or null when every reply is courtesy only. finding: { file, original }.
 */
function readThread(mine, finding, proof) {
  const seen = mine.map((r) => [r, outcomeOf(r, finding, proof)]);
  const labels = seen.filter(([, o]) => o.label);
  const last = labels.at(-1);
  if (!last) {
    const off = seen.filter(([, o]) => !o.courtesy).at(-1);
    return off ? { reason: off[1].reason, reply: off[0] } : null;
  }
  if (labels.some(([, o]) => o.label.disposition !== last[1].label.disposition)) return { reason: 'reply_conflict', reply: last[0] };
  const after = seen.slice(seen.indexOf(last) + 1).find(([, o]) => !o.courtesy);
  return after ? { reason: 'reply_conflict', reply: after[0] } : { label: last[1].label, reply: last[0] };
}

/**
 * Order: the trusted replies (G3), then the CodeRabbit marker (G4: below every trusted reply), then a thumbs reason.
 * proof: { git, mainSha } for G1; without it no G1 reply labels. Only a trusted reply gives wrong or wont_fix.
 * `sha` is git-verified only when rule is 'g1'. With evidence reply_no_sha or cr_marker it is the bot marker's SHA, not verified.
 */
export function decide({ root, replies = [], trusted = new Set(), proof = null }) {
  const mine = replies.filter((r) => authorKind(r?.user, trusted) === 'trusted').sort(byTime);
  const marker = parseMarker(root?.body);
  if (mine.length === 0) {
    return marker ? result({ disposition: 'fixed', evidence: 'cr_marker', sha: marker }) : result({ reason: thumbsReason(thumbsOf(root?.reactions)) });
  }
  const t = readThread(mine, { file: root?.path, original: root?.original_commit_id }, proof);
  if (t === null) return result({ reason: 'reply_unmatched' });
  if (!t.label) return result({ reason: t.reason, replyId: t.reply.id });
  const { disposition, evidence, rule, sha } = t.label;
  // Only a fix takes the marker SHA: a wrong or wont_fix record has no fix commit.
  return result({ disposition, evidence, rule, sha: sha ?? (disposition === 'fixed' ? marker : null), replyId: t.reply.id });
}

// ---- one PR -------------------------------------------------------------------------------------------------------------------

const HEX40 = /^[0-9a-f]{40}$/i;
const isRoot = (c) => c?.in_reply_to_id == null;
const isRootShape = (c) => Number.isInteger(c?.id) && HEX40.test(String(c.original_commit_id ?? '')) && typeof c.path === 'string' && c.path !== '';

function replyCounts(replies, trusted) {
  const out = { trusted: 0, human: 0, bot: 0, unknown: 0, cr: 0 };
  for (const r of replies) out[authorKind(r.user, trusted)] += 1;
  return out;
}

function recordOf(pr, c, replies, trusted, proof) {
  const d = decide({ root: c, replies, trusted, proof });
  return {
    key: `${pr}:${c.id}`, pr, commentId: c.id, path: c.path, line: c.original_line ?? null, originalCommit: c.original_commit_id.toLowerCase(),
    severity: inlineCommentSeverity(c.body), disposition: d.disposition, verdict: verdictOf(d.disposition, d.evidence), by: BY,
    evidence: d.evidence, reason: d.reason, rule: d.rule, sha: d.sha, replyId: d.replyId, thumbs: thumbsOf(c.reactions),
    replies: replyCounts(replies, trusted), outdated: c.line == null, parsed: true, marker: parseMarker(c.body) !== null,
  };
}

const repliesByParent = (comments) => {
  const map = new Map();
  for (const c of comments) if (!isRoot(c)) map.set(c.in_reply_to_id, [...(map.get(c.in_reply_to_id) ?? []), c]);
  return map;
};

/** { records, unparsed: [{ key, reason, kind }], botReplies: { all, parsed } } for the comments of one merged PR. */
export function findingsForPr({ pr, comments = [], prFact = null, repo = DEFAULT_REPO, proof = null }) {
  const trusted = trustedSet({ repo, prAuthor: prFact?.author, comments });
  const rootIds = new Set(comments.filter(isRoot).map((c) => c.id));
  const kids = repliesByParent(comments);
  const records = [];
  const unparsed = [];
  const botReplies = { all: 0, parsed: 0 };
  for (const c of comments.filter((x) => isCodeRabbitUser(x?.user))) {
    const key = `${pr}:${c.id}`;
    if (isRoot(c)) {
      if (isRootShape(c)) records.push(recordOf(pr, c, kids.get(c.id) ?? [], trusted, proof));
      else unparsed.push({ key, reason: 'bad_shape', kind: 'root' });
    } else {
      botReplies.all += 1;
      if (rootIds.has(c.in_reply_to_id)) botReplies.parsed += 1;
      else unparsed.push({ key, reason: 'orphan_reply', kind: 'reply' });
    }
  }
  records.sort((a, b) => a.commentId - b.commentId);
  return { records, unparsed, botReplies };
}

// ---- summary ------------------------------------------------------------------------------------------------------------------

const ratio = (n, d) => (d > 0 ? n / d : null);
const tally = (items, keys, pick) => Object.fromEntries(keys.map((k) => [k, items.filter((i) => pick(i) === k).length]));
const anyReply = (r) => r.replies.trusted + r.replies.human + r.replies.bot + r.replies.unknown > 0;

function repliedOf(records) {
  const replied = records.filter((r) => r.replies.trusted > 0);
  const labeled = replied.filter((r) => r.disposition !== 'unlabeled').length;
  return { findings: replied.length, anyReply: records.filter(anyReply).length, labeled, unlabeled: replied.length - labeled, share: ratio(labeled, replied.length) };
}

function parsedOf({ records, unparsed, botReplies }) {
  const roots = records.length + unparsed.filter((u) => u.kind !== 'reply').length;
  const all = roots + botReplies.all;
  const parsedAll = records.length + botReplies.parsed;
  const share = ratio(parsedAll, all);
  const rootShare = ratio(records.length, roots);
  const met = share !== null && rootShare !== null && share >= BAR && rootShare >= BAR;
  return { denominator: { rule: DENOMINATOR_RULE, all, roots, replies: botReplies.all }, parsed: { all: parsedAll, roots: records.length, replies: botReplies.parsed, share, rootShare, bar: BAR, met } };
}

/** PRs in range with no merge, and their bot comments: open apart from closed without merge. */
const EXCLUDED_KEYS = ['openPrs', 'closedUnmergedPrs', 'openComments', 'closedUnmergedComments'];
const EVIDENCE_KEYS = ['reply_sha_verified', 'reply_no_sha', 'reply_wont_fix', 'reply_wrong', 'cr_marker'];
const REASON_KEYS = ['reply_extra_text', 'reply_unmatched', 'sha_unknown', 'sha_not_newer', 'sha_other_file', 'reply_conflict', 'thumbs_up_only', 'thumbs_down_unverified', 'thumbs_conflict', 'no_signal'];

/** The evidence summary: counts only, no PR number per finding, no comment id, no text. Pure: the stamp comes in as `generatedAt`. */
export function summarize({ records, unparsed, botReplies, excluded, range, repo, generatedAt, mainRef = null, mainSha = null }) {
  const labeled = records.filter((r) => r.disposition !== 'unlabeled').length;
  const by = tally(records, ['fixed', 'wont_fix', 'wrong', 'unlabeled'], (r) => r.disposition);
  const fixedMarker = records.filter((r) => r.disposition === 'fixed' && r.evidence === 'cr_marker').length;
  const unlabeledWithMarker = records.filter((r) => r.disposition === 'unlabeled' && r.marker === true).length;
  return {
    v: 2, kind: 'cr-dispositions', repo, generatedAt, rulesVersion: RULES_VERSION, mainRef, mainSha, range,
    ...parsedOf({ records, unparsed, botReplies }),
    labeled: { count: labeled, share: ratio(labeled, records.length) },
    replied: repliedOf(records),
    counts: { fixed: by.fixed, fixedHuman: by.fixed - fixedMarker, fixedMarker, wont_fix: by.wont_fix, wrong: by.wrong, unlabeled: by.unlabeled, unlabeledWithMarker },
    evidence: tally(records, EVIDENCE_KEYS, (r) => r.evidence),
    reasons: tally(records, REASON_KEYS, (r) => r.reason),
    unparsedReasons: tally(unparsed, ['bad_shape', 'orphan_reply', 'pr_unknown', 'no_pr_url'], (u) => u.reason),
    excluded: Object.fromEntries(EXCLUDED_KEYS.map((k) => [k, excluded?.[k] ?? 0])),
  };
}

/** The one place that picks the exit code of a finished sweep: 0 when the parsed bar is met, else 3. */
export const gateOf = (summary) => (summary.parsed.met ? 0 : 3);

// ---- gh edge ------------------------------------------------------------------------------------------------------------------

export class SweepError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'SweepError';
    this.kind = kind;
  }
}

/** A fixed text plus only the HTTP status: a gh failure message holds the command line and gh's stderr (the API text). */
function ghErrorText(e) {
  const m = /\bHTTP (\d{3})\b/.exec(String(e?.message ?? ''));
  return m ? `gh api call failed (HTTP ${m[1]})` : 'gh api call failed';
}

/** A paged listing, flattened, shape-checked (every row an object with an integer `key`), without repeated rows. */
async function pagedRows(gh, route, key) {
  let rows;
  try {
    rows = await ghList(gh, route);
  } catch (e) {
    // A JSON parse error quotes the response: print a fixed text.
    if (e instanceof SyntaxError) throw new SweepError('bad_shape', 'gh output is not JSON');
    throw new SweepError('gh_error', ghErrorText(e));
  }
  if (!Array.isArray(rows) || !rows.every((r) => r && typeof r === 'object' && !Array.isArray(r) && Number.isInteger(r[key]))) {
    throw new SweepError('bad_shape', `unexpected shape from ${route.split('?')[0]}`);
  }
  return [...new Map(rows.map((r) => [r[key], r])).values()];
}

export const fetchPrs = (gh, repo) => pagedRows(gh, `repos/${repo}/pulls?state=all&sort=created&direction=asc`, 'number');
export const fetchComments = (gh, repo, since) => pagedRows(gh, `repos/${repo}/pulls/comments?sort=created&direction=asc&since=${since}`, 'id');

const topMerged = (prs) => prs.filter((p) => p.merged_at).reduce((hi, p) => Math.max(hi, p.number), 0) || null;

/** Groups rows by PR number inside [from, to]. Rows with no PR url come back apart. */
function groupByPr(rows, from, to) {
  const byPr = new Map();
  const noUrl = [];
  for (const c of rows) {
    const pr = prOf(c);
    if (pr === null) noUrl.push(c);
    else if (pr >= from && pr <= to) byPr.set(pr, [...(byPr.get(pr) ?? []), c]);
  }
  return { byPr, noUrl };
}

const strayEntry = (c, pr, reason) => ({ key: `${pr}:${c.id}`, reason, kind: isRoot(c) ? 'root' : 'reply' });
const isOpenPr = (p) => p.state === 'open';

/** The unmerged PRs in [from, hi], open apart from closed without merge; the comment counts start at 0. */
function excludedOf(prs, from, hi) {
  const unmerged = prs.filter((p) => p.number >= from && (hi == null || p.number <= hi) && !p.merged_at);
  const open = unmerged.filter(isOpenPr).length;
  return { openPrs: open, closedUnmergedPrs: unmerged.length - open, openComments: 0, closedUnmergedComments: 0 };
}

/** Decides the grouped comments: findings of merged PRs, strays as unparsed, unmerged bot comments as excluded counts. */
function collect({ byPr, noUrl, factOf, repo, excluded, proof }) {
  const acc = { records: [], unparsed: [], botReplies: { all: 0, parsed: 0 } };
  const stray = (c, pr, reason) => {
    if (!isCodeRabbitUser(c.user)) return;
    acc.unparsed.push(strayEntry(c, pr, reason));
    if (!isRoot(c)) acc.botReplies.all += 1;
  };
  for (const c of noUrl) stray(c, 'none', 'no_pr_url');
  for (const [pr, comments] of [...byPr].sort((a, b) => a[0] - b[0])) {
    const fact = factOf.get(pr);
    if (!fact) comments.forEach((c) => stray(c, pr, 'pr_unknown'));
    else if (!fact.merged_at) excluded[isOpenPr(fact) ? 'openComments' : 'closedUnmergedComments'] += comments.filter((c) => isCodeRabbitUser(c.user)).length;
    else {
      const got = findingsForPr({ pr, comments, prFact: { author: fact.user?.login ?? null }, repo, proof });
      acc.records.push(...got.records);
      acc.unparsed.push(...got.unparsed);
      acc.botReplies.all += got.botReplies.all;
      acc.botReplies.parsed += got.botReplies.parsed;
    }
  }
  return acc;
}

/**
 * Calls the two listings and decides every comment. Returns { summary, file }; throws SweepError.
 * git and mainSha (the resolved main ref) feed G1; with no git, no G1 reply labels.
 */
export async function sweep({ from, to, repo = DEFAULT_REPO, generatedAt, mainRef = null, mainSha = null }, { gh = defaultGh, git = null } = {}) {
  const prs = await fetchPrs(gh, repo);
  const hi = to ?? topMerged(prs);
  const first = prs.filter((p) => p.number >= from).sort((a, b) => a.number - b.number)[0];
  const open = first && hi != null && first.number <= hi;
  if (open && typeof first.created_at !== 'string') throw new SweepError('bad_shape', 'a PR row has no created_at');
  const rows = open ? await fetchComments(gh, repo, first.created_at) : [];
  const { byPr, noUrl } = groupByPr(rows, from, hi ?? from - 1);
  const excluded = excludedOf(prs, from, hi);
  const proof = { git: typeof git === 'function' ? memoGit(git) : null, mainSha };
  const { records, unparsed, botReplies } = collect({ byPr, noUrl, factOf: new Map(prs.map((p) => [p.number, p])), repo, excluded, proof });
  records.sort((a, b) => a.pr - b.pr || a.commentId - b.commentId);
  unparsed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const summary = summarize({ records, unparsed, botReplies, excluded, range: { from, to: hi ?? null }, repo, generatedAt, mainRef, mainSha });
  return { summary, file: { ...summary, findings: records, unparsed: unparsed.map(({ key, reason }) => ({ key, reason })) } };
}

// ---- the version of the label rules --------------------------------------------------------------------------------------------

const toLf = (s) => s.replace(/\r\n?/g, '\n');
/** A hash part: a RegExp as source and flags, a Set sorted, a Map as sorted entries, a function as its LF source, a string with LF ends. */
function versionPart(x) {
  if (x instanceof RegExp) return ['re', x.source, x.flags];
  if (x instanceof Set) return ['set', [...x].map(String).sort()];
  if (x instanceof Map) return ['map', [...x].map((e) => JSON.stringify(e)).sort()];
  if (typeof x === 'function') return ['fn', toLf(x.toString())];
  if (Array.isArray(x)) return x.map(versionPart);
  return typeof x === 'string' ? toLf(x) : x;
}

/** 16 hex characters over the ordered parts. */
export function rulesVersionOf(parts) {
  return createHash('sha256').update(JSON.stringify(parts.map(versionPart))).digest('hex').slice(0, 16);
}

/** Every part that decides a label: the grammar lists, the patterns, and the source text of each label function. */
export const VERSION_PARTS = Object.freeze([
  GRAMMAR, EVIDENCE_OF, G2_LABEL, COURTESY, G1, MARKUP, MARKUP_ALL, ASK, SHA_END, EXTRA, UNKNOWN, NOT_NEWER, ZERO_WIDTH, APOSTROPHES, STRUCK, STRIKE_TAG, FENCE, BLANK, QUOTE, INDENTED,
  FULL_SHA, SHORT_SHA, MAIN_REF, SHA_WHOLE, MARKER, HEX40, CODERABBIT_LOGIN, DEFAULT_REPO, DEFAULT_MAIN_REF, VERDICT_OF, TRUSTED_ASSOCIATIONS, GIT_MOVES,
  cutStrikeTags, fenceOf, closesFence, dropFences, dropBlocks, cleanReply, firstSentence, g1Of, normal, partsOf, g2Of, startsG2, parseReply,
  tryGit, gitStatus, notNewer, mainShaOf, shaEvidence, memoGit, gitEnvOf, defaultGit, parseMarker, verdictOf, authorKind, isCodeRabbitUser, trustedSet, count, thumbsOf, prOf,
  byTime, result, thumbsReason, outcomeOf, readThread, decide, isRoot, isRootShape, replyCounts, repliesByParent, recordOf, findingsForPr,
  groupByPr, strayEntry, isOpenPr, collect, sweep,
]);

/** The version of the frozen rule set. A file with another value was labeled by other rules. */
export const RULES_VERSION = rulesVersionOf(VERSION_PARTS);

// ---- CLI ----------------------------------------------------------------------------------------------------------------------

const USAGE = [
  'Usage: dispositions.mjs sweep [--from N] [--to N] [--repo owner/name] [--main-ref REF] [--out FILE] [--summary-out FILE] [--json]',
  '       dispositions.mjs --help | -h',
  'G1 replies need the local repo: git proves each SHA against --main-ref (default main). No fetch. --repo must be the repo of this checkout.',
  'Exit: 0 parsed bar met, 1 gh failure (nothing written) or another error (one fixed line), 2 bad input (a --main-ref that names no commit too),',
  '      3 sweep ran but the parsed bar is not met.',
].join('\n');

const WITH_VALUE = new Set(['--from', '--to', '--repo', '--main-ref', '--out', '--summary-out']);
const positive = (s) => (/^[1-9]\d*$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null);

function readFlags(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const name = rest[i];
    if (name === '--json') flags.json = true;
    else if (!WITH_VALUE.has(name)) return { error: `unknown argument ${JSON.stringify(name)}` };
    else if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) return { error: `${name} needs a value` };
    else flags[name.slice(2)] = rest[++i];
  }
  return { flags };
}

/** { opts } or { error } or { help }. Every check runs before any gh or git call. */
function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (argv[0] !== 'sweep') return { error: argv.length === 0 ? 'no command' : `unknown command ${JSON.stringify(argv[0])}` };
  const { flags, error } = readFlags(argv.slice(1));
  if (error) return { error };
  const from = flags.from === undefined ? DEFAULT_FROM : positive(flags.from);
  const to = flags.to === undefined ? undefined : positive(flags.to);
  if (from === null || to === null) return { error: '--from and --to need a positive integer' };
  if (to !== undefined && from > to) return { error: '--from is above --to' };
  const repo = flags.repo ?? DEFAULT_REPO;
  const bad = repoError(repo);
  if (bad) return { error: bad };
  const mainRef = flags['main-ref'] ?? DEFAULT_MAIN_REF;
  if (!MAIN_REF.test(mainRef)) return { error: '--main-ref must be a ref name' };
  return { opts: { from, to, repo, mainRef, out: flags.out, summaryOut: flags['summary-out'], json: Boolean(flags.json) } };
}

const UPSTREAM_OWNER = 'parcadei';

/** null when `repo` is owner/name with no dot-only segment and an owner other than the upstream one; else the error text. */
function repoError(repo) {
  const segs = repo.split('/');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || segs.some((s) => /^\.+$/.test(s))) return '--repo must look like owner/name';
  if (segs[0].toLowerCase() === UPSTREAM_OWNER) return '--repo must not name the upstream owner';
  return null;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** The real path of the deepest existing ancestor, with the missing tail put back. */
function realish(p) {
  const abs = path.resolve(p);
  const tail = [];
  let cur = abs;
  while (!existsSync(cur) && path.dirname(cur) !== cur) {
    tail.unshift(path.basename(cur));
    cur = path.dirname(cur);
  }
  try { return path.join(realpathSync(cur), ...tail); } catch { return abs; }
}

const within = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

const LONG_PATH = /^[\\/]{2}\?[\\/]/;
const LONG_DRIVE = /^[A-Za-z]:[\\/]/;
const UNC = /^[\\/]{2}/;

/**
 * The absolute path with a long-path prefix stripped, or null for every UNC form (a share, a device path, the long-path UNC
 * form), a long-path form whose tail is not <drive>:\ (GLOBALROOT), and, on Windows, an alternate data stream.
 */
function plainPath(file) {
  const raw = String(file);
  const long = LONG_PATH.test(raw);
  const bare = long ? raw.slice(4) : raw;
  if ((long && !LONG_DRIVE.test(bare)) || UNC.test(bare)) return null;
  const abs = path.resolve(bare);
  if (process.platform === 'win32' && abs.indexOf(':', 2) !== -1) return null;
  return UNC.test(abs) ? null : abs;
}

/** True when `abs` or any ancestor holds a `.git` entry (a folder, or a worktree's file). */
function inGitTree(abs) {
  for (let cur = abs; ; cur = path.dirname(cur)) {
    if (existsSync(path.join(cur, '.git'))) return true;
    if (path.dirname(cur) === cur) return false;
  }
}

/** True when `abs` or an ancestor is a link whose target is missing: lstat sees the entry, existsSync does not. */
function underDanglingLink(abs) {
  for (let cur = abs; ; cur = path.dirname(cur)) {
    try {
      if (!existsSync(cur) && lstatSync(cur, { throwIfNoEntry: false })) return true;
    } catch { /* not a link: an ancestor is a file, the write fails later */ }
    if (path.dirname(cur) === cur) return false;
  }
}

/**
 * True when `file` is a UNC form, sits under a dangling link, or resolves inside any repo tree (an ancestor with a .git entry,
 * seen through the plain and the real path), under the repo root of this script, or under any .claude/worktrees folder.
 */
export function outRefused(file, root = REPO_ROOT) {
  const abs = plainPath(file);
  if (abs === null || underDanglingLink(abs)) return true;
  const real = realish(abs);
  if (inGitTree(abs) || inGitTree(real)) return true;
  const target = fold(real);
  const roots = [path.resolve(root), realish(root)].map(fold);
  const segs = target.split(/[\\/]+/);
  return roots.some((r) => within(r, target)) || segs.some((s, i) => s === '.claude' && segs[i + 1] === 'worktrees');
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const defaultOut = (home, now) => path.join(home, '.claude', 'state', STATE_FOLDER, `${localDate(now)}-dispositions.json`);
const sameFile = (a, b) => fold(realish(a)) === fold(realish(b));

/** { file, summaryFile } or { error }: the write targets, checked before any gh or git call. The default path takes the same check. */
function targetsOf(opts, home, now) {
  const wanted = opts.out ?? defaultOut(home, now);
  if (outRefused(wanted)) return { error: '--out must be outside every repo tree and not a UNC or stream path or under a dangling link' };
  const file = plainPath(wanted);
  if (opts.summaryOut === undefined) return { file, summaryFile: null };
  const summaryFile = plainPath(opts.summaryOut);
  if (summaryFile === null) return { error: '--summary-out must not be a UNC or stream path' };
  if (sameFile(file, summaryFile)) return { error: '--summary-out must not be the --out file' };
  return { file, summaryFile };
}

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const pct = (share) => (share === null ? 'n/a' : `${(share * 100).toFixed(1)}%`);
const lineOf = (s) => `dispositions: ${s.denominator.all} bot comments, parsed ${pct(s.parsed.share)}, replied labeled ${s.replied.labeled}/${s.replied.findings}, `
  + `fixed ${s.counts.fixed} wont_fix ${s.counts.wont_fix} wrong ${s.counts.wrong} unlabeled ${s.counts.unlabeled}`;

/** The one fixed line for an error that is not a SweepError: no message, no stack, no path. */
const INTERNAL_LINE = 'dispositions failed (internal): unexpected error';
const failLine = (e) => (e instanceof SweepError ? `dispositions failed (${e.kind}): ${e.message.replace(/\s+/g, ' ').slice(0, 200)}` : INTERNAL_LINE);

async function runSweep(opts, { file, summaryFile }, { gh, git, now, mainSha }, out) {
  const input = { from: opts.from, to: opts.to, repo: opts.repo, generatedAt: new Date(now).toISOString(), mainRef: opts.mainRef, mainSha };
  const { summary, file: full } = await sweep(input, { gh, git });
  writeJson(file, full);
  if (summaryFile !== null) writeJson(summaryFile, summary);
  out(opts.json ? JSON.stringify(summary, null, 1) : lineOf(summary));
  return gateOf(summary);
}

/** True when git names no repo (an injected git), or names the --repo of the sweep (case does not count on GitHub). */
const historyFits = (git, repo) => typeof git.repo !== 'string' || git.repo.toLowerCase() === String(repo).toLowerCase();

export async function main(argv, deps = {}) {
  const out = deps.stdout ?? ((s) => console.log(s));
  const err = deps.stderr ?? ((s) => console.error(s));
  const parsed = parseArgs(argv);
  if (parsed.help) { out(USAGE); return 0; }
  const now = (deps.now ?? Date.now)();
  const targets = parsed.error ? parsed : targetsOf(parsed.opts, deps.homedir ?? os.homedir(), now);
  if (targets.error) { err(`dispositions: ${targets.error}\n${USAGE}`); return 2; }
  const git = deps.git ?? defaultGit;
  if (!historyFits(git, parsed.opts.repo)) { err(`dispositions: --repo must be the repo whose history git reads (${git.repo})\n${USAGE}`); return 2; }
  const mainSha = mainShaOf(git, parsed.opts.mainRef);
  if (mainSha === null) { err(`dispositions: --main-ref does not name a commit in this checkout\n${USAGE}`); return 2; }
  try {
    return await runSweep(parsed.opts, targets, { gh: deps.gh ?? defaultGh, git, now, mainSha }, out);
  } catch (e) {
    err(failLine(e));
    return 1;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => process.exit(code), () => { console.error(INTERNAL_LINE); process.exit(1); });
}
