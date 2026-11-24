/**
 * Age words of the Flow tab and the Last landed list (card agentic-os-feeds-truth, C7 and C3). Pure: no import, no clock.
 * The caller passes the time. Every time is shown in Chicago time with its date, so a file from yesterday cannot read as today.
 */

const CHICAGO = 'America/Chicago';
const STAMP_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: CHICAGO,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});

/** A file older than this is stale. factory.json is written once a day (the 23:55 task, health limit 30 h), flow.json every 30 minutes. */
export const FLOW_STALE_MINUTES: Record<string, number> = { flow: 2 * 60, factory: 36 * 60 };
const DEFAULT_STALE_MINUTES = 36 * 60;
const FUTURE_SKEW_MINUTES = 5;

export const FACTORY_NOTE = 'factory.json is written once a day at 23:55 CST: its "today" figures read 0 until that run.';

/** "11-23 23:55 CST". */
export function formatCtStamp(ms: number): string {
  const part = (type: string, parts: Intl.DateTimeFormatPart[]) => parts.find((p) => p.type === type)?.value ?? '';
  const parts = STAMP_FORMAT.formatToParts(ms);
  return `${part('month', parts)}-${part('day', parts)} ${part('hour', parts)}:${part('minute', parts)} ${part('timeZoneName', parts)}`;
}

/** "25 min" under 90 minutes, else whole hours. */
export function ageWords(minutes: number): string {
  return minutes < 90 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

export type FlowAge = { text: string; stale: boolean; note: string | null };

/** The header of one Flow file: name, date, clock, age and a stale flag. A future or unreadable time is stale. */
export function flowAge(name: string, exportedAt: string, nowMs: number): FlowAge {
  const note = name === 'factory' ? FACTORY_NOTE : null;
  const ms = Date.parse(exportedAt);
  if (Number.isNaN(ms)) return { text: `${name} export time unknown, stale`, stale: true, note };
  const minutes = Math.floor((nowMs - ms) / 60_000);
  const head = `${name} exported ${formatCtStamp(ms)}`;
  if (minutes < -FUTURE_SKEW_MINUTES) return { text: `${head}, time is in the future, stale`, stale: true, note };
  const age = Math.max(0, minutes);
  const stale = age > (FLOW_STALE_MINUTES[name] ?? DEFAULT_STALE_MINUTES);
  return { text: `${head}, ${ageWords(age)} ago${stale ? ', stale' : ''}`, stale, note };
}
