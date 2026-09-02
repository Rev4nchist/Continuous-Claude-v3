#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/post-plan-roadmap.ts
import * as fs2 from "fs";
import * as path2 from "path";
import { spawn } from "child_process";

// src/shared/project-relevance.ts
import * as fs from "fs";
import * as path from "path";
import { homedir } from "node:os";
var IDENTITY_STOPWORDS = /* @__PURE__ */ new Set([
  "claude",
  "continuous",
  "code",
  "anthropic",
  "project",
  "the",
  "app",
  "platform",
  "engine",
  "server",
  "service",
  "system"
]);
var FOREIGN_PROJECT_MARKERS = ["salesforce", "fastmcp"];
function getProjectIdentity(projectDir) {
  const resolvedDir = path.resolve(projectDir);
  const dirName = path.basename(resolvedDir);
  const identity = {
    dirName,
    registryName: null,
    packageName: null,
    projectPath: resolvedDir,
    keywords: [],
    distinctiveKeywords: [],
    otherProjects: [],
    otherProjectTokens: []
  };
  const dirKeywords = tokenize(dirName);
  const keywordSet = new Set(dirKeywords);
  keywordSet.add(dirName.toLowerCase());
  const otherTokenSet = /* @__PURE__ */ new Set();
  const registry = readRegistry(resolvedDir);
  if (registry) {
    for (const project of registry.projects) {
      const projectPath = path.resolve(project.path);
      if (projectPath === resolvedDir) {
        identity.registryName = project.name;
        for (const w of tokenize(project.name)) keywordSet.add(w);
      } else {
        identity.otherProjects.push(project.name);
        for (const w of tokenize(project.name)) {
          if (!IDENTITY_STOPWORDS.has(w)) otherTokenSet.add(w);
        }
      }
    }
  }
  try {
    const pkgPath = path.join(resolvedDir, "package.json");
    const pkgContent = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent);
    if (pkg.name && typeof pkg.name === "string") {
      identity.packageName = pkg.name;
      const cleanName = pkg.name.replace(/^@[^/]+\//, "");
      for (const w of tokenize(cleanName)) keywordSet.add(w);
      keywordSet.add(cleanName.toLowerCase());
    }
  } catch {
  }
  if (identity.registryName) {
    keywordSet.add(identity.registryName.toLowerCase());
  }
  identity.keywords = [...keywordSet];
  identity.distinctiveKeywords = identity.keywords.filter((kw) => !IDENTITY_STOPWORDS.has(kw));
  identity.otherProjectTokens = [...otherTokenSet];
  return identity;
}
function tokenize(name) {
  return name.toLowerCase().split(/[-_\s]+/).filter((w) => w.length > 1);
}
function matchesAsWord(content, term) {
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-_\s/]+/g, "[-_\\s/]+");
  try {
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(content);
  } catch {
    return content.toLowerCase().includes(term.toLowerCase());
  }
}
function isContentRelevantToProject(content, identity) {
  if (!content || content.length < 50) {
    return { relevant: true, confidence: "low", reason: "content too short" };
  }
  const distinctiveNames = [identity.registryName, identity.dirName, identity.packageName].filter((n) => !!n);
  for (const name of distinctiveNames) {
    if (matchesAsWord(content, name)) {
      return { relevant: true, confidence: "high", reason: `matches project identity "${name}"` };
    }
  }
  for (const kw of identity.distinctiveKeywords) {
    if (kw.length < 3) continue;
    if (matchesAsWord(content, kw)) {
      return { relevant: true, confidence: "high", reason: `matches distinctive keyword "${kw}"` };
    }
  }
  if (identity.projectPath && content.toLowerCase().includes(identity.projectPath.toLowerCase())) {
    return { relevant: true, confidence: "high", reason: "mentions this project path" };
  }
  for (const otherName of identity.otherProjects) {
    if (matchesAsWord(content, otherName)) {
      const thisName = identity.registryName || identity.dirName;
      return {
        relevant: false,
        confidence: "high",
        reason: `content mentions "${otherName}" but not "${thisName}"`
      };
    }
  }
  for (const token of identity.otherProjectTokens) {
    if (token.length < 3) continue;
    if (matchesAsWord(content, token)) {
      const thisName = identity.registryName || identity.dirName;
      return {
        relevant: false,
        confidence: "high",
        reason: `content mentions foreign project token "${token}" but no "${thisName}" identity`
      };
    }
  }
  for (const marker of FOREIGN_PROJECT_MARKERS) {
    if (matchesAsWord(content, marker)) {
      const thisName = identity.registryName || identity.dirName;
      return {
        relevant: false,
        confidence: "high",
        reason: `content mentions foreign project "${marker}" but no "${thisName}" identity`
      };
    }
  }
  return { relevant: true, confidence: "low", reason: "no cross-project signals" };
}
function readRegistry(projectDir) {
  const ccv3Dir = process.env.CLAUDE_CCV3_DIR || path.join(homedir(), "continuous-claude");
  const candidates = [
    path.join(projectDir, ".claude", "project-registry.json"),
    path.join(ccv3Dir, ".claude", "project-registry.json")
  ];
  for (const candidate of candidates) {
    try {
      const content = fs.readFileSync(candidate, "utf-8");
      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.projects)) {
        return parsed;
      }
    } catch {
    }
  }
  return null;
}

