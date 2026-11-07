/**
 * reminder-core: isolated tests for the pure parsers behind `lane.mjs remind`.
 *
 * Failure list, one test (or group) each:
 *   R1  an ISO time with an offset is changed (must be returned as the exact instant)
 *   R2  a fixed -6 offset is used for America/Chicago (the July case gives 13:00Z, not 14:00Z)
 *   R3  the DST start day: the hour that does not exist is accepted
 *   R4  the DST end day: the repeated hour throws, or takes the second instant
 *   R5  a date alone is not 08:00 Chicago; sloppy shapes (no offset with a T, 8:00, US dates, words) are accepted
 *   R6  --for takes a unit or size it should refuse
 *   R7  --pri accepts a lower case or `none` value, or turns an omitted value into P0
 *   R8  a time in the past is accepted without --allow-past
 *   R9  --action accepts a shell string
 *   R10 the event detail keeps undefined keys
 *   R11 a lateness label shows at 60 min, or not at 125 min; CT shows the wrong zone abbreviation
 *   R12 a down database is not told apart from a bug (remind tick must exit 2 only for the first)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  REMIND_STATES, assertFuture, fmtCT, overdueLabel, parseAction, parseDue, parseFor, remindDetail, resolvePri, isDbUnreachable,
} from './reminder-core.mjs';

const iso = (d) => d.toISOString();

test('REMIND_STATES is the list in the migration 0005 CHECK constraint', () => {
  const sql = readFileSync(new URL('../../apps/agentic-os/drizzle/0005_lane_reminders.sql', import.meta.url), 'utf8');
  const list = /lane_remind_state_check" CHECK \([^)]*IN \(([^)]*)\)/.exec(sql)?.[1];
  assert.ok(list, 'lane_remind_state_check not found in migration 0005');
  assert.deepEqual(REMIND_STATES, list.split(',').map((x) => x.trim().replace(/'/g, '')));
});

test('R1 parseDue keeps an ISO time with an offset as given', () => {
  assert.equal(iso(parseDue('2026-11-06T08:00:00-06:00')), '2026-11-06T14:00:00.000Z');
  assert.equal(iso(parseDue('2026-11-06T08:00:00Z')), '2026-11-06T08:00:00.000Z');
  assert.equal(iso(parseDue('2026-11-06T08:00+05:30')), '2026-11-06T02:30:00.000Z');
});

test('R2 parseDue reads a bare local time as America/Chicago, with the zone in force', () => {
  assert.equal(iso(parseDue('2026-11-06 08:00')), '2026-11-06T14:00:00.000Z'); // CST
  assert.equal(iso(parseDue('2026-07-06 08:00')), '2026-07-06T13:00:00.000Z'); // CDT
});

test('R3 parseDue on the DST start day: 01:30 ok, 02:30 does not exist, 03:30 ok', () => {
  assert.equal(iso(parseDue('2026-03-08 01:30')), '2026-03-08T07:30:00.000Z');
  assert.throws(() => parseDue('2026-03-08 02:30'), /does not exist/);
  assert.equal(iso(parseDue('2026-03-08 03:30')), '2026-03-08T08:30:00.000Z');
});

test('R4 parseDue on the DST end day takes the first (CDT) instant and never throws', () => {
  assert.equal(iso(parseDue('2026-11-01 01:30')), '2026-11-01T06:30:00.000Z');
  assert.equal(iso(parseDue('2026-11-01 02:30')), '2026-11-01T08:30:00.000Z');
});

test('R5 parseDue: a date alone is 08:00 Chicago', () => {
  assert.equal(iso(parseDue('2026-11-06')), '2026-11-06T14:00:00.000Z');
  assert.equal(iso(parseDue('2026-07-06')), '2026-07-06T13:00:00.000Z');
});

test('R5 parseDue rejects every other shape and names the accepted formats', () => {
  const bad = ['2026-11-06 8:00', '2026-11-06T08:00', '11/06/2026', '', 'tomorrow', true, undefined, '2026-13-40 08:00',
    '2026-02-30 08:00', '2026-11-06 24:00', '2026-11-06 08:60', ' 2026-11-06', '2026-11-06T08:00:00+25:00'];
  for (const b of bad) {
    assert.throws(() => parseDue(b), /YYYY-MM-DD HH:MM/, `should reject ${JSON.stringify(b)}`);
  }
});

test('R6 parseFor accepts 30m, 2h, 1d', () => {
  assert.equal(parseFor('30m'), 30 * 60_000);
  assert.equal(parseFor('2h'), 2 * 3_600_000);
  assert.equal(parseFor('1d'), 86_400_000);
  assert.equal(parseFor('30d'), 30 * 86_400_000);
});

test('R6 parseFor rejects 0m, 2, "2 h", 1.5h, 90d, -1h, 2H and a bare flag', () => {
  for (const b of ['0m', '2', '2 h', '1.5h', '90d', '-1h', '2H', true, '', undefined, '31d', '43201m']) {
    assert.throws(() => parseFor(b), /--for/, `should reject ${JSON.stringify(b)}`);
  }
});

test('R7 resolvePri takes literal P0/P1/P2 only', () => {
  for (const p of ['P0', 'P1', 'P2']) assert.equal(resolvePri(p, 'P1'), p);
  for (const b of ['p0', 'P3', 'none', '', true]) assert.throws(() => resolvePri(b, 'P1'), /--pri/, `should reject ${JSON.stringify(b)}`);
});

test('R7 resolvePri with no value keeps the stored band, else P1, and never makes P0 by itself', () => {
  assert.equal(resolvePri(undefined, 'P0'), 'P0');
  assert.equal(resolvePri(undefined, 'P2'), 'P2');
  assert.equal(resolvePri(undefined, null), 'P1');
  assert.equal(resolvePri(undefined, undefined), 'P1');
  assert.equal(resolvePri(undefined, 'bogus'), 'P1');
});

test('R8 assertFuture throws before now and passes with allowPast', () => {
  const now = new Date('2026-11-06T12:00:00Z');
  assert.throws(() => assertFuture(new Date('2026-11-06T11:59:00Z'), now, false), /past/);
  assert.throws(() => assertFuture(new Date('2026-11-06T12:00:00Z'), now, false), /past/);
  assert.doesNotThrow(() => assertFuture(new Date('2026-11-06T12:00:01Z'), now, false));
  assert.doesNotThrow(() => assertFuture(new Date('2026-11-06T11:59:00Z'), now, true));
});

test('R9 parseAction accepts an id and rejects shell strings', () => {
  assert.equal(parseAction('doctor.run'), 'doctor.run');
  assert.equal(parseAction(undefined), undefined);
  for (const b of ['rm -rf /', 'a;b', '$(x)', '', 'a'.repeat(65), true, '-x', 'A', 'a b', 'a|b', '`x`']) {
    assert.throws(() => parseAction(b), /--action/, `should reject ${JSON.stringify(b)}`);
  }
  assert.equal(parseAction('a'.repeat(64)), 'a'.repeat(64));
});

test('R10 remindDetail keeps op and drops undefined keys', () => {
  assert.deepEqual(remindDetail({ op: 'set', due_at: 'x', pri: undefined, late_min: undefined, via: undefined }), { op: 'set', due_at: 'x' });
  assert.deepEqual(remindDetail({ op: 'ack' }), { op: 'ack' });
  assert.deepEqual(remindDetail({ op: 'snooze', due_at: 'n', from_due_at: 'o' }), { op: 'snooze', due_at: 'n', from_due_at: 'o' });
  assert.deepEqual(remindDetail({ op: 'clear', pri: null }), { op: 'clear', pri: null });
});

test('R11 overdueLabel is empty at 60 min and OVERDUE 2h at 125 min', () => {
  const due = new Date('2026-11-06T12:00:00Z');
  assert.equal(overdueLabel(due, new Date('2026-11-06T13:00:00Z')), '');
  assert.equal(overdueLabel(due, new Date('2026-11-06T11:00:00Z')), '');
  assert.equal(overdueLabel(due, new Date('2026-11-06T14:05:00Z')), 'OVERDUE 2h');
  assert.equal(overdueLabel(due, new Date('2026-11-06T13:30:00Z')), 'OVERDUE 1h');
  assert.equal(overdueLabel(due, new Date('2026-11-08T12:30:00Z')), 'OVERDUE 2d');
});

test('R11 fmtCT shows CDT in July and CST in January', () => {
  assert.equal(fmtCT(new Date('2026-07-06T13:00:00Z')), 'Mon 07-06 08:00 CDT');
  assert.equal(fmtCT(new Date('2026-01-05T14:00:00Z')), 'Mon 01-05 08:00 CST');
  assert.equal(fmtCT(new Date('2026-11-06T14:00:00Z')), 'Fri 11-06 08:00 CST');
});

test('R12 isDbUnreachable: connection codes and connect or timeout messages yes; a syntax error or a plain Error no', () => {
  for (const e of [{ code: 'ECONNREFUSED' }, { code: 'ENOTFOUND' }, { code: 'ETIMEDOUT' }, { code: 'ECONNRESET' }, { code: '28P01' }, { code: '57P03' }, new Error('Connection terminated due to connection timeout')]) {
    assert.equal(isDbUnreachable(e), true, JSON.stringify(e));
  }
  for (const e of [{ code: '42703', message: 'column x does not exist' }, new Error('lane r1 is done'), null, undefined]) {
    assert.equal(isDbUnreachable(e), false, String(e?.message));
  }
});
