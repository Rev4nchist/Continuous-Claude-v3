/**
 * decision-gate push rule: a quote that cmd.exe reads as a plain character must not hide a push (RED step, lane g6-guards-cmd).
 * Same flaw as pre-pr-gate (PR 504). `echo 'x & git push fork feat/x & rem '` is inert quoted text for Bash and PowerShell.
 * cmd.exe treats ' as a plain character and & as a command break, so the push runs. Desktop Commander may run cmd.exe.
 *
 * Rule: a THIRD reading with the real tool name and quotes NOT blanked, only for the Desktop Commander tools. Stricter only.
 *
 * Failure modes, one test group each:
 *   F1  the wrapped push under start_process (shell cmd, and no shell) is allowed (the gap)
 *   F2  the wrapped push under interact_with_process is allowed (the gap)
 *   F3  the new reading changes a verdict it must keep: Bash and PowerShell inert quotes, git status, a plain push
 *   F4  accepted over-deny: a double-quoted echo of the push under Desktop Commander is denied
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, type Deps } from '../decision-gate.js';

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const DC = 'mcp__plugin_desktop-commander_desktop-commander__';
let dir = '';
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-gate-push-cmd-'));
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = join(dir, 'decisions.json');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

const HEAD = 'a'.repeat(40);
const TREE = 't'.repeat(40);

/** A fake git and config for a CCv3 checkout at /repo, with enforcePush on and no tap on record. */
function deps(): Deps {
  const config = JSON.stringify({ decisions: { enforce: true, enforcePush: true } });
  return {
    env: { ...process.env, CCV3_DECISIONS_FILE: join(dir, 'decisions.json') },
    home: '/home/nobody',
    readFile: (p) => (p.replace(/\\/g, '/') === '/repo/review-router.config.json' ? config : null),
    git: (_cwd, args) => {
      const a = args.join(' ');
      if (a === 'remote -v') return { status: 0, stdout: `fork\thttps://github.com/${REPO}.git (push)\n` };
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
      if (a === 'branch --show-current') return { status: 0, stdout: 'feat/x\n' };
      if (/^rev-parse .+\^\{commit\}$/.test(a)) return { status: 0, stdout: `${HEAD}\n` };
      if (/^rev-parse .+\^\{tree\}$/.test(a)) return { status: 0, stdout: `${TREE}\n` };
      return { status: 1, stdout: '' };
    },
  };
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo' });
const pwsh = (command: string) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: '/repo' });
const dcStart = (command: string) => ({ tool_name: `${DC}start_process`, tool_input: { command, shell: 'cmd', timeout_ms: 1000 }, cwd: '/repo' });
const dcStartNoShell = (command: string) => ({ tool_name: `${DC}start_process`, tool_input: { command, timeout_ms: 1000 }, cwd: '/repo' });
const dcInteract = (input: string) => ({ tool_name: `${DC}interact_with_process`, tool_input: { pid: 1, input }, cwd: '/repo' });
const denied = (input: object): boolean => decide(input, deps()).action === 'deny';

const PUSH = 'git push fork feat/x';
/** Inert quoted text for Bash and PowerShell. Under cmd.exe the ' is a plain character, & breaks the command, so PUSH runs. */
const WRAP = `echo 'x & ${PUSH} & rem '`;
/** The accepted over-deny: cmd.exe reads the double quotes, so the push is only text. The guard denies it anyway. */
const DQ_ECHO = `echo "${PUSH}"`;

describe('F1 the wrapped push under start_process is denied like the plain push', () => {
  it('plain push, shell cmd (control: denied today)', () => {
    expect(denied(dcStart(PUSH))).toBe(true);
  });
  it('plain push, no shell (control: denied today)', () => {
    expect(denied(dcStartNoShell(PUSH))).toBe(true);
  });
  it('wrapped push, shell cmd', () => {
    expect(denied(dcStart(WRAP))).toBe(true);
  });
  it('wrapped push, no shell', () => {
    expect(denied(dcStartNoShell(WRAP))).toBe(true);
  });
});

describe('F2 the wrapped push under interact_with_process is denied like the plain push', () => {
  it('plain push (control: denied today)', () => {
    expect(denied(dcInteract(PUSH))).toBe(true);
  });
  it('wrapped push', () => {
    expect(denied(dcInteract(WRAP))).toBe(true);
  });
});

describe('F3 verdicts that must not change', () => {
  it('plain push under Bash stays denied', () => {
    expect(denied(bash(PUSH))).toBe(true);
  });
  it('wrapped text under Bash stays allowed (inert quotes)', () => {
    expect(denied(bash(WRAP))).toBe(false);
  });
  it('wrapped text under PowerShell stays allowed (inert quotes)', () => {
    expect(denied(pwsh(WRAP))).toBe(false);
  });
  it('git status stays allowed under Bash, PowerShell and every Desktop Commander form', () => {
    for (const input of [bash('git status'), pwsh('git status'), dcStart('git status'), dcStartNoShell('git status'), dcInteract('git status')]) {
      expect(denied(input)).toBe(false);
    }
  });
  it('a quoted echo with no push stays allowed under Desktop Commander', () => {
    expect(denied(dcStart(`echo 'x & git status & rem '`))).toBe(false);
    expect(denied(dcInteract(`echo 'hello & world'`))).toBe(false);
  });
});

describe('F5 a quoted executable name or quoted argument (cmd.exe runs "git")', () => {
  const QEXE = `echo 'x & "git" push fork feat/x & rem '`;
  const QBOTH = `echo 'x & "git" push "fork" "feat/x" & rem '`;
  it('quoted executable, start_process', () => {
    expect(denied(dcStart(QEXE))).toBe(true);
  });
  it('quoted executable and quoted arguments, start_process', () => {
    expect(denied(dcStart(QBOTH))).toBe(true);
  });
  it('quoted executable, interact_with_process', () => {
    expect(denied(dcInteract(QEXE))).toBe(true);
  });
  it('quoted executable stays allowed under Bash and PowerShell (inert quotes)', () => {
    expect(denied(bash(QEXE))).toBe(false);
    expect(denied(pwsh(QEXE))).toBe(false);
  });
});

describe('F4 accepted over-deny: a double-quoted echo of the push under Desktop Commander', () => {
  it('start_process is denied', () => {
    expect(denied(dcStart(DQ_ECHO))).toBe(true);
  });
  it('interact_with_process is denied', () => {
    expect(denied(dcInteract(DQ_ECHO))).toBe(true);
  });
  it('the same echo under Bash and PowerShell stays allowed (the third reading is Desktop Commander only)', () => {
    expect(denied(bash(DQ_ECHO))).toBe(false);
    expect(denied(pwsh(DQ_ECHO))).toBe(false);
  });
});
