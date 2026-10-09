#!/usr/bin/env node
/**
 * hooks-src-comment-only.mjs - is every staged hook source change comment- or whitespace-only?
 *
 * Used by scripts/precommit-build-guard.sh. esbuild drops ordinary comments, so a change that only
 * touches comments or whitespace cannot change .claude/hooks/dist and needs no rebuilt dist staged.
 *
 * For each path: parse the HEAD version and the staged (index) version with TypeScript and compare
 * their syntax trees without comments or layout. A parser is used, not a token scan: a scanner
 * alone can read `//` inside a regex as a comment and hide a real code change after it.
 * Legal comments (`/*!`, `//!`, @license, @preserve) survive bundling, so any change to a line that
 * holds one counts as a real change.
 *
 * Usage: node scripts/hooks-src-comment-only.mjs <repo-relative .ts path>...   (run in the repo)
 * Exit 0 = every path is comment/whitespace-only. 1 = at least one is not (or is new). 2 = could not
 * tell (no TypeScript, git error). The guard treats anything but 0 as "keep the block".
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadTypeScript() {
  // TypeScript lives in .claude/hooks/node_modules of the repo that holds this script.
  return require(require.resolve('typescript', { paths: [join(here, '..', '.claude', 'hooks')] }));
}

const LEGAL = /\/\*!|\/\/!|@license|@preserve/;

/**
 * The syntax tree as text: every node's kind with its nesting, and each leaf token's text.
 * Trivia (whitespace, newlines, // and /* comments) is not part of the tree, and JSDoc nodes are
 * skipped, so layout and comments drop out. Structure stays: `return\nx` (two statements, by ASI)
 * and `return x` (one statement) give different text, though their leaf tokens are the same.
 * The TypeScript printer is not used: it keeps whether a block was written on one line or several.
 */
function codeWithoutComments(ts, text, fileName = 'x.ts') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const isJsDoc = (n) => n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;
  const out = [];
  const walk = (n) => {
    if (isJsDoc(n)) return;
    const kids = n.getChildren(sf);
    if (kids.length === 0) {
      if (n.kind !== ts.SyntaxKind.EndOfFileToken) out.push(`${n.kind}:${n.getText(sf)}`);
      return;
    }
    out.push(`(${n.kind}`);
    for (const k of kids) walk(k);
    out.push(')');
  };
  walk(sf);
  return out.join('\n');
}

/** Lines that carry a legal comment marker; esbuild keeps those comments in the bundle. */
function legalLines(text) {
  return text.split(/\r?\n/).filter((l) => LEGAL.test(l)).map((l) => l.trim()).join('\n');
}

/** True when `after` differs from `before` only in ordinary comments or whitespace. */
function isCommentOnlyChange(ts, before, after) {
  return codeWithoutComments(ts, before) === codeWithoutComments(ts, after) && legalLines(before) === legalLines(after);
}

function gitShow(spec) {
  return execFileSync('git', ['show', spec], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

function main(paths) {
  if (paths.length === 0) return 1;
  let ts;
  try { ts = loadTypeScript(); } catch { return 2; }
  for (const p of paths) {
    let before;
    let after;
    try { before = gitShow(`HEAD:${p}`); } catch { return 1; } // new or renamed file: a real change
    try { after = gitShow(`:${p}`); } catch { return 2; }
    if (!isCommentOnlyChange(ts, before, after)) return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
