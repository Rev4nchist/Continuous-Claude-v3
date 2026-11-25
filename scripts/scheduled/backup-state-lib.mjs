/**
 * Pure helpers of the nightly state backup (card ops-state-backup-nightly). No file, no network, no clock, no database.
 * Design: .claudedocs/e2e-ops-state-backup-nightly/00-design-note.md. A module only: no shebang, no argv read.
 *
 *   planUpload(bytes, { maxBytes })        how one file goes to Notion: single-part or parts (design section 4)
 *   chooseRetention(rows, { now })         which backup rows stay and which may go to the Notion trash (section 7)
 *   maskText(text, { secrets })            text that is safe in a Notion cell and in a log: masked, one line, 600 characters
 */

export const TASK = 'CCV3-State-Backup';
export const MiB = 1024 * 1024;
/** Notion: single-part uploads hold up to 20 MB, so the switch is lower than that. */
export const SINGLE_LIMIT = 18 * MiB;
/** Notion: each part is 5 to 20 MiB (the last may be smaller); 10 MiB is the size the docs recommend. */
export const PART_SIZE = 10 * MiB;
export const KEEP_NEWEST = 14;
export const WEEKLY_DAYS = 8 * 7;
export const TEXT_LIMIT = 600;

/** { mode: 'single' } | { mode: 'multi', parts: [{ n, start, end }] } | { error: 'empty' | 'over-limit' }. Throws on a size that is not a whole number. */
export function planUpload(bytes, { maxBytes } = {}) {
  if (!Number.isInteger(bytes) || bytes < 0) throw new Error(`size must be a whole number of bytes, got ${String(bytes)}`);
  if (bytes === 0) return { error: 'empty' };
  if (maxBytes !== undefined && bytes > maxBytes) return { error: 'over-limit' };
  if (bytes <= SINGLE_LIMIT) return { mode: 'single' };
  const parts = [];
  for (let start = 0, n = 1; start < bytes; start += PART_SIZE, n += 1) parts.push({ n, start, end: Math.min(start + PART_SIZE, bytes) });
  return { mode: 'multi', parts };
}

/** 'YYYY-MM-DD' that names a real day, as a day count; else null. */
function dayNumber(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) return null;
  return ms / 86_400_000;
}
const isProved = (r) => r.task === TASK && r.status === 'ok' && r.drill === 'pass';

/**
 * Rows: [{ id, date: 'YYYY-MM-DD', kind: 'nightly' | 'weekly', status, drill, task }]. Returns { keep: [id], trash: [id] }.
 * A row is kept when it is one of the 14 newest, a weekly row of the last 8 weeks, a row of another owner, a row with no real date,
 * (the newest proved row is never trashed either). Any other row is trashed only when a strictly NEWER row of ours has Status ok and Drill pass.
 */
export function chooseRetention(rows, { now }) {
  const today = dayNumber(now);
  if (today === null) throw new Error(`now must be a YYYY-MM-DD date, got ${String(now)}`);
  const dated = rows.filter((r) => r.task === TASK && dayNumber(r.date) !== null).sort((a, b) => (dayNumber(b.date) - dayNumber(a.date)) || String(b.id).localeCompare(String(a.id)));
  const keep = new Set(rows.filter((r) => dayNumber(r.date) === null || r.task !== TASK).map((r) => r.id));
  for (const r of dated.slice(0, KEEP_NEWEST)) keep.add(r.id);
  for (const r of dated) if (r.kind === 'weekly' && today - dayNumber(r.date) <= WEEKLY_DAYS) keep.add(r.id);
  // The newest proved row needs no guard of its own: no NEWER proved row exists for it, so the rule below never trashes it (test R6).
  const trash = [];
  for (const r of dated) {
    if (keep.has(r.id)) continue;
    if (dated.some((p) => isProved(p) && dayNumber(p.date) > dayNumber(r.date))) trash.push(r.id);
    else keep.add(r.id);
  }
  return { keep: rows.map((r) => r.id).filter((id) => keep.has(id)), trash };
}

/**
 * Hide secrets, then make one line of at most 600 characters. Hidden: the password of every scheme://user:pass@ url, Notion tokens
 * (secret_..., ntn_...), Bearer values, and each given secret of 8 or more characters (a shorter one would blank ordinary words).
 * The cut comes last, so a secret never shows as half a word.
 */
export function maskText(text, { secrets = [] } = {}) {
  if (typeof text !== 'string') return '';
  let s = text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, '$1$2:***@')
    .replace(/\b(?:secret|ntn)_[A-Za-z0-9]{8,}/g, '***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{6,}=*/gi, '$1***');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 8) s = s.split(secret).join('***');
  return s.replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT);
}
