'use client';

import type { MissionControlSnapshot } from '@/server/queries/mission-control';

import { useLiveData } from '@/hooks/useLiveData';
import { cn } from '@/lib/utils';

import { AccountingBar } from './AccountingBar';
import { ActiveSessionsStrip } from './ActiveSessionsStrip';
import { FleetGrid } from './FleetGrid';
import { UnmatchedPanel } from './UnmatchedPanel';

/**
 * The only client component that knows liveness exists.
 *
 * ADR-0002 requires polling behind a single `useLiveData()` hook so Slice 3 can
 * swap in SSE without touching components — so this is the one place that calls
 * it, and everything below receives plain data as props. FleetGrid, ProjectCard,
 * AccountingBar, ActiveSessionsStrip and UnmatchedPanel are all server-renderable
 * pure functions of their props; none of them import the hook, fetch anything, or
 * hold state.
 *
 * THE TYPE IMPORT IS SAFE AND IS CHECKED. `@/server/queries/mission-control`
 * carries `import 'server-only'`, which throws if it reaches a client bundle.
 * `import type` is erased at compile time (tsconfig has `isolatedModules`, which
 * makes that erasure a guarantee rather than an optimisation), so no runtime edge
 * is created here — and if a future refactor turns it into a value import, the
 * build fails loudly instead of shipping a database driver to the browser.
 */
export function MissionControl({ initial }: { initial: MissionControlSnapshot }) {
  const { data, status, error, ageMs, consecutiveFailures, refresh } =
    useLiveData<MissionControlSnapshot>({
      endpoint: '/api/mission-control',
      initialData: initial,
    });

  const { fleet, active, database } = data;

  return (
    <div className="mx-auto flex min-h-screen max-w-[100rem] flex-col gap-8 p-6 lg:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Agentic OS</h1>
          <p className="text-sm text-muted-foreground">
            Fleet overview · local-first, read-only, no auth
          </p>
        </div>
        <LiveIndicator
          status={status}
          error={error}
          ageMs={ageMs}
          generatedAt={data.generatedAt}
          consecutiveFailures={consecutiveFailures}
          onRefresh={refresh}
        />
      </header>

      {!database.ok && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm"
        >
          <p className="font-medium text-destructive">Database unreachable.</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{database.error}</p>
          <p className="mt-1 text-muted-foreground">
            Everything below is the last successful read and may be arbitrarily old.
          </p>
        </div>
      )}

      <ActiveSessionsStrip active={active} />

      <section className="space-y-3">
        <h2 className="text-sm font-medium tracking-tight">
          Projects
          <span className="ml-2 font-normal text-muted-foreground">
            {fleet.projects.length} in the registry
          </span>
        </h2>
        <FleetGrid projects={fleet.projects} />
      </section>

      <AccountingBar fleet={fleet} />

      <UnmatchedPanel unmatched={fleet.unmatched} />

      <footer className="mt-auto border-t pt-4 text-xs text-muted-foreground">
        {database.ok
          ? `Connected as agentic_os_app (SELECT-only, ${database.latencyMs}ms).`
          : 'Not connected.'}{' '}
        Slice 1: fleet grid only. Transcripts, search, memory and every write path are
        deliberately out of scope.
      </footer>
    </div>
  );
}

/**
 * Liveness, stated rather than implied.
 *
 * A dashboard that silently stops updating is worse than one that is obviously
 * broken, so the failure states are visible: amber while retrying with the last
 * good data still on screen, and a paused state when the tab is backgrounded so
 * nobody reads a 20-minute-old number as current.
 */
function LiveIndicator({
  status,
  error,
  ageMs,
  generatedAt,
  consecutiveFailures,
  onRefresh,
}: {
  status: 'live' | 'refreshing' | 'error' | 'paused';
  error: string | null;
  ageMs: number | null;
  /** `MissionControlSnapshot.generatedAt` — when the SERVER built the data on
   *  screen, ISO-8601 UTC. It has been computed on every snapshot since the
   *  endpoint was written and rendered nowhere until 2026-07-28.
   *
   *  It is the anchor the relative ages cannot be. `ageMs` is measured from the
   *  last successful FETCH on the client, so during an outage it keeps counting
   *  while every number underneath it stays frozen — and a paused tab shows a
   *  plausible small age for data that is hours old. An absolute server stamp
   *  cannot drift, cannot freeze, and answers "as of when?" outright. */
  generatedAt: string;
  consecutiveFailures: number;
  onRefresh: () => void;
}) {
  // Sliced out of the ISO string, never parsed into a Date. new Date(...) here
  // would render in the viewer's local zone on the client and UTC during SSR —
  // a hydration mismatch — and this file's own timestamps are UTC-bearing
  // `timestamp without time zone`, the exact class of bug that has already cost
  // this project two rounds. A substring cannot be five hours wrong.
  const serverClock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(generatedAt)
    ? `${generatedAt.slice(11, 19)}Z`
    : null;

  const dot =
    status === 'error'
      ? 'bg-destructive'
      : status === 'paused'
        ? 'bg-muted-foreground'
        : 'bg-emerald-500';

  const ageSeconds = ageMs === null ? null : Math.max(0, Math.round(ageMs / 1000));

  const label =
    status === 'error'
      ? // The AGE is the point of this state and it used to be dropped here:
        // "stale — 3 failed refreshes" tells you something is wrong but not
        // whether you are looking at 10-second-old or 40-minute-old numbers,
        // which is the only part that decides whether you can act on them.
        `stale ${ageSeconds === null ? '' : `${ageSeconds}s `}— ${consecutiveFailures} failed ${
          consecutiveFailures === 1 ? 'refresh' : 'refreshes'
        }`
      : status === 'paused'
        ? `paused (tab hidden)${ageSeconds === null ? '' : ` — ${ageSeconds}s old`}`
        : ageSeconds === null
          ? 'live'
          : `updated ${ageSeconds}s ago`;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onRefresh}
        className="flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors hover:bg-accent"
        title="Refresh now"
      >
        <span
          aria-hidden
          className={cn(
            'size-2 rounded-full',
            dot,
            status === 'refreshing' && 'animate-pulse',
          )}
        />
        <span className="tabular-nums">{label}</span>
      </button>
      {serverClock && (
        <span
          className="font-mono text-[0.6875rem] tabular-nums text-muted-foreground"
          title="When the SERVER built the data on screen (UTC). Unlike the relative age above, this cannot keep counting while the data underneath it is frozen."
        >
          data as of {serverClock}
        </span>
      )}
      {status === 'error' && error && (
        <span className="max-w-xs truncate text-right font-mono text-[0.6875rem] text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
