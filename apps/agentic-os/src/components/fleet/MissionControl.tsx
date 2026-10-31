'use client';

import { useState, type ReactNode } from 'react';

import type { MissionControlSnapshot } from '@/server/queries/mission-control';

import { useLiveData } from '@/hooks/useLiveData';
import { cn } from '@/lib/utils';

import { AccountingBar } from './AccountingBar';
import { ActiveSessionsStrip } from './ActiveSessionsStrip';
import { FleetGrid } from './FleetGrid';
import { LaneBoard } from './LaneBoard';
import { NavTabs, type ViewId } from './NavTabs';
import { PrPanel } from './PrPanel';
import { ReadyForDave } from './ReadyForDave';
import { SessionCards } from './SessionCards';
import { SessionDetail, SessionUnavailable } from './SessionDetail';
import { SessionsTable } from './SessionsTable';
import { SourceHealth } from './SourceHealth';
import { StatTiles } from './StatTiles';
import { UnmatchedPanel } from './UnmatchedPanel';

/**
 * The only client component that knows liveness exists.
 *
 * ADR-0002 requires polling behind a single `useLiveData()` hook so Slice 3 can
 * swap in SSE without touching components — so this is the one place that calls
 * it, and everything below receives plain data as props. FleetGrid, ProjectCard,
 * AccountingBar, ActiveSessionsStrip, UnmatchedPanel, ReadyForDave, StatTiles,
 * SessionCards and SourceHealth are all server-renderable pure functions of their props;
 * none of them import the hook or fetch anything. The one piece of client state, the
 * project filter, lives in this component and reaches them as props.
 *
 * THE TYPE IMPORT IS SAFE AND IS CHECKED. `@/server/queries/mission-control`
 * carries `import 'server-only'`, which throws if it reaches a client bundle.
 * `import type` is erased at compile time (tsconfig has `isolatedModules`, which
 * makes that erasure a guarantee rather than an optimisation), so no runtime edge
 * is created here — and if a future refactor turns it into a value import, the
 * build fails loudly instead of shipping a database driver to the browser.
 */
export type { ViewId } from './NavTabs';

const BASE_ENDPOINT = '/api/mission-control';

/** The one endpoint. The Board is asked for only while the Board tab is active. */
function endpointFor(view: ViewId, session: string | null): string {
  const params = new URLSearchParams();
  if (view === 'board') params.set('view', 'board');
  if (session !== null) params.set('session', session);
  const query = params.toString();
  return query === '' ? BASE_ENDPOINT : `${BASE_ENDPOINT}?${query}`;
}

/** Mirror the view and the selection in the address bar. replaceState: no navigation, no history entry. */
function mirrorUrl(view: ViewId, session: string | null): void {
  const params = new URLSearchParams();
  if (view !== 'overview') params.set('view', view);
  if (session !== null) params.set('session', session);
  const query = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}

export function MissionControl({
  initial,
  initialView = 'overview',
  initialSession = null,
}: {
  initial: MissionControlSnapshot;
  initialView?: ViewId;
  initialSession?: string | null;
}) {
  // The view and the selected session live here and nowhere else. The endpoint carries the
  // selection, so the next poll brings the detail of that session.
  const [view, setView] = useState<ViewId>(initialView);
  const [selected, setSelected] = useState<string | null>(initialSession);

  const { data, status, error, ageMs, consecutiveFailures, refresh } =
    useLiveData<MissionControlSnapshot>({
      endpoint: endpointFor(view, selected),
      initialData: initial,
    });

  const { fleet, active, database, ready, cards, tiles, sources, prs } = data;

  // After an endpoint change the hook keeps the old data until the new answer lands, so the detail
  // is shown only when it belongs to the selection.
  const detail = selected !== null && data.detail?.id === selected ? data.detail : null;
  const unavailable =
    selected !== null && detail === null && data.detailUnavailable?.id === selected
      ? data.detailUnavailable
      : null;

  const changeView = (next: ViewId) => {
    setView(next);
    mirrorUrl(next, selected);
  };
  const choose = (id: string | null, nextView: ViewId = view) => {
    setSelected(id);
    setView(nextView);
    mirrorUrl(nextView, id);
  };
  const toggleSession = (id: string) => choose(selected === id ? null : id);
  const closePanel = () => choose(null);

  // The project filter is client state too. Clicking the selected project clears it.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const toggleProject = (key: string) => setSelectedKey((current) => (current === key ? null : key));
  const selectedProject = fleet.projects.find((p) => p.key === selectedKey) ?? null;
  const shownCards =
    selectedKey === null ? cards : cards.filter((card) => card.projectKey === selectedKey);
  const filter =
    selectedKey === null
      ? null
      : { key: selectedKey, label: selectedProject?.displayName ?? selectedKey };
  const clearFilter = () => setSelectedKey(null);

  let panel: ReactNode = null;
  if (selected !== null) {
    if (detail !== null) panel = <SessionDetail detail={detail} onClose={closePanel} />;
    else if (unavailable !== null) panel = <SessionUnavailable unavailable={unavailable} onClose={closePanel} />;
    else panel = <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Loading session</p>;
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-[100rem] flex-col gap-6 p-6 lg:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Agentic OS</h1>
          <p className="text-sm text-muted-foreground">
            Fleet overview · what each session is doing and what needs Dave
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

      <NavTabs view={view} onSelect={changeView} />

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

      <ReadyForDave items={ready} onSelect={(id) => choose(id, 'overview')} />

      <StatTiles tiles={tiles} />

      {view === 'board' ? (
        // The hook keeps old data after an endpoint change, so the Board shows only once it arrives.
        data.board !== null ? (
          <LaneBoard board={data.board} />
        ) : (
          <p
            data-testid="board-loading"
            className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
          >
            Loading board
          </p>
        )
      ) : view === 'sessions' ? (
        <div className="space-y-6">
          <SessionsTable
            cards={shownCards}
            selectedId={selected}
            filter={filter}
            onClear={clearFilter}
            onSelect={toggleSession}
          />
          {panel}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
          <div className="order-2 min-w-0 space-y-8 lg:order-1 lg:row-span-3">
            <SessionCards
              cards={shownCards}
              filter={filter}
              onClear={clearFilter}
              selectedId={selected}
              onSelect={toggleSession}
            />

            <ActiveSessionsStrip active={active} asks={ready} />

            <section className="space-y-3">
              <h2 className="text-sm font-medium tracking-tight">
                Projects
                <span className="ml-2 font-normal text-muted-foreground">
                  {fleet.projects.length} in the registry
                </span>
              </h2>
              <FleetGrid projects={fleet.projects} selectedKey={selectedKey} onSelect={toggleProject} />
            </section>

            <AccountingBar fleet={fleet} />

            <UnmatchedPanel unmatched={fleet.unmatched} />
          </div>

          <div className="order-1 min-w-0 lg:order-2">
            {panel ?? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                Select a session to see its goal, plan and asks.
              </p>
            )}
          </div>

          <div className="order-3 min-w-0 lg:order-3">
            <PrPanel prs={prs} onSelect={(id) => choose(id)} />
          </div>

          <div className="order-4 min-w-0 lg:order-4">
            <SourceHealth sources={sources} />
          </div>
        </div>
      )}

      <footer className="mt-auto border-t pt-4 text-xs text-muted-foreground">
        {database.ok
          ? `Connected as agentic_os_app (SELECT-only, ${database.latencyMs}ms).`
          : 'Not connected.'}{' '}
        Read-only, localhost, no login. Briefs come from session state files; asks older than 24
        hours are hidden.
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
