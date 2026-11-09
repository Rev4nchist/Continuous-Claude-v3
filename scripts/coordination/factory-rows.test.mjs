/**
 * factory-rows.test -- the factory.json rows (Fleet app Flow tab, Phase B). Pure: inline fixtures, no file, no clock.
 *
 *   node --test scripts/coordination/factory-rows.test.mjs
 *
 * The reader tests are in export-factory-data.test.mjs. Design: .claudedocs/2026-11-09-factory-json-design.md section 8
 * (the numbers below are the design's test numbers; the mutation list M1..M7 is there too).
 *
 * Ways buildFactoryRows can fail (one test each, every test names the change that breaks it):
 *   1   empty days are skipped, or the grid is 7 days, or factory.today is not the last grid day
 *   2   a clock enters the pure module (source lint)
 *   3   a row has the wrong columns, a duplicate id, a tone, or a non-finite value
 *   4   any input string reaches a `text`
 *   5   first run is the first line seen, not the smallest run ts                       (mutation M1)
 *   5b  the empty head counts as a head
 *   6   a NOTE or SKIP row fails a run
 *   7   runs are counted per row
 *   8   a head is bucketed by a later run when its first run is before the grid
 *   9   an unknown status becomes text or an id
 *   10  the "N of 7 days" note is unconditional, or a day outside the week counts
 *   11  the today rows are missing
 *   12  an end row counts as a run, or notStarted is read                                (mutation M5)
 *   13  a free purpose string becomes a row id
 *   14  a quiet family is blanked, or as_of equals today
 *   15  the cap reads the total files, not PR files                                      (mutation M4)
 *   16  a row with no kind is not a PR row
 *   17  the month is not a calendar month
 *   18  a null cap is written as 0         18b a cap of 0 divides
 *   19  dollar sums drift in floating point
 *   20  a free outcome becomes an id        21  a future date lands on the grid        22  success_pct divides by 0
 *   23  a dark family writes zeros                                                       (mutation M3)
 *   24  bad_lines is not the count the reader passed
 *   25  the day is the ISO slice                                                         (mutation M2)
 *   26  the day uses a fixed UTC offset; DST vectors
 *   27  an invalid or future timestamp reaches the grid
 *   28  the summaries lose their fixed shape
 *   M6  the empty head counted as a head (5b)       M7  cap.pct written with cap 0 (18b)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildFactoryRows } from './factory-rows.mjs';
import { TILE_COLUMNS } from './lane-dash-metrics.mjs';

const TODAY = '2026-11-08';
const NOW = '2026-11-08T20:00:00.000Z'; // 14:00 CST
const TARGETS = [{ key: 'window_days', value: 7 }];
// Grid for today 2026-11-08, window 7: rank 1 = 10-26 ... rank 14 = 11-08. The week is ranks 8..14 (11-02 to 11-08).
const rankOf = (day, today = TODAY) => 14 - Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
const at = (day, time = '18:00:00') => `${day}T${time}.000Z`; // 12:00 or 13:00 Chicago time on `day`

const dark = { ok: false, reason: 'missing' };
const okFam = (rows, bad = 0) => ({ ok: true, rows, bad });
const build = (o = {}) => buildFactoryRows({
  today: TODAY, exportedAt: NOW, targets: TARGETS, cap: null, prpr: dark, rev: dark, coderabbit: dark, hand: dark, ...o,
});
const find = (rows, id) => rows.find((r) => r.id === id);
const val = (rows, id) => find(rows, id)?.value;
const txt = (rows, id) => find(rows, id)?.text;
const ids = (rows) => rows.map((r) => r.id);

const pr = (day, run, head, status, time) => ({ ts: at(day, time), run, head, status });
const start = (day, purpose = null, time) => ({ ts: at(day, time), phase: 'start', purpose, timedOut: false });
const end = (day, timedOut = false, time) => ({ ts: at(day, time), phase: 'end', purpose: null, timedOut });
const cr = (day, files, cost, kind = null) => ({ ts: at(day), kind, files, cost });
const hd = (date, outcome) => ({ date, outcome });

/** One input with every family readable, and hostile strings in every free field. */
function fullInput() {
  return {
    cap: 160,
    prpr: okFam([
      pr('2026-11-07', 'r1', 'h1', 'PASS'), pr('2026-11-07', 'r1', 'h1', 'NOTE'), pr('2026-11-08', 'r2', 'h1', 'FAIL'),
      pr('2026-11-08', 'r3', 'SECRET-head', 'SECRET-status'), pr('2026-11-08', 'r4', '', 'FAIL'),
    ], 1),
    rev: okFam([start('2026-11-04', 'review'), start('2026-11-04', 'SECRET-purpose'), start('2026-11-04'), end('2026-11-04', true)], 2),
    coderabbit: okFam([cr('2026-11-04', 4, 1), cr('2026-11-04', 2, 0.5, 'cli'), cr('2026-11-03', 1, 0.25, 'SECRET-kind')], 0),
    hand: okFam([hd('2026-11-08', 'SUCCEEDED'), hd('2026-11-07', 'PARTIAL_PLUS'), hd('2026-11-06', 'SECRET-outcome')], 3),
  };
}

