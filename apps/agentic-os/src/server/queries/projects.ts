import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

/**
 * Project identity — the read side of `agentic_os.project` + `project_alias`.
 *
 * See src/server/queries/health.ts for the conventions this follows (ADR-0002:
 * this directory is the API boundary; no component imports `db`).
 */

export type ProjectSummary = {
  key: string;
  displayName: string;
  status: string;
  port: number | null;
  url: string | null;
  /** Real Claude Code sessions only — `s-*` coordination heartbeats are excluded. */
  sessionCount: number;
  /** How many distinct raw `sessions.project` spellings collapse into this project.
   *  `continuous-claude` is currently 16: slash direction, case, trailing slash,
   *  subdirectories and worktrees. Surfacing it makes the normalization auditable. */
  rawSpellings: number;
  lastActivityAt: string | null;
};

/**
 * What the fleet grid is NOT accounting for. Split three ways on purpose, because
 * the three need opposite follow-up and lumping them together hides the useful one:
 *   rejected     — reviewed, not a project (temp dirs, installer paths, $HOME)
 *   notOnboarded — reviewed, a REAL project, just not in project-registry.json
 *   unseen       — no alias row at all; nobody has looked at it yet
 */
export type UnmatchedBucket = {
  sessionCount: number;
  rawCount: number;
  rejected: { sessionCount: number; rawCount: number };
  notOnboarded: { sessionCount: number; rawCount: number };
  unseen: { sessionCount: number; rawCount: number };
};

export type FleetOverview = {
  projects: ProjectSummary[];
  unmatched: UnmatchedBucket;
  /** `s-*` rows from generateSessionId() — coordination heartbeats, not real sessions.
   *  Currently the MAJORITY of the table, which is why they are reported rather than
   *  silently filtered: a total that shrank with no explanation invites mistrust. */
  heartbeats: number;
  /** Rows with a NULL/empty `project`. Every WHERE-based bucket would drop these. */
  nullProject: number;
  totalSessionRows: number;
  /**
   * Whether the buckets sum to `totalSessionRows`.
   *
   * This is checked at RUNTIME, not only in a test, and travels in the DTO so the UI
   * can say "these numbers do not add up" instead of rendering a confident wrong
   * total. It should always be true — if it is ever false, the projection is lying
   * and that is worth more than the numbers themselves.
   *
   * What it proves: no session row was dropped or double-counted.
   * What it does NOT prove: that any row went to the RIGHT project. Only the
   * hand-authored mapping in scripts/project-aliases.json decides that, and nothing
   * here can validate it.
   */
  reconciles: boolean;
};

type OverviewRow = {
  projects: ProjectSummary[] | null;
  heartbeats: string;
  null_project: string;
  unseen_sessions: string;
  unseen_raws: string;
  rejected_sessions: string;
  rejected_raws: string;
  not_onboarded_sessions: string;
  not_onboarded_raws: string;
  total: string;
};

/**
 * The whole fleet picture in ONE round trip.
 *
 * Single query, deliberately. Computing the buckets as separate queries is not just
 * inelegant — it is WRONG twice over. First, the buckets overlap: a heartbeat row
 * also carries a `project` value that maps, so independent counts double-count and
 * exceed the total. Second, separate queries against a live table race with inserts
 * (this database is written continuously by every running session), which manufactures
 * drift that looks like a mapping bug. One CASE with explicit precedence over one
 * snapshot is the only form that can be trusted.
 *
 * Precedence: heartbeat > null/empty > mapped > reviewed-unmapped > unseen.
 */
