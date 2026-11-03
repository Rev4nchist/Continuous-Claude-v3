// GitHub reads for the eval: PR facts, CodeRabbit rounds, and the original place of an inline comment.
// `gh` is injectable: async (args: string[]) => parsed JSON. Read-only calls only (gh api GET).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_REPO } from '../../github/cursor-review.mjs';
import { cleanSummaryCommit, codeRabbitNotice, isCodeRabbitUser } from '../../github/review-status.mjs';

/** The default gh: personal gh config when it exists (same rule as cursor-review.mjs), hidden window, JSON out. */
export function defaultGh(args) {
  const personal = path.join(os.homedir(), '.config', 'gh-personal');
  const dir = process.env.GH_CONFIG_DIR || (existsSync(personal) ? personal : undefined);
  const env = { ...process.env, ...(dir ? { GH_CONFIG_DIR: dir } : {}) };
  const out = execFileSync('gh', args, { encoding: 'utf8', env, timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

/** A paged list: `gh api --paginate --slurp` gives an array of pages; flatten it. A flat array passes through. */
export async function ghList(gh, route) {
  const res = await gh(['api', '--paginate', '--slurp', `${route}${route.includes('?') ? '&' : '?'}per_page=100`]);
  return Array.isArray(res) && res.every(Array.isArray) ? res.flat() : res;
}

const lc = (s) => String(s ?? '').toLowerCase();

/**
 * Pure. CodeRabbit rounds in commit order: one round per distinct commit_id of a non-empty CR review, plus a
 * `summary` round from a clean summary-only comment. A notice review is kept with `notice` set; callers that
 * want real rounds drop it. [{ sha40, rank, kind: 'review' | 'summary', reviewId, submittedAt, notice }]
 */
export function roundsFrom({ reviews = [], comments = [], commentEdits = {}, commits = [] } = {}) {
  const order = new Map(commits.map((c, i) => [lc(typeof c === 'string' ? c : c.sha), i]));
  const byCommit = new Map();
  for (const r of reviews || []) {
    if (!isCodeRabbitUser(r?.user) || String(r.body ?? '').trim() === '' || !r.commit_id) continue;
    const notice = codeRabbitNotice(r.body);
    const cur = byCommit.get(lc(r.commit_id));
    if (cur && !(cur.notice && !notice)) continue; // keep the first review of a commit, unless it was only a notice
    byCommit.set(lc(r.commit_id), { sha40: lc(r.commit_id), kind: 'review', reviewId: r.id ?? null, submittedAt: r.submitted_at ?? null, notice });
  }
  // Eval-only trust: the REST author is the CodeRabbit app, so a summary with no edit history counts (no GraphQL read here).
  const edits = { ...Object.fromEntries((comments || []).filter((c) => isCodeRabbitUser(c?.user)).map((c) => [c.id, []])), ...commentEdits };
  const covered = cleanSummaryCommit(comments, edits);
  if (covered && !byCommit.has(lc(covered))) byCommit.set(lc(covered), { sha40: lc(covered), kind: 'summary', reviewId: null, submittedAt: null, notice: null });
  const rounds = [...byCommit.values()].sort((a, b) => {
    const ra = order.get(a.sha40);
    const rb = order.get(b.sha40);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    return (Date.parse(a.submittedAt) || 0) - (Date.parse(b.submittedAt) || 0);
  });
  return rounds.map((r, i) => ({ ...r, rank: i + 1 }));
}

export async function roundData(pr, { gh, repo }) {
  const [reviews, comments, commits] = await Promise.all([
    ghList(gh, `repos/${repo}/pulls/${pr}/reviews`),
    ghList(gh, `repos/${repo}/issues/${pr}/comments`),
    ghList(gh, `repos/${repo}/pulls/${pr}/commits`),
  ]);
  return { reviews, comments, commits };
}

const renumber = (rounds) => rounds.map((r, i) => ({ ...r, rank: i + 1 }));

/** CodeRabbit rounds of a PR, notices left out, in commit order. */
export async function crRounds(pr, { gh = defaultGh, repo = DEFAULT_REPO } = {}) {
  const data = await roundData(pr, { gh, repo });
  return renumber(roundsFrom({ ...data, commentEdits: {} }).filter((r) => !r.notice));
}

/** { pr, state, merged, mergeSha, baseSha, baseRef, headSha, createdAt, mergedAt, author, commits[], rounds[], allRounds[] }. */
export async function fetchPr(pr, { gh = defaultGh, repo = DEFAULT_REPO } = {}) {
  const pull = await gh(['api', `repos/${repo}/pulls/${pr}`]);
  const data = await roundData(pr, { gh, repo });
  const allRounds = roundsFrom({ ...data, commentEdits: {} });
  return {
    pr, state: pull.state, merged: Boolean(pull.merged || pull.merged_at), mergeSha: pull.merge_commit_sha ?? null, baseSha: pull.base?.sha ?? null, baseRef: pull.base?.ref ?? null,
    headSha: pull.head?.sha ?? null, createdAt: pull.created_at ?? null, mergedAt: pull.merged_at ?? null, author: pull.user?.login ?? null,
    commits: data.commits.map((c) => c.sha), rounds: renumber(allRounds.filter((r) => !r.notice)), allRounds,
  };
}

/** The place an inline comment was made on. Reads original_* (line is null after a push). { id, path, sha40, startLine, endLine }. */
export async function originalPlace(commentId, { gh = defaultGh, repo = DEFAULT_REPO } = {}) {
  const c = await gh(['api', `repos/${repo}/pulls/comments/${commentId}`]);
  const end = c.original_line ?? null;
  return { id: c.id ?? commentId, path: c.path ?? null, sha40: c.original_commit_id ?? null, startLine: c.original_start_line ?? end, endLine: end };
}

/** Inline review comments and reviews of a PR (all rounds), for the shadow reader. */
export const inlineComments = (pr, { gh = defaultGh, repo = DEFAULT_REPO } = {}) => ghList(gh, `repos/${repo}/pulls/${pr}/comments`);
