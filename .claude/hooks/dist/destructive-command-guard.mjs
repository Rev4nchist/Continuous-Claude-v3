#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/shared/destructive-classifier.ts
var DESTRUCTIVE_PATTERNS = [
  // filesystem — recursive deletion only (single-file `rm -f x` is allowed).
  // Scans across SPLIT flag tokens so `rm -f -r x` / `rm --force --recursive x`
  // are caught, not just `rm -rf`. The terminal flag must be a SHORT cluster
  // containing r/R (-r, -rf, -fr) OR the long --recursive — NOT any long flag that
  // merely contains the letter r (round-2 FP fix: `rm --force` / `--verbose` /
  // `--interactive` are single-file deletes and must stay allowed).
  { name: "recursive rm", re: /\brm(?:\s+-{1,2}[^\s]+)*\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive\b)/i },
  { name: "find -delete", re: /\bfind\b[^&|;]*-delete\b/i },
  { name: "find -exec(dir) rm", re: /\bfind\b[^&|;]*-exec(?:dir)?\s+rm\b/i },
  // bulk delete via xargs — e.g. `find … | xargs rm`. Catches the non-recursive
  // form too (plain `xargs rm`), which the recursive-rm pattern alone misses.
  { name: "xargs rm", re: /\bxargs\b[^|&;]*\brm\b/i },
  // rsync --delete removes dest files absent from source; with an empty/sparse source
  // it wipes the destination tree. Only the --delete* variants are gated.
  { name: "rsync --delete", re: /\brsync\b[^&|;]*--delete(-\w+)?\b/i },
  { name: "dd to/from device", re: /\bdd\s+[^&|;]*\b(if|of)=/i },
  { name: "mkfs", re: /\bmkfs(\.\w+)?\b/i },
  // shred/wipefs/blkdiscard are bare verbs — anchor to a command POSITION (start,
  // or after a separator) so the word as an ARGUMENT (`echo shred`, `grep -r shred .`)
  // does NOT false-trigger (round-2 FP fix).
  { name: "shred", re: /(?:^|[;&|(]|&&|\|\|)\s*(?:sudo\s+)?shred\b/i },
  { name: "wipefs (disk signature wipe)", re: /(?:^|[;&|(]|&&|\|\|)\s*(?:sudo\s+)?wipefs\b/i },
  { name: "blkdiscard (device discard)", re: /(?:^|[;&|(]|&&|\|\|)\s*(?:sudo\s+)?blkdiscard\b/i },
  { name: "truncate to zero", re: /\btruncate\s+-s\s*0\b/i },
  { name: "write to block device", re: /(?:>|of=)\s*\/dev\/(sd|nvme|disk|hd)/i },
  // Windows cmd recursive/force delete (also reached via the `cmd /c …` wrapper).
  // rmdir /s is the Windows recursive form; POSIX `rmdir foo` (empty-dir only) has
  // no /s and stays allowed.
  { name: "rd/rmdir /s (recursive)", re: /\b(?:rd|rmdir)\b[^&|;]*\s\/s\b/i },
  { name: "del /f|/s (force/recursive)", re: /\bdel\b[^&|;]*\s\/[fs]\b/i },
  // git — history rewrite / working-tree or remote destruction
  { name: "git reset --hard", re: /\bgit\s+reset\s+--hard\b/i },
  { name: "git push --force", re: /\bgit\s+push\b[^&|;]*(--force(-with-lease)?|\s-f\b)/i },
  { name: "git push --delete", re: /\bgit\s+push\b[^&|;]*(--delete|\s-d\b)/i },
  { name: "git push --mirror", re: /\bgit\s+push\b[^&|;]*--mirror\b/i },
  // colon-refspec remote delete: `git push origin :branch`. The leading SPACE before
  // the colon distinguishes it from `src:dst` (a normal push to a remote branch).
  { name: "git push :refspec delete", re: /\bgit\s+push\b[^&|;]*\s:[^\s]/i },
  { name: "git clean -f", re: /\bgit\s+clean(?:\s+-{1,2}[^\s]+)*\s+-{1,2}[^\s]*f[^\s]*/i },
  { name: "git checkout discard", re: /\bgit\s+checkout\s+(--|\.)/i },
  // git restore discarding the WORKTREE (parity with `git checkout .`/`--`). `--staged`-only
  // (reversible unstage) and single-file `git restore file` are NOT gated (accepted).
  { name: "git restore discard", re: /\bgit\s+restore\b[^&|;]*(--worktree\b|\s\.(?:\s|$))/i },
  { name: "git switch --discard-changes", re: /\bgit\s+switch\b[^&|;]*--discard-changes\b/i },
  // case-SENSITIVE on the force letter so `git branch -d` (lowercase, merged-only,
  // safe) is NOT flagged — only `-D` / `-fD` / `--delete --force` (round-2 FP fix).
  { name: "git branch -D", re: /\bgit\s+branch\s+(-D\b|--delete\s+--force|--force\s+--delete|-[a-zA-Z]*D[a-zA-Z]*\s)/ },
  { name: "git worktree remove --force", re: /\bgit\s+worktree\s+remove\b[^&|;]*(--force|\s-f\b)/i },
  { name: "git submodule deinit -f", re: /\bgit\s+submodule\s+deinit\b[^&|;]*(--force|\s-f\b)/i },
  // bare `git rebase` rewrites history, but the recovery subcommands UNDO / continue an
  // in-progress rebase and must not be gated (round-2 FP fix).
  { name: "git rebase", re: /\bgit\s+rebase\b(?!\s+(--abort|--continue|--skip|--quit|--edit-todo|--show-current-patch)\b)/i },
  { name: "git stash clear/drop", re: /\bgit\s+stash\s+(clear|drop)\b/i },
  // `git stash -u` / `--include-untracked` / `--all` sweeps UNTRACKED files out of the
  // working tree; they come back only if someone finds and pops that stash. On 2026-09-17
  // this emptied a pre-demo FourthBot artifacts folder (45 files), recovered only because the
  // stash survived. Plain `git stash` (tracked changes) and pop/apply/list stay allowed.
  { name: "git stash -u (sweeps untracked files)", re: /\bgit\s+stash\b(?!\s+(?:list|show|pop|apply|branch|drop|clear|create|store)\b)[^&|;]*\s(?:-u|--include-untracked|-a|--all)\b/i },
  { name: "git update-ref -d", re: /\bgit\s+update-ref\s+-d\b/i },
  { name: "git reflog expire", re: /\bgit\s+reflog\s+expire\b/i },
  { name: "git gc --prune", re: /\bgit\s+gc\b[^&|;]*--prune/i },
  { name: "git filter-branch/repo", re: /\bgit\s+filter-(branch|repo)\b/i },
  // docker — volume/image/system destruction
  { name: "docker prune", re: /\bdocker\s+(system|volume|network|container|image)\s+prune\b/i },
  { name: "docker volume rm", re: /\bdocker\s+volume\s+rm\b/i },
  { name: "docker force rm", re: /\bdocker\s+(rm|rmi)\s+[^&|;]*(--force|-f\b|-\w*f\b)/i },
  // Fabric capacity: suspend/resume/resize/delete stops, bills or removes every workload on it.
  // Anchored to a command position so `grep az fabric capacity suspend` stays allowed.
  { name: "Fabric capacity suspend/resume/resize/delete", re: /(?:^|[;&|(]|&&|\|\|)\s*(?:sudo\s+)?az(?:\.cmd|\.exe)?\s+fabric\s+capacity\s+(?:suspend|resume|update|delete)\b/i }
];
var SEG_START = String.raw`^(?:[A-Za-z_]\w*=\S*\s+)*(?:\$\w+\s*=\s*)?(?:sudo\s+)?`;
var HTTP_CLIENT = String.raw`(?:az(?:\.cmd|\.exe)?\s+rest|fab(?:\.exe)?\s+api|curl(?:\.exe)?|Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\b`;
var METHOD_PUT_PATCH = String.raw`(?=.*(?:(?:--method|--request|-Method)[\s=]+["']?(?:patch|put)\b|\s-[Xm]\s*["']?(?:patch|put)\b))`;
var METHOD_PUT = String.raw`(?=.*(?:(?:--method|--request|-Method)[\s=]+["']?put\b|\s-[Xm]\s*["']?put\b))`;
var SEGMENT_PATTERNS = [
  { name: "Fabric capacity suspend/resume via REST", re: new RegExp(SEG_START + HTTP_CLIENT + String.raw`.*/capacities/[^/\s"'?]+/(?:suspend|resume)\b`, "i") },
  // ARM PATCH (or PUT) on the capacity resource itself changes its SKU. GET and subpaths stay allowed.
  { name: "Fabric capacity SKU change via REST (PATCH/PUT)", re: new RegExp(SEG_START + HTTP_CLIENT + METHOD_PUT_PATCH + String.raw`.*management\.azure\.com\S*/capacities/[^/\s"'?]+(?:[?"'\s]|$)`, "i") },
  // PUT .../dataAccessRoles replaces EVERY OneLake role (DefaultReader too). A named role
  // (.../dataAccessRoles/<name>) and POST are not the bulk replace.
  { name: "OneLake bulk PUT dataAccessRoles (replaces ALL roles)", re: new RegExp(SEG_START + HTTP_CLIENT + METHOD_PUT + String.raw`.*/dataAccessRoles(?:[?"'\s]|$)`, "i") }
];
var POWERSHELL_PATTERNS = [
  { name: "PowerShell recursive delete (Remove-Item -Recurse)", re: /(?:^|[;|&({]|\s)(?:Remove-Item|ri|rm|rmdir|rd|del|erase)\b[^;|&\n]*\s-(?:r|rec|recurse)\w*\b/i },
  { name: "PowerShell recursive delete ([IO.Directory]::Delete $true)", re: /\[(?:System\.)?IO\.Directory\]::Delete\([^)]*,\s*\$true\s*\)/i }
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
function normalizeGitGlobalOptions(scan) {
  return scan.replace(
    /\bgit((?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)|--namespace(?:=\S+|\s+\S+)|--no-pager|--no-replace-objects|--bare|-P))+)(?=\s)/gi,
    "git"
  );
}
function classifySegments(command, tool) {
  try {
    const joined = command.replace(/(?:`|\\)\r?\n/g, " ");
    const parseInput = tool === "PowerShell" ? joined.replace(/`./g, "") : joined;
    for (const seg of parseExecutable(parseInput).segments) {
      for (const p of SEGMENT_PATTERNS) if (p.re.test(seg)) return p.name;
    }
  } catch {
  }
  return null;
}
function classifyDestructive(command, depth = 0, tool = "Bash") {
  if (!command || typeof command !== "string") return null;
  const scan = normalizeGitGlobalOptions(stripQuotedStrings(command, tool));
  const patterns = tool === "PowerShell" ? [...DESTRUCTIVE_PATTERNS, ...POWERSHELL_PATTERNS] : DESTRUCTIVE_PATTERNS;
  for (const p of patterns) {
    if (p.re.test(scan)) return p.name;
  }
  const segHit = classifySegments(command, tool);
  if (segHit) return segHit;
  if (depth < 4) {
    try {
      const parseInput = tool === "PowerShell" ? command.replace(/`./g, "") : command;
      const { segments, substitutions } = parseExecutable(parseInput);
      const payloads = [...wrapperPayloadsFromSegments(segments), ...substitutions];
      for (const payload of payloads) {
        const inner = classifyDestructive(payload, depth + 1, tool);
        if (inner) return inner;
      }
    } catch {
    }
  }
  return null;
}

// src/destructive-command-guard.ts
var COMMAND_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
function isUnattended(input, env = process.env) {
  if (input.permission_mode === "bypassPermissions") return true;
  if (env.CLAUDE_AGENT_ID) return true;
  if (env.CI === "true" || env.CI === "1") return true;
  return false;
}
function decide(command, input, env = process.env) {
  if (env.SKIP_DESTRUCTIVE_GUARD === "1" || /^\s*SKIP_DESTRUCTIVE_GUARD=1\s+/.test(command) || /^\s*\$env:SKIP_DESTRUCTIVE_GUARD\s*=\s*['"]?1['"]?\s*;/i.test(command)) {
    return { decision: "allow" };
  }
  const pattern = classifyDestructive(command, 0, input.tool_name || input.tool || "Bash");
  if (!pattern) return { decision: "allow" };
  return { decision: isUnattended(input, env) ? "deny" : "ask", pattern };
}
function reasonFor(decision, pattern, command) {
  const head = decision === "deny" ? `BLOCKED (fail-closed): destructive command in an unattended/bypass context` : `CONFIRM: this is a destructive command`;
  return `${head}

Matched: ${pattern}
Command: ${command.slice(0, 300)}

${decision === "deny" ? `An interactive confirmation would hang a headless/autonomous run, so this is denied. If you genuinely intend it here, re-run with SKIP_DESTRUCTIVE_GUARD=1 prefixed (PowerShell tool: start the command with $env:SKIP_DESTRUCTIVE_GUARD='1'; ), or run it interactively.` : `Approve only if you intend this irreversible operation. (Gate: destructive-command-guard; see ~/.claude/docs/security/destructive-commands.md.)`}`;
}
async function main() {
  let input = {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    console.log("{}");
    return;
  }
  const tool = input.tool || input.tool_name;
  if (!tool || !COMMAND_TOOLS.has(tool)) {
    console.log("{}");
    return;
  }
  const command = input.tool_input?.command;
  if (typeof command !== "string" || !command.trim()) {
    console.log("{}");
    return;
  }
  const { decision, pattern } = decide(command, input);
  if (decision === "allow" || !pattern) {
    console.log("{}");
    return;
  }
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reasonFor(decision, pattern, command)
    }
  };
  console.log(JSON.stringify(output));
}
if (!process.env.VITEST) {
  main().catch(() => {
    console.log("{}");
  });
}
export {
  classifyDestructive,
  decide,
  extractShellWrapperPayloads,
  isUnattended,
  normalizeGitGlobalOptions,
  parseExecutable,
  stripQuotedStrings
};
