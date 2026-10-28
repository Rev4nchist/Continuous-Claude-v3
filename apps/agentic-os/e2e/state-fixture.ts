import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
