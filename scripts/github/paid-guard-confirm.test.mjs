// Tests for the paid-round row that `pr-checkpoint.mjs --confirm` writes AFTER the record (card prflow-paid-run-guard, PR 2, step b).
// Run: node --test scripts/github/paid-guard-confirm.test.mjs
// The real engine CLI runs with --facts and --config, a temp decision store and a fake gh (PR_CHECKPOINT_GH): no GitHub call, no real store.
//
// How the unit can fail, and the test that catches it:
//   a paid pick on the PR head writes no row, or a row with another label, tapAt or entry than the tap it used up      -> PC1
//   the free-slot row, the none row or the wait row writes a paid row                                                    -> PC2
//   a head that is not the PR head, or a failed GitHub read, still writes a row                                          -> PC3
//   a tap with no entry stamp (an old row) writes a row                                                                  -> PC4
//   the row is written when the record was refused (no tap), or before the record                                        -> PC5
//   a draft PR loses its paid row (a pick is confirmed while the PR is a draft); a drop of the taps while the confirm reads the PR leaves a row   -> PC6, PC7, PC8
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_REPO } from './review-router.mjs';
import { makeTempDir, registerTempCleanup } from '../lib/temp-tracker.mjs';

registerTempCleanup();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const LIVE = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8'));
const ENGINE = path.join(HERE, 'pr-checkpoint.mjs');
const D = await import(pathToFileURL(path.join(HERE, 'lib', 'decisions.mjs')).href);

const NOW = '2026-11-18T12:00:00.000Z';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const PR = 349;
const KEY = `${DEFAULT_REPO}#${PR}`;
const BODY_TEXT = 'PR body\n';
const BODY_SHA = createHash('sha256').update(BODY_TEXT).digest('hex');
const FIVE = ['scripts/github/cr-fix.mjs', 'scripts/github/pr-checkpoint.mjs', '.claude/plugins/x/hooks/pr-loop/a.ts', 'scripts/github/local-review/prompt.mjs', 'scripts/github/local-review/context.mjs'];
const FREE = { state: 'free', checkedAt: NOW, nextSlotAt: null, minutesToSlot: null, lastNoticeAt: null, cliRemaining: null, source: 'probe' };

const review = () => ({ step: 'review', key: KEY, head: HEAD });
const paid = (head = HEAD) => ({ step: 'paid-round', key: KEY, head });

