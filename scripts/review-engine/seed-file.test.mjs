// Tests for lib/seed.mjs: the seed items, the edge seam and the output shape.
// The CLI cases (a lint-error map gives exit 1 and writes no file; --edges-out gives exit 5)
// belong to program-cli.test.mjs. Run: node --test scripts/review-engine/seed-file.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMap } from './lib/map-parse.mjs';
import { seedItems, buildEdges, renderSeed, assertProgramRule } from './lib/seed.mjs';
import { rankOf } from './lib/rank.mjs';

const FIXTURE = new URL('./fixtures/map.fixture.md', import.meta.url);
const LF = readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n');
const model = parseMap(LF);
const SHA = '0123456789abcdef0123456789abcdef01234567';
const CTX = { sha: SHA, ref: 'main', project: 'continuous-claude', testMode: false };
const items = seedItems(model, CTX);
const item = (id, list = items) => list.find((i) => i.id === id);
// Every key test reads the file form: an undefined value would pass on the object and vanish in the file.
const fromFile = (list, edges = [], shape = 'array') => JSON.parse(renderSeed(list, edges, shape));

test('S1 one item per Waves lane, none for externals or dropped lanes', () => {
  assert.equal(items.length, 7);
  assert.deepEqual(items.map((i) => i.id), model.lanes.map((l) => l.id));
  assert.equal(item('fx-ext'), undefined);
  assert.equal(item('fx-gone'), undefined);
});

test('S2 every item is blocked, held or not', () => {
  assert.deepEqual([...new Set(items.map((i) => i.state))], ['blocked']);
  assert.equal(item('fx-base').state, 'blocked');
  assert.equal(item('fx-mid').state, 'blocked');
});

test('S3 the exact key set that lane.mjs seed reads', () => {
  const want = ['branch', 'doneWhen', 'id', 'note', 'project', 'rationale', 'scope', 'state', 'title', 'track'];
  for (const it of fromFile(items)) {
    assert.deepEqual(Object.keys(it).sort(), want);
    for (const k of want) assert.equal(typeof it[k], 'string', `${it.id}.${k}`);
  }
});

test('S4 no band and no priority, so the stored rank stays', () => {
  for (const it of fromFile(items)) {
    assert.equal('band' in it, false);
    assert.equal('priority' in it, false);
  }
});

test('S5 track is review-engine, never left to default to unsorted', () => {
  for (const it of fromFile(items)) assert.equal(it.track, 'review-engine');
});

test('S5b field values: title, scope, branch, doneWhen, project, rationale', () => {
  const base = item('fx-base');
  assert.equal(base.title, 'Base tool: builds the fixture tool');
  assert.equal(base.scope, 'Owns: fixture/tool.mjs, fixture/tool.test.mjs');
  assert.equal(base.branch, 're/fx-base');
  assert.equal(base.doneWhen, 'The tool test passes.');
  assert.equal(base.project, 'continuous-claude');
  assert.equal(base.rationale,
    'Wave 0, phase GATE. Depends on: none. Held until: none. Needs Dave: no. '
    + 'Map: docs/review-engine/map.md "### fx-base" at main@0123456789ab.');
  assert.equal(item('fx-mid').scope, 'Owns: fixture/tool.mjs (fixes only)');
  assert.equal(item('fx-gate-a').scope, 'Owns: fixture/config.json (the gate_a key only)');
  assert.equal(item('fx-holder').scope, 'Owns: none');
  assert.match(item('fx-top').rationale, /Depends on: fx-mid, fx-gate-a\. Held until: fx-gate-b; fx-base if DP2\.4 = yes\. Needs Dave: no\./);
  assert.match(item('fx-gate-a').rationale, /Needs Dave: yes\./);
});

test('S5c notes: a held lane names its hold, the others say blocked until GO', () => {
  assert.equal(item('fx-base').note, 'seeded from map main@0123456; blocked until GO');
  assert.equal(item('fx-mid').note, 'seeded from map main@0123456; held: dave-yes');
});

test('S5d a section with no subtitle falls back to the id for the title', () => {
  const bare = parseMap(LF.replace('**Base tool: builds the fixture tool** (wave 0, phase GATE, new)\n', ''));
  assert.equal(seedItems(bare, CTX)[0].title, 'fx-base');
});

