/**
 * QW-05 regression test for the epistemic-reminder PostToolUse hook.
 *
 * Finding D2d-03: the hook read `input.tool`, but Claude Code emits the
 * field as `input.tool_name` on PostToolUse. Result: the Grep
 * claim-verification guard NEVER fired. This test pins the real contract:
 *
 *   * A PostToolUse input with `tool_name: 'Grep'` MUST inject the
 *     epistemic / claim-verification warning.
 *   * An unrelated tool (`tool_name: 'Read'`) MUST NOT inject anything.
 *
 * The hook is spawned as the BUILT subprocess (dist/epistemic-reminder.mjs)
 * so the test exercises the real runtime contract (stdin JSON -> stdout JSON),
 * mirroring the spawn pattern in memory-awareness.test.ts.
 *
 * Output field: QW-05 also corrected the OUTPUT field. The hook previously
 * emitted its warning in `hookSpecificOutput.systemPromptSuffix` — a lone
 * outlier that Claude Code does NOT inject for PostToolUse (every other
 * injecting hook + the hook-dev-lifecycle contract use `additionalContext`).
 * So even with the `tool_name` fix the warning would never reach the model.
 * The hook now emits `hookSpecificOutput.additionalContext`; the test pins
 * that canonical field and asserts the old field is gone (closes D2d-03
 * end-to-end — claim-verification.md's "injects after Grep results" is now true).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const HOOK_PATH = resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'epistemic-reminder.mjs',
);

interface HookResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  parsed?: any;
}

/**
 * Spawn the built hook with the given stdin payload.
 * Returns parsed JSON output (when valid) along with raw stdio.
 * VITEST_* env is stripped so the bundled hook never takes a test path.
 */
function runHook(input: object, timeoutMs = 15000): HookResult {
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('VITEST')) cleanEnv[k] = v;
  }

  const result = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: cleanEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdout = (result.stdout || '').toString();
  let parsed: any;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    /* leave parsed undefined */
  }

  return {
    exitCode: result.status,
    stdout,
    stderr: (result.stderr || '').toString(),
    parsed,
  };
}

/** Pull the guard text from the canonical inject field. */
function injectedText(parsed: any): string {
  const hso = parsed?.hookSpecificOutput;
  if (!hso) return '';
  return String(hso.additionalContext ?? hso.systemPromptSuffix ?? '');
}

const TEST_TIMEOUT_MS = 20000;

beforeAll(() => {
  if (!existsSync(HOOK_PATH)) {
    throw new Error(
      `Built hook not found at ${HOOK_PATH}. Run 'npm run build' first.`,
    );
  }
});

describe('epistemic-reminder QW-05: tool_name field contract', () => {
  // Unique per run: the hook now fires once per session (P22), keyed by session_id.
  const grepSession = `qw05-grep-${process.pid}-${Date.now()}`;

  it('injects the claim-verification warning for tool_name: "Grep"', () => {
    const result = runHook({
      session_id: grepSession,
      hook_event_name: 'PostToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'try.*catch', path: 'src/' },
      tool_response: { content: 'src/foo.ts:42: try { doThing(); } catch {}' },
    });

    // Hook must exit cleanly and emit a parseable JSON object.
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toBeDefined();

    // The Grep case MUST inject the epistemic guard text via the canonical
    // `additionalContext` field (the field Claude Code actually consumes for
    // PostToolUse), NOT the dead `systemPromptSuffix` outlier.
    const text = injectedText(result.parsed);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('EPISTEMIC REMINDER');
    expect(result.parsed?.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
    expect(result.parsed?.hookSpecificOutput?.additionalContext).toContain('EPISTEMIC REMINDER');
    expect(result.parsed?.hookSpecificOutput?.systemPromptSuffix).toBeUndefined();
  }, TEST_TIMEOUT_MS);

  it('does NOT repeat the warning on a second Grep in the same session (P22)', () => {
    const result = runHook({
      session_id: grepSession,
      hook_event_name: 'PostToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'x' },
      tool_response: { content: '' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({});
  }, TEST_TIMEOUT_MS);

  it('does NOT inject the warning for an unrelated tool (tool_name: "Read")', () => {
    const result = runHook({
      session_id: 'qw05-read',
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/foo.ts' },
      tool_response: { content: 'file contents here' },
    });

    expect(result.exitCode).toBe(0);
    // No injection: hook emits an empty object for non-Grep tools.
    expect(result.parsed).toEqual({});
    expect(injectedText(result.parsed)).toBe('');
  }, TEST_TIMEOUT_MS);
});
