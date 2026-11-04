import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertScratchUrl } from './scratch-db.mjs';

const U = (db) => `postgresql://claude:x@localhost:5432/${db}`;

test('accepts a scratch database name', () => {
  assert.equal(assertScratchUrl(U('lanes_pr1_0123abcd')), 'lanes_pr1_0123abcd');
});

test('refuses the live database and look-alikes', () => {
  for (const db of ['continuous_claude', 'postgres', 'xlanes_pr1_0123abcd', 'lanes_pr1', '', 'LANES_PR1_ABCD']) {
    assert.throws(() => assertScratchUrl(U(db)), /refusing/, db);
  }
});

test('refuses a name that could break out of the quoted identifier', () => {
  assert.throws(() => assertScratchUrl(U('lanes_pr1_x%22%3B%20DROP%20DATABASE%20continuous_claude')), /refusing/);
});

test('refuses an unparseable URL', () => {
  assert.throws(() => assertScratchUrl('not a url'), /refusing/);
});

import { maskUrl } from './scratch-db.mjs';

test('maskUrl hides the password and keeps host and database', () => {
  assert.equal(maskUrl('postgresql://claude:s3cret@localhost:5432/lanes_pr1_ab'), 'postgresql://claude:***@localhost:5432/lanes_pr1_ab');
});
