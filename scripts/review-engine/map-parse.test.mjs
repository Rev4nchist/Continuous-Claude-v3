// Tests for lib/map-parse.mjs and lib/owns.mjs. They import the real functions.
// Run: node --test scripts/review-engine/map-parse.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMap, parseHeld, parseOwns, parseDeps } from './lib/map-parse.mjs';
import { globToRegExp, ownsMatch, entriesOverlap } from './lib/owns.mjs';

const FIXTURE = new URL('./fixtures/map.fixture.md', import.meta.url);
// The checkout may have CRLF on disk (core.autocrlf), so fix the endings here.
const LF = readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n');
const model = parseMap(LF);
const lane = (id) => model.lanes.find((l) => l.id === id);
const section = (id) => model.sections.find((s) => s.id === id);

test('P1 CRLF text parses the same as LF text', () => {
  const crlf = LF.replace(/\n/g, '\r\n');
  assert.deepEqual(parseMap(crlf), model);
});

test('P2 backticks are stripped from lane ids', () => {
  assert.equal(model.lanes[0].id, 'fx-base');
  assert.deepEqual(model.lanes.map((l) => l.id), [
    'fx-base', 'fx-keys', 'fx-mid', 'fx-gate-a', 'fx-gate-b', 'fx-top', 'fx-holder',
  ]);
});

test('P3 "none" is an empty dependency list', () => {
  assert.deepEqual(lane('fx-base').deps, []);
});

test('P4 a dependency list is split and trimmed', () => {
  assert.deepEqual(lane('fx-top').deps, ['fx-mid', 'fx-gate-a']);
  assert.deepEqual(lane('fx-mid').deps, ['fx-base', 'fx-ext']);
});

test('P5 every Held until form parses to its exact token', () => {
  assert.deepEqual(lane('fx-mid').held, [{ kind: 'dave-yes' }]);
  assert.deepEqual(lane('fx-gate-a').held, [{ kind: 'decision', id: 'DP2.4' }]);
  assert.deepEqual(lane('fx-gate-b').held, [{ kind: 'first-flip' }]);
  assert.deepEqual(lane('fx-holder').held, [{ kind: 'item-trigger' }]);
  assert.deepEqual(lane('fx-top').held, [
    { kind: 'lane', lane: 'fx-gate-b' },
    { kind: 'conditional', lane: 'fx-base', decision: 'DP2.4', answer: 'yes' },
  ]);
  assert.equal(lane('fx-top').heldRaw, 'fx-gate-b; fx-base if DP2.4 = yes');
  assert.deepEqual(lane('fx-base').held, []);
  assert.deepEqual(parseHeld('DP2.4 maybe'), [{ kind: 'unknown', text: 'DP2.4 maybe' }]);
  assert.deepEqual(parseHeld('first-flip; dave-yes'), [{ kind: 'first-flip' }, { kind: 'dave-yes' }]);
  assert.deepEqual(parseHeld(''), []);
});

test('P6 the Waves table ends at the first line without a pipe', () => {
  assert.equal(model.lanes.length, 7);
  assert.deepEqual(model.errors, []);
});

test('P6b raw cells stay available for the checks', () => {
  assert.equal(lane('fx-gate-a').needsDave, true);
  assert.equal(lane('fx-base').needsDave, false);
  assert.equal(lane('fx-base').needsDaveRaw, '');
  assert.equal(lane('fx-gate-a').needsDaveRaw, 'yes');
  assert.equal(lane('fx-mid').wave, 1);
  assert.equal(lane('fx-mid').waveRaw, '1');
  assert.equal(lane('fx-mid').change, 'changed');
  assert.equal(lane('fx-mid').phase, 'P3');
  assert.equal(lane('fx-mid').cellCount, 7);
  assert.equal(lane('fx-mid').line, 11);
});

test('P6c a bad Waves table is reported in model.errors, not thrown', () => {
  const noTable = parseMap(LF.replace('| Wave | Lane |', '| Wavy | Lane |'));
  assert.deepEqual(noTable.errors.map((e) => e.rule), ['waves-missing']);
  assert.deepEqual(noTable.lanes, []);
  const shortRow = parseMap(LF.replace('| 0 | `fx-keys` | P3 | none |  | changed |  |', '| 0 | `fx-keys` | P3 | none |  | changed |'));
  assert.deepEqual(shortRow.errors.map((e) => e.rule), ['row-cells']);
  assert.match(shortRow.errors[0].message, /^Waves line 10: 6 cells, want 7$/);
  assert.equal(shortRow.lanes.length, 7);
});

