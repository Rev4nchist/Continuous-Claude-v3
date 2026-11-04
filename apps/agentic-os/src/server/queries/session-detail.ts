import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

import { readSessionNames } from '@/server/sources/identity-names';
import type { StateFiles, StateSnapshot } from '@/server/sources/state-files';

import {
  askAgeSeconds,
  cardName,
  chipOf,
  GREEN_UNDER_SECONDS,
  STALE_ASK_SECONDS,
  type Chip,
} from './fleet-sessions';

/**
 * The detail of one session (PRD 5.1, the six sections of the terminal Pane).
 *
 * `detail` is built only when the id has a state file AND a public.sessions row that is not ended
 * (the relative rule of sessions.ts) AND the session was quiet for 24 hours or less. Otherwise the
 * caller gets the reason, a fixed word, never a path or file content. Every string in the DTO was
 * redacted, scrubbed and clipped by the reader (state-files.ts).
 */

export const SESSION_ID_FORMAT = /^[0-9a-fA-F-]{8,64}$/;

/** A session id from a query string, or null when it is absent or of the wrong format. */
export function parseSessionId(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && SESSION_ID_FORMAT.test(first) ? first : null;
}

const QUIET_MAX_SECONDS = 24 * 60 * 60;
/** Same live window as getActiveSessions(). */
const LIVE_MAX_SECONDS = 15 * 60;

const MAX_STEPS = 60;
const MAX_DONE = 60;
const MAX_AGENTS = 10;
const MAX_DECISIONS = 5;
const MAX_PRS = 10;
const MAX_LANES = 5;

export type PlanStatus = 'todo' | 'doing' | 'done' | 'blocked';

export type SessionDetail = {
  id: string;
  shortId: string;
  name: string;
  /** The session name from its identity file (cleaned, 16 code points at most), or null: shown as "unnamed". */
  sessionName: string | null;
  projectKey: string | null;
  projectDisplayName: string | null;
  chip: Chip | null;
  liveColour: 'green' | 'amber';
  liveSecondsAgo: number;
  availability: 'live' | 'quiet';
  // Goal
  title: string | null;
  goal: string | null;
  stopAt: string | null;
  repo: string | null;
  branch: string | null;
  worktree: string | null;
  laneIds: string[];
  // Plan
  planSource: 'tasks' | 'brief' | 'none';
  steps: { id: string; text: string; status: PlanStatus }[];
  planMore: number;
  planDone: number;
  planTotal: number;
  // Now
  step: { tool: string; label: string; elapsedSeconds: number } | null;
  agents: { description: string; type: string; status: string }[];
  // Done
  done: { id: string; text: string; proof: { artifact: string; kind: string } | null }[];
  unproven: number;
  // Ask
  asks: {
    kind: string;
    text: string;
    recommend: string | null;
    answered: boolean;
    stale: boolean;
    parsed: boolean;
  }[];
  decisions: { text: string; by: string; ageSeconds: number }[];
  // Health
  ctxPct: number | null;
  cache: { hitPct: number; savedUsd: number } | null;
  agentRuns: { count: number; running: number; costUsd: number } | null;
  prs: { pr: number; state: string | null }[];
  /** From the state file's `hud`. Null when absent: the panel shows a dash. */
  sessionCost: number | null;
  /** Rate-limit windows, shortest first as the HUD wrote them. Null when the file has none. */
  limits: { label: string; percent: number }[] | null;
  stateAgeSeconds: number | null;
  hasBrief: boolean;
};

export type UnavailableReason = 'unknown id' | 'no state file' | 'ended' | 'older than 24 h';

export type DetailUnavailable = { id: string; reason: UnavailableReason };

export type DetailResult = { detail: SessionDetail | null; unavailable: DetailUnavailable | null };

type SessionRow = {
  projectKey: string | null;
  projectDisplayName: string | null;
  hasEnded: boolean;
  quietSeconds: number | null;
};

