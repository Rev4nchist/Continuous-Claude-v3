import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

import { readSessionNames } from '@/server/sources/identity-names';
import type { StateFiles, StateSnapshot } from '@/server/sources/state-files';

import { answeredOf, countedAsks, goalOf, groupHeldLanes, type Answered, type GoalSource, type HeldLane } from './fleet-card-fields';
import { joinSnapshots, LOOKUP_LIMIT, type JoinStats, type LookupRow } from './fleet-join';
import { laneOrderSql } from './lane-sort';
import type { ActiveSession, ActiveSessions } from './sessions';

export type { JoinStats } from './fleet-join';
export type { HeldLane } from './fleet-card-fields';

/**
 * Session cards and the Ready for Dave strip: the DB session list joined to state files.
 *
 * The join key is `sessions.id = snapshot.sessionId`. The live list comes from
 * getActiveSessions() (the 15 minute window on the most recent sign of life, with its
 * relative "ended" rule), passed in so this module does not copy that SQL or run it twice.
 *
 * Two windows (Dave, 2026-10-28, "24hr strip"). Session cards keep the 15 minute live window.
 * Ready for Dave uses 24 hours: a session that waits on Dave sends no prompt, so it leaves the
 * live window after 15 minutes, but its ask must stay in the strip (PRD 5.2: an ask lasts until
 * 24 hours after the last session activity).
 *
 * "Quiet" = seconds since GREATEST(last_heartbeat, COALESCE(last_activity_at, last_heartbeat)).
 * Every snapshot ends in exactly one bucket:
 *   matched        its session is in `active.sessions` (quiet 15 minutes or less): card and strip
 *   quiet          not ended, quiet over 15 minutes and up to 24 hours: NO card, but its open,
 *                  unanswered, non-stale asks feed the strip and tiles.needsDave
 *   droppedEnded   its session ended (in `active.recentlyEnded`, or ended_at is its latest sign): dropped.
 *                  Also a file with no database answer (no row, or the lookup failed or was capped)
 *                  whose own `endedAt` says it ended (`endedByFile`). A database row always wins.
 *   droppedStale   its session row exists but has been quiet for over 24 hours: dropped
 *   noSessionRow   no row in public.sessions: dropped (a copied file, a test, another machine)
 *   unchecked      the lookup query failed: dropped, and the source says so
 *   lookupFailed   the lookup query failed and the file's own `endedAt` says it ended: dropped, but
 *                  counted apart from `droppedEnded` so the source row reads degraded
 * Dropped snapshots never reach a card or the strip. Ages are computed here, in seconds.
 * The ask rule is separate: an ask is stale when both the brief and the file are older than 24 hours
 * (`max(brief.updatedAt, file.at)`, the rule of the terminal pane), whatever its session is.
 */

export const STALE_ASK_SECONDS = 24 * 60 * 60;
export const GREEN_UNDER_SECONDS = 120;

export const CHIPS = ['working', 'waiting-on-dave', 'blocked', 'done', 'idle'] as const;
export type Chip = (typeof CHIPS)[number];

/** One row per session that waits on Dave: its first open, unanswered, non-stale ask. */
export type ReadyItem = {
  sessionId: string;
  shortId: string;
  name: string;
  /** The session name from its identity file (cleaned, 16 code points at most), or null: shown as "unnamed". */
  sessionName: string | null;
  kind: string;
  /** One line: whitespace collapsed. The state-file reader already redacted and clipped it. */
  text: string;
  /** How many asks of this session are open (this row shows the first). */
  openAsks: number;
  /** False for a quiet session (no card, last sign of life over 15 minutes ago). */
  live: boolean;
  /** Seconds since the later of the brief update and the file write. */
  ageSeconds: number;
};

