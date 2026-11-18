#!/usr/bin/env node
/**
 * pr-checkpoint.mjs: the recommendation engine of the PR Checkpoint mod (PR A, read-only).
 * Spec: .claudedocs/2026-10-28-pr-checkpoint-mod-spec.md section 2. Tests: pr-checkpoint.test.mjs.
 * Given the stamp, the changed files and the credit state, it picks one review pathway for a draft PR:
 * none, coderabbit or both (or wait when the CodeRabbit 7-day count is high). It spends nothing and writes nothing.
 *
 * PR B adds two modes that write or spend. Only Dave's press in the /pathway mod runs them (the pre-pr-gate hook denies
 * a shell that names pr-checkpoint with --confirm or --apply).
 *
 * Usage: node scripts/github/pr-checkpoint.mjs [--json] [--probe] [--pr <n>] [--facts facts.json] [--config router-config.json]
 *   --json     print the result as one JSON object (default: plain lines).
 *   --pr       the PR number the live capacity fact reads (its comments and cache). Default: the PR of the current branch.
 *   --probe    let the run post ONE free "@coderabbitai rate limit" comment (not a review) to learn whether a CodeRabbit slot is free. Without it the
 *              run only reads (PR notices, the cache, the queue state file, cr usage) and never posts. It posts only with --json and --pr, when no
 *              notice or cache answers, a question will be shown (the result is not stopped and auto-confirm does not cover the PR), and
 *              `gh pr view <n>` says state OPEN and isDraft true. Only the /pathway mod's prepare call passes it. --confirm and --apply never post.
 *              Kill switches: capacity.post_rate_limit_probe false in the config, or the env var PR_CHECKPOINT_NO_PROBE=1.
 *   --dependabot  the PR is a Dependabot PR. PR B's mod passes it from the PR author (the authoritative source).
 *              Without it, the real run derives it from base...HEAD: every commit author is dependabot[bot].
 *   --facts    read the facts from a JSON file, not from git and the stamp (tests, like review-router.mjs --fixture).
 *   --config   the router config (default: review-router.config.json of this checkout).
 *
 * node scripts/github/pr-checkpoint.mjs --confirm <none|coderabbit|both> --by <dave|default|auto> --body <draft.md> [--state-dir <dir>]
 *   Records the pathway in <state-dir>/pathway.json and prints the record. It refuses (exit 1, nothing written) when the stamp is
 *   missing, for another head or has a FAIL row; the body hash differs from the stamp; the pathway is wait, not offered or held; or
 *   --by default names a pathway that is not the recommendation; or --by auto names anything but `none`, or the result's `auto`
 *   block is not eligible (autoOf: kill switch checkpoint.autoConfirm, band LOW/MID/ELEVATED, no security-tier or critical file, no drift, labels read). The state dir holds stamp.json and pathway.json. Default:
 *   <git toplevel of the cwd>/.claude/cache/pre-pr. --facts and --config work as above (tests).
 *   Flag checkpoint.ledger (review-router.config.json, default false): see lib/checkpoint-ledger.mjs. With it true, `--json --pr N` adds a `ledger` block (the
 *   two-call protocol: state ask, record, kept-draft, stop or none; `ledger.ask` is the AskUserQuestion spec) and writes the offer to the decision
 *   store; --no-ledger turns that off for one run; --ask-anyway keeps the question open for an auto-eligible PR (the mod passes it after a failed auto-confirm). And a confirm by dave with --pr N records only when Dave's tap for the pathway is in the store (a tap on a paid
 *   row carries its price and is the paid yes); --by default records nothing. The tap is used up after the record.
 * node scripts/github/pr-checkpoint.mjs --apply <pr> [--state-dir <dir>]
 *   Reads pathway.json, checks the live PR (a draft, at the recorded head), adds the review label, then marks it ready. The label
 *   comes first, and a failed label never reaches ready. gh is the real gh, or `node $PR_CHECKPOINT_GH` (tests).
 * Exit 0 = done (a result was printed, including the R0 stop: recommended null). 1 = refused, or gh failed. 2 = bad usage (nothing read or written). 3 = internal error.
 * Without --facts it runs `git fetch fork main` (spec section 2; it moves only refs/remotes/fork/main), then reads
 * `git diff --name-status -M` and `--numstat` against fork/main, the pre-pr stamp, and the saved CLI review output of the head.
 * The base ref and its commit go into why[]. A failed fetch, or a missing fork/main, adds a "may be stale" warning.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPO, bandOf, classify, creditsState, matchGlob, renderPathwayMarker, route } from './review-router.mjs';
import { STAMP_REL, parseAgentStream } from './pre-pr.mjs';
import { monthOf } from './cr-paid.mjs';
import { capacityFact, idleCapacity, parseRateLimitReply } from './lib/capacity-fact.mjs';
import { ledgerConfirmProblem, ledgerStep, ledgerUse } from './lib/checkpoint-ledger.mjs';

export { capacityFact, parseRateLimitReply };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

let workTopCache;
/**
 * The git toplevel of the cwd: the checkout whose state dir the hook reads and pre-pr.mjs writes. Outside a checkout: this script's checkout.
 * Every fact (head, files, config drift, saved CLI output) comes from it, so a script run from one checkout never mixes in another's facts.
 */
function workTop() {
  if (workTopCache === undefined) {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
    workTopCache = r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : ROOT;
  }
  return workTopCache;
}

/** A file of the work checkout, else the same file of this script's checkout. */
const workFile = (name) => (existsSync(path.join(workTop(), name)) ? path.join(workTop(), name) : path.join(ROOT, name));

/** The record --confirm writes and the pre-pr-gate hook reads. Same directory as the stamp (STAMP_REL). */
export const PATHWAY_REL = '.claude/cache/pre-pr/pathway.json';
const STATE_REL = path.posix.dirname(PATHWAY_REL);

const GREPTILE_COST = 3;
const PATHWAY_RANK = { none: 0, coderabbit: 1, both: 2 };
const LABELS = { none: 'review:none', coderabbit: 'review:coderabbit', both: 'review:deep', wait: null };
const QUIET_DIRS = ['thoughts/', 'artifacts/', '.claudedocs/'];
const MAJOR_SEVERITIES = ['critical', 'major'];

// ---------- inputs: pure helpers ----------

/** The `reviews.path_filters` list of .coderabbit.yaml: a block of "- item" lines under that key. Quotes and comments are stripped. */
export function pathFiltersFrom(yamlText) {
  const lines = String(yamlText ?? '').split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s+path_filters:\s*(#.*)?$/.test(l));
  if (at < 0) return [];
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const m = /^\s+-\s+(.*)$/.exec(line);
    if (!m) break;
    const item = m[1].replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
    if (item) out.push(item);
  }
  return out;
}

/** The rows of `git diff --name-status -M`. A rename row "R100<TAB>old<TAB>new" keeps both names. */
export function parseNameStatus(text) {
  return String(text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '').map((line) => {
    const [status, ...names] = line.split('\t');
    if (/^[RC]/.test(status) && names.length === 2) {
      return { filename: names[1], ...(status[0] === 'R' ? { previous_filename: names[0] } : {}) };
    }
    return { filename: names[0] };
  });
}

/** `git diff --numstat -z -M`: filename (the new name of a rename) -> { additions, deletions }. A binary file counts 0. */
export function parseNumstatZ(text) {
  const counts = new Map();
  const parts = String(text ?? '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[i]);
    if (!m) continue;
    const name = m[3] === '' ? parts[(i += 2)] : m[3];
    counts.set(name, { additions: Number(m[1]) || 0, deletions: Number(m[2]) || 0 });
  }
  return counts;
}

const DEPENDABOT_EMAIL = /^(?:\d+\+)?dependabot\[bot\]@users\.noreply\.github\.com$/i;

