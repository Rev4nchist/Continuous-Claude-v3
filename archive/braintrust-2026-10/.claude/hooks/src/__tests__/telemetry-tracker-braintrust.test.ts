/**
 * Tests for telemetry-tracker.ts Phase 3a Braintrust score emit.
 *
 * Validates the pure-helper layer for the skill_trigger_accuracy score:
 *   * resolveScoreSpanId resolves a span from the braintrust session STATE FILE
 *   * buildSkillTriggerScorePayload returns the expected score + metadata
 *   * buildSkillTriggerScorePayload returns null when no spanId is available
 *
 * The actual emit call inside main() is fire-and-forget against the shared
 * emitBraintrustScore helper, which has its own 19-case test suite. We do not
 * re-test the network path here.
 *
 * CONTRACT CHANGE these tests were left behind by (`2542561`, 2026-07-28): the
 * span id used to come from `process.env.BRAINTRUST_SESSION_ID`, falling back to
 * treating the payload session_id AS the span id. That env var is set NOWHERE, so
 * the layer never emitted. resolveScoreSpanId now calls resolveBraintrustSpanId,
 * which uses session_id as a LOOKUP KEY into
 * `~/.claude/state/braintrust_sessions/<sessionId>.json` written by
 * braintrust_hooks.py. A session id is therefore no longer a span id, which is
 * why 14 of these 22 tests failed against correct code.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  resolveScoreSpanId,
  buildSkillTriggerScorePayload,
  buildToolResponseKeys,
} from '../telemetry-tracker.js';
import { detectToolError } from '../shared/tool-error.js';

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

/**
 * Redirect HOME/USERPROFILE at a temp dir and write span state into it.
 * readBraintrustSessionState() reads those vars at CALL time, so this needs no
 * module mocking. Returns the temp home so the caller can clean it up.
 */
function makeSpanHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'tt-braintrust-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

