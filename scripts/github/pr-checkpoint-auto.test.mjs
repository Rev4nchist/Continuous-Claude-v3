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
//   a PR below HIGH that touches a security-tier file auto-confirms (it needs Dave's press)       -> AC10
//   the live config ships autoConfirm true (Dave 2026-11-02: ship it off)                         -> AC3
//   the drift check reads "no drift" when main's config is missing or not JSON (fail open)        -> AC11, AC12
//   a PR below HIGH that touches a critical file (the RF floor) auto-confirms                      -> AC13, AC7
//   the drift warning says "differs" when main's config is missing or not JSON                     -> AC12
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
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
// cr-fix.mjs is a gate file outside matrix.security_tier and checkpoint.critical, so this ELEVATED PR has no floor (AC10, AC13 have one).
const ELEVATED = ['scripts/github/cr-fix.mjs', 'scripts/a.mjs', 'scripts/b.mjs', 'scripts/c.mjs', 'scripts/d.mjs'];

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

test('AC3: the kill switch is a literal true or the word low in checkpoint.autoConfirm; missing, false, "true" or 1 turn auto-confirm off', async () => {
  assert.equal(LIVE.checkpoint.autoConfirm, 'low', 'the live config carries the switch, and it ships low: LOW band only (Dave 2026-11-06; it was false from 2026-11-02)');
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
  // Since the interim CodeRabbit rule (2026-11-04) a HIGH PR gets a paid pathway only with the risk:high label (or CRITICAL plus a trust file).
  const high = await recommendFor(GATE, { labels: ['risk:high'] }, { coderabbit: { reviews_7d_manual: 55, reviews_7d_manual_date: null } });
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
    ['security tier', confirmAuto('none', 'auto', { paths: [GATE[0]] })],
    ['critical file', confirmAuto('none', 'auto', { paths: [GATE[1]] })],
  ];
  for (const [label, r] of cases) {
    assert.equal(r.status, 1, `${label}: ${r.stdout} ${r.stderr}`);
    // One case is refused before the auto rule: unread labels stop the whole checkpoint. HIGH offers none since 2026-11-04 (a person may pick it),
    // so --by auto reaches the auto rule there and is refused by band.
    const why = { 'unread labels': /Could not read the PR labels/ }[label] ?? /auto/i;
    assert.match(r.stderr, why, label);
    assert.doesNotMatch(r.stderr, /\/pathway|\/slot/, `${label}: the refusal names no typed command`);
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

// ---------- the security-tier floor (spec 3.1: aegis + critic, so Dave presses) ----------

test('AC10: a PR below HIGH that touches a security-tier file is never auto-eligible', async () => {
  const r = await recommendFor([GATE[0]]);
  assert.equal(r.band.band, 'ELEVATED');
  assert.deepEqual(r.band.securityTier, [GATE[0]]);
  assert.equal(r.recommended, 'none');
  assert.equal(r.auto.eligible, false);
  assert.match(r.auto.reason, /security.tier/i);
  assert.ok(r.auto.reason.includes(GATE[0]), 'the reason names the file');
});

// ---------- the live drift check (git show main:review-router.config.json) ----------

/** A temp repo whose main holds `mainConfig` (undefined: no file), and a branch with one docs file. Runs the live-facts path. */
function liveDrift(mainConfig) {
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'checkpoint-drift-')));
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  if (mainConfig !== undefined) writeFileSync(path.join(repo, 'review-router.config.json'), mainConfig);
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  git('checkout', '-q', '-b', 'feat/x');
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  writeFileSync(path.join(repo, 'docs', 'guide.md'), 'two\n');
  git('add', '.');
  git('commit', '-q', '-m', 'two');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  mkdirSync(path.join(repo, '.claude', 'cache', 'pre-pr'), { recursive: true });
  writeFileSync(path.join(repo, '.claude', 'cache', 'pre-pr', 'stamp.json'), JSON.stringify({ head, body_sha256: 'f'.repeat(64), results: [] }));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'checkpoint-drift-cfg-'));
  const cfg = path.join(outside, 'cfg.json');
  writeFileSync(cfg, DRIFT_CONFIG);
  const gh = path.join(outside, 'fake-gh.mjs');
  writeFileSync(gh, `process.stdout.write(${JSON.stringify(JSON.stringify({ labels: [] }))});`);
  const r = spawnSync(process.execPath, [path.join(HERE, 'pr-checkpoint.mjs'), '--json', '--config', cfg], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GH_TOKEN: 'invalid-token', PR_CHECKPOINT_GH: gh, PR_CHECKPOINT_CR: 'off', PR_CHECKPOINT_SLOT_STATE: path.join(outside, 'no-slot.json'), PR_CHECKPOINT_NO_PROBE: '1' },
  });
  return { r, out: r.status === 0 ? JSON.parse(r.stdout) : null };
}
const DRIFT_CONFIG = JSON.stringify({ ...LIVE, deep_enabled: false, greptile: { ...LIVE.greptile, credits_used_manual: null }, checkpoint: { ...LIVE.checkpoint, autoConfirm: true } });

test('AC11: main with the same config is no drift, so a LOW PR is auto-eligible (the harness can say false)', () => {
  const { r, out } = liveDrift(DRIFT_CONFIG);
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.equal(out.band.band, 'LOW');
  assert.equal(out.config_drift, false);
  assert.equal(out.auto.eligible, true, out.auto.reason);
});

test('AC12: main with no config, or a config that is not JSON, counts as drift (fail closed): Dave presses', async () => {
  for (const [label, mainConfig] of [['missing', undefined], ['not JSON', '{ not json']]) {
    const { r, out } = liveDrift(mainConfig);
    assert.equal(r.status, 0, `${label}: ${r.stdout} ${r.stderr}`);
    assert.equal(out.config_drift, true, label);
    assert.equal(out.auto.eligible, false, label);
    assert.match(out.auto.reason, /missing or not JSON/, label);
    assert.doesNotMatch(out.auto.reason, /differs/, label);
    const { renderText } = await load();
    assert.match(renderText(out), /Warning: .*missing or not JSON/, label);
    assert.doesNotMatch(renderText(out), /differs/, label);
  }
});

test('AC13: a PR below HIGH that touches a critical file but no security-tier file is never auto-eligible (the RF floor)', async () => {
  const r = await recommendFor([GATE[1]]);
  assert.equal(r.band.band, 'ELEVATED');
  assert.deepEqual(r.band.securityTier, [], 'review-status.mjs is critical, not security tier');
  assert.equal(r.recommended, 'none');
  assert.equal(r.auto.eligible, false);
  assert.match(r.auto.reason, /aegis \+ critic/);
  assert.ok(r.auto.reason.includes(GATE[1]), 'the reason names the file');
});
