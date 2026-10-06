/**
 * shared/done-proof: the one judge behind the commit-time done-check and test-before-done.
 *
 * Each `it` names the change that breaks it (the "Breaks when" column of the PR2 spec, section d).
 * Real functions are imported; timestamps are passed in, so no test waits on a clock.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  hasE2e,
  isRatchet,
  judge,
  latestSidecar,
  readTestRun,
  type Sidecar,
  type TestRun,
} from '../shared/done-proof.js';
import { getStateFile } from '../shared/test-run-state.js';
import { SHA, iso, tempDir, writeRegistry, writeSidecar } from './correct-helpers.js';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const MIN = 60_000;
const SHORT = SHA.slice(0, 7);

const run = (over: Partial<TestRun> = {}): TestRun => ({
  lastTestRun: NOW - MIN,
  command: 'npx vitest run',
  ok: true,
  ...over,
});

const sidecar = (over: Partial<Sidecar> = {}): Sidecar => ({
  exit: 0,
  started: iso(NOW - 2 * MIN),
  finished: iso(NOW - MIN),
  head: SHORT,
  artifact: '.claude/cache/e2e/x.log',
  ...over,
});

const verdict = (over: Partial<Parameters<typeof judge>[0]> = {}) =>
  judge({ run: null, sidecar: null, head: SHA, hasE2e: true, now: NOW, ...over });

describe('judge', () => {
  // commit-no-proof: breaks when the `none` branch is removed.
  it('none: no run and no sidecar in a repo with e2e', () => {
    const v = verdict();
    expect(v.kind).toBe('none');
    expect(v.message).toContain('verify.mjs');
    expect(v.message).toContain('5 minutes');
  });

  // ratchet-is-not-proof: breaks when isRatchet is dropped from `proven`.
  it.each([
    'node scripts/rules/context-budget-guard.mjs --repo',
    'node scripts/skills/audit-skills.mjs',
  ])('none: a ratchet run is not proof (%s)', (command) => {
    expect(verdict({ run: run({ command }) }).kind).toBe('none');
  });

  it.each([
    'npx vitest run',
    'node scripts/coordination/lease-probe.mjs',
    'node ~/.claude/scripts/verify.mjs',
    'uv run pytest',
  ])('proven: a recent %s run', (command) => {
    expect(verdict({ run: run({ command }) }).kind).toBe('proven');
  });

  it('none: a run older than 5 minutes is not proof', () => {
    expect(verdict({ run: run({ lastTestRun: NOW - 6 * MIN }) }).kind).toBe('none');
  });

  it('proven: ok null (unknown exit) still counts as a run', () => {
    expect(verdict({ run: run({ ok: null }) }).kind).toBe('proven');
  });

  // failed-sidecar: breaks when the `failed` branch stops reading `exit`.
  it('failed: a sidecar with a non-zero exit', () => {
    const v = verdict({ sidecar: sidecar({ exit: 1 }) });
    expect(v.kind).toBe('failed');
    expect(v.message).toContain('last verify exited 1');
    expect(v.message).toContain('.claude/cache/e2e/x.log');
    expect(v.message).toContain('verify.mjs');
  });

  it('a failed sidecar older than 30 minutes is not reported', () => {
    const old = sidecar({ exit: 1, started: iso(NOW - 50 * MIN), finished: iso(NOW - 45 * MIN) });
    expect(verdict({ sidecar: old }).kind).toBe('none');
  });

  // killed-sidecar: breaks when null is treated as a pass, or the message says "exited null".
  it('killed: a sidecar with exit null', () => {
    const v = verdict({ sidecar: sidecar({ exit: null, finished: null }) });
    expect(v.kind).toBe('killed');
    expect(v.message).toContain('still running or was killed');
    expect(v.message).not.toContain('exited null');
  });

  // stale-head: breaks when the head check is removed.
  it('stale: a passing sidecar from another commit', () => {
    const v = verdict({ sidecar: sidecar({ head: 'abc1234' }) });
    expect(v.kind).toBe('stale');
    expect(v.message).toContain('verify ran on abc1234');
    expect(v.message).toContain(`HEAD is ${SHORT}`);
  });

  // proven-sidecar: breaks when the hook warns on proof.
  it('proven: a passing sidecar on this HEAD, finished 1 minute ago', () => {
    expect(verdict({ sidecar: sidecar() }).kind).toBe('proven');
  });

  it('a short sidecar head matches as a prefix of the full HEAD', () => {
    expect(verdict({ sidecar: sidecar({ head: SHA.slice(0, 12) }) }).kind).toBe('proven');
  });

  it('none: a passing sidecar finished more than 5 minutes ago', () => {
    const old = sidecar({ started: iso(NOW - 20 * MIN), finished: iso(NOW - 10 * MIN) });
    expect(verdict({ sidecar: old }).kind).toBe('none');
  });

  // no-e2e-silent: breaks when `none` fires in a repo without e2e.
  it('proven (silent): nothing to run and no e2e entry', () => {
    expect(verdict({ hasE2e: false }).kind).toBe('proven');
  });

  // no-e2e-failed-speaks: breaks when a failed run is hidden without e2e.
  it('failed: a failed run speaks even without e2e', () => {
    const v = verdict({ run: run({ ok: false, command: 'npx vitest run' }), hasE2e: false });
    expect(v.kind).toBe('failed');
    expect(v.message).toContain('npx vitest run');
  });

  it('failed: a failed sidecar speaks even without e2e', () => {
    expect(verdict({ sidecar: sidecar({ exit: 2 }), hasE2e: false }).kind).toBe('failed');
  });

  it('an unknown HEAD never reports stale', () => {
    expect(verdict({ sidecar: sidecar({ head: 'abc1234' }), head: null }).kind).toBe('none');
  });
});

describe('judge: the newest evidence wins (review fixes)', () => {
  const RATCHET = 'node scripts/rules/context-budget-guard.mjs --repo';
  const failedAt = (agoMin: number) =>
    sidecar({ exit: 1, started: iso(NOW - (agoMin + 1) * MIN), finished: iso(NOW - agoMin * MIN) });

  // Breaks when `failure()` stops exempting ratchets (the module header says one never counts).
  it('a failed ratchet is not a failed test run', () => {
    const v = verdict({ run: run({ command: RATCHET, ok: false }), hasE2e: false });
    expect(v.kind).toBe('proven');
  });

  // Breaks when an old sidecar failure is reported over a newer test run outside the 5-min window.
  it('a failed verify older than the last test run is not reported', () => {
    const v = verdict({ sidecar: failedAt(20), run: run({ lastTestRun: NOW - 10 * MIN }) });
    expect(v.kind).toBe('none');
  });

  it('a failed verify newer than the last test run is reported', () => {
    const v = verdict({ sidecar: failedAt(2), run: run({ lastTestRun: NOW - 10 * MIN }) });
    expect(v.kind).toBe('failed');
  });

  // Breaks when `proven` is checked before the failure and so hides a newer failure.
  it('a failed run newer than a passing verify overrides it', () => {
    const v = verdict({ sidecar: sidecar({ finished: iso(NOW - 4 * MIN) }), run: run({ ok: false, lastTestRun: NOW - MIN }) });
    expect(v.kind).toBe('failed');
    expect(v.message).toContain('last test run failed');
  });

  it('a failed verify newer than a passing run overrides it', () => {
    const v = verdict({ run: run({ lastTestRun: NOW - 4 * MIN }), sidecar: failedAt(1) });
    expect(v.kind).toBe('failed');
    expect(v.message).toContain('last verify exited 1');
  });

  it('a verify that is still running, newer than a passing run, overrides it', () => {
    const v = verdict({ run: run({ lastTestRun: NOW - 4 * MIN }), sidecar: sidecar({ exit: null, started: iso(NOW - MIN), finished: null }) });
    expect(v.kind).toBe('killed');
  });

  it('an older failure does not override a newer proof', () => {
    expect(verdict({ run: run({ ok: false, lastTestRun: NOW - 3 * MIN }), sidecar: sidecar() }).kind).toBe('proven');
    expect(verdict({ sidecar: failedAt(4), run: run({ lastTestRun: NOW - MIN }) }).kind).toBe('proven');
  });

  // Breaks when `headMatches` accepts any non-empty prefix.
  it('a sidecar head shorter than 7 characters is not a match', () => {
    expect(verdict({ sidecar: sidecar({ head: '0' }) }).kind).toBe('stale');
    expect(verdict({ sidecar: sidecar({ head: '012345' }) }).kind).toBe('stale');
    expect(verdict({ sidecar: sidecar({ head: '0123456' }) }).kind).toBe('proven');
  });

  it('a sidecar head that is not hex is not a match', () => {
    expect(verdict({ sidecar: sidecar({ head: '0123xyz' }), head: '0123xyz' + SHA.slice(7) }).kind).toBe('stale');
  });

  // Breaks when freshness has only an upper bound.
  it('a future-dated run is not proof', () => {
    expect(verdict({ run: run({ lastTestRun: NOW + 60 * MIN }) }).kind).toBe('none');
  });

  it('a future-dated sidecar is not proof', () => {
    expect(verdict({ sidecar: sidecar({ started: iso(NOW + 59 * MIN), finished: iso(NOW + 60 * MIN) }) }).kind).toBe('none');
  });

  it('a few seconds of clock skew still count as fresh', () => {
    expect(verdict({ run: run({ lastTestRun: NOW + 10_000 }) }).kind).toBe('proven');
  });
});

describe('isRatchet', () => {
  it('is true for the two size ratchets only', () => {
    expect(isRatchet('node scripts/rules/context-budget-guard.mjs --repo')).toBe(true);
    expect(isRatchet('node scripts/skills/audit-skills.mjs')).toBe(true);
    expect(isRatchet('npx vitest run')).toBe(false);
    expect(isRatchet('node ~/.claude/scripts/verify.mjs')).toBe(false);
    expect(isRatchet(undefined)).toBe(false);
  });
});

describe('latestSidecar', () => {
  it('returns null when the e2e directory does not exist', () => {
    expect(latestSidecar(tempDir('nosidecar'))).toBeNull();
  });

  it('picks the newest by `started`, not by file name', () => {
    const repo = tempDir('sidecars');
    // The name sorts last but the run is older.
    writeSidecar(repo, 'zzz-old', { exit: 1, started: iso(NOW - 30 * MIN), finished: iso(NOW - 29 * MIN), head: 'aaaaaaa' });
    writeSidecar(repo, 'aaa-new', { exit: 0, started: iso(NOW - 2 * MIN), finished: iso(NOW - MIN), head: SHORT });
    const s = latestSidecar(repo)!;
    expect(s.exit).toBe(0);
    expect(s.head).toBe(SHORT);
  });

  it('skips a file that is not JSON', () => {
    const repo = tempDir('badsidecar');
    writeSidecar(repo, 'good', { exit: 0, started: iso(NOW), finished: iso(NOW), head: SHORT });
    writeFileSync(join(repo, '.claude', 'cache', 'e2e', 'broken.log.json'), '{nope');
    expect(latestSidecar(repo)!.head).toBe(SHORT);
  });

  it('keeps exit null as null', () => {
    const repo = tempDir('nullexit');
    writeSidecar(repo, 'running', { exit: null, started: iso(NOW), finished: null, head: SHORT });
    const s = latestSidecar(repo)!;
    expect(s.exit).toBeNull();
    expect(s.finished).toBeNull();
  });
});

describe('hasE2e', () => {
  it('is true when the registry entry for the repo root has an e2e key', () => {
    const dir = tempDir('reg');
    const reg = writeRegistry(join(dir, 'r.json'), [{ name: 'p', path: dir, e2e: { command: 'x' } }]);
    expect(hasE2e(dir, null, reg)).toBe(true);
  });

  it('matches case-insensitively and across slash styles', () => {
    const dir = tempDir('regcase');
    const reg = writeRegistry(join(dir, 'r.json'), [
      { name: 'p', path: dir.replace(/\\/g, '/').toUpperCase(), e2e: { none: 'x' } },
    ]);
    expect(hasE2e(dir.replace(/\//g, '\\').toLowerCase(), null, reg)).toBe(true);
  });

  it('is false for an entry without e2e', () => {
    const dir = tempDir('regno');
    const reg = writeRegistry(join(dir, 'r.json'), [{ name: 'p', path: dir }]);
    expect(hasE2e(dir, null, reg)).toBe(false);
  });

  it('is false for a path that is only under an entry', () => {
    const dir = tempDir('regunder');
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    const reg = writeRegistry(join(dir, 'r.json'), [{ name: 'p', path: dir, e2e: { command: 'x' } }]);
    expect(hasE2e(sub, null, reg)).toBe(false);
  });

  it('a worktree uses its main root', () => {
    const dir = tempDir('regmain');
    const reg = writeRegistry(join(dir, 'r.json'), [{ name: 'p', path: dir, e2e: { command: 'x' } }]);
    expect(hasE2e(join(dir, '..', 'some-worktree'), dir, reg)).toBe(true);
  });

  it('is false (fail open) when the registry is missing or broken', () => {
    const dir = tempDir('regmissing');
    expect(hasE2e(dir, null, join(dir, 'absent.json'))).toBe(false);
    writeFileSync(join(dir, 'bad.json'), '{{');
    expect(hasE2e(dir, null, join(dir, 'bad.json'))).toBe(false);
  });
});

describe('readTestRun', () => {
  const sid = 'done-proof-read-run';
  const file = getStateFile(sid)!;
  afterEach(() => {
    rmSync(file, { force: true });
  });

  it('reads ok true, false and null', () => {
    writeFileSync(file, JSON.stringify({ lastTestRun: 5, command: 'a', ok: false }));
    expect(readTestRun(sid)).toEqual({ lastTestRun: 5, command: 'a', ok: false });
    writeFileSync(file, JSON.stringify({ lastTestRun: 5, command: 'a', ok: true }));
    expect(readTestRun(sid)!.ok).toBe(true);
    writeFileSync(file, JSON.stringify({ lastTestRun: 5, command: 'a', ok: null }));
    expect(readTestRun(sid)!.ok).toBeNull();
  });

  it('a state file written before the ok field has ok null', () => {
    writeFileSync(file, JSON.stringify({ lastTestRun: 5, command: 'a' }));
    expect(readTestRun(sid)!.ok).toBeNull();
  });

  it('returns null for no session id, no file, empty, garbage or a zero timestamp', () => {
    expect(readTestRun(undefined)).toBeNull();
    expect(readTestRun('done-proof-no-such-session')).toBeNull();
    writeFileSync(file, '');
    expect(readTestRun(sid)).toBeNull();
    writeFileSync(file, 'nope{');
    expect(readTestRun(sid)).toBeNull();
    writeFileSync(file, JSON.stringify({ lastTestRun: 0, command: 'a' }));
    expect(readTestRun(sid)).toBeNull();
  });
});
