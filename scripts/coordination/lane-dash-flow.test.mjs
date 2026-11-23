/**
 * lane-dash-flow.test -- the Flow rows (flow.json) of the lane export. Phase A of the flow design.
 *
 *   node --test scripts/coordination/lane-dash-flow.test.mjs
 *
 * Pure: inline fixtures, no database, no file, no clock. The database oracles are in export-dash-data.db.test.mjs.
 * Design: .claudedocs/2026-11-09-lane-dash-flow-rows-design.md section 4.
 *
 * Ways buildFlowRows can fail (one test each, every test names the change that breaks it):
 *   F1  a claim and a reclaim of one lane on one day count twice, or a Dave placement counts as a claim
 *   F2  a lane with two done signals counts twice
 *   F3  a reopened, still-open lane is dropped from the rework numbers, or counts as a done day
 *   F4  a lane reopened twice counts twice (pairs instead of lanes)
 *   F5  a lane born done (no done_day) is given a done day
 *   F6  the median of an even count takes a middle value, not the mean of the two middle values
 *   F7  a done lane with no claim enters the median as 0 hours
 *   F8  a done time before the first claim enters the median as a negative number
 *   F9  a day is cut from the UTC date, or a null reopen time becomes a day (1969-12-31)
 *   F10 empty days are skipped, the grid is not 2 x window_days, or the history note shows when it should not
 *   F11 flow.today.* drifts from flow.bar.14.*, or the week figures drift from pile.* in tiles.json
 *   F12 a division by zero writes NaN, Infinity or a pct row when no lane is done
 *   F13 a row has the wrong columns, a duplicate id, a tone, a lane id, a title or a session handle
 *   F14 the function reads a clock
 * Added after the Fable review:
 *   M1  a label row is dropped, so the claim-events and claimed-lanes numbers look like a bug
 *   M2  rework.lanes counts a lane done before the week (the numerator is not a subset of the denominator, rate over 100%)
 *   L1a the week uses the 14-day grid   L1b the window is one day too long   L1c the median reads created_day
 *   L1d the median does not sort        L1e the percent loses its decimal    L1f the day uses a fixed UTC offset
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { buildFlowRows } from './lane-dash-flow.mjs';
import { buildTileRows, targetMap, TILE_COLUMNS } from './lane-dash-metrics.mjs';

const META = {
  exported_at: '2026-11-08T20:00:00.000Z', // 14:00 CST on 2026-11-08
  today: '2026-11-08',
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
const TARGETS = [{ key: 'window_days', value: 7 }];
// The grid for today 2026-11-08 and window_days 7: rank 1 = 2026-10-26 ... rank 14 = 2026-11-08. The week is ranks 8..14 (11-02 to 11-08).
const dayOfRank = (r) => new Date(Date.UTC(2026, 10, 8 + r - 14)).toISOString().slice(0, 10);

const lane = (o = {}) => ({
  id: 'l', title: 't', project: 'p', track: null, band: null, state: 'backlog', priority: null,
  created_at: '2026-11-01T12:00:00.000Z', created_day: '2026-11-01', first_claim_at: null, done_at: null,
  done_day: null, last_work_at: null, dave_ask_at: null, lease_expires_at: null, held: false,
  has_done_when: false, terminal: false, claims: 0, ...o,
});
/** A done lane. `claimH` hours of work: first claim at 10:00Z on `day`, done `claimH` hours later. */
const doneLane = (id, day, claimH, o = {}) => {
  const claim = Date.parse(`${day}T10:00:00.000Z`);
  return lane({
    id, state: 'done', created_day: day, done_day: day,
    first_claim_at: new Date(claim).toISOString(), done_at: new Date(claim + claimH * 3_600_000).toISOString(), ...o,
  });
};
const claim = (laneId, day, o = {}) => ({ at: `${day}T15:00:00.000Z`, day, lane_id: laneId, who: 'session', how: 'claim', reassigned: false, ...o });

function build(o = {}) {
  return buildFlowRows({
    lanes: [], assignments: [], rework: [], meta: META, targets: TARGETS, ...o,
  });
}
const get = (rows, id) => rows.find((r) => r.id === id);
const val = (rows, id) => get(rows, id)?.value;

