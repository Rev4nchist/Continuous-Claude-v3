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
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { READ_ONLY_AGENT_TYPES } from './subagent-write.js';

export const PAYLOAD_LOG_CAP = 200;
const MARKER_RE = /^[a-z0-9-]{8,40}$/;
const KEY_RE = /^[a-z0-9_]{1,40}$/;
const TOOL_RE = /^[A-Za-z0-9_:.-]{1,60}$/;
const MAX_KEYS = 30;
const MAX_LINE = 2000; // 30 keys of 40 characters fit
const MAX_FLAG_BYTES = 64;
const MAX_LOG_BYTES = 130_000;
const PERMISSION_MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'];
/** Every name in `.claude/agents/*.md` (drift test T14), the built-in names, and the read-only types the guard knows (imported, so that list cannot drift). */
const WRITE_AGENT_TYPES: readonly string[] = ['aegis', 'arbiter', 'atlas', 'debug-agent', 'herald', 'kraken', 'onboard', 'plan-agent', 'research-codebase', 'review-agent', 'scribe', 'sentinel', 'spark', 'validate-agent', 'wizard'];
export const KNOWN_AGENT_TYPES: readonly string[] = [...READ_ONLY_AGENT_TYPES, ...WRITE_AGENT_TYPES, 'general-purpose', 'claude', 'Explore', 'Plan'];
const AGENT_TYPES = KNOWN_AGENT_TYPES;

type Payload = Record<string, unknown>;

const userHome = (): string => process.env.CCV3_USER_HOME || homedir();

/** The words the line itself holds. A marker that is one of them (or the date) could not be told from the log text: refused. */
const fixedText = (): string =>
  ['ts', 'n', 'tool', 'keys', 'agent_id', 'agent_type', 'permission_mode', 'session', 'transcript', 'present', 'absent', 'other', 'same', 'diff', ...AGENT_TYPES, ...PERMISSION_MODES, new Date().toISOString()].join(' ')

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

/**
 * Card coord-hooks-followups, step 2b (design note .claudedocs/coordination/2026-11-22-coord-agent-type-log-design.md,
 * seat GO 2026-11-22 with changes A to D). LOG ONLY: no verdict changes, nothing prints.
 *
 * WHY: a subagent of a type outside the known list (a Workflow agent with no agentType) logs only as `other` above. The
 * real value is unknown and the docs name no default. No deny may key on `other`.
 * WHAT: one line per FIRST sighting of a raw `agent_type`, only when `agent_id` is present and the type is outside the
 * known list. File `<home>/.claude/state/agent-types-seen.jsonl`. A value that is not `^[A-Za-z0-9_:.-]{1,60}$` is stored
 * as the word `invalid`. Never a path, a prompt, a session id, an agent id or a transcript path.
 * COST (change A): the candidate test and the env switch run before any file system call, so a main-session call or a
 * known type touches no file. Change B: the size is read with statSync first; above AGENT_TYPE_LOG_MAX_BYTES the file is
 * neither read nor written. Cap AGENT_TYPE_LOG_CAP lines. No lock. Off: env CCV3_AGENT_TYPE_LOG=0.
 */
export const AGENT_TYPE_LOG_CAP = 50;
export const AGENT_TYPE_LOG_MAX_BYTES = 8192;
const AGENT_TYPE_VALUE_RE = /^[A-Za-z0-9_:.-]{1,60}$/;

export function logUnknownAgentType(rawInput: unknown): void {
  try {
    if (rawInput === null || typeof rawInput !== 'object') return;
    const input = rawInput as Payload;
    if (typeof input.agent_id !== 'string' || input.agent_id === '') return;
    const type = input.agent_type;
    if (typeof type !== 'string' || type === '' || AGENT_TYPES.includes(type)) return;
    if (process.env.CCV3_AGENT_TYPE_LOG === '0') return;
    const value = AGENT_TYPE_VALUE_RE.test(type) ? type : 'invalid';
    const dir = join(userHome(), '.claude', 'state');
    const path = join(dir, 'agent-types-seen.jsonl');
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0; // no file yet
    }
    if (size >= AGENT_TYPE_LOG_MAX_BYTES) return;
    const rows = size > 0 ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
    if (rows.length >= AGENT_TYPE_LOG_CAP) return;
    for (const row of rows) {
      try {
        if ((JSON.parse(row) as { value?: unknown }).value === value) return;
      } catch {
        // a damaged line is skipped
      }
    }
    const tool = typeof input.tool_name === 'string' && TOOL_RE.test(input.tool_name) ? input.tool_name : 'other';
    const line = JSON.stringify({ ts: new Date().toISOString(), value, tool, agent_id: 'present', session: sessionClass(input.session_id) });
    mkdirSync(dir, { recursive: true });
    appendFileSync(path, line + '\n');
  } catch {
    // a log never blocks a tool call
  }
}

/** Log one line for a marked call. Never throws, never prints. */
export function logPayloadIfMarked(rawInput: unknown): void {
  try {
    const dir = join(userHome(), '.claude', 'state');
    const flag = join(dir, 'payload-log.flag');
    if (!existsSync(flag) || statSync(flag).size > MAX_FLAG_BYTES) return;
    const marker = readFileSync(flag, 'utf8').trim();
    if (!MARKER_RE.test(marker) || fixedText().includes(marker)) return;
    if (rawInput === null || typeof rawInput !== 'object') return;
    const input = rawInput as Payload;
    if (!JSON.stringify(input.tool_input ?? null).includes(marker)) return;
    const path = join(dir, 'payload-log.jsonl');
    if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) return;
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
