import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

/**
 * Project identity — the read side of `agentic_os.project` + `project_alias`.
 *
 * See src/server/queries/health.ts for the conventions this follows (ADR-0002:
 * this directory is the API boundary; no component imports `db`).
 */

/**
 * Which harness wrote a session row. Derived from the id SHAPE, because no column
 * records it — and the shapes are unambiguous:
 *
 *   claude — UUIDv4. Claude Code's own session id.
 *   codex  — UUIDv7. OpenAI Codex thread ids, written into this shared table by a
 *            SEPARATE, STALE copy of these hooks at ~/.codex/hooks/dist (built
 *            2026-05-04, three months behind, still registered in ~/.codex/hooks.json
 *            and still writing today). All 168 carry raw backslash paths the current
 *            canonicalProject() cannot produce, and the first appeared 2026-05-10 —
 *            six days after that mirror was built.
 *   legacy — `s-*` from generateSessionId(). SessionStart registrations written before
 *            the 2026-07-26 identity fix, when session-register and heartbeat disagreed
 *            about the session id and every session produced TWO rows. Production has
 *            essentially stopped (37/day on 07-24, 0 on 07-28) so this is a frozen
 *            historical population, not a growing one.
 *   other  — anything else. Currently 4 hand-typed diagnostic rows.
 *
 * This is a CLASSIFIER OVER EXISTING DATA, not a schema change. If sessions ever gains
 * a real `harness` column, this becomes a fallback for old rows and nothing else moves.
 */
export type Harness = 'claude' | 'codex' | 'legacy' | 'other';

export type HarnessCounts = {
  claude: number;
  codex: number;
  legacy: number;
  other: number;
};

