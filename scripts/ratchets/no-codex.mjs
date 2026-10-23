#!/usr/bin/env node
/**
 * Fail when a runtime file names the removed cross-model CLI.
 * Dated history and third-party package names are listed in the allow file,
 * one path with one reason. A scan of zero files fails. An allow entry that
 * does not occur in its file fails (a pass on zero inputs is a fail).
 *
 *   node scripts/ratchets/no-<token>.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFile } from './no-work-user.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const TOKEN = ['c', 'o', 'd', 'e', 'x'].join('');
const NEEDLE = new RegExp(TOKEN, 'gi');
const SELF = join('scripts', 'ratchets', `no-${TOKEN}.mjs`);
const ALLOW_FILE = join('scripts', 'ratchets', `no-${TOKEN}-allow.json`);

const ROOTS = [
  '.claude',
  'scripts',
  'opc',
  'vendor',
  '.workroom',
  'docs/reviews',
  'docs/self-improvement',
];

const SKIP_DIR = new Set(['node_modules', '.git', 'cache', '.venv', '__pycache__']);

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
  const allowRaw = JSON.parse(readFileSync(join(REPO, ALLOW_FILE), 'utf8'));
  if (!Array.isArray(allowRaw) || allowRaw.length === 0) {
    process.stdout.write('RESULT: FAIL - allow-list empty\n');
    process.exit(1);
  }
  const allow = new Map();
  for (const row of allowRaw) {
    if (!row || !row.path || !row.reason) {
      process.stdout.write('RESULT: FAIL - allow entry missing path or reason\n');
      process.exit(1);
    }
    allow.set(row.path.replace(/\\/g, '/'), String(row.reason));
  }

  const files = [];
  for (const rel of ROOTS) {
    const abs = join(REPO, rel);
    if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) walk(abs, files);
  }
  for (const name of readdirSync(REPO)) {
    if (!name.endsWith('.md')) continue;
    const abs = join(REPO, name);
    if (statSync(abs).isFile()) files.push(abs);
  }

  let hits = 0;
  const listed = [];
  const seenAllow = new Set();
  for (const file of files) {
    const rel = relative(REPO, file).replace(/\\/g, '/');
    if (rel === SELF || rel === ALLOW_FILE) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const n = scanFile(text, NEEDLE);
    if (!n) continue;
    if (allow.has(rel)) {
      seenAllow.add(rel);
      continue;
    }
    hits += n;
    listed.push(`${rel} ${n}`);
  }

  const missing = [...allow.keys()].filter((p) => !seenAllow.has(p));
  process.stdout.write(`files: ${files.length}\n`);
  process.stdout.write(`allow: ${allow.size}\n`);
  process.stdout.write(`hits: ${hits}\n`);
  for (const line of listed) process.stdout.write(`  ${line}\n`);
  if (files.length === 0) {
    process.stdout.write('RESULT: FAIL - scanned 0 files\n');
    process.exit(1);
  }
  if (missing.length) {
    process.stdout.write(`RESULT: FAIL - allow entries with no hit (${missing.length})\n`);
    for (const p of missing) process.stdout.write(`  ${p}\n`);
    process.exit(1);
  }
  if (hits) {
    process.stdout.write('RESULT: FAIL - removed CLI name\n');
    process.exit(1);
  }
  process.stdout.write('RESULT: OK\n');
}

main();
