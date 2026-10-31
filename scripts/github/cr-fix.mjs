#!/usr/bin/env node
/**
 * cr-fix.mjs: a CodeRabbit CLI review of the fix commits of a PR (PR D, Dave 2026-10-30).
 * Why: 6 of the 12 real Majors that CodeRabbit found in round 2 or later were added by a fix commit
 * (.claudedocs/2026-10-30-coderabbit-rereview-study.md). This script reviews only the commits after the newest CodeRabbit
 * PR review of the PR, so a fix is checked once before the READY carry (review-status.mjs) accepts it.
 *
 * Usage: node scripts/github/cr-fix.mjs --pr <N> [--repo owner/name] [--timeout-min N]   (run it in the PR checkout)
 *   1. Reads the PR reviews, issue comments and comment edit history with `gh api`, and takes the same carry source as review-status.mjs
 *      (newestCodeRabbitRound): the newest CodeRabbit review with a body, or a newer clean summary-only round. Its commit is <from>.
 *   2. Runs `cr review --agent --committed --base-commit <from>` in the current checkout. HEAD is <head>.
 *   3. Saves the full output to .claude/cache/e2e/<date>-cr-fix-<head7>.txt.
 *   4. Prints ONE line on stdout when the run finished. Paste it into the PR body:
 *        CLI fix review: <from7>..<head7> <clean|N major|N critical|incomplete>
 *      Critical wins over Major; Minor, Trivial and Info findings still print `clean`. The READY carry reads the line
 *      (parseCliFixReviews in review-status.mjs) and accepts only `clean`.
 *
 * A merge commit in <from>..HEAD (for example a merge of main after the review) puts that code into the CLI review, so a finding in it can
 * block the carry. The run still goes ahead. The merge shas are named on stderr only: the stdout line keeps its exact form, because the carry
 * reads everything after the range as the verdict and accepts only `clean`.
 *
 * It never passes --use-credits or --api-key. Past the hourly CLI allowance the CLI returns awaiting_confirmation or
 * action_required: this script prints the `incomplete` line and the reason on stderr only (nothing to paste) and exits 1. Dave decides about credits
 * (coderabbit-cli.md). pre-pr.mjs keeps its own run count; runs of this script count separately.
 *
 * Exit 0 = the review finished (the line says what it found). 1 = it did not finish. 2 = it could not start (usage, gh error,
 * no earlier CodeRabbit review, nothing after it, the checkout is not the PR head, the earlier review is not an ancestor
 * of HEAD); no CLI run is spent.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeRabbitHeadReview, newestCodeRabbitRound, readIssueComments, readPrCommits } from './review-status.mjs';
import { CR_TIMEOUT_MIN_DEFAULT, CR_TIMEOUT_MIN_FLOOR, defaultCrRunner, parseAgentStream } from './pre-pr.mjs';

const DEFAULT_REPO = 'Rev4nchist/Continuous-Claude-v3';
const FORBIDDEN = /^--(?:use-credits|api-key)\b/;
const MIN = 60_000;
const SHA40 = /^[0-9a-f]{40}$/;

/** The review arguments: only the commits after `from` on the current branch. No billing or key flag, ever. */
export const CR_FIX_ARGS = (from) => ['review', '--agent', '--committed', '--base-commit', from];

