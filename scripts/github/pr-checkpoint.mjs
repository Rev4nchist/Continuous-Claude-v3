#!/usr/bin/env node
/**
 * pr-checkpoint.mjs: the recommendation engine of the PR Checkpoint mod (PR A, read-only).
 * Spec: .claudedocs/2026-10-28-pr-checkpoint-mod-spec.md section 2. Tests: pr-checkpoint.test.mjs.
 * Given the stamp, the changed files and the credit state, it picks one review pathway for a draft PR:
 * none, coderabbit or both (or wait when the CodeRabbit 7-day count is high). It spends nothing and writes nothing.
 *
 * Usage: node scripts/github/pr-checkpoint.mjs [--json] [--facts facts.json] [--config router-config.json]
 *   --json     print the result as one JSON object (default: plain lines).
 *   --dependabot  the PR is a Dependabot PR. PR B's mod passes it from the PR author (the authoritative source).
 *              Without it, the real run derives it from base...HEAD: every commit author is dependabot[bot].
 *   --facts    read the facts from a JSON file, not from git and the stamp (tests, like review-router.mjs --fixture).
 *   --config   the router config (default: review-router.config.json of this checkout).
 *   --confirm, --apply   PR B. Exit 2, nothing is written. This script never writes .claude/cache/pre-pr/pathway.json.
 * Exit 0 = a result was printed (including the R0 stop: recommended null). 2 = bad usage or a PR B mode. 3 = internal error.
 * Without --facts it runs `git fetch fork main` (spec section 2; it moves only refs/remotes/fork/main), then reads
 * `git diff --name-status -M` and `--numstat` against fork/main, the pre-pr stamp, and the saved CLI review output of the head.
 * The base ref and its commit go into why[]. A failed fetch, or a missing fork/main, adds a "may be stale" warning.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, creditsState, matchGlob, route } from './review-router.mjs';
import { STAMP_REL, parseAgentStream } from './pre-pr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

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
function reviewableFiles(files, filters = []) {
  const skip = filters.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  const keep = filters.filter((g) => !g.startsWith('!'));
  return files.filter((f) => !skip.some((g) => matchGlob(g, f.filename)) && (keep.length === 0 || keep.some((g) => matchGlob(g, f.filename))));
}

const sizeOf = (reviewable) => ({ files: reviewable.length, lines: reviewable.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0) });

const budgetPair = (b) => (Array.isArray(b) ? [b[0] ?? 0, b[1] ?? 0] : [Number(b) || 0, 0]);
const classBudget = (policy, cls) => budgetPair(policy.budget?.[cls] ?? policy.budget?.normal ?? [1, 1]);

// ---------- state: capacity, Greptile, CLI ----------

function capacityOf(policy) {
  const n = policy.coderabbit?.reviews_7d_manual;
  const count = Number.isInteger(n) && n >= 0 ? n : null;
  const band = count === null ? 'unknown' : count >= 50 ? 'high' : count >= 40 ? 'warn' : 'ok';
  const warning = band === 'warn' || band === 'high' ? `CodeRabbit 7-day count is ${count}: the rate drops to 6/h at 40, 4/h at 50.` : null;
  return { count, band, warning, source: count === null ? null : 'manual', date: policy.coderabbit?.reviews_7d_manual_date ?? null };
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
  const matched = [parserRule(c), criticalRule(c), r3Rule(c)].filter(Boolean);
  if (matched.length) return matched;
  return [noneRule(c) ?? fallbackRule(c)];
}

function combine(hits) {
  const pathway = hits.reduce((best, h) => (PATHWAY_RANK[h.pathway] > PATHWAY_RANK[best] ? h.pathway : best), 'none');
  const budget = hits.reduce((b, h) => [Math.max(b[0], h.budget[0]), Math.max(b[1], h.budget[1])], [0, 0]);
  return { pathway, budget, why: hits.flatMap((h) => h.why), rules: hits.map((h) => h.rule) };
}

// ---------- options ----------

function orderFor(c, picked) {
  if (c.dependabot) return ['none']; // bots refuse bot PRs: no paid option is offered (Dave decision 3)
  const only = (rule) => picked.rules.length === 1 && picked.rules[0] === rule;
  if (only('R1')) return ['none', 'coderabbit'];
  if (only('R5')) return [...(c.capacity.band === 'high' ? ['wait'] : []), 'coderabbit', ...(cliClean(c.cli) ? ['none'] : []), 'both'];
  return picked.pathway === 'both' ? ['both', 'coderabbit'] : ['coderabbit', 'both'];
}

const atLeast = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1])];

/**
 * What an option costs, from its own pathway and not from the recommendation. The pair stays CodeRabbit opening+extra.
 * coderabbit: the rule budget when a rule picked CodeRabbit or more, else the class budget, never below 1+0.
 * both: max(rule budget, class budget, 1+1), so a both option never looks free. Do not copy it into pathway.json.budget.
 */
function costOf(c, picked, pathway) {
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
  const only = picked.rules.length === 1 && picked.rules[0] === 'R5';
  return only && c.capacity.band === 'high' ? { recommended: 'wait', why: [`CodeRabbit 7-day count is ${c.capacity.count}: wait is the default at 50 or more. It never blocks.`] } : null;
}

// ---------- recommend ----------

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
    critical: tagged(paths, policy.checkpoint?.critical), parser: tagged(paths, policy.checkpoint?.parser),
    size: sizeOf(reviewable), budgetClass, classBudget: classBudget(policy, budgetClass), greptile: greptileOf(cls, policy, credits), capacity: capacityOf(policy),
  };
}

