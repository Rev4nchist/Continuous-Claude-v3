/**
 * portfolio -- one row per program seat, and the page that shows them. Pure: no I/O, no database.
 *
 * A seat is the holder of a master card lane (CONTEXT.md "Master card"). render-portfolio.mjs reads the lane database and
 * calls seatRows then renderHtml. The page shows ids, labels, numbers and the build time only. It never shows a lane
 * note, title, scope or event body: seatRows copies only the fields it needs, so those cannot reach the page.
 *
 * Quiet rule (seat ruling): a seat is quiet when tickMarker says NO TICK. The last event age is a fact on the row and
 * never the test, because a keep-warm tick renews the lease and writes no lane event.
 */
import { MASTER_LANES, NO_TICK, tickMarker } from './tick-marker.mjs';
import { label } from './session-label.mjs';

/** Reclaim needs a holder quiet this long AND an ended lease. TWIN of STALE_MINUTES in lane.mjs and render-board.mjs (lane.mjs runs a command on import, so it cannot be imported). */
export const STALE_MINUTES = 5;
/** A lease more than this far ahead is a park. TWIN of PARK_ABOVE_MINUTES in tick-marker.mjs (not exported there). */
export const PARK_ABOVE_MINUTES = 91;
const DEFAULT_BOARD = 'continuous-claude';

export const IN_REVIEW_HEADER = 'in review, not parked';
export const IN_REVIEW_RULE = 'in review, not parked: open lanes of the same board in state review whose lease is not more than '
  + `${PARK_ABOVE_MINUTES} minutes ahead. It is not Dave's full queue.`;

const ms = (t) => new Date(t).getTime();
const minutesBetween = (later, earlier) => Math.round((ms(later) - ms(earlier)) / 60000);
const boardOf = (l) => l.project_key || DEFAULT_BOARD;

/** Minutes of lease left (rounded, negative when ended), or null for no lease or a junk value. */
function leaseLeft(lane, now) {
  if (!lane.lease_expires_at) return null;
  const end = ms(lane.lease_expires_at);
  return Number.isFinite(end) ? Math.round((end - now.getTime()) / 60000) : null;
}

/** Reclaimable = lease ended (or none) AND the holder quiet STALE_MINUTES (or no session row). The rule of the SEAT banner line. */
function reclaimable(lane, sessions, now) {
  const left = leaseLeft(lane, now);
  if (left !== null && left > 0) return false;
  const s = sessions.find((x) => x.id === lane.owner_session_id);
  const alive = s ? ms(s.last_alive) : NaN;
  return !Number.isFinite(alive) || (now.getTime() - alive) / 60000 >= STALE_MINUTES;
}

/** 'NO TICK' or ''. tickMarker only knows the ids in its own MASTER_LANES, so a master card of another id borrows the first one:
 *  the word and the test stay one source (tick-marker.mjs is not changed). The caller's masterLanes already chose which lanes get here. */
const tickWord = (lane, now) => tickMarker({ ...lane, id: MASTER_LANES[0] }, now);

function lastEventAge(events, board, laneId, now) {
  const times = events.filter((e) => boardOf(e) === board && e.lane_id === laneId).map((e) => ms(e.occurred_at)).filter(Number.isFinite);
  return times.length ? minutesBetween(now, Math.max(...times)) : null;
}

function inReviewNotParked(lanes, board, now) {
  return lanes.filter((l) => boardOf(l) === board && l.state === 'review'
    && !((leaseLeft(l, now) ?? 0) > PARK_ABOVE_MINUTES)).length;
}

function seatRow(lane, ctx) {
  const { lanes, sessions, events, identities, now } = ctx;
  const board = boardOf(lane);
  const left = leaseLeft(lane, now);
  const holds = lane.owner_session_id && !reclaimable(lane, sessions, now);
  return {
    board,
    lane: lane.id,
    holder: holds ? label(lane.owner_session_id, identities) : null,
    leaseMinutes: left,
    lastEventAgeMinutes: lastEventAge(events, board, lane.id, now),
    tick: tickWord(lane, now),
    parkedTo: left !== null && left > PARK_ABOVE_MINUTES ? new Date(lane.lease_expires_at).toISOString() : null,
    inReviewNotParked: inReviewNotParked(lanes, board, now),
  };
}

/**
 * One row per open master card per board, ordered by board then lane id.
 * lanes: { project_key, id, state, owner_session_id, lease_expires_at }. sessions: { id, last_alive }.
 * events: { project_key, lane_id, occurred_at }. identities: optional Map from listIdentities() for 'name #sid8' labels.
 */
export function seatRows({ lanes, sessions = [], events = [], masterLanes = MASTER_LANES, identities = new Map(), now = new Date() }) {
  const ctx = { lanes, sessions, events, identities, now };
  return lanes
    .filter((l) => masterLanes.includes(l.id) && l.state !== 'done')
    .map((l) => seatRow(l, ctx))
    .sort((a, b) => a.board.localeCompare(b.board) || a.lane.localeCompare(b.lane));
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const cell = (v) => `<td>${esc(v ?? '')}</td>`;

const COLUMNS = ['board', 'master card', 'holder', 'lease (min)', 'last event (min ago)', 'tick', 'parked to', IN_REVIEW_HEADER];

function rowHtml(r) {
  const word = r.tick === NO_TICK ? `<td class="warn">${esc(r.tick)}</td>` : cell(r.tick);
  const parked = r.parkedTo ? `parked to ${stamp(new Date(r.parkedTo))}` : '';
  return `<tr>${cell(r.board)}${cell(r.lane)}${cell(r.holder ?? 'no holder')}${cell(r.leaseMinutes)}`
    + `${cell(r.lastEventAgeMinutes)}${word}${cell(parked)}${cell(r.inReviewNotParked)}</tr>`;
}

const failedHtml = (board) => `<tr>${cell(board)}<td colspan="${COLUMNS.length - 1}" class="warn">read failed</td></tr>`;

const CSS = `:root{--bg:#fff;--fg:#1a1a1a;--muted:#5c5c5c;--line:#d8d8d8;--warn:#a33a00}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#e8e8e8;--muted:#a0a0a0;--line:#3a3a3a;--warn:#ff9a5c}}
body{background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif;margin:1.5rem}
h1{font-size:1.2rem;margin:0 0 .25rem}p{color:var(--muted);margin:.25rem 0}
table{border-collapse:collapse;margin-top:1rem}th,td{border:1px solid var(--line);padding:.3rem .6rem;text-align:left}
.warn{color:var(--warn);font-weight:600}`;

/** The page. rows from seatRows; failedBoards are board keys whose read failed. */
export function renderHtml(rows, { builtAt = new Date(), failedBoards = [] } = {}) {
  const head = `<tr>${COLUMNS.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
  const body = [...rows.map(rowHtml), ...failedBoards.map(failedHtml)].join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Program seats</title><style>${CSS}</style></head><body>
<h1>Program seats</h1>
<p>Built ${esc(stamp(builtAt))} local. Read-only. Ids, labels and numbers only.</p>
<table>
${head}
${body}
</table>
<p>${esc(IN_REVIEW_RULE)}</p>
</body></html>
`;
}