/** One bounded SELECT by primary key. Null when there is no row. Throws when the query fails. */
async function lookupSession(id: string): Promise<SessionRow | null> {
  const { rows } = await db.execute<{
    project_key: string | null;
    display_name: string | null;
    has_ended: boolean;
    quiet_seconds: number | null;
  }>(sql`
    -- The relative "ended" rule of sessions.ts: ended_at must be the last thing that happened.
    SELECT a.project_key, p.display_name,
      COALESCE(
        s.ended_at >= GREATEST(s.last_heartbeat, COALESCE(s.last_activity_at, s.last_heartbeat)),
        s.ended_at IS NOT NULL
      ) AS has_ended,
      EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC')
        - GREATEST(s.last_heartbeat, COALESCE(s.last_activity_at, s.last_heartbeat))))::int
        AS quiet_seconds
    FROM public.sessions s
    LEFT JOIN agentic_os.project_alias a
      ON a.raw = s.project AND a.project_key IS NOT NULL
    LEFT JOIN agentic_os.project p ON p.key = a.project_key
    WHERE s.id = ${id}
    LIMIT 1
  `);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    projectKey: row.project_key,
    projectDisplayName: row.display_name,
    hasEnded: row.has_ended === true,
    quietSeconds: row.quiet_seconds === null ? null : Number(row.quiet_seconds),
  };
}

type PlanItem = {
  id: string;
  text: string;
  status: PlanStatus;
  kind: 'task' | 'plan';
};

const TASK_TO_PLAN: Record<StateSnapshot['tasks'][number]['status'], PlanStatus> = {
  pending: 'todo',
  in_progress: 'doing',
  completed: 'done',
};

/** The task list when it has items (PRD 5.1), else the brief plan. */
function planOf(snapshot: StateSnapshot): { source: SessionDetail['planSource']; items: PlanItem[] } {
  if (snapshot.tasks.length > 0) {
    return {
      source: 'tasks',
      items: snapshot.tasks.map((t) => ({
        id: t.id,
        text: t.subject,
        status: TASK_TO_PLAN[t.status],
        kind: 'task' as const,
      })),
    };
  }
  const plan = snapshot.brief?.plan ?? [];
  if (plan.length > 0) {
    return {
      source: 'brief',
      items: plan.map((p) => ({ id: p.id, text: p.text, status: p.status, kind: 'plan' as const })),
    };
  }
  return { source: 'none', items: [] };
}

const seconds = (nowMs: number, stamp: number): number => Math.max(0, Math.round((nowMs - stamp) / 1000));
const money = (value: number): number => Math.round(value * 10_000) / 10_000;

function cacheOf(cache: StateSnapshot['cache']): SessionDetail['cache'] {
  if (cache === null) return null;
  const total = cache.input + cache.read + cache.write;
  return {
    hitPct: total > 0 ? Math.round((100 * cache.read) / total) : 0,
    savedUsd: Math.round(cache.savedUsd * 100) / 100,
  };
}

/** The HUD's own names for the two windows; any other kind reads with spaces for underscores. */
const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' };

function limitsOf(hud: StateSnapshot['hud']): SessionDetail['limits'] {
  if (hud === null || hud.limits.length === 0) return null;
  return hud.limits.map(({ kind, percentUsed }) => ({
    label: Object.hasOwn(LIMIT_LABEL, kind) ? LIMIT_LABEL[kind] : kind.replace(/_/g, ' '),
    percent: Math.min(100, Math.max(0, Math.round(percentUsed))),
  }));
}

function agentRunsOf(runs: StateSnapshot['agentRuns']): SessionDetail['agentRuns'] {
  if (runs.length === 0) return null;
  return {
    count: runs.length,
    running: runs.filter((r) => r.status === 'running').length,
    costUsd: money(runs.reduce((sum, r) => sum + r.costUsd, 0)),
  };
}

