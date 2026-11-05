#!/usr/bin/env node
/**
 * cli-smoke.mjs: runs each changed CLI script with --help and with no arguments, in a sandbox. This is a gate.
 *
 * Usage: node scripts/checks/cli-smoke.mjs --root <dir> (--diff <file> | --files a.mjs,b.mjs) [--timeout-ms <n>]
 * Output: JSON { results: [{ path, runs: [{ args, exit, verdict, reason, stderr }], verdict }], failed, timeouts, checked, copyMs }
 * Exit: 0 when no script fails, 1 when any script fails, 2 on bad usage. A timeout does not fail the run.
 *
 * Smoke contract:
 *   - A candidate is a changed, non-test .mjs under scripts/ that has a shebang or reads process.argv at top level.
 *   - Each candidate runs twice: with --help, then with no arguments. No run ever gets --apply or another mutating flag.
 *   - The child never runs in the checked tree. runSmoke copies <root>/scripts, <root>/.claude, <root>/docs and the files
 *     in <root> (no node_modules, no .git, no .claude/cache, no .claude/worktrees) into a temp folder and spawns the copy
 *     there, so a script that writes beside itself (import.meta.url) changes only the copy. Scripts read .claude/**, docs/**
 *     and root config files: a copy of scripts/ alone gave 8 false FAILs on 121 candidates, with .claude 3, with all of
 *     these 0. The copy is made once per runSmoke.
 *   - HOME, USERPROFILE, APPDATA, LOCALAPPDATA and the cwd point at another temp folder. It holds a stub .claude/settings.json.
 *   - Each run has a 10 s timeout. A run that times out is killed.
 *   - FAIL: an uncaught Node error (the exit is not 0 and stderr has a stack frame or the "Node.js vNN" line), or an
 *     ENOENT or EISDIR error whose message names a path that holds an argument. Else PASS. Exit 1 or 2 with a usage
 *     message is a PASS.
 *   - TIMEOUT: a run that hit the limit. It is a fact for the reviewer, not a failure and not a gate. A script with a FAIL
 *     run is FAIL even when its other run timed out.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedLines } from './changed-lines.mjs';

const TIMEOUT_MS = 10_000;
const RUNS = Object.freeze([['--help'], []]);
const STDERR_TAIL = 8;
const KEEP_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'TERM']);
const STACK_FRAME_RE = /^\s+at\s.+:\d+(?::\d+)?\)?\s*$/m;
const NODE_TRAILER_RE = /^Node\.js v\d+/m;
// A block that starts with one of these is control flow. Code inside it still runs at the top level of the file.
const CONTROL_HEAD_RE = /^\s*(?:\}\s*)?(?:if|else|try|catch|finally|for|while|switch)\b|^\s*\{\s*$/;
// What a script needs from the tree: these folders and every file at the root (package.json, review-router.config.json ...).
const COPY_DIRS = Object.freeze(['scripts', '.claude', 'docs']);
const SKIP_DIRS = new Set(['node_modules', '.git']);
const SKIP_PATHS = new Set(['.claude/cache', '.claude/worktrees']);

const norm = (p) => String(p).replaceAll('\\', '/').replace(/^\.\//, '');
/** A child can leave a process that holds its cwd (EBUSY on Windows). A cleanup error must not fail the gate. */
const rmQuiet = (dir) => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS removes the temp folder later */ } };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- candidates ---------------------------------------------------------------------------------------------------------------

/** Skips a quoted string that starts at line[i]. Returns the index after the closing quote, or -1 when the line has none. */
function skipQuoted(line, i) {
  for (let j = i + 1; j < line.length; j += 1) {
    if (line[j] === '\\') j += 1;
    else if (line[j] === line[i]) return j + 1;
  }
  return -1;
}

/**
 * Removes strings, template text and comments from one line so braces and names in them do not count.
 * state: { block, template }: the line starts inside a block comment or a template literal.
 */
function cleanLine(line, state) {
  let { block, template } = state;
  let out = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (block) {
      if (line.startsWith('*/', i)) { block = false; i += 1; }
    } else if (template) {
      if (ch === '\\') i += 1;
      else if (ch === '`') { template = false; out += '""'; }
    } else if (line.startsWith('/*', i)) { block = true; i += 1; } else if (line.startsWith('//', i)) break;
    else if (ch === '`') template = true;
    else if (ch === "'" || ch === '"') {
      const end = skipQuoted(line, i);
      if (end < 0) out += ch;
      else { out += '""'; i = end - 1; }
    } else out += ch;
  }
  return { text: out, block, template };
}