export type SessionCard = {
  id: string;
  shortId: string;
  name: string;
  /** The session name from its identity file (cleaned, 16 code points at most), or null: shown as "unnamed". */
  sessionName: string | null;
  projectKey: string | null;
  projectDisplayName: string | null;
  chip: Chip | null;
  title: string | null;
  /**
   * One line for the card: a brief_set goal, else the title of the held lane claimed last, else a parsed goal,
   * else null (no prompt text exists). `goalSource` says which.
   */
  goal: string | null;
  goalSource: GoalSource;
  branch: string | null;
  repo: string | null;
  hasBrief: boolean;
  planDone: number;
  planTotal: number;
  askOpen: number;
  askStale: number;
  /** The ANSWERED row: the last brief decision and the count of answered asks. Empty with no brief. */
  answered: Answered;
  unproven: number;
  ctxPct: number | null;
  /** First lane this session holds (active, review, blocked or ready), or null. */
  laneId: string | null;
  /** EVERY lane this session holds, in the shared lane sort order, each with its lease time left. */
  lanes: HeldLane[];
  /** Seconds since the last user prompt (sessions.ts heartbeatSecondsAgo). Not a liveness rule: liveColour stays. */
  heartbeatSecondsAgo: number;
  liveColour: 'green' | 'amber';
  liveSecondsAgo: number;
  /** Seconds since the state file was written, or null with no file. */
  stateAgeSeconds: number | null;
};

/** One watched PR: grouped by repo and number across LIVE sessions. */
export type PrRow = {
  key: string;
  repo: string | null;
  pr: number;
  state: string | null;
  sessions: { id: string; shortId: string; name: string }[];
};

export type FleetSessions = {
  cards: SessionCard[];
  ready: ReadyItem[];
  join: JoinStats;
  /** PR rows of live sessions, sorted and capped. `tiles.openPrs` is their number. */
  prs: PrRow[];
};

const MAX_PR_ROWS = 20;
/** States that need a person: first in the PR panel. READY and CLOSED never show. */
const PR_PERSON_STATES = new Set(['LIMITED', 'REVIEWED', 'PROOF', 'STALLED']);
const PR_HIDDEN_STATES = new Set(['READY', 'CLOSED']);

type PrWatch = {
  repo: string | null;
  pr: number;
  sessions: Map<string, { id: string; shortId: string; name: string }>;
  /** State of the most recently written state file: larger `at`, then the lower file index. */
  state: string | null;
  stateAt: number;
  stateRank: number;
};

function prTier(state: string | null): number {
  if (state === null) return 3;
  return PR_PERSON_STATES.has(state) ? 1 : 2;
}

/**
 * PR rows from the state files of live sessions. `rank` is the position of the snapshot in the
 * reader's list, which is newest file first: a tie on `at` goes to the lower rank (newer mtime).
 */
function buildPrRows(
  entries: { card: SessionCard; snapshot: StateSnapshot; rank: number }[],
): PrRow[] {
  const watches = new Map<string, PrWatch>();
  // Pick the newest state first, READY and CLOSED included; drop a hidden winner afterwards.
  // A session whose own watch is READY or CLOSED has left the watch: it competes for the
  // state but is not listed.
  for (const { card, snapshot, rank } of entries) {
    for (const watch of snapshot.prs) {
      const hidden = watch.state !== null && PR_HIDDEN_STATES.has(watch.state);
      const repo = snapshot.repo;
      const key = `${repo ?? '?'}#${watch.pr}`;
      let row = watches.get(key);
      if (row === undefined) {
        row = { repo, pr: watch.pr, sessions: new Map(), state: watch.state, stateAt: snapshot.at, stateRank: rank };
        watches.set(key, row);
      } else if (snapshot.at > row.stateAt || (snapshot.at === row.stateAt && rank < row.stateRank)) {
        row.state = watch.state;
        row.stateAt = snapshot.at;
        row.stateRank = rank;
      }
      if (!hidden && !row.sessions.has(card.id)) {
        row.sessions.set(card.id, { id: card.id, shortId: card.shortId, name: card.name });
      }
    }
  }
  return [...watches.entries()]
    .filter(([, row]) => row.state === null || !PR_HIDDEN_STATES.has(row.state))
    .map(([key, row]) => ({
      key,
      repo: row.repo,
      pr: row.pr,
      state: row.state,
      sessions: [...row.sessions.values()],
    }))
    .sort((a, b) => prTier(a.state) - prTier(b.state) || b.pr - a.pr || a.key.localeCompare(b.key))
    .slice(0, MAX_PR_ROWS);
}

