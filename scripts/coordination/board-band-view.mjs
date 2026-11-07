/**
 * board-band-view -- pure helpers for the By band view of the phone page. No I/O, no database.
 *
 * render-board.mjs runs on load, so it cannot be imported by a test. Everything a test must reach lives here.
 * Terms follow CONTEXT.md: band = P0 | P1 | P2 | NULL (Unsorted); rank = lane.priority, the drag order inside a band.
 * The sort is the shared key in lane-sort.mjs (band, due_at, priority, id); this file never re-implements it.
 * Design: .claudedocs/2026-11-06-lane-priority-design.md, build phase 5.
 */
import { bandTag, sortOpenLanes } from './lane-sort.mjs';

/** P0 is "this week". Five is a soft cap: the page warns above it and never blocks. */
export const BAND_CAP = 5;

/** [key, heading] in page order. The key is also the data-band value. */
export const BAND_GROUPS = [['P0', 'P0 this week'], ['P1', 'P1 next'], ['P2', 'P2 later'], ['none', 'Unsorted']];

const TITLES = { P0: 'Band P0: this week', P1: 'Band P1: next', P2: 'Band P2: later', none: 'Unsorted: no band set' };

/** 'P0', 'P1' or 'P2'; anything else (NULL, undefined, junk) is 'none'. */
export const bandKey = (l) => (l && (l.band === 'P0' || l.band === 'P1' || l.band === 'P2') ? l.band : 'none');

/** The open lanes (state <> 'done') in the four groups, each in the shared sort order. Empty groups stay. */
export function groupByBand(rows) {
  const sorted = sortOpenLanes(rows);
  return BAND_GROUPS.map(([key, label]) => {
    const group = sorted.filter((l) => bandKey(l) === key);
    return { key, label, rows: group, n: group.length };
  });
}

/** The P0 count against the soft cap. */
export const capState = (n) => ({ text: `${n}/${BAND_CAP}`, over: n > BAND_CAP });

/** A band chip. Only whitelisted values reach the markup, so nothing here needs escaping. */
export function bandChipHtml(l, cls = 'bchip') {
  const key = bandKey(l);
  return `<span class="${cls}" data-band="${key}" title="${TITLES[key]}">${bandTag(key === 'none' ? null : key)}</span>`;
}
