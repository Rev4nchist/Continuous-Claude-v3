import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/session-start-continuity.ts
import * as fs3 from "fs";
import * as path3 from "path";
import { execSync, spawnSync } from "child_process";

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

// src/shared/handoff-select.ts
import * as fs2 from "fs";
import * as path2 from "path";
var STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1e3;
var POINTER_MAX = 300;
var TERMINAL_OUTCOMES = ["SUCCEEDED", "FAILED"];
var TERMINAL_STATUSES = ["complete", "completed", "done"];
function isHandoffFile(name) {
  return name.endsWith(".md") || name.endsWith(".yaml") || name.endsWith(".yml");
}
function frontmatter(content) {
  const m = content.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return m ? m[1] : null;
}
function readFrontmatterField(content, key) {
  const fm = frontmatter(content);
  if (fm === null) return null;
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*\\r?$`, "m"));
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
}
function handoffSkipReason(content, mtimeMs, now = Date.now()) {
  const status = content.match(/^status:\s*(\w+)/m)?.[1]?.toLowerCase() ?? "";
  const outcome = content.match(/^outcome:\s*(\w+)/m)?.[1]?.toUpperCase() ?? "";
  if (TERMINAL_STATUSES.includes(status) || TERMINAL_OUTCOMES.includes(outcome)) return "terminal";
  if (now - mtimeMs > STALE_THRESHOLD_MS) return "stale";
  return null;
}
function selectSessionHandoff(handoffsBase, sessionIds, now = Date.now()) {
  const wanted = new Set(sessionIds.filter(Boolean).map((s) => s.toLowerCase()));
  if (wanted.size === 0 || !fs2.existsSync(handoffsBase)) return null;
  let best = null;
  try {
    for (const dir of fs2.readdirSync(handoffsBase)) {
      const dirPath = path2.join(handoffsBase, dir);
      if (!fs2.statSync(dirPath).isDirectory()) continue;
      for (const file of fs2.readdirSync(dirPath)) {
        if (!isHandoffFile(file)) continue;
        const filePath = path2.join(dirPath, file);
        let st;
        let content;
        try {
          st = fs2.statSync(filePath);
          if (!st.isFile() || best && st.mtimeMs <= best.mtime) continue;
          content = fs2.readFileSync(filePath, "utf-8");
        } catch {
          continue;
        }
        const sid = readFrontmatterField(content, "session_id");
        if (!sid || !wanted.has(sid.toLowerCase())) continue;
        best = { path: filePath, content, mtime: st.mtimeMs };
      }
    }
  } catch {
    return null;
  }
  if (!best || handoffSkipReason(best.content, best.mtime, now)) return null;
  return best;
}
function goalAndNow(content) {
  const pick = (key) => {
    const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ") : "";
  };
  return { goal: pick("goal"), now: pick("now") };
}
function clip(text, max) {
  if (max <= 0) return "";
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}
function buildHandoffPointer(handoffPath, content, projectDir) {
  const rel = path2.relative(projectDir, handoffPath).replace(/\\/g, "/");
  const shown = rel && !rel.startsWith("..") ? rel : handoffPath.replace(/\\/g, "/");
  const { goal, now } = goalAndNow(content);
  const head = `Your handoff: ${shown}
`;
  const left = POINTER_MAX - head.length - "goal: \nnow: ".length;
  const goalMax = Math.max(0, Math.min(goal.length, Math.floor(left / 2)));
  const goalText = clip(goal, goalMax);
  const nowText = clip(now, left - goalText.length);
  return `${head}goal: ${goalText}
now: ${nowText}`.slice(0, POINTER_MAX);
}

// src/shared/session-identity.ts
import { closeSync, existsSync as existsSync3, mkdirSync as mkdirSync2, openSync, readFileSync as readFileSync3, readSync, readdirSync as readdirSync2, statSync as statSync3 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join5 } from "path";

// src/shared/logger.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync, statSync as statSync2, renameSync } from "fs";
import { dirname, join as join3 } from "path";
import { homedir as homedir2 } from "os";
var LOG_FILE = process.env.CLAUDE_HOOK_LOG_FILE || join3(homedir2(), ".claude", "logs", "hooks.log");
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

// src/lib/spawn-hidden.ts
import { tmpdir } from "os";
import { join as join4 } from "path";
var RELAY_ERROR_LOG = join4(tmpdir(), "ccv3-spawn-hidden.log");
var RELAY_LAUNCH_FAILED = 127;
var RELAY_SCRIPT = `const{spawn}=require('child_process');const[c,...a]=process.argv.slice(1);const p=spawn(c,a,{stdio:'inherit',windowsHide:true});p.on('error',(e)=>{const m='['+new Date().toISOString()+'] spawn-hidden: cannot start '+c+': '+(e.code||'')+' '+e.message+'\\n';try{process.stderr.write(m)}catch{}try{require('fs').appendFileSync(process.env.CCV3_SPAWN_HIDDEN_LOG||require('path').join(require('os').tmpdir(),'ccv3-spawn-hidden.log'),m)}catch{}process.exit(${RELAY_LAUNCH_FAILED})});p.on('exit',(code)=>process.exit(code??1));`;

// src/shared/session-identity.ts
var NAME_CLIP = 16;
var CLEAR_WINDOW_MS = 12e4;
var TAIL_BYTES = 256 * 1024;
var HEAD_BYTES = 512 * 1024;
var SAFE_ID_RE = /^[0-9a-fA-F-]{8,64}$/;
function identityDir() {
  return process.env.CCV3_IDENTITY_DIR || join5(homedir3(), ".claude", "state", "identity");
}
var shortId = (uuid) => uuid.slice(0, 8);
function identityPath(uuid) {
  return SAFE_ID_RE.test(uuid) ? join5(identityDir(), `${uuid}.json`) : null;
}
function asString(v) {
  return typeof v === "string" && v ? v : null;
}
function asPid(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}
function readIdentity(uuid) {
  if (!uuid) return null;
  const file = identityPath(uuid);
  if (!file) return null;
  try {
    const o = JSON.parse(readFileSync3(file, "utf8"));
    if (!o || typeof o !== "object" || typeof o.uuid !== "string") return null;
    return {
      uuid,
      short: shortId(uuid),
      name: asString(o.name),
      previous: asString(o.previous),
      cwd: asString(o.cwd),
      endedAt: asString(o.endedAt),
      endReason: asString(o.endReason),
      pid: asPid(o.pid),
      updatedAt: asString(o.updatedAt) ?? ""
    };
  } catch {
    return null;
  }
}
function clipName(name) {
  const one = (name ?? "").replace(/\s+/g, " ").trim();
  if (!one) return null;
  return one.length > NAME_CLIP ? one.slice(0, NAME_CLIP) : one;
}
var normCwd = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
function previousFromClear(current, cwd, now = Date.now(), name) {
  if (!cwd) return null;
  let cands = [];
  const claimed = /* @__PURE__ */ new Set();
  try {
    for (const f of readdirSync2(identityDir())) {
      if (!f.endsWith(".json")) continue;
      const id = readIdentity(f.slice(0, -5));
      if (!id) continue;
      if (id.uuid !== current && id.previous) claimed.add(id.previous);
      if (id.uuid === current || id.endReason !== "clear" || !id.endedAt || !id.cwd) continue;
      const at = Date.parse(id.endedAt);
      if (!Number.isFinite(at) || now - at > CLEAR_WINDOW_MS || at > now + 5e3) continue;
      if (normCwd(id.cwd) !== normCwd(cwd)) continue;
      cands.push(id);
    }
  } catch {
  }
  cands = cands.filter((c) => !claimed.has(c.uuid));
  const want = clipName(name)?.toLowerCase();
  if (want) {
    const same = cands.filter((c) => clipName(c.name)?.toLowerCase() === want);
    if (same.length) cands = same;
  }
  return cands.length === 1 ? cands[0].uuid : null;
}

// src/session-start-continuity.ts
function buildHandoffDirName(sessionName, sessionId) {
  const uuidShort = sessionId.replace(/-/g, "").slice(0, 8);
  return `${sessionName}-${uuidShort}`;
}
function parseHandoffDirName(dirName) {
  const match = dirName.match(/^(.+)-([0-9a-f]{8})$/i);
  if (match) {
    return { sessionName: match[1], uuidShort: match[2].toLowerCase() };
  }
  return { sessionName: dirName, uuidShort: null };
}
function findSessionHandoffWithUUID(sessionName, sessionId) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const handoffsBase = path3.join(projectDir, "thoughts", "shared", "handoffs");
  if (!fs3.existsSync(handoffsBase)) return null;
  const uuidShort = sessionId.replace(/-/g, "").slice(0, 8).toLowerCase();
  const exactDir = path3.join(handoffsBase, `${sessionName}-${uuidShort}`);
  if (fs3.existsSync(exactDir)) {
    return findMostRecentMdFile(exactDir);
  }
  const legacyDir = path3.join(handoffsBase, sessionName);
  if (fs3.existsSync(legacyDir) && fs3.statSync(legacyDir).isDirectory()) {
    const result = findMostRecentMdFile(legacyDir);
    if (result) return result;
  }
  const allDirs = fs3.readdirSync(handoffsBase).filter((d) => {
    const stat = fs3.statSync(path3.join(handoffsBase, d));
    if (!stat.isDirectory()) return false;
    const { sessionName: parsedName } = parseHandoffDirName(d);
    return parsedName === sessionName;
  });
  allDirs.sort((a, b) => {
    const statA = fs3.statSync(path3.join(handoffsBase, a));
    const statB = fs3.statSync(path3.join(handoffsBase, b));
    return statB.mtime.getTime() - statA.mtime.getTime();
  });
  for (const dir of allDirs) {
    const result = findMostRecentMdFile(path3.join(handoffsBase, dir));
    if (result) return result;
  }
  return null;
}
function isHandoffFile2(filename) {
  return filename.endsWith(".md") || filename.endsWith(".yaml") || filename.endsWith(".yml");
}
function findMostRecentMdFile(dirPath) {
  if (!fs3.existsSync(dirPath)) return null;
  const handoffFiles = fs3.readdirSync(dirPath).filter((f) => isHandoffFile2(f)).sort((a, b) => {
    const statA = fs3.statSync(path3.join(dirPath, a));
    const statB = fs3.statSync(path3.join(dirPath, b));
    return statB.mtime.getTime() - statA.mtime.getTime();
  });
  return handoffFiles.length > 0 ? path3.join(dirPath, handoffFiles[0]) : null;
}
function extractYamlFields(content) {
  const goalMatch = content.match(/^goal:\s*(.+)$/m);
  const nowMatch = content.match(/^now:\s*(.+)$/m);
  if (!goalMatch && !nowMatch) return null;
  return {
    goal: goalMatch ? goalMatch[1].trim().replace(/^["']|["']$/g, "") : "",
    now: nowMatch ? nowMatch[1].trim().replace(/^["']|["']$/g, "") : ""
  };
}
function extractLedgerSection(handoffContent) {
  const match = handoffContent.match(/(?:^|\n)## Ledger\n([\s\S]*?)(?=\n---\n|\n## [^#]|$)/);
  return match ? `## Ledger
${match[1].trim()}` : null;
}
function extractGuardedCurrentFocus(roadmapContent, projectDir) {
  const currentMatch = roadmapContent.match(/## Current Focus\n([\s\S]*?)(?=\n## |$)/);
  if (!currentMatch) return null;
  const currentFocus = currentMatch[1].trim();
  if (!currentFocus) return null;
  const identity = getProjectIdentity(projectDir);
  const relevance = isContentRelevantToProject(currentFocus, identity);
  if (!relevance.relevant) {
    console.error(`[session-start-continuity] buildUnifiedContext: ROADMAP focus appears contaminated, skipping: ${relevance.reason}`);
    return null;
  }
  return currentFocus;
}
function extractNotesSections(roadmapContent) {
  const HEADERS = ["Notes", "For Next Session", "Scratch"];
  const blocks = [];
  for (const header of HEADERS) {
    const re = new RegExp(`## ${header}\\n([\\s\\S]*?)(?=\\n## |$)`);
    const match = roadmapContent.match(re);
    if (match) {
      const body = match[1].trim();
      if (body) {
        blocks.push(`## ${header}
${body}`);
      }
    }
  }
  return blocks;
}
function findSessionHandoff(sessionName) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const handoffDir = path3.join(projectDir, "thoughts", "shared", "handoffs", sessionName);
  if (!fs3.existsSync(handoffDir)) return null;
  const handoffFiles = fs3.readdirSync(handoffDir).filter((f) => isHandoffFile2(f)).sort((a, b) => {
    const statA = fs3.statSync(path3.join(handoffDir, a));
    const statB = fs3.statSync(path3.join(handoffDir, b));
    return statB.mtime.getTime() - statA.mtime.getTime();
  });
  return handoffFiles.length > 0 ? path3.join(handoffDir, handoffFiles[0]) : null;
}
function pruneLedger(ledgerPath) {
  let content = fs3.readFileSync(ledgerPath, "utf-8");
  const originalLength = content.length;
  content = content.replace(/\n### Session Ended \([^)]+\)\n- Reason: \w+\n/g, "");
  const agentReportsMatch = content.match(/## Agent Reports\n([\s\S]*?)(?=\n## |$)/);
  if (agentReportsMatch) {
    const agentReportsSection = agentReportsMatch[0];
    const reports = agentReportsSection.match(/### [^\n]+ \(\d{4}-\d{2}-\d{2}[^)]*\)[\s\S]*?(?=\n### |\n## |$)/g);
    if (reports && reports.length > 10) {
      const keptReports = reports.slice(-10);
      const newAgentReportsSection = "## Agent Reports\n" + keptReports.join("");
      content = content.replace(agentReportsSection, newAgentReportsSection);
    }
  }
  if (content.length !== originalLength) {
    fs3.writeFileSync(ledgerPath, content);
    console.error(`Pruned ledger: ${originalLength} \u2192 ${content.length} bytes`);
  }
}
function getLatestHandoff(handoffDir) {
  if (!fs3.existsSync(handoffDir)) return null;
  const handoffFiles = fs3.readdirSync(handoffDir).filter((f) => isHandoffFile2(f)).sort((a, b) => {
    const statA = fs3.statSync(path3.join(handoffDir, a));
    const statB = fs3.statSync(path3.join(handoffDir, b));
    return statB.mtime.getTime() - statA.mtime.getTime();
  });
  if (handoffFiles.length === 0) return null;
  const latestFile = handoffFiles[0];
  const content = fs3.readFileSync(path3.join(handoffDir, latestFile), "utf-8");
  const isAutoHandoff = latestFile.startsWith("auto-handoff-");
  let taskNumber;
  let status;
  let summary;
  if (isAutoHandoff) {
    const typeMatch = content.match(/type:\s*auto-handoff/i);
    status = typeMatch ? "auto-handoff" : "unknown";
    const timestampMatch = latestFile.match(/auto-handoff-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
    taskNumber = timestampMatch ? timestampMatch[1] : "auto";
    const inProgressMatch = content.match(/## In Progress\n([\s\S]*?)(?=\n## |$)/);
    summary = inProgressMatch ? inProgressMatch[1].trim().split("\n").slice(0, 3).join("; ").substring(0, 150) : "Auto-handoff from pre-compact";
  } else {
    const taskMatch = latestFile.match(/task-(\d+)/);
    taskNumber = taskMatch ? taskMatch[1] : "??";
    const statusMatch = content.match(/status:\s*(success|partial|blocked)/i);
    status = statusMatch ? statusMatch[1] : "unknown";
    const summaryMatch = content.match(/## What Was Done\n([\s\S]*?)(?=\n## |$)/);
    summary = summaryMatch ? summaryMatch[1].trim().split("\n").slice(0, 2).join("; ").substring(0, 150) : "No summary available";
  }
  return {
    filename: latestFile,
    taskNumber,
    status,
    summary,
    isAutoHandoff
  };
}
async function buildUnifiedContext(projectDir, opts = {}) {
  const sections = [];
  let currentGoal = "";
  const roadmapPath = path3.join(projectDir, "ROADMAP.md");
  if (fs3.existsSync(roadmapPath)) {
    try {
      const roadmap = fs3.readFileSync(roadmapPath, "utf-8");
      const guardedFocus = extractGuardedCurrentFocus(roadmap, projectDir);
      if (guardedFocus) {
        const focusSection = `## ROADMAP - Current Focus
${guardedFocus.substring(0, 500)}`;
        currentGoal = focusSection.match(/\*\*([^*]+)\*\*/)?.[1] ?? "";
        if (!opts.skipRoadmapFocus) sections.push(focusSection);
      }
      const sessionMatch = roadmap.match(/### (\d{4}-\d{2}-\d{2}): ([^\n]+)\n([\s\S]*?)(?=\n### |\n## |$)/);
      if (sessionMatch) {
        const sessionContent = sessionMatch[3].substring(0, 400);
        sections.push(`## Recent Planning: ${sessionMatch[2]}
${sessionContent}`);
      }
      const roadmapNotes = extractNotesSections(roadmap);
      for (const note of roadmapNotes) {
        const [header, ...body] = note.split("\n");
        sections.push(`## ROADMAP - ${header.replace(/^##\s*/, "")}
${body.join("\n").substring(0, 800)}`);
      }
    } catch (error) {
      console.error(`Warning: Error reading ROADMAP.md for unified context: ${error}`);
    }
  }
  const treePath = path3.join(projectDir, ".claude", "knowledge-tree.json");
  if (fs3.existsSync(treePath)) {
    try {
      const treeContent = fs3.readFileSync(treePath, "utf-8");
      const tree = JSON.parse(treeContent);
      if (tree.navigation?.common_tasks) {
        const taskNav = Object.entries(tree.navigation.common_tasks).slice(0, 5).map(([task, paths]) => `- ${task}: ${paths.slice(0, 2).join(", ")}`).join("\n");
        if (taskNav) {
          sections.push(`## Quick Navigation
${taskNav}`);
        }
      }
      if (tree.navigation?.entry_points) {
        const entries = Object.entries(tree.navigation.entry_points).slice(0, 3).map(([name, p]) => `- ${name}: ${p}`).join("\n");
        if (entries) {
          sections.push(`## Entry Points
${entries}`);
        }
      }
    } catch (error) {
    }
  }
  if (currentGoal && !opts.skipRecall) {
    const opcDir = process.env.CLAUDE_OPC_DIR || path3.join(process.env.USERPROFILE || "", ".claude");
    try {
      const queryText = currentGoal.replace(/"/g, "").substring(0, 100);
      const proc = spawnSync("uv", [
        "run",
        "python",
        "scripts/core/recall_learnings.py",
        "--query",
        queryText,
        "--k",
        "3",
        "--text-only"
      ], {
        cwd: opcDir,
        encoding: "utf-8",
        timeout: 5e3,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONPATH: "." }
      });
      const result = proc.stdout || "";
      if (result && !result.includes("No results") && result.trim().length > 20) {
        sections.push(wrapMemoryContext(`## Relevant Memories
${sanitizeMemoryContent(result, 600)}`));
      }
    } catch (error) {
    }
  }
  return sections.join("\n\n---\n\n");
}
function getUnmarkedHandoffs() {
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const dbPath = path3.join(projectDir, ".claude", "cache", "artifact-index", "context.db");
    if (!fs3.existsSync(dbPath)) {
      return [];
    }
    const result = execSync(
      `sqlite3 "${dbPath}" "SELECT id, session_name, task_number, task_summary FROM handoffs WHERE outcome = 'UNKNOWN' ORDER BY indexed_at DESC LIMIT 5"`,
      { encoding: "utf-8", timeout: 3e3 }
    );
    if (!result.trim()) {
      return [];
    }
    return result.trim().split("\n").map((line) => {
      const [id, session_name, task_number, task_summary] = line.split("|");
      return { id, session_name, task_number: task_number || null, task_summary: task_summary || "" };
    });
  } catch (error) {
    return [];
  }
}
function ownSessionIds(input, sessionType, projectDir) {
  const current = input.session_id;
  if (!current || current === "unknown") return [];
  const ids = [current];
  if (sessionType === "clear") {
    try {
      const previous = readIdentity(current)?.previous ?? previousFromClear(current, input.cwd || projectDir);
      if (previous) ids.push(previous);
    } catch {
    }
  }
  return ids;
}
async function main() {
  let input;
  try {
    const stdin = await readStdin();
    input = stdin ? JSON.parse(stdin) : { session_id: "unknown", source: "cli" };
  } catch (e) {
    input = { session_id: "unknown", source: "cli" };
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionType = input.source || input.type;
  let message = "";
  let additionalContext = "";
  let usedHandoffLedger = false;
  const handoffsDir = path3.join(projectDir, "thoughts", "shared", "handoffs");
  if (fs3.existsSync(handoffsDir)) {
    try {
      const sessionDirs = fs3.readdirSync(handoffsDir).filter((d) => {
        const stat = fs3.statSync(path3.join(handoffsDir, d));
        return stat.isDirectory();
      });
      let mostRecentLedger = null;
      const sessionScoped = sessionType === "compact" || sessionType === "clear";
      let pointer = "";
      if (sessionScoped) {
        const selected = selectSessionHandoff(handoffsDir, ownSessionIds(input, sessionType, projectDir));
        if (selected) {
          const fields = extractYamlFields(selected.content);
          pointer = buildHandoffPointer(selected.path, selected.content, projectDir);
          mostRecentLedger = {
            content: selected.content,
            sessionName: path3.basename(path3.dirname(selected.path)),
            handoffPath: selected.path,
            mtime: selected.mtime,
            goalSummary: (fields?.goal || "No goal found").substring(0, 100),
            currentFocus: fields?.now || "Unknown"
          };
        }
      }
      for (const sessionName of sessionScoped ? [] : sessionDirs) {
        const handoffPath = findSessionHandoff(sessionName);
        if (handoffPath) {
          const content = fs3.readFileSync(handoffPath, "utf-8");
          const isYaml = handoffPath.endsWith(".yaml") || handoffPath.endsWith(".yml");
          let goalSummary = "No goal found";
          let currentFocus = "Unknown";
          let ledgerContent = "";
          if (isYaml) {
            const yamlFields = extractYamlFields(content);
            if (yamlFields) {
              goalSummary = yamlFields.goal || "No goal found";
              currentFocus = yamlFields.now || "Unknown";
              ledgerContent = content;
            }
          } else {
            const ledgerSection = extractLedgerSection(content);
            if (ledgerSection) {
              const goalMatch = ledgerSection.match(/\*\*Goal:\*\*\s*([^\n]+)/);
              const nowMatch = ledgerSection.match(/### Now\n\[?-?>?\]?\s*([^\n]+)/);
              goalSummary = goalMatch ? goalMatch[1].trim().substring(0, 100) : "No goal found";
              currentFocus = nowMatch ? nowMatch[1].trim() : "Unknown";
              ledgerContent = ledgerSection;
            }
          }
          if (ledgerContent || isYaml && (goalSummary !== "No goal found" || currentFocus !== "Unknown")) {
            const mtime = fs3.statSync(handoffPath).mtime.getTime();
            const skipReason = handoffSkipReason(content, mtime);
            if (skipReason) {
              console.error(`Skipping ${skipReason} handoff: ${sessionName}`);
              continue;
            }
            if (!mostRecentLedger || mtime > mostRecentLedger.mtime) {
              mostRecentLedger = {
                content: ledgerContent || content,
                sessionName,
                handoffPath,
                mtime,
                goalSummary: goalSummary.substring(0, 100),
                currentFocus
              };
            }
          }
        }
      }
      const roadmapPath = path3.join(projectDir, "ROADMAP.md");
      let roadmapCurrentFocus = "";
      let roadmapContext = "";
      if (fs3.existsSync(roadmapPath)) {
        try {
          const roadmapContent = fs3.readFileSync(roadmapPath, "utf-8");
          const currentMatch = roadmapContent.match(/## Current Focus\n([\s\S]*?)(?=\n## |$)/);
          if (currentMatch) {
            const currentSection = currentMatch[1].trim();
            const firstLine = currentSection.split("\n")[0];
            roadmapCurrentFocus = firstLine.replace(/\*\*/g, "").trim();
            roadmapContext = `## ROADMAP - Current Focus
${currentSection}`;
            const identity = getProjectIdentity(projectDir);
            const relevance = isContentRelevantToProject(roadmapCurrentFocus, identity);
            if (!relevance.relevant) {
              console.error(`[session-start-continuity] ROADMAP focus appears contaminated: ${relevance.reason}`);
              roadmapCurrentFocus = "";
              roadmapContext = "";
            }
          }
        } catch (error) {
          console.error(`Warning: Error reading ROADMAP.md: ${error}`);
        }
      }
      if (mostRecentLedger) {
        usedHandoffLedger = true;
        const { sessionName, goalSummary, currentFocus, handoffPath } = mostRecentLedger;
        const handoffFilename = path3.basename(handoffPath);
        if (sessionType === "startup") {
          if (roadmapCurrentFocus) {
            message = `\u{1F4CD} Current: ${roadmapCurrentFocus} | \u{1F4CB} Handoff: ${sessionName} (run /resume_handoff)`;
          } else {
            message = `\u{1F4CB} Handoff Ledger: ${sessionName} \u2192 ${currentFocus} (run /resume_handoff to continue)`;
          }
        } else {
          console.error(`\u2713 Handoff loaded: ${sessionName} \u2192 ${currentFocus}`);
          message = `[${sessionType}] Loaded from handoff: ${handoffFilename} | Goal: ${goalSummary} | Focus: ${currentFocus}`;
          if (sessionScoped) {
            if (roadmapContext) {
              additionalContext = `${roadmapContext}

---

`;
            }
            additionalContext += pointer;
          }
        }
      }
      if (!mostRecentLedger && roadmapCurrentFocus) {
        usedHandoffLedger = true;
        if (sessionType === "startup") {
          message = `\u{1F4CD} Current: ${roadmapCurrentFocus}`;
        } else {
          message = `[${sessionType}] ROADMAP Focus: ${roadmapCurrentFocus}`;
          if (sessionType === "clear" || sessionType === "compact") {
            additionalContext = roadmapContext;
          }
        }
      }
      if (sessionType === "startup" || sessionType === "clear" || sessionType === "compact") {
        try {
          const unifiedContext = await buildUnifiedContext(projectDir, {
            skipRoadmapFocus: sessionScoped,
            skipRecall: sessionType === "compact"
          });
          if (unifiedContext && unifiedContext.trim().length > 50) {
            if (additionalContext) {
              additionalContext = unifiedContext + "\n\n---\n\n" + additionalContext;
            } else {
              additionalContext = unifiedContext;
            }
          }
        } catch (error) {
          console.error(`Warning: Could not build unified context: ${error}`);
        }
      }
    } catch (error) {
      console.error(`Warning: Error scanning handoffs: ${error}`);
    }
  }
  const skipLegacyLedger = sessionType === "compact";
  if (!usedHandoffLedger && !skipLegacyLedger) {
    const ledgerDir = path3.join(projectDir, "thoughts", "ledgers");
    if (!fs3.existsSync(ledgerDir)) {
      console.log(JSON.stringify({ result: "continue" }));
      return;
    }
    const ledgerFiles = fs3.readdirSync(ledgerDir).filter((f) => f.startsWith("CONTINUITY_CLAUDE-") && f.endsWith(".md")).sort((a, b) => {
      const statA = fs3.statSync(path3.join(ledgerDir, a));
      const statB = fs3.statSync(path3.join(ledgerDir, b));
      return statB.mtime.getTime() - statA.mtime.getTime();
    });
    if (ledgerFiles.length > 0) {
      console.error("DEPRECATED: Using legacy ledger file. Migrate to handoff format with /create_handoff");
      const mostRecent = ledgerFiles[0];
      const ledgerPath = path3.join(ledgerDir, mostRecent);
      pruneLedger(ledgerPath);
      const ledgerContent = fs3.readFileSync(ledgerPath, "utf-8");
      const goalMatch = ledgerContent.match(/## Goal\n([\s\S]*?)(?=\n## |$)/);
      const nowMatch = ledgerContent.match(/- Now: ([^\n]+)/);
      const goalSummary = goalMatch ? goalMatch[1].trim().split("\n")[0].substring(0, 100) : "No goal found";
      const currentFocus = nowMatch ? nowMatch[1].trim() : "Unknown";
      const sessionName = mostRecent.replace("CONTINUITY_CLAUDE-", "").replace(".md", "");
      const handoffDir = path3.join(projectDir, "thoughts", "shared", "handoffs", sessionName);
      const latestHandoff = getLatestHandoff(handoffDir);
      if (sessionType === "startup") {
        let startupMsg = `\u{1F4CB} Ledger available: ${sessionName} \u2192 ${currentFocus}`;
        if (latestHandoff) {
          if (latestHandoff.isAutoHandoff) {
            startupMsg += ` | Last handoff: auto (${latestHandoff.status})`;
          } else {
            startupMsg += ` | Last handoff: task-${latestHandoff.taskNumber} (${latestHandoff.status})`;
          }
        }
        startupMsg += " (run /resume_handoff to continue)";
        message = startupMsg;
      } else {
        console.error(`\u2713 Ledger loaded: ${sessionName} \u2192 ${currentFocus}`);
        message = `[${sessionType}] Loaded: ${mostRecent} | Goal: ${goalSummary} | Focus: ${currentFocus}`;
        if (sessionType === "clear" || sessionType === "compact") {
          additionalContext = `Continuity ledger loaded from ${mostRecent}:

${ledgerContent}`;
          const unmarkedHandoffs = getUnmarkedHandoffs();
          if (unmarkedHandoffs.length > 0) {
            additionalContext += `

---

## Unmarked Session Outcomes

`;
            additionalContext += `The following handoffs have no outcome marked. Consider marking them to improve future session recommendations:

`;
            for (const h of unmarkedHandoffs) {
              const taskLabel = h.task_number ? `task-${h.task_number}` : "handoff";
              const summaryPreview = h.task_summary ? h.task_summary.substring(0, 60) + "..." : "(no summary)";
              additionalContext += `- **${h.session_name}/${taskLabel}** (ID: \`${h.id.substring(0, 8)}\`): ${summaryPreview}
`;
            }
            additionalContext += `
To mark an outcome:
\`\`\`bash
cd ~/.claude && uv run python scripts/core/artifact_mark.py --handoff <ID> --outcome SUCCEEDED|PARTIAL_PLUS|PARTIAL_MINUS|FAILED
\`\`\`
`;
          }
          if (latestHandoff) {
            const handoffPath = path3.join(handoffDir, latestHandoff.filename);
            const handoffContent = fs3.readFileSync(handoffPath, "utf-8");
            const handoffLabel = latestHandoff.isAutoHandoff ? "Latest auto-handoff" : "Latest task handoff";
            additionalContext += `

---

${handoffLabel} (${latestHandoff.filename}):
`;
            additionalContext += `Status: ${latestHandoff.status}${latestHandoff.isAutoHandoff ? "" : ` | Task: ${latestHandoff.taskNumber}`}

`;
            const truncatedHandoff = handoffContent.length > 2e3 ? handoffContent.substring(0, 2e3) + "\n\n[... truncated, read full file if needed]" : handoffContent;
            additionalContext += truncatedHandoff;
            const allHandoffs = fs3.readdirSync(handoffDir).filter((f) => (f.startsWith("task-") || f.startsWith("auto-handoff-")) && isHandoffFile2(f)).sort((a, b) => {
              const statA = fs3.statSync(path3.join(handoffDir, a));
              const statB = fs3.statSync(path3.join(handoffDir, b));
              return statB.mtime.getTime() - statA.mtime.getTime();
            });
            if (allHandoffs.length > 1) {
              additionalContext += `

---

All handoffs in ${handoffDir}:
`;
              allHandoffs.forEach((f) => {
                additionalContext += `- ${f}
`;
              });
            }
          }
        }
      }
    } else {
      if (sessionType !== "startup") {
        console.error(`\u26A0 No ledger found. Run /continuity_ledger to track session state.`);
        message = `[${sessionType}] No ledger found. Consider running /continuity_ledger to track session state.`;
      }
    }
  }
  const memoryIndexPath = path3.join(projectDir, ".claude", "memory", "index.json");
  if (fs3.existsSync(memoryIndexPath)) {
    try {
      const indexContent = fs3.readFileSync(memoryIndexPath, "utf-8");
      const index = JSON.parse(indexContent);
      const sessionCount = Object.keys(index.sessions || {}).length;
      const topicCount = Object.keys(index.topic_index || {}).length;
      if (sessionCount > 0 || topicCount > 0) {
        const memorySummary = `

---

## Local Project Memory

Sessions indexed: ${sessionCount} | Topics: ${topicCount}
Query with: \`uv run python ~/.claude/scripts/core/core/project_memory.py query "<topic>" --project-dir "${projectDir}"\``;
        if (additionalContext) {
          additionalContext += memorySummary;
        } else if (sessionType === "clear" || sessionType === "compact") {
          additionalContext = memorySummary;
        }
      }
    } catch {
    }
  }
  const output = { result: "continue" };
  if (message) {
    output.message = message;
    output.systemMessage = message;
  }
  if (additionalContext) {
    output.hookSpecificOutput = {
      hookEventName: "SessionStart",
      additionalContext
    };
  }
  console.log(JSON.stringify(output));
}
async function readStdin() {
  return new Promise((resolve2) => {
    let data = "";
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve2(data));
    setTimeout(() => resolve2(data), 1e3).unref();
  });
}
main().catch((err) => {
  console.error(err);
  console.log(JSON.stringify({ result: "continue" }));
});
export {
  buildHandoffDirName,
  extractGuardedCurrentFocus,
  extractLedgerSection,
  extractNotesSections,
  extractYamlFields,
  findSessionHandoff,
  findSessionHandoffWithUUID,
  parseHandoffDirName
};
