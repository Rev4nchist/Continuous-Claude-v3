/**
 * Card coord-hooks-followups, item 4 step 1: a payload log for subagent calls.
 * Design note: .claudedocs/coordination/2026-11-16-coord-payload-log-design.md (seat GO with three changes, section 8).
 *
 * WHY: the subagent write guard judges a call only when the PreToolUse payload has an `agent_id`. A Workflow agent with
 * no agentType was not judged (live proof 16). No hook logged the agent fields of an allowed call, so the cause is
 * unknown. This log answers it. It is LOG ONLY: no deny, no text to the model, no change to any verdict.
 *
 * HOW: the flag file `<home>/.claude/state/payload-log.flag` holds ONE marker word (`^[a-z0-9-]{8,40}$`). With no flag,
 * or a bad or empty marker, nothing is logged. A call is logged only when the JSON text of `tool_input` holds the
 * marker, so a probe that writes a scratch file named with the marker is the only thing that logs. Every line is a hit
 * by construction. Without the marker every write call of every session would fill the cap in minutes, and under
 * "no agent_id" the agent's line would look like a main-session line.
 *
 * WHAT a line holds: field NAMES and class words only. Never a path, a command, a prompt, a session id, an agent id or
 * the marker. Cap: about PAYLOAD_LOG_CAP lines; no rotation, no lock (two sessions that append at once may pass it by
 * a few lines). Off: delete the flag file. Any error is ignored: a log never blocks a tool call.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { READ_ONLY_AGENT_TYPES } from './subagent-write.js';

export const PAYLOAD_LOG_CAP = 200;
const MARKER_RE = /^[a-z0-9-]{8,40}$/;
const KEY_RE = /^[a-z0-9_]{1,40}$/;
const TOOL_RE = /^[A-Za-z0-9_:.-]{1,60}$/;
const MAX_KEYS = 30;
const MAX_LINE = 600;
const PERMISSION_MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'];
/** The read-only types the guard knows (imported, so the list cannot drift), plus the types a builder or a default agent has. */
const AGENT_TYPES: readonly string[] = [...READ_ONLY_AGENT_TYPES, 'general-purpose', 'claude', 'Explore', 'Plan', 'kraken', 'spark'];

type Payload = Record<string, unknown>;

const userHome = (): string => process.env.CCV3_USER_HOME || homedir();

const present = (v: unknown): string => (typeof v === 'string' && v !== '' ? 'present' : 'absent');

/** A value from a closed list, `other` when it is present and not in the list, `absent` when it is missing or empty. */
function classOf(v: unknown, list: readonly string[]): string {
  if (v === undefined || v === null || v === '') return 'absent';
  return typeof v === 'string' && list.includes(v) ? v : 'other';
}

function sessionClass(payloadId: unknown): string {
  const own = process.env.CLAUDE_CODE_SESSION_ID;
  if (typeof payloadId !== 'string' || payloadId === '' || !own) return 'absent';
  return payloadId === own ? 'same' : 'diff';
}

/** Log one line for a marked call. Never throws, never prints. */
export function logPayloadIfMarked(rawInput: unknown): void {
  try {
    const dir = join(userHome(), '.claude', 'state');
    const flag = join(dir, 'payload-log.flag');
    if (!existsSync(flag)) return;
    const marker = readFileSync(flag, 'utf8').trim();
    if (!MARKER_RE.test(marker)) return;
    if (rawInput === null || typeof rawInput !== 'object') return;
    const input = rawInput as Payload;
    if (!JSON.stringify(input.tool_input ?? null).includes(marker)) return;
    const path = join(dir, 'payload-log.jsonl');
    const have = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0;
    if (have >= PAYLOAD_LOG_CAP) return;
    const tool = typeof input.tool_name === 'string' && TOOL_RE.test(input.tool_name) ? input.tool_name : 'other';
    const keys = Object.keys(input).filter((k) => KEY_RE.test(k) && !k.includes(marker)).sort().slice(0, MAX_KEYS);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      n: have + 1,
      tool,
      keys,
      agent_id: present(input.agent_id),
      agent_type: classOf(input.agent_type, AGENT_TYPES),
      permission_mode: classOf(input.permission_mode, PERMISSION_MODES),
      session: sessionClass(input.session_id),
      transcript: present(input.transcript_path),
    });
    if (line.length > MAX_LINE || line.includes(marker)) return;
    mkdirSync(dir, { recursive: true });
    appendFileSync(path, line + '\n');
  } catch {
    // a log never blocks a tool call
  }
}
