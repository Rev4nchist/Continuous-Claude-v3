/**
 * The lane-dashboard export for the Flow tab (PR E4): validate the rows of `flow.json` and `factory.json`, group
 * them into cards and join each bar to its day.
 *
 * Each file is `{ <query text>, exportedAt, rows }`. Only `exportedAt` and `rows` are read, by name. The rest of the
 * file, the query text included, never reaches the result. The result is built field by field, never by spreading
 * the parsed file.
 *
 * Pure on purpose: no imports at all and no `server-only`, so the hooks vitest
 * (.claude/hooks/src/__tests__/lane-dash-parse.test.ts) can load it by file URL. The file reader
 * (src/server/sources/lane-dash.ts) opens the file, parses the JSON and passes `clean` (strip, redact and clip an
 * id), `cleanText` (the same for a text; it defaults to `clean`, but the reader gives it a larger cap than an id)
 * and `dayOf` (the Chicago day of an epoch-ms time). This module never touches the disk or the clock.
 *
 * Rules:
 *   - A file that is not an object, or has no `rows` array, is "absent": the tab says "Flow export not found."
 *   - A row has seven columns: id, tile, kind, rank, value, text, tone. A row with a missing column or a wrong
 *     type is skipped and counted, never thrown on. `rank`, `value`, `text` and `tone` may be null.
 *   - Kinds: figure, text, day, bar. Any other kind (the schema also names chip, row and tick for tiles.json) is
 *     skipped and counted.
 *   - Tone: neutral, ok, warn, bad or null. An unknown tone STRING reads as null and the row stays. A tone that is
 *     not a string or null is a wrong type: the row is skipped.
 *   - A day or bar row needs an integer rank from 1 up. Rank 14 is the day of the export; rank r is that day
 *     minus (14 - r) days. The day of the export is the Chicago day of `exportedAt`, so a file written at 23:55
 *     Chicago time is a day behind the clock, as the rows themselves are.
 *   - A card is every row with the same first id segment, in first-seen order. Its `<prefix>.summary` text row is
 *     the summary and leaves the list. A bar series is the bar ids without the rank (`flow.bar.3.done` and
 *     `flow.bar.4.done` are one series, `flow.bar.done`), sorted by rank.
 *   - Rows past MAX_ROWS are not read and count as skipped.
 */

const HIDDEN_PREFIX = 'factory';

export type FlowTone ='neutral' | 'ok' | 'warn' | 'bad';

/** A figure or text row: a label and a value. */
export type FlowRowView = {
  id: string;
  kind: 'figure' | 'text';
  value: number | null;
  text: string | null;
  tone: FlowTone | null;
};

/** A bar or day row inside a series. `label` is the day (a bar) or the row text (a day row). */
export type FlowBarView = {
  id: string;
  rank: number;
  label: string;
  value: number | null;
  text: string | null;
  tone: FlowTone | null;
};

export type FlowSeriesView = { key: string; rows: FlowBarView[] };

export type FlowCardView = {
  prefix: string;
  summary: string | null;
  rows: FlowRowView[];
  series: FlowSeriesView[];
};

export type FlowFileName = 'flow' | 'factory';

export type FlowFileView = {
  name: FlowFileName;
  status: 'ok' | 'absent';
  /** ISO-8601 UTC, normalised. Null when the file has none, or a string that is not a time. */
  exportedAt: string | null;
  cards: FlowCardView[];
  skipped: number;
};

export type FlowView = { files: FlowFileView[] };

export const MAX_ROWS = 5000;
const TODAY_RANK = 14;
const TONES: readonly string[] = ['neutral', 'ok', 'warn', 'bad'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;
const BAR_ID = /^(.*)\.bar\.(\d+)(?:\.(.+))?$/;

type Clean = (text: string) => string | null;
type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));

