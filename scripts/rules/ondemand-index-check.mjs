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
 *   - an inject rule fits under the hook text cap (see HOOK_CONTEXT_CAP)
 *   - a reference-only file (REFERENCE_ONLY) exists, is loaded by no entry, and is named by a loaded rule file that fits
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
/**
 * Rule files that no manifest entry loads. They are too long for a hook, so a short loaded rule names each one by its
 * active path and tells the session to read it. The check keeps that link: the file exists, it is not loaded, and a
 * loaded rule file that fits the hook cap names it. A file on the list is exempt from "no manifest entry loads it".
 */
export const REFERENCE_ONLY = ['pr-review-loop.md'];

/**
 * @param {{ manifest: { rules: { id: string, files: string[], mode: string }[] }, indexText: string, files: string[],
 *   sizes?: Record<string, number>, texts?: Record<string, string>, referenceOnly?: string[] }} input
 *   `sizes` is characters per rule file; without it no size check runs. `texts` is the text per rule file; it is read
 *   only to find which loaded file names a reference-only file.
 * @returns {string[]} one line per problem; empty when the index and manifest agree
 */
export function checkIndex({ manifest, indexText, files, sizes = null, texts = {}, referenceOnly = [] }) {
  const problems = [];
  const overCap = new Set();
  if (sizes) {
    // Limit: the router joins every rule that fires on one call into one text. Two inject rules that
    // each fit can pass the cap together. This check reads one rule at a time.
    for (const r of manifest.rules) {
      // A deny-first rule reaches the main thread as a deny reason. Without `subagent: "block"` the
      // router sends it to a subagent as inject text, so only the pair is safe at any size.
      if (r.mode === 'deny-first' && r.subagent === 'block') continue;
      const chars = r.files.reduce((n, f) => n + (sizes[f] ?? 0), 0) + ROUTER_OVERHEAD;
      if (chars <= HOOK_CONTEXT_CAP) continue;
      overCap.add(r.id);
      const who = r.mode === 'deny-first' ? 'a subagent gets it as inject text' : 'inject text';
      problems.push(`${r.files.join(', ')} (rule ${r.id}): ${who} of ${chars} characters with the router lines, over the 10,000 character hook cap. `
        + 'The reader gets a 2,000 character preview. Make the rule deny-first with "subagent": "block", or shorten the file');
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
  for (const f of referenceOnly) {
    if (!onDisk.has(f)) problems.push(`${f}: listed as reference only, but missing from rules-ondemand/`);
    const loader = manifest.rules.find((r) => r.files.includes(f));
    if (loader) problems.push(`${f}: listed as reference only, but it is also loaded by rule ${loader.id}; remove it from one of the two`);
    // The namer must be a loaded file of a rule that fits the hook cap itself: a name in a file the router never sends,
    // or in a preview that is cut, does not reach the session.
    const namers = manifest.rules.filter((r) => !overCap.has(r.id) && r.files.some((lf) => (texts[lf] || '').includes(`rules-ondemand/${f}`)));
    if (namers.length === 0) problems.push(`${f}: listed as reference only, but no loaded rule file that fits the hook cap names it by its path (rules-ondemand/${f})`);
  }
  for (const f of files) if (!loaded.has(f) && !referenceOnly.includes(f)) problems.push(`${f}: in rules-ondemand/, but no manifest entry loads it`);
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
  const texts = Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
  const problems = checkIndex({ manifest, indexText, files, sizes, texts, referenceOnly: REFERENCE_ONLY });
  const fileCount = new Set(manifest.rules.flatMap((r) => r.files)).size;
  if (problems.length === 0) {
    console.log(`ondemand-index-check: OK (${manifest.rules.length} manifest entries, ${fileCount} rule files, all indexed, ${REFERENCE_ONLY.length} reference only)`);
    process.exit(0);
  }
  console.log(`ondemand-index-check: ${problems.length} problem(s) between manifest.json and on-demand-rules.md`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

const isDirectRun = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isDirectRun) main();
