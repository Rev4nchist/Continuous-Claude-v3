// Pins the time limits of the slow pre-pr gates (card test-globs-followups, item 12).
// Run: node --test scripts/github/pre-pr-gate-limits.test.mjs
//
// Way it can fail: the review-eval-tests gate keeps a limit below its run time. On 2026-11-15 the suite took 385 s alone (1899 of 1899
// pass) against a 5 minute limit, so every branch that touched scripts/eval/review-eval failed pre-pr with "timed out after 5 min".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SURFACES } from './pre-pr.mjs';

const MIN = 60_000;
const gateById = (id) => SURFACES.flatMap((s) => s.gates ?? []).find((g) => g.id === id);

test('GL1: the review-eval-tests gate allows 10 minutes (the suite took 385 s alone on 2026-11-15)', () => {
  const gate = gateById('review-eval-tests');
  assert.ok(gate, 'the gate exists');
  assert.equal(gate.timeoutMs, 10 * MIN, `review-eval-tests limit is ${gate.timeoutMs / MIN} min`);
});
