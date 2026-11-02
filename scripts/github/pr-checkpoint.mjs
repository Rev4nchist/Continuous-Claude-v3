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
 * Usage: node scripts/github/pr-checkpoint.mjs [--json] [--facts facts.json] [--config router-config.json]
 *   --json     print the result as one JSON object (default: plain lines).
 *   --dependabot  the PR is a Dependabot PR. PR B's mod passes it from the PR author (the authoritative source).
 *              Without it, the real run derives it from base...HEAD: every commit author is dependabot[bot].
 *   --facts    read the facts from a JSON file, not from git and the stamp (tests, like review-router.mjs --fixture).
 *   --config   the router config (default: review-router.config.json of this checkout).
 *
 * node scripts/github/pr-checkpoint.mjs --confirm <none|coderabbit|both> --by <dave|default> --body <draft.md> [--state-dir <dir>]
 *   Records the pathway in <state-dir>/pathway.json and prints the record. It refuses (exit 1, nothing written) when the stamp is
 *   missing, for another head or has a FAIL row; the body hash differs from the stamp; the pathway is wait, not offered or held; or
 *   --by default names a pathway that is not the recommendation. The state dir holds stamp.json and pathway.json. Default:
 *   <git toplevel of the cwd>/.claude/cache/pre-pr. --facts and --config work as above (tests).
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

