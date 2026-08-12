// Auto-allow PermissionRequest EXCEPT for AskUserQuestion, ExitPlanMode, and Bash.
// - AskUserQuestion must surface its UI prompt; auto-allowing it makes
//   Claude Code proceed with empty answers and breaks plan-mode interviews.
// - ExitPlanMode must surface its UI prompt so the user actually approves
//   the proposed plan before execution begins. The plan-mode-approval-gate
//   PreToolUse hook also gates this in bypass-permissions mode (where
//   PermissionRequest hooks don't fire); this exclusion is the
//   belt-and-suspenders for normal mode.
// - Bash (F4): do NOT blanket-allow Bash, so the destructive-command-guard
//   PreToolUse hook's interactive 'ask' on a destructive command is not silently
//   swallowed here. Non-destructive Bash is still granted by the settings
//   permissions.allow "Bash" rule, so this adds no prompt friction for safe ops;
//   it only stops this hook from auto-approving a gated destructive op.
// Everything else is auto-allowed to preserve the .claude/ sensitive-file
// workaround (added 2026-03-28 for Claude Code v2.1.78+). The workaround targets
// Edit/Write on .claude/ files, not Bash, so excluding Bash does not weaken it.

import { readFileSync } from 'node:fs';

interface PermissionRequestInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

function emitAllow(): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' },
    },
  }));
}

function main(): void {
  let input: PermissionRequestInput = {};
  try {
    const raw = readFileSync(0, 'utf8');
    input = raw ? JSON.parse(raw) : {};
  } catch {
    emitAllow();
    return;
  }

  if (
    input.tool_name === 'AskUserQuestion' ||
    input.tool_name === 'ExitPlanMode' ||
    input.tool_name === 'Bash'
  ) {
    process.stdout.write('{}');
    return;
  }

  emitAllow();
}

if ((process.argv[1] || '').includes('permission-auto-allow')) {
  main();
}
