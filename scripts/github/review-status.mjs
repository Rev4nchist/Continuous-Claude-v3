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
 * CodeRabbit PR-bot reviews (`coderabbitai[bot]` on the head, with review content) count toward READY
 * when the PR carries `review:coderabbit` or `review:deep`. "Review skipped", "Review failed" and
 * rate-limit notices, and CLI/plugin output, never count. The summary comment is read only from the
 * newest comment with the "summarize by coderabbit.ai" marker, and counts only if no person edited it.
 * A notice counts only from that comment and only for the head: when it names a commit (link or SHA,
 * 7 or more characters) that commit must be the head, and only a notice with no commit falls back to
 * "newer than the head commit". A labelled
 * PR whose CodeRabbit review is missing because of such a notice reports coderabbitLimited (the
 * pr-loop mod maps it to LIMITED). A leftover CodeRabbit commit status alone does not grant READY.
 * Any review thread, from any reviewer, still counts as unresolved.
 *
 * Usage: node scripts/github/review-status.mjs <pr-number> [--repo owner/name] [--json]
 * Exit 0 = ready, 1 = not ready (reasons listed), 2 = could not determine.
 * Uses `gh api`; set GH_CONFIG_DIR for the repo's account (default: ~/.config/gh-personal when it
 * exists, else gh's own default login).
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
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
export const CODERABBIT_REVIEW_LABELS = new Set(['review:coderabbit', 'review:deep']);

