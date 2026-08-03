// trust-metrics.test.mjs — pure tests for the registry-measuring-itself rollup
// (proposal 09) + the hub human-section freshness checker (proposal 05, item 3).
// No ntn spawn, no live registry reads.
// Run: node --test scripts/report-registry/test/trust-metrics.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractRunRow, mondayOfWeek, buildWeekBuckets, expectedPeriodsInWeek,
  computeWeeklyExpectedVsLanded, expectedDeadlineForPeriod, computeTimeToDetection,
  computeCorrectiveRate, computeTrustMetrics, renderTrustRollupBlocks,
  scanHumanSections, assessSectionFreshness, checkHumanSectionFreshness,
  computeConsecutiveNonOk, computeStandingFailures,
  DEFAULT_LOOKBACK_WEEKS, HUMAN_SECTION_MAX_AGE_DAYS,
} from '../trust-metrics.mjs';
import { SCHEDULE } from '../watchdog.mjs';

// Pinned literally rather than looked up from SCHEDULE: VP Weekly was RETIRED
// 2026-07-25 and has no schedule entry, but it remains the only isoWeek weekly
// shape and these tests exist to cover the weekly-cadence expectation math.
function vpEntry() {
  return {
    type: 'VP Weekly', source: 'AIWeeklyReport', cadence: 'weekly', weekday: 4,
    grace: { h: 12, m: 0 }, periodFormat: 'isoWeek', crossesMidnight: false,
  };
}
function portfolioEntry() { return SCHEDULE.find((e) => e.type === 'Project Portfolio'); }
function selfImpEntry() { return SCHEDULE.find((e) => e.type === 'Self-Improvement'); }

function rawRow({ type, period, runDate, summary, status = 'OK' } = {}) {
  const p = {};
  if (type !== undefined) p['Report Type'] = { select: { name: type } };
  if (period !== undefined) p.Period = { rich_text: [{ plain_text: period }] };
  if (runDate !== undefined) p['Run Date'] = { date: { start: runDate } };
  if (summary !== undefined) p.Summary = { rich_text: [{ plain_text: summary }] };
  if (status !== undefined) p.Status = { select: { name: status } };
  return { properties: p };
}

// --- extractRunRow ------------------------------------------------------------

test('extractRunRow normalizes a raw row; null on an absent/empty row', () => {
  const r = extractRunRow(rawRow({
    type: 'Project Portfolio', period: '2026-07-16', runDate: '2026-07-16T13:00:00Z', summary: 'ok', status: 'OK',
  }));
  assert.deepEqual(r, {
    type: 'Project Portfolio', period: '2026-07-16', runDate: '2026-07-16T13:00:00Z', summary: 'ok', status: 'OK',
  });
  assert.equal(extractRunRow(null), null);
  assert.equal(extractRunRow({}), null);
});

// --- week buckets ---------------------------------------------------------------

test('mondayOfWeek anchors to the Monday of the given date\'s week', () => {
  // 2026-07-16 is a Thursday.
  const mon = mondayOfWeek(new Date(2026, 6, 16, 13, 0, 0));
  assert.equal(mon.getDay(), 1);
  assert.equal(mon.getDate(), 13); // 2026-07-13 is the Monday of that week
});

test('buildWeekBuckets returns N contiguous Mon-Sun buckets ending with the current week', () => {
  const now = new Date(2026, 6, 16, 13, 0, 0); // Thursday
  const buckets = buildWeekBuckets(now, 3);
  assert.equal(buckets.length, 3);
  // contiguous: each bucket's end equals the next bucket's start
  assert.equal(buckets[0].end.getTime(), buckets[1].start.getTime());
  assert.equal(buckets[1].end.getTime(), buckets[2].start.getTime());
  // last bucket covers "now"
  assert.ok(buckets[2].start <= now && now < buckets[2].end);
  for (const b of buckets) assert.match(b.label, /^\d{4}-W\d{2}$/);
});

// --- expectedPeriodsInWeek -------------------------------------------------------