type Step = { done: boolean; proven: boolean };

export function chipOf(value: string | null): Chip | null {
  return (CHIPS as readonly string[]).includes(value ?? '') ? (value as Chip) : null;
}

/** Done steps of the task list when it has items, else of the brief plan (PRD 5.1). */
function stepsOf(snapshot: StateSnapshot | undefined): Step[] {
  if (!snapshot) return [];
  const proofs = snapshot.brief?.proofs ?? [];
  const proven = (id: string, subject: string, kind: 'task' | 'plan'): boolean =>
    proofs.some((p) => p.id === id && p.subject === subject && p.kind === kind);

  if (snapshot.tasks.length > 0) {
    return snapshot.tasks.map((t) => ({
      done: t.status === 'completed',
      proven: proven(t.id, t.subject, 'task'),
    }));
  }
  return (snapshot.brief?.plan ?? []).map((p) => ({
    done: p.status === 'done',
    proven: proven(p.id, p.text, 'plan'),
  }));
}

export function cardName(projectKey: string | null, id: string, snapshot: StateSnapshot | undefined): string {
  return `${projectKey ?? 'unmapped'}/${snapshot?.branch ?? '-'}/${id.slice(0, 4)}`;
}

function buildCard(
  session: ActiveSession,
  snapshot: StateSnapshot | undefined,
  nowMs: number,
  lanes: readonly HeldLane[],
  sessionName: string | null,
): SessionCard {
  const steps = stepsOf(snapshot);
  const brief = snapshot?.brief ?? null;
  const asks = countedAsks(brief?.ask ?? [], snapshot?.chip ?? null, stateAgeOf(snapshot, nowMs));
  const stale =brief !== null && askAgeSeconds(brief.updatedAt, snapshot, nowMs) > STALE_ASK_SECONDS;
  const goal = goalOf(brief?.goal, brief?.goalSource, lanes);

  return {
    id: session.id,
    shortId: session.shortId,
    name: cardName(session.projectKey, session.id, snapshot),
    sessionName,
    projectKey: session.projectKey,
    projectDisplayName: session.projectDisplayName,
    chip: chipOf(snapshot?.chip ?? null),
    title: brief?.title ?? null,
    goal: goal.text,
    goalSource: goal.source,
    branch: snapshot?.branch ?? null,
    repo: snapshot?.repo ?? null,
    hasBrief: brief !== null,
    planDone: steps.filter((s) => s.done).length,
    planTotal: steps.length,
    askOpen: stale ? 0 : asks.length,
    askStale: stale ? asks.length : 0,
    answered: answeredOf(brief?.decisions ?? [], brief?.ask ?? [], nowMs),
    unproven: steps.filter((s) => s.done && !s.proven).length,
    ctxPct:
      snapshot?.ctx === null || snapshot?.ctx === undefined
        ? null
        : Math.min(100, Math.max(0, Math.round(snapshot.ctx))),
    laneId: lanes[0]?.id ?? null,
    lanes: [...lanes],
    heartbeatSecondsAgo: session.heartbeatSecondsAgo,
    liveColour: session.liveSecondsAgo < GREEN_UNDER_SECONDS ? 'green' : 'amber',
    liveSecondsAgo: session.liveSecondsAgo,
    stateAgeSeconds: stateAgeOf(snapshot, nowMs),
  };
}

