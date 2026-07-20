// detector-coverage-matrix.test.mjs — CHARACTERIZATION matrix pinning the exact,
// class-by-class behavior of the TWO Report-Runs failure detectors so a future
// consolidation to a single superset detector is safe. These tests document what
// the detectors DO today (mocked transport, no ntn spawn, no live writes); they do
// not assert what they SHOULD do. If a consolidation changes a verdict, the change
// must be intentional and this matrix updated in the same edit.
//
//   detectors:
//     watchdog  (watchdog.mjs)    — period-precise, schedule-aware; WRITES a miss-row
//                                   on absence; ADDITIVELY reports freshness on present.
//     drift     (check-drift.mjs) — per-type, period-blind, Status-blind; READ-ONLY;
//                                   exits nonzero on any type in drift.
//
//   class            | watchdog write-path        | watchdog freshness      | drift
//   -----------------|----------------------------|-------------------------|------------
//   no row           | MISS (would-write/written) | (n/a — no rows)         | DRIFT
//   stale row        | ok (row present, no write) | stale=true              | DRIFT
//   Failed-only      | ok (Status ignored)        | fresh (by age)          | not drift *
//   Warn-only        | ok (Status ignored)        | fresh (by age)          | not drift *
//   malformed date   | ok (row present, no write) | stale=true (no-date)    | DRIFT
//   late period      | MISS (expected absent)     | (n/a — no rows)         | not drift **
//
//   *  drift is Status-blind: a fresh Failed/Warn row is NOT drift (only age matters).
//   ** drift is period-blind: a LATE row that landed with a fresh Run Date hides the
//      lateness; only the period-precise watchdog catches "expected period absent".
//
// Key insight the matrix makes explicit: the two detectors are COMPLEMENTARY, not
// redundant. Pre-extension, stale + malformed were watchdog blind spots; the
// additive freshness verdict now carries them (REPORT-ONLY — the write path stays
// absence-only), making the watchdog a superset in DETECTION while its write/exit
// contract is unchanged.
// Run: node --test scripts/report-registry/test/detector-coverage-matrix.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateEntry, assessFreshness, runWatchdog, SCHEDULE, maxAgeForType,
} from '../watchdog.mjs';
import { computeDrift, DEFAULT_MAX_AGE_HOURS } from '../check-drift.mjs';

const TYPE = 'VP Weekly';
const vpEntry = () => SCHEDULE.find((e) => e.type === TYPE);

// A VP-Weekly-due instant: local Thursday 2026-07-16 13:00 (grace ends 12:00). The
// LOCAL-constructor Date makes the weekday/grace gating host-TZ-independent, exactly
// like the sibling watchdog tests.
const NOW = new Date(2026, 6, 16, 13, 0, 0);
// Run Dates are built RELATIVE to NOW so age math is exact and host-TZ-independent
// (toISOString() emits a 'Z' instant; getTime() is absolute ms — no local-zone drift).
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const FRESH = hoursAgo(4);    //   4h old -> within the 48h default
const STALE = hoursAgo(120);  // 120h old -> older than the 48h default

// A registry row as the DS returns it (shape mirrors check-drift's own fixtures).
function row({ status, runDate } = {}) {
  const properties = { 'Report Type': { select: { name: TYPE } } };
  if (runDate !== undefined) properties['Run Date'] = { date: { start: runDate } };
  if (status !== undefined) properties.Status = { select: { name: status } };
  return { properties };
}

// watchdog verdict for a class: evaluateEntry at NOW (dry-run so a MISS never writes)
// against a mock transport that returns `rows` for the period-filtered query.
// The freshness CLASSES below are characterized at the DAILY 48h threshold (passed
// explicitly), independent of the per-cadence default; the per-cadence behavior
// (weekly widens to 192h) is characterized separately in its own section at the end.
function watchdog(rows) {
  return evaluateEntry(vpEntry(), NOW, { query: () => rows, dryRun: true, maxAgeHours: 48 });
}
// drift verdict for a class: computeDrift over the type's newest Run Date at NOW.
function drift(newestRunDate) {
  return computeDrift({ [TYPE]: newestRunDate }, { now: NOW.getTime(), types: [TYPE] })[0];
}

// --- CLASS: no row --------------------------------------------------------------
// The expected period has ZERO rows (a run that never launched / was killed).

test('CLASS no-row — watchdog: MISS via the absence write-path (would-write)', () => {
  const r = watchdog([]);
  assert.equal(r.status, 'would-write');
  assert.ok(r.run.runId.endsWith('watchdog-miss'));
});

test('CLASS no-row — drift: DRIFT (no rows -> ageHours null)', () => {
  const d = drift('');
  assert.equal(d.drift, true);
  assert.equal(d.ageHours, null);
});

// --- CLASS: stale row -----------------------------------------------------------
// A row exists for the expected period, but its newest Run Date is old (120h).