export type ProjectSummary = {
  key: string;
  displayName: string;
  status: string;
  port: number | null;
  url: string | null;
  /** EVERY session attributed to this project, across every harness — Claude Code,
   *  Codex, and pre-2026-07-26 legacy registrations alike, minus provable duplicates.
   *
   *  CHANGED 2026-07-28. This used to mean "real Claude Code sessions only", which was
   *  wrong twice: it silently EXCLUDED 1,483 `s-*` rows described as "coordination
   *  heartbeats" that are actually session registrations, and it silently INCLUDED 168
   *  Codex sessions counted as Claude ones (agent-arch was 41% Codex under the old
   *  number). The fleet is multi-harness; the count now says so, and `byHarness` breaks
   *  it down rather than making the reader guess which kind they are looking at. */
  sessionCount: number;
  /** The same total, split by which harness wrote the row. Sums to `sessionCount`. */
  byHarness: HarnessCounts;
  /** How many distinct raw `sessions.project` spellings collapse into this project.
   *  `continuous-claude` is currently 16: slash direction, case, trailing slash,
   *  subdirectories and worktrees. Surfacing it makes the normalization auditable. */
  rawSpellings: number;
  /** ISO-8601 with an explicit `Z`. See the derivation note on the query below —
   *  this is NOT `sessions.last_activity_at`, which is NULL in every row. */
  lastActivityAt: string | null;
  /** Age in seconds, computed server-side against the database clock.
   *  Sent alongside the timestamp so the UI never has to reconcile a browser
   *  clock, a timezone, or a hydration boundary to render "4m ago". */
  lastActivitySecondsAgo: number | null;
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
  /** Every ATTRIBUTED session split by harness. Sums to the sum of project counts. */
  byHarness: HarnessCounts;
  /**
   * Legacy `s-*` rows collapsed into a uuid row that represents the SAME session, and
   * therefore excluded from every session count so they are not counted twice.
   *
   * Matched on identical raw `project` string plus a start within ±90 seconds. That is
   * a HEURISTIC and deliberately the strict one: matching on the alias-resolved project
   * key instead would collapse 564 rather than 238, but it treats two unmapped paths as
   * equal (NULL key = NULL key) and would merge genuinely distinct sessions. So this
   * number is a FLOOR — some twins wrote different spellings of the same directory and
   * are not detected, which means the `legacy` harness count is an UPPER bound on
   * distinct legacy sessions. The UI must not present it as exact.
   */
  duplicates: number;
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
  duplicates: string;
  h_claude: string;
  h_codex: string;
  h_legacy: string;
  h_other: string;
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
    WITH harnessed AS (
      SELECT
        s.*,
        -- Id SHAPE is the only available evidence of provenance; see the Harness type.
        -- The version nibble of a UUID is character 15 (8 hex, dash, 4 hex, dash, V).
        CASE
          WHEN s.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4' THEN 'claude'
          WHEN s.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7' THEN 'codex'
          WHEN s.id LIKE 's-%'                     THEN 'legacy'
          ELSE                                          'other'
        END AS harness
      FROM public.sessions s
    ),
    -- A legacy row whose uuid twin exists is the SECOND registration of ONE session.
    -- Counting both would inflate every project. See the duplicates note above: this is
    -- the STRICT raw-path match on purpose, so it under-collapses rather than merging
    -- two genuinely different sessions.
    dup AS (
      SELECT DISTINCT l.id
      FROM harnessed l
      JOIN harnessed u
        ON u.harness IN ('claude', 'codex')
       AND u.project = l.project
       AND u.started_at BETWEEN l.started_at - interval '90 seconds'
                            AND l.started_at + interval '90 seconds'
      WHERE l.harness = 'legacy'
    ),
    bucketed AS (
      SELECT
        s.id,
        s.project,
        s.harness,
        -- WHY THIS IS NOT JUST s.last_activity_at: that column is NULL in ALL 2,418
        -- rows (verified 2026-07-27 -- count(last_activity_at) returns 0). Nothing
        -- writes it. Reading it alone made every project's "last active" render as an
        -- em-dash, which looks like an empty fleet rather than a dead column.
        --
        -- GREATEST rather than COALESCE precedence, so that if last_activity_at ever
        -- DOES start being written, an older value cannot mask a newer heartbeat.
        -- '-infinity' is the identity element here; NULLIF puts the NULL back for a
        -- project that genuinely has no sessions at all.
        GREATEST(
          COALESCE(s.last_activity_at, '-infinity'::timestamp),
          COALESCE(s.last_heartbeat,   '-infinity'::timestamp),
          COALESCE(s.started_at,       '-infinity'::timestamp)
        ) AS activity_at,
        a.project_key,
        a.confidence,
        a.raw AS alias_raw,
        -- Precedence: duplicate > null/empty > mapped > reviewed-unmapped > unseen.
        -- The s-star shape NO LONGER short-circuits here (no backticks in this comment:
        -- one inside a sql template literal terminates it, and tsc then points ~40 lines
        -- away from the real cause -- the trap this file's own handoff documents).
        -- It used to be first in this CASE, which meant 1,483
        -- rows were dropped from project attribution before the alias join ever ran --
        -- discarding real evidence, since every one of them carries a project value.
        -- Harness is now an ORTHOGONAL dimension, not a bucket, so a legacy row is
        -- attributed to its project like any other and merely labelled as legacy.
        CASE
          WHEN d.id IS NOT NULL                     THEN 'duplicate'
          WHEN s.project IS NULL OR s.project = ''  THEN 'null_project'
          WHEN a.project_key IS NOT NULL            THEN 'mapped'
          WHEN a.raw IS NOT NULL                    THEN 'reviewed_unmapped'
          ELSE                                           'unseen'
        END AS bucket
      FROM harnessed s
      LEFT JOIN agentic_os.project_alias a ON a.raw = s.project
      LEFT JOIN dup d ON d.id = s.id
    ),
    per_project AS (
      SELECT
        b.project_key,
        count(*)                     AS session_count,
        count(DISTINCT b.project)    AS raw_spellings,
        count(*) FILTER (WHERE b.harness = 'claude') AS h_claude,
        count(*) FILTER (WHERE b.harness = 'codex')  AS h_codex,
        count(*) FILTER (WHERE b.harness = 'legacy') AS h_legacy,
        count(*) FILTER (WHERE b.harness = 'other')  AS h_other,
        NULLIF(max(b.activity_at), '-infinity'::timestamp) AS last_activity_at
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
          jsonb_build_object(
            'claude', COALESCE(pp.h_claude, 0)::int,
            'codex',  COALESCE(pp.h_codex,  0)::int,
            'legacy', COALESCE(pp.h_legacy, 0)::int,
            'other',  COALESCE(pp.h_other,  0)::int
          )                                    AS "byHarness",
          COALESCE(pp.raw_spellings, 0)::int   AS "rawSpellings",
          -- The trailing "Z" is load-bearing. These are timestamp WITHOUT time zone
          -- columns that hold UTC (server TimeZone is Etc/UTC, verified). Emitting them
          -- unmarked meant new Date(str) in the browser read them as LOCAL time and
          -- every age was wrong by the UTC offset -- 5 hours here, and 0 hours in
          -- January, which is exactly the kind of bug that hides until it doesn't.
          to_char(pp.last_activity_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "lastActivityAt",
          EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - pp.last_activity_at))::int
                                               AS "lastActivitySecondsAgo",
          COALESCE(pp.session_count, 0)        AS session_count
        FROM agentic_os.project p
        LEFT JOIN per_project pp ON pp.project_key = p.key
        ORDER BY COALESCE(pp.session_count, 0) DESC, p.key
        LIMIT 200
      ) x
    )
    SELECT
      (SELECT payload FROM projects) AS projects,
      count(*) FILTER (WHERE bucket = 'duplicate')::text            AS duplicates,
      count(*) FILTER (WHERE bucket = 'mapped' AND harness = 'claude')::text AS h_claude,
      count(*) FILTER (WHERE bucket = 'mapped' AND harness = 'codex')::text  AS h_codex,
      count(*) FILTER (WHERE bucket = 'mapped' AND harness = 'legacy')::text AS h_legacy,
      count(*) FILTER (WHERE bucket = 'mapped' AND harness = 'other')::text  AS h_other,
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

  const duplicates = n(r.duplicates);
  const nullProject = n(r.null_project);
  const totalSessionRows = n(r.total);
  const mapped = projects.reduce((sum, p) => sum + p.sessionCount, 0);

  const byHarness: HarnessCounts = {
    claude: n(r.h_claude),
    codex: n(r.h_codex),
    legacy: n(r.h_legacy),
    other: n(r.h_other),
  };

  return {
    projects,
    unmatched,
    byHarness,
    duplicates,
    nullProject,
    totalSessionRows,
    // Same contract as before, with `duplicates` taking the slot `heartbeats` held.
    // Legacy rows are no longer a bucket — they are inside `mapped`/`unmatched` now and
    // labelled by harness — so removing them from this sum without adding the collapsed
    // duplicates back would make it fail. It is checked at runtime for exactly that
    // reason: a partition that stops adding up should say so, not round.
    reconciles:
      mapped + unmatched.sessionCount + duplicates + nullProject === totalSessionRows,
  };
}
