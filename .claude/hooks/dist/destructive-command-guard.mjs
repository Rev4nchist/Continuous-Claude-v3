#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/shared/destructive-classifier.ts
var DESTRUCTIVE_PATTERNS = [
  // filesystem — recursive deletion only (single-file `rm -f x` is allowed).
  // The flag may sit ANYWHERE after rm (`rm -f -r x`, `rm build -rf`, F04). It must be a SHORT
  // cluster containing r/R (-r, -rf, -fr) OR the long --recursive — NOT any long flag that
  // merely contains the letter r (round-2 FP fix: `rm --force` / `--verbose` /
  // `--interactive` are single-file deletes and must stay allowed). `(?<![-\w])` keeps
  // `docker run --rm -it` out; `(?=\s)` keeps `$(echo rm) -rf` an accepted gap. One bounded scan:
  // the old `(?:\s+-{1,2}[^\s]+)*` split `--a` two ways and took 4 s on 28 repeats (F16).
  { name: "recursive rm", re: /(?<![-\w])rm(?=\s)[^;&|\n]*?\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/i },
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
  // --hard anywhere after reset (`git reset HEAD~3 --hard`, `git reset -q --hard`, F05).
  { name: "git reset --hard", re: /\bgit\s+reset\b[^;&|\n]*\s--hard\b/i },
  // Force push: --force, a short cluster with f (-f, -uf, -fu), or a +refspec (`origin +main`, F05).
  { name: "git push --force", re: /\bgit\s+push\b[^&|;]*(?:--force(?:-with-lease)?|\s-[a-zA-Z]*f[a-zA-Z]*\b|\s\+\S)/i },
  { name: "git push --delete", re: /\bgit\s+push\b[^&|;]*(--delete|\s-d\b)/i },
  { name: "git push --mirror", re: /\bgit\s+push\b[^&|;]*--mirror\b/i },
  // colon-refspec remote delete: `git push origin :branch`. The leading SPACE before
  // the colon distinguishes it from `src:dst` (a normal push to a remote branch).
  { name: "git push :refspec delete", re: /\bgit\s+push\b[^&|;]*\s:[^\s]/i },
  // One bounded scan (F16: the old `(?:\s+-{1,2}[^\s]+)*` backtracked exponentially on `--a` runs).
  { name: "git clean -f", re: /\bgit\s+clean\b[^;&|\n]*\s(?:--force\b|-[a-zA-Z]*f)/i },
  // A bare `--` or `.` path, or -f/--force, anywhere after checkout (`git checkout main -- src`, F05).
  { name: "git checkout discard", re: /\bgit\s+checkout\b[^;&|\n]*\s(?:--(?=\s|$)|\.(?=\s|$)|-f\b|--force\b)/i },
  // git restore discarding the WORKTREE (parity with `git checkout .`/`--`). `--staged`-only
  // (reversible unstage) and single-file `git restore file` are NOT gated (accepted).
  { name: "git restore discard", re: /\bgit\s+restore\b[^&|;]*(--worktree\b|\s\.(?:\s|$))/i },
  { name: "git switch --discard-changes", re: /\bgit\s+switch\b[^&|;]*--discard-changes\b/i },
  // case-SENSITIVE on the force letter so `git branch -d` (lowercase, merged-only,
  // safe) is NOT flagged — only `-D` / `-fD` / `--delete --force` (round-2 FP fix).
  { name: "git branch -D", re: /\bgit\s+branch\s+(-D\b|--delete\s+--force|--force\s+--delete|-[a-zA-Z]*D[a-zA-Z]*\s)/ },
  // `git branch -f main abc123` moves a branch and drops the commits it pointed at (F05).
  { name: "git branch -f (force move)", re: /\bgit\s+branch\b[^;&|\n]*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)\b/i },
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
  // `docker compose down -v` deletes the project's named volumes (F05).
  { name: "docker compose down --volumes", re: /\bdocker(?:-compose|\s+compose)\b[^;&|\n]*\bdown\b[^;&|\n]*\s(?:-v|--volumes)\b/i }
];
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
var POWERSHELL_PATTERNS = [
  { name: "PowerShell recursive delete (Remove-Item -Recurse)", re: /(?:^|[;|&({]|\s)(?:Remove-Item|ri|rm|rmdir|rd|del|erase)\b[^;|&\n]*\s-(?:r|rec|recurse)\w*\b/i },
  { name: "PowerShell recursive delete ([IO.Directory]::Delete $true)", re: /\[(?:System\.)?IO\.Directory\]::Delete\([^)]*,\s*\$true\s*\)/i },
  // F06. A second argument that is not literally $false ($r, 1, (1 -eq 1)) can be true.
  { name: "PowerShell [IO.Directory]::Delete with a recurse argument", re: /\[(?:System\.)?IO\.Directory\]::Delete\([^),;\n]*,\s*(?!\$false\s*\))[^\s)]/i },
  // F06. A splat (`Remove-Item @p`) hides -Recurse inside a hashtable; the guard cannot see it.
  { name: "PowerShell splatted delete (Remove-Item @args)", re: /(?<![\w-])(?:Remove-Item|ri|rm|rmdir|rd|del|erase)\b[^;|&\n]*\s@\w/i },
  // F06. A pipe into a delete removes every item the left side yields (parity with `xargs rm`).
  { name: "PowerShell pipe into delete (| Remove-Item)", re: /\|\s*(?:Remove-Item|ri|rm|rmdir|rd|del|erase)\b/i }
];
var PS_QUOTED = /"(?:[^"`]|`.)*"|'(?:[^']|'')*'/g;
var BASH_QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
function stripQuotedStrings(command, tool = "Bash") {
  return command.replace(tool === "PowerShell" ? PS_QUOTED : BASH_QUOTED, (m) => m[0] + m[0]);
}
function hasOpenQuote(text, tool) {
  return /["']/.test(text.replace(tool === "PowerShell" ? PS_QUOTED : BASH_QUOTED, ""));
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
var PATH_PREFIX = String.raw`(?:\S*[\\/])?`;
var LAUNCHER = String.raw`(?:${PATH_PREFIX}(?:sudo(?:\s+-[ug]\s+\S+|\s+-\S+)*|env(?:\s+-u\s+\S+|\s+-\S+)*|nohup|time|exec|command|nice(?:\s+-\S+)*|wsl(?:\s+-\S+)*|xargs(?:\s+-\S+)*|timeout(?:\s+-\S+)*\s+\S+)\s+|[^\s=]+=\S+\s+)*`;
var OPTION_AREA = String.raw`(?:[^'"]|"[^"]*"|'[^']*')*?`;
var PAYLOAD = String.raw`\s*("(?:[^"\\]|\\.)*"(?=\s|$)|'[^']*'(?=\s|$)|\S.*)(?:\s.*)?$`;
var wrapper = (interp, flag) => new RegExp(`^${LAUNCHER}${PATH_PREFIX}${interp}\\b${OPTION_AREA}${flag}${PAYLOAD}`, "i");
var WRAPPER_RES = [
  { shell: "posix", re: wrapper("(?:bash|sh|zsh|dash|ksh|ash)(?:\\.exe)?", String.raw`\s-[a-z]*c\b`) },
  { shell: "powershell", re: wrapper("(?:powershell|pwsh)(?:\\.exe)?", String.raw`\s-c(?:ommand)?\b`) },
  { shell: "cmd", re: wrapper("cmd(?:\\.exe)?", String.raw`\s\/[ck]\b`) }
];
function unwrapPayload(raw) {
  let s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1);
  }
  return s.replace(/\\(["'`$\\])/g, "$1");
}
function taggedWrapperPayloads(segments) {
  const out = [];
  for (const seg2 of segments) {
    for (const { shell, re } of WRAPPER_RES) {
      const m = seg2.match(re);
      if (m && m[1]) {
        out.push({ payload: unwrapPayload(m[1]), shell });
        break;
      }
    }
  }
  return out;
}
function wrapperPayloadsFromSegments(segments) {
  return taggedWrapperPayloads(segments).map((w) => w.payload);
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
function bodySubstitutions(body, tool) {
  const out = [];
  const esc = tool === "PowerShell" ? "`" : "\\";
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === esc) {
      i += 2;
      continue;
    }
    if (c === "$" && body[i + 1] === "(") {
      const { inner, end } = readBalanced(body, i + 2, "(", ")");
      out.push(inner);
      i = end;
      continue;
    }
    if (c === "`" && tool !== "PowerShell") {
      const { inner, end } = readBacktick(body, i + 1);
      out.push(inner);
      i = end;
      continue;
    }
    i++;
  }
  return out;
}
function executableView(command, tool) {
  const out = [];
  const seen = [];
  let end = null;
  let expands = false;
  let body = [];
  const flush = () => {
    if (expands) for (const s of bodySubstitutions(body.join("\n"), tool)) out.push(`$(${s})`);
    end = null;
    body = [];
  };
  for (const line of command.split("\n")) {
    if (end) {
      if (end.test(line)) flush();
      else body.push(line);
      continue;
    }
    if (tool === "PowerShell") {
      const h = line.match(/^\s*\$\w+\s*=\s*@(['"])\s*$/);
      if (h) {
        end = new RegExp(`^\\s*${h[1]}@`);
        expands = h[1] === '"';
        continue;
      }
      out.push(line);
      continue;
    }
    out.push(line);
    const m = line.match(/^\s*(?:cat|tee)\b[^|;&<]*<<-?\s*(['"]?)([A-Za-z_]\w*)\1\s*(?:>>?\s*\S+)?\s*$/);
    const before = m ? [...seen, line.slice(0, line.indexOf("<<"))].join("\n") : "";
    seen.push(line);
    if (m && !hasOpenQuote(before, tool)) {
      end = new RegExp(`^\\s*${m[2]}\\s*$`);
      expands = m[1] === "";
    }
  }
  if (end) flush();
  return out.join("\n");
}
function normalizeEscapes(s, tool) {
  if (tool !== "PowerShell") return s.replace(/\\\r?\n/g, " ");
  return s.replace(/`\r?\n/g, " ").replace(/`([A-Za-z0-9])/g, "$1").replace(/`./g, "").replace(/\\(\r?\n)/g, "\\ $1");
}
function classifySegments(view, tool) {
  try {
    for (const seg2 of parseExecutable(normalizeEscapes(view, tool)).segments) {
      for (const p of SEGMENT_PATTERNS) if (p.re.test(seg2)) return p.name;
    }
  } catch {
  }
  return null;
}
var INTERPRETER_RE = /(?<![\w.-])(?:bash|sh|zsh|dash|ksh|ash|pwsh|powershell|cmd)(?:\.exe)?\b/i;
var EXEC_FLAG_RE = /\s(?:-[a-z]*c|-command|\/[ck])\b/i;
function classifyInterpreterSegments(segments, tool) {
  for (const seg2 of segments) {
    const stripped = stripQuotedStrings(seg2, tool);
    const at = stripped.search(INTERPRETER_RE);
    if (at < 0 || !EXEC_FLAG_RE.test(stripped.slice(at))) continue;
    const dequoted = normalizeGitGlobalOptions(seg2.replace(/["']/g, ""));
    for (const p of [...DESTRUCTIVE_PATTERNS, ...POWERSHELL_PATTERNS]) if (p.re.test(dequoted)) return p.name;
  }
  return null;
}
function classifyDestructive(command, depth = 0, tool = "Bash") {
  if (!command || typeof command !== "string") return null;
  let scan = normalizeGitGlobalOptions(stripQuotedStrings(command, tool));
  if (tool === "PowerShell") scan = scan.replace(/`([A-Za-z0-9])/g, "$1");
  const patterns = tool === "PowerShell" ? [...DESTRUCTIVE_PATTERNS, ...POWERSHELL_PATTERNS] : DESTRUCTIVE_PATTERNS;
  for (const p of patterns) {
    if (p.re.test(scan)) return p.name;
  }
  const view = executableView(command, tool);
  const segHit = classifySegments(view, tool);
  if (segHit) return segHit;
  if (depth < 4) {
    try {
      const { segments, substitutions } = parseExecutable(normalizeEscapes(view, tool));
      const interpHit = classifyInterpreterSegments(segments, tool);
      if (interpHit) return interpHit;
      const payloads = [
        ...taggedWrapperPayloads(segments).map((w) => ({ text: w.payload, tool: w.shell === "powershell" ? "PowerShell" : tool })),
        ...substitutions.map((s) => ({ text: s, tool }))
      ];
      for (const payload of payloads) {
        const inner = classifyDestructive(payload.text, depth + 1, payload.tool);
        if (inner) return inner;
      }
    } catch {
    }
  }
  return null;
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
import { homedir } from "os";
import { dirname, join } from "path";
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
    mkdirSync(dirname(path), { recursive: true, mode: 448 });
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
    mkdirSync(dirname(path), { recursive: true, mode: 448 });
    appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 384 });
  } catch {
  }
}

// src/shared/scoped-cleanup.ts
import { execFileSync } from "child_process";
import { lstatSync, readdirSync, realpathSync } from "fs";
import { tmpdir } from "os";
import * as nodePath from "path";
var BASH_RM = /^rm[ \t]+(?:-rf|-fr|-r[ \t]+-f|-f[ \t]+-r)[ \t]+(?:'([^']*)'|"([^"]*)"|([^\s'"]+))$/;
var PS_HEAD = /^Remove-Item[ \t]+/i;
var PS_TOKEN = /[ \t]*(-[A-Za-z]+(?=[ \t]|$)|'[^']*'|"[^"]*"|[^\s'"]+)/y;
var PATH_BLACKLIST = /[^\x20-\x7e]|[$`%*?[\]{}~;&|<>()!#,@]/;
var SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
function bashRmPath(command) {
  const m = BASH_RM.exec(command);
  if (!m) return null;
  const [, single, double, bare] = m;
  if (bare !== void 0 && bare.includes("\\")) return null;
  if (double !== void 0 && /\\[\\$`"]|\\$/.test(double)) return null;
  return single ?? double ?? bare ?? null;
}
function powershellPath(command) {
  const head = PS_HEAD.exec(command);
  if (!head) return null;
  PS_TOKEN.lastIndex = head[0].length;
  const tokens = [];
  let end = head[0].length;
  for (let m = PS_TOKEN.exec(command); m; m = PS_TOKEN.exec(command)) {
    tokens.push(m[1]);
    end = PS_TOKEN.lastIndex;
  }
  if (command.slice(end).trim() !== "") return null;
  return interpretPowershellTokens(tokens);
}
function unquote(token) {
  if (token.startsWith("'") && token.endsWith("'") && token.length >= 2) return token.slice(1, -1);
  if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) return token.slice(1, -1);
  if (token.startsWith("'") || token.startsWith('"')) return null;
  return token;
}
function interpretPowershellTokens(tokens) {
  let recurse = false;
  let force = false;
  const paths = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const lower = t.toLowerCase();
    if (lower === "-recurse") {
      if (recurse) return null;
      recurse = true;
      continue;
    }
    if (lower === "-force") {
      if (force) return null;
      force = true;
      continue;
    }
    if (lower === "-path" || lower === "-literalpath") {
      const value = tokens[++i];
      if (value === void 0 || /^-[A-Za-z]/.test(value)) return null;
      const v2 = unquote(value);
      if (v2 === null) return null;
      paths.push(v2);
      continue;
    }
    if (/^-[A-Za-z]/.test(t)) return null;
    const v = unquote(t);
    if (v === null) return null;
    paths.push(v);
  }
  if (!recurse || paths.length !== 1) return null;
  return paths[0];
}
function literalPath(command, tool) {
  if (/[\r\n\u0000]/.test(command)) return null;
  const c = command.trim();
  if (!c) return null;
  const path = tool === "PowerShell" ? powershellPath(c) : tool === "Bash" ? bashRmPath(c) : null;
  if (!path || path.startsWith("-") || PATH_BLACKLIST.test(path)) return null;
  return path;
}
function absolute(raw, tool, ctx) {
  let s = raw;
  if (ctx.platform === "win32") {
    if (tool === "Bash") {
      const m = /^\/([a-zA-Z])(\/.*)?$/.exec(s);
      if (m) s = `${m[1]}:${m[2] ?? "/"}`;
    }
    if (!/^[a-zA-Z]:[\\/]/.test(s) || s.slice(2).includes(":")) return null;
    if (s.split(/[\\/]/).includes("..")) return null;
    const out = ctx.p.resolve(s);
    return out.split("\\").slice(1).some((seg2) => /[. ]$/.test(seg2)) ? null : out;
  }
  if (!s.startsWith("/") || s.split("/").includes("..")) return null;
  return ctx.p.resolve(s);
}
var fold = (s, ctx) => ctx.platform === "win32" ? s.toLowerCase() : s;
function below(base, target, ctx) {
  const b = fold(base, ctx).replace(/[\\/]+$/, "");
  const t = fold(target, ctx);
  if (!t.startsWith(b + ctx.p.sep)) return null;
  const rest = target.slice(b.length + 1).split(ctx.p.sep).filter(Boolean);
  return rest.length ? rest : null;
}
function realResolve(p, ctx) {
  const tail = [];
  let cur = p;
  for (; ; ) {
    try {
      const r = ctx.realpath(cur);
      return tail.length ? ctx.p.join(r, ...tail.reverse()) : r;
    } catch {
    }
    const parent = ctx.p.dirname(cur);
    if (parent === cur) return null;
    tail.push(ctx.p.basename(cur));
    cur = parent;
  }
}
function sameName(a, b, ctx) {
  return fold(a, ctx) === fold(b, ctx);
}
function isScratchShape(segs, sessionId, ctx) {
  return !!segs && segs.length >= 4 && sameName(segs[1], sessionId, ctx) && sameName(segs[2], "scratchpad", ctx);
}
function inScratchpad(target, real, sessionId, tmp, ctx) {
  if (!SESSION_ID.test(sessionId)) return false;
  const realClaude = realResolve(ctx.p.join(tmp, "claude"), ctx);
  if (!realClaude) return false;
  const realTmp = realResolve(tmp, ctx);
  const lexicalBases = [ctx.p.join(tmp, "claude"), ...realTmp ? [ctx.p.join(realTmp, "claude")] : []];
  const lexical = lexicalBases.some((base) => isScratchShape(below(base, target, ctx), sessionId, ctx));
  return lexical && isScratchShape(below(realClaude, real, ctx), sessionId, ctx);
}
function defaultGitCommonDir(cwd) {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[k];
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 3e3,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env
    }).trim();
    return out ? nodePath.resolve(cwd, out) : null;
  } catch {
    return null;
  }
}
function worktreesRoot(cwd, deps, ctx) {
  if (!cwd || !ctx.p.isAbsolute(cwd)) return null;
  const common = (deps.gitCommonDir ?? defaultGitCommonDir)(cwd);
  if (!common || ctx.p.basename(common).toLowerCase() !== ".git") return null;
  return ctx.p.join(ctx.p.dirname(common), ".claude", "worktrees");
}
function inWorktrees(target, real, wtRoot, ctx) {
  const realRepo = realResolve(ctx.p.dirname(ctx.p.dirname(wtRoot)), ctx);
  const realRoot = realResolve(wtRoot, ctx);
  if (!realRepo || !realRoot) return false;
  if (!sameName(realRoot, ctx.p.join(realRepo, ".claude", "worktrees"), ctx)) return false;
  const lexical = [wtRoot, realRoot].some((base) => below(base, target, ctx) !== null);
  return lexical && below(realRoot, real, ctx) !== null;
}
var DEFAULT_MAX_ENTRIES = 2e3;
function treeIsPlain(root, max, ctx) {
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let st;
    try {
      st = lstatSync(dir);
    } catch (err) {
      if (err.code === "ENOENT" && dir === root) return true;
      return false;
    }
    if (st.isSymbolicLink()) return false;
    if (!st.isDirectory()) continue;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return false;
    }
    seen += names.length;
    if (seen > max) return false;
    for (const n of names) stack.push(ctx.p.join(dir, n));
  }
  return true;
}
function rootKind(target, real, tmp, input, deps, ctx) {
  if (typeof input.session_id === "string" && inScratchpad(target, real, input.session_id, tmp, ctx)) return "scratchpad";
  const wtRoot = worktreesRoot(input.cwd, deps, ctx);
  return wtRoot && inWorktrees(target, real, wtRoot, ctx) ? "worktree" : null;
}
function scopedCleanupKind(command, input, deps = {}) {
  try {
    const tool = input.tool_name || input.tool || "Bash";
    const raw = literalPath(command, tool);
    if (!raw) return null;
    const platform = deps.platform ?? process.platform;
    const ctx = {
      platform,
      p: platform === "win32" ? nodePath.win32 : nodePath.posix,
      realpath: deps.realpath ?? ((p) => realpathSync.native(p))
    };
    const target = absolute(raw, tool, ctx);
    if (!target) return null;
    const real = realResolve(target, ctx);
    if (!real) return null;
    const tmp = ctx.p.resolve(deps.tmpdir ?? tmpdir());
    const kind = rootKind(target, real, tmp, input, deps, ctx);
    if (!kind) return null;
    return treeIsPlain(real, deps.maxEntries ?? DEFAULT_MAX_ENTRIES, ctx) ? kind : null;
  } catch {
    return null;
  }
}