// ---------------------------------------------------------------- shared rows

test('1 the grid is 14 ISO day rows, rank 14 is today, empty days stay', () => {
  // Breaks when empty days are skipped, the grid is 7 days, or factory.today is not the last grid day.
  const rows = build({ prpr: okFam([pr('2026-11-08', 'r1', 'h1', 'PASS')]) });
  assert.equal(val(rows, 'factory.days'), 14);
  const days = Array.from({ length: 14 }, (_, i) => find(rows, `factory.day.${i + 1}`));
  assert.ok(days.every(Boolean), 'all 14 day rows exist');
  assert.ok(days.every((d, i) => d.kind === 'day' && d.rank === i + 1 && d.value === null));
  assert.equal(days[0].text, '2026-10-26');
  assert.equal(days[13].text, TODAY);
  assert.equal(txt(rows, 'factory.today'), txt(rows, 'factory.day.14'));
  assert.equal(find(rows, 'factory.day.15'), undefined);
  for (let r = 1; r <= 14; r++) assert.equal(typeof val(rows, `prpr.bar.${r}.runs`), 'number', `bar ${r} exists with a real zero`);
});

test('1b window_days from the targets sets the grid (3 gives 6 days)', () => {
  // Breaks when the grid length is a constant 14.
  const rows = build({ targets: [{ key: 'window_days', value: 3 }], hand: okFam([hd('2026-11-08', 'SUCCEEDED')]) });
  assert.equal(val(rows, 'factory.days'), 6);
  assert.equal(txt(rows, 'factory.day.1'), '2026-11-03');
  assert.equal(find(rows, 'factory.day.7'), undefined);
  assert.equal(val(rows, 'hand.week.total'), 1);
});

test('2 the pure module has no clock (source lint)', () => {
  // Breaks when a clock call enters factory-rows.mjs. A fake-clock test passes on any pure function, so the source is read.
  const src = readFileSync(fileURLToPath(new URL('./factory-rows.mjs', import.meta.url)), 'utf8');
  assert.ok(!/Date\.now/.test(src), 'Date.now in factory-rows.mjs');
  assert.ok(!/new Date\(/.test(src), 'new Date( in factory-rows.mjs');
});

test('3 every row has the 7 columns in order, tile factory, unique id, tone null, finite or null value', () => {
  // Breaks when a row gains a column, a tone, a duplicate id or a NaN value.
  const rows = build(fullInput());
  assert.ok(rows.length > 150, `rows: ${rows.length}`);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r), TILE_COLUMNS, r.id);
    assert.equal(r.tile, 'factory');
    assert.equal(r.tone, null);
    assert.ok(['figure', 'text', 'day', 'bar'].includes(r.kind), `${r.id} kind ${r.kind}`);
    assert.ok(r.value === null || (typeof r.value === 'number' && Number.isFinite(r.value)), `${r.id} value`);
  }
  assert.equal(new Set(ids(rows)).size, rows.length, 'ids are unique');
});

const TEXT_OK = [
  /^\d{4}-\d{2}-\d{2}$/, // an ISO day
  /^\d+$/, /^\d+\.\d%$/, /^\$\d+\.\d{2}$/, /^\d+ files a month$/, /^\$\d+\.\d{2} per file$/, // number forms
  /^\d+ of \d+ days of data$/, /^no data: (missing|empty|corrupt|too large|reader error)$/, /^no data since [A-Z][a-z]{2} \d{1,2}$/,
  /^[A-Z][a-z]{2} \d{4}$/, // "Nov 2026"
  /^(Runs|Runs with a FAIL|FAIL rows|First runs|First-run pass|Review runs|CodeRabbit \$|Files|Succeeded|Partial plus|Partial minus|Failed|Other)$/,
  /^no writer yet$/,
  /^repo cap: review-router\.config\.json coderabbit\.monthly_file_cap, PR rows only$/,
  /^paid rounds only; a review on a free slot is not in the ledger$/,
  /^In the \d+ days to [A-Z][a-z]{2} \d{1,2}, today so far, \d+ pre-PR runs?, \d+ with a FAIL\.( First-run pass \d+ of \d+ heads? \(\d+\.\d%\)\.)?( \d+ of \d+ days of data\.)?$/,
  /^\d+ review runs? in the \d+ days to [A-Z][a-z]{2} \d{1,2}\.( Last run [A-Z][a-z]{2} \d{1,2}\.)?( \d+ runs? since [A-Z][a-z]{2} \d{1,2}\.)?$/,
  /^CodeRabbit: \$\d+\.\d{2} today, \$\d+\.\d{2} this week, \$\d+\.\d{2} in [A-Z][a-z]{2} \d{4} \(\$\d+\.\d{2} on PRs, \d+( of \d+)? files\)\.( Last paid run [A-Z][a-z]{2} \d{1,2}\.)?$/,
  /^\d+ handoffs? in the \d+ days to [A-Z][a-z]{2} \d{1,2}, \d+ succeeded( \(\d+\.\d%\))?\. \d+ today\.$/,
];

