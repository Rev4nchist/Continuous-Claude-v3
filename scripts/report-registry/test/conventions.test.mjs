// conventions.test.mjs — pure tests for the "Registry conventions" enforcement
// (proposal 08, 2026-07-17): corrective-row prefix, durable artifact URLs, one
// period format per cadence, and watchdog schedule parity. No ntn spawn.
// Run: node --test scripts/report-registry/test/conventions.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRun } from '../make-run.mjs';
import {
  PERIOD_FORMAT_BY_TYPE, REPORT_TYPES,
} from '../config.mjs';
import {
  SCHEDULE, scheduleMissingTypes, scheduleFormatMismatches, runWatchdog,
} from '../watchdog.mjs';

const base = {
  type: 'Project Portfolio',
  period: '2026-07-17',
  status: 'OK',
  source: 'Project-Cards',
};

// --- convention 1: corrective-row prefix (backfill:/remap:) ---------------------

test('buildRun: corrective:true REQUIRES a backfill:/remap: summary prefix', () => {
  assert.throws(
    () => buildRun({ ...base, corrective: true, summary: 'fixed the old row' }),
    /corrective:true requires a summary starting with "backfill:" or "remap:"/,
  );
});

test('buildRun: corrective:true accepts a "backfill:" prefixed summary', () => {
  const run = buildRun({ ...base, corrective: true, summary: 'backfill: seeded from archive' });
  assert.equal(run.summary, 'backfill: seeded from archive');
});

test('buildRun: corrective:true accepts a "remap:" prefixed summary (case-insensitive)', () => {
  const run = buildRun({ ...base, corrective: true, summary: 'REMAP: corrected period' });
  assert.equal(run.summary, 'REMAP: corrected period');
});

test('buildRun: a "backfill:"/"remap:" summary WITHOUT corrective:true is rejected (accidental-prefix guard)', () => {
  assert.throws(
    () => buildRun({ ...base, summary: 'backfill: seeded from archive' }),
    /corrective:true was not passed/,
  );
  assert.throws(
    () => buildRun({ ...base, summary: 'remap: corrected period' }),
    /corrective:true was not passed/,
  );
});

test('buildRun: a normal (non-corrective) summary needs no flag', () => {
  const run = buildRun({ ...base, summary: 'cards refreshed=8' });
  assert.equal(run.summary, 'cards refreshed=8');
});

// --- convention 2: durable artifact URLs (http(s) only) --------------------------

test('buildRun: rejects a non-http(s) artifactUrl (local path)', () => {
  assert.throws(
    () => buildRun({ ...base, artifactUrl: 'C:\\temp\\report-run.json' }),
    /"artifactUrl" must be an http\(s\) URL/,
  );
});

test('buildRun: rejects a file: URL for docxUrl', () => {
  assert.throws(
    () => buildRun({ ...base, docxUrl: 'file:///C:/temp/report.docx' }),
    /"docxUrl" must be an http\(s\) URL/,
  );
});

test('buildRun: accepts http(s) artifactUrl/docxUrl', () => {
  const run = buildRun({
    ...base, artifactUrl: 'https://www.notion.so/abc123', docxUrl: 'http://example.com/x.docx',
  });
  assert.equal(run.artifactUrl, 'https://www.notion.so/abc123');
  assert.equal(run.docxUrl, 'http://example.com/x.docx');
});

// --- convention 3: one period format per cadence ----------------------------------

test('PERIOD_FORMAT_BY_TYPE: VP Weekly is the lone isoWeek exception; everything else is date', () => {
  assert.equal(PERIOD_FORMAT_BY_TYPE['VP Weekly'], 'isoWeek');
  for (const t of REPORT_TYPES) {
    if (t === 'VP Weekly') continue;
    assert.equal(PERIOD_FORMAT_BY_TYPE[t], 'date', `expected "date" period format for ${t}`);
  }
});

test('buildRun: rejects a date-shaped period for VP Weekly (must be ISO week)', () => {
  assert.throws(
    () => buildRun({ ...base, type: 'VP Weekly', source: 'AIWeeklyReport', period: '2026-07-17' }),
    /does not match the "isoWeek" format/,
  );
});

test('buildRun: accepts an ISO-week period for VP Weekly', () => {
  const run = buildRun({
    ...base, type: 'VP Weekly', source: 'AIWeeklyReport', period: '2026-W29',
  });
  assert.equal(run.period, '2026-W29');
});

test('buildRun: rejects an ISO-week-shaped period for a date-cadence type', () => {
  assert.throws(
    () => buildRun({ ...base, period: '2026-W29' }),
    /does not match the "date" format/,
  );
});

test('buildRun: rejects a malformed date period (single-digit month/day)', () => {
  assert.throws(
    () => buildRun({ ...base, period: '2026-7-5' }),
    /does not match the "date" format/,
  );
});

// --- convention 4: watchdog schedule parity ---------------------------------------

test('watchdog SCHEDULE covers every REPORT_TYPES entry (day-one parity)', () => {
  assert.deepEqual(scheduleMissingTypes(SCHEDULE), []);
});

test('scheduleMissingTypes flags a type absent from a (test) schedule', () => {
  const partial = SCHEDULE.filter((e) => e.type !== 'Self-Improvement');
  assert.deepEqual(scheduleMissingTypes(partial), ['Self-Improvement']);
});

test('watchdog SCHEDULE periodFormat never drifts from config.mjs PERIOD_FORMAT_BY_TYPE', () => {
  assert.deepEqual(scheduleFormatMismatches(SCHEDULE), []);
});

test('scheduleFormatMismatches flags a drifted periodFormat', () => {
  // Retargeted from VP Weekly (retired 2026-07-25, no longer in SCHEDULE) to a
  // still-scheduled type. Every ACTIVE type is date-format, so the injected drift
  // is the inverse direction: scheduled=isoWeek vs expected=date.
  const drifted = SCHEDULE.map((e) => (e.type === 'FourthOS Sponsor' ? { ...e, periodFormat: 'isoWeek' } : e));
  const mismatches = scheduleFormatMismatches(drifted);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].type, 'FourthOS Sponsor');
  assert.equal(mismatches[0].scheduled, 'isoWeek');
  assert.equal(mismatches[0].expected, 'date');
});

test('runWatchdog warns (non-fatal) on a schedule missing a type, and still evaluates the rest', () => {
  const partial = SCHEDULE.filter((e) => e.type !== 'Self-Improvement');
  const origError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const results = runWatchdog({
      schedule: partial, now: new Date(2026, 6, 16, 13, 0, 0), dryRun: true, query: () => [],
    });
    assert.equal(results.length, partial.length);
    assert.ok(logged.some((l) => l.includes('no watchdog schedule entry') && l.includes('Self-Improvement')));
  } finally {
    console.error = origError;
  }
});