/** True when the text before process.argv has a function head, so the read sits in a function body. */
const inFunctionHead = (text) => /\bfunction\b|=>/.test(text.slice(0, text.indexOf('process.argv')));

/** True when src reads process.argv at the top level of the file: outside every function, class and object. */
export function readsArgvAtTop(src) {
  const stack = [];
  let state = { block: false, template: false };
  for (const raw of String(src).split(/\r?\n/)) {
    const c = cleanLine(raw, state);
    state = { block: c.block, template: c.template };
    if (c.text.includes('process.argv') && stack.every(Boolean) && !inFunctionHead(c.text)) return true;
    for (const ch of c.text) {
      if (ch === '{') stack.push(CONTROL_HEAD_RE.test(c.text));
      else if (ch === '}') stack.pop();
    }
  }
  return false;
}

function isCandidateFile(root, rel) {
  if (!rel.startsWith('scripts/') || !rel.endsWith('.mjs') || rel.endsWith('.test.mjs')) return false;
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return false;
  const src = readFileSync(abs, 'utf8');
  if (SEMGREP_FIXTURE_RE.test(src)) return false;
  return src.startsWith('#!') || readsArgvAtTop(src);
}

/** files: paths relative to root. Returns the paths (forward slashes) that the smoke run covers. */
export function candidates(root, files) {
  return [...new Set((files ?? []).map(norm))].filter((rel) => isCandidateFile(root, rel));
}

// ---- verdict ------------------------------------------------------------------------------------------------------------------

/** True when an ENOENT or EISDIR message on some line names a quoted path that holds one of the arguments. */
function fsErrorNamesArg(stderr, args) {
  return args.filter((a) => a !== '').some((a) => new RegExp(`(?:ENOENT|EISDIR)[^\\n]*['"][^'"\\n]*${escapeRe(a)}[^'"\\n]*['"]`).test(stderr));
}

// A semgrep rule fixture is wrong on purpose; it marks the lines a rule must flag.
const SEMGREP_FIXTURE_RE = /^\s*\/\/\s*ruleid:/m;
// A bare package that the sandbox copy lacks (node_modules is not copied). A relative path is a real defect.
const MISSING_PACKAGE_RE = /ERR_MODULE_NOT_FOUND\][^\n]*Cannot find package '([^'./\\][^']*)'/;

/** run: { args, exit, timedOut, stderr, spawnError }. Returns { verdict: PASS | FAIL | TIMEOUT | ENV, reason }. */
export function classify(run) {
  const stderr = String(run.stderr ?? '');
  if (run.timedOut) return { verdict: 'TIMEOUT', reason: `timeout after ${(run.timeoutMs ?? TIMEOUT_MS) / 1000} s` };
  if (run.spawnError) return { verdict: 'FAIL', reason: `spawn error: ${run.spawnError}` };
  if (run.exit === 0) return { verdict: 'PASS', reason: 'clean exit' };
  const pkg = MISSING_PACKAGE_RE.exec(stderr);
  if (pkg) return { verdict: 'ENV', reason: `missing package ${pkg[1]} in the sandbox (fact, not a failure)` };
  if (STACK_FRAME_RE.test(stderr) || NODE_TRAILER_RE.test(stderr)) return { verdict: 'FAIL', reason: 'uncaught error with a stack frame' };
  if (fsErrorNamesArg(stderr, run.args)) return { verdict: 'FAIL', reason: 'ENOENT or EISDIR on a path built from argv' };
  return { verdict: 'PASS', reason: `exit ${run.exit} without a crash` };
}

// ---- sandbox ------------------------------------------------------------------------------------------------------------------

/** Makes the temp folder and the env for the child. Returns { dir, env }. */
export function makeSandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-smoke-'));
  const roaming = path.join(dir, 'AppData', 'Roaming');
  const local = path.join(dir, 'AppData', 'Local');
  for (const d of [path.join(dir, '.claude'), roaming, local]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(dir, '.claude', 'settings.json'), '{"hooks":{}}\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP_ENV.has(k.toUpperCase())));
  Object.assign(env, {
    HOME: dir, USERPROFILE: dir, APPDATA: roaming, LOCALAPPDATA: local, TEMP: dir, TMP: dir, TMPDIR: dir,
    XDG_CONFIG_HOME: path.join(dir, '.config'), CLAUDE_CONFIG_DIR: path.join(dir, '.claude'),
  });
  return { dir, env };
}

/** The names to copy: the folders of COPY_DIRS that exist, and every file in the root folder. */
function copyEntries(root) {
  const files = readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  return [...COPY_DIRS.filter((d) => existsSync(path.join(root, d))), ...files];
}

/** Copies what the scripts need from root into a new temp folder. Returns { dir, ms }. */
export function copyTree(root) {
  const started = performance.now();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-smoke-tree-'));
  try {
    for (const entry of copyEntries(root)) {
      const from = path.join(root, entry);
      cpSync(from, path.join(dir, entry), { recursive: true, filter: (src) => !SKIP_DIRS.has(path.basename(src)) && !SKIP_PATHS.has(norm(path.relative(root, src))) });
    }
  } catch (err) {
    rmQuiet(dir);
    throw err;
  }
  return { dir, ms: Math.round(performance.now() - started) };
}

// ---- runs ---------------------------------------------------------------------------------------------------------------------

function runOnce(script, args, sandbox, timeoutMs) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: sandbox.dir, env: sandbox.env, encoding: 'utf8', shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
  });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const spawnError = r.error && !timedOut ? (r.error.code ?? r.error.message) : null;
  const stderr = r.stderr ?? '';
  const run = { args, exit: r.status, timedOut, timeoutMs, spawnError, stderr };
  const tail = stderr.split(/\r?\n/).filter((l) => l !== '').slice(-STDERR_TAIL);
  return { args, exit: r.status, ...classify(run), stderr: tail };
}

