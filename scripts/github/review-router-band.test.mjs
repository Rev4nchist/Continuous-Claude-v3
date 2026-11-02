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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bandOf, decide, ledgerLine, matchGlob } from './review-router.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const LIVE = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8'));
const YAML = readFileSync(path.join(ROOT, '.coderabbit.yaml'), 'utf8');
const BACKTEST = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'band-backtest.json'), 'utf8'));
const NO_MATRIX = { ...LIVE, matrix: undefined };
const HEAD = 'a'.repeat(40);

const GATE = ['scripts/github/review-status.mjs', 'scripts/github/review-router.mjs', 'scripts/github/cr-paid.mjs', 'scripts/github/land-recheck.mjs', 'scripts/github/pre-pr.mjs'];

test('B1: a control-plane file counts for G whatever its extension (a .json guard data file)', () => {
  const b = bandOf(['.claude/hooks/src/shared/malicious-packages.json'], LIVE);
  assert.equal(b.G, 1);
  assert.equal(b.K, 0);
  assert.equal(b.band, 'ELEVATED');
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

test('B12: the section 4 backtest rows get the documented band and G count (fixture band-backtest.json)', () => {
  assert.ok(BACKTEST.prs.length >= 8);
  for (const row of BACKTEST.prs) {
    const b = bandOf(row.files, LIVE);
    assert.equal(b.band, row.band, `#${row.pr} band`);
    assert.equal(b.G, row.G, `#${row.pr} G`);
  }
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

test('B16: HIGH (G = 5) is recommended CodeRabbit with the HIGH budget', async () => {
  const r = await recommendFor(GATE);
  assert.equal(r.band.band, 'HIGH');
  assert.equal(r.recommended, 'coderabbit');
  assert.deepEqual(r.budget, [1, 1]);
});

test('B17: G = 4 in one PR is still none (was CodeRabbit under R3)', async () => {
  const r = await recommendFor(GATE.slice(0, 4));
  assert.equal(r.band.band, 'ELEVATED');
  assert.equal(r.recommended, 'none');
});

test('B18: CRITICAL (risk:high in the facts, or an r3 path) is recommended CodeRabbit', async () => {
  const byLabel = await recommendFor(['docs/a.md'], { labels: ['risk:high'] });
  assert.equal(byLabel.band.band, 'CRITICAL');
  assert.equal(byLabel.recommended, 'coderabbit');
  const byPath = await recommendFor(['db/migrations/001_init.sql']);
  assert.equal(byPath.band.band, 'CRITICAL');
  assert.equal(byPath.recommended, 'coderabbit');
});

test('B19: a Dependabot PR still gets none, and a HIGH PR with a parser file keeps the R2 budget 1+0', async () => {
  const dep = await recommendFor(GATE, { dependabot: true });
  assert.equal(dep.recommended, 'none');
  const parser = await recommendFor([...GATE.slice(0, 4), '.claude/hooks/src/coderabbit-guard.ts']);
  assert.equal(parser.band.band, 'HIGH');
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

const renamed = (n) => Array.from({ length: n }, (_, i) => ({ filename: `.claude/hooks/src/new${i}-guard.ts`, previous_filename: `.claude/hooks/src/old${i}-guard.ts`, additions: 5, deletions: 5 }));

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
  assert.equal((await recommendFor(GATE, { labels: null })).recommended, 'coderabbit', 'a path-HIGH PR cannot be lowered by a label');
  assert.equal((await recommendFor(['docs/guide.md'], { labels: null, dependabot: true })).recommended, 'none');
  assert.equal((await recommendFor(['docs/guide.md'], { labels: [] })).recommended, 'none', 'read, and no risk:high: none');
});

/** The live-facts path: a real git repo, a stamp, and a fake gh (env PR_CHECKPOINT_GH) that prints the PR labels or fails. */
function liveCheckpoint({ labels, ghFails = false, file = 'docs/guide.md' }) {
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
    'process.stdout.write(process.env.FAKE_GH_VIEW);',
  ].join('\n'));
  const r = spawnSync(process.execPath, [path.join(HERE, 'pr-checkpoint.mjs'), '--json', '--config', cfg], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: 'invalid-token', PR_CHECKPOINT_GH: script, FAKE_GH_LOG: log, FAKE_GH_VIEW: JSON.stringify({ labels: (labels ?? []).map((name) => ({ name })) }), ...(ghFails ? { FAKE_GH_FAIL: '1' } : {}) },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { r, out: r.status === 0 ? JSON.parse(r.stdout) : null, calls };
}

test('B27: the live-facts path reads the PR labels: a risk:high docs-only PR is CRITICAL and coderabbit', () => {
  const { r, out, calls } = liveCheckpoint({ labels: ['risk:high', 'builder:claude'] });
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.equal(out.band.band, 'CRITICAL');
  assert.equal(out.recommended, 'coderabbit');
  assert.deepEqual(calls, [['pr', 'view', 'feat/x', '--json', 'labels', '-R', 'Rev4nchist/Continuous-Claude-v3']]);
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
