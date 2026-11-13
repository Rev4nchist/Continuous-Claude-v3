// Tests for scripts/eval/review-eval/escape-causes.mjs: the cause classes and the weekly report.
// Run: node --test scripts/eval/review-eval/escape-causes.test.mjs
//
// Failure modes and the change that would break each test:
//   E1  a rule does not give its class, or two classes swap                -> drop or reorder a rule in classifyCause
//   E2  an earlier rule does not win over a later one (first match wins)    -> reorder the rules
//   E3  a fix with no blamed files is called wrong-surfaces (a guess)       -> drop the "blamedFiles is empty" skip in rule 1
//   E4  rule 1 counts a gate that is not a test gate                        -> drop the node --test / hooks-build / hooks-vitest filter
//   E5  nothing matches and the row is not 'unclassified'                   -> add a default class
//   E6  an empty fix file list counts as "every file is rule text"          -> drop the length check in rule 2
//   E7  rule 1 reads a stale gatesFor instead of the injected one           -> import gatesFor and ignore the argument
//   E8  the real gatesFor of pre-pr.mjs is not the default                  -> change the default argument
//   E9  the report hides a class with zero rows, or divides by zero         -> print only the classes seen, or drop the n/a branch
//   E10 the reviewer-fixable share counts another class                     -> change REVIEWER_FIXABLE
//   E11 the no-target count is lost, or in-PR-only fixes are added to it    -> change report()
//   E12 the CLI fails on a missing file, writes the file, or reads the wrong dir -> change main() or stateDirOf
//   E13 the CLI --since keeps old rows, or a damaged line crashes it        -> change the filter or the line parser
//   E15 a multi-PR row is called merge-interaction (blame of a rewritten block spans PRs by nature) -> add a blamedPrCount rule
//   E16 the primary flag is ignored, or the all-rows line or the rule-of-thumb wording is missing -> change report()
//   E17 a capitalised Mock file is not a mock                               -> drop toLowerCase in the mock rule
//   E18 the share loses a caveat line, changes its wording or order, or keeps path-only rows in the third share -> change shareLines()
//   E19 --from-json with no rows array reads the state dir instead of failing -> change the rows fallback in main()
//   E14 --help is an error                                                 -> change main()
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { CAUSES, REVIEWER_FIXABLE, classifyCause, main, report, stateDirOf } from './escape-causes.mjs';

const made = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'escape-causes-')); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const T = (id) => ({ id, cmd: 'node', args: ['--test', 'x'] });
// A fake gate table: a file under h/ needs hooks-vitest, under s/ needs s-tests, under a/ needs a plain audit script.
const gatesFor = (files) => files.flatMap((f) => {
  if (f.startsWith('h/')) return [{ id: 'hooks-vitest', cmd: 'npx', args: ['vitest'] }];
  if (f.startsWith('s/')) return [T('s-tests')];
  if (f.startsWith('a/')) return [{ id: 'audit', cmd: 'node', args: ['audit.mjs'] }];
  return [];
});
const base = { fixFiles: ['docs/plain.mjs'], blamedFiles: ['docs/other.mjs'], blamedPrCount: 1, linkedFinding: undefined, gatesFor };
const cls = (over) => classifyCause({ ...base, ...over });

test('E1: each rule gives its own class (breaks if a rule is dropped)', () => {
  assert.equal(cls({ fixFiles: ['h/x.ts'], blamedFiles: ['s/y.mjs'] }), 'wrong-surfaces');
  assert.equal(cls({ fixFiles: ['.claude/rules-src/a.md'] }), 'no-behaviour-check');
  assert.equal(cls({ fixFiles: ['.claude/skills/x/SKILL.md', '.claude/agents/y.md'] }), 'no-behaviour-check');
  assert.equal(cls({ fixFiles: ['scripts/x/fixtures/in.json'] }), 'mocked-fixture');
  assert.equal(cls({ fixFiles: ['scripts/x/mock-server.mjs'] }), 'mocked-fixture');
  assert.equal(cls({ fixFiles: ['.github/workflows/ci.yml'] }), 'no-ci-vitest-linux');
  assert.equal(cls({ fixFiles: ['.claude/hooks/src/decision-gate.ts'] }), 'thin-guard-tables');
  assert.equal(cls({ fixFiles: ['.claude/hooks/src/path-guard.ts'] }), 'thin-guard-tables');
  assert.equal(cls({ linkedFinding: 'f-1' }), 'advisory-major-open');
});