test('F1: a claim and a reclaim of one lane on one day count once; a Dave placement is no claim; a second day counts again', () => {
  // Breaks if the function counts claim events instead of distinct lanes, or counts who = dave rows.
  const rows = build({
    assignments: [
      claim('a', '2026-11-08'), claim('a', '2026-11-08', { how: 'reclaim' }), claim('b', '2026-11-08'),
      claim('a', '2026-11-07'),
      { at: '2026-11-08T16:00:00.000Z', day: '2026-11-08', lane_id: 'c', who: 'dave', how: 'placed in Now', reassigned: false },
    ],
  });
  assert.equal(val(rows, 'flow.bar.14.claimed'), 2);
  assert.equal(val(rows, 'flow.bar.13.claimed'), 1);
  assert.equal(val(rows, 'flow.week.claimed'), 2, 'lane a on two days is one lane in the week');
  assert.equal(val(rows, 'flow.today.claimed'), 2);
});

test('F2: a lane with two done signals counts once, on its done day, in the done bar and in rework.done', () => {
  // Breaks if the bars or rework.done count signals (two) instead of lanes (one).
  const rows = build({
    lanes: [doneLane('a', '2026-11-06', 1)],
    rework: [
      { lane_id: 'a', done_at: '2026-11-05T15:00:00.000Z', reopen_at: null },
      { lane_id: 'a', done_at: '2026-11-06T15:00:00.000Z', reopen_at: null },
    ],
  });
  assert.equal(val(rows, 'flow.bar.12.done'), 1);
  assert.equal(val(rows, 'flow.bar.11.done'), 0);
  assert.equal(val(rows, 'flow.week.done'), 1);
  assert.equal(val(rows, 'flow.week.rework.done'), 1);
});

test('F3: a reopened, still-open lane is in rework.done, rework.lanes and the reopened bar, and in no done day', () => {
  // Breaks if the rework denominator is done_day (the lane has none) or the numerator ignores the reopen.
  const rows = build({
    lanes: [lane({ id: 'a', state: 'ready', created_day: '2026-11-01' })],
    rework: [{ lane_id: 'a', done_at: '2026-11-05T15:00:00.000Z', reopen_at: '2026-11-06T15:00:00.000Z' }],
  });
  assert.equal(val(rows, 'flow.week.done'), 0);
  assert.equal(val(rows, 'flow.week.rework.done'), 1);
  assert.equal(val(rows, 'flow.week.rework.lanes'), 1);
  assert.equal(val(rows, 'flow.week.rework.pct'), 100);
  assert.equal(get(rows, 'flow.week.rework.pct').text, '100.0%');
  assert.equal(val(rows, 'flow.bar.12.reopened'), 1); // 11-06
  assert.equal(val(rows, 'flow.bar.11.reopened'), 0);
  for (let r = 1; r <= 14; r++) assert.equal(val(rows, `flow.bar.${r}.done`), 0, `done bar ${r}`);
});

test('F4: a lane reopened twice counts once in rework.lanes and once on each reopen day', () => {
  // Breaks if the function counts pairs (two) instead of distinct lanes: the rate would be 200.0%.
  const rows = build({
    lanes: [lane({ id: 'a', state: 'ready' })],
    rework: [
      { lane_id: 'a', done_at: '2026-11-03T15:00:00.000Z', reopen_at: '2026-11-04T15:00:00.000Z' },
      { lane_id: 'a', done_at: '2026-11-05T15:00:00.000Z', reopen_at: '2026-11-06T15:00:00.000Z' },
    ],
  });
  assert.equal(val(rows, 'flow.week.rework.lanes'), 1);
  assert.equal(val(rows, 'flow.week.rework.done'), 1);
  assert.equal(get(rows, 'flow.week.rework.pct').text, '100.0%');
  assert.equal(val(rows, 'flow.bar.10.reopened'), 1); // 11-04
  assert.equal(val(rows, 'flow.bar.12.reopened'), 1); // 11-06
});

