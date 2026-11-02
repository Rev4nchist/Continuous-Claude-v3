// Auto-confirm of the PR checkpoint (review factory step A, Dave 2026-11-01; spec .claudedocs/2026-11-01-review-matrix.md sections 0, 5.3, 6).
// The engine decides whether a checkpoint may record `none` without Dave's press: recommend() prints `auto`, and --confirm --by auto
// re-checks the same rule. Run: node --test scripts/github/pr-checkpoint-auto.test.mjs
//
// How it can fail, and the test that catches it:
//   a LOW, MID or ELEVATED PR with recommended none is not auto-eligible                         -> AC1
//   a HIGH or CRITICAL PR (G = 5, risk:high label, r3 path) is auto-eligible                     -> AC2
//   the kill switch checkpoint.autoConfirm is missing, false or not a literal true and it still fires -> AC3
//   unreadable labels (null) or a caller with no labels (undefined) still auto-confirm            -> AC4
//   config drift, a missing matrix (unknown band) or an R0 stop still auto-confirms               -> AC5
//   a recommendation other than none (wait, coderabbit) is auto-eligible                          -> AC6
//   --confirm --by auto records for a PR that is not eligible, or for a pathway other than none   -> AC7
//   --confirm --by auto does not record decided_by auto in the same nine-field record as a press -> AC8
//   --by with another word is accepted                                                             -> AC9
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const LIVE = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8'));
const YAML = readFileSync(path.join(ROOT, '.coderabbit.yaml'), 'utf8');
const NOW = '2026-11-02T12:00:00.000Z';
const HEAD = 'a'.repeat(40);
const BODY_TEXT = 'PR body\nwith an Evidence block\n';
const BODY_SHA = createHash('sha256').update(BODY_TEXT).digest('hex');
const STAMP = { head: HEAD, body_sha256: BODY_SHA, results: [{ step: 'git:branch', status: 'PASS', detail: 'ok' }] };

const load = () => import('./pr-checkpoint.mjs');
const file = (filename, additions = 10, deletions = 0) => ({ filename, additions, deletions });

const GATE = ['.claude/hooks/src/pre-pr-gate.ts', 'scripts/github/review-status.mjs', 'scripts/github/review-router.mjs', 'scripts/github/cr-paid.mjs', 'scripts/github/land-pr.ps1'];
const LOW = ['apps/x/README.txt'];
const MID = ['apps/x/src/a.ts', 'apps/x/src/b.ts', 'apps/x/src/c.ts'];
const ELEVATED = [GATE[0], 'scripts/a.mjs', 'scripts/b.mjs', 'scripts/c.mjs', 'scripts/d.mjs'];

/** The live config with the switches pinned. The live autoConfirm value is part of the contract, so it is read, not pinned. */
async function policy(over = {}) {
  const { pathFiltersFrom } = await load();
  return {
    ...LIVE, deep_enabled: false,
    greptile: { ...LIVE.greptile, credits_used_manual: null },
    coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: null, reviews_7d_manual_date: null },
    path_filters: pathFiltersFrom(YAML), ...over,
  };
}
const withAuto = (value) => ({ checkpoint: { ...LIVE.checkpoint, autoConfirm: value } });
const factsFor = (paths, over = {}) => ({
  head: HEAD, now: NOW, stamp: STAMP, files: paths.map((p) => file(p)), cli: { bySeverity: { minor: 1 } }, dependabot: false, config_drift: false, labels: [], ...over,
});
async function recommendFor(paths, factOver = {}, polOver = {}) {
  const { recommend } = await load();
  return recommend(factsFor(paths, factOver), await policy({ ...withAuto(true), ...polOver }));
}

test('AC1: LOW, MID and ELEVATED with recommended none are auto-eligible, and the band is named', async () => {
  for (const [paths, band] of [[LOW, 'LOW'], [MID, 'MID'], [ELEVATED, 'ELEVATED']]) {
    const r = await recommendFor(paths);
    assert.equal(r.band.band, band);
    assert.equal(r.recommended, 'none');
    assert.equal(r.auto.eligible, true, `${band}: ${r.auto.reason}`);
    assert.equal(r.auto.band, band);
  }
});

