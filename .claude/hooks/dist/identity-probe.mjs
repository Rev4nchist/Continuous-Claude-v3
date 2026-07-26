// src/identity-probe.ts
import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { execFileSync } from "child_process";
var ENV_INHERITED_MARKERS = [
  "CC_TERMINAL_ID",
  // the one we actually care about (may be unset)
  "CLAUDE_AGENT_ID",
  // set by Claude Code for subagents
  "CLAUDE_PROJECT_DIR",
  "COORDINATION_SESSION_ID",
  "CLAUDE_OPC_DIR",
  // exported by the user profile -> proxy for Q2
  "DATABASE_URL",
  // exported by the user profile -> proxy for Q2
  "BRAINTRUST_SPAN_ID"
];
function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}
function gitCommonRoot(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf-8",
      timeout: 2e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return out ? out.replace(/\\/g, "/").replace(/\/\.git$/, "") : null;
  } catch {
    return null;
  }
}
function canonicalProjectKey(cwd) {
  const root = gitCommonRoot(cwd);
  return root ? root.toLowerCase() : null;
}
function main() {
  let payload = {};
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    payload = {};
  }
  const cwd = payload.cwd || process.cwd();
  const env = {};
  for (const k of ENV_INHERITED_MARKERS) {
    env[k] = process.env[k] ?? null;
  }
  const row = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    event: payload.hook_event_name ?? null,
    // Q1 — the id the platform hands us. Compare across main session vs subagents.
    payload_session_id: payload.session_id ?? null,
    // What the CURRENT (broken) code would use instead, for side-by-side contrast.
    legacy_env_session_id: process.env.COORDINATION_SESSION_ID ?? null,
    // Q2 — env inheritance reaching this process.
    env,
    // Q3 — project identity, old vs proposed.
    project_legacy: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    project_canonical: canonicalProjectKey(cwd),
    cwd,
    // Process tree — lets us tell a subagent's hook from the main session's.
    pid: process.pid,
    ppid: process.ppid,
    tool: payload.tool_name ?? null
  };
  try {
    const logRoot = gitCommonRoot(cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const logPath = join(logRoot, ".claude", "logs", "identity-probe.jsonl");
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(row) + "\n", "utf-8");
  } catch {
  }
}
try {
  main();
} catch {
}
process.exit(0);