test('S7 the default shape is the object form; the array form stays available', () => {
  const dflt = JSON.parse(renderSeed(items, buildEdges(model)));
  assert.equal(Array.isArray(dflt), false);
  assert.deepEqual(Object.keys(dflt).sort(), ['edges', 'lanes']);
  assert.equal(dflt.edges.length, 7);
  const text = renderSeed(items, buildEdges(model), 'array');
  assert.equal(typeof text, 'string');
  assert.equal(text.endsWith('\n'), true);
  const parsed = JSON.parse(text);
  assert.equal(Array.isArray(parsed), true);
  assert.deepEqual(parsed.map((i) => i.id), ['fx-base', 'fx-keys', 'fx-mid', 'fx-gate-a', 'fx-gate-b', 'fx-top', 'fx-holder']);
  assert.equal(parsed[0].title, 'Base tool: builds the fixture tool');
  assert.equal(parsed[0].state, 'blocked');
});

test('S7b shape object gives {lanes, edges} and every edge.lane is a seeded lane', () => {
  const edges = buildEdges(model);
  const parsed = fromFile(items, edges, 'object');
  assert.deepEqual(Object.keys(parsed).sort(), ['edges', 'lanes']);
  assert.equal(parsed.lanes.length, 7);
  assert.equal(parsed.edges.length, 7);
  const ids = new Set(parsed.lanes.map((l) => l.id));
  for (const e of parsed.edges) assert.equal(ids.has(e.lane), true, e.lane);
});

test('S7c an unknown shape is refused', () => {
  assert.throws(() => renderSeed(items, [], 'yaml'), /shape/);
});


test('S9 buildEdges gives the exact sorted pairs; holds are not edges', () => {
  assert.deepEqual(buildEdges(model), [
    { lane: 'fx-gate-a', dependsOn: 'fx-keys' },
    { lane: 'fx-gate-b', dependsOn: 'fx-keys' },
    { lane: 'fx-holder', dependsOn: 'fx-mid' },
    { lane: 'fx-mid', dependsOn: 'fx-base' },
    { lane: 'fx-mid', dependsOn: 'fx-ext' },
    { lane: 'fx-top', dependsOn: 'fx-gate-a' },
    { lane: 'fx-top', dependsOn: 'fx-mid' },
  ]);
});

test('S9b buildEdges sorts by code unit, not by locale', () => {
  const m = parseMap(LF.replace('| 0 | `fx-keys` | P3 | none |', '| 0 | `fx-keys` | P3 | FX-zed, fx-base |'));
  const pairs = buildEdges(m).filter((e) => e.lane === 'fx-keys');
  assert.deepEqual(pairs.map((e) => e.dependsOn), ['FX-zed', 'fx-base']);
});

test('T1 test mode marks every note, held or not; live mode never does', () => {
  const test = seedItems(model, { ...CTX, testMode: true });
  for (const it of test) assert.equal(it.note.startsWith('TEST MODE seed; '), true, it.id);
  assert.equal(item('fx-base', test).note, 'TEST MODE seed; seeded from map main@0123456; blocked until GO');
  assert.equal(item('fx-mid', test).note, 'TEST MODE seed; seeded from map main@0123456; held: dave-yes');
  // lane.mjs keeps the stored note on conflict but overwrites rationale, so the marker must be in rationale too (C1).
  for (const it of test) assert.equal(it.rationale.startsWith('TEST MODE seed; Wave '), true, it.id);
  assert.equal(item('fx-base', test).rationale, `TEST MODE seed; ${item('fx-base').rationale}`);
  for (const it of items) assert.equal(it.rationale.includes('TEST MODE'), false);
  for (const it of items) assert.equal(it.note.includes('TEST MODE'), false);
  assert.equal(seedItems(model, { sha: SHA }).every((i) => !i.note.includes('TEST MODE')), true);
});

test('T2 a map read from a file has no sha: no "undefined", no path in the output', () => {
  const text = renderSeed(seedItems(model, { testMode: true, project: 'continuous-claude' }), [], 'array');
  assert.equal(text.includes('undefined'), false);
  assert.equal(text.includes('main@'), false);
  assert.equal(/[A-Za-z]:[\\/]|\\\\/.test(text), false);
  assert.match(fromFile(seedItems(model, { testMode: true }))[0].note, /^TEST MODE seed; seeded from map file; blocked until GO$/);
});

