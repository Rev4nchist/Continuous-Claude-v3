#!/usr/bin/env node
// catchers-eval: measures the deterministic catchers (scripts/checks/catchers.mjs) on known commit ranges.
// Rows: target (broken head, expect the gate to FAIL on the PR's own file), post-fix (fixed head, expect PASS), clean (11 baseline PRs, expect PASS).
// Each row: extract the head tree to a temp folder, diff base..head, run runCatchers on that tree, record the verdict.
// The catcher code is the current worktree code. The tree only supplies the files under test.
//
// Verdicts: PASS, FAIL (the gate failed; for a target row, on the target file with a property or crash reason),
//   FAIL(other) (a target row whose gate failed on something else: import, export, another file), ERROR (a catcher tool crashed
//   or the row could not run). FAIL(other) and ERROR never match.
//
// Usage: node scripts/eval/review-eval/catchers-eval.mjs --run [--out <prefix>] [--only <id,id>] [--baseline <dir>]
//        node scripts/eval/review-eval/catchers-eval.mjs --list [--only <id,id>]
// With no arguments it prints the usage and exits 2: the CLI smoke gate runs every changed script with no arguments.
// Output: <prefix>.json and <prefix>.md (default .claude/cache/e2e/2026-11-04-p2-catchers-eval).
// Exit: 0 all rows match, 1 a row does not match (an ERROR row counts), 2 bad usage or --only matches no row.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCatchers } from '../../checks/catchers.mjs';
import { KNOWN_LIMITS, scrubCases } from '../../checks/parser-fixtures/inputs.mjs';
import { REGISTRY } from '../../checks/parser-fixtures/registry.mjs';
import { defaultExtract } from '../../github/cursor-review.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// The TREX baseline records are gitignored cache files. CATCHERS_EVAL_BASELINE points at them from a worktree.
export const DEFAULT_BASELINE = process.env.CATCHERS_EVAL_BASELINE || path.join(REPO_ROOT, '.claude', 'cache', 'e2e', 'trex-baseline');
export const DEFAULT_OUT = path.join(REPO_ROOT, '.claude', 'cache', 'e2e', '2026-11-04-p2-catchers-eval');
const GIT_BUFFER = 256 * 1024 * 1024;
const REASONS_MAX = 8;
const ARGV_ENOENT = 'ENOENT or EISDIR on a path built from argv';
const IMPORT_FAILURE_RE = /ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find (?:module|package)/;

/**
 * Rows with a fixed range. expected is the gate verdict the catchers must give.
 * targetFile: the file of the PR's Major. A target row matches only when a failing smoke script or fixture entry is this file.
 * PR200-post is the PR's final head before the merge (gh api repos/Rev4nchist/Continuous-Claude-v3/pulls/200 --jq .head.sha
 * gives 5f491a64694b3870949cdd268b2c5e3940f1c08b; the merge commit is a309dd66). 16b8f382 was an intermediate commit.
 */
export const FIXED_ROWS = [
  { id: 'PR211-pre', group: 'target', pr: 211, base: '4ff7dc66', head: '2aabe283', expected: 'FAIL', targetFile: 'scripts/settings/remove-maestro-registrations.mjs' },
  { id: 'PR200-pre', group: 'target', pr: 200, base: 'beb9d5ef', head: '23b62e5d', expected: 'FAIL', targetFile: 'apps/agentic-os/src/server/sources/safe-message.ts' },
  { id: 'PR222-pre', group: 'target', pr: 222, base: 'dce71cdc', head: '91b0b4c8', expected: 'FAIL', targetFile: '.claude/plugins/ccv3-mods/hooks/agentic-os/brief.ts' },
  { id: 'PR211-post', group: 'post-fix', pr: 211, base: '4ff7dc66', head: '574eb221', expected: 'PASS' },
  { id: 'PR200-merged', group: 'target', pr: 200, base: 'beb9d5ef', head: '5f491a64', expected: 'FAIL', targetFile: 'apps/agentic-os/src/server/sources/safe-message.ts' },
  { id: 'PR200-post', group: 'post-fix', pr: 200, base: '3a2dcaac', head: '34701f70', expected: 'PASS' },
  { id: 'PR222-post', group: 'post-fix', pr: 222, base: 'dce71cdc', head: '61f94d52', expected: 'PASS' },
];

