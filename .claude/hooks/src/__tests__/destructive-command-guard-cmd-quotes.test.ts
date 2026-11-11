/**
 * destructive-command-guard: the cmd.exe quote reading (RED step).
 *
 * The flaw: a Desktop Commander command such as  echo 'x & rm -rf T & rem '  is inert quoted
 * text under the Bash and PowerShell readings. cmd.exe treats ' as a plain character and & as a
 * command break, so the hidden delete runs unseen.
 *
 * The fix (same as pre-pr-gate, PR 504): a third reading with the real tool name and the quotes
 * NOT blanked. It runs only when blanking changed the text. The two old readings stay first.
 *
 * Failure modes this file pins, one row each:
 *   gap rows (must block):
 *     wrapped rm -rf, start_process, shell cmd; no shell
 *     wrapped Remove-Item -Recurse, start_process, shell cmd; no shell
 *     wrapped rm -rf, interact_with_process
 *     wrapped rm -rf, start_process, unattended (deny, not ask)
 *     double-quoted echo of the command, start_process (accepted over-deny)
 *   control rows (must keep today's verdict):
 *     plain rm -rf and plain Remove-Item through Desktop Commander
 *     the wrapped text under Bash and PowerShell (inert quote text, allow)
 *     the double-quoted echo under Bash (allow)
 *     git status and a plain echo through Desktop Commander (allow)
 *
 * Nothing here runs a command. The path is never created. Only decide() is called.
 */
import { describe, it, expect } from 'vitest';
import { decide } from '../destructive-command-guard.js';

const DC = 'mcp__plugin_desktop-commander_desktop-commander__start_process';
const DCI = 'mcp__plugin_desktop-commander_desktop-commander__interact_with_process';

// A path that is never created and lies in no scoped-cleanup root.
const T = 'C:/no-such-dir-zz9/target';
const RM = `rm -rf ${T}`;
const RI = `Remove-Item -Recurse -Force ${T}`;
const wrap = (c: string) => `echo 'x & ${c} & rem '`;
const dquote = (c: string) => `echo "${c}"`;
// Only SEGMENT_PATTERNS names this one (a Fabric capacity call): the top-level tables do not.
const FAB = 'az fabric capacity suspend --name cap1 --resource-group rg1';

const base = { permission_mode: 'default', session_id: 'cmd-quotes', cwd: 'C:/no-such-dir-zz9' };
const dcStart = (command: string, shell?: string) =>
  ({ ...base, tool_name: DC, tool_input: { command, timeout_ms: 1000, ...(shell ? { shell } : {}) } });
const dcInteract = (text: string) =>
  ({ ...base, tool_name: DCI, tool_input: { pid: 123, input: text } });
const viaBash = (command: string) => ({ ...base, tool_name: 'Bash', tool_input: { command } });
const viaPs = (command: string) => ({ ...base, tool_name: 'PowerShell', tool_input: { command } });

const verdict = (command: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) =>
  decide(command, input, env).decision;

describe('wrapped command under Desktop Commander is blocked like the plain form', () => {
  it('start_process, shell cmd: wrapped rm -rf asks', () => {
    expect(verdict(wrap(RM), dcStart(wrap(RM), 'cmd'))).toBe('ask');
  });
  it('start_process, no shell: wrapped rm -rf asks', () => {
    expect(verdict(wrap(RM), dcStart(wrap(RM)))).toBe('ask');
  });
  it('start_process, shell cmd: wrapped Remove-Item -Recurse asks', () => {
    expect(verdict(wrap(RI), dcStart(wrap(RI), 'cmd'))).toBe('ask');
  });
  it('start_process, no shell: wrapped Remove-Item -Recurse asks', () => {
    expect(verdict(wrap(RI), dcStart(wrap(RI)))).toBe('ask');
  });
  it('interact_with_process: wrapped rm -rf asks', () => {
    expect(verdict(wrap(RM), dcInteract(wrap(RM)))).toBe('ask');
  });
  it('unattended: the wrapped rm -rf is denied, not asked', () => {
    expect(verdict(wrap(RM), dcStart(wrap(RM), 'cmd'), { CLAUDE_AGENT_ID: 'sub-1' })).toBe('deny');
  });
  it('the verdict names the same pattern as the plain form', () => {
    const plain = decide(RM, dcStart(RM, 'cmd'), {});
    const hidden = decide(wrap(RM), dcStart(wrap(RM), 'cmd'), {});
    expect(hidden.pattern).toBe(plain.pattern);
  });
});

describe('segment-table command hidden in the wrapped echo', () => {
  it('plain Fabric suspend through Desktop Commander asks (control: the segment table sees it)', () => {
    expect(verdict(FAB, dcStart(FAB, 'cmd'))).toBe('ask');
  });
  it('start_process: wrapped Fabric suspend asks', () => {
    expect(verdict(wrap(FAB), dcStart(wrap(FAB), 'cmd'))).toBe('ask');
  });
  it('the wrapped Fabric suspend under Bash is inert quote text: allow', () => {
    expect(verdict(wrap(FAB), viaBash(wrap(FAB)))).toBe('allow');
  });
});

describe('accepted over-deny: double-quoted echo of the command through Desktop Commander', () => {
  it('start_process: echo "rm -rf T" asks (cmd.exe would not run it, the guard cannot tell)', () => {
    expect(verdict(dquote(RM), dcStart(dquote(RM), 'cmd'))).toBe('ask');
  });
});

describe('controls: today verdicts stay', () => {
  it('plain rm -rf through Desktop Commander still asks', () => {
    expect(verdict(RM, dcStart(RM, 'cmd'))).toBe('ask');
  });
  it('plain Remove-Item -Recurse through Desktop Commander still asks', () => {
    expect(verdict(RI, dcStart(RI))).toBe('ask');
  });
  it('plain rm -rf through Desktop Commander interact still asks', () => {
    expect(verdict(RM, dcInteract(RM))).toBe('ask');
  });
  it('the wrapped rm -rf under Bash is inert quote text: allow', () => {
    expect(verdict(wrap(RM), viaBash(wrap(RM)))).toBe('allow');
  });
  it('the wrapped Remove-Item under PowerShell is inert quote text: allow', () => {
    expect(verdict(wrap(RI), viaPs(wrap(RI)))).toBe('allow');
  });
  it('the double-quoted echo under Bash stays allow (no over-deny outside Desktop Commander)', () => {
    expect(verdict(dquote(RM), viaBash(dquote(RM)))).toBe('allow');
  });
  it('plain rm -rf under Bash still asks', () => {
    expect(verdict(RM, viaBash(RM))).toBe('ask');
  });
  it('git status through Desktop Commander allows', () => {
    expect(verdict('git status', dcStart('git status', 'cmd'))).toBe('allow');
  });
  it('a plain echo with a quoted word through Desktop Commander allows', () => {
    expect(verdict(`echo 'hello world'`, dcStart(`echo 'hello world'`, 'cmd'))).toBe('allow');
  });
});