test('expectedPeriodsInWeek: a daily entry expects one period per elapsed-deadline day', () => {
  const now = new Date(2026, 6, 16, 13, 0, 0); // Thursday 13:00
  const buckets = buildWeekBuckets(now, 1);
  const periods = expectedPeriodsInWeek(selfImpEntry(), buckets[0], now);
  // grace 12:00 daily; Mon..Thu all have elapsed grace by Thursday 13:00; Fri/Sat/Sun have not.
  assert.deepEqual(periods, ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16']);
});

test('expectedPeriodsInWeek: a weekly entry expects at most one period, only once its weekday+grace has elapsed', () => {
  const now = new Date(2026, 6, 16, 13, 0, 0); // Thursday 13:00, VP Weekly grace 12:00
  const buckets = buildWeekBuckets(now, 1);
  const periods = expectedPeriodsInWeek(vpEntry(), buckets[0], now);
  assert.equal(periods.length, 1);
  assert.match(periods[0], /^2026-W\d{2}$/);
});

test('expectedPeriodsInWeek: a weekly entry expects ZERO periods before its weekday+grace elapses', () => {
  const now = new Date(2026, 6, 16, 8, 0, 0); // Thursday 08:00, before 12:00 grace
  const buckets = buildWeekBuckets(now, 1);
  assert.deepEqual(expectedPeriodsInWeek(vpEntry(), buckets[0], now), []);
});

test('expectedPeriodsInWeek: crossesMidnight entry (grace 00:00) expects yesterday through the day before today', () => {
  const now = new Date(2026, 6, 16, 0, 30, 0); // just after midnight Thursday
  const buckets = buildWeekBuckets(now, 1);
  const periods = expectedPeriodsInWeek(portfolioEntry(), buckets[0], now);
  // Mon(13) grace-elapsed candidate=Sun(12, prev week - excluded by bucket start)..
  // within THIS week's Mon-Thu: candidates are Sun(prev, excluded), Mon->candidate Sun excluded,
  // simplest: Project Portfolio grace=00:00 crossesMidnight -> day D's deadline is D 00:00,
  // candidate = D-1. Elapsed days within [Mon 13..Thu 16] with deadline<=now(Thu 00:30):
  // Mon(13,00:00<=now) candidate Sun(12); Tue(14) candidate Mon(13); Wed(15) candidate Tue(14);
  // Thu(16,00:00<=00:30) candidate Wed(15). Fri/Sat/Sun(future) excluded.
  assert.deepEqual(periods, ['2026-07-12', '2026-07-13', '2026-07-14', '2026-07-15']);
});

// --- computeWeeklyExpectedVsLanded ------------------------------------------------

test('computeWeeklyExpectedVsLanded: landed excludes watchdog miss-rows and corrective rows', () => {
  const now = new Date(2026, 6, 16, 13, 0, 0); // Thursday 13:00
  const rows = [
    extractRunRow(rawRow({ type: 'Self-Improvement', period: '2026-07-13', runDate: '2026-07-13T13:00:00Z', summary: 'ok' })),
    extractRunRow(rawRow({ type: 'Self-Improvement', period: '2026-07-14', runDate: '2026-07-15T09:00:00Z', summary: 'watchdog: no row found' })),
    extractRunRow(rawRow({ type: 'Self-Improvement', period: '2026-07-15', runDate: '2026-07-16T09:00:00Z', summary: 'backfill: seeded' })),
  ];
  const weekly = computeWeeklyExpectedVsLanded({ rows, now, weeks: 1, schedule: SCHEDULE });
  assert.equal(weekly.length, 1);
  // Self-Improvement expects 4 periods this week (Mon..Thu); only 2026-07-13 landed genuinely.
  const selfImpLanded = rows.filter((r) => r.type === 'Self-Improvement').length;
  assert.equal(selfImpLanded, 3); // sanity: 3 rows exist
  assert.ok(weekly[0].landed < weekly[0].expected, 'gap exists because 2 of 3 rows are miss/corrective');
});

// --- expectedDeadlineForPeriod / computeTimeToDetection ---------------------------

test('expectedDeadlineForPeriod: date-format, non-crossesMidnight -> deadline on the period\'s own day', () => {
  const d = expectedDeadlineForPeriod(selfImpEntry(), '2026-07-16');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 6);
  assert.equal(d.getDate(), 16);
  assert.equal(d.getHours(), 12); // Self-Improvement grace {h:12,m:0}
});

