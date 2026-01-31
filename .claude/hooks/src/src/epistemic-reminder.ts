#!/usr/bin/env node
/**
 * Epistemic Reminder Hook - PostToolUse (Grep|Read)
 *
 * After Grep or Read results, reminds the user about claim verification.
 * Per ~/.claude/rules/claim-verification.md - prevents false claims
 * based on pattern matching without reading actual file content.
 */

interface HookInput {
  tool?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: {
    content?: string;
    files?: string[];
  };
}

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    systemPromptSuffix?: string;
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

  const tool = input.tool;

  // Only add reminder for Grep results (Read results are more reliable)
  if (tool !== 'Grep') {
    console.log('{}');
    return;
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
      systemPromptSuffix: reminder,
    },
  };

  console.log(JSON.stringify(output));
}

main().catch(() => {
  console.log('{}');
});
