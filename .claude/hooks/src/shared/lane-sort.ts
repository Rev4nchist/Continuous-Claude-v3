/**
 * lane-sort -- the ONE sort key for open lanes (TypeScript twin). Pure: no I/O, no database.
 *
 * Key: band (P0 = 0, P1 = 1, P2 = 2, NULL = 3, "Unsorted"), then due_at (NULL last), then priority
 * (the drag rank inside a band), then id. Open means state <> 'done'.
 *
 * TWIN: scripts/coordination/lane-sort.mjs (hooks cannot import from scripts/). Change both in one
 * commit. __tests__/lane-sort-twin.test.ts fails when they drift.
 * Design: .claudedocs/2026-11-06-lane-priority-design.md, "Data model" and "Build phases", phase 3.
 */

export interface SortableLane {
  band?: string | null;
  due_at?: string | Date | null;
  priority: number;
  id: string;
  state?: string;
}

/** Rank of a band. P0 first. Anything else, including NULL and undefined, is Unsorted and sorts last. */
export function bandRank(band?: string | null): number {
  return band === 'P0' ? 0 : band === 'P1' ? 1 : band === 'P2' ? 2 : 3;
}

/** Short tag shown before a lane id: "P0", "P1", "P2", or "--" for Unsorted. */
export function bandTag(band?: string | null): string {
  return bandRank(band) === 3 ? '--' : (band as string);
}

const dueMs = (v: string | Date | null | undefined): number => {
  if (v === null || v === undefined || v === '') return Infinity;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(t) ? Infinity : t;
};

/** Comparator for two lane rows. A row with no band reads as Unsorted, so the old priority order still holds. */
export function compareLanes(a: SortableLane, b: SortableLane): number {
  const byBand = bandRank(a.band) - bandRank(b.band);
  if (byBand) return byBand;
  const da = dueMs(a.due_at);
  const db = dueMs(b.due_at);
  if (da !== db) return da < db ? -1 : 1;
  if (a.priority !== b.priority) return a.priority < b.priority ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Open lanes (state <> 'done') in the shared order. Returns a new array. */
export function sortOpenLanes<T extends SortableLane>(rows: T[]): T[] {
  return rows.filter((l) => l.state !== 'done').sort(compareLanes);
}

/**
 * The ORDER BY fragment (no "ORDER BY" keyword) for a lane table or alias, e.g. `laneOrderSql('l')`.
 *
 * It reads the real columns <alias>.band and <alias>.due_at (migration 0005 is the floor).
 * `alias` must be a plain SQL identifier (a table alias or `lane`), never user input.
 */
export function laneOrderSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`laneOrderSql: bad alias ${JSON.stringify(alias)}`);
  return `CASE ${alias}.band WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, ` +
    `${alias}.due_at ASC NULLS LAST, ${alias}.priority, ${alias}.id`;
}
