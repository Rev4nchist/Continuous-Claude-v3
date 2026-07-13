// src/session-outcome.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}
function needsHandoffReminder(outcome) {
  if (!outcome || typeof outcome !== "string") return false;
  return outcome === "PARTIAL_PLUS" || outcome === "PARTIAL_MINUS";
}
function buildOutcomeMessage(sessionName, handoffName, outcome) {
  let msg = `

\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
Session ended: ${sessionName}
Latest handoff: ${handoffName}

Record the outcome in the handoff's YAML frontmatter (outcome: SUCCEEDED |
PARTIAL_PLUS | PARTIAL_MINUS | FAILED), then index it so recall surfaces it:

  cd opc && uv run python scripts/core/index_handoffs.py --apply \\
    --only-path thoughts/shared/handoffs/${sessionName}/<this-handoff>.yaml

index_handoffs.py is idempotent (re-runs insert nothing new) and writes to
archival_memory \u2014 the canonical recall path. Do NOT use artifact_mark.py:
the SQL handoffs table it targets is deprecated/unpopulated.

Outcome meanings:
  SUCCEEDED      - Task completed successfully
  PARTIAL_PLUS   - Mostly done, minor issues remain
  PARTIAL_MINUS  - Some progress, major issues remain
  FAILED         - Task abandoned or blocked
\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
`;
  if (needsHandoffReminder(outcome)) {
    msg += `
HANDOFF REMINDER: This session has a partial outcome (${outcome}).
Create a handoff document to preserve context for the next session:

  Use /create_handoff to generate a structured handoff with:
  - What was completed
  - What remains
  - Blockers encountered
  - Resumption instructions

Location: thoughts/shared/handoffs/${sessionName}/
\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
`;
  }
  return msg;
}
async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    console.log(JSON.stringify({}));
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (input.reason === "other") {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const dbPath = path.join(projectDir, ".claude", "cache", "artifact-index", "context.db");
  const dbExists = fs.existsSync(dbPath);
  if (!dbExists) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const ledgerDir = path.join(projectDir, "thoughts", "ledgers");
  let ledgerFiles;
  try {
    ledgerFiles = fs.readdirSync(ledgerDir).filter((f) => f.startsWith("CONTINUITY_CLAUDE-") && f.endsWith(".md")).sort((a, b) => {
      const statA = fs.statSync(path.join(ledgerDir, a));
      const statB = fs.statSync(path.join(ledgerDir, b));
      return statB.mtime.getTime() - statA.mtime.getTime();
    });
  } catch {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (ledgerFiles.length === 0) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const sessionName = ledgerFiles[0].replace("CONTINUITY_CLAUDE-", "").replace(".md", "");
  const handoffDir = path.join(projectDir, "thoughts", "shared", "handoffs", sessionName);
  if (!fs.existsSync(handoffDir)) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const handoffFiles = fs.readdirSync(handoffDir).filter((f) => f.endsWith(".md") && /^\d{4}-\d{2}-\d{2}_/.test(f)).sort((a, b) => {
    return b.localeCompare(a);
  });
  if (handoffFiles.length === 0) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const latestHandoff = handoffFiles[0];
  const handoffName = latestHandoff.replace(".md", "");
  const sessionId = input.session_id || "default";
  const outcomeFile = path.join(os.tmpdir(), `claude-session-outcome-${sessionId}.json`);
  let outcome = "PARTIAL_PLUS";
  try {
    const data = JSON.parse(fs.readFileSync(outcomeFile, "utf-8"));
    if (data.outcome) outcome = data.outcome;
  } catch {
  }
  const output = {
    result: "continue",
    message: buildOutcomeMessage(sessionName, handoffName, outcome)
  };
  console.log(JSON.stringify(output));
}
if (!process.env.VITEST) {
  main().catch(() => {
    console.log(JSON.stringify({}));
  });
}
export {
  buildOutcomeMessage,
  needsHandoffReminder
};
