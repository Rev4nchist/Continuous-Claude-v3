/**
 * board-scheduled-view -- pure helpers for the Scheduled and reminders column of the phone page. No I/O, no database; `now` is a parameter.
 *
 * render-board.mjs runs on load, so it cannot be imported by a test. Everything a test must reach lives here.
 * The column is read-only: never saved, never ranked. Terms follow CONTEXT.md.
 * A lane in the column is not placed in Next, Later or Waiting, and is not in the page data (kb-data), so the browser never places it twice.
 */

/** Reminder states that still need Dave's eyes. An acked reminder is finished. Same list as REMINDER_DUE_PRED in lane.mjs. */
const LIVE_REMINDER = ['scheduled', 'due', 'needs_dave', 'failed'];

/** The due time in ms from a Date, an ISO string or a number; null when it is none of them or not a real date. */
function dueMsOf(v) {
  if (v === null || v === undefined || v === '') return null;
  const ms = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Is this lane in the column at `nowMs`?
 * A held (active) lane stays in In progress, a done lane is never here, and a lane with no usable due time is a normal lane.
 * Otherwise: a future due time that is not acked, or a due reminder (its time has come and it is not acked).
 */
function inColumn(lane, dueMs, nowMs) {
  if (dueMs === null || lane.state === 'done' || lane.state === 'active') return false;
  if (lane.remind_state === 'acked') return false;
  if (dueMs > nowMs) return true;
  // No track test: `remind set` on an existing lane keeps its track, and REMINDER_DUE_PRED has none.
  return LIVE_REMINDER.includes(lane.remind_state);
}

/**
 * Split the lanes for the page. `now` is a Date.
 * Returns { scheduled: [{ lane, dueMs }], rest: [lane] }. `scheduled` is sorted by due time, ties by id; `rest` keeps the input order.
 * Every lane is in exactly one list. The input is not changed.
 */
export function splitScheduled(lanes, now) {
  const nowMs = now.getTime();
  const scheduled = [];
  const rest = [];
  for (const lane of lanes) {
    const dueMs = dueMsOf(lane.due_at);
    if (inColumn(lane, dueMs, nowMs)) scheduled.push({ lane, dueMs });
    else rest.push(lane);
  }
  scheduled.sort((a, b) => a.dueMs - b.dueMs || (a.lane.id < b.lane.id ? -1 : a.lane.id > b.lane.id ? 1 : 0));
  return { scheduled, rest };
}

/**
 * The time chip: "in 25m", "in 3h", "in 2d", or "DUE" at the due time and after it.
 * Minutes round up, so a chip never reads earlier than the real time. Hours and days round down.
 * It is worked out at render time. A page nobody republished keeps a stale chip.
 */
export function dueChip(dueMs, nowMs) {
  const left = dueMs - nowMs;
  if (left <= 0) return 'DUE';
  const min = Math.ceil(left / 60000);
  if (min < 60) return `in ${min}m`;
  const hours = Math.floor(min / 60);
  return hours < 24 ? `in ${hours}h` : `in ${Math.floor(hours / 24)}d`;
}
