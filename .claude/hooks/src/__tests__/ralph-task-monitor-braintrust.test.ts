/**
 * Tests for ralph-task-monitor.ts Phase 3a Braintrust score emit.
 *
 * Validates the pure-helper layer for the agent_task_success score:
 *   * computeAgentTaskScore rubric: complete+0 retries = 1.0,
 *     complete+N retries = 0.5, failed = 0.0
 *   * buildAgentTaskScorePayload returns the expected score + metadata
 *   * buildAgentTaskScorePayload returns null when no span exists to attach to
 *     (no orphan scores) -- resolved from the braintrust session STATE FILE,
 *     which is what `2542561` switched to; see the describe block below.
 *
 * The actual emit call from the hook is fire-and-forget against the shared
 * emitBraintrustScore helper, which has its own 19-case test suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  computeAgentTaskScore,
  buildAgentTaskScorePayload,
} from '../ralph-task-monitor.js';

function snapshotEnv(): Record<string, string | undefined> {
  return {
    BRAINTRUST_SESSION_ID: process.env.BRAINTRUST_SESSION_ID,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
}

function restoreEnv(snap: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

describe('ralph-task-monitor: computeAgentTaskScore', () => {
  it('returns 1.0 for clean completion (complete + 0 retries)', () => {
    expect(computeAgentTaskScore({
      taskId: '1.0',
      transition: 'complete',
      retries: 0,
    })).toBe(1.0);
  });

  it('returns 0.5 for recovered completion (complete + N retries)', () => {
    expect(computeAgentTaskScore({
      taskId: '1.0',
      transition: 'complete',
      retries: 1,
    })).toBe(0.5);
    expect(computeAgentTaskScore({
      taskId: '1.0',
      transition: 'complete',
      retries: 3,
    })).toBe(0.5);
  });

  it('returns 0.0 for failed transition regardless of retries', () => {
    expect(computeAgentTaskScore({
      taskId: '1.0',
      transition: 'failed',
      retries: 0,
    })).toBe(0.0);
    expect(computeAgentTaskScore({
      taskId: '1.0',
      transition: 'failed',
      retries: 2,
    })).toBe(0.0);
  });

  it('treats missing retries field as 0 (defensive default)', () => {
    expect(computeAgentTaskScore({
      taskId: '1.0',
      transition: 'complete',
    })).toBe(1.0);
  });
});

/**
 * The span id comes from the braintrust session STATE FILE, not from
 * `process.env.BRAINTRUST_SESSION_ID`. That env var is set nowhere, which is the
 * bug `2542561` fixed by switching to `resolveBraintrustSpanId(sessionId)`.
 *
 * These tests were left asserting the retired env-var contract, so four of them
 * failed and the two "returns null" ones passed VACUOUSLY -- with no state file
 * present, null is the answer for every input, so they proved nothing. Both are
 * now driven by the real gate.
 *
 * Non-vacuous by construction: the turn-over-root test asserts a span id that
 * exists only inside the file this suite writes, so it cannot pass unless the
 * state file is genuinely read; and the sampled-out test proves the gate reads
 * the file's CONTENTS rather than merely its existence.
 */
describe('ralph-task-monitor: buildAgentTaskScorePayload', () => {
  let envSnap: Record<string, string | undefined>;
  let homeDir: string;

  /** Writes ~/.claude/state/braintrust_sessions/<id>.json under the temp HOME. */
  function writeSpanState(sessionId: string, state: object): void {
    const dir = join(homeDir, '.claude', 'state', 'braintrust_sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(state));
  }

  beforeEach(() => {
    envSnap = snapshotEnv();
    delete process.env.BRAINTRUST_SESSION_ID;
    // readBraintrustSessionState() reads HOME/USERPROFILE at CALL time, so
    // redirecting them is enough -- no module mocking needed.
    homeDir = mkdtempSync(join(tmpdir(), 'rtm-braintrust-'));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    restoreEnv(envSnap);
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('returns null when there is no span state for the session', () => {
    const payload = buildAgentTaskScorePayload({
      sessionId: 'sess-missing',
      taskId: '1.0',
      transition: 'complete',
      retries: 0,
    });
    expect(payload).toBeNull();
  });

  it('returns null when the session id is empty (no orphan scores)', () => {
    const payload = buildAgentTaskScorePayload({
      sessionId: '',
      taskId: '1.0',
      transition: 'complete',
      retries: 0,
    });
    expect(payload).toBeNull();
  });

  it('returns null for a sampled-out session even with a root span', () => {
    writeSpanState('sess-sampled', { root_span_id: 'span-root-abc', sampled_out: true });
    const payload = buildAgentTaskScorePayload({
      sessionId: 'sess-sampled',
      taskId: '1.0',
      transition: 'complete',
      retries: 0,
    });
    expect(payload).toBeNull();
  });

  it('prefers the current turn span over the root span', () => {
    writeSpanState('sess-turn', {
      root_span_id: 'span-root-abc',
      current_turn_span_id: 'span-turn-xyz',
    });
    const payload = buildAgentTaskScorePayload({
      sessionId: 'sess-turn',
      taskId: '1.0',
      transition: 'complete',
      retries: 0,
    });
    expect(payload!.spanId).toBe('span-turn-xyz');
  });

  it('emits agent_task_success score with span id and metadata', () => {
    writeSpanState('sess-1', { root_span_id: 'span-root-abc' });
    const payload = buildAgentTaskScorePayload({
      sessionId: 'sess-1',
      taskId: '2.0',
      taskName: 'Phase 2 - Easy wins',
      agent: 'kraken',
      retries: 0,
      durationS: 13894.4,
      transition: 'complete',
    });
    expect(payload).not.toBeNull();
    expect(payload!.spanId).toBe('span-root-abc');
    expect(payload!.scores).toEqual({ agent_task_success: 1.0 });
    expect(payload!.metadata).toEqual({
      task_id: '2.0',
      task_name: 'Phase 2 - Easy wins',
      agent: 'kraken',
      retries: 0,
      duration_s: 13894.4,
      transition: 'complete',
      hook: 'ralph-task-monitor',
    });
  });

  it('emits 0.5 score with retries > 0', () => {
    writeSpanState('sess-1', { root_span_id: 'span-root-abc' });
    const payload = buildAgentTaskScorePayload({
      sessionId: 'sess-1',
      taskId: '3.0',
      agent: 'spark',
      retries: 2,
      transition: 'complete',
    });
    expect(payload!.scores).toEqual({ agent_task_success: 0.5 });
    expect(payload!.metadata).toMatchObject({
      task_id: '3.0',
      retries: 2,
      transition: 'complete',
    });
  });

  it('emits 0.0 score on failed transition', () => {
    writeSpanState('sess-1', { root_span_id: 'span-root-abc' });
    const payload = buildAgentTaskScorePayload({
      sessionId: 'sess-1',
      taskId: '4.0',
      transition: 'failed',
      retries: 1,
    });
    expect(payload!.scores).toEqual({ agent_task_success: 0.0 });
    expect(payload!.metadata).toMatchObject({
      transition: 'failed',
      retries: 1,
    });
  });

  it('fills defensive defaults when optional fields are missing', () => {
    writeSpanState('sess-1', { root_span_id: 'span-root-abc' });
    const payload = buildAgentTaskScorePayload({
      sessionId: 'sess-1',
      taskId: '1.0',
      transition: 'complete',
    });
    expect(payload!.metadata).toEqual({
      task_id: '1.0',
      task_name: '',
      agent: 'unknown',
      retries: 0,
      duration_s: 0,
      transition: 'complete',
      hook: 'ralph-task-monitor',
    });
  });
});
