#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/rule-router.ts
import { readFileSync, readdirSync, appendFileSync as appendFileSync2, mkdirSync as mkdirSync2, openSync, closeSync, unlinkSync } from "fs";
import { homedir as homedir2, tmpdir } from "os";
import { join as join2, dirname as dirname2 } from "path";

// src/shared/output.ts
function outputContinue() {
  console.log(JSON.stringify({ result: "continue" }));
}
function outputDeny(reason, decision = "deny") {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason
    }
  }));
}

// src/shared/guard-log.ts
import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
var COMMAND_HEAD_CHARS = 80;
var REASON_CHARS = 200;
function guardLogPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir();
  return env.CCV3_GUARD_DECISIONS_LOG || join(home, ".claude", "logs", "guard-decisions.jsonl");
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
    mkdirSync(dirname(path), { recursive: true, mode: 448 });
    appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}

// src/shared/destructive-classifier.ts
var LEAD_ITEM = String.raw`(?:[A-Za-z_]\w*=\S*|\$\w+\s*=|\[\w+\]|\(|\{|\)|&|\.|sudo|time|nohup|call|(?:try|else|finally|do|ForEach-Object|ForEach|Where-Object|%)\s*\{|(?:if|elseif|foreach|while|switch)\s*\((?:[^()]|\([^()]*\))*\)\s*\{)`;
var SEG_START = String.raw`^\s*(?:${LEAD_ITEM}\s*)*`;
var HTTP_CLIENT = String.raw`(?:az(?:\.cmd|\.exe)?\s+rest|fab(?:\.exe)?\s+api|curl(?:\.exe)?|Invoke-RestMethod|Invoke-WebRequest|Invoke-AzRestMethod|irm|iwr)\b`;
var methodIs = (verbs) => String.raw`(?=.*(?:(?:--method|--request|-(?:Custom)?Meth\w*)[\s=:]+["']?(?:${verbs})\b|\s-[Xm]\s*["']?(?:${verbs})\b))`;
var CAPACITY_RESOURCE = String.raw`.*(?:Microsoft\.(?:Fabric|PowerBIDedicated)/|management\.azure\.com\S*/)capacities/[^/\s"'?#]+/?(?:[?#"'\s]|$)`;
var seg = (rest) => new RegExp(SEG_START + rest, "i");
var SEGMENT_PATTERNS = [
  { name: "Fabric capacity suspend/resume/resize/delete", re: seg(String.raw`az(?:\.cmd|\.exe)?\s+fabric\s+capacity\s+(?:suspend|resume|update|delete)\b`) },
  { name: "Az.Fabric capacity cmdlet (suspend/resume/update/remove)", re: seg(String.raw`(?:Suspend|Resume|Update|Remove)-AzFabricCapacity\b`) },
  // az resource on a capacity: delete, update (--set sku...), create (PUT), invoke-action suspend|resume.
  { name: "az resource change of a Fabric capacity", re: seg(String.raw`az(?:\.cmd|\.exe)?\s+resource\s+(?:delete|update|create|invoke-action)\b.*Microsoft\.(?:Fabric|PowerBIDedicated)/capacities`) },
  // Fabric CLI verbs that act on a capacity path (.capacities/<name>.Capacity). Case-sensitive on purpose.
  { name: "Fabric CLI capacity stop/start/set/rm/create", re: new RegExp(SEG_START + String.raw`fab(?:\.exe)?\s+(?:stop|start|set|rm|create)\b.*(?:\.capacities[\\/]|\.Capacity(?:["'\s]|$))`) },
  { name: "Fabric capacity suspend/resume via REST", re: seg(HTTP_CLIENT + String.raw`.*/capacities/[^/\s"'?#]+/(?:suspend|resume)\b`) },
  // ARM PATCH, PUT or DELETE on the capacity resource itself changes its SKU or removes it. GET and subpaths stay allowed.
  { name: "Fabric capacity SKU change or delete via REST (PATCH/PUT/DELETE)", re: seg(HTTP_CLIENT + methodIs("patch|put|delete") + CAPACITY_RESOURCE) },
  // PUT .../dataAccessRoles replaces EVERY OneLake role (DefaultReader too). A named role
  // (.../dataAccessRoles/<name>) and POST are not the bulk replace.
  { name: "OneLake bulk PUT dataAccessRoles (replaces ALL roles)", re: seg(HTTP_CLIENT + methodIs("put") + String.raw`.*/dataAccessRoles/?(?:[?#"'\s]|$)`) }
];
function stripQuotedStrings(command, tool = "Bash") {
  if (tool === "PowerShell") {
    return command.replace(/"(?:[^"`]|`.)*"/g, '""').replace(/'(?:[^']|'')*'/g, "''");
  }
  return command.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
}
function parseExecutable(command) {
  const segments = [];
  const substitutions = [];
  let seg2 = "";
  let inSingle = false;
  let inDouble = false;
  const n = command.length;
  let i = 0;
  const pushSeg = () => {
    const t = seg2.trim();
    if (t) segments.push(t);
    seg2 = "";
  };
  while (i < n) {
    const c = command[i];
    const next = command[i + 1];
    if (inSingle) {
      seg2 += c;
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (c === "\\" && next !== void 0) {
        seg2 += c + next;
        i += 2;
        continue;
      }
      if (c === '"') {
        inDouble = false;
        seg2 += c;
        i++;
        continue;
      }
      if (c === "$" && next === "(") {
        const { inner, end } = readBalanced(command, i + 2, "(", ")");
        substitutions.push(inner);
        seg2 += command.slice(i, end);
        i = end;
        continue;
      }
      if (c === "`") {
        const { inner, end } = readBacktick(command, i + 1);
        substitutions.push(inner);
        seg2 += command.slice(i, end);
        i = end;
        continue;
      }
      seg2 += c;
      i++;
      continue;
    }
    if (c === "\\" && next !== void 0) {
      seg2 += c + next;
      i += 2;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      seg2 += c;
      i++;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      seg2 += c;
      i++;
      continue;
    }
    if (c === "$" && next === "(") {
      const { inner, end } = readBalanced(command, i + 2, "(", ")");
      substitutions.push(inner);
      seg2 += command.slice(i, end);
      i = end;
      continue;
    }
    if (c === "`") {
      const { inner, end } = readBacktick(command, i + 1);
      substitutions.push(inner);
      seg2 += command.slice(i, end);
      i = end;
      continue;
    }
    if (c === ";" || c === "\n") {
      pushSeg();
      i++;
      continue;
    }
    if (c === "&" && next === "&" || c === "|" && next === "|") {
      pushSeg();
      i += 2;
      continue;
    }
    if (c === "|" || c === "&") {
      pushSeg();
      i++;
      continue;
    }
    seg2 += c;
    i++;
  }
  pushSeg();
  return { segments, substitutions };
}
function readBalanced(s, start, open, close) {
  let depth = 1;
  let i = start;
  let inS = false;
  let inD = false;
  while (i < s.length) {
    const c = s[i];
    if (inS) {
      if (c === "'") inS = false;
      i++;
      continue;
    }
    if (inD) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') inD = false;
      i++;
      continue;
    }
    if (c === "'") {
      inS = true;
      i++;
      continue;
    }
    if (c === '"') {
      inD = true;
      i++;
      continue;
    }
    if (c === "$" && s[i + 1] === open) {
      depth++;
      i += 2;
      continue;
    }
    if (c === open) {
      depth++;
      i++;
      continue;
    }
    if (c === close) {
      depth--;
      if (depth === 0) return { inner: s.slice(start, i), end: i + 1 };
      i++;
      continue;
    }
    i++;
  }
  return { inner: s.slice(start), end: s.length };
}
function readBacktick(s, start) {
  let i = start;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s[i] === "`") return { inner: s.slice(start, i), end: i + 1 };
    i++;
  }
  return { inner: s.slice(start), end: s.length };
}
var WRAPPER_RES = [
  // POSIX shells: bash|sh|zsh|dash|ksh|ash ... -c|-...c "<payload>". The launcher
  // prefix allows flags (env -i, sudo -E) before the interpreter (round-2 fix).
  /^(?:(?:sudo|env|nohup|time)(?:\s+-\S+)*\s+|[^\s=]+=\S+\s+)*(?:bash|sh|zsh|dash|ksh|ash)\b[^'"]*?\s-[a-z]*c\b\s*("(?:[^"\\]|\\.)*"|'[^']*'|\S.*)$/i,
  // PowerShell: powershell|pwsh ... -c|-Command "<payload>"
  /^(?:(?:sudo|env)\s+)?(?:powershell|pwsh)(?:\.exe)?\b[^'"]*?\s-c(?:ommand)?\b\s*("(?:[^"\\]|\\.)*"|'[^']*'|\S.*)$/i,
  // cmd: cmd[.exe] /c|/k "<payload>"
  /^(?:(?:sudo|env)\s+)?cmd(?:\.exe)?\b[^'"]*?\s\/[ck]\b\s*("(?:[^"\\]|\\.)*"|'[^']*'|\S.*)$/i
];
function unwrapPayload(raw) {
  let s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1);
  }
  return s.replace(/\\(["'`$\\])/g, "$1");
}
function wrapperPayloadsFromSegments(segments) {
  const out = [];
  for (const seg2 of segments) {
    for (const re of WRAPPER_RES) {
      const m = seg2.match(re);
      if (m && m[1]) {
        out.push(unwrapPayload(m[1]));
        break;
      }
    }
  }
  return out;
}
function extractShellWrapperPayloads(command) {
  try {
    return wrapperPayloadsFromSegments(parseExecutable(command).segments);
  } catch {
    return [];
  }
}

// src/rule-router.ts
var REARM_SOURCES = /* @__PURE__ */ new Set(["compact", "clear"]);
var COMMAND_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var AGENT_TOOLS = /* @__PURE__ */ new Set(["Task", "Agent"]);
function rulesDir() {
  return process.env.CLAUDE_RULES_ONDEMAND_DIR || join2(homedir2(), ".claude", "rules-ondemand");
}
function splitUnquoted(command, tool) {
  const escape = tool === "PowerShell" ? "`" : "\\";
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === escape && quote === '"' && i + 1 < command.length) cur += command[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === escape && i + 1 < command.length) {
      cur += c + command[++i];
      continue;
    }
    if (c === "#" && (cur === "" || /\s$/.test(cur))) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}
function stripLeaders(segment) {
  let s = segment.trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/^&\s*/, "").replace(/^cmd(\.exe)?\s+\/[cC]\s+/, "").replace(/^env(\s+-u\s+\S+|\s+-i)*\s+/, "").replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "").replace(/^(sudo|time|npx(\s+-y)?)\s+/, "").trim();
  } while (s !== prev);
  return s;
}
function quotedSegments(command, tool, depth = 0) {
  const top = splitUnquoted(command, tool).map(stripLeaders).filter(Boolean);
  if (depth >= 3) return top;
  let nested = [];
  try {
    nested = [...parseExecutable(command).substitutions, ...extractShellWrapperPayloads(command)];
  } catch {
  }
  return [...top, ...nested.flatMap((n) => quotedSegments(n, tool, depth + 1))];
}
function commandSegments(command, tool) {
  return quotedSegments(command, tool).map((s) => stripLeaders(stripQuotedStrings(s, tool))).filter(Boolean);
}
var test = (patterns, value) => !!patterns && patterns.some((p) => new RegExp(p).test(value));
function matchRules(input, manifest) {
  const tool = input.tool_name || "";
  const ti = input.tool_input || {};
  return manifest.rules.filter((r) => {
    if (COMMAND_TOOLS.has(tool)) {
      const command = typeof ti.command === "string" ? ti.command : "";
      if (!command) return false;
      return commandSegments(command, tool).some((seg2) => test(r.command, seg2)) || quotedSegments(command, tool).some((seg2) => test(r.segment, seg2));
    }
    if (AGENT_TOOLS.has(tool)) return test(r.agent, String(ti.subagent_type || ""));
    if (tool === "Skill") return test(r.skill, String(ti.skill || ""));
    return test(r.tools, tool);
  });
}
function stateDir(input) {
  const key = `${input.session_id || "no-session"}-${input.agent_id || process.env.CLAUDE_AGENT_ID || "main"}`;
  return join2(process.env.CLAUDE_RULE_ROUTER_STATE_DIR || tmpdir(), `rule-router-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`);
}
function blockedDir(input) {
  const key = (input.session_id || "no-session").replace(/[^A-Za-z0-9_-]/g, "_");
  return join2(process.env.CLAUDE_RULE_ROUTER_STATE_DIR || tmpdir(), `rule-router-blocked-${key}`);
}
function isSubagent(input) {
  return !!(input.agent_id || process.env.CLAUDE_AGENT_ID);
}
function claim(dir, id) {
  try {
    mkdirSync2(dir, { recursive: true });
    closeSync(openSync(join2(dir, id), "wx"));
    return true;
  } catch {
    return false;
  }
}
function ruleText(entry, dir) {
  return entry.files.map((f) => `----- ~/.claude/rules-ondemand/${f} -----
${readFileSync(join2(dir, f), "utf8").trim()}`).join("\n\n");
}
function falseFireFooter(ids) {
  const script = join2(process.env.CCV3_REPO || join2(homedir2(), "continuous-claude"), "scripts", "rules", "rule-router-false-fires.mjs").replace(/\\/g, "/");
  return `

----- If a rule above is NOT about this call -----
Record the false fire, then carry on: \`node ${script} add --rule <${ids.join("|")}> --what "<first words of the call>" --note "<why it does not apply>" --source agent\``;
}
function decide(matched, seen, dir) {
  const fresh = matched.filter((r) => !seen.includes(r.id));
  if (fresh.length === 0) return { kind: "none", ids: [], text: "" };
  const ids = fresh.map((r) => r.id);
  const body = fresh.map((r) => ruleText(r, dir)).join("\n\n") + falseFireFooter(ids);
  if (fresh.some((r) => r.mode === "deny-first")) {
    return {
      kind: "deny",
      ids,
      text: `[rule-router] Read the rule below before this call runs (${ids.join(", ")}). It blocks once per session per rule. If the call still fits the rule, re-issue it unchanged; otherwise change course (for a confirm-first action, ask Dave first).

${body}`
    };
  }
  return { kind: "inject", ids, text: `[rule-router] On-demand rule for this call (${ids.join(", ")}):

${body}` };
}
function triggerWords(input, fired) {
  const tool = input.tool_name || "";
  const ti = input.tool_input || {};
  if (!COMMAND_TOOLS.has(tool)) return String(ti.subagent_type ?? ti.skill ?? tool).slice(0, 60);
  const segs = quotedSegments(String(ti.command ?? ""), tool);
  const plain = (seg3) => stripLeaders(stripQuotedStrings(seg3, tool));
  const hit = segs.find((seg3) => fired.some((r) => test(r.command, plain(seg3)) || test(r.segment, seg3)));
  const seg2 = hit ?? segs[0] ?? "";
  const [cmd = "", arg] = plain(seg2).split(/\s+/);
  const words = arg === void 0 ? cmd : `${cmd} ${/^[-\w.]+$/.test(arg) ? arg : "<arg>"}`;
  const script = /(?:^|[\s"'\\/])([\w.-]+\.(?:ps1|mjs|cjs|js|py|sh|bat))(?=["'\s]|$)/i.exec(seg2)?.[1];
  return script && !words.includes(script) ? `${words} ${script}` : words;
}
function logFire(input, d, fired, extra = {}) {
  try {
    const path = process.env.CLAUDE_RULE_ROUTER_LOG || join2(homedir2(), ".claude", "logs", "rule-router.jsonl");
    mkdirSync2(dirname2(path), { recursive: true });
    const what = d.kind === "rearm" ? `SessionStart ${input.source}` : triggerWords(input, fired);
    appendFileSync2(path, JSON.stringify({
      // The same session and agent identity the claim markers use, so the audit's dedupe key matches.
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      session: input.session_id || "no-session",
      agent: input.agent_id || process.env.CLAUDE_AGENT_ID || "main",
      tool: input.tool_name,
      rules: d.ids,
      kind: d.kind,
      what,
      ...extra
    }) + "\n");
  } catch {
  }
}
function rearm(input) {
  const dir = stateDir({ session_id: input.session_id });
  let ids;
  try {
    ids = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const id of ids) {
    try {
      unlinkSync(join2(dir, id));
      removed++;
    } catch {
    }
  }
  return removed;
}
function onSessionStart(input) {
  if (REARM_SOURCES.has(input.source || "")) {
    const removed = rearm(input);
    logFire(input, { kind: "rearm", ids: [], text: "" }, [], { source: input.source, removed });
  }
  console.log("{}");
}
function run(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    outputContinue();
    return;
  }
  if (input.hook_event_name === "SessionStart") {
    onSessionStart(input);
    return;
  }
  const dir = rulesDir();
  const manifest = JSON.parse(readFileSync(join2(dir, "manifest.json"), "utf8"));
  const matched = matchRules(input, manifest);
  if (matched.length === 0) {
    outputContinue();
    return;
  }
  const state = stateDir(input);
  const won = matched.filter((r) => claim(state, r.id));
  const sessionClaims = [];
  const downgraded = [];
  const toShow = won.map((r) => {
    if (r.mode !== "deny-first") return r;
    if (claim(blockedDir(input), r.id)) {
      sessionClaims.push(r.id);
      return r;
    }
    if (!isSubagent(input) || r.subagent === "block") return r;
    downgraded.push(r.id);
    return { ...r, mode: "inject" };
  });
  let d;
  try {
    d = decide(toShow, [], dir);
  } catch (err) {
    for (const r of won) {
      try {
        unlinkSync(join2(state, r.id));
      } catch {
      }
    }
    for (const id of sessionClaims) {
      try {
        unlinkSync(join2(blockedDir(input), id));
      } catch {
      }
    }
    throw err;
  }
  if (d.kind === "none") {
    outputContinue();
    return;
  }
  logFire(input, d, won, downgraded.length ? { downgraded } : {});
  if (d.kind === "deny") {
    logGuardDecision("rule-router", input, "deny", `rule-block: ${d.ids.join(",")}`);
    outputDeny(d.text, "deny");
  } else {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: d.text } }));
  }
}
function main() {
  try {
    run(readFileSync(0, "utf8"));
  } catch {
    outputContinue();
  }
}
if ((process.argv[1] || "").includes("rule-router")) {
  main();
}
export {
  commandSegments,
  decide,
  matchRules,
  quotedSegments,
  rearm,
  rulesDir,
  run,
  splitUnquoted,
  triggerWords
};
