import type { ReadyItem } from '@/server/queries/mission-control';

import { formatAge } from './format';

/**
 * Ready for Dave: every open, unanswered, non-stale ask of a session that is live or quiet
 * (last sign of life under 24 h ago, not ended), oldest first.
 *
 * Amber is the colour for "a person is needed". The strip sits at the very top of the page.
 * The server already dropped answered asks, asks older than 24 h, and asks of sessions that
 * ended or were quiet for over 24 h, so this component only draws what it is given.
 */
export function ReadyForDave({ items }: { items: ReadyItem[] }) {
  return (
    <section
      data-testid="ready-for-dave"
      className="space-y-3 rounded-lg border border-warn/40 bg-warn/5 p-4"
    >
      <h2 className="text-sm font-medium tracking-tight text-warn">
        Ready for Dave
        <span className="ml-2 font-normal text-muted-foreground">
          {items.length} {items.length === 1 ? 'ask' : 'asks'} waiting
        </span>
      </h2>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing waiting on Dave.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2">
          {items.map((item, index) => (
            <li
              key={`${item.sessionId}:${index}`}
              data-testid="ready-item"
              data-session-id={item.sessionId}
              className="min-w-0 rounded-md border border-warn/30 bg-card p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="min-w-0 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {item.name}
                </span>
                <span className="shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums">
                  <span className="mr-2 rounded-full border border-warn/40 px-2 py-0.5 text-warn">
                    {item.kind}
                  </span>
                  waiting {formatAge(item.ageSeconds)}
                </span>
              </div>
              <p className="mt-2 text-sm [overflow-wrap:anywhere]">{item.text}</p>
              {item.recommend !== null && (
                <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  <span className="text-warn">Recommend:</span> {item.recommend}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
