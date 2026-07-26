import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/react-perf-context.ts
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
function readStdin() {
  return readFileSync(0, "utf-8");
}
function loadSkillSummary() {
  const skillPath = join(homedir(), ".claude", "skills", "react-perf", "SKILL.md");
  if (!existsSync(skillPath)) return null;
  return `
<react-perf-context>
## React Performance Reminder

You are reading a .tsx file. Consider these Vercel best practices:

**CRITICAL** (Block if found):
- Waterfalls: Sequential awaits \u2192 Use Promise.all for parallel
- Bundle: Full package imports \u2192 Use direct imports (lodash/debounce)

**HIGH** (Flag for review):
- Server: Missing cache() wrapper on data fetches
- Client: Missing deduplication (SWR/React Query)

**MEDIUM** (Consider):
- Re-renders: Inline callbacks \u2192 useCallback
- Missing memo on expensive components

For full rules: \`/react-perf\` or \`~/.claude/skills/react-perf/SKILL.md\`
</react-perf-context>
`;
}
async function main() {
  const input = JSON.parse(readStdin());
  let filePath = input.tool_input?.file_path;
  if (filePath) {
    filePath = filePath.replace(/\\/g, "/");
  }
  if (!filePath || !filePath.endsWith(".tsx")) {
    console.log("{}");
    return;
  }
  if (filePath.includes("node_modules") || filePath.includes("/dist/")) {
    console.log("{}");
    return;
  }
  const summary = loadSkillSummary();
  if (!summary) {
    console.log("{}");
    return;
  }
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: summary
    }
  }));
}
main().catch(() => process.exit(1));
