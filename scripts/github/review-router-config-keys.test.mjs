// Tests for the keys that card re-cr-keys adds to review-router.config.json, each at its off value.
// Run: node --test scripts/github/review-router-config-keys.test.mjs
// No git call and no network: the test reads the config of the checkout it runs in (CI checks out shallow, on Linux).
// "No existing value changed" is proved by the card's byte check (.claudedocs/e2e-re-cr-keys/), not here.
// local_review.union_runs and local_review.hotfile_pass are NOT keys of this card: they change the reviewer-set hash (engine-version.mjs,
// EXEMPT_LOCAL_REVIEW_KEYS) and go to re-p5-multirun with their consumer (seat ruling, option B).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(path.resolve(HERE, '..', '..', 'review-router.config.json'), 'utf8'));
const DOC = CONFIG._doc.join('\n');
const BANDS = ['LOW', 'MID', 'ELEVATED', 'HIGH', 'CRITICAL'];

// Two kinds of test. The shape test below holds for every config, flipped or not: a flip PR leaves it alone.
// The five off-value tests after it pin each key at off. A gate lane (re-retire-prepr-cli, re-retire-critical) edits its own pin in its flip PR,
// together with the flip of the key. That edit is the lane's explicit step: a flip PR that does not edit the pin fails CI here.
test('the shape of every new key holds in any state (breaks if a key changes type or leaves its range, flipped or not)', () => {
  assert.equal(typeof CONFIG.engine_gate?.report_only, 'boolean');
  assert.equal(typeof CONFIG.coderabbit?.demoted?.critical, 'boolean');
  assert.equal(typeof CONFIG.routing?.calibrated_cutoff, 'boolean');
  const list = CONFIG.coderabbit?.demoted?.prepr_cli;
  assert.ok(Array.isArray(list) && list.every((b) => BANDS.includes(b)), 'prepr_cli is a list of risk bands from LOW to CRITICAL');
  const rate = CONFIG.coderabbit?.blind_sample_rate;
  assert.ok(typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 1, 'blind_sample_rate is a number in [0, 1]');
});

test('engine_gate.report_only is the boolean true (breaks if the key is missing, a string or false: the gate would not start in report-only mode)', () => {
  assert.equal(CONFIG.engine_gate?.report_only, true);
});

test('coderabbit.demoted.prepr_cli is an empty array, a list of risk bands (breaks if it is false, null or holds a band: DP1.15)', () => {
  const list = CONFIG.coderabbit?.demoted?.prepr_cli;
  assert.ok(Array.isArray(list), 'a list of risk bands, not a boolean');
  assert.deepEqual(list, []);
});

test('coderabbit.demoted.critical is the boolean false (breaks if it is missing, a list or true)', () => {
  assert.equal(CONFIG.coderabbit?.demoted?.critical, false);
});

test('coderabbit.blind_sample_rate is the number 0, inside [0, 1] (breaks if it is a string, above 1, below 0 or not 0)', () => {
  const rate = CONFIG.coderabbit?.blind_sample_rate;
  assert.equal(typeof rate, 'number');
  assert.ok(Number.isFinite(rate) && rate >= 0 && rate <= 1, `rate ${rate} must be a number in [0, 1]`);
  assert.equal(rate, 0);
});

test('routing.calibrated_cutoff is the boolean false (breaks if it is missing, a string or true)', () => {
  assert.equal(CONFIG.routing?.calibrated_cutoff, false);
});

test('coderabbit.demoted has no high key in any case (breaks if the dropped HIGH gate is added back)', () => {
  const keys = Object.keys(CONFIG.coderabbit?.demoted ?? {});
  assert.deepEqual(keys.filter((k) => k.toLowerCase() === 'high'), []);
});

test('each of the five keys has a description in the _doc notes of the config (breaks if one of them loses its note)', () => {
  for (const key of ['engine_gate.report_only', 'coderabbit.demoted.prepr_cli', 'coderabbit.demoted.critical', 'coderabbit.blind_sample_rate', 'routing.calibrated_cutoff']) {
    assert.ok(DOC.includes(key), `_doc has no line for ${key}`);
  }
});
