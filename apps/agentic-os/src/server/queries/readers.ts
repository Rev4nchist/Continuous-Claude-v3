import 'server-only';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';

import { db } from '@/db';
import { clockOf, type ClockEntry } from '@/lib/clock';
import { DECISIONS_MAX_BYTES, decisionsOpenCount, parseDecisionsStore, type DecisionsView } from '@/lib/decisions-parse';
import { noteFlags } from '@/lib/note-flags';
import { foldOpenQuestions, type OpenQuestion, type QuestionSnapshot } from '@/lib/open-question';
import { buildReaderSources, capRows, prFeedFresh, prFeedPartial, settleReader, stateFilesPartial, type ReaderOutcome, type ReaderSource } from '@/lib/reader-sources';
import { computeStalls, createGreenTracker, type Stall, type StallLane, type StallPr } from '@/lib/stalls';
import { parseTasksFile, type ScheduledTask, type TasksView } from '@/lib/tasks-parse';

import { readOpenPrRows } from '@/server/sources/pr-feed';
import { readSessionNames } from '@/server/sources/identity-names';
import { readSmallFile } from '@/server/sources/small-file';
import type { StateFiles } from '@/server/sources/state-files';

import { cleanText } from './lane-coord';
import type { OpenPrFeed } from './pr-feed-parse';

/**
 * The readers of the cockpit (card agentic-os-readers). Read only: one lane query, the PR feed rows, the state files the
 * snapshot already read, decisions.json and tasks.json. The pure rules are in src/lib; this file only reads and joins.
 *
 * Privacy: the lane NOTE is selected here, on the server, and only for the two note rules. It becomes booleans in
 * noteFlags() and never leaves this function (the rule at lane-board.ts:39, "note never selected", is changed for this
 * one query on purpose: brief 10-rethink-brief.md section 5). Every label passes cleanText.
 */

const MIN = 60_000;
const OPEN_PR_MAX_AGE_MS = 60 * MIN; // the feed task runs every 15 minutes (tasks.json maxAgeHours 1)
const TASKS_MAX_BYTES = 256 * 1024;
const LANE_LIMIT = 500;

/** The first-seen clock of pr-green lives in this process: a restart can only delay a stall, never invent one. */
const greenTracker = createGreenTracker();

export type ReadersSnapshot = {
  stalls: Stall[];
  clock: ClockEntry[];
  openQuestions: OpenQuestion[];
  /** The open offers in decisions.json, or null when the file could not be read. An error is never 0. */
  decisionsOpen: number | null;
  scheduledTasks: ScheduledTask[];
  /** One row per reader: id stalls, open-question, decisions, clock, tasks. Joined into the snapshot `sources`. */
  sources: ReaderSource[];
};

type LaneRaw = {
  id: string;
  state: string;
  owner_held: boolean;
  updated_ms: string | number | null;
  lease_ms: string | number | null;
  due_ms: string | number | null;
  remind_state: string | null;
  note: string | null;
};

const epoch = (v: string | number | null): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The lanes the readers need, machine-wide: held or in review (stalls and leases), and future scheduled reminders.
 * The note is read only for active and review lanes (the two note rules) and never for any other row.
 */
async function readLaneRows(): Promise<{ rows: LaneRaw[]; truncated: boolean }> {
  const { rows } = await db.execute<LaneRaw>(sql`
    SELECT l.id, l.state, (l.owner_session_id IS NOT NULL) AS owner_held,
           EXTRACT(EPOCH FROM l.updated_at) * 1000 AS updated_ms,
           EXTRACT(EPOCH FROM l.lease_expires_at) * 1000 AS lease_ms,
           EXTRACT(EPOCH FROM l.due_at) * 1000 AS due_ms,
           l.remind_state,
           CASE WHEN l.state IN ('active', 'review') THEN l.note ELSE NULL END AS note
    FROM agentic_os.lane l
    WHERE l.state IN ('active', 'review')
       OR (l.owner_session_id IS NOT NULL AND l.lease_expires_at > now())
       OR (l.due_at IS NOT NULL AND l.due_at > now() AND l.remind_state = 'scheduled')
    LIMIT ${LANE_LIMIT + 1}
  `);
  return capRows(rows, LANE_LIMIT); // one row more than the limit proves a cut (card agentic-os-readers-edge-limits)
}

function decisionsPath(): string {
  return process.env.AGENTIC_OS_DECISIONS_FILE || join(homedir(), '.claude', 'state', 'ccv3-mods', 'decisions.json');
}

function tasksPath(): string {
  // next dev and next start run in apps/agentic-os: the repo root is two levels up. A test points the env at a fixture.
  return process.env.AGENTIC_OS_TASKS_FILE || join(process.cwd(), '..', '..', 'scripts', 'scheduled', 'tasks.json');
}

async function readDecisions(): Promise<DecisionsView> {
  const file = await readSmallFile(decisionsPath(), DECISIONS_MAX_BYTES);
  return parseDecisionsStore(file.text, file.bytes);
}

async function readTasks(nowMs: number): Promise<TasksView> {
  const file = await readSmallFile(tasksPath(), TASKS_MAX_BYTES);
  return parseTasksFile(file.text, nowMs);
}

function stallLanes(rows: LaneRaw[]): StallLane[] {
  return rows
    .filter((r) => r.state === 'active' || r.state === 'review')
    .map((r) => ({
      id: r.id,
      state: r.state,
      updatedAtMs: epoch(r.updated_ms) ?? Number.NaN,
      ownerHeld: r.owner_held === true,
      leaseExpiresAtMs: epoch(r.lease_ms),
      flags: noteFlags(r.note),
    }));
}

