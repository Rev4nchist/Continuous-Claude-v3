#!/usr/bin/env node
/**
 * parser-fixtures.mjs: runs registered parsers over hostile inputs and checks a property of each result.
 *
 * Usage: node scripts/checks/parser-fixtures.mjs [--all | --files <a,b,...> | <file> ...] [--root <dir>] [--json]
 *
 * An entry in ./parser-fixtures/registry.mjs names a function, the input classes to feed it and a property. The inputs come from
 * ./parser-fixtures/inputs.mjs. The entries whose file is in the changed list run. --all runs every entry.
 * --root points at another tree (for example an extracted PR tree): the parser files are read from there, the registry from this tree.
 *
 * .mjs files are imported as they are. .ts files are bundled with esbuild into a temp file first (esbuild comes from
 * .claude/hooks/node_modules). Skipped (listed with a reason, never a failure):
 *   - a file that is absent from the root;
 *   - a .ts file when esbuild is not available ("esbuild not available: ...");
 *   - an export that the module does not have ("export absent": the function may be newer than the commit).
 * A file that does not import (syntax error, failed bundle) is a failure.
 * A property that itself throws is a property error: it goes to `errors`, not to the failures.
 *
 * Result: { results: [{ id, file, failures: [{ input, reason }], failureCount, errors, errorCount, inputCount }],
 *           skipped: [{ id, reason }], errors: [{ id, input, reason }], failed }.
 * `failed` is the number of failed (entry, input) pairs. Each entry lists at most MAX_LISTED failures and errors.
 * Exit codes: 0 no failure, 1 a failure, 2 bad usage.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { casesFor } from './parser-fixtures/inputs.mjs';
import { REGISTRY } from './parser-fixtures/registry.mjs';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_LISTED = 25;
const PREVIEW = 100;

// ---------- loading ----------

/** Finds esbuild in the tree under test, then in this tree. */
function loadEsbuild(root) {
  const tries = [root, TOOL_ROOT].map((r) => path.join(r, '.claude', 'hooks', 'package.json'));
  for (const from of tries) {
    try { return createRequire(from)('esbuild'); } catch { /* try the next tree */ }
  }
  throw new Error('esbuild not found in .claude/hooks/node_modules of the tree or of this checkout');
}

