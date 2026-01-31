/**
 * React Performance Context Hook (PostToolUse: Read)
 *
 * Auto-injects react-perf skill context after reading .tsx files.
 * Ensures React performance rules are considered during component development.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface HookInput {
  session_id: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: {
    file_path?: string;
  };
}

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

function loadSkillSummary(): string | null {
  const skillPath = join(homedir(), '.claude', 'skills', 'react-perf', 'SKILL.md');

  if (!existsSync(skillPath)) return null;

  return `
<react-perf-context>
## React Performance Reminder

You are reading a .tsx file. Consider these Vercel best practices:

**CRITICAL** (Block if found):
- Waterfalls: Sequential awaits → Use Promise.all for parallel
- Bundle: Full package imports → Use direct imports (lodash/debounce)

**HIGH** (Flag for review):
- Server: Missing cache() wrapper on data fetches
- Client: Missing deduplication (SWR/React Query)

**MEDIUM** (Consider):
- Re-renders: Inline callbacks → useCallback
- Missing memo on expensive components

For full rules: \`/react-perf\` or \`~/.claude/skills/react-perf/SKILL.md\`
</react-perf-context>
`;
}

async function main() {
  const input: HookInput = JSON.parse(readStdin());
  let filePath = input.tool_input?.file_path;

  // Normalize Windows paths to forward slashes
  if (filePath) {
    filePath = filePath.replace(/\\/g, '/');
  }

  // Only trigger for .tsx files
  if (!filePath || !filePath.endsWith('.tsx')) {
    console.log('{}');
    return;
  }

  // Skip if it's in node_modules or dist
  if (filePath.includes('node_modules') || filePath.includes('/dist/')) {
    console.log('{}');
    return;
  }

  const summary = loadSkillSummary();
  if (!summary) {
    console.log('{}');
    return;
  }

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: summary
    }
  }));
}

main().catch(() => process.exit(1));
