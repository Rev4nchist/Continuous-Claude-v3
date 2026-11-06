#!/usr/bin/env node
/**
 * land-recheck.mjs: Gate C, the re-check land-pr.ps1 runs right before the merge call.
 *
 * Usage: node scripts/github/land-recheck.mjs <pr> --head <sha> --ready-at <ISO time> [--repo owner/name]
 *   <sha> and <ISO time> are the head and the time of the READY check that passed.
 * Exit 0 = nothing changed since the READY check, merge may go on.
 * Exit 1 = refuse (reasons on stdout). Exit 2 = could not read the PR or bad arguments; also a refusal (fail closed).
 *
 * Why: land-pr.ps1 checked READY and merged with no look in between. A CodeRabbit review (and its outside-diff
 * findings) that landed on the same head in that gap was never read. It refuses when, since the READY check:
 *   - the head SHA changed;
 *   - a CodeRabbit review object, or an edit of the CodeRabbit summary comment, is newer than the READY check. Exception: on a PR
 *     with no review:coderabbit, review:deep or review:deep-held label, the TRUSTED summary that is CodeRabbit's automatic "Review
 *     skipped ... limited based on label configuration" notice (skip marker, live PR 338) is not a change: it raised two false STOPs;
 *   - an "@coderabbitai review" request comment is newer than the newest CodeRabbit review with a body and newer than the
 *     TRUSTED CodeRabbit summary when that summary covers the head and is no notice (a review is in flight). Trusted is the
 *     rule READY uses (trustedCodeRabbitSummary): the comments are read with their edit history (readIssueComments), and a
 *     summary a person or another app edited, or one with no readable edit history, answers nothing;
 *   - the CodeRabbit commit status on the head is pending.
 * -IgnoreReview in land-pr.ps1 skips this script like it skips the READY check.
 * Clock note: READY time is the local clock, review times are GitHub's. land-pr.ps1 backs the READY time off by 120 seconds so a
 * fast local clock cannot hide a review; a skew can still refuse a PR (fail closed).
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { codeRabbitNotice, coderabbitRequestComments, isCodeRabbitUser, latestCodeRabbitSummary, newestCodeRabbitReview, readIssueComments, summaryCoversHead, trustedCodeRabbitSummary } from './review-status.mjs';

const ms = (iso) => Date.parse(iso || '') || 0;
const iso = (t) => new Date(t).toISOString();

// Labels that make CodeRabbit review a PR (the list its own skip notice prints, live PR 338).
const CODERABBIT_LABELS = new Set(['review:coderabbit', 'review:deep', 'review:deep-held']);
const SKIP_MARKER = /<!--\s*This is an auto-generated comment: skip review by coderabbit\.ai\s*-->/;
const SKIP_REASON = /Auto reviews are limited based on label configuration/i;

/**
 * True when the PR was read with labels and none of them asks for CodeRabbit. Unreadable labels give false (fail closed).
 */
function hasNoCodeRabbitLabel(pull) {
  return Array.isArray(pull?.labels) && !pull.labels.some((l) => CODERABBIT_LABELS.has(l?.name));
}

/**
 * True when `summary` is the "Review skipped" notice CodeRabbit posts on its own for a PR with no CodeRabbit label (live PR 338:
 * two land runs stopped on it). It needs the skip marker, the skipped heading and the label reason. Only the trusted summary
 * counts: a person or another app edited it, or no edit history, and it does not.
 */
function isLabelSkipNotice(summary, trusted) {
  const body = String(summary?.body ?? '');
  return trusted === summary && SKIP_MARKER.test(body) && codeRabbitNotice(body) === 'skipped' && SKIP_REASON.test(body);
}

