// Tests for scripts/checks/parser-fixtures.mjs and its registry.
// Run: node --test scripts/checks/parser-fixtures.test.mjs
//
// The gate is only worth something if a property fails when the parser breaks. So most tests copy the real parser files to a temp
// tree, change one thing in the copy, and run the real fixtures against that tree (the `root` option). Ways the gate can fail:
//   a registry entry points at a file or export that is gone, or two entries share an id            -> F1  (rename an export)
//   the input taxonomy loses a class, or a selector returns no case                                  -> F2  (empty a generator)
//   selection ignores backslash paths, runs unrelated entries, or --all skips an entry              -> F3
//   the real parsers on the current tree fail a property (the gate is red on main)                   -> F4
//   a parser file missing from the root is a failure instead of a skip                              -> F5
//   a parser breaks and no property notices (one test per mutant, table MUTANTS below)              -> F6
//   a file that does not import passes, or an absent export is a failure instead of a skip              -> F7
//   a missing esbuild fails the .ts entries; a throwing property counts as a parser failure            -> F11, F12
//   brief.ts without an exported LIMITS gives property errors; parseArgs loses the facts key            -> F13, F14
//   a parser that throws on hostile input passes                                                     -> F8
//   the known-limit list rots: a cell stays listed after the scrubber is fixed                       -> F9  (fix POSIX_DEEP_PATH)
//   the CLI exits 0 on a failure, or reads the wrong tree, or accepts a bad option                   -> F10
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule, main, parseCli, runFixtures, selectEntries } from './parser-fixtures.mjs';
import { CLASSES, KNOWN_LIMITS, casesFor, scrubCases } from './parser-fixtures/inputs.mjs';
import { REGISTRY } from './parser-fixtures/registry.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAFE = 'apps/agentic-os/src/server/sources/safe-message.ts';
const BRIEF = '.claude/plugins/ccv3-mods/hooks/agentic-os/brief.ts';
const FILTER = 'scripts/github/review-filter.mjs';
const REVIEW = 'scripts/github/local-review.mjs';
const CONTEXT = 'scripts/github/local-review/context.mjs';

// ---------- a scratch copy of the parser files ----------

const COPY = ['scripts', 'apps/agentic-os/src/server/sources', '.claude/plugins/ccv3-mods/hooks'];
let tree;

function scratchTree() {
  if (tree) return tree;
  tree = mkdtempSync(path.join(os.tmpdir(), 'parser-fixtures-test-'));
  for (const dir of COPY) cpSync(path.join(REPO, dir), path.join(tree, dir), { recursive: true });
  return tree;
}

/** Runs fn with `file` in the scratch tree changed by find -> replace. The file is restored after. */
async function withMutant(file, find, replace, fn) {
  const target = path.join(scratchTree(), file);
  const original = readFileSync(target, 'utf8');
  assert.ok(original.includes(find), `the text to change is not in ${file}: ${find}`);
  writeFileSync(target, original.replace(find, () => replace));
  try { return await fn(); } finally { writeFileSync(target, original); }
}

const failingIds = (report) => report.results.filter((r) => r.failureCount > 0).map((r) => r.id);

test.after(() => { if (tree) rmSync(tree, { recursive: true, force: true }); });

// ---------- registry and inputs ----------

test('F1: every entry has a unique id, a repo file and an exported function, and a known kind', async () => {
  assert.equal(new Set(REGISTRY.map((e) => e.id)).size, REGISTRY.length, 'ids are unique');
  for (const e of REGISTRY) {
    assert.ok(['scrubber', 'sanitizer', 'classifier', 'parser'].includes(e.kind), `${e.id}: kind ${e.kind}`);
    assert.equal(typeof e.property, 'function', `${e.id}: property`);
    const mod = await loadModule(REPO, e.file);
    assert.equal(typeof mod[e.export], 'function', `${e.id}: ${e.file} must export ${e.export}`);
  }
});

test('F2: the taxonomy covers the four classes, every selector returns cases, and case ids are unique per selector', () => {
  const selectors = [...new Set(REGISTRY.flatMap((e) => e.inputs))];
  const classes = new Set(selectors.map((s) => s.split(':')[0]));
  for (const c of CLASSES) assert.ok(classes.has(c), `no registered entry uses the ${c} class`);
  for (const s of selectors) {
    const cases = casesFor(s);
    assert.ok(cases.length > 0, `${s} has no case`);
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, `${s} has a duplicate case id`);
    assert.ok(cases.every((c) => CLASSES.includes(c.cls)), `${s} has a case without a class`);
  }
  assert.throws(() => casesFor('nope'), /unknown input selector/);
});

