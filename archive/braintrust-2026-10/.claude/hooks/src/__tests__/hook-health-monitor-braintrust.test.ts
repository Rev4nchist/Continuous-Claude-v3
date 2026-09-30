/**
 * Tests for hook-health-monitor.ts Phase 3a Braintrust score emit.
 *
 * Validates the pure-helper layer for the hook_health_ratio score:
 *   * buildHookHealthRatioPayload returns the expected ratio + metadata
 *   * Returns null when no spanId is available
 *   * Returns null when total is 0 (avoid divide-by-zero)
 *   * Caps missing_list at 10 entries (bounded metadata size)
 *   * Counts both 'healthy' and 'stale' as registered (file present)
 */

import { describe, it, expect } from 'vitest';

import {
  buildHookHealthRatioPayload,
  type HookHealthResult,
} from '../hook-health-monitor.js';

function mkResult(name: string, status: HookHealthResult['status']): HookHealthResult {
  return { hookName: name, status, hookEvent: 'PreToolUse' };
}

describe('hook-health-monitor: buildHookHealthRatioPayload', () => {
  it('returns null when spanId is empty', () => {
    const payload = buildHookHealthRatioPayload({
      results: [mkResult('a', 'healthy')],
      spanId: '',
    });
    expect(payload).toBeNull();
  });

  it('returns null when total is 0 (no hooks registered)', () => {
    const payload = buildHookHealthRatioPayload({
      results: [],
      spanId: 'span-abc',
    });
    expect(payload).toBeNull();
  });

  it('emits 1.0 ratio when all hooks are healthy', () => {
    const payload = buildHookHealthRatioPayload({
      results: [
        mkResult('a', 'healthy'),
        mkResult('b', 'healthy'),
        mkResult('c', 'healthy'),
      ],
      spanId: 'span-abc',
    });
    expect(payload).not.toBeNull();
    expect(payload!.scores).toEqual({ hook_health_ratio: 1.0 });
    expect(payload!.metadata).toEqual({
      registered: 3,
      total: 3,
      missing_list: [],
      hook: 'hook-health-monitor',
    });
  });

  it('counts stale hooks as registered (file present, just outdated)', () => {
    const payload = buildHookHealthRatioPayload({
      results: [
        mkResult('a', 'healthy'),
        mkResult('b', 'stale'),
        mkResult('c', 'stale'),
      ],
      spanId: 'span-abc',
    });
    expect(payload!.scores).toEqual({ hook_health_ratio: 1.0 });
    expect(payload!.metadata).toMatchObject({
      registered: 3,
      total: 3,
      missing_list: [],
    });
  });

  it('emits fractional ratio when some hooks are missing', () => {
    const payload = buildHookHealthRatioPayload({
      results: [
        mkResult('a', 'healthy'),
        mkResult('b', 'healthy'),
        mkResult('c', 'missing'),
        mkResult('d', 'missing'),
      ],
      spanId: 'span-abc',
    });
    expect(payload!.scores).toEqual({ hook_health_ratio: 0.5 });
    expect(payload!.metadata).toMatchObject({
      registered: 2,
      total: 4,
      missing_list: ['c', 'd'],
    });
  });

  it('caps missing_list at 10 entries', () => {
    const results = [
      ...Array.from({ length: 12 }, (_, i) => mkResult(`m${i}`, 'missing')),
      mkResult('healthy1', 'healthy'),
    ];
    const payload = buildHookHealthRatioPayload({
      results,
      spanId: 'span-abc',
    });
    expect((payload!.metadata.missing_list as string[]).length).toBe(10);
    expect(payload!.metadata).toMatchObject({
      registered: 1,
      total: 13,
    });
  });

  it('emits 0.0 ratio when all hooks are missing', () => {
    const payload = buildHookHealthRatioPayload({
      results: [
        mkResult('a', 'missing'),
        mkResult('b', 'missing'),
      ],
      spanId: 'span-abc',
    });
    expect(payload!.scores).toEqual({ hook_health_ratio: 0.0 });
    expect(payload!.metadata).toMatchObject({
      registered: 0,
      total: 2,
      missing_list: ['a', 'b'],
    });
  });
});