test('4 every text is a day, a number, a fixed word or a fixed sentence; no input string reaches a text or an id', () => {
  // Breaks when any input string (status, purpose, kind, outcome, head, run) is copied into a row.
  for (const input of [fullInput(), { ...fullInput(), cap: null }, { ...fullInput(), cap: 0 }, {}]) {
    for (const r of build(input)) {
      if (r.text === null) continue;
      assert.ok(TEXT_OK.some((re) => re.test(r.text)), `${r.id}: unexpected text ${JSON.stringify(r.text)}`);
      assert.ok(!/SECRET/i.test(r.id + r.text), r.id);
    }
  }
});

// ---------------------------------------------------------------- prpr

test('5 two runs of one head, the later one first in the input: first-run pass looks at the earlier run (M1)', () => {
  // Breaks when "first run" is the first line seen instead of the smallest run ts.
  const rows = build({ prpr: okFam([
    pr('2026-11-07', 'b', 'h1', 'PASS'), pr('2026-11-07', 'b', 'h1', 'PASS'),
    pr('2026-11-06', 'a', 'h1', 'FAIL'), pr('2026-11-06', 'a', 'h1', 'PASS'),
  ]) });
  assert.equal(val(rows, `prpr.bar.${rankOf('2026-11-06')}.heads`), 1);
  assert.equal(val(rows, `prpr.bar.${rankOf('2026-11-06')}.first_pass`), 0);
  assert.equal(val(rows, `prpr.bar.${rankOf('2026-11-07')}.heads`), 0);
  assert.equal(val(rows, 'prpr.week.heads'), 1);
  assert.equal(val(rows, 'prpr.week.first_pass'), 0);
  assert.equal(txt(rows, 'prpr.week.first_pass_pct'), '0.0%');
  assert.equal(val(rows, 'prpr.week.runs'), 2);
});

test('5b two runs with head "": 2 runs, 1 fail run, 0 heads, 0 first-run passes (M6)', () => {
  // Breaks when the empty head counts as one head that absorbs every headless run.
  const rows = build({ prpr: okFam([pr('2026-11-08', 'a', '', 'FAIL'), pr('2026-11-08', 'b', '', 'PASS')]) });
  assert.equal(val(rows, 'prpr.week.runs'), 2);
  assert.equal(val(rows, 'prpr.week.fail_runs'), 1);
  assert.equal(val(rows, 'prpr.week.heads'), 0);
  assert.equal(val(rows, 'prpr.week.first_pass'), 0);
  assert.equal(find(rows, 'prpr.week.first_pass_pct'), undefined, 'no pct over 0 heads');
  assert.equal(find(rows, 'prpr.today.first_pass_pct'), undefined);
});

test('6 a run with NOTE and SKIP rows and no FAIL passes', () => {
  // Breaks when NOTE or SKIP fails a run.
  const rows = build({ prpr: okFam([pr('2026-11-08', 'a', 'h1', 'PASS'), pr('2026-11-08', 'a', 'h1', 'NOTE'), pr('2026-11-08', 'a', 'h1', 'SKIP')]) });
  assert.equal(val(rows, 'prpr.week.fail_runs'), 0);
  assert.equal(val(rows, 'prpr.week.first_pass'), 1);
  assert.equal(val(rows, 'prpr.week.status.note'), 1);
  assert.equal(val(rows, 'prpr.week.status.skip'), 1);
  assert.equal(val(rows, 'prpr.week.status.pass'), 1);
  assert.equal(val(rows, 'prpr.week.status.fail'), 0);
});

