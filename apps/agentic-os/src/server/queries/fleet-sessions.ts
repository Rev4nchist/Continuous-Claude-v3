import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

import type { StateFiles, StateSnapshot } from '@/server/sources/state-files';

import type { ActiveSession, ActiveSessions } from './sessions';

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
 *   droppedEnded   its session ended (in `active.recentlyEnded`, or ended_at is its latest sign): dropped
 *   droppedStale   its session row exists but has been quiet for over 24 hours: dropped
 *   noSessionRow   no row in public.sessions: dropped (a copied file, a test, another machine)
 *   unchecked      the lookup query failed: dropped, and the source says so
 * Dropped snapshots never reach a card or the strip. Ages are computed here, in seconds.
 * The ask rule is separate and unchanged: an ask older than 24 hours (`brief.updatedAt ?? at`)
 * is stale and never reaches the strip, whatever its session is.
 */

const STALE_ASK_SECONDS = 24 * 60 * 60;
const QUIET_MAX_SECONDS = 24 * 60 * 60;
const GREEN_UNDER_SECONDS = 120;
const LOOKUP_LIMIT = 200;

export const CHIPS = ['working', 'waiting-on-dave', 'blocked', 'done', 'idle'] as const;
export type Chip = (typeof CHIPS)[number];

export type ReadyItem = {
  sessionId: string;
  shortId: string;
  name: string;
  kind: string;
  text: string;
  recommend: string | null;
  /** Seconds since the brief was last updated (or the file was written). */
  ageSeconds: number;
};

export type SessionCard = {
  id: string;
  shortId: string;
  name: string;
  projectKey: string | null;
  projectDisplayName: string | null;
  chip: Chip | null;
  title: string | null;
  goal: string | null;
  branch: string | null;
  repo: string | null;
  hasBrief: boolean;
  planDone: number;
  planTotal: number;
  askOpen: number;
  askStale: number;
  unproven: number;
  ctxPct: number | null;
  liveColour: 'green' | 'amber';
  liveSecondsAgo: number;
  /** Seconds since the state file was written, or null with no file. */
  stateAgeSeconds: number | null;
};

export type JoinStats = {
  matched: number;
  /** Snapshots of sessions quiet for 15 minutes to 24 hours: no card, asks still in the strip. */
  quiet: number;
  noSessionRow: number;
  droppedEnded: number;
  droppedStale: number;
  unchecked: number;
};

export type FleetSessions = {
  cards: SessionCard[];
  ready: ReadyItem[];
  join: JoinStats;
  /** Distinct PR numbers in live snapshots whose state is not CLOSED. */
  openPrs: number;
};

type Step = { done: boolean; proven: boolean };