test('F5: a lane born done (state done, no done day) is on no done day and not in the week', () => {
  // Breaks if state = done alone gives a done day.
  const rows = build({ lanes: [lane({ id: 'born', state: 'done', created_day: '2026-11-07', done_at: null, done_day: null })] });
  for (let r = 1; r <= 14; r++) assert.equal(val(rows, `flow.bar.${r}.done`), 0);
  assert.equal(val(rows, 'flow.week.done'), 0);
  assert.equal(val(rows, 'flow.bar.13.created'), 1, 'it is still a created lane');
});

test('F6: the median of an even count is the mean of the two middle values; of an odd count, the middle', () => {
  // Breaks if the even median takes the lower or upper middle value.
  const even = build({ lanes: [1, 2, 3, 4].map((h, i) => doneLane(`e${i}`, '2026-11-05', h)) });
  assert.equal(val(even, 'flow.week.median_h'), 2.5);
  assert.equal(get(even, 'flow.week.median_h').text, '2.50 h');
  assert.equal(val(even, 'flow.week.median_n'), 4);
  const odd = build({ lanes: [1, 2, 4].map((h, i) => doneLane(`o${i}`, '2026-11-05', h)) });
  assert.equal(val(odd, 'flow.week.median_h'), 2);
  const rounded = build({ lanes: [doneLane('r', '2026-11-05', 1.2449)] });
  assert.equal(val(rounded, 'flow.week.median_h'), 1.24);
  assert.equal(get(rounded, 'flow.week.median_h').text, '1.24 h');
});

test('F6b: only lanes done inside the week are in the median', () => {
  // Breaks if the median reads every done lane (the 10-30 lane would pull it to 5 h).
  const rows = build({ lanes: [doneLane('in', '2026-11-05', 1), doneLane('old', '2026-10-30', 9)] });
  assert.equal(val(rows, 'flow.week.median_h'), 1);
  assert.equal(val(rows, 'flow.week.median_n'), 1);
});

test('F7: a done lane with no claim is counted as skipped, not as 0 hours in the median', () => {
  // Breaks if a null first_claim_at is coerced to 0 (the median would fall from 3 h to 2 h).
  const rows = build({ lanes: [doneLane('a', '2026-11-05', 3), doneLane('b', '2026-11-05', 3, { first_claim_at: null })] });
  assert.equal(val(rows, 'flow.week.done'), 2);
  assert.equal(val(rows, 'flow.week.median_h'), 3);
  assert.equal(val(rows, 'flow.week.median_n'), 1);
  assert.equal(val(rows, 'flow.week.median_skipped'), 1);
});

test('F8: a done time before the first claim is left out of the median and counted', () => {
  // Breaks if a negative duration enters the median; or the row is written when the count is 0.
  const neg = doneLane('neg', '2026-11-05', -2);
  const rows = build({ lanes: [doneLane('a', '2026-11-05', 4), neg] });
  assert.equal(val(rows, 'flow.week.median_h'), 4);
  assert.equal(val(rows, 'flow.week.median_n'), 1);
  assert.equal(val(rows, 'flow.week.median_negative'), 1);
  assert.equal(get(build({ lanes: [doneLane('a', '2026-11-05', 4)] }), 'flow.week.median_negative'), undefined);
  assert.equal(val(build({ lanes: [doneLane('z', '2026-11-05', 0)] }), 'flow.week.median_h'), 0, 'done at the claim instant is 0 h, not negative');
});

test('F9: a rework time at 23:30 CST lands on the Chicago day, and a null reopen time makes no day', () => {
  // Breaks if the day is cut from the ISO string (11-08) instead of Chicago (11-07), or null becomes 1969-12-31.
  const rows = build({
    rework: [
      { lane_id: 'a', done_at: '2026-11-08T05:30:00.000Z', reopen_at: '2026-11-08T05:45:00.000Z' }, // 23:30 and 23:45 CST on 11-07
      { lane_id: 'b', done_at: '2026-11-08T05:30:00.000Z', reopen_at: null },
    ],
  });
  assert.equal(val(rows, 'flow.bar.13.reopened'), 1); // 11-07
  assert.equal(val(rows, 'flow.bar.14.reopened'), 0);
  assert.equal(val(rows, 'flow.week.rework.done'), 2);
  assert.equal(val(rows, 'flow.week.rework.lanes'), 1);
  assert.equal(val(rows, 'flow.today.reopened'), 0);
});

