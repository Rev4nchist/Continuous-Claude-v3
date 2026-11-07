#!/usr/bin/env node
/**
 * no-pg-lookup.mjs - a script must not carry its own `pg` lookup.
 *
 * Why: `pg` is installed only in the primary checkout. A lookup that tries only its own checkout fails in every git worktree
 * with a bare "cannot resolve pg". The one lookup that also tries the primary checkout and NODE_PATH is
 * scripts/lib/resolve-deps.mjs (requireDep). About 21 scripts each had a copy; this ratchet keeps new copies out.
 *
 * It fails when a script file under scripts, .claude/scripts or .claude/skills holds a createRequire(...) lookup of `pg`:
 * a line that calls createRequire's result with 'pg' (`)('pg')`, `.call(null, 'pg')`, `require('pg')`, `.resolve('pg')`)
 * in a file that mentions createRequire. Comment-only lines are ignored. Hooks (.claude/hooks/src) keep their own resolution.
 * Baseline: 0 hits outside the allowlist below. A scan of zero files fails.
 *
 * Usage: node scripts/ratchets/no-pg-lookup.mjs [--root <repo root>]
 * Exit 0 = no new lookup. Exit 1 = a lookup was found (file:line printed). Exit 2 = bad usage. ASCII only.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const ROOTS = ['scripts', '.claude/scripts', '.claude/skills'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
const EXT = /\.(?:mjs|js|cjs)$/;

/**
 * The named exceptions: files that may spell the pattern. Each needs a reason.
 *   - the resolver: it is the one lookup.
 *   - this ratchet and its test: their source holds the patterns they look for.
 */
export const ALLOW = new Map([
  ['scripts/lib/resolve-deps.mjs', 'the one shared lookup'],
  ['scripts/ratchets/no-pg-lookup.mjs', 'holds the pattern it searches for'],
  ['scripts/ratchets/no-pg-lookup.test.mjs', 'fixtures hold the pattern the ratchet searches for'],
]);

const PG_CALL = /(?:\)\s*\(|\.call\(\s*null\s*,|\brequire\(|\.resolve\()\s*['"`]pg['"`]\s*\)/;
const COMMENT_ONLY = /^\s*(?:\/\/|\/?\*)/;

/** The 1-based line numbers of a createRequire(...) lookup of `pg` in `text`. Pure. */
export function findPgLookups(text) {
  const source = String(text ?? '');
  if (!source.includes('createRequire')) return [];
  const hits = [];
  source.split(/\r?\n/).forEach((line, i) => {
    if (!COMMENT_ONLY.test(line) && PG_CALL.test(line)) hits.push(i + 1);
  });
  return hits;
}

function walk(dir, out) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = path.join(dir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs, out);
    else if (st.isFile() && EXT.test(name) && st.size < 2_000_000) out.push(abs);
  }
}

/** { files, hits: [{ file, line }] } for a repo root. File names are repo-relative with forward slashes. */
export function scan(root) {
  const files = [];
  for (const r of ROOTS) walk(path.join(root, ...r.split('/')), files);
  const hits = [];
  for (const abs of files) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (ALLOW.has(rel)) continue;
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    for (const line of findPgLookups(text)) hits.push({ file: rel, line });
  }
  return { files: files.length, hits };
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('usage: node scripts/ratchets/no-pg-lookup.mjs [--root <repo root>]\nFails when a script has its own createRequire lookup of pg. Use requireDep from scripts/lib/resolve-deps.mjs.\n');
    return 0;
  }
  const i = argv.indexOf('--root');
  if (argv.some((a) => a !== '--root' && argv[argv.indexOf(a) - 1] !== '--root') || (i >= 0 && !argv[i + 1])) {
    process.stderr.write('usage: node scripts/ratchets/no-pg-lookup.mjs [--root <repo root>]\n');
    return 2;
  }
  const root = i >= 0 ? path.resolve(argv[i + 1]) : REPO;
  const { files, hits } = scan(root);
  process.stdout.write(`files: ${files}\nhits: ${hits.length}\n`);
  for (const h of hits) process.stdout.write(`  ${h.file}:${h.line}\n`);
  if (files === 0) { process.stdout.write('RESULT: FAIL - scanned 0 files\n'); return 1; }
  if (hits.length) {
    process.stdout.write('RESULT: FAIL - a script has its own pg lookup. Use requireDep(\'pg\', { repoRoot }) from scripts/lib/resolve-deps.mjs: it also tries the primary checkout and NODE_PATH.\n');
    return 1;
  }
  process.stdout.write('RESULT: PASS - 0 pg lookups outside scripts/lib/resolve-deps.mjs\n');
  return 0;
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isMain()) process.exitCode = main(process.argv.slice(2));
