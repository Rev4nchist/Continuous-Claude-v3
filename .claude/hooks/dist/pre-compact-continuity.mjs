import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/pre-compact-continuity.ts
import * as fs2 from "fs";
import * as path from "path";

// src/transcript-parser.ts
import * as fs from "fs";
function parseTranscript(transcriptPath) {
  const summary = {
    lastTodos: [],
    recentToolCalls: [],
    lastAssistantMessage: "",
    filesModified: [],
    errorsEncountered: []
  };
  if (!fs.existsSync(transcriptPath)) {
    return summary;
  }
  const content = fs.readFileSync(transcriptPath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim());
  const allToolCalls = [];
  const modifiedFiles = /* @__PURE__ */ new Set();
  const errors = [];
  let lastTodoState = [];
  let lastAssistant = "";
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.role === "assistant" && typeof entry.content === "string") {
        lastAssistant = entry.content;
      } else if (entry.type === "assistant" && typeof entry.content === "string") {
        lastAssistant = entry.content;
      }
      if (entry.tool_name || entry.type === "tool_use") {
        const toolName = entry.tool_name || entry.name;
        if (toolName) {
          const toolCall = {
            name: toolName,
            timestamp: entry.timestamp,
            input: entry.tool_input,
            success: true
            // Will be updated by result
          };
          if (toolName === "TodoWrite" || toolName.toLowerCase().includes("todowrite")) {
            const input = entry.tool_input;
            if (input?.todos) {
              lastTodoState = input.todos.map((t, idx) => ({
                id: t.id || `todo-${idx}`,
                content: t.content || "",
                status: t.status || "pending"
              }));
            }
          }
          if (toolName === "Edit" || toolName === "Write" || toolName.toLowerCase().includes("edit") || toolName.toLowerCase().includes("write")) {
            const input = entry.tool_input;
            const filePath = input?.file_path || input?.path;
            if (filePath && typeof filePath === "string") {
              modifiedFiles.add(filePath);
            }
          }
          if (toolName === "Bash" || toolName.toLowerCase().includes("bash")) {
            const input = entry.tool_input;
            if (input?.command) {
              toolCall.input = { command: input.command };
            }
          }
          allToolCalls.push(toolCall);
        }
      }
      if (entry.type === "tool_result" || entry.tool_result !== void 0) {
        const result = entry.tool_result;
        if (result) {
          const exitCode = result.exit_code ?? result.exitCode;
          if (exitCode !== void 0 && exitCode !== 0) {
            if (allToolCalls.length > 0) {
              allToolCalls[allToolCalls.length - 1].success = false;
            }
            const errorMsg = result.stderr || result.error || "Command failed";
            const lastTool = allToolCalls[allToolCalls.length - 1];
            const command = lastTool?.input?.command || "unknown command";
            errors.push(`${command}: ${errorMsg.substring(0, 200)}`);
          }
        }
        if (entry.error) {
          errors.push(entry.error.substring(0, 200));
          if (allToolCalls.length > 0) {
            allToolCalls[allToolCalls.length - 1].success = false;
          }
        }
      }
    } catch {
      continue;
    }
  }
  summary.lastTodos = lastTodoState;
  summary.recentToolCalls = allToolCalls.slice(-5);
  summary.lastAssistantMessage = lastAssistant.substring(0, 500);
  summary.filesModified = Array.from(modifiedFiles);
  summary.errorsEncountered = errors.slice(-5);
  return summary;
}
function generateAutoHandoff(summary, sessionName) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const dateOnly = timestamp.split("T")[0];
  const lines = [];
  const inProgress = summary.lastTodos.filter((t) => t.status === "in_progress");
  const pending = summary.lastTodos.filter((t) => t.status === "pending");
  const completed = summary.lastTodos.filter((t) => t.status === "completed");
  const currentTask = inProgress[0]?.content || pending[0]?.content || "Continue from auto-compact";
  const goalSummary = completed.length > 0 ? `Completed ${completed.length} task(s) before auto-compact` : "Session auto-compacted";
  lines.push("---");
  lines.push(`session: ${sessionName}`);
  lines.push(`date: ${dateOnly}`);
  lines.push("status: partial");
  lines.push("outcome: PARTIAL_PLUS");
  lines.push("---");
  lines.push("");
  lines.push(`goal: ${goalSummary}`);
  lines.push(`now: ${currentTask}`);
  lines.push("test: # No test command captured");
  lines.push("");
  lines.push("done_this_session:");
  if (completed.length > 0) {
    completed.forEach((t) => {
      lines.push(`  - task: "${t.content.replace(/"/g, '\\"')}"`);
      lines.push("    files: []");
    });
  } else {
    lines.push('  - task: "Session started"');
    lines.push("    files: []");
  }
  lines.push("");
  lines.push("blockers:");
  if (summary.errorsEncountered.length > 0) {
    summary.errorsEncountered.slice(0, 3).forEach((e) => {
      const safeError = e.replace(/"/g, '\\"').substring(0, 100);
      lines.push(`  - "${safeError}"`);
    });
  } else {
    lines.push("  []");
  }
  lines.push("");
  lines.push("questions:");
  if (pending.length > 0) {
    pending.slice(0, 3).forEach((t) => {
      lines.push(`  - "Resume: ${t.content.replace(/"/g, '\\"')}"`);
    });
  } else {
    lines.push("  []");
  }
  lines.push("");
  lines.push("decisions:");
  lines.push('  - auto_compact: "Context limit reached, auto-compacted"');
  lines.push("");
  lines.push("findings:");
  lines.push(`  - tool_calls: "${summary.recentToolCalls.length} recent tool calls"`);
  lines.push(`  - files_modified: "${summary.filesModified.length} files changed"`);
  lines.push("");
  lines.push("worked:");
  const successfulTools = summary.recentToolCalls.filter((t) => t.success);
  if (successfulTools.length > 0) {
    lines.push(`  - "${successfulTools.map((t) => t.name).join(", ")} completed successfully"`);
  } else {
    lines.push("  []");
  }
  lines.push("");
  lines.push("failed:");
  const failedTools = summary.recentToolCalls.filter((t) => !t.success);
  if (failedTools.length > 0) {
    lines.push(`  - "${failedTools.map((t) => t.name).join(", ")} encountered errors"`);
  } else {
    lines.push("  []");
  }
  lines.push("");
  lines.push("next:");
  if (inProgress.length > 0) {
    lines.push(`  - "Continue: ${inProgress[0].content.replace(/"/g, '\\"')}"`);
  }
  if (pending.length > 0) {
    pending.slice(0, 2).forEach((t) => {
      lines.push(`  - "${t.content.replace(/"/g, '\\"')}"`);
    });
  }
  if (inProgress.length === 0 && pending.length === 0) {
    lines.push('  - "Review session state and continue"');
  }
  lines.push("");
  lines.push("files:");
  lines.push("  created: []");
  lines.push("  modified:");
  if (summary.filesModified.length > 0) {
    summary.filesModified.slice(0, 10).forEach((f) => {
      lines.push(`    - "${f}"`);
    });
  } else {
    lines.push("    []");
  }
  return lines.join("\n");
}
var isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Usage: npx tsx transcript-parser.ts <transcript-path> [session-name]");
    process.exit(1);
  }
  const transcriptPath = args[0];
  const sessionName = args[1] || "test-session";
  console.log(`Parsing transcript: ${transcriptPath}`);
  const summary = parseTranscript(transcriptPath);
  console.log("\n--- Summary ---");
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n--- Auto-Handoff ---");
  console.log(generateAutoHandoff(summary, sessionName));
}