test('AC2: HIGH and CRITICAL are never auto-eligible (HIGH stays with Dave: the free-slot signal is not readable)', async () => {
  const high = await recommendFor(GATE);
  assert.equal(high.band.band, 'HIGH');
  assert.equal(high.auto.eligible, false);
  assert.match(high.auto.reason, /HIGH/);
  const byLabel = await recommendFor(['docs/a.md'], { labels: ['risk:high'] });
  assert.equal(byLabel.band.band, 'CRITICAL');
  assert.equal(byLabel.auto.eligible, false);
  const byPath = await recommendFor(['db/migrations/001_init.sql']);
  assert.equal(byPath.band.band, 'CRITICAL');
  assert.equal(byPath.auto.eligible, false);
  const depHigh = await recommendFor(GATE, { dependabot: true });
  assert.equal(depHigh.recommended, 'none', 'a Dependabot PR is recommended none whatever its band');
  assert.equal(depHigh.auto.eligible, false, 'but a HIGH band still goes to Dave');
});

test('AC3: the kill switch is a literal true in checkpoint.autoConfirm; missing, false, "true" or 1 turn auto-confirm off', async () => {
  assert.equal(typeof LIVE.checkpoint.autoConfirm, 'boolean', 'the live config carries the switch');
  assert.equal((await recommendFor(MID, {}, withAuto(true))).auto.eligible, true);
  for (const value of [false, 'true', 1, null, undefined]) {
    const r = await recommendFor(MID, {}, withAuto(value));
    assert.equal(r.auto.eligible, false, `autoConfirm ${JSON.stringify(value)}`);
    assert.match(r.auto.reason, /autoConfirm/);
  }
});

test('AC4: labels that could not be read (null) or were never supplied (undefined) never auto-confirm', async () => {
  const unread = await recommendFor(MID, { labels: null });
  assert.equal(unread.recommended, null, 'the RB stop');
  assert.equal(unread.auto.eligible, false);
  const { labels: _drop, ...noLabels } = factsFor(MID);
  const { recommend } = await load();
  const r = recommend(noLabels, await policy(withAuto(true)));
  assert.equal(r.recommended, 'none', 'recommend() itself accepts a fixture with no labels');
  assert.equal(r.auto.eligible, false, 'auto-confirm needs labels that were read');
});

test('AC5: config drift, no matrix block (unknown band) and an R0 stop never auto-confirm', async () => {
  assert.equal((await recommendFor(MID, { config_drift: true })).auto.eligible, false);
  const noMatrix = await recommendFor(MID, {}, { matrix: undefined });
  assert.equal(noMatrix.band, null);
  assert.equal(noMatrix.auto.eligible, false);
  const noStamp = await recommendFor(MID, { stamp: null });
  assert.equal(noStamp.recommended, null);
  assert.equal(noStamp.auto.eligible, false);
});

test('AC6: a recommendation other than none (wait on a high count, a paid pathway) is not auto-eligible', async () => {
  const r = await recommendFor(MID, {}, { coderabbit: { reviews_7d_manual: 55, reviews_7d_manual_date: null } });
  assert.equal(r.recommended, 'none', 'a band below HIGH buys no review whatever the count');
  assert.equal(r.auto.eligible, true);
  const high = await recommendFor(GATE, {}, { coderabbit: { reviews_7d_manual: 55, reviews_7d_manual_date: null } });
  assert.notEqual(high.recommended, 'none');
  assert.equal(high.auto.eligible, false);
});

// ---------- the CLI: --confirm ... --by auto ----------

