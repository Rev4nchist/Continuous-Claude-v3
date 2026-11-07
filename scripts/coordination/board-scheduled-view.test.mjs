/**
 * board-scheduled-view.test -- the pure helpers behind the Scheduled and reminders column of the phone page.
 *
 * `now` is always a parameter, so no test reads the clock.
 *
 * How they can fail, one test each:
 *   - an open lane with a future due time is not in the column, or a past due time on a normal lane is
 *   - a due reminder (state scheduled, due, needs_dave or failed) leaves the column, or an acked one stays
 *   - a done lane stays, or a held (active) lane shows here and again in In progress
 *   - a lane with no due time, or a bad one, throws or lands in the column
 *   - the order follows the input and not the due time, or a tie changes between renders
 *   - a lane is in both lists, or in neither
 *   - `now` is read from the clock: the same lanes must split differently at two values of `now`
 *   - the input array is changed
 *   - the chip is wrong at the edges: 59 and 60 minutes, 23 and 24 hours, the moment of the due time
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dueChip, splitScheduled } from './board-scheduled-view.mjs';

const NOW = new Date('2026-11-07T15:00:00.000Z');
const MIN = 60 * 1000;
const H = 60 * MIN;
const at = (ms) => new Date(NOW.getTime() + ms);
const lane = (id, extra = {}) => ({ id, state: 'ready', track: 'zz', due_at: null, remind_state: null, ...extra });
const rem = (id, remind_state, ms, extra = {}) => lane(id, { track: 'reminders', remind_state, due_at: at(ms), ...extra });
const ids = (list) => list.map((e) => e.lane?.id ?? e.id);

describe('splitScheduled membership', () => {
  it('puts an open lane with a future due time in the column, and a past due time on a normal lane in the rest', () => {
    const r = splitScheduled([lane('future', { due_at: at(H) }), lane('past', { due_at: at(-H) })], NOW);
    assert.deepEqual(ids(r.scheduled), ['future']);
    assert.deepEqual(ids(r.rest), ['past']);
  });

  it('keeps a due reminder in each of the four live states', () => {
    const all = ['scheduled', 'due', 'needs_dave', 'failed'].map((s) => rem(`r-${s}`, s, -5 * MIN));
    const r = splitScheduled(all, NOW);
    assert.deepEqual(ids(r.scheduled).sort(), ['r-due', 'r-failed', 'r-needs_dave', 'r-scheduled']);
    assert.equal(r.rest.length, 0);
  });

  it('keeps a due reminder on a normal lane (remind set keeps the lane track), the same test as REMINDER_DUE_PRED in lane.mjs', () => {
    const r = splitScheduled([lane('normal-due', { remind_state: 'needs_dave', due_at: at(-5 * MIN) }), lane('normal-sched', { remind_state: 'scheduled', due_at: at(-MIN) })], NOW);
    assert.deepEqual(ids(r.scheduled), ['normal-due', 'normal-sched']);
    assert.equal(r.rest.length, 0);
  });

  it('drops an acked reminder, whether its time is past or still ahead', () => {
    const r = splitScheduled([rem('a-past', 'acked', -H), rem('a-future', 'acked', H)], NOW);
    assert.equal(r.scheduled.length, 0);
    assert.deepEqual(ids(r.rest), ['a-past', 'a-future']);
  });

  it('leaves a reminders lane with no state, or a past time and no live state, in the rest', () => {
    const r = splitScheduled([rem('r-null', null, -H), lane('r-track', { track: 'reminders', due_at: at(-H) })], NOW);
    assert.equal(r.scheduled.length, 0);
  });

  it('leaves a done lane and a held lane out of the column', () => {
    const r = splitScheduled([lane('d', { state: 'done', due_at: at(H) }), lane('h', { state: 'active', due_at: at(H) }), rem('dr', 'due', -H, { state: 'done' })], NOW);
    assert.equal(r.scheduled.length, 0);
    assert.deepEqual(ids(r.rest), ['d', 'h', 'dr']);
  });

  it('leaves a lane with no due time, or a due time that is not a date, in the rest', () => {
    const r = splitScheduled([lane('none'), lane('empty', { due_at: '' }), lane('junk', { due_at: 'not a date' }), lane('nan', { due_at: NaN })], NOW);
    assert.equal(r.scheduled.length, 0);
    assert.equal(r.rest.length, 4);
  });

  it('reads a due time given as an ISO string', () => {
    const r = splitScheduled([lane('iso', { due_at: at(H).toISOString() })], NOW);
    assert.deepEqual(ids(r.scheduled), ['iso']);
  });

  it('treats a due time equal to now as past: a normal lane is in the rest, a reminder is due', () => {
    const r = splitScheduled([lane('edge', { due_at: NOW }), rem('edge-r', 'scheduled', 0)], NOW);
    assert.deepEqual(ids(r.scheduled), ['edge-r']);
    assert.deepEqual(ids(r.rest), ['edge']);
  });
});

describe('splitScheduled order and purity', () => {
  it('sorts by due time, due reminders first, and breaks a tie by id', () => {
    const r = splitScheduled([lane('c', { due_at: at(2 * H) }), lane('b', { due_at: at(H) }), lane('a', { due_at: at(H) }), rem('z', 'due', -H)], NOW);
    assert.deepEqual(ids(r.scheduled), ['z', 'a', 'b', 'c']);
  });

  it('keeps the rest in input order', () => {
    const r = splitScheduled([lane('x'), lane('s', { due_at: at(H) }), lane('y'), lane('w')], NOW);
    assert.deepEqual(ids(r.rest), ['x', 'y', 'w']);
  });

  it('puts no lane in both lists and none in neither', () => {
    const input = [lane('1', { due_at: at(H) }), lane('2'), rem('3', 'failed', -H), rem('4', 'acked', -H), lane('5', { state: 'done' }), lane('6', { state: 'active', due_at: at(H) })];
    const r = splitScheduled(input, NOW);
    const seen = [...ids(r.scheduled), ...ids(r.rest)].sort();
    assert.deepEqual(seen, ['1', '2', '3', '4', '5', '6']);
  });

  it('takes now as a parameter: the same lanes split differently at two values of now', () => {
    const input = [lane('soon', { due_at: at(H) }), rem('rem', 'scheduled', H)];
    assert.deepEqual(ids(splitScheduled(input, NOW).scheduled), ['rem', 'soon']);
    const later = splitScheduled(input, at(2 * H));
    assert.deepEqual(ids(later.scheduled), ['rem']);
    assert.deepEqual(ids(later.rest), ['soon']);
  });

  it('does not change the input array or its lanes', () => {
    const input = [lane('b', { due_at: at(2 * H) }), lane('a', { due_at: at(H) })];
    const copy = JSON.stringify(input);
    splitScheduled(input, NOW);
    assert.equal(JSON.stringify(input), copy);
    assert.equal(input[0].id, 'b');
  });

  it('gives each entry its lane and its due time in ms', () => {
    const r = splitScheduled([lane('a', { due_at: at(H) })], NOW);
    assert.equal(r.scheduled[0].lane.id, 'a');
    assert.equal(r.scheduled[0].dueMs, NOW.getTime() + H);
  });
});

describe('dueChip', () => {
  const chip = (ms) => dueChip(NOW.getTime() + ms, NOW.getTime());

  it('counts minutes below one hour, rounding up so a time never reads as earlier than it is', () => {
    assert.equal(chip(25 * MIN), 'in 25m');
    assert.equal(chip(59 * MIN), 'in 59m');
    assert.equal(chip(59 * MIN + 1), 'in 1h');
    assert.equal(chip(1), 'in 1m');
  });

  it('counts whole hours from 60 minutes to below 24 hours', () => {
    assert.equal(chip(60 * MIN), 'in 1h');
    assert.equal(chip(3 * H), 'in 3h');
    assert.equal(chip(3 * H - 20 * 1000), 'in 3h');
    assert.equal(chip(23 * H), 'in 23h');
  });

  it('counts days from 24 hours', () => {
    assert.equal(chip(24 * H), 'in 1d');
    assert.equal(chip(49 * H), 'in 2d');
  });

  it('says DUE at the due time and after it', () => {
    assert.equal(chip(0), 'DUE');
    assert.equal(chip(-1), 'DUE');
    assert.equal(chip(-30 * 24 * H), 'DUE');
  });
});