// src/shared/state-schema.ts
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "fs";
import { join as join2 } from "path";

// src/shared/logger.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync, statSync, renameSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
var LOG_FILE = process.env.CLAUDE_HOOK_LOG_FILE || join(homedir(), ".claude", "logs", "hooks.log");
var LOG_DIR = dirname(LOG_FILE);
var MAX_LOG_SIZE = 5 * 1024 * 1024;
var MIN_LEVEL = process.env.CLAUDE_HOOK_LOG_LEVEL || "info";
var LEVEL_ORDER = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
function shouldLog(level) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}
function ensureLogDir() {
  if (!existsSync2(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}
function rotateIfNeeded() {
  try {
    if (existsSync2(LOG_FILE)) {
      const stat = statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        const rotated = LOG_FILE + ".1";
        renameSync(LOG_FILE, rotated);
      }
    }
  } catch {
  }
}
function getSessionId() {
  return process.env.CLAUDE_SESSION_ID || void 0;
}
function writeLog(entry) {
  try {
    ensureLogDir();
    rotateIfNeeded();
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
  }
}
function createLogger(hookName) {
  function log2(level, msg, data) {
    if (!shouldLog(level)) return;
    const entry = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      hook: hookName,
      msg,
      sessionId: getSessionId()
    };
    if (data && Object.keys(data).length > 0) {
      entry.data = data;
    }
    writeLog(entry);
    if (level === "error" || level === "warn") {
      console.error(`[${hookName}] ${level.toUpperCase()}: ${msg}`);
    }
  }
  return {
    debug: (msg, data) => log2("debug", msg, data),
    info: (msg, data) => log2("info", msg, data),
    warn: (msg, data) => log2("warn", msg, data),
    error: (msg, data) => log2("error", msg, data)
  };
}

