// The interim CodeRabbit rule (Dave 2026-11-04). CodeRabbit is scarce: $0.25 a file, $50 a month. The checkpoint recommends it only when
//   (a) the PR has a risk:high label, or (b) the band is CRITICAL and a changed file is on CRITICAL_TRUST_BOUNDARY or matrix.security_tier.
// A docs-only PR never gets it. A month cap (coderabbit.monthly_file_cap) stops it when the month-to-date files plus this PR's files go over.
// Run: node --test scripts/github/pr-checkpoint-interim-cr.test.mjs
//
// How the rule can fail, and the test that catches it (written before the code):
//   HIGH by gate files alone still gets CodeRabbit                                          -> I1
//   HIGH with a floor file loses the aegis + critic floor line, or the pane stops saying why -> I2
//   risk:high (non-docs) loses CodeRabbit                                                   -> I3
//   CRITICAL + security-tier file, or CRITICAL + trust-boundary file, loses CodeRabbit      -> I4, I5
//   CRITICAL from an r3 path alone (or with only a critical file) still gets CodeRabbit      -> I6
//   a docs-only PR with risk:high still gets CodeRabbit                                     -> I7
//   a parser file (R2) or a critical file (R3) lifts CodeRabbit back without the trigger     -> I8
//   a parser file with the trigger loses the one-review R2 budget                           -> I8
//   the month cap is off by one, counts CLI rows or other months, or fails open on a bad ledger -> I9, I10
//   unread labels at HIGH give none, hiding a risk:high label                               -> I11
//   a person's `none` at HIGH or CRITICAL is recorded as `default` (the land gate refuses)   -> I12
//   the real CLI path ignores the fact, or prints no cap reason                             -> I13
//   the live path reads the wrong month, the wrong file, or turns a bad ledger into 0         -> I14
//   bandOf hides the label or the trust files that the rule needs                           -> I15
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recommend, pathFiltersFrom, confirmProblem, ledgerMonthFiles } from './pr-checkpoint.mjs';
import { bandOf } from './review-router.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const LIVE = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8'));
const YAML = readFileSync(path.join(ROOT, '.coderabbit.yaml'), 'utf8');
const HEAD = 'a'.repeat(40);
const NOW = '2026-11-04T12:00:00.000Z';
const STAMP = { head: HEAD, body_sha256: 'f'.repeat(64), results: [{ step: 'git:branch', status: 'PASS', detail: 'ok' }] };

// FIVE: five control-plane files, none critical, none security-tier: band HIGH by the gate score alone.
const FIVE = ['scripts/github/cr-fix.mjs', 'scripts/github/pr-checkpoint.mjs', '.claude/plugins/x/hooks/pr-loop/a.ts', 'scripts/github/local-review/prompt.mjs', 'scripts/github/local-review/context.mjs'];
const CRITICAL_FILE = 'scripts/github/review-status.mjs'; // checkpoint.critical, not security_tier, not trust boundary
const SECURITY_FILE = '.claude/hooks/src/pre-pr-gate.ts'; // matrix.security_tier
const TRUST_FILE = 'scripts/github/lib/file-lock.mjs'; // CRITICAL_TRUST_BOUNDARY (lib/**)
const R3_FILE = 'db/migrations/001_init.sql'; // class r3: CRITICAL by path
const PARSER_FILE = '.claude/hooks/src/coderabbit-guard.ts'; // checkpoint.parser

const policy = (over = {}) => ({
  ...LIVE, deep_enabled: false,
  greptile: { ...LIVE.greptile, credits_used_manual: null },
  coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: null, reviews_7d_manual_date: null },
  path_filters: pathFiltersFrom(YAML), ...over,
});
const file = (filename, additions = 10) => ({ filename, additions, deletions: 0 });
const run = (paths, labels = [], over = {}, pol = {}) => recommend({ head: HEAD, now: NOW, stamp: STAMP, files: paths.map((p) => file(p)), cli: { bySeverity: { minor: 1 } }, dependabot: false, config_drift: false, labels, ...over }, policy(pol));

