'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * THE SINGLE LIVENESS SEAM (ADR-0002).
 *
 * "Polling lives behind a single `useLiveData()` hook ... swapping 5s polling for
 * SSE in Slice 3 must not touch components." That is the whole reason this file
 * exists as its own module rather than a `useEffect` inside the grid. Everything
 * a component is allowed to know about liveness is in the return type below:
 * data, a status, an age, and a way to ask again. Nothing in that contract names
 * `fetch`, an interval, or an endpoint — so replacing the body with an
 * EventSource is a change to this file alone.
 *
 * Three behaviours that are correctness, not polish:
 *
 *   1. A failed refresh KEEPS the last good data. A dashboard that blanks on a
 *      transient 503 teaches you to distrust it; one that says "last updated 40s
 *      ago" while it retries stays readable. `data` is therefore never undefined
 *      after the first server render.
 *   2. Polling PAUSES when the tab is hidden, and fires immediately on return.
 *      This app reads a database shared with three other applications; a
 *      forgotten background tab issuing a query every 5 seconds forever is a bad
 *      neighbour, and the first thing you want on refocus is fresh numbers.
 *   3. Only one request is ever in flight. The previous one is aborted rather
 *      than raced, so a slow query cannot land after a newer, faster one and
 *      roll the screen backwards.
 */

export type LiveStatus =
  /** Last fetch succeeded. */
  | 'live'
  /** A fetch is in flight; `data` is the previous good value. */
  | 'refreshing'
  /** At least one consecutive failure; `data` is the last good value. */
  | 'error'
  /** Tab is hidden — deliberately not polling. */
  | 'paused';

export type LiveData<T> = {
  data: T;
  status: LiveStatus;
  /** Message from the most recent failure, cleared on the next success. */
  error: string | null;
  /** Milliseconds since the last SUCCESSFUL update, measured on the client so it
   *  reflects what the user is actually looking at. Null until the first refresh
   *  completes — the initial value came from the server render, and claiming a
   *  client-measured age for it would be a small lie. */
  ageMs: number | null;
  consecutiveFailures: number;
  /** Force an immediate refresh, cancelling any in-flight request. */
  refresh: () => void;
};

export type UseLiveDataOptions<T> = {
  endpoint: string;
  /** Server-rendered value. The screen is never empty and never flashes a
   *  skeleton for data that was already in the HTML. */
  initialData: T;
  intervalMs?: number;
  /** Escape hatch for tests and for pages that want a static view. */
  enabled?: boolean;
};

const DEFAULT_INTERVAL_MS = 5_000;

/** Re-render cadence for the age display. Independent of the poll interval so
 *  "12s ago" keeps counting up while a request is failing. */
const TICK_MS = 1_000;

/**
 * Tab visibility as an EXTERNAL STORE rather than effect-driven state.
 *
 * The obvious version — `useEffect(() => { if (document.hidden) setStatus('paused') })`
 * — is a lint error here (`react-hooks/set-state-in-effect`), and the rule is right:
 * that is a synchronous setState in an effect body, which cascades a render. Visibility
 * is a browser subscription, which is precisely what `useSyncExternalStore` is for, so
 * it is read rather than mirrored. The server snapshot is `false`: nothing is hidden
 * during SSR, and claiming otherwise would produce a hydration mismatch.
 */
function subscribeToVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}
const readHidden = () => document.hidden;
const readHiddenOnServer = () => false;

export function useLiveData<T>({
  endpoint,
  initialData,
  intervalMs = DEFAULT_INTERVAL_MS,
  enabled = true,
}: UseLiveDataOptions<T>): LiveData<T> {
  const [data, setData] = useState<T>(initialData);
  const [fetchStatus, setFetchStatus] = useState<Exclude<LiveStatus, 'paused'>>('live');
  const [error, setError] = useState<string | null>(null);
  const [consecutiveFailures, setFailures] = useState(0);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [now, setNow] = useState<number | null>(null);

  const hidden = useSyncExternalStore(
    subscribeToVisibility,
    readHidden,
    readHiddenOnServer,
  );

  const inFlight = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    setFetchStatus((s) => (s === 'error' ? 'error' : 'refreshing'));

    try {
      const response = await fetch(endpoint, {
        signal: controller.signal,
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });

      if (!response.ok) {
        // The route returns {error} with a 503 on a failed read. Surface the
        // server's own message where there is one — "503" alone tells you
        // nothing, and this dashboard exists to be believed.
        const body: unknown = await response.json().catch(() => null);
        const detail =
          body && typeof body === 'object' && 'error' in body
            ? String((body as { error: unknown }).error)
            : `HTTP ${response.status}`;
        throw new Error(detail);
      }

      const next = (await response.json()) as T;
      if (controller.signal.aborted) return;

      const at = Date.now();
      setData(next);
      setError(null);
      setFailures(0);
      setLastSuccessAt(at);
      // Seeded HERE, not in the ticker effect. Setting it there would be a
      // synchronous setState in an effect body (and a lint error); doing it in
      // this callback is the same value one render earlier.
      setNow(at);
      setFetchStatus('live');
    } catch (caught) {
      // An abort is this hook cancelling itself, not a failure. Counting it
      // would put the header in an error state every time the tab regains focus.
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setFailures((n) => n + 1);
      setFetchStatus('error');
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, [endpoint]);

  // Polling. A hidden tab has no interval at all — this app shares a database
  // with three other applications, and a forgotten background tab querying it
  // every 5s forever is a bad neighbour.
  useEffect(() => {
    if (!enabled || hidden) return;

    // Deferred to a macrotask rather than called inline: an inline call would
    // run fetchOnce()'s synchronous setState during the effect. It also gives
    // the age indicator a real client-measured timestamp to count from, since
    // the initial data came from the server render with no client clock.
    const immediate = setTimeout(() => void fetchOnce(), 0);
    const timer = setInterval(() => void fetchOnce(), intervalMs);

    return () => {
      clearTimeout(immediate);
      clearInterval(timer);
      inFlight.current?.abort();
    };
  }, [enabled, hidden, fetchOnce, intervalMs]);

  // The age ticker runs only once there is a client-measured success to count
  // from, so nothing renders a time during SSR and disagrees with it on hydration.
  useEffect(() => {
    if (lastSuccessAt === null) return;
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(tick);
  }, [lastSuccessAt]);

  return {
    data,
    status: hidden ? 'paused' : fetchStatus,
    error,
    ageMs: lastSuccessAt === null || now === null ? null : now - lastSuccessAt,
    consecutiveFailures,
    refresh: () => void fetchOnce(),
  };
}
