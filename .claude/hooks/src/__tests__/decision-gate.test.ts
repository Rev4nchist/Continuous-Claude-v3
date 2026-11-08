/**
 * decision-gate: PreToolUse. It denies a PR create, a land, a merge, a git push to the fork and a write to the decision store unless
 * Dave's tap is on record. The push gate has its own flag (decisions.enforcePush, absent = warn); the other shapes use decisions.enforce.
 * The decision store is real (a temp file); git and the config file are small fakes, because the hook asks git for the branch head and
 * the tree, and reads review-router.config.json.
 *
 * Failure modes, one test group each:
 *   G1  a PR create (gh api .../pulls POST, gh pr create) runs with no open-pr decision, or with the wrong label or head
 *   G2  a land or merge (land-pr.ps1, gh pr merge, gh api .../merge) runs with no land decision for the PR, or with Keep open
 *   G3  git push to the fork runs with no ship tap for the tree being pushed (every wrapper form), or with the wrong label, tree or branch;
 *       a force or delete form, or a push to origin, runs even with a tap; a command that only mentions a push is denied
 *   G17 the cwd of the call does not exist: the real makeGit() reports "spawnSync git ENOENT" (a missing git), the reason hides the folder,
 *       and the crash row fails the harness doctor; the call must still deny where the gate enforces and warn where it warns
 *   G16 the push flag and the other flag cross over: each acts alone, in decide(), the subagent deny and the handle() catch
 *   G4  the model writes the store: Write, Edit, NotebookEdit, the Desktop Commander writes, or shell text
 *   G5  the Desktop Commander process tools are not read (their text is in `command` and in `input`)
 *   G6  a subagent opens, lands or merges on the main session's tap
 *   G7  enforce false (or missing, or a string "true") denies; or enforce is read from checkpoint instead of decisions
 *   G8  a foreign repo, a push from main, or a normal command is denied
 *   G9  an override (SKIP_*) lets a gated command through
 *   G10 a gated shape that cannot be judged (git fails, no PR number) is allowed
 *   G11 a command with two lands or merges is judged on the first one only (every segment needs its own tap and its own sha)
 *   G12 the model moves a file onto the store (Desktop Commander move_file, write_pdf), or reaches it with a .. path
 *   G13 the model burns taps from a shell (land-decision.mjs use, a loop of pr-checkpoint.mjs --json --pr)
 *   T16 a create is judged in the folder of the first cd anywhere in the text, so a cd after it, or a cd that may not run, hides a CCv3 checkout;
 *       the head is read from a later command or a quoted title, and an empty head is allowed
 *   T17 a merge or a land is judged the same wrong way (a land script is judged by its tap only, so popd never blocks it)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionRecord, decisionRows, offerWrite, type Step } from '../shared/decisions-store.js';
import { COMMAND_TOOLS, WRITE_TOOLS, decide, handle, makeGit, type Deps } from '../decision-gate.js';

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const DC = 'mcp__plugin_desktop-commander_desktop-commander__';
let dir = '';
let storeFile = '';
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-gate-'));
  storeFile = join(dir, 'decisions.json');
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = storeFile;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

const TREE = 't'.repeat(40);
const TREE2 = 'u'.repeat(40);
interface GitCall { cwd: string; args: string[] }
/**
 * enforcePush defaults to true here so a push deny shows as a deny. Pass `enforcePush: undefined` for the shipped state (flag absent).
 * trees: what `git rev-parse <ref>^{tree}` answers. pushRef: what `git rev-parse --abbrev-ref @{push}` answers (default: it fails).
 */
interface World {
  enforce?: unknown; enforcePush?: unknown; config?: string | null; remote?: string; branch?: string; gitFails?: boolean;
  heads?: Record<string, string>; trees?: Record<string, string>; pushRef?: string; calls?: GitCall[];
  /** What `git write-tree` answers (the index tree). Absent: write-tree fails. */
  indexTree?: string;
  /** What `git remote get-url <name>` answers for a remote other than fork (default: it fails). */
  remoteUrls?: Record<string, string>;
  /** Folders that are NOT a CCv3 checkout: `git remote -v` there lists another repo. Every other folder is the CCv3 checkout. */
  otherDirs?: string[];
}

/** A fake git and config for a checkout at /repo. */
function deps(w: World = {}): Deps {
  const config = w.config !== undefined ? w.config : JSON.stringify({ decisions: { enforce: 'enforce' in w ? w.enforce : true, enforcePush: 'enforcePush' in w ? w.enforcePush : true } });
  const heads = w.heads ?? { 'feat/x': HEAD };
  const trees = w.trees ?? { HEAD: TREE, 'feat/x': TREE };
  return {
    env: { ...process.env, CCV3_DECISIONS_FILE: storeFile },
    home: '/home/nobody',
    readFile: (p) => (p.replace(/\\/g, '/') === '/repo/review-router.config.json' ? config : null),
    git: (cwd, args) => {
      w.calls?.push({ cwd, args });
      if (w.gitFails) throw new Error('git exploded');
      const a = args.join(' ');
      if (a === 'remote -v') {
        if (w.otherDirs?.includes(cwd.replace(/\\/g, '/'))) return { status: 0, stdout: 'origin\thttps://github.com/someone/else.git (push)\n' };
        return { status: 0, stdout: `fork\t${w.remote ?? `https://github.com/${REPO}.git`} (push)\n` };
      }
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
      if (a === 'write-tree') return w.indexTree ? { status: 0, stdout: `${w.indexTree}\n` } : { status: 128, stdout: '' };
      if (a === 'branch --show-current') return { status: 0, stdout: `${w.branch ?? 'feat/x'}\n` };
      const gu = /^remote get-url (.+)$/.exec(a);
      if (gu) return w.remoteUrls?.[gu[1]] ? { status: 0, stdout: `${w.remoteUrls[gu[1]]}\n` } : { status: 2, stdout: '' };
      if (a === 'rev-parse --abbrev-ref @{push}') return w.pushRef ? { status: 0, stdout: `${w.pushRef}\n` } : { status: 128, stdout: '' };
      const m = /^rev-parse (.+)\^\{commit\}$/.exec(a);
      if (m && heads[m[1]]) return { status: 0, stdout: `${heads[m[1]]}\n` };
      const t = /^rev-parse (.+)\^\{tree\}$/.exec(a);
      if (t && trees[t[1]]) return { status: 0, stdout: `${trees[t[1]]}\n` };
      return { status: 1, stdout: '' };
    },
  };
}

/** Record Dave's tap: an offer whose options hold the label, then the decision (the real ledger path). `tree` is the tree the offer binds. */
function tap(step: Step, key: string, head: string, label: string, tree?: string): void {
  expect(offerWrite({ step, key, head, tree, spec: { header: 'T', question: 'Q?', options: [{ label }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step, key, head, label })).toEqual({ ok: true });
}

const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo', ...extra });
const pwsh = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: '/repo', ...extra });
const denied = (input: object, w?: World) => decide(input, deps(w)).action === 'deny';
const reasonOf = (input: object, w?: World): string => { const d = decide(input, deps(w)); return d.action === 'deny' ? d.reason : ''; };

const CREATE = `gh api repos/${REPO}/pulls -X POST -F draft=true -F head=feat/x -F base=main -F body=@b.md -F title=t`;
const branchKey = (b = 'feat/x') => `${REPO}@${b}`;
const prKey = (n: number) => `${REPO}#${n}`;

describe('G1 PR create', () => {
  it('denies a create with no open-pr decision, and the reason names the question to ask', () => {
    const r = reasonOf(bash(CREATE));
    expect(r).toContain('BLOCKED (decision-gate)');
    expect(r).toContain('ship-ask.mjs open-pr --branch feat/x');
    expect(r).toContain('AskUserQuestion');
  });
  it('denies gh pr create too, in both shells', () => {
    expect(denied(bash('gh pr create --draft --head feat/x --title t --body-file b.md'))).toBe(true);
    expect(denied(pwsh('gh pr create --draft --title t --body-file b.md'))).toBe(true);
  });
  it('allows the create after Open draft PR for this branch and head', () => {
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    expect(denied(bash(CREATE))).toBe(false);
  });
  it('denies when the tap was another label (Show the PR body first, Stop here, a re-run)', () => {
    for (const label of ['Show the PR body first', 'Stop here', 'Re-run pre-pr (up to $3.00 CLI) (Recommended)']) {
      tap('open-pr', branchKey(), HEAD, label);
      expect(denied(bash(CREATE)), label).toBe(true);
    }
  });
  it('denies when the tap is for an earlier head (the branch moved)', () => {
    tap('open-pr', branchKey(), OTHER, 'Open draft PR (Recommended)');
    expect(denied(bash(CREATE))).toBe(true);
  });
  it('denies when the tap is for another branch', () => {
    tap('open-pr', branchKey('feat/y'), HEAD, 'Open draft PR (Recommended)');
    expect(denied(bash(CREATE))).toBe(true);
  });
  it('reads the branch from the current branch when the command names none', () => {
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    expect(denied(bash('gh pr create --draft --title t --body-file b.md'))).toBe(false);
  });
});

describe('G2 land and merge', () => {
  const LAND = 'pwsh -File scripts/github/land-pr.ps1 -Pr 12';
  it('denies land-pr.ps1 with no land decision, and names the question', () => {
    const r = reasonOf(bash(LAND));
    expect(r).toContain('ship-ask.mjs land --pr 12');
    expect(r).toContain('-CleanupOnly');
  });
  it('allows after Land now, or Land when READY, for that PR', () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(denied(bash(LAND))).toBe(false);
    rmSync(storeFile);
    tap('land', prKey(12), HEAD, 'Land when READY (Recommended)');
    expect(denied(pwsh(LAND))).toBe(false);
  });
  it('denies after Keep open or Return to draft', () => {
    for (const label of ['Keep open', 'Return to draft']) {
      tap('land', prKey(12), HEAD, label);
      expect(denied(bash(LAND)), label).toBe(true);
    }
  });
  it('denies a decision for another PR', () => {
    tap('land', prKey(13), HEAD, 'Land now (Recommended)');
    expect(denied(bash(LAND))).toBe(true);
  });
  it('reads -Pr in the short and colon forms', () => {
    expect(denied(pwsh('.\\scripts\\github\\land-pr.ps1 -P 12'))).toBe(true);
    expect(denied(pwsh('.\\scripts\\github\\land-pr.ps1 -Pr:12 -Method squash'))).toBe(true);
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(denied(pwsh('.\\scripts\\github\\land-pr.ps1 -Pr:12 -Method squash'))).toBe(false);
  });
  it('lets -CleanupOnly through (it never merges, and the tap is used up after the merge)', () => {
    expect(denied(bash(`${LAND} -CleanupOnly`))).toBe(false);
  });
  it('denies gh pr merge and gh api .../merge with no land decision', () => {
    expect(denied(bash('gh pr merge 12 --merge'))).toBe(true);
    expect(denied(bash(`gh api repos/${REPO}/pulls/12/merge -X PUT -f merge_method=merge`))).toBe(true);
  });
  it('a raw merge passes only with the tapped head in the text (sha= or --match-head-commit)', () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(denied(bash(`gh api repos/${REPO}/pulls/12/merge -X PUT -f sha=${HEAD}`))).toBe(false);
    expect(denied(bash(`gh pr merge 12 --merge --match-head-commit ${HEAD}`))).toBe(false);
    expect(denied(bash(`gh api repos/${REPO}/pulls/12/merge -X PUT -f sha=${OTHER}`))).toBe(true);
    expect(denied(bash(`gh pr merge 12 --merge --match-head-commit ${OTHER}`))).toBe(true);
  });
  it('a raw merge with no head is denied even with a tap on record: the tap may be for an older head', () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(reasonOf(bash('gh pr merge 12 --merge'))).toContain('land-pr.ps1 -Pr 12');
    expect(denied(bash(`gh api repos/${REPO}/pulls/12/merge -X PUT -f merge_method=merge`))).toBe(true);
  });
  it('reads a merge endpoint with GET as a read', () => {
    expect(denied(bash(`gh api repos/${REPO}/pulls/12/merge -X GET`))).toBe(false);
  });
});

