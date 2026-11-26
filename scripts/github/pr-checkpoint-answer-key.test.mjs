// The review-pick question never offers a paid review on a change with an answer-key path (card review-pick-answer-key-filter).
// A review bot would read the answer key, so such a change gets the one option none, like a Dependabot PR. Run: node --test scripts/github/pr-checkpoint-answer-key.test.mjs
// Synthetic paths only: a glob folder plus x.json. No listed id is read or written.
//
// How it can fail, and the test that catches it:
//   an answer-key path in a LOW PR still lists CodeRabbit or both, or does not recommend none        -> K1
//   the same at HIGH band (a gate file in the change) still offers a paid review                     -> K2
//   a critical or parser file in the change brings the paid options back, or its why line is lost    -> K3
//   a backslash or capital spelling of the path slips past the match                                -> K4
//   a rename OUT of an answer-key path (previous_filename) slips past the match                      -> K5
//   a path next to the answer-key folder is treated as an answer key (the filter is too wide)        -> K6
//   auto-confirm records none for an answer-key change that also touches a critical file             -> K7
//   --confirm records coderabbit or both for an answer-key change                                    -> K8
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const LIVE = (() => { const c = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8')); c.checkpoint = { ...c.checkpoint, ledger: false }; return c; })();
const YAML = readFileSync(path.join(ROOT, '.coderabbit.yaml'), 'utf8');
const NOW = '2026-11-26T12:00:00.000Z';
const HEAD = 'b'.repeat(40);
const BODY_SHA = createHash('sha256').update('PR body\n').digest('hex');
const STAMP = { head: HEAD, body_sha256: BODY_SHA, results: [{ step: 'git:branch', status: 'PASS', detail: 'ok' }] };

const load = () => import('./pr-checkpoint.mjs');
const KEY = 'scripts/eval/review-eval/gold/x.json';
const GATE_FILE = 'scripts/github/cr-paid.mjs'; // critical, not security tier: band ELEVATED with the floor line
const PARSER_FILE = '.claude/hooks/src/coderabbit-guard.ts';
const GATE_SET = ['.claude/hooks/src/pre-pr-gate.ts', 'scripts/github/review-status.mjs', 'scripts/github/review-router.mjs', 'scripts/github/cr-paid.mjs', 'scripts/github/land-pr.ps1'];

async function policy(autoConfirm) {
  const { pathFiltersFrom } = await load();
  return {
    ...LIVE, deep_enabled: false,
    greptile: { ...LIVE.greptile, credits_used_manual: null },
    coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: null, reviews_7d_manual_date: null },
    path_filters: pathFiltersFrom(YAML), checkpoint: { ...LIVE.checkpoint, autoConfirm },
  };
}
const factsOf = (files) => ({
  head: HEAD, now: NOW, stamp: STAMP, cli: { bySeverity: { minor: 1 } }, dependabot: false, config_drift: false, labels: [],
  files: files.map((f) => (typeof f === 'string' ? { filename: f, additions: 10, deletions: 0 } : { additions: 10, deletions: 0, ...f })),
});
async function recommendFor(files, autoConfirm = true) {
  const { recommend } = await load();
  return recommend(factsOf(files), await policy(autoConfirm));
}
const pathways = (r) => r.options.map((o) => o.pathway);
const whyText = (r) => r.why.join('\n');

test('K1: one answer-key path in a LOW change gives the one option none, recommended none, and the why names the path', async () => {
  const r = await recommendFor(['docs/a.md', KEY]);
  assert.deepEqual(pathways(r), ['none']);
  assert.equal(r.recommended, 'none');
  assert.ok(whyText(r).includes(KEY), whyText(r));
  assert.match(whyText(r), /answer.key/i);
});

test('K2: the same at band HIGH (gate files in the change): still only none', async () => {
  const r = await recommendFor([...GATE_SET, KEY]);
  assert.equal(r.band.band, 'HIGH');
  assert.deepEqual(pathways(r), ['none']);
  assert.equal(r.recommended, 'none');
});

test('K3: with a critical and a parser file, still only none, and the why names both files and keeps the floor line', async () => {
  const r = await recommendFor([KEY, GATE_FILE, PARSER_FILE]);
  assert.deepEqual(pathways(r), ['none']);
  assert.equal(r.recommended, 'none');
  const text = whyText(r);
  assert.ok(text.includes(GATE_FILE), `critical file named: ${text}`);
  assert.ok(text.includes(PARSER_FILE), `parser file named: ${text}`);
  assert.match(text, /aegis \+ critic/, 'the person still reviews: the floor line stays');
});

test('K4: a backslash and capital spelling of the path is matched', async () => {
  const r = await recommendFor(['docs/a.md', 'Scripts\\Eval\\Review-Eval\\Gold\\x.json']);
  assert.deepEqual(pathways(r), ['none']);
  assert.equal(r.recommended, 'none');
});

test('K5: a rename out of an answer-key path (previous_filename) is matched', async () => {
  const r = await recommendFor([{ filename: 'docs/moved.json', previous_filename: 'scripts/eval/review-eval/seeds/x.json' }]);
  assert.deepEqual(pathways(r), ['none']);
  assert.equal(r.recommended, 'none');
});

test('K6: a path next to the answer-key folders is not an answer key: the paid options stay', async () => {
  const r = await recommendFor(['scripts/eval/review-eval/other.mjs']);
  assert.ok(pathways(r).includes('coderabbit'), `options: ${pathways(r).join(', ')}`);
});

test('K7: auto-confirm for an answer-key change: a LOW change qualifies under low and true; a critical file in the change never does', async () => {
  for (const value of ['low', true]) {
    const low = await recommendFor(['docs/a.md', KEY], value);
    assert.equal(low.recommended, 'none');
    assert.equal(low.auto.eligible, true, `LOW under ${JSON.stringify(value)}: ${low.auto.reason}`);
    const crit = await recommendFor([KEY, GATE_FILE], value);
    assert.equal(crit.recommended, 'none');
    assert.equal(crit.auto.eligible, false, `critical file under ${JSON.stringify(value)}`);
    // Under low the band check (ELEVATED is not LOW) stops it first; under true only the critical-file floor stops it.
    assert.match(crit.auto.reason, value === true ? /aegis \+ critic/ : /covers LOW only/);
  }
});

test('K8: --confirm refuses coderabbit and both for an answer-key change and accepts none', async () => {
  const { confirmProblem } = await load();
  const facts = factsOf(['docs/a.md', KEY]);
  const result = await recommendFor(['docs/a.md', KEY]);
  for (const pathway of ['coderabbit', 'both']) {
    assert.match(String(confirmProblem({ result, facts, pathway, by: 'dave', bodySha: BODY_SHA })), /not offered/, pathway);
  }
  assert.equal(confirmProblem({ result, facts, pathway: 'none', by: 'dave', bodySha: BODY_SHA }), null);
});
