#!/usr/bin/env node
/**
 * ship-ask.mjs: builds the AskUserQuestion spec of one ship step and writes the offer to the decision store (pathway-flow-v2, design N1).
 * Tests: scripts/github/ship-ask.test.mjs. Store: scripts/github/lib/decisions.mjs.
 *
 * Usage: node scripts/github/ship-ask.mjs <commit-and-push|open-pr|land|paid-round|cli-skip> [--pr N | --branch B] [--msg file] [--json] [--facts f.json]
 *   commit-and-push, open-pr, cli-skip: --branch B (default: the current branch). --msg is the commit message file (commit-and-push only).
 *   cli-skip: Dave decides to skip the CLI review for the head of a flag stamp (pre-pr.mjs --skip-cr); pre-pr-gate then accepts it once.
 *   land, paid-round: --pr N.
 *   --json   print { header, question, options: [{ label, description }] } as one JSON object. Pass it to AskUserQuestion unchanged.
 *   --facts  read the step data from a JSON file, not from git, gh and the ledger (tests). Honoured only in test mode.
 *   SHIP_ASK_STATUS_SCRIPT  replaces review-status.mjs for land (tests). Honoured only in test mode.
 *   Test mode = SHIP_ASK_TEST=1 and CCV3_DECISIONS_FILE set to a path other than the default real store.
 *   Outside test mode both are ignored, with one warning on stderr, and the real data path runs.
 * The recommended option is first and its label ends with " (Recommended)". The question has at most 3 lines (land: at most 5).
 * land starts with three lines, "Why:", "What it does:" and "You will see:" (the Problem, Change and You will see fields of the pre-pr
 * summary), only when the summary's stamp binds to the PR head. Then one line that starts with "State:".
 * The store step of commit-and-push is `ship`. An open offer is what lets the AskUserQuestion hook record Dave's tap.
 * Exit 0 = the offer is written and the spec printed. 1 = no question can be asked (the reason is on stderr, nothing written).
 * 2 = bad usage. 3 = internal error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECISIONS_ENV, decisionKey, decisionsPath, offerWrite } from './lib/decisions.mjs';
import { SUMMARY_REL, changeOf, hashOf, summaryFieldsOf } from './lib/pr-summary.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_REPO = 'Rev4nchist/Continuous-Claude-v3';
const RECOMMENDED = ' (Recommended)';
const PAID_PER_FILE = 0.25;
const PATHWAY_OF_LABEL = { 'review:none': 'none', 'review:coderabbit': 'coderabbit', 'review:deep': 'both' };

/** The ship-ask step word -> the store step. */
export const STORE_STEP = Object.freeze({ 'commit-and-push': 'ship', 'open-pr': 'open-pr', land: 'land', 'paid-round': 'paid-round', 'cli-skip': 'cli-skip' });

const one = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, n) => (one(text).length > n ? `${one(text).slice(0, n - 1)}…` : one(text));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const usd = (n) => `$${Number(n).toFixed(2)}`;
const opt = (label, description, first = false) => ({ label: `${label}${first ? RECOMMENDED : ''}`, description });

// ---------- the specs: pure ----------

/** Nothing is staged, commits are ahead of fork/main and the HEAD tree is known: the one case that offers "Push only". */
const pushOnlyOf = ({ staged, ahead, headTree }) => staged === 0 && typeof ahead === 'number' && ahead > 0 && Boolean(headTree);

