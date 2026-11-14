/**
 * decision-gate: push blocks that hold without decisions.enforcePush (card prflow-push-blocks; design note
 * .claudedocs/e2e-prflow-push-blocks/01-design-note-rev2-DRAFT.md, sections 2b and 3b). Own file: decision-gate.test.ts is not part of this change.
 * Every row runs in the shipped state: enforcePush is ABSENT (a deny of scope push only warns today).
 *
 *   - a CCv3 push to origin, or by a subagent, only warns (no `hard` deny)                    -> B1, B2
 *   - a force push to main, or through an early return (--git-dir, popd, GIT_DIR), only warns   -> B3, B4
 *   - the hard deny catches a force push to an OWN fork feature branch (the guard asks there)    -> B5 (control, green today)
 *   - the hard deny catches a plain push of an own branch, or git-safe commit-and-push           -> B6 (control, green today)
 *   - a --mirr prefix or a --repo parcadei URL passes with a ship tap                            -> B7
 *   - a re/ push carries a holdout id in an added line or a commit message                       -> H1, H2
 *   - the scan reads main's own lines (two dots) or a bare small number                          -> H3, H4
 *   - a missing id list, a git failure or a huge diff lets the push through (fail open)           -> H5, H6, H7
 *   - the deny text echoes an id, a title or a file path                                         -> H8
 *   - a non-re branch with no answer-key path makes a scan git call                              -> H9
 *   - an answer-key path in the diff does not trigger the scan on a feature branch               -> H10
 * Holdout ids here are synthetic and injected through Deps (holdoutIds). No real id is in this file.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionRecord, offerWrite, type Step } from '../shared/decisions-store.js';
import { decide, type Deps } from '../decision-gate.js';

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const TREE = 't'.repeat(40);
const SYNTH = '9990001'; // a synthetic holdout PR number
const SECRET_FILE = 'src/holdout-probe-file.ts';
let dir = '';
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-gate-pb-'));
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = join(dir, 'decisions.json');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

interface GitCall { cwd: string; args: string[] }
interface World {
  branch?: string;
  calls?: GitCall[];
  /** The added lines of `git diff --unified=0 --no-color fork/main...<sha>`. */
  diff?: string;
  /** The messages of `git log --format=%B fork/main..<sha>`. */
  messages?: string;
  /** The files of `git diff --name-only fork/main...<sha>`. */
  files?: string[];
  /** The scan git calls fail. */
  scanFails?: boolean;
  /** The id list: absent = a list with SYNTH and 42; 'throw' = unreadable. */
  ids?: string[] | 'throw';
  /** Which paths the answer-key guard list names (the real list is imported in the source; here a fake). */
  answerKey?: (path: string) => boolean;
}

/** The shipped state: enforce true, enforcePush absent. A fake git and config for a checkout at /repo. */
function deps(w: World = {}): Deps {
  const config = JSON.stringify({ decisions: { enforce: true } });
  const branch = w.branch ?? 'feat/x';
  const base = {
    env: { ...process.env, CCV3_DECISIONS_FILE: join(dir, 'decisions.json') },
    home: '/home/nobody',
    readFile: (p: string) => (p.replace(/\\/g, '/') === '/repo/review-router.config.json' ? config : null),
    git: (cwd: string, args: string[]) => {
      w.calls?.push({ cwd, args });
      const a = args.join(' ');
      if (a === 'remote -v') return { status: 0, stdout: `fork\thttps://github.com/${REPO}.git (push)\n` };
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
      if (a === 'branch --show-current') return { status: 0, stdout: `${branch}\n` };
      if (a === 'rev-parse --abbrev-ref @{push}') return { status: 128, stdout: '' };
      if (/^rev-parse (.+)\^\{commit\}$/.test(a)) return { status: 0, stdout: `${HEAD}\n` };
      if (/^rev-parse (.+)\^\{tree\}$/.test(a)) return { status: 0, stdout: `${TREE}\n` };
      if (a === 'write-tree') return { status: 128, stdout: '' };
      if (args[0] === 'diff' && args.includes('--name-only')) return w.scanFails ? { status: 128, stdout: '' } : { status: 0, stdout: `${(w.files ?? ['src/app.ts']).join('\0')}\0` };
      if (args[0] === 'diff' && args.includes('--unified=0')) return w.scanFails ? { status: 128, stdout: '' } : { status: 0, stdout: w.diff ?? '' };
      if (args[0] === 'log' && args.some((x) => x.startsWith('--format'))) return w.scanFails ? { status: 128, stdout: '' } : { status: 0, stdout: w.messages ?? '' };
      return { status: 1, stdout: '' };
    },
    // The injected seams of this change: the id list (the one existing source, read in the hook process) and the answer-key list.
    holdoutIds: () => {
      if (w.ids === 'throw') throw new Error('list unreadable');
      return w.ids ?? [SYNTH, '42'];
    },
    answerKeyHits: (paths: string[]) => paths.filter(w.answerKey ?? (() => false)),
  };
  return base as unknown as Deps;
}

