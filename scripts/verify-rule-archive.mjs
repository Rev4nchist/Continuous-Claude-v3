#!/usr/bin/env node
/**
 * Verify that every archived rule snapshot is byte-identical to the rule it archives.
 *
 * WHY THIS EXISTS
 * The context lever moves detail out of always-on rules and into skills/docs, appending
 * the FULL pre-split rule under an <!-- archived-rule:NAME --> marker. The whole value of
 * that choice over editorial summarising is that "nothing was lost" becomes checkable by a
 * machine instead of asserted by a human. Unchecked, it is just a claim -- and it was
 * already false once: the six splits applied 2026-07-29 rewrote inner ``` fences as ` ` `
 * so they would not close the outer 3-backtick fence, silently mutating exactly the code
 * blocks a reader most wants to copy. Snapshots written after that use a 4-backtick fence.
 *
 * USAGE
 *   node scripts/verify-rule-archive.mjs [--ref <git-ref>] [--rules-dir <path>]
 *
 * Discovers every archived-rule marker under .claude/skills and docs, then compares each
 * fenced snapshot against that rule's text AT <git-ref> -- i.e. before the split. Default
 * ref is HEAD~1, which is right immediately after committing a split.
 *
 * EXIT CODES
 *   0  every discovered snapshot matched
 *   1  at least one snapshot differs from the rule it claims to archive
 *   2  bad invocation
 *
 * A rule that does not exist at the given ref is reported SKIP, not FAIL: snapshots taken
 * in different commits need their own ref, and silently passing them would be the vacuous
 * -gate failure mode (a green verdict over an empty set).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i === -1 ? dflt : argv[i + 1];
};
const REF = argOf('--ref', 'HEAD~1');
const RULES_DIR = argOf('--rules-dir', '.claude/rules-src');
const ROOT = process.cwd();

const MARKER = /<!--\s*archived-rule:([^\s>]+?)\s*-->/g;

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'cache') continue;
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (e.endsWith('.md')) out.push(p);
  }
  return out;
}

function ruleAtRef(name) {
  try {
    return execFileSync('git', ['show', `${REF}:${RULES_DIR}/${name}`], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 8,
    });
  } catch {
    return null;
  }
}

const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\n+$/, '');

let pass = 0, fail = 0, skip = 0;

for (const file of [...walk(join(ROOT, '.claude', 'skills')), ...walk(join(ROOT, 'docs'))]) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  MARKER.lastIndex = 0;
  let m;
  while ((m = MARKER.exec(text)) !== null) {
    const name = m[1];
    const where = relative(ROOT, file).replace(/\\/g, '/');
    const original = ruleAtRef(name);
    if (original === null) {
      console.log(`SKIP  ${name} <- ${where} (not present at ${REF})`);
      skip++;
      continue;
    }
    // Longest-fence-first: a 4-backtick fence can legitimately contain ``` blocks.
    const after = text.slice(m.index);
    const fence = after.match(/\n(`{4,})[a-z]*\n([\s\S]*?)\n\1(?:\n|$)/)
               || after.match(/\n(`{3})[a-z]*\n([\s\S]*?)\n\1(?:\n|$)/);
    if (!fence) {
      console.error(`FAIL  ${name} <- ${where}: marker present but no fenced snapshot follows`);
      fail++;
      continue;
    }
    const archived = norm(fence[2]);
    const expected = norm(original);
    if (archived === expected) {
      console.log(`PASS  ${name} <- ${where} (${Buffer.byteLength(expected)} bytes)`);
      pass++;
      continue;
    }
    const a = archived.split('\n'), b = expected.split('\n');
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
    console.error(`FAIL  ${name} <- ${where}: differs at line ${i + 1} of ${b.length}`);
    console.error(`        rule@${REF}: ${JSON.stringify(b[i] ?? '<eof>')}`);
    console.error(`        archived:    ${JSON.stringify(a[i] ?? '<eof>')}`);
    fail++;
  }
}

console.log(`\nRESULT ref=${REF} pass=${pass} fail=${fail} skip=${skip}`);
if (pass + fail === 0) {
  console.error('No snapshot was actually compared -- a green verdict here would be vacuous.');
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