function chipOf(value: string | null): Chip | null {
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

function cardName(projectKey: string | null, id: string, snapshot: StateSnapshot | undefined): string {
  return `${projectKey ?? 'unmapped'}/${snapshot?.branch ?? '-'}/${id.slice(0, 4)}`;
}

function buildCard(session: ActiveSession, snapshot: StateSnapshot | undefined, nowMs: number): SessionCard {
  const steps = stepsOf(snapshot);
  const brief = snapshot?.brief ?? null;
  const asks = (brief?.ask ?? []).filter((a) => !a.answered);
  const stale = brief !== null && askAgeSeconds(brief.updatedAt, snapshot, nowMs) > STALE_ASK_SECONDS;

  return {
    id: session.id,
    shortId: session.shortId,
    name: cardName(session.projectKey, session.id, snapshot),
    projectKey: session.projectKey,
    projectDisplayName: session.projectDisplayName,
    chip: chipOf(snapshot?.chip ?? null),
    title: brief?.title ?? null,
    goal: brief?.goal ?? null,
    branch: snapshot?.branch ?? null,
    repo: snapshot?.repo ?? null,
    hasBrief: brief !== null,
    planDone: steps.filter((s) => s.done).length,
    planTotal: steps.length,
    askOpen: stale ? 0 : asks.length,
    askStale: stale ? asks.length : 0,
    unproven: steps.filter((s) => s.done && !s.proven).length,
    ctxPct:
      snapshot?.ctx === null || snapshot?.ctx === undefined
        ? null
        : Math.min(100, Math.max(0, Math.round(snapshot.ctx))),
    liveColour: session.liveSecondsAgo < GREEN_UNDER_SECONDS ? 'green' : 'amber',
    liveSecondsAgo: session.liveSecondsAgo,
    stateAgeSeconds: snapshot ? Math.max(0, Math.round((nowMs - snapshot.at) / 1000)) : null,
  };
}

/** `now - (brief.updatedAt ?? file.at)` in seconds. Both stamps are epoch milliseconds. */
function askAgeSeconds(updatedAt: number | null, snapshot: StateSnapshot | undefined, nowMs: number): number {
  const stamp = updatedAt ?? snapshot?.at ?? nowMs;
  return Math.max(0, Math.round((nowMs - stamp) / 1000));
}

function buildReady(id: string, name: string, snapshot: StateSnapshot, nowMs: number): ReadyItem[] {
  const brief = snapshot.brief;
  if (brief === null) return [];
  const ageSeconds = askAgeSeconds(brief.updatedAt, snapshot, nowMs);
  if (ageSeconds > STALE_ASK_SECONDS) return [];
  return brief.ask
    .filter((a) => !a.answered)
    .map((a) => ({
      sessionId: id,
      shortId: id.slice(0, 8),
      name,
      kind: a.kind,
      text: a.text,
      recommend: a.recommend,
      ageSeconds,
    }));
}

type LookupRow = { hasEnded: boolean; quietSeconds: number | null; projectKey: string | null };

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
): Promise<FleetSessions> {
  const bySession = new Map(files.snapshots.map((s) => [s.sessionId, s]));
  const liveIds = new Set(active.sessions.map((s) => s.id));
  const endedIds = new Set(active.recentlyEnded.map((s) => s.id));

  const join: JoinStats = {
    matched: 0,
    quiet: 0,
    noSessionRow: 0,
    droppedEnded: 0,
    droppedStale: 0,
    unchecked: 0,
  };
  const leftover: string[] = [];
  for (const id of bySession.keys()) {
    if (liveIds.has(id)) join.matched += 1;
    else if (endedIds.has(id)) join.droppedEnded += 1;
    else leftover.push(id);
  }

  // Walk only the ids that were queried. An id past the cap was never looked up, so it is
  // `unchecked`, never `noSessionRow`.
  const queried = leftover.slice(0, LOOKUP_LIMIT);
  join.unchecked += leftover.length - queried.length;
  const known = await lookupRows(queried);
  const quietRows = new Map<string, LookupRow>();
  if (known === null) {
    join.unchecked += queried.length;
  } else {
    for (const id of queried) {
      const row = known.get(id);
      if (row === undefined) join.noSessionRow += 1;
      else if (row.hasEnded) join.droppedEnded += 1;
      // No timestamp at all, or quiet for over 24 hours: stale.
      else if (row.quietSeconds === null || row.quietSeconds > QUIET_MAX_SECONDS) join.droppedStale += 1;
      else {
        // Not in the live roster and not ended: quiet. A session that woke up between the two
        // queries lands here too, and its asks still count.
        join.quiet += 1;
        quietRows.set(id, row);
      }
    }
  }

  const cards: SessionCard[] = [];
  const ready: ReadyItem[] = [];
  const openPrs = new Set<number>();
  for (const session of active.sessions) {
    const snapshot = bySession.get(session.id);
    const card = buildCard(session, snapshot, nowMs);
    cards.push(card);
    if (!snapshot) continue;
    ready.push(...buildReady(card.id, card.name, snapshot, nowMs));
    for (const pr of snapshot.prs) if (pr.state !== 'CLOSED') openPrs.add(pr.pr);
  }
  // Quiet sessions: no card and no PR count (those stay live-only), but their asks count.
  for (const [id, row] of quietRows) {
    const snapshot = bySession.get(id);
    if (snapshot) ready.push(...buildReady(id, cardName(row.projectKey, id, snapshot), snapshot, nowMs));
  }
  ready.sort((a, b) => b.ageSeconds - a.ageSeconds || a.sessionId.localeCompare(b.sessionId));

  return { cards, ready, join, openPrs: openPrs.size };
}

/** `SELECT count(*) FROM agentic_os.lane WHERE state = 'active'`. Throws when the query fails. */
export async function getActiveLaneCount(): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM agentic_os.lane WHERE state = 'active'`,
  );
  return Number(rows[0]?.n ?? 0);
}