function tap(step: Step, key: string, head: string, label: string, tree?: string): void {
  expect(offerWrite({ step, key, head, tree, spec: { header: 'T', question: 'Q?', options: [{ label }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step, key, head, label })).toEqual({ ok: true });
}
const shipTap = (branch = 'feat/x') => tap('ship', `${REPO}@${branch}`, HEAD, 'Commit and push (Recommended)', TREE);

const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo', ...extra });
const pwsh = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: '/repo', ...extra });
const verdict = (input: object, w?: World) => decide(input, deps(w));
const denied = (input: object, w?: World) => verdict(input, w).action === 'deny';
const reasonOf = (input: object, w?: World): string => { const d = verdict(input, w); return d.action === 'deny' ? d.reason : ''; };

describe('PB: hard denies without enforcePush', () => {
  it('B1: a CCv3 push to origin or to a parcadei URL denies', () => {
    // Breaks when: push-origin has no `hard` mark (scope push only warns while enforcePush is absent).
    expect(denied(bash('git push origin feat/x'))).toBe(true);
    expect(denied(bash('git push https://github.com/parcadei/Continuous-Claude-v3.git feat/x'))).toBe(true);
  });

  it('B2: a subagent push to the fork denies, the main branch included', () => {
    // Breaks when: the subagent deny has no `hard` mark.
    shipTap();
    expect(denied(bash('git push fork feat/x', { agent_id: 'sub-1' }))).toBe(true);
    expect(denied(bash('git push fork main', { agent_id: 'sub-1' }))).toBe(true);
  });

  it('B3: a force push to main denies, in every spelling', () => {
    // Breaks when: push-unsafe for the main branch has no `hard` mark.
    for (const c of ['git push --force fork main', 'git push -f fork main', 'git push fork +main', 'git push --force-with-lease fork main', 'git push fork :main']) {
      expect(denied(bash(c)), c).toBe(true);
    }
  });

  it('B4: a force push through an early return (--git-dir, popd, GIT_DIR, a cd alias) denies', () => {
    // Breaks when: the intent is judged after the folder: each of these returns first with scope push and only warns.
    for (const c of ['git --git-dir=.git push --force fork feat/x', 'popd; git push -f fork feat/x', 'GIT_DIR=.git git push -f fork feat/x', 'alias go=cd; go /x; git push --force fork feat/x']) {
      expect(denied(bash(c)), c).toBe(true);
    }
    // The same early returns hold origin and subagent pushes too.
    expect(denied(bash('git --git-dir=.git push origin feat/x'))).toBe(true);
    expect(denied(bash('popd; git push fork feat/x', { agent_id: 'sub-1' }))).toBe(true);
  });

  it('B5: a force push to an OWN fork feature branch is not a hard deny (the destructive guard asks Dave there)', () => {
    // Breaks when: the hard deny widens to every force push (a new policy: seat ruling 14:0x).
    expect(verdict(bash('git push --force fork feat/x')).action).toBe('allow');
    expect(verdict(bash('git push -f fork feat/x')).action).toBe('allow');
  });

  it('B6: the two legitimate flows pass with no question added: a plain push of an own branch, and git-safe commit-and-push', () => {
    // Breaks when: a hard deny catches the ordinary flow (the control of every other row).
    shipTap();
    expect(verdict(bash('git push fork feat/x')).action).toBe('allow');
    expect(verdict(pwsh('pwsh -File scripts/git-safe.ps1 push fork feat/x')).action).toBe('allow');
    expect(verdict(pwsh('pwsh -File scripts/git-safe.ps1 commit -F m.txt && pwsh -File scripts/git-safe.ps1 push fork feat/x')).action).toBe('allow');
    expect(verdict(bash('git commit -F m.txt && git push fork feat/x')).action).toBe('allow');
  });

  it('B7: a --mirr prefix, or a --repo option that names a parcadei URL, denies', () => {
    // Breaks when: the CCv3 path reads only the full option names (FORCE_LONG) and not unsafeOpt / repoOpt.
    shipTap();
    expect(denied(bash('git push --mirr fork'))).toBe(true);
    expect(denied(bash('git push --repo https://github.com/parcadei/x.git feat/x'))).toBe(true);
  });
});

