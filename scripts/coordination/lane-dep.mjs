/**
 * lane-dep -- the SQL builders for lane dependencies. Pure: no I/O, no database.
 *
 * A lane is MET when its state is 'done' and its latest lifecycle event is a done event with a 40-hex
 * detail.merged. A lane has an OPEN dependency when one of its lane_dep edges points at a lane that is not met.
 *
 *   landedShaSql(a)   scalar: the merged SHA of the latest lifecycle event of lane a, or NULL
 *   laneMetSql(a)     boolean: lane a is met; true or false, never NULL
 *   openDepSql(a)     boolean: lane a has at least one edge that is not met
 *   waitsOnSql(a)     text[]: the ids of the open edges of lane a, sorted; '{}' when none
 *   lifecycleWhere(a) boolean on a lane_event alias: the row is a lifecycle event
 *
 * `a` is the alias of agentic_os.lane (lane_event for lifecycleWhere). It must match ^[a-z_][a-z0-9_]*$ and
 * must not start with `ld_`: the inner aliases are ld_d, ld_x and ld_e, and a caller alias must not shadow them.
 * The inner calls bypass that refusal.
 *
 * TWIN: .claude/hooks/src/shared/lane-dep.ts (hooks cannot import from scripts/). Change both in one commit.
 * The vitest file lane-dep-twin.test.ts fails when they drift.
 * Contract: .claudedocs/re-execution/contracts/t2.1-contract.md, "Point 4".
 */

const ALIAS_RE = /^[a-z_][a-z0-9_]*$/;

/** Return `alias` when it is a plain SQL identifier that does not start with ld_. Throws otherwise. */
function checkAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS_RE.test(alias) || alias.startsWith('ld_')) {
    throw new Error(`lane-dep: bad alias "${alias}"`);
  }
  return alias;
}

// Internal builders: no alias check, so they can use the inner aliases. Only the public functions check.
const lifecycle = (a) =>
  `(${a}.kind IN ('done','state_changed') OR (${a}.kind = 'kanban' AND ${a}.detail->>'kind' = 'state'))`;

const landedSha = (a) =>
  `(SELECT ld_e.detail->>'merged' FROM agentic_os.lane_event ld_e WHERE ld_e.lane_id = ${a}.id AND ` +
  `${lifecycle('ld_e')} ORDER BY ld_e.id DESC LIMIT 1)`;

const laneMet = (a) => `(${a}.state = 'done' AND COALESCE(${landedSha(a)} ~ '^[0-9a-f]{40}$', false))`;

/** The one definition of "open edge", shared by openDepSql and waitsOnSql. */
const openEdgeWhere = (a) =>
  `ld_d.lane_id = ${a}.id AND NOT EXISTS (SELECT 1 FROM agentic_os.lane ld_x WHERE ld_x.id = ld_d.depends_on ` +
  `AND ld_x.project_key = ld_d.project_key AND ${laneMet('ld_x')})`;

/** Scalar SQL: the merged SHA of the latest lifecycle event of lane `alias`, or NULL. */
export function landedShaSql(alias) {
  return landedSha(checkAlias(alias));
}

/** Boolean SQL: lane `alias` is met. True or false, never NULL. */
export function laneMetSql(alias) {
  return laneMet(checkAlias(alias));
}

/** Boolean SQL: lane `alias` has at least one edge that is not met. */
export function openDepSql(alias) {
  return `EXISTS (SELECT 1 FROM agentic_os.lane_dep ld_d WHERE ${openEdgeWhere(checkAlias(alias))})`;
}

/** text[] SQL: the ids of the open edges of lane `alias`, sorted. '{}' when none. */
export function waitsOnSql(alias) {
  return `ARRAY(SELECT ld_d.depends_on FROM agentic_os.lane_dep ld_d WHERE ${openEdgeWhere(checkAlias(alias))} ` +
    'ORDER BY ld_d.depends_on)';
}

/** Boolean SQL on a lane_event alias: the row is a lifecycle event (done, state_changed, or a kanban state tap). */
export function lifecycleWhere(alias) {
  return lifecycle(checkAlias(alias));
}
