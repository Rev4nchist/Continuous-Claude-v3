/**
 * board-done-view.test -- the pure helpers behind the Done column of the phone page.
 *
 * Dates are built with local constructors, so the tests pass in any timezone.
 *
 * How they can fail, one test each:
 *   - a lane done 7 days and 1 hour ago shows, or one done 6 days 23 hours ago is hidden
 *   - a lane done at exactly now minus 7 days shows (the window is open at its old end)
 *   - the cap of 30 hides the count: inWindow must still say how many lanes are in the 7 days
 *   - the order follows updated_at (a note after the done event moves the lane up) and not the done event
 *   - a lane with no done event has no time at all instead of falling back to updated_at
 *   - a future time sorts above everything and prints a future day; an invalid time throws or shows "Invalid Date"
 *   - the day label is wrong around local midnight, or prints a UTC day
 *   - two lanes done at the same moment come out in an order that changes between renders
 *   - an open lane is listed
 *   - a cut note ends in half an emoji (a lone surrogate), or an emoji-only note of 240 characters is cut
 *   - the SQL that finds the done time reads only the lane 'done' event and misses the kanban sync's event
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DONE_NOTE_MAX, DONE_SQL, clockText, cutNote, dayLabel, pickDone } from './board-done-view.mjs';

const NOW = new Date(2026, 10, 7, 15, 0, 0); // Sat Nov 7 2026, 3:00 PM local
const H = 3600 * 1000;
const ago = (ms) => new Date(NOW.getTime() - ms);
const done = (id, updated = NOW, extra = {}) => ({ id, state: 'done', updated_at: updated, ...extra });
const ids = (r) => r.shown.map((e) => e.lane.id);

describe('pickDone window', () => {
  it('hides a lane done 7 days and 1 hour ago and shows one done 6 days and 23 hours ago', () => {
    const lanes = [done('old'), done('new')];
    const at = new Map([['old', ago(7 * 24 * H + H)], ['new', ago(6 * 24 * H + 23 * H)]]);
    const r = pickDone(lanes, at, NOW);
    assert.deepEqual(ids(r), ['new']);
    assert.equal(r.inWindow, 1);
    assert.equal(r.total, 2);
  });

  it('hides a lane done at exactly now minus 7 days and shows one done a millisecond later', () => {
    const edge = new Date(NOW.getTime() - 7 * 24 * H);
    const r = pickDone([done('edge'), done('inside')], new Map([['edge', edge], ['inside', new Date(edge.getTime() + 1)]]), NOW);
    assert.deepEqual(ids(r), ['inside']);
  });

  it('keeps the first 30, and inWindow still counts every lane of the 7 days', () => {
    const lanes = []; const at = new Map();
    for (let i = 0; i < 40; i++) { lanes.push(done(`r${String(i).padStart(2, '0')}`)); at.set(`r${String(i).padStart(2, '0')}`, ago(i * 60 * 1000)); }
    lanes.push(done('ancient')); at.set('ancient', ago(30 * 24 * H));
    const r = pickDone(lanes, at, NOW);
    assert.equal(r.shown.length, 30);
    assert.equal(r.inWindow, 40);
    assert.equal(r.total, 41);
    assert.deepEqual(ids(r).slice(0, 2), ['r00', 'r01'], 'the newest come first');
    assert.ok(!ids(r).includes('r30'), 'the 31st newest is cut');
  });

  it('lists done lanes only', () => {
    const lanes = [done('d'), { id: 'o', state: 'ready', updated_at: NOW }, { id: 'a', state: 'active', updated_at: NOW }];
    const r = pickDone(lanes, new Map([['o', NOW], ['a', NOW]]), NOW);
    assert.deepEqual(ids(r), ['d']);
    assert.equal(r.total, 1);
  });
});

describe('pickDone time', () => {
  it('orders by the done event, not by updated_at (a note after the done event moves updated_at)', () => {
    // The land-pr-lock pattern: the lane was marked done at 09:00, then a note moved updated_at to 14:00.
    const lanes = [done('noted', ago(1 * H)), done('later', ago(5 * H))];
    const at = new Map([['noted', ago(6 * H)], ['later', ago(2 * H)]]);
    assert.deepEqual(ids(pickDone(lanes, at, NOW)), ['later', 'noted']);
  });

  it('falls back to updated_at when the lane has no done event', () => {
    const lanes = [done('no-event', ago(3 * H)), done('with-event', ago(10 * H))];
    const r = pickDone(lanes, new Map([['with-event', ago(1 * H)]]), NOW);
    assert.deepEqual(ids(r), ['with-event', 'no-event']);
    assert.equal(r.shown[1].at.getTime(), ago(3 * H).getTime());
  });

  it('reads a time given as an ISO string as well as a Date', () => {
    const r = pickDone([done('s')], new Map([['s', ago(2 * H).toISOString()]]), NOW);
    assert.equal(r.shown[0].at.getTime(), ago(2 * H).getTime());
  });

  it('counts a future time as now, so it is Today and not above its neighbours by days', () => {
    const lanes = [done('future'), done('recent')];
    const at = new Map([['future', new Date(NOW.getTime() + 3 * 24 * H)], ['recent', ago(60 * 1000)]]);
    const r = pickDone(lanes, at, NOW);
    assert.equal(r.shown[0].lane.id, 'future');
    assert.equal(r.shown[0].at.getTime(), NOW.getTime());
    assert.equal(dayLabel(r.shown[0].at, NOW), 'Today');
  });

  it('uses updated_at when the event time is invalid, and archives a lane with no usable time without throwing', () => {
    const lanes = [done('bad-event', ago(2 * H)), done('bad-both', 'not a date'), done('null-both', null)];
    const at = new Map([['bad-event', 'garbage'], ['bad-both', 'garbage']]);
    let r;
    assert.doesNotThrow(() => { r = pickDone(lanes, at, NOW); });
    assert.deepEqual(ids(r), ['bad-event']);
    assert.equal(r.inWindow, 1);
    assert.equal(r.total, 3, 'an archived lane still counts in the total');
  });

  it('breaks a tie by id, whatever the input order', () => {
    const t = ago(2 * H);
    const lanes = ['c', 'a', 'b'].map((id) => done(id));
    const at = new Map(['a', 'b', 'c'].map((id) => [id, t]));
    assert.deepEqual(ids(pickDone(lanes, at, NOW)), ['a', 'b', 'c']);
    assert.deepEqual(ids(pickDone(lanes.slice().reverse(), at, NOW)), ['a', 'b', 'c']);
  });
});

describe('dayLabel and clockText', () => {
  const justAfterMidnight = new Date(2026, 10, 5, 0, 10); // Thu Nov 5, 00:10
  it('changes at local midnight: 23:50 is Yesterday, 00:05 is Today, two days back is a date', () => {
    assert.equal(dayLabel(new Date(2026, 10, 4, 23, 50), justAfterMidnight), 'Yesterday');
    assert.equal(dayLabel(new Date(2026, 10, 5, 0, 5), justAfterMidnight), 'Today');
    assert.equal(dayLabel(new Date(2026, 10, 3, 23, 59), justAfterMidnight), 'Tue Nov 3');
    assert.equal(dayLabel(new Date(2026, 10, 4, 9, 0), NOW), 'Wed Nov 4');
  });

  it('reads Yesterday across a month end', () => {
    assert.equal(dayLabel(new Date(2026, 9, 31, 22, 0), new Date(2026, 10, 1, 8, 0)), 'Yesterday');
  });

  it('prints the clock as "3:42 PM", with 12 for midnight and noon', () => {
    assert.equal(clockText(new Date(2026, 10, 4, 15, 42)), '3:42 PM');
    assert.equal(clockText(new Date(2026, 10, 4, 0, 5)), '12:05 AM');
    assert.equal(clockText(new Date(2026, 10, 4, 12, 0)), '12:00 PM');
    assert.equal(clockText(new Date(2026, 10, 4, 9, 7)), '9:07 AM');
  });
});

describe('cutNote', () => {
  it('leaves a short note alone and cuts a long one to DONE_NOTE_MAX characters ending in an ellipsis', () => {
    assert.equal(cutNote('short'), 'short');
    assert.equal(cutNote('x'.repeat(DONE_NOTE_MAX)), 'x'.repeat(DONE_NOTE_MAX));
    const cut = cutNote('x'.repeat(DONE_NOTE_MAX + 50));
    assert.equal(cut.length, DONE_NOTE_MAX);
    assert.ok(cut.endsWith('…'));
    assert.equal(cutNote(null), '');
  });

  it('cuts by character, not by UTF-16 unit: an emoji at the cut stays whole, and 240 emoji are not cut', () => {
    const emoji = String.fromCodePoint(0x1F600);
    const cut = cutNote('x'.repeat(DONE_NOTE_MAX - 2) + emoji + 'y'.repeat(30));
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), 'a lone surrogate at the cut');
    assert.equal(Array.from(cut).length, DONE_NOTE_MAX);
    assert.ok(cut.endsWith(emoji + '\u2026'));
    assert.equal(cutNote(emoji.repeat(DONE_NOTE_MAX)), emoji.repeat(DONE_NOTE_MAX));
  });
});

describe('DONE_SQL', () => {
  // The fixture lanes in render-board.test.mjs prove what the query returns. This one pin keeps the kanban sync's form in the text.
  it('reads the kanban sync event (kind kanban, detail state to done) as well as the lane done event', () => {
    assert.match(DONE_SQL, /e\.kind = 'done' OR \(e\.kind = 'kanban' AND e\.detail->>'kind' = 'state' AND e\.detail->>'to' = 'done'\)/);
  });
});
