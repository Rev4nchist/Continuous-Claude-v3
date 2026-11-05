#!/usr/bin/env node
/**
 * catchers.mjs: runs the deterministic catchers on a tree and a diff, and writes the facts for the reviewer.
 *
 * Usage:
 *   node scripts/checks/catchers.mjs --base <ref> --head <ref|WORKTREE> [--root <dir>] [--json <file>] [--md <file>] [--run-tests]
 *   node scripts/checks/catchers.mjs --root <dir> --diff <file> [--json <file>] [--md <file>] [--run-tests]
 *
 * Catchers: cli-smoke (gate), parser-fixtures (gate), typecheck-changed (fact), mapped tests (fact).
 *   - Gate: smoke.failed > 0, fixtures.failed > 0, or a crash of the smoke or the fixtures tool (no verdict is a failed gate,
 *     not a pass). Nothing else blocks. A smoke TIMEOUT, a fixture skip or property error, a tsc error, a tsc crash and
 *     a mapped test result are facts.
 *   - mappedTests lists the node --test gates that pre-pr would run for the changed files (gatesFor in pre-pr.mjs).
 *     --run-tests runs them, each with its own timeout, and records PASS or FAIL. Without it they are only listed.
 *   - --head WORKTREE diffs the working tree, untracked files included, against the merge base with --base.
 *     Any other --head diffs <base>...<head>. In both cases --root must hold the checked-out head.
 * Exit codes: 0 no gate failure, 1 a gate failed, 2 bad usage or a git error.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatesFor } from '../github/pre-pr.mjs';
import { changedLines } from './changed-lines.mjs';
import { runSmoke } from './cli-smoke.mjs';
import { runFixtures } from './parser-fixtures.mjs';
import { runTypecheck } from './typecheck-changed.mjs';

export const FACTS_MAX_BYTES = 4096;
const LINE_MAX = 200;
const MAX_LISTED = 5;
const GIT_BUFFER = 64 * 1024 * 1024;
const WORKTREE = 'WORKTREE';

// ---------- diff from git ----------

function git(root, args) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: GIT_BUFFER });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A ref must not look like an option: it goes into a git command line. */
function assertRef(ref, name) {
  if (typeof ref !== 'string' || ref === '' || ref.startsWith('-') || /[\s\0]/.test(ref)) throw new Error(`${name} "${ref}" is not a usable git ref`);
}

