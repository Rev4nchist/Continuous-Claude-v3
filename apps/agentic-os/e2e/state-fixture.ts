import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { E2E_IDENTITY_DIR, E2E_SPEND_DIR, E2E_STATE_DIR } from '../playwright.config';
import { laneOrderSql } from '../src/server/queries/lane-sort';

/**
 * Fixture state files for e2e/fleet.spec.ts.
 *
 * The real writer is .claude/plugins/ccv3-mods/hooks/agentic-os/index.tsx (writeSnapshot,
 * one `<sessionId>.json` per session). The field types are in
 * .claude/plugins/ccv3-mods/types/index.d.ts. The shapes below copy them on purpose: the app
 * reader must cope with what the real writer writes, so the fixtures mirror it key for key.
 *
 * Units: `at` and `brief.updatedAt` are epoch MILLISECONDS (both come from `$.clock.now()`).
 *
 * The directory is E2E_STATE_DIR (playwright.config.ts), the same path the E2E server gets as
 * AGENTIC_OS_STATE_DIR. Never the real ~/.claude/state.
 */

export const STATE_DIR = E2E_STATE_DIR;
/** The E2E server's identity folder (AGENTIC_OS_IDENTITY_DIR). Never the real ~/.claude/state/identity. */
export const IDENTITY_DIR = E2E_IDENTITY_DIR;

export type FixtureAsk = {
  kind: 'question' | 'approval' | 'decision' | 'block';
  text: string;
  recommend?: string;
  source: 'brief_set' | 'parsed';
  answered?: true;
};

export type FixturePlanStep = {
  id: string;
  text: string;
  status: 'todo' | 'doing' | 'done' | 'blocked';
};

export type FixtureProof = {
  id: string;
  artifact: string;
  at: number;
  subject: string;
  kind: 'task' | 'plan';
};

