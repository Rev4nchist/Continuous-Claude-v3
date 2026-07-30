#!/usr/bin/env node
/**
 * suite-shape-guard -- two shape assertions about the hook test suite, both by COUNT.
 *
 * A. NO MODULE-SCOPE ENTRYPOINT CALL. A hook ending in a bare `main();` at module
 *    scope runs main() on IMPORT. main() awaits stdin, so importing the module to
 *    unit-test its pure helpers blocks forever. That is the defect that made
 *    `npx vitest run` in .claude/hooks never return a verdict -- it was not slow,
 *    it hung, and it hid 93 real failures for a month (fixed 615eb80, 2026-07-29).
 *
 *    The fix per hook is a guard the harness still satisfies at runtime:
 *      if ((process.argv[1] || '').includes('<hook-name>')) { main(); }
 *    Registered hooks are invoked as `node .../dist/<hook-name>.mjs`, so argv[1]
 *    contains the hook name and the guard is a no-op in production.
 *
 * B. NO `node:test` IMPORTS IN TESTS. The suite runs on vitest. Three test files
 *    imported from `node:test`, so vitest never collected them -- 39 tests that
 *    looked present and had never run once. `tsx`, which would have run them, was
 *    never installed.
 *
 * WHY THE PATTERN IN (A) IS DELIBERATELY WIDE
 * -------------------------------------------
 * A precomputed audit of this exact defect reported 15 hooks. The real number was
 * 18. The three it missed -- handoff-index, pre-compact-continuity,
 * session-end-cleanup -- spell the same hazard `main().catch(console.error);`, and
 * the audit's pattern only admitted a bare `main();`. That is the third time in
 * this workstream a "verified" list turned out to be exactly as wide as the grep
 * behind it. So this guard matches ANY identifier called with no arguments at
 * column 0, optionally awaited/voided and optionally chained with .catch/.then --
 * not a hardcoded list of names, and not a hardcoded list of spellings.
 *
 * Consequence worth stating: (A) is a SHAPE check, not a proof that main() reads
 * stdin. A module-scope call in a hook that never touches stdin is harmless in
 * itself. It is still flagged, because the shape is one edit away from hanging the
 * suite again and the guard is one line.
 *
 * WHY BOTH ASSERT NONZERO SUBJECT COUNTS
 * --------------------------------------
 * The recurring defect in this repo is a green check whose subject count is zero:
 * an ESLint boundary linting zero files, `hook-registrations-valid` passing on 0
 * of 85 while 85 fired, a scheduled task exiting 0 after 28 straight failures.
 * So every "must be zero" below is paired with "and we actually looked at N
 * things". A scan that finds nothing to scan FAILS here rather than passing.
 *
 * USAGE
 *   node scripts/hooks/suite-shape-guard.mjs           # exit 1 on violation
 *   node scripts/hooks/suite-shape-guard.mjs --json
 *   node scripts/hooks/suite-shape-guard.mjs --list    # print offenders only
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SRC = join(REPO, '.claude', 'hooks', 'src');
const TESTS = join(SRC, '__tests__');

/** Minimum sources/tests we expect to find. Below this, the scan itself is broken. */
const MIN_HOOK_SOURCES = 80;
const MIN_TEST_FILES = 80;

/** Replace a multi-line match with blank lines so line numbers stay truthful. */
const blankOut = (m) => m.replace(/[^\n]/g, '');

/**
 * Strip comments and string/template literals so a call inside a doc block or an
 * example string is not counted. Crude but sufficient: we only need column-0
 * statement detection, and over-stripping cannot create a false positive.
 *
 * LINE COUNT IS PRESERVED. The first cut of this collapsed block comments to ''
 * and every reported line number was wrong by the size of the file's header --
 * it said agent-verification.ts:197 for a call on line 260. A guard that reports
 * a line the reader cannot find is worse than no line at all, because they go
 * looking for a second defect. Multi-line matches are blanked, not removed.
 */
function stripNonCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blankOut) // block comments
    .replace(/^([ \t]*)\/\/.*$/gm, '$1') // whole-line line comments
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, blankOut) // template literals (may span lines)
    // Quoted strings must NOT span lines. Without the \n exclusion, one unpaired
    // apostrophe -- `don't` inside a surviving regex literal is enough -- matches
    // greedily to the next apostrophe hundreds of lines later and eats every
    // newline between, which put task-router's offender at line 86 instead of 218.
    .replace(/'(?:\\.|[^\\'\n])*'/g, "''")
    .replace(/"(?:\\.|[^\\"\n])*"/g, '""');
}

