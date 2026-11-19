// Tests for the price of the ship-ask paid-round question (card prflow-paid-run-guard, PR 2, step f and the priced yes).
// Run: node --test scripts/github/ship-ask-paid-price.test.mjs
//
// How the unit can fail, and the test that catches it:
//   the Yes label prices the FILTERED file count, so a PR with filtered files shows a cap below the cost `post` compares     -> SP1
//   with no unfiltered count in the data, the label loses its price or breaks old data                                       -> SP2
//   the Yes label names no price (no price, no yes), or the Yes description still tells the model to post by hand            -> SP3
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ship = await import(pathToFileURL(path.join(HERE, 'ship-ask.mjs')).href);
const D = await import(pathToFileURL(path.join(HERE, 'lib', 'decisions.mjs')).href);

const BASE = { pr: 349, round: 1, today: 0, paidRounds: 0, verdict: 'ALLOW', reasons: [], caps: { round: 5, day: 15, rounds: 2 } };
const yesOf = (spec) => spec.options.find((o) => /^Yes/.test(o.label));

test('SP1: the Yes label and the question price the UNFILTERED file count (total), not the billable count', () => {
  const spec = ship.paidRoundSpec({ ...BASE, files: 4, total: 14 });
  assert.equal(yesOf(spec).label, 'Yes, pay up to $3.50');
  assert.match(spec.question, /14 files x \$0\.25 = up to \$3\.50/);
  assert.equal(D.capCentsOfLabel(yesOf(spec).label), 350);
});

test('SP2: with no total in the data the count is the billable one (old data keeps its price)', () => {
  assert.equal(yesOf(ship.paidRoundSpec({ ...BASE, files: 17 })).label, 'Yes, pay up to $4.25');
});

test('SP3: the Yes row names a price the store can read, and tells the model to post only with cr-paid.mjs post', () => {
  const yes = yesOf(ship.paidRoundSpec({ ...BASE, files: 8, total: 8 }));
  assert.notEqual(D.capCentsOfLabel(yes.label), null);
  assert.match(yes.description, /cr-paid\.mjs post --pr 349/);
  assert.doesNotMatch(yes.description, /cr-paid\.mjs record/);
  const none = ship.paidRoundSpec({ pr: 349, verdict: null, reason: 'gh failed' });
  assert.equal(yesOf(none), undefined, 'no verdict: no Yes row');
});
