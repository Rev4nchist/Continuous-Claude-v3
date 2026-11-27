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
import { decideParsed, handleParsed } from './helpers/parse-first.js';
import './helpers/walker-timeout.js'; // C2c: the long test timeout, scoped to the files that start a pwsh walker

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
    // The router config sits in /repo and in the other (plain) repo of T22, so a command run from either folder is enforced.
    readFile: (p) => (['/repo/review-router.config.json', '/tmp/other-repo/review-router.config.json'].includes(p.replace(/\\/g, '/')) ? config : null),
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
const denied = async (input: object, w?: World) => (await decideParsed(input, deps(w))).action === 'deny';
const reasonOf = async (input: object, w?: World): Promise<string> => { const d = await decideParsed(input, deps(w)); return d.action === 'deny' ? d.reason : ''; };

const CREATE = `gh api repos/${REPO}/pulls -X POST -F draft=true -F head=feat/x -F base=main -F body=@b.md -F title=t`;
const branchKey = (b = 'feat/x') => `${REPO}@${b}`;
const prKey = (n: number) => `${REPO}#${n}`;

describe('G1 PR create', () => {
  it('denies a create with no open-pr decision, and the reason names the question to ask', async () => {
    const r = await reasonOf(bash(CREATE));
    expect(r).toContain('BLOCKED (decision-gate)');
    expect(r).toContain('ship-ask.mjs open-pr --branch feat/x');
    expect(r).toContain('AskUserQuestion');
  });
  it('denies gh pr create too, in both shells', async () => {
    expect(await denied(bash('gh pr create --draft --head feat/x --title t --body-file b.md'))).toBe(true);
    expect(await denied(pwsh('gh pr create --draft --title t --body-file b.md'))).toBe(true);
  });
  it('allows the create after Open draft PR for this branch and head', async () => {
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    expect(await denied(bash(CREATE))).toBe(false);
  });
  it('denies when the tap was another label (Show the PR body first, Stop here, a re-run)', async () => {
    for (const label of ['Show the PR body first', 'Stop here', 'Re-run pre-pr (up to $3.00 CLI) (Recommended)']) {
      tap('open-pr', branchKey(), HEAD, label);
      expect(await denied(bash(CREATE)), label).toBe(true);
    }
  });
  it('denies when the tap is for an earlier head (the branch moved)', async () => {
    tap('open-pr', branchKey(), OTHER, 'Open draft PR (Recommended)');
    expect(await denied(bash(CREATE))).toBe(true);
  });
  it('denies when the tap is for another branch', async () => {
    tap('open-pr', branchKey('feat/y'), HEAD, 'Open draft PR (Recommended)');
    expect(await denied(bash(CREATE))).toBe(true);
  });
  it('reads the branch from the current branch when the command names none', async () => {
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    expect(await denied(bash('gh pr create --draft --title t --body-file b.md'))).toBe(false);
  });
});

/**
 * C2c (closed world): a text that names a create or a merge may run listed programs only. These cd-position rows put a program that is not on the lists (npm, Invoke-Command,
 * Start-Job, a call operator block, alias, an escaped command word such as \cd) before the shape, so a create or a merge there is denied (not-inert). A named cost of the closed world,
 * counted in the corpus of the PR. A push shape has its own reader and is not affected.
 */