/** { pr, repo, timeoutMs } from argv. Throws on a billing or key flag, an unknown flag or a missing PR number. */
export function parseArgs(argv) {
  let pr = null;
  let repo = DEFAULT_REPO;
  let minutes = CR_TIMEOUT_MIN_DEFAULT;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (FORBIDDEN.test(a)) throw new Error(`refused: ${a.split('=')[0]} is never passed (Dave decides about credits)`);
    if (/^\d+$/.test(a)) pr = Number(a);
    else if (a === '--pr') pr = Number(argv[(i += 1)]);
    else if (a === '--repo') repo = String(argv[(i += 1)] ?? '');
    else if (a === '--timeout-min') minutes = Number(argv[(i += 1)]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(pr) || pr <= 0) throw new Error('usage: cr-fix.mjs --pr <N> [--repo owner/name] [--timeout-min N]');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad --repo: ${repo}`);
  // A review needs at least 15 minutes (coderabbit-cli.md); a smaller or unreadable value falls back to the default.
  const ok = Number.isFinite(minutes) && minutes >= CR_TIMEOUT_MIN_FLOOR;
  return { pr, repo, timeoutMs: (ok ? minutes : CR_TIMEOUT_MIN_DEFAULT) * MIN };
}

const incomplete = (reason) => ({ verdict: 'incomplete', reason });
const KNOWN_SEVERITIES = new Set(['critical', 'major', 'minor', 'trivial', 'info', 'none']);

/**
 * The number of finding events with no severity (absent or null). parseAgentStream reads those as `info`, which is a known key, so only this
 * count sees them. An empty, blank or non-string severity is already a `bySeverity` key outside the known set, so it is not counted here too.
 */
function noSeverityCount(text) {
  let n = 0;
  for (const l of String(text ?? '').split(/\r?\n/)) {
    try {
      const o = JSON.parse(l);
      if (o?.type === 'finding' && o.severity == null) n += 1;
    } catch { /* not a JSON line */ }
  }
  return n;
}

/**
 * The verdict of one finished or failed run. Pure. { verdict, reason }: verdict is `clean`, `N major`, `N critical` or
 * `incomplete`; reason is set only for `incomplete`.
 */
export function fixVerdict(p, run) {
  if (run.error) return incomplete(`the CLI did not start (${run.error})`);
  if (p.awaiting) return incomplete(`the CLI ended ${p.awaiting}: the hourly allowance is used up. Dave decides about credits; this script never passes them`);
  if (run.timedOut) return incomplete('the CLI hit the time limit');
  if (run.status !== 0) return incomplete(`the CLI exited with code ${run.status}`);
  const c = p.complete;
  if (p.errors.length > 0 && !c) return incomplete(`the CLI sent an error event (${p.errors[0].errorType ?? 'unknown'})`);
  if (!c) return incomplete('no complete event in the CLI output');
  if (c.status === 'review_skipped') return incomplete('the CLI found no changes to review after the base commit');
  if (c.outcome === 'failed') return incomplete('the CLI review outcome is failed');
  if (Number(c.unreviewedFileCount) > 0) return incomplete(`${Number(c.unreviewedFileCount)} file(s) were not reviewed`);
  // A severity outside the known set, or none at all, counts as Major: the PR review carry reads it the same way.
  const { critical = 0, major = 0 } = p.bySeverity;
  const unknown = Object.entries(p.bySeverity).filter(([k]) => !KNOWN_SEVERITIES.has(k)).reduce((sum, [, n]) => sum + n, 0);
  const total = major + unknown + noSeverityCount(run.stdout);
  if (critical > 0) return { verdict: `${critical} critical`, reason: null };
  if (total > 0) return { verdict: `${total} major`, reason: null };
  return { verdict: 'clean', reason: null };
}

const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const stop = (reason) => ({ line: null, exitCode: 2, reason, outFile: null, from: null, head: null, verdict: null });

/** { reviews, comments, commentEdits }: the three inputs of newestCodeRabbitRound. Throws when a read fails. */
function readSource(pr, repo, deps) {
  const [owner, name] = repo.split('/');
  const reviews = [deps.gh(['--paginate', '--slurp', `repos/${repo}/pulls/${pr}/reviews?per_page=100`])].flat(2);
  // The issue comments with their edit history: every page, through the reader review-status.mjs uses (the summary is trusted only with it).
  // `commits` orders the rounds by the reviewed commit, as review-status.mjs does, so both name the same carry source.
  return { reviews, commits: readPrCommits(deps.gh, owner, name, pr), ...readIssueComments(deps.gh, owner, name, pr) };
}

/** The carry source's commit (the same round review-status.mjs reads) and the checkout head, or a stop result. No CLI run has been spent yet. */
function readRange(pr, repo, cwd, deps) {
  let head;
  let source;
  try {
    head = String(deps.headSha(cwd) ?? '').trim().toLowerCase();
    source = readSource(pr, repo, deps);
  } catch (err) {
    return { stop: stop(`could not read the PR or the checkout (${String(err.message).split('\n')[0]})`) };
  }
  if (!SHA40.test(head)) return { stop: stop('the checkout head is not a commit sha') };
  // The head has a CodeRabbit review (the PR #211 shape: an older review object plus a trusted clean summary of the head). No fix range is left.
  if (codeRabbitHeadReview({ head, ...source }).reviewedHead) return { stop: stop('CodeRabbit already reviewed the head; no CLI run needed') };
  const newest = newestCodeRabbitRound({ ...source, head });
  if (!newest) return { stop: stop('the PR has no CodeRabbit review (or clean summary round) to start from') };
  const from = String(newest.commit_id ?? '').toLowerCase();
  if (!SHA40.test(from)) return { stop: stop('the newest CodeRabbit round names no commit') };
  if (from === head) return { stop: stop('the newest CodeRabbit review is of the head: there is no fix commit to review') };
  return { from, head };
}

/** A stop result when the checkout is not the PR head or `from` is not behind HEAD. No CLI run has been spent yet. */
function checkCheckout({ pr, repo, cwd, from, head }, deps) {
  let prHead;
  try {
    prHead = String(deps.gh([`repos/${repo}/pulls/${pr}`])?.head?.sha ?? '').trim().toLowerCase();
  } catch (err) {
    return stop(`could not read the PR head (${String(err.message).split('\n')[0]})`);
  }
  if (prHead !== head) return stop(`the checkout head ${head.slice(0, 7)} is not the PR head ${prHead.slice(0, 7) || '(unreadable)'}: check out the PR branch and pull`);
  if (!deps.isAncestor(cwd, from)) return stop(`the reviewed commit ${from.slice(0, 7)} is not an ancestor of HEAD (fetch it, or the branch was force-pushed)`);
  return null;
}

/** The merge commit shas in <from>..HEAD, or null when git could not list them. Never stops the run. */
function safeMerges(deps, cwd, from) {
  try { return deps.mergesIn(cwd, from); } catch { return null; }
}

/** Saves the CLI output. A failed save is returned as text; the line is still printed. */
function save(file, text, deps) {
  try { deps.writeOut(file, text); return null; } catch (err) { return String(err.message); }
}

/**
 * Reviews the commits after the newest CodeRabbit review. deps (for tests): gh(args) -> JSON, headSha(cwd), runCr(spec),
 * writeOut(file, text), now. Returns { line, exitCode, reason, outFile, from, head, verdict }.
 */
export async function crFix({ pr, repo = DEFAULT_REPO, cwd, timeoutMs = CR_TIMEOUT_MIN_DEFAULT * MIN }, deps = {}) {
  const d = { gh: ghApi, headSha: gitHead, isAncestor: gitIsAncestor, mergesIn: gitMergesIn, runCr: defaultCrRunner, writeOut: writeText, now: new Date(), ...deps };
  const range = readRange(pr, repo, cwd, d);
  if (range.stop) return range.stop;
  const { from, head } = range;
  const bad = checkCheckout({ pr, repo, cwd, from, head }, d);
  if (bad) return bad;
  const merges = safeMerges(d, cwd, from);
  const run = await d.runCr({ cwd, args: CR_FIX_ARGS(from), timeoutMs });
  const stdout = String(run.stdout ?? '');
  const outFile = path.join(cwd, '.claude', 'cache', 'e2e', `${dayOf(d.now)}-cr-fix-${head.slice(0, 7)}.txt`);
  const saveError = save(outFile, run.stderr ? `${stdout}\n# stderr\n${run.stderr}\n` : stdout, d);
  const { verdict, reason } = fixVerdict(parseAgentStream(stdout), run);
  const line = `CLI fix review: ${from.slice(0, 7)}..${head.slice(0, 7)} ${verdict}`;
  const note = saveError ? `the output could not be saved (${saveError})` : null;
  return { line, exitCode: verdict === 'incomplete' ? 1 : 0, reason: [reason, note].filter(Boolean).join('; ') || null, outFile, from, head, verdict, merges };
}

