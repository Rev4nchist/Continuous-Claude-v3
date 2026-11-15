/**
 * tick-marker -- the "NO TICK" word on the board row of a program master card. Pure: no I/O, no database.
 *
 * The seat runs a keep-warm tick every 30 minutes, 07:00 to 21:59 local (rule L2.15). Each tick is a prompt, and the
 * prompt hook renews the lease to now + 90 minutes (probe 2026-11-15: a cron-queued prompt moved the lease from
 * 16:30:24Z to 16:32:00Z at the 09:02:00 CST tick). A ticking seat keeps 45 to 90 minutes (the scheduler delays a
 * tick by up to 15). Under 40 minutes left means 50 minutes without a prompt: the tick has stopped.
 * lane.mjs (laneLine) and render-board.mjs both call this, so the word and the test are the same on both surfaces.
 * Seat agreement (V7.1): milestone 544, re-program.md: the board row only, no banner line.
 */

/** Lanes that stand for a program (CONTEXT.md "Master card"). Builders keep "warm only", so no other lane gets the word. */
export const MASTER_LANES = ['re-program'];

/** The word on the row. The seat reads this exact text in the PR body. */
export const NO_TICK = 'NO TICK';

/** Under this many minutes of lease left, with the tick due, the tick has stopped. */
export const TICK_MIN_LEASE_MINUTES = 40;

/** A lease more than this far ahead is a park (the lease is the park, lane.mjs LEASE_MINUTES + 1). */
const PARK_ABOVE_MINUTES = 91;

/** The tick runs 07:00 to 21:59 local; outside it a quiet seat is expected. */
const inTickHours = (now) => now.getHours() >= 7 && now.getHours() < 22;

/** 'NO TICK' or ''. `lane` needs id, owner_session_id, lease_expires_at. A junk lease gives ''. */
export function tickMarker(lane, now = new Date()) {
  if (!lane || !MASTER_LANES.includes(lane.id) || !lane.owner_session_id || !lane.lease_expires_at) return '';
  if (!inTickHours(now)) return '';
  const end = new Date(lane.lease_expires_at).getTime();
  if (!Number.isFinite(end)) return '';
  const minutes = Math.round((end - now.getTime()) / 60000);
  if (minutes <= 0 || minutes > PARK_ABOVE_MINUTES) return '';
  return minutes < TICK_MIN_LEASE_MINUTES ? NO_TICK : '';
}