test('E2: the first matching rule wins (breaks if the rules are reordered)', () => {
  assert.equal(cls({ fixFiles: ['h/x.ts'], blamedFiles: ['s/y.mjs'], blamedPrCount: 3, linkedFinding: 'f' }), 'wrong-surfaces');
  assert.equal(cls({ fixFiles: ['.claude/skills/x/SKILL.md'], blamedPrCount: 3 }), 'no-behaviour-check');
  assert.equal(cls({ fixFiles: ['scripts/fixtures/a.json'], blamedPrCount: 2 }), 'mocked-fixture');
  assert.equal(cls({ fixFiles: ['scripts/fixtures/a.json', '.github/workflows/ci.yml'] }), 'mocked-fixture');
  assert.equal(cls({ fixFiles: ['.github/workflows/ci.yml', '.claude/hooks/src/gate.ts'] }), 'no-ci-vitest-linux');
  assert.equal(cls({ fixFiles: ['.claude/hooks/src/gate.ts'], linkedFinding: 'f' }), 'thin-guard-tables');
});

test('E15: several blamed PRs are no evidence of a merge interaction: no other signal is unclassified, and the class stays in the report at 0 (breaks if a blamedPrCount rule comes back)', () => {
  assert.equal(cls({ blamedPrCount: 3 }), 'unclassified');
  assert.equal(cls({ blamedPrCount: 2, fixFiles: ['docs/a.md'] }), 'unclassified');
  assert.ok(CAUSES.includes('merge-interaction'));
  assert.match(report([{ mergeSha: 'a', blamedPr: 1, cause: 'unclassified' }], {}), /merge-interaction: 0/);
});

test('E3: a fix with no blamed files is not called wrong-surfaces (breaks if rule 1 runs on an empty blamed list)', () => {
  assert.equal(cls({ fixFiles: ['h/x.ts'], blamedFiles: [] }), 'unclassified');
});

test('E4: rule 1 counts test gates only (breaks if the gate filter is dropped)', () => {
  assert.equal(cls({ fixFiles: ['a/x.mjs'], blamedFiles: ['docs/o.md'] }), 'unclassified');
  assert.equal(cls({ fixFiles: ['s/x.mjs'], blamedFiles: ['docs/o.md'] }), 'wrong-surfaces');
});

test('E5: nothing matches, so the class is unclassified (breaks if a default class is added)', () => {
  assert.equal(cls({}), 'unclassified');
  assert.equal(cls({ fixFiles: [], blamedFiles: [] }), 'unclassified');
});

test('E6: an empty fix file list is not rule text (breaks if rule 2 drops its length check)', () => {
  assert.equal(cls({ fixFiles: [] }), 'unclassified');
  assert.equal(cls({ fixFiles: ['.claude/rules-src/a.md', 'scripts/x.mjs'] }), 'unclassified');
});

test('E7: rule 1 uses the injected gatesFor (breaks if the argument is ignored)', () => {
  const seen = [];
  const spy = (files) => { seen.push(files); return gatesFor(files); };
  cls({ fixFiles: ['h/x.ts'], blamedFiles: ['s/y.mjs'], gatesFor: spy });
  assert.deepEqual(seen.map((f) => f[0]).sort(), ['h/x.ts', 's/y.mjs']);
});

test('E8: the default gatesFor is the real one of pre-pr.mjs (breaks if the default is dropped)', () => {
  const r = classifyCause({ fixFiles: ['.claude/hooks/src/foo.ts'], blamedFiles: ['scripts/lib/x.mjs'], blamedPrCount: 1 });
  assert.equal(r, 'wrong-surfaces');
});

test('E9: the report shows every class, zeros too, and n/a for the share with no rows (breaks if a class is skipped or the n/a branch goes)', () => {
  const empty = report([], { noTarget: { byReason: {}, inPrOnly: 0 } });
  for (const c of CAUSES) assert.match(empty, new RegExp(`${c}: 0`));
  assert.match(empty, /reviewer-fixable share: n\/a/);
  assert.match(empty, /reviewer-fixable share without path-only classes: n\/a/);
  assert.match(empty, /class thin-guard-tables is set by file path, not by reading the fix/);
  assert.match(empty, /escape rows: 0/);
});

