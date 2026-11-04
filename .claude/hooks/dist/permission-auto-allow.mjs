import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/permission-auto-allow.ts
import { readFileSync } from "node:fs";

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

// src/permission-auto-allow.ts
function leaveToHuman(input) {
  if (input.tool_name === "AskUserQuestion" || input.tool_name === "ExitPlanMode" || input.tool_name === "Bash") {
    return true;
  }
  if (input.tool_name === "PowerShell") {
    const command = input.tool_input?.command;
    return typeof command === "string" && classifyDestructive(command, 0, "PowerShell") !== null;
  }
  return false;
}
function emitAllow() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" }
    }
  }));
}
function main() {
  let input = {};
  try {
    const raw = readFileSync(0, "utf8");
    input = raw ? JSON.parse(raw) : {};
  } catch {
    emitAllow();
    return;
  }
  if (leaveToHuman(input)) {
    process.stdout.write("{}");
    return;
  }
  emitAllow();
}
if ((process.argv[1] || "").includes("permission-auto-allow")) {
  main();
}
export {
  leaveToHuman
};
