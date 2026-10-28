import type { SessionCard } from '@/server/queries/mission-control';

import { cn } from '@/lib/utils';

import { formatAgo } from './format';
import type { SessionFilter } from './SessionCards';

const COLUMNS = ['State', 'Name', 'Title', 'Lane', 'Plan', 'Ask', 'Ctx', 'Last seen'] as const;

/**
 * The Sessions view: one row per live session (the same cards, already filtered by the project
 * filter). Pure props. The name cell holds the only button of a row; a click selects the session.
 * No whitespace text nodes inside the table markup.
 */
export function SessionsTable({
  cards,
  selectedId,
  filter,
  onClear,
  onSelect,
}: {
  cards: SessionCard[];
  selectedId: string | null;
  filter: SessionFilter | null;
  onClear: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <section data-testid="sessions-table" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 className="text-sm font-medium tracking-tight">
          Sessions
          <span className="ml-2 font-normal text-muted-foreground">{cards.length} live</span>
        </h2>
        {filter !== null && (
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
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

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[44rem] border-collapse text-left text-xs">
          <thead>
            <tr className="border-b bg-card text-muted-foreground">
              {COLUMNS.map((name) => (
                <th key={name} scope="col" className="px-3 py-2 font-medium">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cards.map((card) => (
              <Row key={card.id} card={card} selected={card.id === selectedId} onSelect={onSelect} />
            ))}
          </tbody>
        </table>
      </div>
      {cards.length === 0 && (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground [overflow-wrap:anywhere]">
          No live sessions
        </p>
      )}
    </section>
  );
}

function Row({
  card,
  selected,
  onSelect,
}: {
  card: SessionCard;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <tr
      data-testid="session-row"
      data-session-id={card.id}
      className={cn('border-b last:border-b-0', selected && 'bg-accent/60')}
    >
      <td data-testid="session-row-state" className="px-3 py-2 align-top">
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            title={card.liveColour === 'green' ? 'active in the last 2 minutes' : 'quiet for over 2 minutes'}
            className={cn(
              'size-2 shrink-0 rounded-full',
              card.liveColour === 'green' ? 'bg-done' : 'bg-warn',
            )}
          />
          <span className="font-mono">{card.chip ?? '-'}</span>
        </span>
      </td>
      <td className="px-3 py-2 align-top">
        <button
          type="button"
          data-testid="session-row-select"
          aria-pressed={selected ? 'true' : 'false'}
          onClick={() => onSelect(card.id)}
          className="text-left font-mono underline-offset-2 hover:underline"
        >
          {card.name}
        </button>
      </td>
      <td data-testid="session-row-title" className="max-w-[16rem] px-3 py-2 align-top [overflow-wrap:anywhere]">
        {card.title ?? '-'}
      </td>
      <td data-testid="session-row-lane" className="px-3 py-2 align-top font-mono [overflow-wrap:anywhere]">
        {card.laneId ?? '-'}
      </td>
      <td data-testid="session-row-plan" className="px-3 py-2 align-top tabular-nums">
        {card.planTotal > 0 ? `${card.planDone}/${card.planTotal}` : '-'}
      </td>
      <td
        data-testid="session-row-ask"
        className={cn('px-3 py-2 align-top tabular-nums', card.askOpen > 0 && 'text-warn')}
      >
        {card.askOpen}
      </td>
      <td data-testid="session-row-ctx" className="px-3 py-2 align-top tabular-nums">
        {card.ctxPct === null ? '-' : `${card.ctxPct}%`}
      </td>
      <td data-testid="session-row-seen" className="px-3 py-2 align-top text-muted-foreground">
        {formatAgo(card.liveSecondsAgo)}
      </td>
    </tr>
  );
}