/** `git log --format=%ae` of base..HEAD: true when there is at least one commit and every author is dependabot[bot]. */
export function isDependabotAuthors(text) {
  const emails = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return emails.length > 0 && emails.every((e) => DEPENDABOT_EMAIL.test(e));
}

/** The base ref of the diff and the why[] line that names it. A base that was not fetched warns that it may be stale. */
export function resolveBase({ fetched, hasFork, sha }) {
  const ref = hasFork ? 'fork/main' : 'main';
  const at = `Base ${ref} at ${String(sha ?? 'unknown').slice(0, 7)}`;
  if (fetched && hasFork) return { ref, notes: [`${at} (fetched).`] };
  const why = hasFork ? 'git fetch fork main failed' : 'no fork/main ref, so local main is used';
  return { ref, notes: [`${at}: ${why}. This base may be stale, and the file list, class and recommendation may be wrong.`] };
}

const pathsOf = (files) => [...new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))];
const tagged = (paths, globs = []) => paths.filter((p) => globs.some((g) => matchGlob(g, p)));

/** A file is reviewable unless a "!glob" path filter excludes it (an include glob, when any exists, must match). */
export function reviewableFiles(files, filters = []) {
  const skip = filters.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  const keep = filters.filter((g) => !g.startsWith('!'));
  return files.filter((f) => !skip.some((g) => matchGlob(g, f.filename)) && (keep.length === 0 || keep.some((g) => matchGlob(g, f.filename))));
}

/** files: reviewable files. lines: additions plus deletions. added: additions alone (the small rule RS reads it). */
const sizeOf = (reviewable) => ({
  files: reviewable.length,
  lines: reviewable.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0),
  added: reviewable.reduce((n, f) => n + (f.additions ?? 0), 0),
});

const budgetPair = (b) => (Array.isArray(b) ? [b[0] ?? 0, b[1] ?? 0] : [Number(b) || 0, 0]);
const classBudget = (policy, cls) => budgetPair(policy.budget?.[cls] ?? policy.budget?.normal ?? [1, 1]);

// ---------- state: capacity, Greptile, CLI ----------

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** A dated manual count is stale when the date is invalid, in the future, or over 7 days before `now`. An undated count is taken as given. */
function isStale(date, now) {
  if (!date) return false;
  const age = Date.parse(now) - Date.parse(date);
  return !Number.isFinite(age) || age < 0 || age > WEEK_MS;
}

function capacityOf(policy, now) {
  const n = policy.coderabbit?.reviews_7d_manual;
  const date = policy.coderabbit?.reviews_7d_manual_date ?? null;
  const count = Number.isInteger(n) && n >= 0 ? n : null;
  if (count !== null && isStale(date, now)) {
    return { count, band: 'unknown', warning: `CodeRabbit 7-day count ${count} is from ${date}, over 7 days old: update reviews_7d_manual.`, source: 'manual', date };
  }
  const band = count === null ? 'unknown' : count >= 40 ? 'high' : count >= 30 ? 'warn' : 'ok';
  const warning = band === 'warn' || band === 'high' ? `CodeRabbit 7-day count is ${count}: warn at 30; the rate drops to 6/h at 40.` : null;
  return { count, band, warning, source: count === null ? null : 'manual', date };
}

/**
 * The capacity of the result. facts.capacity (the live fact, capacity-fact.mjs) wins when its state is known: free is band ok, wait is band
 * high, and the hand-set count is dropped (it is stale). An unknown fact, or none (a fixture), keeps the old band logic (capacityOf), plus the
 * fact's fields. A fact object always clears the stale-count warning (the mod would print "update reviews_7d_manual" beside a live answer).
 * The legacy `source` stays as capacityOf gives it (null once the count is dropped); the fact's own source goes to `factSource`.
 */
function resultCapacity(policy, facts) {
  const live = facts.capacity;
  if (!live || typeof live !== 'object') return capacityOf(policy, facts.now);
  const { source, ...fields } = live;
  const known = live.state === 'free' || live.state === 'wait';
  const legacy = known ? { count: null, band: live.state === 'free' ? 'ok' : 'high', date: null, source: null } : capacityOf(policy, facts.now);
  return { ...legacy, ...fields, warning: null, source: legacy.source, factSource: source ?? null };
}

/**
 * Greptile is available only when the router holds nothing, the credit count is known and 3 credits are left.
 * Empty labels, because a present review:deep clears the router hold. A non-deep class is held like steering (not r3).
 */
function greptileOf(cls, policy, credits) {
  const held = route(cls === 'r3' ? 'r3' : 'steering', [], policy, credits).held;
  if (held) return { available: false, reason: `Greptile held: ${held}` };
  if (credits.used === null) return { available: false, reason: 'Greptile held: credits unknown' };
  const left = policy.greptile.monthly_credits - credits.used;
  if (!(left >= GREPTILE_COST)) return { available: false, reason: `Greptile held: ${left} credits left, ${GREPTILE_COST} needed` };
  return { available: true, reason: 'CodeRabbit now, Greptile once on the final head' };
}

const cliClean = (cli) => cli !== null && MAJOR_SEVERITIES.every((s) => !cli.bySeverity?.[s]);

/** R0: why the checkpoint must stop, or null. A NOTE or SKIP row does not stop it. */
function stampProblem(facts) {
  const { stamp } = facts;
  if (!stamp) return 'No pre-pr stamp. Run node scripts/github/pre-pr.mjs --body <draft.md> first.';
  if (stamp.head !== facts.head) return 'The pre-pr stamp is for another head. Run node scripts/github/pre-pr.mjs again.';
  const failed = (stamp.results ?? []).filter((r) => r.status === 'FAIL');
  return failed.length ? `The pre-pr stamp has a failed row (${failed.map((r) => r.step).join(', ')}). Fix it and run pre-pr.mjs again.` : null;
}

// ---------- rules: each returns a hit {rule, pathway, budget, why} or null ----------

const hit = (rule, pathway, budget, why) => ({ rule, pathway, budget, why });
const list = (paths) => paths.join(', ');

/**
 * The spec 3.1 floor: the PR touches a matrix.security_tier or a checkpoint.critical file. Below HIGH it sets an internal review
 * floor, not a bot floor: aegis + critic run before READY (rule RF), so auto-confirm never records the PR. Same body in PR A and B.
 */
export function floorApplies(c) {
  return Boolean(c.band?.securityTier?.length || c.critical.length);
}