// src/shared/roadmap-parser.ts
var SECTION_PREFIXES = [
  // Order matters: more specific first.
  { key: "sessions", prefix: "## recent planning" },
  { key: "current", prefix: "## current" },
  { key: "completed", prefix: "## completed" },
  { key: "planned", prefix: "## planned" }
];
function detectSection(strippedLower) {
  for (const { key, prefix } of SECTION_PREFIXES) {
    if (strippedLower.startsWith(prefix)) {
      return key;
    }
  }
  if (strippedLower.startsWith("## ")) {
    return null;
  }
  return void 0;
}
function bucketize(rawPriority) {
  const p = rawPriority.toLowerCase();
  if (p.includes("high")) return "high";
  if (p.includes("low")) return "low";
  return "medium";
}
function parseRoadmap(content) {
  const result = {
    current: null,
    completed: [],
    planned: [],
    sessions: [],
    rawContent: content,
    rawSections: /* @__PURE__ */ new Map()
  };
  if (!content) return result;
  const lines = content.split("\n");
  let section = null;
  let sectionStart = -1;
  const closeSection = (endLine) => {
    if (section && sectionStart >= 0) {
      result.rawSections.set(section, { start: sectionStart, end: endLine });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    const lower = stripped.toLowerCase();
    const detected = detectSection(lower);
    const isAnyH2 = stripped.startsWith("## ");
    const isKnownH2 = typeof detected === "string";
    const isUnrelatedH2 = detected === null;
    if (isKnownH2) {
      closeSection(i);
      section = detected;
      sectionStart = i;
      continue;
    }
    if (isUnrelatedH2) {
      closeSection(i);
      section = null;
      sectionStart = -1;
      continue;
    }
    if (section === "current") {
      if (stripped.startsWith("**") && stripped.endsWith("**") && stripped.length >= 4) {
        const title = stripped.replace(/\*\*/g, "").trim();
        if (title.length > 0) {
          result.current = { title };
        }
        continue;
      }
      const checkboxCurrent = stripped.match(/^-\s*\[\s*\]\s*(.+)$/);
      if (checkboxCurrent && !result.current) {
        result.current = { title: checkboxCurrent[1].trim() };
        continue;
      }
      if (result.current && stripped.startsWith("- ")) {
        const text = stripped.slice(2).trim();
        if (/^started:/i.test(text)) {
          result.current.started = text.replace(/^started:\s*/i, "").trim();
        } else if (/^progress:/i.test(text)) {
          result.current.progress = text.replace(/^progress:\s*/i, "").trim();
        } else {
          if (result.current.description) {
            result.current.description = `${result.current.description}; ${text}`;
          } else {
            result.current.description = text;
          }
        }
        continue;
      }
    }
    if (section === "completed") {
      const m = stripped.match(/^-\s*\[x\]\s*(.+?)(?:\s*\(([^)]+)\))?$/i);
      if (m) {
        result.completed.push({
          title: m[1].trim(),
          completed: m[2] || ""
        });
      }
      continue;
    }
    if (section === "planned") {
      const m = stripped.match(/^-\s*\[\s*\]\s*(.+?)(?:\s*\(([^)]+)\))?$/);
      if (m) {
        const rawPriority = m[2] || "normal";
        result.planned.push({
          title: m[1].trim(),
          priority: rawPriority,
          priorityBucket: bucketize(rawPriority)
        });
      }
      continue;
    }
    if (section === "sessions") {
      const sessHeader = stripped.match(/^###\s*(\d{4}-\d{2}-\d{2}):\s*(.+)$/);
      if (sessHeader) {
        result.sessions.push({
          date: sessHeader[1],
          title: sessHeader[2].trim(),
          decisions: []
        });
        continue;
      }
      if (result.sessions.length > 0 && stripped.startsWith("-")) {
        const last = result.sessions[result.sessions.length - 1];
        last.decisions.push(stripped.slice(1).trim());
      }
      continue;
    }
  }
  closeSection(lines.length);
  return result;
}

// src/shared/roadmap-splice.ts
function applySplices(lines, ops) {
  const byStart = [...ops].sort((a, b) => a.range.start - b.range.start);
  for (let i = 1; i < byStart.length; i++) {
    const prev = byStart[i - 1];
    const cur = byStart[i];
    if (cur.range.start < prev.range.end) {
      throw new Error(
        `applySplices: overlapping ranges -- "${prev.label}" [${prev.range.start}, ${prev.range.end}) and "${cur.label}" [${cur.range.start}, ${cur.range.end})`
      );
    }
  }
  const result = lines.slice();
  const descending = [...ops].sort((a, b) => b.range.start - a.range.start);
  for (const op of descending) {
    result.splice(op.range.start, op.range.end - op.range.start, ...op.lines);
  }
  return result;
}
function insertAfterHeader(section, block, label) {
  return {
    range: { start: section.start + 1, end: section.start + 1 },
    lines: block,
    label
  };
}
function insertAtEof(lines, block, label) {
  return {
    range: { start: lines.length, end: lines.length },
    lines: block,
    label
  };
}
function findSubBlocks(lines, section, headerRe = /^###\s/) {
  const blocks = [];
  let open = null;
  for (let i = section.start; i < section.end; i++) {
    if (headerRe.test(lines[i])) {
      if (open) {
        blocks.push({ header: open.header, range: { start: open.start, end: i } });
      }
      open = { header: lines[i], start: i };
    }
  }
  if (open) {
    blocks.push({ header: open.header, range: { start: open.start, end: section.end } });
  }
  return blocks;
}
function findSessionBlock(lines, section, date) {
  const escapedDate = date.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dateRe = new RegExp(`^###\\s*${escapedDate}:`);
  const blocks = findSubBlocks(lines, section);
  return blocks.find((b) => dateRe.test(b.header)) ?? null;
}
function replaceLine(index, line, label) {
  return { range: { start: index, end: index + 1 }, lines: [line], label };
}

