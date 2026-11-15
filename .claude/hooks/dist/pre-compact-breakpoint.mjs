#!/usr/bin/env node
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
function maskSecrets(text) {
  return MASKS.reduce((acc, [re, to]) => acc.replace(re, to), text);
}
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
  "file-claims",
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
    let size2 = 0;
    try {
      size2 = fs.statSync(file).size;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      fs.mkdirSync(dir, { recursive: true });
      try {
        pruneOld(dir, day, opts.pruneDays ?? PRUNE_DAYS);
      } catch {
      }
    }
    if (size2 >= (opts.capBytes ?? DAY_CAP_BYTES)) {
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

// src/pre-compact-breakpoint.ts
import * as fs4 from "fs";
import * as path3 from "path";

// src/shared/breakpoint.ts
import * as fs2 from "fs";
import * as os from "os";
import * as path from "path";
var MAX_FILE_CHARS = 3500;
var TYPED_HEADER = "Dave's last lines (context, not decisions)";
var TAIL_BYTES = 8 * 1024 * 1024;
var MAX_TYPED = 5;
var TYPED_CUT = 300;
var QUESTION_CUT = 140;
var ANSWER_CUT = 160;
var NOTE_CUT = 80;
var LANE_FIELD_CUT = 200;
var PRUNE_DAYS2 = 30;
var SAFE_LANE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
var SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/;
var OWN_FILE = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}\.md$/;
var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var oneLine = (s) => s.replace(/\s+/g, " ").trim();
var cut = (s, n) => s.length > n ? `${s.slice(0, Math.max(0, n - 1))}\u2026` : s;
function answersFromText(content, questions) {
  const out = {};
  for (const q of questions) {
    const start = content.indexOf(`"${q}"="`);
    if (start < 0) continue;
    const from = start + q.length + 4;
    const ends = [content.indexOf('". You can now', from), content.indexOf('", "', from)].filter((i) => i >= 0);
    out[q] = content.slice(from, ends.length ? Math.min(...ends) : content.length).replace(/"$/, "");
  }
  return out;
}
function toolResultText(content) {
  if (!Array.isArray(content)) return "";
  for (const b of content) if (isObj(b) && b.type === "tool_result" && typeof b.content === "string") return b.content;
  return "";
}
function resultFor(o, call) {
  const tur = o.toolUseResult;
  if (isObj(tur) && isObj(tur.answers)) {
    const out = {};
    for (const [q, a] of Object.entries(tur.answers)) if (typeof a === "string") out[q] = a;
    return out;
  }
  const msg = isObj(o.message) ? o.message : {};
  return answersFromText(toolResultText(msg.content), call.questions.map((q) => q.question));
}
function noteFor(o, question) {
  const ann = isObj(o.toolUseResult) ? o.toolUseResult.annotations : void 0;
  const entry = isObj(ann) ? ann[question] : void 0;
  const notes = isObj(entry) ? entry.notes : void 0;
  return typeof notes === "string" && notes.trim() ? oneLine(notes) : void 0;
}
function parseTranscriptTail(text) {
  const decisions = [];
  const typed = [];
  const pending = /* @__PURE__ */ new Map();
  for (const line of text.split("\n")) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(o)) continue;
    const msg = isObj(o.message) ? o.message : null;
    if (!msg) continue;
    if (o.type === "assistant" && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!isObj(b) || b.type !== "tool_use" || b.name !== "AskUserQuestion" || typeof b.id !== "string") continue;
        const qs = isObj(b.input) && Array.isArray(b.input.questions) ? b.input.questions : [];
        const questions = qs.filter(isObj).filter((q) => typeof q.question === "string").map((q) => ({ header: typeof q.header === "string" ? q.header : "", question: q.question }));
        if (questions.length) pending.set(b.id, { questions });
      }
    } else if (o.type === "user" && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!isObj(b) || b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const call = pending.get(b.tool_use_id);
        if (!call) continue;
        pending.delete(b.tool_use_id);
        const answers = resultFor(o, call);
        const at = typeof o.timestamp === "string" ? o.timestamp : "";
        for (const q of call.questions) {
          if (typeof answers[q.question] !== "string") continue;
          const note = noteFor(o, q.question);
          decisions.push({ at, header: q.header, question: q.question, answer: answers[q.question], ...note ? { note } : {} });
        }
      }
    } else if (o.type === "user" && typeof msg.content === "string" && !o.isMeta) {
      const origin = isObj(o.origin) ? o.origin : null;
      const body = msg.content.trim();
      if (origin?.kind !== "human" || !body || body.startsWith("<")) continue;
      typed.push({ at: typeof o.timestamp === "string" ? o.timestamp : "", text: cut(oneLine(body), TYPED_CUT) });
    }
  }
  return { decisions, typed: typed.slice(-MAX_TYPED) };
}
function readTranscriptTail(file, maxBytes = TAIL_BYTES) {
  if (!file) return "";
  let fd = null;
  try {
    fd = fs2.openSync(file, "r");
    const size2 = fs2.fstatSync(fd).size;
    const len = Math.min(size2, maxBytes);
    const buf = Buffer.alloc(len);
    fs2.readSync(fd, buf, 0, len, size2 - len);
    const text = buf.toString("utf8");
    if (size2 <= len) return text;
    const nl = text.indexOf("\n");
    return nl < 0 ? "" : text.slice(nl + 1);
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        fs2.closeSync(fd);
      } catch {
      }
    }
  }
}
function laneFactsFrom(board, sessionId) {
  const lanes = isObj(board) ? board.lanes : void 0;
  if (!Array.isArray(lanes)) return [];
  const out = [];
  for (const l of lanes) {
    if (!isObj(l) || typeof l.id !== "string" || l.owner_session_id !== sessionId || l.state === "done") continue;
    if (!SAFE_LANE_ID.test(l.id)) continue;
    const note = typeof l.note === "string" ? l.note : "";
    out.push({
      id: l.id,
      title: typeof l.title === "string" ? l.title : "",
      goal: /GOAL:\s*(.*?)(?:\s+\|\s+|$)/.exec(note)?.[1]?.trim() ?? "",
      next: /NEXT[^:|]*:\s*(.*?)(?:\s+\|\s+|$)/.exec(note)?.[1]?.trim() ?? "",
      milestone: /MS:\s*(\S+)/.exec(note)?.[1] ?? null
    });
  }
  return out;
}
var hhmm = (at) => {
  const m = /T(\d\d:\d\d)/.exec(at)?.[1];
  return m ? `${m}Z` : "";
};
var mask = (s, n) => cut(maskSecrets(oneLine(s)), n);
function laneBlock(lanes, cut2 = LANE_FIELD_CUT) {
  if (!lanes.length) return [];
  const out = ["## Lanes held"];
  for (const l of lanes) {
    out.push(`- ${l.id}${l.title && cut2 ? `: ${mask(l.title, 100)}` : ""}`);
    if (!cut2) continue;
    if (l.goal) out.push(`  GOAL: ${mask(l.goal, cut2)}`);
    if (l.next) out.push(`  NEXT: ${mask(l.next, cut2)}`);
    if (l.milestone) out.push(`  MS: ${mask(l.milestone, Math.min(200, cut2))}`);
  }
  return out;
}
var size = (lines) => lines.length ? lines.join("\n").length + 1 : 0;
function decisionLine(d) {
  const head = d.header ? `${mask(d.header, 30)}: ` : "";
  const note = d.note ? ` (note: ${mask(d.note, NOTE_CUT)})` : "";
  return `- [${hhmm(d.at)}] ${head}${mask(d.question, QUESTION_CUT)} -> ${mask(d.answer, ANSWER_CUT)}${note}`;
}
function buildBreakpoint(input) {
  const head = [
    "# Session breakpoint",
    `session: ${input.sessionId} | trigger: ${input.trigger} | at: ${input.now.toISOString().slice(0, 16)}Z`,
    ...input.branch ? [`branch: ${mask(input.branch, 100)}`] : []
  ];
  const resume = ["## Resume", "Resume: continue with the NEXT step of the lane note. Do not re-ask a decision above."];
  let room = MAX_FILE_CHARS - size(head) - size(resume) - 40;
  const fresh = input.decisions.map(decisionLine);
  const freshSet = new Set(fresh);
  const lines = [...(input.carried ?? []).filter((l) => !freshSet.has(l)), ...fresh];
  const decHead = "## Decisions made (Do not ask these again)";
  const kept = [];
  let decRoom = room - size(laneBlock(input.lanes, 0)) - decHead.length - 1;
  for (let i = lines.length - 1; i >= 0 && lines[i].length + 1 <= decRoom; i--) {
    kept.unshift(lines[i]);
    decRoom -= lines[i].length + 1;
  }
  const decisions = kept.length ? [decHead, ...kept] : [];
  room -= size(decisions);
  const lanes = [LANE_FIELD_CUT, 80, 0].map((c) => laneBlock(input.lanes, c)).find((b) => size(b) <= room) ?? laneBlock(input.lanes, 0);
  room -= size(lanes);
  const typedLines = input.typed.map((t) => `- [${hhmm(t.at)}] ${mask(t.text, TYPED_CUT)}`);
  const typedKept = [];
  let typedRoom = room - TYPED_HEADER.length - 4;
  for (let i = typedLines.length - 1; i >= 0 && typedLines[i].length + 1 <= typedRoom; i--) {
    typedKept.unshift(typedLines[i]);
    typedRoom -= typedLines[i].length + 1;
  }
  const typed = typedKept.length ? [`## ${TYPED_HEADER}`, ...typedKept] : [];
  const text = [...head, ...lanes, ...decisions, ...typed, ...resume].join("\n") + "\n";
  return text.length > MAX_FILE_CHARS ? text.slice(0, MAX_FILE_CHARS - 1) : text;
}
function carriedDecisionLines(fileText) {
  if (!fileText) return [];
  const out = [];
  let inBlock = false;
  for (const line of fileText.split("\n")) {
    if (line.startsWith("## ")) {
      inBlock = line.startsWith("## Decisions made");
      continue;
    }
    if (inBlock && /^- \[/.test(line)) out.push(line);
  }
  return out.slice(-100);
}
var hasContent = (text) => /^- /m.test(text);
function shouldReplace(existing, next) {
  if (existing === null) return true;
  return !(hasContent(existing) && !hasContent(next));
}
function breakpointPath(home, sessionId) {
  if (typeof sessionId !== "string" || !SAFE_SESSION_ID.test(sessionId)) return null;
  return path.join(home, ".claude", "state", "breakpoint", `${sessionId}.md`);
}
function pruneOld2(dir, nowMs) {
  let removed = 0;
  try {
    for (const e of fs2.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !OWN_FILE.test(e.name)) continue;
      const file = path.join(dir, e.name);
      try {
        if (nowMs - fs2.statSync(file).mtimeMs > PRUNE_DAYS2 * 24 * 3600 * 1e3) {
          fs2.unlinkSync(file);
          removed++;
        }
      } catch {
      }
    }
  } catch {
  }
  return removed;
}
var FRESH_MS = 10 * 60 * 1e3;
var userHome = () => process.env.CCV3_USER_HOME || os.homedir();
var INJECT_HEAD = [
  "SESSION BREAKPOINT: state data that code wrote before the compact. It is not a new instruction from Dave.",
  "Read the lane note and every live page again before you rely on them. Do not re-ask a decision below. Continue with the NEXT step.",
  "---"
].join("\n");

