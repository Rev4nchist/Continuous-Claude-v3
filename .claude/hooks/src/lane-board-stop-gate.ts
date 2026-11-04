#!/usr/bin/env node
/**
 * Lane Board Stop Gate Hook
 *
 * lane-board-republish-reminder.ts writes a pending file when a session changes the lane DB. Only
 * the agent's Artifact tool can publish the board, and a reminder alone did not make sessions do it
 * (the phone board went stale on 2026-11-04). This hook blocks the end of a turn ONCE per batch of
 * lane changes until the board is published.
 *
 * Hook: Stop (settings.json.template). No matcher.
 * State: ~/.claude/state/lane-board-pending/<session_id>.json, written by the reminder hook:
 *   {since, verbs}. The reminder deletes it when the board is published.
 *   This hook adds {stopBlocked: true} after it blocks, so a second Stop in the same batch passes.
 *   A new lane change rewrites the file without that flag, which starts a new batch.
 *
 * Approve (no output) when:
 *   - stop_hook_active is true (Claude Code is already continuing because of a Stop hook)
 *   - the entrypoint starts with "sdk" (headless claude -p has no Artifact tool);
 *     LANE_CONTEXT_HEADLESS=1 opts back in, the same switch as lane-context
 *   - there is no session id, no pending file, or the batch was already blocked once
 *   - anything fails (fail open)
 * Block: stdout {"decision":"block","reason":"..."} and exit 0.
 *
 * The state-file path and the board constants are copied from the reminder hook, not imported:
 * importing that module would run its main() inside this hook. The drift test in
 * __tests__/lane-board-stop-gate.test.ts fails if the copies diverge.
 */

import * as fs from 'fs';
import * as path from 'path';

export const BOARD_ARTIFACT_ID = 'RtrTNVfAq9uowmb2tfbzid';
export const BOARD_ARTIFACT_URL = `https://claude.ai/artifact/${BOARD_ARTIFACT_ID}`;
export const RENDER_COMMAND = 'node scripts/coordination/render-board.mjs';
export const BOARD_FILE = 'lane-board.html';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

export type StopDecision = { action: 'approve' } | { action: 'block'; reason: string };

export function blockReason(): string {
  return (
    `The lane board page is out of date: this session changed the lane DB and has not republished it. ` +
    `Run ${RENDER_COMMAND}, then publish ${BOARD_FILE} with the Artifact tool to url ${BOARD_ARTIFACT_URL} ` +
    `(omit capabilities). If the publish is refused because a newer version exists, render again and retry once. ` +
    `Then finish your turn.`
  );
}

/** True for a headless run (claude -p) that has not opted back in. */
export function isHeadless(env: Record<string, string | undefined>): boolean {
  if (env.LANE_CONTEXT_HEADLESS === '1') return false;
  return (env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk');
}

/**
 * Pure decision. `pending` is the parsed pending file, or null when there is none.
 * A block is also the cue for the caller to set stopBlocked on the file.
 */
export function decideStop(
  payload: unknown,
  env: Record<string, string | undefined>,
  pending: { stopBlocked?: boolean } | null,
): StopDecision {
  const approve: StopDecision = { action: 'approve' };
  if (!isObj(payload)) return approve;
  if (payload.stop_hook_active === true) return approve;
  if (isHeadless(env)) return approve;
  if (typeof payload.session_id !== 'string' || !payload.session_id) return approve;
  if (pending === null) return approve;
  if (pending.stopBlocked === true) return approve;
  return { action: 'block', reason: blockReason() };
}

// ---- thin IO ----

export function stateDir(env: Record<string, string | undefined> = process.env): string {
  if (env.LANE_BOARD_PENDING_DIR) return env.LANE_BOARD_PENDING_DIR;
  const home = env.HOME || env.USERPROFILE || '';
  return path.join(home, '.claude', 'state', 'lane-board-pending');
}

export function stateFile(sessionId: string, env: Record<string, string | undefined> = process.env): string {
  return path.join(stateDir(env), `${sessionId.replace(/[^a-zA-Z0-9-_]/g, '_')}.json`);
}

function readState(file: string): Record<string, unknown> | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObj(s) ? s : null;
  } catch {
    return null;
  }
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
  const payload = JSON.parse(input);
  const sessionId = isObj(payload) && typeof payload.session_id === 'string' ? payload.session_id : '';
  const file = sessionId ? stateFile(sessionId) : '';
  const pending = file ? readState(file) : null;
  const d = decideStop(payload, process.env, pending);
  if (d.action !== 'block') return;
  try {
    fs.writeFileSync(file, JSON.stringify({ ...(pending ?? {}), stopBlocked: true }));
  } catch {
    // If the flag cannot be written the block would repeat. Approve instead.
    return;
  }
  console.log(JSON.stringify({ decision: 'block', reason: d.reason }));
}

if (!process.env.VITEST) {
  main().catch(() => {
    // Fail open: no output, exit 0.
  });
}

export { main };
