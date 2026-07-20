// watchdog.test.mjs — pure tests for the silent-miss watchdog (mocked
// transport; no ntn spawn, no live registry writes).
// Run: node --test scripts/report-registry/test/watchdog.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isoWeekNumber, isoWeekLabel, formatPeriod, computeCandidate, hasRowForPeriod,
  buildMissRun, evaluateEntry, runWatchdog, SCHEDULE, maxAgeForType, MAX_AGE_HOURS_WEEKLY,
} from '../watchdog.mjs';
import { DEFAULT_MAX_AGE_HOURS } from '../check-drift.mjs';

const DS = 'c7d2d9e3-d388-4640-a66e-88f7dd50f854';

function vpEntry() { return SCHEDULE.find((e) => e.type === 'VP Weekly'); }
function sponsorEntry() { return SCHEDULE.find((e) => e.type === 'FourthOS Sponsor'); }
function healthEntry() { return SCHEDULE.find((e) => e.type === 'System Health'); }
function dashboardEntry() { return SCHEDULE.find((e) => e.type === 'Team Dashboard'); }
function portfolioEntry() { return SCHEDULE.find((e) => e.type === 'Project Portfolio'); }
function selfImpEntry() { return SCHEDULE.find((e) => e.type === 'Self-Improvement'); }

// --- isoWeekNumber / isoWeekLabel ------------------------------------------------

test('isoWeekNumber matches known ISO week boundaries', () => {
  // 2026-01-01 is a Thursday -> ISO week 1 of 2026.
  assert.equal(isoWeekNumber(new Date(2026, 0, 1)), 1);
  // 2026-07-16 is a Thursday.
  assert.equal(new Date(2026, 6, 16).getDay(), 4);
});

test('isoWeekLabel formats as <calendar-year>-W<2-digit-week> (matches the VP Weekly wrapper\'s Get-Date -UFormat %Y-W%V)', () => {
  const label = isoWeekLabel(new Date(2026, 6, 16));
  assert.match(label, /^2026-W\d{2}$/);
});

test('formatPeriod: isoWeek vs date', () => {
  const d = new Date(2026, 6, 16);
  assert.equal(formatPeriod(d, 'date'), '2026-07-16');
  assert.match(formatPeriod(d, 'isoWeek'), /^2026-W\d{2}$/);
});

// --- computeCandidate: weekly gating ---------------------------------------------

test('weekly type is NOT due on the wrong weekday', () => {
  // 2026-07-15 is a Wednesday; VP Weekly is Thursday-gated.
  const wed = new Date(2026, 6, 15, 13, 0, 0);
  const c = computeCandidate(vpEntry(), wed);
  assert.equal(c.due, false);
});

test('weekly type is NOT due on its weekday before grace elapses', () => {
  // Thursday 2026-07-16 at 08:00 -- grace ends 12:00.
  const thuMorning = new Date(2026, 6, 16, 8, 0, 0);
  const c = computeCandidate(vpEntry(), thuMorning);
  assert.equal(c.due, false);
});

test('weekly type IS due on its weekday after grace elapses, period = this week', () => {
  // Thursday 2026-07-16 at 13:00 -- grace ends 12:00, so it's due.
  const thuAfternoon = new Date(2026, 6, 16, 13, 0, 0);
  const c = computeCandidate(vpEntry(), thuAfternoon);
  assert.equal(c.due, true);
  assert.match(c.period, /^2026-W\d{2}$/);
});

test('FourthOS Sponsor (weekly, date-format period) due Thursday afternoon', () => {
  const thuAfternoon = new Date(2026, 6, 16, 13, 0, 0);
  const c = computeCandidate(sponsorEntry(), thuAfternoon);
  assert.equal(c.due, true);
  assert.equal(c.period, '2026-07-16');
});

test('System Health (weekly Friday) is due Friday afternoon, not Thursday', () => {
  const thu = new Date(2026, 6, 16, 20, 0, 0);
  assert.equal(computeCandidate(healthEntry(), thu).due, false);
  const fri = new Date(2026, 6, 17, 20, 0, 0); // grace ends 14:00
  const c = computeCandidate(healthEntry(), fri);
  assert.equal(c.due, true);
  assert.equal(c.period, '2026-07-17');
});

