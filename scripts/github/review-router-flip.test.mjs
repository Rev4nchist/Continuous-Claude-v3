// The flip test of card re-cr-keys (refuter on escape-tripwire, part c): a flip PR passes only when its config diff changes coderabbit.* keys
// and nothing else. A change to any gate list (checkpoint.critical, matrix.control_plane and the rest) or any other key fails.
// Run the fixtures: node --test scripts/github/review-router-flip.test.mjs
// Run it on a flip PR: FLIP_BASE_FILE=<config of the base> FLIP_HEAD_FILE=<config of the head> node --test scripts/github/review-router-flip.test.mjs
// Both gate lanes (re-retire-prepr-cli, re-retire-critical) run it on their flip PR. The function lives here because the lane may not touch review-router.mjs.
// Strict by the seat's ruling: every changed leaf must sit under coderabbit. A flip that needs another key is split into two PRs. An edit of _doc fails too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = JSON.parse(readFileSync(path.resolve(HERE, '..', '..', 'review-router.config.json'), 'utf8'));

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every leaf path that differs between a and b. An array and a primitive are leaves; an object is walked by key. */
function changedPaths(a, b, prefix = '') {
  if (isObject(a) && isObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => changedPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
}

/** { ok, changed, reason }. ok only when something changed and every changed leaf is "coderabbit" or starts with "coderabbit.". */
export function flipDiffOk(baseConfig, headConfig) {
  const changed = changedPaths(baseConfig, headConfig);
  if (changed.length === 0) return { ok: false, changed, reason: 'the config did not change: this is not a flip' };
  const outside = changed.filter((p) => p !== 'coderabbit' && !p.startsWith('coderabbit.'));
  return outside.length === 0 ? { ok: true, changed, reason: null } : { ok: false, changed, reason: `changed outside coderabbit.*: ${outside.join(', ')}` };
}

const clone = () => structuredClone(REAL);
const flipped = (edit) => { const head = clone(); edit(head); return head; };

test('F1 a flip that only turns coderabbit.demoted.prepr_cli from an empty list to a list of bands passes (breaks if the coderabbit prefix is not accepted)', () => {
  const r = flipDiffOk(clone(), flipped((h) => { h.coderabbit.demoted.prepr_cli = ['LOW', 'MID']; }));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.changed, ['coderabbit.demoted.prepr_cli']);
});

test('F2 the same flip plus one more glob in checkpoint.critical fails and names the path (breaks if a gate list change is let through)', () => {
  const r = flipDiffOk(clone(), flipped((h) => { h.coderabbit.demoted.prepr_cli = ['MID']; h.checkpoint.critical.push('scripts/github/new-gate.mjs'); }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /checkpoint\.critical/);
});

test('F3 a change to matrix.control_plane alone fails (breaks if only checkpoint.critical is checked)', () => {
  assert.equal(flipDiffOk(clone(), flipped((h) => { h.matrix.control_plane.push('scripts/github/x.mjs'); })).ok, false);
});

test('F4 a change to matrix.security_tier or matrix.config_files fails (breaks if the matrix lists are not covered)', () => {
  assert.equal(flipDiffOk(clone(), flipped((h) => { h.matrix.security_tier.pop(); })).ok, false);
  assert.equal(flipDiffOk(clone(), flipped((h) => { h.matrix.config_files.pop(); })).ok, false);
});

test('F5 a change to local_review.bands or to the _doc notes fails (strict: every changed leaf under coderabbit.*)', () => {
  assert.equal(flipDiffOk(clone(), flipped((h) => { h.local_review.bands = ['HIGH']; })).ok, false);
  assert.equal(flipDiffOk(clone(), flipped((h) => { h._doc.push('a new note'); })).ok, false);
});

test('F6 an identical config fails: an empty diff is not a flip (breaks if no change counts as ok)', () => {
  const r = flipDiffOk(clone(), clone());
  assert.equal(r.ok, false);
  assert.deepEqual(r.changed, []);
});

test('F7 a change to a coderabbit cap key passes and a removed or added coderabbit key passes (breaks if only existing keys are compared)', () => {
  assert.equal(flipDiffOk(clone(), flipped((h) => { h.coderabbit.cli_daily_cap_usd = 5; })).ok, true);
  assert.equal(flipDiffOk(clone(), flipped((h) => { delete h.coderabbit.blind_sample_rate; })).ok, true);
});

test('F8 a key added outside coderabbit fails (breaks if a new top-level key is ignored)', () => {
  assert.equal(flipDiffOk(clone(), flipped((h) => { h.extra_gate = { enabled: true }; })).ok, false);
});

test('live: the base and head config of a flip PR pass (runs only when FLIP_BASE_FILE and FLIP_HEAD_FILE are both set)', (t) => {
  const { FLIP_BASE_FILE: baseFile, FLIP_HEAD_FILE: headFile } = process.env;
  if (!baseFile && !headFile) { t.skip('FLIP_BASE_FILE and FLIP_HEAD_FILE are not set'); return; }
  assert.ok(baseFile && headFile, 'set both FLIP_BASE_FILE and FLIP_HEAD_FILE');
  const r = flipDiffOk(JSON.parse(readFileSync(baseFile, 'utf8')), JSON.parse(readFileSync(headFile, 'utf8')));
  assert.equal(r.ok, true, r.reason);
});
