// Tests for lib/map-check.mjs. They import the real functions.
// Each test applies one string replace to the fixture and names the rule that must fire.
// Run: node --test scripts/review-engine/map-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMap } from './lib/map-parse.mjs';
import { checkTable, closure } from './lib/map-check.mjs';

const FIXTURE = new URL('./fixtures/map.fixture.md', import.meta.url);
const LF = readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n');

// Replace must hit, or the test would pass for the wrong reason.
function mutate(...pairs) {
  let text = LF;
  for (const [from, to] of pairs) {
    assert.ok(text.includes(from), `fixture lacks: ${from}`);
    text = text.replace(from, to);
  }
  return text;
}
const run = (text = LF) => checkTable(parseMap(text));
const hits = (res, rule, lane) =>
  res.errors.filter((e) => e.rule === rule && (lane === undefined || e.lane === lane));
const notesOf = (res, rule) => res.notes.filter((n) => n.rule === rule);

const ROW_KEYS = '| 0 | `fx-keys` | P3 | none |  | changed |  |';

test('K0 the clean fixture has no errors and one exempt overlap', () => {
  const res = run();
  assert.deepEqual(res.errors, []);
  assert.equal(notesOf(res, 'owns-exempt').length, 1);
  assert.match(notesOf(res, 'owns-exempt')[0].message, /fixture\/config\.json/);
  assert.equal(notesOf(res, 'owns-prose').length, 1);
  assert.equal(notesOf(res, 'owns-prose')[0].lane, 'fx-ext');
  assert.equal(res.notes.some((n) => /vacuous/.test(n.message)), false);
});

test('waves-missing: no table gives one error and no cascade', () => {
  const res = run(mutate(['| Wave | Lane |', '| Wavy | Lane |']));
  assert.deepEqual(res.errors.map((e) => e.rule), ['waves-missing']);
  assert.equal(res.notes.some((n) => /vacuous/.test(n.message)), false);
});

test('row-cells: a short row is reported once and causes no other error', () => {
  const res = run(mutate([ROW_KEYS, '| 0 | `fx-keys` | P3 | none |  | changed |']));
  assert.deepEqual(res.errors.map((e) => e.rule), ['row-cells']);
  assert.equal(res.errors[0].lane, 'fx-keys');
});

test('row-cells: a row with a middle cell dropped is skipped by the cell rules', () => {
  // The cells shift left, so Needs Dave and Change would read the wrong columns.
  const res = run(mutate([ROW_KEYS, '| 0 | `fx-keys` | none |  | changed |  |']));
  assert.deepEqual(res.errors.map((e) => e.rule), ['row-cells']);
});

test('bad-wave: a wave that is not a whole number', () => {
  const res = run(mutate([ROW_KEYS, ROW_KEYS.replace('| 0 |', '| x |')]));
  assert.equal(hits(res, 'bad-wave', 'fx-keys').length, 1);
  assert.match(hits(res, 'bad-wave')[0].message, /^Waves line 10: wave 'x' is not a whole number$/);
  assert.equal(hits(res, 'dep-order').length, 0);
});

test('bad-id: an id outside the lane.mjs seed rule', () => {
  const res = run(mutate(['| 1 | `fx-mid` |', '| 1 | `fx_mid` |']));
  assert.equal(hits(res, 'bad-id', 'fx_mid').length, 1);
});

test('dup-lane: two Waves rows for one id', () => {
  const res = run(mutate([ROW_KEYS, `${ROW_KEYS}\n${ROW_KEYS}`]));
  const dup = hits(res, 'dup-lane', 'fx-keys');
  assert.equal(dup.length, 1);
  assert.match(dup[0].message, /two Waves rows \(lines 10, 11\)/);
  assert.equal(hits(res, 'owns-overlap').length, 0);
});

test('needs-dave: a value that is not yes or empty', () => {
  const res = run(mutate(['| fx-keys | yes |', '| fx-keys | maybe |']));
  assert.equal(hits(res, 'needs-dave', 'fx-gate-a').length, 1);
});

test('change: a value outside the four change words', () => {
  const res = run(mutate([ROW_KEYS, ROW_KEYS.replace('changed', 'fresh')]));
  assert.equal(hits(res, 'change', 'fx-keys').length, 1);
});

