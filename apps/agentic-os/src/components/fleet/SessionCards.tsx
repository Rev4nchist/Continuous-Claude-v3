import type { SessionCard } from '@/server/queries/mission-control';

import { cn } from '@/lib/utils';

import { formatAgo } from './format';

/** A state file older than this is shown as stale on the card. */
const STATE_STALE_SECONDS = 15 * 60;

const CHIP_TONE: Record<string, string> = {
  working: 'border-doing/40 text-doing',
  'waiting-on-dave': 'border-warn/50 bg-warn/10 text-warn',
  blocked: 'border-bad/50 bg-bad/10 text-bad',
  done: 'border-done/40 text-done',
  idle: 'border-border text-muted-foreground',
};

export type SessionFilter = { key: string; label: string };

/**
 * One card per live session. Pure props: the project filter lives in MissionControl, which
 * passes the cards already filtered plus the active filter and a clear callback.
 *
 * Three states are drawn on purpose: no brief yet (a live session with no state file, or a
 * file with no brief), a stale state file, and a brief with an empty plan. Cards show counts
 * of asks, never the ask text: the text belongs to the Ready for Dave strip.
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
    <section data-testid="session-cards" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 className="text-sm font-medium tracking-tight">
          Sessions
          <span className="ml-2 font-normal text-muted-foreground">{cards.length} live</span>
        </h2>
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
      </div>

      {cards.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {filter !== null
            ? `No live sessions in ${filter.label}.`
            : 'No live sessions. A session shows here within 15 minutes of its last sign of life.'}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
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
  const pct = card.planTotal > 0 ? Math.round((card.planDone / card.planTotal) * 100) : 0;
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
        'min-w-0 rounded-lg border bg-card',
        selected && 'ring-2 ring-primary',
      )}
    >
      <button
        type="button"
        aria-pressed={selected ? 'true' : 'false'}
        onClick={() => onSelect(card.id)}
        className="block w-full min-w-0 space-y-2 rounded-lg p-3 text-left transition-colors hover:bg-accent/40"
      >
      <span className="flex items-start gap-2">
        <span
          aria-hidden
          title={card.liveColour === 'green' ? 'active in the last 2 minutes' : 'quiet for over 2 minutes'}
          className={cn(
            'mt-1.5 size-2 shrink-0 rounded-full',
            card.liveColour === 'green' ? 'bg-done' : 'bg-warn',
          )}
        />
        <span
          data-testid="session-card-name"
          className="min-w-0 flex-1 font-mono text-xs [overflow-wrap:anywhere]"
        >
          {card.name}
        </span>
        {card.chip !== null && (
          <span
            className={cn(
              'shrink-0 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium',
              CHIP_TONE[card.chip],
            )}
          >
            {card.chip}
          </span>
        )}
      </span>{' '}

      {card.hasBrief && card.title !== null && (
        <span className="block text-sm font-medium [overflow-wrap:anywhere]">{card.title}</span>
      )}{' '}
      {card.hasBrief && card.goal !== null && (
        <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{card.goal}</span>
      )}{' '}
      {!card.hasBrief && (
        <span className="block text-xs text-muted-foreground">
          No brief yet{' '}
          {!showCounts && card.ctxPct !== null && (
            <span className="ml-2 font-mono">{`ctx ${card.ctxPct}%`}</span>
          )}
        </span>
      )}{' '}

      {card.planTotal > 0 ? (
        <span className="flex items-center gap-2 text-xs">
          <span aria-hidden className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-done" style={{ width: `${pct}%` }} />
          </span>{' '}
          <span className="shrink-0 tabular-nums">{`${card.planDone} of ${card.planTotal}`}</span>
        </span>
      ) : (
        card.hasBrief && <span className="block text-xs text-muted-foreground">No plan steps yet.</span>
      )}{' '}

      {showCounts && (
        <span className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[0.6875rem]">
          {/* The {' '} text nodes keep the words apart in the page text: a screen reader
              and a text search read "ASK 1 UNPROVEN 1", not "ASK 1UNPROVEN 1". */}
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
