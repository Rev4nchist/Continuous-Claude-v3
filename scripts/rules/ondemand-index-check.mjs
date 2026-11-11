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
 *   - an inject rule fits under the hook text cap (see HOOK_CONTEXT_CAP), or is on the known list
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
 * Claude Code cuts a hook `additionalContext` string above this size to a 2,000 character preview
 * and saves the rest to a file that the model is not told to read (hooks guide). The router sends
 * an inject rule as `additionalContext`. It sends a deny-first rule as the deny reason, which is
 * not cut (probe of 2026-11-11, lane std-coordination, findings rows 56 and 57).
 */
export const HOOK_CONTEXT_CAP = 10000;
/** Upper bound for what rule-router adds to one rule: its header, the path line and the false-fire footer. */
export const ROUTER_OVERHEAD = 500;
/** Inject files that are over the cap today. Lane `pr-review-loop-10k-cut` owns the fix. Remove a name when its file fits. */
export const KNOWN_OVER_CAP = ['pr-review-loop.md'];

/**
 * @param {{ manifest: { rules: { id: string, files: string[], mode: string }[] }, indexText: string, files: string[],
 *   sizes?: Record<string, number>, knownOver?: string[] }} input  `sizes` is characters per rule file; without it no size check runs
 * @returns {string[]} one line per problem; empty when the index and manifest agree
 */
export function checkIndex({ manifest, indexText, files, sizes = null, knownOver = KNOWN_OVER_CAP }) {
  const problems = [];
  if (sizes) {
    const stillOver = new Set();
    for (const r of manifest.rules) {
      if (r.mode === 'deny-first') continue;
      const chars = r.files.reduce((n, f) => n + (sizes[f] ?? 0), 0) + ROUTER_OVERHEAD;
      if (chars <= HOOK_CONTEXT_CAP) continue;
      const known = r.files.filter((f) => knownOver.includes(f));
      known.forEach((f) => stillOver.add(f));
      if (known.length === 0) {
        problems.push(`${r.files.join(', ')} (rule ${r.id}): inject text is ${chars} characters with the router lines, over the 10,000 character hook cap. `
          + 'A session gets a 2,000 character preview. Make the rule deny-first or shorten the file');
      }
    }
    for (const f of knownOver) {
      if (!stillOver.has(f)) problems.push(`${f}: listed as known over the cap, but it fits now or is not an inject rule; remove it from KNOWN_OVER_CAP`);
    }
  }
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
  // The router sends the trimmed text of the file as it is on disk, so count that.
  const sizes = Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), 'utf8').trim().length]));
  const problems = checkIndex({ manifest, indexText, files, sizes });
  const fileCount = new Set(manifest.rules.flatMap((r) => r.files)).size;
  if (problems.length === 0) {
    console.log(`ondemand-index-check: OK (${manifest.rules.length} manifest entries, ${fileCount} rule files, all indexed)`);
    for (const f of KNOWN_OVER_CAP) console.log(`  note: ${f} is ${sizes[f]} characters, over the hook cap of ${HOOK_CONTEXT_CAP}: a session gets a preview only (lane pr-review-loop-10k-cut)`);
    process.exit(0);
  }
  console.log(`ondemand-index-check: ${problems.length} problem(s) between manifest.json and on-demand-rules.md`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

const isDirectRun = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isDirectRun) main();
