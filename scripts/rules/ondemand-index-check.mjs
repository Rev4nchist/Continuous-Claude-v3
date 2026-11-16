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
 * Groups of rules that share one identical trigger pattern, and so fire on the same call, whose joined text is over the
 * hook cap. The router joins every rule that fires on one call into ONE text, and the cap applies to that text. Both
 * groups below hold the PR core file plus a rule of 7,900 or more characters that is not ours to shorten here. They
 * stay over the cap until that rule is shortened or the router sends one rule per message. A group that is not over any
 * more fails, so the list cannot go stale. Only the first call of a session can hit it: a rule the router already sent
 * is not sent again.
 */
export const KNOWN_COFIRE_OVER = ['coderabbit-cli+pr-review-loop', 'git-merge+pr-review-loop'];

/** `## ` headings of a rule file, without a date or an aside: "Paid PR reviews (Dave, 2026-10-30)" is "Paid PR reviews". */
const plainHeadings = (text) => text.split(/\r?\n/).filter((l) => /^## /.test(l)).map((l) => l.slice(3).replace(/\s+[(—].*$/, '').trim());

/**
 * @param {{ manifest: { rules: { id: string, files: string[], mode: string }[] }, indexText: string, files: string[],
 *   sizes?: Record<string, number>, texts?: Record<string, string>, referenceOnly?: string[], knownCofire?: string[] }} input
 *   `sizes` is characters per rule file; without it no size check runs. `texts` is the text per rule file; it is read
 *   only to find which loaded file names a reference-only file and whether it lists every `##` heading of that file.
 * @returns {string[]} one line per problem; empty when the index and manifest agree
 */
export function checkIndex({ manifest, indexText, files, sizes = null, texts = {}, referenceOnly = [], knownCofire = [] }) {
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
    problems.push(...cofireProblems(manifest, sizes, knownCofire));
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
    // or in a preview that is cut, does not reach the session. The path match ends at the name, so `.md.bak` is no link.
    const pathRe = new RegExp(`rules-ondemand/${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`);
    const namerFiles = manifest.rules.filter((r) => !overCap.has(r.id)).flatMap((r) => r.files)
      .filter((lf) => pathRe.test((texts[lf] || '').replace(/\\/g, '/')));
    if (namerFiles.length === 0) {
      problems.push(`${f}: listed as reference only, but no loaded rule file that fits the hook cap names it by its path (rules-ondemand/${f})`);
      continue;
    }
    // The named file is a manual: its loaded namer must list every `##` section so a new section cannot hide.
    const missing = plainHeadings(texts[f] || '').filter((h) => !namerFiles.some((lf) => texts[lf].includes(h)));
    if (missing.length > 0) problems.push(`${f}: reference only, but ${namerFiles.join(', ')} has no line for its section(s): ${missing.join('; ')}`);
  }
  for (const f of files) if (!loaded.has(f) && !referenceOnly.includes(f)) problems.push(`${f}: in rules-ondemand/, but no manifest entry loads it`);
  return [...new Set(problems)];
}

/** One problem per over-cap co-fire group that is not on the known list, and one per known group that is not over any more. */
function cofireProblems(manifest, sizes, knownCofire) {
  const groups = new Map();
  for (const r of manifest.rules) {
    for (const p of [...(r.command || []), ...(r.segment || []), ...(r.tools || []), ...(r.skill || []), ...(r.agent || [])]) {
      if (!groups.has(p)) groups.set(p, new Map());
      groups.get(p).set(r.id, r);
    }
  }
  const over = new Map();
  for (const byId of groups.values()) {
    const rules = [...byId.values()];
    // Two rules or more; a deny-first rule turns the whole text into a deny reason, which is not cut.
    if (rules.length < 2 || rules.some((r) => r.mode === 'deny-first')) continue;
    const chars = rules.reduce((n, r) => n + r.files.reduce((m, f) => m + (sizes[f] ?? 0), 0) + ROUTER_OVERHEAD, 0) + 2 * (rules.length - 1);
    if (chars > HOOK_CONTEXT_CAP) over.set(rules.map((r) => r.id).sort().join('+'), chars);
  }
  const problems = [];
  for (const [key, chars] of over) {
    if (!knownCofire.includes(key)) problems.push(`rules ${key.replace(/\+/g, ' and ')} fire on one call and join to ${chars} characters with the router lines, over the 10,000 character hook cap: the reader gets a 2,000 character preview. Shorten one of them`);
  }
  for (const key of knownCofire) {
    if (!over.has(key)) problems.push(`${key}: listed in KNOWN_COFIRE_OVER, but that group is not over the cap now; remove it from the list`);
  }
  return problems;
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
  const problems = checkIndex({ manifest, indexText, files, sizes, texts, referenceOnly: REFERENCE_ONLY, knownCofire: KNOWN_COFIRE_OVER });
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