// --- computeCandidate: daily, including crossesMidnight --------------------------

test('daily type without crossesMidnight checks TODAY once its grace elapses', () => {
  const evening = new Date(2026, 6, 16, 20, 0, 0); // grace ends 12:00
  const c = computeCandidate(selfImpEntry(), evening);
  assert.equal(c.due, true);
  assert.equal(c.period, '2026-07-16');
});

test('daily type without crossesMidnight is not due before its grace elapses', () => {
  const morning = new Date(2026, 6, 16, 8, 0, 0); // grace ends 12:00
  assert.equal(computeCandidate(selfImpEntry(), morning).due, false);
});

test('Team Dashboard (crossesMidnight) checks YESTERDAY when run at 20:05 (grace ends next day 06:00)', () => {
  const now = new Date(2026, 6, 16, 20, 5, 0);
  const c = computeCandidate(dashboardEntry(), now);
  assert.equal(c.due, true);
  assert.equal(c.period, '2026-07-15'); // yesterday
});

test('Project Portfolio (crossesMidnight, grace=00:00) checks YESTERDAY any time after midnight', () => {
  const now = new Date(2026, 6, 16, 0, 30, 0); // just after midnight
  const c = computeCandidate(portfolioEntry(), now);
  assert.equal(c.due, true);
  assert.equal(c.period, '2026-07-15');
});

// --- hasRowForPeriod: filter shape -----------------------------------------------

test('hasRowForPeriod issues a compound Report Type + Period filter and reflects row presence', () => {
  const calls = [];
  const query = (dsId, opts) => { calls.push({ dsId, opts }); return [{ id: 'row1' }]; };
  const present = hasRowForPeriod('VP Weekly', '2026-W29', { dsId: DS, query });
  assert.equal(present, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts.filter.and[0], { property: 'Report Type', select: { equals: 'VP Weekly' } });
  assert.deepEqual(calls[0].opts.filter.and[1], { property: 'Period', rich_text: { equals: '2026-W29' } });
});

test('hasRowForPeriod returns false on an empty result set', () => {
  const present = hasRowForPeriod('VP Weekly', '2026-W29', { dsId: DS, query: () => [] });
  assert.equal(present, false);
});

// --- buildMissRun: deterministic runId (the idempotency mechanism) --------------

test('buildMissRun produces a deterministic runId with NO timestamp component', () => {
  const now = new Date(2026, 6, 16, 13, 0, 0);
  const run1 = buildMissRun(vpEntry(), '2026-W29', now);
  const laterNow = new Date(2026, 6, 16, 18, 0, 0);
  const run2 = buildMissRun(vpEntry(), '2026-W29', laterNow);
  assert.equal(run1.runId, 'VP Weekly|2026-W29|watchdog-miss');
  assert.equal(run1.runId, run2.runId); // same period -> same runId regardless of detection time
  assert.equal(run1.status, 'Failed');
  assert.equal(run1.source, 'AIWeeklyReport'); // the pipeline's OWN registered source, not "Watchdog"
  assert.match(run1.summary, /watchdog/i);
});

test('buildMissRun output validates against the real upsert enums (type/status/source)', async () => {
  const { validateRun } = await import('../upsert.mjs');
  const run = buildMissRun(vpEntry(), '2026-W29', new Date(2026, 6, 16, 13, 0, 0));
  assert.doesNotThrow(() => validateRun(run));
});

// --- evaluateEntry: not-due / ok / would-write / written / error ----------------

test('evaluateEntry: not due -> checked:false, no query/upsert calls', () => {
  const calls = { query: 0, upsert: 0 };
  const r = evaluateEntry(vpEntry(), new Date(2026, 6, 15, 13, 0, 0), {
    query: () => { calls.query += 1; return []; },
    upsert: () => { calls.upsert += 1; return { action: 'created', pageId: 'x' }; },
  });
  assert.equal(r.checked, false);
  assert.equal(calls.query, 0);
  assert.equal(calls.upsert, 0);
});

test('evaluateEntry: row present -> status ok, no upsert call', () => {
  const calls = { upsert: 0 };
  const r = evaluateEntry(vpEntry(), new Date(2026, 6, 16, 13, 0, 0), {
    query: () => [{ id: 'row1' }],
    upsert: () => { calls.upsert += 1; return { action: 'created', pageId: 'x' }; },
  });
  assert.equal(r.status, 'ok');
  assert.equal(calls.upsert, 0);
});

