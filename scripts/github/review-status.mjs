#!/usr/bin/env node
/**
 * review-status.mjs — is this PR safe to call "ready to merge"? Read-only. Reviewer: Greptile.
 *
 * Answers the question the PR review loop rule (pr-review-loop.md) asks, for the PR's CURRENT
 * head commit:
 *   - reviewed:   a check run from the Greptile GitHub App on the head SHA ended "success".
 *                 The app identity is the trust anchor: only Greptile can create that run.
 *                 A superseded review ends "neutral" ("Review was cancelled"): NOT a review.
 *   - summary:    Greptile now posts its summary as an ISSUE COMMENT (<!-- greptile_summary -->)
 *                 with the last reviewed commit and a confidence score. It counts only from the
 *                 author greptile-apps[bot] (type Bot) and only when its commit is the head (full
 *                 SHA, or a prefix of 7 or more characters). Fallback: the older block in the PR
 *                 body. People with write access can edit the comment and the body, and REST still
 *                 names the app as the comment author. So each counts only when every edit after
 *                 Greptile's newest one came from an app (GitHub Bot); a comment nobody edited counts.
 *                 The comment body and its edit history are read in ONE GraphQL query (REST only
 *                 finds candidates), so an edit between two requests cannot pair a new body with a
 *                 stale history. An edited Greptile comment counts only when EVERY editor is greptile-apps (Bot).
 *                 A usable summary names the head and has a score; anything else is UNAVAILABLE.
 *   - unresolved: review threads still open from any reviewer, from GraphQL isResolved
 *   - checks:     every other status and check run on the head SHA
 *   - mergeable:  GitHub's mergeable_state
 * ready = reviewed && confidence >= 4 && unresolved == 0 && checks green && mergeable "clean".
 *
 * READY v2 (P3b): the labels pick the bots that must have reviewed the head (see requiredBots):
 * review:deep = both; review:deep-held and review:coderabbit = CodeRabbit only; risk:docs alone = none;
 * no review:* and no risk:* label = Greptile only, as before. A draft PR is never READY.
 * A Greptile check that ended "failure" DID review (score under the bar): its summary is read and a
 * low score blocks. A check that ended "neutral" was cancelled by a newer push.
 *
 * CodeRabbit PR-bot reviews (`coderabbitai[bot]` on the head, with review content) count toward READY
 * when the labels require CodeRabbit (`review:coderabbit`, `review:deep` or `review:deep-held`). "Review skipped", "Review failed" and
 * rate-limit notices, and CLI/plugin output, never count. The summary comment is read only from the
 * newest comment with the "summarize by coderabbit.ai" marker, and counts only if no person edited it.
 * A notice counts only from that comment and only for the head: when it names a commit (link or SHA,
 * 7 or more characters) that commit must be the head, and only a notice with no commit falls back to
 * "newer than the head commit". A labelled
 * PR whose CodeRabbit review is missing because of such a notice reports coderabbitLimited (the
 * pr-loop mod maps it to LIMITED). A leftover CodeRabbit commit status alone does not grant READY.
 * Any review thread, from any reviewer, still counts as unresolved.
 *
 * The carry (PR D, Dave 2026-10-29): a CodeRabbit-required PR whose head has no review is still READY when the NEWEST CodeRabbit
 * review (of an earlier head) is Minor-only, the push since is 30 lines or fewer over the PR's own files, and the PR body holds a
 * `CLI fix review: <from>..<head> clean` line from cr-fix.mjs for that range (see carryBlockers). Every other READY item
 * applies. The carry source is the newest CodeRabbit review object, or a clean round that left only the trusted summary comment
 * (newestCodeRabbitRound); a review with no "Actionable comments posted" sentence counts 0 inline comments and its body is still read.
 * Result field `coderabbitCarried`: { from, deltaLines } or null; `coderabbitCarryBlockers`: the strings that stopped the carry (not
 * reasons; the non-JSON output lists them under the reasons); `coderabbitReviewedHead` stays false. A missing input or
 * a failed read is "not eligible", never exit 2. `--fixture <file>` evaluates saved inputs with no gh call (the result says
 * `fixture: true`); it is for the end-to-end check and is never used by land-pr.ps1.
 *
 * P4b proof gate (DW-102): the PR BODY must name one proof type and show RED and GREEN evidence, and the
 * GREEN line must name the head (see PROOF_TYPES and pr-review-loop.md "Proof in the PR body"). Missing,
 * unknown or incomplete proof is a reason. Exempt: a Dependabot PR (the signed-bot rule above) and a
 * `docs` PR that the review router classed docs on this head. Runs only for the repos in PROOF_REPOS.
 * Result field `proof`: { required, type, status, problems }.
 *
 * Usage: node scripts/github/review-status.mjs <pr-number> [--repo owner/name] [--json]
 * Exit 0 = ready, 1 = not ready (reasons listed), 2 = could not determine.
 * Uses `gh api`; set GH_CONFIG_DIR for the repo's account (default: ~/.config/gh-personal when it
 * exists, else gh's own default login).
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const pr = Number(args.find((a) => /^\d+$/.test(a)));
const repo = opt('--repo', 'Rev4nchist/Continuous-Claude-v3');
const [owner, name] = repo.split('/');
// gh-personal routes the Rev4nchist account on machines with two GitHub logins
// (docs/github/auth-routing.md). Where it does not exist, gh's own default login is the account.
const ghPersonal = path.join(os.homedir(), '.config', 'gh-personal');
const ghConfigDir = process.env.GH_CONFIG_DIR || (existsSync(ghPersonal) ? ghPersonal : undefined);
const env = { ...process.env, ...(ghConfigDir ? { GH_CONFIG_DIR: ghConfigDir } : {}) };

function gh(apiArgs) {
  return JSON.parse(execFileSync('gh', ['api', ...apiArgs], { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 }));
}

/** The Greptile GitHub App, by slug. A check run's app cannot be forged by a user account. */
export const GREPTILE_APP = 'greptile-apps';
export const MIN_CONFIDENCE = 4;
const isGreptileRun = (c) => c?.app?.slug === GREPTILE_APP;
const isCodeRabbitStatus = (s) => /coderabbit/i.test(s?.context || '');