/** Seconds since the state file was written, or null with no snapshot. */
function stateAgeOf(snapshot: StateSnapshot | undefined, nowMs: number): number | null {
  return snapshot ? Math.max(0, Math.round((nowMs - snapshot.at) / 1000)) : null;
}

/**
 * `now - max(brief.updatedAt, file.at)` in seconds. Both stamps are epoch milliseconds. The file is written on
 * every session activity, so a brief set a day ago in a session that is still working is not stale (the terminal
 * pane uses the same rule: the later of the brief update and the last activity).
 */
export function askAgeSeconds(updatedAt: number | null, snapshot: StateSnapshot | undefined, nowMs: number): number {
  const latest = Math.max(updatedAt ?? 0, snapshot?.at ?? 0);
  return Math.max(0, Math.round((nowMs - (latest > 0 ? latest : nowMs)) / 1000));
}

/** Zero or one row: the first open ask in the order the brief lists them. */
function buildReady(
  id: string,
  name: string,
  sessionName: string | null,
  snapshot: StateSnapshot,
  nowMs: number,
  live: boolean,
): ReadyItem[] {
  const brief = snapshot.brief;
  if (brief === null) return [];
  const ageSeconds = askAgeSeconds(brief.updatedAt, snapshot, nowMs);
  if (ageSeconds > STALE_ASK_SECONDS) return [];
  const open = countedAsks(brief.ask, snapshot.chip, stateAgeOf(snapshot, nowMs));
  const first = open[0];
  if (first === undefined) return [];
  return [
    {
      sessionId: id,
      shortId: id.slice(0, 8),
      name,
      sessionName,
      kind: first.kind,
      // first.text was stripped, redacted and scrubbed in state-files; a whitespace replace adds no character.
      text: first.text.replace(/\s+/g, ' '),
      openAsks: open.length,
      live,
      ageSeconds,
    },
  ];
}

/**
 * Of the snapshots whose session is not in the live roster: which sessions exist, which have
 * ended (ended_at is the latest sign, same rule as sessions.ts), how long each has been quiet,
 * and which project each maps to (the alias join of sessions.ts, for the strip item name).
 * One bounded SELECT. Returns null when the query fails.
 */
async function lookupRows(ids: string[]): Promise<Map<string, LookupRow> | null> {
  if (ids.length === 0) return new Map();
  try {
    const { rows } = await db.execute<{
      id: string;
      has_ended: boolean;
      quiet_seconds: number | null;
      project_key: string | null;
    }>(sql`
      -- The same relative rule as getActiveSessions() (sessions.ts is_ended): a resumed session
      -- is not ended. Ended only when ended_at is the last thing that happened to the row.
      SELECT s.id,
        COALESCE(
          s.ended_at >= GREATEST(s.last_heartbeat, COALESCE(s.last_activity_at, s.last_heartbeat)),
          s.ended_at IS NOT NULL
        ) AS has_ended,
        EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC')
          - GREATEST(s.last_heartbeat, COALESCE(s.last_activity_at, s.last_heartbeat))))::int
          AS quiet_seconds,
        a.project_key
      FROM public.sessions s
      LEFT JOIN agentic_os.project_alias a
        ON a.raw = s.project AND a.project_key IS NOT NULL
      WHERE s.id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      LIMIT ${LOOKUP_LIMIT}
    `);
    return new Map(
      rows.map((r) => [
        r.id,
        {
          hasEnded: r.has_ended === true,
          quietSeconds: r.quiet_seconds === null ? null : Number(r.quiet_seconds),
          projectKey: r.project_key,
        },
      ]),
    );
  } catch {
    return null;
  }
}