function stallPrs(feed: OpenPrFeed, nowMs: number): StallPr[] {
  if (!prFeedFresh(feed, nowMs, OPEN_PR_MAX_AGE_MS)) {
    greenTracker.observe([], nowMs); // a missing or stale feed drops every clock: nothing is "still green"
    return [];
  }
  const rows = feed.rows.map((r) => ({ pr: r.pr, head: r.head ?? '', draft: r.draft, ready: r.ready, ci: r.ci }));
  const since = greenTracker.observe(rows, nowMs);
  return rows.map((r) => ({ ...r, greenSinceMs: since.get(`${r.pr}@${r.head}`) ?? null }));
}

const taskTrigger = (tasks: TasksView, name: string): string | null => (tasks.ok ? (tasks.tasks.find((t) => t.name === name)?.trigger ?? null) : null);

async function openQuestions(stateFiles: StateFiles | null, nowMs: number): Promise<OpenQuestion[]> {
  if (stateFiles === null) return [];
  const candidates = stateFiles.snapshots.filter((s) => s.step?.tool === 'AskUserQuestion' || s.chip === 'waiting-on-dave');
  if (candidates.length === 0) return [];
  const names = await readSessionNames(candidates.map((s) => s.sessionId));
  const shaped: QuestionSnapshot[] = candidates.map((s) => ({
    label: cleanText(`${names.get(s.sessionId) ?? 'session'} #${s.sessionId.slice(0, 8)}`, 80) ?? 'session',
    at: s.at,
    endedAt: s.endedAt,
    chip: s.chip,
    step: s.step ? { tool: s.step.tool, startedAt: s.step.startedAt } : null,
  }));
  return foldOpenQuestions(shaped, nowMs);
}

const failed = (reason: string, nowMs: number): ReaderOutcome => ({ ok: false, reason, readAtMs: nowMs });

/** All readers in one pass. Never throws: one reader's failure is its own source row and the others still return data. */
export async function readReaders(stateFiles: StateFiles | null, nowMs: number = Date.now()): Promise<ReadersSnapshot> {
  const [laneRead, feedRead, decisionsRead, tasksRead, questionsRead] = await Promise.all([
    settleReader(readLaneRows),
    settleReader(readOpenPrRows),
    settleReader(readDecisions),
    settleReader(() => readTasks(nowMs)),
    settleReader(() => openQuestions(stateFiles, nowMs)),
  ]);

  const laneRows = laneRead.ok ? laneRead.value.rows : [];
  const laneCut = laneRead.ok && laneRead.value.truncated ? `lane list cut at ${LANE_LIMIT}` : undefined;
  const feedCut = feedRead.ok && feedRead.value.status === 'ok' ? (prFeedPartial(feedRead.value) ?? undefined) : undefined;
  const stallsPartial = [feedCut, laneCut].filter(Boolean).join(', ') || undefined;
  const feed: OpenPrFeed | null = feedRead.ok ? feedRead.value : null;
  const tasks: TasksView = tasksRead.ok ? tasksRead.value : { ok: false, reason: 'unreadable' };
  const decisions: DecisionsView = decisionsRead.ok ? decisionsRead.value : { ok: false, reason: 'unreadable' };

  const stalls = laneRead.ok || feed ? computeStalls({ lanes: stallLanes(laneRows), prs: feed ? stallPrs(feed, nowMs) : [], nowMs }) : [];
  const exportedAtMs = feed?.exportedAt ? Date.parse(feed.exportedAt) : null;
  const clock = clockOf({
    rows: laneRows.map((r) => ({ id: r.id, ownerHeld: r.owner_held === true, leaseExpiresAtMs: epoch(r.lease_ms), dueAtMs: epoch(r.due_ms), remindState: r.remind_state })),
    feeds: [
      { label: 'Open PRs', exportedAtMs, trigger: taskTrigger(tasks, 'CCv3-Open-PRs') },
      { label: 'Lane snapshot', exportedAtMs: null, trigger: taskTrigger(tasks, 'CCv3-Lane-Snapshot') },
    ],
    nowMs,
  });

  const newestStateWrite = stateFiles && stateFiles.snapshots.length > 0 ? Math.max(...stateFiles.snapshots.map((s) => s.at)) : null;
  const sources = buildReaderSources(
    {
      stalls: !laneRead.ok
        ? failed(laneRead.error, nowMs)
        : !feed || feed.status !== 'ok'
          ? failed('missing', nowMs)
          : { ok: true, readAtMs: nowMs, dataAtMs: exportedAtMs, maxAgeMs: OPEN_PR_MAX_AGE_MS, partial: stallsPartial },
      'open-question': !questionsRead.ok ? failed(questionsRead.error, nowMs) : stateFiles === null ? failed('state files unreadable', nowMs) : { ok: true, readAtMs: nowMs, dataAtMs: newestStateWrite, partial: stateFilesPartial(stateFiles.stats) ?? undefined },
      decisions: decisions.ok ? { ok: true, readAtMs: nowMs } : failed(decisions.reason, nowMs),
      clock: laneRead.ok ? { ok: true, readAtMs: nowMs, partial: laneCut } : failed(laneRead.error, nowMs),
      tasks: tasks.ok ? { ok: true, readAtMs: nowMs } : failed(tasks.reason, nowMs),
    },
    nowMs,
  );

  return {
    stalls,
    clock,
    openQuestions: questionsRead.ok ? questionsRead.value : [],
    decisionsOpen: decisionsOpenCount(decisions),
    scheduledTasks: tasks.ok ? tasks.tasks : [],
    sources,
  };
}
