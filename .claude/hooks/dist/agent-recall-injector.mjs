#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/agent-recall-injector.ts
import { readFileSync as readFileSync3, mkdirSync as mkdirSync4, appendFileSync as appendFileSync3 } from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

// src/shared/opc-path.ts
import { existsSync } from "fs";
import { join } from "path";
function getOpcDir() {
  const envOpcDir = process.env.CLAUDE_OPC_DIR;
  if (envOpcDir && existsSync(envOpcDir)) {
    return envOpcDir;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const localOpc = join(projectDir, "opc");
  if (existsSync(localOpc)) {
    return localOpc;
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  if (homeDir) {
    const globalClaude = join(homeDir, ".claude");
    const globalScripts = join(globalClaude, "scripts", "core");
    if (existsSync(globalScripts) && globalClaude !== projectDir) {
      return globalClaude;
    }
  }
  return null;
}

// src/shared/output.ts
function outputContinue() {
  console.log(JSON.stringify({ result: "continue" }));
}

// src/shared/intent-extractor.ts
var STOP_WORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "can",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "s",
  "t",
  "just",
  "don",
  "now",
  "i",
  "me",
  "my",
  "you",
  "your",
  "we",
  "help",
  "with",
  "our",
  "they",
  "them",
  "their",
  "it",
  "its",
  "this",
  "that",
  "these",
  "what",
  "which",
  "who",
  "whom",
  "and",
  "but",
  "if",
  "or",
  "because",
  "until",
  "while",
  "about",
  "against",
  "also",
  "get",
  "got",
  "make",
  "want",
  "need",
  "look",
  "see",
  "use",
  "like",
  "know",
  "think",
  "take",
  "come",
  "go",
  "say",
  "said",
  "tell",
  "please",
  "help",
  "let",
  "sure",
  "recall",
  "remember",
  "similar",
  "problems",
  "issues"
]);
var META_PATTERNS = [
  /^(can you|could you|would you|please|help me|i want to|i need to|let's|lets)\s+/gi,
  /^(show me|tell me|find|search for|look for|recall|remember)\s+/gi,
  /^(how do i|how can i|how to|what is|what are|where is|where are)\s+/gi,
  /\s+(for me|please|thanks|thank you)$/gi,
  /\?$/g
];
function extractKeywords(prompt) {
  if (typeof prompt !== "string") return "";
  const words = prompt.toLowerCase().replace(/[^\w\s-]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, 5).join(" ");
}
function extractIntent(prompt) {
  if (typeof prompt !== "string") return "";
  let intent = prompt.trim();
  for (const pattern of META_PATTERNS) {
    intent = intent.replace(pattern, "");
  }
  intent = intent.trim();
  if (intent.length < 5) {
    return extractKeywords(prompt);
  }
  return intent;
}

// src/shared/logger.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync, statSync, renameSync } from "fs";
import { dirname, join as join2 } from "path";
import { homedir } from "os";
var LOG_FILE = process.env.CLAUDE_HOOK_LOG_FILE || join2(homedir(), ".claude", "logs", "hooks.log");
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
  if (!existsSync2(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}
function rotateIfNeeded() {
  try {
    if (existsSync2(LOG_FILE)) {
      const stat = statSync(LOG_FILE);
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
  function log3(level, msg, data) {
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
    debug: (msg, data) => log3("debug", msg, data),
    info: (msg, data) => log3("info", msg, data),
    warn: (msg, data) => log3("warn", msg, data),
    error: (msg, data) => log3("error", msg, data)
  };
}

// src/shared/memory-sanitize.ts
function sanitizeMemoryContent(content, cap = 500) {
  if (typeof content !== "string" || content.length === 0) {
    return "";
  }
  let out = content.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
  if (out.length > cap) {
    out = out.slice(0, cap) + "...(truncated)";
  }
  out = out.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return out;
}
function wrapMemoryContext(body) {
  return `<context source="memory" trust="data-only">
${body}
</context>`;
}

// src/shared/context-bus.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname3, join as join5, resolve, sep } from "node:path";

// src/shared/session-bus-id.ts
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

// src/shared/session-id.ts
import { mkdirSync as mkdirSync2, readFileSync, writeFileSync } from "fs";
import { homedir as homedir2 } from "os";
import { join as join3 } from "path";
var SESSION_ID_FILENAME = ".coordination-session-id";
function getSessionIdFile(options = {}) {
  const claudeDir = join3(process.env.HOME || process.env.USERPROFILE || homedir2(), ".claude");
  if (options.createDir) {
    try {
      mkdirSync2(claudeDir, { recursive: true, mode: 448 });
    } catch {
    }
  }
  return join3(claudeDir, SESSION_ID_FILENAME);
}
function generateSessionId() {
  const spanId = process.env.BRAINTRUST_SPAN_ID;
  if (spanId) {
    return spanId.slice(0, 8);
  }
  return `s-${Date.now().toString(36)}`;
}
function readSessionId() {
  try {
    const sessionFile = getSessionIdFile();
    const id = readFileSync(sessionFile, "utf-8").trim();
    return id || null;
  } catch {
    return null;
  }
}
function getSessionId2(options = {}) {
  if (process.env.COORDINATION_SESSION_ID) {
    return process.env.COORDINATION_SESSION_ID;
  }
  const fileId = readSessionId();
  if (fileId) {
    return fileId;
  }
  if (options.debug) {
    console.error("[session-id] WARNING: No persisted session ID found, generating new one");
  }
  return generateSessionId();
}

// src/shared/session-bus-id.ts
var PROJECT_HASH_LEN = 12;
function defaultCwd() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
function hashProjectPath(cwd, realpath = realpathSync) {
  let resolved;
  try {
    resolved = realpath(cwd);
  } catch {
    resolved = cwd;
  }
  const normalized = resolved.toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, PROJECT_HASH_LEN);
}
function sanitizeBusPart(part) {
  return part.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, ".").slice(0, 40);
}
function getBusId(opts = {}) {
  try {
    const sessionId = sanitizeBusPart(getSessionId2());
    const projectHash = hashProjectPath(opts.cwd ?? defaultCwd(), opts.realpath);
    return `${sessionId}-${projectHash}`;
  } catch {
    const fallback = hashProjectPath(opts.cwd ?? defaultCwd(), opts.realpath);
    return `s-unknown-${fallback}`;
  }
}

// src/shared/atomic-write.ts
var log = createLogger("atomic-write");

// src/shared/intel-bus.ts
import { appendFileSync as appendFileSync2, existsSync as existsSync3, mkdirSync as mkdirSync3, renameSync as renameSync2, statSync as statSync2, unlinkSync } from "node:fs";
import { dirname as dirname2, join as join4 } from "node:path";
var MAX_LINE_BYTES = 4096;
var MAX_INTEL_BUS_BYTES = 2e6;
var DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
function intelBusPath(projectDir) {
  const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join4(root, ".claude", "logs", "intel-bus.jsonl");
}
function stripNewlinesDeep(value) {
  if (typeof value === "string") {
    return value.replace(/[\r\n]+/g, " ");
  }
  if (Array.isArray(value)) {
    return value.map(stripNewlinesDeep);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = stripNewlinesDeep(v);
    }
    return out;
  }
  return value;
}
var SECRET_KEY_RE = /API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|DATABASE_URL|CONNECTION_?STRING|ACCESS_?KEY|PRIVATE_?KEY|AUTHORIZATION|CREDENTIAL/i;
var SECRET_FIELD_NAME_RE = /^(.*[_-])?(password|passwd|secret|token|api_?key|access_?key|private_?key|authorization|credential|database_url|connection_?string)s?$/i;
var ASSIGNMENT_RE = /([A-Za-z0-9_]{1,128})(\s*[:=]\s*)("?)([^\s]{1,2048})/g;
function redactSecretString(s, keyHint) {
  if (keyHint && s.length > 0 && SECRET_FIELD_NAME_RE.test(keyHint)) {
    return "[REDACTED]";
  }
  let out = s;
  out = out.replace(/sk-[A-Za-z0-9_-]{16,512}/g, "sk-[REDACTED]").replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED-AWS-KEY]").replace(/gh[posru]_[A-Za-z0-9]{30,255}/g, "[REDACTED-GH-TOKEN]").replace(/xox[abprs]-[A-Za-z0-9-]{10,512}/gi, "[REDACTED-SLACK-TOKEN]").replace(
    /eyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{6,2048}/g,
    "[REDACTED-JWT]"
  ).replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,2048}/gi, "Bearer [REDACTED]").replace(/postgres(ql)?:\/\/[^:@\s/]+:[^@\s/]+@/gi, "postgresql://[REDACTED]@");
  out = out.replace(
    ASSIGNMENT_RE,
    (m, key, sep2, quote) => SECRET_KEY_RE.test(key) ? `${key}${sep2}${quote}[REDACTED]` : m
  );
  return out;
}
function redactSecretsDeep(value, keyHint) {
  if (typeof value === "string") {
    return redactSecretString(value, keyHint);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecretsDeep(v, keyHint));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecretsDeep(v, k);
    }
    return out;
  }
  return value;
}
function longestStringKey(obj) {
  let key = null;
  let len = -1;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > len) {
      len = v.length;
      key = k;
    }
  }
  return key;
}
function appendIntelBus(event, opts = {}) {
  if (process.env.CCV3_BUS_OFF === "1") return;
  try {
    const now = opts.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
    const append = opts.append ?? defaultAppend;
    const path2 = intelBusPath(opts.projectDir);
    const stamped = {
      ...event,
      ts: event.ts ?? now(),
      schema_version: 1
    };
    const normalized = stripNewlinesDeep(redactSecretsDeep(stamped));
    let line = JSON.stringify(normalized) + "\n";
    if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) {
      const key = longestStringKey(normalized);
      if (key) {
        const marker = "...(truncated)";
        const withoutField = { ...normalized, [key]: "" };
        const overhead = Buffer.byteLength(JSON.stringify(withoutField) + "\n", "utf-8");
        const budget = MAX_LINE_BYTES - overhead - marker.length;
        if (budget > 0) {
          const original = String(normalized[key]);
          normalized[key] = original.slice(0, budget) + marker;
          line = JSON.stringify(normalized) + "\n";
        }
      }
      if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) {
        return;
      }
    }
    maybeRotate(path2, opts.size, opts.rename);
    append(path2, line);
  } catch {
  }
}
function defaultAppend(path2, line) {
  const dir = dirname2(path2);
  if (!existsSync3(dir)) {
    mkdirSync3(dir, { recursive: true });
  }
  appendFileSync2(path2, line, "utf-8");
}
function defaultSize(path2) {
  if (!existsSync3(path2)) return 0;
  return statSync2(path2).size;
}
function resolveMaxBytes() {
  const raw = process.env.CCV3_INTEL_BUS_MAX_BYTES;
  if (raw !== void 0) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return MAX_INTEL_BUS_BYTES;
}
function maybeRotate(path2, sizeFn, renameFn) {
  try {
    const size = sizeFn ?? defaultSize;
    const rename = renameFn ?? renameSync2;
    const cap = resolveMaxBytes();
    let live = 0;
    try {
      live = size(path2);
    } catch {
      return;
    }
    if (live >= cap) {
      rename(path2, `${path2}.1`);
    }
  } catch {
  }
}

