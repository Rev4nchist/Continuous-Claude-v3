import { cleanText } from '../server/queries/lane-coord';

/**
 * The scheduled tasks reader (card agentic-os-readers, reader 5). PURE: no 'server-only', no '@/' import.
 *
 * Source: scripts/scheduled/tasks.json, {tasks:[{name, trigger, maxAgeHours, ...}]}. The real trigger shapes are
 * `daily HH:MM`, `weekly <Day> HH:MM` and `every Nm`. The file has no last-run time ("not measured"). Extra fields
 * (catchUp, and any later one) are ignored: only a broken shape is an error. Times are America/Chicago.
 */

const ZONE = 'America/Chicago';
const MIN = 60_000;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
});

function chicago(ms: number): { y: number; m: number; d: number; h: number; mi: number } {
  const got: Record<string, number> = {};
  for (const p of parts.formatToParts(ms)) if (p.type !== 'literal') got[p.type] = Number(p.value);
  return { y: got.year, m: got.month, d: got.day, h: got.hour, mi: got.minute };
}

/** The Chicago offset from UTC at an instant, in ms (negative). */
function offsetAt(ms: number): number {
  const c = chicago(ms);
  return Date.UTC(c.y, c.m - 1, c.d, c.h, c.mi) - Math.floor(ms / MIN) * MIN;
}

/** The instant of a Chicago wall time. Two passes settle a daylight-saving change day. */
function chicagoToEpoch(y: number, m: number, d: number, h: number, mi: number): number {
  const naive = Date.UTC(y, m - 1, d, h, mi);
  const first = naive - offsetAt(naive);
  return naive - offsetAt(first);
}

const CLOCK = /^(\d{2}):(\d{2})$/;
function clockOf(text: string): { h: number; mi: number } | null {
  const m = CLOCK.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? { h, mi } : null;
}

/** The next fire after `nowMs`, or null for an "every Nm" trigger (no anchor in the file) or an unknown shape. */
export function nextFireMs(trigger: unknown, nowMs: number): number | null {
  if (typeof trigger !== 'string') return null;
  const daily = /^daily (\S+)$/.exec(trigger);
  const weekly = /^weekly (\S+) (\S+)$/.exec(trigger);
  const today = chicago(nowMs);
  if (daily) {
    const at = clockOf(daily[1]);
    if (!at) return null;
    for (let add = 0; add <= 1; add++) {
      const t = chicagoToEpoch(today.y, today.m, today.d + add, at.h, at.mi);
      if (t > nowMs) return t;
    }
    return null;
  }
  if (weekly) {
    const day = DAYS.indexOf(weekly[1]);
    const at = clockOf(weekly[2]);
    if (day < 0 || !at) return null;
    for (let add = 0; add <= 7; add++) {
      if (new Date(Date.UTC(today.y, today.m - 1, today.d + add)).getUTCDay() !== day) continue;
      const t = chicagoToEpoch(today.y, today.m, today.d + add, at.h, at.mi);
      if (t > nowMs) return t;
    }
  }
  return null;
}

export type ScheduledTask = { name: string; trigger: string; nextFireMs: number | null; maxAgeHours: number | null; lastRun: 'not measured' };
export type TasksView = { ok: true; tasks: ScheduledTask[] } | { ok: false; reason: 'missing' | 'unreadable' | 'bad-shape' };

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseTasksFile(text: string | null, nowMs: number): TasksView {
  if (text === null) return { ok: false, reason: 'missing' };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!isPlain(doc) || !Array.isArray(doc.tasks)) return { ok: false, reason: 'bad-shape' };
  const tasks: ScheduledTask[] = [];
  for (const raw of doc.tasks) {
    if (!isPlain(raw) || typeof raw.name !== 'string' || raw.name === '' || typeof raw.trigger !== 'string') return { ok: false, reason: 'bad-shape' };
    tasks.push({
      name: cleanText(raw.name, 80) ?? 'unnamed task',
      trigger: cleanText(raw.trigger, 40) ?? '',
      nextFireMs: nextFireMs(raw.trigger, nowMs),
      maxAgeHours: typeof raw.maxAgeHours === 'number' && Number.isFinite(raw.maxAgeHours) ? raw.maxAgeHours : null,
      lastRun: 'not measured',
    });
  }
  return { ok: true, tasks };
}
