#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/commit-preflight.ts
import { readFileSync as readFileSync3 } from "fs";
import { isAbsolute as isAbsolute2, resolve as resolve3 } from "path";

// src/shared/done-proof.ts
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join as join2, resolve } from "path";

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
var VERIFY = "node ~/.claude/scripts/verify.mjs";
var RATCHETS = [/\bcontext-budget-guard\b/, /\baudit-skills\b/];
function isRatchet(command) {
  return !!command && RATCHETS.some((re) => re.test(command));
}
function readTestRun(sessionId) {
  try {
    const file = getStateFile(sessionId);
    if (!file || !existsSync(file)) return null;
    const raw = readFileSync(file, "utf8");
    if (!raw.trim()) return null;
    const s = JSON.parse(raw);
    if (typeof s?.lastTestRun !== "number" || !s.lastTestRun) return null;
    return {
      lastTestRun: s.lastTestRun,
      command: typeof s.command === "string" ? s.command : void 0,
      ok: typeof s.ok === "boolean" ? s.ok : null
    };
  } catch {
    return null;
  }
}
var MAX_SIDECARS = 50;
function latestSidecar(repoRoot) {
  const dir = join2(repoRoot, ".claude", "cache", "e2e");
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".log.json"));
  } catch {
    return null;
  }
  const newest = names.map((n) => {
    try {
      return { n, t: statSync(join2(dir, n)).mtimeMs };
    } catch {
      return { n, t: 0 };
    }
  }).sort((a, b) => b.t - a.t).slice(0, MAX_SIDECARS);
  let best = null;
  let bestAt = -Infinity;
  for (const { n } of newest) {
    try {
      const j = JSON.parse(readFileSync(join2(dir, n), "utf8"));
      const at = Date.parse(j.started);
      if (Number.isNaN(at) || at <= bestAt) continue;
      bestAt = at;
      best = {
        exit: typeof j.exit === "number" ? j.exit : null,
        started: typeof j.started === "string" ? j.started : null,
        finished: typeof j.finished === "string" ? j.finished : null,
        head: typeof j.head === "string" ? j.head : null,
        artifact: typeof j.artifact === "string" ? j.artifact : void 0
      };
    } catch {
    }
  }
  return best;
}
var normPath = (p) => resolve(p).replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
var defaultRegistryPath = () => join2(homedir(), ".claude", "project-registry.json");
function hasE2e(repoRoot, mainRoot, registryPath = defaultRegistryPath()) {
  try {
    const reg = JSON.parse(readFileSync(registryPath, "utf8").replace(/^\uFEFF/, ""));
    const roots = /* @__PURE__ */ new Set([normPath(repoRoot), ...mainRoot ? [normPath(mainRoot)] : []]);
    return (reg.projects ?? []).some(
      (p) => p && typeof p.path === "string" && roots.has(normPath(p.path)) && p.e2e !== void 0 && p.e2e !== null
    );
  } catch {
    return false;
  }
}
var sidecarAt = (s) => Date.parse(s.finished ?? s.started ?? "");
var SKEW_MS = MIN;
var fresh = (at, now, window) => now - at > -SKEW_MS && now - at < window;
function runProves(run, now) {
  return !!run && fresh(run.lastTestRun, now, PROOF_WINDOW_MS) && !isRatchet(run.command) && run.ok !== false;
}
var HEX_HEAD = /^[0-9a-f]{7,40}$/i;
function headMatches(sidecar, head) {
  return !!sidecar.head && !!head && HEX_HEAD.test(sidecar.head) && head.toLowerCase().startsWith(sidecar.head.toLowerCase());
}
function sidecarProves(s, head, now) {
  if (s.exit !== 0 || !s.finished) return false;
  return fresh(Date.parse(s.finished), now, PROOF_WINDOW_MS) && headMatches(s, head);
}
var shortCmd = (c) => (c ?? "unknown command").replace(/\s+/g, " ").slice(0, 120);
function failure(run, s, now) {
  const counted = run && !isRatchet(run.command) ? run : null;
  const sAt = s ? sidecarAt(s) : NaN;
  const sRecent = !!s && fresh(sAt, now, FAILURE_WINDOW_MS);
  const sidecarIsNewest = !counted || sAt >= counted.lastTestRun;
  if (s && sRecent && sidecarIsNewest && typeof s.exit === "number" && s.exit !== 0) {
    const message = `last verify exited ${s.exit} (${s.artifact ?? "no artifact"}): fix and re-run ${VERIFY}`;
    return { verdict: { kind: "failed", message }, at: sAt };
  }
  const passedSince = !!s && s.exit === 0 && sAt > (counted?.lastTestRun ?? Infinity);
  if (counted && counted.ok === false && fresh(counted.lastTestRun, now, FAILURE_WINDOW_MS) && !passedSince) {
    const message = `last test run failed (${shortCmd(counted.command)}): fix it and re-run it, or run ${VERIFY}`;
    return { verdict: { kind: "failed", message }, at: counted.lastTestRun };
  }
  if (s && sRecent && sidecarIsNewest && s.exit === null) {
    const message = `last verify (${s.artifact ?? "no artifact"}) is still running or was killed: let it finish or re-run ${VERIFY}`;
    return { verdict: { kind: "killed", message }, at: sAt };
  }
  return null;
}
function judge(i) {
  const { run, sidecar, head, now } = i;
  const proofAt = Math.max(
    runProves(run, now) ? run.lastTestRun : -Infinity,
    sidecar && sidecarProves(sidecar, head, now) ? sidecarAt(sidecar) : -Infinity
  );
  const bad = failure(run, sidecar, now);
  if (bad && bad.at > proofAt) return bad.verdict;
  if (proofAt > -Infinity) return { kind: "proven", message: "" };
  if (sidecar && sidecar.exit === 0 && sidecar.head && head && !headMatches(sidecar, head) && fresh(sidecarAt(sidecar), now, FAILURE_WINDOW_MS)) {
    return { kind: "stale", message: `verify ran on ${sidecar.head}, HEAD is ${head.slice(0, 7)}: re-run ${VERIFY}` };
  }
  if (!i.hasE2e) return { kind: "proven", message: "" };
  return {
    kind: "none",
    message: `no test run or verify sidecar in the last 5 minutes: run ${VERIFY} and cite its output`
  };
}