/** The CodeRabbit GitHub App login. CLI output cannot forge this identity. */
export const CODERABBIT_LOGIN = 'coderabbitai[bot]';
export function pullLabelNames(pull) {
  return (pull?.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}

/** Shown in `routing.held` while a PR carries review:deep-held. Not a blocking reason. */
export const DEEP_HELD_NOTE = 'deep review held (Apex billing, D3)';

/**
 * READY v2: which bots must have reviewed the head, from the PR labels. First match wins:
 *   review:deep          Greptile AND CodeRabbit (a person upgrading a held PR wins over review:deep-held)
 *   review:deep-held     CodeRabbit only; `held` carries the note
 *   review:coderabbit    CodeRabbit only
 *   review:none          no bot (the PR checkpoint chose it; verifiedBots also needs the router state of the head)
 *   risk:docs, alone    no bot review (any other risk:* label next to it keeps Greptile)
 *   anything else        Greptile only: the rule every PR had before the router labels existed
 * `source` is 'default' only when the PR has no review:* and no risk:* label at all. A risk:* label
 * with no review:* label (for example risk:normal) is not specified by the router; Greptile stays
 * required there, so a half-labelled PR can never become READY with less review than before.
 */
export function requiredBots(labels, greptileAuto = true) {
  const need = labelBots(labels);
  // Greptile off (main's .greptile/config.json has autoReview []): Greptile never reviews by itself, so a
  // path that would wait for it needs CodeRabbit instead (Dave, 2026-10-26).
  if (greptileAuto || !need.greptile) return need;
  return { ...need, greptile: false, coderabbit: true };
}

/**
 * Greptile reviews by itself unless autoReview is an empty list. A missing file or key means the
 * dashboard default (it reviews); anything that is not an array keeps the stricter rule.
 */
export function greptileAutoFrom(config) {
  const v = config?.autoReview;
  return !(Array.isArray(v) && v.length === 0);
}

function labelBots(labels) {
  const names = labels || [];
  const has = (n) => names.includes(n);
  const risks = names.filter((n) => n.startsWith('risk:'));
  const routed = names.some((n) => n.startsWith('review:') || n.startsWith('risk:'));
  const pick = (greptile, coderabbit, held = null) => ({ greptile, coderabbit, held, source: 'labels' });
  if (has('review:deep')) return pick(true, true);
  if (has('review:deep-held')) return pick(false, true, DEEP_HELD_NOTE);
  if (has('review:coderabbit')) return pick(false, true);
  if (has('review:none')) return pick(false, false);
  if (risks.length > 0 && risks.every((n) => n === 'risk:docs')) return pick(false, false);
  return { ...pick(true, false), source: routed ? 'labels' : 'default' };
}

export function needsCodeRabbitReview(labels) {
  return requiredBots(labels).coderabbit;
}

const ROUTER_COMMENT_MARKER = '<!-- review-router -->';
// `\x3C` is `<`: a regex literal that starts with `<!--` stops Semgrep's JS parser (HTML-like comment).
// Attributes after the head: `pathway=` and `pclass=` are read below (PR checkpoint); others (`held=apex_d3`) are ignored here.
const ROUTER_STATE_RE = /\x3C!--\s*review-router-state class=(\w+) head=([0-9a-f]{40})((?:\s+\w+=\w+)*)\s*-->/;
export const ROUTER_UNVERIFIED_NOTE = 'the review router has not classified this head; Greptile stays required';
export const ROUTER_NONE_UNVERIFIED_NOTE = 'the router has not classified this head; re-run the router workflow';
export const CLASS_RAISED_NOTE = 'class raised after the checkpoint (review:none was chosen at a lower class). Return the PR to draft (gh pr ready --undo), then run /pathway again';
const PATHWAYS = new Set(['none', 'coderabbit', 'both']);

/**
 * The review router's saved state: only a github-actions[bot] comment that starts with the
 * marker counts (lowest id), so a pasted or forged marker is ignored. null when there is none.
 * pathway and pclass (the PR checkpoint's choice and class) are null when absent or not on the list.
 */
export function routerState(comments) {
  const own = (comments || [])
    .filter((c) => c?.user?.login === 'github-actions[bot]' && c?.user?.type === 'Bot' && String(c?.body ?? '').startsWith(ROUTER_COMMENT_MARKER))
    .sort((a, b) => a.id - b.id)[0];
  const m = own ? String(own.body).match(ROUTER_STATE_RE) : null;
  if (!m) return null;
  const attrs = Object.fromEntries([...m[3].matchAll(/(\w+)=(\w+)/g)].map((a) => [a[1], a[2]]));
  return {
    class: m[1], head: m[2],
    pathway: PATHWAYS.has(attrs.pathway) ? attrs.pathway : null,
    pclass: Object.hasOwn(RISK_RANK, attrs.pclass) ? attrs.pclass : null,
  };
}

/**
 * Labels may only RELAX review (drop Greptile) when the router classified the current head. A
 * stale label (a raise that failed after a push) or a label with no router state keeps Greptile.
 */
// Same order as review-router.mjs RANK. A risk:* label above the router's saved class was added by a
// person after the router ran; the router has not routed it yet.
const RISK_RANK = { docs: 0, normal: 1, high: 2, steering: 3, infra: 4, r3: 5 };
export const ROUTER_BEHIND_LABEL_NOTE = 'a risk label is higher than the class the review router saved; Greptile stays required until the router routes it';

const rankOf = (cls) => RISK_RANK[cls] ?? -1;
export const NONE_BEHIND_LABEL_NOTE = 'a risk label is higher than the class the review router saved; the router has not routed it yet';

/**
 * review:none wants no bot. READY still needs the router state of THIS head (a missing state means a stale or
 * absent classification), no risk label above the saved class, and, for pathway none, a class that has not risen
 * above the class at the checkpoint. Each problem is a reason; none of them asks a bot for a review.
 */
export const NONE_NO_CHECKPOINT_NOTE = 'review:none has no saved checkpoint (pathway=none) on this head; run /pathway or re-run the router workflow';

function noneBlockers(labels, state, head) {
  if (!state || state.head !== head) return [ROUTER_NONE_UNVERIFIED_NOTE];
  // Fail closed: review:none skips every bot only when the router saved the checkpoint itself.
  if (state.pathway !== 'none' || !state.pclass) return [NONE_NO_CHECKPOINT_NOTE];
  const top = Math.max(-1, ...(labels || []).filter((n) => n.startsWith('risk:')).map((n) => rankOf(n.slice(5))));
  return [
    ...(top > rankOf(state.class) ? [NONE_BEHIND_LABEL_NOTE] : []),
    ...(rankOf(state.class) > rankOf(state.pclass) ? [CLASS_RAISED_NOTE] : []),
  ];
}

export function verifiedBots(labels, comments, head, greptileAuto = true) {
  const state = routerState(comments);
  // G1: the router saved pathway=both (a person chose Greptile too): Greptile stays required, and the CodeRabbit need of auto off stays. Any head: never relaxes.
  const base = requiredBots(labels, greptileAuto);
  const need = state?.pathway === 'both' ? { ...base, greptile: true } : base;
  if (need.greptile) return need;
  if ((labels || []).includes('review:none') && !need.coderabbit) return { ...need, blockers: noneBlockers(labels, state, head) };
  // Greptile on: the fallback is Greptile. Greptile off: CodeRabbit, with the note naming it.
  const keep = (note) => (greptileAuto
    ? { ...need, greptile: true, unverified: note }
    : { ...need, coderabbit: true, unverified: note.replace('Greptile stays required', 'CodeRabbit is required') });
  if (!state || state.head !== head) return keep(ROUTER_UNVERIFIED_NOTE);
  const top = Math.max(-1, ...(labels || []).filter((n) => n.startsWith('risk:')).map((n) => RISK_RANK[n.slice(5)] ?? -1));
  if (top > (RISK_RANK[state.class] ?? -1)) return keep(ROUTER_BEHIND_LABEL_NOTE);
  return need;
}

const isCodeRabbitUser = (u) => u?.login === CODERABBIT_LOGIN && u?.type === 'Bot';

const LIMIT_WARNING = /Review limit reached/i;
/** Notice headings seen on live PRs, e.g. "> ## Review skipped" (#155). A notice is never a review. */
const NOTICE_HEADING = /^[>\s]*#{1,6}\s*(Review skipped|Review failed|Rate limit(?:ed| exceeded)?|Review limit reached)\b/im;
const NOTICE_PLAIN = /^[>\s]*(Review failed)\s*[-\u2013:]/im;

/** 'skipped', 'failed' or 'rate limited' when the CodeRabbit comment is a notice, else null. */
export function codeRabbitNotice(body) {
  const text = String(body ?? '');
  const m = NOTICE_HEADING.exec(text) || NOTICE_PLAIN.exec(text);
  if (m) {
    const w = m[1].toLowerCase();
    return w.includes('skipped') ? 'skipped' : w.includes('failed') ? 'failed' : 'rate limited';
  }
  return LIMIT_WARNING.test(text) ? 'rate limited' : null;
}

/**
 * Minutes until CodeRabbit's next included review, read from a limit notice ("Next included review available
 * in 12 minutes", "Please wait 12 minutes"). Hours and seconds are folded in; any seconds round up one minute.
 * Null when the text has no figure. Best effort: the wording is CodeRabbit's, so a new wording gives null,
 * never a wrong number.
 */
export function codeRabbitRetryMinutes(body) {
  const phrase = /(?:available\s+in|please\s+wait(?:\s+for)?|try\s+again\s+in|retry\s+in)\s+([^.\n<]{1,60})/i.exec(String(body ?? ''));
  if (!phrase) return null;
  const part = (unit) => Number(new RegExp(`(\\d+)\\s*${unit}`, 'i').exec(phrase[1])?.[1] ?? 0);
  const total = part('hours?') * 60 + part('minutes?') + (part('seconds?') > 0 ? 1 : 0);
  return total > 0 ? total : null;
}

/**
 * The minutes still left of a figure written at `writtenMs`. Null once the wait has passed, so no alert states a
 * wait that is over. A source with no date (writtenMs 0) keeps its figure as written. Null stays null.
 */
export function minutesLeft(minutes, writtenMs, nowMs) {
  if (minutes === null || !writtenMs) return minutes;
  const left = minutes - Math.floor((nowMs - writtenMs) / 60_000);
  return left > 0 ? left : null;
}

/** Summary comment on the PR naming the reviewed head (from legacy coderabbit-status.mjs). */
export function summaryCoversHead(body, head) {
  const text = String(body ?? '');
  if (codeRabbitNotice(text)) return false;
  for (const m of text.matchAll(/between\s+[0-9a-f]{40}\s+and\s+([0-9a-f]{40})/g)) if (m[1] === head) return true;
  for (const m of text.matchAll(/final_review_risk_coverage:(\{[^}]*\})/g)) {
    try {
      const c = JSON.parse(m[1]);
      if (c.coveredCommitId === head && c.kind === 'reviewed') return true;
    } catch { /* not a marker */ }
  }
  return false;
}

/** GraphQL login of the CodeRabbit app as a comment editor (no "[bot]" suffix there). */
const CODERABBIT_EDITOR = 'coderabbitai';
const CODERABBIT_SUMMARY_MARKER = /<!--\s*This is an auto-generated comment: summarize by coderabbit\.ai\s*-->/;

/** The newest summary comment from the CodeRabbit app. Chat replies do not carry the marker. */
export function latestCodeRabbitSummary(comments) {
  return (comments || [])
    .filter((c) => isCodeRabbitUser(c?.user) && CODERABBIT_SUMMARY_MARKER.test(String(c.body ?? '')))
    .reduce((best, c) => (best === null || commentStamp(c) >= commentStamp(best) ? c : best), null);
}

/**
 * The newest CodeRabbit summary comment, only when it is trusted: no edit history is untrusted, and once the comment has edits
 * every editor must be the CodeRabbit app (a person or another app makes it untrusted). null when none or untrusted.
 */
function trustedCodeRabbitSummary(comments, commentEdits) {
  const summary = latestCodeRabbitSummary(comments);
  const trusted = summary !== null
    && commentEditedAfterApp(commentEdits, summary.id, CODERABBIT_EDITOR) === null
    && appCommentForeignEditor(summary, commentEdits?.[summary.id], CODERABBIT_EDITOR) === null;
  return trusted ? summary : null;
}

/**
 * Commits a CodeRabbit comment names: `/commit/<sha>` links (the "Commit" line of a notice), the
 * `/blob/<sha>/` link of the run configuration, and a "between <sha> and <sha>" range. 7 to 40 hex.
 */
