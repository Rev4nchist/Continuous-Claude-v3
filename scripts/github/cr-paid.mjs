#!/usr/bin/env node
/**
 * cr-paid.mjs: the cap check for a paid CodeRabbit PR review (Dave's policy, 2026-10-30).
 *
 * Usage:
 *   node scripts/github/cr-paid.mjs check --pr <N> [--json]     estimate the round, print ALLOW or ESCALATE
 *   node scripts/github/cr-paid.mjs record --pr <N> --head <sha> --files <K>   log a paid round you just posted (a manual record, via "manual"; `post` records its own round, via "post")
 *   node scripts/github/cr-paid.mjs post --pr <N>                post the paid review on Dave's priced yes. Exit 0 posted; 4 refused (the yes is used up); 5 nothing happened, the yes is kept
 *   node scripts/github/cr-paid.mjs unledgered --pr <N> [--json] read-only: { head, ids } of the paid comments of the PR that the ledger has no post round for (counted per PR). Exit 0 always (a failed read gives ids: [])
 *   node scripts/github/cr-paid.mjs today [--json]               today's paid total and rows
 *   node scripts/github/cr-paid.mjs month [--json]               this Chicago month's paid files (the interim monthly cap reads it)
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
 * Ledger: ~/.claude/state/coderabbit-paid.jsonl, one JSON line per paid round: {ts, date, pr, head, files, cost, session, via}.
 * via is "post" for a round that `post` or a paid decision recorded, "manual" for the record verb. An old row has no via and counts as manual.
 * A paid CLI run (pre-pr.mjs and cr-fix.mjs log it from the run's usageCost) adds {ts, date, kind: "cli", branch, head, files, cost, session}.
 * A row with no kind is a PR row. The PR limits above count PR rows only. The CLI daily cap (review-router.config.json,
 * coderabbit.cli_daily_cap_usd) counts cli rows only, for the same America/Chicago day.
 * The month counter (monthToDateFiles, `month`) sums the files of PR rows of one America/Chicago month. The pr-checkpoint reads it for
 * coderabbit.monthly_file_cap. The ledger records paid rounds only, so the count misses reviews that used a free slot: it undercounts.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanSummaryCommit, codeRabbitHeadReview, codeRabbitNotice, coderabbitRequestComments, deltaLinesOf, isCodeRabbitUser, newestCodeRabbitRound, readIssueComments, readPrCommits, summaryCoversHead, trustedCodeRabbitSummary } from './review-status.mjs';
import { capacityFact, pathFiltersFrom, reviewableFiles, sameForm } from './pr-checkpoint.mjs';
import { ghApi } from './cr-fix.mjs';
import { withLock } from './lib/file-lock.mjs';
import { DECISIONS_ENV, accountHome, capCentsOfLabel, decisionKey, decisionRowRead, decisionUse } from './lib/decisions.mjs';
import { slotStateOf } from './lib/checkpoint-ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = 'Rev4nchist/Continuous-Claude-v3';
/** The paid ledger of this account: under the home of the OS account record, never a HOME or USERPROFILE a command set. No flag and no env variable sets it in a real run (deps only). */
export const defaultLedgerPath = () => path.join(accountHome(), '.claude', 'state', 'coderabbit-paid.jsonl');
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
const isCli = (r) => r.kind === 'cli';

function parseRow(line, n) {
  let r;
  try { r = JSON.parse(line); } catch { throw new Error(`ledger line ${n} is not JSON`); }
  const base = /^\d{4}-\d{2}-\d{2}$/.test(r?.date ?? '') && Number.isFinite(r.cost) && r.cost >= 0;
  if (base && isCli(r) && typeof r.branch === 'string' && r.branch !== '') return r;
  if (base && (r.kind === undefined || r.kind === 'pr') && Number.isInteger(r.pr)) return r;
  throw new Error(`ledger line ${n} lacks a whole pr (or a branch for a cli row), a known kind, a date or a cost`);
}

/** Every ledger row. A missing file is an empty ledger. Throws on any other read error or any bad line. */
export function readLedger(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  return text.split(/\r?\n/).map((l, i) => [l, i + 1]).filter(([l]) => l.trim() !== '').map(([l, n]) => parseRow(l, n));
}

const centsOf = (rows) => rows.reduce((sum, r) => sum + Math.round(r.cost * 100), 0);

/** { date, total, rows }: the paid PR rows of the Chicago day of now. Throws on a bad ledger. */
export function todayOf(deps) {
  const d = withDefaults(deps);
  const date = chicagoDay(d.now());
  const rows = readLedger(d.ledgerPath).filter((r) => r.date === date && !isCli(r));
  return { date, total: centsOf(rows) / 100, rows };
}

/** { date, total, rows }: the paid CLI rows of the Chicago day of now. Throws on a bad ledger. */
export function cliTodayOf(deps) {
  const d = withDefaults(deps);
  const date = chicagoDay(d.now());
  const rows = readLedger(d.ledgerPath).filter((r) => r.date === date && isCli(r));
  return { date, total: centsOf(rows) / 100, rows };
}

