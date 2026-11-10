/**
 * lane-seed-file.test -- the pure seed-file parser and the cycle finder. No database.
 * Contract: .claudedocs/re-execution/contracts/t2.1-contract.md, "Point 2" (File rules 1 to 5, Parser).
 *
 *   node --test scripts/coordination/lane-seed-file.test.mjs
 *
 * One test per failure. Each test would fail if its rule in parseSeedFile or findCycle changed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeedFile, findCycle } from './lane-seed-file.mjs';

const lanes = (...ids) => ids.map((id) => ({ id, title: id }));
const edge = (lane, dependsOn) => ({ lane, dependsOn });
const obj = (l, e) => ({ lanes: l, edges: e });

describe('parseSeedFile: the top level', () => {
  it('an array passes through unchanged as the array form', () => {
    const items = lanes('a', 'b');
    const out = parseSeedFile(items);
    assert.equal(out.form, 'array');
    assert.deepEqual(out.lanes, items);
    assert.equal('edges' in out, false);
  });
  it('a wrong top-level type keeps the old words "JSON array of lanes"', () => {
    for (const bad of ['text', 42, null, true]) {
      assert.throws(() => parseSeedFile(bad), /JSON array of lanes/);
    }
  });
  it('an object with a missing key is refused (no edges, then no lanes)', () => {
    assert.throws(() => parseSeedFile({ lanes: [] }), /missing key "edges"/);
    assert.throws(() => parseSeedFile({ edges: [] }), /missing key "lanes"/);
  });
  it('an object with an unknown key is refused', () => {
    assert.throws(() => parseSeedFile({ lanes: [], edges: [], extra: 1 }), /unknown key "extra"/);
  });
  it('a non-array value for lanes or edges is refused', () => {
    assert.throws(() => parseSeedFile({ lanes: {}, edges: [] }), /"lanes" must be an array/);
    assert.throws(() => parseSeedFile({ lanes: [], edges: 'x' }), /"edges" must be an array/);
  });
});

describe('parseSeedFile: lanes (rule 2)', () => {
  it('a duplicate lane id is refused', () => {
    assert.throws(() => parseSeedFile(obj(lanes('a', 'b', 'a'), [])), /duplicate lane id "a"/);
  });
});

describe('parseSeedFile: edge shape (rule 3)', () => {
  const run = (e) => parseSeedFile(obj(lanes('a', 'b'), [e]));
  it('an edge with a missing key, an extra key or a wrong key is refused', () => {
    assert.throws(() => run({ lane: 'a' }), /edges\[0\].*exactly the keys "lane" and "dependsOn"/);
    assert.throws(() => run({ lane: 'a', dependsOn: 'b', note: 'x' }), /edges\[0\].*exactly the keys/);
    assert.throws(() => run({ lane: 'a', depends_on: 'b' }), /edges\[0\].*exactly the keys/);
  });
  it('an edge that is not an object is refused', () => {
    for (const bad of ['a', null, 7, ['a', 'b']]) assert.throws(() => run(bad), /edges\[0\] must be an object/);
  });
  it('the id rule: a value must be a string that matches ^[a-z0-9][a-z0-9-]*$', () => {
    assert.throws(() => run({ lane: 'A', dependsOn: 'b' }), /edges\[0\].*lane.*not a valid lane id/);
    assert.throws(() => run({ lane: 'a', dependsOn: '-b' }), /edges\[0\].*dependsOn.*not a valid lane id/);
    assert.throws(() => run({ lane: 'a', dependsOn: 'b c' }), /not a valid lane id/);
    assert.throws(() => run({ lane: 'a', dependsOn: 5 }), /not a valid lane id/);
    assert.throws(() => run({ lane: 'a', dependsOn: '' }), /not a valid lane id/);
  });
});

describe('parseSeedFile: edge meaning (rules 4 and 5)', () => {
  it('edge.lane that is not in lanes is refused', () => {
    assert.throws(() => parseSeedFile(obj(lanes('a'), [edge('zzz', 'a')])), /edges\[0\].*lane "zzz" is not in lanes/);
  });
  it('edge.dependsOn may name an id outside lanes', () => {
    const out = parseSeedFile(obj(lanes('a'), [edge('a', 'hf-judge-precheck')]));
    assert.deepEqual(out.edges, [edge('a', 'hf-judge-precheck')]);
  });
  it('a self-edge is refused', () => {
    assert.throws(() => parseSeedFile(obj(lanes('a'), [edge('a', 'a')])), /edges\[0\].*"a" depends on itself/);
  });
});

describe('parseSeedFile: duplicate edges', () => {
  it('a duplicate edge is dropped and counted; the first stays, in file order', () => {
    const e = [edge('b', 'a'), edge('c', 'a'), edge('b', 'a'), edge('c', 'b'), edge('c', 'a')];
    const out = parseSeedFile(obj(lanes('a', 'b', 'c'), e));
    assert.equal(out.form, 'object');
    assert.deepEqual(out.edges, [edge('b', 'a'), edge('c', 'a'), edge('c', 'b')]);
    assert.equal(out.dropped, 2);
  });
  it('no duplicate gives dropped 0 and the lanes come back as given', () => {
    const l = lanes('a', 'b');
    const out = parseSeedFile(obj(l, [edge('b', 'a')]));
    assert.equal(out.dropped, 0);
    assert.deepEqual(out.lanes, l);
  });
  it('an empty object form is valid', () => {
    assert.deepEqual(parseSeedFile(obj([], [])), { form: 'object', lanes: [], edges: [], dropped: 0 });
  });
});

describe('findCycle', () => {
  it('no edges, and a chain, give null', () => {
    assert.equal(findCycle([]), null);
    assert.equal(findCycle([edge('a', 'b'), edge('b', 'c')]), null);
  });
  it('a diamond is not a cycle', () => {
    const d = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')];
    assert.equal(findCycle(d), null);
  });
  it('a cycle of length 2 returns a path that starts and ends with the same id', () => {
    assert.deepEqual(findCycle([edge('a', 'b'), edge('b', 'a')]), ['a', 'b', 'a']);
  });
  it('a cycle of length 3 returns the whole loop', () => {
    assert.deepEqual(findCycle([edge('c', 'a'), edge('a', 'b'), edge('b', 'c')]), ['a', 'b', 'c', 'a']);
  });
  it('the result does not depend on the edge order (ids are visited in sorted order)', () => {
    const e = [edge('b', 'c'), edge('c', 'b'), edge('a', 'b')];
    assert.deepEqual(findCycle(e), ['b', 'c', 'b']);
    assert.deepEqual(findCycle([...e].reverse()), ['b', 'c', 'b']);
  });
  it('a node with 2 out-edges into 2 cycles reports the lower id first (the adjacency lists are sorted)', () => {
    // Fails when the per-node list sort is removed: a->c is listed before a->b.
    assert.deepEqual(findCycle([edge('a', 'c'), edge('a', 'b'), edge('b', 'a'), edge('c', 'a')]), ['a', 'b', 'a']);
  });
  it('2 separate cycles give the same answer in both edge orders (the start ids are sorted)', () => {
    // Fails when the key sort is removed: the c-d cycle is listed first.
    const e = [edge('c', 'd'), edge('d', 'c'), edge('a', 'b'), edge('b', 'a')];
    assert.deepEqual(findCycle(e), ['a', 'b', 'a']);
    assert.deepEqual(findCycle([...e].reverse()), ['a', 'b', 'a']);
  });
  it('one key named "dependsOn,lane" does not pass the exact-keys check', () => {
    assert.throws(() => parseSeedFile({ lanes: [{ id: 'a' }], edges: [{ 'dependsOn,lane': 'x' }] }), /exactly the keys/);
  });
  it('a cycle that hangs off a tail is found, and the path holds only the loop', () => {
    assert.deepEqual(findCycle([edge('a', 'x'), edge('x', 'y'), edge('y', 'x')]), ['x', 'y', 'x']);
  });
  it('no cycle runs through an id outside the lanes (it has no outgoing edge)', () => {
    const e = [edge('a', 'hf-judge-precheck'), edge('b', 'hf-judge-precheck'), edge('a', 'b')];
    assert.equal(findCycle(e), null);
  });
});