/** The floor's cause for a why line: "Security-tier floor (a)", "Critical-file floor (b)", or both joined by "and". */
function floorLabel(c) {
  const tier = c.band.securityTier;
  const crit = c.critical.filter((p) => !tier.includes(p));
  const parts = [tier.length ? `security-tier floor (${list(tier)})` : '', crit.length ? `critical-file floor (${list(crit)})` : ''];
  const text = parts.filter(Boolean).join(' and ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function parserRule(c) {
  if (c.parser.length === 0) return null;
  return hit('R2', 'coderabbit', [1, 0], [`Parser file ${list(c.parser)}. Do not loop. Use a vetted parser.`]);
}

function greptileRule(rule, label, c) {
  const both = c.greptile.available;
  return hit(rule, both ? 'both' : 'coderabbit', c.classBudget, [`${label}: ${both ? 'Greptile is available, so both bots.' : `${c.greptile.reason}.`}`]);
}

const criticalRule = (c) => (c.critical.length ? greptileRule('R3', `Critical file ${list(c.critical)}`, c) : null);
const r3Rule = (c) => (c.cls === 'r3' ? greptileRule('R4', 'Class r3', c) : null);

/** Why a PR is docs-only (class docs, or only thoughts/, artifacts/ and .claudedocs/ paths), or null. Only these skip the CodeRabbit trigger. */
function docsOnlyReason(c) {
  if (c.cls === 'docs' || c.budgetClass === 'docs') return `Class docs (first file ${c.paths[0] ?? 'none'}): no bot review.`;
  const quiet = c.paths.every((p) => QUIET_DIRS.some((d) => p.startsWith(d)));
  return quiet ? `Only thoughts/, artifacts/ or .claudedocs/ paths (first file ${c.paths[0] ?? 'none'}): no bot review.` : null;
}

function noneReason(c) {
  const docs = docsOnlyReason(c);
  if (docs) return docs;
  return c.size.lines === 0 ? 'No reviewable lines: every path is filtered or a build output.' : null;
}

function noneRule(c) {
  const why = noneReason(c);
  return why ? hit('R1', 'none', [0, 0], [why]) : null;
}

/** RS limits (constants: a config key would be a persistent format change). */
const SMALL_FILES = 3;
const SMALL_ADDED = 30;

/** Why the CLI review is not clean, for the RS why line. */
function cliProblem(cli) {
  if (cli === null) return 'there is no completed CLI review of this head';
  return 'the CLI review found a Major or Critical finding';
}

/**
 * RS: a small PR (3 files or fewer, 30 added lines or fewer; class normal, steering or infra).
 * A clean CLI review gives none. A Major, a Critical or no CLI result gives CodeRabbit at 1+0.
 * It runs after R1 to R4 and Dependabot, so a stronger rule always wins.
 */
function smallRule(c) {
  if (!['normal', 'steering', 'infra'].includes(c.budgetClass)) return null;
  if (c.size.files > SMALL_FILES || c.size.added > SMALL_ADDED) return null;
  const sized = `${c.size.files} file(s), ${c.size.added} added line(s); the limit is ${SMALL_FILES} files and ${SMALL_ADDED} added lines`;
  if (cliClean(c.cli)) return hit('RS', 'none', [0, 0], [`Small PR (${sized}) and a clean CLI review: no bot review.`]);
  return hit('RS', 'coderabbit', [1, 0], [`Small PR (${sized}), but ${cliProblem(c.cli)}: CodeRabbit 1+0.`]);
}

/**
 * The CodeRabbit PR bot is scarce ($0.25 a file, $50 a month). Interim rule (Dave 2026-11-04): a HIGH or CRITICAL PR earns it only through
 * (a) the risk:high label, or (b) band CRITICAL plus a changed matrix.security_tier or CRITICAL_TRUST_BOUNDARY file. Returns the cause text, or null.
 * Band CRITICAL from an r3 path alone, or from a checkpoint.critical file, earns nothing. Docs-only PRs are cut before this (docsOnlyReason); a zero-line code PR is not.
 */
function crTrigger(b) {
  if (b.labelHigh) return 'the risk:high label';
  const named = [...new Set([...(b.securityTier ?? []), ...(b.trustFiles ?? [])])];
  return b.band === 'CRITICAL' && named.length ? `band CRITICAL with ${list(named)} (security-tier or trust-boundary file)` : null;
}

/** The cap in files from coderabbit.monthly_file_cap, or null (no cap) when the key is missing or not a whole number of 0 or more. */
const monthCapOf = (policy) => {
  const cap = policy.coderabbit?.monthly_file_cap;
  return Number.isInteger(cap) && cap >= 0 ? cap : null;
};

const LEDGER_NOTE = 'ledger month-to-date counts paid rounds only, so it undercounts reviews that used a free slot';

/**
 * Why the month cap stops a CodeRabbit recommendation, or null. facts.ledger_month_files: a number (the ledger count), null (the ledger
 * could not be read: fail closed, no spend recommended) or absent (a fixture: not checked). Over the cap means count + this PR's files > cap.
 */
function monthCapProblem(c) {
  if (c.monthCap === null || c.monthFiles === undefined) return null;
  if (c.monthFiles === null) return `The CodeRabbit ledger could not be read, so the month cap of ${c.monthCap} file(s) cannot be checked. No CodeRabbit recommendation; press CodeRabbit by hand if you want it.`;
  if (c.monthFiles + c.size.files <= c.monthCap) return null;
  return `Month cap: ${c.monthFiles} file(s) reviewed this month (${LEDGER_NOTE}) plus ${c.size.files} reviewable file(s) in this PR is over the cap of ${c.monthCap} (coderabbit.monthly_file_cap). No CodeRabbit recommendation; press CodeRabbit by hand if you want it.`;
}

/** The real trigger of a band, for a reason line: the first critical file, the risk:high label, the first gate file, else the first changed file. */
function triggerOf(c) {
  const b = c.band;
  if (c.critical.length) return `critical file ${c.critical[0]}`;
  if (b.labelHigh) return 'the risk:high label';
  if (b.gateFiles?.length) return `gate file ${b.gateFiles[0]}`;
  return `first file ${c.paths[0] ?? 'none'}, band ${b.band}`;
}

/**
 * RB (review matrix, option A, interim CodeRabbit rule 2026-11-04): the band decides. LOW, MID and ELEVATED get no CodeRabbit PR bot. HIGH and
 * CRITICAL get it at the matrix.bot_budget only when crTrigger names a cause, the PR is not docs-only and the month cap is not over.
 * Everything else is none. Dave can still press CodeRabbit (an escalation); this is only the recommendation.
 */
function bandRule(c) {
  const b = c.band;
  const tier = b.securityTier?.length ? `, security-tier file(s) ${list(b.securityTier)}` : '';
  const facts = `score ${b.score}: ${b.G} gate file(s)${b.C ? ', a review config file' : ''}${b.K ? ', logic code' : ''}${tier}`;
  const head = `Band ${b.band} (${facts})`;
  if (!['HIGH', 'CRITICAL'].includes(b.band)) {
    return hit('RB', 'none', [0, 0], [`${head}: no CodeRabbit PR bot below HIGH (trigger: ${triggerOf(c)}). The internal review stack covers it.`]);
  }
  const docs = docsOnlyReason(c);
  if (docs) return hit('RB', 'none', [0, 0], [`${head}: ${docs} A docs-only PR gets no CodeRabbit PR bot, even with risk:high (interim rule).`]);
  const cause = crTrigger(b);
  if (!cause) {
    return hit('RB', 'none', [0, 0], [`${head}: no CodeRabbit PR bot under the interim rule (trigger: ${triggerOf(c)}). It needs the risk:high label, or band CRITICAL with a trust-boundary or security-tier file. The internal review stack covers it.`]);
  }
  const capped = monthCapProblem(c);
  if (capped) return hit('RB', 'none', [0, 0], [`${head}: ${capped}`]);
  const budget = budgetPair(c.botBudget[b.band] ?? [1, 1]);
  const month = typeof c.monthFiles === 'number' ? ` Month-to-date ${c.monthFiles} of ${c.monthCap ?? 'no cap'} file(s) (${LEDGER_NOTE}).` : '';
  return hit('RB', 'coderabbit', budget, [`${head}: CodeRabbit ${budget[0]}+${budget[1]}. Cause: ${cause}.${month}`]);
}

const fallbackRule = (c) => hit('R5', 'coderabbit', c.classBudget, [`Class ${c.budgetClass} (reviewable paths): CodeRabbit ${c.classBudget[0]}+${c.classBudget[1]}.`]);

/** Dependabot wins over every rule: bots refuse bot PRs. A critical or parser file is named so the person reviews it. */
function dependabotRule(c) {
  const named = [...c.critical.map((p) => ['critical', p]), ...c.parser.map((p) => ['parser', p])];
  return hit('R1', 'none', [0, 0], [
    'Dependabot PR: bots refuse bot PRs, so no review is bought.',
    ...named.map(([kind, p]) => `Dependabot PR touches ${kind} file ${p}; bots refuse bot PRs, review it yourself.`),
  ]);
}

function hitsFor(c) {
  if (c.dependabot) return [dependabotRule(c)];
  if (c.band) return bandHits(c);
  const matched = [parserRule(c), criticalRule(c), r3Rule(c)].filter(Boolean);
  if (matched.length) return matched;
  return [noneRule(c) ?? smallRule(c) ?? fallbackRule(c)];
}

/**
 * RF (spec 3.1, option A): the security-tier floor below HIGH. A security-tier or critical file sets an internal review floor, not a
 * bot floor: the pathway stays none, and the why line says aegis + critic must pass before READY. HIGH and CRITICAL keep R2 to R4.
 */
function floorRule(c) {
  if (!floorApplies(c)) return null;
  return hit('RF', 'none', [0, 0], [`${floorLabel(c)}: run the internal pass (aegis + critic) before READY. No CodeRabbit PR bot; press CodeRabbit to escalate.`]);
}

/** With a matrix block the band rule replaces R1, RS and R5. A HIGH or CRITICAL PR keeps R2, R3 and R4 beside it (parser budget, Greptile). */
function bandHits(c) {
  const rb = bandRule(c);
  if (rb.pathway === 'none') return [rb, floorRule(c)].filter(Boolean);
  return [rb, ...[parserRule(c), criticalRule(c), r3Rule(c)].filter(Boolean)];
}

function combine(hits) {
  const pathway = hits.reduce((best, h) => (PATHWAY_RANK[h.pathway] > PATHWAY_RANK[best] ? h.pathway : best), 'none');
  // Dave 2026-10-28: a parser file (R2) means one review and no loop, so R2's budget beats R3's. R4 (class r3) keeps its own.
  // The same holds for RB: a parser file in a HIGH PR still means one review and no loop.
  const counted = hits.some((h) => h.rule === 'R2') ? hits.filter((h) => h.rule !== 'R3' && h.rule !== 'RB') : hits;
  const budget = counted.reduce((b, h) => [Math.max(b[0], h.budget[0]), Math.max(b[1], h.budget[1])], [0, 0]);
  return { pathway, budget, why: hits.flatMap((h) => h.why), rules: hits.map((h) => h.rule) };
}

// ---------- options ----------

function orderFor(c, picked) {
  if (c.dependabot) return ['none']; // bots refuse bot PRs: no paid option is offered (Dave decision 3)
  // A result with no review band (a config with no matrix block) keeps the old lists: none only where a rule or a clean CLI gave it.
  return c.band ? withNone(paidOrder(c, picked)) : paidOrder(c, picked);
}

/**
 * "No review, land on CI" is an option at every review band (Dave 2026-11-04): a PR that a person will land on CI alone must not need a hand press
 * of GitHub's "Ready for review". It is last, so the recommendation stays first, and it is never the recommendation of a HIGH or CRITICAL PR.
 * Only a person records it there: --by default needs the recommendation, and --by auto needs autoOf (band LOW, MID or ELEVATED).
 * A list that has it already (R5 with a clean CLI, a LOW to ELEVATED band) keeps its own place.
 */
const withNone = (order) => (order.includes('none') ? order : [...order, 'none']);

function paidOrder(c, picked) {
  const only = (rule) => picked.rules.length === 1 && picked.rules[0] === rule;
  const band = picked.rules[0] === 'RB' && picked.rules.every((r) => r === 'RB' || r === 'RF');
  if (only('R1') || band) return picked.pathway === 'none' ? ['none', 'coderabbit'] : ['coderabbit', 'both'];
  const waitFirst = c.capacity.band === 'high' ? ['wait'] : [];
  if (only('RS')) return picked.pathway === 'none' ? ['none', 'coderabbit', 'both'] : [...waitFirst, 'coderabbit', 'both'];
  if (only('R5')) return [...waitFirst, 'coderabbit', ...(cliClean(c.cli) ? ['none'] : []), 'both'];
  return picked.pathway === 'both' ? ['both', 'coderabbit'] : ['coderabbit', 'both'];
}

const atLeast = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1])];