export function commitsNamed(body) {
  const text = String(body ?? '');
  const found = [];
  for (const m of text.matchAll(/\/commit\/([0-9a-f]{7,40})\b/gi)) found.push(m[1]);
  for (const m of text.matchAll(/\/blob\/([0-9a-f]{40})\//gi)) found.push(m[1]);
  for (const m of text.matchAll(/between\s+([0-9a-f]{40})\s+and\s+([0-9a-f]{40})/gi)) found.push(m[1], m[2]);
  return found.map((sha) => sha.toLowerCase());
}

/**
 * A notice speaks for the head when it names the head commit (a prefix of 7 or more characters).
 * A notice that names only other commits is for an older head, whatever its date. Only a notice
 * that names no commit falls back to the date: CodeRabbit wrote it after the head commit existed.
 */
const noticeIsAfterHead = (comment, headCommittedAt, head) => {
  const named = commitsNamed(comment?.body);
  if (named.length > 0) return named.some((sha) => shaIsHead(sha, head));
  const committed = Date.parse(headCommittedAt || '');
  return Number.isFinite(committed) && commentStamp(comment) > committed;
};

/**
 * PR-bot review on the head only; rate-limit text on the status never counts as reviewed.
 * `commentEdits` (comment id -> GraphQL edits) and `headCommittedAt` (ISO date) tie the summary comment to the head.
 */
export function codeRabbitHeadReview({ head, reviews = [], comments = [], statuses = [], commentEdits, headCommittedAt, nowMs = Date.now() }) {
  const cr = (statuses || []).find((s) => /coderabbit/i.test(s?.context || ''));
  const summary = latestCodeRabbitSummary(comments);
  // Same rule as the Greptile comment (see trustedCodeRabbitSummary).
  const summaryTrusted = trustedCodeRabbitSummary(comments, commentEdits) !== null;
  const reviewedHead =
    reviews.some(
      (r) => isCodeRabbitUser(r.user) && r.commit_id === head && !codeRabbitNotice(r.body) && hasReviewContent(r.body),
    ) || (summaryTrusted && summaryCoversHead(summary.body, head));
  const statusLimited = !reviewedHead && /rate limit|limit reached/i.test(cr?.description || '');
  // The summary comment from the CodeRabbit app holds the notice ("Review skipped", "Review failed",
  // "Rate limit exceeded") that explains why no review exists. Chat replies and old notices do not count.
  const notice = reviewedHead ? null
    : statusLimited ? 'rate limited'
    : summary !== null && noticeIsAfterHead(summary, headCommittedAt, head) ? codeRabbitNotice(summary.body)
    : null;
  // The status line first; when it names no figure, a summary notice that applies to this head may (G-R10).
  const summaryForHead = summary !== null && noticeIsAfterHead(summary, headCommittedAt, head) ? summary.body : null;
  // Each figure counts down from the time its source was written (G-R11).
  const fromStatus = statusLimited ? minutesLeft(codeRabbitRetryMinutes(cr.description), commentStamp(cr), nowMs) : null;
  const fromSummary = (body) => (body == null ? null : minutesLeft(codeRabbitRetryMinutes(body), commentStamp(summary), nowMs));
  const retryMinutes = notice !== 'rate limited' ? null
    : statusLimited ? fromStatus ?? fromSummary(summaryForHead)
    : fromSummary(summary?.body);
  return {
    reviewedHead, rateLimited: notice === 'rate limited', limited: notice !== null, notice, retryMinutes,
    status: cr?.state ?? 'absent', description: cr?.description ?? null,
  };
}

/**
 * The Greptile block in the PR body (live PR #111, 2026-10-09):
 *   <!-- greptile_comment --> ... Confidence Score: 5/5 ... <!-- greptile_confidence_score:5 -->
 *   ... Last reviewed commit: ["..."](https://github.com/<o>/<r>/commit/<40-hex>) ... <!-- /greptile_comment -->
 * Returns { present, sha, confidence }. Unknown shapes give nulls, never a guess.
 */
export function parseSummary(body) {
  const block = /<!--\s*greptile_comment\s*-->([\s\S]*?)<!--\s*\/greptile_comment\s*-->/.exec(String(body ?? ''));
  if (!block) return { present: false, sha: null, confidence: null };
  const sha = /Last reviewed commit:[\s\S]*?\/commit\/([0-9a-f]{40})\b/i.exec(block[1]);
  const score = /<!--\s*greptile_confidence_score:(\d+)\s*-->/.exec(block[1]);
  return { present: true, sha: sha ? sha[1].toLowerCase() : null, confidence: score ? Number(score[1]) : null };
}

/** The Greptile App as a REST comment author: the login carries "[bot]" (the GraphQL editor login does not). */
export const GREPTILE_COMMENT_LOGIN = 'greptile-apps[bot]';
const GREPTILE_SUMMARY_MARKER = /<!--\s*greptile_summary\s*-->/;
const isGreptileCommentUser = (u) => u?.login === GREPTILE_COMMENT_LOGIN && u?.type === 'Bot';

const lastMatch = (text, re) => { let last = null; for (const m of text.matchAll(re)) last = m; return last; };

/**
 * The Greptile summary issue comment (live PRs #152, #154, 2026-10-25): it opens with
 *   <!-- greptile_summary --> ... Confidence Score: 5/5 ... <!-- greptile_confidence_score:5 -->
 *   <sub>... Last reviewed commit: ["..."](https://github.com/<o>/<r>/commit/<sha>) ...</sub>
 * and has no closing marker. The sha is 7 to 40 hex characters. Unknown shapes give nulls.
 */
export function parseCommentSummary(text) {
  const t = String(text ?? '');
  if (!GREPTILE_SUMMARY_MARKER.test(t)) return { present: false, sha: null, confidence: null };
  const sha = lastMatch(t, /Last reviewed commit:[\s\S]*?\/commit\/([0-9a-f]{7,40})\b/gi);
  const score = lastMatch(t, /<!--\s*greptile_confidence_score:(\d+)\s*-->/g);
  return { present: true, sha: sha ? sha[1].toLowerCase() : null, confidence: score ? Number(score[1]) : null };
}

const commentStamp = (c) => Date.parse(c?.updated_at || c?.created_at || '') || 0;

/** The newest summary comment from the Greptile app. Anyone else's copy of the marker is ignored. */
export function latestGreptileComment(comments) {
  return (comments || [])
    .filter((c) => isGreptileCommentUser(c?.user) && GREPTILE_SUMMARY_MARKER.test(String(c.body ?? '')))
    .reduce((best, c) => (best === null || commentStamp(c) >= commentStamp(best) ? c : best), null);
}

/** A full SHA must equal the head; a prefix of 7 or more characters must start it. */
export const shaIsHead = (sha, head) => Boolean(sha) && sha.length >= 7 && String(head).toLowerCase().startsWith(sha);

/**
 * Where the confidence comes from, and what is wrong when it cannot be used. The comment wins when
 * it names the head and nobody but an app edited it: REST names the app as author even after a
 * person with write access rewrote the text. The body block is the fallback and has the same check.
 */
function resolveSummary({ pull, comments, commentEdits, bodyEdits, head }) {
  const comment = latestGreptileComment(comments);
  const cs = comment ? parseCommentSummary(comment.body) : null;
  const commentEditor = comment
    ? commentEditedAfterApp(commentEdits, comment.id, GREPTILE_EDITOR) ?? greptileCommentForeignEditor(comment, commentEdits?.[comment.id])
    : null;
  if (cs && !commentEditor && shaIsHead(cs.sha, head) && cs.confidence !== null) return { source: 'comment', confidence: cs.confidence, problem: null };
  const body = parseSummary(pull.body);
  if (body.present) {
    const editor = bodyEditedAfterGreptile(bodyEdits);
    let problem = null;
    if (editor) problem = `PR body was edited by ${editor} after Greptile's summary, so its score cannot be confirmed`;
    else if (body.sha !== head) problem = `Greptile summary names ${body.sha ? `commit ${body.sha.slice(0, 7)}` : 'no commit'}, not the head`;
    else if (body.confidence === null) problem = 'Greptile summary has no confidence score';
    return { source: 'body', confidence: body.confidence, problem };
  }
  let problem = 'Greptile summary block is missing from the PR body (was the PR body overwritten?)';
  if (cs) {
    if (commentEditor) problem = `Greptile summary comment was edited by ${commentEditor} after Greptile, so its score cannot be confirmed`;
    else if (!cs.sha) problem = 'Greptile summary comment names no commit';
    else if (!shaIsHead(cs.sha, head)) problem = `Greptile summary comment names commit ${cs.sha.slice(0, 7)}, not the head`;
    else problem = 'Greptile summary comment has no confidence score';
  }
  return { source: null, confidence: null, problem };
}

/** The newest Greptile run on the head: a re-review adds a run, so the latest one decides. */
function latestGreptileRun(checkRuns) {
  const runs = (checkRuns || []).filter(isGreptileRun);
  return runs.reduce((best, c) => (best === null || (c.id ?? 0) > (best.id ?? 0) ? c : best), null);
}

export const UNAVAILABLE_TAIL = "Post one @greptileai comment to re-run it, or land-pr -IgnoreReview on Dave's yes";

/** GraphQL login of the Greptile app as a body editor (no "[bot]" suffix there). */
const GREPTILE_EDITOR = 'greptile-apps';

/**
 * Who last touched the PR body after Greptile. `edits` is GraphQL userContentEdits, newest first.
 * Returns null when Greptile's newest edit is followed only by app edits, else the login (or a
 * description) of the first non-app editor. Missing history is untrusted.
 */
export function bodyEditedAfterGreptile(edits) {
  if (!Array.isArray(edits)) return 'unknown (no edit history)';
  const at = edits.findIndex((e) => e?.editor?.login === GREPTILE_EDITOR);
  if (at < 0) return 'unknown (no Greptile edit in the history read)';
  const later = edits.slice(0, at).find((e) => e?.editor?.__typename !== 'Bot');
  return later ? (later.editor?.login ?? 'a deleted account') : null;
}

/**
 * Who edited a COMMENT after the app that wrote it. `editsById` maps a comment id (REST id =
 * GraphQL databaseId) to its userContentEdits, newest first. Returns null when the comment is
 * trusted, else the login (or a description) of the problem. A comment never edited has an empty
 * list: its REST author, already checked as the app, wrote all of it. A comment with no entry
 * (missing from the page read) is untrusted.
 */
export function commentEditedAfterApp(editsById, id, appLogin) {
  const edits = editsById?.[id];
  if (!Array.isArray(edits)) return 'unknown (no edit history)';
  const at = edits.findIndex((e) => e?.editor?.login === appLogin);
  const later = (at < 0 ? edits : edits.slice(0, at)).find((e) => e?.editor?.__typename !== 'Bot');
  return later ? (later.editor?.login ?? 'a deleted account') : null;
}

/**
 * Stricter rule for an app's comment. Once the comment was edited, every editor in the history must
 * be that app (GraphQL login `appLogin`, type Bot). Returns the first other editor's login (or a
 * description), else null. A comment with no edits has an empty history and passes.
 */
export function appCommentForeignEditor(comment, edits, appLogin) {
  const edited = Boolean(comment?.lastEditedAt) || (Array.isArray(edits) && edits.length > 0);
  if (!edited || !Array.isArray(edits)) return null;
  const other = edits.find((e) => !(e?.editor?.login === appLogin && e?.editor?.__typename === 'Bot'));
  return other ? (other.editor?.login ?? 'a deleted account') : null;
}

export const greptileCommentForeignEditor = (comment, edits) => appCommentForeignEditor(comment, edits, GREPTILE_EDITOR);

/**
 * Pair each REST comment with the GraphQL node of the same id. The body, the update stamp and the
 * edit history all come from that one node, which GitHub returned in one response, so an edit
 * between two requests cannot pair a new body with an old history. REST only finds the candidates.
 * A comment with no node, or whose GraphQL author differs from its REST author, keeps its REST
 * fields but gets no edit history, so it is untrusted.
 */
export function mergeGraphqlComments(restComments, nodes) {
  const byId = new Map((nodes || []).map((n) => [n?.databaseId, n]));
  const comments = [];
  const commentEdits = {};
  for (const c of restComments || []) {
    const n = byId.get(c?.id);
    const restLogin = String(c?.user?.login ?? '').replace(/\[bot\]$/, '');
    if (!n || typeof n.body !== 'string' || n.author?.login !== restLogin || n.author?.__typename !== c?.user?.type) {
      comments.push(c);
      continue;
    }
    comments.push({ ...c, body: n.body, updated_at: n.updatedAt ?? c.updated_at, lastEditedAt: n.lastEditedAt ?? null });
    commentEdits[c.id] = n.userContentEdits?.nodes ?? [];
  }
  return { comments, commentEdits };
}

// One page of issue comments, with the body, author and 20 edits of each in the same response, so a parsed body and its edit
// history cannot come from different moments. `$c` is the end cursor of the page before (null for the first page).
const COMMENTS_QUERY = 'query($o:String!,$r:String!,$n:Int!,$c:String){repository(owner:$o,name:$r){pullRequest(number:$n){comments(first:100,after:$c){pageInfo{hasNextPage endCursor} nodes{databaseId body author{__typename login} lastEditedAt updatedAt userContentEdits(first:20){nodes{editor{__typename login} editedAt}}}}}}}';

/**
 * Every issue comment of the PR with its edit history: all REST pages, paired (mergeGraphqlComments) with all GraphQL pages.
 * review-status.mjs and cr-fix.mjs both read through this, so they see the same comment set. `gh(args)` returns parsed JSON.
 * Throws when any read fails, a cursor is missing or a cursor repeats: a partial set must never stand for the whole.
 */
export function readIssueComments(gh, owner, name, pr) {
  const nodes = [];
  const seen = new Set();
  let cursor = null;
  do {
    const args = ['graphql', '-f', `query=${COMMENTS_QUERY}`, '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${pr}`];
    if (cursor !== null) args.push('-f', `c=${cursor}`);
    const page = gh(args).data.repository.pullRequest.comments;
    nodes.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo.hasNextPage && (typeof cursor !== 'string' || cursor === '' || seen.has(cursor))) throw new Error('the comment pages have no usable cursor');
    seen.add(cursor);
  } while (cursor !== null);
  const rest = [gh(['--paginate', '--slurp', `repos/${owner}/${name}/issues/${pr}/comments?per_page=100`])].flat(2);
  return mergeGraphqlComments(rest, nodes);
}

export const CANCELLED_REASON = 'Greptile review of the head was cancelled (superseded by a push); wait for the review of the new head';

/**
 * The Greptile check run as a state: absent, pending, reviewed, cancelled or unavailable.
 * "failure" counts as reviewed: Greptile ends its check failure when it DID review but scored below the
 * repo bar (4/5). The summary then decides (see evaluate). "neutral" is a review a newer push superseded.
 */
function greptileState(run) {
  if (!run) return 'absent';
  if (run.status !== 'completed') return 'pending';
  if (run.conclusion === 'success' || run.conclusion === 'failure') return 'reviewed';
  if (run.conclusion === 'neutral') return 'cancelled';
  return 'unavailable';
}

/**
 * Why Greptile blocks. A MISSING or unusable review (absent, pending, cancelled, unavailable, summary problem)
 * blocks only when `required` (the labels need Greptile). A review of the head that scored under the bar, or a
 * check that ended failure although the summary names the head, blocks whatever the labels say.
 */
/**
 * A Greptile check on the head ended failure (Greptile reviewed and scored under the bar) and no later
 * Greptile run on the head succeeded. A re-run that is still pending does not clear it.
 */
export function greptileFailedOnHead(checkRuns) {
  let failed = false;
  for (const r of (checkRuns || []).filter(isGreptileRun).sort((a, b) => a.id - b.id)) {
    if (r.status !== 'completed') continue;
    if (r.conclusion === 'failure') failed = true;
    else if (r.conclusion === 'success') failed = false;
  }
  return failed;
}

export const FAILED_UNREQUIRED_REASON = `Greptile check ended failure on the head (a review under ${MIN_CONFIDENCE}/5); a failed review blocks even when the labels do not require Greptile`;

function greptileReasons({ required, greptile, run, greptileSummary, unavailable, summaryProblem, lowConfidence, reviewedHead, confidence, failedOnHead }) {
  const out = [];
  // A failed review blocks whatever the labels say, even when its summary is unusable or a re-run is pending.
  if (!required && failedOnHead && !lowConfidence && !(reviewedHead && run?.conclusion === 'failure')) out.push(FAILED_UNREQUIRED_REASON);
  if (required) {
    if (greptile === 'absent') out.push('no Greptile check on the head commit yet (review pending; if none appears, see pr-review-loop.md "No review on the head")');
    if (greptile === 'pending') out.push(`Greptile review of the head is ${run.status}`);
    if (greptile === 'cancelled') out.push(CANCELLED_REASON);
    else if (unavailable) out.push(`Greptile did not finish a review of the head (${run.status}/${run.conclusion}${greptileSummary ? `: "${String(greptileSummary).split('\n')[0]}"` : ''}). ${UNAVAILABLE_TAIL}`);
    if (summaryProblem) out.push(`${summaryProblem}. ${UNAVAILABLE_TAIL}`);
  }
  if (lowConfidence) out.push(`Greptile confidence ${confidence}/5 is below ${MIN_CONFIDENCE}`);
  else if (reviewedHead && run.conclusion === 'failure') out.push(`Greptile check ended failure on the head although its summary scores ${confidence}/5. ${UNAVAILABLE_TAIL}`);
  return out;
}

/**
 * CodeRabbit refuses bot-authored PRs (no seat for the bot), so a Dependabot PR needs no bot review
 * (Dave, 2026-10-26). Only when the PR author is the dependabot[bot] Bot account AND every commit is
 * authored by it AND carries a valid signature made by GitHub. The author alone can be spoofed (a local
 * commit with Dependabot's email links to the account); a GitHub signature cannot be made locally.
 * A person's commit, an unsigned commit, or an empty or unknown commit list ends the exemption.
 * commits: [{ author: login|null, githubSigned: boolean }]. CI, threads and mergeable still gate.
 */
const DEPENDABOT_LOGIN = 'dependabot[bot]';
export function isDependabotPr(pull, commits) {
  return pull?.user?.login === DEPENDABOT_LOGIN && pull?.user?.type === 'Bot' &&
    Array.isArray(commits) && commits.length > 0 &&
    commits.every((c) => c?.author === DEPENDABOT_LOGIN && c?.githubSigned === true);
}
const DEPENDABOT_NEED = { greptile: false, coderabbit: false, held: null, source: 'dependabot' };

/**
 * P4b proof gate (DW-102). A PR body names one proof type and shows its evidence (pr-review-loop.md
 * "Proof in the PR body"). Each type lists the fields it needs: RED (the check fails), GREEN (it passes on
 * the head) or, for a refactor, BEFORE (the suite passes before the change) and GREEN. `docs` needs none.
 * Only the PR body counts, never a comment. This checks the shape and the head, not whether RED failed.
 */
export const PROOF_TYPES = Object.freeze({
  bugfix: ['RED', 'GREEN'], feature: ['RED', 'GREEN'], refactor: ['BEFORE', 'GREEN'], ui: ['RED', 'GREEN'], harness: ['RED', 'GREEN'], docs: [],
});
export const PROOF_REASON_PREFIX = 'PR body proof:';
/** The gate runs only for these repos (lower case). Other repos use this script without it. */
export const PROOF_REPOS = new Set(['rev4nchist/continuous-claude-v3']);
const PROOF_TYPE_LIST = Object.keys(PROOF_TYPES).join(', ');

// `\x3C` is `<`: a regex literal that starts with `<!--` stops Semgrep's JS parser (see ROUTER_STATE_RE).
const COMMENT_OPEN = '\x3C!--';
// Bot blocks the apps write into the PR body. Their text is not the author's proof.
const BOT_BLOCKS = [
  { start: /\x3C!--\s*greptile_comment\s*-->/, end: /\x3C!--\s*\/greptile_comment\s*-->/ },
  { start: /\x3C!--\s*This is an auto-generated comment:/, end: /\x3C!--\s*end of auto-generated comment:/ },
];
const KEY_HEAD = '^\\s*(?:[-*+]\\s+)?(?:\\*\\*|__)?';
const KEY_TAIL = '(?:\\*\\*|__)?\\s*:\\s*(?:\\*\\*|__)?\\s*(.*)$';
const TYPE_LINE = new RegExp(`${KEY_HEAD}proof\\s+type${KEY_TAIL}`, 'i');
// Field keys are case-sensitive: the Pocock template's "**Before:**" line must not count as BEFORE.
const FIELD_LINE = new RegExp(`${KEY_HEAD}(RED|GREEN|BEFORE)${KEY_TAIL}`);
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

/** Remove HTML comments from one line. `state.inComment` carries an open comment to the next line. */
function stripComments(line, state) {
  let out = '';
  let rest = line;
  for (;;) {
    if (state.inComment) {
      const end = rest.indexOf('-->');
      if (end < 0) return out;
      rest = rest.slice(end + 3);
      state.inComment = false;
    }
    const open = rest.indexOf(COMMENT_OPEN);
    if (open < 0) return out + rest;
    out += rest.slice(0, open);
    rest = rest.slice(open + COMMENT_OPEN.length);
    state.inComment = true;
  }
}

const trimValue = (v) => v.trim().replace(/(?:\*\*|__)\s*$/, '').trim();

/** One RED, GREEN or BEFORE line: its backticked command, the commit after @ (lower case), and later its output. */
function parseField(value) {
  const v = trimValue(value);
  const cmd = /^`([^`]+)`/.exec(v);
  const rest = cmd ? v.slice(cmd[0].length) : v;
  const sha = /(?:^|\s)(?:@|at\s)\s*`?([0-9a-fA-F]{7,40})`?(?=[\s.,;)]|$)/.exec(rest);
  return { command: cmd ? cmd[1].trim() : null, sha: sha ? sha[1].toLowerCase() : null, output: null };
}

/**
 * Pure, never throws. Reads the proof block from a PR body: { types: string[], fields: { RED, GREEN, BEFORE } }.
 * One pass over the lines. Inside a code fence nothing is a field (the fence after a field line is its
 * output). Outside a fence, HTML comments and the Greptile and CodeRabbit blocks are removed first.
 */
export function parseProof(body) {
  const types = [];
  const fields = { RED: [], GREEN: [], BEFORE: [] };
  const state = { inComment: false };
  let fence = null;
  let skipUntil = null;
  let pending = null;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      else if (fence.entry) fence.entry.output += `${line}\n`;
      continue;
    }
    if (skipUntil) {
      if (skipUntil.test(line)) skipUntil = null;
      continue;
    }
    if (!state.inComment) {
      const bot = BOT_BLOCKS.find((b) => b.start.test(line));
      if (bot) {
        const m = bot.start.exec(line);
        if (!bot.end.test(line.slice(m.index + m[0].length))) skipUntil = bot.end;
        continue;
      }
    }
    const clean = stripComments(line, state);
    const open = FENCE_OPEN.exec(clean);
    if (open) {
      fence = { ch: open[1][0], len: open[1].length, entry: pending };
      if (pending) pending.output = '';
      pending = null;
      continue;
    }
    if (clean.trim() === '') continue;
    pending = null;
    const t = TYPE_LINE.exec(clean);
    if (t) { types.push(trimValue(t[1])); continue; }
    const f = FIELD_LINE.exec(clean);
    if (f) { pending = parseField(f[2]); fields[f[1]].push(pending); }
  }
  return { types, fields };
}

/** The proof type a "Proof type:" value names: { type } when it is one known type, else { problem }. */
function readProofType(raw) {
  if (raw === '' || raw.startsWith('<')) return { problem: `the "Proof type:" line has no type. Write one of: ${PROOF_TYPE_LIST}` };
  const m = /^`?([A-Za-z-]+)`?\s*(?:\([^)]*\))?$/.exec(raw);
  if (!m) return { problem: `the "Proof type:" line must hold one type, not "${raw.slice(0, 60)}". Name one type of: ${PROOF_TYPE_LIST}` };
  const type = m[1].toLowerCase();
  if (!Object.hasOwn(PROOF_TYPES, type)) return { problem: `unknown proof type "${type}". Use one of: ${PROOF_TYPE_LIST}` };
  return { type };
}

function fieldProblems(key, list, type, head, say) {
  if (list.length !== 1) {
    say(list.length === 0 ? `a ${type} proof needs a ${key} line: ${key}: \`<command>\` @ <sha>, then a fenced output block` : `${list.length} ${key} lines. Keep one`);
    return;
  }
  const ev = list[0];
  if (!ev.command) say(`the ${key} line has no command in backticks`);
  else if (/^<.*>$/.test(ev.command)) say(`the ${key} line has a placeholder command`);
  if (!ev.sha) say(`the ${key} line names no commit (7 to 40 hex characters after @)`);
  else if (key === 'GREEN' && !shaIsHead(ev.sha, head)) say(`GREEN names commit ${ev.sha.slice(0, 7)}, not the head ${String(head).slice(0, 7)}. Run the check on the head and update the GREEN line`);
  if (ev.output === null) say(`the ${key} line has no fenced output block under it`);
  else if (ev.output.trim() === '') say(`the ${key} output block is empty`);
  else if (/^<[^>]*>$/.test(ev.output.trim())) say(`the ${key} output block is a placeholder`);
}