function buildDetail(
  id: string,
  row: SessionRow,
  quietSeconds: number,
  snapshot: StateSnapshot,
  laneIds: string[],
  nowMs: number,
  sessionName: string | null,
): SessionDetail {
  const brief = snapshot.brief;
  const plan = planOf(snapshot);
  const proofs = brief?.proofs ?? [];
  const proofOf = (item: PlanItem) =>
    proofs.find((p) => p.id === item.id && p.subject === item.text && p.kind === item.kind) ?? null;

  const doneItems = plan.items.filter((item) => item.status === 'done');
  const done = doneItems.map((item) => {
    const proof = proofOf(item);
    return {
      id: item.id,
      text: item.text,
      proof: proof === null ? null : { artifact: proof.artifact, kind: proof.kind },
    };
  });

  const askStale = brief !== null && askAgeSeconds(brief.updatedAt, snapshot, nowMs) > STALE_ASK_SECONDS;
  const decisions = [...(brief?.decisions ?? [])]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_DECISIONS)
    .map((d) => ({ text: d.text, by: d.by, ageSeconds: seconds(nowMs, d.at) }));

  return {
    id,
    shortId: id.slice(0, 8),
    name: cardName(row.projectKey, id, snapshot),
    sessionName,
    projectKey: row.projectKey,
    projectDisplayName: row.projectDisplayName,
    chip: chipOf(snapshot.chip),
    liveColour: quietSeconds < GREEN_UNDER_SECONDS ? 'green' : 'amber',
    liveSecondsAgo: quietSeconds,
    availability: quietSeconds <= LIVE_MAX_SECONDS ? 'live' : 'quiet',
    title: brief?.title ?? null,
    goal: brief?.goal ?? null,
    stopAt: brief?.stopAt ?? null,
    repo: snapshot.repo,
    branch: snapshot.branch,
    worktree: snapshot.worktree,
    laneIds: laneIds.slice(0, MAX_LANES),
    planSource: plan.source,
    steps: plan.items.slice(0, MAX_STEPS).map(({ id: stepId, text, status }) => ({ id: stepId, text, status })),
    planMore: Math.max(0, plan.items.length - MAX_STEPS),
    planDone: doneItems.length,
    planTotal: plan.items.length,
    step:
      snapshot.step === null
        ? null
        : {
            tool: snapshot.step.tool,
            label: snapshot.step.label,
            elapsedSeconds: seconds(nowMs, snapshot.step.startedAt),
          },
    agents: snapshot.agents
      .slice(0, MAX_AGENTS)
      .map(({ description, type, status }) => ({ description, type, status })),
    done: done.slice(0, MAX_DONE),
    unproven: done.filter((d) => d.proof === null).length,
    asks: (brief?.ask ?? []).map((a) => ({
      kind: a.kind,
      text: a.text,
      recommend: a.recommend,
      answered: a.answered,
      stale: askStale,
      parsed: a.source === 'parsed',
    })),
    decisions,
    ctxPct:
      snapshot.ctx === null ? null : Math.min(100, Math.max(0, Math.round(snapshot.ctx))),
    cache: cacheOf(snapshot.cache),
    agentRuns: agentRunsOf(snapshot.agentRuns),
    prs: snapshot.prs.slice(0, MAX_PRS).map(({ pr, state }) => ({ pr, state })),
    sessionCost: snapshot.hud?.costUsd ?? null,
    limits: limitsOf(snapshot.hud),
    stateAgeSeconds: seconds(nowMs, snapshot.at),
    hasBrief: brief !== null,
  };
}

/**
 * The detail of `id`, or the reason it is unavailable. Order of the reasons: no session row,
 * ended, quiet over 24 hours, then no state file. A failed lookup is reported as `unknown id`
 * (the caller shows no path and no error text).
 */
export async function getSessionDetail(
  id: string,
  files: StateFiles,
  lanes: Map<string, string[]>,
  nowMs: number = Date.now(),
): Promise<DetailResult> {
  const unavailable = (reason: UnavailableReason): DetailResult => ({
    detail: null,
    unavailable: { id, reason },
  });

  let row: SessionRow | null;
  try {
    row = await lookupSession(id);
  } catch {
    return unavailable('unknown id');
  }
  if (row === null) return unavailable('unknown id');
  if (row.hasEnded) return unavailable('ended');
  if (row.quietSeconds === null || row.quietSeconds > QUIET_MAX_SECONDS) {
    return unavailable('older than 24 h');
  }
  const snapshot = files.snapshots.find((s) => s.sessionId === id);
  if (snapshot === undefined) return unavailable('no state file');

  // Read only after the session passed every check above: an unknown id never touches the folder.
  const sessionName = (await readSessionNames([id])).get(id) ?? null;
  return {
    detail: buildDetail(id, row, Math.max(0, row.quietSeconds), snapshot, lanes.get(id) ?? [], nowMs, sessionName),
    unavailable: null,
  };
}