/** The files of the PR rows whose Chicago date starts with monthPrefix (YYYY-MM). CLI rows never count. Throws when a counted row has no whole, non-negative files (a bad row would lower the total). Pure. */
export function monthToDateFiles(rows, monthPrefix) {
  const counted = rows.filter((r) => !isCli(r) && String(r.date).startsWith(`${monthPrefix}-`));
  for (const r of counted) {
    if (!Number.isInteger(r.files) || r.files < 0) throw new Error(`ledger PR row dated ${r.date} (pr ${r.pr}) lacks a whole, non-negative files count`);
  }
  return counted.reduce((sum, r) => sum + r.files, 0);
}

/** { month, files, rounds }: the paid PR rows of the Chicago month of now. A missing ledger is an empty month. Throws on a bad ledger. */
export function monthOf(deps) {
  const d = withDefaults(deps);
  const month = chicagoDay(d.now()).slice(0, 7);
  const rows = readLedger(d.ledgerPath).filter((r) => !isCli(r) && r.date.startsWith(`${month}-`));
  return { month, files: monthToDateFiles(rows, month), rounds: rows.length, cost: centsOf(rows) / 100 };
}

/** The daily CLI cap in dollars from the router config (coderabbit.cli_daily_cap_usd), or null when the key is missing or not a number of 0 or more. */
export function cliCapOf(config) {
  const cap = config?.coderabbit?.cli_daily_cap_usd;
  return typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 ? cap : null;
}

/** { capped, total, cap, date }: today's CLI spend against the cap. capped is true when the total reaches the cap. Throws on a bad ledger. */
export function cliCapCheck(capUsd, deps) {
  const { date, total } = cliTodayOf(deps);
  return { capped: Math.round(total * 100) >= Math.round(capUsd * 100), total, cap: capUsd, date };
}

/** The line that names the CLI total, the cap and the day. */
export const cliCapLine = ({ total, cap, date }) => `today's paid CodeRabbit CLI spend is ${usd(Math.round(total * 100))} (${date}, America/Chicago), at or over the daily cap of ${usd(Math.round(cap * 100))} (review-router.config.json coderabbit.cli_daily_cap_usd)`;

/** Appends one paid round to the ledger and returns the row. `via` is "manual" (the record verb has no flag for another) or "post" (postPaid only). Throws on a bad head or file count. */
export function recordPaid({ pr, head, files, via = 'manual' }, deps) {
  const d = withDefaults(deps);
  if (!/^[0-9a-f]{7,40}$/i.test(String(head))) throw new Error('--head must be a commit sha');
  if (!Number.isInteger(files) || files < 0) throw new Error('--files must be a whole number, 0 or more');
  const now = d.now();
  const row = { ts: now.toISOString(), date: chicagoDay(now), pr, head: String(head).toLowerCase(), files, cost: (files * CENTS_PER_FILE) / 100, session: d.env.CLAUDE_CODE_SESSION_ID || d.env.CLAUDE_SESSION_ID || 'unknown', via };
  mkdirSync(path.dirname(d.ledgerPath), { recursive: true });
  appendFileSync(d.ledgerPath, `${JSON.stringify(row)}\n`);
  return row;
}

/**
 * Appends one paid CLI run to the ledger and returns the row. `usageCost` is { files, costCents } (usageCostOf in pre-pr.mjs).
 * Returns null and writes nothing when the cost is not above 0 (a free run). Throws on a bad head or a write error.
 */
export function recordCliSpend({ branch, head, usageCost }, deps) {
  if (!usageCost || !Number.isFinite(usageCost.costCents) || usageCost.costCents <= 0) return null;
  const d = withDefaults(deps);
  if (!/^[0-9a-f]{7,40}$/i.test(String(head))) throw new Error('the head must be a commit sha');
  const now = d.now();
  const files = Number.isInteger(usageCost.files) && usageCost.files >= 0 ? usageCost.files : 0;
  const row = { ts: now.toISOString(), date: chicagoDay(now), kind: 'cli', branch: String(branch || 'unknown'), head: String(head).toLowerCase(), files, cost: usageCost.costCents / 100, session: d.env.CLAUDE_CODE_SESSION_ID || d.env.CLAUDE_SESSION_ID || 'unknown' };
  mkdirSync(path.dirname(d.ledgerPath), { recursive: true });
  appendFileSync(d.ledgerPath, `${JSON.stringify(row)}
`);
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
  return { head, reviews, prFiles, commits: readPrCommits(gh, owner, name, pr), ...readIssueComments(gh, owner, name, pr) };
}

/** The fix since the last reviewed commit: { lines, added }. Throws when the compare cannot be sized. */
function fixOf(compare, prFiles) {
  const lines = deltaLinesOf(compare, prFiles);
  if (lines === null) throw new Error('the fix size could not be read (the compare is missing, full or malformed)');
  const own = new Set(prFiles.map((f) => f.filename));
  return { lines, added: compare.files.filter((f) => f.status === 'added' && own.has(f.filename)).length };
}