// src/shared/shell-tools.ts
var BOTH = ["Bash", "PowerShell"];
var SHELL_TOOLS = /* @__PURE__ */ new Map([
  ["Bash", { field: "command", dialects: ["Bash"], failClosed: false }],
  ["PowerShell", { field: "command", dialects: ["PowerShell"], failClosed: false }],
  ["mcp__plugin_desktop-commander_desktop-commander__start_process", { field: "command", dialects: BOTH, failClosed: true }],
  ["mcp__plugin_desktop-commander_desktop-commander__interact_with_process", { field: "input", dialects: BOTH, failClosed: true }]
]);
function readShellCommand(input) {
  const tool = input.tool_name || input.tool;
  const spec = tool ? SHELL_TOOLS.get(tool) : void 0;
  if (!tool || !spec) return { kind: "not-shell" };
  const toolInput = input.tool_input;
  const text = toolInput && typeof toolInput === "object" ? toolInput[spec.field] : void 0;
  if (typeof text !== "string") {
    return spec.failClosed ? { kind: "unreadable", tool, field: spec.field } : { kind: "command", tool, text: "", dialects: spec.dialects };
  }
  return { kind: "command", tool, text, dialects: spec.dialects };
}
function dialectsFor(tool) {
  return tool && SHELL_TOOLS.get(tool)?.dialects || ["Bash"];
}