/** commit-and-push. data: { branch, head, headTree, staged, ahead (number or null), subject (string or null) }. */
export function shipSpec({ branch, head, headTree, staged, ahead, subject }) {
  if (pushOnlyOf({ staged, ahead, headTree })) {
    const lines = [`Push ${clip(branch, 60)} to fork? Nothing is staged.`, `No commit is made. HEAD is ${String(head ?? '').slice(0, 7)}.`, `${plural(ahead, 'commit')} ahead of fork/main.`];
    return { header: 'Push', question: lines.join('\n'), options: [
      opt('Push only', `Runs git-safe push fork ${clip(branch, 60)}. No commit is made.`, true),
      opt('Show the commits first', 'Prints git log fork/main..HEAD --oneline, then asks again.'),
      opt('Stop here', 'Nothing runs.'),
    ] };
  }
  const ready = staged > 0;
  const lines = [
    ready ? `Commit ${plural(staged, 'file')} on ${clip(branch, 60)} and push to fork?` : `Nothing is staged on ${clip(branch, 60)}.`,
    subject ? `Message: '${clip(subject, 90)}'.` : 'No commit message file was given.',
    typeof ahead === 'number' ? `${plural(ahead, 'commit')} ahead of fork/main.` : 'Commits ahead of fork/main: unknown.',
  ];
  const go = opt('Commit and push', `Runs git commit -F <msg> && git-safe push fork ${clip(branch, 60)}, joined by &&.`, ready);
  const diff = opt('Show the diff first', 'Prints git diff --cached --stat and the message, then asks again.');
  const stop = opt('Stop here', 'Nothing runs. The work stays uncommitted.', !ready);
  return { header: 'Commit', question: lines.join('\n'), options: ready ? [go, diff, stop] : [stop, diff] };
}

const ageText = (min) => (min < 60 ? `${min} min` : `${Math.round(min / 60)} h`);

/** open-pr when the stamp names this head. data: { branch, head, stampHead, stampAt, now, rows, fails, change, cliDetail, costUsd }. change is the Change sentence of the summary, or null. */
export function openPrSpec(d) {
  const min = Math.max(0, Math.round((Date.parse(d.now) - Date.parse(d.stampAt)) / 60000));
  // The Change sentence replaces the CLI cost line. With no summary for this stamp the CLI line stays.
  const second = d.change ? `Change: ${clip(d.change, 140)}` : `CLI: ${clip(d.cliDetail ?? 'no CLI result in the stamp', 100)} pre-pr cost ${usd(d.costUsd ?? 0)}.`;
  const lines = [
    `pre-pr passed at ${String(d.head).slice(0, 7)}, ${ageText(min)} ago (${plural(d.rows, 'row')} checked, ${d.fails} failed).`,
    second,
    `Open a draft PR for ${clip(d.branch, 60)} on fork?`,
  ];
  return { header: 'Open PR', question: lines.join('\n'), options: [
    opt('Open draft PR', 'Runs gh api .../pulls -X POST -F draft=true -F body=@<file>. pre-pr-gate still checks the stamp.', true),
    opt('Show the PR body first', 'Prints the body file, then asks again.'),
    opt('Stop here', 'No PR opens.'),
  ] };
}

/** open-pr when no PR can open: no stamp, a failed row, or a head that moved. data: { branch, head, stampHead, fails, capLeftUsd }. */
export function rerunPrePrSpec({ branch, head, stampHead, fails, capLeftUsd }) {
  const why = !stampHead ? `No pre-pr stamp for ${clip(branch, 60)}.`
    : fails > 0 ? `The pre-pr stamp has ${plural(fails, 'failed row')}.`
      : `The head moved: the stamp is for ${String(stampHead).slice(0, 7)}, the branch is at ${String(head).slice(0, 7)}.`;
  const cost = typeof capLeftUsd === 'number' ? `up to ${usd(capLeftUsd)} CLI` : 'CLI cost unknown';
  return { header: 'Open PR', question: `${why}\nA draft PR needs a pre-pr stamp for the pushed head.\nRe-run pre-pr first?`, options: [
    opt(`Re-run pre-pr (${cost})`, 'Runs node scripts/github/pre-pr.mjs --body <file>. The CLI review is free inside the hourly allowance.', true),
    opt('Stop here', 'No PR opens.'),
  ] };
}

/** The tap that lets pre-pr-gate accept a flag skip (pre-pr-gate.ts CLI_SKIP_LABEL). */
export const CLI_SKIP_LABEL = 'Skip the CLI review for this head';
export const CLI_KEEP_LABEL = 'Keep the CLI review';