/** `YYYY-MM-DD` plus `days` (negative goes back). UTC arithmetic on the date only, so no zone or DST can shift it. */
export function addDays(iso: string, days: number): string {
  const match = DAY_FORMAT.exec(iso);
  if (match === null) return iso;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** "Nov 8" from `YYYY-MM-DD`. A string of another format comes back unchanged. */
export function dayLabel(iso: string): string {
  const match = DAY_FORMAT.exec(iso);
  if (match === null) return iso;
  return `${MONTHS[Number(match[2]) - 1] ?? '?'} ${Number(match[3])}`;
}

/** The row as the view holds it, or null for a skipped row. `bar` and `day` rows keep a `rank`. */
type Checked = {
  id: string;
  kind: 'figure' | 'text' | 'day' | 'bar';
  rank: number | null;
  value: number | null;
  text: string | null;
  tone: FlowTone | null;
};

function checkRow(raw: unknown, clean: Clean, cleanText: Clean): Checked | null {
  if (!isObject(raw)) return null;
  const { id, tile, kind, rank, value, text, tone } = raw;
  if (typeof id !== 'string' || id === '' || typeof tile !== 'string') return null;
  if (kind !== 'figure' && kind !== 'text' && kind !== 'day' && kind !== 'bar') return null;
  if (!isNumberOrNull(rank) || !isNumberOrNull(value)) return null;
  if (text !== null && typeof text !== 'string') return null;
  if (tone !== null && typeof tone !== 'string') return null;
  const cleanId = clean(id);
  if (cleanId === null) return null;
  if ((kind === 'day' || kind === 'bar') && (rank === null || !Number.isInteger(rank) || rank < 1)) return null;
  return {
    id: cleanId,
    kind,
    rank,
    value,
    text: text === null ? null : cleanText(text),
    tone: tone !== null && TONES.includes(tone) ? (tone as FlowTone) : null,
  };
}

/** The series key: the id without its rank. `flow.bar.3.done` -> `flow.bar.done`; `flow.day.3` -> `flow.day`. */
function seriesKey(id: string, kind: 'day' | 'bar'): string {
  if (kind === 'bar') {
    const match = BAR_ID.exec(id);
    if (match !== null) return match[3] === undefined ? `${match[1]}.bar` : `${match[1]}.bar.${match[3]}`;
  }
  return id.replace(/\.\d+$/, '');
}

function exportedAtOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function emptyCard(prefix: string): FlowCardView {
  return { prefix, summary: null, rows: [], series: [] };
}

function addRow(card: FlowCardView, row: Checked, today: string | null): void {
  if (row.kind === 'figure' || row.kind === 'text') {
    if (row.kind === 'text' && row.id === `${card.prefix}.summary`) card.summary = row.text;
    else card.rows.push({ id: row.id, kind: row.kind, value: row.value, text: row.text, tone: row.tone });
    return;
  }
  const rank = row.rank as number;
  const label =
    row.kind === 'bar'
      ? today === null
        ? `day ${rank}`
        : dayLabel(addDays(today, rank - TODAY_RANK))
      : (row.text ?? `day ${rank}`);
  const key = seriesKey(row.id, row.kind);
  let series = card.series.find((s) => s.key === key);
  if (series === undefined) {
    series = { key, rows: [] };
    card.series.push(series);
  }
  series.rows.push({ id: row.id, rank, label, value: row.value, text: row.text, tone: row.tone });
}

export function parseLaneDashFile(
  name: FlowFileName,
  raw: unknown,
  clean: Clean,
  dayOf: (ms: number) => string,
  cleanText: Clean = clean,
): FlowFileView {
  const absent: FlowFileView = { name, status: 'absent', exportedAt: null, cards: [], skipped: 0 };
  if (!isObject(raw)) return absent;
  const { exportedAt: rawTime, rows } = raw;
  if (!Array.isArray(rows)) return absent;
  const exportedAt = exportedAtOf(rawTime);
  const today = exportedAt === null ? null : dayOf(Date.parse(exportedAt));

  const cards: FlowCardView[] = [];
  let skipped = Math.max(0, rows.length - MAX_ROWS);
  for (const item of rows.slice(0, MAX_ROWS)) {
    const row = checkRow(item, clean, cleanText);
    if (row === null) {
      skipped += 1;
      continue;
    }
    const prefix = row.id.split('.')[0];
    // The factory prefix holds only meta rows (days, today, day.N): no card. A valid row, so not skipped.
    if (prefix === HIDDEN_PREFIX) continue;
    let card = cards.find((c) => c.prefix === prefix);
    if (card === undefined) {
      card = emptyCard(prefix);
      cards.push(card);
    }
    addRow(card, row, today);
  }
  for (const card of cards) for (const series of card.series) series.rows.sort((a, b) => a.rank - b.rank);
  return { name, status: 'ok', exportedAt, cards, skipped };
}
