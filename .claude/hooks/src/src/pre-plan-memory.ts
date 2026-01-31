#!/usr/bin/env node
/**
 * Pre-Plan Memory Hook
 *
 * Fires on PreToolUse for EnterPlanMode to recall relevant past planning
 * decisions from archival_memory and inject them as additional context.
 *
 * Hook: PreToolUse (EnterPlanMode)
 * Output: Injects relevant past ARCHITECTURAL_DECISION learnings
 */

import { execSync } from 'child_process';
import * as path from 'path';

interface PreToolUseInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface HookOutput {
  decision: 'allow' | 'block';
  message?: string;
  hookSpecificOutput?: {
    additionalContext?: string;
  };
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 1000);
  });
}

function output(obj: HookOutput): void {
  console.log(JSON.stringify(obj));
}

async function main() {
  const stdin = await readStdin();
  if (!stdin.trim()) {
    output({ decision: 'allow' });
    return;
  }

  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin);
  } catch {
    output({ decision: 'allow' });
    return;
  }

  if (input.tool_name !== 'EnterPlanMode') {
    output({ decision: 'allow' });
    return;
  }

  const opcDir = process.env.CLAUDE_OPC_DIR ||
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude');

  try {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows
      ? `cd /d "${opcDir}" && set PYTHONPATH=. && uv run python scripts/core/recall_learnings.py ` +
        `--query "planning architecture decisions approach design" --k 5 --text-only`
      : `cd "${opcDir}" && PYTHONPATH=. uv run python scripts/core/recall_learnings.py ` +
        `--query "planning architecture decisions approach design" --k 5 --text-only`;

    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWindows ? 'cmd.exe' : true
    });

    if (result && !result.includes('No results') && result.trim().length > 20) {
      const truncated = result.substring(0, 1500);
      console.error('🧠 Found relevant past planning context');
      output({
        decision: 'allow',
        message: '🧠 Relevant past planning found',
        hookSpecificOutput: {
          additionalContext: `## Prior Planning Context\n\nThe following past planning decisions may be relevant:\n\n${truncated}`
        }
      });
      return;
    }
  } catch (e) {
    const err = e as Error;
    console.error(`Pre-plan memory recall failed: ${err.message}`);
  }

  output({ decision: 'allow' });
}

main().catch(() => output({ decision: 'allow' }));
