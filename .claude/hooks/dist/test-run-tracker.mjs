#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/test-run-tracker.ts
import * as fs from "fs";

// src/shared/test-run-state.ts
import * as os from "os";
import * as path from "path";
function getStateFile(sessionId) {
  if (!sessionId) return null;
  const safe = sessionId.replace(/[^a-zA-Z0-9-_]/g, "_");
  return path.join(os.tmpdir(), `claude-recent-test-runs-${safe}.json`);
}

// src/shared/done-proof.ts
var MIN = 6e4;
var PROOF_WINDOW_MS = 5 * MIN;
var FAILURE_WINDOW_MS = 30 * MIN;
var RATCHETS = [/\bcontext-budget-guard\b/, /\baudit-skills\b/];
function isRatchet(command) {
  return !!command && RATCHETS.some((re) => re.test(command));
}

// src/shared/mask-quotes.ts
var BASH_STRING = /"(?:[^"\\]|\\[\s\S])*"|'[^']*'/g;
var PWSH_STRING = /"(?:[^"`]|`[\s\S])*"|'(?:[^']|'')*'/g;
var blank = (s) => s[0] + " ".repeat(s.length - 2) + s[s.length - 1];
function maskQuoted(command, tool = "Bash") {
  return command.replace(tool === "PowerShell" ? PWSH_STRING : BASH_STRING, blank);
}

// src/shared/tool-error.ts
function exitCodeOf(resp) {
  if (resp && typeof resp === "object") {
    const o = resp;
    for (const k of ["exit_code", "exitCode", "code", "status"]) {
      if (typeof o[k] === "number") return o[k];
    }
    if (o.is_error === true) return -1;
  }
  return null;
}

// src/test-run-tracker.ts
var COMMAND_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
function nodeScript(name) {
  const flag = String.raw`\s+(?!--check\b|-c\b)--?[\w-]+(?:=\S+)?`;
  const dir = String.raw`["']?(?:[^\s"']*[\\/])?`;
  const notPlan = String.raw`(?![^\n]*--(?:dry-run|help)\b)`;
  const start = String.raw`(?:^|[;&|(]\s*|\n\s*)(?:&\s+)?`;
  return new RegExp(String.raw`${start}node(?:\.exe)?(?:${flag})*\s+${dir}${name}\.mjs\b${notPlan}`);
}
var CMD_START = String.raw`(?:^\s*|[;&|(]\s*|\n\s*)(?:&\s+)?(?:\w+=\S*\s+)*`;
var LAUNCHERS = String.raw`(?:(?:npx|pnpx|bunx)(?:\.cmd)?(?:\s+--?[\w-]+(?:=\S+)?)*\s+|(?:pnpm|yarn|npm)(?:\.cmd)?\s+(?:exec\s+|dlx\s+)?|(?:uv|poetry|pipenv|pdm)\s+run\s+|python3?(?:\.exe)?\s+-m\s+|py\s+-m\s+|cross-env\s+(?:\w+=\S*\s+)*)*`;
var TOOL_PATH = String.raw`(?:[^\s"';&|()]*[\\/])?`;
var atCommand = (body) => new RegExp(CMD_START + body);
var TOOL_PATTERNS = [
  atCommand(`${LAUNCHERS}${TOOL_PATH}(?:vitest|jest|pytest|mocha)(?:\\.cmd|\\.exe)?\\b`),
  atCommand(String.raw`(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:run\s+)?test\b`),
  atCommand(String.raw`cargo\s+test\b`),
  atCommand(String.raw`go\s+test\b`),
  atCommand(String.raw`make\s+test\b`)
];
var NODE_PATTERNS = [
  nodeScript("[\\w.-]+-probe"),
  nodeScript("audit-skills"),
  nodeScript("context-budget-guard"),
  nodeScript("verify")
];
var TEST_PATTERNS = [...TOOL_PATTERNS, ...NODE_PATTERNS];
function isTestCommand(command, tool = "Bash") {
  if (NODE_PATTERNS.some((p) => p.test(command))) return true;
  const masked = maskQuoted(command, tool);
  return TOOL_PATTERNS.some((p) => p.test(masked));
}
function okOf(data) {
  if (data.hook_event_name === "PostToolUseFailure") return false;
  const code = exitCodeOf(data.tool_response);
  if (code !== null) return code === 0;
  return data.hook_event_name === "PostToolUse" ? true : null;
}
function keepsEarlierRun(stateFile, command) {
  if (!isRatchet(command)) return false;
  try {
    const prev = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return typeof prev?.lastTestRun === "number" && typeof prev?.command === "string" && !isRatchet(prev.command);
  } catch {
    return false;
  }
}
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}
async function main() {
  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({}));
    return;
  }
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({}));
    return;
  }
  if (!COMMAND_TOOLS.has(data.tool_name)) {
    console.log(JSON.stringify({}));
    return;
  }
  const command = data.tool_input?.command || "";
  if (isTestCommand(command, data.tool_name) && data.tool_input?.run_in_background !== true) {
    const stateFile = getStateFile(data.session_id);
    if (!stateFile) {
      console.log(JSON.stringify({}));
      return;
    }
    if (keepsEarlierRun(stateFile, command)) {
      console.log(JSON.stringify({}));
      return;
    }
    try {
      fs.writeFileSync(
        stateFile,
        JSON.stringify({ lastTestRun: Date.now(), command, ok: okOf(data) })
      );
    } catch {
    }
  }
  console.log(JSON.stringify({}));
}
if (!process.env.VITEST) {
  main().catch(() => {
    console.log(JSON.stringify({}));
  });
}
export {
  TEST_PATTERNS,
  getStateFile,
  isTestCommand,
  main,
  okOf
};