const closedWorldCost = (cmd: string, shape: string): boolean => /gh pr (?:create|merge)/.test(shape) && /(?:^|[\s;&|(])(?:npm|Invoke-Command|Start-Job|alias|Set-Alias)\b|&\s*\{|(?:^|[\s;&|(])(?:\\cd|c\\d)\b|(?:^|[\s;&|(])(?!(?:NO_COLOR|CLICOLOR|CI|TERM|LANG|LC_\w+|TZ|GH_PROMPT_DISABLED|GH_NO_UPDATE_NOTIFIER|GH_SPINNER_DISABLED)=)[A-Za-z_]\w*=\S*\s+cd\b/.test(cmd); // C2d: a prefix of a name outside the safe env names (X=1 cd) is off the lists

describe('G2 land and merge', () => {
  const LAND = 'pwsh -File scripts/github/land-pr.ps1 -Pr 12';
  it('denies land-pr.ps1 with no land decision, and names the question', async () => {
    const r = await reasonOf(bash(LAND));
    expect(r).toContain('ship-ask.mjs land --pr 12');
    expect(r).toContain('-CleanupOnly');
  });
  it('allows after Land now, or Land when READY, for that PR', async () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(await denied(bash(LAND))).toBe(false);
    rmSync(storeFile);
    tap('land', prKey(12), HEAD, 'Land when READY (Recommended)');
    expect(await denied(pwsh(LAND))).toBe(false);
  });
  it('denies after Keep open or Return to draft', async () => {
    for (const label of ['Keep open', 'Return to draft']) {
      tap('land', prKey(12), HEAD, label);
      expect(await denied(bash(LAND)), label).toBe(true);
    }
  });
  it('denies a decision for another PR', async () => {
    tap('land', prKey(13), HEAD, 'Land now (Recommended)');
    expect(await denied(bash(LAND))).toBe(true);
  });
  it('reads -Pr in the short and colon forms', async () => {
    expect(await denied(pwsh('.\\scripts\\github\\land-pr.ps1 -P 12'))).toBe(true);
    expect(await denied(pwsh('.\\scripts\\github\\land-pr.ps1 -Pr:12 -Method squash'))).toBe(true);
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(await denied(pwsh('.\\scripts\\github\\land-pr.ps1 -Pr:12 -Method squash'))).toBe(false);
  });
  it('lets -CleanupOnly through (it never merges, and the tap is used up after the merge)', async () => {
    expect(await denied(bash(`${LAND} -CleanupOnly`))).toBe(false);
  });
  it('denies gh pr merge and gh api .../merge with no land decision', async () => {
    expect(await denied(bash('gh pr merge 12 --merge'))).toBe(true);
    expect(await denied(bash(`gh api repos/${REPO}/pulls/12/merge -X PUT -f merge_method=merge`))).toBe(true);
  });
  it('a raw merge passes only with the tapped head in the text (sha= or --match-head-commit)', async () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(await denied(bash(`gh api repos/${REPO}/pulls/12/merge -X PUT -f sha=${HEAD}`))).toBe(false);
    expect(await denied(bash(`gh pr merge 12 --merge --match-head-commit ${HEAD}`))).toBe(false);
    expect(await denied(bash(`gh api repos/${REPO}/pulls/12/merge -X PUT -f sha=${OTHER}`))).toBe(true);
    expect(await denied(bash(`gh pr merge 12 --merge --match-head-commit ${OTHER}`))).toBe(true);
  });
  it('a raw merge with no head is denied even with a tap on record: the tap may be for an older head', async () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(await reasonOf(bash('gh pr merge 12 --merge'))).toContain('land-pr.ps1 -Pr 12');
    expect(await denied(bash(`gh api repos/${REPO}/pulls/12/merge -X PUT -f merge_method=merge`))).toBe(true);
  });
  it('reads a merge endpoint with GET as a read', async () => {
    expect(await denied(bash(`gh api repos/${REPO}/pulls/12/merge -X GET`))).toBe(false);
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
    ])('denies %s with no tap (Bash and PowerShell)', async (cmd) => {
      expect(await denied(bash(cmd)), `bash: ${cmd}`).toBe(true);
      expect(await denied(pwsh(cmd)), `pwsh: ${cmd}`).toBe(true);
    });
    it('names the question to ask and the rule to follow in the reason', async () => {
      const r = await reasonOf(bash(PUSH));
      expect(r).toContain('BLOCKED (decision-gate)');
      expect(r).toContain('ship-ask.mjs commit-and-push --branch feat/x --json');
      expect(r).toContain('AskUserQuestion');
      expect(r).toContain('Commit and push');
      expect(r).toContain('Push only');
      expect(r).toContain('bare commit && push');
      expect(r).toContain('no redirect');
    });
    it('reads the Desktop Commander process tools', async () => {
      expect(await denied({ tool_name: `${DC}start_process`, tool_input: { command: PUSH }, cwd: '/repo' })).toBe(true);
      expect(await denied({ tool_name: `${DC}interact_with_process`, tool_input: { pid: 1, input: PUSH }, cwd: '/repo' })).toBe(true);
    });
  });

  describe('RED-4 and RED-5 the tap is bound to the tree and the branch, not the head', () => {
    it('allows after Commit and push for this branch and the tree being pushed', async () => {
      shipTap();
      expect(await denied(bash(PUSH))).toBe(false);
      expect(await denied(pwsh('pwsh -File scripts/git-safe.ps1 push fork feat/x'))).toBe(false);
    });
    it('allows when the tap is for an OLD head and the tree matches (the commit moved the head after the tap)', async () => {
      shipTap('feat/x', TREE, OTHER);
      expect(await denied(bash(PUSH))).toBe(false);
    });
    it('denies when the tree differs from the tapped tree', async () => {
      shipTap('feat/x', TREE2);
      expect(await denied(bash(PUSH))).toBe(true);
    });
    it('denies when the tap was another label', async () => {
      for (const label of ['Show the diff first', 'Stop here', 'Do not Commit and push', 'Do not Push only']) {
        rmSync(storeFile, { force: true });
        shipTap('feat/x', TREE, HEAD, label);
        expect(await denied(bash(PUSH)), label).toBe(true);
      }
    });
    it('denies when the tap is for another branch key', async () => {
      shipTap('feat/y');
      expect(await denied(bash(PUSH))).toBe(true);
    });
    it('denies when the tap has no tree on record (null)', async () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)');
      expect(await denied(bash(PUSH))).toBe(true);
    });
    it('denies when the only tap is of another step', async () => {
      tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)', TREE);
      expect(await denied(bash(PUSH))).toBe(true);
    });
    it('allows when ANY recorded row matches: an older tap for another tree does not hide a good one', async () => {
      shipTap('feat/x', TREE2, OTHER);
      shipTap('feat/x', TREE, HEAD);
      expect(await denied(bash(PUSH))).toBe(false);
    });
  });

  // Push only: nothing is staged, the tap binds HEAD^{tree}. It licenses a plain push of that tree. It never licenses a push that
  // follows a commit in the same command, because that push sends the index tree (viaIndex), which the tap did not bind.
  describe('RED-14 "Push only" licenses a plain push of the tapped tree, never a chained commit and push', () => {
    const PO = 'Push only (Recommended)';
    const PUSHB = 'git push fork feat/x';
    const COMMIT = 'git commit -F m.txt';
    const INDEX = 'i'.repeat(40);
    it('G-PO1: allows a plain push after Push only for this branch and the HEAD tree', async () => {
      shipTap('feat/x', TREE, HEAD, PO);
      expect(await denied(bash(PUSH))).toBe(false);
      expect(await denied(pwsh('pwsh -File scripts/git-safe.ps1 push fork feat/x'))).toBe(false);
    });
    it('G-PO1b: the plain label without (Recommended) works too', async () => {
      shipTap('feat/x', TREE, HEAD, 'Push only');
      expect(await denied(bash(PUSH))).toBe(false);
    });
    it('G-PO2: denies when the tapped tree is not the tree being pushed', async () => {
      shipTap('feat/x', TREE2, HEAD, PO);
      expect(await denied(bash(PUSH))).toBe(true);
    });
    it('G-PO3: denies when the tap is for another branch key', async () => {
      shipTap('feat/y', TREE, HEAD, PO);
      expect(await denied(bash(PUSH))).toBe(true);
    });
    it('G-PO4: denies a label that only starts like Push only', async () => {
      for (const label of ['Push only now', 'Push only (Recommended) please', 'Do not Push only', 'push only']) {
        rmSync(storeFile, { force: true });
        shipTap('feat/x', TREE, HEAD, label);
        expect(await denied(bash(PUSH)), label).toBe(true);
      }
    });
    it('G-PO5: denies a commit chained before the push, when the tap tree is the index tree', async () => {
      shipTap('feat/x', INDEX, HEAD, PO);
      expect(await denied(bash(`${COMMIT} && ${PUSHB}`), { indexTree: INDEX })).toBe(true);
      expect(await reasonOf(bash(`${COMMIT} && ${PUSHB}`), { indexTree: INDEX })).toContain('Push only');
    });
    it('G-PO6: denies the chained form even when the tap tree equals both the HEAD tree and the index tree', async () => {
      shipTap('feat/x', TREE, HEAD, PO);
      expect(await denied(bash(`${COMMIT} && ${PUSHB}`), { indexTree: TREE })).toBe(true);
    });
    it('G-PO6b: Commit and push still allows the chained form (the new rule does not weaken it)', async () => {
      shipTap('feat/x', INDEX, HEAD, 'Commit and push (Recommended)');
      expect(await denied(bash(`${COMMIT} && ${PUSHB}`), { indexTree: INDEX })).toBe(false);
    });
    // The HEAD tree is read before any commit in the command runs. A Push only tap equals that tree, so a command that stages or commits
    // and then pushes, in a form the chained-commit rule does not recognise, would send a new tree the tap never bound. Fail closed.
    it('G-PO8: denies add, commit and push in one command (a form the chained rule does not accept)', async () => {
      shipTap('feat/x', TREE, HEAD, PO);
      expect(await denied(bash(`git add f.txt && ${COMMIT} && ${PUSHB}`))).toBe(true);
    });
    it('G-PO9: denies a commit and a push joined by ; , a newline or ||', async () => {
      shipTap('feat/x', TREE, HEAD, PO);
      for (const join of ['; ', '\n', ' || ']) expect(await denied(bash(`${COMMIT}${join}${PUSHB}`)), JSON.stringify(join)).toBe(true);
    });
    it('G-PO10: denies a push with an output redirect or a trailing command (only a bare push is licensed)', async () => {
      shipTap('feat/x', TREE, HEAD, PO);
      expect(await denied(bash(`${PUSHB} > out.txt 2>&1`))).toBe(true);
      expect(await denied(bash(`${PUSHB}; echo done`))).toBe(true);
      expect(await denied(bash(`${PUSHB} | tail -3`))).toBe(true);
    });
    it('G-PO11: still allows a bare push after a cd or a read-only git call', async () => {
      shipTap('feat/x', TREE, HEAD, PO);
      expect(await denied(bash(`cd /tmp/repo && ${PUSHB}`))).toBe(false);
      expect(await denied(bash(`git status && ${PUSHB}`))).toBe(false);
    });
    it('G-PO7: a Push only tap never licenses a force, origin or subagent push', async () => {
      shipTap('feat/x', TREE, HEAD, PO);
      expect(await denied(bash('git push --force fork feat/x'))).toBe(true);
      expect(await denied(bash('git push origin feat/x'))).toBe(true);
      expect(await denied(bash(PUSH, { agent_id: 'sub-1' }))).toBe(true);
    });
  });

  describe('RED-6 the refspec names the branch and the tree to check', () => {
    it('reads the destination, else the source, else the current branch', async () => {
      shipTap('feat/y');
      const w = { trees: { HEAD: TREE, 'feat/x': TREE, 'feat/y': TREE } };
      expect(await denied(bash('git push fork HEAD:feat/y'), w)).toBe(false);
      expect(await denied(bash('git push fork HEAD:refs/heads/feat/y'), w)).toBe(false);
      expect(await denied(bash('git push fork feat/x:feat/y'), w)).toBe(false);
      expect(await denied(bash('git push fork feat/y'), w)).toBe(false);
      expect(await denied(bash('git push fork refs/heads/feat/y'), w)).toBe(false);
      expect(await denied(bash('git push fork HEAD:feat/z'), w)).toBe(true);
      expect(await denied(bash('git push fork'), w)).toBe(true); // the current branch is feat/x: no tap for it
      expect(await denied(bash('git push fork'), { ...w, branch: 'feat/y' })).toBe(false);
      expect(await denied(bash('git push fork HEAD'), { ...w, branch: 'feat/y' })).toBe(false);
      expect(await denied(bash('git push'), { ...w, branch: 'feat/y' })).toBe(false); // no remote: @{push} fails, treated as the fork
    });
    it('checks the tree of the SOURCE ref', async () => {
      shipTap('feat/z', TREE2);
      const w = { trees: { HEAD: TREE, 'feat/x': TREE2 } };
      expect(await denied(bash('git push fork feat/x:feat/z'), w)).toBe(false);
      expect(await denied(bash('git push fork HEAD:feat/z'), w)).toBe(true);
    });
    it('judges every refspec of one push', async () => {
      shipTap('feat/x');
      const w = { trees: { HEAD: TREE, 'feat/x': TREE, 'feat/y': TREE } };
      expect(await denied(bash('git push fork feat/x feat/y'), w)).toBe(true);
      shipTap('feat/y');
      expect(await denied(bash('git push fork feat/x feat/y'), w)).toBe(false);
    });
    it('skips option values: --repo, -o and --receive-pack take the next word', async () => {
      shipTap();
      expect(await denied(bash('git push -o ci.skip --receive-pack=x fork feat/x'))).toBe(false);
      expect(await denied(bash('git push -o ci.skip fork feat/y'))).toBe(true);
    });
    it('denies when the tree of the source cannot be read', async () => {
      shipTap();
      expect(await reasonOf(bash('git push fork nosuch:feat/x'))).toContain('tree');
    });
    it('uses @{push} for the remote when none is named: an origin upstream is a push to origin', async () => {
      expect(await denied(bash('git push'), { pushRef: 'origin/feat/x' })).toBe(true);
      shipTap();
      expect(await denied(bash('git push'), { pushRef: 'fork/feat/x' })).toBe(false);
    });
    it('denies a detached HEAD with no refspec (the branch cannot be named)', async () => {
      expect(await reasonOf(bash('git push fork'), { branch: '' })).toContain('branch');
    });
    it('denies a git option that moves the repo (--git-dir, --work-tree): the checkout cannot be known', async () => {
      shipTap();
      expect(await denied(bash('git --git-dir=/other/.git push fork feat/x'))).toBe(true);
      expect(await denied(bash('git --work-tree /other push fork feat/x'))).toBe(true);
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
    ])('passes %s', async (cmd) => {
      expect(await denied(bash(cmd)), cmd).toBe(false);
      expect(await denied(pwsh(cmd)), cmd).toBe(false);
      expect(await handleParsed(JSON.stringify(bash(cmd)), deps())).toBe('{}');
    });
    // Round 3 C3 (seat Q1, 2026-11-15): the raw verb reader counts the git push after echo as a push no shape reads (a covered app folder
    // already took the tap path). In a CCv3 root that is now a hard push-target-unresolved: an accepted over-deny (0 of 588 pushes in 7 days).
    it('denies echo git push fork feat/x hard (round 3 C3: a push no shape reads, an accepted over-deny)', async () => {
      expect(await handleParsed(JSON.stringify(bash('echo git push fork feat/x')), deps())).toContain('"permissionDecision":"deny"');
    });
    it('passes a push in a checkout that is not CCv3', async () => {
      expect(await denied(bash(PUSH), { remote: 'https://github.com/someone/else.git' })).toBe(false);
      expect(await denied(bash('git push origin main'), { remote: 'https://github.com/someone/else.git' })).toBe(false);
      expect(await denied(bash('git push --force fork feat/x'), { remote: 'https://github.com/someone/else.git' })).toBe(false);
    });
    it('passes a push in the same text where the first segment is a different tool', async () => {
      expect(await denied(bash('echo done; git stash push -m x'))).toBe(false);
    });
  });

  describe('D4 a push to origin from a CCv3 checkout is denied, even with a tap', () => {
    it('denies origin with any branch, with and without a tap', async () => {
      shipTap();
      for (const cmd of ['git push origin feat/x', 'git push origin main', 'git push origin', 'git push -u origin HEAD:feat/x', 'git push https://github.com/parcadei/continuous-claude.git feat/x']) {
        expect(await denied(bash(cmd)), cmd).toBe(true);
      }
      expect(await reasonOf(bash('git push origin main'))).toContain('origin');
    });
    it('reads a remote under another name by the URL it points at', async () => {
      const FORK_URL = `https://github.com/${REPO}.git`;
      expect(await denied(bash('git push rev4 feat/x'), { remoteUrls: { rev4: FORK_URL } })).toBe(true); // the fork under another name needs the tap
      expect(await reasonOf(bash('git push rev4 feat/x'), { remoteUrls: { rev4: FORK_URL } })).toContain('ship-ask.mjs');
      expect(await reasonOf(bash('git push up main'), { remoteUrls: { up: 'git@github.com:parcadei/continuous-claude.git' } })).toContain('origin');
      expect(await denied(bash('git push other feat/x'), { remoteUrls: { other: 'https://github.com/someone/else.git' } })).toBe(false);
      expect(await denied(bash('git push other feat/x'))).toBe(false); // get-url fails: not ours
      shipTap();
      expect(await denied(bash('git push rev4 feat/x'), { remoteUrls: { rev4: FORK_URL } })).toBe(false);
    });
    it('reads an upstream that @{push} names under another name the same way', async () => {
      expect(await denied(bash('git push'), { pushRef: 'rev4/feat/x', remoteUrls: { rev4: `https://github.com/${REPO}.git` } })).toBe(true);
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
    ])('denies %s', async (cmd) => {
      shipTap();
      shipTap('main');
      expect(await denied(bash(cmd)), cmd).toBe(true);
      expect(await reasonOf(bash(cmd)), cmd).toMatch(/force|delete|rewrit/i);
    });
    it('denies the unsafe push of a chain even when the plain push before it has its tap', async () => {
      shipTap();
      expect(await denied(bash(`${PUSH}; git push -f fork feat/x`))).toBe(true);
      expect(await denied(bash(`git push -f fork feat/x; ${PUSH}`))).toBe(true);
    });
    // Round 3 C3 (seat Q1, 2026-11-15): this row pinned the allow of a force dry run, which no push shape reads (quiet). The raw rule
    // reads a force word in a push it cannot read: in a CCv3 root that is now a hard push-target-unresolved (accepted over-deny, 0 of 588
    // measured). A plain dry run still passes (RED-7).
    it('denies a dry run of a force push hard (round 3 C3: no shape reads it)', async () => {
      expect(await handleParsed(JSON.stringify(bash('git push --dry-run --force fork feat/x')), deps())).toContain('"permissionDecision":"deny"');
    });
  });

  describe('RED-11 a chained command is judged one segment at a time', () => {
    it('denies two pushes when only the first has a tap, and names the second', async () => {
      shipTap();
      const r = await reasonOf(bash(`${PUSH} && git push fork feat/y`), { trees: { HEAD: TREE, 'feat/x': TREE, 'feat/y': TREE } });
      expect(r).toContain('feat/y');
    });
    it('allows both when each branch has its tap', async () => {
      shipTap();
      shipTap('feat/y');
      const w = { trees: { HEAD: TREE, 'feat/x': TREE, 'feat/y': TREE } };
      expect(await denied(bash(`${PUSH}; git push fork feat/y`), w)).toBe(false);
      expect(await denied(bash(`${PUSH}\ngit push fork feat/y`), w)).toBe(false);
    });
    it('judges a push after a passing push-like segment', async () => {
      expect(await denied(bash(`git stash push && ${PUSH}`))).toBe(true);
    });
  });

  describe('RED-12 there is no override', () => {
    it('a SKIP_ assignment, or a SKIP_ value in the env, lets nothing through', async () => {
      for (const cmd of [`SKIP_DECISION_GATE=1 ${PUSH}`, `$env:SKIP_DECISION_GATE='1'; ${PUSH}`, `SKIP_PRE_PR_GATE=1 SKIP_PUSH_GATE=1 ${PUSH}`]) {
        expect(await denied(bash(cmd)), cmd).toBe(true);
      }
      const d = { ...deps(), env: { ...deps().env, SKIP_DECISION_GATE: '1' } };
      expect((await decideParsed(bash(PUSH), d)).action).toBe('deny');
    });
  });

  describe('T13 a push from a worktree runs git in that worktree', () => {
    const cwdsOf = (calls: GitCall[]) => [...new Set(calls.map((c) => c.cwd))];
    it('uses the cd target', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash('cd /wt && git push fork feat/x'), deps({ calls }));
      expect(cwdsOf(calls)).toEqual(['/wt']);
      expect(calls.some((c) => c.args.join(' ') === 'rev-parse feat/x^{tree}')).toBe(true);
    });
    it('uses the -C value over the cd target, and passes it as the cwd (never as a git argument)', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash('cd /wt && git -C /wt2 push fork feat/x'), deps({ calls }));
      expect(cwdsOf(calls)).toEqual(['/wt2']);
      expect(calls.every((c) => !c.args.includes('-C'))).toBe(true);
    });
    it('uses the git-for.ps1 -Path value as the directory', async () => {
      const calls: GitCall[] = [];
      await decideParsed(pwsh('pwsh -File scripts/github/git-for.ps1 -Path /wt3 -Remote fork push fork feat/x'), deps({ calls }));
      expect(cwdsOf(calls)).toEqual(['/wt3']);
    });
    it('uses the payload cwd when nothing else is named', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash('git push fork feat/x'), deps({ calls }));
      expect(cwdsOf(calls)).toEqual(['/repo']);
    });
    it('reads the branch from the worktree when the push names none', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash('git -C /wt push fork'), deps({ calls }));
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
    ])('denies %s with no tap: a cd after the push does not move it out of the CCv3 checkout', async (cmd) => {
      expect(await denied(bash(cmd), W), cmd).toBe(true);
      expect(await denied(pwsh(cmd), W), `pwsh: ${cmd}`).toBe(true);
    });
    it.each([
      `${PUSH}; Set-Location C:\\other`,
      `${PUSH}; sl C:\\other`,
      `${PUSH}; Push-Location C:\\other`,
      `${PUSH}; Set-Location -LiteralPath 'C:\\other'`,
    ])('denies the PowerShell form %s with no tap', async (cmd) => {
      expect(await denied(pwsh(cmd), W), cmd).toBe(true);
    });
    it('judges the push in the payload cwd, never in the later cd', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash(`${PUSH}; cd ${OTHER_DIR}`), deps({ ...W, calls }));
      expect(cwdsOf(calls)).toEqual(['/repo']);
    });
    it('allows the same push after the tap: the tap is checked in the CCv3 checkout', async () => {
      shipTap();
      expect(await denied(bash(`${PUSH}; cd ${OTHER_DIR}`), W)).toBe(false);
    });
    it('a cd text inside a quoted string is not a cd', async () => {
      expect(await denied(bash(`echo "; cd ${OTHER_DIR}"; ${PUSH}`), W)).toBe(true);
      expect(await denied(bash(`echo '; cd ${OTHER_DIR}'; ${PUSH}`), W)).toBe(true);
    });
    // T18: a cd joined by ; may fail and leave the shell in the CCv3 cwd, so only the && form passes on the cd folder alone.
    it('a cd before the push into a folder that is not CCv3 still passes the push when joined by && (T18 covers ;)', async () => {
      expect(await denied(bash(`cd ${OTHER_DIR} && ${PUSH}`), W)).toBe(false);
      expect(await denied(bash(`cd ${OTHER_DIR}; ${PUSH}`), W)).toBe(true);
      expect(await denied(pwsh(`Set-Location C:\\other; ${PUSH}`), W)).toBe(true);
    });
    it('every folder on the cd path is judged: a cd back into the repo needs the tap, and with the tap both folders pass', async () => {
      const cmd = `cd ${OTHER_DIR} && cd /repo && ${PUSH}`;
      expect(await denied(bash(cmd), W)).toBe(true);
      shipTap();
      expect(await denied(bash(cmd), W)).toBe(false);
    });
    // A later cd may not run (|| short-circuit, a subshell, a failed cd), so the repo folder is still judged. See T15.
    it('a cd out of the repo before the push no longer lets it pass: the cd may not run', async () => {
      expect(await denied(bash(`cd /repo && cd ${OTHER_DIR} && ${PUSH}`), W)).toBe(true);
    });
    it('a cd after the push, with a cd back to the repo before it, still needs the tap', async () => {
      const cmd = `cd ${OTHER_DIR}; cd /repo; ${PUSH}; cd ${OTHER_DIR}`;
      expect(await denied(bash(cmd), W)).toBe(true);
      shipTap();
      expect(await denied(bash(cmd), W)).toBe(false);
    });
    it('a -C value still wins over the cd target', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash(`cd ${OTHER_DIR} && git -C /wt2 push fork feat/x; cd /wt9`), deps({ ...W, calls }));
      expect(cwdsOf(calls)).toEqual(['/wt2']);
    });
    it('a relative cd is resolved against the cwd, and a later relative cd is resolved against the earlier one', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash('cd sub && cd deeper && git push fork feat/x; cd ../other'), deps({ calls }));
      expect(cwdsOf(calls)).toEqual([resolve('/repo', 'sub'), resolve('/repo', 'sub', 'deeper')]);
    });
    it('a squashed-quote push (g"i"t push) is placed by the cds before it', async () => {
      expect(await denied(bash(`g"i"t push fork feat/x; cd ${OTHER_DIR}`), W)).toBe(true);
      expect(await denied(bash(`cd ${OTHER_DIR} && g"i"t push fork feat/x`), W)).toBe(false);
    });
    it('two pushes are each judged in their own folder: only the one in the CCv3 checkout needs the tap', async () => {
      const cmd = `cd /tmp/other && git push other main; cd /repo && ${PUSH}`;
      expect(await denied(bash(cmd), W)).toBe(true);
      shipTap();
      expect(await denied(bash(cmd), W)).toBe(false);
    });
    it('two pushes: the second runs after both cds, so the repo folder on its path needs its own tap too', async () => {
      const cmd = `cd /repo && ${PUSH}; cd /tmp/other && git push fork feat/y`;
      expect(await denied(bash(cmd), W)).toBe(true);
      shipTap();
      expect(await denied(bash(cmd), W)).toBe(true); // the second push may run in /repo (its cd may not run): feat/y has no tap
      shipTap('feat/y', TREE, HEAD);
      expect(await denied(bash(cmd), { ...W, trees: { HEAD: TREE, 'feat/x': TREE, 'feat/y': TREE } })).toBe(false);
    });
    it('two identical pushes in different folders are two judgments', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash(`cd /tmp/a && ${PUSH}; cd /tmp/b && ${PUSH}`), deps({ calls }));
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
    ])('denies a push when the later cd is a %s: %s', async (_name, cmd) => {
      expect(await denied(bash(cmd), W), cmd).toBe(true);
    });
    it('denies the PowerShell -WhatIf cd, which does not move', async () => {
      const cmd = `Set-Location /repo; cd ${OTHER_WIN} -WhatIf; ${PUSH}`;
      expect(await denied(pwsh(cmd), W), cmd).toBe(true);
    });
    it('judges the push in each folder on the path, never in the payload cwd when a cd comes first', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash(`cd /aa && cd /bb && cd /cc && ${PUSH}`), deps({ calls }));
      expect([...new Set(calls.map((c) => c.cwd))]).toEqual(['/aa', '/bb', '/cc']);
    });
    it('a push before any cd is judged only in the payload cwd', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash(`${PUSH}; cd /a`), deps({ calls }));
      expect([...new Set(calls.map((c) => c.cwd))]).toEqual(['/repo']);
    });
    it('a push after `true || cd` is denied even when the tap covers every folder on the path (round 3 C4)', async () => {
      shipTap();
      // Round 3 C4 (Dave 2026-11-15): a step before the push that the gate does not model is a hard deny, push-state-unknown. `true` is a program it does not model.
      expect(await denied(bash(`cd /repo && true || cd ${OTHER_DIR}; ${PUSH}`), W)).toBe(true);
    });

    // HOLE 2: \" escapes in bash, not in PowerShell. Each shell hides a different cd, so the squashed view reads cds under both masks.
    it('denies a push when the real PowerShell cd into CCv3 is hidden from the bash mask', async () => {
      const cmd = `Write-Output "a\\"; cd /repo; Write-Output \\"b"; git "push" fork feat/x`;
      expect(await denied(pwsh(cmd, { cwd: SUB }), WSUB), cmd).toBe(true);
    });
    it('denies a push when a bash-visible fake cd to another folder follows the real PowerShell cd into CCv3', async () => {
      const cmd = 'cd /repo; Write-Output "a`"; cd ' + OTHER_DIR + '; echo `"b"; git "push" fork feat/x';
      expect(await denied(pwsh(cmd, { cwd: SUB }), WSUB), cmd).toBe(true);
    });
    it('denies a push when a bash-visible cd to another folder follows a PowerShell cd into CCv3 that the bash mask hides', async () => {
      const cmd = `Write-Output "a\\"; cd /repo; Write-Output \\"b"; cd ${OTHER_DIR}; git "push" fork feat/x`;
      expect(await denied(pwsh(cmd, { cwd: SUB }), WSUB), cmd).toBe(true);
    });
  });

  // RED-13: a plain commit in the SAME command text moves HEAD before the push runs. The hook reads HEAD earlier, so the tap is
  // compared with the index tree (what the commit will hold). HEAD's tree is TREE, the index tree is INDEX in these tests.
  describe('RED-13 a plain commit before the push in the same command: the tap is compared with the index tree', () => {
    const INDEX = 'i'.repeat(40);
    const W: World = { indexTree: INDEX };
    const PUSHB = 'git push fork feat/x';
    const COMMIT = 'git commit -F m.txt';
    const callsOf = async (cmd: string, tool: typeof bash | typeof pwsh = bash, w: World = W): Promise<string[]> => {
      const calls: GitCall[] = [];
      await decideParsed(tool(cmd), deps({ ...w, calls }));
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
    ])('1: allows %j with a tap on the index tree', async (cmd) => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      expect(await denied(bash(cmd), W), cmd).toBe(false);
    });

    it('1b: the same command is denied with no tap (the rule is the tree, not the shape)', async () => {
      expect(await denied(bash(`${COMMIT} && ${PUSHB}`), W)).toBe(true);
    });

    it('2: denies when the index tree is not the tapped tree (a file changed after the tap)', async () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE2);
      expect(await denied(bash(`${COMMIT} && ${PUSHB}`), W)).toBe(true);
      expect(await reasonOf(bash(`${COMMIT} && ${PUSHB}`), W)).toContain('ship-ask.mjs commit-and-push --branch feat/x');
    });

    it('2b: a tap on the HEAD tree does not license a different index tree', async () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
      expect(await denied(bash(`${COMMIT} && ${PUSHB}`), W)).toBe(true);
    });

    it('2c: denies when write-tree fails, as push-tree-unresolved', async () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      const w: World = { enforcePush: true }; // no indexTree: write-tree fails
      expect(await denied(bash(`${COMMIT} && ${PUSHB}`), w)).toBe(true);
      expect(await reasonOf(bash(`${COMMIT} && ${PUSHB}`), w)).toContain('cannot read the tree of');
      expect((await decideParsed(bash(`${COMMIT} && ${PUSHB}`), deps({ enforcePush: undefined }))).action).toBe('allow'); // warn mode still only warns
    });

    it('2d: reads the index in the directory the command acts in', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash(`cd /wt && ${COMMIT} && ${PUSHB}`), deps({ ...W, calls }));
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
    ])('3/4: %j is denied with a tap on the index tree AND with one on the HEAD tree (round 3 C4)', async (cmd) => {
      // Round 3 C4 (Dave 2026-11-15): a step before the push that the gate does not model is a hard deny, push-state-unknown.
      // Before round 3 the HEAD-tree tap passed here, and the push then sent the new commit under a tap for the old tree.
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      expect(await denied(bash(cmd), W), cmd).toBe(true);
      rmSync(storeFile, { force: true });
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
      expect(await denied(bash(cmd), { ...W, trees: { HEAD: TREE, 'feat/x': TREE, other: TREE } }), `${cmd} with a HEAD-tree tap`).toBe(true);
    });

    it('3b: a fallback never asks git for the index tree', async () => {
      for (const cmd of [`git commit --amend -F m.txt; ${PUSHB}`, `git commit -a -F m.txt; ${PUSHB}`, `git add -A; ${COMMIT}; ${PUSHB}`]) {
        expect(await callsOf(cmd), cmd).not.toContain('write-tree');
      }
    });

    it('5: a push alone is unchanged: HEAD tree rule, no write-tree', async () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      expect(await denied(bash(PUSHB), W)).toBe(true);
      rmSync(storeFile, { force: true });
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
      expect(await denied(bash(PUSHB), W)).toBe(false);
      expect(await callsOf(PUSHB)).not.toContain('write-tree');
    });

    it('6/9: a push before the commit uses the HEAD tree rule', async () => {
      for (const cmd of [`${PUSHB}; ${COMMIT}`, `${PUSHB} && ${COMMIT}`]) {
        rmSync(storeFile, { force: true });
        tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
        expect(await denied(bash(cmd), W), cmd).toBe(true);
        rmSync(storeFile, { force: true });
        tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
        expect(await denied(bash(cmd), W), `${cmd} with a HEAD-tree tap`).toBe(false);
        expect(await callsOf(cmd), cmd).not.toContain('write-tree');
      }
    });

    it('7: force, delete, origin and subagent denials hold for a chained command', async () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      tap('ship', branchKey('main'), HEAD, 'Commit and push (Recommended)', INDEX);
      for (const push of ['git push -f fork feat/x', 'git push --force-with-lease fork feat/x', 'git push fork +feat/x', 'git push fork :feat/x', 'git push --delete fork feat/x', 'git push --tags fork']) {
        expect(await reasonOf(bash(`${COMMIT} && ${push}`), W), push).toMatch(/force|delete|rewrit/i);
      }
      for (const push of ['git push origin feat/x', 'git push origin main', 'git push']) {
        expect(await denied(bash(`${COMMIT} && ${push}`), { ...W, pushRef: 'origin/feat/x' }), push).toBe(true);
      }
      expect(await reasonOf(bash(`${COMMIT} && git push origin feat/x`), W)).toContain('origin');
      expect(await reasonOf(bash(`${COMMIT} && ${PUSHB}`, { agent_id: 'sub-1' }), W)).toContain('subagent');
    });

    it('7b: a chained land still needs its own tap', async () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      expect(await denied(bash(`${COMMIT} && ${PUSHB} && pwsh -File scripts/github/land-pr.ps1 -Pr 12`), W)).toBe(true);
    });

    it('8: PowerShell git-safe commit then push', async () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      const cmd = 'pwsh -File scripts/git-safe.ps1 commit -F m.txt && pwsh -File scripts/git-safe.ps1 push fork feat/x';
      expect(await denied(pwsh(cmd), W)).toBe(false);
      expect(await denied(pwsh(`pwsh -File scripts/git-safe.ps1 commit --amend -F m.txt && pwsh -File scripts/git-safe.ps1 push fork feat/x`), W)).toBe(true);
    });

    it('8b: PowerShell: && chains (PowerShell 7), ; is the fallback', async () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      const gs = 'pwsh -File scripts/git-safe.ps1';
      expect(await denied(pwsh(`${gs} commit -F m.txt && ${gs} push fork feat/x`), W)).toBe(false);
      expect(await denied(pwsh(`${gs} commit -F m.txt; ${gs} push fork feat/x`), W)).toBe(true);
      expect(await denied(pwsh(`${gs} commit -F m.txt
${gs} push fork feat/x`), W)).toBe(true);
    });

    it('10: ; newline and || between commit and push: no index read, and no tap clears it (round 3 C4)', async () => {
      for (const cmd of [`${COMMIT}; ${PUSHB}`, `${COMMIT}
${PUSHB}`, `${COMMIT} || ${PUSHB}`]) {
        rmSync(storeFile, { force: true });
        tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
        expect(await denied(bash(cmd), W), `${cmd} with an index-tree tap`).toBe(true);
        expect(await callsOf(cmd), cmd).not.toContain('write-tree');
        rmSync(storeFile, { force: true });
        tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
        // Round 3 C4 (Dave 2026-11-15): a step before the push that the gate does not model is a hard deny, push-state-unknown.
        expect(await denied(bash(cmd), W), `${cmd} with a HEAD-tree tap`).toBe(true);
      }
    });

    it('the push gate in warn mode warns, with the same tree rule', async () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
      expect(await decideParsed(bash(`${COMMIT} && ${PUSHB}`), deps({ ...W, enforcePush: undefined }))).toEqual({ action: 'allow' });
      const d = await decideParsed(bash(`${COMMIT} && ${PUSHB}`), deps({ indexTree: TREE2, enforcePush: undefined }));
      expect(d.action === 'allow' && d.warn).toContain('ship');
    });
  });
});

