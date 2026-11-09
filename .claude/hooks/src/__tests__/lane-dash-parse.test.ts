/**
 * Flow tab parser (PR E4): `parseLaneDashFile`, `addDays` and `dayLabel` in
 * apps/agentic-os/src/server/queries/lane-dash-parse.ts, and the real `cdtDay` of spend-fold.ts.
 * Both files are pure (no `server-only`, no value imports), so this runner loads them by file URL, as
 * spend-fold-view.test.ts does. The file reader (src/server/sources/lane-dash.ts) imports `server-only`; only
 * apps/agentic-os/e2e/flow.spec.ts reaches it.
 *
 * Each case names the change that breaks it:
 *   1  the result built by spreading the parsed file (a `sql` key or a extra column would reach the DTO)
 *   2  a row with a string `value`, a missing column or a wrong-type column kept, or skipped without the count
 *   3  a `null` text, rank or value rejected (real figure and text rows carry null rank and value)
 *   4  an unknown tone dropped as a bad row, or kept as a string; a non-string tone kept
 *   5  an unknown kind kept, or thrown on
 *   6  a file that is not an object, or has no `rows` array, read as an empty ok file (the tab must say "not found")
 *   7  exportedAt shown as given (a hostile or invalid string) in place of a normalised ISO time or null
 *   8  text, ids not passed through `clean`; a row whose clean text is null kept with the raw text
 *   9  grouping by a fixed prefix list (a new prefix would vanish), or the summary not first and not removed from the list
 *  10  bar series keyed by the full id (14 one-row series), or the rank left in file order
 *  11  a bar or day row with no integer rank kept
 *  12  the day join: rank 14 is not today, rank 1 is not today minus 13, a month or year edge, a 29 Feb
 *  13  the "today" taken from Date.now() (a stale export would show today's date), not from the file's own time
 *  14  no row cap: a file of 100000 rows would be walked whole
 *  15  text cleaned with the id function (a sentence clipped at the id cap, as flow.summary was at 160)
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

type Tone = 'neutral' | 'ok' | 'warn' | 'bad';
type RowView = { id: string; kind: 'figure' | 'text'; value: number | null; text: string | null; tone: Tone | null };
type BarView = { id: string; rank: number; label: string; value: number | null; text: string | null; tone: Tone | null };
type Card = { prefix: string; summary: string | null; rows: RowView[]; series: { key: string; rows: BarView[] }[] };
type FileView = {
  name: 'flow' | 'factory';
  status: 'ok' | 'absent';
  exportedAt: string | null;
  cards: Card[];
  skipped: number;
};
type Parse = {
  parseLaneDashFile: (
    name: 'flow' | 'factory',
    raw: unknown,
    clean: (text: string) => string | null,
    dayOf: (ms: number) => string,
    cleanText?: (text: string) => string | null,
  ) => FileView;
  addDays: (iso: string, days: number) => string;
  dayLabel: (iso: string) => string;
  MAX_ROWS: number;
};
type Fold = { cdtDay: (ms: number) => string };

const url = (rel: string): string => pathToFileURL(path.resolve(__dirname, rel)).href;
const p: Parse = await import(
  /* @vite-ignore */ url('../../../../apps/agentic-os/src/server/queries/lane-dash-parse.ts')
);
const fold: Fold = await import(
  /* @vite-ignore */ url('../../../../apps/agentic-os/src/server/queries/spend-fold.ts')
);

const keep = (text: string): string | null => text;
const row = (id: string, kind: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  tile: 'flow',
  kind,
  rank: null,
  value: null,
  text: 'x',
  tone: null,
  ...patch,
});
const file = (rows: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  exportedAt: '2026-11-09T18:30:02.598Z',
  rows,
  ...extra,
});
const parse = (raw: unknown, clean = keep): FileView => p.parseLaneDashFile('flow', raw, clean, fold.cdtDay);