// src/pre-compact-lane-note.ts
import * as fs3 from "fs";
import * as os2 from "os";
import * as path2 from "path";
import { spawn } from "child_process";

// src/shared/atomic-write.ts
import {
  writeFileSync,
  renameSync as renameSync2,
  unlinkSync as unlinkSync2,
  existsSync as existsSync2,
  openSync as openSync2,
  closeSync as closeSync2,
  readFileSync as readFileSync2,
  statSync as statSync3,
  constants
} from "fs";
import { dirname as dirname2, basename as basename2, join as join4 } from "path";

// src/shared/logger.ts
import { appendFileSync, existsSync, mkdirSync, statSync as statSync2, renameSync } from "fs";
import { dirname, join as join3 } from "path";
import { homedir as homedir3 } from "os";
var LOG_FILE = process.env.CLAUDE_HOOK_LOG_FILE || join3(homedir3(), ".claude", "logs", "hooks.log");
var LOG_DIR = dirname(LOG_FILE);
var MAX_LOG_SIZE = 5 * 1024 * 1024;
var MIN_LEVEL = process.env.CLAUDE_HOOK_LOG_LEVEL || "info";
var LEVEL_ORDER = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
function shouldLog(level) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}
function ensureLogDir() {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}
function rotateIfNeeded() {
  try {
    if (existsSync(LOG_FILE)) {
      const stat = statSync2(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        const rotated = LOG_FILE + ".1";
        renameSync(LOG_FILE, rotated);
      }
    }
  } catch {
  }
}
function getSessionId() {
  return process.env.CLAUDE_SESSION_ID || void 0;
}
function writeLog(entry) {
  try {
    ensureLogDir();
    rotateIfNeeded();
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
  }
}
function createLogger(hookName) {
  function log2(level, msg, data) {
    if (!shouldLog(level)) return;
    const entry = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      hook: hookName,
      msg,
      sessionId: getSessionId()
    };
    if (data && Object.keys(data).length > 0) {
      entry.data = data;
    }
    writeLog(entry);
    if (level === "error" || level === "warn") {
      console.error(`[${hookName}] ${level.toUpperCase()}: ${msg}`);
    }
  }
  return {
    debug: (msg, data) => log2("debug", msg, data),
    info: (msg, data) => log2("info", msg, data),
    warn: (msg, data) => log2("warn", msg, data),
    error: (msg, data) => log2("error", msg, data)
  };
}