/** recommend(facts, policy) -> the checkpoint result. Pure: it does no I/O and reads the time only from facts.now. */
export function recommend(facts, policy) {
  const c = contextOf(facts, policy);
  const base = {
    head: facts.head, class: c.cls, matched: c.matched, size: c.size, checks: facts.stamp?.results ?? [], cli: c.cli, credits: c.credits,
    capacity: c.capacity, recommended: null, options: [], why: [], budget: [0, 0], config_drift: Boolean(facts.config_drift),
  };
  const stop = stampProblem(facts);
  const notes = facts.notes ?? [];
  if (stop) return { ...base, why: [stop, ...notes] };
  const picked = combine(hitsFor(c));
  const wait = waitWhy(c, picked);
  const options = orderFor(c, picked).map((p) => optionOf(c, picked, p));
  return { ...base, recommended: wait?.recommended ?? picked.pathway, options, why: [...picked.why, ...(wait?.why ?? []), ...notes], budget: picked.budget };
}

// ---------- real inputs (read-only) ----------

function git(args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr).trim().split('\n')[0]}`);
  return r.stdout;
}

const gitOk = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true }).status === 0;
const FETCH_TIMEOUT_MS = 30000;
const fetchBase = () => spawnSync('git', ['fetch', '--quiet', 'fork', 'main'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: FETCH_TIMEOUT_MS }).status === 0;

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

function readStamp() {
  try { return JSON.parse(readFileSync(path.join(ROOT, STAMP_REL), 'utf8')); } catch { return null; }
}

/** The saved CLI review output of the head (pre-pr.mjs keeps it as <date>-pre-pr-cr-<sha7>.txt). null = not found. */
function readCli(head) {
  const dir = path.join(ROOT, '.claude', 'cache', 'e2e');
  const name = existsSync(dir) ? readdirSync(dir).find((n) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-pre-pr-cr-${head.slice(0, 7)}\\.txt$`).test(n)) : undefined;
  return name ? { bySeverity: parseAgentStream(readFileSync(path.join(dir, name), 'utf8')).bySeverity } : null;
}

/** The branch config differs from the base branch's: the router uses main's config. */
function configDrift(base, configText) {
  const r = spawnSync('git', ['show', `${base}:review-router.config.json`], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return false;
  try { return JSON.stringify(JSON.parse(r.stdout)) !== JSON.stringify(JSON.parse(configText)); } catch { return false; }
}

function gatherFacts(configText) {
  const { ref: base, notes } = baseRef();
  const head = git(['rev-parse', 'HEAD']).trim();
  // Fallback only: the PR author is the authoritative source, and the mod passes it with --dependabot.
  const dependabot = isDependabotAuthors(git(['log', '--format=%ae', `${base}..HEAD`]));
  return { head, now: new Date().toISOString(), stamp: readStamp(), files: readFiles(base), cli: readCli(head), dependabot, config_drift: configDrift(base, configText), notes };
}

// ---------- CLI ----------

const FLAGS = ['--json', '--dependabot', '--facts', '--config'];

/** A message for an unknown argument, or --facts or --config without a value; else null. */
function usageProblem(args) {
  for (let i = 0; i < args.length; i++) {
    if (!FLAGS.includes(args[i])) return `unknown argument ${args[i]}`;
    if ((args[i] === '--facts' || args[i] === '--config') && (args[i + 1] === undefined || args[i + 1].startsWith('--'))) return `${args[i]} needs a value`;
    if (args[i] === '--facts' || args[i] === '--config') i++;
  }
  return null;
}

const opt = (args, k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

export function renderText(r) {
  const lines = [`PR checkpoint for ${String(r.head).slice(0, 7)}: class ${r.class}, ${r.size.files} file(s), ${r.size.lines} line(s)`];
  lines.push(`Recommended: ${r.recommended ?? 'stopped'}  budget ${r.budget[0]}+${r.budget[1]}`);
  lines.push(...r.why.map((w) => `  - ${w}`));
  r.options.forEach((o, i) => lines.push(`  ${i + 1}. ${o.pathway}${o.label ? ` (${o.label})` : ''}${o.available ? '' : ' [held]'}: ${o.reason}`));
  lines.push(`CodeRabbit 7-day count: ${r.capacity.count ?? 'unknown'} (${r.capacity.band})${r.capacity.warning ? `. ${r.capacity.warning}` : ''}`);
  if (r.config_drift) lines.push('Warning: branch config differs from main. The router uses the config of main.');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => /^--(confirm|apply)(=|$)/.test(a))) {
    console.error('pr-checkpoint: --confirm and --apply are not available yet (PR B). Nothing was written.');
    process.exit(2);
  }
  const bad = usageProblem(args);
  if (bad) {
    console.error(`pr-checkpoint: usage: ${bad}. Flags: --json, --dependabot, --facts <file>, --config <file>.`);
    process.exit(2);
  }
  try {
    const configText = readFileSync(opt(args, '--config') ?? path.join(ROOT, 'review-router.config.json'), 'utf8');
    const yaml = path.join(ROOT, '.coderabbit.yaml');
    const policy = { ...JSON.parse(configText), path_filters: pathFiltersFrom(existsSync(yaml) ? readFileSync(yaml, 'utf8') : '') };
    const factsFile = opt(args, '--facts');
    const facts = factsFile ? JSON.parse(readFileSync(factsFile, 'utf8')) : gatherFacts(configText);
    if (args.includes('--dependabot')) facts.dependabot = true;
    const result = recommend(facts, policy);
    console.log(args.includes('--json') ? JSON.stringify(result) : renderText(result));
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
