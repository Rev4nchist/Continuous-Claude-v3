#!/usr/bin/env node
/**
 * gate-coverage -- every tracked test file is in a gate or on a named skip list (card coord-test-gate-coverage).
 * Design note: .claudedocs/coordination/2026-11-16-coord-test-gate-coverage-design.md. Read-only: it writes nothing.
 *
 * A test file is GATED when a gate runs it. The reader counts only commands that RUN tests: a pre-pr gate (SURFACES and ALWAYS_GATES of pre-pr.mjs)
 * or a `run:` command of .github/workflows/*.yml whose command word is a runner (node, bash, sh, pwsh, powershell, python, uv, npx, claude, vitest,
 * pytest, playwright) and that names the test path or a glob. `npm run <script>` counts through the text of that package.json script, and only when a
 * gate calls it: a script that nothing calls is not a gate. A path inside echo, git, rm or a comment is not run. Runners that run a whole folder
 * (RUNNERS) count when their pre-pr gate exists. A file that no gate runs must be on the skip list (scripts/github/gate-coverage-skip.json, `skip`:
 * a path or glob and a reason). A file that only pre-pr runs must be on `ciGaps` (a path or glob and a reason): CI has no runner for it.
 * The check fails when:
 *   ungated            a test file is in no gate and on no skip entry
 *   stale-skip         a skip entry matches no test file
 *   duplicate-entry    the same path is listed twice in skip or in ciGaps
 *   gated-and-skipped  a file is gated and also on the skip list (the skip entry must go)
 *   pre-pr-only        a file only pre-pr runs is on no ciGaps entry
 *   stale-ci-gap       a ciGaps entry matches no pre-pr-only file
 *   dead-gate-glob     a gate or CI command names a test glob that matches no tracked file and `deadGates` does not name it
 *   stale-dead-gate    a `deadGates` entry names a glob that is no longer dead
 *   missing-gate-file  a gate or CI command names a test file that is not tracked
 *   skip-file          an entry has no path or no reason, or the file is malformed
 *   no-test-files / no-gated-files   a reader found nothing (it must not pass on nothing)
 * The exit line always prints the counts it read. Exit: 0 ok | 1 problems | 2 a source could not be read.
 *
 * Usage: node scripts/github/gate-coverage.mjs [--list]    (--list prints the file names of every problem)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
export const SKIP_FILE = 'scripts/github/gate-coverage-skip.json';

const TEST_RES = [/\.test\.(mjs|js|cjs|ts|tsx|sh|ps1)$/, /\.spec\.(ts|js)$/, /(^|\/)test_[^/]+\.py$/, /_test\.py$/];
export const isTestFile = (f) => TEST_RES.some((r) => r.test(f));

/** A glob as a RegExp over a forward-slash path. * stays in one folder, ** crosses folders, ? is one character. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The commands of the `run:` keys of one workflow file: single-line values, and `|` or `>` blocks. Comments, names and `if:` lines are not commands. */
export function commandsOfWorkflow(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)(-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length + (m[2] ? m[2].length : 0);
    const value = m[3].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const body = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const l = lines[j];
        if (l.trim() !== '' && l.length - l.trimStart().length <= indent) break;
        body.push(l.trim());
      }
      out.push(body.filter((l) => l && !l.startsWith('#')).join(value[0] === '>' ? ' ' : '\n'));
    } else if (value) out.push(value.replace(/\s#.*$/, ''));
  }
  return out;
}

// Command words that run tests. A segment whose command word is not here (echo, git, rm, cat, test, ls) runs nothing.
const RUNNER_WORDS = new Set(['node', 'bash', 'sh', 'pwsh', 'powershell', 'python', 'python3', 'uv', 'npx', 'claude', 'vitest', 'pytest', 'playwright']);
const NPM_WORDS = new Set(['npm', 'pnpm', 'yarn']);