describe('G4 the model writes the store', () => {
  it('denies Write, Edit and NotebookEdit to the store, its lock and its tmp file', async () => {
    for (const tool of ['Write', 'Edit']) {
      expect(await denied({ tool_name: tool, tool_input: { file_path: storeFile }, cwd: '/repo' }), tool).toBe(true);
    }
    expect(await denied({ tool_name: 'NotebookEdit', tool_input: { notebook_path: storeFile }, cwd: '/repo' })).toBe(true);
    expect(await denied({ tool_name: 'Write', tool_input: { file_path: `${storeFile}.lock` }, cwd: '/repo' })).toBe(true);
    expect(await denied({ tool_name: 'Write', tool_input: { file_path: `${storeFile}.123.tmp` }, cwd: '/repo' })).toBe(true);
  });
  it('denies the default store path of the real home folder', async () => {
    const p = join('C:\\Users\\dave', '.claude', 'state', 'ccv3-mods', 'decisions.json');
    expect(await denied({ tool_name: 'Write', tool_input: { file_path: p }, cwd: '/repo' })).toBe(true);
    expect(await denied({ tool_name: 'Write', tool_input: { file_path: 'C:/Users/dave/.claude/state/ccv3-mods/decisions.json' }, cwd: '/repo' })).toBe(true);
  });
  it('denies the Desktop Commander write tools', async () => {
    expect(await denied({ tool_name: `${DC}write_file`, tool_input: { path: storeFile, content: '{}' }, cwd: '/repo' })).toBe(true);
    expect(await denied({ tool_name: `${DC}edit_block`, tool_input: { file_path: storeFile, old_string: 'a', new_string: 'b' }, cwd: '/repo' })).toBe(true);
  });
  it('allows a write to any other file, including another decisions.json', async () => {
    expect(await denied({ tool_name: 'Write', tool_input: { file_path: '/repo/docs/decisions.json' }, cwd: '/repo' })).toBe(false);
    expect(await denied({ tool_name: 'Edit', tool_input: { file_path: '/repo/src/a.ts' }, cwd: '/repo' })).toBe(false);
  });
  it('denies shell text that writes the store, and passes a read of it', async () => {
    expect(await denied(bash(`echo '{}' > ${storeFile}`))).toBe(true);
    expect(await denied(pwsh(`Set-Content -Path ${storeFile} -Value '{}'`))).toBe(true);
    expect(await denied(bash(`node -e "import('./scripts/github/lib/decisions.mjs').then(m=>m.decisionRecord({}))"`))).toBe(true);
    expect(await denied(bash(`cat ${storeFile}`))).toBe(false);
    expect(await denied(pwsh(`Get-Content ${storeFile} -Raw`))).toBe(false);
    expect(await denied(bash('rg decisionRecord scripts/github'))).toBe(false);
  });
  it('passes a node -e that only READS the store, and still denies node code that can write it', async () => {
    expect(await denied(bash(`node -e "const d=require('${storeFile}');console.log(Object.keys(d))"`))).toBe(false);
    expect(await denied(bash(`node -e "console.log(require('fs').readFileSync('${storeFile}','utf8').length)"`))).toBe(false);
    expect(await denied(bash(`node -e "require('fs').writeFileSync('${storeFile}','{}')"`))).toBe(true);
    expect(await denied(bash(`node -e "require('fs').createWriteStream('${storeFile}').end('{}')"`))).toBe(true);
    expect(await denied(bash(`node -e "require('fs').copyFileSync('/tmp/x.json','${storeFile}')"`))).toBe(true);
    expect(await denied(bash(`node -e "const f=require('fs').openSync('${storeFile}','w');require('fs').closeSync(f)"`))).toBe(true);
    expect(await denied(bash(`node -e "require('child_process').execSync('echo {} > ${storeFile}')"`))).toBe(true);
    expect(await denied(bash(`node -e "import('./scripts/github/lib/decisions.mjs').then(m=>m.decisionRecord({}))"`))).toBe(true);
    expect(await denied(bash(`node -e "require('/tmp/evil.js');console.log(require('${storeFile}'))"`))).toBe(true);
    expect(await denied(bash(`node -e "console.log(require('fs').readFileSync('${storeFile}',{flag:'w'}))"`))).toBe(true);
    expect(await denied(bash(`node -e "const m=process.argv[1];require(m);console.log(require('${storeFile}'))" x`))).toBe(true);
    expect(await denied(bash(`node -e "const f=require('fs');f['wri'+'teFileSync']('${storeFile}','{}')"`))).toBe(true);
  });
  it('passes a copy that only READS the store (the store is the first source) and still denies a copy that writes it', async () => {
    expect(await denied(bash(`cp ${storeFile} /tmp/before.json`))).toBe(false);
    expect(await denied(bash(`cp -f ${storeFile} /tmp/before.json`))).toBe(false);
    expect(await denied(pwsh(`Copy-Item ${storeFile} C:\\tmp\\before.json`))).toBe(false);
    expect(await denied(bash(`cp /tmp/x.json ${storeFile}`))).toBe(true);
    expect(await denied(pwsh(`Copy-Item C:\\tmp\\x.json ${storeFile}`))).toBe(true);
    expect(await denied(bash(`cp ${storeFile} ${storeFile}.bak`))).toBe(true);
    expect(await denied(bash(`cp ${storeFile} /tmp/b.json && echo '{}' > ${storeFile}`))).toBe(true);
    expect(await denied(pwsh(`Copy-Item -Destination ${storeFile} C:\\tmp\\x.json`))).toBe(true);
    expect(await denied(pwsh(`Copy-Item -Path C:\\tmp\\x.json -Destination ${storeFile}`))).toBe(true);
    expect(await denied(bash(`cp -t ${storeFile} /tmp/x.json`))).toBe(true);
    expect(await denied(bash(`cp --target-directory ${storeFile} /tmp/x.json`))).toBe(true);
    expect(await denied(pwsh(`Copy-Item -Force ${storeFile} C:\\tmp\\before.json`))).toBe(false);
    expect(await denied(bash(`cp ${storeFile} /tmp/b.json; mv /tmp/x.json ${storeFile}`))).toBe(true);
  });
});

describe('G5 Desktop Commander process tools', () => {
  it('reads command for start_process and input for interact_with_process', async () => {
    expect(await denied({ tool_name: `${DC}start_process`, tool_input: { command: CREATE }, cwd: '/repo' })).toBe(true);
    expect(await denied({ tool_name: `${DC}interact_with_process`, tool_input: { pid: 1, input: 'pwsh -File scripts/github/land-pr.ps1 -Pr 12' }, cwd: '/repo' })).toBe(true);
    expect(await denied({ tool_name: `${DC}start_process`, tool_input: { command: 'git status' }, cwd: '/repo' })).toBe(false);
  });
  it('passes a process call with no readable text (nothing to judge)', async () => {
    expect(await denied({ tool_name: `${DC}interact_with_process`, tool_input: { pid: 1 }, cwd: '/repo' })).toBe(false);
  });
  it('lists the tools the matcher must cover', () => {
    expect([...COMMAND_TOOLS].sort()).toEqual(['Bash', 'PowerShell', `${DC}interact_with_process`, `${DC}start_process`].sort());
    expect([...WRITE_TOOLS].sort()).toEqual(['Edit', 'NotebookEdit', 'Write', `${DC}edit_block`, `${DC}move_file`, `${DC}write_file`, `${DC}write_pdf`].sort());
  });
});

