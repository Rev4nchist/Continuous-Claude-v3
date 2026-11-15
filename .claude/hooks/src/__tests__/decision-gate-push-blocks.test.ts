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
  /** The diff read THROWS (makeGit throws on a timeout or a spawn error). */
  throwOnScan?: boolean;
  /** The id list: absent = a list with SYNTH and 42; 'throw' = unreadable. */
  ids?: string[] | 'throw';
  /** Which paths the answer-key guard list names (the real list is imported in the source; here a fake). */
  answerKey?: (path: string) => boolean;
  /** Item 4 path reads of a chained push: `git diff --cached --name-only`, `git diff HEAD --name-only`, `git ls-files --others --exclude-standard`. */
  cachedFiles?: string[];
  headFiles?: string[];
  untracked?: string[];
  /** The chained-path reads fail (status 128). */
  chainFails?: boolean;
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
      const list = (names?: string[]) => (w.chainFails ? { status: 128, stdout: '' } : { status: 0, stdout: `${(names ?? []).join('\0')}${names?.length ? '\0' : ''}` });
      if (args[0] === 'diff' && args.includes('--name-only') && args.includes('--cached')) return list(w.cachedFiles);
      if (args[0] === 'diff' && args.includes('--name-only') && args[args.length - 1] === 'HEAD') return list(w.headFiles);
      if (args[0] === 'ls-files' && args.includes('--others')) return list(w.untracked);
      if (args[0] === 'diff' && args.includes('--name-only')) return w.scanFails ? { status: 128, stdout: '' } : { status: 0, stdout: `${(w.files ?? ['src/app.ts']).join('\0')}\0` };
      if (w.throwOnScan && args[0] === 'diff' && args.includes('--unified=0')) throw new Error('git exploded');
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