// src/shared/atomic-write.ts
var log = createLogger("atomic-write");
var LOCK_STALE_MS = 1e4;
var LOCK_RETRY_MS = 50;
var LOCK_TIMEOUT_MS = 5e3;
function atomicWriteSync(filePath, content) {
  const dir = dirname2(filePath);
  const tmpFile = join4(dir, `.${basename2(filePath)}.tmp.${process.pid}`);
  try {
    writeFileSync(tmpFile, content, "utf-8");
    renameSync2(tmpFile, filePath);
  } catch (err) {
    try {
      if (existsSync2(tmpFile)) unlinkSync2(tmpFile);
    } catch {
    }
    throw err;
  }
}
var missingLockDirsLogged = /* @__PURE__ */ new Set();
function warnLockDirMissing(lockFile) {
  const dir = dirname2(lockFile);
  if (missingLockDirsLogged.has(dir)) return;
  missingLockDirsLogged.add(dir);
  log.warn("Lock dir missing, lock not acquired", { lockFile, dir });
}
function acquireLockSync(filePath, timeoutMs = LOCK_TIMEOUT_MS) {
  const lockFile = filePath + ".lock";
  const startTime = Date.now();
  while (true) {
    try {
      const fd = openSync2(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeFileSync(fd, `${process.pid}
${Date.now()}`, "utf-8");
      closeSync2(fd);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const stat = statSync3(lockFile);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            log.warn("Removing stale lock", { lockFile, ageMs: Date.now() - stat.mtimeMs });
            unlinkSync2(lockFile);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - startTime > timeoutMs) {
          log.error("Lock acquisition timed out", { lockFile, timeoutMs });
          return false;
        }
        const waitUntil = Date.now() + LOCK_RETRY_MS;
        while (Date.now() < waitUntil) {
        }
      } else if (err.code === "ENOENT") {
        warnLockDirMissing(lockFile);
        return false;
      } else {
        log.error("Lock acquisition failed", { lockFile, error: String(err) });
        return false;
      }
    }
  }
}
function releaseLockSync(filePath) {
  const lockFile = filePath + ".lock";
  try {
    if (existsSync2(lockFile)) {
      unlinkSync2(lockFile);
    }
  } catch (err) {
    log.warn("Failed to release lock", { lockFile, error: String(err) });
  }
}
function writeStateWithLock(filePath, content) {
  const locked = acquireLockSync(filePath);
  try {
    atomicWriteSync(filePath, content);
  } catch (err) {
    log.error("State write failed", { filePath, error: String(err) });
  } finally {
    if (locked) {
      releaseLockSync(filePath);
    }
  }
}