describe('G6 subagent', () => {
  it('denies a create, a land and a merge even with the tap on record', async () => {
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(await denied(bash(CREATE, { agent_id: 'a1' }))).toBe(true);
    expect(await denied(bash('pwsh -File scripts/github/land-pr.ps1 -Pr 12', { agent_id: 'a1' }))).toBe(true);
    expect(await denied(bash('gh pr merge 12', { agent_id: 'a1' }))).toBe(true);
    expect(await reasonOf(bash(CREATE, { agent_id: 'a1' }))).toContain('subagent');
  });
  it('lets a subagent run a normal command', async () => {
    expect(await denied(bash('git status', { agent_id: 'a1' }))).toBe(false);
    expect(await denied(bash('git fetch fork', { agent_id: 'a1' }))).toBe(false);
  });
  it('denies a subagent push even with the tap on record (D3), and says why', async () => {
    tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
    expect(await denied(bash('git push fork feat/x', { agent_id: 'a1' }))).toBe(true);
    expect(await reasonOf(bash('git push fork feat/x', { agent_id: 'a1' }))).toContain('subagent');
    expect(await reasonOf(bash('git push fork feat/x', { agent_id: 'a1' }))).toContain('push');
  });
  it('denies EVERY subagent push to the fork (D3), main included, but not a dry run or a stash', async () => {
    expect(await denied(bash('git push fork main', { agent_id: 'a1' }))).toBe(true);
    expect(await denied(bash('git push --force fork feat/x', { agent_id: 'a1' }))).toBe(true);
    expect(await denied(bash('git push --dry-run fork feat/x', { agent_id: 'a1' }))).toBe(false);
    expect(await denied(bash('git stash push -m x', { agent_id: 'a1' }))).toBe(false);
  });
  it('lets a subagent push in a checkout that is not CCv3, or to another remote (the checkout and the remote decide first)', async () => {
    expect(await denied(bash('git push fork feat/x', { agent_id: 'a1' }), { remote: 'https://github.com/someone/else.git' })).toBe(false);
    expect(await denied(bash('git push origin main', { agent_id: 'a1' }), { remote: 'https://github.com/someone/else.git' })).toBe(false);
    expect(await denied(bash('git push other feat/x', { agent_id: 'a1' }))).toBe(false);
  });
  it('a subagent push to origin from a CCv3 checkout is denied (origin is never allowed)', async () => {
    expect(await reasonOf(bash('git push origin main', { agent_id: 'a1' }))).toContain('origin');
  });
});

