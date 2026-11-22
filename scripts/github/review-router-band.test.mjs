// Tests for the review band (Step C2 of .claudedocs/2026-11-01-review-matrix.md): bandOf() in review-router.mjs,
// its use in decide() and ledgerLine(), and its use in the pr-checkpoint recommendation.
// Run: node --test scripts/github/review-router-band.test.mjs
//
// How the unit can fail, and the test that catches it (written before the code):
//   G counts only logic files, so a .json control-plane file is missed        -> B1
//   a test file under a control-plane glob counts as a gate file               -> B2
//   dist/ output counts as logic code                                          -> B3
//   a test-only or docs-only PR is MID                                         -> B4
//   C alone or logic alone lands in the wrong band                             -> B5
//   G = 4 with C = 1 reaches HIGH (static maximum is 9), or G = 5 misses HIGH -> B6
//   risk:high or an r3 path does not force CRITICAL                            -> B7
//   a backslash path or a repeated path changes the count                      -> B8
//   no matrix block still returns a band                                       -> B9
//   a confirmed Major (R) does not move the band                               -> B10
//   matrix.control_plane drops a file of checkpoint.critical or .parser        -> B11
//   the band rule disagrees with the section 4 table on real PRs               -> B12 (fixture rows)
//   decide() or the ledger line lose the band, or carry it on a label event   -> B13, B14
//   the checkpoint still recommends CodeRabbit below HIGH, or none from HIGH   -> B15 to B19
//   a PR without a matrix block loses the old R2 to R5 rules                    -> B20
//   a security-tier or critical file below HIGH drops the internal floor (aegis + critic) -> B31, B32
//   the floor rule hides none from the options, or a plain PR gets the floor       -> B31, B32
//   the floor turns a HIGH PR away from CodeRabbit or drops its R2/R3 rules      -> B33
//   the RB line loses the security-tier file names (the RF line hides it)       -> B31
//   a critical-only file is labelled a security-tier floor                       -> B32
//   the none option says READY needs CI and proof only next to the RF line        -> B31, B32
//   an engine trust-boundary file is not CRITICAL, or a prompt-tuning file is  -> B40
//   checkpoint.critical alone (not a trust-boundary file) becomes CRITICAL      -> B40
// Card force-high-security-tier (Dave 2026-11-22, "Wide: 102 of 651"): a security_tier file or one of FORCE_HIGH_FILES is HIGH at least.
//   a security_tier file below HIGH stays below HIGH                           -> B1, B31, B50
//   each FORCE_HIGH_FILES file (router, config, READY, land step) stays ELEVATED -> B32, B40, B51
//   a rename into or out of the force list or tier does not force HIGH        -> B52
//   a test file named like a force or tier path forces HIGH                    -> B53
//   CRITICAL (risk:high, r3, engine file) drops to HIGH, or forcedHigh is true on a score-HIGH PR -> B54
//   the force list is not one named constant of tap files, or a forced file also forces CRITICAL -> B55
//   the rule changes the band of a PR with no tier and no force file            -> B56, B12
//   a review:none pick at a forced band is not held for Dave (the land gate reads the base config) -> B57
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as router from './review-router.mjs';
import { bandOf, decide, ledgerLine, matchGlob, CRITICAL_TRUST_BOUNDARY, TRUST_BOUNDARY } from './review-router.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const LIVE = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8'));
const YAML = readFileSync(path.join(ROOT, '.coderabbit.yaml'), 'utf8');
const BACKTEST = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'band-backtest.json'), 'utf8'));
const NO_MATRIX = { ...LIVE, matrix: undefined };
const HEAD = 'a'.repeat(40);

// Five control-plane files outside FORCE_HIGH_FILES and the security tier: their band comes from the score alone. (Until 2026-11-22 this list held
// review-status.mjs and review-router.mjs, which are forced HIGH now; B32, B40 and B51 test those two by name.)
const GATE = ['scripts/github/cr-paid.mjs', '.claude/plugins/ccv3-mods/hooks/pr-loop/model.ts', 'scripts/github/pre-pr.mjs', 'scripts/github/cr-fix.mjs', 'scripts/github/pr-checkpoint.mjs'];
const LAND_STEP = 'scripts/github/' + ['land', 'pr'].join('-') + '.ps1';
// The four of card force-high-security-tier, then the land path of card force-high-land-path (Dave 2026-11-22: "17 of 654: all 11 files").
const FORCED = [
  'scripts/github/review-router.mjs', 'review-router.config.json', 'scripts/github/review-status.mjs', LAND_STEP,
  'scripts/github/land-decision.mjs', 'scripts/github/migration-gate.mjs', 'scripts/git-safe.ps1', '.claude/hooks/src/decision-gate.ts', 'scripts/github/ship-ask.mjs',
  'scripts/github/land-recheck.mjs', 'scripts/ratchets/lib/review-md.mjs',
  '.claude/hooks/src/decision-ledger.ts', 'scripts/lib/resolve-deps.mjs', '.claude/hooks/dist/decision-gate.mjs', '.claude/hooks/dist/decision-ledger.mjs',
];

test('B1: a control-plane file counts for G whatever its extension (a .json guard data file)', () => {
  const b = bandOf(['.claude/hooks/src/shared/malicious-packages.json'], LIVE);
  assert.equal(b.G, 1);
  assert.equal(b.K, 0);
  assert.equal(b.score, 3, 'the score is still ELEVATED by score');
  assert.equal(b.band, 'HIGH', 'a security_tier file forces HIGH (card force-high-security-tier)');
  assert.equal(b.forcedHigh, true);
});

test('B2: a test file under a control-plane glob does not count for G', () => {
  const b = bandOf(['.claude/plugins/ccv3-mods/hooks/pr-loop/__tests__/poller.test.ts'], LIVE);
  assert.equal(b.G, 0);
  assert.equal(b.band, 'LOW');
});

test('B3: dist/ output is not logic code', () => {
  const b = bandOf(['.claude/hooks/dist/foo.mjs', 'apps/x/dist/bundle.js'], LIVE);
  assert.equal(b.K, 0);
  assert.equal(b.band, 'LOW');
});

test('B4: a test-only PR and a docs-only PR are LOW (the spec text; the backtest script labelled test-only MID)', () => {
  assert.equal(bandOf(['scripts/github/foo.test.mjs', 'e2e/example.spec.ts'], LIVE).band, 'LOW');
  assert.equal(bandOf(['docs/guide.md', 'README.md'], LIVE).band, 'LOW');
  assert.equal(bandOf([], LIVE).band, 'LOW');
});