test('expectedDeadlineForPeriod: crossesMidnight -> deadline lands the day AFTER the period', () => {
  const d = expectedDeadlineForPeriod(portfolioEntry(), '2026-07-15');
  assert.equal(d.getDate(), 16); // day after the period
  assert.equal(d.getHours(), 0); // Project Portfolio grace {h:0,m:0}
});

test('expectedDeadlineForPeriod: isoWeek periodFormat is honestly "not computable" -> null', () => {
  assert.equal(expectedDeadlineForPeriod(vpEntry(), '2026-W29'), null);
});

test('expectedDeadlineForPeriod: unparseable period -> null', () => {
  assert.equal(expectedDeadlineForPeriod(selfImpEntry(), 'not-a-date'), null);
});

test('computeTimeToDetection: mean hours between deadline and the miss-row\'s Run Date', () => {
  // Self-Improvement grace 12:00; period 2026-07-16 -> deadline 2026-07-16T12:00 local.
  const missRows = [
    { type: 'Self-Improvement', period: '2026-07-16', runDate: new Date(2026, 6, 16, 18, 0, 0).toISOString() }, // +6h
    { type: 'Self-Improvement', period: '2026-07-15', runDate: new Date(2026, 6, 15, 16, 0, 0).toISOString() }, // +4h
  ];
  const ttd = computeTimeToDetection(missRows);
  assert.equal(ttd.sampleCount, 2);
  assert.equal(ttd.meanHours, 5);
});

test('computeTimeToDetection: isoWeek samples are excluded, not zeroed', () => {
  const missRows = [{ type: 'VP Weekly', period: '2026-W29', runDate: '2026-07-20T12:00:00Z' }];
  const ttd = computeTimeToDetection(missRows);
  assert.equal(ttd.sampleCount, 0);
  assert.equal(ttd.meanHours, null);
});

test('computeTimeToDetection: unknown type or malformed runDate is skipped, not thrown', () => {
  const missRows = [
    { type: 'Nonexistent Type', period: '2026-07-16', runDate: '2026-07-16T18:00:00Z' },
    { type: 'Self-Improvement', period: '2026-07-16', runDate: 'not-a-date' },
  ];
  assert.doesNotThrow(() => computeTimeToDetection(missRows));
  assert.equal(computeTimeToDetection(missRows).sampleCount, 0);
});

// --- computeCorrectiveRate --------------------------------------------------------

test('computeCorrectiveRate: fraction of rows carrying the backfill:/remap: prefix', () => {
  const rows = [
    { summary: 'cards refreshed=8' },
    { summary: 'backfill: seeded from archive' },
    { summary: 'remap: corrected period' },
    { summary: 'ok' },
  ];
  const r = computeCorrectiveRate(rows);
  assert.equal(r.correctiveCount, 2);
  assert.equal(r.totalCount, 4);
  assert.equal(r.rate, 0.5);
});

test('computeCorrectiveRate: empty input -> rate 0, no division by zero', () => {
  const r = computeCorrectiveRate([]);
  assert.deepEqual(r, { rate: 0, correctiveCount: 0, totalCount: 0 });
});

// --- computeConsecutiveNonOk / computeStandingFailures (U2, T9.2) -----------------
// Audit finding this closes: two genuine Self-Improvement mid-flight-death rows
// (2026-07-26, 2026-07-27) stood stranded for days scored as landed successes,
// because nothing anywhere branched on Status. These are the status-aware metric.

test('computeConsecutiveNonOk: counts consecutive non-OK rows from the most recent backward, stopping at the first genuine OK', () => {
  const rows = [
    { type: 'Self-Improvement', runDate: '2026-07-25T12:00:00Z', status: 'OK' },
    { type: 'Self-Improvement', runDate: '2026-07-26T12:00:00Z', status: 'Failed' },
    { type: 'Self-Improvement', runDate: '2026-07-27T12:00:00Z', status: 'Failed' },
  ];
  assert.equal(computeConsecutiveNonOk(rows, 'Self-Improvement'), 2);
});