describe('G7 enforce flag', () => {
  it('only a literal true under decisions.enforce denies; every other value warns', async () => {
    for (const w of [{ enforce: false }, { enforce: 'true' }, { enforce: 1 }, { config: null }, { config: 'not json' }, { config: JSON.stringify({ checkpoint: { enforce: true } }) }]) {
      const d = await decideParsed(bash(CREATE), deps(w));
      expect(d.action, JSON.stringify(w)).toBe('allow');
      expect(d.action === 'allow' && d.warn, JSON.stringify(w)).toBeTruthy();
    }
    expect((await decideParsed(bash(CREATE), deps({ enforce: true }))).action).toBe('deny');
  });
  it('warn mode prints the would-be deny as context and does not block', async () => {
    const out = JSON.parse(await handleParsed(JSON.stringify(bash(CREATE)), deps({ enforce: false }))) as { hookSpecificOutput: { permissionDecision?: string; additionalContext?: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain('would be blocked');
  });
  it('a deny is a deny output', async () => {
    const out = JSON.parse(await handleParsed(JSON.stringify(bash(CREATE)), deps())) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('G8 what is not gated', () => {
  it('passes a create in a foreign checkout', async () => {
    expect(await denied(bash('gh pr create --draft --title t --body-file b.md'), { remote: 'https://github.com/someone/else.git' })).toBe(false);
  });
  it('passes a create from main', async () => {
    expect(await denied(bash('gh pr create --draft --head main --title t --body-file b.md'))).toBe(false);
  });
  it('passes ordinary commands and other tools', async () => {
    for (const c of ['git status', 'gh pr view 12', 'gh pr ready 12 --undo', 'node scripts/github/pr-checkpoint.mjs --json --pr 12', 'gh api repos/x/y/pulls/12/reviews']) {
      expect(await denied(bash(c)), c).toBe(false);
    }
    expect(await denied({ tool_name: 'Read', tool_input: { file_path: storeFile }, cwd: '/repo' })).toBe(false);
  });
  it('passes unreadable input', async () => {
    expect(await handleParsed('not json', deps())).toBe('{}');
  });
  // Unreadable input has no visible shape, so the documented posture (deny only a gated shape) allows it. It says so on stderr, once, and the log row holds no input text.
  it('passes unreadable input, says so on stderr once, and logs none of the input text', async () => {
    const log = join(dir, 'guard.jsonl');
    const savedLog = process.env.CCV3_GUARD_DECISIONS_LOG;
    process.env.CCV3_GUARD_DECISIONS_LOG = log;
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      for (const raw of ['SECRET-TOKEN-abc123 gh pr merge', '{"tool_name": "Bash", SECRET-TOKEN-abc123']) {
        writes.length = 0;
        expect(await handleParsed(raw, deps())).toBe('{}');
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
  it('a readable payload prints nothing on stderr', async () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { expect(await handleParsed(JSON.stringify(bash('git status')), deps())).toBe('{}'); } finally { process.stderr.write = orig; }
    expect(writes).toEqual([]);
  });
});

describe('G9 there is no override', () => {
  it('a leading SKIP_ assignment or env value does not let a create through', async () => {
    for (const cmd of [`SKIP_DECISION_GATE=1 ${CREATE}`, `$env:SKIP_DECISION_GATE='1'; ${CREATE}`, `SKIP_PRE_PR_GATE=1 ${CREATE}`]) {
      expect(await denied(bash(cmd)), cmd).toBe(true);
    }
    const d = { ...deps(), env: { ...deps().env, SKIP_DECISION_GATE: '1', SKIP_PRE_PR_GATE: '1' } };
    expect((await decideParsed(bash(CREATE), d)).action).toBe('deny');
  });
});

describe('G10 fail closed on a gated shape', () => {
  it('denies a create when git fails', async () => {
    const out = JSON.parse(await handleParsed(JSON.stringify(bash(CREATE)), deps({ gitFails: true }))) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('denies a land with no readable PR number', async () => {
    expect(await denied(pwsh('.\\scripts\\github\\land-pr.ps1 -Pr $n'))).toBe(true);
    expect(await denied(bash('gh pr merge --squash'))).toBe(true);
  });
  it('does not fail a harmless command when git fails', async () => {
    expect(await handleParsed(JSON.stringify(bash('git fetch fork')), deps({ gitFails: true }))).toBe('{}');
    // the checkout cannot be read: a push is gated, and the answer is a deny (not any non-empty answer, a warning included)
    const out = JSON.parse(await handleParsed(JSON.stringify(bash('git push fork main')), deps({ gitFails: true }))) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });
  it('denies a push when git fails', async () => {
    const out = JSON.parse(await handleParsed(JSON.stringify(bash('git push fork feat/x')), deps({ gitFails: true }))) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('denies a push when the tree cannot be read', async () => {
    tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
    expect(await denied(bash('git push fork feat/x'), { trees: {} })).toBe(true);
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
  const run = async (input: object, w?: World): Promise<Out> => JSON.parse(await handleParsed(JSON.stringify(input), realDeps(w))) as Out;
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
  it('enforce on: a push from a missing cwd is denied, and the reason names the cwd', async () => {
    const o = await run(bash(PUSH, { cwd: missing() }), { enforcePush: true });
    expect(o.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(textOf(o), 'names the cwd').toContain(missing());
    expect(textOf(o), 'no ENOENT').not.toMatch(/ENOENT/);
  });
  it('enforce on: a create from a missing cwd is denied too (the other scope)', async () => {
    const o = await run(bash(CREATE, { cwd: missing() }), { enforce: true });
    expect(o.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(textOf(o)).toContain(missing());
  });
  it('enforcePush absent (round 3 item 18): a push from a missing cwd is a hard deny, and the reason names the cwd', async () => {
    // Round 3 item 18 (Dave: "Land now, fix first in round 3"): a throw in a command that holds a push never ends in a warning.
    const o = await run(bash(PUSH, { cwd: missing() }), { enforcePush: undefined });
    expect(o.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(textOf(o), 'names the cwd').toContain(missing());
    expect(textOf(o), 'no ENOENT').not.toMatch(/ENOENT/);
  });
  it('a cd target that is missing is named, not the payload cwd', async () => {
    const target = missing();
    const o = await run(bash(`cd "${target.replace(/\\/g, '/')}" && ${PUSH}`, { cwd: dir }), { enforcePush: true });
    expect(o.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(textOf(o).replace(/\\/g, '/')).toContain(target.replace(/\\/g, '/'));
    expect(textOf(o)).not.toMatch(/ENOENT/);
  });
  it('a command that is not gated still passes from a missing cwd', async () => {
    expect(await handleParsed(JSON.stringify(bash('git status', { cwd: missing() })), realDeps())).toBe('{}');
  });
  it('an existing cwd that is not a repo behaves as before: git fails, the push is denied', async () => {
    const o = await run(bash(PUSH, { cwd: dir }), { enforcePush: true });
    expect(o.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(textOf(o)).toContain('git remote -v failed');
  });
  it('the log gets a decision row, not an error row, so the doctor stays green', async () => {
    const log = join(dir, 'guard.jsonl');
    const saved = process.env.CCV3_GUARD_DECISIONS_LOG;
    process.env.CCV3_GUARD_DECISIONS_LOG = log;
    try {
      await run(bash(PUSH, { cwd: missing() }), { enforcePush: true });
      const rows = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(rows.filter((r) => r.kind === 'error'), 'no crash row').toEqual([]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ hook: 'decision-gate', decision: 'deny', reason: 'cwd-missing' });
    } finally {
      if (saved === undefined) delete process.env.CCV3_GUARD_DECISIONS_LOG; else process.env.CCV3_GUARD_DECISIONS_LOG = saved;
    }
  });
  it('a real git failure on an existing cwd is still a crash row (the log is not silenced)', async () => {
    const log = join(dir, 'guard2.jsonl');
    const saved = process.env.CCV3_GUARD_DECISIONS_LOG;
    process.env.CCV3_GUARD_DECISIONS_LOG = log;
    try {
      const boom: Deps = { ...realDeps({ enforcePush: true }), git: () => { throw new Error('git exploded'); } };
      await handleParsed(JSON.stringify(bash(PUSH, { cwd: dir })), boom);
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
  const out = async (input: object, w: World) => JSON.parse(await handleParsed(JSON.stringify(input), deps(w))) as { hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string } };

  it('push: enforcePush absent or not literally true warns; enforce does not matter', async () => {
    for (const w of [{ enforce: true, ...ABSENT }, { enforce: true, enforcePush: false }, { enforce: true, enforcePush: 'true' }, { enforce: true, enforcePush: 1 }, { enforce: false, enforcePush: false }, { config: JSON.stringify({ decisions: { enforce: true } }) }, { config: JSON.stringify({ checkpoint: { enforcePush: true } }) }]) {
      const d = await decideParsed(bash(PUSHC), deps(w));
      expect(d.action, JSON.stringify(w)).toBe('allow');
      expect(d.action === 'allow' && d.warn, JSON.stringify(w)).toBeTruthy();
    }
  });
  it('push: enforcePush true denies even when decisions.enforce is false', async () => {
    expect((await decideParsed(bash(PUSHC), deps({ enforce: false, enforcePush: true }))).action).toBe('deny');
  });
  it('push warn: runs, adds context that names decisions.enforcePush, does not block', async () => {
    const o = await out(bash(PUSHC), { enforce: true, ...ABSENT });
    expect(o.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(o.hookSpecificOutput?.additionalContext).toContain('decisions.enforcePush');
    expect(o.hookSpecificOutput?.additionalContext).toContain('ship-ask.mjs commit-and-push');
  });
  it('other warn text still names decisions.enforce', async () => {
    const o = await out(bash(CREATE), { enforce: false });
    expect(o.hookSpecificOutput?.additionalContext).toContain('decisions.enforce is true');
  });
  it('other: enforcePush does not make a create, a land or a store write deny', async () => {
    for (const input of [bash(CREATE), bash(LANDC), bash(`echo '{}' > ${storeFile}`), { tool_name: 'Write', tool_input: { file_path: storeFile }, cwd: '/repo' }]) {
      const d = await decideParsed(input, deps({ enforce: false, enforcePush: true }));
      expect(d.action).toBe('allow');
      expect(d.action === 'allow' && d.warn).toBeTruthy();
      expect((await decideParsed(input, deps({ enforce: true, ...ABSENT }))).action).toBe('deny');
    }
  });
  it('mixed land plus push: each flag decides its own part', async () => {
    const cmd = `${LANDC} && ${PUSHC}`;
    const push = `${PUSHC} && ${LANDC}`;
    for (const c of [cmd, push]) {
      expect((await decideParsed(bash(c), deps({ enforce: true, ...ABSENT }))).action, c).toBe('deny'); // the land part denies
      expect((await decideParsed(bash(c), deps({ enforce: false, enforcePush: true }))).action, c).toBe('deny'); // the push part denies
      const both = await decideParsed(bash(c), deps({ enforce: false, enforcePush: false }));
      // Round 3 C4 (Dave 2026-11-15): a step before the push that the gate does not model is a hard deny, push-state-unknown. The land script before the push can move the branch: hard.
      expect(both.action, c).toBe(c === cmd ? 'deny' : 'allow');
      if (c === push) expect(both.action === 'allow' && both.warn, c).toBeTruthy();
      expect((await decideParsed(bash(c), deps({ enforce: true, enforcePush: true }))).action, c).toBe('deny');
    }
  });
  it('mixed: the push tap alone does not clear the land part, and the flag that is on still denies', async () => {
    tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
    const d = await decideParsed(bash(`${PUSHC} && ${LANDC}`), deps({ enforce: true, ...ABSENT }));
    expect(d.action === 'deny' && d.reason).toContain('PR #12');
    expect((await decideParsed(bash(`${PUSHC} && ${LANDC}`), deps({ enforce: false, enforcePush: true }))).action).toBe('allow');
  });
  it('subagent: a push is a hard deny (card prflow-push-blocks), a create follows enforce', async () => {
    // A subagent push to the fork denies whatever enforcePush says (it used to warn while the flag was absent).
    expect((await decideParsed(bash(PUSHC, { agent_id: 'a1' }), deps({ enforce: true, ...ABSENT }))).action).toBe('deny');
    expect((await decideParsed(bash(PUSHC, { agent_id: 'a1' }), deps({ enforce: false, enforcePush: true }))).action).toBe('deny');
    expect((await decideParsed(bash(CREATE, { agent_id: 'a1' }), deps({ enforce: true, ...ABSENT }))).action).toBe('deny');
    expect((await decideParsed(bash(CREATE, { agent_id: 'a1' }), deps({ enforce: false, enforcePush: true }))).action).toBe('allow');
    expect((await decideParsed(bash(`${PUSHC} && ${LANDC}`, { agent_id: 'a1' }), deps({ enforce: true, ...ABSENT }))).action).toBe('deny');
  });
  it('catch path: a push that cannot be judged is a hard deny (round 3 item 18), any other shape follows enforce', async () => {
    const permission = async (input: object, w: World) => (await out(input, { ...w, gitFails: true })).hookSpecificOutput?.permissionDecision;
    expect(await permission(bash(PUSHC), { enforce: true, ...ABSENT })).toBe('deny');
    expect(await permission(bash(PUSHC), { enforce: false, enforcePush: false })).toBe('deny');
    expect(await permission(bash(PUSHC), { enforce: false, enforcePush: true })).toBe('deny');
    expect(await permission(bash(CREATE), { enforce: true, enforcePush: false })).toBe('deny');
    expect(await permission(bash(CREATE), { enforce: false, enforcePush: true })).toBeUndefined();
    expect(await permission(bash(`${PUSHC} && ${CREATE}`), { enforce: true, ...ABSENT })).toBe('deny');
    expect(await permission(bash(`${PUSHC} && ${CREATE}`), { enforce: false, enforcePush: true })).toBe('deny');
    expect(await permission(bash(`${PUSHC} && ${CREATE}`), { enforce: false, enforcePush: false })).toBe('deny');
  });
  it('handle(): a push warn is logged as warn, a push deny as deny', async () => {
    expect((await out(bash(PUSHC), { enforce: true, ...ABSENT })).hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect((await out(bash(PUSHC), { enforce: true, enforcePush: true })).hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});

describe('G11 every land and merge shape of a command is judged', () => {
  const M43 = `gh pr merge 43 --squash --match-head-commit ${HEAD}`;
  const A44 = `gh api repos/${REPO}/pulls/44/merge -X PUT -f sha=${HEAD}`;
  it('denies two gh pr merge commands when only the first PR has a tap', async () => {
    tap('land', prKey(43), HEAD, 'Land now (Recommended)');
    const cmd = `${M43} && gh pr merge 44 --squash --match-head-commit ${HEAD}`;
    expect(await reasonOf(bash(cmd))).toContain('PR #44');
  });
  it('denies a gh pr merge followed by a gh api merge when only the first PR has a tap', async () => {
    tap('land', prKey(43), HEAD, 'Land now (Recommended)');
    expect(await reasonOf(bash(`${M43} && ${A44}`))).toContain('PR #44');
  });
  it('allows both when each PR has its tap', async () => {
    tap('land', prKey(43), HEAD, 'Land now (Recommended)');
    tap('land', prKey(44), HEAD, 'Land now (Recommended)');
    expect(await denied(bash(`${M43} && ${A44}`))).toBe(false);
  });
  it('splits on ; | and newlines too, and in PowerShell', async () => {
    tap('land', prKey(43), HEAD, 'Land now (Recommended)');
    expect(await denied(bash(`${M43}; ${A44}`))).toBe(true);
    expect(await denied(bash(`${M43}\n${A44}`))).toBe(true);
    expect(await denied(pwsh(`${M43}; ${A44}`))).toBe(true);
  });
  it('reads the sha of each segment: the sha of the first merge does not cover the second', async () => {
    tap('land', prKey(43), HEAD, 'Land now (Recommended)');
    tap('land', prKey(44), HEAD, 'Land now (Recommended)');
    expect(await reasonOf(bash(`${M43} && gh pr merge 44 --squash`))).toContain('names no head');
    expect(await denied(bash(`${M43} && gh api repos/${REPO}/pulls/44/merge -X PUT -f sha=${OTHER}`))).toBe(true);
  });
  it('judges a land-pr.ps1 after another land, each with its own PR', async () => {
    tap('land', prKey(12), HEAD, 'Land now (Recommended)');
    expect(await denied(bash('pwsh -File scripts/github/land-pr.ps1 -Pr 12 && pwsh -File scripts/github/land-pr.ps1 -Pr 13'))).toBe(true);
    expect(await denied(bash('pwsh -File scripts/github/land-pr.ps1 -Pr 13 -CleanupOnly && pwsh -File scripts/github/land-pr.ps1 -Pr 12'))).toBe(false);
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
  ])('denies %j with no tap: a cd after the create does not move it', async (cmd) => {
    expect(await denied(bash(cmd), W), cmd).toBe(true);
    expect(await reasonOf(bash(cmd), W), cmd).toContain(ask);
  });
  it('denies the PowerShell forms with a cd after the create', async () => {
    expect(await denied(pwsh(`${C}; Set-Location C:\\other`), W)).toBe(true);
    expect(await denied(pwsh(`${C}; sl C:\\other`), W)).toBe(true);
    expect(await denied(pwsh(`${C}; Push-Location C:\\other`), W)).toBe(true);
  });
  it('judges the create in the payload cwd, never in a later cd', async () => {
    const calls: GitCall[] = [];
    await decideParsed(bash(`${C}; cd ${O}`), deps({ ...W, calls }));
    expect(cwdsOf(calls)).toEqual(['/repo']);
  });
  it('a quoted cd is not a cd', async () => {
    expect(await denied(bash(`echo "; cd ${O}"; ${C}`), W)).toBe(true);
    expect(await denied(bash(`echo '; cd ${O}'; ${C}`), W)).toBe(true);
  });
  // T18: a cd joined by ; may fail and leave the shell in the CCv3 cwd, so only the && form passes on the cd folder alone.
  it('a cd before the create into a folder that is not CCv3 still passes it when joined by && (T18 covers ;)', async () => {
    expect(await denied(bash(`cd ${O} && ${C}`), W)).toBe(false);
    expect(await denied(pwsh(`Set-Location C:\\other && ${C}`), W)).toBe(false);
    expect(await denied(pwsh(`Set-Location -LiteralPath 'C:\\other' && ${C}`), W)).toBe(false);
    expect(await denied(bash(`cd ${O}; ${C}`), W)).toBe(true);
    expect(await denied(pwsh(`Set-Location C:\\other; ${C}`), W)).toBe(true);
    expect(await denied(pwsh(`Set-Location -LiteralPath 'C:\\other'; ${C}`), W)).toBe(true);
  });
  // The old rule took the FIRST cd, so `cd O && cd /repo && C` passed. Every folder on the path is judged now.
  it('every folder on the cd path is judged: a cd back into the repo needs the tap', async () => {
    const cmd = `cd ${O} && cd /repo && ${C}`;
    expect(await denied(bash(cmd), W)).toBe(true);
    expect(await denied(bash(`cd /repo && cd ${O} && ${C}`), W)).toBe(true);
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    expect(await denied(bash(cmd), W)).toBe(false);
  });
  it('a relative cd chains: each folder on the path is judged', async () => {
    const calls: GitCall[] = [];
    await decideParsed(bash(`cd sub && cd deeper && ${C}`), deps({ calls }));
    expect(cwdsOf(calls)).toEqual([resolve('/repo', 'sub'), resolve('/repo', 'sub', 'deeper')]);
  });
  it('two creates are each judged in their own folder', async () => {
    const calls: GitCall[] = [];
    const cmd = `cd ${O} && ${C}; cd /repo && ${C}`;
    expect(await denied(bash(cmd), W)).toBe(true);
    await decideParsed(bash(cmd), deps({ ...W, calls }));
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
  ])('denies a create when the later cd is a %s: %j', async (_name, cmd) => {
    expect(await denied(bash(cmd), W), cmd).toBe(true);
  });
  it('denies the PowerShell -WhatIf cd, which does not move', async () => {
    expect(await denied(pwsh(`Set-Location /repo; cd C:\\other -WhatIf; ${C}`), W)).toBe(true);
  });
  it('allows the create when the tap covers every folder on the path', async () => {
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    expect(await denied(bash(`cd /repo && true || cd ${O}; ${C}`), W)).toBe(false);
    expect(await denied(bash(`${C}; cd ${O}`), W)).toBe(false);
  });
  it('the worktree ship flow: a create with a quoted ; in the title and a head after it, in a worktree, with the tap', async () => {
    tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
    const calls: GitCall[] = [];
    const cmd = `cd .claude/worktrees/x && ${CREATE} -f title="a; b & c" -F head=feat/x`;
    expect((await decideParsed(bash(cmd), deps({ calls }))).action).toBe('allow');
    expect(cwdsOf(calls)).toContain(resolve('/repo', '.claude/worktrees/x'));
  });

  // The folder cannot be known after popd, Pop-Location, `cd -` or a bare cd.
  describe('a folder that cannot be known', () => {
    it.each([
      `cd /repo && pushd ${O} && popd && ${C}`,
      `cd ${O} && popd && ${C}`,
      `cd ${O}; cd - ; ${C}`,
      `cd ${O}; cd; ${C}`,
    ])('denies %j with position-unknown when a CCv3 checkout is on the path', async (cmd) => {
      const d = await decideParsed(bash(cmd), deps(W));
      expect(d.action, cmd).toBe('deny');
      expect(d.action === 'deny' ? d.pattern : '', cmd).toBe('position-unknown');
      expect(await reasonOf(bash(cmd), W), cmd).toContain('one absolute cd');
    });
    it('denies the PowerShell Pop-Location form', async () => {
      expect(await denied(pwsh(`Push-Location C:\\other; Pop-Location; ${C}`), W)).toBe(true);
    });
    it('does not deny when no folder on the path is a CCv3 checkout', async () => {
      expect(await denied(bash(`pushd ${O} && popd && ${C}`, { cwd: SUB }), WSUB)).toBe(false);
      expect(await denied(bash(`popd && ${C}`, { cwd: SUB }), WSUB)).toBe(false);
    });
  });

  // The head is read from the create's OWN segment, so a later command's -H or a quoted --head does not set it.
  describe('the head branch', () => {
    it('a -H header of a later command is not the head: the checked-out branch is judged', async () => {
      const cmd = `${C}; curl -H "Accept: x" u`;
      expect(await denied(bash(cmd))).toBe(true);
      tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
      expect(await denied(bash(cmd))).toBe(false);
    });
    it('a --head inside a quoted title is not the head', async () => {
      expect(await denied(bash('gh pr create --draft --title "x --head main" --body-file b.md'))).toBe(true);
    });
    it('a --head after a quoted ; in the title is still the head', async () => {
      tap('open-pr', branchKey('feat/y'), HEAD, 'Open draft PR (Recommended)');
      expect(await denied(bash('gh pr create --title "a; b" --head feat/y'), { heads: { 'feat/y': HEAD } })).toBe(false);
    });
    it('a head that cannot be named (detached HEAD) is denied, not allowed', async () => {
      const d = await decideParsed(bash(C), deps({ branch: '' }));
      expect(d.action).toBe('deny');
      expect(d.action === 'deny' ? d.pattern : '').toBe('head-unresolved');
    });
    it('a create from main is still not gated', async () => {
      expect(await denied(bash(C), { branch: 'main' })).toBe(false);
    });
    it('a spliced gh pr "create" reads --head too', async () => {
      expect(await denied(bash('gh pr "create" --head feat/y --title t'), { branch: 'main', heads: { 'feat/y': HEAD } })).toBe(true);
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
  ])('denies %j with no tap: a cd after the merge does not move it', async (cmd) => {
    expect(await denied(bash(cmd), W), cmd).toBe(true);
    expect(await reasonOf(bash(cmd), W), cmd).toContain('land --pr 12');
  });
  it('denies the PowerShell forms with a cd after the merge', async () => {
    expect(await reasonOf(pwsh(`${M}; Set-Location C:\\other`), W)).toContain('land --pr 12');
    expect(await denied(pwsh(`${M}; sl C:\\other`), W)).toBe(true);
    expect(await denied(pwsh(`${REST}; Push-Location C:\\other`), W)).toBe(true);
  });
  it('judges the merge in the payload cwd, never in a later cd', async () => {
    const calls: GitCall[] = [];
    await decideParsed(bash(`${M}; cd ${O}`), deps({ ...W, calls }));
    expect(cwdsOf(calls)).toEqual(['/repo']);
  });
  it('pins: a merge in a folder that is not CCv3 passes; a land script, a named repo and a subagent do not', async () => {
    expect(await denied(bash(`cd ${O} && ${M}`), W)).toBe(false);
    expect(await denied(pwsh(`Set-Location C:\\other && ${M}`), W)).toBe(false);
    expect(await denied(pwsh(`Set-Location C:\\other; ${M}`), W)).toBe(true); // T18: the ; cd may fail
    expect(await denied(bash(`cd ${O} && ${LAND}`), W)).toBe(true);
    expect(await denied(bash(`cd ${O} && ${M} -R ${REPO}`), W)).toBe(true);
    expect(await denied(bash(`cd ${O} && GH_REPO=${REPO} ${M}`), W)).toBe(true);
    expect(await denied(bash(`cd ${O} && gh pr merge https://github.com/${REPO}/pull/12 --match-head-commit ${HEAD}`), W)).toBe(true);
    expect(await denied(bash(`cd ${O} && ${M}`, { agent_id: 'a1' }), W)).toBe(true);
  });
  it('every folder on the cd path is judged: a cd back into the repo needs the tap', async () => {
    expect(await denied(bash(`cd ${O} && cd /repo && ${M}`), W)).toBe(true);
    expect(await denied(bash(`cd /repo && cd ${O} && ${M}`), W)).toBe(true);
    land12();
    expect(await denied(bash(`cd ${O} && cd /repo && ${M}`), W)).toBe(false);
  });
  it('a relative cd chains: each folder on the path is judged', async () => {
    const calls: GitCall[] = [];
    await decideParsed(bash(`cd sub && cd deeper && ${M}`), deps({ calls }));
    expect(cwdsOf(calls)).toEqual([resolve('/repo', 'sub'), resolve('/repo', 'sub', 'deeper')]);
  });
  // The other folder is FIRST, so a de-duplication that drops the cd list keeps the shape in O and denied() would pass.
  it('two identical merges in two folders are two judgments', async () => {
    const calls: GitCall[] = [];
    const cmd = `cd ${O} && ${M}; cd /repo && ${M}`;
    expect(await denied(bash(cmd), W)).toBe(true);
    await decideParsed(bash(cmd), deps({ ...W, calls }));
    expect(cwdsOf(calls)).toContain('/repo');
    expect(cwdsOf(calls)).toContain(O);
  });
  it('two merges of two PRs: the one in the CCv3 folder needs its own tap', async () => {
    tap('land', prKey(13), HEAD, 'Land now (Recommended)');
    const cmd = `cd ${O} && ${M13}; cd /repo && ${M}`;
    expect(await reasonOf(bash(cmd), W)).toContain('PR #12');
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
  ])('denies a merge when the later cd is a %s: %j', async (_name, cmd) => {
    expect(await denied(bash(cmd), W), cmd).toBe(true);
  });
  it('denies the PowerShell -WhatIf cd, which does not move', async () => {
    expect(await denied(pwsh(`Set-Location /repo; cd C:\\other -WhatIf; ${M}`), W)).toBe(true);
  });
  it('allows the merge when the tap covers every folder on the path', async () => {
    land12();
    expect(await denied(bash(`cd /repo && true || cd ${O}; ${M}`), W)).toBe(false);
    expect(await denied(bash(`${M}; cd ${O}`), W)).toBe(false);
    expect(await denied(bash(`${REST}; cd ${O}`), W)).toBe(false);
  });
  // The squashed gh pr "merge" is found only in the quote-less reading. \" escapes in bash, not in PowerShell, so each mask hides a different cd.
  it('denies a squashed merge when the real PowerShell cd into CCv3 is hidden from the bash mask', async () => {
    const cmd = `Write-Output "a\\"; cd /repo; Write-Output \\"b"; gh pr "merge" 12 --match-head-commit ${HEAD}`;
    expect(await denied(pwsh(cmd, { cwd: SUB }), WSUB), cmd).toBe(true);
  });
  it('denies a squashed merge when a bash-visible fake cd follows the real PowerShell cd into CCv3', async () => {
    const cmd = 'cd /repo; Write-Output "a`"; cd ' + O + '; echo `"b"; gh pr "merge" 12 --match-head-commit ' + HEAD;
    expect(await denied(pwsh(cmd, { cwd: SUB }), WSUB), cmd).toBe(true);
  });

  describe('a folder that cannot be known', () => {
    it.each([
      `cd /repo && pushd ${O} && popd && ${M}`,
      `cd ${O} && popd && ${REST}`,
      `cd ${O}; cd - ; ${M}`,
    ])('denies %j with position-unknown when a CCv3 checkout is on the path', async (cmd) => {
      const d = await decideParsed(bash(cmd), deps(W));
      expect(d.action === 'deny' ? d.pattern : '', cmd).toBe('position-unknown');
    });
    it('denies position-unknown for a merge that names the repo, wherever it runs', async () => {
      const d = await decideParsed(bash(`popd && ${M} -R ${REPO}`, { cwd: SUB }), deps(WSUB));
      expect(d.action === 'deny' ? d.pattern : '').toBe('position-unknown');
    });
    it('does not deny when no folder on the path is a CCv3 checkout', async () => {
      expect(await denied(bash(`pushd ${O} && popd && ${M}`, { cwd: SUB }), WSUB)).toBe(false);
    });
    // judgeLand never reads the folder for the land script, so a pushd and popd must not block a tapped land.
    it('the land script is judged by its PR tap only: pushd and popd do not block it', async () => {
      const cmd = `pushd ${O} && popd && ${LAND}`;
      expect(await reasonOf(bash(cmd), W)).toContain('land --pr 12');
      land12();
      expect(await denied(bash(cmd), W)).toBe(false);
      expect(await denied(pwsh(`Push-Location C:\\other; Pop-Location; ${LAND}`), W)).toBe(false);
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
    ])('denies %s: the cd can fail and the push then runs in the CCv3 cwd', async (_name, cmd) => {
      expect(await denied(bash(cmd), W), cmd).toBe(true);
    });
    it('denies the PowerShell forms', async () => {
      expect(await denied(pwsh(`Set-Location C:\\other; ${PUSH}`), W)).toBe(true);
      expect(await denied(pwsh(`Set-Location C:\\other || ${PUSH}`), W)).toBe(true);
      expect(await denied(pwsh(`$true || Set-Location C:\\other && ${PUSH}`), W)).toBe(true);
    });
    it('judges the push in the cwd when a || comes before the cd', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash(`true || cd ${O} && ${PUSH}`), deps({ ...W, calls }));
      expect(cwdsOf(calls).sort()).toEqual(['/repo', O].sort());
    });
    // The & of an fd redirect (2>&1, &>file, >&2) is no joiner (FD_REDIRECT, as in pre-pr-gate): the cd is sure, the cwd is not judged.
    it.each([
      ['a 2>&1 redirect between the && joiners', `cd ${O} && npm test 2>&1 && ${PUSH}`],
      ['a &> redirect between the && joiners', `cd ${O} && npm test &> /dev/null && ${PUSH}`],
      ['a >&2 redirect between the && joiners', `cd ${O} && npm test >&2 && ${PUSH}`],
      ['a 2>&1 redirect on the cd itself', `cd ${O} 2>&1 && ${PUSH}`],
    ])('does not read the & of %s as a joiner: the cwd is not judged', async (_name, cmd) => {
      expect(await denied(bash(cmd), W), cmd).toBe(false);
      const calls: GitCall[] = [];
      await decideParsed(bash(cmd), deps({ ...W, calls }));
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
    ])('over-deny accepted: %s', async (_name, cmd) => {
      expect(await denied(bash(cmd), W), cmd).toBe(true);
    });
    it('judges the push in the cwd and in the cd folder', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash(`cd ${O} extra; ${PUSH}`), deps({ ...W, calls }));
      expect(cwdsOf(calls).sort()).toEqual(['/repo', O].sort());
    });
    it('allows the push when the tap covers the cwd', async () => {
      shipTap();
      expect(await denied(bash(`cd ${O} extra; ${PUSH}`), W)).toBe(false);
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
    ])('keeps the old prefix logic for %s: the cwd is not judged', async (_name, cmd) => {
      expect(await denied(bash(cmd), W), cmd).toBe(false);
      const calls: GitCall[] = [];
      await decideParsed(bash(cmd), deps({ ...W, calls }));
      expect(cwdsOf(calls), cmd).not.toContain('/repo');
    });
    it('keeps the old logic in PowerShell with &&', async () => {
      expect(await denied(pwsh(`Set-Location C:\\other && ${PUSH}`), W)).toBe(false);
    });
    it('a cwd that is not CCv3 and a cd that is not CCv3 still pass, whatever the joiner', async () => {
      expect(await denied(bash(`cd ${O} extra; ${PUSH}`, { cwd: SUB }), WSUB)).toBe(false);
      expect(await denied(bash(`cd ${O}; ${PUSH}`, { cwd: SUB }), WSUB)).toBe(false);
    });
    it('a cwd that is not CCv3 and a cd into CCv3 joined by ; needs the tap', async () => {
      expect(await denied(bash(`cd /repo; ${PUSH}`, { cwd: SUB }), WSUB)).toBe(true);
      shipTap();
      expect(await denied(bash(`cd /repo; ${PUSH}`, { cwd: SUB }), WSUB)).toBe(false);
    });
    it('a relative loose cd is still resolved against the cwd', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash(`cd sub; ${PUSH}`), deps({ calls }));
      expect(cwdsOf(calls).sort()).toEqual(['/repo', resolve('/repo', 'sub')].sort());
    });
    it('over-deny accepted: a loose cd followed by an absolute && cd still adds the cwd (same as planRun)', async () => {
      expect(await denied(bash(`cd ${O}; cd ${O2} && ${PUSH}`), W)).toBe(true);
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
      ])('denies %j with position-unknown when a CCv3 checkout is on the path', async (cmd) => {
        const d = await decideParsed(bash(cmd), deps(W));
        expect(d.action, cmd).toBe('deny');
        expect(d.action === 'deny' ? d.pattern : '', cmd).toBe('position-unknown');
        expect(await reasonOf(bash(cmd), W), cmd).toContain('one absolute cd');
      });
      it('denies the PowerShell Pop-Location form', async () => {
        const d = await decideParsed(pwsh(`Push-Location C:\\other; Pop-Location; ${PUSH}`), deps(W));
        expect(d.action === 'deny' ? d.pattern : '').toBe('position-unknown');
      });
      it('a ship tap does not lift it: the folder is still unknown', async () => {
        shipTap();
        expect(await denied(bash(`pushd ${O} && popd && ${PUSH}`), W)).toBe(true);
      });
      it('is a push-scope deny: it warns, not blocks, while decisions.enforcePush is absent', async () => {
        expect((await decideParsed(bash(`pushd ${O} && popd && ${PUSH}`), deps({ ...W, enforcePush: undefined }))).action).toBe('allow');
      });
      it('passes when the cwd and every folder on the known path are not a CCv3 checkout', async () => {
        expect(await denied(bash(`pushd ${O} && popd && ${PUSH}`, { cwd: SUB }), WSUB)).toBe(false);
        expect(await denied(bash(`popd && ${PUSH}`, { cwd: SUB }), WSUB)).toBe(false);
      });
      it('a --git-dir or --work-tree push still denies after a popd, even when no folder on the path is CCv3', async () => {
        expect(await denied(bash('popd && git --git-dir=/other/.git push fork feat/x', { cwd: SUB }), WSUB)).toBe(true);
        expect(await denied(bash('popd && git --work-tree /other push fork feat/x', { cwd: SUB }), WSUB)).toBe(true);
      });
      it('an absolute -C names the folder, so a popd does not make it unknown', async () => {
        expect(await denied(bash(`popd && git -C ${O} push fork feat/x`), W)).toBe(false);
        const d = await decideParsed(bash('popd && git -C /repo push fork feat/x'), deps(W));
        expect(d.action === 'deny' ? d.pattern : '').toBe('ship');
      });
      it('a popd AFTER the push does not count', async () => {
        shipTap();
        expect(await denied(bash(`cd ${O} && ${PUSH}; popd`), W)).toBe(false);
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
    ])('denies %s: the create then runs in the CCv3 cwd', async (_name, cmd) => {
      expect(await denied(bash(cmd), W), cmd).toBe(true);
      expect(await reasonOf(bash(cmd), W), cmd).toContain('open-pr --branch feat/x');
    });
    it('denies the PowerShell form', async () => {
      expect(await denied(pwsh(`Set-Location C:\\other; ${C}`), W)).toBe(true);
    });
    it('judges the create in the cwd and in the cd folder', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash(`cd ${O} extra; ${C}`), deps({ ...W, calls }));
      expect(cwdsOf(calls).sort()).toEqual(['/repo', O].sort());
    });
    it('allows the create when the tap covers the cwd', async () => {
      openTap();
      expect(await denied(bash(`cd ${O} extra; ${C}`), W)).toBe(false);
    });
    it.each([
      ['one cd and &&', `cd ${O} && ${C}`],
      ['a quoted ; between the && joiners', `cd ${O} && echo "a; b" && ${C}`],
      ['a cd after the create', `cd ${O} && ${C}; cd /repo`],
    ])('keeps the old prefix logic for %s: the cwd is not judged', async (_name, cmd) => {
      expect(await denied(bash(cmd), W), cmd).toBe(false);
    });
    it('a create split over lines (gh pr + newline + create) after a failing cd is judged in the cwd', async () => {
      expect(await denied(bash(`cd ${O}; gh pr\ncreate --draft --title t`), W)).toBe(true);
      // Over-deny accepted: the split create has no segment start, so the line end inside `gh pr\ncreate` counts as a loose joiner.
      expect(await denied(bash(`cd ${O} && gh pr\ncreate --draft --title t`), W)).toBe(true);
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
    ])('denies %s: the merge then runs in the CCv3 cwd', async (_name, cmd) => {
      expect(await reasonOf(bash(cmd), W), cmd).toContain('land --pr 12');
    });
    it('denies the PowerShell form', async () => {
      expect(await denied(pwsh(`Set-Location C:\\other; ${M}`), W)).toBe(true);
    });
    it('judges the merge in the cwd and in the cd folder', async () => {
      const calls: GitCall[] = [];
      await decideParsed(bash(`cd ${O} extra; ${M}`), deps({ ...W, calls }));
      expect(cwdsOf(calls).sort()).toEqual(['/repo', O].sort());
    });
    it('allows the merge when the tap covers the cwd', async () => {
      land12();
      expect(await denied(bash(`cd ${O} extra; ${M}`), W)).toBe(false);
    });
    it.each([
      ['one cd and &&', `cd ${O} && ${M}`],
      ['a quoted || between the && joiners', `cd ${O} && echo "a || b" && ${M}`],
      ['a cd after the merge', `cd ${O} && ${M}; cd /repo`],
    ])('keeps the old prefix logic for %s: the cwd is not judged', async (_name, cmd) => {
      expect(await denied(bash(cmd), W), cmd).toBe(false);
    });
    it('the land script is judged by its PR tap alone, whatever the joiner', async () => {
      const cmd = `cd ${O} extra; pwsh -File scripts/github/land-pr.ps1 -Pr 12`;
      expect(await reasonOf(bash(cmd), W)).toContain('land --pr 12');
      land12();
      expect(await denied(bash(cmd), W)).toBe(false);
    });
    it('a popd after a failing cd is still position-unknown', async () => {
      const d = await decideParsed(bash(`cd ${O} extra; popd; ${M}`), deps(W));
      expect(d.action === 'deny' ? d.pattern : '').toBe('position-unknown');
    });
  });
});

describe('G12 the store through move_file, write_pdf and a .. path', () => {
  it('denies Desktop Commander move_file whose destination is the store', async () => {
    expect(await denied({ tool_name: `${DC}move_file`, tool_input: { source: '/tmp/forged.json', destination: storeFile }, cwd: '/repo' })).toBe(true);
    expect(await denied({ tool_name: `${DC}move_file`, tool_input: { source: '/tmp/forged.json', destination: '/tmp/other.json' }, cwd: '/repo' })).toBe(false);
  });
  it('denies Desktop Commander write_pdf whose path is the store', async () => {
    expect(await denied({ tool_name: `${DC}write_pdf`, tool_input: { path: storeFile }, cwd: '/repo' })).toBe(true);
  });
  it('denies a Write whose path reaches the store through ..', async () => {
    expect(await denied({ tool_name: 'Write', tool_input: { file_path: 'C:/Users/dkhay/.claude/state/ccv3-mods/x/../decisions.json' }, cwd: '/repo' })).toBe(true);
    expect(await denied({ tool_name: 'Write', tool_input: { file_path: `${dir.replace(/\\/g, '/')}/x/../decisions.json` }, cwd: '/repo' })).toBe(true);
  });
  it('allows a Write whose .. path leaves the store folder', async () => {
    expect(await denied({ tool_name: 'Write', tool_input: { file_path: 'C:/Users/dkhay/.claude/state/ccv3-mods/x/../../notes.txt' }, cwd: '/repo' })).toBe(false);
  });
});

describe('G14 shell text that writes the default store path, with text after the path', () => {
  const DEF = 'C:/Users/dave/.claude/state/ccv3-mods/decisions.json';
  it('denies a write with arguments after the path', async () => {
    expect(await denied(bash(`cp /tmp/forged.json ${DEF} -f`))).toBe(true);
    expect(await denied(bash(`echo '{}' > ${DEF} 2>/dev/null`))).toBe(true);
    expect(await denied(pwsh(`Set-Content -Path ${DEF} -Value '{}'`))).toBe(true);
    expect(await denied(bash(`echo '{}' > ${DEF}; echo done`))).toBe(true);
  });
  it('denies the $HOME, ~ and %USERPROFILE% spellings', async () => {
    expect(await denied(bash(`echo '{}' > $HOME/.claude/state/ccv3-mods/decisions.json; echo ok`))).toBe(true);
    expect(await denied(bash(`echo '{}' > "$HOME/.claude/state/ccv3-mods/decisions.json" && true`))).toBe(true);
    expect(await denied(bash(`echo '{}' > ~/.claude/state/ccv3-mods/decisions.json && true`))).toBe(true);
    expect(await denied(pwsh('Set-Content -Path "$HOME\\.claude\\state\\ccv3-mods\\decisions.json" -Value \'{}\''))).toBe(true);
    expect(await denied(pwsh('Set-Content -Path "%USERPROFILE%\\.claude\\state\\ccv3-mods\\decisions.json" -Value \'{}\''))).toBe(true);
  });
  it('denies a quoted path with text after it', async () => {
    expect(await denied(pwsh(`Set-Content -Path 'C:\\Users\\dave\\.claude\\state\\ccv3-mods\\decisions.json' -Value '{}'`))).toBe(true);
    expect(await denied(bash(`tee "${DEF}" < /tmp/forged.json`))).toBe(true);
  });
  it('denies a write to the lock file, with text after it', async () => {
    expect(await denied(bash(`rm -f ${DEF}.lock -v`))).toBe(true);
  });
  it('passes a read, and a file that only starts with the same letters', async () => {
    expect(await denied(bash(`cat ${DEF} | head -5`))).toBe(false);
    expect(await denied(bash(`cp /tmp/a.json ${DEF.replace('decisions.json', 'decisions-old.json')} -f`))).toBe(false);
    expect(await denied(bash(`cp /tmp/a.json ${DEF.replace('decisions.json', 'decisions.jsonx')} -f`))).toBe(false);
  });
});

describe('G15 the store path as a tool path: streams, trailing dots and spaces, source, outputPath', () => {
  const write = async (file_path: string) => await denied({ tool_name: 'Write', tool_input: { file_path }, cwd: '/repo' });
  it('denies a path with ::$DATA or a :stream name', async () => {
    expect(await write(`${storeFile}::$DATA`)).toBe(true);
    expect(await write(`${storeFile}:evil`)).toBe(true);
  });
  it('denies a path with trailing dots or spaces', async () => {
    expect(await write(`${storeFile} `)).toBe(true);
    expect(await write(`${storeFile}.`)).toBe(true);
    expect(await write(`${storeFile}. . `)).toBe(true);
  });
  it('denies a move_file whose source is the store', async () => {
    expect(await denied({ tool_name: `${DC}move_file`, tool_input: { source: storeFile, destination: '/tmp/gone.json' }, cwd: '/repo' })).toBe(true);
  });
  it('denies a write_pdf whose outputPath is the store', async () => {
    expect(await denied({ tool_name: `${DC}write_pdf`, tool_input: { outputPath: storeFile }, cwd: '/repo' })).toBe(true);
  });
  it('still allows another file, a .. leaf and a stream of another file', async () => {
    expect(await write(`${dir.replace(/\\/g, '/')}/notes.txt::$DATA`)).toBe(false);
    expect(await write(`${dir.replace(/\\/g, '/')}/x/..`)).toBe(false);
    expect(await write('/repo/docs/decisions.json ')).toBe(false);
  });
});

describe('G13 the model burns taps from a shell', () => {
  it('denies land-decision.mjs use, in both shells, and passes check', async () => {
    expect(await denied(bash('node scripts/github/land-decision.mjs use 12 --head ' + HEAD))).toBe(true);
    expect(await denied(pwsh('node .\\scripts\\github\\land-decision.mjs use 12 --head ' + HEAD))).toBe(true);
    expect(await denied(bash('node scripts/github/land-decision.mjs check 12 --head ' + HEAD))).toBe(false);
  });
  it('denies a loop of pr-checkpoint.mjs --json --pr, and passes one run', async () => {
    expect(await denied(bash('for i in 1 2 3; do node scripts/github/pr-checkpoint.mjs --json --pr 12; done'))).toBe(true);
    expect(await denied(pwsh('1..5 | ForEach-Object { node scripts/github/pr-checkpoint.mjs --json --pr 12 }'))).toBe(true);
    expect(await denied(bash('while true; do node scripts/github/pr-checkpoint.mjs --json --pr 12; done'))).toBe(true);
    expect(await denied(bash('node scripts/github/pr-checkpoint.mjs --json --pr 12'))).toBe(false);
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
  const patternOf = async (input: object, w: World): Promise<string> => { const d = await decideParsed(input, deps(w)); return d.action === 'deny' ? d.pattern : 'allow'; };
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
    it.each(HIDDEN)('judges the shape in the folder %s names', async (_name, tpl) => {
      const cmd = tpl.replace('%S', shape);
      expect(await denied(bash(cmd, { cwd: SUB }), W), cmd).toBe(true);
      const calls: GitCall[] = [];
      await decideParsed(bash(cmd, { cwd: SUB }), deps({ ...W, calls }));
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
    ])('judges the shape in the folder PowerShell %s names', async (_name, tpl) => {
      const cmd = tpl.replace('%S', shape);
      const calls: GitCall[] = [];
      expect(await denied(pwsh(cmd, { cwd: SUB }), { ...W, calls }), cmd).toBe(true);
      expect(cwdsOf(calls), cmd).toContain('/repo');
      expect(cwdsOf(calls).filter((c) => /Path:?\/repo|PSPath/i.test(c)), cmd).toEqual([]);
    });
    it('allows a cd to a non-CCv3 folder in each new spelling', async () => {
      for (const tpl of ['builtin cd', 'command cd', 'chdir', 'cd -P', 'cd --', '{ cd']) {
        const cmd = `${tpl} ${O} && ${shape}${tpl === '{ cd' ? '; }' : ''}`;
        expect(await denied(bash(cmd, { cwd: SUB }), W), cmd).toBe(false);
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
    ])('judges the cwd too when the cd follows %s', async (_name, tpl) => {
      const cmd = tpl.replace('%S', shape);
      expect(await denied(bash(cmd), W), cmd).toBe(true);
    });
    // A cd in a subshell does not last past the `)`: the shape after it runs in the cwd. It must not be judged in the cd folder alone.
    it.each([
      ['a subshell closed before the shape', `(cd ${O}) && %S`],
      ['a command substitution closed before the shape', `x=$(cd ${O}) && %S`],
    ])('judges the cwd too after %s', async (_name, tpl) => {
      const cmd = tpl.replace('%S', shape);
      expect(await denied(bash(cmd), W), cmd).toBe(true);
    });
    it('a comment line after && does not make the cd loose', async () => {
      const cmd = `echo x &&\n# note\ncd ${O} && ${shape}`;
      expect(await denied(bash(cmd), W), cmd).toBe(false);
    });
    it('does not read the & of an fd redirect as a joiner', async () => {
      for (const cmd of [`cd ${O} 2>&1 && ${shape}`, `cd ${O} && npm test 2>&1 && ${shape}`, `cd ${O} &>/dev/null && ${shape}`, `cd ${O} && npm test >&2 && ${shape}`]) {
        expect(await denied(bash(cmd), W), cmd).toBe(closedWorldCost(cmd, shape));
      }
    });
    it.each([
      ['a pipe after the redirect', `cd ${O} && npm test 2>&1 | tail && %S`],
      ['a ; after the redirect', `cd ${O} && npm test 2>&1; %S`],
      ['a lone & after the cd', `cd ${O} & %S`],
    ])('still judges the cwd when %s', async (_name, tpl) => {
      const cmd = tpl.replace('%S', shape);
      expect(await denied(bash(cmd), W), cmd).toBe(true);
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
      it.each(UNKNOWN)('denies %s as position-unknown', async (_name, tpl) => {
        const cmd = tpl.replace('%S', shape);
        expect(await patternOf(bash(cmd), W), cmd).toBe('position-unknown');
      });
      it('a tap does not lift it', async () => {
        tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
        tap('open-pr', branchKey(), HEAD, 'Open draft PR (Recommended)');
        tap('land', prKey(12), HEAD, 'Land now (Recommended)');
        const cmd = `cd ${O} && chdir && ${shape}`;
        expect(await patternOf(bash(cmd), W), cmd).toBe('position-unknown');
      });
      it('passes when no folder on the path is CCv3', async () => {
        for (const cmd of [`chdir && ${shape}`, `builtin cd && ${shape}`, `cd -P && ${shape}`, `cd ${O} && chdir && ${shape}`]) {
          expect(await denied(bash(cmd, { cwd: SUB }), W), cmd).toBe(false);
        }
      });
    });
    it('denies the PowerShell bare forms', async () => {
      for (const cmd of [`Set-Location ${O}; chdir; ${PUSH}`, `Set-Location ${O}; sl; ${PUSH}`, `Set-Location ${O}; Set-Location; ${PUSH}`]) {
        expect(await patternOf(pwsh(cmd), W), cmd).toBe('position-unknown');
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
    ])('judges the cwd when %s is no command', async (_name, tpl) => {
      expect(await denied(bash(fill(tpl, shape)), W), fill(tpl, shape)).toBe(true);
    });
    it.each([
      ['Write-Output then cd', 'Write-Output then cd %O && %S'],
      ['Write-Output { cd', 'Write-Output { cd %O && %S'],
    ])('judges the cwd when PowerShell %s is no command', async (_name, tpl) => {
      expect(await denied(pwsh(fill(tpl, shape)), W), fill(tpl, shape)).toBe(true);
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
    ])('judges the cwd when the cd is inside %s', async (_name, tpl) => {
      expect(await denied(pwsh(fill(tpl, shape)), W), fill(tpl, shape)).toBe(true);
    });
    // The scriptblock of & and Invoke-Command runs in the current session: the location stays. Pinned (the round-1 change stays).
    it.each([
      ['& {', '& { Set-Location %O } && %S'],
      ['Invoke-Command {', 'Invoke-Command { Set-Location %O } && %S'],
    ])('does not judge the cwd after %s } moved the location (a create or a merge: a closed-world cost)', async (_name, tpl) => {
      expect(await denied(pwsh(fill(tpl, shape)), W), fill(tpl, shape)).toBe(closedWorldCost(fill(tpl, shape), shape));
    });
    // Invoke-Command names its target AFTER the block: the cd runs on another computer, in a session or as a job, and the local shell stays in the cwd.
    it.each([
      ['-ComputerName', 'Invoke-Command { Set-Location %O } -ComputerName localhost && %S'],
      ['-Session', 'Invoke-Command { Set-Location %O } -Session $s && %S'],
      ['-AsJob', 'Invoke-Command { Set-Location %O } -AsJob && %S'],
      ['-ScriptBlock and -ComputerName', 'icm -ScriptBlock { Set-Location %O } -ComputerName srv && %S'],
    ])('judges the cwd when Invoke-Command runs the cd with %s', async (_name, tpl) => {
      expect(await denied(pwsh(fill(tpl, shape)), W), fill(tpl, shape)).toBe(true);
    });
    // A parameter alias or a prefix after the block (-cn, -Comp, -CU, -VMGuid) also names another place: any parameter after the block counts (CodeRabbit CLI, 816013a).
    it.each([
      ['-cn alias', 'icm { Set-Location %O } -cn srv && %S'],
      ['-Comp prefix', 'Invoke-Command { Set-Location %O } -Comp srv && %S'],
      ['-CU alias', 'icm { Set-Location %O } -CU http://srv && %S'],
      ['-VMGuid', 'icm { Set-Location %O } -VMGuid $g && %S'],
    ])('judges the cwd when Invoke-Command runs the cd with %s', async (_name, tpl) => {
      expect(await denied(pwsh(fill(tpl, shape)), W), fill(tpl, shape)).toBe(true);
    });
    // In PowerShell a backslash is no escape: a quoted folder may end in one, and a quote inside the other kind of quote is a letter of the name.
    it.each([
      ['a double-quoted folder with a trailing backslash', 'Set-Location "%O\\" && %S'],
      ['a single-quoted folder with a trailing backslash', "Set-Location '%O\\' && %S"],
    ])('reads %s as the folder', async (_name, tpl) => {
      expect(await denied(pwsh(fill(tpl, shape), { cwd: SUB }), W), fill(tpl, shape)).toBe(false);
    });
    // The closing ) or backtick of a subshell is no part of the folder.
    it.each([
      ['a subshell', '(cd %O) && %S'],
      ['a command substitution', 'x=$(cd %O) && %S'],
      ['a backtick', 'x=`cd %O` && %S'],
    ])('reads the folder of %s without the closing mark', async (_name, tpl) => {
      expect(await denied(bash(fill(tpl, shape), { cwd: SUB }), W), fill(tpl, shape)).toBe(false);
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
    ])('judges the shape in the folder a cd names after %s', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await denied(bash(cmd, { cwd: SUB }), W), cmd).toBe(true);
    });
    it.each([
      ['a variable prefix', 'X=1 cd %O && %S'],
      ['time', 'time cd %O && %S'],
      ['a backslash', '\\cd %O && %S'],
      ['command builtin', 'command builtin cd %O && %S'],
      ['eval', 'eval cd %O && %S'],
    ])('sees the cd after %s, so a cd to a non-CCv3 folder passes (an escaped cd word with a create or a merge: a closed-world cost)', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await denied(bash(cmd), W), cmd).toBe(closedWorldCost(cmd, shape));
    });
    // A target that is partly quoted or has an escaped space is one folder.
    it.each([
      ['a quoted tail', 'cd /tmp/"other-repo" && %S'],
      ['a single-quoted tail', "cd /tmp/'other-repo' && %S"],
      ['a quoted head', "cd '/tmp'/other-repo && %S"],
      ['an escaped space', 'cd /tmp/other\\ repo && %S'],
      ['a quoted space', 'cd "/tmp/other repo" && %S'],
    ])('reads %s as the whole folder', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await denied(bash(cmd), W), cmd).toBe(false);
    });
    it.each([
      ['a comment block', '<# note #> Set-Location /repo; %S'],
      ['an assignment', '$null = Set-Location /repo; %S'],
      ['a module name', 'Microsoft.PowerShell.Management\\Set-Location /repo; %S'],
    ])('judges the shape in the folder PowerShell names after %s', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await denied(pwsh(cmd, { cwd: SUB }), W), cmd).toBe(true);
    });
    // Accepted over-deny, pinned: the target is a shell variable, so the folder is the literal `$d`. It fails closed: here the fake git reads
    // it as a CCv3 folder (tap deny); the real hook finds no such folder and denies as unjudgeable.
    it('denies a cd to a shell variable (accepted over-deny, fails closed)', async () => {
      const cmd = fill('for d in %O; do cd $d && %S; done', shape);
      expect(await denied(bash(cmd, { cwd: SUB }), W), cmd).toBe(true);
    });
  });
});

// T21 (lane decision-gate-cd-residuals): six cd shapes that pre-pr-gate reads since PR #421 and this gate did not. Each hid a CCv3 cwd behind a cd to
// another folder (fail-open), or judged a folder the text does not name. Every row runs for a push, a create and a merge. /repo is the CCv3 cwd and O is
// not CCv3, so a LOOSE row must be denied (the cwd is judged too) and a SURE row must pass (only O is judged). Regex reading only: no lexer.
describe('T21 cd residuals: subshell separators, closed braces in jobs, abbreviations, Invoke-Command, backslash and backtick targets, chdir', () => {
  const O = '/tmp/other-repo';
  const SUB = '/repo/sub';
  const W: World = { otherDirs: [O, SUB, O + '/'] }; // O + '/': an absolute target that ends in a backslash is kept as written, and the fake reads it with a slash
  const PUSH = 'git push fork feat/x';
  const C = 'gh pr create --draft --head feat/x --title t --body-file b.md';
  const M = `gh pr merge 12 --merge --match-head-commit ${HEAD}`;
  const SHAPES: [string, string][] = [['push', PUSH], ['create', C], ['merge', M]];
  const fill = (tpl: string, shape: string): string => tpl.replaceAll('%O', O).replaceAll('%S', shape);
  const cwdsOf = (calls: GitCall[]): string[] => [...new Set(calls.map((c) => c.cwd))];

  describe.each(SHAPES)('%s', (_kind, shape) => {
    // 1. A cd after a separator INSIDE an open ( or $( may not last: the shape after the `)` runs in the cwd.
    it.each([
      ['(true && cd O) && S', '(true && cd %O) && %S'],
      ['(true; cd O) && S', '(true; cd %O) && %S'],
      ['x=$(true; cd O) && S', 'x=$(true; cd %O) && %S'],
      ['echo $(true && cd O) && S', 'echo $(true && cd %O) && %S'],
      ['a backtick with a ;', 'x=`true; cd %O` && %S'],
      ['a process substitution', 'cat <(true; cd %O) && %S'],
      ['a nested group before the cd', '(true && (echo y); cd %O) && %S'],
    ])('1: judges the cwd too: %s', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await denied(bash(cmd), W), cmd).toBe(true);
    });
    it('1: a PowerShell subexpression with a ; before the cd is loose', async () => {
      const cmd = fill('$d = (1; Set-Location %O) && %S', shape);
      expect(await denied(pwsh(cmd), W), cmd).toBe(true);
    });
    it.each([
      ['a subshell closed before the cd', '(true; echo y); cd %O && %S'],
      ['a substitution closed before the cd', 'x=$(echo y); cd %O && %S'],
      ['a backtick pair closed before the cd', 'x=`echo y`; cd %O && %S'],
    ])('1: pinned, the cd stays sure after %s', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await denied(bash(cmd), W), cmd).toBe(false);
    });

    // 2. A closed } inside a job block does not end the block: the cd after it still runs in the job.
    it.each([
      ['if (1) {}', 'Start-Job { if (1) {}; Set-Location %O } && %S'],
      ['a hashtable', 'Start-Job { $h = @{}; Set-Location %O } && %S'],
      ['a closed block with a body', 'Start-Job { if ($true) { $null }; Set-Location %O } && %S'],
      ['Start-ThreadJob and foreach', 'Start-ThreadJob { foreach ($i in 1) {}; Set-Location %O } && %S'],
      ['pwsh -Command', 'pwsh -NoProfile -Command { if (1) {}; Set-Location %O } && %S'],
      ['-Parallel', '1 | ForEach-Object -Parallel { if (1) {}; Set-Location %O } && %S'],
      ['a hashtable argument before the block', 'Start-Job -ArgumentList @{a=1} -ScriptBlock { Set-Location %O } && %S'],
    ])('2: judges the cwd when a closed brace comes before the cd in %s', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await denied(pwsh(cmd), W), cmd).toBe(true);
    });
    it('2: pinned, a job block that closed before the cd does not make it loose', async () => {
      const cmd = fill('Start-Job { $null }; Set-Location %O && %S', shape);
      expect(await denied(pwsh(cmd), W), cmd).toBe(closedWorldCost(cmd, shape));
    });

    // 3. -Pa and -Para are abbreviations of -Parallel (and -As, -AsJo of -AsJob).
    it.each([
      ['-Pa', '1 | % -Pa { $null; Set-Location %O } && %S'],
      ['-Para', '1 | ForEach-Object -Para { $null; Set-Location %O } && %S'],
      ['-Parall', '1 | ForEach-Object -Parall { Set-Location %O } && %S'],
      ['-AsJo', '1 | ForEach-Object -AsJo { $null; Set-Location %O } && %S'],
      ['-As', 'icm -As { Set-Location %O } && %S'],
    ])('3: judges the cwd when the cd is inside a block of %s', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await denied(pwsh(cmd), W), cmd).toBe(true);
    });

    // 4. Invoke-Command runs the cd elsewhere when a parameter comes before the block, an && sits inside it, or a splat follows it.
    it.each([
      ['a parameter before the block', 'Invoke-Command -ComputerName srv -ScriptBlock { $null; Set-Location %O } && %S'],
      ['icm -cn before the block', 'icm -cn srv { $null; Set-Location %O } && %S'],
      ['a word before the block', 'Invoke-Command srv { $null; Set-Location %O } && %S'],
      ['-Session before the block', 'Invoke-Command -Session $s { $null; Set-Location %O } && %S'],
      ['a splat before the block', 'Invoke-Command @p { Set-Location %O } && %S'],
      ['an && inside the block and -cn after it', 'Invoke-Command { Set-Location %O && $null } -cn srv && %S'],
      ['a splat after the block', 'Invoke-Command { Set-Location %O } @p && %S'],
      ['a nested block and -cn after it', 'Invoke-Command { if (1) { Set-Location %O } } -cn srv && %S'],
    ])('4: judges the cwd with %s', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await denied(pwsh(cmd), W), cmd).toBe(true);
    });
    it('4: pinned, a local scriptblock stays a sure cd', async () => {
      const cmd = fill('Invoke-Command -ScriptBlock { Set-Location %O } && %S', shape);
      expect(await denied(pwsh(cmd), W), cmd).toBe(closedWorldCost(cmd, shape));
    });

    // 5. A PowerShell target that ends in a backslash must not swallow the next separator (`\&`, `\;` were read as an escape).
    it.each([
      ['a backslash then &&', 'Set-Location %O\\&& %S'],
      ['a backslash, a space, then &&', 'Set-Location %O\\ && %S'],
    ])('5: reads the folder without the separator after %s', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      const calls: GitCall[] = [];
      expect(await denied(pwsh(cmd), { ...W, calls }), cmd).toBe(false);
      expect(cwdsOf(calls).filter((c) => /[;&|]/.test(c)), cmd).toEqual([]);
    });
    it('5: a backslash then | ends the folder; the pipe makes the cd loose, so the cwd is judged too', async () => {
      const cmd = fill('Set-Location %O\\|Out-Null; %S', shape);
      const calls: GitCall[] = [];
      expect(await denied(pwsh(cmd), { ...W, calls }), cmd).toBe(true);
      expect(cwdsOf(calls).filter((c) => /[;&|]/.test(c)), cmd).toEqual([]);
    });
    it('5: a ; after the backslash is a separator, so the next cd is read', async () => {
      const cmd = fill('Set-Location %O\\; Set-Location /repo; %S', shape);
      const calls: GitCall[] = [];
      expect(await denied(pwsh(cmd, { cwd: SUB }), { ...W, calls }), cmd).toBe(true);
      expect(cwdsOf(calls), cmd).toContain('/repo');
      expect(cwdsOf(calls).filter((c) => /[;&|]/.test(c)), cmd).toEqual([]);
    });

    // The command positions pre-pr-gate reads since #421 (a redirect prefix, an option after command, builtin or time, a += prefix): the cd is seen, so /repo is judged.
    it.each([
      ['a redirect prefix', '2>/dev/null cd /repo && %S'],
      ['an output redirect prefix', '>/dev/null cd /repo && %S'],
      ['command -p', 'command -p cd /repo && %S'],
      ['command --', 'command -- cd /repo && %S'],
      ['builtin --', 'builtin -- cd /repo && %S'],
      ['time -p', 'time -p cd /repo && %S'],
      ['a += prefix', 'Y+=1 cd /repo && %S'],
    ])('judges the shape in the folder a cd names after %s', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await denied(bash(cmd, { cwd: SUB }), W), cmd).toBe(true);
    });

    // 6. A bash backtick substitution as the target names a folder this hook cannot expand. It is read as a target, so the folder is unexpanded: a deny in any checkout
    // (T22 reads the `..` forms). Before round 2 the folder was only a path that does not exist, and a `/..` after the backticks made it the cwd.
    it.each([
      ['a backtick substitution', 'cd `echo /repo` && %S'],
      ['a backtick substitution after ;', 'true; cd `pwd` && %S'],
      ['a backtick substitution in a path', 'cd `pwd`/x && %S'],
    ])('6: does not skip the cd with %s', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      const calls: GitCall[] = [];
      const d = await decideParsed(bash(cmd, { cwd: SUB }), deps({ ...W, calls }));
      expect(d.action === 'deny' && d.pattern, cmd).toBe('cd-unexpanded');
      expect(cwdsOf(calls).some((c) => c.includes('`')), cmd).toBe(false); // no git runs in the unexpanded folder
    });
  });

  // chdir is a cd word: a chdir before a commit and a push is the one cd the ship rule allows.
  it('chdir: a commit and a push after a chdir is judged on the index tree, like cd', async () => {
    const INDEX = 'i'.repeat(40);
    tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', INDEX);
    for (const cd of ['cd /repo', 'chdir /repo']) {
      const cmd = `${cd} && git commit -F m.txt && ${PUSH}`;
      expect(await denied(bash(cmd), { indexTree: INDEX }), cmd).toBe(false);
    }
  });
});

