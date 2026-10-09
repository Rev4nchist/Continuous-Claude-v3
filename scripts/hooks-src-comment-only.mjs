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
 * Not every comment is ignorable. esbuild keeps legal notices and acts on annotations
 * (`@__PURE__`, `@__NO_SIDE_EFFECTS__`), source-map and JSX pragmas, so those must match exactly,
 * whole text and position. The `#!` line is copied into the bundle, so it must match too.
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

// Comments esbuild keeps or acts on: legal notices, tree-shaking annotations, source-map and JSX
// pragmas. Any comment matching this is compared exactly; every other comment is ignorable.
const MEANINGFUL = /^\/\*!|^\/\/!|@license|@preserve|__PURE__|__NO_SIDE_EFFECTS__|__KEY__|sourceMappingURL|sourceURL|@jsx/;

/**
 * What the bundle can depend on, as text:
 * - tree: every node's kind with its nesting, and each leaf token's text. Trivia (whitespace,
 *   newlines, comments) is not part of the tree and JSDoc nodes are skipped, so layout and comments
 *   drop out. Structure stays: `return\nx` (two statements, by ASI) and `return x` differ.
 * - notes: every meaningful comment, whole text, tagged with the index of the token it precedes, so
 *   adding, editing or moving an annotation or a legal notice is a change.
 * - shebang: the `#!` first line.
 * The TypeScript printer is not used: it keeps whether a block was written on one line or several.
 */
function fingerprint(ts, text) {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const isJsDoc = (n) => n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;
  const tree = [];
  const notes = [];
  let leaf = 0;
  const walk = (n) => {
    if (isJsDoc(n)) return;
    const kids = n.getChildren(sf);
    if (kids.length === 0) {
      // TypeScript splits the trivia between tokens: a comment on the same line as the token
      // before it is that token's trailing comment (`= /* @__PURE__ */ f()`), and one after a line
      // break is the next token's leading comment. Read both, so none is missed or counted twice.
      const tag = (ranges, where) => {
        for (const r of ranges ?? []) {
          const c = text.slice(r.pos, r.end);
          if (MEANINGFUL.test(c)) notes.push(`${leaf}${where}:${c}`);
        }
      };
      tag(ts.getLeadingCommentRanges(text, n.pos), 'L');
      tag(ts.getTrailingCommentRanges(text, n.end), 'T');
      if (n.kind !== ts.SyntaxKind.EndOfFileToken) tree.push(`${n.kind}:${n.getText(sf)}`);
      leaf++;
      return;
    }
    tree.push(`(${n.kind}`);
    for (const k of kids) walk(k);
    tree.push(')');
  };
  walk(sf);
  const shebang = text.startsWith('#!') ? text.split(/\r?\n/, 1)[0] : '';
  return JSON.stringify({ shebang, tree, notes });
}

/** True when `after` differs from `before` only in ordinary comments or whitespace. */
function isCommentOnlyChange(ts, before, after) {
  return fingerprint(ts, before) === fingerprint(ts, after);
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