test('CLASS stale-row — watchdog: write-path says ok (present, NOT written); freshness flags stale', () => {
  const r = watchdog([row({ status: 'OK', runDate: STALE })]);
  assert.equal(r.status, 'ok');           // present -> not a silent miss, no write
  assert.equal(r.freshness.stale, true);  // additive superset signal catches it
  assert.equal(r.freshness.reason, 'stale');
  assert.ok(r.freshness.ageHours > 48);
});

test('CLASS stale-row — drift: DRIFT (newest row older than the threshold)', () => {
  const d = drift(STALE);
  assert.equal(d.drift, true);
  assert.ok(d.ageHours > 48);
});

// --- CLASS: Failed-only rows ----------------------------------------------------
// Row(s) present for the period with Status=Failed and a FRESH Run Date. A Failed
// row proves the run LAUNCHED — a different, already-visible failure mode.

test('CLASS failed-only — watchdog: ok (Status ignored — launch proven); freshness fresh', () => {
  const r = watchdog([row({ status: 'Failed', runDate: FRESH })]);
  assert.equal(r.status, 'ok');
  assert.equal(r.freshness.stale, false);
  assert.equal(r.freshness.reason, 'fresh');
});

test('CLASS failed-only — drift: NOT drift (Status-blind; a fresh Failed row reads as healthy)', () => {
  assert.equal(drift(FRESH).drift, false);
});

// --- CLASS: Warn-only rows ------------------------------------------------------
// Same as Failed-only but Status=Warn — proving both detectors ignore the Status
// column entirely (identical verdict to the Failed-only class).

test('CLASS warn-only — watchdog: ok (Status ignored); freshness fresh — identical to failed-only', () => {
  const r = watchdog([row({ status: 'Warn', runDate: FRESH })]);
  assert.equal(r.status, 'ok');
  assert.equal(r.freshness.stale, false);
});

test('CLASS warn-only — drift: NOT drift (Status-blind)', () => {
  assert.equal(drift(FRESH).drift, false);
});

// --- CLASS: malformed date ------------------------------------------------------
// A row exists for the period but its Run Date is unparseable (age unknowable).

test('CLASS malformed-date — watchdog: write-path says ok (present); freshness flags no-parseable-run-date', () => {
  const r = watchdog([row({ status: 'OK', runDate: 'not-a-date' })]);
  assert.equal(r.status, 'ok');
  assert.equal(r.freshness.stale, true);
  assert.equal(r.freshness.reason, 'no-parseable-run-date');
  assert.equal(r.freshness.ageHours, null);
});

test('CLASS malformed-date — drift: DRIFT (unparseable newest -> ageHours null)', () => {
  const d = drift('not-a-date');
  assert.equal(d.drift, true);
  assert.equal(d.ageHours, null);
});

// --- CLASS: late period ---------------------------------------------------------
// The type has a row, but for a PRIOR period that landed late with a FRESH Run Date;
// the EXPECTED current period has no row. This is the watchdog's unique coverage.

test('CLASS late-period — watchdog: MISS for the expected period (period-precise)', () => {
  // The period-filtered query for the EXPECTED (current) period returns nothing —
  // the late row is filed under a PRIOR Period, so it never matches this filter.
  // (From the watchdog's period-scoped view this is indistinguishable from no-row,
  // and that is correct: the current period genuinely never landed.)
  const r = watchdog([]);
  assert.equal(r.status, 'would-write');
});

test('CLASS late-period — drift: NOT drift (period-blind; a fresh prior-period row hides the lateness)', () => {
  // check-drift only sees the newest Run Date across the type — the late row's fresh
  // date reads as healthy even though the CURRENT period never landed.
  assert.equal(drift(FRESH).drift, false);
});

// --- cross-cutting characterization ---------------------------------------------

test('CHARACTERIZATION: both detectors are Status-blind — Failed/Warn/OK/Skipped give identical verdicts for the same Run Date', () => {
  for (const status of ['Failed', 'Warn', 'OK', 'Skipped']) {
    const w = watchdog([row({ status, runDate: STALE })]);
    assert.equal(w.status, 'ok');          // watchdog: present regardless of Status
    assert.equal(w.freshness.stale, true); // freshness driven by age, not Status
  }
  // drift likewise depends only on the date, never the Status column.
  assert.equal(drift(STALE).drift, true);
  assert.equal(drift(FRESH).drift, false);
});

test('CHARACTERIZATION: the superset extension is REPORT-ONLY — a present-but-stale row NEVER triggers a write (write path stays absence-only)', () => {
  let upserts = 0;
  const r = evaluateEntry(vpEntry(), NOW, {
    query: () => [row({ status: 'OK', runDate: STALE })],
    upsert: () => { upserts += 1; return { action: 'created', pageId: 'x' }; },
    dryRun: false, // REAL run — not dry
    maxAgeHours: 48, // characterize the stale class at the daily threshold
  });
  assert.equal(r.status, 'ok');        // still ok (present)
  assert.equal(r.freshness.stale, true);
  assert.equal(upserts, 0);            // no miss-row written for a stale present row
});

