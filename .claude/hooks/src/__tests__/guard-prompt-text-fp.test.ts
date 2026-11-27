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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Deps } from '../decision-gate.js';
import { FINDING_SHAPES, REAL_SHAPES, TEXT_CONTEXTS, WORDS, tools, type Tool } from './guard-prompt-text-fp-corpus.js';
import { decideParsed } from './helpers/parse-first.js';

// C2b: the hand reader is gone, so each row runs the command with the real parse, as the hook does (a PowerShell parse is about 330 ms alone).
vi.setConfig({ testTimeout: 60000 });

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
const action = async (tool: Tool, command: string): Promise<string> => (await decideParsed({ tool_name: tool, tool_input: { command }, cwd: '/repo' }, deps())).action;

/**
 * C2b migration (Dave's decision 11-26, Policy P). Each row expects the verdict that MAIN gives the same text WITH a parse (the production hook parses first), as listed by a
 * probe of every row on the RED head, with these named differences. The old no-parse assertions asserted the hand reader alone.
 *   MAIN_DENIES_TEXT: a node lane.mjs call whose quoted text names a guarded call is denied by C1 (script-runner), on main too.
 *   Quoted text inside claude -p, gh pr comment --body, curl -d, ntn and after cd stays allowed as data (Dave's tap 11-26): those programs are accounted calls, and the parsed rules judge the real command around the text.
 *   DAVE_ALLOWED: the 10 rows Dave allowed, by exact text: class A (a script WRITTEN as data and not run, 4 rows) and class D (the parse proves the text is data in that tool, 6 rows).
 *   PARSER_RIGHT_EXTRA: 2 more rows the final data list allows (Write-Output is on it): a smart quote on the Bash tool opens one string, so the merge sits inside it. Not among
 *     Dave's 10 by the seat's count; reported to the seat with the head.
 * Every other row of REAL, FINDINGS, SPLIT and WRITER expects deny, as on main.
 */
const MAIN_DENIES_TEXT = new Set(['lane add title', 'lane shim note', 'lane say', 'after echo ;', 'newline']);
const W_API = 'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f title=x';
const W_MERGE = 'gh pr merge 5 --squash';
// DENY FLOOR (card coord-guard-deny-floor, Dave tap 11-27 "Floor wins, no exception"): main denies all 12 rows the C2b parser allowed, so both lists are empty and every row expects deny.
const DAVE_ALLOWED = new Set<string>();
const PARSER_RIGHT_EXTRA = new Set<string>();
const verdictFor = (tool: Tool, name: string, text: string): 'allow' | 'deny' => (DAVE_ALLOWED.has(`${tool}|${name}|${text}`) || PARSER_RIGHT_EXTRA.has(`${tool}|${name}|${text}`) ? 'allow' : 'deny');

describe('TEXT: words of a create, land or merge inside quoted text are allowed, except where main denies them with a parse', () => {
  for (const tool of tools) {
    for (const w of WORDS) {
      for (const [name, build] of TEXT_CONTEXTS) {
        const command = build(w.text, '"');
        it(`${tool} ${w.family} | ${name} | ${w.text}`, async () => {
          expect(await action(tool, command), command).toBe(MAIN_DENIES_TEXT.has(name) ? 'deny' : 'allow');
        });
      }
    }
  }
  it('a single-quoted title of a node lane.mjs call: denied as on main (C1 script-runner)', async () => {
    for (const tool of tools) expect(await action(tool, "node lane.mjs add x --title 'gh pr create for fix'")).toBe('deny');
  });
});

describe('REAL: every real create, land and merge keeps its gate', () => {
  for (const tool of tools) {
    for (const w of WORDS) {
      for (const [name, build] of REAL_SHAPES) {
        const command = build(w.text);
        it(`${tool} ${w.family} | ${name} | ${w.text}`, async () => {
          expect(await action(tool, command), command).toBe(verdictFor(tool, name, w.text));
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
        it(`${tool} ${w.family} | ${name} | ${w.text}`, async () => { expect(await action(tool, command), command).toBe(verdictFor(tool, name, w.text)); });
      }
    }
  }
});

describe('SPLIT: a command spliced with quotes is still the command', () => {
  for (const tool of tools) {
    for (const command of ['gh "pr" create --title x', 'gh pr cre""ate --title x', "gh pr 'create' --title x", 'g""h pr merge 5', 'gh pr "merge" 5', 'echo "x"; gh pr "create"', 'echo "gh pr create for fix"; gh pr cre""ate --title x']) {
      it(`${tool} | ${command}`, async () => { expect(await action(tool, command), command).toBe('deny'); });
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
      it(`${tool} | ${command}`, async () => { expect(await action(tool, command), command).toBe('deny'); });
    }
  }
});
