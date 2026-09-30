#!/usr/bin/env node
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { logSkill, logAgent } from './shared/session-activity.js';
import { detectToolError } from './shared/tool-error.js';

interface HookInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
    // Widened per Gate B2 / premortem T4. The original two-field shape
    // ({status, output}) hid is_error/error/success — the fields Claude Code
    // actually sets on tool failures. detectToolError() in shared/tool-error.ts
    // checks all four; this type lets tests construct realistic payloads
    // without `as any` casts.
    tool_response?: {
        status?: string;
        output?: string;
        is_error?: boolean;
        error?: string | boolean;
        success?: boolean;
    };
}

interface TelemetryEvent {
    timestamp: string;
    session_id: string;
    type: 'skill_triggered' | 'skill_used' | 'agent_suggested' | 'agent_spawned';
    name: string;
    trigger_source: 'hook' | 'explicit' | 'llm';
    success?: boolean;
    /**
     * Gate B2 instrumentation: empirical record of what fields Claude Code
     * actually sends in tool_response. Lets us audit `~/.claude/cache/
     * skill-telemetry.jsonl` and confirm whether is_error / error / success
     * ever appear in real payloads vs the speculation in the Phase 3a comment.
     * Always present; `[]` when tool_response is null/undefined.
     */
    tool_response_keys: string[];
}

function getTelemetryPath(): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const telemetryDir = join(homeDir, '.claude', 'cache');
    if (!existsSync(telemetryDir)) {
        mkdirSync(telemetryDir, { recursive: true });
    }
    return join(telemetryDir, 'skill-telemetry.jsonl');
}

function logEvent(event: TelemetryEvent): void {
    const telemetryPath = getTelemetryPath();
    const line = JSON.stringify(event) + '\n';
    appendFileSync(telemetryPath, line, 'utf-8');
}

function determineSource(toolInput: Record<string, unknown>): 'hook' | 'explicit' | 'llm' {
    const skill = toolInput.skill as string || '';
    if (skill.startsWith('/')) {
        return 'explicit';
    }
    return 'llm';
}

/**
 * Compute `tool_response_keys` for empirical instrumentation. Returns the
 * sorted keys of the tool_response object (or `[]` when null/undefined).
 *
 * Gate B2: lets us audit `~/.claude/cache/skill-telemetry.jsonl` and see
 * what fields Claude Code actually sends in tool_response. We've been
 * speculating for a week; this gives us empirical signal.
 *
 * Exported for unit testing.
 */
export function buildToolResponseKeys(toolResponse: unknown): string[] {
    if (toolResponse === null || toolResponse === undefined) return [];
    if (typeof toolResponse !== 'object') return [];
    return Object.keys(toolResponse as Record<string, unknown>);
}

async function main() {
    try {
        const input = readFileSync(0, 'utf-8');
        const data: HookInput = JSON.parse(input);

        if (data.tool_name === 'Skill') {
            const skillName = data.tool_input?.skill as string || 'unknown';
            // Gate B2: use detectToolError (adds status==='error' beyond the
            // is_error/error/success checks). The original `status !== 'error'` check missed
            // is_error/error/success — 0/285 prod rows showed success: false
            // before this change.
            const success = !detectToolError(data.tool_response);
            const toolResponseKeys = buildToolResponseKeys(data.tool_response);

            const event: TelemetryEvent = {
                timestamp: new Date().toISOString(),
                session_id: data.session_id,
                type: 'skill_used',
                name: skillName,
                trigger_source: determineSource(data.tool_input),
                success,
                tool_response_keys: toolResponseKeys
            };

            logEvent(event);
            try { logSkill(data.session_id, skillName); } catch { /* never break */ }
        } else if (data.tool_name === 'Task') {
            const agentType = data.tool_input?.subagent_type as string || 'unknown';
            // Gate B2: see Skill branch above for context on the detector swap.
            const success = !detectToolError(data.tool_response);
            const toolResponseKeys = buildToolResponseKeys(data.tool_response);

            const event: TelemetryEvent = {
                timestamp: new Date().toISOString(),
                session_id: data.session_id,
                type: 'agent_spawned',
                name: agentType,
                trigger_source: 'llm',
                success,
                tool_response_keys: toolResponseKeys
            };

            logEvent(event);
            try { logAgent(data.session_id, agentType); } catch { /* never break */ }
        }

        // Deliberately NO process.exit(0) here: process.exit() with async handles
        // in flight tore libuv down mid-teardown on Windows (exit 0xC0000409).
        // Letting the event loop drain naturally is the shape that works.
    } catch {
        /* fail-open: never let telemetry break the tool call */
    }
}

if (!process.env.VITEST) {
    main();
}
