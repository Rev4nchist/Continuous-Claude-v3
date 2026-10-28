import type { PrRow } from '@/server/queries/mission-control';

import { cn } from '@/lib/utils';

/** States that need a person are drawn warm. Everything else, including an unknown word, is plain. */
const PERSON_STATES = new Set(['LIMITED', 'REVIEWED', 'PROOF', 'STALLED']);

/**
 * Pull requests that live sessions watch (state files only). Pure props. Each watching session
 * is a real button; the click selects the session and keeps the view. A null state reads
 * "unchecked". The note says what this list is not.
 */
export function PrPanel({ prs, onSelect }: { prs: PrRow[]; onSelect: (id: string) => void }) {
  return (
    <section data-testid="pr-panel" className="space-y-3">
      <div
        data-testid="pr-header"
        className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm font-medium tracking-tight"
      >
        <span>Pull requests</span>
        <span className="text-xs font-normal text-muted-foreground">watched by live sessions</span>
      </div>

      {prs.length === 0 ? (
        <p
          data-testid="pr-panel-empty"
          className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
        >
          No PR is watched by a live session.
        </p>
      ) : (
        <ul className="space-y-2">
          {prs.map((row) => (
            <li
              key={row.key}
              data-testid="pr-row"
              data-pr-key={row.key}
              className="min-w-0 space-y-2 rounded-lg border bg-card p-3"
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span data-testid="pr-row-number" className="font-mono text-sm font-semibold">
                  {`#${row.pr}`}
                </span>
                <span
                  data-testid="pr-row-repo"
                  className="min-w-0 flex-1 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]"
                >
                  {row.repo ?? '?'}
                </span>
                <span
                  data-testid="pr-row-state"
                  className={cn(
                    'shrink-0 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium',
                    row.state !== null && PERSON_STATES.has(row.state)
                      ? 'border-warn/50 bg-warn/10 text-warn'
                      : 'border-border text-muted-foreground',
                  )}
                >
                  {row.state ?? 'unchecked'}
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {row.sessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    data-testid="pr-row-session"
                    data-session-id={session.id}
                    onClick={() => onSelect(session.id)}
                    className="max-w-full rounded border px-2 py-0.5 font-mono text-[0.6875rem] transition-colors [overflow-wrap:anywhere] hover:bg-accent"
                  >
                    {session.name}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p data-testid="pr-panel-note" className="text-xs text-muted-foreground">
        Only PRs a live session watches. Merged or ready PRs leave the watch.
      </p>
    </section>
  );
}
