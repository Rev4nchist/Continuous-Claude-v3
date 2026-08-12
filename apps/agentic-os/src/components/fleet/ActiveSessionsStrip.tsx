import type { ActiveSessions } from '@/server/queries/sessions';

import { cn } from '@/lib/utils';

import { formatAge, formatAgo, plural } from './format';

/**
 * Who is working right now.
 *
 * This is the strip that makes the acceptance test real: open a second terminal,
 * and its session appears here within one poll without a refresh.
 *
 * An UNMAPPED session is rendered with its raw path rather than hidden. The
 * fleet grid can only count sessions it can attribute; this strip must show
 * every live session regardless, or the two halves of the screen would disagree
 * about whether you are working.
 */
export function ActiveSessionsStrip({ active }: { active: ActiveSessions }) {
  const { sessions, recentlyEnded, windowMinutes, truncated } = active;

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium tracking-tight">
          Active sessions
          <span className="ml-2 font-normal text-muted-foreground">
            {sessions.length} in the last {windowMinutes}m
          </span>
        </h2>
        {truncated && (
          <span className="text-xs text-amber-600 dark:text-amber-500">
            list truncated — more sessions matched than shown
          </span>
        )}
      </div>

      {sessions.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No session has shown any sign of life in {windowMinutes} minutes. Liveness is the
          more recent of a user prompt and an agent tool call, so an open-but-idle terminal
          will drop off this strip before it is actually closed.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {sessions.map((session) => {
            // Keyed on liveSecondsAgo, NOT heartbeatSecondsAgo. Measured on this
            // machine 2026-07-28: session 9370e196 had made a tool call 5 seconds
            // earlier and had a 442-second-old heartbeat, so the old test painted
            // an actively-working agent amber. The dot answers "is anything
            // happening", and a tool call is something happening.
            const fresh = session.liveSecondsAgo < 120;
            return (
              <li
                key={session.id}
                className="flex items-start gap-3 rounded-lg border bg-card p-3"
              >
                <span
                  aria-hidden
                  className={cn(
                    'mt-1.5 size-2 shrink-0 rounded-full',
                    fresh ? 'bg-emerald-500' : 'bg-amber-500',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-medium">
                      {session.projectDisplayName ?? (
                        <span className="text-amber-600 dark:text-amber-500">unmapped</span>
                      )}
                    </span>
                    <span
                      className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground"
                      title={session.id}
                    >
                      {session.shortId}
                    </span>
                  </div>

                  {session.projectKey === null && (
                    <p className="truncate font-mono text-[0.6875rem] text-muted-foreground">
                      {session.rawProject}
                    </p>
                  )}

                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {session.workingOn ?? (
                      <span className="italic">no working_on recorded</span>
                    )}
                  </p>

                  <p className="mt-1.5 text-[0.6875rem] tabular-nums text-muted-foreground">
                    active {formatAgo(session.liveSecondsAgo)}
                    {session.activitySecondsAgo !== null && (
                      <> · tool {formatAgo(session.activitySecondsAgo)}</>
                    )}
                    {' · prompt '}
                    {formatAgo(session.heartbeatSecondsAgo)}
                    {session.startedSecondsAgo !== null && (
                      <> · open {formatAge(session.startedSecondsAgo)}</>
                    )}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {recentlyEnded.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium tracking-tight text-muted-foreground">
            Closed in the last {windowMinutes}m
          </h3>
          <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {recentlyEnded.map((session) => (
              <li
                key={session.id}
                className="flex items-start gap-3 rounded-lg border border-dashed p-3 opacity-70"
              >
                <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/40" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm">
                      {session.projectDisplayName ?? (
                        <span className="text-amber-600 dark:text-amber-500">unmapped</span>
                      )}
                    </span>
                    <span
                      className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground"
                      title={session.id}
                    >
                      {session.shortId}
                    </span>
                  </div>
                  <p className="mt-1 text-[0.6875rem] tabular-nums text-muted-foreground">
                    {/* Membership in this list comes from the SQL predicate, not
                        from this number, so it can in principle be absent. Say so
                        rather than rendering `?? 0` as "closed just now". */}
                    {session.endedSecondsAgo === null
                      ? 'closed, time unknown'
                      : `closed ${formatAgo(session.endedSecondsAgo)}`}
                    {session.endReason && (
                      <> · <span className="font-mono">{session.endReason}</span></>
                    )}
                    {session.startedSecondsAgo !== null && (
                      <> · ran {formatAge(session.startedSecondsAgo)}</>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        {sessions.length > 0 && (
          <>
            {sessions.length} live {plural(sessions.length, 'session')}.{' '}
          </>
        )}
        {/* CORRECTED 2026-07-28. This paragraph used to end "nothing writes an
            end-of-session marker ... a terminal you closed twelve minutes ago is
            still here". Something writes one now, so that had to go — a stale
            explanation of a fixed bug is worse than none. What replaces it is the
            limit that is STILL true, stated as narrowly as it actually holds. */}
        A session leaves this list the moment its SessionEnd hook records an end,
        and reappears under &ldquo;closed&rdquo; above. That hook cannot run if the
        process is killed outright, so a session with no recorded end is{' '}
        <em>unknown</em>, not necessarily alive — for those, and for every row
        written before 2026-07-28, this {windowMinutes}-minute window of silence is
        still the only thing separating live from long gone.
      </p>
    </section>
  );
}
