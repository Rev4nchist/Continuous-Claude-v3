#!/usr/bin/env node
/**
 * Ralph Delegation Enforcer Hook
 *
 * Logs activity and updates heartbeat when Ralph mode is active.
 * Does NOT block Edit/Write/Bash tools.
 *
 * Runs on PreToolUse:Edit, PreToolUse:Write, PreToolUse:Bash
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { cleanupOldStateFiles } from './shared/session-isolation.js';
import { createLogger } from './shared/logger.js';
import { isRalphActive } from './shared/state-schema.js';
import { logHook } from './shared/session-activity.js';
import { isCodeFile, isAllowedConfigFile } from './shared/file-classification.js';

const log = createLogger('ralph-delegation-enforcer');

interface HookInput {
  session_id?: string;
  tool_name: string;
  tool_input: {
    file_path?: string;
    command?: string;
    content?: string;
  };
}

// Use session-specific state files to prevent cross-terminal collision
const STATE_BASE_NAME = 'ralph-state';

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

function makeAllowOutput(): void {
  console.log(JSON.stringify({}));
}

// Kept for future use if strict per-context blocking is added back.
// Gate on CLAUDE_AGENT_ID absence (orchestrator) vs presence (agent context)
// once Claude Code surfaces that env var reliably.
function isTestCommand(command: string): boolean {
  const testPatterns = [
    /\bnpm\s+(run\s+)?test/i,
    /\byarn\s+test/i,
    /\bpnpm\s+test/i,
    /\bpytest\b/i,
    /\bgo\s+test\b/i,
    /\bcargo\s+test\b/i,
    /\bjest\b/i,
    /\bvitest\b/i,
    /\bmocha\b/i,
    /\bnpm\s+run\s+lint/i,
    /\bnpm\s+run\s+typecheck/i,
    /\btsc\s+--noEmit/i,
    /\bruff\s+check/i,
    /\bmypy\b/i,
    /\bgolangci-lint/i
  ];
  return testPatterns.some(p => p.test(command));
}

async function main() {
  // SOFT ENFORCEMENT (2026-04-23): Ralph-delegation-enforcer logs activity
  // but does NOT block tools. The hook cannot distinguish orchestrator from
  // sub-agents using the same session_id, so blocking caused broad collateral
  // damage (agents blocked from code edits, tests blocked, workarounds via
  // heredoc). Enforcement of "Ralph orchestrates, agents implement" is now
  // convention-only - maintained by prompts + CLAUDE.md, not by this hook.
  // If strict blocking is needed later, gate it on CLAUDE_AGENT_ID being
  // absent (orchestrator context) vs present (agent context) - once Claude
  // Code surfaces that env var reliably.

  try {
    // Periodic cleanup of old state files (1 in 100 calls)
    if (Math.random() < 0.01) {
      cleanupOldStateFiles(STATE_BASE_NAME);
    }

    const rawInput = readStdin();
    if (!rawInput.trim()) {
      makeAllowOutput();
      return;
    }

    let input: HookInput;
    try {
      input = JSON.parse(rawInput);
    } catch {
      makeAllowOutput();
      return;
    }

    const sessionId = input.session_id;
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

    // Check unified state first, then legacy
    const ralphStatus = isRalphActive(projectDir);

    if (!ralphStatus.active) {
      makeAllowOutput();
      return;
    }

    const storyId = ralphStatus.storyId;

    // Update heartbeat - unified state uses ralph-state-v2.py, legacy uses temp file
    // Debounce: only spawn if state.json mtime is older than 5 minutes
    if (ralphStatus.source === 'unified') {
      try {
        const statePath = join(projectDir, '.ralph', 'state.json');
        const stMtime = existsSync(statePath) ? statSync(statePath).mtimeMs : 0;
        const HEARTBEAT_INTERVAL = 5 * 60 * 1000; // 5 minutes
        if (Date.now() - stMtime > HEARTBEAT_INTERVAL) {
          const homeDir = process.env.HOME || process.env.USERPROFILE || '';
          const v2Script = join(homeDir, '.claude', 'scripts', 'ralph', 'ralph-state-v2.py');
          if (existsSync(v2Script)) {
            spawnSync('python', [v2Script, '-p', projectDir, 'session-heartbeat'], {
              encoding: 'utf-8',
              timeout: 3000,
            });
          }
        }
      } catch { /* ignore heartbeat failures */ }
    }

    log.info(`Ralph active (soft-enforce, allow): tool=${input.tool_name}`, { storyId, sessionId, source: ralphStatus.source });
    try { logHook(sessionId || '', 'ralph-delegation-enforcer'); } catch { /* never break */ }

    // Always allow - soft enforcement only
    makeAllowOutput();

  } catch (err) {
    // Fail open
    makeAllowOutput();
  }
}

if ((process.argv[1] || '').includes('ralph-delegation-enforcer')) {
  main();
}
