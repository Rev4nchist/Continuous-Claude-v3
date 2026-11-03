/**
 * dc-config-guard (PreToolUse: desktop-commander set_config_value)
 *
 * desktop-commander keeps its own safety settings, and set_config_value changes them with no
 * prompt: an empty blockedCommands, allowedDirectories [] (the whole filesystem) or a new
 * defaultShell widens what every later start_process and file call may do. Found during the F07
 * fix (PR #276, lane dc-config-guard, 2026-11-03).
 *
 * Only the keys in SAFE_KEYS pass. Every other key, and a missing or non-string key, gets an
 * ask (deny when unattended: an ask would hang). There is no override: Dave answers the ask.
 *
 * Two gates: the PreToolUse matcher in settings.json.template must match every CONFIG_TOOLS
 * name. Guard: hook-matcher-runtime-consistency.test.ts.
 */
import { isUnattended } from './shared/unattended.js';
import { logGuardDecision, logGuardError } from './shared/guard-log.js';

const HOOK = 'dc-config-guard';

export const CONFIG_TOOLS: ReadonlySet<string> = new Set([
  'mcp__plugin_desktop-commander_desktop-commander__set_config_value',
]);

/** Keys that change no access: output limits and telemetry. */
const SAFE_KEYS: ReadonlySet<string> = new Set(['telemetryEnabled', 'fileReadLineLimit', 'fileWriteLineLimit']);

interface HookInput {
  tool_name?: string;
  tool?: string;
  tool_input?: unknown;
  permission_mode?: string;
  session_id?: string;
  agent_id?: string;
  cwd?: string;
}

export type ConfigDecision = { decision: 'allow' } | { decision: 'ask' | 'deny'; reason: string; detail: string };

/** Decide allow/ask/deny for one tool call. Pure. */
export function decideConfig(input: HookInput, env: NodeJS.ProcessEnv = process.env): ConfigDecision {
  const tool = input.tool_name || input.tool;
  if (!tool || !CONFIG_TOOLS.has(tool)) return { decision: 'allow' };
  const args = input.tool_input && typeof input.tool_input === 'object' ? (input.tool_input as Record<string, unknown>) : {};
  const key = args.key;
  if (typeof key === 'string' && SAFE_KEYS.has(key)) return { decision: 'allow' };
  const reason = typeof key === 'string' ? `config key ${key}` : 'unreadable config key';
  const value = JSON.stringify(args.value) ?? 'undefined';
  return {
    decision: isUnattended(input, env) ? 'deny' : 'ask',
    reason,
    detail: `${typeof key === 'string' ? key : '<no string key>'} = ${value.slice(0, 200)}`,
  };
}

export function reasonFor(decision: 'ask' | 'deny', detail: string): string {
  const head = decision === 'deny'
    ? 'BLOCKED (fail-closed): desktop-commander config change in an unattended/bypass context'
    : 'CONFIRM: this changes desktop-commander safety settings';
  return `${head}\n\nChange: ${detail}\n\n${
    decision === 'deny'
      ? 'An interactive confirmation would hang a headless/autonomous run, so this is denied. Ask Dave for a yes, or state the reason this change is needed. Do not work around this block.'
      : 'blockedCommands, allowedDirectories ([] = whole filesystem) and defaultShell decide what later desktop-commander calls may do. Approve only if you intend to widen or change them. (Gate: dc-config-guard.)'
  }`;
}

async function main(): Promise<void> {
  let input: HookInput;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf-8').trim() || '{}');
  } catch (err) {
    logGuardError(HOOK, err);
    console.log('{}'); // fail-open on malformed input, like the other guards
    return;
  }
  const d = decideConfig(input);
  if (d.decision === 'allow') { console.log('{}'); return; }
  logGuardDecision(HOOK, input, d.decision, d.reason, { command: d.detail });
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: d.decision,
      permissionDecisionReason: reasonFor(d.decision, d.detail),
    },
  }));
}

// Auto-run only as a hook; VITEST imports the pure functions above.
if (!process.env.VITEST) {
  main().catch((err) => {
    logGuardError(HOOK, err);
    console.log('{}'); // fail-open: a guard crash must never brick the tool
  });
}
