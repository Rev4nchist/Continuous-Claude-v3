#!/usr/bin/env node
// What happened to each CodeRabbit inline finding on merged PRs: fixed, wont_fix, wrong or unlabeled.
// A disposition comes only from a trusted human's reply, or from CodeRabbit's own "Addressed in commit" marker (no verdict).
// Thumbs never label: the REST rollup does not say who reacted. An open finding is never negative.
// Read-only: two paged `gh api` GET calls in all. `gh` is injectable: async (args: string[]) => parsed JSON (same contract as github.mjs).
// The full file holds PR numbers and comment ids, so --out is refused under the repo or a worktree. --summary-out holds counts only.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPO } from '../../github/cursor-review.mjs';
import { inlineCommentSeverity, isCodeRabbitUser } from '../../github/review-status.mjs';
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

/** Zero-width characters out, curly apostrophes folded, fenced code blocks and quoted lines dropped. */
export function cleanReply(text) {
  const folded = String(text ?? '').replace(ZERO_WIDTH, '').replace(/[\u2018\u2019]/g, "'");
  const keep = [];
  let fenced = false;
  for (const line of folded.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      if ((line.match(/```/g) ?? []).length % 2 === 1) fenced = !fenced;
      continue;
    }
    if (!fenced && !/^\s*>/.test(line)) keep.push(line);
  }
  return keep.join('\n');
}

// ---- reply rules --------------------------------------------------------------------------------------------------------------

// No pattern has a nested quantifier: each runs in linear time. A fix rule is a global regex read by fixHit (it has a guard).
const NEG_FIX = /\b(?:won't|will not|not going to)\s+(?:fix|change|address)\b|\bwontfix\b/i;
const WRONG = /\bfalse[- ]positive\b|\bnot applicable\b|\b(?:this|that|it|the (?:comment|finding|suggestion))\s+(?:(?:is|was)\s+(?:incorrect|invalid|wrong)|does(?:n't| not) apply|is not (?:a|an) (?:bug|issue|problem))\b/i;
const DECLINE = /\bout of scope\b|\bby design\b|\bintentional(?:ly)?\b|\bdefer(?:red)?\b|\bfollow[- ]up\b|\bseparate (?:pr|change)\b|\b(?:leave|leaving|keep|keeping) (?:it |this )?as[- ]is\b/i;
const FIX_SHA = new RegExp(`\\b(?:fixed|addressed|resolved|done|applied|fix in)\\b[^\\n]{0,60}?(${SHA_BODY})`, 'gi');
const FIX_WORD = /\b(?:fixed|addressed|resolved|done|applied)\b/gi;

/** Frozen before the live run. Order: negatives first, then fix rules. Extend only from made-up text, with the seat's approval. */
export const REPLY_RULES = Object.freeze([
  Object.freeze({ id: 'neg_fix', re: NEG_FIX, disposition: 'wont_fix', evidence: 'reply_wont_fix' }),
  Object.freeze({ id: 'fix_sha', re: FIX_SHA, disposition: 'fixed', evidence: 'reply_sha', fix: true }),
  Object.freeze({ id: 'wrong', re: WRONG, disposition: 'wrong', evidence: 'reply_wrong' }),
  Object.freeze({ id: 'decline', re: DECLINE, disposition: 'wont_fix', evidence: 'reply_decline' }),
  Object.freeze({ id: 'fix_word', re: FIX_WORD, disposition: 'fixed', evidence: 'reply_no_sha', fix: true }),
]);

const BLOCK_WORDS = new Set(['will', 'would', 'should', 'could', 'shall', 'cannot', 'never', 'not', 'gonna']);

/** True when a modal or a negation sits in the same clause before the fix word (a 40-character window, cut at sentence punctuation). */
function blockedBefore(line, index) {
  const clause = line.slice(Math.max(0, index - 40), index).toLowerCase().split(/[.;!,:]/).pop();
  const words = clause.split(/[^a-z']+/).filter(Boolean);
  return words.some((w, i) => BLOCK_WORDS.has(w) || w.endsWith("n't") || (w === 'to' && words[i + 1] === 'be'));
}

/** The first match of a fix rule that is not after a modal or a negation, on a line that does not end with a question mark. */
function fixHit(text, re) {
  for (const line of text.split('\n')) {
    if (line.trimEnd().endsWith('?')) continue;
    re.lastIndex = 0;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      if (!blockedBefore(line, m.index)) return m;
      re.lastIndex = m.index + 1;
    }
  }
  return null;
}

const ruleHit = (rule, text) => (rule.fix ? fixHit(text, rule.re) : rule.re.exec(text));
const CONFLICT = Object.freeze({ disposition: 'unlabeled', evidence: null, rule: 'reply_conflict', sha: null });

/** { disposition, evidence, rule, sha } or null. A fix rule and a negative rule together give unlabeled reply_conflict. */
export function parseReply(text) {
  const clean = cleanReply(text);
  if (clean.trim() === '') return null;
  const hits = REPLY_RULES.map((rule) => [rule, ruleHit(rule, clean)]).filter(([, m]) => m);
  const fix = hits.find(([rule]) => rule.fix);
  const neg = hits.find(([rule]) => !rule.fix);
  if (fix && neg) return { ...CONFLICT };
  const [rule, m] = neg ?? fix ?? [];
  if (!rule) return null;
  return { disposition: rule.disposition, evidence: rule.evidence, rule: rule.id, sha: rule.id === 'fix_sha' ? m[1].toLowerCase() : null };
}

const MARKER = /\bAddressed in commits?\s+`?([0-9a-f]{7,40})(?![0-9a-z])`?(?:\s+to\s+`?([0-9a-f]{7,40})(?![0-9a-z])`?)?/gi;

/** The SHA of the last "Addressed in commit(s) ..." marker in a CodeRabbit root body ("a to b" gives b), or null. */
export function parseMarker(body) {
  let found = null;
  for (const m of String(body ?? '').matchAll(MARKER)) {
    const candidate = m[2] ?? m[1];
    if (SHA_WHOLE.test(candidate)) found = candidate.toLowerCase();
  }
  return found;
}

/** 16 hex characters over the ordered rule set (id, regex source and flags, disposition, evidence) and the extra pattern sources. */
export function rulesVersionOf(rules, extra = []) {
  const parts = rules.map((r) => [r.id, r.re.source, r.re.flags, r.disposition, r.evidence]);
  return createHash('sha256').update(JSON.stringify([parts, extra])).digest('hex').slice(0, 16);
}

/** The version of the frozen rule set. A file with another value was labeled by other rules. */
export const RULES_VERSION = rulesVersionOf(REPLY_RULES, [MARKER.source, MARKER.flags, SHA_BODY]);

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
 * Order: the latest trusted reply that parses (a conflict reply counts), then the CodeRabbit marker, then unmatched trusted replies,
 * then a thumbs reason, then no_signal. Only a trusted human reply gives wrong or wont_fix.
 */
export function decide({ root, replies = [], trusted = new Set() }) {
  const mine = replies.filter((r) => authorKind(r?.user, trusted) === 'trusted').sort(byTime);
  const marker = parseMarker(root?.body);
  const decided = mine.map((r) => [r, parseReply(r.body)]).filter(([, p]) => p).pop();
  if (decided) {
    const [r, p] = decided;
    if (p.rule === 'reply_conflict') return result({ reason: 'reply_conflict', rule: p.rule, replyId: r.id });
    return result({ disposition: p.disposition, evidence: p.evidence, rule: p.rule, sha: p.sha ?? marker, replyId: r.id });
  }
  if (marker) return result({ disposition: 'fixed', evidence: 'cr_marker', sha: marker });
  if (mine.length > 0) return result({ reason: 'reply_unmatched' });
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
    replies: replyCounts(replies, trusted), outdated: c.line == null, parsed: true,
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

/** The evidence summary: counts only, no PR number per finding, no comment id, no text. Pure: the stamp comes in as `generatedAt`. */
export function summarize({ records, unparsed, botReplies, excluded, range, repo, generatedAt }) {
  const labeled = records.filter((r) => r.disposition !== 'unlabeled').length;
  const by = tally(records, ['fixed', 'wont_fix', 'wrong', 'unlabeled'], (r) => r.disposition);
  const fixedMarker = records.filter((r) => r.disposition === 'fixed' && r.evidence === 'cr_marker').length;
  return {
    v: 1, kind: 'cr-dispositions', repo, generatedAt, rulesVersion: RULES_VERSION, range,
    ...parsedOf({ records, unparsed, botReplies }),
    labeled: { count: labeled, share: ratio(labeled, records.length) },
    replied: repliedOf(records),
    counts: { fixed: by.fixed, fixedHuman: by.fixed - fixedMarker, fixedMarker, wont_fix: by.wont_fix, wrong: by.wrong, unlabeled: by.unlabeled },
    evidence: tally(records, ['reply_wont_fix', 'reply_sha', 'reply_wrong', 'reply_decline', 'reply_no_sha', 'cr_marker'], (r) => r.evidence),
    reasons: tally(records, ['reply_unmatched', 'reply_conflict', 'thumbs_up_only', 'thumbs_down_unverified', 'thumbs_conflict', 'no_signal'], (r) => r.reason),
    unparsedReasons: tally(unparsed, ['bad_shape', 'orphan_reply', 'pr_unknown', 'no_pr_url'], (u) => u.reason),
    excluded: { unmergedPrs: excluded?.unmergedPrs ?? 0, unmergedComments: excluded?.unmergedComments ?? 0 },
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

/** A paged listing, flattened, shape-checked (every row an object with an integer `key`), without repeated rows. */
async function pagedRows(gh, route, key) {
  let rows;
  try {
    rows = await ghList(gh, route);
  } catch (e) {
    throw new SweepError('gh_error', String(e?.message ?? e));
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

/** Calls the two listings and decides every comment. Returns { summary, file }; throws SweepError. */
export async function sweep({ from, to, repo = DEFAULT_REPO, generatedAt }, { gh = defaultGh } = {}) {
  const prs = await fetchPrs(gh, repo);
  const hi = to ?? topMerged(prs);
  const first = prs.filter((p) => p.number >= from).sort((a, b) => a.number - b.number)[0];
  const open = first && hi != null && first.number <= hi;
  if (open && typeof first.created_at !== 'string') throw new SweepError('bad_shape', 'a PR row has no created_at');
  const rows = open ? await fetchComments(gh, repo, first.created_at) : [];
  const { byPr, noUrl } = groupByPr(rows, from, hi ?? from - 1);
  const factOf = new Map(prs.map((p) => [p.number, p]));
  const records = [];
  const unparsed = [];
  const botReplies = { all: 0, parsed: 0 };
  const excluded = { unmergedPrs: prs.filter((p) => p.number >= from && (hi == null || p.number <= hi) && !p.merged_at).length, unmergedComments: 0 };
  const stray = (c, pr, reason) => {
    if (!isCodeRabbitUser(c.user)) return;
    unparsed.push(strayEntry(c, pr, reason));
    if (!isRoot(c)) botReplies.all += 1;
  };
  for (const c of noUrl) stray(c, 'none', 'no_pr_url');
  for (const [pr, comments] of [...byPr].sort((a, b) => a[0] - b[0])) {
    const fact = factOf.get(pr);
    if (!fact) comments.forEach((c) => stray(c, pr, 'pr_unknown'));
    else if (!fact.merged_at) excluded.unmergedComments += comments.filter((c) => isCodeRabbitUser(c.user)).length;
    else {
      const got = findingsForPr({ pr, comments, prFact: { author: fact.user?.login ?? null }, repo });
      records.push(...got.records);
      unparsed.push(...got.unparsed);
      botReplies.all += got.botReplies.all;
      botReplies.parsed += got.botReplies.parsed;
    }
  }
  records.sort((a, b) => a.pr - b.pr || a.commentId - b.commentId);
  unparsed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const summary = summarize({ records, unparsed, botReplies, excluded, range: { from, to: hi ?? null }, repo, generatedAt });
  return { summary, file: { ...summary, findings: records, unparsed: unparsed.map(({ key, reason }) => ({ key, reason })) } };
}

// ---- CLI ----------------------------------------------------------------------------------------------------------------------

const USAGE = [
  'Usage: dispositions.mjs sweep [--from N] [--to N] [--repo owner/name] [--out FILE] [--summary-out FILE] [--json]',
  '       dispositions.mjs --help | -h',
  'Exit: 0 parsed bar met, 1 gh failure (nothing written), 2 bad input, 3 sweep ran but the parsed bar is not met.',
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
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: '--repo must look like owner/name' };
  return { opts: { from, to, repo, out: flags.out, summaryOut: flags['summary-out'], json: Boolean(flags.json) } };
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

/** True when `file` resolves under the repo root of this script or under any .claude/worktrees folder. */
export function outRefused(file, root = REPO_ROOT) {
  const target = fold(realish(file));
  const roots = [path.resolve(root), realish(root)].map(fold);
  const segs = target.split(/[\\/]+/);
  return roots.some((r) => within(r, target)) || segs.some((s, i) => s === '.claude' && segs[i + 1] === 'worktrees');
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`);
  renameSync(tmp, file);
}

const pct = (share) => (share === null ? 'n/a' : `${(share * 100).toFixed(1)}%`);
const lineOf = (s) => `dispositions: ${s.denominator.all} bot comments, parsed ${pct(s.parsed.share)}, replied labeled ${s.replied.labeled}/${s.replied.findings}, `
  + `fixed ${s.counts.fixed} wont_fix ${s.counts.wont_fix} wrong ${s.counts.wrong} unlabeled ${s.counts.unlabeled}`;

export async function main(argv, deps = {}) {
  const out = deps.stdout ?? ((s) => console.log(s));
  const err = deps.stderr ?? ((s) => console.error(s));
  const parsed = parseArgs(argv);
  if (parsed.help) { out(USAGE); return 0; }
  if (parsed.error) { err(`dispositions: ${parsed.error}\n${USAGE}`); return 2; }
  const { opts } = parsed;
  const now = (deps.now ?? Date.now)();
  const file = path.resolve(opts.out ?? path.join(deps.homedir ?? os.homedir(), '.claude', 'state', STATE_FOLDER,`${localDate(now)}-dispositions.json`));
  if (outRefused(file)) { err(`dispositions: --out must be outside the repo and its worktrees\n${USAGE}`); return 2; }
  try {
    const { summary, file: full } = await sweep({ from: opts.from, to: opts.to, repo: opts.repo, generatedAt: new Date(now).toISOString() }, { gh: deps.gh ?? defaultGh });
    writeJson(file, full);
    if (opts.summaryOut) writeJson(path.resolve(opts.summaryOut), summary);
    out(opts.json ? JSON.stringify(summary, null, 1) : lineOf(summary));
    return gateOf(summary);
  } catch (e) {
    if (!(e instanceof SweepError)) throw e;
    err(`dispositions failed (${e.kind}): ${e.message.replace(/\s+/g, ' ').slice(0, 200)}`);
    return 1;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.stack || e.message); process.exit(1); });
}
