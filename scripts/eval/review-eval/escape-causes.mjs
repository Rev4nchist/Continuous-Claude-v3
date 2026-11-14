#!/usr/bin/env node
// escape-causes.mjs: puts each escape row in one of the cause classes and prints the weekly report. It only reads.
//   Classes: the seven of .claudedocs/2026-11-07-prepr-checks-effectiveness.md ("Top gaps"), plus 'unclassified'.
//   Rows come from fix-chains.mjs (the one writer): <stateDir>/escapes.jsonl. The report prints counts only.
// Known limit: rule 1 uses today's gatesFor. A row from before a routing change may not read as wrong-surfaces.
// Usage: node scripts/eval/review-eval/escape-causes.mjs [--state-dir <dir>] [--since <iso>] [--from-json <fix-chains --json file>]
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatesFor as realGatesFor } from '../../github/pre-pr.mjs';

export const CAUSES = Object.freeze(['wrong-surfaces', 'advisory-major-open', 'mocked-fixture', 'no-behaviour-check', 'no-ci-vitest-linux', 'merge-interaction', 'thin-guard-tables', 'unclassified']);
/** The classes a better reviewer could have caught. The others are gates that did not run. */
export const REVIEWER_FIXABLE = Object.freeze(['advisory-major-open', 'thin-guard-tables']);
export const ESCAPES_FILE = 'escapes.jsonl';

/** The state dir: the option, then REVIEW_ENGINE_STATE_DIR, then the live dir. Read at call time, never at load. */
export function stateDirOf(opt, env = process.env) {
  return opt || env?.REVIEW_ENGINE_STATE_DIR || path.join(os.homedir(), '.claude', 'state', 'review-engine');
}

// ---------- classify ----------

const RULE_TEXT_DIRS = ['.claude/rules-src/', '.claude/rules-ondemand/', '.claude/skills/', '.claude/agents/'];
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const isTestGate = (g) => (g.cmd === 'node' && g.args?.[0] === '--test') || g.id === 'hooks-build' || g.id === 'hooks-vitest';
const testGateIds = (gatesFor, files) => new Set(gatesFor(files).filter(isTestGate).map((g) => g.id));

/** Rule 1: the fix needs a test gate that the blamed change did not. No blamed files: no guess. */
function wrongSurfaces({ fixFiles, blamedFiles, gatesFor }) {
  if (blamedFiles.length === 0) return false;
  const had = testGateIds(gatesFor, blamedFiles);
  return [...testGateIds(gatesFor, fixFiles)].some((id) => !had.has(id));
}

const RULES = [
  ['wrong-surfaces', wrongSurfaces],
  ['no-behaviour-check', ({ fixFiles }) => fixFiles.length > 0 && fixFiles.every((p) => RULE_TEXT_DIRS.some((d) => p.startsWith(d)))],
  // No rule for 'merge-interaction' on purpose. Blame of a rewritten block spans several PRs by nature, so "two or more blamed
  // PRs" is no evidence that two PRs broke together. The class stays in CAUSES (the report prints it at 0): the one known case
  // was fixed in a merge commit, which fix-chains skips. A multi-PR row falls through to the path rules, then 'unclassified'.
  ['mocked-fixture', ({ fixFiles }) => fixFiles.some((p) => `/${p}`.includes('/fixtures/') || baseOf(p).toLowerCase().includes('mock'))],
  ['no-ci-vitest-linux', ({ fixFiles }) => fixFiles.some((p) => p.startsWith('.github/workflows/'))],
  ['thin-guard-tables', ({ fixFiles }) => fixFiles.some((p) => p.startsWith('.claude/hooks/src/') && /guard|gate/.test(baseOf(p)))],
  ['advisory-major-open', ({ linkedFinding }) => Boolean(linkedFinding)],
];

/** One class per escape, first match wins, no guess: a row that fits no rule is 'unclassified'. */
export function classifyCause({ fixFiles = [], blamedFiles = [], linkedFinding, gatesFor = realGatesFor } = {}) {
  const ctx = { fixFiles: fixFiles.map(String), blamedFiles: blamedFiles.map(String), linkedFinding, gatesFor };
  return RULES.find(([, test]) => test(ctx))?.[0] ?? 'unclassified';
}

// ---------- report ----------

const countBy = (rows) => {
  const counts = Object.fromEntries(CAUSES.map((c) => [c, 0]));
  for (const r of rows) counts[CAUSES.includes(r.cause) ? r.cause : 'unclassified'] += 1;
  return counts;
};

/** Classes set by file path alone, not by reading the fix. thin-guard-tables is the reviewer-fixable one. */
const PATH_ONLY = Object.freeze(['thin-guard-tables']);
const PATH_ONLY_WARNING = 'class thin-guard-tables is set by file path, not by reading the fix; a range heavy in guard-file fixes raises this share';

const percent = (n, m) => `${Math.round((100 * n) / m)}%`;

/**
 * The share a reviewer could fix, on three lines that stay together (the seat asked for the caveats next to the number):
 *   1 the share of the primary rows, with its row count (a lower bound: rows carry no linkedFinding);
 *   2 the warning that thin-guard-tables is set by path alone;
 *   3 the share again with the path-only classes left out of both counts, or n/a when no row is left.
 */
