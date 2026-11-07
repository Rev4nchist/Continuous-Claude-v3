/**
 * lane-band -- pure validators for the lane `band` and `priority` writers.
 *
 * lane.mjs runs its commands at the top level, so a test cannot import from it. These two
 * functions live here and lane.mjs imports them. No I/O, no database.
 *
 * Both return `undefined` when the value was not given. That means "keep the stored value" on a
 * conflict. An invalid value throws an Error whose message is shown to the caller (exit 1), so a bad
 * value never turns into a default.
 */

/** The bands, most urgent first. `none` is the CLI word for NULL (Unsorted). */
export const BANDS = ['P0', 'P1', 'P2'];

const PRIORITY_MIN = 1;
const PRIORITY_MAX = 999;
const show = (v) => (v === true ? '(no value)' : JSON.stringify(v));

/**
 * The drag rank inside a band: a whole number from 1 to 999.
 * Accepts a flag string ("7") or a JSON number (7). `undefined` and `null` mean "not given".
 * A bare flag (`true`), an empty string, "abc", "1.5", "-3", "0x10", " 7", "1e2", 0 and 1000 all throw.
 */
export function parsePriority(raw, what = '--priority') {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) : NaN);
  if (!Number.isInteger(n) || n < PRIORITY_MIN || n > PRIORITY_MAX) {
    throw new Error(`${what} must be a whole number from ${PRIORITY_MIN} to ${PRIORITY_MAX} (got ${show(raw)})`);
  }
  return n;
}

/** A lane id: the same rule as BOARD_KEY_RE in lane.mjs (lower case letters, digits and '-', first char not '-'). */
const LANE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The `--p0` list of `band-backfill --apply`: lane ids Dave names for P0. The flag is required; zero lanes is
 * spelled `none`. `undefined` and a bare flag (`true`) throw. An empty token, a duplicate, an invalid id and
 * `none` mixed with ids all throw, so a typo never drops a lane from the list without a word.
 */
export function parseP0List(raw) {
  if (raw === undefined || raw === true) {
    throw new Error("--p0 is required: name the lane ids that get P0 (--p0 id,id,...), or --p0 none for no P0 lane");
  }
  if (typeof raw !== 'string') throw new Error(`--p0 must be a comma list of lane ids or none (got ${JSON.stringify(raw)})`);
  if (raw.trim() === 'none') return [];
  const ids = raw.split(',').map((t) => t.trim());
  const seen = new Set();
  for (const id of ids) {
    if (id === '') throw new Error(`--p0 has an empty id (got ${JSON.stringify(raw)}); remove the extra comma`);
    if (id === 'none') throw new Error("--p0: 'none' cannot be mixed with lane ids");
    if (!LANE_ID_RE.test(id)) throw new Error(`--p0: '${id}' is not a valid lane id: use lower case letters, digits and '-'`);
    if (seen.has(id)) throw new Error(`--p0 has a duplicate id '${id}'`);
    seen.add(id);
  }
  return ids;
}

/**
 * The `--expect N` of `band-backfill --apply`: how many lanes the dry run said would change. Required, a whole number from 0.
 * The apply rolls back when the plan it computes under lock has a different count.
 */
export function parseExpect(raw) {
  if (raw === undefined || raw === true) {
    throw new Error('--expect is required: run --dry-run first and copy the count from its "to apply" line (--expect N)');
  }
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) {
    throw new Error(`--expect must be a whole number from 0 (got ${show(raw)})`);
  }
  return Number(raw);
}

/**
 * The importance band. "P0", "P1" or "P2" (exact case) give themselves; "none" gives `null` (write NULL).
 * `undefined` and `null` mean "not given" (keep the stored band). Anything else throws, including "p0",
 * "P3", "NONE", an empty string and a bare flag.
 */
export function parseBand(raw, what = '--band') {
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'none') return null;
  if (typeof raw === 'string' && BANDS.includes(raw)) return raw;
  throw new Error(`${what} must be one of ${BANDS.join(', ')} or none (got ${show(raw)})`);
}