test('7 a run with one FAIL among 20 PASS fails once', () => {
  // Breaks when runs are counted per row (fail_runs 1 becomes 21 runs).
  const rows = [pr('2026-11-08', 'a', 'h1', 'FAIL'), ...Array.from({ length: 20 }, () => pr('2026-11-08', 'a', 'h1', 'PASS'))];
  const out = build({ prpr: okFam(rows) });
  assert.equal(val(out, 'prpr.week.runs'), 1);
  assert.equal(val(out, 'prpr.week.fail_runs'), 1);
  assert.equal(val(out, 'prpr.bar.14.fail_rows'), 1);
  assert.equal(val(out, 'prpr.week.status.pass'), 20);
  assert.equal(txt(out, 'prpr.week.fail_share_pct'), '100.0%');
});

test('8 a head whose first run is before the grid is not in the grid, its later run is a run', () => {
  // Breaks when heads are bucketed by any run instead of the first run.
  const rows = build({ prpr: okFam([pr('2026-10-20', 'a', 'h1', 'PASS'), pr('2026-11-05', 'b', 'h1', 'PASS')]) });
  assert.equal(val(rows, 'prpr.week.heads'), 0);
  assert.equal(val(rows, 'prpr.week.runs'), 1);
  for (let r = 1; r <= 14; r++) assert.equal(val(rows, `prpr.bar.${r}.heads`), 0, `bar ${r}`);
});

test('9 a status outside the list counts in status.other and never appears as text', () => {
  // Breaks when a free status becomes a row id or a text.
  const rows = build({ prpr: okFam([pr('2026-11-08', 'a', 'h1', 'PASS'), pr('2026-11-08', 'a', 'h1', 'SECRET'), pr('2026-11-08', 'a', 'h1', 'pass')]) });
  assert.equal(val(rows, 'prpr.week.status.other'), 2);
  assert.equal(val(rows, 'prpr.week.status.pass'), 1);
  assert.ok(!JSON.stringify(rows).includes('SECRET'));
});

test('10 days_of_data and its note: 2 of 7 days; no note with 7 of 7; a day outside the week does not count', () => {
  // Breaks when the note is unconditional, or days before the week count as days of data.
  const two = build({ prpr: okFam([pr('2026-11-07', 'a', 'h1', 'PASS'), pr('2026-11-08', 'b', 'h2', 'PASS'), pr('2026-11-01', 'c', 'h3', 'PASS')]) });
  assert.equal(val(two, 'prpr.week.days_of_data'), 2);
  assert.equal(txt(two, 'prpr.week.days_note'), '2 of 7 days of data');
  const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];
  const seven = build({ prpr: okFam(days.map((d, i) => pr(d, `r${i}`, `h${i}`, 'PASS'))) });
  assert.equal(val(seven, 'prpr.week.days_of_data'), 7);
  assert.equal(find(seven, 'prpr.week.days_note'), undefined);
  assert.equal(val(seven, 'prpr.week.runs'), 7);
});

test('11 the today rows and the bar.14 rows both exist (schema only)', () => {
  // Breaks when a today row is dropped. An equality check would restate the code: both come from one variable.
  const rows = build({ prpr: okFam([pr('2026-11-08', 'a', 'h1', 'PASS')]), rev: okFam([start('2026-11-08')]), coderabbit: okFam([cr('2026-11-08', 1, 0.25)]), hand: okFam([hd('2026-11-08', 'FAILED')]) });
  for (const id of ['prpr.today.runs', 'prpr.bar.14.runs', 'prpr.today.fail_runs', 'prpr.bar.14.fail_runs', 'prpr.today.first_pass_pct',
    'rev.today.runs', 'rev.bar.14.runs', 'rev.coderabbit.today.usd', 'rev.coderabbit.bar.14.usd', 'hand.today.total', 'hand.bar.14.failed']) {
    assert.ok(find(rows, id), id);
  }
  assert.equal(val(rows, 'prpr.today.runs'), 1);
  assert.equal(val(rows, 'hand.today.total'), 1);
});

test('11b prpr family rows: rows, bad_lines, as_of, first_day, the quiet note, and the prs placeholder', () => {
  // Breaks when a status row is left out, or the note shows for a family that wrote today.
  const live = build({ prpr: okFam([pr('2026-11-07', 'a', 'h1', 'PASS'), pr('2026-11-08', 'b', 'h2', 'PASS')], 4) });
  assert.equal(val(live, 'prpr.rows'), 2);
  assert.equal(val(live, 'prpr.bad_lines'), 4);
  assert.equal(txt(live, 'prpr.as_of'), '2026-11-08');
  assert.equal(txt(live, 'prpr.first_day'), '2026-11-07');
  assert.equal(find(live, 'prpr.note'), undefined);
  assert.equal(txt(live, 'prpr.prs.note'), 'no writer yet');
  const quiet = build({ prpr: okFam([pr('2026-11-07', 'a', 'h1', 'PASS')]) });
  assert.equal(txt(quiet, 'prpr.note'), 'no data since Nov 7');
});

