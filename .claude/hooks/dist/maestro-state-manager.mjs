#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);

// src/maestro-state-manager.ts
import { readFileSync as readFileSync2, existsSync as existsSync4, unlinkSync as unlinkSync3 } from "fs";

// src/shared/output.ts
function outputContinue() {
  console.log(JSON.stringify({ result: "continue" }));
}
function outputWithMessage(message, hookEventName) {
  if (!message || !message.trim()) {
    outputContinue();
    return;
  }
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext: message }
  }));
}

// src/shared/session-isolation.ts
import { tmpdir, hostname } from "os";
import { join } from "path";
import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
function getSessionId() {
  if (process.env.CLAUDE_SESSION_ID) {
    return process.env.CLAUDE_SESSION_ID;
  }
  const host = hostname().replace(/[^a-zA-Z0-9]/g, "").substring(0, 8);
  return `${host}-${process.pid}`;
}
function getSessionStatePath(baseName, sessionId) {
  const sid = sessionId || getSessionId();
  const safeSid = sid.replace(/[^a-zA-Z0-9-_]/g, "_").substring(0, 32);
  return join(tmpdir(), `claude-${baseName}-${safeSid}.json`);
}
function getLegacyStatePath(baseName) {
  return join(tmpdir(), `claude-${baseName}.json`);
}
function getStatePathWithMigration(baseName, sessionId) {
  const sessionPath = getSessionStatePath(baseName, sessionId);
  const legacyPath = getLegacyStatePath(baseName);
  if (existsSync(sessionPath)) {
    return sessionPath;
  }
  if (existsSync(legacyPath)) {
    try {
      const stat = statSync(legacyPath);
      const oneHourAgo = Date.now() - 60 * 60 * 1e3;
      if (stat.mtimeMs > oneHourAgo) {
        return legacyPath;
      }
    } catch {
    }
  }
  return sessionPath;
}
function cleanupOldStateFiles(baseName, maxAgeMs = 24 * 60 * 60 * 1e3) {
  const tmpDir = tmpdir();
  const pattern = new RegExp(`^claude-${baseName}-.*\\.json$`);
  let cleaned = 0;
  try {
    const files = readdirSync(tmpDir);
    const now = Date.now();
    for (const file of files) {
      if (!pattern.test(file)) continue;
      const fullPath = join(tmpDir, file);
      try {
        const stat = statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(fullPath);
          cleaned++;
        }
      } catch {
      }
    }
  } catch {
  }
  return cleaned;
}

// src/shared/logger.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync, statSync as statSync2, renameSync } from "fs";
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
      const stat = statSync2(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        const rotated = LOG_FILE + ".1";
        renameSync(LOG_FILE, rotated);
      }
    }
  } catch {
  }
}
function getSessionId2() {
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
  function log4(level, msg, data) {
    if (!shouldLog(level)) return;
    const entry = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      hook: hookName,
      msg,
      sessionId: getSessionId2()
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
    debug: (msg, data) => log4("debug", msg, data),
    info: (msg, data) => log4("info", msg, data),
    warn: (msg, data) => log4("warn", msg, data),
    error: (msg, data) => log4("error", msg, data)
  };
}

