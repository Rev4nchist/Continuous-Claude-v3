/**
 * context-pct-warning -- reconstructed source (2026-08-31, harness-security lane).
 * Runs the built dist bundle against the state-file contract: escalating
 * handoff warnings at 70/80/90%, outputContinue everywhere else.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const HOOK = resolve(__dirname, '../../dist/context-pct-warning.mjs');
const SESSION_ID = 'cpwtest1-0000-0000-0000-000000000000';
const STATE_FILE = join(tmpdir(), `claude-context-pct-${SESSION_ID.slice(0, 8)}.txt`);

function runHook(stdin: string): { out: Record<string, unknown>; status: number | null } {
  const res = spawnSync('node', [HOOK], {
    input: stdin,
    encoding: 'utf8',
    timeout: 15000,
  });
  return { out: JSON.parse(res.stdout.trim()), status: res.status };
}

function payload(): string {
  return JSON.stringify({ session_id: SESSION_ID, prompt: 'hello' });
}

describe('context-pct-warning', () => {
  beforeEach(() => {
    rmSync(STATE_FILE, { force: true });
  });
  afterAll(() => {
    rmSync(STATE_FILE, { force: true });
  });

  it('continues when no state file exists', () => {
    const { out, status } = runHook(payload());
    expect(status).toBe(0);
    expect(out).toEqual({ result: 'continue' });
  });

  it('continues below 70%', () => {
    writeFileSync(STATE_FILE, '65');
    const { out } = runHook(payload());
    expect(out).toEqual({ result: 'continue' });
  });

  it('injects a gentle nudge at 70-79%', () => {
    writeFileSync(STATE_FILE, '72');
    const { out } = runHook(payload());
    const hso = out.hookSpecificOutput as Record<string, string>;
    expect(hso.hookEventName).toBe('UserPromptSubmit');
    expect(hso.additionalContext).toContain('Context at 72%');
  });

  it('injects CONTEXT WARNING at 80-89%', () => {
    writeFileSync(STATE_FILE, '85');
    const { out } = runHook(payload());
    const hso = out.hookSpecificOutput as Record<string, string>;
    expect(hso.additionalContext).toContain('CONTEXT WARNING: 85%');
  });

  it('injects CONTEXT CRITICAL at >=90%', () => {
    writeFileSync(STATE_FILE, '95');
    const { out } = runHook(payload());
    const hso = out.hookSpecificOutput as Record<string, string>;
    expect(hso.additionalContext).toContain('CONTEXT CRITICAL: 95%');
  });

  it('continues on a non-numeric state file', () => {
    writeFileSync(STATE_FILE, 'garbage');
    const { out } = runHook(payload());
    expect(out).toEqual({ result: 'continue' });
  });

  it('continues on malformed stdin (never crashes the prompt)', () => {
    const { out, status } = runHook('not json');
    expect(status).toBe(0);
    expect(out).toEqual({ result: 'continue' });
  });
});