/**
 * What an option costs, from its own pathway and not from the recommendation. The pair stays CodeRabbit opening+extra.
 * coderabbit: the rule budget when a rule picked CodeRabbit or more, else the class budget, never below 1+0.
 *   When RS is the only rule, a chosen CodeRabbit review costs 1+0, not the class budget.
 * both: max(rule budget, class budget, 1+1), so a both option never looks free. This 1+1 floor is display only: optionOf.budget
 *   (what confirmRecord stores as pathway.json.budget) is max(rule budget, class budget) floored at 1+0 (Dave 11-04).
 */
function costOf(c, picked, pathway) {
  if (pathway === 'coderabbit' && picked.rules.length === 1 && picked.rules[0] === 'RS') return [1, 0];
  if (pathway === 'coderabbit') return atLeast(picked.pathway === 'none' ? c.classBudget : picked.budget, [1, 0]);
  if (pathway === 'both') return atLeast(atLeast(picked.budget, c.classBudget), [1, 1]);
  return [0, 0];
}

/** The pair confirmRecord stores for an option: coderabbit its price, both max(rule, class) floored 1+0 (not the 1+1 display floor), none and wait 0+0. */
function budgetOf(c, picked, pathway, cost) {
  if (pathway === 'coderabbit') return cost;
  if (pathway === 'both') return atLeast(atLeast(picked.budget, c.classBudget), [1, 0]);
  return [0, 0];
}

function optionOf(c, picked, pathway) {
  const cost = costOf(c, picked, pathway);
  // RF: the none option must not contradict the floor line, which asks for aegis + critic before READY.
  const floor = picked.rules.includes('RF') || floorApplies(c);
  const reason = {
    none: floor ? 'No bot review. READY needs CI, proof and the internal pass (aegis + critic).' : 'No bot review. READY needs CI and proof only.',
    wait: c.capacity.state === 'wait' ? `Stay a draft and spend nothing${nextSlotText(c.capacity)}.` : 'Stay a draft and spend nothing until the CodeRabbit 7-day count drops.',
    coderabbit: `CodeRabbit ${cost[0]}+${cost[1]}.`,
    both: c.greptile.reason,
  }[pathway];
  return { pathway, label: LABELS[pathway], available: pathway === 'both' ? c.greptile.available : true, cost, budget: budgetOf(c, picked, pathway, cost), reason };
}

/** When the next slot opens, from the live fact: "about 2026-11-06T18:20:00.000Z (in 20 min)", or "" when the fact names no time. */
const nextSlotText = (cap) => (cap.nextSlotAt ? ` until about ${cap.nextSlotAt} (in ${cap.minutesToSlot} min)` : '');

/** Why wait is the default: the live slot fact when it says wait, else the hand-set 7-day count. */
function waitText(cap) {
  if (cap.state === 'wait') return `CodeRabbit has no free slot${nextSlotText(cap)}: wait is the default. It never blocks.`;
  return `CodeRabbit 7-day count is ${cap.count}: wait is the default at 40 or more. It never blocks.`;
}

function waitWhy(c, picked) {
  const only = picked.rules.length === 1 && ['R5', 'RS'].includes(picked.rules[0]);
  // A clean small PR (RS, none) buys no review, so there is nothing to wait for.
  const buys = picked.pathway === 'coderabbit';
  return only && buys && c.capacity.band === 'high' ? { recommended: 'wait', why: [waitText(c.capacity)] } : null;
}

// ---------- auto-confirm (review factory step A, Dave 2026-11-01) ----------

/** Bands whose recommendation is `none`: the internal review stack covers them. HIGH and CRITICAL always go to Dave. */
const AUTO_BANDS = ['LOW', 'MID', 'ELEVATED'];

/**
 * The bands an autoConfirm value covers: the literal true is LOW, MID and ELEVATED (the first switch), the word "low" is LOW only
 * (Dave 2026-11-06), anything else is none (off).
 */
const autoBandsOf = (value) => (value === true ? AUTO_BANDS : value === 'low' ? ['LOW'] : []);

