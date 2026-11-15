#!/usr/bin/env node
// engine-version.mjs: the two version hashes of the review engine at one git commit (docs/review-engine/map.md, "Freeze set (B3)").
// Owner: re-live-advisory only.
//
// reviewerVersion: the reviewer set. REVIEWER_SET_FILES, every non-test file under scripts/github/local-review/ (recursive;
//   a test file matches *.test.mjs), and the local_review block of review-router.config.json without EXEMPT_LOCAL_REVIEW_KEYS.
//   PROMPT_VERSION lives in local-review/prompt.mjs, so the directory rule covers it. No CONTEXT_VERSION exists today.
//   scripts/ratchets/review-skip-sync.mjs is in the set (coordinator ruling, 2026-11-12): local-review/context.mjs:12 loads it with a
//   dynamic import inside a try (optional), and it builds the skip list the reviewer reads. It has no relative import of its own.
// bandVersion: the band set. BAND_SET_FILES (the whole review-router.mjs blob) and the matrix block of review-router.config.json.
// Import closure: importClosureGaps reads both sets, static and literal dynamic imports. BAND_SET_IMPORT_EXEMPT is the one import from the
//   band set that stays outside both sets (coordinator ruling, final): review-router.mjs:47 imports PR status helpers from review-status.mjs.
// engineVersion: the contract name. An alias of reviewerVersion, exported from this module only.
//
// WARNING: scripts/eval/review-eval/freeze.mjs also exports a function named engineVersion. It has another meaning:
// 12 hex over the model, the prompt hash and two blobs. Never mix the two values or the two imports.
//
// Rules:
// - Everything is read from the commit's tree (git ls-tree and git cat-file blob), never from the working tree or the index.
//   Files count by git blob id, so a checkout's line endings never change the value. CRLF bytes committed are another blob.
// - The config file's own blob id is NOT hashed: a cap raise or a coderabbit.* change changes neither version.
//   Only the two blocks are hashed, as canonical JSON: object keys sorted (code-unit order) at every level, arrays kept in order.
//   The exempt keys are removed at the top level of local_review only.
// - A listed file missing at the commit is an error that names every missing path (Error.missing), never a silent skip.
//   So the result's missing list is always [] on success.
// - Hash text: a format tag line, one "path<TAB>blobId" line per file sorted by path, one "<block><TAB><canonical JSON>" line,
//   each line ended by \n. The version is the first 16 hex of sha256 over it.
//
// CLI: node scripts/eval/review-eval/engine-version.mjs --sha <sha40> [--json] [--root <dir>]
//   Prints "engineVersion <16hex>" and "bandVersion <16hex>", or the full object with --json. --root defaults to the cwd.
//   Exit 0 ok, 1 error (one stderr line), 2 usage (one stderr line).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REVIEWER_SET_FILES = Object.freeze([
  'scripts/github/local-review.mjs',
  'scripts/github/cursor-review.mjs',
  'scripts/github/review-filter.mjs',
  'scripts/github/lib/file-lock.mjs',
  'scripts/github/lib/grok-slots.mjs',
  'scripts/github/lib/findings-repair.mjs',
  'scripts/github/lib/proc.mjs',
  'scripts/ratchets/review-skip-sync.mjs',
]);
export const REVIEWER_SET_DIR = 'scripts/github/local-review/';
export const BAND_SET_FILES = Object.freeze(['scripts/github/review-router.mjs']);
/**
 * Imports of the band set that stay outside both sets. review-router.mjs:47 imports PR status helpers from review-status.mjs (pullLabelNames,
 * latestCodeRabbitSummary, codeRabbitNotice, commitsNamed, shaIsHead). bandOf and CRITICAL_TRUST_BOUNDARY do not use them. Exempt by the
 * coordinator's final ruling; a guard test checks that classify, bandOf and globToRegExp name none of the five.
 */
export const BAND_SET_IMPORT_EXEMPT = Object.freeze(['scripts/github/review-status.mjs']);
export const CONFIG_FILE = 'review-router.config.json';
export const EXEMPT_LOCAL_REVIEW_KEYS = Object.freeze(['weekly_live_cap', 'max_concurrent', 'per_branch_cap', 'slot_wait_min', 'headless_daily_cap']);

