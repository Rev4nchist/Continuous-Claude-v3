// Tests for catchers-eval.mjs (the table logic of the catchers measurement). Every test names the source change that would break it.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REGISTRY } from '../../checks/parser-fixtures/registry.mjs';
import {
  FIXED_ROWS, cleanRows, errorRow, evaluateRow, judgeRow, main, parseCli, reasonsOf, renderMd, totalsOf,
} from './catchers-eval.mjs';

const ROW = { id: 'R1', group: 'target', pr: 1, base: 'aaaaaaaa', head: 'bbbbbbbb', expected: 'FAIL', targetFile: 'scripts/a.mjs' };
const result = (over = {}) => ({
  files: ['scripts/a.mjs'], gateFailed: false, errors: [], mappedTests: [{ id: 't1' }],
  smoke: { failed: 0, checked: 2, timeouts: 0, results: [] }, fixtures: { failed: 0, results: [], skipped: [], errors: [] }, typecheck: { errors: [], skipped: null }, ...over,
});
const smokeOf = (file, reason = 'uncaught error with a stack frame', stderr = []) => ({
  failed: 1, checked: 2, timeouts: 0,
  results: [{ path: file, verdict: 'FAIL', runs: [{ args: ['--help'], verdict: 'FAIL', reason, stderr }] }],
});
const smokeFail = smokeOf('scripts/a.mjs');
const fixtureOf = (file, failures, id = 'safe-message') => ({ failed: failures.length, skipped: [], errors: [], results: [{ id, file, failureCount: failures.length, failures }] });

test('judgeRow matches only when the gate verdict equals the expected verdict (breaks if match compares something else, like the exit code)', () => {
  assert.equal(judgeRow(ROW, result({ gateFailed: true, smoke: smokeFail })).match, true);
  assert.equal(judgeRow(ROW, result()).match, false);
  assert.equal(judgeRow({ ...ROW, expected: 'PASS' }, result()).match, true);
  assert.equal(judgeRow({ ...ROW, expected: 'PASS' }, result({ gateFailed: true, smoke: smokeFail })).match, false);
});

test('a target row matches only when the failing smoke script or fixture entry is the target file (breaks if any gate failure counts)', () => {
  const other = judgeRow(ROW, result({ gateFailed: true, smoke: smokeOf('scripts/other.mjs') }));
  assert.deepEqual([other.actual, other.match], ['FAIL(other)', false]);
  const hit = judgeRow(ROW, result({ gateFailed: true, smoke: smokeOf('scripts/a.mjs', 'ENOENT or EISDIR on a path built from argv') }));
  assert.deepEqual([hit.actual, hit.match], ['FAIL', true]);
  const ts = { ...ROW, targetFile: 'apps/x/safe.ts' };
  const wrongFile = judgeRow(ts, result({ gateFailed: true, fixtures: fixtureOf('apps/x/other.ts', [{ input: 'a', reason: 'leak' }]) }));
  assert.equal(wrongFile.actual, 'FAIL(other)');
  const rightFile = judgeRow(ts, result({ gateFailed: true, fixtures: fixtureOf('apps/x/safe.ts', [{ input: 'a', reason: 'output still holds path text' }]) }));
  assert.deepEqual([rightFile.actual, rightFile.match], ['FAIL', true]);
});

test('an import failure or a module-not-found at the target is FAIL(other), not a catch (breaks if import and export reasons count as a property catch)', () => {
  const ts = { ...ROW, targetFile: 'apps/x/safe.ts' };
  const imp = judgeRow(ts, result({ gateFailed: true, fixtures: fixtureOf('apps/x/safe.ts', [{ input: '(import)', reason: 'cannot import apps/x/safe.ts: bad' }]) }));
  assert.deepEqual([imp.actual, imp.match], ['FAIL(other)', false]);
  const exp = judgeRow(ts, result({ gateFailed: true, fixtures: fixtureOf('apps/x/safe.ts', [{ input: '(export)', reason: 'does not export' }]) }));
  assert.equal(exp.actual, 'FAIL(other)');
  const mixed = judgeRow(ts, result({ gateFailed: true, fixtures: fixtureOf('apps/x/safe.ts', [{ input: '(import)', reason: 'x' }, { input: 'a', reason: 'leak' }]) }));
  assert.equal(mixed.actual, 'FAIL', 'one real property failure is enough');
  const nf = judgeRow(ROW, result({ gateFailed: true, smoke: smokeOf('scripts/a.mjs', 'uncaught error with a stack frame', ["Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/x/lib.mjs'"]) }));
  assert.deepEqual([nf.actual, nf.match], ['FAIL(other)', false]);
});

