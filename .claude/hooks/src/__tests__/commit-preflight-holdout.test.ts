/**
 * commit-preflight: the early warning of the holdout push scan (card prflow-push-blocks, design note rev 1 section 2, seat condition 3a).
 * Own file: commit-preflight.test.ts is not part of this change. The hook asks (never denies) when the STAGED added lines of a commit on a
 * `re/` branch hold a holdout id, and says the push will be refused. The push check in decision-gate is the gate.
 *
 *   - a re/ commit with a staged id gets no ask, or the text names an id                      -> CH1
 *   - a non-re branch runs the staged read (the trigger widens)                                -> CH2
 *   - an unreadable read (null) or a count of 0 asks (fail open is the file's rule)           -> CH3
 *   - the text holds anything but a count                                                      -> CH1
 * The count is injected through PreflightOptions.stagedHoldout. No real id is in this file.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preflight, type PreflightOptions } from '../commit-preflight.js';
import { getStateFile } from '../shared/test-run-state.js';
import { loadFixture, mkRepo, tempDir, writeRegistry } from './correct-helpers.js';

const sessions: string[] = [];
let n = 0;
afterEach(() => { for (const id of sessions.splice(0)) rmSync(getStateFile(id)!, { force: true }); });

function ctx(branch: string, stagedHoldout?: PreflightOptions['stagedHoldout']) {
  const repo = mkRepo(tempDir('pfh'), branch);
  const registryPath = writeRegistry(join(tempDir('reg'), 'project-registry.json'), [{ name: 'p', path: repo, e2e: { command: 'x' } }]);
  const session = `commit-preflight-holdout-${process.pid}-${Date.now()}-${n++}`;
  sessions.push(session);
  return { payload: loadFixture('commit-no-proof', { REPO: repo, SESSION: session }), opts: { env: {}, registryPath, ...(stagedHoldout ? { stagedHoldout } : {}) } as PreflightOptions };
}
const decisionOf = (out: any): string | undefined => out?.hookSpecificOutput?.permissionDecision;
const reasonOf = (out: any): string => out?.hookSpecificOutput?.permissionDecisionReason ?? '';

describe('CH: holdout early warning', () => {
  it('CH1: a commit on a re/ branch with staged holdout ids asks, names a count, and says the push will be refused', () => {
    // Breaks when: the check is missing, or the text carries more than a count (an id, a line, a path).
    const c = ctx('re/re-x', () => 2);
    const out = preflight(c.payload, c.opts);
    expect(decisionOf(out)).toBe('ask');
    expect(reasonOf(out)).toMatch(/hold 2 holdout ids/);
    expect(reasonOf(out)).toMatch(/push will be refused/);
    expect(reasonOf(out)).not.toMatch(/\d{5,}/);
    const one = ctx('re/re-x', () => 1);
    expect(reasonOf(preflight(one.payload, one.opts))).toMatch(/hold 1 holdout id\./);
  });

  it('CH2: a commit on a non-re branch with staged holdout ids WARNS with a count and never asks (card coord-holdout-scan-warn, seat Q2)', () => {
    // Breaks when: the staged read stays re/-only, or a non-re branch gets an ask instead of a warning, or the text holds more than a count.
    let calls = 0;
    const c = ctx('feat/x', () => { calls += 1; return 3; });
    const out = preflight(c.payload, c.opts);
    expect(calls).toBe(1);
    expect(reasonOf(out)).not.toMatch(/holdout/);
    const context: string = (out as any)?.hookSpecificOutput?.additionalContext ?? '';
    expect(context).toMatch(/hold 3 holdout ids/);
    expect(context).not.toMatch(/push will be refused/);
    expect(context).not.toMatch(/\d{5,}/);
    for (const answer of [null, 0]) {
      const z = ctx('feat/x', () => answer);
      expect(((preflight(z.payload, z.opts) as any)?.hookSpecificOutput?.additionalContext ?? '')).not.toMatch(/holdout/);
    }
  });

  it('CH3: a read that fails (null) or finds nothing (0) adds no ask', () => {
    // Breaks when: an unreadable index counts as a hit, or a count of 0 asks.
    for (const answer of [null, 0]) {
      const c = ctx('re/re-x', () => answer);
      expect(decisionOf(preflight(c.payload, c.opts))).toBeUndefined();
    }
  });
});