/**
 * May the mod record `none` without Dave's press? Fails closed: every doubt is "no, Dave presses". Only a literal `true` or the word "low" in
 * checkpoint.autoConfirm turns it on (the kill switch; false turns it off). The band must be known and below HIGH, with no security-tier
 * or critical file (floorApplies, spec 3.1: that floor needs aegis + critic before READY, so Dave presses), the config must match main, the PR
 * labels must have been read (an absent list is as bad as a failed read), and the recommendation must be `none`.
 * HIGH with a free CodeRabbit slot is not covered: the slot is not readable without the pr-loop poller's queue (spec 3.7), and the
 * 7-day count is a hand-set number, so a HIGH PR keeps Dave's press.
 */
export function autoOf(c, facts, policy, recommended) {
  const band = c.band?.band ?? null;
  const no = (reason) => ({ eligible: false, band, reason });
  const covered = autoBandsOf(policy.checkpoint?.autoConfirm);
  if (covered.length === 0) return no('checkpoint.autoConfirm is not true or "low" in review-router.config.json: Dave presses.');
  if (!band) return no('The PR has no review band (no matrix block): Dave presses.');
  if (!covered.includes(band)) return no(`Band ${band}: Dave presses. Auto-confirm (checkpoint.autoConfirm) covers ${covered.join(', ')} only.`);
  if (floorApplies(c)) return no(`${floorLabel(c)}: the internal pass (aegis + critic) runs before READY, so Dave presses.`);
  if (facts.config_drift) return no(`${driftWhy(facts.config_drift)}: Dave presses.`);
  if (!Array.isArray(facts.labels)) return no('The PR labels were not read: Dave presses.');
  if (recommended !== 'none') return no(`The recommendation is ${recommended ?? 'stopped'}, not none: Dave presses.`);
  return { eligible: true, band, reason: `Band ${band} is recommended none (trigger: ${triggerOf(c)}): no CodeRabbit PR bot, the internal review stack covers it.` };
}

// ---------- recommend ----------

/** The drift text, or null. facts.config_drift: true or 'differs' (the configs differ), 'unread' (main's config is missing or not JSON). */
function driftWhy(drift) {
  if (!drift) return null;
  return drift === 'unread' ? "Main's review-router.config.json is missing or not JSON, so it counts as drift" : 'Branch config differs from main';
}

/**
 * Fail closed: the PR labels could not be read (facts.labels is null), so a risk:high label may be hiding. At any band that could
 * turn a PR that earns CodeRabbit into `none` (the interim rule reads the label at HIGH too), so the checkpoint stops (recommended null,
 * like R0). A Dependabot PR gets none whatever its labels. facts.labels absent means a caller that supplies no labels (a fixture);
 * only null means "tried and failed".
 */
function labelsProblem(c, facts) {
  if (!c.band || facts.labels !== null || c.dependabot) return null;
  return 'Could not read the PR labels (gh pr view failed, or there is no PR for this branch). The band needs the risk:high label, so no pathway is recommended. Open the draft PR, check gh, and call pr_checkpoint {pr} again.';
}

function clockOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error('facts.now must be an ISO time');
  return d;
}

function contextOf(facts, policy) {
  const paths = pathsOf(facts.files);
  const { class: cls, matched } = classify(paths, policy);
  const credits = creditsState(policy, clockOf(facts.now));
  const reviewable = reviewableFiles(facts.files, policy.path_filters);
  // The budget follows the class of the paths CodeRabbit reads: a filtered dist file does not raise it.
  const budgetClass = classify(pathsOf(reviewable), policy).class;
  return {
    cls, matched, paths, credits, cli: facts.cli ?? null, dependabot: Boolean(facts.dependabot),
    band: bandOf(facts.files, policy, { labels: facts.labels ?? [] }), botBudget: policy.matrix?.bot_budget ?? {},
    critical: tagged(paths, policy.checkpoint?.critical), parser: tagged(paths, policy.checkpoint?.parser),
    monthFiles: facts.ledger_month_files, monthCap: monthCapOf(policy),
    size: sizeOf(reviewable), budgetClass, classBudget: classBudget(policy, budgetClass), greptile: greptileOf(cls, policy, credits), capacity: resultCapacity(policy, facts),
  };
}

/** recommend(facts, policy) -> the checkpoint result. Pure: it does no I/O and reads the time only from facts.now. */
export function recommend(facts, policy) {
  const c = contextOf(facts, policy);
  const base = {
    head: facts.head, class: c.cls, matched: c.matched, size: c.size, checks: facts.stamp?.results ?? [], cli: c.cli, credits: c.credits,
    capacity: c.capacity, band: c.band, recommended: null, options: [], why: [], budget: [0, 0], config_drift: Boolean(facts.config_drift),
    config_drift_why: driftWhy(facts.config_drift),
  };
  const auto = (recommended) => ({ auto: autoOf(c, facts, policy, recommended) });
  const stop = stampProblem(facts);
  const notes = facts.notes ?? [];
  if (stop) return { ...base, ...auto(null), why: [stop, ...notes] };
  const unread = labelsProblem(c, facts);
  if (unread) return { ...base, ...auto(null), why: [unread, ...notes] };
  const picked = combine(hitsFor(c));
  const wait = waitWhy(c, picked);
  const options = orderFor(c, picked).map((p) => optionOf(c, picked, p));
  const recommended = wait?.recommended ?? picked.pathway;
  return { ...base, ...auto(recommended), recommended, options, why: [...picked.why, ...(wait?.why ?? []), ...notes], budget: picked.budget };
}

// ---------- real inputs (read-only) ----------

function git(args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: workTop(), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr).trim().split('\n')[0]}`);
  return r.stdout;
}

const gitOk = (args) => spawnSync('git', args, { cwd: workTop(), encoding: 'utf8', windowsHide: true }).status === 0;
const FETCH_TIMEOUT_MS = 30000;
const fetchBase = () => spawnSync('git', ['fetch', '--quiet', 'fork', 'main'], { cwd: workTop(), encoding: 'utf8', windowsHide: true, timeout: FETCH_TIMEOUT_MS }).status === 0;

/** Spec section 2: fetch fork main, then diff against it. Returns { ref, notes }. */
function baseRef() {
  const fetched = fetchBase();
  const hasFork = gitOk(['rev-parse', '--verify', '--quiet', 'refs/remotes/fork/main']);
  const ref = hasFork ? 'fork/main' : 'main';
  return resolveBase({ fetched, hasFork, sha: git(['rev-parse', ref]).trim() });
}

function readFiles(base) {
  const range = `${base}...HEAD`;
  const counts = parseNumstatZ(git(['diff', '--numstat', '-z', '-M', range]));
  return parseNameStatus(git(['diff', '--name-status', '-M', range])).map((f) => ({ ...f, additions: 0, deletions: 0, ...counts.get(f.filename) }));
}

/** <state-dir>/stamp.json, or null when it is missing or not JSON. */
function readStamp(stateDir) {
  try { return JSON.parse(readFileSync(path.join(stateDir, path.basename(STAMP_REL)), 'utf8')); } catch { return null; }
}

/** <git toplevel of the cwd>/.claude/cache/pre-pr: where pre-pr.mjs writes the stamp and the hook looks. Outside a checkout: this script's checkout. */
function defaultStateDir() {
  return path.join(workTop(), ...STATE_REL.split('/'));
}

/** CLI facts from a saved review stream. null unless the run completed with no error or awaiting status, so a cut-off run never reads as clean. */
export function cliFromStream(text) {
  const p = parseAgentStream(text);
  return p.complete && !p.awaiting && p.errors.length === 0 ? { bySeverity: p.bySeverity } : null;
}

/** The saved CLI review output of the head (pre-pr.mjs keeps it as <date>-pre-pr-cr-<sha7>.txt). null = not found or not complete. */
function readCli(head) {
  const dir = path.join(workTop(), '.claude', 'cache', 'e2e');
  const name = existsSync(dir) ? readdirSync(dir).find((n) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-pre-pr-cr-${head.slice(0, 7)}\\.txt$`).test(n)) : undefined;
  return name ? cliFromStream(readFileSync(path.join(dir, name), 'utf8')) : null;
}