test('P7 a section ends at the next "##" heading with no blank line', () => {
  const ext = section('fx-ext');
  assert.deepEqual(Object.keys(ext.fields), [
    'Depends on', 'Unblocks', 'Related', 'Owns', 'Do not touch', 'Cost', 'Needs Dave',
  ]);
  assert.equal(ext.blocks['Done when'], 'The external test passes.');
  assert.equal(ext.blocks.Why, 'It gates fx-mid.');
  assert.equal(model.sections.length, 8);
});

test('P8 a field with a tag in parentheses is found', () => {
  assert.equal(section('fx-base').fields.Cost, '0 runs');
});

test('P9 a prose bullet is not a field', () => {
  assert.deepEqual(Object.keys(section('fx-mid').fields), [
    'Depends on', 'Unblocks', 'Related', 'Owns', 'Do not touch', 'Cost', 'Needs Dave',
  ]);
});

test('P10 Scope buffering: field-like lines inside Scope stay in the block, not in fields', () => {
  const mid = section('fx-mid');
  assert.equal(mid.fields.Owns, '`fixture/tool.mjs` (fixes only)');
  assert.equal('Decoyfield' in mid.fields, false);
});

test('P11 Owns entries: new, scope, prose, none, outside git', () => {
  const base = section('fx-base').owns;
  assert.deepEqual(base, [
    { path: 'fixture/tool.mjs', kind: 'file', scope: null, isNew: false, outsideGit: false },
    { path: 'fixture/tool.test.mjs', kind: 'file', scope: null, isNew: true, outsideGit: false },
  ]);
  assert.deepEqual(section('fx-mid').owns, [
    { path: 'fixture/tool.mjs', kind: 'file', scope: 'fixes only', isNew: false, outsideGit: false },
  ]);
  assert.equal(section('fx-gate-a').owns[0].scope, 'the gate_a key only');
  assert.deepEqual(section('fx-top').owns, [
    { path: 'fixture/out/**', kind: 'glob', scope: null, isNew: false, outsideGit: false },
    { path: '.claudedocs/fx-results.md', kind: 'file', scope: null, isNew: true, outsideGit: true },
  ]);
  assert.equal(section('fx-top').ownsProse, '');
  assert.deepEqual(section('fx-ext').owns.map((e) => [e.path, e.kind]), [['fixture/ext*.mjs', 'glob']]);
  assert.equal(section('fx-ext').ownsProse, 'its test (card scope)');
  assert.deepEqual(section('fx-holder').owns, []);
  assert.equal(section('fx-holder').ownsProse, '');
});

test('P12 an external lane is found from its subtitle', () => {
  assert.deepEqual(model.externals.map((e) => e.id), ['fx-ext']);
  assert.equal(model.externals[0].wave, 0);
  assert.equal(model.externals[0].section, section('fx-ext'));
  assert.equal(section('fx-ext').external, true);
  assert.equal(section('fx-base').external, false);
});

test('P13 only the first table under Dropped is read', () => {
  assert.deepEqual(model.dropped.map((d) => d.id), ['fx-gone']);
  assert.equal(model.dropped[0].what, 'Dropped (X1)');
  assert.equal(model.dropped[0].where, 'Nowhere.');
});

test('P13b a table that is not under the Dropped heading is not read', () => {
  const text = '## Dropped or merged lanes\n\nNothing was dropped.\n\n## Next\n\n| Lane | What | Where |\n|---|---|---|\n| `x-a` | y | z |\n';
  assert.deepEqual(parseMap(text).dropped, []);
});

test('P10b before-first-block limit: a repeated block line and a field after a block change nothing', () => {
  const text = LF.replace('Why: The tool has a known fault.', 'Why: The tool has a known fault.\nScope: again\n- Extrafield: y');
  const mid = parseMap(text).sections.find((s) => s.id === 'fx-mid');
  assert.equal('Extrafield' in mid.fields, false);
  assert.equal(mid.blocks.Why, 'The tool has a known fault.');
  assert.equal(mid.blocks.Scope, '- Fix the tool.\n- Owns: decoy\n- Decoyfield: x');
});