/** The clean baseline PRs: record id and PR number. The heads come from the record files. */
export const CLEAN_PRS = { N3: 237, N7: 210, N8: 226, N9: 247, N10: 254, N11: 255, N12: 222, N13: 265, N14: 266, N15: 211, N16: 242 };

/** Reads one baseline record. Returns the record object, or throws. */
export function readRecord(baselineDir, id) {
  return JSON.parse(readFileSync(path.join(baselineDir, id, 'record.json'), 'utf8'));
}

/**
 * Builds the clean rows. The base is the record's mergeBase, else its pullBaseSha. A record without a head or a base
 * gives a row with `problem` set, so the table shows the gap and the run does not skip it.
 * read(id) returns the record. A throw gives a row with `problem`.
 */
export function cleanRows(read, prs = CLEAN_PRS) {
  return Object.entries(prs).map(([id, pr]) => {
    const row = { id: `${id}-clean`, group: 'clean', pr, expected: 'PASS', base: null, head: null };
    try {
      const rec = read(id);
      row.head = rec.head ?? null;
      row.base = rec.mergeBase ?? rec.pullBaseSha ?? null;
      if (!row.head || !row.base) row.problem = `record ${id} has no ${row.head ? 'base' : 'head'}`;
    } catch (err) {
      row.problem = `record ${id} unreadable: ${String(err.message).split('\n')[0]}`;
    }
    return row;
  });
}

// ---------- the verdict of one row ----------

const failedSmoke = (r) => r.smoke.results.filter((x) => x.verdict === 'FAIL');
const failedFixtures = (r) => r.fixtures.results.filter((x) => x.failureCount > 0);