/**
 * The reviewed CodeRabbit rounds so far: one per distinct commit named by a bot review with a body (an empty body is a thread reply),
 * plus the commit a trusted clean summary covers when no review object holds it (a summary-only round, even an older one).
 * A request still unanswered counts none.
 */
function reviewedRounds(facts) {
  const bot = (facts.reviews ?? []).filter((r) => isCodeRabbitUser(r?.user) && String(r.body ?? '').trim() !== '');
  const commits = new Set(bot.map((r) => r.commit_id));
  const covered = cleanSummaryCommit(facts.comments, facts.commentEdits);
  if (covered !== null && covered !== facts.head) commits.add(covered);
  return commits.size;
}

/** { round, from, head, list, fix }: the files this round bills and, for round 2 or later, the fix size. */
function estimate(facts, repo, gh) {
  if (codeRabbitHeadReview(facts).reviewedHead) throw new Error('CodeRabbit already reviewed the head; a round would buy nothing');
  const newest = newestCodeRabbitRound(facts);
  if (!newest) return { round: 1, from: null, head: facts.head, list: facts.prFiles, fix: null };
  const from = String(newest.commit_id ?? '').toLowerCase();
  if (!SHA40.test(from)) throw new Error('the newest CodeRabbit round names no commit');
  const compare = gh([`repos/${repo}/compare/${from}...${facts.head}`]);
  return { round: reviewedRounds(facts) + 1, from, head: facts.head, list: compare.files ?? [], fix: fixOf(compare, facts.prFiles) };
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
  const todayCents = centsOf(ledger.filter((r) => r.date === date && !isCli(r)));
  const paidRounds = ledger.filter((r) => !isCli(r) && r.pr === pr).length;
  const reasons = verdictReasons({ costCents, todayCents, paidRounds, fix: est.fix });
  const allow = reasons.length === 0;
  return {
    exitCode: allow ? 0 : 3, verdict: allow ? 'ALLOW' : 'ESCALATE', pr, head: est.head, round: est.round, from: est.from,
    files, total: est.list.length, cost: costCents / 100, today: todayCents / 100, paidRounds, fix: est.fix, reasons,
    comment: allow ? PAID_COMMENT : null,
  };
}

const withDefaults = (deps = {}) => ({ gh: ghApi, now: () => new Date(), ledgerPath: defaultLedgerPath(), pathFilters: liveFilters, env: process.env, ...deps });

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

// ---- the paid post (card prflow-paid-run-guard, PR 2) ----
// One function posts a paid review: postPaid. It runs from `cr-paid.mjs post --pr N` (the cap comes from Dave's priced yes in the decision store)
// and from the free-slot queue's pay decision (the cap comes from --cap; the mod's own dialog passes it). The control is the priced yes:
// a text rule on gh commands is only a second layer. Mode assumed: CodeRabbit On demand, where a plain "@coderabbitai review" never bills and
// the --use-credits word does (a mode change is a new card).
/** The only entry points that may pay: `cli` is the terminal, and the phone through Remote Control. Any other value, a missing one and an empty one are refused. */
export const PAID_ENTRY_ALLOWED = Object.freeze(['cli']);
/** tapMaxMs: a paid yes lasts this long from Dave's tap. deadlineMs: the whole guarded section. callMs: one GitHub call. lockStaleMs: the paid lock (the default is 30 s). */
export const POST_LIMITS = Object.freeze({ tapMaxMs: 60 * 60_000, deadlineMs: 120_000, callMs: 20_000, lockStaleMs: 180_000 });
const PAID_WORD = /use[-_\s]*credits/i;
const REMOTE_NOTE = 'A paid tap works from the terminal or the phone through Remote Control.';
const ROOT = path.join(HERE, '..', '..');

/** ghApi with a time limit: a hung call ends after timeoutMs (the default ghApi has none). */
export function ghApiTimed(apiArgs, { timeoutMs = POST_LIMITS.callMs } = {}) {
  const personal = path.join(os.homedir(), '.config', 'gh-personal');
  const dir = process.env.GH_CONFIG_DIR || (existsSync(personal) ? personal : undefined);
  const env = { ...process.env, ...(dir ? { GH_CONFIG_DIR: dir } : {}) };
  return JSON.parse(execFileSync('gh', ['api', ...apiArgs], { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }));
}

/**
 * The paid requests (comments by a person that start "@coderabbitai review" and hold the paid word) that no review answers: the logic of land-recheck.mjs
 * (a request is answered by a CodeRabbit review with a body, or a trusted summary that covers the head, made after it), limited to requests with the paid
 * word. A plain request that CodeRabbit refused (a rate limit) is not counted: it must not block the paid round that exists for that case. Pure.
 */