test('T3 project defaults to continuous-claude and follows ctx.project', () => {
  assert.equal(seedItems(model, { sha: SHA })[0].project, 'continuous-claude');
  assert.equal(seedItems(model, { sha: SHA, project: 'other' })[0].project, 'other');
});

// ---- part 2: pack branch, rank, program rule

const PACKED = parseMap(LF.replace('## Dropped or merged lanes', 'Pack: fx-gate-a, fx-gate-b (branch re/fx-gate-a)\n\n## Dropped or merged lanes'));

test('S11 both lanes of a pack get the pack branch; every other lane keeps re/<id>', () => {
  const list = seedItems(PACKED, CTX);
  assert.equal(item('fx-gate-a', list).branch, 're/fx-gate-a');
  assert.equal(item('fx-gate-b', list).branch, 're/fx-gate-a');
  assert.equal(item('fx-base', list).branch, 're/fx-base');
  assert.equal(item('fx-gate-b').branch, 're/fx-gate-b', 'the same map with no Pack line');
});

test('S4b no item has a band key, also with a rank', () => {
  const rank = { 'fx-base': 5, 'fx-top': 900 };
  for (const it of fromFile(seedItems(model, { ...CTX, rank }))) assert.equal('band' in it, false, it.id);
});

test('S4c no priority key without a rank; a rank writes priority for the ranked ids only', () => {
  for (const it of fromFile(seedItems(model, CTX))) assert.equal('priority' in it, false, it.id);
  const ranked = fromFile(seedItems(model, { ...CTX, rank: { 'fx-base': 5, 'fx-top': 900 } }));
  assert.equal(ranked.find((i) => i.id === 'fx-base').priority, 5);
  assert.equal(ranked.find((i) => i.id === 'fx-top').priority, 900);
  for (const it of ranked.filter((i) => !['fx-base', 'fx-top'].includes(i.id))) assert.equal('priority' in it, false, it.id);
});

test('R2 a packages.json rank gives priority 10 + position, externals counted but not written', () => {
  const pkg = {
    packageOrder: { ids: ['p1', 'p2'] },
    packages: [{ id: 'p1', lanes: ['fx-base', 'fx-keys'] }, { id: 'p2', lanes: ['fx-mid', 'fx-ext'] }],
  };
  const { rank, errors, notes } = rankOf(pkg, model);
  assert.deepEqual(errors, []);
  assert.equal(notes.some((n) => n.includes('fx-ext')), true);
  const list = fromFile(seedItems(model, { ...CTX, rank }));
  assert.deepEqual(list.filter((i) => 'priority' in i).map((i) => [i.id, i.priority]), [['fx-base', 10], ['fx-keys', 11], ['fx-mid', 12]]);
  assert.equal(list.some((i) => i.id === 'fx-ext'), false);
});

test('R3 a rank for an unknown lane is an error from rankOf, and seedItems never invents an item for it', () => {
  assert.match(rankOf({ 'fx-nope': 5 }, model).errors[0], /fx-nope.*not a map lane/);
  const list = seedItems(model, { ...CTX, rank: { 'fx-nope': 5, 'fx-ext': 6 } });
  assert.equal(list.length, 7);
  assert.equal(list.some((i) => 'priority' in i), false);
});

test('S2b the program rule assert fires on a hand-edited item', () => {
  assert.doesNotThrow(() => assertProgramRule(items));
  const bad = (over) => assert.throws(() => assertProgramRule([{ ...items[0], ...over }]), /program rule/);
  bad({ state: 'backlog' });
  bad({ state: undefined });
  bad({ track: 'unsorted' });
  bad({ band: 'P0' });
  bad({ priority: 0 });
  bad({ priority: 1000 });
  bad({ priority: 2.5 });
  assert.doesNotThrow(() => assertProgramRule([{ ...items[0], priority: 999 }]));
});

test('S2c seedItems runs the assert itself: a rank that is not a whole number in range stops the build', () => {
  assert.throws(() => seedItems(model, { ...CTX, rank: { 'fx-base': 5000 } }), /program rule/);
});
