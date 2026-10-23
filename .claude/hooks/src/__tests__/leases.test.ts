/**
 * Lease classification.
 *
 * The classification, not the TTL number, is what these assert. A test that
 * checks `ttlMs === 3600000` passes for a path classified harness for the wrong
 * reason; a test that checks the CLASS says which rule fired.
 */

// Imported explicitly rather than relying on vitest globals. The globals are
// configured for the RUNNER but not for tsc, so every existing test file in this
// directory contributes a pile of "Cannot find name 'describe'" errors to a
// project that already has no working typecheck gate. This file declines to add
// 37 more.
import { describe, it, expect } from 'vitest';

import {
  isHarnessPath,
  leaseFor,
  FILE_LEASE_MS,
  HARNESS_LEASE_MS,
} from '../shared/leases.js';

describe('isHarnessPath', () => {
  it('matches the three harness directories', () => {
    expect(isHarnessPath('C:/Users/d/continuous-claude/.claude/hooks/src/x.ts')).toBe(true);
    expect(isHarnessPath('C:/Users/d/continuous-claude/.claude/rules/no-haiku.md')).toBe(true);
    expect(isHarnessPath('C:/Users/d/continuous-claude/.claude/skills/review/SKILL.md')).toBe(true);
  });

  it('matches the LIVE harness, not just a repo copy', () => {
    // ~/.claude is the copy every session on the machine actually executes.
    expect(isHarnessPath('~/.claude/hooks/dist/file-claims.mjs')).toBe(true);
  });

  it('matches regardless of slash direction or case', () => {
    expect(isHarnessPath('C:\\Users\\d\\repo\\.claude\\hooks\\src\\x.ts')).toBe(true);
    expect(isHarnessPath('C:/Users/D/Repo/.Claude/Hooks/src/X.ts')).toBe(true);
  });

  it('matches settings*.json by basename', () => {
    expect(isHarnessPath('C:/repo/.claude/settings.json')).toBe(true);
    expect(isHarnessPath('C:/repo/.claude/settings.local.json')).toBe(true);
    expect(isHarnessPath('C:/repo/settings.json.template')).toBe(false); // not *.json
  });

  it('does NOT match a rollback copy that nothing reads', () => {
    expect(isHarnessPath('C:/repo/.claude/settings.json.bak-step4')).toBe(false);
  });

  it('does NOT match on the word settings appearing elsewhere', () => {
    expect(isHarnessPath('C:/repo/src/settings/index.ts')).toBe(false);
    expect(isHarnessPath('C:/repo/docs/settings-guide.md')).toBe(false);
  });

  it('does NOT match a directory that merely shares a name', () => {
    // A project's own src/hooks/ is application code, not the harness.
    expect(isHarnessPath('C:/repo/src/hooks/useThing.ts')).toBe(false);
    expect(isHarnessPath('C:/repo/app/skills/page.tsx')).toBe(false);
  });

  it('does NOT match .claude files outside the three directories', () => {
    expect(isHarnessPath('C:/repo/.claude/knowledge-tree.json')).toBe(false);
    expect(isHarnessPath('C:/repo/.claude/project-registry.json')).toBe(false);
  });
});

describe('leaseFor', () => {
  it('gives ordinary files the short lease', () => {
    const lease = leaseFor('C:/repo/src/app/page.tsx');
    expect(lease.leaseClass).toBe('file');
    expect(lease.ttlMs).toBe(FILE_LEASE_MS);
  });

  it('gives harness source the long lease', () => {
    const lease = leaseFor('C:/repo/.claude/hooks/src/file-claims.ts');
    expect(lease.leaseClass).toBe('harness:src');
    expect(lease.ttlMs).toBe(HARNESS_LEASE_MS);
  });

  it('keeps the harness lease strictly longer than the file lease', () => {
    // If these ever converge the class distinction is doing nothing.
    expect(HARNESS_LEASE_MS).toBeGreaterThan(FILE_LEASE_MS);
  });

  it('leases longer than the 5-minute heartbeat staleness window', () => {
    // Reclamation requires BOTH an expired lease and a stale heartbeat. If a
    // lease were SHORTER than the staleness window, the lease would always be
    // the expired one first and the heartbeat would become the only real
    // condition -- silently collapsing the two-condition rule back into the
    // one-condition rule that caused the original false positives.
    const HEARTBEAT_STALE_MS = 5 * 60 * 1000;
    expect(FILE_LEASE_MS).toBeGreaterThan(HEARTBEAT_STALE_MS);
    expect(HARNESS_LEASE_MS).toBeGreaterThan(HEARTBEAT_STALE_MS);
  });
});