export function openPaidRequests({ comments = [], commentEdits = [], reviews = [], head }) {
  const ms = (t) => Date.parse(t ?? '') || 0;
  const answers = reviews.filter((r) => isCodeRabbitUser(r?.user) && String(r.body ?? '').trim() !== '');
  const trusted = trustedCodeRabbitSummary(comments, commentEdits);
  const covers = Boolean(trusted) && !codeRabbitNotice(trusted.body) && summaryCoversHead(trusted.body, head);
  const answeredAt = Math.max(0, ...answers.map((r) => ms(r.submitted_at)), covers ? ms(trusted.updated_at || trusted.created_at) : 0);
  return paidRequestsOf(comments).filter((c) => ms(c.created_at) > answeredAt);
}

/** Why Dave's stored yes cannot pay, as one sentence, or null. Order: price, entry point, tap time. `nowMs` is the clock of the check. */
function rowProblem(row, pr, nowMs) {
  if (capCentsOfLabel(row.label) === null) return `Dave's tap for PR #${pr} names no price ("${row.label}"). A tap with no price is no paid yes.`;
  if (typeof row.entry !== 'string' || row.entry === '') return `The paid yes for PR #${pr} has no entry point stamp. ${REMOTE_NOTE}`;
  if (!PAID_ENTRY_ALLOWED.includes(row.entry)) return `The paid yes for PR #${pr} was tapped in "${row.entry}". ${REMOTE_NOTE}`;
  const tapMs = typeof row.tapAt === 'string' ? Date.parse(row.tapAt) : Number.NaN;
  if (!Number.isFinite(tapMs)) return `The paid yes for PR #${pr} has no readable tap time. Ask Dave again.`;
  if (tapMs > nowMs) return `The paid yes for PR #${pr} has a tap time in the future. Ask Dave again.`;
  const age = Math.floor((nowMs - tapMs) / 60_000);
  return nowMs - tapMs > POST_LIMITS.tapMaxMs ? `Dave's tap for PR #${pr} is ${age} minutes old; a paid yes lasts 60 minutes. Ask again.` : null;
}

/**
 * Why a PR cannot take a paid review, as the words of the refusal ('merged', 'closed', 'a draft'), or null for an open PR that is not a draft.
 * `pull` is the REST answer of repos/<repo>/pulls/<N>. Throws when state, merged or draft is missing or of the wrong type: an unreadable answer is a failed read, never "open".
 */
export function pullBlockOf(pull) {
  const { state, merged, draft } = pull ?? {};
  if (state !== 'open' && state !== 'closed') throw new Error('the PR state is missing or not understood');
  if (typeof merged !== 'boolean' || typeof draft !== 'boolean') throw new Error('the PR merged or draft flag is missing');
  if (merged) return 'merged';
  if (state === 'closed') return 'closed';
  return draft ? 'a draft' : null;
}

class DeadlineError extends Error {}
const fail = (code, text, extra = {}) => ({ ok: false, code, text, ...extra });
const DEADLINE_TEXT = `The paid post ran past its ${POST_LIMITS.deadlineMs / 1000} s limit. Nothing was posted.`;

/** Steps 3 to 6 of the guarded section: a refusal text (with extra fields), or { verdict } when the post may go on. */
function checksOf(d, { pr, repo, head, capCents }, gh) {
  const nowMs = d.now().getTime();
  const h7 = head.slice(0, 7);
  let fact = null;
  try { fact = d.capacity(pr, nowMs); } catch { /* an unreadable slot fact is unknown: the review stays paid */ }
  if (slotStateOf(fact, nowMs) === 'free') return { text: `The CodeRabbit slot is free for PR #${pr}. A free review costs nothing: use the free slot.` };
  const [owner, name] = repo.split('/');
  const reviews = readList(gh, `repos/${repo}/pulls/${pr}/reviews?per_page=100`);
  const { comments, commentEdits } = readIssueComments(gh, owner, name, pr);
  if (openPaidRequests({ comments, commentEdits, reviews, head }).length > 0) return { text: `An unanswered paid request already exists for PR #${pr} at ${h7}. Wait for CodeRabbit.` };
  if (d.queue?.holdsPay?.(pr, head) === true) return { text: `The free-slot queue already holds a paid decision for PR #${pr} at ${h7}.` };
  // deps.checkPr({ pr, repo }) stands in for the cr-paid check (the queue's tests); with none, the check reads GitHub through the guarded gh.
  const v = (d.checkPr ?? ((a) => checkPr(a, { gh, now: d.now, ledgerPath: d.ledgerPath, pathFilters: d.pathFilters, env: d.env })))({ pr, repo }) ?? { verdict: null, reason: 'no answer' };
  if (!v.verdict) return { text: `cr-paid gave no verdict for PR #${pr} (${v.reason}). No paid post.` };
  if (v.verdict !== 'ALLOW') return { text: `cr-paid says ${v.verdict} for PR #${pr}: ${v.reasons.join('; ')}. No paid post.`, kind: 'escalate', verdict: v.verdict, reasons: v.reasons };
  if (v.head !== head) return { text: `The head of PR #${pr} moved from ${h7} to ${String(v.head).slice(0, 7)} during the check. Ask Dave again.` };
  // The UNFILTERED count prices the round (path_filters billing is unproven). No whole count of 1 or more, no price: never fall back to the filtered count (F4).
  if (!Number.isInteger(v.total) || v.total < 1) return { text: `cr-paid gave no usable file count for PR #${pr}. No paid post.` };
  const files = v.total;
  const costCents = files * CENTS_PER_FILE;
  // The verdict above priced the round on the FILTERED count (path_filters of the working tree: an edit there zeroes it). Judge the limits again on the same
  // UNFILTERED count that the cap below uses, so the price Dave tapped and the round and day limits read one number. LIMITS are unchanged.
  const today = Number.isFinite(v.today) ? Math.round(v.today * 100) : 0;
  const limits = verdictReasons({ costCents, todayCents: today, paidRounds: Number.isInteger(v.paidRounds) ? v.paidRounds : 0, fix: v.fix ?? null });
  if (limits.length > 0) return { text: `cr-paid says ESCALATE for PR #${pr}: ${limits.join('; ')}. No paid post.`, kind: 'escalate', verdict: 'ESCALATE', reasons: limits };
  if (costCents > capCents) return { text: `The cost is ${usd(costCents)}, over the ${usd(capCents)} Dave tapped. Ask again.` };
  return { v, files, costCents };
}

