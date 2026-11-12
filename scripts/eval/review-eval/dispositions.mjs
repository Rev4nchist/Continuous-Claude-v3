#!/usr/bin/env node
// What happened to each CodeRabbit inline finding on merged PRs: fixed, wont_fix, wrong or unlabeled.
// A disposition comes only from a trusted human's reply, or from CodeRabbit's own "Addressed in commit" marker (no verdict).
// Thumbs never label: the REST rollup does not say who reacted. An open finding is never negative.
// Read-only: two paged `gh api` GET calls in all. `gh` is injectable: async (args: string[]) => parsed JSON (same contract as github.mjs).
// The full file holds PR numbers and comment ids, so --out (and the default path) is refused inside every repo tree, on a UNC path and on a stream path.
// --summary-out holds counts only; it must not be the --out file.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPO } from '../../github/cursor-review.mjs';
import { CODERABBIT_LOGIN, inlineCommentSeverity, isCodeRabbitUser } from '../../github/review-status.mjs';
import { defaultGh, ghList } from './github.mjs';

export const BY = 'cr-disposition';
export const BAR = 0.9;
const DEFAULT_FROM = 188;
const DENOMINATOR_RULE = 'REST pulls/comments by coderabbitai[bot] (type Bot) on merged PRs in range; review-body findings are outside pulls/comments';
const STATE_FOLDER = 'review-engine';

export const VERDICT_OF = Object.freeze({ fixed: 'real', wrong: 'noise', wont_fix: 'unclear', unlabeled: null });
/** A bot's own "Addressed in commit" claim is not a label: no verdict. */
export const verdictOf = (disposition, evidence) => (evidence === 'cr_marker' ? null : (VERDICT_OF[disposition] ?? null));

// ---- SHA and text -------------------------------------------------------------------------------------------------------------

// 7 to 40 hex characters with at least one digit and at least one a-f letter (rejects numbers, dates, ids, hex-only words).
const SHA_BODY = '(?<![0-9a-z])(?=[0-9a-f]{0,39}[0-9])(?=[0-9a-f]{0,39}[a-f])[0-9a-f]{7,40}(?![0-9a-z])';
const SHA_RE = new RegExp(SHA_BODY, 'i');
const SHA_WHOLE = /^(?=[0-9a-f]{0,39}[0-9])(?=[0-9a-f]{0,39}[a-f])[0-9a-f]{7,40}$/i;

export function findSha(text) {
  const m = SHA_RE.exec(String(text ?? ''));
  return m ? m[0].toLowerCase() : null;
}

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
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