export type FixtureTask = {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export type FixtureBrief = {
  title?: string;
  goal?: string;
  stopAt?: string;
  /** Who set each value (brief.ts `sources`). The reader keeps only `goal`. */
  sources: { goal?: 'brief_set' | 'parsed'; ask?: 'brief_set' | 'parsed' };
  plan: FixturePlanStep[];
  ask: FixtureAsk[];
  decisions: { text: string; by: string; at: number }[];
  proofs: FixtureProof[];
  updatedAt: number;
};

/**
 * An OsBrief with every list present. `updatedAt` defaults to now (epoch ms). A goal given without
 * `sources` reads as set by `brief_set`, as the real writer records it; pass `sources` to say otherwise.
 */
export function makeBrief(parts: Partial<FixtureBrief> = {}): FixtureBrief {
  return {
    sources: parts.goal === undefined ? {} : { goal: 'brief_set' },
    plan: [],
    ask: [],
    decisions: [],
    proofs: [],
    updatedAt: Date.now(),
    ...parts,
  };
}

/** A question ask in the shape brief_set stores. */
export function ask(text: string, recommend?: string, extra: Partial<FixtureAsk> = {}): FixtureAsk {
  return {
    kind: 'question',
    text,
    ...(recommend === undefined ? {} : { recommend }),
    source: 'brief_set',
    ...extra,
  };
}

// --- Fields the session detail panel reads (P1b B1) ----------------------------------------------
// Each type copies the writer type of the same meaning in .claude/plugins/ccv3-mods/types/index.d.ts
// (OsStep, OsAgent, AgentRun, CacheState, PrWatch, OsPlan). The snapshot holds the NEWEST running
// step only: index.tsx writes `step: (await read($, steps)).at(-1) ?? null`.

export type FixtureStep = { id: string; tool: string; label: string; startedAt: number };

export type FixtureAgent = { id: string; description: string; type: string; status: string };

export type FixtureAgentRun = {
  id: string;
  type: string;
  description: string;
  model: string | null;
  effort: string | null;
  spec: { model?: string; effort?: string };
  startedAt: number;
  endedAt: number | null;
  status: 'running' | 'done' | 'failed';
  tokens: number;
  costUsd: number;
  drift: string | null;
  /**
   * Written by the ledger only when true (agent-ledger/model.ts). `unknown` so a spec can write a
   * wrong type, which the reader must treat as absent.
   */
  hasUnknownModelCost?: unknown;
  /** Written by the ledger only above 0 (the advisor floor). `unknown` for the same reason. */
  advised?: unknown;
};

export type FixtureCache = {
  requests: number;
  input: number;
  read: number;
  write: number;
  savedUsd: number;
  contextTokens: number | null;
  cachedTokens: number | null;
  lastUsedAt: number | null;
  lastModel: string | null;
  lastTurnId: string | null;
  compacted: boolean;
  resumed: boolean;
  ttlMin: number;
  oneHour: boolean;
  misses: never[];
  missCount: number;
};

export type FixturePr = {
  pr: number;
  state: 'READY' | 'PENDING' | 'LIMITED' | 'CLOSED' | 'REVIEWED' | 'STALLED' | 'PROOF' | null;
  whenReady: boolean;
};

export type FixturePlan = { title: string; file?: string };

/** The running step. `startedSecondsAgo` sets `startedAt`; the detail shows the elapsed time. */
export function step(tool: string, label: string, startedSecondsAgo = 30): FixtureStep {
  return { id: `e2e-step-${tool}`, tool, label, startedAt: Date.now() - startedSecondsAgo * 1000 };
}

export function agent(
  description: string,
  type = 'scout',
  status = 'running',
  id = 'e2e-agent-1',
): FixtureAgent {
  return { id, description, type, status };
}

/** An Agent Ledger run. Defaults: finished, 100 tokens, no cost. */
export function agentRun(id: string, parts: Partial<FixtureAgentRun> = {}): FixtureAgentRun {
  return {
    id,
    type: 'scout',
    description: `E2E run ${id}`,
    model: 'claude-sonnet-4-5',
    effort: 'high',
    spec: {},
    startedAt: Date.now() - 600_000,
    endedAt: Date.now() - 300_000,
    status: 'done',
    tokens: 100,
    costUsd: 0,
    drift: null,
    ...parts,
  };
}

/** Prompt-cache state. Defaults: 10 requests, 900 read of 1000 prompt tokens, no write, $1.25 saved. */
export function cacheState(parts: Partial<FixtureCache> = {}): FixtureCache {
  return {
    requests: 10,
    input: 100,
    read: 900,
    write: 0,
    savedUsd: 1.25,
    contextTokens: 1000,
    cachedTokens: 1000,
    lastUsedAt: Date.now() - 60_000,
    lastModel: 'claude-sonnet-4-5',
    lastTurnId: null,
    compacted: false,
    resumed: false,
    ttlMin: 5,
    oneHour: false,
    misses: [],
    missCount: 0,
    ...parts,
  };
}

export function pr(number: number, state: FixturePr['state'], whenReady = false): FixturePr {
  return { pr: number, state, whenReady };
}

export type StateOptions = {
  at?: number;
  brief?: FixtureBrief | null;
  chip?: string | null;
  repo?: string | null;
  branch?: string | null;
  worktree?: string | null;
  ctx?: number | null;
  /** The task list. Leave it empty to make the plan count come from `brief.plan`. */
  tasks?: FixtureTask[];
  /** The newest running tool call (top-level `step`). Default null. */
  step?: FixtureStep | null;
  /** Running subagents (top-level `agents`). Default none. */
  agents?: FixtureAgent[];
  /** Agent Ledger runs (top-level `agentRuns`). Default none. */
  agentRuns?: FixtureAgentRun[];
  /** Prompt-cache state (top-level `cache`). Default null. */
  cache?: FixtureCache | null;
  /** Watched PRs (top-level `prs`). Default none. */
  prs?: FixturePr[];
  /** The plan FILE reference (top-level `plan`, an OsPlan), not the brief's plan steps. Default null. */
  plan?: FixturePlan | null;
  /** The HUD's cost and limits (top-level `hud`, writeSnapshot). `unknown` so a spec can write a malformed one. Default null. */
  hud?: unknown;
};

/** The object the real writer serialises (index.tsx writeSnapshot), with test values. */
export function makeSnapshot(sessionId: string, options: StateOptions = {}): Record<string, unknown> {
  return {
    sessionId,
    at: options.at ?? Date.now(),
    tasks: options.tasks ?? [],
    plan: options.plan ?? null,
    turn: null,
    step: options.step ?? null,
    ctx: options.ctx ?? null,
    agents: options.agents ?? [],
    lanes: [],
    prs: options.prs ?? [],
    agentRuns: options.agentRuns ?? [],
    cache: options.cache ?? null,
    hud: options.hud ?? null,
    brief: options.brief ?? null,
    chip: options.chip ?? null,
    repo: options.repo ?? null,
    branch: options.branch ?? null,
    worktree: options.worktree ?? null,
  };
}

/** Write `<sessionId>.json` into the E2E state dir. Returns the path. */
export function writeState(sessionId: string, options: StateOptions = {}): string {
  return writeRaw(`${sessionId}.json`, JSON.stringify(makeSnapshot(sessionId, options), null, 2));
}

/** Write any text under any name in the E2E state dir (for files that are not valid state). */
export function writeRaw(fileName: string, text: string): string {
  mkdirSync(STATE_DIR, { recursive: true });
  const path = join(STATE_DIR, fileName);
  writeFileSync(path, text);
  return path;
}

/**
 * Remove EVERY file in the E2E state dir. The directory is private to the E2E server, so
 * this also clears leftovers of a crashed run, which would otherwise change the exact counts
 * the specs assert.
 */
export function clearStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  for (const name of readdirSync(STATE_DIR)) {
    rmSync(join(STATE_DIR, name), { recursive: true, force: true });
  }
}

