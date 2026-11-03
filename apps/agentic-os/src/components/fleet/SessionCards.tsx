import type { SessionCard } from '@/server/queries/mission-control';

import { cn } from '@/lib/utils';

import { chipTone, chipWord, formatAgo } from './format';
import { SessionLabel } from './SessionLabel';

/** A state file older than this is shown as stale on the card. */
const STATE_STALE_SECONDS = 15 * 60;

/** A plan with more steps than this draws one smooth bar; fewer draw one segment per step. */
const MAX_SEGMENTS = 20;

export type SessionFilter = { key: string; label: string };

/**
 * The Live sessions panel: one card per live session. Pure props: the project filter lives in
 * MissionControl, which passes the cards already filtered plus the active filter and a clear callback.
 *
 * Three states are drawn on purpose: no brief yet (a live session with no state file, or a
 * file with no brief), a stale state file, and a brief with an empty plan. Cards show counts
 * of asks, never the ask text: the text belongs to the Ready for Dave strip. The goal is not on
 * the card either; the session detail holds it. The state word comes from the glossary; the code
 * stays in `data-chip`. A card that waits on Dave has an amber border, a blocked one a red border.
 */
export function SessionCards({
  cards,
  filter,
  onClear,
  selectedId,
  onSelect,
}: {
  cards: SessionCard[];
  filter: SessionFilter | null;
  onClear: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section data-testid="session-cards" className="rounded-md border bg-card">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b px-3 py-2 text-xs text-muted-foreground">
        <h2 className="text-foreground">
          Live sessions
          <span className="ml-2 font-normal text-muted-foreground">
            {`· ${filter === null ? 'all projects' : filter.label}`}
          </span>
        </h2>
        <span>liveness: green &lt; 2 min, amber older</span>
      </header>

      <div className="flex flex-col gap-2 p-3">
        {filter !== null && (
          <div
            data-testid="session-filter"
            className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
          >
            <span className="min-w-0 [overflow-wrap:anywhere]">Project: {filter.label}</span>
            <button
              type="button"
              onClick={onClear}
              className="shrink-0 rounded-full border px-2 py-0.5 text-foreground transition-colors hover:bg-accent"
            >
              Clear
            </button>
          </div>
        )}

        {cards.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {filter !== null
              ? `No live sessions in ${filter.label}.`
              : 'No live sessions. A session shows here within 15 minutes of its last sign of life.'}
          </p>
        ) : (
          <ul className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))]">
            {cards.map((card) => (
              <SessionCardItem
                key={card.id}
                card={card}
                selected={card.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function SessionCardItem({
  card,
  selected,
  onSelect,
}: {
  card: SessionCard;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const stateStale = card.stateAgeSeconds !== null && card.stateAgeSeconds > STATE_STALE_SECONDS;
  // With a brief the plan and the counts always show. Without one they show only when the task
  // list (PRD 5.1, the Plan source when it has items) or an ask count gives them something to say.
  const showCounts =
    card.hasBrief || card.planTotal > 0 || card.askOpen > 0 || card.askStale > 0 || card.unproven > 0;

  return (
    <li
      data-testid="session-card"
      data-session-id={card.id}
      className={cn(
        'min-w-0 rounded-md border bg-card',
        card.chip === 'waiting-on-dave' && 'border-warn',
        card.chip === 'blocked' && 'border-bad',
        selected && 'ring-2 ring-primary',
      )}
    >
      <button
        type="button"
        aria-pressed={selected ? 'true' : 'false'}
        onClick={() => onSelect(card.id)}
        className="block w-full min-w-0 space-y-2 rounded-md p-3 text-left transition-colors hover:bg-accent/40"
      >
      <span className="flex items-center gap-2">
        {card.chip !== null && (
          <span
            data-chip={card.chip}
            className={cn(
              'shrink-0 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium',
              chipTone(card.chip),
            )}
          >
            {chipWord(card.chip)}
          </span>
        )}
        <span className="flex-1" />
        <span
          aria-hidden
          title={card.liveColour === 'green' ? 'active in the last 2 minutes' : 'quiet for over 2 minutes'}
          className={cn('size-2 shrink-0 rounded-full', card.liveColour === 'green' ? 'bg-done' : 'bg-warn')}
        />
        <span className="shrink-0 text-xs text-muted-foreground">{formatAgo(card.liveSecondsAgo)}</span>
      </span>{' '}
      <span className="block min-w-0">
        <SessionLabel name={card.sessionName} shortId={card.shortId} />
      </span>{' '}
      <span
        data-testid="session-card-name"
        className="block min-w-0 font-mono text-xs font-bold [overflow-wrap:anywhere]"
      >
        {card.name}
      </span>{' '}

      {card.hasBrief && card.title !== null && (
        <span className="block text-sm [overflow-wrap:anywhere]">{card.title}</span>
      )}{' '}
      {!card.hasBrief && (
        <span className="block text-xs text-muted-foreground">
          No brief yet{' '}
          {!showCounts && card.ctxPct !== null && (
            <span className="ml-2 font-mono">{`ctx ${card.ctxPct}%`}</span>
          )}
        </span>
      )}{' '}

      {card.planTotal > 0 && <PlanBar done={card.planDone} total={card.planTotal} />}{' '}
      {card.planTotal === 0 && card.hasBrief && (
        <span className="block text-xs text-muted-foreground">No plan steps yet.</span>
      )}{' '}

      {showCounts && (
        <span className="flex flex-wrap items-center gap-x-3.5 gap-y-1 font-mono text-xs">
          {/* The {' '} text nodes keep the words apart in the page text: a screen reader
              and a text search read "1 of 3 ASK 1 UNPROVEN 1", not "1 of 3ASK 1UNPROVEN 1". */}
          {card.planTotal > 0 && (
            <>
              <span className="tabular-nums text-muted-foreground">{`${card.planDone} of ${card.planTotal}`}</span>{' '}
            </>
          )}
          <span className={card.askOpen > 0 ? 'text-warn' : 'text-muted-foreground'}>
            {`ASK ${card.askOpen}`}
          </span>{' '}
          {card.askStale > 0 && (
            <>
              <span className="text-muted-foreground">{`ASK STALE ${card.askStale}`}</span>{' '}
            </>
          )}
          <span className={card.unproven > 0 ? 'text-warn' : 'text-muted-foreground'}>
            {`UNPROVEN ${card.unproven}`}
          </span>{' '}
          <span className="flex-1" />
          {card.ctxPct !== null && (
            <span className="text-muted-foreground">{`ctx ${card.ctxPct}%`}</span>
          )}
        </span>
      )}{' '}

      {card.stateAgeSeconds !== null && (
        <span className={cn('block text-[0.6875rem]', stateStale ? 'text-warn' : 'text-muted-foreground')}>
          {stateStale
            ? `state file stale: written ${formatAgo(card.stateAgeSeconds)}`
            : `state written ${formatAgo(card.stateAgeSeconds)}`}
        </span>
      )}
      </button>
    </li>
  );
}

/** One segment per plan step, done ones green. A long plan draws one smooth bar instead. */
function PlanBar({ done, total }: { done: number; total: number }) {
  if (total > MAX_SEGMENTS) {
    const pct = Math.round((done / total) * 100);
    return (
      <span aria-hidden className="flex h-1.5 overflow-hidden rounded-sm bg-muted">
        <span className="block h-full bg-done" style={{ width: `${pct}%` }} />
      </span>
    );
  }
  return (
    <span aria-hidden className="flex gap-[3px]">
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className={cn('h-1.5 min-w-0 flex-1 rounded-sm', index < done ? 'bg-done' : 'bg-muted')}
        />
      ))}
    </span>
  );
}
