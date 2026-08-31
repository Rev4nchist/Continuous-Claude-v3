#!/usr/bin/env node
/**
 * context-pct-warning -- UserPromptSubmit hook.
 *
 * Reads the context-percentage state file written by the statusline
 * ($TEMP/claude-context-pct-<sessionId8>.txt) and injects an escalating
 * handoff warning at 70/80/90%.
 *
 * PROVENANCE: this source was reconstructed 2026-08-31 (harness-security lane)
 * from the live compiled bundle ~/.claude/hooks/dist/context-pct-warning.mjs,
 * which had run registered for months with no committed source anywhere
 * (registration-reconcile finding: no-committed-code). The original bundle is
 * archived at docs/harness-strategy/artifacts/2026-08-31-live-dist/. Behavior
 * is verified equivalent by stdin/stdout/exit-code diff against that bundle.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { outputContinue, outputWithMessage } from './shared/output.js';

function main(): void {
  try {
    const input = readFileSync(0, 'utf-8');
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(input);
    } catch {
      outputContinue();
      return;
    }
    const rawSessionId =
      (data.session_id as string) ||
      process.env.CLAUDE_SESSION_ID ||
      process.env.CLAUDE_PPID ||
      'default';
    const sessionId = rawSessionId.slice(0, 8);
    const contextFile = join(tmpdir(), `claude-context-pct-${sessionId}.txt`);
    if (existsSync(contextFile)) {
      const pct = parseInt(readFileSync(contextFile, 'utf-8').trim(), 10);
      if (!Number.isNaN(pct)) {
        if (pct >= 90) {
          outputWithMessage(
            'CONTEXT CRITICAL: ' + pct + '%\nRun /create_handoff NOW before auto-compact!',
            'UserPromptSubmit',
          );
          return;
        }
        if (pct >= 80) {
          outputWithMessage(
            'CONTEXT WARNING: ' + pct + '%\nRecommend: /create_handoff then /clear soon',
            'UserPromptSubmit',
          );
          return;
        }
        if (pct >= 70) {
          outputWithMessage(
            'Context at ' + pct + '%. Consider handoff when you reach a stopping point.',
            'UserPromptSubmit',
          );
          return;
        }
      }
    }
    outputContinue();
  } catch {
    outputContinue();
  }
}

main();