// --- Spend rollup files (the Spend tab) -----------------------------------------------------------

/** The E2E server's spend folder (AGENTIC_OS_SPEND_DIR). Never the real ~/.claude/state/spend. */
export const SPEND_DIR = E2E_SPEND_DIR;

/** Write `<day>.json` into the E2E spend dir. `day` is the CDT date, `YYYY-MM-DD`. Returns the path. */
export function writeRollup(day: string, rollup: unknown): string {
  return writeSpendRaw(`${day}.json`, JSON.stringify(rollup, null, 2));
}

/** Write any text under any name in the E2E spend dir (for a file that is not valid JSON). */
export function writeSpendRaw(fileName: string, text: string): string {
  mkdirSync(SPEND_DIR, { recursive: true });
  const path = join(SPEND_DIR, fileName);
  writeFileSync(path, text);
  return path;
}

/** Remove EVERY file in the E2E spend dir, so a rollup of one test never reaches the next. */
export function clearSpendDir(): void {
  mkdirSync(SPEND_DIR, { recursive: true });
  for (const name of readdirSync(SPEND_DIR)) {
    rmSync(join(SPEND_DIR, name), { recursive: true, force: true });
  }
}

// --- Identity files (the session name) ------------------------------------------------------------

export type IdentityOptions = {
  /** Any JSON value: the reader must accept only a non-empty string. */
  name?: unknown;
  /** The uuid INSIDE the file. The reader must ignore it: the file name is the identity. */
  uuid?: string;
  previous?: string | null;
  cwd?: string;
};

/**
 * Write `<sessionId>.json` into the E2E identity dir in the shape the hooks write
 * (.claude/hooks/src/shared/session-identity.ts): {uuid, short, name, previous, cwd, endedAt,
 * endReason, updatedAt}. Returns the path.
 */
export function writeIdentity(sessionId: string, options: IdentityOptions = {}): string {
  const body = {
    uuid: options.uuid ?? sessionId,
    short: sessionId.slice(0, 8),
    name: options.name === undefined ? null : options.name,
    previous: options.previous ?? null,
    cwd: options.cwd ?? 'C:\\Users\\e2e\\repo',
    endedAt: null,
    endReason: null,
    updatedAt: new Date().toISOString(),
  };
  return writeIdentityRaw(`${sessionId}.json`, JSON.stringify(body, null, 2));
}

