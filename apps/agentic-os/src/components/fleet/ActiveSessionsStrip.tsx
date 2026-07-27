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
  const { sessions, windowMinutes, truncated } = active;

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
          No session has sent a heartbeat in {windowMinutes} minutes. Heartbeats are written
          by the coordination hooks on tool use, so an open-but-idle terminal will drop off
          this strip before it is actually closed.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {sessions.map((session) => {
            const fresh = session.heartbeatSecondsAgo < 120;
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
                    heartbeat {formatAgo(session.heartbeatSecondsAgo)}
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

      <p className="text-xs leading-relaxed text-muted-foreground">
        {sessions.length > 0 && (
          <>
            {sessions.length} live {plural(sessions.length, 'session')}.{' '}
          </>
        )}
        Sessions are never deleted from <code className="text-[0.7rem]">public.sessions</code>,
        so &ldquo;active&rdquo; is defined entirely by this {windowMinutes}-minute heartbeat
        window — not by anything the row itself records as open or closed.
      </p>
    </section>
  );
}