function setup({ capacity = null, labels = ['risk:high'] } = {}) {
  const dir = makeTempDir('paid-confirm-');
  const state = path.join(dir, 'pre-pr');
  mkdirSync(state, { recursive: true });
  const factsFile = path.join(dir, 'facts.json');
  const cfgFile = path.join(dir, 'config.json');
  const bodyFile = path.join(dir, 'body.md');
  const fakeGh = path.join(dir, 'fake-gh.mjs');
  const stamp = { head: HEAD, body_sha256: BODY_SHA, results: [{ step: 'git:branch', status: 'PASS', detail: 'ok' }] };
  writeFileSync(factsFile, JSON.stringify({ head: HEAD, now: NOW, stamp, files: FIVE.map((filename) => ({ filename, additions: 10, deletions: 0 })), cli: { bySeverity: { minor: 1 } }, dependabot: false, config_drift: false, labels, ...(capacity ? { capacity } : {}) }));
  writeFileSync(bodyFile, BODY_TEXT);
  writeFileSync(cfgFile, JSON.stringify({ ...LIVE, deep_enabled: false, greptile: { ...LIVE.greptile, credits_used_manual: null }, coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: null, reviews_7d_manual_date: null }, checkpoint: { ...LIVE.checkpoint, autoConfirm: false, ledger: true } }));
  // `pr view` answers FAKE_GH_HEAD as the PR head; with no FAKE_GH_HEAD it fails like an unreachable GitHub.
  // FAKE_GH_DRAFT=1: the PR is a draft on every read (a pick is confirmed while the PR is a draft: applyPathway needs that).
  // FAKE_GH_DROP=1: the first `pr view` first runs the drop of the taps of the PR, the way a return to draft and its --drop-taps land at that moment.
  const decisionsUrl = pathToFileURL(path.join(HERE, 'lib', 'decisions.mjs')).href;
  writeFileSync(fakeGh, [
    `import { decisionKey, dropKey } from ${JSON.stringify(decisionsUrl)};`,
    "if (!process.env.FAKE_GH_HEAD) { console.error('network down'); process.exit(1); }",
    "if (process.env.FAKE_GH_DROP === '1' && process.argv.includes('view')) dropKey({ steps: ['review', 'paid-round'], key: decisionKey({ pr: 349 }) });",
    "console.log(JSON.stringify({ headRefOid: process.env.FAKE_GH_HEAD, isDraft: process.env.FAKE_GH_DRAFT === '1', number: 349 }));",
    '',
  ].join('\n'));
  const storeFile = path.join(dir, 'decisions.json');
  process.env.CCV3_DECISIONS_FILE = storeFile;
  const env = (over = {}) => ({ ...process.env, GH_TOKEN: 'invalid-token', GH_CONFIG_DIR: dir, CCV3_DECISIONS_FILE: storeFile, PR_CHECKPOINT_NO_PROBE: '1', PR_CHECKPOINT_TEST: '1', PR_CHECKPOINT_GH: fakeGh, ...over });
  const run = (args, over = {}) => spawnSync(process.execPath, [ENGINE, ...args, ...(args.includes('--confirm') ? ['--state-dir', state] : []), '--facts', factsFile, '--config', cfgFile], { encoding: 'utf8', cwd: dir, env: env(over) });
  const ask = () => { const r = run(['--json', '--pr', String(PR)]); assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`); return JSON.parse(r.stdout).ledger.ask; };
  const confirm = (pathway, over = {}) => run(['--confirm', pathway, '--by', 'dave', '--body', bodyFile, '--pr', String(PR)], over);
  return { ask, confirm, pathwayFile: path.join(state, 'pathway.json') };
}

const labelOf = (spec, re) => spec.options.find((o) => re.test(o.label)).label;
const tap = (label, entry) => assert.deepEqual(D.decisionRecord({ ...review(), label, ...(entry === undefined ? {} : { entry }) }), { ok: true }, label);

test('PC1: a paid pick on the PR head writes one paid-round row after the record, with the tapped label and the tap stamp it used up', () => {
  const t = setup();
  const label = labelOf(t.ask(), /^CodeRabbit review/);
  tap(label, 'cli');
  const tapAt = D.decisionRowRead(review()).tapAt;
  const r = t.confirm('coderabbit', { FAKE_GH_HEAD: HEAD });
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.ok(existsSync(t.pathwayFile), 'the record is written');
  const row = D.decisionRowRead(paid());
  assert.ok(row, 'the paid-round row exists');
  assert.equal(row.label, label);
  assert.equal(D.capCentsOfLabel(row.label), 125);
  assert.equal(row.tapAt, tapAt, 'it copies the tap time, not the confirm time');
  assert.equal(row.entry, 'cli');
  assert.equal(D.decisionRowRead(review()), null, 'the review tap is used up');
});

test('PC2: the free-slot row, the none row and the wait row write no paid row', () => {
  const free = setup({ capacity: FREE });
  const freeLabel = labelOf(free.ask(), /^CodeRabbit now/);
  tap(freeLabel, 'cli');
  const r = free.confirm('coderabbit', { FAKE_GH_HEAD: HEAD });
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.equal(D.decisionRowRead(paid()), null, 'the free-slot pick has no price: no paid row');
  const none = setup();
  tap(labelOf(none.ask(), /^No review/), 'cli');
  assert.equal(none.confirm('none', { FAKE_GH_HEAD: HEAD }).status, 0);
  assert.equal(D.decisionRowRead(paid()), null, 'none writes no paid row');
});

test('PC3: a head that is not the PR head, or a failed GitHub read, writes no row; the record stays', () => {
  const moved = setup();
  tap(labelOf(moved.ask(), /^CodeRabbit review/), 'cli');
  const r = moved.confirm('coderabbit', { FAKE_GH_HEAD: OTHER });
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.match(r.stderr, /no paid yes was stored/);
  assert.ok(existsSync(moved.pathwayFile), 'the record stays');
  assert.equal(D.decisionRowRead(paid()), null);
  const down = setup();
  tap(labelOf(down.ask(), /^CodeRabbit review/), 'cli');
  const r2 = down.confirm('coderabbit', {});
  assert.equal(r2.status, 0, `${r2.stdout} ${r2.stderr}`);
  assert.match(r2.stderr, /could not be read from GitHub/);
  assert.equal(D.decisionRowRead(paid()), null);
});

test('PC4: a tap with no entry stamp writes no row (no stamp, no paid yes)', () => {
  const t = setup();
  tap(labelOf(t.ask(), /^CodeRabbit review/));
  const r = t.confirm('coderabbit', { FAKE_GH_HEAD: HEAD });
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.match(r.stderr, /no-stamp/);
  assert.equal(D.decisionRowRead(paid()), null);
});

test('PC6 (control, seat ruling): a pick is confirmed while the PR is a DRAFT, and a draft PR keeps its paid row (applyPathway marks it ready later)', () => {
  const t = setup();
  tap(labelOf(t.ask(), /^CodeRabbit review/), 'cli');
  const r = t.confirm('coderabbit', { FAKE_GH_HEAD: HEAD, FAKE_GH_DRAFT: '1' });
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /no paid yes was stored/);
  assert.ok(D.decisionRowRead(paid()), 'the paid row is stored for a draft PR');
  assert.ok(existsSync(t.pathwayFile), 'the record is written');
});

test('PC7 (CLI run 3, seat option A): a drop of the taps that lands while the confirm reads the PR leaves NO paid row: the tap and the paid row are one step', () => {
  const t = setup();
  tap(labelOf(t.ask(), /^CodeRabbit review/), 'cli');
  // The fake gh runs the drop at its first `pr view`. With the PR read BEFORE the use of the tap, the drop removes the tap, the confirm is refused and nothing is
  // stored. With the read AFTER the use (the old order), the drop finds nothing to remove and the write after it recreates the row.
  const r = t.confirm('coderabbit', { FAKE_GH_HEAD: HEAD, FAKE_GH_DROP: '1' });
  assert.equal(r.status, 1, `${r.stdout} ${r.stderr}`);
  assert.match(r.stderr, /could not be used up/);
  assert.equal(D.decisionRowRead(paid()), null, 'no paid row survives the drop');
  assert.equal(D.decisionRowRead(review()), null, 'the tap is gone');
  assert.ok(!existsSync(t.pathwayFile), 'no record is written');
});

test('PC8 (seat option A): the paid row is written in the same step that uses the tap up: a used tap always has its paid row, an unused one has none', () => {
  const t = setup();
  tap(labelOf(t.ask(), /^CodeRabbit review/), 'cli');
  const before = D.decisionRowRead(review());
  assert.ok(before, 'the tap is there');
  assert.equal(D.decisionRowRead(paid()), null, 'no paid row before the confirm');
  const r = t.confirm('coderabbit', { FAKE_GH_HEAD: HEAD });
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.equal(D.decisionRowRead(review()), null, 'the tap is used up');
  const row = D.decisionRowRead(paid());
  assert.ok(row, 'and its paid row exists');
  assert.equal(row.tapAt, before.tapAt, 'the row copies the stamp of the tap it used up');
  assert.equal(row.entry, 'cli');
});

test('PC9 (seat proof): the paid row a confirm writes is the row `cr-paid` post reads (same key, same head): the post goes out and uses the row up', async () => {
  const PAID = await import(pathToFileURL(path.join(HERE, 'cr-paid.mjs')).href);
  const t = setup(); // setup() puts a temp decision store at CCV3_DECISIONS_FILE: both sides read it
  tap(labelOf(t.ask(), /^CodeRabbit review/), 'cli');
  const confirmed = t.confirm('coderabbit', { FAKE_GH_HEAD: HEAD });
  assert.equal(confirmed.status, 0, `${confirmed.stdout} ${confirmed.stderr}`);
  assert.ok(D.decisionRowRead(paid()), 'the confirm wrote the paid row');
  // `post` on a PR with 4 files ($1.00, under the $1.25 the pick tapped). A key or head mismatch between writer and reader would make it refuse with "No paid yes".
  const prFiles = Array.from({ length: 4 }, (_, i) => ({ filename: `src/f${i}.ts`, additions: 5, deletions: 0, status: 'modified' }));
  const posts = [];
  const gh = (args) => {
    if (args.includes('POST')) { posts.push(args); return { id: 1 }; }
    if (args.includes('graphql')) return { data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false }, nodes: [] } } } } };
    if (args.some((a) => /issues\/\d+\/comments/.test(a))) return [];
    if (args.some((a) => /pulls\/\d+\/files/.test(a))) return [prFiles];
    if (args.some((a) => /pulls\/\d+\/commits/.test(a))) return [[{ sha: HEAD }]];
    if (args.some((a) => /pulls\/\d+\/reviews/.test(a))) return [[]];
    return { head: { sha: HEAD }, state: 'open', merged: false, draft: false };
  };
  const wait = { state: 'wait', nextSlotAt: new Date(Date.now() + 20 * 60_000).toISOString(), checkedAt: new Date().toISOString(), minutesToSlot: 20, source: 'notice' };
  const ledgerPath = path.join(makeTempDir('paid-confirm-ledger-'), 'coderabbit-paid.jsonl');
  const out = PAID.postPaid({ pr: PR, repo: DEFAULT_REPO }, { gh, ledgerPath, pathFilters: () => [], env: {}, capacity: () => wait, lockWaitMs: 100 });
  assert.equal(out.ok, true, out.text);
  assert.equal(posts.length, 1, 'one paid comment was posted');
  assert.equal(D.decisionRowRead(paid()), null, 'the row is used up');
});

test('PC5: a confirm that is refused (no tap) writes no paid row', () => {
  const t = setup();
  t.ask();
  const r = t.confirm('coderabbit', { FAKE_GH_HEAD: HEAD });
  assert.equal(r.status, 1);
  assert.equal(D.decisionRowRead(paid()), null);
  assert.ok(!existsSync(t.pathwayFile));
});