test('P14 a subtitle with no change token parses', () => {
  const top = section('fx-top');
  assert.equal(top.title, 'Top lane: ties it together');
  assert.equal(top.subtitle, 'wave 2, phase P4');
  assert.equal(lane('fx-top').section, top);
});

test('P15 an Owner chains bullet with two clauses gives two chains', () => {
  assert.equal(model.ownerChains.length, 2);
  assert.deepEqual(model.ownerChains[0].files, ['tool.mjs']);
  assert.deepEqual(model.ownerChains[0].lanes, ['fx-base', 'fx-mid']);
  assert.deepEqual(model.ownerChains[1].files, ['fixture/config.json']);
  assert.deepEqual(model.ownerChains[1].lanes, ['fx-keys', 'fx-gate-a', 'fx-gate-b']);
  assert.deepEqual(model.ownerPhrases.map((p) => [p.lane, p.files]), [['fx-keys', ['fixture/config.json']]]);
});

test('P16 a block with an empty rest takes its following lines', () => {
  assert.equal(section('fx-mid').blocks.Scope, '- Fix the tool.\n- Owns: decoy\n- Decoyfield: x');
  assert.equal(section('fx-base').blocks.Scope, '- Build the tool.');
  assert.equal(section('fx-ext').blocks.Scope, 'Run the external check.');
});

test('sections keep file order and the model has every key S2 needs', () => {
  assert.deepEqual(model.sections.map((s) => s.id), [
    'fx-base', 'fx-keys', 'fx-mid', 'fx-gate-a', 'fx-gate-b', 'fx-top', 'fx-holder', 'fx-ext',
  ]);
  assert.deepEqual(Object.keys(model).sort(), [
    'chainUnparsed', 'dropped', 'errors', 'externals', 'lanes', 'ownerChains', 'ownerPhrases', 'sections', 'source',
  ]);
  assert.equal(parseMap(LF, { kind: 'file', path: 'x' }).source.path, 'x');
});

// owns.mjs

test('owns: "**" crosses directories', () => {
  assert.equal(ownsMatch({ path: 'fixture/out/**' }, 'fixture/out/a/b/c.txt'), true);
  assert.equal(ownsMatch({ path: 'fixture/out/**' }, 'fixture/other/c.txt'), false);
  assert.equal(ownsMatch({ path: 'a/**/b.mjs' }, 'a/b.mjs'), true);
  assert.equal(ownsMatch({ path: 'a/**/b.mjs' }, 'a/x/y/b.mjs'), true);
});

test('owns: "*" does not cross "/" and "." is literal', () => {
  assert.equal(ownsMatch({ path: 'fixture/ext*.mjs' }, 'fixture/ext-1.mjs'), true);
  assert.equal(ownsMatch({ path: 'fixture/ext*.mjs' }, 'fixture/ext/deep.mjs'), false);
  assert.equal(ownsMatch({ path: 'fixture/ext*.mjs' }, 'fixture/ext-1xmjs'), false);
  assert.equal(globToRegExp('a*b').test('a/b'), false);
});

test('owns: a directory entry is a prefix', () => {
  assert.equal(ownsMatch({ path: 'fixture/dir/' }, 'fixture/dir/x/y.mjs'), true);
  assert.equal(ownsMatch({ path: 'fixture/dir/' }, 'fixture/dirx/y.mjs'), false);
  assert.equal(ownsMatch({ path: 'fixture/dir/' }, 'fixture/dir'), false);
});

test('owns: a file entry matches only the same path', () => {
  assert.equal(ownsMatch({ path: 'fixture/tool.mjs' }, 'fixture/tool.mjs'), true);
  assert.equal(ownsMatch({ path: 'fixture/tool.mjs' }, 'fixture/tool.mjs.bak'), false);
});

test('owns: match is case sensitive', () => {
  assert.equal(ownsMatch({ path: 'fixture/tool.mjs' }, 'Fixture/Tool.mjs'), false);
  assert.equal(ownsMatch({ path: 'fixture/out/**' }, 'Fixture/out/a.txt'), false);
});

