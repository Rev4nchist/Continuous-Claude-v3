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
  consecutiveFailures,
  onRefresh,
}: {
  status: 'live' | 'refreshing' | 'error' | 'paused';
  error: string | null;
  ageMs: number | null;
  consecutiveFailures: number;
  onRefresh: () => void;
}) {
  const dot =
    status === 'error'
      ? 'bg-destructive'
      : status === 'paused'
        ? 'bg-muted-foreground'
        : 'bg-emerald-500';

  const label =
    status === 'error'
      ? `stale — ${consecutiveFailures} failed ${consecutiveFailures === 1 ? 'refresh' : 'refreshes'}`
      : status === 'paused'
        ? 'paused (tab hidden)'
        : ageMs === null
          ? 'live'
          : `updated ${Math.max(0, Math.round(ageMs / 1000))}s ago`;

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
      {status === 'error' && error && (
        <span className="max-w-xs truncate text-right font-mono text-[0.6875rem] text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
