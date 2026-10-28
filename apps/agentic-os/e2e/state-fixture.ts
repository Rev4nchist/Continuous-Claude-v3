import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { E2E_STATE_DIR } from '../playwright.config';

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
  sources: Record<string, never>;
  plan: FixturePlanStep[];
  ask: FixtureAsk[];
  decisions: { text: string; by: string; at: number }[];
  proofs: FixtureProof[];
  updatedAt: number;
};

/** An OsBrief with every list present. `updatedAt` defaults to now (epoch ms). */
export function makeBrief(parts: Partial<FixtureBrief> = {}): FixtureBrief {
  return {
    sources: {},
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
};

/** The object the real writer serialises (index.tsx writeSnapshot), with test values. */
export function makeSnapshot(sessionId: string, options: StateOptions = {}): Record<string, unknown> {
  return {
    sessionId,
    at: options.at ?? Date.now(),
    tasks: options.tasks ?? [],
    plan: null,
    turn: null,
    step: null,
    ctx: options.ctx ?? null,
    agents: [],
    lanes: [],
    prs: [],
    agentRuns: [],
    cache: null,
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
export async function findEndedSessionId(): Promise<string> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM public.sessions
       WHERE ended_at IS NOT NULL
         AND ended_at >= GREATEST(last_heartbeat, COALESCE(last_activity_at, last_heartbeat))
       ORDER BY ended_at DESC LIMIT 1`,
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
export async function findQuietSessionId(): Promise<string> {
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
       ORDER BY 1 LIMIT 1`,
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
