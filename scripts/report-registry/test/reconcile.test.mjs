// reconcile.test.mjs — pure tests for the local-artifact reconciler. No ntn, no FS.
// The first block is the one that matters: absent-only. Getting it wrong turns a
// reporting gap into reporting corruption, which is strictly worse.
// Run: node --test scripts/report-registry/test/reconcile.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decide, artifactAgeMs, listArtifacts, parseArgs, reconcile,
  DEFAULT_MAX_AGE_DAYS, CLEAN_GRACE_HOURS, ARTIFACT_RE,
} from '../reconcile.mjs';

const NOW = Date.parse('2026-07-27T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

const run = (over = {}) => ({
  runId: 'Project Portfolio|2026-07-27|2026-07-27T11:00:00Z',
  type: 'Project Portfolio', period: '2026-07-27', runDate: hoursAgo(1),
  status: 'Failed', source: 'Project-Cards', ...over,
});

// --- absent-only: the rule the whole file exists to honour -----------------------

test('an existing row is NEVER written over, however stale the artifact looks', () => {
  // A pre-emit artifact shares its runId with the row the finished run updates in
  // place. Upserting it would regress a completed OK row back to Failed/in-progress.
  const d = decide(run(), [{ id: 'page-1' }], { now: NOW, mtimeMs: NOW });
  assert.equal(d.action, 'present');
  assert.match(d.reason, /NOT touched/);
});

test('multiple existing rows are also left alone — dedup is not this tool\'s job', () => {
  assert.equal(decide(run(), [{ id: 'a' }, { id: 'b' }], { now: NOW, mtimeMs: NOW }).action, 'present');
});

test('only a runId with no row at all is repaired', () => {
  const d = decide(run(), [], { now: NOW, mtimeMs: NOW });
  assert.equal(d.action, 'repair');
});

// --- age bound -------------------------------------------------------------------

test('an artifact older than the bound is skipped, even with no row', () => {
  const old = run({ runDate: hoursAgo(24 * 30) });
  const d = decide(old, [], { now: NOW, mtimeMs: NOW });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /older than 7d \(30d\)/);
});

test('the age bound is configurable and applied against the run date', () => {
  const twelveDays = run({ runDate: hoursAgo(24 * 12) });
  assert.equal(decide(twelveDays, [], { now: NOW, mtimeMs: NOW }).action, 'skip');
  assert.equal(decide(twelveDays, [], { now: NOW, mtimeMs: NOW, maxAgeDays: 14 }).action, 'repair');
});

test('age comes from runDate, and falls back to mtime only when runDate is unusable', () => {
  assert.equal(artifactAgeMs(run({ runDate: hoursAgo(2) }), { now: NOW, mtimeMs: NOW }), 2 * 3_600_000);
  // mtime is a proxy that a re-read or restore can move, so it is the fallback only.
  assert.equal(artifactAgeMs(run({ runDate: 'garbage' }), { now: NOW, mtimeMs: NOW - 5_000 }), 5_000);
  assert.equal(artifactAgeMs(run({ runDate: '' }), { now: NOW, mtimeMs: undefined }), 0);
});

test('a future-dated artifact reads as age zero rather than negative', () => {
  // The box has a real clock-skew history; a negative age must not wrap past the bound.
  assert.equal(artifactAgeMs(run({ runDate: hoursAgo(-6) }), { now: NOW, mtimeMs: NOW }), 0);
});

// --- cleanup ---------------------------------------------------------------------

test('a fresh artifact is never cleaned — its run may still be in flight', () => {
  const d = decide(run({ runDate: hoursAgo(2) }), [{ id: 'p' }], { now: NOW, mtimeMs: NOW });
  assert.equal(d.cleanable, false);
});

test('an artifact past the grace window whose row is confirmed is cleanable', () => {
  const d = decide(run({ runDate: hoursAgo(CLEAN_GRACE_HOURS + 1) }), [{ id: 'p' }], { now: NOW, mtimeMs: NOW });
  assert.equal(d.cleanable, true);
});

// --- sweep behaviour -------------------------------------------------------------

const harness = (files, rowsByRunId, opts = {}) => {
  const calls = { upserted: [], removed: [], logs: [] };
  const res = reconcile({
    dir: '/fake',
    now: NOW,
    readdir: () => Object.keys(files),
    read: (p) => files[p.split(/[/\\]/).pop()],
    stat: () => ({ mtimeMs: NOW }),
    query: (_ds, q) => rowsByRunId[q.filter.rich_text.equals] || [],
    upsert: (r) => { calls.upserted.push(r.runId); return { action: 'created', pageId: 'new-1' }; },
    remove: (p) => calls.removed.push(p.split(/[/\\]/).pop()),
    log: (m) => calls.logs.push(m),
    warn: (m) => calls.logs.push(m),
    ...opts,
  });
  return { res, calls };
};

test('the specimen case: a run that happened, with no row, is recovered', () => {
  const r = run();
  const { res, calls } = harness({ 'report-run-Project-Cards-preemit.json': JSON.stringify(r) }, {});
  assert.deepEqual(calls.upserted, [r.runId]);
  assert.equal(res.repaired.length, 1);
});

