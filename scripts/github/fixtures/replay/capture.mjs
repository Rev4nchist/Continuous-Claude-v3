#!/usr/bin/env node
/**
 * Capture one PR as a replay fixture for review-status.test.mjs. READ-ONLY: every call is a `gh api` GET or a GraphQL query.
 * Usage: node scripts/github/fixtures/replay/capture.mjs <pr-number> [--repo owner/name]
 * Writes scripts/github/fixtures/replay/pr<N>.json: the inputs evaluate() takes (see readLiveInputs in review-status.mjs),
 * plus `carry` (the four reads of readCarry). Only the `patch` text of files and `_links` are dropped; no test reads them.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readIssueComments, newestCodeRabbitRound } from '../../review-status.mjs';

const args = process.argv.slice(2);
const pr = Number(args.find((a) => /^\d+$/.test(a)));
const repoArg = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : 'Rev4nchist/Continuous-Claude-v3';
const [owner, name] = repoArg.split('/');
if (!pr) { console.error('usage: capture.mjs <pr-number> [--repo owner/name]'); process.exit(2); }

const gh = (a) => JSON.parse(execFileSync('gh', ['api', ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const attempt = (fn) => { try { return fn(); } catch { return null; } };
const slim = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'patch' || k === '_links' ? undefined : x)));
const repoPath = `repos/${owner}/${name}`;

const pull = gh([`${repoPath}/pulls/${pr}`]);
for (const side of ['head', 'base']) delete pull[side].repo;
const head = pull.head.sha;
const combined = gh([`${repoPath}/commits/${head}/status?per_page=100`]);
const checkRuns = gh([`${repoPath}/commits/${head}/check-runs?per_page=100`]).check_runs;
const q = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved}} userContentEdits(first:20){nodes{editor{__typename login}}} commits(last:1){nodes{commit{oid committedDate}}} allCommits: commits(first:100){totalCount nodes{commit{oid author{user{login}} signature{isValid wasSignedByGitHub}}}}}}}';
const g = gh(['graphql', '-f', `query=${q}`, '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${pr}`]).data.repository.pullRequest;
const { comments, commentEdits } = readIssueComments(gh, owner, name, pr);
const reviews = gh(['--paginate', '--slurp', `${repoPath}/pulls/${pr}/reviews?per_page=100`]).flat();
const headCommit = g.commits.nodes[0]?.commit;
// Same shape as readLiveInputs: oldest first, `sha` added for the round order. More than 100 commits = unknown ([]).
const commits = g.allCommits.totalCount > g.allCommits.nodes.length ? [] : g.allCommits.nodes.map((n) => ({
  sha: n.commit.oid, author: n.commit.author?.user?.login ?? null, githubSigned: n.commit.signature?.isValid === true && n.commit.signature?.wasSignedByGitHub === true,
}));

const newest = newestCodeRabbitRound({ reviews, comments, commentEdits, head });
let carry = null;
if (newest?.commit_id && (newest.id || newest.summaryOnly)) {
  const files = attempt(() => gh(['--paginate', '--slurp', `${repoPath}/pulls/${pr}/files?per_page=100`]).flat());
  carry = {
    reviewComments: newest.summaryOnly ? [] : attempt(() => gh(['--paginate', '--slurp', `${repoPath}/pulls/${pr}/reviews/${newest.id}/comments?per_page=100`]).flat()),
    compare: attempt(() => gh([`${repoPath}/compare/${newest.commit_id}...${head}`])),
    prFiles: files && files.length === pull.changed_files ? files : null,
    config: attempt(() => JSON.parse(Buffer.from(gh([`${repoPath}/contents/review-router.config.json?ref=${encodeURIComponent(pull.base.ref)}`]).content ?? '', 'base64').toString('utf8'))),
  };
}
const out = slim({
  pull, combined, checkRuns, threads: g.reviewThreads.nodes, bodyEdits: g.userContentEdits.nodes, reviews, comments, commentEdits,
  headCommittedAt: headCommit?.oid === head ? headCommit.committedDate : undefined, greptileAuto: true, commits, proofGate: false, carry,
});
const file = fileURLToPath(new URL(`./pr${pr}.json`, import.meta.url));
writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(`pr${pr}: head ${head.slice(0, 7)} reviews ${reviews.length} comments ${comments.length} carry ${carry ? 'read' : 'none'} -> ${file}`);