describe('G3 git push to the fork', () => {
  const PUSH = 'git push fork feat/x';
  const shipTap = (branch = 'feat/x', tree = TREE, head = HEAD, label = 'Commit and push (Recommended)') => tap('ship', branchKey(branch), head, label, tree);

  describe('RED-3 every wrapper form is seen, in every command tool', () => {
    it.each([
      PUSH,
      'git.exe push fork feat/x',
      '/usr/bin/git push fork feat/x',
      '"C:\\Program Files\\Git\\bin\\git.exe" push fork feat/x',
      '& "C:\\Program Files\\Git\\bin\\git.exe" push fork feat/x',
      '.\\git.exe push fork feat/x',
      'git -C /repo push fork feat/x',
      'git -c user.name=x -c core.editor=true push fork feat/x',
      'git --no-pager push fork feat/x',
      'git push -u fork feat/x',
      'pwsh -File scripts/git-safe.ps1 push fork feat/x',
      'pwsh -NoProfile -File C:\\repo\\scripts\\git-safe.ps1 push fork feat/x',
      'pwsh -File scripts/github/git-for.ps1 push fork feat/x',
      'pwsh -File scripts/github/git-for.ps1 -UseGitSafe push fork feat/x',
      'pwsh -File scripts/github/git-for.ps1 -Remote fork push fork HEAD:feat/x',
      'pwsh -File scripts/github/git-for.ps1 -remote:fork -usegitsafe push fork feat/x',
      'pwsh -File scripts/github/git-for.ps1 -Rem fork -U push fork feat/x',
      'pwsh -File scripts/github/git-for.ps1 -Path /repo -Remote fork push fork feat/x',
      'pwsh -NoProfile -File C:\\repo\\scripts\\github\\git-for.ps1 -UseGitSafe -Remote fork push fork feat/x',
      '& git push fork feat/x',
      'GIT_TRACE=1 git push fork feat/x',
      'time git push fork feat/x',
      'sudo git push fork feat/x',
      'cd /repo && git push fork feat/x',
      'git status && git push fork feat/x',
      'git commit -F m.txt; git push fork feat/x',
      'git status | git push fork feat/x',
      '(git push fork feat/x)',
      'if true; then git push fork feat/x; fi',
      'g"i"t push fork feat/x',
      'git "push" fork feat/x',
      "git push fork 'feat/x'",
      'git push fork feat/x 2>&1',
      'git push \\\n  fork feat/x',
    ])('denies %s with no tap (Bash and PowerShell)', (cmd) => {
      expect(denied(bash(cmd)), `bash: ${cmd}`).toBe(true);
      expect(denied(pwsh(cmd)), `pwsh: ${cmd}`).toBe(true);
    });
    it('names the question to ask and the rule to follow in the reason', () => {
      const r = reasonOf(bash(PUSH));
      expect(r).toContain('BLOCKED (decision-gate)');
      expect(r).toContain('ship-ask.mjs commit-and-push --branch feat/x --json');
      expect(r).toContain('AskUserQuestion');
      expect(r).toContain('Commit and push');
      expect(r).toContain('Push only');
      expect(r).toContain('bare commit && push');
      expect(r).toContain('no redirect');
    });
    it('reads the Desktop Commander process tools', () => {
      expect(denied({ tool_name: `${DC}start_process`, tool_input: { command: PUSH }, cwd: '/repo' })).toBe(true);
      expect(denied({ tool_name: `${DC}interact_with_process`, tool_input: { pid: 1, input: PUSH }, cwd: '/repo' })).toBe(true);
    });
  });

  describe('RED-4 and RED-5 the tap is bound to the tree and the branch, not the head', () => {
    it('allows after Commit and push for this branch and the tree being pushed', () => {
      shipTap();
      expect(denied(bash(PUSH))).toBe(false);
      expect(denied(pwsh('pwsh -File scripts/git-safe.ps1 push fork feat/x'))).toBe(false);
    });
    it('allows when the tap is for an OLD head and the tree matches (the commit moved the head after the tap)', () => {
      shipTap('feat/x', TREE, OTHER);
      expect(denied(bash(PUSH))).toBe(false);
    });
    it('denies when the tree differs from the tapped tree', () => {
      shipTap('feat/x', TREE2);
      expect(denied(bash(PUSH))).toBe(true);
    });
    it('denies when the tap was another label', () => {
      for (const label of ['Show the diff first', 'Stop here', 'Do not Commit and push', 'Do not Push only']) {
        rmSync(storeFile, { force: true });
        shipTap('feat/x', TREE, HEAD, label);
        expect(denied(bash(PUSH)), label).toBe(true);
      }
    });
    it('denies when the tap is for another branch key', () => {
      shipTap('feat/y');
      expect(denied(bash(PUSH))).toBe(true);
    });
    it('denies when the tap has no tree on record (null)', () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)');
      expect(denied(bash(PUSH))).toBe(true);
    });
    it('denies when the only tap is of another step', () => {
      tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)', TREE);
      expect(denied(bash(PUSH))).toBe(true);
    });
    it('allows when ANY recorded row matches: an older tap for another tree does not hide a good one', () => {
      shipTap('feat/x', TREE2, OTHER);
      shipTap('feat/x', TREE, HEAD);
      expect(denied(bash(PUSH))).toBe(false);
    });
  });

  // Push only: nothing is staged, the tap binds HEAD^{tree}. It licenses a plain push of that tree. It never licenses a push that
  // follows a commit in the same command, because that push sends the index tree (viaIndex), which the tap did not bind.
  describe('RED-14 "Push only" licenses a plain push of the tapped tree, never a chained commit and push', () => {
    const PO = 'Push only (Recommended)';
    const PUSHB = 'git push fork feat/x';
    const COMMIT = 'git commit -F m.txt';
    const INDEX = 'i'.repeat(40);
    it('G-PO1: allows a plain push after Push only for this branch and the HEAD tree', () => {
      shipTap('feat/x', TREE, HEAD, PO);
      expect(denied(bash(PUSH))).toBe(false);
      expect(denied(pwsh('pwsh -File scripts/git-safe.ps1 push fork feat/x'))).toBe(false);
    });
    it('G-PO1b: the plain label without (Recommended) works too', () => {
      shipTap('feat/x', TREE, HEAD, 'Push only');
      expect(denied(bash(PUSH))).toBe(false);
    });
    it('G-PO2: denies when the tapped tree is not the tree being pushed', () => {
      shipTap('feat/x', TREE2, HEAD, PO);
      expect(denied(bash(PUSH))).toBe(true);
    });
    it('G-PO3: denies when the tap is for another branch key', () => {
      shipTap('feat/y', TREE, HEAD, PO);
      expect(denied(bash(PUSH))).toBe(true);
    });
    it('G-PO4: denies a label that only starts like Push only', () => {
      for (const label of ['Push only now', 'Push only (Recommended) please', 'Do not Push only', 'push only']) {
        rmSync(storeFile, { force: true });
        shipTap('feat/x', TREE, HEAD, label);
        expect(denied(bash(PUSH)), label).toBe(true);
      }
    });
    it('G-PO5: denies a commit chained before the push, when the tap tree is the index tree', () => {
      shipTap('feat/x', INDEX, HEAD, PO);
      expect(denied(bash(`${COMMIT} && ${PUSHB}`), { indexTree: INDEX })).toBe(true);
      expect(reasonOf(bash(`${COMMIT} && ${PUSHB}`), { indexTree: INDEX })).toContain('Push only');
    });
    it('G-PO6: denies the chained form even when the tap tree equals both the HEAD tree and the index tree', () => {
      shipTap('feat/x', TREE, HEAD, PO);
      expect(denied(bash(`${COMMIT} && ${PUSHB}`), { indexTree: TREE })).toBe(true);
    });
    it('G-PO6b: Commit and push still allows the chained form (the new rule does not weaken it)', () => {
      shipTap('feat/x', INDEX, HEAD, 'Commit and push (Recommended)');
      expect(denied(bash(`${COMMIT} && ${PUSHB}`), { indexTree: INDEX })).toBe(false);
    });
    // The HEAD tree is read before any commit in the command runs. A Push only tap equals that tree, so a command that stages or commits
    // and then pushes, in a form the chained-commit rule does not recognise, would send a new tree the tap never bound. Fail closed.
    it('G-PO8: denies add, commit and push in one command (a form the chained rule does not accept)', () => {
      shipTap('feat/x', TREE, HEAD, PO);
      expect(denied(bash(`git add f.txt && ${COMMIT} && ${PUSHB}`))).toBe(true);
    });
    it('G-PO9: denies a commit and a push joined by ; , a newline or ||', () => {
      shipTap('feat/x', TREE, HEAD, PO);
      for (const join of ['; ', '\n', ' || ']) expect(denied(bash(`${COMMIT}${join}${PUSHB}`)), JSON.stringify(join)).toBe(true);
    });
    it('G-PO10: denies a push with an output redirect or a trailing command (only a bare push is licensed)', () => {
      shipTap('feat/x', TREE, HEAD, PO);
      expect(denied(bash(`${PUSHB} > out.txt 2>&1`))).toBe(true);
      expect(denied(bash(`${PUSHB}; echo done`))).toBe(true);
      expect(denied(bash(`${PUSHB} | tail -3`))).toBe(true);
    });
    it('G-PO11: still allows a bare push after a cd or a read-only git call', () => {
      shipTap('feat/x', TREE, HEAD, PO);
      expect(denied(bash(`cd /tmp/repo && ${PUSHB}`))).toBe(false);
      expect(denied(bash(`git status && ${PUSHB}`))).toBe(false);
    });
    it('G-PO7: a Push only tap never licenses a force, origin or subagent push', () => {
      shipTap('feat/x', TREE, HEAD, PO);
      expect(denied(bash('git push --force fork feat/x'))).toBe(true);
      expect(denied(bash('git push origin feat/x'))).toBe(true);
      expect(denied(bash(PUSH, { agent_id: 'sub-1' }))).toBe(true);
    });
  });

  describe('RED-6 the refspec names the branch and the tree to check', () => {
    it('reads the destination, else the source, else the current branch', () => {
      shipTap('feat/y');
      const w = { trees: { HEAD: TREE, 'feat/x': TREE, 'feat/y': TREE } };
      expect(denied(bash('git push fork HEAD:feat/y'), w)).toBe(false);
      expect(denied(bash('git push fork HEAD:refs/heads/feat/y'), w)).toBe(false);
      expect(denied(bash('git push fork feat/x:feat/y'), w)).toBe(false);
      expect(denied(bash('git push fork feat/y'), w)).toBe(false);
      expect(denied(bash('git push fork refs/heads/feat/y'), w)).toBe(false);
      expect(denied(bash('git push fork HEAD:feat/z'), w)).toBe(true);
      expect(denied(bash('git push fork'), w)).toBe(true); // the current branch is feat/x: no tap for it
      expect(denied(bash('git push fork'), { ...w, branch: 'feat/y' })).toBe(false);
      expect(denied(bash('git push fork HEAD'), { ...w, branch: 'feat/y' })).toBe(false);
      expect(denied(bash('git push'), { ...w, branch: 'feat/y' })).toBe(false); // no remote: @{push} fails, treated as the fork
    });
    it('checks the tree of the SOURCE ref', () => {
      shipTap('feat/z', TREE2);
      const w = { trees: { HEAD: TREE, 'feat/x': TREE2 } };
      expect(denied(bash('git push fork feat/x:feat/z'), w)).toBe(false);
      expect(denied(bash('git push fork HEAD:feat/z'), w)).toBe(true);
    });
    it('judges every refspec of one push', () => {
      shipTap('feat/x');
      const w = { trees: { HEAD: TREE, 'feat/x': TREE, 'feat/y': TREE } };
      expect(denied(bash('git push fork feat/x feat/y'), w)).toBe(true);
      shipTap('feat/y');
      expect(denied(bash('git push fork feat/x feat/y'), w)).toBe(false);
    });
    it('skips option values: --repo, -o and --receive-pack take the next word', () => {
      shipTap();
      expect(denied(bash('git push -o ci.skip --receive-pack=x fork feat/x'))).toBe(false);
      expect(denied(bash('git push -o ci.skip fork feat/y'))).toBe(true);
    });
    it('denies when the tree of the source cannot be read', () => {
      shipTap();
      expect(reasonOf(bash('git push fork nosuch:feat/x'))).toContain('tree');
    });
    it('uses @{push} for the remote when none is named: an origin upstream is a push to origin', () => {
      expect(denied(bash('git push'), { pushRef: 'origin/feat/x' })).toBe(true);
      shipTap();
      expect(denied(bash('git push'), { pushRef: 'fork/feat/x' })).toBe(false);
    });
    it('denies a detached HEAD with no refspec (the branch cannot be named)', () => {
      expect(reasonOf(bash('git push fork'), { branch: '' })).toContain('branch');
    });
    it('denies a git option that moves the repo (--git-dir, --work-tree): the checkout cannot be known', () => {
      shipTap();
      expect(denied(bash('git --git-dir=/other/.git push fork feat/x'))).toBe(true);
      expect(denied(bash('git --work-tree /other push fork feat/x'))).toBe(true);
    });
  });

  describe('RED-7 what passes with no tap', () => {
    it.each([
      'git push fork main',
      'git push fork HEAD:main',
      'git push fork HEAD:refs/heads/main',
      'git push --dry-run fork feat/x',
      'git push -n fork feat/x',
      'git push --help',
      'git push -h',
      'git stash push',
      'git stash push -m wip',
      'git -C /repo stash push -m wip',
      'echo git push fork feat/x',
      'rg "git push fork feat/x" docs',
      "rg 'git push' docs",
      'git commit -m "git push fork feat/x"',
      'git commit -m "x; git push fork feat/x"',
      'git commit -m "x" && echo "git push fork feat/x"',
      'git push other feat/x',
      'git fetch fork',
      'git pull fork main',
      'git status',
      'ssh-push fork feat/x',
      'mygit push fork feat/x',
    ])('passes %s', (cmd) => {
      expect(denied(bash(cmd)), cmd).toBe(false);
      expect(denied(pwsh(cmd)), cmd).toBe(false);
      expect(handle(JSON.stringify(bash(cmd)), deps())).toBe('{}');
    });
    it('passes a push in a checkout that is not CCv3', () => {
      expect(denied(bash(PUSH), { remote: 'https://github.com/someone/else.git' })).toBe(false);
      expect(denied(bash('git push origin main'), { remote: 'https://github.com/someone/else.git' })).toBe(false);
      expect(denied(bash('git push --force fork feat/x'), { remote: 'https://github.com/someone/else.git' })).toBe(false);
    });
    it('passes a push in the same text where the first segment is a different tool', () => {
      expect(denied(bash('echo done; git stash push -m x'))).toBe(false);
    });
  });

  describe('D4 a push to origin from a CCv3 checkout is denied, even with a tap', () => {
    it('denies origin with any branch, with and without a tap', () => {
      shipTap();
      for (const cmd of ['git push origin feat/x', 'git push origin main', 'git push origin', 'git push -u origin HEAD:feat/x', 'git push https://github.com/parcadei/continuous-claude.git feat/x']) {
        expect(denied(bash(cmd)), cmd).toBe(true);
      }
      expect(reasonOf(bash('git push origin main'))).toContain('origin');
    });
    it('reads a remote under another name by the URL it points at', () => {
      const FORK_URL = `https://github.com/${REPO}.git`;
      expect(denied(bash('git push rev4 feat/x'), { remoteUrls: { rev4: FORK_URL } })).toBe(true); // the fork under another name needs the tap
      expect(reasonOf(bash('git push rev4 feat/x'), { remoteUrls: { rev4: FORK_URL } })).toContain('ship-ask.mjs');
      expect(reasonOf(bash('git push up main'), { remoteUrls: { up: 'git@github.com:parcadei/continuous-claude.git' } })).toContain('origin');
      expect(denied(bash('git push other feat/x'), { remoteUrls: { other: 'https://github.com/someone/else.git' } })).toBe(false);
      expect(denied(bash('git push other feat/x'))).toBe(false); // get-url fails: not ours
      shipTap();
      expect(denied(bash('git push rev4 feat/x'), { remoteUrls: { rev4: FORK_URL } })).toBe(false);
    });
    it('reads an upstream that @{push} names under another name the same way', () => {
      expect(denied(bash('git push'), { pushRef: 'rev4/feat/x', remoteUrls: { rev4: `https://github.com/${REPO}.git` } })).toBe(true);
    });
  });

  describe('RED-8 force and delete forms are denied even with a valid tap', () => {
    it.each([
      'git push --force fork feat/x',
      'git push -f fork feat/x',
      'git push fork feat/x --force',
      'git push --force-with-lease fork feat/x',
      'git push --force-with-lease=feat/x fork feat/x',
      'git push --force-if-includes fork feat/x',
      'git push fork +feat/x',
      'git push fork +HEAD:feat/x',
      'git push --mirror fork',
      'git push --all fork',
      'git push --branches fork',
      'git push --tags fork',
      'git push --delete fork feat/x',
      'git push -d fork feat/x',
      'git push --prune fork feat/x',
      'git push fork :feat/x',
      'git push -fu fork feat/x',
      'git push fork feat/x tag v1',
      'git push --force fork main',
      'git push fork +main',
      'git push --delete fork main',
    ])('denies %s', (cmd) => {
      shipTap();
      shipTap('main');
      expect(denied(bash(cmd)), cmd).toBe(true);
      expect(reasonOf(bash(cmd)), cmd).toMatch(/force|delete|rewrit/i);
    });
    it('denies the unsafe push of a chain even when the plain push before it has its tap', () => {
      shipTap();
      expect(denied(bash(`${PUSH}; git push -f fork feat/x`))).toBe(true);
      expect(denied(bash(`git push -f fork feat/x; ${PUSH}`))).toBe(true);
    });
    it('does not deny a dry run of a force push', () => {
      expect(denied(bash('git push --dry-run --force fork feat/x'))).toBe(false);
    });
  });

  describe('RED-11 a chained command is judged one segment at a time', () => {
    it('denies two pushes when only the first has a tap, and names the second', () => {
      shipTap();
      const r = reasonOf(bash(`${PUSH} && git push fork feat/y`), { trees: { HEAD: TREE, 'feat/x': TREE, 'feat/y': TREE } });
      expect(r).toContain('feat/y');
    });
    it('allows both when each branch has its tap', () => {
      shipTap();
      shipTap('feat/y');
      const w = { trees: { HEAD: TREE, 'feat/x': TREE, 'feat/y': TREE } };
      expect(denied(bash(`${PUSH}; git push fork feat/y`), w)).toBe(false);
      expect(denied(bash(`${PUSH}\ngit push fork feat/y`), w)).toBe(false);
    });
    it('judges a push after a passing push-like segment', () => {
      expect(denied(bash(`git stash push && ${PUSH}`))).toBe(true);
    });
  });

  describe('RED-12 there is no override', () => {
    it('a SKIP_ assignment, or a SKIP_ value in the env, lets nothing through', () => {
      for (const cmd of [`SKIP_DECISION_GATE=1 ${PUSH}`, `$env:SKIP_DECISION_GATE='1'; ${PUSH}`, `SKIP_PRE_PR_GATE=1 SKIP_PUSH_GATE=1 ${PUSH}`]) {
        expect(denied(bash(cmd)), cmd).toBe(true);
      }
      const d = { ...deps(), env: { ...deps().env, SKIP_DECISION_GATE: '1' } };
      expect(decide(bash(PUSH), d).action).toBe('deny');
    });
  });

  describe('T13 a push from a worktree runs git in that worktree', () => {
    const cwdsOf = (calls: GitCall[]) => [...new Set(calls.map((c) => c.cwd))];
    it('uses the cd target', () => {
      const calls: GitCall[] = [];
      decide(bash('cd /wt && git push fork feat/x'), deps({ calls }));
      expect(cwdsOf(calls)).toEqual(['/wt']);
      expect(calls.some((c) => c.args.join(' ') === 'rev-parse feat/x^{tree}')).toBe(true);
    });
    it('uses the -C value over the cd target, and passes it as the cwd (never as a git argument)', () => {
      const calls: GitCall[] = [];
      decide(bash('cd /wt && git -C /wt2 push fork feat/x'), deps({ calls }));
      expect(cwdsOf(calls)).toEqual(['/wt2']);
      expect(calls.every((c) => !c.args.includes('-C'))).toBe(true);
    });
    it('uses the git-for.ps1 -Path value as the directory', () => {
      const calls: GitCall[] = [];
      decide(pwsh('pwsh -File scripts/github/git-for.ps1 -Path /wt3 -Remote fork push fork feat/x'), deps({ calls }));
      expect(cwdsOf(calls)).toEqual(['/wt3']);
    });
    it('uses the payload cwd when nothing else is named', () => {
      const calls: GitCall[] = [];
      decide(bash('git push fork feat/x'), deps({ calls }));
      expect(cwdsOf(calls)).toEqual(['/repo']);
    });
    it('reads the branch from the worktree when the push names none', () => {
      const calls: GitCall[] = [];
      decide(bash('git -C /wt push fork'), deps({ calls }));
      const b = calls.find((c) => c.args.join(' ') === 'branch --show-current');
      expect(b?.cwd).toBe('/wt');
    });
  });

  // T14: git runs a push from the folder the cd commands BEFORE it set. A cd after the push never moves it.
  describe('T14 the folder of a push is set by the cd commands before it, not after it', () => {
    const OTHER_DIR = '/tmp/other-repo';
    const W: World = { otherDirs: [OTHER_DIR, '/tmp/other', 'C:/other'] };
    const cwdsOf = (calls: GitCall[]) => [...new Set(calls.map((c) => c.cwd))];
    it.each([
      `${PUSH}; cd ${OTHER_DIR}`,
      `${PUSH} && cd ${OTHER_DIR}`,
      `${PUSH}\ncd ${OTHER_DIR}`,
      `${PUSH} || cd ${OTHER_DIR}`,
      `${PUSH}; cd ${OTHER_DIR}; git status`,
    ])('denies %s with no tap: a cd after the push does not move it out of the CCv3 checkout', (cmd) => {
      expect(denied(bash(cmd), W), cmd).toBe(true);
      expect(denied(pwsh(cmd), W), `pwsh: ${cmd}`).toBe(true);
    });
    it.each([
      `${PUSH}; Set-Location C:\\other`,
      `${PUSH}; sl C:\\other`,
      `${PUSH}; Push-Location C:\\other`,
      `${PUSH}; Set-Location -LiteralPath 'C:\\other'`,
    ])('denies the PowerShell form %s with no tap', (cmd) => {
      expect(denied(pwsh(cmd), W), cmd).toBe(true);
    });
    it('judges the push in the payload cwd, never in the later cd', () => {
      const calls: GitCall[] = [];
      decide(bash(`${PUSH}; cd ${OTHER_DIR}`), deps({ ...W, calls }));
      expect(cwdsOf(calls)).toEqual(['/repo']);
    });
    it('allows the same push after the tap: the tap is checked in the CCv3 checkout', () => {
      shipTap();
      expect(denied(bash(`${PUSH}; cd ${OTHER_DIR}`), W)).toBe(false);
    });
    it('a cd text inside a quoted string is not a cd', () => {
      expect(denied(bash(`echo "; cd ${OTHER_DIR}"; ${PUSH}`), W)).toBe(true);
      expect(denied(bash(`echo '; cd ${OTHER_DIR}'; ${PUSH}`), W)).toBe(true);
    });
    // T18: a cd joined by ; may fail and leave the shell in the CCv3 cwd, so only the && form passes on the cd folder alone.
    it('a cd before the push into a folder that is not CCv3 still passes the push when joined by && (T18 covers ;)', () => {
      expect(denied(bash(`cd ${OTHER_DIR} && ${PUSH}`), W)).toBe(false);
      expect(denied(bash(`cd ${OTHER_DIR}; ${PUSH}`), W)).toBe(true);
      expect(denied(pwsh(`Set-Location C:\\other; ${PUSH}`), W)).toBe(true);
    });
    it('every folder on the cd path is judged: a cd back into the repo needs the tap, and with the tap both folders pass', () => {
      const cmd = `cd ${OTHER_DIR} && cd /repo && ${PUSH}`;
      expect(denied(bash(cmd), W)).toBe(true);
      shipTap();
      expect(denied(bash(cmd), W)).toBe(false);
    });
    // A later cd may not run (|| short-circuit, a subshell, a failed cd), so the repo folder is still judged. See T15.
    it('a cd out of the repo before the push no longer lets it pass: the cd may not run', () => {
      expect(denied(bash(`cd /repo && cd ${OTHER_DIR} && ${PUSH}`), W)).toBe(true);
    });
    it('a cd after the push, with a cd back to the repo before it, still needs the tap', () => {
      const cmd = `cd ${OTHER_DIR}; cd /repo; ${PUSH}; cd ${OTHER_DIR}`;
      expect(denied(bash(cmd), W)).toBe(true);
      shipTap();
      expect(denied(bash(cmd), W)).toBe(false);
    });
    it('a -C value still wins over the cd target', () => {
      const calls: GitCall[] = [];
      decide(bash(`cd ${OTHER_DIR} && git -C /wt2 push fork feat/x; cd /wt9`), deps({ ...W, calls }));
      expect(cwdsOf(calls)).toEqual(['/wt2']);
    });
    it('a relative cd is resolved against the cwd, and a later relative cd is resolved against the earlier one', () => {
      const calls: GitCall[] = [];
      decide(bash('cd sub && cd deeper && git push fork feat/x; cd ../other'), deps({ calls }));
      expect(cwdsOf(calls)).toEqual([resolve('/repo', 'sub'), resolve('/repo', 'sub', 'deeper')]);
    });
    it('a squashed-quote push (g"i"t push) is placed by the cds before it', () => {
      expect(denied(bash(`g"i"t push fork feat/x; cd ${OTHER_DIR}`), W)).toBe(true);
      expect(denied(bash(`cd ${OTHER_DIR} && g"i"t push fork feat/x`), W)).toBe(false);
    });
    it('two pushes are each judged in their own folder: only the one in the CCv3 checkout needs the tap', () => {
      const cmd = `cd /tmp/other && git push other main; cd /repo && ${PUSH}`;
      expect(denied(bash(cmd), W)).toBe(true);
      shipTap();
      expect(denied(bash(cmd), W)).toBe(false);
    });
    it('two pushes: the second runs after both cds, so the repo folder on its path needs its own tap too', () => {
      const cmd = `cd /repo && ${PUSH}; cd /tmp/other && git push fork feat/y`;
      expect(denied(bash(cmd), W)).toBe(true);
      shipTap();
      expect(denied(bash(cmd), W)).toBe(true); // the second push may run in /repo (its cd may not run): feat/y has no tap
      shipTap('feat/y', TREE, HEAD);
      expect(denied(bash(cmd), { ...W, trees: { HEAD: TREE, 'feat/x': TREE, 'feat/y': TREE } })).toBe(false);
    });
    it('two identical pushes in different folders are two judgments', () => {
      const calls: GitCall[] = [];
      decide(bash(`cd /tmp/a && ${PUSH}; cd /tmp/b && ${PUSH}`), deps({ calls }));
      // The second push follows a ; after the first cd, so its payload cwd is judged too (T18).
      expect(cwdsOf(calls).sort()).toEqual(['/repo', '/tmp/a', '/tmp/b']);
    });
  });

  // T15: a cd in the text may never run, or may not last. The push is judged in EVERY folder on its cd path; one deny denies.
  describe('T15 a cd that may not run does not hide the CCv3 folder', () => {
    const OTHER_DIR = '/tmp/other-repo';
    const W: World = { otherDirs: [OTHER_DIR, '/tmp/other', 'C:/other'] };
    const OTHER_WIN = 'C:\\other';
    // The payload cwd is a non-CCv3 folder under /repo, so the config is still found (the flag is read from the payload cwd).
    const SUB = '/repo/sub';
    const WSUB: World = { otherDirs: [...W.otherDirs!, SUB] };
    it.each([
      ['|| short-circuit', `cd /repo && true || cd ${OTHER_DIR}; ${PUSH}`],
      ['&& after false', `cd /repo; false && cd ${OTHER_DIR}; ${PUSH}`],
      ['subshell', `cd /repo && (true; cd ${OTHER_DIR}; true) && ${PUSH}`],
      ['background', `cd /repo; cd ${OTHER_DIR} & ${PUSH}`],
      ['pipe', `cd /repo && cd ${OTHER_DIR} | cat; ${PUSH}`],
      ['comment', `cd /repo # ; cd ${OTHER_DIR}\n${PUSH}`],
      ['heredoc body', `cd /repo\ncat <<EOF\ncd ${OTHER_DIR}\nEOF\n${PUSH}`],
      ['cd with too many arguments', `cd /repo; cd ${OTHER_DIR} extra; ${PUSH}`],
      ['function body', `cd /repo\nf() {\n  cd ${OTHER_DIR}\n}\n${PUSH}`],
    ])('denies a push when the later cd is a %s: %s', (_name, cmd) => {
      expect(denied(bash(cmd), W), cmd).toBe(true);
    });
    it('denies the PowerShell -WhatIf cd, which does not move', () => {
      const cmd = `Set-Location /repo; cd ${OTHER_WIN} -WhatIf; ${PUSH}`;
      expect(denied(pwsh(cmd), W), cmd).toBe(true);
    });
    it('judges the push in each folder on the path, never in the payload cwd when a cd comes first', () => {
      const calls: GitCall[] = [];
      decide(bash(`cd /aa && cd /bb && cd /cc && ${PUSH}`), deps({ calls }));
      expect([...new Set(calls.map((c) => c.cwd))]).toEqual(['/aa', '/bb', '/cc']);
    });
    it('a push before any cd is judged only in the payload cwd', () => {
      const calls: GitCall[] = [];
      decide(bash(`${PUSH}; cd /a`), deps({ calls }));
      expect([...new Set(calls.map((c) => c.cwd))]).toEqual(['/repo']);
    });
    it('allows the push when the tap covers every folder on the path', () => {
      shipTap();
      expect(denied(bash(`cd /repo && true || cd ${OTHER_DIR}; ${PUSH}`), W)).toBe(false);
    });

    // HOLE 2: \" escapes in bash, not in PowerShell. Each shell hides a different cd, so the squashed view reads cds under both masks.
    it('denies a push when the real PowerShell cd into CCv3 is hidden from the bash mask', () => {
      const cmd = `Write-Output "a\\"; cd /repo; Write-Output \\"b"; git "push" fork feat/x`;
      expect(denied(pwsh(cmd, { cwd: SUB }), WSUB), cmd).toBe(true);
    });
    it('denies a push when a bash-visible fake cd to another folder follows the real PowerShell cd into CCv3', () => {
      const cmd = 'cd /repo; Write-Output "a`"; cd ' + OTHER_DIR + '; echo `"b"; git "push" fork feat/x';
      expect(denied(pwsh(cmd, { cwd: SUB }), WSUB), cmd).toBe(true);
    });
    it('denies a push when a bash-visible cd to another folder follows a PowerShell cd into CCv3 that the bash mask hides', () => {
      const cmd = `Write-Output "a\\"; cd /repo; Write-Output \\"b"; cd ${OTHER_DIR}; git "push" fork feat/x`;
      expect(denied(pwsh(cmd, { cwd: SUB }), WSUB), cmd).toBe(true);
    });
  });

  // RED-13: a plain commit in the SAME command text moves HEAD before the push runs. The hook reads HEAD earlier, so the tap is
  // compared with the index tree (what the commit will hold). HEAD's tree is TREE, the index tree is INDEX in these tests.
  describe('RED-13 a plain commit before the push in the same command: the tap is compared with the index tree', () => {
    const INDEX = 'i'.repeat(40);
    const W: World = { indexTree: INDEX };
    const PUSHB = 'git push fork feat/x';
    const COMMIT = 'git commit -F m.txt';
    const callsOf = (cmd: string, tool: typeof bash | typeof pwsh = bash, w: World = W): string[] => {
      const calls: GitCall[] = [];
      decide(tool(cmd), deps({ ...w, calls }));
      return calls.map((c) => c.args.join(' '));
    };

    it.each([
      `${COMMIT} && ${PUSHB}`,
      `git commit -q -F m.txt && ${PUSHB}`,
      `git commit --quiet --file m.txt && ${PUSHB}`,
      `git commit --file=m.txt && ${PUSHB}`,
      `git commit -m "fix: a thing (x)" && ${PUSHB}`,
      `git commit --message='msg' && ${PUSHB}`,
      `cd /repo && ${COMMIT} && ${PUSHB}`,
      `cd /repo; ${COMMIT} && ${PUSHB}`,
      `git status; ${COMMIT} && ${PUSHB}`,
      `${COMMIT} && git status && ${PUSHB}`,
      `${COMMIT} && git push fork HEAD:feat/x`,
      `${COMMIT} && git push fork`,
      `${COMMIT} && pwsh -File scripts/git-safe.ps1 push fork feat/x`,
      `pwsh -File scripts/git-safe.ps1 commit -F m.txt && pwsh -File scripts/git-safe.ps1 push fork feat/x`,
      `pwsh -File scripts/github/git-for.ps1 commit -F m.txt && pwsh -File scripts/github/git-for.ps1 push fork feat/x`,
    ])('1: allows %j with a tap on the index tree', (cmd) => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      expect(denied(bash(cmd), W), cmd).toBe(false);
    });

    it('1b: the same command is denied with no tap (the rule is the tree, not the shape)', () => {
      expect(denied(bash(`${COMMIT} && ${PUSHB}`), W)).toBe(true);
    });

    it('2: denies when the index tree is not the tapped tree (a file changed after the tap)', () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE2);
      expect(denied(bash(`${COMMIT} && ${PUSHB}`), W)).toBe(true);
      expect(reasonOf(bash(`${COMMIT} && ${PUSHB}`), W)).toContain('ship-ask.mjs commit-and-push --branch feat/x');
    });

    it('2b: a tap on the HEAD tree does not license a different index tree', () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
      expect(denied(bash(`${COMMIT} && ${PUSHB}`), W)).toBe(true);
    });

    it('2c: denies when write-tree fails, as push-tree-unresolved', () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      const w: World = { enforcePush: true }; // no indexTree: write-tree fails
      expect(denied(bash(`${COMMIT} && ${PUSHB}`), w)).toBe(true);
      expect(reasonOf(bash(`${COMMIT} && ${PUSHB}`), w)).toContain('cannot read the tree of');
      expect(decide(bash(`${COMMIT} && ${PUSHB}`), deps({ enforcePush: undefined })).action).toBe('allow'); // warn mode still only warns
    });

    it('2d: reads the index in the directory the command acts in', () => {
      const calls: GitCall[] = [];
      decide(bash(`cd /wt && ${COMMIT} && ${PUSHB}`), deps({ ...W, calls }));
      const wt = calls.find((c) => c.args.join(' ') === 'write-tree');
      expect(wt?.cwd).toBe('/wt');
    });

    it.each([
      `${COMMIT}; ${PUSHB}`,
      `${COMMIT}
${PUSHB}`,
      `${COMMIT} ;${PUSHB}`,
      `${COMMIT} && ; ${PUSHB}`,
      `${COMMIT} && git status; ${PUSHB}`,
      `${COMMIT} || ${PUSHB}`,
      `git commit -q -F m.txt; ${PUSHB}`,
      `${COMMIT}; git push fork HEAD:feat/x`,
      `${COMMIT}; pwsh -File scripts/git-safe.ps1 push fork feat/x`,
      `pwsh -File scripts/git-safe.ps1 commit -F m.txt; pwsh -File scripts/git-safe.ps1 push fork feat/x`,
      `git commit --amend -F m.txt; ${PUSHB}`,
      `git commit --amend --no-edit; ${PUSHB}`,
      `git commit -a -F m.txt; ${PUSHB}`,
      `git commit -am "msg"; ${PUSHB}`,
      `git commit --all -F m.txt; ${PUSHB}`,
      `git commit --allow-empty -F m.txt; ${PUSHB}`,
      `git commit -F m.txt --no-verify; ${PUSHB}`,
      `git commit -F m.txt -- file.txt; ${PUSHB}`,
      `git commit -F m.txt file.txt; ${PUSHB}`,
      `git commit; ${PUSHB}`,
      `git add -A; ${COMMIT}; ${PUSHB}`,
      `${COMMIT}; git add -A; ${PUSHB}`,
      `git rm x; ${COMMIT}; ${PUSHB}`,
      `git checkout other; ${COMMIT}; ${PUSHB}`,
      `git stash; ${COMMIT}; ${PUSHB}`,
      `git merge fork/main; ${COMMIT}; ${PUSHB}`,
      `echo x > m.txt; ${COMMIT}; ${PUSHB}`,
      `GIT_INDEX_FILE=/tmp/other ${COMMIT}; ${PUSHB}`,
      `git -C /elsewhere commit -F m.txt; ${PUSHB}`,
      `git -c core.hooksPath=/x commit -F m.txt; ${PUSHB}`,
      `${COMMIT} || ${PUSHB}`,
      `${COMMIT} | cat; ${PUSHB}`,
      `git commit -m "$(git add -A)"; ${PUSHB}`,
      `git commit -m "\`git add -A\`"; ${PUSHB}`,
      `(${COMMIT}); ${PUSHB}`,
      `${COMMIT}; ${PUSHB}; git add -A`,
      `${COMMIT}; cd /other; ${PUSHB}`,
      `cd /a; cd /b; ${COMMIT}; ${PUSHB}`,
      `${COMMIT}; git -C /other push fork feat/x`,
      `${COMMIT}; git push fork other:feat/x`,
      `${COMMIT}; git push fork feat/x; ${COMMIT}`,
    ])('3/4: %j falls back to the HEAD tree rule (a tap on the index tree is not enough)', (cmd) => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      expect(denied(bash(cmd), W), cmd).toBe(true);
      rmSync(storeFile, { force: true });
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
      expect(denied(bash(cmd), { ...W, trees: { HEAD: TREE, 'feat/x': TREE, other: TREE } }), `${cmd} with a HEAD-tree tap`).toBe(false);
    });

    it('3b: a fallback never asks git for the index tree', () => {
      for (const cmd of [`git commit --amend -F m.txt; ${PUSHB}`, `git commit -a -F m.txt; ${PUSHB}`, `git add -A; ${COMMIT}; ${PUSHB}`]) {
        expect(callsOf(cmd), cmd).not.toContain('write-tree');
      }
    });

    it('5: a push alone is unchanged: HEAD tree rule, no write-tree', () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      expect(denied(bash(PUSHB), W)).toBe(true);
      rmSync(storeFile, { force: true });
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
      expect(denied(bash(PUSHB), W)).toBe(false);
      expect(callsOf(PUSHB)).not.toContain('write-tree');
    });

    it('6/9: a push before the commit uses the HEAD tree rule', () => {
      for (const cmd of [`${PUSHB}; ${COMMIT}`, `${PUSHB} && ${COMMIT}`]) {
        rmSync(storeFile, { force: true });
        tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
        expect(denied(bash(cmd), W), cmd).toBe(true);
        rmSync(storeFile, { force: true });
        tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
        expect(denied(bash(cmd), W), `${cmd} with a HEAD-tree tap`).toBe(false);
        expect(callsOf(cmd), cmd).not.toContain('write-tree');
      }
    });

    it('7: force, delete, origin and subagent denials hold for a chained command', () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      tap('ship', branchKey('main'), HEAD, 'Commit and push (Recommended)', INDEX);
      for (const push of ['git push -f fork feat/x', 'git push --force-with-lease fork feat/x', 'git push fork +feat/x', 'git push fork :feat/x', 'git push --delete fork feat/x', 'git push --tags fork']) {
        expect(reasonOf(bash(`${COMMIT} && ${push}`), W), push).toMatch(/force|delete|rewrit/i);
      }
      for (const push of ['git push origin feat/x', 'git push origin main', 'git push']) {
        expect(denied(bash(`${COMMIT} && ${push}`), { ...W, pushRef: 'origin/feat/x' }), push).toBe(true);
      }
      expect(reasonOf(bash(`${COMMIT} && git push origin feat/x`), W)).toContain('origin');
      expect(reasonOf(bash(`${COMMIT} && ${PUSHB}`, { agent_id: 'sub-1' }), W)).toContain('subagent');
    });

    it('7b: a chained land still needs its own tap', () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      expect(denied(bash(`${COMMIT} && ${PUSHB} && pwsh -File scripts/github/land-pr.ps1 -Pr 12`), W)).toBe(true);
    });

    it('8: PowerShell git-safe commit then push', () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      const cmd = 'pwsh -File scripts/git-safe.ps1 commit -F m.txt && pwsh -File scripts/git-safe.ps1 push fork feat/x';
      expect(denied(pwsh(cmd), W)).toBe(false);
      expect(denied(pwsh(`pwsh -File scripts/git-safe.ps1 commit --amend -F m.txt && pwsh -File scripts/git-safe.ps1 push fork feat/x`), W)).toBe(true);
    });

    it('8b: PowerShell: && chains (PowerShell 7), ; is the fallback', () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      const gs = 'pwsh -File scripts/git-safe.ps1';
      expect(denied(pwsh(`${gs} commit -F m.txt && ${gs} push fork feat/x`), W)).toBe(false);
      expect(denied(pwsh(`${gs} commit -F m.txt; ${gs} push fork feat/x`), W)).toBe(true);
      expect(denied(pwsh(`${gs} commit -F m.txt
${gs} push fork feat/x`), W)).toBe(true);
    });

    it('10: ; newline and || between commit and push use the HEAD tree rule (a failed commit would push HEAD)', () => {
      for (const cmd of [`${COMMIT}; ${PUSHB}`, `${COMMIT}
${PUSHB}`, `${COMMIT} || ${PUSHB}`]) {
        rmSync(storeFile, { force: true });
        tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
        expect(denied(bash(cmd), W), `${cmd} with an index-tree tap`).toBe(true);
        expect(callsOf(cmd), cmd).not.toContain('write-tree');
        rmSync(storeFile, { force: true });
        tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
        expect(denied(bash(cmd), W), `${cmd} with a HEAD-tree tap`).toBe(false);
      }
    });

    it('the push gate in warn mode warns, with the same tree rule', () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      expect(decide(bash(`${COMMIT} && ${PUSHB}`), deps({ ...W, enforcePush: undefined }))).toEqual({ action: 'allow' });
      const d = decide(bash(`${COMMIT} && ${PUSHB}`), deps({ indexTree: TREE2, enforcePush: undefined }));
      expect(d.action === 'allow' && d.warn).toContain('ship');
    });
  });
});