test('a run the registry already knows is not upserted and not deleted while fresh', () => {
  const r = run();
  const { res, calls } = harness({ 'report-run-X.json': JSON.stringify(r) }, { [r.runId]: [{ id: 'p1' }] });
  assert.deepEqual(calls.upserted, []);
  assert.deepEqual(calls.removed, []);
  assert.equal(res.present.length, 1);
});

test('--keep suppresses deletion even when the artifact is cleanable', () => {
  const r = run({ runDate: hoursAgo(CLEAN_GRACE_HOURS + 1) });
  const { calls } = harness({ 'report-run-X.json': JSON.stringify(r) }, { [r.runId]: [{ id: 'p1' }] }, { keep: true });
  assert.deepEqual(calls.removed, []);
});

test('a confirmed, past-grace artifact is cleaned', () => {
  const r = run({ runDate: hoursAgo(CLEAN_GRACE_HOURS + 1) });
  const { calls } = harness({ 'report-run-X.json': JSON.stringify(r) }, { [r.runId]: [{ id: 'p1' }] });
  assert.deepEqual(calls.removed, ['report-run-X.json']);
});

test('--dry-run writes nothing and deletes nothing', () => {
  const r = run();
  const { res, calls } = harness({ 'report-run-X.json': JSON.stringify(r) }, {}, { dryRun: true });
  assert.deepEqual(calls.upserted, []);
  assert.deepEqual(calls.removed, []);
  assert.equal(res.repaired.length, 1);
  assert.equal(res.repaired[0].dryRun, true);
});

test('one malformed artifact does not stop the sweep recovering the others', () => {
  const good = run({ runId: 'Team Dashboard|2026-07-27|t', type: 'Team Dashboard', source: 'Dashboard-Sync' });
  const { res, calls } = harness({
    'report-run-broken.json': '{ not json',
    'report-run-good.json': JSON.stringify(good),
  }, {});
  assert.deepEqual(calls.upserted, [good.runId]);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].error, /unreadable\/invalid/);
});

test('an artifact failing validation is reported, not silently upserted', () => {
  const bad = run({ status: 'Nonsense' });
  const { res, calls } = harness({ 'report-run-X.json': JSON.stringify(bad) }, {});
  assert.deepEqual(calls.upserted, []);
  assert.equal(res.failed.length, 1);
});

test('a registry query failure fails that artifact rather than assuming absence', () => {
  // Assuming absence on an unreachable registry is how you create duplicate rows.
  const { res, calls } = harness({ 'report-run-X.json': JSON.stringify(run()) }, {}, {
    query: () => { throw new Error('ETIMEDOUT'); },
  });
  assert.deepEqual(calls.upserted, []);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].error, /registry query failed/);
});

// --- discovery + args ------------------------------------------------------------

test('both pre-emit and final artifact names are swept, unrelated files are not', () => {
  assert.ok(ARTIFACT_RE.test('report-run-Project-Cards-preemit.json'));
  assert.ok(ARTIFACT_RE.test('report-run-Self-Improvement.json'));
  assert.ok(!ARTIFACT_RE.test('report-run-.json'), 'a nameless artifact is not a match');
  assert.ok(!ARTIFACT_RE.test('work-rows-proposal-x.json'));
  assert.deepEqual(
    listArtifacts('/fake', { readdir: () => ['report-run-A.json', 'notes.txt', 'report-run-B.json'] }),
    ['report-run-A.json', 'report-run-B.json'],
  );
});

// D6 (decided 2026-08-02): a recovery tool that mutates the registry and deletes
// artifacts BY DEFAULT is a foot-gun for the exact operator who reaches for it —
// someone mid-incident. Default is report-only + keep-everything; --apply opts in.
test('parseArgs defaults to --dry-run --keep (report-only, delete-nothing)', () => {
  const a = parseArgs([]);
  assert.equal(a.dryRun, true);
  assert.equal(a.keep, true);
  assert.equal(a.maxAgeDays, DEFAULT_MAX_AGE_DAYS);
});

test('parseArgs: --apply enables writes AND cleanup; --apply --keep writes but never deletes', () => {
  const a = parseArgs(['--apply']);
  assert.equal(a.dryRun, false);
  assert.equal(a.keep, false, '--apply alone un-keeps: cleanup of confirmed-present artifacts is part of the live sweep');
  const b = parseArgs(['--apply', '--keep']);
  assert.equal(b.dryRun, false);
  assert.equal(b.keep, true, 'an explicit --keep survives --apply');
});

test('parseArgs: --apply with --dry-run is a contradiction and fails loud', () => {
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /contradict/);
  assert.throws(() => parseArgs(['--dry-run', '--apply']), /contradict/);
});

test('parseArgs rejects a nonsense age and unknown flags', () => {
  assert.throws(() => parseArgs(['--max-age-days', '0']), /positive number/);
  assert.throws(() => parseArgs(['--max-age-days', 'soon']), /positive number/);
  assert.throws(() => parseArgs(['--wat']), /unknown flag/);
});
