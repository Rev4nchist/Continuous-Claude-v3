import { expect, test } from '@playwright/test';

import { TOKEN, countListed, type ListedIds } from '../src/lib/listed-id-mask';
import { LISTED_IDS_MESSAGE, ListedIdsUnavailable, maskSnapshot } from '../src/lib/snapshot-mask';
import { safeMessage } from '../src/server/sources/safe-message';
import { IDS, KEY, PR, SHA } from './listed-id-fixtures';

/**
 * The boundary mask of the mission-control snapshot (card agentic-os-listed-id-mask): every string VALUE and every KEY of the one object
 * that the page and the poll send is masked, and an unreadable or empty list stops the snapshot (the route turns the throw into a 503).
 * Pure Node, made-up ids only. Each test names the source change that breaks it.
 */

const LIST: ListedIds = { ok: true, ids: IDS };
const line = (n: number) => `lane ${n} note: see PR ${PR}, ${KEY} and ${SHA}`;

/** A snapshot-shaped object: a listed id sits in a text field of every section, deep, in a list, in a list of lists and in a key. */
const snapshot = () => ({
  fleet: { projects: [{ name: line(1), sessions: 3 }] },
  cards: [{ id: 'c1', title: line(2), chip: 'working', pr: { title: line(3) } }],
  coord: { parks: [{ laneId: 'x', title: line(4) }], note: null },
  board: { lanes: [{ id: 'l', title: line(5), tags: [line(6), 'plain'] }] },
  [`by key ${KEY}`]: { deep: [[line(7)]] },
  tiles: { liveSessions: 4, healthy: true, none: null },
  generatedAt: '2026-11-25T15:00:00.000Z',
});

/** Every string value and every key of a JSON-shaped value. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      strings(v, out);
    }
  }
  return out;
}

test.describe('maskSnapshot', () => {
  test('N1 no listed id is left in any string value or key, at any depth', () => {
    // Breaks when a section is skipped, an array is not walked, or a key is not masked: the one place every snapshot field passes.
    const input = snapshot();
    expect(countListed(strings(input).join('\n'), IDS), 'the fixture must hold ids to begin with').toBeGreaterThan(0);
    const { value, masked } = maskSnapshot(input, LIST);
    expect(masked).toBeGreaterThanOrEqual(8);
    for (const s of strings(value)) expect(countListed(s, IDS), 'a string still holds a listed id').toBe(0);
    expect(strings(value).join('\n')).toContain(TOKEN);
  });

  test('N2 numbers, booleans, null, plain strings and the shape are kept, and the input is not changed', () => {
    // Breaks when the walk rewrites non-text values, drops a field, or masks the caller's object in place.
    const input = snapshot();
    const before = JSON.stringify(input);
    const { value } = maskSnapshot(input, LIST);
    expect(JSON.stringify(input)).toBe(before);
    expect(value.tiles).toEqual({ liveSessions: 4, healthy: true, none: null });
    expect(value.generatedAt).toBe('2026-11-25T15:00:00.000Z');
    expect(value.cards[0].chip).toBe('working');
    expect(value.cards[0].id).toBe('c1');
    expect(value.board.lanes[0].tags[1]).toBe('plain');
    expect(Object.keys(value)).toHaveLength(Object.keys(input).length);
  });

  test('N3 a snapshot with no listed id comes back equal, with a count of 0', () => {
    const clean = { cards: [{ id: 'a', title: 'the lane waits on the seat' }], tiles: { n: 1 } };
    expect(maskSnapshot(clean, LIST)).toEqual({ value: clean, masked: 0 });
  });

  test('N4 two keys that mask to the same text both stay', () => {
    // Breaks when a masked key overwrites another: data would vanish from the snapshot.
    const { value } = maskSnapshot({ [`PR ${PR}`]: 1, [`pr ${PR}`]: 2 } as Record<string, number>, LIST);
    expect(Object.values(value).sort()).toEqual([1, 2]);
  });

  test('N5 a PR number after seven spaces is masked too (the reader view, as on the board page)', () => {
    const { value } = maskSnapshot({ title: `see PR${' '.repeat(7)}${PR} now` }, LIST);
    expect(countListed(value.title, IDS)).toBe(0);
  });
});

test.describe('fail closed: an unreadable or empty list stops the snapshot', () => {
  const refusals: [string, ListedIds][] = [
    ['absent', { ok: false, reason: 'absent' }],
    ['bad', { ok: false, reason: 'bad' }],
    ['empty', { ok: false, reason: 'empty' }],
    ['an ok list with no ids', { ok: true, ids: [] }],
  ];

  for (const [label, list] of refusals) {
    test(`N6 ${label}: maskSnapshot throws one fixed message and returns nothing`, () => {
      // Breaks when an unreadable or empty list lets the snapshot through unmasked ("0 ids, all clear").
      let thrown: unknown = null;
      try {
        maskSnapshot(snapshot(), list);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ListedIdsUnavailable);
      expect((thrown as Error).message).toBe(LISTED_IDS_MESSAGE);
      expect(countListed((thrown as Error).message, IDS)).toBe(0);
    });
  }

  test('N7 the route text for the throw is the fixed message (safeMessage keeps it)', () => {
    // Breaks when the message is reworded into something safeMessage clips or hides: the 503 would carry no reason.
    expect(safeMessage(new ListedIdsUnavailable())).toContain(LISTED_IDS_MESSAGE);
  });
});
