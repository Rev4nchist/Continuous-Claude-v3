/**
 * test-run-tracker records `ok` (did the run pass) next to the timestamp.
 *
 * Evidence for the rule (step 0 of PR2, 2026-10-06, isolated `claude -p --settings` capture; the
 * fixtures are those real payloads): a passing Bash command fires PostToolUse with a tool_response
 * that has NO exit-code field; a failing one fires PostToolUseFailure with `error: "Exit code N"`
 * and no tool_response. So `ok` comes from the event name and the error text.
 */
import * as fs from 'fs';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';

import { main, okOf } from '../test-run-tracker.js';
import { getStateFile } from '../shared/test-run-state.js';
import { loadFixture } from './correct-helpers.js';

const SESSION = 'test-run-tracker-ok-session';
const stateFile = getStateFile(SESSION)!;
afterEach(() => fs.rmSync(stateFile, { force: true }));

const exit0 = () => loadFixture('posttooluse-bash-exit0', { SESSION });
const exit3 = () => loadFixture('posttoolusefailure-bash-exit3', { SESSION });

async function track(payload: Record<string, unknown>): Promise<any> {
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

describe('okOf', () => {
  // Breaks when `ok` stops reading the failure event.
  it('is false for the real PostToolUseFailure payload (exit 3)', () => {
    expect(okOf(exit3() as any)).toBe(false);
  });

  // Breaks when a pass is recorded as null or a failure.
  it('is true for the real PostToolUse payload (exit 0, no exit-code field)', () => {
    expect(okOf(exit0() as any)).toBe(true);
  });

  it('is false when the tool_response carries a non-zero exit code', () => {
    const p = { ...exit0(), tool_response: { exit_code: 2, stdout: '' } };
    expect(okOf(p as any)).toBe(false);
  });

  // Breaks when an interrupt is saved as null: null counts as a pass in done-proof.runProves.
  it('is false when the user interrupted the run (an interrupted run is not proof)', () => {
    const p = { ...exit3(), is_interrupt: true };
    expect(okOf(p as any)).toBe(false);
  });

  it('is null when the payload names no event and carries no exit code', () => {
    const { hook_event_name, ...rest } = exit0() as any;
    expect(hook_event_name).toBe('PostToolUse');
    expect(okOf(rest)).toBeNull();
  });
});

describe('main() writes ok', () => {
  it('a failing test command records ok:false', async () => {
    const p = exit3() as any;
    p.tool_input.command = 'npx vitest run';
    const state = await track(p);
    expect(state.ok).toBe(false);
    expect(state.command).toBe('npx vitest run');
  });

  it('a passing test command records ok:true', async () => {
    const p = exit0() as any;
    p.tool_input.command = 'npx vitest run';
    expect((await track(p)).ok).toBe(true);
  });

  it('a later failure overwrites an earlier pass', async () => {
    const pass = exit0() as any;
    pass.tool_input.command = 'npx vitest run';
    await track(pass);
    const fail = exit3() as any;
    fail.tool_input.command = 'npx vitest run';
    expect((await track(fail)).ok).toBe(false);
  });

  it('a failing non-test command writes nothing', async () => {
    expect(await track(exit3())).toBeNull();
  });

  it('an interrupted test run records ok:false', async () => {
    const p = { ...exit3(), is_interrupt: true } as any;
    p.tool_input.command = 'npx vitest run';
    expect((await track(p)).ok).toBe(false);
  });
});

describe('main() keeps the proof (review fixes)', () => {
  const RATCHET = 'node scripts/rules/context-budget-guard.mjs --repo';
  const withCommand = (p: any, command: string) => {
    p.tool_input.command = command;
    return p;
  };

  // Breaks when a ratchet run overwrites the single-slot state: AGENTS.md says to run vitest and
  // then context-budget-guard, and the second run must not erase the first.
  it('a ratchet run does not overwrite a vitest run', async () => {
    await track(withCommand(exit0(), 'npx vitest run'));
    const state = await track(withCommand(exit0(), RATCHET));
    expect(state.command).toBe('npx vitest run');
    expect(state.ok).toBe(true);
  });

  it('a passing ratchet run does not hide a failed vitest run', async () => {
    await track(withCommand(exit3(), 'npx vitest run'));
    const state = await track(withCommand(exit0(), RATCHET));
    expect(state.command).toBe('npx vitest run');
    expect(state.ok).toBe(false);
  });

  it('a ratchet run is still recorded when nothing else is', async () => {
    expect((await track(withCommand(exit0(), RATCHET))).command).toBe(RATCHET);
  });

  it('a vitest run overwrites a ratchet run', async () => {
    await track(withCommand(exit0(), RATCHET));
    expect((await track(withCommand(exit0(), 'npx vitest run'))).command).toBe('npx vitest run');
  });

  // Breaks when a background start (PostToolUse fires before any test finishes) is saved as a pass.
  it('a test started in the background records nothing', async () => {
    const p = withCommand(exit0(), 'npx vitest run') as any;
    p.tool_input.run_in_background = true;
    expect(await track(p)).toBeNull();
  });

  it('a background start does not overwrite an earlier record', async () => {
    await track(withCommand(exit3(), 'npx vitest run'));
    const p = withCommand(exit0(), 'npx vitest run') as any;
    p.tool_input.run_in_background = true;
    expect((await track(p)).ok).toBe(false);
  });
});