/**
 * cli-skip: Dave decides that the CodeRabbit CLI review is skipped for this head. data: { branch, head, runsSpent, unreviewed }.
 * The skip is recommended only when the run cap is spent (2 runs): no CLI path is left. Else keeping the review is first.
 */
export function cliSkipSpec(d) {
  const spent = Number(d.runsSpent) || 0;
  // Missing coverage is not zero coverage: with no counter row that holds a count, the text says the coverage is unknown (CodeRabbit, PR 576).
  const known = Number.isInteger(d.unreviewed);
  const unreviewed = known ? d.unreviewed : 0;
  const lines = [
    `The CodeRabbit CLI review of ${clip(d.branch, 60)} at ${String(d.head).slice(0, 7)} did not finish.`,
    known ? `${plural(spent, 'CLI run')} spent of 2; the CLI left ${plural(unreviewed, 'file')} unreviewed.` : `${plural(spent, 'CLI run')} spent of 2; the files the CLI left unreviewed are unknown (no coverage count on record).`,
    'Skip the CLI review for this head and open the PR?',
  ];
  const skip = opt(CLI_SKIP_LABEL, 'pre-pr-gate lets the flag stamp open the PR once for this branch and head. A push voids this answer.', spent >= 2);
  const keep = opt(CLI_KEEP_LABEL, 'The PR stays blocked. Fix the findings, run pre-pr again.', spent < 2);
  return { header: 'CLI skip', question: lines.join('\n'), options: spent >= 2 ? [skip, keep] : [keep, skip] };
}

const LAND_LABELS = ['Land now', 'Land when READY', 'Keep open', 'Return to draft'];
const NO_SUMMARY = 'What it does: no checked summary for this head. Read the PR body before you answer.';
const SUMMARY_MAX = 200;

const WITHHELD = 'text withheld (it reads like the state line or an option). Read the PR body.';

// Control, format, private-use and lone surrogate characters, and the line and paragraph separators. None may reach the question:
// a zero-width or bidi character can hide the start of a field, and a separator can add a line.
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu;
/** Text in one plain form: NFKC (full-width letters become ASCII), no unsafe character, one line, single spaces. */
const plainOf = (text) => one(String(text ?? '').normalize('NFKC').replace(UNSAFE_CHARS, ' '));
// READY or NOT READY as the first word, after any run of characters that are not letters or digits ("**READY**", "- NOT READY").
const STARTS_AS_STATE = /^[^\p{L}\p{N}]*(?:not[^\p{L}\p{N}]+ready|ready)(?![\p{L}\p{N}])/iu;
/** clip by code point: a cut never leaves half a character (the ledger needs the question word for word). */
function clipPoints(text, n) {
  const points = [...text];
  return points.length > n ? `${points.slice(0, n - 1).join('')}…` : text;
}

/**
 * One summary field as one line of at most SUMMARY_MAX characters, or null when the field is empty. The text comes from a file the building
 * session wrote and shows above the machine facts. A field that could pose as them is not shown: one that holds an option label, or starts
 * with READY, NOT READY (also behind punctuation, an invisible character or full-width letters), or holds "state:" anywhere.
 * Its line says WITHHELD, so Dave sees that a text was there.
 */
function summaryLine(text) {
  const t = plainOf(text);
  if (!t) return null;
  const low = t.toLowerCase();
  const poses = STARTS_AS_STATE.test(t) || /state\s*:/i.test(t) || LAND_LABELS.some((l) => low.includes(l.toLowerCase()));
  return poses ? WITHHELD : clipPoints(t, SUMMARY_MAX);
}

/** The description lines of the Land question: Why, What it does, You will see. With no field at all: the one NO_SUMMARY line. */
function describeLines(summary) {
  const rows = [['Why', summary?.problem], ['What it does', summary?.change], ['You will see', summary?.youWillSee]];
  const lines = rows.map(([label, text]) => [label, summaryLine(text)]).filter(([, text]) => text).map(([label, text]) => `${label}: ${text}`);
  return lines.length > 0 ? lines : [NO_SUMMARY];
}