// src/shared/context-bus.ts
var LATENCY_BUDGET_MS = 50;
function emptyBus(busId) {
  return {
    bus_id: busId,
    current_intent: null,
    focus_symbols: [],
    files_in_play: { load_bearing: [], ambient: [] },
    recent_findings: [],
    open_threads: [],
    schema_version: 3,
    compact_generation: 0,
    revision: 0,
    current_turn: 0
  };
}
var VALID_BUS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
function assertSafeBusId(busId) {
  if (typeof busId !== "string" || busId.length === 0 || busId === "." || busId === ".." || busId.includes("/") || busId.includes("\\") || busId.includes("..") || !VALID_BUS_ID.test(busId)) {
    throw new Error("unsafe bus id");
  }
}
function sessionCacheRoot(projectDir) {
  const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join5(root, ".claude", "cache", "session");
}
function busPath(busId, projectDir) {
  assertSafeBusId(busId);
  const sessionRoot = sessionCacheRoot(projectDir);
  const full = join5(sessionRoot, busId, "context.json");
  const resolvedRoot = resolve(sessionRoot);
  const resolvedFull = resolve(full);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (!resolvedFull.startsWith(rootWithSep)) {
    throw new Error("bus path escapes session root");
  }
  return full;
}
function busOff() {
  return process.env.CCV3_BUS_OFF === "1";
}
function capTail(arr, cap) {
  return arr.length > cap ? arr.slice(arr.length - cap) : arr;
}
function capByTurn(arr, cap) {
  if (arr.length <= cap) return arr;
  return [...arr].sort((a, b) => (a.turn_added ?? 0) - (b.turn_added ?? 0)).slice(arr.length - cap);
}
function coerceBus(busId, parsed) {
  const base = emptyBus(busId);
  if (!parsed || typeof parsed !== "object") return base;
  const p = parsed;
  return {
    bus_id: typeof p.bus_id === "string" ? p.bus_id : busId,
    current_intent: typeof p.current_intent === "string" ? p.current_intent : null,
    focus_symbols: capTail(
      Array.isArray(p.focus_symbols) ? p.focus_symbols : [],
      FOCUS_SYMBOLS_CAP
    ),
    files_in_play: coerceFilesInPlay(p.files_in_play),
    recent_findings: capTail(
      Array.isArray(p.recent_findings) ? p.recent_findings : [],
      RECENT_FINDINGS_CAP
    ),
    open_threads: capTail(
      Array.isArray(p.open_threads) ? p.open_threads : [],
      OPEN_THREADS_CAP
    ),
    schema_version: 3,
    compact_generation: typeof p.compact_generation === "number" ? p.compact_generation : 0,
    revision: typeof p.revision === "number" && Number.isFinite(p.revision) ? p.revision : 0,
    current_turn: typeof p.current_turn === "number" && Number.isFinite(p.current_turn) ? p.current_turn : 0
  };
}
function coerceFilesInPlay(value) {
  if (!value || typeof value !== "object") return { load_bearing: [], ambient: [] };
  const v = value;
  const lb = Array.isArray(v.load_bearing) ? v.load_bearing : [];
  const amb = Array.isArray(v.ambient) ? v.ambient : [];
  return {
    load_bearing: capByTurn(lb, LOAD_BEARING_CAP),
    ambient: capTail(amb, LOAD_BEARING_CAP)
  };
}
function defaultRead(path2) {
  try {
    return readFileSync2(path2, "utf-8");
  } catch {
    return null;
  }
}
function readBus(busId, opts = {}) {
  const id = busId ?? safeBusId();
  if (busOff()) return emptyBus(id);
  const read = opts.read ?? defaultRead;
  const now = opts.now ?? Date.now;
  try {
    const path2 = busPath(id, opts.projectDir);
    const start = now();
    const raw = read(path2);
    const elapsed = now() - start;
    if (elapsed >= LATENCY_BUDGET_MS) {
      reportLatency(id, elapsed, opts);
    }
    if (raw == null) return emptyBus(id);
    return coerceBus(id, JSON.parse(raw));
  } catch {
    return emptyBus(id);
  }
}
function reportLatency(busId, durationMs, opts) {
  const event = {
    bus_id: busId,
    query_type: "bus_read_latency",
    duration_ms: durationMs
  };
  try {
    if (opts.onLatency) {
      opts.onLatency(event);
    } else {
      appendIntelBus({ ...event, bus_id: busId }, { projectDir: opts.projectDir });
    }
  } catch {
  }
}
function safeBusId() {
  try {
    return getBusId();
  } catch {
    return "s-unknown";
  }
}
var LOAD_BEARING_CAP = 50;
var FOCUS_SYMBOLS_CAP = 50;
var RECENT_FINDINGS_CAP = 50;
var OPEN_THREADS_CAP = 50;

