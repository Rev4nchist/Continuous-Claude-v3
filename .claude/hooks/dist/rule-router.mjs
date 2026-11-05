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

// src/shared/destructive-classifier.ts
var abbrev = (word, min) => word.slice(0, min) + [...word.slice(min)].reduceRight((rest, c) => `(?:${c}${rest})?`, "");
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
function extractShellWrapperPayloads(command) {
  try {
    return wrapperPayloadsFromSegments(parseExecutable(command).segments);
  } catch {
    return [];
  }
}
var INTERPRETERS = [
  { word: /(?<![\w.-])(?:bash|sh|zsh|dash|ksh|ash)(?:\.exe)?\b/i, flag: new RegExp(POSIX_EXEC_FLAG) },
  { word: /(?<![\w.-])(?:pwsh|powershell)(?:\.exe)?\b/i, flag: new RegExp(PWSH_EXEC_FLAG, "i") },
  { word: /(?<![\w.-])cmd(?:\.exe)?\b/i, flag: /\s\/[ck](?=\s|["']|$)/i }
];

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
  } catch (err) {
    logGuardError("rule-router", err);
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
  } catch (err) {
    logGuardError("rule-router", err);
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