// src/shared/roadmap-audit.ts
import { createHash } from "node:crypto";
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync2, readdirSync, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { basename as basename3, dirname as dirname2, join as join4 } from "node:path";

// src/shared/atomic-write.ts
import {
  writeFileSync,
  renameSync as renameSync2,
  unlinkSync,
  existsSync as existsSync2,
  openSync,
  closeSync,
  readFileSync as readFileSync2,
  statSync as statSync2,
  constants
} from "fs";
import { dirname, basename as basename2, join as join3 } from "path";

// src/shared/logger.ts
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from "fs";
import { join as join2 } from "path";
import { homedir as homedir2 } from "os";
var LOG_DIR = join2(homedir2(), ".claude", "logs");
var LOG_FILE = join2(LOG_DIR, "hooks.log");
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
  const dir = dirname(filePath);
  const tmpFile = join3(dir, `.${basename2(filePath)}.tmp.${process.pid}`);
  try {
    writeFileSync(tmpFile, content, "utf-8");
    renameSync2(tmpFile, filePath);
  } catch (err) {
    try {
      if (existsSync2(tmpFile)) unlinkSync(tmpFile);
    } catch {
    }
    throw err;
  }
}
function acquireLockSync(filePath, timeoutMs = LOCK_TIMEOUT_MS) {
  const lockFile = filePath + ".lock";
  const startTime = Date.now();
  while (true) {
    try {
      const fd = openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeFileSync(fd, `${process.pid}
${Date.now()}`, "utf-8");
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const stat = statSync2(lockFile);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            log.warn("Removing stale lock", { lockFile, ageMs: Date.now() - stat.mtimeMs });
            unlinkSync(lockFile);
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
      unlinkSync(lockFile);
    }
  } catch (err) {
    log.warn("Failed to release lock", { lockFile, error: String(err) });
  }
}
function mutateStateWithLock(filePath, transformFn, opts = {}) {
  const lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const lockStart = Date.now();
  const locked = acquireLockSync(filePath, lockTimeoutMs);
  const waitMs = Date.now() - lockStart;
  if (opts.onLockOutcome) {
    try {
      opts.onLockOutcome({ acquired: locked, wait_ms: waitMs });
    } catch {
    }
  }
  if (!locked) {
    log.warn("mutateStateWithLock: lock not acquired, skipping write", { filePath });
    return false;
  }
  try {
    let current;
    if (!existsSync2(filePath)) {
      current = null;
    } else {
      try {
        current = readFileSync2(filePath, "utf-8");
      } catch (err) {
        log.warn("mutateStateWithLock: existing file unreadable, aborting write", {
          filePath,
          error: String(err)
        });
        return false;
      }
    }
    let next;
    try {
      next = transformFn(current);
    } catch (err) {
      log.error("mutateStateWithLock: transform threw, leaving file untouched", {
        filePath,
        error: String(err)
      });
      return false;
    }
    if (next == null) {
      return false;
    }
    const writeStart = Date.now();
    atomicWriteSync(filePath, next);
    if (opts.onWriteTiming) {
      try {
        opts.onWriteTiming({ write_ms: Date.now() - writeStart });
      } catch {
      }
    }
    return true;
  } catch (err) {
    log.error("mutateStateWithLock: write failed", { filePath, error: String(err) });
    return false;
  } finally {
    releaseLockSync(filePath);
  }
}

// src/shared/roadmap-audit.ts
var MAX_REFUSED_DELETIONS = 20;
var CATASTROPHIC_MIN_RATIO = 0.25;
function sha256Prefix16(content) {
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}
function multisetCounts(lines) {
  const counts = /* @__PURE__ */ new Map();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}