test('E10: the reviewer-fixable share counts advisory-major-open and thin-guard-tables only (breaks if REVIEWER_FIXABLE changes)', () => {
  assert.deepEqual([...REVIEWER_FIXABLE].sort(), ['advisory-major-open', 'thin-guard-tables']);
  const rows = ['advisory-major-open', 'thin-guard-tables', 'wrong-surfaces', 'unclassified'].map((cause, i) => ({ mergeSha: `m${i}`, blamedPr: i, cause }));
  assert.match(report(rows, {}), /reviewer-fixable share: 2 of 4 primary rows \(50%\) \(lower bound: rows carry no linkedFinding\)/);
});

test('E16: the report counts primary rows per cause, keeps an all-rows line, bases the share on primary rows, and says the rule is a rule of thumb (breaks if the primary flag is ignored or the wording goes)', () => {
  const rows = [
    { cause: 'wrong-surfaces', primary: true },
    { cause: 'unclassified', primary: false },
    { cause: 'unclassified', primary: false },
    { cause: 'thin-guard-tables' }, // an old row with no primary field counts as primary
  ];
  const text = report(rows, {});
  assert.match(text, /escape rows: 4 \(primary 2\)/);
  assert.match(text, /^ {2}wrong-surfaces: 1$/m);
  assert.match(text, /^ {2}unclassified: 0$/m, 'a non-primary row is not in the per-cause counts');
  assert.match(text, /all rows by cause[^\n]*unclassified 2/);
  assert.match(text, /all rows by cause[^\n]*wrong-surfaces 1/);
  assert.match(text, /reviewer-fixable share: 1 of 2 primary rows \(50%\) \(lower bound: rows carry no linkedFinding\)/);
  assert.match(text, /a rule of thumb \(right in 4 of 4 doc cases\), not a proven cause/);
});

test('E17: the mock check reads the lowercased basename (breaks if the case is not folded)', () => {
  assert.equal(cls({ fixFiles: ['scripts/x/MockServer.mjs'] }), 'mocked-fixture');
  assert.equal(cls({ fixFiles: ['scripts/x/FAKE_MOCK.mjs'] }), 'mocked-fixture');
});

test('E18: the share carries its caveats on the lines next to it, in order: the share with its row count, the path-only warning, the share without path-only classes (breaks if a line, its wording or its order changes, or thin-guard-tables rows stay in the third share)', () => {
  const mk = (cause, n, extra = {}) => Array.from({ length: n }, (_, i) => ({ mergeSha: `${cause}${i}`, blamedPr: i, cause, ...extra }));
  // 19 primary rows: 7 advisory-major-open, 5 thin-guard-tables, 4 wrong-surfaces, 3 unclassified. Non-primary rows must not count.
  const rows = [...mk('advisory-major-open', 7), ...mk('thin-guard-tables', 5), ...mk('wrong-surfaces', 4, { primary: true }), ...mk('unclassified', 3), ...mk('thin-guard-tables', 3, { primary: false })];
  const lines = report(rows, {}).split('\n');
  const at = lines.findIndex((l) => l.startsWith('reviewer-fixable share: '));
  assert.ok(at >= 0, 'the share line exists');
  assert.deepEqual(lines.slice(at, at + 3), [
    'reviewer-fixable share: 12 of 19 primary rows (63%) (lower bound: rows carry no linkedFinding)',
    'class thin-guard-tables is set by file path, not by reading the fix; a range heavy in guard-file fixes raises this share',
    'reviewer-fixable share without path-only classes: 7 of 14 primary rows (50%)',
  ]);
  const onlyPath = report(mk('thin-guard-tables', 2), {}).split('\n');
  assert.ok(onlyPath.includes('reviewer-fixable share without path-only classes: n/a'), 'M = 0 prints n/a');
  assert.ok(onlyPath.includes('reviewer-fixable share: 2 of 2 primary rows (100%) (lower bound: rows carry no linkedFinding)'));
});

test('E11: the no-target count and its reasons print; in-PR-only fixes print apart (breaks if they are merged or lost)', () => {
  const text = report([], { noTarget: { byReason: { 'outside-window': 2, 'no-removed-lines': 1 }, inPrOnly: 4 } });
  assert.match(text, /fixes with no blame target: 3/);
  assert.match(text, /outside-window 2/);
  assert.match(text, /no-removed-lines 1/);
  assert.match(text, /fix commits inside their own PR only \(not counted as no-target\): 4/);
  assert.match(report([], {}), /fixes with no blame target: not available/);
});

const rowsFile = (dir, lines) => { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'escapes.jsonl'), `${lines.join('\n')}\n`); };
const run = async (argv, env = {}) => {
  const out = [];
  const code = await main(argv, { stdout: (s) => out.push(s), stderr: (s) => out.push(`ERR ${s}`), env });
  return { code, text: out.join('\n') };
};

