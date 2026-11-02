#!/usr/bin/env node
/**
 * Lane Board Republish Reminder Hook
 *
 * The lane board is a claude.ai artifact rendered from the lane DB by render-board.mjs. A script
 * cannot publish it: only the agent's Artifact tool can. So when a session changes the lane DB
 * through lane.mjs, this hook reminds that session, once per batch, to re-render and republish.
 *
 * Hook: PostToolUse, matcher Bash|PowerShell|Artifact (settings.json.template).
 * State: ~/.claude/state/lane-board-pending/<session_id>.json = {since, verbs}
 *   - first lane change since the last republish: write state, emit the reminder
 *   - later lane changes while pending: update the verb list, stay silent
 *   - Artifact publish of the board (url or lane-board.html): delete the state, stay silent
 * Never blocks. Any error: no output, exit 0.
 *
 * Failure evidence: a failing Bash call arrives as PostToolUseFailure, not PostToolUse (see
 * shared/tool-error.ts and .claude/cache/e2e/2026-10-06-correct-posttooluse-bash.json), so this
 * PostToolUse registration already skips most failures. The is_error / exit-code checks are a
 * second guard for payloads that do carry them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { maskQuoted } from './shared/mask-quotes.js';
import { detectToolError, exitCodeOf } from './shared/tool-error.js';

export const BOARD_ARTIFACT_ID = 'RtrTNVfAq9uowmb2tfbzid';
export const BOARD_ARTIFACT_URL = `https://claude.ai/artifact/${BOARD_ARTIFACT_ID}`;
export const RENDER_COMMAND = 'node scripts/coordination/render-board.mjs';
export const BOARD_FILE = 'lane-board.html';

/** lane.mjs verbs that change the lane DB. Read-only verbs (board, next, inbox, ...) are absent. */
export const CHANGING_VERBS = new Set([
  'claim',
  'release',
  'done',
  'note',
  'say',
  'add',
  'apply-kanban',
  'state',
  'seed',
]);

/** Tools this hook accepts. Must match the settings.json.template matcher. */
const HOOK_TOOLS = new Set(['Bash', 'PowerShell', 'Artifact']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

export type Action = 'remind' | 'mark' | 'clear' | 'none';

export interface Decision {
  action: Action;
  verb?: string;
  message?: string;
}

const NONE: Decision = { action: 'none' };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

function reminder(verb: string): string {
  return (
    `Lane DB changed (lane.mjs ${verb}). The lane board page is a snapshot. ` +
    `When this batch of lane changes is done: run ${RENDER_COMMAND}, then publish ${BOARD_FILE} ` +
    `with the Artifact tool to url ${BOARD_ARTIFACT_URL} (omit capabilities). ` +
    `Steps: kanban-sync skill step 7.`
  );
}

/**
 * The first state-changing lane.mjs verb a command runs, or null.
 *
 * A quoted path to lane.mjs is unquoted first. Then quoted text is masked, so a commit message
 * that mentions "lane.mjs done" never counts. `node` must start the command (after an optional PowerShell
 * call operator or an env prefix), so `echo node lane.mjs done` is not a run. A segment (split on
 * `; & | newline`) with --dry-run is a plan, not a change.
 */
export function laneChangeVerb(command: string, tool: string): string | null {
  const unquoted = command.replace(/(["'])([^"'\n]*lane\.mjs)\1/g, '$2');
  const masked = maskQuoted(unquoted, tool);
  const re = /^[(\s]*(?:&\s+)?(?:\w+=\S+\s+)*node(?:\.exe)?(?:\s+--?[\w-]+(?:=\S+)?)*\s+(?:[^\s;&|()]*[\\/])?lane\.mjs\s+([a-z][a-z-]*)/;
  for (const segment of masked.split(/[;&|\n]+/)) {
    if (/--dry-run\b/.test(segment)) continue;
    const m = segment.match(re);
    if (m && CHANGING_VERBS.has(m[1])) return m[1];
  }
  return null;
}

function failed(data: Record<string, unknown>): boolean {
  if (data.hook_event_name === 'PostToolUseFailure') return true;
  const resp = data.tool_response;
  if (detectToolError(resp)) return true;
  const code = exitCodeOf(resp);
  return code !== null && code !== 0;
}

function isBoardPublish(input: Record<string, unknown>): boolean {
  const url = typeof input.url === 'string' ? input.url : '';
  const file = typeof input.file_path === 'string' ? input.file_path : '';
  return url.includes(BOARD_ARTIFACT_ID) || file.replace(/\\/g, '/').toLowerCase().endsWith(`/${BOARD_FILE}`) || file.toLowerCase() === BOARD_FILE;
}

/** Pure decision. `pending` = the session already changed lanes since the last republish. */
export function decide(payload: unknown, pending: boolean): Decision {
  if (!isObj(payload)) return NONE;
  const tool = payload.tool_name;
  if (typeof tool !== 'string' || !HOOK_TOOLS.has(tool)) return NONE;
  if (typeof payload.session_id !== 'string' || !payload.session_id) return NONE;
  const input = payload.tool_input;
  if (!isObj(input) || failed(payload)) return NONE;

  if (tool === 'Artifact') return isBoardPublish(input) ? { action: 'clear' } : NONE;

  if (!COMMAND_TOOLS.has(tool) || typeof input.command !== 'string') return NONE;
  const verb = laneChangeVerb(input.command, tool);
  if (!verb) return NONE;
  return pending ? { action: 'mark', verb } : { action: 'remind', verb, message: reminder(verb) };
}

// ---- thin IO ----

function stateDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.claude', 'state', 'lane-board-pending');
}

export function stateFile(sessionId: string): string {
  return path.join(stateDir(), `${sessionId.replace(/[^a-zA-Z0-9-_]/g, '_')}.json`);
}

function readState(file: string): { since?: string; verbs?: string[] } | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObj(s) ? s : null;
  } catch {
    return null;
  }
}

function applyDecision(d: Decision, sessionId: string): void {
  const file = stateFile(sessionId);
  if (d.action === 'clear') {
    fs.rmSync(file, { force: true });
    return;
  }
  const prev = readState(file);
  const verbs = [...(prev?.verbs ?? []), d.verb as string].slice(-50);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ since: prev?.since ?? new Date().toISOString(), verbs }));
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
  const pending = sessionId ? readState(stateFile(sessionId)) !== null : false;
  const d = decide(payload, pending);
  if (d.action === 'none') return;
  applyDecision(d, sessionId);
  if (d.action === 'remind') {
    console.log(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: d.message } }),
    );
  }
}

if (!process.env.VITEST) {
  main().catch(() => {
    // Fail open: no output, exit 0.
  });
}

export { main };
