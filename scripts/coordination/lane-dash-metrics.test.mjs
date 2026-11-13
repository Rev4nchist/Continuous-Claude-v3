/**
 * lane-dash-metrics.test -- the tile figures, verdict words and sentences of the lane dashboard.
 *
 *   node --test scripts/coordination/lane-dash-metrics.test.mjs
 *
 * Pure: inline fixtures, no database, no clock, no files. Each test names the change that breaks it.
 * The first 28 cases port the practice app's tests/metrics.test.ts. The rest cover the rules changed
 * for the export (growthState, parked strip, label list, stale text, tile 5 without a meter, tile 6 with
 * four rows, no handle, unique row ids).
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import {
  DEFAULT_CATEGORY_ROWS, DEFAULT_PROJECT_ROWS, DEFAULT_SHOW_ROWS, HOURS_TOKEN, NO_CATEGORY_NAME, STATE_WORD, STATUS_WORD, TILE_COLUMNS,
  GOAL_MAX, addDays, assignmentTile, buildTileRows, goalOf, isParkedNote, categoryRows, chicagoDay, dailyRows, daveQueue, verdictTile, formatChicago, formatDay, freshSentence,
  growthState, hasPriorWindow, hoursOld, isStale, neverStarted, niceTicks, p0Sentence, p0Tile, pileTile,
  pluralize, projectRows, showWipBar, sign, staleChipText, staleSentence, takeaway, targetMap, trendState, windowOf, wipTile,
} from './lane-dash-metrics.mjs';

const META_BASE = {
  exported_at: '2026-11-08T05:32:25.630Z',
  today: '2026-11-07',
  history_start: '2026-10-27',
  band_history_start: '2026-11-07',
  board: 'b',
  board_url: 'https://example.test/board',
  stale_after_hours: 36,
  projects_stale_after_hours: 168,
  timezone: 'America/Chicago',
  open_check: 0,
  done_check: 0,
};

const lane = (over = {}) => ({
  id: 'x', title: 't', project: 'p', track: null, band: null, state: 'backlog', priority: null,
  created_at: '2026-11-01T12:00:00.000Z', created_day: '2026-11-01', first_claim_at: null, done_at: null,
  done_day: null, last_work_at: null, dave_ask_at: null, lease_expires_at: null, held: false,
  has_done_when: false, terminal: false, claims: 0, ...over,
});

const TARGETS = targetMap([
  { key: 'window_days', value: 7 }, { key: 'age_edge_1', value: 1 }, { key: 'age_edge_2', value: 3 },
  { key: 'age_edge_3', value: 7 }, { key: 'show_rows', value: 6 }, { key: 'project_rows', value: 4 },
  { key: 'log_rows', value: 12 }, { key: 'p0_cap', value: 5 },
]);

const proj = (key, over = {}) => ({
  key, name: key, goal: '', done_when: '', terminal_lanes: '', terminal_total: 1, terminal_done: 0,
  status: 'open', done_at: null, done_day: null, visible_until: null, parked: false, proposed: false, focus: false, ...over,
});

// ---------------------------------------------------------------- day math (ported)

test('chicagoDay: UTC date after 18:00 Chicago is still the Chicago day', () => {
  assert.equal(chicagoDay('2026-11-08T05:32:25.630Z'), '2026-11-07');
});

test('chicagoDay: midnight edge in CDT and the fall-back day', () => {
  assert.equal(chicagoDay('2026-11-01T04:59:00Z'), '2026-10-31');
  assert.equal(chicagoDay('2026-11-01T05:00:00Z'), '2026-11-01');
  assert.equal(chicagoDay('2026-11-02T05:59:00Z'), '2026-11-01');
  assert.equal(chicagoDay('2026-11-02T06:00:00Z'), '2026-11-02');
});

test('addDays: month and year borders', () => {
  assert.equal(addDays('2026-03-02', -6), '2026-02-24');
  assert.equal(addDays('2026-01-03', -6), '2025-12-28');
  assert.equal(addDays('2026-11-07', 0), '2026-11-07');
});

test('windowOf: 7 days inclusive at both ends', () => {
  assert.deepEqual(windowOf('2026-11-07', 7), { start: '2026-11-01', end: '2026-11-07' });
});

test('formatChicago: prints the zone Intl gives, with a plain space before AM or PM', () => {
  assert.match(formatChicago('2026-11-08T05:32:25.630Z'), /CST$/);
  assert.match(formatChicago('2026-10-30T17:00:00Z'), /CDT$/);
  // Breaks if the narrow no-break space that newer ICU puts before PM reaches the page text.
  assert.equal(formatChicago('2026-11-08T05:32:25.630Z'), 'Nov 7, 11:32 PM CST');
});

// ---------------------------------------------------------------- gates (ported)

test('hasPriorWindow: false on 2026-11-07, false 11-09, true from 11-10', () => {
  assert.equal(hasPriorWindow('2026-10-27', '2026-11-07', 7), false);
  assert.equal(hasPriorWindow('2026-10-27', '2026-11-09', 7), false);
  assert.equal(hasPriorWindow('2026-10-27', '2026-11-10', 7), true);
});

test('isStale: 36 h exactly is fresh, one ms over is stale', () => {
  const t = Date.parse('2026-11-08T05:32:25.630Z');
  assert.equal(isStale(META_BASE.exported_at, t + 36 * 3600_000, 36), false);
  assert.equal(isStale(META_BASE.exported_at, t + 36 * 3600_000 + 1, 36), true);
});

// ---------------------------------------------------------------- tile 1 (ported)

test('daveQueue: Chicago-day cut at window_start, done lanes and null asks excluded', () => {
  const lanes = [
    lane({ id: 'a', state: 'blocked', dave_ask_at: '2026-11-01T05:00:00Z' }),
    lane({ id: 'b', state: 'blocked', dave_ask_at: '2026-11-01T04:59:00Z' }),
    lane({ id: 'c', state: 'done', dave_ask_at: '2026-11-05T12:00:00Z' }),
    lane({ id: 'd', state: 'ready' }),
  ];
  const q = daveQueue(lanes, META_BASE, TARGETS);
  assert.equal(q.n, 2);
  assert.equal(q.m, 1);
  assert.equal(q.older, 1);
  assert.deepEqual(q.rows.map((r) => r.id), ['b', 'a']);
});

test('daveQueue: oldest age counts from exported_at, not the browser clock', () => {
  const lanes = [lane({ state: 'blocked', dave_ask_at: '2026-11-06T05:32:25.630Z' })];
  assert.equal(daveQueue(lanes, META_BASE, TARGETS).oldestDays, 2);
});

test('daveQueue: shows at most show_rows rows', () => {
  const lanes = Array.from({ length: 9 }, (_, i) =>
    lane({ id: `l${i}`, state: 'blocked', dave_ask_at: `2026-11-0${i + 1}T12:00:00Z` }));
  const q = daveQueue(lanes, META_BASE, TARGETS);
  assert.equal(q.n, 9);
  assert.equal(q.rows.length, 6);
});

// ---------------------------------------------------------------- tile 2 (ported)

test('pileTile: done lane with no claim counts in done, not in waited (R1)', () => {
  const lanes = [
    lane({ id: 'w', state: 'done', done_day: '2026-11-05', first_claim_at: '2026-11-03T12:00:00.000Z' }),
    lane({ id: 'n', state: 'done', done_day: '2026-11-05', first_claim_at: null }),
    lane({ id: 'q', state: 'done', done_day: '2026-11-05', first_claim_at: '2026-11-01T18:00:00.000Z' }),
  ];
  const p = pileTile(lanes, { ...META_BASE, open_check: 0 }, TARGETS);
  assert.equal(p.done, 3);
  assert.equal(p.waited, 1);
});

test('pileTile: lane done in window but created before it is open at the start', () => {
  const lanes = [
    lane({ id: 'old', state: 'done', created_day: '2026-10-30', done_day: '2026-11-03' }),
    lane({ id: 'new', state: 'ready', created_day: '2026-11-04' }),
    lane({ id: 'gone', state: 'done', created_day: '2026-10-28', done_day: '2026-10-31' }),
  ];
  const p = pileTile(lanes, { ...META_BASE, open_check: 2 }, TARGETS);
  assert.equal(p.openStart, 1);
  assert.equal(p.created, 1);
  assert.equal(p.done, 1);
  assert.equal(p.net, 0);
  assert.equal(p.openNow, 2);
});

// ---------------------------------------------------------------- tile 3, 4 (ported)

test('neverStarted: edge ages fall in the upper bucket', () => {
  const exp = Date.parse(META_BASE.exported_at);
  const at = (days) => new Date(exp - days * 86400_000).toISOString();
  const lanes = [0.5, 1, 2.9, 3, 6.9, 7, 20].map((d, i) => lane({ id: `n${i}`, created_at: at(d) }));
  lanes.push(lane({ id: 'worked', created_at: at(30), last_work_at: at(1) }));
  lanes.push(lane({ id: 'done', state: 'done', created_at: at(30) }));
  const n = neverStarted(lanes, META_BASE, TARGETS);
  assert.equal(n.n, 7);
  assert.deepEqual(n.buckets.map((b) => b.count), [1, 2, 2, 2]);
  assert.equal(n.over, 2);
});

test('wipTile: lapsed means null lease or lease before exported_at', () => {
  const lanes = [
    lane({ state: 'active', lease_expires_at: '2026-11-08T05:32:25.630Z' }),
    lane({ state: 'active', lease_expires_at: '2026-11-08T05:32:25.629Z' }),
    lane({ state: 'active', lease_expires_at: null }),
    lane({ state: 'ready', lease_expires_at: '2026-11-09T00:00:00Z' }),
  ];
  const w = wipTile(lanes, META_BASE);
  assert.deepEqual([w.active, w.live, w.lapsed], [3, 1, 2]);
});

// ---------------------------------------------------------------- tile 5 (ported)

test('p0Tile: under, at and over cap; null cap has no state', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => lane({ id: `p${i}`, band: 'P0', state: 'active' }));
  assert.equal(p0Tile(mk(0), 5).state, 'none');
  assert.equal(p0Tile(mk(4), 5).state, 'under');
  assert.equal(p0Tile(mk(5), 5).state, 'at');
  assert.equal(p0Tile(mk(6), 5).state, 'over');
  assert.equal(p0Tile(mk(6), 5).extra, 1);
  assert.equal(p0Tile(mk(6), null).state, 'nocap');
});

test('p0Tile: done P0 is not open, unheld counted among open only', () => {
  const lanes = [
    lane({ band: 'P0', state: 'done', held: false }),
    lane({ band: 'P0', state: 'active', held: true }),
    lane({ band: 'P0', state: 'ready', held: false }),
    lane({ band: 'P1', state: 'ready', held: false }),
  ];
  const t = p0Tile(lanes, 5);
  assert.equal(t.p0, 2);
  assert.equal(t.unheld, 1);
});

// ---------------------------------------------------------------- tile 6 (ported)

test('projectRows: unassigned hidden, focus first, growing next, expired Done hidden', () => {
  const projects = [
    proj('calm'), proj('grow'), proj('foc', { focus: true }), proj('unassigned', { status: 'no_end' }),
    proj('gone', { status: 'done', visible_until: '2026-11-06' }),
    proj('shown', { status: 'done', visible_until: '2026-11-07' }),
  ];
  const lanes = [
    lane({ project: 'grow', created_day: '2026-11-05', state: 'ready' }),
    lane({ project: 'calm', state: 'ready', created_day: '2026-10-28' }),
    lane({ project: 'calm', state: 'done', created_day: '2026-10-28', done_day: '2026-11-05' }),
  ];
  const r = projectRows(projects, lanes, META_BASE, TARGETS);
  const calm = r.rows.find((x) => x.key === 'calm');
  assert.equal(calm.closed, 1); // done lanes are the only rows with a done_day, so closed must count them
  assert.equal(calm.growing, false);
  assert.deepEqual(r.rows.map((x) => x.key), ['foc', 'grow', 'calm', 'shown']);
  assert.equal(r.growing, 1);
  assert.equal(r.unassignedOpen, 0);
});

// ---------------------------------------------------------------- tile 7 (ported)

test('assignmentTile: edge days, kinds, prior window gate', () => {
  const a = (day, how, who = 'session') => ({ at: `${day}T15:00:00.000Z`, day, lane_id: 'l', who, how, reassigned: false });
  const rows = [
    a('2026-10-31', 'claim'), a('2026-11-01', 'claim'), a('2026-11-01', 'reclaim'),
    a('2026-11-07', 'placed in Now', 'dave'), a('2026-11-07', 'placed in Next', 'dave'),
  ];
  const t = assignmentTile(rows, META_BASE, TARGETS);
  assert.equal(t.total, 4);
  assert.equal(t.claims, 1);
  assert.equal(t.reclaims, 1);
  assert.equal(t.placed, 2);
  assert.equal(t.days.length, 7);
  assert.equal(t.days[0].day, '2026-11-01');
  assert.equal(t.days[6].day, '2026-11-07');
  assert.equal(t.prior, null);
});

// ---------------------------------------------------------------- the counts agree with each other (ported "real export" case, inline data)

test('generated export: the tile counts agree with meta and with each other', () => {
  const projects = [proj('alpha'), proj('beta'), proj('unassigned', { status: 'no_end' })];
  const lanes = [];
  for (let i = 0; i < 40; i++) {
    const created = addDays('2026-10-27', i % 12);
    const done = i % 3 === 0 ? addDays(created, (i % 5) + 1) : null;
    lanes.push(lane({
      id: `g${i}`, project: ['alpha', 'beta', 'unassigned'][i % 3], created_day: created,
      created_at: `${created}T15:00:00.000Z`, state: done && done <= '2026-11-07' ? 'done' : (i % 4 === 0 ? 'blocked' : 'ready'),
      done_day: done && done <= '2026-11-07' ? done : null,
      dave_ask_at: i % 4 === 0 ? `${created}T16:00:00.000Z` : null,
      band: i % 9 === 0 ? 'P0' : null, last_work_at: i % 2 ? '2026-11-02T00:00:00.000Z' : null,
    }));
  }
  const open = lanes.filter((l) => l.state !== 'done').length;
  const meta = { ...META_BASE, open_check: open };
  const q = daveQueue(lanes, meta, TARGETS);
  const p = pileTile(lanes, meta, TARGETS);
  const ns = neverStarted(lanes, meta, TARGETS);
  const w = wipTile(lanes, meta);
  const all = projectRows(projects, lanes, meta, { ...TARGETS, project_rows: 99 });
  assert.equal(p.openNow - p.openStart, p.net);
  assert.equal(q.m + q.older, q.n);
  assert.equal(w.live + w.lapsed, w.active);
  assert.equal(ns.buckets.reduce((s, b) => s + b.count, 0), ns.n);
  assert.ok(p.waited <= p.done);
  assert.ok(all.rows.every((r) => r.key !== 'unassigned'));
  const win = windowOf(meta.today, 7);
  const un = lanes.filter((l) => l.project === 'unassigned');
  const sum = (f) => all.rows.reduce((s, r) => s + f(r), 0);
  assert.equal(sum((r) => r.opened) + un.filter((l) => l.created_day >= win.start).length, p.created);
  assert.equal(sum((r) => r.closed) + un.filter((l) => l.done_day !== null && l.done_day >= win.start).length, p.done);
  assert.ok(sum((r) => r.closed) > 0);
});

// ---------------------------------------------------------------- gate 3 fixes (ported)

test('projectRows: priorKnown follows the 14-day history gate', () => {
  assert.equal(projectRows([], [], META_BASE, TARGETS).priorKnown, false);
  assert.equal(projectRows([], [], { ...META_BASE, today: '2026-11-10' }, TARGETS).priorKnown, true);
});

test('p0Sentence: null cap reads as a sentence, a cap reads "of N"', () => {
  assert.equal(p0Sentence({ p0: 2, cap: null, unheld: 2 }), '2 P0 lanes open, no limit set, 2 with no holder');
  assert.equal(p0Sentence({ p0: 1, cap: null, unheld: 1 }), '1 P0 lane open, no limit set, 1 with no holder');
  assert.equal(p0Sentence({ p0: 2, cap: 5, unheld: 0 }), '2 of 5 P0 lanes open, 0 with no holder');
});

test('showWipBar: only when both segments are above zero', () => {
  assert.equal(showWipBar(4, 0), false);
  assert.equal(showWipBar(0, 3), false);
  assert.equal(showWipBar(0, 0), false);
  assert.equal(showWipBar(4, 3), true);
});

test('niceTicks: even steps from 0, at most five ticks, top covers the max', () => {
  assert.deepEqual(niceTicks(57), [0, 15, 30, 45, 60]);
  assert.deepEqual(niceTicks(60), [0, 15, 30, 45, 60]);
  assert.deepEqual(niceTicks(3), [0, 1, 2, 3]);
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(171), [0, 50, 100, 150, 200]);
});

// Breaks if the phone page default goes back to 6 wait rows (Dave, 2026-11-08: 4 rows, about 3 screens).
test('DEFAULT_SHOW_ROWS is 4', () => {
  assert.equal(DEFAULT_SHOW_ROWS, 4);
});

test('daveQueue: with no targets it shows DEFAULT_SHOW_ROWS rows', () => {
  const lanes = Array.from({ length: 12 }, (_, i) =>
    lane({ id: `a${i}`, state: 'blocked', dave_ask_at: `2026-11-0${(i % 7) + 1}T15:00:00Z` }));
  assert.equal(daveQueue(lanes, META_BASE, {}).rows.length, DEFAULT_SHOW_ROWS);
});

test('neverStarted: labels say "to under" for half-open buckets', () => {
  assert.deepEqual(neverStarted([], META_BASE, TARGETS).buckets.map((b) => b.label),
    ['Under 1 day', '1 to under 3 days', '3 to under 7 days', '7 days or more']);
});

test('formatDay: month and day without the year or zero pad', () => {
  assert.equal(formatDay('2026-11-07'), 'Nov 7');
  assert.equal(formatDay('2026-10-27'), 'Oct 27');
  assert.equal(formatDay('2026-01-03'), 'Jan 3');
});

test('pluralize: one is singular, zero and many are plural', () => {
  assert.equal(pluralize(1, 'lane'), 'lane');
  assert.equal(pluralize(0, 'lane'), 'lanes');
  assert.equal(pluralize(2, 'lane'), 'lanes');
});

// ---------------------------------------------------------------- changed rules (new)

// Breaks if Flat gets a verdict colour, or the tone ignores whether an earlier week exists.
test('growthState: word from the net, tone neutral when there is no earlier week or the net is flat', () => {
  assert.deepEqual(growthState(95, true), { word: 'Growing', tone: 'warn' });
  assert.deepEqual(growthState(-3, true), { word: 'Shrinking', tone: 'ok' });
  assert.deepEqual(growthState(0, true), { word: 'Flat', tone: 'neutral' });
  assert.deepEqual(growthState(95, false), { word: 'Growing', tone: 'neutral' });
  assert.deepEqual(growthState(-3, false), { word: 'Shrinking', tone: 'neutral' });
  assert.deepEqual(growthState(0, false), { word: 'Flat', tone: 'neutral' });
});

// Breaks if the strip moves back to the page, runs on a name that is not parked, or leaves the suffix.
test('projectRows: " (parked)" is stripped from a parked project name only', () => {
  const projects = [
    proj('t', { name: 'TREX (parked)', parked: true }),
    proj('u', { name: 'Keeps name (parked)', parked: false }),
    proj('v', { name: 'Mid (parked) name', parked: true }),
  ];
  const names = Object.fromEntries(projectRows(projects, [], META_BASE, TARGETS).rows.map((r) => [r.key, r.name]));
  assert.equal(names.t, 'TREX');
  assert.equal(names.u, 'Keeps name (parked)');
  assert.equal(names.v, 'Mid (parked) name');
});

// Breaks if tile 6 still reads show_rows (6), or the default is not 4.
test('projectRows: shows project_rows rows (default 4), not show_rows', () => {
  assert.equal(DEFAULT_PROJECT_ROWS, 4);
  const projects = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => proj(k));
  const r = projectRows(projects, [], META_BASE, TARGETS);
  assert.equal(r.rows.length, 4);
  assert.equal(r.hidden, 2);
  const none = projectRows(projects, [], META_BASE, {});
  assert.equal(none.rows.length, 4);
  const six = projectRows(projects, [], META_BASE, { ...TARGETS, project_rows: 6 });
  assert.equal(six.rows.length, 6);
  assert.equal(six.hidden, 0);
});

// Breaks if the sign helper drops the plus or prints a minus sign variant.
test('sign: plus for above zero, hyphen minus for below, bare 0', () => {
  assert.equal(sign(3), '+3');
  assert.equal(sign(-3), '-3');
  assert.equal(sign(0), '0');
});

// Breaks if the hours come from a clock inside the module, or the wording moves.
test('stale text: hours come from the nowMs argument; chip, full sentence and fresh sentence', () => {
  const exp = Date.parse(META_BASE.exported_at);
  const now = exp + 40 * 3600_000;
  assert.equal(hoursOld(META_BASE.exported_at, now), 40);
  assert.equal(hoursOld(META_BASE.exported_at, exp - 5000), 0);
  assert.equal(hoursSinceRounded(exp + 90 * 60_000), 2);
  assert.equal(staleChipText(40), 'Stale, 40 h');
  assert.equal(staleSentence(formatChicago(META_BASE.exported_at), 40), 'Stale: data from Nov 7, 11:32 PM CST, 40 h old');
  assert.equal(freshSentence('Nov 7, 11:32 PM CST', 3), 'Data from Nov 7, 11:32 PM CST, 3 hours ago.');
  assert.equal(HOURS_TOKEN, '{h}');
});
function hoursSinceRounded(nowMs) { return hoursOld(META_BASE.exported_at, nowMs); }

// Breaks if the header sentence changes shape or reads "1 lanes wait".
test('takeaway: queue split first, then the pile change; one lane reads singular', () => {
  const q = { n: 2, m: 1, older: 1, windowDays: 7 };
  const p = { net: 3, windowDays: 7 };
  assert.equal(takeaway(q, p), '2 lanes wait on Dave: 1 asked in the last 7 days, 1 older. The pile changed by +3 in the last 7 days.');
  assert.equal(takeaway({ n: 1, m: 1, older: 0, windowDays: 7 }, { net: -2, windowDays: 7 }),
    '1 lane waits on Dave: 1 asked in the last 7 days, 0 older. The pile changed by -2 in the last 7 days.');
});

// ---------------------------------------------------------------- the tiles document

const OPEN_STAMP = 'Nov 7, 11:32 PM CST';

function fixture() {
  const mk = (o) => lane(o);
  const lanes = [
    mk({ id: 'a1', title: 'Pick the logo', project: 'alpha', band: 'P0', state: 'blocked', created_day: '2026-11-01', created_at: '2026-11-01T15:00:00.000Z', dave_ask_at: '2026-11-06T05:32:00.000Z', last_work_at: '2026-11-05T00:00:00.000Z', has_done_when: true }),
    mk({ id: 'a2', title: 'Decide the plan', project: 'alpha', band: 'P1', state: 'blocked', created_day: '2026-10-29', created_at: '2026-10-29T15:00:00.000Z', dave_ask_at: '2026-10-30T12:00:00.000Z', last_work_at: '2026-11-05T00:00:00.000Z' }),
    mk({ id: 'a3', title: 'Build it', project: 'beta', band: 'P0', state: 'active', held: true, created_day: '2026-10-28', created_at: '2026-10-28T15:00:00.000Z', lease_expires_at: '2026-11-09T00:00:00.000Z', last_work_at: '2026-11-05T00:00:00.000Z' }),
    mk({ id: 'a4', title: 'Lapsed work', project: 'beta', state: 'active', created_day: '2026-10-29', created_at: '2026-10-29T15:00:00.000Z', lease_expires_at: null, last_work_at: '2026-11-05T00:00:00.000Z' }),
    mk({ id: 'a5', title: 'Fresh idea', project: 'alpha', state: 'ready', created_day: '2026-11-07', created_at: '2026-11-07T17:00:00.000Z' }),
    mk({ id: 'a6', title: 'Old idea', project: 'unassigned', state: 'backlog', created_day: '2026-11-01', created_at: '2026-11-01T12:00:00.000Z' }),
    mk({ id: 'd1', title: 'Shipped', project: 'alpha', state: 'done', created_day: '2026-11-03', created_at: '2026-11-03T12:00:00.000Z', first_claim_at: '2026-11-04T12:00:00.000Z', done_at: '2026-11-05T15:00:00.000Z', done_day: '2026-11-05' }),
    mk({ id: 'd2', title: 'Shipped early', project: 'beta', state: 'done', created_day: '2026-10-28', created_at: '2026-10-28T12:00:00.000Z', done_at: '2026-10-30T15:00:00.000Z', done_day: '2026-10-30' }),
  ];
  const projects = [
    proj('alpha', { name: 'Alpha', goal: 'GOAL-TEXT-ALPHA', done_when: 'DONE-WHEN-TEXT-ALPHA', terminal_total: 2, terminal_done: 1 }),
    proj('beta', { name: 'Beta', goal: 'GOAL-TEXT-BETA', status: 'no_end', terminal_total: 0 }),
    proj('gamma', { name: 'Gamma (parked)', goal: 'GOAL-TEXT-GAMMA', parked: true, proposed: true }),
    proj('delta', { name: 'Delta', status: 'no_end', terminal_total: 0 }),
    proj('eps', { name: 'Eps', status: 'no_end', terminal_total: 0 }),
    proj('zeta', { name: 'Zeta', status: 'no_end', terminal_total: 0 }),
    proj('unassigned', { name: 'Unassigned', status: 'no_end', terminal_total: 0 }),
  ];
  const assignments = [
    { at: '2026-11-01T15:00:00.000Z', day: '2026-11-01', lane_id: 'a1', who: 'session', how: 'claim', reassigned: false },
    { at: '2026-11-02T15:00:00.000Z', day: '2026-11-02', lane_id: 'a3', who: 'session', how: 'reclaim', reassigned: false },
    { at: '2026-11-07T15:00:00.000Z', day: '2026-11-07', lane_id: 'a5', who: 'dave', how: 'placed in Now', reassigned: false },
  ];
  const targets = [
    { key: 'p0_cap', value: 5 }, { key: 'wip_limit', value: null }, { key: 'never_started_cap', value: null },
    { key: 'dave_queue_cap', value: null }, { key: 'window_days', value: 7 }, { key: 'age_edge_1', value: 1 },
    { key: 'age_edge_2', value: 3 }, { key: 'age_edge_3', value: 7 }, { key: 'show_rows', value: 6 },
    { key: 'project_rows', value: 4 }, { key: 'log_rows', value: 12 }, { key: 'trend_min_days', value: 7 },
  ];
  const meta = { ...META_BASE, open_check: lanes.filter((l) => l.state !== 'done').length };
  const snapshots = [{ day: '2026-11-07', snapshot_at: META_BASE.exported_at, open: 6 }];
  return { lanes, projects, assignments, targets, meta, snapshots };
}

const build = (over = {}) => buildTileRows({ ...fixture(), ...over });
const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
const text = (rows, id) => byId(rows).get(id)?.text;

// Breaks if a figure, row or sentence is added without the full column set, or two rows share an id.
test('tiles rows: every row has the seven columns, ids are unique, and values are from the allowed sets', () => {
  const rows = build();
  assert.deepEqual(TILE_COLUMNS, ['id', 'tile', 'kind', 'rank', 'value', 'text', 'tone']);
  assert.ok(rows.length > 50);
  const seen = new Set();
  for (const r of rows) {
    assert.deepEqual(Object.keys(r), TILE_COLUMNS, r.id);
    assert.ok(!seen.has(r.id), `duplicate id ${r.id}`);
    seen.add(r.id);
    assert.ok([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 'page'].includes(r.tile), r.id);
    assert.ok(['figure', 'text', 'chip', 'row', 'bar', 'day', 'tick'].includes(r.kind), r.id);
    assert.ok(r.rank === null || Number.isInteger(r.rank), r.id);
    assert.ok(r.value === null || Number.isFinite(r.value), r.id);
    assert.ok(r.text === null || typeof r.text === 'string', r.id);
    assert.ok([null, 'neutral', 'ok', 'warn', 'bad'].includes(r.tone), `${r.id} tone ${r.tone}`);
    assert.ok(r.value !== null || r.text !== null, `${r.id} has neither value nor text`);
  }
});

// Breaks if one tile writes ids under another tile's prefix, which would mix them on the page.
test('tiles rows: one tile is the rows with one id prefix', () => {
  const prefix = { 1: 'wait', 2: 'pile', 3: 'never', 4: 'wip', 5: 'p0', 6: 'proj', 7: 'assign', 8: 'verdict', 9: 'cat', 10: 'daily', page: 'page' };
  for (const r of build()) assert.ok(r.id.startsWith(`${prefix[r.tile]}.`), `${r.id} on tile ${r.tile}`);
});

// Breaks if a row is built twice with a hidden clock, or the build reads Date.now.
test('tiles rows: the same input gives the same rows, whatever the process clock says', () => {
  // mock.timers replaces Date itself, so new Date() and Date.now() both see the fake time. Patching Date.now alone would miss new Date().
  const before = JSON.stringify(build());
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2031-05-05T12:00:00Z') });
  try {
    assert.equal(JSON.stringify(build()), before);
  } finally {
    mock.timers.reset();
  }
});

// Breaks if trend_min_days 0 with no snapshots turns the chart on and the build reads the last snapshot of an empty list.
test('trendState: zero snapshots never show the chart, even when trend_min_days is 0', () => {
  assert.equal(trendState([], targetMap([{ key: 'trend_min_days', value: 0 }])).show, false);
  assert.doesNotThrow(() => build({ snapshots: [], targets: fixture().targets.map((t) => (t.key === 'trend_min_days' ? { ...t, value: 0 } : t)) }));
});

// Breaks if tile 3 loses its axis ticks, which leaves the page to find the bar maximum itself.
test('tile 3 writes axis ticks that reach the largest bar', () => {
  const rows = build();
  const bars = rows.filter((r) => r.id.startsWith('never.bar.')).map((r) => r.value);
  const ticks = rows.filter((r) => r.id.startsWith('never.tick.')).map((r) => r.value);
  assert.ok(ticks.length >= 2, 'never.tick rows exist');
  assert.equal(ticks[0], 0);
  assert.ok(ticks[ticks.length - 1] >= Math.max(...bars), 'the top tick reaches the largest bar');
});

// Breaks if the page has to read targets.json to size its loading state.
test('page rows carry the row limits: show_rows, project_rows, log_rows', () => {
  const rows = build();
  assert.equal(byId(rows).get('page.rows.wait').value, 6);
  assert.equal(byId(rows).get('page.rows.proj').value, 4);
  assert.equal(byId(rows).get('page.rows.log').value, 12);
});

// Breaks if any summary sentence drifts from TILE-SPEC section 5 or from the practice app.
test('tiles rows: every summary sentence for the base fixture', () => {
  const rows = build();
  assert.equal(text(rows, 'wait.summary'), '2 of 6 open lanes wait on Dave.');
  assert.equal(text(rows, 'wait.split'), '1 asked in the last 7 days, 1 older');
  assert.equal(text(rows, 'wait.detail'),
    `1 asked in the last 7 days, 1 older. The oldest ask is 8 days old, as of ${OPEN_STAMP}. Dave's queue has no limit set.`);
  assert.equal(text(rows, 'pile.summary'), 'In the 7 days to Nov 7, today so far, 4 lanes opened and 1 lane finished, a net change of +3.');
  assert.equal(text(rows, 'pile.detail'),
    'Open went from 3 to 6. 1 of 1 finished lane waited 1 day or more. The pile is Growing, with history from Oct 27 and no earlier week to compare. The trend line starts after 7 daily snapshots; there is 1 so far.');
  assert.equal(text(rows, 'never.summary'), '2 of 6 open lanes have never been worked.');
  assert.equal(text(rows, 'never.detail'), '0 are 7 days old or more and need a decision. No cap is set.');
  assert.equal(text(rows, 'wip.summary'), '1 of 2 active lanes have a live lease and 1 are lapsed.');
  assert.equal(text(rows, 'wip.detail'), 'No work-in-progress limit is set.');
  assert.equal(text(rows, 'p0.summary'), '2 of 5 P0 lanes open, 1 with no holder.');
  assert.equal(text(rows, 'p0.detail'), 'The state is under cap.');
  assert.equal(text(rows, 'proj.summary'), '1 of 6 open lanes have a done-when; 1 unassigned.');
  assert.equal(text(rows, 'proj.detail'),
    '1 project opened more lanes than it closed; there is no earlier week to compare. '
    + 'Project Alpha has 1 of 2 terminal lanes done, net +2 in 7 days, 3 open lanes. '
    + 'Project Beta has no end defined, net 0 in 7 days, 2 open lanes. '
    + 'Project Gamma has 0 of 1 terminal lane done, net 0 in 7 days, 0 open lanes. '
    + 'Project Delta has no end defined, net 0 in 7 days, 0 open lanes.');
  assert.equal(text(rows, 'assign.summary'), 'In the 7 days to Nov 7, today so far, 3 assignments started: 1 claim, 1 reclaim and 1 placed by Dave.');
  assert.equal(text(rows, 'assign.line'), '3 assignments in 7 days to Nov 7, today so far: 1 claim, 1 reclaim, 1 placed by Dave');
  assert.equal(text(rows, 'page.takeaway'), '2 lanes wait on Dave: 1 asked in the last 7 days, 1 older. The pile changed by +3 in the last 7 days.');
});

// Breaks if the stale words are computed at export time (they would say 0 h) or lose the {h} slot.
test('tiles rows: page rows carry the data stamp and stale templates with the {h} slot, never an hour count', () => {
  const rows = build();
  assert.equal(text(rows, 'page.data_from'), OPEN_STAMP);
  assert.equal(text(rows, 'page.stale.chip'), 'Stale, {h} h');
  assert.equal(text(rows, 'page.stale.sentence'), `Stale: data from ${OPEN_STAMP}, {h} h old`);
  assert.equal(text(rows, 'page.fresh.sentence'), `Data from ${OPEN_STAMP}, {h} hours ago.`);
  assert.equal(byId(rows).get('page.stale.chip').tone, 'warn');
  assert.equal(byId(rows).get('page.stale.limit').value, 36);
});

// Breaks if the growth chip falls back to a view-side word, or Flat/no-prior gets a colour.
test('tiles rows: tile 2 growth chip uses growthState (no earlier week gives a neutral Growing)', () => {
  const rows = build();
  assert.deepEqual([byId(rows).get('pile.growth').text, byId(rows).get('pile.growth').tone], ['Growing', 'neutral']);
  assert.equal(text(rows, 'pile.history_note'), 'history from Oct 27, no earlier week');
  assert.equal(byId(rows).get('pile.net').value, 3);
  assert.equal(byId(rows).get('pile.net').text, '+3');
  const late = build({ meta: { ...fixture().meta, history_start: '2026-10-20' } });
  assert.equal(byId(late).get('pile.growth').tone, 'warn');
  assert.equal(byId(late).has('pile.history_note'), false);
  assert.ok(byId(late).has('pile.line.prior'));
});

// Breaks if tile 5 gets slot rows again, red shows at the cap, or a null cap gets a number.
test('tile 5: no meter rows; chip words under cap, at cap, over cap, no limit set; bad only above a set cap', () => {
  const p0lanes = (n) => Array.from({ length: n }, (_, i) =>
    lane({ id: `z${i}`, project: 'alpha', band: 'P0', state: 'ready', created_day: '2026-10-28', created_at: '2026-10-28T12:00:00.000Z' }));
  const withP0 = (n, cap) => {
    const f = fixture();
    const lanes = [...f.lanes.filter((l) => l.band !== 'P0'), ...p0lanes(n)];
    const targets = f.targets.map((t) => (t.key === 'p0_cap' ? { ...t, value: cap } : t));
    return build({ lanes, targets, meta: { ...f.meta, open_check: lanes.filter((l) => l.state !== 'done').length } });
  };
  const chip = (rows) => [byId(rows).get('p0.chip').text, byId(rows).get('p0.chip').tone];
  assert.deepEqual(chip(withP0(4, 5)), ['under cap', 'neutral']);
  assert.deepEqual(chip(withP0(5, 5)), ['at cap', 'neutral']);
  assert.deepEqual(chip(withP0(6, 5)), ['over cap by 1', 'bad']);
  assert.deepEqual(chip(withP0(9, null)), ['no limit set', 'neutral']);
  assert.deepEqual(chip(withP0(0, 5)), ['under cap', 'neutral']);
  assert.equal(text(withP0(0, 5), 'p0.empty'), 'No open P0 lanes');
  assert.equal(byId(withP0(9, null)).get('p0.figure').text, '9');
  assert.equal(byId(withP0(6, 5)).get('p0.figure').text, '6 of 5');
  assert.equal(text(withP0(9, null), 'p0.summary'), '9 P0 lanes open, no limit set, 9 with no holder.');
  assert.equal(text(withP0(9, null), 'p0.detail'), 'No limit is set.');
  for (const rows of [withP0(4, 5), withP0(6, 5), withP0(9, null)]) {
    assert.deepEqual(rows.filter((r) => r.tile === 5 && !['figure', 'text', 'chip'].includes(r.kind)), []);
    assert.equal(rows.filter((r) => r.tile === 5 && /slot|meter/.test(r.id)).length, 0);
  }
  // Red appears nowhere else: not on the base fixture, and not on any other tile with 6 P0 lanes open.
  assert.deepEqual(build().filter((r) => r.tone === 'bad'), []);
  assert.deepEqual(withP0(6, 5).filter((r) => r.tone === 'bad').map((r) => r.id), ['p0.chip']);
});

// Breaks if tile 6 shows more than 4 rows, keeps goal text, or leaves "(parked)" in a name.
test('tile 6: four project rows, counts only, no goal text, parked name stripped, one hidden-rows line', () => {
  const rows = build();
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes('proj.row.4.name'));
  assert.ok(!ids.some((i) => i.startsWith('proj.row.5.')));
  assert.equal(text(rows, 'proj.more'), '2 more on the board');
  assert.equal(text(rows, 'proj.row.3.name'), 'Gamma');
  assert.equal(text(rows, 'proj.row.1.name'), 'Alpha');
  assert.equal(text(rows, 'proj.row.1.meta'), '1 of 2 terminal lanes done · net +2 in 7 days · 3 open lanes');
  assert.equal(text(rows, 'proj.row.2.meta'), 'net 0 in 7 days · 2 open lanes');
  assert.equal(text(rows, 'proj.row.3.chip.parked'), 'Parked');
  assert.equal(text(rows, 'proj.row.3.chip.proposed'), 'Proposed');
  assert.equal(text(rows, 'proj.row.1.chip.growing'), 'Growing');
  assert.equal(byId(rows).get('proj.row.1.chip.growing').tone, 'neutral'); // no earlier week
  assert.equal(text(rows, 'proj.row.2.chip.status'), 'No end defined');
  assert.equal(text(rows, 'proj.history_note'), 'Growing is net flow only: history from Oct 27, no earlier week.');
  assert.equal(text(rows, 'proj.ranked_note'), 'ranked by net flow, no cap set');
  const all = JSON.stringify(rows);
  assert.ok(!all.includes('GOAL-TEXT'));
  assert.ok(!all.includes('DONE-WHEN-TEXT'));
  assert.ok(!all.includes('(parked)'));
});

// Breaks if tile 6 and tile 1 share one row limit.
test('row limits: tile 1 follows show_rows, tile 6 follows project_rows', () => {
  const f = fixture();
  const targets = f.targets.map((t) => (t.key === 'show_rows' ? { ...t, value: 1 } : t));
  const rows = build({ targets });
  assert.ok(byId(rows).has('wait.row.1.title'));
  assert.ok(!byId(rows).has('wait.row.2.title'));
  assert.equal(text(rows, 'wait.more'), '1 more on the board');
  assert.ok(byId(rows).has('proj.row.4.name'));
});

// Breaks if tile 1 rows lose the title, the oldest-first order, or the age wording.
test('tile 1: rows are oldest first with title and a meta line; the limit text says no limit set', () => {
  const rows = build();
  assert.equal(text(rows, 'wait.row.1.title'), 'Decide the plan');
  assert.equal(text(rows, 'wait.row.1.meta'), 'alpha · P1 · 8 days');
  // Breaks if any row meta repeats the age words that the age column already shows.
  for (const [id, r] of byId(rows)) {
    if (/^wait\.row\.\d+\.meta$/.test(id)) assert.ok(!/asked|before the export/.test(r.text), id);
  }
  assert.equal(byId(rows).get('wait.row.1.meta').value, 8);
  assert.equal(text(rows, 'wait.row.2.title'), 'Pick the logo');
  assert.equal(text(rows, 'wait.limit'), 'no limit set');
  assert.equal(byId(rows).get('wait.count').value, 2);
  assert.equal(byId(rows).get('wait.oldest').value, 8);
  assert.equal(text(rows, 'wait.count.label'), 'of 6 open');
});

// Breaks if the tile 7 axis label and its aria text come from two lists, or an ISO date reaches body text.
test('tile 7: one label list for the visible label and the aria text; "today" last; no ISO date in any text', () => {
  const rows = build();
  const labels = [1, 2, 3, 4, 5, 6, 7].map((i) => text(rows, `assign.day.${i}`));
  assert.deepEqual(labels, ['Nov 1', 'Nov 2', 'Nov 3', 'Nov 4', 'Nov 5', 'Nov 6', 'today']);
  const totals = [1, 2, 3, 4, 5, 6, 7].map((i) => byId(rows).get(`assign.day.${i}`).value);
  assert.deepEqual(totals, [1, 1, 0, 0, 0, 0, 1]);
  assert.equal(text(rows, 'assign.aria'), `Stacked columns per day: ${labels.map((l, i) => `${l} ${totals[i]}`).join(', ')}`);
  assert.equal(byId(rows).get('assign.bar.7.placed').value, 1);
  assert.equal(byId(rows).get('assign.bar.1.claims').value, 1);
  for (const r of rows) assert.ok(!/\d{4}-\d{2}-\d{2}/.test(r.text ?? ''), `${r.id}: ${r.text}`);
  assert.equal(text(rows, 'assign.log.button'), 'Show log (3 rows)');
  assert.equal(text(rows, 'assign.log.1.lane'), 'a5');
  assert.equal(text(rows, 'assign.log.1.when'), 'placed in Now, Nov 7, 9:00 AM CST');
});

// Breaks if the P0 / WIP / never-started rows lose their words, bars or aria text.
test('tiles 3 and 4: bucket bars, aria text, WIP chips and bar', () => {
  const rows = build();
  assert.deepEqual([1, 2, 3, 4].map((i) => byId(rows).get(`never.bar.${i}`).value), [1, 0, 1, 0]);
  assert.equal(text(rows, 'never.bar.4'), '7 days or more');
  assert.equal(byId(rows).get('never.bar.4').tone, 'warn');
  assert.equal(byId(rows).get('never.bar.1').tone, 'neutral');
  assert.equal(text(rows, 'never.aria'),
    'Bar chart of never-started lanes by age: Under 1 day 1, 1 to under 3 days 0, 3 to under 7 days 1, 7 days or more 0');
  assert.equal(text(rows, 'never.chip'), '0 at 7 days or more need a decision (proposed edge)');
  assert.equal(text(rows, 'wip.chip.live'), '1 live');
  assert.equal(byId(rows).get('wip.chip.live').tone, 'ok');
  assert.equal(text(rows, 'wip.chip.lapsed'), '1 lapsed');
  assert.equal(byId(rows).get('wip.chip.lapsed').tone, 'warn');
  assert.equal(text(rows, 'wip.aria'), 'Stacked bar: 1 live, 1 lapsed');
  assert.ok(byId(rows).has('wip.bar.1') && byId(rows).has('wip.bar.2'));
  assert.equal(text(rows, 'wip.live_at'), `Live at ${OPEN_STAMP}.`);
});

// Breaks if a one-segment WIP bar is drawn, or a zero-lapsed chip is coloured.
test('tile 4: one segment draws no bar rows and a zero lapsed chip stays neutral', () => {
  const f = fixture();
  const lanes = f.lanes.filter((l) => l.id !== 'a4');
  const rows = build({ lanes, meta: { ...f.meta, open_check: lanes.filter((l) => l.state !== 'done').length } });
  assert.ok(!byId(rows).has('wip.bar.1'));
  assert.equal(byId(rows).get('wip.chip.lapsed').tone, 'neutral');
  const none = build({ lanes: lanes.filter((l) => l.state !== 'active'), meta: { ...f.meta, open_check: 3 } });
  assert.equal(text(none, 'wip.empty'), 'No active lanes');
  assert.ok(!byId(none).has('wip.chip.live'));
});

// Breaks if the 7-snapshot gate or the zero-based ticks are lost.
test('tile 2: trend rows appear only from trend_min_days snapshots, with ticks from zero', () => {
  const few = build();
  assert.equal(text(few, 'pile.trend.note'), 'Trend after 7 daily snapshots: 1 so far');
  assert.ok(!byId(few).has('pile.day.1'));
  const snaps = Array.from({ length: 7 }, (_, i) => ({ day: addDays('2026-11-01', i), snapshot_at: 'x', open: 40 + i * 5 }));
  const many = build({ snapshots: snaps });
  assert.ok(!byId(many).has('pile.trend.note'));
  assert.equal(byId(many).get('pile.day.7').value, 70);
  assert.equal(text(many, 'pile.day.1'), 'Nov 1');
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => byId(many).get(`pile.tick.${i}`)?.value), [0, 20, 40, 60, 80]);
  assert.equal(text(many, 'pile.trend.aria'), 'Line chart of open lanes per day, 7 snapshots, last 70');
  assert.equal(text(many, 'pile.trend.data_to'), 'data to Nov 7');
});

// Breaks if a raw 8-hex handle in a title, project, name or lane id reaches tiles.json.
test('privacy: a session handle never appears; the control proves the check can fail', () => {
  const HANDLE = /#[0-9a-f]{8}/i;
  assert.ok(HANDLE.test('Resume #abcdef12 now'), 'control: the pattern must match a handle');
  const f = fixture();
  const lanes = f.lanes.map((l) => (l.id === 'a2' ? { ...l, title: 'Resume #abcdef12 and #12 and #AAAA1111', project: 'alpha' } : l));
  lanes.push(lane({ id: 'h-#deadbeef', title: 'x', project: 'alpha', state: 'blocked', dave_ask_at: '2026-11-03T12:00:00Z', created_day: '2026-11-03' }));
  const assignments = [...f.assignments, { at: '2026-11-07T16:00:00.000Z', day: '2026-11-07', lane_id: 'h-#deadbeef', who: 'session', how: 'claim', reassigned: false }];
  const projects = f.projects.map((p) => (p.key === 'alpha' ? { ...p, name: 'Alpha #cafe0123' } : p));
  const out = JSON.stringify(build({ lanes, assignments, projects, meta: { ...f.meta, open_check: lanes.filter((l) => l.state !== 'done').length } }));
  assert.ok(!HANDLE.test(out), out.match(HANDLE)?.[0]);
  assert.ok(!/"handle"/.test(out));
  assert.ok(out.includes('Resume #[handle] and #12 and #[handle]'));
});

// Breaks if an empty board throws (a new board has no lanes and a null history_start).
test('empty board: no throw, ids unique, the empty-state sentences appear', () => {
  const f = fixture();
  const rows = buildTileRows({
    lanes: [], assignments: [], projects: [proj('unassigned', { status: 'no_end' })], targets: f.targets,
    meta: { ...f.meta, history_start: null, open_check: 0, done_check: 0 }, snapshots: [],
  });
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  assert.equal(text(rows, 'wait.empty'), 'No lanes waiting on Dave');
  assert.equal(text(rows, 'pile.empty'), 'No lanes in this export');
  assert.equal(text(rows, 'never.empty'), 'Every open lane has been worked');
  assert.equal(text(rows, 'wip.empty'), 'No active lanes');
  assert.equal(text(rows, 'p0.empty'), 'No open P0 lanes');
  assert.equal(text(rows, 'proj.empty'), 'No project rules match any lane');
  assert.equal(text(rows, 'proj.summary'), 'No open lanes.');
  assert.equal(text(rows, 'assign.empty'), 'No assignments in the last 7 days');
  assert.equal(text(rows, 'assign.summary'), 'No assignments in the last 7 days.');
  assert.equal(text(rows, 'pile.summary'), 'No lanes in this export.');
});

// Breaks if the document grows toward the 256 KB cap: 2000 lanes must stay far below it.
test('size: a large board stays well under the 256 KB cap', () => {
  const f = fixture();
  const lanes = Array.from({ length: 2000 }, (_, i) =>
    lane({ id: `s${i}`, title: `Lane number ${i}`, project: 'alpha', state: 'blocked', dave_ask_at: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T12:00:00Z`, created_day: '2026-10-28', created_at: '2026-10-28T12:00:00.000Z' }));
  const rows = build({ lanes, meta: { ...f.meta, open_check: 2000 } });
  const bytes = Buffer.byteLength(JSON.stringify({ sql: 'x', exportedAt: 'y', rows }));
  assert.ok(bytes < 64 * 1024, `${bytes} bytes`);
});

// ---------------------------------------------------------------- tiles 8 to 10: verdict, category rows, day table (fleetops-category-progress)

// Window Nov 1 to Nov 7 (META_BASE.today). History from Oct 27, so no earlier week. Reminder cards (track reminders) are in no count.
function catFixture() {
  const projects = [
    proj('re', { name: 'Review engine', status: 'done', done_day: '2026-10-30', visible_until: '2026-11-01' }),
    proj('lb', { name: 'Lane board' }),
    proj('unassigned', { name: 'Unassigned', status: 'no_end' }),
  ];
  const lanes = [
    lane({ id: 'r1', title: 'TITLE-R1', project: 're', band: 'P2', state: 'backlog', created_day: '2026-11-02', created_at: '2026-11-02T15:00:00.000Z' }),
    lane({ id: 'r2', title: 'TITLE-R2', project: 're', band: 'P0', state: 'blocked', created_day: '2026-10-28', created_at: '2026-10-28T15:00:00.000Z' }),
    lane({ id: 'r3', title: 'TITLE-R3', project: 're', state: 'done', created_day: '2026-10-29', created_at: '2026-10-29T12:00:00.000Z', first_claim_at: '2026-10-31T12:00:00.000Z', done_at: '2026-11-03T15:00:00.000Z', done_day: '2026-11-03' }),
    lane({ id: 'r4', title: 'TITLE-R4', project: 're', state: 'done', created_day: '2026-10-27', created_at: '2026-10-27T12:00:00.000Z' }),
    lane({ id: 'l1', title: 'TITLE-L1', project: 'lb', band: 'P1', state: 'ready', created_day: '2026-11-05', created_at: '2026-11-05T15:00:00.000Z' }),
    lane({ id: 'l2', title: 'TITLE-L2', project: 'lb', state: 'done', created_day: '2026-11-06', created_at: '2026-11-06T13:00:00.000Z', first_claim_at: '2026-11-06T14:00:00.000Z', done_at: '2026-11-06T16:00:00.000Z', done_day: '2026-11-06' }),
    lane({ id: 'l3', title: 'TITLE-L3', project: 'lb', track: 'reminders', band: 'P1', state: 'backlog', created_day: '2026-11-04', created_at: '2026-11-04T15:00:00.000Z' }),
    lane({ id: 'u1', title: 'TITLE-U1', project: 'unassigned', state: 'backlog', created_day: '2026-11-03', created_at: '2026-11-03T15:00:00.000Z' }),
    lane({ id: 'u2', title: 'TITLE-U2', project: 'unassigned', state: 'backlog', created_day: '2026-11-04', created_at: '2026-11-04T15:00:00.000Z' }),
    lane({ id: 'u3', title: 'TITLE-U3', project: 'unassigned', state: 'backlog', created_day: '2026-11-05', created_at: '2026-11-05T15:00:00.000Z' }),
    lane({ id: 'u4', title: 'TITLE-U4', project: 'unassigned', track: 'reminders', state: 'backlog', created_day: '2026-11-07', created_at: '2026-11-07T15:00:00.000Z' }),
  ];
  return { projects, lanes, meta: { ...META_BASE, open_check: lanes.filter((l) => l.state !== 'done').length } };
}
const catBuild = (over = {}) => buildTileRows({ ...fixture(), ...catFixture(), ...over });

// Breaks if the old projectRows filters come back: a Done project past visible_until, or unassigned, leaves the table.
test('categoryRows: a Done project past visible_until stays; unassigned is last as "No category yet"', () => {
  const f = catFixture();
  const c = categoryRows(f.projects, f.lanes, f.meta, TARGETS);
  assert.deepEqual(c.rows.map((r) => r.key), ['re', 'lb', 'unassigned']);
  assert.equal(c.rows[2].name, NO_CATEGORY_NAME);
  assert.equal(NO_CATEGORY_NAME, 'No category yet');
});

// Breaks if the sort puts unassigned by its open count (3, the most), or a tie does not keep the project order.
test('categoryRows: sorted by open count, ties keep project order, unassigned pinned last', () => {
  const f = catFixture();
  const extra = [lane({ id: 'l9', project: 'lb', state: 'ready', created_day: '2026-10-28' })];
  const c = categoryRows(f.projects, [...f.lanes, ...extra], f.meta, TARGETS);
  assert.deepEqual(c.rows.map((r) => r.key), ['re', 'lb', 'unassigned'], 'tie 2 open each: re first by project order');
  const more = [lane({ id: 'l8', project: 'lb', state: 'ready', created_day: '2026-10-28' }), ...extra];
  assert.deepEqual(categoryRows(f.projects, [...f.lanes, ...more], f.meta, TARGETS).rows.map((r) => r.key), ['lb', 're', 'unassigned']);
});

// Breaks if a reminder card is counted anywhere in tiles 8 to 10, or a born-done lane (no done_day) is not closed.
test('categoryRows: counts per row, reminders out, born-done counts as closed', () => {
  const f = catFixture();
  const [re, lb, un] = categoryRows(f.projects, f.lanes, f.meta, TARGETS).rows;
  assert.deepEqual([re.total, re.closed, re.open, re.blocked, re.created, re.closedWindow, re.net, re.waited, re.lastClose],
    [4, 2, 2, 1, 1, 1, 0, 1, '2026-11-03']);
  assert.deepEqual([lb.total, lb.closed, lb.open, lb.created, lb.closedWindow, lb.net, lb.waited], [2, 1, 1, 2, 1, 1, 0]);
  assert.deepEqual([un.total, un.closed, un.open, un.created, un.net, un.lastClose], [3, 0, 3, 3, 3, null]);
  assert.deepEqual(re.bands, { P0: 1, P1: 0, P2: 1, none: 0 });
  assert.deepEqual(lb.bands, { P0: 0, P1: 1, P2: 0, none: 0 }, 'the P1 reminder l3 is not counted');
});

// Breaks if "No category yet" disappears when it has no cards, or a zero total divides.
test('categoryRows: "No category yet" with 0 cards still shows 0 of 0; another empty category is left out', () => {
  const f = catFixture();
  const lanes = f.lanes.filter((l) => l.project !== 'unassigned');
  const c = categoryRows([...f.projects, proj('empty')], lanes, f.meta, TARGETS);
  assert.deepEqual(c.rows.map((r) => r.key), ['re', 'lb', 'unassigned']);
  const rows = catBuild({ lanes, projects: [...f.projects, proj('empty')] });
  assert.equal(text(rows, 'cat.row.3.name'), 'No category yet');
  assert.equal(text(rows, 'cat.row.3.closed'), '0 of 0 closed');
  assert.equal(byId(rows).get('cat.row.3.total').value, 0);
  for (const r of rows) assert.ok(r.value === null || Number.isFinite(r.value), r.id);
});

// Breaks if a project key in the lanes but not in projects.json is dropped (the seat changes the rules later).
test('categoryRows: a lane project missing from the projects list still gets a row, before unassigned', () => {
  const f = catFixture();
  const lanes = [...f.lanes, lane({ id: 'n1', project: 'newcat', state: 'ready', created_day: '2026-10-28' })];
  assert.deepEqual(categoryRows(f.projects, lanes, f.meta, TARGETS).rows.map((r) => r.key), ['re', 'lb', 'newcat', 'unassigned']);
});

// Breaks if the cap cuts "No category yet", or the hidden count is wrong.
test('categoryRows: the cap never cuts "No category yet"; cat.more names the hidden count', () => {
  const f = catFixture();
  const c = categoryRows(f.projects, f.lanes, f.meta, { ...TARGETS, category_rows: 2 });
  assert.deepEqual(c.rows.map((r) => r.key), ['re', 'unassigned']);
  assert.equal(c.hidden, 1);
  const rows = catBuild({ targets: [...fixture().targets, { key: 'category_rows', value: 2 }] });
  assert.equal(text(rows, 'cat.more'), '1 more category not shown');
  assert.equal(byId(rows).get('page.rows.cat').value, 2);
  assert.equal(DEFAULT_CATEGORY_ROWS, 9);
  assert.ok(!byId(catBuild()).has('cat.more'));
  assert.equal(byId(catBuild()).get('page.rows.cat').value, 9);
});

// Breaks if the category nets and the verdict net use two different lane sets (the reminder rule on one side only).
test('verdictTile: net counts no reminder; the category nets sum to it; the day table sums to the week', () => {
  const f = catFixture();
  const v = verdictTile(f.lanes, f.meta, TARGETS);
  assert.deepEqual([v.created, v.done, v.net, v.waited, v.reminders], [6, 2, 4, 1, 2]);
  const cats = categoryRows(f.projects, f.lanes, f.meta, { ...TARGETS, category_rows: 99 });
  assert.equal(cats.rows.reduce((s, r) => s + r.net, 0), v.net);
  const days = dailyRows(f.lanes, f.meta, TARGETS);
  assert.equal(days.reduce((s, d) => s + d.created, 0), v.created);
  assert.equal(days.reduce((s, d) => s + d.closed, 0), v.done);
});

// Breaks if a verdict word, the share line or the reminder note changes wording or shows when it should not.
test('tile 8: verdict words, share line only while the top category net is above 0, reminder note', () => {
  const rows = catBuild();
  assert.equal(text(rows, 'verdict.net'), '+4');
  assert.equal(byId(rows).get('verdict.net').value, 4);
  assert.equal(text(rows, 'verdict.growth'), 'Growing');
  assert.equal(byId(rows).get('verdict.growth').tone, 'neutral', 'no earlier week: no verdict colour');
  assert.equal(text(rows, 'verdict.sentence'), 'We create more cards than we close: net +4 in 7 days.');
  assert.equal(text(rows, 'verdict.week'), 'In the 7 days to Nov 7, today so far: 6 created, 2 closed.');
  assert.equal(text(rows, 'verdict.waited'), '1 of 2 closed cards waited 1 day or more.');
  assert.equal(text(rows, 'verdict.share'), 'Largest net gain: No category yet, +3.');
  assert.equal(text(rows, 'verdict.note'), '2 reminder cards are left out.');
  const f = catFixture();
  const closing = [...f.lanes, ...['x1', 'x2', 'x3', 'x4', 'x5'].map((id) => lane({ id, project: 'lb', state: 'done', created_day: '2026-10-28', done_day: '2026-11-04', done_at: '2026-11-04T15:00:00.000Z' }))];
  const neg = catBuild({ lanes: closing });
  assert.equal(text(neg, 'verdict.sentence'), 'We close more cards than we create: net -1 in 7 days.');
  assert.ok(!byId(neg).has('verdict.share'));
  const flat = catBuild({ lanes: closing.filter((l) => l.id !== 'x5') });
  assert.equal(text(flat, 'verdict.sentence'), 'We create and close the same number of cards: net 0 in 7 days.');
  const noRem = catBuild({ lanes: f.lanes.filter((l) => l.track !== 'reminders') });
  assert.ok(!byId(noRem).has('verdict.note'));
});

// Breaks if the share line puts a category net beside a smaller page net ("+10 of the +2"), which reads as nonsense.
test('tile 8: the share line never claims a part larger than the whole', () => {
  const f = catFixture();
  // lb closes 5 more cards in the window: lb net -4, page net -1 + ... => page net below the unassigned net of +3.
  const lanes = [...f.lanes, ...['y1', 'y2', 'y3', 'y4'].map((id) => lane({ id, project: 'lb', state: 'done', created_day: '2026-10-28', done_day: '2026-11-04', done_at: '2026-11-04T15:00:00.000Z' }))];
  const rows = catBuild({ lanes });
  assert.equal(byId(rows).get('verdict.net').value, 0 + 3 + (2 - 5));
  assert.equal(text(rows, 'verdict.net'), '0');
  assert.ok(!byId(rows).has('verdict.share'), 'page net 0: no share line');
  // Keep y1 and y2: lb net -1, page net +2, top category (No category yet) +3, larger than the page net.
  const one = catBuild({ lanes: lanes.slice(0, -2) });
  assert.equal(byId(one).get('verdict.net').value, 2);
  const share = text(one, 'verdict.share');
  assert.ok(!/ of the /.test(share), share);
  assert.equal(share, 'Largest net gain: No category yet, +3.');
});

// Breaks if the earlier week shows without 14 days of history, or its numbers come from another window.
test('tile 8: the earlier week shows only with a full earlier window', () => {
  assert.ok(!byId(catBuild()).has('verdict.prior'));
  const f = catFixture();
  const lanes = [...f.lanes, lane({ id: 'p1', project: 'lb', state: 'done', created_day: '2026-10-26', done_day: '2026-10-27', done_at: '2026-10-27T15:00:00.000Z' })];
  const rows = catBuild({ lanes, meta: { ...f.meta, history_start: '2026-10-20' } });
  // Oct 25 to Oct 31: r2, r3, r4 and p1 created; only p1 closed (r4 is born done, with no day).
  assert.equal(text(rows, 'verdict.prior'), 'Earlier 7 days: 4 created, 1 closed, net +3.');
});

// Breaks if a category row loses its words, the bar inputs, or the growth chip shows on a net of 0.
test('tile 9: category row text, bar inputs, growth chip only on a net that is not 0', () => {
  const rows = catBuild();
  assert.equal(text(rows, 'cat.row.1.name'), 'Review engine');
  assert.equal(text(rows, 'cat.row.1.closed'), '2 of 4 closed');
  assert.equal(byId(rows).get('cat.row.1.closed').value, 2);
  assert.equal(byId(rows).get('cat.row.1.total').value, 4);
  assert.equal(text(rows, 'cat.row.1.meta'), '2 open, 1 blocked · 7 days: 1 created, 1 closed, net 0 · 1 waited · last close Nov 3');
  assert.equal(text(rows, 'cat.row.1.bands'), 'Open by band: P0 1 · P1 0 · P2 1 · none 0');
  assert.ok(!byId(rows).has('cat.row.1.chip.growth'));
  assert.equal(text(rows, 'cat.row.2.meta'), '1 open · 7 days: 2 created, 1 closed, net +1 · 0 waited · last close Nov 6');
  assert.equal(text(rows, 'cat.row.2.chip.growth'), 'Growing');
  assert.equal(text(rows, 'cat.row.3.meta'), '3 open · 7 days: 3 created, 0 closed, net +3');
  assert.equal(text(rows, 'cat.note'), 'Closed includes dropped cards. Reopened cards count as open. Reminder cards are left out.');
  assert.ok(byId(rows).get('cat.row.1.name').rank === 1 && byId(rows).get('cat.row.3.bands').rank === 3);
});

// Breaks if " (parked)" reaches a category name (export-dash-data.db.test asserts no "(parked)" in tiles.json),
// or a parked category loses the Parked chip that says it instead.
test('tile 9: a parked category name loses " (parked)" and gets a Parked chip', () => {
  const f = catFixture();
  const projects = f.projects.map((p) => (p.key === 'lb' ? { ...p, name: 'Lane board (parked)', parked: true } : p));
  const rows = catBuild({ projects });
  assert.ok(!JSON.stringify(rows).includes('(parked)'));
  assert.equal(text(rows, 'cat.row.2.name'), 'Lane board');
  assert.equal(text(rows, 'cat.row.2.chip.parked'), 'Parked');
  assert.ok(!byId(rows).has('cat.row.1.chip.parked'));
});

// Breaks if the day table changes length, order or the "today so far" label, or net is not created minus closed.
test('tile 10: seven days oldest first, last label "today so far", net is created minus closed', () => {
  const rows = catBuild();
  const labels = [1, 2, 3, 4, 5, 6, 7].map((i) => text(rows, `daily.row.${i}.label`));
  assert.deepEqual(labels, ['Nov 1', 'Nov 2', 'Nov 3', 'Nov 4', 'Nov 5', 'Nov 6', 'today so far']);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((i) => byId(rows).get(`daily.row.${i}.created`).value), [0, 1, 1, 1, 2, 1, 0]);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((i) => byId(rows).get(`daily.row.${i}.closed`).value), [0, 0, 1, 0, 0, 1, 0]);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((i) => text(rows, `daily.row.${i}.net`)), ['0', '+1', '0', '+1', '+2', '0', '0']);
  assert.ok(!byId(rows).has('daily.row.8.label'));
  assert.equal(text(rows, 'daily.note'), "Rebuilt from today's card states.");
  assert.equal(text(rows, 'daily.summary'), 'In the 7 days to Nov 7, closed beat created on 0 of 7 days.');
});

// Breaks if a lane title or a lane id reaches a row of tiles 8 to 10 (seat condition a: names and counts only).
test('tiles 8 to 10: no lane title and no lane id in any row', () => {
  const f = catFixture();
  const rows = catBuild().filter((r) => [8, 9, 10].includes(r.tile));
  assert.ok(rows.length > 30);
  const out = JSON.stringify(rows);
  for (const l of f.lanes) {
    assert.ok(!out.includes(l.title), l.title);
    assert.ok(!new RegExp(`\\b${l.id}\\b`).test(out), l.id);
  }
});

// Breaks if an empty board throws in tiles 8 to 10, or "No category yet" is missing from it.
test('tiles 8 to 10: an empty board gives words, not a throw', () => {
  const rows = buildTileRows({
    lanes: [], assignments: [], projects: [proj('unassigned', { status: 'no_end' })], targets: fixture().targets,
    meta: { ...META_BASE, history_start: null, open_check: 0, done_check: 0 }, snapshots: [],
  });
  assert.equal(text(rows, 'verdict.sentence'), 'No cards in this export.');
  assert.equal(text(rows, 'cat.row.1.name'), 'No category yet');
  assert.equal(text(rows, 'cat.row.1.closed'), '0 of 0 closed');
  assert.equal(text(rows, 'daily.row.7.label'), 'today so far');
});

// ---------------------------------------------------------------- goalOf (fleetops-category-expand)

test('goalOf: keeps only the sentence before " | "; the SHA and test counts after it never pass', () => {
  // Breaks if the cut at " | " goes: the rest of a lane note holds SHAs and test text.
  assert.equal(goalOf('GOAL: let Dave see the work. | NEXT: run 34/34 at abc1234 | MS: x.md'), 'let Dave see the work.');
});

test('goalOf: each stop word cuts, whichever comes first', () => {
  // Breaks if one stop word is dropped from the list, or the latest stop wins over the first.
  assert.equal(goalOf('GOAL: a b WAITS ON the seat'), 'a b');
  assert.equal(goalOf('GOAL: a b NEXT: tests'), 'a b');
  assert.equal(goalOf('GOAL: a b MS: C:/x.md'), 'a b');
  assert.equal(goalOf('GOAL: a NEXT b WAITS ON c | d'), 'a');
});

test('goalOf: "GOAL:" must start the note; later in the note it does not count', () => {
  // Breaks if the parser searches for GOAL: anywhere: an old note after "|| before:" would leak a stale goal.
  assert.equal(goalOf('Dave (kanban): moved || before: GOAL: old goal'), null);
  assert.equal(goalOf('  GOAL: spaced  '), 'spaced');
});

test('goalOf: a park note is cut through its first " || " as lane.mjs writes it', () => {
  // Breaks if only "PARKED until ... -- " is skipped: the park reason would come first and hide the GOAL.
  const note = 'PARKED until 2026-11-14 09:00 CST -- waits on Dave || GOAL: ship the expand rows. | NEXT: page';
  assert.equal(goalOf(note), 'ship the expand rows.');
  assert.equal(goalOf('PARKED until 2026-11-14 09:00 CST -- waits on Dave'), null);
});

test('goalOf: a session handle and a SHA inside the sentence are masked', () => {
  // Breaks if the handle rule or the 7 to 40 hex rule (seat word 10:51) goes.
  assert.equal(goalOf('GOAL: help #0f5ea433 land 71e3bc68 and 4c4b5eb5d1'), 'help #[handle] land [sha] and [sha]');
  // A word of only a to f letters, or only digits, is not a SHA.
  assert.equal(goalOf('GOAL: a faded 2026111 decade'), 'a faded 2026111 decade');
});

test('goalOf: a whole session uuid is masked, letters-only parts included (CodeRabbit CLI, pre-pr a325502)', () => {
  // Breaks if a uuid in the GOAL sentence reaches lanes.json: the handle rule needs "#", the SHA rule needs a digit.
  assert.equal(goalOf('GOAL: help aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee and b2b46d90-5361-424d-a80d-bfe4f49674e6 now'), 'help [id] and [id] now');
  assert.equal(goalOf('GOAL: ask #B2B46D90-5361-424D-A80D-BFE4F49674E6 first'), 'ask [id] first');
});

test('goalOf: ids joined to a word by "_" are still masked (CodeRabbit CLI, pre-pr 2efd658)', () => {
  // Breaks if the masks need a word boundary: "_" is a word character, so \b sees none before the id.
  assert.equal(goalOf('GOAL: inspect session_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee now'), 'inspect session_[id] now');
  assert.equal(goalOf('GOAL: land x_abc1234 and #0f5ea433_y'), 'land x_[sha] and #[handle]_y');
});

test('goalOf: the sentence ends at " || " (kanban and park keep the old note after it) (CodeRabbit CLI, pre-pr 2efd658)', () => {
  // Breaks if " || before: <old note>" stays in the goal: " || " holds no " | ".
  assert.equal(goalOf('GOAL: ship. || before: private old note'), 'ship.');
});

test('goalOf: a long sentence is cut at a word boundary with an ellipsis', () => {
  // Breaks if there is no cut (lanes.json size) or the cut splits a word.
  const g = goalOf(`GOAL: ${'word '.repeat(80)}`);
  assert.ok(g.length <= GOAL_MAX, String(g.length));
  assert.ok(g.endsWith('…'));
  assert.match(g.slice(0, -1), /\bword$/);
});

test('goalOf: no GOAL gives null, never the raw note', () => {
  // Breaks if a missing goal falls back to the note text.
  for (const n of [null, undefined, 42, '', 'just a status', 'GOAL:', 'GOAL:   | NEXT: x']) assert.equal(goalOf(n), null, String(n));
});

test('isParkedNote: true only for a note that starts with "PARKED until "', () => {
  // Breaks if a parked held lane reads as active work (seat word 10:51, item 6a).
  assert.equal(isParkedNote('PARKED until 2026-11-14 -- x || GOAL: y'), true);
  assert.equal(isParkedNote('GOAL: y | PARKED until later'), false);
  assert.equal(isParkedNote(null), false);
});

test('tile 9: each category row carries its project key; "No category yet" has key unassigned', () => {
  // Breaks if the page cannot find a row's cards in lanes.json (it filters on this key).
  const rows = catBuild();
  const f = { ...fixture(), ...catFixture() };
  const keys = categoryRows(f.projects, f.lanes, f.meta, f.targets ?? TARGETS).rows.map((r) => r.key);
  keys.forEach((k, i) => assert.equal(text(rows, `cat.row.${i + 1}.key`), k));
  assert.equal(text(rows, `cat.row.${keys.length}.key`), 'unassigned');
  assert.ok(keys.length >= 2);
});