/**
 * The number of rounds of the PR (all heads) that `post` or a paid decision recorded: the rows with via "post". A row of the record verb (via "manual") and an old
 * row with no via never count: a hand-written row must not silence the detection. Throws on a bad ledger.
 */
export function postRoundsOf(pr, deps) {
  const d = withDefaults(deps);
  return readLedger(d.ledgerPath).filter((r) => !isCli(r) && r.pr === pr && r.via === 'post').length;
}

/** The comments by a person that start "@coderabbitai review" and hold the paid word (the same match as openPaidRequests). Pure. */
export const paidRequestsOf = (comments = []) => coderabbitRequestComments(comments).filter((c) => PAID_WORD.test(String(c.body ?? '')));

/**
 * The ids of the paid comments (a person's "@coderabbitai review" with the paid word) of the PR that the paid ledger has no round for: a paid post that did not
 * go through `post` or a paid decision. The count is per PR: the comments (deduped by id, sorted by id) beyond the number of via "post" rows of the PR, all heads.
 * The first N comments match the N rows; the rest are unledgered. No date and no head is read, so nothing the model can move (a committer date, a manual row)
 * hides a comment. `head`, `_headCommittedAt` stay in the signature for the queue's call and are not used. An unreadable ledger says nothing (no flag), so a bad
 * file cannot make every tick toast. Detection only: it blocks nothing. `deps` is what postRoundsOf reads (ledgerPath, now, env).
 */
export function unledgeredPaidOf(pr, _head, comments, _headCommittedAt, deps) {
  const ids = [...new Set(paidRequestsOf(comments).map((c) => c.id))].sort((a, b) => a - b);
  if (ids.length === 0) return [];
  try { return ids.slice(postRoundsOf(pr, deps)); } catch { return []; }
}

/** { head, ids } for the unledgered verb: the PR head and the unledgered paid comment ids on it. Never throws: any failed read is { head: '', ids: [] }. */
export function unledgeredOf({ pr, repo = DEFAULT_REPO }, deps) {
  const d = withDefaults(deps);
  try {
    const [owner, name] = repo.split('/');
    const head = String(d.gh([`repos/${repo}/pulls/${pr}`])?.head?.sha ?? '').toLowerCase();
    if (!SHA40.test(head)) return { head: '', ids: [] };
    const { comments } = readIssueComments(d.gh, owner, name, pr);
    return { head, ids: unledgeredPaidOf(pr, head, comments, null, d) };
  } catch { return { head: '', ids: [] }; }
}