/**
 * The reasons this head has no valid proof; [] when the proof is valid. Pure.
 * `docsVerified`: the review router classed this head docs (see docsHeadVerified).
 */
export function proofProblems(parsed, { head, docsVerified = false }) {
  const out = [];
  const say = (text) => out.push(`${PROOF_REASON_PREFIX} ${text}`);
  const { types, fields } = parsed;
  if (types.length === 0) { say(`no "Proof type:" line. Add the Evidence block from pr-and-commit-style.md (types: ${PROOF_TYPE_LIST})`); return out; }
  if (types.length > 1) { say(`${types.length} "Proof type:" lines (${types.map((t) => t || 'empty').join(', ')}). Name one type`); return out; }
  const { type, problem } = readProofType(types[0]);
  if (problem) { say(problem); return out; }
  if (type === 'docs') {
    if (!docsVerified) say('proof type docs needs the review router to class this head as docs, with risk:docs as the only risk label');
    return out;
  }
  for (const key of PROOF_TYPES[type]) fieldProblems(key, fields[key], type, head, say);
  return out;
}

/**
 * The review router classed THIS head docs, and every risk:* label is risk:docs (at least one is present).
 * Same trust rule as verifiedBots: only the github-actions[bot] router comment counts.
 */
export function docsHeadVerified(labels, comments, head) {
  const state = routerState(comments);
  const risks = (labels || []).filter((n) => n.startsWith('risk:'));
  return state !== null && state.head === head && state.class === 'docs' && risks.length > 0 && risks.every((n) => n === 'risk:docs');
}

