// Tests for the cli-skip step of ship-ask.mjs and the store (card prflow-cli-partial-run-rule, rule B).
// Design note: .claudedocs/e2e-prflow-cli-skip-decision/01-design-note.md. Own file: ship-ask.test.mjs and decisions.test.mjs stay as they are.
// Run: node --test scripts/github/ship-ask-cli-skip.test.mjs
//
// How the unit can fail, and the test that catches it:
//   the store refuses the step, so no offer can be written and no tap recorded                -> S1
//   the question is asked with no flag stamp, or for another head, or for a cap stamp           -> S2
//   the question hides the branch, the head, the runs spent or the unreviewed files             -> S3
//   the allow label is not exact, or no option keeps the CLI review, or recommended is not first -> S3
//   a PR number is accepted (the step binds to a branch)                                         -> S4
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.CCV3_DECISIONS_FILE = path.join(mkdtempSync(path.join(os.tmpdir(), 'cli-skip-store-')), 'decisions.json');
const { STEPS, offerWrite, decisionRecord, decisionRead, decisionUse, decisionKey } = await import('./lib/decisions.mjs');
const { planOf, STORE_STEP } = await import('./ship-ask.mjs');

const HEAD = 'c'.repeat(40);
const data = (over = {}) => ({ branch: 'feat/x', head: HEAD, stampHead: HEAD, stampSkip: 'flag', runsSpent: 2, unreviewed: 3, ...over });
const SKIP = 'Skip the CLI review for this head';
const KEEP = 'Keep the CLI review';

test('S1: the store knows the step cli-skip: an offer opens, the exact label records, the tap is used once', () => {
  // Breaks when: STEPS lacks cli-skip (offerWrite refuses, decisionRecord has no offer).
  assert.ok(STEPS.includes('cli-skip'));
  assert.equal(STORE_STEP['cli-skip'], 'cli-skip');
  const key = decisionKey({ branch: 'feat/s1' });
  const plan = planOf('cli-skip', data({ branch: 'feat/s1' }), { branch: 'feat/s1' });
  assert.equal(plan.refuse, undefined);
  const w = offerWrite({ step: 'cli-skip', key, head: HEAD, spec: plan.spec });
  assert.equal(w.ok, true, JSON.stringify(w));
  const label = plan.spec.options.map((o) => o.label).find((l) => l.startsWith(SKIP));
  assert.equal(decisionRecord({ step: 'cli-skip', key, head: HEAD, label }).ok, true);
  assert.equal(decisionRead({ step: 'cli-skip', key, head: HEAD })?.label, label);
  assert.equal(decisionUse({ step: 'cli-skip', key, head: HEAD }).ok, true);
  assert.equal(decisionRead({ step: 'cli-skip', key, head: HEAD }), null, 'used up');
});

test('S2: no question without a flag stamp for this head', () => {
  // Breaks when: planOf asks although pre-pr --skip-cr has not written a flag stamp at the branch head.
  for (const over of [{ stampHead: null }, { stampHead: 'd'.repeat(40) }, { stampSkip: 'cap' }, { stampSkip: null }, { stampSkip: 'docs-only' }]) {
    const plan = planOf('cli-skip', data(over), { branch: 'feat/x' });
    assert.ok(plan.refuse, JSON.stringify(over));
    assert.match(plan.refuse, /skip-cr/);
  }
  assert.ok(planOf('cli-skip', { ...data(), missing: true, branch: 'feat/x' }, { branch: 'feat/x' }).refuse, 'a missing branch');
});

test('S3: the question names branch, head, runs and unreviewed files; two options with the exact labels', () => {
  // Breaks when: a fact is missing from the text, the allow label changes, there is no keep option, or the recommended option is not first.
  const plan = planOf('cli-skip', data(), { branch: 'feat/x' });
  const text = `${plan.spec.header}\n${plan.spec.question}`;
  assert.ok(plan.spec.header.length <= 12);
  assert.ok(plan.spec.question.split('\n').length <= 4);
  for (const fact of ['feat/x', HEAD.slice(0, 7), '2 CLI runs', '3 file']) assert.ok(text.includes(fact), fact);
  assert.equal(plan.spec.options.length, 2);
  const labels = plan.spec.options.map((o) => o.label.replace(/ \(Recommended\)$/, ''));
  assert.deepEqual([...labels].sort(), [KEEP, SKIP].sort());
  // Recommended is the first option: the skip when the cap is spent (no CLI path is left), else keeping the review.
  assert.ok(plan.spec.options[0].label.endsWith('(Recommended)'));
  assert.equal(plan.spec.options[0].label.startsWith(SKIP), true, 'runs spent 2: the skip is recommended');
  const few = planOf('cli-skip', data({ runsSpent: 0 }), { branch: 'feat/x' });
  assert.equal(few.spec.options[0].label.startsWith(KEEP), true, 'no run spent: keep the review');
  assert.equal(plan.key, decisionKey({ branch: 'feat/x' }));
  assert.equal(plan.head, HEAD);
});