/**
 * Pure decision. { readyHead, readyAt (ISO), pull, reviews, comments, commentEdits, statuses } in, { ok, refusals } out.
 * `pull` is the PR read now; `statuses` are the commit statuses of its current head. `commentEdits` maps a comment id to its
 * edit history (readIssueComments); without it no summary is trusted. `commits` is the PR's commit list, oldest first, as
 * [{ sha }] (readPrCommits): the newest CodeRabbit round is the one on the newest commit, not the latest submitted_at. [] means
 * unreadable: with rounds on two or more commits the order is unknown and it refuses.
 */
export function decideRecheck({ readyHead, readyAt, pull, reviews = [], comments = [], commentEdits, statuses = [], commits = [] }) {
  const refusals = [];
  const readyMs = ms(readyAt);
  const head = pull?.head?.sha;
  if (!readyMs) refusals.push(`READY check time is unreadable (${readyAt})`);
  if (!head) refusals.push('PR head is unreadable');
  else if (head !== readyHead) refusals.push(`head changed since the READY check (${String(readyHead).slice(0, 7)} -> ${head.slice(0, 7)})`);

  const crReviews = reviews.filter((r) => isCodeRabbitUser(r?.user));
  const newestReview = crReviews.reduce((t, r) => Math.max(t, ms(r.submitted_at)), 0);
  if (newestReview > readyMs) refusals.push(`a CodeRabbit review landed after the READY check (${iso(newestReview)}); read it and re-run`);

  const summary = latestCodeRabbitSummary(comments);
  // A request is answered by the newest review with a body, or by a clean summary-only round: the TRUSTED summary covers the
  // head and is no notice (live PR 211 got no review object for its on-demand round, only a summary edit).
  const trusted = trustedCodeRabbitSummary(comments, commentEdits);
  // The automatic skip notice on a PR with no CodeRabbit label is no change of the review state: it never refuses here.
  const summaryIsSkipNotice = hasNoCodeRabbitLabel(pull) && isLabelSkipNotice(summary, trusted);
  const summaryAt = summary && !summaryIsSkipNotice ? ms(summary.updated_at || summary.created_at) : 0;
  if (summaryAt > readyMs) refusals.push(`the CodeRabbit summary comment changed after the READY check (${iso(summaryAt)})`);
  // newestCodeRabbitReview ranks by commit only when the list holds EVERY reviewed commit (ranksFor: all or none), else it
  // falls back to submitted_at. A round on a commit no longer in the PR (amend, rebase) reviewed code that is gone, so it
  // answers no request: drop it, then rank the rest. Dropping a round can only lower answeredAt, so the gate gets stricter.
  const listed = new Set((commits ?? []).map((c) => String(c?.sha ?? '').toLowerCase()));
  const onPr = listed.size ? reviews.filter((r) => listed.has(String(r?.commit_id ?? '').toLowerCase())) : reviews;
  const bodyReview = newestCodeRabbitReview(onPr, commits);
  const roundCommits = new Set(crReviews.filter((r) => String(r.body ?? '').trim() !== '').map((r) => String(r.commit_id ?? '').toLowerCase()));
  if (!listed.size && roundCommits.size >= 2) refusals.push('could not read the PR commit list to order CodeRabbit rounds');
  const coversHead = trusted && !codeRabbitNotice(trusted.body) && summaryCoversHead(trusted.body, head);
  const answeredAt = Math.max(bodyReview ? ms(bodyReview.submitted_at) : 0, coversHead ? ms(trusted.updated_at || trusted.created_at) : 0);
  const open = coderabbitRequestComments(comments).filter((c) => ms(c.created_at) > answeredAt);
  if (open.length) refusals.push(`an "@coderabbitai review" request has no review after it (a review is in flight; asked ${iso(ms(open[0].created_at))})`);

  if (statuses.some((s) => /coderabbit/i.test(s?.context || '') && s.state === 'pending')) refusals.push('the CodeRabbit commit status on the head is pending');
  return { ok: refusals.length === 0, refusals };
}

const flatPages = (pages) => [pages].flat(2);

