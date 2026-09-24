#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/rule-router.ts
import { readFileSync, appendFileSync, mkdirSync, openSync, closeSync, unlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, dirname } from "path";

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

// src/shared/destructive-classifier.ts
function stripQuotedStrings(command, tool = "Bash") {
  if (tool === "PowerShell") {
    return command.replace(/"(?:[^"`]|`.)*"/g, '""').replace(/'(?:[^']|'')*'/g, "''");
  }
  return command.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
}
function parseExecutable(command) {
  const segments = [];
  const substitutions = [];
  let seg = "";
  let inSingle = false;
  let inDouble = false;
  const n = command.length;
  let i = 0;
  const pushSeg = () => {
    const t = seg.trim();
    if (t) segments.push(t);
    seg = "";
  };
  while (i < n) {
    const c = command[i];
    const next = command[i + 1];
    if (inSingle) {
      seg += c;
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (c === "\\" && next !== void 0) {
        seg += c + next;
        i += 2;
        continue;
      }
      if (c === '"') {
        inDouble = false;
        seg += c;
        i++;
        continue;
      }
      if (c === "$" && next === "(") {
        const { inner, end } = readBalanced(command, i + 2, "(", ")");
        substitutions.push(inner);
        seg += command.slice(i, end);
        i = end;
        continue;
      }
      if (c === "`") {
        const { inner, end } = readBacktick(command, i + 1);
        substitutions.push(inner);
        seg += command.slice(i, end);
        i = end;
        continue;
      }
      seg += c;
      i++;
      continue;
    }
    if (c === "\\" && next !== void 0) {
      seg += c + next;
      i += 2;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      seg += c;
      i++;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      seg += c;
      i++;
      continue;
    }
    if (c === "$" && next === "(") {
      const { inner, end } = readBalanced(command, i + 2, "(", ")");
      substitutions.push(inner);
      seg += command.slice(i, end);
      i = end;
      continue;
    }
    if (c === "`") {
      const { inner, end } = readBacktick(command, i + 1);
      substitutions.push(inner);
      seg += command.slice(i, end);
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
    seg += c;
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
  for (const seg of segments) {
    for (const re of WRAPPER_RES) {
      const m = seg.match(re);
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
var COMMAND_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var AGENT_TOOLS = /* @__PURE__ */ new Set(["Task", "Agent"]);
function rulesDir() {
  return process.env.CLAUDE_RULES_ONDEMAND_DIR || join(homedir(), ".claude", "rules-ondemand");
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
      return commandSegments(command, tool).some((seg) => test(r.command, seg)) || quotedSegments(command, tool).some((seg) => test(r.segment, seg));
    }
    if (AGENT_TOOLS.has(tool)) return test(r.agent, String(ti.subagent_type || ""));
    if (tool === "Skill") return test(r.skill, String(ti.skill || ""));
    return test(r.tools, tool);
  });
}
function stateDir(input) {
  const key = `${input.session_id || "no-session"}-${input.agent_id || process.env.CLAUDE_AGENT_ID || "main"}`;
  return join(process.env.CLAUDE_RULE_ROUTER_STATE_DIR || tmpdir(), `rule-router-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`);
}
function claim(dir, id) {
  try {
    mkdirSync(dir, { recursive: true });
    closeSync(openSync(join(dir, id), "wx"));
    return true;
  } catch {
    return false;
  }
}
function ruleText(entry, dir) {
  return entry.files.map((f) => `----- ~/.claude/rules-ondemand/${f} -----
${readFileSync(join(dir, f), "utf8").trim()}`).join("\n\n");
}
function decide(matched, seen, dir) {
  const fresh = matched.filter((r) => !seen.includes(r.id));
  if (fresh.length === 0) return { kind: "none", ids: [], text: "" };
  const ids = fresh.map((r) => r.id);
  const body = fresh.map((r) => ruleText(r, dir)).join("\n\n");
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
function logFire(input, d) {
  try {
    const path = process.env.CLAUDE_RULE_ROUTER_LOG || join(homedir(), ".claude", "logs", "rule-router.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    const ti = input.tool_input || {};
    const tool = input.tool_name || "";
    const what = COMMAND_TOOLS.has(tool) ? (commandSegments(String(ti.command ?? ""), tool)[0] || "").split(/\s+/).slice(0, 2).join(" ") : String(ti.subagent_type ?? ti.skill ?? "").slice(0, 60);
    appendFileSync(path, JSON.stringify({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      session: (input.session_id || "").slice(0, 8),
      agent: input.agent_id || null,
      tool: input.tool_name,
      rules: d.ids,
      kind: d.kind,
      what
    }) + "\n");
  } catch {
  }
}
function run(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    outputContinue();
    return;
  }
  const dir = rulesDir();
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const matched = matchRules(input, manifest);
  if (matched.length === 0) {
    outputContinue();
    return;
  }
  const state = stateDir(input);
  const won = matched.filter((r) => claim(state, r.id));
  let d;
  try {
    d = decide(won, [], dir);
  } catch (err) {
    for (const r of won) {
      try {
        unlinkSync(join(state, r.id));
      } catch {
      }
    }
    throw err;
  }
  if (d.kind === "none") {
    outputContinue();
    return;
  }
  logFire(input, d);
  if (d.kind === "deny") {
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
  rulesDir,
  run,
  splitUnquoted
};