/** The `proof` field of the result. `gate` false = a repo without the gate; `dependabot` = the signed-bot exemption. */
function proofResult({ gate, dependabot, body, head, labels, comments }) {
  if (!gate) return { required: false, type: null, status: 'off', problems: [] };
  if (dependabot) return { required: false, type: null, status: 'exempt', exemption: 'dependabot', problems: [] };
  const parsed = parseProof(body);
  const problems = proofProblems(parsed, { head, docsVerified: docsHeadVerified(labels, comments, head) });
  const type = parsed.types.length === 1 ? readProofType(parsed.types[0]).type ?? null : null;
  const status = problems.length === 0 ? 'ok' : parsed.types.length === 0 ? 'missing' : 'invalid';
  return { required: true, type, status, problems };
}

// CodeRabbit lists findings on lines outside the diff in the review body: "Outside diff range comments (N)".
// They make no review thread, so `unresolved` stays 0. N is the sum over every PR-bot review of the PR: a review
// of a new head covers only the new commits and never repeats older outside-diff findings, so a push must not clear
// them. N blocks READY until the PR body "Outside-diff: handled" list has N entries (pr-review-loop.md "When the
// review lands"). A full re-review can list a finding twice; that over-counts, which fails closed.
const OUTSIDE_DIFF_HEADING = /^(?:[^\w\n<]|<\/?(?:summary|details|strong)>)*Outside diff range comments\s*\((\d+)\)/im;

/**
 * N summed over every CodeRabbit app review body, each review id once; 0 when none. The review sentence is not needed: a body that
 * starts at the heading (live PR 205 review 5691905341, PR 221 review 5712203534) has none. A reply holds no heading, so it adds 0.
 */
export function codeRabbitOutsideDiff({ reviews = [] }) {
  const seen = new Set();
  let total = 0;
  for (const r of reviews || []) {
    if (!isCodeRabbitUser(r?.user)) continue;
    if (r.id != null && seen.has(r.id)) continue;
    if (r.id != null) seen.add(r.id);
    const m = OUTSIDE_DIFF_HEADING.exec(r.body || '');
    if (m) total += Number(m[1]);
  }
  return total;
}

/** The reason a draft carries. The pr-loop mod holds this text by value (pr-loop-sync.test.mjs pins it). */
export const DRAFT_REASON = 'PR is a draft (no bot review on drafts)';

const CODERABBIT_REQUEST = /^@coderabbitai\s+(?:full\s+)?review\b/i;
const isBotAuthor = (user) => user?.type === 'Bot' || /\[bot\]$/i.test(user?.login || '');

/** Issue comments by a person (not a bot) whose trimmed body starts with "@coderabbitai review" or "@coderabbitai full review". */
export function coderabbitRequestComments(comments = []) {
  return (comments || []).filter((c) => !isBotAuthor(c?.user) && CODERABBIT_REQUEST.test((c?.body || '').trim()));
}

/**
 * The CodeRabbit PR reviews bought so far. 0 with no bot review and no request. Else max(botReviews, requests + opening), where
 * botReviews = distinct commit_id among the CodeRabbit app reviews with a non-empty body (a thread-reply review has an empty one) and opening = 1 when the first bot review is older than the first
 * request (the automatic opening review was not asked for). Requests whose review is not in yet still count.
 */
export function coderabbitRoundsOf({ reviews = [], comments = [] } = {}) {
  // A thread reply makes a COMMENTED review with an empty body: it is no round. Any non-empty body is a round,
  // even one without the review sentence (a review of outside-diff or nitpick findings only).
  const bot = (reviews || []).filter((r) => isCodeRabbitUser(r?.user) && (r.body || '').trim().length > 0);
  const requests = coderabbitRequestComments(comments);
  if (bot.length === 0 && requests.length === 0) return 0;
  const botReviews = new Set(bot.map((r) => r.commit_id)).size;
  const at = (iso) => Date.parse(iso);
  const firstReview = Math.min(...bot.map((r) => at(r.submitted_at)));
  const firstRequest = Math.min(...requests.map((c) => at(c.created_at)));
  const opening = bot.length > 0 && requests.length > 0 && firstReview < firstRequest ? 1 : 0;
  return Math.max(botReviews, requests.length + opening);
}

const HANDLED_HEADING = /^\s*(?:#{1,6}\s+)?(?:\*\*|__)?Outside-diff:\s*handled(?:\*\*|__)?:?\s*$/i;
const TOP_BULLET = /^[-*+]\s+\S/;
const EMPTY_BULLET = /^[-*+]\s*$/;
const PLACEHOLDER_BULLET = /^[-*+]\s+<[^>]*>\s*$/;

/**
 * Counts the top-level bullets under the "Outside-diff: handled" heading of the PR body. Fences and HTML
 * comments are skipped. Indented lines are detail. A heading or a prose line ends the list.
 */
export function outsideDiffHandled(body) {
  const state = { inComment: false };
  let fence = null;
  let inList = false;
  let count = 0;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      continue;
    }
    const clean = stripComments(line, state);
    const open = FENCE_OPEN.exec(clean);
    if (open) { fence = { ch: open[1][0], len: open[1].length }; if (inList) return count; continue; }
    if (HANDLED_HEADING.test(clean)) { if (inList) return count; inList = true; continue; }
    if (!inList || clean.trim() === '' || /^\s/.test(clean) || EMPTY_BULLET.test(clean) || PLACEHOLDER_BULLET.test(clean)) continue;
    if (TOP_BULLET.test(clean)) count += 1;
    else return count;
  }
  return count;
}

// ---- The carry (PR D): READY accepts a CodeRabbit review of an EARLIER head -------------------------------------------
// A Minor-only round plus a small fix push needs no second review. CodeRabbit puts the severity in each INLINE comment
// (`**<picture>..</picture> Major** ·`); the review body has none, except in its outside-diff and nitpick sections. The reader is
// a minimal pattern on the raw text and fails closed: no marker is "unknown", and unknown counts as Major.
// pr-checkpoint.mjs and pr-review-loop.md name the same limit.
export const CARRY_MAX_LINES = 30;
const SEVERITY_MARK = /(?:<\/picture>|[\u{1F534}\u{1F7E0}\u{1F7E1}\u{1F535}\u{1F7E2}\u{1F9F9}])\s*(Critical|Major|Minor|Trivial|Nitpick)\b/giu;
const SEVERITY_OF = { critical: 'critical', major: 'major', minor: 'minor', trivial: 'minor', nitpick: 'minor' };
const SEVERITY_RANK = { unknown: 0, minor: 1, major: 2, critical: 3 };
const severityMarks = (text) => [...String(text ?? '').matchAll(SEVERITY_MARK)].map((m) => SEVERITY_OF[m[1].toLowerCase()]);

const REVIEW_SENTENCE = /Actionable comments posted:\s*(\d+)/;

/**
 * Is this a CodeRabbit review body worth reading? It holds the review sentence, an outside-diff section or a severity marker (the
 * live PR 205 and PR 221 outside-diff-only reviews have no sentence). The head review (codeRabbitHeadReview) and the carry
 * (reviewBlockers) both use this rule, so they cannot drift. It does not test for a notice: the head review does that itself.
 */
