/**
 * package-install-guard: a quoted & that cmd.exe reads as a command break (Desktop Commander).
 *
 * Every case runs the BUILT hook (dist/package-install-guard.mjs) with a real PreToolUse payload, with the
 * registry and OSV stubbed. OSV answers a MAL advisory, so the plain install is a deny.
 *
 * Flaw: echo 'x & <install> & rem ' is inert quoted text under the Bash and PowerShell readings.
 * cmd.exe treats ' as a plain character and & as a command break, so the hidden install runs unseen.
 * Desktop Commander runs the text with cmd when its shell is cmd or is not set (the choice is made at run time).
 *
 * Failure modes, one row each:
 * 1. Wrapped install, start_process, shell cmd: must get the verdict of the plain install.
 * 2. Wrapped install, start_process, no shell field: same.
 * 3. Wrapped install, interact_with_process (text in the "input" field): same.
 * 3b. Wrapped install, tool named in the "tool" field (readShellCommand accepts it): same.
 * Controls, today's verdict stays:
 * 4. The plain install through Desktop Commander and Bash is denied.
 * 5. The wrapped text under Bash and PowerShell is inert text: allowed.
 * 6. git status and an inert quoted echo through Desktop Commander are allowed.
 * Accepted over-deny:
 * 7. A double-quoted echo of the install through Desktop Commander is denied by the new reading.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// PIG_DIST points the run at another build of the hook (a scratch build of the source).
const DIST = process.env.PIG_DIST ?? fileURLToPath(new URL('../../dist/package-install-guard.mjs', import.meta.url));
const NET_STUB = fileURLToPath(new URL('./package-guard-net-stub.cjs', import.meta.url));

const DC_START = 'mcp__plugin_desktop-commander_desktop-commander__start_process';
const DC_INTERACT = 'mcp__plugin_desktop-commander_desktop-commander__interact_with_process';

interface Run { decision: string | undefined; reason: string }

function runHook(tool: string, toolInput: Record<string, unknown>, nameField: 'tool_name' | 'tool' = 'tool_name'): Run {
  const rcHome = mkdtempSync(join(tmpdir(), 'pig-cq-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'pig-cq-cwd-'));
  writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CCV3_GUARD_DECISIONS_LOG: join(rcHome, 'guard-decisions.jsonl'),
    CCV3_GUARD_RC_HOME: rcHome,
    APPDATA: join(rcHome, 'AppData', 'Roaming'),
    PIG_STUB_AGE_HOURS: '2400',
    PIG_STUB_NEXT_HOURS: '2400',
    // The stub answers a MAL advisory: the plain install is a deny, not a pass.
    PIG_STUB_OSV_MAL: '1',
    // An unattended session turns every ask into a deny: blank both so a test sees the real verdict.
    CLAUDE_AGENT_ID: '',
    CI: '',
  };
  delete childEnv.VITEST;
  delete childEnv.VITEST_WORKER_ID;
  delete childEnv.CDPATH;
  const res = spawnSync(process.execPath, ['-r', NET_STUB, DIST], {
    input: JSON.stringify({ session_id: 'test-session', [nameField]: tool, tool_input: toolInput, cwd }),
    encoding: 'utf8',
    timeout: 20_000,
    env: childEnv,
    cwd,
  });
  expect(res.status).toBe(0);
  const out = JSON.parse(res.stdout.trim().split('\n').pop()!);
  return {
    decision: out.hookSpecificOutput?.permissionDecision,
    reason: String(out.hookSpecificOutput?.permissionDecisionReason ?? ''),
  };
}

const gated = (d: string | undefined) => expect(d).toBe('deny');
const allowed = (d: string | undefined) => expect(d).toBeUndefined();

// The words are split so this file does not hold a literal install command.
const PKG = 'zz-nonexistent-pkg-q7x91';
const CMD = 'npm ' + 'install ' + PKG;
const WRAPPED = `echo 'x & ${CMD} & rem '`;
const DQ_WRAPPED = `echo "x & ${CMD} & rem "`;

describe('package-install-guard: quoted & read by cmd.exe in Desktop Commander', () => {
  describe('gap rows: the wrapped install must be gated like the plain one', () => {
    it('start_process, shell cmd', () => {
      gated(runHook(DC_START, { command: WRAPPED, shell: 'cmd', timeout_ms: 1000 }).decision);
    });
    it('start_process, no shell field', () => {
      gated(runHook(DC_START, { command: WRAPPED, timeout_ms: 1000 }).decision);
    });
    it('interact_with_process, text in the input field', () => {
      gated(runHook(DC_INTERACT, { input: WRAPPED, pid: 1234 }).decision);
    });
    it('start_process named in the "tool" field, not "tool_name"', () => {
      gated(runHook(DC_START, { command: WRAPPED, shell: 'cmd', timeout_ms: 1000 }, 'tool').decision);
    });
    it('the verdict names the hidden package, as for the plain form', () => {
      const plain = runHook(DC_START, { command: CMD, shell: 'cmd', timeout_ms: 1000 });
      const wrapped = runHook(DC_START, { command: WRAPPED, shell: 'cmd', timeout_ms: 1000 });
      expect(wrapped.decision).toBe(plain.decision);
      expect(wrapped.reason).toContain(PKG);
    });
  });

  describe('controls: today\'s verdict stays', () => {
    it('plain install, Bash: gated', () => {
      gated(runHook('Bash', { command: CMD }).decision);
    });
    it('plain install, start_process shell cmd: gated', () => {
      gated(runHook(DC_START, { command: CMD, shell: 'cmd', timeout_ms: 1000 }).decision);
    });
    it('plain install, start_process no shell: gated', () => {
      gated(runHook(DC_START, { command: CMD, timeout_ms: 1000 }).decision);
    });
    it('plain install, interact_with_process: gated', () => {
      gated(runHook(DC_INTERACT, { input: CMD, pid: 1234 }).decision);
    });
    it('wrapped text, Bash: inert, allowed', () => {
      allowed(runHook('Bash', { command: WRAPPED }).decision);
    });
    it('wrapped text, PowerShell: inert, allowed', () => {
      allowed(runHook('PowerShell', { command: WRAPPED }).decision);
    });
    it('git status, Bash: allowed', () => {
      allowed(runHook('Bash', { command: 'git status' }).decision);
    });
    it('git status, start_process: allowed', () => {
      allowed(runHook(DC_START, { command: 'git status', shell: 'cmd', timeout_ms: 1000 }).decision);
    });
    it('an echo with no install in the quotes, start_process: allowed', () => {
      allowed(runHook(DC_START, { command: `echo 'x & git status & rem '`, shell: 'cmd', timeout_ms: 1000 }).decision);
    });
  });

  describe('accepted over-deny', () => {
    it('a double-quoted echo of the install through Desktop Commander is gated', () => {
      gated(runHook(DC_START, { command: DQ_WRAPPED, shell: 'cmd', timeout_ms: 1000 }).decision);
    });
  });
});