// src/pre-compact-lane-note.ts
var COOLDOWN_MS = 5 * 60 * 1e3;
var CALL_TIMEOUT_MS = 4e3;
var TOTAL_BUDGET_MS = 1e4;
var TODO_MAX = 120;
var NOTE_MAX = 300;
var BRANCH_MAX = 80;
var TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
var SAFE_LANE_ID2 = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
var skipped = (why) => ({ continue: true, systemMessage: `[PreCompact] lane note skipped: ${why}` });
function pickHeldLanes(boardJson, sessionId) {
  const lanes = boardJson?.lanes;
  if (!Array.isArray(lanes)) return [];
  const ids = [];
  for (const l of lanes) {
    const lane = l;
    if (!lane || typeof lane.id !== "string") continue;
    if (lane.owner_session_id !== sessionId || lane.state === "done") continue;
    if (SAFE_LANE_ID2.test(lane.id)) ids.push(lane.id);
  }
  return ids;
}
function toOneLine(text) {
  return text.replace(/\s+/g, " ").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();
}
function buildCompactText(opts) {
  const trigger = opts.trigger === "manual" || opts.trigger === "auto" ? opts.trigger : "unknown";
  const hh = String(opts.now.getHours()).padStart(2, "0");
  const mm = String(opts.now.getMinutes()).padStart(2, "0");
  const todo = toOneLine(opts.todo ?? "").slice(0, TODO_MAX).trim();
  const branch = toOneLine(opts.branch ?? "").slice(0, BRANCH_MAX).trim();
  const text = `Compacting (${trigger}) at ${hh}:${mm} local${branch ? ` on branch ${branch}` : ""}.` + (todo ? ` Open task: ${todo}.` : "");
  return text.slice(0, NOTE_MAX);
}
function lastTodoWrite(transcriptText) {
  let last = null;
  let at = -1;
  const lines = transcriptText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("TodoWrite")) continue;
    try {
      const entry = JSON.parse(lines[i]);
      if (entry?.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
      for (const part of entry.message.content) {
        if (part?.type === "tool_use" && part.name === "TodoWrite" && Array.isArray(part.input?.todos)) {
          last = part.input.todos;
          at = i;
        }
      }
    } catch {
    }
  }
  const hit = last?.find((t) => t && t.status === "in_progress" && typeof t.content === "string");
  return hit ? { text: hit.content, at } : null;
}
function firstInProgressTask(transcriptText) {
  const pending = /* @__PURE__ */ new Map();
  const subjects = /* @__PURE__ */ new Map();
  const status = /* @__PURE__ */ new Map();
  const lines = transcriptText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("TaskCreate") && !line.includes("TaskUpdate") && !line.includes('"task"')) continue;
    try {
      const entry = JSON.parse(line);
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      if (entry.type === "assistant") {
        for (const part of content) {
          if (part?.type !== "tool_use") continue;
          if (part.name === "TaskCreate" && typeof part.input?.subject === "string" && typeof part.id === "string") {
            pending.set(part.id, part.input.subject);
          } else if (part.name === "TaskUpdate" && typeof part.input?.taskId === "string") {
            if (typeof part.input.subject === "string") subjects.set(part.input.taskId, part.input.subject);
            if (typeof part.input.status === "string") status.set(part.input.taskId, { status: part.input.status, at: i });
          }
        }
      } else if (entry.type === "user" && typeof entry.toolUseResult?.task?.id === "string") {
        for (const part of content) {
          const subject = part?.type === "tool_result" ? pending.get(part.tool_use_id) : void 0;
          if (subject !== void 0) subjects.set(entry.toolUseResult.task.id, subject);
        }
      }
    } catch {
    }
  }
  const open = [...status.entries()].filter(([id, s]) => s.status === "in_progress" && subjects.has(id)).sort((a, b) => Number(a[0]) - Number(b[0]));
  return open.length ? { text: subjects.get(open[0][0]), at: open[0][1].at } : null;
}
function currentWorkText(transcriptText) {
  const todo = lastTodoWrite(transcriptText);
  const task = firstInProgressTask(transcriptText);
  if (todo && task) return todo.at > task.at ? todo.text : task.text;
  return (todo ?? task)?.text ?? null;
}
function branchOf(cwd) {
  try {
    let dir = path2.resolve(cwd || ".");
    for (let i = 0; i < 8; i++) {
      const dotGit = path2.join(dir, ".git");
      if (fs3.existsSync(dotGit)) {
        let gitDir = dotGit;
        if (fs3.statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(fs3.readFileSync(dotGit, "utf-8"));
          if (!m) return null;
          gitDir = path2.resolve(dir, m[1].trim());
        }
        const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(fs3.readFileSync(path2.join(gitDir, "HEAD"), "utf-8"));
        return ref ? ref[1].trim() : null;
      }
      const up = path2.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  } catch {
  }
  return null;
}
function inCooldown(state, sessionId, nowMs) {
  const last = state?.[sessionId];
  return typeof last === "number" && nowMs - last < COOLDOWN_MS;
}
function readState(stateFile) {
  try {
    const data = JSON.parse(fs3.readFileSync(stateFile, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}
function stampState(stateFile, sessionId, nowMs) {
  try {
    const next = {};
    for (const [k, v] of Object.entries(readState(stateFile))) {
      if (typeof v === "number" && nowMs - v < COOLDOWN_MS) next[k] = v;
    }
    next[sessionId] = nowMs;
    fs3.mkdirSync(path2.dirname(stateFile), { recursive: true });
    writeStateWithLock(stateFile, JSON.stringify(next, null, 2));
  } catch {
  }
}
function readTranscriptTail2(file) {
  if (!file) return "";
  try {
    const fd = fs3.openSync(file, "r");
    try {
      const size2 = fs3.fstatSync(fd).size;
      const len = Math.min(size2, TRANSCRIPT_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs3.readSync(fd, buf, 0, len, size2 - len);
      return buf.toString("utf-8");
    } finally {
      fs3.closeSync(fd);
    }
  } catch {
    return "";
  }
}
var spawnLaneCli = (laneCli) => (args, opts) => new Promise((resolve3) => {
  let stdout = "";
  let stderr = "";
  let settled = false;
  const done = (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve3({ code, stdout, stderr });
  };
  let proc;
  try {
    proc = spawn(process.execPath, [laneCli, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    resolve3({ code: -1, stdout, stderr });
    return;
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
    }
    stderr += "timeout";
    done(-1);
  }, opts.timeoutMs);
  proc.stdout?.on("data", (d) => {
    stdout += d.toString();
  });
  proc.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  proc.on("error", () => done(-1));
  proc.on("close", (code) => done(code ?? -1));
});
async function runPreCompactLaneNote(input, deps) {
  try {
    const sessionId = input.session_id;
    if (!sessionId) return skipped("no session id");
    const started = deps.now().getTime();
    if (inCooldown(readState(deps.stateFile), sessionId, started)) return skipped("cooldown (noted within 5 minutes)");
    const cwd = input.cwd || process.cwd();
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId };
    const left = () => Math.min(CALL_TIMEOUT_MS, TOTAL_BUDGET_MS - (deps.now().getTime() - started));
    const boardRun = await deps.runner(["board", "--json"], { cwd, env, timeoutMs: left() });
    if (boardRun.code !== 0) return skipped(`lane board unavailable (exit ${boardRun.code})`);
    let boardJson;
    try {
      boardJson = JSON.parse(boardRun.stdout);
    } catch {
      return skipped("lane board output is not JSON");
    }
    const held = pickHeldLanes(boardJson, sessionId);
    if (held.length === 0) return skipped("no held lane");
    const text = buildCompactText({
      trigger: input.trigger,
      now: deps.now(),
      todo: currentWorkText(readTranscriptTail2(input.transcript_path)),
      branch: branchOf(cwd)
    });
    let written = 0;
    for (const laneId of held) {
      if (left() <= 0) break;
      try {
        const r = await deps.runner(["compact", laneId, text], { cwd, env, timeoutMs: left() });
        if (r.code === 0) written++;
      } catch {
      }
    }
    if (written === 0) return skipped("every compact event write failed");
    stampState(deps.stateFile, sessionId, started);
    return { continue: true, systemMessage: `[PreCompact] compact event logged on ${written} lane(s)` };
  } catch (err) {
    return skipped(`error (${err instanceof Error ? err.message.slice(0, 80) : "unknown"})`);
  }
}
async function readStdin() {
  return new Promise((resolve3) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve3(data));
  });
}
async function main() {
  let out;
  try {
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) : {};
    const home = process.env.CCV3_USER_HOME || os2.homedir();
    const laneCli = path2.join(home, ".claude", "scripts", "lane.mjs");
    out = await runPreCompactLaneNote(input, {
      runner: spawnLaneCli(laneCli),
      now: () => /* @__PURE__ */ new Date(),
      // One file under ~/.claude/state, not the project folder: no stray state file in every project you compact in.
      stateFile: path2.join(home, ".claude", "state", "pre-compact-lane-note.json"),
      laneCli
    });
  } catch {
    out = skipped("bad hook input");
  }
  console.log(JSON.stringify(out));
}
if ((process.argv[1] || "").includes("pre-compact-lane-note")) {
  main().catch(() => console.log(JSON.stringify(skipped("error"))));
}

// src/pre-compact-breakpoint.ts
var CALL_TIMEOUT_MS2 = 4e3;
var skipped2 = (why) => ({ continue: true, systemMessage: `[PreCompact] breakpoint skipped: ${why}` });
async function lanesOf(sessionId, cwd, deps) {
  try {
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId };
    const run = await deps.runner(["board", "--json"], { cwd, env, timeoutMs: CALL_TIMEOUT_MS2 });
    if (run.code !== 0) return [];
    return laneFactsFrom(JSON.parse(run.stdout), sessionId);
  } catch {
    return [];
  }
}
function readExisting(file) {
  try {
    return fs4.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
function writeAtomic(file, text) {
  fs4.mkdirSync(path3.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs4.writeFileSync(tmp, text);
  fs4.renameSync(tmp, file);
}
async function runPreCompactBreakpoint(input, deps) {
  try {
    const sessionId = input.session_id;
    const file = sessionId ? breakpointPath(deps.home, sessionId) : null;
    if (!sessionId || !file) return skipped2("no usable session id");
    const cwd = input.cwd || process.cwd();
    const { decisions, typed } = parseTranscriptTail(readTranscriptTail(input.transcript_path));
    const lanes = await lanesOf(sessionId, cwd, deps);
    const existing = readExisting(file);
    const facts = {
      sessionId,
      trigger: input.trigger === "auto" ? "auto" : "manual",
      now: deps.now(),
      lanes,
      branch: deps.branchOf(cwd),
      decisions,
      typed
    };
    if (!shouldReplace(existing, buildBreakpoint(facts))) return { continue: true, systemMessage: "[PreCompact] breakpoint kept (nothing new to save)" };
    writeAtomic(file, buildBreakpoint({ ...facts, carried: carriedDecisionLines(existing) }));
    pruneOld2(path3.dirname(file), deps.now().getTime());
    return { continue: true, systemMessage: `[PreCompact] breakpoint saved: ${decisions.length} decision(s), ${lanes.length} lane(s)` };
  } catch (err) {
    return skipped2(`error (${err instanceof Error ? err.message.slice(0, 80) : "unknown"})`);
  }
}
async function readStdin2() {
  return new Promise((resolve3) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve3(data));
  });
}
async function main2() {
  let out;
  try {
    const raw = await readStdin2();
    const input = raw.trim() ? JSON.parse(raw) : {};
    const home = userHome();
    out = await runPreCompactBreakpoint(input, {
      home,
      now: () => /* @__PURE__ */ new Date(),
      runner: spawnLaneCli(path3.join(home, ".claude", "scripts", "lane.mjs")),
      branchOf
    });
  } catch {
    out = skipped2("bad hook input");
  }
  console.log(JSON.stringify(out));
}
if ((process.argv[1] || "").includes("pre-compact-breakpoint")) {
  main2().catch(() => console.log(JSON.stringify(skipped2("error"))));
}
export {
  runPreCompactBreakpoint
};