/** land. data: { pr, head, ready, reasons, mergeable, unresolved, pathway, by, summary }. summary is { problem, change, youWillSee } of the pre-pr summary that binds to this head, or null. */
export function landSpec(d) {
  const state = d.ready ? 'READY' : 'NOT READY';
  const review = d.pathway ? `review ${d.pathway}${d.by ? `, recorded by ${d.by}` : ''}` : 'no review recorded';
  // The description first, then the machine facts on one line that starts with "State:". At most 5 lines.
  const lines = [
    ...describeLines(d.summary),
    `State: PR #${d.pr} is ${state} at ${String(d.head).slice(0, 7)}: mergeable ${d.mergeable ?? 'unknown'}, ${plural(d.unresolved ?? 0, 'open thread')}. Review: ${review}.`,
    ...(d.ready ? [] : [`Not ready: ${clip((d.reasons ?? [])[0] ?? 'no reason given', 110)}.`]),
  ];
  const go = d.ready ? opt('Land now', 'Runs land-pr.ps1 for this head. A push voids this answer.', true) : opt('Land when READY', 'Run land-pr.ps1 once READY is true for this head. A push voids this answer.', true);
  return { header: 'Land', question: lines.join('\n'), options: [go, opt('Keep open', 'Nothing runs. The PR stays open.'), opt('Return to draft', 'Runs gh pr ready --undo. The review pick starts again.')] };
}

/** paid-round. data: { pr, round, files, today, paidRounds, verdict ('ALLOW'|'ESCALATE'|null), reasons, reason, caps: { round, day, rounds } }. */
export function paidRoundSpec(d) {
  const caps = d.caps ?? { round: 5, day: 15, rounds: 2 };
  const cost = typeof d.files === 'number' ? d.files * PAID_PER_FILE : null;
  const allow = d.verdict === 'ALLOW';
  const verdict = allow ? 'cr-paid says ALLOW.'
    : d.verdict === 'ESCALATE' ? `cr-paid says ESCALATE: ${clip((d.reasons ?? []).join('; '), 100)}. No paid round is offered: it is over the cap.`
      : `cr-paid gave no verdict: ${clip(d.reason ?? 'unknown', 80)}. No paid round is offered without an ALLOW.`;
  const lines = [
    cost === null ? `PR #${d.pr}: a paid CodeRabbit round costs ${usd(PAID_PER_FILE)} a file, size unknown.` : `PR #${d.pr}: paid CodeRabbit round ${d.round ?? '?'}, ${plural(d.files, 'file')} x ${usd(PAID_PER_FILE)} = up to ${usd(cost)}.`,
    `Today ${usd(d.today ?? 0)} of ${usd(caps.day)}. Paid rounds on this PR ${d.paidRounds ?? 0} of ${caps.rounds}. Round cap ${usd(caps.round)}.`,
    verdict,
  ];
  const free = opt('No, keep it free', 'Posts nothing. The PR keeps its free-slot path.', true);
  // Dave 2026-11-06: a paid round is offered only on cr-paid ALLOW. ESCALATE and a missing verdict get no pay row.
  const rows = allow ? [free, opt(`Yes, pay up to ${usd(cost ?? 0)}`, 'Posts @coderabbitai review --use-credits, then logs the round with cr-paid.mjs record.')]
    : [free, opt('Stop here', 'Posts nothing. The reason is in the question above.')];
  return { header: 'Paid round', question: lines.join('\n'), options: rows };
}

// ---------- the data: git, gh, ledger ----------

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

const topOf = () => git(['rev-parse', '--show-toplevel'], process.cwd()) ?? ROOT;

/**
 * The head of branch B: refs/heads/B, else fork/B. `null` when neither exists.
 * With no --branch, or when B is the checked-out branch, the head is HEAD and the tree is the index (what a commit would hold).
 * With another branch, the head and the tree are those of the ref, never of the checkout.
 */