test('F10: the grid has 2 x window_days zero-filled day rows, rank 14 = today; the history note only when history starts inside the grid', () => {
  // Breaks if empty days are skipped, the grid length is not 2 x window_days, or the note shows for early or equal history.
  const rows = build();
  assert.equal(val(rows, 'flow.days'), 14);
  const dayRows = rows.filter((r) => r.kind === 'day');
  assert.equal(dayRows.length, 14);
  assert.deepEqual(dayRows.map((r) => r.rank), Array.from({ length: 14 }, (_, i) => i + 1));
  assert.equal(get(rows, 'flow.day.1').text, 'Oct 26');
  assert.equal(get(rows, 'flow.day.14').text, 'today');
  for (let r = 1; r <= 14; r++) {
    for (const s of ['claimed', 'done', 'created', 'reopened']) assert.equal(val(rows, `flow.bar.${r}.${s}`), 0, `${s} ${r}`);
  }
  assert.equal(get(rows, 'flow.history_note').text, 'history from Oct 27'); // history starts after the first grid day (10-26)
  assert.equal(get(build({ meta: { ...META, history_start: '2026-10-26' } }), 'flow.history_note'), undefined);
  assert.equal(get(build({ meta: { ...META, history_start: '2026-10-01' } }), 'flow.history_note'), undefined);
  assert.equal(get(build({ meta: { ...META, history_start: null } }), 'flow.history_note'), undefined);
  // The grid follows window_days.
  const three = build({ targets: [{ key: 'window_days', value: 3 }] });
  assert.equal(val(three, 'flow.days'), 6);
  assert.equal(three.filter((r) => r.kind === 'day').length, 6);
  // Events outside the grid are ignored.
  const out = build({ lanes: [lane({ id: 'x', created_day: '2026-10-20' })], assignments: [claim('x', '2026-10-20')] });
  assert.equal(val(out, 'flow.week.created'), 0);
  assert.equal(val(out, 'flow.week.claimed'), 0);
  assert.equal(dayOfRank(1), '2026-10-26');
});

test('F11: flow.today.* equals flow.bar.14.*, flow.week.done and created equal pile.* in tiles.json, flow.week.net is opened minus done', () => {
  // Breaks if the day bars and the today figures, or the flow week and the pile tile, come from different computations.
  const lanes = [
    lane({ id: 'c1', created_day: '2026-11-08' }), lane({ id: 'c2', created_day: '2026-11-05' }), lane({ id: 'c3', created_day: '2026-10-28' }),
    doneLane('d1', '2026-11-08', 2), doneLane('d2', '2026-11-03', 1), doneLane('d3', '2026-10-30', 1),
    lane({ id: 'born', state: 'done', created_day: '2026-11-04' }),
  ];
  const assignments = [claim('c1', '2026-11-08'), claim('d1', '2026-11-08'), claim('d2', '2026-11-03')];
  const rework = [{ lane_id: 'd1', done_at: '2026-11-08T15:00:00.000Z', reopen_at: '2026-11-08T16:00:00.000Z' }];
  const rows = build({ lanes, assignments, rework });
  for (const s of ['claimed', 'done', 'reopened']) assert.equal(val(rows, `flow.today.${s}`), val(rows, `flow.bar.14.${s}`), s);
  assert.equal(val(rows, 'flow.today.done'), 1);
  const tiles = buildTileRows({ lanes, assignments, projects: [], targets: TARGETS, meta: META, snapshots: [] });
  const tget = (id) => tiles.find((r) => r.id === id).value;
  assert.equal(val(rows, 'flow.week.done'), tget('pile.done'));
  assert.equal(val(rows, 'flow.week.created'), tget('pile.created'));
  // pile.net is the open count change since card coord-fleetops-pile-figure; the flow week net stays opened minus done.
  // The born-done lane above is in opened and in neither the open count nor done, so the two differ by it (pile.line.gap says so).
  assert.equal(val(rows, 'flow.week.net'), tget('pile.created') - tget('pile.done'));
  assert.equal(tiles.find((r) => r.id === 'pile.line.gap').value, Math.abs(tget('pile.net') - val(rows, 'flow.week.net')));
});

