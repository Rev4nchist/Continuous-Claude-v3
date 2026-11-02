#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/pre-pr-gate.ts
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { accessSync, appendFileSync as appendFileSync2, constants, existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync2, statSync } from "fs";
import { dirname as dirname2, isAbsolute, join as join3, posix, resolve, win32 } from "path";

// src/pr-opened-review-loop.ts
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
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
function safeSession(sessionId) {
  return (sessionId || "no-session").replace(/[^a-zA-Z0-9_-]/g, "_");
}
function statePath(sessionId) {
  return join(tmpdir(), `pr-opened-review-loop-${safeSession(sessionId)}.json`);
}
function legacyStatePath(sessionId) {
  return join(tmpdir(), `pr-opened-coderabbit-loop-${safeSession(sessionId)}.json`);
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
function buildContext(info) {
  const head = `PR OPENED: ${info.url}. Per ~/.claude/rules-ondemand/pr-review-loop.md, `;
  if (`${info.owner}/${info.repo}`.toLowerCase() === WATCH_REPO) {
    return head + `FIRST call the pr_watch tool with pr: ${info.number} (mcp__ccv3-mods__pr_watch), in this same turn. It watches the review bots the labels require (CodeRabbit while Greptile auto review is off) and CI for you and tells Dave and you at READY; never merge. Only if that tool does not exist, start the REVIEW LOOP instead: ${loopText(info)}. Either way, also call the pr_checkpoint tool with pr: ${info.number} and body: the path of the PR body file that pre-pr.mjs --body checked (mcp__ccv3-mods__pr_checkpoint). Without that call /pathway has no checkpoint to record, and the PR stays a draft. Never mark it ready or add a review: label yourself; the checkpoint does both. This applies to every PR in every session.`;
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
if ((process.argv[1] || "").includes("pr-opened-review-loop")) {
  try {
    main();
  } catch {
    console.log("{}");
  }
}

// src/shared/checkpoint-shapes.ts
var QUOTED = /"[^"]*"|'[^']*'/g;
var stripQuotes = (text) => text.replace(QUOTED, " ");
var segmentsOf = (text) => text.split(/[;&|\r\n]+/);
var countOf = (re, text) => (text.match(re) ?? []).length;
var plainPart = (segment) => segment.split(/#|<|>|\$\(|`/)[0];
var quoteDoubt = (raw) => /\\["']|`["']/.test(raw) || countOf(/["']/g, stripQuotes(raw)) % 2 === 1;
function uncovered(raw, re, ok) {
  const total = countOf(re, squashQuotes(raw));
  if (total === 0) return false;
  if (quoteDoubt(raw)) return true;
  const covered = segmentsOf(stripQuotes(raw)).map(plainPart).filter(ok).reduce((n, s) => n + countOf(re, s), 0);
  return total > covered;
}
var CLI_CREATE = /\bgh\s+pr\s+create\b/gi;
var GH_API = /\bgh\s+api\b/gi;
var CLI_DRAFT = /(?:^|\s)(?:--draft|-d)(?=\s|$)/;
var API_DRAFT = /(?:^|\s)(?:-F|-f|--field|--raw-field)(?:=|\s+)draft=true(?=\s|$)/;
var DRAFT_FALSE = /\bdraft=false\b/i;
var apiCreateUncovered = (raw) => segmentsOf(raw).some((s) => /\bgh\s+api\b/i.test(s) && isPrOpenText(s) && !API_DRAFT.test(plainPart(stripQuotes(s))));
function isNonDraftCreate(raw) {
  if (DRAFT_FALSE.test(raw)) return true;
  if (!/\bgh\s+pr\s+create\b/i.test(squashQuotes(raw))) return uncovered(raw, GH_API, (s) => API_DRAFT.test(s));
  return uncovered(raw, CLI_CREATE, (s) => CLI_DRAFT.test(s)) || apiCreateUncovered(raw);
}
var READY_CLI = /\bgh\s+pr\s+ready\b/gi;
var READY_GRAPHQL = /markPullRequestReadyForReview/i;
var READY_BRACE = /\bgh\s+pr\s+\S*[{}]/i;
var UNDO = /(?:^|\s)--undo(?=\s|$)/;
function isReadyShape(raw) {
  return READY_GRAPHQL.test(raw) || READY_BRACE.test(raw) || uncovered(raw, READY_CLI, (s) => UNDO.test(s));
}
var WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'])+`;
var ADD_LABEL = new RegExp(String.raw`(?:^|\s)--add-label(?:=|\s+)(${WORD})`, "g");
var CREATE_LABEL = new RegExp(String.raw`(?:^|\s)(?:--label(?:=|\s+)|-l\s*)(${WORD})`, "g");
var REVIEW_TOKEN = /review:[\w-]+/gi;
var ISSUE_ENDPOINT = /repos\/([\w.-]+\/[\w.-]+)\/(?:issues|pulls)\/[^\s/"'?]+/gi;
var LABELS_PATH = /\/labels\b/i;
var LABEL_FIELD = /\blabels(?:\[[^\]]*\])?=/i;
var FILE_LABELS = /\blabels(?:\[[^\]]*\])?=@/i;
var LABEL_MUTATION = /\b(?:labelIds|updatePullRequest|updateIssue)\b/;
var INPUT_FLAG = /(?:^|\s)--input(?:=|\s|$)/;
function hasCcv3Endpoint(raw) {
  if (!/\bgh\s+api\b/i.test(raw)) return false;
  return [...raw.matchAll(ISSUE_ENDPOINT)].some((m) => m[1].toLowerCase() === "rev4nchist/continuous-claude-v3");
}
var valuesOf = (re, raw) => [...raw.matchAll(re)].map((m) => m[1]);
var unquote = (word) => word.replace(/["'\\]/g, "");
var reviewTokens = (text) => (text.match(REVIEW_TOKEN) ?? []).map((t) => t.toLowerCase());
function labelShape(raw, create) {
  if (!/\bgh\b/i.test(raw)) return null;
  const squashed = squashQuotes(raw);
  const read = (re) => [...valuesOf(re, raw).map(unquote), ...valuesOf(re, squashed)];
  const values = [...read(ADD_LABEL), ...create ? read(CREATE_LABEL) : []];
  const api = /\bgh\s+api\b/i.test(squashed);
  const labelsApi = api && (LABELS_PATH.test(squashed) || new RegExp(ISSUE_ENDPOINT.source, "i").test(squashed) && LABEL_FIELD.test(squashed));
  const labels = [...new Set(reviewTokens(values.join(" ") + (labelsApi ? ` ${squashed}` : "")))];
  const blind = /addLabelsToLabelable/i.test(raw) || api && (LABEL_MUTATION.test(squashed) || FILE_LABELS.test(squashed) || labelsApi && INPUT_FLAG.test(squashed)) || values.some((v) => /[$`{}]/.test(v));
  return labels.length > 0 || blind ? { labels, blind } : null;
}
var SELF_FLAG = /(?:^|\s)--(?:confirm|apply)(?:=|\s|$)/;
var NODE_CMD = /\bnode(?:\.exe)?["']?\s/i;
var APPLY_N = /(?:^|\s)--apply(?:=|\s+)["']?\d+/;
var CONFIRM_PATHWAY = /(?:^|\s)--confirm(?:=|\s+)["']?(?:none|coderabbit|both|wait)\b/;
var BY_FLAG = /(?:^|\s)--by(?:=|\s)/;
var SCRIPT_GLOB = /scripts[\\/]+github[\\/]+[^\s"']*[*?[]/i;
var NONLITERAL_REPO = new RegExp(
  String.raw`(?:^|\s)(?:-R\s*=?|--repo(?:\s+|=))["']?[^\s"']*(?:\$|\x60|%[A-Za-z_]\w*%)` + String.raw`|(?:^|[\s;])(?:\$env:)?GH_REPO\s*=\s*["']?[^\s"';]*(?:\$|\x60|%[A-Za-z_]\w*%)`,
  "i"
);
function isSelfConfirm(raw) {
  if (/pr-checkpoint/i.test(raw) && SELF_FLAG.test(raw)) return true;
  if (NODE_CMD.test(raw) && (APPLY_N.test(raw) || CONFIRM_PATHWAY.test(raw) && BY_FLAG.test(raw))) return true;
  return SELF_FLAG.test(raw) && SCRIPT_GLOB.test(raw);
}
var hasNonLiteralRepo = (raw) => NONLITERAL_REPO.test(raw);
function shapesOf(command) {
  const text = normalizeGh(command);
  const create = isPrOpenCommand(text);
  const ready = isReadyShape(text);
  const label = labelShape(text, create);
  const nonLiteral = (create || ready || label !== null) && hasNonLiteralRepo(text);
  return { create, nonDraft: create && isNonDraftCreate(text), ready, label, self: isSelfConfirm(text), nonLiteral };
}
var isGated = (s) => s.create || s.ready || s.label !== null || s.self;
var CCV3_REPO = "rev4nchist/continuous-claude-v3";
var REPO_VALUE = "((?:https?:\\/\\/)?[\\w.-]+(?:\\/[\\w.-]+){1,2})";
var REPO_FLAG = new RegExp(`(?:^|\\s)(?:-R\\s*=?|--repo(?:\\s+|=))["']?${REPO_VALUE}`, "g");
var GH_REPO_ASSIGN = new RegExp(`(?:^|[\\s;])(?:\\$env:)?GH_REPO\\s*=\\s*["']?${REPO_VALUE}`, "gi");
var PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/\d+/gi;
var ownerRepo = (value) => value.replace(/^https?:\/\//i, "").split("/").slice(-2).join("/").replace(/\.git$/i, "").toLowerCase();
var API_ENDPOINT = /repos\/([\w.-]+\/[\w.-]+)\/pulls\b/gi;
function namedRepo(command, env = {}) {
  const envRepo = env.GH_REPO && new RegExp(`^${REPO_VALUE}$`).exec(env.GH_REPO.trim())?.[1];
  const values = [...command.matchAll(REPO_FLAG), ...command.matchAll(GH_REPO_ASSIGN)].map((m) => m[1]);
  const explicits = [...values, ...envRepo ? [envRepo] : []].map(ownerRepo);
  const endpoints = [...command.matchAll(API_ENDPOINT)].map((m) => m[1].toLowerCase());
  const urls = [...command.matchAll(PR_URL)].map((m) => m[1].toLowerCase());
  const ccv3 = explicits.includes(CCV3_REPO) || endpoints.includes(CCV3_REPO) || urls.includes(CCV3_REPO) || hasCcv3Endpoint(command);
  return ccv3 ? CCV3_REPO : null;
}

// src/shared/guard-log.ts
import { appendFileSync, mkdirSync as mkdirSync2 } from "fs";
import { homedir } from "os";
import { dirname, join as join2 } from "path";
var COMMAND_HEAD_CHARS = 80;
var REASON_CHARS = 200;
var PATH_CHARS = 300;
var TARGET_FIELD = {
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  Agent: "subagent_type",
  Task: "subagent_type",
  Skill: "skill"
};
function guardLogPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir();
  return env.CCV3_GUARD_DECISIONS_LOG || join2(home, ".claude", "logs", "guard-decisions.jsonl");
}
var SECRET_NAME = "[\\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|auth|credential|cookie)[\\w.-]*";
var MASKS = [
  // A URL inside quotes may hold a password with a space: the closing quote ends it, not the space.
  [/(["'])([a-z][\w+.-]*:\/\/)[^\s/@:"']+:(?:(?!\1)[^/@])+@/gi, "$1$2***@"],
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1***@"],
  // `curl -u user:pass`, `curl --user user:pass`. A numeric user (`docker run -u 1000:1000`) is a uid:gid.
  // Quoting decides where the credential ends: `-u "user:two words"`, `-u user:"two words"`.
  [/(\s(?:-u[\s=]*|--user[\s=]+)")(?!\d+:)([^":]+):[^"]*"/g, '$1$2:***"'],
  [/(\s(?:-u[\s=]*|--user[\s=]+)')(?!\d+:)([^':]+):[^']*'/g, "$1$2:***'"],
  [/(\s(?:-u[\s=]*|--user[\s=]+))(?!\d+:)([^\s:"']+):(?:"[^"]*"|'[^']*'|[^\s"'])+/g, "$1$2:***"],
  // `mysql -uroot -pS3cret`: the password is glued to -p. Case matters: -P is the port.
  [/(\b(?:mysql|mariadb)\w*\b[^|;&\n]*?\s-p)(?:"[^"]*"|'[^']*'|[^\s"'])+/g, "$1***"],
  // `sshpass -p pw ssh host`
  [/(\bsshpass\s+-p\s*)(?:"[^"]*"|'[^']*'|[^\s"']+)/g, "$1***"],
  [/\b(Bearer|Basic|Token)\s+[^\s'"]+/gi, "$1 ***"],
  [new RegExp(`(${SECRET_NAME})(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s'"]+)`, "gi"), "$1$2***"],
  [new RegExp(`(--?${SECRET_NAME})(\\s+)("[^"]*"|'[^']*'|[^\\s'"-][^\\s'"]*)`, "gi"), "$1$2***"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "***"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "***"],
  [/\bgithub_pat_\w+/g, "***"],
  [/\bxox[abprs]-[\w-]+/g, "***"],
  [/\bnpm_[A-Za-z0-9]{20,}/g, "***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "***"],
  [/\bAIza[\w-]{30,}/g, "***"],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "***"],
  // Any other long opaque run that mixes letters and digits (hex, base64url keys).
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}/g, "***"]
];
function maskSecrets(text) {
  return MASKS.reduce((acc, [re, to]) => acc.replace(re, to), text);
}
function commandHead(command) {
  return maskSecrets(command).replace(/\s+/g, " ").trim().slice(0, COMMAND_HEAD_CHARS);
}
function shouldWrite(env) {
  return !!env.CCV3_GUARD_DECISIONS_LOG || !env.VITEST;
}
function pathText(value, max = PATH_CHARS) {
  return typeof value === "string" && value ? value.slice(0, max) : void 0;
}
function targetOf(input, tool) {
  const explicit = pathText(input?.target);
  if (explicit) return explicit;
  const field = Object.hasOwn(TARGET_FIELD, tool) ? TARGET_FIELD[tool] : void 0;
  const toolInput = input?.tool_input;
  if (!field || typeof toolInput !== "object" || toolInput === null) return void 0;
  return pathText(toolInput[field]);
}
function logGuardDecision(hook, input, decision, reason, opts = {}) {
  const env = opts.env ?? process.env;
  try {
    if (!shouldWrite(env)) return;
    const agent = input?.agent_id || env.CLAUDE_AGENT_ID || void 0;
    const tool = input?.tool_name || input?.tool || "";
    const entry = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      hook,
      tool,
      decision,
      reason: maskSecrets(String(reason)).replace(/\s+/g, " ").trim().slice(0, REASON_CHARS),
      session_id: input?.session_id || "",
      agent: !!agent
    };
    if (agent) entry.agent_id = agent;
    const cwd = pathText(input?.cwd);
    if (cwd) entry.cwd = cwd;
    const mode = pathText(input?.permission_mode, 40);
    if (mode) entry.permission_mode = mode;
    const target = targetOf(input, tool);
    if (target) entry.target = target;
    if (typeof opts.command === "string" && opts.command) entry.command = commandHead(opts.command);
    const path = guardLogPath(env);
    mkdirSync2(dirname(path), { recursive: true, mode: 448 });
    appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}
var ERROR_FIELD_CHARS = 200;
function oneLine(text) {
  return maskSecrets(text).replace(/\s+/g, " ").trim().slice(0, ERROR_FIELD_CHARS);
}
function errorMessage(err) {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : safeJson(err);
  return oneLine(String(raw).split(/\r?\n/)[0]);
}
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
function firstFrame(err) {
  const stack = err instanceof Error ? err.stack : void 0;
  const frame = typeof stack === "string" ? stack.split(/\r?\n/).find((l) => /^\s*at\s/.test(l)) : void 0;
  return frame ? oneLine(frame) : "";
}
function logGuardError(hook, err, opts = {}) {
  try {
    const env = opts.env ?? process.env;
    if (!shouldWrite(env)) return;
    const entry = { ts: (/* @__PURE__ */ new Date()).toISOString(), hook, kind: "error", message: errorMessage(err), stack: firstFrame(err) };
    const path = guardLogPath(env);
    mkdirSync2(dirname(path), { recursive: true, mode: 448 });
    appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}

// src/pre-pr-gate.ts
var STAMP_REL = ".claude/cache/pre-pr/stamp.json";
var PATHWAY_REL = ".claude/cache/pre-pr/pathway.json";
var CONFIG_REL = "review-router.config.json";
var MAX_STAMP_AGE_MS = 24 * 36e5;
var FUTURE_SLACK_MS = 5 * 6e4;
var GIT_TIMEOUT_MS = 2e3;
var ALLOWED_SKIP_REASONS = /* @__PURE__ */ new Set(["cli-missing"]);
var COMMAND_TOOLS2 = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var HOOK = "pre-pr-gate";
var RUN = "node scripts/github/pre-pr.mjs --body <file>";
var BODY_UNVERIFIABLE = "the PR body is not a file, so it cannot be matched to the body pre-pr.mjs checked. Pass the body as a file: -F body=@<file> (gh api) or --body-file <file> (gh pr create). An inline body, a body from stdin, --fill and --fill-first are denied";
function headBranchOf(command) {
  const m = /(?:^|\s)(?:-[fF]|--(?:raw-)?field)\s*["']?head=["']?([^\s"']+)/.exec(command) ?? (/\bgh\s+pr\s+create\b/i.test(command) ? /(?:^|\s)(?:--head(?:\s+|=)|-H\s*)["']?([^\s"']+)/.exec(command) : null);
  return m ? m[1].replace(/^[^:\s]+:/, "").replace(/["']+$/, "") : null;
}
function isCcv3Remote(url) {
  const m = /github\.com[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m !== null && m[1].toLowerCase() === CCV3_REPO;
}
var CD_TARGET = /(?:^|[;&|\r\n]\s*)(?:cd|Set-Location|sl|pushd|Push-Location)\s+(?:-LiteralPath\s+|-Path\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/gi;
var resolveIn = (cwd, target) => {
  const t = target.replace(/^["']|["']$/g, "");
  return isAbsolute(t) || /^[A-Za-z]:/.test(t) ? t : resolve(cwd, t);
};
function workDir(command, cwd) {
  const m = new RegExp(CD_TARGET.source, "i").exec(command);
  return m ? resolveIn(cwd, m[1]) : cwd;
}
function candidateDirs(command, cwd) {
  const texts = [command, command.replace(/["']/g, "")];
  const targets = texts.flatMap((t) => [...t.matchAll(CD_TARGET)].map((m) => resolveIn(cwd, m[1].replace(/["']+$/, ""))));
  return [.../* @__PURE__ */ new Set([cwd, ...targets])];
}
var FIELD_BODY = /(?:^|\s)(?:-F|--field)(?:=|\s*)(?:"body=@([^"]+)"|'body=@([^']+)'|body=@(?:"([^"]+)"|'([^']+)'|([^\s"']+)))/;
var BODY_FILE = /(?:^|\s)--body-file(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/;
var SHORT_BODY_FILE = /(?:^|\s)-F\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))/;
var INLINE_BODY = /(?:^|\s)(?:--body(?![\w-])|-b)|(?:^|\s)(?:-f|--raw-field)(?:=|\s*)["']?body=|(?:^|\s)(?:-F|--field)(?:=|\s*)["']?body=(?!@)/;
var INPUT_FLAG2 = /(?:^|\s)--input(?![\w-])/;
function bodyFilesOf(command) {
  const sources = [FIELD_BODY, BODY_FILE, .../\bgh\s+pr\s+create\b/i.test(command) ? [SHORT_BODY_FILE] : []];
  return sources.flatMap((re) => [...command.matchAll(new RegExp(re.source, "g"))].map((m) => m.slice(1).find((g) => g !== void 0) ?? ""));
}
function bodyFileOf(command) {
  const path = bodyFilesOf(command)[0];
  return path !== void 0 && path !== "-" ? path : null;
}
function singleBodyFile(command) {
  const files = bodyFilesOf(command);
  if (files.length !== 1 || INLINE_BODY.test(command) || INPUT_FLAG2.test(command)) return null;
  return bodyFileOf(command);
}
function hasOverride(command, env) {
  return env.SKIP_PRE_PR_GATE === "1" || /^\s*SKIP_PRE_PR_GATE=1\s+/.test(command) || /^\s*\$env:SKIP_PRE_PR_GATE\s*=\s*['"]?1['"]?\s*;/i.test(command);
}
function deny(pattern, why) {
  return {
    action: "deny",
    pattern,
    reason: `BLOCKED (pre-pr-gate): ${why}

Run this from the repo root, then open the PR again:
  ${RUN}

<file> is the draft PR body with the Evidence block (pr-and-commit-style.md). The script runs the gates for the files you changed, checks the Evidence against the head, and runs one CodeRabbit CLI review. It writes a stamp for the head. See pr-review-loop.md "Before you open a PR". CodeRabbit allows 8 PR reviews per hour for one identity, so checks run before the PR opens.`
  };
}
function isCcv3Checkout(deps, dir) {
  const r = deps.git(dir, ["remote", "-v"]);
  if (r.status !== 0) throw new Error(`git remote -v failed in ${dir} (exit ${r.status})`);
  return r.stdout.split(/\r?\n/).some((line) => {
    const url = line.split(/\s+/)[1];
    return url !== void 0 && isCcv3Remote(url);
  });
}
function isCcv3Dir(deps, dir) {
  try {
    return isCcv3Checkout(deps, dir);
  } catch {
    return false;
  }
}
function stampRoots(deps, dir, root, branch) {
  const roots = [root];
  if (!branch) return roots;
  const r = deps.git(dir, ["worktree", "list", "--porcelain"]);
  if (r.status !== 0) return roots;
  for (const block of r.stdout.split(/\r?\n\r?\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const ref = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (path && ref === branch && !roots.includes(path.trim())) roots.push(path.trim());
  }
  return roots;
}
function stampProblem(raw, head, now, body) {
  if (raw === null) return "no stamp. The pre-PR check has not passed in this checkout";
  let s;
  try {
    s = JSON.parse(raw);
  } catch {
    return "the stamp is not valid JSON";
  }
  const o = s;
  if (!o || typeof o !== "object" || typeof o.head !== "string" || o.head === "") return "the stamp has no head";
  const at = typeof o.at === "string" ? Date.parse(o.at) : NaN;
  if (!Number.isFinite(at)) return "the stamp has no valid time";
  if (o.head.toLowerCase() !== head.toLowerCase()) return `the stamp is for commit ${o.head.slice(0, 7)}, the head being opened is ${head.slice(0, 7)}`;
  if (now - at > MAX_STAMP_AGE_MS) return "the stamp is older than 24 hours";
  if (at - now > FUTURE_SLACK_MS) return "the stamp time is in the future";
  const reason = String(o.cr_skip_reason);
  const waitKnown = reason === "rate-limited" && typeof o.cr_retry_minutes === "number" && o.cr_retry_minutes > 0;
  const capEarned = reason === "cap" && typeof o.cr_finished_runs === "number" && o.cr_finished_runs >= 1;
  if (o.cr_skipped === true && reason === "cap" && !capEarned) {
    return `the stamp skipped the CodeRabbit CLI review for the run cap, but no CLI run on this branch has finished with a PASS (cr_finished_runs: ${String(o.cr_finished_runs ?? "none")}). The cap counts runs that finished with a PASS. Fix the CLI and run pre-pr.mjs again`;
  }
  if (o.cr_skipped === true && !ALLOWED_SKIP_REASONS.has(reason) && !waitKnown && !capEarned) {
    return `the stamp skipped the CodeRabbit CLI review (reason: ${o.cr_skip_reason || "none"}). Only a finished-run cap, a missing CLI (cli-missing), or a rate limit with a known retry time allows a skip. A broken CLI (cli-error) costs nothing to retry. Run pre-pr.mjs again without --skip-cr`;
  }
  if (body) {
    if (body.sha === null) return `the body file ${body.path} cannot be read, so it cannot be matched to the body pre-pr.mjs checked. Use an absolute path or a path relative to the working directory. The hook does not expand ~, $env: or /c/ paths`;
    if (o.body_sha256 !== body.sha) return `the body file ${body.path} is not the body pre-pr.mjs checked (its hash differs from the stamp). Run pre-pr.mjs on this file`;
  }
  return null;
}
function pushedProblem(deps, root, branch, head) {
  const name = branch ?? deps.git(root, ["branch", "--show-current"]).stdout.trim();
  if (!name) return null;
  const r = deps.git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/fork/${name}^{commit}`]);
  if (r.status !== 0) return null;
  const pushed = r.stdout.trim();
  if (pushed.toLowerCase() === head.toLowerCase()) return null;
  return `the pushed head fork/${name} is ${pushed.slice(0, 7)}, not the stamped head ${head.slice(0, 7)}. Push the stamped commit, or run pre-pr.mjs again`;
}
var shellOf = (input) => (input.tool_name || input.tool) === "PowerShell" ? "pwsh" : "bash";
var once = (f) => {
  let box;
  return () => (box ??= { v: f() }).v;
};
function makeCtx(input, command, deps, shapes) {
  const cwd = input.cwd || process.cwd();
  const dir = workDir(command, cwd);
  const named = namedRepo(command, deps.env);
  const tops = /* @__PURE__ */ new Map();
  const top = (d) => {
    if (!tops.has(d)) {
      const r = deps.git(d, ["rev-parse", "--show-toplevel"]);
      tops.set(d, r.status === 0 ? r.stdout.trim() : null);
    }
    return tops.get(d) ?? null;
  };
  const inCcv3 = once(() => named === CCV3_REPO || isCcv3Checkout(deps, dir) || candidateDirs(command, cwd).some((d) => d !== dir && isCcv3Dir(deps, d)));
  return {
    dir,
    named,
    top,
    ccv3: inCcv3,
    // No usable config in the cwd checkout: fail closed for a command that names CCv3, a self-confirm (repo-free, pr-checkpoint is CCv3-only)
    // and a command that runs in a CCv3 checkout. Any other command is warn mode. A readable config keeps its own value.
    enforcing: once(() => enforceIn(deps, top(cwd)) ?? (named === CCV3_REPO || shapes.self || inCcv3()))
  };
}
function enforceIn(deps, top) {
  const text = top === null ? null : deps.readFile(join3(top, CONFIG_REL));
  if (text === null) return null;
  try {
    return JSON.parse(text)?.checkpoint?.enforce === true;
  } catch {
    return null;
  }
}
function decide(input, deps) {
  const raw = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  const command = normalizeGh(joinContinuations(raw, shellOf(input)));
  const shapes = shapesOf(command);
  if (!isGated(shapes)) return { action: "allow" };
  const ctx = makeCtx(input, command, deps, shapes);
  const d = judge(command, deps, ctx, shapes);
  if (d.action !== "deny") return d;
  if (hasOverride(command, deps.env)) return { action: "override" };
  return d.soft && !ctx.enforcing() ? { action: "allow", warn: d.pattern } : d;
}
function judge(command, deps, ctx, shapes) {
  const stamp = shapes.create ? stampDeny(command, deps, ctx) : null;
  return stamp ?? checkpointDeny(deps, ctx, shapes) ?? { action: "allow" };
}
function stampDeny(command, deps, ctx) {
  const { dir, named } = ctx;
  if (!ctx.ccv3()) return null;
  const top = ctx.top(dir);
  if (top === null) return deny("no-checkout", `this command opens a PR in ${CCV3_REPO}, but ${dir} is not a git checkout, so no pre-PR stamp can be found`);
  if (named !== null && !isCcv3Checkout(deps, dir)) return deny("repo-identity", `this command names ${CCV3_REPO}, but ${dir} is not a CCv3 checkout, so its stamp does not count`);
  const bodyPath = singleBodyFile(command);
  if (bodyPath === null) return deny("body", BODY_UNVERIFIABLE);
  const branch = headBranchOf(command);
  const headRun = deps.git(top, ["rev-parse", branch ? `${branch}^{commit}` : "HEAD"]);
  if (headRun.status !== 0) return deny("head-unresolved", `cannot resolve the head ${branch ?? "HEAD"} in ${top}`);
  const head = headRun.stdout.trim();
  const body = { path: bodyPath, sha: sha256Of(deps.readFile(resolve(dir, bodyPath))) };
  const problems = stampRoots(deps, dir, top, branch).map((r) => stampProblem(deps.readFile(join3(r, STAMP_REL)), head, deps.now(), body));
  if (!problems.some((p) => p === null)) return deny("stamp", problems[0] ?? "no stamp");
  const pushed = pushedProblem(deps, top, branch, head);
  return pushed ? deny("pushed-head", pushed) : null;
}
function soft(pattern, why) {
  return { action: "deny", pattern, soft: true, reason: `BLOCKED (pre-pr-gate): ${why}` };
}
var SELF_WHY = "pr-checkpoint --confirm and --apply record and spend a review pathway. Only Dave's press in the /pathway mod does that. Do not run them from a shell. The read-only form (node scripts/github/pr-checkpoint.mjs --json) is allowed.";
var LITERAL_WHY = "pass a literal OWNER/REPO to --repo or -R. A value with $, a backtick or %VAR% hides the target repo from this gate.";
var DRAFT_WHY = `open as draft; run /pathway. Open the PR with gh pr create --draft (gh api: -F draft=true). The /pathway mod picks the review pathway and marks the PR ready after Dave presses it.`;
var READY_WHY = "gh pr ready is not run from a shell. Run /pathway: when Dave presses a pathway, the mod adds the review label and marks the PR ready. To return a PR to draft, use gh pr ready --undo.";
var LABEL_WHY = "a review: label is set only by /pathway, for the pathway Dave confirmed for this head. Do not add one by hand, and do not use a command whose label text is hidden. Run /pathway.";
function checkpointDeny(deps, ctx, shapes) {
  if (shapes.self) return soft("self-confirm", SELF_WHY);
  if (shapes.nonLiteral) return soft("nonliteral-repo", LITERAL_WHY);
  if (!ctx.ccv3()) return null;
  if (shapes.nonDraft) return soft("non-draft", DRAFT_WHY);
  if (shapes.ready) return soft("ready", READY_WHY);
  if (shapes.label && !labelAllowed(shapes.label, deps, ctx)) return soft("review-label", LABEL_WHY);
  return null;
}
function labelAllowed(label, deps, ctx) {
  if (label.blind || label.labels.length !== 1) return false;
  return pathwayLabel(deps, ctx) === label.labels[0];
}
function pathwayLabel(deps, ctx) {
  const top = ctx.top(ctx.dir);
  const text = top === null ? null : deps.readFile(join3(top, PATHWAY_REL));
  const head = top === null ? null : deps.git(top, ["rev-parse", "HEAD"]);
  if (text === null || head === null || head.status !== 0) return null;
  let p;
  try {
    p = JSON.parse(text);
  } catch {
    return null;
  }
  if (!p || typeof p.head !== "string" || typeof p.label !== "string") return null;
  return p.head.toLowerCase() === head.stdout.trim().toLowerCase() ? p.label.toLowerCase() : null;
}
var sha256Of = (text) => text === null ? null : createHash("sha256").update(text).digest("hex");
function errorContext(err, input) {
  const code = err?.code;
  const cwd = input?.cwd;
  return { ...typeof code === "string" && code ? { code } : {}, ...typeof cwd === "string" && cwd ? { cwd } : {} };
}
function handle(raw, deps) {
  let input = {};
  let command = "";
  let gated = false;
  let create = false;
  try {
    try {
      input = JSON.parse(raw.trim() || "{}");
    } catch (parseErr) {
      try {
        deps.logError?.(String(parseErr?.message ?? parseErr), errorContext(parseErr, null));
      } catch {
      }
      if (!isPrOpenCommand(raw)) return "{}";
      logGuardDecision(HOOK, {}, "deny", "unreadable-input", { command: raw.slice(0, 500) });
      const why = `BLOCKED (pre-pr-gate): could not read the hook input, and its text looks like a PR create, so the pre-PR stamp could not be checked. Run the command again. If it keeps failing, ask Dave.

The stamp comes from: ${RUN}`;
      return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } });
    }
    const tool = input.tool_name || input.tool || "";
    if (!COMMAND_TOOLS2.has(tool)) return "{}";
    command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
    create = isPrOpenCommand(command);
    gated = create || isGated(shapesOf(joinContinuations(command, shellOf(input))));
    const d = decide(input, deps);
    if (d.action === "override") logGuardDecision(HOOK, input, "override", "SKIP_PRE_PR_GATE", { command });
    if (d.action === "allow" && d.warn) logGuardDecision(HOOK, input, "warn", d.warn, { command });
    if (d.action !== "deny") return "{}";
    logGuardDecision(HOOK, input, "deny", d.pattern, { command });
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } });
  } catch (err) {
    const message = String(err?.message ?? err);
    try {
      deps.logError?.(message, errorContext(err, input));
    } catch {
    }
    if (!gated) return "{}";
    if (hasOverride(joinContinuations(command, shellOf(input)), deps.env)) {
      logGuardDecision(HOOK, input, "override", "SKIP_PRE_PR_GATE", { command });
      return "{}";
    }
    if (err?.code === GIT_NOT_FOUND) {
      logGuardDecision(HOOK, input, "deny", "git-not-found", { command });
      const why = `BLOCKED (pre-pr-gate): ${message.slice(0, 400)}

The gate needs git to check ${create ? "the pre-PR stamp" : "the PR checkpoint rules"}.`;
      return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } });
    }
    logGuardDecision(HOOK, input, "deny", "verify-error", { command });
    const what = create ? "the pre-PR stamp" : "the PR checkpoint rules";
    const reason = `BLOCKED (pre-pr-gate): could not verify ${what} (${message.slice(0, 200)}). Run the command again. If it keeps failing, ask Dave.

The stamp comes from: ${RUN}`;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  }
}
var GIT_NOT_FOUND = "GIT_NOT_FOUND";
var GIT_FIX = "Fix: install Git for Windows (https://git-scm.com/download/win) or add its cmd folder (for example C:\\Program Files\\Git\\cmd) to PATH, then run the command again.";
function gitNotFound(detail) {
  return Object.assign(new Error(`git not found on PATH: ${detail}. ${GIT_FIX}`), { code: GIT_NOT_FOUND });
}
function runnableFile(path, platform = process.platform) {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function resolveGit(env = process.env, exists, platform = process.platform) {
  exists ??= (path) => runnableFile(path, platform);
  const win = platform === "win32";
  const p = win ? win32 : posix;
  const exe = win ? "git.exe" : "git";
  const dirs = (env.PATH ?? env.Path ?? "").split(p.delimiter).map((d) => d.replace(/^"|"$/g, "")).filter(Boolean);
  const candidates = dirs.map((d) => p.join(d, exe));
  if (win) {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files", "C:\\Program Files (x86)"].filter((r) => !!r);
    for (const root of roots) candidates.push(p.join(root, "Git", "cmd", exe), p.join(root, "Git", "bin", exe));
    if (env.LOCALAPPDATA) candidates.push(p.join(env.LOCALAPPDATA, "Programs", "Git", "cmd", exe));
  } else {
    candidates.push("/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git");
  }
  return candidates.find((c) => {
    try {
      return exists(c);
    } catch {
      return false;
    }
  }) ?? null;
}
function makeGit(spawn = spawnSync, env = process.env, gitPath) {
  const asked = Number(env.PRE_PR_GATE_GIT_TIMEOUT_MS);
  const timeout = Number.isFinite(asked) && asked > GIT_TIMEOUT_MS ? asked : GIT_TIMEOUT_MS;
  let resolved = gitPath;
  return (cwd, args) => {
    if (resolved === void 0) resolved = resolveGit(env);
    if (resolved === null) throw gitNotFound("no git program in PATH or in the standard install folders");
    const r = spawn(resolved, args, { cwd, encoding: "utf8", timeout, windowsHide: true });
    if (r.error) {
      if (r.error.code === "ENOENT") {
        if (!existsSync2(resolved)) throw gitNotFound(r.error.message);
        if (!existsSync2(cwd)) throw new Error(`directory not found: ${cwd}`);
      }
      throw r.error;
    }
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
  };
}
function makeErrorLogger(env = process.env) {
  return (message, ctx = {}) => {
    if (!shouldWrite(env)) return;
    const file = join3(dirname2(guardLogPath(env)), "pre-pr-gate-errors.jsonl");
    mkdirSync3(dirname2(file), { recursive: true, mode: 448 });
    const cwd = ctx.cwd ?? null;
    let cwdExists = false;
    try {
      cwdExists = existsSync2(cwd ?? process.cwd());
    } catch {
    }
    const row = { ts: (/* @__PURE__ */ new Date()).toISOString(), hook: HOOK, error: maskSecrets(message).slice(0, 300), ...ctx.code ? { code: ctx.code.slice(0, 40) } : {}, cwd: cwd === null ? null : cwd.slice(0, 300), cwd_exists: cwdExists };
    appendFileSync2(file, `${JSON.stringify(row)}
`, { mode: 384 });
  };
}
function realDeps() {
  return {
    git: makeGit(),
    readFile: (p) => {
      try {
        return readFileSync2(p, "utf8");
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
    env: process.env,
    logError: makeErrorLogger(process.env)
  };
}
async function main2() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  console.log(handle(Buffer.concat(chunks).toString("utf-8"), realDeps()));
}
if (!process.env.VITEST) {
  main2().catch((err) => {
    logGuardError(HOOK, err);
    console.log("{}");
  });
}
export {
  CCV3_REPO,
  GIT_NOT_FOUND,
  GIT_TIMEOUT_MS,
  MAX_STAMP_AGE_MS,
  PATHWAY_REL,
  STAMP_REL,
  bodyFileOf,
  decide,
  handle,
  hasOverride,
  headBranchOf,
  isCcv3Remote,
  makeErrorLogger,
  makeGit,
  namedRepo,
  resolveGit,
  runnableFile
};