test('dep-unknown: a dependency with no row and no external section', () => {
  const res = run(mutate(['fx-base, fx-ext |', 'fx-base, fx-nope |']));
  assert.equal(hits(res, 'dep-unknown', 'fx-mid').length, 1);
  assert.equal(hits(res, 'dep-dropped').length, 0);
});

test('dep-dropped: a dependency on a dropped lane is dropped only, not unknown', () => {
  const res = run(mutate(['| 2 | `fx-holder` | P7 | fx-mid |', '| 2 | `fx-holder` | P7 | fx-mid, fx-gone |']));
  assert.equal(hits(res, 'dep-dropped', 'fx-holder').length, 1);
  assert.equal(hits(res, 'dep-unknown').length, 0);
});

test('dep-order: a dependency in the same wave', () => {
  const res = run(mutate(['| 1 | `fx-mid` | P3 |', '| 2 | `fx-mid` | P3 |']));
  const err = hits(res, 'dep-order', 'fx-top');
  assert.equal(err.length, 1);
  assert.match(err[0].message, /lane 'fx-top' \(wave 2\): dependency 'fx-mid' is in wave 2, not an earlier wave/);
});

test('dep-order: an external counts as wave 0', () => {
  const res = run(mutate(['| 0 | `fx-base` | GATE | none |', '| 0 | `fx-base` | GATE | fx-ext |']));
  const err = hits(res, 'dep-order', 'fx-base');
  assert.equal(err.length, 1);
  assert.match(err[0].message, /dependency 'fx-ext' is in wave 0/);
  assert.equal(hits(run(), 'dep-order').length, 0);
});

test('held-token: a token in no known form', () => {
  const res = run(mutate(['| yes | new | DP2.4 |', '| yes | new | DP2.4 maybe |']));
  assert.equal(hits(res, 'held-token', 'fx-gate-a').length, 1);
});

test('held-lane-unknown: a lane token and a conditional that name no lane', () => {
  const plain = run(mutate(['fx-gate-b; fx-base if DP2.4 = yes', 'fx-gate-b; fx-nope']));
  assert.equal(hits(plain, 'held-lane-unknown', 'fx-top').length, 1);
  const cond = run(mutate(['fx-base if DP2.4 = yes', 'fx-nope if DP2.4 = yes']));
  assert.equal(hits(cond, 'held-lane-unknown', 'fx-top').length, 1);
});

test('section-missing and orphan-section: a renamed heading gives both', () => {
  const res = run(mutate(['### fx-holder', '### fx-holdr']));
  assert.equal(hits(res, 'section-missing', 'fx-holder').length, 1);
  assert.equal(hits(res, 'orphan-section', 'fx-holdr').length, 1);
  assert.equal(hits(res, 'orphan-section', 'fx-holdr')[0].line, 150);
});

test('section-field: a missing field bullet and a missing block', () => {
  const field = run(mutate(['- Cost (T04): 0 runs\n', '']));
  assert.equal(hits(field, 'section-field', 'fx-base').length, 1);
  assert.match(hits(field, 'section-field')[0].message, /section has no 'Cost'/);
  const block = run(mutate(['Why: Every other lane needs the tool.\n', '']));
  assert.match(hits(block, 'section-field', 'fx-base')[0].message, /section has no 'Why'/);
});

test('section-field: an external section is checked too', () => {
  const res = run(mutate(['Done when: The external test passes.\n', '']));
  assert.equal(hits(res, 'section-field', 'fx-ext').length, 1);
});

test('section-deps: a section Depends on that differs from the table', () => {
  const res = run(mutate(['- Depends on: fx-mid, fx-gate-a', '- Depends on: fx-mid']));
  const err = hits(res, 'section-deps', 'fx-top');
  assert.equal(err.length, 1);
  assert.match(err[0].message, /section Depends on 'fx-mid' differs from the Waves table 'fx-mid, fx-gate-a'/);
});

test('dropped-live: a dropped lane that still has a row and a section', () => {
  const res = run(mutate(['| `fx-gone` | Dropped (X1) |', '| `fx-holder` | Dropped (X1) |']));
  assert.equal(hits(res, 'dropped-live', 'fx-holder').length, 1);
  assert.equal(hits(res, 'orphan-section').length, 0);
});

