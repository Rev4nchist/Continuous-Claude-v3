// cockpit-pair.test.mjs — the 2026-08-04 shipped-together pair:
//   (1) hash quantization: day-counters (staleDays/reviewDays) no longer churn the
//       canonical card hash daily; band flips still do.
//   (2) embed identity verification: fresh-embed predicate shared by card/mobile/
//       cockpit publish paths (presence-only let a stale embed pass), and
//       readLastSweepSignal now skips sub-target/triage rows.
// Run: node --test "scripts/project-cards/test/*.test.mjs"
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeAttention, quantizeAttentionForHash } from '../lib/attention.mjs';
import { assembleCard } from '../assembler.mjs';
import { readLastSweepSignal, freshEmbedVerified, cockpitEmbedIdFromUrl } from '../sweep.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const project = {
  name: 'Quantize Co', health: 'Yellow', currentFocus: 'F', nextMilestone: 'M',
  decisionNeeded: false, latestUpdate: 'U', strategicBet: 'B', projectPage: '',
  lastEdited: '2026-07-10T12:00:00.000Z', reviewDate: '2026-08-20', stats: [],
};

function canonicalAt(nowIso) {
  const now = new Date(nowIso);
  const attention = computeAttention(
    { health: project.health, decisionNeeded: false, lastEditedISO: project.lastEdited, reviewDateISO: project.reviewDate },
    [], now,
  );
  return assembleCard(project, [], {
    series: [], attention: quantizeAttentionForHash(attention), asOf: '', now,
  });
}

test('quantized canonical hash is STABLE across a day tick within the same bands', () => {
  // 2026-08-01 vs 08-02: both stale (>14d since 07-10), review 19/18d out (later band).
  assert.equal(sha(canonicalAt('2026-08-01T08:00:00Z')), sha(canonicalAt('2026-08-02T08:00:00Z')));
});

test('quantized canonical hash CHANGES when a band flips (review later -> due-soon -> overdue)', () => {
  const later = canonicalAt('2026-08-01T08:00:00Z'); // review in 19d
  const dueSoon = canonicalAt('2026-08-15T08:00:00Z'); // review in 5d
  const overdue = canonicalAt('2026-08-25T08:00:00Z'); // review 5d past
  assert.notEqual(sha(later), sha(dueSoon));
  assert.notEqual(sha(dueSoon), sha(overdue));
});

test('quantizeAttentionForHash: bands + digit-neutralized reasons; raw counters gone', () => {
  const a = computeAttention(
    { health: 'Green', decisionNeeded: false, lastEditedISO: '2026-07-01T00:00:00Z', reviewDateISO: '2026-07-30' },
    [], new Date('2026-08-01T00:00:00Z'),
  );
  const q = quantizeAttentionForHash(a);
  assert.equal(q.staleDays, 'stale');
  assert.equal(q.reviewDays, 'overdue');
  assert.ok(q.reasons.every((s) => !/\d+d/.test(s)), 'reasons still carry day counts');
  assert.equal(q.score, a.score); // scoring untouched
});

test('freshEmbedVerified: fresh id or first publish verifies; stale/missing does not', () => {
  assert.equal(freshEmbedVerified(null, 'abc'), true); // nothing before
  assert.equal(freshEmbedVerified('abc', 'def'), true); // re-bound
  assert.equal(freshEmbedVerified('abc', 'abc'), false); // STALE — identity unchanged
  assert.equal(freshEmbedVerified('abc', null), false); // embed gone
  assert.equal(freshEmbedVerified(null, null), false);
});

test('cockpitEmbedIdFromUrl strips presigned noise; same file uuid -> same identity', () => {
  const uuid = '0a1b2c3d-0000-4444-8888-aabbccddeeff';
  const u1 = `https://s3.example/space/${uuid}/card.html?X-Amz-Signature=AAA`;
  const u2 = `https://s3.example/space/${uuid}/card.html?X-Amz-Signature=BBB`;
  assert.equal(cockpitEmbedIdFromUrl(u1), cockpitEmbedIdFromUrl(u2));
});

test('readLastSweepSignal: skips triage + sub-target rows; reads newest FULL row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-sig-'));
  const p = join(dir, 'sweep.jsonl');
  const rows = [
    { ts: '2026-08-03T08:00:00Z', target: 'full', error: null, publishFailed: [], hubRefreshed: true },
    { ts: '2026-08-03T12:00:00Z', step: 'triage', target: 'full' }, // lacks failure fields -> would derive ok=true
    { ts: '2026-08-03T20:00:00Z', target: 'mobile-cockpit', hubRefreshed: false }, // would derive ok=false
  ];
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  try {
    const sig = readLastSweepSignal(p);
    assert.equal(sig.ts, '2026-08-03T08:00:00Z'); // the full row, not the last line
    assert.equal(sig.ok, true);
    // A failed FULL row is still reported as failed.
    writeFileSync(p, JSON.stringify({ ts: '2026-08-04T08:00:00Z', target: 'full', error: 'boom' }) + '\n');
    assert.equal(readLastSweepSignal(p).ok, false);
    // Pre-`target`-era rows (no target, no step) still match.
    writeFileSync(p, JSON.stringify({ ts: '2026-07-01T08:00:00Z', hubRefreshed: true, publishFailed: [] }) + '\n');
    assert.equal(readLastSweepSignal(p).ok, true);
    // Only non-full rows -> null.
    writeFileSync(p, JSON.stringify({ ts: '2026-08-04T09:00:00Z', step: 'triage' }) + '\n');
    assert.equal(readLastSweepSignal(p), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
