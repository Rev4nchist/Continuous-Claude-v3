import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

/**
 * The live half of the fleet view — who is working right now.
 *
 * See src/server/queries/health.ts for the conventions this follows (ADR-0002:
 * this directory is the API boundary; no component imports `db`).
 */

/** How recent a heartbeat has to be for a session to count as live.
 *
 *  Measured, not guessed: heartbeats are written by the coordination hooks on
 *  tool use, so an idle-but-open terminal can go several minutes without one
 *  (this session's own gap was 5m33s while actively working). A 2-minute window
 *  would blink real sessions in and out of the strip; 15 minutes is long enough
 *  to be stable and short enough that a closed terminal disappears while you
 *  still remember closing it. Sessions are never deleted, so a window is the
 *  ONLY thing separating "live" from "every session since March". */
const DEFAULT_WINDOW_MINUTES = 15;

/** A hard bound on the result set, per the shared-database rule in src/db/index.ts.
 *  Nothing sane produces 50 concurrent sessions; if it ever does, the strip
 *  truncates and says so rather than rendering an unbounded list. */
const MAX_SESSIONS = 50;

export type ActiveSession = {
  id: string;
  /** First 8 chars — what the lane bus and hook logs actually print. */
  shortId: string;
  /** NULL when this session's `project` value has no mapping yet. Rendering it as
   *  "unmapped" rather than hiding the row is the same contract the fleet grid's
   *  unmatched bucket keeps: a session you cannot attribute is still a session. */
  projectKey: string | null;
  projectDisplayName: string | null;
  /** The raw `sessions.project` string, always present. Shown when unmapped so
   *  the fix (add an alias row) is visible without opening psql. */
  rawProject: string;
  /** Truncated in SQL, not in the browser — this is the user's prompt text and
   *  there is no reason to ship 4KB of it over the wire every 5 seconds. */
  workingOn: string | null;
  heartbeatSecondsAgo: number;
  startedSecondsAgo: number | null;
};

export type ActiveSessions = {
  windowMinutes: number;
  sessions: ActiveSession[];
  /** True when more sessions matched than `MAX_SESSIONS`. */
  truncated: boolean;
};

type ActiveRow = {
  id: string;
  project_key: string | null;
  display_name: string | null;
  raw_project: string;
  working_on: string | null;
  heartbeat_seconds_ago: number;
  started_seconds_ago: number | null;
};

/**
 * Sessions with a heartbeat inside the window.
 *
 * `s-%` ids are excluded: those are `generateSessionId()` coordination rows, not
 * Claude Code sessions, and they are the MAJORITY of the table. Their count is
 * reported by getFleetOverview() rather than dropped silently.
 *
 * The `now() AT TIME ZONE 'UTC'` dance is not decoration. `sessions.last_heartbeat`
 * is `timestamp WITHOUT time zone` holding UTC; `now()` is `timestamptz`. Comparing
 * them directly makes Postgres coerce using the SESSION TimeZone, so the query would
 * be correct today (server is Etc/UTC) and silently wrong on any host that is not.
 */
export async function getActiveSessions(
  windowMinutes: number = DEFAULT_WINDOW_MINUTES,
): Promise<ActiveSessions> {
  const { rows } = await db.execute<ActiveRow>(sql`
    SELECT
      s.id,
      a.project_key,
      p.display_name,
      s.project                                                   AS raw_project,
      NULLIF(left(btrim(regexp_replace(s.working_on, '\\s+', ' ', 'g')), 140), '')
                                                                  AS working_on,
      EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - s.last_heartbeat))::int
                                                                  AS heartbeat_seconds_ago,
      EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - s.started_at))::int
                                                                  AS started_seconds_ago
    FROM public.sessions s
    LEFT JOIN agentic_os.project_alias a
      ON a.raw = s.project AND a.project_key IS NOT NULL
    LEFT JOIN agentic_os.project p ON p.key = a.project_key
    WHERE s.id NOT LIKE 's-%'
      AND s.last_heartbeat IS NOT NULL
      AND s.last_heartbeat > (now() AT TIME ZONE 'UTC')
                             - make_interval(mins => ${windowMinutes})
    ORDER BY s.last_heartbeat DESC
    LIMIT ${MAX_SESSIONS + 1}
  `);

  const truncated = rows.length > MAX_SESSIONS;

  return {
    windowMinutes,
    truncated,
    sessions: rows.slice(0, MAX_SESSIONS).map((r) => ({
      id: r.id,
      shortId: r.id.slice(0, 8),
      projectKey: r.project_key,
      projectDisplayName: r.display_name,
      rawProject: r.raw_project,
      workingOn: r.working_on,
      heartbeatSecondsAgo: Number(r.heartbeat_seconds_ago ?? 0),
      startedSecondsAgo:
        r.started_seconds_ago === null ? null : Number(r.started_seconds_ago),
    })),
  };
}
