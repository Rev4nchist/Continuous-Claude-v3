/**
 * The shared sort key for open lanes, as an ORDER BY fragment. Pure: no database.
 *
 * Key: band (P0, P1, P2, then NULL = Unsorted), due_at (NULL last), priority (the drag rank inside a
 * band), id. Callers add their own state filter.
 *
 * COPY of laneOrderSql in scripts/coordination/lane-sort.mjs (the app cannot import from scripts/).
 * Change both in one commit. .claude/hooks/src/__tests__/lane-sort-twin.test.ts fails when they drift.
 *
 * It reads the real columns <alias>.band and <alias>.due_at (migration 0005 is the floor).
 * `alias` must be a plain SQL identifier (a table alias or `lane`), never user input.
 */
export function laneOrderSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`laneOrderSql: bad alias ${JSON.stringify(alias)}`);
  return `CASE ${alias}.band WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, ` +
    `${alias}.due_at ASC NULLS LAST, ${alias}.priority, ${alias}.id`;
}
