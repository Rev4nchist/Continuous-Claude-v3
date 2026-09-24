#!/usr/bin/env node
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { logSkill, logAgent } from './shared/session-activity.js';
import { emitBraintrustScore } from './shared/braintrust-score.js';
import { resolveBraintrustSpanId } from './shared/braintrust-span.js';
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

// ---------------------------------------------------------------------------
// Phase 3a (story braintrust-scoring): skill_trigger_accuracy score emit.
//
// The original plan describes "skill_trigger_accuracy" as a multi-skill
// collision detector (exactly 1 skill triggered = 1.0, 0 or 2+ = 0.0).
// That detection happens at a higher layer than this PostToolUse:Skill
// hook -- by the time we run, exactly 1 skill has fired by definition.
//
// What we CAN measure deterministically from this hook is whether that
// single skill SUCCEEDED. We emit:
//   * skill_trigger_accuracy: 1.0 when success === true, else 0.0
//
// Gate B2 (2026-05-24): success is now derived from `detectToolError`
// (`shared/tool-error.ts`), a TS port of the Python `_detect_tool_error`
// at `braintrust_hooks.py:422-449`. It checks four indicators:
// is_error===true, error truthy non-empty, success===false, OR
// status==='error'. The original `status !== 'error'` check missed the
// first three and 0/285 prod rows showed success: false. We also write
// `tool_response_keys` to the jsonl telemetry so we can audit what
// Claude Code actually sends in tool_response.
//
// spanId resolution: from the Python-written span state file, via
// shared/braintrust-span.ts, keyed on the payload session id.
//
// It previously read BRAINTRUST_SESSION_ID -- which this comment claimed was
// "set by the Python hook chain", and which is in fact set nowhere (verified
// 2026-07-28) -- then fell back to the payload session_id. That fallback was
// the more dangerous half: a Claude Code session id is NOT a Braintrust span
// id, so it addressed feedback to a span that does not exist. Fail-open still
// applies: no span, no emit.
// ---------------------------------------------------------------------------
export function resolveScoreSpanId(payloadSessionId: string | undefined): string {
    // Was: BRAINTRUST_SESSION_ID env, falling back to the payload session_id.
    // The env var is set NOWHERE (checked 2026-07-28: process env,
    // ~/.claude/.env, settings.json env block), and the fallback conflated two
    // different identifiers -- a Claude Code session id is NOT a Braintrust
    // span id, so the "fallback" posted feedback against a non-existent span.
    // The real span state is written by braintrust_hooks.py; read that.
    return resolveBraintrustSpanId(payloadSessionId || '');
}

export interface SkillTriggerEmitInput {
    sessionId: string | undefined;
    skillName: string;
    triggerSource: 'hook' | 'explicit' | 'llm';
    success: boolean;
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

/**
 * Pure helper that derives the emit payload for skill_trigger_accuracy.
 * Returns null when there is no spanId available (helper would skip).
 * Exported for unit testing -- main() wires this to emitBraintrustScore.
 */
export function buildSkillTriggerScorePayload(
    input: SkillTriggerEmitInput,
): { spanId: string; scores: Record<string, number>; metadata: Record<string, unknown> } | null {
    const spanId = resolveScoreSpanId(input.sessionId);
    if (!spanId) return null;
    return {
        spanId,
        scores: {
            skill_trigger_accuracy: input.success ? 1.0 : 0.0,
        },
        metadata: {
            skill_name: input.skillName,
            trigger_source: input.triggerSource,
            hook: 'telemetry-tracker',
        },
    };
}

async function main() {
    try {
        const input = readFileSync(0, 'utf-8');
        const data: HookInput = JSON.parse(input);

        if (data.tool_name === 'Skill') {
            const skillName = data.tool_input?.skill as string || 'unknown';
            // Gate B2: use detectToolError (mirrors Python _detect_tool_error
            // at braintrust_hooks.py:422-449 + adds status==='error' for
            // backward compat). The original `status !== 'error'` check missed
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

            // Phase 3a: emit skill_trigger_accuracy score. Fire-and-forget --
            // the helper has a 2s timeout and swallows errors. Awaiting would
            // add up to 2s of latency to every Skill PostToolUse.
            try {
                const payload = buildSkillTriggerScorePayload({
                    sessionId: data.session_id,
                    skillName,
                    triggerSource: determineSource(data.tool_input),
                    success,
                });
                if (payload) {
                    await emitBraintrustScore(payload); // eslint-disable-line @typescript-eslint/no-floating-promises
                }
            } catch {
                /* fail-open: never let score emission break the hook */
            }
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

        // Deliberately NO process.exit(0) here.
        //
        // This hook reads stdin with readFileSync(0) and, since the Braintrust
        // emit above started doing real network I/O, also has async handles in
        // flight when main() returns. Calling process.exit() in that state tore
        // libuv down mid-teardown, deterministically (4/4):
        //
        //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
        //   file src\win\async.c, line 76        -> exit 0xC0000409
        //
        // It was invisible until 2026-07-28 only because the emit was disabled
        // and never opened a socket, so there was nothing in flight to race.
        // Draining the response body was tried first and did NOT fix it -- the
        // exit call itself is the problem.
        //
        // memory-awareness and hook-health-monitor both emit scores and
        // neither crashes; neither calls process.exit either.
        // Letting the loop drain naturally is the shape that works. The emit is
        // bounded by a 2s AbortSignal timeout, so this cannot hang on the POST.
    } catch {
        /* fail-open: never let telemetry break the tool call */
    }
}

if (!process.env.VITEST) {
    main();
}