test('B5: logic alone is MID, config alone is ELEVATED, one gate file is ELEVATED', () => {
  assert.equal(bandOf(['apps/x/src/a.ts'], LIVE).band, 'MID');
  assert.equal(bandOf(['.coderabbit.yaml'], LIVE).band, 'ELEVATED');
  assert.equal(bandOf(['.github/workflows/ccv3-checks.yml'], LIVE).C, 1);
  assert.equal(bandOf([GATE[0]], LIVE).band, 'ELEVATED');
});

test('B6: G = 4 with a config file stays ELEVATED (static maximum 9); G = 5 is HIGH (option A edge)', () => {
  const four = bandOf([...GATE.slice(0, 4), '.coderabbit.yaml'], LIVE);
  assert.deepEqual([four.G, four.C, four.score, four.band], [4, 1, 9, 'ELEVATED']);
  const five = bandOf(GATE, LIVE);
  assert.deepEqual([five.G, five.score, five.band], [5, 11, 'HIGH']);
});

test('B7: risk:high, or an r3 path, forces CRITICAL at any score', () => {
  assert.equal(bandOf(['docs/guide.md'], LIVE, { labels: ['risk:high'] }).band, 'CRITICAL');
  assert.equal(bandOf(['apps/x/migrations/001_init.sql'], LIVE).band, 'CRITICAL');
  assert.equal(bandOf(['docs/guide.md'], LIVE, { labels: ['risk:normal', 'builder:claude'] }).band, 'LOW');
  // an eval fixture under skills is not an r3 path (the r3 class excludes it)
  assert.notEqual(bandOf(['.claude/skills/x/evals/q.sql'], LIVE).band, 'CRITICAL');
});

test('B8: backslash paths are normalised and a repeated path counts once', () => {
  const b = bandOf(['scripts\\github\\review-status.mjs', 'scripts/github/review-status.mjs', './scripts/github/cr-paid.mjs'], LIVE);
  assert.equal(b.G, 2);
  assert.deepEqual(b.gateFiles, ['scripts/github/review-status.mjs', 'scripts/github/cr-paid.mjs']);
});

test('B9: no matrix block, no band', () => {
  assert.equal(bandOf(GATE, NO_MATRIX), null);
});

test('B10: confirmed Majors (R) move the band up: MID to ELEVATED, ELEVATED to HIGH', () => {
  assert.equal(bandOf(['apps/x/src/a.ts'], LIVE, { r: 7 }).band, 'ELEVATED');
  assert.equal(bandOf([GATE[0]], LIVE, { r: 7 }).band, 'HIGH');
  assert.equal(bandOf([GATE[0]], LIVE, { r: 0 }).band, 'ELEVATED');
});

test('B11: matrix.control_plane holds every checkpoint.critical and checkpoint.parser glob', () => {
  for (const g of [...LIVE.checkpoint.critical, ...LIVE.checkpoint.parser]) {
    assert.ok(LIVE.matrix.control_plane.includes(g), `matrix.control_plane lacks ${g}`);
  }
});

test('B11b: code moved out of a gate file into a lib keeps at least the gate band (answer-paths, review-md)', () => {
  const RANK = ['LOW', 'MID', 'ELEVATED', 'HIGH', 'CRITICAL'];
  const moves = [
    ['scripts/github/lib/answer-paths.mjs', 'scripts/github/review-router.mjs'],
    ['scripts/github/lib/answer-paths.mjs', 'scripts/github/pre-pr.mjs'],
    ['scripts/ratchets/lib/review-md.mjs', 'scripts/github/pre-pr.mjs'],
  ];
  for (const [lib, origin] of moves) {
    const a = bandOf([lib], LIVE);
    const b = bandOf([origin], LIVE);
    assert.ok(RANK.indexOf(a.band) >= RANK.indexOf(b.band), `${lib} band ${a.band} is below ${origin} band ${b.band}`);
    assert.equal(a.G, b.G, `${lib} counts as a gate file like ${origin}`);
    assert.ok(LIVE.checkpoint.critical.includes(lib), `checkpoint.critical lacks ${lib}`);
  }
});

test('B12: the section 4 backtest rows get the documented band and G count (fixture band-backtest.json)', () => {
  assert.ok(BACKTEST.prs.length >= 8);
  const BELOW = ['LOW', 'MID', 'ELEVATED'];
  let forcedRows = 0;
  for (const row of BACKTEST.prs) {
    const b = bandOf(row.files, LIVE);
    // The documented band is the score band. A security_tier or FORCE_HIGH_FILES file lifts a band below HIGH to HIGH (card force-high-security-tier).
    // The expected value comes from the row's own paths and this file's lists (FORCED, the matrix globs), not from bandOf's outputs.
    const isTestPath = (p) => LIVE.matrix.test_markers.some((t) => `/${p}`.includes(t));
    const onTier = (p) => LIVE.matrix.control_plane.some((g) => matchGlob(g, p)) && LIVE.matrix.security_tier.some((g) => matchGlob(g, p));
    const forced = row.files.some((p) => !isTestPath(p) && (FORCED.includes(p) || onTier(p))) && BELOW.includes(row.band);
    if (forced) forcedRows++;
    assert.equal(b.band, forced ? 'HIGH' : row.band, `#${row.pr} band`);
    assert.equal(b.forcedHigh, forced, `#${row.pr} forcedHigh`);
    assert.equal(b.G, row.G, `#${row.pr} G`);
  }
  assert.ok(forcedRows >= 1, 'the fixture holds at least one row that the new rule lifts');
});

const prOf = (paths) => ({ number: 7, head: HEAD, draft: false, state: 'open', paths });

test('B13: decide() carries the band; a label event and a config without matrix carry none', () => {
  const d = decide('ready_for_review', prOf(GATE), ['builder:claude'], null, LIVE, { now: new Date('2026-10-26T12:00:00Z') });
  assert.equal(d.band.band, 'HIGH');
  assert.equal(d.band.G, 5);
  const risky = decide('ready_for_review', prOf(['docs/a.md']), ['risk:high'], null, LIVE, { now: new Date('2026-10-26T12:00:00Z') });
  assert.equal(risky.band.band, 'CRITICAL');
  const lab = decide('labeled', prOf([]), [], null, LIVE);
  assert.equal(lab.band, null);
  const none = decide('ready_for_review', prOf(GATE), ['builder:claude'], null, NO_MATRIX, { now: new Date('2026-10-26T12:00:00Z') });
  assert.equal(none.band, null);
});

test('B14: the ledger line names the band and the gate count, and only when a band exists', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  const d = decide('ready_for_review', prOf(GATE), ['builder:claude'], null, LIVE, { now });
  const line = JSON.parse(ledgerLine({ d, pr: prOf(GATE), event: 'ready_for_review', now }));
  assert.equal(line.band, 'HIGH');
  assert.equal(line.band_g, 5);
  const plain = decide('ready_for_review', prOf(GATE), ['builder:claude'], null, NO_MATRIX, { now });
  assert.equal(Object.hasOwn(JSON.parse(ledgerLine({ d: plain, pr: prOf(GATE), event: 'ready_for_review', now })), 'band'), false);
});