test('owns-overlap: two lanes on one file with no scope and no dependency path', () => {
  const res = run(mutate(['`fixture/config.json` (the gate_b key only)', '`fixture/config.json`']));
  const err = hits(res, 'owns-overlap');
  assert.equal(err.length, 1);
  assert.match(err[0].message, /^file 'fixture\/config\.json': owned by 'fx-gate-a' and 'fx-gate-b' with no dependency path between them$/);
  assert.equal(notesOf(res, 'owns-exempt').length, 0);
});

test('owns-overlap: a shared file passes when a dependency path joins the owners', () => {
  assert.equal(hits(run(), 'owns-overlap').length, 0);
  const cut = run(mutate(['fx-base, fx-ext |', 'fx-ext |']));
  const err = hits(cut, 'owns-overlap');
  assert.equal(err.length, 1);
  assert.match(err[0].message, /file 'fixture\/tool\.mjs': owned by 'fx-base' and 'fx-mid'/);
});

test('owns-overlap: a glob and a file are compared through the real matcher', () => {
  // fx-gate-b has no dependency path to fx-top (the hold on it is not an edge).
  const res = run(mutate(['`fixture/config.json` (the gate_b key only)', '`fixture/out/x.txt`']));
  const err = hits(res, 'owns-overlap');
  assert.equal(err.length, 1);
  assert.match(err[0].message, /owned by 'fx-gate-b' and 'fx-top' with no dependency path/);
  assert.equal(notesOf(res, 'owns-exempt').length, 0);
});

test('owner-chain: a chain lane whose Owns list lacks the file', () => {
  const res = run(mutate(['tool.mjs: `fx-base`, `fx-mid`.', 'tool.mjs: `fx-base`, `fx-mid`, `fx-keys`.']));
  const err = hits(res, 'owner-chain', 'fx-keys');
  assert.equal(err.length, 1);
  assert.match(err[0].message, /^Owner chains line 33: 'tool\.mjs' lists 'fx-keys', whose Owns list has no 'tool\.mjs'$/);
  assert.equal(hits(res, 'owner-chain').length, 1);
});

test('owner-phrase: an Owner phrase naming a lane that does not own the file', () => {
  const res = run(mutate(['Owner `fx-keys` (fixture/config.json)', 'Owner `fx-base` (fixture/config.json)']));
  const err = hits(res, 'owner-phrase', 'fx-base');
  assert.equal(err.length, 1);
  assert.match(err[0].message, /Shared contracts line 31: Owner 'fx-base' \(fixture\/config\.json\), but 'fx-base' Owns has no 'fixture\/config\.json'/);
});

test('examined counts what each rule group looked at', () => {
  assert.deepEqual(run().examined, {
    ownerChains: 2, ownerPhrases: 1, overlapPairs: 4, deps: 7, heldTokens: 6, sections: 8,
    rows: 7, dropped: 1, chainUnparsed: 0, packs: 0,
  });
});

test('vacuous: a map with no dropped lane notes that the dropped rule examined 0 items (C10)', () => {
  const res = run(mutate(['| `fx-gone` | Dropped (X1) | Nowhere. |\n', '']));
  assert.equal(res.examined.dropped, 0);
  assert.deepEqual(notesOf(res, 'vacuous').map((n) => n.message), ['vacuous: dropped examined 0 items']);
  assert.deepEqual(res.errors, []);
});

test('vacuous: a group that examined nothing on a map with a Waves table adds a note', () => {
  const res = run(mutate(['  - tool.mjs: `fx-base`, `fx-mid`. fixture/config.json: `fx-keys`, `fx-gate-a`, `fx-gate-b`.\n', '']));
  assert.equal(res.examined.ownerChains, 0);
  assert.equal(notesOf(res, 'vacuous').length, 1);
  assert.equal(notesOf(res, 'vacuous')[0].message, 'vacuous: ownerChains examined 0 items');
  assert.deepEqual(res.errors, []);
});

test('closure follows Waves edges only, with externals as leaves', () => {
  const model = parseMap(LF);
  assert.deepEqual([...closure(model, 'fx-top')].sort(), ['fx-base', 'fx-ext', 'fx-gate-a', 'fx-keys', 'fx-mid']);
  assert.deepEqual([...closure(model, 'fx-base')], []);
  assert.deepEqual([...closure(model, 'fx-nope')], []);
});

