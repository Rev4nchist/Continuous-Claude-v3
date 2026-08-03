// check-drift.test.mjs — pure tests for the drift/age logic (no ntn spawn).
// Run: node --test scripts/report-registry/test/check-drift.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeDrift, newestRunDate, groupByType, parseMaxAgeHours, DEFAULT_MAX_AGE_HOURS, checkDrift,
  isGenuineRow,
} from '../check-drift.mjs';
import { ACTIVE_REPORT_TYPES } from '../config.mjs';

const NOW = Date.parse('2026-07-05T12:00:00Z');

// A raw DS row shaped like queryDataSource returns.
function dsRow(type, runDate) {
  return { properties: { 'Report Type': { select: { name: type } }, 'Run Date': { date: { start: runDate } } } };
}

// A raw DS row with Summary/Status too (queryDataSource shape — plain_text array).
function dsRowFull(type, runDate, { summary, status } = {}) {
  const props = {
    'Report Type': { select: { name: type } },
    'Run Date': { date: { start: runDate } },
  };
  if (summary !== undefined) props.Summary = { rich_text: [{ plain_text: summary }] };
  if (status !== undefined) props.Status = { select: { name: status } };
  return { properties: props };
}

test('computeDrift flags a type older than the threshold', () => {
  const r = computeDrift(
    { 'VP Weekly': '2026-07-01T12:00:00Z' }, // 96h old
    { maxAgeHours: 48, now: NOW, types: ['VP Weekly'] },
  );
  assert.equal(r[0].type, 'VP Weekly');
  assert.equal(r[0].ageHours, 96);
  assert.equal(r[0].drift, true);
});

test('computeDrift passes a fresh type (within threshold)', () => {
  const r = computeDrift(
    { 'VP Weekly': '2026-07-05T00:00:00Z' }, // 12h old
    { maxAgeHours: 48, now: NOW, types: ['VP Weekly'] },
  );
  assert.equal(r[0].ageHours, 12);
  assert.equal(r[0].drift, false);
});

test('computeDrift treats a type with NO rows as drift (ageHours null)', () => {
  const r = computeDrift({}, { maxAgeHours: 48, now: NOW, types: ['System Health'] });
  assert.equal(r[0].newestRunDate, null);
  assert.equal(r[0].ageHours, null);
  assert.equal(r[0].drift, true);
});

test('computeDrift boundary: exactly at threshold is NOT drift (strictly older only)', () => {
  const r = computeDrift(
    { X: '2026-07-03T12:00:00Z' }, // exactly 48h
    { maxAgeHours: 48, now: NOW, types: ['X'] },
  );
  assert.equal(r[0].ageHours, 48);
  assert.equal(r[0].drift, false);
});

test('computeDrift returns one row per requested type', () => {
  const r = computeDrift(
    { A: '2026-07-05T11:00:00Z' },
    { maxAgeHours: 48, now: NOW, types: ['A', 'B', 'C'] },
  );
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((x) => x.type), ['A', 'B', 'C']);
  assert.equal(r.find((x) => x.type === 'A').drift, false);
  assert.equal(r.find((x) => x.type === 'B').drift, true); // no data
});

test('newestRunDate returns the max Run Date, tolerating last_edited_time fallback', () => {
  const rows = [
    { properties: { 'Run Date': { date: { start: '2026-07-01' } } } },
    { properties: { 'Run Date': { date: { start: '2026-07-04' } } } },
    { properties: {}, last_edited_time: '2026-07-02T00:00:00Z' },
  ];
  assert.equal(newestRunDate(rows), '2026-07-04');
  assert.equal(newestRunDate([]), '');
});

test('newestRunDate compares CHRONOLOGICALLY across mixed tz formats (T6.1 #5)', () => {
  // Same instant family: '...06:00:00-05:00' == 11:00Z is the NEWEST, but a raw string
  // compare would pick '...10:00:00Z' ('10' > '06'). A bare 'YYYY-MM-DD' (00:00Z) is
  // oldest. The numeric compare must return the -05:00 offset row.
  const rows = [
    { properties: { 'Run Date': { date: { start: '2026-07-09' } } } },
    { properties: { 'Run Date': { date: { start: '2026-07-09T10:00:00Z' } } } },
    { properties: { 'Run Date': { date: { start: '2026-07-09T06:00:00-05:00' } } } },
  ];
  assert.equal(newestRunDate(rows), '2026-07-09T06:00:00-05:00');
});

test('newestRunDate: a parseable date beats an unparseable one', () => {
  const rows = [
    { properties: { 'Run Date': { date: { start: 'not-a-date' } } } },
    { properties: { 'Run Date': { date: { start: '2026-07-04T00:00:00Z' } } } },
  ];
  assert.equal(newestRunDate(rows), '2026-07-04T00:00:00Z');
});

test('groupByType buckets rows by Report Type select', () => {
  const rows = [
    { properties: { 'Report Type': { select: { name: 'VP Weekly' } } } },
    { properties: { 'Report Type': { select: { name: 'VP Weekly' } } } },
    { properties: { 'Report Type': { select: { name: 'System Health' } } } },
  ];
  const g = groupByType(rows);
  assert.equal(g['VP Weekly'].length, 2);
  assert.equal(g['System Health'].length, 1);
});

