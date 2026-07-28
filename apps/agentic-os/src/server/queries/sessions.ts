import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

/**
 * The live half of the fleet view — who is working right now.
 *
 * See src/server/queries/health.ts for the conventions this follows (ADR-0002:
 * this directory is the API boundary; no component imports `db`).
 */

/** How recent a session's last sign of life has to be for it to count as live.
 *
 *  CORRECTED 2026-07-28. The previous version of this comment said "heartbeats
 *  are written by the coordination hooks on tool use". That was FALSE, and the
 *  window length was chosen on top of it. `heartbeat.ts` is registered on
 *  UserPromptSubmit ONLY — it measures the human typing, not the agent working.
 *  Sampled every 20s for 8 minutes against a session that was running a
 *  12-agent workflow the whole time, `last_heartbeat` was written exactly ONCE
 *  and peaked at 505 seconds stale. The observed "5m33s gap while actively
 *  working" was not idleness; it was the gap between two prompts.
 *
 *  `last_activity_at` now carries the real signal (written on PostToolUse by
 *  shared/session-touch.ts, throttled to 30s), so liveness below is GREATEST of
 *  the two. 15 minutes stays: it is long enough to be stable and short enough
 *  that a closed terminal disappears while you still remember closing it. But it
 *  is now 15 minutes of AGENT silence, which is a far stronger statement than 15
 *  minutes of nobody typing. Sessions are never deleted, so this window is the
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
  /** Seconds since the last USER PROMPT. Kept as its own field rather than
   *  folded into liveness because "the human last said something 20 minutes ago"
   *  is a genuinely different fact from "the agent is idle", and the strip is
   *  more honest showing both than averaging them. */
  heartbeatSecondsAgo: number;
  /** Seconds since the last TOOL CALL — the agent-side signal. NULL for every
   *  session that predates shared/session-touch.ts (2026-07-28); those rows have
   *  no agent-activity history and never will, so the UI must render this as
   *  "unknown" rather than "never active". */
  activitySecondsAgo: number | null;
  /** Seconds since the most recent sign of life of EITHER kind. This is the one
   *  the window admits on and the strip sorts by. */
  liveSecondsAgo: number;
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
  activity_seconds_ago: number | null;
  live_seconds_ago: number;
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
      EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - s.last_activity_at))::int
                                                                  AS activity_seconds_ago,
      EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC')
              - GREATEST(s.last_heartbeat, s.last_activity_at)))::int
                                                                  AS live_seconds_ago,
      EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - s.started_at))::int
                                                                  AS started_seconds_ago
    FROM public.sessions s
    LEFT JOIN agentic_os.project_alias a
      ON a.raw = s.project AND a.project_key IS NOT NULL
    LEFT JOIN agentic_os.project p ON p.key = a.project_key
    WHERE s.id NOT LIKE 's-%'
      AND s.last_heartbeat IS NOT NULL
      -- GREATEST, not COALESCE, and no fallback sentinel is needed: Postgres
      -- GREATEST IGNORES nulls and returns NULL only when every argument is NULL
      -- (verified against this server 2026-07-28). So for the 2,435 rows written
      -- before last_activity_at had any writer, this reduces exactly to the old
      -- last_heartbeat behavior, and for live sessions it admits an agent that
      -- has been working for an hour without the user typing. The
      -- last_heartbeat IS NOT NULL guard above keeps the reduction total.
      AND GREATEST(s.last_heartbeat, s.last_activity_at)
          > (now() AT TIME ZONE 'UTC') - make_interval(mins => ${windowMinutes})
    ORDER BY GREATEST(s.last_heartbeat, s.last_activity_at) DESC
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
      // NOT `?? 0`: zero would render as "active this second" for every row that
      // predates agent-activity tracking, which is the confidently-wrong failure
      // this codebase keeps designing against. Null means unknown, and the UI
      // has to say so.
      activitySecondsAgo:
        r.activity_seconds_ago === null || r.activity_seconds_ago === undefined
          ? null
          : Number(r.activity_seconds_ago),
      liveSecondsAgo: Number(r.live_seconds_ago ?? r.heartbeat_seconds_ago ?? 0),
      startedSecondsAgo:
        r.started_seconds_ago === null ? null : Number(r.started_seconds_ago),
    })),
  };
}
