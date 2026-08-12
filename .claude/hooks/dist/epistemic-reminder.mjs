#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/epistemic-reminder.ts
async function main() {
  let input = {};
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  try {
    const rawInput = Buffer.concat(chunks).toString("utf-8").trim();
    if (rawInput) {
      input = JSON.parse(rawInput);
    }
  } catch {
    console.log("{}");
    return;
  }
  const tool = input.tool_name;
  if (tool !== "Grep") {
    console.log("{}");
    return;
  }
  const reminder = `
\u26A0\uFE0F EPISTEMIC REMINDER: Grep results show pattern matches, NOT verified facts.

Before making claims based on this search:
1. \u2713 VERIFIED claims require: Reading the file, tracing the logic
2. ? INFERRED claims: Based on pattern match - must verify before asserting
3. \u2717 UNCERTAIN: Haven't checked - must investigate

Common false patterns:
- grep found "try.*catch" \u2260 "file has error handling" (might be in comments)
- grep returned nothing \u2260 "feature doesn't exist" (might use different naming)
- Found function name \u2260 "system does X" (must trace the implementation)
`;
  const output = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: reminder
    }
  };
  console.log(JSON.stringify(output));
}
main().catch(() => {
  console.log("{}");
});