test('computeConsecutiveNonOk: zero when the most recent row is OK, even if older non-OK rows exist', () => {
  const rows = [
    { type: 'Self-Improvement', runDate: '2026-07-26T12:00:00Z', status: 'Failed' },
    { type: 'Self-Improvement', runDate: '2026-07-27T12:00:00Z', status: 'OK' },
  ];
  assert.equal(computeConsecutiveNonOk(rows, 'Self-Improvement'), 0);
});

test('computeConsecutiveNonOk: zero for a type with no rows', () => {
  assert.equal(computeConsecutiveNonOk([], 'Self-Improvement'), 0);
});

test('computeStandingFailures: one entry per schedule type; counts stranded non-OK rows for the audit\'s exact scenario (two consecutive mid-flight-death rows previously scored as landed successes)', () => {
  const rawRows = [
    rawRow({
      type: 'Self-Improvement', period: '2026-07-26', runDate: '2026-07-26T12:00:00Z', summary: 'died mid-flight', status: 'Failed',
    }),
    rawRow({
      type: 'Self-Improvement', period: '2026-07-27', runDate: '2026-07-27T12:00:00Z', summary: 'died mid-flight', status: 'Failed',
    }),
  ];
  const rows = rawRows.map(extractRunRow);
  const standing = computeStandingFailures(rows, { schedule: SCHEDULE });
  assert.equal(standing.length, SCHEDULE.length); // every schedule type gets an entry, even zero-count ones
  assert.equal(standing.find((s) => s.type === 'Self-Improvement').consecutiveNonOk, 2);
  for (const s of standing) {
    if (s.type !== 'Self-Improvement') assert.equal(s.consecutiveNonOk, 0);
  }
});

test('computeTrustMetrics exposes standingFailures in its return shape', () => {
  const now = new Date(2026, 6, 16, 13, 0, 0);
  const rawRows = [
    rawRow({
      type: 'Self-Improvement', period: '2026-07-16', runDate: '2026-07-16T13:00:00Z', summary: 'died', status: 'Failed',
    }),
  ];
  const summary = computeTrustMetrics({ rawRows, now });
  assert.ok(Array.isArray(summary.standingFailures));
  assert.equal(summary.standingFailures.find((s) => s.type === 'Self-Improvement').consecutiveNonOk, 1);
});

// --- computeTrustMetrics (integration of the pure pieces) -------------------------

test('computeTrustMetrics: full rollup shape with defaults', () => {
  const now = new Date(2026, 6, 16, 13, 0, 0);
  const rawRows = [
    rawRow({ type: 'Self-Improvement', period: '2026-07-13', runDate: '2026-07-13T13:00:00Z', summary: 'ok' }),
    rawRow({
      type: 'Self-Improvement', period: '2026-07-14', runDate: '2026-07-14T18:00:00Z', summary: 'watchdog: no "Self-Improvement" row found for period 2026-07-14 by its deadline+grace',
    }),
  ];
  const summary = computeTrustMetrics({ rawRows, now });
  assert.equal(summary.lookbackWeeks, DEFAULT_LOOKBACK_WEEKS);
  assert.equal(summary.weeks.length, DEFAULT_LOOKBACK_WEEKS);
  assert.equal(summary.silentMissCount, 1);
  assert.equal(summary.ttdSampleCount, 1);
  assert.ok(summary.meanTimeToDetectionHours > 0);
  assert.equal(summary.totalRowsInWindow, 2);
  assert.equal(summary.correctiveRowCount, 0);
});

test('computeTrustMetrics: rows outside the lookback window are excluded', () => {
  const now = new Date(2026, 6, 16, 13, 0, 0);
  const rawRows = [
    rawRow({ type: 'Self-Improvement', period: '2025-01-01', runDate: '2025-01-01T13:00:00Z', summary: 'ancient' }),
  ];
  const summary = computeTrustMetrics({ rawRows, now, weeks: 1 });
  assert.equal(summary.totalRowsInWindow, 0);
});

// --- renderTrustRollupBlocks -------------------------------------------------------