export async function getFleetSessions(
  active: ActiveSessions,
  files: StateFiles,
  nowMs: number = Date.now(),
  lanes: Map<string, HeldLane[]> = new Map(),
): Promise<FleetSessions> {
  const bySession = new Map(files.snapshots.map((s) => [s.sessionId, s]));
  const liveIds = new Set(active.sessions.map((s) => s.id));
  const endedIds = new Set(active.recentlyEnded.map((s) => s.id));
  const { join, quietRows } = await joinSnapshots(bySession, liveIds, endedIds, lookupRows);
  // One read for the live sessions and the quiet rows, by id (never a folder listing).
  const names = await readSessionNames([...liveIds, ...quietRows.keys()]);

  const cards: SessionCard[] = [];
  const ready: ReadyItem[] = [];
  const rankOf = new Map(files.snapshots.map((s, index) => [s.sessionId, index]));
  const watching: { card: SessionCard; snapshot: StateSnapshot; rank: number }[] = [];
  for (const session of active.sessions) {
    const snapshot = bySession.get(session.id);
    const card = buildCard(session, snapshot, nowMs, lanes.get(session.id) ?? [], names.get(session.id) ?? null);
    cards.push(card);
    if (!snapshot) continue;
    ready.push(...buildReady(card.id, card.name, card.sessionName, snapshot, nowMs, true));
    watching.push({ card, snapshot, rank: rankOf.get(session.id) ?? 0 });
  }
  // Quiet sessions: no card and no PR count (those stay live-only), but their asks count.
  for (const [id, row] of quietRows) {
    const snapshot = bySession.get(id);
    if (snapshot) {
      const name = cardName(row.projectKey, id, snapshot);
      ready.push(...buildReady(id, name, names.get(id) ?? null, snapshot, nowMs, false));
    }
  }
  ready.sort((a, b) => b.ageSeconds - a.ageSeconds || a.sessionId.localeCompare(b.sessionId));

  return { cards, ready, join, prs: buildPrRows(watching) };
}

/** `SELECT count(*) FROM agentic_os.lane WHERE state = 'active'`. Throws when the query fails. */
export async function getActiveLaneCount(): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM agentic_os.lane WHERE state = 'active'`,
  );
  return Number(rows[0]?.n ?? 0);
}

const HELD_LANE_STATES = ['active', 'review', 'blocked', 'ready'];
const HELD_LANE_LIMIT = 200;

const LANE_TITLE_CLIP = 200;

/**
 * Lanes held by a session, by owner session id: ALL of them, each with its title and lease time left. Shared
 * lane sort key (band, due_at, priority, id), so the first entry is stable. Done lanes are excluded by
 * HELD_LANE_STATES. Bounded by HELD_LANE_LIMIT. The lease end and the database clock come from the same
 * query, so `leaseSecondsLeft` does not depend on this machine's clock; it is negative when the lease has
 * lapsed. Throws when the query fails.
 */
export async function getHeldLanes(): Promise<Map<string, HeldLane[]>> {
  const { rows } = await db.execute<{
    id: string;
    title: string | null;
    owner_session_id: string;
    lease_expires_epoch: number | null;
    claimed_at_epoch: number | null;
    db_now_epoch: number;
  }>(sql`
    SELECT l.id, left(l.title, ${LANE_TITLE_CLIP}) AS title, l.owner_session_id,
      EXTRACT(EPOCH FROM l.lease_expires_at)::float8 AS lease_expires_epoch,
      EXTRACT(EPOCH FROM l.claimed_at)::float8 AS claimed_at_epoch,
      EXTRACT(EPOCH FROM now())::float8 AS db_now_epoch
    FROM agentic_os.lane l
    WHERE l.owner_session_id IS NOT NULL
      AND l.state IN (${sql.join(
        HELD_LANE_STATES.map((state) => sql`${state}`),
        sql`, `,
      )})
    ORDER BY ${sql.raw(laneOrderSql('l'))}
    LIMIT ${HELD_LANE_LIMIT}
  `);
  const dbNow = Number(rows[0]?.db_now_epoch ?? Date.now() / 1000);
  return groupHeldLanes(rows, dbNow);
}