function shareLines(counts, total) {
  const fixable = REVIEWER_FIXABLE.reduce((sum, c) => sum + counts[c], 0);
  const pathOnly = PATH_ONLY.reduce((sum, c) => sum + counts[c], 0);
  const m = total - pathOnly;
  const n = fixable - PATH_ONLY.filter((c) => REVIEWER_FIXABLE.includes(c)).reduce((sum, c) => sum + counts[c], 0);
  return [
    total === 0 ? 'reviewer-fixable share: n/a' : `reviewer-fixable share: ${fixable} of ${total} primary rows (${percent(fixable, total)}) (lower bound: rows carry no linkedFinding)`,
    PATH_ONLY_WARNING,
    m === 0 ? 'reviewer-fixable share without path-only classes: n/a' : `reviewer-fixable share without path-only classes: ${n} of ${m} primary rows (${percent(n, m)})`,
  ];
}

const WHOLE_RUN = ' (whole run, not filtered by --since)';

/** wholeRun: the rows were cut by --since, but these counts are of the whole run (no-target fixes carry no date). */
function noTargetLines(noTarget, wholeRun = false) {
  if (!noTarget) return ['fixes with no blame target: not available (pass --from-json <fix-chains --json file>)'];
  const entries = Object.entries(noTarget.byReason ?? {});
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  const detail = entries.length ? ` (${entries.map(([k, n]) => `${k} ${n}`).join(', ')})` : '';
  const note = wholeRun ? WHOLE_RUN : '';
  return [`fixes with no blame target: ${total}${detail}${note}`, `fix commits inside their own PR only (not counted as no-target): ${noTarget.inPrOnly ?? 0}${note}`];
}

/** The primary row of a fix PR is the latest merged blamed PR. An old row with no `primary` field counts as primary. */
const isPrimary = (r) => r.primary !== false;
const RULE_OF_THUMB = 'a rule of thumb (right in 4 of 4 doc cases), not a proven cause';

/**
 * Plain text, counts only. Per-cause counts use the primary rows: one per fix PR, the latest merged blamed PR. That choice is
 * a rule of thumb (right in 4 of 4 doc cases), not a proven cause. One line keeps the all-row counts, so the noise stays visible.
 * noTarget: { byReason: { reason: n }, inPrOnly } from the fix-chains totals, or absent.
 */
export function report(rows, { noTarget, wholeRun = false } = {}) {
  const primary = rows.filter(isPrimary);
  const counts = countBy(primary);
  const all = countBy(rows);
  return [
    `escape rows: ${rows.length} (primary ${primary.length})`,
    `by cause (primary rows only; ${RULE_OF_THUMB}):`,
    ...CAUSES.map((c) => `  ${c}: ${counts[c]}`),
    `all rows by cause (every blamed PR, the noise): ${CAUSES.map((c) => `${c} ${all[c]}`).join(', ')}`,
    ...shareLines(counts, primary.length),
    ...noTargetLines(noTarget, wholeRun),
  ].join('\n');
}

// ---------- read ----------

/** The rows of escapes.jsonl. A missing file is no rows. A damaged line is skipped. Read only. */
export function readEscapeRows(stateDir) {
  const file = path.join(stateDir, ESCAPES_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try { const row = JSON.parse(line); return row && typeof row === 'object' ? [row] : []; } catch { return []; }
  });
}

/** Rows merged at or after iso. A row with no date cannot be placed: it is dropped and counted. */
function since(rows, iso) {
  const t = Date.parse(iso);
  const dated = rows.filter((r) => Number.isFinite(Date.parse(r.fixMergedAt)));
  return { kept: dated.filter((r) => Date.parse(r.fixMergedAt) >= t), undated: rows.length - dated.length };
}

// ---------- command line ----------

const USAGE = 'usage: node scripts/eval/review-eval/escape-causes.mjs [--state-dir <dir>] [--since <iso>] [--from-json <fix-chains --json file>]';
const VALUE_FLAGS = { '--state-dir': 'stateDir', '--since': 'since', '--from-json': 'fromJson' };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (VALUE_FLAGS[a] && argv[i + 1] && !argv[i + 1].startsWith('--')) { out[VALUE_FLAGS[a]] = argv[i + 1]; i += 1; }
    else return { error: VALUE_FLAGS[a] ? `${a} needs a value` : `unknown argument ${JSON.stringify(a)}` };
  }
  if (out.since !== undefined && !Number.isFinite(Date.parse(out.since))) return { error: `--since ${JSON.stringify(out.since)} is not a date` };
  return out;
}

/** Returns the exit code. deps (tests): stdout, stderr, env. */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const args = parseArgs(argv);
  if (args.help) { stdout(USAGE); return 0; }
  if (args.error) { stderr(`escape-causes: ${args.error}\n${USAGE}`); return 2; }
  try {
    const fromRun = args.fromJson ? JSON.parse(readFileSync(args.fromJson, 'utf8')) : null;
    const dir = stateDirOf(args.stateDir, deps.env ?? process.env);
    if (args.fromJson && !Array.isArray(fromRun?.rows)) throw new Error(`${args.fromJson} has no rows array: it is not a fix-chains --json file`);
    const rows = args.fromJson ? fromRun.rows : readEscapeRows(dir);
    if (!args.fromJson && !existsSync(path.join(dir, ESCAPES_FILE))) stdout(`0 escape rows (no ${ESCAPES_FILE} in ${dir})`);
    const cut = args.since ? since(rows, args.since) : { kept: rows, undated: null };
    stdout(report(cut.kept, { noTarget: fromRun?.totals?.noTarget, wholeRun: Boolean(args.since) }));
    if (cut.undated !== null) stdout(`undated rows left out: ${cut.undated}`);
    return 0;
  } catch (err) {
    stderr(`escape-causes: ${String(err?.message ?? err).split('\n')[0]}`);
    return 2;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2));