/** The guarded section (steps 1 to 7). The paid lock is held by the caller. Never throws for a GitHub or ledger failure: it returns { ok, code, text }. */
function guardedPost(d, { pr, cap, source, repo, expectHead }, began) {
  const nowMs = () => d.now().getTime();
  const left = () => began + POST_LIMITS.deadlineMs - nowMs();
  const gh = (args) => {
    if (left() <= 0) throw new DeadlineError(DEADLINE_TEXT);
    return d.gh(args, { timeoutMs: Math.min(POST_LIMITS.callMs, left()) });
  };
  let head;
  let block;
  try { // step 1: before any row is found, so a failed read keeps the yes. The same answer gives the head and the PR state (a missing state is a failed read, not "open").
    const pull = gh([`repos/${repo}/pulls/${pr}`]);
    head = String(pull?.head?.sha ?? '').toLowerCase();
    if (!SHA40.test(head)) throw new Error('the PR head is not a commit sha');
    block = pullBlockOf(pull);
  } catch (err) { return fail(5, `Could not read PR #${pr} from GitHub (${firstLine(err)}). Nothing was posted. The paid yes is kept; run it again.`); }
  // F6: the head Dave saw with the price (source cap: the queue's --head). A PR that moved off it is a different round than the one he priced.
  if (expectHead !== null && expectHead !== head) return fail(4, `The head of PR #${pr} moved from ${String(expectHead).slice(0, 7)} to ${head.slice(0, 7)} after Dave saw the price. Nothing was posted. Ask Dave again.`);
  // step 2: the yes. From here on every refusal uses the row up and exits 4.
  const triple = { step: 'paid-round', key: decisionKey({ repo, pr }), head };
  const row = source === 'cap' ? null : decisionRowRead(triple);
  const useUp = () => (row ? decisionUse({ ...triple, label: row.label, at: row.at }) : { ok: true });
  // A use-up that fails (a busy or unreadable store, a newer tap) leaves the row in place: that is exit 5 and "run it again", never exit 4 "used up".
  const notUsedUp = (used, refusal) => fail(5, `The paid yes could not be used up (${used.reason}). Nothing was posted. Run it again.`, refusal ? { refusal } : {});
  const refuse = (text, extra = {}) => { const used = useUp(); return used.ok ? fail(4, text, extra) : notUsedUp(used, text); };
  const capCents = source === 'cap' ? (Number.isInteger(cap) && cap > 0 ? cap : null) : (row ? capCentsOfLabel(row.label) : null);
  if (source === 'cap' ? capCents === null : row === null) return fail(4, `No paid yes of Dave's for PR #${pr} at ${head.slice(0, 7)}.`);
  const problem = row ? rowProblem(row, pr, nowMs()) : null;
  if (problem) return refuse(problem);
  // A closed, merged or draft PR cannot take a paid review. This stands before the free-slot step: no further GitHub call is spent on it.
  if (block) return refuse(`PR #${pr} is ${block}. A paid review goes only to an open PR that is not a draft. Nothing was posted.`);
  let checked;
  try { checked = checksOf(d, { pr, repo, head, capCents }, gh); } catch (err) {
    return refuse(err instanceof DeadlineError ? DEADLINE_TEXT : `The paid post stopped (${firstLine(err)}). Nothing was posted.`);
  }
  if (checked.text) return refuse(checked.text, { kind: checked.kind, verdict: checked.verdict, reasons: checked.reasons });
  if (left() <= 0) return refuse(DEADLINE_TEXT);
  // step 7: use the row up, record the round FIRST, then post. A failure after the record leaves a counted round that did not happen: the safe direction.
  const used = useUp();
  if (!used.ok) return notUsedUp(used);
  const { v, files, costCents } = checked;
  try { recordPaid({ pr, head, files, via: 'post' }, { now: d.now, ledgerPath: d.ledgerPath, env: d.env }); } catch (err) { return fail(4, `The round could not be recorded (${firstLine(err)}). Nothing was posted.`); }
  try { d.afterRecord?.({ pr, head, v, files }); } catch (err) { return fail(4, `The queue could not be marked (${firstLine(err)}). The round is counted. Nothing was posted. Ask Dave again.`); }
  try { gh(['-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '-f', `body=${PAID_COMMENT}`]); } catch (err) {
    try { d.onPostError?.(err); } catch { /* the first failure is the one reported */ }
    return fail(4, `The paid post failed (${firstLine(err)}). The round is counted. Ask Dave again.`, { kind: 'post-failed', error: err });
  }
  return { ok: true, code: 0, kind: 'posted', pr, head, files, cost: costCents / 100, comment: PAID_COMMENT, text: `Posted the paid CodeRabbit review for PR #${pr} at ${head.slice(0, 7)}: ${files} file(s), ${usd(costCents)}, recorded in the ledger. Do not run cr-paid record: the round is already recorded.` };
}

const STORE_MOVED_TEXT = 'The decision store path is overridden by CCV3_DECISIONS_FILE. A paid post reads Dave\'s tap from the real store only. Nothing was posted. The paid yes is kept.';

const HOME_MOVED_TEXT = 'The home folder differs from the one in the OS account record (an environment variable moved it). A paid post reads Dave\'s tap and the paid ledger from the account home only. Nothing was posted. The paid yes is kept.';
const CAP_HEAD_TEXT = 'A paid post from a pay decision needs the PR head Dave saw with the price (40 lowercase hex characters). Nothing was posted.';

/**
 * True when the run env names a decision store at all (seat rule 2026-11-22): a model could write a stamped row to a scratch file and post on it. Any non-empty
 * value refuses, whatever its spelling: no path compare, no parser. Tests do not set the override in the run env (deps.env); the real run's env is process.env.
 */
const storeOverridden = (env) => typeof env?.[DECISIONS_ENV] === 'string' && env[DECISIONS_ENV] !== '';

/** True when HOME or USERPROFILE moved the home away from the OS account record (or the record cannot be read: fail closed). Then the store and the ledger default would move too. */
function homeMoved() {
  try { return sameForm(os.homedir()) !== sameForm(os.userInfo().homedir); } catch { return true; }
}

/**
 * postPaid({ pr, cap, source, repo, head }, deps) -> { ok, code, text, ... }. source `row` (default): the cap is the price of Dave's stored yes. source `cap`: `cap` is
 * whole cents from the queue's pay decision (--cap) and `head` is the PR head Dave saw with that price (--head); a PR that moved off it refuses (exit 4). Holds the paid lock across every step, with a 120 s deadline and a 20 s limit per GitHub call.
 * Codes: 0 posted; 4 a refusal from step 2 on (the row is used up); 5 nothing happened and the yes is kept (a failed GitHub read in step 1, another paid post holds the lock,
 * a non-empty CCV3_DECISIONS_FILE in a `row` run, a HOME or USERPROFILE that differs from the OS account record (or an account record that cannot be read) in any run, or the use-up of the row failed).
 * 4 also covers a `cap` run with no valid `head` and a PR that moved off it (both before step 2: no row is involved). A real run has no flag and no env variable
 * that sets ledgerPath; only deps do. The store and the ledger default to the OS account home; the writer of the stamped row resolves the same file in a normal session.
 * deps (tests, the queue): gh(args, { timeoutMs }), now() -> Date, ledgerPath, pathFilters, env, capacity(pr, ms) -> fact, queue { holdsPay(pr, head) },
 * checkPr({ pr, repo }) -> verdict, afterRecord({ pr, head, v, files }) and onPostError(err) (the queue marks its item), lockWaitMs.
 */
export function postPaid({ pr, cap = null, source = 'row', repo = DEFAULT_REPO, head: expectHead = null }, deps = {}) {
  const given = Object.fromEntries(Object.entries(deps).filter(([, v]) => v !== undefined));
  const capacity = (n, ms) => capacityFact({ now: new Date(ms).toISOString(), pr: n, dependabot: false, policy: {}, probe: false, root: ROOT }, { crUsage: () => null });
  const d = { ...withDefaults({ gh: ghApiTimed, capacity, ...given }), lockWaitMs: given.lockWaitMs ?? 5000 };
  if (source !== 'cap' && storeOverridden(d.env)) return fail(5, STORE_MOVED_TEXT);
  if (homeMoved()) return fail(5, HOME_MOVED_TEXT); // both sources: the ledger (the limits) moves with the home in a cap run too
  if (source === 'cap' && !SHA40.test(String(expectHead))) return fail(4, CAP_HEAD_TEXT); // F6: no head Dave saw, no paid post
  const began = d.now().getTime();
  mkdirSync(path.dirname(d.ledgerPath), { recursive: true });
  const ran = withLock(d.ledgerPath, { lockWaitMs: d.lockWaitMs, lockStaleMs: POST_LIMITS.lockStaleMs }, () => guardedPost(d, { pr, cap, source, repo, expectHead }, began));
  if (ran?.ok === false && ran.reason === 'lock') return fail(5, `Another paid post is running for the paid ledger (${firstLine(ran.detail)}). Nothing was posted. The paid yes is kept; run it again in a moment.`);
  return ran;
}

// ---- output ----
/** { out, err }: the lines main() prints for a check result. */
export function reportOf(r) {
  if (r.exitCode === 2) return { out: [], err: [`cr-paid: stopped, no verdict: ${r.reason}`] };
  const shape = `PR #${r.pr}: round ${r.round}, ${r.files} billable file(s) at $0.25 = ${usd(r.cost * 100)}. Reviewable ${r.files} of ${r.total} files (path_filters exclusion from billing is unproven).`;
  const day = `Paid today ${usd(r.today * 100)}; paid rounds on this PR ${r.paidRounds} of ${LIMITS.paidRounds}.`;
  if (r.verdict === 'ESCALATE') return { out: [`ESCALATE ${shape}`, day, ...r.reasons.map((x) => `- ${x}`), 'Stop. Ask Dave. Do not post a paid review.'], err: [] };
  // A paid round needs Dave's priced tap (card prflow-paid-run-guard). The post and the record are one step: `post` records the round FIRST, then posts.
  const post = `node scripts/github/cr-paid.mjs post --pr ${r.pr}`;
  return { out: [`ALLOW ${shape}`, day, 'Do not post a paid review yourself. A paid round needs Dave\'s priced tap: run ship-ask.mjs paid-round --pr N --json and ask him.', `After his Yes, run: ${post}`, 'It posts this comment and records the round. Do not run record.', r.comment], err: [] };
}

// ---- command line ----
const COMMANDS = ['check', 'record', 'today', 'month', 'post', 'unledgered'];
const VALUE_FLAGS = { '--pr': 'pr', '--head': 'head', '--files': 'files', '--repo': 'repo' };
const USAGE_LINE = 'usage: cr-paid.mjs check --pr <N> [--json] | record --pr <N> --head <sha> --files <K> | post --pr <N> | unledgered --pr <N> [--json] | today [--json] | month [--json] | --help';
const toInt = (v, flag) => {
  if (!/^\d+$/.test(String(v ?? '')) || Number(v) === 0 && flag === '--pr') throw new Error(`${flag} needs a whole number${flag === '--pr' ? ' above 0' : ''}`);
  return Number(v);
};

/** { cmd, pr, json, head, files, repo } from argv. Throws on a bad subcommand, flag or number. `post` takes --pr N and nothing else (no --cap: the cap is Dave's tap). */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!COMMANDS.includes(cmd)) throw new Error(USAGE_LINE);
  if (cmd === 'post' && (rest.length !== 2 || rest[0] !== '--pr')) throw new Error('post takes --pr N only: the cap is the price of Dave\'s tap, never a flag');
  if (cmd === 'unledgered' && (rest.filter((a) => a !== '--json').length !== 2 || rest[0] !== '--pr')) throw new Error('unledgered takes --pr N and --json only');
  const o = { cmd, pr: null, json: false, head: null, files: null, repo: DEFAULT_REPO };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--json') o.json = true;
    else if (VALUE_FLAGS[rest[i]]) o[VALUE_FLAGS[rest[i]]] = rest[(i += 1)];
    else throw new Error(`unknown argument: ${rest[i]}`);
  }
  if (!['today', 'month'].includes(cmd)) o.pr = toInt(o.pr, '--pr');
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

