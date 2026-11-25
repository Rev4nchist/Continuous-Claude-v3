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
  | { ok: true; readAtMs: number; /** When the data itself was made (a feed export time); default: the read time. */ dataAtMs?: number | null; /** Older than this is degraded. */ maxAgeMs?: number }
  | { ok: false; reason: string; readAtMs: number };

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
  const ageMs = Math.max(0, nowMs - (outcome.dataAtMs ?? outcome.readAtMs));
  const late = outcome.maxAgeMs !== undefined && ageMs > outcome.maxAgeMs;
  return { ...base, status: late ? 'degraded' : 'ok', detail: `read ${hhmm.format(outcome.readAtMs)}, age ${Math.floor(ageMs / 60_000)} min`, ageSec: Math.floor(ageMs / 1000) };
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