test('I1: HIGH by gate files alone (no label, no trust file) is recommended none; CodeRabbit stays an option', () => {
  const r = run(FIVE);
  assert.equal(r.band.band, 'HIGH');
  assert.equal(r.recommended, 'none');
  assert.deepEqual(r.budget, [0, 0]);
  assert.equal(r.options[0].pathway, 'none', 'none is first when it is the recommendation');
  assert.ok(r.options.some((o) => o.pathway === 'coderabbit' && o.available), 'Dave can still press CodeRabbit');
  assert.match(r.why.join(' '), /interim/i, 'the pane says why');
});

test('I2: a HIGH PR without the trigger keeps the floor line (aegis + critic) when a critical file is in it', () => {
  const r = run([...FIVE.slice(0, 4), CRITICAL_FILE]);
  assert.equal(r.band.band, 'HIGH');
  assert.equal(r.recommended, 'none');
  assert.ok(r.why.some((w) => w.startsWith(`Critical-file floor (${CRITICAL_FILE})`)), r.why.join(' | '));
  assert.match(r.options.find((o) => o.pathway === 'none').reason, /aegis \+ critic/);
  const tier = run([...FIVE.slice(0, 4), SECURITY_FILE]);
  assert.equal(tier.band.band, 'HIGH');
  assert.equal(tier.recommended, 'none', 'HIGH + a security-tier file is not CRITICAL, so (b) does not fire');
});

test('I3: risk:high on a non-docs PR is recommended CodeRabbit, and the line names the label', () => {
  const r = run(FIVE, ['risk:high']);
  assert.equal(r.band.band, 'CRITICAL');
  assert.equal(r.recommended, 'coderabbit');
  assert.deepEqual(r.budget, [1, 1]);
  assert.match(r.why[0], /risk:high label/);
});

test('I4: CRITICAL by an r3 path plus a security-tier file (no label) is recommended CodeRabbit', () => {
  const r = run([R3_FILE, SECURITY_FILE]);
  assert.equal(r.band.band, 'CRITICAL');
  assert.deepEqual(r.band.securityTier, [SECURITY_FILE]);
  assert.notEqual(r.recommended, 'none');
  assert.ok(r.why.some((w) => w.includes(SECURITY_FILE)), 'the line names the security-tier file');
});

test('I5: CRITICAL by a trust-boundary file (no label) is recommended CodeRabbit', () => {
  const r = run([TRUST_FILE, 'scripts/github/other.mjs']);
  assert.equal(r.band.band, 'CRITICAL');
  assert.notEqual(r.recommended, 'none');
  assert.ok(r.why.some((w) => w.includes(TRUST_FILE)), 'the line names the trust-boundary file');
});

test('I6: CRITICAL from an r3 path alone, or r3 plus only a critical file, is recommended none', () => {
  const alone = run([R3_FILE]);
  assert.equal(alone.band.band, 'CRITICAL');
  assert.equal(alone.recommended, 'none');
  const withCritical = run([R3_FILE, CRITICAL_FILE]);
  assert.equal(withCritical.band.band, 'CRITICAL');
  assert.deepEqual(withCritical.band.securityTier, []);
  assert.equal(withCritical.recommended, 'none', 'checkpoint.critical is not on either list');
  assert.ok(withCritical.why.some((w) => w.startsWith('Critical-file floor')), 'the floor still applies');
});

test('I7: a docs-only PR gets none even with risk:high, and even when the band is CRITICAL', () => {
  const r = run(['docs/guide.md'], ['risk:high']);
  assert.equal(r.band.band, 'CRITICAL');
  assert.equal(r.recommended, 'none');
  assert.match(r.why.join(' '), /docs/i);
  assert.ok(r.options.some((o) => o.pathway === 'coderabbit'), 'Dave can still press CodeRabbit');
  assert.equal(run(['docs/guide.md', 'README.md'], ['risk:high']).recommended, 'none');
});