test('renderTrustRollupBlocks: null summary -> no blocks', () => {
  assert.deepEqual(renderTrustRollupBlocks(null), []);
});

test('renderTrustRollupBlocks: renders header + weekly line + stats line with the numbers surfaced', () => {
  const summary = {
    lookbackWeeks: 2,
    weeks: [{ week: '2026-W28', expected: 4, landed: 4, gap: 0 }, { week: '2026-W29', expected: 4, landed: 3, gap: 1 }],
    silentMissCount: 1,
    meanTimeToDetectionHours: 5.5,
    ttdSampleCount: 1,
    correctiveRowRate: 0.1,
    correctiveRowCount: 1,
    totalRowsInWindow: 10,
  };
  const blocks = renderTrustRollupBlocks(summary);
  assert.equal(blocks.length, 3);
  const flat = (b) => b.paragraph.rich_text.map((s) => s.text.content).join('');
  assert.match(flat(blocks[0]), /Trust metrics \(last 2 weeks\)/);
  assert.match(flat(blocks[1]), /2026-W28: expected 4 \/ landed 4/);
  assert.match(flat(blocks[1]), /2026-W29: expected 4 \/ landed 3 \(gap 1\)/);
  assert.match(flat(blocks[2]), /Silent misses: 1 \(target: 0\)/);
  assert.match(flat(blocks[2]), /5\.5h \(n=1\)/);
  assert.match(flat(blocks[2]), /10% \(1\/10\)/);
});

// --- human-section freshness checker -----------------------------------------------

function heading2(text) { return { type: 'heading_2', heading_2: { rich_text: [{ plain_text: text }] } }; }
function para(text) { return { type: 'paragraph', paragraph: { rich_text: [{ plain_text: text }] } }; }

test('scanHumanSections: excludes machine-owned headings; groups body blocks under their heading', () => {
  const blocks = [
    heading2('🗂 Report pages'), para('machine content'),
    heading2('📥 Latest reports'), para('human narrative'), para('more'),
  ];
  const sections = scanHumanSections(blocks, { machineHeadings: ['🗂 Report pages'] });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, '📥 Latest reports');
  assert.equal(sections[0].blocks.length, 2);
});

test('assessSectionFreshness: unstamped section -> unstamped:true, no false staleness claim', () => {
  const section = { heading: 'X', blocks: [para('no stamp here')] };
  const r = assessSectionFreshness(section, { now: new Date(2026, 6, 16) });
  assert.equal(r.unstamped, true);
  assert.equal(r.stale, null);
  assert.equal(r.reviewedDate, null);
});

test('assessSectionFreshness: stamped section within maxAgeDays -> stale:false', () => {
  const section = { heading: 'X', blocks: [para('Reviewed: 2026-07-01 — looks good')] };
  const r = assessSectionFreshness(section, { now: new Date(2026, 6, 16), maxAgeDays: HUMAN_SECTION_MAX_AGE_DAYS });
  assert.equal(r.unstamped, false);
  assert.equal(r.reviewedDate, '2026-07-01');
  assert.equal(r.stale, false);
  assert.equal(r.ageDays, 15);
});

test('assessSectionFreshness: stamped section older than maxAgeDays -> stale:true', () => {
  const section = { heading: 'X', blocks: [para('Reviewed: 2026-05-01')] };
  const r = assessSectionFreshness(section, { now: new Date(2026, 6, 16), maxAgeDays: 30 });
  assert.equal(r.stale, true);
});

test('checkHumanSectionFreshness: one entry per human section, machine sections skipped entirely', () => {
  const blocks = [
    heading2('🗂 Report pages'), para('machine'),
    heading2('📥 Latest reports'), para('Reviewed: 2026-07-01'),
    heading2('🎯 Decisions'), para('no stamp'),
  ];
  const results = checkHumanSectionFreshness(blocks, { machineHeadings: ['🗂 Report pages'], now: new Date(2026, 6, 16) });
  assert.equal(results.length, 2);
  assert.equal(results.find((r) => r.heading === '📥 Latest reports').unstamped, false);
  assert.equal(results.find((r) => r.heading === '🎯 Decisions').unstamped, true);
});
