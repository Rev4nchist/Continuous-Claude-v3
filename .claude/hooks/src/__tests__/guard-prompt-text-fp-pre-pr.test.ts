/**
 * pre-pr-gate: words of a PR create inside quoted text are text, not a create (lane guard-prompt-text-fp).
 * The cases and the ways to fail are the ones in guard-prompt-text-fp.test.ts, for the create family only
 * (pre-pr-gate gates a create and the checkpoint shapes, not land or merge text).
 *   TEXT   a harmless command that only names a create is denied for a missing stamp
 *   REAL   a real create loses its stamp rule: bare, wrapped, in a substitution, after a quoted string, piped to a shell
 *   SPLIT  gh "pr" create and gh pr cre""ate stop counting as a create
 */
import { describe, expect, it } from 'vitest';
import { decide, type Deps } from '../pre-pr-gate.js';
import { FINDING_SHAPES, REAL_SHAPES, TEXT_CONTEXTS, WORDS, tools, type Tool } from './guard-prompt-text-fp-corpus.js';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const ROOT = '/work/ccv3';
const CCV3_REMOTES = 'fork\thttps://github.com/Rev4nchist/Continuous-Claude-v3.git (fetch)\nfork\thttps://github.com/Rev4nchist/Continuous-Claude-v3.git (push)\n';

/** A CCv3 checkout with NO stamp: a real create is denied. */
function deps(): Deps {
  return {
    git: (cwd, args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --show-toplevel') return { status: 0, stdout: `${cwd}\n` };
      if (key === 'remote -v') return { status: 0, stdout: CCV3_REMOTES };
      if (key === 'rev-parse HEAD') return { status: 0, stdout: `${'a'.repeat(40)}\n` };
      if (key === 'branch --show-current') return { status: 0, stdout: 'feat/x\n' };
      if (args[0] === 'rev-parse' && args[1]?.endsWith('^{commit}')) return { status: 0, stdout: `${'a'.repeat(40)}\n` };
      return { status: 1, stdout: '' };
    },
    readFile: () => null,
    now: () => NOW,
    env: {},
  };
}
const action = (tool: Tool, command: string): string => decide({ tool_name: tool, tool_input: { command }, cwd: ROOT }, deps()).action;
const CREATES = WORDS.filter((w) => w.family === 'create');

describe('TEXT: words of a create inside quoted text of a harmless command are allowed without a stamp', () => {
  for (const tool of tools) {
    for (const w of CREATES) {
      for (const [name, build] of TEXT_CONTEXTS) {
        const command = build(w.text, '"');
        it(`${tool} | ${name} | ${w.text}`, () => { expect(action(tool, command), command).toBe('allow'); });
      }
    }
  }
});

describe('REAL: a real create keeps the stamp rule', () => {
  for (const tool of tools) {
    for (const w of CREATES) {
      for (const [name, build] of REAL_SHAPES) {
        const command = build(w.text);
        it(`${tool} | ${name} | ${w.text}`, () => { expect(action(tool, command), command).toBe('deny'); });
      }
    }
  }
});

describe('FINDINGS: a quote the regex misreads, or a harmless-looking segment, never hides a real create', () => {
  for (const tool of tools) {
    for (const w of CREATES) {
      for (const [name, build] of FINDING_SHAPES) {
        const command = build(w.text);
        it(`${tool} | ${name} | ${w.text}`, () => { expect(action(tool, command), command).toBe('deny'); });
      }
    }
  }
});

describe('SPLIT: a command spliced with quotes is still a create', () => {
  for (const tool of tools) {
    for (const command of ['gh "pr" create --title x', 'gh pr cre""ate --title x', "gh pr 'create' --title x", 'echo "x"; gh pr "create"', 'echo "gh pr create for fix"; gh pr cre""ate --title x']) {
      it(`${tool} | ${command}`, () => { expect(action(tool, command), command).toBe('deny'); });
    }
  }
});
