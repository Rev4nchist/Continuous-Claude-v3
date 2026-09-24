#!/usr/bin/env node
/**
 * Epistemic Reminder Hook - PostToolUse (Grep|Read)
 *
 * After Grep or Read results, reminds the user about claim verification.
 * Per ~/.claude/CLAUDE.md ("Done means proven") - prevents false claims
 * based on pattern matching without reading actual file content.
 */

import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: {
    content?: string;
    files?: string[];
  };
}

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
  };
}

async function main(): Promise<void> {
  let input: HookInput = {};

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  try {
    const rawInput = Buffer.concat(chunks).toString('utf-8').trim();
    if (rawInput) {
      input = JSON.parse(rawInput);
    }
  } catch {
    console.log('{}');
    return;
  }

  const tool = input.tool_name;

  // Only add reminder for Grep results (Read results are more reliable)
  if (tool !== 'Grep') {
    console.log('{}');
    return;
  }

  // Once per session. It used to repeat the same ~500 characters after EVERY Grep (dozens
  // of times in a long session) while the rule it points to is already loaded
  // (2026-09-23 eval, P22). Without a session id, keep the old behavior.
  const sid = (input.session_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (sid) {
    const flag = join(tmpdir(), `claude-epistemic-reminder-${sid}.flag`);
    try {
      // 'wx' = create only if absent, atomically: two concurrent Greps cannot both win.
      writeFileSync(flag, '', { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        console.log('{}');
        return;
      }
      // Any other write error: show the reminder (the old behavior) rather than lose it.
    }
  }

  const reminder = `
⚠️ EPISTEMIC REMINDER: Grep results show pattern matches, NOT verified facts.

Before making claims based on this search:
1. ✓ VERIFIED claims require: Reading the file, tracing the logic
2. ? INFERRED claims: Based on pattern match - must verify before asserting
3. ✗ UNCERTAIN: Haven't checked - must investigate

Common false patterns:
- grep found "try.*catch" ≠ "file has error handling" (might be in comments)
- grep returned nothing ≠ "feature doesn't exist" (might use different naming)
- Found function name ≠ "system does X" (must trace the implementation)
`;

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: reminder,
    },
  };

  console.log(JSON.stringify(output));
}

main().catch(() => {
  console.log('{}');
});