test('owns: a file overlaps a glob or dir that matches it', () => {
  assert.equal(entriesOverlap({ path: 'fixture/tool.mjs' }, { path: 'fixture/tool.mjs' }), true);
  assert.equal(entriesOverlap({ path: 'fixture/out/a.txt' }, { path: 'fixture/out/**' }), true);
  assert.equal(entriesOverlap({ path: 'fixture/out/**' }, { path: 'fixture/out/a.txt' }), true);
  assert.equal(entriesOverlap({ path: 'fixture/dir/x.mjs' }, { path: 'fixture/dir/' }), true);
  assert.equal(entriesOverlap({ path: 'fixture/other/a.txt' }, { path: 'fixture/out/**' }), false);
  assert.equal(entriesOverlap({ path: 'fixture/a.mjs' }, { path: 'fixture/b.mjs' }), false);
});

test('owns: two globs overlap when one static prefix starts the other', () => {
  assert.equal(entriesOverlap({ path: 'fixture/**' }, { path: 'fixture/out/*.txt' }), true);
  assert.equal(entriesOverlap({ path: 'fixture/out/*.txt' }, { path: 'fixture/**' }), true);
  assert.equal(entriesOverlap({ path: 'fixture/dir/' }, { path: 'fixture/dir/sub/**' }), true);
  assert.equal(entriesOverlap({ path: 'fixture/ext*.mjs' }, { path: 'fixture/out/**' }), false);
});


test('P17 a chain clause that is not "<files>: <lanes>" is kept in model.chainUnparsed', () => {
  assert.deepEqual(model.chainUnparsed, []);
  const from = 'fixture/config.json: `fx-keys`, `fx-gate-a`, `fx-gate-b`.';
  assert.ok(LF.includes(from));
  const text = LF.replace(from, `${from} tasks.json and package.json test:scripts line: \`fx-base\`. The \`fx-top\` hold is gone.`);
  assert.deepEqual(parseMap(text).chainUnparsed, [
    { line: 33, text: 'tasks.json and package.json test:scripts line: `fx-base`' },
    { line: 33, text: 'The `fx-top` hold is gone.' },
  ]);
  assert.equal(parseMap(text).ownerChains.length, 2);
});

test('P18 parseOwns reports a rejected backticked token that looks like a path', () => {
  const r = parseOwns('`a/b.mjs`, `my dir/x.mjs`, `run x.json`, `lane.mjs seed`, `some prose`');
  assert.deepEqual(r.owns.map((e) => e.path), ['a/b.mjs']);
  assert.deepEqual(r.rejected, ['my dir/x.mjs', 'run x.json']);
  assert.deepEqual(parseOwns('none').rejected, []);
  assert.deepEqual(section('fx-base').ownsRejected, []);
});

test('P19 parseDeps: "none" is empty, a list is split and trimmed, one helper for the table and the check', () => {
  assert.deepEqual(parseDeps('none'), []);
  assert.deepEqual(parseDeps(' none '), []);
  assert.deepEqual(parseDeps('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseDeps(''), []);
});

test('owns: two globs that no file can match do not overlap (C3)', () => {
  const pairs = [
    ['scripts/*.mjs', 'scripts/*.json'],
    ['scripts/*.mjs', 'scripts/sub/'],
    ['scripts/*.mjs', 'scripts/sub/**'],
    ['scripts/a*', 'scripts/b*'],
    ['scripts/*/x.mjs', 'scripts/*/y.mjs'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(entriesOverlap({ path: a }, { path: b }), false, `${a} vs ${b}`);
    assert.equal(entriesOverlap({ path: b }, { path: a }), false, `${b} vs ${a}`);
  }
});

test('owns: globs and dirs that share a file still overlap, in both directions (C3)', () => {
  const pairs = [
    ['scripts/**', 'scripts/sub/x.mjs'],
    ['scripts/*.mjs', 'scripts/a*.mjs'],
    ['scripts/*.mjs', 'scripts/*.test.mjs'],
    ['scripts/**', 'scripts/*.mjs'],
    ['scripts/', 'scripts/*.mjs'],
    ['scripts/sub/', 'scripts/**/x.mjs'],
    ['a/**/b.mjs', 'a/b*.mjs'],
    ['scripts/*/x.mjs', 'scripts/sub/*.mjs'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(entriesOverlap({ path: a }, { path: b }), true, `${a} vs ${b}`);
    assert.equal(entriesOverlap({ path: b }, { path: a }), true, `${b} vs ${a}`);
  }
});