/**
 * Does the branch config differ from the base branch's? The router uses main's config. Fails closed: 'unread' when main's config is
 * missing or not JSON, 'differs' when the two differ (or the branch config is not JSON), false when they match.
 */
function configDrift(base, configText) {
  const r = spawnSync('git', ['show', `${base}:review-router.config.json`], { cwd: workTop(), encoding: 'utf8', windowsHide: true });
  let main;
  try { main = JSON.parse(r.status === 0 ? r.stdout : ''); } catch { return 'unread'; }
  try { return JSON.stringify(main) !== JSON.stringify(JSON.parse(configText)) ? 'differs' : false; } catch { return 'differs'; }
}

/** { labels, number, author } of a gh pr view JSON text. labels is null and number is null when the text is not usable. */
function viewFields(text) {
  try {
    const o = JSON.parse(text);
    return { labels: labelNames(text), number: Number.isInteger(o.number) ? o.number : null, author: String(o.author?.login ?? '') };
  } catch { return { labels: null, number: null, author: '' }; }
}

/** The label names in a gh pr view JSON text, or null. */
function labelNames(text) {
  try {
    const labels = JSON.parse(text).labels;
    return Array.isArray(labels) ? labels.map((l) => l?.name).filter((n) => typeof n === 'string') : null;
  } catch { return null; }
}

/**
 * The labels, the number and the author of the PR on the current branch. labels is null when they cannot be read (null makes the checkpoint stop below HIGH).
 * The number lets the capacity fact read the PR comments; without it nothing is posted.
 * First the lookup pinned to the fork repo by branch name. A fork PR is not found that way, so then `gh pr view` with no branch
 * (gh resolves the current branch's PR, fork-aware). That call cannot be pinned with -R, and origin here is parcadei, so its
 * answer counts only when the PR url is in DEFAULT_REPO.
 */
function readPrView() {
  const none = viewFields('');
  let branch;
  try { branch = git(['branch', '--show-current']).trim(); } catch { return none; }
  if (!branch) return none;
  const gh = ghRunner();
  const pinned = gh(['pr', 'view', branch, '--json', 'labels,number,author', ...REPO_ARGS]);
  if (pinned.status === 0) return viewFields(pinned.stdout);
  const open = gh(['pr', 'view', '--json', 'labels,url,number,author']);
  let url = '';
  try { url = String(JSON.parse(open.stdout).url ?? ''); } catch { /* no JSON: not read */ }
  return open.status === 0 && url.startsWith(`https://github.com/${DEFAULT_REPO}/pull/`) ? viewFields(open.stdout) : none;
}

const hasMatrix = (configText) => { try { return Boolean(JSON.parse(configText).matrix); } catch { return false; } };

/**
 * The files CodeRabbit reviewed this Chicago month, from the paid ledger (cr-paid.mjs monthOf), or null when the ledger cannot be read.
 * Test seams: `deps.ledgerPath`, and the env var PR_CHECKPOINT_LEDGER (a ledger file for a spawned engine, like PR_CHECKPOINT_GH). The
 * checkpoint tests feed facts.ledger_month_files or the env var and never read ~/.claude/state.
 */
export function ledgerMonthFiles(now, deps = {}, env = process.env) {
  const seam = env.PR_CHECKPOINT_LEDGER ? { ledgerPath: env.PR_CHECKPOINT_LEDGER } : {};
  try { return monthOf({ ...seam, ...deps, now: () => new Date(now) }).files; } catch { return null; }
}

const parsedOr = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

/**
 * Will /pathway show Dave a question that offers CodeRabbit? True for a result that is not stopped (recommended null) and that auto-confirm does
 * not cover, with a coderabbit or both option. Only then may the probe post: a PR that auto-confirms none, or stops, never needs the fact.
 */
export function questionShown(result) {
  if (!result || result.recommended === null || result.auto?.eligible === true) return false;
  return (result.options ?? []).some((o) => o.pathway === 'coderabbit' || o.pathway === 'both');
}

const PROBE_VIEW_TIMEOUT_MS = 20000;

/** `gh pr view <n>` says the PR is OPEN, a draft, and has that number. Any gh error or odd answer is false. */
function openDraft(pr) {
  const r = ghRunner(process.env, PROBE_VIEW_TIMEOUT_MS)(['pr', 'view', String(pr), '--json', 'state,isDraft,number', ...REPO_ARGS]);
  if (r.status !== 0) return false;
  try { const o = JSON.parse(r.stdout); return o.state === 'OPEN' && o.isDraft === true && o.number === pr; } catch { return false; }
}

/**
 * The probe gate: it runs just before the post. Needs --probe and --pr, a branch PR (when read) that is the --pr PR, a question that Dave will see
 * (the result without the live fact), and then `gh pr view` of that number: OPEN, draft, same number. The cheap checks come first, the gh call last.
 */
function probeGate({ opts, view, facts, policy }) {
  return () => {
    if (opts.probe !== true || !Number.isInteger(opts.pr)) return false;
    if (view.number !== null && view.number !== opts.pr) return false;
    return questionShown(recommend(facts, policy)) && openDraft(opts.pr);
  };
}

/**
 * The live capacity fact (capacity-fact.mjs). It reads the PR comments and, behind the probe gate, may post one "@coderabbitai rate limit" comment, so it
 * runs only when the stamp lets the checkpoint go on. Dependabot: the --dependabot flag, the commit authors or the PR author. Never throws.
 */
function readCapacity({ now, stamp, view, pr, dependabot, policy, gate }) {
  if (!stamp) return idleCapacity(now);
  try {
    return capacityFact({ now, pr, dependabot: dependabot || /dependabot/i.test(view.author), policy, probe: gate, root: workTop() });
  } catch {
    return idleCapacity(now);
  }
}

/** opts: { dependabot, probe (--probe), pr (the --pr number or null), policy (the router policy: the probe gate reads the result) }. */
function gatherFacts(configText, stateDir, readMonth = ledgerMonthFiles, opts = {}) {
  const { ref: base, notes } = baseRef();
  const head = git(['rev-parse', 'HEAD']).trim();
  // Fallback only: the PR author is the authoritative source, and the mod passes it with --dependabot.
  const dependabot = isDependabotAuthors(git(['log', '--format=%ae', `${base}..HEAD`]));
  const stamp = readStamp(stateDir);
  // The band needs the labels (risk:high), and the capacity fact needs the PR number. Read the view only when the stamp lets the checkpoint go on.
  const view = stamp ? readPrView() : viewFields('');
  const labels = hasMatrix(configText) && stamp ? { labels: view.labels } : {};
  const now = new Date().toISOString();
  const facts = { head, now, stamp, files: readFiles(base), cli: readCli(head), dependabot, config_drift: configDrift(base, configText), ledger_month_files: readMonth(now), ...labels, notes };
  const policy = opts.policy ?? parsedOr(configText, {});
  const asDependabot = dependabot || opts.dependabot === true;
  const gate = probeGate({ opts, view, facts: { ...facts, dependabot: asDependabot }, policy });
  const capacity = readCapacity({ now, stamp, view, pr: opts.pr ?? view.number, dependabot: asDependabot, policy, gate });
  return { ...facts, capacity };
}

// ---------- PR B: --confirm (record a pathway) and --apply (label, then ready) ----------

const bodyHash = (text) => createHash('sha256').update(String(text ?? '')).digest('hex');

/**
 * The budget the record stores (Dave 11-04): option.budget, never below 1+0 for a chosen review, 0+0 for none. coderabbit records the
 * price its option shows (option.cost); both records max(rule budget, class budget), not the display-only 1+1 floor of both.cost.
 * No offered option for the pathway: fall back to the rule budget.
 */
const recordBudget = (pathway, option, rule) => (pathway === 'none' ? [0, 0] : atLeast(option?.budget ?? rule, [1, 0]));