// --- assessFreshness unit (the shared superset primitive) ------------------------

test('assessFreshness classifies fresh / stale / no-parseable-run-date directly', () => {
  const fresh = assessFreshness([row({ runDate: FRESH })], { now: NOW });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.reason, 'fresh');

  const stale = assessFreshness([row({ runDate: STALE })], { now: NOW });
  assert.equal(stale.stale, true);
  assert.equal(stale.reason, 'stale');

  const malformed = assessFreshness([row({ runDate: 'not-a-date' })], { now: NOW });
  assert.equal(malformed.stale, true);
  assert.equal(malformed.reason, 'no-parseable-run-date');
  assert.equal(malformed.ageHours, null);

  const noRows = assessFreshness([], { now: NOW });
  assert.equal(noRows.stale, true);    // empty -> no newest date -> unknowable
  assert.equal(noRows.reason, 'no-parseable-run-date');
});

test('assessFreshness honors a custom maxAgeHours threshold', () => {
  const rows = [row({ runDate: STALE })]; // 120h old
  assert.equal(assessFreshness(rows, { now: NOW, maxAgeHours: 48 }).stale, true);
  assert.equal(assessFreshness(rows, { now: NOW, maxAgeHours: 168 }).stale, false);
});

test('assessFreshness uses the NEWEST Run Date among the period rows (mirrors check-drift newestRunDate)', () => {
  const rows = [row({ runDate: STALE }), row({ runDate: FRESH }), row({ runDate: 'not-a-date' })];
  const f = assessFreshness(rows, { now: NOW });
  assert.equal(f.stale, false); // the fresh row wins
  assert.equal(f.reason, 'fresh');
});

// --- sweep-level shape (additive) ------------------------------------------------

test('runWatchdog attaches a freshness verdict to every present (ok) entry in the sweep', () => {
  const results = runWatchdog({ now: NOW, dryRun: true, query: () => [row({ runDate: FRESH })] });
  const present = results.filter((r) => r.status === 'ok');
  assert.ok(present.length > 0);
  for (const r of present) {
    assert.ok(r.freshness, `expected freshness on ok result for ${r.type}`);
    assert.equal(r.freshness.stale, false);
  }
});

// --- per-cadence staleness threshold (maxAgeForType) -----------------------------
// The freshness classes above are pinned at the DAILY 48h threshold. The default
// (no explicit maxAgeHours) is PER-CADENCE: weekly widens to 192h so a healthy weekly
// report ~5-6 days between runs is NOT reported stale, while a daily stays at 48h.

test('maxAgeForType: weekly types = 192h, daily types = 48h (DEFAULT), unknown = DEFAULT (guard)', () => {
  assert.equal(maxAgeForType('VP Weekly'), 192);
  assert.equal(maxAgeForType('FourthOS Sponsor'), 192);
  assert.equal(maxAgeForType('System Health'), 192);
  assert.equal(maxAgeForType('Team Dashboard'), DEFAULT_MAX_AGE_HOURS);
  assert.equal(maxAgeForType('Self-Improvement'), DEFAULT_MAX_AGE_HOURS);
  assert.equal(maxAgeForType('Not A Real Type'), DEFAULT_MAX_AGE_HOURS); // ?? DEFAULT, never undefined
});

test('per-cadence default: a 120h-old WEEKLY row is FRESH in the sweep (not stale under 192h)', () => {
  // Same 120h STALE row that reads stale at the daily 48h threshold reads FRESH for a
  // weekly type once the per-cadence default (192h) applies — the false-"stale" fix.
  const r = evaluateEntry(vpEntry(), NOW, { query: () => [row({ status: 'OK', runDate: STALE })], dryRun: true });
  assert.equal(r.status, 'ok');
  assert.equal(r.freshness.stale, false);
  assert.equal(r.freshness.reason, 'fresh');
});

test('per-cadence default: a 120h-old DAILY row is STALE (daily threshold unchanged at 48h)', () => {
  const daily = SCHEDULE.find((e) => e.type === 'Self-Improvement'); // daily, grace 12:00
  // A daily-due instant: 2026-07-16 20:00 local (grace 12:00 elapsed).
  const dailyNow = new Date(2026, 6, 16, 20, 0, 0);
  const staleForDaily = new Date(dailyNow.getTime() - 120 * 3_600_000).toISOString();
  const r = evaluateEntry(daily, dailyNow, { query: () => [row({ status: 'OK', runDate: staleForDaily })], dryRun: true });
  assert.equal(r.status, 'ok');
  assert.equal(r.freshness.stale, true);
  assert.equal(r.freshness.reason, 'stale');
});