// ---------- the checkpoint recommendation ----------

const load = () => import('./pr-checkpoint.mjs');
const PASS_STAMP = { head: HEAD, body_sha256: 'f'.repeat(64), results: [{ step: 'git:branch', status: 'PASS', detail: 'ok' }] };
const file = (filename, additions = 10, deletions = 0) => ({ filename, additions, deletions });
async function policy(over = {}) {
  const { pathFiltersFrom } = await load();
  return {
    ...LIVE, deep_enabled: false,
    greptile: { ...LIVE.greptile, credits_used_manual: null },
    coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: null, reviews_7d_manual_date: null },
    path_filters: pathFiltersFrom(YAML), ...over,
  };
}
async function recommendFor(paths, factOver = {}, polOver = {}) {
  const { recommend } = await load();
  const facts = { head: HEAD, now: '2026-11-02T12:00:00.000Z', stamp: PASS_STAMP, files: paths.map((p) => file(p)), cli: { bySeverity: { minor: 1 } }, dependabot: false, config_drift: false, ...factOver };
  return recommend(facts, await policy(polOver));
}

test('B15: LOW, MID and ELEVATED PRs are recommended none (no CodeRabbit PR bot below HIGH)', async () => {
  for (const [paths, band] of [
    [['apps/x/README.txt'], 'LOW'],
    [['apps/x/src/a.ts', 'apps/x/src/b.ts', 'apps/x/src/c.ts', 'apps/x/src/d.ts', 'apps/x/src/e.ts'], 'MID'],
    [[GATE[0], 'scripts/a.mjs', 'scripts/b.mjs', 'scripts/c.mjs', 'scripts/d.mjs'], 'ELEVATED'],
  ]) {
    const r = await recommendFor(paths);
    assert.equal(r.band.band, band, paths[0]);
    assert.equal(r.recommended, 'none', `${band} must not recommend a bot`);
    assert.deepEqual(r.budget, [0, 0]);
    assert.ok(r.options.some((o) => o.pathway === 'coderabbit'), 'Dave can still press CodeRabbit (escalation)');
  }
});

test('B16: HIGH (G = 5) without the risk:high label or a trust file is recommended none (interim CodeRabbit rule, Dave 2026-11-04)', async () => {
  const r = await recommendFor(GATE);
  assert.equal(r.band.band, 'HIGH');
  assert.equal(r.recommended, 'none');
  assert.deepEqual(r.budget, [0, 0]);
});

test('B17: G = 4 in one PR is still none (was CodeRabbit under R3)', async () => {
  const r = await recommendFor(GATE.slice(0, 4));
  assert.equal(r.band.band, 'ELEVATED');
  assert.equal(r.recommended, 'none');
});

test('B18: CRITICAL by risk:high is recommended CodeRabbit unless docs-only; CRITICAL by an r3 path alone is none (interim rule)', async () => {
  const byLabel = await recommendFor(['scripts/a.mjs'], { labels: ['risk:high'] });
  assert.equal(byLabel.band.band, 'CRITICAL');
  assert.equal(byLabel.recommended, 'coderabbit');
  const docsOnly = await recommendFor(['docs/a.md'], { labels: ['risk:high'] });
  assert.equal(docsOnly.band.band, 'CRITICAL');
  assert.equal(docsOnly.recommended, 'none', 'docs-only wins over risk:high');
  const byPath = await recommendFor(['db/migrations/001_init.sql']);
  assert.equal(byPath.band.band, 'CRITICAL');
  assert.equal(byPath.recommended, 'none', 'an r3 path alone does not earn CodeRabbit');
});

test('B19: a Dependabot PR still gets none, and a parser file (R2) keeps its 1+0 budget only when the CodeRabbit trigger fires', async () => {
  const dep = await recommendFor(GATE, { dependabot: true });
  assert.equal(dep.recommended, 'none');
  const files = [...GATE.slice(0, 4), '.claude/hooks/src/coderabbit-guard.ts'];
  const noTrigger = await recommendFor(files);
  assert.equal(noTrigger.band.band, 'HIGH');
  assert.equal(noTrigger.recommended, 'none', 'R2 cannot lift a none');
  const parser = await recommendFor(files, { labels: ['risk:high'] });
  assert.equal(parser.band.band, 'CRITICAL');
  assert.equal(parser.recommended, 'coderabbit');
  assert.deepEqual(parser.budget, [1, 0]);
});

test('B20: a policy without a matrix block keeps the old rules (R5 recommends CodeRabbit for plain logic)', async () => {
  const r = await recommendFor(['scripts/a.mjs', 'scripts/b.mjs', 'scripts/c.mjs', 'scripts/d.mjs'], {}, { matrix: undefined });
  assert.equal(r.band, null);
  assert.equal(r.recommended, 'coderabbit');
  assert.ok(matchGlob('scripts/*.mjs', 'scripts/a.mjs'));
});

// ---------- CodeRabbit CLI findings on f5429ecb ----------

// pr-loop files: on the control plane, not on the security tier (a *-guard.ts rename is forced HIGH since card force-high-security-tier)
const renamed = (n) => Array.from({ length: n }, (_, i) => ({ filename: `.claude/plugins/ccv3-mods/hooks/pr-loop/new${i}.ts`, previous_filename: `.claude/plugins/ccv3-mods/hooks/pr-loop/old${i}.ts`, additions: 5, deletions: 5 }));

test('B21: three renamed gate files are G = 3 (ELEVATED), not 6: a rename is one changed file', () => {
  const b = bandOf(renamed(3), LIVE);
  assert.deepEqual([b.G, b.band], [3, 'ELEVATED']);
  assert.deepEqual(b.gateFiles, renamed(3).map((f) => f.filename));
});

test('B22: a rename into or out of the control plane counts once (either name is a gate file)', () => {
  assert.equal(bandOf([{ filename: GATE[0], previous_filename: 'scripts/old.mjs' }], LIVE).G, 1);
  assert.equal(bandOf([{ filename: 'scripts/new.mjs', previous_filename: GATE[0] }], LIVE).G, 1);
  assert.equal(bandOf([{ filename: 'scripts/new.mjs', previous_filename: 'scripts/old.mjs' }], LIVE).G, 0);
  assert.equal(bandOf(['scripts/a.mjs', { filename: 'scripts/a.mjs' }], LIVE).K, 1, 'strings and objects mix; the same file counts once');
});

test('B23: the checkpoint recommends none for three renamed gate files', async () => {
  const r = await recommendFor([], { files: renamed(3) });
  assert.equal(r.band.G, 3);
  assert.equal(r.band.band, 'ELEVATED');
  assert.equal(r.recommended, 'none');
});