/** The first reason --confirm must refuse, or null. Order: stamp (R0), body, wait, offered, held, --by default. */
export function confirmProblem({ result, facts, pathway, by, bodySha }) {
  if (result.recommended === null) return result.why[0];
  if (facts.stamp.body_sha256 !== bodySha) return 'The PR body is not the body pre-pr.mjs checked (its sha256 differs from the stamp). Run pre-pr.mjs on this body file.';
  if (pathway === 'wait') return 'wait records nothing: the PR stays a draft. Confirm none, coderabbit or both when you decide.';
  const option = result.options.find((o) => o.pathway === pathway);
  if (!option) return `${pathway} is not offered. Offered: ${result.options.map((o) => o.pathway).join(', ')}.`;
  if (!option.available) return `${pathway} is held: ${option.reason}`;
  if (by === 'default' && pathway !== result.recommended) return `--by default needs the recommended pathway (${result.recommended}), not ${pathway}.`;
  // none is the recommendation at HIGH and CRITICAL without the CodeRabbit trigger (interim rule), but only a person records it there: the land gate reads decided_by dave.
  if (by === 'default' && pathway === 'none' && ['HIGH', 'CRITICAL'].includes(result.auto?.band)) return `--by default cannot record none at ${result.auto.band}: only Dave's own pick records it (--by dave).`;
  if (by === 'auto' && pathway !== 'none') return `--by auto records none only, not ${pathway}.`;
  if (by === 'auto' && !result.auto?.eligible) return `--by auto is not allowed here: ${result.auto?.reason ?? 'no auto-confirm answer'}`;
  return null;
}

/** The nine-field pathway.json record. head and body_sha256 come from the stamp that confirmProblem checked. */
export function confirmRecord({ result, facts, pathway, by }) {
  return {
    head: facts.stamp.head, body_sha256: facts.stamp.body_sha256, pathway, label: LABELS[pathway], class: result.class,
    recommended: result.recommended, decided_by: by, at: facts.now,
    budget: recordBudget(pathway, result.options.find((o) => o.pathway === pathway), result.budget),
  };
}

/** Why a pathway record cannot be applied, or null. It is checked before any gh call. */
function recordProblem(record) {
  if (!record || typeof record !== 'object') return 'No pathway record. Call pr_checkpoint {pr} first: it asks Dave and records his tap.';
  if (typeof record.head !== 'string' || record.head === '') return 'The pathway record has no head.';
  if (!['none', 'coderabbit', 'both'].includes(record.pathway)) return `The pathway record holds pathway ${String(record.pathway)}, which records no review.`;
  if (record.label !== LABELS[record.pathway]) return `The pathway record label ${String(record.label)} does not match its pathway ${record.pathway}.`;
  return null;
}

/** Every gh call names the fork: gh otherwise picks the repo from the cwd remotes, where origin is parcadei (review-router.mjs and review-status.mjs pin it too). */
const REPO_ARGS = ['-R', DEFAULT_REPO];

const firstLine = (text) => String(text ?? '').trim().split('\n')[0];
const failed = (error) => ({ ok: false, error });

function readPr(pr, gh) {
  const r = gh(['pr', 'view', String(pr), '--json', 'isDraft,headRefOid,labels', ...REPO_ARGS]);
  if (r.status !== 0) return { error: `Could not read PR #${pr} (${firstLine(r.stderr)}).` };
  try { return JSON.parse(r.stdout); } catch { return { error: `Could not read PR #${pr}: gh gave no JSON.` }; }
}

/**
 * The review:* labels of a PR view other than `keep`. The router reads the strongest review:* label, so a stale one must go (#349). Labels may be objects or strings.
 * A review:coderabbit record keeps review:deep-held: review-router.mjs `releasable` lifts a hold only while that label is still on the PR.
 */
const staleReviewLabels = (labels, keep) => (Array.isArray(labels) ? labels : [])
  .map((l) => (typeof l === 'string' ? l : l?.name))
  .filter((n) => typeof n === 'string' && n.startsWith('review:') && n !== keep && !(keep === 'review:coderabbit' && n === 'review:deep-held'));

/** The comment applyPathway posts before ready: the hidden marker the router reads (review-router.mjs confirmedPathways), then one visible line. */
const confirmBody = (record) => `${renderPathwayMarker(record.head.toLowerCase(), record.pathway)}
Checkpoint: ${record.pathway} at ${record.head.slice(0, 7)}, chosen in /pathway.`;

/**
 * applyPathway({ pr, record, gh }) -> { ok: true } | { ok: false, error }. gh(args) -> { status, stdout, stderr }.
 * Order: refuse a bad record, read the PR, refuse a PR that is not a draft or whose head moved, add the label, post the
 * pathway-confirmed comment, then mark it ready. A failed label never reaches ready: a ready PR with no label would be routed with no pathway.
 * A failed comment never reaches ready either: the router counts a ready_for_review as a new checkpoint only with that comment (PR D).
 */
export function applyPathway({ pr, record, gh }) {
  const bad = recordProblem(record);
  if (bad) return failed(bad);
  const live = readPr(pr, gh);
  if (live.error) return failed(live.error);
  if (live.isDraft !== true) return failed(`PR #${pr} is not a draft, so the pathway is not applied.`);
  if (String(live.headRefOid).toLowerCase() !== record.head.toLowerCase()) {
    return failed(`The head of PR #${pr} moved since the pathway was confirmed (PR ${String(live.headRefOid).slice(0, 7)}, record ${record.head.slice(0, 7)}). Call pr_checkpoint {pr} again: it asks Dave again for the new head.`);
  }
  const label = gh(['pr', 'edit', String(pr), ...staleReviewLabels(live.labels, record.label).flatMap((n) => ['--remove-label', n]), '--add-label', record.label, ...REPO_ARGS]);
  if (label.status !== 0) return failed(`Could not add the label ${record.label} (${firstLine(label.stderr)}). The PR was not marked ready.`);
  const note = gh(['pr', 'comment', String(pr), '--body', confirmBody(record), ...REPO_ARGS]);
  if (note.status !== 0) return failed(`The label ${record.label} was added, but the pathway-confirmed comment failed (${firstLine(note.stderr)}). The PR was not marked ready.`);
  const ready = gh(['pr', 'ready', String(pr), ...REPO_ARGS]);
  if (ready.status !== 0) return failed(`The label ${record.label} was added, but gh pr ready failed (${firstLine(ready.stderr)}).`);
  return { ok: true };
}

/** The real gh, or `node $PR_CHECKPOINT_GH <args>` (the test seam: a fake gh script, never a real GitHub call). */
function ghRunner(env = process.env, timeout = undefined) {
  return (args) => {
    const fake = env.PR_CHECKPOINT_GH;
    const r = spawnSync(fake ? process.execPath : 'gh', fake ? [fake, ...args] : args, { encoding: 'utf8', windowsHide: true, env, ...(timeout ? { timeout } : {}) });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr || String(r.error?.message ?? '') };
  };
}

// ---------- CLI ----------

const VALUE_FLAGS = ['--facts', '--config', '--confirm', '--by', '--body', '--state-dir', '--apply', '--pr'];
const BOOL_FLAGS = ['--json', '--dependabot', '--probe', '--no-ledger', '--ask-anyway'];
const PATHWAYS = ['none', 'coderabbit', 'both', 'wait'];

/** { opts } or { error }. A value flag with no value (or whose next argument is a flag) is an error. */
function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (BOOL_FLAGS.includes(a)) { opts[a] = true; continue; }
    if (!VALUE_FLAGS.includes(a)) return { error: `unknown argument ${a}` };
    if (args[i + 1] === undefined || args[i + 1].startsWith('--')) return { error: `${a} needs a value` };
    opts[a] = args[++i];
  }
  return { opts };
}

