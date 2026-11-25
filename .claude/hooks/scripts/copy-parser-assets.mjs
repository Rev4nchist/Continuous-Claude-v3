#!/usr/bin/env node
/**
 * Copy the three files the shell parser reads at run time next to the bundles in dist/ (design note 02 section 8):
 *   dist/sh-syntax.wasm            <- node_modules/sh-syntax/main.wasm
 *   dist/sh-syntax-wasm_exec.cjs   <- node_modules/sh-syntax/vendors/wasm_exec.cjs
 *   dist/shell-ast-walk.ps1        <- src/shell-ast-walk.ps1
 * esbuild bundles the loader (src/shared/shell-ast.ts) but not these files, and ~/.claude/hooks has no node_modules/sh-syntax, so a
 * built hook that reads a command needs them beside it. A missing source stops the build (exit 1): a dist without them would fail
 * closed on every review text (rows E1 and E2 of the coderabbit guard).
 * Usage: node scripts/copy-parser-assets.mjs [hooks-root]
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ASSETS = [
  { dist: 'sh-syntax.wasm', from: (pkgDir, root) => join(pkgDir, 'main.wasm') },
  { dist: 'sh-syntax-wasm_exec.cjs', from: (pkgDir, root) => join(pkgDir, 'vendors', 'wasm_exec.cjs') },
  { dist: 'shell-ast-walk.ps1', from: (pkgDir, root) => join(root, 'src', 'shell-ast-walk.ps1') },
];

export function copyParserAssets(root) {
  const pkgJson = createRequire(join(root, 'package.json')).resolve('sh-syntax/package.json');
  const pkgDir = dirname(pkgJson);
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  for (const a of ASSETS) {
    const src = a.from(pkgDir, root);
    if (!existsSync(src)) throw new Error(`copy-parser-assets: source missing: ${src}`);
    copyFileSync(src, join(distDir, a.dist));
  }
  return ASSETS.map((a) => a.dist);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..'));
  try {
    process.stdout.write(`copy-parser-assets: ${copyParserAssets(root).join(', ')}\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
