/**
 * tldr-context-inject — findProjectRoot termination (F5)
 *
 * Regression guard: the prior `while (current !== '/')` never terminated on a
 * Windows drive root, and QW-04 made this hook live on every PreToolUse:Task
 * spawn. These tests would HANG (vitest test-timeout fail) if the loop ever
 * regressed to a non-terminating form.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  findProjectRoot,
  isTldrEligibleAgent,
  tldrCacheKey,
  readTldrCache,
  writeTldrCache,
} from '../tldr-context-inject.js';

describe('findProjectRoot', () => {
  it('terminates (does not hang) walking a deep path up to the fs root', () => {
    // The regression being guarded is non-termination on a Windows drive root.
    // The test COMPLETING is the proof (it would hit vitest's timeout if the loop
    // never terminated). We only assert it returns a string — the exact value
    // depends on whether any real ancestor happens to hold a marker.
    const deep = join(tmpdir(), 'tldr-fpr-nomarker', 'a', 'b', 'c');
    const result = findProjectRoot(deep);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('finds the nearest ancestor containing a marker', () => {
    const base = mkdtempSync(join(tmpdir(), 'tldr-fpr-'));
    try {
      writeFileSync(join(base, 'package.json'), '{}');
      const nested = join(base, 'src', 'deep');
      mkdirSync(nested, { recursive: true });
      expect(findProjectRoot(nested)).toBe(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// D (2026-06-29): agent narrowing + per-(project, git-freshness, query) cache
// ---------------------------------------------------------------------------

describe('isTldrEligibleAgent (D narrow)', () => {
  it('skips non-code agents (research / ops / meta)', () => {
    expect(isTldrEligibleAgent('oracle')).toBe(false);
    expect(isTldrEligibleAgent('deployer')).toBe(false);
    expect(isTldrEligibleAgent('scribe')).toBe(false);
    expect(isTldrEligibleAgent('agent-factory')).toBe(false);
  });

  it('allows code-focused agents and unknown/undefined (default = inject, safe)', () => {
    expect(isTldrEligibleAgent('scout')).toBe(true);
    expect(isTldrEligibleAgent('kraken')).toBe(true);
    expect(isTldrEligibleAgent('debug-agent')).toBe(true);
    expect(isTldrEligibleAgent(undefined)).toBe(true);
    expect(isTldrEligibleAgent('')).toBe(true);
    expect(isTldrEligibleAgent('some-future-agent')).toBe(true);
  });
});

describe('tldrCacheKey (D cache)', () => {
  const q = { entryPoints: ['foo'], layers: ['call_graph'] };

  it('is deterministic for identical inputs', () => {
    expect(tldrCacheKey('/proj', 'sha1-aaaa', q)).toBe(tldrCacheKey('/proj', 'sha1-aaaa', q));
  });

  it('changes with git freshness (new sha or dirty marker -> fresh key)', () => {
    expect(tldrCacheKey('/proj', 'sha1-aaaa', q)).not.toBe(tldrCacheKey('/proj', 'sha2-bbbb', q));
  });

  it('changes with the query and the project', () => {
    expect(tldrCacheKey('/proj', 'sha1', { e: 'a' })).not.toBe(tldrCacheKey('/proj', 'sha1', { e: 'b' }));
    expect(tldrCacheKey('/proj-a', 'sha1', q)).not.toBe(tldrCacheKey('/proj-b', 'sha1', q));
  });
});

describe('tldr cache round-trip (D)', () => {
  it('writes then reads the same key; misses a different key', () => {
    const key = `test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const val = { tldrContext: '## Context: foo', usedTarget: 'foo' };
    writeTldrCache(key, val);
    expect(readTldrCache(key)).toEqual(val);
    expect(readTldrCache(`${key}-absent`)).toBeNull();
  });
});
