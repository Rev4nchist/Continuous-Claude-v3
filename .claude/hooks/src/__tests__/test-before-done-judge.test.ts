/**
 * test-before-done calls the same `judge` as commit-preflight (one source of truth).
 * These rows break when handleTaskUpdate goes back to "any state file within 5 minutes".
 */
import * as fs from 'fs';
import { afterEach, describe, expect, it } from 'vitest';

import { handleTaskUpdate } from '../test-before-done.js';
import { getStateFile } from '../shared/test-run-state.js';
import { SHA, iso, mkRepo, tempDir, writeSidecar } from './correct-helpers.js';

const SESSION = 'test-before-done-judge-session';
const stateFile = getStateFile(SESSION)!;
afterEach(() => fs.rmSync(stateFile, { force: true }));

// Without a repo of its own a test runs in an empty directory: a sidecar written in this checkout
// a moment ago must not decide it.
const NO_REPO = tempDir('judge-norepo');
const completed = (cwd: string = NO_REPO) => ({
  session_id: SESSION,
  cwd,
  tool_name: 'TaskUpdate',
  tool_input: { status: 'completed' },
});

const writeRun = (command: string, ok: boolean | null) =>
  fs.writeFileSync(stateFile, JSON.stringify({ lastTestRun: Date.now() - 30_000, command, ok }));

describe('handleTaskUpdate uses judge', () => {
  it('a ratchet run is not proof', () => {
    writeRun('node scripts/rules/context-budget-guard.mjs --repo', true);
    expect(handleTaskUpdate(completed())).not.toBeNull();
  });

  it('a failed run speaks, and names the command', () => {
    writeRun('npx vitest run', false);
    const out = handleTaskUpdate(completed())!;
    expect(out.hookSpecificOutput.additionalContext).toContain('npx vitest run');
  });

  it('a failed verify sidecar in the task cwd speaks', () => {
    const repo = mkRepo(tempDir('tbd'), 'work');
    const now = Date.now();
    writeSidecar(repo, 'v', { exit: 1, started: iso(now - 120_000), finished: iso(now - 60_000), head: SHA.slice(0, 7) });
    const out = handleTaskUpdate(completed(repo))!;
    expect(out.hookSpecificOutput.additionalContext).toContain('last verify exited 1');
  });

  it('a passing sidecar on this HEAD is proof', () => {
    const repo = mkRepo(tempDir('tbdok'), 'work');
    const now = Date.now();
    writeSidecar(repo, 'v', { exit: 0, started: iso(now - 120_000), finished: iso(now - 60_000), head: SHA.slice(0, 7) });
    expect(handleTaskUpdate(completed(repo))).toBeNull();
  });

  it('still warns with no proof at all (the pre-judge behaviour)', () => {
    expect(handleTaskUpdate(completed())).not.toBeNull();
  });
});
