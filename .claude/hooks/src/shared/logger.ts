/**
 * Shared Logger for Claude Code Hooks
 *
 * Provides structured, file-based logging for all hooks.
 * Logs are written to ~/.claude/logs/hooks.log as JSON lines.
 *
 * Usage:
 *   import { createLogger } from './shared/logger.js';
 *   const log = createLogger('my-hook-name');
 *   log.info('Processing started', { key: 'value' });
 *   log.error('Something failed', { error: err.message });
 */

import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: LogLevel;
  hook: string;
  msg: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// CLAUDE_HOOK_LOG_FILE redirects the log. vitest.config.ts sets it to a temp file, so test
// runs (and the hook subprocesses they spawn, which inherit the env) stop writing fixture
// rows into the live ~/.claude/logs/hooks.log. Those rows were 38% of its session rows.
const LOG_FILE = process.env.CLAUDE_HOOK_LOG_FILE || join(homedir(), '.claude', 'logs', 'hooks.log');
const LOG_DIR = dirname(LOG_FILE);
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB before rotation
const MIN_LEVEL: LogLevel = (process.env.CLAUDE_HOOK_LOG_LEVEL as LogLevel) || 'info';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

function rotateIfNeeded(): void {
  try {
    if (existsSync(LOG_FILE)) {
      const stat = statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        const rotated = LOG_FILE + '.1';
        renameSync(LOG_FILE, rotated);
      }
    }
  } catch {
    // Rotation failure is non-critical
  }
}

function getSessionId(): string | undefined {
  return process.env.CLAUDE_SESSION_ID || undefined;
}

function writeLog(entry: LogEntry): void {
  try {
    ensureLogDir();
    rotateIfNeeded();
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // Logging must never break a hook — fail silently
  }
}

/**
 * Create a namespaced logger for a hook.
 *
 * @param hookName - Identifies which hook is logging
 * @returns Logger with debug/info/warn/error methods
 */
export function createLogger(hookName: string): Logger {
  function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (!shouldLog(level)) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      hook: hookName,
      msg,
      sessionId: getSessionId(),
    };

    if (data && Object.keys(data).length > 0) {
      entry.data = data;
    }

    writeLog(entry);

    // Also write to stderr for immediate visibility (existing pattern)
    if (level === 'error' || level === 'warn') {
      console.error(`[${hookName}] ${level.toUpperCase()}: ${msg}`);
    }
  }

  return {
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),
  };
}