describe('lane-dash-parse', () => {
  it('1 never copies anything but exportedAt and rows into the result', () => {
    const key = ['s', 'q', 'l'].join('');
    const canary = 'CANARY-do-not-show-9f31';
    const out = parse(file([row('flow.days', 'figure', { value: 14, text: '14', extra: canary })], { [key]: canary }));
    expect(JSON.stringify(out)).not.toContain(canary);
    expect(Object.keys(out).sort()).toEqual(['cards', 'exportedAt', 'name', 'skipped', 'status']);
  });

  it('2 skips and counts a string value, a missing column and a wrong-type column', () => {
    const missingTone: Record<string, unknown> = row('flow.c', 'figure');
    delete missingTone.tone;
    const out = parse(
      file([
        row('flow.ok', 'figure', { value: 3 }),
        row('flow.str', 'figure', { value: '3' }),
        missingTone,
        row('flow.badtext', 'text', { text: 5 }),
        row('flow.badrank', 'figure', { rank: '2' }),
        row('flow.nan', 'figure', { value: Number.NaN }),
        row('', 'figure'),
        row('flow.badtile', 'figure', { tile: 7 }),
        'not a row',
        null,
      ]),
    );
    expect(out.skipped).toBe(9);
    expect(out.cards.flatMap((c) => c.rows.map((r) => r.id))).toEqual(['flow.ok']);
  });

  it('3 accepts null text, rank and value', () => {
    const out = parse(file([row('flow.a', 'figure', { text: null })]));
    expect(out.skipped).toBe(0);
    expect(out.cards[0].rows[0]).toMatchObject({ value: null, text: null });
  });

  it('4 maps an unknown tone string to null and keeps the row; skips a non-string tone', () => {
    const out = parse(
      file([
        row('flow.w', 'figure', { tone: 'warn' }),
        row('flow.u', 'figure', { tone: 'loud' }),
        row('flow.n', 'figure', { tone: 5 }),
      ]),
    );
    const tones = Object.fromEntries(out.cards[0].rows.map((r) => [r.id, r.tone]));
    expect(tones).toEqual({ 'flow.w': 'warn', 'flow.u': null });
    expect(out.skipped).toBe(1);
  });

  it('5 skips and counts an unknown kind', () => {
    const out = parse(file([row('flow.chip', 'chip'), row('flow.a', 'text')]));
    expect(out.skipped).toBe(1);
    expect(out.cards[0].rows.map((r) => r.id)).toEqual(['flow.a']);
  });

  it('6 reads a non-object file, or a file with no rows array, as absent', () => {
    for (const raw of [null, 'text', 7, [], { exportedAt: '2026-11-09T00:00:00Z' }, { rows: 'x' }, { rows: {} }]) {
      expect(parse(raw)).toMatchObject({ status: 'absent', cards: [], skipped: 0, exportedAt: null });
    }
  });

  it('7 normalises exportedAt to ISO, and a string that is not a time to null', () => {
    expect(parse(file([])).exportedAt).toBe('2026-11-09T18:30:02.598Z');
    expect(parse(file([], { exportedAt: '<script>alert(1)</script>' })).exportedAt).toBeNull();
    expect(parse(file([], { exportedAt: 123 })).exportedAt).toBeNull();
  });

  it('8 passes every id and text through clean; a null clean result clears the text or skips the id', () => {
    const clean = (text: string): string | null => (text === 'drop' ? null : text.replace('secret', '<redacted>'));
    const out = parse(file([row('flow.a', 'text', { text: 'a secret' }), row('flow.b', 'text', { text: 'drop' })]), clean);
    expect(out.cards[0].rows.map((r) => r.text)).toEqual(['a <redacted>', null]);
    const skipped = parse(file([row('drop', 'text')]), clean);
    expect(skipped.skipped).toBe(1);
  });

  it('9b the factory prefix (meta rows only) makes no card and no skipped count', () => {
    const out = parse(
      file([
        row('factory.days', 'figure', { value: 14, text: '14' }),
        row('factory.day.14', 'day', { rank: 14, text: '2026-11-08' }),
        row('hand.week.total', 'figure', { value: 59, text: '59' }),
      ]),
    );
    expect(out.cards.map((c) => c.prefix)).toEqual(['hand']);
    expect(out.skipped).toBe(0);
  });

  it('9 groups by the first id segment, in first-seen order, with the summary first and out of the list', () => {
    const out = parse(
      file([
        row('hand.week.total', 'figure', { value: 59, text: '59' }),
        row('hand.summary', 'text', { text: 'handoffs summary' }),
        row('zzz.new', 'text', { text: 'a new prefix' }),
        row('hand.today.total', 'figure', { value: 16, text: '16' }),
      ]),
    );
    expect(out.cards.map((c) => c.prefix)).toEqual(['hand', 'zzz']);
    expect(out.cards[0].summary).toBe('handoffs summary');
    expect(out.cards[0].rows.map((r) => r.id)).toEqual(['hand.week.total', 'hand.today.total']);
    expect(out.cards[1].summary).toBeNull();
  });

  it('10 keys a bar series by the id without its rank, and sorts it by rank', () => {
    const out = parse(
      file([
        row('flow.bar.3.claimed', 'bar', { rank: 3, value: 3, text: 'Claimed' }),
        row('flow.bar.1.claimed', 'bar', { rank: 1, value: 1, text: 'Claimed' }),
        row('flow.bar.2.done', 'bar', { rank: 2, value: 9, text: 'Done' }),
        row('prpr.prs.landed.bar.14', 'bar', { rank: 14, value: 2, text: 'Landed' }),
        row('flow.day.2', 'day', { rank: 2, value: 5, text: 'Oct 28' }),
        row('flow.day.1', 'day', { rank: 1, value: 4, text: 'Oct 27' }),
      ]),
    );
    const flow = out.cards.find((c) => c.prefix === 'flow')!;
    expect(flow.series.map((s) => s.key)).toEqual(['flow.bar.claimed', 'flow.bar.done', 'flow.day']);
    expect(flow.series[0].rows.map((r) => r.rank)).toEqual([1, 3]);
    expect(flow.series[2].rows.map((r) => r.label)).toEqual(['Oct 27', 'Oct 28']);
    expect(out.cards.find((c) => c.prefix === 'prpr')!.series[0].key).toBe('prpr.prs.landed.bar');
    expect(flow.rows).toEqual([]);
  });

  it('11 skips a bar or day row with no integer rank from 1 up', () => {
    const out = parse(
      file([
        row('flow.bar.x.claimed', 'bar', { rank: null }),
        row('flow.bar.1.claimed', 'bar', { rank: 1.5 }),
        row('flow.bar.0.claimed', 'bar', { rank: 0 }),
        row('flow.day.1', 'day', { rank: null }),
      ]),
    );
    expect(out.skipped).toBe(4);
    expect(out.cards).toEqual([]);
  });

  it('12 joins a bar to its day: rank 14 is today, rank r is today minus (14 - r)', () => {
    // 2026-11-09 18:30 UTC is 12:30 on 2026-11-09 in Chicago.
    const out = parse(
      file([
        row('flow.bar.14.done', 'bar', { rank: 14, value: 1 }),
        row('flow.bar.13.done', 'bar', { rank: 13, value: 1 }),
        row('flow.bar.9.done', 'bar', { rank: 9, value: 1 }),
        row('flow.bar.1.done', 'bar', { rank: 1, value: 1 }),
      ]),
    );
    expect(out.cards[0].series[0].rows.map((r) => r.label)).toEqual(['Oct 27', 'Nov 4', 'Nov 8', 'Nov 9']);
    expect(p.addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(p.addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(p.addDays('2026-01-02', -13)).toBe('2025-12-20');
    expect(p.addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(p.dayLabel('2026-11-08')).toBe('Nov 8');
  });

  it('13 takes today from the file time: a file exported just before midnight Chicago time is a day behind', () => {
    // 2026-11-09T05:55:01Z is 23:55 on 2026-11-08 in Chicago (the real factory.json).
    const out = p.parseLaneDashFile(
      'factory',
      file([row('prpr.bar.14.runs', 'bar', { rank: 14, value: 1 })], { exportedAt: '2026-11-09T05:55:01.879Z' }),
      keep,
      fold.cdtDay,
    );
    expect(out.cards[0].series[0].rows[0].label).toBe('Nov 8');
  });

  it('14 stops at the row cap and counts the rest as skipped', () => {
    const rows = Array.from({ length: p.MAX_ROWS + 50 }, (_, i) => row(`flow.r${i}`, 'figure'));
    const out = parse(file(rows));
    expect(out.cards[0].rows.length).toBe(p.MAX_ROWS);
    expect(out.skipped).toBe(50);
  });

  it('15 cleans ids with the id function and every text with the text function', () => {
    const idClean = (text: string): string | null => text.slice(0, 12);
    const textClean = (text: string): string | null => text.slice(0, 40);
    const long = 'w'.repeat(100);
    const out = p.parseLaneDashFile(
      'flow',
      file([
        row('flow.summary', 'text', { text: long }),
        row('flow.some.long.id.here', 'figure', { value: 1, text: long }),
        row('flow.bar.14.done', 'bar', { rank: 14, value: 1, text: long }),
      ]),
      idClean,
      fold.cdtDay,
      textClean,
    );
    const card = out.cards[0];
    expect(card.summary).toBe('w'.repeat(40));
    expect(card.rows[0].id).toBe('flow.some.lo');
    expect(card.rows[0].text).toBe('w'.repeat(40));
    expect(card.series[0].rows[0].text).toBe('w'.repeat(40));
  });
});
