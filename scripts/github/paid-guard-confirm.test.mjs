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
  writeFileSync(fakeGh, "if (!process.env.FAKE_GH_HEAD) { console.error('network down'); process.exit(1); }\nconsole.log(JSON.stringify({ headRefOid: process.env.FAKE_GH_HEAD, number: 349 }));\n");
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

test('PC5: a confirm that is refused (no tap) writes no paid row', () => {
  const t = setup();
  t.ask();
  const r = t.confirm('coderabbit', { FAKE_GH_HEAD: HEAD });
  assert.equal(r.status, 1);
  assert.equal(D.decisionRowRead(paid()), null);
  assert.ok(!existsSync(t.pathwayFile));
});