const REVIEWER_TAG = 'reviewer-set v1';
const BAND_TAG = 'band-set v1';
const SHA_RE = /^[0-9a-f]{40}$/i;
const isTestFile = (p) => p.endsWith('.test.mjs');
const inDir = (p) => p.startsWith(REVIEWER_SET_DIR) && !isTestFile(p);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** JSON with object keys sorted at every level. Arrays keep their order. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isPlainObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function versionOf(tag, files, block, value) {
  const lines = [tag, ...[...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => `${f.path}\t${f.blob}`), `${block}\t${canonicalJson(value)}`];
  return createHash('sha256').update(`${lines.join('\n')}\n`, 'utf8').digest('hex').slice(0, 16);
}

/** files: [{ path, blob }]. localReview: the parsed local_review block; the exempt keys are removed here. */
export function reviewerVersion({ files, localReview }) {
  const kept = Object.fromEntries(Object.entries(localReview).filter(([k]) => !EXEMPT_LOCAL_REVIEW_KEYS.includes(k)));
  return versionOf(REVIEWER_TAG, files, 'local_review', kept);
}
export const engineVersion = reviewerVersion;

/** files: [{ path, blob }]. matrix: the parsed matrix block. */
export function bandVersion({ files, matrix }) {
  return versionOf(BAND_TAG, files, 'matrix', matrix);
}

