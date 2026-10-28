#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/pre-pr-gate.ts
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync2 } from "fs";
import { dirname as dirname2, isAbsolute, join as join3, resolve } from "path";

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
function isPrOpenCommand(command) {
  return isPrOpenText(joinContinuations(command, "bash")) || isPrOpenText(joinContinuations(command, "pwsh"));
}
function isPrOpenText(cmd) {
  if (PR_CREATE_RE.test(cmd)) return true;
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
    return head + `FIRST call the pr_watch tool with pr: ${info.number} (mcp__ccv3-mods__pr_watch), in this same turn. It watches the review bots the labels require (CodeRabbit while Greptile auto review is off) and CI for you and tells Dave and you at READY; never merge. Only if that tool does not exist, start the REVIEW LOOP instead: ${loopText(info)}. This applies to every PR in every session.`;
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

// src/shared/guard-log.ts
import { appendFileSync, mkdirSync as mkdirSync2 } from "fs";
import { homedir } from "os";
import { dirname, join as join2 } from "path";
var COMMAND_HEAD_CHARS = 80;
var REASON_CHARS = 200;
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
function logGuardDecision(hook, input, decision, reason, opts = {}) {
  const env = opts.env ?? process.env;
  try {
    if (!shouldWrite(env)) return;
    const agent = input?.agent_id || env.CLAUDE_AGENT_ID || void 0;
    const entry = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      hook,
      tool: input?.tool_name || input?.tool || "",
      decision,
      reason: maskSecrets(String(reason)).replace(/\s+/g, " ").trim().slice(0, REASON_CHARS),
      session_id: input?.session_id || ""
    };
    if (agent) entry.agent_id = agent;
    if (typeof opts.command === "string" && opts.command) entry.command = commandHead(opts.command);
    const path = guardLogPath(env);
    mkdirSync2(dirname(path), { recursive: true, mode: 448 });
    appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}

// src/pre-pr-gate.ts
var CCV3_REPO = "rev4nchist/continuous-claude-v3";
var STAMP_REL = ".claude/cache/pre-pr/stamp.json";
var MAX_STAMP_AGE_MS = 24 * 36e5;
var FUTURE_SLACK_MS = 5 * 6e4;
var GIT_TIMEOUT_MS = 2e3;
var ALLOWED_SKIP_REASONS = /* @__PURE__ */ new Set(["cli-missing"]);
var COMMAND_TOOLS2 = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var HOOK = "pre-pr-gate";
var RUN = "node scripts/github/pre-pr.mjs --body <file>";
var BODY_UNVERIFIABLE = "the PR body is not a file, so it cannot be matched to the body pre-pr.mjs checked. Pass the body as a file: -F body=@<file> (gh api) or --body-file <file> (gh pr create). An inline body, a body from stdin, --fill and --fill-first are denied";
var REPO_VALUE = "((?:https?:\\/\\/)?[\\w.-]+(?:\\/[\\w.-]+){1,2})";
var REPO_FLAG = new RegExp(`(?:^|\\s)(?:-R\\s*=?|--repo(?:\\s+|=))["']?${REPO_VALUE}`);
var GH_REPO_ASSIGN = new RegExp(`(?:^|[\\s;])(?:\\$env:)?GH_REPO\\s*=\\s*["']?${REPO_VALUE}`, "i");
var ownerRepo = (value) => value.replace(/^https?:\/\//i, "").split("/").slice(-2).join("/").replace(/\.git$/i, "").toLowerCase();
function namedRepo(command, env = {}) {
  const api = /repos\/([\w.-]+\/[\w.-]+)\/pulls\b/i.exec(command);
  if (api) return api[1].toLowerCase();
  const named = REPO_FLAG.exec(command)?.[1] ?? GH_REPO_ASSIGN.exec(command)?.[1] ?? (env.GH_REPO && new RegExp(`^${REPO_VALUE}$`).exec(env.GH_REPO.trim())?.[1]);
  return named ? ownerRepo(named) : null;
}
function headBranchOf(command) {
  const m = /(?:^|\s)(?:-[fF]|--(?:raw-)?field)\s*["']?head=["']?([^\s"']+)/.exec(command) ?? (/\bgh\s+pr\s+create\b/i.test(command) ? /(?:^|\s)(?:--head(?:\s+|=)|-H\s*)["']?([^\s"']+)/.exec(command) : null);
  return m ? m[1].replace(/^[^:\s]+:/, "").replace(/["']+$/, "") : null;
}
function isCcv3Remote(url) {
  const m = /github\.com[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m !== null && m[1].toLowerCase() === CCV3_REPO;
}
function workDir(command, cwd) {
  const m = /(?:^|[;&|]\s*|&&\s*)(?:cd|Set-Location|sl)\s+(?:-LiteralPath\s+|-Path\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/i.exec(command);
  if (!m) return cwd;
  const target = m[1].replace(/^["']|["']$/g, "");
  return isAbsolute(target) || /^[A-Za-z]:/.test(target) ? target : resolve(cwd, target);
}
var FIELD_BODY = /(?:^|\s)(?:-F|--field)\s*(?:"body=@([^"]+)"|'body=@([^']+)'|body=@(?:"([^"]+)"|'([^']+)'|([^\s"']+)))/;
var BODY_FILE = /(?:^|\s)--body-file(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/;
var SHORT_BODY_FILE = /(?:^|\s)-F\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))/;
var INLINE_BODY = /(?:^|\s)(?:--body(?![\w-])|-b)|(?:^|\s)(?:-f|--raw-field)\s*["']?body=|(?:^|\s)(?:-F|--field)\s*["']?body=(?!@)/;
var INPUT_FLAG = /(?:^|\s)--input(?![\w-])/;
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
  if (files.length !== 1 || INLINE_BODY.test(command) || INPUT_FLAG.test(command)) return null;
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
function decide(input, deps) {
  const raw = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  const command = joinContinuations(raw, shellOf(input));
  const d = gate(input, command, deps);
  return d.action === "deny" && hasOverride(command, deps.env) ? { action: "override" } : d;
}
function gate(input, command, deps) {
  if (!isPrOpenCommand(command)) return { action: "allow" };
  const dir = workDir(command, input.cwd || process.cwd());
  const named = namedRepo(command, deps.env);
  const isCcv3 = named !== null ? named === CCV3_REPO : isCcv3Checkout(deps, dir);
  if (!isCcv3) return { action: "allow" };
  const top = deps.git(dir, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return deny("no-checkout", `this command opens a PR in ${CCV3_REPO}, but ${dir} is not a git checkout, so no pre-PR stamp can be found`);
  if (named !== null && !isCcv3Checkout(deps, dir)) return deny("repo-identity", `this command names ${CCV3_REPO}, but ${dir} is not a CCv3 checkout, so its stamp does not count`);
  const bodyPath = singleBodyFile(command);
  if (bodyPath === null) return deny("body", BODY_UNVERIFIABLE);
  const root = top.stdout.trim();
  const branch = headBranchOf(command);
  const headRun = deps.git(root, ["rev-parse", branch ? `${branch}^{commit}` : "HEAD"]);
  if (headRun.status !== 0) return deny("head-unresolved", `cannot resolve the head ${branch ?? "HEAD"} in ${root}`);
  const head = headRun.stdout.trim();
  const body = { path: bodyPath, sha: sha256Of(deps.readFile(resolve(dir, bodyPath))) };
  const problems = stampRoots(deps, dir, root, branch).map((r) => stampProblem(deps.readFile(join3(r, STAMP_REL)), head, deps.now(), body));
  if (!problems.some((p) => p === null)) return deny("stamp", problems[0] ?? "no stamp");
  const pushed = pushedProblem(deps, root, branch, head);
  return pushed ? deny("pushed-head", pushed) : { action: "allow" };
}
var sha256Of = (text) => text === null ? null : createHash("sha256").update(text).digest("hex");
function handle(raw, deps) {
  let input = {};
  let command = "";
  let prCreate = false;
  try {
    try {
      input = JSON.parse(raw.trim() || "{}");
    } catch (parseErr) {
      try {
        deps.logError?.(String(parseErr?.message ?? parseErr));
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
    prCreate = isPrOpenCommand(command);
    const d = decide(input, deps);
    if (d.action === "override") logGuardDecision(HOOK, input, "override", "SKIP_PRE_PR_GATE", { command });
    if (d.action !== "deny") return "{}";
    logGuardDecision(HOOK, input, "deny", d.pattern, { command });
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } });
  } catch (err) {
    const message = String(err?.message ?? err);
    try {
      deps.logError?.(message);
    } catch {
    }
    if (!prCreate) return "{}";
    if (hasOverride(joinContinuations(command, shellOf(input)), deps.env)) {
      logGuardDecision(HOOK, input, "override", "SKIP_PRE_PR_GATE", { command });
      return "{}";
    }
    logGuardDecision(HOOK, input, "deny", "verify-error", { command });
    const reason = `BLOCKED (pre-pr-gate): could not verify the pre-PR stamp (${message.slice(0, 200)}). Run the command again. If it keeps failing, ask Dave.

The stamp comes from: ${RUN}`;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  }
}
function makeGit(spawn = spawnSync, env = process.env) {
  const asked = Number(env.PRE_PR_GATE_GIT_TIMEOUT_MS);
  const timeout = Number.isFinite(asked) && asked > GIT_TIMEOUT_MS ? asked : GIT_TIMEOUT_MS;
  return (cwd, args) => {
    const r = spawn("git", args, { cwd, encoding: "utf8", timeout, windowsHide: true });
    if (r.error) throw r.error;
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
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
    logError: (message) => {
      const file = join3(dirname2(guardLogPath(process.env)), "pre-pr-gate-errors.jsonl");
      mkdirSync3(dirname2(file), { recursive: true });
      appendFileSync2(file, `${JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), hook: HOOK, error: message.slice(0, 300) })}
`);
    }
  };
}
async function main2() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  console.log(handle(Buffer.concat(chunks).toString("utf-8"), realDeps()));
}
if (!process.env.VITEST) {
  main2().catch(() => {
    console.log("{}");
  });
}
export {
  CCV3_REPO,
  GIT_TIMEOUT_MS,
  MAX_STAMP_AGE_MS,
  STAMP_REL,
  bodyFileOf,
  decide,
  handle,
  hasOverride,
  headBranchOf,
  isCcv3Remote,
  makeGit,
  namedRepo
};
