// The flip test of card re-cr-keys (refuter on escape-tripwire, part c): a flip PR passes only when its config diff changes the flip keys
// (coderabbit.demoted.* and coderabbit.blind_sample_rate) and nothing else. A change to any gate list (checkpoint.critical, matrix.control_plane and the rest) or any other key fails.
// Run the fixtures: node --test scripts/github/review-router-flip.test.mjs
// Run it on a flip PR: FLIP_BASE_FILE=<config of the base> FLIP_HEAD_FILE=<config of the head> node --test scripts/github/review-router-flip.test.mjs
// Both gate lanes (re-retire-prepr-cli, re-retire-critical) run it on their flip PR. The function lives here because the lane may not touch review-router.mjs.
// Strict by the seat's ruling (option 2): the only flip paths are coderabbit.demoted.* and coderabbit.blind_sample_rate. Any other changed, added or removed leaf fails,
// the paid caps (coderabbit.cli_daily_cap_usd, coderabbit.monthly_file_cap) and the whole coderabbit block included: a missing cap means no cap on paid CLI runs.
// A flip that needs another key, or a cap change, goes in its own PR. An edit of _doc fails too.
// In CI the live case below always skips (no step sets the two variables): a gate lane runs it by hand on its flip PR and reads the skip count.
// Make the two files with pwsh or git show <ref>:review-router.config.json | Out-File -Encoding utf8NoBOM <file>. Windows PowerShell 5.1 writes UTF-16 and JSON.parse throws.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = JSON.parse(readFileSync(path.resolve(HERE, '..', '..', 'review-router.config.json'), 'utf8'));

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every leaf path that differs between a and b, as an array of key segments (a key with a dot stays one segment). An array and a primitive are leaves; an object is walked by key. */
function changedPaths(a, b, prefix = []) {
  if (isObject(a) && isObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => changedPaths(a[k], b[k], [...prefix, k]));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
}

/** A flip path: anything under coderabbit.demoted, or the leaf coderabbit.blind_sample_rate. Nothing else, so no paid cap (cli_daily_cap_usd, monthly_file_cap) can change in a flip PR. */
const isFlipPath = (p) => p[0] === 'coderabbit' && (p[1] === 'demoted' || (p.length === 2 && p[1] === 'blind_sample_rate'));

/** { ok, changed, reason }. changed lists every changed, added or removed leaf as a dotted path. ok only when something changed and every changed leaf is a flip path. */
export function flipDiffOk(baseConfig, headConfig) {
  const paths = changedPaths(baseConfig, headConfig);
  const changed = paths.map((p) => p.join('.'));
  if (paths.length === 0) return { ok: false, changed, reason: 'the config did not change: this is not a flip' };
  const outside = paths.filter((p) => !isFlipPath(p)).map((p) => p.join('.'));
  return outside.length === 0 ? { ok: true, changed, reason: null } : { ok: false, changed, reason: `changed outside coderabbit.demoted.* and coderabbit.blind_sample_rate: ${outside.join(', ')}` };
}

const clone = () => structuredClone(REAL);
const flipped = (edit) => { const head = clone(); edit(head); return head; };

test('F1 a flip that only turns coderabbit.demoted.prepr_cli from an empty list to a list of bands passes (breaks if the coderabbit prefix is not accepted)', () => {
  const base = clone();
  base.coderabbit.demoted = { ...base.coderabbit.demoted, prepr_cli: [] };
  const r = flipDiffOk(base, flipped((h) => { h.coderabbit.demoted = { ...h.coderabbit.demoted, prepr_cli: ['LOW', 'MID'] }; }));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.changed, ['coderabbit.demoted.prepr_cli']);
});