function branchTarget(branch, cwd) {
  const current = git(['branch', '--show-current'], cwd);
  if (branch === undefined || branch === current) return { name: current, head: git(['rev-parse', 'HEAD'], cwd), tree: git(['write-tree'], cwd), headTree: git(['rev-parse', 'HEAD^{tree}'], cwd), ref: 'HEAD' };
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/fork/${branch}`]) {
    const head = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    if (head) { const tree = git(['rev-parse', `${ref}^{tree}`], cwd); return { name: branch, head, tree, headTree: tree, ref }; }
  }
  return { name: branch, head: null, tree: null, ref: null, missing: true };
}

/** { branch, head, tree, headTree, staged, ahead, subject } of --branch B (default: the checkout in the cwd). `missing` is set when B has no ref. */
export function gatherShip({ branch, msg }) {
  const cwd = process.cwd();
  const t = branchTarget(branch, cwd);
  const staged = (git(['diff', '--cached', '--name-only'], cwd) ?? '').split('\n').filter(Boolean).length;
  const ahead = t.ref ? git(['rev-list', '--count', `fork/main..${t.ref}`], cwd) : null;
  let subject = null;
  try { subject = msg ? readFileSync(msg, 'utf8').split(/\r?\n/)[0] : null; } catch { /* no message file */ }
  return { branch: t.name, head: t.head, tree: t.tree, headTree: t.headTree ?? null, staged, ahead: ahead === null ? null : Number(ahead), subject, missing: t.missing === true };
}

/** The stamp of the checkout at root (default: this checkout), or null. */
function readStamp(root = topOf()) {
  try { return JSON.parse(readFileSync(path.join(root, '.claude', 'cache', 'pre-pr', 'stamp.json'), 'utf8')); } catch { return null; }
}

const costOfDetail = (detail) => Number(/billed \$([0-9.]+)/.exec(detail ?? '')?.[1] ?? 0);

/** The CLI daily cap left today in dollars, or null when it cannot be read. */
async function capLeft() {
  try {
    const { cliCapOf, cliTodayOf } = await import('./cr-paid.mjs');
    const config = JSON.parse(readFileSync(path.join(topOf(), 'review-router.config.json'), 'utf8'));
    const cap = cliCapOf(config);
    return cap === null ? null : Math.max(0, cap - cliTodayOf().total);
  } catch { return null; }
}

/** The text of the summary file under root, only when the stamp's summary row is PASS and the file is the one the stamp hashed (stamp.summary_sha256). Else null. */
function checkedSummaryText(stamp, root = topOf()) {
  try {
    if (!stamp?.summary_sha256) return null;
    // PASS, or a NOTE the check marked ok (an older Head, a long sentence). A NOTE that hides a real problem has no summary_ok.
    if (!Array.isArray(stamp.results) || !(stamp.summary_ok === true || stamp.results.find((r) => r.step === 'summary')?.status === 'PASS')) return null;
    const text = readFileSync(path.join(root, SUMMARY_REL), 'utf8');
    return hashOf(text) === stamp.summary_sha256 ? text : null;
  } catch { return null; }
}

/** The Change sentence of the checked summary of this checkout, or null. */
const readChange = (stamp) => changeOf(checkedSummaryText(stamp));

const SHA = /^[0-9a-f]{7,40}$/i;
// The summary lookup must never stop the question: each of its git calls ends after this time, and a call that did not end is a failure.
const SUMMARY_GIT_MS = 10000;
const gitQuick = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: SUMMARY_GIT_MS });
const gitOk = (args, cwd) => gitQuick(args, cwd).status === 0;
/** stdout of a git call inside the time limit, or null. */
const gitText = (args, cwd) => { const r = gitQuick(args, cwd); return r.status === 0 ? r.stdout.trim() : null; };

/**
 * True when a summary that pre-pr checked at stampHead still describes the PR at prHead:
 * the two are the same commit, or stampHead is an ancestor and every commit after it that is not on main is a merge commit.
 * Named limit (seat ruling): a merge commit that carries new code still binds. The gate does not use this text.
 * A fix commit after pre-pr does not bind: pre-pr never saw it. Any git failure (a commit this repo does not hold, no main ref) does not bind.
 */
function bindsTo(stampHead, prHead, cwd) {
  const from = String(stampHead ?? '').toLowerCase();
  const to = String(prHead ?? '').toLowerCase();
  if (!SHA.test(from) || !SHA.test(to)) return false;
  if (from.length === 40 && from === to) return true;
  // fork/main when this repo has it; the local main only when it does not. Both together would hide a fix commit that reached the local main only.
  const main = ['refs/remotes/fork/main', 'refs/heads/main'].find((ref) => gitOk(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd));
  if (!main || !gitOk(['merge-base', '--is-ancestor', from, to], cwd)) return false;
  return gitText(['rev-list', '--no-merges', `${from}..${to}`, `^${main}`], cwd) === '';
}

/** This checkout first, then every other worktree of the repo. */
function checkoutRoots() {
  const here = topOf();
  const listed = (gitText(['worktree', 'list', '--porcelain'], here) ?? '').split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim());
  const seen = new Set();
  return [here, ...listed].filter((root) => { const k = path.resolve(root).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** { problem, change, youWillSee } of the checked pre-pr summary whose stamp binds to prHead, or null. Never throws: any read error is null. */
function readSummaryFor(prHead) {
  try {
    for (const root of checkoutRoots()) {
      const stamp = readStamp(root);
      const text = checkedSummaryText(stamp, root);
      if (text && bindsTo(stamp.head, prHead, root)) return summaryFieldsOf(text);
    }
  } catch { /* the question shows the NO_SUMMARY line */ }
  return null;
}

/** { branch, head, stampHead, stampAt, rows, fails, change, cliDetail, costUsd, capLeftUsd, now } for open-pr. */
export async function gatherOpenPr({ branch }) {
  const t = branchTarget(branch, process.cwd());
  const stamp = readStamp();
  const results = Array.isArray(stamp?.results) ? stamp.results : [];
  const cli = results.find((r) => r.step === 'coderabbit');
  return {
    branch: t.name, head: t.head, missing: t.missing === true, stampHead: stamp?.head ?? null, stampAt: stamp?.at ?? null,
    rows: results.length, fails: results.filter((r) => r.status === 'FAIL').length, change: readChange(stamp), cliDetail: cli?.detail ?? null, costUsd: costOfDetail(cli?.detail),
    capLeftUsd: await capLeft(), now: new Date().toISOString(),
  };
}

/** { branch, head, stampHead, stampSkip, runsSpent, unreviewed } for cli-skip: the stamp of this checkout and the run counter of the branch. */
export async function gatherCliSkip({ branch }) {
  const t = branchTarget(branch, process.cwd());
  const stamp = readStamp();
  let runs = [];
  try {
    const { crPaths } = await import('./pre-pr.mjs');
    const counter = JSON.parse(readFileSync(crPaths(topOf(), t.name).counter, 'utf8'));
    runs = Array.isArray(counter?.runs) ? counter.runs : [];
  } catch { /* no counter: 0 runs */ }
  // null (unknown) when no row holds a count: a missing counter must not read as "0 files unreviewed".
  const counts = runs.filter((r) => Number.isInteger(r?.unreviewed)).map((r) => r.unreviewed);
  const unreviewed = counts.length > 0 ? Math.max(...counts) : null;
  return {
    branch: t.name, head: t.head, missing: t.missing === true, stampHead: stamp?.head ?? null,
    stampSkip: stamp?.cr_skipped === true ? stamp.cr_skip_reason ?? null : null, runsSpent: runs.filter((r) => r?.newCode !== false).length, unreviewed,
  };
}

/** True only when SHIP_ASK_TEST=1 and CCV3_DECISIONS_FILE names a store other than the default real one. The test seams (--facts, SHIP_ASK_STATUS_SCRIPT) need both. */
function seamsOn(env = process.env) {
  if (env.SHIP_ASK_TEST !== '1' || !env[DECISIONS_ENV]) return false;
  return path.resolve(env[DECISIONS_ENV]) !== path.resolve(decisionsPath({}));
}
const warnSeam = (name) => console.error(`ship-ask: ignored ${name}: it is a test seam and needs SHIP_ASK_TEST=1 and a temp CCV3_DECISIONS_FILE. The real data path runs.`);

/** The script that reports PR status: review-status.mjs, or SHIP_ASK_STATUS_SCRIPT in test mode only. */
export function statusScriptOf(env = process.env) {
  const real = path.join(HERE, 'review-status.mjs');
  if (!env.SHIP_ASK_STATUS_SCRIPT) return real;
  if (seamsOn(env)) return env.SHIP_ASK_STATUS_SCRIPT;
  warnSeam('SHIP_ASK_STATUS_SCRIPT');
  return real;
}

/** { pr, head, ready, reasons, mergeable, unresolved, isDraft, prState, pathway, by, summary } for land. Runs review-status.mjs (read-only). */
export function gatherLand({ pr }, env = process.env) {
  const script = statusScriptOf(env);
  const r = spawnSync(process.execPath, [script, String(pr), '--repo', DEFAULT_REPO, '--json'], { encoding: 'utf8', windowsHide: true, cwd: topOf() });
  let s;
  try { s = JSON.parse(r.stdout); } catch { throw new Error(`review-status.mjs gave no JSON for PR #${pr} (${one(r.stderr).slice(0, 120)})`); }
  const record = readJson(path.join(topOf(), '.claude', 'cache', 'pre-pr', 'pathway.json'));
  const mine = record && String(record.head).toLowerCase() === String(s.head).toLowerCase() ? record : null;
  const label = (s.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).find((n) => String(n).startsWith('review:'));
  return { pr, head: s.head, ready: s.ready === true, reasons: s.reasons ?? [], mergeable: s.mergeable_state, unresolved: s.unresolved, isDraft: s.isDraft === true, prState: s.prState, pathway: mine?.pathway ?? PATHWAY_OF_LABEL[label] ?? null, by: mine?.decided_by ?? null, summary: readSummaryFor(s.head) };
}