describe('G4 the model writes the store', () => {
  it('denies Write, Edit and NotebookEdit to the store, its lock and its tmp file', () => {
    for (const tool of ['Write', 'Edit']) {
      expect(denied({ tool_name: tool, tool_input: { file_path: storeFile }, cwd: '/repo' }), tool).toBe(true);
    }
    expect(denied({ tool_name: 'NotebookEdit', tool_input: { notebook_path: storeFile }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: 'Write', tool_input: { file_path: `${storeFile}.lock` }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: 'Write', tool_input: { file_path: `${storeFile}.123.tmp` }, cwd: '/repo' })).toBe(true);
  });
  it('denies the default store path of the real home folder', () => {
    const p = join('C:\\Users\\dave', '.claude', 'state', 'ccv3-mods', 'decisions.json');
    expect(denied({ tool_name: 'Write', tool_input: { file_path: p }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: 'Write', tool_input: { file_path: 'C:/Users/dave/.claude/state/ccv3-mods/decisions.json' }, cwd: '/repo' })).toBe(true);
  });
  it('denies the Desktop Commander write tools', () => {
    expect(denied({ tool_name: `${DC}write_file`, tool_input: { path: storeFile, content: '{}' }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: `${DC}edit_block`, tool_input: { file_path: storeFile, old_string: 'a', new_string: 'b' }, cwd: '/repo' })).toBe(true);
  });
  it('allows a write to any other file, including another decisions.json', () => {
    expect(denied({ tool_name: 'Write', tool_input: { file_path: '/repo/docs/decisions.json' }, cwd: '/repo' })).toBe(false);
    expect(denied({ tool_name: 'Edit', tool_input: { file_path: '/repo/src/a.ts' }, cwd: '/repo' })).toBe(false);
  });
  it('denies shell text that writes the store, and passes a read of it', () => {
    expect(denied(bash(`echo '{}' > ${storeFile}`))).toBe(true);
    expect(denied(pwsh(`Set-Content -Path ${storeFile} -Value '{}'`))).toBe(true);
    expect(denied(bash(`node -e "import('./scripts/github/lib/decisions.mjs').then(m=>m.decisionRecord({}))"`))).toBe(true);
    expect(denied(bash(`cat ${storeFile}`))).toBe(false);
    expect(denied(pwsh(`Get-Content ${storeFile} -Raw`))).toBe(false);
    expect(denied(bash('rg decisionRecord scripts/github'))).toBe(false);
  });
  it('passes a node -e that only READS the store, and still denies node code that can write it', () => {
    expect(denied(bash(`node -e "const d=require('${storeFile}');console.log(Object.keys(d))"`))).toBe(false);
    expect(denied(bash(`node -e "console.log(require('fs').readFileSync('${storeFile}','utf8').length)"`))).toBe(false);
    expect(denied(bash(`node -e "require('fs').writeFileSync('${storeFile}','{}')"`))).toBe(true);
    expect(denied(bash(`node -e "require('fs').createWriteStream('${storeFile}').end('{}')"`))).toBe(true);
    expect(denied(bash(`node -e "require('fs').copyFileSync('/tmp/x.json','${storeFile}')"`))).toBe(true);
    expect(denied(bash(`node -e "const f=require('fs').openSync('${storeFile}','w');require('fs').closeSync(f)"`))).toBe(true);
    expect(denied(bash(`node -e "require('child_process').execSync('echo {} > ${storeFile}')"`))).toBe(true);
    expect(denied(bash(`node -e "import('./scripts/github/lib/decisions.mjs').then(m=>m.decisionRecord({}))"`))).toBe(true);
    expect(denied(bash(`node -e "require('/tmp/evil.js');console.log(require('${storeFile}'))"`))).toBe(true);
    expect(denied(bash(`node -e "console.log(require('fs').readFileSync('${storeFile}',{flag:'w'}))"`))).toBe(true);
    expect(denied(bash(`node -e "const m=process.argv[1];require(m);console.log(require('${storeFile}'))" x`))).toBe(true);
    expect(denied(bash(`node -e "const f=require('fs');f['wri'+'teFileSync']('${storeFile}','{}')"`))).toBe(true);
  });
  it('passes a copy that only READS the store (the store is the first source) and still denies a copy that writes it', () => {
    expect(denied(bash(`cp ${storeFile} /tmp/before.json`))).toBe(false);
    expect(denied(bash(`cp -f ${storeFile} /tmp/before.json`))).toBe(false);
    expect(denied(pwsh(`Copy-Item ${storeFile} C:\\tmp\\before.json`))).toBe(false);
    expect(denied(bash(`cp /tmp/x.json ${storeFile}`))).toBe(true);
    expect(denied(pwsh(`Copy-Item C:\\tmp\\x.json ${storeFile}`))).toBe(true);
    expect(denied(bash(`cp ${storeFile} ${storeFile}.bak`))).toBe(true);
    expect(denied(bash(`cp ${storeFile} /tmp/b.json && echo '{}' > ${storeFile}`))).toBe(true);
    expect(denied(pwsh(`Copy-Item -Destination ${storeFile} C:\\tmp\\x.json`))).toBe(true);
    expect(denied(pwsh(`Copy-Item -Path C:\\tmp\\x.json -Destination ${storeFile}`))).toBe(true);
    expect(denied(bash(`cp -t ${storeFile} /tmp/x.json`))).toBe(true);
    expect(denied(bash(`cp --target-directory ${storeFile} /tmp/x.json`))).toBe(true);
    expect(denied(pwsh(`Copy-Item -Force ${storeFile} C:\\tmp\\before.json`))).toBe(false);
    expect(denied(bash(`cp ${storeFile} /tmp/b.json; mv /tmp/x.json ${storeFile}`))).toBe(true);
  });
});

