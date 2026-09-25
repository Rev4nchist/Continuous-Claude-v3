#!/usr/bin/env node
/**
 * coderabbit-status.mjs — is this PR safe to call "ready to merge"? Read-only.
 *
 * Answers the question the CodeRabbit loop rule asks, for the PR's CURRENT head commit:
 *   - reviewed:   the "CodeRabbit" commit status on the head SHA is success (a push resets it
 *                 to pending, so "no review in progress" alone proves nothing; a merge was once
 *                 called safe 92 s before CodeRabbit found a real defect — Opus 5.5 eval, P26)
 *   - unresolved: review threads still open, from GraphQL isResolved (never from bot text)
 *   - checks:     every other status/check-run on the head SHA
 *   - mergeable:  GitHub's mergeable_state
 * ready = reviewed && unresolved == 0 && checks all green && mergeable_state == "clean".
 *
 * Usage: node scripts/github/coderabbit-status.mjs <pr-number> [--repo owner/name] [--json]
 * Exit 0 = ready, 1 = not ready (reasons listed), 2 = could not determine.
 * Uses `gh api`; set GH_CONFIG_DIR for the repo's account (default: ~/.config/gh-personal).
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const pr = Number(args.find((a) => /^\d+$/.test(a)));
const repo = opt('--repo', 'Rev4nchist/Continuous-Claude-v3');
const [owner, name] = repo.split('/');
const env = { ...process.env, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || path.join(os.homedir(), '.config', 'gh-personal') };

function gh(apiArgs) {
  return JSON.parse(execFileSync('gh', ['api', ...apiArgs], { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 }));
}

// The CodeRabbit GitHub App, exactly. A substring match would trust a lookalike account such as
// "coderabbit-helper" that posts a head-matching range (CodeRabbit #65). App logins end in "[bot]",
// which a user account cannot register.
const CODERABBIT_LOGIN = 'coderabbitai[bot]';
const isCodeRabbit = (u) => u?.login === CODERABBIT_LOGIN && u?.type === 'Bot';

// Proof from CodeRabbit's summary comment that the head commit was reviewed. A clean review
// posts no review object, only this edited comment (PR #64, 2026-09-24). Two head-bound forms:
//   - "Reviewing files that changed ... between <base> and <head>" (updated on each incremental review)
//   - <!-- final_review_risk_coverage:{..."coveredCommitId":"<head>","kind":"reviewed"} -->
// A later push that CodeRabbit has not reviewed leaves both pointing at an older SHA.
// Exception (PR #65, 2026-09-25): when the review limit is reached, the summary still shows a range
// ending at the unreviewed head, inside the "Review limit reached" warning. So the range counts only
// when no limit warning is present. The marker is not moved by a skipped review, so it still counts.
const LIMIT_WARNING = /Review limit reached/i;
export function summaryCoversHead(body, head) {
  const text = String(body);
  if (!LIMIT_WARNING.test(text)) {
    for (const m of text.matchAll(/between\s+[0-9a-f]{40}\s+and\s+([0-9a-f]{40})/g)) if (m[1] === head) return true;
  }
  for (const m of text.matchAll(/final_review_risk_coverage:(\{[^}]*\})/g)) {
    try { const c = JSON.parse(m[1]); if (c.coveredCommitId === head && c.kind === 'reviewed') return true; } catch { /* not a marker */ }
  }
  return false;
}

export function evaluate({ pull, combined, checkRuns, threads, reviews = [], comments = [] }) {
  const head = pull.head.sha;
  const cr = (combined.statuses || []).find((s) => /coderabbit/i.test(s.context));
  // A green "CodeRabbit" status is NOT proof of review: when CodeRabbit hits its review limit
  // it still reports success and posts "Review limit reached" (seen on PR #48, 2026-09-23).
  // Proof is a CodeRabbit review object on the head SHA, or its summary comment naming the head.
  // A review object counts only when it carries review content: CodeRabbit's reply to a thread also
  // creates a "review" on the current head, with an empty body (PR #65, 2026-09-25).
  const reviewedHead = reviews.some((r) => isCodeRabbit(r.user) && r.commit_id === head && /Actionable comments posted:\s*\d+/.test(r.body || ''))
    || comments.some((c) => isCodeRabbit(c.user) && summaryCoversHead(c.body, head));
  const otherStatuses = (combined.statuses || []).filter((s) => !/coderabbit/i.test(s.context));
  const badStatuses = otherStatuses.filter((s) => s.state !== 'success');
  const badRuns = (checkRuns || []).filter((c) => c.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(c.conclusion));
  const unresolved = threads.filter((t) => !t.isResolved).length;
  const reasons = [];
  if (pull.merged) reasons.push('already merged');
  if (pull.state !== 'open') reasons.push(`PR is ${pull.state}`);
  if (!cr) reasons.push('no CodeRabbit status on the head commit (not reviewed yet, or the app is not installed)');
  else if (cr.state !== 'success') reasons.push(`CodeRabbit status on the head commit is "${cr.state}" (review pending for the latest push)`);
  if (!reviewedHead) reasons.push('no CodeRabbit review of the head commit (pending, or skipped by the review limit; never buy the on-demand review)');
  if (unresolved > 0) reasons.push(`${unresolved} review thread(s) unresolved`);
  for (const s of badStatuses) reasons.push(`status "${s.context}" is ${s.state}`);
  for (const c of badRuns) reasons.push(`check "${c.name}" is ${c.status}/${c.conclusion}`);
  if (pull.mergeable_state && pull.mergeable_state !== 'clean') reasons.push(`mergeable_state is "${pull.mergeable_state}"`);
  return {
    pr: pull.number, head, headShort: head.slice(0, 7), branch: pull.head.ref,
    reviewed: Boolean(cr && cr.state === 'success' && reviewedHead), coderabbit: cr ? cr.state : 'absent', reviewedHead,
    unresolved, totalThreads: threads.length, mergeable_state: pull.mergeable_state,
    ready: reasons.length === 0, reasons,
  };
}

function main() {
  if (!pr) { console.error('usage: coderabbit-status.mjs <pr-number> [--repo owner/name] [--json]'); process.exit(2); }
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
    const q = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}}}}';
    const g = gh(['graphql', '-f', `query=${q}`, '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${pr}`]);
    const rt = g.data.repository.pullRequest.reviewThreads;
    if (rt.pageInfo.hasNextPage) throw new Error('more than 100 review threads');
    const threads = rt.nodes;
    // Reviews come oldest first, so the head review can sit past page one: read every page.
    const reviews = gh(['--paginate', '--slurp', `repos/${owner}/${name}/pulls/${pr}/reviews?per_page=100`]).flat();
    const comments = gh(['--paginate', '--slurp', `repos/${owner}/${name}/issues/${pr}/comments?per_page=100`]).flat();
    result = evaluate({ pull, combined, checkRuns, threads, reviews, comments });
  } catch (err) {
    console.error(`coderabbit-status: could not determine (${String(err.message).split('\n')[0]})`);
    process.exit(2);
  }
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else {
    console.log(`PR #${result.pr} head ${result.headShort} (${result.branch}): ${result.ready ? 'READY' : 'NOT READY'}`);
    console.log(`  CodeRabbit status: ${result.coderabbit} | review of head: ${result.reviewedHead ? 'yes' : 'NO'} | unresolved threads: ${result.unresolved}/${result.totalThreads} | mergeable: ${result.mergeable_state}`);
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