test('B24: decide() counts a rename once when the PR carries the file objects (the router passes them)', () => {
  const files = renamed(3);
  const paths = files.flatMap((f) => [f.filename, f.previous_filename]);
  const d = decide('ready_for_review', { ...prOf(paths), files }, ['builder:claude'], null, LIVE, { now: new Date('2026-10-26T12:00:00Z') });
  assert.equal(d.band.G, 3);
  assert.equal(d.band.band, 'ELEVATED');
});

test('B25: a test-only PR that touches a config-glob test fixture is LOW (C ignores test files)', () => {
  const b = bandOf(['.greptile/fixtures/sample.json', '.github/workflows/__tests__/x.test.yml'], LIVE);
  assert.deepEqual([b.C, b.band], [0, 'LOW']);
  assert.equal(bandOf(['.greptile/config.json'], LIVE).C, 1);
});

// ---------- CodeRabbit CLI finding on 368d905c: the live path reads the PR labels ----------

test('B26: unreadable labels (facts.labels null) below HIGH stop the checkpoint: never none; HIGH and Dependabot are unaffected', async () => {
  const stop = await recommendFor(['docs/guide.md'], { labels: null });
  assert.equal(stop.recommended, null);
  assert.deepEqual(stop.options, []);
  assert.match(stop.why[0], /labels/i);
  assert.equal((await recommendFor(GATE, { labels: null })).recommended, null, 'a HIGH PR stops too: a hidden risk:high would turn its none into CodeRabbit (interim rule)');
  assert.equal((await recommendFor(['docs/guide.md'], { labels: null, dependabot: true })).recommended, 'none');
  assert.equal((await recommendFor(['docs/guide.md'], { labels: [] })).recommended, 'none', 'read, and no risk:high: none');
});

/** The live-facts path: a real git repo, a stamp, and a fake gh (env PR_CHECKPOINT_GH) that prints the PR labels or fails. */
function liveCheckpoint({ labels, ghFails = false, pinnedFails = false, url = 'https://github.com/Rev4nchist/Continuous-Claude-v3/pull/9', file = 'docs/guide.md' }) {
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'band-live-')));
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'one');
  git('checkout', '-q', '-b', 'feat/x');
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), 'two\n');
  git('add', '.');
  git('commit', '-q', '-m', 'two');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  mkdirSync(path.join(repo, '.claude', 'cache', 'pre-pr'), { recursive: true });
  writeFileSync(path.join(repo, '.claude', 'cache', 'pre-pr', 'stamp.json'), JSON.stringify({ head, body_sha256: 'f'.repeat(64), results: [] }));
  const cfg = path.join(repo, 'cfg.json');
  writeFileSync(cfg, JSON.stringify({ ...LIVE, deep_enabled: false, greptile: { ...LIVE.greptile, credits_used_manual: null } }));
  const script = path.join(repo, 'fake-gh.mjs');
  const log = path.join(repo, 'gh-calls.jsonl');
  writeFileSync(script, [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
    "if (process.env.FAKE_GH_FAIL) { process.stderr.write('gh: not found'); process.exit(1); }",
    "if (process.env.FAKE_GH_PINNED_FAIL && process.argv.includes('-R')) { process.stderr.write('no pull requests found'); process.exit(1); }",
    'process.stdout.write(process.env.FAKE_GH_VIEW);',
  ].join('\n'));
  const r = spawnSync(process.execPath, [path.join(HERE, 'pr-checkpoint.mjs'), '--json', '--config', cfg], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: 'invalid-token', PR_CHECKPOINT_LEDGER: path.join(repo, 'no-ledger.jsonl'), PR_CHECKPOINT_CR: 'off', PR_CHECKPOINT_SLOT_STATE: path.join(repo, 'no-slot.json'), PR_CHECKPOINT_NO_PROBE: '1', PR_CHECKPOINT_GH: script, FAKE_GH_LOG: log, FAKE_GH_VIEW: JSON.stringify({ url, labels: (labels ?? []).map((name) => ({ name })) }), ...(ghFails ? { FAKE_GH_FAIL: '1' } : {}), ...(pinnedFails ? { FAKE_GH_PINNED_FAIL: '1' } : {}) },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { r, out: r.status === 0 ? JSON.parse(r.stdout) : null, calls };
}

test('B27: the live-facts path reads the PR labels: a risk:high PR is CRITICAL; docs-only is none, anything else coderabbit (interim rule)', () => {
  const { r, out, calls } = liveCheckpoint({ labels: ['risk:high', 'builder:claude'] });
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.equal(out.band.band, 'CRITICAL');
  assert.equal(out.recommended, 'none', 'docs-only wins over risk:high');
  assert.deepEqual(calls, [['pr', 'view', 'feat/x', '--json', 'labels,number,author', '-R', 'Rev4nchist/Continuous-Claude-v3']]);
  const code = liveCheckpoint({ labels: ['risk:high'], file: 'scripts/guide.mjs' });
  assert.equal(code.out.band.band, 'CRITICAL');
  assert.equal(code.out.recommended, 'coderabbit');
});

test('B27b: only a docs-only PR skips the CodeRabbit trigger: a zero-reviewable-line non-docs PR with risk:high, or CRITICAL with a trust or security file, is coderabbit (CodeRabbit round 2)', async () => {
  const empty = (name) => ({ filename: name, additions: 0, deletions: 0 });
  const label = await recommendFor([], { files: [empty('scripts/a.mjs')], labels: ['risk:high'] });
  assert.equal(label.size.lines, 0);
  assert.equal(label.recommended, 'coderabbit', 'risk:high on a zero-line code PR still reaches the trigger');
  const trust = await recommendFor([], { files: [empty('scripts/github/lib/x.mjs')] });
  assert.equal(trust.band.band, 'CRITICAL');
  assert.equal(trust.recommended, 'coderabbit', 'CRITICAL with a trust-boundary file');
  const tier = await recommendFor([], { files: [empty('scripts/github/local-review.mjs'), empty('.claude/hooks/src/x-guard.ts')] });
  assert.equal(tier.band.band, 'CRITICAL');
  assert.equal(tier.recommended, 'coderabbit', 'CRITICAL with a security-tier file');
  const docs = await recommendFor([], { files: [empty('docs/a.md')], labels: ['risk:high'] });
  assert.equal(docs.recommended, 'none', 'a docs-only PR with risk:high stays none');
  const quiet = await recommendFor([], { files: [empty('thoughts/a.md')], labels: ['risk:high'] });
  assert.equal(quiet.recommended, 'none', 'a thoughts-only PR stays none');
});

test('B28: the live-facts path with no risk:high label keeps a docs-only PR LOW and none', () => {
  const { out } = liveCheckpoint({ labels: ['builder:claude'] });
  assert.equal(out.band.band, 'LOW');
  assert.equal(out.recommended, 'none');
});

