/**
 * telemetry-tracker: buildToolResponseKeys.
 *
 * Instrumentation field written to the skill/agent telemetry jsonl so we can
 * audit which fields Claude Code sends in tool_response. Split out of the
 * retired telemetry-tracker-braintrust.test.ts (Braintrust retired 2026-09-30).
 */
import { describe, it, expect } from 'vitest';

import { buildToolResponseKeys } from '../telemetry-tracker.js';

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
