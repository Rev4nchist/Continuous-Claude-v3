/**
 * context-pct-warning E2E — spawns the built dist hook, so what passes here is
 * what the harness actually runs.
 *
 * The hook reads $TMP/claude-context-pct-<sid8>.txt (written by status.py) and
 * injects tiered handoff nudges at 70/80/90%. These tests write that file for
 * synthetic session ids and assert the emitted shape is the one the harness
 * reads (hookSpecificOutput.additionalContext), not the dead result/message
 * shape — see shared/output.ts for why that distinction is load-bearing.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __filename_ = fileURLToPath(import.meta.url);
const __dirname_ = resolve(__filename_, '..');
const HOOK_PATH = resolve(__dirname_, '..', '..', 'dist', 'context-pct-warning.mjs');

const cleanupFiles: string[] = [];

function pctFileFor(sessionId: string): string {
  return join(tmpdir(), `claude-context-pct-${sessionId.slice(0, 8)}.txt`);
}

/** Run the dist hook with the given stdin, return parsed stdout JSON. */
function runHook(input: string): { raw: string; json: Record<string, unknown> } {
  const r = spawnSync('node', [HOOK_PATH], { input, encoding: 'utf-8', timeout: 15000 });
  expect(r.status).toBe(0);
  const raw = (r.stdout || '').trim();
  return { raw, json: JSON.parse(raw) };
}

function runWithPct(sessionId: string, pctContent: string) {
  const f = pctFileFor(sessionId);
  writeFileSync(f, pctContent);
  cleanupFiles.push(f);
  return runHook(JSON.stringify({ session_id: sessionId, prompt: 'hello' }));
}

function contextOf(json: Record<string, unknown>): string {
  const hso = json.hookSpecificOutput as { hookEventName?: string; additionalContext?: string } | undefined;
  expect(hso, 'expected hookSpecificOutput (the shape the harness reads)').toBeDefined();
  expect(hso!.hookEventName).toBe('UserPromptSubmit');
  return hso!.additionalContext ?? '';
}

afterAll(() => {
  for (const f of cleanupFiles) {
    try { rmSync(f, { force: true }); } catch { /* best effort */ }
  }
});

describe('context-pct-warning', () => {
  it('dist file exists (src without build changes nothing)', () => {
    expect(existsSync(HOOK_PATH), `missing ${HOOK_PATH} — run npm run build`).toBe(true);
  });

  it('injects CRITICAL at >=90%', () => {
    const { json } = runWithPct('ctxp90aa-test', '92');
    const msg = contextOf(json);
    expect(msg).toContain('CONTEXT CRITICAL: 92%');
    expect(msg).toContain('/create_handoff');
  });

  it('injects WARNING at >=80%', () => {
    const { json } = runWithPct('ctxp80bb-test', '85');
    const msg = contextOf(json);
    expect(msg).toContain('CONTEXT WARNING: 85%');
  });

  it('injects the soft nudge at >=70%', () => {
    const { json } = runWithPct('ctxp70cc-test', '72');
    const msg = contextOf(json);
    expect(msg).toContain('Context at 72%');
  });

  it('stays silent below 70%', () => {
    const { json } = runWithPct('ctxp50dd-test', '55');
    expect(json).toEqual({ result: 'continue' });
  });

  it('stays silent when the pct file does not exist', () => {
    const { json } = runHook(JSON.stringify({ session_id: 'ctxp-none-test', prompt: 'hi' }));
    expect(json).toEqual({ result: 'continue' });
  });

  it('stays silent on non-numeric file content', () => {
    const { json } = runWithPct('ctxpNaNe-test', 'not-a-number');
    expect(json).toEqual({ result: 'continue' });
  });

  it('survives malformed stdin (fail-open)', () => {
    const { json } = runHook('{not json');
    expect(json).toEqual({ result: 'continue' });
  });

  it('survives empty stdin (fail-open)', () => {
    const { json } = runHook('');
    expect(json).toEqual({ result: 'continue' });
  });
});
