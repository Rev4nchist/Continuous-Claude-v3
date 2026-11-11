// Row builders for the pure tests. They give exactly the shapes of design B.0 (lib/board.mjs returns the same):
//   BoardRow, EdgeRow, EventRow. A key outside the shape throws, so a test cannot invent a field.
// Dates are Date objects, as pg returns them. Event ids are numbers (board.mjs converts the bigserial string).

const BOARD = 'continuous-claude';
const WHEN = new Date('2026-11-10T00:00:00.000Z');

function build(label, base, over) {
  for (const key of Object.keys(over)) {
    if (!(key in base)) throw new Error(`${label}: '${key}' is not a key of the row shape`);
  }
  return { ...base, ...over };
}

// BoardRow. A re- lane gets the seed branch and track; any other id (an external) gets NULL, like an old card.
export function row(id, over = {}) {
  const program = id.startsWith('re-');
  return build('row', {
    id, project_key: BOARD, state: 'blocked', owner_session_id: null, owner_alive_at: null,
    lease_expires_at: null, updated_at: WHEN, branch: program ? `re/${id}` : null, track: program ? 'review-engine' : null,
    note: null, priority: 50, band: null, reclaimable: false, open_dep: false, waits_on: [], met: false,
    landed_sha: null, last_life: null,
  }, over);
}

// EdgeRow: lane_id waits on depends_on. dep_board is the board of the dependency lane (NULL: it has no lane row).
export function edge(laneId, dependsOn, over = {}) {
  return build('edge', { lane_id: laneId, depends_on: dependsOn, project_key: BOARD, dep_board: BOARD }, over);
}

// EventRow.
export function ev(id, laneId, kind, detail = {}, over = {}) {
  return build('ev', { id: Number(id), lane_id: laneId, kind, session_id: null, detail, occurred_at: WHEN }, over);
}

// The last_life object of a BoardRow: { id, kind, session_id, detail }.
export function life(id, kind, detail = {}, sessionId = null) {
  return { id: Number(id), kind, session_id: sessionId, detail };
}