function readJson(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; }
}

/** { pr, head, round, files, today, paidRounds, verdict, reasons, reason, caps } for paid-round. Runs the cr-paid estimate (reads GitHub). */
export async function gatherPaid({ pr }) {
  const { checkPr, LIMITS } = await import('./cr-paid.mjs');
  const r = checkPr({ pr });
  return { ...r, caps: { round: LIMITS.roundCents / 100, day: LIMITS.dayCents / 100, rounds: LIMITS.paidRounds } };
}

// ---------- plan: data -> { spec, key, head, tree } ----------

/** { spec, key, head, tree } for a step and its data, or { refuse } when no question can be asked. */
export function planOf(step, data, args) {
  if (data.missing) return { refuse: `branch ${data.branch} does not exist (no refs/heads/${data.branch} and no fork/${data.branch}). Pass a branch that exists.` };
  if (step === 'commit-and-push') {
    // Push only binds HEAD's tree (no index tree exists to bind: nothing is staged). Commit and push binds the staged tree.
    const spec = shipSpec(data);
    const tree = spec.options[0].label.startsWith('Push only') ? data.headTree : data.tree;
    return { spec, key: decisionKey({ branch: data.branch }), head: data.head, tree: tree ?? null };
  }
  if (step === 'open-pr') {
    const ok = data.stampHead && data.fails === 0 && String(data.stampHead).toLowerCase() === String(data.head).toLowerCase();
    return { spec: ok ? openPrSpec(data) : rerunPrePrSpec(data), key: decisionKey({ branch: data.branch }), head: data.head, tree: null };
  }
  if (step === 'cli-skip') {
    const same = data.stampHead && data.head && String(data.stampHead).toLowerCase() === String(data.head).toLowerCase();
    if (data.stampSkip !== 'flag' || !same) return { refuse: `there is no flag stamp for ${data.branch} at ${String(data.head).slice(0, 7)}. Run node scripts/github/pre-pr.mjs --skip-cr --body <file> first: the question follows its stamp.` };
    return { spec: cliSkipSpec(data), key: decisionKey({ branch: data.branch }), head: data.head, tree: null };
  }
  const key = decisionKey({ pr: args.pr });
  if (step === 'paid-round') return { spec: paidRoundSpec(data), key, head: data.head, tree: null };
  if (data.isDraft) return { refuse: `PR #${args.pr} is a draft. Call pr_checkpoint {pr} first: land needs a ready PR.` };
  if (data.prState && data.prState !== 'open') return { refuse: `PR #${args.pr} is ${data.prState}, not open.` };
  return { spec: landSpec(data), key, head: data.head, tree: null };
}

