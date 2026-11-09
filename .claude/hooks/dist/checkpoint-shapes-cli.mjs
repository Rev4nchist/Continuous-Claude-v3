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
var APPLY_N = /(?:^|\s)--apply(?:=["']?\d+(?!\d)|\s+["']?\d+(?![\d>]))/;
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

// src/checkpoint-shapes-cli.ts
function shellArg(argv) {
  const i = argv.indexOf("--shell");
  const value = i >= 0 ? argv[i + 1] : void 0;
  return value === "bash" || value === "pwsh" ? value : null;
}
function reportOf(text, shell) {
  const joined = normalizeGh(joinContinuations(text, shell));
  return JSON.stringify({ ...shapesOf(joined), ccv3: namedRepo(joined, {}) === CCV3_REPO });
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}
async function main2() {
  const shell = shellArg(process.argv.slice(2));
  if (shell === null) {
    process.stderr.write("checkpoint-shapes-cli: --shell bash|pwsh is required\n");
    process.exitCode = 2;
    return;
  }
  const text = await readStdin();
  if (text.trim() === "") {
    process.stderr.write("checkpoint-shapes-cli: empty stdin: pass the command text on stdin\n");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${reportOf(text, shell)}
`);
}
if ((process.argv[1] || "").includes("checkpoint-shapes-cli")) {
  main2().catch((err) => {
    process.stderr.write(`checkpoint-shapes-cli: ${err instanceof Error ? err.message : String(err)}
`);
    process.exit(1);
  });
}
export {
  reportOf,
  shellArg
};