// ---------------------------------------------------------------- rev

test('12 only start rows are runs; an end row counts in timed_out only (M5)', () => {
  // Breaks when end rows are counted as runs (3 would read 6).
  const rows = build({ rev: okFam([
    start('2026-11-08'), start('2026-11-08'), start('2026-11-07'),
    end('2026-11-08', true), end('2026-11-08', false), end('2026-11-07', false),
    end('2026-10-20', true), // a timed-out end row outside the week must not count in rev.week.timed_out
  ]) });
  assert.equal(val(rows, 'rev.week.runs'), 3);
  assert.equal(val(rows, 'rev.all.runs'), 3);
  assert.equal(val(rows, 'rev.week.timed_out'), 1);
  assert.equal(val(rows, 'rev.bar.14.runs'), 2);
  assert.equal(val(rows, 'rev.bar.13.runs'), 1);
  assert.equal(val(rows, 'rev.rows'), 7);
});

test('13 purpose: none is unknown, verify is kept, an unlisted word is other, and no free string is an id', () => {
  // Breaks when a free string becomes a row id.
  const rows = build({ rev: okFam([
    start('2026-11-08', null), start('2026-11-08', 'verify'), start('2026-11-08', 'eval-netprobe'), start('2026-11-08', 'SECRET'),
    start('2026-11-08', 'review'), start('2026-11-08', 'bench'), start('2026-11-08', 'eval'),
  ]) });
  const want = { review: 1, bench: 1, eval: 1, other: 2, verify: 1, unknown: 1 };
  for (const [p, n] of Object.entries(want)) {
    assert.equal(val(rows, `rev.week.purpose.${p}`), n, p);
    assert.equal(val(rows, `rev.today.purpose.${p}`), n, `today ${p}`);
  }
  assert.equal(ids(rows).filter((id) => id.startsWith('rev.week.purpose.')).length, 6);
  assert.ok(!ids(rows).some((id) => /netprobe|SECRET/.test(id)));
});

test('14 a quiet review ledger: as_of Nov 4, the note, and real zeros after it', () => {
  // Breaks when a stale family is blanked, or the note shows when as_of equals today.
  const rows = build({ rev: okFam([start('2026-11-03'), start('2026-11-04')]) });
  assert.equal(txt(rows, 'rev.as_of'), '2026-11-04');
  assert.equal(txt(rows, 'rev.note'), 'no data since Nov 4');
  for (const r of [11, 12, 13, 14]) assert.strictEqual(val(rows, `rev.bar.${r}.runs`), 0, `rank ${r} is a real zero`);
  assert.equal(val(rows, 'rev.bar.10.runs'), 1);
  assert.equal(val(rows, 'rev.today.runs'), 0);
  assert.equal(val(rows, 'rev.week.runs'), 2);
  assert.equal(txt(rows, 'rev.first_day'), '2026-11-03');
  const live = build({ rev: okFam([start('2026-11-08')]) });
  assert.equal(find(live, 'rev.note'), undefined);
  assert.equal(txt(live, 'rev.as_of'), '2026-11-08');
});

// ---------------------------------------------------------------- coderabbit

test('15 one PR row and one CLI row on one day: the bars sum both, the month splits them, cap.pct reads PR files (M4)', () => {
  // Breaks when the cap reads total files (6 of 160 is 3.8%, not 2.5%).
  const rows = build({ cap: 160, coderabbit: okFam([cr('2026-11-05', 4, 1), cr('2026-11-05', 2, 0.5, 'cli')]) });
  const r = rankOf('2026-11-05');
  assert.equal(val(rows, `rev.coderabbit.bar.${r}.files`), 6);
  assert.equal(val(rows, `rev.coderabbit.bar.${r}.usd`), 1.5);
  assert.equal(val(rows, 'rev.coderabbit.month.pr.files'), 4);
  assert.equal(val(rows, 'rev.coderabbit.month.pr.usd'), 1);
  assert.equal(val(rows, 'rev.coderabbit.month.cli.files'), 2);
  assert.equal(val(rows, 'rev.coderabbit.month.cli.usd'), 0.5);
  assert.equal(txt(rows, 'rev.coderabbit.month.usd'), '$1.50');
  assert.equal(txt(rows, 'rev.coderabbit.month.cap.pct'), '2.5%');
  assert.equal(txt(rows, 'rev.coderabbit.month.cap.files'), '160 files a month');
  assert.equal(val(rows, 'rev.coderabbit.month.cap.files'), 160);
  assert.equal(txt(rows, 'rev.coderabbit.month.cap.usd'), '$40.00');
  assert.equal(txt(rows, 'rev.coderabbit.price_per_file'), '$0.25 per file');
  assert.equal(val(rows, 'rev.coderabbit.price_per_file'), 0.25);
  assert.ok(find(rows, 'rev.coderabbit.month.cap.source'));
  assert.ok(find(rows, 'rev.coderabbit.floor_note'));
});

