'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import type { MissionControlSnapshot } from '@/server/queries/mission-control';

import { useLiveData } from '@/hooks/useLiveData';
import { cn } from '@/lib/utils';

import { AccountingBar } from './AccountingBar';
import { ActiveSessionsStrip } from './ActiveSessionsStrip';
import { FleetGrid } from './FleetGrid';
import { FlowView } from './FlowView';
import { LaneBoard } from './LaneBoard';
import { NavTabs, type ViewId } from './NavTabs';
import { PrPanel } from './PrPanel';
import { ReadyCoord, ReadyForDave } from './ReadyForDave';
import { SessionCards } from './SessionCards';
import { SessionDetail, SessionUnavailable } from './SessionDetail';
import { SessionsTable } from './SessionsTable';
import { SpendView } from './SpendView';
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

/** The one endpoint. The Board and the Spend tab are asked for only while their tab is active. */
function endpointFor(view: ViewId, session: string | null, project: string | null): string {
  const params = new URLSearchParams();
  if (view === 'board') params.set('view', 'board');
  if (view === 'spend') params.set('view', 'spend');
  if (view === 'flow') params.set('view', 'flow');
  // Without the board key every poll would fall back to the default board.
  if (view === 'board' && project !== null) params.set('project', project);
  if (session !== null) params.set('session', session);
  const query = params.toString();
  return query === '' ? BASE_ENDPOINT : `${BASE_ENDPOINT}?${query}`;
}

/** Mirror the view and the selection in the address bar. replaceState: no navigation, no history entry. */
function mirrorUrl(view: ViewId, session: string | null, project: string | null): void {
  const params = new URLSearchParams();
  if (view !== 'overview') params.set('view', view);
  if (project !== null) params.set('project', project);
  if (session !== null) params.set('session', session);
  const query = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}