// ---------- CLI ----------

const VALUE_FLAGS = ['--pr', '--branch', '--msg', '--facts'];

function parseArgs(argv) {
  const [step, ...rest] = argv;
  if (!Object.hasOwn(STORE_STEP, step ?? '')) return { error: `the step must be one of ${Object.keys(STORE_STEP).join(', ')}` };
  const o = { step, json: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--json') { o.json = true; continue; }
    if (!VALUE_FLAGS.includes(rest[i]) || rest[i + 1] === undefined || rest[i + 1].startsWith('--')) return { error: `bad argument ${rest[i]}` };
    o[rest[i].slice(2)] = rest[++i];
  }
  const byPr = step === 'land' || step === 'paid-round';
  if (byPr && !/^[1-9]\d*$/.test(o.pr ?? '')) return { error: `${step} needs --pr N` };
  if (!byPr && o.pr !== undefined) return { error: `${step} takes --branch, not --pr` };
  if (step !== 'commit-and-push' && o.msg !== undefined) return { error: '--msg is a commit-and-push flag' };
  return { o: { ...o, pr: byPr ? Number(o.pr) : undefined } };
}

async function dataOf(o) {
  if (o.facts) {
    if (seamsOn()) return JSON.parse(readFileSync(o.facts, 'utf8'));
    warnSeam('--facts');
  }
  if (o.step === 'commit-and-push') return gatherShip({ branch: o.branch, msg: o.msg });
  if (o.step === 'open-pr') return gatherOpenPr({ branch: o.branch });
  if (o.step === 'cli-skip') return gatherCliSkip({ branch: o.branch });
  return o.step === 'land' ? gatherLand({ pr: o.pr }) : gatherPaid({ pr: o.pr });
}

