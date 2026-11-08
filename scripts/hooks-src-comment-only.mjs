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
 * Any failure to transform (syntax error, no esbuild) means "not proven", never "unchanged".
 *
 * Usage: node scripts/hooks-src-comment-only.mjs <repo-relative .ts path>...   (run in the repo)
 * Exit 0 = every path leaves the emitted code unchanged. 1 = at least one does not (or is new).
 * 2 = could not tell (no esbuild, git error). The guard treats anything but 0 as "keep the block".
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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

/** The code esbuild would emit for one file. Throws when the file does not transform. */
function emitted(esbuild, text) {
  return esbuild.transformSync(text, OPTIONS).code;
}

/** True when `after` emits exactly the code `before` emits. A file that does not transform is "no". */
function sameEmit(esbuild, before, after) {
  if (before === after) return true;
  try {
    return emitted(esbuild, before) === emitted(esbuild, after);
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
    if (!sameEmit(esbuild, before, after)) return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
