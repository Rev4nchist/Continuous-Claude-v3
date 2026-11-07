#!/usr/bin/env node
/**
 * Keep the esbuild module-path comments in dist/*.mjs the same wherever node_modules lives.
 *
 * esbuild writes each bundled module's path relative to the build folder. In the primary checkout
 * that is "node_modules/pkg/x.js". In a nested worktree that reaches packages through the shared
 * store link (.claude/worktrees/node_modules), the same file reads "../../../node_modules/pkg/x.js".
 * The code is identical, but tracked dist files change and the hooks-build gate fails.
 *
 * This step rewrites only esbuild's own two forms, at the start of a line:
 *   // ../../../node_modules/pkg/x.js
 *   "../../../node_modules/pkg/x.js"(exports) {
 * to the primary form. It is idempotent and changes nothing in the primary.
 *
 * Usage: node scripts/normalize-dist-paths.mjs [dist-dir]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function normalizeDistText(text) {
  return text
    .replace(/^(\/\/ )(?:\.\.\/)+(node_modules\/)/gm, '$1$2')
    .replace(/^(\s*")(?:\.\.\/)+(node_modules\/[^"\n]+"\()/gm, '$1$2');
}

export function normalizeDistDir(dir) {
  const changed = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    const file = join(dir, name);
    const before = readFileSync(file, 'utf8');
    const after = normalizeDistText(before);
    if (after !== before) { writeFileSync(file, after); changed.push(name); }
  }
  return changed;
}

function main(args) {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write('usage: node scripts/normalize-dist-paths.mjs [dist-dir]\nRewrites esbuild module-path comments in dist/*.mjs to the node_modules/... form.\n');
    return 0;
  }
  const dir = resolve(args[0] || join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  if (!existsSync(dir)) { process.stderr.write(`normalize-dist-paths: no folder ${dir}\n`); return 1; }
  const changed = normalizeDistDir(dir);
  process.stdout.write(`normalize-dist-paths: ${changed.length} file(s) rewritten\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