test('E12: the CLI reads the given state dir, treats a missing file as 0 rows, and never writes (breaks if main writes or reads another dir)', async () => {
  const dir = tmp();
  assert.match((await run(['--state-dir', dir])).text, /0 escape rows/);
  assert.equal((await run(['--state-dir', dir])).code, 0);
  rowsFile(dir, [JSON.stringify({ mergeSha: 'a', pr: 2, blamedPr: 1, cause: 'merge-interaction' })]);
  const file = path.join(dir, 'escapes.jsonl');
  const before = statSync(file);
  const r = await run([], { REVIEW_ENGINE_STATE_DIR: dir });
  assert.match(r.text, /escape rows: 1/);
  assert.match(r.text, /merge-interaction: 1/);
  const after2 = statSync(file);
  assert.equal(after2.size, before.size);
  assert.equal(after2.mtimeMs, before.mtimeMs);
  assert.equal(stateDirOf('/x/y', { REVIEW_ENGINE_STATE_DIR: '/z' }), '/x/y');
  assert.equal(stateDirOf(undefined, { REVIEW_ENGINE_STATE_DIR: '/z' }), '/z');
  assert.equal(stateDirOf(undefined, {}), path.join(os.homedir(), '.claude', 'state', 'review-engine'));
});

test('E13: --since drops older rows and undated rows (and says how many), and a damaged line is skipped (breaks if the filter keeps undated rows, the count is not printed, or the parser is removed)', async () => {
  const dir = tmp();
  rowsFile(dir, [
    JSON.stringify({ mergeSha: 'a', pr: 2, blamedPr: 1, cause: 'unclassified', fixMergedAt: '2026-01-01T00:00:00Z' }),
    '{not json',
    JSON.stringify({ mergeSha: 'b', pr: 4, blamedPr: 3, cause: 'unclassified', fixMergedAt: '2026-03-01T00:00:00Z' }),
    JSON.stringify({ mergeSha: 'c', pr: 6, blamedPr: 5, cause: 'unclassified' }),
  ]);
  const all = (await run(['--state-dir', dir])).text;
  assert.match(all, /escape rows: 3/);
  assert.doesNotMatch(all, /undated/);
  const recent = (await run(['--state-dir', dir, '--since', '2026-02-01T00:00:00Z'])).text;
  assert.match(recent, /escape rows: 1 /);
  assert.match(recent, /undated rows left out: 1/);
});

test('E13b: --from-json takes rows and the no-target count from a fix-chains --json file (breaks if the flag is ignored)', async () => {
  const dir = tmp();
  const file = path.join(dir, 'run.json');
  writeFileSync(file, JSON.stringify({ rows: [{ mergeSha: 'a', pr: 2, blamedPr: 1, cause: 'mocked-fixture' }], totals: { noTarget: { byReason: { 'gh-failed': 2 }, inPrOnly: 0 } } }));
  const r = await run(['--from-json', file, '--state-dir', path.join(dir, 'none')]);
  assert.match(r.text, /mocked-fixture: 1/);
  assert.match(r.text, /fixes with no blame target: 2/);
});

test('E19: --from-json with no rows array exits 2 with a message and never falls back to the state dir (breaks if a missing rows array reads escapes.jsonl)', async () => {
  const dir = tmp();
  rowsFile(dir, [JSON.stringify({ mergeSha: 'a', pr: 2, blamedPr: 1, cause: 'unclassified' })]);
  const bad = { 'no-rows.json': '{"totals":{}}', 'array.json': '[]', 'null.json': 'null', 'rows-string.json': '{"rows":"x"}', 'broken.json': '{not json' };
  for (const [name, text] of Object.entries(bad)) {
    const file = path.join(dir, name);
    writeFileSync(file, text);
    const r = await run(['--from-json', file, '--state-dir', dir]);
    assert.equal(r.code, 2, name);
    assert.doesNotMatch(r.text, /escape rows/, `${name}: the state dir rows must not be read`);
    assert.match(r.text, /ERR escape-causes: /);
  }
  assert.match((await run(['--from-json', path.join(dir, 'nope.json'), '--state-dir', dir])).text, /ERR escape-causes: /);
});

test('E14: --help prints usage and exits 0; a bad flag exits 2 (breaks if main treats help as an error)', async () => {
  const h = await run(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.text, /usage: node scripts\/eval\/review-eval\/escape-causes\.mjs/);
  assert.equal((await run(['--nope'])).code, 2);
});
