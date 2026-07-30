#!/usr/bin/env node
/**
 * Hook Error Pipeline
 *
 * A utility module that wraps hook execution with error capture.
 * When hooks fail, captures the error and stores it as a learning
 * so the system learns from infrastructure failures.
 *
 * Usage in other hooks:
 *   import { wrapWithErrorCapture } from './hook-error-pipeline.js';
 *
 *   async function main() {
 *     await wrapWithErrorCapture('my-hook-name', async () => {
 *       // Your hook logic here
 *     });
 *   }
 *
 * This module also provides a standalone hook that can be registered
 * to catch unhandled errors from any hook output.
 */

import { spawnSync } from 'child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

interface HookError {
  hookName: string;
  errorMessage: string;
  errorStack?: string;
  timestamp: number;
  sessionId?: string;
}

const ERROR_LOG_DIR = join(tmpdir(), 'claude-hook-errors');
const ERROR_LOG_FILE = join(ERROR_LOG_DIR, 'recent-errors.json');
const MAX_ERRORS = 50;

function getOpcDir(): string {
  return process.env.CLAUDE_OPC_DIR || join(process.env.HOME || process.env.USERPROFILE || '', 'continuous-claude', 'opc');
}

function ensureErrorDir(): void {
  if (!existsSync(ERROR_LOG_DIR)) {
    mkdirSync(ERROR_LOG_DIR, { recursive: true });
  }
}

function loadRecentErrors(): HookError[] {
  ensureErrorDir();
  if (!existsSync(ERROR_LOG_FILE)) {
    return [];
  }
  try {
    return JSON.parse(readFileSync(ERROR_LOG_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveRecentErrors(errors: HookError[]): void {
  ensureErrorDir();
  // Keep only last MAX_ERRORS
  const trimmed = errors.slice(-MAX_ERRORS);
  writeFileSync(ERROR_LOG_FILE, JSON.stringify(trimmed, null, 2));
}

function isDuplicateError(errors: HookError[], newError: HookError): boolean {
  // Check if we've seen this exact error recently (within 5 minutes)
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  return errors.some(e =>
    e.hookName === newError.hookName &&
    e.errorMessage === newError.errorMessage &&
    e.timestamp > fiveMinAgo
  );
}

function storeErrorAsLearning(error: HookError): void {
  const opcDir = getOpcDir();
  const storeScript = join(opcDir, 'scripts', 'core', 'store_learning.py');

  if (!existsSync(storeScript)) {
    console.error('[HookErrorPipeline] store_learning.py not found');
    return;
  }

  const content = `Hook '${error.hookName}' failed with error: ${error.errorMessage}. ${error.errorStack ? `Stack: ${error.errorStack.substring(0, 300)}` : ''}`;

  const tags = [
    'auto_captured',
    'hook_failure',
    `hook:${error.hookName}`,
    'scope:global',
    'infrastructure'
  ];

  try {
    // QW-01: spawn with no shell — pass each argument as a separate argv element.
    // The raw content is handed to Python verbatim (no shell = no injection);
    // the previous sh-style double-quote escaping is removed. The 1500-char cap
    // (a size limit, not escaping) is preserved.
    const cappedContent = content.substring(0, 1500);

    spawnSync(
      'uv',
      [
        'run', 'python', 'scripts/core/store_learning.py',
        '--session-id', error.sessionId || 'unknown',
        '--type', 'FAILED_APPROACH',
        '--content', cappedContent,
        '--context', 'Hook infrastructure failure',
        '--tags', tags.join(','),
        '--confidence', 'medium',
      ],
      { cwd: opcDir, shell: false, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    console.error(`[HookErrorPipeline] Stored hook failure learning for '${error.hookName}'`);
  } catch (err) {
    console.error(`[HookErrorPipeline] Failed to store learning: ${err}`);
  }
}

/**
 * Logs a hook error and optionally stores it as a learning.
 */
export function captureHookError(
  hookName: string,
  error: Error | unknown,
  sessionId?: string,
  storeAsLearning = true
): void {
  const hookError: HookError = {
    hookName,
    errorMessage: error instanceof Error ? error.message : String(error),
    errorStack: error instanceof Error ? error.stack : undefined,
    timestamp: Date.now(),
    sessionId
  };

  // Log to error log
  const errors = loadRecentErrors();

  // Skip duplicates
  if (isDuplicateError(errors, hookError)) {
    console.error(`[HookErrorPipeline] Skipping duplicate error for '${hookName}'`);
    return;
  }

  errors.push(hookError);
  saveRecentErrors(errors);

  // Store as learning if enabled
  if (storeAsLearning) {
    storeErrorAsLearning(hookError);
  }
}

/**
 * Wraps hook execution with error capture.
 * If the hook throws, captures the error and still outputs valid JSON.
 */
export async function wrapWithErrorCapture<T>(
  hookName: string,
  sessionId: string | undefined,
  fn: () => Promise<T> | T,
  fallbackOutput: unknown = {}
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    captureHookError(hookName, error, sessionId);

    // Output fallback so hook doesn't crash Claude Code
    console.log(JSON.stringify(fallbackOutput));
    return undefined;
  }
}

/**
 * Creates a wrapped main function for a hook.
 * Use this as a higher-order function to wrap your entire hook.
 */
export function createSafeHook(
  hookName: string,
  hookFn: (input: unknown) => Promise<void> | void
): () => Promise<void> {
  return async () => {
    let sessionId: string | undefined;

    try {
      const rawInput = readFileSync(0, 'utf-8');
      if (!rawInput.trim()) {
        console.log(JSON.stringify({}));
        return;
      }

      let input: { session_id?: string };
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

/**
 * Get summary of recent hook errors for diagnostics.
 */
export function getErrorSummary(): { total: number; byHook: Record<string, number>; recent: HookError[] } {
  const errors = loadRecentErrors();
  const byHook: Record<string, number> = {};

  for (const error of errors) {
    byHook[error.hookName] = (byHook[error.hookName] || 0) + 1;
  }

  // Get errors from last hour
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recent = errors.filter(e => e.timestamp > oneHourAgo);

  return {
    total: errors.length,
    byHook,
    recent
  };
}

// If run directly, output error summary
if (require.main === module) {
  const summary = getErrorSummary();
  console.log(JSON.stringify(summary, null, 2));
}
