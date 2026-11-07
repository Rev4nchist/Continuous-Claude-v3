/**
 * reminder-core -- pure parsers and formatters for the `lane.mjs remind` verbs. No I/O, no database.
 *
 * lane.mjs runs its commands at the top level, so a test cannot import from it. The rules that can
 * go wrong (time zones, DST, flags) live here and lane.mjs imports them.
 *
 * Every parser throws an Error whose message is shown to the caller (exit 1), so a bad value never
 * turns into a default. `undefined` means "the flag was not given".
 *
 * Time input (design: .claudedocs/2026-11-06-lane-reminders-design.md, "Data model"):
 *   - ISO with an offset or Z: taken as given.
 *   - 'YYYY-MM-DD HH:MM': read as America/Chicago, with the zone in force on that day.
 *   - 'YYYY-MM-DD': 08:00 America/Chicago.
 * Stored as timestamptz. Shown as Chicago time with the zone abbreviation in force (CST or CDT).
 * No time-zone package: Intl does the offset math.
 */

/** The values the lane_remind_state_check constraint allows. */
export const REMIND_STATES = ['scheduled', 'due', 'needs_dave', 'failed', 'acked'];

const BANDS = ['P0', 'P1', 'P2'];
const ZONE = 'America/Chicago';
const show = (v) => (v === true ? '(no value)' : JSON.stringify(v));

const FORMATS = "an ISO time with an offset (2026-11-06T08:00:00-06:00), 'YYYY-MM-DD HH:MM' (America/Chicago) "
  + "or 'YYYY-MM-DD' (08:00 America/Chicago)";
const badTime = (raw, why) => new Error(`bad time ${show(raw)}${why ? ` (${why})` : ''}: use ${FORMATS}`);

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/;

