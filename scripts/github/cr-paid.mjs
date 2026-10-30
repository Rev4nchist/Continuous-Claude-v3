#!/usr/bin/env node
/**
 * cr-paid.mjs: the cap check for a paid CodeRabbit PR review (Dave's policy, 2026-10-30).
 *
 * Usage:
 *   node scripts/github/cr-paid.mjs check --pr <N> [--json]     estimate the round, print ALLOW or ESCALATE
 *   node scripts/github/cr-paid.mjs record --pr <N> --head <sha> --files <K>   log a paid round you just posted
 *   node scripts/github/cr-paid.mjs today [--json]               today's paid total and rows
 *
 * Billing: $0.25 per reviewed file. Round 1 bills every reviewable PR file. A later round bills the files changed since the last
 * reviewed commit (the compare API). Accepted limit: billing exclusion by .coderabbit.yaml path_filters is unproven. The estimate
 * applies the filters (so a filtered file is not counted) and prints the unfiltered count next to it.
 *
 * ALLOW (exit 0): round cost <= $5, today + round <= $15 (America/Chicago date, one ledger for all sessions), fewer than 2 paid
 * rounds on this PR, and for round 2 or later a fix of 30 lines or fewer that adds no file. It prints the comment to post:
 * "@coderabbitai review --use-credits". ESCALATE (exit 3): one reason line per failed limit; stop and ask Dave. Exit 2: a read error
 * or a bad ledger line; no verdict (fail closed). The head already holds a CodeRabbit review: exit 2, since a round would buy nothing.
 *
 * It does NOT check conditions 1, 2, 3 and 6 of the policy (READY needs a review and no carry; the PR round budget; the next included
 * slot is over 15 minutes away; every finding of the last round is fixed). The rule text (pr-review-loop.md "Paid PR reviews")
 * and pr_watch cover them. Run the check before EVERY review request: in Automatic mode an over-limit review bills with no prompt.
 *
 * Ledger: ~/.claude/state/coderabbit-paid.jsonl, one JSON line per paid round: {ts, date, pr, head, files, cost, session}.
 */
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeRabbitHeadReview, deltaLinesOf, isCodeRabbitUser, newestCodeRabbitRound, readIssueComments } from './review-status.mjs';
import { pathFiltersFrom, reviewableFiles } from './pr-checkpoint.mjs';
import { ghApi } from './cr-fix.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = 'Rev4nchist/Continuous-Claude-v3';
const DEFAULT_LEDGER = path.join(os.homedir(), '.claude', 'state', 'coderabbit-paid.jsonl');
const SHA40 = /^[0-9a-f]{40}$/;
const CENTS_PER_FILE = 25;
export const LIMITS = Object.freeze({ roundCents: 500, dayCents: 1500, paidRounds: 2, fixLines: 30 });
export const PAID_COMMENT = '@coderabbitai review --use-credits';

const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

