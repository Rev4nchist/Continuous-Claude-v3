/**
 * board-done-view -- pure helpers for the Done column of the phone page. No I/O, no database; `now` is a parameter.
 *
 * render-board.mjs runs on load, so it cannot be imported by a test. Everything a test must reach lives here.
 * Done lists the lanes (state = 'done') finished in the last DONE_DAYS days, newest first, at most DONE_MAX.
 * It is read-only: never saved, never ranked. Terms follow CONTEXT.md.
 * Dates are local time, like localStamp() in render-board.mjs.
 */

export const DONE_DAYS = 7;
export const DONE_MAX = 30;
export const DONE_NOTE_MAX = 240;

/**
 * When a lane was marked done: the newest 'done' event or the newest kanban sync event that moved it to done.
 * lane.mjs `state ... done` logs kind 'done'. kanban-apply logs kind 'kanban' with detail {kind:'state', to:'done'} and never kind 'done',
 * so both forms are needed. $1 = board key. A lane with no event falls back to lane.updated_at in pickDone (never first: a note moves updated_at).
 */
export const DONE_SQL = `SELECT e.lane_id AS id, max(e.occurred_at) AS done_at
  FROM agentic_os.lane_event e
 WHERE e.project_key = $1::text
   AND (e.kind = 'done' OR (e.kind = 'kanban' AND e.detail->>'kind' = 'state' AND e.detail->>'to' = 'done'))
 GROUP BY e.lane_id`;

/** A Date from a Date, an ISO string or a number; null when it is none of them or not a real date. */
function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The done lanes of `lanes` for the page.
 * `doneAtById` is a Map lane id -> done time (Date or string) from DONE_SQL. The time of a lane is that, else lane.updated_at.
 * A time in the future counts as now. A lane with no usable time is archived: it counts in `total` and is never shown.
 * Returns { shown: [{ lane, at }], inWindow, total }: `shown` is the newest DONE_MAX of the last DONE_DAYS days, ties by id.
 */
export function pickDone(lanes, doneAtById, now) {
  const cutoff = now.getTime() - DONE_DAYS * 24 * 3600 * 1000;
  const done = lanes.filter((l) => l.state === 'done');
  const dated = [];
  for (const lane of done) {
    const at = toDate(doneAtById.get(lane.id)) ?? toDate(lane.updated_at);
    if (!at) continue;
    dated.push({ lane, at: at.getTime() > now.getTime() ? new Date(now.getTime()) : at });
  }
  const inWindow = dated.filter((e) => e.at.getTime() > cutoff)
    .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.lane.id < b.lane.id ? -1 : a.lane.id > b.lane.id ? 1 : 0));
  return { shown: inWindow.slice(0, DONE_MAX), inWindow: inWindow.length, total: done.length };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Today", "Yesterday", else "Wed Nov 4". Local calendar days. */
export function dayLabel(d, now) {
  if (sameDay(d, now)) return 'Today';
  if (sameDay(d, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday';
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "3:42 PM", local time. */
export function clockText(d) {
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** A note for a Done card: at most DONE_NOTE_MAX characters, ending in an ellipsis when it was cut. Counts code points, so an emoji is never split. */
export function cutNote(text) {
  const chars = Array.from(String(text ?? ''));
  return chars.length <= DONE_NOTE_MAX ? chars.join('') : `${chars.slice(0, DONE_NOTE_MAX - 1).join('')}…`;
}
