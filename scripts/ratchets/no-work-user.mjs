#!/usr/bin/env node
/**
 * Fail when a runtime file names the work-machine user as a path.
 * The GitHub login is an account name, not a filesystem path, and is allowed.
 * An email address is not a path. A scan of zero files fails.
 *
 *   node scripts/ratchets/no-work-user.mjs
 *   node scripts/ratchets/no-work-user.mjs --root <dir>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const NEEDLE = /david[.-]hayes(?!@)/g;
const ACCOUNT = /david-hayes44/g;

const ROOTS = [
  '.claude/hooks/src',
  '.claude/rules-src',
  '.claude/rules-ondemand',
  '.claude/skills',
  '.claude/agents',
  '.claude/templates',
  '.claude/scripts',
  'scripts',
  'opc/scripts',
];

const SKIP_DIR = new Set(['node_modules', '.git']);

export function scanFile(text) {
  const stripped = text.replace(ACCOUNT, '');
  const hits = [];
  for (const match of stripped.matchAll(NEEDLE)) hits.push(match.index);
  return hits.length;
}

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const abs = join(dir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs, out);
    else if (st.isFile() && st.size < 2_000_000) out.push(abs);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf('--root');
  const root = rootFlag === -1 ? REPO : resolve(argv[rootFlag + 1]);
  const relRoots = rootFlag === -1 ? ROOTS.map((r) => join(root, r)) : [root];
  const files = [];
  for (const dir of relRoots) walk(dir, files);
  let hits = 0;
  const listed = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const n = scanFile(text);
    if (n) {
      hits += n;
      listed.push(`${relative(root, file)} ${n}`);
    }
  }
  process.stdout.write(`files: ${files.length}\n`);
  process.stdout.write(`hits: ${hits}\n`);
  for (const line of listed) process.stdout.write(`  ${line}\n`);
  if (files.length === 0) {
    process.stdout.write('RESULT: FAIL - scanned 0 files\n');
    process.exit(1);
  }
  if (hits) {
    process.stdout.write('RESULT: FAIL - work-user path\n');
    process.exit(1);
  }
  process.stdout.write('RESULT: OK\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