function computeRemovedLines(beforeLines, afterLines) {
  const beforeCounts = multisetCounts(beforeLines);
  const afterCounts = multisetCounts(afterLines);
  const removed = [];
  for (const [line, count] of beforeCounts) {
    const remaining = count - (afterCounts.get(line) ?? 0);
    for (let i = 0; i < remaining; i++) {
      removed.push(line);
    }
  }
  return removed;
}
function defaultWrite(roadmapPath, before, after) {
  const captured = { transformDeclined: false, lockOutcome: null, writeMs: void 0 };
  const wrote = mutateStateWithLock(
    roadmapPath,
    (current) => {
      const observed = current ?? "";
      if (observed === before) return after;
      captured.transformDeclined = true;
      return null;
    },
    {
      onLockOutcome: (o) => {
        captured.lockOutcome = o;
      },
      onWriteTiming: (o) => {
        captured.writeMs = o.write_ms;
      }
    }
  );
  if (wrote) {
    return { wrote: true, wait_ms: captured.lockOutcome?.wait_ms, write_ms: captured.writeMs };
  }
  if (captured.lockOutcome && !captured.lockOutcome.acquired) {
    return { wrote: false, reason: "lock_timeout", wait_ms: captured.lockOutcome.wait_ms };
  }
  if (captured.transformDeclined) {
    return {
      wrote: false,
      reason: "concurrent_modification",
      wait_ms: captured.lockOutcome?.wait_ms
    };
  }
  return { wrote: false, reason: "write_failed", wait_ms: captured.lockOutcome?.wait_ms };
}
var ROADMAP_MANUAL_MARKER = /<!--\s*roadmap-sync\s*:\s*manual\s*-->/i;
var BAK_KEEP = 10;
function roadmapBakPath(projectDir, when = /* @__PURE__ */ new Date()) {
  const slug = basename3(projectDir).replace(/[^A-Za-z0-9._-]/g, "_") || "project";
  const hash = sha256Prefix16(projectDir).slice(0, 8);
  const stamp = when.toISOString().replace(/[:.]/g, "-");
  return join4(homedir3(), ".claude", "state", "roadmap-bak", `${slug}-${hash}`, `${stamp}.md`);
}
function rotateBaks(dir) {
  try {
    const entries = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - BAK_KEEP))) {
      try {
        unlinkSync2(join4(dir, stale));
      } catch {
      }
    }
  } catch {
  }
}
function defaultBackup(bakPath, content) {
  const dir = dirname2(bakPath);
  mkdirSync2(dir, { recursive: true });
  writeFileSync2(bakPath, content, "utf-8");
  rotateBaks(dir);
}
function defaultAppendLog(logPath, line) {
  mkdirSync2(dirname2(logPath), { recursive: true });
  appendFileSync2(logPath, line, "utf-8");
}
function appendAudit(projectDir, record, appendLogDep) {
  try {
    const logPath = join4(projectDir, ".claude", "logs", "roadmap-sync.jsonl");
    const line = JSON.stringify(record) + "\n";
    (appendLogDep ?? defaultAppendLog)(logPath, line);
  } catch {
  }
}
function writeRoadmapGuarded(args) {
  const {
    hook,
    tool,
    roadmapPath,
    projectDir,
    before,
    after,
    ops,
    allowedDeletions,
    allowFullRewrite,
    sessionId,
    deps
  } = args;
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const beforeBytes = Buffer.byteLength(before, "utf-8");
  const afterBytes = Buffer.byteLength(after, "utf-8");
  const base = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    hook,
    tool: tool ?? "unknown",
    project_dir: projectDir,
    roadmap_path: roadmapPath,
    before_sha256: sha256Prefix16(before),
    after_sha256: sha256Prefix16(after),
    before_lines: beforeLines.length,
    after_lines: afterLines.length,
    line_delta: afterLines.length - beforeLines.length,
    before_bytes: beforeBytes,
    after_bytes: afterBytes,
    bytes_delta: afterBytes - beforeBytes,
    ops,
    session_id: sessionId ?? null
  };
  const finish = (outcome, extra = {}) => {
    const record = {
      ...base,
      outcome,
      bak_path: null,
      bak_error: null,
      ...extra
    };
    appendAudit(projectDir, record, deps?.appendLog);
    return { outcome, record };
  };
  if (after === before) {
    return finish("noop");
  }
  if (ROADMAP_MANUAL_MARKER.test(before)) {
    return finish("skipped", { reason: "opt_out_manual" });
  }
  if (!allowFullRewrite) {
    const allowedSet = new Set(allowedDeletions ?? []);
    const removed = computeRemovedLines(beforeLines, afterLines);
    const refused = removed.filter((line) => !allowedSet.has(line));
    if (refused.length > 0) {
      return finish("skipped", {
        reason: "deletion_guard",
        refused_deletions: refused.slice(0, MAX_REFUSED_DELETIONS)
      });
    }
  } else {
    const beforeTrim = before.trim();
    const afterTrim = after.trim();
    const tooSmall = beforeLines.length > 0 && afterLines.length < beforeLines.length * CATASTROPHIC_MIN_RATIO;
    if (beforeTrim !== "" && (afterTrim === "" || tooSmall)) {
      return finish("skipped", { reason: "catastrophic_rewrite" });
    }
  }
  const bakPath = roadmapBakPath(projectDir);
  let bakError = null;
  try {
    (deps?.backup ?? defaultBackup)(bakPath, before);
  } catch (err) {
    bakError = err instanceof Error ? err.message : String(err);
  }
  let writeResult;
  try {
    writeResult = (deps?.write ?? defaultWrite)(roadmapPath, before, after);
  } catch {
    writeResult = { wrote: false, reason: "write_failed" };
  }
  if (!writeResult.wrote) {
    return finish("skipped", {
      reason: writeResult.reason ?? "write_failed",
      bak_path: bakPath,
      bak_error: bakError,
      wait_ms: writeResult.wait_ms,
      write_ms: writeResult.write_ms
    });
  }
  return finish("written", {
    bak_path: bakPath,
    bak_error: bakError,
    wait_ms: writeResult.wait_ms,
    write_ms: writeResult.write_ms
  });
}

