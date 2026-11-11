// The reclaim predicate of lane.mjs, with the table alias as a parameter. Pure: no I/O.
// Source of truth today: ALIVE_AT, STALE_MINUTES and RECLAIMABLE in scripts/coordination/lane.mjs (about :352-373).
// contract-seam.test.mjs compares this text with lane.mjs source, so a change there fails a test here.
// Card 4 may move the predicate into a pure module; then this copy is replaced by an import.

export const STALE_MINUTES = 5;

const ALIAS = /^[a-z_][a-z0-9_]*$/;
const PREFIX = /^(?:[a-z_][a-z0-9_]*\.)?$/;

// Same calling convention as lane.mjs: the argument is a column prefix WITH the dot, e.g. ALIVE_AT('s.').
export function ALIVE_AT(prefix = '') {
  if (!PREFIX.test(prefix)) throw new Error(`liveness: bad column prefix ${JSON.stringify(prefix)}`);
  return `GREATEST(${prefix}last_heartbeat, ${prefix}last_activity_at)`;
}

// BOTH conditions: an expired lease on a live session is slow, and a dead session inside its lease is dead.
export function reclaimableSql(alias) {
  if (!ALIAS.test(alias)) throw new Error(`liveness: bad alias ${JSON.stringify(alias)}`);
  return `(
  ${alias}.owner_session_id IS NULL
  OR (
    (${alias}.lease_expires_at IS NULL OR ${alias}.lease_expires_at < now())
    AND NOT EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = ${alias}.owner_session_id
        AND ${ALIVE_AT('s.')} > now() - interval '${STALE_MINUTES} minutes'
    )
  )
)`;
}
