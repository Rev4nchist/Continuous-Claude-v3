import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/lib/trace-boot.ts
import fs from "fs";
import { homedir } from "os";
import { basename, join, resolve, sep } from "path";
import { syncBuiltinESMExports } from "module";

// src/shared/guard-log.ts
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
function guardSource(env) {
  const named = env.CCV3_GUARD_SOURCE;
  if (named === "test" || named === "probe") return named;
  if (Object.hasOwn(env, "VITEST")) return "test";
  return env.CCV3_GUARD_DECISIONS_LOG ? "probe" : "live";
}
var MARK_OPEN = String.fromCharCode(57344);
var MARK_CLOSE = String.fromCharCode(57345);
var UUID_MARK = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "g");
var PATH_MASKS = [
  ...MASKS.slice(0, -1),
  [/\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}/g, "***"]
];

// src/lib/trace-boot.ts
var TRACE_MARKER = "__CCV3_HOOK_TRACE_V1__";
var HOT_PROGRAMS = [
  "architecture-stats-sync",
  "commit-preflight",
  "decision-gate",
  "destructive-command-guard",
  "git-commit-roadmap",
  "hook-health-monitor",
  "identity-probe",
  "lane-agent-tag",
  "lane-board-republish-reminder",
  "lane-context",
  "mcp-activity-tracker",
  "msys-crash-capture",
  "package-install-guard",
  "periodic-extract",
  "pr-opened-review-loop",
  "pre-pr-gate",
  "roadmap-completion",
  "roadmap-reconcile",
  "rule-router",
  "scan-scope-guard",
  "session-register",
  "session-start-context-loaders",
  "session-start-continuity",
  "session-start-docker",
  "session-start-init-check",
  "session-start-intel-prune",
  "session-start-memory-loaders",
  "smarter-everyday",
  "test-run-tracker"
];
var DAY_CAP_BYTES = 32 * 1024 * 1024;
var PRUNE_DAYS = 10;
var STDIN_KEEP = 64 * 1024;
var STDOUT_KEEP = 8 * 1024;
var ERROR_MAX = 120;
function traceModeFrom(env, modeText) {
  if (env.CCV3_HOOK_TRACE === "0") return "off";
  const t = (modeText ?? "").trim().toLowerCase();
  return t === "off" || t === "all" ? t : "hot";
}
function readTraceMode(env, read = (p) => fs.readFileSync(p, "utf8")) {
  let text = null;
  try {
    text = read(env.CCV3_HOOK_TRACE_MODE_FILE || join(homedir(), ".claude", "state", "hook-trace-mode"));
  } catch {
  }
  return traceModeFrom(env, text);
}
function shouldTrace(name, mode) {
  return mode === "all" || mode === "hot" && HOT_PROGRAMS.includes(name);
}
var realPath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return resolve(p);
  }
};
var caseKey = (p) => process.platform === "win32" ? p.toLowerCase() : p;
function underLiveDist(script, home) {
  if (!script) return false;
  try {
    return caseKey(realPath(script)).startsWith(caseKey(realPath(join(home, ".claude", "hooks", "dist"))) + sep);
  } catch {
    return false;
  }
}
function traceSource(env, script = process.argv[1], home = homedir()) {
  const g = guardSource(env);
  if (g !== "live") return g;
  if (env.CCV3_HOOK_TRACE_DIR) return "probe";
  return underLiveDist(script, home) ? "live" : "probe";
}
var traceDir = (env) => env.CCV3_HOOK_TRACE_DIR || join(homedir(), ".claude", "cache");
var SESSION_ID = /^[A-Za-z0-9._:-]{1,100}$/;
var EVENT_NAME = /^[A-Za-z]{1,40}$/;
var TOOL_NAME = /^[\w.:-]{1,100}$/;
var pick = (v, re) => typeof v === "string" && re.test(v) ? v : null;
function extractPayloadFields(text) {
  try {
    const o = JSON.parse(text);
    if (o && typeof o === "object" && !Array.isArray(o)) {
      return { sessionId: pick(o.session_id, SESSION_ID), event: pick(o.hook_event_name, EVENT_NAME), tool: pick(o.tool_name, TOOL_NAME) };
    }
  } catch {
  }
  const key = (k, re) => pick(new RegExp(`"${k}"\\s*:\\s*"([^"\\\\]{1,100})"`).exec(text)?.[1], re);
  return { sessionId: key("session_id", SESSION_ID), event: key("hook_event_name", EVENT_NAME), tool: key("tool_name", TOOL_NAME) };
}
function classifyObject(o) {
  const hso = o.hookSpecificOutput ?? {};
  const pd = hso.permissionDecision ?? o.permissionDecision;
  if (pd === "deny" || pd === "ask" || pd === "allow") return pd;
  if (o.decision === "block" || o.result === "block") return "block";
  if (typeof hso.additionalContext === "string") return "inject";
  if (typeof o.systemMessage === "string") return "message";
  return "none";
}
function classifyOut(text) {
  const t = text.trim();
  if (!t) return "none";
  try {
    const o = JSON.parse(t);
    return o && typeof o === "object" && !Array.isArray(o) ? classifyObject(o) : "none";
  } catch {
  }
  const pd = /"permissionDecision"\s*:\s*"(deny|ask|allow)"/.exec(t)?.[1];
  if (pd) return pd;
  if (/"decision"\s*:\s*"block"/.test(t)) return "block";
  if (/"additionalContext"\s*:/.test(t)) return "inject";
  if (/"systemMessage"\s*:/.test(t)) return "message";
  return "none";
}
var ERROR_WORD = /^[A-Za-z0-9_.]{1,40}$/;
var ERROR_CODE = /^[A-Za-z0-9_]{1,40}$/;
function maskError(err) {
  if (!(err instanceof Error)) return typeof err;
  try {
    const rawName = err.name;
    const name = typeof rawName === "string" && ERROR_WORD.test(rawName) ? rawName : "Error";
    const code = err.code;
    return (typeof code === "string" && ERROR_CODE.test(code) ? `${name}/${code}` : name).slice(0, ERROR_MAX);
  } catch {
    return "Error";
  }
}
var round1 = (n) => Math.round(n * 10) / 10;
function buildRow(i) {
  return {
    ts: i.ts.toISOString(),
    name: i.name,
    event: i.event,
    tool: i.tool,
    startupMs: round1(i.startupMs),
    durationMs: round1(i.durationMs),
    exitCode: i.code === 0 ? 0 : 1,
    code: i.code,
    sessionId: i.sessionId,
    out: i.out,
    error: i.error,
    source: i.source
  };
}
var DAY_FILE = /^hook-trace-(\d{4}-\d{2}-\d{2})\.(?:jsonl|dropped)$/;
function pruneOld(dir, day, days) {
  const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - days * 864e5).toISOString().slice(0, 10);
  for (const f of fs.readdirSync(dir)) {
    const m = DAY_FILE.exec(f);
    if (m && m[1] < cutoff) {
      try {
        fs.unlinkSync(join(dir, f));
      } catch {
      }
    }
  }
}
function bumpDropped(file) {
  let n = 0;
  try {
    n = Number(JSON.parse(fs.readFileSync(file, "utf8")).dropped) || 0;
  } catch {
  }
  fs.writeFileSync(file, `${JSON.stringify({ dropped: n + 1, ts: (/* @__PURE__ */ new Date()).toISOString() })}
`);
}
function appendTraceRow(row, opts = {}) {
  try {
    const dir = opts.dir ?? traceDir(process.env);
    const day = row.ts.slice(0, 10);
    const file = join(dir, `hook-trace-${day}.jsonl`);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      fs.mkdirSync(dir, { recursive: true });
      try {
        pruneOld(dir, day, opts.pruneDays ?? PRUNE_DAYS);
      } catch {
      }
    }
    if (size >= (opts.capBytes ?? DAY_CAP_BYTES)) {
      bumpDropped(join(dir, `hook-trace-${day}.dropped`));
      return "dropped";
    }
    fs.appendFileSync(file, `${JSON.stringify(row)}
`);
    return "written";
  } catch {
    return "error";
  }
}
var keep = (cur, chunk, max) => {
  if (cur.length >= max) return cur;
  const s = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "";
  return cur + s.slice(0, max - cur.length);
};
function lazyTap(name, onStream) {
  const d = Object.getOwnPropertyDescriptor(process, name);
  if (!d || !d.get || !d.configurable) return;
  const orig = d.get;
  let seen;
  Object.defineProperty(process, name, {
    configurable: true,
    enumerable: d.enumerable,
    get() {
      const s = orig.call(this);
      if (s && s !== seen) {
        seen = s;
        try {
          onStream(s);
        } catch {
        }
      }
      return s;
    }
  });
}
function bootTrace(env = process.env, _bootCall) {
  try {
    if (!process.argv[1]) return;
    const name = basename(process.argv[1], ".mjs");
    if (!shouldTrace(name, readTraceMode(env))) return;
    const startupMs = process.uptime() * 1e3;
    const t0 = performance.now();
    const state = { v: 1, stdinTouched: false, stdoutTouched: false };
    globalThis[TRACE_MARKER] = state;
    let stdinText = "";
    let stdoutText = "";
    let errText = null;
    const rawRead = fs.readFileSync;
    fs.readFileSync = function(...args) {
      const r = rawRead.apply(this, args);
      try {
        if (args[0] === 0 || args[0] === "/dev/stdin") stdinText = keep(stdinText, r, STDIN_KEEP);
      } catch {
      }
      return r;
    };
    try {
      Object.defineProperty(fs.readFileSync, "name", { value: "readFileSync", configurable: true });
      Object.defineProperty(fs.readFileSync, "length", { value: 2, configurable: true });
    } catch {
    }
    syncBuiltinESMExports();
    lazyTap("stdin", (s) => {
      state.stdinTouched = true;
      const emit = s.emit;
      s.emit = function(ev, chunk) {
        if (ev === "data") {
          try {
            stdinText = keep(stdinText, chunk, STDIN_KEEP);
          } catch {
          }
        }
        return emit.apply(this, arguments);
      };
    });
    lazyTap("stdout", (s) => {
      state.stdoutTouched = true;
      const write = s.write;
      s.write = function(chunk) {
        try {
          stdoutText = keep(stdoutText, chunk, STDOUT_KEEP);
        } catch {
        }
        return write.apply(this, arguments);
      };
    });
    process.on("uncaughtExceptionMonitor", (err) => {
      try {
        errText = maskError(err);
      } catch {
      }
    });
    process.on("exit", (code) => {
      try {
        const f = extractPayloadFields(stdinText);
        const row = buildRow({
          ts: /* @__PURE__ */ new Date(),
          name,
          event: f.event,
          tool: f.tool,
          startupMs,
          durationMs: performance.now() - t0,
          code: typeof code === "number" ? code : 0,
          sessionId: f.sessionId,
          out: classifyOut(stdoutText),
          error: errText,
          source: traceSource(env, process.argv[1])
        });
        appendTraceRow(row, { dir: traceDir(env) });
      } catch {
      }
    });
  } catch {
  }
}
if (!Object.hasOwn(process.env, "VITEST")) bootTrace(process.env, "__CCV3_HOOK_TRACE_BOOT_V1__");

