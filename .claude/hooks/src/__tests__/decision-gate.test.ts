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
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionRecord, decisionRows, offerWrite, type Step } from '../shared/decisions-store.js';
import { COMMAND_TOOLS, WRITE_TOOLS, decide, handle, type Deps } from '../decision-gate.js';

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
  /** What `git remote get-url <name>` answers for a remote other than fork (default: it fails). */
  remoteUrls?: Record<string, string>;
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
      if (a === 'remote -v') return { status: 0, stdout: `fork\t${w.remote ?? `https://github.com/${REPO}.git`} (push)\n` };
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
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
      for (const label of ['Show the diff first', 'Stop here', 'Do not Commit and push', 'Push only']) {
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
