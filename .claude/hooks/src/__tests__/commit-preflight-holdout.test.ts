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
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preflight, stagedHoldoutCount, type PreflightOptions } from '../commit-preflight.js';
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

  it('CH4: two commits in one command, a feature branch with ids first and then a re/ branch with ids, still ask for the re/ commit; the reverse order is the control (CLI finding, seat word 13:1x)', () => {
    // Breaks when: a warning on the first commit stops the staged scan, so a later re/ commit loses its ask.
    const feat = mkRepo(tempDir('pfh-feat'), 'feat/x');
    const re = mkRepo(tempDir('pfh-re'), 're/re-x');
    const registryPath = writeRegistry(join(tempDir('reg'), 'project-registry.json'), [{ name: 'p', path: feat, e2e: { command: 'x' } }]);
    const session = `commit-preflight-holdout-${process.pid}-${Date.now()}-${n++}`;
    sessions.push(session);
    const counts = (dir: string) => (dir === feat ? 2 : dir === re ? 3 : 0);
    for (const order of [[feat, re], [re, feat]]) {
      const payload = loadFixture('commit-no-proof', { REPO: feat, SESSION: session });
      payload.tool_input.command = `git -C "${order[0]}" commit -m "chore: a" && git -C "${order[1]}" commit -m "chore: b"`;
      const out = preflight(payload, { env: {}, registryPath, stagedHoldout: counts } as PreflightOptions);
      expect(decisionOf(out), `order ${order === undefined ? '' : order.map((d) => (d === feat ? 'feat' : 're')).join(' then ')}`).toBe('ask');
      expect(reasonOf(out)).toMatch(/on re\/re-x hold 3 holdout ids/);
      expect((out as any)?.hookSpecificOutput?.additionalContext ?? '').toMatch(/staged lines of this commit hold 2 holdout ids/);
    }
  });

  it('CH3: a read that fails (null) or finds nothing (0) adds no ask', () => {
    // Breaks when: an unreadable index counts as a hit, or a count of 0 asks.
    for (const answer of [null, 0]) {
      const c = ctx('re/re-x', () => answer);
      expect(decisionOf(preflight(c.payload, c.opts))).toBeUndefined();
    }
  });
  it('CH6: the staged lines over the read bound warn that they were not read (card coord-decision-gate-round3-content-scan)', () => {
    // Breaks when: an over-bound read stays silent (it says nothing about what it did not read).
    for (const branch of ['re/re-x', 'feat/x']) {
      const c = ctx(branch, () => 'too-large');
      const out = preflight(c.payload, c.opts) as any;
      expect(out?.hookSpecificOutput?.additionalContext ?? '').toMatch(/over 1500000 bytes and were not read/);
      expect(decisionOf(out)).toBeUndefined();
    }
  });
});

/** C5 items 12 and 14 on the default reader: a real index and a made-up id list in a temp primary checkout. */
describe('CH: the default staged reader', () => {
  const CID = '987654321';
  function world(dataset: unknown): { repo: string; mainRoot: string } {
    const repo = tempDir('pfh-real');
    execFileSync('git', ['init', '-q', '-b', 're/re-x', repo], { windowsHide: true });
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo, windowsHide: true });
    const mainRoot = tempDir('pfh-main');
    mkdirSync(join(mainRoot, '.claudedocs'), { recursive: true });
    mkdirSync(join(mainRoot, 'scripts', 'eval', 'review-eval'), { recursive: true });
    writeFileSync(join(mainRoot, '.claudedocs', '2026-11-01-pr-review-dataset.json'), JSON.stringify(dataset));
    writeFileSync(join(mainRoot, 'scripts', 'eval', 'review-eval', 'config.json'), JSON.stringify({ reserve: [], holdoutExclude: [] }));
    return { repo, mainRoot };
  }
  const stage = (repo: string, name: string, text: string | Buffer): void => {
    writeFileSync(join(repo, name), text);
    execFileSync('git', ['add', '--', name], { cwd: repo, windowsHide: true });
  };
  const GOOD = { prs: [{ pr: 9001 }], findings: [{ pr: 9001, comment_id: Number(CID) }] };

  it('CH7: an added line whose content starts with ++ is counted (item 12)', () => {
    // Breaks when: lines that start with +++ are dropped (the old header filter).
    const w = world(GOOD);
    stage(w.repo, 'p.txt', `++ ${CID}\n`);
    expect(stagedHoldoutCount(w.repo, w.mainRoot)).toBe(1);
  });

  it('CH8: an id list read from a dataset of the wrong shape gives no count, not a short list (item 14)', () => {
    // Breaks when: a dataset with no findings key gives the PR numbers only and the staged id is missed (count 0).
    const w = world({ prs: [{ pr: 9001 }] });
    stage(w.repo, 'p.txt', `+ ${CID}\n`);
    expect(stagedHoldoutCount(w.repo, w.mainRoot)).toBeNull();
  });

  it('CH9: staged lines over the read bound give too-large', () => {
    // Breaks when: an over-bound read returns null (silent) or a count of a prefix.
    const w = world(GOOD);
    stage(w.repo, 'big.txt', `${'x'.repeat(1_600_000)}\n`);
    expect(stagedHoldoutCount(w.repo, w.mainRoot)).toBe('too-large');
  });

  it('CH10: staged lines over the bound in UTF-8 bytes but under it in string length give too-large (PR 612 review, minor)', () => {
    // Breaks when: the bound counts UTF-16 code units (600,000 euro signs are 600,000 units but 1,800,000 bytes).
    const w = world(GOOD);
    stage(w.repo, 'euro.txt', `${'€'.repeat(600_000)}\n`);
    expect(stagedHoldoutCount(w.repo, w.mainRoot)).toBe('too-large');
  });
});
