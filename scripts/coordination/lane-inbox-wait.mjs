/**
 * lane-inbox-wait -- the pure part of `lane.mjs inbox --wait [--timeout N]` (card coord-inbox-wait).
 *
 * No database and no clock of its own: the caller passes `poll`, `sleep` and `now`, so a test can count the polls exactly.
 * Tests: scripts/coordination/lane-inbox-wait.test.mjs (W6 flags, W8 the loop).
 */

export const WAIT_DEFAULT_S = 600;
export const WAIT_MAX_S = 3600;
export const WAIT_POLL_S = 15;

const USAGE = 'usage: lane.mjs inbox --wait [--timeout N] (N is a whole number of seconds from 1 to 3600, default 600; --wait does not combine with --peek or --id; nothing was run)';

/** The time limit in seconds, from the parsed flags. Throws the usage error, before any query, for anything else. */
export function parseWaitFlags(flags) {
  const keys = Object.keys(flags);
  if (flags.wait !== true || keys.some((k) => k.startsWith('wait=')) || flags.peek !== undefined || flags.id !== undefined || keys.some((k) => k.startsWith('id='))) {
    throw new Error(USAGE);
  }
  if (flags.timeout === undefined) return { timeoutS: WAIT_DEFAULT_S };
  const raw = flags.timeout;
  if (typeof raw !== 'string' || !/^[1-9]\d{0,3}$/.test(raw) || Number(raw) > WAIT_MAX_S) throw new Error(USAGE);
  return { timeoutS: Number(raw) };
}

/**
 * The poll interval in ms: 15 s, or LANE_WAIT_POLL_MS (a whole number) when LANE_ALLOW_AS is exactly "1" (drills, probes and tests).
 */
export function pollMs(env = process.env) {
  const raw = env.LANE_WAIT_POLL_MS;
  if (env.LANE_ALLOW_AS === '1' && typeof raw === 'string' && /^[1-9]\d{0,6}$/.test(raw)) return Number(raw);
  return WAIT_POLL_S * 1000;
}

/**
 * Polls until `poll()` returns a row, or the limit. The first poll runs at once; then one every `pollS` seconds; one last poll at the
 * limit, so an event that arrived just before it is not lost. Returns { event } or { timedOut: true }. An error from `poll` is not caught.
 */
export async function waitForEvent({ poll, sleep, now, timeoutS, pollS = WAIT_POLL_S, pollMsOverride }) {
  const stepMs = pollMsOverride ?? pollS * 1000;
  const start = now();
  for (;;) {
    const event = await poll();
    if (event) return { event };
    const left = timeoutS * 1000 - (now() - start);
    if (left <= 0) return { timedOut: true };
    await sleep(Math.min(stepMs, left));
  }
}