test('F12: with no done lane there is no pct row and no median row, and a note says why', () => {
  // Breaks if 0 / 0 is written as NaN or Infinity, or the median of nothing is written.
  const rows = build({ lanes: [lane({ id: 'a' })] });
  assert.equal(get(rows, 'flow.week.rework.pct'), undefined);
  assert.equal(get(rows, 'flow.week.median_h'), undefined);
  assert.equal(get(rows, 'flow.week.rework.note').text, 'No lanes done in the last 7 days');
  assert.equal(val(rows, 'flow.week.rework.done'), 0);
  for (const r of rows) assert.ok(r.value === null || Number.isFinite(r.value), r.id);
  // With a done lane the note is absent and pct is present.
  const some = build({ lanes: [doneLane('a', '2026-11-05', 1)], rework: [{ lane_id: 'a', done_at: '2026-11-05T11:00:00.000Z', reopen_at: null }] });
  assert.equal(get(some, 'flow.week.rework.note'), undefined);
  assert.equal(get(some, 'flow.week.rework.pct').text, '0.0%');
});

test('F12b: the summary sentence carries the week figures and drops the clauses that do not apply', () => {
  // Breaks if the wording drifts from the design or a clause is written with 0 lanes behind it.
  const lanes = [doneLane('a', '2026-11-05', 1), doneLane('b', '2026-11-06', 2)];
  const full = build({
    lanes, assignments: [claim('a', '2026-11-05'), claim('b', '2026-11-06'), claim('c', '2026-11-07')],
    rework: [{ lane_id: 'a', done_at: '2026-11-05T11:00:00.000Z', reopen_at: null }, { lane_id: 'b', done_at: '2026-11-06T12:00:00.000Z', reopen_at: null }],
  });
  assert.equal(
    get(full, 'flow.summary').text,
    'In the 7 days to Nov 8, today so far, 3 lanes were claimed and 2 finished. Median claim to done 1.50 h over 2 lanes. 0 of 2 done lanes were reopened.',
  );
  assert.equal(get(build(), 'flow.summary').text, 'In the 7 days to Nov 8, today so far, 0 lanes were claimed and 0 finished.');
});