export function hasReviewContent(body) {
  const text = String(body ?? '');
  return REVIEW_SENTENCE.test(text) || OUTSIDE_DIFF_HEADING.test(text) || severityMarks(text).length > 0;
}

/** 'critical', 'major', 'minor' (Trivial and Nitpick too) or 'unknown'. The highest marker in the text wins. */
export function codeRabbitSeverity(text) {
  return severityMarks(text).reduce((best, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[best] ? s : best), 'unknown');
}

/** The newest CodeRabbit app review with a body (an empty body is a thread reply, no round). null when none. */
export function newestCodeRabbitReview(reviews) {
  const at = (r) => Date.parse(r?.submitted_at || '') || 0;
  return (reviews || [])
    .filter((r) => isCodeRabbitUser(r?.user) && String(r.body ?? '').trim() !== '')
    .reduce((best, r) => (best === null || at(r) >= at(best) ? r : best), null);
}

const CLEAN_ROUND = /No actionable comments were generated/i;

/** The commit named by a coverage marker of kind reviewed. 40 hex or null. */
function reviewedCoverage(text) {
  for (const m of text.matchAll(/final_review_risk_coverage:(\{[^}]*\})/g)) {
    try {
      const c = JSON.parse(m[1]);
      if (c.kind === 'reviewed' && /^[0-9a-f]{40}$/.test(c.coveredCommitId ?? '')) return c.coveredCommitId;
    } catch { /* not a marker */ }
  }
  return null;
}

/**
 * The commit a clean, reviewed summary covers: the coverage marker of kind reviewed. With no marker at all, the last "between <sha> and <sha>".
 * A marker that exists but does not say reviewed (or cannot be read) gives null: the "between" line must not override it. 40 hex or null.
 */
function summaryCoveredCommit(body) {
  const text = String(body ?? '');
  if (text.includes('final_review_risk_coverage:')) return reviewedCoverage(text);
  const between = [...text.matchAll(/between\s+[0-9a-f]{40}\s+and\s+([0-9a-f]{40})/g)].pop();
  return between ? between[1] : null;
}

/**
 * C2: the CodeRabbit round the carry reads. A review object (newestCodeRabbitReview), or a clean round that left only the summary
 * comment (live PR 213: 0 review objects). The summary stands in for a zero-finding review of the commit it covers: { id: null,
 * commit_id, summaryOnly: true }. It counts only when it is trusted, is no notice, says no actionable comments, covers a commit
 * that is not the head, was written after the newest review object, and no review object holds that commit (the object has the findings).
 */
export function newestCodeRabbitRound({ reviews, comments, commentEdits, head } = {}) {
  const object = newestCodeRabbitReview(reviews);
  const summary = trustedCodeRabbitSummary(comments, commentEdits);
  if (summary === null || codeRabbitNotice(summary.body) || !CLEAN_ROUND.test(String(summary.body))) return object;
  const covered = summaryCoveredCommit(summary.body);
  if (covered === null || covered === head) return object;
  if ((reviews || []).some((r) => isCodeRabbitUser(r?.user) && r.commit_id === covered)) return object;
  const objectAt = object ? Date.parse(object.submitted_at || '') || 0 : -1;
  return commentStamp(summary) > objectAt ? { id: null, commit_id: covered, body: '', summaryOnly: true } : object;
}

// GitHub lists at most 300 files in a compare. A list that long may be cut off, and the PR's own files may be the ones cut.
const COMPARE_FILE_CAP = 300;

/**
 * Lines changed since the reviewed head, over the PR's own files only: additions plus deletions of each compare file that is
 * also in the PR file list (by its name or its old name). A merge of main that touches files outside the PR does not count.
 * Accepted limit: a change of main INSIDE a PR file counts, because the compare cannot tell it from a fix line.
 * A file that counts none (binary, pure rename) counts one, so such a push cannot hide under the limit. null (fail closed)
 * when the compare file list is missing, is full (300 or more), or holds a bad count, or when the PR file list is missing.
 */
export function deltaLinesOf(compare, prFiles) {
  const files = compare?.files;
  if (!Array.isArray(files) || files.length >= COMPARE_FILE_CAP) return null;
  if (!files.every((f) => Number.isInteger(f?.additions) && Number.isInteger(f?.deletions))) return null;
  if (!Array.isArray(prFiles) || !prFiles.every((f) => typeof f?.filename === 'string')) return null;
  const own = new Set(prFiles.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)));
  const mine = files.filter((f) => own.has(f.filename) || (f.previous_filename && own.has(f.previous_filename)));
  return mine.reduce((sum, f) => sum + Math.max(1, f.additions + f.deletions), 0);
}

// The CLI fix review line (cr-fix.mjs prints it; the author pastes it into the PR body): `CLI fix review: <from>..<head> <verdict>`.
// Verdict is clean, "N major", "N critical" or incomplete. Fences and HTML comments are skipped, as in parseProof.
const CLI_FIX_LINE = /^(?:[-*+]\s+)?CLI fix review:\s*([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})\s+(\S.*?)\s*$/i;

/** Every CLI fix review line of a PR body: [{ from, head, verdict }], the shas in lower case. [] for no body. Pure. */
export function parseCliFixReviews(body) {
  const out = [];
  const state = { inComment: false };
  let fence = null;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      continue;
    }
    const clean = stripComments(line, state);
    const open = FENCE_OPEN.exec(clean);
    if (open) { fence = { ch: open[1][0], len: open[1].length }; continue; }
    const m = CLI_FIX_LINE.exec(clean.trim());
    if (m) out.push({ from: m[1].toLowerCase(), head: m[2].toLowerCase(), verdict: m[3] });
  }
  return out;
}

function reviewBlockers({ newest, reviewComments }, head) {
  if (!newest) return ['no CodeRabbit review to carry'];
  if (!/^[0-9a-f]{40}$/.test(newest.commit_id ?? '') || newest.commit_id === head) return ['the newest CodeRabbit review names no earlier head'];
  if (newest.summaryOnly) return []; // a clean summary-only round has no findings and no inline comments
  // A notice (rate limit, skipped, failed) is never a review, even when it quotes review content.
  if (codeRabbitNotice(newest.body)) return ['the newest CodeRabbit review is a notice'];
  const stated = REVIEW_SENTENCE.exec(newest.body);
  // No sentence (an outside-diff or nitpick only review, live PR 205 review 5691905341): 0 inline comments, the body is still read.
  // A body with no sentence, no outside-diff section and no severity marker has nothing to read, so it fails closed.
  if (!hasReviewContent(newest.body)) return ['the newest CodeRabbit review has no review sentence'];
  if (!Array.isArray(reviewComments)) return ['the inline comments of the newest review were not read'];
  const blocks = [];
  const bodySeverity = codeRabbitSeverity(newest.body);
  if (bodySeverity === 'critical' || bodySeverity === 'major') blocks.push(`the review body lists a ${bodySeverity} finding`);
  // Best effort: a marker per outside-diff finding. Each finding carries two, so this only catches a body with none.
  const outside = Number(OUTSIDE_DIFF_HEADING.exec(newest.body)?.[1] ?? 0);
  if (outside > 0 && severityMarks(newest.body).length < outside) blocks.push('an outside-diff finding has no severity marker');
  // N counts the inline comments only (PR 204 review 5691302687: N 1, one inline comment, one more finding outside the diff).
  const inline = Number(stated?.[1] ?? 0);
  if (reviewComments.length < inline) blocks.push(`only ${reviewComments.length} of ${inline} inline comments were read`);
  for (const c of reviewComments) {
    const s = codeRabbitSeverity(c?.body);
    if (s !== 'minor') blocks.push(s === 'unknown' ? 'an inline comment has no severity marker' : `an inline comment is ${s}`);
  }
  return blocks;
}

function deltaBlockers(compare, prFiles) {
  if (compare?.status !== 'ahead') return [`the earlier head is not an ancestor of this head (compare: ${compare?.status ?? 'unread'})`];
  const lines = deltaLinesOf(compare, prFiles);
  if (lines === null) return ['the push since the reviewed head could not be measured'];
  return lines > CARRY_MAX_LINES ? [`the push since the reviewed head is ${lines} lines, over ${CARRY_MAX_LINES}`] : [];
}

/**
 * The PR body must hold a CLI fix review line for exactly this range: from is a prefix (7 or more hex) of the carried review's
 * commit, head is a prefix of the current head. Every line that names the range must say clean, except that a clean line
 * overrides `incomplete` lines for the range. Anything else blocks.
 */
function cliFixBlockers({ body, newest }, head) {
  const from = String(newest?.commit_id ?? '');
  const range = `${from.slice(0, 7)}..${String(head ?? '').slice(0, 7)}`;
  const mine = parseCliFixReviews(body).filter((l) => shaIsHead(l.from, from) && shaIsHead(l.head, String(head ?? '')));
  if (mine.length === 0) return [`the PR body has no "CLI fix review: ${range} clean" line (run scripts/github/cr-fix.mjs)`];
  // A clean line overrides `incomplete` lines (an earlier run that did not finish). A Major or Critical line never yields.
  const bad = mine.find((l) => l.verdict !== 'clean' && (l.verdict !== 'incomplete' || !mine.some((m) => m.verdict === 'clean')));
  return bad ? [`the CLI fix review of ${range} is "${bad.verdict}", not clean`] : [];
}

function fileBlockers({ prFiles, config, matchGlob }) {
  const { critical, parser } = config?.checkpoint ?? {};
  if (!Array.isArray(critical) || !Array.isArray(parser)) return ['the base review-router config lists no critical and parser files'];
  if (typeof matchGlob !== 'function') return ['no glob matcher'];
  if (!Array.isArray(prFiles) || prFiles.length === 0 || !prFiles.every((f) => typeof f?.filename === 'string')) return ['the PR file list was not read'];
  const paths = prFiles.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
  try {
    const hit = paths.find((p) => [...critical, ...parser].some((g) => matchGlob(g, p)));
    return hit ? [`the PR changes a critical or parser file (${hit})`] : [];
  } catch { return ['a critical or parser glob could not be matched']; }
}

function scopeBlockers({ state, labels, cr }, head) {
  const blocks = [];
  if (!state || state.head !== head) blocks.push('the review router has not classified this head');
  if (state?.class === 'r3' || (labels || []).some((n) => n === 'risk:high' || n === 'risk:r3')) blocks.push('the PR is class r3 or risk:high');
  if (!cr || cr.status === 'pending') blocks.push('the CodeRabbit status is pending or unread');
  return blocks;
}

