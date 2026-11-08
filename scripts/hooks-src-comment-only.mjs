#!/usr/bin/env node
/**
 * hooks-src-comment-only.mjs - can every staged hook source change leave .claude/hooks/dist as it is?
 *
 * Used by scripts/precommit-build-guard.sh. The name is old: it first proved only comment and
 * whitespace edits. It now proves every edit that esbuild erases: comments, layout and TypeScript
 * types (interface fields, annotations, unions, `import type`, `// @ts-expect-error`).
 *
 * How: for each path, run the HEAD version and the staged (index) version through esbuild's
 * transform with the same options and compare the output text. esbuild is the tool that builds
 * the dist, so equal per-file output means the file adds the same code to every bundle. It keeps
 * what matters and drops the rest:
 * - kept in the output, so a change shows: legal notices, `@__PURE__` style annotations, the `#!`
 *   line, import paths, `return\nx` (ASI), enum and parameter-property code, any code edit.
 * - dropped, so a change does not show: ordinary comments, layout, types.
 * One more step: a relative import path (`./a`, `./a.js`, `./dir`) is compared by the file it names
 * in the git index, so adding `.js` to a path that names the same file is not a change. A path
 * that names no file in the index stays as written, so an edit to it is a change. Package names
 * are never rewritten. The rewrite finds paths in esbuild's output by pattern, then checks that the
 * pattern found exactly the imports esbuild's metafile reports, in order. Import-shaped text inside
 * a string or template literal breaks that match, so nothing is rewritten and the edit blocks.
 * Any failure to transform (syntax error, no esbuild) means "not proven", never "unchanged".
 *
 * Usage: node scripts/hooks-src-comment-only.mjs <repo-relative .ts path>...   (run in the repo)
 * Exit 0 = every path leaves the emitted code unchanged. 1 = at least one does not (or is new).
 * 2 = could not tell (no esbuild, git error). The guard treats anything but 0 as "keep the block".
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadEsbuild() {
  // esbuild lives in .claude/hooks/node_modules of the repo that holds this script (a worktree
  // reaches it through the shared store link).
  return require(require.resolve('esbuild', { paths: [join(here, '..', '.claude', 'hooks')] }));
}

// The same switches the build uses (.claude/hooks/package.json "build"): node, esm, no minify.
// Only equality of two outputs matters, so the exact target is not important; it must be the same
// for both sides.
const OPTIONS = { loader: 'ts', format: 'esm', platform: 'node', legalComments: 'inline', sourcemap: false };

/**
 * What esbuild would emit for one file: the code, and the relative import paths the build itself
 * reports (its metafile), in order. A string or template literal is not in that list. Throws when
 * the file does not build.
 */
function emitted(esbuild, text) {
  const r = esbuild.buildSync({
    stdin: { contents: text, loader: OPTIONS.loader, sourcefile: 'x.ts' },
    bundle: false, write: false, metafile: true, logLevel: 'silent',
    format: OPTIONS.format, platform: OPTIONS.platform, legalComments: OPTIONS.legalComments,
  });
  const imports = Object.values(r.metafile.outputs)[0].imports.map((i) => i.path).filter((p) => /^\.{1,2}\//.test(p));
  return { code: r.outputFiles[0].text, imports };
}

/** True when this repo-relative path is a file in the git index. */
function inIndex(path) {
  try {
    return execFileSync('git', ['cat-file', '-t', `:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'blob';
  } catch {
    return false;
  }
}

const SWAP = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] };

/**
 * The file a relative import path names, as the bundler resolves it, or null. Tried in order:
 * the exact file, a .js style ending swapped for its TypeScript ending, an added ending, an
 * index file. Only files in the git index count, so a path to nothing stays unresolved.
 */
function resolveImport(importer, spec) {
  const base = posix.normalize(posix.join(posix.dirname(importer), spec));
  const ext = posix.extname(base);
  const candidates = [base];
  for (const to of SWAP[ext] ?? []) candidates.push(base.slice(0, -ext.length) + to);
  for (const e of ['.ts', '.tsx', '.js', '.mjs']) candidates.push(base + e);
  for (const e of ['.ts', '.tsx', '.js']) candidates.push(`${base}/index${e}`);
  return candidates.find(inIndex) ?? null;
}

// esbuild writes import and export-from paths in double quotes at the start of a line, and dynamic
// imports as import("..."). Only relative paths are rewritten; a package name stays as written.
const IMPORT_PATH = /^([ \t]*(?:(?:import|export)\b[^"'\n]*?\bfrom[ \t]*|\}[ \t]*from[ \t]*|import[ \t]*))"(\.{1,2}\/[^"\n]*)"|\bimport\([ \t]*"(\.{1,2}\/[^"\n]*)"[ \t]*\)/gm;

/**
 * The emitted code with each relative import path replaced by the file it resolves to, or null.
 * Null means the paths the pattern found are not exactly the imports the build reported, in order:
 * some text that looks like an import (in a string or a template literal) or an import form the
 * pattern does not know. Then nothing is rewritten, because a rewrite could hide a change.
 */
function withResolvedImports({ code, imports }, importer) {
  const found = [];
  const name = (spec) => {
    found.push(spec);
    const file = resolveImport(importer, spec);
    return file === null ? spec : `\0${file}`;
  };
  const out = code.replace(IMPORT_PATH, (_, head, spec, dyn) =>
    spec === undefined ? `import("${name(dyn)}")` : `${head}"${name(spec)}"`);
  return found.length === imports.length && found.every((s, i) => s === imports[i]) ? out : null;
}

/**
 * True when `after` emits the code `before` emits, with each relative import path read as the file
 * it names (so `./a` and `./a.js` match when both are the same file). A file that does not
 * build, an import path that names no file in the index, and import-shaped text the build does
 * not report as an import are "no".
 */
function sameEmit(esbuild, before, after, importer) {
  if (before === after) return true;
  try {
    const b = emitted(esbuild, before);
    const a = emitted(esbuild, after);
    if (b.code === a.code) return true;
    const rb = withResolvedImports(b, importer);
    const ra = withResolvedImports(a, importer);
    return rb !== null && rb === ra;
  } catch {
    return false;
  }
}

function gitShow(spec) {
  return execFileSync('git', ['show', spec], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

function main(paths) {
  if (paths.length === 0) return 1;
  let esbuild;
  try { esbuild = loadEsbuild(); } catch { return 2; }
  for (const p of paths) {
    let before;
    let after;
    try { before = gitShow(`HEAD:${p}`); } catch { return 1; } // new or renamed file: a real change
    try { after = gitShow(`:${p}`); } catch { return 2; }
    if (!sameEmit(esbuild, before, after, p)) return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