// src/shared/git-head.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, statSync as statSync2 } from "fs";
import { basename, dirname, isAbsolute, join as join3, resolve as resolve2 } from "path";
var SHA_RE = /^[0-9a-f]{40}$/i;
function read(path2) {
  try {
    return readFileSync2(path2, "utf8");
  } catch {
    return null;
  }
}
function findDotGit(start) {
  let dir = resolve2(start);
  for (; ; ) {
    if (existsSync2(join3(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function gitDirOf(root) {
  const dotGit = join3(root, ".git");
  if (statSync2(dotGit).isDirectory()) return dotGit;
  const m = (read(dotGit) ?? "").match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return null;
  const target = isAbsolute(m[1]) ? m[1] : resolve2(root, m[1]);
  return statSync2(target).isDirectory() ? target : null;
}
function commonDirOf(gitDir) {
  const rel = read(join3(gitDir, "commondir"))?.trim();
  if (!rel) return gitDir;
  return isAbsolute(rel) ? rel : resolve2(gitDir, rel);
}
function shaOfBranch(branch, gitDir, commonDir) {
  for (const dir of /* @__PURE__ */ new Set([gitDir, commonDir])) {
    const loose = read(join3(dir, "refs", "heads", ...branch.split("/")))?.trim();
    if (loose && SHA_RE.test(loose)) return loose;
  }
  const packed = read(join3(commonDir, "packed-refs")) ?? "";
  for (const line of packed.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{40})\s+refs\/heads\/(.+?)\s*$/i);
    if (m && m[2] === branch) return m[1];
  }
  return null;
}
function resolveHead(dir) {
  try {
    if (!dir || !existsSync2(dir)) return null;
    const repoRoot = findDotGit(dir);
    if (!repoRoot) return null;
    const gitDir = gitDirOf(repoRoot);
    if (!gitDir) return null;
    const commonDir = commonDirOf(gitDir);
    const mainRoot = basename(commonDir) === ".git" ? dirname(commonDir) : repoRoot;
    const head = read(join3(gitDir, "HEAD"))?.trim();
    if (!head) return null;
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return { repoRoot, mainRoot, branch: ref[1], sha: shaOfBranch(ref[1], gitDir, commonDir) };
    if (SHA_RE.test(head)) return { repoRoot, mainRoot, branch: null, sha: head };
    return null;
  } catch {
    return null;
  }
}

// src/shared/mask-quotes.ts
var BASH_STRING = /"(?:[^"\\]|\\[\s\S])*"|'[^']*'/g;
var PWSH_STRING = /"(?:[^"`]|`[\s\S])*"|'(?:[^']|'')*'/g;
var blank = (s) => s[0] + " ".repeat(s.length - 2) + s[s.length - 1];
function maskQuoted(command, tool = "Bash") {
  return command.replace(tool === "PowerShell" ? PWSH_STRING : BASH_STRING, blank);
}

// src/shared/unattended.ts
function isUnattended(input, env = process.env) {
  if (input.permission_mode === "bypassPermissions") return true;
  if (env.CLAUDE_AGENT_ID) return true;
  if (env.CI === "true" || env.CI === "1") return true;
  return false;
}

