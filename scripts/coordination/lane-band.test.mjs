/**
 * lane-band.test -- the pure validators behind `lane.mjs add --band/--priority`, `seed` and `band`.
 * No database. The end-to-end proof is lane-band-probe.mjs.
 *
 *   node --test scripts/coordination/lane-band.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseBand, parsePriority, parseP0List, parseExpect } from './lane-band.mjs';

describe('parseExpect (band-backfill --apply --expect N)', () => {
  it('is required: missing or a bare flag throws and names the dry run', () => {
    assert.throws(() => parseExpect(undefined), /--expect is required.*--dry-run/);
    assert.throws(() => parseExpect(true), /--expect is required/);
  });
  it('accepts a whole number from 0 up, as a flag string', () => {
    assert.equal(parseExpect('0'), 0);
    assert.equal(parseExpect('82'), 82);
  });
  for (const bad of ['abc', '-1', '1.5', '', ' 3', '3 ', '1e2', '+4', '0x10']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseExpect(bad), /--expect must be a whole number/);
    });
  }
});

describe('parseP0List (band-backfill --p0)', () => {
  it('a missing --p0 throws: the list is required, an empty list is spelled "none"', () => {
    assert.throws(() => parseP0List(undefined), /--p0 is required/);
  });
  it('a bare --p0 (the arg parser gives true) throws', () => {
    assert.throws(() => parseP0List(true), /--p0 is required/);
  });
  it('"none" is the only way to name zero P0 lanes', () => {
    assert.deepEqual(parseP0List('none'), []);
  });
  it('splits on commas and trims spaces', () => {
    assert.deepEqual(parseP0List('a-1, b2 ,c'), ['a-1', 'b2', 'c']);
  });
  it('keeps one id as a one-item list', () => {
    assert.deepEqual(parseP0List('solo'), ['solo']);
  });
  it('rejects an empty token (a trailing comma, a double comma, an empty string)', () => {
    for (const bad of ['a,', ',a', 'a,,b', '']) assert.throws(() => parseP0List(bad), /empty id/, bad);
  });
  it('rejects a duplicate id and names it', () => {
    assert.throws(() => parseP0List('a,b,a'), /duplicate id 'a'/);
  });
  it('rejects "none" mixed with ids', () => {
    assert.throws(() => parseP0List('none,a'), /'none' cannot be mixed/);
    assert.throws(() => parseP0List('a,none'), /'none' cannot be mixed/);
  });
  it('rejects an id that is not a valid lane id (upper case, space, slash)', () => {
    for (const bad of ['Bad', 'a b', 'a/b', '-x']) assert.throws(() => parseP0List(bad), /not a valid lane id/, bad);
  });
});

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