function confirmAuto(pathway, by, { paths = MID, factOver = {}, autoConfirm = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'checkpoint-auto-'));
  const state = path.join(dir, 'pre-pr');
  mkdirSync(state, { recursive: true });
  const factsFile = path.join(dir, 'facts.json');
  const cfgFile = path.join(dir, 'config.json');
  const bodyFile = path.join(dir, 'body.md');
  writeFileSync(factsFile, JSON.stringify(factsFor(paths, factOver)));
  writeFileSync(bodyFile, BODY_TEXT);
  writeFileSync(cfgFile, JSON.stringify({
    ...LIVE, deep_enabled: false,
    greptile: { ...LIVE.greptile, credits_used_manual: null },
    coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: null, reviews_7d_manual_date: null },
    checkpoint: autoConfirm === 'omit' ? (({ autoConfirm: _drop, ...rest }) => rest)(LIVE.checkpoint) : { ...LIVE.checkpoint, autoConfirm },
  }));
  const args = [path.join(HERE, 'pr-checkpoint.mjs'), '--confirm', pathway, '--by', by, '--body', bodyFile, '--state-dir', state, '--facts', factsFile, '--config', cfgFile];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: dir, env: { ...process.env, GH_TOKEN: 'invalid-token', GH_CONFIG_DIR: dir } });
  return { ...r, pathwayFile: path.join(state, 'pathway.json') };
}

test('AC7: --confirm --by auto refuses (exit 1, nothing written) for HIGH, kill switch off, drift, unread labels and any pathway but none', () => {
  const cases = [
    ['HIGH', confirmAuto('none', 'auto', { paths: GATE })],
    ['kill switch off', confirmAuto('none', 'auto', { autoConfirm: false })],
    ['kill switch missing', confirmAuto('none', 'auto', { autoConfirm: 'omit' })],
    ['config drift', confirmAuto('none', 'auto', { factOver: { config_drift: true } })],
    ['unread labels', confirmAuto('none', 'auto', { factOver: { labels: null } })],
    ['coderabbit by auto', confirmAuto('coderabbit', 'auto')],
  ];
  for (const [label, r] of cases) {
    assert.equal(r.status, 1, `${label}: ${r.stdout} ${r.stderr}`);
    // Two cases are refused before the auto rule: none is not offered on a HIGH PR, and unread labels stop the whole checkpoint.
    const why = { HIGH: /not offered/, 'unread labels': /Could not read the PR labels/ }[label] ?? /auto/i;
    assert.match(r.stderr, why, label);
    assert.ok(!existsSync(r.pathwayFile), `${label}: no pathway.json`);
  }
});

test('AC8: --confirm none --by auto on an eligible PR writes the same nine-field record a press writes, with decided_by auto', () => {
  const r = confirmAuto('none', 'auto');
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  const rec = JSON.parse(readFileSync(r.pathwayFile, 'utf8'));
  assert.deepEqual(Object.keys(rec).sort(), ['at', 'body_sha256', 'budget', 'class', 'decided_by', 'head', 'label', 'pathway', 'recommended']);
  assert.equal(rec.decided_by, 'auto');
  assert.equal(rec.pathway, 'none');
  assert.equal(rec.label, 'review:none');
  assert.equal(rec.recommended, 'none');
  assert.deepEqual(rec.budget, [0, 0]);
  assert.equal(rec.head, HEAD);
  assert.equal(rec.body_sha256, BODY_SHA);
  assert.deepEqual(JSON.parse(r.stdout), rec, 'stdout is the record');
  const press = confirmAuto('none', 'default');
  const pressRec = JSON.parse(readFileSync(press.pathwayFile, 'utf8'));
  assert.deepEqual({ ...pressRec, decided_by: 'auto' }, rec, 'only decided_by differs from the default press');
});

test('AC9: --by takes dave, default or auto only', () => {
  const r = confirmAuto('none', 'robot');
  assert.equal(r.status, 2, `${r.stdout} ${r.stderr}`);
  assert.match(r.stderr, /--by dave, --by default or --by auto/);
  assert.ok(!existsSync(r.pathwayFile));
});
