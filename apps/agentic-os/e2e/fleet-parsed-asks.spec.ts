import { expect, test } from '@playwright/test';

import { LIVE_WINDOW_MINUTES, countedAsks, type CountedAsk } from '../src/server/queries/fleet-card-fields';

/**
 * Card fleet-stale-parsed-asks. A parsed closing-line ask (source parsed) is only a guess from the last turn's text.
 * The mod chip already ignores it. The Fleet card, the Ready for Dave row and the Needs Dave tile read `countedAsks`,
 * so a session that works on a peer or timer prompt must not show as waiting on Dave because of an older parsed ask.
 * Rule (seat GO 2026-11-26): a parsed ask does not count while the chip is `working` and the snapshot is inside the Live window.
 * A brief_set ask always counts. Every other chip, no chip, or a working chip on an old snapshot counts every unanswered ask.
 * Pure spec: it imports the real helper and the real Live window, no server and no database.
 */

const asked = (text: string, source: CountedAsk['source'], answered = false): CountedAsk & { text: string } => ({ text, source, answered });
const FRESH = 10;
const WINDOW_SECONDS = LIVE_WINDOW_MINUTES * 60;
const texts = (rows: readonly { text: string }[]): string[] => rows.map((row) => row.text);

test.describe('countedAsks: a parsed ask while the session works', () => {
  test('F1 a working chip hides a parsed ask', () => {
    expect(countedAsks([asked('parsed one', 'parsed')], 'working', FRESH)).toEqual([]);
  });

  test('F2 a working chip keeps a brief_set ask', () => {
    expect(texts(countedAsks([asked('set one', 'brief_set')], 'working', FRESH))).toEqual(['set one']);
  });

  test('F3 a working chip with a brief_set ask first and a parsed ask second counts only the brief_set ask', () => {
    const rows = countedAsks([asked('set one', 'brief_set'), asked('parsed two', 'parsed')], 'working', FRESH);
    expect(texts(rows)).toEqual(['set one']);
  });

  test('F3b a working chip with a parsed ask first and a brief_set ask second: the brief_set ask is the first row', () => {
    const rows = countedAsks([asked('parsed one', 'parsed'), asked('set two', 'brief_set')], 'working', FRESH);
    expect(texts(rows)).toEqual(['set two']);
  });

  test('F4 an idle chip counts a parsed ask', () => {
    expect(texts(countedAsks([asked('parsed one', 'parsed')], 'idle', FRESH))).toEqual(['parsed one']);
  });

  test('F5 waiting-on-dave, blocked and done chips count a parsed ask', () => {
    for (const chip of ['waiting-on-dave', 'blocked', 'done']) {
      expect(texts(countedAsks([asked('parsed one', 'parsed')], chip, FRESH))).toEqual(['parsed one']);
    }
  });

  test('F6 no chip in the snapshot counts a parsed ask', () => {
    expect(texts(countedAsks([asked('parsed one', 'parsed')], null, FRESH))).toEqual(['parsed one']);
  });

  test('F7 an answered ask never counts, working or not', () => {
    const rows = [asked('set done', 'brief_set', true), asked('parsed done', 'parsed', true)];
    expect(countedAsks(rows, 'working', FRESH)).toEqual([]);
    expect(countedAsks(rows, 'idle', FRESH)).toEqual([]);
  });

  test('F9 a working chip on a snapshot older than the Live window does not hide a parsed ask', () => {
    // A crashed or closed session can leave the chip at working: the old file must not hide the question.
    expect(texts(countedAsks([asked('parsed one', 'parsed')], 'working', WINDOW_SECONDS + 1))).toEqual(['parsed one']);
  });

  test('F10 a snapshot exactly as old as the Live window still hides it, one second older does not', () => {
    expect(countedAsks([asked('parsed one', 'parsed')], 'working', WINDOW_SECONDS)).toEqual([]);
    expect(texts(countedAsks([asked('parsed one', 'parsed')], 'working', WINDOW_SECONDS + 1))).toEqual(['parsed one']);
  });

  test('F11 a working chip with no snapshot age does not hide a parsed ask', () => {
    expect(texts(countedAsks([asked('parsed one', 'parsed')], 'working', null))).toEqual(['parsed one']);
  });

  test('F12 the order of the asks is kept and the input list is not changed', () => {
    const input = Object.freeze([asked('a', 'brief_set'), asked('b', 'parsed'), asked('c', 'brief_set')]);
    expect(texts(countedAsks(input, 'working', FRESH))).toEqual(['a', 'c']);
    expect(texts(countedAsks(input, 'idle', FRESH))).toEqual(['a', 'b', 'c']);
  });

  test('F13 the Live window is the one the Live tile uses', () => {
    expect(LIVE_WINDOW_MINUTES).toBe(15);
  });
});
