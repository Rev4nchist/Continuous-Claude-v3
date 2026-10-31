import type { ReadyItem } from '@/server/queries/mission-control';
import type { ActiveSessions } from '@/server/queries/sessions';

import { cn } from '@/lib/utils';

import { formatAge, formatAgo } from './format';

/**
 * Two panels: sessions the app cannot place, and sessions that just closed.
 *
 * A session that maps to a project shows only as a card (SessionCards); this strip does not
 * repeat it. A live session with NO project mapping is listed here with its raw folder name
 * instead of being hidden, so the cards and this list cannot disagree about whether you are
 * working. Its first open ask (from the Ready for Dave rows, passed in as `asks`) shows on one line.
 * No prompt text is shown anywhere in this strip.
 */
export function ActiveSessionsStrip({
  active,
  asks = [],
}: {
  active: ActiveSessions;
  asks?: ReadyItem[];
}) {
  const { sessions, recentlyEnded, windowMinutes, truncated } = active;
  const unmatched = sessions.filter((session) => session.projectKey === null);
  const askOf = new Map(asks.map((item) => [item.sessionId, item]));

  return (
    <div className="flex flex-wrap gap-3.5">
      <section data-testid="unmatched-sessions" className="min-w-0 flex-[1_1_300px] rounded-md border bg-card">
        <header className="flex items-baseline justify-between gap-3 border-b px-3 py-2 text-xs text-muted-foreground">
          <h2 className="text-foreground">
            Unmatched sessions
            <span className="ml-2 font-normal text-muted-foreground">{unmatched.length}</span>
          </h2>
          {truncated && <span className="text-warn">list truncated</span>}
        </header>
        <div className="p-3">
          {unmatched.length === 0 ? (
            <p className="text-sm text-muted-foreground">none</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {unmatched.map((session) => {
                const item = askOf.get(session.id);
                return (
                  <li
                    key={session.id}
                    data-testid="unmatched-session"
                    data-session-id={session.id}
                    className="flex min-w-0 gap-2.5 rounded bg-[var(--bg3)] px-2.5 py-2"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'mt-1.5 size-2 shrink-0 rounded-full',
                        session.liveSecondsAgo < 120 ? 'bg-emerald-500' : 'bg-amber-500',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        <span className="font-mono" title={session.id}>
                          {session.shortId}
                        </span>
                        {` · ${session.rawProject} · active ${formatAgo(session.liveSecondsAgo)}`}
                      </p>
                      {item !== undefined && (
                        <p data-testid="unmatched-ask" title={item.text} className="truncate text-sm">
                          <span className="text-warn">{item.kind}</span> {item.text}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <section data-testid="closed-sessions" className="min-w-0 flex-[1_1_300px] rounded-md border bg-card">
        <header className="flex items-baseline justify-between gap-3 border-b px-3 py-2 text-xs text-muted-foreground">
          <h2 className="text-foreground">
            Closed in the last {windowMinutes}m
            <span className="ml-2 font-normal text-muted-foreground">{recentlyEnded.length}</span>
          </h2>
        </header>
        <div className="p-3">
          {recentlyEnded.length === 0 ? (
            <p className="text-sm text-muted-foreground">none</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {recentlyEnded.map((session) => (
                <li
                  key={session.id}
                  data-testid="closed-session"
                  data-session-id={session.id}
                  className="flex min-w-0 gap-2.5 rounded bg-[var(--bg3)] px-2.5 py-2 opacity-70"
                >
                  <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/40" />
                  <p className="min-w-0 flex-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    <span className="font-mono" title={session.id}>
                      {session.shortId}
                    </span>
                    {` · ${session.projectDisplayName ?? session.rawProject}`}
                    {session.endReason !== null && ` · ${session.endReason}`}
                    {/* Membership in this list comes from the SQL predicate, not from this number,
                        so it can in principle be absent. Say so rather than render `?? 0` as "closed just now". */}
                    {session.endedSecondsAgo === null
                      ? ' · closed, time unknown'
                      : ` · closed ${formatAgo(session.endedSecondsAgo)}`}
                    {session.startedSecondsAgo !== null && ` · ran ${formatAge(session.startedSecondsAgo)}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