/** The words of a segment after env assignments and the wrappers `timeout N`, `time`, `exec`. */
function commandWords(segment) {
  const w = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < w.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i += 1;
    else if (w[i] === 'timeout' && /^\d+[smh]?$/.test(w[i + 1] ?? '')) i += 2;
    else if (w[i] === 'time' || w[i] === 'exec') i += 1;
    else break;
  }
  return w.slice(i).map((x) => x.replace(/^["'(]+|["';,)]+$/g, ''));
}

/**
 * The test paths and test globs that a command RUNS, and the npm scripts it calls: {paths, npm}. Segments split at ; & | and line ends; only a segment
 * whose command word is a runner counts. Quotes are removed; flags and other words are left out.
 */
export function runsOf(command) {
  const paths = [];
  const npm = [];
  for (const seg of String(command).replace(/(^|\s)#[^\n]*/g, '$1').split(/[;&|\n]+/)) {
    const w = commandWords(seg);
    if (!w.length) continue;
    const head = w[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
    if (NPM_WORDS.has(head)) {
      const rest = w.slice(1).filter((x) => !x.startsWith('-'));
      if (rest[0] === 'run' || rest[0] === 'run-script') { if (rest[1]) npm.push(rest[1]); } else if (rest[0] === 'test' || rest[0] === 't') npm.push('test');
      continue;
    }
    if (!RUNNER_WORDS.has(head)) continue;
    for (const raw of w.slice(1)) {
      const t = raw.replace(/^\.\//, '');
      if (!t || t.startsWith('-')) continue;
      if (isTestFile(t.replace(/[*?]+/g, 'x'))) paths.push(t);
    }
  }
  return { paths, npm };
}

/** The runs of many commands, with npm scripts expanded through `scripts` ({name: command[]}) when a command calls them (depth 3). */
export function expandRuns(commands, scripts = {}) {
  const paths = [];
  const called = new Set();
  let level = commands;
  for (let depth = 0; depth < 3 && level.length; depth += 1) {
    const next = [];
    for (const c of level) {
      const r = runsOf(c);
      paths.push(...r.paths);
      for (const n of r.npm) if (!called.has(n)) { called.add(n); next.push(...(scripts[n] ?? [])); }
    }
    level = next;
  }
  return { paths, called: [...called] };
}

/** The files that some token names (exactly, or by glob). */
export function gatedBy(files, tokens) {
  const set = new Set();
  const exact = new Set(tokens.filter((t) => !/[*?]/.test(t)));
  const res = tokens.filter((t) => /[*?]/.test(t)).map(globToRegExp);
  for (const f of files) if (exact.has(f) || res.some((r) => r.test(f))) set.add(f);
  return set;
}

// Runners that run a whole folder. `gate` says which pre-pr gate runs it (the runner counts only when that gate exists); `ci` says whether a workflow
// command runs it too; `files(f, ctx)` is the set it covers (ctx.playwrightPure: the testMatch globs of the pure config, read from the config).
// Pinned to the real sources by gate-coverage.test.mjs: a rename must fail there, not drop coverage here.
// opc pytest is NOT a runner: its pre-pr gate runs only the opc test files a change touches (appendTouched), never the whole folder.
export const RUNNERS = [
  { id: 'hooks-vitest', gate: (g) => g.cmd === 'npx' && (g.args ?? []).includes('vitest') && g.cwd === '.claude/hooks', files: (f) => /^\.claude\/hooks\/src\/__tests__\/.+\.test\.ts$/.test(f), ci: (cmds) => cmds.some((c) => /\bvitest run\b/.test(c)) },
  { id: 'mods-plugin-test', gate: (g) => g.id === 'mods-validate', files: (f) => /^\.claude\/plugins\/ccv3-mods\/tests\/.+\.test\.ts$/.test(f), ci: () => false },
  { id: 'playwright-pure', gate: (g) => (g.args ?? []).includes('apps/agentic-os/playwright.pure.config.ts'), files: (f, ctx = {}) => (ctx.playwrightPure ?? []).some((g) => globToRegExp(`apps/agentic-os/e2e/${g}`).test(f)), ci: (cmds) => cmds.some((c) => c.includes('playwright.pure.config.ts')) },
];

/** The files the runners cover, for the pre-pr gates given. */
export function runnerFiles(files, gates, ctx = {}) {
  const set = new Set();
  for (const r of RUNNERS) if (gates.some((g) => r.gate(g))) for (const f of files) if (r.files(f, ctx)) set.add(f);
  return set;
}
function runnerFilesCi(files, gates, cmds, ctx) {
  const set = new Set();
  for (const r of RUNNERS) if (gates.some((g) => r.gate(g)) && r.ci(cmds)) for (const f of files) if (r.files(f, ctx)) set.add(f);
  return set;
}

/** The testMatch globs of a Playwright config text (strings of the testMatch array). */
export function testMatchOf(configText) {
  const m = /testMatch:\s*\[([^\]]*)\]/.exec(configText);
  return m ? [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] ?? x[2]) : [];
}

/** The skip file: { skip: [{path, reason}], ciGaps: [{path, reason}] }. A missing reason or a duplicate path is a problem. */
export function parseSkipFile(json) {
  const problems = [];
  const read = (key, required) => {
    const list = json && typeof json === 'object' ? json[key] : undefined;
    if (list === undefined && !required) return [];
    if (!Array.isArray(list)) { problems.push({ kind: 'skip-file', message: `"${key}" is not a list` }); return []; }
    const ok = [];
    const seen = new Set();
    for (const e of list) {
      if (!e || typeof e.path !== 'string' || !e.path.trim()) problems.push({ kind: 'skip-file', message: `an entry of "${key}" has no path` });
      else if (typeof e.reason !== 'string' || !e.reason.trim()) problems.push({ kind: 'skip-file', message: `the entry ${e.path} of "${key}" has no reason` });
      else {
        const p = e.path.replace(/^\.\//, '');
        if (seen.has(p)) problems.push({ kind: 'duplicate-entry', message: `the path ${p} is listed twice in "${key}"` });
        seen.add(p);
        ok.push({ path: p, reason: e.reason.trim() });
      }
    }
    return ok;
  };
  if (!json || typeof json !== 'object') problems.push({ kind: 'skip-file', message: 'the skip file is not an object' });
  return { skip: read('skip', true), ciGaps: read('ciGaps', false), deadGates: read('deadGates', false), problems };
}

/** The verdict: problems and counts. `ci` and `prepr` are the sets of files each side gates; `tokens` the test paths and globs the gates name. */
export function evaluate({ files, ci, prepr, skip, ciGaps, deadGates = [], tokens = [] }) {
  const problems = [];
  const counts = { files: files.length, gated: 0, skipped: 0, ciGaps: 0, ungated: 0 };
  if (!files.length) return { problems: [{ kind: 'no-test-files', message: 'no test file was read' }], counts };
  const gatedOf = (f) => ci.has(f) || prepr.has(f);
  const gated = files.filter(gatedOf);
  counts.gated = gated.length;
  if (!gated.length) problems.push({ kind: 'no-gated-files', message: 'no test file is gated: the gate sources were not read' });
  const match = (entries) => entries.map((e) => ({ e, re: globToRegExp(e.path) }));
  const skipM = match(skip);
  const skipOf = (f) => skipM.some((m) => m.re.test(f));
  const stale = skipM.filter((m) => !files.some((f) => m.re.test(f))).map((m) => m.e.path);
  if (stale.length) problems.push({ kind: 'stale-skip', message: `skip entries that match no test file: ${stale.join(', ')}`, entries: stale });
  const both = files.filter((f) => gatedOf(f) && skipOf(f));
  if (both.length) problems.push({ kind: 'gated-and-skipped', message: `${both.length} file(s) are gated and also on the skip list`, files: both });
  counts.skipped = files.filter((f) => !gatedOf(f) && skipOf(f)).length;
  const ungated = files.filter((f) => !gatedOf(f) && !skipOf(f)).sort();
  counts.ungated = ungated.length;
  if (ungated.length) problems.push({ kind: 'ungated', message: `${ungated.length} test file(s) are in no gate and on no skip entry`, files: ungated });
  const preOnly = files.filter((f) => prepr.has(f) && !ci.has(f));
  const gapM = match(ciGaps);
  const unnamed = preOnly.filter((f) => !gapM.some((m) => m.re.test(f)));
  counts.ciGaps = preOnly.length - unnamed.length;
  if (unnamed.length) problems.push({ kind: 'pre-pr-only', message: `${unnamed.length} file(s) only pre-pr runs and no ciGaps entry names them`, files: unnamed });
  const staleGaps = gapM.filter((m) => !preOnly.some((f) => m.re.test(f))).map((m) => m.e.path);
  if (staleGaps.length) problems.push({ kind: 'stale-ci-gap', message: `ciGaps entries that match no pre-pr-only file: ${staleGaps.join(', ')}`, entries: staleGaps });
  const fileSet = new Set(files);
  const dead = [...new Set(tokens.filter((t) => /[*?]/.test(t)))].filter((t) => !files.some((f) => globToRegExp(t).test(f)));
  const allowedDead = new Set(deadGates.map((e) => e.path));
  const deadGlobs = dead.filter((t) => !allowedDead.has(t));
  if (deadGlobs.length) problems.push({ kind: 'dead-gate-glob', message: `test globs named by a gate that match no tracked file: ${deadGlobs.join(', ')}`, entries: deadGlobs });
  const staleDead = [...allowedDead].filter((p) => !dead.includes(p));
  if (staleDead.length) problems.push({ kind: 'stale-dead-gate', message: `deadGates entries whose glob is not dead any more: ${staleDead.join(', ')}`, entries: staleDead });
  const missing = [...new Set(tokens.filter((t) => !/[*?]/.test(t)))].filter((t) => !fileSet.has(t));
  if (missing.length) problems.push({ kind: 'missing-gate-file', message: `test files named by a gate that are not tracked: ${missing.join(', ')}`, entries: missing });
  return { problems, counts };
}

// ---- real sources

const gitLines = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'core.quotepath=false', ...args, '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);

/** Reads the real sources. Throws (exit 2) when one cannot be read: a reader that found nothing must not pass. */
export async function readSources(root) {
  const tracked = gitLines(root, 'ls-files').map((f) => f.replace(/\\/g, '/'));
  const files = tracked.filter(isTestFile);
  const wfDir = path.join(root, '.github', 'workflows');
  const ciCommands = fs.readdirSync(wfDir).filter((n) => n.endsWith('.yml')).flatMap((n) => commandsOfWorkflow(fs.readFileSync(path.join(wfDir, n), 'utf8')));
  if (!ciCommands.length) throw new Error('no workflow command was read from .github/workflows');
  const pre = await import(new URL('./pre-pr.mjs', import.meta.url).href);
  const gates = [...(pre.ALWAYS_GATES ?? []), ...(pre.SURFACES ?? []).flatMap((s) => s.gates ?? [])];
  if (!gates.length) throw new Error('no pre-pr gate was read from pre-pr.mjs');
  const scripts = {};
  for (const p of tracked.filter((f) => /(^|\/)package\.json$/.test(f))) {
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')).scripts ?? {})) (scripts[k] ||= []).push(String(v)); } catch { /* an unreadable package.json has no scripts */ }
  }
  const preCommands = gates.map((g) => [g.cmd, ...(g.args ?? []).map(String)].join(' '));
  const preRuns = expandRuns(preCommands, scripts);
  const ciRuns = expandRuns(ciCommands, scripts);
  let playwrightPure = [];
  try { playwrightPure = testMatchOf(fs.readFileSync(path.join(root, 'apps', 'agentic-os', 'playwright.pure.config.ts'), 'utf8')); } catch { /* no pure config: its runner covers nothing */ }
  const ctx = { playwrightPure };
  const ci = new Set([...gatedBy(files, ciRuns.paths), ...runnerFilesCi(files, gates, ciCommands, ctx)]);
  const prepr = new Set([...gatedBy(files, preRuns.paths), ...runnerFiles(files, gates, ctx)]);
  return { files, ci, prepr, gates, tokens: [...ciRuns.paths, ...preRuns.paths] };
}

export function readSkipFile(root) {
  return parseSkipFile(JSON.parse(fs.readFileSync(path.join(root, SKIP_FILE), 'utf8')));
}

export async function check(root = REPO) {
  const src = await readSources(root);
  const skipFile = readSkipFile(root);
  const r = evaluate({ files: src.files, ci: src.ci, prepr: src.prepr, skip: skipFile.skip, ciGaps: skipFile.ciGaps, deadGates: skipFile.deadGates, tokens: src.tokens });
  return { problems: [...skipFile.problems, ...r.problems], counts: r.counts };
}

export async function main(argv) {
  const list = argv.includes('--list');
  let res;
  try { res = await check(REPO); } catch (e) {
    process.stderr.write(`gate-coverage: a source could not be read: ${String(e?.message ?? e).split('\n')[0]}\n`);
    return 2;
  }
  const c = res.counts;
  const counts = `read ${c.files} test files: ${c.gated} gated, ${c.skipped} skipped, ${c.ciGaps} gated at pre-pr only and named, ${c.ungated} ungated`;
  if (!res.problems.length) { process.stdout.write(`gate-coverage: OK, ${counts}\n`); return 0; }
  process.stdout.write(`gate-coverage: FAIL, ${counts}\n`);
  for (const p of res.problems) {
    process.stdout.write(`  ${p.kind}: ${p.message}\n`);
    for (const f of (p.files ?? []).slice(0, list ? Infinity : 20)) process.stdout.write(`    ${f}\n`);
    if (!list && (p.files ?? []).length > 20) process.stdout.write(`    ... ${(p.files ?? []).length - 20} more (--list prints all)\n`);
  }
  return 1;
}

// The same direct-run test as pre-pr.mjs: real paths, so a junction or a drive-letter case cannot make the check silently not run.
export function isDirectRun(argv1 = process.argv[1], here = fileURLToPath(import.meta.url)) {
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(here); } catch { return path.resolve(argv1) === path.resolve(here); }
}
if (isDirectRun()) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