test('B29: the live-facts path with unreadable labels (gh fails) stops: no recommendation, and never none', () => {
  const { r, out } = liveCheckpoint({ labels: [], ghFails: true });
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.equal(out.recommended, null);
  assert.deepEqual(out.options, []);
  assert.match(out.why[0], /labels/i);
});

test('B30: when the pinned lookup finds no PR (a fork PR), the labels come from `gh pr view` with no branch, and only if the PR is in the fork repo', () => {
  const ok = liveCheckpoint({ labels: ['risk:high'], pinnedFails: true });
  assert.equal(ok.out.band.band, 'CRITICAL');
  assert.deepEqual(ok.calls.map((c) => c.includes('-R')), [true, false], 'the pinned call first, then the fork-aware one');
  assert.deepEqual(ok.calls[1], ['pr', 'view', '--json', 'labels,url,number,author']);
  const other = liveCheckpoint({ labels: ['risk:high'], pinnedFails: true, url: 'https://github.com/parcadei/Continuous-Claude-v3/pull/9' });
  assert.equal(other.out.recommended, null, 'a PR in another repo (origin is parcadei) never supplies the labels');
  assert.match(other.out.why[0], /labels/i);
});

// ---------- the security-tier floor (spec 3.1: internal floor, not a bot floor; option A) ----------

const SECURITY = '.claude/hooks/src/pre-pr-gate.ts';

