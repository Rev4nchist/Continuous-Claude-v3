// Board reads for the program verbs: SQL and row shaping only. Every input is a bound parameter; only the
// alias builders (contract.mjs, liveness.mjs, lane-sort.mjs) are interpolated, and they take a fixed alias.
// The SQL here is checked by the scratch-database probe, not by the unit tests (they use a fake client).
// Each reader takes a connected client (db.mjs openReadOnly) and returns the pinned row shapes of design B.0.
//   BoardRow, EdgeRow, EventRow: ids of lane_event are bigserial, so pg gives strings; they are converted with Number().
import { reclaimableSql } from './liveness.mjs';

const num = (v) => (v === null || v === undefined ? null : Number(v));

// ids: Waves ids plus external ids (text[]). Every query binds the board key and the ids; no string interpolation of input.

export function toBoardRow(r) {
  const life = r.last_life ?? null;
  return {
    id: r.id, project_key: r.project_key, state: r.state, owner_session_id: r.owner_session_id ?? null,
    owner_alive_at: r.owner_alive_at ?? null, lease_expires_at: r.lease_expires_at ?? null, updated_at: r.updated_at,
    branch: r.branch ?? null, track: r.track ?? null, note: r.note ?? null, priority: r.priority, band: r.band ?? null,
    reclaimable: r.reclaimable === true, open_dep: r.open_dep === true, waits_on: r.waits_on ?? [],
    met: r.met === true, landed_sha: r.landed_sha ?? null,
    last_life: life && { ...life, id: num(life.id) },
  };
}

export const toEdgeRow = (r) => ({ lane_id: r.lane_id, depends_on: r.depends_on, project_key: r.project_key, dep_board: r.dep_board ?? null });

export const toEventRow = (r) => ({
  id: num(r.id), lane_id: r.lane_id, kind: r.kind, session_id: r.session_id ?? null, detail: r.detail ?? {}, occurred_at: r.occurred_at,
});

// Program lanes: every map id, plus any card whose id starts with re- (cards that are not in the map are listed, never offered).
export async function readBoard(client, { board, ids, sql }) {
  const { laneOrderSql } = await import('../../coordination/lane-sort.mjs');
  const text = `SELECT l.id, l.project_key, l.state, l.owner_session_id, l.lease_expires_at, l.updated_at,
       l.branch, l.track, l.note, l.priority, l.band,
       (SELECT GREATEST(s.last_heartbeat, s.last_activity_at) FROM sessions s WHERE s.id = l.owner_session_id) AS owner_alive_at,
       ${reclaimableSql('l')} AS reclaimable,
       ${sql.openDepSql('l')} AS open_dep,
       ${sql.waitsOnSql('l')} AS waits_on,
       ${sql.laneMetSql('l')} AS met,
       ${sql.landedShaSql('l')} AS landed_sha,
       (SELECT row_to_json(x) FROM (SELECT e.id, e.kind, e.session_id, e.detail FROM agentic_os.lane_event e
          WHERE e.project_key = $1 AND e.lane_id = l.id AND ${sql.lifecycleWhere('e')}
          ORDER BY e.id DESC LIMIT 1) x) AS last_life
FROM agentic_os.lane l
WHERE l.project_key = $1 AND (l.id = ANY($2::text[]) OR left(l.id, 3) = 're-')
ORDER BY ${laneOrderSql('l')}`;
  const res = await client.query(text, [board, ids]);
  return res.rows.map(toBoardRow);
}

// A map id held by another board.
export async function readForeign(client, { board, ids }) {
  const res = await client.query(
    'SELECT id, project_key FROM agentic_os.lane WHERE id = ANY($2::text[]) AND project_key <> $1 ORDER BY id',
    [board, ids],
  );
  return res.rows.map((r) => ({ id: r.id, project_key: r.project_key }));
}

// Edges of the board, plus edges of the map ids stored under another board. dep_board is NULL when the dependency has no lane row.
export async function readEdges(client, { board, ids }) {
  const res = await client.query(
    `SELECT d.lane_id, d.depends_on, d.project_key, x.project_key AS dep_board
FROM agentic_os.lane_dep d LEFT JOIN agentic_os.lane x ON x.id = d.depends_on
WHERE d.project_key = $1 OR d.lane_id = ANY($2::text[]) ORDER BY d.lane_id, d.depends_on`,
    [board, ids],
  );
  return res.rows.map(toEdgeRow);
}

// Amendment A1. The program seed mark is the EARLIEST 'seeded' event of the board whose detail has an 'edges' key
// (the object-form seed writes {"lanes":N,"edges":M}; the array form writes no such key). Number, or null when there is none.
export async function readProgramSeed(client, board) {
  const res = await client.query(
    `SELECT id FROM agentic_os.lane_event
WHERE project_key = $1 AND kind = 'seeded' AND (detail->'edges') IS NOT NULL
ORDER BY id ASC LIMIT 1`,
    [board],
  );
  return num(res.rows[0]?.id);
}

// Lifecycle events and claims of the given lanes of one board, oldest first (check --claims replays them).
// Lane ids are global and lane_event.project_key is NOT NULL, so the board filter keeps the old events of a same-id lane
// on another board out of the replay.
export async function readLaneEvents(client, { board, ids, sql }) {
  const res = await client.query(
    `SELECT id, lane_id, kind, session_id, detail, occurred_at FROM agentic_os.lane_event e
WHERE e.project_key = $1 AND e.lane_id = ANY($2::text[]) AND (e.kind IN ('claimed','dep_override') OR ${sql.lifecycleWhere('e')})
ORDER BY e.id`,
    [board, ids],
  );
  return res.rows.map(toEventRow);
}

// State and owner of the given lanes, for the sync-board re-read before a write and the read-back after it.
// Returns a Map: lane id to { state, owner }. A lane with no row is not in the Map.
export async function readLaneStates(client, { board, ids }) {
  const res = await client.query(
    'SELECT id, state, owner_session_id FROM agentic_os.lane WHERE project_key = $1 AND id = ANY($2::text[])',
    [board, ids],
  );
  return new Map(res.rows.map((r) => [r.id, { state: r.state, owner: r.owner_session_id ?? null }]));
}