describe('G5 Desktop Commander process tools', () => {
  it('reads command for start_process and input for interact_with_process', () => {
    expect(denied({ tool_name: `${DC}start_process`, tool_input: { command: CREATE }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: `${DC}interact_with_process`, tool_input: { pid: 1, input: 'pwsh -File scripts/github/land-pr.ps1 -Pr 12' }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: `${DC}start_process`, tool_input: { command: 'git status' }, cwd: '/repo' })).toBe(false);
  });
  it('passes a process call with no readable text (nothing to judge)', () => {
    expect(denied({ tool_name: `${DC}interact_with_process`, tool_input: { pid: 1 }, cwd: '/repo' })).toBe(false);
  });
  it('lists the tools the matcher must cover', () => {
    expect([...COMMAND_TOOLS].sort()).toEqual(['Bash', 'PowerShell', `${DC}interact_with_process`, `${DC}start_process`].sort());
    expect([...WRITE_TOOLS].sort()).toEqual(['Edit', 'NotebookEdit', 'Write', `${DC}edit_block`, `${DC}move_file`, `${DC}write_file`, `${DC}write_pdf`].sort());
  });
});

describe('G6 subagent', () => {
  it('denies a create, a land and a merge even with the tap on record', () => {
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(denied(bash(CREATE, { agent_id: 'a1' }))).toBe(true);
    expect(denied(bash('pwsh -File scripts/github/land-pr.ps1 -Pr 12', { agent_id: 'a1' }))).toBe(true);
    expect(denied(bash('gh pr merge 12', { agent_id: 'a1' }))).toBe(true);
    expect(reasonOf(bash(CREATE, { agent_id: 'a1' }))).toContain('subagent');
  });
  it('lets a subagent run a normal command', () => {
    expect(denied(bash('git status', { agent_id: 'a1' }))).toBe(false);
    expect(denied(bash('git fetch fork', { agent_id: 'a1' }))).toBe(false);
  });
  it('denies a subagent push even with the tap on record (D3), and says why', () => {
    tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
    expect(denied(bash('git push fork feat/x', { agent_id: 'a1' }))).toBe(true);
    expect(reasonOf(bash('git push fork feat/x', { agent_id: 'a1' }))).toContain('subagent');
    expect(reasonOf(bash('git push fork feat/x', { agent_id: 'a1' }))).toContain('push');
  });
  it('denies EVERY subagent push to the fork (D3), main included, but not a dry run or a stash', () => {
    expect(denied(bash('git push fork main', { agent_id: 'a1' }))).toBe(true);
    expect(denied(bash('git push --force fork feat/x', { agent_id: 'a1' }))).toBe(true);
    expect(denied(bash('git push --dry-run fork feat/x', { agent_id: 'a1' }))).toBe(false);
    expect(denied(bash('git stash push -m x', { agent_id: 'a1' }))).toBe(false);
  });
  it('lets a subagent push in a checkout that is not CCv3, or to another remote (the checkout and the remote decide first)', () => {
    expect(denied(bash('git push fork feat/x', { agent_id: 'a1' }), { remote: 'https://github.com/someone/else.git' })).toBe(false);
    expect(denied(bash('git push origin main', { agent_id: 'a1' }), { remote: 'https://github.com/someone/else.git' })).toBe(false);
    expect(denied(bash('git push other feat/x', { agent_id: 'a1' }))).toBe(false);
  });
  it('a subagent push to origin from a CCv3 checkout is denied (origin is never allowed)', () => {
    expect(reasonOf(bash('git push origin main', { agent_id: 'a1' }))).toContain('origin');
  });
});