// src/destructive-command-guard.ts
var HOOK = "destructive-command-guard";
var UNREADABLE_PATTERN = "unreadable command text";
var SCOPED_CLEANUP_REASON = "scoped-cleanup";
var SCOPED_PATTERNS = /* @__PURE__ */ new Set(["recursive rm", "PowerShell recursive delete (Remove-Item -Recurse)"]);
function decide(command, input, env = process.env, scopedDeps) {
  const overridden = env.SKIP_DESTRUCTIVE_GUARD === "1" || /^\s*SKIP_DESTRUCTIVE_GUARD=1\s+/.test(command) || /^\s*\$env:SKIP_DESTRUCTIVE_GUARD\s*=\s*['"]?1['"]?\s*;/i.test(command);
  let pattern = null;
  for (const dialect of dialectsFor(input.tool_name || input.tool)) {
    pattern = classifyDestructive(command, 0, dialect);
    if (pattern) break;
  }
  if (overridden) return pattern ? { decision: "allow", pattern, override: true } : { decision: "allow" };
  if (!pattern) return { decision: "allow" };
  const scoped = SCOPED_PATTERNS.has(pattern) ? scopedCleanupKind(command, input, scopedDeps) : null;
  if (scoped) return { decision: "allow", pattern, scoped };
  return { decision: isUnattended(input, env) ? "deny" : "ask", pattern };
}
function reasonFor(decision, pattern, command) {
  const head = decision === "deny" ? `BLOCKED (fail-closed): destructive command in an unattended/bypass context` : `CONFIRM: this is a destructive command`;
  return `${head}

Matched: ${pattern}
Command: ${command.slice(0, 300)}

${decision === "deny" ? `An interactive confirmation would hang a headless/autonomous run, so this is denied. Ask Dave for a yes, or state the reason this command is needed. Do not work around this block.` : `Approve only if you intend this irreversible operation. (Gate: destructive-command-guard; see ~/.claude/docs/security/destructive-commands.md.)`}`;
}
async function main() {
  let input = {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (raw) input = JSON.parse(raw);
  } catch (err) {
    logGuardError(HOOK, err);
    console.log("{}");
    return;
  }
  const shell = readShellCommand(input);
  if (shell.kind === "not-shell") {
    console.log("{}");
    return;
  }
  if (shell.kind === "unreadable") {
    emit(input, isUnattended(input) ? "deny" : "ask", UNREADABLE_PATTERN, `${shell.tool} with no string field "${shell.field}"`);
    return;
  }
  const command = shell.text;
  if (!command.trim()) {
    console.log("{}");
    return;
  }
  const { decision, pattern, override, scoped } = decide(command, input);
  if (override && pattern) logGuardDecision(HOOK, input, "override", pattern, { command });
  if (scoped) logGuardDecision(HOOK, input, "allow", `${SCOPED_CLEANUP_REASON}:${scoped}`, { command });
  if (decision === "allow" || !pattern) {
    console.log("{}");
    return;
  }
  emit(input, decision, pattern, command);
}
function emit(input, decision, pattern, command) {
  logGuardDecision(HOOK, input, decision, pattern, { command });
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
  main().catch((err) => {
    logGuardError(HOOK, err);
    console.log("{}");
  });
}
export {
  SCOPED_CLEANUP_REASON,
  UNREADABLE_PATTERN,
  classifyDestructive,
  decide,
  extractShellWrapperPayloads,
  isUnattended,
  normalizeGitGlobalOptions,
  parseExecutable,
  reasonFor,
  stripQuotedStrings
};