test('a row with catcher tool errors is ERROR and never matches, even when the gate failed as expected (breaks if errors are read as a verdict)', () => {
  const got = judgeRow(ROW, result({ gateFailed: true, smoke: smokeFail, errors: ['parser-fixtures crashed: esbuild'] }));
  assert.deepEqual([got.actual, got.match], ['ERROR', false]);
  assert.deepEqual(got.toolErrors, ['parser-fixtures crashed: esbuild']);
  const pass = judgeRow({ ...ROW, expected: 'PASS' }, result({ errors: ['cli-smoke crashed: x'] }));
  assert.deepEqual([pass.actual, pass.match], ['ERROR', false]);
});

test('judgeRow counts the tsc errors and keeps the smoke, fixture and timeout counts per row (breaks if a count reads the wrong list)', () => {
  const fx = { failed: 2, results: [{ id: 'a', file: 'x.ts', failureCount: 2, failures: [] }, { id: 'b', file: 'y.ts', failureCount: 0, failures: [] }], skipped: [{ id: 'c', reason: 'export absent' }], errors: [{ id: 'a', input: 'i', reason: 'r' }] };
  const got = judgeRow(ROW, result({ typecheck: { errors: [{}, {}, {}], skipped: null }, fixtures: fx, smoke: { failed: 0, checked: 5, timeouts: 2, results: [] } }));
  assert.deepEqual([got.tscErrors, got.smokeChecked, got.fixtureFailed, got.mappedTests], [3, 5, 2, ['t1']]);
  assert.deepEqual([got.fixturesRun, got.fixturesSkipped, got.smokeTimeouts, got.fixturePropertyErrors], [2, 1, 2, 1]);
  assert.deepEqual(got.fixtureIds, ['a', 'b']);
});

test('reasonsOf names the failing script with its args and the failing parser (breaks if a failing catcher gives no reason line)', () => {
  const fx = { failed: 1, results: [{ id: 'safe-message', file: 'x.ts', failureCount: 1, failures: [{ input: 'a\nb', reason: 'wrong' }] }, { id: 'ok', file: 'y.ts', failureCount: 0, failures: [] }] };
  const got = reasonsOf(result({ gateFailed: true, smoke: smokeFail, fixtures: fx }));
  assert.equal(got.length, 2);
  assert.match(got[0], /cli-smoke: scripts\/a\.mjs --help: uncaught error/);
  assert.match(got[1], /parser-fixtures: safe-message \(x\.ts\): 1 failure/);
});

test('errorRow never matches, even for an expected PASS (breaks if a row that could not run counts as a pass)', () => {
  const got = errorRow({ ...ROW, expected: 'PASS' }, 'boom');
  assert.deepEqual([got.actual, got.match], ['ERROR', false]);
  assert.deepEqual(got.reasons, ['boom']);
});

test('cleanRows takes mergeBase before pullBaseSha and flags a missing head or base (breaks if the base choice flips or a bad record is dropped)', () => {
  const recs = { A: { head: 'h1', mergeBase: 'm1', pullBaseSha: 'p1' }, B: { head: 'h2', pullBaseSha: 'p2' }, C: { head: 'h3' }, D: {} };
  const rows = cleanRows((id) => recs[id], { A: 1, B: 2, C: 3, D: 4 });
  assert.deepEqual(rows.map((r) => [r.id, r.base, r.head]), [['A-clean', 'm1', 'h1'], ['B-clean', 'p2', 'h2'], ['C-clean', null, 'h3'], ['D-clean', null, null]]);
  assert.deepEqual(rows.map((r) => Boolean(r.problem)), [false, false, true, true]);
  assert.ok(rows.every((r) => r.group === 'clean' && r.expected === 'PASS'));
});