describe('PR: refspecs and wide options (seat GO 16:5x: refs/eval seed refs must never reach a remote)', () => {
  it('B8: a refspec that names a ref outside refs/heads and refs/tags, or holds a wildcard, denies, with a tap on record', () => {
    // Breaks when: such a refspec is read as a branch name and goes to the ship tap (a tap on feat/x then lets it pass).
    shipTap();
    for (const c of ['git push fork refs/eval/*:refs/eval/*', 'git push fork refs/*:refs/*', 'git push fork refs/eval/seed/x', 'git push fork refs/eval/seed/x:refs/eval/seed/x', 'git push fork HEAD:refs/eval/seed/x', 'git push fork feat/*:feat/*', 'git push fork +refs/eval/x:refs/eval/x']) {
      const d = verdict(bash(c));
      expect(d.action, c).toBe('deny');
    }
  });

  it('B9: full --mirror and --all are hard denies (a prefix too); --tags and --delete of an own branch stay soft', () => {
    // Breaks when: the full spellings are only the soft push-unsafe (the guard asks) while the prefixed ones are hard.
    shipTap();
    for (const c of ['git push --mirror fork', 'git push --all fork', 'git push --mir fork', 'git push --al fork', 'git push --mirror fork feat/x']) expect(denied(bash(c)), c).toBe(true);
    for (const c of ['git push --tags fork', 'git push --delete fork feat/x']) expect(verdict(bash(c)).action, c).toBe('allow');
  });

  it('B11: a push with TWO refspecs denies when only the SECOND is bad (every refspec is judged)', () => {
    // Breaks when: the shape keeps only the first refspec (a bad one hides behind a good one).
    shipTap();
    for (const c of ['git push fork feat/x refs/eval/seed/y', 'git push fork feat/x refs/*:refs/*', 'git push fork feat/x refs/eval/*:refs/eval/*', 'git push fork refs/heads/feat/x HEAD:refs/eval/seed/y']) expect(denied(bash(c)), c).toBe(true);
    // The control: two good refspecs of the tapped branch pass.
    expect(verdict(bash('git push fork feat/x HEAD:feat/x')).action).toBe('allow');
  });

  it('B10: a plain branch name and refs/heads/<own branch> still pass with their tap (no question added)', () => {
    // Breaks when: the refspec rule catches the ordinary refspecs.
    shipTap();
    for (const c of ['git push fork feat/x', 'git push fork refs/heads/feat/x', 'git push fork HEAD:refs/heads/feat/x', 'git push fork feat/x:feat/x', 'git push fork HEAD:feat/x']) expect(verdict(bash(c)).action, c).toBe('allow');
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

  it('H12: an id that stands only in the PATH of an added or renamed file denies (seat 2, 14:1x)', () => {
    // Breaks when: only the added lines and the messages are scanned (a file named after a holdout PR passes).
    tapRe();
    expect(denied(bash(PUSH), { ...RE, files: [`src/pr-${SYNTH}-fix.ts`], diff: '+++ b/src/x.ts\n+const a = 1;\n' })).toBe(true);
    expect(denied(bash(PUSH), { ...RE, files: ['src/old.ts', `docs/notes-for-#${SYNTH}.md`], diff: '+++ b/src/x.ts\n+const a = 1;\n' })).toBe(true);
    expect(verdict(bash(PUSH), { ...RE, files: ['src/pr-fix.ts'], diff: '+++ b/src/x.ts\n+const a = 1;\n' }).action).toBe('allow');
  });

  it('H13: a FORCE push of a re/ branch is scanned too (the guard\'s yes must not send it out unscanned)', () => {
    // Breaks when: the force return comes before the scan (seat read 16:0x).
    tapRe();
    for (const c of ['git push --force fork re/re-x', 'git push -f fork re/re-x', 'git push fork +re/re-x']) {
      const d = verdict(bash(c), { ...RE, diff: `+++ b/src/a.ts\n+// PR ${SYNTH}\n` });
      expect(d.action, c).toBe('deny');
      expect(d.action === 'deny' ? d.pattern : '', c).toBe('holdout-id');
    }
    // A clean force push of a re/ branch stays the soft push-unsafe (the guard asks Dave), never a hard deny.
    expect(verdict(bash('git push --force fork re/re-x'), { ...RE, diff: '+++ b/src/a.ts\n+const a = 1;\n' }).action).toBe('allow');
  });

  it('H14: a push of main is scanned too when its diff touches an answer-key path (CLI round 1, item a)', () => {
    // Breaks when: the main ALLOW comes before the scan.
    const w = { branch: 'main', files: ['gold/a.json'], answerKey: (p: string) => p.startsWith('gold/') };
    expect(denied(bash('git push fork main'), { ...w, diff: `+++ b/gold/a.json\n+// PR ${SYNTH}\n` })).toBe(true);
    expect(verdict(bash('git push fork main'), { ...w, diff: '+++ b/gold/a.json\n+{}\n' }).action).toBe('allow');
    // A plain main push with no answer-key path is unchanged.
    expect(verdict(bash('git push fork main'), { branch: 'main', files: ['src/a.ts'] }).action).toBe('allow');
  });

  it('H15: a THROW anywhere in the scan path is a hard deny, never an exception or a warning (item b)', () => {
    // Breaks when: scanHoldout lets a git throw escape (the catch path only warns in scope push).
    tapRe();
    const d = () => verdict(bash(PUSH), { ...RE, throwOnScan: true });
    expect(d).not.toThrow();
    expect(d().action).toBe('deny');
    // A throw while reading the id list is a deny too.
    expect(denied(bash(PUSH), { ...RE, ids: 'throw' })).toBe(true);
  });

  it('H16: a push chained after a commit on a re/ branch is a hard deny: commit first, push in a separate command (item c)', () => {
    // Breaks when: the chained push is scanned at the pre-commit head (the new commit is never read).
    tapRe();
    for (const c of ['git commit -F m.txt && git push fork re/re-x', 'git commit -am x && git push fork re/re-x', 'pwsh -File scripts/git-safe.ps1 commit -F m.txt && pwsh -File scripts/git-safe.ps1 push fork re/re-x']) {
      const d = verdict(c.startsWith('pwsh') ? pwsh(c) : bash(c), RE);
      expect(d.action, c).toBe('deny');
      expect(d.action === 'deny' ? d.reason : '', c).toMatch(/separate command/);
    }
    // The control: the same chain on an own feature branch with no answer-key path is not touched.
    shipTap();
    expect(verdict(bash('git commit -F m.txt && git push fork feat/x')).action).toBe('allow');
  });

  it('H17: an added line whose content starts with ++ is scanned (the +++ header filter dropped it) (item d)', () => {
    // Breaks when: lines that start with +++ are dropped from the added text.
    tapRe();
    expect(denied(bash(PUSH), { ...RE, diff: `+++ b/src/a.ts\n+++ // PR ${SYNTH}\n` })).toBe(true);
    expect(denied(bash(PUSH), { ...RE, diff: `+++ b/src/a.ts\n++++ #${SYNTH}\n` })).toBe(true);
    expect(verdict(bash(PUSH), { ...RE, diff: '+++ b/src/a.ts\n+++ plain text\n' }).action).toBe('allow');
  });

  describe('H18 to H21: a chained or not-alone push of a NON-re branch whose change adds or edits an answer-key path (seat YES, item 4)', () => {
    // The union of paths: fork/main...HEAD + git diff --cached + git diff HEAD + untracked. An answer-key hit = hard deny, commit first.
    const KEY = { answerKey: (p: string) => p.startsWith('gold/') };
    const CHAIN = 'git commit -am x && git push fork feat/x';
    const sepCommand = (c: string, w: World): void => {
      const d = verdict(bash(c), w);
      expect(d.action, c).toBe('deny');
      expect(d.action === 'deny' ? d.reason : '', c).toMatch(/commit first, push in a separate command/i);
    };

    it('H18: a chained commit -am that changes a tracked answer-key file is a hard deny', () => {
      // Breaks when: only fork/main...HEAD is read (the -a change is not on the branch yet).
      shipTap();
      sepCommand(CHAIN, { ...KEY, headFiles: ['gold/a.json'] });
      sepCommand('git commit -a -m x ; git push fork feat/x', { ...KEY, headFiles: ['gold/a.json'] });
    });

    it('H19: a chained git add of a new answer-key file (staged or untracked) is a hard deny', () => {
      // Breaks when: the staged or the untracked names are not read.
      shipTap();
      sepCommand('git add gold/new.json && git commit -m x && git push fork feat/x', { ...KEY, untracked: ['gold/new.json'] });
      sepCommand('git add -A && git commit -m x && git push fork feat/x', { ...KEY, cachedFiles: ['gold/new.json'] });
      // The names already on the branch count too.
      sepCommand(CHAIN, { ...KEY, files: ['gold/on-branch.json'] });
    });

    it('H20: the controls stay allowed: an ordinary commit and push with no answer-key path, and a push with no chain', () => {
      // Breaks when: every chained push of a non-re branch is denied (the seat: no blanket deny).
      shipTap();
      expect(verdict(bash(CHAIN), { ...KEY, headFiles: ['src/a.ts'], cachedFiles: ['src/b.ts'], untracked: ['notes.md'] }).action).toBe('allow');
      expect(verdict(bash('git push fork feat/x'), { ...KEY, headFiles: ['gold/a.json'] }).action).toBe('allow');
    });

    it('H21: a failed git read, or an untracked list over the bound, is a hard deny', () => {
      // Breaks when: a failed read is read as an empty list (fail open).
      shipTap();
      expect(verdict(bash(CHAIN), { ...KEY, chainFails: true }).action).toBe('deny');
      const many = Array.from({ length: 2001 }, (_, i) => `src/f${i}.ts`);
      expect(verdict(bash(CHAIN), { ...KEY, untracked: many }).action).toBe('deny');
    });
  });

  it('H11: a re/ push with no id passes with its ship tap only (no question added)', () => {
    // Breaks when: the scan denies a clean push.
    tapRe();
    expect(verdict(bash(PUSH), { ...RE, diff: '+++ b/src/a.ts\n+const a = 1;\n', messages: 'feat: a\n' }).action).toBe('allow');
  });
});
