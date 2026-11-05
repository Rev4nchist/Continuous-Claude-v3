// Unit test for the pure helper in probe-boards.mjs. No database.
// CodeRabbit PR 297, dm-delivery-probe.mjs:186: an inbox read that failed or returned junk must not count as "message absent".
// The test fails if jsonArrayOf stops checking the exit code or the JSON shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonArrayOf } from './probe-boards.mjs';

test('jsonArrayOf returns the array of a successful read, empty or not', () => {
  assert.deepEqual(jsonArrayOf({ code: 0, out: '[]' }), []);
  assert.deepEqual(jsonArrayOf({ code: 0, out: '[{"body":"x"}]' }), [{ body: 'x' }]);
});

test('jsonArrayOf returns null for a failed read, even when its stdout is a valid empty array', () => {
  assert.equal(jsonArrayOf({ code: 1, out: '[]' }), null);
  assert.equal(jsonArrayOf({ code: null, out: '[]' }), null);
});

test('jsonArrayOf returns null for output that is not a JSON array', () => {
  assert.equal(jsonArrayOf({ code: 0, out: 'not json' }), null);
  assert.equal(jsonArrayOf({ code: 0, out: '' }), null);
  assert.equal(jsonArrayOf({ code: 0, out: '{"lanes":[]}' }), null);
  assert.equal(jsonArrayOf({ code: 0, out: 'null' }), null);
  assert.equal(jsonArrayOf({ code: 0 }), null);
});