// src/post-plan-roadmap.ts
function renderSectionBody(key, sections) {
  const lines = [];
  if (key === "current") {
    lines.push("## Current Focus");
    if (sections.current) {
      lines.push(`**${sections.current.title}**`);
      if (sections.current.description) {
        lines.push(`- ${sections.current.description}`);
      }
      if (sections.current.started) {
        lines.push(`- Started: ${sections.current.started}`);
      }
    } else {
      lines.push("No current focus set.");
    }
  } else if (key === "completed") {
    lines.push("## Completed");
    if (sections.completed.length > 0) {
      for (const item of sections.completed) {
        const dateStr = item.completed ? ` (${item.completed})` : "";
        lines.push(`- [x] ${item.title}${dateStr}`);
      }
    } else {
      lines.push("_No completed items yet._");
    }
  } else if (key === "planned") {
    lines.push("## Planned");
    if (sections.planned.length > 0) {
      for (const item of sections.planned) {
        const bucket = item.priorityBucket || "medium";
        lines.push(`- [ ] ${item.title} (${bucket} priority)`);
      }
    } else {
      lines.push("_No planned items yet._");
    }
  } else {
    lines.push("## Recent Planning Sessions");
    if (sections.sessions.length > 0) {
      for (const session of sections.sessions.slice(0, 5)) {
        lines.push(...renderSessionBlock(session));
      }
    } else {
      lines.push("_No planning sessions recorded._");
    }
  }
  return lines;
}
function renderSessionBlock(session) {
  const lines = [];
  lines.push(`### ${session.date}: ${session.title}`);
  if (session.summary) {
    lines.push(`**Summary:** ${session.summary}`);
    lines.push("");
  }
  if (session.decisions.length > 0) {
    lines.push("**Key Decisions:**");
    for (const decision of session.decisions) {
      lines.push(`- ${decision}`);
    }
    lines.push("");
  }
  if (session.steps && session.steps.length > 0) {
    lines.push("**Implementation:**");
    for (const step of session.steps) {
      lines.push(`- ${step}`);
    }
    lines.push("");
  }
  if (session.files && session.files.length > 0) {
    lines.push(`**Files:** ${session.files.join(", ")}`);
    lines.push("");
  }
  if (session.verification && session.verification.length > 0) {
    lines.push(`**Verification:** ${session.verification[0]}`);
    lines.push("");
  }
  return lines;
}
function renderSessionBlockCompact(session) {
  const lines = [`### ${session.date}: ${session.title}`];
  if (session.planPath) {
    lines.push(`**Plan:** ${session.planPath}`);
  }
  return lines;
}
function generateRoadmap(sections) {
  const lines = ["# Project Roadmap", ""];
  lines.push(...renderSectionBody("current", sections), "");
  lines.push(...renderSectionBody("completed", sections), "");
  lines.push(...renderSectionBody("planned", sections), "");
  lines.push(...renderSectionBody("sessions", sections));
  return lines.join("\n");
}
var FOCUS_FUNCTION_WORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "the",
  "of",
  "and",
  "or",
  "but",
  "for",
  "nor",
  "so",
  "yet",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "into",
  "onto",
  "over",
  "under",
  "via",
  "is",
  "are",
  "as"
]);
function looksFilenameDerived(title) {
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (/[.,;:!?()[\]{}"'`]/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  if (words.length === 0 || words.length > 4) return false;
  if (words.some((w) => FOCUS_FUNCTION_WORDS.has(w.toLowerCase()) && w === w.toLowerCase())) return false;
  return words.every((w) => /^[A-Z]/.test(w));
}
function isSeedableFocusTitle(title) {
  if (!title) return false;
  const trimmed = title.trim();
  if (!trimmed || trimmed === "Planning Session") return false;
  if (looksFilenameDerived(trimmed)) return false;
  return true;
}
var CURRENT_FOCUS_PLACEHOLDER = "No current focus set.";
function findPlaceholderLine(lines, range) {
  for (let i = range.start; i < range.end; i++) {
    if (lines[i].trim() === CURRENT_FOCUS_PLACEHOLDER) return i;
  }
  return null;
}
function applyRoadmapUpdate(doc, update) {
  const original = doc.rawContent;
  if (!original.trim()) {
    const seededCurrent = doc.current === null && isSeedableFocusTitle(update.focusTitle) ? { title: update.focusTitle, started: update.today } : doc.current;
    const seeded = {
      ...doc,
      current: seededCurrent,
      sessions: [update.session, ...doc.sessions]
    };
    const content2 = generateRoadmap(seeded);
    return {
      content: content2,
      ops: [{ label: "fresh-file", lines_removed: 0, lines_added: content2.split("\n").length }]
    };
  }
  const lines = original.split("\n");
  const ops = [];
  const opSummaries = [];
  const addOp = (op) => {
    ops.push(op);
    opSummaries.push({
      label: op.label,
      lines_removed: op.range.end - op.range.start,
      lines_added: op.lines.length
    });
  };
  if (doc.current === null && isSeedableFocusTitle(update.focusTitle)) {
    const currentRange = doc.rawSections.get("current");
    if (currentRange) {
      const placeholderIdx = findPlaceholderLine(lines, currentRange);
      if (placeholderIdx !== null) {
        addOp(replaceLine(placeholderIdx, `**${update.focusTitle}**`, "focus-seed"));
      } else {
        addOp(insertAfterHeader(currentRange, [`**${update.focusTitle}**`], "focus-seed-insert"));
      }
    } else {
      addOp(
        insertAtEof(
          lines,
          ["", "## Current Focus", `**${update.focusTitle}**`, ""],
          "focus-seed-new-section"
        )
      );
    }
  }
  const sessionsRange = doc.rawSections.get("sessions");
  const sessionBlockLines = [...renderSessionBlockCompact(update.session), ""];
  if (sessionsRange) {
    const existing = findSessionBlock(lines, sessionsRange, update.today);
    if (!existing) {
      addOp(insertAfterHeader(sessionsRange, sessionBlockLines, "session-insert"));
    } else {
      const titleMatch = existing.header.match(/^###\s*\d{4}-\d{2}-\d{2}:\s*(.+)$/);
      const existingTitle = titleMatch ? titleMatch[1].trim() : "";
      if (existingTitle !== update.session.title) {
        addOp(insertAfterHeader(sessionsRange, sessionBlockLines, "session-insert-same-day"));
      }
    }
  } else {
    addOp(
      insertAtEof(lines, ["## Recent Planning Sessions", ...sessionBlockLines], "session-insert-new-section")
    );
  }
  const content = applySplices(lines, ops).join("\n");
  return { content, ops: opSummaries };
}
function parseSections(content) {
  const sections = {};
  const lines = content.split("\n");
  let currentSection = "_intro";
  let sectionContent = [];
  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      if (sectionContent.length > 0) {
        sections[currentSection] = sectionContent.join("\n");
      }
      currentSection = h2Match[1].trim().toLowerCase();
      sectionContent = [];
    } else {
      sectionContent.push(line);
    }
  }
  if (sectionContent.length > 0) {
    sections[currentSection] = sectionContent.join("\n");
  }
  return sections;
}
function extractBullets(content, keywords) {
  const bullets = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-") && !trimmed.startsWith("*") && !trimmed.match(/^\d+\./)) {
      continue;
    }
    const bulletText = trimmed.replace(/^[-*]\s*/, "").replace(/^\d+\.\s*/, "").trim();
    if (!bulletText) continue;
    let cleanText = bulletText.replace(/^\[[ x]\]\s*/i, "");
    cleanText = cleanText.replace(/^\*\*([^*]+)\*\*:?\s*/, "$1: ").replace(/^`([^`]+)`\s*[-–]\s*/, "").replace(/^\*([^*]+)\*:?\s*/g, "$1 ").replace(/::\s*\*/g, ": ").replace(/\s+/g, " ").trim();
    if (cleanText.length < 15) continue;
    if (cleanText.startsWith("|") || cleanText.startsWith("```")) continue;
    if (cleanText.match(/^`[^`]+`$/) || cleanText.match(/^[A-Za-z_]+\.[a-z]+$/)) continue;
    if (cleanText.match(/\{[^}]+\}/) && cleanText.length < 50) continue;
    if (keywords) {
      const lower = cleanText.toLowerCase();
      if (keywords.some((kw) => lower.includes(kw))) {
        bullets.push(cleanText);
      }
    } else {
      bullets.push(cleanText);
    }
  }
  return bullets;
}
function extractFirstParagraph(content) {
  const lines = content.split("\n");
  const paragraphLines = [];
  let foundStart = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!foundStart) {
      if (trimmed.startsWith("#") || !trimmed) continue;
      foundStart = true;
    }
    if (foundStart && (!trimmed || trimmed.startsWith("#"))) {
      if (paragraphLines.length > 0) break;
      continue;
    }
    paragraphLines.push(trimmed);
  }
  const summary = paragraphLines.join(" ").slice(0, 300);
  return summary.length === 300 ? summary + "..." : summary;
}
function extractFilesFromContent(content) {
  const files = [];
  const backtickMatches = content.match(/`([^`]+\.[a-z]{2,4})`/gi) || [];
  for (const match of backtickMatches) {
    const file = match.replace(/`/g, "");
    if (file.includes("/") || file.includes("\\") || file.match(/\.\w{2,4}$/)) {
      files.push(file);
    }
  }
  const tableMatches = content.match(/\|\s*`?([^|`]+\.[a-z]{2,4})`?\s*\|/gi) || [];
  for (const match of tableMatches) {
    const file = match.replace(/[|`\s]/g, "");
    if (file.match(/\.\w{2,4}$/)) {
      files.push(file);
    }
  }
  return [...new Set(files)];
}
function extractPlanInfo(planContent, filePath) {
  const sections = parseSections(planContent);
  let title = "Planning Session";
  const titleMatch = planContent.match(/^#\s+(?:Plan:\s*)?(.+)/m);
  if (titleMatch && titleMatch[1].trim() !== "Planning Session") {
    title = titleMatch[1].trim();
  } else if (filePath) {
    const basename4 = filePath.replace(/\\/g, "/").split("/").pop()?.replace(".md", "") || "";
    if (basename4 && !basename4.match(/^plan[-_]?\d*$/i)) {
      title = basename4.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    }
  }
  let summary = "";
  const summarySection = sections["summary"] || sections["problem summary"] || sections["purpose"] || sections["overview"];
  if (summarySection) {
    summary = extractFirstParagraph(summarySection);
  } else if (sections["_intro"]) {
    summary = extractFirstParagraph(sections["_intro"]);
  }
  const decisionSection = sections["decisions"] || sections["key decisions"] || sections["approach"] || "";
  const decisions = extractBullets(decisionSection);
  const implSection = sections["implementation plan"] || sections["implementation"] || sections["steps"] || sections["plan"] || "";
  let steps = extractBullets(implSection);
  if (steps.length === 0 && sections["step 1"]) {
    steps = Object.keys(sections).filter((k) => k.match(/^step \d/)).map((k) => sections[k].split("\n")[0]?.trim() || k).filter(Boolean);
  }
  const verifySection = sections["verification"] || sections["verification plan"] || sections["testing"] || sections["test plan"] || "";
  const verification = extractBullets(verifySection);
  const filesSection = sections["files to modify"] || sections["files"] || sections["affected files"] || "";
  let affectedFiles = extractFilesFromContent(filesSection);
  if (affectedFiles.length === 0) {
    affectedFiles = extractFilesFromContent(planContent);
  }
  return {
    title,
    summary: summary.slice(0, 500),
    decisions: decisions.slice(0, 10),
    steps: steps.slice(0, 8),
    verification: verification.slice(0, 5),
    affectedFiles: affectedFiles.slice(0, 10)
  };
}
function storePlanningLearnings(planInfo, projectDir) {
  const decisions = planInfo.decisions.slice(0, 5);
  if (decisions.length === 0) {
    console.error("No decisions to store in memory");
    return;
  }
  const contentLines = [
    `Planning: ${planInfo.title}`,
    "",
    "Decisions:",
    ...decisions.map((d) => `- ${d}`)
  ];
  if (planInfo.steps.length > 0) {
    contentLines.push("", "Key Steps:", ...planInfo.steps.slice(0, 3).map((s) => `- ${s}`));
  }
  const content = contentLines.join("\n");
  const opcDir = process.env.CLAUDE_OPC_DIR || path2.join(process.env.USERPROFILE || process.env.HOME || "", "continuous-claude", "opc");
  const sessionId = `plan-${Date.now()}`;
  try {
    const child = spawn("uv", [
      "run",
      "python",
      "scripts/core/store_learning.py",
      "--session-id",
      sessionId,
      "--type",
      "ARCHITECTURAL_DECISION",
      "--content",
      content,
      "--context",
      `planning: ${planInfo.title}`,
      "--tags",
      "planning,decisions,architecture",
      "--confidence",
      "high"
    ], {
      cwd: opcDir,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PYTHONPATH: "." }
    });
    child.unref();
  } catch {
  }
}
async function main() {
  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (data.tool_name !== "ExitPlanMode") {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const roadmapPath = path2.join(projectDir, "ROADMAP.md");
  const planDirNested = path2.join(projectDir, ".claude", "plans");
  const planDirDirect = path2.join(projectDir, "plans");
  const userHome = process.env.USERPROFILE || process.env.HOME || "";
  const userPlanDir = path2.join(userHome, ".claude", "plans");
  const hasPlanFiles = (dir) => {
    try {
      return fs2.existsSync(dir) && fs2.readdirSync(dir).some((f) => f.endsWith(".md"));
    } catch {
      return false;
    }
  };
  const planDir = hasPlanFiles(planDirNested) ? planDirNested : hasPlanFiles(planDirDirect) ? planDirDirect : hasPlanFiles(userPlanDir) ? userPlanDir : planDirNested;
  const isGlobalPlanDir = planDir === userPlanDir;
  const STALENESS_THRESHOLD_MS = 6e5;
  let planContent = "";
  let latestPlanPath;
  if (fs2.existsSync(planDir)) {
    const now = Date.now();
    const planFiles = fs2.readdirSync(planDir).filter((f) => f.endsWith(".md") && !f.startsWith("_")).map((f) => ({
      name: f,
      mtime: fs2.statSync(path2.join(planDir, f)).mtime.getTime()
    })).filter((f) => {
      if (isGlobalPlanDir) return now - f.mtime < STALENESS_THRESHOLD_MS;
      return true;
    }).sort((a, b) => b.mtime - a.mtime);
    if (planFiles.length > 0) {
      planContent = fs2.readFileSync(path2.join(planDir, planFiles[0].name), "utf-8");
      latestPlanPath = path2.join(planDir, planFiles[0].name);
    }
  }
  const toolOutput = data.tool_output || data.tool_result || "";
  if (!planContent && toolOutput) {
    planContent = toolOutput;
  }
  let sections;
  if (fs2.existsSync(roadmapPath)) {
    const existingContent = fs2.readFileSync(roadmapPath, "utf-8");
    sections = parseRoadmap(existingContent);
  } else {
    sections = {
      current: null,
      completed: [],
      planned: [],
      sessions: [],
      rawContent: "",
      rawSections: /* @__PURE__ */ new Map()
    };
  }
  const planInfo = extractPlanInfo(planContent, latestPlanPath);
  const identity = getProjectIdentity(projectDir);
  const relevance = isContentRelevantToProject(planContent, identity);
  if (!relevance.relevant) {
    console.error(`[post-plan-roadmap] BLOCKED: Plan is about a different project. ${relevance.reason}`);
    console.log(JSON.stringify({
      result: "continue",
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `ROADMAP update skipped: cross-project guard triggered. "${planInfo.title}" does not match project "${identity.dirName}". ${relevance.reason}`
      }
    }));
    return;
  }
  const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
  const planPathForEntry = latestPlanPath ? path2.isAbsolute(latestPlanPath) && latestPlanPath.startsWith(projectDir) ? path2.relative(projectDir, latestPlanPath).split(path2.sep).join("/") : latestPlanPath : void 0;
  const newSession = {
    date: today,
    planPath: planPathForEntry,
    title: planInfo.title,
    summary: planInfo.summary || void 0,
    decisions: planInfo.decisions.slice(0, 5),
    steps: planInfo.steps.length > 0 ? planInfo.steps.slice(0, 5) : void 0,
    verification: planInfo.verification.length > 0 ? planInfo.verification.slice(0, 3) : void 0,
    files: planInfo.affectedFiles.length > 0 ? planInfo.affectedFiles.slice(0, 8) : void 0
  };
  const { content: newContent, ops } = applyRoadmapUpdate(sections, {
    session: newSession,
    today,
    focusTitle: planInfo.title
  });
  const wasFreshFile = !sections.rawContent.trim();
  const focusSeeded = ops.some((o) => o.label === "focus-seed");
  const allowedDeletions = focusSeeded ? [CURRENT_FOCUS_PLACEHOLDER] : [];
  const { outcome, record } = writeRoadmapGuarded({
    hook: "post-plan-roadmap",
    tool: data.tool_name,
    roadmapPath,
    projectDir,
    before: sections.rawContent,
    after: newContent,
    ops,
    allowedDeletions,
    allowFullRewrite: wasFreshFile,
    sessionId: data.session_id ?? null
  });
  storePlanningLearnings(planInfo, projectDir);
  console.error(`[post-plan-roadmap] ROADMAP.md ${outcome}: ${planInfo.title}`);
  const stats = [
    `Goal: ${planInfo.title}`,
    `Decisions: ${planInfo.decisions.length}`,
    `Steps: ${planInfo.steps.length}`,
    `Files: ${planInfo.affectedFiles.length}`
  ].join(" | ");
  const advisories = [];
  const focusOpLabels = new Set(ops.map((o) => o.label));
  const focusWasSeeded = focusOpLabels.has("focus-seed") || focusOpLabels.has("focus-seed-insert") || focusOpLabels.has("focus-seed-new-section");
  if (sections.current !== null) {
    advisories.push(
      `Current Focus unchanged ("${sections.current.title}" is still active) -- new goal "${planInfo.title}" was NOT recorded there. Run /roadmap focus to switch.`
    );
  } else if (!focusWasSeeded) {
    advisories.push(
      `Current Focus left vacant -- "${planInfo.title}" did not pass the seed quality gate (looks like a placeholder or filename-derived title). Run /roadmap focus to set it manually.`
    );
  }
  const sessionAdded = ops.some((o) => o.label.startsWith("session-insert"));
  const totalSessionBlocks = sections.sessions.length + (sessionAdded ? 1 : 0);
  if (totalSessionBlocks > 8) {
    advisories.push(
      `Recent Planning Sessions now has ${totalSessionBlocks} entries -- consider an archive sweep into ROADMAP.archive.md.`
    );
  }
  const contextLines = outcome === "written" ? ["Planning session recorded:", stats, `ROADMAP: ${roadmapPath}`] : [
    `ROADMAP entry NOT recorded (outcome: ${outcome}${record.reason ? `, reason: ${record.reason}` : ""}).`,
    stats,
    `ROADMAP: ${roadmapPath}`
  ];
  contextLines.push(...advisories);
  const output = {
    result: "continue",
    message: outcome === "written" ? `\u{1F4CB} ROADMAP.md updated: ${planInfo.title}` : `\u26A0\uFE0F ROADMAP.md NOT updated (${outcome}): ${planInfo.title}`,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: contextLines.join("\n")
    }
  };
  console.log(JSON.stringify(output));
}
async function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve2(data));
    setTimeout(() => resolve2(data), 1e3).unref();
  });
}
main().catch((err) => {
  console.error("[post-plan-roadmap] Error:", err.message);
  console.log(JSON.stringify({ result: "continue" }));
});
export {
  applyRoadmapUpdate,
  extractBullets,
  extractPlanInfo,
  renderSessionBlock,
  renderSessionBlockCompact
};