/** Write any text under any name in the E2E identity dir (corrupt JSON, an oversize file). */
export function writeIdentityRaw(fileName: string, text: string): string {
  mkdirSync(IDENTITY_DIR, { recursive: true });
  const path = join(IDENTITY_DIR, fileName);
  writeFileSync(path, text);
  return path;
}

/** Make a DIRECTORY named `fileName` in the E2E identity dir (the reader must not read it as a file). */
export function writeIdentityDir(fileName: string): string {
  const path = join(IDENTITY_DIR, fileName);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Remove EVERY entry in the E2E identity dir. The dir is private to the E2E server. */
export function clearIdentityDir(): void {
  mkdirSync(IDENTITY_DIR, { recursive: true });
  for (const name of readdirSync(IDENTITY_DIR)) {
    rmSync(join(IDENTITY_DIR, name), { recursive: true, force: true });
  }
}

/** Remove the identity dir itself (the "no identity folder" case). clearIdentityDir() makes it again. */
export function removeIdentityDir(): void {
  rmSync(IDENTITY_DIR, { recursive: true, force: true });
}

/**
 * The session id format the app accepts in ?session= (B1 design, "Views and URL"). A borrowed
 * session whose id does not match is ignored by the app, so the detail specs must not use it.
 */
export const SESSION_ID_PATTERN = '^[0-9a-fA-F-]{8,64}$';
export const SESSION_ID_FORMAT = new RegExp(SESSION_ID_PATTERN);

/** Epoch ms for "this many seconds ago". */
export function secondsAgo(seconds: number): number {
  return Date.now() - seconds * 1000;
}

// --- A session that ended (read from the database) ----------------------------------------------

/** AGENTIC_OS_DATABASE_URL from the environment, else from apps/agentic-os/.env.local. Never printed. */
function databaseUrl(): string {
  const fromEnv = process.env.AGENTIC_OS_DATABASE_URL;
  if (fromEnv) return fromEnv;
  const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = /^\s*AGENTIC_OS_DATABASE_URL\s*=\s*(.*?)\s*$/.exec(line);
      if (match) return match[1].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  throw new Error('AGENTIC_OS_DATABASE_URL is neither in the environment nor in apps/agentic-os/.env.local.');
}

/**
 * The id of a session that has ended, by the relative rule of getActiveSessions(): ended_at is
 * its latest sign of life. Read straight from the database (SELECT only), so the ENDED spec
 * does not depend on a session having ended in the last 15 minutes. The newest such row is
 * returned. Throws with a clear message when the table has none.
 */
export async function findEndedSessionId(options: { validFormat?: boolean } = {}): Promise<string> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM public.sessions
       WHERE ended_at IS NOT NULL
         AND ended_at >= GREATEST(last_heartbeat, COALESCE(last_activity_at, last_heartbeat))
         AND ($1::boolean IS NOT TRUE OR id::text ~ '${SESSION_ID_PATTERN}')
       ORDER BY ended_at DESC LIMIT 1`,
      [options.validFormat === true],
    );
    if (rows.length === 0) {
      throw new Error(
        'Precondition: public.sessions has no row with ended_at set as its latest sign of life. ' +
          'Close a Claude Code session and run again.',
      );
    }
    return rows[0].id;
  } finally {
    await client.end();
  }
}

/**
 * The id of a QUIET session: not ended (relative rule), and its latest sign of life is between
 * 15 minutes and 24 hours ago. Such a session has no card, but its open asks still feed Ready
 * for Dave (PRD 5.2: an ask lasts until 24 h after the last session activity). An abandoned
 * session row is enough. Read straight from the database (SELECT only). Throws when none.
 */
export async function findQuietSessionId(options: { validFormat?: boolean } = {}): Promise<string> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM public.sessions
       WHERE id NOT LIKE 's-%'
         AND GREATEST(last_heartbeat, COALESCE(last_activity_at, last_heartbeat)) < now() - interval '15 minutes'
         AND GREATEST(last_heartbeat, COALESCE(last_activity_at, last_heartbeat)) > now() - interval '24 hours'
         AND NOT (ended_at IS NOT NULL
                  AND ended_at >= GREATEST(last_heartbeat, COALESCE(last_activity_at, last_heartbeat)))
         AND ($1::boolean IS NOT TRUE OR id::text ~ '${SESSION_ID_PATTERN}')
       ORDER BY 1 LIMIT 1`,
      [options.validFormat === true],
    );
    if (rows.length === 0) {
      throw new Error(
        'Precondition: needs a session that is not ended and was last active 15 minutes to 24 hours ago ' +
          '(an abandoned session row is enough).',
      );
    }
    return rows[0].id;
  } finally {
    await client.end();
  }
}