/**
 * Why a CodeRabbit review of an earlier head cannot stand for this head. [] means it can (the carry). Any missing input
 * is a reason: a failed fetch never makes a PR eligible. Needs the newest review, its inline comments, the compare of
 * that commit to the head, the PR files, the BASE branch's router config and a matchGlob (review-router.mjs).
 */
export function carryBlockers({ head, newest, reviewComments, compare, prFiles, config, state, labels, cr, matchGlob, body } = {}) {
  return [
    ...reviewBlockers({ newest, reviewComments }, head),
    ...deltaBlockers(compare, prFiles),
    ...cliFixBlockers({ body, newest }, head),
    ...fileBlockers({ prFiles, config, matchGlob }),
    ...scopeBlockers({ state, labels, cr }, head),
  ];
}

/**
 * { carried, cliOnly }. carried is { from, deltaLines } when the newest CodeRabbit review stands for the head (see carryBlockers), else null.
 * cliOnly is true when the CLI fix review line is the ONLY blocker: every other carry condition holds, so the author needs cr-fix.mjs, not a PR review.
 */
function carriedReview({ carry, reviews, head, comments, commentEdits, labels, cr, body }) {
  const newest = newestCodeRabbitRound({ reviews, comments, commentEdits, head });
  const blocks = carryBlockers({ ...carry, head, newest, state: routerState(comments), labels, cr, body });
  const carried = blocks.length === 0 ? { from: newest.commit_id, deltaLines: deltaLinesOf(carry.compare, carry.prFiles) } : null;
  return { carried, blockers: blocks, cliOnly: blocks.length > 0 && blocks.length === cliFixBlockers({ body, newest }, head).length };
}

/** The reasons a head with no CodeRabbit review carries. The first two are for a draft and an unrouted PR; a person must not post a review request for either. */
export const NO_REVIEW_REASON = 'no CodeRabbit PR-bot review of the head commit (CLI/plugin output does not count). After a push, post "@coderabbitai review" once to start one';
export const NO_REVIEW_DRAFT_REASON = 'no CodeRabbit PR-bot review of the head commit. Draft: run /pathway; do not request a review';
export const NO_REVIEW_UNVERIFIED_REASON = 'no CodeRabbit PR-bot review of the head commit; re-run the review-router workflow for this head; do not request a review';
/** Only the CLI fix review line blocks the carry: run cr-fix.mjs and paste its line. Never a paid PR review. The prefix is the one the mod and the rule match. */
export const noReviewCliReason = (prNumber) => `no CodeRabbit PR-bot review of the head commit; the earlier review carries once the PR body has a clean CLI fix review line. Run node scripts/github/cr-fix.mjs --pr ${prNumber} and put its line in the PR body (or fix its findings, then run it again); do not request a review`;
const noReviewReason = (pull, need, cliOnly) => (pull.draft === true ? NO_REVIEW_DRAFT_REASON : need.unverified ? NO_REVIEW_UNVERIFIED_REASON : cliOnly ? noReviewCliReason(pull.number) : NO_REVIEW_REASON);

export function evaluate({ pull, combined, checkRuns, threads, bodyEdits, reviews = [], comments = [], commentEdits, headCommittedAt, greptileAuto = true, commits = [], proofGate = true, nowMs = Date.now(), carry = null }) {
  const head = pull.head.sha;
  const labels = pullLabelNames(pull);
  const dependabot = isDependabotPr(pull, commits);
  const need = dependabot ? DEPENDABOT_NEED : verifiedBots(labels, comments, head, greptileAuto);
  const proof = proofResult({ gate: proofGate, dependabot, body: pull.body, head, labels, comments });
  const run = latestGreptileRun(checkRuns);
  const greptile = greptileState(run);
  const greptileSummary = run?.output?.summary ?? null;

  // reviewedHead needs the check run (check-only state stays in `greptile`) AND a usable summary.
  // After a passed (or failed-but-scored) check, any summary problem is UNAVAILABLE with its own
  // reason: one @greptileai comment makes Greptile rewrite its summary.
  // A cancelled run (neutral) keeps `unavailable` true for older mod copies that read `unavailable` and
  // `rateLimited`; only its reason text says cancelled. When the labels do not require Greptile, the
  // raw state stays in `greptile`, `confidence`, `reviewedHead`, `lowConfidence` and `unavailable`, and a
  // reviewed head under the bar still blocks. Only `rateLimited` (a MISSING review) follows the requirement.
  const summary = greptile === 'reviewed' ? resolveSummary({ pull, comments, commentEdits, bodyEdits, head }) : null;
  const summaryProblem = summary ? summary.problem : null;
  const reviewedHead = greptile === 'reviewed' && summaryProblem === null;
  const unavailable = greptile === 'unavailable' || greptile === 'cancelled' || summaryProblem !== null;
  const lowConfidence = reviewedHead && summary.confidence < MIN_CONFIDENCE;

  const otherStatuses = (combined.statuses || []).filter((s) => !isCodeRabbitStatus(s));
  const badStatuses = otherStatuses.filter((s) => s.state !== 'success');
  const badRuns = (checkRuns || []).filter((c) => !isGreptileRun(c))
    .filter((c) => c.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(c.conclusion));
  const unresolved = threads.filter((t) => !t.isResolved).length;
  const outsideDiff = codeRabbitOutsideDiff({ head, reviews });
  const outsideHandled = outsideDiffHandled(pull.body);

  const reasons = [];
  if (pull.merged) reasons.push('already merged');
  if (pull.state !== 'open') reasons.push(`PR is ${pull.state}`);
  if (pull.draft === true) reasons.push(DRAFT_REASON);
  reasons.push(...proof.problems);
  reasons.push(...(need.blockers ?? []));
  const greptileBlocks = greptileReasons({
    required: need.greptile, greptile, run, greptileSummary, unavailable, summaryProblem, lowConfidence, reviewedHead, confidence: summary?.confidence,
    failedOnHead: greptileFailedOnHead(checkRuns),
  });
  reasons.push(...greptileBlocks);
  // Say WHY Greptile is needed when the labels alone would not need it (the router check kept it).
  if (need.unverified && greptileBlocks.length > 0) reasons.push(`Greptile is required because ${need.unverified}`);
  if (unresolved > 0) reasons.push(`${unresolved} review thread(s) unresolved`);
  if (outsideDiff > outsideHandled) {
    reasons.push(`CodeRabbit lists ${outsideDiff} outside-diff finding(s) across its reviews of this PR (head ${head.slice(0, 7)}) and the PR body "Outside-diff: handled" list has ${outsideHandled}. Read the review body, then fix each finding or list it as handled`);
  }
  for (const s of badStatuses) reasons.push(`status "${s.context}" is ${s.state}`);
  for (const c of badRuns) reasons.push(`check "${c.name}" is ${c.status}/${c.conclusion}`);
  if (pull.mergeable_state && pull.mergeable_state !== 'clean') reasons.push(`mergeable_state is "${pull.mergeable_state}"`);

  let coderabbit = null;
  let coderabbitReviewedHead = null;
  let coderabbitLimited = null;
  let coderabbitRateLimited = null;
  let coderabbitRetryMinutes = null;
  let coderabbitCarried = null;
  let coderabbitCarryBlockers = [];
  if (need.coderabbit) {
    const cr = codeRabbitHeadReview({ head, reviews, comments, statuses: combined.statuses || [], commentEdits, headCommittedAt, nowMs });
    coderabbit = cr.status;
    coderabbitReviewedHead = cr.reviewedHead;
    coderabbitLimited = cr.limited;
    coderabbitRateLimited = cr.rateLimited;
    coderabbitRetryMinutes = cr.retryMinutes;
    if (cr.rateLimited) {
      reasons.push('CodeRabbit rate limited: head not reviewed (PR-bot review does not count; do not buy on-demand review)');
    } else if (cr.limited) {
      reasons.push(`CodeRabbit ${cr.notice === 'skipped' ? 'skipped the review of' : 'review failed on'} the head (PR-bot review did not run; CLI/plugin output does not count)`);
    } else if (!cr.reviewedHead) {
      // auto_incremental_review is off, so a push does not start a review. A rate-limit notice has its own branch above.
      // A Minor-only review of an earlier head plus a small push stands for the head (the carry); every other case asks for a review.
      const carryResult = carriedReview({ carry, reviews, head, comments, commentEdits, labels, cr, body: pull.body });
      coderabbitCarried = carryResult.carried;
      // Only a carry whose inputs were read has blockers to show; a draft or unrouted PR never reads them.
      coderabbitCarryBlockers = carry ? carryResult.blockers : [];
      if (coderabbitCarried === null) reasons.push(noReviewReason(pull, need, carryResult.cliOnly));
    }
    if (need.unverified && !need.greptile && cr.reviewedHead !== true) reasons.push(`CodeRabbit is required because ${need.unverified}`);
  }

  return {
    pr: pull.number, head, headShort: head.slice(0, 7), branch: pull.head.ref, reviewer: 'greptile',
    // false when main's .greptile/config.json turns automatic Greptile reviews off (autoReview []).
    greptileAuto,
    greptile, greptileSummary, confidence: reviewedHead ? summary.confidence : null, lowConfidence,
    reviewed: reviewedHead, reviewedHead, unavailable,
    coderabbit, coderabbitReviewedHead,
    // { from, deltaLines }: READY took a Minor-only CodeRabbit review of the earlier head `from`, plus a push of `deltaLines` lines or fewer, for this head.
    // null otherwise. coderabbitReviewedHead stays false for a carry: the head itself was not reviewed.
    coderabbitCarried,
    // Why the carry did not stand for the head: the carryBlockers strings. [] when carried or not tried. Never a reason: READY ignores it.
    coderabbitCarryBlockers,
    // N from "Outside diff range comments (N)" in the newest CodeRabbit review of the head. 0 when none. Blocks READY until handled.
    coderabbitOutsideDiff: outsideDiff,
    // true when a labelled PR has no CodeRabbit review because the app rate limited, skipped or failed; null when unlabelled.
    coderabbitLimited,
    // true when that missing review is a rate limit or review limit (not a skip or a failure). null when unlabelled.
    // coderabbitRetryMinutes: CodeRabbit's own "next review in N minutes" figure from the notice, else null.
    // A rate-limited PR must not get an @coderabbitai review request (the pr-loop mod says so).
    coderabbitRateLimited, coderabbitRetryMinutes,
    // PR checkpoint fields the pr-loop mod reads: draft state, the label names, the requests people posted, and the rounds bought.
    isDraft: pull.draft === true, labels, coderabbitRequests: coderabbitRequestComments(comments).length, coderabbitRounds: coderabbitRoundsOf({ reviews, comments }),
    // 'comment' or 'body': where the usable Greptile summary came from. null when none was used.
    summarySource: reviewedHead ? summary.source : null,
    // rateLimited is the pre-Greptile name for "the reviewer did not finish". Older mod copies read it.
    rateLimited: unavailable && need.greptile,
    // Every bot in `routing.required` reviewed the head (Greptile: reviewedHead; CodeRabbit: coderabbitReviewedHead).
    // True when no bot is required. The pr-loop mod keys on this, not on the Greptile-only `reviewedHead`.
    routedReviewed: (!need.greptile || reviewedHead) && (!need.coderabbit || coderabbitReviewedHead === true || coderabbitCarried !== null),
    // Which bots the labels require. `held` is a note, never a reason. `source` is 'default' with no review:* or risk:* label.
    routing: { required: [...(need.greptile ? ['greptile'] : []), ...(need.coderabbit ? ['coderabbit'] : [])], held: need.held, source: need.source, ...(need.unverified ? { unverified: need.unverified } : {}) },
    // P4b: the PR body proof. status is 'ok', 'missing' (no Proof type line), 'invalid', 'exempt' (Dependabot) or 'off' (other repos).
    proof: { required: proof.required, type: proof.type, status: proof.status, ...(proof.exemption ? { exemption: proof.exemption } : {}), problems: proof.problems },
    unresolved, totalThreads: threads.length, mergeable_state: pull.mergeable_state, prState: pull.state, merged: Boolean(pull.merged),
    ready: reasons.length === 0, reasons,
  };
}

