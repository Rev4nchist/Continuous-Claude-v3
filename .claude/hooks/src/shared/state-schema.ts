/**
 * State Schema Validation for Claude Code Hooks
 *
 * Validates state objects before use to catch corruption early.
 * Invalid state is logged and treated as absent (fail open).
 *
 * Usage:
 *   import { validateMaestroState } from './shared/state-schema.js';
 *   const state = JSON.parse(content);
 *   const valid = validateMaestroState(state);
 *   if (!valid) return null; // treat as no state
 */

import { createLogger } from './logger.js';
// Legacy getStatePathWithMigration import removed — unified state only

const log = createLogger('state-schema');

// ─── Maestro State ───────────────────────────────────────

export interface MaestroState {
  active: boolean;
  taskType: 'implementation' | 'research' | 'unknown';
  reconComplete: boolean;
  interviewComplete: boolean;
  planApproved: boolean;
  activatedAt: number;
  lastActivity?: number;
  sessionId?: string;
}

const VALID_TASK_TYPES = ['implementation', 'research', 'unknown'];

/**
 * Validate a parsed object as MaestroState.
 * Returns the typed state if valid, null if invalid.
 */
export function validateMaestroState(obj: unknown, sessionId?: string): MaestroState | null {
  if (!obj || typeof obj !== 'object') {
    log.warn('Maestro state is not an object', { received: typeof obj, sessionId });
    return null;
  }

  const s = obj as Record<string, unknown>;

  if (typeof s.active !== 'boolean') {
    log.warn('Maestro state missing or invalid "active" field', { value: s.active, sessionId });
    return null;
  }

  if (typeof s.taskType !== 'string' || !VALID_TASK_TYPES.includes(s.taskType)) {
    log.warn('Maestro state missing or invalid "taskType" field', { value: s.taskType, sessionId });
    return null;
  }

  for (const field of ['reconComplete', 'interviewComplete', 'planApproved'] as const) {
    if (typeof s[field] !== 'boolean') {
      log.warn(`Maestro state missing or invalid "${field}" field`, { value: s[field], sessionId });
      return null;
    }
  }

  if (typeof s.activatedAt !== 'number' || s.activatedAt <= 0) {
    log.warn('Maestro state missing or invalid "activatedAt" field', { value: s.activatedAt, sessionId });
    return null;
  }

  // Optional fields
  if (s.lastActivity !== undefined && typeof s.lastActivity !== 'number') {
    log.warn('Maestro state invalid "lastActivity" field', { value: s.lastActivity, sessionId });
    return null;
  }

  if (s.sessionId !== undefined && typeof s.sessionId !== 'string') {
    log.warn('Maestro state invalid "sessionId" field', { value: s.sessionId, sessionId });
    return null;
  }

  return obj as MaestroState;
}
