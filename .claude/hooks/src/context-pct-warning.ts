#!/usr/bin/env node
/**
 * context-pct-warning — tiered context-usage nudges on UserPromptSubmit.
 *
 * Extracted verbatim from the retired skill-activation-prompt hook (2026-08-19,
 * docs/self-improvement/audits/2026-08-19-skill-router-decision.md) so the one
 * feature worth keeping survives without the skill-matching false-fire engine.
 *
 * Reads the statusline's temp file (written by .claude/scripts/status.py):
 *   $TMP/claude-context-pct-<first 8 chars of session_id>.txt
 * and injects a handoff nudge at 70/80/90%. Fail-open: any error is a silent
 * continue — a warning hook must never break prompt submission.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { outputContinue, outputWithMessage } from './shared/output.js';

interface HookInput {
    session_id?: string;
}

function main(): void {
    try {
        const input = readFileSync(0, 'utf-8');
        let data: HookInput;
        try {
            data = JSON.parse(input);
        } catch {
            outputContinue();
            return;
        }

        // CLAUDE_PPID kept for backwards compatibility with the bash wrapper,
        // same fallback chain the original hook used.
        const rawSessionId = data.session_id || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_PPID || 'default';
        const sessionId = rawSessionId.slice(0, 8); // Match status.py truncation
        const contextFile = join(tmpdir(), `claude-context-pct-${sessionId}.txt`);

        if (existsSync(contextFile)) {
            const pct = parseInt(readFileSync(contextFile, 'utf-8').trim(), 10);
            if (!Number.isNaN(pct)) {
                if (pct >= 90) {
                    outputWithMessage('CONTEXT CRITICAL: ' + pct + '%\nRun /create_handoff NOW before auto-compact!', 'UserPromptSubmit');
                    return;
                }
                if (pct >= 80) {
                    outputWithMessage('CONTEXT WARNING: ' + pct + '%\nRecommend: /create_handoff then /clear soon', 'UserPromptSubmit');
                    return;
                }
                if (pct >= 70) {
                    outputWithMessage('Context at ' + pct + '%. Consider handoff when you reach a stopping point.', 'UserPromptSubmit');
                    return;
                }
            }
        }

        outputContinue();
    } catch {
        // Fail-open — never block a prompt over a missing/corrupt temp file.
        outputContinue();
    }
}

main();
