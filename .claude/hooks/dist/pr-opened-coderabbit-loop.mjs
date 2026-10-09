import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/pr-opened-coderabbit-loop.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
var COMMAND_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var PR_CREATE_RE = /\bgh\s+pr\s+create\b/i;
var GH_API_RE = /\bgh\s+api\b/i;
var PULLS_PATH_RE = /\/pulls\b/i;
var POST_METHOD_RE = /(-X\s*POST|--method\s*POST)/i;
var PR_URL_RE = /https:\/\/github\.com\/([^/\s"']+)\/([^/\s"']+)\/pull\/(\d+)/;
function isPrOpenCommand(command) {
  const cmd = command || "";
  if (PR_CREATE_RE.test(cmd)) return true;
  if (GH_API_RE.test(cmd) && PULLS_PATH_RE.test(cmd) && POST_METHOD_RE.test(cmd)) return true;
  return false;
}
function responseText(resp) {
  if (resp === null || resp === void 0) return "";
  if (typeof resp === "string") return resp;
  if (resp && typeof resp === "object") {
    const o = resp;
    const parts = [o.output, o.stdout, o.stderr, o.content].filter(
      (v) => typeof v === "string"
    );
    if (parts.length) return parts.join("\n");
  }
  try {
    return JSON.stringify(resp ?? "");
  } catch {
    return "";
  }
}
function extractPrInfo(responseTxt) {
  const urlMatch = responseTxt.match(PR_URL_RE);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], number: urlMatch[3], url: urlMatch[0] };
  }
  return null;
}
function hasNumberField(responseTxt) {
  return /"number"\s*:\s*\d+/.test(responseTxt);
}
function statePath(sessionId) {
  const safeSession = (sessionId || "no-session").replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(tmpdir(), `pr-opened-coderabbit-loop-${safeSession}.json`);
}
function alreadyFired(sessionId, url) {
  try {
    const p = statePath(sessionId);
    if (!existsSync(p)) return false;
    const seen = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(seen) && seen.includes(url);
  } catch {
    return false;
  }
}
function markFired(sessionId, url) {
  try {
    const p = statePath(sessionId);
    let seen = [];
    if (existsSync(p)) {
      try {
        const parsed = JSON.parse(readFileSync(p, "utf8"));
        if (Array.isArray(parsed)) seen = parsed;
      } catch {
        seen = [];
      }
    }
    if (!seen.includes(url)) seen.push(url);
    mkdirSync(tmpdir(), { recursive: true });
    writeFileSync(p, JSON.stringify(seen), "utf8");
  } catch {
  }
}
var WATCH_REPO = "rev4nchist/continuous-claude-v3";
var loopText = (info) => `/loop 5m Check the review bot (Greptile; CodeRabbit on a repo not moved yet) on ${info.owner}/${info.repo} PR #${info.number} (stop when a review of the head lands or after 60 minutes; fix real findings; dismiss false positives with a reason; verify thread isResolved via GraphQL; never merge)`;
function buildContext(info) {
  const head = `PR OPENED: ${info.url}. Per ~/.claude/rules-ondemand/pr-review-loop.md, `;
  if (`${info.owner}/${info.repo}`.toLowerCase() === WATCH_REPO) {
    return head + `FIRST call the pr_watch tool with pr: ${info.number} (mcp__ccv3-mods__pr_watch), in this same turn. It watches the Greptile review and CI for you and tells Dave and you at READY; never merge. Only if that tool does not exist, start the REVIEW LOOP instead: ${loopText(info)}. This applies to every PR in every session.`;
  }
  return head + `START THE REVIEW LOOP NOW, in this same turn: ${loopText(info)}. This applies to every PR in every session.`;
}
function main() {
  const raw = readFileSync(0, "utf8");
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    console.log("{}");
    return;
  }
  const tool = input.tool_name || "";
  if (!COMMAND_TOOLS.has(tool)) {
    console.log("{}");
    return;
  }
  const command = input.tool_input?.command || "";
  if (!isPrOpenCommand(command)) {
    console.log("{}");
    return;
  }
  const text = responseText(input.tool_response);
  const info = extractPrInfo(text);
  if (!info) {
    console.log("{}");
    return;
  }
  const sessionId = input.session_id || "";
  if (alreadyFired(sessionId, info.url)) {
    console.log("{}");
    return;
  }
  markFired(sessionId, info.url);
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: buildContext(info)
      }
    })
  );
}
if ((process.argv[1] || "").includes("pr-opened-coderabbit-loop")) {
  try {
    main();
  } catch {
    console.log("{}");
  }
}
export {
  buildContext,
  extractPrInfo,
  hasNumberField,
  isPrOpenCommand,
  main,
  responseText
};
