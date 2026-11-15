#!/usr/bin/env node
/**
 * review-skip-sync.mjs - the PR review bots skip the same paths.
 *
 * REVIEW.md ("Skip paths" section, first fenced block, one glob per line) is the one list. This ratchet
 * compares it with the two bot configs:
 *   - .greptile/config.json   `ignorePatterns`: one string, globs joined by newlines
 *   - .coderabbit.yaml        `reviews.path_filters`: list entries that start with "!"
 * The YAML is read with a small regex, not a YAML library (node builtins only). It finds `path_filters:`
 * as a child of the top-level `reviews:` key and reads the `- "..."` lines under it until the first line
 * that is not a list item or a comment. A quoted `"!glob"` entry is a skip path. An entry without `!` is an
 * include filter and counts as extra. An unquoted `!` entry (a YAML tag) cannot be read: exit 2.
 *
 * Usage: node scripts/ratchets/review-skip-sync.mjs [--root <repo root>]
 * Exit 0 = in sync. Exit 1 = a bot config misses a REVIEW.md glob or holds an extra one (printed).
 * Exit 2 = cannot compare (a file, the section, the list or a key is missing). ASCII only.
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CannotCompare, parseReviewMd } from './lib/review-md.mjs';

const lines = (text) => String(text).split(/\r?\n/);

export { parseReviewMd };

export function parseGreptile(text) {
  let config;
  try { config = JSON.parse(text); } catch { throw new CannotCompare('.greptile/config.json is not valid JSON'); }
  if (typeof config.ignorePatterns !== 'string') throw new CannotCompare('.greptile/config.json has no ignorePatterns string');
  return lines(config.ignorePatterns).map((l) => l.trim()).filter(Boolean);
}

const indentOf = (l) => /^ */.exec(l)[0].length;
const blankOrComment = (l) => /^\s*(#.*)?$/.test(l);

/**
 * The `reviews:` block (a top-level key) and the indent of its children. Only `reviews.path_filters`
 * counts: a `path_filters` key under any other section is ignored.
 */
function reviewsBlock(all) {
  const at = all.findIndex((l) => /^reviews:\s*(#.*)?$/.test(l));
  if (at < 0) throw new CannotCompare('.coderabbit.yaml has no top-level reviews: key');
  const rest = all.slice(at + 1);
  const end = rest.findIndex((l) => !blankOrComment(l) && indentOf(l) === 0);
  const block = end < 0 ? rest : rest.slice(0, end);
  const first = block.find((l) => !blankOrComment(l));
  return { block, child: first ? indentOf(first) : 0 };
}

/**
 * `reviews.path_filters` entries. `skip` holds the quoted "!glob" entries (without the "!"). `include` holds
 * entries without "!": an include filter narrows the review to those paths, so it is a difference, not a skip path.
 * An UNQUOTED entry that starts with "!" is a YAML tag, not a glob: it cannot be read, so it is exit 2.
 */
export function parseCodeRabbit(text) {
  const { block, child } = reviewsBlock(lines(text));
  const at = block.findIndex((l) => indentOf(l) === child && /^\s*path_filters:\s*(#.*)?$/.test(l));
  if (at < 0) throw new CannotCompare('.coderabbit.yaml has no reviews.path_filters list');
  const skip = [];
  const include = [];
  for (const line of block.slice(at + 1)) {
    if (blankOrComment(line)) continue;
    if (!/^\s*-(\s|$)/.test(line)) break;
    const item = /^\s*-\s+(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    if (!item) throw new CannotCompare(`cannot read the path_filters entry: ${line.trim()}`);
    const quoted = item[1] ?? item[2];
    const value = quoted ?? item[3];
    if (quoted === undefined && value.startsWith('!')) {
      throw new CannotCompare(`path_filters entry ${value} is unquoted; quote it ("${value}") or YAML reads "!" as a tag`);
    }
    if (value.startsWith('!')) skip.push(value.slice(1));
    else include.push(value);
  }
  return { skip, include };
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
  const cr = parseCodeRabbit(read(root, '.coderabbit.yaml'));
  const crDiff = diff(expected, cr.skip);
  crDiff.extra.push(...cr.include.map((g) => `${g} (include filter, not a "!" skip path)`));
  return [
    { name: 'greptile (.greptile/config.json ignorePatterns)', ...diff(expected, parseGreptile(read(root, '.greptile/config.json'))) },
    { name: 'coderabbit (.coderabbit.yaml reviews.path_filters)', ...crDiff },
  ];
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

// Run main() when executed directly. Compare real paths: a plain path compare skips main() when the
// script is reached through a junction or symlink, and the ratchet would exit 0 without checking.
function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) main();
