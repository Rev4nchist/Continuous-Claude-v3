#!/usr/bin/env node
/**
 * gate-coverage -- every tracked test file is in a gate or on a named skip list (card coord-test-gate-coverage).
 * Design note: .claudedocs/coordination/2026-11-16-coord-test-gate-coverage-design.md. Read-only: it writes nothing.
 *
 * A test file is GATED when a gate runs it: a pre-pr gate (SURFACES and ALWAYS_GATES of pre-pr.mjs: any test path or glob in a gate's args, or a
 * runner of RUNNERS below whose gate exists), or a CI command (a `run:` command of .github/workflows/*.yml that names the path or a glob, or a
 * runner step). A file that no gate runs must be on the skip list (scripts/github/gate-coverage-skip.json, `skip`: a path or glob and a reason).
 * A file that only pre-pr runs must be on `ciGaps` (a path or glob and a reason): CI has no runner for it. The check fails when:
 *   ungated           a test file is in no gate and on no skip entry
 *   stale-skip        a skip entry matches no test file, or an entry has no reason
 *   gated-and-skipped a file is gated and also on the skip list (the skip entry must go)
 *   pre-pr-only       a file only pre-pr runs is on no ciGaps entry
 *   stale-ci-gap      a ciGaps entry matches no pre-pr-only file
 *   no-test-files / no-gated-files / no-workflow-command / no-pre-pr-gate   a reader found nothing (it must not pass on nothing)
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
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length + (lines[i].includes('- run:') ? 2 : 0);
    const value = m[2].trim();
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

/** The test paths and test globs that one command names (quotes removed; flags and other words left out). */
export function pathTokens(command) {
  const out = [];
  for (const raw of command.split(/\s+/)) {
    const t = raw.replace(/^["']+|["';,)&|]+$/g, '').replace(/^\.\//, '');
    if (!t || t.startsWith('-')) continue;
    if (isTestFile(t.replace(/[*?]+/g, 'x'))) out.push(t);
  }
  return out;
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
// command runs it too. Pinned to the real sources by gate-coverage.test.mjs (a rename must fail there, not drop coverage here).
export const RUNNERS = [
  { id: 'hooks-vitest', gate: (g) => g.cmd === 'npx' && (g.args ?? []).includes('vitest') && g.cwd === '.claude/hooks', files: (f) => /^\.claude\/hooks\/src\/__tests__\/.+\.test\.ts$/.test(f), ci: (cmds) => cmds.some((c) => /\bvitest run\b/.test(c)) },
  { id: 'opc-pytest', gate: (g) => g.cmd === 'uv' && (g.args ?? []).includes('pytest') && g.cwd === 'opc', files: (f) => /^opc\/.*(\/test_[^/]+\.py|_test\.py)$/.test(f), ci: (cmds) => cmds.some((c) => /\bpytest\b/.test(c)) },
  { id: 'mods-plugin-test', gate: (g) => g.id === 'mods-validate', files: (f) => /^\.claude\/plugins\/ccv3-mods\/tests\/.+\.test\.ts$/.test(f), ci: () => false },
  { id: 'playwright-pure', gate: (g) => (g.args ?? []).includes('apps/agentic-os/playwright.pure.config.ts'), files: (f) => /^apps\/agentic-os\/e2e\/(safe-message[^/]*\.spec\.ts|lane-coord-drift\.spec\.ts|pr-feed-parse\.spec\.ts)$/.test(f), ci: (cmds) => cmds.some((c) => c.includes('playwright.pure.config.ts')) },
];

/** The files the runners cover, for the pre-pr gates given. */
export function runnerFiles(files, gates) {
  const set = new Set();
  for (const r of RUNNERS) if (gates.some((g) => r.gate(g))) for (const f of files) if (r.files(f)) set.add(f);
  return set;
}
function runnerFilesCi(files, gates, cmds) {
  const set = new Set();
  for (const r of RUNNERS) if (gates.some((g) => r.gate(g)) && r.ci(cmds)) for (const f of files) if (r.files(f)) set.add(f);
  return set;
}

/** The skip file: { skip: [{path, reason}], ciGaps: [{path, reason}] }. A missing reason is a problem. */
export function parseSkipFile(json) {
  const problems = [];
  const read = (key, required) => {
    const list = json && typeof json === 'object' ? json[key] : undefined;
    if (list === undefined && !required) return [];
    if (!Array.isArray(list)) { problems.push({ kind: 'skip-file', message: `"${key}" is not a list` }); return []; }
    const ok = [];
    for (const e of list) {
      if (!e || typeof e.path !== 'string' || !e.path.trim()) problems.push({ kind: 'skip-file', message: `an entry of "${key}" has no path` });
      else if (typeof e.reason !== 'string' || !e.reason.trim()) problems.push({ kind: 'skip-file', message: `the entry ${e.path} of "${key}" has no reason` });
      else ok.push({ path: e.path.replace(/^\.\//, ''), reason: e.reason.trim() });
    }
    return ok;
  };
  if (!json || typeof json !== 'object') problems.push({ kind: 'skip-file', message: 'the skip file is not an object' });
  return { skip: read('skip', true), ciGaps: read('ciGaps', false), problems };
}

/** The verdict: problems and counts. `ci` and `prepr` are the sets of files each side gates. */
export function evaluate({ files, ci, prepr, skip, ciGaps }) {
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
  return { problems, counts };
}

// ---- real sources

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean);

/** Reads the real sources. Throws (exit 2) when one cannot be read: a reader that found nothing must not pass. */
export async function readSources(root) {
  const files = git(root, 'ls-files').map((f) => f.replace(/\\/g, '/')).filter(isTestFile);
  const wfDir = path.join(root, '.github', 'workflows');
  const ciCommands = fs.readdirSync(wfDir).filter((n) => n.endsWith('.yml')).flatMap((n) => commandsOfWorkflow(fs.readFileSync(path.join(wfDir, n), 'utf8')));
  if (!ciCommands.length) throw new Error('no workflow command was read from .github/workflows');
  const pre = await import(new URL('./pre-pr.mjs', import.meta.url).href);
  const gates = [...(pre.ALWAYS_GATES ?? []), ...(pre.SURFACES ?? []).flatMap((s) => s.gates ?? [])];
  if (!gates.length) throw new Error('no pre-pr gate was read from pre-pr.mjs');
  const preTokens = gates.flatMap((g) => (g.args ?? []).flatMap((a) => pathTokens(String(a))));
  const pkgs = git(root, 'ls-files').filter((f) => /(^|\/)package\.json$/.test(f));
  const pkgCommands = pkgs.flatMap((p) => { try { return Object.values(JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')).scripts ?? {}).map(String); } catch { return []; } });
  const ciTokens = [...ciCommands, ...pkgCommands].flatMap(pathTokens);
  const ci = new Set([...gatedBy(files, ciTokens), ...runnerFilesCi(files, gates, ciCommands)]);
  const prepr = new Set([...gatedBy(files, preTokens), ...runnerFiles(files, gates)]);
  return { files, ci, prepr, gates };
}

export function readSkipFile(root) {
  return parseSkipFile(JSON.parse(fs.readFileSync(path.join(root, SKIP_FILE), 'utf8')));
}

export async function check(root = REPO) {
  const src = await readSources(root);
  const skipFile = readSkipFile(root);
  const r = evaluate({ files: src.files, ci: src.ci, prepr: src.prepr, skip: skipFile.skip, ciGaps: skipFile.ciGaps });
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