// --- A live session that holds lanes (read from the database) -----------------------------------

export type HeldLaneFact = {
  id: string;
  title: string;
  leaseSecondsLeft: number | null;
  /** `lane.claimed_at` in epoch seconds, null when the lane has none. */
  claimedAtEpoch: number | null;
};

/**
 * The title the card must show as the lane goal: the held lane with the NEWEST `claimed_at` (the first
 * of equal or missing claims wins), clipped to the 200 characters the app query keeps, on one line.
 * Null when no lane has a title. Computed here from the database facts, not from the app's code.
 */
export function expectedLaneGoal(lanes: readonly HeldLaneFact[]): string | null {
  let best: HeldLaneFact | null = null;
  for (const lane of lanes) {
    if (lane.title.trim() === '') continue;
    if (best === null || (lane.claimedAtEpoch ?? -Infinity) > (best.claimedAtEpoch ?? -Infinity)) best = lane;
  }
  return best === null ? null : best.title.slice(0, 200).replace(/\s+/g, ' ').trim();
}

export type LaneHolder = { sessionId: string; shortId: string; lanes: HeldLaneFact[] };

/**
 * A LIVE session (not ended, last sign of life within 15 minutes, UUID-shaped id) and EVERY lane it
 * holds, in the shared lane sort order. Read straight from the database (SELECT only): the oracle for
 * the level 1 card, independent of the app's own query. The session with the most lanes wins, then
 * the lower id. Lease seconds are measured against the database clock when the query runs. Throws
 * with a clear message when no live session holds a lane.
 */
export async function findLaneHolderSession(): Promise<LaneHolder> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query<{
      id: string;
      title: string;
      owner_session_id: string;
      lease_left: number | null;
      claimed_epoch: number | null;
    }>(
      `SELECT l.id, l.title, l.owner_session_id,
              EXTRACT(EPOCH FROM (l.lease_expires_at - now()))::int AS lease_left,
              EXTRACT(EPOCH FROM l.claimed_at)::float8 AS claimed_epoch
       FROM agentic_os.lane l
       JOIN public.sessions s ON s.id = l.owner_session_id
       WHERE l.state IN ('active', 'review', 'blocked', 'ready')
         AND s.id::text ~ '${SESSION_ID_PATTERN}'
         AND GREATEST(s.last_heartbeat, COALESCE(s.last_activity_at, s.last_heartbeat))
             > (now() AT TIME ZONE 'UTC') - interval '15 minutes'
         AND NOT COALESCE(
           s.ended_at >= GREATEST(s.last_heartbeat, COALESCE(s.last_activity_at, s.last_heartbeat)), FALSE)
       ORDER BY ${laneOrderSql('l')}`,
    );
    const byOwner = new Map<string, HeldLaneFact[]>();
    for (const row of rows) {
      const held = byOwner.get(row.owner_session_id) ?? [];
      held.push({
        id: row.id,
        title: row.title,
        leaseSecondsLeft: row.lease_left === null ? null : Number(row.lease_left),
        claimedAtEpoch: row.claimed_epoch === null ? null : Number(row.claimed_epoch),
      });
      byOwner.set(row.owner_session_id, held);
    }
    const best = [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
    if (best === undefined) {
      throw new Error(
        'Precondition: needs a LIVE session (active in the last 15 minutes) that holds a lane. ' +
          'Claim one with `node C:/Users/dkhay/.claude/scripts/lane.mjs claim <id>` and run again.',
      );
    }
    return { sessionId: best[0], shortId: best[0].slice(0, 8), lanes: best[1] };
  } finally {
    await client.end();
  }
}