function writeSpanState(home: string, sessionId: string, state: object): void {
  const dir = join(home, '.claude', 'state', 'braintrust_sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(state));
}

describe('telemetry-tracker: resolveScoreSpanId', () => {
  let envSnap: Record<string, string | undefined>;
  let home: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    delete process.env.BRAINTRUST_SESSION_ID;
    home = makeSpanHome();
  });

  afterEach(() => {
    restoreEnv(envSnap);
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('resolves the root span recorded for the session', () => {
    writeSpanState(home, 'sess-root', { root_span_id: 'span-root-abc' });
    expect(resolveScoreSpanId('sess-root')).toBe('span-root-abc');
  });

  it('prefers the current turn span over the root span', () => {
    writeSpanState(home, 'sess-turn', {
      root_span_id: 'span-root-abc',
      current_turn_span_id: 'span-turn-xyz',
    });
    expect(resolveScoreSpanId('sess-turn')).toBe('span-turn-xyz');
  });

  it('returns empty string when the session has no state file', () => {
    expect(resolveScoreSpanId('sess-missing')).toBe('');
  });

  it('returns empty string for a sampled-out session', () => {
    writeSpanState(home, 'sess-sampled', { root_span_id: 'span-root-abc', sampled_out: true });
    expect(resolveScoreSpanId('sess-sampled')).toBe('');
  });

  it('returns empty string when the session id is missing', () => {
    expect(resolveScoreSpanId(undefined)).toBe('');
  });

  it('does NOT treat the session id as a span id', () => {
    // The retired contract returned the session id itself when the env var was
    // unset, which is how a span id that no Braintrust trace contained got
    // emitted. Regression guard: a session with no state file resolves to ''.
    expect(resolveScoreSpanId('payload-session-xyz')).toBe('');
  });

  it('IGNORES BRAINTRUST_SESSION_ID', () => {
    // Regression guard against reintroducing the retired env-var path. Nothing
    // in this harness sets this variable; honouring it is how the score layer
    // silently emitted nothing for months.
    process.env.BRAINTRUST_SESSION_ID = 'env-span-abc';
    expect(resolveScoreSpanId('sess-missing')).toBe('');
  });
});

describe('telemetry-tracker: buildSkillTriggerScorePayload', () => {
  let envSnap: Record<string, string | undefined>;
  let home: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    delete process.env.BRAINTRUST_SESSION_ID;
    home = makeSpanHome();
    // 'sess-abc' is the session every positive case below resolves through.
    writeSpanState(home, 'sess-abc', { root_span_id: 'span-abc' });
  });

  afterEach(() => {
    restoreEnv(envSnap);
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('returns null when no spanId is available', () => {
    const payload = buildSkillTriggerScorePayload({
      sessionId: undefined,
      skillName: 'memory',
      triggerSource: 'llm',
      success: true,
    });
    expect(payload).toBeNull();
  });

  it('returns null when the session has no span state', () => {
    const payload = buildSkillTriggerScorePayload({
      sessionId: 'sess-missing',
      skillName: 'memory',
      triggerSource: 'llm',
      success: true,
    });
    expect(payload).toBeNull();
  });

  it('emits 1.0 score when success is true', () => {
    const payload = buildSkillTriggerScorePayload({
      sessionId: 'sess-abc',
      skillName: 'memory',
      triggerSource: 'llm',
      success: true,
    });
    expect(payload).not.toBeNull();
    expect(payload!.spanId).toBe('span-abc');
    expect(payload!.scores).toEqual({ skill_trigger_accuracy: 1.0 });
  });

  it('emits 0.0 score when success is false', () => {
    const payload = buildSkillTriggerScorePayload({
      sessionId: 'sess-abc',
      skillName: 'memory',
      triggerSource: 'llm',
      success: false,
    });
    expect(payload).not.toBeNull();
    expect(payload!.scores).toEqual({ skill_trigger_accuracy: 0.0 });
  });

  it('includes skill_name, trigger_source, hook in metadata', () => {
    const payload = buildSkillTriggerScorePayload({
      sessionId: 'sess-abc',
      skillName: 'systematic-debugging',
      triggerSource: 'explicit',
      success: true,
    });
    expect(payload!.metadata).toEqual({
      skill_name: 'systematic-debugging',
      trigger_source: 'explicit',
      hook: 'telemetry-tracker',
    });
  });

  it('IGNORES BRAINTRUST_SESSION_ID when building the payload', () => {
    process.env.BRAINTRUST_SESSION_ID = 'env-span-xyz';
    const payload = buildSkillTriggerScorePayload({
      sessionId: 'sess-abc',
      skillName: 'memory',
      triggerSource: 'hook',
      success: true,
    });
    expect(payload!.spanId).toBe('span-abc');
  });
});

// ---------------------------------------------------------------------------
// Gate B2 — integration: detectToolError → buildSkillTriggerScorePayload
//
// Plan-spec'd 6 cases: 5 error indicators + 1 "no error flags = success".
// Each case asserts the score that REACHES the payload is 0.0 (failure) or
// 1.0 (success) — proving the new detector is wired through the path that
// emits scores to Braintrust.
//
// This is the integration layer: detectToolError is unit-tested with all
// branches in __tests__/tool-error.test.ts; here we verify the composition.
// ---------------------------------------------------------------------------
describe('telemetry-tracker: detectToolError → score payload integration', () => {
  let envSnap: Record<string, string | undefined>;
  let home: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    delete process.env.BRAINTRUST_SESSION_ID;
    home = makeSpanHome();
    // Each case below uses its own session id; every one needs span state, or
    // buildSkillTriggerScorePayload returns null and the assertion dies on
    // `payload!.scores` rather than reporting a wrong score.
    for (const n of [1, 2, 3, 4, 5, 6]) {
      writeSpanState(home, `span-${n}`, { root_span_id: `resolved-span-${n}` });
    }
  });

  afterEach(() => {
    restoreEnv(envSnap);
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('error indicator #1 — is_error===true → score 0.0', () => {
    const success = !detectToolError({ is_error: true });
    const payload = buildSkillTriggerScorePayload({
      sessionId: 'span-1',
      skillName: 'memory',
      triggerSource: 'llm',
      success,
    });
    expect(payload!.scores).toEqual({ skill_trigger_accuracy: 0.0 });
  });

  it('error indicator #2 — error: non-empty string → score 0.0', () => {
    const success = !detectToolError({ error: 'something broke' });
    const payload = buildSkillTriggerScorePayload({
      sessionId: 'span-2',
      skillName: 'memory',
      triggerSource: 'llm',
      success,
    });
    expect(payload!.scores).toEqual({ skill_trigger_accuracy: 0.0 });
  });

  it('error indicator #3 — error===true → score 0.0', () => {
    const success = !detectToolError({ error: true });
    const payload = buildSkillTriggerScorePayload({
      sessionId: 'span-3',
      skillName: 'memory',
      triggerSource: 'llm',
      success,
    });
    expect(payload!.scores).toEqual({ skill_trigger_accuracy: 0.0 });
  });

  it('error indicator #4 — success===false → score 0.0', () => {
    const success = !detectToolError({ success: false });
    const payload = buildSkillTriggerScorePayload({
      sessionId: 'span-4',
      skillName: 'memory',
      triggerSource: 'llm',
      success,
    });
    expect(payload!.scores).toEqual({ skill_trigger_accuracy: 0.0 });
  });

  it('error indicator #5 — status==="error" (backward compat) → score 0.0', () => {
    const success = !detectToolError({ status: 'error' });
    const payload = buildSkillTriggerScorePayload({
      sessionId: 'span-5',
      skillName: 'memory',
      triggerSource: 'llm',
      success,
    });
    expect(payload!.scores).toEqual({ skill_trigger_accuracy: 0.0 });
  });

  it('no error flags (empty object) → success → score 1.0', () => {
    const success = !detectToolError({});
    const payload = buildSkillTriggerScorePayload({
      sessionId: 'span-6',
      skillName: 'memory',
      triggerSource: 'llm',
      success,
    });
    expect(payload!.scores).toEqual({ skill_trigger_accuracy: 1.0 });
  });
});

// ---------------------------------------------------------------------------
// Gate B2 — buildToolResponseKeys instrumentation
//
// Plan-spec'd 2 cases: (1) keys populated when tool_response has fields,
// (2) keys is [] when tool_response is null/undefined. Confirms the
// empirical instrumentation field will surface field names in the jsonl
// telemetry so we can audit what Claude Code actually sends.
// ---------------------------------------------------------------------------
describe('telemetry-tracker: buildToolResponseKeys', () => {
  it('populates keys array when tool_response has fields', () => {
    const keys = buildToolResponseKeys({ is_error: true, output: 'boom' });
    expect(keys).toEqual(expect.arrayContaining(['is_error', 'output']));
    expect(keys.length).toBe(2);
  });

  it('returns [] when tool_response is undefined', () => {
    expect(buildToolResponseKeys(undefined)).toEqual([]);
  });

  it('returns [] when tool_response is null', () => {
    expect(buildToolResponseKeys(null)).toEqual([]);
  });

  it('returns [] when tool_response is not an object', () => {
    // Defensive: a non-object payload should not crash; produce []
    expect(buildToolResponseKeys('error')).toEqual([]);
    expect(buildToolResponseKeys(42)).toEqual([]);
  });

  it('returns [] for an empty object', () => {
    expect(buildToolResponseKeys({})).toEqual([]);
  });

  it('captures all four error-indicator field names when present', () => {
    // The empirical scenario we most want to detect: Claude Code emitting
    // any of the four detector fields. This test documents the expected
    // shape of a fully-populated failure payload.
    const keys = buildToolResponseKeys({
      is_error: true,
      error: 'boom',
      success: false,
      status: 'error',
    });
    expect(keys.sort()).toEqual(['error', 'is_error', 'status', 'success']);
  });
});
