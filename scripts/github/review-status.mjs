#!/usr/bin/env node
/**
 * review-status.mjs — is this PR safe to call "ready to merge"? Read-only. Reviewer: Greptile.
 *
 * Answers the question the PR review loop rule (pr-review-loop.md) asks, for the PR's CURRENT
 * head commit:
 *   - reviewed:   a check run from the Greptile GitHub App on the head SHA ended "success".
 *                 The app identity is the trust anchor: only Greptile can create that run.
 *                 A superseded review ends "neutral" ("Review was cancelled"): NOT a review.
 *   - summary:    Greptile writes a block into the PR body with the last reviewed commit and a
 *                 confidence score. People with write access can also edit the body, so the block
 *                 counts only when every body edit after Greptile's newest one came from an app
 *                 (GitHub Bot). Otherwise the review is UNAVAILABLE until Greptile rewrites it.
 *                 A usable summary names the head and has a score; anything else is UNAVAILABLE.
 *   - unresolved: review threads still open from any reviewer, from GraphQL isResolved
 *   - checks:     every other status and check run on the head SHA
 *   - mergeable:  GitHub's mergeable_state
 * ready = reviewed && confidence >= 4 && unresolved == 0 && checks green && mergeable "clean".
 *
 * CodeRabbit was uninstalled from this repo on 2026-10-09 (proposal 2026-10-09-greptile.md, decision
 * D2). A leftover CodeRabbit commit status on an older PR neither blocks nor grants READY; any review
 * thread, from any reviewer, still counts as unresolved.
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

export function evaluate({ pull, combined, checkRuns, threads, bodyEdits }) {
  const head = pull.head.sha;
  const run = latestGreptileRun(checkRuns);
  let greptile;
  if (!run) greptile = 'absent';
  else if (run.status !== 'completed') greptile = 'pending';
  else if (run.conclusion === 'success') greptile = 'reviewed';
  else greptile = 'unavailable';
  const greptileSummary = run?.output?.summary ?? null;

  const summary = parseSummary(pull.body);
  // reviewedHead needs the check run (check-only state stays in `greptile`) AND a usable summary.
  // After a passed check, any summary problem is UNAVAILABLE with its own reason: one @greptileai
  // comment makes Greptile rewrite the block.
  let summaryProblem = null;
  if (greptile === 'reviewed') {
    const editor = bodyEditedAfterGreptile(bodyEdits);
    if (!summary.present) summaryProblem = 'Greptile summary block is missing from the PR body (was the PR body overwritten?)';
    else if (editor) summaryProblem = `PR body was edited by ${editor} after Greptile's summary, so its score cannot be confirmed`;
    else if (summary.sha !== head) summaryProblem = `Greptile summary names ${summary.sha ? `commit ${summary.sha.slice(0, 7)}` : 'no commit'}, not the head`;
    else if (summary.confidence === null) summaryProblem = 'Greptile summary has no confidence score';
  }
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
  return {
    pr: pull.number, head, headShort: head.slice(0, 7), branch: pull.head.ref, reviewer: 'greptile',
    greptile, greptileSummary, confidence: reviewedHead ? summary.confidence : null, lowConfidence,
    reviewed: reviewedHead, reviewedHead, unavailable,
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
    const q = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}} userContentEdits(first:20){nodes{editor{__typename login}}}}}}';
    const g = gh(['graphql', '-f', `query=${q}`, '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${pr}`]);
    const prq = g.data.repository.pullRequest;
    const rt = prq.reviewThreads;
    if (rt.pageInfo.hasNextPage) throw new Error('more than 100 review threads');
    result = evaluate({ pull, combined, checkRuns, threads: rt.nodes, bodyEdits: prq.userContentEdits.nodes });
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