// ---------- selection ----------

test('F3: selection takes entries by changed file (backslash and ./ forms too), none for an unrelated file, all with --all', () => {
  const ids = (o) => selectEntries(o).map((e) => e.id);
  assert.deepEqual(ids({ files: [FILTER] }), ['review-filter.parseHunks']);
  assert.deepEqual(ids({ files: ['scripts\\github\\review-filter.mjs'] }), ['review-filter.parseHunks']);
  assert.deepEqual(ids({ files: ['./scripts/github/review-filter.mjs'] }), ['review-filter.parseHunks']);
  assert.deepEqual(ids({ files: ['README.md', 'scripts/github/pre-pr.mjs'] }), []);
  assert.equal(ids({ files: [REVIEW] }).length, 2, 'two entries share local-review.mjs');
  assert.equal(selectEntries({ all: true }).length, REGISTRY.length);
});

// ---------- the real tree ----------

test('F4: every registered parser passes on the current tree', async () => {
  const report = await runFixtures({ root: REPO, all: true });
  assert.equal(report.results.length, REGISTRY.length);
  assert.equal(report.failed, 0, JSON.stringify(report.results.filter((r) => r.failureCount), null, 1).slice(0, 1500));
  assert.deepEqual(report.skipped, []);
});

test('F5: a parser file that is absent from the root is skipped and listed, not a failure', async () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'parser-fixtures-empty-'));
  try {
    const report = await runFixtures({ root: empty, files: [FILTER] });
    assert.equal(report.failed, 0);
    assert.deepEqual(report.results, []);
    assert.equal(report.skipped.length, 1);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

// ---------- each property catches a broken parser ----------

const MUTANTS = [
  ['parseHunks reads only "\\n" line ends', FILTER, String.raw`.split(/\r?\n/)`, ".split('\\n')", 'review-filter.parseHunks'],
  ['parseHunks ends a hunk at a line that looks like a header', FILTER, 'if (s.hunk && (s.ro > 0 || s.rn > 0)) hunkLine(s, line);', "if (s.hunk && !line.startsWith('--- ') && !line.startsWith('diff ')) hunkLine(s, line);", 'review-filter.parseHunks'],
  ['parseNameStatus reads only R as a rename', REVIEW, 'if (/^[RC]/.test(status))', 'if (/^R$/.test(status))', 'local-review.parseNameStatus'],
  ['parseNameStatus keeps rows with no file name', REVIEW, 'return out.filter((f) => f.filename);', 'return out;', 'local-review.parseNameStatus'],
  ['parseArgs accepts --pr 0', REVIEW, '|| Number(v) <= 0', '', 'local-review.parseArgs'],
  ['parsePathInstructions keeps the blank edge lines of a block', CONTEXT, String.raw`.join('\n').trim(), next: i`, String.raw`.join('\n'), next: i`, 'context.parsePathInstructions'],
  ['parsePathInstructions throws an unnamed Error', CONTEXT, 'path_instructions: unsupported line', 'unsupported line', 'context.parsePathInstructions'],
  ['parseFilePatterns defaults applyTo to *', CONTEXT, "applyTo: '**' });", "applyTo: '*' });", 'context.parseFilePatterns'],
  ['stripControl leaves bidi overrides', SAFE, String.raw`\u202A-\u202E`, '', 'safe-message.stripControl'],
  ['safeMessage redacts before it strips', SAFE, 'const redacted = redact(stripControl(raw.slice(0, 2000))).text;', 'const redacted = stripControl(redact(raw.slice(0, 2000)).text);', 'safe-message.safeMessage'],
  ['scrubPathsInText does not absorb the rest of a path with spaces', SAFE, 'function absorbPathTail(text: string): string {', 'function absorbPathTail(text: string): string {\n  return text;', 'safe-message.scrubPathsInText'],
  ['parseTurnEnd drops an action that also names waiting', BRIEF, "(LEAD_ITEM.test(whole) || BARE_WAIT.test(whole))", '(LEAD_ITEM.test(whole) || /waiting/i.test(whole))', 'brief.parseTurnEnd'],
  ['parseTurnEnd reads a Next steps block inside a code fence', BRIEF, 'else if (!fenced) out.push(line)', 'else out.push(line)', 'brief.parseTurnEnd'],
  ['parseTurnEnd leaves the stop clause in the goal', BRIEF, 'const goal = (clause ? body.slice(0, clause.index) : body).replace(', 'const goal = body.replace(', 'brief.parseTurnEnd'],
];

for (const [name, file, find, replace, id] of MUTANTS) {
  test(`F6: the fixtures fail when ${name}`, async () => {
    const report = await withMutant(file, find, replace, () => runFixtures({ root: scratchTree(), files: [file] }));
    assert.ok(failingIds(report).includes(id), `${id} did not fail; failing: ${failingIds(report).join(', ') || 'none'}`);
  });
}

test('F6: the unchanged scratch copy passes, so a mutant failure comes from the change', async () => {
  const report = await runFixtures({ root: scratchTree(), all: true });
  assert.equal(report.failed, 0);
});

// ---------- load failures and throws ----------

test('F7: a parser file that does not import is a failure; an export that is absent at that commit is skipped, not a failure', async () => {
  const absent = await withMutant(FILTER, 'export function parseHunks(', 'export function parseHunksRenamed(', () => runFixtures({ root: scratchTree(), files: [FILTER] }));
  assert.deepEqual(absent.results, []);
  assert.deepEqual(absent.skipped.map((k) => [k.id, k.reason]), [['review-filter.parseHunks', 'export absent']]);
  assert.equal(absent.failed, 0);
  const syntax = await withMutant(FILTER, 'export function parseHunks(', 'export function (', () => runFixtures({ root: scratchTree(), files: [FILTER] }));
  assert.match(syntax.results[0].failures[0].reason, /cannot import/);
  assert.ok(syntax.failed > 0);
  const ts = await withMutant(SAFE, 'export function stripControl(', 'export function stripControl2(', () => runFixtures({ root: scratchTree(), files: [SAFE] }));
  assert.deepEqual(ts.skipped.map((k) => [k.id, k.reason]), [['safe-message.stripControl', 'export absent']], 'a TypeScript export that is absent is skipped');
  assert.ok(!ts.results.some((r) => r.id === 'safe-message.stripControl'), 'the absent export has no result row');
  const tsSyntax = await withMutant(SAFE, 'export function stripControl(', 'export function (', () => runFixtures({ root: scratchTree(), files: [SAFE] }));
  assert.ok(tsSyntax.failed > 0 && tsSyntax.results.every((r) => /cannot import/.test(r.failures[0].reason)), 'a TypeScript file that does not bundle is a failure when esbuild is present');
});

test('F11: without esbuild the .ts entries are skipped with a reason and the .mjs entries still run (breaks if a missing esbuild counts as a parser failure)', async () => {
  const noEsbuild = () => { throw new Error('esbuild not found in test'); };
  const report = await runFixtures({ root: REPO, files: [SAFE, FILTER] }, { loadEsbuild: noEsbuild });
  assert.equal(report.failed, 0, JSON.stringify(report.results.filter((r) => r.failureCount)).slice(0, 400));
  assert.deepEqual(report.results.map((r) => r.id), ['review-filter.parseHunks']);
  const ids = report.skipped.map((k) => k.id).sort();
  assert.deepEqual(ids, REGISTRY.filter((e) => e.file === SAFE).map((e) => e.id).sort());
  assert.ok(report.skipped.every((k) => /esbuild not available/.test(k.reason) && /esbuild not found in test/.test(k.reason)), JSON.stringify(report.skipped[0]));
  const withIt = await runFixtures({ root: REPO, files: [SAFE] });
  assert.ok(withIt.results.length > 0 && withIt.skipped.length === 0, 'esbuild present: the .ts entries run');
});

test('F12: a property that throws is a property error, listed in errors and not counted as a parser failure (breaks if judge folds it into failures)', async () => {
  const entry = { id: 'x.parseHunks', file: FILTER, export: 'parseHunks', kind: 'parser', inputs: ['text'], property: () => { throw new TypeError('boom in property'); } };
  const report = await runFixtures({ root: REPO, files: [FILTER] }, { registry: [entry] });
  assert.equal(report.failed, 0);
  assert.equal(report.results[0].failureCount, 0);
  assert.ok(report.errors.length > 0 && report.errors.length <= 25);
  assert.match(report.errors[0].reason, /the property itself threw: boom in property/);
  assert.equal(report.errors[0].id, 'x.parseHunks');
  assert.equal(report.results[0].errorCount, casesFor('text').length);
});

test('F13: brief.ts without an exported LIMITS gives no property error and no failure (breaks if the property reads ctx.mod.LIMITS unguarded)', async () => {
  const report = await withMutant(BRIEF, 'export const LIMITS = {', 'const LIMITS = {', () => runFixtures({ root: scratchTree(), files: [BRIEF] }));
  assert.deepEqual(report.errors, []);
  assert.equal(report.failed, 0, JSON.stringify(report.results.filter((r) => r.failureCount).map((r) => r.failures[0])).slice(0, 400));
  assert.equal(report.results.length, 2);
});

test('F14: local-review.parseArgs may return facts, so --facts is a known key (breaks if KNOWN_ARGS loses facts)', async () => {
  const mod = await loadModule(REPO, REVIEW);
  const value = ['--pr', '1', '--facts', 'catchers.md'];
  const output = mod.parseArgs(value);
  assert.equal(output.facts, 'catchers.md');
  const entry = REGISTRY.find((e) => e.id === 'local-review.parseArgs');
  assert.equal(entry.property(mod.parseArgs, { value }, output, { threw: null, ms: 0, mod }), null);
});

test('F8: a parser that throws on a hostile input fails the entry', async () => {
  const report = await withMutant(REVIEW, "const t = String(text ?? '').split('\\0');", "const t = String(text ?? '').split('\\0');\n  if (t.length > 8) throw new RangeError('too many');", () => runFixtures({ root: scratchTree(), files: [REVIEW] }));
  const hit = report.results.find((r) => r.id === 'local-review.parseNameStatus');
  assert.ok(hit.failureCount > 0);
  assert.match(hit.failures[0].reason, /threw: too many/);
});

// ---------- known limits ----------

test('F9: every cell in KNOWN_LIMITS still leaks, so the list shrinks when the scrubber is fixed', async () => {
  const mod = await loadModule(REPO, SAFE);
  const skipped = new Set(scrubCases().map((c) => c.id));
  const limited = scrubCases({ includeLimits: true }).filter((c) => !skipped.has(c.id));
  assert.ok(limited.length > 0 && KNOWN_LIMITS.length > 0);
  const stillLeaks = (c) => c.secrets.some((s) => mod.scrubPathsInText(c.value).includes(s));
  const fixed = limited.filter((c) => !stillLeaks(c));
  assert.deepEqual(fixed.map((c) => c.id), [], 'these cells pass now: remove them from KNOWN_LIMITS');
});

// ---------- command line ----------

test('F10: the CLI exits 0 on a pass, 1 on a failure, 2 on bad usage, and reads the tree given by --root', async () => {
  const sink = () => { const out = []; return { out, fn: (s) => out.push(s) }; };
  const run = async (argv) => { const o = sink(); const e = sink(); const code = await main(argv, { stdout: o.fn, stderr: e.fn }); return { code, out: o.out.join('\n'), err: e.out.join('\n') }; };
  assert.equal((await run([FILTER])).code, 0);
  assert.equal((await run(['--files', `${FILTER},${CONTEXT}`])).code, 0);
  assert.equal((await run([])).code, 2);
  assert.equal((await run(['--bogus'])).code, 2);
  assert.equal((await run(['--root'])).code, 2);
  const bad = await withMutant(FILTER, String.raw`.split(/\r?\n/)`, ".split('\\n')", () => run(['--root', scratchTree(), FILTER]));
  assert.equal(bad.code, 1);
  assert.match(bad.out, /FAIL review-filter\.parseHunks/);
  const json = await run(['--json', FILTER]);
  assert.equal(JSON.parse(json.out).failed, 0);
  assert.deepEqual(parseCli(['a.mjs', '--files', 'b.mjs,c.mjs']).files, ['a.mjs', 'b.mjs', 'c.mjs']);
});
