#!/usr/bin/env node
import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/hook-error-pipeline.ts
import { spawnSync } from "child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
var ERROR_LOG_DIR = join(tmpdir(), "claude-hook-errors");
var ERROR_LOG_FILE = join(ERROR_LOG_DIR, "recent-errors.json");
var MAX_ERRORS = 50;
function getOpcDir() {
  return process.env.CLAUDE_OPC_DIR || join(process.env.HOME || process.env.USERPROFILE || "", "continuous-claude", "opc");
}
function ensureErrorDir() {
  if (!existsSync(ERROR_LOG_DIR)) {
    mkdirSync(ERROR_LOG_DIR, { recursive: true });
  }
}
function loadRecentErrors() {
  ensureErrorDir();
  if (!existsSync(ERROR_LOG_FILE)) {
    return [];
  }
  try {
    return JSON.parse(readFileSync(ERROR_LOG_FILE, "utf-8"));
  } catch {
    return [];
  }
}
function saveRecentErrors(errors) {
  ensureErrorDir();
  const trimmed = errors.slice(-MAX_ERRORS);
  writeFileSync(ERROR_LOG_FILE, JSON.stringify(trimmed, null, 2));
}
function isDuplicateError(errors, newError) {
  const fiveMinAgo = Date.now() - 5 * 60 * 1e3;
  return errors.some(
    (e) => e.hookName === newError.hookName && e.errorMessage === newError.errorMessage && e.timestamp > fiveMinAgo
  );
}
function storeErrorAsLearning(error) {
  const opcDir = getOpcDir();
  const storeScript = join(opcDir, "scripts", "core", "store_learning.py");
  if (!existsSync(storeScript)) {
    console.error("[HookErrorPipeline] store_learning.py not found");
    return;
  }
  const content = `Hook '${error.hookName}' failed with error: ${error.errorMessage}. ${error.errorStack ? `Stack: ${error.errorStack.substring(0, 300)}` : ""}`;
  const tags = [
    "auto_captured",
    "hook_failure",
    `hook:${error.hookName}`,
    "scope:global",
    "infrastructure"
  ];
  try {
    const cappedContent = content.substring(0, 1500);
    spawnSync(
      "uv",
      [
        "run",
        "python",
        "scripts/core/store_learning.py",
        "--session-id",
        error.sessionId || "unknown",
        "--type",
        "FAILED_APPROACH",
        "--content",
        cappedContent,
        "--context",
        "Hook infrastructure failure",
        "--tags",
        tags.join(","),
        "--confidence",
        "medium"
      ],
      { cwd: opcDir, shell: false, encoding: "utf-8", timeout: 1e4, stdio: ["pipe", "pipe", "pipe"] }
    );
    console.error(`[HookErrorPipeline] Stored hook failure learning for '${error.hookName}'`);
  } catch (err) {
    console.error(`[HookErrorPipeline] Failed to store learning: ${err}`);
  }
}
function captureHookError(hookName, error, sessionId, storeAsLearning = true) {
  const hookError = {
    hookName,
    errorMessage: error instanceof Error ? error.message : String(error),
    errorStack: error instanceof Error ? error.stack : void 0,
    timestamp: Date.now(),
    sessionId
  };
  const errors = loadRecentErrors();
  if (isDuplicateError(errors, hookError)) {
    console.error(`[HookErrorPipeline] Skipping duplicate error for '${hookName}'`);
    return;
  }
  errors.push(hookError);
  saveRecentErrors(errors);
  if (storeAsLearning) {
    storeErrorAsLearning(hookError);
  }
}
async function wrapWithErrorCapture(hookName, sessionId, fn, fallbackOutput = {}) {
  try {
    return await fn();
  } catch (error) {
    captureHookError(hookName, error, sessionId);
    console.log(JSON.stringify(fallbackOutput));
    return void 0;
  }
}
function createSafeHook(hookName, hookFn) {
  return async () => {
    let sessionId;
    try {
      const rawInput = readFileSync(0, "utf-8");
      if (!rawInput.trim()) {
        console.log(JSON.stringify({}));
        return;
      }
      let input;
      try {
        input = JSON.parse(rawInput);
        sessionId = input.session_id;
      } catch {
        console.log(JSON.stringify({}));
        return;
      }
      await hookFn(input);
    } catch (error) {
      captureHookError(hookName, error, sessionId);
      console.log(JSON.stringify({}));
    }
  };
}
function getErrorSummary() {
  const errors = loadRecentErrors();
  const byHook = {};
  for (const error of errors) {
    byHook[error.hookName] = (byHook[error.hookName] || 0) + 1;
  }
  const oneHourAgo = Date.now() - 60 * 60 * 1e3;
  const recent = errors.filter((e) => e.timestamp > oneHourAgo);
  return {
    total: errors.length,
    byHook,
    recent
  };
}
if (__require.main === module) {
  const summary = getErrorSummary();
  console.log(JSON.stringify(summary, null, 2));
}
export {
  captureHookError,
  createSafeHook,
  getErrorSummary,
  wrapWithErrorCapture
};