function confirmUsage(o) {
  if (!PATHWAYS.includes(o['--confirm'])) return `--confirm needs one of ${PATHWAYS.join(', ')}`;
  if (!['dave', 'default', 'auto'].includes(o['--by'])) return '--confirm needs --by dave, --by default or --by auto';
  return o['--body'] ? null : '--confirm needs --body <file>: the PR body file that pre-pr.mjs checked';
}

function applyUsage(o) {
  if (!/^[1-9]\d*$/.test(o['--apply'])) return '--apply needs a PR number';
  const stray = ['--facts', '--config', '--body', '--by', '--json', '--dependabot', '--probe', '--pr', '--ask-anyway'].find((k) => o[k] !== undefined);
  return stray ? `${stray} is not an --apply flag: it takes --state-dir only` : null;
}

/** A message for bad usage, or null. Checked before anything is read or written. */
function usageProblem(o) {
  const confirm = o['--confirm'] !== undefined;
  const apply = o['--apply'] !== undefined;
  if (o['--pr'] !== undefined && !apply && !/^[1-9]\d*$/.test(o['--pr'])) return '--pr needs a PR number';
  if (confirm && apply) return '--confirm and --apply cannot be combined';
  if (confirm) return confirmUsage(o);
  if (apply) return applyUsage(o);
  const stray = ['--by', '--body', '--state-dir'].find((k) => o[k] !== undefined);
  return stray ? `${stray} needs --confirm or --apply` : null;
}

/** One line for the live capacity fact: free now, the next slot, or unknown with the last notice. */
function slotText(cap) {
  const cli = typeof cap.cliRemaining === 'number' ? ` CLI reviews left: ${cap.cliRemaining}.` : '';
  if (cap.state === 'free') return `free now (${cap.factSource}).${cli}`;
  if (cap.state === 'wait') return `no free slot${cap.nextSlotAt ? `, next about ${cap.nextSlotAt} (in ${cap.minutesToSlot} min)` : ''} (${cap.factSource}).${cli}`;
  return `unknown${cap.lastNoticeAt ? `, last notice ${cap.lastNoticeAt}` : ''}.${cli}`;
}

export function renderText(r) {
  const lines = [`PR checkpoint for ${String(r.head).slice(0, 7)}: class ${r.class}, ${r.size.files} file(s), ${r.size.lines} line(s)`];
  lines.push(`Recommended: ${r.recommended ?? 'stopped'}  budget ${r.budget[0]}+${r.budget[1]}`);
  lines.push(...r.why.map((w) => `  - ${w}`));
  r.options.forEach((o, i) => lines.push(`  ${i + 1}. ${o.pathway}${o.label ? ` (${o.label})` : ''}${o.available ? '' : ' [held]'}: ${o.reason}`));
  if (r.capacity.state) lines.push(`CodeRabbit slot: ${slotText(r.capacity)}`);
  lines.push(`CodeRabbit 7-day count: ${r.capacity.count ?? 'unknown'} (${r.capacity.band})${r.capacity.warning ? `. ${r.capacity.warning}` : ''}`);
  if (r.config_drift) lines.push(`Warning: ${r.config_drift_why ?? 'Branch config differs from main'}. The router uses the config of main.`);
  return lines.join('\n');
}

/** The facts and the policy of a real or fixture run. With --facts and no `stamp` key, --confirm reads <state-dir>/stamp.json. */
function inputsOf(o, stateDir, probe = false) {
  const configText = readFileSync(o['--config'] ?? workFile('review-router.config.json'), 'utf8');
  const yaml = workFile('.coderabbit.yaml');
  const policy = { ...JSON.parse(configText), path_filters: pathFiltersFrom(existsSync(yaml) ? readFileSync(yaml, 'utf8') : '') };
  const factsFile = o['--facts'];
  const facts = factsFile ? JSON.parse(readFileSync(factsFile, 'utf8')) : gatherFacts(configText, stateDir, undefined, { dependabot: o['--dependabot'] === true, probe, pr: o['--pr'] === undefined ? null : Number(o['--pr']), policy });
  if (factsFile && o['--confirm'] !== undefined && !('stamp' in facts)) facts.stamp = readStamp(stateDir);
  if (o['--dependabot']) facts.dependabot = true;
  return { facts, policy };
}

/** The two-call protocol (lib/checkpoint-ledger.mjs) runs only for the literal true in checkpoint.ledger. */
const ledgerOn = (policy) => policy.checkpoint?.ledger === true;

/** The clock of the question in ms: facts.now (a fixture sets it, a live run reads it once). The CodeRabbit slot fact is judged at this time. */
const clockMs = (facts) => (Number.isFinite(Date.parse(facts.now)) ? Date.parse(facts.now) : Date.now());

const refuse = (message) => { console.error(`pr-checkpoint: refused: ${message}`); process.exitCode = 1; };

function runConfirm(o) {
  const stateDir = o['--state-dir'] ?? defaultStateDir();
  const { facts, policy } = inputsOf(o, stateDir);
  let bodyText;
  try { bodyText = readFileSync(o['--body'], 'utf8'); } catch { return refuse(`cannot read the body file ${o['--body']}`); }
  const args = { result: recommend(facts, policy), facts, pathway: o['--confirm'], by: o['--by'], bodySha: bodyHash(bodyText) };
  const pr = o['--pr'] === undefined ? null : Number(o['--pr']);
  const problem = confirmProblem(args) ?? (ledgerOn(policy) ? ledgerConfirmProblem({ pr, head: facts.head, pathway: args.pathway, by: args.by, result: args.result, now: clockMs(facts) }) : null);
  if (problem) return refuse(problem);
  const record = confirmRecord(args);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, path.basename(PATHWAY_REL)), `${JSON.stringify(record, null, 2)}\n`);
  if (ledgerOn(policy)) ledgerUse({ pr, head: facts.head });
  console.log(JSON.stringify(record));
}

function runApply(o) {
  const stateDir = o['--state-dir'] ?? defaultStateDir();
  let record = null;
  try { record = JSON.parse(readFileSync(path.join(stateDir, path.basename(PATHWAY_REL)), 'utf8')); } catch { /* recordProblem names the missing record */ }
  const r = applyPathway({ pr: o['--apply'], record, gh: ghRunner() });
  if (!r.ok) return refuse(r.error);
  console.log(`pr-checkpoint: PR #${o['--apply']} labelled ${record.label} and marked ready.`);
}

function runRecommend(o) {
  // The probe may post only in the JSON run the mod makes. The text plan and --confirm never post.
  const { facts, policy } = inputsOf(o, defaultStateDir(), o['--probe'] === true && o['--json'] === true);
  const result = recommend(facts, policy);
  const pr = o['--pr'] === undefined ? null : Number(o['--pr']);
  const ledger = o['--json'] && pr !== null && !o['--no-ledger'] && ledgerOn(policy) ? ledgerStep({ pr, result, slotLine: slotText(result.capacity), askAnyway: o['--ask-anyway'] === true, now: clockMs(facts) }) : null;
  console.log(o['--json'] ? JSON.stringify(ledger ? { ...result, ledger } : result) : renderText(result));
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const bad = parsed.error ?? usageProblem(parsed.opts);
  if (bad) {
    console.error(`pr-checkpoint: usage: ${bad}. Modes: [--json] [--probe] [--no-ledger] [--ask-anyway] [--pr n] [--dependabot] [--facts f] [--config c] | --confirm <pathway> --by <dave|default|auto> --body <file> [--pr n] [--state-dir d] | --apply <pr> [--state-dir d].`);
    process.exit(2);
  }
  const o = parsed.opts;
  try {
    if (o['--apply'] !== undefined) runApply(o);
    else if (o['--confirm'] !== undefined) runConfirm(o);
    else runRecommend(o);
  } catch (err) {
    console.error(`pr-checkpoint: could not determine (${String(err.message).split('\n')[0]})`);
    process.exit(3);
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) main();