test('cleanRows turns an unreadable record into a row with a problem instead of throwing (breaks if one bad file stops the whole table)', () => {
  const rows = cleanRows(() => { throw new Error('ENOENT: no such file'); }, { A: 1 });
  assert.match(rows[0].problem, /record A unreadable: ENOENT/);
});

test('FIXED_ROWS: each target row names its target file, PR 200 post-fix is the final head 5f491a64, and every row has a range (breaks if the head or a target file changes)', () => {
  const by = Object.fromEntries(FIXED_ROWS.map((r) => [r.id, r]));
  assert.equal(by['PR211-pre'].targetFile, 'scripts/settings/remove-maestro-registrations.mjs');
  assert.equal(by['PR200-pre'].targetFile, 'apps/agentic-os/src/server/sources/safe-message.ts');
  assert.equal(by['PR222-pre'].targetFile, '.claude/plugins/ccv3-mods/hooks/agentic-os/brief.ts');
  assert.equal(by['PR200-merged'].head, '5f491a64');
  assert.equal(by['PR200-merged'].expected, 'FAIL');
  assert.equal(by['PR200-post'].head, '34701f70');
  assert.ok(FIXED_ROWS.filter((r) => r.group === 'target').every((r) => r.targetFile));
  assert.ok(FIXED_ROWS.every((r) => r.base && r.head && ['PASS', 'FAIL'].includes(r.expected)));
});

const mk = (id, group, expected, actual, extra = {}) => ({
  id, group, expected, actual, match: actual === expected, tscErrors: 0, toolErrors: [], smokeChecked: 0, smokeTimeouts: 0, fixtureIds: [], fixturesRun: 0, fixturesSkipped: 0, ...extra,
});

test('totalsOf counts each group by its own verdict and sums tsc errors for the clean rows only (breaks if groups mix or an ERROR row counts as PASS)', () => {
  const rows = [
    mk('t1', 'target', 'FAIL', 'FAIL', { tscErrors: 9 }), mk('t2', 'target', 'FAIL', 'PASS'), mk('t3', 'target', 'FAIL', 'FAIL(other)'), mk('p1', 'post-fix', 'PASS', 'PASS'), mk('p2', 'post-fix', 'PASS', 'ERROR'),
    mk('c1-clean', 'clean', 'PASS', 'PASS', { tscErrors: 2 }), mk('c2-clean', 'clean', 'PASS', 'FAIL', { tscErrors: 3, toolErrors: ['x'] }), mk('c3-clean', 'clean', 'PASS', 'ERROR'),
  ];
  const t = totalsOf(rows);
  assert.deepEqual(t.targetFail, { count: 1, of: 3 });
  assert.deepEqual(t.postFixPass, { count: 1, of: 2 });
  assert.deepEqual(t.cleanFailures, { count: 1, of: 3 });
  assert.equal(t.cleanErrors, 1);
  assert.deepEqual(t.cleanTscErrors, { 'c1-clean': 2, 'c2-clean': 3, 'c3-clean': 0 });
  assert.equal(t.cleanTscTotal, 5);
  assert.deepEqual(t.toolErrorRows, ['c2-clean']);
  assert.deepEqual(t.mismatches, ['t2', 't3', 'p2', 'c2-clean', 'c3-clean']);
});

