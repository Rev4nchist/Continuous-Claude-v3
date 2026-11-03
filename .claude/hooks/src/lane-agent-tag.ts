#!/usr/bin/env node
/**
 * lane-agent-tag - PreToolUse (Bash|PowerShell)
 *
 * A subagent shares its parent's session UUID (identity-probe, Q1), so a lane
 * note from a subagent reads as the parent. This hook tells them apart: when the
 * payload carries agent_id AND agent_type, it adds `--agent <agent_type>` right after the verb
 * of a `node ...lane.mjs say|note` call. lane.mjs renders it as "name/type #sid8".
 *
 * Live probe 2026-11-03 (.claude/cache/e2e/2026-11-03-lane-agent-tag-live.txt): a subagent
 * Bash payload carries agent_id and agent_type; the main thread carries neither. A main
 * thread started with `claude --agent <x>` may carry agent_type alone, so agent_id is the
 * gate: without it the call is not tagged.
 *
 * The model does nothing. The hook returns updatedInput only. It sets no
 * permissionDecision, so the normal permission flow still decides.
 * On any doubt it returns {} and the command runs unchanged.
 */

import { readFileSync } from 'fs';

/** Both shell tools. Same list as the settings.json matcher `Bash|PowerShell`. */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

/** `node [path/]lane.mjs say|note`, with the verb captured. */
const LANE_VERB_RE = /(\bnode(?:\.exe)?["']?\s+["']?[^\s"'|;&]*lane\.mjs["']?\s+)(say|note)(?=\s|$)/g;
const AGENT_TYPE_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** The rewritten command, or null when nothing should change. */
export function tagLaneCommand(command: string, agentType: string): string | null {
  if (!AGENT_TYPE_RE.test(agentType)) return null;
  let changed = false;
  const out = command.replace(LANE_VERB_RE, (m, head: string, verb: string, offset: number, whole: string) => {
    // Already tagged: the next token after the verb is --agent.
    if (/^\s+--agent\b/.test(whole.slice(offset + m.length))) return m;
    changed = true;
    return `${head}${verb} --agent ${agentType}`;
  });
  return changed ? out : null;
}

export function run(raw: string): object {
  try {
    const input = JSON.parse(raw) as {
      tool_name?: string;
      agent_id?: string;
      agent_type?: string;
      tool_input?: Record<string, unknown>;
    };
    if (!input.tool_name || !COMMAND_TOOLS.has(input.tool_name)) return {};
    const command = input.tool_input?.command;
    if (typeof command !== 'string' || typeof input.agent_type !== 'string') return {};
    if (typeof input.agent_id !== 'string' || !input.agent_id) return {};
    const tagged = tagLaneCommand(command, input.agent_type);
    if (tagged === null) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...input.tool_input, command: tagged },
      },
    };
  } catch {
    return {};
  }
}

if (/(^|[\\/])lane-agent-tag\.(mjs|js|ts)$/.test(process.argv[1] || '')) {
  let raw = '';
  try { raw = readFileSync(0, 'utf-8'); } catch { /* no stdin */ }
  console.log(JSON.stringify(run(raw)));
}