test('16 a row with no kind is a PR row; an unknown kind is neither PR nor CLI but is in the month total', () => {
  // Breaks when a missing kind becomes "other".
  const rows = build({ coderabbit: okFam([cr('2026-11-05', 3, 0.75, null), cr('2026-11-05', 1, 0.25, 'weird')]) });
  assert.equal(val(rows, 'rev.coderabbit.month.pr.files'), 3);
  assert.equal(val(rows, 'rev.coderabbit.month.cli.files'), 0);
  assert.equal(txt(rows, 'rev.coderabbit.month.usd'), '$1.00');
});

test('17 an October row is out of the November month, and inside the grid and out of the week', () => {
  // Breaks when the month is a 30-day window instead of a calendar month.
  const rows = build({ coderabbit: okFam([cr('2026-10-28', 52, 13), cr('2026-11-02', 1, 0.25)]) });
  assert.equal(txt(rows, 'rev.coderabbit.month.label'), 'Nov 2026');
  assert.equal(val(rows, 'rev.coderabbit.month.pr.files'), 1);
  assert.equal(txt(rows, 'rev.coderabbit.month.usd'), '$0.25');
  assert.equal(val(rows, `rev.coderabbit.bar.${rankOf('2026-10-28')}.usd`), 13);
  assert.equal(txt(rows, 'rev.coderabbit.week.usd'), '$0.25');
  assert.equal(val(rows, 'rev.coderabbit.week.files'), 1);
});

test('18 with cap null there are no cap rows and no 0', () => {
  // Breaks when a missing cap is written as 0.
  const rows = build({ cap: null, coderabbit: okFam([cr('2026-11-05', 4, 1)]) });
  for (const k of ['files', 'pct', 'usd', 'source']) assert.equal(find(rows, `rev.coderabbit.month.cap.${k}`), undefined, k);
  assert.ok(find(rows, 'rev.coderabbit.price_per_file'));
  assert.ok(find(rows, 'rev.coderabbit.month.pr.files'));
});

test('18b with cap 0 and 117 PR files: cap.files 0, cap.usd $0.00, no cap.pct (M7)', () => {
  // Breaks when the division runs (the value turns null and the text a non-number).
  const rows = build({ cap: 0, coderabbit: okFam([cr('2026-11-05', 117, 29.25)]) });
  assert.equal(val(rows, 'rev.coderabbit.month.cap.files'), 0);
  assert.equal(txt(rows, 'rev.coderabbit.month.cap.usd'), '$0.00');
  assert.equal(find(rows, 'rev.coderabbit.month.cap.pct'), undefined);
  assert.ok(!JSON.stringify(rows).match(/Infinity|NaN/));
});

test('19 dollar sums keep cents: 4.25 + 0.50 is $4.75, 0.1 + 0.2 is exactly 0.3', () => {
  // Breaks on float drift (the sum must run in cents).
  const a = build({ coderabbit: okFam([cr('2026-11-05', 1, 4.25), cr('2026-11-05', 1, 0.5)]) });
  assert.equal(txt(a, 'rev.coderabbit.month.usd'), '$4.75');
  assert.equal(val(a, 'rev.coderabbit.month.usd'), 4.75);
  const b = build({ coderabbit: okFam([cr('2026-11-05', 1, 0.1), cr('2026-11-05', 1, 0.2)]) });
  assert.strictEqual(val(b, 'rev.coderabbit.month.usd'), 0.3);
  assert.strictEqual(val(b, `rev.coderabbit.bar.${rankOf('2026-11-05')}.usd`), 0.3);
});

// ---------------------------------------------------------------- hand

