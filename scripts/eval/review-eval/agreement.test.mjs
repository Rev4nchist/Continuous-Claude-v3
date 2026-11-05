// Tests for agreement.mjs (Cohen kappa and raw agreement). Every test names the source change that would break it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agreementOf, cohenKappa } from './agreement.mjs';

const rep = (a, b, n) => Array.from({ length: n }, () => [a, b]);

test('kappa is 1 for perfect agreement over two classes, 0 at chance level, and negative below it (breaks if the chance term is left out)', () => {
  assert.equal(cohenKappa([...rep('x', 'x', 5), ...rep('y', 'y', 5)]), 1);
  assert.equal(cohenKappa([...rep('x', 'x', 5), ...rep('x', 'y', 5), ...rep('y', 'x', 5), ...rep('y', 'y', 5)]), 0);
  assert.ok(cohenKappa([...rep('x', 'y', 5), ...rep('y', 'x', 5)]) < 0);
});

test('kappa matches the textbook 2x2 table: 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no gives 0.4 (breaks if the marginals are swapped or summed wrong)', () => {
  const k = cohenKappa([...rep('yes', 'yes', 20), ...rep('yes', 'no', 5), ...rep('no', 'yes', 10), ...rep('no', 'no', 15)]);
  assert.ok(Math.abs(k - 0.4) < 1e-12, String(k));
});

test('kappa is null when it is undefined: no pairs, or both raters use one class only (breaks if it divides by zero into NaN or 1)', () => {
  assert.equal(cohenKappa([]), null);
  assert.equal(cohenKappa(rep('x', 'x', 4)), null);
});

test('agreementOf gives n, agree, raw and kappa, and lists the keys the raters split on (breaks if a disputed key is hidden)', () => {
  const a = { k1: 'within-hunk', k2: 'same-file', k3: 'cross-file-dynamic', k4: 'same-file' };
  const b = { k1: 'within-hunk', k2: 'within-hunk', k3: 'cross-file-dynamic', k5: 'same-file' };
  const got = agreementOf(a, b);
  assert.deepEqual([got.n, got.agree, got.raw], [3, 2, 2 / 3]);
  assert.deepEqual(got.disputed, ['k2']);
  assert.equal(typeof got.kappa, 'number');
  assert.deepEqual(agreementOf({}, {}), { n: 0, agree: 0, raw: null, kappa: null, disputed: [] });
});

test('kappa is exactly 0.6 for 141 yes/yes, 19 yes/no, 9 no/yes, 31 no/no, so the kappa >= 0.6 gate accepts it (breaks if kappa is computed from float shares: that gives 0.5999999999999998)', () => {
  const k = cohenKappa([...rep('yes', 'yes', 141), ...rep('yes', 'no', 19), ...rep('no', 'yes', 9), ...rep('no', 'no', 31)]);
  assert.equal(k, 0.6);
  assert.ok(k >= 0.6);
});