test('totalsOf counts, for the clean rows, how many ran each registry id and how many ran smoke (breaks if a skipped or errored row counts as a run)', () => {
  const rows = [
    mk('c1-clean', 'clean', 'PASS', 'PASS', { smokeChecked: 2, fixtureIds: ['brief.parseTurnEnd', 'review-filter.parseHunks'] }),
    mk('c2-clean', 'clean', 'PASS', 'PASS', { smokeChecked: 0, fixtureIds: ['brief.parseTurnEnd'] }),
    mk('c3-clean', 'clean', 'PASS', 'ERROR', { smokeChecked: 4, fixtureIds: ['brief.parseTurnEnd'] }),
    mk('t1', 'target', 'FAIL', 'FAIL', { smokeChecked: 1, fixtureIds: ['brief.parseTurnEnd'] }),
  ];
  const t = totalsOf(rows);
  assert.equal(t.cleanSmokeRows, 1);
  assert.equal(t.cleanRowsTotal, 3);
  assert.equal(t.cleanFixtureCoverage['brief.parseTurnEnd'], 2);
  assert.equal(t.cleanFixtureCoverage['review-filter.parseHunks'], 1);
  assert.equal(t.cleanFixtureCoverage['safe-message.scrubPaths'], 0, 'every registry id is listed, also with 0');
  assert.deepEqual(Object.keys(t.cleanFixtureCoverage).sort(), REGISTRY.map((e) => e.id).sort());
});