test('20 an outcome outside the four goes to other and never becomes an id or a text', () => {
  // Breaks when a free outcome becomes an id.
  const rows = build({ hand: okFam([hd('2026-11-08', 'SUCCEEDED'), hd('2026-11-08', 'PARTIAL_PLUS'), hd('2026-11-08', 'PARTIAL_MINUS'), hd('2026-11-08', 'FAILED'), hd('2026-11-08', 'SECRET'), hd('2026-11-08', 'succeeded')]) });
  assert.equal(val(rows, 'hand.week.total'), 6);
  for (const [o, n] of Object.entries({ succeeded: 1, partial_plus: 1, partial_minus: 1, failed: 1, other: 2 })) {
    assert.equal(val(rows, `hand.week.${o}`), n, o);
    assert.equal(val(rows, `hand.bar.14.${o}`), n, `bar ${o}`);
  }
  assert.equal(val(rows, 'hand.today.total'), 6);
  assert.ok(!JSON.stringify(rows).includes('SECRET'));
});

test('21 a date after today is a bad file, not a grid rank', () => {
  // Breaks when a future date lands on a grid rank over 14 or in the week total.
  const rows = build({ hand: okFam([hd('2026-11-08', 'SUCCEEDED'), hd('2026-11-09', 'SUCCEEDED'), hd('2030-01-01', 'FAILED')], 1) });
  assert.equal(val(rows, 'hand.week.total'), 1);
  assert.equal(val(rows, 'hand.bad_lines'), 3);
  assert.equal(txt(rows, 'hand.as_of'), '2026-11-08');
  assert.equal(find(rows, 'hand.bar.15.succeeded'), undefined);
  assert.equal(val(rows, 'hand.rows'), 1);
});

test('22 success_pct is left out when the week total is 0, and is a one-decimal percent otherwise', () => {
  // Breaks when the division runs on 0.
  const none = build({ hand: okFam([hd('2026-10-26', 'SUCCEEDED')]) });
  assert.equal(val(none, 'hand.week.total'), 0);
  assert.equal(find(none, 'hand.week.success_pct'), undefined);
  assert.equal(txt(none, 'hand.first_day'), '2026-10-26');
  const some = build({ hand: okFam([hd('2026-11-08', 'SUCCEEDED'), hd('2026-11-07', 'SUCCEEDED'), hd('2026-11-06', 'PARTIAL_PLUS')]) });
  assert.equal(txt(some, 'hand.week.success_pct'), '66.7%');
  assert.equal(val(some, 'hand.week.success_pct'), 66.7);
});

// ---------------------------------------------------------------- failure policy

test('23 a dark family gives one note row and no other row of its own, never a zero (M3)', () => {
  // Breaks when a dark family writes zeros instead of a note.
  const own = {
    prpr: (id) => id.startsWith('prpr.') && !id.startsWith('prpr.prs.'),
    rev: (id) => id.startsWith('rev.') && !id.startsWith('rev.coderabbit.'),
    coderabbit: (id) => id.startsWith('rev.coderabbit.'),
    hand: (id) => id.startsWith('hand.'),
  };
  const noteId = { prpr: 'prpr.note', rev: 'rev.note', coderabbit: 'rev.coderabbit.note', hand: 'hand.note' };
  const live = fullInput();
  for (const fam of Object.keys(own)) {
    for (const reason of ['missing', 'empty', 'corrupt', 'too large', 'reader error']) {
      const rows = build({ ...live, [fam]: { ok: false, reason } });
      const mine = rows.filter((r) => own[fam](r.id));
      assert.deepEqual(mine.map((r) => r.id), [noteId[fam]], `${fam}/${reason}`);
      assert.equal(mine[0].text, `no data: ${reason}`);
      assert.equal(mine[0].value, null);
    }
    const others = Object.keys(own).filter((f) => f !== fam);
    const rows = build({ ...live, [fam]: dark });
    for (const o of others) assert.ok(rows.some((r) => own[o](r.id) && r.kind === 'bar'), `${o} still has rows when ${fam} is dark`);
  }
});

test('24 bad_lines is the count the reader passed, for every family', () => {
  // Breaks when the figure is recomputed or dropped.
  const rows = build({
    prpr: okFam([pr('2026-11-08', 'a', 'h', 'PASS')], 7), rev: okFam([start('2026-11-08')], 5),
    coderabbit: okFam([cr('2026-11-08', 1, 0.25)], 3), hand: okFam([hd('2026-11-08', 'FAILED')], 9),
  });
  assert.equal(val(rows, 'prpr.bad_lines'), 7);
  assert.equal(val(rows, 'rev.bad_lines'), 5);
  assert.equal(val(rows, 'rev.coderabbit.bad_lines'), 3);
  assert.equal(val(rows, 'hand.bad_lines'), 9);
  assert.equal(txt(rows, 'prpr.bad_lines'), '7');
});