describe('G7 enforce flag', () => {
  it('only a literal true under decisions.enforce denies; every other value warns', () => {
    for (const w of [{ enforce: false }, { enforce: 'true' }, { enforce: 1 }, { config: null }, { config: 'not json' }, { config: JSON.stringify({ checkpoint: { enforce: true } }) }]) {
      const d = decide(bash(CREATE), deps(w));
      expect(d.action, JSON.stringify(w)).toBe('allow');
      expect(d.action === 'allow' && d.warn, JSON.stringify(w)).toBeTruthy();
    }
    expect(decide(bash(CREATE), deps({ enforce: true })).action).toBe('deny');
  });
  it('warn mode prints the would-be deny as context and does not block', () => {
    const out = JSON.parse(handle(JSON.stringify(bash(CREATE)), deps({ enforce: false }))) as { hookSpecificOutput: { permissionDecision?: string; additionalContext?: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain('would be blocked');
  });
  it('a deny is a deny output', () => {
    const out = JSON.parse(handle(JSON.stringify(bash(CREATE)), deps())) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('G8 what is not gated', () => {
  it('passes a create in a foreign checkout', () => {
    expect(denied(bash('gh pr create --draft --title t --body-file b.md'), { remote: 'https://github.com/someone/else.git' })).toBe(false);
  });
  it('passes a create from main', () => {
    expect(denied(bash('gh pr create --draft --head main --title t --body-file b.md'))).toBe(false);
  });
  it('passes ordinary commands and other tools', () => {
    for (const c of ['git status', 'gh pr view 12', 'gh pr ready 12 --undo', 'node scripts/github/pr-checkpoint.mjs --json --pr 12', 'gh api repos/x/y/pulls/12/reviews']) {
      expect(denied(bash(c)), c).toBe(false);
    }
    expect(denied({ tool_name: 'Read', tool_input: { file_path: storeFile }, cwd: '/repo' })).toBe(false);
  });
  it('passes unreadable input', () => {
    expect(handle('not json', deps())).toBe('{}');
  });
  // Unreadable input has no visible shape, so the documented posture (deny only a gated shape) allows it. It says so on stderr, once, and the log row holds no input text.
  it('passes unreadable input, says so on stderr once, and logs none of the input text', () => {
    const log = join(dir, 'guard.jsonl');
    const savedLog = process.env.CCV3_GUARD_DECISIONS_LOG;
    process.env.CCV3_GUARD_DECISIONS_LOG = log;
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      for (const raw of ['SECRET-TOKEN-abc123 gh pr merge', '{"tool_name": "Bash", SECRET-TOKEN-abc123']) {
        writes.length = 0;
        expect(handle(raw, deps())).toBe('{}');
        expect(writes, raw).toHaveLength(1);
        expect(writes[0]).toMatch(/^decision-gate: [^\n]*not readable[^\n]*allowed\.\n$/);
        expect(writes[0]).not.toContain('SECRET-TOKEN');
      }
    } finally {
      process.stderr.write = orig;
      if (savedLog === undefined) delete process.env.CCV3_GUARD_DECISIONS_LOG; else process.env.CCV3_GUARD_DECISIONS_LOG = savedLog;
    }
    const logged = existsSync(log) ? readFileSync(log, 'utf8') : '';
    expect(logged).not.toContain('SECRET-TOKEN');
  });
  it('a readable payload prints nothing on stderr', () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { expect(handle(JSON.stringify(bash('git status')), deps())).toBe('{}'); } finally { process.stderr.write = orig; }
    expect(writes).toEqual([]);
  });
});

describe('G9 there is no override', () => {
  it('a leading SKIP_ assignment or env value does not let a create through', () => {
    for (const cmd of [`SKIP_DECISION_GATE=1 ${CREATE}`, `$env:SKIP_DECISION_GATE='1'; ${CREATE}`, `SKIP_PRE_PR_GATE=1 ${CREATE}`]) {
      expect(denied(bash(cmd)), cmd).toBe(true);
    }
    const d = { ...deps(), env: { ...deps().env, SKIP_DECISION_GATE: '1', SKIP_PRE_PR_GATE: '1' } };
    expect(decide(bash(CREATE), d).action).toBe('deny');
  });
});

describe('G10 fail closed on a gated shape', () => {
  it('denies a create when git fails', () => {
    const out = JSON.parse(handle(JSON.stringify(bash(CREATE)), deps({ gitFails: true }))) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('denies a land with no readable PR number', () => {
    expect(denied(pwsh('.\\scripts\\github\\land-pr.ps1 -Pr $n'))).toBe(true);
    expect(denied(bash('gh pr merge --squash'))).toBe(true);
  });
  it('does not fail a harmless command when git fails', () => {
    expect(handle(JSON.stringify(bash('git fetch fork')), deps({ gitFails: true }))).toBe('{}');
    expect(handle(JSON.stringify(bash('git push fork main')), deps({ gitFails: true }))).not.toBe('{}'); // the checkout cannot be read: a push is gated
  });
  it('denies a push when git fails', () => {
    const out = JSON.parse(handle(JSON.stringify(bash('git push fork feat/x')), deps({ gitFails: true }))) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('denies a push when the tree cannot be read', () => {
    tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
    expect(denied(bash('git push fork feat/x'), { trees: {} })).toBe(true);
  });
});

describe('G17 a working folder (cwd) that does not exist', () => {
  // The real makeGit() runs here, not the fake: the bug is in how a failed spawn is reported. Node gives "spawnSync git ENOENT" for a
  // missing cwd, the same text as a missing git binary. The config is found from any path, so the cwd being gone does not hide the flags.
  const PUSH = 'git push fork feat/x';
  const missing = (): string => join(dir, 'gone', 'worktree');
  const realDeps = (w: World = {}): Deps => {
    const base = deps(w);
    const config = base.readFile('/repo/review-router.config.json');
    return { ...base, git: makeGit(), readFile: (p) => (p.replace(/\\/g, '/').endsWith('/review-router.config.json') ? config : null) };
  };
  type Out = { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };
  const run = (input: object, w?: World): Out => JSON.parse(handle(JSON.stringify(input), realDeps(w))) as Out;
  const textOf = (o: Out): string => o.hookSpecificOutput.permissionDecisionReason ?? o.hookSpecificOutput.additionalContext ?? '';

  it('makeGit names the cwd and does not blame git', () => {
    const cwd = missing();
    let message = '';
    try { makeGit()(cwd, ['--version']); } catch (e) { message = (e as Error).message; }
    expect(message, 'the message names the cwd').toContain(cwd);
    expect(message, 'the message must not say ENOENT').not.toMatch(/ENOENT/);
  });
  it('makeGit still runs git in a folder that exists', () => {
    const r = makeGit()(dir, ['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^git version/);
  });
  it('enforce on: a push from a missing cwd is denied, and the reason names the cwd', () => {
    const o = run(bash(PUSH, { cwd: missing() }), { enforcePush: true });
    expect(o.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(textOf(o), 'names the cwd').toContain(missing());
    expect(textOf(o), 'no ENOENT').not.toMatch(/ENOENT/);
  });
  it('enforce on: a create from a missing cwd is denied too (the other scope)', () => {
    const o = run(bash(CREATE, { cwd: missing() }), { enforce: true });
    expect(o.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(textOf(o)).toContain(missing());
  });
  it('warn mode: the command runs, with a warning that names the cwd', () => {
    const o = run(bash(PUSH, { cwd: missing() }), { enforcePush: undefined });
    expect(o.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(textOf(o), 'names the cwd').toContain(missing());
    expect(textOf(o), 'no ENOENT').not.toMatch(/ENOENT/);
    expect(textOf(o)).toContain('decisions.enforcePush');
  });
  it('a cd target that is missing is named, not the payload cwd', () => {
    const target = missing();
    const o = run(bash(`cd "${target.replace(/\\/g, '/')}" && ${PUSH}`, { cwd: dir }), { enforcePush: true });
    expect(o.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(textOf(o).replace(/\\/g, '/')).toContain(target.replace(/\\/g, '/'));
    expect(textOf(o)).not.toMatch(/ENOENT/);
  });
  it('a command that is not gated still passes from a missing cwd', () => {
    expect(handle(JSON.stringify(bash('git status', { cwd: missing() })), realDeps())).toBe('{}');
  });
  it('an existing cwd that is not a repo behaves as before: git fails, the push is denied', () => {
    const o = run(bash(PUSH, { cwd: dir }), { enforcePush: true });
    expect(o.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(textOf(o)).toContain('git remote -v failed');
  });
  it('the log gets a decision row, not an error row, so the doctor stays green', () => {
    const log = join(dir, 'guard.jsonl');
    const saved = process.env.CCV3_GUARD_DECISIONS_LOG;
    process.env.CCV3_GUARD_DECISIONS_LOG = log;
    try {
      run(bash(PUSH, { cwd: missing() }), { enforcePush: true });
      const rows = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(rows.filter((r) => r.kind === 'error'), 'no crash row').toEqual([]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ hook: 'decision-gate', decision: 'deny', reason: 'cwd-missing' });
    } finally {
      if (saved === undefined) delete process.env.CCV3_GUARD_DECISIONS_LOG; else process.env.CCV3_GUARD_DECISIONS_LOG = saved;
    }
  });
  it('a real git failure on an existing cwd is still a crash row (the log is not silenced)', () => {
    const log = join(dir, 'guard2.jsonl');
    const saved = process.env.CCV3_GUARD_DECISIONS_LOG;
    process.env.CCV3_GUARD_DECISIONS_LOG = log;
    try {
      const boom: Deps = { ...realDeps({ enforcePush: true }), git: () => { throw new Error('git exploded'); } };
      handle(JSON.stringify(bash(PUSH, { cwd: dir })), boom);
      const rows = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(rows.map((r) => r.kind)).toEqual(['error']);
    } finally {
      if (saved === undefined) delete process.env.CCV3_GUARD_DECISIONS_LOG; else process.env.CCV3_GUARD_DECISIONS_LOG = saved;
    }
  });
});

describe('G16 the push flag and the other flag act alone', () => {
  const PUSHC = 'git push fork feat/x';
  const LANDC = 'pwsh -File scripts/github/land-pr.ps1 -Pr 12';
  const ABSENT = { enforcePush: undefined };
  const out = (input: object, w: World) => JSON.parse(handle(JSON.stringify(input), deps(w))) as { hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string } };

  it('push: enforcePush absent or not literally true warns; enforce does not matter', () => {
    for (const w of [{ enforce: true, ...ABSENT }, { enforce: true, enforcePush: false }, { enforce: true, enforcePush: 'true' }, { enforce: true, enforcePush: 1 }, { enforce: false, enforcePush: false }, { config: JSON.stringify({ decisions: { enforce: true } }) }, { config: JSON.stringify({ checkpoint: { enforcePush: true } }) }]) {
      const d = decide(bash(PUSHC), deps(w));
      expect(d.action, JSON.stringify(w)).toBe('allow');
      expect(d.action === 'allow' && d.warn, JSON.stringify(w)).toBeTruthy();
    }
  });
  it('push: enforcePush true denies even when decisions.enforce is false', () => {
    expect(decide(bash(PUSHC), deps({ enforce: false, enforcePush: true })).action).toBe('deny');
  });
  it('push warn: runs, adds context that names decisions.enforcePush, does not block', () => {
    const o = out(bash(PUSHC), { enforce: true, ...ABSENT });
    expect(o.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(o.hookSpecificOutput?.additionalContext).toContain('decisions.enforcePush');
    expect(o.hookSpecificOutput?.additionalContext).toContain('ship-ask.mjs commit-and-push');
  });
  it('other warn text still names decisions.enforce', () => {
    const o = out(bash(CREATE), { enforce: false });
    expect(o.hookSpecificOutput?.additionalContext).toContain('decisions.enforce is true');
  });
  it('other: enforcePush does not make a create, a land or a store write deny', () => {
    for (const input of [bash(CREATE), bash(LANDC), bash(`echo '{}' > ${storeFile}`), { tool_name: 'Write', tool_input: { file_path: storeFile }, cwd: '/repo' }]) {
      const d = decide(input, deps({ enforce: false, enforcePush: true }));
      expect(d.action).toBe('allow');
      expect(d.action === 'allow' && d.warn).toBeTruthy();
      expect(decide(input, deps({ enforce: true, ...ABSENT })).action).toBe('deny');
    }
  });
  it('mixed land plus push: each flag decides its own part', () => {
    const cmd = `${LANDC} && ${PUSHC}`;
    const push = `${PUSHC} && ${LANDC}`;
    for (const c of [cmd, push]) {
      expect(decide(bash(c), deps({ enforce: true, ...ABSENT })).action, c).toBe('deny'); // the land part denies
      expect(decide(bash(c), deps({ enforce: false, enforcePush: true })).action, c).toBe('deny'); // the push part denies
      const both = decide(bash(c), deps({ enforce: false, enforcePush: false }));
      expect(both.action, c).toBe('allow');
      expect(both.action === 'allow' && both.warn, c).toBeTruthy();
      expect(decide(bash(c), deps({ enforce: true, enforcePush: true })).action, c).toBe('deny');
    }
  });
  it('mixed: the push tap alone does not clear the land part, and the flag that is on still denies', () => {
    tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
    const d = decide(bash(`${PUSHC} && ${LANDC}`), deps({ enforce: true, ...ABSENT }));
    expect(d.action === 'deny' && d.reason).toContain('PR #12');
    expect(decide(bash(`${PUSHC} && ${LANDC}`), deps({ enforce: false, enforcePush: true })).action).toBe('allow');
  });
  it('subagent: a push follows enforcePush, a create follows enforce', () => {
    expect(decide(bash(PUSHC, { agent_id: 'a1' }), deps({ enforce: true, ...ABSENT })).action).toBe('allow');
    expect(decide(bash(PUSHC, { agent_id: 'a1' }), deps({ enforce: false, enforcePush: true })).action).toBe('deny');
    expect(decide(bash(CREATE, { agent_id: 'a1' }), deps({ enforce: true, ...ABSENT })).action).toBe('deny');
    expect(decide(bash(CREATE, { agent_id: 'a1' }), deps({ enforce: false, enforcePush: true })).action).toBe('allow');
    expect(decide(bash(`${PUSHC} && ${LANDC}`, { agent_id: 'a1' }), deps({ enforce: true, ...ABSENT })).action).toBe('deny');
  });
  it('catch path: a push that cannot be judged follows enforcePush, any other shape follows enforce', () => {
    const permission = (input: object, w: World) => out(input, { ...w, gitFails: true }).hookSpecificOutput?.permissionDecision;
    expect(permission(bash(PUSHC), { enforce: true, ...ABSENT })).toBeUndefined();
    expect(out(bash(PUSHC), { enforce: true, gitFails: true, ...ABSENT }).hookSpecificOutput?.additionalContext).toContain('could not verify');
    expect(permission(bash(PUSHC), { enforce: false, enforcePush: true })).toBe('deny');
    expect(permission(bash(CREATE), { enforce: true, enforcePush: false })).toBe('deny');
    expect(permission(bash(CREATE), { enforce: false, enforcePush: true })).toBeUndefined();
    expect(permission(bash(`${PUSHC} && ${CREATE}`), { enforce: true, ...ABSENT })).toBe('deny');
    expect(permission(bash(`${PUSHC} && ${CREATE}`), { enforce: false, enforcePush: true })).toBe('deny');
    expect(permission(bash(`${PUSHC} && ${CREATE}`), { enforce: false, enforcePush: false })).toBeUndefined();
  });
  it('handle(): a push warn is logged as warn, a push deny as deny', () => {
    expect(out(bash(PUSHC), { enforce: true, ...ABSENT }).hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(out(bash(PUSHC), { enforce: true, enforcePush: true }).hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});

describe('G11 every land and merge shape of a command is judged', () => {
  const M43 = `gh pr merge 43 --squash --match-head-commit ${HEAD}`;
  const A44 = `gh api repos/${REPO}/pulls/44/merge -X PUT -f sha=${HEAD}`;
  it('denies two gh pr merge commands when only the first PR has a tap', () => {
    tap('land', prKey(43), HEAD, 'Land now (Recommended)');
    const cmd = `${M43} && gh pr merge 44 --squash --match-head-commit ${HEAD}`;
    expect(reasonOf(bash(cmd))).toContain('PR #44');
  });
  it('denies a gh pr merge followed by a gh api merge when only the first PR has a tap', () => {
    tap('land', prKey(43), HEAD, 'Land now (Recommended)');
    expect(reasonOf(bash(`${M43} && ${A44}`))).toContain('PR #44');
  });
  it('allows both when each PR has its tap', () => {
    tap('land', prKey(43), HEAD, 'Land now (Recommended)');
    tap('land', prKey(44), HEAD, 'Land now (Recommended)');
    expect(denied(bash(`${M43} && ${A44}`))).toBe(false);
  });
  it('splits on ; | and newlines too, and in PowerShell', () => {
    tap('land', prKey(43), HEAD, 'Land now (Recommended)');
    expect(denied(bash(`${M43}; ${A44}`))).toBe(true);
    expect(denied(bash(`${M43}\n${A44}`))).toBe(true);
    expect(denied(pwsh(`${M43}; ${A44}`))).toBe(true);
  });
  it('reads the sha of each segment: the sha of the first merge does not cover the second', () => {
    tap('land', prKey(43), HEAD, 'Land now (Recommended)');
    tap('land', prKey(44), HEAD, 'Land now (Recommended)');
    expect(reasonOf(bash(`${M43} && gh pr merge 44 --squash`))).toContain('names no head');
    expect(denied(bash(`${M43} && gh api repos/${REPO}/pulls/44/merge -X PUT -f sha=${OTHER}`))).toBe(true);
  });
  it('judges a land-pr.ps1 after another land, each with its own PR', () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(denied(bash('pwsh -File scripts/github/land-pr.ps1 -Pr 12 && pwsh -File scripts/github/land-pr.ps1 -Pr 13'))).toBe(true);
    expect(denied(bash('pwsh -File scripts/github/land-pr.ps1 -Pr 13 -CleanupOnly && pwsh -File scripts/github/land-pr.ps1 -Pr 12'))).toBe(false);
  });
});

// T16 and T17: a create, a land and a merge run in the folder the cd commands BEFORE them set, like a push (T14, T15).
// Before this change they were judged in the folder of the FIRST cd anywhere in the text, so `M; cd O` was judged in O and passed.
// The commands below name no repo (no -R, no repos/<owner>/<repo>/pulls), so the checkout of the folder decides.
describe('T16 a create is judged in every folder on the cd path before it', () => {
  const O = '/tmp/other-repo';
  const W: World = { otherDirs: [O, '/tmp/other', 'C:/other'] };
  const SUB = '/repo/sub';
  const WSUB: World = { otherDirs: [...W.otherDirs!, SUB, O] };
  const C = 'gh pr create --draft --title t --body-file b.md';
  const REST = 'gh api repos/{owner}/{repo}/pulls -X POST -F head=feat/x -F base=main -F title=t';
  const cwdsOf = (calls: GitCall[]) => [...new Set(calls.map((c) => c.cwd))];
  const ask = 'open-pr --branch feat/x';

  it.each([
    `${C}; cd ${O}`,
    `${C} && cd ${O}`,
    `${C}\ncd ${O}`,
    `${C} || cd ${O}`,
    `${REST}; cd ${O}`,
    `${REST}\ncd ${O}`,
  ])('denies %j with no tap: a cd after the create does not move it', (cmd) => {
    expect(denied(bash(cmd), W), cmd).toBe(true);
    expect(reasonOf(bash(cmd), W), cmd).toContain(ask);
  });
  it('denies the PowerShell forms with a cd after the create', () => {
    expect(denied(pwsh(`${C}; Set-Location C:\\other`), W)).toBe(true);
    expect(denied(pwsh(`${C}; sl C:\\other`), W)).toBe(true);
    expect(denied(pwsh(`${C}; Push-Location C:\\other`), W)).toBe(true);
  });
  it('judges the create in the payload cwd, never in a later cd', () => {
    const calls: GitCall[] = [];
    decide(bash(`${C}; cd ${O}`), deps({ ...W, calls }));
    expect(cwdsOf(calls)).toEqual(['/repo']);
  });
  it('a quoted cd is not a cd', () => {
    expect(denied(bash(`echo "; cd ${O}"; ${C}`), W)).toBe(true);
    expect(denied(bash(`echo '; cd ${O}'; ${C}`), W)).toBe(true);
  });
  // T18: a cd joined by ; may fail and leave the shell in the CCv3 cwd, so only the && form passes on the cd folder alone.
  it('a cd before the create into a folder that is not CCv3 still passes it when joined by && (T18 covers ;)', () => {
    expect(denied(bash(`cd ${O} && ${C}`), W)).toBe(false);
    expect(denied(pwsh(`Set-Location C:\\other && ${C}`), W)).toBe(false);
    expect(denied(pwsh(`Set-Location -LiteralPath 'C:\\other' && ${C}`), W)).toBe(false);
    expect(denied(bash(`cd ${O}; ${C}`), W)).toBe(true);
    expect(denied(pwsh(`Set-Location C:\\other; ${C}`), W)).toBe(true);
    expect(denied(pwsh(`Set-Location -LiteralPath 'C:\\other'; ${C}`), W)).toBe(true);
  });
  // The old rule took the FIRST cd, so `cd O && cd /repo && C` passed. Every folder on the path is judged now.
  it('every folder on the cd path is judged: a cd back into the repo needs the tap', () => {
    const cmd = `cd ${O} && cd /repo && ${C}`;
    expect(denied(bash(cmd), W)).toBe(true);
    expect(denied(bash(`cd /repo && cd ${O} && ${C}`), W)).toBe(true);
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    expect(denied(bash(cmd), W)).toBe(false);
  });
  it('a relative cd chains: each folder on the path is judged', () => {
    const calls: GitCall[] = [];
    decide(bash(`cd sub && cd deeper && ${C}`), deps({ calls }));
    expect(cwdsOf(calls)).toEqual([resolve('/repo', 'sub'), resolve('/repo', 'sub', 'deeper')]);
  });
  it('two creates are each judged in their own folder', () => {
    const calls: GitCall[] = [];
    const cmd = `cd ${O} && ${C}; cd /repo && ${C}`;
    expect(denied(bash(cmd), W)).toBe(true);
    decide(bash(cmd), deps({ ...W, calls }));
    expect(cwdsOf(calls)).toContain('/repo');
    expect(cwdsOf(calls)).toContain(O);
  });
  it.each([
    ['|| short-circuit', `cd /repo && true || cd ${O}; ${C}`],
    ['&& after false', `cd /repo; false && cd ${O}; ${C}`],
    ['subshell', `cd /repo && (true; cd ${O}; true) && ${C}`],
    ['background', `cd /repo; cd ${O} & ${C}`],
    ['pipe', `cd /repo && cd ${O} | cat; ${C}`],
    ['comment', `cd /repo # ; cd ${O}\n${C}`],
    ['heredoc body', `cd /repo\ncat <<EOF\ncd ${O}\nEOF\n${C}`],
    ['cd with too many arguments', `cd /repo; cd ${O} extra; ${C}`],
    ['REST create after a || cd', `cd /repo && true || cd ${O}; ${REST}`],
  ])('denies a create when the later cd is a %s: %j', (_name, cmd) => {
    expect(denied(bash(cmd), W), cmd).toBe(true);
  });
  it('denies the PowerShell -WhatIf cd, which does not move', () => {
    expect(denied(pwsh(`Set-Location /repo; cd C:\\other -WhatIf; ${C}`), W)).toBe(true);
  });
  it('allows the create when the tap covers every folder on the path', () => {
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    expect(denied(bash(`cd /repo && true || cd ${O}; ${C}`), W)).toBe(false);
    expect(denied(bash(`${C}; cd ${O}`), W)).toBe(false);
  });
  it('the worktree ship flow: a create with a quoted ; in the title and a head after it, in a worktree, with the tap', () => {
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    const calls: GitCall[] = [];
    const cmd = `cd .claude/worktrees/x && ${CREATE} -f title="a; b & c" -F head=feat/x`;
    expect(decide(bash(cmd), deps({ calls })).action).toBe('allow');
    expect(cwdsOf(calls)).toContain(resolve('/repo', '.claude/worktrees/x'));
  });

  // The folder cannot be known after popd, Pop-Location, `cd -` or a bare cd.
  describe('a folder that cannot be known', () => {
    it.each([
      `cd /repo && pushd ${O} && popd && ${C}`,
      `cd ${O} && popd && ${C}`,
      `cd ${O}; cd - ; ${C}`,
      `cd ${O}; cd; ${C}`,
    ])('denies %j with position-unknown when a CCv3 checkout is on the path', (cmd) => {
      const d = decide(bash(cmd), deps(W));
      expect(d.action, cmd).toBe('deny');
      expect(d.action === 'deny' ? d.pattern : '', cmd).toBe('position-unknown');
      expect(reasonOf(bash(cmd), W), cmd).toContain('one absolute cd');
    });
    it('denies the PowerShell Pop-Location form', () => {
      expect(denied(pwsh(`Push-Location C:\\other; Pop-Location; ${C}`), W)).toBe(true);
    });
    it('does not deny when no folder on the path is a CCv3 checkout', () => {
      expect(denied(bash(`pushd ${O} && popd && ${C}`, { cwd: SUB }), WSUB)).toBe(false);
      expect(denied(bash(`popd && ${C}`, { cwd: SUB }), WSUB)).toBe(false);
    });
  });

  // The head is read from the create's OWN segment, so a later command's -H or a quoted --head does not set it.
  describe('the head branch', () => {
    it('a -H header of a later command is not the head: the checked-out branch is judged', () => {
      const cmd = `${C}; curl -H "Accept: x" u`;
      expect(denied(bash(cmd))).toBe(true);
      tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
      expect(denied(bash(cmd))).toBe(false);
    });
    it('a --head inside a quoted title is not the head', () => {
      expect(denied(bash('gh pr create --draft --title "x --head main" --body-file b.md'))).toBe(true);
    });
    it('a --head after a quoted ; in the title is still the head', () => {
      tap('open-pr', branchKey('feat/y'), HEAD, 'Open draft PR (Recommended)');
      expect(denied(bash('gh pr create --title "a; b" --head feat/y'), { heads: { 'feat/y': HEAD } })).toBe(false);
    });
    it('a head that cannot be named (detached HEAD) is denied, not allowed', () => {
      const d = decide(bash(C), deps({ branch: '' }));
      expect(d.action).toBe('deny');
      expect(d.action === 'deny' ? d.pattern : '').toBe('head-unresolved');
    });
    it('a create from main is still not gated', () => {
      expect(denied(bash(C), { branch: 'main' })).toBe(false);
    });
    it('a spliced gh pr "create" reads --head too', () => {
      expect(denied(bash('gh pr "create" --head feat/y --title t'), { branch: 'main', heads: { 'feat/y': HEAD } })).toBe(true);
    });
  });
});

describe('T17 a merge and a land are judged in every folder on the cd path before them', () => {
  const O = '/tmp/other-repo';
  const W: World = { otherDirs: [O, '/tmp/other', 'C:/other'] };
  const SUB = '/repo/sub';
  const WSUB: World = { otherDirs: [...W.otherDirs!, SUB] };
  const M = `gh pr merge 12 --merge --match-head-commit ${HEAD}`;
  const M13 = `gh pr merge 13 --merge --match-head-commit ${HEAD}`;
  const REST = `gh api repos/{owner}/{repo}/pulls/12/merge -X PUT -f sha=${HEAD}`;
  const LAND = 'pwsh -File scripts/github/land-pr.ps1 -Pr 12';
  const cwdsOf = (calls: GitCall[]) => [...new Set(calls.map((c) => c.cwd))];
  const land12 = () => tap('land', prKey(12), HEAD, 'Land now (Recommended)');

  it.each([
    `${M}; cd ${O}`,
    `${M} && cd ${O}`,
    `${M}\ncd ${O}`,
    `${REST}; cd ${O}`,
    `gh pr "merge" 12 --match-head-commit ${HEAD}; cd ${O}`,
    `echo "; cd ${O}"; ${M}`,
  ])('denies %j with no tap: a cd after the merge does not move it', (cmd) => {
    expect(denied(bash(cmd), W), cmd).toBe(true);
    expect(reasonOf(bash(cmd), W), cmd).toContain('land --pr 12');
  });
  it('denies the PowerShell forms with a cd after the merge', () => {
    expect(reasonOf(pwsh(`${M}; Set-Location C:\\other`), W)).toContain('land --pr 12');
    expect(denied(pwsh(`${M}; sl C:\\other`), W)).toBe(true);
    expect(denied(pwsh(`${REST}; Push-Location C:\\other`), W)).toBe(true);
  });
  it('judges the merge in the payload cwd, never in a later cd', () => {
    const calls: GitCall[] = [];
    decide(bash(`${M}; cd ${O}`), deps({ ...W, calls }));
    expect(cwdsOf(calls)).toEqual(['/repo']);
  });
  it('pins: a merge in a folder that is not CCv3 passes; a land script, a named repo and a subagent do not', () => {
    expect(denied(bash(`cd ${O} && ${M}`), W)).toBe(false);
    expect(denied(pwsh(`Set-Location C:\\other && ${M}`), W)).toBe(false);
    expect(denied(pwsh(`Set-Location C:\\other; ${M}`), W)).toBe(true); // T18: the ; cd may fail
    expect(denied(bash(`cd ${O} && ${LAND}`), W)).toBe(true);
    expect(denied(bash(`cd ${O} && ${M} -R ${REPO}`), W)).toBe(true);
    expect(denied(bash(`cd ${O} && GH_REPO=${REPO} ${M}`), W)).toBe(true);
    expect(denied(bash(`cd ${O} && gh pr merge https://github.com/${REPO}/pull/12 --match-head-commit ${HEAD}`), W)).toBe(true);
    expect(denied(bash(`cd ${O} && ${M}`, { agent_id: 'a1' }), W)).toBe(true);
  });
  it('every folder on the cd path is judged: a cd back into the repo needs the tap', () => {
    expect(denied(bash(`cd ${O} && cd /repo && ${M}`), W)).toBe(true);
    expect(denied(bash(`cd /repo && cd ${O} && ${M}`), W)).toBe(true);
    land12();
    expect(denied(bash(`cd ${O} && cd /repo && ${M}`), W)).toBe(false);
  });
  it('a relative cd chains: each folder on the path is judged', () => {
    const calls: GitCall[] = [];
    decide(bash(`cd sub && cd deeper && ${M}`), deps({ calls }));
    expect(cwdsOf(calls)).toEqual([resolve('/repo', 'sub'), resolve('/repo', 'sub', 'deeper')]);
  });
  // The other folder is FIRST, so a de-duplication that drops the cd list keeps the shape in O and denied() would pass.
  it('two identical merges in two folders are two judgments', () => {
    const calls: GitCall[] = [];
    const cmd = `cd ${O} && ${M}; cd /repo && ${M}`;
    expect(denied(bash(cmd), W)).toBe(true);
    decide(bash(cmd), deps({ ...W, calls }));
    expect(cwdsOf(calls)).toContain('/repo');
    expect(cwdsOf(calls)).toContain(O);
  });
  it('two merges of two PRs: the one in the CCv3 folder needs its own tap', () => {
    tap('land', prKey(13), HEAD, 'Land now (Recommended)');
    const cmd = `cd ${O} && ${M13}; cd /repo && ${M}`;
    expect(reasonOf(bash(cmd), W)).toContain('PR #12');
  });
  it.each([
    ['|| short-circuit', `cd /repo && true || cd ${O}; ${M}`],
    ['&& after false', `cd /repo; false && cd ${O}; ${M}`],
    ['subshell', `cd /repo && (true; cd ${O}; true) && ${M}`],
    ['background', `cd /repo; cd ${O} & ${M}`],
    ['pipe', `cd /repo && cd ${O} | cat; ${M}`],
    ['comment', `cd /repo # ; cd ${O}\n${M}`],
    ['heredoc body', `cd /repo\ncat <<EOF\ncd ${O}\nEOF\n${M}`],
    ['cd with too many arguments', `cd /repo; cd ${O} extra; ${M}`],
    ['REST merge after a || cd', `cd /repo && true || cd ${O}; ${REST}`],
  ])('denies a merge when the later cd is a %s: %j', (_name, cmd) => {
    expect(denied(bash(cmd), W), cmd).toBe(true);
  });
  it('denies the PowerShell -WhatIf cd, which does not move', () => {
    expect(denied(pwsh(`Set-Location /repo; cd C:\\other -WhatIf; ${M}`), W)).toBe(true);
  });
  it('allows the merge when the tap covers every folder on the path', () => {
    land12();
    expect(denied(bash(`cd /repo && true || cd ${O}; ${M}`), W)).toBe(false);
    expect(denied(bash(`${M}; cd ${O}`), W)).toBe(false);
    expect(denied(bash(`${REST}; cd ${O}`), W)).toBe(false);
  });
  // The squashed gh pr "merge" is found only in the quote-less reading. \" escapes in bash, not in PowerShell, so each mask hides a different cd.
  it('denies a squashed merge when the real PowerShell cd into CCv3 is hidden from the bash mask', () => {
    const cmd = `Write-Output "a\\"; cd /repo; Write-Output \\"b"; gh pr "merge" 12 --match-head-commit ${HEAD}`;
    expect(denied(pwsh(cmd, { cwd: SUB }), WSUB), cmd).toBe(true);
  });
  it('denies a squashed merge when a bash-visible fake cd follows the real PowerShell cd into CCv3', () => {
    const cmd = 'cd /repo; Write-Output "a`"; cd ' + O + '; echo `"b"; gh pr "merge" 12 --match-head-commit ' + HEAD;
    expect(denied(pwsh(cmd, { cwd: SUB }), WSUB), cmd).toBe(true);
  });

  describe('a folder that cannot be known', () => {
    it.each([
      `cd /repo && pushd ${O} && popd && ${M}`,
      `cd ${O} && popd && ${REST}`,
      `cd ${O}; cd - ; ${M}`,
    ])('denies %j with position-unknown when a CCv3 checkout is on the path', (cmd) => {
      const d = decide(bash(cmd), deps(W));
      expect(d.action === 'deny' ? d.pattern : '', cmd).toBe('position-unknown');
    });
    it('denies position-unknown for a merge that names the repo, wherever it runs', () => {
      const d = decide(bash(`popd && ${M} -R ${REPO}`, { cwd: SUB }), deps(WSUB));
      expect(d.action === 'deny' ? d.pattern : '').toBe('position-unknown');
    });
    it('does not deny when no folder on the path is a CCv3 checkout', () => {
      expect(denied(bash(`pushd ${O} && popd && ${M}`, { cwd: SUB }), WSUB)).toBe(false);
    });
    // judgeLand never reads the folder for the land script, so a pushd and popd must not block a tapped land.
    it('the land script is judged by its PR tap only: pushd and popd do not block it', () => {
      const cmd = `pushd ${O} && popd && ${LAND}`;
      expect(reasonOf(bash(cmd), W)).toContain('land --pr 12');
      land12();
      expect(denied(bash(cmd), W)).toBe(false);
      expect(denied(pwsh(`Push-Location C:\\other; Pop-Location; ${LAND}`), W)).toBe(false);
    });
  });
});

// T18: a cd before the shape that can FAIL (joined to what follows by ;, || or a line end) leaves the shell in the payload cwd, so the
// shape is judged there too. Same rule as pre-pr-gate planRun: every separator from the cd to the shape must be && for the cd to count as sure.
// A cd after the shape never counts. A | or || right BEFORE a cd also makes it loose (the cd may be skipped or run in a pipe subshell).
// The & of an fd redirect (`2>&1`, `&>`, `>&2`) is no joiner (T19). Accepted over-denies (fail closed, pinned below): a loose cd followed by an
// absolute && cd still adds the cwd; a | or lone & inside a && list (`| tail`); a line end after && (`cd O &&` newline push); `cd O || exit 1; push`.
// A push is also denied with position-unknown (as a create or merge) after a popd, Pop-Location, `cd -` or a bare cd, when a CCv3 checkout is on the path.
describe('T18 the payload cwd is judged when a cd before the shape can fail', () => {
  const O = '/tmp/other-repo';
  const O2 = '/tmp/other-two';
  const W: World = { otherDirs: [O, O2, '/tmp/other', 'C:/other'] };
  const SUB = '/repo/sub';
  const WSUB: World = { otherDirs: [...W.otherDirs!, SUB] };
  const PUSH = 'git push fork feat/x';
  const C = 'gh pr create --draft --title t --body-file b.md';
  const M = `gh pr merge 12 --merge --match-head-commit ${HEAD}`;
  const REST = `gh api repos/{owner}/{repo}/pulls/12/merge -X PUT -f sha=${HEAD}`;
  const cwdsOf = (calls: GitCall[]) => [...new Set(calls.map((c) => c.cwd))];
  const shipTap = () => tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
  const openTap = () => tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
  const land12 = () => tap('land', prKey(12), HEAD, 'Land now (Recommended)');

  describe('push', () => {
    it.each([
      ['a cd with too many arguments, then ;', `cd ${O} extra; ${PUSH}`],
      ['a plain cd, then ;', `cd ${O}; ${PUSH}`],
      ['a cd, then ||', `cd ${O} || ${PUSH}`],
      ['a cd, then a line end', `cd ${O}\n${PUSH}`],
      ['a cd, && and then a ; before the push', `cd ${O} && true; ${PUSH}`],
      ['a loose cd, then a sure cd', `cd ${O}; cd ${O2} && ${PUSH}`],
      ['a sure cd, then a loose cd', `cd ${O} && cd ${O2}; ${PUSH}`],
      ['a squashed-quote push after a failing cd', `cd ${O} extra; g"i"t push fork feat/x`],
      ['a cd, a pipe, then the push', `cd ${O} | cat && ${PUSH}`],
      ['a || BEFORE the cd (the cd may be skipped)', `true || cd ${O} && ${PUSH}`],
      ['a pipe BEFORE the cd (the cd may run in a pipe subshell)', `true | cd ${O} && ${PUSH}`],
      ['a || before the cd, with a squashed-quote push', `true || cd ${O} && g"i"t push fork feat/x`],
      ['a || before the second cd', `cd ${O} && true || cd ${O2} && ${PUSH}`],
    ])('denies %s: the cd can fail and the push then runs in the CCv3 cwd', (_name, cmd) => {
      expect(denied(bash(cmd), W), cmd).toBe(true);
    });
    it('denies the PowerShell forms', () => {
      expect(denied(pwsh(`Set-Location C:\\other; ${PUSH}`), W)).toBe(true);
      expect(denied(pwsh(`Set-Location C:\\other || ${PUSH}`), W)).toBe(true);
      expect(denied(pwsh(`$true || Set-Location C:\\other && ${PUSH}`), W)).toBe(true);
    });
    it('judges the push in the cwd when a || comes before the cd', () => {
      const calls: GitCall[] = [];
      decide(bash(`true || cd ${O} && ${PUSH}`), deps({ ...W, calls }));
      expect(cwdsOf(calls).sort()).toEqual(['/repo', O].sort());
    });
    // The & of an fd redirect (2>&1, &>file, >&2) is no joiner (FD_REDIRECT, as in pre-pr-gate): the cd is sure, the cwd is not judged.
    it.each([
      ['a 2>&1 redirect between the && joiners', `cd ${O} && npm test 2>&1 && ${PUSH}`],
      ['a &> redirect between the && joiners', `cd ${O} && npm test &> /dev/null && ${PUSH}`],
      ['a >&2 redirect between the && joiners', `cd ${O} && npm test >&2 && ${PUSH}`],
      ['a 2>&1 redirect on the cd itself', `cd ${O} 2>&1 && ${PUSH}`],
    ])('does not read the & of %s as a joiner: the cwd is not judged', (_name, cmd) => {
      expect(denied(bash(cmd), W), cmd).toBe(false);
      const calls: GitCall[] = [];
      decide(bash(cmd), deps({ ...W, calls }));
      expect(cwdsOf(calls), cmd).not.toContain('/repo');
    });
    // Accepted over-denies, pinned (fail closed): a | in a && list counts as loose, so is a line end after &&, and `|| exit`.
    it.each([
      ['a pipe between the && joiners', `cd ${O} && npm test | tail -5 && ${PUSH}`],
      ['a pipe after a 2>&1 redirect', `cd ${O} && npm test 2>&1 | tail -5 && ${PUSH}`],
      ['a ; after a 2>&1 redirect', `cd ${O} && npm test 2>&1; ${PUSH}`],
      ['a lone & (background) after the cd', `cd ${O} & ${PUSH}`],
      ['a line end after &&', `cd ${O} &&\n${PUSH}`],
      ['|| exit 1 then ;', `cd ${O} || exit 1; ${PUSH}`],
    ])('over-deny accepted: %s', (_name, cmd) => {
      expect(denied(bash(cmd), W), cmd).toBe(true);
    });
    it('judges the push in the cwd and in the cd folder', () => {
      const calls: GitCall[] = [];
      decide(bash(`cd ${O} extra; ${PUSH}`), deps({ ...W, calls }));
      expect(cwdsOf(calls).sort()).toEqual(['/repo', O].sort());
    });
    it('allows the push when the tap covers the cwd', () => {
      shipTap();
      expect(denied(bash(`cd ${O} extra; ${PUSH}`), W)).toBe(false);
    });
    it.each([
      ['one cd and &&', `cd ${O} && ${PUSH}`],
      ['two cds and &&', `cd ${O} && cd ${O2} && ${PUSH}`],
      ['a quoted ; between the && joiners', `cd ${O} && echo "a; b" && ${PUSH}`],
      ['a quoted || between the && joiners', `cd ${O} && echo 'a || b' && ${PUSH}`],
      ['a quoted ; cd is not a cd', `cd ${O} && echo "; cd /repo" && ${PUSH}`],
      ['a cd after the push', `cd ${O} && ${PUSH}; cd /repo`],
      ['a cd after the push, joined by ||', `cd ${O} && ${PUSH} || cd /repo`],
      ['a ; before the cd', `echo x; cd ${O} && ${PUSH}`],
      ['a && before the cd', `true && cd ${O} && ${PUSH}`],
    ])('keeps the old prefix logic for %s: the cwd is not judged', (_name, cmd) => {
      expect(denied(bash(cmd), W), cmd).toBe(false);
      const calls: GitCall[] = [];
      decide(bash(cmd), deps({ ...W, calls }));
      expect(cwdsOf(calls), cmd).not.toContain('/repo');
    });
    it('keeps the old logic in PowerShell with &&', () => {
      expect(denied(pwsh(`Set-Location C:\\other && ${PUSH}`), W)).toBe(false);
    });
    it('a cwd that is not CCv3 and a cd that is not CCv3 still pass, whatever the joiner', () => {
      expect(denied(bash(`cd ${O} extra; ${PUSH}`, { cwd: SUB }), WSUB)).toBe(false);
      expect(denied(bash(`cd ${O}; ${PUSH}`, { cwd: SUB }), WSUB)).toBe(false);
    });
    it('a cwd that is not CCv3 and a cd into CCv3 joined by ; needs the tap', () => {
      expect(denied(bash(`cd /repo; ${PUSH}`, { cwd: SUB }), WSUB)).toBe(true);
      shipTap();
      expect(denied(bash(`cd /repo; ${PUSH}`, { cwd: SUB }), WSUB)).toBe(false);
    });
    it('a relative loose cd is still resolved against the cwd', () => {
      const calls: GitCall[] = [];
      decide(bash(`cd sub; ${PUSH}`), deps({ calls }));
      expect(cwdsOf(calls).sort()).toEqual(['/repo', resolve('/repo', 'sub')].sort());
    });
    it('over-deny accepted: a loose cd followed by an absolute && cd still adds the cwd (same as planRun)', () => {
      expect(denied(bash(`cd ${O}; cd ${O2} && ${PUSH}`), W)).toBe(true);
    });

    // popd, Pop-Location, `cd -` and a bare cd go to a folder the text does not name. A push is judged like a create or a merge (judgeAt).
    describe('a folder that cannot be known', () => {
      it.each([
        `pushd ${O} && popd && ${PUSH}`,
        `cd /repo && pushd ${O} && popd && ${PUSH}`,
        `cd ${O} && popd && ${PUSH}`,
        `cd ${O}; cd - ; ${PUSH}`,
        `cd ${O} && cd - && ${PUSH}`,
        `cd ${O}; cd; ${PUSH}`,
        `cd ${O} && cd && ${PUSH}`,
        `cd ${O} && popd && g"i"t push fork feat/x`,
      ])('denies %j with position-unknown when a CCv3 checkout is on the path', (cmd) => {
        const d = decide(bash(cmd), deps(W));
        expect(d.action, cmd).toBe('deny');
        expect(d.action === 'deny' ? d.pattern : '', cmd).toBe('position-unknown');
        expect(reasonOf(bash(cmd), W), cmd).toContain('one absolute cd');
      });
      it('denies the PowerShell Pop-Location form', () => {
        const d = decide(pwsh(`Push-Location C:\\other; Pop-Location; ${PUSH}`), deps(W));
        expect(d.action === 'deny' ? d.pattern : '').toBe('position-unknown');
      });
      it('a ship tap does not lift it: the folder is still unknown', () => {
        shipTap();
        expect(denied(bash(`pushd ${O} && popd && ${PUSH}`), W)).toBe(true);
      });
      it('is a push-scope deny: it warns, not blocks, while decisions.enforcePush is absent', () => {
        expect(decide(bash(`pushd ${O} && popd && ${PUSH}`), deps({ ...W, enforcePush: undefined })).action).toBe('allow');
      });
      it('passes when the cwd and every folder on the known path are not a CCv3 checkout', () => {
        expect(denied(bash(`pushd ${O} && popd && ${PUSH}`, { cwd: SUB }), WSUB)).toBe(false);
        expect(denied(bash(`popd && ${PUSH}`, { cwd: SUB }), WSUB)).toBe(false);
      });
      it('a --git-dir or --work-tree push still denies after a popd, even when no folder on the path is CCv3', () => {
        expect(denied(bash('popd && git --git-dir=/other/.git push fork feat/x', { cwd: SUB }), WSUB)).toBe(true);
        expect(denied(bash('popd && git --work-tree /other push fork feat/x', { cwd: SUB }), WSUB)).toBe(true);
      });
      it('an absolute -C names the folder, so a popd does not make it unknown', () => {
        expect(denied(bash(`popd && git -C ${O} push fork feat/x`), W)).toBe(false);
        const d = decide(bash('popd && git -C /repo push fork feat/x'), deps(W));
        expect(d.action === 'deny' ? d.pattern : '').toBe('ship');
      });
      it('a popd AFTER the push does not count', () => {
        shipTap();
        expect(denied(bash(`cd ${O} && ${PUSH}; popd`), W)).toBe(false);
      });
    });
  });

  describe('create', () => {
    it.each([
      ['a cd with too many arguments', `cd ${O} extra; ${C}`],
      ['a cd, then ||', `cd ${O} || ${C}`],
      ['a cd, then a line end', `cd ${O}\n${C}`],
      ['a plain cd, then ;', `cd ${O}; ${C}`],
      ['a loose cd, then a sure cd', `cd ${O}; cd ${O2} && ${C}`],
      ['a || BEFORE the cd (the cd may be skipped)', `true || cd ${O} && ${C}`],
      ['a pipe BEFORE the cd (the cd may run in a pipe subshell)', `true | cd ${O} && ${C}`],
      ['the REST form', `cd ${O} extra; gh api repos/{owner}/{repo}/pulls -X POST -F head=feat/x -F base=main -F title=t`],
    ])('denies %s: the create then runs in the CCv3 cwd', (_name, cmd) => {
      expect(denied(bash(cmd), W), cmd).toBe(true);
      expect(reasonOf(bash(cmd), W), cmd).toContain('open-pr --branch feat/x');
    });
    it('denies the PowerShell form', () => {
      expect(denied(pwsh(`Set-Location C:\\other; ${C}`), W)).toBe(true);
    });
    it('judges the create in the cwd and in the cd folder', () => {
      const calls: GitCall[] = [];
      decide(bash(`cd ${O} extra; ${C}`), deps({ ...W, calls }));
      expect(cwdsOf(calls).sort()).toEqual(['/repo', O].sort());
    });
    it('allows the create when the tap covers the cwd', () => {
      openTap();
      expect(denied(bash(`cd ${O} extra; ${C}`), W)).toBe(false);
    });
    it.each([
      ['one cd and &&', `cd ${O} && ${C}`],
      ['a quoted ; between the && joiners', `cd ${O} && echo "a; b" && ${C}`],
      ['a cd after the create', `cd ${O} && ${C}; cd /repo`],
    ])('keeps the old prefix logic for %s: the cwd is not judged', (_name, cmd) => {
      expect(denied(bash(cmd), W), cmd).toBe(false);
    });
    it('a create split over lines (gh pr + newline + create) after a failing cd is judged in the cwd', () => {
      expect(denied(bash(`cd ${O}; gh pr\ncreate --draft --title t`), W)).toBe(true);
      // Over-deny accepted: the split create has no segment start, so the line end inside `gh pr\ncreate` counts as a loose joiner.
      expect(denied(bash(`cd ${O} && gh pr\ncreate --draft --title t`), W)).toBe(true);
    });
  });

  describe('merge and land', () => {
    it.each([
      ['a cd with too many arguments', `cd ${O} extra; ${M}`],
      ['a cd, then ||', `cd ${O} || ${M}`],
      ['a cd, then a line end', `cd ${O}\n${M}`],
      ['a || BEFORE the cd (the cd may be skipped)', `true || cd ${O} && ${M}`],
      ['a pipe BEFORE the cd (the cd may run in a pipe subshell)', `true | cd ${O} && ${M}`],
      ['the REST merge after a || cd', `true || cd ${O} && ${REST}`],
      ['the REST merge', `cd ${O} extra; ${REST}`],
    ])('denies %s: the merge then runs in the CCv3 cwd', (_name, cmd) => {
      expect(reasonOf(bash(cmd), W), cmd).toContain('land --pr 12');
    });
    it('denies the PowerShell form', () => {
      expect(denied(pwsh(`Set-Location C:\\other; ${M}`), W)).toBe(true);
    });
    it('judges the merge in the cwd and in the cd folder', () => {
      const calls: GitCall[] = [];
      decide(bash(`cd ${O} extra; ${M}`), deps({ ...W, calls }));
      expect(cwdsOf(calls).sort()).toEqual(['/repo', O].sort());
    });
    it('allows the merge when the tap covers the cwd', () => {
      land12();
      expect(denied(bash(`cd ${O} extra; ${M}`), W)).toBe(false);
    });
    it.each([
      ['one cd and &&', `cd ${O} && ${M}`],
      ['a quoted || between the && joiners', `cd ${O} && echo "a || b" && ${M}`],
      ['a cd after the merge', `cd ${O} && ${M}; cd /repo`],
    ])('keeps the old prefix logic for %s: the cwd is not judged', (_name, cmd) => {
      expect(denied(bash(cmd), W), cmd).toBe(false);
    });
    it('the land script is judged by its PR tap alone, whatever the joiner', () => {
      const cmd = `cd ${O} extra; pwsh -File scripts/github/land-pr.ps1 -Pr 12`;
      expect(reasonOf(bash(cmd), W)).toContain('land --pr 12');
      land12();
      expect(denied(bash(cmd), W)).toBe(false);
    });
    it('a popd after a failing cd is still position-unknown', () => {
      const d = decide(bash(`cd ${O} extra; popd; ${M}`), deps(W));
      expect(d.action === 'deny' ? d.pattern : '').toBe('position-unknown');
    });
  });
});

describe('G12 the store through move_file, write_pdf and a .. path', () => {
  it('denies Desktop Commander move_file whose destination is the store', () => {
    expect(denied({ tool_name: `${DC}move_file`, tool_input: { source: '/tmp/forged.json', destination: storeFile }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: `${DC}move_file`, tool_input: { source: '/tmp/forged.json', destination: '/tmp/other.json' }, cwd: '/repo' })).toBe(false);
  });
  it('denies Desktop Commander write_pdf whose path is the store', () => {
    expect(denied({ tool_name: `${DC}write_pdf`, tool_input: { path: storeFile }, cwd: '/repo' })).toBe(true);
  });
  it('denies a Write whose path reaches the store through ..', () => {
    expect(denied({ tool_name: 'Write', tool_input: { file_path: 'C:/Users/dkhay/.claude/state/ccv3-mods/x/../decisions.json' }, cwd: '/repo' })).toBe(true);
    expect(denied({ tool_name: 'Write', tool_input: { file_path: `${dir.replace(/\\/g, '/')}/x/../decisions.json` }, cwd: '/repo' })).toBe(true);
  });
  it('allows a Write whose .. path leaves the store folder', () => {
    expect(denied({ tool_name: 'Write', tool_input: { file_path: 'C:/Users/dkhay/.claude/state/ccv3-mods/x/../../notes.txt' }, cwd: '/repo' })).toBe(false);
  });
});

describe('G14 shell text that writes the default store path, with text after the path', () => {
  const DEF = 'C:/Users/dave/.claude/state/ccv3-mods/decisions.json';
  it('denies a write with arguments after the path', () => {
    expect(denied(bash(`cp /tmp/forged.json ${DEF} -f`))).toBe(true);
    expect(denied(bash(`echo '{}' > ${DEF} 2>/dev/null`))).toBe(true);
    expect(denied(pwsh(`Set-Content -Path ${DEF} -Value '{}'`))).toBe(true);
    expect(denied(bash(`echo '{}' > ${DEF}; echo done`))).toBe(true);
  });
  it('denies the $HOME, ~ and %USERPROFILE% spellings', () => {
    expect(denied(bash(`echo '{}' > $HOME/.claude/state/ccv3-mods/decisions.json; echo ok`))).toBe(true);
    expect(denied(bash(`echo '{}' > "$HOME/.claude/state/ccv3-mods/decisions.json" && true`))).toBe(true);
    expect(denied(bash(`echo '{}' > ~/.claude/state/ccv3-mods/decisions.json && true`))).toBe(true);
    expect(denied(pwsh('Set-Content -Path "$HOME\\.claude\\state\\ccv3-mods\\decisions.json" -Value \'{}\''))).toBe(true);
    expect(denied(pwsh('Set-Content -Path "%USERPROFILE%\\.claude\\state\\ccv3-mods\\decisions.json" -Value \'{}\''))).toBe(true);
  });
  it('denies a quoted path with text after it', () => {
    expect(denied(pwsh(`Set-Content -Path 'C:\\Users\\dave\\.claude\\state\\ccv3-mods\\decisions.json' -Value '{}'`))).toBe(true);
    expect(denied(bash(`tee "${DEF}" < /tmp/forged.json`))).toBe(true);
  });
  it('denies a write to the lock file, with text after it', () => {
    expect(denied(bash(`rm -f ${DEF}.lock -v`))).toBe(true);
  });
  it('passes a read, and a file that only starts with the same letters', () => {
    expect(denied(bash(`cat ${DEF} | head -5`))).toBe(false);
    expect(denied(bash(`cp /tmp/a.json ${DEF.replace('decisions.json', 'decisions-old.json')} -f`))).toBe(false);
    expect(denied(bash(`cp /tmp/a.json ${DEF.replace('decisions.json', 'decisions.jsonx')} -f`))).toBe(false);
  });
});

describe('G15 the store path as a tool path: streams, trailing dots and spaces, source, outputPath', () => {
  const write = (file_path: string) => denied({ tool_name: 'Write', tool_input: { file_path }, cwd: '/repo' });
  it('denies a path with ::$DATA or a :stream name', () => {
    expect(write(`${storeFile}::$DATA`)).toBe(true);
    expect(write(`${storeFile}:evil`)).toBe(true);
  });
  it('denies a path with trailing dots or spaces', () => {
    expect(write(`${storeFile} `)).toBe(true);
    expect(write(`${storeFile}.`)).toBe(true);
    expect(write(`${storeFile}. . `)).toBe(true);
  });
  it('denies a move_file whose source is the store', () => {
    expect(denied({ tool_name: `${DC}move_file`, tool_input: { source: storeFile, destination: '/tmp/gone.json' }, cwd: '/repo' })).toBe(true);
  });
  it('denies a write_pdf whose outputPath is the store', () => {
    expect(denied({ tool_name: `${DC}write_pdf`, tool_input: { outputPath: storeFile }, cwd: '/repo' })).toBe(true);
  });
  it('still allows another file, a .. leaf and a stream of another file', () => {
    expect(write(`${dir.replace(/\\/g, '/')}/notes.txt::$DATA`)).toBe(false);
    expect(write(`${dir.replace(/\\/g, '/')}/x/..`)).toBe(false);
    expect(write('/repo/docs/decisions.json ')).toBe(false);
  });
});

describe('G13 the model burns taps from a shell', () => {
  it('denies land-decision.mjs use, in both shells, and passes check', () => {
    expect(denied(bash('node scripts/github/land-decision.mjs use 12 --head ' + HEAD))).toBe(true);
    expect(denied(pwsh('node .\\scripts\\github\\land-decision.mjs use 12 --head ' + HEAD))).toBe(true);
    expect(denied(bash('node scripts/github/land-decision.mjs check 12 --head ' + HEAD))).toBe(false);
  });
  it('denies a loop of pr-checkpoint.mjs --json --pr, and passes one run', () => {
    expect(denied(bash('for i in 1 2 3; do node scripts/github/pr-checkpoint.mjs --json --pr 12; done'))).toBe(true);
    expect(denied(pwsh('1..5 | ForEach-Object { node scripts/github/pr-checkpoint.mjs --json --pr 12 }'))).toBe(true);
    expect(denied(bash('while true; do node scripts/github/pr-checkpoint.mjs --json --pr 12; done'))).toBe(true);
    expect(denied(bash('node scripts/github/pr-checkpoint.mjs --json --pr 12'))).toBe(false);
  });
});

describe('decisions-store reader', () => {
  it('reads the rows the real store writes (a change of the row id breaks this)', () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(decisionRows({ CCV3_DECISIONS_FILE: storeFile })).toEqual([{ step: 'land', key: prKey(12), head: HEAD, label: 'Land now (Recommended)', tree: null }]);
  });

  it('RED-1 reads the tree the offer was bound to (a string), else null', () => {
    tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    const rows = decisionRows({ CCV3_DECISIONS_FILE: storeFile });
    expect(rows.find((r) => r.step === 'ship')?.tree).toBe(TREE);
    expect(rows.find((r) => r.step === 'open-pr')?.tree).toBeNull();
    const raw = JSON.parse(readFileSync(storeFile, 'utf8')) as { decisions: Record<string, { tree?: unknown }> };
    for (const d of Object.values(raw.decisions)) d.tree = 42;
    writeFileSync(storeFile, JSON.stringify(raw));
    expect(decisionRows({ CCV3_DECISIONS_FILE: storeFile }).map((r) => r.tree)).toEqual([null, null]);
  });

  it('reads a store with any section that is not a plain object as empty, like decisions.mjs (fail closed)', () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    const good = JSON.parse(readFileSync(storeFile, 'utf8')) as Record<string, unknown>;
    for (const bad of ['offers', 'misses', 'decisions']) {
      writeFileSync(storeFile, JSON.stringify({ ...good, [bad]: [] }));
      expect(decisionRows({ CCV3_DECISIONS_FILE: storeFile }), bad).toEqual([]);
    }
  });
});

// T19: cd spellings that pre-pr-gate reads since PR #411 (CMD_POS, CD_NAMES, CD_TARGET, UNKNOWN_CD, FD_REDIRECT, endsInPipe) must be read here too.
// A cd that decision-gate cannot see runs the push, create or merge in a folder that is never judged (fail-open). A land reads no folder, so it is not here.
describe('T19 cd spellings: the same reading as pre-pr-gate', () => {
  const O = '/tmp/other-repo';
  const SUB = '/repo/sub';
  const W: World = { otherDirs: [O, SUB] };
  const PUSH = 'git push fork feat/x';
  const C = 'gh pr create --draft --head feat/x --title t --body-file b.md';
  const M = `gh pr merge 12 --merge --match-head-commit ${HEAD}`;
  const SHAPES: [string, string][] = [['push', PUSH], ['create', C], ['merge', M]];
  const cwdsOf = (calls: GitCall[]) => [...new Set(calls.map((c) => c.cwd))];
  const patternOf = (input: object, w: World): string => { const d = decide(input, deps(w)); return d.action === 'deny' ? d.pattern : 'allow'; };
  // Each form moves the shell to /repo (CCv3) from a non-CCv3 cwd: the shape must be judged there, so it is denied.
  const HIDDEN: [string, string][] = [
    ['builtin cd', 'builtin cd /repo && %S'],
    ['command cd', 'command cd /repo && %S'],
    ['chdir', 'chdir /repo && %S'],
    ['cd -P', 'cd -P /repo && %S'],
    ['cd -L', 'cd -L /repo && %S'],
    ['cd --', 'cd -- /repo && %S'],
    ['cd -P --', 'cd -P -- /repo && %S'],
    ['a brace group', '{ cd /repo && %S; }'],
    ['then', 'if true; then cd /repo && %S; fi'],
    ['else', 'if false; then true; else cd /repo && %S; fi'],
    ['do', 'for i in 1; do cd /repo && %S; done'],
    ['builtin cd after then', 'if true; then builtin cd /repo && %S; fi'],
    ['a subshell (not seen by pre-pr-gate either)', '(cd /repo && %S)'],
    ['a command substitution', 'x=$(cd /repo && %S)'],
    ['a backtick', 'x=`cd /repo && %S`'],
  ];
  describe.each(SHAPES)('%s', (_kind, shape) => {
    it.each(HIDDEN)('judges the shape in the folder %s names', (_name, tpl) => {
      const cmd = tpl.replace('%S', shape);
      expect(denied(bash(cmd, { cwd: SUB }), W), cmd).toBe(true);
      const calls: GitCall[] = [];
      decide(bash(cmd, { cwd: SUB }), deps({ ...W, calls }));
      expect(cwdsOf(calls), cmd).toContain('/repo');
      expect(cwdsOf(calls).filter((c) => /-[PL]$|\/--$/.test(c)), cmd).toEqual([]);
    });
    it.each([
      ['Set-Location -Path:', 'Set-Location -Path:/repo; %S'],
      ['Set-Location -Path', 'Set-Location -Path /repo; %S'],
      ['Set-Location -LiteralPath:', 'Set-Location -LiteralPath:/repo; %S'],
      ['Set-Location -PSPath', 'Set-Location -PSPath /repo; %S'],
      ['Push-Location -Path:', 'Push-Location -Path:/repo; %S'],
      ['chdir', 'chdir /repo; %S'],
    ])('judges the shape in the folder PowerShell %s names', (_name, tpl) => {
      const cmd = tpl.replace('%S', shape);
      const calls: GitCall[] = [];
      expect(denied(pwsh(cmd, { cwd: SUB }), { ...W, calls }), cmd).toBe(true);
      expect(cwdsOf(calls), cmd).toContain('/repo');
      expect(cwdsOf(calls).filter((c) => /Path:?\/repo|PSPath/i.test(c)), cmd).toEqual([]);
    });
    it('allows a cd to a non-CCv3 folder in each new spelling', () => {
      for (const tpl of ['builtin cd', 'command cd', 'chdir', 'cd -P', 'cd --', '{ cd']) {
        const cmd = `${tpl} ${O} && ${shape}${tpl === '{ cd' ? '; }' : ''}`;
        expect(denied(bash(cmd, { cwd: SUB }), W), cmd).toBe(false);
      }
    });
    // A cd after a pipe (|, ||, |&, with or without comment lines between) may be skipped or run in a pipe subshell: the cwd is judged too.
    it.each([
      ['|&', `echo x |& cd ${O} && %S`],
      ['| and a comment line', `echo x |\n# note\ncd ${O} && %S`],
      ['| and two comment lines', `echo x |\n# one\n# two\ncd ${O} && %S`],
      ['|& and a comment line, builtin cd', `echo x |&\n# note\nbuiltin cd ${O} && %S`],
      ['|| and a comment line', `false ||\n# note\ncd ${O} && %S`],
      ['| and chdir', `echo x | chdir ${O} && %S`],
    ])('judges the cwd too when the cd follows %s', (_name, tpl) => {
      const cmd = tpl.replace('%S', shape);
      expect(denied(bash(cmd), W), cmd).toBe(true);
    });
    // A cd in a subshell does not last past the `)`: the shape after it runs in the cwd. It must not be judged in the cd folder alone.
    it.each([
      ['a subshell closed before the shape', `(cd ${O}) && %S`],
      ['a command substitution closed before the shape', `x=$(cd ${O}) && %S`],
    ])('judges the cwd too after %s', (_name, tpl) => {
      const cmd = tpl.replace('%S', shape);
      expect(denied(bash(cmd), W), cmd).toBe(true);
    });
    it('a comment line after && does not make the cd loose', () => {
      const cmd = `echo x &&\n# note\ncd ${O} && ${shape}`;
      expect(denied(bash(cmd), W), cmd).toBe(false);
    });
    it('does not read the & of an fd redirect as a joiner', () => {
      for (const cmd of [`cd ${O} 2>&1 && ${shape}`, `cd ${O} && npm test 2>&1 && ${shape}`, `cd ${O} &>/dev/null && ${shape}`, `cd ${O} && npm test >&2 && ${shape}`]) {
        expect(denied(bash(cmd), W), cmd).toBe(false);
      }
    });
    it.each([
      ['a pipe after the redirect', `cd ${O} && npm test 2>&1 | tail && %S`],
      ['a ; after the redirect', `cd ${O} && npm test 2>&1; %S`],
      ['a lone & after the cd', `cd ${O} & %S`],
    ])('still judges the cwd when %s', (_name, tpl) => {
      const cmd = tpl.replace('%S', shape);
      expect(denied(bash(cmd), W), cmd).toBe(true);
    });
  });

  // A bare cd form goes home: the folder is unknown. Denied as position-unknown when a CCv3 folder is on the path, even with a tap.
  describe('an unknown position', () => {
    const UNKNOWN: [string, string][] = [
      ['chdir', `cd ${O} && chdir && %S`],
      ['builtin cd', `cd ${O} && builtin cd && %S`],
      ['command cd', `cd ${O} && command cd && %S`],
      ['cd -P', `cd ${O} && cd -P && %S`],
      ['cd --', `cd ${O} && cd -- && %S`],
      ['cd -P -', `cd ${O} && cd -P - && %S`],
      ['a bare cd after {', `cd ${O} && { cd; %S; }`],
      ['a bare cd after then', `cd ${O} && if true; then cd; %S; fi`],
      ['a bare cd after do', `cd ${O} && for i in 1; do cd; %S; done`],
    ];
    describe.each(SHAPES)('%s', (_kind, shape) => {
      it.each(UNKNOWN)('denies %s as position-unknown', (_name, tpl) => {
        const cmd = tpl.replace('%S', shape);
        expect(patternOf(bash(cmd), W), cmd).toBe('position-unknown');
      });
      it('a tap does not lift it', () => {
        tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
        tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
        tap('land', prKey(12), HEAD, 'Land now (Recommended)');
        const cmd = `cd ${O} && chdir && ${shape}`;
        expect(patternOf(bash(cmd), W), cmd).toBe('position-unknown');
      });
      it('passes when no folder on the path is CCv3', () => {
        for (const cmd of [`chdir && ${shape}`, `builtin cd && ${shape}`, `cd -P && ${shape}`, `cd ${O} && chdir && ${shape}`]) {
          expect(denied(bash(cmd, { cwd: SUB }), W), cmd).toBe(false);
        }
      });
    });
    it('denies the PowerShell bare forms', () => {
      for (const cmd of [`Set-Location ${O}; chdir; ${PUSH}`, `Set-Location ${O}; sl; ${PUSH}`, `Set-Location ${O}; Set-Location; ${PUSH}`]) {
        expect(patternOf(pwsh(cmd), W), cmd).toBe('position-unknown');
      }
    });
  });
});

// T20 (round 2 of the cd parity lane): a cd that is not at a command position must not hide the cwd; a cd that never moves the parent shell
// (a job, a parallel block) must not count as a sure cd; more bash command positions; a partly quoted target; more PowerShell spellings.
describe('T20 cd positions, scriptblocks and targets', () => {
  const O = '/tmp/other-repo';
  const OSP = '/tmp/other repo';
  const SUB = '/repo/sub';
  const W: World = { otherDirs: [O, SUB, OSP, O + '/'] };
  const PUSH = 'git push fork feat/x';
  const C = 'gh pr create --draft --head feat/x --title t --body-file b.md';
  const M = `gh pr merge 12 --merge --match-head-commit ${HEAD}`;
  const SHAPES: [string, string][] = [['push', PUSH], ['create', C], ['merge', M]];
  const fill = (tpl: string, shape: string): string => tpl.replaceAll('%O', O).replaceAll('%S', shape);

  describe.each(SHAPES)('%s', (_kind, shape) => {
    // These words are no command position: nothing moves the shell, so the shape runs in the CCv3 cwd (/repo) and is judged there.
    it.each([
      ['echo then cd', 'echo then cd %O && %S'],
      ['echo else cd', 'echo else cd %O && %S'],
      ['echo do cd', 'echo do cd %O && %S'],
      ['echo { cd', 'echo { cd %O && %S'],
      ['echo x{ cd', 'echo x{ cd %O && %S'],
      ['git log do cd', 'git log -1 --format=x do cd %O && %S'],
    ])('judges the cwd when %s is no command', (_name, tpl) => {
      expect(denied(bash(fill(tpl, shape)), W), fill(tpl, shape)).toBe(true);
    });
    it.each([
      ['Write-Output then cd', 'Write-Output then cd %O && %S'],
      ['Write-Output { cd', 'Write-Output { cd %O && %S'],
    ])('judges the cwd when PowerShell %s is no command', (_name, tpl) => {
      expect(denied(pwsh(fill(tpl, shape)), W), fill(tpl, shape)).toBe(true);
    });
    // A job or a parallel block runs its cd in another runspace: the parent shell stays in the cwd, so the cwd is judged.
    it.each([
      ['Start-Job', 'Start-Job { Set-Location %O } && %S'],
      ['Start-Job -ScriptBlock', 'Start-Job -ScriptBlock { Set-Location %O } && %S'],
      ['Start-ThreadJob', 'Start-ThreadJob { Set-Location %O } && %S'],
      ['ForEach-Object -Parallel', '1 | ForEach-Object -Parallel { Set-Location %O } && %S'],
      ['pwsh -Command', 'pwsh -NoProfile -Command { Set-Location %O } && %S'],
      ['a cd after a ; in the job', 'Start-Job { Write-Host hi; Set-Location %O } && %S'],
      ['a cd in a nested block of the job', 'Start-Job { if ($true) { Set-Location %O } } && %S'],
    ])('judges the cwd when the cd is inside %s', (_name, tpl) => {
      expect(denied(pwsh(fill(tpl, shape)), W), fill(tpl, shape)).toBe(true);
    });
    // The scriptblock of & and Invoke-Command runs in the current session: the location stays. Pinned (the round-1 change stays).
    it.each([
      ['& {', '& { Set-Location %O } && %S'],
      ['Invoke-Command {', 'Invoke-Command { Set-Location %O } && %S'],
    ])('does not judge the cwd after %s } moved the location', (_name, tpl) => {
      expect(denied(pwsh(fill(tpl, shape)), W), fill(tpl, shape)).toBe(false);
    });
    // Invoke-Command names its target AFTER the block: the cd runs on another computer, in a session or as a job, and the local shell stays in the cwd.
    it.each([
      ['-ComputerName', 'Invoke-Command { Set-Location %O } -ComputerName localhost && %S'],
      ['-Session', 'Invoke-Command { Set-Location %O } -Session $s && %S'],
      ['-AsJob', 'Invoke-Command { Set-Location %O } -AsJob && %S'],
      ['-ScriptBlock and -ComputerName', 'icm -ScriptBlock { Set-Location %O } -ComputerName srv && %S'],
    ])('judges the cwd when Invoke-Command runs the cd with %s', (_name, tpl) => {
      expect(denied(pwsh(fill(tpl, shape)), W), fill(tpl, shape)).toBe(true);
    });
    // A parameter alias or a prefix after the block (-cn, -Comp, -CU, -VMGuid) also names another place: any parameter after the block counts (CodeRabbit CLI, 816013a).
    it.each([
      ['-cn alias', 'icm { Set-Location %O } -cn srv && %S'],
      ['-Comp prefix', 'Invoke-Command { Set-Location %O } -Comp srv && %S'],
      ['-CU alias', 'icm { Set-Location %O } -CU http://srv && %S'],
      ['-VMGuid', 'icm { Set-Location %O } -VMGuid $g && %S'],
    ])('judges the cwd when Invoke-Command runs the cd with %s', (_name, tpl) => {
      expect(denied(pwsh(fill(tpl, shape)), W), fill(tpl, shape)).toBe(true);
    });
    // In PowerShell a backslash is no escape: a quoted folder may end in one, and a quote inside the other kind of quote is a letter of the name.
    it.each([
      ['a double-quoted folder with a trailing backslash', 'Set-Location "%O\\" && %S'],
      ['a single-quoted folder with a trailing backslash', "Set-Location '%O\\' && %S"],
    ])('reads %s as the folder', (_name, tpl) => {
      expect(denied(pwsh(fill(tpl, shape), { cwd: SUB }), W), fill(tpl, shape)).toBe(false);
    });
    // The closing ) or backtick of a subshell is no part of the folder.
    it.each([
      ['a subshell', '(cd %O) && %S'],
      ['a command substitution', 'x=$(cd %O) && %S'],
      ['a backtick', 'x=`cd %O` && %S'],
    ])('reads the folder of %s without the closing mark', (_name, tpl) => {
      expect(denied(bash(fill(tpl, shape), { cwd: SUB }), W), fill(tpl, shape)).toBe(false);
    });
    // Bash command positions: the cd after if, while, until, elif, !, time, a variable prefix, a backslash, a wrapper chain, eval, a case pattern.
    it.each([
      ['if', 'if cd /repo; then %S; fi'],
      ['if and &&', 'if cd /repo && %S; then :; fi'],
      ['while', 'while cd /repo && %S; do break; done'],
      ['until', 'until cd /repo; do :; done; %S'],
      ['elif', 'if false; then :; elif cd /repo && %S; then :; fi'],
      ['!', '! cd /repo || %S'],
      ['a case pattern', 'case x in x) cd /repo && %S;; esac'],
      ['a variable prefix', 'X=1 cd /repo && %S'],
      ['time', 'time cd /repo && %S'],
      ['a backslash', '\\cd /repo && %S'],
      ['command builtin', 'command builtin cd /repo && %S'],
      ['builtin command', 'builtin command cd /repo && %S'],
      ['eval', 'eval cd /repo && %S'],
    ])('judges the shape in the folder a cd names after %s', (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(denied(bash(cmd, { cwd: SUB }), W), cmd).toBe(true);
    });
    it.each([
      ['a variable prefix', 'X=1 cd %O && %S'],
      ['time', 'time cd %O && %S'],
      ['a backslash', '\\cd %O && %S'],
      ['command builtin', 'command builtin cd %O && %S'],
      ['eval', 'eval cd %O && %S'],
    ])('sees the cd after %s, so a cd to a non-CCv3 folder passes', (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(denied(bash(cmd), W), cmd).toBe(false);
    });
    // A target that is partly quoted or has an escaped space is one folder.
    it.each([
      ['a quoted tail', 'cd /tmp/"other-repo" && %S'],
      ['a single-quoted tail', "cd /tmp/'other-repo' && %S"],
      ['a quoted head', "cd '/tmp'/other-repo && %S"],
      ['an escaped space', 'cd /tmp/other\\ repo && %S'],
      ['a quoted space', 'cd "/tmp/other repo" && %S'],
    ])('reads %s as the whole folder', (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(denied(bash(cmd), W), cmd).toBe(false);
    });
    it.each([
      ['a comment block', '<# note #> Set-Location /repo; %S'],
      ['an assignment', '$null = Set-Location /repo; %S'],
      ['a module name', 'Microsoft.PowerShell.Management\\Set-Location /repo; %S'],
    ])('judges the shape in the folder PowerShell names after %s', (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(denied(pwsh(cmd, { cwd: SUB }), W), cmd).toBe(true);
    });
    // Accepted over-deny, pinned: the target is a shell variable, so the folder is the literal `$d`. It fails closed: here the fake git reads
    // it as a CCv3 folder (tap deny); the real hook finds no such folder and denies as unjudgeable.
    it('denies a cd to a shell variable (accepted over-deny, fails closed)', () => {
      const cmd = fill('for d in %O; do cd $d && %S; done', shape);
      expect(denied(bash(cmd, { cwd: SUB }), W), cmd).toBe(true);
    });
  });
});