test('F2 the same flip plus one more glob in checkpoint.critical fails and names the path (breaks if a gate list change is let through)', () => {
  const r = flipDiffOk(clone(), flipped((h) => { h.coderabbit.demoted.prepr_cli = ['MID']; h.checkpoint.critical.push('scripts/github/new-gate.mjs'); }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /checkpoint\.critical/);
});

/** The diff is refused and names exactly this path (an empty diff is also not ok, so ok === false alone proves nothing). */
function assertRefusedAt(head, changedPath) {
  const r = flipDiffOk(clone(), head);
  assert.equal(r.ok, false);
  assert.deepEqual(r.changed, [changedPath]);
}

test('F3 a change to matrix.control_plane alone fails and names it (breaks if only checkpoint.critical is checked)', () => {
  assertRefusedAt(flipped((h) => { h.matrix.control_plane.push('scripts/github/x.mjs'); }), 'matrix.control_plane');
});

test('F4 a change to matrix.security_tier or matrix.config_files fails and names it (breaks if the matrix lists are not covered)', () => {
  assertRefusedAt(flipped((h) => { h.matrix.security_tier.pop(); }), 'matrix.security_tier');
  assertRefusedAt(flipped((h) => { h.matrix.config_files.pop(); }), 'matrix.config_files');
});

test('F5 a change to local_review.bands or to the _doc notes fails and names it (strict: every changed leaf under coderabbit.*)', () => {
  assertRefusedAt(flipped((h) => { h.local_review.bands = ['HIGH']; }), 'local_review.bands');
  assertRefusedAt(flipped((h) => { h._doc.push('a new note'); }), '_doc');
});

test('F6 an identical config fails: an empty diff is not a flip (breaks if no change counts as ok)', () => {
  const r = flipDiffOk(clone(), clone());
  assert.equal(r.ok, false);
  assert.deepEqual(r.changed, []);
});

/** A base with explicit paid caps and flip keys, so these tests do not depend on the live values. */
const capBase = () => {
  const base = clone();
  base.coderabbit = { ...base.coderabbit, cli_daily_cap_usd: 3, monthly_file_cap: 160, blind_sample_rate: 0, demoted: { prepr_cli: [], critical: false } };
  return base;
};
const capHead = (edit) => { const head = structuredClone(capBase()); edit(head); return head; };
const refusedAt = (head, changedPath) => {
  const r = flipDiffOk(capBase(), head);
  assert.equal(r.ok, false);
  assert.ok(r.changed.includes(changedPath), `changed names ${changedPath}: ${r.changed.join(', ')}`);
  return r;
};

test('F7a removing coderabbit.cli_daily_cap_usd fails and names it: a missing cap means no cap on paid CLI runs (breaks if the paid caps are inside the flip paths)', () => {
  refusedAt(capHead((h) => { delete h.coderabbit.cli_daily_cap_usd; }), 'coderabbit.cli_daily_cap_usd');
});

test('F7b raising coderabbit.monthly_file_cap fails and names it (breaks if a cap raise is let through)', () => {
  refusedAt(capHead((h) => { h.coderabbit.monthly_file_cap = 500; }), 'coderabbit.monthly_file_cap');
});

test('F7c removing the whole coderabbit block fails and names it (breaks if a removed block counts as a flip)', () => {
  refusedAt(capHead((h) => { delete h.coderabbit; }), 'coderabbit');
});

test('F7d a new coderabbit key outside demoted and blind_sample_rate fails (breaks if every coderabbit key is a flip path)', () => {
  refusedAt(capHead((h) => { h.coderabbit.a_new_key = 1; }), 'coderabbit.a_new_key');
});

test('F7e coderabbit.demoted.prepr_cli and coderabbit.blind_sample_rate together pass, and a removed blind_sample_rate passes (breaks if a flip path is refused)', () => {
  const both = flipDiffOk(capBase(), capHead((h) => { h.coderabbit.demoted.prepr_cli = ['MID', 'ELEVATED']; h.coderabbit.blind_sample_rate = 0.1; }));
  assert.equal(both.ok, true, both.reason);
  assert.deepEqual(both.changed.sort(), ['coderabbit.blind_sample_rate', 'coderabbit.demoted.prepr_cli']);
  const gone = flipDiffOk(capBase(), capHead((h) => { delete h.coderabbit.blind_sample_rate; }));
  assert.equal(gone.ok, true, gone.reason);
  const critical = flipDiffOk(capBase(), capHead((h) => { h.coderabbit.demoted.critical = true; }));
  assert.equal(critical.ok, true, critical.reason);
});

test('F8 a key added outside coderabbit fails and names it (breaks if a new top-level key is ignored)', () => {
  assertRefusedAt(flipped((h) => { h.extra_gate = { enabled: true }; }), 'extra_gate');
});

test('F9 a top-level key that only starts with the word coderabbit is not coderabbit (breaks if the first segment is tested as a string prefix, or as a dotted path)', () => {
  assertRefusedAt(flipped((h) => { h['coderabbit.x'] = 1; }), 'coderabbit.x');
  const base = clone();
  base.coderabbit_extra = { demoted: { a: 0 } };
  const head = structuredClone(base);
  head.coderabbit_extra.demoted.a = 1;
  const r = flipDiffOk(base, head);
  assert.equal(r.ok, false);
  assert.deepEqual(r.changed, ['coderabbit_extra.demoted.a']);
});

test('live: the base and head config of a flip PR pass (runs only when FLIP_BASE_FILE and FLIP_HEAD_FILE are both set)', (t) => {
  const { FLIP_BASE_FILE: baseFile, FLIP_HEAD_FILE: headFile } = process.env;
  if (!baseFile && !headFile) { t.skip('FLIP_BASE_FILE and FLIP_HEAD_FILE are not set'); return; }
  assert.ok(baseFile && headFile, 'set both FLIP_BASE_FILE and FLIP_HEAD_FILE');
  const r = flipDiffOk(JSON.parse(readFileSync(baseFile, 'utf8')), JSON.parse(readFileSync(headFile, 'utf8')));
  assert.equal(r.ok, true, r.reason);
});