test('I8: a parser file or a critical file lifts CodeRabbit only with the trigger', () => {
  const parser = run([...FIVE.slice(0, 4), PARSER_FILE]);
  assert.equal(parser.band.band, 'HIGH');
  assert.equal(parser.recommended, 'none', 'R2 does not override a none');
  const crit = run([...FIVE.slice(0, 4), CRITICAL_FILE]);
  assert.equal(crit.recommended, 'none', 'R3 does not override a none');
  const withLabel = run([...FIVE.slice(0, 4), PARSER_FILE], ['risk:high']);
  assert.equal(withLabel.recommended, 'coderabbit');
  assert.deepEqual(withLabel.budget, [1, 0], 'the R2 one-review budget stays when the trigger fires');
});

const files20 = Array.from({ length: 20 }, (_, i) => `apps/x/src/f${i}.ts`);

test('I9: the month cap: 100 + 20 files recommends CodeRabbit, 150 + 20 recommends none and says why, the edge is 160', () => {
  const at = (mtd) => run(files20, ['risk:high'], { ledger_month_files: mtd });
  assert.equal(at(100).recommended, 'coderabbit');
  assert.equal(at(140).recommended, 'coderabbit', '140 + 20 = 160 is at the cap, not over it');
  const over = at(141);
  assert.equal(over.recommended, 'none', '141 + 20 = 161 is over');
  const cap = at(150);
  assert.equal(cap.recommended, 'none');
  assert.match(cap.why.join(' '), /160/);
  assert.match(cap.why.join(' '), /month/i);
  assert.match(cap.why.join(' '), /ledger month-to-date/);
  assert.match(cap.why.join(' '), /press CodeRabbit/i, 'Dave is told he can still press it');
  assert.ok(cap.options.some((o) => o.pathway === 'coderabbit' && o.available), 'the press stays open');
  assert.equal(run(files20, ['risk:high']).recommended, 'coderabbit', 'a fixture with no count is not capped');
});

test('I10: the cap reads coderabbit.monthly_file_cap from the config, and an unread ledger (null) fails closed', () => {
  assert.equal(LIVE.coderabbit.monthly_file_cap, 160);
  const small = run(files20, ['risk:high'], { ledger_month_files: 0 }, { coderabbit: { monthly_file_cap: 10 } });
  assert.equal(small.recommended, 'none', '20 files over a cap of 10');
  const unread = run(files20, ['risk:high'], { ledger_month_files: null });
  assert.equal(unread.recommended, 'none');
  assert.match(unread.why.join(' '), /ledger/i);
});

test('I11: unread labels stop the checkpoint at HIGH too: a hidden risk:high would flip none to CodeRabbit', () => {
  const r = run(FIVE, null);
  assert.equal(r.recommended, null);
  assert.match(r.why[0], /labels/i);
  assert.equal(run(FIVE, null, { dependabot: true }).recommended, 'none');
});

test('I12: --by default cannot record none at HIGH or CRITICAL even when none is the recommendation; --by dave can', () => {
  for (const [paths, labels] of [[FIVE, []], [[R3_FILE], []], [['docs/guide.md'], ['risk:high']]]) {
    const result = run(paths, labels);
    assert.equal(result.recommended, 'none');
    const facts = { stamp: STAMP };
    const base = { result, facts, pathway: 'none', bodySha: 'f'.repeat(64) };
    assert.match(confirmProblem({ ...base, by: 'default' }) ?? '', /only Dave|--by dave/i, `${result.band.band}`);
    assert.equal(confirmProblem({ ...base, by: 'dave' }), null);
  }
});

