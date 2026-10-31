import type { ReadyItem } from '@/server/queries/mission-control';

import { formatAge } from './format';

/**
 * Ready for Dave: one row per session that waits on Dave. The row shows the session's FIRST open,
 * unanswered, non-stale ask, redacted, on one line (the `title` holds the same text: the server clips an
 * ask to 240 characters, so the title is that clip, not the full ask). There is no
 * recommendation here, and never a prompt: the session detail panel holds every ask and the plan.
 *
 * Amber is the colour for "a person is needed". The strip sits at the very top of the page.
 * The server already dropped answered asks, asks older than 24 h, and asks of sessions that
 * ended or were quiet for over 24 h, so this component only draws what it is given.
 * The session name is a button: it opens that session's detail (the only button of an item).
 * A quiet session (no sign of life for 15 minutes, so no card) is marked `quiet` and counted in the header.
 */
export function ReadyForDave({
  items,
  onSelect,
}: {
  items: ReadyItem[];
  onSelect: (sessionId: string) => void;
}) {
  const quiet = items.filter((item) => !item.live).length;

  return (
    <section data-testid="ready-for-dave" className="rounded-md border bg-card">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b px-3 py-2 text-xs text-muted-foreground">
        <h2 className="text-foreground">
          Ready for Dave
          <span className="ml-2 font-normal text-muted-foreground">· every item waiting on you</span>
        </h2>
        <span className="shrink-0 tabular-nums text-warn">
          {items.length} waiting
          {quiet > 0 && ` · ${quiet} from quiet sessions`}
        </span>
      </header>

      <div className="p-3">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waiting on Dave.</p>
        ) : (
          <ul className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))]">
            {items.map((item) => (
              <li
                key={item.sessionId}
                data-testid="ready-item"
                data-session-id={item.sessionId}
                className="flex min-w-0 gap-2.5 rounded bg-[var(--bg3)] px-2.5 py-2"
              >
                <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-warn" />
                <div className="min-w-0 flex-1">
                  <p data-testid="ready-text" title={item.text} className="truncate text-sm">
                    <span className="text-warn">{item.kind}</span> {item.text}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => onSelect(item.sessionId)}
                      title="Open the session detail"
                      className="inline-flex min-h-6 items-center text-left font-mono underline-offset-2 transition-colors hover:text-foreground hover:underline [overflow-wrap:anywhere]"
                    >
                      {item.name}
                    </button>
                    {` · waiting ${formatAge(item.ageSeconds)}`}
                    {!item.live && ' · quiet'}
                    {item.openAsks > 1 && ` · +${item.openAsks - 1} more`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