export function pullLabelNames(pull) {
  return (pull?.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}

export function needsCodeRabbitReview(labels) {
  return labels.some((n) => CODERABBIT_REVIEW_LABELS.has(n));
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
export function codeRabbitHeadReview({ head, reviews = [], comments = [], statuses = [], commentEdits, headCommittedAt }) {
  const cr = (statuses || []).find((s) => /coderabbit/i.test(s?.context || ''));
  const summary = latestCodeRabbitSummary(comments);
  const summaryTrusted = summary !== null && commentEditedAfterApp(commentEdits, summary.id, CODERABBIT_EDITOR) === null;
  const reviewedHead =
    reviews.some(
      (r) => isCodeRabbitUser(r.user) && r.commit_id === head && /Actionable comments posted:\s*\d+/.test(r.body || ''),
    ) || (summaryTrusted && summaryCoversHead(summary.body, head));
  const statusLimited = !reviewedHead && /rate limit|limit reached/i.test(cr?.description || '');
  // The summary comment from the CodeRabbit app holds the notice ("Review skipped", "Review failed",
  // "Rate limit exceeded") that explains why no review exists. Chat replies and old notices do not count.
  const notice = reviewedHead ? null
    : statusLimited ? 'rate limited'
    : summary !== null && noticeIsAfterHead(summary, headCommittedAt, head) ? codeRabbitNotice(summary.body)
    : null;
  return {
    reviewedHead, rateLimited: notice === 'rate limited', limited: notice !== null, notice,
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
 * Stricter rule for the Greptile comment. Once the comment was edited, every editor in the history
 * must be the Greptile app (GraphQL login greptile-apps, type Bot). Returns the first other editor's
 * login (or a description), else null. A comment with no edits has an empty history and passes.
 */
export function greptileCommentForeignEditor(comment, edits) {
  const edited = Boolean(comment?.lastEditedAt) || (Array.isArray(edits) && edits.length > 0);
  if (!edited || !Array.isArray(edits)) return null;
  const other = edits.find((e) => !(e?.editor?.login === GREPTILE_EDITOR && e?.editor?.__typename === 'Bot'));
  return other ? (other.editor?.login ?? 'a deleted account') : null;
}

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

export function evaluate({ pull, combined, checkRuns, threads, bodyEdits, reviews = [], comments = [], commentEdits, headCommittedAt }) {
  const head = pull.head.sha;
  const run = latestGreptileRun(checkRuns);
  let greptile;
  if (!run) greptile = 'absent';
  else if (run.status !== 'completed') greptile = 'pending';
  else if (run.conclusion === 'success') greptile = 'reviewed';
  else greptile = 'unavailable';
  const greptileSummary = run?.output?.summary ?? null;

  // reviewedHead needs the check run (check-only state stays in `greptile`) AND a usable summary.
  // After a passed check, any summary problem is UNAVAILABLE with its own reason: one @greptileai
  // comment makes Greptile rewrite its summary.
  const summary = greptile === 'reviewed' ? resolveSummary({ pull, comments, commentEdits, bodyEdits, head }) : null;
  const summaryProblem = summary ? summary.problem : null;
  const reviewedHead = greptile === 'reviewed' && summaryProblem === null;
  const unavailable = greptile === 'unavailable' || summaryProblem !== null;
  const lowConfidence = reviewedHead && summary.confidence < MIN_CONFIDENCE;

  const otherStatuses = (combined.statuses || []).filter((s) => !isCodeRabbitStatus(s));
  const badStatuses = otherStatuses.filter((s) => s.state !== 'success');
  const badRuns = (checkRuns || []).filter((c) => !isGreptileRun(c))
    .filter((c) => c.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(c.conclusion));
  const unresolved = threads.filter((t) => !t.isResolved).length;

  const reasons = [];
  if (pull.merged) reasons.push('already merged');
  if (pull.state !== 'open') reasons.push(`PR is ${pull.state}`);
  if (greptile === 'absent') reasons.push('no Greptile check on the head commit yet (review pending; if none appears, see pr-review-loop.md "No review on the head")');
  if (greptile === 'pending') reasons.push(`Greptile review of the head is ${run.status}`);
  if (unavailable) reasons.push(`Greptile did not finish a review of the head (${run.status}/${run.conclusion}${greptileSummary ? `: "${String(greptileSummary).split('\n')[0]}"` : ''}). ${UNAVAILABLE_TAIL}`);
  if (summaryProblem) reasons.push(`${summaryProblem}. ${UNAVAILABLE_TAIL}`);
  if (lowConfidence) reasons.push(`Greptile confidence ${summary.confidence}/5 is below ${MIN_CONFIDENCE}`);
  if (unresolved > 0) reasons.push(`${unresolved} review thread(s) unresolved`);
  for (const s of badStatuses) reasons.push(`status "${s.context}" is ${s.state}`);
  for (const c of badRuns) reasons.push(`check "${c.name}" is ${c.status}/${c.conclusion}`);
  if (pull.mergeable_state && pull.mergeable_state !== 'clean') reasons.push(`mergeable_state is "${pull.mergeable_state}"`);

  const labels = pullLabelNames(pull);
  let coderabbit = null;
  let coderabbitReviewedHead = null;
  let coderabbitLimited = null;
  if (needsCodeRabbitReview(labels)) {
    const cr = codeRabbitHeadReview({ head, reviews, comments, statuses: combined.statuses || [], commentEdits, headCommittedAt });
    coderabbit = cr.status;
    coderabbitReviewedHead = cr.reviewedHead;
    coderabbitLimited = cr.limited;
    if (cr.rateLimited) {
      reasons.push('CodeRabbit rate limited: head not reviewed (PR-bot review does not count; do not buy on-demand review)');
    } else if (cr.limited) {
      reasons.push(`CodeRabbit ${cr.notice === 'skipped' ? 'skipped the review of' : 'review failed on'} the head (PR-bot review did not run; CLI/plugin output does not count)`);
    } else if (!cr.reviewedHead) {
      // auto_incremental_review is off, so a push does not start a review. A rate-limit notice has its own branch above.
      reasons.push('no CodeRabbit PR-bot review of the head commit (CLI/plugin output does not count). After a push, post "@coderabbitai review" once to start one');
    }
  }

  return {
    pr: pull.number, head, headShort: head.slice(0, 7), branch: pull.head.ref, reviewer: 'greptile',
    greptile, greptileSummary, confidence: reviewedHead ? summary.confidence : null, lowConfidence,
    reviewed: reviewedHead, reviewedHead, unavailable,
    coderabbit, coderabbitReviewedHead,
    // true when a labelled PR has no CodeRabbit review because the app rate limited, skipped or failed; null when unlabelled.
    coderabbitLimited,
    // 'comment' or 'body': where the usable Greptile summary came from. null when none was used.
    summarySource: reviewedHead ? summary.source : null,
    // rateLimited is the pre-Greptile name for "the reviewer did not finish". Older mod copies read it.
    rateLimited: unavailable,
    unresolved, totalThreads: threads.length, mergeable_state: pull.mergeable_state, prState: pull.state, merged: Boolean(pull.merged),
    ready: reasons.length === 0, reasons,
  };
}

function main() {
  if (!pr) { console.error('usage: review-status.mjs <pr-number> [--repo owner/name] [--json]'); process.exit(2); }
  let result;
  try {
    const pull = gh([`repos/${owner}/${name}/pulls/${pr}`]);
    // Page sizes are explicit, and a truncated page is "cannot determine", never READY:
    // a failing check or open thread past the first page must not be dropped silently.
    const combined = gh([`repos/${owner}/${name}/commits/${pull.head.sha}/status?per_page=100`]);
    if ((combined.total_count ?? 0) > (combined.statuses || []).length) throw new Error(`more than ${combined.statuses.length} commit statuses`);
    const runsDoc = gh([`repos/${owner}/${name}/commits/${pull.head.sha}/check-runs?per_page=100`]);
    const checkRuns = runsDoc.check_runs;
    if ((runsDoc.total_count ?? 0) > checkRuns.length) throw new Error(`more than ${checkRuns.length} check runs`);
    // userContentEdits is newest first; 20 is plenty to reach Greptile's newest edit.
    // Comments: the first 100, with body, author and 20 edits each in ONE response, so the parsed body and its edit
    // history cannot come from different moments. More than 100 is "cannot determine", like threads.
    // commits(last:1) is the head commit, for the CodeRabbit notice date.
    const q = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}} userContentEdits(first:20){nodes{editor{__typename login}}} comments(first:100){pageInfo{hasNextPage} nodes{databaseId body author{__typename login} lastEditedAt updatedAt userContentEdits(first:20){nodes{editor{__typename login} editedAt}}}} commits(last:1){nodes{commit{oid committedDate}}}}}}';
    const g = gh(['graphql', '-f', `query=${q}`, '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${pr}`]);
    const prq = g.data.repository.pullRequest;
    const rt = prq.reviewThreads;
    if (rt.pageInfo.hasNextPage) throw new Error('more than 100 review threads');
    if (prq.comments.pageInfo.hasNextPage) throw new Error('more than 100 comments');
    const labels = pullLabelNames(pull);
    let reviews = [];
    // Issue comments carry the Greptile summary (and CodeRabbit's), so every PR reads them.
    const restComments = gh(['--paginate', '--slurp', `repos/${owner}/${name}/issues/${pr}/comments?per_page=100`]).flat();
    // REST finds the candidates; only the GraphQL body is parsed.
    const { comments, commentEdits } = mergeGraphqlComments(restComments, prq.comments.nodes);
    if (needsCodeRabbitReview(labels)) {
      reviews = gh(['--paginate', '--slurp', `repos/${owner}/${name}/pulls/${pr}/reviews?per_page=100`]).flat();
    }
    const headCommit = prq.commits.nodes[0]?.commit;
    const headCommittedAt = headCommit?.oid === pull.head.sha ? headCommit.committedDate : undefined;
    result = evaluate({
      pull, combined, checkRuns, threads: rt.nodes, bodyEdits: prq.userContentEdits.nodes, reviews, comments, commentEdits, headCommittedAt,
    });
  } catch (err) {
    console.error(`review-status: could not determine (${String(err.message).split('\n')[0]})`);
    process.exit(2);
  }
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else {
    console.log(`PR #${result.pr} head ${result.headShort} (${result.branch}): ${result.ready ? 'READY' : 'NOT READY'}`);
    console.log(`  Greptile: ${result.greptile} | review of head: ${result.reviewedHead ? 'yes' : 'NO'} | confidence: ${result.confidence === null ? 'n/a' : `${result.confidence}/5`} | unresolved threads: ${result.unresolved}/${result.totalThreads} | mergeable: ${result.mergeable_state}`);
    for (const r of result.reasons) console.log(`  - ${r}`);
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
if (isDirectRun()) main();