test('B31: a security-tier PR (forced HIGH since card force-high-security-tier) keeps none, names the file and requires aegis + critic', async () => {
  const r = await recommendFor([SECURITY]);
  assert.equal(r.band.band, 'HIGH');
  assert.equal(r.band.forcedHigh, true);
  assert.deepEqual(r.band.securityTier, [SECURITY]);
  assert.equal(r.recommended, 'none', 'the floor is internal: no CodeRabbit PR bot (option A)');
  assert.deepEqual(r.budget, [0, 0]);
  const why = r.why.join(' ');
  assert.match(why, /security.tier/i);
  assert.ok(why.includes(SECURITY), 'the pane names the security-tier file');
  assert.match(why, /aegis/);
  assert.match(why, /critic/);
  assert.equal(r.options[0].pathway, 'none', 'none stays the first option');
  assert.ok(r.options.some((o) => o.pathway === 'coderabbit'), 'Dave can still press CodeRabbit (escalation)');
  assert.match(r.why[0], /^Band HIGH \(/, 'why[0] is the RB line');
  assert.ok(r.why[0].includes(`security-tier file(s) ${SECURITY}`), 'the RB line itself names the security-tier file');
  assert.ok(r.why.some((w) => w.startsWith(`Security-tier floor (${SECURITY})`)), 'the RF line names its cause');
  assert.match(r.options[0].reason, /aegis \+ critic/, 'the none option names the internal pass the RF line asks for');
  assert.doesNotMatch(r.options[0].reason, /CI and proof only/);
});

test('B32: a critical file below HIGH gets the floor; a plain logic PR does not', async () => {
  const crit = await recommendFor([GATE[0]]);
  assert.equal(crit.band.band, 'ELEVATED');
  assert.deepEqual(crit.band.securityTier, [], 'cr-paid.mjs is critical, not security tier');
  assert.equal(crit.recommended, 'none');
  assert.match(crit.why.join(' '), /aegis/);
  assert.equal(crit.options[0].pathway, 'none');
  assert.ok(crit.why.some((w) => w.startsWith(`Critical-file floor (${GATE[0]})`)), 'a critical-only file is a critical-file floor');
  assert.ok(!crit.why.some((w) => /security.tier/i.test(w)), 'no line calls cr-paid.mjs security tier');
  assert.match(crit.options[0].reason, /aegis \+ critic/);
  const plain = await recommendFor(['apps/x/src/a.ts', 'apps/x/src/b.ts']);
  assert.equal(plain.band.band, 'MID');
  assert.doesNotMatch(plain.why.join(' '), /aegis/);
  assert.equal(plain.options.find((o) => o.pathway === 'none').reason, 'No bot review. READY needs CI and proof only.', 'no floor: the none text is unchanged');
});

test('B33: a HIGH PR with a security-tier file is none without risk:high (the floor stays); with risk:high it gets CodeRabbit and keeps R3', async () => {
  const none = await recommendFor([...GATE.slice(0, 4), SECURITY]);
  assert.equal(none.band.band, 'HIGH');
  assert.equal(none.recommended, 'none', 'HIGH is not CRITICAL, so a security-tier file alone does not earn CodeRabbit');
  assert.ok(none.why.some((w) => w.startsWith('Security-tier floor')), none.why.join(' | '));
  const r = await recommendFor([...GATE.slice(0, 4), SECURITY], { labels: ['risk:high'] });
  assert.equal(r.band.band, 'CRITICAL');
  assert.equal(r.recommended, 'coderabbit');
  assert.deepEqual(r.budget, [1, 1]);
  assert.ok(r.why.some((w) => w.startsWith('Critical file')), 'R3 stays beside RB when the trigger fires');
});

test('B40: an engine trust-boundary file forces CRITICAL; prompt.mjs, context.mjs and test files do not', () => {
  for (const f of ['scripts/github/local-review.mjs', 'scripts/github/cursor-review.mjs', 'scripts/github/local-review/record.mjs', 'scripts/github/review-filter.mjs', 'scripts/github/lib/file-lock.mjs', 'scripts/github/lib/deep/x.mjs']) {
    assert.equal(bandOf([f], LIVE).band, 'CRITICAL', f);
    assert.equal(bandOf([f], LIVE).L, true, f);
  }
  for (const f of ['scripts/github/local-review/prompt.mjs', 'scripts/github/local-review/context.mjs', 'scripts/github/local-review.test.mjs', 'scripts/github/lib/file-lock.test.mjs']) {
    assert.notEqual(bandOf([f], LIVE).band, 'CRITICAL', f);
  }
  // a rename out of the trust boundary still counts, and backslashes are normalised
  assert.equal(bandOf([{ filename: 'scripts/github/old.mjs', previous_filename: 'scripts/github/review-filter.mjs' }], LIVE).band, 'CRITICAL');
  assert.equal(bandOf(['scripts\\github\\local-review.mjs'], LIVE).band, 'CRITICAL');
});

// ---------- prflow-trust-list (C0): one trust list for every D1 class (seat ruling D1; Dave 2026-11-17: only the named guards) ----------

// Engine part: forces CRITICAL. Tap part: keeps Dave's tap (tapFiles) and forces no band (seat ruling 2026-11-17, option A).
const ENGINE_CLASSES = {
  'engine backends': ['scripts/github/local-review/backends/cursor.mjs', 'scripts/github/local-review/backends/claude.mjs'],
  'decision store (lib/**)': ['scripts/github/lib/decisions.mjs'],
};
const TAP_CLASSES = {
  'named guard hooks (source)': ['.claude/hooks/src/package-install-guard.ts', '.claude/hooks/src/agent-model-guard.ts', '.claude/hooks/src/pre-pr-gate.ts'],
  'named guard hooks (built dist)': ['.claude/hooks/dist/package-install-guard.mjs', '.claude/hooks/dist/pre-pr-gate.mjs'],
  'land step': [LAND_STEP, 'scripts/github/land-recheck.mjs', 'scripts/github/land-none-check.mjs', 'scripts/github/land-decision.mjs', 'scripts/github/migration-gate.mjs', 'scripts/git-safe.ps1'],
  'hook registration': ['.claude/settings.json.template', 'scripts/settings/apply-registrations.mjs', 'scripts/settings/remove-registrations.mjs'],
  'tap screen and paid review': ['.claude/plugins/ccv3-mods/hooks/pr-checkpoint/ask.ts', '.claude/plugins/ccv3-mods/hooks/pr-checkpoint/index.tsx', 'scripts/github/cr-paid.mjs'],
  // Dave 2026-11-17 ("All of both groups"): PR 642 critic and the prflow-review-pick aegis pass.
  'settings render and machine overlay': ['scripts/settings/render-settings.mjs', 'machine/personal.json', 'scripts/settings/machine-profile.mjs'],
  'paid run path': ['scripts/github/cr-fix.mjs', 'scripts/github/slot-queue.mjs', '.claude/plugins/ccv3-mods/hooks/pr-loop/model.ts', '.claude/plugins/ccv3-mods/hooks/pr-loop/slot.ts',
    // Dave 2026-11-17 ("Tap list 2: All of them"): the queue rules and the pay, wait and drop question model
    'scripts/github/slot-queue-model.mjs', '.claude/plugins/ccv3-mods/hooks/pr-loop/slot-model.ts'],
  'review bot config and reviewer agents': ['.coderabbit.yaml', '.claude/agents/aegis.md', '.claude/agents/critic.md', '.claude/agents/security-refuter.md',
    '.claude/agents/aegis.json', '.claude/agents/security-refuter.json',
    // Dave 2026-11-17 ("Tap list 2"): the second bot config and the reviewer files in config_files
    '.greptile/config.json', '.claude/agents/principal-reviewer.md', 'REVIEW.md', '.claude/skills/security/SKILL.md', '.claude/rules-ondemand/pr-review-loop.md'],
  'decision gate and ledger': ['.claude/hooks/src/decision-gate.ts', '.claude/hooks/src/decision-ledger.ts', '.claude/hooks/dist/decision-gate.mjs', '.claude/hooks/dist/decision-ledger.mjs', 'scripts/github/ship-ask.mjs'],
  'review router and its config': ['scripts/github/review-router.mjs', 'review-router.config.json', 'scripts/github/review-status.mjs', 'scripts/github/pr-checkpoint.mjs'],
};

test('B41a: a one-file change of each engine class forces CRITICAL and is named in trustFiles and tapFiles', () => {
  for (const [cls, files] of Object.entries(ENGINE_CLASSES)) {
    for (const f of files) {
      const b = bandOf([f], LIVE);
      assert.equal(b.band, 'CRITICAL', `${cls}: ${f}`);
      assert.deepEqual(b.trustFiles, [f], `${cls}: trustFiles`);
      assert.deepEqual(b.tapFiles, [f], `${cls}: tapFiles`);
    }
  }
});

test('B41b: a one-file change of each tap class is named in tapFiles only: not CRITICAL, L false, empty trustFiles', () => {
  for (const [cls, files] of Object.entries(TAP_CLASSES)) {
    for (const f of files) {
      const b = bandOf([f], LIVE);
      assert.notEqual(b.band, 'CRITICAL', `${cls}: ${f}`);
      assert.equal(b.L, false, `${cls}: ${f}`);
      assert.deepEqual(b.trustFiles, [], `${cls}: trustFiles`);
      assert.deepEqual(b.tapFiles, [f], `${cls}: tapFiles`);
    }
  }
});

test('B42: test files and near-miss paths of the trust classes do not force CRITICAL', () => {
  const notTrust = [
    '.claude/hooks/src/__tests__/decision-gate.test.ts', 'scripts/github/local-review/backends/cursor.test.mjs',
    'scripts/github/ship-ask.test.mjs', 'scripts/github/land-notes.mjs', '.claude/hooks/src/guardrail-report.ts',
    '.claude/hooks/src/decision-gate-helper.ts', '.claude/hooks/dist/lane-context.mjs', '.claude/hooks/src/lane-context.ts',
    'scripts/github/local-review/prompt.mjs', 'scripts/github/local-review/verify.mjs', 'scripts/github/pre-pr.mjs',
    '.github/workflows/ccv3-checks.yml', 'scripts/github/land-decision.test.mjs', '.claude/plugins/ccv3-mods/tests/plain.test.ts',
    // near misses that pin the width of the plugin and agent globs (PR 642 delta critic)
    '.claude/plugins/ccv3-mods/hooks/pr-loop/index.ts', '.claude/plugins/a/b/hooks/pr-checkpoint/x.ts',
    '.claude/agents/scout.md', '.claude/agents/scout.json', 'machine/README.md', 'scripts/settings/apply-registrations.test.mjs',
    // width pins for the overlay and settings globs, and the Tap list 2 entries (PR 646 critic items 4 and 5)
    'machine/sub/x.json', 'scripts/settings/hook-parity.mjs', '.claude/rules-ondemand/pr-review-loop-core.md',
    '.claude/skills/security/references/x.md', 'docs/REVIEW.md', '.claude/plugins/ccv3-mods/hooks/pr-loop/ask.ts',
  ];
  for (const f of notTrust) {
    const b = bandOf([f], LIVE);
    assert.notEqual(b.band, 'CRITICAL', f);
    assert.deepEqual(b.trustFiles, [], f);
    assert.deepEqual(b.tapFiles, [], f);
  }
});

test('B43: a dist-only change of decision-gate.mjs is in tapFiles (dist is not logic code; the tap match does not use isLogic) and is not CRITICAL', () => {
  const b = bandOf(['.claude/hooks/dist/decision-gate.mjs'], LIVE);
  assert.equal(b.K, 0, 'dist output is not logic (B3)');
  assert.deepEqual(b.tapFiles, ['.claude/hooks/dist/decision-gate.mjs']);
  assert.notEqual(b.band, 'CRITICAL');
  // A rename into or out of the list counts by either name, and backslashes are normalised.
  assert.deepEqual(bandOf([{ filename: 'scripts/github/ship-ask-v2.mjs', previous_filename: 'scripts/github/ship-ask.mjs' }], LIVE).tapFiles, ['scripts/github/ship-ask.mjs']);
  assert.deepEqual(bandOf(['.claude\\hooks\\src\\decision-gate.ts'], LIVE).tapFiles, ['.claude/hooks/src/decision-gate.ts']);
});

test('B44: every entry of both trust parts matches at least one tracked file (a dead entry hides a rename)', () => {
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.ok(tracked.length > 100, 'git ls-files read the repo');
  assert.equal(CRITICAL_TRUST_BOUNDARY, TRUST_BOUNDARY.engine, 'the old export is the engine part');
  const dead = [...TRUST_BOUNDARY.engine, ...TRUST_BOUNDARY.tap].filter((g) => !tracked.some((p) => matchGlob(g, p)));
  assert.deepEqual(dead, []);
});

test('B45: a tap file in a CRITICAL PR earns no paid CodeRabbit trigger (crTrigger reads trustFiles and security_tier, not tapFiles)', async () => {
  // The r3 path makes the band CRITICAL, so bandRule reaches crTrigger. ship-ask.mjs is a tap file and not on matrix.security_tier.
  const r = await recommendFor(['scripts/github/ship-ask.mjs', 'db/migrations/001_init.sql']);
  assert.equal(r.band.band, 'CRITICAL');
  assert.deepEqual(r.band.tapFiles, ['scripts/github/ship-ask.mjs']);
  assert.deepEqual(r.band.securityTier, []);
  assert.equal(r.recommended, 'none');
  assert.ok(!r.why.some((w) => /CodeRabbit trigger|Cause:/i.test(w)), r.why.join(' | '));
});

test('B40: checkpoint.critical alone does not force CRITICAL (it gives the floor, not the band)', () => {
  assert.equal(bandOf(['scripts/github/cr-paid.mjs'], LIVE).band, 'ELEVATED');
  const status = bandOf(['scripts/github/review-status.mjs'], LIVE);
  assert.equal(status.band, 'HIGH', 'review-status.mjs is forced HIGH (FORCE_HIGH_FILES), not CRITICAL');
  assert.equal(status.L, false);
  assert.ok(CRITICAL_TRUST_BOUNDARY.every((g) => !LIVE.checkpoint.critical.includes(g)), 'no second critical list in the config');
});

// ---------- card force-high-security-tier (Dave 2026-11-22, "Wide: 102 of 651"): a security_tier or FORCE_HIGH_FILES file is HIGH at least ----------

const TIER_PATHS = LIVE.matrix.security_tier.map((g) => g.replaceAll('*', 'x'));

test('B50: every matrix.security_tier path alone is HIGH and forcedHigh; the score stays below HIGH', () => {
  assert.ok(TIER_PATHS.length >= 9);
  for (const p of TIER_PATHS) {
    const b = bandOf([p], LIVE);
    assert.deepEqual(b.securityTier, [p], p);
    assert.equal(b.band, 'HIGH', p);
    assert.equal(b.forcedHigh, true, p);
    assert.ok(b.score < LIVE.matrix.bands.high, `${p} score ${b.score} is below the HIGH step: the floor, not the score, makes HIGH`);
  }
  // a tier file inside a PR that is HIGH by score alone is not "forced"
  const five = bandOf([...GATE.slice(0, 4), TIER_PATHS[0]], LIVE);
  assert.deepEqual([five.band, five.forcedHigh], ['HIGH', false]);
});

test('B51: each FORCE_HIGH_FILES file alone is HIGH, forcedHigh, not CRITICAL, and named in forceHighFiles', () => {
  for (const p of FORCED) {
    const b = bandOf([p], LIVE);
    assert.equal(b.band, 'HIGH', p);
    assert.equal(b.forcedHigh, true, p);
    assert.equal(b.L, false, `${p} forces no CRITICAL`);
    assert.deepEqual(b.trustFiles, [], p);
    assert.deepEqual(b.forceHighFiles, [p], p);
  }
  // the router config is a config file (C = 1) and still HIGH, not CRITICAL
  const cfg = bandOf(['review-router.config.json'], LIVE);
  assert.deepEqual([cfg.C, cfg.G, cfg.band], [1, 0, 'HIGH']);
  // one forced file next to plain logic and docs is still HIGH
  assert.equal(bandOf(['docs/a.md', 'apps/x/src/a.ts', FORCED[0]], LIVE).band, 'HIGH');
});

test('B52: a rename into or out of a forced or tier path is HIGH; a rename between two plain paths is not', () => {
  assert.equal(bandOf([{ filename: FORCED[0], previous_filename: 'scripts/old.mjs' }], LIVE).band, 'HIGH');
  assert.equal(bandOf([{ filename: 'scripts/new.mjs', previous_filename: FORCED[0] }], LIVE).band, 'HIGH');
  assert.equal(bandOf([{ filename: 'scripts/new.mjs', previous_filename: LAND_STEP }], LIVE).band, 'HIGH');
  assert.equal(bandOf([{ filename: TIER_PATHS[0], previous_filename: 'scripts/old.mjs' }], LIVE).band, 'HIGH');
  assert.equal(bandOf([{ filename: 'scripts/new.mjs', previous_filename: TIER_PATHS[0] }], LIVE).band, 'HIGH');
  const plain = bandOf([{ filename: 'scripts/new.mjs', previous_filename: 'scripts/old.mjs' }], LIVE);
  assert.deepEqual([plain.band, plain.forcedHigh], ['MID', false]);
});

test('B53: a test file named like a forced or tier path does not force HIGH; neither does a near-miss name', () => {
  for (const p of [
    'scripts/github/review-router.test.mjs', 'scripts/github/__tests__/review-status.mjs', '.claude/hooks/src/__tests__/pre-pr-gate.test.ts',
    'scripts/github/land-pr.test.ps1', 'scripts/github/fixtures/review-router.config.json',
  ]) {
    const b = bandOf([p], LIVE);
    assert.equal(b.forcedHigh, false, p);
    assert.notEqual(b.band, 'HIGH', p);
  }
  for (const p of ['scripts/github/review-routers.mjs', 'docs/review-router.config.json.md', 'scripts/github/review-status.mjs.bak', 'scripts/github/old/review-router.mjs']) {
    assert.equal(bandOf([p], LIVE).forcedHigh, false, p);
  }
});

test('B54: CRITICAL stays CRITICAL beside a forced file, and a PR that is HIGH by score is not "forced"', () => {
  for (const [files, labels] of [
    [[FORCED[0], 'docs/a.md'], ['risk:high']],
    [[FORCED[1], 'apps/x/migrations/001_init.sql'], []],
    [[FORCED[2], 'scripts/github/local-review.mjs'], []],
    [[TIER_PATHS[0], 'scripts/github/lib/proc.mjs'], []],
  ]) {
    const b = bandOf(files, LIVE, { labels });
    assert.equal(b.band, 'CRITICAL', files.join(','));
    assert.equal(b.forcedHigh, false, 'CRITICAL is not lowered or reported as forced HIGH');
  }
  const high = bandOf([...GATE, FORCED[0]], LIVE);
  assert.deepEqual([high.band, high.forcedHigh], ['HIGH', false]);
});

test('B55: FORCE_HIGH_FILES is one frozen constant: a subset of the tap list, no engine file, and every entry names a tracked file', () => {
  assert.ok(Array.isArray(router.FORCE_HIGH_FILES) && Object.isFrozen(router.FORCE_HIGH_FILES), 'exported and frozen');
  assert.deepEqual([...router.FORCE_HIGH_FILES].sort(), [...FORCED].sort());
  for (const p of router.FORCE_HIGH_FILES) {
    assert.ok(TRUST_BOUNDARY.tap.includes(p), `${p} is in TRUST_BOUNDARY.tap`);
    assert.ok(!CRITICAL_TRUST_BOUNDARY.includes(p), `${p} is not an engine file`);
    assert.ok(existsSync(path.join(ROOT, p)), `${p} exists (a dead entry hides a rename)`);
  }
  assert.ok(!Object.hasOwn(LIVE.matrix, 'force_high'), 'no config key: the list is a constant in code (re-cr-keys keeps the config)');
});

test('B56: a PR with no tier file and no forced file keeps its score band (the rule changes nothing else)', () => {
  const cases = [
    [['docs/guide.md'], 'LOW'], [['apps/x/src/a.ts'], 'MID'], [['.coderabbit.yaml'], 'ELEVATED'], [[GATE[0]], 'ELEVATED'],
    [['scripts/github/pre-pr.mjs'], 'ELEVATED'], [['scripts/github/cr-fix.mjs'], 'ELEVATED'], [['scripts/github/pr-checkpoint.mjs'], 'ELEVATED'],
    [[...GATE.slice(0, 4), '.coderabbit.yaml'], 'ELEVATED'], [GATE, 'HIGH'],
  ];
  for (const [files, band] of cases) {
    const b = bandOf(files, LIVE);
    assert.equal(b.band, band, files.join(','));
    assert.equal(b.forcedHigh, false, files.join(','));
    assert.deepEqual(b.forceHighFiles, [], files.join(','));
  }
  assert.equal(bandOf(['docs/guide.md'], LIVE, { labels: ['risk:high'] }).band, 'CRITICAL');
  assert.equal(bandOf(FORCED, NO_MATRIX), null, 'no matrix block, no band, forced file or not');
});

test('B57: the none-pick check needs Dave\'s record for a forced-HIGH band (band from the local config here; the base code and config reads are in land-none-base-code.test.mjs and land-none-check.test.mjs), and still skips a plain MID PR', async () => {
  const { nonePick } = await import('./land-none-check.mjs');
  const noRecord = () => ({ glob: '/s/store.json', files: [], records: [], bad: [] });
  for (const p of [FORCED[0], FORCED[3], TIER_PATHS[0]]) {
    const band = bandOf([p], LIVE).band;
    const r = nonePick({ pr: 7, head: HEAD, labels: ['review:none'], band, read: noRecord });
    assert.equal(r.needed, true, `${p}: band ${band} needs a record`);
    assert.equal(r.ok, false, `${p}: no record, so the land refuses`);
  }
  const mid = nonePick({ pr: 7, head: HEAD, labels: ['review:none'], band: bandOf(['apps/x/src/a.ts'], LIVE).band, read: noRecord });
  assert.equal(mid.ok, true);
});

// ---------- card force-high-land-path (Dave 2026-11-22: "17 of 654: all 11 files"): the whole land path is forced HIGH, matched without case ----------

test('B58: every file of the land path alone is HIGH and forcedHigh, with no CRITICAL; FORCED holds 15 entries', () => {
  assert.equal(FORCED.length, 15);
  assert.equal(new Set(FORCED).size, 15);
  for (const p of FORCED.slice(4)) {
    const b = bandOf([p], LIVE);
    assert.equal(b.band, 'HIGH', p);
    assert.equal(b.forcedHigh, true, p);
    assert.equal(b.L, false, `${p} forces no CRITICAL`);
    assert.deepEqual(b.forceHighFiles, [p], p);
  }
  // a rename out of a land-path file counts by its old name
  assert.equal(bandOf([{ filename: 'scripts/new.mjs', previous_filename: 'scripts/github/land-decision.mjs' }], LIVE).band, 'HIGH');
});

test('B59: a path that differs only in case still forces HIGH, counts for the gate plane and the engine list, and a docs file stays LOW', () => {
  for (const p of [
    LAND_STEP.toUpperCase(), 'Scripts/GitHub/Review-Router.mjs', 'REVIEW-ROUTER.CONFIG.JSON', '.Claude/Hooks/Src/Decision-Gate.ts',
    'scripts/github/SHIP-ASK.MJS', '.claude/hooks/dist/Decision-Ledger.mjs',
  ]) {
    const b = bandOf([p], LIVE);
    assert.equal(b.band, 'HIGH', p);
    assert.equal(b.forcedHigh, true, p);
  }
  // a security_tier path, upper-cased, is on the tier and on the gate plane
  const tier = bandOf([TIER_PATHS[0].toUpperCase()], LIVE);
  assert.deepEqual(tier.securityTier, [TIER_PATHS[0].toUpperCase()]);
  assert.equal(tier.G, 1);
  assert.equal(tier.band, 'HIGH');
  // an engine file, in other case, is CRITICAL
  assert.equal(bandOf(['Scripts/GitHub/Local-Review.mjs'], LIVE).band, 'CRITICAL');
  // a case-variant of an upper-case extension is a logic file (K = 1)
  assert.equal(bandOf(['apps/x/src/A.TS'], LIVE).K, 1);
  assert.equal(bandOf(['DOCS/Guide.MD'], LIVE).band, 'LOW');
});

test('B60: a test file in another case does not force HIGH, and a near-miss name in another case does not either', () => {
  for (const p of ['Scripts/GitHub/Review-Router.test.mjs', '.claude/hooks/src/__tests__/DECISION-GATE.test.ts', 'scripts/github/Fixtures/Land-Decision.mjs.bak', 'scripts/github/old/SHIP-ASK.mjs']) {
    assert.equal(bandOf([p], LIVE).forcedHigh, false, p);
  }
});

test('B61: TRUST_BOUNDARY.tap holds every FORCE_HIGH_FILES entry (one list, named in one place)', () => {
  for (const p of router.FORCE_HIGH_FILES) assert.ok(TRUST_BOUNDARY.tap.includes(p), `${p} is in TRUST_BOUNDARY.tap`);
});
