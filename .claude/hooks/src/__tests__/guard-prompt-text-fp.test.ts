/**
 * decision-gate: words of a PR create, land or merge inside quoted text are text, not a command (lane guard-prompt-text-fp).
 *
 * How the gate can fail, and the test that catches it (written before the fix):
 *   - it denies a quoted title, message, prompt or body that only NAMES a create, land or merge  -> TEXT (every context x word x shell)
 *   - the fix lets a real command through, so a gate is lost:
 *       bare, wrapped (bash -c, sh -c, pwsh -c, eval, iex, ssh), in $(...) or a backtick inside the same quotes,
 *       after a quoted string with ; && || | or a newline, fed to a shell by a pipe, or written to a script   -> REAL
 *   - the quote-split reading is lost (gh "pr" create, gh pr cre""ate)                                     -> SPLIT
 *   - a file writer is read as inert (Set-Content can write a script that runs later)                      -> WRITER
 * pre-pr-gate has the same cases in guard-prompt-text-fp-pre-pr.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, type Deps } from '../decision-gate.js';
import { FINDING_SHAPES, REAL_SHAPES, TEXT_CONTEXTS, WORDS, tools, type Tool } from './guard-prompt-text-fp-corpus.js';

let dir = '';
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guard-prompt-text-fp-'));
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = join(dir, 'decisions.json');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

/** A fake checkout at /repo that is CCv3, with decisions.enforce true and no decision on file. */
function deps(): Deps {
  const config = JSON.stringify({ decisions: { enforce: true, enforcePush: true } });
  return {
    env: { ...process.env, CCV3_DECISIONS_FILE: join(dir, 'decisions.json') },
    home: '/home/nobody',
    readFile: (p) => (p.replace(/\\/g, '/') === '/repo/review-router.config.json' ? config : null),
    git: (_cwd, args) => {
      const a = args.join(' ');
      if (a === 'remote -v') return { status: 0, stdout: 'fork\thttps://github.com/Rev4nchist/Continuous-Claude-v3.git (push)\n' };
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
      if (a === 'branch --show-current') return { status: 0, stdout: 'feat/x\n' };
      if (/^rev-parse .+\^\{commit\}$/.test(a)) return { status: 0, stdout: `${'a'.repeat(40)}\n` };
      if (/^rev-parse .+\^\{tree\}$/.test(a)) return { status: 0, stdout: `${'t'.repeat(40)}\n` };
      return { status: 1, stdout: '' };
    },
  };
}
const action = (tool: Tool, command: string): string => decide({ tool_name: tool, tool_input: { command }, cwd: '/repo' }, deps()).action;

describe('TEXT: words of a create, land or merge inside quoted text of a harmless command are allowed', () => {
  for (const tool of tools) {
    for (const w of WORDS) {
      for (const [name, build] of TEXT_CONTEXTS) {
        const command = build(w.text, '"');
        it(`${tool} ${w.family} | ${name} | ${w.text}`, () => {
          expect(action(tool, command), command).toBe('allow');
        });
      }
    }
  }
  it('a single-quoted title is text too', () => {
    for (const tool of tools) expect(action(tool, "node lane.mjs add x --title 'gh pr create for fix'")).toBe('allow');
  });
});

describe('REAL: every real create, land and merge keeps its gate', () => {
  for (const tool of tools) {
    for (const w of WORDS) {
      for (const [name, build] of REAL_SHAPES) {
        const command = build(w.text);
        it(`${tool} ${w.family} | ${name} | ${w.text}`, () => {
          expect(action(tool, command), command).toBe('deny');
        });
      }
    }
  }
});

describe('FINDINGS: a quote the regex misreads, or a harmless-looking segment, never hides a real command', () => {
  for (const tool of tools) {
    for (const w of WORDS) {
      for (const [name, build] of FINDING_SHAPES) {
        const command = build(w.text);
        it(`${tool} ${w.family} | ${name} | ${w.text}`, () => { expect(action(tool, command), command).toBe('deny'); });
      }
    }
  }
});

describe('SPLIT: a command spliced with quotes is still the command', () => {
  for (const tool of tools) {
    for (const command of ['gh "pr" create --title x', 'gh pr cre""ate --title x', "gh pr 'create' --title x", 'g""h pr merge 5', 'gh pr "merge" 5', 'echo "x"; gh pr "create"', 'echo "gh pr create for fix"; gh pr cre""ate --title x']) {
      it(`${tool} | ${command}`, () => { expect(action(tool, command), command).toBe('deny'); });
    }
  }
});

describe('WRITER: a file writer and an unknown program keep the gate (the text may become a script)', () => {
  for (const tool of tools) {
    for (const command of [
      'Set-Content -Path run.ps1 -Value "gh pr create --title x"',
      'Add-Content run.ps1 "gh pr merge 5"',
      'tee run.sh "gh pr create"',
      'xargs "gh pr create"',
      'Start-Process "gh pr create"',
      'wsl "gh pr create"',
      'cmd /c "gh pr merge 5"',
      '& "gh pr create"',
      'node -e "require(\'child_process\').execSync(\'gh pr create\')"',
      'echo "x" "$(gh pr create)"',
    ]) {
      it(`${tool} | ${command}`, () => { expect(action(tool, command), command).toBe('deny'); });
    }
  }
});