/**
 * Read .greptile/config.json from the BASE branch, never the PR head: a PR must not lower its own bar.
 * No file (404) = the dashboard default (Greptile reviews). Any other error is "cannot determine".
 */
function readGreptileAuto(baseRef) {
  let doc;
  try {
    doc = gh([`repos/${owner}/${name}/contents/.greptile/config.json?ref=${encodeURIComponent(baseRef)}`]);
  } catch (err) {
    if (/HTTP 404|Not Found/i.test(`${err.message}\n${err.stderr ?? ''}\n${err.stdout ?? ''}`)) return true;
    throw err;
  }
  return greptileAutoFrom(JSON.parse(Buffer.from(doc.content ?? '', 'base64').toString('utf8')));
}

/** The value of fn(), or null when it throws: a failed carry fetch makes the PR not eligible, never an error. */
function attempt(fn) {
  try { return fn(); } catch { return null; }
}

/**
 * The four reads the carry needs, only for a PR whose CodeRabbit review does not name the head. Each read that fails is null,
 * and carryBlockers turns a null into "not eligible". The router config comes from the BASE branch: a PR must not lower its own bar.
 */
function readCarry({ pull, reviews, comments, commentEdits }) {
  const newest = newestCodeRabbitRound({ reviews, comments, commentEdits, head: pull.head.sha });
  if (!newest?.commit_id || (!newest.id && !newest.summaryOnly)) return null;
  const files = attempt(() => gh(['--paginate', '--slurp', `repos/${owner}/${name}/pulls/${pr}/files?per_page=100`]).flat());
  return {
    // A summary-only round has no review object and no inline comments: nothing to read.
    reviewComments: newest.summaryOnly ? [] : attempt(() => gh(['--paginate', '--slurp', `repos/${owner}/${name}/pulls/${pr}/reviews/${newest.id}/comments?per_page=100`]).flat()),
    compare: attempt(() => gh([`repos/${owner}/${name}/compare/${newest.commit_id}...${pull.head.sha}`])),
    // changed_files must match the list read: a short or long list is not the PR's files. Above 300 files: not eligible.
    prFiles: files && files.length === pull.changed_files && files.length <= 300 ? files : null,
    config: attempt(() => JSON.parse(Buffer.from(gh([`repos/${owner}/${name}/contents/review-router.config.json?ref=${encodeURIComponent(pull.base.ref)}`]).content ?? '', 'base64').toString('utf8'))),
  };
}

/** Does this result want the carry? CodeRabbit is required, did not review the head and did not rate limit, skip or fail. */
// A draft or an unrouted PR can never carry (scopeBlockers), so it pays for no read.
const wantsCarry = (r) => r.routing.required.includes('coderabbit') && r.coderabbitReviewedHead === false && r.coderabbitLimited === false
  && !r.isDraft && !r.routing.unverified;

/**
 * Evaluate once without the carry. Only a PR that wants it pays for the reads and the dynamic import. matchGlob lives in
 * review-router.mjs, which imports this file, so it is imported here and not at the top.
 */
async function evaluateWithCarry(inputs, readCarryFn) {
  const first = evaluate(inputs);
  if (!wantsCarry(first)) return first;
  const carry = inputs.carry ?? readCarryFn(inputs);
  const matchGlob = await import('./review-router.mjs').then((m) => m.matchGlob, () => undefined);
  return carry ? evaluate({ ...inputs, carry: { ...carry, matchGlob } }) : first;
}

/** --fixture <file>: the evaluate inputs as JSON (plus carry, with no matchGlob). No gh call. The result says fixture: true. */
const fixturePath = opt('--fixture', null);

/** Every gh read evaluate needs, for the live PR. A truncated page or a moved head throws: "cannot determine". */
function readLiveInputs() {
  const pull = gh([`repos/${owner}/${name}/pulls/${pr}`]);
  // Page sizes are explicit, and a truncated page is "cannot determine", never READY:
  // a failing check or open thread past the first page must not be dropped silently.
  const combined = gh([`repos/${owner}/${name}/commits/${pull.head.sha}/status?per_page=100`]);
  if ((combined.total_count ?? 0) > (combined.statuses || []).length) throw new Error(`more than ${combined.statuses.length} commit statuses`);
  const runsDoc = gh([`repos/${owner}/${name}/commits/${pull.head.sha}/check-runs?per_page=100`]);
  const checkRuns = runsDoc.check_runs;
  if ((runsDoc.total_count ?? 0) > checkRuns.length) throw new Error(`more than ${checkRuns.length} check runs`);
  // userContentEdits is newest first; 20 is plenty to reach Greptile's newest edit.
  // Comments are read apart, page by page (readIssueComments). More than 100 review threads is "cannot determine".
  // commits(last:1) is the head commit, for the CodeRabbit notice date.
  const q = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){headRefOid reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}} userContentEdits(first:20){nodes{editor{__typename login}}} commits(last:1){nodes{commit{oid committedDate}}} allCommits: commits(first:100){totalCount nodes{commit{author{user{login}} signature{isValid wasSignedByGitHub}}}}}}}';
  const g = gh(['graphql', '-f', `query=${q}`, '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${pr}`]);
  const prq = g.data.repository.pullRequest;
  const rt = prq.reviewThreads;
  if (rt.pageInfo.hasNextPage) throw new Error('more than 100 review threads');
  // Issue comments carry the Greptile summary (and CodeRabbit's), so every PR reads them. All pages, through the reader cr-fix.mjs uses.
  // REST finds the candidates; only the GraphQL body is parsed.
  const { comments, commentEdits } = readIssueComments(gh, owner, name, pr);
  const greptileAuto = readGreptileAuto(pull.base.ref);
  // Every PR reads the reviews: outside-diff findings in a CodeRabbit review body block READY whatever the labels.
  const reviews = gh(['--paginate', '--slurp', `repos/${owner}/${name}/pulls/${pr}/reviews?per_page=100`]).flat();
  const headCommit = prq.commits.nodes[0]?.commit;
  const headCommittedAt = headCommit?.oid === pull.head.sha ? headCommit.committedDate : undefined;
  // The GraphQL read must describe the head the REST read saw; a push in between is "cannot determine".
  // headRefOid, not the commit list: an empty list must still reach evaluate, which then denies the exemption.
  if (prq.headRefOid !== pull.head.sha) throw new Error(`head moved during the read (${String(prq.headRefOid).slice(0, 7)} vs ${pull.head.sha.slice(0, 7)})`);
  // Every commit's author account and GitHub signature, for the Dependabot rule. More than 100 commits = unknown.
  const ac = prq.allCommits;
  const commits = ac.totalCount > ac.nodes.length ? [] : ac.nodes.map((n) => ({
    author: n.commit.author?.user?.login ?? null,
    githubSigned: n.commit.signature?.isValid === true && n.commit.signature?.wasSignedByGitHub === true,
  }));
  return {
    pull, combined, checkRuns, threads: rt.nodes, bodyEdits: prq.userContentEdits.nodes, reviews, comments, commentEdits, headCommittedAt, greptileAuto, commits,
    proofGate: PROOF_REPOS.has(repo.toLowerCase()),
  };
}

async function main() {
  if (!pr && !fixturePath) { console.error('usage: review-status.mjs <pr-number> [--repo owner/name] [--json] [--fixture file]'); process.exit(2); }
  let result;
  try {
    result = fixturePath
      ? { ...(await evaluateWithCarry(JSON.parse(readFileSync(fixturePath, 'utf8')), () => null)), fixture: true }
      : await evaluateWithCarry(readLiveInputs(), readCarry);
  } catch (err) {
    console.error(`review-status: could not determine (${String(err.message).split('\n')[0]})`);
    process.exit(2);
  }
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else {
    console.log(`PR #${result.pr} head ${result.headShort} (${result.branch}): ${result.ready ? 'READY' : 'NOT READY'}`);
    console.log(`  Greptile: ${result.greptile} | review of head: ${result.reviewedHead ? 'yes' : 'NO'} | confidence: ${result.confidence === null ? 'n/a' : `${result.confidence}/5`} | unresolved threads: ${result.unresolved}/${result.totalThreads} | mergeable: ${result.mergeable_state}`);
    console.log(`  Proof: ${result.proof.type ?? 'none'} (${result.proof.status})`);
    for (const r of result.reasons) console.log(`  - ${r}`);
    if (result.coderabbitCarryBlockers?.length > 0) {
      console.log('  Carry blockers (why the earlier CodeRabbit review does not stand for this head):');
      for (const b of result.coderabbitCarryBlockers) console.log(`    - ${b}`);
    }
  }
  process.exit(result.ready ? 0 : 1);
}

// Run main() when executed directly. Compare real paths (fileURLToPath decodes %20 and
// non-ASCII; realpath follows junctions/symlinks) so a direct run can never silently skip
// main() and exit 0 -- land-pr.ps1 treats exit 0 as READY.
function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) {
  main().catch((err) => {
    console.error(`review-status: could not determine (${String(err?.message).split('\n')[0]})`);
    process.exit(2);
  });
}