/** Bundles a .ts file to a temp ESM file and imports it. The temp folder goes away after the import. */
async function importTs(abs, root, loaded) {
  const esbuild = loaded ?? loadEsbuild(root);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'parser-fixtures-'));
  try {
    const outfile = path.join(dir, 'bundle.mjs');
    esbuild.buildSync({ entryPoints: [abs], outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', logLevel: 'silent' });
    return await import(`${pathToFileURL(outfile).href}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function importMjs(abs) {
  const stamp = statSync(abs);
  return import(`${pathToFileURL(abs).href}?v=${stamp.mtimeMs}-${stamp.size}`);
}

const isTs = (file) => /\.(?:ts|tsx|mts|cts)$/.test(file);

/** The module for a repo-relative file under root. opts.esbuild: an esbuild module that is already loaded. */
export async function loadModule(root, file, opts = {}) {
  const abs = path.join(root, file);
  return isTs(file) ? importTs(abs, root, opts.esbuild) : importMjs(abs);
}

// ---------- running ----------

const normalize = (f) => String(f).replaceAll('\\', '/').replace(/^\.\//, '');

/** The entries to run: all of them, or those whose file is in `files`. */
export function selectEntries({ files = [], all = false } = {}, registry = REGISTRY) {
  if (all) return registry;
  const changed = new Set(files.map(normalize));
  return registry.filter((e) => changed.has(e.file));
}

function callOnce(fn, value) {
  const start = performance.now();
  try {
    return { output: fn(value), threw: null, ms: performance.now() - start };
  } catch (err) {
    return { output: undefined, threw: err ?? new Error('threw a falsy value'), ms: performance.now() - start };
  }
}

function preview(input) {
  const text = typeof input.value === 'string' ? JSON.stringify(input.value) : '';
  return text.length > PREVIEW ? `${text.slice(0, PREVIEW)}...` : text;
}

/** null (the property holds), { failure } (it does not) or { error } (the property itself threw). */
function judge(entry, mod, fn, input) {
  const { output, threw, ms } = callOnce(fn, input.value);
  const at = `${input.id} ${preview(input)}`.trim();
  try {
    const reason = entry.property(fn, input, output, { threw, ms, mod });
    return reason ? { failure: { input: at, reason } } : null;
  } catch (err) {
    return { error: { input: at, reason: `the property itself threw: ${err?.message ?? err}` } };
  }
}

function inputsOf(entry) {
  const seen = new Set();
  return entry.inputs.flatMap(casesFor).filter((c) => (seen.has(c.id) ? false : seen.add(c.id)));
}

/**
 * Runs one entry over its inputs. A module that does not load is one failure. A module without the export gives { absent: true }.
 * opts.esbuild: an esbuild module that is already loaded.
 */
export async function runEntry(entry, root, opts = {}) {
  const base = { id: entry.id, file: entry.file };
  let mod;
  try { mod = await loadModule(root, entry.file, opts); } catch (err) {
    return { ...base, failures: [{ input: '(import)', reason: `cannot import ${entry.file}: ${String(err?.message ?? err).split('\n')[0]}` }], failureCount: 1, errors: [], errorCount: 0, inputCount: 0 };
  }
  const fn = mod[entry.export];
  if (typeof fn !== 'function') return { ...base, absent: true, failures: [], failureCount: 0, errors: [], errorCount: 0, inputCount: 0 };
  const inputs = inputsOf(entry);
  const judged = inputs.map((input) => judge(entry, mod, fn, input)).filter(Boolean);
  const failures = judged.filter((j) => j.failure).map((j) => j.failure);
  const errors = judged.filter((j) => j.error).map((j) => ({ id: entry.id, ...j.error }));
  return { ...base, failures: failures.slice(0, MAX_LISTED), failureCount: failures.length, errors: errors.slice(0, MAX_LISTED), errorCount: errors.length, inputCount: inputs.length };
}

/** Esbuild for the .ts entries, or the reason it is not there. */
function esbuildFor(entries, root, loader) {
  if (!entries.some((e) => isTs(e.file))) return { esbuild: null, missing: null };
  try { return { esbuild: loader(root), missing: null }; } catch (err) { return { esbuild: null, missing: String(err?.message ?? err).split('\n')[0] }; }
}

/**
 * Runs the selected entries against the tree at `root`.
 * opts (tests): { registry, loadEsbuild(root) }.
 */
export async function runFixtures({ root = TOOL_ROOT, files = [], all = false } = {}, opts = {}) {
  const treeRoot = path.resolve(root);
  const entries = selectEntries({ files, all }, opts.registry ?? REGISTRY);
  const { esbuild, missing } = esbuildFor(entries, treeRoot, opts.loadEsbuild ?? loadEsbuild);
  const results = [];
  const skipped = [];
  for (const entry of entries) {
    if (!existsSync(path.join(treeRoot, entry.file))) { skipped.push({ id: entry.id, reason: `${entry.file} is not in ${treeRoot}` }); continue; }
    if (isTs(entry.file) && missing) { skipped.push({ id: entry.id, reason: `esbuild not available: ${missing}` }); continue; }
    const r = await runEntry(entry, treeRoot, { esbuild });
    if (r.absent) skipped.push({ id: entry.id, reason: 'export absent', file: entry.file });
    else results.push(r);
  }
  return { results, skipped, errors: results.flatMap((r) => r.errors), failed: results.reduce((n, r) => n + r.failureCount, 0) };
}

// ---------- command line ----------

const USAGE = 'usage: node scripts/checks/parser-fixtures.mjs [--all | --files <a,b,...> | <file> ...] [--root <dir>] [--json]';

export function parseCli(argv) {
  const out = { files: [], all: false, json: false, root: TOOL_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--root' || a === '--files') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) return { error: `${a} needs a value` };
      i += 1;
      if (a === '--root') out.root = v; else out.files.push(...v.split(',').filter(Boolean));
    } else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else out.files.push(a);
  }
  return out;
}

function lines(report) {
  const out = [];
  for (const r of report.results) {
    out.push(`${r.failureCount ? 'FAIL' : 'ok  '} ${r.id} (${r.file})${r.failureCount ? `: ${r.failureCount} failure(s)` : ''}`);
    for (const f of r.failures) out.push(`       ${f.input}\n         ${f.reason}`);
    if (r.failureCount > r.failures.length) out.push(`       ... ${r.failureCount - r.failures.length} more`);
  }
  for (const e of report.errors) out.push(`error ${e.id} ${e.input}: ${e.reason}`);
  for (const s of report.skipped) out.push(`skip ${s.id}: ${s.reason}`);
  out.push(`parser-fixtures: ${report.results.length} entr${report.results.length === 1 ? 'y' : 'ies'} run, ${report.failed} failure(s)`);
  return out;
}

/** Returns the exit code. deps (tests): stdout, stderr. */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const args = parseCli(argv);
  if (args.error) { stderr(`parser-fixtures: ${args.error}\n${USAGE}`); return 2; }
  if (args.help) { stdout(USAGE); return 0; }
  if (!args.all && args.files.length === 0) { stderr(`parser-fixtures: pass --all or the changed files\n${USAGE}`); return 2; }
  const report = await runFixtures(args);
  stdout(args.json ? JSON.stringify(report, null, 2) : lines(report).join('\n'));
  return report.failed > 0 ? 1 : 0;
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2));