/**
 * A module-scope, zero-argument call at column 0.
 *
 * Matches:  main();  await main();  void main();  main().catch(console.error);
 *           main().then(x)  run();  bootstrap();
 * Does NOT match a guarded call, because a guarded one is either indented inside
 * the if-block or preceded on its line by `if (`.
 */
const ENTRY_CALL = /^(?:await\s+|void\s+)?([A-Za-z_$][\w$]*)\(\s*\)\s*(?:\.(?:catch|then)\([^\n]*\))?\s*;?\s*$/;

/** Identifiers at column 0 that are never hook entrypoints. */
const NOT_ENTRYPOINTS = new Set(['export', 'return', 'break', 'continue', 'process']);

function findModuleScopeCalls() {
  if (!existsSync(SRC)) throw new Error(`hook source dir not found: ${SRC}`);
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
  const offenders = [];
  for (const file of files) {
    const raw = readFileSync(join(SRC, file), 'utf8');
    const lines = stripNonCode(raw).split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = ENTRY_CALL.exec(line);
      if (!m) return;
      if (NOT_ENTRYPOINTS.has(m[1])) return;
      offenders.push({ file, line: i + 1, fn: m[1], text: line.trim() });
    });
  }
  return { scanned: files.length, offenders };
}

/**
 * Strip ONLY comments, preserving string literals.
 *
 * Needed because this check looks FOR a string literal ('node:test'). The first
 * version of this guard reused stripNonCode(), which blanks quoted strings -- so
 * `from 'node:test'` became `from ''` and the check could never match anything.
 * It reported "0 node:test imports" on a file that had one. Caught only because
 * the acceptance criterion required reintroducing a violation on purpose; a guard
 * that has never been seen to fail is not yet a guard.
 */
function stripCommentsOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, blankOut).replace(/^([ \t]*)\/\/.*$/gm, '$1');
}

function findNodeTestImports() {
  if (!existsSync(TESTS)) throw new Error(`test dir not found: ${TESTS}`);
  const files = readdirSync(TESTS).filter((f) => f.endsWith('.ts'));
  const offenders = [];
  for (const file of files) {
    const src = stripCommentsOnly(readFileSync(join(TESTS, file), 'utf8'));
    if (/from\s*['"]node:test['"]|require\(\s*['"]node:test['"]\s*\)/.test(src)) {
      offenders.push({ file });
    }
  }
  return { scanned: files.length, offenders };
}

const calls = findModuleScopeCalls();
const nodeTest = findNodeTestImports();

const failures = [];
if (calls.scanned < MIN_HOOK_SOURCES) {
  failures.push(
    `VACUOUS SCAN: only ${calls.scanned} hook sources found under ${SRC} (expected >= ${MIN_HOOK_SOURCES}). ` +
      `The scan is broken, not the code.`
  );
}
if (nodeTest.scanned < MIN_TEST_FILES) {
  failures.push(
    `VACUOUS SCAN: only ${nodeTest.scanned} test files found under ${TESTS} (expected >= ${MIN_TEST_FILES}).`
  );
}
if (calls.offenders.length > 0) {
  failures.push(
    `${calls.offenders.length} hook source(s) call an entrypoint at module scope -- importing these hangs or ` +
      `side-effects the suite. Wrap with: if ((process.argv[1] || '').includes('<hook-name>')) { <fn>(); }\n` +
      calls.offenders.map((o) => `    ${o.file}:${o.line}  ${o.text}`).join('\n')
  );
}
if (nodeTest.offenders.length > 0) {
  failures.push(
    `${nodeTest.offenders.length} test file(s) import from node:test -- vitest will never collect them, so ` +
      `their tests silently do not run:\n` +
      nodeTest.offenders.map((o) => `    ${o.file}`).join('\n')
  );
}

const report = {
  guard: 'suite-shape-guard',
  hook_sources_scanned: calls.scanned,
  module_scope_entry_calls: calls.offenders.length,
  module_scope_offenders: calls.offenders,
  test_files_scanned: nodeTest.scanned,
  node_test_imports: nodeTest.offenders.length,
  node_test_offenders: nodeTest.offenders,
  pass: failures.length === 0,
  failures,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else if (process.argv.includes('--list')) {
  for (const o of calls.offenders) console.log(`${o.file}:${o.line}  ${o.text}`);
} else {
  console.log(
    `[suite-shape-guard] scanned ${calls.scanned} hook sources, ${nodeTest.scanned} test files`
  );
  console.log(
    `[suite-shape-guard] module-scope entry calls: ${calls.offenders.length} | node:test imports: ${nodeTest.offenders.length}`
  );
  if (failures.length === 0) {
    console.log('[suite-shape-guard] PASS');
  } else {
    for (const f of failures) console.error(`[suite-shape-guard] FAIL: ${f}`);
  }
}

process.exit(report.pass ? 0 : 1);