/** The lines `today` prints: the PR rounds, then the CLI runs of the day. Pure. */
export function todayLines(t, cli) {
  const pr = t.rows.map((r) => `PR #${r.pr} ${r.head.slice(0, 7)} ${r.files} file(s) ${usd(r.cost * 100)} ${r.ts} ${r.session}`);
  const runs = cli.rows.map((r) => `CLI ${r.branch} ${r.head.slice(0, 7)} ${r.files} file(s) ${usd(r.cost * 100)} ${r.ts} ${r.session}`);
  return [
    `Paid today (${t.date}, America/Chicago): ${usd(t.total * 100)} in ${t.rows.length} round(s)`, ...pr,
    `Paid CLI runs today: ${usd(cli.total * 100)} in ${cli.rows.length} run(s)`, ...runs,
  ];
}

/** The lines `month` prints. The ledger holds paid rounds only, so a review that used a free slot is not in the count. */
export function monthLines(m) {
  return [
    `Paid CodeRabbit PR files in ${m.month} (America/Chicago): ${m.files} file(s), ${usd(m.cost * 100)} in ${m.rounds} round(s).`,
    'The ledger records paid rounds only, so this undercounts reviews that used a free slot.',
  ];
}

function runMonth(o) {
  const m = monthOf();
  if (o.json) console.log(JSON.stringify(m));
  else print(monthLines(m), console.log);
  return 0;
}