function noneReason(c) {
  if (c.cls === 'docs' || c.budgetClass === 'docs') return 'Class docs: no bot review.';
  if (c.size.lines === 0) return 'No reviewable lines: every path is filtered or a build output.';
  const quiet = c.paths.every((p) => QUIET_DIRS.some((d) => p.startsWith(d)));
  return quiet ? 'Only thoughts/, artifacts/ or .claudedocs/ paths: no bot review.' : null;
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
 * RB (review matrix, option A): the band decides. LOW, MID and ELEVATED get no CodeRabbit PR bot; HIGH and CRITICAL get it at the
 * matrix.bot_budget. Dave can still press CodeRabbit on a lower band (an escalation); this is only the recommendation.
 */
function bandRule(c) {
  const b = c.band;
  const facts = `score ${b.score}: ${b.G} gate file(s)${b.C ? ', a review config file' : ''}${b.K ? ', logic code' : ''}`;
  if (!['HIGH', 'CRITICAL'].includes(b.band)) {
    return hit('RB', 'none', [0, 0], [`Band ${b.band} (${facts}): no CodeRabbit PR bot below HIGH. The internal review stack covers it.`]);
  }
  const budget = budgetPair(c.botBudget[b.band] ?? [1, 1]);
  const why = b.L ? 'risk:high or an r3 path' : `${b.G} gate files (${list(b.gateFiles)})`;
  return hit('RB', 'coderabbit', budget, [`Band ${b.band} (${facts}): CodeRabbit ${budget[0]}+${budget[1]}. Cause: ${why}.`]);
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

/** With a matrix block the band rule replaces R1, RS and R5. A HIGH or CRITICAL PR keeps R2, R3 and R4 beside it (parser budget, Greptile). */
function bandHits(c) {
  const rb = bandRule(c);
  if (rb.pathway === 'none') return [rb];
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
  const only = (rule) => picked.rules.length === 1 && picked.rules[0] === rule;
  if (only('R1') || only('RB')) return picked.pathway === 'none' ? ['none', 'coderabbit'] : ['coderabbit', 'both'];
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
 * both: max(rule budget, class budget, 1+1), so a both option never looks free. Do not copy it into pathway.json.budget.
 */
function costOf(c, picked, pathway) {
  if (pathway === 'coderabbit' && picked.rules.length === 1 && picked.rules[0] === 'RS') return [1, 0];
  if (pathway === 'coderabbit') return atLeast(picked.pathway === 'none' ? c.classBudget : picked.budget, [1, 0]);
  if (pathway === 'both') return atLeast(atLeast(picked.budget, c.classBudget), [1, 1]);
  return [0, 0];
}

function optionOf(c, picked, pathway) {
  const cost = costOf(c, picked, pathway);
  const reason = {
    none: 'No bot review. READY needs CI and proof only.',
    wait: 'Stay a draft and spend nothing until the CodeRabbit 7-day count drops.',
    coderabbit: `CodeRabbit ${cost[0]}+${cost[1]}.`,
    both: c.greptile.reason,
  }[pathway];
  return { pathway, label: LABELS[pathway], available: pathway === 'both' ? c.greptile.available : true, cost, reason };
}

function waitWhy(c, picked) {
  const only = picked.rules.length === 1 && ['R5', 'RS'].includes(picked.rules[0]);
  // A clean small PR (RS, none) buys no review, so there is nothing to wait for.
  const buys = picked.pathway === 'coderabbit';
  return only && buys && c.capacity.band === 'high' ? { recommended: 'wait', why: [`CodeRabbit 7-day count is ${c.capacity.count}: wait is the default at 40 or more. It never blocks.`] } : null;
}

// ---------- recommend ----------

/**
 * Fail closed: the PR labels could not be read (facts.labels is null), so a risk:high label may be hiding. Below HIGH that could
 * turn a CRITICAL PR into `none`, so the checkpoint stops (recommended null, like R0). A HIGH or CRITICAL band by paths already
 * recommends CodeRabbit whatever a label says, and a Dependabot PR gets none whatever its labels. facts.labels absent means a caller
 * that supplies no labels (a fixture); only null means "tried and failed".
 */
function labelsProblem(c, facts) {
  if (!c.band || facts.labels !== null || c.dependabot || ['HIGH', 'CRITICAL'].includes(c.band.band)) return null;
  return 'Could not read the PR labels (gh pr view failed, or there is no PR for this branch). The band needs the risk:high label, so no pathway is recommended. Open the draft PR, check gh, and run /pathway again.';
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
    size: sizeOf(reviewable), budgetClass, classBudget: classBudget(policy, budgetClass), greptile: greptileOf(cls, policy, credits), capacity: capacityOf(policy, facts.now),
  };
}

/** recommend(facts, policy) -> the checkpoint result. Pure: it does no I/O and reads the time only from facts.now. */
export function recommend(facts, policy) {
  const c = contextOf(facts, policy);
  const base = {
    head: facts.head, class: c.cls, matched: c.matched, size: c.size, checks: facts.stamp?.results ?? [], cli: c.cli, credits: c.credits,
    capacity: c.capacity, band: c.band, recommended: null, options: [], why: [], budget: [0, 0], config_drift: Boolean(facts.config_drift),
  };
  const stop = stampProblem(facts);
  const notes = facts.notes ?? [];
  if (stop) return { ...base, why: [stop, ...notes] };
  const unread = labelsProblem(c, facts);
  if (unread) return { ...base, why: [unread, ...notes] };
  const picked = combine(hitsFor(c));
  const wait = waitWhy(c, picked);
  const options = orderFor(c, picked).map((p) => optionOf(c, picked, p));
  return { ...base, recommended: wait?.recommended ?? picked.pathway, options, why: [...picked.why, ...(wait?.why ?? []), ...notes], budget: picked.budget };
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

/** The branch config differs from the base branch's: the router uses main's config. */
function configDrift(base, configText) {
  const r = spawnSync('git', ['show', `${base}:review-router.config.json`], { cwd: workTop(), encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return false;
  try { return JSON.stringify(JSON.parse(r.stdout)) !== JSON.stringify(JSON.parse(configText)); } catch { return false; }
}

/** The label names of the PR on the current branch (one gh call), or null when they cannot be read. null makes the checkpoint stop below HIGH. */
function readLabels() {
  let branch;
  try { branch = git(['branch', '--show-current']).trim(); } catch { return null; }
  if (!branch) return null;
  const r = ghRunner()(['pr', 'view', branch, '--json', 'labels', ...REPO_ARGS]);
  if (r.status !== 0) return null;
  try {
    const labels = JSON.parse(r.stdout).labels;
    return Array.isArray(labels) ? labels.map((l) => l?.name).filter((n) => typeof n === 'string') : null;
  } catch { return null; }
}

const hasMatrix = (configText) => { try { return Boolean(JSON.parse(configText).matrix); } catch { return false; } };

function gatherFacts(configText, stateDir) {
  const { ref: base, notes } = baseRef();
  const head = git(['rev-parse', 'HEAD']).trim();
  // Fallback only: the PR author is the authoritative source, and the mod passes it with --dependabot.
  const dependabot = isDependabotAuthors(git(['log', '--format=%ae', `${base}..HEAD`]));
  const stamp = readStamp(stateDir);
  // The band needs the labels (risk:high). Read them only when a band is computed and the stamp lets the checkpoint go on.
  const labels = hasMatrix(configText) && stamp ? { labels: readLabels() } : {};
  return { head, now: new Date().toISOString(), stamp, files: readFiles(base), cli: readCli(head), dependabot, config_drift: configDrift(base, configText), ...labels, notes };
}

// ---------- PR B: --confirm (record a pathway) and --apply (label, then ready) ----------

const bodyHash = (text) => createHash('sha256').update(String(text ?? '')).digest('hex');

/** The rule budget, never below 1+0 for a chosen review and 0+0 for none. option.cost is a price, not the budget. */
const recordBudget = (pathway, rule) => (pathway === 'none' ? [0, 0] : atLeast(rule, [1, 0]));

/** The first reason --confirm must refuse, or null. Order: stamp (R0), body, wait, offered, held, --by default. */
export function confirmProblem({ result, facts, pathway, by, bodySha }) {
  if (result.recommended === null) return result.why[0];
  if (facts.stamp.body_sha256 !== bodySha) return 'The PR body is not the body pre-pr.mjs checked (its sha256 differs from the stamp). Run pre-pr.mjs on this body file.';
  if (pathway === 'wait') return 'wait records nothing: the PR stays a draft. Confirm none, coderabbit or both when you decide.';
  const option = result.options.find((o) => o.pathway === pathway);
  if (!option) return `${pathway} is not offered. Offered: ${result.options.map((o) => o.pathway).join(', ')}.`;
  if (!option.available) return `${pathway} is held: ${option.reason}`;
  if (by === 'default' && pathway !== result.recommended) return `--by default needs the recommended pathway (${result.recommended}), not ${pathway}.`;
  return null;
}

/** The nine-field pathway.json record. head and body_sha256 come from the stamp that confirmProblem checked. */
export function confirmRecord({ result, facts, pathway, by }) {
  return {
    head: facts.stamp.head, body_sha256: facts.stamp.body_sha256, pathway, label: LABELS[pathway], class: result.class,
    recommended: result.recommended, decided_by: by, at: facts.now, budget: recordBudget(pathway, result.budget),
  };
}

/** Why a pathway record cannot be applied, or null. It is checked before any gh call. */
function recordProblem(record) {
  if (!record || typeof record !== 'object') return 'No pathway record. Run /pathway (pr-checkpoint.mjs --confirm) first.';
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
  const r = gh(['pr', 'view', String(pr), '--json', 'isDraft,headRefOid', ...REPO_ARGS]);
  if (r.status !== 0) return { error: `Could not read PR #${pr} (${firstLine(r.stderr)}).` };
  try { return JSON.parse(r.stdout); } catch { return { error: `Could not read PR #${pr}: gh gave no JSON.` }; }
}

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
    return failed(`The head of PR #${pr} moved since the pathway was confirmed (PR ${String(live.headRefOid).slice(0, 7)}, record ${record.head.slice(0, 7)}). Run /pathway again.`);
  }
  const label = gh(['pr', 'edit', String(pr), '--add-label', record.label, ...REPO_ARGS]);
  if (label.status !== 0) return failed(`Could not add the label ${record.label} (${firstLine(label.stderr)}). The PR was not marked ready.`);
  const note = gh(['pr', 'comment', String(pr), '--body', confirmBody(record), ...REPO_ARGS]);
  if (note.status !== 0) return failed(`The label ${record.label} was added, but the pathway-confirmed comment failed (${firstLine(note.stderr)}). The PR was not marked ready.`);
  const ready = gh(['pr', 'ready', String(pr), ...REPO_ARGS]);
  if (ready.status !== 0) return failed(`The label ${record.label} was added, but gh pr ready failed (${firstLine(ready.stderr)}).`);
  return { ok: true };
}

/** The real gh, or `node $PR_CHECKPOINT_GH <args>` (the test seam: a fake gh script, never a real GitHub call). */
function ghRunner(env = process.env) {
  return (args) => {
    const fake = env.PR_CHECKPOINT_GH;
    const r = spawnSync(fake ? process.execPath : 'gh', fake ? [fake, ...args] : args, { encoding: 'utf8', windowsHide: true, env });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr || String(r.error?.message ?? '') };
  };
}

// ---------- CLI ----------

const VALUE_FLAGS = ['--facts', '--config', '--confirm', '--by', '--body', '--state-dir', '--apply'];
const BOOL_FLAGS = ['--json', '--dependabot'];
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
  if (!['dave', 'default'].includes(o['--by'])) return '--confirm needs --by dave or --by default';
  return o['--body'] ? null : '--confirm needs --body <file>: the PR body file that pre-pr.mjs checked';
}

function applyUsage(o) {
  if (!/^[1-9]\d*$/.test(o['--apply'])) return '--apply needs a PR number';
  const stray = ['--facts', '--config', '--body', '--by', '--json', '--dependabot'].find((k) => o[k] !== undefined);
  return stray ? `${stray} is not an --apply flag: it takes --state-dir only` : null;
}

/** A message for bad usage, or null. Checked before anything is read or written. */
function usageProblem(o) {
  const confirm = o['--confirm'] !== undefined;
  const apply = o['--apply'] !== undefined;
  if (confirm && apply) return '--confirm and --apply cannot be combined';
  if (confirm) return confirmUsage(o);
  if (apply) return applyUsage(o);
  const stray = ['--by', '--body', '--state-dir'].find((k) => o[k] !== undefined);
  return stray ? `${stray} needs --confirm or --apply` : null;
}

export function renderText(r) {
  const lines = [`PR checkpoint for ${String(r.head).slice(0, 7)}: class ${r.class}, ${r.size.files} file(s), ${r.size.lines} line(s)`];
  lines.push(`Recommended: ${r.recommended ?? 'stopped'}  budget ${r.budget[0]}+${r.budget[1]}`);
  lines.push(...r.why.map((w) => `  - ${w}`));
  r.options.forEach((o, i) => lines.push(`  ${i + 1}. ${o.pathway}${o.label ? ` (${o.label})` : ''}${o.available ? '' : ' [held]'}: ${o.reason}`));
  lines.push(`CodeRabbit 7-day count: ${r.capacity.count ?? 'unknown'} (${r.capacity.band})${r.capacity.warning ? `. ${r.capacity.warning}` : ''}`);
  if (r.config_drift) lines.push('Warning: branch config differs from main. The router uses the config of main.');
  return lines.join('\n');
}

/** The facts and the policy of a real or fixture run. With --facts and no `stamp` key, --confirm reads <state-dir>/stamp.json. */
function inputsOf(o, stateDir) {
  const configText = readFileSync(o['--config'] ?? workFile('review-router.config.json'), 'utf8');
  const yaml = workFile('.coderabbit.yaml');
  const policy = { ...JSON.parse(configText), path_filters: pathFiltersFrom(existsSync(yaml) ? readFileSync(yaml, 'utf8') : '') };
  const factsFile = o['--facts'];
  const facts = factsFile ? JSON.parse(readFileSync(factsFile, 'utf8')) : gatherFacts(configText, stateDir);
  if (factsFile && o['--confirm'] !== undefined && !('stamp' in facts)) facts.stamp = readStamp(stateDir);
  if (o['--dependabot']) facts.dependabot = true;
  return { facts, policy };
}

const refuse = (message) => { console.error(`pr-checkpoint: refused: ${message}`); process.exitCode = 1; };

function runConfirm(o) {
  const stateDir = o['--state-dir'] ?? defaultStateDir();
  const { facts, policy } = inputsOf(o, stateDir);
  let bodyText;
  try { bodyText = readFileSync(o['--body'], 'utf8'); } catch { return refuse(`cannot read the body file ${o['--body']}`); }
  const args = { result: recommend(facts, policy), facts, pathway: o['--confirm'], by: o['--by'], bodySha: bodyHash(bodyText) };
  const problem = confirmProblem(args);
  if (problem) return refuse(problem);
  const record = confirmRecord(args);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, path.basename(PATHWAY_REL)), `${JSON.stringify(record, null, 2)}\n`);
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
  const { facts, policy } = inputsOf(o, defaultStateDir());
  const result = recommend(facts, policy);
  console.log(o['--json'] ? JSON.stringify(result) : renderText(result));
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const bad = parsed.error ?? usageProblem(parsed.opts);
  if (bad) {
    console.error(`pr-checkpoint: usage: ${bad}. Modes: [--json] [--dependabot] [--facts f] [--config c] | --confirm <pathway> --by <dave|default> --body <file> [--state-dir d] | --apply <pr> [--state-dir d].`);
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