test('I13: the CLI (--facts) prints the cap reason from the ledger_month_files fact', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'interim-cr-'));
  const factsFile = path.join(dir, 'facts.json');
  const cfg = path.join(dir, 'config.json');
  writeFileSync(factsFile, JSON.stringify({ head: HEAD, now: NOW, stamp: STAMP, files: files20.map((p) => file(p)), labels: ['risk:high'], cli: { bySeverity: { minor: 1 } }, dependabot: false, config_drift: false, ledger_month_files: 150 }));
  writeFileSync(cfg, JSON.stringify(policy()));
  const r = spawnSync(process.execPath, [path.join(HERE, 'pr-checkpoint.mjs'), '--json', '--facts', factsFile, '--config', cfg], { encoding: 'utf8', cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.recommended, 'none');
  assert.match(out.why.join(' '), /ledger month-to-date/);
});

test('I14b: a PR row with a missing, negative or fractional files value makes the month unreadable (null), so the checkpoint recommends none', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'interim-ledger-bad-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  const row = (files) => JSON.stringify({ ts: '2026-11-01T10:00:00.000Z', date: '2026-11-01', pr: 1, head: HEAD, ...(files === undefined ? {} : { files }), cost: 1, session: 's' });
  for (const files of [undefined, -5, 2.5]) {
    writeFileSync(ledger, `${[row(30), row(files)].join('\n')}\n`);
    assert.equal(ledgerMonthFiles(NOW, { ledgerPath: ledger }), null, `files ${String(files)}`);
  }
});

test('I4b: a rename whose OLD name is security-tier and whose new name is another gate file still counts as a security-tier file', () => {
  const renamed = { filename: 'scripts/github/cr-fix.mjs', previous_filename: SECURITY_FILE, additions: 5, deletions: 5 };
  const r = run([], [], { files: [file(R3_FILE), renamed] });
  assert.equal(r.band.band, 'CRITICAL');
  assert.deepEqual(r.band.securityTier, [SECURITY_FILE]);
  assert.notEqual(r.recommended, 'none', 'the rename must not hide the security-tier trigger');
  const intoTier = run([], [], { files: [file(R3_FILE), { filename: SECURITY_FILE, previous_filename: 'scripts/github/cr-fix.mjs', additions: 5, deletions: 5 }] });
  assert.deepEqual(intoTier.band.securityTier, [SECURITY_FILE]);
});

test('I14: ledgerMonthFiles reads the Chicago month of now from the ledger file (env seam or deps), and a bad ledger gives null, not 0', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'interim-ledger-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  const row = (date, files, extra = {}) => JSON.stringify({ ts: `${date}T10:00:00.000Z`, date, pr: 1, head: HEAD, files, cost: files / 4, session: 's', ...extra });
  writeFileSync(ledger, [row('2026-11-01', 30), row('2026-11-03', 20), row('2026-10-31', 99), row('2026-11-02', 50, { kind: 'cli', branch: 'b', pr: undefined })].join('\n') + '\n');
  assert.equal(ledgerMonthFiles(NOW, { ledgerPath: ledger }), 50);
  assert.equal(ledgerMonthFiles(NOW, {}, { PR_CHECKPOINT_LEDGER: ledger }), 50);
  assert.equal(ledgerMonthFiles(NOW, { ledgerPath: path.join(dir, 'missing.jsonl') }), 0, 'no ledger file is an empty month');
  writeFileSync(ledger, 'not json\n');
  assert.equal(ledgerMonthFiles(NOW, { ledgerPath: ledger }), null);
});

test('I15: bandOf returns the label and the trust-boundary files apart from L', () => {
  const b = bandOf(['docs/a.md'], LIVE, { labels: ['risk:high'] });
  assert.deepEqual([b.labelHigh, b.trustFiles, b.L], [true, [], true]);
  const t = bandOf([TRUST_FILE, 'scripts/github/lib/file-lock.test.mjs'], LIVE);
  assert.deepEqual([t.labelHigh, t.trustFiles, t.L], [false, [TRUST_FILE], true], 'a test file is not a trust file');
  const r3 = bandOf([R3_FILE], LIVE);
  assert.deepEqual([r3.labelHigh, r3.trustFiles, r3.L], [false, [], true]);
});