const textOf = (spec) => [`${spec.header}: ${spec.question}`, ...spec.options.map((x, i) => `  ${i + 1}. ${x.label} - ${x.description}`)].join('\n');

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`ship-ask: usage: ${parsed.error}. node scripts/github/ship-ask.mjs <commit-and-push|open-pr|land|paid-round|cli-skip> [--pr N | --branch B] [--msg file] [--json] [--facts f.json]`);
    process.exit(2);
  }
  const { o } = parsed;
  try {
    const plan = planOf(o.step, await dataOf(o), o);
    if (plan.refuse) { console.error(`ship-ask: no question: ${plan.refuse}`); process.exit(1); }
    if (!plan.head || !plan.key) { console.error('ship-ask: no question: the head or the branch could not be read.'); process.exit(1); }
    const w = offerWrite({ step: STORE_STEP[o.step], key: plan.key, head: plan.head, spec: plan.spec, tree: plan.tree, cwd: process.cwd() });
    if (!w.ok) { console.error(`ship-ask: the offer was not written (${w.reason}). Do not ask.`); process.exit(1); }
    console.log(o.json ? JSON.stringify(plan.spec) : textOf(plan.spec));
  } catch (err) {
    console.error(`ship-ask: could not build the question (${String(err.message).split('\n')[0]})`);
    process.exit(3);
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) await main();
