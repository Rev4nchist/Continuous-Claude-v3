import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/pr-opened-review-loop.ts
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join as join2 } from "path";
import { homedir, tmpdir } from "os";

// src/shared/router-config.ts
import { dirname, join } from "path";
var CONFIG_REL = "review-router.config.json";
function routerConfigText(cwd, readFile, home) {
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    const text = readFile(join(dir, CONFIG_REL));
    if (text !== null) return text;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return readFile(join(home, "continuous-claude", CONFIG_REL));
}
function routerFlag(cwd, readFile, home, section, key) {
  const text = routerConfigText(cwd, readFile, home);
  if (text === null) return false;
  try {
    const cfg = JSON.parse(text);
    return cfg?.[section]?.[key] === true;
  } catch {
    return false;
  }
}

// src/pr-opened-review-loop.ts
var COMMAND_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var PR_CREATE_RE = /\bgh\s+pr\s+create\b/i;
var GH_API_RE = /\bgh\s+api\b/i;
var PULLS_PATH_RE = /\/pulls\/?(?=[\s"'?]|$)/i;
var POST_METHOD_RE = /(?:^|\s)(?:-X\s*|--method(?:\s+|=))POST\b/i;
var ANY_METHOD_RE = /(?:^|\s)(?:-X\s*|--method(?:\s+|=))\w/i;
var FIELD_FLAG_RE = /(?:^|\s)(?:-[fF]\s*["']?[\w.[\]-]+=|--(?:raw-field|field|input)[\s=])/;
var GH_API_SEGMENT_RE = /\bgh\s+api\b[^|;&\n]*/i;
var DATA_VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s"']+)+`;
var DATA_FLAG_RE = new RegExp(String.raw`(^|\s)(-[fFHqt]\s*|--(?:raw-field|field|header|jq|template|input)(?:\s+|=))${DATA_VALUE}`, "g");
var PR_URL_RE = /https:\/\/github\.com\/([^/\s"']+)\/([^/\s"']+)\/pull\/(\d+)/;
function joinContinuations(command, shell) {
  const text = command || "";
  return shell === "bash" ? text.replace(/\\\r?\n/g, "") : text.replace(/[ \t]*`\r?\n[ \t]*/g, " ");
}
function normalizeGh(command) {
  return (command || "").replace(/(["'])gh(?:\.exe)?\1(?=\s)|\bgh\.exe(?=\s)/gi, "gh");
}
var squashQuotes = (text) => text.replace(/["'\\]/g, "");
function isPrOpenCommand(command) {
  const text = normalizeGh(command);
  return isPrOpenText(joinContinuations(text, "bash")) || isPrOpenText(joinContinuations(text, "pwsh"));
}
function isPrOpenText(cmd) {
  if (PR_CREATE_RE.test(cmd) || PR_CREATE_RE.test(squashQuotes(cmd))) return true;
  if (!GH_API_RE.test(cmd)) return false;
  const api = cmd.match(GH_API_SEGMENT_RE)?.[0] ?? "";
  const bare = api.replace(DATA_FLAG_RE, "$1$2");
  if (!PULLS_PATH_RE.test(bare)) return false;
  if (POST_METHOD_RE.test(bare)) return true;
  return FIELD_FLAG_RE.test(api) && !ANY_METHOD_RE.test(bare);
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
function safeSession(sessionId) {
  return (sessionId || "no-session").replace(/[^a-zA-Z0-9_-]/g, "_");
}
function statePath(sessionId) {
  return join2(tmpdir(), `pr-opened-review-loop-${safeSession(sessionId)}.json`);
}
function legacyStatePath(sessionId) {
  return join2(tmpdir(), `pr-opened-coderabbit-loop-${safeSession(sessionId)}.json`);
}
function readSeen(p) {
  try {
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}
function alreadyFired(sessionId, url) {
  return readSeen(statePath(sessionId)).includes(url) || readSeen(legacyStatePath(sessionId)).includes(url);
}
function markFired(sessionId, url) {
  try {
    const legacy = legacyStatePath(sessionId);
    const seen = [.../* @__PURE__ */ new Set([...readSeen(statePath(sessionId)), ...readSeen(legacy), url])];
    mkdirSync(tmpdir(), { recursive: true });
    writeFileSync(statePath(sessionId), JSON.stringify(seen), "utf8");
    if (existsSync(legacy)) unlinkSync(legacy);
  } catch {
  }
}
var WATCH_REPO = "rev4nchist/continuous-claude-v3";
var loopText = (info) => `/loop 5m Check the PR review bots that must review the head (in CCv3, the bots \`node scripts/github/review-status.mjs ${info.number}\` requires; elsewhere, the repo's configured bots) on ${info.owner}/${info.repo} PR #${info.number} (stop when reviews of the head land or after 60 minutes; fix real findings; dismiss false positives with a reason; verify thread isResolved via GraphQL; never merge)`;
function checkpointText(info, ledger) {
  const call = `the pr_checkpoint tool with pr: ${info.number} and body: the path of the PR body file that pre-pr.mjs --body checked (mcp__ccv3-mods__pr_checkpoint)`;
  const never = "Never mark it ready or add a review: label yourself; the checkpoint does both. ";
  if (ledger) {
    return `Either way, also call ${call}. If it returns a question, ask Dave that question with AskUserQuestion, word for word, then call pr_checkpoint again with the same pr and body. Only his tap records a pick. An answer that matches no option records nothing, and the PR stays a draft. ` + never;
  }
  return `Either way, also call ${call}. Without that call /pathway has no checkpoint to record, and the PR stays a draft. ` + never;
}
function buildContext(info, ledger = false) {
  const head = `PR OPENED: ${info.url}. Per ~/.claude/rules-ondemand/pr-review-loop.md, `;
  if (`${info.owner}/${info.repo}`.toLowerCase() === WATCH_REPO) {
    return head + `FIRST call the pr_watch tool with pr: ${info.number} (mcp__ccv3-mods__pr_watch), in this same turn. It watches the review bots the labels require (CodeRabbit while Greptile auto review is off) and CI for you and tells Dave and you at READY; never merge. Only if that tool does not exist, start the REVIEW LOOP instead: ${loopText(info)}. ` + checkpointText(info, ledger) + `This applies to every PR in every session.`;
  }
  return head + `START THE REVIEW LOOP NOW, in this same turn: ${loopText(info)}. This applies to every PR in every session.`;
}
function ledgerOn(cwd) {
  const readFile = (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  return routerFlag(cwd || process.cwd(), readFile, homedir(), "checkpoint", "ledger");
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
        additionalContext: buildContext(info, ledgerOn(input.cwd || ""))
      }
    })
  );
}
if ((process.argv[1] || "").includes("pr-opened-review-loop")) {
  try {
    main();
  } catch {
    console.log("{}");
  }
}
export {
  alreadyFired,
  buildContext,
  extractPrInfo,
  hasNumberField,
  isPrOpenCommand,
  isPrOpenText,
  joinContinuations,
  legacyStatePath,
  main,
  markFired,
  normalizeGh,
  responseText,
  squashQuotes,
  statePath
};