test('renderMd shows every row with failed/run counts, marks a mismatch, escapes a pipe, and has a Provenance section (breaks if a row is dropped, a pipe splits the table or the section goes)', () => {
  const rows = [judgeRow(ROW, result({ gateFailed: true, smoke: smokeFail, fixtures: { failed: 0, results: [{ id: 'a', file: 'x', failureCount: 0, failures: [] }], skipped: [{ id: 's', reason: 'r' }], errors: [] } })), { ...judgeRow({ ...ROW, id: 'R2' }, result()), reasons: ['a|b'] }];
  const md = renderMd(rows, totalsOf(rows), { ts: 'T', sha: 'S' });
  assert.match(md, /\| R1 \| target \| 1 \| aaaaaaaa\.\.bbbbbbbb \| FAIL \| FAIL \| yes \| 1\/2 \| 0\/1 \(1 skipped\) \|/);
  assert.match(md, /\| R2 \|.*\| NO \|/);
  assert.match(md, /a\\\|b/);
  assert.match(md, /Mismatched rows: R2/);
  assert.match(md, /## Provenance/);
  assert.match(md, /regression evidence, not out-of-sample holdout evidence/);
  assert.match(md, /PR 211 smoke catch is general/);
  assert.match(md, /root=data.*apostrophe.*dquote.*unicode/);
  assert.match(md, /5f491a64/);
  assert.match(md, /PR200-merged uses 5f491a64/);
  assert.match(md, /PR200-post is 34701f70/);
  assert.match(md, /Clean rows that ran smoke: /);
});

test('evaluateRow cleans the temp tree when the catchers throw, and returns an ERROR row (breaks if cleanup moves out of finally)', async () => {
  let cleaned = 0;
  const deps = {
    gitOut: () => 'abc\n', extract: () => ({ dir: '/t', cleanup: () => { cleaned += 1; } }),
    run: async () => { throw new Error('catchers broke'); },
  };
  const got = await evaluateRow(ROW, deps);
  assert.equal(cleaned, 1);
  assert.deepEqual([got.actual, got.match], ['ERROR', false]);
  assert.match(got.reasons[0], /catchers broke/);
});

test('evaluateRow runs the catchers on the extracted tree with the merge-base diff and then cleans up (breaks if root or diff is wrong)', async () => {
  const calls = [];
  const deps = {
    gitOut: (_r, args) => { calls.push(args); return args[0] === 'diff' ? 'DIFF' : `${args[0]}-out\n`; },
    extract: () => ({ dir: '/tree', cleanup: () => calls.push(['cleanup']) }),
    run: async (input) => { calls.push(['run', input]); return result({ gateFailed: true, smoke: smokeFail }); },
  };
  const got = await evaluateRow(ROW, deps);
  assert.deepEqual(calls.find((c) => c[0] === 'run')[1], { root: '/tree', diffText: 'DIFF' });
  assert.deepEqual(calls.find((c) => c[0] === 'diff').slice(-2), ['merge-base-out', 'rev-parse-out']);
  assert.equal(calls.at(-1)[0], 'cleanup');
  assert.equal(got.match, true);
});

test('evaluateRow does not extract a row that has a problem (breaks if a bad record still runs against a null head)', async () => {
  const got = await evaluateRow({ ...ROW, head: null, problem: 'no head' }, { extract: () => { throw new Error('must not run'); } });
  assert.equal(got.actual, 'ERROR');
});

test('parseCli rejects an unknown flag and a flag without a value, and reads --run and --help (breaks if a typo is ignored or --run is dropped)', () => {
  assert.match(parseCli(['--nope']).error, /unknown argument/);
  assert.match(parseCli(['--out']).error, /needs a value/);
  assert.equal(parseCli(['--only', 'a,b', '--list']).only, 'a,b');
  assert.equal(parseCli(['--run']).run, true);
  assert.equal(parseCli([]).run, false);
  assert.equal(parseCli(['--help']).help, true);
});

// ---------- main: the smoke gate runs this file with no arguments and with --help ----------

const sink = () => { const out = []; return { out, fn: (s) => out.push(s) }; };
const failingDeps = { run: async () => { throw new Error('the eval must not run'); }, extract: () => { throw new Error('the eval must not run'); }, gitOut: () => { throw new Error('the eval must not run'); } };

test('main with no arguments prints usage and exits 2 without running the eval; --help exits 0 (breaks if a bare run starts the eval)', async () => {
  const o = sink();
  const code = await main([], { stdout: o.fn, rows: [ROW], ...failingDeps });
  assert.equal(code, 2);
  assert.match(o.out.join('\n'), /usage: .*--run/);
  const h = sink();
  assert.equal(await main(['--help'], { stdout: h.fn, rows: [ROW], ...failingDeps }), 0);
  assert.match(h.out.join('\n'), /usage: /);
});

test('main with --only that matches no row exits 2 (breaks if an empty selection passes)', async () => {
  const o = sink();
  assert.equal(await main(['--run', '--only', 'nope'], { stdout: o.fn, rows: [ROW], ...failingDeps }), 2);
  assert.equal(await main(['--only', 'nope', '--list'], { stdout: o.fn, rows: [ROW], ...failingDeps }), 2);
});

test('main --run writes the json and md, exits 0 when every row matches, and exits 1 when a row has a catcher tool error (breaks if ERROR rows exit 0)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'catchers-eval-test-'));
  try {
    const deps = (res) => ({ stdout: () => {}, rows: [ROW, { ...ROW, id: 'R2', group: 'post-fix', expected: 'PASS' }], gitOut: () => 'abc\n', extract: () => ({ dir: '/t', cleanup: () => {} }), run: async (input) => res(input) });
    const prefix = path.join(dir, 'out', 'e');
    const good = await main(['--run', '--out', prefix], deps(() => result({ gateFailed: true, smoke: smokeFail })));
    assert.equal(good, 1, 'R2 expects PASS but the gate failed');
    assert.ok(existsSync(`${prefix}.json`) && existsSync(`${prefix}.md`));
    assert.match(readFileSync(`${prefix}.md`, 'utf8'), /Provenance/);
    const ok = await main(['--run', '--out', prefix], { ...deps(() => result()), rows: [{ ...ROW, expected: 'PASS', group: 'post-fix' }] });
    assert.equal(ok, 0);
    const errs = await main(['--run', '--out', prefix], { ...deps(() => result({ errors: ['cli-smoke crashed: x'] })), rows: [{ ...ROW, expected: 'PASS', group: 'post-fix' }] });
    assert.equal(errs, 1);
    assert.equal(JSON.parse(readFileSync(`${prefix}.json`, 'utf8')).rows[0].actual, 'ERROR');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