const WALL = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** The Chicago wall clock at an instant, as numbers. */
function wallAt(ms) {
  const p = Object.fromEntries(WALL.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Chicago's offset from UTC at an instant, in ms (negative: CST is -6h). */
function offsetAt(ms) {
  const w = wallAt(ms);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** True when y-mo-d h:mi is a real calendar time (rejects 02-30, hour 24, minute 60). */
function validFields(y, mo, d, h, mi, s = 0) {
  if (h > 23 || mi > 59 || s > 59) return false;
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * The instant for a Chicago wall time. Tries both offsets that apply around that day and keeps the ones that
 * give the same wall time back. None: the hour does not exist (DST start) and it throws. Two: the hour repeats
 * (DST end) and the first (earlier, CDT) instant wins.
 */
function chicagoInstant(raw, y, mo, d, h, mi) {
  const t0 = Date.UTC(y, mo - 1, d, h, mi);
  const offsets = [...new Set([offsetAt(t0 - 86_400_000), offsetAt(t0 + 86_400_000)])];
  const hits = offsets.map((o) => t0 - o).filter((cand) => {
    const w = wallAt(cand);
    return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi;
  }).sort((a, b) => a - b);
  if (!hits.length) throw badTime(raw, `that hour does not exist in ${ZONE} on that day`);
  return new Date(hits[0]);
}

/** The due time as a Date. It never reads the clock: the past check is assertFuture. */
export function parseDue(raw) {
  if (typeof raw !== 'string') throw badTime(raw);
  const iso = ISO_RE.exec(raw);
  if (iso) {
    const [, y, mo, d, h, mi, s = '0', zone] = iso;
    if (!validFields(+y, +mo, +d, +h, +mi, +s)) throw badTime(raw, 'not a real date or time');
    let off = 0;
    if (zone !== 'Z') {
      const [oh, om] = zone.slice(1).split(':').map(Number);
      if (oh > 14 || om > 59) throw badTime(raw, 'offset out of range');
      off = (zone[0] === '-' ? -1 : 1) * (oh * 60 + om) * 60_000;
    }
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - off);
  }
  const loc = LOCAL_RE.exec(raw);
  if (!loc) throw badTime(raw);
  const [, y, mo, d, h = '08', mi = '00'] = loc;
  if (!validFields(+y, +mo, +d, +h, +mi)) throw badTime(raw, 'not a real date or time');
  return chicagoInstant(raw, +y, +mo, +d, +h, +mi);
}

const FOR_MIN_MS = 60_000;
const FOR_MAX_MS = 30 * 86_400_000;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `--for 30m|2h|1d` as milliseconds, from 1 minute to 30 days. Nothing else. */
export function parseFor(raw) {
  const m = typeof raw === 'string' ? /^([1-9][0-9]*)([mhd])$/.exec(raw) : null;
  const ms = m ? Number(m[1]) * UNIT_MS[m[2]] : NaN;
  if (!(ms >= FOR_MIN_MS && ms <= FOR_MAX_MS)) {
    throw new Error(`--for must look like 30m, 2h or 1d, from 1m to 30d (got ${show(raw)})`);
  }
  return ms;
}

/**
 * The reminder band. Literal "P0", "P1" or "P2" only. Not given: keep the stored band, else P1.
 * P0 is never produced from "not given" unless it is already stored (Dave: P0 only on an explicit --pri P0).
 */
export function resolvePri(raw, stored) {
  if (raw === undefined || raw === null) return BANDS.includes(stored) ? stored : 'P1';
  if (typeof raw === 'string' && BANDS.includes(raw)) return raw;
  throw new Error(`--pri must be one of ${BANDS.join(', ')} (got ${show(raw)})`);
}

const ACTION_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** `--action <id>`: the shape of an allowlist id, never a shell string. Version 1 only shows it. */
export function parseAction(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string' && ACTION_RE.test(raw)) return raw;
  throw new Error(`--action must be an action id (lower case letters, digits, '.', '_', '-'; 1 to 64 characters), not a command (got ${show(raw)})`);
}

/** Refuse a time that is not after `now`, unless the caller allows the past (set --allow-past, for the backfill). */
export function assertFuture(date, now, allowPast) {
  if (!allowPast && date.getTime() <= now.getTime()) {
    throw new Error(`that time is in the past (${fmtCT(date)}); pick a later time`);
  }
}

/** The lane_event detail for a reminder verb: only the keys that have a value. null stays (it is a value). */
export function remindDetail(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

const CT = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, weekday: 'short', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23', timeZoneName: 'short',
});

/** 'Fri 11-06 08:00 CST': Chicago time with the zone abbreviation in force. */
export function fmtCT(date) {
  const p = Object.fromEntries(CT.formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** '' while the reminder is at most 60 minutes late, else 'OVERDUE 2h' (hours) or 'OVERDUE 2d' (from 24 hours). */
export function overdueLabel(due, now = new Date()) {
  const late = Math.floor((new Date(now).getTime() - new Date(due).getTime()) / 60_000);
  if (!(late > 60)) return '';
  const h = Math.floor(late / 60);
  return h < 24 ? `OVERDUE ${h}h` : `OVERDUE ${Math.floor(h / 24)}d`;
}

const DOWN_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH', '57P03', '3D000']);

export const DONE_POLL_MS = 2 * 3_600_000; // 2 hours

/** True when the Done-poll has not run for DONE_POLL_MS (or never). `state` is latest.json. The tick and the sync share this rule. */
export function pollDue(state, nowMs) {
  return !state?.lastDonePollAt || !(nowMs - Date.parse(state.lastDonePollAt) < DONE_POLL_MS);
}

/**
 * True when an error means "the database is not there" and not "the code is wrong": a network code, a login refusal
 * (SQLSTATE class 28), the server starting up (57P03), or a connect or timeout message. `remind tick` exits 2 for it.
 */
export function isDbUnreachable(e) {
  if (!e) return false;
  const code = String(e.code ?? '');
  if (DOWN_CODES.has(code) || code.startsWith('28')) return true;
  return /connect|timeout/i.test(String(e.message ?? ''));
}
