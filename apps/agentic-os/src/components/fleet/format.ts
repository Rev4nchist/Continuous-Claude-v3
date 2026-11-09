/**
 * Display helpers for the fleet view. No data access, no fetching — these turn
 * numbers the server already computed into strings.
 *
 * Ages arrive as SECONDS COMPUTED SERVER-SIDE against the database clock, never
 * as a timestamp the browser has to parse. That is deliberate: `sessions`
 * timestamps are `timestamp WITHOUT time zone` holding UTC, and every attempt to
 * render them client-side is one missed `Z` away from being wrong by the local
 * UTC offset — which is zero in winter in some locales and therefore invisible
 * until it isn't.
 */

/** Compact age: "just now", "4m", "2h", "3d". Null renders as an em-dash. */
export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  // Clock skew or a heartbeat written a moment in the future should read as
  // "just now", not "-3s ago".
  if (seconds < 45) return 'just now';
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** Same scale, past tense, for "last active" labels. */
export function formatAgo(seconds: number | null | undefined): string {
  const age = formatAge(seconds);
  if (age === '—' || age === 'just now') return age;
  return `${age} ago`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** Pluralise without the "1 sessions" tell. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

export type ProjectStatus = 'active' | 'in-development' | 'inactive' | 'archived';

/**
 * Status pill styling. Archived and inactive are muted rather than hidden —
 * a project with 43 sessions that is now archived is still part of the history
 * this screen is accounting for, and dropping it would break the arithmetic the
 * accounting bar makes verifiable.
 */
export function statusClasses(status: string): string {
  switch (status) {
    case 'active':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
    case 'in-development':
      return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400';
    case 'inactive':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-500';
    case 'archived':
      return 'border-border bg-muted text-muted-foreground';
    default:
      return 'border-border bg-muted text-muted-foreground';
  }
}

/**
 * The words for the chip codes (.claudedocs/2026-10-29-os-pane-glossary.md, the same ones the /os
 * pane uses). The raw code stays the data (`data-chip`, the API); only the label changes.
 * A code this map does not know comes back as it is.
 */
const CHIP_WORDS: Record<string, string> = {
  working: 'Working',
  'waiting-on-dave': 'Waiting for you',
  blocked: 'Stuck',
  done: 'Done',
  idle: 'Idle',
};

export function chipWord(code: string): string {
  return Object.hasOwn(CHIP_WORDS, code) ? CHIP_WORDS[code] : code;
}

/**
 * The waiting line of a card, in the chip's own words so one card never shows two phrases. A card waits
 * only with an open, fresh ask. With no open ask and a waiting-on-dave chip, "Not waiting for you" would
 * contradict the chip, so the line says what is true: no ask is open.
 */
export function waitingLine(waiting: boolean, chip: string | null): string {
  const phrase = chipWord('waiting-on-dave');
  if (waiting) return phrase;
  return chip === 'waiting-on-dave' ? 'No open ask' : `Not ${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}`;
}

/** Chip colours by code, shared by the cards, the table and the detail header. */
const CHIP_TONE: Record<string, string> = {
  working: 'border-doing/40 text-doing',
  'waiting-on-dave': 'border-warn/50 bg-warn/10 text-warn',
  blocked: 'border-bad/50 bg-bad/10 text-bad',
  done: 'border-done/40 text-done',
  idle: 'border-border text-muted-foreground',
};

export function chipTone(code: string): string | undefined {
  return Object.hasOwn(CHIP_TONE, code) ? CHIP_TONE[code] : undefined;
}

/** A lease with this many seconds or fewer left reads amber on the card. A lapsed lease is amber too. */
export const LEASE_SHORT_SECONDS = 15 * 60;

export type LeaseTone = 'ok' | 'short' | 'lapsed' | 'none';

/** `lapsed` at 0 seconds or less, `short` at LEASE_SHORT_SECONDS or less, `none` with no lease. */
export function leaseTone(secondsLeft: number | null): LeaseTone {
  if (secondsLeft === null) return 'none';
  if (secondsLeft <= 0) return 'lapsed';
  return secondsLeft <= LEASE_SHORT_SECONDS ? 'short' : 'ok';
}

/** "lease 1h 20m left", "lease 12m left", "lease <1m left", "lease lapsed 5m ago", "no lease". */
export function formatLease(secondsLeft: number | null): string {
  if (secondsLeft === null) return 'no lease';
  if (secondsLeft <= 0) {
    const late = -secondsLeft;
    if (late < 45) return 'lease lapsed just now';
    if (late < 3_600) return `lease lapsed ${Math.round(late / 60)}m ago`;
    if (late < 86_400) return `lease lapsed ${Math.round(late / 3_600)}h ago`;
    return `lease lapsed ${Math.round(late / 86_400)}d ago`;
  }
  if (secondsLeft < 60) return 'lease <1m left';
  const minutes = Math.floor(secondsLeft / 60);
  if (minutes < 60) return `lease ${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  return `lease ${hours}h ${minutes % 60}m left`;
}

/** "$1.50". The one money format of the fleet view. */
export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * The words for a run-cost sum. Same rule as the ledger pane's `usdText` (agent-ledger/model.ts), with
 * words in place of the glyphs.
 *  - `unpriced`: how many runs used a model with no price. Their dollars are left out of `usd`.
 *  - `floor`: a run used the advisor, whose tokens the live feed leaves out. `usd` is a floor.
 * A sum of 0 with unpriced runs and no floor reads "unpriced", never "$0.00". A floor never hides: it
 * reads "at least $0.00" at zero.
 */
export function costLabel({ usd, unpriced, floor }: { usd: number; unpriced: number; floor: boolean }): string {
  if (unpriced > 0 && usd <= 0 && !floor) return 'unpriced';
  const base = `${floor ? 'at least ' : ''}${formatUsd(usd)}`;
  return unpriced > 0 ? `${base} + ${unpriced} unpriced` : base;
}
