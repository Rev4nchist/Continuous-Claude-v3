// backfill.test.mjs — pure tests for the historical backfill extractors.
// Verifies DETERMINISTIC runIds (idempotency key = <type>|<period>|<stable-marker>),
// period normalization, ISO-week date derivation, and status mapping. No FS/ntn.
// Run: node --test scripts/report-registry/test/backfill.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizePeriod, isoWeekMonday, healthStatus,
  vpRunsFromDirs, sponsorRunsFromDecks, selfImprovementRunsFromIndex, healthRunFromReport,
} from '../backfill.mjs';
import { validateRun } from '../upsert.mjs';

// --- normalization -------------------------------------------------------------

test('normalizePeriod keeps ISO weeks and trims dates to YYYY-MM-DD', () => {
  assert.equal(normalizePeriod('2026-W27'), '2026-W27');
  assert.equal(normalizePeriod('2026w07'), '2026-W07');
  assert.equal(normalizePeriod('2026-07-01T13:30:00Z'), '2026-07-01');
  assert.equal(normalizePeriod('2026-06-30'), '2026-06-30');
});

test('isoWeekMonday returns the Monday of an ISO week', () => {
  assert.equal(isoWeekMonday(2026, 7), '2026-02-09');
  assert.equal(isoWeekMonday(2026, 27), '2026-06-29');
});

test('healthStatus maps overall_status to a registry Status enum', () => {
  assert.equal(healthStatus('PASS'), 'OK');
  assert.equal(healthStatus('WARN'), 'Warn');
  assert.equal(healthStatus('FAIL'), 'Failed');
  // HIGH_FAIL and CRITICAL_FAIL are real health_check.py _overall_status() values
  // (the two fail severities above bare FAIL) -- a prior version of the map
  // omitted them, so they silently fell through to the default and were
  // recorded as OK (found + corrected 2026-07-16; see backfill remap).
  assert.equal(healthStatus('HIGH_FAIL'), 'Failed');
  assert.equal(healthStatus('CRITICAL_FAIL'), 'Failed');
  assert.equal(healthStatus('SKIP'), 'Skipped');
  // Fail-safe default: an unrecognized overall_status must never silently read
  // as healthy -- it maps to Warn so a human notices, not OK.
  assert.equal(healthStatus('weird'), 'Warn');
});

// --- VP Weekly (RETIRED 2026-07-25, extractor retained + still valid) -----------
// The type stays in REPORT_TYPES (validation domain) so its historical rows remain
// upsertable; only its EXPECTATION (watchdog schedule, hub row, drift) was removed.
// This test therefore still holds and guards the revive path.

test('vpRunsFromDirs: deterministic runId, real date, GH Pages url; ignores junk dirs', () => {
  const runs = vpRunsFromDirs(['2026-W07', '2026-W27', 'not-a-week', '.git']);
  assert.equal(runs.length, 2);
  const r = runs[0];
  assert.equal(r.runId, 'VP Weekly|2026-W07|2026-W07');
  assert.equal(r.period, '2026-W07');
  assert.equal(r.runDate, '2026-02-09');
  assert.match(r.artifactUrl, /ai-enablement-status\/reports\/2026-W07\/$/);
  runs.forEach((x) => assert.equal(validateRun(x), x)); // all upsertable
});

// --- FourthOS Sponsor ----------------------------------------------------------

test('sponsorRunsFromDecks: only sponsor-updates decks, deep-linked, deterministic id', () => {
  const decks = {
    site: { url: 'https://rev4nchist.github.io/ai-enablement-decks/' },
    decks: [
      { id: 'fourthos-2026-07-01', section: 'sponsor-updates', title: 'FourthOS — 1 July', date: '2026-07-01', href: './fourthos/2026-07-01/' },
      { id: 'other', section: 'portfolio', title: 'x', date: '2026-07-01' },
    ],
  };
  const runs = sponsorRunsFromDecks(decks);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, 'FourthOS Sponsor|2026-07-01|fourthos-2026-07-01');
  assert.equal(runs[0].artifactUrl, 'https://rev4nchist.github.io/ai-enablement-decks/fourthos/2026-07-01/');
  assert.equal(validateRun(runs[0]), runs[0]);
});

// --- Self-Improvement ----------------------------------------------------------

test('selfImprovementRunsFromIndex: parses table rows, skips header/separator', () => {
  const md = [
    '| Date | Component | Verdict | Headline | Sources | Proposal |',
    '|------|-----------|---------|----------|---------|----------|',
    '| 2026-06-30 | Memory | adopt | some headline | 23 | [proposal](proposals/2026-06-30-memory.md) |',
    '| 2026-07-01 | Hooks | adopt | another | 15 | [proposal](proposals/2026-07-01-hooks.md) |',
  ].join('\n');
  const runs = selfImprovementRunsFromIndex(md);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].runId, 'Self-Improvement|2026-06-30|2026-06-30-memory');
  assert.equal(runs[0].summary, 'Memory — adopt');
  assert.equal(runs[0].artifactUrl, 'docs/self-improvement/proposals/2026-06-30-memory.md');
  runs.forEach((x) => assert.equal(validateRun(x), x));
});

// --- System Health -------------------------------------------------------------

test('healthRunFromReport: status from overall, counts summary, deterministic id', () => {
  const report = {
    timestamp: '2026-04-24T12:26:27.110005+00:00',
    overall_status: 'WARN',
    counts: { PASS: 8, WARN: 1, FAIL: 0, SKIP: 0 },
  };
  const run = healthRunFromReport(report, 'health_20260424_122627', '.claude/cache/health-checks/health_20260424_122627.md');
  assert.equal(run.runId, 'System Health|2026-04-24|health_20260424_122627');
  assert.equal(run.period, '2026-04-24');
  assert.equal(run.status, 'Warn');
  assert.equal(run.summary, 'PASS=8 WARN=1 FAIL=0 SKIP=0');
  assert.equal(run.artifactUrl, '.claude/cache/health-checks/health_20260424_122627.md');
  assert.equal(validateRun(run), run);
});