export async function getFleetOverview(): Promise<FleetOverview> {
  const { rows } = await db.execute<OverviewRow>(sql`
    WITH bucketed AS (
      SELECT
        s.id,
        s.project,
        s.last_activity_at,
        a.project_key,
        a.confidence,
        a.raw AS alias_raw,
        CASE
          WHEN s.id LIKE 's-%'                      THEN 'heartbeat'
          WHEN s.project IS NULL OR s.project = ''  THEN 'null_project'
          WHEN a.project_key IS NOT NULL            THEN 'mapped'
          WHEN a.raw IS NOT NULL                    THEN 'reviewed_unmapped'
          ELSE                                           'unseen'
        END AS bucket
      FROM public.sessions s
      LEFT JOIN agentic_os.project_alias a ON a.raw = s.project
    ),
    per_project AS (
      SELECT
        b.project_key,
        count(*)                     AS session_count,
        count(DISTINCT b.project)    AS raw_spellings,
        max(b.last_activity_at)      AS last_activity_at
      FROM bucketed b
      WHERE b.bucket = 'mapped'
      GROUP BY b.project_key
    ),
    projects AS (
      SELECT jsonb_agg(x ORDER BY x.session_count DESC, x.key) AS payload
      FROM (
        SELECT
          p.key,
          p.display_name                       AS "displayName",
          p.status,
          p.port,
          p.url,
          COALESCE(pp.session_count, 0)::int   AS "sessionCount",
          COALESCE(pp.raw_spellings, 0)::int   AS "rawSpellings",
          to_char(pp.last_activity_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS "lastActivityAt",
          COALESCE(pp.session_count, 0)        AS session_count
        FROM agentic_os.project p
        LEFT JOIN per_project pp ON pp.project_key = p.key
        ORDER BY COALESCE(pp.session_count, 0) DESC, p.key
        LIMIT 200
      ) x
    )
    SELECT
      (SELECT payload FROM projects) AS projects,
      count(*) FILTER (WHERE bucket = 'heartbeat')::text            AS heartbeats,
      count(*) FILTER (WHERE bucket = 'null_project')::text         AS null_project,
      count(*) FILTER (WHERE bucket = 'unseen')::text               AS unseen_sessions,
      count(DISTINCT project) FILTER (WHERE bucket = 'unseen')::text AS unseen_raws,
      count(*) FILTER (WHERE bucket = 'reviewed_unmapped' AND confidence = 0)::text            AS rejected_sessions,
      count(DISTINCT project) FILTER (WHERE bucket = 'reviewed_unmapped' AND confidence = 0)::text AS rejected_raws,
      count(*) FILTER (WHERE bucket = 'reviewed_unmapped' AND confidence > 0)::text            AS not_onboarded_sessions,
      count(DISTINCT project) FILTER (WHERE bucket = 'reviewed_unmapped' AND confidence > 0)::text AS not_onboarded_raws,
      count(*)::text                                                AS total
    FROM bucketed
  `);

  const r = rows[0];
  if (!r) {
    throw new Error('getFleetOverview: query returned no rows, which should be impossible');
  }

  const n = (v: string | null) => Number(v ?? 0);

  const projects = r.projects ?? [];
  const rejected = { sessionCount: n(r.rejected_sessions), rawCount: n(r.rejected_raws) };
  const notOnboarded = {
    sessionCount: n(r.not_onboarded_sessions),
    rawCount: n(r.not_onboarded_raws),
  };
  const unseen = { sessionCount: n(r.unseen_sessions), rawCount: n(r.unseen_raws) };

  const unmatched: UnmatchedBucket = {
    sessionCount: rejected.sessionCount + notOnboarded.sessionCount + unseen.sessionCount,
    rawCount: rejected.rawCount + notOnboarded.rawCount + unseen.rawCount,
    rejected,
    notOnboarded,
    unseen,
  };

  const heartbeats = n(r.heartbeats);
  const nullProject = n(r.null_project);
  const totalSessionRows = n(r.total);
  const mapped = projects.reduce((sum, p) => sum + p.sessionCount, 0);

  return {
    projects,
    unmatched,
    heartbeats,
    nullProject,
    totalSessionRows,
    reconciles:
      mapped + unmatched.sessionCount + heartbeats + nullProject === totalSessionRows,
  };
}