// src/shared/state-schema.ts
var log = createLogger("state-schema");
function readRalphUnifiedState(projectDir) {
  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const statePath = join2(dir, ".ralph", "state.json");
  if (!existsSync3(statePath)) return null;
  try {
    const content = readFileSync2(statePath, "utf-8");
    const state = JSON.parse(content);
    if (!state.version || !state.version.startsWith("2.")) {
      log.warn("Ralph unified state version mismatch (expected 2.x) \u2014 returning null", {
        version: state.version,
        statePath: join2(dir, ".ralph", "state.json")
      });
      return null;
    }
    return state;
  } catch (err) {
    log.warn("Failed to read Ralph unified state", { error: String(err) });
    return null;
  }
}

// src/pre-compact-continuity.ts
function getRalphStateYaml(projectDir) {
  try {
    const state = readRalphUnifiedState(projectDir);
    if (!state) return null;
    const hasActive = state.session?.active === true;
    const inProgress = (state.tasks || []).filter((t) => t.status === "in_progress" || t.status === "in-progress");
    const completed = (state.tasks || []).filter((t) => t.status === "complete" || t.status === "completed");
    const problemTasks = (state.tasks || []).filter(
      (t) => ["failed", "blocked", "paused", "cancelled"].includes(t.status)
    );
    const total = (state.tasks || []).length;
    if (!hasActive && inProgress.length === 0 && problemTasks.length === 0) return null;
    const currentTaskName = inProgress.length > 0 ? (inProgress[0].name || inProgress[0].id || "current task").replace(/"/g, '\\"') : "orchestration complete";
    const lines = [];
    lines.push(`ralph_state:`);
    lines.push(`  story_id: "${state.story_id || "unknown"}"`);
    lines.push(`  stage: "${state.stage || "unknown"}"`);
    lines.push(`  iteration: ${state.iteration || 0}`);
    lines.push(`  max_iterations: ${state.max_iterations || 30}`);
    lines.push(`  progress: "${completed.length}/${total} tasks complete"`);
    lines.push(`  retry_queue_size: ${(state.retry_queue || []).length}`);
    if (inProgress.length > 0) {
      lines.push(`  active_task:`);
      lines.push(`    id: "${inProgress[0].id}"`);
      lines.push(`    name: "${(inProgress[0].name || "").replace(/"/g, '\\"')}"`);
      lines.push(`    agent: "${inProgress[0].agent || "unassigned"}"`);
    }
    const pending = (state.tasks || []).filter((t) => t.status === "pending");
    if (pending.length > 0) {
      lines.push(`  pending_tasks: [${pending.slice(0, 10).map((t) => `"${t.id}"`).join(", ")}]`);
    }
    if (problemTasks.length > 0) {
      lines.push(`  problem_tasks: [${problemTasks.slice(0, 10).map((t) => `"${t.id}(${t.status})"`).join(", ")}]`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}
async function main() {
  const input = JSON.parse(await readStdin());
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ledgerDir = path.join(projectDir, "thoughts", "ledgers");
  const ledgerFiles = fs2.existsSync(ledgerDir) ? fs2.readdirSync(ledgerDir).filter((f) => f.startsWith("CONTINUITY_CLAUDE-") && f.endsWith(".md")) : [];
  let handoffFile = "";
  let ledgerMessage = "";
  if (ledgerFiles.length > 0) {
    const mostRecent = ledgerFiles.sort((a, b) => {
      const statA = fs2.statSync(path.join(ledgerDir, a));
      const statB = fs2.statSync(path.join(ledgerDir, b));
      return statB.mtime.getTime() - statA.mtime.getTime();
    })[0];
    const ledgerPath = path.join(ledgerDir, mostRecent);
    if (input.trigger === "auto") {
      const sessionName = mostRecent.replace("CONTINUITY_CLAUDE-", "").replace(".md", "");
      if (input.transcript_path && fs2.existsSync(input.transcript_path)) {
        const summary = parseTranscript(input.transcript_path);
        const handoffContent = generateAutoHandoff(summary, sessionName);
        const handoffDir = path.join(projectDir, "thoughts", "shared", "handoffs", sessionName);
        fs2.mkdirSync(handoffDir, { recursive: true });
        const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
        handoffFile = `auto-handoff-${timestamp}.yaml`;
        const handoffPath = path.join(handoffDir, handoffFile);
        const ralphYaml2 = getRalphStateYaml(projectDir);
        const finalContent = ralphYaml2 ? handoffContent + "\n\n" + ralphYaml2 + "\n" : handoffContent;
        fs2.writeFileSync(handoffPath, finalContent);
        const briefSummary = generateAutoSummary(projectDir, input.session_id);
        if (briefSummary) {
          appendToLedger(ledgerPath, briefSummary);
        }
      } else {
        const briefSummary = generateAutoSummary(projectDir, input.session_id);
        if (briefSummary) {
          appendToLedger(ledgerPath, briefSummary);
        }
      }
      ledgerMessage = handoffFile ? `[PreCompact:auto] Created YAML handoff: thoughts/shared/handoffs/${mostRecent.replace("CONTINUITY_CLAUDE-", "").replace(".md", "")}/${handoffFile}` : `[PreCompact:auto] Session summary auto-appended to ${mostRecent}`;
    } else {
      ledgerMessage = `[PreCompact] Consider updating ledger before compacting: /continuity_ledger
Ledger: ${mostRecent}`;
    }
  }
  const ralphYaml = getRalphStateYaml(projectDir);
  if (ralphYaml) {
    if (handoffFile) {
      ledgerMessage += " (Ralph state preserved)";
    } else {
      const handoffDir = path.join(projectDir, "thoughts", "shared", "handoffs", "ralph-auto");
      fs2.mkdirSync(handoffDir, { recursive: true });
      const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const ralphHandoffFile = `ralph-handoff-${timestamp}.yaml`;
      const storyId = ralphYaml.match(/story_id:\s*"([^"]+)"/)?.[1] || "";
      const currentTask = ralphYaml.match(/name:\s*"([^"]+)"/)?.[1] || "orchestration";
      const goal = storyId ? `Ralph orchestration for story ${storyId}` : `Ralph orchestration: ${currentTask}`;
      fs2.writeFileSync(
        path.join(handoffDir, ralphHandoffFile),
        `---
type: auto-handoff
session: ralph-auto
date: ${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}
---

goal: "${goal}"
now: "${currentTask}"

${ralphYaml}
`
      );
      ledgerMessage = `[PreCompact] Ralph state preserved to thoughts/shared/handoffs/ralph-auto/${ralphHandoffFile}`;
    }
  }
  const output = {
    continue: true,
    systemMessage: ledgerMessage || "[PreCompact] No continuity data to preserve"
  };
  console.log(JSON.stringify(output));
}
function generateAutoSummary(projectDir, sessionId) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const lines = [];
  const cacheDir = path.join(projectDir, ".claude", "tsc-cache", sessionId || "default");
  const editedFilesPath = path.join(cacheDir, "edited-files.log");
  let editedFiles = [];
  if (fs2.existsSync(editedFilesPath)) {
    const content = fs2.readFileSync(editedFilesPath, "utf-8");
    editedFiles = [...new Set(
      content.split("\n").filter((line) => line.trim()).map((line) => {
        const parts = line.split(":");
        return parts[1]?.replace(projectDir + "/", "") || "";
      }).filter((f) => f)
    )];
  }
  const gitClaudeDir = path.join(projectDir, ".git", "claude", "branches");
  let buildAttempts = { passed: 0, failed: 0 };
  if (fs2.existsSync(gitClaudeDir)) {
    try {
      const branches = fs2.readdirSync(gitClaudeDir);
      for (const branch of branches) {
        const attemptsFile = path.join(gitClaudeDir, branch, "attempts.jsonl");
        if (fs2.existsSync(attemptsFile)) {
          const content = fs2.readFileSync(attemptsFile, "utf-8");
          content.split("\n").filter((l) => l.trim()).forEach((line) => {
            try {
              const attempt = JSON.parse(line);
              if (attempt.type === "build_pass") buildAttempts.passed++;
              if (attempt.type === "build_fail") buildAttempts.failed++;
            } catch {
            }
          });
        }
      }
    } catch {
    }
  }
  if (editedFiles.length === 0 && buildAttempts.passed === 0 && buildAttempts.failed === 0) {
    return null;
  }
  lines.push(`
## Session Auto-Summary (${timestamp})`);
  if (editedFiles.length > 0) {
    lines.push(`- Files changed: ${editedFiles.slice(0, 10).join(", ")}${editedFiles.length > 10 ? ` (+${editedFiles.length - 10} more)` : ""}`);
  }
  if (buildAttempts.passed > 0 || buildAttempts.failed > 0) {
    lines.push(`- Build/test: ${buildAttempts.passed} passed, ${buildAttempts.failed} failed`);
  }
  return lines.join("\n");
}
function appendToLedger(ledgerPath, summary) {
  try {
    let content = fs2.readFileSync(ledgerPath, "utf-8");
    const stateMatch = content.match(/## State\n/);
    if (stateMatch) {
      const nowMatch = content.match(/(\n-\s*Now:)/);
      if (nowMatch && nowMatch.index) {
        content = content.slice(0, nowMatch.index) + summary + content.slice(nowMatch.index);
      } else {
        const nextSection = content.indexOf("\n## ", content.indexOf("## State") + 1);
        if (nextSection > 0) {
          content = content.slice(0, nextSection) + summary + "\n" + content.slice(nextSection);
        } else {
          content += summary;
        }
      }
    } else {
      content += summary;
    }
    fs2.writeFileSync(ledgerPath, content);
  } catch (err) {
  }
}
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}
if ((process.argv[1] || "").includes("pre-compact-continuity")) {
  main().catch(console.error);
}
