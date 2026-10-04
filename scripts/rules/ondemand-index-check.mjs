#!/usr/bin/env node
/**
 * ondemand-index-check.mjs — keeps the always-loaded index in step with the rule-router manifest.
 *
 * .claude/rules-ondemand/manifest.json decides which tool call loads which rule file.
 * .claude/rules-src/on-demand-rules.md is the always-loaded index a session reads to PLAN around
 * those rules. Nothing tied the two together, so a rule could load with no index row (a session
 * never plans for it), or a row could name a file that no longer exists.
 *
 * Checks, against the table rows of the index only:
 *   - every manifest file exists in rules-ondemand/ (a missing file makes the router fail open)
 *   - every manifest file has an index row
 *   - every file an index row names exists
 *   - every rule file in rules-ondemand/ is loaded by some manifest entry
 *   - a row says "block" for a deny-first rule and "inject" for an inject rule
 *
 * Usage: node scripts/rules/ondemand-index-check.mjs [--repo <dir>]   exit 1 on any problem
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Index table rows (lines starting with `|`), each with the backticked *.md files it names. */
function indexRows(indexText) {
  return indexText.split(/\r?\n/)
    .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l))
    .map((line) => ({ line, files: [...line.matchAll(/`([\w.-]+\.md)`/g)].map((m) => m[1]) }))
    .filter((r) => r.files.length > 0);
}

/**
 * @param {{ manifest: { rules: { id: string, files: string[], mode: string }[] }, indexText: string, files: string[] }} input
 * @returns {string[]} one line per problem; empty when the index and manifest agree
 */
export function checkIndex({ manifest, indexText, files }) {
  const problems = [];
  const onDisk = new Set(files);
  const rows = indexRows(indexText);
  const rowFor = (f) => rows.find((r) => r.files.includes(f));
  const loaded = new Set();
  for (const r of manifest.rules) {
    for (const f of r.files) {
      loaded.add(f);
      if (!onDisk.has(f)) problems.push(`${f} (rule ${r.id}): missing from rules-ondemand/`);
      const row = rowFor(f);
      if (!row) { problems.push(`${f} (rule ${r.id}): no row in the index`); continue; }
      const word = r.mode === 'deny-first' ? 'block' : 'inject';
      if (!new RegExp(`\\b${word}\\b`).test(row.line.split('|').slice(-2).join('|'))) {
        problems.push(`${f} (rule ${r.id}): mode ${r.mode}, but its index row does not say "${word}"`);
      }
    }
  }
  for (const r of rows) {
    for (const f of r.files) if (!onDisk.has(f)) problems.push(`${f}: index row names a file that is not in rules-ondemand/`);
  }
  for (const f of files) if (!loaded.has(f)) problems.push(`${f}: in rules-ondemand/, but no manifest entry loads it`);
  return [...new Set(problems)];
}

function main() {
  const args = process.argv.slice(2);
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = args.includes('--repo') ? resolve(args[args.indexOf('--repo') + 1]) : resolve(here, '..', '..');
  const dir = join(repo, '.claude', 'rules-ondemand');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const indexText = readFileSync(join(repo, '.claude', 'rules-src', 'on-demand-rules.md'), 'utf8');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  const problems = checkIndex({ manifest, indexText, files });
  const fileCount = new Set(manifest.rules.flatMap((r) => r.files)).size;
  if (problems.length === 0) {
    console.log(`ondemand-index-check: OK (${manifest.rules.length} manifest entries, ${fileCount} rule files, all indexed)`);
    process.exit(0);
  }
  console.log(`ondemand-index-check: ${problems.length} problem(s) between manifest.json and on-demand-rules.md`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

const isDirectRun = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isDirectRun) main();
