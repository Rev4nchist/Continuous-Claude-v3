#!/usr/bin/env node
/**
 * review-skip-sync.mjs - the PR review bots skip the same paths.
 *
 * REVIEW.md ("Skip paths" section, first fenced block, one glob per line) is the one list. This ratchet
 * compares it with the two bot configs:
 *   - .greptile/config.json   `ignorePatterns`: one string, globs joined by newlines
 *   - .coderabbit.yaml        `reviews.path_filters`: list entries that start with "!"
 * The YAML is read with a small regex, not a YAML library (node builtins only). It finds the line
 * `path_filters:` and reads the `- "..."` lines under it until the first line that is not a list item or
 * a comment. A `!` entry is a skip path; an entry without `!` is an include filter and is ignored.
 *
 * Usage: node scripts/ratchets/review-skip-sync.mjs [--root <repo root>]
 * Exit 0 = in sync. Exit 1 = a bot config misses a REVIEW.md glob or holds an extra one (printed).
 * Exit 2 = cannot compare (a file, the section, the list or a key is missing). ASCII only.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class CannotCompare extends Error {}

const lines = (text) => String(text).split(/\r?\n/);

/** Globs in the first fenced block under the "Skip paths" heading of REVIEW.md. */
export function parseReviewMd(text) {
  const all = lines(text);
  const at = all.findIndex((l) => /^##\s+Skip paths\s*$/i.test(l));
  if (at < 0) throw new CannotCompare('REVIEW.md has no "## Skip paths" section');
  const rest = all.slice(at + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  const section = end < 0 ? rest : rest.slice(0, end);
  const open = section.findIndex((l) => /^```/.test(l));
  const close = open < 0 ? -1 : section.findIndex((l, i) => i > open && /^```\s*$/.test(l));
  if (open < 0 || close < 0) throw new CannotCompare('REVIEW.md "Skip paths" has no fenced block');
  const globs = section.slice(open + 1, close).map((l) => l.trim()).filter(Boolean);
  if (globs.length === 0) throw new CannotCompare('REVIEW.md "Skip paths" block is empty');
  return globs;
}

export function parseGreptile(text) {
  let config;
  try { config = JSON.parse(text); } catch { throw new CannotCompare('.greptile/config.json is not valid JSON'); }
  if (typeof config.ignorePatterns !== 'string') throw new CannotCompare('.greptile/config.json has no ignorePatterns string');
  return lines(config.ignorePatterns).map((l) => l.trim()).filter(Boolean);
}

export function parseCodeRabbit(text) {
  const all = lines(text);
  const at = all.findIndex((l) => /^\s*path_filters:\s*(#.*)?$/.test(l));
  if (at < 0) throw new CannotCompare('.coderabbit.yaml has no path_filters list');
  const globs = [];
  for (const line of all.slice(at + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s*-\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    if (!item) break;
    const value = item[1] ?? item[2] ?? item[3];
    if (value.startsWith('!')) globs.push(value.slice(1));
  }
  return globs;
}

/** What `actual` lacks and what it adds, against the REVIEW.md list. */
export function diff(expected, actual) {
  const have = new Set(actual);
  const want = new Set(expected);
  return { missing: expected.filter((g) => !have.has(g)), extra: [...have].filter((g) => !want.has(g)) };
}

const read = (root, rel) => {
  try { return readFileSync(path.join(root, rel), 'utf8'); } catch { throw new CannotCompare(`cannot read ${rel}`); }
};

export function check(root) {
  const expected = parseReviewMd(read(root, 'REVIEW.md'));
  const bots = [
    ['greptile (.greptile/config.json ignorePatterns)', parseGreptile(read(root, '.greptile/config.json'))],
    ['coderabbit (.coderabbit.yaml path_filters)', parseCodeRabbit(read(root, '.coderabbit.yaml'))],
  ];
  return bots.map(([name, actual]) => ({ name, ...diff(expected, actual) }));
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--root');
  const root = at >= 0 ? path.resolve(args[at + 1] ?? '.') : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  let results;
  try { results = check(root); } catch (err) {
    if (!(err instanceof CannotCompare)) throw err;
    console.error(`review-skip-sync: cannot compare (${err.message})`);
    process.exit(2);
  }
  let bad = 0;
  for (const r of results) {
    for (const g of r.missing) { console.log(`${r.name}: missing ${g}`); bad++; }
    for (const g of r.extra) { console.log(`${r.name}: extra ${g}`); bad++; }
  }
  console.log(bad === 0 ? 'review-skip-sync: OK, both bot configs match REVIEW.md' : `review-skip-sync: FAIL, ${bad} difference(s) from REVIEW.md`);
  process.exit(bad === 0 ? 0 : 1);
}

if ((process.argv[1] ?? '') && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