/** Short reason lines for the table: which catcher fired, on which script or parser, and why. */
export function reasonsOf(result) {
  const out = [];
  for (const s of failedSmoke(result)) {
    const run = s.runs.find((x) => x.verdict === 'FAIL');
    out.push(`cli-smoke: ${s.path}${run ? ` ${run.args.join(' ') || '(no args)'}: ${String(run.reason).replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
  }
  for (const f of failedFixtures(result)) {
    const first = f.failures[0];
    out.push(`parser-fixtures: ${f.id} (${f.file}): ${f.failureCount} failure(s)${first ? `, e.g. ${JSON.stringify(String(first.input).slice(0, 40))} -> ${String(first.reason).slice(0, 80)}` : ''}`);
  }
  return out.slice(0, REASONS_MAX);
}

/** A smoke run that failed because a module could not load is an import failure, not a catch of a CLI bug. */
const isImportFailure = (run) => run.reason !== ARGV_ENOENT && IMPORT_FAILURE_RE.test((run.stderr ?? []).join('\n'));

/** True when a failing smoke script is the target file, with a crash reason that is not an import failure. */
const smokeCaught = (result, file) => failedSmoke(result).some((s) => s.path === file && s.runs.some((run) => run.verdict === 'FAIL' && !isImportFailure(run)));

/** True when a failing fixture entry is on the target file, with a property failure (not "(import)" or "(export)"). */
const fixtureCaught = (result, file) => failedFixtures(result).some((f) => f.file === file && f.failures.some((x) => !/^\((?:import|export)\)/.test(String(x.input))));

const caughtTarget = (row, result) => !row.targetFile || smokeCaught(result, row.targetFile) || fixtureCaught(result, row.targetFile);

function verdictOf(row, result) {
  if ((result.errors ?? []).length > 0) return 'ERROR';
  if (!result.gateFailed) return 'PASS';
  return row.group === 'target' && !caughtTarget(row, result) ? 'FAIL(other)' : 'FAIL';
}

/** Turns a runCatchers result into the row record. Never throws on a well-formed result. */
export function judgeRow(row, result, durationMs = 0) {
  const actual = verdictOf(row, result);
  const fx = result.fixtures;
  return {
    id: row.id, group: row.group, pr: row.pr, base: row.base, head: row.head, expected: row.expected, targetFile: row.targetFile ?? null,
    actual, match: actual === row.expected, reasons: reasonsOf(result),
    smokeFailed: result.smoke.failed, smokeChecked: result.smoke.checked, smokeTimeouts: result.smoke.timeouts ?? result.smoke.results.filter((x) => x.verdict === 'TIMEOUT').length,
    fixtureFailed: fx.failed, fixturesRun: fx.results.length, fixturesSkipped: (fx.skipped ?? []).length, fixturePropertyErrors: (fx.errors ?? []).length, fixtureIds: fx.results.map((x) => x.id),
    tscErrors: result.typecheck.errors.length, tscSkipped: result.typecheck.skipped ?? null,
    mappedTests: result.mappedTests.map((t) => t.id), toolErrors: result.errors, files: result.files.length, durationMs,
  };
}

/** A row that could not run (bad record, extract failed). It never matches, so it can not pass by accident. */
export function errorRow(row, message) {
  return {
    id: row.id, group: row.group, pr: row.pr, base: row.base, head: row.head, expected: row.expected, targetFile: row.targetFile ?? null,
    actual: 'ERROR', match: false, reasons: [message], smokeFailed: 0, smokeChecked: 0, smokeTimeouts: 0,
    fixtureFailed: 0, fixturesRun: 0, fixturesSkipped: 0, fixturePropertyErrors: 0, fixtureIds: [],
    tscErrors: 0, tscSkipped: null, mappedTests: [], toolErrors: [], files: 0, durationMs: 0,
  };
}

/** How many clean rows ran each registry entry. A row that ended in ERROR ran nothing that counts. */
function fixtureCoverage(clean) {
  const ran = clean.filter((r) => r.actual !== 'ERROR');
  return Object.fromEntries(REGISTRY.map((e) => [e.id, ran.filter((r) => (r.fixtureIds ?? []).includes(e.id)).length]));
}

/** Totals over the row records. tscByCleanPr maps a clean row id to its changed-line tsc error count. */
export function totalsOf(rows) {
  const of = (g) => rows.filter((r) => r.group === g);
  const [target, post, clean] = [of('target'), of('post-fix'), of('clean')];
  return {
    targetFail: { count: target.filter((r) => r.actual === 'FAIL').length, of: target.length },
    postFixPass: { count: post.filter((r) => r.actual === 'PASS').length, of: post.length },
    cleanFailures: { count: clean.filter((r) => r.actual === 'FAIL').length, of: clean.length },
    cleanErrors: clean.filter((r) => r.actual === 'ERROR').length,
    cleanTscErrors: Object.fromEntries(clean.map((r) => [r.id, r.tscErrors])),
    cleanTscTotal: clean.reduce((n, r) => n + r.tscErrors, 0),
    cleanRowsTotal: clean.length,
    cleanSmokeRows: clean.filter((r) => r.actual !== 'ERROR' && r.smokeChecked > 0).length,
    cleanFixtureCoverage: fixtureCoverage(clean),
    toolErrorRows: rows.filter((r) => r.toolErrors.length > 0).map((r) => r.id),
    mismatches: rows.filter((r) => !r.match).map((r) => r.id),
  };
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

const smokeCell = (r) => `${r.smokeFailed}/${r.smokeChecked}${r.smokeTimeouts ? ` (${r.smokeTimeouts} timeout)` : ''}`;
const fixturesCell = (r) => `${r.fixtureFailed}/${r.fixturesRun}${r.fixturesSkipped ? ` (${r.fixturesSkipped} skipped)` : ''}${r.fixturePropertyErrors ? ` (${r.fixturePropertyErrors} prop err)` : ''}`;

/** The KNOWN_LIMITS cells the scrub fixtures leave out, read from the code. */
function knownLimitLines() {
  const cells = scrubCases({ includeLimits: true }).length - scrubCases().length;
  return [
    `- KNOWN_LIMITS cells skipped on the PR 200 rows (the scrubbers in safe-message.ts; ${cells} cells in all):`,
    ...KNOWN_LIMITS.map((l) => `  - root=${l.root} seg=${l.segs.join(', ')}: ${l.reason}`),
  ];
}

function provenanceLines() {
  const merged = FIXED_ROWS.find((r) => r.id === 'PR200-merged');
  const post = FIXED_ROWS.find((r) => r.id === 'PR200-post');
  return [
    '## Provenance', '',
    '- The PR 200 scrub fixtures (the url and mdlink tails, the unclosed-quote wraps dqopen and sqopen) and the PR 222 brief fixtures were written from the current, post-fix code and tests.',
    '  The PR 200 and PR 222 catches are regression evidence, not out-of-sample holdout evidence.',
    '- The PR 211 smoke catch is general: the smoke run gives --help and no arguments to any changed CLI and uses no PR-specific input.',
    `- PR200-merged uses ${merged.head}, the final head of PR 200 before the merge (gh api repos/Rev4nchist/Continuous-Claude-v3/pulls/200 --jq .head.sha; merged as a309dd66). PR 200 merged with path shapes that still leaked a file name, so this row is an escaped bug and is expected to FAIL.`,
    `- PR200-post is ${post.head} ("stop two path shapes leaking a file name past the scrubber"), the main commit that fixed that leak after the merge, diffed against its parent ${post.base}. It is expected to PASS.`,
    '- A target row counts as a catch only when a failing smoke script or fixture entry is the PR\'s own file, with a property or crash reason. An import or export failure, or a failure in another file, is FAIL(other) and does not match.',
    ...knownLimitLines(), '',
  ];
}

/** The markdown report: one table, then the totals, then the provenance. */
export function renderMd(rows, totals, meta = {}) {
  const t = totals;
  const lines = [
    '# Catchers eval (review engine P2, K4)', '',
    `Run: ${meta.ts ?? ''} on ${meta.sha ?? ''}. Catcher code: the current worktree. One row per range.`, '',
    '| Row | Group | PR | Range | Expected | Actual | Match | Smoke failed/checked | Fixtures failed/run | tsc (changed lines) | Mapped tests | Reasons |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.group} | ${r.pr} | ${String(r.base).slice(0, 8)}..${String(r.head).slice(0, 8)} | ${r.expected} | ${r.actual} | ${r.match ? 'yes' : 'NO'} | ${smokeCell(r)} | ${fixturesCell(r)} | ${r.tscSkipped ? 'skipped' : r.tscErrors} | ${r.mappedTests.length} | ${cell(r.reasons.join('; ')) || '-'} |`),
    '', '## Totals', '',
    `- Target rows with gate FAIL on the target file: ${t.targetFail.count} of ${t.targetFail.of}`,
    `- Post-fix rows with gate PASS: ${t.postFixPass.count} of ${t.postFixPass.of}`,
    `- Clean rows with gate FAIL (false blocks): ${t.cleanFailures.count} of ${t.cleanFailures.of}`,
    `- Clean rows that could not run: ${t.cleanErrors}`,
    `- Clean rows that ran smoke: ${t.cleanSmokeRows} of ${t.cleanRowsTotal}`,
    `- Clean rows that ran each fixture entry: ${Object.entries(t.cleanFixtureCoverage).map(([id, n]) => `${id}=${n}`).join(', ')} (of ${t.cleanRowsTotal})`,
    `- tsc changed-line errors per clean PR: ${Object.entries(t.cleanTscErrors).map(([k, v]) => `${k.replace('-clean', '')}=${v}`).join(', ')} (total ${t.cleanTscTotal})`,
    `- Rows with a catcher tool error: ${t.toolErrorRows.length ? t.toolErrorRows.join(', ') : 'none'}`,
    `- Mismatched rows: ${t.mismatches.length ? t.mismatches.join(', ') : 'none'}`,
    '', ...provenanceLines(),
  ];
  return `${lines.join('\n')}\n`;
}

// ---------- running a row ----------

function git(root, args) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: GIT_BUFFER });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function mustGit(root, args) {
  const r = git(root, args);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split('\n')[0]}`);
  return r.stdout;
}

/** Extracts the head tree into a temp folder. Returns { dir, cleanup }. */
export function materialize(root, head, tmpRoot = os.tmpdir()) {
  const work = mkdtempSync(path.join(tmpRoot, 'catchers-eval-'));
  const dir = path.join(work, 'tree');
  const cleanup = () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } };
  try {
    mkdirSync(dir);
    const r = defaultExtract({ dir, work, root, head });
    if (r.error || r.status !== 0) throw new Error(`tree checkout failed: ${r.error?.message ?? String(r.stderr).trim().split('\n')[0]}`);
    return { dir, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Runs one row. deps (tests): { run, extract, gitOut }. Returns the row record. Always cleans the temp folder. */
export async function evaluateRow(row, { root = REPO_ROOT, run = runCatchers, extract = materialize, gitOut = mustGit } = {}) {
  if (row.problem) return errorRow(row, row.problem);
  const started = Date.now();
  let tree;
  try {
    const head = gitOut(root, ['rev-parse', '--verify', `${row.head}^{commit}`]).trim();
    const base = gitOut(root, ['rev-parse', '--verify', `${row.base}^{commit}`]).trim();
    const mergeBase = gitOut(root, ['merge-base', base, head]).trim();
    const diffText = gitOut(root, ['diff', '--no-color', '--no-ext-diff', '--no-renames', mergeBase, head]);
    tree = extract(root, head);
    const result = await run({ root: tree.dir, diffText });
    return judgeRow(row, result, Date.now() - started);
  } catch (err) {
    return errorRow(row, `row failed: ${String(err.message).split('\n')[0]}`);
  } finally {
    tree?.cleanup();
  }
}

// ---------- command line ----------

const USAGE = 'usage: node scripts/eval/review-eval/catchers-eval.mjs --run [--out <prefix>] [--only <id,id>] [--baseline <dir>, default $CATCHERS_EVAL_BASELINE or .claude/cache/e2e/trex-baseline] | --list [--only <id,id>] | --help';

export function parseCli(argv) {
  const out = { list: false, run: false, help: false };
  const flags = { '--out': 'out', '--only': 'only', '--baseline': 'baseline' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--run') out.run = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (flags[a]) {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) return { error: `${a} needs a value` };
      out[flags[a]] = v;
      i += 1;
    } else return { error: `unknown argument ${JSON.stringify(a)}` };
  }
  return out;
}

function currentSha(root) {
  return git(root, ['rev-parse', '--short=12', 'HEAD']).stdout.trim();
}

/**
 * Returns the exit code: 0 all rows match, 1 a row does not match, 2 bad usage or --only matches no row.
 * deps (tests): stdout, stderr, rows, and the evaluateRow deps { run, extract, gitOut }.
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const args = parseCli(argv);
  if (args.error) { stderr(`catchers-eval: ${args.error}\n${USAGE}`); return 2; }
  if (args.help) { stdout(USAGE); return 0; }
  if (!args.run && !args.list) { stdout(USAGE); return 2; }
  const baseline = args.baseline ?? DEFAULT_BASELINE;
  const all = deps.rows ?? [...FIXED_ROWS, ...cleanRows((id) => readRecord(baseline, id))];
  const only = args.only ? new Set(args.only.split(',')) : null;
  const rows = only ? all.filter((r) => only.has(r.id)) : all;
  if (rows.length === 0) { stderr(`catchers-eval: --only ${args.only} matches no row. Rows: ${all.map((r) => r.id).join(', ')}`); return 2; }
  if (args.list) { rows.forEach((r) => stdout(`${r.id} ${r.group} PR${r.pr} ${String(r.base).slice(0, 8)}..${String(r.head).slice(0, 8)} expect ${r.expected}`)); return 0; }
  const records = [];
  for (const row of rows) {
    const rec = await evaluateRow(row, deps);
    stdout(`${rec.id.padEnd(12)} expected ${rec.expected} actual ${rec.actual} ${rec.match ? 'ok' : 'MISMATCH'} (${Math.round(rec.durationMs / 1000)} s)`);
    records.push(rec);
  }
  const totals = totalsOf(records);
  const meta = { ts: new Date().toLocaleString('sv-SE'), sha: currentSha(REPO_ROOT) };
  const prefix = args.out ?? DEFAULT_OUT;
  mkdirSync(path.dirname(prefix), { recursive: true });
  writeFileSync(`${prefix}.json`, `${JSON.stringify({ meta, totals, rows: records }, null, 2)}\n`);
  writeFileSync(`${prefix}.md`, renderMd(records, totals, meta));
  stdout(`target FAIL ${totals.targetFail.count}/${totals.targetFail.of}, post-fix PASS ${totals.postFixPass.count}/${totals.postFixPass.of}, clean FAIL ${totals.cleanFailures.count}/${totals.cleanFailures.of}, clean tsc total ${totals.cleanTscTotal}, tool-error rows ${totals.toolErrorRows.length}, mismatches ${totals.mismatches.length}`);
  return totals.mismatches.length === 0 ? 0 : 1;
}

function isMain() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMain()) process.exitCode = await main(process.argv.slice(2));
