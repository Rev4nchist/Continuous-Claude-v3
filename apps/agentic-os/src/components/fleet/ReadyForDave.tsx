import type { ReadyCoord as ReadyCoordData, ReadyItem } from '@/server/queries/mission-control';

import { formatAge, plural } from './format';
import { SessionLabel } from './SessionLabel';

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
                    <SessionLabel name={item.sessionName} shortId={item.shortId} />
                    {' · '}
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

/** Rows drawn. The section sits above Projects and Live sessions, so its height must not grow with the database. */
const COORD_SHOWN = 4;

/**
 * From the lane board: what waits for Dave in the lane CLI's own rules, all boards. A sibling of Ready for
 * Dave, never inside it: the Ready pins (the "N waiting" header, "Nothing waiting on Dave.", `ready-item`)
 * keep their meaning. Read only: no button, no link, no session id in the DOM. The server wrote each line
 * (counts, lane ids, board keys and Central times as text), so this only draws it. Amber is a dot; the words
 * carry the meaning. At most COORD_SHOWN rows are drawn, in server order (one row of each kind first: unread, park,
 * reminder, then the rest): the header counts every row and says how many are not drawn. The Live sessions panel
 * below keeps its place in the first screen. The section always renders (ruling R13), so a poll never shifts the page:
 * with no rows it holds one line and "0 items"; with an error it holds the error line.
 */
export function ReadyCoord({ coord }: { coord: ReadyCoordData }) {
  const count = coord.rows.length;
  const shown = coord.rows.slice(0, COORD_SHOWN);
  const hidden = count - shown.length;

  return (
    <section data-testid="ready-coord" className="rounded-md border bg-card">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b px-3 py-2 text-xs text-muted-foreground">
        <h2 className="text-foreground">From the lane board</h2>
        {coord.status === 'ok' && (
          <span data-testid="ready-coord-count" className="shrink-0 tabular-nums text-warn">
            {`${count} ${plural(count, 'item')}`}
            {hidden > 0 ? `, ${hidden}${coord.truncated ? '+' : ''} more not shown` : coord.truncated && ', more not shown'}
          </span>
        )}
      </header>

      <div className="p-3">
        {coord.status === 'error' ? (
          <p data-testid="ready-coord-error" role="status" className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {`Lane board signals unavailable: ${coord.error ?? 'read failed'}`}
          </p>
        ) : count === 0 ? (
          <p data-testid="ready-coord-empty" className="text-sm text-muted-foreground">
            Nothing from the lane board.
          </p>
        ) : (
          <ul className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))]">
            {shown.map((row, index) => (
              <li
                key={`${row.kind}-${index}`}
                data-testid="ready-coord-item"
                data-kind={row.kind}
                data-lane-id={row.kind === 'unread' ? undefined : row.laneId}
                className="flex min-w-0 gap-2.5 rounded bg-[var(--bg3)] px-2.5 py-2"
              >
                <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-warn" />
                <div className="min-w-0 flex-1">
                  <p data-testid="ready-coord-text" className="text-sm [overflow-wrap:anywhere]">
                    {row.text}
                  </p>
                  {row.kind !== 'unread' && row.title !== '' && (
                    <p className="truncate text-xs text-muted-foreground" title={row.title}>
                      {row.title}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