/** The default git: run in root, stderr piped (never inherited), never throws. */
export function gitIn(root) {
  return (args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

/** The blob entries of the commit's whole tree: Map path -> blob id. */
function listTree(git, sha) {
  const ls = git(['ls-tree', '-r', '-z', '--full-tree', sha]);
  if (ls.status !== 0) throw new Error(`git ls-tree failed at ${sha}`);
  const blobs = new Map();
  for (const entry of String(ls.stdout).split('\0')) {
    const m = /^\d+ (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
    if (m && m[1] === 'blob') blobs.set(m[3], m[2]);
  }
  return blobs;
}

function readConfig(git, sha, blob) {
  if (!blob) throw new Error(`${CONFIG_FILE} is missing at ${sha}`);
  const r = git(['cat-file', 'blob', blob]);
  if (r.status !== 0) throw new Error(`git cat-file failed for ${CONFIG_FILE} at ${sha}`);
  let cfg;
  try { cfg = JSON.parse(String(r.stdout).replace(/^\uFEFF/, '')); } catch (e) { throw new Error(`${CONFIG_FILE} at ${sha} is not valid JSON: ${e.message}`); }
  for (const block of ['local_review', 'matrix']) {
    if (!isPlainObject(cfg?.[block])) throw new Error(`${CONFIG_FILE} at ${sha} has no ${block} object`);
  }
  return cfg;
}

// ---- the lists at a sha (card sweep-pinned-own-lists) ----
// A pinned engine copy is proven and versioned by the lists of ITS sha. The checkout's lists can name a file the pin never had (PR 567).

/** This module, the one source of the lists at a sha. */
export const LIST_MODULE = 'scripts/eval/review-eval/engine-version.mjs';
/**
 * The lists for a sha that predates this module: as first written in 9f93fe56 (2026-11-12). The pin 01f63c79 is older than the module.
 * A test ties this baseline to that commit. Never edit it to follow the constants above.
 */
export const PRE_MODULE_BASELINE = Object.freeze({
  firstSha: '9f93fe568ccbc578d0bd9cec5f487702753c355d',
  reviewerSetFiles: Object.freeze([
    'scripts/github/local-review.mjs',
    'scripts/github/cursor-review.mjs',
    'scripts/github/review-filter.mjs',
    'scripts/github/lib/file-lock.mjs',
    'scripts/github/lib/grok-slots.mjs',
    'scripts/github/lib/findings-repair.mjs',
    'scripts/github/lib/proc.mjs',
    'scripts/ratchets/review-skip-sync.mjs',
  ]),
  bandSetFiles: Object.freeze(['scripts/github/review-router.mjs']),
  reviewerSetDir: 'scripts/github/local-review/',
});
const CHECKOUT_LISTS = Object.freeze({ reviewerSetFiles: REVIEWER_SET_FILES, bandSetFiles: BAND_SET_FILES, reviewerSetDir: REVIEWER_SET_DIR });

/** A frozen string array constant of the module text: only quoted strings and commas between the brackets, else an error. */
function literalArray(text, name, at) {
  const m = new RegExp(`^export const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\);`, 'm').exec(text);
  if (!m) {
    if (new RegExp(`^export const ${name}\\b`, 'm').test(text)) throw new Error(`${name} at ${at} is not a plain literal array`);
    throw new Error(`${LIST_MODULE} at ${at} has no ${name}`);
  }
  if (!/^(\s*'[^'\\\n]+'\s*,?)*\s*$/.test(m[1])) throw new Error(`${name} at ${at} is not a plain literal array`);
  return [...m[1].matchAll(/'([^'\\\n]+)'/g)].map((x) => x[1]);
}

function literalString(text, name, at) {
  const m = new RegExp(`^export const ${name} = (.*);\\s*$`, 'm').exec(text);
  if (!m) throw new Error(`${LIST_MODULE} at ${at} has no ${name}`);
  const s = /^'([^'\\\n]+)'$/.exec(m[1].trim());
  if (!s) throw new Error(`${name} at ${at} is not a plain string literal`);
  return s[1];
}

/**
 * The file lists at one commit: { reviewerSetFiles, bandSetFiles, reviewerSetDir, source }. With this module at the sha, its own constants
 * (source "sha"); a constant that is absent or not a plain literal is an error. Without the module, PRE_MODULE_BASELINE (source
 * "baseline"). Never the checkout's lists. Throws an Error with a one-line message.
 */
export function listsAt({ sha, git }) {
  const at = String(sha).slice(0, 12);
  const type = git(['cat-file', '-t', sha]);
  if (type.status !== 0 || String(type.stdout).trim() !== 'commit') throw new Error(`${sha} is not a commit in this repository`);
  const blob = git(['rev-parse', '--verify', '--quiet', `${sha}:${LIST_MODULE}`]);
  if (blob.status !== 0) {
    const b = PRE_MODULE_BASELINE;
    // The baseline is for a sha OLDER than the module only. A later sha without it (a rename, a delete) is an error. A repo that does not
    // hold firstSha at all (a test fixture) has no later history to confuse, so its sha gets the baseline.
    const anc = git(['merge-base', '--is-ancestor', b.firstSha, sha]);
    if (anc.status === 0) throw new Error(`${LIST_MODULE} is absent at ${at}, which has ${b.firstSha.slice(0, 12)} as ancestor: a renamed or deleted list module`);
    if (anc.status !== 1 && git(['cat-file', '-e', `${b.firstSha}^{commit}`]).status === 0) throw new Error(`git merge-base failed for ${b.firstSha.slice(0, 12)} and ${at}`);
    return { reviewerSetFiles: [...b.reviewerSetFiles], bandSetFiles: [...b.bandSetFiles], reviewerSetDir: b.reviewerSetDir, source: 'baseline' };
  }
  const r = git(['cat-file', 'blob', String(blob.stdout).trim()]);
  if (r.status !== 0) throw new Error(`git cat-file failed for ${LIST_MODULE} at ${at}`);
  const text = String(r.stdout).replace(/\r\n/g, '\n');
  return {
    reviewerSetFiles: literalArray(text, 'REVIEWER_SET_FILES', at),
    bandSetFiles: literalArray(text, 'BAND_SET_FILES', at),
    reviewerSetDir: literalString(text, 'REVIEWER_SET_DIR', at),
    source: 'sha',
  };
}

/**
 * Both versions at one commit. Throws an Error with a one-line message on any problem. `lists` (from listsAt) replaces the checkout's
 * lists; without it the checkout's lists are used, as before, for every other caller.
 */
export function computeVersions({ sha, root = process.cwd(), git = gitIn(root), lists = CHECKOUT_LISTS } = {}) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new Error(`sha must be 40 hex digits, got ${JSON.stringify(String(sha).slice(0, 60))}`);
  const id = sha.toLowerCase();
  const type = git(['cat-file', '-t', id]);
  if (type.status !== 0 || String(type.stdout).trim() !== 'commit') throw new Error(`${id} is not a commit in this repository`);
  const blobs = listTree(git, id);
  const missing = [...lists.reviewerSetFiles, ...lists.bandSetFiles].filter((p) => !blobs.has(p)).sort();
  if (missing.length > 0) throw Object.assign(new Error(`missing at ${id}: ${missing.join(', ')}`), { missing });
  const cfg = readConfig(git, id, blobs.get(CONFIG_FILE));
  const pick = (paths) => paths.map((p) => ({ path: p, blob: blobs.get(p) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const inSet = (p) => p.startsWith(lists.reviewerSetDir) && !isTestFile(p);
  const reviewerFiles = pick([...lists.reviewerSetFiles, ...[...blobs.keys()].filter(inSet)]);
  const bandFiles = pick([...lists.bandSetFiles]);
  const rv = reviewerVersion({ files: reviewerFiles, localReview: cfg.local_review });
  return { sha: id, engineVersion: rv, reviewerVersion: rv, bandVersion: bandVersion({ files: bandFiles, matrix: cfg.matrix }), reviewerFiles, bandFiles, missing: [] };
}

// ---- import closure (seat ruling 5) ----
// Matches the specifier only (from './x', a bare import './x', or a literal dynamic import('./x')), so a comment inside a brace list cannot
// hide an import. It fails closed: the same text inside a comment or a string also counts. A computed import(expr) is not seen.
const IMPORT_RE = /\b(?:from|import)\s*(?:\(\s*)?['"](\.{1,2}\/[^'"]+)['"]/g;

/** The relative specifiers of the static imports, export-from lines and literal import() calls of a source text, in source order. */
export function relativeImports(text) {
  return [...String(text).matchAll(IMPORT_RE)].map((m) => m[1]);
}

function walk(root, rel) {
  let entries;
  try { entries = readdirSync(path.join(root, ...rel.split('/')), { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => (e.isDirectory() ? walk(root, `${rel}${e.name}/`) : [`${rel}${e.name}`]));
}

/** The gaps of one source file: each relative import whose target is not in `allowed`. An absent file is one gap with spec null. */
function fileGaps(root, file, allowed) {
  let text;
  try { text = readFileSync(path.join(root, ...file.split('/')), 'utf8'); } catch { return [{ file, spec: null, target: null }]; }
  return relativeImports(text)
    .map((spec) => ({ file, spec, target: path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)) }))
    .filter((g) => !allowed.has(g.target));
}

/**
 * Reads the working-tree files under root (no git). Returns every relative import (static or literal dynamic) of a reviewer-set or band-set
 * source file whose target is in neither set: [{ file, spec, target }]. A band-set file may also import bandExempt (default
 * BAND_SET_IMPORT_EXEMPT); a reviewer-set file may not. A listed file that is absent gives { file, spec: null, target: null }.
 */
export function importClosureGaps({ root, bandExempt = BAND_SET_IMPORT_EXEMPT }) {
  const reviewer = [...REVIEWER_SET_FILES, ...walk(root, REVIEWER_SET_DIR).filter(inDir)];
  const inSets = new Set([...reviewer, ...BAND_SET_FILES]);
  const isCode = (f) => /\.[cm]?js$/.test(f);
  return [
    ...reviewer.filter(isCode).flatMap((f) => fileGaps(root, f, inSets)),
    ...BAND_SET_FILES.filter(isCode).flatMap((f) => fileGaps(root, f, new Set([...inSets, ...bandExempt]))),
  ];
}

// ---- CLI ----
const USAGE = 'usage: engine-version.mjs --sha <sha40> [--json] [--root <dir>]';

function parseArgs(argv) {
  const a = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const f = argv[i];
    if (f === '--json') a.json = true;
    else if ((f === '--sha' || f === '--root') && argv[i + 1] !== undefined) { i += 1; a[f.slice(2)] = argv[i]; }
    else return { error: `unknown or incomplete argument ${f}` };
  }
  if (a.sha === undefined) return { error: 'missing --sha' };
  return a;
}

/** deps: { out, err, cwd, git }. Returns the exit code. */
export function main(argv, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(s));
  const err = deps.err ?? ((s) => process.stderr.write(s));
  const a = parseArgs(argv);
  if (a.error) { err(`engine-version: ${a.error}; ${USAGE}\n`); return 2; }
  const root = a.root ? path.resolve(a.root) : (deps.cwd ?? process.cwd());
  let v;
  try { v = computeVersions({ sha: a.sha, root, git: deps.git ?? gitIn(root) }); } catch (e) {
    err(`engine-version: ${String(e?.message ?? e).split(/\r?\n/)[0]}\n`);
    return 1;
  }
  out(a.json ? `${JSON.stringify(v, null, 2)}\n` : `engineVersion ${v.engineVersion}\nbandVersion ${v.bandVersion}\n`);
  return 0;
}

/** Real paths, case-blind on Windows, so "c:\..." in argv[1] still runs the CLI. */
function isMain() {
  if (!process.argv[1]) return false;
  const real = (p) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return fold(real(process.argv[1])) === fold(real(fileURLToPath(import.meta.url)));
}

if (isMain()) process.exitCode = main(process.argv.slice(2));
