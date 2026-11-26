/**
 * decision-gate paid tripwire (card coord-paid-guard, PR 655). One deny rule: shell text that holds BOTH `@coderabbitai` and
 * `use[-_\s]*credits` (case-insensitive) in the RAW text is denied for every command tool. The rows are data (decision-gate-paid-tripwire-rows.ts).
 *
 * Failure modes, one group each:
 *   F1  a paid request spelled in a gh comment is not denied (miss)
 *   F2  the rule reads blanked text, so a heredoc or here-string body escapes
 *   F3  the rule fires on text that holds only one of the two words (self-block of the 30+ files and commit messages that name the flag)
 *   F4  the rule skips a command tool (PowerShell, Desktop Commander)
 *   F5  the tripwire grows into an allowlist: the by-design rows must stay allowed
 *   F6  the deny is hard and ignores decisions.enforce (it follows the flag, as the land-script text rule does)
 *   F7  a git throw after the tripwire loses its deny (it is pushed before the shapes)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMAND_TOOLS, decide, handle, type Deps } from '../decision-gate.js';
import { PAID_ROWS, PAID_TRIPWIRE_SENTENCE, TEST_SESSION_ID, TOOL_NAMES, payloadOf } from './decision-gate-paid-tripwire-rows.js';
import { decideParsed, handleParsed } from './helpers/parse-first.js';

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const DC = 'mcp__plugin_desktop-commander_desktop-commander__';
let dir = '';
let storeFile = '';
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-gate-paid-'));
  storeFile = join(dir, 'decisions.json');
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = storeFile;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

/** A fake git and config for a CCv3 checkout at /repo. `enforce` is the literal decisions.enforce value. */
function deps(enforce = true, gitThrows = false): Deps {
  const config = JSON.stringify({ decisions: { enforce, enforcePush: true } });
  return {
    env: { ...process.env, CCV3_DECISIONS_FILE: storeFile },
    home: '/home/nobody',
    readFile: (p) => (p.replace(/\\/g, '/') === '/repo/review-router.config.json' ? config : null),
    git: (_cwd, args) => {
      if (gitThrows) throw new Error('git is gone');
      const a = args.join(' ');
      if (a === 'remote -v') return { status: 0, stdout: `fork\thttps://github.com/${REPO}.git (push)\n` };
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
      if (a === 'branch --show-current') return { status: 0, stdout: 'feat/x\n' };
      return { status: 1, stdout: '' };
    },
  };
}

/** True when the decision is the tripwire deny (a deny or a warn that carries the tripwire sentence). */
function tripped(d: ReturnType<typeof decide>): boolean {
  if (d.action === 'deny') return d.reason.includes(PAID_TRIPWIRE_SENTENCE);
  return typeof d.warn === 'string' && d.warn.includes(PAID_TRIPWIRE_SENTENCE);
}

const rowsOf = (kind: 'deny' | 'allow') => PAID_ROWS.filter((r) => r.expect === kind);

describe('F1, F2: a row that holds both words is denied (both tools, raw text)', () => {
  for (const tool of TOOL_NAMES) {
    for (const row of rowsOf('deny')) {
      it(`${tool}: ${row.command.replace(/\n/g, '\\n')}`, async () => {
        const d = await decideParsed(payloadOf(row, tool, '/repo'), deps());
        expect(d.action).toBe('deny');
        expect(tripped(d)).toBe(true);
      });
    }
  }
  it('names decision-gate and the cr-paid post command in the deny text', async () => {
    const d = await decideParsed(payloadOf(rowsOf('deny')[0], 'Bash', '/repo'), deps());
    expect(d.action === 'deny' && d.reason).toBe(`BLOCKED (decision-gate): ${PAID_TRIPWIRE_SENTENCE}`);
  });
});

describe('F3, F5: the other rows are not tripped (one word alone, apart, or the by-design rows)', () => {
  for (const tool of TOOL_NAMES) {
    for (const row of rowsOf('allow')) {
      it(`${tool}: ${row.command.replace(/\n/g, '\\n')} (${row.note})`, async () => {
        expect(tripped(await decideParsed(payloadOf(row, tool, '/repo'), deps()))).toBe(false);
      });
    }
  }
});

describe('F4: every command tool is covered', () => {
  const paid = 'gh pr comment 12 --body "@coderabbitai review --use-credits"';
  it('lists the tools this test calls, so a new command tool needs a row', () => {
    expect([...COMMAND_TOOLS].sort()).toEqual(['Bash', 'PowerShell', `${DC}interact_with_process`, `${DC}start_process`].sort());
  });
  it('Desktop Commander start_process', async () => {
    const d = await decideParsed({ tool_name: `${DC}start_process`, tool_input: { command: paid, shell: 'cmd' }, cwd: '/repo', session_id: TEST_SESSION_ID }, deps());
    expect(tripped(d)).toBe(true);
  });
  it('Desktop Commander interact_with_process', async () => {
    const d = await decideParsed({ tool_name: `${DC}interact_with_process`, tool_input: { pid: 1, input: paid }, cwd: '/repo', session_id: TEST_SESSION_ID }, deps());
    expect(tripped(d)).toBe(true);
  });
  it('a non-command tool is not read', async () => {
    expect(tripped(await decideParsed({ tool_name: 'Read', tool_input: { file_path: paid }, cwd: '/repo', session_id: TEST_SESSION_ID }, deps()))).toBe(false);
  });
});

describe('F6: the deny follows decisions.enforce, as the land-script text rule does', () => {
  it('enforce true: deny', async () => {
    expect((await decideParsed(payloadOf(rowsOf('deny')[0], 'Bash', '/repo'), deps(true))).action).toBe('deny');
  });
  it('enforce false: allow with a warning that carries the sentence', async () => {
    const d = await decideParsed(payloadOf(rowsOf('deny')[0], 'Bash', '/repo'), deps(false));
    expect(d.action).toBe('allow');
    expect(tripped(d)).toBe(true);
  });
});

describe('F7: a git throw does not lose the tripwire deny', () => {
  it('handle() still prints the deny when a push in the same text makes git throw', async () => {
    // The push shape reads git; deps(true, true) throws there. The tripwire is pushed before shapesOf, so handle() still finds it.
    const row = { ...rowsOf('deny')[0], command: `git push fork feat/x && ${rowsOf('deny')[0].command}` };
    const raw = JSON.stringify(payloadOf(row, 'Bash', '/repo'));
    const out = JSON.parse(await handleParsed(raw, deps(true, true))) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain(PAID_TRIPWIRE_SENTENCE);
  });
});