// ---------------------------------------------------------------- day bucket

const runOn = (ts, run = 'a') => ({ ts, run, head: `h${run}`, status: 'PASS' });

test('25 23:30 CST on 11-07 (05:30Z on 11-08) lands on 11-07, not 11-08 (M2)', () => {
  // Breaks when the day is the ISO slice of the timestamp.
  const rows = build({ prpr: okFam([runOn('2026-11-08T05:30:00.000Z')]) });
  assert.equal(val(rows, 'prpr.bar.13.runs'), 1);
  assert.equal(val(rows, 'prpr.bar.14.runs'), 0);
  assert.equal(txt(rows, 'prpr.first_day'), '2026-11-07');
});

test('26 DST vectors: both 01:30 instants of 11-01 are 11-01; 04:59Z is 10-31; 05:30Z on 10-31 is 10-31', () => {
  // Breaks on a fixed UTC-6 or UTC-5 offset, or a slice.
  const rows = build({ prpr: okFam([
    runOn('2026-11-01T06:30:00.000Z', 'a'), runOn('2026-11-01T07:30:00.000Z', 'b'), // 01:30 CDT and 01:30 CST
    runOn('2026-11-01T04:59:00.000Z', 'c'), // 23:59 CDT on 10-31
    runOn('2026-10-31T05:30:00.000Z', 'd'), // 00:30 CDT on 10-31
  ]) });
  assert.equal(val(rows, `prpr.bar.${rankOf('2026-11-01')}.runs`), 2);
  assert.equal(val(rows, `prpr.bar.${rankOf('2026-10-31')}.runs`), 2);
  assert.equal(val(rows, `prpr.bar.${rankOf('2026-10-30')}.runs`), 0);
});

test('26b spring forward: 08:30Z on 2026-03-08 is 03:30 CDT, day 03-08', () => {
  // Breaks when the grid or the day shifts across the spring change.
  const today = '2026-03-10';
  const rows = build({ today, exportedAt: '2026-03-10T18:00:00.000Z', prpr: okFam([runOn('2026-03-08T08:30:00.000Z'), runOn('2026-03-08T07:30:00.000Z', 'b')]) });
  assert.equal(val(rows, `prpr.bar.${rankOf('2026-03-08', today)}.runs`), 2);
  assert.equal(txt(rows, `factory.day.${rankOf('2026-03-08', today)}`), '2026-03-08');
  assert.equal(txt(rows, 'factory.day.1'), '2026-02-25');
});

test('27 a row with an unparseable ts, or a ts after exportedAt, never reaches the grid', () => {
  // Breaks when an invalid ts throws RangeError in the day function, or a future row is counted.
  const rows = build({ prpr: okFam([runOn('not a time', 'a'), runOn('2031-01-01T00:00:00.000Z', 'b'), runOn('2026-11-08T18:00:00.000Z', 'c')]) });
  assert.equal(val(rows, 'prpr.week.runs'), 1);
  assert.equal(val(rows, 'prpr.rows'), 1);
  assert.equal(val(rows, 'prpr.bad_lines'), 2);
});

// ---------------------------------------------------------------- summaries

test('28 the four summaries read as the design says', () => {
  // Breaks when a summary loses its fixed shape (the Fleet app shows these sentences as they are).
  const rows = build({
    cap: 160,
    prpr: okFam([pr('2026-11-07', 'a', 'h1', 'FAIL'), pr('2026-11-08', 'b', 'h2', 'PASS')]),
    rev: okFam([start('2026-11-01'), start('2026-11-04')]),
    coderabbit: okFam([cr('2026-11-04', 4, 1)]),
    hand: okFam([hd('2026-11-08', 'SUCCEEDED'), hd('2026-11-08', 'FAILED')]),
  });
  assert.equal(txt(rows, 'prpr.summary'), 'In the 7 days to Nov 8, today so far, 2 pre-PR runs, 1 with a FAIL. First-run pass 1 of 2 heads (50.0%). 2 of 7 days of data.');
  assert.equal(txt(rows, 'rev.summary'), '1 review run in the 7 days to Nov 8. Last run Nov 4. 2 runs since Nov 1.');
  assert.equal(txt(rows, 'rev.coderabbit.summary'), 'CodeRabbit: $0.00 today, $1.00 this week, $1.00 in Nov 2026 ($1.00 on PRs, 4 of 160 files). Last paid run Nov 4.');
  assert.equal(txt(rows, 'hand.summary'), '2 handoffs in the 7 days to Nov 8, 1 succeeded (50.0%). 2 today.');
});