/** The Chicago calendar day of a Date, as YYYY-MM-DD. */
export function chicagoDay(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** The path_filters of the live .coderabbit.yaml (repo root). */
export const liveFilters = () => pathFiltersFrom(readFileSync(path.join(HERE, '..', '..', '.coderabbit.yaml'), 'utf8'));
export const billable = reviewableFiles;

// ---- ledger ----
function parseRow(line, n) {
  let r;
  try { r = JSON.parse(line); } catch { throw new Error(`ledger line ${n} is not JSON`); }
  const ok = Number.isInteger(r?.pr) && /^\d{4}-\d{2}-\d{2}$/.test(r.date ?? '') && Number.isFinite(r.cost) && r.cost >= 0;
  if (!ok) throw new Error(`ledger line ${n} lacks a whole pr, a date or a cost`);
  return r;
}

/** Every ledger row. A missing file is an empty ledger. Throws on any other read error or any bad line. */
export function readLedger(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  return text.split(/\r?\n/).map((l, i) => [l, i + 1]).filter(([l]) => l.trim() !== '').map(([l, n]) => parseRow(l, n));
}

const centsOf = (rows) => rows.reduce((sum, r) => sum + Math.round(r.cost * 100), 0);

/** { date, total, rows }: the paid rows of the Chicago day of now. Throws on a bad ledger. */
export function todayOf(deps) {
  const d = withDefaults(deps);
  const date = chicagoDay(d.now());
  const rows = readLedger(d.ledgerPath).filter((r) => r.date === date);
  return { date, total: centsOf(rows) / 100, rows };
}

/** Appends one paid round to the ledger and returns the row. Throws on a bad head or file count. */
export function recordPaid({ pr, head, files }, deps) {
  const d = withDefaults(deps);
  if (!/^[0-9a-f]{7,40}$/i.test(String(head))) throw new Error('--head must be a commit sha');
  if (!Number.isInteger(files) || files < 0) throw new Error('--files must be a whole number, 0 or more');
  const now = d.now();
  const row = { ts: now.toISOString(), date: chicagoDay(now), pr, head: String(head).toLowerCase(), files, cost: (files * CENTS_PER_FILE) / 100, session: d.env.CLAUDE_SESSION_ID || 'unknown' };
  mkdirSync(path.dirname(d.ledgerPath), { recursive: true });
  appendFileSync(d.ledgerPath, `${JSON.stringify(row)}\n`);
  return row;
}

// ---- the estimate ----
const readList = (gh, apiPath) => [gh(['--paginate', '--slurp', apiPath])].flat(2);

function readFacts(pr, repo, gh) {
  const [owner, name] = repo.split('/');
  const head = String(gh([`repos/${repo}/pulls/${pr}`])?.head?.sha ?? '').toLowerCase();
  if (!SHA40.test(head)) throw new Error('the PR head is not a commit sha');
  const reviews = readList(gh, `repos/${repo}/pulls/${pr}/reviews?per_page=100`);
  const prFiles = readList(gh, `repos/${repo}/pulls/${pr}/files?per_page=100`);
  return { head, reviews, prFiles, ...readIssueComments(gh, owner, name, pr) };
}

/** The fix since the last reviewed commit: { lines, added }. Throws when the compare cannot be sized. */
function fixOf(compare, prFiles) {
  const lines = deltaLinesOf(compare, prFiles);
  if (lines === null) throw new Error('the fix size could not be read (the compare is missing, full or malformed)');
  const own = new Set(prFiles.map((f) => f.filename));
  return { lines, added: compare.files.filter((f) => f.status === 'added' && own.has(f.filename)).length };
}

/**
 * The reviewed CodeRabbit rounds so far, as newestCodeRabbitRound sees them: one per commit named by a bot review with a body
 * (an empty body is a thread reply), plus the summary-only round when that is the newest. A request still unanswered counts none.
 */
function reviewedRounds(facts, newest) {
  const bot = (facts.reviews ?? []).filter((r) => isCodeRabbitUser(r?.user) && String(r.body ?? '').trim() !== '');
  return new Set(bot.map((r) => r.commit_id)).size + (newest.summaryOnly ? 1 : 0);
}

/** { round, from, head, list, fix }: the files this round bills and, for round 2 or later, the fix size. */
function estimate(facts, repo, gh) {
  if (codeRabbitHeadReview(facts).reviewedHead) throw new Error('CodeRabbit already reviewed the head; a round would buy nothing');
  const newest = newestCodeRabbitRound(facts);
  if (!newest) return { round: 1, from: null, head: facts.head, list: facts.prFiles, fix: null };
  const from = String(newest.commit_id ?? '').toLowerCase();
  if (!SHA40.test(from)) throw new Error('the newest CodeRabbit round names no commit');
  const compare = gh([`repos/${repo}/compare/${from}...${facts.head}`]);
  return { round: reviewedRounds(facts, newest) + 1, from, head: facts.head, list: compare.files ?? [], fix: fixOf(compare, facts.prFiles) };
}

// ---- the verdict ----
function fixReasons(fix) {
  const reasons = [];
  if (fix.lines > LIMITS.fixLines) reasons.push(`the fix is ${fix.lines} lines, over ${LIMITS.fixLines}`);
  if (fix.added > 0) reasons.push(`the fix adds ${fix.added} file(s)`);
  return reasons;
}

/** One reason line per failed limit. [] means ALLOW. Pure. */
export function verdictReasons({ costCents, todayCents, paidRounds, fix }) {
  const reasons = [];
  if (costCents > LIMITS.roundCents) reasons.push(`round cost ${usd(costCents)} is over ${usd(LIMITS.roundCents)}`);
  if (todayCents + costCents > LIMITS.dayCents) reasons.push(`today ${usd(todayCents)} + round ${usd(costCents)} is over ${usd(LIMITS.dayCents)}`);
  if (paidRounds >= LIMITS.paidRounds) reasons.push(`${paidRounds} paid rounds on this PR already; a third round needs Dave`);
  return fix ? [...reasons, ...fixReasons(fix)] : reasons;
}

function decide(pr, est, ledger, now, filters) {
  const date = chicagoDay(now);
  const files = billable(est.list, filters).length;
  const costCents = files * CENTS_PER_FILE;
  const todayCents = centsOf(ledger.filter((r) => r.date === date));
  const paidRounds = ledger.filter((r) => r.pr === pr).length;
  const reasons = verdictReasons({ costCents, todayCents, paidRounds, fix: est.fix });
  const allow = reasons.length === 0;
  return {
    exitCode: allow ? 0 : 3, verdict: allow ? 'ALLOW' : 'ESCALATE', pr, head: est.head, round: est.round, from: est.from,
    files, total: est.list.length, cost: costCents / 100, today: todayCents / 100, paidRounds, fix: est.fix, reasons,
    comment: allow ? PAID_COMMENT : null,
  };
}

const withDefaults = (deps = {}) => ({ gh: ghApi, now: () => new Date(), ledgerPath: DEFAULT_LEDGER, pathFilters: liveFilters, env: process.env, ...deps });

/** Estimates the next round of a PR and gives the verdict. Never throws: a read error is { exitCode: 2, verdict: null, reason }. */
export function checkPr({ pr, repo = DEFAULT_REPO }, deps) {
  const d = withDefaults(deps);
  try {
    const filters = d.pathFilters();
    const est = estimate(readFacts(pr, repo, d.gh), repo, d.gh);
    return decide(pr, est, readLedger(d.ledgerPath), d.now(), filters);
  } catch (err) {
    return { exitCode: 2, verdict: null, pr, reason: firstLine(err) };
  }
}

// ---- output ----
/** { out, err }: the lines main() prints for a check result. */
export function reportOf(r) {
  if (r.exitCode === 2) return { out: [], err: [`cr-paid: stopped, no verdict: ${r.reason}`] };
  const shape = `PR #${r.pr}: round ${r.round}, ${r.files} billable file(s) at $0.25 = ${usd(r.cost * 100)}. Reviewable ${r.files} of ${r.total} files (path_filters exclusion from billing is unproven).`;
  const day = `Paid today ${usd(r.today * 100)}; paid rounds on this PR ${r.paidRounds} of ${LIMITS.paidRounds}.`;
  if (r.verdict === 'ESCALATE') return { out: [`ESCALATE ${shape}`, day, ...r.reasons.map((x) => `- ${x}`), 'Stop. Ask Dave. Do not post a paid review.'], err: [] };
  const record = `node scripts/github/cr-paid.mjs record --pr ${r.pr} --head ${r.head} --files ${r.files}`;
  return { out: [`ALLOW ${shape}`, day, 'Post exactly this comment:', r.comment, 'Then run:', record], err: [] };
}

// ---- command line ----
const COMMANDS = ['check', 'record', 'today'];
const VALUE_FLAGS = { '--pr': 'pr', '--head': 'head', '--files': 'files', '--repo': 'repo' };
const USAGE_LINE = 'usage: cr-paid.mjs check --pr <N> [--json] | record --pr <N> --head <sha> --files <K> | today [--json] | --help';
const toInt = (v, flag) => {
  if (!/^\d+$/.test(String(v ?? '')) || Number(v) === 0 && flag === '--pr') throw new Error(`${flag} needs a whole number${flag === '--pr' ? ' above 0' : ''}`);
  return Number(v);
};

/** { cmd, pr, json, head, files, repo } from argv. Throws on a bad subcommand, flag or number. */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!COMMANDS.includes(cmd)) throw new Error(USAGE_LINE);
  const o = { cmd, pr: null, json: false, head: null, files: null, repo: DEFAULT_REPO };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--json') o.json = true;
    else if (VALUE_FLAGS[rest[i]]) o[VALUE_FLAGS[rest[i]]] = rest[(i += 1)];
    else throw new Error(`unknown argument: ${rest[i]}`);
  }
  if (cmd !== 'today') o.pr = toInt(o.pr, '--pr');
  if (o.files !== null || cmd === 'record') o.files = toInt(o.files, '--files');
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error(`bad --repo: ${o.repo}`);
  return o;
}

const print = (lines, stream) => lines.forEach((l) => stream(l));

function runCheck(o) {
  const r = checkPr(o);
  if (o.json) console.log(JSON.stringify(r));
  else { const { out, err } = reportOf(r); print(out, console.log); print(err, console.error); }
  return r.exitCode;
}

function runToday(o) {
  const t = todayOf();
  if (o.json) console.log(JSON.stringify(t));
  else print([`Paid today (${t.date}, America/Chicago): ${usd(t.total * 100)} in ${t.rows.length} round(s)`, ...t.rows.map((r) => `PR #${r.pr} ${r.head.slice(0, 7)} ${r.files} file(s) ${usd(r.cost * 100)} ${r.ts} ${r.session}`)], console.log);
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, '')); return 0; }
  try {
    const o = parseArgs(argv);
    if (o.cmd === 'check') return runCheck(o);
    if (o.cmd === 'today') return runToday(o);
    console.log(JSON.stringify(recordPaid(o)));
    return 0;
  } catch (err) { console.error(`cr-paid: ${firstLine(err)}`); return 2; }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) process.exit(main());
