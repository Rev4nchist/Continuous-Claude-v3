import { cleanText } from '../server/queries/lane-coord';
import { safeMessage } from '../server/sources/safe-message';

/**
 * One source row per reader (card agentic-os-readers, reader 6). PURE: no 'server-only', no '@/' import.
 *
 * The row is the app's DataSource (mission-control.ts:57-60: id, label, status, detail) plus `readAtMs` and `ageSec`.
 * The detail text holds a read time and an age, or a reason: never a path, a session id or file content.
 * A missing file is "degraded"; any other failure is "error"; data older than the row's limit is "degraded".
 */

export const READER_IDS = ['stalls', 'open-question', 'decisions', 'clock', 'tasks'] as const;
export type ReaderId = (typeof READER_IDS)[number];
export type ReaderStatus = 'ok' | 'degraded' | 'error';
export type ReaderSource = { id: ReaderId; label: string; status: ReaderStatus; detail: string; readAtMs: number; ageSec: number };
export type ReaderOutcome =
  | {
      ok: true;
      readAtMs: number;
      /** When the data itself was made (a feed export time); default: the read time. */ dataAtMs?: number | null;
      /** Older than this is degraded. */ maxAgeMs?: number;
      /** The read lost some input (a skipped file or folder): degraded, with this short reason. */ partial?: string;
    }
  | { ok: false; reason: string; readAtMs: number };

/** A data time this far ahead of the clock is still fresh; more is not trusted (the allowance of pr-feed-parse.ts:262). */
const FUTURE_SKEW_MS = 5 * 60_000;

/** The size of a read: the bigger of the size on disk and the bytes read, so a file that grew after lstat is still too large. */
export function bytesRead(diskBytes: number, text: string): number {
  return Math.max(diskBytes, new TextEncoder().encode(text).length);
}

/** A short reason when the state-file read skipped files or the folder (counts only, never the folder path); null when it lost nothing. */
export function stateFilesPartial(stats: { unreadable: number; oversize: number; tooMany: number; dirUnreadable: boolean }): string | null {
  const parts = [
    stats.dirUnreadable ? 'directory unreadable' : '',
    stats.unreadable > 0 ? `${stats.unreadable} unreadable` : '',
    stats.oversize > 0 ? `${stats.oversize} oversize` : '',
    stats.tooMany > 0 ? `${stats.tooMany} over the file limit` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Rows cut to `limit`. The caller asks for limit + 1 rows, so one extra row proves a cut that the limit alone would hide. */
export function capRows<T>(rows: T[], limit: number): { rows: T[]; truncated: boolean } {
  return rows.length > limit ? { rows: rows.slice(0, limit), truncated: true } : { rows, truncated: false };
}

/** A short reason when the PR feed lost rows (a cap or skipped rows); null for a feed that is whole. Counts only. */
export function prFeedPartial(feed: { capped: boolean; skipped: number }): string | null {
  const parts = [feed.capped ? 'capped' : '', feed.skipped > 0 ? `${feed.skipped} rows skipped` : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Is the PR feed usable for a stall: status ok, and its export no older than the limit (no data time: the read time stands in). */
export function prFeedFresh(feed: { status: string; exportedAt: string | null }, nowMs: number, maxAgeMs: number): boolean {
  if (feed.status !== 'ok') return false;
  if (feed.exportedAt === null) return true;
  const at = Date.parse(feed.exportedAt);
  return Number.isFinite(at) && nowMs - at <= maxAgeMs;
}

const LABELS: Record<ReaderId, string> = {
  stalls: 'Stalls (lane table, PR feed)',
  'open-question': 'Open questions (session state files)',
  decisions: 'Decisions store (decisions.json)',
  clock: 'Next on the clock (lane table, feeds)',
  tasks: 'Scheduled tasks (tasks.json)',
};

const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function readerSource(id: ReaderId, outcome: ReaderOutcome, nowMs: number): ReaderSource {
  const base = { id, label: LABELS[id], readAtMs: outcome.readAtMs };
  if (!outcome.ok) {
    if (outcome.reason === 'missing') return { ...base, status: 'degraded', detail: 'source file missing', ageSec: 0 };
    return { ...base, status: 'error', detail: `read failed: ${cleanText(outcome.reason, 120) ?? 'unknown'}`, ageSec: 0 };
  }
  const dataAtMs = outcome.dataAtMs ?? outcome.readAtMs;
  const ageMs = Math.max(0, nowMs - dataAtMs);
  const ahead = dataAtMs - nowMs > FUTURE_SKEW_MS;
  const late = outcome.maxAgeMs !== undefined && ageMs > outcome.maxAgeMs;
  const text = `read ${hhmm.format(outcome.readAtMs)}, age ${Math.floor(ageMs / 60_000)} min`;
  const detail = ahead ? `data time is ahead of the clock, ${text}` : outcome.partial ? `partial read (${cleanText(outcome.partial, 80) ?? 'unknown'}), ${text}` : text;
  return { ...base, status: ahead || late || outcome.partial ? 'degraded' : 'ok', detail, ageSec: Math.floor(ageMs / 1000) };
}

export function buildReaderSources(outcomes: Record<ReaderId, ReaderOutcome>, nowMs: number): ReaderSource[] {
  return READER_IDS.map((id) => readerSource(id, outcomes[id], nowMs));
}

/** One reader's throw never rejects the snapshot: the same isolation as settle() in mission-control.ts:207-214. */
export async function settleReader<T>(fn: () => T | Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: safeMessage(error) };
  }
}