/** The fence mark (``` or ~~~) a line opens or closes with, or null. */
function fenceOf(line) {
  const m = /^\s*(```|~~~)/.exec(line);
  return m ? m[1] : null;
}

/** True when the line holds an odd count of its fence mark (an even count opens and closes on one line). */
const togglesFence = (line, mark) => line.split(mark).length % 2 === 0;

/** The lines outside fenced blocks (``` and ~~~); the fence lines go too. An unclosed fence drops the rest. */
function dropFences(text) {
  const keep = [];
  let open = null;
  for (const line of text.split(/\r?\n/)) {
    const mark = fenceOf(line);
    if (open !== null) {
      if (mark === open && togglesFence(line, mark)) open = null;
    } else if (mark !== null) {
      if (togglesFence(line, mark)) open = mark;
    } else keep.push(line);
  }
  return keep;
}

/** Zero-width characters out, curly apostrophes folded; fenced blocks (``` and ~~~), quoted lines and struck text dropped. */
export function cleanReply(text) {
  const folded = String(text ?? '').replace(ZERO_WIDTH, '').replace(/[\u2018\u2019]/g, "'");
  return dropFences(folded).filter((line) => !/^\s*>/.test(line)).map((line) => cutStrikeTags(line).replace(STRUCK, ' ')).join('\n');
}

// ---- reply rules --------------------------------------------------------------------------------------------------------------

// No pattern has a nested quantifier: each runs in linear time. Every rule is a global regex; readSentence reads it with the guard.
const NEG_FIX = /\b(?:won't|will not|not going to)\s+(?:fix|change|address)\b|\bwontfix\b/gi;
/** The named-subject arm of the wrong rule. It counts only at the start of its sentence (see offStart). */
const WRONG_SUBJECT = /\b(?:(?:the|this|that)\s+)?(?:finding|comment|suggestion|review|bot|coderabbit)\s+(?:(?:is|was)\s+(?:incorrect|invalid|wrong)|does(?:n't| not) apply)\b/;
const WRONG = new RegExp(`\\bfalse[- ]positive\\b|\\bnot applicable\\b|${WRONG_SUBJECT.source}`, 'gi');
const WRONG_SUBJECT_WHOLE = new RegExp(`^(?:${WRONG_SUBJECT.source})$`, 'i');
/** What may stand before a named subject: nothing, or a bare no or nah. */
const LEAD_OK = /^(?:(?:no|nah)\b[\s,.!]*)?$/i;
// A follow-up or a separate PR declines only with a defer verb before it and a work noun after it ("moved to a follow-up PR").
// "Moved to a separate file" or "a follow-up commit" is a code move, not a decline: no work noun, no hit.
const DECLINE = /\bout of scope\b|\bby design\b|\bintentional(?:ly)?\b|\bdefer(?:red)?\b|\b(?:move[ds]?|moving|left|leave|leaving|punt(?:ed)?|split|track(?:ed)?)\s+(?:(?:it|this|that)\s+)?(?:to|in|into|for|as)\s+(?:a|the)\s+(?:separate|follow[- ]?up)\s+(?:pr|issue|ticket|change)s?\b|\b(?:leave|leaving|keep|keeping) (?:it |this )?as[- ]is\b/gi;
/** A bare follow-up or separate PR: it never labels, but beside a fix hit it makes a conflict ("Fixed; follow-up for the rest"). */
const NEG_MENTION = /\bfollow[- ]?ups?\b|\bseparate (?:pr|change|issue|ticket)s?\b/i;
const FIX_SHA = new RegExp(`\\b(?:fixed|addressed|resolved|done|applied|fix in)\\b[^\\n]{0,60}?(${SHA_BODY})`, 'gi');
const FIX_WORD = /\b(?:fixed|addressed|resolved)\b/gi;
const DONE_WORD = /\b(?:done|applied)\b/gi;
/** Any word of the fix family. A blocked sentence with one is a blocked fix (R9); it never labels on its own. */
const FIX_FAMILY = /\b(?:fix|fixe[sd]|fixing|addressed|resolved|done|applied)\b/i;

/** Frozen before the live run. Order: negatives first, then fix rules. Extend only from made-up text, with the seat's approval. */
export const REPLY_RULES = Object.freeze([
  Object.freeze({ id: 'neg_fix', re: NEG_FIX, disposition: 'wont_fix', evidence: 'reply_wont_fix' }),
  Object.freeze({ id: 'fix_sha', re: FIX_SHA, disposition: 'fixed', evidence: 'reply_sha', fix: true }),
  Object.freeze({ id: 'wrong', re: WRONG, disposition: 'wrong', evidence: 'reply_wrong' }),
  Object.freeze({ id: 'decline', re: DECLINE, disposition: 'wont_fix', evidence: 'reply_decline' }),
  Object.freeze({ id: 'fix_word', re: FIX_WORD, disposition: 'fixed', evidence: 'reply_no_sha', fix: true }),
  Object.freeze({ id: 'fix_done', re: DONE_WORD, disposition: 'fixed', evidence: 'reply_no_sha', fix: true, alone: true }),
]);
const isFixRule = (r) => r.fix === true;
const isNegRule = (r) => !isFixRule(r);
const NEG_RULES = REPLY_RULES.filter(isNegRule);
const FIX_RULES = REPLY_RULES.filter(isFixRule);
const ANY_HIT = new RegExp([NEG_FIX, WRONG, DECLINE, FIX_FAMILY].map((r) => r.source).join('|'), 'i');

// Modal, hedge, ask, partial, revert and negation words. Any of them in a hit sentence blocks the hit (in doubt, unlabeled).
const BLOCK_WORDS = new Set([
  'will', 'would', 'should', 'could', 'shall', 'cannot', 'never', 'not', 'gonna', 'must', 'if', 'whether', 'unsure', 'unclear', 'maybe', 'might', 'nothing', 'yet',
  'can', 'may', 'ought', 'probably', 'possibly', 'perhaps', 'likely', 'hopefully', 'think', 'guess', 'seems', 'please', 'confirm',
  'partly', 'partially', 'partial', 'half', 'most', 'some', 'except', 'still', 'revert', 'reverted', 'undo', 'undid', 'un', 'non',
]);
const BLOCK_PAIRS = new Set(['to be', 'need to', 'needs to', 'going to', 'plan to', 'plans to', 'planning to']);
const BLOCK_ENDS = /(?:n't|'ll|'d)$/;
const BARE_NO = /^(?:(?:no|nope)(?: not (?:yet|really))?|not (?:yet|really))$/;
const DONE_WORDS = new Set(['done', 'applied', 'thanks', 'thank', 'you', 'ty', 'all', 'now', 'both', 'ok', 'okay', 'yes', 'yep', 'sure']);
const SENTENCE_ENDS = new Set(['.', '!', '?']);

/** Sentences: cut after . ! or ? before a space or the end, and at every ; and line break. A manual scan: linear. */
function sentencesOf(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '\n' || c === ';' || (SENTENCE_ENDS.has(c) && (next === undefined || /\s/.test(next)))) {
      out.push(text.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

// A ? with no white space after it ("Fixed?No", a URL query). It does not cut the sentence: the whole sentence counts as a question.
const INNER_ASK = /\?(?=\S)/;

/** True when the trailing run of non-letters holds a question mark, or a ? stands with no white space after it. */
function isQuestion(s) {
  for (let i = s.length - 1; i >= 0 && !/[\p{L}\p{N}]/u.test(s[i]); i -= 1) if (s[i] === '?') return true;
  return INNER_ASK.test(s);
}

/** The word with its edge apostrophes cut. An index loop: a regex trim is quadratic on an inner apostrophe run. */
function trimQuotes(w) {
  let a = 0;
  let b = w.length;
  while (a < b && w[a] === "'") a += 1;
  while (b > a && w[b - 1] === "'") b -= 1;
  return w.slice(a, b);
}

const wordsOf = (s) => s.toLowerCase().split(/[^a-z']+/).map(trimQuotes).filter(Boolean);
const blockedWords = (ws) => ws.some((w, i) => BLOCK_WORDS.has(w) || BLOCK_ENDS.test(w) || BLOCK_PAIRS.has(`${w} ${ws[i + 1]}`));
const isBareNo = (s) => BARE_NO.test(wordsOf(s).join(' '));
const firstMatch = (s, re) => s.matchAll(re).next().value ?? null;

/** Every negative-rule match in a sentence, as [rule, start, end], in rule order. */
const negSpans = (s) => NEG_RULES.flatMap((rule) => [...s.matchAll(rule.re)].map((m) => [rule, m.index, m.index + m[0].length]));

/** The sentence with every span cut out, so a negation inside a negative phrase blocks nothing. */
function cutSpans(s, spans) {
  let out = '';
  let at = 0;
  for (const [, start, end] of [...spans].sort((a, b) => a[1] - b[1])) {
    if (start > at) out += s.slice(at, start);
    out += ' ';
    at = Math.max(at, end);
  }
  return out + s.slice(at);
}

/** Done or applied as a short sentence with no object: at most 4 words, each from DONE_WORDS. */
function doneAlone(s) {
  const ws = wordsOf(s);
  return ws.length > 0 && ws.length <= 4 && ws.some((w) => w === 'done' || w === 'applied') && ws.every((w) => DONE_WORDS.has(w));
}

/** The first fix rule (in rule order) that matches, as [rule, match], or null. */
function fixMatch(rest) {
  for (const rule of FIX_RULES) {
    const m = rule.alone ? (doneAlone(rest) ? [] : null) : firstMatch(rest, rule.re);
    if (m) return [rule, m];
  }
  return null;
}

/** True when a span is the named-subject wrong arm and something other than a bare no or nah stands before it. */
function offStart(s, [rule, start, end]) {
  if (rule.id !== 'wrong' || !WRONG_SUBJECT_WHOLE.test(s.slice(start, end))) return false;
  return start > 16 || !LEAD_OK.test(s.slice(0, start).trim());
}

/**
 * What one sentence says, or null when no rule word is in it. The guard reads the whole sentence outside the negative
 * phrases: a block word before or after the hit blocks it. A question blocks a negative hit and voids a fix hit.
 * An off-start wrong subject blocks the negative hit. fixMention: an unblocked fix-family word that no fix rule took.
 */
function readSentence(s) {
  if (!ANY_HIT.test(s)) return null;
  const spans = negSpans(s);
  const rest = cutSpans(s, spans);
  const ask = isQuestion(s);
  const held = blockedWords(wordsOf(rest));
  const fix = ask ? null : fixMatch(rest);
  const stop = held || ask || spans.some((sp) => offStart(s, sp));
  const family = FIX_FAMILY.test(rest);
  return {
    neg: stop ? null : (spans[0]?.[0] ?? null), negBlocked: spans.length > 0 && stop,
    fix: held ? null : fix, fixBlocked: !ask && held && family, fixMention: !ask && !held && !fix && family,
  };
}

const ruleIndex = (rule) => REPLY_RULES.indexOf(rule);
const firstByOrder = (hits) => hits.reduce((best, h) => (best === null || ruleIndex(h[0]) < ruleIndex(best[0]) ? h : best), null);
const labelOf = ([rule, m]) => ({ disposition: rule.disposition, evidence: rule.evidence, rule: rule.id, sha: rule.id === 'fix_sha' ? m[1].toLowerCase() : null });
const CONFLICT = Object.freeze({ disposition: 'unlabeled', evidence: null, rule: 'reply_conflict', sha: null });

/** True when a sentence with a hit is followed by a bare no (no, nope, not yet, not really). */
const answeredNo = (parts, seen) => seen.some((x, i) => x !== null && i + 1 < parts.length && isBareNo(parts[i + 1]));

/**
 * { parsed, blocked }. parsed: { disposition, evidence, rule, sha } or null. Conflict (unlabeled reply_conflict): a blocked
 * negative hit, a hit answered by a bare no, a clean fix hit beside a negative hit, a blocked fix hit or a bare follow-up
 * mention, or a negative hit beside a fix mention. blocked: the reply holds only a blocked fix hit (it undoes an earlier fix).
 */
function readReply(text) {
  const clean = cleanReply(text);
  const parts = ANY_HIT.test(clean) ? sentencesOf(clean) : [];
  const seen = parts.map(readSentence);
  const has = (key) => seen.some((x) => x?.[key]);
  const neg = firstByOrder(seen.filter((x) => x?.neg).map((x) => [x.neg, null]));
  const fix = firstByOrder(seen.map((x) => x?.fix).filter(Boolean));
  const mixed = (fix && (neg || has('fixBlocked') || NEG_MENTION.test(clean))) || (neg && has('fixMention'));
  if (answeredNo(parts, seen) || has('negBlocked') || mixed) return { parsed: { ...CONFLICT }, blocked: false };
  const hit = neg ?? fix;
  return { parsed: hit ? labelOf(hit) : null, blocked: has('fixBlocked') };
}

/** { disposition, evidence, rule, sha } or null. A fix rule and a negative rule together give unlabeled reply_conflict. */
export const parseReply = (text) => readReply(text).parsed;

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

const toLf = (s) => s.replace(/\r\n?/g, '\n');
/** A hash part: a RegExp as source and flags, a Set sorted, a function as its LF source text, a string with LF ends. */
function versionPart(x) {
  if (x instanceof RegExp) return ['re', x.source, x.flags];
  if (x instanceof Set) return ['set', [...x].map(String).sort()];
  if (typeof x === 'function') return ['fn', toLf(x.toString())];
  if (Array.isArray(x)) return x.map(versionPart);
  return typeof x === 'string' ? toLf(x) : x;
}

/** 16 hex characters over the ordered rule set (id, regex source and flags, disposition, evidence, fix, alone) and the extra parts. */
export function rulesVersionOf(rules, extra = []) {
  const parts = rules.map((r) => [r.id, r.re.source, r.re.flags, r.disposition, r.evidence, Boolean(r.fix), Boolean(r.alone)]);
  return createHash('sha256').update(JSON.stringify([parts, extra.map(versionPart)])).digest('hex').slice(0, 16);
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

/**
 * [reply, parsed] of the latest trusted reply that parses (a conflict reply counts), or null. A later reply whose only hit is a
 * blocked fix ("not fixed") turns an earlier fix into a conflict; a later reply with no hit keeps the label.
 */
function latestDecision(mine) {
  let state = null;
  for (const r of mine) {
    const { parsed, blocked } = readReply(r.body);
    if (parsed) state = [r, parsed];
    else if (blocked && state?.[1].disposition === 'fixed') state = [r, { ...CONFLICT }];
  }
  return state;
}

/**
 * Order: the latest trusted reply that parses, then unmatched trusted replies (reply_unmatched), then the CodeRabbit marker,
 * then a thumbs reason, then no_signal. The marker ranks below every trusted reply. Only a trusted human reply gives wrong or wont_fix.
 */
export function decide({ root, replies = [], trusted = new Set() }) {
  const mine = replies.filter((r) => authorKind(r?.user, trusted) === 'trusted').sort(byTime);
  const marker = parseMarker(root?.body);
  const decided = latestDecision(mine);
  if (decided) {
    const [r, p] = decided;
    if (p.rule === 'reply_conflict') return result({ reason: 'reply_conflict', rule: p.rule, replyId: r.id });
    // Only a fix takes the marker SHA: a wrong or wont_fix record has no fix commit.
    return result({ disposition: p.disposition, evidence: p.evidence, rule: p.rule, sha: p.sha ?? (p.disposition === 'fixed' ? marker : null), replyId: r.id });
  }
  if (mine.length > 0) return result({ reason: 'reply_unmatched' });
  if (marker) return result({ disposition: 'fixed', evidence: 'cr_marker', sha: marker });
  return result({ reason: thumbsReason(thumbsOf(root?.reactions)) });
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

function recordOf(pr, c, replies, trusted) {
  const d = decide({ root: c, replies, trusted });
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
export function findingsForPr({ pr, comments = [], prFact = null, repo = DEFAULT_REPO }) {
  const trusted = trustedSet({ repo, prAuthor: prFact?.author, comments });
  const rootIds = new Set(comments.filter(isRoot).map((c) => c.id));
  const kids = repliesByParent(comments);
  const records = [];
  const unparsed = [];
  const botReplies = { all: 0, parsed: 0 };
  for (const c of comments.filter((x) => isCodeRabbitUser(x?.user))) {
    const key = `${pr}:${c.id}`;
    if (isRoot(c)) {
      if (isRootShape(c)) records.push(recordOf(pr, c, kids.get(c.id) ?? [], trusted));
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

// ---- the version of the label rules --------------------------------------------------------------------------------------------

/** Every part that decides a label: the constants and the source text of each label function (CRLF folded to LF). */
const LABEL_PARTS = [
  SHA_BODY, SHA_WHOLE, ZERO_WIDTH, STRUCK, STRIKE_TAG, MARKER, FIX_FAMILY, ANY_HIT, BLOCK_WORDS, BLOCK_PAIRS, BLOCK_ENDS, BARE_NO, DONE_WORDS, SENTENCE_ENDS, INNER_ASK,
  WRONG_SUBJECT, WRONG_SUBJECT_WHOLE, LEAD_OK, NEG_MENTION, HEX40, CODERABBIT_LOGIN, DEFAULT_REPO, CONFLICT, VERDICT_OF, TRUSTED_ASSOCIATIONS,
  NEG_RULES.map((r) => r.id), FIX_RULES.map((r) => r.id),
  findSha, cutStrikeTags, fenceOf, togglesFence, dropFences, cleanReply, isFixRule, isNegRule, sentencesOf, isQuestion, trimQuotes, wordsOf, blockedWords,
  isBareNo, firstMatch, negSpans, cutSpans, doneAlone, fixMatch, offStart, readSentence, ruleIndex, firstByOrder, labelOf, answeredNo, readReply, parseReply,
  parseMarker, verdictOf, authorKind, isCodeRabbitUser, trustedSet, count, thumbsOf, byTime, result, thumbsReason, latestDecision, decide, isRoot, isRootShape,
  repliesByParent, recordOf, findingsForPr,
];

/** The version of the frozen rule set. A file with another value was labeled by other rules. */
export const RULES_VERSION = rulesVersionOf(REPLY_RULES, LABEL_PARTS);

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

/** The evidence summary: counts only, no PR number per finding, no comment id, no text. Pure: the stamp comes in as `generatedAt`. */
export function summarize({ records, unparsed, botReplies, excluded, range, repo, generatedAt }) {
  const labeled = records.filter((r) => r.disposition !== 'unlabeled').length;
  const by = tally(records, ['fixed', 'wont_fix', 'wrong', 'unlabeled'], (r) => r.disposition);
  const fixedMarker = records.filter((r) => r.disposition === 'fixed' && r.evidence === 'cr_marker').length;
  const unlabeledWithMarker = records.filter((r) => r.disposition === 'unlabeled' && r.marker === true).length;
  return {
    v: 1, kind: 'cr-dispositions', repo, generatedAt, rulesVersion: RULES_VERSION, range,
    ...parsedOf({ records, unparsed, botReplies }),
    labeled: { count: labeled, share: ratio(labeled, records.length) },
    replied: repliedOf(records),
    counts: { fixed: by.fixed, fixedHuman: by.fixed - fixedMarker, fixedMarker, wont_fix: by.wont_fix, wrong: by.wrong, unlabeled: by.unlabeled, unlabeledWithMarker },
    evidence: tally(records, ['reply_wont_fix', 'reply_sha', 'reply_wrong', 'reply_decline', 'reply_no_sha', 'cr_marker'], (r) => r.evidence),
    reasons: tally(records, ['reply_unmatched', 'reply_conflict', 'thumbs_up_only', 'thumbs_down_unverified', 'thumbs_conflict', 'no_signal'], (r) => r.reason),
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
function collect({ byPr, noUrl, factOf, repo, excluded }) {
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
      const got = findingsForPr({ pr, comments, prFact: { author: fact.user?.login ?? null }, repo });
      acc.records.push(...got.records);
      acc.unparsed.push(...got.unparsed);
      acc.botReplies.all += got.botReplies.all;
      acc.botReplies.parsed += got.botReplies.parsed;
    }
  }
  return acc;
}

/** Calls the two listings and decides every comment. Returns { summary, file }; throws SweepError. */
export async function sweep({ from, to, repo = DEFAULT_REPO, generatedAt }, { gh = defaultGh } = {}) {
  const prs = await fetchPrs(gh, repo);
  const hi = to ?? topMerged(prs);
  const first = prs.filter((p) => p.number >= from).sort((a, b) => a.number - b.number)[0];
  const open = first && hi != null && first.number <= hi;
  if (open && typeof first.created_at !== 'string') throw new SweepError('bad_shape', 'a PR row has no created_at');
  const rows = open ? await fetchComments(gh, repo, first.created_at) : [];
  const { byPr, noUrl } = groupByPr(rows, from, hi ?? from - 1);
  const excluded = excludedOf(prs, from, hi);
  const { records, unparsed, botReplies } = collect({ byPr, noUrl, factOf: new Map(prs.map((p) => [p.number, p])), repo, excluded });
  records.sort((a, b) => a.pr - b.pr || a.commentId - b.commentId);
  unparsed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const summary = summarize({ records, unparsed, botReplies, excluded, range: { from, to: hi ?? null }, repo, generatedAt });
  return { summary, file: { ...summary, findings: records, unparsed: unparsed.map(({ key, reason }) => ({ key, reason })) } };
}

// ---- CLI ----------------------------------------------------------------------------------------------------------------------

const USAGE = [
  'Usage: dispositions.mjs sweep [--from N] [--to N] [--repo owner/name] [--out FILE] [--summary-out FILE] [--json]',
  '       dispositions.mjs --help | -h',
  'Exit: 0 parsed bar met, 1 gh failure (nothing written) or another error (one fixed line), 2 bad input, 3 sweep ran but the parsed bar is not met.',
].join('\n');

const WITH_VALUE = new Set(['--from', '--to', '--repo', '--out', '--summary-out']);
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

/** { opts } or { error } or { help }. Every check runs before any gh call. */
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
  return { opts: { from, to, repo, out: flags.out, summaryOut: flags['summary-out'], json: Boolean(flags.json) } };
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
const UNC = /^[\\/]{2}/;

/**
 * The absolute path with a long-path prefix stripped, or null for every UNC form (a share, a device path, the long-path UNC
 * form) and, on Windows, for an alternate data stream (a colon after the drive: a stream on a repo folder is in no tree walk).
 */
function plainPath(file) {
  const raw = String(file);
  const long = LONG_PATH.test(raw);
  const bare = long ? raw.slice(4) : raw;
  if (UNC.test(bare) || (long && /^unc[\\/]/i.test(bare))) return null;
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

/**
 * True when `file` is a UNC form, or resolves inside any repo tree (an ancestor with a .git entry, seen through the
 * plain and the real path), under the repo root of this script, or under any .claude/worktrees folder.
 */
export function outRefused(file, root = REPO_ROOT) {
  const abs = plainPath(file);
  if (abs === null) return true;
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

/** { file, summaryFile } or { error }: the write targets, checked before any gh call. The default path takes the same check. */
function targetsOf(opts, home, now) {
  const wanted = opts.out ?? defaultOut(home, now);
  if (outRefused(wanted)) return { error: '--out must be outside every repo tree and not a UNC or stream path' };
  const file = plainPath(wanted);
  const summaryFile = opts.summaryOut === undefined ? null : (plainPath(opts.summaryOut) ?? path.resolve(opts.summaryOut));
  if (summaryFile !== null && sameFile(file, summaryFile)) return { error: '--summary-out must not be the --out file' };
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

async function runSweep(opts, { file, summaryFile }, { gh, now }, out) {
  const { summary, file: full } = await sweep({ from: opts.from, to: opts.to, repo: opts.repo, generatedAt: new Date(now).toISOString() }, { gh });
  writeJson(file, full);
  if (summaryFile !== null) writeJson(summaryFile, summary);
  out(opts.json ? JSON.stringify(summary, null, 1) : lineOf(summary));
  return gateOf(summary);
}

export async function main(argv, deps = {}) {
  const out = deps.stdout ?? ((s) => console.log(s));
  const err = deps.stderr ?? ((s) => console.error(s));
  const parsed = parseArgs(argv);
  if (parsed.help) { out(USAGE); return 0; }
  const now = (deps.now ?? Date.now)();
  const targets = parsed.error ? parsed : targetsOf(parsed.opts, deps.homedir ?? os.homedir(), now);
  if (targets.error) { err(`dispositions: ${targets.error}\n${USAGE}`); return 2; }
  try {
    return await runSweep(parsed.opts, targets, { gh: deps.gh ?? defaultGh, now }, out);
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