test('closure survives a dependency cycle', () => {
  const model = parseMap(mutate(['| 0 | `fx-base` | GATE | none |', '| 0 | `fx-base` | GATE | fx-mid |']));
  assert.deepEqual([...closure(model, 'fx-base')].sort(), ['fx-base', 'fx-ext', 'fx-mid']);
});

const CHAIN = '  - tool.mjs: `fx-base`, `fx-mid`. fixture/config.json: `fx-keys`, `fx-gate-a`, `fx-gate-b`.';
const withClause = (clause) => mutate([CHAIN, `${CHAIN} ${clause}`]);

test('owns-overlap: scopes that are not key scopes are not exempt (C2)', () => {
  const both = run(mutate(
    ['`fixture/config.json` (the gate_a key only)', '`fixture/config.json` (fixes only)'],
    ['`fixture/config.json` (the gate_b key only)', '`fixture/config.json` (tests)'],
  ));
  const err = hits(both, 'owns-overlap');
  assert.equal(err.length, 1);
  assert.match(err[0].message, /^file 'fixture\/config\.json': owned by 'fx-gate-a' and 'fx-gate-b' with no dependency path between them$/);
  assert.equal(notesOf(both, 'owns-exempt').length, 0);
  const one = run(mutate(['`fixture/config.json` (the gate_b key only)', '`fixture/config.json` (tests)']));
  assert.equal(hits(one, 'owns-overlap').length, 1);
  assert.equal(notesOf(one, 'owns-exempt').length, 0);
});

test('owns-overlap: "<word> only" scopes that name no key are not exempt (C2)', () => {
  const res = run(mutate(
    ['`fixture/config.json` (the gate_a key only)', '`fixture/config.json` (fixes only)'],
    ['`fixture/config.json` (the gate_b key only)', '`fixture/config.json` (tests only)'],
  ));
  assert.equal(hits(res, 'owns-overlap').length, 1);
  assert.equal(notesOf(res, 'owns-exempt').length, 0);
});

test('owns-overlap: two "keys only" scopes are still exempt, and a plural form counts (C2)', () => {
  const res = run(mutate(['`fixture/config.json` (the gate_b key only)', '`fixture/config.json` (the b and c keys only)']));
  assert.deepEqual(res.errors, []);
  assert.equal(notesOf(res, 'owns-exempt').length, 1);
});

test('owner-chain: a lane that owns a glob covering the chain file passes (C9)', () => {
  const res = run(withClause('fixture/out/x.json: `fx-top`.'));
  assert.equal(hits(res, 'owner-chain').length, 0);
  assert.equal(res.examined.ownerChains, 3);
});

test('owner-chain: a path outside the owner glob still fails (C9)', () => {
  const err = hits(run(withClause('fixture/other/x.json: `fx-top`.')), 'owner-chain', 'fx-top');
  assert.equal(err.length, 1);
  assert.match(err[0].message, /'fixture\/other\/x\.json' lists 'fx-top', whose Owns list has no/);
});

test('owner-phrase: a lane that owns a glob covering the phrase file passes (C9)', () => {
  const pass = run(mutate(['Owner `fx-keys` (fixture/config.json)', 'Owner `fx-top` (fixture/out/y.json)']));
  assert.equal(hits(pass, 'owner-phrase').length, 0);
  const fail = run(mutate(['Owner `fx-keys` (fixture/config.json)', 'Owner `fx-top` (fixture/other/y.json)']));
  assert.equal(hits(fail, 'owner-phrase', 'fx-top').length, 1);
});

test('owns-token: a backticked path the parser rejects is an error; plain prose is not (C8)', () => {
  const text = mutate(['`fixture/tool.test.mjs` (new)', '`fixture/tool.test.mjs` (new), `fixture/my tool.mjs`, `lane.mjs seed`']);
  const res = run(text);
  assert.deepEqual(res.errors.map((e) => e.rule), ['owns-token']);
  assert.equal(res.errors[0].lane, 'fx-base');
  assert.equal(res.errors[0].line, text.split('\n').indexOf('### fx-base') + 1);
  assert.match(res.errors[0].message, /^lane 'fx-base' \(line \d+\): Owns token 'fixture\/my tool\.mjs' looks like a path/);
  assert.equal(notesOf(res, 'owns-prose').some((n) => n.lane === 'fx-base'), true);
});