/** FAIL beats TIMEOUT, TIMEOUT beats ENV, ENV beats PASS. */
function scriptVerdict(runs) {
  for (const v of ['FAIL', 'TIMEOUT', 'ENV']) if (runs.some((r) => r.verdict === v)) return v;
  return 'PASS';
}

function smokeOne(treeDir, rel, timeoutMs) {
  const sandbox = makeSandbox();
  try {
    const runs = RUNS.map((args) => runOnce(path.join(treeDir, rel), args, sandbox, timeoutMs));
    return { path: rel, runs, verdict: scriptVerdict(runs) };
  } finally { rmQuiet(sandbox.dir); }
}

const count = (results, verdict) => results.filter((r) => r.verdict === verdict).length;

/** root: the tree that holds the files. files: paths relative to root. opts.timeoutMs (tests). */
export function runSmoke({ root, files }, opts = {}) {
  const abs = path.resolve(root);
  const found = candidates(abs, files);
  if (found.length === 0) return { results: [], failed: 0, timeouts: 0, env: 0, checked: 0, copyMs: 0 };
  const copy = copyTree(abs);
  try {
    const results = found.map((rel) => smokeOne(copy.dir, rel, opts.timeoutMs ?? TIMEOUT_MS));
    return { results, failed: count(results, 'FAIL'), timeouts: count(results, 'TIMEOUT'), env: count(results, 'ENV'), checked: results.length, copyMs: copy.ms };
  } finally { rmQuiet(copy.dir); }
}

// ---- CLI ----------------------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) out.root = argv[++i];
    else if (argv[i] === '--diff' && argv[i + 1]) out.diff = argv[++i];
    else if (argv[i] === '--files' && argv[i + 1]) out.files = argv[++i].split(',').filter(Boolean);
    else if (argv[i] === '--timeout-ms' && Number(argv[i + 1]) > 0) out.timeoutMs = Number(argv[++i]);
    else return { error: `unknown or incomplete argument ${JSON.stringify(argv[i])}` };
  }
  return out.diff || out.files ? out : { error: 'pass --diff <file> or --files a.mjs,b.mjs' };
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`cli-smoke: ${args.error}\nUsage: cli-smoke.mjs --root <dir> (--diff <file> | --files a.mjs,b.mjs) [--timeout-ms <n>]\n`);
    process.exitCode = 2;
  } else {
    const files = args.files ?? changedLines(readFileSync(args.diff, 'utf8')).map((c) => c.path);
    const result = runSmoke({ root: args.root, files }, { timeoutMs: args.timeoutMs });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.failed > 0 ? 1 : 0;
  }
}
