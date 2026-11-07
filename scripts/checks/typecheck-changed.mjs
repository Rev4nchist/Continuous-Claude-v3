#!/usr/bin/env node
/**
 * typecheck-changed.mjs: tsc facts for the changed .mjs files. This is a fact for the reviewer, never a gate.
 *
 * Usage: node scripts/checks/typecheck-changed.mjs --root <dir> --diff <file> [--strict]
 * Output: JSON { errors: [{ path, line, code, message }], skipped, tool: 'tsc', version } (plus { env: true, error: 'ENV: ...' } when tsc is missing)
 *
 * Rules:
 *   - tsc runs on the changed non-test .mjs files only, with --allowJs --checkJs and @types/node from .claude/hooks of this
 *     checkout, else of the primary checkout (a worktree has no node_modules).
 *   - A changed .mjs file and no tsc anywhere is { env: true, error: 'ENV: ...' }, not a skip: catchers.mjs fails on it.
 *     With no changed .mjs file the run is skipped, as before.
 *   - An error stays only when its file is a changed file and its line is in a changed range.
 *   - The CLI exits 0 even with errors. With --strict it exits 1 when errors remain.
 *   - tsc runs through process.execPath on its JS entry, with no shell. The timeout is 120 s.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { depsHint, primaryRoot } from '../lib/resolve-deps.mjs';
import { changedLines, inRanges } from './changed-lines.mjs';

const HOOKS_DIR = fileURLToPath(new URL('../../.claude/hooks/', import.meta.url));
const TIMEOUT_MS = 120_000;
const ERROR_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

const norm = (p) => String(p).replaceAll('\\', '/').replace(/^\.\//, '');

/** Changed non-test .mjs files only. */
export function typecheckTargets(files) {
  return [...new Set((files ?? []).map(norm))].filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
}

/** Accepts { path: ranges } or [{ path, ranges }]. Returns Map<path, ranges>. */
function rangeMap(ranges) {
  const pairs = Array.isArray(ranges) ? ranges.map((r) => [r.path, r.ranges]) : Object.entries(ranges ?? {});
  return new Map(pairs.map(([p, r]) => [norm(p), r]));
}

/** Parses "file(line,col): error TSnnnn: msg" lines. Continuation lines (indented) are ignored. */
export function parseTscOutput(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = ERROR_RE.exec(line);
    if (m) out.push({ path: norm(m[1]), line: Number(m[2]), code: m[4], message: m[5].trim() });
  }
  return out;
}

/** Keeps an error only when its file is changed and its line is in a changed range. */
export function keepChanged(errors, ranges) {
  const map = rangeMap(ranges);
  return errors.filter((e) => map.has(e.path) && inRanges(map.get(e.path), e.line));
}

function tscTool(hooksDir) {
  const entry = path.join(hooksDir, 'node_modules', 'typescript', 'lib', 'tsc.js');
  if (!existsSync(entry)) return null;
  const pkg = JSON.parse(readFileSync(path.join(hooksDir, 'node_modules', 'typescript', 'package.json'), 'utf8'));
  return { entry, version: pkg.version, typeRoots: path.join(hooksDir, 'node_modules', '@types') };
}

/**
 * The tsc of the first hooks folder that has one: this checkout's, then the primary checkout's (a worktree has no
 * node_modules; scripts/lib/resolve-deps.mjs finds the primary). Returns { tool, tried }.
 */
function findTool(hooksDirs) {
  const tried = [];
  for (const dir of hooksDirs) {
    tried.push(dir);
    const tool = tscTool(dir);
    if (tool) return { tool, tried };
  }
  return { tool: null, tried };
}

function tscArgs(tool, targets) {
  return [
    tool.entry, '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--pretty', 'false',
    '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext',
    '--types', 'node', '--typeRoots', tool.typeRoots, ...targets,
  ];
}

/**
 * root: the tree that holds the files. files: paths relative to root. ranges: see rangeMap.
 * opts.hooksDir (tests): where typescript and @types live.
 */
export function runTypecheck({ root, files, ranges }, opts = {}) {
  const base = { errors: [], skipped: null, tool: 'tsc', version: null };
  const dirs = opts.hooksDir ? [opts.hooksDir] : [HOOKS_DIR, path.join(primaryRoot(path.resolve(HOOKS_DIR, '..', '..')), '.claude', 'hooks')];
  const { tool, tried } = findTool([...new Set(dirs)]);
  const targets = typecheckTargets(files).filter((f) => existsSync(path.join(root, f)));
  if (targets.length === 0) return { ...base, version: tool?.version ?? null, skipped: 'no changed non-test .mjs files' };
  // A file needs checking and there is no compiler: that is the environment, loud, never a silent skip.
  if (!tool) {
    const where = tried.map((d) => path.join(d, 'node_modules', 'typescript')).join(', ');
    return { ...base, env: true, error: `ENV: tsc needs typescript. Tried ${where}. This is the environment, not your change. Fix: ${depsHint('typescript', tried, primaryRoot(HOOKS_DIR))}` };
  }
  const r = spawnSync(process.execPath, tscArgs(tool, targets), {
    cwd: root, encoding: 'utf8', shell: false, windowsHide: true, timeout: TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) return { ...base, version: tool.version, skipped: `tsc did not finish: ${r.error.code ?? r.error.message}` };
  if (r.status !== 0 && r.status !== 1 && r.status !== 2) return { ...base, version: tool.version, skipped: `tsc exited ${r.status}` };
  return { ...base, version: tool.version, errors: keepChanged(parseTscOutput(r.stdout), ranges) };
}

function parseArgs(argv) {
  const out = { root: process.cwd(), strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--strict') out.strict = true;
    else if (argv[i] === '--root' && argv[i + 1]) out.root = argv[++i];
    else if (argv[i] === '--diff' && argv[i + 1]) out.diff = argv[++i];
    else return { error: `unknown or incomplete argument ${JSON.stringify(argv[i])}` };
  }
  return out.diff ? out : { error: 'pass --diff <file>' };
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`typecheck-changed: ${args.error}\nUsage: typecheck-changed.mjs --root <dir> --diff <file> [--strict]\n`);
    process.exitCode = 2;
  } else {
    const changed = changedLines(readFileSync(args.diff, 'utf8'));
    const result = runTypecheck({ root: args.root, files: changed.map((c) => c.path), ranges: changed });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = args.strict && result.errors.length > 0 ? 1 : 0;
  }
}