export function MissionControl({
  initial,
  initialView = 'overview',
  initialSession = null,
  initialProject = null,
}: {
  initial: MissionControlSnapshot;
  initialView?: ViewId;
  initialSession?: string | null;
  /** The board key from `?project=`; null is the default board (continuous-claude). It does not change on the page. */
  initialProject?: string | null;
}) {
  // The view and the selected session live here and nowhere else. The endpoint carries the
  // selection, so the next poll brings the detail of that session.
  const [view, setView] = useState<ViewId>(initialView);
  const [selected, setSelected] = useState<string | null>(initialSession);

  const { data, status, error, ageMs, consecutiveFailures, refresh } =
    useLiveData<MissionControlSnapshot>({
      endpoint: endpointFor(view, selected, initialProject),
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

  // Choosing a session moves focus to the detail heading and, only when the heading is off screen,
  // scrolls to it. On a phone the detail is drawn first but comes late in the DOM, so a keyboard or
  // screen-reader user would otherwise stay on the card they pressed. A load with ?session= or a poll
  // does not move focus: only a choice does.
  const detailRef = useRef<HTMLDivElement>(null);
  // A counter, not a flag: choosing the open session changes no other state, and a flag alone
  // would cause no render and no effect run.
  const [focusRequest, setFocusRequest] = useState(0);
  const handledFocus = useRef(0);
  const panelState = detail !== null ? 'detail' : unavailable !== null ? 'unavailable' : 'loading';
  useEffect(() => {
    if (focusRequest === handledFocus.current || selected === null || panelState === 'loading') return;
    // The request ends here, with or without a heading: the "not available" panel has none, and a
    // later poll that turns it into the detail must not move focus.
    handledFocus.current = focusRequest;
    const area = detailRef.current;
    const heading = area?.querySelector('h2');
    if (!area || !heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    // The whole detail scrolls to the top of the screen, not only its heading.
    const { top, bottom } = heading.getBoundingClientRect();
    if (top < 0 || bottom > window.innerHeight) area.scrollIntoView({ block: 'start' });
  }, [focusRequest, selected, panelState]);

  const changeView = (next: ViewId) => {
    handledFocus.current = focusRequest; // a tab switch is not a choice: drop a pending request
    setView(next);
    mirrorUrl(next, selected, initialProject);
  };
  const choose = (id: string | null, nextView: ViewId = view) => {
    // A close drops a pending request.
    if (id !== null) setFocusRequest((n) => n + 1);
    else handledFocus.current = focusRequest;
    setSelected(id);
    setView(nextView);
    mirrorUrl(nextView, id, initialProject);
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
    <div className="flex min-h-screen flex-col">
      {/* One top strip: the mark and the tabs on the left, the live text on the right. */}
      <header className="border-b bg-background">
        <div className="mx-auto flex w-full max-w-[1360px] flex-wrap items-center gap-x-1.5 gap-y-1 px-4">
          <h1 className="sr-only">Agentic OS</h1>
          <NavTabs view={view} onSelect={changeView} />
          <LiveIndicator
            status={status}
            error={error}
            ageMs={ageMs}
            generatedAt={data.generatedAt}
            consecutiveFailures={consecutiveFailures}
            onRefresh={refresh}
          />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1360px] flex-1 flex-col gap-3.5 p-4">
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

        <StatTiles tiles={tiles} databaseOk={database.ok} />

        {/* Below the tiles on purpose: fleet-layout.spec.ts pins the tile row inside the first phone screen, and this list grows with the lane board. */}
        <ReadyCoord coord={data.coord} />

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
        ) : view === 'spend' ? (
          // Same rule as the Board: the old data stays until the answer for this view lands.
          data.spend !== null ? (
            <SpendView spend={data.spend} />
          ) : (
            <p
              data-testid="spend-loading"
              className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
            >
              Loading spend
            </p>
          )
        ) : view === 'flow' ? (
          // Same rule again: the old data stays until the answer for this view lands.
          data.flow !== null ? (
            <FlowView flow={data.flow} />
          ) : (
            <p
              data-testid="flow-loading"
              className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
            >
              Loading flow
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
            {panel !== null && <div ref={detailRef}>{panel}</div>}
          </div>
        ) : (
          // Two columns from `lg` up. On a phone the column wrappers are `contents`, so every panel
          // sits in one column and the `order-*` classes put the selected session first.
          <div className="flex flex-col gap-3.5 lg:flex-row lg:items-start">
            <div className="contents lg:flex lg:min-w-0 lg:flex-[999_1_620px] lg:flex-col lg:gap-3.5">
              <div className="order-2 min-w-0 lg:order-none">
                <section className="rounded-md border bg-card">
                  <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b px-3 py-2 text-xs text-muted-foreground">
                    <h2 className="text-foreground">
                      Projects
                      <span className="ml-2 font-normal text-muted-foreground">· fleet home</span>
                    </h2>
                    <span>click to filter sessions</span>
                  </header>
                  <div className="p-3">
                    <FleetGrid
                      projects={fleet.projects}
                      selectedKey={selectedKey}
                      onSelect={toggleProject}
                    />
                  </div>
                </section>
              </div>

              <div className="order-3 min-w-0 lg:order-none">
                <SessionCards
                  cards={shownCards}
                  filter={filter}
                  onClear={clearFilter}
                  selectedId={selected}
                  onSelect={toggleSession}
                />
              </div>

              <div className="order-4 min-w-0 lg:order-none">
                <ActiveSessionsStrip active={active} asks={ready} />
              </div>

              <div className="order-5 min-w-0 lg:order-none">
                <AccountingBar fleet={fleet} />
              </div>

              <div className="order-6 min-w-0 lg:order-none">
                <UnmatchedPanel unmatched={fleet.unmatched} />
              </div>
            </div>

            <div className="contents lg:flex lg:min-w-0 lg:flex-[1_1_380px] lg:flex-col lg:gap-3.5">
              <div
                ref={detailRef}
                className={cn('order-1 min-w-0 lg:order-none', panel === null && 'hidden lg:block')}
              >
                {panel ?? (
                  <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    Select a session to see its goal, plan and asks.
                  </p>
                )}
              </div>

              <div className="order-7 min-w-0 lg:order-none">
                <PrPanel prs={prs} onSelect={(id) => choose(id)} />
              </div>

              <div className="order-8 min-w-0 lg:order-none">
                <SourceHealth sources={sources} />
              </div>
            </div>
          </div>
        )}

        <footer className="mt-auto px-0.5 py-1 text-xs text-muted-foreground">
          {database.ok
            ? `Connected as agentic_os_app (SELECT-only, ${database.latencyMs}ms).`
            : 'Not connected.'}{' '}
          Read-only, localhost, no login. Briefs come from session state files; asks older than 24
          hours are hidden.
        </footer>
      </main>
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
  // The server render and the first client render both slice UTC out of the ISO string, never a
  // Date: new Date(...) there would print the viewer's zone on the client and UTC during SSR, a
  // hydration mismatch. After mount the clock switches to local time, which is what Dave reads.
  // useSyncExternalStore gives the `mounted` flag without a setState in an effect.
  const mounted = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  const isoOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(generatedAt);
  const serverClock = !isoOk
    ? null
    : mounted
      ? new Date(generatedAt).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
        })
      : `${generatedAt.slice(11, 19)}Z`;

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
    <div className="ml-auto flex flex-col items-end gap-0.5 py-1">
      <div className="flex flex-wrap items-center justify-end gap-x-1 text-xs">
        <button
          type="button"
          onClick={onRefresh}
          className="flex min-h-6 items-center gap-2 rounded px-1.5 py-1 transition-colors hover:bg-accent"
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
            className="tabular-nums text-muted-foreground"
            title="Local time of the server read. Unlike the relative age, this cannot keep counting while the data underneath it is frozen."
          >
            {`· polls 5s · data as of ${serverClock}`}
          </span>
        )}
      </div>
      {status === 'error' && error && (
        <span className="max-w-xs truncate text-right font-mono text-[0.6875rem] text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

/** useSyncExternalStore needs a subscribe; the mounted flag never changes after mount. */
function subscribeNothing(): () => void {
  return () => {};
}