// ---- real gh, git and file calls ----
export function ghApi(apiArgs) {
  const personal = path.join(os.homedir(), '.config', 'gh-personal');
  const dir = process.env.GH_CONFIG_DIR || (existsSync(personal) ? personal : undefined);
  const env = { ...process.env, ...(dir ? { GH_CONFIG_DIR: dir } : {}) };
  return JSON.parse(execFileSync('gh', ['api', ...apiArgs], { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 }));
}

function gitHead(cwd) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git rev-parse HEAD failed: ${String(r.stderr).trim()}`);
  return r.stdout.trim();
}

function gitIsAncestor(cwd, from) {
  return spawnSync('git', ['merge-base', '--is-ancestor', from, 'HEAD'], { cwd, windowsHide: true }).status === 0;
}

/** The merge commit shas in <from>..HEAD, newest first. Throws when git fails. */
export function gitMergesIn(cwd, from) {
  const r = spawnSync('git', ['rev-list', '--merges', `${from}..HEAD`], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git rev-list --merges failed: ${String(r.stderr).trim()}`);
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function writeText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** What main() prints. { out, err }: stdout lines and stderr lines. Only a finished run puts its line on stdout. */
export function reportOf(r) {
  const out = [];
  const err = [];
  if (r.line) (r.verdict === 'incomplete' ? err : out).push(r.line);
  if (r.reason) err.push(`cr-fix: ${r.exitCode === 0 ? 'note' : r.line ? 'incomplete' : 'stopped'}: ${r.reason}`);
  if (r.merges === null) err.push('cr-fix: note: could not check the range for merge commits');
  else if (r.merges?.length > 0) {
    const shas = r.merges.map((m) => m.slice(0, 7)).join(', ');
    err.push(`cr-fix: note: the range holds ${r.merges.length} merge commit(s): ${shas}. Code merged in (for example main) is part of this review; a finding there is not from the fix commits`);
  }
  if (r.outFile) err.push(`cr-fix: full output: ${r.outFile}`);
  return { out, err };
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(`cr-fix: ${err.message}`); process.exit(2); }
  const cwd = process.cwd();
  console.error(`cr-fix: reviewing the fix commits of PR #${opts.pr} with the CodeRabbit CLI (takes several minutes)`);
  const r = await crFix({ ...opts, cwd });
  const { out, err } = reportOf(r);
  for (const l of out) console.log(l);
  for (const l of err) console.error(l);
  process.exit(r.exitCode);
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) {
  main().catch((err) => { console.error(`cr-fix: ${String(err?.message).split('\n')[0]}`); process.exit(2); });
}