describe('HS: the holdout scan on a push of a re/ branch', () => {
  const RE = { branch: 're/re-x' };
  const PUSH = 'git push fork re/re-x';
  const tapRe = () => shipTap('re/re-x');

  it('H1: an added line with a holdout id next to a context word denies', () => {
    // Breaks when: the push is not scanned (a re/ push needs only the ship tap today).
    tapRe();
    for (const line of [`+// see #${SYNTH}`, `+// PR ${SYNTH}`, `+// https://github.com/x/y/pull/${SYNTH}`]) {
      expect(denied(bash(PUSH), { ...RE, diff: `+++ b/src/a.ts\n${line}\n` }), line).toBe(true);
    }
  });

  it('H2: an id only in a commit message of the range denies', () => {
    // Breaks when: the messages of the range are not scanned.
    tapRe();
    expect(denied(bash(PUSH), { ...RE, diff: '+++ b/src/a.ts\n+const a = 1;\n', messages: `fix: look at PR ${SYNTH}\n` })).toBe(true);
  });

  it('H3: an id only on main (a removed or context line, or a merge of main) does not deny', () => {
    // Breaks when: the diff uses two dots or HEAD (main's own lines would show up), or the scan reads "-" lines.
    tapRe();
    const w = { ...RE, diff: `+++ b/src/a.ts\n-// PR ${SYNTH}\n+const a = 1;\n`, messages: 'Merge remote-tracking branch fork/main\n' };
    expect(verdict(bash(PUSH), w).action).toBe('allow');
  });

  it('H4: a bare small number does not match (only an id next to a context word or in a key form)', () => {
    // Breaks when: the matcher takes any digit run that is in the list.
    tapRe();
    expect(verdict(bash(PUSH), { ...RE, diff: '+++ b/src/a.ts\n+const answer = 42;\n+const t = 1042;\n' }).action).toBe('allow');
    expect(denied(bash(PUSH), { ...RE, diff: '+++ b/src/a.ts\n+// PR 42\n' })).toBe(true);
  });

  it('H5: an unreadable or missing id list on a re/ push denies (fail closed)', () => {
    // Breaks when: a loader failure counts as "no ids".
    tapRe();
    expect(denied(bash(PUSH), { ...RE, ids: 'throw', diff: '+++ b/src/a.ts\n+const a = 1;\n' })).toBe(true);
    expect(denied(bash(PUSH), { ...RE, ids: [], diff: '+++ b/src/a.ts\n+const a = 1;\n' })).toBe(true);
  });

  it('H6: a git failure while scanning denies', () => {
    // Breaks when: a failed diff or log read is treated as an empty diff.
    tapRe();
    expect(denied(bash(PUSH), { ...RE, scanFails: true })).toBe(true);
  });

  it('H7: a diff over the size bound denies with the plain way to push in parts, no clock involved', () => {
    // Breaks when: the git work is unbounded (a huge diff is read whole) or bounded by a timeout instead of by size.
    tapRe();
    const huge = `+++ b/src/a.ts\n${'+x'.repeat(2_000_000)}\n`;
    const r = reasonOf(bash(PUSH), { ...RE, diff: huge });
    expect(r).not.toBe('');
    expect(r).toMatch(/parts/);
  });

  it('H8: the deny text holds a count only: no id, no file path, no title', () => {
    // Breaks when: the reason echoes the match, the file, or the line (the list of holdout ids must not leak by probing).
    tapRe();
    const r = reasonOf(bash(PUSH), { ...RE, diff: `+++ b/${SECRET_FILE}\n+// PR ${SYNTH} secret-title\n` });
    expect(r).not.toBe('');
    expect(r).not.toContain(SYNTH);
    expect(r).not.toContain('holdout-probe');
    expect(r).not.toContain('secret-title');
    expect(r).toMatch(/\b1\b/);
  });

  it('H9: a feature branch with no answer-key path makes no scan call', () => {
    // Breaks when: the trigger widens to every push (a git diff and log call on each ordinary push).
    shipTap();
    const calls: GitCall[] = [];
    expect(verdict(bash('git push fork feat/x'), { calls, files: ['src/app.ts'] }).action).toBe('allow');
    expect(calls.some((c) => c.args[0] === 'log' || c.args.includes('--unified=0'))).toBe(false);
  });

  it('H10: a feature branch whose diff touches an answer-key path is scanned too', () => {
    // Breaks when: the only trigger is the re/ branch name.
    shipTap();
    const w = { files: ['gold/a.json'], answerKey: (p: string) => p.startsWith('gold/'), diff: `+++ b/gold/a.json\n+// PR ${SYNTH}\n` };
    expect(denied(bash('git push fork feat/x'), w)).toBe(true);
    expect(verdict(bash('git push fork feat/x'), { ...w, diff: '+++ b/gold/a.json\n+{}\n' }).action).toBe('allow');
  });

  it('H11: a re/ push with no id passes with its ship tap only (no question added)', () => {
    // Breaks when: the scan denies a clean push.
    tapRe();
    expect(verdict(bash(PUSH), { ...RE, diff: '+++ b/src/a.ts\n+const a = 1;\n', messages: 'feat: a\n' }).action).toBe('allow');
  });
});
