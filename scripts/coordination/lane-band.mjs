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
