#!/usr/bin/env node
/**
 * Lane Board Stop Gate Hook
 *
 * lane-board-republish-reminder.ts writes a pending file per (session, board) when a session changes the lane
 * DB. Only the agent's Artifact tool can publish a board page, and a reminder alone did not make sessions do it
 * (the phone board went stale on 2026-11-04). This hook blocks the end of a turn ONCE per batch of lane
 * changes until the board is published.
 *
 * Hook: Stop (settings.json.template). No matcher.
 * State: <pending dir>/<sid>.json (default board) and <sid>@<board>.json, written by the reminder hook:
 *   {since, verbs, board}. The reminder deletes a file when that board's page is published.
 *   This hook adds {stopBlocked: true} after it blocks, so a second Stop in the same batch passes.
 *   A new lane change rewrites the file without that flag, which starts a new batch.
 *   Files older than 24 h are deleted on every Stop.
 *
 * It blocks for the FIRST pending file (file-name order) whose board has a phone page
 * (boardArtifact(board) is not null) and has no stopBlocked. Boards without a phone page never block.
 *
 * Approve (no output) when:
 *   - stop_hook_active is true (Claude Code is already continuing because of a Stop hook)
 *   - the entrypoint starts with "sdk" (headless claude -p has no Artifact tool);
 *     LANE_CONTEXT_HEADLESS=1 opts back in, the same switch as lane-context
 *   - there is no session id, no qualifying pending file, or every batch was already blocked once
 *   - anything fails (fail open)
 * Block: stdout {"decision":"block","reason":"..."} and exit 0.
 *
 * The file names, the pending dir and the board constants come from shared/lane-board-pending.ts and
 * shared/lane-board.ts, which the reminder hook imports too. Neither hook imports the other (that would
 * run its main()). The drift test in __tests__/lane-board-stop-gate.test.ts keeps them in step.
 */

import * as fs from 'fs';
import { DEFAULT_BOARD, boardArtifact, primaryRepo, renderBoardCmd } from './shared/lane-board.js';
import { listPending, pendingDir, pendingFile, sweepStalePending, type Pending } from './shared/lane-board-pending.js';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

type Env = Record<string, string | undefined>;

export type StopDecision = { action: 'approve' } | { action: 'block'; reason: string; board: string };

export function blockReason(board: string, env: Env = process.env): string {
  const a = boardArtifact(board, { env });
  if (!a) return '';
  return (
    `The lane board page for board ${board} is out of date: this session changed the lane DB and has not republished it. ` +
    `Other sessions update this page all day, so your held copy is old. In this order: ` +
    `1. Read the live page with the Artifact tool, action read, url ${a.url}, without path (a read with path does not count). Do not open or paste the saved file.` +
    `2. Run ${renderBoardCmd(board, env)}. ` +
    `3. At once publish ${primaryRepo(env)}/${a.publishFrom} with the Artifact tool to url ${a.url} (omit capabilities). ` +
    `If the publish is refused, publish the same file again: the refusal counts as the read. ` +
    `Then finish your turn.`
  );
}

/** True for a headless run (claude -p) that has not opted back in. */
export function isHeadless(env: Env): boolean {
  if (env.LANE_CONTEXT_HEADLESS === '1') return false;
  return (env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk');
}

/**
 * Pure decision. `entries` are the session's pending files, parsed (file-name order). A block is also the cue
 * for the caller to set stopBlocked on the file of the board it names.
 */
export function decideStop(
  payload: unknown,
  env: Env,
  entries: Array<{ board: string; pending: Pending }>,
): StopDecision {
  const approve: StopDecision = { action: 'approve' };
  if (!isObj(payload)) return approve;
  if (payload.stop_hook_active === true) return approve;
  if (isHeadless(env)) return approve;
  if (typeof payload.session_id !== 'string' || !payload.session_id) return approve;
  for (const e of entries) {
    if (e.pending.stopBlocked === true) continue;
    if (!boardArtifact(e.board, { env })) continue;
    return { action: 'block', reason: blockReason(e.board, env), board: e.board };
  }
  return approve;
}

// ---- thin IO ----

export const stateDir = pendingDir;
export const stateFile = pendingFile;

/** Sweep stale files, read this session's batches, decide, and mark the block. */
export function stopGate(payload: unknown, env: Env = process.env, now: number = Date.now()): { output: object | null } {
  sweepStalePending(env, now);
  const sid = isObj(payload) && typeof payload.session_id === 'string' ? payload.session_id : '';
  const entries = sid ? listPending(sid, env) : [];
  const d = decideStop(payload, env, entries.map(({ board, pending }) => ({ board, pending })));
  if (d.action !== 'block') return { output: null };
  const hit = entries.find((e) => e.board === d.board);
  try {
    fs.writeFileSync((hit as NonNullable<typeof hit>).file, JSON.stringify({ ...hit?.pending, stopBlocked: true }));
  } catch {
    // If the flag cannot be written the block would repeat. Approve instead.
    return { output: null };
  }
  return { output: { decision: 'block', reason: d.reason } };
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input.trim()) return;
  const { output } = stopGate(JSON.parse(input));
  if (output) console.log(JSON.stringify(output));
}

if (!process.env.VITEST) {
  main().catch(() => {
    // Fail open: no output, exit 0.
  });
}

export { main, DEFAULT_BOARD };