test('chain-unparsed: a chain clause no rule can read gets a note with its map line, counted (S-gap)', () => {
  const res = run(withClause('tasks.json and package.json test:scripts line: `fx-base`. The `fx-top` hold is gone.'));
  assert.deepEqual(res.errors, []);
  const notes = notesOf(res, 'chain-unparsed');
  assert.equal(notes.length, 2);
  assert.equal(notes[0].line, 33);
  assert.match(notes[0].message, /Owner chains line 33: .*tasks\.json and package\.json test:scripts line/);
  assert.equal(res.examined.chainUnparsed, 2);
  assert.equal(res.examined.ownerChains, 2);
  assert.equal(notesOf(res, 'vacuous').length, 0);
});

// checkPacks (amendment A6). A Pack line goes before the Dropped heading, so the Waves table is not touched.
const withPack = (...lines) => mutate(['## Dropped or merged lanes', `${lines.join('\n')}\n\n## Dropped or merged lanes`]);
const PACK_OK = 'Pack: fx-gate-a, fx-gate-b (branch re/fx-gate-a)';

test('pack: a valid pack passes, is counted, and adds no vacuous note', () => {
  const res = run(withPack(PACK_OK));
  assert.deepEqual(res.errors, []);
  assert.equal(res.examined.packs, 1);
  assert.equal(notesOf(res, 'vacuous').length, 0);
});

test('pack: a map with no Pack line examines 0 packs and still has no error or vacuous note', () => {
  const res = run();
  assert.equal(res.examined.packs, 0);
  assert.equal(res.notes.some((n) => /packs/.test(n.message)), false);
});

test('pack-lane: a pack lane that is not a Waves lane fails, an external included', () => {
  const ext = run(withPack('Pack: fx-gate-a, fx-ext (branch re/fx-gate-a)'));
  assert.equal(hits(ext, 'pack-lane', 'fx-ext').length, 1);
  const ghost = run(withPack('Pack: fx-gate-a, fx-ghost (branch re/fx-gate-a)'));
  assert.equal(hits(ghost, 'pack-lane', 'fx-ghost').length, 1);
});

test('pack-dep: a dependency path between two lanes of one pack fails, direct or through other lanes', () => {
  const direct = run(withPack('Pack: fx-base, fx-mid (branch re/fx-base)'));
  assert.equal(hits(direct, 'pack-dep').length, 1);
  const deep = run(withPack('Pack: fx-top, fx-base (branch re/fx-top)'));
  assert.equal(hits(deep, 'pack-dep').length, 1);
});

test('pack-dup: a lane in two packs fails', () => {
  const res = run(withPack(PACK_OK, 'Pack: fx-gate-b, fx-holder (branch re/fx-holder)'));
  assert.equal(hits(res, 'pack-dup', 'fx-gate-b').length, 1);
  assert.equal(res.examined.packs, 2);
});

test('pack-branch: the branch must be re/<one of its lanes>', () => {
  assert.equal(hits(run(withPack('Pack: fx-gate-a, fx-gate-b (branch re/fx-other)')), 'pack-branch').length, 1);
  assert.equal(hits(run(withPack('Pack: fx-gate-a, fx-gate-b (branch main)')), 'pack-branch').length, 1);
  assert.equal(hits(run(withPack('Pack: fx-gate-a, fx-gate-b (branch re/fx-gate-b)')), 'pack-branch').length, 0);
});

test('pack-line: a line that starts with Pack: but has no readable form is an error, not "no pack"', () => {
  const res = run(withPack('Pack: fx-gate-a, fx-gate-b'));
  assert.equal(hits(res, 'pack-line').length, 1);
  assert.match(hits(res, 'pack-line')[0].message, /Pack: fx-gate-a, fx-gate-b/);
});

test('held-token: seat-hold is a known form (A8), so check --table accepts it', () => {
  const res = run(mutate(['| yes | new | first-flip |', '| yes | new | seat-hold |']));
  assert.deepEqual(res.errors, []);
  assert.equal(res.examined.heldTokens, 6);
});
