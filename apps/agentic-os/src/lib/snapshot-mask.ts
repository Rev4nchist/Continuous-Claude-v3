import { maskStringWith, prepareMask, type ListedIds } from './listed-id-mask';

/**
 * The boundary mask of the mission-control snapshot (card agentic-os-listed-id-mask). PURE.
 *
 * getMissionControlSnapshot is the ONE place both the page and the poll take their data from. Every string VALUE and every KEY of the
 * snapshot passes here before it leaves, so a listed id (a holdout or gold answer-key id) cannot reach a screen through any field, today's or a
 * later one. An unreadable, absent or empty list stops the snapshot: the same rule as render-board (exit 3, no page). The route turns the throw
 * into a 503 with this fixed text, and the client keeps its last good data.
 */

export const LISTED_IDS_MESSAGE = 'the listed-id list could not be read; the snapshot is not sent';

export class ListedIdsUnavailable extends Error {
  constructor() {
    super(LISTED_IDS_MESSAGE);
    this.name = 'ListedIdsUnavailable';
  }
}

/** A copy of `value` with every listed id masked in every string value and key, and the count masked. The input is not changed. */
export function maskSnapshot<T>(value: T, list: ListedIds): { value: T; masked: number } {
  // An ok list with no id is not "all clear" either: it is a list that failed to say what it holds.
  if (!list.ok || list.ids.length === 0) throw new ListedIdsUnavailable();
  const mask = prepareMask(list.ids);
  let masked = 0;
  const text = (s: string): string => {
    const m = maskStringWith(mask, s);
    masked += m.masked;
    return m.text;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(v)) {
        let name = text(key);
        // Two keys that mask to the same text must both stay.
        for (let n = 2; Object.hasOwn(out, name); n += 1) name = `${text(key)}~${n}`;
        // defineProperty, not out[name] = ...: a key named __proto__ would run the setter and the field would be lost.
        Object.defineProperty(out, name, { value: walk(inner), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, masked };
}