// src/shared/atomic-write.ts
import {
  writeFileSync,
  renameSync as renameSync2,
  unlinkSync as unlinkSync2,
  existsSync as existsSync3,
  openSync,
  closeSync,
  readFileSync,
  statSync as statSync3,
  constants
} from "fs";
import { dirname as dirname2, basename as basename2, join as join3 } from "path";
var log = createLogger("atomic-write");
var LOCK_STALE_MS = 1e4;
var LOCK_RETRY_MS = 50;
var LOCK_TIMEOUT_MS = 5e3;
function atomicWriteSync(filePath, content) {
  const dir = dirname2(filePath);
  const tmpFile = join3(dir, `.${basename2(filePath)}.tmp.${process.pid}`);
  try {
    writeFileSync(tmpFile, content, "utf-8");
    renameSync2(tmpFile, filePath);
  } catch (err) {
    try {
      if (existsSync3(tmpFile)) unlinkSync2(tmpFile);
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
    if (existsSync3(lockFile)) {
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
function readStateWithLock(filePath) {
  if (!existsSync3(filePath)) return null;
  const locked = acquireLockSync(filePath, 2e3);
  try {
    return readFileSync(filePath, "utf-8");
  } catch (err) {
    log.error("State read failed", { filePath, error: String(err) });
    return null;
  } finally {
    if (locked) {
      releaseLockSync(filePath);
    }
  }
}

// src/shared/state-schema.ts
var log2 = createLogger("state-schema");
var VALID_TASK_TYPES = ["implementation", "research", "unknown"];
function validateMaestroState(obj, sessionId) {
  if (!obj || typeof obj !== "object") {
    log2.warn("Maestro state is not an object", { received: typeof obj, sessionId });
    return null;
  }
  const s = obj;
  if (typeof s.active !== "boolean") {
    log2.warn('Maestro state missing or invalid "active" field', { value: s.active, sessionId });
    return null;
  }
  if (typeof s.taskType !== "string" || !VALID_TASK_TYPES.includes(s.taskType)) {
    log2.warn('Maestro state missing or invalid "taskType" field', { value: s.taskType, sessionId });
    return null;
  }
  for (const field of ["reconComplete", "interviewComplete", "planApproved"]) {
    if (typeof s[field] !== "boolean") {
      log2.warn(`Maestro state missing or invalid "${field}" field`, { value: s[field], sessionId });
      return null;
    }
  }
  if (typeof s.activatedAt !== "number" || s.activatedAt <= 0) {
    log2.warn('Maestro state missing or invalid "activatedAt" field', { value: s.activatedAt, sessionId });
    return null;
  }
  if (s.lastActivity !== void 0 && typeof s.lastActivity !== "number") {
    log2.warn('Maestro state invalid "lastActivity" field', { value: s.lastActivity, sessionId });
    return null;
  }
  if (s.sessionId !== void 0 && typeof s.sessionId !== "string") {
    log2.warn('Maestro state invalid "sessionId" field', { value: s.sessionId, sessionId });
    return null;
  }
  return obj;
}

// src/maestro-state-manager.ts
var say = (message) => outputWithMessage(message, "UserPromptSubmit");
var log3 = createLogger("maestro-state-manager");
var STATE_BASE_NAME = "maestro-state";
var STATE_TTL = 4 * 60 * 60 * 1e3;
function getStateFile(sessionId) {
  return getStatePathWithMigration(STATE_BASE_NAME, sessionId);
}
function defaultState() {
  return {
    active: false,
    taskType: "unknown",
    reconComplete: false,
    interviewComplete: false,
    planApproved: false,
    activatedAt: 0
  };
}
function readState(sessionId) {
  const stateFile = getStateFile(sessionId);
  if (!existsSync4(stateFile)) {
    return defaultState();
  }
  try {
    const content = readStateWithLock(stateFile);
    if (!content) return defaultState();
    const state = validateMaestroState(JSON.parse(content), sessionId);
    if (!state) return defaultState();
    const lastTime = state.lastActivity || state.activatedAt;
    if (Date.now() - lastTime > STATE_TTL) {
      return defaultState();
    }
    return state;
  } catch (err) {
    log3.error("State file corrupted", { error: String(err), sessionId });
    return defaultState();
  }
}
function writeState(state, sessionId) {
  const stateFile = getStateFile(sessionId);
  try {
    state.lastActivity = Date.now();
    state.sessionId = sessionId;
    writeStateWithLock(stateFile, JSON.stringify(state, null, 2));
  } catch {
  }
}
function clearState(sessionId) {
  const stateFile = getStateFile(sessionId);
  try {
    if (existsSync4(stateFile)) {
      unlinkSync3(stateFile);
    }
  } catch {
  }
}
function readStdin() {
  return readFileSync2(0, "utf-8");
}
var ACTIVATION_PATTERNS = [
  /\b(yes,?\s*)?use\s+maestro\b/i,
  /\borchestrate\s+(this|it)\b/i,
  /\bstart\s+maestro\b/i,
  /\bmaestro\s+mode\b/i,
  /^\/maestro$/i
];
var RECON_COMPLETE_PATTERNS = [
  /\brecon\s+complete\b/i,
  /\bexploration\s+complete\b/i,
  /\bscouting\s+(is\s+)?complete\b/i,
  /\bdone\s+(with\s+)?(recon|exploration|scouting)\b/i
];
var INTERVIEW_COMPLETE_PATTERNS = {
  positive: [
    /^interview\s+complete[\s\.!]*$/i,
    /^discovery\s+complete[\s\.!]*$/i,
    /^done\s+(with\s+)?(interview|questions)[\s\.!]*$/i,
    /\bthe\s+interview\s+is\s+complete\b/i
  ],
  negative: [
    /\?/,
    /\bnot\b/i,
    /\bmore\s+questions\b/i,
    /\bstill\b/i,
    /\bwhen\b/i,
    /\blet\s+me\s+know\b/i,
    /\bshould\b/i,
    /\bsignal\b/i
  ]
};
var IMPLEMENTATION_PATTERNS = [
  /\b(build|create|implement|add|develop|make|write)\b/i,
  /\b(feature|component|service|api|endpoint|module)\b/i,
  /\b(fix|debug|refactor|update|change)\b/i
];
var RESEARCH_PATTERNS = [
  /\b(research|understand|learn|explore|how\s+does|what\s+is)\b/i,
  /\b(best\s+practices|documentation|docs|patterns)\b/i
];
var PLAN_APPROVAL_PATTERNS = {
  positive: [
    /^(yes|approve|approved|proceed|go\s*ahead|looks\s*good|do\s*it|lgtm)[\s,\.!]*$/i,
    /^yes,?\s*(proceed|go\s*ahead|do\s*it|let'?s?\s*(do|go))[\s\.!]*$/i,
    /\bapprove\s+(the\s+)?plan\b/i,
    /\bplan\s+approved\b/i,
    /\bproceed\s+with\s+(the\s+)?plan\b/i
  ],
  negative: [
    /\bbut\b/i,
    /\bhowever\b/i,
    /\bwait\b/i,
    /\bhold\s+on\b/i,
    /\?/,
    /\bfirst\b/i,
    /\bbefore\b/i,
    /\bconcern/i,
    /\bquestion/i,
    /\bmaybe\b/i,
    /\bnot\s+yet\b/i
  ]
};
var CANCEL_PATTERNS = {
  positive: [
    /\bcancel\s+maestro\b/i,
    /\bstop\s+orchestrat/i,
    /\bexit\s+maestro\b/i,
    /\bdisable\s+maestro\b/i
  ],
  negative: [
    /\bdon'?t\b/i,
    /\bdo\s+not\b/i,
    /\bkeep\b/i,
    /\bwait\b/i,
    /\bnot\s+yet\b/i,
    /\bshould\s+i\b/i,
    /\bif\s+(this|it|we|I)\b/i,
    /\bI'?ll\b/i,
    /\?/
  ]
};
function matchesAny(text, patterns) {
  return patterns.some((p) => p.test(text));
}
function matchesPattern(text, patternSet) {
  if (Array.isArray(patternSet)) {
    return matchesAny(text, patternSet);
  }
  if (patternSet.negative && matchesAny(text, patternSet.negative)) {
    return false;
  }
  return matchesAny(text, patternSet.positive);
}
async function main() {
  try {
    if (Math.random() < 0.01) {
      cleanupOldStateFiles(STATE_BASE_NAME);
    }
    const rawInput = readStdin();
    if (!rawInput.trim()) {
      outputContinue();
      return;
    }
    let input;
    try {
      input = JSON.parse(rawInput);
    } catch {
      outputContinue();
      return;
    }
    if (!input.prompt || typeof input.prompt !== "string") {
      outputContinue();
      return;
    }
    const sessionId = input.session_id;
    const prompt = input.prompt.trim();
    const state = readState(sessionId);
    if (matchesPattern(prompt, CANCEL_PATTERNS)) {
      log3.info("Maestro deactivated by user", { sessionId });
      clearState(sessionId);
      say("MAESTRO DEACTIVATED\nMaestro orchestration mode disabled.\nReturning to normal operation.");
      return;
    }
    if (!state.active && matchesAny(prompt, ACTIVATION_PATTERNS)) {
      const isResearch = matchesAny(prompt, RESEARCH_PATTERNS) && !matchesAny(prompt, IMPLEMENTATION_PATTERNS);
      const taskType = isResearch ? "research" : "implementation";
      log3.info(`Maestro activated: type=${taskType}`, { sessionId });
      writeState({
        active: true,
        taskType,
        reconComplete: isResearch,
        // Research tasks skip recon
        interviewComplete: false,
        planApproved: false,
        activatedAt: Date.now()
      }, sessionId);
      if (isResearch) {
        say(
          "MAESTRO ACTIVATED (Research Mode)\n\nTask Type: **RESEARCH** (external docs, best practices)\n\n**WORKFLOW:**\n1. Discovery Interview (CURRENT)\n2. Propose Plan\n3. Await Approval\n4. Execute\n\n**YOUR FIRST ACTION:**\nUse AskUserQuestion to clarify:\n- What specifically to research?\n- What format for findings?\n- Any constraints or preferences?\n\nTask tool BLOCKED until interview complete."
        );
      } else {
        say(
          'MAESTRO ACTIVATED (Implementation Mode)\n\nTask Type: **IMPLEMENTATION** (coding, building, fixing)\n\n**WORKFLOW:**\n1. Codebase Recon (CURRENT) - scout allowed\n2. Discovery Interview\n3. Propose Plan\n4. Await Approval\n5. Execute\n\n**YOUR FIRST ACTION:**\nSpawn 1-2 scout agents to understand codebase:\n- Existing patterns relevant to task\n- File structure and conventions\n- Related code that might be affected\n\nOnly scout agents allowed. Other agents BLOCKED.\nSay "recon complete" when done exploring.'
        );
      }
      return;
    }
    if (state.active) {
      if (!state.reconComplete && matchesAny(prompt, RECON_COMPLETE_PATTERNS)) {
        state.reconComplete = true;
        log3.info("State transition: recon complete", { sessionId });
        writeState(state, sessionId);
        say(
          'MAESTRO: Recon Complete\n\n**WORKFLOW PROGRESS:**\n1. [done] Codebase Recon\n2. Discovery Interview (CURRENT)\n3. Propose Plan\n4. Await Approval\n5. Execute\n\n**YOUR NEXT ACTION:**\nUse AskUserQuestion with INFORMED questions based on recon:\n- "I found X pattern, should we follow it?"\n- "Existing code uses Y approach, continue or change?"\n- "This will affect N files, confirm scope?"\n\nTask tool BLOCKED until interview complete.'
        );
        return;
      }
      if (state.reconComplete && !state.interviewComplete && matchesPattern(prompt, INTERVIEW_COMPLETE_PATTERNS)) {
        state.interviewComplete = true;
        log3.info("State transition: interview complete", { sessionId });
        writeState(state, sessionId);
        const step = state.taskType === "research" ? 1 : 2;
        const progress = state.taskType === "implementation" ? "1. [done] Codebase Recon\n2. [done] Discovery Interview\n3. Propose Plan (CURRENT)\n4. Await Approval\n5. Execute" : "1. [done] Discovery Interview\n2. Propose Plan (CURRENT)\n3. Await Approval\n4. Execute";
        say(
          "MAESTRO: Interview Complete\n\n**WORKFLOW PROGRESS:**\n" + progress + "\n\n**YOUR NEXT ACTION:**\nPresent orchestration plan to user.\nTask tool still BLOCKED until plan approved."
        );
        return;
      }
      if (state.interviewComplete && !state.planApproved && matchesPattern(prompt, PLAN_APPROVAL_PATTERNS)) {
        state.planApproved = true;
        log3.info("State transition: plan approved", { sessionId });
        writeState(state, sessionId);
        say(
          "MAESTRO: Plan Approved\n\n**WORKFLOW PROGRESS:**\n1. [done] Discovery Interview\n2. [done] Propose Plan\n3. [done] Await Approval\n4. Execute (CURRENT)\n\n**Task tool is now UNBLOCKED.**\nYou may spawn agents to execute the plan."
        );
        return;
      }
      if (!state.interviewComplete) {
        const looksLikeAnswers = /\b(build|fix|research|refactor|single|module|system|full|code|plan|understanding|all)\b/i.test(prompt) && prompt.length < 200;
        if (looksLikeAnswers) {
          state.interviewComplete = true;
          writeState(state);
          say(
            "MAESTRO: Answers Received\n\nDiscovery answers received.\n\n**YOUR NEXT ACTION:**\n1. Classify task type based on answers\n2. Present orchestration plan\n3. Wait for approval\n\nTask tool still BLOCKED until plan approved."
          );
          return;
        }
      }
    }
    outputContinue();
  } catch (err) {
    outputContinue();
  }
}
if ((process.argv[1] || "").includes("maestro-state-manager")) {
  main();
}