/** The PR's commits, oldest first, as [{ sha }]. Throws when the read fails or returns no commit (a PR always has one). */
function readCommitList(gh, base, pr) {
  let list;
  try {
    list = flatPages(gh(['--paginate', '--slurp', `${base}/pulls/${pr}/commits?per_page=100`]));
  } catch (err) {
    throw new Error(`the PR commit list is unreadable (${String(err?.message ?? err).split('\n')[0]})`);
  }
  const commits = list.map((c) => ({ sha: String(c?.sha ?? '').toLowerCase() })).filter((c) => /^[0-9a-f]{40}$/.test(c.sha));
  if (!commits.length) throw new Error('the PR commit list is empty');
  return commits;
}

/** Re-read the PR through `gh(args)` (parsed JSON) and decide. Any read error is a refusal. */
export function recheckPr({ pr, repo, head, readyAt }, gh) {
  try {
    const base = `repos/${repo}`;
    const pull = gh([`${base}/pulls/${pr}`]);
    const reviews = flatPages(gh(['--paginate', '--slurp', `${base}/pulls/${pr}/reviews?per_page=100`]));
    // The shared reader READY uses: all REST pages, each comment paired with its GraphQL body and edit history.
    const [owner, name] = repo.split('/');
    const { comments, commentEdits } = readIssueComments(gh, owner, name, pr);
    // The PR's commit order ranks the CodeRabbit rounds (as cr-fix and cr-paid do). Read directly, not through readPrCommits:
    // that helper returns [] on a read error, and a failed read must refuse (fail closed).
    const commits = readCommitList(gh, base, pr);
    // The combined status lists 30 statuses a page: read every page (100 each), so a pending CodeRabbit status on a later page counts.
    const statuses = flatPages(gh(['--paginate', '--slurp', `${base}/commits/${pull.head.sha}/status?per_page=100`])).flatMap((page) => page?.statuses ?? []);
    return decideRecheck({ readyHead: head, readyAt, pull, reviews, comments, commentEdits, statuses, commits });
  } catch (err) {
    return { ok: false, refusals: [`could not re-read PR #${pr}: ${String(err?.message ?? err).split('\n')[0]}`] };
  }
}

/** { pr, head, readyAt, repo } from argv. Throws on a missing or bad value. */
export function parseArgs(argv, defaultRepo = 'Rev4nchist/Continuous-Claude-v3') {
  const o = { pr: null, head: null, readyAt: null, repo: defaultRepo };
  const flags = { '--head': 'head', '--ready-at': 'readyAt', '--repo': 'repo' };
  for (let i = 0; i < argv.length; i += 1) {
    if (flags[argv[i]]) o[flags[argv[i]]] = argv[(i += 1)];
    else if (/^\d+$/.test(argv[i])) o.pr = Number(argv[i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!o.pr) throw new Error('usage: land-recheck.mjs <pr> --head <sha> --ready-at <ISO time> [--repo owner/name]');
  if (!/^[0-9a-f]{40}$/i.test(o.head || '')) throw new Error('--head needs a 40-character sha');
  if (!ms(o.readyAt)) throw new Error('--ready-at needs an ISO time');
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error(`bad --repo: ${o.repo}`);
  return o;
}

function ghApi(apiArgs) {
  const personal = path.join(os.homedir(), '.config', 'gh-personal');
  const dir = process.env.GH_CONFIG_DIR || (existsSync(personal) ? personal : undefined);
  const env = { ...process.env, ...(dir ? { GH_CONFIG_DIR: dir } : {}) };
  return JSON.parse(execFileSync('gh', ['api', ...apiArgs], { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 }));
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (err) { console.error(`land-recheck: ${err.message}`); return 2; }
  const r = recheckPr(o, ghApi);
  r.refusals.forEach((line) => console.log(`  re-check: ${line}`));
  if (r.ok) console.log(`  re-check: PR #${o.pr} is unchanged since the READY check at ${o.readyAt}`);
  return r.ok ? 0 : r.refusals.some((l) => l.startsWith('could not re-read')) ? 2 : 1;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) process.exit(main());