function mustGit(root, args) {
  const r = git(root, args);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split('\n')[0]}`);
  return r.stdout;
}

/** A new-file diff for each untracked file. `git diff --no-index` exits 1 when the files differ. */
function untrackedDiff(root) {
  const names = mustGit(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  return names.map((name) => {
    const r = git(root, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', name]);
    return r.status === 0 || r.status === 1 ? r.stdout : '';
  }).join('');
}

/** The unified diff of the change. head WORKTREE: working tree against the merge base, plus untracked files. */
export function diffFromGit(root, base, head) {
  assertRef(base, '--base');
  assertRef(head, '--head');
  if (head !== WORKTREE) return mustGit(root, ['diff', '--no-color', '--no-ext-diff', `${base}...${head}`]);
  const mb = git(root, ['merge-base', base, 'HEAD']);
  const from = mb.status === 0 ? mb.stdout.trim() : base;
  return mustGit(root, ['diff', '--no-color', '--no-ext-diff', from]) + untrackedDiff(root);
}

// ---------- running the catchers ----------

/** The node --test gates that cover the changed files. The always gates and other tools are not tests. */
export function mappedTestGates(files) {
  return gatesFor(files).filter((g) => g.cmd === 'node' && g.args[0] === '--test');
}

const commandOf = (g) => `${g.cmd} ${g.args.join(' ')}`;

const errCode = (err) => (err && typeof err === 'object' && 'code' in err ? err.code : undefined);

function defaultExec(gate, root) {
  const r = spawnSync(gate.cmd, gate.args, { cwd: path.join(root, gate.cwd ?? '.'), encoding: 'utf8', windowsHide: true, timeout: gate.timeoutMs, killSignal: 'SIGKILL', maxBuffer: GIT_BUFFER });
  return { status: r.status, timedOut: errCode(r.error) === 'ETIMEDOUT', error: r.error && errCode(r.error) !== 'ETIMEDOUT' ? r.error.message : null, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

/** The last line of the output that looks like a node --test total, else the last line. */
function testSummary(output) {
  const lines = String(output).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.filter((l) => /^#\s*(?:pass|fail)\s+\d+/i.test(l)).join(' / ') || lines.at(-1) || '';
}

function runTestGate(gate, root, exec) {
  const row = { id: gate.id, command: commandOf(gate), status: 'NOT_RUN', summary: '' };
  const r = exec(gate, root);
  if (r.timedOut) return { ...row, status: 'TIMEOUT', summary: `timed out after ${Math.round(gate.timeoutMs / 1000)} s` };
  if (r.error) return { ...row, status: 'FAIL', summary: `could not start: ${r.error}` };
  return { ...row, status: r.status === 0 ? 'PASS' : 'FAIL', summary: testSummary(r.output) };
}

/** A catcher that throws is recorded as { error } and the others still run. */
async function guarded(name, fn, fallback) {
  try { return await fn(); } catch (err) { return { ...fallback, error: `${name} crashed: ${String(err?.message ?? err).split('\n')[0]}` }; }
}

/**
 * input: { root, diffText, files }. root: the tree that holds the changed files. diffText: the unified diff.
 * files (optional): the changed paths; the default is the files of the diff.
 * @param {{ root: string, diffText: string, files?: string[] }} input
 * @param {{ runTests?: boolean, exec?: Function, smoke?: Function, fixtures?: Function, typecheck?: Function }} [opts]
 * opts: { runTests, exec(gate, root) } and tool overrides { smoke, fixtures, typecheck } for tests.
 * Returns { files, typecheck, smoke, fixtures, mappedTests, gateFailed, errors }.
 */
export async function runCatchers({ root, diffText, files }, opts = {}) {
  const tree = path.resolve(root);
  const changed = changedLines(diffText ?? '');
  const list = files ?? changed.map((c) => c.path);
  const tools = { smoke: runSmoke, fixtures: runFixtures, typecheck: runTypecheck, ...opts };
  const smoke = await guarded('cli-smoke', () => tools.smoke({ root: tree, files: list }), { results: [], failed: 0, timeouts: 0, checked: 0 });
  const fixtures = await guarded('parser-fixtures', () => tools.fixtures({ root: tree, files: list }), { results: [], skipped: [], errors: [], failed: 0 });
  const typecheck = await guarded('typecheck', () => tools.typecheck({ root: tree, files: list, ranges: changed }), { errors: [], skipped: null });
  const gates = mappedTestGates(list);
  const mappedTests = opts.runTests ? gates.map((g) => runTestGate(g, tree, opts.exec ?? defaultExec)) : gates.map((g) => ({ id: g.id, command: commandOf(g), status: 'NOT_RUN', summary: '' }));
  const errors = [smoke, fixtures, typecheck].map((r) => r.error).filter(Boolean);
  const gateFailed = smoke.failed > 0 || fixtures.failed > 0 || Boolean(smoke.error) || Boolean(fixtures.error);
  return { files: list, typecheck, smoke, fixtures, mappedTests, gateFailed, errors };
}

// ---------- facts for the reviewer ----------

/** One line of plain text: control characters and long runs are cut, so a value cannot add lines. */
const oneLine = (s, max = LINE_MAX) => {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
};

function smokeLines(smoke) {
  const bad = smoke.results.filter((r) => r.verdict === 'FAIL');
  const slow = smoke.results.filter((r) => r.verdict === 'TIMEOUT');
  const timeouts = smoke.timeouts ?? slow.length;
  const head = `cli-smoke GATE: ${smoke.failed} failed of ${smoke.checked} script(s) run${timeouts > 0 ? `, ${timeouts} timeout(s) (fact, not a failure)` : ''}`;
  const rowOf = (verdict) => (r) => r.runs.filter((x) => x.verdict === verdict).slice(0, 1).map((x) => `  ${verdict} ${r.path} ${x.args.join(' ') || '(no args)'}: ${oneLine(x.reason)}`);
  const rows = bad.slice(0, MAX_LISTED).flatMap(rowOf('FAIL'));
  const slowRows = slow.slice(0, MAX_LISTED).flatMap(rowOf('TIMEOUT'));
  const envRows = smoke.results.filter((r) => r.verdict === 'ENV').slice(0, MAX_LISTED).flatMap(rowOf('ENV'));
  return [head, ...rows, ...(bad.length > MAX_LISTED ? [`  ... ${bad.length - MAX_LISTED} more script(s)`] : []), ...slowRows, ...envRows];
}

function fixtureLines(fx) {
  const bad = fx.results.filter((r) => r.failureCount > 0);
  const skipped = fx.skipped ?? [];
  const errors = fx.errors ?? [];
  const extra = [skipped.length ? `${skipped.length} skipped` : '', errors.length ? `${errors.length} property error(s)` : ''].filter(Boolean);
  const head = `parser-fixtures GATE: ${fx.failed} failure(s) in ${fx.results.length} parser(s) run${extra.length ? `, ${extra.join(', ')}` : ''}`;
  const rows = bad.slice(0, MAX_LISTED).flatMap((r) => [`  FAIL ${r.id} (${r.file}): ${r.failureCount} failure(s)`, ...r.failures.slice(0, 2).map((f) => `    ${oneLine(f.input, 80)} -> ${oneLine(f.reason, 120)}`)]);
  const skips = skipped.slice(0, 3).map((k) => `  skipped ${k.id}: ${oneLine(k.reason, 120)}`);
  const errs = errors.slice(0, 3).map((e) => `  property error ${e.id}: ${oneLine(e.reason, 120)}`);
  return [head, ...rows, ...(bad.length > MAX_LISTED ? [`  ... ${bad.length - MAX_LISTED} more parser(s)`] : []), ...skips, ...errs];
}

function typecheckLines(tc) {
  if (tc.skipped) return [`tsc (fact): skipped, ${oneLine(tc.skipped)}`];
  const head = `tsc (fact, changed lines only): ${tc.errors.length} error(s)`;
  return [head, ...tc.errors.slice(0, MAX_LISTED).map((e) => `  ${e.path}:${e.line} ${e.code} ${oneLine(e.message, 140)}`), ...(tc.errors.length > MAX_LISTED ? [`  ... ${tc.errors.length - MAX_LISTED} more`] : [])];
}

function testLines(tests) {
  if (tests.length === 0) return ['mapped tests (fact): none map to the changed files'];
  const ran = tests.some((t) => t.status !== 'NOT_RUN');
  const rows = tests.slice(0, MAX_LISTED + 3).map((t) => `  ${t.status === 'NOT_RUN' ? 'listed' : t.status} ${t.id}: ${oneLine(t.summary || t.command, 140)}`);
  return [`mapped tests (fact, ${ran ? 'run' : 'listed, not run'}): ${tests.length} gate(s)`, ...rows];
}

/** Lines in priority order; the tail is dropped when the text passes the byte cap. */
function fitLines(lines, maxBytes) {
  const kept = [];
  let size = 0;
  for (const line of lines) {
    if (size + Buffer.byteLength(line) + 1 > maxBytes) break;
    kept.push(line);
    size += Buffer.byteLength(line) + 1;
  }
  return kept.length === lines.length ? kept : [...kept, `[cut: ${lines.length - kept.length} more line(s)]`];
}

/**
 * The facts as plain lines for the reviewer, about 4 KB at most. No heading and no fence: context.mjs adds them once.
 * Order: catcher errors first (the byte cap cuts the tail, so an error is never cut), then the gates, then the facts.
 */
export function factsBody(result) {
  const body = [
    ...result.errors.map((e) => `catcher error: ${oneLine(e)}`),
    ...smokeLines(result.smoke), ...fixtureLines(result.fixtures), ...typecheckLines(result.typecheck), ...testLines(result.mappedTests),
  ];
  return `${fitLines(body, FACTS_MAX_BYTES - 64).join('\n')}\n`;
}

/** One summary line for the terminal and for the pre-pr gate output. */
export function summaryOf(result) {
  const parts = [`smoke ${result.smoke.failed} failed of ${result.smoke.checked}`, `fixtures ${result.fixtures.failed} failed`, `tsc ${result.typecheck.errors.length} error(s)`, `${result.mappedTests.length} mapped test gate(s)`];
  if (result.errors.length) parts.push(`${result.errors.length} catcher error(s)`);
  return `catchers: ${result.gateFailed ? 'FAIL' : 'ok'}: ${parts.join(', ')}`;
}

// ---------- command line ----------

const USAGE = 'usage: node scripts/checks/catchers.mjs (--base <ref> --head <ref|WORKTREE> | --diff <file>) [--root <dir>] [--json <file>] [--md <file>] [--run-tests]';
const VALUE_FLAGS = { '--base': 'base', '--head': 'head', '--root': 'root', '--diff': 'diff', '--json': 'json', '--md': 'md' };

export function parseCli(argv) {
  const out = { runTests: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--run-tests') out.runTests = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (VALUE_FLAGS[a]) {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) return { error: `${a} needs a value` };
      out[VALUE_FLAGS[a]] = v;
      i += 1;
    } else return { error: `unknown argument ${JSON.stringify(a)}` };
  }
  if (out.help) return out;
  if (out.diff && (out.base || out.head)) return { error: 'use --diff or --base with --head, not both' };
  if (!out.diff && !(out.base && out.head)) return { error: 'pass --base and --head, or --diff' };
  return out;
}

function writeOut(file, text) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, text);
}

/** Returns the exit code. deps (tests): stdout, stderr, runOpts (passed to runCatchers). */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const args = parseCli(argv);
  if (args.help) { stdout(USAGE); return 0; }
  if (args.error) { stderr(`catchers: ${args.error}\n${USAGE}`); return 2; }
  const root = path.resolve(args.root ?? process.cwd());
  let diffText;
  try { diffText = args.diff ? readFileSync(args.diff, 'utf8') : diffFromGit(root, args.base, args.head); } catch (err) {
    stderr(`catchers: ${err.message}`);
    return 2;
  }
  const result = await runCatchers({ root, diffText }, { runTests: args.runTests, ...deps.runOpts });
  if (args.json) writeOut(args.json, `${JSON.stringify(result, null, 2)}\n`);
  if (args.md) writeOut(args.md, factsBody(result));
  for (const e of result.errors) stderr(`catchers: ${e}`);
  if (result.gateFailed) [...result.errors.map((e) => `catcher error: ${oneLine(e)}`), ...smokeLines(result.smoke), ...fixtureLines(result.fixtures)].forEach((l) => stdout(l));
  stdout(summaryOf(result));
  return result.gateFailed ? 1 : 0;
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2));
