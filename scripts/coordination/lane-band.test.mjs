/**
 * lane-band.test -- the pure validators behind `lane.mjs add --band/--priority`, `seed` and `band`.
 * No database. The end-to-end proof is lane-band-probe.mjs.
 *
 *   node --test scripts/coordination/lane-band.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseBand, parsePriority } from './lane-band.mjs';

describe('parsePriority', () => {
  it('a missing value is "not given" (undefined), so the caller keeps the stored value', () => {
    assert.equal(parsePriority(undefined), undefined);
    assert.equal(parsePriority(null), undefined);
  });
  it('accepts a flag string and a JSON number from 1 to 999', () => {
    assert.equal(parsePriority('1'), 1);
    assert.equal(parsePriority('7'), 7);
    assert.equal(parsePriority('999'), 999);
    assert.equal(parsePriority(50), 50);
  });
  for (const bad of ['abc', '0', '-3', '1000', '', '1.5', '0x10', ' 7', '7 ', '1e2', '+5', '-0']) {
    it(`rejects the string ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parsePriority(bad), /--priority must be a whole number from 1 to 999/);
    });
  }
  for (const bad of [0, -3, 1000, 1.5, NaN, Infinity]) {
    it(`rejects the number ${bad}`, () => {
      assert.throws(() => parsePriority(bad), /whole number from 1 to 999/);
    });
  }
  it('rejects a bare flag (the arg parser gives true for `--priority` with no value)', () => {
    assert.throws(() => parsePriority(true), /\(no value\)/);
  });
  it('rejects a non-scalar seed value', () => {
    assert.throws(() => parsePriority([5]), /whole number/);
    assert.throws(() => parsePriority({}), /whole number/);
  });
  it('names the field in the message when the caller passes one', () => {
    assert.throws(() => parsePriority('x', "seed item 'a': priority"), /^Error: seed item 'a': priority must be/);
  });
});

describe('parseBand', () => {
  it('a missing value is "not given" (undefined), so the caller keeps the stored band', () => {
    assert.equal(parseBand(undefined), undefined);
    assert.equal(parseBand(null), undefined);
  });
  it('P0, P1 and P2 give themselves', () => {
    assert.equal(parseBand('P0'), 'P0');
    assert.equal(parseBand('P1'), 'P1');
    assert.equal(parseBand('P2'), 'P2');
  });
  it('"none" gives null, which is different from "not given"', () => {
    assert.equal(parseBand('none'), null);
    assert.notEqual(parseBand('none'), parseBand(undefined));
  });
  for (const bad of ['P9', 'P3', 'p0', 'p1', 'NONE', 'None', '', ' P0', 'P0 ', 'P', 0, 1]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseBand(bad), /--band must be one of P0, P1, P2 or none/);
    });
  }
  it('rejects a bare flag (`--band` with no value gives true)', () => {
    assert.throws(() => parseBand(true), /\(no value\)/);
  });
  it('names the field in the message when the caller passes one', () => {
    assert.throws(() => parseBand('P9', 'band'), /^Error: band must be one of/);
  });
});
