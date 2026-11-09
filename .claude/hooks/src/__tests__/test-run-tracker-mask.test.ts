/**
 * test-run-tracker must not write a secret from the command line to the state file.
 *
 * The state file ($TEMP/claude-recent-test-runs-<session>.json) is a plain temp file. A command like
 * `GITHUB_TOKEN=ghp_xxx vitest run` or `vitest run --token abc` used to land there as typed.
 * The tracker now stores maskSecrets(command). These tests check three things:
 *   1. the secret is not in the file;
 *   2. the run is still recorded (lastTestRun, ok);
 *   3. the readers (done-proof) still classify the stored command as before.
 */
import * as fs from 'fs';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';

import { isTestCommand, main } from '../test-run-tracker.js';
import { isRatchet, readTestRun, runProves } from '../shared/done-proof.js';
import { getStateFile } from '../shared/test-run-state.js';
import { loadFixture } from './correct-helpers.js';

const SESSION = 'test-run-tracker-mask-session';
const stateFile = getStateFile(SESSION)!;
afterEach(() => fs.rmSync(stateFile, { force: true }));

// Fake values built here, so no real credential is in the repo.
const GH_TOKEN = 'ghp_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5';
const FLAG_SECRET = 'abc123secret';
const exit0 = () => loadFixture('posttooluse-bash-exit0', { SESSION });
const exit3 = () => loadFixture('posttoolusefailure-bash-exit3', { SESSION });

async function track(payload: Record<string, unknown>, command: string): Promise<any> {
  (payload as any).tool_input.command = command;
  const original = process.stdin;
  const stdin = new PassThrough();
  Object.defineProperty(process, 'stdin', { value: stdin, writable: true });
  try {
    const done = main();
    stdin.end(JSON.stringify(payload));
    await done;
  } finally {
    Object.defineProperty(process, 'stdin', { value: original, writable: true });
  }
  return fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
}

const rawFile = (): string => fs.readFileSync(stateFile, 'utf8');

describe('the state file holds no secret', () => {
  // Breaks when the tracker writes the raw command again.
  it('masks a GitHub token in an env prefix', async () => {
    const state = await track(exit0(), `GITHUB_TOKEN=${GH_TOKEN} vitest run`);
    expect(rawFile()).not.toContain(GH_TOKEN);
    expect(rawFile()).not.toContain(GH_TOKEN.slice(4));
    expect(typeof state.lastTestRun).toBe('number');
    expect(state.ok).toBe(true);
    expect(isTestCommand(state.command)).toBe(true);
  });

  it('masks a bare ghp_ token in an argument', async () => {
    const state = await track(exit0(), `npx vitest run --reporter dot ${GH_TOKEN}`);
    expect(rawFile()).not.toContain(GH_TOKEN);
    expect(isTestCommand(state.command)).toBe(true);
  });

  it('masks a --token flag with a separate value', async () => {
    const state = await track(exit0(), `npx vitest run --token ${FLAG_SECRET}`);
    expect(rawFile()).not.toContain(FLAG_SECRET);
    expect(state.command).toContain('vitest run');
    expect(isTestCommand(state.command)).toBe(true);
  });

  it('masks a --token=value flag', async () => {
    const state = await track(exit0(), `pytest --token=${FLAG_SECRET} -q`);
    expect(rawFile()).not.toContain(FLAG_SECRET);
    expect(isTestCommand(state.command)).toBe(true);
  });

  // The failure event path writes the same file.
  it('masks the command of a failed run and keeps ok:false', async () => {
    const state = await track(exit3(), `GITHUB_TOKEN=${GH_TOKEN} pytest`);
    expect(rawFile()).not.toContain(GH_TOKEN);
    expect(state.ok).toBe(false);
    expect(isTestCommand(state.command)).toBe(true);
  });
});

describe('the readers classify the stored command as before', () => {
  // Breaks when masking turns a vitest run into something done-proof does not count.
  it('a masked vitest run still proves (readTestRun then runProves)', async () => {
    await track(exit0(), `GITHUB_TOKEN=${GH_TOKEN} npx vitest run --token ${FLAG_SECRET}`);
    expect(rawFile()).not.toContain(GH_TOKEN);
    expect(rawFile()).not.toContain(FLAG_SECRET);
    const run = readTestRun(SESSION);
    expect(run?.ok).toBe(true);
    expect(isRatchet(run?.command)).toBe(false);
    expect(runProves(run, Date.now())).toBe(true);
  });

  // Breaks when masking removes the verify script name.
  it('a masked verify run is still a test run and still proves', async () => {
    const state = await track(exit0(), `node ~/.claude/scripts/verify.mjs --password ${FLAG_SECRET}`);
    expect(rawFile()).not.toContain(FLAG_SECRET);
    expect(isTestCommand(state.command)).toBe(true);
    expect(isRatchet(state.command)).toBe(false);
    expect(runProves(readTestRun(SESSION), Date.now())).toBe(true);
  });

  it('a masked probe run is still a test run', async () => {
    // node scripts need `node` at the start of the command: the secret goes in a trailing flag.
    const state = await track(exit0(), `node scripts/coordination/claim-probe.mjs --api-key ${GH_TOKEN}`);
    expect(rawFile()).not.toContain(GH_TOKEN);
    expect(isTestCommand(state.command)).toBe(true);
  });

  // Breaks when masking hides a ratchet from isRatchet: it would then count as proof.
  it('a masked ratchet run is still a ratchet and never proves', async () => {
    const state = await track(exit0(), `node scripts/rules/context-budget-guard.mjs --repo --token=${GH_TOKEN}`);
    expect(rawFile()).not.toContain(GH_TOKEN);
    expect(isRatchet(state.command)).toBe(true);
    expect(runProves(readTestRun(SESSION), Date.now())).toBe(false);
  });

  // A ratchet never overwrites an earlier test run (keepsEarlierRun reads the raw command, so masking cannot change that).
  // The earlier run holds a secret too: the file keeps its masked text and never gains the ratchet's secret.
  it('a ratchet with a secret does not overwrite an earlier vitest run, and no secret reaches the file', async () => {
    await track(exit0(), `vitest run --token ${GH_TOKEN}`);
    const state = await track(exit0(), `node scripts/audit-skills.mjs --token ${FLAG_SECRET}`);
    expect(state.command).toBe('vitest run --token ***');
    expect(rawFile()).not.toContain(GH_TOKEN);
    expect(rawFile()).not.toContain(FLAG_SECRET);
  });
});

describe('a command with no secret is stored unchanged', () => {
  it('keeps a plain vitest command byte for byte', async () => {
    const state = await track(exit0(), 'npx vitest run src/__tests__/test-run-tracker.test.ts');
    expect(state.command).toBe('npx vitest run src/__tests__/test-run-tracker.test.ts');
  });
});