// src/shared/bus-focus.ts
var BUS_STALENESS_MAX_AGE = 3;
var MAX_FOCUS_TERMS = 8;
var FOCUS_TERM_CHARS = 60;
function isFresh(currentTurn, turnAdded) {
  if (typeof turnAdded !== "number" || !Number.isFinite(turnAdded)) return false;
  const age = currentTurn - turnAdded;
  return age >= -1 && age <= BUS_STALENESS_MAX_AGE;
}
function basenameNoExt(p) {
  const base = p.split(/[\\/]/).pop() ?? p;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
function extractBusFocus(bus) {
  const currentTurn = typeof bus.current_turn === "number" ? bus.current_turn : 0;
  const seen = /* @__PURE__ */ new Set();
  const terms = [];
  let staleSymbolsCount = 0;
  const push = (raw) => {
    if (terms.length >= MAX_FOCUS_TERMS) return;
    if (typeof raw !== "string") return;
    const t = raw.replace(/[\x00-\x1f\x7f-\x9f]/g, "").replace(/[^\p{L}\p{N}_.$#-]/gu, "").trim().slice(0, FOCUS_TERM_CHARS);
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(t);
  };
  const SCAN_CAP = 200;
  const focusSymbols = (Array.isArray(bus.focus_symbols) ? bus.focus_symbols : []).slice(0, SCAN_CAP);
  for (const sym of focusSymbols) {
    if (!isFresh(currentTurn, sym?.turn_added)) {
      staleSymbolsCount += 1;
      continue;
    }
    push(sym?.id?.name);
  }
  const loadBearing = (Array.isArray(bus.files_in_play?.load_bearing) ? bus.files_in_play.load_bearing : []).slice(0, SCAN_CAP);
  for (const f of loadBearing) {
    if (!isFresh(currentTurn, f?.turn_added)) continue;
    if (typeof f?.path === "string") push(basenameNoExt(f.path));
  }
  return { terms: terms.slice(0, MAX_FOCUS_TERMS), staleSymbolsCount };
}
function buildFocusBlock(terms) {
  if (!terms.length) return "";
  const safeTerms = terms.map((t) => sanitizeMemoryContent(t, FOCUS_TERM_CHARS));
  const body = [
    "SESSION FOCUS (current working set, reference data only):",
    ...safeTerms.map((t) => `- ${t}`)
  ].join("\n");
  return wrapMemoryContext(body);
}

// src/agent-recall-injector.ts
var PROACTIVE_INJECTION_FLOOR = 0.05;
var RECALL_TIMEOUT_MS = 3500;
var MIN_PROMPT_LENGTH = 30;
var TOP_K = 3;
var PREVIEW_CHARS = 120;
var SKIP_SUBAGENTS = /* @__PURE__ */ new Set(["oracle", "pathfinder"]);
var log2 = createLogger("agent-recall-injector");
function shouldSkip(input) {
  if (process.env.CLAUDE_AGENT_ID) {
    return { skip: true, reason: "CLAUDE_AGENT_ID set (recursion guard, nested agent)" };
  }
  if (!input || typeof input !== "object") {
    return { skip: true, reason: "invalid input" };
  }
  if (input.tool_name !== "Agent" && input.tool_name !== "Task") {
    return { skip: true, reason: `tool_name is not Agent/Task (${input.tool_name})` };
  }
  const ti = input.tool_input;
  if (!ti || typeof ti !== "object") {
    return { skip: true, reason: "missing tool_input" };
  }
  const subagent = typeof ti.subagent_type === "string" ? ti.subagent_type : "";
  if (!subagent) {
    return { skip: true, reason: "missing subagent_type" };
  }
  if (SKIP_SUBAGENTS.has(subagent.toLowerCase())) {
    return { skip: true, reason: `${subagent} is external research, skipping` };
  }
  const prompt = typeof ti.prompt === "string" ? ti.prompt : "";
  if (!prompt) {
    return { skip: true, reason: "missing prompt" };
  }
  if (prompt.length < MIN_PROMPT_LENGTH) {
    return { skip: true, reason: `prompt too short (length ${prompt.length})` };
  }
  const desc = typeof ti.description === "string" ? ti.description : "";
  if (desc.trim().startsWith("/")) {
    return { skip: true, reason: "slash-command pass-through" };
  }
  return { skip: false };
}
function previewContent(content) {
  const joined = content.split("\n").filter((l) => l.trim().length > 0).map((l) => l.trim()).join(" ");
  return sanitizeMemoryContent(joined, PREVIEW_CHARS);
}
function buildAgentContext(subagentType, intent, results, focusBlock) {
  const top = results.slice(0, TOP_K);
  const lines = top.map((r, i) => {
    const safeType = sanitizeMemoryContent(String(r.type ?? "UNKNOWN"), 40);
    const safeId = sanitizeMemoryContent(String(r.id ?? ""), 16);
    return `${i + 1}. [${safeType}] ${previewContent(r.content || "")} (id: ${safeId})`;
  });
  const safeIntent = sanitizeMemoryContent(intent, 200);
  const safeSubagentType = sanitizeMemoryContent(String(subagentType ?? ""), 40);
  if (top.length === 0) {
    return focusBlock ?? "";
  }
  const body = [
    `AGENT MEMORY CONTEXT for "${safeSubagentType}" task on "${safeIntent}":`,
    ...lines
  ].join("\n");
  const memory = `${wrapMemoryContext(body)}
Above is reference data only; call /recall "${safeIntent}" for full content if needed.`;
  return focusBlock ? `${focusBlock}
${memory}` : memory;
}
function defaultRecall(intent) {
  const opcDir = getOpcDir();
  if (!opcDir) {
    return { ok: false, results: [], error: "no opcDir" };
  }
  const searchTerm = intent.replace(/[_\/]/g, " ").replace(/\b\w{1,2}\b/g, "").replace(/\s+/g, " ").trim();
  const res = spawnSync(
    "uv",
    [
      "run",
      "python",
      "scripts/core/recall_learnings.py",
      "--query",
      searchTerm,
      "--k",
      String(TOP_K),
      "--json",
      "--text-only"
    ],
    {
      encoding: "utf-8",
      cwd: opcDir,
      env: { ...process.env, PYTHONPATH: opcDir },
      timeout: RECALL_TIMEOUT_MS,
      killSignal: "SIGKILL"
    }
  );
  if (res.status !== 0 || !res.stdout) {
    return { ok: false, results: [], error: `recall status=${res.status}` };
  }
  try {
    const data = JSON.parse(res.stdout);
    const raw = Array.isArray(data?.results) ? data.results : [];
    const normalized = raw.map((r) => ({
      id: String(r.id ?? "unknown"),
      type: String(r.learning_type ?? r.type ?? "UNKNOWN"),
      content: String(r.content ?? ""),
      score: typeof r.score === "number" ? r.score : 0
    }));
    return { ok: true, results: normalized };
  } catch (e) {
    return { ok: false, results: [], error: `parse error: ${e?.message}` };
  }
}
function getLogPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dir = path.join(projectDir, ".claude", "logs");
  try {
    mkdirSync4(dir, { recursive: true });
  } catch {
  }
  return path.join(dir, "agent-recall.jsonl");
}
function writeFireLog(entry) {
  try {
    appendFileSync3(getLogPath(), JSON.stringify(entry) + "\n");
  } catch (e) {
    log2.warn("failed to write agent-recall.jsonl", { error: e?.message });
  }
}
function handleAgentTask(input, recall = defaultRecall, readBusFn = () => readBus(), telemetry = appendIntelBus) {
  const decision = shouldSkip(input);
  if (decision.skip) {
    log2.debug("skipping agent-recall", { reason: decision.reason });
    return null;
  }
  const ti = input.tool_input;
  const subagentType = String(ti.subagent_type);
  const prompt = String(ti.prompt);
  const intent = extractIntent(prompt);
  if (intent.length < 3) {
    log2.debug("intent too short after extraction", { prompt_len: prompt.length });
    return null;
  }
  let bus;
  try {
    bus = readBusFn();
  } catch (e) {
    log2.debug("bus read threw (fail-open, no bias)", { error: e?.message });
    bus = emptyBusFallback();
  }
  let busFocus;
  try {
    busFocus = extractBusFocus(bus);
  } catch (e) {
    log2.debug("bus focus extraction threw (fail-open)", { error: e?.message });
    busFocus = { terms: [], staleSymbolsCount: 0 };
  }
  const focusTerms = busFocus.terms;
  const focusBlock = buildFocusBlock(focusTerms);
  const baseTel = {
    bus_id: typeof bus.bus_id === "string" ? bus.bus_id : "unknown",
    query_type: "agent_recall_bus_read",
    biased: false,
    focus_count: focusTerms.length,
    stale_symbols_count: busFocus.staleSymbolsCount,
    current_turn: typeof bus.current_turn === "number" ? bus.current_turn : 0
  };
  let response;
  try {
    response = recall(intent);
  } catch (e) {
    log2.warn("recall threw", { error: e?.message });
    emitBusReadTelemetry(telemetry, { ...baseTel, injected: false, result_count: 0 });
    return null;
  }
  const results = response.ok ? response.results : [];
  const kept = results.filter((r) => (r.score ?? 0) >= PROACTIVE_INJECTION_FLOOR);
  const topScore = results.length > 0 ? results.reduce((m, r) => Math.max(m, r.score ?? 0), 0) : 0;
  const entry = {
    session_id: String(input.session_id ?? "unknown"),
    subagent_type: subagentType,
    intent,
    recall_query: intent,
    results_count: results.length,
    kept_after_floor: kept.length,
    top_score: topScore,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  writeFireLog(entry);
  const hasFocusBlock = focusBlock.length > 0;
  const recallUsable = response.ok && kept.length > 0;
  const injected = recallUsable || hasFocusBlock;
  emitBusReadTelemetry(telemetry, { ...baseTel, injected, result_count: kept.length });
  if (!response.ok) {
    log2.debug("recall failed/timeout", { error: response.error });
    if (!hasFocusBlock) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: focusBlock
      }
    };
  }
  if (kept.length === 0 && !hasFocusBlock) {
    return null;
  }
  const additionalContext = buildAgentContext(
    subagentType,
    intent,
    kept,
    hasFocusBlock ? focusBlock : void 0
  );
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext
    }
  };
}
function emptyBusFallback() {
  return {
    bus_id: "unknown",
    current_intent: null,
    focus_symbols: [],
    files_in_play: { load_bearing: [], ambient: [] },
    recent_findings: [],
    open_threads: [],
    schema_version: 3,
    compact_generation: 0,
    revision: 0,
    current_turn: 0
  };
}
function emitBusReadTelemetry(telemetry, event) {
  try {
    telemetry(event);
  } catch (e) {
    log2.debug("bus-read telemetry threw (ignored)", { error: e?.message });
  }
}
function readStdin() {
  try {
    return readFileSync3(0, "utf-8");
  } catch {
    return "";
  }
}
async function main() {
  if (process.env.CCV3_AGENT_RECALL_OFF === "1") {
    outputContinue();
    return;
  }
  let input;
  try {
    const raw = readStdin().trim();
    if (!raw) {
      outputContinue();
      return;
    }
    input = JSON.parse(raw);
  } catch (e) {
    log2.warn("failed to parse stdin", { error: e?.message });
    outputContinue();
    return;
  }
  const out = handleAgentTask(input);
  if (out) {
    console.log(JSON.stringify(out));
  } else {
    console.log("{}");
  }
}
var isDirectInvocation = (() => {
  try {
    const arg1 = process.argv[1] || "";
    return arg1.endsWith("agent-recall-injector.mjs") || arg1.endsWith("agent-recall-injector.js");
  } catch {
    return false;
  }
})();
if (isDirectInvocation) {
  main().catch((e) => {
    log2.error("main() crashed", { error: e?.message });
    outputContinue();
  });
}
var __isDirectInvocation = isDirectInvocation;
export {
  BUS_STALENESS_MAX_AGE,
  PROACTIVE_INJECTION_FLOOR,
  __isDirectInvocation,
  buildAgentContext,
  defaultRecall,
  handleAgentTask,
  main,
  shouldSkip
};