test('evaluateEntry: row missing + dryRun -> would-write, NO upsert call (proves dry-run writes nothing)', () => {
  const calls = { upsert: 0 };
  const r = evaluateEntry(vpEntry(), new Date(2026, 6, 16, 13, 0, 0), {
    query: () => [],
    upsert: () => { calls.upsert += 1; return { action: 'created', pageId: 'x' }; },
    dryRun: true,
  });
  assert.equal(r.status, 'would-write');
  assert.equal(calls.upsert, 0);
  assert.equal(r.run.runId, `VP Weekly|${r.period}|watchdog-miss`);
});

test('evaluateEntry: row missing + real run -> written, upsert called exactly once', () => {
  const calls = { upsert: 0 };
  const r = evaluateEntry(vpEntry(), new Date(2026, 6, 16, 13, 0, 0), {
    query: () => [],
    upsert: (run) => { calls.upsert += 1; return { action: 'created', pageId: 'page1' }; },
    dryRun: false,
  });
  assert.equal(r.status, 'written');
  assert.equal(calls.upsert, 1);
  assert.equal(r.result.pageId, 'page1');
});

test('evaluateEntry: a second call for the SAME missing period does not duplicate (upsert re-targets by runId)', () => {
  // Simulate the upsert layer's real idempotency: first call creates, second
  // call for the identical runId updates the SAME page (as upsertReportRun
  // itself already guarantees via its own Run-ID query). This test proves the
  // watchdog always emits the SAME runId for repeated calls at the same period,
  // which is the precondition for that guarantee to apply.
  const now1 = new Date(2026, 6, 16, 13, 0, 0);
  const now2 = new Date(2026, 6, 16, 19, 0, 0);
  const r1 = evaluateEntry(vpEntry(), now1, { query: () => [], upsert: (run) => ({ action: 'created', pageId: 'page1', runId: run.runId }) });
  const r2 = evaluateEntry(vpEntry(), now2, { query: () => [], upsert: (run) => ({ action: 'updated', pageId: 'page1', runId: run.runId }) });
  assert.equal(r1.run.runId, r2.run.runId);
});

test('evaluateEntry: query error is caught and reported, not thrown', () => {
  const r = evaluateEntry(vpEntry(), new Date(2026, 6, 16, 13, 0, 0), {
    query: () => { throw new Error('boom'); },
  });
  assert.equal(r.status, 'error');
  assert.match(r.error, /boom/);
});

// --- maxAgeForType: per-cadence staleness threshold + guard ----------------------

test('maxAgeForType: weekly -> MAX_AGE_HOURS_WEEKLY (192), daily -> DEFAULT (48)', () => {
  assert.equal(maxAgeForType('VP Weekly'), MAX_AGE_HOURS_WEEKLY);
  assert.equal(MAX_AGE_HOURS_WEEKLY, 192);
  assert.equal(maxAgeForType('System Health'), 192);
  assert.equal(maxAgeForType('Project Portfolio'), DEFAULT_MAX_AGE_HOURS);
  assert.equal(DEFAULT_MAX_AGE_HOURS, 48);
});

test('maxAgeForType: an unknown/unscheduled type falls back to DEFAULT, never undefined (?? guard)', () => {
  assert.equal(maxAgeForType('Not A Real Type'), DEFAULT_MAX_AGE_HOURS);
  // a schedule with no cadence field on the matched entry also degrades safely
  assert.equal(maxAgeForType('X', [{ type: 'X' }]), DEFAULT_MAX_AGE_HOURS);
  assert.notEqual(maxAgeForType('anything'), undefined);
});

// --- runWatchdog: sweep shape -----------------------------------------------------

test('runWatchdog returns one result per schedule entry', () => {
  const results = runWatchdog({
    now: new Date(2026, 6, 16, 13, 0, 0), dryRun: true, query: () => [],
  });
  assert.equal(results.length, SCHEDULE.length);
  const types = results.map((r) => r.type);
  for (const entry of SCHEDULE) assert.ok(types.includes(entry.type));
});
