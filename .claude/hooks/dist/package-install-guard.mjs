#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/package-install-guard.ts
import { existsSync, readFileSync, statSync } from "fs";
import { dirname as dirname2, join as join2, resolve } from "path";
import https from "https";

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
var abbrev = (word2, min) => word2.slice(0, min) + [...word2.slice(min)].reduceRight((rest, c) => `(?:${c}${rest})?`, "");
var gitFlag = (sub, flags) => new RegExp(String.raw`\bgit\s+${sub}\b[^;&|\n]*\s(?:${flags})`, "i");
var CHECKOUT_SWITCH_OPTIONS = String.raw`(?:track|no-track|detach|orphan)`;
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
  // Abbreviations count (`--har`, R4).
  { name: "git reset --hard", re: gitFlag("reset", String.raw`--${abbrev("hard", 1)}\b`) },
  // Force push: --force, a short cluster with f (-f, -uf, -fu), or a +refspec (`origin +main`, F05).
  // `--for` and longer (R4): --follow-tags shares `--fo`. --force-with-lease matches at the `-` boundary.
  { name: "git push --force", re: new RegExp(String.raw`\bgit\s+push\b[^&|;]*(?:--${abbrev("force", 3)}\b|\s-[a-zA-Z]*f[a-zA-Z]*\b|\s\+\S)`, "i") },
  { name: "git push --delete", re: /\bgit\s+push\b[^&|;]*(--delete|\s-d\b)/i },
  { name: "git push --mirror", re: /\bgit\s+push\b[^&|;]*--mirror\b/i },
  // colon-refspec remote delete: `git push origin :branch`. The leading SPACE before
  // the colon distinguishes it from `src:dst` (a normal push to a remote branch).
  { name: "git push :refspec delete", re: /\bgit\s+push\b[^&|;]*\s:[^\s]/i },
  // One bounded scan (F16: the old `(?:\s+-{1,2}[^\s]+)*` backtracked exponentially on `--a` runs).
  // `--f` and longer (R4): --force is the only clean option that starts with f.
  { name: "git clean -f", re: gitFlag("clean", String.raw`--${abbrev("force", 1)}\b|-[a-zA-Z]*f`) },
  // Anywhere after checkout (`git checkout main -- src`, F05): a bare `--`; a path that starts with `.`
  // (`.`, `./src`, `../x`: a ref name cannot start with a dot, R3); -f; and ANY long option outside the
  // branch-switch set (B2: --no-overlay, --quiet, --merge, --conflict=x restore files). This covers every
  // abbreviation too (R4: `--forc`, `--theirs`, `--pathspec-from-file`). An abbreviated switch (`--det`) asks.
  { name: "git checkout discard", re: gitFlag("checkout", String.raw`--(?=\s|$)|\.|-[a-zA-Z]*f[a-zA-Z]*\b|--(?!${CHECKOUT_SWITCH_OPTIONS}(?=[\s=]|$))\w`) },
  // git restore discarding the WORKTREE (parity with `git checkout .`/`--`). `--staged`-only
  // (reversible unstage) and single-file `git restore file` are NOT gated (accepted).
  { name: "git restore discard", re: /\bgit\s+restore\b[^&|;]*(--worktree\b|\s\.(?:\s|$))/i },
  { name: "git switch --discard-changes", re: /\bgit\s+switch\b[^&|;]*--discard-changes\b/i },
  // case-SENSITIVE on the force letter so `git branch -d` (lowercase, merged-only,
  // safe) is NOT flagged — only `-D` / `-fD` / `--delete --force` (round-2 FP fix).
  { name: "git branch -D", re: /\bgit\s+branch\s+(-D\b|--delete\s+--force|--force\s+--delete|-[a-zA-Z]*D[a-zA-Z]*\s)/ },
  // `git branch -f main abc123` moves a branch and drops the commits it pointed at (F05).
  // `--forc` and longer (R4): --format shares `--for`.
  { name: "git branch -f (force move)", re: gitFlag("branch", String.raw`(?:-[a-zA-Z]*f[a-zA-Z]*|--${abbrev("force", 4)})\b`) },
  // `git checkout -B x main` and `git switch -C x main` reset an existing branch the same way (CR 299).
  // Case-SENSITIVE on the letter: lowercase -b / -c only create a new branch and stay allowed.
  { name: "git checkout -B / switch -C (force reset a branch)", re: /\bgit\s+(?:checkout\b[^;&|\n]*\s-[a-zA-Z]*B[a-zA-Z]*\b|switch\b[^;&|\n]*\s(?:-[a-zA-Z]*C[a-zA-Z]*\b|--force-c(?:r(?:e(?:a(?:t(?:e)?)?)?)?)?\b))/ },
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
  // `down` is a whole word (`-f down.yml` is a file, R5). The lookahead takes the FIRST down and the
  // backreference consumes it atomically, so a failed `-v` scan never retries a later down (two greedy
  // scans around down were cubic on `docker compose down` x500). A -v after any down is after the first.
  { name: "docker compose down --volumes", re: /\bdocker(?:-compose|\s+compose)\b(?=([^;&|\n]*?\sdown(?=\s|$)))\1[^;&|\n]*\s(?:-v|--volumes)\b/i }
];
var LEAD_ITEM = String.raw`(?:[A-Za-z_]\w*=\S*(?=\s|$)|\$\w+\s*=|\[\w+\]|\(|\{|\)|&|\.|sudo|time|nohup|call|(?:try|else|finally|do|ForEach-Object|ForEach|Where-Object|%)\s*\{|(?:if|elseif|foreach|while|switch)\s*\((?:[^()]|\([^()]*\))*\)\s*\{)`;
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
var PS_QUOTED = /`.|"(?:[^"`]|`.)*"|'(?:[^']|'')*'/g;
var BASH_QUOTED = /\\.|"(?:[^"\\]|\\.)*"|'[^']*'/g;
var ESCAPE_CHARS = "\\`";
function stripQuotedStrings(command, tool = "Bash") {
  return command.replace(tool === "PowerShell" ? PS_QUOTED : BASH_QUOTED, (m) => ESCAPE_CHARS.includes(m[0]) ? m : m[0] + m[0]);
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
var LAUNCHER_PATH = String.raw`(?:[^\s=]*[\\/])?`;
var valueFlags = (letters) => String.raw`(?:\s+-[${letters}]\s+(?!-)\S+|\s+-(?![${letters}](?:\s|$))\S+)*`;
var SIMPLE_FLAGS = String.raw`(?:\s+-[^\s=\\/]*)*`;
var LAUNCHER = String.raw`(?:${LAUNCHER_PATH}(?:sudo${valueFlags("ug")}|env${valueFlags("u")}|nohup${SIMPLE_FLAGS}|time${SIMPLE_FLAGS}|exec|command|nice(?:\s+-\S+)*|wsl(?:\s+-\S+)*|xargs(?:\s+-\S+)*|timeout(?:\s+-\S+)*\s+(?!-)\S+)\s+|[^\s=]+=\S+\s+)*`;
var OPTION_AREA = String.raw`(?:[^'"]|"[^"]*"|'[^']*')*?`;
var PAYLOAD = String.raw`\s*(?:("(?:[^"\\]|\\[\s\S])*"|'[^']*')(?=\s|$)(?:\s([\s\S]*))?|(\S[\s\S]*))$`;
var wrapper = (interp, flag) => new RegExp(`^${LAUNCHER}${PATH_PREFIX}${interp}\\b${OPTION_AREA}${flag}${PAYLOAD}`, "i");
var POSIX_EXEC_FLAG = String.raw`\s-[a-z]{0,5}c[a-z]{0,5}\b`;
var PWSH_EXEC_FLAG = String.raw`\s-(?:c(?:o(?:m(?:m(?:a(?:n(?:d(?:withargs)?)?)?)?)?)?)?|cwa)\b`;
var WRAPPER_RES = [
  { shell: "posix", re: wrapper("(?:bash|sh|zsh|dash|ksh|ash)(?:\\.exe)?", POSIX_EXEC_FLAG) },
  { shell: "powershell", re: wrapper("(?:powershell|pwsh)(?:\\.exe)?", PWSH_EXEC_FLAG) },
  { shell: "cmd", re: wrapper("cmd(?:\\.exe)?", String.raw`\s\/[ck]\b`) }
];
function unwrapPayload(raw) {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(["`$\\])/g, "$1");
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}
var dropQuotes = (s) => s.replace(/["']/g, "");
function matchWrapper(seg2) {
  for (const { shell, re } of WRAPPER_RES) {
    const m = seg2.match(re);
    if (!m || !(m[1] || m[3])) continue;
    if (!m[1]) return { payload: /^["']/.test(m[3]) ? dropQuotes(m[3]) : unwrapPayload(m[3]), shell };
    if (!m[2]?.trim()) return { payload: unwrapPayload(m[1]), shell };
    const join3 = shell === "posix" ? " ; " : " ";
    return { payload: unwrapPayload(m[1]) + join3 + dropQuotes(m[2]), shell };
  }
  return null;
}
function taggedWrapperPayloads(segments) {
  return segments.map(matchWrapper).filter((w) => w !== null);
}
function wrapperPayloadsFromSegments(segments) {
  return taggedWrapperPayloads(segments).map((w) => w.payload);
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
var INTERPRETERS = [
  { word: /(?<![\w.-])(?:bash|sh|zsh|dash|ksh|ash)(?:\.exe)?\b/i, flag: new RegExp(POSIX_EXEC_FLAG) },
  { word: /(?<![\w.-])(?:pwsh|powershell)(?:\.exe)?\b/i, flag: new RegExp(PWSH_EXEC_FLAG, "i") },
  { word: /(?<![\w.-])cmd(?:\.exe)?\b/i, flag: /\s\/[ck](?=\s|["']|$)/i }
];

// src/shared/unattended.ts
function isUnattended(input, env = process.env) {
  if (input.permission_mode === "bypassPermissions") return true;
  if (env.CLAUDE_AGENT_ID) return true;
  if (env.CI === "true" || env.CI === "1") return true;
  return false;
}

// src/shared/typosquat-detect.ts
var POPULAR_PYPI = [
  "requests",
  "flask",
  "django",
  "numpy",
  "pandas",
  "boto3",
  "urllib3",
  "setuptools",
  "cryptography",
  "pillow",
  "scikit-learn",
  "tensorflow",
  "torch",
  "pytorch",
  "beautifulsoup4",
  "sqlalchemy",
  "celery",
  "redis",
  "psycopg2",
  "fastapi",
  "pydantic",
  "httpx",
  "aiohttp",
  "paramiko",
  "colorama",
  "litellm",
  "pip",
  "wheel",
  "six",
  "pyyaml"
];
var POPULAR_NPM = [
  "express",
  "react",
  "lodash",
  "axios",
  "chalk",
  "commander",
  "webpack",
  "typescript",
  "eslint",
  "prettier",
  "next",
  "vue",
  "angular",
  "moment",
  "underscore",
  "debug",
  "uuid",
  "dotenv",
  "cors",
  "jsonwebtoken",
  "bcrypt",
  "mongoose",
  "socket.io",
  "tailwindcss",
  "vite",
  "esbuild",
  "zod",
  "prisma",
  "drizzle-orm",
  "turbo"
];
var LEGITIMATE_NEAR_MISSES_NPM = /* @__PURE__ */ new Set([
  "vitest",
  // Vite-team test runner (vitest-dev/vitest); 2 from "vite"
  "vite-node",
  // Vitest's node runner; 2+ from "vite" once hyphen counted, kept explicit
  "vitepress",
  // Vite-team docs generator
  "chai",
  // assertion library; 2 from "chalk"
  "ora",
  // spinner (sindresorhus); 2 from "cors"
  "uid",
  // tiny id generator; 1 from "uuid"
  "zx"
  // Google shell scripting; 2 from "zod"
]);
var LEGITIMATE_NEAR_MISSES_PYPI = /* @__PURE__ */ new Set([
  "sympy",
  // symbolic math; 2 from "numpy"
  "pipx",
  // PyPA tool; 1 from "pip"
  "httpie",
  // HTTP client; 2 from "httpx"
  "hiredis",
  // redis C parser binding; 2 from "redis"
  "torchx",
  // Meta's TorchX; 1 from "torch"
  "sh",
  // subprocess wrapper; 1 from "six"
  "mcp"
  // Model Context Protocol Python SDK (modelcontextprotocol/python-sdk); 2 from "pip"
]);
var KNOWN_PYPI_TYPOSQUATS = {
  // requests variants
  "requets": "requests",
  "reqeusts": "requests",
  "reequests": "requests",
  "request": "requests",
  "requsts": "requests",
  "reqests": "requests",
  // flask
  "flaask": "flask",
  "flasks": "flask",
  "flaskk": "flask",
  // django
  "djnago": "django",
  "djagno": "django",
  "dajngo": "django",
  // numpy
  "numppy": "numpy",
  "numby": "numpy",
  "nympy": "numpy",
  // pandas
  "pandaas": "pandas",
  "pandsa": "pandas",
  // boto3
  "bto3": "boto3",
  "boto33": "boto3",
  // urllib3
  "urlib3": "urllib3",
  "urrlib3": "urllib3",
  // cryptography
  "cryptograpy": "cryptography",
  "criptography": "cryptography",
  // pillow
  "pilow": "pillow",
  "pilllow": "pillow",
  // colorama
  "colourama": "colorama",
  "collorama": "colorama",
  "coloramma": "colorama",
  // litellm
  "litelm": "litellm",
  "litellmm": "litellm",
  "lite-llm": "litellm",
  "litellm-proxy": "litellm",
  // fastapi
  "fastapl": "fastapi",
  "fast-api": "fastapi",
  // pydantic
  "pydantiic": "pydantic",
  "pydantik": "pydantic",
  // setuptools
  "setuptool": "setuptools",
  "setuptoolss": "setuptools",
  // tensorflow
  "tenserflow": "tensorflow",
  "tensorfow": "tensorflow",
  // torch/pytorch
  "pytorchh": "pytorch",
  "py-torch": "pytorch",
  // sqlalchemy
  "sqlaclhemy": "sqlalchemy",
  "sqlalcemy": "sqlalchemy",
  // httpx
  "htppx": "httpx",
  "httppx": "httpx",
  // paramiko
  "parmaiko": "paramiko",
  "paramko": "paramiko"
};
var KNOWN_NPM_TYPOSQUATS = {
  // express
  "exprss": "express",
  "expres": "express",
  "expresss": "express",
  "exppress": "express",
  // react
  "reakt": "react",
  "reactt": "react",
  "raect": "react",
  // lodash
  "lodasj": "lodash",
  "loddash": "lodash",
  "lodahs": "lodash",
  "loadash": "lodash",
  // axios
  "axois": "axios",
  "axiso": "axios",
  "axioss": "axios",
  // chalk
  "challk": "chalk",
  "chalks": "chalk",
  // commander
  "comander": "commander",
  "commanderr": "commander",
  // webpack
  "webpck": "webpack",
  "wepback": "webpack",
  // typescript
  "typscript": "typescript",
  "tyepscript": "typescript",
  "typescrpt": "typescript",
  // eslint
  "esllint": "eslint",
  "elsint": "eslint",
  // next
  "nextt": "next",
  "nex": "next",
  // vue
  "veu": "vue",
  "vuee": "vue",
  // moment
  "momnet": "moment",
  "momet": "moment",
  // dotenv
  "dotnev": "dotenv",
  "dot-env": "dotenv",
  // jsonwebtoken
  "jsonwebtokn": "jsonwebtoken",
  "json-web-token": "jsonwebtoken",
  // tailwindcss
  "tailwindcs": "tailwindcss",
  "tailwincss": "tailwindcss",
  // vite
  "vitte": "vite",
  "viite": "vite",
  // esbuild
  "esbuld": "esbuild",
  "esbulid": "esbuild",
  // zod
  "zodd": "zod",
  "zodt": "zod"
};
function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 999;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        // deletion
        dp[i][j - 1] + 1,
        // insertion
        dp[i - 1][j - 1] + cost
        // substitution
      );
    }
  }
  return dp[m][n];
}
function checkTyposquat(packageName, ecosystem) {
  const name = packageName.toLowerCase();
  const popularList = ecosystem === "pypi" ? POPULAR_PYPI : POPULAR_NPM;
  if (popularList.includes(name)) {
    return { isTyposquat: false };
  }
  const legit = ecosystem === "pypi" ? LEGITIMATE_NEAR_MISSES_PYPI : LEGITIMATE_NEAR_MISSES_NPM;
  if (legit.has(name)) {
    return { isTyposquat: false };
  }
  const knownList = ecosystem === "pypi" ? KNOWN_PYPI_TYPOSQUATS : KNOWN_NPM_TYPOSQUATS;
  if (knownList[name]) {
    return {
      isTyposquat: true,
      similarTo: knownList[name],
      reason: `Known typosquat variant of "${knownList[name]}"`
    };
  }
  for (const popular of popularList) {
    const dist = levenshteinDistance(name, popular);
    if (dist > 0 && dist <= 2) {
      return {
        isTyposquat: true,
        similarTo: popular,
        reason: `Name is ${dist} edit(s) away from popular package "${popular}"`
      };
    }
  }
  return { isTyposquat: false };
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

// src/shared/malicious-packages.json
var malicious_packages_default = {
  pypi: {
    litellm: {
      blocked_versions: [
        "1.82.7",
        "1.82.8"
      ],
      reason: "TeamPCP supply chain attack via compromised Trivy CI/CD - credential stealer targeting SSH keys, cloud creds, K8s configs",
      date: "2026-03-24",
      advisory: "https://futuresearch.ai/blog/litellm-pypi-supply-chain-attack/"
    },
    colourama: {
      blocked_all: true,
      reason: "Typosquat of colorama - known malware",
      date: "2023-01-01"
    },
    "python-dateutil": {
      blocked_all: false,
      note: "Legitimate package - but watch for python_dateutil typosquats"
    },
    jeIlyfish: {
      blocked_all: true,
      reason: "Typosquat of jellyfish (uses uppercase I instead of lowercase l) - credential stealer",
      date: "2019-12-01"
    },
    "python3-dateutil": {
      blocked_all: true,
      reason: "Typosquat of python-dateutil - known malware",
      date: "2019-06-01"
    },
    langflow: {
      blocked_versions: [],
      reason: "Langflow has an Arbitrary File Write (RCE) via v2 API (GHSA-g2j9-7rj2-gm6c)",
      date: "2026-03-19",
      advisory: "https://github.com/advisories/GHSA-g2j9-7rj2-gm6c"
    },
    mesop: {
      blocked_versions: [],
      reason: "Mesop Affected by Unauthenticated Remote Code Execution via Test Suite Route /exec-py (GHSA-gjgx-rvqr-6w6v)",
      date: "2026-03-18",
      advisory: "https://github.com/advisories/GHSA-gjgx-rvqr-6w6v"
    },
    glances: {
      blocked_versions: [],
      reason: "Glances's Browser API Exposes Reusable Downstream Credentials via `/api/4/serverslist` (GHSA-r297-p3v4-wp8m)",
      date: "2026-03-16",
      advisory: "https://github.com/advisories/GHSA-r297-p3v4-wp8m"
    },
    authlib: {
      blocked_versions: [],
      reason: "Authlib JWS JWK Header Injection: Signature Verification Bypass (GHSA-wvwj-cvrp-7pv5)",
      date: "2026-03-16",
      advisory: "https://github.com/advisories/GHSA-wvwj-cvrp-7pv5"
    },
    sglang: {
      blocked_versions: [],
      reason: "SGLang's encoder parallel disaggregation system is vulnerable to unauthenticated remote code execution through the disaggregation module (GHSA-jx93-g359-86wm)",
      date: "2026-03-12",
      advisory: "https://github.com/advisories/GHSA-jx93-g359-86wm"
    },
    "mcp-atlassian": {
      blocked_versions: [],
      reason: "MCP Atlassian has an arbitrary file write leading to arbitrary code execution via unconstrained download_path in confluence_download_attachment (GHSA-xjgw-4wvw-rgm4)",
      date: "2026-03-10",
      advisory: "https://github.com/advisories/GHSA-xjgw-4wvw-rgm4"
    },
    picklescan: {
      blocked_versions: [],
      reason: "PickleScan has multiple stdlib modules with direct RCE not in blocklist (GHSA-g38g-8gr9-h9xp)",
      date: "2026-03-03",
      advisory: "https://github.com/advisories/GHSA-g38g-8gr9-h9xp"
    },
    vitrage: {
      blocked_versions: [],
      reason: "OpenStack Vitrage: Unauthorized Access to the Host can Lead to Eval Injection (GHSA-8xwf-cr4r-856r)",
      date: "2026-02-27",
      advisory: "https://github.com/advisories/GHSA-8xwf-cr4r-856r"
    },
    "flask-reuploaded": {
      blocked_versions: [],
      reason: "Flask-Reuploaded vulnerable to Remote Code Execution via Server-Side Template Injection (GHSA-65mp-fq8v-56jr)",
      date: "2026-02-25",
      advisory: "https://github.com/advisories/GHSA-65mp-fq8v-56jr"
    },
    bugsink: {
      blocked_versions: [],
      reason: "Bugsink is vulnerable to Stored XSS via Pygments fallback in stacktrace rendering (GHSA-vp6q-7m36-pq3w)",
      date: "2026-02-25",
      advisory: "https://github.com/advisories/GHSA-vp6q-7m36-pq3w"
    },
    ormar: {
      blocked_versions: [],
      reason: "ormar is vulnerable to SQL Injection through aggregate functions min() and max() (GHSA-xxh2-68g9-8jqr)",
      date: "2026-02-23",
      advisory: "https://github.com/advisories/GHSA-xxh2-68g9-8jqr"
    },
    mlflow: {
      blocked_versions: [],
      reason: "MLflow Use of Default Password Authentication Bypass Vulnerability (GHSA-gq3w-7jj3-x7gr)",
      date: "2026-02-21",
      advisory: "https://github.com/advisories/GHSA-gq3w-7jj3-x7gr"
    },
    "semantic-kernel": {
      blocked_versions: [],
      reason: "Microsoft Semantic Kernel InMemoryVectorStore filter functionality vulnerable to remote code execution (GHSA-xjw9-4gw8-4rqx)",
      date: "2026-02-19",
      advisory: "https://github.com/advisories/GHSA-xjw9-4gw8-4rqx"
    },
    nltk: {
      blocked_versions: [],
      reason: "NLTK has a Zip Slip Vulnerability (GHSA-7p94-766c-hgjp)",
      date: "2026-02-18",
      advisory: "https://github.com/advisories/GHSA-7p94-766c-hgjp"
    },
    "azure-ai-language-conversations-authoring": {
      blocked_versions: [],
      reason: "Azure AI Language Authoring Elevation of Privilege Vulnerability can Lead to RCE (GHSA-436v-jg82-p533)",
      date: "2026-02-10",
      advisory: "https://github.com/advisories/GHSA-436v-jg82-p533"
    },
    keylime: {
      blocked_versions: [],
      reason: "Keylime Missing Authentication for Critical Function and Improper Authentication (GHSA-4jqp-9qjv-57m2)",
      date: "2026-02-06",
      advisory: "https://github.com/advisories/GHSA-4jqp-9qjv-57m2"
    },
    "dydx-v4-client": {
      blocked_versions: [],
      reason: "A single post-release of dydx-v4-client contained obfuscated multi-stage loader (GHSA-4f84-67cv-qrv3)",
      date: "2026-02-06",
      advisory: "https://github.com/advisories/GHSA-4f84-67cv-qrv3"
    },
    "microsoft.semantickernel.core": {
      blocked_versions: [],
      reason: "Semantic Kernel has Arbitrary File Write via AI Agent Function Calling in .NET SDK (GHSA-2ww3-72rp-wpp4)",
      date: "2026-02-06",
      advisory: "https://github.com/advisories/GHSA-2ww3-72rp-wpp4"
    },
    "epyt-flow": {
      blocked_versions: [],
      reason: "EPyT-Flow vulnerable to unsafe JSON deserialization (__type__) (GHSA-74vm-8frp-7w68)",
      date: "2026-02-04",
      advisory: "https://github.com/advisories/GHSA-74vm-8frp-7w68"
    },
    unstructured: {
      blocked_versions: [],
      reason: "Unstructured has Path Traversal via Malicious MSG Attachment that Allows Arbitrary File Write (GHSA-gm8q-m8mv-jj5m)",
      date: "2026-02-03",
      advisory: "https://github.com/advisories/GHSA-gm8q-m8mv-jj5m"
    },
    bambuddy: {
      blocked_versions: [],
      reason: "Bambuddy Uses Hardcoded Secret Key + Many API Endpoints do not Require Authentication (GHSA-gc24-px2r-5qmf)",
      date: "2026-02-02",
      advisory: "https://github.com/advisories/GHSA-gc24-px2r-5qmf"
    },
    langroid: {
      blocked_versions: [],
      reason: "Langroid has WAF Bypass Leading to RCE in TableChatAgent (GHSA-x34r-63hx-w57f)",
      date: "2026-02-02",
      advisory: "https://github.com/advisories/GHSA-x34r-63hx-w57f"
    },
    vllm: {
      blocked_versions: [],
      reason: "vLLM has RCE In Video Processing (GHSA-4r2x-xpjr-7cvv)",
      date: "2026-02-02",
      advisory: "https://github.com/advisories/GHSA-4r2x-xpjr-7cvv"
    },
    "ai.h2o:h2o-core": {
      blocked_versions: [],
      reason: "H2O has an External Control of File Name or Path vulnerability (GHSA-wj3h-wx8g-x699)",
      date: "2026-02-02",
      advisory: "https://github.com/advisories/GHSA-wj3h-wx8g-x699"
    },
    h2o: {
      blocked_versions: [],
      reason: "H2O has an External Control of File Name or Path vulnerability (GHSA-wj3h-wx8g-x699)",
      date: "2026-02-02",
      advisory: "https://github.com/advisories/GHSA-wj3h-wx8g-x699"
    },
    "cai-framework": {
      blocked_versions: [],
      reason: "CAI find_file Agent Tool has Command Injection Vulnerability Through Argument Injection (GHSA-jfpc-wj3m-qw2m)",
      date: "2026-01-30",
      advisory: "https://github.com/advisories/GHSA-jfpc-wj3m-qw2m"
    },
    "dfir-unfurl": {
      blocked_versions: [],
      reason: "Unfurl's debug mode cannot be disabled due to string config parsing (Werkzeug debugger exposure) (GHSA-vg9h-jx4v-cwx2)",
      date: "2026-01-29",
      advisory: "https://github.com/advisories/GHSA-vg9h-jx4v-cwx2"
    },
    "dcap-qvl": {
      blocked_versions: [],
      reason: "dcap-qvl has Missing Verification for QE Identity (GHSA-796p-j2gh-9m2q)",
      date: "2026-01-26",
      advisory: "https://github.com/advisories/GHSA-796p-j2gh-9m2q"
    },
    "@phala/dcap-qvl": {
      blocked_versions: [],
      reason: "dcap-qvl has Missing Verification for QE Identity (GHSA-796p-j2gh-9m2q)",
      date: "2026-01-26",
      advisory: "https://github.com/advisories/GHSA-796p-j2gh-9m2q"
    },
    "@phala/dcap-qvl-web": {
      blocked_versions: [],
      reason: "dcap-qvl has Missing Verification for QE Identity (GHSA-796p-j2gh-9m2q)",
      date: "2026-01-26",
      advisory: "https://github.com/advisories/GHSA-796p-j2gh-9m2q"
    },
    "@phala/dcap-qvl-node": {
      blocked_versions: [],
      reason: "dcap-qvl has Missing Verification for QE Identity (GHSA-796p-j2gh-9m2q)",
      date: "2026-01-26",
      advisory: "https://github.com/advisories/GHSA-796p-j2gh-9m2q"
    },
    crawl4ai: {
      blocked_versions: [],
      reason: "Crawl4AI is Vulnerable to Remote Code Execution in Docker API via Hooks Parameter (GHSA-5882-5rx9-xgxp)",
      date: "2026-01-16",
      advisory: "https://github.com/advisories/GHSA-5882-5rx9-xgxp"
    },
    uni2ts: {
      blocked_versions: [],
      reason: "Salesforce Uni2TS has a Code Injection vulnerability (GHSA-7x99-8x99-xc54)",
      date: "2026-01-10",
      advisory: "https://github.com/advisories/GHSA-7x99-8x99-xc54"
    },
    wolfssl: {
      blocked_versions: [],
      reason: "wolfSSL Python module vulnerable to Improper Authentication (GHSA-vj87-jj27-4h9c)",
      date: "2026-01-08",
      advisory: "https://github.com/advisories/GHSA-vj87-jj27-4h9c"
    },
    "terminal-controller": {
      blocked_versions: [],
      reason: "terminal-controller-mcp vulnerable to Command Injection (GHSA-h4rf-624j-gj33)",
      date: "2026-01-07",
      advisory: "https://github.com/advisories/GHSA-h4rf-624j-gj33"
    },
    "langchain-core": {
      blocked_versions: [],
      reason: "LangChain serialization injection vulnerability enables secret extraction in dumps/loads APIs (GHSA-c67j-w6g6-q2cm)",
      date: "2025-12-23",
      advisory: "https://github.com/advisories/GHSA-c67j-w6g6-q2cm"
    },
    weblate: {
      blocked_versions: [],
      reason: "Weblate is vulnerable to RCE through Git config file overwrite (GHSA-8vcg-cfxj-p5m3)",
      date: "2025-12-18",
      advisory: "https://github.com/advisories/GHSA-8vcg-cfxj-p5m3"
    },
    "apache-airflow-providers-edge3": {
      blocked_versions: [],
      reason: "Apache Airflow Providers Edge3 exposes internal API allowing RCE in web server context (GHSA-66h8-3g48-6hx8)",
      date: "2025-12-17",
      advisory: "https://github.com/advisories/GHSA-66h8-3g48-6hx8"
    },
    pgadmin4: {
      blocked_versions: [],
      reason: "pgadmin4 has a Meta-Command Filter Command Execution (GHSA-fxmw-jcgr-w44v)",
      date: "2025-12-11",
      advisory: "https://github.com/advisories/GHSA-fxmw-jcgr-w44v"
    },
    asyncmy: {
      blocked_versions: [],
      reason: "asyncmy is vulnerable to SQL injection via crafted dict keys (GHSA-qhqw-rrw9-25rm)",
      date: "2025-12-02",
      advisory: "https://github.com/advisories/GHSA-qhqw-rrw9-25rm"
    },
    ray: {
      blocked_versions: [],
      reason: "Ray's New Token Authentication is Disabled By Default (GHSA-gx77-xgc2-4888)",
      date: "2025-11-27",
      advisory: "https://github.com/advisories/GHSA-gx77-xgc2-4888"
    },
    modular: {
      blocked_versions: [],
      reason: "Modular Max Serve has Unsafe Deserialization vulnerability (GHSA-7xcv-9j6c-2fmc)",
      date: "2025-11-18",
      advisory: "https://github.com/advisories/GHSA-7xcv-9j6c-2fmc"
    },
    joserfc: {
      blocked_versions: [],
      reason: "joserfc has Possible Uncontrolled Resource Consumption Vulnerability Triggered by Logging Arbitrarily Large JWT Token Payloads (GHSA-frfh-8v73-gjg4)",
      date: "2025-11-18",
      advisory: "https://github.com/advisories/GHSA-frfh-8v73-gjg4"
    },
    astrbot: {
      blocked_versions: [],
      reason: "AstrBot is vulnerable to RCE with hard-coded JWT signing keys (GHSA-4m32-cjv7-f425)",
      date: "2025-11-14",
      advisory: "https://github.com/advisories/GHSA-4m32-cjv7-f425"
    },
    django: {
      blocked_versions: [],
      reason: "Django vulnerable to SQL injection via _connector keyword argument in QuerySet and Q objects. (GHSA-frmv-pr5f-9mcr)",
      date: "2025-11-05",
      advisory: "https://github.com/advisories/GHSA-frmv-pr5f-9mcr"
    },
    keras: {
      blocked_versions: [],
      reason: "Keras framework vulnerable to deserialization of untrusted data (GHSA-cvhh-q5g5-qprp)",
      date: "2025-10-17",
      advisory: "https://github.com/advisories/GHSA-cvhh-q5g5-qprp"
    },
    pyquokka: {
      blocked_versions: [],
      reason: "pyquokka is Vulnerable to Remote Code Execution by Pickle Deserialization via FlightServer  (GHSA-f74j-gffq-vm9p)",
      date: "2025-10-17",
      advisory: "https://github.com/advisories/GHSA-f74j-gffq-vm9p"
    },
    bbot: {
      blocked_versions: [],
      reason: "BBOT's insufficient sanitization issues in gitdumper.py can lead to RCE (GHSA-h6m2-r6h9-4c44)",
      date: "2025-10-09",
      advisory: "https://github.com/advisories/GHSA-h6m2-r6h9-4c44"
    },
    "scio-pypi": {
      blocked_versions: [],
      reason: "scio is vunerable to  Remote Command Execution  through PyTorch (GHSA-m9mp-6x32-5rhg)",
      date: "2025-10-09",
      advisory: "https://github.com/advisories/GHSA-m9mp-6x32-5rhg"
    },
    pyfory: {
      blocked_versions: [],
      reason: "Apache Pyfory python is vulnerable to deserialization of untrusted data (GHSA-538v-3wq9-4h3r)",
      date: "2025-10-01",
      advisory: "https://github.com/advisories/GHSA-538v-3wq9-4h3r"
    },
    pyfury: {
      blocked_versions: [],
      reason: "Apache Pyfory python is vulnerable to deserialization of untrusted data (GHSA-538v-3wq9-4h3r)",
      date: "2025-10-01",
      advisory: "https://github.com/advisories/GHSA-538v-3wq9-4h3r"
    },
    invokeai: {
      blocked_versions: [],
      reason: "InvokeAI has External Control of File Name or Path (GHSA-vv9c-xxg7-wmv7)",
      date: "2025-09-18",
      advisory: "https://github.com/advisories/GHSA-vv9c-xxg7-wmv7"
    },
    "mcp-kubernetes-server": {
      blocked_versions: [],
      reason: "mcp-kubernetes-server has an OS Command Injection vulnerability (GHSA-4hqq-7q79-932p)",
      date: "2025-09-15",
      advisory: "https://github.com/advisories/GHSA-4hqq-7q79-932p"
    },
    internetarchive: {
      blocked_versions: [],
      reason: "internetarchive Vulnerable to Directory Traversal in File.download() (GHSA-wx3r-v6h7-frjp)",
      date: "2025-09-05",
      advisory: "https://github.com/advisories/GHSA-wx3r-v6h7-frjp"
    },
    tkeasygui: {
      blocked_versions: [],
      reason: "TkEasyGUI Vulnerable to OS Command Injection (GHSA-hfrj-3w3g-jv32)",
      date: "2025-09-05",
      advisory: "https://github.com/advisories/GHSA-hfrj-3w3g-jv32"
    },
    "usd-core": {
      blocked_versions: [],
      reason: "Pixar OpenUSD Sdf_PathNode Module Use-After-Free Vulnerability Leading to Potential Remote Code Execution (GHSA-58p5-r2f6-g2cj)",
      date: "2025-09-04",
      advisory: "https://github.com/advisories/GHSA-58p5-r2f6-g2cj"
    },
    deepdiff: {
      blocked_versions: [],
      reason: "DeepDiff Class Pollution in Delta class leading to DoS, Remote Code Execution, and more (GHSA-mw26-5g2v-hqw3)",
      date: "2025-09-03",
      advisory: "https://github.com/advisories/GHSA-mw26-5g2v-hqw3"
    },
    executorch: {
      blocked_versions: [],
      reason: "ExecuTorch integer overflow vulnerability (GHSA-hj95-mhgf-jxc4)",
      date: "2025-08-08",
      advisory: "https://github.com/advisories/GHSA-hj95-mhgf-jxc4"
    },
    "org.pytorch:executorch-android": {
      blocked_versions: [],
      reason: "ExecuTorch integer overflow vulnerability (GHSA-hj95-mhgf-jxc4)",
      date: "2025-08-08",
      advisory: "https://github.com/advisories/GHSA-hj95-mhgf-jxc4"
    },
    "pyload-ng": {
      blocked_versions: [],
      reason: "pyLoad CNL Blueprint allows Path Traversal through `dlc_path` which leads to Remote Code Execution (RCE) (GHSA-48rp-jc79-2264)",
      date: "2025-08-04",
      advisory: "https://github.com/advisories/GHSA-48rp-jc79-2264"
    },
    num2words: {
      blocked_versions: [],
      reason: "num2words subjected to phishing attack, two versions published containing malware (GHSA-jxr6-qrxx-2ph2)",
      date: "2025-07-31",
      advisory: "https://github.com/advisories/GHSA-jxr6-qrxx-2ph2"
    },
    bentoml: {
      blocked_versions: [],
      reason: "BentoML SSRF Vulnerability in File Upload Processing   (GHSA-mrmq-3q62-6cc8)",
      date: "2025-07-29",
      advisory: "https://github.com/advisories/GHSA-mrmq-3q62-6cc8"
    },
    smolagents: {
      blocked_versions: [],
      reason: "smolagents has Sandbox Escape Vulnerability in the local_python_executor.py Module (GHSA-6v92-r5mx-h5fx)",
      date: "2025-07-27",
      advisory: "https://github.com/advisories/GHSA-6v92-r5mx-h5fx"
    },
    "apache-airflow-providers-snowflake": {
      blocked_versions: [],
      reason: "Apache Airflow Providers Snowflake package allows for Special Element Injection via CopyFromExternalStageToSnowflakeOperator (GHSA-9r64-3wmc-x8m8)",
      date: "2025-06-26",
      advisory: "https://github.com/advisories/GHSA-9r64-3wmc-x8m8"
    },
    "rfc3161-client": {
      blocked_versions: [],
      reason: "rfc3161-client has insufficient verification for timestamp response signatures (GHSA-6qhv-4h7r-2g9m)",
      date: "2025-06-20",
      advisory: "https://github.com/advisories/GHSA-6qhv-4h7r-2g9m"
    },
    "langflow-base": {
      blocked_versions: [],
      reason: "Langflow Unauth RCE (GHSA-rvqx-wpfh-mfx7)",
      date: "2025-06-17",
      advisory: "https://github.com/advisories/GHSA-rvqx-wpfh-mfx7"
    },
    salt: {
      blocked_versions: [],
      reason: "Salt vulnerable to directory traversal attack in file receiving method (GHSA-8pcp-r83j-fc92)",
      date: "2025-06-13",
      advisory: "https://github.com/advisories/GHSA-8pcp-r83j-fc92"
    },
    "backend.ai": {
      blocked_versions: [],
      reason: "BackendAI Missing Authentication for Critical Function (GHSA-ww28-4m4v-cq4j)",
      date: "2025-06-09",
      advisory: "https://github.com/advisories/GHSA-ww28-4m4v-cq4j"
    },
    "llama-index": {
      blocked_versions: [],
      reason: "llama_index vulnerable to SQL Injection (GHSA-v3c8-3pr6-gr7p)",
      date: "2025-06-05",
      advisory: "https://github.com/advisories/GHSA-v3c8-3pr6-gr7p"
    },
    "org.apache.iotdb:iotdb-core": {
      blocked_versions: [],
      reason: "Apache IoTDB Vulnerable to Remote Code Execution (GHSA-f4rq-f4j9-f6rm)",
      date: "2025-05-14",
      advisory: "https://github.com/advisories/GHSA-f4rq-f4j9-f6rm"
    },
    "apache-iotdb": {
      blocked_versions: [],
      reason: "Apache IoTDB Vulnerable to Remote Code Execution (GHSA-f4rq-f4j9-f6rm)",
      date: "2025-05-14",
      advisory: "https://github.com/advisories/GHSA-f4rq-f4j9-f6rm"
    },
    "browser-use": {
      blocked_versions: [],
      reason: "Browser Use allows bypassing `allowed_domains` by putting a decoy domain in http auth username portion of a URL (GHSA-x39x-9qw5-ghrf)",
      date: "2025-05-05",
      advisory: "https://github.com/advisories/GHSA-x39x-9qw5-ghrf"
    },
    h11: {
      blocked_versions: [],
      reason: "h11 accepts some malformed Chunked-Encoding bodies (GHSA-vqfr-h8mv-ghfj)",
      date: "2025-04-24",
      advisory: "https://github.com/advisories/GHSA-vqfr-h8mv-ghfj"
    },
    torch: {
      blocked_versions: [],
      reason: "PyTorch: `torch.load` with `weights_only=True` leads to remote code execution (GHSA-53q9-r3pm-6pq6)",
      date: "2025-04-18",
      advisory: "https://github.com/advisories/GHSA-53q9-r3pm-6pq6"
    },
    "jupyter-remote-desktop-proxy": {
      blocked_versions: [],
      reason: "TigerVNC accessible via the network and not just via a UNIX socket as intended (GHSA-vrq4-9hc3-cgp7)",
      date: "2025-04-12",
      advisory: "https://github.com/advisories/GHSA-vrq4-9hc3-cgp7"
    },
    lnbits: {
      blocked_versions: [],
      reason: "LNbits Lightning Network Payment System Vulnerable to Server-Side Request Forgery via LNURL Authentication Callback (GHSA-qp8j-p87f-c8cc)",
      date: "2025-04-07",
      advisory: "https://github.com/advisories/GHSA-qp8j-p87f-c8cc"
    },
    dtale: {
      blocked_versions: [],
      reason: "Duplicate Advisory: D-Tale Command Injection vulnerability (GHSA-gjxm-x497-4h6h)",
      date: "2025-03-20",
      advisory: "https://github.com/advisories/GHSA-gjxm-x497-4h6h"
    },
    kedro: {
      blocked_versions: [],
      reason: "Kedro deserialization vulnerability (GHSA-747f-ww56-4q4h)",
      date: "2025-03-20",
      advisory: "https://github.com/advisories/GHSA-747f-ww56-4q4h"
    },
    agentscope: {
      blocked_versions: [],
      reason: "AgentScope path traversal vulnerability (GHSA-c4cc-w454-4634)",
      date: "2025-03-20",
      advisory: "https://github.com/advisories/GHSA-c4cc-w454-4634"
    },
    aim: {
      blocked_versions: [],
      reason: "Aim  path traversal in LockManager.release_locks (GHSA-4qcx-jx49-6qrh)",
      date: "2025-03-20",
      advisory: "https://github.com/advisories/GHSA-4qcx-jx49-6qrh"
    },
    "pytorch-lightning": {
      blocked_versions: [],
      reason: "PyTorch Lightning path traversal vulnerability (GHSA-4cv3-v7pv-rfhf)",
      date: "2025-03-20",
      advisory: "https://github.com/advisories/GHSA-4cv3-v7pv-rfhf"
    },
    "llama-index-packs-finchat": {
      blocked_versions: [],
      reason: "llama-index-packs-finchat SQL Injection vulnerability (GHSA-x48g-hm9c-ww42)",
      date: "2025-03-20",
      advisory: "https://github.com/advisories/GHSA-x48g-hm9c-ww42"
    },
    "llama-index-retrievers-duckdb-retriever": {
      blocked_versions: [],
      reason: " LlamaIndex Retrievers Integration: DuckDBRetriever SQL Injection (GHSA-339r-cjv9-x78g)",
      date: "2025-03-20",
      advisory: "https://github.com/advisories/GHSA-339r-cjv9-x78g"
    },
    dbgpt: {
      blocked_versions: [],
      reason: "DB-GPT Arbitrary File Write vulnerability (GHSA-7gj6-22m4-qfhx)",
      date: "2025-03-20",
      advisory: "https://github.com/advisories/GHSA-7gj6-22m4-qfhx"
    },
    horovod: {
      blocked_versions: [],
      reason: "Horovod Vulnerable to Command Injection (GHSA-mrhh-3ggq-23p2)",
      date: "2025-03-20",
      advisory: "https://github.com/advisories/GHSA-mrhh-3ggq-23p2"
    },
    dask: {
      blocked_versions: [],
      reason: "Withdrawn Advisory: Dask Vulnerable to Command Injection (GHSA-xqgj-r6xv-9cw4)",
      date: "2025-03-20",
      advisory: "https://github.com/advisories/GHSA-xqgj-r6xv-9cw4"
    },
    "qiskit-terra": {
      blocked_versions: [],
      reason: "Qiskit allows arbitrary code execution decoding QPY format versions < 13 (GHSA-6m2c-76ff-6vrf)",
      date: "2025-03-14",
      advisory: "https://github.com/advisories/GHSA-6m2c-76ff-6vrf"
    },
    qiskit: {
      blocked_versions: [],
      reason: "Qiskit allows arbitrary code execution decoding QPY format versions < 13 (GHSA-6m2c-76ff-6vrf)",
      date: "2025-03-14",
      advisory: "https://github.com/advisories/GHSA-6m2c-76ff-6vrf"
    },
    plotai: {
      blocked_versions: [],
      reason: "PlotAI eval vulnerability (GHSA-2hmp-5wqg-f24h)",
      date: "2025-03-10",
      advisory: "https://github.com/advisories/GHSA-2hmp-5wqg-f24h"
    },
    "jupyterhub-ltiauthenticator": {
      blocked_versions: [],
      reason: "LTI JupyterHub Authenticator does not properly validate JWT Signature (GHSA-mcgx-2gcr-p3hp)",
      date: "2025-02-25",
      advisory: "https://github.com/advisories/GHSA-mcgx-2gcr-p3hp"
    },
    pandasai: {
      blocked_versions: [],
      reason: "PandasAI interactive prompt function Remote Code Execution (RCE) (GHSA-vv2h-2w3q-3fx7)",
      date: "2025-02-11",
      advisory: "https://github.com/advisories/GHSA-vv2h-2w3q-3fx7"
    },
    "django-unicorn": {
      blocked_versions: [],
      reason: "Django-Unicorn Class Pollution Vulnerability, Leading to XSS, DoS and Authentication Bypass (GHSA-g9wf-5777-gq43)",
      date: "2025-02-03",
      advisory: "https://github.com/advisories/GHSA-g9wf-5777-gq43"
    },
    sentry: {
      blocked_versions: [],
      reason: "Sentry's improper authentication on SAML SSO process allows user impersonation (GHSA-7pq6-v88g-wf3w)",
      date: "2025-01-15",
      advisory: "https://github.com/advisories/GHSA-7pq6-v88g-wf3w"
    },
    gradio: {
      blocked_versions: [],
      reason: "Gradio Blocked Path ACL Bypass Vulnerability (GHSA-j2jg-fq62-7c3h)",
      date: "2025-01-14",
      advisory: "https://github.com/advisories/GHSA-j2jg-fq62-7c3h"
    },
    "rasa-pro": {
      blocked_versions: [],
      reason: "Rasa Allows Remote Code Execution via Remote Model Loading (GHSA-cpv4-ggrr-7j9v)",
      date: "2025-01-14",
      advisory: "https://github.com/advisories/GHSA-cpv4-ggrr-7j9v"
    },
    rasa: {
      blocked_versions: [],
      reason: "Rasa Allows Remote Code Execution via Remote Model Loading (GHSA-cpv4-ggrr-7j9v)",
      date: "2025-01-14",
      advisory: "https://github.com/advisories/GHSA-cpv4-ggrr-7j9v"
    },
    cobbler: {
      blocked_versions: [],
      reason: "cobbler allows anyone to connect to cobbler XML-RPC server with known password and make changes (GHSA-m26c-fcgh-cp6h)",
      date: "2024-11-18",
      advisory: "https://github.com/advisories/GHSA-m26c-fcgh-cp6h"
    },
    codechecker: {
      blocked_versions: [],
      reason: "codechecker authentication method confusion vulnerability allows logging in as the built-in root user from an external service (GHSA-fpm5-2wcj-vfr7)",
      date: "2024-11-06",
      advisory: "https://github.com/advisories/GHSA-fpm5-2wcj-vfr7"
    },
    waitress: {
      blocked_versions: [],
      reason: "Waitress has request processing race condition in HTTP pipelining with invalid first request (GHSA-9298-4cf8-g4wj)",
      date: "2024-10-29",
      advisory: "https://github.com/advisories/GHSA-9298-4cf8-g4wj"
    },
    "changedetection.io": {
      blocked_versions: [],
      reason: "changedetection.io has a Server Side Template Injection using Jinja2 which allows Remote Command Execution (GHSA-4r7v-whpg-8rx3)",
      date: "2024-10-15",
      advisory: "https://github.com/advisories/GHSA-4r7v-whpg-8rx3"
    },
    "langchain-experimental": {
      blocked_versions: [],
      reason: "LangChain Experimental Eval Injection vulnerability (GHSA-p2qj-r53j-h3xj)",
      date: "2024-09-19",
      advisory: "https://github.com/advisories/GHSA-p2qj-r53j-h3xj"
    },
    agpt: {
      blocked_versions: [],
      reason: "AutoGPT bypass of the shell commands denylist settings (GHSA-g84q-54hf-36rg)",
      date: "2024-09-11",
      advisory: "https://github.com/advisories/GHSA-g84q-54hf-36rg"
    },
    "llama-index-core": {
      blocked_versions: [],
      reason: "LlamaIndex includes an exec call for `import {cls_name}` (GHSA-fxc2-8m62-m85x)",
      date: "2024-08-22",
      advisory: "https://github.com/advisories/GHSA-fxc2-8m62-m85x"
    },
    torchserve: {
      blocked_versions: [],
      reason: "TorchServe vulnerable to bypass of allowed_urls configuration (GHSA-wxcx-gg9c-fwp2)",
      date: "2024-07-18",
      advisory: "https://github.com/advisories/GHSA-wxcx-gg9c-fwp2"
    },
    fiona: {
      blocked_versions: [],
      reason: "Fiona affected by CVE-2023-45853 related to MiniZip madler-zlib (GHSA-q5fm-55c2-v6j9)",
      date: "2024-07-16",
      advisory: "https://github.com/advisories/GHSA-q5fm-55c2-v6j9"
    },
    vanna: {
      blocked_versions: [],
      reason: "vanna vulnerable to remote code execution caused by prompt injection (GHSA-rrqq-fv6m-692m)",
      date: "2024-06-27",
      advisory: "https://github.com/advisories/GHSA-rrqq-fv6m-692m"
    },
    lightning: {
      blocked_versions: [],
      reason: "pytorch-lightning vulnerable to Arbitrary File Write via /v1/runs API endpoint (GHSA-mr7h-w2qc-ffc2)",
      date: "2024-06-27",
      advisory: "https://github.com/advisories/GHSA-mr7h-w2qc-ffc2"
    },
    lollms: {
      blocked_versions: [],
      reason: "Remote Code Execution via path traversal bypass in lollms (GHSA-mvrm-fh8q-6wr2)",
      date: "2024-06-22",
      advisory: "https://github.com/advisories/GHSA-mvrm-fh8q-6wr2"
    },
    "org.apache.submarine:submarine-server-core": {
      blocked_versions: [],
      reason: "Apache Submarine Server Core Incorrect Authorization vulnerability (GHSA-6q97-8v3g-rpxw)",
      date: "2024-06-12",
      advisory: "https://github.com/advisories/GHSA-6q97-8v3g-rpxw"
    },
    "apache-submarine": {
      blocked_versions: [],
      reason: "Apache Submarine Server Core Incorrect Authorization vulnerability (GHSA-6q97-8v3g-rpxw)",
      date: "2024-06-12",
      advisory: "https://github.com/advisories/GHSA-6q97-8v3g-rpxw"
    },
    "jupyter-server-proxy": {
      blocked_versions: [],
      reason: "Jupyter Server Proxy has a reflected XSS issue in host parameter (GHSA-fvcq-4x64-hqxr)",
      date: "2024-06-11",
      advisory: "https://github.com/advisories/GHSA-fvcq-4x64-hqxr"
    },
    "qdrant-client": {
      blocked_versions: [],
      reason: "qdrant input validation failure  (GHSA-7m75-x27w-r52r)",
      date: "2024-06-03",
      advisory: "https://github.com/advisories/GHSA-7m75-x27w-r52r"
    },
    mocodo: {
      blocked_versions: [],
      reason: "Mocodo vulnerable to SQL injection in `/web/generate.php` (GHSA-j6cv-98jx-mrwr)",
      date: "2024-05-28",
      advisory: "https://github.com/advisories/GHSA-j6cv-98jx-mrwr"
    },
    "ait-core": {
      blocked_versions: [],
      reason: "NASA AIT-Core vulnerable to remote code execution (GHSA-jqff-8g2v-642h)",
      date: "2024-05-21",
      advisory: "https://github.com/advisories/GHSA-jqff-8g2v-642h"
    },
    pymysql: {
      blocked_versions: [],
      reason: "PyMySQL SQL Injection vulnerability (GHSA-v9hf-5j83-6xpp)",
      date: "2024-05-21",
      advisory: "https://github.com/advisories/GHSA-v9hf-5j83-6xpp"
    },
    consoleme: {
      blocked_versions: [],
      reason: "ConsoleMe has an Arbitrary File Read Vulnerability via Limited Git command (GHSA-3783-62vc-jr7x)",
      date: "2024-05-16",
      advisory: "https://github.com/advisories/GHSA-3783-62vc-jr7x"
    },
    "llama-cpp-python": {
      blocked_versions: [],
      reason: "llama-cpp-python vulnerable to Remote Code Execution by Server-Side Template Injection in Model Metadata (GHSA-56xg-wfcc-g829)",
      date: "2024-05-13",
      advisory: "https://github.com/advisories/GHSA-56xg-wfcc-g829"
    },
    frigate: {
      blocked_versions: [],
      reason: "Malicious Long Unicode filenames may cause a Multiple Application-level Denial of Service (GHSA-w4h6-9wrp-v5jq)",
      date: "2024-05-09",
      advisory: "https://github.com/advisories/GHSA-w4h6-9wrp-v5jq"
    },
    cbpi4: {
      blocked_versions: [],
      reason: "CraftBeerPi 4 allows arbitrary code execution (GHSA-4f92-w438-f484)",
      date: "2024-05-02",
      advisory: "https://github.com/advisories/GHSA-4f92-w438-f484"
    },
    "python-jose": {
      blocked_versions: [],
      reason: "python-jose algorithm confusion with OpenSSH ECDSA keys (GHSA-6c5p-j8vq-pqhj)",
      date: "2024-04-26",
      advisory: "https://github.com/advisories/GHSA-6c5p-j8vq-pqhj"
    },
    zenml: {
      blocked_versions: [],
      reason: "Directory traversal in zenml (GHSA-6h3f-43vq-53hj)",
      date: "2024-04-16",
      advisory: "https://github.com/advisories/GHSA-6h3f-43vq-53hj"
    },
    lektor: {
      blocked_versions: [],
      reason: "Lektor does not sanitize database path traversal (GHSA-wv28-7fpw-fj49)",
      date: "2024-03-27",
      advisory: "https://github.com/advisories/GHSA-wv28-7fpw-fj49"
    },
    "whoogle-search": {
      blocked_versions: [],
      reason: "Whoogle Search Path Traversal vulnerability (GHSA-q97g-c29h-x2p7)",
      date: "2024-03-14",
      advisory: "https://github.com/advisories/GHSA-q97g-c29h-x2p7"
    },
    paddlepaddle: {
      blocked_versions: [],
      reason: "PaddlePaddle Path Traversal vulnerability (GHSA-2rp8-hff9-c5wr)",
      date: "2024-03-07",
      advisory: "https://github.com/advisories/GHSA-2rp8-hff9-c5wr"
    },
    "flask-appbuilder": {
      blocked_versions: [],
      reason: "Flask-AppBuilder vulnerable to incorrect authentication when using auth type OpenID  (GHSA-j2pw-vp55-fqqj)",
      date: "2024-02-28",
      advisory: "https://github.com/advisories/GHSA-j2pw-vp55-fqqj"
    },
    pymatgen: {
      blocked_versions: [],
      reason: "pymatgen vulnerable to arbitrary code execution when parsing a maliciously crafted JonesFaithfulTransformation transformation_string (GHSA-vgv8-5cpj-qj2f)",
      date: "2024-02-21",
      advisory: "https://github.com/advisories/GHSA-vgv8-5cpj-qj2f"
    },
    "apache-airflow-providers-mongo": {
      blocked_versions: [],
      reason: "Improper Certificate Validation in apache airflow mongo hook (GHSA-x5pm-h33q-cjrw)",
      date: "2024-02-20",
      advisory: "https://github.com/advisories/GHSA-x5pm-h33q-cjrw"
    },
    dirac: {
      blocked_versions: [],
      reason: "DIRAC's TokenManager does not check permissions on cached tokens (GHSA-59qj-jcjv-662j)",
      date: "2024-02-08",
      advisory: "https://github.com/advisories/GHSA-59qj-jcjv-662j"
    },
    "products.sqlalchemyda": {
      blocked_versions: [],
      reason: "SQLAlchemyDA unauthenticated arbitrary SQL query execution (GHSA-r3jc-3qmm-w3pw)",
      date: "2024-02-07",
      advisory: "https://github.com/advisories/GHSA-r3jc-3qmm-w3pw"
    },
    vyper: {
      blocked_versions: [],
      reason: "Vyper negative array index bounds checks (GHSA-52xq-j7v9-v4v2)",
      date: "2024-02-07",
      advisory: "https://github.com/advisories/GHSA-52xq-j7v9-v4v2"
    },
    synthcity: {
      blocked_versions: [],
      reason: "Deserialization of untrusted data in synthcity (GHSA-4957-7vhp-7v59)",
      date: "2024-01-26",
      advisory: "https://github.com/advisories/GHSA-4957-7vhp-7v59"
    },
    "apache-superset": {
      blocked_versions: [],
      reason: "Cross-site Scripting in Apache superset (GHSA-rwhh-6x83-84v6)",
      date: "2024-01-23",
      advisory: "https://github.com/advisories/GHSA-rwhh-6x83-84v6"
    },
    embedchain: {
      blocked_versions: [],
      reason: "Code execution in Embedchain (GHSA-rhhj-5436-95vf)",
      date: "2024-01-21",
      advisory: "https://github.com/advisories/GHSA-rhhj-5436-95vf"
    },
    "llama-hub": {
      blocked_versions: [],
      reason: "Unsafe yaml deserialization in llama-hub (GHSA-297x-2qf3-jrj3)",
      date: "2024-01-21",
      advisory: "https://github.com/advisories/GHSA-297x-2qf3-jrj3"
    },
    pillow: {
      blocked_versions: [],
      reason: "Arbitrary Code Execution in Pillow (GHSA-3f63-hfp8-52jq)",
      date: "2024-01-19",
      advisory: "https://github.com/advisories/GHSA-3f63-hfp8-52jq"
    },
    "aries-cloudagent": {
      blocked_versions: [],
      reason: "Hyperledger Aries Cloud Agent Python result of presentation verification not checked for LDP-VC (GHSA-97x9-59rv-q5pm)",
      date: "2024-01-09",
      advisory: "https://github.com/advisories/GHSA-97x9-59rv-q5pm"
    },
    transformers: {
      blocked_versions: [],
      reason: "transformers has a Deserialization of Untrusted Data vulnerability (GHSA-3863-2447-669p)",
      date: "2023-12-19",
      advisory: "https://github.com/advisories/GHSA-3863-2447-669p"
    },
    "sap-xssec": {
      blocked_versions: [],
      reason: "Improper Privilege Management in sap-xssec (GHSA-6mjg-37cp-42x5)",
      date: "2023-12-13",
      advisory: "https://github.com/advisories/GHSA-6mjg-37cp-42x5"
    },
    "ibis-framework": {
      blocked_versions: [],
      reason: "Ibis PyArrow dependency allows arbitrary code execution when loading a malicious data file (GHSA-x563-6hqv-26mr)",
      date: "2023-11-17",
      advisory: "https://github.com/advisories/GHSA-x563-6hqv-26mr"
    },
    piccolo: {
      blocked_versions: [],
      reason: "piccolo SQL Injection via named transaction savepoints (GHSA-xq59-7jf3-rjc6)",
      date: "2023-11-12",
      advisory: "https://github.com/advisories/GHSA-xq59-7jf3-rjc6"
    },
    "label-studio": {
      blocked_versions: [],
      reason: "Label Studio has Hardcoded Django `SECRET_KEY` that can be Abused to Forge Session Tokens (GHSA-f475-x83m-rx5m)",
      date: "2023-11-09",
      advisory: "https://github.com/advisories/GHSA-f475-x83m-rx5m"
    },
    pyarrow: {
      blocked_versions: [],
      reason: "PyArrow: Arbitrary code execution when loading a malicious data file (GHSA-5wvp-7f3h-6wmm)",
      date: "2023-11-09",
      advisory: "https://github.com/advisories/GHSA-5wvp-7f3h-6wmm"
    },
    "transmute-core": {
      blocked_versions: [],
      reason: "transmute-core unsafe YAML deserialization vulnerability (GHSA-w9cp-3x79-2p8p)",
      date: "2023-11-02",
      advisory: "https://github.com/advisories/GHSA-w9cp-3x79-2p8p"
    },
    langchain: {
      blocked_versions: [],
      reason: "Langchain SQL Injection vulnerability (GHSA-8h5w-f6q9-wg35)",
      date: "2023-10-21",
      advisory: "https://github.com/advisories/GHSA-8h5w-f6q9-wg35"
    },
    modoboa: {
      blocked_versions: [],
      reason: "modoboa Cross-site Scripting vulnerability (GHSA-pqgm-9g82-wcm7)",
      date: "2023-10-20",
      advisory: "https://github.com/advisories/GHSA-pqgm-9g82-wcm7"
    },
    pyminizip: {
      blocked_versions: [],
      reason: "pyminizip affected by zlib's integer overflow/heap based buffer overflow vulnerability due to vulnerable dependency (GHSA-mq29-j5xf-cjwr)",
      date: "2023-10-14",
      advisory: "https://github.com/advisories/GHSA-mq29-j5xf-cjwr"
    },
    pydash: {
      blocked_versions: [],
      reason: "pydash Command Injection vulnerability (GHSA-8mjr-6c96-39w8)",
      date: "2023-09-28",
      advisory: "https://github.com/advisories/GHSA-8mjr-6c96-39w8"
    },
    searchor: {
      blocked_versions: [],
      reason: "Searchor CLI's Search vulnerable to Arbitrary Code using Eval (GHSA-66m2-493m-crh2)",
      date: "2023-09-25",
      advisory: "https://github.com/advisories/GHSA-66m2-493m-crh2"
    },
    gevent: {
      blocked_versions: [],
      reason: "Gevent allows remote attacker to escalate privileges (GHSA-x7m3-jprg-wc5g)",
      date: "2023-09-25",
      advisory: "https://github.com/advisories/GHSA-x7m3-jprg-wc5g"
    },
    reportlab: {
      blocked_versions: [],
      reason: "ReportLab vulnerable to remote code execution via paraparser (GHSA-pj98-2xf6-cff5)",
      date: "2023-09-20",
      advisory: "https://github.com/advisories/GHSA-pj98-2xf6-cff5"
    },
    numexpr: {
      blocked_versions: [],
      reason: "Langchain vulnerable to arbitrary code execution via the evaluate function in the numexpr library (GHSA-f73w-4m7g-ch9x)",
      date: "2023-09-01",
      advisory: "https://github.com/advisories/GHSA-f73w-4m7g-ch9x"
    },
    zbar: {
      blocked_versions: [],
      reason: "Heap-based buffer overflow in ZBar (GHSA-mhp6-jvpx-2p4m)",
      date: "2023-08-29",
      advisory: "https://github.com/advisories/GHSA-mhp6-jvpx-2p4m"
    },
    gitpython: {
      blocked_versions: [],
      reason: "GitPython vulnerable to remote code execution due to insufficient sanitization of input arguments (GHSA-pr76-5cm5-w9cj)",
      date: "2023-08-11",
      advisory: "https://github.com/advisories/GHSA-pr76-5cm5-w9cj"
    },
    mindsdb: {
      blocked_versions: [],
      reason: "MindsDB can be made to not verify SSL certificates (GHSA-8hx6-qv6f-xgcw)",
      date: "2023-08-01",
      advisory: "https://github.com/advisories/GHSA-8hx6-qv6f-xgcw"
    },
    "matrix-sydent": {
      blocked_versions: [],
      reason: "Sydent does not verify email server certificates (GHSA-p6hw-wm59-3g5g)",
      date: "2023-07-31",
      advisory: "https://github.com/advisories/GHSA-p6hw-wm59-3g5g"
    },
    "postgraas-server": {
      blocked_versions: [],
      reason: "postgraas-server vulnerable to SQL injection (GHSA-vghm-8cjp-hjw6)",
      date: "2023-07-18",
      advisory: "https://github.com/advisories/GHSA-vghm-8cjp-hjw6"
    },
    xalpha: {
      blocked_versions: [],
      reason: "xalpha vulnerable to Remote Code Execution (GHSA-jx3q-5rgf-vrrr)",
      date: "2023-07-11",
      advisory: "https://github.com/advisories/GHSA-jx3q-5rgf-vrrr"
    },
    scipy: {
      blocked_versions: [],
      reason: "Withdrawn: Use after free in SciPy (GHSA-jrfm-2h82-xg28)",
      date: "2023-07-06",
      advisory: "https://github.com/advisories/GHSA-jrfm-2h82-xg28"
    },
    "apache-airflow-providers-apache-hive": {
      blocked_versions: [],
      reason: "Apache Airflow Hive Provider Beeline remote code execution with Principal (GHSA-hg6c-qqcm-r79r)",
      date: "2023-07-03",
      advisory: "https://github.com/advisories/GHSA-hg6c-qqcm-r79r"
    },
    pipreqs: {
      blocked_versions: [],
      reason: "pipreqs vulnerable to Dependency Confusion (GHSA-v4f4-23wc-99mh)",
      date: "2023-06-30",
      advisory: "https://github.com/advisories/GHSA-v4f4-23wc-99mh"
    },
    "fief-server": {
      blocked_versions: [],
      reason: "fief-server Server-Side Template Injection vulnerability (GHSA-hj8m-9fhf-v7jp)",
      date: "2023-06-23",
      advisory: "https://github.com/advisories/GHSA-hj8m-9fhf-v7jp"
    },
    toui: {
      blocked_versions: [],
      reason: "toui allows user-specific variables to be shared between users (GHSA-hh7j-pg39-q563)",
      date: "2023-05-24",
      advisory: "https://github.com/advisories/GHSA-hh7j-pg39-q563"
    },
    ckan: {
      blocked_versions: [],
      reason: "Ckan remote code execution and private information access via crafted resource ids (GHSA-446m-hmmm-hm8m)",
      date: "2023-05-24",
      advisory: "https://github.com/advisories/GHSA-446m-hmmm-hm8m"
    },
    "apache-airflow": {
      blocked_versions: [],
      reason: "Apache Airflow vulnerable to Privilege Context Switching Error (GHSA-jchm-fm4q-c2fp)",
      date: "2023-05-08",
      advisory: "https://github.com/advisories/GHSA-jchm-fm4q-c2fp"
    },
    pysha3: {
      blocked_versions: [],
      reason: "Buffer overflow in sponge queue functions (GHSA-6w4m-2xhg-2658)",
      date: "2023-04-26",
      advisory: "https://github.com/advisories/GHSA-6w4m-2xhg-2658"
    },
    sha3: {
      blocked_versions: [],
      reason: "Buffer overflow in sponge queue functions (GHSA-6w4m-2xhg-2658)",
      date: "2023-04-26",
      advisory: "https://github.com/advisories/GHSA-6w4m-2xhg-2658"
    },
    "org.apache.iotdb:iotdb-grafana-connector": {
      blocked_versions: [],
      reason: "Apache IoTDB Grafana Connector vulnerable to Improper Authentication (GHSA-pvjv-386f-c8wh)",
      date: "2023-04-17",
      advisory: "https://github.com/advisories/GHSA-pvjv-386f-c8wh"
    },
    "org.apache.spark:spark-core_2.12": {
      blocked_versions: [],
      reason: "Apache Spark vulnerable to Improper Privilege Management (GHSA-329j-jfvr-rhr6)",
      date: "2023-04-17",
      advisory: "https://github.com/advisories/GHSA-329j-jfvr-rhr6"
    },
    "org.apache.spark:spark-core_2.13": {
      blocked_versions: [],
      reason: "Apache Spark vulnerable to Improper Privilege Management (GHSA-329j-jfvr-rhr6)",
      date: "2023-04-17",
      advisory: "https://github.com/advisories/GHSA-329j-jfvr-rhr6"
    },
    pyspark: {
      blocked_versions: [],
      reason: "Apache Spark vulnerable to Improper Privilege Management (GHSA-329j-jfvr-rhr6)",
      date: "2023-04-17",
      advisory: "https://github.com/advisories/GHSA-329j-jfvr-rhr6"
    },
    "farm-haystack": {
      blocked_versions: [],
      reason: "Use of hard-coded, security-relevant constants in deepset-ai/haystack (GHSA-w7qg-j435-78qw)",
      date: "2023-03-30",
      advisory: "https://github.com/advisories/GHSA-w7qg-j435-78qw"
    },
    tensorflow: {
      blocked_versions: [],
      reason: "TensorFlow has a heap out-of-buffer read vulnerability in the QuantizeAndDequantize operation (GHSA-gw97-ff7c-9v96)",
      date: "2023-03-24",
      advisory: "https://github.com/advisories/GHSA-gw97-ff7c-9v96"
    },
    "tensorflow-cpu": {
      blocked_versions: [],
      reason: "TensorFlow has a heap out-of-buffer read vulnerability in the QuantizeAndDequantize operation (GHSA-gw97-ff7c-9v96)",
      date: "2023-03-24",
      advisory: "https://github.com/advisories/GHSA-gw97-ff7c-9v96"
    },
    "tensorflow-gpu": {
      blocked_versions: [],
      reason: "TensorFlow has a heap out-of-buffer read vulnerability in the QuantizeAndDequantize operation (GHSA-gw97-ff7c-9v96)",
      date: "2023-03-24",
      advisory: "https://github.com/advisories/GHSA-gw97-ff7c-9v96"
    },
    "weixin-python": {
      blocked_versions: [],
      reason: "weixin-python XML External Entity vulnerability (GHSA-h384-ph77-3699)",
      date: "2023-03-21",
      advisory: "https://github.com/advisories/GHSA-h384-ph77-3699"
    },
    "apache-airflow-providers-google": {
      blocked_versions: [],
      reason: "Apache Airflow Google Provider Improper Input Validation vulnerability (GHSA-8g23-2q5p-8866)",
      date: "2023-02-24",
      advisory: "https://github.com/advisories/GHSA-8g23-2q5p-8866"
    },
    "apache-airflow-providers-apache-sqoop": {
      blocked_versions: [],
      reason: "Apache Airflow Sqoop Provider Improper Input Validation vulnerability (GHSA-j69x-v4wc-3fpf)",
      date: "2023-02-24",
      advisory: "https://github.com/advisories/GHSA-j69x-v4wc-3fpf"
    },
    turbogears: {
      blocked_versions: [],
      reason: "Header injection in TurboGears (GHSA-8q38-w56m-qq2c)",
      date: "2023-02-04",
      advisory: "https://github.com/advisories/GHSA-8q38-w56m-qq2c"
    },
    "apache-airflow-providers-mysql": {
      blocked_versions: [],
      reason: "Command Injection in Apache Airflow and Apache Airflow MySQL Provider (GHSA-c732-xvv8-g94c)",
      date: "2023-01-21",
      advisory: "https://github.com/advisories/GHSA-c732-xvv8-g94c"
    },
    rdiffweb: {
      blocked_versions: [],
      reason: "rdiffweb Improper Access Control vulnerability (GHSA-m8r9-qxx8-mrxp)",
      date: "2022-12-27",
      advisory: "https://github.com/advisories/GHSA-m8r9-qxx8-mrxp"
    },
    py7zr: {
      blocked_versions: [],
      reason: "py7zr directory traversal vulnerability (GHSA-m8xw-9x5x-6vh3)",
      date: "2022-12-06",
      advisory: "https://github.com/advisories/GHSA-m8xw-9x5x-6vh3"
    },
    wger: {
      blocked_versions: [],
      reason: "wger vulnerable to brute force attempts (GHSA-gr58-76rp-mmg4)",
      date: "2022-11-24",
      advisory: "https://github.com/advisories/GHSA-gr58-76rp-mmg4"
    },
    "acryl-datahub": {
      blocked_versions: [],
      reason: "acryl-datahub missing JWT signature check (GHSA-r8gm-v65f-c973)",
      date: "2022-10-31",
      advisory: "https://github.com/advisories/GHSA-r8gm-v65f-c973"
    },
    pikepdf: {
      blocked_versions: [],
      reason: "Duplicate Advisory: Improper Restriction of XML External Entity Reference in pikepdf (GHSA-x58j-j539-w8mv)",
      date: "2022-10-24",
      advisory: "https://github.com/advisories/GHSA-x58j-j539-w8mv"
    },
    shinken: {
      blocked_versions: [],
      reason: "Shinken Solutions Shinken Monitoring vulnerable to Incorrect Access Control (GHSA-p373-jqfm-j6wr)",
      date: "2022-10-20",
      advisory: "https://github.com/advisories/GHSA-p373-jqfm-j6wr"
    },
    joblib: {
      blocked_versions: [],
      reason: "joblib vulnerable to arbitrary code execution (GHSA-6hrg-qmvc-2xh8)",
      date: "2022-09-27",
      advisory: "https://github.com/advisories/GHSA-6hrg-qmvc-2xh8"
    },
    "python-jwt": {
      blocked_versions: [],
      reason: "python-jwt vulnerable to token forgery with new claims (GHSA-5p8v-58qm-c7fp)",
      date: "2022-09-21",
      advisory: "https://github.com/advisories/GHSA-5p8v-58qm-c7fp"
    },
    vncauthproxy: {
      blocked_versions: [],
      reason: "VNCAuthProxy authentication bypass vulnerability (GHSA-237r-mx84-7x8c)",
      date: "2022-09-16",
      advisory: "https://github.com/advisories/GHSA-237r-mx84-7x8c"
    },
    "python-scciclient": {
      blocked_versions: [],
      reason: "python-scciclient vulnerable to Man-in-the-middle (MITM) attacks (GHSA-rf3f-3p37-2qh4)",
      date: "2022-09-02",
      advisory: "https://github.com/advisories/GHSA-rf3f-3p37-2qh4"
    },
    nvflare: {
      blocked_versions: [],
      reason: "NVFLARE unsafe deserialization due to Pickle (GHSA-6qv6-q77g-7qm6)",
      date: "2022-08-31",
      advisory: "https://github.com/advisories/GHSA-6qv6-q77g-7qm6"
    },
    exotel: {
      blocked_versions: [],
      reason: "exotel-py includes code execution backdoor inserted by a third party (GHSA-cv6j-9835-p7fh)",
      date: "2022-08-28",
      advisory: "https://github.com/advisories/GHSA-cv6j-9835-p7fh"
    },
    keystone: {
      blocked_versions: [],
      reason: "Openstack Keystone Incorrect Authorization vulnerability (GHSA-cc99-whm5-mmq3)",
      date: "2022-08-27",
      advisory: "https://github.com/advisories/GHSA-cc99-whm5-mmq3"
    },
    wmagent: {
      blocked_versions: [],
      reason: "WMAgent arbitrary code execution via a crafted dbs-client package (GHSA-4vq7-8699-4xgc)",
      date: "2022-07-29",
      advisory: "https://github.com/advisories/GHSA-4vq7-8699-4xgc"
    },
    reqmgr2: {
      blocked_versions: [],
      reason: "WMAgent arbitrary code execution via a crafted dbs-client package (GHSA-4vq7-8699-4xgc)",
      date: "2022-07-29",
      advisory: "https://github.com/advisories/GHSA-4vq7-8699-4xgc"
    },
    reqmon: {
      blocked_versions: [],
      reason: "WMAgent arbitrary code execution via a crafted dbs-client package (GHSA-4vq7-8699-4xgc)",
      date: "2022-07-29",
      advisory: "https://github.com/advisories/GHSA-4vq7-8699-4xgc"
    },
    "global-workqueue": {
      blocked_versions: [],
      reason: "WMAgent arbitrary code execution via a crafted dbs-client package (GHSA-4vq7-8699-4xgc)",
      date: "2022-07-29",
      advisory: "https://github.com/advisories/GHSA-4vq7-8699-4xgc"
    },
    octobot: {
      blocked_versions: [],
      reason: "Octobot mishandles Tentacles upload (GHSA-fr75-x856-q6j8)",
      date: "2022-07-17",
      advisory: "https://github.com/advisories/GHSA-fr75-x856-q6j8"
    },
    distributed: {
      blocked_versions: [],
      reason: "Workers for local Dask clusters mistakenly listened on public interfaces (GHSA-hwqr-f3v9-hwxr)",
      date: "2022-07-15",
      advisory: "https://github.com/advisories/GHSA-hwqr-f3v9-hwxr"
    },
    ganga: {
      blocked_versions: [],
      reason: "Ganga allows absolute path traversal (GHSA-7488-6x3r-23w5)",
      date: "2022-07-13",
      advisory: "https://github.com/advisories/GHSA-7488-6x3r-23w5"
    },
    "chainerrl-visualizer": {
      blocked_versions: [],
      reason: "ChainerRL Visualizer 0.1.1 vulnerable to Path Traversal via unsafe use of send_file function (GHSA-687h-86vc-5x59)",
      date: "2022-07-12",
      advisory: "https://github.com/advisories/GHSA-687h-86vc-5x59"
    },
    shiva: {
      blocked_versions: [],
      reason: "Tooxie Shiva 0.10.0 allows absolute path traversal because Flask send_file function used unsafely (GHSA-qp72-96p2-g644)",
      date: "2022-07-12",
      advisory: "https://github.com/advisories/GHSA-qp72-96p2-g644"
    },
    opendiamond: {
      blocked_versions: [],
      reason: "SatyaLab opendiamond 10.1.1 vulnerable to path traversal because Flask send_file function used unsafely (GHSA-x2pc-fqrw-hc7f)",
      date: "2022-07-12",
      advisory: "https://github.com/advisories/GHSA-x2pc-fqrw-hc7f"
    },
    "rpc.py": {
      blocked_versions: [],
      reason: "rpc.py vulnerable to Deserialization of Untrusted Data (GHSA-8rq8-f485-7v8x)",
      date: "2022-07-09",
      advisory: "https://github.com/advisories/GHSA-8rq8-f485-7v8x"
    },
    couchbase: {
      blocked_versions: [],
      reason: "Couchbase Sync Gateway admin credentials not verified when using X.509 client cert authentication (GHSA-9266-j9v3-q4j5)",
      date: "2022-06-11",
      advisory: "https://github.com/advisories/GHSA-9266-j9v3-q4j5"
    },
    cookiecutter: {
      blocked_versions: [],
      reason: "OS Command Injection in cookiecutter (GHSA-f4q6-9qm4-h8j4)",
      date: "2022-06-09",
      advisory: "https://github.com/advisories/GHSA-f4q6-9qm4-h8j4"
    },
    "api-res-py": {
      blocked_versions: [],
      reason: "Backdoor in api-res-py (GHSA-6978-4w92-428p)",
      date: "2022-06-09",
      advisory: "https://github.com/advisories/GHSA-6978-4w92-428p"
    },
    "django-s3file": {
      blocked_versions: [],
      reason: "Path Traversal in django-s3file (GHSA-4w8f-hjm9-xwgf)",
      date: "2022-06-06",
      advisory: "https://github.com/advisories/GHSA-4w8f-hjm9-xwgf"
    },
    bottle: {
      blocked_versions: [],
      reason: "Denial of service in bottle (GHSA-xhp9-4947-rq78)",
      date: "2022-06-03",
      advisory: "https://github.com/advisories/GHSA-xhp9-4947-rq78"
    },
    ctx: {
      blocked_versions: [],
      reason: "Embedded Malicious Code in ctx (GHSA-67r3-h899-9w95)",
      date: "2022-06-02",
      advisory: "https://github.com/advisories/GHSA-67r3-h899-9w95"
    },
    ansible: {
      blocked_versions: [],
      reason: "Ansible Code Injection Vulnerability (GHSA-66c7-5pwv-mm3j)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-66c7-5pwv-mm3j"
    },
    numpy: {
      blocked_versions: [],
      reason: "Numpy Deserialization of Untrusted Data (GHSA-9fq2-x9r6-wfmf)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-9fq2-x9r6-wfmf"
    },
    lmdb: {
      blocked_versions: [],
      reason: "py-lmdb Invalid write operation (GHSA-pf3p-v9xp-mrvf)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-pf3p-v9xp-mrvf"
    },
    "ops-cli": {
      blocked_versions: [],
      reason: "Ops CLI Deserialization of Untrusted Data vulnerability (GHSA-x23q-4j9j-9cxw)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-x23q-4j9j-9cxw"
    },
    lxdui: {
      blocked_versions: [],
      reason: "AdaptiveScale LXDUI Hardcoded JWT Secret Key (GHSA-p4xh-4869-8vrg)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-p4xh-4869-8vrg"
    },
    "lin-cms": {
      blocked_versions: [],
      reason: "Lin-CMS-Flask vulnerable to Improper Authentication (GHSA-h6r2-pgvx-683c)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-h6r2-pgvx-683c"
    },
    "git-big-picture": {
      blocked_versions: [],
      reason: "git-big-picture Code Execution (GHSA-x38j-4rr5-hqrj)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-x38j-4rr5-hqrj"
    },
    jsonpickle: {
      blocked_versions: [],
      reason: "jsonpickle unsafe deserialization (GHSA-j66q-qmrc-89rx)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-j66q-qmrc-89rx"
    },
    "scalyr-agent-2": {
      blocked_versions: [],
      reason: "Scalyr Agent 2 Missing SSL Certificate Validation (GHSA-738x-v49g-p6hx)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-738x-v49g-p6hx"
    },
    "scikit-learn": {
      blocked_versions: [],
      reason: "scikit-learn Deserialization of Untrusted Data (GHSA-jjw5-xxj6-pcv5)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-jjw5-xxj6-pcv5"
    },
    "misp-maltego": {
      blocked_versions: [],
      reason: "Maltego incorrectly shares a MISP connection across users in a remote-transform use case (GHSA-fj35-m94r-9h4c)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-fj35-m94r-9h4c"
    },
    plone: {
      blocked_versions: [],
      reason: "Plone Unauthenticated Write Vulnerability (GHSA-w6g9-xccc-347h)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-w6g9-xccc-347h"
    },
    "plone.app.contenttypes": {
      blocked_versions: [],
      reason: "Plone Unauthenticated Write Vulnerability (GHSA-w6g9-xccc-347h)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-w6g9-xccc-347h"
    },
    octavia: {
      blocked_versions: [],
      reason: "OpenStack Octavia Amphora-Agent not requiring Client-Certificate (GHSA-r4v4-3jj7-jc29)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-r4v4-3jj7-jc29"
    },
    "os-vif": {
      blocked_versions: [],
      reason: "OpenStack os-vif Ageing time of 0 disables linuxbridge MAC learning (GHSA-mcpw-cp35-p3h8)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-mcpw-cp35-p3h8"
    },
    linotp: {
      blocked_versions: [],
      reason: "LinOTP replay vulnerability with auto resynchronization enabled for TOTP token (GHSA-rqg8-xjp2-pg9w)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-rqg8-xjp2-pg9w"
    },
    "openstack-magnum": {
      blocked_versions: [],
      reason: "Openstack Magnum Unsafe Credential Handling (GHSA-793v-r35j-9rp9)",
      date: "2022-05-24",
      advisory: "https://github.com/advisories/GHSA-793v-r35j-9rp9"
    },
    "org.eclipse.jgit:org.eclipse.jgit": {
      blocked_versions: [],
      reason: "JGit Improper Input Validation vulnerability (GHSA-6vvc-c2m3-cjf3)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-6vvc-c2m3-cjf3"
    },
    mercurial: {
      blocked_versions: [],
      reason: "JGit Improper Input Validation vulnerability (GHSA-6vvc-c2m3-cjf3)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-6vvc-c2m3-cjf3"
    },
    pywebdav: {
      blocked_versions: [],
      reason: "PyWebDAV SQL Injection vulnerability (GHSA-69vw-jfq7-935g)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-69vw-jfq7-935g"
    },
    "graphite-web": {
      blocked_versions: [],
      reason: "graphite-web is vulnerable to Remote Code Execution (GHSA-ch3j-w953-hfcm)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-ch3j-w953-hfcm"
    },
    "python-swiftclient": {
      blocked_versions: [],
      reason: "Python Swift client is vulnerable to Missing SSL Certificate Check (GHSA-p3xv-97g8-4wmj)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-p3xv-97g8-4wmj"
    },
    dulwich: {
      blocked_versions: [],
      reason: "Dulwich Buffer Overflow when handling pack files (GHSA-vjjf-3rvg-gv3v)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-vjjf-3rvg-gv3v"
    },
    murano: {
      blocked_versions: [],
      reason: "OpenStack Murano Code Execution (GHSA-87r7-q54j-f9qg)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-87r7-q54j-f9qg"
    },
    "murano-dashboard": {
      blocked_versions: [],
      reason: "OpenStack Murano Code Execution (GHSA-87r7-q54j-f9qg)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-87r7-q54j-f9qg"
    },
    "python-muranoclient": {
      blocked_versions: [],
      reason: "OpenStack Murano Code Execution (GHSA-87r7-q54j-f9qg)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-87r7-q54j-f9qg"
    },
    radicale: {
      blocked_versions: [],
      reason: "Radicale is vulnerable to directory traversal on Windows Filesystem Storage Backend component (GHSA-84cw-mxhv-qvv4)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-84cw-mxhv-qvv4"
    },
    notebook: {
      blocked_versions: [],
      reason: "Improper Input Validation in Jupyter Notebook (GHSA-92mr-v722-f48m)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-92mr-v722-f48m"
    },
    ipython: {
      blocked_versions: [],
      reason: "Improper Input Validation in Jupyter Notebook (GHSA-92mr-v722-f48m)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-92mr-v722-f48m"
    },
    pysaml2: {
      blocked_versions: [],
      reason: "PySAML2 XML external entity attack (GHSA-m269-wj6g-c459)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-m269-wj6g-c459"
    },
    pygments: {
      blocked_versions: [],
      reason: "Command Injection in Pygments (GHSA-fff8-4w9p-7v76)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-fff8-4w9p-7v76"
    },
    swift: {
      blocked_versions: [],
      reason: "OpenStack Object Storage (swift) Code Injection vulnerability (GHSA-v7mh-3jgf-r26c)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-v7mh-3jgf-r26c"
    },
    swauth: {
      blocked_versions: [],
      reason: "OpenStack Swauth object/proxy server writing Auth Token to log file (GHSA-qhq8-xwqv-pvv9)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-qhq8-xwqv-pvv9"
    },
    calibreweb: {
      blocked_versions: [],
      reason: "SQL injection in calibreweb (GHSA-8ppf-x4gr-2x7g)",
      date: "2022-05-17",
      advisory: "https://github.com/advisories/GHSA-8ppf-x4gr-2x7g"
    },
    ipsilon: {
      blocked_versions: [],
      reason: "Session Fixation in ipsilon (GHSA-376m-3rm2-9jm6)",
      date: "2022-05-14",
      advisory: "https://github.com/advisories/GHSA-376m-3rm2-9jm6"
    },
    nova: {
      blocked_versions: [],
      reason: "OpenStack Nova logs sensitive context from notification exceptions (GHSA-f4g4-cj8f-3cr9)",
      date: "2022-05-14",
      advisory: "https://github.com/advisories/GHSA-f4g4-cj8f-3cr9"
    },
    sqlalchemy: {
      blocked_versions: [],
      reason: "SQLAlchemy vulnerable to SQL injection (GHSA-hfg2-wf6j-x53p)",
      date: "2022-05-14",
      advisory: "https://github.com/advisories/GHSA-hfg2-wf6j-x53p"
    },
    "django-anymail": {
      blocked_versions: [],
      reason: "django-anymail Includes Sensitive Information in Log Files (GHSA-qh9x-mc42-vg4g)",
      date: "2022-05-14",
      advisory: "https://github.com/advisories/GHSA-qh9x-mc42-vg4g"
    },
    "django-tastypie": {
      blocked_versions: [],
      reason: "Django Tastypie Improper Deserialization of YAML Data (GHSA-qgvw-qc2q-gv5q)",
      date: "2022-05-14",
      advisory: "https://github.com/advisories/GHSA-qgvw-qc2q-gv5q"
    },
    neutron: {
      blocked_versions: [],
      reason: "OpenStack Neutron allows remote attackers to bypass an intended ICMPv6-spoofing protection mechanism (GHSA-3vj4-cvjp-482h)",
      date: "2022-05-14",
      advisory: "https://github.com/advisories/GHSA-3vj4-cvjp-482h"
    },
    kerberos: {
      blocked_versions: [],
      reason: "python-kerberos vulnerable to KDC spoofing attacks (GHSA-mffc-9gx5-99g3)",
      date: "2022-05-14",
      advisory: "https://github.com/advisories/GHSA-mffc-9gx5-99g3"
    },
    pykerberos: {
      blocked_versions: [],
      reason: "python-kerberos vulnerable to KDC spoofing attacks (GHSA-mffc-9gx5-99g3)",
      date: "2022-05-14",
      advisory: "https://github.com/advisories/GHSA-mffc-9gx5-99g3"
    },
    asyncssh: {
      blocked_versions: [],
      reason: "AsyncSSH SSH Server Authentication Bypass (GHSA-97cv-6pjf-5f9q)",
      date: "2022-05-14",
      advisory: "https://github.com/advisories/GHSA-97cv-6pjf-5f9q"
    },
    donfig: {
      blocked_versions: [],
      reason: "Donfig Command Injection in collect_yaml method (GHSA-3qr5-h7w4-3gx3)",
      date: "2022-05-14",
      advisory: "https://github.com/advisories/GHSA-3qr5-h7w4-3gx3"
    },
    web2py: {
      blocked_versions: [],
      reason: "web2py is vulnerable to password brute-force attack (GHSA-gv85-wgxc-vc56)",
      date: "2022-05-14",
      advisory: "https://github.com/advisories/GHSA-gv85-wgxc-vc56"
    },
    sickrage: {
      blocked_versions: [],
      reason: "SiCKRAGE Discloses Plaintext Credentials (GHSA-jrcv-3c5h-rh3q)",
      date: "2022-05-13",
      advisory: "https://github.com/advisories/GHSA-jrcv-3c5h-rh3q"
    },
    pyanyapi: {
      blocked_versions: [],
      reason: "Unsafe pyyaml load usage in PyAnyAPI (GHSA-vg8g-jpm9-jh8r)",
      date: "2022-05-13",
      advisory: "https://github.com/advisories/GHSA-vg8g-jpm9-jh8r"
    },
    nnabla: {
      blocked_versions: [],
      reason: "Sony Neural Network Libraries reliance on untrusted inputs prior to v1.0.10 (GHSA-4q2w-rw7m-xqw6)",
      date: "2022-05-13",
      advisory: "https://github.com/advisories/GHSA-4q2w-rw7m-xqw6"
    },
    marcador: {
      blocked_versions: [],
      reason: "Code-execution backdoor in marcador (GHSA-57qv-h9m7-jxfg)",
      date: "2022-05-09",
      advisory: "https://github.com/advisories/GHSA-57qv-h9m7-jxfg"
    },
    "python-libnmap": {
      blocked_versions: [],
      reason: "Argument injection in python-libnmap (GHSA-qwqv-j7jr-4hp6)",
      date: "2022-05-06",
      advisory: "https://github.com/advisories/GHSA-qwqv-j7jr-4hp6"
    },
    djblets: {
      blocked_versions: [],
      reason: "ReviewBoard and Djblets library are vulnerable to code execution (GHSA-58h8-44mg-r43x)",
      date: "2022-05-05",
      advisory: "https://github.com/advisories/GHSA-58h8-44mg-r43x"
    },
    reviewboard: {
      blocked_versions: [],
      reason: "ReviewBoard and Djblets library are vulnerable to code execution (GHSA-58h8-44mg-r43x)",
      date: "2022-05-05",
      advisory: "https://github.com/advisories/GHSA-58h8-44mg-r43x"
    },
    zodb3: {
      blocked_versions: [],
      reason: "Zope Object Database (ZODB) Arbitrary files reading and deletion (GHSA-m52m-2qpx-9j4j)",
      date: "2022-05-02",
      advisory: "https://github.com/advisories/GHSA-m52m-2qpx-9j4j"
    },
    roundup: {
      blocked_versions: [],
      reason: "Roundup xml-rpc server improper check of property permissions (GHSA-j59j-h3g7-cpmf)",
      date: "2022-05-01",
      advisory: "https://github.com/advisories/GHSA-j59j-h3g7-cpmf"
    },
    httpx: {
      blocked_versions: [],
      reason: "Improper Input Validation in httpx (GHSA-h8pj-cxx2-jfg2)",
      date: "2022-04-29",
      advisory: "https://github.com/advisories/GHSA-h8pj-cxx2-jfg2"
    },
    twisted: {
      blocked_versions: [],
      reason: "Inconsistent Interpretation of HTTP Requests in twisted.web (GHSA-c2jg-hw38-jrqq)",
      date: "2022-04-04",
      advisory: "https://github.com/advisories/GHSA-c2jg-hw38-jrqq"
    },
    poetry: {
      blocked_versions: [],
      reason: "Poetry before v1.1.9 contains Untrusted Search Path (GHSA-xr2c-5w89-63pv)",
      date: "2022-03-23",
      advisory: "https://github.com/advisories/GHSA-xr2c-5w89-63pv"
    },
    mitmproxy: {
      blocked_versions: [],
      reason: "Insufficient Protection against HTTP Request Smuggling in mitmproxy (GHSA-gcx2-gvj7-pxv3)",
      date: "2022-03-22",
      advisory: "https://github.com/advisories/GHSA-gcx2-gvj7-pxv3"
    },
    libvcs: {
      blocked_versions: [],
      reason: "Command injection in libvcs and vcspull (GHSA-mv2w-4jqc-6fg4)",
      date: "2022-03-15",
      advisory: "https://github.com/advisories/GHSA-mv2w-4jqc-6fg4"
    },
    vcspull: {
      blocked_versions: [],
      reason: "Command injection in libvcs and vcspull (GHSA-mv2w-4jqc-6fg4)",
      date: "2022-03-15",
      advisory: "https://github.com/advisories/GHSA-mv2w-4jqc-6fg4"
    },
    gerapy: {
      blocked_versions: [],
      reason: "Duplicate Advisory: Incorrect Authorization in Gerapy (GHSA-29vr-79w7-p649)",
      date: "2022-03-11",
      advisory: "https://github.com/advisories/GHSA-29vr-79w7-p649"
    },
    "org.apache.spark:spark-parent_2.11": {
      blocked_versions: [],
      reason: "Improper Authentication in Apache Spark (GHSA-wgx7-jwwm-cgjv)",
      date: "2022-02-10",
      advisory: "https://github.com/advisories/GHSA-wgx7-jwwm-cgjv"
    },
    apkleaks: {
      blocked_versions: [],
      reason: "Improper Neutralization of Argument Delimiters in a Decompiling Package Process in APKLeaks (GHSA-8434-v7xw-8m9x)",
      date: "2022-01-21",
      advisory: "https://github.com/advisories/GHSA-8434-v7xw-8m9x"
    },
    "onionshare-cli": {
      blocked_versions: [],
      reason: "Remote unauthenticated attackers able to upload files in Onionshare (GHSA-7g47-xxff-9p85)",
      date: "2021-11-19",
      advisory: "https://github.com/advisories/GHSA-7g47-xxff-9p85"
    },
    "starkbank-ecdsa": {
      blocked_versions: [],
      reason: "Improper Verification of Cryptographic Signature in starkbank-ecdsa (GHSA-92vm-mxjf-jqf3)",
      date: "2021-11-10",
      advisory: "https://github.com/advisories/GHSA-92vm-mxjf-jqf3"
    },
    "jupyterhub-firstuseauthenticator": {
      blocked_versions: [],
      reason: "Improper Access Control in jupyterhub-firstuseauthenticator (GHSA-5xvc-vgmp-jgc3)",
      date: "2021-10-28",
      advisory: "https://github.com/advisories/GHSA-5xvc-vgmp-jgc3"
    },
    nameko: {
      blocked_versions: [],
      reason: "Nameko Arbitrary code execution due to YAML deserialization (GHSA-6p52-jr3q-c94g)",
      date: "2021-10-19",
      advisory: "https://github.com/advisories/GHSA-6p52-jr3q-c94g"
    },
    "omero-web": {
      blocked_versions: [],
      reason: "Inconsistent input sanitisation leads to XSS vectors (GHSA-g67g-hvc3-xmvf)",
      date: "2021-10-14",
      advisory: "https://github.com/advisories/GHSA-g67g-hvc3-xmvf"
    },
    "omero-figure": {
      blocked_versions: [],
      reason: "Inconsistent input sanitisation leads to XSS vectors (GHSA-g67g-hvc3-xmvf)",
      date: "2021-10-14",
      advisory: "https://github.com/advisories/GHSA-g67g-hvc3-xmvf"
    },
    "python-keystoneclient": {
      blocked_versions: [],
      reason: "Inadequate Encryption Strength in python-keystoneclient (GHSA-c3xq-cj8f-7829)",
      date: "2021-10-12",
      advisory: "https://github.com/advisories/GHSA-c3xq-cj8f-7829"
    },
    simiki: {
      blocked_versions: [],
      reason: "Command Injection in Simiki (GHSA-w873-xcqq-x922)",
      date: "2021-09-01",
      advisory: "https://github.com/advisories/GHSA-w873-xcqq-x922"
    },
    quokka: {
      blocked_versions: [],
      reason: "Improper Restriction of XML External Entity Reference in Quokka (GHSA-4q2r-qxp6-h5j6)",
      date: "2021-08-30",
      advisory: "https://github.com/advisories/GHSA-4q2r-qxp6-h5j6"
    },
    "django-widgy": {
      blocked_versions: [],
      reason: "Unrestricted Upload of File with Dangerous Type in django-widgy (GHSA-98hv-qff3-8793)",
      date: "2021-08-30",
      advisory: "https://github.com/advisories/GHSA-98hv-qff3-8793"
    },
    binderhub: {
      blocked_versions: [],
      reason: "remote code execution via git repo provider (GHSA-9jjr-qqfp-ppwx)",
      date: "2021-08-30",
      advisory: "https://github.com/advisories/GHSA-9jjr-qqfp-ppwx"
    },
    arrayfire: {
      blocked_versions: [],
      reason: "Potential memory corruption in arrayfire (GHSA-69fv-gw6g-8ccg)",
      date: "2021-08-25",
      advisory: "https://github.com/advisories/GHSA-69fv-gw6g-8ccg"
    },
    onefuzz: {
      blocked_versions: [],
      reason: "Improper Authorization and Origin Validation Error in OneFuzz (GHSA-q5vh-6whw-x745)",
      date: "2021-08-13",
      advisory: "https://github.com/advisories/GHSA-q5vh-6whw-x745"
    },
    impacket: {
      blocked_versions: [],
      reason: "Path traversal in impacket (GHSA-mj63-64x7-57xf)",
      date: "2021-06-18",
      advisory: "https://github.com/advisories/GHSA-mj63-64x7-57xf"
    },
    localstack: {
      blocked_versions: [],
      reason: "Command injection in LocalStack (GHSA-hpr6-f4vq-mxch)",
      date: "2021-06-18",
      advisory: "https://github.com/advisories/GHSA-hpr6-f4vq-mxch"
    },
    tendenci: {
      blocked_versions: [],
      reason: "Deserialization of Untrusted Data in Tendenci (GHSA-jqmc-fxxp-r589)",
      date: "2021-06-18",
      advisory: "https://github.com/advisories/GHSA-jqmc-fxxp-r589"
    },
    "jw.util": {
      blocked_versions: [],
      reason: "OS Command Injection in jw.util (GHSA-h72c-w3q3-55qq)",
      date: "2021-06-02",
      advisory: "https://github.com/advisories/GHSA-h72c-w3q3-55qq"
    },
    svglib: {
      blocked_versions: [],
      reason: "SVGlib Vulnerable to XXE Attacks (GHSA-3vcg-8p79-jpcv)",
      date: "2021-05-06",
      advisory: "https://github.com/advisories/GHSA-3vcg-8p79-jpcv"
    },
    libtaxii: {
      blocked_versions: [],
      reason: "libtaxii Server-Side Request Forgery vulnerability (GHSA-836c-xg97-8p4h)",
      date: "2021-04-30",
      advisory: "https://github.com/advisories/GHSA-836c-xg97-8p4h"
    },
    pyyaml: {
      blocked_versions: [],
      reason: "Deserialization of Untrusted Data in PyYAML (GHSA-3pqx-4fqf-j49f)",
      date: "2021-04-20",
      advisory: "https://github.com/advisories/GHSA-3pqx-4fqf-j49f"
    },
    petl: {
      blocked_versions: [],
      reason: "Duplicate Advisory: XML Injection in petl (GHSA-69q2-p9xp-739v)",
      date: "2021-04-20",
      advisory: "https://github.com/advisories/GHSA-69q2-p9xp-739v"
    },
    asyncpg: {
      blocked_versions: [],
      reason: "Asyncpg Arbitrary Code Execution Via Access to an Uninitialized Pointer (GHSA-2xpj-f5g2-8p7m)",
      date: "2021-04-20",
      advisory: "https://github.com/advisories/GHSA-2xpj-f5g2-8p7m"
    },
    pwntools: {
      blocked_versions: [],
      reason: "pwntools Server-Side Template Injection (SSTI) vulnerability (GHSA-7xc5-ggpp-g249)",
      date: "2021-04-20",
      advisory: "https://github.com/advisories/GHSA-7xc5-ggpp-g249"
    },
    "clickhouse-driver": {
      blocked_versions: [],
      reason: "Arbitrary code execution in clickhouse-driver (GHSA-vgv5-cxvh-vfxh)",
      date: "2021-04-07",
      advisory: "https://github.com/advisories/GHSA-vgv5-cxvh-vfxh"
    },
    "datasette-indieauth": {
      blocked_versions: [],
      reason: 'Implementation trusts the "me" field returned by the authorization server without verifying it (GHSA-mjcr-rqjg-rhg3)',
      date: "2020-11-24",
      advisory: "https://github.com/advisories/GHSA-mjcr-rqjg-rhg3"
    },
    "alerta-server": {
      blocked_versions: [],
      reason: "LDAP authentication bypass with empty password (GHSA-5hmm-x8q8-w5jh)",
      date: "2020-11-06",
      advisory: "https://github.com/advisories/GHSA-5hmm-x8q8-w5jh"
    },
    lookatme: {
      blocked_versions: [],
      reason: "Markdown-supplied Shell Command Execution (GHSA-c84h-w6cr-5v8q)",
      date: "2020-10-27",
      advisory: "https://github.com/advisories/GHSA-c84h-w6cr-5v8q"
    },
    tuf: {
      blocked_versions: [],
      reason: "Incorrect threshold signature computation in TUF (GHSA-pwqf-9h7j-7mv8)",
      date: "2020-08-21",
      advisory: "https://github.com/advisories/GHSA-pwqf-9h7j-7mv8"
    },
    "indy-node": {
      blocked_versions: [],
      reason: "Uncontrolled Resource Consumption in Indy Node (GHSA-3gw4-m5w7-v89c)",
      date: "2020-06-11",
      advisory: "https://github.com/advisories/GHSA-3gw4-m5w7-v89c"
    },
    "drf-jwt": {
      blocked_versions: [],
      reason: "Django Rest Framework jwt allows obtaining new token from notionally invalidated token (GHSA-fpjm-rp2g-3r4c)",
      date: "2020-06-05",
      advisory: "https://github.com/advisories/GHSA-fpjm-rp2g-3r4c"
    },
    ecdsa: {
      blocked_versions: [],
      reason: "Improper Verification of Cryptographic Signature in Pure-Python ECDSA (GHSA-8qxj-f9rh-9fg2)",
      date: "2020-04-01",
      advisory: "https://github.com/advisories/GHSA-8qxj-f9rh-9fg2"
    },
    "easybuild-framework": {
      blocked_versions: [],
      reason: "GitHub personal access token leaking into temporary EasyBuild (debug) logs (GHSA-2wx6-wc87-rmjm)",
      date: "2020-03-19",
      advisory: "https://github.com/advisories/GHSA-2wx6-wc87-rmjm"
    },
    "psd-tools": {
      blocked_versions: [],
      reason: "Potential buffer overflow in psd-tools (GHSA-22jr-vc7j-g762)",
      date: "2020-03-16",
      advisory: "https://github.com/advisories/GHSA-22jr-vc7j-g762"
    },
    docutils: {
      blocked_versions: [],
      reason: "python-docutils allows insecure usage of temporary files (GHSA-cg75-6938-wx58)",
      date: "2020-03-13",
      advisory: "https://github.com/advisories/GHSA-cg75-6938-wx58"
    },
    "requests-kerberos": {
      blocked_versions: [],
      reason: "Improper Authentication in requests-kerberos (GHSA-wh37-37xw-54hr)",
      date: "2020-03-10",
      advisory: "https://github.com/advisories/GHSA-wh37-37xw-54hr"
    },
    rediswrapper: {
      blocked_versions: [],
      reason: "Uncontrolled deserialization of a pickled object in rediswrapper allows attackers to execute arbitrary scripts (GHSA-vrcf-g539-x6h3)",
      date: "2019-11-20",
      advisory: "https://github.com/advisories/GHSA-vrcf-g539-x6h3"
    },
    limnoria: {
      blocked_versions: [],
      reason: "Eval injection in Supybot/Limnoria (GHSA-6g88-vr3v-76mf)",
      date: "2019-11-20",
      advisory: "https://github.com/advisories/GHSA-6g88-vr3v-76mf"
    },
    mitogen: {
      blocked_versions: [],
      reason: "Undirectional routing wasn't respected in some cases in Mitogen (GHSA-8rf6-w2mx-4xjh)",
      date: "2019-08-19",
      advisory: "https://github.com/advisories/GHSA-8rf6-w2mx-4xjh"
    },
    aubio: {
      blocked_versions: [],
      reason: "aubio Buffer Overflow vulnerability (GHSA-grmf-4fq6-2r79)",
      date: "2019-07-26",
      advisory: "https://github.com/advisories/GHSA-grmf-4fq6-2r79"
    },
    ladon: {
      blocked_versions: [],
      reason: "Improper Restriction of XML External Entity Reference in ladon (GHSA-vg35-vc9f-q7x2)",
      date: "2019-07-26",
      advisory: "https://github.com/advisories/GHSA-vg35-vc9f-q7x2"
    },
    "python-ironic-inspector-client": {
      blocked_versions: [],
      reason: "Injection vulnerability that affects ironic-discoverd (GHSA-x64g-wjmw-w328)",
      date: "2019-07-05",
      advisory: "https://github.com/advisories/GHSA-x64g-wjmw-w328"
    },
    "ironic-inspector": {
      blocked_versions: [],
      reason: "Injection vulnerability that affects ironic-discoverd (GHSA-x64g-wjmw-w328)",
      date: "2019-07-05",
      advisory: "https://github.com/advisories/GHSA-x64g-wjmw-w328"
    },
    "django-rest-registration": {
      blocked_versions: [],
      reason: "Improper Verification of Cryptographic Signature in django-rest-registration (GHSA-p3w6-jcg4-52xh)",
      date: "2019-07-02",
      advisory: "https://github.com/advisories/GHSA-p3w6-jcg4-52xh"
    },
    buildbot: {
      blocked_versions: [],
      reason: "Improper Authentication in Buildbot (GHSA-g86p-hgx5-2pfh)",
      date: "2019-05-29",
      advisory: "https://github.com/advisories/GHSA-g86p-hgx5-2pfh"
    },
    "splunk-sdk": {
      blocked_versions: [],
      reason: "splunk-sdk does not properly verify untrusted TLS server certificates (GHSA-f58w-649r-qjr9)",
      date: "2019-03-25",
      advisory: "https://github.com/advisories/GHSA-f58w-649r-qjr9"
    },
    ipycache: {
      blocked_versions: [],
      reason: "ipycache is vulnerable to Code Injection (GHSA-gcm4-q2pg-xw89)",
      date: "2019-03-25",
      advisory: "https://github.com/advisories/GHSA-gcm4-q2pg-xw89"
    },
    modulemd: {
      blocked_versions: [],
      reason: "modulemd uses an unsafe function for processing externally provided data (GHSA-jhjh-ghwx-6h7r)",
      date: "2019-01-17",
      advisory: "https://github.com/advisories/GHSA-jhjh-ghwx-6h7r"
    },
    recurly: {
      blocked_versions: [],
      reason: "Recurly vulnerable to SSRF (GHSA-38rv-5jqc-m2cv)",
      date: "2019-01-04",
      advisory: "https://github.com/advisories/GHSA-38rv-5jqc-m2cv"
    },
    bleach: {
      blocked_versions: [],
      reason: "Bleach URI Scheme Restriction Bypass (GHSA-m9mq-p2f9-cfqv)",
      date: "2019-01-04",
      advisory: "https://github.com/advisories/GHSA-m9mq-p2f9-cfqv"
    },
    ymlref: {
      blocked_versions: [],
      reason: "Code injection in ymlref (GHSA-8r8j-xvfj-36f9)",
      date: "2018-12-19",
      advisory: "https://github.com/advisories/GHSA-8r8j-xvfj-36f9"
    },
    pycrypto: {
      blocked_versions: [],
      reason: "Buffer Overflow in pycrypto (GHSA-cq27-v7xp-c356)",
      date: "2018-12-14",
      advisory: "https://github.com/advisories/GHSA-cq27-v7xp-c356"
    },
    urllib3: {
      blocked_versions: [],
      reason: "Exposure of Sensitive Information to an Unauthorized Actor in urllib3 (GHSA-www2-v7xj-xrc6)",
      date: "2018-12-12",
      advisory: "https://github.com/advisories/GHSA-www2-v7xj-xrc6"
    },
    superset: {
      blocked_versions: [],
      reason: "Deserialization of Untrusted Data in superset (GHSA-vxp9-wv2f-wqmw)",
      date: "2018-11-09",
      advisory: "https://github.com/advisories/GHSA-vxp9-wv2f-wqmw"
    },
    "python-gnupg": {
      blocked_versions: [],
      reason: "python-gnupg vulnerable to shell injection (GHSA-vcr5-xr9h-mvc5)",
      date: "2018-11-06",
      advisory: "https://github.com/advisories/GHSA-vcr5-xr9h-mvc5"
    },
    pycsw: {
      blocked_versions: [],
      reason: "SQL Injection in pycsw (GHSA-hg4c-rgvm-964g)",
      date: "2018-08-15",
      advisory: "https://github.com/advisories/GHSA-hg4c-rgvm-964g"
    },
    rope: {
      blocked_versions: [],
      reason: "Code injection in rope (GHSA-r38r-qp28-2m63)",
      date: "2018-07-26",
      advisory: "https://github.com/advisories/GHSA-r38r-qp28-2m63"
    },
    "django-piston": {
      blocked_versions: [],
      reason: "Django-piston and Django-tastypie do not properly deserialize YAML data (GHSA-pvhp-v9qp-xf5r)",
      date: "2018-07-23",
      advisory: "https://github.com/advisories/GHSA-pvhp-v9qp-xf5r"
    },
    confire: {
      blocked_versions: [],
      reason: "Unsafe deserialization in confire (GHSA-m85c-9mf8-m2m6)",
      date: "2018-07-18",
      advisory: "https://github.com/advisories/GHSA-m85c-9mf8-m2m6"
    },
    tablib: {
      blocked_versions: [],
      reason: "Loaded Databook of Tablib prone to python insertion resulting in command execution (GHSA-gcr6-rf47-jrgf)",
      date: "2018-07-13",
      advisory: "https://github.com/advisories/GHSA-gcr6-rf47-jrgf"
    },
    diffoscope: {
      blocked_versions: [],
      reason: "Diffoscope may write to arbitrary locations due to an untrusted archive (GHSA-8p5c-f328-9fvv)",
      date: "2018-07-13",
      advisory: "https://github.com/advisories/GHSA-8p5c-f328-9fvv"
    },
    owlmixin: {
      blocked_versions: [],
      reason: "Unsafe deserialization in owlmixin (GHSA-ccmq-qvcp-5mrm)",
      date: "2018-07-13",
      advisory: "https://github.com/advisories/GHSA-ccmq-qvcp-5mrm"
    },
    mlalchemy: {
      blocked_versions: [],
      reason: "Unsafe deserialization in MLAlchemy (GHSA-xpm8-98mx-h4c5)",
      date: "2018-07-13",
      advisory: "https://github.com/advisories/GHSA-xpm8-98mx-h4c5"
    },
    django_make_app: {
      blocked_versions: [],
      reason: "django_make_app is vulnerable to Code Injection (GHSA-9pv8-q5rx-c8gq)",
      date: "2018-07-13",
      advisory: "https://github.com/advisories/GHSA-9pv8-q5rx-c8gq"
    },
    koji: {
      blocked_versions: [],
      reason: "Koji hub call does not perform correct access checks (GHSA-6mww-xvh7-fq4f)",
      date: "2018-07-12",
      advisory: "https://github.com/advisories/GHSA-6mww-xvh7-fq4f"
    },
    eve: {
      blocked_versions: [],
      reason: "Eve allows execution of arbitrary code (GHSA-8jxq-75rw-fhj9)",
      date: "2018-07-12",
      advisory: "https://github.com/advisories/GHSA-8jxq-75rw-fhj9"
    },
    paramiko: {
      blocked_versions: [],
      reason: "Paramiko not properly checking authentication before processing other requests (GHSA-232r-66cg-79px)",
      date: "2018-07-12",
      advisory: "https://github.com/advisories/GHSA-232r-66cg-79px"
    }
  },
  npm: {
    "event-stream": {
      blocked_versions: [
        "3.3.6"
      ],
      reason: "Flatmap-stream crypto wallet stealer",
      date: "2018-11-26"
    },
    "ua-parser-js": {
      blocked_versions: [
        "0.7.29",
        "0.8.0",
        "1.0.0"
      ],
      reason: "Supply chain attack - crypto miner and password stealer",
      date: "2021-10-22"
    },
    colors: {
      blocked_versions: [
        "1.4.1",
        "1.4.2"
      ],
      reason: "Developer protest - infinite loop DoS (Marak incident)",
      date: "2022-01-09"
    },
    faker: {
      blocked_versions: [
        "6.6.6"
      ],
      reason: "Developer protest - malicious payload (Marak incident)",
      date: "2022-01-05"
    },
    "node-ipc": {
      blocked_versions: [
        "10.1.1",
        "10.1.2",
        "10.1.3"
      ],
      reason: "Peacenotwar malware - file deletion targeting Russian/Belarusian IPs",
      date: "2022-03-15"
    },
    coa: {
      blocked_versions: [
        "2.0.3",
        "2.0.4",
        "2.1.1",
        "2.1.3",
        "3.0.1",
        "3.1.3"
      ],
      reason: "Compromised maintainer account - credential stealer",
      date: "2021-11-04"
    },
    rc: {
      blocked_versions: [
        "1.2.9",
        "1.3.9",
        "2.3.9"
      ],
      reason: "Compromised maintainer account - credential stealer",
      date: "2021-11-04"
    },
    "@finxsecdemo/utils": {
      blocked_all: true,
      reason: "Malicious code in @finxsecdemo/utils (npm) (GHSA-qccg-fq42-3rgc)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-qccg-fq42-3rgc"
    },
    zer0code: {
      blocked_all: true,
      reason: "Malware in zer0code (GHSA-frrq-7m67-mgxg)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-frrq-7m67-mgxg"
    },
    "@omniwatch-wick/cli": {
      blocked_all: true,
      reason: "Malware in @omniwatch-wick/cli (GHSA-x4cm-7r6h-pjg3)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-x4cm-7r6h-pjg3"
    },
    "chain-manager": {
      blocked_all: true,
      reason: "Malware in chain-manager (GHSA-257g-ggr2-j398)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-257g-ggr2-j398"
    },
    "chain-analyze": {
      blocked_all: true,
      reason: "Malware in chain-analyze (GHSA-vmj5-cm6w-jrgj)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-vmj5-cm6w-jrgj"
    },
    "@bowozzz/baileys": {
      blocked_all: true,
      reason: "Malware in @bowozzz/baileys (GHSA-f9vh-885g-hv2f)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-f9vh-885g-hv2f"
    },
    toll_free: {
      blocked_all: true,
      reason: "Malicious code in toll_free (npm) (GHSA-8grw-9ghp-8r94)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-8grw-9ghp-8r94"
    },
    blots: {
      blocked_all: true,
      reason: "Malicious code in blots (npm) (GHSA-m24q-pqxm-qhqw)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-m24q-pqxm-qhqw"
    },
    "@mypwn/hawkeye": {
      blocked_all: true,
      reason: "Malicious code in @mypwn/hawkeye (npm) (GHSA-28p4-h97c-j397)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-28p4-h97c-j397"
    },
    "@joyfill/layouts": {
      blocked_all: true,
      reason: "Malware in @joyfill/layouts (GHSA-887f-rwr9-wp54)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-887f-rwr9-wp54"
    },
    "@joyfill/components": {
      blocked_all: true,
      reason: "Malware in @joyfill/components (GHSA-x4p3-wjxx-m4x5)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-x4p3-wjxx-m4x5"
    },
    "streak-core-math": {
      blocked_all: true,
      reason: "Malicious code in streak-core-math (npm) (GHSA-g827-wm64-px2q)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-g827-wm64-px2q"
    },
    "simple-probe-utils": {
      blocked_all: true,
      reason: "Malicious code in simple-probe-utils (npm) (GHSA-9j4g-h77m-3g6m)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-9j4g-h77m-3g6m"
    },
    "sigchain-js": {
      blocked_all: true,
      reason: "Malicious code in sigchain-js (npm) (GHSA-j78w-wm55-982q)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-j78w-wm55-982q"
    },
    "streak-daily-lib": {
      blocked_all: true,
      reason: "Malicious code in streak-daily-lib (npm) (GHSA-456x-5qpf-qrrw)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-456x-5qpf-qrrw"
    },
    "rollup-runtime-core-polyfills": {
      blocked_all: true,
      reason: "Malicious code in rollup-runtime-core-polyfills (npm) (GHSA-j877-m36j-5p92)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-j877-m36j-5p92"
    },
    "xerohub-discord-voice-v3": {
      blocked_all: true,
      reason: "Malicious code in xerohub-discord-voice-v3 (npm) (GHSA-xw2v-59xv-3c84)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-xw2v-59xv-3c84"
    },
    "tidal-embed-player": {
      blocked_all: true,
      reason: "Malicious code in tidal-embed-player (npm) (GHSA-gfxj-v4hg-f5h7)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-gfxj-v4hg-f5h7"
    },
    "text-line-parser": {
      blocked_all: true,
      reason: "Malicious code in text-line-parser (npm) (GHSA-hp3v-hcrw-9mf8)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-hp3v-hcrw-9mf8"
    },
    "xerohub-discord-voice-v2": {
      blocked_all: true,
      reason: "Malicious code in xerohub-discord-voice-v2 (npm) (GHSA-3h72-42vm-wphp)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-3h72-42vm-wphp"
    },
    triage_bot_using_sdkv3: {
      blocked_all: true,
      reason: "Malicious code in triage_bot_using_sdkv3 (npm) (GHSA-8pwc-32rm-4cgm)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-8pwc-32rm-4cgm"
    },
    "streak-core-lib": {
      blocked_all: true,
      reason: "Malicious code in streak-core-lib (npm) (GHSA-7vpc-qq63-xvwj)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-7vpc-qq63-xvwj"
    },
    "api-node-sdk": {
      blocked_all: true,
      reason: "Malicious code in api-node-sdk (npm) (GHSA-c836-6399-93jv)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-c836-6399-93jv"
    },
    "array-node-utils": {
      blocked_all: true,
      reason: "Malicious code in array-node-utils (npm) (GHSA-gv25-mh5m-p7gp)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-gv25-mh5m-p7gp"
    },
    "react-puller": {
      blocked_all: true,
      reason: "Malicious code in react-puller (npm) (GHSA-pg26-7r73-h7pp)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-pg26-7r73-h7pp"
    },
    "jobber-app-template-react": {
      blocked_all: true,
      reason: "Malicious code in jobber-app-template-react (npm) (GHSA-j6qc-95jf-9rqf)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-j6qc-95jf-9rqf"
    },
    "basic-vite": {
      blocked_all: true,
      reason: "Malicious code in basic-vite (npm) (GHSA-x36g-6hf7-wr48)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-x36g-6hf7-wr48"
    },
    kordyn: {
      blocked_all: true,
      reason: "Malicious code in kordyn (npm) (GHSA-4mhx-3hm9-cfpf)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-4mhx-3hm9-cfpf"
    },
    "app-soda-layer": {
      blocked_all: true,
      reason: "Malicious code in app-soda-layer (npm) (GHSA-2q8x-gg6r-p5hg)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-2q8x-gg6r-p5hg"
    },
    "bianira-ui": {
      blocked_all: true,
      reason: "Malicious code in bianira-ui (npm) (GHSA-w3r2-397p-xcfw)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-w3r2-397p-xcfw"
    },
    "color-convert-helper": {
      blocked_all: true,
      reason: "Malicious code in color-convert-helper (npm) (GHSA-4682-ww49-563f)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-4682-ww49-563f"
    },
    "api-rust-sdk": {
      blocked_all: true,
      reason: "Malicious code in api-rust-sdk (npm) (GHSA-4hhr-c99m-jq9f)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-4hhr-c99m-jq9f"
    },
    "app-svm-layer": {
      blocked_all: true,
      reason: "Malicious code in app-svm-layer (npm) (GHSA-7m36-xw8v-8hq9)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-7m36-xw8v-8hq9"
    },
    parallely: {
      blocked_all: true,
      reason: "Malicious code in parallely (npm) (GHSA-mxc4-6gh5-wpvw)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-mxc4-6gh5-wpvw"
    },
    "json-schema-inspector": {
      blocked_all: true,
      reason: "Malicious code in json-schema-inspector (npm) (GHSA-m8v5-qxc2-v92m)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-m8v5-qxc2-v92m"
    },
    korvica: {
      blocked_all: true,
      reason: "Malicious code in korvica (npm) (GHSA-5h49-444p-9g8v)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-5h49-444p-9g8v"
    },
    "lib-streak-math": {
      blocked_all: true,
      reason: "Malicious code in lib-streak-math (npm) (GHSA-7hfx-rf8h-6j2g)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-7hfx-rf8h-6j2g"
    },
    "ethers-secure": {
      blocked_all: true,
      reason: "Malicious code in ethers-secure (npm) (GHSA-379c-c2fc-xj46)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-379c-c2fc-xj46"
    },
    "fluid-type-ui": {
      blocked_all: true,
      reason: "Malicious code in fluid-type-ui (npm) (GHSA-44q9-v3f9-xcx6)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-44q9-v3f9-xcx6"
    },
    "node-array-plus": {
      blocked_all: true,
      reason: "Malicious code in node-array-plus (npm) (GHSA-mgw3-3jfq-3gwx)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-mgw3-3jfq-3gwx"
    },
    "@crbrc/xbt": {
      blocked_all: true,
      reason: "Malicious code in @crbrc/xbt (npm) (GHSA-f3f6-vqm6-jv4v)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-f3f6-vqm6-jv4v"
    },
    "@yancyyu/agentcli": {
      blocked_all: true,
      reason: "Malicious code in @yancyyu/agentcli (npm) (GHSA-wqc4-72w7-qr9g)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-wqc4-72w7-qr9g"
    },
    "app-sim-layer": {
      blocked_all: true,
      reason: "Malicious code in app-sim-layer (npm) (GHSA-363f-gw2q-m6j5)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-363f-gw2q-m6j5"
    },
    "app-sima-layer": {
      blocked_all: true,
      reason: "Malicious code in app-sima-layer (npm) (GHSA-gxmw-r885-6v87)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-gxmw-r885-6v87"
    },
    "@apexfnd/apex": {
      blocked_all: true,
      reason: "Malicious code in @apexfnd/apex (npm) (GHSA-r3xx-75gm-53pm)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-r3xx-75gm-53pm"
    },
    "@ai_/autoprefixers": {
      blocked_all: true,
      reason: "Malicious code in @ai_/autoprefixers (npm) (GHSA-8hhx-8x59-hr55)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-8hhx-8x59-hr55"
    },
    "postcss-motion-utils": {
      blocked_all: true,
      reason: "Malware in postcss-motion-utils (GHSA-m763-9wch-p9gg)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-m763-9wch-p9gg"
    },
    "local-config-parser": {
      blocked_all: true,
      reason: "Malware in local-config-parser (GHSA-f463-rm4g-746g)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-f463-rm4g-746g"
    },
    "lib-mtop": {
      blocked_all: true,
      reason: "Malware in lib-mtop (GHSA-vrrg-j2c5-mj4v)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-vrrg-j2c5-mj4v"
    },
    "aone-sandbox": {
      blocked_all: true,
      reason: "Malware in aone-sandbox (GHSA-mv5v-q5f3-gf7h)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-mv5v-q5f3-gf7h"
    },
    "aone-kit": {
      blocked_all: true,
      reason: "Malware in aone-kit (GHSA-7w6g-48pj-7977)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-7w6g-48pj-7977"
    },
    "aone-kit-cli": {
      blocked_all: true,
      reason: "Malware in aone-kit-cli (GHSA-55qq-2qq4-c47g)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-55qq-2qq4-c47g"
    },
    "cloud-config-fetcher": {
      blocked_all: true,
      reason: "Malware in cloud-config-fetcher (GHSA-25r8-r3cf-28q4)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-25r8-r3cf-28q4"
    },
    "smart-config-manager": {
      blocked_all: true,
      reason: "Malware in smart-config-manager (GHSA-v644-r975-m85m)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-v644-r975-m85m"
    },
    "string-format-kit": {
      blocked_all: true,
      reason: "Malicious code in string-format-kit (npm) (GHSA-xqqx-722m-55gr)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-xqqx-722m-55gr"
    },
    "num-format-helper": {
      blocked_all: true,
      reason: "Malicious code in num-format-helper (npm) (GHSA-jf75-cqhp-mhch)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-jf75-cqhp-mhch"
    },
    "date-sanitize-helper": {
      blocked_all: true,
      reason: "Malicious code in date-sanitize-helper (npm) (GHSA-jj2h-2x77-rrwf)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-jj2h-2x77-rrwf"
    },
    "@wagni_bot/web3": {
      blocked_all: true,
      reason: "Malicious code in @wagni_bot/web3 (npm) (GHSA-48gg-v3w4-m38v)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-48gg-v3w4-m38v"
    },
    "@wagni_bot/wagni": {
      blocked_all: true,
      reason: "Malicious code in @wagni_bot/wagni (npm) (GHSA-c324-fqr6-v3cw)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-c324-fqr6-v3cw"
    },
    "@wagni_bot/polygon": {
      blocked_all: true,
      reason: "Malicious code in @wagni_bot/polygon (npm) (GHSA-5w5j-423r-2x73)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-5w5j-423r-2x73"
    },
    "@wagni_bot/polymarket": {
      blocked_all: true,
      reason: "Malicious code in @wagni_bot/polymarket (npm) (GHSA-46gp-xx3g-2cqr)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-46gp-xx3g-2cqr"
    },
    "@wagni_bot/opensea": {
      blocked_all: true,
      reason: "Malicious code in @wagni_bot/opensea (npm) (GHSA-c84m-x93c-fwjj)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-c84m-x93c-fwjj"
    },
    "@wagni_bot/metamask": {
      blocked_all: true,
      reason: "Malicious code in @wagni_bot/metamask (npm) (GHSA-vg7p-qg4j-56rc)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-vg7p-qg4j-56rc"
    },
    "@wagni_bot/hyperliquid": {
      blocked_all: true,
      reason: "Malicious code in @wagni_bot/hyperliquid (npm) (GHSA-35jp-phg5-g2hr)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-35jp-phg5-g2hr"
    },
    "@wagni_bot/bsc": {
      blocked_all: true,
      reason: "Malicious code in @wagni_bot/bsc (npm) (GHSA-r3x3-gxmq-rmhj)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-r3x3-gxmq-rmhj"
    },
    "@wagni_bot/eth": {
      blocked_all: true,
      reason: "Malicious code in @wagni_bot/eth (npm) (GHSA-vr92-xmj8-jr8v)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-vr92-xmj8-jr8v"
    },
    "json-to-table-util": {
      blocked_all: true,
      reason: "Malicious code in json-to-table-util (npm) (GHSA-j9fg-prmr-97cw)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-j9fg-prmr-97cw"
    },
    "array-sort-helper": {
      blocked_all: true,
      reason: "Malicious code in array-sort-helper (npm) (GHSA-mx6g-xr3v-fc2f)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-mx6g-xr3v-fc2f"
    },
    "@vaultflow/update-flow": {
      blocked_all: true,
      reason: "Malware in @vaultflow/update-flow (GHSA-gv55-mvjq-232h)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-gv55-mvjq-232h"
    },
    "@vaultflow/create-flow": {
      blocked_all: true,
      reason: "Malware in @vaultflow/create-flow (GHSA-xpp9-qw49-cpw2)",
      date: "2026-07-28",
      advisory: "https://github.com/advisories/GHSA-xpp9-qw49-cpw2"
    },
    "motion-forge-css": {
      blocked_all: true,
      reason: "Malware in motion-forge-css (GHSA-3v24-55c2-cpp9)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-3v24-55c2-cpp9"
    },
    "truffle-helper": {
      blocked_all: true,
      reason: "Malicious code in truffle-helper (npm) (GHSA-2cq2-c7vh-j55c)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-2cq2-c7vh-j55c"
    },
    "truffle-js": {
      blocked_all: true,
      reason: "Malicious code in truffle-js (npm) (GHSA-7cmq-x9fp-ppg5)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-7cmq-x9fp-ppg5"
    },
    "web3-core-js": {
      blocked_all: true,
      reason: "Malicious code in web3-core-js (npm) (GHSA-f75h-gv5f-cg2x)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-f75h-gv5f-cg2x"
    },
    "solc-helper": {
      blocked_all: true,
      reason: "Malicious code in solc-helper (npm) (GHSA-8mmw-f9x4-8m2v)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-8mmw-f9x4-8m2v"
    },
    "typography-stylecss": {
      blocked_all: true,
      reason: "Malicious code in typography-stylecss (npm) (GHSA-vqg5-mfj2-mmrr)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-vqg5-mfj2-mmrr"
    },
    sysbin: {
      blocked_all: true,
      reason: "Malicious code in sysbin (npm) (GHSA-jxmp-2j7x-rvwp)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-jxmp-2j7x-rvwp"
    },
    "rimraf-utils": {
      blocked_all: true,
      reason: "Malicious code in rimraf-utils (npm) (GHSA-9fg9-r489-hq34)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-9fg9-r489-hq34"
    },
    "joi-pack": {
      blocked_all: true,
      reason: "Malicious code in joi-pack (npm) (GHSA-2p7q-46c9-cjgf)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-2p7q-46c9-cjgf"
    },
    "chalk-utils": {
      blocked_all: true,
      reason: "Malicious code in chalk-utils (npm) (GHSA-qfhf-894c-75p7)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-qfhf-894c-75p7"
    },
    "nock-helper": {
      blocked_all: true,
      reason: "Malicious code in nock-helper (npm) (GHSA-335w-3phj-h2jj)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-335w-3phj-h2jj"
    },
    "ethers-common": {
      blocked_all: true,
      reason: "Malicious code in ethers-common (npm) (GHSA-853h-mq9w-93p4)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-853h-mq9w-93p4"
    },
    "env-threads": {
      blocked_all: true,
      reason: "Malicious code in env-threads (npm) (GHSA-j3r8-fm75-pfq7)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-j3r8-fm75-pfq7"
    },
    "glob-helper": {
      blocked_all: true,
      reason: "Malicious code in glob-helper (npm) (GHSA-5f9h-7gp2-hg2m)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-5f9h-7gp2-hg2m"
    },
    "hello-world-pkg-value-value-p": {
      blocked_all: true,
      reason: "Malicious code in hello-world-pkg-value-value-p (npm) (GHSA-7mhg-447r-w46p)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-7mhg-447r-w46p"
    },
    "dotenvv-tool": {
      blocked_all: true,
      reason: "Malicious code in dotenvv-tool (npm) (GHSA-v6vw-vv5w-p658)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-v6vw-vv5w-p658"
    },
    "exxpress-tool": {
      blocked_all: true,
      reason: "Malicious code in exxpress-tool (npm) (GHSA-xfj5-439g-p6qm)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-xfj5-439g-p6qm"
    },
    "@design-system-coopeuch/web": {
      blocked_all: true,
      reason: "Malicious code in @design-system-coopeuch/web (npm) (GHSA-4fqj-2fv5-gj83)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-4fqj-2fv5-gj83"
    },
    "cdp-core": {
      blocked_all: true,
      reason: "Malicious code in cdp-core (npm) (GHSA-xc49-p4pq-83rq)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-xc49-p4pq-83rq"
    },
    "paysafe-gbp-virtual-assistant-lib-fe": {
      blocked_all: true,
      reason: "Malicious code in paysafe-gbp-virtual-assistant-lib-fe (npm) (GHSA-cprr-jmxq-pj2p)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-cprr-jmxq-pj2p"
    },
    "boring-avatars-vanilla": {
      blocked_all: true,
      reason: "Malicious code in boring-avatars-vanilla (npm) (GHSA-37pp-fr38-g266)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-37pp-fr38-g266"
    },
    "ethers-io": {
      blocked_all: true,
      reason: "Malicious code in ethers-io (npm) (GHSA-rmhg-qfp9-hvvm)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-rmhg-qfp9-hvvm"
    },
    "cache-poisoning-pwn-demo": {
      blocked_all: true,
      reason: "Malicious code in cache-poisoning-pwn-demo (npm) (GHSA-fg76-6277-9c5c)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-fg76-6277-9c5c"
    },
    "@webapp-next/store": {
      blocked_all: true,
      reason: "Malicious code in @webapp-next/store (npm) (GHSA-9frp-9f8j-wj97)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-9frp-9f8j-wj97"
    },
    "chalk-pack": {
      blocked_all: true,
      reason: "Malicious code in chalk-pack (npm) (GHSA-v7hx-pp9r-7rvr)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-v7hx-pp9r-7rvr"
    },
    "vue-template-compiler-plugin": {
      blocked_all: true,
      reason: "Malicious code in vue-template-compiler-plugin (npm) (GHSA-766p-9cxp-2xxh)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-766p-9cxp-2xxh"
    },
    "request-logger-canary": {
      blocked_all: true,
      reason: "Malicious code in request-logger-canary (npm) (GHSA-wx62-h3rg-4284)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-wx62-h3rg-4284"
    },
    "mcp-echarts": {
      blocked_all: true,
      reason: "Malicious code in mcp-echarts (npm) (GHSA-33m7-5xmx-p58p)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-33m7-5xmx-p58p"
    },
    "exxpress-utils": {
      blocked_all: true,
      reason: "Malicious code in exxpress-utils (npm) (GHSA-pjc4-9jjg-gqx4)",
      date: "2026-07-27",
      advisory: "https://github.com/advisories/GHSA-pjc4-9jjg-gqx4"
    },
    "js-client-node": {
      blocked_all: true,
      reason: "Malware in js-client-node (GHSA-x7hp-6x9v-c662)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-x7hp-6x9v-c662"
    },
    "react-fast-refresh-helper": {
      blocked_all: true,
      reason: "Malware in react-fast-refresh-helper (GHSA-p32r-hmph-46qm)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-p32r-hmph-46qm"
    },
    test2221: {
      blocked_all: true,
      reason: "Malicious code in test2221 (npm) (GHSA-76mv-v3rc-4p79)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-76mv-v3rc-4p79"
    },
    "litespeed-cache": {
      blocked_all: true,
      reason: "Malware in litespeed-cache (GHSA-vxgg-x9mm-892p)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-vxgg-x9mm-892p"
    },
    "n8n-nodes-trust-me-im-totally-safe": {
      blocked_all: true,
      reason: "Malware in n8n-nodes-trust-me-im-totally-safe (GHSA-58v7-66mp-4mf4)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-58v7-66mp-4mf4"
    },
    "@ai-plus/de-agent-sdk": {
      blocked_all: true,
      reason: "Malware in @ai-plus/de-agent-sdk (GHSA-4c3x-2hh8-6pp9)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-4c3x-2hh8-6pp9"
    },
    "@ai-plus/de-agent": {
      blocked_all: true,
      reason: "Malware in @ai-plus/de-agent (GHSA-w62v-8p95-rhf2)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-w62v-8p95-rhf2"
    },
    "@ai-agent-node/agent-node": {
      blocked_all: true,
      reason: "Malware in @ai-agent-node/agent-node (GHSA-h95p-8cf6-7qrc)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-h95p-8cf6-7qrc"
    },
    "@ai-agent-node/nodesql": {
      blocked_all: true,
      reason: "Malware in @ai-agent-node/nodesql (GHSA-fm4j-w897-7h3g)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-fm4j-w897-7h3g"
    },
    "@ai-agent-node/createnode": {
      blocked_all: true,
      reason: "Malware in @ai-agent-node/createnode (GHSA-79rw-4w2g-9hr5)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-79rw-4w2g-9hr5"
    },
    "@zannstore/baileys": {
      blocked_all: true,
      reason: "Malware in @zannstore/baileys (GHSA-vw26-8qc4-8hmg)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-vw26-8qc4-8hmg"
    },
    "@peptide-unit/peptide-modify": {
      blocked_all: true,
      reason: "Malware in @peptide-unit/peptide-modify (GHSA-mw2h-4g9g-g7vv)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-mw2h-4g9g-g7vv"
    },
    "@peptide-unit/js-unimode": {
      blocked_all: true,
      reason: "Malware in @peptide-unit/js-unimode (GHSA-hghj-5h7q-fq5h)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-hghj-5h7q-fq5h"
    },
    "test-skill-zip": {
      blocked_all: true,
      reason: "Malware in test-skill-zip (GHSA-qw86-6hcg-cj2j)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-qw86-6hcg-cj2j"
    },
    "flight-compare-analyzer": {
      blocked_all: true,
      reason: "Malware in flight-compare-analyzer (GHSA-wwp4-2j5x-f2m9)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-wwp4-2j5x-f2m9"
    },
    "lzd-unified-station-sdk": {
      blocked_all: true,
      reason: "Malware in lzd-unified-station-sdk (GHSA-2rgv-qvc2-5q4h)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-2rgv-qvc2-5q4h"
    },
    "colder-cli": {
      blocked_all: true,
      reason: "Malware in colder-cli (GHSA-x646-p774-9w26)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-x646-p774-9w26"
    },
    "def-open-client": {
      blocked_all: true,
      reason: "Malware in def-open-client (GHSA-pxmg-gr7p-wx8p)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-pxmg-gr7p-wx8p"
    },
    "uniapi-bridge": {
      blocked_all: true,
      reason: "Malware in uniapi-bridge (GHSA-wpp9-5p7g-7cjh)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-wpp9-5p7g-7cjh"
    },
    "lwp-web-client": {
      blocked_all: true,
      reason: "Malware in lwp-web-client (GHSA-rmm2-5g7m-wj7p)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-rmm2-5g7m-wj7p"
    },
    "open-worker-cli": {
      blocked_all: true,
      reason: "Malware in open-worker-cli (GHSA-2p2c-gx9p-5wg8)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-2p2c-gx9p-5wg8"
    },
    "feedback-ai-sdk": {
      blocked_all: true,
      reason: "Malware in feedback-ai-sdk (GHSA-fh6v-xfxj-m87q)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-fh6v-xfxj-m87q"
    },
    "aone-cloud-cli": {
      blocked_all: true,
      reason: "Malware in aone-cloud-cli (GHSA-c6xg-mcq6-m594)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-c6xg-mcq6-m594"
    },
    "stake-math": {
      blocked_all: true,
      reason: "Malware in stake-math (GHSA-qcc9-j6wh-4h9h)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-qcc9-j6wh-4h9h"
    },
    "ts-precision": {
      blocked_all: true,
      reason: "Malware in ts-precision (GHSA-g38h-2r6h-pwr8)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-g38h-2r6h-pwr8"
    },
    "data-parser-utils": {
      blocked_all: true,
      reason: "Malware in data-parser-utils (GHSA-vw6q-xg53-fpxh)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-vw6q-xg53-fpxh"
    },
    "polymarket-risk-manager": {
      blocked_all: true,
      reason: "Malware in polymarket-risk-manager (GHSA-jcx2-q527-7qcx)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-jcx2-q527-7qcx"
    },
    "poly-kelly": {
      blocked_all: true,
      reason: "Malware in poly-kelly (GHSA-c37j-v3j2-6gf8)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-c37j-v3j2-6gf8"
    },
    "ts-bn-proto": {
      blocked_all: true,
      reason: "Malware in ts-bn-proto (GHSA-wxpc-r4jx-9jrw)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-wxpc-r4jx-9jrw"
    },
    eslintcmd: {
      blocked_all: true,
      reason: "Malware in eslintcmd (GHSA-73c6-pgjj-9v82)",
      date: "2026-07-29",
      advisory: "https://github.com/advisories/GHSA-73c6-pgjj-9v82"
    },
    "vite-config-svg": {
      blocked_all: true,
      reason: "Malware in vite-config-svg (GHSA-qhvp-2j38-vcxv)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-qhvp-2j38-vcxv"
    },
    "rollup-plugin-polyfill-helper": {
      blocked_all: true,
      reason: "Malware in rollup-plugin-polyfill-helper (GHSA-583c-qcpm-pcw6)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-583c-qcpm-pcw6"
    },
    "@sudoughnym/enviro-demo": {
      blocked_all: true,
      reason: "Malware in @sudoughnym/enviro-demo (GHSA-77gf-97j3-jv6p)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-77gf-97j3-jv6p"
    },
    "@peptide-packets/peptide-modify": {
      blocked_all: true,
      reason: "Malware in @peptide-packets/peptide-modify (GHSA-9q28-pqxf-8mgj)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-9q28-pqxf-8mgj"
    },
    "@peptide-packets/js-unimode": {
      blocked_all: true,
      reason: "Malware in @peptide-packets/js-unimode (GHSA-c4rp-69c2-g2m3)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-c4rp-69c2-g2m3"
    },
    socketi: {
      blocked_all: true,
      reason: "Malware in socketi (GHSA-9gmr-4p5m-j5vr)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-9gmr-4p5m-j5vr"
    },
    asdsafsafdasdsaasdasda: {
      blocked_all: true,
      reason: "Malware in asdsafsafdasdsaasdasda (GHSA-ffx4-p8v3-667v)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-ffx4-p8v3-667v"
    },
    soccketio: {
      blocked_all: true,
      reason: "Malware in soccketio (GHSA-6j64-8q3f-7w69)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-6j64-8q3f-7w69"
    },
    scketio: {
      blocked_all: true,
      reason: "Malware in scketio (GHSA-xgm9-mpc5-qf5w)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-xgm9-mpc5-qf5w"
    },
    passsport1: {
      blocked_all: true,
      reason: "Malware in passsport1 (GHSA-whq9-wwww-4g3q)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-whq9-wwww-4g3q"
    },
    socktio: {
      blocked_all: true,
      reason: "Malware in socktio (GHSA-q2q2-2vj8-r6q4)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-q2q2-2vj8-r6q4"
    },
    passtpor: {
      blocked_all: true,
      reason: "Malware in passtpor (GHSA-j9c9-vv76-9f83)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-j9c9-vv76-9f83"
    },
    moontose: {
      blocked_all: true,
      reason: "Malware in moontose (GHSA-3675-4v4m-cxv9)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-3675-4v4m-cxv9"
    },
    vcse: {
      blocked_all: true,
      reason: "Malware in vcse (GHSA-84xr-327r-c8vf)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-84xr-327r-c8vf"
    },
    mongostose: {
      blocked_all: true,
      reason: "Malware in mongostose (GHSA-6ww9-9hr9-f9m9)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-6ww9-9hr9-f9m9"
    },
    asdsafsadad: {
      blocked_all: true,
      reason: "Malware in asdsafsadad (GHSA-7j38-gr5c-v4mv)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-7j38-gr5c-v4mv"
    },
    "redis-type-xyz": {
      blocked_all: true,
      reason: "Malicious code in redis-type-xyz (npm) (GHSA-9c7w-936w-35px)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-9c7w-936w-35px"
    },
    "nano-perf": {
      blocked_all: true,
      reason: "Malicious code in nano-perf (npm) (GHSA-4f46-w499-cvxr)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-4f46-w499-cvxr"
    },
    "@dexwilt/node-fetch": {
      blocked_all: true,
      reason: "Malicious code in @dexwilt/node-fetch (npm) (GHSA-xqj6-r3qp-9rx9)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-xqj6-r3qp-9rx9"
    },
    "rlp.git": {
      blocked_all: true,
      reason: "Malware in rlp.git (GHSA-79vf-868m-fv3g)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-79vf-868m-fv3g"
    },
    "rlp-master": {
      blocked_all: true,
      reason: "Malware in rlp-master (GHSA-pcfm-f78r-p9wq)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-pcfm-f78r-p9wq"
    },
    "node-fs-extra-master": {
      blocked_all: true,
      reason: "Malware in node-fs-extra-master (GHSA-9qpq-q9v6-pw27)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-9qpq-q9v6-pw27"
    },
    "fs-extra-master": {
      blocked_all: true,
      reason: "Malware in fs-extra-master (GHSA-cg95-x585-4q9p)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-cg95-x585-4q9p"
    },
    fsextrra: {
      blocked_all: true,
      reason: "Malware in fsextrra (GHSA-224j-655w-2vrq)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-224j-655w-2vrq"
    },
    "ethers-io-ethers": {
      blocked_all: true,
      reason: "Malware in ethers-io-ethers (GHSA-84j5-2jj5-mpwj)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-84j5-2jj5-mpwj"
    },
    "ethe.json": {
      blocked_all: true,
      reason: "Malware in ethe.json (GHSA-v4xp-v255-r8cp)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-v4xp-v255-r8cp"
    },
    ethersss: {
      blocked_all: true,
      reason: "Malware in ethersss (GHSA-h2m8-726m-9cxp)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-h2m8-726m-9cxp"
    },
    "ethers.json": {
      blocked_all: true,
      reason: "Malware in ethers.json (GHSA-q64r-f9q5-x6m3)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-q64r-f9q5-x6m3"
    },
    "ethers.jsonn": {
      blocked_all: true,
      reason: "Malware in ethers.jsonn (GHSA-jw38-p89x-r52c)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-jw38-p89x-r52c"
    },
    "eth.json": {
      blocked_all: true,
      reason: "Malware in eth.json (GHSA-22c3-g965-m9vc)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-22c3-g965-m9vc"
    },
    ethe: {
      blocked_all: true,
      reason: "Malware in ethe (GHSA-f5gf-fr4q-g7qx)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-f5gf-fr4q-g7qx"
    },
    "sunpro-3dmodel-renderer": {
      blocked_all: true,
      reason: "Malware in sunpro-3dmodel-renderer (GHSA-q5x7-xq6c-4cfc)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-q5x7-xq6c-4cfc"
    },
    n158: {
      blocked_all: true,
      reason: "Malware in n158 (GHSA-prvg-mr2g-9hfr)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-prvg-mr2g-9hfr"
    },
    npum: {
      blocked_all: true,
      reason: "Malware in npum (GHSA-q6v5-6xq8-wxmh)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-q6v5-6xq8-wxmh"
    },
    "dsilva-react-module-seed": {
      blocked_all: true,
      reason: "Malware in dsilva-react-module-seed (GHSA-qrv2-rr4v-8g54)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-qrv2-rr4v-8g54"
    },
    "rph-validator": {
      blocked_all: true,
      reason: "Malware in rph-validator (GHSA-3h87-jp5v-6338)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-3h87-jp5v-6338"
    },
    thoughtgear: {
      blocked_all: true,
      reason: "Malware in thoughtgear (GHSA-p62r-7cm3-39m8)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-p62r-7cm3-39m8"
    },
    "android-web-logger": {
      blocked_all: true,
      reason: "Malware in android-web-logger (GHSA-pgxg-3482-4c64)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-pgxg-3482-4c64"
    },
    shnc: {
      blocked_all: true,
      reason: "Malware in shnc (GHSA-q5hv-3jxw-ch7f)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-q5hv-3jxw-ch7f"
    },
    "host-inspector-module": {
      blocked_all: true,
      reason: "Malware in host-inspector-module (GHSA-4cwm-hc83-jf82)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-4cwm-hc83-jf82"
    },
    shsk: {
      blocked_all: true,
      reason: "Malware in shsk (GHSA-w2px-6f9h-j4rw)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-w2px-6f9h-j4rw"
    },
    equiviewer: {
      blocked_all: true,
      reason: "Malware in equiviewer (GHSA-98hr-v28p-r787)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-98hr-v28p-r787"
    },
    "api-gateway-lambda-router": {
      blocked_all: true,
      reason: "Malware in api-gateway-lambda-router (GHSA-r84m-hgjm-w4mm)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-r84m-hgjm-w4mm"
    },
    "payu-node": {
      blocked_all: true,
      reason: "Malware in payu-node (GHSA-vg8q-pg5j-2fq4)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-vg8q-pg5j-2fq4"
    },
    "express-bubble": {
      blocked_all: true,
      reason: "Malware in express-bubble (GHSA-4qc8-p57w-wf57)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-4qc8-p57w-wf57"
    },
    ideascloud: {
      blocked_all: true,
      reason: "Malware in ideascloud (GHSA-69jp-v94c-58pm)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-69jp-v94c-58pm"
    },
    inkalabs: {
      blocked_all: true,
      reason: "Malware in inkalabs (GHSA-vrpm-5883-jc99)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-vrpm-5883-jc99"
    },
    "files-bucket-server": {
      blocked_all: true,
      reason: "Malware in files-bucket-server (GHSA-xcx3-5pr8-rph9)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-xcx3-5pr8-rph9"
    },
    "express-wrapper": {
      blocked_all: true,
      reason: "Malware in express-wrapper (GHSA-vm63-359p-h56j)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-vm63-359p-h56j"
    },
    easyinstaller: {
      blocked_all: true,
      reason: "Malware in easyinstaller (GHSA-2qhv-3chw-2w9g)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-2qhv-3chw-2w9g"
    },
    rshell: {
      blocked_all: true,
      reason: "Malware in rshell (GHSA-7pc7-hr79-3cwp)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-7pc7-hr79-3cwp"
    },
    "express-sequelize-wrapper": {
      blocked_all: true,
      reason: "Malware in express-sequelize-wrapper (GHSA-4rxq-hv39-2x82)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-4rxq-hv39-2x82"
    },
    qserver: {
      blocked_all: true,
      reason: "Malware in qserver (GHSA-wpxf-fg7q-h6gv)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-wpxf-fg7q-h6gv"
    },
    "merg-descripters": {
      blocked_all: true,
      reason: "Malware in merg-descripters (GHSA-g4wx-r72j-qg7j)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-g4wx-r72j-qg7j"
    },
    "express-test-dependency": {
      blocked_all: true,
      reason: "Malware in express-test-dependency (GHSA-v7c3-j562-ph45)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-v7c3-j562-ph45"
    },
    "@goodjavascript/dotenv": {
      blocked_all: true,
      reason: "Malware in @goodjavascript/dotenv (GHSA-c5ch-4w75-vcw7)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-c5ch-4w75-vcw7"
    },
    "discord-starter": {
      blocked_all: true,
      reason: "Malware in discord-starter (GHSA-f7vm-5hq9-mwjj)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-f7vm-5hq9-mwjj"
    },
    "discord-ms": {
      blocked_all: true,
      reason: "Malware in discord-ms (GHSA-3gvj-vp8w-8hhv)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-3gvj-vp8w-8hhv"
    },
    "react-ag-grid": {
      blocked_all: true,
      reason: "Malware in react-ag-grid (GHSA-98mq-h6cv-m583)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-98mq-h6cv-m583"
    },
    "lodash-ex": {
      blocked_all: true,
      reason: "Malware in lodash-ex (GHSA-x8qf-9h8v-gm9x)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-x8qf-9h8v-gm9x"
    },
    "imut-set": {
      blocked_all: true,
      reason: "Malware in imut-set (GHSA-r3c8-mw9w-xmfv)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-r3c8-mw9w-xmfv"
    },
    "ag-grid-boost": {
      blocked_all: true,
      reason: "Malware in ag-grid-boost (GHSA-xqpj-5x5p-hgh7)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-xqpj-5x5p-hgh7"
    },
    "test-wastu": {
      blocked_all: true,
      reason: "Malware in test-wastu (GHSA-63j4-mhgp-qg9v)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-63j4-mhgp-qg9v"
    },
    wastu: {
      blocked_all: true,
      reason: "Malware in wastu (GHSA-jwr5-mf48-j5vg)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-jwr5-mf48-j5vg"
    },
    scol: {
      blocked_all: true,
      reason: "Malware in scol (GHSA-qxvp-f79c-fhm8)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-qxvp-f79c-fhm8"
    },
    blbird: {
      blocked_all: true,
      reason: "Malware in blbird (GHSA-8mww-mrp7-gg4g)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-8mww-mrp7-gg4g"
    },
    "@spectraltest/loglevel": {
      blocked_all: true,
      reason: "Malware in @spectraltest/loglevel (GHSA-8jp7-hh94-hrrf)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-8jp7-hh94-hrrf"
    },
    "ecto-logger": {
      blocked_all: true,
      reason: "Malware in ecto-logger (GHSA-6224-2ghr-p5cq)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-6224-2ghr-p5cq"
    },
    "spectral-wraith": {
      blocked_all: true,
      reason: "Malware in spectral-wraith (GHSA-m2mq-w6wp-w8gf)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-m2mq-w6wp-w8gf"
    },
    "curse-dependent": {
      blocked_all: true,
      reason: "Malware in curse-dependent (GHSA-8888-hf6w-c5xg)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-8888-hf6w-c5xg"
    },
    zcas: {
      blocked_all: true,
      reason: "Malware in zcas (GHSA-2v4j-qgf9-fvqc)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-2v4j-qgf9-fvqc"
    },
    "spectral-corsair": {
      blocked_all: true,
      reason: "Malware in spectral-corsair (GHSA-pcp5-vg44-ch66)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-pcp5-vg44-ch66"
    },
    puppetewebr: {
      blocked_all: true,
      reason: "Malware in puppetewebr (GHSA-8hpf-vg2v-v9wc)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-8hpf-vg2v-v9wc"
    },
    etwl: {
      blocked_all: true,
      reason: "Malware in etwl (GHSA-grfv-7rvr-chw4)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-grfv-7rvr-chw4"
    },
    pretierr: {
      blocked_all: true,
      reason: "Malware in pretierr (GHSA-rfv2-vfmp-jq9p)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-rfv2-vfmp-jq9p"
    },
    malxios: {
      blocked_all: true,
      reason: "Malware in malxios (GHSA-73g9-wgm7-84qr)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-73g9-wgm7-84qr"
    },
    maalxios: {
      blocked_all: true,
      reason: "Malware in maalxios (GHSA-5f53-x2hv-vqqx)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-5f53-x2hv-vqqx"
    },
    "@sourav_chanduka/core": {
      blocked_all: true,
      reason: "Malware in @sourav_chanduka/core (GHSA-7p79-743j-rjq8)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-7p79-743j-rjq8"
    },
    "@sourav_chanduka/core-no-ngrok": {
      blocked_all: true,
      reason: "Malware in @sourav_chanduka/core-no-ngrok (GHSA-qrx2-r7m9-fw6x)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-qrx2-r7m9-fw6x"
    },
    "@sourav_chanduka/oidc-client": {
      blocked_all: true,
      reason: "Malware in @sourav_chanduka/oidc-client (GHSA-5w3j-78pm-qcj7)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-5w3j-78pm-qcj7"
    },
    "@web3utils/common": {
      blocked_all: true,
      reason: "Malware in @web3utils/common (GHSA-q3f3-h8g8-7qc6)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-q3f3-h8g8-7qc6"
    },
    "@solana-utils/common": {
      blocked_all: true,
      reason: "Malware in @solana-utils/common (GHSA-86ff-vvv8-wr2x)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-86ff-vvv8-wr2x"
    },
    "@web3-util/common": {
      blocked_all: true,
      reason: "Malware in @web3-util/common (GHSA-wvx6-fwf2-hpp5)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-wvx6-fwf2-hpp5"
    },
    "discord-rsc": {
      blocked_all: true,
      reason: "Malware in discord-rsc (GHSA-g892-r2fw-vxgc)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-g892-r2fw-vxgc"
    },
    "discord-csr": {
      blocked_all: true,
      reason: "Malware in discord-csr (GHSA-gjqh-7qrr-25q9)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-gjqh-7qrr-25q9"
    },
    tailwindcssss: {
      blocked_all: true,
      reason: "Malware in tailwindcssss (GHSA-9x5x-r7x3-737h)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-9x5x-r7x3-737h"
    },
    tailwindcsssss: {
      blocked_all: true,
      reason: "Malware in tailwindcsssss (GHSA-6x93-j4j5-p856)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-6x93-j4j5-p856"
    },
    "@sie-ppr-web-checkout/app": {
      blocked_all: true,
      reason: "Malware in @sie-ppr-web-checkout/app (GHSA-qvjv-fpr5-2fmm)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-qvjv-fpr5-2fmm"
    },
    "@relforce-dev/console-log": {
      blocked_all: true,
      reason: "Malware in @relforce-dev/console-log (GHSA-4rj5-hjhh-8xc8)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-4rj5-hjhh-8xc8"
    },
    "@node-console-log/log": {
      blocked_all: true,
      reason: "Malware in @node-console-log/log (GHSA-cmv8-rmg2-2232)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-cmv8-rmg2-2232"
    },
    "@pumpdot-fun/pump-swap-sdk": {
      blocked_all: true,
      reason: "Malware in @pumpdot-fun/pump-swap-sdk (GHSA-4gj3-7xcg-jhpm)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-4gj3-7xcg-jhpm"
    },
    "@pumpdot-fun/pump-sdk": {
      blocked_all: true,
      reason: "Malware in @pumpdot-fun/pump-sdk (GHSA-873h-v5vp-pq52)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-873h-v5vp-pq52"
    },
    fwf: {
      blocked_all: true,
      reason: "Malware in fwf (GHSA-5rjh-56g3-j7x2)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-5rjh-56g3-j7x2"
    },
    "@santieich/homebridge-midea-lan": {
      blocked_all: true,
      reason: "Malware in @santieich/homebridge-midea-lan (GHSA-jx3g-gq4q-33jp)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-jx3g-gq4q-33jp"
    },
    famshot: {
      blocked_all: true,
      reason: "Malware in famshot (GHSA-v3p3-vv86-m2vx)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-v3p3-vv86-m2vx"
    },
    aruda: {
      blocked_all: true,
      reason: "Malware in aruda (GHSA-pxhx-3f73-24mp)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-pxhx-3f73-24mp"
    },
    chakll: {
      blocked_all: true,
      reason: "Malware in chakll (GHSA-x86w-fpjg-whp5)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-x86w-fpjg-whp5"
    },
    "@patternfly-4/react-table": {
      blocked_all: true,
      reason: "Malware in @patternfly-4/react-table (GHSA-49v8-6wpf-47mq)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-49v8-6wpf-47mq"
    },
    "@patternfly-4/react-tokens": {
      blocked_all: true,
      reason: "Malware in @patternfly-4/react-tokens (GHSA-8743-4q24-h66x)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-8743-4q24-h66x"
    },
    "@patternfly-4/quickstarts": {
      blocked_all: true,
      reason: "Malware in @patternfly-4/quickstarts (GHSA-9xpj-3r3g-x2gh)",
      date: "2026-07-30",
      advisory: "https://github.com/advisories/GHSA-9xpj-3r3g-x2gh"
    },
    "test-dev-boot": {
      blocked_all: true,
      reason: "Malware in test-dev-boot (GHSA-fxj3-2jph-p7mg)",
      date: "2026-08-01",
      advisory: "https://github.com/advisories/GHSA-fxj3-2jph-p7mg"
    },
    "test-dev-host": {
      blocked_all: true,
      reason: "Malware in test-dev-host (GHSA-6v46-5v2x-c3c5)",
      date: "2026-08-01",
      advisory: "https://github.com/advisories/GHSA-6v46-5v2x-c3c5"
    },
    "test-dev-sync": {
      blocked_all: true,
      reason: "Malware in test-dev-sync (GHSA-c2gc-7pfc-7fjf)",
      date: "2026-08-01",
      advisory: "https://github.com/advisories/GHSA-c2gc-7pfc-7fjf"
    },
    "test-dev-dispatch": {
      blocked_all: true,
      reason: "Malware in test-dev-dispatch (GHSA-qx8w-r9j6-p4g5)",
      date: "2026-08-01",
      advisory: "https://github.com/advisories/GHSA-qx8w-r9j6-p4g5"
    },
    "test-dev-store": {
      blocked_all: true,
      reason: "Malware in test-dev-store (GHSA-2ph5-h7fc-33mm)",
      date: "2026-08-01",
      advisory: "https://github.com/advisories/GHSA-2ph5-h7fc-33mm"
    },
    "test-dev-watch": {
      blocked_all: true,
      reason: "Malware in test-dev-watch (GHSA-qxrq-qr5j-h4rw)",
      date: "2026-08-01",
      advisory: "https://github.com/advisories/GHSA-qxrq-qr5j-h4rw"
    },
    "test-dev-link": {
      blocked_all: true,
      reason: "Malware in test-dev-link (GHSA-vf2p-478v-vg76)",
      date: "2026-08-01",
      advisory: "https://github.com/advisories/GHSA-vf2p-478v-vg76"
    },
    "test-dev-exec": {
      blocked_all: true,
      reason: "Malware in test-dev-exec (GHSA-vxp9-h9vh-8mp3)",
      date: "2026-08-01",
      advisory: "https://github.com/advisories/GHSA-vxp9-h9vh-8mp3"
    },
    "@moxfive-llc/common": {
      blocked_all: true,
      reason: "Malware in @moxfive-llc/common (GHSA-x9jj-732w-pjvr)",
      date: "2026-08-01",
      advisory: "https://github.com/advisories/GHSA-x9jj-732w-pjvr"
    },
    "@spending-behavior-ui/widget-insights": {
      blocked_all: true,
      reason: "Malware in @spending-behavior-ui/widget-insights (GHSA-m955-rhgf-m5fx)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-m955-rhgf-m5fx"
    },
    "@sw-commons-components/message-upsell": {
      blocked_all: true,
      reason: "Malware in @sw-commons-components/message-upsell (GHSA-8w99-rvcw-j7cf)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-8w99-rvcw-j7cf"
    },
    "@spending-behavior-ui/cashflow-widget": {
      blocked_all: true,
      reason: "Malware in @spending-behavior-ui/cashflow-widget (GHSA-mqcg-v4cw-rgr3)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-mqcg-v4cw-rgr3"
    },
    "@one-chat/react": {
      blocked_all: true,
      reason: "Malware in @one-chat/react (GHSA-598h-mgjc-c42f)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-598h-mgjc-c42f"
    },
    "@nordic-dev/linting-tools": {
      blocked_all: true,
      reason: "Malware in @nordic-dev/linting-tools (GHSA-95g5-jx8f-9835)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-95g5-jx8f-9835"
    },
    "@mplay-core-lib/utilities": {
      blocked_all: true,
      reason: "Malware in @mplay-core-lib/utilities (GHSA-w8v3-x4pv-78rp)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-w8v3-x4pv-78rp"
    },
    "@sof-assistant-fe-lib/vertical-faqs": {
      blocked_all: true,
      reason: "Malware in @sof-assistant-fe-lib/vertical-faqs (GHSA-chhc-9q4w-p5vq)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-chhc-9q4w-p5vq"
    },
    "@finance-ui/finance-view": {
      blocked_all: true,
      reason: "Malware in @finance-ui/finance-view (GHSA-cwvh-hhv3-v52q)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-cwvh-hhv3-v52q"
    },
    "@mp-op-ss-front-lib/tracks": {
      blocked_all: true,
      reason: "Malware in @mp-op-ss-front-lib/tracks (GHSA-rcc9-cq4p-xv77)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-rcc9-cq4p-xv77"
    },
    "@meli-testing/jest-react": {
      blocked_all: true,
      reason: "Malware in @meli-testing/jest-react (GHSA-2rh8-4vrh-7vh3)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-2rh8-4vrh-7vh3"
    },
    "@fuji-web-components/maps": {
      blocked_all: true,
      reason: "Malware in @fuji-web-components/maps (GHSA-qmwr-pvcq-hhrm)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-qmwr-pvcq-hhrm"
    },
    "@mplay-frontend-ui/link": {
      blocked_all: true,
      reason: "Malware in @mplay-frontend-ui/link (GHSA-xxrf-9xmw-rq5r)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-xxrf-9xmw-rq5r"
    },
    "@global-theme/context": {
      blocked_all: true,
      reason: "Malware in @global-theme/context (GHSA-whq3-7x3r-pv39)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-whq3-7x3r-pv39"
    },
    "@finance-ui/snackbar-ifpe": {
      blocked_all: true,
      reason: "Malware in @finance-ui/snackbar-ifpe (GHSA-rcgh-7xjx-4rh6)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-rcgh-7xjx-4rh6"
    },
    "@cr-invested-ui-components/chart": {
      blocked_all: true,
      reason: "Malware in @cr-invested-ui-components/chart (GHSA-8g97-c5r5-8hjr)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-8g97-c5r5-8hjr"
    },
    "metrics-ui": {
      blocked_all: true,
      reason: "Malware in metrics-ui (GHSA-g4m5-r29v-w7gh)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-g4m5-r29v-w7gh"
    },
    "process-status-widget": {
      blocked_all: true,
      reason: "Malware in process-status-widget (GHSA-rvcg-4hj7-jmv2)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-rvcg-4hj7-jmv2"
    },
    "frontend-regulations": {
      blocked_all: true,
      reason: "Malware in frontend-regulations (GHSA-hf3r-x49q-fxm2)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-hf3r-x49q-fxm2"
    },
    "notifications-broadcast": {
      blocked_all: true,
      reason: "Malware in notifications-broadcast (GHSA-hh3x-6gh6-rhxf)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-hh3x-6gh6-rhxf"
    },
    "polylabel-web-lib": {
      blocked_all: true,
      reason: "Malware in polylabel-web-lib (GHSA-4x59-mhxh-4ghc)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-4x59-mhxh-4ghc"
    },
    portway: {
      blocked_all: true,
      reason: "Malware in portway (GHSA-j5q6-x29x-2v5x)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-j5q6-x29x-2v5x"
    },
    "sso-users-detection": {
      blocked_all: true,
      reason: "Malware in sso-users-detection (GHSA-x9p4-637q-6wjw)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-x9p4-637q-6wjw"
    },
    allurectl: {
      blocked_all: true,
      reason: "Malware in allurectl (GHSA-gpj6-4r9m-prh8)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-gpj6-4r9m-prh8"
    },
    "refbase-mcp": {
      blocked_all: true,
      reason: "Malware in refbase-mcp (GHSA-5xcj-w4qg-g78g)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-5xcj-w4qg-g78g"
    },
    "hit-mcp": {
      blocked_all: true,
      reason: "Malware in hit-mcp (GHSA-fmvj-j52v-97x4)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-fmvj-j52v-97x4"
    },
    "iwomm-mcp": {
      blocked_all: true,
      reason: "Malware in iwomm-mcp (GHSA-8cvf-hpjg-mf2j)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-8cvf-hpjg-mf2j"
    },
    "mcp-server-boilerplate": {
      blocked_all: true,
      reason: "Malware in mcp-server-boilerplate (GHSA-694g-9jgf-5566)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-694g-9jgf-5566"
    },
    "paraglide-js": {
      blocked_all: true,
      reason: "Malware in paraglide-js (GHSA-433p-gj42-fh44)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-433p-gj42-fh44"
    },
    "community-published": {
      blocked_all: true,
      reason: "Malware in community-published (GHSA-cr3h-6mq7-f6q9)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-cr3h-6mq7-f6q9"
    },
    "chaos-mcp": {
      blocked_all: true,
      reason: "Malware in chaos-mcp (GHSA-8whv-6hc5-4wpr)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-8whv-6hc5-4wpr"
    },
    "gtm-mcp-auth": {
      blocked_all: true,
      reason: "Malware in gtm-mcp-auth (GHSA-4ch5-wcxv-58j5)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-4ch5-wcxv-58j5"
    },
    "create-remotion": {
      blocked_all: true,
      reason: "Malware in create-remotion (GHSA-947j-5gjp-7968)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-947j-5gjp-7968"
    },
    "sap-mcp-facilitator": {
      blocked_all: true,
      reason: "Malware in sap-mcp-facilitator (GHSA-fvh4-59gv-h4qp)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-fvh4-59gv-h4qp"
    },
    "maximumsats-mcp": {
      blocked_all: true,
      reason: "Malware in maximumsats-mcp (GHSA-mr5v-ffrr-c4h3)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-mr5v-ffrr-c4h3"
    },
    "adpanel-core": {
      blocked_all: true,
      reason: "Malware in adpanel-core (GHSA-jhrx-465c-725f)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-jhrx-465c-725f"
    },
    "sap-mcp-config": {
      blocked_all: true,
      reason: "Malware in sap-mcp-config (GHSA-4j2q-gh4v-v729)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-4j2q-gh4v-v729"
    },
    "attio-discover": {
      blocked_all: true,
      reason: "Malware in attio-discover (GHSA-h74v-846x-863c)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-h74v-846x-863c"
    },
    "hazmat-cfr": {
      blocked_all: true,
      reason: "Malware in hazmat-cfr (GHSA-g8cx-prcq-676p)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-g8cx-prcq-676p"
    },
    "capacitor-assets": {
      blocked_all: true,
      reason: "Malware in capacitor-assets (GHSA-8v58-g8f8-2gpp)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-8v58-g8f8-2gpp"
    },
    "kip-mcp-http": {
      blocked_all: true,
      reason: "Malware in kip-mcp-http (GHSA-993p-762h-628r)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-993p-762h-628r"
    },
    "fast-csv-helper": {
      blocked_all: true,
      reason: "Malware in fast-csv-helper (GHSA-c65v-4v4c-jcpr)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-c65v-4v4c-jcpr"
    },
    "pm-claude-skills-mcp": {
      blocked_all: true,
      reason: "Malware in pm-claude-skills-mcp (GHSA-87v2-285p-xhrr)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-87v2-285p-xhrr"
    },
    "routerbase-mcp": {
      blocked_all: true,
      reason: "Malware in routerbase-mcp (GHSA-rxc6-q384-2wrx)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-rxc6-q384-2wrx"
    },
    polyprompt: {
      blocked_all: true,
      reason: "Malware in polyprompt (GHSA-h574-ghq2-gh4p)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-h574-ghq2-gh4p"
    },
    "goldenflow-js": {
      blocked_all: true,
      reason: "Malware in goldenflow-js (GHSA-7gxf-x4v3-6vq7)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-7gxf-x4v3-6vq7"
    },
    "smart-npv-mcp": {
      blocked_all: true,
      reason: "Malware in smart-npv-mcp (GHSA-972c-x84x-rm4f)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-972c-x84x-rm4f"
    },
    "install-native-host": {
      blocked_all: true,
      reason: "Malware in install-native-host (GHSA-4wvg-prm7-99h4)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-4wvg-prm7-99h4"
    },
    "ai-backup-script": {
      blocked_all: true,
      reason: "Malware in ai-backup-script (GHSA-34m8-mhm4-w3q4)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-34m8-mhm4-w3q4"
    },
    "iac-scanner": {
      blocked_all: true,
      reason: "Malware in iac-scanner (GHSA-69pc-2883-mff3)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-69pc-2883-mff3"
    },
    "@404c3s4r/lodash": {
      blocked_all: true,
      reason: "Malware in @404c3s4r/lodash (GHSA-3357-xmhq-8r86)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-3357-xmhq-8r86"
    },
    "eth-bridge": {
      blocked_all: true,
      reason: "Malware in eth-bridge (GHSA-5hj6-99cc-g84q)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-5hj6-99cc-g84q"
    },
    "kelly-stake": {
      blocked_all: true,
      reason: "Malware in kelly-stake (GHSA-9x8c-c54x-vgrv)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-9x8c-c54x-vgrv"
    },
    "vite-tsconfig-svg": {
      blocked_all: true,
      reason: "Malware in vite-tsconfig-svg (GHSA-3w4v-4hp3-9934)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-3w4v-4hp3-9934"
    },
    "rollup-plugin-polyfill-hold": {
      blocked_all: true,
      reason: "Malware in rollup-plugin-polyfill-hold (GHSA-7p2c-jxw4-jxvv)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-7p2c-jxw4-jxvv"
    },
    "react-hot-svg": {
      blocked_all: true,
      reason: "Malware in react-hot-svg (GHSA-46cj-57m5-r4wc)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-46cj-57m5-r4wc"
    },
    "@0xlr/dep-confusion-poc": {
      blocked_all: true,
      reason: "Malware in @0xlr/dep-confusion-poc (GHSA-r4wg-xfm2-45qv)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-r4wg-xfm2-45qv"
    },
    "@0xlr/clerk-auth": {
      blocked_all: true,
      reason: "Malware in @0xlr/clerk-auth (GHSA-57r8-xw4c-5j59)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-57r8-xw4c-5j59"
    },
    "@0xlr/prisma-client-js": {
      blocked_all: true,
      reason: "Malware in @0xlr/prisma-client-js (GHSA-mrxf-wq2g-xvxm)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-mrxf-wq2g-xvxm"
    },
    "@0xlr/vercel-analytics": {
      blocked_all: true,
      reason: "Malware in @0xlr/vercel-analytics (GHSA-p9mc-hf7g-gjfx)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-p9mc-hf7g-gjfx"
    },
    "@0xlr/stripe-frontend": {
      blocked_all: true,
      reason: "Malware in @0xlr/stripe-frontend (GHSA-c3gr-xj4c-rc53)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-c3gr-xj4c-rc53"
    },
    "@0xlr/stripe-checkout-js": {
      blocked_all: true,
      reason: "Malware in @0xlr/stripe-checkout-js (GHSA-3fr8-m4cc-93fj)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-3fr8-m4cc-93fj"
    },
    "@0xlr/supabase-db": {
      blocked_all: true,
      reason: "Malware in @0xlr/supabase-db (GHSA-236w-q9vm-8r42)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-236w-q9vm-8r42"
    },
    "@0xlr/question-types": {
      blocked_all: true,
      reason: "Malware in @0xlr/question-types (GHSA-3x4g-gcc2-3jrc)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-3x4g-gcc2-3jrc"
    },
    "@0xlr/test-callback": {
      blocked_all: true,
      reason: "Malware in @0xlr/test-callback (GHSA-p6vh-r7p3-72r9)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-p6vh-r7p3-72r9"
    },
    "@0xlr/sentry-web": {
      blocked_all: true,
      reason: "Malware in @0xlr/sentry-web (GHSA-pq34-wqrw-jw86)",
      date: "2026-07-31",
      advisory: "https://github.com/advisories/GHSA-pq34-wqrw-jw86"
    },
    "pp-react-worldready": {
      blocked_all: true,
      reason: "Malicious code in pp-react-worldready (npm) (GHSA-4g95-5h46-4643)",
      date: "2026-08-01",
      advisory: "https://github.com/advisories/GHSA-4g95-5h46-4643"
    },
    "@types-beta/sdk": {
      blocked_all: true,
      reason: "Malicious code in @types-beta/sdk (npm) (GHSA-j9jc-8h3g-qqrx)",
      date: "2026-08-03",
      advisory: "https://github.com/advisories/GHSA-j9jc-8h3g-qqrx"
    },
    "tailwind-anim": {
      blocked_all: true,
      reason: "Malware in tailwind-anim (GHSA-7xhc-fvmj-h5xj)",
      date: "2026-08-03",
      advisory: "https://github.com/advisories/GHSA-7xhc-fvmj-h5xj"
    },
    "@custombots/custombot": {
      blocked_all: true,
      reason: "Malicious code in @custombots/custombot (npm) (GHSA-77jv-xw6r-q246)",
      date: "2026-08-03",
      advisory: "https://github.com/advisories/GHSA-77jv-xw6r-q246"
    },
    "list-issue-predecessor-dependencies-block": {
      blocked_all: true,
      reason: "Malicious code in list-issue-predecessor-dependencies-block (npm) (GHSA-fjgr-3cq9-qxm6)",
      date: "2026-08-02",
      advisory: "https://github.com/advisories/GHSA-fjgr-3cq9-qxm6"
    },
    "tailwindcss-anim": {
      blocked_all: true,
      reason: "Malware in tailwindcss-anim (GHSA-m326-xg22-g2fx)",
      date: "2026-08-02",
      advisory: "https://github.com/advisories/GHSA-m326-xg22-g2fx"
    },
    "simple-date-formatter-util-2": {
      blocked_all: true,
      reason: "Malware in simple-date-formatter-util-2 (GHSA-q43f-5xj6-8v63)",
      date: "2026-08-02",
      advisory: "https://github.com/advisories/GHSA-q43f-5xj6-8v63"
    },
    "simple-date-formatter-util": {
      blocked_all: true,
      reason: "Malware in simple-date-formatter-util (GHSA-q32h-xc3m-rc77)",
      date: "2026-08-02",
      advisory: "https://github.com/advisories/GHSA-q32h-xc3m-rc77"
    },
    "simple-date-formatter-util-1": {
      blocked_all: true,
      reason: "Malware in simple-date-formatter-util-1 (GHSA-mmc7-8pmj-h3xj)",
      date: "2026-08-02",
      advisory: "https://github.com/advisories/GHSA-mmc7-8pmj-h3xj"
    },
    houzidawang808: {
      blocked_all: true,
      reason: "Malware in houzidawang808 (GHSA-4qvg-392x-j32q)",
      date: "2026-08-02",
      advisory: "https://github.com/advisories/GHSA-4qvg-392x-j32q"
    },
    houzidawang807: {
      blocked_all: true,
      reason: "Malware in houzidawang807 (GHSA-f2g2-48mf-957v)",
      date: "2026-08-02",
      advisory: "https://github.com/advisories/GHSA-f2g2-48mf-957v"
    },
    houzidawang806: {
      blocked_all: true,
      reason: "Malware in houzidawang806 (GHSA-7gf8-h22p-4qr4)",
      date: "2026-08-02",
      advisory: "https://github.com/advisories/GHSA-7gf8-h22p-4qr4"
    },
    "utility-kit-ts": {
      blocked_all: true,
      reason: "Malware in utility-kit-ts (GHSA-p66g-m465-g72x)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-p66g-m465-g72x"
    },
    "ts-toolkit-plus": {
      blocked_all: true,
      reason: "Malware in ts-toolkit-plus (GHSA-99wx-749q-58xh)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-99wx-749q-58xh"
    },
    "crypto-checkout-api": {
      blocked_all: true,
      reason: "Malware in crypto-checkout-api (GHSA-cg47-54wp-xjp9)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-cg47-54wp-xjp9"
    },
    "polyclob-api": {
      blocked_all: true,
      reason: "Malware in polyclob-api (GHSA-qc45-qw25-9w37)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-qc45-qw25-9w37"
    },
    "wallet-analytics": {
      blocked_all: true,
      reason: "Malware in wallet-analytics (GHSA-xf3p-c585-94jr)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-xf3p-c585-94jr"
    },
    "polymarket-toolkit": {
      blocked_all: true,
      reason: "Malware in polymarket-toolkit (GHSA-w7x3-5xp7-6pw8)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-w7x3-5xp7-6pw8"
    },
    "async-mutex-lock": {
      blocked_all: true,
      reason: "Malware in async-mutex-lock (GHSA-vwr9-j5fc-42fq)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-vwr9-j5fc-42fq"
    },
    "tick-forge": {
      blocked_all: true,
      reason: "Malware in tick-forge (GHSA-rjvw-v893-2f7g)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-rjvw-v893-2f7g"
    },
    "poly-provider-api": {
      blocked_all: true,
      reason: "Malware in poly-provider-api (GHSA-jxxm-5453-r666)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-jxxm-5453-r666"
    },
    "tailwindcss-form-components": {
      blocked_all: true,
      reason: "Malware in tailwindcss-form-components (GHSA-qqcc-hmq5-37p5)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-qqcc-hmq5-37p5"
    },
    "streak-calc-metrics": {
      blocked_all: true,
      reason: "Malicious code in streak-calc-metrics (npm) (GHSA-gq4j-wc22-g5g3)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-gq4j-wc22-g5g3"
    },
    "statist-browser-typed-client-sme.platform.web.teasers": {
      blocked_all: true,
      reason: "Malicious code in statist-browser-typed-client-sme.platform.web.teasers (npm) (GHSA-h8vv-5w47-jr68)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-h8vv-5w47-jr68"
    },
    "statist-browser-typed-client-jumptaxi.feature.contacts": {
      blocked_all: true,
      reason: "Malicious code in statist-browser-typed-client-jumptaxi.feature.contacts (npm) (GHSA-j69g-vwwq-rrmf)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-j69g-vwwq-rrmf"
    },
    "tinkoff-statist-browser-typed-client-sme.reporting.reporting": {
      blocked_all: true,
      reason: "Malicious code in tinkoff-statist-browser-typed-client-sme.reporting.reporting (npm) (GHSA-gxjm-79h7-8p8q)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-gxjm-79h7-8p8q"
    },
    "tui-react-mobile-styles": {
      blocked_all: true,
      reason: "Malicious code in tui-react-mobile-styles (npm) (GHSA-c8m3-2v45-wg8x)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-c8m3-2v45-wg8x"
    },
    "tinkoff-ui-action": {
      blocked_all: true,
      reason: "Malicious code in tinkoff-ui-action (npm) (GHSA-xhqw-rjf7-x6h2)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-xhqw-rjf7-x6h2"
    },
    uibabai: {
      blocked_all: true,
      reason: "Malicious code in uibabai (npm) (GHSA-xm2g-qfpc-cc6h)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-xm2g-qfpc-cc6h"
    },
    "tinkoff-component-infopanel": {
      blocked_all: true,
      reason: "Malicious code in tinkoff-component-infopanel (npm) (GHSA-fprc-5vxr-hqwp)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-fprc-5vxr-hqwp"
    },
    "sextant-cli-darwin-amd64": {
      blocked_all: true,
      reason: "Malicious code in sextant-cli-darwin-amd64 (npm) (GHSA-7x22-xp2x-5r35)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-7x22-xp2x-5r35"
    },
    "tramvai-tinkoff-module-legacy-popup": {
      blocked_all: true,
      reason: "Malicious code in tramvai-tinkoff-module-legacy-popup (npm) (GHSA-33jp-mp9g-xvw7)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-33jp-mp9g-xvw7"
    },
    "tinkoff-boxy-desktop-features-banner": {
      blocked_all: true,
      reason: "Malicious code in tinkoff-boxy-desktop-features-banner (npm) (GHSA-v8mq-h2v3-675q)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-v8mq-h2v3-675q"
    },
    "sextant-cli-linux-arm64": {
      blocked_all: true,
      reason: "Malicious code in sextant-cli-linux-arm64 (npm) (GHSA-3w3q-fqgj-f36f)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-3w3q-fqgj-f36f"
    },
    "@zzzgenesis00/ethers-wallet": {
      blocked_all: true,
      reason: "Malicious code in @zzzgenesis00/ethers-wallet (npm) (GHSA-mfp5-2q2x-vj4p)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-mfp5-2q2x-vj4p"
    },
    "platform-ui-island": {
      blocked_all: true,
      reason: "Malicious code in platform-ui-island (npm) (GHSA-3q7q-cmmw-mmr4)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-3q7q-cmmw-mmr4"
    },
    "tinkoff-boxy-mobile-vivid-heading": {
      blocked_all: true,
      reason: "Malicious code in tinkoff-boxy-mobile-vivid-heading (npm) (GHSA-c49g-3j6g-ff99)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-c49g-3j6g-ff99"
    },
    "bigops-create-manifest": {
      blocked_all: true,
      reason: "Malicious code in bigops-create-manifest (npm) (GHSA-2p8g-p678-pf84)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-2p8g-p678-pf84"
    },
    "trezor-lib": {
      blocked_all: true,
      reason: "Malicious code in trezor-lib (npm) (GHSA-7244-wrrf-8qvr)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-7244-wrrf-8qvr"
    },
    "platform-ui-codemods": {
      blocked_all: true,
      reason: "Malicious code in platform-ui-codemods (npm) (GHSA-jpjf-h9c6-gh26)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-jpjf-h9c6-gh26"
    },
    "forge-extended": {
      blocked_all: true,
      reason: "Malicious code in forge-extended (npm) (GHSA-3pph-gj9f-37j7)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-3pph-gj9f-37j7"
    },
    "data-format-helper": {
      blocked_all: true,
      reason: "Malicious code in data-format-helper (npm) (GHSA-8x6p-c3wj-g2h5)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-8x6p-c3wj-g2h5"
    },
    "statist-browser-typed-client-hra.workplacer.events": {
      blocked_all: true,
      reason: "Malicious code in statist-browser-typed-client-hra.workplacer.events (npm) (GHSA-cp53-cjcf-6fwx)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-cp53-cjcf-6fwx"
    },
    "bigops-customer": {
      blocked_all: true,
      reason: "Malicious code in bigops-customer (npm) (GHSA-8vj2-2pp5-wgw7)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-8vj2-2pp5-wgw7"
    },
    "volna-boxy-di-test": {
      blocked_all: true,
      reason: "Malicious code in volna-boxy-di-test (npm) (GHSA-m6vx-f9vm-7p7q)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-m6vx-f9vm-7p7q"
    },
    "streak-day-utils": {
      blocked_all: true,
      reason: "Malicious code in streak-day-utils (npm) (GHSA-chvr-9wqf-pw57)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-chvr-9wqf-pw57"
    },
    "specials-mvno-client": {
      blocked_all: true,
      reason: "Malicious code in specials-mvno-client (npm) (GHSA-7x38-rxfc-7439)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-7x38-rxfc-7439"
    },
    "statist-browser-typed-client-test.jumpwork.circuitbreaker": {
      blocked_all: true,
      reason: "Malicious code in statist-browser-typed-client-test.jumpwork.circuitbreaker (npm) (GHSA-cwf6-c7v4-rv74)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-cwf6-c7v4-rv74"
    },
    "@zzzgenesis00/bip39-mnemonic": {
      blocked_all: true,
      reason: "Malicious code in @zzzgenesis00/bip39-mnemonic (npm) (GHSA-cf5w-8hr5-cpff)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-cf5w-8hr5-cpff"
    },
    "bigops-chat-tmsg": {
      blocked_all: true,
      reason: "Malicious code in bigops-chat-tmsg (npm) (GHSA-rjrw-rx8c-5fp2)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-rjrw-rx8c-5fp2"
    },
    aedes_clusters: {
      blocked_all: true,
      reason: "Malicious code in aedes_clusters (npm) (GHSA-ccmc-q8x3-v382)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-ccmc-q8x3-v382"
    },
    "bigops-auth-utils": {
      blocked_all: true,
      reason: "Malicious code in bigops-auth-utils (npm) (GHSA-9m43-3q5c-855f)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-9m43-3q5c-855f"
    },
    "tinkoff-statist-browser-typed-client-sme.compliance.web.events": {
      blocked_all: true,
      reason: "Malicious code in tinkoff-statist-browser-typed-client-sme.compliance.web.events (npm) (GHSA-jj33-jprr-c96x)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-jj33-jprr-c96x"
    },
    "beaver-ui-form-modal": {
      blocked_all: true,
      reason: "Malicious code in beaver-ui-form-modal (npm) (GHSA-694p-cpwm-9w6r)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-694p-cpwm-9w6r"
    },
    "add-two-numbers-x7q9m": {
      blocked_all: true,
      reason: "Malicious code in add-two-numbers-x7q9m (npm) (GHSA-9pf9-rmxg-xw8w)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-9pf9-rmxg-xw8w"
    },
    "tinkoff-cache-path": {
      blocked_all: true,
      reason: "Malicious code in tinkoff-cache-path (npm) (GHSA-9gcw-36vr-jw5g)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-9gcw-36vr-jw5g"
    },
    "sso-tramvai-module-context-auth": {
      blocked_all: true,
      reason: "Malicious code in sso-tramvai-module-context-auth (npm) (GHSA-frm7-83xc-2wp6)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-frm7-83xc-2wp6"
    },
    "sextant-cli-linux-amd64": {
      blocked_all: true,
      reason: "Malicious code in sextant-cli-linux-amd64 (npm) (GHSA-g6xw-m38g-gq9x)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-g6xw-m38g-gq9x"
    },
    "hwi-lib": {
      blocked_all: true,
      reason: "Malicious code in hwi-lib (npm) (GHSA-f9r2-8m6r-p3qv)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-f9r2-8m6r-p3qv"
    },
    "specials-obid-webpack": {
      blocked_all: true,
      reason: "Malicious code in specials-obid-webpack (npm) (GHSA-3g4w-f3vp-2cjp)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-3g4w-f3vp-2cjp"
    },
    "hubert-appointment-v2-task-create-am": {
      blocked_all: true,
      reason: "Malicious code in hubert-appointment-v2-task-create-am (npm) (GHSA-62xx-7cqv-qp4g)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-62xx-7cqv-qp4g"
    },
    "statist-browser-typed-client-nfs.grocery.mobile.events": {
      blocked_all: true,
      reason: "Malicious code in statist-browser-typed-client-nfs.grocery.mobile.events (npm) (GHSA-3225-grxw-fx69)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-3225-grxw-fx69"
    },
    "sotqa-test": {
      blocked_all: true,
      reason: "Malicious code in sotqa-test (npm) (GHSA-56r2-8f47-m5mx)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-56r2-8f47-m5mx"
    },
    "shopping-shared-atom-mobile-cart-counter": {
      blocked_all: true,
      reason: "Malicious code in shopping-shared-atom-mobile-cart-counter (npm) (GHSA-9mcv-4v2c-mv32)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-9mcv-4v2c-mv32"
    },
    "ledger-lib": {
      blocked_all: true,
      reason: "Malicious code in ledger-lib (npm) (GHSA-2gq8-9xc9-mx8j)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-2gq8-9xc9-mx8j"
    },
    "ckcc-protocol": {
      blocked_all: true,
      reason: "Malicious code in ckcc-protocol (npm) (GHSA-922v-8r8m-7cxw)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-922v-8r8m-7cxw"
    },
    "checkout-create-pos-order-am": {
      blocked_all: true,
      reason: "Malicious code in checkout-create-pos-order-am (npm) (GHSA-cjcp-fwqf-qqr5)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-cjcp-fwqf-qqr5"
    },
    "nxify-unic": {
      blocked_all: true,
      reason: "Malicious code in nxify-unic (npm) (GHSA-pph5-5pvw-w45m)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-pph5-5pvw-w45m"
    },
    osinthell: {
      blocked_all: true,
      reason: "Malicious code in osinthell (npm) (GHSA-gh9x-wv37-w3xq)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-gh9x-wv37-w3xq"
    },
    "bigops-eslint": {
      blocked_all: true,
      reason: "Malicious code in bigops-eslint (npm) (GHSA-8vwm-3x9f-mccp)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-8vwm-3x9f-mccp"
    },
    "greatcall-customers-commandapi": {
      blocked_all: true,
      reason: "Malicious code in greatcall-customers-commandapi (npm) (GHSA-78f6-2878-hcp4)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-78f6-2878-hcp4"
    },
    "bcore-bravo-eslint-config": {
      blocked_all: true,
      reason: "Malicious code in bcore-bravo-eslint-config (npm) (GHSA-rp5f-362v-pw3h)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-rp5f-362v-pw3h"
    },
    "boardwalk-js-tests": {
      blocked_all: true,
      reason: "Malicious code in boardwalk-js-tests (npm) (GHSA-978x-49gc-fq44)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-978x-49gc-fq44"
    },
    "beaver-ui-card-large": {
      blocked_all: true,
      reason: "Malicious code in beaver-ui-card-large (npm) (GHSA-v8v9-qm2p-x684)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-v8v9-qm2p-x684"
    },
    "@zzzgenesis00/playwrite": {
      blocked_all: true,
      reason: "Malicious code in @zzzgenesis00/playwrite (npm) (GHSA-c5v7-846x-pcgr)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-c5v7-846x-pcgr"
    },
    "@zzzgenesis00/docker-api-client": {
      blocked_all: true,
      reason: "Malicious code in @zzzgenesis00/docker-api-client (npm) (GHSA-p492-926f-h775)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-p492-926f-h775"
    },
    "@zzzgenesis00/spl-token-utils": {
      blocked_all: true,
      reason: "Malicious code in @zzzgenesis00/spl-token-utils (npm) (GHSA-6fpm-pvw8-qj34)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-6fpm-pvw8-qj34"
    },
    "@zzzgenesis00/mnemonic-to-key": {
      blocked_all: true,
      reason: "Malicious code in @zzzgenesis00/mnemonic-to-key (npm) (GHSA-65q9-wff6-3r9m)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-65q9-wff6-3r9m"
    },
    "creditcard.js": {
      blocked_all: true,
      reason: "Malware in creditcard.js (GHSA-6v78-xg39-f56q)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-6v78-xg39-f56q"
    },
    "awaitly-postgres": {
      blocked_all: true,
      reason: "Malware in awaitly-postgres (GHSA-hpp3-2qqp-gw63)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-hpp3-2qqp-gw63"
    },
    "awaitly-visualizer": {
      blocked_all: true,
      reason: "Malware in awaitly-visualizer (GHSA-7vwj-f8vf-q9jf)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-7vwj-f8vf-q9jf"
    },
    "discord-search": {
      blocked_all: true,
      reason: "Malware in discord-search (GHSA-98mq-hfqh-3rxm)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-98mq-hfqh-3rxm"
    },
    "eslint-plugin-executable-stories-playwright": {
      blocked_all: true,
      reason: "Malware in eslint-plugin-executable-stories-playwright (GHSA-xqjr-r64q-26cp)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-xqjr-r64q-26cp"
    },
    "executable-stories-playwright": {
      blocked_all: true,
      reason: "Malware in executable-stories-playwright (GHSA-g2qc-jgmc-4956)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-g2qc-jgmc-4956"
    },
    mountly: {
      blocked_all: true,
      reason: "Malware in mountly (GHSA-j9rq-vgj9-94g8)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-j9rq-vgj9-94g8"
    },
    "executable-stories-vitest": {
      blocked_all: true,
      reason: "Malware in executable-stories-vitest (GHSA-75mp-q9qh-pc3h)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-75mp-q9qh-pc3h"
    },
    "create-cf-token": {
      blocked_all: true,
      reason: "Malware in create-cf-token (GHSA-cf4c-f3hr-3wh4)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-cf4c-f3hr-3wh4"
    },
    "create-wrangler-deploy": {
      blocked_all: true,
      reason: "Malware in create-wrangler-deploy (GHSA-5pxw-jqgf-87rf)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-5pxw-jqgf-87rf"
    },
    "@umacloud/cli-linux-musl-x64": {
      blocked_all: true,
      reason: "Malware in @umacloud/cli-linux-musl-x64 (GHSA-jp94-5mph-fpf8)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-jp94-5mph-fpf8"
    },
    umadev: {
      blocked_all: true,
      reason: "Malware in umadev (GHSA-rxr8-mfg7-xm79)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-rxr8-mfg7-xm79"
    },
    "@umacloud/cli-linux-musl-arm64": {
      blocked_all: true,
      reason: "Malware in @umacloud/cli-linux-musl-arm64 (GHSA-ppgw-mhjm-w25f)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-ppgw-mhjm-w25f"
    },
    "@umacloud/knowledge": {
      blocked_all: true,
      reason: "Malware in @umacloud/knowledge (GHSA-vpvg-254v-wp7h)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-vpvg-254v-wp7h"
    },
    "@umacloud/cli-win32-x64": {
      blocked_all: true,
      reason: "Malware in @umacloud/cli-win32-x64 (GHSA-vgf8-c62c-jjxr)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-vgf8-c62c-jjxr"
    },
    "@umacloud/cli-darwin-x64": {
      blocked_all: true,
      reason: "Malware in @umacloud/cli-darwin-x64 (GHSA-qqc5-qqrh-3hx8)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-qqc5-qqrh-3hx8"
    },
    "@umacloud/cli-linux-arm64": {
      blocked_all: true,
      reason: "Malware in @umacloud/cli-linux-arm64 (GHSA-cgqh-w28v-v9wg)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-cgqh-w28v-v9wg"
    },
    "@umacloud/cli-linux-x64": {
      blocked_all: true,
      reason: "Malware in @umacloud/cli-linux-x64 (GHSA-p886-3cf4-j5cx)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-p886-3cf4-j5cx"
    },
    "@umacloud/cli-darwin-arm64": {
      blocked_all: true,
      reason: "Malware in @umacloud/cli-darwin-arm64 (GHSA-qrjp-2vx3-hwg4)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-qrjp-2vx3-hwg4"
    },
    "@jsimplify/errno": {
      blocked_all: true,
      reason: "Malware in @jsimplify/errno (GHSA-vgg6-7x38-g434)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-vgg6-7x38-g434"
    },
    "cors-version": {
      blocked_all: true,
      reason: "Malware in cors-version (GHSA-2hwp-7m6r-hgjg)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-2hwp-7m6r-hgjg"
    },
    "tailwind-anime": {
      blocked_all: true,
      reason: "Malware in tailwind-anime (GHSA-58f3-m5c8-hcrv)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-58f3-m5c8-hcrv"
    },
    "server-hemera-mongo": {
      blocked_all: true,
      reason: "Malware in server-hemera-mongo (GHSA-rrhh-mxmx-x7xf)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-rrhh-mxmx-x7xf"
    },
    "@adminide-stack/yantra-mobile": {
      blocked_all: true,
      reason: "Malware in @adminide-stack/yantra-mobile (GHSA-2698-4w7r-9qqv)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-2698-4w7r-9qqv"
    },
    "workbench-browser-server": {
      blocked_all: true,
      reason: "Malware in workbench-browser-server (GHSA-63m5-c696-rwrc)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-63m5-c696-rwrc"
    },
    "@workbench-stack/core": {
      blocked_all: true,
      reason: "Malware in @workbench-stack/core (GHSA-qc5f-j5q7-57hf)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-qc5f-j5q7-57hf"
    },
    "@qlik/nebula-table-utils": {
      blocked_all: true,
      reason: "Malware in @qlik/nebula-table-utils (GHSA-qgqm-m8rp-5q25)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-qgqm-m8rp-5q25"
    },
    "@nebula.js/sn-line-chart": {
      blocked_all: true,
      reason: "Malware in @nebula.js/sn-line-chart (GHSA-jvxf-3873-cvcw)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-jvxf-3873-cvcw"
    },
    "@nebula.js/sn-layout-container": {
      blocked_all: true,
      reason: "Malware in @nebula.js/sn-layout-container (GHSA-cqf2-r88m-hcq2)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-cqf2-r88m-hcq2"
    },
    "@qlik/sprout-icons": {
      blocked_all: true,
      reason: "Malware in @qlik/sprout-icons (GHSA-4hhj-rpx3-pw9f)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-4hhj-rpx3-pw9f"
    },
    "http-metrics-middleware": {
      blocked_all: true,
      reason: "Malware in http-metrics-middleware (GHSA-w86p-g27r-2m6q)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-w86p-g27r-2m6q"
    },
    "@qlik/sprout-design-docs": {
      blocked_all: true,
      reason: "Malware in @qlik/sprout-design-docs (GHSA-m3hw-7p37-3vmh)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-m3hw-7p37-3vmh"
    },
    "@qlik/prettier-config": {
      blocked_all: true,
      reason: "Malware in @qlik/prettier-config (GHSA-2259-j57x-rf45)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-2259-j57x-rf45"
    },
    "@qlik/browserslist-config": {
      blocked_all: true,
      reason: "Malware in @qlik/browserslist-config (GHSA-x47v-2r4m-2q34)",
      date: "2026-08-04",
      advisory: "https://github.com/advisories/GHSA-x47v-2r4m-2q34"
    },
    "wallet-monitor-snap": {
      blocked_all: true,
      reason: "Malicious code in wallet-monitor-snap (npm) (GHSA-vvrv-9r7f-pxcv)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-vvrv-9r7f-pxcv"
    },
    golaaa: {
      blocked_all: true,
      reason: "Malicious code in golaaa (npm) (GHSA-qw4v-qp85-m2fx)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-qw4v-qp85-m2fx"
    },
    "@zahlen/checkout-angular": {
      blocked_all: true,
      reason: "Malware in @zahlen/checkout-angular (GHSA-x4vv-h5rq-v2hm)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-x4vv-h5rq-v2hm"
    },
    "@zahlen/checkout": {
      blocked_all: true,
      reason: "Malware in @zahlen/checkout (GHSA-vj9r-9wwp-6cfp)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-vj9r-9wwp-6cfp"
    },
    "@voxepay/checkout": {
      blocked_all: true,
      reason: "Malware in @voxepay/checkout (GHSA-qgfh-mjq8-m7wx)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-qgfh-mjq8-m7wx"
    },
    "@vboxdev/common": {
      blocked_all: true,
      reason: "Malware in @vboxdev/common (GHSA-rx4f-8493-c7j8)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-rx4f-8493-c7j8"
    },
    "@nasdtickets/common": {
      blocked_all: true,
      reason: "Malware in @nasdtickets/common (GHSA-49j5-8rcw-8rh8)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-49j5-8rcw-8rh8"
    },
    "@simplipayng/checkout": {
      blocked_all: true,
      reason: "Malware in @simplipayng/checkout (GHSA-cvhm-4vf7-gq9p)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-cvhm-4vf7-gq9p"
    },
    "@rentwise/common": {
      blocked_all: true,
      reason: "Malware in @rentwise/common (GHSA-x23q-mgjg-53mq)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-x23q-mgjg-53mq"
    },
    "@nasddatax/common": {
      blocked_all: true,
      reason: "Malware in @nasddatax/common (GHSA-mx45-4vrr-4fgp)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-mx45-4vrr-4fgp"
    },
    "@hoteldev/common": {
      blocked_all: true,
      reason: "Malware in @hoteldev/common (GHSA-62r9-p944-cjmg)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-62r9-p944-cjmg"
    },
    "@afasinatickets/common": {
      blocked_all: true,
      reason: "Malware in @afasinatickets/common (GHSA-m2g7-6r7x-29p9)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-m2g7-6r7x-29p9"
    },
    simplipayng: {
      blocked_all: true,
      reason: "Malware in simplipayng (GHSA-qw5j-q6g9-pqhf)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-qw5j-q6g9-pqhf"
    },
    "@xsat10/baileys-xsat": {
      blocked_all: true,
      reason: "Malware in @xsat10/baileys-xsat (GHSA-fj9m-r2qx-cc39)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-fj9m-r2qx-cc39"
    },
    "@agenthub-ai/agent": {
      blocked_all: true,
      reason: "Malware in @agenthub-ai/agent (GHSA-p2hv-cfx8-pv93)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-p2hv-cfx8-pv93"
    },
    "statist-browser-typed-client-sme.rko.tariffs.web": {
      blocked_all: true,
      reason: "Malicious code in statist-browser-typed-client-sme.rko.tariffs.web (npm) (GHSA-3pph-9426-8xmv)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-3pph-9426-8xmv"
    },
    "claude-remote-agent": {
      blocked_all: true,
      reason: "Malicious code in claude-remote-agent (npm) (GHSA-vmfr-7cqr-9wc8)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-vmfr-7cqr-9wc8"
    },
    "bigops-tcrm-permissions": {
      blocked_all: true,
      reason: "Malicious code in bigops-tcrm-permissions (npm) (GHSA-gpvp-vfrf-23hv)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-gpvp-vfrf-23hv"
    },
    "app-api-sdk": {
      blocked_all: true,
      reason: "Malicious code in app-api-sdk (npm) (GHSA-g296-v9h4-4449)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-g296-v9h4-4449"
    },
    ezdiscordbots: {
      blocked_all: true,
      reason: "Malicious code in ezdiscordbots (npm) (GHSA-5r45-5p39-9pxx)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-5r45-5p39-9pxx"
    },
    "npm-dc-dev": {
      blocked_all: true,
      reason: "Malicious code in npm-dc-dev (npm) (GHSA-c8p8-hx32-6q2r)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-c8p8-hx32-6q2r"
    },
    "alipclutch-baileys": {
      blocked_all: true,
      reason: "Malicious code in alipclutch-baileys (npm) (GHSA-jw7v-xrmm-426j)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-jw7v-xrmm-426j"
    },
    "@chnayser/server": {
      blocked_all: true,
      reason: "Malicious code in @chnayser/server (npm) (GHSA-c4jh-v6xv-2wpm)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-c4jh-v6xv-2wpm"
    },
    "svelte-mapped-metrics": {
      blocked_all: true,
      reason: "Malware in svelte-mapped-metrics (GHSA-pqjj-j4gr-x575)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-pqjj-j4gr-x575"
    },
    "streak-math-calc": {
      blocked_all: true,
      reason: "Malware in streak-math-calc (GHSA-vvg8-qpgg-c28r)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-vvg8-qpgg-c28r"
    },
    "svelte-mapping-core": {
      blocked_all: true,
      reason: "Malware in svelte-mapping-core (GHSA-qq27-fv34-9cm7)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-qq27-fv34-9cm7"
    },
    "eslint-plugin-vitest-ts": {
      blocked_all: true,
      reason: "Malware in eslint-plugin-vitest-ts (GHSA-pw3r-jw68-935v)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-pw3r-jw68-935v"
    },
    "tailwindcss-scrollbar-hide": {
      blocked_all: true,
      reason: "Malware in tailwindcss-scrollbar-hide (GHSA-6r49-6vv4-wpp3)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-6r49-6vv4-wpp3"
    },
    "multi-acct": {
      blocked_all: true,
      reason: "Malicious code in multi-acct (npm) (GHSA-38x6-vx4x-xrgv)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-38x6-vx4x-xrgv"
    },
    "llm-interceptor": {
      blocked_all: true,
      reason: "Malicious code in llm-interceptor (npm) (GHSA-6wxr-274h-wx32)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-6wxr-274h-wx32"
    },
    "sextant-cli-darwin-arm64": {
      blocked_all: true,
      reason: "Malicious code in sextant-cli-darwin-arm64 (npm) (GHSA-2qg7-5p3x-vr75)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-2qg7-5p3x-vr75"
    },
    "express-dever": {
      blocked_all: true,
      reason: "Malicious code in express-dever (npm) (GHSA-p26f-w557-jgq6)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-p26f-w557-jgq6"
    },
    "express-rate-controller": {
      blocked_all: true,
      reason: "Malicious code in express-rate-controller (npm) (GHSA-qm8f-pmrw-jjhh)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-qm8f-pmrw-jjhh"
    },
    "@workoscalif/sudoku": {
      blocked_all: true,
      reason: "Malicious code in @workoscalif/sudoku (npm) (GHSA-8g32-6v5x-wx9c)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-8g32-6v5x-wx9c"
    },
    "clawtrl-wallet": {
      blocked_all: true,
      reason: "Malicious code in clawtrl-wallet (npm) (GHSA-fh5c-3w68-67m4)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-fh5c-3w68-67m4"
    },
    "@lizhao1/memorax-code-internal": {
      blocked_all: true,
      reason: "Malicious code in @lizhao1/memorax-code-internal (npm) (GHSA-38v4-49rm-mvj2)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-38v4-49rm-mvj2"
    },
    kepler: {
      blocked_all: true,
      reason: "Malicious code in kepler (npm) (GHSA-4vx4-f3cp-29qp)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-4vx4-f3cp-29qp"
    },
    "@stageflight-testbed/a": {
      blocked_all: true,
      reason: "Malicious code in @stageflight-testbed/a (npm) (GHSA-26x7-qj39-p8cg)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-26x7-qj39-p8cg"
    },
    "@ikbal_fadilah_vanexa01/vanexa-agent": {
      blocked_all: true,
      reason: "Malicious code in @ikbal_fadilah_vanexa01/vanexa-agent (npm) (GHSA-f255-3246-f22g)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-f255-3246-f22g"
    },
    "@cliphijack/santaclaude": {
      blocked_all: true,
      reason: "Malicious code in @cliphijack/santaclaude (npm) (GHSA-mfhm-5r65-895x)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-mfhm-5r65-895x"
    },
    "dolyame-boxy-independent-bnpl-items": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-independent-bnpl-items (GHSA-jh2q-fjxj-2jrr)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-jh2q-fjxj-2jrr"
    },
    "tinkoff-volna-zustate": {
      blocked_all: true,
      reason: "Malware in tinkoff-volna-zustate (GHSA-fm7r-fg6q-669q)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-fm7r-fg6q-669q"
    },
    "bnpl-blocks-atom-bnpl-email-form": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-email-form (GHSA-2gqh-cw7h-hv48)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-2gqh-cw7h-hv48"
    },
    "dolyame-boxy-fonts": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-fonts (GHSA-rphf-wm4q-p6rj)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-rphf-wm4q-p6rj"
    },
    "bnpl-blocks-atom-bnpl-badge": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-badge (GHSA-6hgf-fq2c-gw65)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-6hgf-fq2c-gw65"
    },
    "tinkoff-pfp-block-desktop-tabs": {
      blocked_all: true,
      reason: "Malware in tinkoff-pfp-block-desktop-tabs (GHSA-48h6-x5hr-r3v3)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-48h6-x5hr-r3v3"
    },
    "tinkoff-statist-browser-typed-client-itsa.candy.selfservicesupport.frontend.events": {
      blocked_all: true,
      reason: "Malware in tinkoff-statist-browser-typed-client-itsa.candy.selfservicesupport.frontend.events (GHSA-4mrm-8v83-27p9)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-4mrm-8v83-27p9"
    },
    "dolyame-boxy-independent-bnpl-info-slider": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-independent-bnpl-info-slider (GHSA-jqw3-qv57-jf48)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-jqw3-qv57-jf48"
    },
    "bnpl-blocks-atom-bnpl-dropdown": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-dropdown (GHSA-78qc-hpf4-c2hh)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-78qc-hpf4-c2hh"
    },
    "dolyame-boxy-independent-bnpl-partners": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-independent-bnpl-partners (GHSA-8j6w-c4q8-8hm5)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-8j6w-c4q8-8hm5"
    },
    "tramvai-module-feature-toggle": {
      blocked_all: true,
      reason: "Malware in tramvai-module-feature-toggle (GHSA-x32c-hhrc-xrc7)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-x32c-hhrc-xrc7"
    },
    "bnpl-blocks-atom-bnpl-info-card": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-info-card (GHSA-6gpj-rw83-w8q4)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-6gpj-rw83-w8q4"
    },
    "dolyame-boxy-independent-bnpl-search": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-independent-bnpl-search (GHSA-c6jq-gq46-43jj)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-c6jq-gq46-43jj"
    },
    "bnpl-blocks-atom-bnpl-news-card": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-news-card (GHSA-rqfj-h6pc-94cx)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-rqfj-h6pc-94cx"
    },
    "vvvedernikov-test-another-test": {
      blocked_all: true,
      reason: "Malware in vvvedernikov-test-another-test (GHSA-2cwh-jj48-rvcp)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-2cwh-jj48-rvcp"
    },
    "bigops-auth": {
      blocked_all: true,
      reason: "Malware in bigops-auth (GHSA-2g3q-h5qx-j6f8)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-2g3q-h5qx-j6f8"
    },
    "dolyame-boxy-independent-bnpl-picture-gallery": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-independent-bnpl-picture-gallery (GHSA-66p9-hhr7-jqr7)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-66p9-hhr7-jqr7"
    },
    "bnpl-blocks-atom-bnpl-integrations-breadcrumbs": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-integrations-breadcrumbs (GHSA-q24r-8r2w-2x7q)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-q24r-8r2w-2x7q"
    },
    "tinkoff-statist-browser-typed-client-sme.rko.origsmartphonepaytb.common.mobile.events": {
      blocked_all: true,
      reason: "Malware in tinkoff-statist-browser-typed-client-sme.rko.origsmartphonepaytb.common.mobile.events (GHSA-8w68-xhpf-ww9j)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-8w68-xhpf-ww9j"
    },
    "bnpl-blocks-atom-bnpl-dolyame-button": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-dolyame-button (GHSA-6r9r-p7ch-x848)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-6r9r-p7ch-x848"
    },
    "trapp-check-logs": {
      blocked_all: true,
      reason: "Malware in trapp-check-logs (GHSA-4xfj-589v-h29h)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-4xfj-589v-h29h"
    },
    "bnpl-blocks-atom-bnpl-action-card": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-action-card (GHSA-8wwx-wwwp-v9x6)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-8wwx-wwwp-v9x6"
    },
    "sme-foundation-frame-manager": {
      blocked_all: true,
      reason: "Malware in sme-foundation-frame-manager (GHSA-v4gj-p36r-rv6m)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-v4gj-p36r-rv6m"
    },
    "dolyame-boxy-desktop-bnpl-text-block": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-desktop-bnpl-text-block (GHSA-w896-652g-jg96)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-w896-652g-jg96"
    },
    "dolyame-boxy-independent-bnpl-scheme": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-independent-bnpl-scheme (GHSA-4c3q-jjpc-xjwp)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-4c3q-jjpc-xjwp"
    },
    "bnpl-blocks-atom-bnpl-navigation-arrow": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-navigation-arrow (GHSA-7qx6-3gxv-f3mj)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-7qx6-3gxv-f3mj"
    },
    "bnpl-blocks-atom-bnpl-breadcrumbs": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-breadcrumbs (GHSA-r3c4-v8r3-9wx3)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-r3c4-v8r3-9wx3"
    },
    "dolyame-boxy-independent-bnpl-button": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-independent-bnpl-button (GHSA-f3r5-jmpg-pmrm)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-f3r5-jmpg-pmrm"
    },
    "twork-data-services-sme-agent-company-relation": {
      blocked_all: true,
      reason: "Malware in twork-data-services-sme-agent-company-relation (GHSA-xp7w-qh77-w69x)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-xp7w-qh77-w69x"
    },
    "bigops-api": {
      blocked_all: true,
      reason: "Malware in bigops-api (GHSA-fpj4-wwp3-6693)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-fpj4-wwp3-6693"
    },
    "dolyame-boxy-desktop-bnpl-popup": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-desktop-bnpl-popup (GHSA-54m5-fwc4-g8cq)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-54m5-fwc4-g8cq"
    },
    "tinkoff-test-app-child-app": {
      blocked_all: true,
      reason: "Malware in tinkoff-test-app-child-app (GHSA-q659-qc8w-8m2x)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-q659-qc8w-8m2x"
    },
    "bnpl-blocks-analytics": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-analytics (GHSA-gpqh-q563-jrxf)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-gpqh-q563-jrxf"
    },
    "bnpl-blocks-atom-bnpl-anchor-menu": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-anchor-menu (GHSA-h36f-584p-27fc)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-h36f-584p-27fc"
    },
    "dolyame-boxy-desktop-bnpl-title": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-desktop-bnpl-title (GHSA-q5wr-4pm9-cv7p)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-q5wr-4pm9-cv7p"
    },
    "statist-browser-typed-client-rubliq.platform.keycloak": {
      blocked_all: true,
      reason: "Malware in statist-browser-typed-client-rubliq.platform.keycloak (GHSA-vw62-9qq2-wr9g)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-vw62-9qq2-wr9g"
    },
    "dolyame-boxy-independent-bnpl-mobile-application": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-independent-bnpl-mobile-application (GHSA-9368-qf6c-gcr6)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-9368-qf6c-gcr6"
    },
    "bnpl-blocks-atom-bnpl-feedback": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-feedback (GHSA-23mh-5c53-jxhh)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-23mh-5c53-jxhh"
    },
    "boxy-fixture-allure": {
      blocked_all: true,
      reason: "Malware in boxy-fixture-allure (GHSA-cq8x-34cv-8xxm)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-cq8x-34cv-8xxm"
    },
    "bigops-api-mobile": {
      blocked_all: true,
      reason: "Malware in bigops-api-mobile (GHSA-342j-gf24-vx6v)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-342j-gf24-vx6v"
    },
    "bnpl-blocks-atom-bnpl-fade-overflow": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-fade-overflow (GHSA-cmmv-wrqx-q5f8)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-cmmv-wrqx-q5f8"
    },
    "dolyame-boxy-independent-bnpl-main-banner": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-independent-bnpl-main-banner (GHSA-w834-22q3-g727)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-w834-22q3-g727"
    },
    "tinkoff-fb-app-frame-page-height-dippy": {
      blocked_all: true,
      reason: "Malware in tinkoff-fb-app-frame-page-height-dippy (GHSA-4xh9-wm5m-39jp)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-4xh9-wm5m-39jp"
    },
    "dolyame-boxy-independent-bnpl-navigation": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-independent-bnpl-navigation (GHSA-wcqm-j33w-hfrv)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-wcqm-j33w-hfrv"
    },
    "bnpl-blocks-atom-bnpl-image": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-image (GHSA-j6xp-jc33-qf8j)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-j6xp-jc33-qf8j"
    },
    "sso-tramvai-lib-roles": {
      blocked_all: true,
      reason: "Malware in sso-tramvai-lib-roles (GHSA-pp46-jh43-q79f)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-pp46-jh43-q79f"
    },
    "dolyame-boxy-independent-bnpl-cards": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-independent-bnpl-cards (GHSA-j8fg-fh4m-2cw2)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-j8fg-fh4m-2cw2"
    },
    "bnpl-blocks-atom-bnpl-button": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-button (GHSA-gxfp-gfm5-6f92)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-gxfp-gfm5-6f92"
    },
    "statist-browser-typed-client-eventea.projects.pfpacquiring": {
      blocked_all: true,
      reason: "Malware in statist-browser-typed-client-eventea.projects.pfpacquiring (GHSA-p42f-p569-4px5)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-p42f-p569-4px5"
    },
    "dolyame-boxy-independent-bnpl-features": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-independent-bnpl-features (GHSA-gcf9-6q6g-6qjf)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-gcf9-6q6g-6qjf"
    },
    "bnpl-blocks-atom-bnpl-dangerously-html": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-dangerously-html (GHSA-h385-qp77-g974)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-h385-qp77-g974"
    },
    "eventea-diag": {
      blocked_all: true,
      reason: "Malware in eventea-diag (GHSA-c86h-3ch7-5r5g)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-c86h-3ch7-5r5g"
    },
    "dolyame-boxy-independent-bnpl-breadcrumbs": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-independent-bnpl-breadcrumbs (GHSA-42r9-vvjf-fx84)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-42r9-vvjf-fx84"
    },
    "bnpl-blocks-atom-bnpl-base-popup": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-base-popup (GHSA-jcq8-g68g-q43c)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-jcq8-g68g-q43c"
    },
    "tinkoff-fb-fieldset-car-reference-kasko": {
      blocked_all: true,
      reason: "Malware in tinkoff-fb-fieldset-car-reference-kasko (GHSA-4pm5-vwjx-55wp)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-4pm5-vwjx-55wp"
    },
    "dolyame-boxy-desktop-bnpl-picture-gallery": {
      blocked_all: true,
      reason: "Malware in dolyame-boxy-desktop-bnpl-picture-gallery (GHSA-gf73-fvqq-2f8f)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-gf73-fvqq-2f8f"
    },
    "pfp-forms-mobile-sme-group-tiles": {
      blocked_all: true,
      reason: "Malware in pfp-forms-mobile-sme-group-tiles (GHSA-9vp2-g2wh-59wm)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-9vp2-g2wh-59wm"
    },
    "bnpl-api": {
      blocked_all: true,
      reason: "Malware in bnpl-api (GHSA-fgxc-644c-34qm)",
      date: "2026-08-05",
      advisory: "https://github.com/advisories/GHSA-fgxc-644c-34qm"
    },
    "postcss-theme-provider": {
      blocked_all: true,
      reason: "Malicious code in postcss-theme-provider (npm) (GHSA-43g9-xh9q-657c)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-43g9-xh9q-657c"
    },
    "gas-diff-core": {
      blocked_all: true,
      reason: "Malicious code in gas-diff-core (npm) (GHSA-hw2f-c6r2-4cmc)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-hw2f-c6r2-4cmc"
    },
    "vitest-preview-pro": {
      blocked_all: true,
      reason: "Malicious code in vitest-preview-pro (npm) (GHSA-68vm-3fp7-p29j)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-68vm-3fp7-p29j"
    },
    "forge-gas-diff": {
      blocked_all: true,
      reason: "Malicious code in forge-gas-diff (npm) (GHSA-83mr-hgqj-5xw3)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-83mr-hgqj-5xw3"
    },
    "streak-kit-map": {
      blocked_all: true,
      reason: "Malicious code in streak-kit-map (npm) (GHSA-hgrf-cfvr-xx4h)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-hgrf-cfvr-xx4h"
    },
    "dolyame-ui-iconloaderhoc": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-iconloaderhoc (npm) (GHSA-r8c7-ghf2-mh2r)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-r8c7-ghf2-mh2r"
    },
    "ded-pwa-ded-pwa-core": {
      blocked_all: true,
      reason: "Malicious code in ded-pwa-ded-pwa-core (npm) (GHSA-q534-q94q-5267)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-q534-q94q-5267"
    },
    "ded-pwa-c-cms": {
      blocked_all: true,
      reason: "Malicious code in ded-pwa-c-cms (npm) (GHSA-jp7v-p7hf-jrvm)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-jp7v-p7hf-jrvm"
    },
    "delivery-ci-jira-rnd": {
      blocked_all: true,
      reason: "Malicious code in delivery-ci-jira-rnd (npm) (GHSA-gr32-hfrv-p7fq)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-gr32-hfrv-p7fq"
    },
    "ded-pwa-c-page-maker-props": {
      blocked_all: true,
      reason: "Malicious code in ded-pwa-c-page-maker-props (npm) (GHSA-cf34-h47q-47m7)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-cf34-h47q-47m7"
    },
    distributorblock: {
      blocked_all: true,
      reason: "Malicious code in distributorblock (npm) (GHSA-jwgc-h665-hx38)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-jwgc-h665-hx38"
    },
    "devplatform-react-mcp": {
      blocked_all: true,
      reason: "Malicious code in devplatform-react-mcp (npm) (GHSA-mcm8-ccm7-f469)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-mcm8-ccm7-f469"
    },
    "eacq-core": {
      blocked_all: true,
      reason: "Malicious code in eacq-core (npm) (GHSA-q3wf-gqpp-w2j7)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-q3wf-gqpp-w2j7"
    },
    "eacq-dialog": {
      blocked_all: true,
      reason: "Malicious code in eacq-dialog (npm) (GHSA-w5m9-cv95-g8rm)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-w5m9-cv95-g8rm"
    },
    "dolyame-ui-inputcolor": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-inputcolor (npm) (GHSA-2h8h-gwgx-mwxw)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-2h8h-gwgx-mwxw"
    },
    "eacq-cdk": {
      blocked_all: true,
      reason: "Malicious code in eacq-cdk (npm) (GHSA-8v88-w292-98xq)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-8v88-w292-98xq"
    },
    "dolyame-ui-inputpassword": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-inputpassword (npm) (GHSA-xxm4-6xph-4vp8)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-xxm4-6xph-4vp8"
    },
    "dolyame-ui-stateutils": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-stateutils (npm) (GHSA-fvh5-mpq2-8g44)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-fvh5-mpq2-8g44"
    },
    "dolyame-ui-tabsblock": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-tabsblock (npm) (GHSA-48hx-6pv6-rvc9)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-48hx-6pv6-rvc9"
    },
    "dolyame-ui-inputbox": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-inputbox (npm) (GHSA-v8m6-gp8m-c68v)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-v8m6-gp8m-c68v"
    },
    "dolyame-ui-progresscircle": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-progresscircle (npm) (GHSA-4f9v-2x77-4wrv)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-4f9v-2x77-4wrv"
    },
    "dolyame-ui-lazyrender": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-lazyrender (npm) (GHSA-r6wh-r68v-mrj9)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-r6wh-r68v-mrj9"
    },
    "dolyame-ui-attachfile": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-attachfile (npm) (GHSA-wwqm-fv8r-cwj6)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-wwqm-fv8r-cwj6"
    },
    "delivery-ci-codeceptjs-fork": {
      blocked_all: true,
      reason: "Malicious code in delivery-ci-codeceptjs-fork (npm) (GHSA-x6hr-5vj6-f8cq)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-x6hr-5vj6-f8cq"
    },
    "delivery-ci-dpat": {
      blocked_all: true,
      reason: "Malicious code in delivery-ci-dpat (npm) (GHSA-cm97-w294-4p9x)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-cm97-w294-4p9x"
    },
    blekit: {
      blocked_all: true,
      reason: "Malicious code in blekit (npm) (GHSA-9vrr-g3mp-m3r4)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-9vrr-g3mp-m3r4"
    },
    "bigops-telephony-mock": {
      blocked_all: true,
      reason: "Malicious code in bigops-telephony-mock (npm) (GHSA-g88g-2v35-hwhj)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-g88g-2v35-hwhj"
    },
    "merge-grid-stats": {
      blocked_all: true,
      reason: "Malicious code in merge-grid-stats (npm) (GHSA-vqp7-j6jf-34qm)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-vqp7-j6jf-34qm"
    },
    weight2loss: {
      blocked_all: true,
      reason: "Malicious code in weight2loss (npm) (GHSA-8hq6-jx73-fgjw)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-8hq6-jx73-fgjw"
    },
    internallib_v514: {
      blocked_all: true,
      reason: "Malicious code in internallib_v514 (npm) (GHSA-676x-3cvx-w3j5)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-676x-3cvx-w3j5"
    },
    "diezyclutch-baileys": {
      blocked_all: true,
      reason: "Malicious code in diezyclutch-baileys (npm) (GHSA-xqrx-4hpr-8cx7)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-xqrx-4hpr-8cx7"
    },
    "@cats-cdf/browser-metrics-meter": {
      blocked_all: true,
      reason: "Malicious code in @cats-cdf/browser-metrics-meter (npm) (GHSA-c4hf-jrgf-gw89)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-c4hf-jrgf-gw89"
    },
    "cdf-tag-commander-helper": {
      blocked_all: true,
      reason: "Malicious code in cdf-tag-commander-helper (npm) (GHSA-3cg7-rhc6-g63p)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-3cg7-rhc6-g63p"
    },
    "@prototypevip/baileys": {
      blocked_all: true,
      reason: "Malicious code in @prototypevip/baileys (npm) (GHSA-rj44-3fvq-rvp4)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-rj44-3fvq-rvp4"
    },
    "@cats-cdf/authentication": {
      blocked_all: true,
      reason: "Malicious code in @cats-cdf/authentication (npm) (GHSA-cgq2-qp6c-q4rm)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-cgq2-qp6c-q4rm"
    },
    xxdxax: {
      blocked_all: true,
      reason: "Malicious code in xxdxax (npm) (GHSA-vmq9-f9v2-mpqm)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-vmq9-f9v2-mpqm"
    },
    squeez: {
      blocked_all: true,
      reason: "Malicious code in squeez (npm) (GHSA-gxp9-8gvx-q8cq)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-gxp9-8gvx-q8cq"
    },
    "wos-library-ui": {
      blocked_all: true,
      reason: "Malicious code in wos-library-ui (npm) (GHSA-j5rq-m53m-6xfx)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-j5rq-m53m-6xfx"
    },
    xdaxx: {
      blocked_all: true,
      reason: "Malicious code in xdaxx (npm) (GHSA-qhqw-3g9p-hj8v)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-qhqw-3g9p-hj8v"
    },
    "vite-vue-path-map": {
      blocked_all: true,
      reason: "Malicious code in vite-vue-path-map (npm) (GHSA-jvpq-f7f2-w263)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-jvpq-f7f2-w263"
    },
    "vite-plugin-cleaner": {
      blocked_all: true,
      reason: "Malicious code in vite-plugin-cleaner (npm) (GHSA-fg76-p6gh-vq23)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-fg76-p6gh-vq23"
    },
    trimprompt: {
      blocked_all: true,
      reason: "Malicious code in trimprompt (npm) (GHSA-cvm3-f6xv-h47p)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-cvm3-f6xv-h47p"
    },
    "vite-svg-parse": {
      blocked_all: true,
      reason: "Malicious code in vite-svg-parse (npm) (GHSA-27vm-5h98-8xf6)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-27vm-5h98-8xf6"
    },
    "streak-map-cache": {
      blocked_all: true,
      reason: "Malicious code in streak-map-cache (npm) (GHSA-jrfj-4vf7-xrg3)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-jrfj-4vf7-xrg3"
    },
    "ynastore-baileys": {
      blocked_all: true,
      reason: "Malicious code in ynastore-baileys (npm) (GHSA-wv6v-7p37-mx4j)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-wv6v-7p37-mx4j"
    },
    "zyr-agent": {
      blocked_all: true,
      reason: "Malicious code in zyr-agent (npm) (GHSA-rhx7-52rr-88vg)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-rhx7-52rr-88vg"
    },
    supersig: {
      blocked_all: true,
      reason: "Malicious code in supersig (npm) (GHSA-3g8f-pfg5-95hv)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-3g8f-pfg5-95hv"
    },
    stretchshop: {
      blocked_all: true,
      reason: "Malicious code in stretchshop (npm) (GHSA-hjhp-x4x6-fq56)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-hjhp-x4x6-fq56"
    },
    "remote-claude-daemon": {
      blocked_all: true,
      reason: "Malicious code in remote-claude-daemon (npm) (GHSA-4qch-7gcj-fhvm)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-4qch-7gcj-fhvm"
    },
    "wormgpt-cli": {
      blocked_all: true,
      reason: "Malicious code in wormgpt-cli (npm) (GHSA-fw33-jr6r-h62p)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-fw33-jr6r-h62p"
    },
    "@lyxa.ai/core": {
      blocked_all: true,
      reason: "Malicious code in @lyxa.ai/core (npm) (GHSA-vmrc-mrj8-pcvh)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-vmrc-mrj8-pcvh"
    },
    "commonweb-flow": {
      blocked_all: true,
      reason: "Malicious code in commonweb-flow (npm) (GHSA-hvpr-vw2p-qhw6)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-hvpr-vw2p-qhw6"
    },
    "@wbnr/frontend-shared": {
      blocked_all: true,
      reason: "Malicious code in @wbnr/frontend-shared (npm) (GHSA-9vgv-g4jx-8g9w)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-9vgv-g4jx-8g9w"
    },
    "electrode-ota-ui-app": {
      blocked_all: true,
      reason: "Malicious code in electrode-ota-ui-app (npm) (GHSA-mxx2-5pvc-7hc9)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-mxx2-5pvc-7hc9"
    },
    "dpdgroup-css": {
      blocked_all: true,
      reason: "Malicious code in dpdgroup-css (npm) (GHSA-pccr-p7j6-phph)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-pccr-p7j6-phph"
    },
    "cewe-npm-cops": {
      blocked_all: true,
      reason: "Malicious code in cewe-npm-cops (npm) (GHSA-823q-q648-p3m6)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-823q-q648-p3m6"
    },
    "nms-dashboard-js": {
      blocked_all: true,
      reason: "Malicious code in nms-dashboard-js (npm) (GHSA-c3ch-m7ff-x6vx)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-c3ch-m7ff-x6vx"
    },
    "santana-baileys": {
      blocked_all: true,
      reason: "Malicious code in santana-baileys (npm) (GHSA-ff82-56mj-77vq)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-ff82-56mj-77vq"
    },
    "opencode-optimised-toolings": {
      blocked_all: true,
      reason: "Malicious code in opencode-optimised-toolings (npm) (GHSA-49cx-27xq-h4g2)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-49cx-27xq-h4g2"
    },
    "elephant-tusk-runner": {
      blocked_all: true,
      reason: "Malicious code in elephant-tusk-runner (npm) (GHSA-5cwc-j82p-mr9g)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-5cwc-j82p-mr9g"
    },
    "shadowx-fca": {
      blocked_all: true,
      reason: "Malicious code in shadowx-fca (npm) (GHSA-w857-mcfm-gm2p)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-w857-mcfm-gm2p"
    },
    "pilgrimage-portal-client": {
      blocked_all: true,
      reason: "Malicious code in pilgrimage-portal-client (npm) (GHSA-r69p-2jjg-vh25)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-r69p-2jjg-vh25"
    },
    "poc-ch4rlygr": {
      blocked_all: true,
      reason: "Malicious code in poc-ch4rlygr (npm) (GHSA-jh29-j9hv-jp8j)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-jh29-j9hv-jp8j"
    },
    "merchantweb-lang-cookie-reset": {
      blocked_all: true,
      reason: "Malicious code in merchantweb-lang-cookie-reset (npm) (GHSA-5vjj-p6vh-456m)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-5vjj-p6vh-456m"
    },
    "gpt-terminal-cli": {
      blocked_all: true,
      reason: "Malicious code in gpt-terminal-cli (npm) (GHSA-x33m-j487-w85g)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-x33m-j487-w85g"
    },
    "content-common": {
      blocked_all: true,
      reason: "Malicious code in content-common (npm) (GHSA-2g4v-xv3f-9gv3)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-2g4v-xv3f-9gv3"
    },
    "lib-frontsga": {
      blocked_all: true,
      reason: "Malicious code in lib-frontsga (npm) (GHSA-gjrm-rjj5-9x2v)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-gjrm-rjj5-9x2v"
    },
    "express-chai": {
      blocked_all: true,
      reason: "Malicious code in express-chai (npm) (GHSA-539g-57mc-c49q)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-539g-57mc-c49q"
    },
    "dbk-ui-forms": {
      blocked_all: true,
      reason: "Malicious code in dbk-ui-forms (npm) (GHSA-6xhg-r9f8-79h9)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-6xhg-r9f8-79h9"
    },
    "aitable-workflow-server": {
      blocked_all: true,
      reason: "Malicious code in aitable-workflow-server (npm) (GHSA-558j-7qm6-gmf2)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-558j-7qm6-gmf2"
    },
    "ach-detail": {
      blocked_all: true,
      reason: "Malicious code in ach-detail (npm) (GHSA-j5q4-grmc-8327)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-j5q4-grmc-8327"
    },
    "consumerweb-creditcollection": {
      blocked_all: true,
      reason: "Malicious code in consumerweb-creditcollection (npm) (GHSA-qvf2-x454-7637)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-qvf2-x454-7637"
    },
    "connect-contingency": {
      blocked_all: true,
      reason: "Malicious code in connect-contingency (npm) (GHSA-jc5p-q2fg-2r77)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-jc5p-q2fg-2r77"
    },
    "commonweb-balance": {
      blocked_all: true,
      reason: "Malicious code in commonweb-balance (npm) (GHSA-h829-pq72-xf4j)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-h829-pq72-xf4j"
    },
    "@ks-video/kwai-player-web": {
      blocked_all: true,
      reason: "Malicious code in @ks-video/kwai-player-web (npm) (GHSA-px7p-gw96-h3c9)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-px7p-gw96-h3c9"
    },
    "@junyoung-kim/reins": {
      blocked_all: true,
      reason: "Malicious code in @junyoung-kim/reins (npm) (GHSA-785q-v8jw-hfj2)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-785q-v8jw-hfj2"
    },
    "@itsreduxtm/unpkg-xss-test": {
      blocked_all: true,
      reason: "Malicious code in @itsreduxtm/unpkg-xss-test (npm) (GHSA-x3q4-9v45-gphv)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-x3q4-9v45-gphv"
    },
    "@cy4dev/cydemo-bg-color": {
      blocked_all: true,
      reason: "Malicious code in @cy4dev/cydemo-bg-color (npm) (GHSA-p8f6-3vxc-6r75)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-p8f6-3vxc-6r75"
    },
    "@ch4acko3/frontal-lobe": {
      blocked_all: true,
      reason: "Malicious code in @ch4acko3/frontal-lobe (npm) (GHSA-m8jr-68xh-8qp9)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-m8jr-68xh-8qp9"
    },
    "@avi892nash/aegis-grid-runner": {
      blocked_all: true,
      reason: "Malicious code in @avi892nash/aegis-grid-runner (npm) (GHSA-w7r2-hmcm-cv9x)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-w7r2-hmcm-cv9x"
    },
    "@united-airlines-org/atmos-design-system": {
      blocked_all: true,
      reason: "Malicious code in @united-airlines-org/atmos-design-system (npm) (GHSA-9gxh-qrf3-h8h2)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-9gxh-qrf3-h8h2"
    },
    velabuild: {
      blocked_all: true,
      reason: "Malware in velabuild (GHSA-q7w3-723m-252j)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-q7w3-723m-252j"
    },
    rdfxvela: {
      blocked_all: true,
      reason: "Malware in rdfxvela (GHSA-7485-r458-jppf)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-7485-r458-jppf"
    },
    "rdfxvela-build": {
      blocked_all: true,
      reason: "Malware in rdfxvela-build (GHSA-jw4p-5x7w-fcm4)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-jw4p-5x7w-fcm4"
    },
    "tailwindcss-hide-scrollbar": {
      blocked_all: true,
      reason: "Malware in tailwindcss-hide-scrollbar (GHSA-rvh2-7968-hpfx)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-rvh2-7968-hpfx"
    },
    "sui-graphql-client": {
      blocked_all: true,
      reason: "Malware in sui-graphql-client (GHSA-3xg5-x743-4fjc)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-3xg5-x743-4fjc"
    },
    "sui-migration-audit-cli": {
      blocked_all: true,
      reason: "Malware in sui-migration-audit-cli (GHSA-h2cr-h9m7-mxg3)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-h2cr-h9m7-mxg3"
    },
    "sui-migration-audit-rules": {
      blocked_all: true,
      reason: "Malware in sui-migration-audit-rules (GHSA-f9p8-c2qh-w7cm)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-f9p8-c2qh-w7cm"
    },
    "move-bcs-codec": {
      blocked_all: true,
      reason: "Malware in move-bcs-codec (GHSA-3v7v-gr39-jf7v)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-3v7v-gr39-jf7v"
    },
    "svelte-visual-map": {
      blocked_all: true,
      reason: "Malware in svelte-visual-map (GHSA-mx36-p8c2-88gg)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-mx36-p8c2-88gg"
    },
    "streak-cache-map": {
      blocked_all: true,
      reason: "Malware in streak-cache-map (GHSA-wpj4-68w6-w2fh)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-wpj4-68w6-w2fh"
    },
    "devplatform-vite-plugin-gle": {
      blocked_all: true,
      reason: "Malware in devplatform-vite-plugin-gle (GHSA-8ph7-fh8m-9rwc)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-8ph7-fh8m-9rwc"
    },
    "tinkoff-codeceptjs-storyshots-alpha": {
      blocked_all: true,
      reason: "Malware in tinkoff-codeceptjs-storyshots-alpha (GHSA-fhqv-jjj8-w6wh)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-fhqv-jjj8-w6wh"
    },
    "devplatform-spa-plugin-error-boundary": {
      blocked_all: true,
      reason: "Malware in devplatform-spa-plugin-error-boundary (GHSA-2557-fmc3-p2q7)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-2557-fmc3-p2q7"
    },
    "tui-react-tooltip": {
      blocked_all: true,
      reason: "Malware in tui-react-tooltip (GHSA-m4vv-cf6m-g553)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-m4vv-cf6m-g553"
    },
    "devplatform-jscodeshift-utils": {
      blocked_all: true,
      reason: "Malware in devplatform-jscodeshift-utils (GHSA-mfcc-hqhf-5g3f)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-mfcc-hqhf-5g3f"
    },
    "statist-statist-core": {
      blocked_all: true,
      reason: "Malware in statist-statist-core (GHSA-j362-x54r-m764)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-j362-x54r-m764"
    },
    "devplatform-data-table": {
      blocked_all: true,
      reason: "Malware in devplatform-data-table (GHSA-f95m-xx4x-37cx)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-f95m-xx4x-37cx"
    },
    "tinkoff-boxy-desktop-two-panel-right-image": {
      blocked_all: true,
      reason: "Malware in tinkoff-boxy-desktop-two-panel-right-image (GHSA-23c2-qcrv-2gc9)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-23c2-qcrv-2gc9"
    },
    "tsihealth-client": {
      blocked_all: true,
      reason: "Malicious code in tsihealth-client (npm) (GHSA-22gm-pcxq-h54x)",
      date: "2026-08-06",
      advisory: "https://github.com/advisories/GHSA-22gm-pcxq-h54x"
    },
    "sme-rko-finance-front-payments-domain": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-payments-domain (npm) (GHSA-pmc8-g84p-3x77)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-pmc8-g84p-3x77"
    },
    "sme-rko-finance-front-payments-feed-display-list": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-payments-feed-display-list (npm) (GHSA-6cqr-56m6-wch6)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-6cqr-56m6-wch6"
    },
    "sme-rko-finance-front-payments-feed-display-list-impl": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-payments-feed-display-list-impl (npm) (GHSA-4wvm-26xh-fgjw)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-4wvm-26xh-fgjw"
    },
    "sme-rko-finance-front-operations-shared": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-shared (npm) (GHSA-pp5j-rx3f-4m7x)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-pp5j-rx3f-4m7x"
    },
    "sme-rko-finance-front-payments-feed-adapter": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-payments-feed-adapter (npm) (GHSA-xprg-ffr4-2rw4)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-xprg-ffr4-2rw4"
    },
    "sme-rko-finance-front-payments-currency-payment-actions-operations-repeat-models": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-payments-currency-payment-actions-operations-repeat-models (npm) (GHSA-6hmr-8896-mrmx)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-6hmr-8896-mrmx"
    },
    "sme-rko-finance-front-payments-classic-payment-actions-operations-repeat-impl": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-payments-classic-payment-actions-operations-repeat-impl (npm) (GHSA-8q7h-xvgq-ff27)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-8q7h-xvgq-ff27"
    },
    "sme-rko-finance-front-payments-currency-payment-domain": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-payments-currency-payment-domain (npm) (GHSA-pwjh-hjvr-rv33)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-pwjh-hjvr-rv33"
    },
    "sme-rko-finance-front-payments-classic-payment-actions-operations-repeat-models": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-payments-classic-payment-actions-operations-repeat-models (npm) (GHSA-xfv4-g237-3qv8)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-xfv4-g237-3qv8"
    },
    "titan-exchange-shared-permissions": {
      blocked_all: true,
      reason: "Malicious code in titan-exchange-shared-permissions (npm) (GHSA-8qhv-45mq-rp4v)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-8qhv-45mq-rp4v"
    },
    "sme-rko-finance-front-payments-currency-payment-actions-operations-repeat-impl": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-payments-currency-payment-actions-operations-repeat-impl (npm) (GHSA-85v5-vfj6-7hw8)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-85v5-vfj6-7hw8"
    },
    "sme-rko-finance-front-operations-widget-models": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-widget-models (npm) (GHSA-gpvf-x5gg-r5cv)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-gpvf-x5gg-r5cv"
    },
    "sme-rko-finance-front-payment-registers-operations-domain": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-payment-registers-operations-domain (npm) (GHSA-vrgq-5852-3299)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-vrgq-5852-3299"
    },
    "sme-rko-finance-front-operations-widget-impl": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-widget-impl (npm) (GHSA-2phg-c6vf-892f)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-2phg-c6vf-892f"
    },
    "sme-rko-finance-front-payments-allowed-tariffs-filter": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-payments-allowed-tariffs-filter (npm) (GHSA-mp53-hghj-9r7p)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-mp53-hghj-9r7p"
    },
    "sme-rko-finance-front-operations-widget-domain": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-widget-domain (npm) (GHSA-q26r-96fx-86h6)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-q26r-96fx-86h6"
    },
    "sme-rko-finance-front-operations-tax": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-tax (npm) (GHSA-p2hc-6684-r35c)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-p2hc-6684-r35c"
    },
    "sme-rko-finance-front-operations-special-payments": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-special-payments (npm) (GHSA-28cp-6vcg-8fhv)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-28cp-6vcg-8fhv"
    },
    "sme-rko-finance-front-operations-overnight": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-overnight (npm) (GHSA-c9vg-pfhf-qxw9)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-c9vg-pfhf-qxw9"
    },
    "sme-rko-finance-front-operations-providers": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-providers (npm) (GHSA-cg6q-c6gh-62q2)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-cg6q-c6gh-62q2"
    },
    "sme-rko-finance-front-operations-penalty": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-penalty (npm) (GHSA-h56m-2x6r-3fx2)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-h56m-2x6r-3fx2"
    },
    "sme-rko-finance-front-operations-pegasus": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-pegasus (npm) (GHSA-6fvh-4vgq-9765)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-6fvh-4vgq-9765"
    },
    "sme-rko-finance-front-operations-other": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-other (npm) (GHSA-xqr4-4gx9-7w24)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-xqr4-4gx9-7w24"
    },
    "sme-rko-finance-front-operations-notifications-models": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-notifications-models (npm) (GHSA-35pp-f297-w386)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-35pp-f297-w386"
    },
    "sme-rko-finance-front-operations-holding-domain": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-holding-domain (npm) (GHSA-wm7f-4h9v-m4mm)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-wm7f-4h9v-m4mm"
    },
    "sme-rko-finance-front-operations-notifications-impl": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-notifications-impl (npm) (GHSA-45vf-qpf8-q2pq)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-45vf-qpf8-q2pq"
    },
    "sme-rko-finance-front-operations-income": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-income (npm) (GHSA-6m9x-xq34-wgvq)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-6m9x-xq34-wgvq"
    },
    "map-streak-kit": {
      blocked_all: true,
      reason: "Malicious code in map-streak-kit (npm) (GHSA-2fcq-4c2w-gvm3)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-2fcq-4c2w-gvm3"
    },
    "sme-rko-finance-front-operations-feed-impl": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-feed-impl (npm) (GHSA-j2hm-7vph-3whg)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-j2hm-7vph-3whg"
    },
    "sme-rko-finance-front-operations-feed-models": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-feed-models (npm) (GHSA-52qg-7wfr-wvgx)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-52qg-7wfr-wvgx"
    },
    "sme-rko-finance-front-operations-domain": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-domain (npm) (GHSA-4rj4-828w-hv35)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-4rj4-828w-hv35"
    },
    "sme-rko-finance-front-operations-fee": {
      blocked_all: true,
      reason: "Malicious code in sme-rko-finance-front-operations-fee (npm) (GHSA-ffh6-w4x4-2j5q)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-ffh6-w4x4-2j5q"
    },
    "localization-fixer": {
      blocked_all: true,
      reason: "Malicious code in localization-fixer (npm) (GHSA-744p-7qm5-8wpj)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-744p-7qm5-8wpj"
    },
    "@coralxyz/anchor": {
      blocked_all: true,
      reason: "Malicious code in @coralxyz/anchor (npm) (GHSA-hhj6-h3rr-qc2j)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-hhj6-h3rr-qc2j"
    },
    "@rbx-ts/services": {
      blocked_all: true,
      reason: "Malicious code in @rbx-ts/services (npm) (GHSA-2846-4m8r-rvv5)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-2846-4m8r-rvv5"
    },
    "modern-localization": {
      blocked_all: true,
      reason: "Malicious code in modern-localization (npm) (GHSA-qf2g-q6rj-77q5)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-qf2g-q6rj-77q5"
    },
    "w-screenctl": {
      blocked_all: true,
      reason: "Malicious code in w-screenctl (npm) (GHSA-38f4-gq4r-6vwp)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-38f4-gq4r-6vwp"
    },
    "aclade-agent": {
      blocked_all: true,
      reason: "Malicious code in aclade-agent (npm) (GHSA-45jx-7hwc-cx43)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-45jx-7hwc-cx43"
    },
    "agenthub-ai": {
      blocked_all: true,
      reason: "Malicious code in agenthub-ai (npm) (GHSA-hw95-mqx2-4pg5)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-hw95-mqx2-4pg5"
    },
    "@decido/backend-core": {
      blocked_all: true,
      reason: "Malicious code in @decido/backend-core (npm) (GHSA-32mh-mxcj-9p4g)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-32mh-mxcj-9p4g"
    },
    "@depup/nuxt": {
      blocked_all: true,
      reason: "Malicious code in @depup/nuxt (npm) (GHSA-jgpp-gq7g-rgrr)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-jgpp-gq7g-rgrr"
    },
    "@depup/memfs": {
      blocked_all: true,
      reason: "Malicious code in @depup/memfs (npm) (GHSA-6m4q-wxhf-p7rw)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-6m4q-wxhf-p7rw"
    },
    "@depup/aws-sdk__credential-provider-process": {
      blocked_all: true,
      reason: "Malicious code in @depup/aws-sdk__credential-provider-process (npm) (GHSA-f2wr-82xc-8pmq)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-f2wr-82xc-8pmq"
    },
    "streak-map-kit": {
      blocked_all: true,
      reason: "Malicious code in streak-map-kit (npm) (GHSA-qjg3-27xw-6xvr)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-qjg3-27xw-6xvr"
    },
    "@nestjs-passport/jwt": {
      blocked_all: true,
      reason: "Malicious code in @nestjs-passport/jwt (npm) (GHSA-h677-7mjr-8f76)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-h677-7mjr-8f76"
    },
    "ts-utility-plus": {
      blocked_all: true,
      reason: "Malicious code in ts-utility-plus (npm) (GHSA-32pr-r98g-6jmq)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-32pr-r98g-6jmq"
    },
    "hardhat-cap": {
      blocked_all: true,
      reason: "Malicious code in hardhat-cap (npm) (GHSA-hxmr-mqp4-pfpx)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-hxmr-mqp4-pfpx"
    },
    "@mrbenty8jf1p9y5/oidc-bind-canary": {
      blocked_all: true,
      reason: "Malicious code in @mrbenty8jf1p9y5/oidc-bind-canary (npm) (GHSA-6frr-644f-4r3j)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-6frr-644f-4r3j"
    },
    "@depup/astro": {
      blocked_all: true,
      reason: "Malicious code in @depup/astro (npm) (GHSA-6pqf-9w43-mrp4)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-6pqf-9w43-mrp4"
    },
    "@catamania/front-components": {
      blocked_all: true,
      reason: "Malicious code in @catamania/front-components (npm) (GHSA-j897-68x3-2658)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-j897-68x3-2658"
    },
    "svelte-map-visual": {
      blocked_all: true,
      reason: "Malware in svelte-map-visual (GHSA-5qqf-5c4c-p53q)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-5qqf-5c4c-p53q"
    },
    "svelte-cache-kit": {
      blocked_all: true,
      reason: "Malware in svelte-cache-kit (GHSA-9qqc-qrf8-gp8j)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-9qqc-qrf8-gp8j"
    },
    "@lambda-platform/lambda-vue": {
      blocked_all: true,
      reason: "Malware in @lambda-platform/lambda-vue (GHSA-jm85-g3fj-922w)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-jm85-g3fj-922w"
    },
    "tailwindcss-motion-advanced": {
      blocked_all: true,
      reason: "Malicious code in tailwindcss-motion-advanced (npm) (GHSA-7p82-x6rm-hphv)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-7p82-x6rm-hphv"
    },
    "dolyame-ui-tableinline": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-tableinline (npm) (GHSA-vj97-3mjp-3ggc)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-vj97-3mjp-3ggc"
    },
    "dolyame-ui-tabslayout": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-tabslayout (npm) (GHSA-h8wx-r33x-9pxx)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-h8wx-r33x-9pxx"
    },
    yakuza0: {
      blocked_all: true,
      reason: "Malicious code in yakuza0 (npm) (GHSA-j3c6-qq5r-wp79)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-j3c6-qq5r-wp79"
    },
    "platform-ui-colors": {
      blocked_all: true,
      reason: "Malicious code in platform-ui-colors (npm) (GHSA-p3jx-3fvm-5297)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-p3jx-3fvm-5297"
    },
    "dolyame-ui-progressline": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-progressline (npm) (GHSA-8983-87j9-966h)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-8983-87j9-966h"
    },
    "dolyame-ui-selectaccount": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-selectaccount (npm) (GHSA-9ccv-c933-88f3)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-9ccv-c933-88f3"
    },
    "dolyame-ui-memoizeweak": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-memoizeweak (npm) (GHSA-453m-cmgf-pp2m)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-453m-cmgf-pp2m"
    },
    "dolyame-ui-overridestyles": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-overridestyles (npm) (GHSA-m89w-mm69-583c)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-m89w-mm69-583c"
    },
    "dolyame-ui-sortablelist": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-sortablelist (npm) (GHSA-m88f-xr4q-28vm)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-m88f-xr4q-28vm"
    },
    "dolyame-ui-inputtag": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-inputtag (npm) (GHSA-gx3q-hwq5-v832)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-gx3q-hwq5-v832"
    },
    "dolyame-ui-mediainfohoc": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-mediainfohoc (npm) (GHSA-8q38-55jh-57j5)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-8q38-55jh-57j5"
    },
    "dolyame-ui-tablemobile": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-tablemobile (npm) (GHSA-5x2p-c62p-xg8q)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-5x2p-c62p-xg8q"
    },
    "dolyame-ui-inputsearchtagged": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-inputsearchtagged (npm) (GHSA-x6gv-rr9x-8gh4)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-x6gv-rr9x-8gh4"
    },
    "dolyame-ui-popupcarousel": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-popupcarousel (npm) (GHSA-j84x-mpxc-246j)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-j84x-mpxc-246j"
    },
    "dolyame-ui-pageheader": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-pageheader (npm) (GHSA-m9j5-hq2x-6cm7)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-m9j5-hq2x-6cm7"
    },
    "dolyame-ui-postcssconfig": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-postcssconfig (npm) (GHSA-c25q-g4g2-4ww8)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-c25q-g4g2-4ww8"
    },
    "dolyame-ui-inputtools": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-inputtools (npm) (GHSA-8x86-rh4c-m9xf)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-8x86-rh4c-m9xf"
    },
    "dolyame-ui-scrollblock": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-scrollblock (npm) (GHSA-46pg-535x-6xgv)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-46pg-535x-6xgv"
    },
    "dolyame-ui-postcsscustomproperties": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-postcsscustomproperties (npm) (GHSA-6p4q-px92-w3w6)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-6p4q-px92-w3w6"
    },
    "dolyame-ui-inputtime": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-inputtime (npm) (GHSA-v55h-m4jc-mhgh)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-v55h-m4jc-mhgh"
    },
    "dolyame-ui-noindex": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-noindex (npm) (GHSA-rqrq-p5gm-vq8w)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-rqrq-p5gm-vq8w"
    },
    "dolyame-ui-inputsecure": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-inputsecure (npm) (GHSA-3qg5-j2pg-gxwg)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-3qg5-j2pg-gxwg"
    },
    "dolyame-ui-inputsearch": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-inputsearch (npm) (GHSA-9gfm-g4gc-wpmm)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-9gfm-g4gc-wpmm"
    },
    "dolyame-ui-inputphone": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-inputphone (npm) (GHSA-6r68-r3f6-pmm7)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-6r68-r3f6-pmm7"
    },
    "dolyame-ui-inputdate": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-inputdate (npm) (GHSA-5g2j-hj85-vphj)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-5g2j-hj85-vphj"
    },
    "dolyame-ui-inputmoney": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-inputmoney (npm) (GHSA-h8f3-rr3j-wr6w)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-h8f3-rr3j-wr6w"
    },
    "dolyame-ui-cardlogo": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-cardlogo (npm) (GHSA-689h-gvpf-9mh5)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-689h-gvpf-9mh5"
    },
    "dolyame-ui-collapseblock": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-collapseblock (npm) (GHSA-x579-hcjj-4fp2)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-x579-hcjj-4fp2"
    },
    "dolyame-ui-checkablegroup": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-checkablegroup (npm) (GHSA-hw66-qprf-ggq5)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-hw66-qprf-ggq5"
    },
    "dolyame-ui-clickoutsidehoc": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-clickoutsidehoc (npm) (GHSA-93pw-3cqq-jx36)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-93pw-3cqq-jx36"
    },
    "dolyame-ui-buttonstore": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-buttonstore (npm) (GHSA-p5qq-7xpw-7qrx)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-p5qq-7xpw-7qrx"
    },
    "dolyame-ui-dataqa": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-dataqa (npm) (GHSA-p7c9-vmrf-f5wm)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-p7c9-vmrf-f5wm"
    },
    "dolyame-ui-datatable": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-datatable (npm) (GHSA-56w9-6w54-38cx)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-56w9-6w54-38cx"
    },
    "dolyame-boxy-independent-bnpl-product-grid": {
      blocked_all: true,
      reason: "Malicious code in dolyame-boxy-independent-bnpl-product-grid (npm) (GHSA-6m88-7jqj-885x)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-6m88-7jqj-885x"
    },
    "dolyame-ui-focusstatehoc": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-focusstatehoc (npm) (GHSA-2q5m-3qcg-vf7g)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-2q5m-3qcg-vf7g"
    },
    "dolyame-ui-contextmenu": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-contextmenu (npm) (GHSA-chcw-cjqg-q9hq)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-chcw-cjqg-q9hq"
    },
    "dolyame-ui-controlgroup": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-controlgroup (npm) (GHSA-2vcv-2qxw-jrx5)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-2vcv-2qxw-jrx5"
    },
    "dolyame-boxy-independent-bnpl-faq": {
      blocked_all: true,
      reason: "Malicious code in dolyame-boxy-independent-bnpl-faq (npm) (GHSA-p8v6-j29q-4m26)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-p8v6-j29q-4m26"
    },
    "devplatform-stylelint-config": {
      blocked_all: true,
      reason: "Malicious code in devplatform-stylelint-config (npm) (GHSA-8m84-9859-q829)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-8m84-9859-q829"
    },
    "dolyame-ui-inputrange": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-inputrange (npm) (GHSA-v43c-jqwv-832q)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-v43c-jqwv-832q"
    },
    "dolyame-ui-inputcard": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-inputcard (npm) (GHSA-ccj5-x7h8-wqq3)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-ccj5-x7h8-wqq3"
    },
    "dolyame-ui-inlineedit": {
      blocked_all: true,
      reason: "Malicious code in dolyame-ui-inlineedit (npm) (GHSA-f2x5-grg7-j57q)",
      date: "2026-08-07",
      advisory: "https://github.com/advisories/GHSA-f2x5-grg7-j57q"
    },
    "statist-browser-typed-client-eventea.projects.pwakasko": {
      blocked_all: true,
      reason: "Malware in statist-browser-typed-client-eventea.projects.pwakasko (GHSA-4fvg-gp6j-v2qm)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-4fvg-gp6j-v2qm"
    },
    "statist-browser-typed-client-eventea.projects.tdevice": {
      blocked_all: true,
      reason: "Malware in statist-browser-typed-client-eventea.projects.tdevice (GHSA-rrvf-xjx8-gmjh)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-rrvf-xjx8-gmjh"
    },
    "statist-browser-typed-client-eventea.projects.pwahelp": {
      blocked_all: true,
      reason: "Malware in statist-browser-typed-client-eventea.projects.pwahelp (GHSA-wvc6-wpjx-jgx8)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-wvc6-wpjx-jgx8"
    },
    "statist-browser-typed-client-eventea.projects.tdeal": {
      blocked_all: true,
      reason: "Malware in statist-browser-typed-client-eventea.projects.tdeal (GHSA-966c-8786-6cx7)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-966c-8786-6cx7"
    },
    "statist-browser-typed-client-eventea.projects.pwainsurance": {
      blocked_all: true,
      reason: "Malware in statist-browser-typed-client-eventea.projects.pwainsurance (GHSA-hm23-rg8r-xhmg)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-hm23-rg8r-xhmg"
    },
    "statist-browser-typed-client-eventea.projects.pwafamily": {
      blocked_all: true,
      reason: "Malware in statist-browser-typed-client-eventea.projects.pwafamily (GHSA-qmv3-2w4r-rwwq)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-qmv3-2w4r-rwwq"
    },
    "bnpl-blocks-desktop-bnpl-anchor-title": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-desktop-bnpl-anchor-title (GHSA-55g4-q5c3-783j)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-55g4-q5c3-783j"
    },
    "test-noexist-xyz-99": {
      blocked_all: true,
      reason: "Malware in test-noexist-xyz-99 (GHSA-682j-6frp-w6rq)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-682j-6frp-w6rq"
    },
    "specials-resources-server": {
      blocked_all: true,
      reason: "Malware in specials-resources-server (GHSA-9wh2-7j4m-r43r)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-9wh2-7j4m-r43r"
    },
    "svelte-kit-cache": {
      blocked_all: true,
      reason: "Malware in svelte-kit-cache (GHSA-9fg7-rqp2-7hpg)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-9fg7-rqp2-7hpg"
    },
    "svelte-streak-kit": {
      blocked_all: true,
      reason: "Malware in svelte-streak-kit (GHSA-2w6v-q693-8jjm)",
      date: "2026-08-08",
      advisory: "https://github.com/advisories/GHSA-2w6v-q693-8jjm"
    },
    "simple-date-formatter-new-9": {
      blocked_all: true,
      reason: "Malicious code in simple-date-formatter-new-9 (npm) (GHSA-fq7m-frv3-2w4v)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-fq7m-frv3-2w4v"
    },
    tokocrytodev: {
      blocked_all: true,
      reason: "Malicious code in tokocrytodev (npm) (GHSA-m482-gfg4-jcp7)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-m482-gfg4-jcp7"
    },
    "postcss-initial-provider": {
      blocked_all: true,
      reason: "Malicious code in postcss-initial-provider (npm) (GHSA-9qww-697m-3rg3)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-9qww-697m-3rg3"
    },
    "simple-date-formatter-new-10": {
      blocked_all: true,
      reason: "Malicious code in simple-date-formatter-new-10 (npm) (GHSA-wgv9-74pq-hwh9)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-wgv9-74pq-hwh9"
    },
    cryptostock: {
      blocked_all: true,
      reason: "Malicious code in cryptostock (npm) (GHSA-vxm9-fcc8-7337)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-vxm9-fcc8-7337"
    },
    "hex-encode-utils": {
      blocked_all: true,
      reason: "Malicious code in hex-encode-utils (npm) (GHSA-2p54-jrq3-p4p9)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-2p54-jrq3-p4p9"
    },
    "env-local": {
      blocked_all: true,
      reason: "Malicious code in env-local (npm) (GHSA-r3pr-mmg7-gr2j)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-r3pr-mmg7-gr2j"
    },
    "chai-jsonss": {
      blocked_all: true,
      reason: "Malicious code in chai-jsonss (npm) (GHSA-xp6h-f5rv-v8fp)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-xp6h-f5rv-v8fp"
    },
    "@noobaihome/amis-uni-area-widget": {
      blocked_all: true,
      reason: "Malicious code in @noobaihome/amis-uni-area-widget (npm) (GHSA-932g-6p3v-rp3w)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-932g-6p3v-rp3w"
    },
    "@rblxts/services": {
      blocked_all: true,
      reason: "Malicious code in @rblxts/services (npm) (GHSA-x6xv-2jr9-4pc5)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-x6xv-2jr9-4pc5"
    },
    "@kuperka/chainguard-sdk": {
      blocked_all: true,
      reason: "Malicious code in @kuperka/chainguard-sdk (npm) (GHSA-x3c3-qwj8-qfpc)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-x3c3-qwj8-qfpc"
    },
    "@noobaihome/amis-simple-area-widget": {
      blocked_all: true,
      reason: "Malicious code in @noobaihome/amis-simple-area-widget (npm) (GHSA-jprv-2653-h4xc)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-jprv-2653-h4xc"
    },
    "@ssgw/icon": {
      blocked_all: true,
      reason: "Malicious code in @ssgw/icon (npm) (GHSA-v5mx-v28f-r24j)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-v5mx-v28f-r24j"
    },
    newtun: {
      blocked_all: true,
      reason: "Malicious code in newtun (npm) (GHSA-3xv7-433h-78x9)",
      date: "2026-08-11",
      advisory: "https://github.com/advisories/GHSA-3xv7-433h-78x9"
    },
    ghazaly: {
      blocked_all: true,
      reason: "Malware in ghazaly (GHSA-g62q-mq3x-765x)",
      date: "2026-08-11",
      advisory: "https://github.com/advisories/GHSA-g62q-mq3x-765x"
    },
    dependencyfsdsfdsfg: {
      blocked_all: true,
      reason: "Malware in dependencyfsdsfdsfg (GHSA-6xhq-px35-hhv9)",
      date: "2026-08-11",
      advisory: "https://github.com/advisories/GHSA-6xhq-px35-hhv9"
    },
    "fetch-runtime": {
      blocked_all: true,
      reason: "Malware in fetch-runtime (GHSA-3hqj-592v-g33j)",
      date: "2026-08-11",
      advisory: "https://github.com/advisories/GHSA-3hqj-592v-g33j"
    },
    "lines-columns": {
      blocked_all: true,
      reason: "Malware in lines-columns (GHSA-572q-x4v9-m474)",
      date: "2026-08-11",
      advisory: "https://github.com/advisories/GHSA-572q-x4v9-m474"
    },
    "@sqlite-labs/nodesql": {
      blocked_all: true,
      reason: "Malware in @sqlite-labs/nodesql (GHSA-86f7-qh62-pq7c)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-86f7-qh62-pq7c"
    },
    "@sqlite-labs/createsql": {
      blocked_all: true,
      reason: "Malware in @sqlite-labs/createsql (GHSA-qwqp-6xhg-jhhv)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-qwqp-6xhg-jhhv"
    },
    spoint: {
      blocked_all: true,
      reason: "Malware in spoint (GHSA-72h3-pwwh-68cx)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-72h3-pwwh-68cx"
    },
    "svelte-kit-streak": {
      blocked_all: true,
      reason: "Malware in svelte-kit-streak (GHSA-rc4p-g2mc-7w8h)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-rc4p-g2mc-7w8h"
    },
    "kit-map-streak": {
      blocked_all: true,
      reason: "Malware in kit-map-streak (GHSA-7wwj-2mjc-pmxq)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-7wwj-2mjc-pmxq"
    },
    "iconova-react": {
      blocked_all: true,
      reason: "Malware in iconova-react (GHSA-mvp5-cv38-rqfj)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-mvp5-cv38-rqfj"
    },
    "post-css-transfer": {
      blocked_all: true,
      reason: "Malware in post-css-transfer (GHSA-f5h9-q436-8chv)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-f5h9-q436-8chv"
    },
    "godot-kit": {
      blocked_all: true,
      reason: "Malware in godot-kit (GHSA-j7m9-r9h4-rfw8)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-j7m9-r9h4-rfw8"
    },
    runtimekit: {
      blocked_all: true,
      reason: "Malware in runtimekit (GHSA-v6qq-vq5x-rmxf)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-v6qq-vq5x-rmxf"
    },
    "tailwind-elements-ui": {
      blocked_all: true,
      reason: "Malware in tailwind-elements-ui (GHSA-mmpq-4w6p-rwg2)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-mmpq-4w6p-rwg2"
    },
    fsbrowse: {
      blocked_all: true,
      reason: "Malware in fsbrowse (GHSA-pvvh-h7rh-2c7g)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-pvvh-h7rh-2c7g"
    },
    "@sqlite-table/sql-creator": {
      blocked_all: true,
      reason: "Malware in @sqlite-table/sql-creator (GHSA-4hxf-37q3-vfxh)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-4hxf-37q3-vfxh"
    },
    "@sqlite-table/schema-generator": {
      blocked_all: true,
      reason: "Malware in @sqlite-table/schema-generator (GHSA-f86c-mf53-7934)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-f86c-mf53-7934"
    },
    "@sqlite-prime/nodesql": {
      blocked_all: true,
      reason: "Malware in @sqlite-prime/nodesql (GHSA-f348-mwv9-7p8h)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-f348-mwv9-7p8h"
    },
    "@sqlite-prime/createsql": {
      blocked_all: true,
      reason: "Malware in @sqlite-prime/createsql (GHSA-v49c-g99c-qvf9)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-v49c-g99c-qvf9"
    },
    "eth-library-utils": {
      blocked_all: true,
      reason: "Malware in eth-library-utils (GHSA-rp49-3975-7q6c)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-rp49-3975-7q6c"
    },
    "eth-library-toolkit": {
      blocked_all: true,
      reason: "Malware in eth-library-toolkit (GHSA-mqxc-259c-25w3)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-mqxc-259c-25w3"
    },
    "commonjs-assertion": {
      blocked_all: true,
      reason: "Malware in commonjs-assertion (GHSA-mfjj-4625-mpvr)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-mfjj-4625-mpvr"
    },
    "commonjs-assert": {
      blocked_all: true,
      reason: "Malware in commonjs-assert (GHSA-hcmm-fvc7-pjv3)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-hcmm-fvc7-pjv3"
    },
    "xerohub-discord-voice": {
      blocked_all: true,
      reason: "Malicious code in xerohub-discord-voice (npm) (GHSA-mppv-3p7f-3fmq)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-mppv-3p7f-3fmq"
    },
    "chai-tracker": {
      blocked_all: true,
      reason: "Malicious code in chai-tracker (npm) (GHSA-j2r4-fv2p-jjf8)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-j2r4-fv2p-jjf8"
    },
    "neverthrow-js": {
      blocked_all: true,
      reason: "Malicious code in neverthrow-js (npm) (GHSA-qpxw-hpjq-29wj)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-qpxw-hpjq-29wj"
    },
    "polymarket-stake-mathss": {
      blocked_all: true,
      reason: "Malicious code in polymarket-stake-mathss (npm) (GHSA-2qqg-9fjr-5mw9)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-2qqg-9fjr-5mw9"
    },
    "chai-as-promised-plus": {
      blocked_all: true,
      reason: "Malicious code in chai-as-promised-plus (npm) (GHSA-525m-456x-w57c)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-525m-456x-w57c"
    },
    "chai-as-deployer": {
      blocked_all: true,
      reason: "Malicious code in chai-as-deployer (npm) (GHSA-7qqp-m577-rp2w)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-7qqp-m577-rp2w"
    },
    "chai-as-map": {
      blocked_all: true,
      reason: "Malicious code in chai-as-map (npm) (GHSA-rx7j-9w2g-fvjf)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-rx7j-9w2g-fvjf"
    },
    "chai-as-format": {
      blocked_all: true,
      reason: "Malicious code in chai-as-format (npm) (GHSA-wpwv-ffg9-hmxr)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-wpwv-ffg9-hmxr"
    },
    "chai-as-bench": {
      blocked_all: true,
      reason: "Malicious code in chai-as-bench (npm) (GHSA-m5h5-5r2r-qw58)",
      date: "2026-08-10",
      advisory: "https://github.com/advisories/GHSA-m5h5-5r2r-qw58"
    },
    vxhjkseuiaqkb: {
      blocked_all: true,
      reason: "Malicious code in vxhjkseuiaqkb (npm) (GHSA-2qw7-9xxw-rx96)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-2qw7-9xxw-rx96"
    },
    skxcmwuncbg2: {
      blocked_all: true,
      reason: "Malicious code in skxcmwuncbg2 (npm) (GHSA-q832-gxg8-6r47)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-q832-gxg8-6r47"
    },
    testdgdbcsd: {
      blocked_all: true,
      reason: "Malicious code in testdgdbcsd (npm) (GHSA-f3pc-2866-vh84)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-f3pc-2866-vh84"
    },
    tesgfvbncsdbcv: {
      blocked_all: true,
      reason: "Malicious code in tesgfvbncsdbcv (npm) (GHSA-gh7p-8vpj-q8cg)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-gh7p-8vpj-q8cg"
    },
    ndmushdkeqe: {
      blocked_all: true,
      reason: "Malicious code in ndmushdkeqe (npm) (GHSA-p464-h76r-rj42)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-p464-h76r-rj42"
    },
    ndmxchdjxn2: {
      blocked_all: true,
      reason: "Malicious code in ndmxchdjxn2 (npm) (GHSA-274w-3vcj-jp83)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-274w-3vcj-jp83"
    },
    ndmfguyhoxc3: {
      blocked_all: true,
      reason: "Malicious code in ndmfguyhoxc3 (npm) (GHSA-82fg-ff39-hqp6)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-82fg-ff39-hqp6"
    },
    mn3sadkoiewu: {
      blocked_all: true,
      reason: "Malicious code in mn3sadkoiewu (npm) (GHSA-mp3h-jfj3-wr82)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-mp3h-jfj3-wr82"
    },
    mn2adskhweox: {
      blocked_all: true,
      reason: "Malicious code in mn2adskhweox (npm) (GHSA-6hmr-m2jx-83fm)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-6hmr-m2jx-83fm"
    },
    mjsdqwocvn: {
      blocked_all: true,
      reason: "Malicious code in mjsdqwocvn (npm) (GHSA-vpvw-v9vm-x468)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-vpvw-v9vm-x468"
    },
    mbxcnsuwgs1: {
      blocked_all: true,
      reason: "Malicious code in mbxcnsuwgs1 (npm) (GHSA-vg94-293q-3vwj)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-vg94-293q-3vwj"
    },
    mndsxcusiwlk1: {
      blocked_all: true,
      reason: "Malicious code in mndsxcusiwlk1 (npm) (GHSA-r76h-r7jm-887r)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-r76h-r7jm-887r"
    },
    mobiwaefhxc3: {
      blocked_all: true,
      reason: "Malicious code in mobiwaefhxc3 (npm) (GHSA-6rcc-gj62-rx6m)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-6rcc-gj62-rx6m"
    },
    mn4xcouzvhus: {
      blocked_all: true,
      reason: "Malicious code in mn4xcouzvhus (npm) (GHSA-cjhr-wxvm-qjvx)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-cjhr-wxvm-qjvx"
    },
    m3fdfocdoewn: {
      blocked_all: true,
      reason: "Malicious code in m3fdfocdoewn (npm) (GHSA-qjqg-87v3-xm2f)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-qjqg-87v3-xm2f"
    },
    m2fcsfyjkuxb: {
      blocked_all: true,
      reason: "Malicious code in m2fcsfyjkuxb (npm) (GHSA-8pf5-9qh7-qc5h)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-8pf5-9qh7-qc5h"
    },
    "@worrisome/reutil": {
      blocked_all: true,
      reason: "Malicious code in @worrisome/reutil (npm) (GHSA-2pgx-9rv6-xj93)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-2pgx-9rv6-xj93"
    },
    "redis-cookie-server": {
      blocked_all: true,
      reason: "Malware in redis-cookie-server (GHSA-jgx3-v64x-v2w5)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-jgx3-v64x-v2w5"
    },
    "eslint-prettier-js": {
      blocked_all: true,
      reason: "Malware in eslint-prettier-js (GHSA-fp43-fcrg-6w93)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-fp43-fcrg-6w93"
    },
    "generate-schema-ethers": {
      blocked_all: true,
      reason: "Malicious code in generate-schema-ethers (npm) (GHSA-f45j-cpvf-37vh)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-f45j-cpvf-37vh"
    },
    "fuels-typegen": {
      blocked_all: true,
      reason: "Malicious code in fuels-typegen (npm) (GHSA-4f4x-3qvc-wffh)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-4f4x-3qvc-wffh"
    },
    "npx-oob-package": {
      blocked_all: true,
      reason: "Malicious code in npx-oob-package (npm) (GHSA-2gqg-4mch-fmq5)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-2gqg-4mch-fmq5"
    },
    "grafeno-actions": {
      blocked_all: true,
      reason: "Malicious code in grafeno-actions (npm) (GHSA-rcj7-44gp-9983)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-rcj7-44gp-9983"
    },
    "generate-schema-viem": {
      blocked_all: true,
      reason: "Malicious code in generate-schema-viem (npm) (GHSA-rrqc-jj9x-2m46)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-rrqc-jj9x-2m46"
    },
    "verify-contract-viem": {
      blocked_all: true,
      reason: "Malicious code in verify-contract-viem (npm) (GHSA-wgc5-g8h3-3grx)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-wgc5-g8h3-3grx"
    },
    "verify-contract-ethers": {
      blocked_all: true,
      reason: "Malicious code in verify-contract-ethers (npm) (GHSA-7cgh-hfp8-2h8v)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-7cgh-hfp8-2h8v"
    },
    "com.db.autobahn.notification-center-electron": {
      blocked_all: true,
      reason: "Malicious code in com.db.autobahn.notification-center-electron (npm) (GHSA-q6wc-5f8x-wwwj)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-q6wc-5f8x-wwwj"
    },
    "cre-setup": {
      blocked_all: true,
      reason: "Malicious code in cre-setup (npm) (GHSA-85ff-72jm-25qf)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-85ff-72jm-25qf"
    },
    "fuels-core": {
      blocked_all: true,
      reason: "Malicious code in fuels-core (npm) (GHSA-w76m-93w4-w9vj)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-w76m-93w4-w9vj"
    },
    "autobahn-electron-probe": {
      blocked_all: true,
      reason: "Malicious code in autobahn-electron-probe (npm) (GHSA-8jx3-79xq-v4q4)",
      date: "2026-08-31",
      advisory: "https://github.com/advisories/GHSA-8jx3-79xq-v4q4"
    },
    "@lucideproxy/svg": {
      blocked_all: true,
      reason: "Malware in @lucideproxy/svg (GHSA-6j97-93gg-j7r8)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-6j97-93gg-j7r8"
    },
    "@fidzzhost/baileys": {
      blocked_all: true,
      reason: "Malware in @fidzzhost/baileys (GHSA-vc2v-c8j2-qxg9)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-vc2v-c8j2-qxg9"
    },
    cloudfcrxz: {
      blocked_all: true,
      reason: "Malware in cloudfcrxz (GHSA-p375-pmrj-262v)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-p375-pmrj-262v"
    },
    cloufcrxz: {
      blocked_all: true,
      reason: "Malware in cloufcrxz (GHSA-gxpc-36pf-vcrw)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-gxpc-36pf-vcrw"
    },
    "real-browser-plus": {
      blocked_all: true,
      reason: "Malware in real-browser-plus (GHSA-ffvr-gx62-j45m)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-ffvr-gx62-j45m"
    },
    "h2-codex": {
      blocked_all: true,
      reason: "Malware in h2-codex (GHSA-8h78-gfj3-qrp2)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-8h78-gfj3-qrp2"
    },
    h3client: {
      blocked_all: true,
      reason: "Malware in h3client (GHSA-89vf-5xgx-fhq7)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-89vf-5xgx-fhq7"
    },
    "brat-codex": {
      blocked_all: true,
      reason: "Malware in brat-codex (GHSA-63wg-22hx-h5q4)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-63wg-22hx-h5q4"
    },
    "h3-codex": {
      blocked_all: true,
      reason: "Malware in h3-codex (GHSA-w6m7-6jhr-mfjc)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-w6m7-6jhr-mfjc"
    },
    originaldevelopmentstelemetry: {
      blocked_all: true,
      reason: "Malware in originaldevelopmentstelemetry (GHSA-m8hq-jrvf-g8xm)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-m8hq-jrvf-g8xm"
    },
    gclassroom: {
      blocked_all: true,
      reason: "Malware in gclassroom (GHSA-6c25-pq89-3m9w)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-6c25-pq89-3m9w"
    },
    opiumbest: {
      blocked_all: true,
      reason: "Malware in opiumbest (GHSA-pwqr-5gcr-9rc4)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-pwqr-5gcr-9rc4"
    },
    quesoeducation: {
      blocked_all: true,
      reason: "Malware in quesoeducation (GHSA-mm9m-8q5p-fxwx)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-mm9m-8q5p-fxwx"
    },
    "grafeno-webhook": {
      blocked_all: true,
      reason: "Malicious code in grafeno-webhook (npm) (GHSA-477g-wmjw-mjmr)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-477g-wmjw-mjmr"
    },
    "grafeno-billing": {
      blocked_all: true,
      reason: "Malicious code in grafeno-billing (npm) (GHSA-8x3v-8vvh-78qm)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-8x3v-8vvh-78qm"
    },
    "grafeno-payments": {
      blocked_all: true,
      reason: "Malicious code in grafeno-payments (npm) (GHSA-wv93-x8h7-2vq7)",
      date: "2026-08-30",
      advisory: "https://github.com/advisories/GHSA-wv93-x8h7-2vq7"
    },
    "node-net-pool": {
      blocked_all: true,
      reason: "Malware in node-net-pool (GHSA-vm9g-mp9v-6q5p)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-vm9g-mp9v-6q5p"
    },
    supersignaturenature: {
      blocked_all: true,
      reason: "Malware in supersignaturenature (GHSA-x67q-xvcf-f2rw)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-x67q-xvcf-f2rw"
    },
    "manager-thedate": {
      blocked_all: true,
      reason: "Malware in manager-thedate (GHSA-3rww-v3p8-fw9p)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-3rww-v3p8-fw9p"
    },
    "htps-provider": {
      blocked_all: true,
      reason: "Malware in htps-provider (GHSA-gcqr-3vw3-7fqm)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-gcqr-3vw3-7fqm"
    },
    "nuvyra-marketplace-sdk": {
      blocked_all: true,
      reason: "Malware in nuvyra-marketplace-sdk (GHSA-rq2p-956p-32h6)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-rq2p-956p-32h6"
    },
    "axis-datagrid": {
      blocked_all: true,
      reason: "Malware in axis-datagrid (GHSA-7f64-56gx-r4cm)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-7f64-56gx-r4cm"
    },
    "vui-gateway": {
      blocked_all: true,
      reason: "Malware in vui-gateway (GHSA-69cq-ggff-w363)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-69cq-ggff-w363"
    },
    librastandardlib: {
      blocked_all: true,
      reason: "Malware in librastandardlib (GHSA-p943-f2p4-7xfx)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-p943-f2p4-7xfx"
    },
    "katal-logger": {
      blocked_all: true,
      reason: "Malware in katal-logger (GHSA-f2rf-58x5-5f6w)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-f2rf-58x5-5f6w"
    },
    "nx-app": {
      blocked_all: true,
      reason: "Malware in nx-app (GHSA-vmrp-3pwx-mj42)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-vmrp-3pwx-mj42"
    },
    "prm-bundles": {
      blocked_all: true,
      reason: "Malware in prm-bundles (GHSA-g57v-rj8p-j52h)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-g57v-rj8p-j52h"
    },
    "ux-metrics-client-interaction-subscriber": {
      blocked_all: true,
      reason: "Malware in ux-metrics-client-interaction-subscriber (GHSA-5v45-27j3-r52f)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-5v45-27j3-r52f"
    },
    "integration-amplitude": {
      blocked_all: true,
      reason: "Malware in integration-amplitude (GHSA-m5fj-7mm7-mg9p)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-m5fj-7mm7-mg9p"
    },
    tabbables: {
      blocked_all: true,
      reason: "Malware in tabbables (GHSA-4g4c-9232-9cwv)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-4g4c-9232-9cwv"
    },
    "framework-zero": {
      blocked_all: true,
      reason: "Malware in framework-zero (GHSA-c583-7r3r-x2p8)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-c583-7r3r-x2p8"
    },
    "oit-lib-oracle-util": {
      blocked_all: true,
      reason: "Malware in oit-lib-oracle-util (GHSA-rqm2-xgr5-297v)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-rqm2-xgr5-297v"
    },
    "paper-password-input": {
      blocked_all: true,
      reason: "Malware in paper-password-input (GHSA-p8fv-qch5-j7m9)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-p8fv-qch5-j7m9"
    },
    "payments-ui-services": {
      blocked_all: true,
      reason: "Malware in payments-ui-services (GHSA-jhxr-q6vp-9x3m)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-jhxr-q6vp-9x3m"
    },
    "loading-performance-instrumentation": {
      blocked_all: true,
      reason: "Malware in loading-performance-instrumentation (GHSA-hx7g-4f5f-7hq9)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-hx7g-4f5f-7hq9"
    },
    "npm-extension": {
      blocked_all: true,
      reason: "Malware in npm-extension (GHSA-f2fx-3q3p-v293)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-f2fx-3q3p-v293"
    },
    "mintel-taskbar": {
      blocked_all: true,
      reason: "Malware in mintel-taskbar (GHSA-x2qj-v4rx-3phv)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-x2qj-v4rx-3phv"
    },
    "jsb-adapter": {
      blocked_all: true,
      reason: "Malware in jsb-adapter (GHSA-69pf-x798-g22x)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-69pf-x798-g22x"
    },
    "gridster-coords": {
      blocked_all: true,
      reason: "Malware in gridster-coords (GHSA-fq5c-v7fm-mv99)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-fq5c-v7fm-mv99"
    },
    "jira-projects-backbone": {
      blocked_all: true,
      reason: "Malware in jira-projects-backbone (GHSA-8569-7m7w-7gf9)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-8569-7m7w-7gf9"
    },
    "alimama-minisite": {
      blocked_all: true,
      reason: "Malware in alimama-minisite (GHSA-q5h9-9fg7-xg2g)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-q5h9-9fg7-xg2g"
    },
    "data-value": {
      blocked_all: true,
      reason: "Malware in data-value (GHSA-rq5q-gpqf-p4vp)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-rq5q-gpqf-p4vp"
    },
    "qbo-ui-services": {
      blocked_all: true,
      reason: "Malware in qbo-ui-services (GHSA-j5hx-563p-m829)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-j5hx-563p-m829"
    },
    "calcite-web": {
      blocked_all: true,
      reason: "Malware in calcite-web (GHSA-fhxc-p24q-34ch)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-fhxc-p24q-34ch"
    },
    "firestore-lite": {
      blocked_all: true,
      reason: "Malware in firestore-lite (GHSA-q556-gm72-jcp7)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-q556-gm72-jcp7"
    },
    "amplitude-react-native": {
      blocked_all: true,
      reason: "Malware in amplitude-react-native (GHSA-wxgr-5x7q-cc86)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-wxgr-5x7q-cc86"
    },
    "ir-annuities-client-authentication-module": {
      blocked_all: true,
      reason: "Malware in ir-annuities-client-authentication-module (GHSA-4hpj-q7v8-mjf7)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-4hpj-q7v8-mjf7"
    },
    "analytics-web-client": {
      blocked_all: true,
      reason: "Malware in analytics-web-client (GHSA-5g5q-647h-8vv8)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-5g5q-647h-8vv8"
    },
    "confluence-create-content": {
      blocked_all: true,
      reason: "Malware in confluence-create-content (GHSA-j52x-8r24-hw6x)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-j52x-8r24-hw6x"
    },
    "amplitude-experiment": {
      blocked_all: true,
      reason: "Malware in amplitude-experiment (GHSA-4qr2-j5wh-f48g)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-4qr2-j5wh-f48g"
    },
    "mkt-ui-library": {
      blocked_all: true,
      reason: "Malware in mkt-ui-library (GHSA-w4pq-8q38-v8jr)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-w4pq-8q38-v8jr"
    },
    "confluence-editor": {
      blocked_all: true,
      reason: "Malware in confluence-editor (GHSA-cwcw-cv28-7jfm)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-cwcw-cv28-7jfm"
    },
    sentrykit: {
      blocked_all: true,
      reason: "Malware in sentrykit (GHSA-qq6h-882h-g88f)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-qq6h-882h-g88f"
    },
    "intuit-authz": {
      blocked_all: true,
      reason: "Malware in intuit-authz (GHSA-vp52-xxhf-m857)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-vp52-xxhf-m857"
    },
    "confluence-rest": {
      blocked_all: true,
      reason: "Malware in confluence-rest (GHSA-g338-wxvv-vg5q)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-g338-wxvv-vg5q"
    },
    "ring-device-settings-library": {
      blocked_all: true,
      reason: "Malware in ring-device-settings-library (GHSA-f4f7-3wwr-hxfx)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-f4f7-3wwr-hxfx"
    },
    "bui-react-10themes": {
      blocked_all: true,
      reason: "Malware in bui-react-10themes (GHSA-mj9w-ffv9-m8rf)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-mj9w-ffv9-m8rf"
    },
    "amplitude-session-replay": {
      blocked_all: true,
      reason: "Malware in amplitude-session-replay (GHSA-jvwx-f8cc-jjj8)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-jvwx-f8cc-jjj8"
    },
    "sycm-vendors": {
      blocked_all: true,
      reason: "Malware in sycm-vendors (GHSA-7h72-24vr-wrf6)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-7h72-24vr-wrf6"
    },
    "one-intuit-help-system-utils": {
      blocked_all: true,
      reason: "Malware in one-intuit-help-system-utils (GHSA-93c7-v93p-97cw)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-93c7-v93p-97cw"
    },
    "search-reservation": {
      blocked_all: true,
      reason: "Malware in search-reservation (GHSA-j5xq-g44w-jh7c)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-j5xq-g44w-jh7c"
    },
    "aura-instrumentation": {
      blocked_all: true,
      reason: "Malware in aura-instrumentation (GHSA-p4vf-c829-4m2m)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-p4vf-c829-4m2m"
    },
    "aws-blog": {
      blocked_all: true,
      reason: "Malware in aws-blog (GHSA-q8ww-mqrw-jq9q)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-q8ww-mqrw-jq9q"
    },
    "vs-modules": {
      blocked_all: true,
      reason: "Malware in vs-modules (GHSA-8hpw-v4hq-pg99)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-8hpw-v4hq-pg99"
    },
    mfakit: {
      blocked_all: true,
      reason: "Malicious code in mfakit (npm) (GHSA-r4f7-w4j9-xj27)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-r4f7-w4j9-xj27"
    },
    secretkey2fa: {
      blocked_all: true,
      reason: "Malicious code in secretkey2fa (npm) (GHSA-wrp2-cvjj-h5jx)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-wrp2-cvjj-h5jx"
    },
    "vitest-chalk-pro": {
      blocked_all: true,
      reason: "Malicious code in vitest-chalk-pro (npm) (GHSA-rjfw-6xw6-qjfx)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-rjfw-6xw6-qjfx"
    },
    "test-in-one": {
      blocked_all: true,
      reason: "Malicious code in test-in-one (npm) (GHSA-34hr-xghx-cfj4)",
      date: "2026-08-29",
      advisory: "https://github.com/advisories/GHSA-34hr-xghx-cfj4"
    },
    "sliding-score-window": {
      blocked_all: true,
      reason: "Malware in sliding-score-window (GHSA-7wm7-mj8v-49f7)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-7wm7-mj8v-49f7"
    },
    "ordered-freq-counter": {
      blocked_all: true,
      reason: "Malware in ordered-freq-counter (GHSA-xjh3-6ch8-mr8c)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-xjh3-6ch8-mr8c"
    },
    "neighbor-key-map": {
      blocked_all: true,
      reason: "Malware in neighbor-key-map (GHSA-c7w5-hg7j-94q4)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-c7w5-hg7j-94q4"
    },
    "ordered-kv-index": {
      blocked_all: true,
      reason: "Malware in ordered-kv-index (GHSA-r948-p23m-ffg3)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-r948-p23m-ffg3"
    },
    "btree-lru-cache": {
      blocked_all: true,
      reason: "Malware in btree-lru-cache (GHSA-p5xg-f96c-j538)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-p5xg-f96c-j538"
    },
    "btree-time-index": {
      blocked_all: true,
      reason: "Malware in btree-time-index (GHSA-7r97-jh52-2rx8)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-7r97-jh52-2rx8"
    },
    "priority-slot-queue": {
      blocked_all: true,
      reason: "Malware in priority-slot-queue (GHSA-7gh9-f2pq-8vf3)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-7gh9-f2pq-8vf3"
    },
    "btree-range-store": {
      blocked_all: true,
      reason: "Malware in btree-range-store (GHSA-5p9f-98mr-w2hr)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-5p9f-98mr-w2hr"
    },
    "btree-core": {
      blocked_all: true,
      reason: "Malware in btree-core (GHSA-wj64-2cmx-c3j4)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-wj64-2cmx-c3j4"
    },
    "btree-leaderboard": {
      blocked_all: true,
      reason: "Malware in btree-leaderboard (GHSA-jj56-73wg-7pff)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-jj56-73wg-7pff"
    },
    "indexed-btree": {
      blocked_all: true,
      reason: "Malware in indexed-btree (GHSA-f3xx-wvxc-5vh4)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-f3xx-wvxc-5vh4"
    },
    cbc97b7a: {
      blocked_all: true,
      reason: "Malware in cbc97b7a (GHSA-9m3c-67f2-gjwf)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-9m3c-67f2-gjwf"
    },
    "element-utils-guci": {
      blocked_all: true,
      reason: "Malware in element-utils-guci (GHSA-xmq8-5hmm-8m7p)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-xmq8-5hmm-8m7p"
    },
    "element-guci-util": {
      blocked_all: true,
      reason: "Malware in element-guci-util (GHSA-rv3j-whh5-7gwg)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-rv3j-whh5-7gwg"
    },
    "fullcalendar-windos": {
      blocked_all: true,
      reason: "Malware in fullcalendar-windos (GHSA-r79q-6mfx-5r5v)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-r79q-6mfx-5r5v"
    },
    "element-icon-guci": {
      blocked_all: true,
      reason: "Malware in element-icon-guci (GHSA-vmx8-58pp-r729)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-vmx8-58pp-r729"
    },
    "guci-wxrout": {
      blocked_all: true,
      reason: "Malware in guci-wxrout (GHSA-wm72-hv9c-mxxr)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-wm72-hv9c-mxxr"
    },
    "guci-main": {
      blocked_all: true,
      reason: "Malware in guci-main (GHSA-xv44-v947-3jrh)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-xv44-v947-3jrh"
    },
    "guci-date": {
      blocked_all: true,
      reason: "Malware in guci-date (GHSA-pg5x-8f3x-f3x5)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-pg5x-8f3x-f3x5"
    },
    "frank-apple-utils": {
      blocked_all: true,
      reason: "Malware in frank-apple-utils (GHSA-xg8f-3qvf-9cfp)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-xg8f-3qvf-9cfp"
    },
    "apple-internal-test-utility": {
      blocked_all: true,
      reason: "Malware in apple-internal-test-utility (GHSA-54h3-c256-wpw8)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-54h3-c256-wpw8"
    },
    "frank-apple-sync-service": {
      blocked_all: true,
      reason: "Malware in frank-apple-sync-service (GHSA-463x-3972-8874)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-463x-3972-8874"
    },
    "frank-research-poc-apple": {
      blocked_all: true,
      reason: "Malware in frank-research-poc-apple (GHSA-78hq-gp8w-grwp)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-78hq-gp8w-grwp"
    },
    "google-cloud-internal-core-utils": {
      blocked_all: true,
      reason: "Malware in google-cloud-internal-core-utils (GHSA-4vvq-8686-f44c)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-4vvq-8686-f44c"
    },
    "frank-bot-gogle-cloning": {
      blocked_all: true,
      reason: "Malware in frank-bot-gogle-cloning (GHSA-52j3-fx2q-cqm9)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-52j3-fx2q-cqm9"
    },
    "google-cloud-internal-build-helper": {
      blocked_all: true,
      reason: "Malware in google-cloud-internal-build-helper (GHSA-3qp7-c8c6-w6vj)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-3qp7-c8c6-w6vj"
    },
    "google-internal-cloud-audit-security-check": {
      blocked_all: true,
      reason: "Malware in google-internal-cloud-audit-security-check (GHSA-cw6m-gmx9-x556)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-cw6m-gmx9-x556"
    },
    "apple-cktool-internal-api-v9": {
      blocked_all: true,
      reason: "Malware in apple-cktool-internal-api-v9 (GHSA-5cfx-4hvj-jxm8)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-5cfx-4hvj-jxm8"
    },
    "google-cloud-mono-repo-helper": {
      blocked_all: true,
      reason: "Malware in google-cloud-mono-repo-helper (GHSA-8rcc-3mvv-4c2x)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-8rcc-3mvv-4c2x"
    },
    "tailwindcss-fluid-styles": {
      blocked_all: true,
      reason: "Malicious code in tailwindcss-fluid-styles (npm) (GHSA-qmfx-363x-c6gj)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-qmfx-363x-c6gj"
    },
    "@stellarshift/token-units": {
      blocked_all: true,
      reason: "Malicious code in @stellarshift/token-units (npm) (GHSA-f7jv-2wj8-grw7)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-f7jv-2wj8-grw7"
    },
    "real-router-utils": {
      blocked_all: true,
      reason: "Malicious code in real-router-utils (npm) (GHSA-fw7f-xj7r-p9v6)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-fw7f-xj7r-p9v6"
    },
    "@stellarshift/evm-address-kit": {
      blocked_all: true,
      reason: "Malicious code in @stellarshift/evm-address-kit (npm) (GHSA-9wh4-p3rc-w4r3)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-9wh4-p3rc-w4r3"
    },
    "@stellarshift/chain-metadata": {
      blocked_all: true,
      reason: "Malicious code in @stellarshift/chain-metadata (npm) (GHSA-3qrc-cxw6-3956)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-3qrc-cxw6-3956"
    },
    "@stellarshift/abi-tools": {
      blocked_all: true,
      reason: "Malicious code in @stellarshift/abi-tools (npm) (GHSA-75j4-5w9p-f97f)",
      date: "2026-09-03",
      advisory: "https://github.com/advisories/GHSA-75j4-5w9p-f97f"
    },
    beltful: {
      blocked_all: true,
      reason: "Malicious code in beltful (npm) (GHSA-g3fv-f7jr-rm3v)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-g3fv-f7jr-rm3v"
    },
    "bem-page-object": {
      blocked_all: true,
      reason: "Malicious code in bem-page-object (npm) (GHSA-8xvw-4jvh-gvf2)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-8xvw-4jvh-gvf2"
    },
    "bellatrix-proxima-xenos-mantle": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-proxima-xenos-mantle (npm) (GHSA-qq35-399h-mg53)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-qq35-399h-mg53"
    },
    "bellatrix-nextjs-jupiter-dagda": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-nextjs-jupiter-dagda (npm) (GHSA-mqr7-hp6h-7jf5)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-mqr7-hp6h-7jf5"
    },
    "bellatrix-paleoecology-gammarayburst-orbit": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-paleoecology-gammarayburst-orbit (npm) (GHSA-hpfc-8c95-x82h)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-hpfc-8c95-x82h"
    },
    "benchmark-deserialize-mu-epsilon-shell": {
      blocked_all: true,
      reason: "Malicious code in benchmark-deserialize-mu-epsilon-shell (npm) (GHSA-g57v-rhgj-45mc)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-g57v-rhgj-45mc"
    },
    "bellatrix-polaris-resolvers-xenos": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-polaris-resolvers-xenos (npm) (GHSA-gfjx-rhpc-hc4h)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-gfjx-rhpc-hc4h"
    },
    "bellatrix-websockets-filament-biohacking": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-websockets-filament-biohacking (npm) (GHSA-989q-4g7h-22qr)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-989q-4g7h-22qr"
    },
    "bellatrix-spawn-iota-convict": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-spawn-iota-convict (npm) (GHSA-xrx8-v3gj-7mcg)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-xrx8-v3gj-7mcg"
    },
    "bellatrix-rest-blitz-style-loader": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-rest-blitz-style-loader (npm) (GHSA-hx67-h65v-c94h)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-hx67-h65v-c94h"
    },
    "bellatrix-pulsar-bionics-cryovolcano": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-pulsar-bionics-cryovolcano (npm) (GHSA-7xhf-r74v-qwjj)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-7xhf-r74v-qwjj"
    },
    "bellatrix-oberon-halley-convict": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-oberon-halley-convict (npm) (GHSA-m4x3-6f55-f7mp)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-m4x3-6f55-f7mp"
    },
    "bellatrix-odin-redis-commitlint": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-odin-redis-commitlint (npm) (GHSA-4348-x54w-9jjg)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-4348-x54w-9jjg"
    },
    "bellatrix-quantum-computing-non-blocking-package": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-quantum-computing-non-blocking-package (npm) (GHSA-9h89-7wvx-v322)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-9h89-7wvx-v322"
    },
    "bem-mvc-direct": {
      blocked_all: true,
      reason: "Malicious code in bem-mvc-direct (npm) (GHSA-p4wg-jxfp-v4c7)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-p4wg-jxfp-v4c7"
    },
    "benchmark-epsilon-runtime-authenticate-slow": {
      blocked_all: true,
      reason: "Malicious code in benchmark-epsilon-runtime-authenticate-slow (npm) (GHSA-9pr2-9mgf-66f3)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-9pr2-9mgf-66f3"
    },
    "bellatrix-yonder-umbra-polaris": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-yonder-umbra-polaris (npm) (GHSA-jwjp-xfv5-c42f)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-jwjp-xfv5-c42f"
    },
    "bellatrix-pino-nebula-comet": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-pino-nebula-comet (npm) (GHSA-5wp7-2f6x-9x3p)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-5wp7-2f6x-9x3p"
    },
    "bellatrix-spica-rollup-forever": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-spica-rollup-forever (npm) (GHSA-cj4w-p84h-5cx2)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-cj4w-p84h-5cx2"
    },
    "bellatrix-resolvers-inquirer-orbit": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-resolvers-inquirer-orbit (npm) (GHSA-r6r9-gwph-r63j)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-r6r9-gwph-r63j"
    },
    "bellatrix-mira-europa-commitlint": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-mira-europa-commitlint (npm) (GHSA-xvmf-h223-wxrm)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-xvmf-h223-wxrm"
    },
    "bellatrix-nightmare-sequelize-materialize": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-nightmare-sequelize-materialize (npm) (GHSA-fvgf-8h24-pch6)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-fvgf-8h24-pch6"
    },
    "bellatrix-titan-eslint-config-envconfig": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-titan-eslint-config-envconfig (npm) (GHSA-qj56-2g73-jgcj)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-qj56-2g73-jgcj"
    },
    "benchmark-refactor-secure-scale-array": {
      blocked_all: true,
      reason: "Malicious code in benchmark-refactor-secure-scale-array (npm) (GHSA-96c4-92xx-r5fh)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-96c4-92xx-r5fh"
    },
    "bellatrix-quantum-inquirer-child-process": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-quantum-inquirer-child-process (npm) (GHSA-65hr-8grh-6mjj)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-65hr-8grh-6mjj"
    },
    "bellatrix-protractor-fomalhaut-css-loader": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-protractor-fomalhaut-css-loader (npm) (GHSA-jj8q-jhr7-ff3g)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-jj8q-jhr7-ff3g"
    },
    "bellatrix-panspermia-websockets-gulp": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-panspermia-websockets-gulp (npm) (GHSA-4878-h7hw-845m)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-4878-h7hw-845m"
    },
    "bellatrix-oberon-prettier-alphard": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-oberon-prettier-alphard (npm) (GHSA-gq5v-hcj6-6vqj)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-gq5v-hcj6-6vqj"
    },
    bemutato: {
      blocked_all: true,
      reason: "Malicious code in bemutato (npm) (GHSA-rx47-2g5j-w4qr)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-rx47-2g5j-w4qr"
    },
    bemjst: {
      blocked_all: true,
      reason: "Malicious code in bemjst (npm) (GHSA-rv92-pmc9-cj65)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-rv92-pmc9-cj65"
    },
    "belmgr-plugins": {
      blocked_all: true,
      reason: "Malicious code in belmgr-plugins (npm) (GHSA-592q-5rph-cm2c)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-592q-5rph-cm2c"
    },
    "bellatrix-upgrade-janus-dynamo": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-upgrade-janus-dynamo (npm) (GHSA-387x-5gv2-f5jf)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-387x-5gv2-f5jf"
    },
    "bellatrix-yildun-lint-staged-wolf": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-yildun-lint-staged-wolf (npm) (GHSA-5r75-xrf9-jvf4)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-5r75-xrf9-jvf4"
    },
    "bellatrix-prompts-webpack-paleobotany": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-prompts-webpack-paleobotany (npm) (GHSA-jqcc-mphv-7qhj)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-jqcc-mphv-7qhj"
    },
    "bellatrix-process-buffer-sequelize": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-process-buffer-sequelize (npm) (GHSA-598f-42h3-wf2v)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-598f-42h3-wf2v"
    },
    "bellatrix-proteomics-meissa-redis": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-proteomics-meissa-redis (npm) (GHSA-c963-jfm5-9fqj)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-c963-jfm5-9fqj"
    },
    "bellatrix-tool-hyperion-prettier-stylelint": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-tool-hyperion-prettier-stylelint (npm) (GHSA-4hw3-96xw-ppg9)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-4hw3-96xw-ppg9"
    },
    "bellatrix-passport-quantum-levels": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-passport-quantum-levels (npm) (GHSA-cmg8-m2gq-925v)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-cmg8-m2gq-925v"
    },
    "bellatrix-mocha-eridanus-gridsome": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-mocha-eridanus-gridsome (npm) (GHSA-r63x-wp52-6rg7)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-r63x-wp52-6rg7"
    },
    "bellatrix-pipe-dione-cordelia": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-pipe-dione-cordelia (npm) (GHSA-qp8w-fx79-gfgh)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-qp8w-fx79-gfgh"
    },
    "bellatrix-local-puppeteer-epigenetics": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-local-puppeteer-epigenetics (npm) (GHSA-w86h-f66f-9chp)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-w86h-f66f-9chp"
    },
    "bellatrix-jabbah-websockets-ignite": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-jabbah-websockets-ignite (npm) (GHSA-w3gj-rc2p-v92g)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-w3gj-rc2p-v92g"
    },
    "bellatrix-library-ganymede-equinox": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-library-ganymede-equinox (npm) (GHSA-2429-qq2r-954w)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-2429-qq2r-954w"
    },
    "bellatrix-graphql-lynx-nova": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-graphql-lynx-nova (npm) (GHSA-rr36-g79x-p99m)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-rr36-g79x-p99m"
    },
    "bellatrix-luna-markdownlint-oberon": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-luna-markdownlint-oberon (npm) (GHSA-638r-r6hc-xmvh)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-638r-r6hc-xmvh"
    },
    "bellatrix-figures-mongodb-warp": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-figures-mongodb-warp (npm) (GHSA-4qcg-9jrj-6hxq)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-4qcg-9jrj-6hxq"
    },
    "bellatrix-gulp-barnard-dagda": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-gulp-barnard-dagda (npm) (GHSA-qp32-33jg-6qgw)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-qp32-33jg-6qgw"
    },
    "bellatrix-element-ui-native-graphql": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-element-ui-native-graphql (npm) (GHSA-76vr-693c-6q7h)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-76vr-693c-6q7h"
    },
    "bellatrix-jsonp-octans-stream": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-jsonp-octans-stream (npm) (GHSA-4j49-6cp7-6qc6)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-4j49-6cp7-6qc6"
    },
    "bellatrix-middleware-yildun-eslint-config": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-middleware-yildun-eslint-config (npm) (GHSA-54xg-7v7m-6vrx)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-54xg-7v7m-6vrx"
    },
    "bellatrix-dorado-halley-sagitta": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-dorado-halley-sagitta (npm) (GHSA-jx8v-gj9q-9pw7)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-jx8v-gj9q-9pw7"
    },
    "bellatrix-eris-yaml-celeste": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-eris-yaml-celeste (npm) (GHSA-7hhr-xw97-x8v5)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-7hhr-xw97-x8v5"
    },
    "bellatrix-middleware-update-uglify-js": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-middleware-update-uglify-js (npm) (GHSA-x6x2-xv8r-3c38)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-x6x2-xv8r-3c38"
    },
    "bellatrix-less-blaze-uglify-js": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-less-blaze-uglify-js (npm) (GHSA-656w-vm9c-8hxv)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-656w-vm9c-8hxv"
    },
    "bellatrix-comet-spica-nightwatch": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-comet-spica-nightwatch (npm) (GHSA-cgv3-3pqj-8625)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-cgv3-3pqj-8625"
    },
    "bellatrix-equinox-commitizen-cors": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-equinox-commitizen-cors (npm) (GHSA-v5j4-r26g-6chg)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-v5j4-r26g-6chg"
    },
    "bellatrix-axios-spica-geoarchaeology": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-axios-spica-geoarchaeology (npm) (GHSA-q635-8cvf-vrw6)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-q635-8cvf-vrw6"
    },
    "bellatrix-astro-sedna-nightwatch": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-astro-sedna-nightwatch (npm) (GHSA-3php-897w-99mx)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-3php-897w-99mx"
    },
    "bellatrix-bulma-postcss-deimos": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-bulma-postcss-deimos (npm) (GHSA-252x-9777-jxgh)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-252x-9777-jxgh"
    },
    "bellatrix-child-process-playwright-geodynamo": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-child-process-playwright-geodynamo (npm) (GHSA-7pmx-c4gg-ppf8)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-7pmx-c4gg-ppf8"
    },
    "bellatrix-aldebaran-mira-centauri": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-aldebaran-mira-centauri (npm) (GHSA-399j-ffc2-qvw5)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-399j-ffc2-qvw5"
    },
    "bellatrix-axios-babel-element-ui": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-axios-babel-element-ui (npm) (GHSA-3rqv-x9h7-vr77)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-3rqv-x9h7-vr77"
    },
    "bellatrix-async-yildun-morgan": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-async-yildun-morgan (npm) (GHSA-rhx5-76gm-r3gj)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-rhx5-76gm-r3gj"
    },
    "bellatrix-aldebaran-hexo-prettier": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-aldebaran-hexo-prettier (npm) (GHSA-6h3h-2m52-93h5)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-6h3h-2m52-93h5"
    },
    "bellatrix-command-testcafe-pino-pretty": {
      blocked_all: true,
      reason: "Malicious code in bellatrix-command-testcafe-pino-pretty (npm) (GHSA-mw7h-r3p7-723x)",
      date: "2026-09-02",
      advisory: "https://github.com/advisories/GHSA-mw7h-r3p7-723x"
    },
    "@crysnovax/plug": {
      blocked_all: true,
      reason: "Malware in @crysnovax/plug (GHSA-vg98-2r8g-7qw2)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-vg98-2r8g-7qw2"
    },
    "@crysnovax/baileys-fixed": {
      blocked_all: true,
      reason: "Malware in @crysnovax/baileys-fixed (GHSA-262v-p7h8-9574)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-262v-p7h8-9574"
    },
    "@crysnovax/baileys-stable": {
      blocked_all: true,
      reason: "Malware in @crysnovax/baileys-stable (GHSA-p579-542j-6v98)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-p579-542j-6v98"
    },
    "@crysnovax/baileys": {
      blocked_all: true,
      reason: "Malware in @crysnovax/baileys (GHSA-c34p-4828-cg5g)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-c34p-4828-cg5g"
    },
    "line-through": {
      blocked_all: true,
      reason: "Malicious code in line-through (npm) (GHSA-j28f-v2rv-5qxh)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-j28f-v2rv-5qxh"
    },
    "box-sign-client": {
      blocked_all: true,
      reason: "Malicious code in box-sign-client (npm) (GHSA-g83p-hr9q-m2pp)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-g83p-hr9q-m2pp"
    },
    "tailwind-contact-forms": {
      blocked_all: true,
      reason: "Malicious code in tailwind-contact-forms (npm) (GHSA-389v-79qp-mvg6)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-389v-79qp-mvg6"
    },
    "real-router-telemetry": {
      blocked_all: true,
      reason: "Malicious code in real-router-telemetry (npm) (GHSA-cwm2-j3h3-g35f)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-cwm2-j3h3-g35f"
    },
    "claude-channel-discord": {
      blocked_all: true,
      reason: "Malicious code in claude-channel-discord (npm) (GHSA-787m-xjf4-8gx6)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-787m-xjf4-8gx6"
    },
    "box-sign-client-poc": {
      blocked_all: true,
      reason: "Malicious code in box-sign-client-poc (npm) (GHSA-33rh-wv8r-6q4r)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-33rh-wv8r-6q4r"
    },
    damp_tuna_z3n: {
      blocked_all: true,
      reason: "Malicious code in damp_tuna_z3n (npm) (GHSA-73pw-wf6r-mg3g)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-73pw-wf6r-mg3g"
    },
    damp_hippopotamus_z3n: {
      blocked_all: true,
      reason: "Malicious code in damp_hippopotamus_z3n (npm) (GHSA-c5qr-hfqr-35qq)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-c5qr-hfqr-35qq"
    },
    "dandelion-dune-cli341-project": {
      blocked_all: true,
      reason: "Malicious code in dandelion-dune-cli341-project (npm) (GHSA-2pxv-fj7p-ww84)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-2pxv-fj7p-ww84"
    },
    "dandelion-giraffe-mpa122-project": {
      blocked_all: true,
      reason: "Malicious code in dandelion-giraffe-mpa122-project (npm) (GHSA-f227-2985-97vw)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-f227-2985-97vw"
    },
    "damp_swift-gooddev": {
      blocked_all: true,
      reason: "Malicious code in damp_swift-gooddev (npm) (GHSA-vcjp-28q4-pppr)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-vcjp-28q4-pppr"
    },
    damp_pelican_z3n: {
      blocked_all: true,
      reason: "Malicious code in damp_pelican_z3n (npm) (GHSA-xhpp-pv6j-7vh7)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-xhpp-pv6j-7vh7"
    },
    damp_hawk_0xrequest: {
      blocked_all: true,
      reason: "Malicious code in damp_hawk_0xrequest (npm) (GHSA-4457-x2x6-w34v)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-4457-x2x6-w34v"
    },
    damp_dog_z3n: {
      blocked_all: true,
      reason: "Malicious code in damp_dog_z3n (npm) (GHSA-gxj3-54c6-2xpf)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-gxj3-54c6-2xpf"
    },
    "dandelion-cliff-atc189-project": {
      blocked_all: true,
      reason: "Malicious code in dandelion-cliff-atc189-project (npm) (GHSA-p4xq-cr56-6gcq)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-p4xq-cr56-6gcq"
    },
    damp_vulture_z3n: {
      blocked_all: true,
      reason: "Malicious code in damp_vulture_z3n (npm) (GHSA-wrwv-fxq6-8q6r)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-wrwv-fxq6-8q6r"
    },
    damp_gayal_z3n: {
      blocked_all: true,
      reason: "Malicious code in damp_gayal_z3n (npm) (GHSA-qr2r-6mhq-gf5m)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-qr2r-6mhq-gf5m"
    },
    "dandelion-amber-owt940-project": {
      blocked_all: true,
      reason: "Malicious code in dandelion-amber-owt940-project (npm) (GHSA-p99r-5928-7c9g)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-p99r-5928-7c9g"
    },
    damp_guanaco_z3n: {
      blocked_all: true,
      reason: "Malicious code in damp_guanaco_z3n (npm) (GHSA-j66j-xc9w-j3hv)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-j66j-xc9w-j3hv"
    },
    "damp_spoonbill_coral-60": {
      blocked_all: true,
      reason: "Malicious code in damp_spoonbill_coral-60 (npm) (GHSA-wh9f-ggrf-84rc)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-wh9f-ggrf-84rc"
    },
    damp_mastodon_z3n: {
      blocked_all: true,
      reason: "Malicious code in damp_mastodon_z3n (npm) (GHSA-6jgv-hgwg-42hg)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-6jgv-hgwg-42hg"
    },
    damp_coyote_0xrequest: {
      blocked_all: true,
      reason: "Malicious code in damp_coyote_0xrequest (npm) (GHSA-q54v-gwff-98wm)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-q54v-gwff-98wm"
    },
    "dandelion-coral-rpv024-project": {
      blocked_all: true,
      reason: "Malicious code in dandelion-coral-rpv024-project (npm) (GHSA-m68q-x8h5-7w44)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-m68q-x8h5-7w44"
    },
    "dandelion-brook-wuk348-project": {
      blocked_all: true,
      reason: "Malicious code in dandelion-brook-wuk348-project (npm) (GHSA-5j95-p237-g537)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-5j95-p237-g537"
    },
    danasah: {
      blocked_all: true,
      reason: "Malicious code in danasah (npm) (GHSA-pfw8-mr2f-cp5r)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-pfw8-mr2f-cp5r"
    },
    danangwijaya: {
      blocked_all: true,
      reason: "Malicious code in danangwijaya (npm) (GHSA-5823-mcwm-qf79)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-5823-mcwm-qf79"
    },
    "damp_wolverine_white-89": {
      blocked_all: true,
      reason: "Malicious code in damp_wolverine_white-89 (npm) (GHSA-v6gc-q43j-8426)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-v6gc-q43j-8426"
    },
    dampradio: {
      blocked_all: true,
      reason: "Malicious code in dampradio (npm) (GHSA-999m-66cp-63m9)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-999m-66cp-63m9"
    },
    damp_manatee_z3n: {
      blocked_all: true,
      reason: "Malicious code in damp_manatee_z3n (npm) (GHSA-8hhr-82g8-mqjp)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-8hhr-82g8-mqjp"
    },
    damp_haddock_requirement: {
      blocked_all: true,
      reason: "Malicious code in damp_haddock_requirement (npm) (GHSA-rwh5-jm6q-5w97)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-rwh5-jm6q-5w97"
    },
    damp_guineafowl_z3n: {
      blocked_all: true,
      reason: "Malicious code in damp_guineafowl_z3n (npm) (GHSA-4qch-r9f4-6rh4)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-4qch-r9f4-6rh4"
    },
    damp_ermine_z3n: {
      blocked_all: true,
      reason: "Malicious code in damp_ermine_z3n (npm) (GHSA-8qg5-8x3v-x5j4)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-8qg5-8x3v-x5j4"
    },
    "damp-crimson-mule": {
      blocked_all: true,
      reason: "Malicious code in damp-crimson-mule (npm) (GHSA-6h42-q2g3-v99g)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-6h42-q2g3-v99g"
    },
    damaged_wasp_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_wasp_z3n (npm) (GHSA-grmf-w25p-w99v)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-grmf-w25p-w99v"
    },
    damaged_marmot_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_marmot_z3n (npm) (GHSA-f5jf-8rq5-wqmf)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-f5jf-8rq5-wqmf"
    },
    damaged_bison_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_bison_z3n (npm) (GHSA-pr2g-v83v-32r3)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-pr2g-v83v-32r3"
    },
    damasco: {
      blocked_all: true,
      reason: "Malicious code in damasco (npm) (GHSA-7496-4qqf-8mhx)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-7496-4qqf-8mhx"
    },
    damaged_bobcat_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_bobcat_z3n (npm) (GHSA-cw98-q8hf-727p)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-cw98-q8hf-727p"
    },
    "damaged-rose-vole": {
      blocked_all: true,
      reason: "Malicious code in damaged-rose-vole (npm) (GHSA-vff9-wjg4-4qwj)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-vff9-wjg4-4qwj"
    },
    "damaged-rose-hedgehog": {
      blocked_all: true,
      reason: "Malicious code in damaged-rose-hedgehog (npm) (GHSA-m82h-2mg2-h298)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-m82h-2mg2-h298"
    },
    damp_chicken_z3n: {
      blocked_all: true,
      reason: "Malicious code in damp_chicken_z3n (npm) (GHSA-45p6-c37c-w2w3)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-45p6-c37c-w2w3"
    },
    damaged_nightingale_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_nightingale_z3n (npm) (GHSA-gc89-jc52-j377)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-gc89-jc52-j377"
    },
    damaged_herring_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_herring_z3n (npm) (GHSA-pr47-8v7v-55ch)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-pr47-8v7v-55ch"
    },
    damaged_crane_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_crane_z3n (npm) (GHSA-8grf-ph8f-9hr6)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-8grf-ph8f-9hr6"
    },
    "damaged-brown-cicada": {
      blocked_all: true,
      reason: "Malicious code in damaged-brown-cicada (npm) (GHSA-gwqm-hgwm-42qm)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-gwqm-hgwm-42qm"
    },
    damp_beaver_z3n: {
      blocked_all: true,
      reason: "Malicious code in damp_beaver_z3n (npm) (GHSA-hrh9-wj44-5r5v)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-hrh9-wj44-5r5v"
    },
    "damp-jade-sole": {
      blocked_all: true,
      reason: "Malicious code in damp-jade-sole (npm) (GHSA-366p-8v93-gq4q)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-366p-8v93-gq4q"
    },
    damaged_dragon_0xrequest: {
      blocked_all: true,
      reason: "Malicious code in damaged_dragon_0xrequest (npm) (GHSA-22fq-9chv-jwc2)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-22fq-9chv-jwc2"
    },
    damp_beetle_z3n: {
      blocked_all: true,
      reason: "Malicious code in damp_beetle_z3n (npm) (GHSA-rfcf-wrr5-ff5j)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-rfcf-wrr5-ff5j"
    },
    "daliusheng-tongjie-zhong": {
      blocked_all: true,
      reason: "Malicious code in daliusheng-tongjie-zhong (npm) (GHSA-m4gh-4w76-3q55)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-m4gh-4w76-3q55"
    },
    "damaged-black-mosquito": {
      blocked_all: true,
      reason: "Malicious code in damaged-black-mosquito (npm) (GHSA-f5xg-4qvp-cqj9)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-f5xg-4qvp-cqj9"
    },
    "daliuren-zhinan": {
      blocked_all: true,
      reason: "Malicious code in daliuren-zhinan (npm) (GHSA-mxfp-jpf6-x8cw)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-mxfp-jpf6-x8cw"
    },
    damaged_coral_replicate_automation: {
      blocked_all: true,
      reason: "Malicious code in damaged_coral_replicate_automation (npm) (GHSA-c29p-3mjj-58m5)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-c29p-3mjj-58m5"
    },
    damaged_angelfish_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_angelfish_z3n (npm) (GHSA-6fcf-9mph-pwx7)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-6fcf-9mph-pwx7"
    },
    damaged_minnow_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_minnow_z3n (npm) (GHSA-7wv3-h8wq-5mgj)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-7wv3-h8wq-5mgj"
    },
    damaged_moth_0xrequest: {
      blocked_all: true,
      reason: "Malicious code in damaged_moth_0xrequest (npm) (GHSA-m3rg-2f6h-pm9m)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-m3rg-2f6h-pm9m"
    },
    "damaged_cricket-appteadev": {
      blocked_all: true,
      reason: "Malicious code in damaged_cricket-appteadev (npm) (GHSA-3fgv-q85w-f98f)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-3fgv-q85w-f98f"
    },
    damaged_firefly_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_firefly_z3n (npm) (GHSA-3wqr-8mr4-p759)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-3wqr-8mr4-p759"
    },
    "damaged-salmon-angelfish": {
      blocked_all: true,
      reason: "Malicious code in damaged-salmon-angelfish (npm) (GHSA-3jmq-7c3r-853f)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-3jmq-7c3r-853f"
    },
    "damaged-emerald-hookworm": {
      blocked_all: true,
      reason: "Malicious code in damaged-emerald-hookworm (npm) (GHSA-4gmq-jq3g-cr8c)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-4gmq-jq3g-cr8c"
    },
    damaged_asp_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_asp_z3n (npm) (GHSA-mjxx-6fvm-96g7)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-mjxx-6fvm-96g7"
    },
    "damp_angelfish_gray-42": {
      blocked_all: true,
      reason: "Malicious code in damp_angelfish_gray-42 (npm) (GHSA-76m4-rm34-h2w4)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-76m4-rm34-h2w4"
    },
    "damaged_rooster-teagooddev": {
      blocked_all: true,
      reason: "Malicious code in damaged_rooster-teagooddev (npm) (GHSA-6whh-6w7j-v9hm)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-6whh-6w7j-v9hm"
    },
    damaged_cat_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_cat_z3n (npm) (GHSA-6mq9-wfjf-g95p)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-6mq9-wfjf-g95p"
    },
    damaged_bass_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_bass_z3n (npm) (GHSA-fpvx-6w77-r6wh)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-fpvx-6w77-r6wh"
    },
    damaged_stoat_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_stoat_z3n (npm) (GHSA-4q6w-2j7g-2q8f)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-4q6w-2j7g-2q8f"
    },
    damaged_spider_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_spider_z3n (npm) (GHSA-77x2-7wpf-r59h)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-77x2-7wpf-r59h"
    },
    damaged_chimpanzee_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_chimpanzee_z3n (npm) (GHSA-wrq9-9ggf-rj9q)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-wrq9-9ggf-rj9q"
    },
    "dam-driver-agoda": {
      blocked_all: true,
      reason: "Malicious code in dam-driver-agoda (npm) (GHSA-6mm3-9hj8-c4ff)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-6mm3-9hj8-c4ff"
    },
    damaged_rat_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_rat_z3n (npm) (GHSA-2cp2-22xq-6p44)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-2cp2-22xq-6p44"
    },
    damaged_sheep_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_sheep_z3n (npm) (GHSA-89qv-8p56-45hp)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-89qv-8p56-45hp"
    },
    damaged_flea_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_flea_z3n (npm) (GHSA-vrh8-3hm3-pph7)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-vrh8-3hm3-pph7"
    },
    damaged_cicada_z3n: {
      blocked_all: true,
      reason: "Malicious code in damaged_cicada_z3n (npm) (GHSA-cfm5-pr82-4q58)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-cfm5-pr82-4q58"
    },
    "daliuren-duanan-shuzheng": {
      blocked_all: true,
      reason: "Malicious code in daliuren-duanan-shuzheng (npm) (GHSA-hghj-w3xr-8r44)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-hghj-w3xr-8r44"
    },
    "dam-pkg-ckeditor": {
      blocked_all: true,
      reason: "Malicious code in dam-pkg-ckeditor (npm) (GHSA-qrg6-f2rf-4hhx)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-qrg6-f2rf-4hhx"
    },
    "dallify-ts": {
      blocked_all: true,
      reason: "Malicious code in dallify-ts (npm) (GHSA-c4w8-483w-8x56)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-c4w8-483w-8x56"
    },
    "dajouka-tsfdaa-ta15": {
      blocked_all: true,
      reason: "Malicious code in dajouka-tsfdaa-ta15 (npm) (GHSA-xq3q-6mfh-2xx9)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-xq3q-6mfh-2xx9"
    },
    "dajouka-tsfdaa-ta13": {
      blocked_all: true,
      reason: "Malicious code in dajouka-tsfdaa-ta13 (npm) (GHSA-fpcj-7mq4-pqv2)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-fpcj-7mq4-pqv2"
    },
    dakado: {
      blocked_all: true,
      reason: "Malicious code in dakado (npm) (GHSA-fjgf-p2r9-3x23)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-fjgf-p2r9-3x23"
    },
    "dajouka-tsfdaa-t6a": {
      blocked_all: true,
      reason: "Malicious code in dajouka-tsfdaa-t6a (npm) (GHSA-44vx-wr2f-wm7p)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-44vx-wr2f-wm7p"
    },
    "dajouka-trssusra-tazc12": {
      blocked_all: true,
      reason: "Malicious code in dajouka-trssusra-tazc12 (npm) (GHSA-mp4c-g7xp-2m6m)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-mp4c-g7xp-2m6m"
    },
    "dajouka-tsfdaa-t1a": {
      blocked_all: true,
      reason: "Malicious code in dajouka-tsfdaa-t1a (npm) (GHSA-xqv9-4chc-p7m9)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-xqv9-4chc-p7m9"
    },
    "dajouka-trefdua-tazc12": {
      blocked_all: true,
      reason: "Malicious code in dajouka-trefdua-tazc12 (npm) (GHSA-gv2w-pwjg-hfvv)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-gv2w-pwjg-hfvv"
    },
    "dajouka-trura-tazc12": {
      blocked_all: true,
      reason: "Malicious code in dajouka-trura-tazc12 (npm) (GHSA-hv4c-5wcw-mr5g)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-hv4c-5wcw-mr5g"
    },
    dakruz: {
      blocked_all: true,
      reason: "Malicious code in dakruz (npm) (GHSA-9mp2-qrw5-5647)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-9mp2-qrw5-5647"
    },
    dalilbaguette: {
      blocked_all: true,
      reason: "Malicious code in dalilbaguette (npm) (GHSA-p5gq-x32g-4rcv)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-p5gq-x32g-4rcv"
    },
    daktyloskop: {
      blocked_all: true,
      reason: "Malicious code in daktyloskop (npm) (GHSA-jghj-mcv2-qvwx)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-jghj-mcv2-qvwx"
    },
    "dajouka-tsfdaa-t2a": {
      blocked_all: true,
      reason: "Malicious code in dajouka-tsfdaa-t2a (npm) (GHSA-7g85-59pr-8qc7)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-7g85-59pr-8qc7"
    },
    "dajouka-tsfdaa-t9a": {
      blocked_all: true,
      reason: "Malicious code in dajouka-tsfdaa-t9a (npm) (GHSA-w37w-3vcc-mh34)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-w37w-3vcc-mh34"
    },
    "dajouka-tsfdaa-t4a": {
      blocked_all: true,
      reason: "Malicious code in dajouka-tsfdaa-t4a (npm) (GHSA-95fh-37pq-348g)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-95fh-37pq-348g"
    },
    "dajouka-tsfdaa-t8a": {
      blocked_all: true,
      reason: "Malicious code in dajouka-tsfdaa-t8a (npm) (GHSA-h5h5-9f29-7c5f)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-h5h5-9f29-7c5f"
    },
    "dajouka-trusra-tazc12": {
      blocked_all: true,
      reason: "Malicious code in dajouka-trusra-tazc12 (npm) (GHSA-4c27-jgqx-7rm5)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-4c27-jgqx-7rm5"
    },
    "dajouka-treua-tazc12": {
      blocked_all: true,
      reason: "Malicious code in dajouka-treua-tazc12 (npm) (GHSA-whpw-mcgh-8jjg)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-whpw-mcgh-8jjg"
    },
    "dajouka-tsfdaa-ta12": {
      blocked_all: true,
      reason: "Malicious code in dajouka-tsfdaa-ta12 (npm) (GHSA-wfwc-g3g2-64rf)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-wfwc-g3g2-64rf"
    },
    "dajouka-trefddua-tazc12": {
      blocked_all: true,
      reason: "Malicious code in dajouka-trefddua-tazc12 (npm) (GHSA-xhqc-w4gf-665q)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-xhqc-w4gf-665q"
    },
    "dajouka-tsfdaa-t7a": {
      blocked_all: true,
      reason: "Malicious code in dajouka-tsfdaa-t7a (npm) (GHSA-77h8-5qcm-6fvx)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-77h8-5qcm-6fvx"
    },
    "ulid-intel": {
      blocked_all: true,
      reason: "Malware in ulid-intel (GHSA-h48j-674x-299v)",
      date: "2026-09-04",
      advisory: "https://github.com/advisories/GHSA-h48j-674x-299v"
    },
    "@liuliang520500/sinataoke_cn_test": {
      blocked_all: true,
      reason: "Malware in @liuliang520500/sinataoke_cn_test (GHSA-36jr-wqjh-q55x)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-36jr-wqjh-q55x"
    },
    "@liuliang520500/sinataoke_cn": {
      blocked_all: true,
      reason: "Malware in @liuliang520500/sinataoke_cn (GHSA-jjx2-vpx2-qp32)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-jjx2-vpx2-qp32"
    },
    "@liuliang520500/pdd-sdk-new": {
      blocked_all: true,
      reason: "Malware in @liuliang520500/pdd-sdk-new (GHSA-jp84-gqp2-j9qq)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-jp84-gqp2-j9qq"
    },
    "@liuliang520500/pdd-sdk": {
      blocked_all: true,
      reason: "Malware in @liuliang520500/pdd-sdk (GHSA-g9hc-xr9f-27g4)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-g9hc-xr9f-27g4"
    },
    "@liuliang520500/jd-sdk": {
      blocked_all: true,
      reason: "Malware in @liuliang520500/jd-sdk (GHSA-j849-992g-rggr)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-j849-992g-rggr"
    },
    "@liuliang520500/taobao-topclient": {
      blocked_all: true,
      reason: "Malware in @liuliang520500/taobao-topclient (GHSA-75r6-9fpm-rf6j)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-75r6-9fpm-rf6j"
    },
    "@pilllesss/yorn": {
      blocked_all: true,
      reason: "Malware in @pilllesss/yorn (GHSA-rghh-4gfg-jvqc)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-rghh-4gfg-jvqc"
    },
    dcftunnel: {
      blocked_all: true,
      reason: "Malware in dcftunnel (GHSA-4c2f-x64v-297x)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-4c2f-x64v-297x"
    },
    "1cattunnel": {
      blocked_all: true,
      reason: "Malware in 1cattunnel (GHSA-r35j-cv2x-mm7h)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-r35j-cv2x-mm7h"
    },
    "multicore-kit": {
      blocked_all: true,
      reason: "Malware in multicore-kit (GHSA-q588-cfvg-8346)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-q588-cfvg-8346"
    },
    "date-fns-formatter": {
      blocked_all: true,
      reason: "Malware in date-fns-formatter (GHSA-h258-m2gc-2p4q)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-h258-m2gc-2p4q"
    },
    "array-frames": {
      blocked_all: true,
      reason: "Malware in array-frames (GHSA-24hx-4mc8-g9q7)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-24hx-4mc8-g9q7"
    },
    "node-helper": {
      blocked_all: true,
      reason: "Malware in node-helper (GHSA-2ggc-wmq2-3whp)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-2ggc-wmq2-3whp"
    },
    "jwt-logger": {
      blocked_all: true,
      reason: "Malware in jwt-logger (GHSA-rpqx-cp2g-55w5)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-rpqx-cp2g-55w5"
    },
    "array-scala": {
      blocked_all: true,
      reason: "Malware in array-scala (GHSA-rx3f-9hxc-773g)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-rx3f-9hxc-773g"
    },
    "@domyjs/i18n": {
      blocked_all: true,
      reason: "Malware in @domyjs/i18n (GHSA-22jr-v88r-5cj6)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-22jr-v88r-5cj6"
    },
    "@domyjs/reactive": {
      blocked_all: true,
      reason: "Malware in @domyjs/reactive (GHSA-3ggc-3pw2-c9v9)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-3ggc-3pw2-c9v9"
    },
    "@domyjs/router": {
      blocked_all: true,
      reason: "Malware in @domyjs/router (GHSA-j7wp-3648-mh57)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-j7wp-3648-mh57"
    },
    "@domyjs/mask": {
      blocked_all: true,
      reason: "Malware in @domyjs/mask (GHSA-93j2-q7r7-7qhh)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-93j2-q7r7-7qhh"
    },
    "@domyjs/throttle": {
      blocked_all: true,
      reason: "Malware in @domyjs/throttle (GHSA-fr62-p59g-hr9f)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-fr62-p59g-hr9f"
    },
    "@domyjs/intersect": {
      blocked_all: true,
      reason: "Malware in @domyjs/intersect (GHSA-v8xv-9q46-8h3x)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-v8xv-9q46-8h3x"
    },
    "@yoannchb/wtf-json": {
      blocked_all: true,
      reason: "Malware in @yoannchb/wtf-json (GHSA-82x7-44x9-7295)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-82x7-44x9-7295"
    },
    enqueu: {
      blocked_all: true,
      reason: "Malware in enqueu (GHSA-352p-f6j8-qxxh)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-352p-f6j8-qxxh"
    },
    "puppeteer-obscura": {
      blocked_all: true,
      reason: "Malware in puppeteer-obscura (GHSA-cxwq-q9c5-424v)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-cxwq-q9c5-424v"
    },
    "inner-svg-ts": {
      blocked_all: true,
      reason: "Malware in inner-svg-ts (GHSA-rx43-xhjx-3xq6)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-rx43-xhjx-3xq6"
    },
    pipipe: {
      blocked_all: true,
      reason: "Malware in pipipe (GHSA-pmm9-p62g-hvp5)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-pmm9-p62g-hvp5"
    },
    "@yoannchb/tokenize": {
      blocked_all: true,
      reason: "Malware in @yoannchb/tokenize (GHSA-4qx6-wqw8-r2qr)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-4qx6-wqw8-r2qr"
    },
    "chrome-speech-recognition": {
      blocked_all: true,
      reason: "Malware in chrome-speech-recognition (GHSA-wvfg-ghw3-64q7)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-wvfg-ghw3-64q7"
    },
    "@domyjs/domy": {
      blocked_all: true,
      reason: "Malware in @domyjs/domy (GHSA-f553-q356-4cmc)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-f553-q356-4cmc"
    },
    "drive-album": {
      blocked_all: true,
      reason: "Malware in drive-album (GHSA-xwpg-4hvv-jxjq)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-xwpg-4hvv-jxjq"
    },
    "@domyjs/debounce": {
      blocked_all: true,
      reason: "Malware in @domyjs/debounce (GHSA-pp6m-2fxr-qjhf)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-pp6m-2fxr-qjhf"
    },
    card3d: {
      blocked_all: true,
      reason: "Malware in card3d (GHSA-gggp-h9vj-pw3p)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-gggp-h9vj-pw3p"
    },
    "@domyjs/anchor": {
      blocked_all: true,
      reason: "Malware in @domyjs/anchor (GHSA-x2rm-5qrx-62mg)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-x2rm-5qrx-62mg"
    },
    "parallaxy-img": {
      blocked_all: true,
      reason: "Malware in parallaxy-img (GHSA-mhp3-rpvj-vrpx)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-mhp3-rpvj-vrpx"
    },
    "@yoannchb/langy": {
      blocked_all: true,
      reason: "Malware in @yoannchb/langy (GHSA-92qv-fgvj-ccf4)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-92qv-fgvj-ccf4"
    },
    "@domyjs/collapse": {
      blocked_all: true,
      reason: "Malware in @domyjs/collapse (GHSA-39q9-7vqg-3m6w)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-39q9-7vqg-3m6w"
    },
    "iframe-to-video": {
      blocked_all: true,
      reason: "Malware in iframe-to-video (GHSA-hh9g-3hm5-vcch)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-hh9g-3hm5-vcch"
    },
    "@yoannchb/cattract": {
      blocked_all: true,
      reason: "Malware in @yoannchb/cattract (GHSA-76pv-jq47-p439)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-76pv-jq47-p439"
    },
    jimg: {
      blocked_all: true,
      reason: "Malware in jimg (GHSA-53xc-j4p4-52q3)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-53xc-j4p4-52q3"
    },
    "tempjs-template": {
      blocked_all: true,
      reason: "Malware in tempjs-template (GHSA-5x3v-r6fj-vf2p)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-5x3v-r6fj-vf2p"
    },
    memov: {
      blocked_all: true,
      reason: "Malware in memov (GHSA-6q78-8863-ww8m)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-6q78-8863-ww8m"
    },
    muswish: {
      blocked_all: true,
      reason: "Malware in muswish (GHSA-295f-26rf-f8f4)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-295f-26rf-f8f4"
    },
    "btn-particles": {
      blocked_all: true,
      reason: "Malware in btn-particles (GHSA-6w56-62pq-vhph)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-6w56-62pq-vhph"
    },
    "onetime-rnd": {
      blocked_all: true,
      reason: "Malware in onetime-rnd (GHSA-55h6-2qxg-jvqv)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-55h6-2qxg-jvqv"
    },
    "google-img-scrap": {
      blocked_all: true,
      reason: "Malware in google-img-scrap (GHSA-mwh7-p59x-2f4g)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-mwh7-p59x-2f4g"
    },
    "json-into-html": {
      blocked_all: true,
      reason: "Malware in json-into-html (GHSA-xvrp-hmjm-74qr)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-xvrp-hmjm-74qr"
    },
    "fast-html-dom-parser": {
      blocked_all: true,
      reason: "Malware in fast-html-dom-parser (GHSA-4wcx-wjq9-25cr)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-4wcx-wjq9-25cr"
    },
    "discord-tqr": {
      blocked_all: true,
      reason: "Malware in discord-tqr (GHSA-xp88-72h6-mw9r)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-xp88-72h6-mw9r"
    },
    "anime-vostfr": {
      blocked_all: true,
      reason: "Malware in anime-vostfr (GHSA-f6c5-36x2-p79p)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-f6c5-36x2-p79p"
    },
    "infinity-grid": {
      blocked_all: true,
      reason: "Malware in infinity-grid (GHSA-39fr-j2vr-r24p)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-39fr-j2vr-r24p"
    },
    "discord-phub": {
      blocked_all: true,
      reason: "Malware in discord-phub (GHSA-7693-gh38-7wmj)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-7693-gh38-7wmj"
    },
    "linkpreview-simple": {
      blocked_all: true,
      reason: "Malware in linkpreview-simple (GHSA-w9q9-gr86-rr73)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-w9q9-gr86-rr73"
    },
    "lazy-attr": {
      blocked_all: true,
      reason: "Malware in lazy-attr (GHSA-pm6r-2g8f-89qh)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-pm6r-2g8f-89qh"
    },
    "trading-bot-utils": {
      blocked_all: true,
      reason: "Malware in trading-bot-utils (GHSA-2h3c-rw6j-mpq7)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-2h3c-rw6j-mpq7"
    },
    "eth-query-utils": {
      blocked_all: true,
      reason: "Malware in eth-query-utils (GHSA-c33f-ppxr-8r7j)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-c33f-ppxr-8r7j"
    },
    "ens-namehash-utils": {
      blocked_all: true,
      reason: "Malware in ens-namehash-utils (GHSA-qfrg-2m38-35gp)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-qfrg-2m38-35gp"
    },
    "gas-price-checker": {
      blocked_all: true,
      reason: "Malware in gas-price-checker (GHSA-fw8f-xwq4-q3v8)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-fw8f-xwq4-q3v8"
    },
    "wallet-watcher": {
      blocked_all: true,
      reason: "Malware in wallet-watcher (GHSA-jq3q-655j-wjqh)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-jq3q-655j-wjqh"
    },
    "eth-lib-helpers": {
      blocked_all: true,
      reason: "Malware in eth-lib-helpers (GHSA-h3xf-4f7r-v9xf)",
      date: "2026-09-05",
      advisory: "https://github.com/advisories/GHSA-h3xf-4f7r-v9xf"
    },
    "feishu-docx-mcp": {
      blocked_all: true,
      reason: "Malware in feishu-docx-mcp (GHSA-q5c6-p5q5-g3px)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-q5c6-p5q5-g3px"
    },
    "blueai-cli": {
      blocked_all: true,
      reason: "Malware in blueai-cli (GHSA-c2v5-8c2f-jj54)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-c2v5-8c2f-jj54"
    },
    "bmc-i18n-extract-cli": {
      blocked_all: true,
      reason: "Malware in bmc-i18n-extract-cli (GHSA-327g-rcr8-hp3p)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-327g-rcr8-hp3p"
    },
    "bmc-translate-utils": {
      blocked_all: true,
      reason: "Malware in bmc-translate-utils (GHSA-997w-vpm2-ww7x)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-997w-vpm2-ww7x"
    },
    "orbitron-tui": {
      blocked_all: true,
      reason: "Malicious code in orbitron-tui (npm) (GHSA-q9gw-fmw5-2mwc)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-q9gw-fmw5-2mwc"
    },
    "orbitron-cli": {
      blocked_all: true,
      reason: "Malicious code in orbitron-cli (npm) (GHSA-4m89-qrv7-j3hv)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-4m89-qrv7-j3hv"
    },
    "agent-free": {
      blocked_all: true,
      reason: "Malicious code in agent-free (npm) (GHSA-7r6p-r7pv-prmg)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-7r6p-r7pv-prmg"
    },
    "prime-coding-agent": {
      blocked_all: true,
      reason: "Malicious code in prime-coding-agent (npm) (GHSA-cxgp-c3r5-8xhr)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-cxgp-c3r5-8xhr"
    },
    vishal_312pkg: {
      blocked_all: true,
      reason: "Malicious code in vishal_312pkg (npm) (GHSA-v7f2-5vcp-m653)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-v7f2-5vcp-m653"
    },
    "agentrc-security-poc-policy": {
      blocked_all: true,
      reason: "Malicious code in agentrc-security-poc-policy (npm) (GHSA-8gv3-q4hj-3764)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-8gv3-q4hj-3764"
    },
    "omni-channel-configurator-wireline-frontend": {
      blocked_all: true,
      reason: "Malicious code in omni-channel-configurator-wireline-frontend (npm) (GHSA-p429-pvx5-xj55)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-p429-pvx5-xj55"
    },
    "b2b-frontend-external-library": {
      blocked_all: true,
      reason: "Malicious code in b2b-frontend-external-library (npm) (GHSA-hmhj-jhrj-285j)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-hmhj-jhrj-285j"
    },
    "@caliperx2/components": {
      blocked_all: true,
      reason: "Malicious code in @caliperx2/components (npm) (GHSA-4jpr-935q-33r2)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-4jpr-935q-33r2"
    },
    "scw-mobile": {
      blocked_all: true,
      reason: "Malware in scw-mobile (GHSA-h9g8-rwcg-hpmh)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-h9g8-rwcg-hpmh"
    },
    "base-account-core": {
      blocked_all: true,
      reason: "Malware in base-account-core (GHSA-vgm8-2vf8-769j)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-vgm8-2vf8-769j"
    },
    "cb-wallet-solana-provider": {
      blocked_all: true,
      reason: "Malware in cb-wallet-solana-provider (GHSA-5cg4-38v4-j4vc)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-5cg4-38v4-j4vc"
    },
    "cb-wallet-metadata": {
      blocked_all: true,
      reason: "Malware in cb-wallet-metadata (GHSA-cxwc-958j-45g8)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-cxwc-958j-45g8"
    },
    "cb-wallet-http": {
      blocked_all: true,
      reason: "Malware in cb-wallet-http (GHSA-mv3f-92cr-83h7)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-mv3f-92cr-83h7"
    },
    "cb-wallet-store": {
      blocked_all: true,
      reason: "Malware in cb-wallet-store (GHSA-gw4f-3mgw-h64x)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-gw4f-3mgw-h64x"
    },
    "base-app-data": {
      blocked_all: true,
      reason: "Malware in base-app-data (GHSA-9hpg-rmwp-vg4p)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-9hpg-rmwp-vg4p"
    },
    "wallet-engine-signing": {
      blocked_all: true,
      reason: "Malware in wallet-engine-signing (GHSA-qw4m-ccr9-7r43)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-qw4m-ccr9-7r43"
    },
    "cb-wallet-env": {
      blocked_all: true,
      reason: "Malware in cb-wallet-env (GHSA-m477-pr6m-v2fp)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-m477-pr6m-v2fp"
    },
    "cb-wallet-analytics": {
      blocked_all: true,
      reason: "Malware in cb-wallet-analytics (GHSA-7944-c265-3ff7)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-7944-c265-3ff7"
    },
    "cb-wallet-data": {
      blocked_all: true,
      reason: "Malware in cb-wallet-data (GHSA-7w56-x3g2-57fg)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-7w56-x3g2-57fg"
    },
    "scw-core": {
      blocked_all: true,
      reason: "Malware in scw-core (GHSA-fv48-xvcx-h3qh)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-fv48-xvcx-h3qh"
    },
    "wallet-cds-web": {
      blocked_all: true,
      reason: "Malware in wallet-cds-web (GHSA-qh9w-32r6-2qpw)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-qh9w-32r6-2qpw"
    },
    "eka-esdoger53-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-esdoger53-breki (npm) (GHSA-p8xp-vqhv-j4c4)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-p8xp-vqhv-j4c4"
    },
    "eka-empal71-sluey": {
      blocked_all: true,
      reason: "Malicious code in eka-empal71-sluey (npm) (GHSA-662p-fwq5-mp67)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-662p-fwq5-mp67"
    },
    "eka-esdoger35-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-esdoger35-breki (npm) (GHSA-pw7m-cwxx-j43p)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-pw7m-cwxx-j43p"
    },
    "eka-enting14-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-enting14-breki (npm) (GHSA-xh92-fg6r-46j3)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-xh92-fg6r-46j3"
    },
    "eka-empal81-kyuki": {
      blocked_all: true,
      reason: "Malicious code in eka-empal81-kyuki (npm) (GHSA-fjhh-fr66-j7p3)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-fjhh-fr66-j7p3"
    },
    "eka-enting87-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-enting87-breki (npm) (GHSA-rppw-gq7q-4v3m)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-rppw-gq7q-4v3m"
    },
    "eka-enting48-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-enting48-breki (npm) (GHSA-3xx4-frfh-8ph6)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-3xx4-frfh-8ph6"
    },
    "eka-empal98-miaww": {
      blocked_all: true,
      reason: "Malicious code in eka-empal98-miaww (npm) (GHSA-65mp-cfv9-8pqm)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-65mp-cfv9-8pqm"
    },
    "eka-empal71-ruro": {
      blocked_all: true,
      reason: "Malicious code in eka-empal71-ruro (npm) (GHSA-72xh-8mhp-xhrp)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-72xh-8mhp-xhrp"
    },
    "eka-empal42-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in eka-empal42-sukiwir (npm) (GHSA-fq2f-vpxp-rmj6)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-fq2f-vpxp-rmj6"
    },
    "eka-esdoger71-pore": {
      blocked_all: true,
      reason: "Malicious code in eka-esdoger71-pore (npm) (GHSA-h2qx-fpq7-93f7)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-h2qx-fpq7-93f7"
    },
    "eka-buburayam38-riris": {
      blocked_all: true,
      reason: "Malicious code in eka-buburayam38-riris (npm) (GHSA-5px8-2xmx-7372)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-5px8-2xmx-7372"
    },
    "eka-donat14-sluey": {
      blocked_all: true,
      reason: "Malicious code in eka-donat14-sluey (npm) (GHSA-c5w6-qmvw-f9m6)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-c5w6-qmvw-f9m6"
    },
    "eka-bubursumsum2-riris": {
      blocked_all: true,
      reason: "Malicious code in eka-bubursumsum2-riris (npm) (GHSA-jvxc-crrx-f62g)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-jvxc-crrx-f62g"
    },
    "eka-bakwan14-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-bakwan14-breki (npm) (GHSA-f3j8-vvcv-6cjm)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-f3j8-vvcv-6cjm"
    },
    "eka-dradag100-miaww": {
      blocked_all: true,
      reason: "Malicious code in eka-dradag100-miaww (npm) (GHSA-f2w2-g68x-hrgc)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-f2w2-g68x-hrgc"
    },
    "eka-bubursumsum24-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-bubursumsum24-breki (npm) (GHSA-x73r-rvr2-r4ff)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-x73r-rvr2-r4ff"
    },
    "eka-dodol77-apidev": {
      blocked_all: true,
      reason: "Malicious code in eka-dodol77-apidev (npm) (GHSA-5qxp-rjq8-26j6)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-5qxp-rjq8-26j6"
    },
    "eka-bubursumsum20-pore": {
      blocked_all: true,
      reason: "Malicious code in eka-bubursumsum20-pore (npm) (GHSA-263q-x35h-hc9w)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-263q-x35h-hc9w"
    },
    "eka-botok87-riris": {
      blocked_all: true,
      reason: "Malicious code in eka-botok87-riris (npm) (GHSA-f6wm-hqf8-489m)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-f6wm-hqf8-489m"
    },
    "eka-brengkes16-sluey": {
      blocked_all: true,
      reason: "Malicious code in eka-brengkes16-sluey (npm) (GHSA-23q4-mwpm-m5cm)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-23q4-mwpm-m5cm"
    },
    "eka-donat34-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-donat34-breki (npm) (GHSA-4fv3-8w34-4vcp)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-4fv3-8w34-4vcp"
    },
    "eka-bika74-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in eka-bika74-sukiwir (npm) (GHSA-9mvc-4cgq-675j)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-9mvc-4cgq-675j"
    },
    "eka-bika31-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-bika31-breki (npm) (GHSA-gvvf-r2mm-jxvm)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-gvvf-r2mm-jxvm"
    },
    "eka-buburayam42-miaww": {
      blocked_all: true,
      reason: "Malicious code in eka-buburayam42-miaww (npm) (GHSA-6h2v-8m36-6r9c)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-6h2v-8m36-6r9c"
    },
    "eka-buburayam24-miaww": {
      blocked_all: true,
      reason: "Malicious code in eka-buburayam24-miaww (npm) (GHSA-3f8q-x5f5-fw9g)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-3f8q-x5f5-fw9g"
    },
    "eka-brongkos63-sluey": {
      blocked_all: true,
      reason: "Malicious code in eka-brongkos63-sluey (npm) (GHSA-xm32-jcrm-w5c8)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-xm32-jcrm-w5c8"
    },
    "eka-brengkes56-riris": {
      blocked_all: true,
      reason: "Malicious code in eka-brengkes56-riris (npm) (GHSA-5m4p-vv7m-q4xf)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-5m4p-vv7m-q4xf"
    },
    "eka-bakwan21-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-bakwan21-breki (npm) (GHSA-mm6v-v8wr-62cr)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-mm6v-v8wr-62cr"
    },
    "eka-empal53-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in eka-empal53-sukiwir (npm) (GHSA-cxhc-8rxc-v49h)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-cxhc-8rxc-v49h"
    },
    "eka-bubursumsum92-miaww": {
      blocked_all: true,
      reason: "Malicious code in eka-bubursumsum92-miaww (npm) (GHSA-64p6-xr37-v8fh)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-64p6-xr37-v8fh"
    },
    "eka-buburayam37-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-buburayam37-breki (npm) (GHSA-qg7q-mr6r-mj6p)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-qg7q-mr6r-mj6p"
    },
    "eka-dodol26-miaww": {
      blocked_all: true,
      reason: "Malicious code in eka-dodol26-miaww (npm) (GHSA-vqf5-5x6g-2w2h)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-vqf5-5x6g-2w2h"
    },
    "eka-brongkos66-sluey": {
      blocked_all: true,
      reason: "Malicious code in eka-brongkos66-sluey (npm) (GHSA-rcvr-qc75-jfmp)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-rcvr-qc75-jfmp"
    },
    "eka-dradag43-kuki": {
      blocked_all: true,
      reason: "Malicious code in eka-dradag43-kuki (npm) (GHSA-vwqr-p8wj-xfj2)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-vwqr-p8wj-xfj2"
    },
    "eka-donat40-riris": {
      blocked_all: true,
      reason: "Malicious code in eka-donat40-riris (npm) (GHSA-5qgq-x93q-gq6m)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-5qgq-x93q-gq6m"
    },
    "eka-dodol98-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-dodol98-breki (npm) (GHSA-6rv6-h3pw-vrwq)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-6rv6-h3pw-vrwq"
    },
    "eka-bika97-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in eka-bika97-sukiwir (npm) (GHSA-457p-c9fc-84rf)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-457p-c9fc-84rf"
    },
    "eka-bakwan94-miaww": {
      blocked_all: true,
      reason: "Malicious code in eka-bakwan94-miaww (npm) (GHSA-6p8m-cw53-xw3m)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-6p8m-cw53-xw3m"
    },
    "eka-bakwan35-riris": {
      blocked_all: true,
      reason: "Malicious code in eka-bakwan35-riris (npm) (GHSA-58rj-q85x-3629)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-58rj-q85x-3629"
    },
    "eka-empal52-pore": {
      blocked_all: true,
      reason: "Malicious code in eka-empal52-pore (npm) (GHSA-3mh9-xh82-f5vp)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-3mh9-xh82-f5vp"
    },
    "eka-empal64-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-empal64-breki (npm) (GHSA-2p3p-m32m-72x2)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-2p3p-m32m-72x2"
    },
    "eka-dodol16-miaww": {
      blocked_all: true,
      reason: "Malicious code in eka-dodol16-miaww (npm) (GHSA-fx8c-53xf-658h)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-fx8c-53xf-658h"
    },
    "eka-brongkos41-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in eka-brongkos41-sukiwir (npm) (GHSA-qxpv-x89f-xq89)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-qxpv-x89f-xq89"
    },
    "eka-brongkos84-riris": {
      blocked_all: true,
      reason: "Malicious code in eka-brongkos84-riris (npm) (GHSA-8mp3-c979-pxvv)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-8mp3-c979-pxvv"
    },
    "eka-brengkes98-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-brengkes98-breki (npm) (GHSA-2vcf-v2vr-m25f)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-2vcf-v2vr-m25f"
    },
    "eka-brengkes76-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in eka-brengkes76-sukiwir (npm) (GHSA-4x27-fc32-22jm)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-4x27-fc32-22jm"
    },
    "eka-brongkos29-sluey": {
      blocked_all: true,
      reason: "Malicious code in eka-brongkos29-sluey (npm) (GHSA-fgjm-wcg2-xqg7)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-fgjm-wcg2-xqg7"
    },
    "eka-dodol85-miaww": {
      blocked_all: true,
      reason: "Malicious code in eka-dodol85-miaww (npm) (GHSA-9pm8-66jh-25vq)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-9pm8-66jh-25vq"
    },
    "eka-buburayam47-sluey": {
      blocked_all: true,
      reason: "Malicious code in eka-buburayam47-sluey (npm) (GHSA-4fg9-38vw-492m)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-4fg9-38vw-492m"
    },
    "eka-bubursumsum84-sumpek": {
      blocked_all: true,
      reason: "Malicious code in eka-bubursumsum84-sumpek (npm) (GHSA-5qq2-h3gg-hcjm)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-5qq2-h3gg-hcjm"
    },
    "eka-buburayam76-ruro": {
      blocked_all: true,
      reason: "Malicious code in eka-buburayam76-ruro (npm) (GHSA-rm97-cj7h-376c)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-rm97-cj7h-376c"
    },
    "eka-bubur49-sluey": {
      blocked_all: true,
      reason: "Malicious code in eka-bubur49-sluey (npm) (GHSA-r99j-cwjg-3jcx)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-r99j-cwjg-3jcx"
    },
    "eka-bubur69-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-bubur69-breki (npm) (GHSA-gv5x-g7jf-j8c6)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-gv5x-g7jf-j8c6"
    },
    "eka-bika1-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in eka-bika1-sukiwir (npm) (GHSA-82g5-m2gm-47c8)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-82g5-m2gm-47c8"
    },
    "eka-empal30-sluey": {
      blocked_all: true,
      reason: "Malicious code in eka-empal30-sluey (npm) (GHSA-jhv7-pwvv-f582)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-jhv7-pwvv-f582"
    },
    "eka-empal63-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in eka-empal63-sukiwir (npm) (GHSA-54v4-99w4-hmx3)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-54v4-99w4-hmx3"
    },
    "eka-buburayam35-sluey": {
      blocked_all: true,
      reason: "Malicious code in eka-buburayam35-sluey (npm) (GHSA-cxgc-7x3r-xw57)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-cxgc-7x3r-xw57"
    },
    "eka-dodol73-ruro": {
      blocked_all: true,
      reason: "Malicious code in eka-dodol73-ruro (npm) (GHSA-54pf-qmjv-hch5)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-54pf-qmjv-hch5"
    },
    "eka-brengkes44-ruro": {
      blocked_all: true,
      reason: "Malicious code in eka-brengkes44-ruro (npm) (GHSA-3jw7-h4c4-3v5f)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-3jw7-h4c4-3v5f"
    },
    "eka-brengkes59-sluey": {
      blocked_all: true,
      reason: "Malicious code in eka-brengkes59-sluey (npm) (GHSA-4vqq-g77c-wwhr)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-4vqq-g77c-wwhr"
    },
    "eka-botok35-miaww": {
      blocked_all: true,
      reason: "Malicious code in eka-botok35-miaww (npm) (GHSA-pcgx-mp52-32q6)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-pcgx-mp52-32q6"
    },
    "eka-dodol98-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in eka-dodol98-sukiwir (npm) (GHSA-3vxj-2wx6-9w65)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-3vxj-2wx6-9w65"
    },
    "eka-donat34-sluey": {
      blocked_all: true,
      reason: "Malicious code in eka-donat34-sluey (npm) (GHSA-c75q-382r-q6j3)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-c75q-382r-q6j3"
    },
    "eka-dodol91-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in eka-dodol91-sukiwir (npm) (GHSA-g4x3-gm44-rp95)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-g4x3-gm44-rp95"
    },
    "eka-bubursumsum17-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-bubursumsum17-breki (npm) (GHSA-fr2x-gj3j-9p4f)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-fr2x-gj3j-9p4f"
    },
    "eka-asinan60-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in eka-asinan60-sukiwir (npm) (GHSA-v6x9-6675-rrwr)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-v6x9-6675-rrwr"
    },
    "ejbwdr-devapptea": {
      blocked_all: true,
      reason: "Malicious code in ejbwdr-devapptea (npm) (GHSA-r9c3-q9c9-492c)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-r9c3-q9c9-492c"
    },
    eivybsafunmzpxlg: {
      blocked_all: true,
      reason: "Malicious code in eivybsafunmzpxlg (npm) (GHSA-q44q-q8fv-453f)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-q44q-q8fv-453f"
    },
    ejercico: {
      blocked_all: true,
      reason: "Malicious code in ejercico (npm) (GHSA-2pv9-fhmj-jxp5)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-2pv9-fhmj-jxp5"
    },
    "eka-asinan10-breki": {
      blocked_all: true,
      reason: "Malicious code in eka-asinan10-breki (npm) (GHSA-7x59-j5pj-q59r)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-7x59-j5pj-q59r"
    },
    "ejs-client": {
      blocked_all: true,
      reason: "Malicious code in ejs-client (npm) (GHSA-94xv-vvc9-6f2j)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-94xv-vvc9-6f2j"
    },
    eimearmartin: {
      blocked_all: true,
      reason: "Malicious code in eimearmartin (npm) (GHSA-gjrj-q8fx-pgx5)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-gjrj-q8fx-pgx5"
    },
    ejdgrvaqkioslhbf: {
      blocked_all: true,
      reason: "Malicious code in ejdgrvaqkioslhbf (npm) (GHSA-j7pj-jc8f-q3fp)",
      date: "2026-09-06",
      advisory: "https://github.com/advisories/GHSA-j7pj-jc8f-q3fp"
    },
    "i18nexus-tools": {
      blocked_all: true,
      reason: "Malware in i18nexus-tools (GHSA-9cfw-xh4g-cc2f)",
      date: "2026-09-08",
      advisory: "https://github.com/advisories/GHSA-9cfw-xh4g-cc2f"
    },
    i18nexus: {
      blocked_all: true,
      reason: "Malware in i18nexus (GHSA-38hw-f37p-99jj)",
      date: "2026-09-08",
      advisory: "https://github.com/advisories/GHSA-38hw-f37p-99jj"
    },
    "@web2apk/baileys": {
      blocked_all: true,
      reason: "Malware in @web2apk/baileys (GHSA-f4f2-cqqp-jcrx)",
      date: "2026-09-08",
      advisory: "https://github.com/advisories/GHSA-f4f2-cqqp-jcrx"
    },
    "krdpass-auth-react-native": {
      blocked_all: true,
      reason: "Malware in krdpass-auth-react-native (GHSA-3j7p-44mj-76hx)",
      date: "2026-09-08",
      advisory: "https://github.com/advisories/GHSA-3j7p-44mj-76hx"
    },
    "@cp-shared-14/frontend-ui": {
      blocked_all: true,
      reason: "Malicious code in @cp-shared-14/frontend-ui (npm) (GHSA-3f8m-gfc3-3g2m)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-3f8m-gfc3-3g2m"
    },
    "@aircanada/components": {
      blocked_all: true,
      reason: "Malware in @aircanada/components (GHSA-w6c3-rrw8-wxrx)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-w6c3-rrw8-wxrx"
    },
    "@aircanada/core": {
      blocked_all: true,
      reason: "Malware in @aircanada/core (GHSA-46mp-56rw-qpmm)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-46mp-56rw-qpmm"
    },
    "@opap/player-kyc-widget": {
      blocked_all: true,
      reason: "Malware in @opap/player-kyc-widget (GHSA-356g-cp7r-g5f5)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-356g-cp7r-g5f5"
    },
    "@aircanada/navigation-handler": {
      blocked_all: true,
      reason: "Malware in @aircanada/navigation-handler (GHSA-356v-pcf2-7958)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-356v-pcf2-7958"
    },
    "@jacksher/install-exec-poc": {
      blocked_all: true,
      reason: "Malware in @jacksher/install-exec-poc (GHSA-4fj2-wwv5-x646)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-4fj2-wwv5-x646"
    },
    "kelly-stake-sizing": {
      blocked_all: true,
      reason: "Malware in kelly-stake-sizing (GHSA-h8rr-x7cp-4h62)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-h8rr-x7cp-4h62"
    },
    "log-update-ts": {
      blocked_all: true,
      reason: "Malware in log-update-ts (GHSA-5866-j382-r7g9)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-5866-j382-r7g9"
    },
    "chai-as-synced": {
      blocked_all: true,
      reason: "Malware in chai-as-synced (GHSA-3m37-26mh-fj77)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-3m37-26mh-fj77"
    },
    "optimizely-starter-kit-for-fastly-compute": {
      blocked_all: true,
      reason: "Malware in optimizely-starter-kit-for-fastly-compute (GHSA-8pfr-f8q3-mr5x)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-8pfr-f8q3-mr5x"
    },
    "github-app-sts-action": {
      blocked_all: true,
      reason: "Malware in github-app-sts-action (GHSA-wmg2-8x3r-rg73)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-wmg2-8x3r-rg73"
    },
    "dojo-rn-interview": {
      blocked_all: true,
      reason: "Malware in dojo-rn-interview (GHSA-7phf-cqrv-j3jg)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-7phf-cqrv-j3jg"
    },
    "passkeys-react": {
      blocked_all: true,
      reason: "Malware in passkeys-react (GHSA-j5q8-gq2c-63vq)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-j5q8-gq2c-63vq"
    },
    "openai-pr-reviewer": {
      blocked_all: true,
      reason: "Malware in openai-pr-reviewer (GHSA-wpv4-wxrh-hvmh)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-wpv4-wxrh-hvmh"
    },
    "karapace-docs": {
      blocked_all: true,
      reason: "Malware in karapace-docs (GHSA-mf8g-pqcc-wxfw)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-mf8g-pqcc-wxfw"
    },
    "octopus-action": {
      blocked_all: true,
      reason: "Malware in octopus-action (GHSA-27rc-jrqq-3wvj)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-27rc-jrqq-3wvj"
    },
    "knowledge-grader": {
      blocked_all: true,
      reason: "Malware in knowledge-grader (GHSA-m4g7-2mxw-5m83)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-m4g7-2mxw-5m83"
    },
    "technical-challenge": {
      blocked_all: true,
      reason: "Malware in technical-challenge (GHSA-x874-j4r9-66gh)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-x874-j4r9-66gh"
    },
    "prism-registry": {
      blocked_all: true,
      reason: "Malware in prism-registry (GHSA-gvgw-fqw6-f4rw)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-gvgw-fqw6-f4rw"
    },
    "matlab-azure-devops-extension": {
      blocked_all: true,
      reason: "Malware in matlab-azure-devops-extension (GHSA-9cfc-3wfm-r8p5)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-9cfc-3wfm-r8p5"
    },
    "remove-bg-serverless-azure": {
      blocked_all: true,
      reason: "Malware in remove-bg-serverless-azure (GHSA-65rf-pp5h-8fw9)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-65rf-pp5h-8fw9"
    },
    "global-intel": {
      blocked_all: true,
      reason: "Malware in global-intel (GHSA-gr4h-f42r-xcxf)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-gr4h-f42r-xcxf"
    },
    "glia-functions-tools": {
      blocked_all: true,
      reason: "Malware in glia-functions-tools (GHSA-62wp-x489-6g6h)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-62wp-x489-6g6h"
    },
    "hyper-kube-config": {
      blocked_all: true,
      reason: "Malware in hyper-kube-config (GHSA-pvc8-7whj-r3w4)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-pvc8-7whj-r3w4"
    },
    wolverinechat: {
      blocked_all: true,
      reason: "Malware in wolverinechat (GHSA-9gmm-g6fq-594g)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-9gmm-g6fq-594g"
    },
    "dynstrg-howto": {
      blocked_all: true,
      reason: "Malware in dynstrg-howto (GHSA-p2vx-mw75-76fw)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-p2vx-mw75-76fw"
    },
    "tool-registry-scripts": {
      blocked_all: true,
      reason: "Malware in tool-registry-scripts (GHSA-r8mg-hv3j-fc44)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-r8mg-hv3j-fc44"
    },
    "content-publisher-sdks": {
      blocked_all: true,
      reason: "Malware in content-publisher-sdks (GHSA-cmjx-pgm3-j5gc)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-cmjx-pgm3-j5gc"
    },
    "llm-traces-app": {
      blocked_all: true,
      reason: "Malware in llm-traces-app (GHSA-xcwg-9ggx-j7pm)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-xcwg-9ggx-j7pm"
    },
    "starship-timeline": {
      blocked_all: true,
      reason: "Malware in starship-timeline (GHSA-7c79-95c2-vgwm)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-7c79-95c2-vgwm"
    },
    "dbt-language-server": {
      blocked_all: true,
      reason: "Malware in dbt-language-server (GHSA-w54g-2v55-m5vr)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-w54g-2v55-m5vr"
    },
    "paypal-postman-lib": {
      blocked_all: true,
      reason: "Malware in paypal-postman-lib (GHSA-96v6-4928-255v)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-96v6-4928-255v"
    },
    "simplisafe-gatsby": {
      blocked_all: true,
      reason: "Malware in simplisafe-gatsby (GHSA-grcq-xfr7-4vpm)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-grcq-xfr7-4vpm"
    },
    "afterpay-sdk-example-server": {
      blocked_all: true,
      reason: "Malware in afterpay-sdk-example-server (GHSA-xqcr-rgfp-6wv7)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-xqcr-rgfp-6wv7"
    },
    "twilio-voice-js-reference-components": {
      blocked_all: true,
      reason: "Malware in twilio-voice-js-reference-components (GHSA-5wvr-g236-9w68)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-5wvr-g236-9w68"
    },
    "@medisend/webview-bridge": {
      blocked_all: true,
      reason: "Malware in @medisend/webview-bridge (GHSA-j743-3xjm-x63m)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-j743-3xjm-x63m"
    },
    "@medisend/shared": {
      blocked_all: true,
      reason: "Malware in @medisend/shared (GHSA-f6mp-mchf-ppcc)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-f6mp-mchf-ppcc"
    },
    "@medisend/core": {
      blocked_all: true,
      reason: "Malware in @medisend/core (GHSA-wfxf-4cwg-r55p)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-wfxf-4cwg-r55p"
    },
    "@medisend/auth": {
      blocked_all: true,
      reason: "Malware in @medisend/auth (GHSA-cpvc-ph75-5rf3)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-cpvc-ph75-5rf3"
    },
    "service-home": {
      blocked_all: true,
      reason: "Malware in service-home (GHSA-m2c9-2v7c-fxf9)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-m2c9-2v7c-fxf9"
    },
    ecobee2: {
      blocked_all: true,
      reason: "Malware in ecobee2 (GHSA-339h-mj38-2p38)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-339h-mj38-2p38"
    },
    "ecobee-home": {
      blocked_all: true,
      reason: "Malware in ecobee-home (GHSA-fhh5-9f4g-qw3h)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-fhh5-9f4g-qw3h"
    },
    "ecobee-api": {
      blocked_all: true,
      reason: "Malware in ecobee-api (GHSA-v8ph-958r-cj9q)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-v8ph-958r-cj9q"
    },
    "op-ts-server-core": {
      blocked_all: true,
      reason: "Malware in op-ts-server-core (GHSA-cj4c-268v-m597)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-cj4c-268v-m597"
    },
    "@idkruan-10/dpd-depconf-probe": {
      blocked_all: true,
      reason: "Malware in @idkruan-10/dpd-depconf-probe (GHSA-994q-v55m-r2mw)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-994q-v55m-r2mw"
    },
    "digitalexp-style-module-l9": {
      blocked_all: true,
      reason: "Malware in digitalexp-style-module-l9 (GHSA-r7fr-v3m3-mpq2)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-r7fr-v3m3-mpq2"
    },
    "redis-type-intel": {
      blocked_all: true,
      reason: "Malware in redis-type-intel (GHSA-v9rh-vg7p-gwqm)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-v9rh-vg7p-gwqm"
    },
    "oscar-redis": {
      blocked_all: true,
      reason: "Malware in oscar-redis (GHSA-c6m6-wr2f-6f63)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-c6m6-wr2f-6f63"
    },
    "kiki-baileys": {
      blocked_all: true,
      reason: "Malware in kiki-baileys (GHSA-g8cr-3r7q-pcr6)",
      date: "2026-09-07",
      advisory: "https://github.com/advisories/GHSA-g8cr-3r7q-pcr6"
    },
    "chai-as-sleek": {
      blocked_all: true,
      reason: "Malicious code in chai-as-sleek (npm) (GHSA-8986-j8vv-hgwr)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-8986-j8vv-hgwr"
    },
    "cache-cleanup-module": {
      blocked_all: true,
      reason: "Malicious code in cache-cleanup-module (npm) (GHSA-6x68-3hh5-j2mh)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-6x68-3hh5-j2mh"
    },
    "server-authorized-cleanup": {
      blocked_all: true,
      reason: "Malicious code in server-authorized-cleanup (npm) (GHSA-x6qm-rh4f-fjg8)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-x6qm-rh4f-fjg8"
    },
    "reactlogo-load": {
      blocked_all: true,
      reason: "Malicious code in reactlogo-load (npm) (GHSA-x694-g6xc-wfjv)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-x694-g6xc-wfjv"
    },
    "@fyxzpediaa/baileys": {
      blocked_all: true,
      reason: "Malicious code in @fyxzpediaa/baileys (npm) (GHSA-5wxh-fwcf-rv5j)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-5wxh-fwcf-rv5j"
    },
    external_deps_enjoyer: {
      blocked_all: true,
      reason: "Malicious code in external_deps_enjoyer (npm) (GHSA-675v-pqp8-v3wg)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-675v-pqp8-v3wg"
    },
    "easypanel-hosting": {
      blocked_all: true,
      reason: "Malicious code in easypanel-hosting (npm) (GHSA-h9xg-5pcf-4xf2)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-h9xg-5pcf-4xf2"
    },
    "easypanel-deploy": {
      blocked_all: true,
      reason: "Malicious code in easypanel-deploy (npm) (GHSA-m564-m3c9-3gp4)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-m564-m3c9-3gp4"
    },
    "easypanel-agent": {
      blocked_all: true,
      reason: "Malicious code in easypanel-agent (npm) (GHSA-p4x3-628f-53f8)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-p4x3-628f-53f8"
    },
    "easypanel-api-client": {
      blocked_all: true,
      reason: "Malicious code in easypanel-api-client (npm) (GHSA-p4hx-gwfg-7g7p)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-p4hx-gwfg-7g7p"
    },
    "cat-sis2go-utils": {
      blocked_all: true,
      reason: "Malicious code in cat-sis2go-utils (npm) (GHSA-h64p-6fgg-pgm9)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-h64p-6fgg-pgm9"
    },
    sonmors: {
      blocked_all: true,
      reason: "Malicious code in sonmors (npm) (GHSA-vp67-pvcp-4j8j)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-vp67-pvcp-4j8j"
    },
    "vinzz-wcli": {
      blocked_all: true,
      reason: "Malicious code in vinzz-wcli (npm) (GHSA-xv3f-69vw-grmg)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-xv3f-69vw-grmg"
    },
    "toru-ultimate": {
      blocked_all: true,
      reason: "Malicious code in toru-ultimate (npm) (GHSA-jg37-3w86-3rx2)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-jg37-3w86-3rx2"
    },
    gloggo: {
      blocked_all: true,
      reason: "Malicious code in gloggo (npm) (GHSA-wmgg-555m-p7h6)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-wmgg-555m-p7h6"
    },
    "tailwind-aspect-styles": {
      blocked_all: true,
      reason: "Malicious code in tailwind-aspect-styles (npm) (GHSA-r28r-839h-4gqw)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-r28r-839h-4gqw"
    },
    "file-type-detector": {
      blocked_all: true,
      reason: "Malicious code in file-type-detector (npm) (GHSA-cjhh-g8v5-hg5g)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-cjhh-g8v5-hg5g"
    },
    "rojo-rbx": {
      blocked_all: true,
      reason: "Malicious code in rojo-rbx (npm) (GHSA-p55w-6rww-5frg)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-p55w-6rww-5frg"
    },
    selfcerts: {
      blocked_all: true,
      reason: "Malicious code in selfcerts (npm) (GHSA-2cj2-qj4h-42hp)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-2cj2-qj4h-42hp"
    },
    "unifi-credential-server": {
      blocked_all: true,
      reason: "Malicious code in unifi-credential-server (npm) (GHSA-9rgc-h7qj-q8w3)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-9rgc-h7qj-q8w3"
    },
    "express-session-timer": {
      blocked_all: true,
      reason: "Malicious code in express-session-timer (npm) (GHSA-xf4h-cmpp-qfvf)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-xf4h-cmpp-qfvf"
    },
    "bx-ui-view": {
      blocked_all: true,
      reason: "Malicious code in bx-ui-view (npm) (GHSA-hqg3-m33m-mvcr)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-hqg3-m33m-mvcr"
    },
    "@yongot/canary-mcp-test": {
      blocked_all: true,
      reason: "Malicious code in @yongot/canary-mcp-test (npm) (GHSA-469r-xxvx-62x3)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-469r-xxvx-62x3"
    },
    "@yongot/canary-mcp-isolation": {
      blocked_all: true,
      reason: "Malicious code in @yongot/canary-mcp-isolation (npm) (GHSA-7gq6-vvhp-97f4)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-7gq6-vvhp-97f4"
    },
    "alloy-graphql": {
      blocked_all: true,
      reason: "Malicious code in alloy-graphql (npm) (GHSA-5xmm-9965-mvqw)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-5xmm-9965-mvqw"
    },
    "twilio-functions": {
      blocked_all: true,
      reason: "Malicious code in twilio-functions (npm) (GHSA-73g6-c624-22hf)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-73g6-c624-22hf"
    },
    "react-hook-doms": {
      blocked_all: true,
      reason: "Malicious code in react-hook-doms (npm) (GHSA-hj8f-64m3-wrpj)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-hj8f-64m3-wrpj"
    },
    "@versacode/baileys": {
      blocked_all: true,
      reason: "Malware in @versacode/baileys (GHSA-fw7g-gr3j-7wf7)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-fw7g-gr3j-7wf7"
    },
    "@vallensofficial/baileys": {
      blocked_all: true,
      reason: "Malware in @vallensofficial/baileys (GHSA-gg93-mm5f-23v8)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-gg93-mm5f-23v8"
    },
    "@haimiya/baileys": {
      blocked_all: true,
      reason: "Malware in @haimiya/baileys (GHSA-q246-72rh-fp8w)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-q246-72rh-fp8w"
    },
    "open-item-validator": {
      blocked_all: true,
      reason: "Malicious code in open-item-validator (npm) (GHSA-jfq9-9hf7-gr4x)",
      date: "2026-09-09",
      advisory: "https://github.com/advisories/GHSA-jfq9-9hf7-gr4x"
    },
    "tailwindcss-aspectratio-styles": {
      blocked_all: true,
      reason: "Malicious code in tailwindcss-aspectratio-styles (npm) (GHSA-4gjp-7xcv-m2gc)",
      date: "2026-09-08",
      advisory: "https://github.com/advisories/GHSA-4gjp-7xcv-m2gc"
    },
    punypump: {
      blocked_all: true,
      reason: "Malicious code in punypump (npm) (GHSA-45jc-2qr4-pmgf)",
      date: "2026-09-08",
      advisory: "https://github.com/advisories/GHSA-45jc-2qr4-pmgf"
    },
    "@umschool/analytics": {
      blocked_all: true,
      reason: "Malicious code in @umschool/analytics (npm) (GHSA-2qmq-f9mj-rwcj)",
      date: "2026-09-08",
      advisory: "https://github.com/advisories/GHSA-2qmq-f9mj-rwcj"
    },
    "@aspect-adv-ui/consent-manager": {
      blocked_all: true,
      reason: "Malicious code in @aspect-adv-ui/consent-manager (npm) (GHSA-2m5c-v74g-r4m8)",
      date: "2026-09-08",
      advisory: "https://github.com/advisories/GHSA-2m5c-v74g-r4m8"
    },
    "@usemosaik/template-react-js": {
      blocked_all: true,
      reason: "Malware in @usemosaik/template-react-js (GHSA-8rcc-9ggm-659p)",
      date: "2026-09-08",
      advisory: "https://github.com/advisories/GHSA-8rcc-9ggm-659p"
    },
    "far-gray-pike": {
      blocked_all: true,
      reason: "Malicious code in far-gray-pike (npm) (GHSA-4gw6-f885-5rrp)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-4gw6-f885-5rrp"
    },
    "far-jade-porcupine": {
      blocked_all: true,
      reason: "Malicious code in far-jade-porcupine (npm) (GHSA-6cpr-cwhx-vpg9)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-6cpr-cwhx-vpg9"
    },
    "far-teal-platypus": {
      blocked_all: true,
      reason: "Malicious code in far-teal-platypus (npm) (GHSA-r33m-wc9f-rg95)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-r33m-wc9f-rg95"
    },
    far_bovid_z3n: {
      blocked_all: true,
      reason: "Malicious code in far_bovid_z3n (npm) (GHSA-v77m-mch6-pwm8)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-v77m-mch6-pwm8"
    },
    "far-cyan-mite": {
      blocked_all: true,
      reason: "Malicious code in far-cyan-mite (npm) (GHSA-xh35-hq39-4wmw)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-xh35-hq39-4wmw"
    },
    fantastic_meadowlark_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_meadowlark_z3n (npm) (GHSA-7pgw-39qg-rgp6)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-7pgw-39qg-rgp6"
    },
    "far-pink-anglerfish": {
      blocked_all: true,
      reason: "Malicious code in far-pink-anglerfish (npm) (GHSA-wg44-f7mv-5wgh)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-wg44-f7mv-5wgh"
    },
    "far-aquamarine-parakeet": {
      blocked_all: true,
      reason: "Malicious code in far-aquamarine-parakeet (npm) (GHSA-4xrp-g5qx-rrfx)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-4xrp-g5qx-rrfx"
    },
    fantastic_wolf_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_wolf_z3n (npm) (GHSA-86hr-465c-gwqv)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-86hr-465c-gwqv"
    },
    fantastic_parrotfish_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_parrotfish_z3n (npm) (GHSA-4m6p-3g35-qvrh)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-4m6p-3g35-qvrh"
    },
    fantastic_peafowl_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_peafowl_z3n (npm) (GHSA-q7h4-m38v-r88v)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-q7h4-m38v-r88v"
    },
    "fantastic-copper-heron": {
      blocked_all: true,
      reason: "Malicious code in fantastic-copper-heron (npm) (GHSA-fv9q-h436-vpjg)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-fv9q-h436-vpjg"
    },
    fantastic_rat_0xrequest: {
      blocked_all: true,
      reason: "Malicious code in fantastic_rat_0xrequest (npm) (GHSA-p8jj-xpwf-7w48)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-p8jj-xpwf-7w48"
    },
    fantastic_bug_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_bug_z3n (npm) (GHSA-56r2-ccqh-6xw8)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-56r2-ccqh-6xw8"
    },
    fantastic_mackerel_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_mackerel_z3n (npm) (GHSA-78c3-mp94-jg79)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-78c3-mp94-jg79"
    },
    fanfav: {
      blocked_all: true,
      reason: "Malicious code in fanfav (npm) (GHSA-528f-qm84-q52j)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-528f-qm84-q52j"
    },
    fantastic_locust_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_locust_z3n (npm) (GHSA-wq86-vggx-76c9)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-wq86-vggx-76c9"
    },
    "fanta-notthedevs": {
      blocked_all: true,
      reason: "Malicious code in fanta-notthedevs (npm) (GHSA-6rc5-vvxc-j48f)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-6rc5-vvxc-j48f"
    },
    "fantastic-violet-hoverfly": {
      blocked_all: true,
      reason: "Malicious code in fantastic-violet-hoverfly (npm) (GHSA-9gqw-g4ww-c5f9)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-9gqw-g4ww-c5f9"
    },
    fancy_goose_z3n: {
      blocked_all: true,
      reason: "Malicious code in fancy_goose_z3n (npm) (GHSA-67xf-vpv7-7rr9)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-67xf-vpv7-7rr9"
    },
    fantastic_magpie_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_magpie_z3n (npm) (GHSA-39wc-rj52-4c62)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-39wc-rj52-4c62"
    },
    fancy_firefly_0xrequest: {
      blocked_all: true,
      reason: "Malicious code in fancy_firefly_0xrequest (npm) (GHSA-78cw-273c-8q4g)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-78cw-273c-8q4g"
    },
    fantastic_goose_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_goose_z3n (npm) (GHSA-fwc5-jr84-xgmf)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-fwc5-jr84-xgmf"
    },
    fantastic_lizard_0xrequest: {
      blocked_all: true,
      reason: "Malicious code in fantastic_lizard_0xrequest (npm) (GHSA-wffp-v77g-hfq3)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-wffp-v77g-hfq3"
    },
    fantastic_hedgehog_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_hedgehog_z3n (npm) (GHSA-jfqg-3cc4-9qh7)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-jfqg-3cc4-9qh7"
    },
    fantastic_koi_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_koi_z3n (npm) (GHSA-9rvh-j2qm-rp6g)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-9rvh-j2qm-rp6g"
    },
    fancy_wolf_z3n: {
      blocked_all: true,
      reason: "Malicious code in fancy_wolf_z3n (npm) (GHSA-7x5q-gv97-gr38)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-7x5q-gv97-gr38"
    },
    fancy_roadrunner_z3n: {
      blocked_all: true,
      reason: "Malicious code in fancy_roadrunner_z3n (npm) (GHSA-jr96-7m4c-2fwc)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-jr96-7m4c-2fwc"
    },
    fantastic_mollusk_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_mollusk_z3n (npm) (GHSA-pwhj-xj2j-32q2)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-pwhj-xj2j-32q2"
    },
    fantastic_hamster_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_hamster_z3n (npm) (GHSA-7q6v-pmm9-4hfp)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-7q6v-pmm9-4hfp"
    },
    fancy_perch_0xrequest: {
      blocked_all: true,
      reason: "Malicious code in fancy_perch_0xrequest (npm) (GHSA-v45c-c3rc-pr9j)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-v45c-c3rc-pr9j"
    },
    fancy_wombat_z3n: {
      blocked_all: true,
      reason: "Malicious code in fancy_wombat_z3n (npm) (GHSA-799m-83rp-xvvv)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-799m-83rp-xvvv"
    },
    fantastic_lynx_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_lynx_z3n (npm) (GHSA-7g6m-9qv6-pp9r)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-7g6m-9qv6-pp9r"
    },
    fantastic_lion_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_lion_z3n (npm) (GHSA-59cm-53wr-jwgg)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-59cm-53wr-jwgg"
    },
    "fantastic-coffee-lynx": {
      blocked_all: true,
      reason: "Malicious code in fantastic-coffee-lynx (npm) (GHSA-2fc5-5p7m-rqpv)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-2fc5-5p7m-rqpv"
    },
    fantastic_goat_dumbs: {
      blocked_all: true,
      reason: "Malicious code in fantastic_goat_dumbs (npm) (GHSA-9223-j7x6-jhg9)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-9223-j7x6-jhg9"
    },
    "fantastic-crimson-dolphin": {
      blocked_all: true,
      reason: "Malicious code in fantastic-crimson-dolphin (npm) (GHSA-x5pg-9wwj-r999)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-x5pg-9wwj-r999"
    },
    fankctoxvrkdsmgq: {
      blocked_all: true,
      reason: "Malicious code in fankctoxvrkdsmgq (npm) (GHSA-859f-c87f-qx2q)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-859f-c87f-qx2q"
    },
    fancy_snail_z3n: {
      blocked_all: true,
      reason: "Malicious code in fancy_snail_z3n (npm) (GHSA-fwg8-h9xg-mw73)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-fwg8-h9xg-mw73"
    },
    fantastic_toad_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_toad_z3n (npm) (GHSA-3w3g-vmx6-x283)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-3w3g-vmx6-x283"
    },
    fandyx: {
      blocked_all: true,
      reason: "Malicious code in fandyx (npm) (GHSA-ccq5-gpxw-j9cx)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-ccq5-gpxw-j9cx"
    },
    fantastic_gopher_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_gopher_z3n (npm) (GHSA-548r-3hqv-7437)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-548r-3hqv-7437"
    },
    fantastic_goldfish_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_goldfish_z3n (npm) (GHSA-9w46-6p93-f94w)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-9w46-6p93-f94w"
    },
    fantastic_lemur_z3n: {
      blocked_all: true,
      reason: "Malicious code in fantastic_lemur_z3n (npm) (GHSA-jjwq-q54f-7978)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-jjwq-q54f-7978"
    },
    fancy_dormouse_z3n: {
      blocked_all: true,
      reason: "Malicious code in fancy_dormouse_z3n (npm) (GHSA-cv3g-x22v-5q95)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-cv3g-x22v-5q95"
    },
    famous_skunk_z3n: {
      blocked_all: true,
      reason: "Malicious code in famous_skunk_z3n (npm) (GHSA-v6jp-w858-3v4j)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-v6jp-w858-3v4j"
    },
    "fancy-radiate-ygx449-project": {
      blocked_all: true,
      reason: "Malicious code in fancy-radiate-ygx449-project (npm) (GHSA-f3cp-c93p-3483)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-f3cp-c93p-3483"
    },
    fancy_cricket_z3n: {
      blocked_all: true,
      reason: "Malicious code in fancy_cricket_z3n (npm) (GHSA-p5m7-g3q8-46ch)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-p5m7-g3q8-46ch"
    },
    "fancy_bovid-appteadev": {
      blocked_all: true,
      reason: "Malicious code in fancy_bovid-appteadev (npm) (GHSA-9m29-qp5j-xm46)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-9m29-qp5j-xm46"
    },
    fancy_cattle_z3n: {
      blocked_all: true,
      reason: "Malicious code in fancy_cattle_z3n (npm) (GHSA-9rrw-g6q4-6f27)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-9rrw-g6q4-6f27"
    },
    famous_whale_z3n: {
      blocked_all: true,
      reason: "Malicious code in famous_whale_z3n (npm) (GHSA-c77g-hg46-ppqr)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-c77g-hg46-ppqr"
    },
    famous_swordtail_z3n: {
      blocked_all: true,
      reason: "Malicious code in famous_swordtail_z3n (npm) (GHSA-vqfc-8jv4-wfvg)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-vqfc-8jv4-wfvg"
    },
    fancy_bobcat_dumbs: {
      blocked_all: true,
      reason: "Malicious code in fancy_bobcat_dumbs (npm) (GHSA-8mhf-44wr-rj23)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-8mhf-44wr-rj23"
    },
    "fancy-beige-gamefowl": {
      blocked_all: true,
      reason: "Malicious code in fancy-beige-gamefowl (npm) (GHSA-rgqg-g5gx-jm8x)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-rgqg-g5gx-jm8x"
    },
    famous_mite_z3n: {
      blocked_all: true,
      reason: "Malicious code in famous_mite_z3n (npm) (GHSA-5r28-8g3v-7q65)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-5r28-8g3v-7q65"
    },
    fancy_cuckoo_z3n: {
      blocked_all: true,
      reason: "Malicious code in fancy_cuckoo_z3n (npm) (GHSA-hh48-jfwj-grch)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-hh48-jfwj-grch"
    },
    "fancy-blush-egret": {
      blocked_all: true,
      reason: "Malicious code in fancy-blush-egret (npm) (GHSA-mh65-9p7f-69jj)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-mh65-9p7f-69jj"
    },
    "fancy-apricot-whitefish": {
      blocked_all: true,
      reason: "Malicious code in fancy-apricot-whitefish (npm) (GHSA-7j3j-vxp3-v727)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-7j3j-vxp3-v727"
    },
    "fancy-blue-sailfish": {
      blocked_all: true,
      reason: "Malicious code in fancy-blue-sailfish (npm) (GHSA-97r6-w2pp-wwrw)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-97r6-w2pp-wwrw"
    },
    famous_hummingbird_z3n: {
      blocked_all: true,
      reason: "Malicious code in famous_hummingbird_z3n (npm) (GHSA-m9mh-w6mp-24w3)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-m9mh-w6mp-24w3"
    },
    fancy_alligator_z3n: {
      blocked_all: true,
      reason: "Malicious code in fancy_alligator_z3n (npm) (GHSA-px6h-wccg-g6hh)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-px6h-wccg-g6hh"
    },
    fanada: {
      blocked_all: true,
      reason: "Malicious code in fanada (npm) (GHSA-mrxm-hwgm-v932)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-mrxm-hwgm-v932"
    },
    "fancy-tomato-pony": {
      blocked_all: true,
      reason: "Malicious code in fancy-tomato-pony (npm) (GHSA-55j7-wg4g-5rq7)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-55j7-wg4g-5rq7"
    },
    "fancy-pure-vfk847-project": {
      blocked_all: true,
      reason: "Malicious code in fancy-pure-vfk847-project (npm) (GHSA-76rc-xhw3-rrq2)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-76rc-xhw3-rrq2"
    },
    famous_tahr_z3n: {
      blocked_all: true,
      reason: "Malicious code in famous_tahr_z3n (npm) (GHSA-xgf9-qmg7-595h)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-xgf9-qmg7-595h"
    },
    famous_marsupial_z3n: {
      blocked_all: true,
      reason: "Malicious code in famous_marsupial_z3n (npm) (GHSA-5rmx-j8wf-2636)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-5rmx-j8wf-2636"
    },
    "famous-cyan-crayfish": {
      blocked_all: true,
      reason: "Malicious code in famous-cyan-crayfish (npm) (GHSA-rg3r-p374-xgq5)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-rg3r-p374-xgq5"
    },
    "famous-jade-felidae": {
      blocked_all: true,
      reason: "Malicious code in famous-jade-felidae (npm) (GHSA-7vvp-hmf7-f74w)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-7vvp-hmf7-f74w"
    },
    "famous-red-stoat": {
      blocked_all: true,
      reason: "Malicious code in famous-red-stoat (npm) (GHSA-8qxg-w748-wqjg)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-8qxg-w748-wqjg"
    },
    famous_ox_z3n: {
      blocked_all: true,
      reason: "Malicious code in famous_ox_z3n (npm) (GHSA-j9v2-6cpj-r8qp)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-j9v2-6cpj-r8qp"
    },
    famous_goose_z3n: {
      blocked_all: true,
      reason: "Malicious code in famous_goose_z3n (npm) (GHSA-6mph-355v-hc7h)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-6mph-355v-hc7h"
    },
    "famous-coral-fly": {
      blocked_all: true,
      reason: "Malicious code in famous-coral-fly (npm) (GHSA-gpgj-pgj5-xqfh)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-gpgj-pgj5-xqfh"
    },
    "family-island-unlimited-energy447": {
      blocked_all: true,
      reason: "Malicious code in family-island-unlimited-energy447 (npm) (GHSA-f3wf-mwc6-wccp)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-f3wf-mwc6-wccp"
    },
    famous_anaconda_z3n: {
      blocked_all: true,
      reason: "Malicious code in famous_anaconda_z3n (npm) (GHSA-gq6j-954p-84x3)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-gq6j-954p-84x3"
    },
    "famous-amethyst-coyote": {
      blocked_all: true,
      reason: "Malicious code in famous-amethyst-coyote (npm) (GHSA-77g4-h867-gvqq)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-77g4-h867-gvqq"
    },
    famous_heron_z3n: {
      blocked_all: true,
      reason: "Malicious code in famous_heron_z3n (npm) (GHSA-mr4x-8h69-jwg3)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-mr4x-8h69-jwg3"
    },
    famous_angelfish_dumbs: {
      blocked_all: true,
      reason: "Malicious code in famous_angelfish_dumbs (npm) (GHSA-gpxc-xcvf-vpxm)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-gpxc-xcvf-vpxm"
    },
    familylink: {
      blocked_all: true,
      reason: "Malicious code in familylink (npm) (GHSA-f5cq-29jg-wfch)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-f5cq-29jg-wfch"
    },
    "family-island-unlimited-energy167": {
      blocked_all: true,
      reason: "Malicious code in family-island-unlimited-energy167 (npm) (GHSA-fwqv-54f8-mpv3)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-fwqv-54f8-mpv3"
    },
    famous_ape_0xrequest: {
      blocked_all: true,
      reason: "Malicious code in famous_ape_0xrequest (npm) (GHSA-5vv3-5mxp-h76h)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-5vv3-5mxp-h76h"
    },
    "famous-scarlet-dog": {
      blocked_all: true,
      reason: "Malicious code in famous-scarlet-dog (npm) (GHSA-27cg-xj35-r83q)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-27cg-xj35-r83q"
    },
    familiar_puma_z3n: {
      blocked_all: true,
      reason: "Malicious code in familiar_puma_z3n (npm) (GHSA-fj33-vpfr-42jf)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-fj33-vpfr-42jf"
    },
    familiar_scorpion_z3n: {
      blocked_all: true,
      reason: "Malicious code in familiar_scorpion_z3n (npm) (GHSA-29g5-27gh-qgmq)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-29g5-27gh-qgmq"
    },
    famous_firefly_0xrequest: {
      blocked_all: true,
      reason: "Malicious code in famous_firefly_0xrequest (npm) (GHSA-3gwg-6r3j-8phm)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-3gwg-6r3j-8phm"
    },
    "famous-beige-tern": {
      blocked_all: true,
      reason: "Malicious code in famous-beige-tern (npm) (GHSA-rjfr-r6m2-5wgq)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-rjfr-r6m2-5wgq"
    },
    "famous-aquamarine-unicorn": {
      blocked_all: true,
      reason: "Malicious code in famous-aquamarine-unicorn (npm) (GHSA-4m9c-2fw6-629r)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-4m9c-2fw6-629r"
    },
    "famous_angelfish-notthedev": {
      blocked_all: true,
      reason: "Malicious code in famous_angelfish-notthedev (npm) (GHSA-8m5p-5rpg-p79c)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-8m5p-5rpg-p79c"
    },
    famous_firefly_z3n: {
      blocked_all: true,
      reason: "Malicious code in famous_firefly_z3n (npm) (GHSA-vjvh-qfh9-j644)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-vjvh-qfh9-j644"
    },
    famous_hippopotamus_z3n: {
      blocked_all: true,
      reason: "Malicious code in famous_hippopotamus_z3n (npm) (GHSA-xf7r-2xqg-43ff)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-xf7r-2xqg-43ff"
    },
    famous_cicada_z3n: {
      blocked_all: true,
      reason: "Malicious code in famous_cicada_z3n (npm) (GHSA-9vhh-3w4f-qg2q)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-9vhh-3w4f-qg2q"
    },
    "family-island-unlimited-energy463": {
      blocked_all: true,
      reason: "Malicious code in family-island-unlimited-energy463 (npm) (GHSA-vfv5-3f53-m9xc)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-vfv5-3f53-m9xc"
    },
    "family-island-unlimited-energy285": {
      blocked_all: true,
      reason: "Malicious code in family-island-unlimited-energy285 (npm) (GHSA-5gpm-vmw8-fh82)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-5gpm-vmw8-fh82"
    },
    "family-island-unlimited-energy362": {
      blocked_all: true,
      reason: "Malicious code in family-island-unlimited-energy362 (npm) (GHSA-mfhq-v4c9-3j9m)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-mfhq-v4c9-3j9m"
    },
    familiar_hippopotamus_z3n: {
      blocked_all: true,
      reason: "Malicious code in familiar_hippopotamus_z3n (npm) (GHSA-968v-qf7v-6j94)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-968v-qf7v-6j94"
    },
    familiar_jackal_z3n: {
      blocked_all: true,
      reason: "Malicious code in familiar_jackal_z3n (npm) (GHSA-mj35-wgvx-52jg)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-mj35-wgvx-52jg"
    },
    familiar_porcupine_z3n: {
      blocked_all: true,
      reason: "Malicious code in familiar_porcupine_z3n (npm) (GHSA-64q4-pvm4-9hxf)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-64q4-pvm4-9hxf"
    },
    familiar_marten_dumbs: {
      blocked_all: true,
      reason: "Malicious code in familiar_marten_dumbs (npm) (GHSA-h8m5-xmq7-pfh2)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-h8m5-xmq7-pfh2"
    },
    "familiar_marlin-appteadev": {
      blocked_all: true,
      reason: "Malicious code in familiar_marlin-appteadev (npm) (GHSA-84hv-pmq7-m9xg)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-84hv-pmq7-m9xg"
    },
    "familiar_prawn_scarlet-18": {
      blocked_all: true,
      reason: "Malicious code in familiar_prawn_scarlet-18 (npm) (GHSA-6x3p-7qff-g562)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-6x3p-7qff-g562"
    },
    familiar_hare_z3n: {
      blocked_all: true,
      reason: "Malicious code in familiar_hare_z3n (npm) (GHSA-ggqm-w32h-4qfg)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-ggqm-w32h-4qfg"
    },
    "strapi-plugin-vinsoc-1109": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-vinsoc-1109 (npm) (GHSA-244v-fw48-794m)",
      date: "2026-09-11",
      advisory: "https://github.com/advisories/GHSA-244v-fw48-794m"
    },
    "daytona-test-miner": {
      blocked_all: true,
      reason: "Malware in daytona-test-miner (GHSA-7fxg-v94h-8j5g)",
      date: "2026-09-11",
      advisory: "https://github.com/advisories/GHSA-7fxg-v94h-8j5g"
    },
    "daytona-test-filereader": {
      blocked_all: true,
      reason: "Malware in daytona-test-filereader (GHSA-f2vx-rj2m-pmp8)",
      date: "2026-09-11",
      advisory: "https://github.com/advisories/GHSA-f2vx-rj2m-pmp8"
    },
    "daytona-test-npm": {
      blocked_all: true,
      reason: "Malware in daytona-test-npm (GHSA-j8pm-8rv6-xg64)",
      date: "2026-09-11",
      advisory: "https://github.com/advisories/GHSA-j8pm-8rv6-xg64"
    },
    "@yongot/canary-mcp-test-2": {
      blocked_all: true,
      reason: "Malware in @yongot/canary-mcp-test-2 (GHSA-93xr-jvm3-jpch)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-93xr-jvm3-jpch"
    },
    pinochiomathm: {
      blocked_all: true,
      reason: "Malicious code in pinochiomathm (npm) (GHSA-cq4w-8cp6-cmvf)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-cq4w-8cp6-cmvf"
    },
    "tailwindcss-contact-forms": {
      blocked_all: true,
      reason: "Malicious code in tailwindcss-contact-forms (npm) (GHSA-h9xr-6q2x-2v47)",
      date: "2026-09-10",
      advisory: "https://github.com/advisories/GHSA-h9xr-6q2x-2v47"
    },
    "tailwind-form-kit": {
      blocked_all: true,
      reason: "Malicious code in tailwind-form-kit (npm) (GHSA-p7c5-phj5-qm49)",
      date: "2026-09-12",
      advisory: "https://github.com/advisories/GHSA-p7c5-phj5-qm49"
    },
    "cr-bot-common": {
      blocked_all: true,
      reason: "Malicious code in cr-bot-common (npm) (GHSA-mjmf-5pc4-pfrp)",
      date: "2026-09-12",
      advisory: "https://github.com/advisories/GHSA-mjmf-5pc4-pfrp"
    },
    greensaver: {
      blocked_all: true,
      reason: "Malicious code in greensaver (npm) (GHSA-jfw2-6254-9cwg)",
      date: "2026-09-12",
      advisory: "https://github.com/advisories/GHSA-jfw2-6254-9cwg"
    },
    "tracker-cloudflare": {
      blocked_all: true,
      reason: "Malicious code in tracker-cloudflare (npm) (GHSA-f874-m83r-9vqh)",
      date: "2026-09-12",
      advisory: "https://github.com/advisories/GHSA-f874-m83r-9vqh"
    },
    "@nimbusedge/auth": {
      blocked_all: true,
      reason: "Malicious code in @nimbusedge/auth (npm) (GHSA-gr7r-8wrc-f3mw)",
      date: "2026-09-11",
      advisory: "https://github.com/advisories/GHSA-gr7r-8wrc-f3mw"
    },
    "ida-gado-gado74-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in ida-gado-gado74-sukiwir (npm) (GHSA-9fv6-vg84-r4x6)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-9fv6-vg84-r4x6"
    },
    "ida-gado-gado47-ruro": {
      blocked_all: true,
      reason: "Malicious code in ida-gado-gado47-ruro (npm) (GHSA-7xh6-mjpr-h9hf)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-7xh6-mjpr-h9hf"
    },
    "ida-enting39-riris": {
      blocked_all: true,
      reason: "Malicious code in ida-enting39-riris (npm) (GHSA-jw5q-jwgr-6w4p)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-jw5q-jwgr-6w4p"
    },
    "ida-enting48-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in ida-enting48-sukiwir (npm) (GHSA-3rjm-xpcf-mj6r)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-3rjm-xpcf-mj6r"
    },
    "ida-gandul100-riris": {
      blocked_all: true,
      reason: "Malicious code in ida-gandul100-riris (npm) (GHSA-vv4p-226g-fg38)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-vv4p-226g-fg38"
    },
    "ida-enting56-ruro": {
      blocked_all: true,
      reason: "Malicious code in ida-enting56-ruro (npm) (GHSA-qrqw-v7vm-p76v)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-qrqw-v7vm-p76v"
    },
    "ida-enting60-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in ida-enting60-sukiwir (npm) (GHSA-9fq3-wvcc-wp3x)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-9fq3-wvcc-wp3x"
    },
    "ida-gandul37-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-gandul37-breki (npm) (GHSA-xgx8-mr59-q3pq)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-xgx8-mr59-q3pq"
    },
    "ida-gandul24-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-gandul24-miaww (npm) (GHSA-qc87-3gwr-r3qm)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-qc87-3gwr-r3qm"
    },
    "ida-enting65-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-enting65-sluey (npm) (GHSA-jpxh-fp8f-q8mc)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-jpxh-fp8f-q8mc"
    },
    "ida-gado-gado10-tititugel": {
      blocked_all: true,
      reason: "Malicious code in ida-gado-gado10-tititugel (npm) (GHSA-f2j8-h5h9-xj9f)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-f2j8-h5h9-xj9f"
    },
    "ida-empal83-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-empal83-sluey (npm) (GHSA-553g-fw7c-fqfx)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-553g-fw7c-fqfx"
    },
    "ida-empal23-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in ida-empal23-sukiwir (npm) (GHSA-5xmq-xgc7-jq84)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-5xmq-xgc7-jq84"
    },
    "ida-dodol92-riris": {
      blocked_all: true,
      reason: "Malicious code in ida-dodol92-riris (npm) (GHSA-gjj4-9qff-2rfc)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-gjj4-9qff-2rfc"
    },
    "ida-donat18-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-donat18-sluey (npm) (GHSA-vr62-p52v-gh4q)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-vr62-p52v-gh4q"
    },
    "ida-empal18-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-empal18-sluey (npm) (GHSA-hgxf-mrw8-mhp3)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-hgxf-mrw8-mhp3"
    },
    "ida-empal27-ruro": {
      blocked_all: true,
      reason: "Malicious code in ida-empal27-ruro (npm) (GHSA-6392-2f9j-qvm7)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-6392-2f9j-qvm7"
    },
    "ida-empal18-ruro": {
      blocked_all: true,
      reason: "Malicious code in ida-empal18-ruro (npm) (GHSA-w5qr-jj4x-xr8g)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-w5qr-jj4x-xr8g"
    },
    "ida-dradag60-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-dradag60-breki (npm) (GHSA-9wq8-cfg8-fg7r)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-9wq8-cfg8-fg7r"
    },
    "ida-dodol60-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-dodol60-breki (npm) (GHSA-7m5m-pg98-v2qm)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-7m5m-pg98-v2qm"
    },
    "ida-enting20-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-enting20-miaww (npm) (GHSA-c429-536w-28c2)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-c429-536w-28c2"
    },
    "ida-enting24-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-enting24-sluey (npm) (GHSA-jwcv-4p8j-7j9j)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-jwcv-4p8j-7j9j"
    },
    "ida-empal98-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-empal98-breki (npm) (GHSA-2fxh-gcqr-cr3m)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-2fxh-gcqr-cr3m"
    },
    "ida-empal80-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-empal80-sluey (npm) (GHSA-749x-pg6v-rcvj)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-749x-pg6v-rcvj"
    },
    "ida-empal37-riris": {
      blocked_all: true,
      reason: "Malicious code in ida-empal37-riris (npm) (GHSA-m492-p72c-f8g7)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-m492-p72c-f8g7"
    },
    "ida-empal55-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-empal55-breki (npm) (GHSA-pfvr-56qg-qpgv)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-pfvr-56qg-qpgv"
    },
    "ida-empal74-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-empal74-breki (npm) (GHSA-7xp9-98j9-w28p)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-7xp9-98j9-w28p"
    },
    "ida-empal15-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-empal15-sluey (npm) (GHSA-9fmj-4x5j-4cp3)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-9fmj-4x5j-4cp3"
    },
    "ida-dradag70-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-dradag70-miaww (npm) (GHSA-rm2m-87cr-f6fh)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-rm2m-87cr-f6fh"
    },
    "ida-dodol83-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in ida-dodol83-sukiwir (npm) (GHSA-5vp9-mv53-9864)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-5vp9-mv53-9864"
    },
    "ida-dodol64-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in ida-dodol64-sukiwir (npm) (GHSA-pmp6-9f47-whwr)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-pmp6-9f47-whwr"
    },
    "ida-dodol25-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-dodol25-breki (npm) (GHSA-4gp6-4v7q-pmg8)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-4gp6-4v7q-pmg8"
    },
    "ida-bubursumsum36-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-bubursumsum36-miaww (npm) (GHSA-jmhf-753f-m99m)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-jmhf-753f-m99m"
    },
    "ida-empal77-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-empal77-miaww (npm) (GHSA-48mf-6qwf-4x9g)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-48mf-6qwf-4x9g"
    },
    "ida-dradag78-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-dradag78-miaww (npm) (GHSA-q556-pm43-jj6v)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-q556-pm43-jj6v"
    },
    "ida-dradag80-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in ida-dradag80-sukiwir (npm) (GHSA-h4mj-8pw7-hcp8)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-h4mj-8pw7-hcp8"
    },
    "ida-donat78-remi": {
      blocked_all: true,
      reason: "Malicious code in ida-donat78-remi (npm) (GHSA-2g89-xcv3-gch5)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-2g89-xcv3-gch5"
    },
    "ida-dodol88-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in ida-dodol88-sukiwir (npm) (GHSA-cxxg-7hw3-vf32)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-cxxg-7hw3-vf32"
    },
    "ida-dodol70-crottsekebon": {
      blocked_all: true,
      reason: "Malicious code in ida-dodol70-crottsekebon (npm) (GHSA-rr5c-m9mg-qwfr)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-rr5c-m9mg-qwfr"
    },
    "ida-dodol22-ruro": {
      blocked_all: true,
      reason: "Malicious code in ida-dodol22-ruro (npm) (GHSA-wrcq-jc4r-gfx7)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-wrcq-jc4r-gfx7"
    },
    "ida-bubur42-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-bubur42-miaww (npm) (GHSA-cc6r-x69m-cvrv)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-cc6r-x69m-cvrv"
    },
    "ida-bubur68-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-bubur68-breki (npm) (GHSA-83wc-8rc3-fgwf)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-83wc-8rc3-fgwf"
    },
    "ida-brongkos40-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-brongkos40-sluey (npm) (GHSA-qhjc-mj9r-qh5v)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-qhjc-mj9r-qh5v"
    },
    "ida-brongkos79-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in ida-brongkos79-sukiwir (npm) (GHSA-gvmv-9f43-r6ph)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-gvmv-9f43-r6ph"
    },
    "ida-brengkes64-riris": {
      blocked_all: true,
      reason: "Malicious code in ida-brengkes64-riris (npm) (GHSA-23gc-6x3r-h8p3)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-23gc-6x3r-h8p3"
    },
    "ida-brengkes68-pore": {
      blocked_all: true,
      reason: "Malicious code in ida-brengkes68-pore (npm) (GHSA-hh52-jgpf-w6mp)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-hh52-jgpf-w6mp"
    },
    "ida-botok37-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-botok37-breki (npm) (GHSA-r2xm-3rf7-cxch)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-r2xm-3rf7-cxch"
    },
    "ida-bika91-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-bika91-sluey (npm) (GHSA-f4pp-7w86-55gq)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-f4pp-7w86-55gq"
    },
    "ida-bubur42-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-bubur42-sluey (npm) (GHSA-6vfg-r83x-mfxr)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-6vfg-r83x-mfxr"
    },
    "ida-brongkos2-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-brongkos2-miaww (npm) (GHSA-623g-9hhq-8rqx)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-623g-9hhq-8rqx"
    },
    "ida-brongkos75-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-brongkos75-sluey (npm) (GHSA-6hxm-pvjq-gw3v)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-6hxm-pvjq-gw3v"
    },
    "ida-brengkes53-sumpek": {
      blocked_all: true,
      reason: "Malicious code in ida-brengkes53-sumpek (npm) (GHSA-hvv5-7rcm-fh9q)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-hvv5-7rcm-fh9q"
    },
    "ida-brengkes46-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-brengkes46-miaww (npm) (GHSA-3r46-76mq-r8fv)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-3r46-76mq-r8fv"
    },
    "ida-botok50-ruro": {
      blocked_all: true,
      reason: "Malicious code in ida-botok50-ruro (npm) (GHSA-qmrr-85rr-v6pf)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-qmrr-85rr-v6pf"
    },
    "ida-bubur86-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-bubur86-sluey (npm) (GHSA-7q66-f25m-7p8v)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-7q66-f25m-7p8v"
    },
    "ida-bubursumsum28-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-bubursumsum28-breki (npm) (GHSA-569v-6xv5-j5v2)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-569v-6xv5-j5v2"
    },
    "ida-bubur55-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-bubur55-breki (npm) (GHSA-vjm6-5prx-ghgm)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-vjm6-5prx-ghgm"
    },
    "ida-brengkes26-riris": {
      blocked_all: true,
      reason: "Malicious code in ida-brengkes26-riris (npm) (GHSA-mwrr-p82r-f3jh)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-mwrr-p82r-f3jh"
    },
    "ida-botok73-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in ida-botok73-sukiwir (npm) (GHSA-pvw3-mr34-977h)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-pvw3-mr34-977h"
    },
    "ida-brengkes50-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-brengkes50-breki (npm) (GHSA-gxmj-wwrp-vgqg)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-gxmj-wwrp-vgqg"
    },
    "ida-bakwan79-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-bakwan79-miaww (npm) (GHSA-vg4f-vrq4-f343)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-vg4f-vrq4-f343"
    },
    "ida-bubur44-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-bubur44-breki (npm) (GHSA-26x3-hr3w-mh2g)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-26x3-hr3w-mh2g"
    },
    "ida-bubur1-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-bubur1-miaww (npm) (GHSA-x2g3-f2vx-6frr)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-x2g3-f2vx-6frr"
    },
    "ida-brongkos14-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-brongkos14-miaww (npm) (GHSA-62wr-7wh4-mg8c)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-62wr-7wh4-mg8c"
    },
    "ida-bakwan96-riris": {
      blocked_all: true,
      reason: "Malicious code in ida-bakwan96-riris (npm) (GHSA-9q8g-67x7-5qgx)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-9q8g-67x7-5qgx"
    },
    "ida-botok22-kyuki": {
      blocked_all: true,
      reason: "Malicious code in ida-botok22-kyuki (npm) (GHSA-5gh2-p742-884j)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-5gh2-p742-884j"
    },
    "ida-brengkes11-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-brengkes11-sluey (npm) (GHSA-cv28-h7gx-qq38)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-cv28-h7gx-qq38"
    },
    "ida-bika85-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-bika85-sluey (npm) (GHSA-fgm7-42rm-rfw6)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-fgm7-42rm-rfw6"
    },
    "ida-bakwan74-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-bakwan74-breki (npm) (GHSA-h9fh-2v23-rqjw)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-h9fh-2v23-rqjw"
    },
    "ida-bakso95-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-bakso95-miaww (npm) (GHSA-vqv5-rm3c-mg39)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-vqv5-rm3c-mg39"
    },
    "ida-bakso49-crottsekebon": {
      blocked_all: true,
      reason: "Malicious code in ida-bakso49-crottsekebon (npm) (GHSA-52x2-xx32-h4h5)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-52x2-xx32-h4h5"
    },
    "ida-bakso42-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-bakso42-breki (npm) (GHSA-wh5c-p9mj-vjp6)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-wh5c-p9mj-vjp6"
    },
    "ida-asinan64-riris": {
      blocked_all: true,
      reason: "Malicious code in ida-asinan64-riris (npm) (GHSA-jq6f-w4rr-3vqh)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-jq6f-w4rr-3vqh"
    },
    "ida-asinan46-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-asinan46-breki (npm) (GHSA-m23f-4g8v-q4qg)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-m23f-4g8v-q4qg"
    },
    "id-cookies": {
      blocked_all: true,
      reason: "Malicious code in id-cookies (npm) (GHSA-7h96-j5j5-qhwp)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-7h96-j5j5-qhwp"
    },
    icy_mammal_z3n: {
      blocked_all: true,
      reason: "Malicious code in icy_mammal_z3n (npm) (GHSA-f963-rv58-5635)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-f963-rv58-5635"
    },
    "ida-bakso54-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-bakso54-sluey (npm) (GHSA-x4wr-jw64-hcg4)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-x4wr-jw64-hcg4"
    },
    "ida-bakso55-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-bakso55-miaww (npm) (GHSA-7c6h-rxwx-6p7c)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-7c6h-rxwx-6p7c"
    },
    "ida-asinan98-sumpek": {
      blocked_all: true,
      reason: "Malicious code in ida-asinan98-sumpek (npm) (GHSA-r83h-hfc6-fx6q)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-r83h-hfc6-fx6q"
    },
    "ida-asinan93-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-asinan93-miaww (npm) (GHSA-47jf-4w5q-v3c7)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-47jf-4w5q-v3c7"
    },
    icy_stork_z3n: {
      blocked_all: true,
      reason: "Malicious code in icy_stork_z3n (npm) (GHSA-7r3q-xc77-gcf4)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-7r3q-xc77-gcf4"
    },
    icy_otter_z3n: {
      blocked_all: true,
      reason: "Malicious code in icy_otter_z3n (npm) (GHSA-v978-gc65-cqvg)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-v978-gc65-cqvg"
    },
    icy_pig_z3n: {
      blocked_all: true,
      reason: "Malicious code in icy_pig_z3n (npm) (GHSA-w363-vwxm-rfgc)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-w363-vwxm-rfgc"
    },
    icy_ostrich_z3n: {
      blocked_all: true,
      reason: "Malicious code in icy_ostrich_z3n (npm) (GHSA-xq52-jqqq-mjf7)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-xq52-jqqq-mjf7"
    },
    icy_marsupial_z3n: {
      blocked_all: true,
      reason: "Malicious code in icy_marsupial_z3n (npm) (GHSA-757q-crmv-4jrv)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-757q-crmv-4jrv"
    },
    "ida-bakwan25-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-bakwan25-breki (npm) (GHSA-rhq4-xgxv-p43f)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-rhq4-xgxv-p43f"
    },
    "ida-bakso58-ruro": {
      blocked_all: true,
      reason: "Malicious code in ida-bakso58-ruro (npm) (GHSA-7p9h-rprr-9vgc)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-7p9h-rprr-9vgc"
    },
    "ida-bakso91-breki": {
      blocked_all: true,
      reason: "Malicious code in ida-bakso91-breki (npm) (GHSA-f37g-58pv-6cwm)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-f37g-58pv-6cwm"
    },
    "ida-asinan17-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-asinan17-sluey (npm) (GHSA-mm39-24hc-pm4w)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-mm39-24hc-pm4w"
    },
    icy_orca_z3n: {
      blocked_all: true,
      reason: "Malicious code in icy_orca_z3n (npm) (GHSA-rhc7-9m28-2v88)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-rhc7-9m28-2v88"
    },
    icy_snail_z3n: {
      blocked_all: true,
      reason: "Malicious code in icy_snail_z3n (npm) (GHSA-xpgh-xjfx-mhgm)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-xpgh-xjfx-mhgm"
    },
    icy_prawn_z3n: {
      blocked_all: true,
      reason: "Malicious code in icy_prawn_z3n (npm) (GHSA-p8m8-mrgj-5734)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-p8m8-mrgj-5734"
    },
    "ida-bakso73-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-bakso73-sluey (npm) (GHSA-p73w-2qq4-wm4c)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-p73w-2qq4-wm4c"
    },
    "ida-bakso42-miaww": {
      blocked_all: true,
      reason: "Malicious code in ida-bakso42-miaww (npm) (GHSA-wrhp-7pqm-c537)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-wrhp-7pqm-c537"
    },
    "ida-asinan46-sluey": {
      blocked_all: true,
      reason: "Malicious code in ida-asinan46-sluey (npm) (GHSA-vgfv-vq74-rq7p)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-vgfv-vq74-rq7p"
    },
    icy_sheep_z3n: {
      blocked_all: true,
      reason: "Malicious code in icy_sheep_z3n (npm) (GHSA-fcjq-vv8f-576g)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-fcjq-vv8f-576g"
    },
    icy_rhinoceros_z3n: {
      blocked_all: true,
      reason: "Malicious code in icy_rhinoceros_z3n (npm) (GHSA-7qwr-hv3p-w546)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-7qwr-hv3p-w546"
    },
    icy_leech_z3n: {
      blocked_all: true,
      reason: "Malicious code in icy_leech_z3n (npm) (GHSA-x6q8-44gx-89wm)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-x6q8-44gx-89wm"
    },
    icy_jackal_z3n: {
      blocked_all: true,
      reason: "Malicious code in icy_jackal_z3n (npm) (GHSA-ppr9-pxxg-433r)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-ppr9-pxxg-433r"
    },
    icy_condor_z3n: {
      blocked_all: true,
      reason: "Malicious code in icy_condor_z3n (npm) (GHSA-wg4h-w5f9-ghv2)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-wg4h-w5f9-ghv2"
    },
    "joko-klanting28-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-klanting28-sluey (npm) (GHSA-58wm-27h4-6hm5)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-58wm-27h4-6hm5"
    },
    "joko-ketoprak70-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-ketoprak70-breki (npm) (GHSA-wh59-q7c6-vf3c)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-wh59-q7c6-vf3c"
    },
    "joko-klanting57-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-klanting57-breki (npm) (GHSA-p9qw-3fxw-g994)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-p9qw-3fxw-g994"
    },
    "joko-klanting72-miaww": {
      blocked_all: true,
      reason: "Malicious code in joko-klanting72-miaww (npm) (GHSA-w38j-pq3p-49r9)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-w38j-pq3p-49r9"
    },
    "joko-klanting70-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-klanting70-riris (npm) (GHSA-5wcv-3mmw-mj84)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-5wcv-3mmw-mj84"
    },
    "joko-klanting55-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-klanting55-breki (npm) (GHSA-623r-mc89-3j8j)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-623r-mc89-3j8j"
    },
    "joko-ketoprak97-ruro": {
      blocked_all: true,
      reason: "Malicious code in joko-ketoprak97-ruro (npm) (GHSA-w38j-5jxr-jc29)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-w38j-5jxr-jc29"
    },
    "joko-ketan92-miaww": {
      blocked_all: true,
      reason: "Malicious code in joko-ketan92-miaww (npm) (GHSA-h62x-m5q5-3fm9)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-h62x-m5q5-3fm9"
    },
    "joko-ketan33-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-ketan33-sluey (npm) (GHSA-mg2q-qf2h-h649)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-mg2q-qf2h-h649"
    },
    "joko-ketan77-ruro": {
      blocked_all: true,
      reason: "Malicious code in joko-ketan77-ruro (npm) (GHSA-q427-ww3g-9cvc)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-q427-ww3g-9cvc"
    },
    "joko-keraktelor71-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-keraktelor71-breki (npm) (GHSA-vh64-6c4m-hqg5)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-vh64-6c4m-hqg5"
    },
    "joko-keraktelor64-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-keraktelor64-riris (npm) (GHSA-7646-rm66-476f)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-7646-rm66-476f"
    },
    "joko-keraktelor75-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-keraktelor75-breki (npm) (GHSA-3xw6-mq9c-27fg)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-3xw6-mq9c-27fg"
    },
    "joko-keraktelor64-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-keraktelor64-breki (npm) (GHSA-rp65-5jv3-2cch)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-rp65-5jv3-2cch"
    },
    "joko-ketoprak59-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-ketoprak59-riris (npm) (GHSA-j8pg-8fg4-r2f4)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-j8pg-8fg4-r2f4"
    },
    "joko-ketan89-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-ketan89-breki (npm) (GHSA-mr99-x72h-rrmv)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-mr99-x72h-rrmv"
    },
    "joko-keripik82-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-keripik82-riris (npm) (GHSA-8cj3-6w77-8mmp)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-8cj3-6w77-8mmp"
    },
    "joko-keripik2-ruro": {
      blocked_all: true,
      reason: "Malicious code in joko-keripik2-ruro (npm) (GHSA-c324-x6x9-h254)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-c324-x6x9-h254"
    },
    "joko-keripik55-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-keripik55-sluey (npm) (GHSA-m3p7-x429-qf85)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-m3p7-x429-qf85"
    },
    "joko-keripik1-apidev": {
      blocked_all: true,
      reason: "Malicious code in joko-keripik1-apidev (npm) (GHSA-4gp3-hr68-wrp7)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-4gp3-hr68-wrp7"
    },
    "joko-ketoprak52-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in joko-ketoprak52-sukiwir (npm) (GHSA-66jc-p4q8-xcp9)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-66jc-p4q8-xcp9"
    },
    "joko-keripik93-miaww": {
      blocked_all: true,
      reason: "Malicious code in joko-keripik93-miaww (npm) (GHSA-p2mp-mqfr-668v)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-p2mp-mqfr-668v"
    },
    "joko-keripik33-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-keripik33-riris (npm) (GHSA-wq2p-mwx7-4qpc)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-wq2p-mwx7-4qpc"
    },
    "joko-ketoprak89-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-ketoprak89-breki (npm) (GHSA-xv9r-7qp8-chvr)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-xv9r-7qp8-chvr"
    },
    "joko-ketoprak39-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-ketoprak39-breki (npm) (GHSA-hv3g-2x5h-4x6g)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-hv3g-2x5h-4x6g"
    },
    "joko-ketan75-miaww": {
      blocked_all: true,
      reason: "Malicious code in joko-ketan75-miaww (npm) (GHSA-pv3f-xpvx-qqm4)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-pv3f-xpvx-qqm4"
    },
    "joko-ketan40-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-ketan40-breki (npm) (GHSA-4jr4-fgjh-x88j)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-4jr4-fgjh-x88j"
    },
    "joko-ketan37-apidev": {
      blocked_all: true,
      reason: "Malicious code in joko-ketan37-apidev (npm) (GHSA-4gjm-q57v-6xhx)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-4gjm-q57v-6xhx"
    },
    "joko-ketan29-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-ketan29-breki (npm) (GHSA-vw6c-h27w-g729)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-vw6c-h27w-g729"
    },
    "joko-keripik89-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-keripik89-sluey (npm) (GHSA-c4p2-m6ff-hvrp)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-c4p2-m6ff-hvrp"
    },
    "joko-ketoprak99-miaww": {
      blocked_all: true,
      reason: "Malicious code in joko-ketoprak99-miaww (npm) (GHSA-q6fg-8jvq-rvc9)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-q6fg-8jvq-rvc9"
    },
    "joko-keripik43-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in joko-keripik43-sukiwir (npm) (GHSA-f6p9-mxr8-8vxf)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-f6p9-mxr8-8vxf"
    },
    "joko-ketan28-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in joko-ketan28-sukiwir (npm) (GHSA-4fmj-3h5p-cf4m)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-4fmj-3h5p-cf4m"
    },
    "joko-keripik42-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in joko-keripik42-sukiwir (npm) (GHSA-cp5h-f7fq-23j3)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-cp5h-f7fq-23j3"
    },
    "joko-keripik33-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-keripik33-sluey (npm) (GHSA-7qm8-wmh2-pfhf)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-7qm8-wmh2-pfhf"
    },
    "joko-keripik100-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-keripik100-sluey (npm) (GHSA-5xp5-ccrf-45q9)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-5xp5-ccrf-45q9"
    },
    "joko-keraktelor76-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-keraktelor76-breki (npm) (GHSA-h2vw-r235-hvjm)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-h2vw-r235-hvjm"
    },
    "joko-keraktelor62-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-keraktelor62-sluey (npm) (GHSA-9qq2-85f6-3q23)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-9qq2-85f6-3q23"
    },
    "joko-kepok90-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-kepok90-riris (npm) (GHSA-7vjr-536f-mjxw)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-7vjr-536f-mjxw"
    },
    "joko-keraktelor36-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in joko-keraktelor36-sukiwir (npm) (GHSA-jfcm-65r8-8mw4)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-jfcm-65r8-8mw4"
    },
    "joko-ketoprak93-ruro": {
      blocked_all: true,
      reason: "Malicious code in joko-ketoprak93-ruro (npm) (GHSA-v4vf-x4r8-rxx3)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-v4vf-x4r8-rxx3"
    },
    "joko-klanting26-miaww": {
      blocked_all: true,
      reason: "Malicious code in joko-klanting26-miaww (npm) (GHSA-w8xf-496j-3hrg)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-w8xf-496j-3hrg"
    },
    "joko-ketan94-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-ketan94-breki (npm) (GHSA-h2c7-hmvh-qgc5)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-h2c7-hmvh-qgc5"
    },
    "joko-ketoprak31-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-ketoprak31-breki (npm) (GHSA-jf9q-f9wx-758j)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-jf9q-f9wx-758j"
    },
    "joko-keripik88-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-keripik88-riris (npm) (GHSA-22qv-hrmh-q3vr)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-22qv-hrmh-q3vr"
    },
    "joko-keripik32-remi": {
      blocked_all: true,
      reason: "Malicious code in joko-keripik32-remi (npm) (GHSA-584c-w97g-c5q5)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-584c-w97g-c5q5"
    },
    "joko-keraktelor90-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-keraktelor90-breki (npm) (GHSA-6hqx-w3fj-pqqc)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-6hqx-w3fj-pqqc"
    },
    "joko-keripik64-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-keripik64-sluey (npm) (GHSA-g297-m582-9xgv)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-g297-m582-9xgv"
    },
    "joko-keripik36-miaww": {
      blocked_all: true,
      reason: "Malicious code in joko-keripik36-miaww (npm) (GHSA-g5m9-v64p-c9jv)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-g5m9-v64p-c9jv"
    },
    "joko-kemplang72-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-kemplang72-breki (npm) (GHSA-vp7q-vfmw-ggqc)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-vp7q-vfmw-ggqc"
    },
    "joko-kentang83-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-kentang83-riris (npm) (GHSA-9gcm-7p4c-fq93)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-9gcm-7p4c-fq93"
    },
    "joko-kepok33-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-kepok33-breki (npm) (GHSA-vr3q-fv2p-w6wr)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-vr3q-fv2p-w6wr"
    },
    "joko-kepok61-ruro": {
      blocked_all: true,
      reason: "Malicious code in joko-kepok61-ruro (npm) (GHSA-2h6g-cqm8-3562)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-2h6g-cqm8-3562"
    },
    "joko-kentang14-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-kentang14-breki (npm) (GHSA-r8hr-r5pf-f3c8)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-r8hr-r5pf-f3c8"
    },
    "joko-kemplang69-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-kemplang69-sluey (npm) (GHSA-8g7h-7v7p-ff9f)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-8g7h-7v7p-ff9f"
    },
    "joko-kepok21-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-kepok21-riris (npm) (GHSA-p282-4j74-x8h6)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-p282-4j74-x8h6"
    },
    "joko-kentang65-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-kentang65-breki (npm) (GHSA-xjqc-rw2p-rjcx)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-xjqc-rw2p-rjcx"
    },
    "joko-kemplang27-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in joko-kemplang27-sukiwir (npm) (GHSA-qf75-h93f-r6wj)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-qf75-h93f-r6wj"
    },
    "joko-kentang4-miaww": {
      blocked_all: true,
      reason: "Malicious code in joko-kentang4-miaww (npm) (GHSA-cppq-fq2j-c5jc)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-cppq-fq2j-c5jc"
    },
    "joko-kentang26-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-kentang26-sluey (npm) (GHSA-6h3v-8wg5-hj5f)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-6h3v-8wg5-hj5f"
    },
    "joko-kepok53-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in joko-kepok53-sukiwir (npm) (GHSA-mvqw-pr38-4xqv)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-mvqw-pr38-4xqv"
    },
    "joko-kepok37-crottsekebon": {
      blocked_all: true,
      reason: "Malicious code in joko-kepok37-crottsekebon (npm) (GHSA-jw9x-3hhj-h268)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-jw9x-3hhj-h268"
    },
    "joko-kepok15-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-kepok15-riris (npm) (GHSA-f5wf-vqpq-fjj6)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-f5wf-vqpq-fjj6"
    },
    "joko-kepok4-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-kepok4-breki (npm) (GHSA-wxj4-rvf6-7ffx)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-wxj4-rvf6-7ffx"
    },
    "joko-kentang46-miaww": {
      blocked_all: true,
      reason: "Malicious code in joko-kentang46-miaww (npm) (GHSA-4r48-m5rv-4q4j)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-4r48-m5rv-4q4j"
    },
    "joko-kemplang7-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-kemplang7-breki (npm) (GHSA-v73w-4pwj-42rf)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-v73w-4pwj-42rf"
    },
    "joko-kemplang60-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in joko-kemplang60-sukiwir (npm) (GHSA-r5jv-hgv6-x875)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-r5jv-hgv6-x875"
    },
    "joko-kepok57-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-kepok57-riris (npm) (GHSA-p4jj-gg4r-c4jc)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-p4jj-gg4r-c4jc"
    },
    "joko-kemplang79-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-kemplang79-breki (npm) (GHSA-f3x8-35wc-fp3w)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-f3x8-35wc-fp3w"
    },
    "joko-kepok64-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-kepok64-riris (npm) (GHSA-c39m-cc55-9mq7)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-c39m-cc55-9mq7"
    },
    "joko-kepok30-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in joko-kepok30-sukiwir (npm) (GHSA-v465-j258-vr6v)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-v465-j258-vr6v"
    },
    "joko-kentang37-wekto": {
      blocked_all: true,
      reason: "Malicious code in joko-kentang37-wekto (npm) (GHSA-rxg5-8v5q-9x83)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-rxg5-8v5q-9x83"
    },
    "joko-kemplang66-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-kemplang66-riris (npm) (GHSA-h947-wrwj-p39j)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-h947-wrwj-p39j"
    },
    "joko-kembang64-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-kembang64-riris (npm) (GHSA-74vq-4xxm-fmvc)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-74vq-4xxm-fmvc"
    },
    "joko-kemplang47-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-kemplang47-breki (npm) (GHSA-h2qx-j5vx-w8h3)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-h2qx-j5vx-w8h3"
    },
    "joko-kembang53-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-kembang53-breki (npm) (GHSA-j7r7-4rgv-p4p9)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-j7r7-4rgv-p4p9"
    },
    "joko-kembang58-miaww": {
      blocked_all: true,
      reason: "Malicious code in joko-kembang58-miaww (npm) (GHSA-m637-46w8-rvmq)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-m637-46w8-rvmq"
    },
    "joko-kembang42-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in joko-kembang42-sukiwir (npm) (GHSA-hrhg-7m2v-945f)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-hrhg-7m2v-945f"
    },
    "joko-kembang98-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-kembang98-riris (npm) (GHSA-38wv-m2xp-v8g3)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-38wv-m2xp-v8g3"
    },
    "joko-kembang49-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in joko-kembang49-sukiwir (npm) (GHSA-qqj8-3gj6-m6xc)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-qqj8-3gj6-m6xc"
    },
    "joko-kembang90-ruro": {
      blocked_all: true,
      reason: "Malicious code in joko-kembang90-ruro (npm) (GHSA-565q-jgxr-g88r)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-565q-jgxr-g88r"
    },
    "joko-kemplang45-kyuki": {
      blocked_all: true,
      reason: "Malicious code in joko-kemplang45-kyuki (npm) (GHSA-58mq-57hm-vf2x)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-58mq-57hm-vf2x"
    },
    "joko-kembang90-miaww": {
      blocked_all: true,
      reason: "Malicious code in joko-kembang90-miaww (npm) (GHSA-3w3x-2v3h-p2m6)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-3w3x-2v3h-p2m6"
    },
    "joko-kemplang16-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in joko-kemplang16-sukiwir (npm) (GHSA-gmg4-qcm7-hfhg)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-gmg4-qcm7-hfhg"
    },
    "joko-kacang44-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-kacang44-breki (npm) (GHSA-8fgh-g836-v3w4)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-8fgh-g836-v3w4"
    },
    "joko-jus98-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-jus98-sluey (npm) (GHSA-55hv-2gv6-g7g8)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-55hv-2gv6-g7g8"
    },
    "joko-kembang2-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-kembang2-sluey (npm) (GHSA-x569-9pfw-vj96)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-x569-9pfw-vj96"
    },
    "joko-kacang87-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-kacang87-riris (npm) (GHSA-phhq-q665-j2fh)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-phhq-q665-j2fh"
    },
    "joko-kacang44-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-kacang44-sluey (npm) (GHSA-w249-hg9c-vgf3)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-w249-hg9c-vgf3"
    },
    "joko-kembang28-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-kembang28-sluey (npm) (GHSA-g24r-8mvx-g9mf)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-g24r-8mvx-g9mf"
    },
    "joko-kacang62-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in joko-kacang62-sukiwir (npm) (GHSA-qp84-7m2q-ph36)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-qp84-7m2q-ph36"
    },
    "joko-kacang93-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-kacang93-breki (npm) (GHSA-557v-4hjg-59mp)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-557v-4hjg-59mp"
    },
    "joko-kacang92-breki": {
      blocked_all: true,
      reason: "Malicious code in joko-kacang92-breki (npm) (GHSA-w695-2j6r-6q36)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-w695-2j6r-6q36"
    },
    "joko-kacang41-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in joko-kacang41-sukiwir (npm) (GHSA-f6mc-fv32-g25w)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-f6mc-fv32-g25w"
    },
    "joko-jus93-pore": {
      blocked_all: true,
      reason: "Malicious code in joko-jus93-pore (npm) (GHSA-wf44-7gxc-m5jr)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-wf44-7gxc-m5jr"
    },
    "joko-kacang39-riris": {
      blocked_all: true,
      reason: "Malicious code in joko-kacang39-riris (npm) (GHSA-6g9w-6qrc-mw65)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-6g9w-6qrc-mw65"
    },
    "joko-kacang6-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-kacang6-sluey (npm) (GHSA-g8q5-6rqf-5764)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-g8q5-6rqf-5764"
    },
    "joko-jengkol78-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in joko-jengkol78-sukiwir (npm) (GHSA-c8cx-6r92-37hq)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-c8cx-6r92-37hq"
    },
    "joko-jengkol30-sluey": {
      blocked_all: true,
      reason: "Malicious code in joko-jengkol30-sluey (npm) (GHSA-8gq9-xvf4-wf53)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-8gq9-xvf4-wf53"
    },
    "joko-jamblang90-ruro": {
      blocked_all: true,
      reason: "Malicious code in joko-jamblang90-ruro (npm) (GHSA-4hhp-527w-vwf5)",
      date: "2026-09-13",
      advisory: "https://github.com/advisories/GHSA-4hhp-527w-vwf5"
    },
    "@biz44/process-runtime-utils": {
      blocked_all: true,
      reason: "Malicious code in @biz44/process-runtime-utils (npm) (GHSA-85j9-pqgv-pr94)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-85j9-pqgv-pr94"
    },
    "@biz44/runtime-utils": {
      blocked_all: true,
      reason: "Malicious code in @biz44/runtime-utils (npm) (GHSA-fc79-g66m-pjph)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-fc79-g66m-pjph"
    },
    "@biz44/id99-client": {
      blocked_all: true,
      reason: "Malicious code in @biz44/id99-client (npm) (GHSA-2r46-q2c6-8xv3)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-2r46-q2c6-8xv3"
    },
    "@biz44/id44-client": {
      blocked_all: true,
      reason: "Malicious code in @biz44/id44-client (npm) (GHSA-5j4q-j7xc-mcjq)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-5j4q-j7xc-mcjq"
    },
    "id79-client": {
      blocked_all: true,
      reason: "Malicious code in id79-client (npm) (GHSA-c62r-crr7-5qfm)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-c62r-crr7-5qfm"
    },
    "@biz44/id95-client": {
      blocked_all: true,
      reason: "Malicious code in @biz44/id95-client (npm) (GHSA-h5qm-2mw2-cpj7)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-h5qm-2mw2-cpj7"
    },
    "@biz44/id79-client": {
      blocked_all: true,
      reason: "Malicious code in @biz44/id79-client (npm) (GHSA-38g4-jrgw-cqgh)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-38g4-jrgw-cqgh"
    },
    "@biz44/id12-client": {
      blocked_all: true,
      reason: "Malicious code in @biz44/id12-client (npm) (GHSA-57p7-wfrw-75gv)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-57p7-wfrw-75gv"
    },
    "@biz44/id10-client": {
      blocked_all: true,
      reason: "Malicious code in @biz44/id10-client (npm) (GHSA-3fp9-rc4g-j5v2)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-3fp9-rc4g-j5v2"
    },
    "n8n-nodes-sysdiag2": {
      blocked_all: true,
      reason: "Malicious code in n8n-nodes-sysdiag2 (npm) (GHSA-mx46-3mx3-r66x)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-mx46-3mx3-r66x"
    },
    "@yggbrasil/api": {
      blocked_all: true,
      reason: "Malware in @yggbrasil/api (GHSA-cmxv-8vgc-m43c)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-cmxv-8vgc-m43c"
    },
    "get-power": {
      blocked_all: true,
      reason: "Malicious code in get-power (npm) (GHSA-pjxw-c7p6-x2gq)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-pjxw-c7p6-x2gq"
    },
    "app-rrhh": {
      blocked_all: true,
      reason: "Malicious code in app-rrhh (npm) (GHSA-c9r8-qhjh-h69j)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-c9r8-qhjh-h69j"
    },
    "web-main": {
      blocked_all: true,
      reason: "Malicious code in web-main (npm) (GHSA-mq47-gfmg-59pp)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-mq47-gfmg-59pp"
    },
    "@aiwfm/communitywfm.scripts.api": {
      blocked_all: true,
      reason: "Malicious code in @aiwfm/communitywfm.scripts.api (npm) (GHSA-cj6r-j9c8-88qp)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-cj6r-j9c8-88qp"
    },
    "sql-limit-enforcer": {
      blocked_all: true,
      reason: "Malicious code in sql-limit-enforcer (npm) (GHSA-vjjr-9qv2-mh33)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-vjjr-9qv2-mh33"
    },
    "strapi-plugin-os-info-meeb322k": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-os-info-meeb322k (npm) (GHSA-3jh2-p873-gc7r)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-3jh2-p873-gc7r"
    },
    postgreesqlhelper: {
      blocked_all: true,
      reason: "Malicious code in postgreesqlhelper (npm) (GHSA-87qj-rx96-4w66)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-87qj-rx96-4w66"
    },
    "n8n-nodes-sysdiag": {
      blocked_all: true,
      reason: "Malicious code in n8n-nodes-sysdiag (npm) (GHSA-mfvv-xhj7-524c)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-mfvv-xhj7-524c"
    },
    "noblox-asset.js": {
      blocked_all: true,
      reason: "Malicious code in noblox-asset.js (npm) (GHSA-9pp6-m94w-8jhp)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-9pp6-m94w-8jhp"
    },
    "os-info-meeb322k": {
      blocked_all: true,
      reason: "Malicious code in os-info-meeb322k (npm) (GHSA-5wwx-6p5f-p9vh)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-5wwx-6p5f-p9vh"
    },
    "concierge-sdk": {
      blocked_all: true,
      reason: "Malicious code in concierge-sdk (npm) (GHSA-7gx4-hj9w-hx25)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-7gx4-hj9w-hx25"
    },
    "ultra-ws": {
      blocked_all: true,
      reason: "Malicious code in ultra-ws (npm) (GHSA-h35p-624w-rrp4)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-h35p-624w-rrp4"
    },
    "pino-ulid": {
      blocked_all: true,
      reason: "Malicious code in pino-ulid (npm) (GHSA-5qw6-rpv6-623h)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-5qw6-rpv6-623h"
    },
    afhmxiewpsf: {
      blocked_all: true,
      reason: "Malware in afhmxiewpsf (GHSA-59f6-ch49-395j)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-59f6-ch49-395j"
    },
    "expect-dotenv": {
      blocked_all: true,
      reason: "Malware in expect-dotenv (GHSA-h7q6-7chv-cgh2)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-h7q6-7chv-cgh2"
    },
    "@gfe/lx-watcher": {
      blocked_all: true,
      reason: "Malware in @gfe/lx-watcher (GHSA-wg37-hw83-hqwf)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-wg37-hw83-hqwf"
    },
    "meraz-project-tracker": {
      blocked_all: true,
      reason: "Malware in meraz-project-tracker (GHSA-54v8-j59m-366h)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-54v8-j59m-366h"
    },
    "@merazmz/project-tracker": {
      blocked_all: true,
      reason: "Malware in @merazmz/project-tracker (GHSA-x98w-cqq8-v3q2)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-x98w-cqq8-v3q2"
    },
    lpulogin: {
      blocked_all: true,
      reason: "Malware in lpulogin (GHSA-5823-3hg3-27v8)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-5823-3hg3-27v8"
    },
    dilxztech: {
      blocked_all: true,
      reason: "Malware in dilxztech (GHSA-5wh2-j94m-rwpf)",
      date: "2026-09-14",
      advisory: "https://github.com/advisories/GHSA-5wh2-j94m-rwpf"
    },
    jexkcode: {
      blocked_all: true,
      reason: "Malicious code in jexkcode (npm) (GHSA-g9xj-rjfw-h7h6)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-g9xj-rjfw-h7h6"
    },
    "bender-rspack-config": {
      blocked_all: true,
      reason: "Malicious code in bender-rspack-config (npm) (GHSA-xq97-9c5h-5m43)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-xq97-9c5h-5m43"
    },
    swnwall: {
      blocked_all: true,
      reason: "Malicious code in swnwall (npm) (GHSA-8p3w-gp6g-xf77)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-8p3w-gp6g-xf77"
    },
    "strapi-plugin-pencc-meeb": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-pencc-meeb (npm) (GHSA-77mj-c6xm-92j2)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-77mj-c6xm-92j2"
    },
    "strapi-plugin-ccsuc-meeb": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-ccsuc-meeb (npm) (GHSA-g2q3-qp84-8cj7)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-g2q3-qp84-8cj7"
    },
    "chai-as-agile": {
      blocked_all: true,
      reason: "Malicious code in chai-as-agile (npm) (GHSA-5724-m8w6-w6g2)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-5724-m8w6-w6g2"
    },
    "@prime0/inimatch": {
      blocked_all: true,
      reason: "Malicious code in @prime0/inimatch (npm) (GHSA-853x-jxp5-rq5c)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-853x-jxp5-rq5c"
    },
    "@prime0/pcomatch": {
      blocked_all: true,
      reason: "Malicious code in @prime0/pcomatch (npm) (GHSA-736x-m99h-5pfg)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-736x-m99h-5pfg"
    },
    tol8t: {
      blocked_all: true,
      reason: "Malicious code in tol8t (npm) (GHSA-69x6-h25v-58j2)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-69x6-h25v-58j2"
    },
    "@prime0/alanced-match": {
      blocked_all: true,
      reason: "Malicious code in @prime0/alanced-match (npm) (GHSA-wr38-cc44-847g)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-wr38-cc44-847g"
    },
    tetomood: {
      blocked_all: true,
      reason: "Malicious code in tetomood (npm) (GHSA-wwxg-wcx2-44fm)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-wwxg-wcx2-44fm"
    },
    "discord-resolvers": {
      blocked_all: true,
      reason: "Malicious code in discord-resolvers (npm) (GHSA-m6rp-5w7c-9q45)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-m6rp-5w7c-9q45"
    },
    engin1: {
      blocked_all: true,
      reason: "Malicious code in engin1 (npm) (GHSA-8v43-g45f-4c59)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-8v43-g45f-4c59"
    },
    tetotest: {
      blocked_all: true,
      reason: "Malicious code in tetotest (npm) (GHSA-25v6-77x2-2mwr)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-25v6-77x2-2mwr"
    },
    "otel-span-adapter": {
      blocked_all: true,
      reason: "Malicious code in otel-span-adapter (npm) (GHSA-f4c7-58f5-g8r9)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-f4c7-58f5-g8r9"
    },
    "discord-players": {
      blocked_all: true,
      reason: "Malicious code in discord-players (npm) (GHSA-qgp7-rhmr-pjmc)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-qgp7-rhmr-pjmc"
    },
    plogme: {
      blocked_all: true,
      reason: "Malicious code in plogme (npm) (GHSA-q276-hmjg-47qw)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-q276-hmjg-47qw"
    },
    webpackbootstrapscripts: {
      blocked_all: true,
      reason: "Malicious code in webpackbootstrapscripts (npm) (GHSA-prhx-w9qf-6qqh)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-prhx-w9qf-6qqh"
    },
    "@zaka13/thing": {
      blocked_all: true,
      reason: "Malicious code in @zaka13/thing (npm) (GHSA-m9vr-9hpp-v65x)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-m9vr-9hpp-v65x"
    },
    webpackbootstrap5: {
      blocked_all: true,
      reason: "Malicious code in webpackbootstrap5 (npm) (GHSA-wvx4-99w4-gwvh)",
      date: "2026-09-16",
      advisory: "https://github.com/advisories/GHSA-wvx4-99w4-gwvh"
    },
    "kartykp-prod-oidc-test-pkg": {
      blocked_all: true,
      reason: "Malware in kartykp-prod-oidc-test-pkg (GHSA-v7jq-fcmp-3w93)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-v7jq-fcmp-3w93"
    },
    "kartykp-token-pkg": {
      blocked_all: true,
      reason: "Malware in kartykp-token-pkg (GHSA-6qx5-2w7p-cf29)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-6qx5-2w7p-cf29"
    },
    "strapi-plugin-yayccresh-meeb": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-yayccresh-meeb (npm) (GHSA-rw9q-wchq-m3jv)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-rw9q-wchq-m3jv"
    },
    "strapi-plugin-tryccresh-meeb": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-tryccresh-meeb (npm) (GHSA-cph2-r8rf-9v67)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-cph2-r8rf-9v67"
    },
    "strapi-plugin-weccresh-meeb": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-weccresh-meeb (npm) (GHSA-6mvh-5g6x-2jhr)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-6mvh-5g6x-2jhr"
    },
    "strapi-plugin-revs01-meeb322k": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-revs01-meeb322k (npm) (GHSA-f8wr-jqjq-4vvf)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-f8wr-jqjq-4vvf"
    },
    "chai-as-crack": {
      blocked_all: true,
      reason: "Malicious code in chai-as-crack (npm) (GHSA-9q54-rq2g-8m87)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-9q54-rq2g-8m87"
    },
    "strapi-plugin-ccresh-meeb": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-ccresh-meeb (npm) (GHSA-64x7-hw7m-2wrx)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-64x7-hw7m-2wrx"
    },
    "strapi-plugin-proccresh-meeb": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-proccresh-meeb (npm) (GHSA-46m5-637h-jmhh)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-46m5-637h-jmhh"
    },
    "strapi-plugin-revs02-meeb322k": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-revs02-meeb322k (npm) (GHSA-c4gc-cwxr-w524)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-c4gc-cwxr-w524"
    },
    "strapi-plugin-revsh-meeb322k": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-revsh-meeb322k (npm) (GHSA-8ccq-6g42-37vx)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-8ccq-6g42-37vx"
    },
    "strapi-plugin-uicc-meeb": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-uicc-meeb (npm) (GHSA-77cj-57r4-c4fv)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-77cj-57r4-c4fv"
    },
    "strapi-plugin-rs-meeb322k": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-rs-meeb322k (npm) (GHSA-xjgc-fw8x-c3xj)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-xjgc-fw8x-c3xj"
    },
    "strapi-plugin-yesccresh-meeb": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-yesccresh-meeb (npm) (GHSA-3xqj-h67p-8m5w)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-3xqj-h67p-8m5w"
    },
    "strapi-plugin-revs-meeb322k": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-revs-meeb322k (npm) (GHSA-8pr6-ghc9-rm9v)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-8pr6-ghc9-rm9v"
    },
    "strapi-plugin-sucresh-meeb": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-sucresh-meeb (npm) (GHSA-whqm-wv8m-mvmr)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-whqm-wv8m-mvmr"
    },
    alkajsdfoiwqeusdflkjsdf: {
      blocked_all: true,
      reason: "Malicious code in alkajsdfoiwqeusdflkjsdf (npm) (GHSA-5cjw-7pgr-hg89)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-5cjw-7pgr-hg89"
    },
    "strapi-plugin-plsresh-meeb": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-plsresh-meeb (npm) (GHSA-vm7q-xcf2-26r8)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-vm7q-xcf2-26r8"
    },
    "strapi-plugin-resh-meeb322k": {
      blocked_all: true,
      reason: "Malicious code in strapi-plugin-resh-meeb322k (npm) (GHSA-m8xh-7643-8frr)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-m8xh-7643-8frr"
    },
    "n8n-nodes-buildcheck": {
      blocked_all: true,
      reason: "Malicious code in n8n-nodes-buildcheck (npm) (GHSA-39q8-5c9h-rj8c)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-39q8-5c9h-rj8c"
    },
    "fulfillment-cuprum-auth-widget": {
      blocked_all: true,
      reason: "Malicious code in fulfillment-cuprum-auth-widget (npm) (GHSA-wh94-xh5h-j48v)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-wh94-xh5h-j48v"
    },
    "process-tailwind": {
      blocked_all: true,
      reason: "Malicious code in process-tailwind (npm) (GHSA-qm95-54f4-jjg8)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-qm95-54f4-jjg8"
    },
    "csa-mfa": {
      blocked_all: true,
      reason: "Malicious code in csa-mfa (npm) (GHSA-gqh9-2j3v-c5g6)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-gqh9-2j3v-c5g6"
    },
    "process-lhpm": {
      blocked_all: true,
      reason: "Malicious code in process-lhpm (npm) (GHSA-8x79-9h94-vj8g)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-8x79-9h94-vj8g"
    },
    "tailwind-forms-styles": {
      blocked_all: true,
      reason: "Malware in tailwind-forms-styles (GHSA-q8wp-7xrg-83rx)",
      date: "2026-09-15",
      advisory: "https://github.com/advisories/GHSA-q8wp-7xrg-83rx"
    },
    "leda-middleware-pm2-impulse": {
      blocked_all: true,
      reason: "Malicious code in leda-middleware-pm2-impulse (npm) (GHSA-f2c3-57jx-9x3q)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-f2c3-57jx-9x3q"
    },
    "leda-javascript-stream-husky": {
      blocked_all: true,
      reason: "Malicious code in leda-javascript-stream-husky (npm) (GHSA-g577-73x2-6ghp)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-g577-73x2-6ghp"
    },
    "leda-loopback-markdown-pdf-quasar": {
      blocked_all: true,
      reason: "Malicious code in leda-loopback-markdown-pdf-quasar (npm) (GHSA-qh9x-rc75-rmrp)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-qh9x-rc75-rmrp"
    },
    "leda-morgan-xanthus-ophiuchus": {
      blocked_all: true,
      reason: "Malicious code in leda-morgan-xanthus-ophiuchus (npm) (GHSA-4wh2-qfjv-6m8q)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-4wh2-qfjv-6m8q"
    },
    "leda-koa-dotenv-safe-atlas": {
      blocked_all: true,
      reason: "Malicious code in leda-koa-dotenv-safe-atlas (npm) (GHSA-27f6-c6rq-962q)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-27f6-c6rq-962q"
    },
    "leda-nodejs-nextjs-sirius": {
      blocked_all: true,
      reason: "Malicious code in leda-nodejs-nextjs-sirius (npm) (GHSA-hrmm-3r4r-m4xv)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-hrmm-3r4r-m4xv"
    },
    "leda-miranda-oberon-capella": {
      blocked_all: true,
      reason: "Malicious code in leda-miranda-oberon-capella (npm) (GHSA-mq57-rgj3-q6g2)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-mq57-rgj3-q6g2"
    },
    "leda-metalsmith-cassini-avior": {
      blocked_all: true,
      reason: "Malicious code in leda-metalsmith-cassini-avior (npm) (GHSA-q9hg-cr2r-j4gc)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-q9hg-cr2r-j4gc"
    },
    "leda-kaus-bellatrix-leda": {
      blocked_all: true,
      reason: "Malicious code in leda-kaus-bellatrix-leda (npm) (GHSA-v97p-hpv8-cfgj)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-v97p-hpv8-cfgj"
    },
    "leda-jsonp-dependencies-eslint-config": {
      blocked_all: true,
      reason: "Malicious code in leda-jsonp-dependencies-eslint-config (npm) (GHSA-3rp3-759c-jj5h)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-3rp3-759c-jj5h"
    },
    "leda-pegasus-magnetosphere-sagitta": {
      blocked_all: true,
      reason: "Malicious code in leda-pegasus-magnetosphere-sagitta (npm) (GHSA-xmr8-6fh3-mpv9)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-xmr8-6fh3-mpv9"
    },
    "leda-npm-chai-sync": {
      blocked_all: true,
      reason: "Malicious code in leda-npm-chai-sync (npm) (GHSA-jhv6-qvjh-gw62)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-jhv6-qvjh-gw62"
    },
    "leda-mini-css-extract-plugin-backend-radiant": {
      blocked_all: true,
      reason: "Malicious code in leda-mini-css-extract-plugin-backend-radiant (npm) (GHSA-r469-4jv5-mx98)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-r469-4jv5-mx98"
    },
    "leda-development-config-eclipse": {
      blocked_all: true,
      reason: "Malicious code in leda-development-config-eclipse (npm) (GHSA-44x8-rr9w-fr9w)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-44x8-rr9w-fr9w"
    },
    "leda-docusaurus-dactyl-ignite": {
      blocked_all: true,
      reason: "Malicious code in leda-docusaurus-dactyl-ignite (npm) (GHSA-h6pr-xhjh-wmg5)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-h6pr-xhjh-wmg5"
    },
    "leda-janus-solis-dynamo": {
      blocked_all: true,
      reason: "Malicious code in leda-janus-solis-dynamo (npm) (GHSA-2pwf-5f76-r5qm)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-2pwf-5f76-r5qm"
    },
    "leda-jabbah-exec-prettier-stylelint": {
      blocked_all: true,
      reason: "Malicious code in leda-jabbah-exec-prettier-stylelint (npm) (GHSA-q57q-g7hp-g9vx)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-q57q-g7hp-g9vx"
    },
    "leda-commitizen-markdown-ariel": {
      blocked_all: true,
      reason: "Malicious code in leda-commitizen-markdown-ariel (npm) (GHSA-7cgw-f4vc-3758)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-7cgw-f4vc-3758"
    },
    "leda-hydra-pm2-indus": {
      blocked_all: true,
      reason: "Malicious code in leda-hydra-pm2-indus (npm) (GHSA-24w8-q855-3cvp)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-24w8-q855-3cvp"
    },
    "leda-farout-alphard-kastra": {
      blocked_all: true,
      reason: "Malicious code in leda-farout-alphard-kastra (npm) (GHSA-9fqg-8qj9-f873)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-9fqg-8qj9-f873"
    },
    "leda-envconfig-odin-sass-loader": {
      blocked_all: true,
      reason: "Malicious code in leda-envconfig-odin-sass-loader (npm) (GHSA-8mg3-8qp8-w6vx)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-8mg3-8qp8-w6vx"
    },
    "leda-configstore-fornax-mui": {
      blocked_all: true,
      reason: "Malicious code in leda-configstore-fornax-mui (npm) (GHSA-r3ff-3pvj-572f)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-r3ff-3pvj-572f"
    },
    "leda-betelgeuse-chariklo-backend": {
      blocked_all: true,
      reason: "Malicious code in leda-betelgeuse-chariklo-backend (npm) (GHSA-wx6g-fr2m-496g)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-wx6g-fr2m-496g"
    },
    "leda-acamar-sequelize-sass-loader": {
      blocked_all: true,
      reason: "Malicious code in leda-acamar-sequelize-sass-loader (npm) (GHSA-wvmh-hpmq-6r79)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-wvmh-hpmq-6r79"
    },
    "leda-element-ui-radiant-sagitta": {
      blocked_all: true,
      reason: "Malicious code in leda-element-ui-radiant-sagitta (npm) (GHSA-pvxm-7q9r-84pc)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-pvxm-7q9r-84pc"
    },
    "leda-gemini-saturnology-jovian": {
      blocked_all: true,
      reason: "Malicious code in leda-gemini-saturnology-jovian (npm) (GHSA-7jh7-3hhj-8v2g)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-7jh7-3hhj-8v2g"
    },
    "leda-cassini-wasat-aldebaran": {
      blocked_all: true,
      reason: "Malicious code in leda-cassini-wasat-aldebaran (npm) (GHSA-fmx5-446p-9pgq)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-fmx5-446p-9pgq"
    },
    "leda-command-aquarius-leda": {
      blocked_all: true,
      reason: "Malicious code in leda-command-aquarius-leda (npm) (GHSA-gcfw-fvmc-qjj3)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-gcfw-fvmc-qjj3"
    },
    "leda-command-superagent-cache": {
      blocked_all: true,
      reason: "Malicious code in leda-command-superagent-cache (npm) (GHSA-mpcg-cwp5-wr49)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-mpcg-cwp5-wr49"
    },
    "leda-cassini-dactyl-mongodb": {
      blocked_all: true,
      reason: "Malicious code in leda-cassini-dactyl-mongodb (npm) (GHSA-q8qp-7pr5-mqfm)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-q8qp-7pr5-mqfm"
    },
    "leda-jabbah-google-rigel": {
      blocked_all: true,
      reason: "Malicious code in leda-jabbah-google-rigel (npm) (GHSA-95qv-j43m-33wq)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-95qv-j43m-33wq"
    },
    "leda-dependencies-fomalhaut-rocket": {
      blocked_all: true,
      reason: "Malicious code in leda-dependencies-fomalhaut-rocket (npm) (GHSA-2pxp-mh6m-8c9p)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-2pxp-mh6m-8c9p"
    },
    "leda-grus-bellatrix-docusaurus": {
      blocked_all: true,
      reason: "Malicious code in leda-grus-bellatrix-docusaurus (npm) (GHSA-wr95-chpp-728f)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-wr95-chpp-728f"
    },
    "leda-geckodriver-miranda-helios": {
      blocked_all: true,
      reason: "Malicious code in leda-geckodriver-miranda-helios (npm) (GHSA-675v-cc8h-26hh)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-675v-cc8h-26hh"
    },
    "leda-convict-commitizen-cassini": {
      blocked_all: true,
      reason: "Malicious code in leda-convict-commitizen-cassini (npm) (GHSA-26v2-hh52-45p7)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-26v2-hh52-45p7"
    },
    "leda-capella-celeste-spawn": {
      blocked_all: true,
      reason: "Malicious code in leda-capella-celeste-spawn (npm) (GHSA-jwfv-2mx3-pc7h)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-jwfv-2mx3-pc7h"
    },
    "leda-andromeda-spectron-neptune": {
      blocked_all: true,
      reason: "Malicious code in leda-andromeda-spectron-neptune (npm) (GHSA-jv39-qjq4-44cg)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-jv39-qjq4-44cg"
    },
    "leda-hercules-restart-upgrade": {
      blocked_all: true,
      reason: "Malicious code in leda-hercules-restart-upgrade (npm) (GHSA-38m8-xpxj-93x7)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-38m8-xpxj-93x7"
    },
    "leda-fornax-dagda-css-loader": {
      blocked_all: true,
      reason: "Malicious code in leda-fornax-dagda-css-loader (npm) (GHSA-3xjq-g72j-j37x)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-3xjq-g72j-j37x"
    },
    "leda-eslint-leda-electron": {
      blocked_all: true,
      reason: "Malicious code in leda-eslint-leda-electron (npm) (GHSA-98v4-4mv2-6h3p)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-98v4-4mv2-6h3p"
    },
    "leda-epigenetics-redshift-geochronology": {
      blocked_all: true,
      reason: "Malicious code in leda-epigenetics-redshift-geochronology (npm) (GHSA-ph53-52f9-grxq)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-ph53-52f9-grxq"
    },
    "leda-electron-builder-chromedriver-nodemon": {
      blocked_all: true,
      reason: "Malicious code in leda-electron-builder-chromedriver-nodemon (npm) (GHSA-p75m-j2jh-chvj)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-p75m-j2jh-chvj"
    },
    "leda-async-nodejs-izar": {
      blocked_all: true,
      reason: "Malicious code in leda-async-nodejs-izar (npm) (GHSA-xhqg-9q25-mfmm)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-xhqg-9q25-mfmm"
    },
    "leda-bulma-rate-limiter-delphinus": {
      blocked_all: true,
      reason: "Malicious code in leda-bulma-rate-limiter-delphinus (npm) (GHSA-q945-g9pr-8gw6)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-q945-g9pr-8gw6"
    },
    lectron: {
      blocked_all: true,
      reason: "Malicious code in lectron (npm) (GHSA-v54x-v8hh-4688)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-v54x-v8hh-4688"
    },
    "leatherman-js": {
      blocked_all: true,
      reason: "Malicious code in leatherman-js (npm) (GHSA-vw45-233j-4v86)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-vw45-233j-4v86"
    },
    learning_npm1: {
      blocked_all: true,
      reason: "Malicious code in learning_npm1 (npm) (GHSA-8wh6-2j2q-48m4)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-8wh6-2j2q-48m4"
    },
    "leading_dragon_plum-2": {
      blocked_all: true,
      reason: "Malicious code in leading_dragon_plum-2 (npm) (GHSA-gg52-3hg8-j369)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-gg52-3hg8-j369"
    },
    leading_chinchilla_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_chinchilla_z3n (npm) (GHSA-ffr5-wmrg-m94q)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-ffr5-wmrg-m94q"
    },
    leading_chimpanzee_0xrequest: {
      blocked_all: true,
      reason: "Malicious code in leading_chimpanzee_0xrequest (npm) (GHSA-v459-fp26-4hmg)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-v459-fp26-4hmg"
    },
    "leading-teal-minnow": {
      blocked_all: true,
      reason: "Malicious code in leading-teal-minnow (npm) (GHSA-66gf-w3jm-fr2h)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-66gf-w3jm-fr2h"
    },
    "leading-rose-heron": {
      blocked_all: true,
      reason: "Malicious code in leading-rose-heron (npm) (GHSA-gvjh-rhh5-35x6)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-gvjh-rhh5-35x6"
    },
    lebardon: {
      blocked_all: true,
      reason: "Malicious code in lebardon (npm) (GHSA-h9cq-5c7m-f6m8)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-h9cq-5c7m-f6m8"
    },
    "learnx-zh": {
      blocked_all: true,
      reason: "Malicious code in learnx-zh (npm) (GHSA-pvv6-gmg7-fmc4)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-pvv6-gmg7-fmc4"
    },
    "lean-coffee": {
      blocked_all: true,
      reason: "Malicious code in lean-coffee (npm) (GHSA-qcc6-w76j-gm83)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-qcc6-w76j-gm83"
    },
    leading_rhinoceros_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_rhinoceros_z3n (npm) (GHSA-jvcf-qx6m-r2x2)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-jvcf-qx6m-r2x2"
    },
    leading_bass_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_bass_z3n (npm) (GHSA-7fg3-8m6c-q2mf)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-7fg3-8m6c-q2mf"
    },
    leading_bison_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_bison_z3n (npm) (GHSA-52gr-cgg3-9qrc)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-52gr-cgg3-9qrc"
    },
    leading_buzzard_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_buzzard_z3n (npm) (GHSA-w65p-pgqm-c4jf)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-w65p-pgqm-c4jf"
    },
    learns: {
      blocked_all: true,
      reason: "Malicious code in learns (npm) (GHSA-qjg4-3j5r-pfpq)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-qjg4-3j5r-pfpq"
    },
    leading_squid_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_squid_z3n (npm) (GHSA-78p2-fp2v-wmj8)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-78p2-fp2v-wmj8"
    },
    leading_sheep_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_sheep_z3n (npm) (GHSA-p55g-v5pf-mp2q)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-p55g-v5pf-mp2q"
    },
    leading_crab_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_crab_z3n (npm) (GHSA-xqc6-3g29-88qf)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-xqc6-3g29-88qf"
    },
    leading_cicada_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_cicada_z3n (npm) (GHSA-6p7c-cpgr-4973)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-6p7c-cpgr-4973"
    },
    leapviz: {
      blocked_all: true,
      reason: "Malicious code in leapviz (npm) (GHSA-24m2-g38m-hvpv)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-24m2-g38m-hvpv"
    },
    "leandro-teadev": {
      blocked_all: true,
      reason: "Malicious code in leandro-teadev (npm) (GHSA-wgx3-6mq2-4h6w)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-wgx3-6mq2-4h6w"
    },
    leading_pig_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_pig_z3n (npm) (GHSA-g74p-qq5r-g375)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-g74p-qq5r-g375"
    },
    leading_mule_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_mule_z3n (npm) (GHSA-wjwg-wgmp-p2hg)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-wjwg-wgmp-p2hg"
    },
    leading_guppy_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_guppy_z3n (npm) (GHSA-9rfm-7rwg-jq5c)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-9rfm-7rwg-jq5c"
    },
    leading_bovid_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_bovid_z3n (npm) (GHSA-rphx-c448-4qpm)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-rphx-c448-4qpm"
    },
    leapboard: {
      blocked_all: true,
      reason: "Malicious code in leapboard (npm) (GHSA-hr3w-4v8v-57w6)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-hr3w-4v8v-57w6"
    },
    "leaflet-opencage-geocoding": {
      blocked_all: true,
      reason: "Malicious code in leaflet-opencage-geocoding (npm) (GHSA-5rpx-396x-xx2f)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-5rpx-396x-xx2f"
    },
    "leading_eel-smiletea": {
      blocked_all: true,
      reason: "Malicious code in leading_eel-smiletea (npm) (GHSA-q8fx-rx23-whqv)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-q8fx-rx23-whqv"
    },
    leading_herring_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_herring_z3n (npm) (GHSA-vh6p-g4pw-h2gw)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-vh6p-g4pw-h2gw"
    },
    leading_kingfisher_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_kingfisher_z3n (npm) (GHSA-vhwv-9j6w-gxqr)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-vhwv-9j6w-gxqr"
    },
    learnbdd: {
      blocked_all: true,
      reason: "Malicious code in learnbdd (npm) (GHSA-6hm4-r2gp-f6vf)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-6hm4-r2gp-f6vf"
    },
    leafbox: {
      blocked_all: true,
      reason: "Malicious code in leafbox (npm) (GHSA-485q-6g6q-m825)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-485q-6g6q-m825"
    },
    leaiss: {
      blocked_all: true,
      reason: "Malicious code in leaiss (npm) (GHSA-98fg-x9gr-m4m9)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-98fg-x9gr-m4m9"
    },
    leading_dragonfly_dumbs: {
      blocked_all: true,
      reason: "Malicious code in leading_dragonfly_dumbs (npm) (GHSA-m8gj-2p49-r98r)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-m8gj-2p49-r98r"
    },
    leading_lemming_0xrequest: {
      blocked_all: true,
      reason: "Malicious code in leading_lemming_0xrequest (npm) (GHSA-w4xp-26f7-775x)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-w4xp-26f7-775x"
    },
    leading_fish_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_fish_z3n (npm) (GHSA-g6c3-m9hq-9w22)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-g6c3-m9hq-9w22"
    },
    leading_gibbon_0xrequest: {
      blocked_all: true,
      reason: "Malicious code in leading_gibbon_0xrequest (npm) (GHSA-x79x-7mcp-9fmw)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-x79x-7mcp-9fmw"
    },
    "leafygreen-ui": {
      blocked_all: true,
      reason: "Malicious code in leafygreen-ui (npm) (GHSA-vgcc-f8fc-g79f)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-vgcc-f8fc-g79f"
    },
    leading_tuna_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_tuna_z3n (npm) (GHSA-c4w4-rhhj-9hgh)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-c4w4-rhhj-9hgh"
    },
    "leafygreen-docs": {
      blocked_all: true,
      reason: "Malicious code in leafygreen-docs (npm) (GHSA-8r92-58rh-h5m8)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-8r92-58rh-h5m8"
    },
    leading_swordfish_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_swordfish_z3n (npm) (GHSA-37rh-rrrp-6xv7)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-37rh-rrrp-6xv7"
    },
    leading_planarian_0xrequest: {
      blocked_all: true,
      reason: "Malicious code in leading_planarian_0xrequest (npm) (GHSA-ch4r-xv79-6xq6)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-ch4r-xv79-6xq6"
    },
    leading_quail_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_quail_z3n (npm) (GHSA-25h2-3wxj-wv5p)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-25h2-3wxj-wv5p"
    },
    leading_prawn_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_prawn_z3n (npm) (GHSA-wc62-x9pg-89fc)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-wc62-x9pg-89fc"
    },
    leading_falcon_z3n: {
      blocked_all: true,
      reason: "Malicious code in leading_falcon_z3n (npm) (GHSA-33vv-q37m-hx37)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-33vv-q37m-hx37"
    },
    "leadconduit-militarydotcom": {
      blocked_all: true,
      reason: "Malicious code in leadconduit-militarydotcom (npm) (GHSA-ghgm-c28v-q56x)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-ghgm-c28v-q56x"
    },
    "leadconduit-twitter": {
      blocked_all: true,
      reason: "Malicious code in leadconduit-twitter (npm) (GHSA-pmj6-5fvr-gcj8)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-pmj6-5fvr-gcj8"
    },
    "leadconduit-homesdotcom": {
      blocked_all: true,
      reason: "Malicious code in leadconduit-homesdotcom (npm) (GHSA-rg9m-gw22-wjhc)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-rg9m-gw22-wjhc"
    },
    ldhpgemrdhs92007: {
      blocked_all: true,
      reason: "Malicious code in ldhpgemrdhs92007 (npm) (GHSA-4cp3-9wjq-j865)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-4cp3-9wjq-j865"
    },
    leadcrm: {
      blocked_all: true,
      reason: "Malicious code in leadcrm (npm) (GHSA-v4wc-x47j-fv66)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-v4wc-x47j-fv66"
    },
    "leading-green-mink": {
      blocked_all: true,
      reason: "Malicious code in leading-green-mink (npm) (GHSA-ppq9-5587-5g3w)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-ppq9-5587-5g3w"
    },
    "leadconduit-zillow": {
      blocked_all: true,
      reason: "Malicious code in leadconduit-zillow (npm) (GHSA-xp9x-g8p3-f27q)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-xp9x-g8p3-f27q"
    },
    "leading-chocolate-roadrunner": {
      blocked_all: true,
      reason: "Malicious code in leading-chocolate-roadrunner (npm) (GHSA-mv5g-r8f2-4jq6)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-mv5g-r8f2-4jq6"
    },
    "leadconduit-whitepages": {
      blocked_all: true,
      reason: "Malicious code in leadconduit-whitepages (npm) (GHSA-44wj-cqc3-7jc2)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-44wj-cqc3-7jc2"
    },
    "leadconduit-versium": {
      blocked_all: true,
      reason: "Malicious code in leadconduit-versium (npm) (GHSA-wcwc-w55p-pxxg)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-wcwc-w55p-pxxg"
    },
    sinful: {
      blocked_all: true,
      reason: "Malware in sinful (GHSA-2xjj-r8mc-xpf6)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-2xjj-r8mc-xpf6"
    },
    "@sanzoffc/baileys": {
      blocked_all: true,
      reason: "Malicious code in @sanzoffc/baileys (npm) (GHSA-grqc-r63w-6845)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-grqc-r63w-6845"
    },
    "tailwindcss-form": {
      blocked_all: true,
      reason: "Malicious code in tailwindcss-form (npm) (GHSA-xhr7-h7hc-7785)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-xhr7-h7hc-7785"
    },
    "blue-string-formatter-utils": {
      blocked_all: true,
      reason: "Malicious code in blue-string-formatter-utils (npm) (GHSA-5mc6-ff2p-32qj)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-5mc6-ff2p-32qj"
    },
    "zero-baileys": {
      blocked_all: true,
      reason: "Malicious code in zero-baileys (npm) (GHSA-2q5p-vqh2-8c92)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-2q5p-vqh2-8c92"
    },
    xzvbailsx: {
      blocked_all: true,
      reason: "Malicious code in xzvbailsx (npm) (GHSA-m364-pjc8-42wc)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-m364-pjc8-42wc"
    },
    xzvbailey: {
      blocked_all: true,
      reason: "Malicious code in xzvbailey (npm) (GHSA-rg4j-jh5f-w982)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-rg4j-jh5f-w982"
    },
    xa424234657567: {
      blocked_all: true,
      reason: "Malicious code in xa424234657567 (npm) (GHSA-h7pm-6wh6-7xvw)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-h7pm-6wh6-7xvw"
    },
    "@lekzo/baileys": {
      blocked_all: true,
      reason: "Malicious code in @lekzo/baileys (npm) (GHSA-75mc-fj4c-6pfm)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-75mc-fj4c-6pfm"
    },
    "@tink/tink-link-core": {
      blocked_all: true,
      reason: "Malicious code in @tink/tink-link-core (npm) (GHSA-hvcc-qwg6-972c)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-hvcc-qwg6-972c"
    },
    "test89078-auth": {
      blocked_all: true,
      reason: "Malicious code in test89078-auth (npm) (GHSA-x9mp-cqw3-368c)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-x9mp-cqw3-368c"
    },
    "kartykgithub-multiversion-a": {
      blocked_all: true,
      reason: "Malware in kartykgithub-multiversion-a (GHSA-p957-4pc7-x6hp)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-p957-4pc7-x6hp"
    },
    "@railone/image-utils": {
      blocked_all: true,
      reason: "Malicious code in @railone/image-utils (npm) (GHSA-h72c-8fwp-p292)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-h72c-8fwp-p292"
    },
    "tailwindcss-form-ui": {
      blocked_all: true,
      reason: "Malicious code in tailwindcss-form-ui (npm) (GHSA-hxjv-cpxc-564m)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-hxjv-cpxc-564m"
    },
    "tailwindcss-form-utils": {
      blocked_all: true,
      reason: "Malicious code in tailwindcss-form-utils (npm) (GHSA-fm65-924g-pg2g)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-fm65-924g-pg2g"
    },
    "lisa-jamblang60-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-jamblang60-sluey (npm) (GHSA-r59m-hqhw-848c)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-r59m-hqhw-848c"
    },
    "lisa-jamblang9-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-jamblang9-sluey (npm) (GHSA-j332-339q-x927)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-j332-339q-x927"
    },
    "lisa-jamblang72-breki": {
      blocked_all: true,
      reason: "Malicious code in lisa-jamblang72-breki (npm) (GHSA-mpj7-hpwc-c7v4)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-mpj7-hpwc-c7v4"
    },
    "lisa-jamblang15-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in lisa-jamblang15-sukiwir (npm) (GHSA-3x2v-hmhg-pxj9)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-3x2v-hmhg-pxj9"
    },
    "lisa-jamblang16-remi": {
      blocked_all: true,
      reason: "Malicious code in lisa-jamblang16-remi (npm) (GHSA-h83g-rm38-rmfc)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-h83g-rm38-rmfc"
    },
    "lisa-gulai61-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in lisa-gulai61-sukiwir (npm) (GHSA-8mpg-5m8p-wcw7)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-8mpg-5m8p-wcw7"
    },
    "lisa-gulai37-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in lisa-gulai37-sukiwir (npm) (GHSA-3369-4xx7-cv2c)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-3369-4xx7-cv2c"
    },
    "lisa-ikan25-riris": {
      blocked_all: true,
      reason: "Malicious code in lisa-ikan25-riris (npm) (GHSA-xp28-3f2x-3j5v)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-xp28-3f2x-3j5v"
    },
    "lisa-gulai32-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-gulai32-sluey (npm) (GHSA-cf79-2m6r-r8wc)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-cf79-2m6r-r8wc"
    },
    "lisa-gudeg30-sumpek": {
      blocked_all: true,
      reason: "Malicious code in lisa-gudeg30-sumpek (npm) (GHSA-4xh7-mxv6-hx24)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-4xh7-mxv6-hx24"
    },
    "lisa-jus17-ruro": {
      blocked_all: true,
      reason: "Malicious code in lisa-jus17-ruro (npm) (GHSA-2939-4rc4-gwgw)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-2939-4rc4-gwgw"
    },
    "lisa-jengkol34-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-jengkol34-miaww (npm) (GHSA-c24q-4578-v2x7)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-c24q-4578-v2x7"
    },
    "lisa-ikan40-breki": {
      blocked_all: true,
      reason: "Malicious code in lisa-ikan40-breki (npm) (GHSA-xg5x-23mm-cpqw)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-xg5x-23mm-cpqw"
    },
    "lisa-gulai65-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in lisa-gulai65-sukiwir (npm) (GHSA-85hh-jqvp-8x89)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-85hh-jqvp-8x89"
    },
    "lisa-jengkol46-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-jengkol46-miaww (npm) (GHSA-qj73-5wfj-q4mh)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-qj73-5wfj-q4mh"
    },
    "lisa-gulai30-breki": {
      blocked_all: true,
      reason: "Malicious code in lisa-gulai30-breki (npm) (GHSA-4w4c-2mjf-phmf)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-4w4c-2mjf-phmf"
    },
    "lisa-gudeg42-riris": {
      blocked_all: true,
      reason: "Malicious code in lisa-gudeg42-riris (npm) (GHSA-5rvm-w2j4-3xp5)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-5rvm-w2j4-3xp5"
    },
    "lisa-gudeg59-breki": {
      blocked_all: true,
      reason: "Malicious code in lisa-gudeg59-breki (npm) (GHSA-g8vm-vq94-chc3)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-g8vm-vq94-chc3"
    },
    "lisa-getuk10-ruro": {
      blocked_all: true,
      reason: "Malicious code in lisa-getuk10-ruro (npm) (GHSA-rv5r-rqvj-h4wh)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-rv5r-rqvj-h4wh"
    },
    "lisa-gado-gado86-apidev": {
      blocked_all: true,
      reason: "Malicious code in lisa-gado-gado86-apidev (npm) (GHSA-878m-vqjr-gvvj)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-878m-vqjr-gvvj"
    },
    "lisa-gado-gado8-ruro": {
      blocked_all: true,
      reason: "Malicious code in lisa-gado-gado8-ruro (npm) (GHSA-4f7v-pghf-x9cm)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-4f7v-pghf-x9cm"
    },
    "lisa-getas76-ruro": {
      blocked_all: true,
      reason: "Malicious code in lisa-getas76-ruro (npm) (GHSA-393c-whh6-8qpw)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-393c-whh6-8qpw"
    },
    "lisa-getas81-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in lisa-getas81-sukiwir (npm) (GHSA-96jv-2hg6-f4wg)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-96jv-2hg6-f4wg"
    },
    "lisa-getas76-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-getas76-miaww (npm) (GHSA-g273-5c9w-fw8f)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-g273-5c9w-fw8f"
    },
    "lisa-getas23-apidev": {
      blocked_all: true,
      reason: "Malicious code in lisa-getas23-apidev (npm) (GHSA-99xq-2683-f596)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-99xq-2683-f596"
    },
    "lisa-gandul37-breki": {
      blocked_all: true,
      reason: "Malicious code in lisa-gandul37-breki (npm) (GHSA-7p6x-45gm-q8r6)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-7p6x-45gm-q8r6"
    },
    "lisa-esdoger16-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-esdoger16-miaww (npm) (GHSA-82gp-c3vm-2ghg)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-82gp-c3vm-2ghg"
    },
    "lisa-gado-gado88-ruro": {
      blocked_all: true,
      reason: "Malicious code in lisa-gado-gado88-ruro (npm) (GHSA-r872-cf42-w4hh)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-r872-cf42-w4hh"
    },
    "lisa-gorengan76-kyuki": {
      blocked_all: true,
      reason: "Malicious code in lisa-gorengan76-kyuki (npm) (GHSA-79hg-4gfq-v6hm)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-79hg-4gfq-v6hm"
    },
    "lisa-gorengan62-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-gorengan62-sluey (npm) (GHSA-w9fm-54j3-f476)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-w9fm-54j3-f476"
    },
    "lisa-esdoger24-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-esdoger24-miaww (npm) (GHSA-wx93-q3rv-xf84)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-wx93-q3rv-xf84"
    },
    "lisa-getas37-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-getas37-miaww (npm) (GHSA-pf67-5v96-fvgw)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-pf67-5v96-fvgw"
    },
    "lisa-getas43-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-getas43-miaww (npm) (GHSA-68jq-5r2m-5w4x)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-68jq-5r2m-5w4x"
    },
    "lisa-gandul17-riris": {
      blocked_all: true,
      reason: "Malicious code in lisa-gandul17-riris (npm) (GHSA-4x4p-p9p3-75m6)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-4x4p-p9p3-75m6"
    },
    "lisa-esdoger11-ruro": {
      blocked_all: true,
      reason: "Malicious code in lisa-esdoger11-ruro (npm) (GHSA-p9g7-qvmc-m3hh)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-p9g7-qvmc-m3hh"
    },
    "lisa-esdoger78-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-esdoger78-miaww (npm) (GHSA-r7xw-gqq2-9vm9)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-r7xw-gqq2-9vm9"
    },
    "lisa-getuk7-riris": {
      blocked_all: true,
      reason: "Malicious code in lisa-getuk7-riris (npm) (GHSA-f7r9-cp59-wv38)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-f7r9-cp59-wv38"
    },
    "lisa-getuk77-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-getuk77-sluey (npm) (GHSA-v9x4-3xh7-7397)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-v9x4-3xh7-7397"
    },
    "lisa-getas75-ruro": {
      blocked_all: true,
      reason: "Malicious code in lisa-getas75-ruro (npm) (GHSA-v7qg-6r7w-7hpx)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-v7qg-6r7w-7hpx"
    },
    "lisa-getas63-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in lisa-getas63-sukiwir (npm) (GHSA-797j-4w4q-vfv9)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-797j-4w4q-vfv9"
    },
    "lisa-gandul81-breki": {
      blocked_all: true,
      reason: "Malicious code in lisa-gandul81-breki (npm) (GHSA-xmmr-3fgr-jh9x)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-xmmr-3fgr-jh9x"
    },
    "lisa-gado-gado55-riris": {
      blocked_all: true,
      reason: "Malicious code in lisa-gado-gado55-riris (npm) (GHSA-4pcp-rq23-9qc6)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-4pcp-rq23-9qc6"
    },
    "lisa-gado-gado20-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in lisa-gado-gado20-sukiwir (npm) (GHSA-pg4c-c639-v77v)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-pg4c-c639-v77v"
    },
    "lisa-gado-gado96-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-gado-gado96-miaww (npm) (GHSA-68pc-9gmw-g68f)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-68pc-9gmw-g68f"
    },
    "lisa-esdoger6-breki": {
      blocked_all: true,
      reason: "Malicious code in lisa-esdoger6-breki (npm) (GHSA-88wh-qrwm-9687)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-88wh-qrwm-9687"
    },
    "lisa-gaplek51-riris": {
      blocked_all: true,
      reason: "Malicious code in lisa-gaplek51-riris (npm) (GHSA-cxvw-9wpw-3h9w)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-cxvw-9wpw-3h9w"
    },
    "lisa-gembus35-sumpek": {
      blocked_all: true,
      reason: "Malicious code in lisa-gembus35-sumpek (npm) (GHSA-46x9-p5ww-85p5)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-46x9-p5ww-85p5"
    },
    "lisa-gaplek6-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-gaplek6-sluey (npm) (GHSA-wjrv-8v2v-x336)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-wjrv-8v2v-x336"
    },
    "lisa-enting89-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-enting89-sluey (npm) (GHSA-45gh-6m7h-fcp2)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-45gh-6m7h-fcp2"
    },
    "lisa-gepuk92-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-gepuk92-sluey (npm) (GHSA-mjf7-9fpx-45r5)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-mjf7-9fpx-45r5"
    },
    "lisa-gembus37-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-gembus37-miaww (npm) (GHSA-9fjg-h4qp-pgvh)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-9fjg-h4qp-pgvh"
    },
    "lisa-gembus72-riris": {
      blocked_all: true,
      reason: "Malicious code in lisa-gembus72-riris (npm) (GHSA-j9f2-827v-j232)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-j9f2-827v-j232"
    },
    "lisa-getuk80-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-getuk80-miaww (npm) (GHSA-8j77-5v75-8ghm)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-8j77-5v75-8ghm"
    },
    "lisa-gudeg13-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-gudeg13-sluey (npm) (GHSA-fcv6-9h6p-pm3c)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-fcv6-9h6p-pm3c"
    },
    "lisa-gorengan43-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-gorengan43-miaww (npm) (GHSA-qq8f-5v2p-vc5w)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-qq8f-5v2p-vc5w"
    },
    "lisa-getuk69-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-getuk69-miaww (npm) (GHSA-v3j4-h59p-5v62)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-v3j4-h59p-5v62"
    },
    "lisa-getuk11-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-getuk11-miaww (npm) (GHSA-9f6m-99g5-4x38)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-9f6m-99g5-4x38"
    },
    "lisa-gandul10-breki": {
      blocked_all: true,
      reason: "Malicious code in lisa-gandul10-breki (npm) (GHSA-7fj6-94w4-77vv)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-7fj6-94w4-77vv"
    },
    "lisa-gembus100-pore": {
      blocked_all: true,
      reason: "Malicious code in lisa-gembus100-pore (npm) (GHSA-w63c-3j2q-q4hq)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-w63c-3j2q-q4hq"
    },
    "lisa-gepuk30-breki": {
      blocked_all: true,
      reason: "Malicious code in lisa-gepuk30-breki (npm) (GHSA-g8cg-rj37-x6m6)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-g8cg-rj37-x6m6"
    },
    "lisa-gaplek22-ruro": {
      blocked_all: true,
      reason: "Malicious code in lisa-gaplek22-ruro (npm) (GHSA-3r6h-22vr-jvcq)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-3r6h-22vr-jvcq"
    },
    "lisa-gaplek22-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in lisa-gaplek22-sukiwir (npm) (GHSA-qc83-7484-gwf8)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-qc83-7484-gwf8"
    },
    "lisa-empal62-ruro": {
      blocked_all: true,
      reason: "Malicious code in lisa-empal62-ruro (npm) (GHSA-qvv6-hhcj-9fcj)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-qvv6-hhcj-9fcj"
    },
    "lisa-empal39-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in lisa-empal39-sukiwir (npm) (GHSA-p269-8wq7-9mpp)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-p269-8wq7-9mpp"
    },
    "lisa-bubursumsum4-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-bubursumsum4-sluey (npm) (GHSA-5fhh-8r8q-j558)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-5fhh-8r8q-j558"
    },
    "lisa-buburayam83-ruro": {
      blocked_all: true,
      reason: "Malicious code in lisa-buburayam83-ruro (npm) (GHSA-22r3-pvx4-9pv6)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-22r3-pvx4-9pv6"
    },
    "lisa-bubur5-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-bubur5-miaww (npm) (GHSA-jh3q-xpj9-qcj3)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-jh3q-xpj9-qcj3"
    },
    "lisa-empal87-breki": {
      blocked_all: true,
      reason: "Malicious code in lisa-empal87-breki (npm) (GHSA-vm3m-gm6m-g29c)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-vm3m-gm6m-g29c"
    },
    "lisa-empal72-ruro": {
      blocked_all: true,
      reason: "Malicious code in lisa-empal72-ruro (npm) (GHSA-3926-r8rj-3v4v)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-3926-r8rj-3v4v"
    },
    "lisa-dodol81-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-dodol81-miaww (npm) (GHSA-pcch-vcw5-vxf4)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-pcch-vcw5-vxf4"
    },
    "lisa-brongkos35-breki": {
      blocked_all: true,
      reason: "Malicious code in lisa-brongkos35-breki (npm) (GHSA-xg28-w7w5-f6p6)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-xg28-w7w5-f6p6"
    },
    "lisa-brongkos17-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-brongkos17-sluey (npm) (GHSA-rm2w-j77j-4rr5)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-rm2w-j77j-4rr5"
    },
    "lisa-botok73-sumpek": {
      blocked_all: true,
      reason: "Malicious code in lisa-botok73-sumpek (npm) (GHSA-r9jq-7qvq-6pgx)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-r9jq-7qvq-6pgx"
    },
    "lisa-empal58-ruro": {
      blocked_all: true,
      reason: "Malicious code in lisa-empal58-ruro (npm) (GHSA-7f47-59xv-hrjm)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-7f47-59xv-hrjm"
    },
    "lisa-bubursumsum30-miaww": {
      blocked_all: true,
      reason: "Malicious code in lisa-bubursumsum30-miaww (npm) (GHSA-h6xp-gxjg-p7c7)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-h6xp-gxjg-p7c7"
    },
    "lisa-bubur56-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-bubur56-sluey (npm) (GHSA-cx7j-9j8m-xx56)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-cx7j-9j8m-xx56"
    },
    "lisa-dradag98-wekto": {
      blocked_all: true,
      reason: "Malicious code in lisa-dradag98-wekto (npm) (GHSA-g59r-vp82-9843)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-g59r-vp82-9843"
    },
    "lisa-brongkos58-riris": {
      blocked_all: true,
      reason: "Malicious code in lisa-brongkos58-riris (npm) (GHSA-2xc3-32cr-ch72)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-2xc3-32cr-ch72"
    },
    "lisa-brongkos16-breki": {
      blocked_all: true,
      reason: "Malicious code in lisa-brongkos16-breki (npm) (GHSA-q96f-8486-mwfg)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-q96f-8486-mwfg"
    },
    "lisa-donat56-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-donat56-sluey (npm) (GHSA-pqgv-wf7x-4p54)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-pqgv-wf7x-4p54"
    },
    "lisa-empal1-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-empal1-sluey (npm) (GHSA-pvr8-4xf7-hrwm)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-pvr8-4xf7-hrwm"
    },
    "lisa-dradag70-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-dradag70-sluey (npm) (GHSA-36v7-7hwj-6c37)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-36v7-7hwj-6c37"
    },
    "lisa-buburayam23-breki": {
      blocked_all: true,
      reason: "Malicious code in lisa-buburayam23-breki (npm) (GHSA-jhqw-rv95-x5h7)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-jhqw-rv95-x5h7"
    },
    "lisa-bubur33-sluey": {
      blocked_all: true,
      reason: "Malicious code in lisa-bubur33-sluey (npm) (GHSA-97xp-gf3m-m3mj)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-97xp-gf3m-m3mj"
    },
    "lisa-buburayam31-sukiwir": {
      blocked_all: true,
      reason: "Malicious code in lisa-buburayam31-sukiwir (npm) (GHSA-7222-jv76-3fgh)",
      date: "2026-09-17",
      advisory: "https://github.com/advisories/GHSA-7222-jv76-3fgh"
    },
    keroeltop: {
      blocked_all: true,
      reason: "Malicious code in keroeltop (npm) (GHSA-gg5m-rqpp-c9xf)",
      date: "2026-09-19",
      advisory: "https://github.com/advisories/GHSA-gg5m-rqpp-c9xf"
    },
    internallib_v949: {
      blocked_all: true,
      reason: "Malware in internallib_v949 (GHSA-f863-m366-9cfm)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-f863-m366-9cfm"
    },
    "@shared-web/utils": {
      blocked_all: true,
      reason: "Malicious code in @shared-web/utils (npm) (GHSA-29f7-pqf4-c94j)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-29f7-pqf4-c94j"
    },
    "tailwindcss-forms-ui": {
      blocked_all: true,
      reason: "Malicious code in tailwindcss-forms-ui (npm) (GHSA-fc5q-m33g-rp9c)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-fc5q-m33g-rp9c"
    },
    "chai-as-indexed": {
      blocked_all: true,
      reason: "Malicious code in chai-as-indexed (npm) (GHSA-727r-6hg5-947x)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-727r-6hg5-947x"
    },
    "x509-escaping": {
      blocked_all: true,
      reason: "Malicious code in x509-escaping (npm) (GHSA-fq85-7xqm-cgj9)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-fq85-7xqm-cgj9"
    },
    "@shared-runtime/modules": {
      blocked_all: true,
      reason: "Malicious code in @shared-runtime/modules (npm) (GHSA-g85c-jph7-8q4r)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-g85c-jph7-8q4r"
    },
    "@insiderintelligence/googleadmanager": {
      blocked_all: true,
      reason: "Malicious code in @insiderintelligence/googleadmanager (npm) (GHSA-76rx-jxhm-vhww)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-76rx-jxhm-vhww"
    },
    "openmct-heatmap": {
      blocked_all: true,
      reason: "Malware in openmct-heatmap (GHSA-qx52-2xq4-3x3v)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-qx52-2xq4-3x3v"
    },
    "test899-auth": {
      blocked_all: true,
      reason: "Malware in test899-auth (GHSA-jf2q-w77c-99vv)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-jf2q-w77c-99vv"
    },
    "test89-auth": {
      blocked_all: true,
      reason: "Malware in test89-auth (GHSA-7868-hxr7-g8r6)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-7868-hxr7-g8r6"
    },
    "test8999-auth": {
      blocked_all: true,
      reason: "Malware in test8999-auth (GHSA-25wf-vfrc-2r82)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-25wf-vfrc-2r82"
    },
    "test890-auth": {
      blocked_all: true,
      reason: "Malware in test890-auth (GHSA-xvpv-wq7p-548c)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-xvpv-wq7p-548c"
    },
    "@shared-web/assets": {
      blocked_all: true,
      reason: "Malicious code in @shared-web/assets (npm) (GHSA-vmr9-5w3x-4v98)",
      date: "2026-09-18",
      advisory: "https://github.com/advisories/GHSA-vmr9-5w3x-4v98"
    },
    "radio-player-theme": {
      blocked_all: true,
      reason: "Malicious code in radio-player-theme (npm) (GHSA-3rj7-hf4w-jh5c)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-3rj7-hf4w-jh5c"
    },
    pflag14570: {
      blocked_all: true,
      reason: "Malicious code in pflag14570 (npm) (GHSA-j2x3-5g59-p27j)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-j2x3-5g59-p27j"
    },
    "sorrawit-dev-helper": {
      blocked_all: true,
      reason: "Malicious code in sorrawit-dev-helper (npm) (GHSA-6rc9-cghh-frwr)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-6rc9-cghh-frwr"
    },
    "element-plus-vite-cli": {
      blocked_all: true,
      reason: "Malicious code in element-plus-vite-cli (npm) (GHSA-2w5j-q26r-6m9w)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-2w5j-q26r-6m9w"
    },
    siriusbeyond: {
      blocked_all: true,
      reason: "Malicious code in siriusbeyond (npm) (GHSA-4pq9-9r53-4chh)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-4pq9-9r53-4chh"
    },
    keroeltopgg: {
      blocked_all: true,
      reason: "Malicious code in keroeltopgg (npm) (GHSA-p3m2-65cv-vjqj)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-p3m2-65cv-vjqj"
    },
    "feed-widget-helper": {
      blocked_all: true,
      reason: "Malicious code in feed-widget-helper (npm) (GHSA-fgrp-3g95-g56v)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-fgrp-3g95-g56v"
    },
    pf25262: {
      blocked_all: true,
      reason: "Malicious code in pf25262 (npm) (GHSA-w55g-75g8-c4wj)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-w55g-75g8-c4wj"
    },
    pflag29424: {
      blocked_all: true,
      reason: "Malicious code in pflag29424 (npm) (GHSA-rmcq-vcrh-wjpw)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-rmcq-vcrh-wjpw"
    },
    pf23727: {
      blocked_all: true,
      reason: "Malicious code in pf23727 (npm) (GHSA-cm8q-25x5-5426)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-cm8q-25x5-5426"
    },
    catwrestlingbird: {
      blocked_all: true,
      reason: "Malicious code in catwrestlingbird (npm) (GHSA-48qc-pw85-j8gf)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-48qc-pw85-j8gf"
    },
    pf25133: {
      blocked_all: true,
      reason: "Malicious code in pf25133 (npm) (GHSA-prrp-f648-8673)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-prrp-f648-8673"
    },
    catwrestlinghuman: {
      blocked_all: true,
      reason: "Malicious code in catwrestlinghuman (npm) (GHSA-6p69-rvw3-pvrv)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-6p69-rvw3-pvrv"
    },
    keroeltopkkk: {
      blocked_all: true,
      reason: "Malicious code in keroeltopkkk (npm) (GHSA-4cvc-3pxq-6v5f)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-4cvc-3pxq-6v5f"
    },
    "my-cdn-script": {
      blocked_all: true,
      reason: "Malicious code in my-cdn-script (npm) (GHSA-r55v-7qcq-fvr9)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-r55v-7qcq-fvr9"
    },
    "commerce-materials": {
      blocked_all: true,
      reason: "Malicious code in commerce-materials (npm) (GHSA-79cv-pg4c-wmph)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-79cv-pg4c-wmph"
    },
    keroeltopkk: {
      blocked_all: true,
      reason: "Malicious code in keroeltopkk (npm) (GHSA-gr8g-435h-492g)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-gr8g-435h-492g"
    },
    "homestack-cheer": {
      blocked_all: true,
      reason: "Malicious code in homestack-cheer (npm) (GHSA-fqjq-jxmv-48qv)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-fqjq-jxmv-48qv"
    },
    "chai-as-viem": {
      blocked_all: true,
      reason: "Malicious code in chai-as-viem (npm) (GHSA-c67f-wr24-prw9)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-c67f-wr24-prw9"
    },
    "@asenfotech/unplugin-element-plus": {
      blocked_all: true,
      reason: "Malicious code in @asenfotech/unplugin-element-plus (npm) (GHSA-j296-5jqh-9cxv)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-j296-5jqh-9cxv"
    },
    "byted-commerce-materials": {
      blocked_all: true,
      reason: "Malicious code in byted-commerce-materials (npm) (GHSA-j9hx-j6cf-phx5)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-j9hx-j6cf-phx5"
    },
    "bulk-add-sdk": {
      blocked_all: true,
      reason: "Malicious code in bulk-add-sdk (npm) (GHSA-j7qr-p7vp-jvhx)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-j7qr-p7vp-jvhx"
    },
    "@siriusbeyond/ui": {
      blocked_all: true,
      reason: "Malicious code in @siriusbeyond/ui (npm) (GHSA-vw2m-5qq2-7qwg)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-vw2m-5qq2-7qwg"
    },
    "@siriusbeyond/auth": {
      blocked_all: true,
      reason: "Malicious code in @siriusbeyond/auth (npm) (GHSA-5x48-2mvx-rc23)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-5x48-2mvx-rc23"
    },
    "starbucks-sdk": {
      blocked_all: true,
      reason: "Malicious code in starbucks-sdk (npm) (GHSA-6m74-h462-fr23)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-6m74-h462-fr23"
    },
    "action-slack-message-root": {
      blocked_all: true,
      reason: "Malicious code in action-slack-message-root (npm) (GHSA-48hx-h7cw-h342)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-48hx-h7cw-h342"
    },
    "@siriusbeyond/utils": {
      blocked_all: true,
      reason: "Malicious code in @siriusbeyond/utils (npm) (GHSA-446r-4pr8-w423)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-446r-4pr8-w423"
    },
    "@dbbhk/ui-components": {
      blocked_all: true,
      reason: "Malicious code in @dbbhk/ui-components (npm) (GHSA-hwx5-436m-736q)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-hwx5-436m-736q"
    },
    "better-envforge": {
      blocked_all: true,
      reason: "Malicious code in better-envforge (npm) (GHSA-9x97-m747-42gc)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-9x97-m747-42gc"
    },
    testmgkregme: {
      blocked_all: true,
      reason: "Malicious code in testmgkregme (npm) (GHSA-hc49-rwm2-p2w7)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-hc49-rwm2-p2w7"
    },
    test1sdsd2: {
      blocked_all: true,
      reason: "Malicious code in test1sdsd2 (npm) (GHSA-9mc8-mrvr-f664)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-9mc8-mrvr-f664"
    },
    test1ro: {
      blocked_all: true,
      reason: "Malicious code in test1ro (npm) (GHSA-8rr3-xrmc-xvjf)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-8rr3-xrmc-xvjf"
    },
    test1df23: {
      blocked_all: true,
      reason: "Malicious code in test1df23 (npm) (GHSA-78p9-g7q9-mcjw)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-78p9-g7q9-mcjw"
    },
    test1hh235: {
      blocked_all: true,
      reason: "Malicious code in test1hh235 (npm) (GHSA-qrfc-3762-c24w)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-qrfc-3762-c24w"
    },
    "chai-testing": {
      blocked_all: true,
      reason: "Malicious code in chai-testing (npm) (GHSA-5jvh-cf7p-qx9w)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-5jvh-cf7p-qx9w"
    },
    "chat-adapter-matrix": {
      blocked_all: true,
      reason: "Malicious code in chat-adapter-matrix (npm) (GHSA-2rg8-m9rx-gfhf)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-2rg8-m9rx-gfhf"
    },
    test1gg234: {
      blocked_all: true,
      reason: "Malicious code in test1gg234 (npm) (GHSA-w7fw-w5xv-5p8v)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-w7fw-w5xv-5p8v"
    },
    test12vv36: {
      blocked_all: true,
      reason: "Malicious code in test12vv36 (npm) (GHSA-7f39-795r-gxj4)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-7f39-795r-gxj4"
    },
    npmscript_tesstalert_unpkg: {
      blocked_all: true,
      reason: "Malicious code in npmscript_tesstalert_unpkg (npm) (GHSA-r2rm-wm4f-f55p)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-r2rm-wm4f-f55p"
    },
    "npx-test-ma980": {
      blocked_all: true,
      reason: "Malicious code in npx-test-ma980 (npm) (GHSA-9vj4-6r95-2p6w)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-9vj4-6r95-2p6w"
    },
    "@nimbusedge2/authxsas": {
      blocked_all: true,
      reason: "Malicious code in @nimbusedge2/authxsas (npm) (GHSA-8mrv-jcm6-9rv3)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-8mrv-jcm6-9rv3"
    },
    "@nimbusedge2/authxsas1": {
      blocked_all: true,
      reason: "Malicious code in @nimbusedge2/authxsas1 (npm) (GHSA-92qm-hjm8-mp6j)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-92qm-hjm8-mp6j"
    },
    "@nimbusedge2/auth": {
      blocked_all: true,
      reason: "Malicious code in @nimbusedge2/auth (npm) (GHSA-9hmg-mp2c-g9wr)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-9hmg-mp2c-g9wr"
    },
    "@nimbusedge2/x": {
      blocked_all: true,
      reason: "Malicious code in @nimbusedge2/x (npm) (GHSA-488m-x4jr-5x75)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-488m-x4jr-5x75"
    },
    "@baanx/solana-lib": {
      blocked_all: true,
      reason: "Malicious code in @baanx/solana-lib (npm) (GHSA-pvh9-27rp-6282)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-pvh9-27rp-6282"
    },
    "@nimbsuedge3/xar": {
      blocked_all: true,
      reason: "Malicious code in @nimbsuedge3/xar (npm) (GHSA-rg8r-9wp3-7jrg)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-rg8r-9wp3-7jrg"
    },
    "@nimbusedge2/xa": {
      blocked_all: true,
      reason: "Malicious code in @nimbusedge2/xa (npm) (GHSA-m4pg-jjmc-xgr9)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-m4pg-jjmc-xgr9"
    },
    "@pwaplatform/module-sso-integration": {
      blocked_all: true,
      reason: "Malicious code in @pwaplatform/module-sso-integration (npm) (GHSA-26h7-cmv3-wgv6)",
      date: "2026-09-20",
      advisory: "https://github.com/advisories/GHSA-26h7-cmv3-wgv6"
    },
    "emoji-prints-fancy": {
      blocked_all: true,
      reason: "Malware in emoji-prints-fancy (GHSA-m523-mggx-3fgr)",
      date: "2026-09-22",
      advisory: "https://github.com/advisories/GHSA-m523-mggx-3fgr"
    },
    "transform-es2015-unicode-regex": {
      blocked_all: true,
      reason: "Malware in transform-es2015-unicode-regex (GHSA-jcxm-5v55-599q)",
      date: "2026-09-22",
      advisory: "https://github.com/advisories/GHSA-jcxm-5v55-599q"
    },
    "de-morgan": {
      blocked_all: true,
      reason: "Malware in de-morgan (GHSA-2vc2-gwg3-2gpx)",
      date: "2026-09-22",
      advisory: "https://github.com/advisories/GHSA-2vc2-gwg3-2gpx"
    },
    "test-react-app-in": {
      blocked_all: true,
      reason: "Malware in test-react-app-in (GHSA-wm2w-4m2r-mv73)",
      date: "2026-09-22",
      advisory: "https://github.com/advisories/GHSA-wm2w-4m2r-mv73"
    },
    "test-react-app-out": {
      blocked_all: true,
      reason: "Malware in test-react-app-out (GHSA-vx3p-fwmg-p7g8)",
      date: "2026-09-22",
      advisory: "https://github.com/advisories/GHSA-vx3p-fwmg-p7g8"
    },
    "test-react-app-way": {
      blocked_all: true,
      reason: "Malware in test-react-app-way (GHSA-264w-9h55-v637)",
      date: "2026-09-22",
      advisory: "https://github.com/advisories/GHSA-264w-9h55-v637"
    },
    "@uol-afiliados/affiliated-config-lib": {
      blocked_all: true,
      reason: "Malicious code in @uol-afiliados/affiliated-config-lib (npm) (GHSA-mh6g-473c-fvhx)",
      date: "2026-09-22",
      advisory: "https://github.com/advisories/GHSA-mh6g-473c-fvhx"
    },
    "@zig-design-system/react": {
      blocked_all: true,
      reason: "Malware in @zig-design-system/react (GHSA-rqjq-px4f-2m8r)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-rqjq-px4f-2m8r"
    },
    "react-context-form-tdsss": {
      blocked_all: true,
      reason: "Malware in react-context-form-tdsss (GHSA-pg33-6m24-4p63)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-pg33-6m24-4p63"
    },
    "wos-library": {
      blocked_all: true,
      reason: "Malware in wos-library (GHSA-mfwv-9gcf-2mww)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-mfwv-9gcf-2mww"
    },
    "@vitets/vite-ts": {
      blocked_all: true,
      reason: "Malware in @vitets/vite-ts (GHSA-733v-wc48-f65r)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-733v-wc48-f65r"
    },
    "@vite-tab/tabui": {
      blocked_all: true,
      reason: "Malware in @vite-tab/tabui (GHSA-q5h9-3mvh-45cf)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-q5h9-3mvh-45cf"
    },
    "@vite-tab/tab": {
      blocked_all: true,
      reason: "Malware in @vite-tab/tab (GHSA-74pv-97c8-9hfp)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-74pv-97c8-9hfp"
    },
    "@vite-pro/vite-ui": {
      blocked_all: true,
      reason: "Malware in @vite-pro/vite-ui (GHSA-phpx-wpr2-26pv)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-phpx-wpr2-26pv"
    },
    "@vite-mcp/vite-type": {
      blocked_all: true,
      reason: "Malware in @vite-mcp/vite-type (GHSA-mqf9-3wx8-45cj)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-mqf9-3wx8-45cj"
    },
    "@vite-ts/vite-ui": {
      blocked_all: true,
      reason: "Malware in @vite-ts/vite-ui (GHSA-jm6h-xxm2-2mr3)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-jm6h-xxm2-2mr3"
    },
    "@uh-platform/domain-widget": {
      blocked_all: true,
      reason: "Malicious code in @uh-platform/domain-widget (npm) (GHSA-xh82-8x4m-9w6c)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-xh82-8x4m-9w6c"
    },
    "@asdfaskdjfksadhfkasf/nadaver2": {
      blocked_all: true,
      reason: "Malicious code in @asdfaskdjfksadhfkasf/nadaver2 (npm) (GHSA-p368-v58m-82vj)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-p368-v58m-82vj"
    },
    "@uh-platform/webcard": {
      blocked_all: true,
      reason: "Malicious code in @uh-platform/webcard (npm) (GHSA-5h99-j25f-5q62)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-5h99-j25f-5q62"
    },
    "bytepack-probe-a7x3": {
      blocked_all: true,
      reason: "Malicious code in bytepack-probe-a7x3 (npm) (GHSA-pjjj-2389-rwj6)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-pjjj-2389-rwj6"
    },
    "@uh-platform/nadaver2": {
      blocked_all: true,
      reason: "Malicious code in @uh-platform/nadaver2 (npm) (GHSA-99r3-9hc2-372p)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-99r3-9hc2-372p"
    },
    "@uh-platform/nadaver": {
      blocked_all: true,
      reason: "Malicious code in @uh-platform/nadaver (npm) (GHSA-5r3f-92qc-25rr)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-5r3f-92qc-25rr"
    },
    "@uh-platform/cloud": {
      blocked_all: true,
      reason: "Malicious code in @uh-platform/cloud (npm) (GHSA-g4jv-48fc-mhh2)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-g4jv-48fc-mhh2"
    },
    "blue-string-formatter-utilss": {
      blocked_all: true,
      reason: "Malicious code in blue-string-formatter-utilss (npm) (GHSA-4g26-86h7-34h3)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-4g26-86h7-34h3"
    },
    "my-ctf-helper-script-9921": {
      blocked_all: true,
      reason: "Malicious code in my-ctf-helper-script-9921 (npm) (GHSA-qhgh-m36j-h879)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-qhgh-m36j-h879"
    },
    "math-universe": {
      blocked_all: true,
      reason: "Malware in math-universe (GHSA-97cg-r346-fg22)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-97cg-r346-fg22"
    },
    mathsbase: {
      blocked_all: true,
      reason: "Malware in mathsbase (GHSA-v4cx-64j6-84xm)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-v4cx-64j6-84xm"
    },
    mathmain: {
      blocked_all: true,
      reason: "Malware in mathmain (GHSA-v6mx-2p6p-3628)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-v6mx-2p6p-3628"
    },
    "hardhat-devkit": {
      blocked_all: true,
      reason: "Malicious code in hardhat-devkit (npm) (GHSA-2wmg-qp72-3736)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-2wmg-qp72-3736"
    },
    "@woodpecker-web-shared/components": {
      blocked_all: true,
      reason: "Malicious code in @woodpecker-web-shared/components (npm) (GHSA-8hq6-gvg5-x8wq)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-8hq6-gvg5-x8wq"
    },
    "gemini-computer-use": {
      blocked_all: true,
      reason: "Malicious code in gemini-computer-use (npm) (GHSA-4cwr-c4gf-f9r4)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-4cwr-c4gf-f9r4"
    },
    "bnppf-flag-icons": {
      blocked_all: true,
      reason: "Malicious code in bnppf-flag-icons (npm) (GHSA-r56f-8237-82ch)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-r56f-8237-82ch"
    },
    "@insiderintelligence/componentlibrary": {
      blocked_all: true,
      reason: "Malicious code in @insiderintelligence/componentlibrary (npm) (GHSA-5h4w-mvwx-ff8q)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-5h4w-mvwx-ff8q"
    },
    "hardhat-base": {
      blocked_all: true,
      reason: "Malicious code in hardhat-base (npm) (GHSA-g59v-28j4-2r85)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-g59v-28j4-2r85"
    },
    "@baanx/abis": {
      blocked_all: true,
      reason: "Malicious code in @baanx/abis (npm) (GHSA-r554-rpx4-qw24)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-r554-rpx4-qw24"
    },
    "@baanx/blockchain-config": {
      blocked_all: true,
      reason: "Malicious code in @baanx/blockchain-config (npm) (GHSA-7cc3-jjqj-wrm5)",
      date: "2026-09-21",
      advisory: "https://github.com/advisories/GHSA-7cc3-jjqj-wrm5"
    },
    "@memtensor/memos-cloud-openclaw-plugin": {
      blocked_all: true,
      reason: "Malware in @memtensor/memos-cloud-openclaw-plugin (GHSA-mhjf-v53x-7p87)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-mhjf-v53x-7p87"
    },
    "vite-dev-launcher": {
      blocked_all: true,
      reason: "Malicious code in vite-dev-launcher (npm) (GHSA-pg2r-jxrr-mx5j)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-pg2r-jxrr-mx5j"
    },
    "sea-baileys": {
      blocked_all: true,
      reason: "Malicious code in sea-baileys (npm) (GHSA-9xjg-g5r3-xpj8)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-9xjg-g5r3-xpj8"
    },
    hachutis: {
      blocked_all: true,
      reason: "Malicious code in hachutis (npm) (GHSA-9rj9-xh7c-qqh8)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-9rj9-xh7c-qqh8"
    },
    "helpersutils-dev-tools": {
      blocked_all: true,
      reason: "Malicious code in helpersutils-dev-tools (npm) (GHSA-w43w-f8m4-5r39)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-w43w-f8m4-5r39"
    },
    godxxx: {
      blocked_all: true,
      reason: "Malicious code in godxxx (npm) (GHSA-4wh8-4j9j-8q3r)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-4wh8-4j9j-8q3r"
    },
    godzz: {
      blocked_all: true,
      reason: "Malicious code in godzz (npm) (GHSA-p6cq-66pp-9r5g)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-p6cq-66pp-9r5g"
    },
    godzzz: {
      blocked_all: true,
      reason: "Malicious code in godzzz (npm) (GHSA-6j9r-v67w-r8w4)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-6j9r-v67w-r8w4"
    },
    "@test1230504/string-format-helper": {
      blocked_all: true,
      reason: "Malware in @test1230504/string-format-helper (GHSA-9572-4cpv-x2hp)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-9572-4cpv-x2hp"
    },
    "@test1230504/probe-7f3k2m-utils": {
      blocked_all: true,
      reason: "Malware in @test1230504/probe-7f3k2m-utils (GHSA-3qx9-8g8p-4mcj)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-3qx9-8g8p-4mcj"
    },
    "@test1230504/test-publish-verify": {
      blocked_all: true,
      reason: "Malware in @test1230504/test-publish-verify (GHSA-7m76-mq85-8c7w)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-7m76-mq85-8c7w"
    },
    "z-deno-truth-ya1t4m": {
      blocked_all: true,
      reason: "Malware in z-deno-truth-ya1t4m (GHSA-qff9-mw3p-hg4c)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-qff9-mw3p-hg4c"
    },
    "z-deno-truth-va499w": {
      blocked_all: true,
      reason: "Malware in z-deno-truth-va499w (GHSA-76wq-hx78-mw6x)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-76wq-hx78-mw6x"
    },
    "z-deno-truth-bwhlsz": {
      blocked_all: true,
      reason: "Malware in z-deno-truth-bwhlsz (GHSA-f8xr-gjfq-xfcp)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-f8xr-gjfq-xfcp"
    },
    efhthrthrthregerht: {
      blocked_all: true,
      reason: "Malicious code in efhthrthrthregerht (npm) (GHSA-rxg9-j4gc-5m6m)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-rxg9-j4gc-5m6m"
    },
    "eslint-plugin-i18n-shreddit": {
      blocked_all: true,
      reason: "Malicious code in eslint-plugin-i18n-shreddit (npm) (GHSA-h5xr-5j26-q5rm)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-h5xr-5j26-q5rm"
    },
    "@vitemirrorte/element-plus-vite-cli": {
      blocked_all: true,
      reason: "Malicious code in @vitemirrorte/element-plus-vite-cli (npm) (GHSA-j7hr-ff2j-rgv6)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-j7hr-ff2j-rgv6"
    },
    internallib_v497: {
      blocked_all: true,
      reason: "Malicious code in internallib_v497 (npm) (GHSA-m9ww-2r6q-x632)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-m9ww-2r6q-x632"
    },
    catqrcodeconverter: {
      blocked_all: true,
      reason: "Malicious code in catqrcodeconverter (npm) (GHSA-f639-24m5-rmxp)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-f639-24m5-rmxp"
    },
    catplatebarcodeparser: {
      blocked_all: true,
      reason: "Malicious code in catplatebarcodeparser (npm) (GHSA-7h34-v43h-45gc)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-7h34-v43h-45gc"
    },
    "turbo-ws": {
      blocked_all: true,
      reason: "Malicious code in turbo-ws (npm) (GHSA-49rw-43cc-8cmh)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-49rw-43cc-8cmh"
    },
    "n8n-nodes-metricsagent": {
      blocked_all: true,
      reason: "Malicious code in n8n-nodes-metricsagent (npm) (GHSA-g3pf-m29r-p353)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-g3pf-m29r-p353"
    },
    internallib_v550: {
      blocked_all: true,
      reason: "Malicious code in internallib_v550 (npm) (GHSA-vc8f-vp28-j8g3)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-vc8f-vp28-j8g3"
    },
    moudeva: {
      blocked_all: true,
      reason: "Malicious code in moudeva (npm) (GHSA-8c6q-78vh-4fwp)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-8c6q-78vh-4fwp"
    },
    moidevl: {
      blocked_all: true,
      reason: "Malicious code in moidevl (npm) (GHSA-x8vv-mr6f-v7gf)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-x8vv-mr6f-v7gf"
    },
    "n8n-nodes-healthmon": {
      blocked_all: true,
      reason: "Malicious code in n8n-nodes-healthmon (npm) (GHSA-j6fv-f788-59cj)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-j6fv-f788-59cj"
    },
    "my-company-device": {
      blocked_all: true,
      reason: "Malicious code in my-company-device (npm) (GHSA-q4cw-hqw3-j56g)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-q4cw-hqw3-j56g"
    },
    "some-tool-package": {
      blocked_all: true,
      reason: "Malware in some-tool-package (GHSA-55vw-cpj6-w7w8)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-55vw-cpj6-w7w8"
    },
    "subapp-pkg-util": {
      blocked_all: true,
      reason: "Malware in subapp-pkg-util (GHSA-f946-r32q-xrp6)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-f946-r32q-xrp6"
    },
    "better-md": {
      blocked_all: true,
      reason: "Malware in better-md (GHSA-r4h9-57fh-5fj3)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-r4h9-57fh-5fj3"
    },
    "uolcs-host-uol-anuncios-fe": {
      blocked_all: true,
      reason: "Malware in uolcs-host-uol-anuncios-fe (GHSA-p4vr-mx6g-r574)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-p4vr-mx6g-r574"
    },
    dbconnectify: {
      blocked_all: true,
      reason: "Malware in dbconnectify (GHSA-p5xv-vqcx-vm42)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-p5xv-vqcx-vm42"
    },
    "prettier-lint-lenz": {
      blocked_all: true,
      reason: "Malware in prettier-lint-lenz (GHSA-8558-w8j5-67wq)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-8558-w8j5-67wq"
    },
    "semver-bump-io": {
      blocked_all: true,
      reason: "Malware in semver-bump-io (GHSA-m877-5x7f-7r88)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-m877-5x7f-7r88"
    },
    "webp-https-errors": {
      blocked_all: true,
      reason: "Malware in webp-https-errors (GHSA-gmm9-q3gf-4hfr)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-gmm9-q3gf-4hfr"
    },
    "solo-async-pipe": {
      blocked_all: true,
      reason: "Malware in solo-async-pipe (GHSA-j96p-xm58-6233)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-j96p-xm58-6233"
    },
    "debounce-throttle-base": {
      blocked_all: true,
      reason: "Malware in debounce-throttle-base (GHSA-g9m6-qcpw-g96x)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-g9m6-qcpw-g96x"
    },
    "iso-datetime-core": {
      blocked_all: true,
      reason: "Malware in iso-datetime-core (GHSA-fc7h-qf7q-qxw4)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-fc7h-qf7q-qxw4"
    },
    kamafhbnowct: {
      blocked_all: true,
      reason: "Malware in kamafhbnowct (GHSA-j87m-pgqx-mpg5)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-j87m-pgqx-mpg5"
    },
    luftzxyuiwgbgsp: {
      blocked_all: true,
      reason: "Malware in luftzxyuiwgbgsp (GHSA-cppx-756q-g98p)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-cppx-756q-g98p"
    },
    tib2jcvowuyma: {
      blocked_all: true,
      reason: "Malware in tib2jcvowuyma (GHSA-hqgj-c9q6-8qv8)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-hqgj-c9q6-8qv8"
    },
    xsjukcnv8low26: {
      blocked_all: true,
      reason: "Malware in xsjukcnv8low26 (GHSA-6g8g-gw7h-prch)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-6g8g-gw7h-prch"
    },
    tuxcmdfhjkw: {
      blocked_all: true,
      reason: "Malware in tuxcmdfhjkw (GHSA-67q5-w9wg-mvvv)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-67q5-w9wg-mvvv"
    },
    mob4zchvuine: {
      blocked_all: true,
      reason: "Malware in mob4zchvuine (GHSA-f232-pcw4-j7qg)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-f232-pcw4-j7qg"
    },
    caphsmgiwy: {
      blocked_all: true,
      reason: "Malware in caphsmgiwy (GHSA-35mc-7f44-62rg)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-35mc-7f44-62rg"
    },
    tibcwmpoeafh: {
      blocked_all: true,
      reason: "Malware in tibcwmpoeafh (GHSA-vcg8-c5h2-55w6)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-vcg8-c5h2-55w6"
    },
    "@usaa-grp-personal-profile/personal-profile-common": {
      blocked_all: true,
      reason: "Malware in @usaa-grp-personal-profile/personal-profile-common (GHSA-hhfp-ggmv-qx2x)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-hhfp-ggmv-qx2x"
    },
    "bnpl-blocks-mobile-bnpl-floating-button": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-mobile-bnpl-floating-button (GHSA-vrh4-rf6w-3256)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-vrh4-rf6w-3256"
    },
    "bigops-products-timeline": {
      blocked_all: true,
      reason: "Malware in bigops-products-timeline (GHSA-9f9c-qwvh-f45q)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-9f9c-qwvh-f45q"
    },
    "bigops-auth-interceptor": {
      blocked_all: true,
      reason: "Malware in bigops-auth-interceptor (GHSA-7pp9-3qqc-vc84)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-7pp9-3qqc-vc84"
    },
    "bnpl-blocks-atom-bnpl-search-input": {
      blocked_all: true,
      reason: "Malware in bnpl-blocks-atom-bnpl-search-input (GHSA-pvq7-rm52-m5g7)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-pvq7-rm52-m5g7"
    },
    "devplatform-sdk": {
      blocked_all: true,
      reason: "Malware in devplatform-sdk (GHSA-24m2-6frm-vxj3)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-24m2-6frm-vxj3"
    },
    "@tvg-mar/promos-context": {
      blocked_all: true,
      reason: "Malicious code in @tvg-mar/promos-context (npm) (GHSA-gmpx-wq8f-4q86)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-gmpx-wq8f-4q86"
    },
    "@tvg-mar/utils": {
      blocked_all: true,
      reason: "Malicious code in @tvg-mar/utils (npm) (GHSA-g5mj-6q8x-7cj6)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-g5mj-6q8x-7cj6"
    },
    "eslint-config-compact-utils": {
      blocked_all: true,
      reason: "Malicious code in eslint-config-compact-utils (npm) (GHSA-qh87-q3mj-33jx)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-qh87-q3mj-33jx"
    },
    "@tvg-mar/tvg-promos-atomic-ui": {
      blocked_all: true,
      reason: "Malicious code in @tvg-mar/tvg-promos-atomic-ui (npm) (GHSA-fvh3-76xv-7978)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-fvh3-76xv-7978"
    },
    "n8n-nodes-data-transformer-utils": {
      blocked_all: true,
      reason: "Malicious code in n8n-nodes-data-transformer-utils (npm) (GHSA-w3qc-pff7-wmpv)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-w3qc-pff7-wmpv"
    },
    "@tvg-mar/storyblok-bridge": {
      blocked_all: true,
      reason: "Malicious code in @tvg-mar/storyblok-bridge (npm) (GHSA-r788-p8wq-7672)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-r788-p8wq-7672"
    },
    "@tvg-mar/promos-gtm": {
      blocked_all: true,
      reason: "Malicious code in @tvg-mar/promos-gtm (npm) (GHSA-4mmr-x347-r6gv)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-4mmr-x347-r6gv"
    },
    "@gsutevil/hta-stage": {
      blocked_all: true,
      reason: "Malicious code in @gsutevil/hta-stage (npm) (GHSA-95xp-29r3-v466)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-95xp-29r3-v466"
    },
    "agora402-payment-utils": {
      blocked_all: true,
      reason: "Malware in agora402-payment-utils (GHSA-pvr5-m9hx-xxfr)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-pvr5-m9hx-xxfr"
    },
    "@wizloft/harness": {
      blocked_all: true,
      reason: "Malware in @wizloft/harness (GHSA-hv3x-6r5c-g4cp)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-hv3x-6r5c-g4cp"
    },
    "@wizloft/harness-file-providers": {
      blocked_all: true,
      reason: "Malware in @wizloft/harness-file-providers (GHSA-2jrv-g43f-qm7f)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-2jrv-g43f-qm7f"
    },
    "@wizloft/harness-plugin-repository-files": {
      blocked_all: true,
      reason: "Malware in @wizloft/harness-plugin-repository-files (GHSA-p4gf-f4rj-hfh8)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-p4gf-f4rj-hfh8"
    },
    "@wizloft/harness-commands": {
      blocked_all: true,
      reason: "Malware in @wizloft/harness-commands (GHSA-cv26-mq7q-h5hq)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-cv26-mq7q-h5hq"
    },
    "@wizloft/harness-cli-adapter": {
      blocked_all: true,
      reason: "Malware in @wizloft/harness-cli-adapter (GHSA-hmmw-27v2-3qc8)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-hmmw-27v2-3qc8"
    },
    "@wizloft/harness-project": {
      blocked_all: true,
      reason: "Malware in @wizloft/harness-project (GHSA-xj44-gx57-mm59)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-xj44-gx57-mm59"
    },
    "@wizloft/harness-plugin-memory-context": {
      blocked_all: true,
      reason: "Malware in @wizloft/harness-plugin-memory-context (GHSA-r4qq-8p58-gfpv)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-r4qq-8p58-gfpv"
    },
    "@wizloft/harness-evidence": {
      blocked_all: true,
      reason: "Malware in @wizloft/harness-evidence (GHSA-mjfj-x5qx-p7v8)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-mjfj-x5qx-p7v8"
    },
    "@wizloft/harness-plugin-file-memory": {
      blocked_all: true,
      reason: "Malware in @wizloft/harness-plugin-file-memory (GHSA-64w5-qg43-54g7)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-64w5-qg43-54g7"
    },
    "@wizloft/harness-plugin-file-events": {
      blocked_all: true,
      reason: "Malware in @wizloft/harness-plugin-file-events (GHSA-6866-wx9h-j2rh)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-6866-wx9h-j2rh"
    },
    "@wizloft/harness-authority": {
      blocked_all: true,
      reason: "Malware in @wizloft/harness-authority (GHSA-8h24-fp89-4cw3)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-8h24-fp89-4cw3"
    },
    "@wizloft/harness-validation": {
      blocked_all: true,
      reason: "Malware in @wizloft/harness-validation (GHSA-7g98-grc6-6xjh)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-7g98-grc6-6xjh"
    },
    "@wizloft/harness-memory": {
      blocked_all: true,
      reason: "Malware in @wizloft/harness-memory (GHSA-3mjw-625p-wvhf)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-3mjw-625p-wvhf"
    },
    "@wizloft/harness-kernel": {
      blocked_all: true,
      reason: "Malware in @wizloft/harness-kernel (GHSA-9f63-qfxp-2726)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-9f63-qfxp-2726"
    },
    "anhn-cli": {
      blocked_all: true,
      reason: "Malware in anhn-cli (GHSA-7fvf-fgwq-85q6)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-7fvf-fgwq-85q6"
    },
    "@wizloft/harness-context": {
      blocked_all: true,
      reason: "Malware in @wizloft/harness-context (GHSA-wjhv-xmmw-qqf9)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-wjhv-xmmw-qqf9"
    },
    "@httttt/mcp-npx-fetch-1": {
      blocked_all: true,
      reason: "Malware in @httttt/mcp-npx-fetch-1 (GHSA-q6m6-3rfx-7f62)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-q6m6-3rfx-7f62"
    },
    "@httttt/mcp-demo": {
      blocked_all: true,
      reason: "Malware in @httttt/mcp-demo (GHSA-phcp-xhhf-xcvq)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-phcp-xhhf-xcvq"
    },
    "evm-validation": {
      blocked_all: true,
      reason: "Malware in evm-validation (GHSA-gvxq-2rq2-f7x6)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-gvxq-2rq2-f7x6"
    },
    "hardhat-hold": {
      blocked_all: true,
      reason: "Malware in hardhat-hold (GHSA-f33v-qqxm-m6m9)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-f33v-qqxm-m6m9"
    },
    "ubiquiti-agents-link-mcp": {
      blocked_all: true,
      reason: "Malicious code in ubiquiti-agents-link-mcp (npm) (GHSA-f2wc-4v37-6f5h)",
      date: "2026-09-22",
      advisory: "https://github.com/advisories/GHSA-f2wc-4v37-6f5h"
    },
    noverojava: {
      blocked_all: true,
      reason: "Malicious code in noverojava (npm) (GHSA-g77m-jmph-gj8q)",
      date: "2026-09-22",
      advisory: "https://github.com/advisories/GHSA-g77m-jmph-gj8q"
    },
    "@baanx/domain": {
      blocked_all: true,
      reason: "Malware in @baanx/domain (GHSA-qhfc-6rp6-pwv6)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-qhfc-6rp6-pwv6"
    },
    "@baanx/common": {
      blocked_all: true,
      reason: "Malware in @baanx/common (GHSA-27jh-hjhg-vg2p)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-27jh-hjhg-vg2p"
    },
    "@rixxcodex/baileys": {
      blocked_all: true,
      reason: "Malicious code in @rixxcodex/baileys (npm) (GHSA-fjxf-mv8f-cp6x)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-fjxf-mv8f-cp6x"
    },
    "pino-testkit": {
      blocked_all: true,
      reason: "Malicious code in pino-testkit (npm) (GHSA-q57p-68r4-fj72)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-q57p-68r4-fj72"
    },
    internallib_v463: {
      blocked_all: true,
      reason: "Malicious code in internallib_v463 (npm) (GHSA-gv94-v8fj-f45c)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-gv94-v8fj-f45c"
    },
    internallib_v657: {
      blocked_all: true,
      reason: "Malicious code in internallib_v657 (npm) (GHSA-w2wx-86qr-g533)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-w2wx-86qr-g533"
    },
    "a-onesite": {
      blocked_all: true,
      reason: "Malicious code in a-onesite (npm) (GHSA-9j7m-m3w9-mgrc)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-9j7m-m3w9-mgrc"
    },
    "com.apple.unityplugin.storekit": {
      blocked_all: true,
      reason: "Malicious code in com.apple.unityplugin.storekit (npm) (GHSA-6r46-f382-x53p)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-6r46-f382-x53p"
    },
    simplenewnpmpackage: {
      blocked_all: true,
      reason: "Malicious code in simplenewnpmpackage (npm) (GHSA-mr2p-c47m-85w8)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-mr2p-c47m-85w8"
    },
    "event-hunter": {
      blocked_all: true,
      reason: "Malicious code in event-hunter (npm) (GHSA-wwrq-gcqx-rx6p)",
      date: "2026-09-23",
      advisory: "https://github.com/advisories/GHSA-wwrq-gcqx-rx6p"
    },
    "app-sca-info-banking": {
      blocked_all: true,
      reason: "Malicious code in app-sca-info-banking (npm) (GHSA-wfg5-3jm7-5p8w)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-wfg5-3jm7-5p8w"
    },
    "secure-env3": {
      blocked_all: true,
      reason: "Malicious code in secure-env3 (npm) (GHSA-w2g5-xcc6-p474)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-w2g5-xcc6-p474"
    },
    "wallet-connect-adapter": {
      blocked_all: true,
      reason: "Malicious code in wallet-connect-adapter (npm) (GHSA-39rm-rv2w-366r)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-39rm-rv2w-366r"
    },
    "n8n-nodes-moonlet-helpers": {
      blocked_all: true,
      reason: "Malicious code in n8n-nodes-moonlet-helpers (npm) (GHSA-hh4f-fhfw-7vgw)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-hh4f-fhfw-7vgw"
    },
    "chromatitle-js": {
      blocked_all: true,
      reason: "Malicious code in chromatitle-js (npm) (GHSA-93mr-5j8f-6p3w)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-93mr-5j8f-6p3w"
    },
    "n8n-nodes-moonlet-utils": {
      blocked_all: true,
      reason: "Malicious code in n8n-nodes-moonlet-utils (npm) (GHSA-f77h-w3rc-2c74)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-f77h-w3rc-2c74"
    },
    "better-dotenv3": {
      blocked_all: true,
      reason: "Malicious code in better-dotenv3 (npm) (GHSA-qx8m-mvxg-49m3)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-qx8m-mvxg-49m3"
    },
    "n8n-nodes-flowstats": {
      blocked_all: true,
      reason: "Malicious code in n8n-nodes-flowstats (npm) (GHSA-wm7h-qmp4-782c)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-wm7h-qmp4-782c"
    },
    "agency-test-exercise": {
      blocked_all: true,
      reason: "Malicious code in agency-test-exercise (npm) (GHSA-qwj9-hfhg-j6vh)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-qwj9-hfhg-j6vh"
    },
    chromatitle: {
      blocked_all: true,
      reason: "Malicious code in chromatitle (npm) (GHSA-7pgp-qm32-53rp)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-7pgp-qm32-53rp"
    },
    "agency-testts": {
      blocked_all: true,
      reason: "Malicious code in agency-testts (npm) (GHSA-75mh-8gwp-9cvf)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-75mh-8gwp-9cvf"
    },
    "@alphaspace/core": {
      blocked_all: true,
      reason: "Malicious code in @alphaspace/core (npm) (GHSA-5qqj-qfpp-jfqw)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-5qqj-qfpp-jfqw"
    },
    "simple-date-formatter-new-15": {
      blocked_all: true,
      reason: "Malicious code in simple-date-formatter-new-15 (npm) (GHSA-fj2x-7537-68xm)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-fj2x-7537-68xm"
    },
    "eslint-config-compact-base": {
      blocked_all: true,
      reason: "Malicious code in eslint-config-compact-base (npm) (GHSA-ghfm-6qx4-q8p4)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-ghfm-6qx4-q8p4"
    },
    "simple-date-formatter-new-14": {
      blocked_all: true,
      reason: "Malicious code in simple-date-formatter-new-14 (npm) (GHSA-7r88-5m7v-8m5w)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-7r88-5m7v-8m5w"
    },
    "aliftech-ui": {
      blocked_all: true,
      reason: "Malicious code in aliftech-ui (npm) (GHSA-648v-rwj3-6j2f)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-648v-rwj3-6j2f"
    },
    "simple-date-formatter-new-11": {
      blocked_all: true,
      reason: "Malicious code in simple-date-formatter-new-11 (npm) (GHSA-2v58-3f75-j4jv)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-2v58-3f75-j4jv"
    },
    "@osl-design/react": {
      blocked_all: true,
      reason: "Malicious code in @osl-design/react (npm) (GHSA-qx4v-776h-xcpw)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-qx4v-776h-xcpw"
    },
    "simple-date-formatter-new-13": {
      blocked_all: true,
      reason: "Malicious code in simple-date-formatter-new-13 (npm) (GHSA-539g-4gx9-g555)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-539g-4gx9-g555"
    },
    "@nf-addons/am-global-header": {
      blocked_all: true,
      reason: "Malicious code in @nf-addons/am-global-header (npm) (GHSA-hj7v-p563-fffq)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-hj7v-p563-fffq"
    },
    "@birbalo/aliftech-ui": {
      blocked_all: true,
      reason: "Malicious code in @birbalo/aliftech-ui (npm) (GHSA-383w-gxv7-cg2f)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-383w-gxv7-cg2f"
    },
    "simple-date-formatter-new-16": {
      blocked_all: true,
      reason: "Malicious code in simple-date-formatter-new-16 (npm) (GHSA-j933-m42r-pjvp)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-j933-m42r-pjvp"
    },
    "building-build": {
      blocked_all: true,
      reason: "Malicious code in building-build (npm) (GHSA-v37c-88px-mm6h)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-v37c-88px-mm6h"
    },
    "c2-client": {
      blocked_all: true,
      reason: "Malicious code in c2-client (npm) (GHSA-h7qv-4h6m-4g2x)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-h7qv-4h6m-4g2x"
    },
    "cache-swipper": {
      blocked_all: true,
      reason: "Malicious code in cache-swipper (npm) (GHSA-55m7-mqpg-rv53)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-55m7-mqpg-rv53"
    },
    "analytics-widget": {
      blocked_all: true,
      reason: "Malicious code in analytics-widget (npm) (GHSA-xpv4-prm5-w6gr)",
      date: "2026-09-24",
      advisory: "https://github.com/advisories/GHSA-xpv4-prm5-w6gr"
    },
    "cma-self-hosted-sandbox-cf": {
      blocked_all: true,
      reason: "Malicious code in cma-self-hosted-sandbox-cf (npm) (GHSA-wjmh-pc3x-575f)",
      date: "2026-09-26",
      advisory: "https://github.com/advisories/GHSA-wjmh-pc3x-575f"
    },
    "chai-as-relay": {
      blocked_all: true,
      reason: "Malicious code in chai-as-relay (npm) (GHSA-mq79-xj84-m775)",
      date: "2026-09-26",
      advisory: "https://github.com/advisories/GHSA-mq79-xj84-m775"
    },
    "@digift/cli": {
      blocked_all: true,
      reason: "Malicious code in @digift/cli (npm) (GHSA-2394-2grm-2336)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-2394-2grm-2336"
    },
    "@nubjs/types": {
      blocked_all: true,
      reason: "Malware in @nubjs/types (GHSA-7qx8-98q7-66p4)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-7qx8-98q7-66p4"
    },
    "shoplist-app": {
      blocked_all: true,
      reason: "Malicious code in shoplist-app (npm) (GHSA-9gqc-gwvw-4228)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-9gqc-gwvw-4228"
    },
    "@airbnb-extended/typescript-config": {
      blocked_all: true,
      reason: "Malicious code in @airbnb-extended/typescript-config (npm) (GHSA-jc5g-qvp3-6hrx)",
      date: "2026-09-25",
      advisory: "https://github.com/advisories/GHSA-jc5g-qvp3-6hrx"
    },
    "@wbnr/design-kit": {
      blocked_all: true,
      reason: "Malware in @wbnr/design-kit (GHSA-865f-pwj5-p2c5)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-865f-pwj5-p2c5"
    },
    "@wbnr/lottiefiles-loader": {
      blocked_all: true,
      reason: "Malware in @wbnr/lottiefiles-loader (GHSA-94r6-cxjq-fq4r)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-94r6-cxjq-fq4r"
    },
    "wbnr-probe-visible-check": {
      blocked_all: true,
      reason: "Malware in wbnr-probe-visible-check (GHSA-65gf-jmp3-4wrc)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-65gf-jmp3-4wrc"
    },
    "kalasnik-npm-simple-test": {
      blocked_all: true,
      reason: "Malware in kalasnik-npm-simple-test (GHSA-pm4h-xrhq-vh62)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-pm4h-xrhq-vh62"
    },
    kjj81: {
      blocked_all: true,
      reason: "Malware in kjj81 (GHSA-9f7c-6fp7-9g6x)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-9f7c-6fp7-9g6x"
    },
    o0o9: {
      blocked_all: true,
      reason: "Malware in o0o9 (GHSA-5f5h-pg84-39h4)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-5f5h-pg84-39h4"
    },
    "uuid-date": {
      blocked_all: true,
      reason: "Malware in uuid-date (GHSA-pqvc-prrc-mv45)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-pqvc-prrc-mv45"
    },
    "@bb1ptest23/test-paket": {
      blocked_all: true,
      reason: "Malicious code in @bb1ptest23/test-paket (npm) (GHSA-mh6f-77j8-pfrp)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-mh6f-77j8-pfrp"
    },
    "capacitor-plugin-service-worker": {
      blocked_all: true,
      reason: "Malware in capacitor-plugin-service-worker (GHSA-qg5c-9jmq-fpmf)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-qg5c-9jmq-fpmf"
    },
    swiper_angular: {
      blocked_all: true,
      reason: "Malware in swiper_angular (GHSA-r6m9-x8fm-wq5c)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-r6m9-x8fm-wq5c"
    },
    "riot-private": {
      blocked_all: true,
      reason: "Malware in riot-private (GHSA-qgpm-ggcf-4fqm)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-qgpm-ggcf-4fqm"
    },
    "seek-pass": {
      blocked_all: true,
      reason: "Malware in seek-pass (GHSA-q39g-5xh5-89h3)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-q39g-5xh5-89h3"
    },
    "api-typings": {
      blocked_all: true,
      reason: "Malware in api-typings (GHSA-gjx9-hrcc-f6qj)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-gjx9-hrcc-f6qj"
    },
    "discord-mfa-solver": {
      blocked_all: true,
      reason: "Malware in discord-mfa-solver (GHSA-vf4w-775x-ccfh)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-vf4w-775x-ccfh"
    },
    "vinzzsync-wacli": {
      blocked_all: true,
      reason: "Malware in vinzzsync-wacli (GHSA-rmcq-f7vh-v86v)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-rmcq-f7vh-v86v"
    },
    tanksync: {
      blocked_all: true,
      reason: "Malware in tanksync (GHSA-47j4-w95p-wjp7)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-47j4-w95p-wjp7"
    },
    "@consts/links": {
      blocked_all: true,
      reason: "Malware in @consts/links (GHSA-5rp9-7r4x-3fqp)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-5rp9-7r4x-3fqp"
    },
    "spotify-url-resolvers": {
      blocked_all: true,
      reason: "Malware in spotify-url-resolvers (GHSA-w77g-6g5j-wr2r)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-w77g-6g5j-wr2r"
    },
    "@digi-kernel/digi-kernel-constrains": {
      blocked_all: true,
      reason: "Malware in @digi-kernel/digi-kernel-constrains (GHSA-h37m-2c3q-82j8)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-h37m-2c3q-82j8"
    },
    "rai6jaisahthaghee5ou-loader-package": {
      blocked_all: true,
      reason: "Malicious code in rai6jaisahthaghee5ou-loader-package (npm) (GHSA-hhf7-grh4-575w)",
      date: "2026-09-29",
      advisory: "https://github.com/advisories/GHSA-hhf7-grh4-575w"
    },
    "native-env": {
      blocked_all: true,
      reason: "Malicious code in native-env (npm) (GHSA-9p6x-527c-vh8p)",
      date: "2026-09-29",
      advisory: "https://github.com/advisories/GHSA-9p6x-527c-vh8p"
    },
    "hardhat-lock": {
      blocked_all: true,
      reason: "Malicious code in hardhat-lock (npm) (GHSA-crqg-xv46-qmmw)",
      date: "2026-09-29",
      advisory: "https://github.com/advisories/GHSA-crqg-xv46-qmmw"
    },
    "mini-hardhat": {
      blocked_all: true,
      reason: "Malicious code in mini-hardhat (npm) (GHSA-wxx2-jv4c-38wh)",
      date: "2026-09-29",
      advisory: "https://github.com/advisories/GHSA-wxx2-jv4c-38wh"
    },
    "test-agency-assignment": {
      blocked_all: true,
      reason: "Malicious code in test-agency-assignment (npm) (GHSA-7x83-rfhr-656r)",
      date: "2026-09-29",
      advisory: "https://github.com/advisories/GHSA-7x83-rfhr-656r"
    },
    "items-validator": {
      blocked_all: true,
      reason: "Malicious code in items-validator (npm) (GHSA-hvv9-35pw-8qvf)",
      date: "2026-09-29",
      advisory: "https://github.com/advisories/GHSA-hvv9-35pw-8qvf"
    },
    "hardhat-zet": {
      blocked_all: true,
      reason: "Malicious code in hardhat-zet (npm) (GHSA-qqvr-prmw-6pq2)",
      date: "2026-09-29",
      advisory: "https://github.com/advisories/GHSA-qqvr-prmw-6pq2"
    },
    "fabric-native-loader": {
      blocked_all: true,
      reason: "Malicious code in fabric-native-loader (npm) (GHSA-h76r-hhqx-cjq3)",
      date: "2026-09-29",
      advisory: "https://github.com/advisories/GHSA-h76r-hhqx-cjq3"
    },
    "dotenv-native": {
      blocked_all: true,
      reason: "Malicious code in dotenv-native (npm) (GHSA-438j-7xq6-grfr)",
      date: "2026-09-29",
      advisory: "https://github.com/advisories/GHSA-438j-7xq6-grfr"
    },
    "llm-nebula": {
      blocked_all: true,
      reason: "Malicious code in llm-nebula (npm) (GHSA-8g48-f52v-xggv)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-8g48-f52v-xggv"
    },
    "nebulaai-sdk": {
      blocked_all: true,
      reason: "Malicious code in nebulaai-sdk (npm) (GHSA-57f4-h93r-jvh6)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-57f4-h93r-jvh6"
    },
    "simple-date-formatter-new-12": {
      blocked_all: true,
      reason: "Malicious code in simple-date-formatter-new-12 (npm) (GHSA-v6p6-9wrj-f56p)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-v6p6-9wrj-f56p"
    },
    "nebula-llm": {
      blocked_all: true,
      reason: "Malicious code in nebula-llm (npm) (GHSA-5ph8-m4r7-g739)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-5ph8-m4r7-g739"
    },
    "figlet-chalk-render": {
      blocked_all: true,
      reason: "Malicious code in figlet-chalk-render (npm) (GHSA-frpq-rj8q-hpr4)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-frpq-rj8q-hpr4"
    },
    "fabric-render-bridge": {
      blocked_all: true,
      reason: "Malicious code in fabric-render-bridge (npm) (GHSA-r54m-4q33-rjvr)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-r54m-4q33-rjvr"
    },
    "fabric-asset-pipeline": {
      blocked_all: true,
      reason: "Malicious code in fabric-asset-pipeline (npm) (GHSA-2h5p-2j55-g9r4)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-2h5p-2j55-g9r4"
    },
    "chalk-figlet": {
      blocked_all: true,
      reason: "Malicious code in chalk-figlet (npm) (GHSA-85m5-qg46-qg28)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-85m5-qg46-qg28"
    },
    "img-to-native": {
      blocked_all: true,
      reason: "Malware in img-to-native (GHSA-pv7p-ghgv-268x)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-pv7p-ghgv-268x"
    },
    "native-runner": {
      blocked_all: true,
      reason: "Malware in native-runner (GHSA-jxw5-69p3-hpm4)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-jxw5-69p3-hpm4"
    },
    "nebulajs-api": {
      blocked_all: true,
      reason: "Malware in nebulajs-api (GHSA-2gr6-gxvx-3594)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-2gr6-gxvx-3594"
    },
    "nebula-sdk": {
      blocked_all: true,
      reason: "Malware in nebula-sdk (GHSA-fm5g-6rr8-p9vq)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-fm5g-6rr8-p9vq"
    },
    "vite-plugin-crypto": {
      blocked_all: true,
      reason: "Malware in vite-plugin-crypto (GHSA-mh9w-qr45-6wrq)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-mh9w-qr45-6wrq"
    },
    "tailwindcss-form-kit": {
      blocked_all: true,
      reason: "Malware in tailwindcss-form-kit (GHSA-cxrh-669r-w2g9)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-cxrh-669r-w2g9"
    },
    "my-skibidi": {
      blocked_all: true,
      reason: "Malware in my-skibidi (GHSA-w4g6-rgx4-2wjf)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-w4g6-rgx4-2wjf"
    },
    chaikit: {
      blocked_all: true,
      reason: "Malware in chaikit (GHSA-6c2m-985r-wrwm)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-6c2m-985r-wrwm"
    },
    "git-en-boite-logging": {
      blocked_all: true,
      reason: "Malicious code in git-en-boite-logging (npm) (GHSA-33v8-h584-r8xc)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-33v8-h584-r8xc"
    },
    "eslint-plugin-skywagon-web": {
      blocked_all: true,
      reason: "Malicious code in eslint-plugin-skywagon-web (npm) (GHSA-pfgw-q545-ch2m)",
      date: "2026-09-28",
      advisory: "https://github.com/advisories/GHSA-pfgw-q545-ch2m"
    },
    levvleys: {
      blocked_all: true,
      reason: "Malicious code in levvleys (npm) (GHSA-9q97-jr9x-2qfr)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-9q97-jr9x-2qfr"
    },
    "@xayz/baileys": {
      blocked_all: true,
      reason: "Malicious code in @xayz/baileys (npm) (GHSA-75px-x2r4-9f98)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-75px-x2r4-9f98"
    },
    "ishumdz-bail": {
      blocked_all: true,
      reason: "Malicious code in ishumdz-bail (npm) (GHSA-hpmr-5fvg-hvqf)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-hpmr-5fvg-hvqf"
    },
    noxleyss: {
      blocked_all: true,
      reason: "Malicious code in noxleyss (npm) (GHSA-wf8j-w269-5xwv)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-wf8j-w269-5xwv"
    },
    "my-baileys": {
      blocked_all: true,
      reason: "Malicious code in my-baileys (npm) (GHSA-xgfv-rm5m-vffw)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-xgfv-rm5m-vffw"
    },
    whalibmob: {
      blocked_all: true,
      reason: "Malicious code in whalibmob (npm) (GHSA-g2qq-9229-mhjq)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-g2qq-9229-mhjq"
    },
    xzbails: {
      blocked_all: true,
      reason: "Malicious code in xzbails (npm) (GHSA-w8fw-prwf-rpmg)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-w8fw-prwf-rpmg"
    },
    xzvbails: {
      blocked_all: true,
      reason: "Malicious code in xzvbails (npm) (GHSA-3x7p-cc3q-4g77)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-3x7p-cc3q-4g77"
    },
    kiyoramarkets: {
      blocked_all: true,
      reason: "Malicious code in kiyoramarkets (npm) (GHSA-mjx8-f269-h2qf)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-mjx8-f269-h2qf"
    },
    "lilys-baileys": {
      blocked_all: true,
      reason: "Malicious code in lilys-baileys (npm) (GHSA-xcqq-823x-hhv7)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-xcqq-823x-hhv7"
    },
    noxxleys: {
      blocked_all: true,
      reason: "Malicious code in noxxleys (npm) (GHSA-rqhh-ghpc-p37r)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-rqhh-ghpc-p37r"
    },
    "yonzoffic-baileys": {
      blocked_all: true,
      reason: "Malicious code in yonzoffic-baileys (npm) (GHSA-j5q9-mf2r-jhf9)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-j5q9-mf2r-jhf9"
    },
    syncxbails: {
      blocked_all: true,
      reason: "Malicious code in syncxbails (npm) (GHSA-hvc6-5q6j-2867)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-hvc6-5q6j-2867"
    },
    "saturn-baileys": {
      blocked_all: true,
      reason: "Malicious code in saturn-baileys (npm) (GHSA-h3r9-cv69-cx87)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-h3r9-cv69-cx87"
    },
    "spencer-baileys": {
      blocked_all: true,
      reason: "Malicious code in spencer-baileys (npm) (GHSA-r58r-8rfq-ff52)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-r58r-8rfq-ff52"
    },
    shadowmd: {
      blocked_all: true,
      reason: "Malicious code in shadowmd (npm) (GHSA-8h9r-v5vf-jvxr)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-8h9r-v5vf-jvxr"
    },
    xzvexpzcbailey: {
      blocked_all: true,
      reason: "Malicious code in xzvexpzcbailey (npm) (GHSA-fwmc-x797-fpr6)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-fwmc-x797-fpr6"
    },
    "monte-md-baileys": {
      blocked_all: true,
      reason: "Malicious code in monte-md-baileys (npm) (GHSA-vxm9-4847-jw5m)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-vxm9-4847-jw5m"
    },
    yonzofficial: {
      blocked_all: true,
      reason: "Malicious code in yonzofficial (npm) (GHSA-5jww-9h4j-x7w7)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-5jww-9h4j-x7w7"
    },
    noverojs: {
      blocked_all: true,
      reason: "Malicious code in noverojs (npm) (GHSA-wj4h-927q-m5xv)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-wj4h-927q-m5xv"
    },
    kasabaileys: {
      blocked_all: true,
      reason: "Malicious code in kasabaileys (npm) (GHSA-vrqh-8vm7-r584)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-vrqh-8vm7-r584"
    },
    keithbaileys: {
      blocked_all: true,
      reason: "Malicious code in keithbaileys (npm) (GHSA-mr96-r2xf-grpw)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-mr96-r2xf-grpw"
    },
    "eliteprotech-baileys": {
      blocked_all: true,
      reason: "Malicious code in eliteprotech-baileys (npm) (GHSA-jjr8-hv8r-m5x7)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-jjr8-hv8r-m5x7"
    },
    xvinleys: {
      blocked_all: true,
      reason: "Malicious code in xvinleys (npm) (GHSA-vpxr-24w4-56qf)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-vpxr-24w4-56qf"
    },
    focashi: {
      blocked_all: true,
      reason: "Malicious code in focashi (npm) (GHSA-9hx5-4wfr-m32w)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-9hx5-4wfr-m32w"
    },
    "@revizahoshii/baileys": {
      blocked_all: true,
      reason: "Malicious code in @revizahoshii/baileys (npm) (GHSA-fhwq-mfvr-5wxg)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-fhwq-mfvr-5wxg"
    },
    "@wanzlonely/bails4u": {
      blocked_all: true,
      reason: "Malicious code in @wanzlonely/bails4u (npm) (GHSA-cvfh-2x22-f8xx)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-cvfh-2x22-f8xx"
    },
    "@xatancchii/velycxbail": {
      blocked_all: true,
      reason: "Malicious code in @xatancchii/velycxbail (npm) (GHSA-fpmr-r559-qrq5)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-fpmr-r559-qrq5"
    },
    "@queenanya/baileys": {
      blocked_all: true,
      reason: "Malicious code in @queenanya/baileys (npm) (GHSA-w659-c49m-62p4)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-w659-c49m-62p4"
    },
    "albert-anitabaileys": {
      blocked_all: true,
      reason: "Malicious code in albert-anitabaileys (npm) (GHSA-2435-2rp3-4hx7)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-2435-2rp3-4hx7"
    },
    "@sakataoffc/baileys": {
      blocked_all: true,
      reason: "Malicious code in @sakataoffc/baileys (npm) (GHSA-cv72-gp3m-2v97)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-cv72-gp3m-2v97"
    },
    anuaja: {
      blocked_all: true,
      reason: "Malicious code in anuaja (npm) (GHSA-g6f9-85p5-hpm9)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-g6f9-85p5-hpm9"
    },
    "@revizahoshii/hoshino": {
      blocked_all: true,
      reason: "Malicious code in @revizahoshii/hoshino (npm) (GHSA-5hw7-w6pr-4249)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-5hw7-w6pr-4249"
    },
    "@sairidev/baileys-new": {
      blocked_all: true,
      reason: "Malicious code in @sairidev/baileys-new (npm) (GHSA-xw6v-5999-m5r7)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-xw6v-5999-m5r7"
    },
    "arsya-baileys": {
      blocked_all: true,
      reason: "Malicious code in arsya-baileys (npm) (GHSA-324p-wm5r-x38v)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-324p-wm5r-x38v"
    },
    "@ostyado/baileys": {
      blocked_all: true,
      reason: "Malicious code in @ostyado/baileys (npm) (GHSA-wcr2-cpf3-rj9m)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-wcr2-cpf3-rj9m"
    },
    "@noxleyss/baileys": {
      blocked_all: true,
      reason: "Malicious code in @noxleyss/baileys (npm) (GHSA-fvp5-5pm3-p4pj)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-fvp5-5pm3-p4pj"
    },
    "@levvicode/baileys": {
      blocked_all: true,
      reason: "Malicious code in @levvicode/baileys (npm) (GHSA-64qg-xmr9-2f4p)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-64qg-xmr9-2f4p"
    },
    "@lendkzn/xntaabail": {
      blocked_all: true,
      reason: "Malicious code in @lendkzn/xntaabail (npm) (GHSA-p5cc-9mw3-v97w)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-p5cc-9mw3-v97w"
    },
    bungoma: {
      blocked_all: true,
      reason: "Malicious code in bungoma (npm) (GHSA-ww72-pf36-94gj)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-ww72-pf36-94gj"
    },
    "baileys-xbats": {
      blocked_all: true,
      reason: "Malicious code in baileys-xbats (npm) (GHSA-7vgr-9ffm-pcvq)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-7vgr-9ffm-pcvq"
    },
    "cantarella-baileys": {
      blocked_all: true,
      reason: "Malicious code in cantarella-baileys (npm) (GHSA-x9p7-rw8c-33cx)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-x9p7-rw8c-33cx"
    },
    "@teamolduser/baileys": {
      blocked_all: true,
      reason: "Malicious code in @teamolduser/baileys (npm) (GHSA-5r2r-xhj4-34x2)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-5r2r-xhj4-34x2"
    },
    "@lendxntaa/baileys": {
      blocked_all: true,
      reason: "Malicious code in @lendxntaa/baileys (npm) (GHSA-pvw3-cpwh-j97f)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-pvw3-cpwh-j97f"
    },
    "@saazkira/baileys": {
      blocked_all: true,
      reason: "Malicious code in @saazkira/baileys (npm) (GHSA-rqcw-rcxf-63pp)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-rqcw-rcxf-63pp"
    },
    "@nyzzpedia/baileys-new": {
      blocked_all: true,
      reason: "Malicious code in @nyzzpedia/baileys-new (npm) (GHSA-rmgh-5jhh-hg68)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-rmgh-5jhh-hg68"
    },
    "@wenzyx1/bails": {
      blocked_all: true,
      reason: "Malicious code in @wenzyx1/bails (npm) (GHSA-2qgj-rvf8-vwqv)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-2qgj-rvf8-vwqv"
    },
    "@rennnpm/baileys": {
      blocked_all: true,
      reason: "Malicious code in @rennnpm/baileys (npm) (GHSA-8w6p-crxw-qc2m)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-8w6p-crxw-qc2m"
    },
    "@nyzzpediaa/baileys-new": {
      blocked_all: true,
      reason: "Malicious code in @nyzzpediaa/baileys-new (npm) (GHSA-vwq4-8q2g-gg4w)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-vwq4-8q2g-gg4w"
    },
    "@mikudeveloper/grace": {
      blocked_all: true,
      reason: "Malicious code in @mikudeveloper/grace (npm) (GHSA-mjq2-8p38-g74g)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-mjq2-8p38-g74g"
    },
    "@mivesensei/baileys": {
      blocked_all: true,
      reason: "Malicious code in @mivesensei/baileys (npm) (GHSA-hgwp-qvq7-jhff)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-hgwp-qvq7-jhff"
    },
    "@ikyyjee/ikyysingle": {
      blocked_all: true,
      reason: "Malicious code in @ikyyjee/ikyysingle (npm) (GHSA-6wpx-c5rq-xq7g)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-6wpx-c5rq-xq7g"
    },
    "@jojoxyz/condemnedforce-baileys": {
      blocked_all: true,
      reason: "Malicious code in @jojoxyz/condemnedforce-baileys (npm) (GHSA-9hqm-fc7g-6425)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-9hqm-fc7g-6425"
    },
    "@ikyyjee/ikyysinggle": {
      blocked_all: true,
      reason: "Malicious code in @ikyyjee/ikyysinggle (npm) (GHSA-gf54-gmxf-9wwx)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-gf54-gmxf-9wwx"
    },
    "@kxa/xbails": {
      blocked_all: true,
      reason: "Malicious code in @kxa/xbails (npm) (GHSA-gm5c-7967-vvfr)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-gm5c-7967-vvfr"
    },
    "@ikanngeming/ikannbail": {
      blocked_all: true,
      reason: "Malicious code in @ikanngeming/ikannbail (npm) (GHSA-rf69-qjhh-rx9h)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-rf69-qjhh-rx9h"
    },
    "@japofc/baileys": {
      blocked_all: true,
      reason: "Malicious code in @japofc/baileys (npm) (GHSA-xg7c-vv95-m77x)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-xg7c-vv95-m77x"
    },
    "@kelvdra/baileys": {
      blocked_all: true,
      reason: "Malicious code in @kelvdra/baileys (npm) (GHSA-qr96-8wf2-prfm)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-qr96-8wf2-prfm"
    },
    "@fhkryxv/baileys-new": {
      blocked_all: true,
      reason: "Malicious code in @fhkryxv/baileys-new (npm) (GHSA-4c5h-x65g-5jxx)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-4c5h-x65g-5jxx"
    },
    "@hanzofc/baileys": {
      blocked_all: true,
      reason: "Malicious code in @hanzofc/baileys (npm) (GHSA-qcfw-cc7v-hqrp)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-qcfw-cc7v-hqrp"
    },
    "@kanaraa/baileys": {
      blocked_all: true,
      reason: "Malicious code in @kanaraa/baileys (npm) (GHSA-prhg-r778-jc6m)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-prhg-r778-jc6m"
    },
    "@fhkryxv/baileys": {
      blocked_all: true,
      reason: "Malicious code in @fhkryxv/baileys (npm) (GHSA-wv5j-q989-gpg9)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-wv5j-q989-gpg9"
    },
    "@bottino/baileys": {
      blocked_all: true,
      reason: "Malicious code in @bottino/baileys (npm) (GHSA-f98g-fwj3-vvxc)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-f98g-fwj3-vvxc"
    },
    "@ikyyjee/ikkysingle": {
      blocked_all: true,
      reason: "Malicious code in @ikyyjee/ikkysingle (npm) (GHSA-7pjq-h23c-mpv6)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-7pjq-h23c-mpv6"
    },
    "@bellaxchuu/velvetry": {
      blocked_all: true,
      reason: "Malicious code in @bellaxchuu/velvetry (npm) (GHSA-g249-pm94-vr27)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-g249-pm94-vr27"
    },
    "@badzz88/baileys": {
      blocked_all: true,
      reason: "Malicious code in @badzz88/baileys (npm) (GHSA-rf9x-xcrv-wjmc)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-rf9x-xcrv-wjmc"
    },
    "@bellaxchuu/teambails": {
      blocked_all: true,
      reason: "Malicious code in @bellaxchuu/teambails (npm) (GHSA-289q-5xqh-ghv5)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-289q-5xqh-ghv5"
    },
    "@bellaxchuu/skyblue": {
      blocked_all: true,
      reason: "Malicious code in @bellaxchuu/skyblue (npm) (GHSA-r285-5mh6-5w3v)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-r285-5mh6-5w3v"
    },
    "@bellaxchuu/xtrxbails": {
      blocked_all: true,
      reason: "Malicious code in @bellaxchuu/xtrxbails (npm) (GHSA-2mwq-vxg9-67pm)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-2mwq-vxg9-67pm"
    },
    "@bellaxchuu/familyxtrx": {
      blocked_all: true,
      reason: "Malicious code in @bellaxchuu/familyxtrx (npm) (GHSA-8m3x-3r2m-qpw7)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-8m3x-3r2m-qpw7"
    },
    "@astracode/byles-new": {
      blocked_all: true,
      reason: "Malicious code in @astracode/byles-new (npm) (GHSA-7jgw-q4fr-8pxr)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-7jgw-q4fr-8pxr"
    },
    "@bellaxchuu/privatebails": {
      blocked_all: true,
      reason: "Malicious code in @bellaxchuu/privatebails (npm) (GHSA-4j8c-968c-8p2r)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-4j8c-968c-8p2r"
    },
    "@bellaxchuu/crystalred": {
      blocked_all: true,
      reason: "Malicious code in @bellaxchuu/crystalred (npm) (GHSA-p97h-939j-wpm5)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-p97h-939j-wpm5"
    },
    "@bellaxchuu/flowblue": {
      blocked_all: true,
      reason: "Malicious code in @bellaxchuu/flowblue (npm) (GHSA-5rx7-7php-xrqp)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-5rx7-7php-xrqp"
    },
    "reactjs-risk": {
      blocked_all: true,
      reason: "Malicious code in reactjs-risk (npm) (GHSA-7c65-pwf5-vfcq)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-7c65-pwf5-vfcq"
    },
    "@bellaxchuu/belbails": {
      blocked_all: true,
      reason: "Malicious code in @bellaxchuu/belbails (npm) (GHSA-94fr-7p9q-mmx4)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-94fr-7p9q-mmx4"
    },
    "contoso-login-sim-loader": {
      blocked_all: true,
      reason: "Malicious code in contoso-login-sim-loader (npm) (GHSA-98rj-4grx-g355)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-98rj-4grx-g355"
    },
    chaienv: {
      blocked_all: true,
      reason: "Malicious code in chaienv (npm) (GHSA-3vpx-vp9c-229p)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-3vpx-vp9c-229p"
    },
    "cdn-img-fetch": {
      blocked_all: true,
      reason: "Malicious code in cdn-img-fetch (npm) (GHSA-34f5-mxpq-x694)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-34f5-mxpq-x694"
    },
    "dotenv-preflight": {
      blocked_all: true,
      reason: "Malicious code in dotenv-preflight (npm) (GHSA-9gqp-7mp4-44qm)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-9gqp-7mp4-44qm"
    },
    "cortana-md-engine": {
      blocked_all: true,
      reason: "Malicious code in cortana-md-engine (npm) (GHSA-25rm-w924-v83v)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-25rm-w924-v83v"
    },
    imgbundle: {
      blocked_all: true,
      reason: "Malicious code in imgbundle (npm) (GHSA-5p43-g79v-96pj)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-5p43-g79v-96pj"
    },
    "fca-raihan": {
      blocked_all: true,
      reason: "Malicious code in fca-raihan (npm) (GHSA-gmjq-r5g4-xc73)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-gmjq-r5g4-xc73"
    },
    exiouss: {
      blocked_all: true,
      reason: "Malicious code in exiouss (npm) (GHSA-gg34-g46w-6hhf)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-gg34-g46w-6hhf"
    },
    "@zeronexcode/baileys": {
      blocked_all: true,
      reason: "Malicious code in @zeronexcode/baileys (npm) (GHSA-h49v-c54j-rfw2)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-h49v-c54j-rfw2"
    },
    runhelper: {
      blocked_all: true,
      reason: "Malicious code in runhelper (npm) (GHSA-pxgx-w72j-f3p8)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-pxgx-w72j-f3p8"
    },
    focaleys: {
      blocked_all: true,
      reason: "Malicious code in focaleys (npm) (GHSA-jfhq-f5v2-pf3m)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-jfhq-f5v2-pf3m"
    },
    "@cat-gen/material": {
      blocked_all: true,
      reason: "Malware in @cat-gen/material (GHSA-m7x3-q6r8-p5rg)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-m7x3-q6r8-p5rg"
    },
    "@cat-gen/materia": {
      blocked_all: true,
      reason: "Malware in @cat-gen/materia (GHSA-m8g8-xcgx-j6hw)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-m8g8-xcgx-j6hw"
    },
    ragacateslikodi: {
      blocked_all: true,
      reason: "Malware in ragacateslikodi (GHSA-mjhw-5x2v-v3wg)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-mjhw-5x2v-v3wg"
    },
    "@firelordzuka/pulse-poc": {
      blocked_all: true,
      reason: "Malware in @firelordzuka/pulse-poc (GHSA-h645-43f8-g987)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-h645-43f8-g987"
    },
    "link-age-great": {
      blocked_all: true,
      reason: "Malware in link-age-great (GHSA-jmrg-vr2j-j96x)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-jmrg-vr2j-j96x"
    },
    "link-status-page": {
      blocked_all: true,
      reason: "Malware in link-status-page (GHSA-5j3f-rr83-xcpq)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-5j3f-rr83-xcpq"
    },
    "web-vitals-polyfill-core-v1": {
      blocked_all: true,
      reason: "Malware in web-vitals-polyfill-core-v1 (GHSA-h475-44q2-vfjx)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-h475-44q2-vfjx"
    },
    "@redman89405/my-module": {
      blocked_all: true,
      reason: "Malware in @redman89405/my-module (GHSA-vc53-jhh2-pwf3)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-vc53-jhh2-pwf3"
    },
    "future-scripts": {
      blocked_all: true,
      reason: "Malicious code in future-scripts (npm) (GHSA-c9xw-xmvx-ffm7)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-c9xw-xmvx-ffm7"
    },
    "pulse-pwn-9f3a2": {
      blocked_all: true,
      reason: "Malware in pulse-pwn-9f3a2 (GHSA-fwr5-cj49-cq4h)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-fwr5-cj49-cq4h"
    },
    "set-egs-backend": {
      blocked_all: true,
      reason: "Malicious code in set-egs-backend (npm) (GHSA-whwx-38wq-2f27)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-whwx-38wq-2f27"
    },
    "player-support-tools-ui": {
      blocked_all: true,
      reason: "Malicious code in player-support-tools-ui (npm) (GHSA-2p95-xv34-387r)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-2p95-xv34-387r"
    },
    "ssp-config-management-tool": {
      blocked_all: true,
      reason: "Malicious code in ssp-config-management-tool (npm) (GHSA-68gm-434m-pfmj)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-68gm-434m-pfmj"
    },
    "mms-ref-dedserver": {
      blocked_all: true,
      reason: "Malicious code in mms-ref-dedserver (npm) (GHSA-v7g9-2fm9-gf3r)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-v7g9-2fm9-gf3r"
    },
    "mms-ref-client": {
      blocked_all: true,
      reason: "Malicious code in mms-ref-client (npm) (GHSA-p4x2-g83h-x323)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-p4x2-g83h-x323"
    },
    "generator-epic-react": {
      blocked_all: true,
      reason: "Malicious code in generator-epic-react (npm) (GHSA-g46p-chgx-c83v)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-g46p-chgx-c83v"
    },
    "store-service-worker": {
      blocked_all: true,
      reason: "Malicious code in store-service-worker (npm) (GHSA-pp63-g67g-4hxq)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-pp63-g67g-4hxq"
    },
    "mod-manager": {
      blocked_all: true,
      reason: "Malicious code in mod-manager (npm) (GHSA-c34f-w6mj-2346)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-c34f-w6mj-2346"
    },
    "qa-egs-rollback": {
      blocked_all: true,
      reason: "Malicious code in qa-egs-rollback (npm) (GHSA-p4fw-q7gp-3mq3)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-p4fw-q7gp-3mq3"
    },
    "mms-simulation": {
      blocked_all: true,
      reason: "Malicious code in mms-simulation (npm) (GHSA-v994-mfhw-f42p)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-v994-mfhw-f42p"
    },
    "mms-tools": {
      blocked_all: true,
      reason: "Malicious code in mms-tools (npm) (GHSA-gvwj-w5p8-h682)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-gvwj-w5p8-h682"
    },
    "mms-thin-client": {
      blocked_all: true,
      reason: "Malicious code in mms-thin-client (npm) (GHSA-557c-973f-xg6r)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-557c-973f-xg6r"
    },
    "mms-service": {
      blocked_all: true,
      reason: "Malicious code in mms-service (npm) (GHSA-pjxq-g48x-h4jh)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-pjxq-g48x-h4jh"
    },
    "ddok-modal": {
      blocked_all: true,
      reason: "Malware in ddok-modal (GHSA-5xvp-j6m9-rwr6)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-5xvp-j6m9-rwr6"
    },
    "com.epi.e2e_test": {
      blocked_all: true,
      reason: "Malicious code in com.epi.e2e_test (npm) (GHSA-76w7-xhq5-w327)",
      date: "2026-09-30",
      advisory: "https://github.com/advisories/GHSA-76w7-xhq5-w327"
    },
    niksinnkatalapp: {
      blocked_all: true,
      reason: "Malicious code in niksinnkatalapp (npm) (GHSA-g37r-cvvp-rj75)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-g37r-cvvp-rj75"
    },
    "@bluewin/utils": {
      blocked_all: true,
      reason: "Malicious code in @bluewin/utils (npm) (GHSA-9ggj-2v34-hwv8)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-9ggj-2v34-hwv8"
    },
    "ai-workshop-radio-app": {
      blocked_all: true,
      reason: "Malicious code in ai-workshop-radio-app (npm) (GHSA-rxfj-38w3-hw2x)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-rxfj-38w3-hw2x"
    },
    "live-detection-dashboard": {
      blocked_all: true,
      reason: "Malicious code in live-detection-dashboard (npm) (GHSA-h4cx-hwvc-8mgj)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-h4cx-hwvc-8mgj"
    },
    "brioche-apl-dev-env": {
      blocked_all: true,
      reason: "Malicious code in brioche-apl-dev-env (npm) (GHSA-8r2r-7gc9-8vq8)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-8r2r-7gc9-8vq8"
    },
    "ai-workshop-radio-lambda": {
      blocked_all: true,
      reason: "Malicious code in ai-workshop-radio-lambda (npm) (GHSA-427x-rv7c-m3f9)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-427x-rv7c-m3f9"
    },
    "alexa-cybertron-team-code-review-agent": {
      blocked_all: true,
      reason: "Malicious code in alexa-cybertron-team-code-review-agent (npm) (GHSA-g7c3-m79h-9cqq)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-g7c3-m79h-9cqq"
    },
    "danz-bails": {
      blocked_all: true,
      reason: "Malicious code in danz-bails (npm) (GHSA-83xg-jvg8-96qw)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-83xg-jvg8-96qw"
    },
    "apl-rive-renderer": {
      blocked_all: true,
      reason: "Malicious code in apl-rive-renderer (npm) (GHSA-66jg-9x42-xwh9)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-66jg-9x42-xwh9"
    },
    xcvrenzcompany: {
      blocked_all: true,
      reason: "Malicious code in xcvrenzcompany (npm) (GHSA-474r-6338-73gj)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-474r-6338-73gj"
    },
    "okra-cloud-cdk": {
      blocked_all: true,
      reason: "Malicious code in okra-cloud-cdk (npm) (GHSA-7rq8-hfxr-pxhw)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-7rq8-hfxr-pxhw"
    },
    prastzy: {
      blocked_all: true,
      reason: "Malicious code in prastzy (npm) (GHSA-phvc-2p87-8jf3)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-phvc-2p87-8jf3"
    },
    "@zanta/baileys": {
      blocked_all: true,
      reason: "Malicious code in @zanta/baileys (npm) (GHSA-44wf-ggpw-qq53)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-44wf-ggpw-qq53"
    },
    wailib: {
      blocked_all: true,
      reason: "Malicious code in wailib (npm) (GHSA-w72m-vjx4-9m36)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-w72m-vjx4-9m36"
    },
    "figma-to-apl": {
      blocked_all: true,
      reason: "Malicious code in figma-to-apl (npm) (GHSA-fmw8-mrp6-mj68)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-fmw8-mrp6-mj68"
    },
    "ai-workshop-maa15-radio": {
      blocked_all: true,
      reason: "Malicious code in ai-workshop-maa15-radio (npm) (GHSA-5m79-v4p8-r597)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-5m79-v4p8-r597"
    },
    "mikuhostt-baileys": {
      blocked_all: true,
      reason: "Malicious code in mikuhostt-baileys (npm) (GHSA-p4xf-x6j2-mq3f)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-p4xf-x6j2-mq3f"
    },
    "luoxy-baileys": {
      blocked_all: true,
      reason: "Malicious code in luoxy-baileys (npm) (GHSA-rhcf-fwmc-3cm3)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-rhcf-fwmc-3cm3"
    },
    prastzyy: {
      blocked_all: true,
      reason: "Malicious code in prastzyy (npm) (GHSA-23mj-w7jj-h63m)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-23mj-w7jj-h63m"
    },
    "rubbydev-crash-baileys": {
      blocked_all: true,
      reason: "Malicious code in rubbydev-crash-baileys (npm) (GHSA-2cr6-p8h2-g7pv)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-2cr6-p8h2-g7pv"
    },
    "@fazzcodestudio/wa-web": {
      blocked_all: true,
      reason: "Malicious code in @fazzcodestudio/wa-web (npm) (GHSA-6c6x-j4h9-g6mh)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-6c6x-j4h9-g6mh"
    },
    "@smart-dev-wa/baileys": {
      blocked_all: true,
      reason: "Malicious code in @smart-dev-wa/baileys (npm) (GHSA-x69h-gm3h-2w4q)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-x69h-gm3h-2w4q"
    },
    "ichigo-baileys": {
      blocked_all: true,
      reason: "Malicious code in ichigo-baileys (npm) (GHSA-jmwp-25hp-85hw)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-jmwp-25hp-85hw"
    },
    "@erlanzz/baileys": {
      blocked_all: true,
      reason: "Malicious code in @erlanzz/baileys (npm) (GHSA-pwrr-vrh9-c7gf)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-pwrr-vrh9-c7gf"
    },
    "@developmentyora/baileyss": {
      blocked_all: true,
      reason: "Malicious code in @developmentyora/baileyss (npm) (GHSA-hr4v-9q47-37m3)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-hr4v-9q47-37m3"
    },
    "@celestial-community/baileys": {
      blocked_all: true,
      reason: "Malicious code in @celestial-community/baileys (npm) (GHSA-vcwh-7gr6-f894)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-vcwh-7gr6-f894"
    },
    "kartykgithub-ph-f": {
      blocked_all: true,
      reason: "Malware in kartykgithub-ph-f (GHSA-x2m2-w3gv-m5wg)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-x2m2-w3gv-m5wg"
    },
    "kartykgithub-ph-e": {
      blocked_all: true,
      reason: "Malware in kartykgithub-ph-e (GHSA-7hq7-x7ww-7cxr)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-7hq7-x7ww-7cxr"
    },
    "kartykgithub-ph-b": {
      blocked_all: true,
      reason: "Malware in kartykgithub-ph-b (GHSA-27m4-jjxc-69wf)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-27m4-jjxc-69wf"
    },
    "illusion-datalab": {
      blocked_all: true,
      reason: "Malware in illusion-datalab (GHSA-834w-x8gq-8rmx)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-834w-x8gq-8rmx"
    },
    "online-header": {
      blocked_all: true,
      reason: "Malicious code in online-header (npm) (GHSA-hg4r-6gv8-6hmj)",
      date: "2026-10-01",
      advisory: "https://github.com/advisories/GHSA-hg4r-6gv8-6hmj"
    },
    mfahelper: {
      blocked_all: true,
      reason: "Malware in mfahelper (GHSA-9f55-6cf9-3pgw)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-9f55-6cf9-3pgw"
    },
    "@smwebserver/static": {
      blocked_all: true,
      reason: "Malicious code in @smwebserver/static (npm) (GHSA-xh7x-r46x-g84q)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-xh7x-r46x-g84q"
    },
    "translate-base-font": {
      blocked_all: true,
      reason: "Malware in translate-base-font (GHSA-grv5-7wp6-vw6h)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-grv5-7wp6-vw6h"
    },
    "ui.dist.min.js": {
      blocked_all: true,
      reason: "Malware in ui.dist.min.js (GHSA-325f-rjxf-3gm9)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-325f-rjxf-3gm9"
    },
    "ui-base-colors": {
      blocked_all: true,
      reason: "Malware in ui-base-colors (GHSA-qgqx-3mhx-jwx3)",
      date: "2026-10-02",
      advisory: "https://github.com/advisories/GHSA-qgqx-3mhx-jwx3"
    },
    "@subql/common": {
      blocked_all: true,
      reason: "Malware in @subql/common (GHSA-9333-3c4x-x3h5)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-9333-3c4x-x3h5"
    },
    typesens: {
      blocked_all: true,
      reason: "Malicious code in typesens (npm) (GHSA-mh5h-258m-rw22)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-mh5h-258m-rw22"
    },
    tostpro: {
      blocked_all: true,
      reason: "Malicious code in tostpro (npm) (GHSA-462h-3mh4-gh4m)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-462h-3mh4-gh4m"
    },
    "css-txedrf-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-txedrf-polyfill (npm) (GHSA-xjj7-95rf-xxgq)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-xjj7-95rf-xxgq"
    },
    "ph-common": {
      blocked_all: true,
      reason: "Malicious code in ph-common (npm) (GHSA-g6x8-wj65-55v2)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-g6x8-wj65-55v2"
    },
    "unified-platform": {
      blocked_all: true,
      reason: "Malicious code in unified-platform (npm) (GHSA-wpv3-cp2c-m843)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-wpv3-cp2c-m843"
    },
    "risk-detection": {
      blocked_all: true,
      reason: "Malicious code in risk-detection (npm) (GHSA-367w-p5mp-qr5j)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-367w-p5mp-qr5j"
    },
    "api-nebula": {
      blocked_all: true,
      reason: "Malicious code in api-nebula (npm) (GHSA-jj92-6g5g-gg78)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-jj92-6g5g-gg78"
    },
    "css-ogojwh-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-ogojwh-polyfill (npm) (GHSA-29mx-x4mq-3x9j)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-29mx-x4mq-3x9j"
    },
    "insomnia-plugin-api-lint-helper": {
      blocked_all: true,
      reason: "Malicious code in insomnia-plugin-api-lint-helper (npm) (GHSA-48cg-3rqj-p4f3)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-48cg-3rqj-p4f3"
    },
    "css-svqggc-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-svqggc-polyfill (npm) (GHSA-67vj-fvv3-m9f5)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-67vj-fvv3-m9f5"
    },
    "hardhat-kex": {
      blocked_all: true,
      reason: "Malicious code in hardhat-kex (npm) (GHSA-g6j9-c37g-6cwx)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-g6j9-c37g-6cwx"
    },
    "css-mpmdds-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-mpmdds-polyfill (npm) (GHSA-7f4m-pm4p-cp8q)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-7f4m-pm4p-cp8q"
    },
    "hardhat-spack": {
      blocked_all: true,
      reason: "Malicious code in hardhat-spack (npm) (GHSA-p24j-qh47-mf78)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-p24j-qh47-mf78"
    },
    "css-nbanqq-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-nbanqq-polyfill (npm) (GHSA-87mm-9c3c-4xp5)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-87mm-9c3c-4xp5"
    },
    internallib_v923: {
      blocked_all: true,
      reason: "Malicious code in internallib_v923 (npm) (GHSA-729c-mqh7-8m3m)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-729c-mqh7-8m3m"
    },
    "css-display-reading-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-display-reading-polyfill (npm) (GHSA-c8vg-2r7m-hfch)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-c8vg-2r7m-hfch"
    },
    "css-hgwctv-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-hgwctv-polyfill (npm) (GHSA-7q76-4xm4-4v93)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-7q76-4xm4-4v93"
    },
    "css-ayucyz-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-ayucyz-polyfill (npm) (GHSA-2wxc-f4mp-28fp)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-2wxc-f4mp-28fp"
    },
    "css-at-scope-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-at-scope-polyfill (npm) (GHSA-h5r5-rc62-j2gj)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-h5r5-rc62-j2gj"
    },
    "css-gvqmfn-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-gvqmfn-polyfill (npm) (GHSA-f7jc-h6hm-qhx4)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-f7jc-h6hm-qhx4"
    },
    "@qngular/core": {
      blocked_all: true,
      reason: "Malicious code in @qngular/core (npm) (GHSA-rwv8-8xgx-7c3r)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-rwv8-8xgx-7c3r"
    },
    "css-dwsawd-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-dwsawd-polyfill (npm) (GHSA-xvvh-qgjc-g49x)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-xvvh-qgjc-g49x"
    },
    "abbishal-poc": {
      blocked_all: true,
      reason: "Malicious code in abbishal-poc (npm) (GHSA-338q-8q2m-5426)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-338q-8q2m-5426"
    },
    "@inpeek/odata": {
      blocked_all: true,
      reason: "Malicious code in @inpeek/odata (npm) (GHSA-wffh-h964-cp5q)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-wffh-h964-cp5q"
    },
    "@inpeek/odata-angular": {
      blocked_all: true,
      reason: "Malicious code in @inpeek/odata-angular (npm) (GHSA-qfq6-5pwx-q8f5)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-qfq6-5pwx-q8f5"
    },
    "@anuglar/core": {
      blocked_all: true,
      reason: "Malicious code in @anuglar/core (npm) (GHSA-6p2c-j6rp-rxch)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-6p2c-j6rp-rxch"
    },
    "@abgular/core": {
      blocked_all: true,
      reason: "Malicious code in @abgular/core (npm) (GHSA-58jj-ccq3-fxq3)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-58jj-ccq3-fxq3"
    },
    "css-ikomdq-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-ikomdq-polyfill (npm) (GHSA-vfrj-frg7-gx5v)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-vfrj-frg7-gx5v"
    },
    "@angupar/core": {
      blocked_all: true,
      reason: "Malicious code in @angupar/core (npm) (GHSA-8v93-83f6-whc9)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-8v93-83f6-whc9"
    },
    "@anguar/core": {
      blocked_all: true,
      reason: "Malicious code in @anguar/core (npm) (GHSA-pjc3-f292-727c)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-pjc3-f292-727c"
    },
    "@angulaar/core": {
      blocked_all: true,
      reason: "Malicious code in @angulaar/core (npm) (GHSA-h45p-4h47-vgjq)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-h45p-4h47-vgjq"
    },
    "@angulaar/cli": {
      blocked_all: true,
      reason: "Malicious code in @angulaar/cli (npm) (GHSA-65xg-ghmw-cq2c)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-65xg-ghmw-cq2c"
    },
    "aria-live-region-helper": {
      blocked_all: true,
      reason: "Malicious code in aria-live-region-helper (npm) (GHSA-2rx7-6p88-g7x4)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-2rx7-6p88-g7x4"
    },
    "@anngular/core": {
      blocked_all: true,
      reason: "Malicious code in @anngular/core (npm) (GHSA-jxv9-3rgw-q36v)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-jxv9-3rgw-q36v"
    },
    "@angulr/core": {
      blocked_all: true,
      reason: "Malicious code in @angulr/core (npm) (GHSA-vx9x-cv7q-rq74)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-vx9x-cv7q-rq74"
    },
    "@angjlar/core": {
      blocked_all: true,
      reason: "Malicious code in @angjlar/core (npm) (GHSA-m2v2-6rv3-7f7v)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-m2v2-6rv3-7f7v"
    },
    "@anfular/core": {
      blocked_all: true,
      reason: "Malicious code in @anfular/core (npm) (GHSA-857q-84q8-fxgx)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-857q-84q8-fxgx"
    },
    "focus-visible-polyfill-lite": {
      blocked_all: true,
      reason: "Malicious code in focus-visible-polyfill-lite (npm) (GHSA-5h59-r5m3-rf9w)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-5h59-r5m3-rf9w"
    },
    "express-fork": {
      blocked_all: true,
      reason: "Malicious code in express-fork (npm) (GHSA-5pr8-5p22-ffv8)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-5pr8-5p22-ffv8"
    },
    "express-enhanced": {
      blocked_all: true,
      reason: "Malicious code in express-enhanced (npm) (GHSA-qj2f-36rw-2gvm)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-qj2f-36rw-2gvm"
    },
    "css-starting-style-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-starting-style-polyfill (npm) (GHSA-64fj-vj54-m8r3)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-64fj-vj54-m8r3"
    },
    "css-snap-target-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-snap-target-polyfill (npm) (GHSA-x6m9-jxjp-c938)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-x6m9-jxjp-c938"
    },
    "css-light-dark-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-light-dark-polyfill (npm) (GHSA-p6p9-mjx4-2fgf)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-p6p9-mjx4-2fgf"
    },
    "css-gap-decorations-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-gap-decorations-polyfill (npm) (GHSA-gpfw-fchg-rwjm)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-gpfw-fchg-rwjm"
    },
    "css-relative-color-util": {
      blocked_all: true,
      reason: "Malicious code in css-relative-color-util (npm) (GHSA-63h7-vcf3-9xgh)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-63h7-vcf3-9xgh"
    },
    "css-interop-observer-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-interop-observer-polyfill (npm) (GHSA-h3hx-44p9-q47q)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-h3hx-44p9-q47q"
    },
    "chai-as-testmode": {
      blocked_all: true,
      reason: "Malicious code in chai-as-testmode (npm) (GHSA-5hx2-mp3m-4gr6)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-5hx2-mp3m-4gr6"
    },
    "css-scroll-anchor-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-scroll-anchor-polyfill (npm) (GHSA-wqfg-33rw-c9rw)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-wqfg-33rw-c9rw"
    },
    "css-logical-prop-shim": {
      blocked_all: true,
      reason: "Malicious code in css-logical-prop-shim (npm) (GHSA-7g6f-95c5-ghgv)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-7g6f-95c5-ghgv"
    },
    "css-field-sizing-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-field-sizing-polyfill (npm) (GHSA-rmf7-f53x-p8v6)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-rmf7-f53x-p8v6"
    },
    "css-scroll-state-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-scroll-state-polyfill (npm) (GHSA-wwwp-g75q-ww7r)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-wwwp-g75q-ww7r"
    },
    "css-reading-flow-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-reading-flow-polyfill (npm) (GHSA-h7h4-gh2m-xjmq)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-h7h4-gh2m-xjmq"
    },
    "css-env-function-shim": {
      blocked_all: true,
      reason: "Malicious code in css-env-function-shim (npm) (GHSA-592h-fp69-gpjf)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-592h-fp69-gpjf"
    },
    "css-a11y-contrast-utils": {
      blocked_all: true,
      reason: "Malicious code in css-a11y-contrast-utils (npm) (GHSA-4hxq-p3xc-m5cr)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-4hxq-p3xc-m5cr"
    },
    "core-js-gnz": {
      blocked_all: true,
      reason: "Malicious code in core-js-gnz (npm) (GHSA-5q2j-22rc-7634)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-5q2j-22rc-7634"
    },
    "css-anchor-pos-fallback": {
      blocked_all: true,
      reason: "Malicious code in css-anchor-pos-fallback (npm) (GHSA-4ppq-v2jm-24mc)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-4ppq-v2jm-24mc"
    },
    "wcag-color-a11y-helpers": {
      blocked_all: true,
      reason: "Malicious code in wcag-color-a11y-helpers (npm) (GHSA-hp8q-m388-6xxg)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-hp8q-m388-6xxg"
    },
    "ultimate-websocket": {
      blocked_all: true,
      reason: "Malicious code in ultimate-websocket (npm) (GHSA-w8c4-4fjc-rg48)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-w8c4-4fjc-rg48"
    },
    "tiny-viewport-unit-calc": {
      blocked_all: true,
      reason: "Malicious code in tiny-viewport-unit-calc (npm) (GHSA-q9p4-hv94-cxpj)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-q9p4-hv94-cxpj"
    },
    "tiny-dom-focus-trap": {
      blocked_all: true,
      reason: "Malicious code in tiny-dom-focus-trap (npm) (GHSA-vr8g-34ph-vq26)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-vr8g-34ph-vq26"
    },
    "tiny-css-token-parser": {
      blocked_all: true,
      reason: "Malicious code in tiny-css-token-parser (npm) (GHSA-gc5p-h89m-743g)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-gc5p-h89m-743g"
    },
    "tiny-focusgroup-helper": {
      blocked_all: true,
      reason: "Malicious code in tiny-focusgroup-helper (npm) (GHSA-vj2w-9332-v252)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-vj2w-9332-v252"
    },
    "tailwindcss-forms-styles": {
      blocked_all: true,
      reason: "Malicious code in tailwindcss-forms-styles (npm) (GHSA-6qrh-6qq7-9xjh)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-6qrh-6qq7-9xjh"
    },
    "monitoring-agent": {
      blocked_all: true,
      reason: "Malicious code in monitoring-agent (npm) (GHSA-9q5r-qjph-hpr8)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-9q5r-qjph-hpr8"
    },
    studiocode_tools: {
      blocked_all: true,
      reason: "Malicious code in studiocode_tools (npm) (GHSA-j79g-9wmp-mcv8)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-j79g-9wmp-mcv8"
    },
    "lite-matte": {
      blocked_all: true,
      reason: "Malicious code in lite-matte (npm) (GHSA-4c6x-w3wj-2cr2)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-4c6x-w3wj-2cr2"
    },
    studiocode_eligibility: {
      blocked_all: true,
      reason: "Malicious code in studiocode_eligibility (npm) (GHSA-chvh-489x-9963)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-chvh-489x-9963"
    },
    "dom-focus-sentinel": {
      blocked_all: true,
      reason: "Malicious code in dom-focus-sentinel (npm) (GHSA-94wj-mm38-wwhp)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-94wj-mm38-wwhp"
    },
    "hardhat-jsx": {
      blocked_all: true,
      reason: "Malicious code in hardhat-jsx (npm) (GHSA-w5cp-x835-j7fg)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-w5cp-x835-j7fg"
    },
    "botmaker-cli": {
      blocked_all: true,
      reason: "Malicious code in botmaker-cli (npm) (GHSA-h2r5-f9pw-xprr)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-h2r5-f9pw-xprr"
    },
    "popover-anchor-polyfill": {
      blocked_all: true,
      reason: "Malicious code in popover-anchor-polyfill (npm) (GHSA-254v-2947-w7m9)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-254v-2947-w7m9"
    },
    "postcss-gap-fallback-util": {
      blocked_all: true,
      reason: "Malicious code in postcss-gap-fallback-util (npm) (GHSA-35rh-mx8g-vj6f)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-35rh-mx8g-vj6f"
    },
    "lite-matterr": {
      blocked_all: true,
      reason: "Malicious code in lite-matterr (npm) (GHSA-6p6v-j47j-wgcr)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-6p6v-j47j-wgcr"
    },
    "rgx33-css-grid-utils": {
      blocked_all: true,
      reason: "Malicious code in rgx33-css-grid-utils (npm) (GHSA-fqp7-jcwh-2jp3)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-fqp7-jcwh-2jp3"
    },
    internallib_v275: {
      blocked_all: true,
      reason: "Malicious code in internallib_v275 (npm) (GHSA-wp69-7q5m-655v)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-wp69-7q5m-655v"
    },
    "oleh-modal": {
      blocked_all: true,
      reason: "Malicious code in oleh-modal (npm) (GHSA-g7w2-c843-wqvj)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-g7w2-c843-wqvj"
    },
    "lite-mater": {
      blocked_all: true,
      reason: "Malicious code in lite-mater (npm) (GHSA-294m-x97c-p7xh)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-294m-x97c-p7xh"
    },
    "dotenv-promises": {
      blocked_all: true,
      reason: "Malicious code in dotenv-promises (npm) (GHSA-f39p-674r-wpww)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-f39p-674r-wpww"
    },
    "minimal-a11y-contrast-check": {
      blocked_all: true,
      reason: "Malicious code in minimal-a11y-contrast-check (npm) (GHSA-xhw7-45rg-wv8m)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-xhw7-45rg-wv8m"
    },
    "rgx33-flex-layout-core": {
      blocked_all: true,
      reason: "Malicious code in rgx33-flex-layout-core (npm) (GHSA-w2cr-cx6p-c475)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-w2cr-cx6p-c475"
    },
    "promises-dotenv3": {
      blocked_all: true,
      reason: "Malicious code in promises-dotenv3 (npm) (GHSA-3rx7-3cx7-x3hv)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-3rx7-3cx7-x3hv"
    },
    "hardhat-ftp": {
      blocked_all: true,
      reason: "Malicious code in hardhat-ftp (npm) (GHSA-85mm-jcj2-w79v)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-85mm-jcj2-w79v"
    },
    "hardhat-roof": {
      blocked_all: true,
      reason: "Malicious code in hardhat-roof (npm) (GHSA-99j2-pxrq-hpqc)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-99j2-pxrq-hpqc"
    },
    "hardhat-plus": {
      blocked_all: true,
      reason: "Malicious code in hardhat-plus (npm) (GHSA-2hcg-vv96-p63m)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-2hcg-vv96-p63m"
    },
    "dotenv-async": {
      blocked_all: true,
      reason: "Malicious code in dotenv-async (npm) (GHSA-5gq4-v664-5cwf)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-5gq4-v664-5cwf"
    },
    "a11y-tabindex-manager": {
      blocked_all: true,
      reason: "Malicious code in a11y-tabindex-manager (npm) (GHSA-6rjc-7w2v-h9mg)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-6rjc-7w2v-h9mg"
    },
    "@kibt/www-nuxt-i18n": {
      blocked_all: true,
      reason: "Malicious code in @kibt/www-nuxt-i18n (npm) (GHSA-gh38-mqx9-5mxf)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-gh38-mqx9-5mxf"
    },
    "@nagular/router": {
      blocked_all: true,
      reason: "Malicious code in @nagular/router (npm) (GHSA-cg42-crqv-qjm9)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-cg42-crqv-qjm9"
    },
    "@angulra/cli": {
      blocked_all: true,
      reason: "Malicious code in @angulra/cli (npm) (GHSA-2gcf-qjvx-w58p)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-2gcf-qjvx-w58p"
    },
    "@nagular/core": {
      blocked_all: true,
      reason: "Malicious code in @nagular/core (npm) (GHSA-wxf9-85p5-gwhp)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-wxf9-85p5-gwhp"
    },
    "@babell/core": {
      blocked_all: true,
      reason: "Malicious code in @babell/core (npm) (GHSA-9hmh-c2v6-5rx3)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-9hmh-c2v6-5rx3"
    },
    "@angularr/core": {
      blocked_all: true,
      reason: "Malicious code in @angularr/core (npm) (GHSA-9rxx-xxjx-v9w8)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-9rxx-xxjx-v9w8"
    },
    "@angularr/router": {
      blocked_all: true,
      reason: "Malicious code in @angularr/router (npm) (GHSA-37mv-mqr9-gv2x)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-37mv-mqr9-gv2x"
    },
    "@angularr/cli": {
      blocked_all: true,
      reason: "Malicious code in @angularr/cli (npm) (GHSA-3954-6vvg-qq74)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-3954-6vvg-qq74"
    },
    "@angulra/core": {
      blocked_all: true,
      reason: "Malicious code in @angulra/core (npm) (GHSA-836w-242f-9mvg)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-836w-242f-9mvg"
    },
    "captchetat-angularv8": {
      blocked_all: true,
      reason: "Malware in captchetat-angularv8 (GHSA-7crr-x792-cp3w)",
      date: "2026-10-06",
      advisory: "https://github.com/advisories/GHSA-7crr-x792-cp3w"
    },
    internallib_v875: {
      blocked_all: true,
      reason: "Malicious code in internallib_v875 (npm) (GHSA-pjcv-xqxg-cv9j)",
      date: "2026-10-06",
      advisory: "https://github.com/advisories/GHSA-pjcv-xqxg-cv9j"
    },
    internallib_v86: {
      blocked_all: true,
      reason: "Malicious code in internallib_v86 (npm) (GHSA-5q3r-2hm2-jm3j)",
      date: "2026-10-06",
      advisory: "https://github.com/advisories/GHSA-5q3r-2hm2-jm3j"
    },
    "hardhat-init": {
      blocked_all: true,
      reason: "Malicious code in hardhat-init (npm) (GHSA-w6mp-phr7-c2v5)",
      date: "2026-10-06",
      advisory: "https://github.com/advisories/GHSA-w6mp-phr7-c2v5"
    },
    internallib_v23: {
      blocked_all: true,
      reason: "Malicious code in internallib_v23 (npm) (GHSA-hpq7-6v2v-xmq3)",
      date: "2026-10-06",
      advisory: "https://github.com/advisories/GHSA-hpq7-6v2v-xmq3"
    },
    internallib_v30: {
      blocked_all: true,
      reason: "Malicious code in internallib_v30 (npm) (GHSA-rqhh-xrhc-wr23)",
      date: "2026-10-06",
      advisory: "https://github.com/advisories/GHSA-rqhh-xrhc-wr23"
    },
    "@pinecone-experience/messages": {
      blocked_all: true,
      reason: "Malicious code in @pinecone-experience/messages (npm) (GHSA-px72-v3hv-7q87)",
      date: "2026-10-06",
      advisory: "https://github.com/advisories/GHSA-px72-v3hv-7q87"
    },
    "virgil-cli": {
      blocked_all: true,
      reason: "Malicious code in virgil-cli (npm) (GHSA-6j8f-g5mj-4wcj)",
      date: "2026-10-06",
      advisory: "https://github.com/advisories/GHSA-6j8f-g5mj-4wcj"
    },
    "css-vvgsze-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-vvgsze-polyfill (npm) (GHSA-hcp6-vwm8-q8x9)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-hcp6-vwm8-q8x9"
    },
    "css-yhpodl-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-yhpodl-polyfill (npm) (GHSA-2jxx-gxxm-qqfv)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-2jxx-gxxm-qqfv"
    },
    "css-gwqyid-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-gwqyid-polyfill (npm) (GHSA-x6w7-8rr6-f834)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-x6w7-8rr6-f834"
    },
    "css-nrmgzn-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-nrmgzn-polyfill (npm) (GHSA-6qc5-m3jm-2rg5)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-6qc5-m3jm-2rg5"
    },
    "css-eqxcdx-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-eqxcdx-polyfill (npm) (GHSA-4q3v-p549-vp7m)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-4q3v-p549-vp7m"
    },
    "with-cte": {
      blocked_all: true,
      reason: "Malicious code in with-cte (npm) (GHSA-3gw4-w474-rj2f)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-3gw4-w474-rj2f"
    },
    "css-kfvwax-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-kfvwax-polyfill (npm) (GHSA-c9cg-4hcw-x27p)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-c9cg-4hcw-x27p"
    },
    "checkmate-remediation-assistant": {
      blocked_all: true,
      reason: "Malicious code in checkmate-remediation-assistant (npm) (GHSA-x239-w7m5-vrjh)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-x239-w7m5-vrjh"
    },
    documenclient: {
      blocked_all: true,
      reason: "Malware in documenclient (GHSA-648r-w4vm-vvvp)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-648r-w4vm-vvvp"
    },
    serpacksven: {
      blocked_all: true,
      reason: "Malware in serpacksven (GHSA-297h-8m5x-925p)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-297h-8m5x-925p"
    },
    serpacksven2: {
      blocked_all: true,
      reason: "Malware in serpacksven2 (GHSA-4pg5-wvv5-w7fg)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-4pg5-wvv5-w7fg"
    },
    serpacksven1: {
      blocked_all: true,
      reason: "Malware in serpacksven1 (GHSA-696v-rr55-26pc)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-696v-rr55-26pc"
    },
    dzyclutch: {
      blocked_all: true,
      reason: "Malware in dzyclutch (GHSA-36rj-4crv-cmgm)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-36rj-4crv-cmgm"
    },
    "dzyclutch-baileys": {
      blocked_all: true,
      reason: "Malware in dzyclutch-baileys (GHSA-c936-2h58-8v2f)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-c936-2h58-8v2f"
    },
    "dzyhaxz-libsignal": {
      blocked_all: true,
      reason: "Malware in dzyhaxz-libsignal (GHSA-jjrx-mg27-p6ww)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-jjrx-mg27-p6ww"
    },
    "dzyhaxz-baileys": {
      blocked_all: true,
      reason: "Malware in dzyhaxz-baileys (GHSA-xwv2-25hq-j64g)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-xwv2-25hq-j64g"
    },
    "dzyclutch-libsignal-node": {
      blocked_all: true,
      reason: "Malware in dzyclutch-libsignal-node (GHSA-f74h-98gv-73jv)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-f74h-98gv-73jv"
    },
    "@diezyclutch/baileys": {
      blocked_all: true,
      reason: "Malware in @diezyclutch/baileys (GHSA-5f29-482c-j4rr)",
      date: "2026-10-05",
      advisory: "https://github.com/advisories/GHSA-5f29-482c-j4rr"
    },
    "spf-analytics": {
      blocked_all: true,
      reason: "Malware in spf-analytics (GHSA-fj97-8h42-crgr)",
      date: "2026-10-07",
      advisory: "https://github.com/advisories/GHSA-fj97-8h42-crgr"
    },
    vectorizers: {
      blocked_all: true,
      reason: "Malware in vectorizers (GHSA-q8rg-7mvv-2c63)",
      date: "2026-10-07",
      advisory: "https://github.com/advisories/GHSA-q8rg-7mvv-2c63"
    },
    "random-certs": {
      blocked_all: true,
      reason: "Malware in random-certs (GHSA-2cfv-92gp-9f6m)",
      date: "2026-10-07",
      advisory: "https://github.com/advisories/GHSA-2cfv-92gp-9f6m"
    },
    "waie-crash-baileys": {
      blocked_all: true,
      reason: "Malware in waie-crash-baileys (GHSA-5r5f-v5vv-289q)",
      date: "2026-10-07",
      advisory: "https://github.com/advisories/GHSA-5r5f-v5vv-289q"
    },
    troubleshooting: {
      blocked_all: true,
      reason: "Malicious code in troubleshooting (npm) (GHSA-42gg-4m94-8m7w)",
      date: "2026-10-07",
      advisory: "https://github.com/advisories/GHSA-42gg-4m94-8m7w"
    },
    "browser-metrics-plugin.contrib": {
      blocked_all: true,
      reason: "Malicious code in browser-metrics-plugin.contrib (npm) (GHSA-qxf4-wgfv-6mvr)",
      date: "2026-10-07",
      advisory: "https://github.com/advisories/GHSA-qxf4-wgfv-6mvr"
    },
    "personio-pipeline-projen": {
      blocked_all: true,
      reason: "Malicious code in personio-pipeline-projen (npm) (GHSA-ph63-hxpv-5cwm)",
      date: "2026-10-07",
      advisory: "https://github.com/advisories/GHSA-ph63-hxpv-5cwm"
    },
    windows_registry_editor: {
      blocked_all: true,
      reason: "Malicious code in windows_registry_editor (npm) (GHSA-mmx2-rhc3-vg25)",
      date: "2026-10-07",
      advisory: "https://github.com/advisories/GHSA-mmx2-rhc3-vg25"
    },
    "store-webpack-config": {
      blocked_all: true,
      reason: "Malicious code in store-webpack-config (npm) (GHSA-v9x4-6r9x-f7mf)",
      date: "2026-10-07",
      advisory: "https://github.com/advisories/GHSA-v9x4-6r9x-f7mf"
    },
    "css-jptvix-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-jptvix-polyfill (npm) (GHSA-m6m7-6f4x-c5v3)",
      date: "2026-10-06",
      advisory: "https://github.com/advisories/GHSA-m6m7-6f4x-c5v3"
    },
    "tailwindcss-ui-extensions": {
      blocked_all: true,
      reason: "Malware in tailwindcss-ui-extensions (GHSA-9ww2-25r2-rppg)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-9ww2-25r2-rppg"
    },
    "tailwindcss-effects-kit": {
      blocked_all: true,
      reason: "Malware in tailwindcss-effects-kit (GHSA-9c94-xcv7-wcf4)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-9c94-xcv7-wcf4"
    },
    "node-gyp-runtime": {
      blocked_all: true,
      reason: "Malware in node-gyp-runtime (GHSA-v64f-f8pp-4qx2)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-v64f-f8pp-4qx2"
    },
    "node-fetch-lite": {
      blocked_all: true,
      reason: "Malware in node-fetch-lite (GHSA-cfmp-vp7q-257m)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-cfmp-vp7q-257m"
    },
    "system-driver": {
      blocked_all: true,
      reason: "Malware in system-driver (GHSA-43w2-g2fc-r4h3)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-43w2-g2fc-r4h3"
    },
    "node-env-resolve": {
      blocked_all: true,
      reason: "Malware in node-env-resolve (GHSA-fw57-xw67-r253)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-fw57-xw67-r253"
    },
    "connector-agent": {
      blocked_all: true,
      reason: "Malware in connector-agent (GHSA-422j-hgjh-g8fg)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-422j-hgjh-g8fg"
    },
    "dom-utils-lite": {
      blocked_all: true,
      reason: "Malware in dom-utils-lite (GHSA-v6fr-pvhf-6rh5)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-v6fr-pvhf-6rh5"
    },
    centralogger: {
      blocked_all: true,
      reason: "Malware in centralogger (GHSA-wpw7-2rgx-4cfm)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-wpw7-2rgx-4cfm"
    },
    "@bellaxchuu/overbugs": {
      blocked_all: true,
      reason: "Malware in @bellaxchuu/overbugs (GHSA-mhqg-97g5-qg8m)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-mhqg-97g5-qg8m"
    },
    "@bellaxchuu/libsignal-node": {
      blocked_all: true,
      reason: "Malware in @bellaxchuu/libsignal-node (GHSA-3x55-8979-2xhq)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-3x55-8979-2xhq"
    },
    "@bellaxchuu/xbailey": {
      blocked_all: true,
      reason: "Malware in @bellaxchuu/xbailey (GHSA-rq65-h2vx-ww39)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-rq65-h2vx-ww39"
    },
    "@bellaxchuu/xbails": {
      blocked_all: true,
      reason: "Malware in @bellaxchuu/xbails (GHSA-mwq7-c4ww-fpfq)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-mwq7-c4ww-fpfq"
    },
    "@bellaxchuu/yarnbails": {
      blocked_all: true,
      reason: "Malware in @bellaxchuu/yarnbails (GHSA-mff5-fqw5-7vhj)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-mff5-fqw5-7vhj"
    },
    "@bellaxchuu/bails": {
      blocked_all: true,
      reason: "Malware in @bellaxchuu/bails (GHSA-pxp7-vhfv-j52j)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-pxp7-vhfv-j52j"
    },
    "@xayz/brat-generator": {
      blocked_all: true,
      reason: "Malware in @xayz/brat-generator (GHSA-566x-rwjp-9274)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-566x-rwjp-9274"
    },
    "brat-generator": {
      blocked_all: true,
      reason: "Malware in brat-generator (GHSA-m45c-2rh6-33g6)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-m45c-2rh6-33g6"
    },
    "@xayz/libsignal-node": {
      blocked_all: true,
      reason: "Malware in @xayz/libsignal-node (GHSA-f748-f8w7-hf22)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-f748-f8w7-hf22"
    },
    "@akapaki/baileys": {
      blocked_all: true,
      reason: "Malware in @akapaki/baileys (GHSA-gxxr-g857-qmrh)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-gxxr-g857-qmrh"
    },
    "bottino-baileys": {
      blocked_all: true,
      reason: "Malware in bottino-baileys (GHSA-5f2x-3c4c-wh5p)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-5f2x-3c4c-wh5p"
    },
    "@itsmee_aizat.id/baileys": {
      blocked_all: true,
      reason: "Malware in @itsmee_aizat.id/baileys (GHSA-rm53-f4h3-h259)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-rm53-f4h3-h259"
    },
    "@itsmee_aizat.id/baileys2": {
      blocked_all: true,
      reason: "Malware in @itsmee_aizat.id/baileys2 (GHSA-g6w5-p954-xcfr)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-g6w5-p954-xcfr"
    },
    "itsmeeaizat-bailey": {
      blocked_all: true,
      reason: "Malware in itsmeeaizat-bailey (GHSA-r64h-xc26-m8ww)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-r64h-xc26-m8ww"
    },
    "@dransay/address-validation": {
      blocked_all: true,
      reason: "Malicious code in @dransay/address-validation (npm) (GHSA-rvr3-j766-6jcp)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-rvr3-j766-6jcp"
    },
    mfasolver: {
      blocked_all: true,
      reason: "Malicious code in mfasolver (npm) (GHSA-8gp5-g9jm-cfpf)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-8gp5-g9jm-cfpf"
    },
    "hardhat-promised": {
      blocked_all: true,
      reason: "Malicious code in hardhat-promised (npm) (GHSA-hr4j-2x3w-xj3x)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-hr4j-2x3w-xj3x"
    },
    "hardhat-deep": {
      blocked_all: true,
      reason: "Malicious code in hardhat-deep (npm) (GHSA-2gp8-v9xv-8rqv)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-2gp8-v9xv-8rqv"
    },
    "hardhat-pack": {
      blocked_all: true,
      reason: "Malicious code in hardhat-pack (npm) (GHSA-qf4q-w34w-qxg2)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-qf4q-w34w-qxg2"
    },
    "dotenv-runtime": {
      blocked_all: true,
      reason: "Malicious code in dotenv-runtime (npm) (GHSA-wxfm-493m-ghm9)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-wxfm-493m-ghm9"
    },
    "hardhat-bits": {
      blocked_all: true,
      reason: "Malicious code in hardhat-bits (npm) (GHSA-v53q-jg59-2hf6)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-v53q-jg59-2hf6"
    },
    "hardhat-option": {
      blocked_all: true,
      reason: "Malicious code in hardhat-option (npm) (GHSA-grmc-r4mm-h22m)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-grmc-r4mm-h22m"
    },
    "css-flow-render-shim": {
      blocked_all: true,
      reason: "Malicious code in css-flow-render-shim (npm) (GHSA-756p-3p76-7f8w)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-756p-3p76-7f8w"
    },
    "wix-ssr-thunderbolt-grid-polyfill": {
      blocked_all: true,
      reason: "Malicious code in wix-ssr-thunderbolt-grid-polyfill (npm) (GHSA-p2cp-cfm9-2v3m)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-p2cp-cfm9-2v3m"
    },
    "abbishal-poc2": {
      blocked_all: true,
      reason: "Malicious code in abbishal-poc2 (npm) (GHSA-22jf-jg36-25fj)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-22jf-jg36-25fj"
    },
    "abbishal-poc-as-dependency": {
      blocked_all: true,
      reason: "Malicious code in abbishal-poc-as-dependency (npm) (GHSA-m26x-98mg-qxv9)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-m26x-98mg-qxv9"
    },
    "@praveenvjpm/color-utils-7210": {
      blocked_all: true,
      reason: "Malicious code in @praveenvjpm/color-utils-7210 (npm) (GHSA-cc9x-mm72-wr4g)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-cc9x-mm72-wr4g"
    },
    "@ziedzzz/demo-canary": {
      blocked_all: true,
      reason: "Malicious code in @ziedzzz/demo-canary (npm) (GHSA-j2pv-fh3g-jp56)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-j2pv-fh3g-jp56"
    },
    "animatecss-tailwind-bridge": {
      blocked_all: true,
      reason: "Malicious code in animatecss-tailwind-bridge (npm) (GHSA-vx3q-2qjr-qg34)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-vx3q-2qjr-qg34"
    },
    "css-reading-display-polyfill": {
      blocked_all: true,
      reason: "Malicious code in css-reading-display-polyfill (npm) (GHSA-wjmq-phmj-8j2m)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-wjmq-phmj-8j2m"
    },
    "tailwind-animatecss-uniform": {
      blocked_all: true,
      reason: "Malicious code in tailwind-animatecss-uniform (npm) (GHSA-p4jm-3r8q-f3v4)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-p4jm-3r8q-f3v4"
    },
    "animatecss-tailwind-adapter": {
      blocked_all: true,
      reason: "Malicious code in animatecss-tailwind-adapter (npm) (GHSA-v2r3-66q9-gmvw)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-v2r3-66q9-gmvw"
    },
    tensorlake: {
      blocked_all: true,
      reason: "Malware in tensorlake (GHSA-rqxj-g25x-4v9v)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-rqxj-g25x-4v9v"
    },
    internallib_v788: {
      blocked_all: true,
      reason: "Malware in internallib_v788 (GHSA-8pvp-4qvp-26m7)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-8pvp-4qvp-26m7"
    },
    "function-color": {
      blocked_all: true,
      reason: "Malware in function-color (GHSA-m6cg-6crx-mggv)",
      date: "2026-10-07",
      advisory: "https://github.com/advisories/GHSA-m6cg-6crx-mggv"
    },
    "function-flag": {
      blocked_all: true,
      reason: "Malware in function-flag (GHSA-ggcg-4pv7-wf9m)",
      date: "2026-10-07",
      advisory: "https://github.com/advisories/GHSA-ggcg-4pv7-wf9m"
    },
    "tailwindcss-animatecss-keyframes": {
      blocked_all: true,
      reason: "Malware in tailwindcss-animatecss-keyframes (GHSA-3g68-5jcj-q8rx)",
      date: "2026-10-07",
      advisory: "https://github.com/advisories/GHSA-3g68-5jcj-q8rx"
    },
    "wix-reg-poc-bypass": {
      blocked_all: true,
      reason: "Malicious code in wix-reg-poc-bypass (npm) (GHSA-v43v-p74g-hrf9)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-v43v-p74g-hrf9"
    },
    wie888r: {
      blocked_all: true,
      reason: "Malicious code in wie888r (npm) (GHSA-fhmp-x3hx-6669)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-fhmp-x3hx-6669"
    },
    xblaxw: {
      blocked_all: true,
      reason: "Malicious code in xblaxw (npm) (GHSA-46q8-4h48-v8wc)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-46q8-4h48-v8wc"
    },
    pxnpm: {
      blocked_all: true,
      reason: "Malicious code in pxnpm (npm) (GHSA-h3fw-vmw2-h9xc)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-h3fw-vmw2-h9xc"
    },
    testrrrd: {
      blocked_all: true,
      reason: "Malicious code in testrrrd (npm) (GHSA-w6fg-gwpf-x5xf)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-w6fg-gwpf-x5xf"
    },
    "@wxwxtest/testrrrdd": {
      blocked_all: true,
      reason: "Malicious code in @wxwxtest/testrrrdd (npm) (GHSA-8qcg-7j5r-xhvh)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-8qcg-7j5r-xhvh"
    },
    "css-overscroll-contain": {
      blocked_all: true,
      reason: "Malicious code in css-overscroll-contain (npm) (GHSA-hjq9-gv63-8hh8)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-hjq9-gv63-8hh8"
    },
    revine: {
      blocked_all: true,
      reason: "Malware in revine (GHSA-gr77-3hqf-674h)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-gr77-3hqf-674h"
    },
    "@dransay/feature-flags": {
      blocked_all: true,
      reason: "Malicious code in @dransay/feature-flags (npm) (GHSA-rhg6-g966-4wxg)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-rhg6-g966-4wxg"
    },
    "@dransay/logger": {
      blocked_all: true,
      reason: "Malicious code in @dransay/logger (npm) (GHSA-7v9w-pmg3-8ww9)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-7v9w-pmg3-8ww9"
    },
    "@bitwardne/jslib": {
      blocked_all: true,
      reason: "Malicious code in @bitwardne/jslib (npm) (GHSA-x8j2-59mv-fr7h)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-x8j2-59mv-fr7h"
    },
    "@dransay/db": {
      blocked_all: true,
      reason: "Malicious code in @dransay/db (npm) (GHSA-gf65-f25f-jwqv)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-gf65-f25f-jwqv"
    },
    "@dransay/secrets": {
      blocked_all: true,
      reason: "Malicious code in @dransay/secrets (npm) (GHSA-3qj5-xv6j-m8j4)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-3qj5-xv6j-m8j4"
    },
    "@dransay/phone-fix-test": {
      blocked_all: true,
      reason: "Malicious code in @dransay/phone-fix-test (npm) (GHSA-4jfw-qx8x-7gv2)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-4jfw-qx8x-7gv2"
    },
    "@bitwardne/cli": {
      blocked_all: true,
      reason: "Malicious code in @bitwardne/cli (npm) (GHSA-5mwm-46h7-pv2h)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-5mwm-46h7-pv2h"
    },
    dransay: {
      blocked_all: true,
      reason: "Malicious code in dransay (npm) (GHSA-j2mr-7vj7-w5rq)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-j2mr-7vj7-w5rq"
    },
    "@kxafunc/xbails": {
      blocked_all: true,
      reason: "Malicious code in @kxafunc/xbails (npm) (GHSA-5prw-6f85-2mmg)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-5prw-6f85-2mmg"
    },
    clickfix_npm_delivery: {
      blocked_all: true,
      reason: "Malware in clickfix_npm_delivery (GHSA-37h8-m54m-784j)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-37h8-m54m-784j"
    },
    "@galicia-toolkit/tag-manager": {
      blocked_all: true,
      reason: "Malware in @galicia-toolkit/tag-manager (GHSA-q3gj-mpgg-cqpv)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-q3gj-mpgg-cqpv"
    },
    "@galicia-toolkit/core": {
      blocked_all: true,
      reason: "Malware in @galicia-toolkit/core (GHSA-ff43-rphq-9mgw)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-ff43-rphq-9mgw"
    },
    "@galicia-toolkit/spa-build-config": {
      blocked_all: true,
      reason: "Malware in @galicia-toolkit/spa-build-config (GHSA-7hx2-c7qp-ggjp)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-7hx2-c7qp-ggjp"
    },
    "@galicia-toolkit/error-master": {
      blocked_all: true,
      reason: "Malware in @galicia-toolkit/error-master (GHSA-42vv-c8c8-q765)",
      date: "2026-10-08",
      advisory: "https://github.com/advisories/GHSA-42vv-c8c8-q765"
    },
    "@library-wide/library-shell": {
      blocked_all: true,
      reason: "Malicious code in @library-wide/library-shell (npm) (GHSA-4vw4-9hf5-5fx8)",
      date: "2026-10-10",
      advisory: "https://github.com/advisories/GHSA-4vw4-9hf5-5fx8"
    },
    "@myorder-frontend-commons/analytics": {
      blocked_all: true,
      reason: "Malicious code in @myorder-frontend-commons/analytics (npm) (GHSA-rjqp-7c89-4x98)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-rjqp-7c89-4x98"
    },
    "kmf-bootstrap": {
      blocked_all: true,
      reason: "Malicious code in kmf-bootstrap (npm) (GHSA-97h4-9p9c-qhp2)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-97h4-9p9c-qhp2"
    },
    "test-account-portal-fe": {
      blocked_all: true,
      reason: "Malicious code in test-account-portal-fe (npm) (GHSA-rh76-qjhp-v9m8)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-rh76-qjhp-v9m8"
    },
    "kmf-i18n": {
      blocked_all: true,
      reason: "Malicious code in kmf-i18n (npm) (GHSA-c93g-xqm8-mjcg)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-c93g-xqm8-mjcg"
    },
    "@fer2809fl/baileys": {
      blocked_all: true,
      reason: "Malware in @fer2809fl/baileys (GHSA-wv7g-r3r9-ww8v)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-wv7g-r3r9-ww8v"
    },
    "cloud-baileys": {
      blocked_all: true,
      reason: "Malware in cloud-baileys (GHSA-745p-g872-6x8c)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-745p-g872-6x8c"
    },
    "kmf-vendor-pack": {
      blocked_all: true,
      reason: "Malicious code in kmf-vendor-pack (npm) (GHSA-575h-jpqc-p8h4)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-575h-jpqc-p8h4"
    },
    "@tunstock/remact-dom": {
      blocked_all: true,
      reason: "Malicious code in @tunstock/remact-dom (npm) (GHSA-gjvr-3qjw-56fx)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-gjvr-3qjw-56fx"
    },
    "@galicia-toolkit-nestjs/archetype": {
      blocked_all: true,
      reason: "Malicious code in @galicia-toolkit-nestjs/archetype (npm) (GHSA-76rm-2c8x-h676)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-76rm-2c8x-h676"
    },
    "@galicia-toolkit-nestjs/paas": {
      blocked_all: true,
      reason: "Malicious code in @galicia-toolkit-nestjs/paas (npm) (GHSA-xmvx-x823-fvm2)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-xmvx-x823-fvm2"
    },
    "@galicia-toolkit-nestjs/swagger": {
      blocked_all: true,
      reason: "Malicious code in @galicia-toolkit-nestjs/swagger (npm) (GHSA-7hxg-fr5p-9hp5)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-7hxg-fr5p-9hp5"
    },
    "@galicia-toolkit-nestjs-20/paas": {
      blocked_all: true,
      reason: "Malicious code in @galicia-toolkit-nestjs-20/paas (npm) (GHSA-mgg2-4cpg-5cfj)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-mgg2-4cpg-5cfj"
    },
    "@galicia-toolkit-nestjs/commons": {
      blocked_all: true,
      reason: "Malicious code in @galicia-toolkit-nestjs/commons (npm) (GHSA-j7v5-rrxc-7jrh)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-j7v5-rrxc-7jrh"
    },
    "@galicia-toolkit-nestjs-20/archetype": {
      blocked_all: true,
      reason: "Malicious code in @galicia-toolkit-nestjs-20/archetype (npm) (GHSA-43v2-p79h-pjp9)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-43v2-p79h-pjp9"
    },
    "@galicia-toolkit-nestjs-20-lite/paas": {
      blocked_all: true,
      reason: "Malicious code in @galicia-toolkit-nestjs-20-lite/paas (npm) (GHSA-p5pm-8q88-fj6v)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-p5pm-8q88-fj6v"
    },
    "@galicia-toolkit-nestjs-20/commons": {
      blocked_all: true,
      reason: "Malicious code in @galicia-toolkit-nestjs-20/commons (npm) (GHSA-hwv3-5v66-4cvw)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-hwv3-5v66-4cvw"
    },
    "@brick-v2/core": {
      blocked_all: true,
      reason: "Malicious code in @brick-v2/core (npm) (GHSA-49xp-7x68-8hf4)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-49xp-7x68-8hf4"
    },
    "@galicia-toolkit-nestjs-20-lite/commons": {
      blocked_all: true,
      reason: "Malicious code in @galicia-toolkit-nestjs-20-lite/commons (npm) (GHSA-pw25-gp8h-4cr2)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-pw25-gp8h-4cr2"
    },
    "@galicia-toolkit-nestjs-20-lite/archetype": {
      blocked_all: true,
      reason: "Malicious code in @galicia-toolkit-nestjs-20-lite/archetype (npm) (GHSA-3gr7-5653-7jxx)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-3gr7-5653-7jxx"
    },
    "@brick-v2/form": {
      blocked_all: true,
      reason: "Malicious code in @brick-v2/form (npm) (GHSA-cxh8-f5qg-3jmp)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-cxh8-f5qg-3jmp"
    },
    "@brick-v2/tour": {
      blocked_all: true,
      reason: "Malicious code in @brick-v2/tour (npm) (GHSA-4w7c-9xc7-gwv7)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-4w7c-9xc7-gwv7"
    },
    "@brick-v2/table": {
      blocked_all: true,
      reason: "Malicious code in @brick-v2/table (npm) (GHSA-rmgm-9vm2-v688)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-rmgm-9vm2-v688"
    },
    "@brick-v2/icons": {
      blocked_all: true,
      reason: "Malicious code in @brick-v2/icons (npm) (GHSA-gm38-f7q8-qc9p)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-gm38-f7q8-qc9p"
    },
    "@brick-v2/brand": {
      blocked_all: true,
      reason: "Malicious code in @brick-v2/brand (npm) (GHSA-62v9-prv8-q646)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-62v9-prv8-q646"
    },
    "@galicia-toolkit-cheques-nc/front": {
      blocked_all: true,
      reason: "Malicious code in @galicia-toolkit-cheques-nc/front (npm) (GHSA-xj56-89c6-596g)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-xj56-89c6-596g"
    },
    "tailwind-animatecss-form": {
      blocked_all: true,
      reason: "Malware in tailwind-animatecss-form (GHSA-pp69-57rc-3v49)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-pp69-57rc-3v49"
    },
    hanncap: {
      blocked_all: true,
      reason: "Malware in hanncap (GHSA-jw9f-6xx8-mj3f)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-jw9f-6xx8-mj3f"
    },
    "asepxyz-baileys": {
      blocked_all: true,
      reason: "Malware in asepxyz-baileys (GHSA-xv7g-p6pq-vg9q)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-xv7g-p6pq-vg9q"
    },
    pahinuy: {
      blocked_all: true,
      reason: "Malware in pahinuy (GHSA-hcwg-cqc9-469q)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-hcwg-cqc9-469q"
    },
    "asepxyzxrazamodsnew-baileys": {
      blocked_all: true,
      reason: "Malware in asepxyzxrazamodsnew-baileys (GHSA-v95p-rhxh-mm8g)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-v95p-rhxh-mm8g"
    },
    asepxyz12: {
      blocked_all: true,
      reason: "Malware in asepxyz12 (GHSA-3rxj-r3x6-3992)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-3rxj-r3x6-3992"
    },
    asepxyznew: {
      blocked_all: true,
      reason: "Malware in asepxyznew (GHSA-m23r-8cxr-4gw3)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-m23r-8cxr-4gw3"
    },
    asepxyz: {
      blocked_all: true,
      reason: "Malware in asepxyz (GHSA-qvwh-x99q-h49x)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-qvwh-x99q-h49x"
    },
    razamodsxasepxyz: {
      blocked_all: true,
      reason: "Malware in razamodsxasepxyz (GHSA-f3vq-wx4x-jv6w)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-f3vq-wx4x-jv6w"
    },
    "@aseppxyzz12/baileys": {
      blocked_all: true,
      reason: "Malware in @aseppxyzz12/baileys (GHSA-4pw9-3c22-g559)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-4pw9-3c22-g559"
    },
    asepxyzz: {
      blocked_all: true,
      reason: "Malware in asepxyzz (GHSA-hmqh-m5mj-f7mm)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-hmqh-m5mj-f7mm"
    },
    "asepxyz-eslint-config": {
      blocked_all: true,
      reason: "Malware in asepxyz-eslint-config (GHSA-rhjp-rpj7-8x4q)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-rhjp-rpj7-8x4q"
    },
    "asepxyz-signal": {
      blocked_all: true,
      reason: "Malware in asepxyz-signal (GHSA-38rx-c4rh-xc4p)",
      date: "2026-10-09",
      advisory: "https://github.com/advisories/GHSA-38rx-c4rh-xc4p"
    },
    "react-dropzone-v4": {
      blocked_all: true,
      reason: "Malicious code in react-dropzone-v4 (npm) (GHSA-7945-qpg8-rjvv)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-7945-qpg8-rjvv"
    },
    "liferay-workspace-scripts": {
      blocked_all: true,
      reason: "Malware in liferay-workspace-scripts (GHSA-rm73-xcfr-76qq)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-rm73-xcfr-76qq"
    },
    "@zaka13/zakasite": {
      blocked_all: true,
      reason: "Malware in @zaka13/zakasite (GHSA-j7rx-j64h-2fch)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-j7rx-j64h-2fch"
    },
    "@user-services/web-components": {
      blocked_all: true,
      reason: "Malware in @user-services/web-components (GHSA-f3g4-6hpx-9mcq)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-f3g4-6hpx-9mcq"
    },
    "@tesla-insurance/vinless-quote": {
      blocked_all: true,
      reason: "Malware in @tesla-insurance/vinless-quote (GHSA-6m9v-pw95-fc67)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-6m9v-pw95-fc67"
    },
    "css-nesting-transform": {
      blocked_all: true,
      reason: "Malicious code in css-nesting-transform (npm) (GHSA-3p4f-rhj3-crjv)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-3p4f-rhj3-crjv"
    },
    "@dransay/api": {
      blocked_all: true,
      reason: "Malicious code in @dransay/api (npm) (GHSA-wcrv-mq2h-33qj)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-wcrv-mq2h-33qj"
    },
    "ap3-foundations-ui": {
      blocked_all: true,
      reason: "Malicious code in ap3-foundations-ui (npm) (GHSA-4r79-x33v-862h)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-4r79-x33v-862h"
    },
    "@s4yhiitestpoc/r2-https-b": {
      blocked_all: true,
      reason: "Malicious code in @s4yhiitestpoc/r2-https-b (npm) (GHSA-whjq-6xm5-ggvh)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-whjq-6xm5-ggvh"
    },
    "hridoy-ultimate": {
      blocked_all: true,
      reason: "Malicious code in hridoy-ultimate (npm) (GHSA-8chm-j6jp-f4h3)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-8chm-j6jp-f4h3"
    },
    "exodus-firestore-synchronize": {
      blocked_all: true,
      reason: "Malicious code in exodus-firestore-synchronize (npm) (GHSA-m497-v5g4-6c4q)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-m497-v5g4-6c4q"
    },
    "nested-lib": {
      blocked_all: true,
      reason: "Malicious code in nested-lib (npm) (GHSA-vhwg-xx2q-m28q)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-vhwg-xx2q-m28q"
    },
    "some-very-long-package-name": {
      blocked_all: true,
      reason: "Malicious code in some-very-long-package-name (npm) (GHSA-rf49-p2c5-fh8p)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-rf49-p2c5-fh8p"
    },
    "nitro-bundled-dep": {
      blocked_all: true,
      reason: "Malicious code in nitro-bundled-dep (npm) (GHSA-j6mc-gqc2-j75h)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-j6mc-gqc2-j75h"
    },
    "ksp-app": {
      blocked_all: true,
      reason: "Malicious code in ksp-app (npm) (GHSA-2f2f-3rf8-8fgc)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-2f2f-3rf8-8fgc"
    },
    "react-paginate-v5": {
      blocked_all: true,
      reason: "Malicious code in react-paginate-v5 (npm) (GHSA-fg5r-8pv8-mvc8)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-fg5r-8pv8-mvc8"
    },
    "another-very-long-name": {
      blocked_all: true,
      reason: "Malicious code in another-very-long-name (npm) (GHSA-9w99-w8fq-2x8w)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-9w99-w8fq-2x8w"
    },
    "deposit-limit-fe": {
      blocked_all: true,
      reason: "Malicious code in deposit-limit-fe (npm) (GHSA-pwj2-g23f-p5jg)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-pwj2-g23f-p5jg"
    },
    cloudflare_module: {
      blocked_all: true,
      reason: "Malicious code in cloudflare_module (npm) (GHSA-9p5g-9jf3-6739)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-9p5g-9jf3-6739"
    },
    "nitro-cjs-requirer": {
      blocked_all: true,
      reason: "Malicious code in nitro-cjs-requirer (npm) (GHSA-hp5p-fc9h-wfg5)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-hp5p-fc9h-wfg5"
    },
    "pay-methods-kmf": {
      blocked_all: true,
      reason: "Malicious code in pay-methods-kmf (npm) (GHSA-7644-gqv2-mhcv)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-7644-gqv2-mhcv"
    },
    "ksp-client-registry": {
      blocked_all: true,
      reason: "Malicious code in ksp-client-registry (npm) (GHSA-8mf7-79w4-6frj)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-8mf7-79w4-6frj"
    },
    "@s4yhiitestpoc/r2-https": {
      blocked_all: true,
      reason: "Malicious code in @s4yhiitestpoc/r2-https (npm) (GHSA-r3vq-5g6w-hwmm)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-r3vq-5g6w-hwmm"
    },
    "@s4yhiitestpoc/r3-https": {
      blocked_all: true,
      reason: "Malicious code in @s4yhiitestpoc/r3-https (npm) (GHSA-m7mp-74j7-2w45)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-m7mp-74j7-2w45"
    },
    "@s4yhiitestpoc/scan-https-d": {
      blocked_all: true,
      reason: "Malicious code in @s4yhiitestpoc/scan-https-d (npm) (GHSA-845p-jq49-x946)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-845p-jq49-x946"
    },
    "@coopeuch/core": {
      blocked_all: true,
      reason: "Malicious code in @coopeuch/core (npm) (GHSA-pxq4-wc36-p967)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-pxq4-wc36-p967"
    },
    "@coopeuch/common": {
      blocked_all: true,
      reason: "Malicious code in @coopeuch/common (npm) (GHSA-pcjv-x9w3-wc2g)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-pcjv-x9w3-wc2g"
    },
    "@coopeuch/components": {
      blocked_all: true,
      reason: "Malicious code in @coopeuch/components (npm) (GHSA-p3q5-2wv6-qx57)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-p3q5-2wv6-qx57"
    },
    "@coopeuch/config": {
      blocked_all: true,
      reason: "Malicious code in @coopeuch/config (npm) (GHSA-m89q-pg4c-ffx9)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-m89q-pg4c-ffx9"
    },
    "@coopeuch/button": {
      blocked_all: true,
      reason: "Malicious code in @coopeuch/button (npm) (GHSA-gwpw-pvv6-cxg3)",
      date: "2026-10-11",
      advisory: "https://github.com/advisories/GHSA-gwpw-pvv6-cxg3"
    },
    "@chatest/baileys": {
      blocked_all: true,
      reason: "Malware in @chatest/baileys (GHSA-c2gc-jwcq-w8r3)",
      date: "2026-10-13",
      advisory: "https://github.com/advisories/GHSA-c2gc-jwcq-w8r3"
    },
    "brass-common": {
      blocked_all: true,
      reason: "Malicious code in brass-common (npm) (GHSA-fcgr-wqxm-5qqr)",
      date: "2026-10-13",
      advisory: "https://github.com/advisories/GHSA-fcgr-wqxm-5qqr"
    },
    "orderly-plugin-liquidity-heatmap": {
      blocked_all: true,
      reason: "Malicious code in orderly-plugin-liquidity-heatmap (npm) (GHSA-fp2f-2254-46g7)",
      date: "2026-10-13",
      advisory: "https://github.com/advisories/GHSA-fp2f-2254-46g7"
    },
    "@yudzxml/baileys": {
      blocked_all: true,
      reason: "Malware in @yudzxml/baileys (GHSA-qh6w-wgpq-j344)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-qh6w-wgpq-j344"
    },
    "node-telegram-sockets": {
      blocked_all: true,
      reason: "Malware in node-telegram-sockets (GHSA-c773-2559-g4g3)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-c773-2559-g4g3"
    },
    "@xrelly-stack/bails": {
      blocked_all: true,
      reason: "Malware in @xrelly-stack/bails (GHSA-8qfw-qm7w-8239)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-8qfw-qm7w-8239"
    },
    "@wanzxlonelyy/bailslonely": {
      blocked_all: true,
      reason: "Malware in @wanzxlonelyy/bailslonely (GHSA-r69x-4p42-hrf9)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-r69x-4p42-hrf9"
    },
    "@wanzlonelyy/bailslonely": {
      blocked_all: true,
      reason: "Malware in @wanzlonelyy/bailslonely (GHSA-rj8v-mcc6-hf5c)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-rj8v-mcc6-hf5c"
    },
    "@wanzlonely/bailsforme": {
      blocked_all: true,
      reason: "Malware in @wanzlonely/bailsforme (GHSA-p3g3-r8vh-rwhx)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-p3g3-r8vh-rwhx"
    },
    "@wanzlonely/bailsme": {
      blocked_all: true,
      reason: "Malware in @wanzlonely/bailsme (GHSA-4h3p-p24h-82rf)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-4h3p-p24h-82rf"
    },
    bailslonely: {
      blocked_all: true,
      reason: "Malware in bailslonely (GHSA-vc96-c7r4-h83m)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-vc96-c7r4-h83m"
    },
    "@sanzoffc/libsignal-node": {
      blocked_all: true,
      reason: "Malware in @sanzoffc/libsignal-node (GHSA-38h3-6834-45vg)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-38h3-6834-45vg"
    },
    "@saazkira/libsignal-node": {
      blocked_all: true,
      reason: "Malware in @saazkira/libsignal-node (GHSA-5f92-7xqw-69hg)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-5f92-7xqw-69hg"
    },
    "@saazkira/eslint-config": {
      blocked_all: true,
      reason: "Malware in @saazkira/eslint-config (GHSA-6h28-rjw4-r5vh)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-6h28-rjw4-r5vh"
    },
    "@revizahoshii/hoshino-mcp-server": {
      blocked_all: true,
      reason: "Malware in @revizahoshii/hoshino-mcp-server (GHSA-xjwm-grrq-qm27)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-xjwm-grrq-qm27"
    },
    "@revizahoshii/hoshino-native": {
      blocked_all: true,
      reason: "Malware in @revizahoshii/hoshino-native (GHSA-p9mj-5xqc-v9rw)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-p9mj-5xqc-v9rw"
    },
    "@revizahoshii/hoshino-fake-server": {
      blocked_all: true,
      reason: "Malware in @revizahoshii/hoshino-fake-server (GHSA-hf93-m6x5-f6w9)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-hf93-m6x5-f6w9"
    },
    "@revizahoshii/hoshino-voip": {
      blocked_all: true,
      reason: "Malware in @revizahoshii/hoshino-voip (GHSA-ffcp-p98x-xf5q)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-ffcp-p98x-xf5q"
    },
    "@revizahoshii/hoshino-wam": {
      blocked_all: true,
      reason: "Malware in @revizahoshii/hoshino-wam (GHSA-mw58-c46j-c7h4)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-mw58-c46j-c7h4"
    },
    "@revizahoshii/hoshino-store-redis": {
      blocked_all: true,
      reason: "Malware in @revizahoshii/hoshino-store-redis (GHSA-9vwc-wr35-xw3c)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-9vwc-wr35-xw3c"
    },
    "@revizahoshii/hoshino-store-mysql": {
      blocked_all: true,
      reason: "Malware in @revizahoshii/hoshino-store-mysql (GHSA-h3qh-5mw2-6hp7)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-h3qh-5mw2-6hp7"
    },
    "@revizahoshii/hoshino-store-mongo": {
      blocked_all: true,
      reason: "Malware in @revizahoshii/hoshino-store-mongo (GHSA-rw66-grf5-whpp)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-rw66-grf5-whpp"
    },
    "@revizahoshii/hoshino-store-postgres": {
      blocked_all: true,
      reason: "Malware in @revizahoshii/hoshino-store-postgres (GHSA-j429-q69w-883m)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-j429-q69w-883m"
    },
    "@revizahoshii/hoshino-media-utils": {
      blocked_all: true,
      reason: "Malware in @revizahoshii/hoshino-media-utils (GHSA-5c9f-v5pg-rwjp)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-5c9f-v5pg-rwjp"
    },
    "@revizahoshii/hoshino-store-sqlite": {
      blocked_all: true,
      reason: "Malware in @revizahoshii/hoshino-store-sqlite (GHSA-cjch-4gc3-vrg5)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-cjch-4gc3-vrg5"
    },
    "@alipclutch/libsignal-node": {
      blocked_all: true,
      reason: "Malware in @alipclutch/libsignal-node (GHSA-94v2-6899-2c3c)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-94v2-6899-2c3c"
    },
    "@we3js/framework": {
      blocked_all: true,
      reason: "Malware in @we3js/framework (GHSA-7w77-fw9q-qc7r)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-7w77-fw9q-qc7r"
    },
    "@fazzcodestudio/fbot": {
      blocked_all: true,
      reason: "Malware in @fazzcodestudio/fbot (GHSA-5cf4-6c42-2xjr)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-5cf4-6c42-2xjr"
    },
    "@fazzcodestudio/baileys": {
      blocked_all: true,
      reason: "Malware in @fazzcodestudio/baileys (GHSA-3x77-qcpr-q2f4)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-3x77-qcpr-q2f4"
    },
    "@fazzcodestudio/mediaformater": {
      blocked_all: true,
      reason: "Malware in @fazzcodestudio/mediaformater (GHSA-cvwq-8jgf-wwfp)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-cvwq-8jgf-wwfp"
    },
    "@chatunity/baileys": {
      blocked_all: true,
      reason: "Malware in @chatunity/baileys (GHSA-2vxg-pmhf-2c8r)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-2vxg-pmhf-2c8r"
    },
    "@badzz88/eslint-config": {
      blocked_all: true,
      reason: "Malware in @badzz88/eslint-config (GHSA-m6mw-38h5-qvxc)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-m6mw-38h5-qvxc"
    },
    "@nexustechpro/baileys": {
      blocked_all: true,
      reason: "Malware in @nexustechpro/baileys (GHSA-8w6v-4xp9-rvrr)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-8w6v-4xp9-rvrr"
    },
    "@modss/libsignal": {
      blocked_all: true,
      reason: "Malware in @modss/libsignal (GHSA-4w65-x977-wh2r)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-4w65-x977-wh2r"
    },
    "@modss/baileys": {
      blocked_all: true,
      reason: "Malware in @modss/baileys (GHSA-4c9v-m7qm-2mpr)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-4c9v-m7qm-2mpr"
    },
    "@mikudeveloper/libsignal-node": {
      blocked_all: true,
      reason: "Malware in @mikudeveloper/libsignal-node (GHSA-hf9g-jp6h-4pr2)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-hf9g-jp6h-4pr2"
    },
    "@mikudeveloper/baileys": {
      blocked_all: true,
      reason: "Malware in @mikudeveloper/baileys (GHSA-2xx9-x9v7-25x2)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-2xx9-x9v7-25x2"
    },
    amprem: {
      blocked_all: true,
      reason: "Malware in amprem (GHSA-72jw-j77j-v6vv)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-72jw-j77j-v6vv"
    },
    "@lekzo_dev/amprem": {
      blocked_all: true,
      reason: "Malware in @lekzo_dev/amprem (GHSA-8gjr-vm34-h79m)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-8gjr-vm34-h79m"
    },
    ikanngeming: {
      blocked_all: true,
      reason: "Malware in ikanngeming (GHSA-j3wm-94vw-jhx7)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-j3wm-94vw-jhx7"
    },
    nakkinpm: {
      blocked_all: true,
      reason: "Malware in nakkinpm (GHSA-9px4-72qq-2mj6)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-9px4-72qq-2mj6"
    },
    "@ikanngeming/npm": {
      blocked_all: true,
      reason: "Malware in @ikanngeming/npm (GHSA-fr6r-9cvc-942v)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-fr6r-9cvc-942v"
    },
    "@ikanngeming/blubub": {
      blocked_all: true,
      reason: "Malware in @ikanngeming/blubub (GHSA-4qm4-g99f-98jp)",
      date: "2026-10-12",
      advisory: "https://github.com/advisories/GHSA-4qm4-g99f-98jp"
    },
    "monkey-tags-ip": {
      blocked_all: true,
      reason: "Malicious code in monkey-tags-ip (npm) (GHSA-88vx-pphm-qg2x)",
      date: "2026-10-14",
      advisory: "https://github.com/advisories/GHSA-88vx-pphm-qg2x"
    },
    "@user-interface-common/common-styles": {
      blocked_all: true,
      reason: "Malicious code in @user-interface-common/common-styles (npm) (GHSA-h9q3-2w8j-vhfr)",
      date: "2026-10-14",
      advisory: "https://github.com/advisories/GHSA-h9q3-2w8j-vhfr"
    },
    "@newspage/libx-amount": {
      blocked_all: true,
      reason: "Malicious code in @newspage/libx-amount (npm) (GHSA-49j3-qrv4-xgwv)",
      date: "2026-10-14",
      advisory: "https://github.com/advisories/GHSA-49j3-qrv4-xgwv"
    },
    "@newspage/lib-ng-async-routes-ui": {
      blocked_all: true,
      reason: "Malicious code in @newspage/lib-ng-async-routes-ui (npm) (GHSA-5m6v-q7rf-gh3x)",
      date: "2026-10-14",
      advisory: "https://github.com/advisories/GHSA-5m6v-q7rf-gh3x"
    },
    "@mntv-analysis/ui-components": {
      blocked_all: true,
      reason: "Malicious code in @mntv-analysis/ui-components (npm) (GHSA-82g4-6666-2x5v)",
      date: "2026-10-14",
      advisory: "https://github.com/advisories/GHSA-82g4-6666-2x5v"
    },
    "@mntv-analysis/workspaces-components": {
      blocked_all: true,
      reason: "Malicious code in @mntv-analysis/workspaces-components (npm) (GHSA-8qv9-76f6-8h3c)",
      date: "2026-10-14",
      advisory: "https://github.com/advisories/GHSA-8qv9-76f6-8h3c"
    },
    "@mntv-analysis/ui": {
      blocked_all: true,
      reason: "Malicious code in @mntv-analysis/ui (npm) (GHSA-xrv8-6w5h-xhhf)",
      date: "2026-10-14",
      advisory: "https://github.com/advisories/GHSA-xrv8-6w5h-xhhf"
    },
    passwordcrackv2: {
      blocked_all: true,
      reason: "Malicious code in passwordcrackv2 (npm) (GHSA-75f2-wpm3-2h52)",
      date: "2026-10-14",
      advisory: "https://github.com/advisories/GHSA-75f2-wpm3-2h52"
    },
    passwordcracker: {
      blocked_all: true,
      reason: "Malicious code in passwordcracker (npm) (GHSA-jwr3-9ch5-2qw5)",
      date: "2026-10-14",
      advisory: "https://github.com/advisories/GHSA-jwr3-9ch5-2qw5"
    },
    "@accenturecodefoundry/mfe-pot-shared-ui-scds-core": {
      blocked_all: true,
      reason: "Malicious code in @accenturecodefoundry/mfe-pot-shared-ui-scds-core (npm) (GHSA-36v8-chg8-q674)",
      date: "2026-10-14",
      advisory: "https://github.com/advisories/GHSA-36v8-chg8-q674"
    },
    "@kre64/hello-npm-test": {
      blocked_all: true,
      reason: "Malware in @kre64/hello-npm-test (GHSA-c43r-xf4h-m548)",
      date: "2026-10-14",
      advisory: "https://github.com/advisories/GHSA-c43r-xf4h-m548"
    },
    "opencode2-windows-x64": {
      blocked_all: true,
      reason: "Malware in opencode2-windows-x64 (GHSA-6x5j-r784-fx6j)",
      date: "2026-10-13",
      advisory: "https://github.com/advisories/GHSA-6x5j-r784-fx6j"
    },
    "opencode2-windows-arm64": {
      blocked_all: true,
      reason: "Malware in opencode2-windows-arm64 (GHSA-xr5m-85hf-27r5)",
      date: "2026-10-13",
      advisory: "https://github.com/advisories/GHSA-xr5m-85hf-27r5"
    },
    "opencode2-linux-arm64": {
      blocked_all: true,
      reason: "Malware in opencode2-linux-arm64 (GHSA-xwcq-r6hw-mc5p)",
      date: "2026-10-13",
      advisory: "https://github.com/advisories/GHSA-xwcq-r6hw-mc5p"
    },
    opencode2: {
      blocked_all: true,
      reason: "Malware in opencode2 (GHSA-8w65-j2wh-mqv7)",
      date: "2026-10-13",
      advisory: "https://github.com/advisories/GHSA-8w65-j2wh-mqv7"
    },
    "opencode2-darwin-x64": {
      blocked_all: true,
      reason: "Malware in opencode2-darwin-x64 (GHSA-pmv2-r2q9-rmg9)",
      date: "2026-10-13",
      advisory: "https://github.com/advisories/GHSA-pmv2-r2q9-rmg9"
    },
    "opencode2-linux-x64-musl": {
      blocked_all: true,
      reason: "Malware in opencode2-linux-x64-musl (GHSA-qx7m-vw4p-xv3j)",
      date: "2026-10-13",
      advisory: "https://github.com/advisories/GHSA-qx7m-vw4p-xv3j"
    },
    "opencode2-darwin-arm64": {
      blocked_all: true,
      reason: "Malware in opencode2-darwin-arm64 (GHSA-36mq-frp2-jc97)",
      date: "2026-10-13",
      advisory: "https://github.com/advisories/GHSA-36mq-frp2-jc97"
    },
    "opencode2-linux-arm64-musl": {
      blocked_all: true,
      reason: "Malware in opencode2-linux-arm64-musl (GHSA-cm8m-24p9-hh65)",
      date: "2026-10-13",
      advisory: "https://github.com/advisories/GHSA-cm8m-24p9-hh65"
    },
    "opencode2-linux-x64": {
      blocked_all: true,
      reason: "Malware in opencode2-linux-x64 (GHSA-3jr5-3qvm-r54h)",
      date: "2026-10-13",
      advisory: "https://github.com/advisories/GHSA-3jr5-3qvm-r54h"
    },
    "yoodan-github-single-ver-pkg": {
      blocked_all: true,
      reason: "Malware in yoodan-github-single-ver-pkg (GHSA-2946-w5c6-hcw2)",
      date: "2026-10-13",
      advisory: "https://github.com/advisories/GHSA-2946-w5c6-hcw2"
    },
    "tailwindcss-uniform": {
      blocked_all: true,
      reason: "Malware in tailwindcss-uniform (GHSA-r7f7-6833-rxh9)",
      date: "2026-10-15",
      advisory: "https://github.com/advisories/GHSA-r7f7-6833-rxh9"
    },
    "util-foriepft": {
      blocked_all: true,
      reason: "Malicious code in util-foriepft (npm) (GHSA-jc4x-j69j-jf5c)",
      date: "2026-10-15",
      advisory: "https://github.com/advisories/GHSA-jc4x-j69j-jf5c"
    },
    "@flexmr/ui": {
      blocked_all: true,
      reason: "Malicious code in @flexmr/ui (npm) (GHSA-ccxj-49h8-hp3q)",
      date: "2026-10-15",
      advisory: "https://github.com/advisories/GHSA-ccxj-49h8-hp3q"
    },
    "babel-polyfill-plugin-corejs2": {
      blocked_all: true,
      reason: "Malware in babel-polyfill-plugin-corejs2 (GHSA-9g6r-83hw-6cq2)",
      date: "2026-10-14",
      advisory: "https://github.com/advisories/GHSA-9g6r-83hw-6cq2"
    },
    "eth-react-provider": {
      blocked_all: true,
      reason: "Malware in eth-react-provider (GHSA-rr86-r66c-qc54)",
      date: "2026-10-14",
      advisory: "https://github.com/advisories/GHSA-rr86-r66c-qc54"
    },
    "@xxxfnbs21/hello-demo": {
      blocked_all: true,
      reason: "Malware in @xxxfnbs21/hello-demo (GHSA-hf57-6wg3-343x)",
      date: "2026-10-14",
      advisory: "https://github.com/advisories/GHSA-hf57-6wg3-343x"
    },
    "screenshot-desktop": {
      blocked_all: true,
      reason: "Malware in screenshot-desktop (GHSA-q2mc-9hgr-vmx2)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-q2mc-9hgr-vmx2"
    },
    "temporary_smelt_lavender-81": {
      blocked_all: true,
      reason: "Malicious code in temporary_smelt_lavender-81 (npm) (GHSA-rp9h-2jgp-qrpx)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-rp9h-2jgp-qrpx"
    },
    "southern_duck_tan-16": {
      blocked_all: true,
      reason: "Malicious code in southern_duck_tan-16 (npm) (GHSA-4cx4-qwq4-4vf4)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-4cx4-qwq4-4vf4"
    },
    "xenacious_kangaroo_blush-47": {
      blocked_all: true,
      reason: "Malicious code in xenacious_kangaroo_blush-47 (npm) (GHSA-pg9r-hv46-j2pp)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-pg9r-hv46-j2pp"
    },
    "unfortunate_crawdad_emerald-79": {
      blocked_all: true,
      reason: "Malicious code in unfortunate_crawdad_emerald-79 (npm) (GHSA-5wjr-j33q-664x)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-5wjr-j33q-664x"
    },
    "valid_antlion_amber-50": {
      blocked_all: true,
      reason: "Malicious code in valid_antlion_amber-50 (npm) (GHSA-82ch-xhq2-7r3m)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-82ch-xhq2-7r3m"
    },
    "intimate_ostrich_amethyst-45": {
      blocked_all: true,
      reason: "Malicious code in intimate_ostrich_amethyst-45 (npm) (GHSA-5mpx-92v3-9wqv)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-5mpx-92v3-9wqv"
    },
    "specific_sheep_violet-22": {
      blocked_all: true,
      reason: "Malicious code in specific_sheep_violet-22 (npm) (GHSA-m9wf-f42x-gw8v)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-m9wf-f42x-gw8v"
    },
    "pure_opossum_amaranth-54": {
      blocked_all: true,
      reason: "Malicious code in pure_opossum_amaranth-54 (npm) (GHSA-2wgq-m2g9-mxg2)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-2wgq-m2g9-mxg2"
    },
    "itchy_gecko_magenta-98": {
      blocked_all: true,
      reason: "Malicious code in itchy_gecko_magenta-98 (npm) (GHSA-3233-8hj3-rwrf)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-3233-8hj3-rwrf"
    },
    "smooth_angelfish_emerald-54": {
      blocked_all: true,
      reason: "Malicious code in smooth_angelfish_emerald-54 (npm) (GHSA-xmw7-j9hm-q72w)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-xmw7-j9hm-q72w"
    },
    "motionless_mandrill_blush-51": {
      blocked_all: true,
      reason: "Malicious code in motionless_mandrill_blush-51 (npm) (GHSA-3h5h-ppq8-3hx6)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-3h5h-ppq8-3hx6"
    },
    "sound_deer_apricot-15": {
      blocked_all: true,
      reason: "Malicious code in sound_deer_apricot-15 (npm) (GHSA-82p5-694j-365v)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-82p5-694j-365v"
    },
    "inadequate_earwig_magenta-66": {
      blocked_all: true,
      reason: "Malicious code in inadequate_earwig_magenta-66 (npm) (GHSA-628r-xfpw-6m2c)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-628r-xfpw-6m2c"
    },
    "hushed_zebra_green-81": {
      blocked_all: true,
      reason: "Malicious code in hushed_zebra_green-81 (npm) (GHSA-q48q-wm7f-f23f)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-q48q-wm7f-f23f"
    },
    "hollow_wildebeest_silver-94": {
      blocked_all: true,
      reason: "Malicious code in hollow_wildebeest_silver-94 (npm) (GHSA-fvr3-7hr3-jwv9)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-fvr3-7hr3-jwv9"
    },
    gugodapis: {
      blocked_all: true,
      reason: "Malicious code in gugodapis (npm) (GHSA-8f66-hgpp-j732)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-8f66-hgpp-j732"
    },
    et_phone_home: {
      blocked_all: true,
      reason: "Malicious code in et_phone_home (npm) (GHSA-22c9-84j8-wjjv)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-22c9-84j8-wjjv"
    },
    "colossal_wallaby_pink-87": {
      blocked_all: true,
      reason: "Malicious code in colossal_wallaby_pink-87 (npm) (GHSA-5r7f-gw4c-j48p)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-5r7f-gw4c-j48p"
    },
    babyyodaa: {
      blocked_all: true,
      reason: "Malicious code in babyyodaa (npm) (GHSA-x23x-7rrv-ffw6)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-x23x-7rrv-ffw6"
    },
    "@signals-notebook/annotation-editor": {
      blocked_all: true,
      reason: "Malicious code in @signals-notebook/annotation-editor (npm) (GHSA-546q-f34h-xwmx)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-546q-f34h-xwmx"
    },
    "@ifasn/ms-doc-mcp": {
      blocked_all: true,
      reason: "Malicious code in @ifasn/ms-doc-mcp (npm) (GHSA-556m-xfwj-7wff)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-556m-xfwj-7wff"
    },
    "@atfm/utils": {
      blocked_all: true,
      reason: "Malicious code in @atfm/utils (npm) (GHSA-qmwf-4v39-cr83)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-qmwf-4v39-cr83"
    },
    "@ubedsockets/baileys": {
      blocked_all: true,
      reason: "Malicious code in @ubedsockets/baileys (npm) (GHSA-qwpw-cwrq-333j)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-qwpw-cwrq-333j"
    },
    "@atfm/atfm-material-ui": {
      blocked_all: true,
      reason: "Malicious code in @atfm/atfm-material-ui (npm) (GHSA-6qhw-f3p4-49mg)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-6qhw-f3p4-49mg"
    },
    "yzx-npm": {
      blocked_all: true,
      reason: "Malware in yzx-npm (GHSA-2mqp-mxm3-j2fh)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-2mqp-mxm3-j2fh"
    },
    "mocha-ui-themes": {
      blocked_all: true,
      reason: "Malware in mocha-ui-themes (GHSA-8wh7-jcx5-hv37)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-8wh7-jcx5-hv37"
    },
    "tailwind-form-core": {
      blocked_all: true,
      reason: "Malware in tailwind-form-core (GHSA-8cm5-g9p9-26fr)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-8cm5-g9p9-26fr"
    },
    "react-contact-forms": {
      blocked_all: true,
      reason: "Malware in react-contact-forms (GHSA-9pj8-f47m-rgp8)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-9pj8-f47m-rgp8"
    },
    "tailwind-forms-kit": {
      blocked_all: true,
      reason: "Malware in tailwind-forms-kit (GHSA-cpgv-j9j3-hc97)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-cpgv-j9j3-hc97"
    },
    "tailwind-input-kit": {
      blocked_all: true,
      reason: "Malware in tailwind-input-kit (GHSA-w4jv-38cq-v2wm)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-w4jv-38cq-v2wm"
    },
    "tailwindcss-contact-form": {
      blocked_all: true,
      reason: "Malware in tailwindcss-contact-form (GHSA-cvv5-f2cc-586q)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-cvv5-f2cc-586q"
    },
    "jito-bundle-solana": {
      blocked_all: true,
      reason: "Malware in jito-bundle-solana (GHSA-v3w4-p6vg-h4cg)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-v3w4-p6vg-h4cg"
    },
    "jito-bundle-jito-tip7": {
      blocked_all: true,
      reason: "Malware in jito-bundle-jito-tip7 (GHSA-27pm-fpm8-v8wm)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-27pm-fpm8-v8wm"
    },
    "@touchkey0111/jito-bundle": {
      blocked_all: true,
      reason: "Malware in @touchkey0111/jito-bundle (GHSA-wm3m-jxgh-45rj)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-wm3m-jxgh-45rj"
    },
    "jito-bundle-tip-7": {
      blocked_all: true,
      reason: "Malware in jito-bundle-tip-7 (GHSA-f985-77gc-37cx)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-f985-77gc-37cx"
    },
    "jito-bundle-jitotip": {
      blocked_all: true,
      reason: "Malware in jito-bundle-jitotip (GHSA-f2jv-xgx9-pxr8)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-f2jv-xgx9-pxr8"
    },
    arbkit: {
      blocked_all: true,
      reason: "Malware in arbkit (GHSA-8vwq-527w-6hcm)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-8vwq-527w-6hcm"
    },
    bandkit: {
      blocked_all: true,
      reason: "Malware in bandkit (GHSA-v69f-q3vh-9qcf)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-v69f-q3vh-9qcf"
    },
    "jailbreak-code": {
      blocked_all: true,
      reason: "Malware in jailbreak-code (GHSA-fmpq-536x-fhwq)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-fmpq-536x-fhwq"
    },
    txnforge: {
      blocked_all: true,
      reason: "Malware in txnforge (GHSA-qjw2-5743-xhp4)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-qjw2-5743-xhp4"
    },
    "print-hello-world-test-temp": {
      blocked_all: true,
      reason: "Malware in print-hello-world-test-temp (GHSA-jrrx-r9c6-3mhv)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-jrrx-r9c6-3mhv"
    },
    "web-pixels-manager": {
      blocked_all: true,
      reason: "Malware in web-pixels-manager (GHSA-v6gx-6p2r-f6pp)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-v6gx-6p2r-f6pp"
    },
    buyerdashboard: {
      blocked_all: true,
      reason: "Malware in buyerdashboard (GHSA-gg3j-f9ff-vx42)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-gg3j-f9ff-vx42"
    },
    "xapi-lib": {
      blocked_all: true,
      reason: "Malware in xapi-lib (GHSA-wm6w-9vgq-gw26)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-wm6w-9vgq-gw26"
    },
    "idlive-face-capture-web-development": {
      blocked_all: true,
      reason: "Malware in idlive-face-capture-web-development (GHSA-84cj-67gm-jqc5)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-84cj-67gm-jqc5"
    },
    gvmabc: {
      blocked_all: true,
      reason: "Malware in gvmabc (GHSA-65hx-gqfw-5gpg)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-65hx-gqfw-5gpg"
    },
    y0syoh: {
      blocked_all: true,
      reason: "Malware in y0syoh (GHSA-g9g2-jmg8-55w6)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-g9g2-jmg8-55w6"
    },
    sgj0kx: {
      blocked_all: true,
      reason: "Malware in sgj0kx (GHSA-4c39-8j6x-w27j)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-4c39-8j6x-w27j"
    },
    ru0z83: {
      blocked_all: true,
      reason: "Malware in ru0z83 (GHSA-jrr7-389c-xvx9)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-jrr7-389c-xvx9"
    },
    s775oe: {
      blocked_all: true,
      reason: "Malware in s775oe (GHSA-9vr6-jfc9-2hrj)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-9vr6-jfc9-2hrj"
    },
    ll3zea: {
      blocked_all: true,
      reason: "Malware in ll3zea (GHSA-c96g-mrq4-grg8)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-c96g-mrq4-grg8"
    },
    rtvu6h: {
      blocked_all: true,
      reason: "Malware in rtvu6h (GHSA-wqhj-26xr-qxfg)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-wqhj-26xr-qxfg"
    },
    v36sl2: {
      blocked_all: true,
      reason: "Malware in v36sl2 (GHSA-gvvq-fmh5-289g)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-gvvq-fmh5-289g"
    },
    bznio5: {
      blocked_all: true,
      reason: "Malware in bznio5 (GHSA-q4vj-66fh-mp2p)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-q4vj-66fh-mp2p"
    },
    ib3rwn: {
      blocked_all: true,
      reason: "Malware in ib3rwn (GHSA-gm4c-56vq-fvc9)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-gm4c-56vq-fvc9"
    },
    qxjf8r: {
      blocked_all: true,
      reason: "Malware in qxjf8r (GHSA-hxvp-c2g3-r3x5)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-hxvp-c2g3-r3x5"
    },
    wolce9: {
      blocked_all: true,
      reason: "Malware in wolce9 (GHSA-m9c6-jp5r-78jh)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-m9c6-jp5r-78jh"
    },
    "3zqth8": {
      blocked_all: true,
      reason: "Malware in 3zqth8 (GHSA-j6vh-x4xf-9mgh)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-j6vh-x4xf-9mgh"
    },
    g3ypjg: {
      blocked_all: true,
      reason: "Malware in g3ypjg (GHSA-5q27-444v-p666)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-5q27-444v-p666"
    },
    wxmzfq: {
      blocked_all: true,
      reason: "Malware in wxmzfq (GHSA-472h-9323-xcvr)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-472h-9323-xcvr"
    },
    wyrj3i: {
      blocked_all: true,
      reason: "Malware in wyrj3i (GHSA-pmhv-7c84-cgwc)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-pmhv-7c84-cgwc"
    },
    t6unrv: {
      blocked_all: true,
      reason: "Malware in t6unrv (GHSA-wcxx-qg5c-m5x2)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-wcxx-qg5c-m5x2"
    },
    "5df897": {
      blocked_all: true,
      reason: "Malware in 5df897 (GHSA-48hw-rh72-ghfh)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-48hw-rh72-ghfh"
    },
    kojs0k: {
      blocked_all: true,
      reason: "Malware in kojs0k (GHSA-6848-888x-98xp)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-6848-888x-98xp"
    },
    jd7ijw: {
      blocked_all: true,
      reason: "Malware in jd7ijw (GHSA-hjj4-7q39-pv9h)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-hjj4-7q39-pv9h"
    },
    j4pe0w: {
      blocked_all: true,
      reason: "Malware in j4pe0w (GHSA-v4x4-mw65-qg9w)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-v4x4-mw65-qg9w"
    },
    "2tyegs": {
      blocked_all: true,
      reason: "Malware in 2tyegs (GHSA-vqvx-2p5h-xq2p)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-vqvx-2p5h-xq2p"
    },
    "7un7kh": {
      blocked_all: true,
      reason: "Malware in 7un7kh (GHSA-45h2-rmx2-6wcv)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-45h2-rmx2-6wcv"
    },
    "more-resour-ces-gen-stickman-legends-f-r-e-e-h-a-c-k-gen-erat-or-bv4n15": {
      blocked_all: true,
      reason: "Malware in more-resour-ces-gen-stickman-legends-f-r-e-e-h-a-c-k-gen-erat-or-bv4n15 (GHSA-cxvw-m35g-gfvx)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-cxvw-m35g-gfvx"
    },
    u0bh1f: {
      blocked_all: true,
      reason: "Malware in u0bh1f (GHSA-rj5j-c6p5-3hrq)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-rj5j-c6p5-3hrq"
    },
    "more-resour-ces-gen-daylio-h-a-c-k-gen-erat-or-qvi0r6": {
      blocked_all: true,
      reason: "Malware in more-resour-ces-gen-daylio-h-a-c-k-gen-erat-or-qvi0r6 (GHSA-c94q-6359-2gcf)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-c94q-6359-2gcf"
    },
    "1b67v5": {
      blocked_all: true,
      reason: "Malware in 1b67v5 (GHSA-cwxv-8638-h5f2)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-cwxv-8638-h5f2"
    },
    winjb6: {
      blocked_all: true,
      reason: "Malware in winjb6 (GHSA-qhmw-9qw2-5x8x)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-qhmw-9qw2-5x8x"
    },
    "9ct8bi": {
      blocked_all: true,
      reason: "Malware in 9ct8bi (GHSA-pc8q-2g55-7ghp)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-pc8q-2g55-7ghp"
    },
    k7nhgj: {
      blocked_all: true,
      reason: "Malware in k7nhgj (GHSA-53j8-6fcm-mj4g)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-53j8-6fcm-mj4g"
    },
    j5ugvu: {
      blocked_all: true,
      reason: "Malware in j5ugvu (GHSA-7m7p-pwmq-5cg9)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-7m7p-pwmq-5cg9"
    },
    "working-today--empire-takeover-h-a-c-k-gen-erat-or-akcp8z": {
      blocked_all: true,
      reason: "Malware in working-today--empire-takeover-h-a-c-k-gen-erat-or-akcp8z (GHSA-99p8-pfpx-fjvh)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-99p8-pfpx-fjvh"
    },
    yhk9j0: {
      blocked_all: true,
      reason: "Malware in yhk9j0 (GHSA-wqrw-429v-9hc3)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-wqrw-429v-9hc3"
    },
    "more-resour-ces-gen-tailed-demon-slayer-h-a-c-k-gen-erat-or-yas2jz": {
      blocked_all: true,
      reason: "Malware in more-resour-ces-gen-tailed-demon-slayer-h-a-c-k-gen-erat-or-yas2jz (GHSA-mhj2-fr2q-rwgf)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-mhj2-fr2q-rwgf"
    },
    "more-resour-ces-gen-disney-mirrorverse-h-a-c-k-gen-erat-or-gulnxl": {
      blocked_all: true,
      reason: "Malware in more-resour-ces-gen-disney-mirrorverse-h-a-c-k-gen-erat-or-gulnxl (GHSA-qffp-x9cg-g7jw)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-qffp-x9cg-g7jw"
    },
    "real-gen-erator-one-shade-h-a-c-k-gen-erat-or-8ks294": {
      blocked_all: true,
      reason: "Malware in real-gen-erator-one-shade-h-a-c-k-gen-erat-or-8ks294 (GHSA-pv4p-pf47-47xw)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-pv4p-pf47-47xw"
    },
    l52upm: {
      blocked_all: true,
      reason: "Malware in l52upm (GHSA-c3h9-79ww-v5gh)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-c3h9-79ww-v5gh"
    },
    "updated-gen-erator-producer-h-a-c-k-gen-erat-or-g8pi55": {
      blocked_all: true,
      reason: "Malware in updated-gen-erator-producer-h-a-c-k-gen-erat-or-g8pi55 (GHSA-pr94-qp59-m2wm)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-pr94-qp59-m2wm"
    },
    "updated-gen-erator-rainbow-six-mobile-h-a-c-k-gen-erat-or-1179lh": {
      blocked_all: true,
      reason: "Malware in updated-gen-erator-rainbow-six-mobile-h-a-c-k-gen-erat-or-1179lh (GHSA-hr7m-jr7f-x5cp)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-hr7m-jr7f-x5cp"
    },
    "updated-today-gen-dr-parking-4-h-a-c-k-gen-erat-or-hmdcsa": {
      blocked_all: true,
      reason: "Malware in updated-today-gen-dr-parking-4-h-a-c-k-gen-erat-or-hmdcsa (GHSA-f723-86mx-5f32)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-f723-86mx-5f32"
    },
    "new-code-unlim-ited-jurassic-world-m-od-f-r-e-e-wuo1ky": {
      blocked_all: true,
      reason: "Malware in new-code-unlim-ited-jurassic-world-m-od-f-r-e-e-wuo1ky (GHSA-wjc8-4c4f-f5gh)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-wjc8-4c4f-f5gh"
    },
    "new-code-unlim-ited-my-time-at-portia-h-a-c-k-gen-erat-or-i477p4": {
      blocked_all: true,
      reason: "Malware in new-code-unlim-ited-my-time-at-portia-h-a-c-k-gen-erat-or-i477p4 (GHSA-w8fh-67cj-9fpq)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-w8fh-67cj-9fpq"
    },
    "updated-today-gen-photo-lab-pro-h-a-c-k-gen-erat-or-ofgpju": {
      blocked_all: true,
      reason: "Malware in updated-today-gen-photo-lab-pro-h-a-c-k-gen-erat-or-ofgpju (GHSA-q5q8-w3pp-7fgq)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-q5q8-w3pp-7fgq"
    },
    "gene-rator-new-hearthstone-h-a-c-k-gen-erat-or-9wy4b5": {
      blocked_all: true,
      reason: "Malware in gene-rator-new-hearthstone-h-a-c-k-gen-erat-or-9wy4b5 (GHSA-pj5m-334m-g92j)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-pj5m-334m-g92j"
    },
    "code-resour-ces-new-app-cloner-premium-9upyk2": {
      blocked_all: true,
      reason: "Malware in code-resour-ces-new-app-cloner-premium-9upyk2 (GHSA-fm53-p7qv-jwvx)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-fm53-p7qv-jwvx"
    },
    "gene-rator-new-rope-hero-h-a-c-k-gen-erat-or-azkrvc": {
      blocked_all: true,
      reason: "Malware in gene-rator-new-rope-hero-h-a-c-k-gen-erat-or-azkrvc (GHSA-v2mw-9w26-p7jg)",
      date: "2026-11-03",
      advisory: "https://github.com/advisories/GHSA-v2mw-9w26-p7jg"
    },
    "unemployed_xerinae-toolteadev": {
      blocked_all: true,
      reason: "Malicious code in unemployed_xerinae-toolteadev (npm) (GHSA-c9vc-x2gg-hw32)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-c9vc-x2gg-hw32"
    },
    "peas-tea-curut": {
      blocked_all: true,
      reason: "Malicious code in peas-tea-curut (npm) (GHSA-7q53-6jpr-rhpp)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-7q53-6jpr-rhpp"
    },
    wet_rat_replicate_automation: {
      blocked_all: true,
      reason: "Malicious code in wet_rat_replicate_automation (npm) (GHSA-gp2j-hp5w-f4vf)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-gp2j-hp5w-f4vf"
    },
    "quiche-tea-curut": {
      blocked_all: true,
      reason: "Malicious code in quiche-tea-curut (npm) (GHSA-p7g6-w5rr-h6fx)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-p7g6-w5rr-h6fx"
    },
    "related_blackbird-toolteadev": {
      blocked_all: true,
      reason: "Malicious code in related_blackbird-toolteadev (npm) (GHSA-6w3c-x58r-rm96)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-6w3c-x58r-rm96"
    },
    wxwxtt: {
      blocked_all: true,
      reason: "Malicious code in wxwxtt (npm) (GHSA-678p-cx2w-w69p)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-678p-cx2w-w69p"
    },
    testtestkjkldfnjdfn: {
      blocked_all: true,
      reason: "Malicious code in testtestkjkldfnjdfn (npm) (GHSA-j4mg-x22p-3q6m)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-j4mg-x22p-3q6m"
    },
    wisewwasd: {
      blocked_all: true,
      reason: "Malicious code in wisewwasd (npm) (GHSA-hhwj-3gxq-p9hw)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-hhwj-3gxq-p9hw"
    },
    wiselllx: {
      blocked_all: true,
      reason: "Malicious code in wiselllx (npm) (GHSA-w2vv-r9c4-jh3x)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-w2vv-r9c4-jh3x"
    },
    "dian-peyek23-miaww": {
      blocked_all: true,
      reason: "Malicious code in dian-peyek23-miaww (npm) (GHSA-phmx-r6fx-798c)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-phmx-r6fx-798c"
    },
    "solidity-gas-watcher": {
      blocked_all: true,
      reason: "Malicious code in solidity-gas-watcher (npm) (GHSA-rgfv-cv82-ppcm)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-rgfv-cv82-ppcm"
    },
    wiasdcxc: {
      blocked_all: true,
      reason: "Malicious code in wiasdcxc (npm) (GHSA-458c-rvqf-2638)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-458c-rvqf-2638"
    },
    "solidity-cat": {
      blocked_all: true,
      reason: "Malicious code in solidity-cat (npm) (GHSA-93r8-wfvq-vpvg)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-93r8-wfvq-vpvg"
    },
    "maila-talijah-alpha-128": {
      blocked_all: true,
      reason: "Malicious code in maila-talijah-alpha-128 (npm) (GHSA-pmxw-wvq7-rjgp)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-pmxw-wvq7-rjgp"
    },
    "solidity-map": {
      blocked_all: true,
      reason: "Malicious code in solidity-map (npm) (GHSA-95qc-c4xp-j95w)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-95qc-c4xp-j95w"
    },
    "dependent-final": {
      blocked_all: true,
      reason: "Malicious code in dependent-final (npm) (GHSA-x23q-jp7q-hjf8)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-x23q-jp7q-hjf8"
    },
    low_hummingbird_replicate_automation: {
      blocked_all: true,
      reason: "Malicious code in low_hummingbird_replicate_automation (npm) (GHSA-777j-qwpx-hqmv)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-777j-qwpx-hqmv"
    },
    xzvbailss: {
      blocked_all: true,
      reason: "Malicious code in xzvbailss (npm) (GHSA-pr4w-wjwf-c2g3)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-pr4w-wjwf-c2g3"
    },
    "pearx93qja-notthedevs": {
      blocked_all: true,
      reason: "Malicious code in pearx93qja-notthedevs (npm) (GHSA-c2f4-3mvg-7f8h)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-c2f4-3mvg-7f8h"
    },
    "ruby-baileys": {
      blocked_all: true,
      reason: "Malicious code in ruby-baileys (npm) (GHSA-v4gm-7w96-f3xq)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-v4gm-7w96-f3xq"
    },
    "cs-core-api-phoenix": {
      blocked_all: true,
      reason: "Malicious code in cs-core-api-phoenix (npm) (GHSA-5rmp-29vr-6q79)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-5rmp-29vr-6q79"
    },
    "lunaaa-baileys": {
      blocked_all: true,
      reason: "Malicious code in lunaaa-baileys (npm) (GHSA-rr77-wr29-jh28)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-rr77-wr29-jh28"
    },
    "kevinx-baileys": {
      blocked_all: true,
      reason: "Malicious code in kevinx-baileys (npm) (GHSA-rr5f-94j3-xjw3)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-rr5f-94j3-xjw3"
    },
    "ndraawzz-baileys": {
      blocked_all: true,
      reason: "Malicious code in ndraawzz-baileys (npm) (GHSA-rrmr-c6m3-x33m)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-rrmr-c6m3-x33m"
    },
    "pino-std": {
      blocked_all: true,
      reason: "Malicious code in pino-std (npm) (GHSA-cc98-qqxc-x7r6)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-cc98-qqxc-x7r6"
    },
    "@zyrennofficiall/baileys": {
      blocked_all: true,
      reason: "Malicious code in @zyrennofficiall/baileys (npm) (GHSA-xhv6-rwhf-2wx2)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-xhv6-rwhf-2wx2"
    },
    "ichigokurosaki-baileys": {
      blocked_all: true,
      reason: "Malicious code in ichigokurosaki-baileys (npm) (GHSA-3ggh-rhmq-3v8w)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-3ggh-rhmq-3v8w"
    },
    "loader-utils-kit": {
      blocked_all: true,
      reason: "Malicious code in loader-utils-kit (npm) (GHSA-2hvh-9r5r-6xj3)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-2hvh-9r5r-6xj3"
    },
    "@denzz221/baileys": {
      blocked_all: true,
      reason: "Malicious code in @denzz221/baileys (npm) (GHSA-588x-qpg3-55p7)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-588x-qpg3-55p7"
    },
    "aemeath-baileys": {
      blocked_all: true,
      reason: "Malicious code in aemeath-baileys (npm) (GHSA-p48h-3642-cg37)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-p48h-3642-cg37"
    },
    "@bellaxchan/sixtech": {
      blocked_all: true,
      reason: "Malicious code in @bellaxchan/sixtech (npm) (GHSA-qwh5-5r23-qmrg)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-qwh5-5r23-qmrg"
    },
    "@zaxius/baileys": {
      blocked_all: true,
      reason: "Malicious code in @zaxius/baileys (npm) (GHSA-888v-4h85-r423)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-888v-4h85-r423"
    },
    "@wanzforme/bails": {
      blocked_all: true,
      reason: "Malicious code in @wanzforme/bails (npm) (GHSA-jr7m-gx4v-25ph)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-jr7m-gx4v-25ph"
    },
    "@sakataa/baileys": {
      blocked_all: true,
      reason: "Malicious code in @sakataa/baileys (npm) (GHSA-v2gw-xwwr-5v2c)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-v2gw-xwwr-5v2c"
    },
    "@alannxds/baileys": {
      blocked_all: true,
      reason: "Malicious code in @alannxds/baileys (npm) (GHSA-6c9f-82qv-qmq2)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-6c9f-82qv-qmq2"
    },
    "@axo_cuy/baileyss": {
      blocked_all: true,
      reason: "Malicious code in @axo_cuy/baileyss (npm) (GHSA-4xm7-j9vm-7cfq)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-4xm7-j9vm-7cfq"
    },
    "@bellaxchan/techxatz": {
      blocked_all: true,
      reason: "Malicious code in @bellaxchan/techxatz (npm) (GHSA-974f-fvcg-vvc7)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-974f-fvcg-vvc7"
    },
    "@monze1239/baileys": {
      blocked_all: true,
      reason: "Malicious code in @monze1239/baileys (npm) (GHSA-2wm3-79g9-h6rx)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-2wm3-79g9-h6rx"
    },
    "@bellaxchan/eleventech": {
      blocked_all: true,
      reason: "Malicious code in @bellaxchan/eleventech (npm) (GHSA-xfxr-27rj-f57f)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-xfxr-27rj-f57f"
    },
    "@bellaxchan/bailtech": {
      blocked_all: true,
      reason: "Malicious code in @bellaxchan/bailtech (npm) (GHSA-43p9-p64v-82g3)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-43p9-p64v-82g3"
    },
    "@raffnotdev/baileys": {
      blocked_all: true,
      reason: "Malicious code in @raffnotdev/baileys (npm) (GHSA-g8f4-vq44-pjx3)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-g8f4-vq44-pjx3"
    },
    "@dyllxnn/baileys": {
      blocked_all: true,
      reason: "Malicious code in @dyllxnn/baileys (npm) (GHSA-9mg6-gjp6-25j7)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-9mg6-gjp6-25j7"
    },
    "@lekzox/baileys": {
      blocked_all: true,
      reason: "Malicious code in @lekzox/baileys (npm) (GHSA-gpw9-jch5-fhgq)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-gpw9-jch5-fhgq"
    },
    "@k.vict1999/pino-std-serializers": {
      blocked_all: true,
      reason: "Malicious code in @k.vict1999/pino-std-serializers (npm) (GHSA-g56j-96r8-x96p)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-g56j-96r8-x96p"
    },
    "synapse-hub": {
      blocked_all: true,
      reason: "Malware in synapse-hub (GHSA-q7g7-jwp5-cvgh)",
      date: "2026-11-05",
      advisory: "https://github.com/advisories/GHSA-q7g7-jwp5-cvgh"
    },
    "@secauditb20y/sec-test-b1": {
      blocked_all: true,
      reason: "Malware in @secauditb20y/sec-test-b1 (GHSA-4rp3-383p-p8qj)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-4rp3-383p-p8qj"
    },
    "@secaudita10x/sec-test-a1": {
      blocked_all: true,
      reason: "Malware in @secaudita10x/sec-test-a1 (GHSA-pgq7-5652-37p2)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-pgq7-5652-37p2"
    },
    "@secauditb20y/sec-test-r3b": {
      blocked_all: true,
      reason: "Malware in @secauditb20y/sec-test-r3b (GHSA-h95w-3ffr-98m2)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-h95w-3ffr-98m2"
    },
    exnesss: {
      blocked_all: true,
      reason: "Malware in exnesss (GHSA-32p4-hf5c-v228)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-32p4-hf5c-v228"
    },
    "dogmans-afterglow": {
      blocked_all: true,
      reason: "Malware in dogmans-afterglow (GHSA-hp36-pmf7-j3cg)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-hp36-pmf7-j3cg"
    },
    nannnnnnnnn: {
      blocked_all: true,
      reason: "Malware in nannnnnnnnn (GHSA-hqfx-x4m7-grcv)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-hqfx-x4m7-grcv"
    },
    "doghack-afterglow": {
      blocked_all: true,
      reason: "Malware in doghack-afterglow (GHSA-7g67-f73j-fv58)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-7g67-f73j-fv58"
    },
    "@saidddddddddd/somethingelse": {
      blocked_all: true,
      reason: "Malware in @saidddddddddd/somethingelse (GHSA-qfxf-cc7c-cj3v)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-qfxf-cc7c-cj3v"
    },
    "@saidddddddddd/ggsgg": {
      blocked_all: true,
      reason: "Malware in @saidddddddddd/ggsgg (GHSA-rrmm-993c-wx3r)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-rrmm-993c-wx3r"
    },
    thththtbhthhth: {
      blocked_all: true,
      reason: "Malware in thththtbhthhth (GHSA-cvvr-rqx9-2683)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-cvvr-rqx9-2683"
    },
    heheheshsds: {
      blocked_all: true,
      reason: "Malware in heheheshsds (GHSA-rgqx-q27x-g8jc)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-rgqx-q27x-g8jc"
    },
    nminer: {
      blocked_all: true,
      reason: "Malware in nminer (GHSA-hvrq-7pvp-2573)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-hvrq-7pvp-2573"
    },
    "@pubngo-stack/help-browser": {
      blocked_all: true,
      reason: "Malware in @pubngo-stack/help-browser (GHSA-284w-rrfr-35rg)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-284w-rrfr-35rg"
    },
    "@cdmbase/wiki-browser": {
      blocked_all: true,
      reason: "Malware in @cdmbase/wiki-browser (GHSA-qg2p-28h9-mjw8)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-qg2p-28h9-mjw8"
    },
    "@adminide-stack/yantra-help-browser": {
      blocked_all: true,
      reason: "Malware in @adminide-stack/yantra-help-browser (GHSA-7wfq-2q8j-q4xj)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-7wfq-2q8j-q4xj"
    },
    "@adminide-stack/forms-core": {
      blocked_all: true,
      reason: "Malware in @adminide-stack/forms-core (GHSA-qrh3-jr62-6rfm)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-qrh3-jr62-6rfm"
    },
    cdeops: {
      blocked_all: true,
      reason: "Malware in cdeops (GHSA-4rxj-jcfq-cpm2)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-4rxj-jcfq-cpm2"
    },
    "@adminide-stack/user-activity-browser": {
      blocked_all: true,
      reason: "Malware in @adminide-stack/user-activity-browser (GHSA-ff5p-vgj6-cjcp)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-ff5p-vgj6-cjcp"
    },
    "@adminide-stack/health-api-server": {
      blocked_all: true,
      reason: "Malware in @adminide-stack/health-api-server (GHSA-w4gc-9685-7pr8)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-w4gc-9685-7pr8"
    },
    "@adminide-stack/client-redux": {
      blocked_all: true,
      reason: "Malware in @adminide-stack/client-redux (GHSA-phqq-85q5-xmqm)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-phqq-85q5-xmqm"
    },
    "@adminide-stack/utils": {
      blocked_all: true,
      reason: "Malware in @adminide-stack/utils (GHSA-7gx8-qvpw-82h6)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-7gx8-qvpw-82h6"
    },
    "mock-datas-lib": {
      blocked_all: true,
      reason: "Malware in mock-datas-lib (GHSA-33jq-j4x3-75pc)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-33jq-j4x3-75pc"
    },
    "data-sync-utils": {
      blocked_all: true,
      reason: "Malware in data-sync-utils (GHSA-3q8h-39p8-6vw8)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-3q8h-39p8-6vw8"
    },
    "kvarzo-8f3a2-testmetest": {
      blocked_all: true,
      reason: "Malware in kvarzo-8f3a2-testmetest (GHSA-cfr8-88wx-3j9g)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-cfr8-88wx-3j9g"
    },
    "that-fetch": {
      blocked_all: true,
      reason: "Malware in that-fetch (GHSA-cwjc-3f32-g7cg)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-cwjc-3f32-g7cg"
    },
    filipt: {
      blocked_all: true,
      reason: "Malware in filipt (GHSA-56fp-mx7r-63x8)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-56fp-mx7r-63x8"
    },
    "@pasqua-baileys/baileys": {
      blocked_all: true,
      reason: "Malware in @pasqua-baileys/baileys (GHSA-73vv-6qcp-qgpw)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-73vv-6qcp-qgpw"
    },
    "@realvare/baileys": {
      blocked_all: true,
      reason: "Malware in @realvare/baileys (GHSA-3959-8jgw-g6xp)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-3959-8jgw-g6xp"
    },
    "@realvare/based": {
      blocked_all: true,
      reason: "Malware in @realvare/based (GHSA-r5hx-v68j-8w57)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-r5hx-v68j-8w57"
    },
    "canta-baileys": {
      blocked_all: true,
      reason: "Malware in canta-baileys (GHSA-475j-858m-v8ww)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-475j-858m-v8ww"
    },
    "@fyxzpediaa/libsignal": {
      blocked_all: true,
      reason: "Malware in @fyxzpediaa/libsignal (GHSA-xwm4-6w5f-x95p)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-xwm4-6w5f-x95p"
    },
    "noon-contracts": {
      blocked_all: true,
      reason: "Malware in noon-contracts (GHSA-qj9j-8fcr-pjq2)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-qj9j-8fcr-pjq2"
    },
    "@ai-ecoverse/slicc-windows-amd64": {
      blocked_all: true,
      reason: "Malware in @ai-ecoverse/slicc-windows-amd64 (GHSA-38rp-mcrj-j69m)",
      date: "2026-11-04",
      advisory: "https://github.com/advisories/GHSA-38rp-mcrj-j69m"
    }
  }
};

// src/package-install-guard.ts
var DIR = String.raw`(?:&\s*)?(?:"[^"]*[\\/]|'[^']*[\\/]|[^\s"']*[\\/])?`;
var PIP_OPTS = String.raw`(?:\s+(?:--(?:proxy|log|cache-dir|timeout|retries|cert|client-cert|exists-action|trusted-host|python|use-feature|keyring-provider)\s+(?!-[-\w]+(?:=\S+)?(?!\S))\S+|-[-\w]+(?:=\S+)?))*`;
var PY_OPTS = String.raw`(?:\s+(?:-[XW]\s*\S+|-[IuBEsSOqbdv]+|-\d(?:\.\d+)?))*`;
var UV_OPTS = String.raw`(?:\s+(?:--(?:directory|project|config-file|cache-dir|python|color|python-preference|allow-insecure-host|index-strategy)(?:=|\s+(?!-))\S+|(?:-[qv]+|-n|--(?:quiet|verbose|offline|no-cache|no-progress|no-config|native-tls))(?=\s|$)))*`;
var PY_VAR = String.raw`["']?\$(?:\{[^}\s]+\}|(?:env:)?\w+)`;
function installPattern(body, ecosystem, opts = {}) {
  const f = opts.ignoreCase ? "i" : "";
  return {
    regex: new RegExp(`^${body}`, f),
    loose: new RegExp(String.raw`(?:^|[\s;&|({])${body}`, f),
    ecosystem,
    requirePin: opts.requirePin,
    kind: opts.kind ?? "list",
    flags: opts.flags ?? "other",
    remoteOnly: opts.remoteOnly,
    preferLocal: opts.preferLocal
  };
}
var END = String.raw`(?=\s|$)`;
var bin = (name) => String.raw`${DIR}${name}(?:\.cmd|\.exe|\.ps1)?["']?`;
var NODE_OPTS = String.raw`(?:\s+(?:--(?:prefix|registry|cache|userconfig|globalconfig|loglevel|workspace|cwd|dir|filter|modules-folder)\s+(?!-)\S+|-C\s+(?!-)\S+|-\S+))*`;
var NPM_INSTALL = "(?:install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|install-test|it)";
var NPM_CI = "(?:ci|clean-install|ic|install-clean|isntall-clean|install-ci-test|cit|clean-install-test|sit)";
var NPM_UPDATE = "(?:update|up|upgrade|udpate)";
var PIP_VERBS = "(?:install|download|wheel)";
var INSTALL_PATTERNS = [
  // Python (Windows runs Python.exe and PIP the same as python and pip, so these ignore case)
  installPattern(String.raw`${DIR}pip(?:3(?:\.\d+)?)?(?:\.exe)?["']?${PIP_OPTS}\s+${PIP_VERBS}${END}`, "pypi", { requirePin: true, flags: "pip", ignoreCase: true }),
  // -m and its module may be one word: python -mpip install x.
  installPattern(String.raw`${DIR}(?:python(?:3(?:\.\d+)?)?|py|${PY_VAR})(?:\.exe)?["']?${PY_OPTS}\s+-m\s*pip${PIP_OPTS}\s+${PIP_VERBS}${END}`, "pypi", { requirePin: true, flags: "pip", ignoreCase: true }),
  installPattern(String.raw`uv${UV_OPTS}\s+pip\s+install${END}`, "pypi", { requirePin: true, flags: "pip" }),
  installPattern(String.raw`uv${UV_OPTS}\s+add${END}`, "pypi", { flags: "pip" }),
  installPattern(String.raw`poetry\s+add${END}`, "pypi", { flags: "pip" }),
  installPattern(String.raw`pipenv\s+install${END}`, "pypi", { flags: "pip" }),
  // Python runners and tool installs (F13): the first token is the package, the rest is its argv.
  installPattern(String.raw`(?:uvx|uv${UV_OPTS}\s+tool\s+(?:run|install)|pipx\s+(?:run|install))${END}`, "pypi", { kind: "first", flags: "pyrunner" }),
  installPattern(String.raw`uv${UV_OPTS}\s+run${END}`, "pypi", { kind: "run", flags: "pyrunner" }),
  // JavaScript / Node
  installPattern(String.raw`${bin("npm")}${NODE_OPTS}\s+${NPM_INSTALL}${END}`, "npm", { flags: "node" }),
  installPattern(String.raw`${bin("npm")}${NODE_OPTS}\s+${NPM_UPDATE}${END}`, "npm", { flags: "node" }),
  installPattern(String.raw`${bin("npm")}${NODE_OPTS}\s+${NPM_CI}${END}`, "npm", { kind: "lockfile", flags: "node" }),
  installPattern(String.raw`${bin("npm")}${NODE_OPTS}\s+(?:exec|x)${END}`, "npm", { kind: "first", flags: "node", preferLocal: true }),
  installPattern(String.raw`(?:${bin("npm")}${NODE_OPTS}\s+(?:create|init|innit)|${bin("(?:yarn|pnpm|bun)")}${NODE_OPTS}\s+create)${END}`, "npm", { kind: "create", flags: "node" }),
  installPattern(String.raw`${bin("yarn")}${NODE_OPTS}\s+(?:global\s+)?(?:add|up|upgrade)${END}`, "npm", { flags: "node" }),
  // A bare `yarn` / `yarn install` names no package. needsCheck counts it only when the command sets a registry (G2).
  // Its loose form never matches: `which yarn` and `echo yarn install` are not installs.
  { ...installPattern(String.raw`${bin("yarn")}${NODE_OPTS}(?:\s+install${END}|\s*$)`, "npm", { flags: "node" }), loose: /(?!)/ },
  installPattern(String.raw`${bin("pnpm")}${NODE_OPTS}\s+(?:add|install|i|update|up|upgrade)${END}`, "npm", { flags: "node" }),
  installPattern(String.raw`${bin("bun")}${NODE_OPTS}\s+(?:add|a|install|i|update)${END}`, "npm", { flags: "node" }),
  installPattern(String.raw`(?:${bin("npx")}|${bin("bunx")}|${bin("bun")}${NODE_OPTS}\s+x)${END}`, "npm", { kind: "first", flags: "node", preferLocal: true }),
  // pnpx is pnpm dlx. These always fetch, even when a local bin of that name exists.
  installPattern(String.raw`(?:${bin("pnpx")}|${bin("yarn")}${NODE_OPTS}\s+dlx|${bin("pnpm")}${NODE_OPTS}\s+dlx)${END}`, "npm", { kind: "first", flags: "node" }),
  // deno names its sources npm:x, jsr:x or a URL; the classifier asks on each of them.
  installPattern(String.raw`${bin("deno")}\s+(?:install|i|add)${END}`, "npm", { flags: "node" }),
  // Rust, Go, Ruby, PHP: matched so the guard can ask. It has no blocklist or age check for them.
  installPattern(String.raw`cargo\s+(?:add|install|binstall)${END}`, "cargo"),
  // NuGet and Homebrew (G4): same policy as cargo, the guard has no blocklist, OSV or age check for them.
  // Up to 8 option words may come first (dotnet -d add package X), and up to 8 project words after add.
  // Both loops are bounded, so the loose scan stays linear: 1500 "dotnet add" words must not stall the hook.
  installPattern(String.raw`${bin("dotnet")}(?:\s+\S+){0,8}?\s+(?:add(?:\s+\S+){0,8}?\s+package|package\s+add|tool\s+(?:install|update|exec|run)|dnx)${END}`, "nuget"),
  installPattern(String.raw`${bin("dnx")}${END}`, "nuget", { kind: "first" }),
  installPattern(String.raw`brew\s+(?:install|reinstall|upgrade)${END}`, "brew"),
  installPattern(String.raw`go\s+(?:get|install)${END}`, "go"),
  installPattern(String.raw`go\s+run${END}`, "go", { remoteOnly: true }),
  installPattern(String.raw`gem\s+install${END}`, "gem"),
  installPattern(String.raw`composer\s+require${END}`, "composer")
];
var EXACT_PIN = /^[A-Za-z0-9_.-]+(?:\[[^\]]*\])?===?[^=<>~!*,;\s]+$/;
var PIP_VALUE = [
  // uv global options (uvx --directory DIR tool, uvx --color never tool)
  "--directory",
  "--project",
  "--color",
  "--python-preference",
  "--allow-insecure-host",
  "-t",
  "--target",
  "--prefix",
  "--root",
  "--src",
  // pip and uv pip (a value here is not a package; the pin check would deny it)
  "--trusted-host",
  "--python",
  "-p",
  "--python-version",
  "--platform",
  "--abi",
  "--implementation",
  "--timeout",
  "--retries",
  "--proxy",
  "--cert",
  "--client-cert",
  "--cache-dir",
  "--log",
  "--upgrade-strategy",
  "--progress-bar",
  "--exists-action",
  "--report",
  "-C",
  "--config-settings",
  "--index-strategy",
  "--resolution",
  "--prerelease",
  "--keyring-provider",
  "--root-user-action"
];
var PIP_SOURCE = ["-r", "--requirement", "-c", "--constraint", "-e", "--editable", "--with-requirements", "--with-editable"];
var PIP_INDEX = ["-i", "--index-url", "--extra-index-url", "--index", "--default-index", "-f", "--find-links", "--source", "--config-file"];
var PY_BARE = [
  "--",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "-n",
  "--no-cache",
  "--offline",
  "--isolated",
  "--refresh",
  "-U",
  "--upgrade",
  "--force",
  "--native-tls",
  "--no-config",
  "--no-progress",
  "--preview",
  "-e",
  "--editable",
  "--include-deps"
];
var none = () => /* @__PURE__ */ new Set();
var FLAG_TABLES = {
  pip: { value: new Set(PIP_VALUE), pkg: none(), source: new Set(PIP_SOURCE), index: new Set(PIP_INDEX), extra: none(), bare: none() },
  // Only --from and --spec name the package that runs; --with adds one more (F11/F13 repair).
  pyrunner: {
    value: new Set(PIP_VALUE),
    pkg: /* @__PURE__ */ new Set(["--from", "--spec"]),
    source: new Set(PIP_SOURCE.filter((f) => f !== "-e" && f !== "--editable")),
    index: new Set(PIP_INDEX),
    extra: /* @__PURE__ */ new Set(["--with", "-w"]),
    bare: new Set(PY_BARE)
  },
  node: {
    value: /* @__PURE__ */ new Set([
      "--prefix",
      "--cache",
      "--tag",
      "--workspace",
      "-w",
      "--filter",
      "--dir",
      "--cwd",
      "--loglevel",
      "--omit",
      "--include",
      "--save-prefix",
      "--modules-folder",
      "--network-concurrency",
      "-C",
      "--call",
      "-c",
      "--node-options",
      "--shell",
      "--script-shell"
    ]),
    pkg: /* @__PURE__ */ new Set(["-p", "--package"]),
    source: none(),
    // A user or global config file can set the registry (F11 repair).
    index: /* @__PURE__ */ new Set(["--registry", "--userconfig", "--globalconfig"]),
    extra: none(),
    bare: /* @__PURE__ */ new Set([
      "--",
      "-y",
      "--yes",
      "--no",
      "-q",
      "--quiet",
      "-s",
      "--silent",
      "--ignore-existing",
      "--no-install",
      "--prefer-offline",
      "--prefer-online",
      "--offline",
      "-g",
      "--global",
      "-D",
      "--dev",
      "-E",
      "--exact"
    ])
  },
  other: { value: none(), pkg: none(), source: none(), index: none(), extra: none(), bare: none() }
};
function isPackageInstallCommand(command) {
  return extractPackageNames(command).length > 0;
}
function parseEcosystem(command) {
  return matchInstall(command)?.pattern.ecosystem ?? null;
}
function extractPackageNames(command) {
  return analyzeInstall(command)?.packages ?? [];
}
function unpinnedPipPackages(command) {
  const install = analyzeInstall(command);
  if (!install?.pattern.requirePin) return [];
  return install.named.filter(({ raw }) => !EXACT_PIN.test(pipSpec(raw))).map(({ pkg }) => pkg.name);
}
function pipSpec(token) {
  return token.split(";")[0].replace(/\s+/g, "");
}
var LEADER = new RegExp(String.raw`^(?:(?:${[
  String.raw`sudo(?:\s+(?:-[ugCDhpRrTt]\s+(?!-)\S+|-\S+))*`,
  String.raw`doas(?:\s+-u\s+\S+)?`,
  String.raw`env(?:\s+(?:-[uCS]\s+(?!-)\S+|-\S+))*`,
  String.raw`timeout(?:\s+(?:-[sk]\s+(?!-)\S+|-\S+))*\s+\d+(?:\.\d+)?[smhd]?`,
  String.raw`nice(?:\s+-n\s+-?\d+|\s+-\d+)?`,
  String.raw`exec(?:\s+-a\s+\S+|\s+-[cl]+)*`,
  "time",
  "nohup",
  "command",
  "builtin"
].join("|")})\s+|[{(]\s*)+`);
function stripLeaders(segment) {
  return segment.trim().replace(LEADER, "").replace(/\s*[})]\s*$/, "");
}
function stripPrefixes(command) {
  let s = command.trim();
  for (let prev = ""; s !== prev; ) {
    prev = s;
    s = stripLeaders(stripEnvPrefix(s)).trim();
  }
  return s;
}
function installSegments(command, tool = "Bash", depth = 0) {
  return installPlans(command, tool, null, depth).map((p) => p.segment);
}
function installPlans(command, tool = "Bash", cwd = null, depth = 0, configured) {
  const config = configured ?? (indexConfigMarkers(command).length > 0 || persistentConfigMarkers(command, tool).length > 0 || rawConfigMarkers(command).length > 0);
  try {
    const { segments, substitutions } = parseExecutable(normalizeEscapes(executableView(command, tool), tool));
    const found = segments.map(stripLeaders).filter((s) => needsCheck(s, tool, config)).map((segment) => ({ segment, cwd, tool }));
    if (depth >= 3) return found;
    const nested = [...substitutions, ...wrapperPayloadsFromSegments(segments)];
    return [...found, ...nested.flatMap((text) => installPlans(text, tool, cwd, depth + 1, config))];
  } catch {
    return needsCheck(command, tool, config) ? [{ segment: command.trim(), cwd: null, tool }] : [];
  }
}
var MAY_MOVE_WORD = /\b(?:cd|pushd|popd|chdir|sl|set-location|push-location|pop-location|source|eval|iex|invoke-expression)\b|(?:^|\s)\.\s|(?:^|\s)-(?:wd|wo\w*)(?=[\s:=]|$)/i;
var MAY_MOVE_OTHER = /(?:^|\s)(?:-[CD]|--chdir|--prefix|--cwd|--dir|--directory)(?=[\s=]|$)|(?:^|\s)-[CD]\S|[$`]/;
function mayMoveFolder(text) {
  const plain = text.replace(/\\\r?\n/g, "").replace(/[\\'"`^]/g, "");
  return MAY_MOVE_WORD.test(text) || MAY_MOVE_WORD.test(plain) || MAY_MOVE_OTHER.test(text) || /npm_config_prefix/i.test(text);
}
var GLOBAL_MODE = /(?:^|\s)(?:-g|--global|--location[=\s]+global)(?=\s|$)|npm_config_global|npm_config_location/i;
function localBinCwd(command, cwd) {
  return cwd === null || mayMoveFolder(command) || GLOBAL_MODE.test(command) ? null : cwd;
}
function needsCheck(segment, tool, configured = false) {
  const a = analyzeInstall(segment);
  if (!a) return hiddenInstall(segment, tool);
  return configured || a.packages.length > 0 || a.unparsed.length > 0 || a.customIndex.length > 0 || a.ambiguous.length > 0 || a.pattern.kind === "lockfile";
}
var ANY_WORD = /./;
var word = (alts) => new RegExp(`^${alts}$`);
var MANAGER_VERBS = [
  [/^npm$/, new RegExp(`^(?:${NPM_INSTALL.slice(3, -1)}|${NPM_CI.slice(3, -1)}|${NPM_UPDATE.slice(3, -1)}|exec|x|create|init|innit)$`)],
  [/^pnpm$/, /^(?:add|install|i|dlx|create|update|up|upgrade)$/],
  [/^yarn$/, /^(?:add|dlx|create|up|upgrade)$/],
  [/^bun$/, /^(?:add|a|install|i|x|create|update)$/],
  [/^(?:pip\d*(?:\.\d+)?|pipx|pipenv)$/, word(PIP_VERBS)],
  // uv with an option the patterns do not know (uv --foo X run --with y) still asks. managerVerbs takes the first entry, so uv has one.
  [/^uv$/, /^(?:install|download|wheel|add|run|tool)$/],
  [/^poetry$/, /^add$/],
  [/^cargo$/, /^(?:add|install|binstall)$/],
  [/^brew$/, /^(?:install|reinstall|upgrade)$/],
  [/^go$/, /^(?:get|install)$/],
  [/^gem$/, /^install$/],
  [/^composer$/, /^require$/],
  [/^deno$/, /^(?:install|i|add)$/],
  [/^(?:npx|pnpx|bunx|uvx)$/, ANY_WORD]
];
function commandName(word2) {
  return (word2.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(?:cmd|exe|ps1)$/, "");
}
function managerVerbs(word2) {
  const names = [commandName(word2), commandName(word2.replace(/\\/g, ""))];
  return MANAGER_VERBS.find(([manager]) => names.some((n) => manager.test(n)))?.[1];
}
function verbOrHidden(word2, verbs) {
  return /^[$`]/.test(word2) || verbs.test(word2) || verbs.test(word2.replace(/\\/g, ""));
}
var ANY_VERB = new RegExp(`^(?:${MANAGER_VERBS.filter(([, v]) => v !== ANY_WORD).map(([, v]) => v.source.replace(/^\^|\$$/g, "")).join("|")})$`);
var START_PROCESS = /^(?:start-process|saps|start)$/i;
var NOT_INSTALL = /^(?:test|t|tst|run|run-script|start|stop|restart|build|exec)$/;
function anyManagerInstall(words) {
  return words.some((w, i) => {
    const verbs = managerVerbs(w);
    if (verbs === void 0) return false;
    let subcommandSeen = false;
    for (let j = i + 1; j < words.length; j++) {
      const v = words[j];
      if (verbs.test(v)) return true;
      if (v === "--" && subcommandSeen) return false;
      if (v.startsWith("-") || words[j - 1].startsWith("-")) continue;
      if (NOT_INSTALL.test(v)) return false;
      subcommandSeen = true;
    }
    return false;
  });
}
function hiddenInstall(segment, tool) {
  const scan = stripQuotedStrings(segment, tool).replace(/\$\([^)]*\)?|`[^`]*`?/g, "");
  if (INSTALL_PATTERNS.some((p) => p.loose.test(scan))) return true;
  if (anyManagerInstall(tokenize(scan))) return true;
  return commandWordInstall(segment);
}
function commandWordInstall(segment) {
  const words = tokenize(stripPrefixes(segment)).flatMap((w) => w.split(",")).filter(Boolean);
  if (words[0] === "&") words.shift();
  if (words.length < 2) return false;
  if (START_PROCESS.test(words[0])) return anyManagerInstall(words);
  const next = words.slice(1).find((w) => !w.startsWith("-"));
  if (next === void 0) return false;
  if (/^[$`]/.test(words[0])) return ANY_VERB.test(next);
  const verbs = managerVerbs(words[0]);
  return verbs !== void 0 && verbOrHidden(next, verbs);
}
var QUOTED_WORD = /(^|\s)(["'])([^"'\s]+)\2(?=\s|$)/g;
function matchInstall(command) {
  const trimmed = stripPrefixes(command);
  const unquoted = stripPrefixes(command.replace(QUOTED_WORD, "$1$3"));
  for (const text of trimmed === unquoted ? [trimmed] : [trimmed, unquoted]) {
    for (const pattern of INSTALL_PATTERNS) {
      const m = text.match(pattern.regex);
      if (m) return { pattern, head: m[0], args: text.slice(m[0].length) };
    }
  }
  return null;
}
var takesValue = (t, n) => t.value.has(n) || t.pkg.has(n) || t.source.has(n) || t.index.has(n) || t.extra.has(n);
var isIndexFlag = (t, n) => t.index.has(n) || /^--@[^:\s]+:registry$/.test(n);
function splitFlag(token, table) {
  const eq = token.indexOf("=");
  if (token.startsWith("--") && eq > 2) return { name: token.slice(0, eq), inline: token.slice(eq + 1) };
  const short = token.slice(0, 2);
  if (/^-[A-Za-z]./.test(token) && takesValue(table, short)) return { name: short, inline: token.slice(2) };
  return { name: token };
}
function createPackage(token) {
  if (NPM_NON_REGISTRY.test(token)) return token;
  const scoped = token.match(/^(@[^/@]+)(?:\/([^@]+))?(@.*)?$/);
  if (scoped) return `${scoped[1]}/create${scoped[2] ? `-${scoped[2]}` : ""}${scoped[3] ?? ""}`;
  return `create-${token}`;
}
var INDEX_ENV = /(?:^|\s)(?:PIP_(?:EXTRA_)?INDEX_URL|PIP_FIND_LINKS|UV_(?:EXTRA_|DEFAULT_)?INDEX(?:_URL)?|UV_FIND_LINKS|npm_config_registry|YARN_NPM_REGISTRY_SERVER|YARN_REGISTRY|BUN_CONFIG_REGISTRY)=\S*/gi;
var INDEX_VARS = String.raw`(?:PIP_(?:EXTRA_)?INDEX_URL|PIP_FIND_LINKS|PIP_CONFIG_FILE|UV_(?:EXTRA_|DEFAULT_)?INDEX(?:_URL)?|UV_FIND_LINKS|UV_CONFIG_FILE|npm_config_(?:registry|userconfig|globalconfig)|YARN_NPM_REGISTRY_SERVER|YARN_REGISTRY|YARN_RC_FILENAME|BUN_CONFIG_REGISTRY)`;
var RC_FILE = String.raw`(?:\.npmrc|\.yarnrc(?:\.yml)?|bunfig\.toml|pip\.ini|pip\.conf)\b`;
var PERSISTENT_CONFIG = [
  /\b(?:(?:config|c)\s+set|npm\s+set|pnpm\s+set)\s+\S*(?:registry|userconfig|globalconfig|index|find-links)\S*/gi,
  // A write into an npm, yarn, bun or pip config file: echo registry=URL > .npmrc, tee -a .yarnrc.yml.
  new RegExp(String.raw`(?:>>?|\btee(?:\s+-a)?)\s*["']?\S*${RC_FILE}`, "gi"),
  // The same through a PowerShell or copy command, up to 8 words before the file: Set-Content -Path '.npmrc', cp x .npmrc.
  new RegExp(String.raw`(?:^|[\s;&|({])(?:set-content|add-content|out-file|sc|ac|cp|copy|copy-item|cpi|mv|move|move-item|mi)(?:\s+[^\s;&|]+){0,8}?\s+["']?[^\s;&|"']*${RC_FILE}`, "gi"),
  // A registry variable set through the Env: drive or .NET: Set-Item Env:npm_config_registry, SetEnvironmentVariable('npm_config_registry'.
  new RegExp(String.raw`(?:(?<!\$)\benv:[\\/]?|SetEnvironmentVariable\(\s*["'])${INDEX_VARS}\b`, "gi")
];
var INDEX_CONFIG = [
  new RegExp(String.raw`\b${INDEX_VARS}\s*=`, "gi"),
  ...PERSISTENT_CONFIG,
  /--(?:userconfig|globalconfig)\b/g,
  /--@[^\s=:]+:registry\b/g
];
function indexConfigMarkers(command, patterns = INDEX_CONFIG) {
  return [...new Set(patterns.flatMap((re) => [...command.matchAll(re)].map((m) => m[0].replace(/\s*=$/, ""))))];
}
var REGISTRY_KEY = /^(?:--?)?(?:@[^:\s]+:)?(?:registry|npmRegistryServer|npmScopes|registries)\b/i;
function registrySet(segment) {
  const words = tokenize(stripPrefixes(segment));
  const manager = commandName(words[0] ?? "");
  const key = words.find((w) => REGISTRY_KEY.test(w));
  return /^(?:npm|pnpm|yarn)$/.test(manager) && words.includes("set") && key ? [`${manager} set ${key.split("=")[0]}`] : [];
}
var RAW_CONFIG_WORD = /(?<![a-z0-9]|[a-z0-9]-)(?:registry|registries|npmRegistryServer|npmScopes|(?:extra-)?index-url|trusted-host|find[-_]links|userconfig|globalconfig|UV_INDEX|UV_DEFAULT_INDEX|PIP_INDEX_URL|PIP_EXTRA_INDEX_URL|PIP_CONFIG_FILE|UV_CONFIG_FILE|npm_config_registry)|\.npmrc|\.yarnrc|bunfig\.toml|pip\.ini|pip\.conf|uv\.toml|\.pypirc/gi;
var RAW_MANAGER = /\b(?:npm|pnpm|yarn|bun|pip\d*|uv|poetry|pdm|conda)\b/i;
var RAW_SET_MANAGER = /\b(?:npm|pnpm)\b/i;
function rawConfigMarkers(command) {
  const text = command.replace(/[\\'"`]/g, "");
  const writes = text.split(/[;&|\r\n]/).filter((seg2) => (
    // Whole shell words only: eslint-config-prettier, set-value and lodash.set are package names, not config writes.
    RAW_MANAGER.test(seg2) && /(?:^|\s)(?:config|c)(?=\s|$)/i.test(seg2) || RAW_SET_MANAGER.test(seg2) && /(?:^|\s)set(?=\s|$)/i.test(seg2)
  ));
  return [.../* @__PURE__ */ new Set([...writes.map((seg2) => seg2.trim().slice(0, 80)), ...[...text.matchAll(RAW_CONFIG_WORD)].map((m) => m[0])])];
}
function persistentConfigMarkers(command, tool, depth = 0) {
  try {
    const { segments, substitutions } = parseExecutable(normalizeEscapes(executableView(command, tool), tool));
    const own = segments.flatMap((seg2) => [...indexConfigMarkers(stripQuotedStrings(seg2, tool), PERSISTENT_CONFIG), ...registrySet(seg2)]);
    if (depth >= 3) return own;
    const nested = [...substitutions, ...wrapperPayloadsFromSegments(segments)];
    return [...own, ...nested.flatMap((text) => persistentConfigMarkers(text, tool, depth + 1))];
  } catch {
    return [...indexConfigMarkers(command, PERSISTENT_CONFIG), ...registrySet(command)];
  }
}
function analyzeInstall(command) {
  const install = matchInstall(command);
  if (!install) return null;
  const { pattern } = install;
  const table = FLAG_TABLES[pattern.flags];
  const out = { pattern, named: [], packages: [], unparsed: [], customIndex: [], ambiguous: [] };
  const add = (raw) => {
    const t = classifyToken(raw, pattern);
    if (t.pkg) {
      out.named.push({ raw, pkg: t.pkg });
      out.packages.push(t.pkg);
    }
    if (t.unparsed) out.unparsed.push(raw);
  };
  for (const m of command.matchAll(INDEX_ENV)) out.customIndex.push(m[0].trim());
  const headWords = tokenize(install.head);
  headWords.forEach((word2, i) => {
    const { name, inline } = splitFlag(word2, table);
    if (isIndexFlag(table, name)) out.customIndex.push(`${name} ${inline ?? headWords[i + 1] ?? ""}`.trim());
  });
  const words = tokenize(install.args);
  const runner = pattern.kind === "first" || pattern.kind === "create";
  let pkgFlagSeen = false;
  let unknownFlag;
  for (let i = 0; i < words.length; i++) {
    const word2 = words[i];
    if (word2.startsWith("-")) {
      const { name, inline } = splitFlag(word2, table);
      const value = inline ?? (takesValue(table, name) ? words[++i] : void 0);
      unknownFlag = value === void 0 && !table.bare.has(name) ? word2 : void 0;
      if (isIndexFlag(table, name)) out.customIndex.push(`${name} ${value ?? ""}`.trim());
      else if (pattern.flags === "node" && (name === "-c" || name === "--call")) out.ambiguous.push(`${name} ${value ?? ""}`.trim());
      else if (table.pkg.has(name) && value !== void 0) {
        pkgFlagSeen = true;
        add(value);
      } else if (table.extra.has(name) && value !== void 0) add(value);
      else if (table.source.has(name) && value !== void 0 && isRemoteSource(value)) out.unparsed.push(value);
      else if (`${word2} ${value ?? ""}`.includes("://")) out.customIndex.push(`${word2} ${value ?? ""}`.trim());
      if (name === "--tag" && value !== void 0) out.tag = value;
      continue;
    }
    if (pattern.kind === "run") break;
    if (runner) {
      if (unknownFlag !== void 0) out.ambiguous.push(`${unknownFlag} ${word2}`);
      else if (!pkgFlagSeen) {
        const before = out.packages.length;
        add(pattern.kind === "create" ? createPackage(word2) : word2);
        const pkg = out.packages[before];
        if (pattern.preferLocal && pkg && !pkg.version && !out.tag && !pkg.name.startsWith("@")) out.localBin = pkg;
      }
      break;
    }
    add(word2);
  }
  return out;
}
function isRemoteSource(token) {
  return /:\/\/|^(?:git|hg|svn|bzr)\+|@|^(?:\\\\|\/\/)/i.test(token);
}
var NPM_NON_REGISTRY = /[:\\]|^[.~/]|\.(?:tgz|tar|tar\.gz)$|^[^@][^/]*\//i;
var NPM_NAME = /^(?:@[\w.~-]+\/)?[\w.~-]+$/;
var ARCHIVE = /\.(?:whl|zip|tgz|tar|tar\.gz|tar\.bz2|tar\.xz)$/i;
function classifyToken(token, pattern) {
  const { ecosystem } = pattern;
  if (ecosystem === "npm") {
    if (NPM_NON_REGISTRY.test(token)) return { unparsed: true };
    const pkg2 = parsePackageToken(token, ecosystem);
    if (pkg2?.version && NPM_NON_REGISTRY.test(pkg2.version)) return { unparsed: true };
    return pkg2 && NPM_NAME.test(pkg2.name) ? { pkg: pkg2 } : { unparsed: true };
  }
  if (ecosystem === "pypi") {
    const spec = pipSpec(token);
    const at = pattern.kind === "first" ? spec.match(/^([A-Za-z0-9_.-]+)@([^:/@]+)$/) : null;
    if (at) return { pkg: { name: at[1], version: at[2] === "latest" ? void 0 : at[2] } };
    if (isRemoteSource(spec) || ARCHIVE.test(spec)) return { unparsed: true };
    if (/^[.~/]|[\\/]/.test(token)) return {};
    const pkg2 = parsePackageToken(token, ecosystem);
    return pkg2 ? { pkg: pkg2 } : { unparsed: true };
  }
  if (pattern.remoteOnly && !token.includes("@")) return {};
  const pkg = parsePackageToken(token, ecosystem);
  return pkg ? { pkg } : { unparsed: true };
}
var BASH_OVERRIDE = /^[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*SKIP_PACKAGE_GUARD=1(?=[ \t]|$)/;
var PS_OVERRIDE = /^\s*\$(?:env|Env|ENV):SKIP_PACKAGE_GUARD=1\s*(?:;|\r?\n)/;
function checkOverride(command) {
  return BASH_OVERRIDE.test(command) || PS_OVERRIDE.test(command);
}
function checkMaliciousPackage(name, version, ecosystem) {
  const ecosystemKey = ecosystem === "pypi" ? "pypi" : "npm";
  if (ecosystemKey !== "pypi" && ecosystemKey !== "npm") {
    return { blocked: false };
  }
  const entry = blocklistIndex(ecosystemKey).get(normalizeName(name, ecosystemKey));
  if (!entry) return { blocked: false };
  version = canonicalVersion(version, ecosystemKey);
  if (entry.blocked_all === true) {
    return {
      blocked: true,
      reason: entry.reason || `Package "${name}" is entirely blocked`
    };
  }
  if (entry.blocked_versions && Array.isArray(entry.blocked_versions)) {
    if (version && entry.blocked_versions.some((v) => canonicalVersion(v, ecosystemKey) === version)) {
      return {
        blocked: true,
        reason: entry.reason || `Version ${version} of "${name}" is known malicious`
      };
    }
    if (!version && entry.blocked_versions.length > 0) {
      return {
        blocked: false,
        warning: `Package "${name}" has known malicious versions: ${entry.blocked_versions.join(", ")}. Ensure you are installing a safe version.`
      };
    }
  }
  return { blocked: false };
}
function normalizeName(name, ecosystem) {
  const lower = name.toLowerCase();
  return ecosystem === "pypi" ? lower.replace(/[-_.]+/g, "-") : lower;
}
var blocklistCache = /* @__PURE__ */ new Map();
function blocklistIndex(ecosystem) {
  let index = blocklistCache.get(ecosystem);
  if (!index) {
    const registry = malicious_packages_default[ecosystem] ?? {};
    index = new Map(Object.entries(registry).map(([k, v]) => [normalizeName(k, ecosystem), v]));
    blocklistCache.set(ecosystem, index);
  }
  return index;
}
function pep440Key(v) {
  return v.toLowerCase().replace(/^v/, "").replace(/^(\d+(?:\.\d+)*)/, (rel) => rel.split(".").map((n) => n.replace(/^0+(?=\d)/, "")).join(".").replace(/(\.0+)+$/, ""));
}
function canonicalVersion(version, ecosystem) {
  if (!version) return void 0;
  if (ecosystem === "pypi") return pep440Key(version);
  const v = version.trim().replace(/^=+/, "").replace(/^v/i, "").replace(/\+.*$/, "");
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v) ? v : void 0;
}
var EXACT_SEMVER = /^\d+\.\d+\.\d+(?:[-+].*)?$/;
async function checkOsvAdvisory(name, version, ecosystem) {
  if (ecosystem !== "pypi" && ecosystem !== "npm") {
    return { blocked: false };
  }
  const osvEcosystem = ecosystem === "pypi" ? "PyPI" : "npm";
  try {
    const known = version !== void 0 && (ecosystem === "pypi" || EXACT_SEMVER.test(version));
    const vulns = await queryOsv(name, known ? version : void 0, osvEcosystem);
    const scope = known ? "" : " The version to install is unknown (no exact version in the command), so this advisory may not apply to it.";
    const malware = vulns.find((v) => v.id?.startsWith("MAL-"));
    if (malware) {
      return {
        blocked: true,
        advisoryId: malware.id,
        warning: `OSV.dev reports malware: ${malware.id}. ${malware.summary || malware.details?.slice(0, 200) || "No details available"}.${scope}`
      };
    }
    const critical = vulns.find((v) => {
      const severity = v.database_specific?.severity || v.severity?.find((s) => s.type === "CVSS_V3")?.score;
      if (typeof severity === "string") return severity === "CRITICAL";
      if (typeof severity === "number") return severity >= 9;
      return false;
    });
    if (critical) {
      return {
        blocked: known,
        ask: !known,
        advisoryId: critical.id,
        warning: `OSV.dev reports CRITICAL vulnerability: ${critical.id}. ${critical.summary || "No summary"}.${scope}`
      };
    }
    const high = vulns.find((v) => {
      const severity = v.database_specific?.severity || v.severity?.find((s) => s.type === "CVSS_V3")?.score;
      if (typeof severity === "string") return severity === "HIGH";
      if (typeof severity === "number") return severity >= 7 && severity < 9;
      return false;
    });
    if (high) {
      return {
        blocked: false,
        advisoryId: high.id,
        warning: `OSV.dev reports HIGH severity vulnerability: ${high.id}. ${high.summary || "No summary"}.${scope}`
      };
    }
    return { blocked: false };
  } catch {
    return { blocked: false };
  }
}
function queryOsv(name, version, ecosystem) {
  return new Promise((resolve2) => {
    const body = {
      package: { name, ecosystem }
    };
    if (version) {
      body.version = version;
    }
    const postData = JSON.stringify(body);
    const timer = setTimeout(() => resolve2([]), 5e3);
    const req = https.request(
      {
        hostname: "api.osv.dev",
        path: "/v1/query",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData)
        },
        timeout: 5e3
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          clearTimeout(timer);
          try {
            const json = JSON.parse(data);
            resolve2(json.vulns || []);
          } catch {
            resolve2([]);
          }
        });
      }
    );
    req.on("error", () => {
      clearTimeout(timer);
      resolve2([]);
    });
    req.on("timeout", () => {
      req.destroy();
      clearTimeout(timer);
      resolve2([]);
    });
    req.write(postData);
    req.end();
  });
}
async function checkPackageAge(name, ecosystem, requestedVersion) {
  if (ecosystem !== "pypi" && ecosystem !== "npm") {
    return { ageHours: null, blocked: false };
  }
  try {
    const publishDate = await fetchPublishDate(name, ecosystem, requestedVersion);
    if (!publishDate) {
      return { ageHours: null, blocked: false };
    }
    const ageMs = Date.now() - publishDate.getTime();
    const ageHours = ageMs / (1e3 * 60 * 60);
    if (ageHours < 24) {
      return {
        ageHours,
        blocked: true,
        warning: `Package "${name}" was published less than 24 hours ago (${Math.round(ageHours)}h). This is suspicious for supply-chain attacks.`
      };
    }
    if (ageHours < 168) {
      const ageDays = Math.round(ageHours / 24);
      return {
        ageHours,
        blocked: false,
        warning: `Package "${name}" was published ${ageDays} day(s) ago. Proceed with caution.`
      };
    }
    return { ageHours, blocked: false };
  } catch {
    return { ageHours: null, blocked: false, error: "Registry check failed (network)" };
  }
}
function publishDateFromRegistryJson(json, ecosystem, requestedVersion) {
  const doc = json;
  if (!doc) return null;
  if (ecosystem === "pypi") {
    const exact2 = requestedVersion && /^v?\d+(\.\d+)*((a|b|rc)\d+)?(\.post\d+)?(\.dev\d+)?$/i.test(requestedVersion) ? requestedVersion.replace(/^v/, "") : void 0;
    const norm = pep440Key;
    const releaseKey = exact2 ? doc.releases?.[exact2] ? exact2 : Object.keys(doc.releases ?? {}).find((k) => norm(k) === norm(exact2)) : void 0;
    const version2 = releaseKey ?? doc.info?.version;
    let newest = null;
    for (const file of doc.releases?.[version2] ?? []) {
      const d = file?.upload_time_iso_8601 ? new Date(file.upload_time_iso_8601) : null;
      if (d && !Number.isNaN(d.getTime()) && (!newest || d > newest)) newest = d;
    }
    return newest;
  }
  const exact = requestedVersion && /^v?\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(requestedVersion) ? requestedVersion.replace(/^v/, "") : void 0;
  const tags = doc["dist-tags"] ?? {};
  const tagged = requestedVersion && Object.prototype.hasOwnProperty.call(tags, requestedVersion) ? tags[requestedVersion] : void 0;
  let version = exact && doc.time?.[exact] ? exact : tagged ?? tags.latest;
  if (!exact && tagged === void 0 && requestedVersion && /\d/.test(requestedVersion) && requestedVersion.includes("-")) {
    version = newestNpmVersion(doc.time) ?? version;
  }
  const timeEntry = doc.time?.[version];
  return timeEntry ? new Date(timeEntry) : null;
}
function newestNpmVersion(time) {
  let best;
  for (const [v, t] of Object.entries(time ?? {})) {
    if (v === "created" || v === "modified" || Number.isNaN(Date.parse(t))) continue;
    if (!best || Date.parse(t) > Date.parse(time[best])) best = v;
  }
  return best;
}
function fetchPublishDate(name, ecosystem, requestedVersion) {
  return new Promise((resolve2) => {
    const url = ecosystem === "pypi" ? `https://pypi.org/pypi/${encodeURIComponent(name)}/json` : `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    const timer = setTimeout(() => {
      resolve2(null);
    }, 5e3);
    const req = https.get(url, { timeout: 5e3 }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        clearTimeout(timer);
        try {
          resolve2(publishDateFromRegistryJson(JSON.parse(data), ecosystem, requestedVersion));
        } catch {
          resolve2(null);
        }
      });
    });
    req.on("error", () => {
      clearTimeout(timer);
      resolve2(null);
    });
    req.on("timeout", () => {
      req.destroy();
      clearTimeout(timer);
      resolve2(null);
    });
  });
}
function stripEnvPrefix(command) {
  return command.replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)*/, "");
}
function tokenize(command) {
  const tokens = [];
  let current = "";
  let inQuote = null;
  for (const ch of command) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "	") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}
function parsePackageToken(token, ecosystem) {
  if (ecosystem === "pypi") {
    const match = pipSpec(token).match(/^([a-zA-Z0-9_.-]+)(?:\[.*?\])?(?:[=<>~!]+(.+))?$/);
    if (match) {
      return { name: match[1], version: match[2] || void 0 };
    }
  } else if (ecosystem === "npm") {
    if (token.startsWith("@")) {
      const lastAt = token.lastIndexOf("@");
      if (lastAt > 0) {
        const name = token.slice(0, lastAt);
        const version = token.slice(lastAt + 1);
        if (name.includes("/")) {
          return { name, version: version || void 0 };
        }
      }
      return { name: token, version: void 0 };
    } else {
      const atIdx = token.indexOf("@");
      if (atIdx > 0) {
        return { name: token.slice(0, atIdx), version: token.slice(atIdx + 1) || void 0 };
      }
      return { name: token, version: void 0 };
    }
  } else if (ecosystem === "go") {
    const atIdx = token.indexOf("@");
    if (atIdx > 0) {
      return { name: token.slice(0, atIdx), version: token.slice(atIdx + 1) };
    }
    return { name: token, version: void 0 };
  } else if (ecosystem === "composer") {
    const colonIdx = token.indexOf(":");
    if (colonIdx > 0) {
      return { name: token.slice(0, colonIdx), version: token.slice(colonIdx + 1) };
    }
    return { name: token, version: void 0 };
  } else {
    return { name: token, version: void 0 };
  }
  return null;
}
function outputAllowWithAdvisory(advisory) {
  const output = {
    hookSpecificOutput: {
      additionalContext: advisory
    }
  };
  console.log(JSON.stringify(output));
}
function outputAllowOk() {
  outputContinue();
}
function readStdin() {
  return readFileSync(0, "utf-8");
}
var OVERRIDE = "To override: prefix command with SKIP_PACKAGE_GUARD=1";
function asksFor(segment, install, cwd, tool) {
  if (!install) {
    return [`Install command the guard cannot parse: "${segment.slice(0, 200)}". No package check ran. Run it as a plain install (no wrapper or leader) or confirm it.`];
  }
  const asks = [];
  const { pattern } = install;
  const commandWord = stripPrefixes(segment).split(/\s/)[0];
  if (tool !== "PowerShell" && commandWord.startsWith("$")) {
    asks.push(`The command word is an unquoted variable (${commandWord}). Bash splits its value into words, so it may run another program. Quote it ("$VAR") or confirm it.`);
  }
  if (pattern.kind === "lockfile" && cwd === null) {
    asks.push("Lockfile install in a folder the guard cannot vouch for (a cd, a folder option or an expansion in the command). Nothing pinned to check.");
  } else if (pattern.kind === "lockfile" && cwd !== null && !["package-lock.json", "npm-shrinkwrap.json"].some((f) => existsSync(join2(cwd, f)))) {
    asks.push(`Lockfile install with no package-lock.json in ${cwd}. Nothing pinned to check.`);
  }
  if (install.unparsed.length > 0) {
    asks.push(`Non-registry source: ${install.unparsed.join(", ")}. A URL, VCS, github:, user/repo, path or tarball install skips the blocklist, OSV and age checks.`);
  }
  if (install.customIndex.length > 0) {
    asks.push(`Custom package index: ${install.customIndex.join(", ")}. The checks read the public PyPI or npm registry, not this index.`);
  }
  if (install.ambiguous.length > 0) {
    asks.push(`Runner flag the guard cannot read: ${install.ambiguous.join(", ")}. The flag may take the next word as its value, so the package that runs is not known.`);
  }
  if (pattern.ecosystem !== "pypi" && pattern.ecosystem !== "npm") {
    const names = install.packages.map((p) => p.name).join(", ") || segment.slice(0, 200);
    asks.push(`No blocklist, OSV or age check exists for ${pattern.ecosystem} packages: ${names}.`);
  }
  return asks;
}
var LOCAL_BIN_MAX_LEVELS = 10;
function hasLocalBin(name, cwd) {
  let dir = resolve(cwd);
  for (let level = 0; level < LOCAL_BIN_MAX_LEVELS; level++) {
    if (existsSync(join2(dir, "package.json")) || existsSync(join2(dir, "node_modules"))) {
      try {
        return statSync(join2(dir, "node_modules", ".bin", name)).isFile();
      } catch {
        return false;
      }
    }
    const parent = dirname2(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}
async function checkInstall(segment, cwd, tool) {
  const install = analyzeInstall(segment);
  const asks = asksFor(segment, install, cwd, tool);
  const advisories = [];
  const ecosystem = install?.pattern.ecosystem;
  if (ecosystem !== "pypi" && ecosystem !== "npm") return { asks, advisories };
  const trailingAt = /\S@(?=\s|$)/.test(segment);
  const packages = install.packages.filter((p) => p !== install.localBin || cwd === null || trailingAt || !hasLocalBin(p.name, cwd));
  for (const pkg of packages) {
    const typo = checkTyposquat(pkg.name, ecosystem);
    if (typo.isTyposquat) {
      return { asks, advisories, deny: `PACKAGE SECURITY: Suspected typosquat. "${pkg.name}" looks like "${typo.similarTo}". ${typo.reason}. Package: ${pkg.name}. ${OVERRIDE}` };
    }
    const malCheck = checkMaliciousPackage(pkg.name, pkg.version, ecosystem);
    if (malCheck.blocked) {
      return { asks, advisories, deny: `PACKAGE SECURITY: Known malicious package/version. ${malCheck.reason}. Package: ${pkg.name}${pkg.version ? "@" + pkg.version : ""}. ${OVERRIDE}` };
    }
    if (malCheck.warning) advisories.push(malCheck.warning);
  }
  const unpinned = unpinnedPipPackages(segment);
  if (unpinned.length > 0) {
    return { asks, advisories, deny: `PACKAGE SECURITY: Unpinned pip install. Every pip install needs an exact == pin. Unpinned: ${unpinned.join(", ")}. Pin each one, for example ${unpinned[0]}==<version>, with a version at least 7 days old on PyPI.` };
  }
  for (const pkg of packages) {
    const raw = install.named.find((n) => n.pkg === pkg)?.raw ?? "";
    const osvVersion = ecosystem === "pypi" && !EXACT_PIN.test(pipSpec(raw)) ? void 0 : pkg.version;
    const osvResult = await checkOsvAdvisory(pkg.name, osvVersion, ecosystem);
    if (osvResult.blocked) {
      return { asks, advisories, deny: `PACKAGE SECURITY: ${osvResult.warning} Advisory: ${osvResult.advisoryId}. Package: ${pkg.name}${pkg.version ? "@" + pkg.version : ""}. ${OVERRIDE}` };
    }
    if (osvResult.ask) asks.push(`${osvResult.warning} Advisory: ${osvResult.advisoryId}. Package: ${pkg.name}${pkg.version ? "@" + pkg.version : ""}. Pin an exact version to check it, or confirm.`);
    else if (osvResult.warning) advisories.push(`OSV ADVISORY: ${osvResult.warning}`);
    const ageResult = await checkPackageAge(pkg.name, ecosystem, pkg.version ?? install.tag);
    if (ageResult.blocked) {
      return { asks, advisories, deny: `PACKAGE SECURITY: ${ageResult.warning} Package: ${pkg.name}. ${OVERRIDE}` };
    }
    if (ageResult.warning) advisories.push(`PACKAGE ADVISORY: ${ageResult.warning}`);
  }
  return { asks, advisories };
}
async function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch (err) {
    logGuardError("package-install-guard", err);
    outputContinue();
    return;
  }
  const shell = readShellCommand(input);
  if (shell.kind === "not-shell") {
    outputContinue();
    return;
  }
  if (shell.kind === "unreadable") {
    const reason = `PACKAGE SECURITY: Unreadable command text. ${shell.tool} has no string field "${shell.field}", so the install check cannot run.`;
    logGuardDecision("package-install-guard", input, "deny", "unreadable command text", { command: shell.tool });
    outputDeny(reason);
    return;
  }
  const command = shell.text;
  if (!command) {
    outputContinue();
    return;
  }
  const payloadCwd = /desktop-commander/i.test(String(input.tool_name)) ? null : typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const plans = shell.dialects.flatMap((dialect) => installPlans(command, dialect, localBinCwd(command, payloadCwd)));
  const installs = plans.filter((p, i) => plans.findIndex((q) => q.segment === p.segment && q.cwd === p.cwd) === i);
  const wholeOverride = PS_OVERRIDE.test(command);
  const checked = installs.filter(({ segment }) => !wholeOverride && !checkOverride(segment));
  if (checked.length < installs.length) {
    logGuardDecision("package-install-guard", input, "override", "SKIP_PACKAGE_GUARD", { command });
  }
  if (checked.length === 0) {
    const persistent = installs.length === 0 && !wholeOverride && !checkOverride(command) ? [...new Set(shell.dialects.flatMap((dialect) => persistentConfigMarkers(command, dialect)))] : [];
    if (persistent.length === 0) {
      outputContinue();
      return;
    }
    const decision = isUnattended(input) ? "deny" : "ask";
    logGuardDecision("package-install-guard", input, decision, "persistent registry config", { command });
    outputDeny(`PACKAGE SECURITY: Registry or index change that persists for later installs: ${persistent.join(", ")}. The checks read the public PyPI or npm registry, not this one. ${OVERRIDE}`, decision);
    return;
  }
  const advisories = [];
  const asks = [];
  for (const { segment, cwd, tool } of checked) {
    const result = await checkInstall(segment, cwd, tool);
    if (result.deny) {
      logGuardDecision("package-install-guard", input, "deny", result.deny.replace(/^PACKAGE SECURITY:\s*/, "").split(/\.\s/)[0], { command });
      outputDeny(result.deny);
      return;
    }
    asks.push(...result.asks);
    advisories.push(...result.advisories);
  }
  const config = [.../* @__PURE__ */ new Set([...indexConfigMarkers(command), ...shell.dialects.flatMap((dialect) => persistentConfigMarkers(command, dialect)), ...rawConfigMarkers(command)])];
  if (config.length > 0 && !asks.some((a) => a.startsWith("Custom package index"))) {
    asks.push(`Custom package index or config in the command: ${config.join(", ")}. The checks read the public PyPI or npm registry, not this index.`);
  }
  if (asks.length > 0) {
    const decision = isUnattended(input) ? "deny" : "ask";
    logGuardDecision("package-install-guard", input, decision, asks[0].split(/\.\s/)[0], { command });
    outputDeny(`PACKAGE SECURITY: ${asks.join(" ")} ${OVERRIDE}`, decision);
    return;
  }
  if (advisories.length > 0) {
    outputAllowWithAdvisory(advisories.join("\n"));
  } else {
    outputAllowOk();
  }
}
if (!process.env.VITEST) {
  main().catch((err) => {
    logGuardError("package-install-guard", err);
    outputContinue();
  });
}
export {
  checkMaliciousPackage,
  checkOsvAdvisory,
  checkOverride,
  checkPackageAge,
  extractPackageNames,
  installPlans,
  installSegments,
  isPackageInstallCommand,
  parseEcosystem,
  publishDateFromRegistryJson,
  unpinnedPipPackages
};