// T22 (lane decision-gate-cd-residuals, round 2): nine shapes two reviewers reproduced in a real shell. /repo is the CCv3 checkout with no tap, O is not CCv3.
// The cwd is O, so a fail-open row is one where the gate judges only O and the real shell runs in /repo. Regex reading only: no lexer, no tokenizer.
const patternOf = async (input: object, w?: World): Promise<string> => { const d = await decideParsed(input, deps(w)); return d.action === 'deny' ? d.pattern : d.action; };
describe('T22 reviewer shapes: unexpanded targets that cancel, GIT_DIR, cd aliases, spelled cd names, wrappers, comment lines', () => {
  const O = '/tmp/other-repo';
  const W: World = { otherDirs: [O] };
  const PUSH = 'git push fork feat/x';
  const C = 'gh pr create --draft --head feat/x --title t --body-file b.md';
  const M = `gh pr merge 12 --merge --match-head-commit ${HEAD}`;
  const SHAPES: [string, string][] = [['push', PUSH], ['create', C], ['merge', M]];
  const fill = (tpl: string, shape: string): string => tpl.replaceAll('%O', O).replaceAll('%S', shape);

  describe.each(SHAPES)('%s', (kind, shape) => {
    // 1. A variable, a command substitution or a ~ in the target, then a `..` that cancels it: the folder looks like the cwd, the shell is somewhere else.
    it.each([
      ['$D/..', 'cd $D/.. && %S'],
      ['"$D"/..', 'cd "$D"/.. && %S'],
      ['${D}/..', 'cd ${D}/.. && %S'],
      ['$PWD/..', 'cd $PWD/.. && %S'],
      ['"$(pwd)/.."', 'cd "$(pwd)/.." && %S'],
      ['"$(git rev-parse --show-toplevel)/.."', 'cd "$(git rev-parse --show-toplevel)/.." && %S'],
      ['$(pwd)/.. unquoted', 'cd $(pwd)/.. && %S'],
      ['a backtick pair then /..', 'cd `pwd`/.. && %S'],
      ['~/..', 'cd ~/.. && %S'],
      ['a later cd .. after a variable', 'cd $D && cd .. && %S'],
      ['a variable in the first cd, a sure one after it', 'cd $D && cd %O && %S'],
    ])('1: bash %s is an unexpanded target: deny, cwd is not enough', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await patternOf(bash(cmd, { cwd: O }), W), cmd).toBe('cd-unexpanded');
    });
    it.each([
      ['$d/.. in Set-Location', '$d = "x"; Set-Location $d\\..; %S'],
      ['$d/.. in cd', "$d='x'; cd $d/..; %S"],
      ['$PWD/..', 'cd $PWD/..; %S'],
      ['a subexpression', 'cd (Join-Path $a ..); %S'],
      ['$env: variable', 'Set-Location $env:HOME\\..; %S'],
    ])('1: pwsh %s is an unexpanded target: deny', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await patternOf(pwsh(cmd, { cwd: O }), W), cmd).toBe('cd-unexpanded');
    });
    it('1: pinned, the target names a plain folder: no unexpanded deny', async () => {
      const cmd = fill('cd %O && cd %O && %S', shape);
      expect(await patternOf(bash(cmd, { cwd: O }), W), cmd).toBe('allow');
    });
    it('1: pinned, a single-quoted $ is literal in bash but the hook cannot tell it apart: deny (fail closed)', async () => {
      expect(await patternOf(bash(fill("cd '$D'/.. && %S", shape), { cwd: O }), W)).toBe('cd-unexpanded');
    });
    it('1: a scope that is off warns instead of denying (the flag of its scope)', async () => {
      const flag = kind === 'push' ? { enforcePush: false } : { enforce: false };
      const d = await decideParsed(bash(fill('cd $D/.. && %S', shape), { cwd: O }), deps({ ...W, ...flag }));
      expect(d.action).toBe('allow');
    });

    // 2. GIT_DIR and GIT_WORK_TREE in the environment name another repo than the folder: the flag forms were denied, the env forms were not.
    const MOVED = kind === 'push' ? 'push-target-unresolved' : 'repo-moved';
    it.each([
      ['a prefix', 'GIT_DIR=/repo/.git %S'],
      ['a prefix with a work tree', 'GIT_WORK_TREE=/repo %S'],
      ['export, then the shape', 'export GIT_DIR=/repo/.git; %S'],
      ['env', 'env GIT_DIR=/repo/.git %S'],
      ['a quoted assignment given to env', 'env "GIT_DIR=/repo/.git" %S'],
      ['a quoted value', 'GIT_DIR="/repo/.git" %S'],
    ])('2: bash %s', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await patternOf(bash(cmd, { cwd: O }), W), cmd).toBe(MOVED);
    });
    it.each([
      ['$env: with a quote', "$env:GIT_DIR='/repo/.git'; %S"],
      ['$env: with spaces', "$env:GIT_DIR = '/repo/.git'; %S"],
      ['$env: work tree', "$env:GIT_WORK_TREE = '/repo'; %S"],
    ])('2: pwsh %s', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await patternOf(pwsh(cmd, { cwd: O }), W), cmd).toBe(MOVED);
    });
    it('2: pinned, a quoted mention of the name without an assignment is text', async () => {
      expect(await patternOf(bash(fill('echo "the GIT_DIR variable" && %S', shape), { cwd: O }), W)).toBe('allow');
    });
    it('2: pinned, a quoted GIT_DIR= in an argument is text (a commit message that names it must not block the ship)', async () => {
      expect(await patternOf(bash(fill('echo "GIT_DIR=x" && %S', shape), { cwd: O }), W)).toBe('allow');
      expect(await patternOf(bash(fill("git commit -m 'deny GIT_DIR= env forms' && %S", shape), { cwd: O }), W)).toBe('allow');
    });
    it.each([
      ['an unquoted read', 'echo $GIT_DIR && %S'],
      ['unset', 'unset GIT_DIR && %S'],
      ['export with a quoted assignment', 'export "GIT_DIR=/repo/.git"; %S'],
      ['env with an option and a quoted assignment', 'env -i "GIT_WORK_TREE=/repo" %S'],
      ['a quoted assignment at a command position', '"GIT_DIR=/repo/.git" env %S'],
    ])('2: %s is read as a GIT_DIR move (ACCEPTED over-deny for the reads)', async (_name, tpl) => {
      expect(await patternOf(bash(fill(tpl, shape), { cwd: O }), W), tpl).toBe(MOVED);
    });

    // 3. An alias for cd (bash alias, PowerShell Set-Alias): the folder the alias moves to is not readable.
    it.each([
      ['alias go=cd', 'alias go=cd\ngo /repo && %S'],
      ["alias go='cd'", "alias go='cd'; go /repo && %S"],
      ['alias with shopt', 'shopt -s expand_aliases\nalias go=pushd\ngo /repo && %S'],
      ['alias chdir', 'true && alias go="chdir"; go /repo && %S'],
    ])('3: bash %s', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await patternOf(bash(cmd, { cwd: O }), W), cmd).toBe(MOVED);
    });
    it.each([
      ['Set-Alias', 'Set-Alias go Set-Location; go /repo; %S'],
      ['Set-Alias -Name -Value', 'Set-Alias -Name go -Value Set-Location; go /repo; %S'],
      ['New-Alias sl', 'New-Alias go sl; go /repo; %S'],
      ['sal', 'sal go cd; go /repo; %S'],
    ])('3: pwsh %s', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await patternOf(pwsh(cmd, { cwd: O }), W), cmd).toBe(MOVED);
    });
    it('3: pinned, an alias for something else is no cd alias', async () => {
      const a1 = fill("alias ll='ls -l'; %S", shape);
      const a2 = fill('Set-Alias ll Get-ChildItem; %S', shape);
      expect(await patternOf(bash(a1, { cwd: O }), W)).toBe(closedWorldCost(a1, shape) ? 'not-inert' : 'allow');
      expect(await patternOf(pwsh(a2, { cwd: O }), W)).toBe(closedWorldCost(a2, shape) ? 'not-inert' : 'allow');
    });

    // 4. A cd name spelled with a backslash or an empty quote pair between the letters: bash still runs cd.
    it.each([
      ['c\\d', 'c\\d /repo && %S'],
      ["c''d", "c''d /repo && %S"],
      ['c""d', 'c""d /repo && %S'],
      ["''cd", "''cd /repo && %S"],
      ['p\\ushd', 'p\\ushd /repo && %S'],
      ['ch\\dir', 'ch\\dir /repo && %S'],
    ])('4: %s is read as a cd to /repo, so /repo is judged', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await denied(bash(cmd, { cwd: O }), W), cmd).toBe(true);
    });
    it('4: pinned, the spelled cd is READ: a sure cd to O is judged in O only, even from the /repo cwd', async () => {
      const s1 = fill('c\\d %O && %S', shape);
      expect(await denied(bash(s1, { cwd: '/repo' }), W)).toBe(closedWorldCost(s1, shape));
      expect(await denied(bash(fill("c''d %O && %S", shape), { cwd: '/repo' }), W)).toBe(false);
    });
    it('4: a spelled bare cd is a position-unknown cd', async () => {
      expect(await patternOf(bash(fill('c\\d && %S', shape), { cwd: '/repo' }), W)).toBe('position-unknown');
    });

    // 9. A comment line with an open ( or backtick opens no subshell. It made the next line's cd loose.
    it.each([
      ['a comment with (', '# (x\ncd %O && %S'],
      ['a comment with a backtick', '# run `x\ncd %O && %S'],
      ['a comment after a command', 'echo a # (x\ncd %O && %S'],
      ['a comment with $(', '# build $(x\ncd %O && %S'],
    ])('9: %s does not make the cd loose', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await denied(bash(cmd, { cwd: '/repo' }), W), cmd).toBe(false);
    });
    it.each([
      ['a ( in the middle of a word is no comment', 'echo a#(x\ncd %O && %S'],
      ['a ( after an escaped space is no comment', 'echo a\\ #(x\ncd %O && %S'],
      ['a real subshell after a comment', '# c\n(true; cd %O) && %S'],
    ])('9: pinned, %s: the cd stays loose', async (_name, tpl) => {
      const cmd = fill(tpl, shape);
      expect(await denied(bash(cmd, { cwd: '/repo' }), W), cmd).toBe(true);
    });
  });

  // 8. A wrapper before git: env, nice, timeout, xargs, setsid, sudo with options. The push is the same push. /repo is the cwd, there is no tap.
  describe('8: a wrapper before git push is still a push', () => {
    it.each([
      'env git push fork feat/x',
      'env GIT_TRACE=0 git push fork feat/x',
      'env -i git push fork feat/x',
      'env -u FOO git push fork feat/x',
      'nice git push fork feat/x',
      'nice -n 5 git push fork feat/x',
      'timeout 60 git push fork feat/x',
      'timeout -s KILL 60s git push fork feat/x',
      'timeout --foreground 60 git push fork feat/x',
      'echo | xargs git push fork feat/x',
      'echo x | xargs -n 1 git push fork feat/x',
      'setsid git push fork feat/x',
      'sudo -u bob git push fork feat/x',
      'true && env GIT_TRACE=0 nice -n 5 timeout 60 git push fork feat/x',
    ])('denies %s with no tap', async (cmd) => {
      // Round 3 C4 (Dave 2026-11-15): a step before the push that the gate does not model is a hard deny, push-state-unknown. A pipe into xargs and a `true &&` come before the push.
      expect(await patternOf(bash(cmd), {}), cmd).toBe(/^(?:echo|true)\b/.test(cmd) ? 'push-state-unknown' : 'ship');
    });
    it('an allowed shape stays allowed behind a wrapper (main, and a non-push git command)', async () => {
      expect(await denied(bash('env git push fork main'))).toBe(false);
      expect(await denied(bash('timeout 60 git fetch fork'))).toBe(false);
      expect(await denied(bash('nice -n 5 git status'))).toBe(false);
    });
    it('a tap licenses the wrapped push like the plain one', async () => {
      tap('ship', branchKey(), HEAD, 'Commit and push (Recommended)', TREE);
      expect(await denied(bash('timeout 60 git push fork feat/x'))).toBe(false);
    });
  });
});
