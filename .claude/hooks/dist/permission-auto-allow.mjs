import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/permission-auto-allow.ts
import { readFileSync } from "node:fs";
function emitAllow() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" }
    }
  }));
}
function main() {
  let input = {};
  try {
    const raw = readFileSync(0, "utf8");
    input = raw ? JSON.parse(raw) : {};
  } catch {
    emitAllow();
    return;
  }
  if (input.tool_name === "AskUserQuestion" || input.tool_name === "ExitPlanMode" || input.tool_name === "Bash") {
    process.stdout.write("{}");
    return;
  }
  emitAllow();
}
main();