// src/permission-auto-allow.ts
import { readFileSync } from "node:fs";

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
var POWERSHELL_PATTERNS = [
  { name: "PowerShell recursive delete (Remove-Item -Recurse)", re: /(?:^|[;|&({]|\s)(?:Remove-Item|ri|rm|rmdir|rd|del|erase)\b[^;|&\n]*\s-(?:r|rec|recurse)\w*\b/i },
  { name: "PowerShell recursive delete ([IO.Directory]::Delete $true)", re: /\[(?:System\.)?IO\.Directory\]::Delete\([^)]*,\s*\$true\s*\)/i },
  // F06. A second argument that is not literally $false ($r, 1, (1 -eq 1)) can be true.
  { name: "PowerShell [IO.Directory]::Delete with a recurse argument", re: /\[(?:System\.)?IO\.Directory\]::Delete\((?:[^(),;\n]|\([^()\n]*\))*,\s*(?!\$false\s*\))[^\s)]/i },
  // F06. A splat (`Remove-Item @p`) hides -Recurse inside a hashtable; the guard cannot see it.
  { name: "PowerShell splatted delete (Remove-Item @args)", re: /(?<![\w-])(?:Remove-Item|ri|rm|rmdir|rd|del|erase)\b[^;|&\n]*\s@\w/i },
  // F06. A pipe into a delete removes every item the left side yields (parity with `xargs rm`).
  { name: "PowerShell pipe into delete (| Remove-Item)", re: /\|\s*(?:Remove-Item|ri|rm|rmdir|rd|del|erase)\b/i }
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
    if (c === "&" && next === ">") {
      seg2 += i > 0 && !/\s/.test(command[i - 1]) ? " &" : "&";
      i++;
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
  { shell: "cmd", re: wrapper("cmd(?:\\.exe)?", String.raw`\s\/[ck]\b`) },
  { shell: "eval", re: new RegExp(`^${LAUNCHER}eval(?=\\s)${PAYLOAD}`, "i") }
];
function unwrapPayload(raw) {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(["`$\\])/g, "$1");
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}
var dropQuotes = (s) => s.replace(/["']/g, "");
function matchWrapper(segment, tool = "Bash") {
  const seg2 = stripRedirects(segment, tool);
  for (const { shell, re } of WRAPPER_RES) {
    const m = seg2.match(re);
    if (!m || !(m[1] || m[3])) continue;
    if (!m[1]) {
      const dequote = shell === "posix" || shell === "eval" || /^["']/.test(m[3]);
      return { payload: dequote ? dropQuotes(m[3]) : unwrapPayload(m[3]), shell };
    }
    if (!m[2]?.trim()) return { payload: unwrapPayload(m[1]), shell };
    const join2 = shell === "posix" ? " ; " : " ";
    return { payload: unwrapPayload(m[1]) + join2 + dropQuotes(m[2]), shell };
  }
  return null;
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
var INTERPRETERS = [
  { word: /(?<![\w.-])(?:bash|sh|zsh|dash|ksh|ash)(?:\.exe)?\b/i, flag: new RegExp(POSIX_EXEC_FLAG) },
  { word: /(?<![\w.-])(?:pwsh|powershell)(?:\.exe)?\b/i, flag: new RegExp(PWSH_EXEC_FLAG, "i") },
  { word: /(?<![\w.-])cmd(?:\.exe)?\b/i, flag: /\s\/[ck](?=\s|["']|$)/i }
];
function runsInterpreter(stripped) {
  return INTERPRETERS.some(({ word, flag }) => {
    const at = stripped.search(word);
    return at >= 0 && flag.test(stripped.slice(at));
  });
}
function afterExecFlag(text) {
  for (const { word, flag } of INTERPRETERS) {
    const at = text.search(word);
    const m = at >= 0 ? flag.exec(text.slice(at)) : null;
    if (m) return text.slice(at + m.index + m[0].length);
  }
  return null;
}
function classifyInterpreterSegments(segments, tool) {
  for (const seg2 of segments) {
    if (!runsInterpreter(stripQuotedStrings(seg2, tool))) continue;
    const dequoted = normalizeGitGlobalOptions(dropQuotes(seg2));
    for (const p of [...DESTRUCTIVE_PATTERNS, ...POWERSHELL_PATTERNS]) if (p.re.test(dequoted)) return p.name;
    const payload = afterExecFlag(dequoted);
    if (payload !== null) {
      for (const p of SEGMENT_PATTERNS) if (p.re.test(payload)) return p.name;
    }
  }
  return null;
}
var REDIR_OPS = String.raw`&>>?|<<<|>>|>\||>&|<&|<>|>(?!\()|(?<!<)<(?![<(])`;
var redirectRegex = (tool) => {
  const ps = tool === "PowerShell";
  const quoted = (ps ? PS_QUOTED : BASH_QUOTED).source;
  const plain = ps ? String.raw`(?:[^\s;&|<>()'"\x60$]|\$(?![({]))` : String.raw`(?:[^\s;&|<>()'"\\\x60$]|\$(?![({]))`;
  const fd = String.raw`(?:(?<![^\s;&|(])${ps ? String.raw`(?:\d+|\*)` : String.raw`(?:\d+|\{\w+\})`})?`;
  const subst = String.raw`\$\((?:[^()]|\([^()]*\)){0,300}\)|\$\{[^{}\s]*\}` + (ps ? "" : "|`[^`]{0,300}`");
  return new RegExp(`(${quoted})|${fd}(?:${REDIR_OPS})[ \\t]*(?=((?:${quoted}|${subst}|${plain})+))\\2(?![$\\x60(])`, "g");
};
var REDIRECT_RES = { Bash: redirectRegex("Bash"), PowerShell: redirectRegex("PowerShell") };
var heredocRegex = (tool) => {
  const quoted = (tool === "PowerShell" ? PS_QUOTED : BASH_QUOTED).source;
  return new RegExp(String.raw`(${quoted})|(?<!<)<<(?!<)-?[ \t]*(?:\\?\w+|${quoted})(?=[ \t]+[^\s;&|<>])`, "g");
};
var HEREDOC_RES = { Bash: heredocRegex("Bash"), PowerShell: heredocRegex("PowerShell") };
function stripRedirects(text, tool = "Bash") {
  const key = tool === "PowerShell" ? "PowerShell" : "Bash";
  const keepQuoted = (m, quoted) => quoted !== void 0 ? quoted : " ";
  return text.replace(REDIRECT_RES[key], keepQuoted).replace(HEREDOC_RES[key], keepQuoted);
}
var UNPARSED_REDIRECT_RE = new RegExp(
  String.raw`(${BASH_QUOTED.source})|[<>][ \t]*(?:[^\s;&|<>()'"\\\x60$]|\$(?![({]))*(?:\$[({]|\x60|[<>]\()`,
  "g"
);
var GUARDED_VERBS = [
  [/(?<![-\w.])(?:rm|rmdir|rd|del|erase|ri|find|xargs|rsync|dd|shred|wipefs|blkdiscard|truncate|Remove-Item)(?![-\w])|\bmkfs\b/i],
  [/\bgit\b/i, /\b(?:reset|clean|push|checkout|restore|switch|branch|worktree|submodule|rebase|stash|update-ref|reflog|gc|filter-branch|filter-repo)\b/i],
  [/\bdocker(?:-compose)?\b/i, /\b(?:prune|rm|rmi|down)\b/i],
  [/\b(?:az|fab|curl|irm|iwr)(?:\.exe|\.cmd)?\b|\bInvoke-\w+|\b(?:Suspend|Resume|Update|Remove)-AzFabricCapacity\b/i, /capacit|dataAccessRoles/i]
];
function unparsedRedirect(bare) {
  let found = false;
  bare.replace(UNPARSED_REDIRECT_RE, (m, quoted) => {
    if (quoted === void 0) found = true;
    return m;
  });
  if (!found || !GUARDED_VERBS.some((words) => words.every((w) => w.test(bare)))) return null;
  return "unparsed redirect target";
}
function classifyDestructive(command, depth = 0, tool = "Bash") {
  const hit = classifyText(command, depth, tool);
  if (hit || typeof command !== "string") return hit;
  const joined = normalizeEscapes(command, tool);
  const variants = joined === command ? [command] : [command, joined];
  if (variants.length > 1) {
    const joinedHit = classifyText(joined, depth, tool);
    if (joinedHit) return joinedHit;
  }
  if (!/[<>]/.test(command)) return null;
  let lastBare = command;
  for (const text of variants) {
    const bare = stripRedirects(text, tool);
    if (bare === text) continue;
    lastBare = bare;
    const bareHit = classifyText(bare, depth, tool);
    if (bareHit) return bareHit;
  }
  return unparsedRedirect(lastBare);
}
function classifyText(command, depth, tool) {
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
      const wrapped = segments.map((s) => matchWrapper(s, tool));
      const interpHit = classifyInterpreterSegments(segments.filter((_, i) => wrapped[i] === null), tool);
      if (interpHit) return interpHit;
      const payloads = [
        ...wrapped.flatMap((w) => w ? [{ text: w.payload, tool: w.shell === "powershell" ? "PowerShell" : tool }] : []),
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
