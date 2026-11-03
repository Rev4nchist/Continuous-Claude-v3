import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/pre-compact-continuity.ts
import * as fs2 from "fs";
import * as path from "path";

// src/lib/transcript-parser.ts
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
  let content;
  try {
    content = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return summary;
  }
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
              lastTodoState = input.todos.map((t, idx) => {
                const rawStatus = t.status;
                const status = rawStatus === "pending" || rawStatus === "in_progress" || rawStatus === "completed" ? rawStatus : "pending";
                return {
                  id: t.id || `todo-${idx}`,
                  content: t.content || "",
                  status
                };
              });
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
function yamlSafe(value) {
  if (value === null || value === void 0) return "";
  const s = typeof value === "string" ? value : String(value);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 92) {
      out += "\\\\";
      continue;
    }
    if (ch === 34) {
      out += '\\"';
      continue;
    }
    if (ch === 9) {
      out += "\\t";
      continue;
    }
    if (ch === 10) {
      out += "\\n";
      continue;
    }
    if (ch === 13) {
      out += "\\r";
      continue;
    }
    if (ch === 0) {
      out += "\\0";
      continue;
    }
    if (ch === 8) {
      out += "\\b";
      continue;
    }
    if (ch === 12) {
      out += "\\f";
      continue;
    }
    if (ch < 32 || ch >= 127 && ch < 160) {
      out += "\\x" + ch.toString(16).padStart(2, "0");
      continue;
    }
    out += s[i];
  }
  return out;
}
function yamlScalar(value) {
  if (value === null || value === void 0) return '""';
  const s = typeof value === "string" ? value : String(value);
  if (s.length === 0 || /[^A-Za-z0-9 _./\-]/.test(s) || /^\s|\s$/.test(s) || /^[-?@`!&*|>'%,\[\]\{\}#]/.test(s)) {
    return `"${yamlSafe(s)}"`;
  }
  return s;
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
  lines.push(`session: ${yamlScalar(sessionName)}`);
  lines.push(`date: ${yamlScalar(dateOnly)}`);
  lines.push("status: partial");
  lines.push("outcome: PARTIAL_PLUS");
  lines.push("---");
  lines.push("");
  lines.push(`goal: ${yamlScalar(goalSummary)}`);
  lines.push(`now: ${yamlScalar(currentTask)}`);
  lines.push("test: # No test command captured");
  lines.push("");
  lines.push("done_this_session:");
  if (completed.length > 0) {
    completed.forEach((t) => {
      lines.push(`  - task: "${yamlSafe(t.content)}"`);
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
      const safeError = yamlSafe(typeof e === "string" ? e.substring(0, 100) : String(e).substring(0, 100));
      lines.push(`  - "${safeError}"`);
    });
  } else {
    lines.push("  []");
  }
  lines.push("");
  lines.push("questions:");
  if (pending.length > 0) {
    pending.slice(0, 3).forEach((t) => {
      lines.push(`  - "Resume: ${yamlSafe(t.content)}"`);
    });
  } else {
    lines.push("  []");
  }
  lines.push("");
  lines.push("decisions:");
  lines.push('  - auto_compact: "Context limit reached, auto-compacted"');
  lines.push("");
  lines.push("findings:");
  lines.push(`  - tool_calls: "${yamlSafe(summary.recentToolCalls.length + " recent tool calls")}"`);
  lines.push(`  - files_modified: "${yamlSafe(summary.filesModified.length + " files changed")}"`);
  lines.push("");
  lines.push("worked:");
  const successfulTools = summary.recentToolCalls.filter((t) => t.success);
  if (successfulTools.length > 0) {
    lines.push(`  - "${yamlSafe(successfulTools.map((t) => t.name).join(", ") + " completed successfully")}"`);
  } else {
    lines.push("  []");
  }
  lines.push("");
  lines.push("failed:");
  const failedTools = summary.recentToolCalls.filter((t) => !t.success);
  if (failedTools.length > 0) {
    lines.push(`  - "${yamlSafe(failedTools.map((t) => t.name).join(", ") + " encountered errors")}"`);
  } else {
    lines.push("  []");
  }
  lines.push("");
  lines.push("next:");
  if (inProgress.length > 0) {
    lines.push(`  - "Continue: ${yamlSafe(inProgress[0].content)}"`);
  }
  if (pending.length > 0) {
    pending.slice(0, 2).forEach((t) => {
      lines.push(`  - "${yamlSafe(t.content)}"`);
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
      lines.push(`    - "${yamlSafe(f)}"`);
    });
  } else {
    lines.push("    []");
  }
  return lines.join("\n");
}
var isMainModule = /transcript-parser\.[cm]?[jt]s$/.test(process.argv[1] ?? "");
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

// src/pre-compact-continuity.ts
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
        fs2.writeFileSync(handoffPath, handoffContent);
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