test('parseMaxAgeHours reads flag forms and defaults', () => {
  assert.equal(parseMaxAgeHours(['--max-age-hours', '72']), 72);
  assert.equal(parseMaxAgeHours(['--max-age-hours=24']), 24);
  assert.equal(parseMaxAgeHours([]), DEFAULT_MAX_AGE_HOURS);
});

// --- checkDrift per-cadence (the false-weekly-drift fix) -------------------------

test('checkDrift default is PER-CADENCE: a ~100h-old WEEKLY row is fresh; a ~100h-old DAILY row is drift', () => {
  const now = Date.parse('2026-07-21T12:00:00Z');
  // 2026-07-17T08:00Z -> ~100h before now (4d4h).
  const rows = [dsRow('FourthOS Sponsor', '2026-07-17T08:00:00Z'), dsRow('Team Dashboard', '2026-07-17T08:00:00Z')];
  const report = checkDrift({ query: () => rows, now }); // no explicit maxAgeHours -> per-cadence
  assert.equal(report.find((r) => r.type === 'FourthOS Sponsor').drift, false); // weekly 192h -> fresh
  assert.equal(report.find((r) => r.type === 'Team Dashboard').drift, true); // daily 48h -> drift
});

test('checkDrift with an explicit flat maxAgeHours overrides ALL types (documented --max-age-hours behavior)', () => {
  const now = Date.parse('2026-07-21T12:00:00Z');
  const rows = [dsRow('FourthOS Sponsor', '2026-07-17T08:00:00Z')]; // ~100h
  const flat = checkDrift({ maxAgeHours: 48, query: () => rows, now });
  assert.equal(flat.find((r) => r.type === 'FourthOS Sponsor').drift, true); // flat 48 ignores cadence
});

// --- T9.2: synthetic-row exclusion (the 2026-08-02 audit false-green fix) --------

test('isGenuineRow: true for a normal pipeline row, false for a watchdog miss-row or a corrective row', () => {
  assert.equal(isGenuineRow(dsRowFull('Team Dashboard', '2026-07-05T01:00:00Z', { summary: 'cards refreshed=8' })), true);
  assert.equal(isGenuineRow(dsRowFull('Team Dashboard', '2026-07-05T01:00:00Z', {
    summary: 'watchdog: no "Team Dashboard" row found for period 2026-07-04 by its deadline+grace',
  })), false);
  assert.equal(isGenuineRow(dsRowFull('Team Dashboard', '2026-07-05T01:00:00Z', { summary: 'backfill: seeded from archive' })), false);
  assert.equal(isGenuineRow(dsRowFull('Team Dashboard', '2026-07-05T01:00:00Z', { summary: 'remap: corrected period' })), false);
});

test('checkDrift: a type whose ONLY row is a watchdog miss-row is drift=true — the exact 2026-08-02 audit false-green (Team Dashboard reported drift=false because of its own watchdog miss-row)', () => {
  const now = Date.parse('2026-07-05T12:00:00Z');
  const rows = [
    dsRowFull('Team Dashboard', '2026-07-05T01:04:00Z', {
      summary: 'watchdog: no "Team Dashboard" row found for period 2026-07-04 by its deadline+grace',
      status: 'Failed',
    }),
  ];
  const report = checkDrift({ query: () => rows, now });
  const td = report.find((r) => r.type === 'Team Dashboard');
  assert.equal(td.newestRunDate, null); // no genuine row -> nothing to be "fresh" against
  assert.equal(td.ageHours, null);
  assert.equal(td.drift, true);
});

test('checkDrift: a type whose ONLY row is a corrective (backfill:/remap:) row is ALSO drift=true, same reasoning', () => {
  const now = Date.parse('2026-07-05T12:00:00Z');
  const rows = [dsRowFull('Team Dashboard', '2026-07-05T01:00:00Z', { summary: 'backfill: seeded from archive', status: 'OK' })];
  const report = checkDrift({ query: () => rows, now });
  assert.equal(report.find((r) => r.type === 'Team Dashboard').drift, true);
});

test('checkDrift: a type with a genuine FAILED pipeline row still counts toward freshness -> drift=false (must NOT break — a Failed row proves the run launched, a different already-visible failure)', () => {
  const now = Date.parse('2026-07-05T12:00:00Z');
  const rows = [dsRowFull('Team Dashboard', '2026-07-05T01:00:00Z', { summary: 'dashboard sync crashed: ECONNRESET', status: 'Failed' })];
  const report = checkDrift({ query: () => rows, now });
  const td = report.find((r) => r.type === 'Team Dashboard');
  assert.equal(td.drift, false);
  assert.ok(td.newestRunDate);
});

test('checkDrift returns one row per ACTIVE_REPORT_TYPES type, in order, unchanged shape', () => {
  const report = checkDrift({ query: () => [], now: NOW });
  // Derived, not a hardcoded count: checkDrift covers the ACTIVE types only, so
  // retiring one must shrink this in lockstep rather than fail an arbitrary >= 6.
  assert.equal(report.length, ACTIVE_REPORT_TYPES.length);
  assert.deepEqual(report.map((r) => r.type), ACTIVE_REPORT_TYPES);
  for (const r of report) {
    assert.ok('type' in r && 'newestRunDate' in r && 'ageHours' in r && 'drift' in r);
    assert.equal(r.drift, true); // no rows for any type -> all drift
  }
});
