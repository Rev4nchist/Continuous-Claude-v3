/**
 * dc-config-guard: desktop-commander set_config_value can widen what later tool calls may do
 * (empty blockedCommands, allowedDirectories [] = whole filesystem, a new defaultShell).
 *
 * Ways it can fail (one case each):
 *  1. A key that widens access passes with no ask.
 *  2. The unattended path asks (hangs) instead of denying.
 *  3. A missing or non-string key passes (must fail closed).
 *  4. An unknown key passes (must fail closed: only listed keys pass).
 *  5. A listed harmless key (telemetryEnabled, line limits) is blocked.
 *  6. A different tool is gated.
 *  7. The src logic works but the built dist does not (the harness runs dist).
 */
import { describe, it, expect } from 'vitest';
import { decideConfig, CONFIG_TOOLS } from '../dc-config-guard.js';

const TOOL = 'mcp__plugin_desktop-commander_desktop-commander__set_config_value';
const call = (tool_input: unknown, extra: Record<string, unknown> = {}) => ({ tool_name: TOOL, tool_input, ...extra });

describe('decideConfig', () => {
  it('lists the plugin set_config_value tool', () => {
    expect(CONFIG_TOOLS.has(TOOL)).toBe(true);
  });

  it.each(['blockedCommands', 'allowedDirectories', 'defaultShell'])('asks on %s', (key) => {
    expect(decideConfig(call({ key, value: [] }), {}).decision).toBe('ask');
  });

  it('denies a widening key when unattended', () => {
    const d = decideConfig(call({ key: 'allowedDirectories', value: [] }, { permission_mode: 'bypassPermissions' }), {});
    expect(d.decision).toBe('deny');
    expect(decideConfig(call({ key: 'blockedCommands', value: [] }), { CLAUDE_AGENT_ID: 'a1' }).decision).toBe('deny');
  });

  it('fails closed on a missing or non-string key', () => {
    expect(decideConfig(call({ value: [] }), {}).decision).toBe('ask');
    expect(decideConfig(call({ key: 7, value: [] }), {}).decision).toBe('ask');
    expect(decideConfig(call(undefined), {}).decision).toBe('ask');
  });

  it('fails closed on an unknown key', () => {
    expect(decideConfig(call({ key: 'AllowedDirectories', value: [] }), {}).decision).toBe('ask');
    expect(decideConfig(call({ key: 'someFutureKey', value: true }), {}).decision).toBe('ask');
  });

  it.each(['telemetryEnabled', 'fileReadLineLimit', 'fileWriteLineLimit'])('allows %s', (key) => {
    expect(decideConfig(call({ key, value: 1000 }), {}).decision).toBe('allow');
  });

  it('ignores other tools', () => {
    expect(decideConfig({ tool_name: 'mcp__plugin_desktop-commander_desktop-commander__get_config', tool_input: {} }, {}).decision).toBe('allow');
    expect(decideConfig({ tool_name: 'Bash', tool_input: { command: 'ls' } }, {}).decision).toBe('allow');
  });
});

describe('built hook, subprocess', () => {
  async function run(payload: object): Promise<Record<string, any>> {
    const { spawnSync } = await import('node:child_process');
    const { existsSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dist = fileURLToPath(new URL('../../dist/dc-config-guard.mjs', import.meta.url));
    expect(existsSync(dist)).toBe(true);
    // The built hook runs without VITEST, so its guard log goes to a temp file.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CCV3_GUARD_DECISIONS_LOG: join(mkdtempSync(join(tmpdir(), 'dcfg-')), 'guard-decisions.jsonl'),
    };
    for (const k of ['VITEST', 'VITEST_WORKER_ID', 'CI', 'CLAUDE_AGENT_ID']) delete env[k];
    const res = spawnSync(process.execPath, [dist], {
      input: JSON.stringify({ session_id: 'test-session', permission_mode: 'default', ...payload }),
      encoding: 'utf8',
      timeout: 20_000,
      env,
    });
    expect(res.status).toBe(0);
    return JSON.parse(res.stdout.trim().split('\n').pop()!);
  }
  const verdict = (out: Record<string, any>) => out.hookSpecificOutput?.permissionDecision;

  it('asks when allowedDirectories is set to []', async () => {
    const out = await run(call({ key: 'allowedDirectories', value: [] }));
    expect(verdict(out)).toBe('ask');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/allowedDirectories/);
  });

  it('denies the same call in bypassPermissions mode', async () => {
    expect(verdict(await run(call({ key: 'allowedDirectories', value: [] }, { permission_mode: 'bypassPermissions' })))).toBe('deny');
  });

  it('allows telemetryEnabled', async () => {
    expect(await run(call({ key: 'telemetryEnabled', value: false }))).toEqual({});
  });
});