test('F13: every row has the 7 columns in order, tile "flow", a unique id, tone null, and no lane id, title or handle', () => {
  // Breaks if a lane id, a title or a session handle is written into text, a tone is set, or an id repeats.
  const lanes = [doneLane('secret-lane-77', '2026-11-05', 1, { title: 'SECRET title #abcdef12' }), lane({ id: 'secret-lane-88', title: 'SECRET2' })];
  const rows = build({
    lanes, assignments: [claim('secret-lane-77', '2026-11-05')],
    rework: [{ lane_id: 'secret-lane-77', done_at: '2026-11-05T11:00:00.000Z', reopen_at: '2026-11-06T11:00:00.000Z' }],
  });
  const ids = new Set();
  for (const r of rows) {
    assert.deepEqual(Object.keys(r), TILE_COLUMNS);
    assert.equal(r.tile, 'flow');
    assert.equal(r.tone, null, r.id);
    assert.ok(!ids.has(r.id), `duplicate id ${r.id}`);
    ids.add(r.id);
    assert.ok(['figure', 'text', 'day', 'bar'].includes(r.kind), r.kind);
    assert.ok(r.text === null || !/#[0-9a-f]{8}/i.test(r.text), r.id);
    assert.ok(r.value === null || Number.isFinite(r.value), r.id);
  }
  const all = JSON.stringify(rows);
  for (const s of ['secret-lane', 'SECRET', 'abcdef12']) assert.ok(!all.includes(s), `leaked ${s}`);
  for (const id of ['flow.week.claimed.label', 'flow.week.rework.done.label']) assert.ok(ids.has(id), `missing ${id}`);
  assert.ok(rows.length >= 14 * 5 + 10 && rows.length < 150, `row count ${rows.length}`);
});

test('F14: the function reads no clock (same rows under a 2030 clock)', () => {
  // Breaks if Date.now() or new Date() decides a day or an age instead of meta.today.
  const input = {
    lanes: [doneLane('a', '2026-11-05', 1)], assignments: [claim('a', '2026-11-05')],
    rework: [{ lane_id: 'a', done_at: '2026-11-05T11:00:00.000Z', reopen_at: '2026-11-06T11:00:00.000Z' }],
  };
  const before = build(input);
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-01T00:00:00Z') });
  let after;
  try {
    after = build(input);
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(after, before);
});

// ---------------------------------------------------------------- review fixes (Fable review of phase A)

test('M1: two label rows say what the claimed and rework figures count', () => {
  // Breaks if a label row is dropped or reworded: the 195 claim events on tile 7 and the 154 lanes here would look like a bug.
  const rows = build();
  assert.deepEqual(
    ['flow.week.claimed.label', 'flow.week.rework.done.label'].map((id) => [get(rows, id).kind, get(rows, id).value, get(rows, id).text]),
    [['text', null, 'lanes claimed, not claim events'], ['text', null, 'done lanes, including reopened']],
  );
});

test('M2: the rework numerator is a subset of the denominator: a lane done before the week and reopened inside it is not counted', () => {
  // Breaks if rework.lanes counts any lane with a reopen in the week (the px-2 shape): the rate could pass 100%.
  const rows = build({
    lanes: [doneLane('y', '2026-11-05', 1)],
    rework: [
      { lane_id: 'x', done_at: '2026-11-01T15:00:00.000Z', reopen_at: '2026-11-03T15:00:00.000Z' }, // done 11-01, before the week (11-02 to 11-08)
      { lane_id: 'y', done_at: '2026-11-05T15:00:00.000Z', reopen_at: null },
    ],
  });
  assert.equal(val(rows, 'flow.week.rework.done'), 1);
  assert.equal(val(rows, 'flow.week.rework.lanes'), 0);
  assert.equal(get(rows, 'flow.week.rework.pct').text, '0.0%');
  assert.equal(val(rows, 'flow.bar.9.reopened'), 1, 'the reopen is still a reopen on its day (11-03 is rank 9)');
  // Only reopens of lanes that were also done in the week can be counted, so the rate never passes 100%.
  const many = build({
    rework: [
      { lane_id: 'a', done_at: '2026-10-30T15:00:00.000Z', reopen_at: '2026-11-03T15:00:00.000Z' },
      { lane_id: 'b', done_at: '2026-10-30T15:00:00.000Z', reopen_at: '2026-11-04T15:00:00.000Z' },
      { lane_id: 'c', done_at: '2026-11-05T15:00:00.000Z', reopen_at: null },
    ],
  });
  assert.ok(val(many, 'flow.week.rework.pct') <= 100);
  assert.equal(val(many, 'flow.week.rework.lanes'), 0);
});

test('M2b: a lane done in the week and reopened later is counted, and the rate is lanes over done lanes', () => {
  // Breaks if the numerator drops a done-then-reopened lane, or the denominator is not distinct done lanes.
  const rows = build({
    rework: [
      { lane_id: 'a', done_at: '2026-11-05T15:00:00.000Z', reopen_at: '2026-11-06T15:00:00.000Z' },
      { lane_id: 'b', done_at: '2026-11-05T15:00:00.000Z', reopen_at: null },
    ],
  });
  assert.equal(val(rows, 'flow.week.rework.done'), 2);
  assert.equal(val(rows, 'flow.week.rework.lanes'), 1);
  assert.equal(get(rows, 'flow.week.rework.pct').text, '50.0%');
});

test('L1a: the week is the last 7 days, not the 14-day grid: claims, rework.done, rework.lanes stay out; the reopen shows on its bar', () => {
  // Breaks if weekLanes or reworkOf use the whole grid instead of the window.
  const rows = build({
    assignments: [claim('in', '2026-11-05'), claim('old', '2026-11-01')],
    rework: [{ lane_id: 'r', done_at: '2026-10-30T15:00:00.000Z', reopen_at: '2026-10-31T15:00:00.000Z' }],
  });
  assert.equal(val(rows, 'flow.week.claimed'), 1);
  assert.equal(val(rows, 'flow.week.rework.done'), 0);
  assert.equal(val(rows, 'flow.week.rework.lanes'), 0);
  assert.equal(val(rows, 'flow.bar.6.reopened'), 1); // 10-31 is rank 6 and is in the grid
  assert.equal(val(rows, 'flow.bar.7.claimed'), 1); // 11-01 is rank 7 and is in the grid
});

test('L1b: the week window is window_days long: a lane done 8 days ago is not in the week, one done 7 days ago is', () => {
  // Breaks if the window is widened by one day (windowOf with windowDays + 1).
  const rows = build({ lanes: [doneLane('a', '2026-11-01', 1), doneLane('b', '2026-11-02', 1)] });
  assert.equal(val(rows, 'flow.week.done'), 1);
  assert.equal(val(rows, 'flow.week.median_n'), 1);
  assert.equal(val(rows, 'flow.bar.7.done'), 1, 'the 11-01 lane is still on its bar');
});

test('L1c: the median reads the done day, not the created day', () => {
  // Breaks if medianOf filters on created_day: this lane was created 10-20, before the week.
  const rows = build({ lanes: [doneLane('x', '2026-11-05', 1, { created_day: '2026-10-20' })] });
  assert.equal(val(rows, 'flow.week.median_n'), 1);
  assert.equal(val(rows, 'flow.week.median_h'), 1);
});

test('L1d: the median sorts its values first (4, 1, 3, 2 hours give 2.5)', () => {
  // Breaks if the middle values are taken in input order.
  const rows = build({ lanes: [4, 1, 3, 2].map((h, i) => doneLane(`s${i}`, '2026-11-05', h)) });
  assert.equal(val(rows, 'flow.week.median_h'), 2.5);
});

test('L1e: the rate keeps one decimal (1 of 3 is 33.3%)', () => {
  // Breaks if the percent is rounded to a whole number.
  const rows = build({
    rework: [
      { lane_id: 'a', done_at: '2026-11-05T15:00:00.000Z', reopen_at: '2026-11-06T15:00:00.000Z' },
      { lane_id: 'b', done_at: '2026-11-05T15:00:00.000Z', reopen_at: null },
      { lane_id: 'c', done_at: '2026-11-05T15:00:00.000Z', reopen_at: null },
    ],
  });
  assert.equal(get(rows, 'flow.week.rework.pct').text, '33.3%');
  assert.equal(val(rows, 'flow.week.rework.pct'), 33.3);
});

test('L1f: a rework time lands on the Chicago day in daylight time (CDT, UTC-5), not on a fixed offset', () => {
  // Breaks if the day comes from a fixed UTC-6 offset: 00:30 CDT on 10-31 would land on 10-30.
  const rows = build({
    rework: [
      { lane_id: 'a', done_at: '2026-10-30T15:00:00.000Z', reopen_at: '2026-10-31T05:30:00.000Z' }, // 00:30 CDT on 10-31
      { lane_id: 'b', done_at: '2026-10-30T15:00:00.000Z', reopen_at: '2026-10-31T04:30:00.000Z' }, // 23:30 CDT on 10-30
    ],
  });
  assert.equal(val(rows, 'flow.bar.5.reopened'), 1); // 10-30
  assert.equal(val(rows, 'flow.bar.6.reopened'), 1); // 10-31
});

test('targets arrive as rows: targetMap is the same reader as tiles.json', () => {
  // Breaks if the function reads targets as an object and ignores the rows a document holds.
  assert.deepEqual(targetMap(TARGETS), { window_days: 7 });
  assert.equal(val(build({ targets: [] }), 'flow.days'), 14, 'no window_days target falls back to 7');
});