// src/shared/guard-log.ts
import { appendFileSync, mkdirSync } from "fs";
import { homedir as homedir2 } from "os";
import { dirname as dirname2, join as join4 } from "path";
var COMMAND_HEAD_CHARS = 80;
var REASON_CHARS = 200;
function guardLogPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir2();
  return env.CCV3_GUARD_DECISIONS_LOG || join4(home, ".claude", "logs", "guard-decisions.jsonl");
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
    const path2 = guardLogPath(env);
    mkdirSync(dirname2(path2), { recursive: true, mode: 448 });
    appendFileSync(path2, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}

// src/commit-preflight.ts
var COMMAND_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var PROTECTED_BRANCHES = /* @__PURE__ */ new Set(["main", "master"]);
var FEAT_OR_FIX = /^(feat|fix)(\(|:|!)/;
var VAL = String.raw`(?:"[^"]*"|'[^']*'|[^\s"']+)`;
var GLOBAL_OPT = String.raw`(?:\s+(?:-C\s+${VAL}|-c\s+(?:[^\s"']|"[^"]*"|'[^']*')+|--(?:git-dir|work-tree|namespace)(?:=|\s+)${VAL}|--no-pager|--no-replace-objects|--bare|-P))*`;
var CALL_START = String.raw`(?:^\s*|[;&|(\n{]\s*|\b(?:then|do|else)\s+)(?:&\s+)?(?:\w+=\S*\s+)*(?:(?:time|sudo|command|exec|nohup)\s+)*`;
var PATH_PREFIX = String.raw`(?:[^\s;&|()]*[\\/])?`;
var PWSH_PREFIX = String.raw`(?:(?:pwsh|powershell)(?:\.exe)?(?:\s+-[A-Za-z]+(?:\s+[^-\s]\S*)?)*?\s+-File\s+)?`;
var GIT_CALL = new RegExp(
  String.raw`(${CALL_START})(${PATH_PREFIX}git(?:\.exe)?|"\s*"|'\s*')(${GLOBAL_OPT})(\s+commit)(?=\s|$)`,
  "g"
);
var SAFE_CALL = new RegExp(
  String.raw`(${CALL_START})(${PWSH_PREFIX}(?:${PATH_PREFIX}git-safe\.ps1|"\s*"|'\s*'))(${GLOBAL_OPT})(\s+commit)(?=\s|$)`,
  "g"
);
var isGitToken = (raw) => /(?:^|[\\/"'])git(?:\.exe)?["']?$/i.test(raw);
var isSafeToken = (raw) => /git-safe\.ps1/i.test(raw);
function findCommits(command, masked) {
  const calls = [];
  for (const [re, valid] of [[GIT_CALL, isGitToken], [SAFE_CALL, isSafeToken]]) {
    for (const m of masked.matchAll(re)) {
      const tokenStart = m.index + m[1].length;
      if (!valid(command.slice(tokenStart, tokenStart + m[2].length))) continue;
      const optsStart = tokenStart + m[2].length;
      calls.push({ index: m.index, end: m.index + m[0].length, opts: command.slice(optsStart, optsStart + m[3].length) });
    }
  }
  return calls.sort((a, b) => a.index - b.index);
}
var unquote = (s) => s.replace(/^(["'])(.*)\1$/, "$2");
var toNative = (p) => process.platform === "win32" ? p.replace(/^\/([A-Za-z])(?=\/|$)/, (_m, d) => `${d.toUpperCase()}:`) : p;
var CD = new RegExp(String.raw`(?:^\s*|[;&|(\n{]\s*)(?:cd|pushd|Set-Location|sl)(?:\s+-(?:Path|LiteralPath))?\s+(${VAL})`, "g");
var UNRESOLVABLE = /[$`%]|^~|^-$/;
function applyDir(dir, target) {
  const p = unquote(target);
  if (!p || UNRESOLVABLE.test(p)) return null;
  const native = toNative(p);
  return isAbsolute2(native) ? native : resolve3(dir, native);
}
function callDir(command, masked, call, cwd) {
  if (/--(?:git-dir|work-tree)\b/.test(call.opts)) return null;
  let dir = cwd;
  for (const m of masked.slice(0, call.index).matchAll(CD)) {
    const at = m.index + m[0].length - m[1].length;
    dir = applyDir(dir, command.slice(at, at + m[1].length));
    if (!dir) return null;
  }
  for (const m of call.opts.matchAll(/-C\s+("[^"]*"|'[^']*'|[^\s"']+)/g)) {
    dir = applyDir(dir, m[1]);
    if (!dir) return null;
  }
  return dir;
}
function firstLine(s) {
  return s.split(/\r?\n/)[0].trim();
}
function untilClosingQuote(s, q, escapes) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && escapes) {
      i++;
      continue;
    }
    if (s[i] === q) return s.slice(0, i);
  }
  return s;
}
function messageValueHead(value) {
  const s = value.trimStart();
  const open = s.match(/^(@?)(\$?)(["'])/);
  if (!open) return s.split(/\s/)[0];
  const body = s.slice(open[0].length);
  const heredoc = body.match(/^\$\(\s*cat\s*<<-?\s*['"]?\w+['"]?\s*\r?\n/);
  if (heredoc) return firstLine(body.slice(heredoc[0].length));
  if (open[1]) return firstLine(body.replace(/^\s*\r?\n/, ""));
  return firstLine(untilClosingQuote(body, open[3], open[3] === '"' || open[2] === "$"));
}
function fileHead(rawPath, dirs) {
  const p = unquote(rawPath);
  if (!p || p === "-") return null;
  const native = toNative(p);
  const candidates = isAbsolute2(native) ? [native] : dirs.map((d) => resolve3(d, native));
  for (const file of candidates) {
    try {
      const text = readFileSync3(file, "utf8").replace(/^\uFEFF/, "").trimStart();
      return text ? firstLine(text) : null;
    } catch {
    }
  }
  return null;
}
var MSG_FLAG = /(?:^|\s)(?:(-[A-Za-z]*m|--message)(?:=|\s+|(?=["']))|(-[A-Za-z]*F|--file)(?:=|\s+))/;
function messageHead(command, masked, call, dirs) {
  const maskedRest = masked.slice(call.end);
  const cut = maskedRest.search(/&&|\|\||[;|\n]/);
  const scope = cut < 0 ? maskedRest : maskedRest.slice(0, cut);
  const flag = MSG_FLAG.exec(scope);
  if (!flag) return null;
  const value = command.slice(call.end + flag.index + flag[0].length);
  if (flag[1]) return messageValueHead(value);
  const file = value.match(/^("[^"]*"|'[^']*'|\S+)/);
  return file ? fileHead(file[1], dirs) : null;
}
var isFeatOrFix = (head) => FEAT_OR_FIX.test(head) || head.startsWith("$");
function commitMessageHead(command, dir = process.cwd()) {
  const masked = maskQuoted(command);
  const call = findCommits(command, masked)[0];
  return call ? messageHead(command, masked, call, [dir]) : null;
}
function mainBranchText(branch, dir) {
  return `On branch ${branch} in ${dir}. Rule: no feature work on main. Create a branch first: git switch -c <type>/<name>. Approve only for a sync or release commit.`;
}
function preflight(input, opts = {}) {
  try {
    const tool = input?.tool_name || input?.tool || "";
    if (!COMMAND_TOOLS.has(tool)) return null;
    const command = input?.tool_input?.command;
    if (typeof command !== "string") return null;
    const masked = maskQuoted(command, tool);
    const calls = findCommits(command, masked);
    if (calls.length === 0) return null;
    const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    let warn = null;
    let judged = false;
    let mainText = null;
    for (const call of calls) {
      const dir = callDir(command, masked, call, cwd);
      const head = dir ? resolveHead(dir) : null;
      if (!dir || !head) continue;
      if (!judged) {
        judged = true;
        const verdict = judge({
          run: readTestRun(input?.session_id),
          sidecar: latestSidecar(head.repoRoot),
          head: head.sha,
          hasE2e: hasE2e(head.repoRoot, head.mainRoot, opts.registryPath),
          now: opts.now ?? Date.now()
        });
        warn = verdict.kind === "proven" ? null : `commit-preflight: ${verdict.message}`;
      }
      if (mainText || !head.branch || !PROTECTED_BRANCHES.has(head.branch)) continue;
      const msg = messageHead(command, masked, call, [dir, cwd]);
      if (msg !== null && isFeatOrFix(msg)) mainText = mainBranchText(head.branch, head.repoRoot);
    }
    if (!judged) return null;
    if (mainText && !isUnattended(input ?? {}, opts.env ?? process.env)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: mainText,
          ...warn ? { additionalContext: warn } : {}
        }
      };
    }
    const context = [warn, mainText].filter(Boolean).join("\n");
    if (!context) return null;
    return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context } };
  } catch {
    return null;
  }
}
function main() {
  let input = {};
  try {
    const raw = readFileSync3(0, "utf8").trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    console.log("{}");
    return;
  }
  const out = preflight(input);
  if (out?.hookSpecificOutput.permissionDecision === "ask") {
    logGuardDecision("commit-preflight", input, "ask", "commit-on-protected-branch", { command: String(input.tool_input?.command ?? "") });
  }
  console.log(JSON.stringify(out ?? {}));
}
if (!process.env.VITEST) {
  try {
    main();
  } catch {
    console.log("{}");
  }
}
export {
  commitMessageHead,
  preflight
};