function runToday(o) {
  const t = todayOf();
  const cli = cliTodayOf();
  if (o.json) console.log(JSON.stringify({ ...t, cli }));
  else print(todayLines(t, cli), console.log);
  return 0;
}

/** { code, out, err } of `post --pr N`. deps.post({ pr, repo }) -> the postPaid result (the queue wrapper in main; a stub in tests). Exit: 0 posted, 4 refused, 5 a failed read or a busy lock, 2 bad usage. */
export function runPostVerb(argv, deps) {
  const bad = (err) => ({ code: 2, out: [], err: [`cr-paid: ${firstLine(err)}`] });
  let o;
  try { o = parseArgs(argv); } catch (err) { return bad(err); }
  let r;
  try { r = deps.post({ pr: o.pr, repo: o.repo }); } catch (err) { return bad(err); }
  if (r.ok) return { code: 0, out: [r.text], err: [] };
  return { code: r.code, out: [], err: [`cr-paid: ${r.code === 4 ? 'refused: ' : ''}${r.text}`] };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, '')); return 0; }
  if (argv[0] === 'post') {
    // The queue wrapper holds the queue lock, then postPaid takes the paid lock (lock order: queue, then paid). A dynamic import: slot-queue.mjs imports this file.
    const { postPaidForRow } = await import('./slot-queue.mjs');
    const r = runPostVerb(argv, { post: postPaidForRow });
    print(r.out, console.log);
    print(r.err, console.error);
    return r.code;
  }
  try {
    const o = parseArgs(argv);
    if (o.cmd === 'unledgered') { console.log(JSON.stringify(unledgeredOf(o, { gh: ghApiTimed }))); return 0; }
    if (o.cmd === 'check') return runCheck(o);
    if (o.cmd === 'today') return runToday(o);
    if (o.cmd === 'month') return runMonth(o);
    console.log(JSON.stringify(recordPaid(o)));
    return 0;
  } catch (err) { console.error(`cr-paid: ${firstLine(err)}`); return 2; }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
// No top-level await: `post` imports slot-queue.mjs, which imports this file, so an await here would wait on itself.
if (isDirectRun()) main().then((code) => process.exit(code));
