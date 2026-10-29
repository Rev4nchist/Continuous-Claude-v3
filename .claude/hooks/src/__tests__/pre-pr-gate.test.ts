/**
 * pre-pr-gate tests. How the hook can fail, and the test that catches it (written before the code):
 *
 * Shape (what counts as opening a PR)
 *   - a PR-create command passes without a stamp                       -> D1
 *   - a read-only gh call is denied, or spawns git                     -> A1
 * Repo (only Rev4nchist/Continuous-Claude-v3 is gated)
 *   - another repo is denied                                           -> A2
 *   - the upstream parcadei remote or a longer repo name counts        -> A3
 *   - any remote name but "origin" is missed                           -> A3
 *   - the repo named in the command is ignored for the checkout's      -> A2, D1
 * Stamp
 *   - a stamp for another head passes                                  -> D3
 *   - a stamp over 24 hours old, or from the future, passes            -> D4
 *   - a malformed stamp passes or crashes                              -> D5
 *   - the stamp is read from the wrong checkout                        -> D6, D7
 *   - the branch being opened is not the one compared                  -> D6
 * Override
 *   - the override works when it is not a leading assignment           -> O1
 *   - the override is not logged                                       -> O1
 *   - the deny text teaches the override                               -> D2
 * Body (the stamp holds the sha256 of the body pre-pr.mjs checked; the hook must be able to compare it)
 *   - an inline, stdin, --fill or missing body passes unchecked        -> X1, X2, X3
 *   - the override stops working for those                             -> X4
 *   - a quoted body path with spaces is cut at the first space         -> X5, X6, X7
 *   - a quoted stdin marker is read as a file named "-"                -> X5
 * Checkout identity
 *   - an explicit CCv3 target skips the "is this a CCv3 checkout" test -> X8 (X9: a CCv3 checkout stays allowed)
 * Critic review of PR1
 *   - a repeated body flag, --input or a second body source passes      -> Y1 (Y2: a normal create stays allowed)
 *   - --repo HOST/OWNER/REPO, a URL, a glued -R or GH_REPO skips identity -> Y3, Y4, Y5
 *   - gh pr create -F <file> is denied as not a file                   -> Y6
 *   - an unexpanded body path gives a misleading reason                -> Y7
 * Fail open
 *   - bad input, a git crash, or another tool blocks the call          -> F1
 * Wiring
 *   - registered on Bash only, or the dist file is missing             -> W1
 *   - the stamp path drifts from pre-pr.mjs                            -> W2
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isPrOpenCommand } from '../pr-opened-review-loop.js';
import * as gateModule from '../pre-pr-gate.js';
import {
  CCV3_REPO,
  MAX_STAMP_AGE_MS,
  STAMP_REL,
  bodyFileOf,
  decide,
  handle,
  hasOverride,
  headBranchOf,
  GIT_TIMEOUT_MS,
  isCcv3Remote,
  makeGit,
  namedRepo,
  type Deps,
} from '../pre-pr-gate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const NOW = Date.parse('2026-10-27T12:00:00Z');
const HEAD = 'a'.repeat(40);
const ROOT = '/work/ccv3';
const CCV3_REMOTES = 'fork\thttps://github.com/Rev4nchist/Continuous-Claude-v3.git (fetch)\nfork\thttps://github.com/Rev4nchist/Continuous-Claude-v3.git (push)\n';

/** The default body file of the CREATE and CONTINUED fixtures. deps() serves its text and stampJson() hashes it. */
const DEFAULT_BODY_TEXT = 'default body\n';
const DEFAULT_BODY_PATH = resolve('/work/default-body.md');
const DB = DEFAULT_BODY_PATH.replace(/\\/g, '/');
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

type GitFn =(cwd: string, args: string[]) => { status: number; stdout: string };

function stampJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ head: HEAD, branch: 'feat/x', at: new Date(NOW - 3_600_000).toISOString(), body_sha256: sha256(DEFAULT_BODY_TEXT), results: [], ...over });
}

function deps(over: { stamp?: string | null; remotes?: string; gitFail?: boolean; head?: string; calls?: Array<{ cwd: string; args: string[] }>; worktrees?: string; stamps?: Record<string, string>; pushed?: string | null; branch?: string } = {}): Deps {
  const git: GitFn = (cwd, args) => {
    over.calls?.push({ cwd, args });
    if (over.gitFail) return { status: 128, stdout: '' };
    const key = args.join(' ');
    if (key === 'rev-parse --show-toplevel') return { status: 0, stdout: `${cwd}\n` };
    if (key === 'remote -v') return { status: 0, stdout: over.remotes ?? CCV3_REMOTES };
    if (key === 'worktree list --porcelain') return { status: 0, stdout: over.worktrees ?? '' };
    if (key === 'rev-parse HEAD') return { status: 0, stdout: `${over.head ?? HEAD}\n` };
    if (key === 'branch --show-current') return { status: 0, stdout: `${over.branch ?? 'feat/x'}\n` };
    // The pushed head: refs/remotes/fork/<branch>. Absent unless the test sets `pushed`.
    if (args[0] === 'rev-parse' && args[1] === '--verify' && String(args[3]).startsWith('refs/remotes/fork/')) return over.pushed ? { status: 0, stdout: `${over.pushed}\n` } : { status: 1, stdout: '' };
    if (args[0] === 'rev-parse' && args[1]?.endsWith('^{commit}')) return over.head === 'unresolvable' ? { status: 128, stdout: '' } : { status: 0, stdout: `${over.head ?? HEAD}\n` };
    return { status: 1, stdout: '' };
  };
  return {
    git,
    readFile: (p) => {
      if (p === DEFAULT_BODY_PATH && !(over.stamps && p in over.stamps)) return DEFAULT_BODY_TEXT;
      if (over.stamps) return over.stamps[p] ?? null;
      return over.stamp === undefined ? null : over.stamp;
    },
    now: () => NOW,
    env: {},
  };
}

const input = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd: ROOT, ...extra });

// Every create names the default body file: the hook allows a create only when it can hash the body.
const CREATE = [
  `gh pr create --body-file ${DB}`,
  `gh pr create --base main --head feat/x --title "t" --body-file ${DB}`,
  `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f title=t -f head=feat/x -f base=main -F body=@${DB}`,
  `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls --method POST -f title=t -F body=@${DB}`,
  `gh api -X POST repos/Rev4nchist/Continuous-Claude-v3/pulls -f title=t -F body=@${DB}`,
  `gh api --method=POST repos/Rev4nchist/Continuous-Claude-v3/pulls -f title=t -F body=@${DB}`,
  `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -f title=t -f head=feat/x -F body=@${DB}`,
];

const CONTINUED = [
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls `\n  -X POST `\n  -f title=t -F body=@' + DB,
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls `\r\n  --method POST `\r\n  -f title=t -F body=@' + DB,
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls \\\n  -X POST \\\n  -f title=t -F body=@' + DB,
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls \\\r\n  -f title=t \\\r\n  -f head=feat/x -F body=@' + DB,
  'gh api -X POST `\n  repos/Rev4nchist/Continuous-Claude-v3/pulls `\n  -f title=t -F body=@' + DB,
  'gh pr create `\n  --body-file ' + DB,
  // Bash deletes a backslash-newline outright, so a word split across lines runs as one word (CLI review, d2403f3).
  'gh a\\\npi repos/Rev4nchist/Continuous-Claude-v3/pulls -f title=x -F body=@' + DB,
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pu\\\nlls -X POST -f title=x -F body=@' + DB,
  'gh pr cre\\\r\nate --body-file ' + DB,
];

// Not a PR create, though the text names /pulls or a method. Each was a false deny or a miss before P2-d.
const NOT_CREATE = [
  'gh api repos/Rev4nchist/Continuous-Claude-v3/issues/5/comments -X POST -f body="see https://github.com/Rev4nchist/Continuous-Claude-v3/pulls"',
  "gh api repos/Rev4nchist/Continuous-Claude-v3/issues/5/comments -f body='details at /pulls'",
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls/12 -X PATCH -f state=closed',
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls/12/merge -X PUT -f merge_method=merge',
  'gh api repos/Rev4nchist/Continuous-Claude-v3/issues/5/comments --input ./tmp/pulls',
  'gh api repos/Rev4nchist/Continuous-Claude-v3/issues/5/labels -X POST -F labels[]=x -H "X-Note: /pulls"',
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls\n-X POST',
];

describe('P: continued lines and field values', () => {
  it('P1: a command continued with a backtick or a backslash is one command and is denied without a stamp', () => {
    for (const c of CONTINUED) {
      expect(isPrOpenCommand(c), JSON.stringify(c)).toBe(true);
      for (const tool of ['Bash', 'PowerShell']) {
        expect(decide(input(c, { tool_name: tool }), deps({ stamp: null })).action, `${tool}: ${JSON.stringify(c)}`).toBe('deny');
      }
      expect(decide(input(c), deps({ stamp: stampJson() })).action, JSON.stringify(c)).toBe('allow');
    }
  });

  it('P2: a bare newline still ends a command: the next line is another command', () => {
    expect(isPrOpenCommand('gh api repos/o/r/pulls\n-X POST')).toBe(false);
    expect(isPrOpenCommand('gh api repos/o/r/pulls --jq ".[0]" `\n  --paginate')).toBe(false);
  });

  it('P3: /pulls inside a field value, a header or an --input path is not the endpoint; a PATCH or merge is not a create', () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    for (const c of NOT_CREATE) {
      expect(isPrOpenCommand(c), c).toBe(false);
      expect(decide(input(c), deps({ calls, stamp: null })).action, c).toBe('allow');
    }
    expect(calls).toEqual([]);
  });

  it('P4: the pulls endpoint is still a create when a field value or --input is given', () => {
    for (const c of [
      'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls --input body.json',
      'gh api "repos/Rev4nchist/Continuous-Claude-v3/pulls" -f title="/pulls" -f head=feat/x',
      'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -f title="two words" -X POST',
    ]) {
      expect(isPrOpenCommand(c), c).toBe(true);
      expect(decide(input(c), deps({ stamp: null })).action, c).toBe('deny');
    }
  });
});

describe('A: only PR-create shapes are looked at', () => {
  it('A1: other commands are allowed and never spawn git', () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    for (const c of [
      'ls -la',
      'gh pr view 5',
      'gh pr list',
      'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls/5/comments',
      'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X GET',
      'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls --jq ".[0]"',
      'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls/12/reviews -X POST -f body=x',
      'git push fork feat/x',
      'node scripts/github/review-status.mjs 5',
    ]) {
      expect(decide(input(c), deps({ calls })).action, c).toBe('allow');
    }
    expect(calls).toEqual([]);
  });

  it('A2: a PR in another repo is allowed, named in the command or by the checkout', () => {
    expect(decide(input('gh api repos/other/repo/pulls -X POST -f title=t'), deps()).action).toBe('allow');
    expect(decide(input('gh pr create -R other/repo --fill'), deps()).action).toBe('allow');
    expect(decide(input('gh pr create --repo other/repo --fill'), deps()).action).toBe('allow');
    expect(decide(input('gh pr create --fill'), deps({ remotes: 'origin\thttps://github.com/other/repo.git (fetch)\n' })).action).toBe('allow');
    // The repo named in the command wins over the checkout: a CCv3 PR from a foreign checkout is gated.
    expect(decide(input('gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f title=t'), deps({ remotes: 'origin\thttps://github.com/other/repo.git (fetch)\n' })).action).toBe('deny');
  });

  it('A3: remote matching is exact: every remote name counts, upstream and longer names do not', () => {
    expect(isCcv3Remote('https://github.com/Rev4nchist/Continuous-Claude-v3.git')).toBe(true);
    expect(isCcv3Remote('git@github.com:Rev4nchist/Continuous-Claude-v3.git')).toBe(true);
    expect(isCcv3Remote('https://github.com/rev4nchist/continuous-claude-v3')).toBe(true);
    expect(isCcv3Remote('https://github.com/parcadei/Continuous-Claude-v3.git')).toBe(false);
    expect(isCcv3Remote('https://github.com/Rev4nchist/Continuous-Claude-v3-old.git')).toBe(false);
    expect(isCcv3Remote('https://github.com/Rev4nchist/Continuous-Claude-v3-old')).toBe(false);
    expect(isCcv3Remote('https://github.com/xRev4nchist/Continuous-Claude-v3.git')).toBe(false);
    const upstreamOnly = 'origin\thttps://github.com/parcadei/Continuous-Claude-v3.git (fetch)\n';
    expect(decide(input('gh pr create --fill'), deps({ remotes: upstreamOnly })).action).toBe('allow');
    const both = `${upstreamOnly}fork\thttps://github.com/Rev4nchist/Continuous-Claude-v3.git (fetch)\n`;
    expect(decide(input('gh pr create --fill'), deps({ remotes: both })).action).toBe('deny');
  });

  it('A4: a checkout that git cannot read is an internal error: decide throws and handle denies; the named CCv3 repo with no checkout is a plain deny', () => {
    expect(() => decide(input('gh pr create --fill'), deps({ gitFail: true }))).toThrow(/git remote/);
    const out = JSON.parse(handle(JSON.stringify(input('gh pr create --fill')), deps({ gitFail: true })));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/could not verify the pre-PR stamp/);
    // The command names the CCv3 repo, so the repo is known; with no checkout there is no stamp to find.
    const named = decide(input('gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f title=t'), deps({ gitFail: true }));
    expect(named.action).toBe('deny');
    expect(named.action === 'deny' && named.reason).toMatch(/not a git checkout/);
  });

  it('A5b: a foreign repo value in another command segment names nothing; the checkout decides (CodeRabbit CLI, PR B)', () => {
    for (const sep of ['; ', ' && ', ' || ', ' | ', '\n']) {
      expect(namedRepo(`gh pr ready 201${sep}gh repo view -R someone/else`), JSON.stringify(sep)).toBeNull();
      expect(namedRepo(`gh pr edit 201 --add-label review:deep${sep}GH_REPO=someone/else gh repo view`), JSON.stringify(sep)).toBeNull();
    }
    expect(namedRepo('gh pr ready 201 -R someone/else')).toBe('someone/else');
    // A leading GH_REPO statement belongs to its one call; a second segment after it still hands the choice to the checkout.
    expect(namedRepo("$env:GH_REPO='someone/else'; gh pr ready 201")).toBe('someone/else');
    expect(namedRepo("$env:GH_REPO='someone/else'; gh pr ready 201; echo hi")).toBeNull();
    expect(namedRepo('export GH_REPO=someone/else; gh pr ready 201 && gh pr view 201')).toBeNull();
    expect(namedRepo('gh pr ready 201; gh repo view -R Rev4nchist/Continuous-Claude-v3')).toBe(CCV3_REPO);
  });

  it('A5: the helpers read the repo and the head branch from raw text', () => {
    expect(namedRepo('gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST')).toBe(CCV3_REPO);
    expect(namedRepo('gh pr create -R Foo/Bar')).toBe('foo/bar');
    expect(namedRepo('gh pr create --repo=Foo/Bar')).toBe('foo/bar');
    expect(namedRepo('gh pr create --fill')).toBeNull();
    expect(headBranchOf('gh pr create --head feat/x')).toBe('feat/x');
    expect(headBranchOf('gh pr create -H feat/x')).toBe('feat/x');
    expect(headBranchOf('gh pr create --head Rev4nchist:feat/x')).toBe('feat/x');
    expect(headBranchOf('gh api repos/o/r/pulls -X POST -f head=feat/x -f base=main')).toBe('feat/x');
    expect(headBranchOf('gh api repos/o/r/pulls -X POST -F head="feat/x"')).toBe('feat/x');
    expect(headBranchOf('gh api repos/o/r/pulls -X POST -f title=t')).toBeNull();
    // -H is a header for gh api, not a head.
    expect(headBranchOf('gh api repos/o/r/pulls -X POST -H "Accept: application/json" -f head=feat/x')).toBe('feat/x');
    expect(headBranchOf('gh api repos/o/r/pulls -X POST -H "Accept: application/json"')).toBeNull();
  });
});

describe('D: the stamp decides', () => {
  it('D1: every PR-create shape is denied without a stamp, on Bash and PowerShell', () => {
    for (const c of CREATE) {
      for (const tool of ['Bash', 'PowerShell']) {
        const d = decide(input(c, { tool_name: tool }), deps({ stamp: null }));
        expect(d.action, `${tool}: ${c}`).toBe('deny');
      }
    }
  });

  it('D2: the deny reason names the exact command and does not teach the override', () => {
    const d = decide(input(CREATE[0]), deps({ stamp: null }));
    expect(d.action).toBe('deny');
    expect((d as { reason: string }).reason).toContain('node scripts/github/pre-pr.mjs --body <file>');
    expect((d as { reason: string }).reason).not.toMatch(/SKIP_PRE_PR_GATE/);
    expect((d as { reason: string }).reason).toMatch(/no stamp/i);
  });

  it('D3: a stamp for the head allows; a stamp for another head denies and names both', () => {
    for (const c of CREATE) expect(decide(input(c), deps({ stamp: stampJson() })).action, c).toBe('allow');
    const d = decide(input(CREATE[0]), deps({ stamp: stampJson({ head: 'c'.repeat(40) }) }));
    expect(d.action).toBe('deny');
    expect((d as { reason: string }).reason).toContain('ccccccc');
    expect((d as { reason: string }).reason).toContain('aaaaaaa');
    expect(decide(input(CREATE[0]), deps({ stamp: stampJson({ head: 'A'.repeat(40) }) })).action).toBe('allow');
  });

  it('D4: 24 hours is the limit; a future stamp is refused', () => {
    expect(MAX_STAMP_AGE_MS).toBe(24 * 3_600_000);
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    expect(decide(input(CREATE[0]), deps({ stamp: stampJson({ at: at(MAX_STAMP_AGE_MS - 1000) }) })).action).toBe('allow');
    const old = decide(input(CREATE[0]), deps({ stamp: stampJson({ at: at(MAX_STAMP_AGE_MS + 1000) }) }));
    expect(old.action).toBe('deny');
    expect((old as { reason: string }).reason).toMatch(/24 hours|older/i);
    expect(decide(input(CREATE[0]), deps({ stamp: stampJson({ at: at(-3_600_000) }) })).action).toBe('deny');
    expect(decide(input(CREATE[0]), deps({ stamp: stampJson({ at: at(-60_000) }) })).action).toBe('allow');
  });

  it('D5: a malformed stamp is a deny, not a crash and not an allow', () => {
    for (const s of ['{not json', '[]', 'null', '"x"', stampJson({ head: 5 }), stampJson({ head: '' }), stampJson({ at: 'yesterday' }), stampJson({ at: undefined }), JSON.stringify({ branch: 'x' })]) {
      const d = decide(input(CREATE[0]), deps({ stamp: s }));
      expect(d.action, s).toBe('deny');
    }
  });

  it('D6: the branch being opened is the head that is compared', () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const c = 'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f title=t -f head=feat/other -f base=main -F body=@' + DB;
    const d = decide(input(c), deps({ calls, stamp: stampJson(), head: 'd'.repeat(40) }));
    expect(d.action).toBe('deny');
    expect(calls.some((x) => x.args.join(' ') === 'rev-parse feat/other^{commit}')).toBe(true);
    expect(calls.some((x) => x.args.join(' ') === 'rev-parse HEAD')).toBe(false);
    expect(decide(input(c), deps({ stamp: stampJson({ head: 'd'.repeat(40) }), head: 'd'.repeat(40) })).action).toBe('allow');
    const unresolved = decide(input(c), deps({ stamp: stampJson(), head: 'unresolvable' }));
    expect(unresolved.action).toBe('deny');
    expect((unresolved as { reason: string }).reason).toMatch(/feat\/other/);
  });

  it('D7: the stamp is read from the command checkout; a cd moves it; a worktree on the branch is searched', () => {
    const seen: string[] = [];
    const d = deps({ stamp: stampJson() });
    // PR B: a non-draft create also reads review-router.config.json (the warn or enforce switch). This test is about where the STAMP is read.
    const spy: Deps = { ...d, readFile: (p) => { if (p === DEFAULT_BODY_PATH) return DEFAULT_BODY_TEXT; if (p.endsWith('review-router.config.json')) return null; seen.push(p.replace(/\\/g, '/')); return stampJson(); } };
    decide(input(CREATE[0]), spy);
    expect(seen).toEqual([`${ROOT}/${STAMP_REL}`]);
    seen.length = 0;
    decide(input(`cd /other/checkout && ${CREATE[0]}`), spy);
    expect(seen).toEqual([`/other/checkout/${STAMP_REL}`]);
    seen.length = 0;
    const wt = 'worktree /work/ccv3\nHEAD aaa\nbranch refs/heads/main\n\nworktree /work/wt-x\nHEAD bbb\nbranch refs/heads/feat/x\n';
    const c = 'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f head=feat/x -f title=t -F body=@' + DB;
    const res = decide(input(c), deps({ worktrees: wt, stamps: { [join('/work/wt-x', STAMP_REL)]: stampJson() } }));
    expect(res.action).toBe('allow');
  });
});

describe('K: the CodeRabbit CLI skip in the stamp', () => {
  const skipped = (reason: unknown) => stampJson({ cr_skipped: true, cr_skip_reason: reason });

  it('K0: cap needs a finished run; cli-missing is allowed; cli-error and the old cli-unavailable are denied', () => {
    const cap = (n?: unknown) => stampJson({ cr_skipped: true, cr_skip_reason: 'cap', ...(n === undefined ? {} : { cr_finished_runs: n }) });
    expect(decide(input(CREATE[0]), deps({ stamp: cap(1) })).action).toBe('allow');
    expect(decide(input(CREATE[0]), deps({ stamp: cap(2) })).action).toBe('allow');
    for (const n of [undefined, 0, -1, '2', null]) {
      const d = decide(input(CREATE[0]), deps({ stamp: cap(n) }));
      expect(d.action, String(n)).toBe('deny');
      expect(d.action === 'deny' && d.reason, String(n)).toMatch(/cr_finished_runs/);
    }
    expect(decide(input(CREATE[0]), deps({ stamp: skipped('cli-missing') })).action).toBe('allow');
    for (const r of ['cli-error', 'cli-unavailable']) {
      const d = decide(input(CREATE[0]), deps({ stamp: skipped(r) }));
      expect(d.action, r).toBe('deny');
      expect(d.action === 'deny' && d.reason, r).toMatch(new RegExp(r));
    }
  });

  it('K1: a stamp that skipped the review is denied unless the reason is an allowed one', () => {
    const flag = decide(input(CREATE[0]), deps({ stamp: skipped('flag') }));
    expect(flag.action).toBe('deny');
    expect(flag.action === 'deny' && flag.reason).toMatch(/skipped the CodeRabbit CLI review/);
    expect(flag.action === 'deny' && flag.reason).toMatch(/flag/);
    for (const r of [undefined, null, '', 'other']) expect(decide(input(CREATE[0]), deps({ stamp: skipped(r) })).action, String(r)).toBe('deny');
    expect(decide(input(CREATE[0]), deps({ stamp: stampJson({ cr_skipped: true, cr_skip_reason: 'cap', cr_finished_runs: 1 }) })).action).toBe('allow');
    expect(decide(input(CREATE[0]), deps({ stamp: skipped('cli-missing') })).action).toBe('allow');
    expect(decide(input(CREATE[0]), deps({ stamp: stampJson({ cr_skipped: false, cr_skip_reason: null }) })).action).toBe('allow');
    expect(decide(input(CREATE[0]), deps({ stamp: stampJson() })).action).toBe('allow');
  });
});

describe('K2: rate-limited and no-changes skips', () => {
  const skip = (reason: string, minutes?: unknown) => stampJson({ cr_skipped: true, cr_skip_reason: reason, ...(minutes === undefined ? {} : { cr_retry_minutes: minutes }) });

  it('K2: rate-limited is allowed only with a known positive retry time; no-changes and other reasons are denied', () => {
    expect(decide(input(CREATE[0]), deps({ stamp: skip('rate-limited', 12) })).action).toBe('allow');
    for (const m of [undefined, 0, -1, '12', null]) expect(decide(input(CREATE[0]), deps({ stamp: skip('rate-limited', m) })).action, String(m)).toBe('deny');
    const none = decide(input(CREATE[0]), deps({ stamp: skip('no-changes') }));
    expect(none.action).toBe('deny');
    expect(none.action === 'deny' && none.reason).toMatch(/no-changes/);
    expect(decide(input(CREATE[0]), deps({ stamp: skip('earlier-step-failed') })).action).toBe('deny');
    // A retry time does not excuse any other reason.
    expect(decide(input(CREATE[0]), deps({ stamp: skip('no-changes', 12) })).action).toBe('deny');
    expect(decide(input(CREATE[0]), deps({ stamp: skip('flag', 12) })).action).toBe('deny');
  });
});

describe('B: the pushed head and the body file', () => {
  it('B1: a pushed head (refs/remotes/fork/<branch>) must equal the stamped head', () => {
    const other = 'e'.repeat(40);
    const d = decide(input(CREATE[0]), deps({ stamp: stampJson(), pushed: other }));
    expect(d.action).toBe('deny');
    expect(d.action === 'deny' && d.reason).toContain('eeeeeee');
    expect(d.action === 'deny' && d.reason).toMatch(/pushed/);
    expect(decide(input(CREATE[0]), deps({ stamp: stampJson(), pushed: HEAD })).action).toBe('allow');
    expect(decide(input(CREATE[0]), deps({ stamp: stampJson(), pushed: null })).action).toBe('allow');
    // A named head branch is the one that is looked up.
    const calls: Array<{ cwd: string; args: string[] }> = [];
    decide(input('gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f head=feat/named -f title=t -F body=@' + DB), deps({ calls, stamp: stampJson(), pushed: HEAD }));
    expect(calls.some((c) => c.args.join(' ') === 'rev-parse --verify --quiet refs/remotes/fork/feat/named^{commit}')).toBe(true);
  });

  const BODY_PATH = resolve('/work/body.md');
  const bodyDeps = (text: string | null, stampBody: string) => {
    const stamps: Record<string, string> = { [join(ROOT, STAMP_REL)]: stampJson({ body_sha256: stampBody }) };
    if (text !== null) stamps[BODY_PATH] = text;
    return deps({ stamps });
  };
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');

  it('B2: -F body=@file or --body-file must hash to the stamp body_sha256', () => {
    const api = `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f head=feat/x -F body=@${BODY_PATH.replace(/\\/g, '/')}`;
    const cli = `gh pr create --head feat/x --body-file ${BODY_PATH.replace(/\\/g, '/')}`;
    for (const c of [api, cli]) {
      expect(decide(input(c), bodyDeps('the body\n', sha('the body\n'))).action, c).toBe('allow');
      const bad = decide(input(c), bodyDeps('an edited body\n', sha('the body\n')));
      expect(bad.action, c).toBe('deny');
      expect(bad.action === 'deny' && bad.reason).toMatch(/body file/);
      const missing = decide(input(c), bodyDeps(null, sha('the body\n')));
      expect(missing.action, c).toBe('deny');
      expect(missing.action === 'deny' && missing.reason, c).toMatch(/cannot be read/);
    }
  });

  // B3 asserted that inline, stdin and no-body creates are allowed. That is the opposite of X1 to X3, so it is removed.
});

describe('X: the PR body must be verifiable, and the body path and checkout must be read right (CodeRabbit #193 outside-diff findings)', () => {
  const BODY = resolve('/work/body.md');
  const SPACED = resolve('/work/a b/body.md');
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');
  const TEXT = 'the body\n';
  /** A fresh stamp for HEAD whose body hash matches TEXT, plus the files the hook may read. */
  const withBody = (files: Record<string, string> = {}, remotes?: string): Deps =>
    deps({ remotes, stamps: { [join(ROOT, STAMP_REL)]: stampJson({ body_sha256: sha(TEXT) }), [BODY]: TEXT, ...files } });
  const fwd = (p: string) => p.replace(/\\/g, '/');
  const denyReason = (c: string, d: Deps): string => {
    const r = decide(input(c), d);
    expect(r.action, c).toBe('deny');
    return r.action === 'deny' ? r.reason : '';
  };

  // Finding 1 (Major): bodyFileOf() is null for these, and stampProblem() then skips the body-hash check.
  it('X1: an inline body is denied with a reason that names -F body=@<file> and --body-file <file>', () => {
    for (const c of [
      'gh pr create --head feat/x --title t --body "inline text"',
      'gh pr create --head feat/x --title t --body=inline',
      'gh pr create --head feat/x --title t -b inline',
      'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f head=feat/x -f title=t -f body=inline',
    ]) {
      const why = denyReason(c, withBody());
      expect(why, c).toContain('-F body=@<file>');
      expect(why, c).toContain('--body-file <file>');
    }
  });

  it('X2: a body from stdin is denied with the same reason', () => {
    for (const c of [
      'gh pr create --head feat/x --title t --body-file -',
      'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f head=feat/x -f title=t -F body=@-',
    ]) {
      const why = denyReason(c, withBody());
      expect(why, c).toContain('-F body=@<file>');
      expect(why, c).toContain('--body-file <file>');
    }
  });

  it('X3: --fill (gh builds the body from commits) and a command with no body at all are denied with the same reason', () => {
    for (const c of [
      'gh pr create --head feat/x --fill',
      'gh pr create --head feat/x --fill-first',
      'gh pr create --head feat/x --title t',
      'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f head=feat/x -f title=t',
    ]) {
      const why = denyReason(c, withBody());
      expect(why, c).toContain('-F body=@<file>');
      expect(why, c).toContain('--body-file <file>');
    }
  });

  it('X4: the override still lets an unverifiable body through, and logs it as an override (sh form on Bash, $env form on PowerShell)', () => {
    const cases: Array<[string, string]> = [
      ['Bash', 'SKIP_PRE_PR_GATE=1 gh pr create --head feat/x --fill'],
      ['PowerShell', "$env:SKIP_PRE_PR_GATE='1'; gh pr create --head feat/x --body inline"],
    ];
    for (const [tool, c] of cases) expect(decide(input(c, { tool_name: tool }), withBody()).action, `${tool}: ${c}`).toBe('override');
    const dir = mkdtempSync(join(tmpdir(), 'prepr-gate-x4-'));
    const file = join(dir, 'guard-decisions.jsonl');
    const saved = process.env.CCV3_GUARD_DECISIONS_LOG;
    process.env.CCV3_GUARD_DECISIONS_LOG = file;
    try {
      for (const [tool, c] of cases) expect(handle(JSON.stringify(input(c, { tool_name: tool })), withBody()), `${tool}: ${c}`).toBe('{}');
    } finally {
      if (saved === undefined) delete process.env.CCV3_GUARD_DECISIONS_LOG;
      else process.env.CCV3_GUARD_DECISIONS_LOG = saved;
    }
    expect(existsSync(file), 'the override was not logged').toBe(true);
    expect(readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).decision)).toEqual(['override', 'override']);
  });

  // Finding 2 (Minor): the body path stops at the first space.
  it('X5: bodyFileOf returns the whole quoted path, with spaces, for both options and both quote kinds', () => {
    expect(bodyFileOf('gh pr create --body-file "C:/a b/body.md"')).toBe('C:/a b/body.md');
    expect(bodyFileOf("gh pr create --body-file 'C:/a b/body.md'")).toBe('C:/a b/body.md');
    expect(bodyFileOf('gh pr create --body-file="C:/a b/body.md"')).toBe('C:/a b/body.md');
    expect(bodyFileOf('gh api repos/o/r/pulls -X POST -F "body=@C:/a b/body.md"')).toBe('C:/a b/body.md');
    expect(bodyFileOf("gh api repos/o/r/pulls -X POST -F 'body=@C:/a b/body.md'")).toBe('C:/a b/body.md');
    expect(bodyFileOf('gh api repos/o/r/pulls -X POST --field body=@"C:/a b/body.md"')).toBe('C:/a b/body.md');
    expect(bodyFileOf("gh api repos/o/r/pulls -X POST -F body=@'C:/a b/body.md'")).toBe('C:/a b/body.md');
    // Unquoted paths still work, and stdin stays null whether or not the marker is quoted (no file named "-").
    expect(bodyFileOf('gh pr create --body-file C:/a/body.md')).toBe('C:/a/body.md');
    expect(bodyFileOf('gh pr create --body-file -')).toBeNull();
    expect(bodyFileOf('gh pr create --body-file "-"')).toBeNull();
    expect(bodyFileOf("gh pr create --body-file '-'")).toBeNull();
    expect(bodyFileOf('gh api repos/o/r/pulls -X POST -F body=@-')).toBeNull();
    expect(bodyFileOf("gh api repos/o/r/pulls -X POST -F 'body=@-'")).toBeNull();
    expect(bodyFileOf('gh pr create --fill')).toBeNull();
  });

  it('X6: a body file path with spaces is hashed whole: a matching body allows', () => {
    const c = `gh pr create --head feat/x --body-file "${fwd(SPACED)}"`;
    expect(decide(input(c), withBody({ [SPACED]: TEXT })).action).toBe('allow');
  });

  it('X7: a quoted path that starts with a validated file name is not read as that file (the prefix file must not stand in for the real body)', () => {
    const DRAFT = resolve(ROOT, 'draft.md');
    const c = 'gh pr create --head feat/x --body-file "draft.md unvalidated.md"';
    // draft.md is the validated file. gh would submit "draft.md unvalidated.md", which does not exist here.
    const why = denyReason(c, withBody({ [DRAFT]: TEXT }));
    expect(why).toMatch(/cannot be read|not the body/);
    expect(why).toContain('draft.md unvalidated.md');
  });

  // Finding 3 (Minor): --repo / repos/<o>/<r> naming CCv3 skips the checkout identity check.
  const FOREIGN = 'origin\thttps://github.com/other/repo.git (fetch)\norigin\thttps://github.com/other/repo.git (push)\n';
  it('X8: an explicit CCv3 target from a checkout that is not CCv3 is denied, even with a fresh stamp and a matching body', () => {
    for (const c of [
      `gh pr create --repo Rev4nchist/Continuous-Claude-v3 --head feat/x --body-file ${fwd(BODY)}`,
      `gh pr create -R Rev4nchist/Continuous-Claude-v3 --head feat/x --body-file ${fwd(BODY)}`,
      `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f head=feat/x -F body=@${fwd(BODY)}`,
    ]) {
      expect(denyReason(c, withBody({}, FOREIGN)), c).toMatch(/not a CCv3 checkout/i);
    }
  });

  it('X9: the same explicit CCv3 target from a CCv3 checkout (a worktree shares its remotes) is still allowed', () => {
    for (const c of [
      `gh pr create --repo Rev4nchist/Continuous-Claude-v3 --head feat/x --body-file ${fwd(BODY)}`,
      `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f head=feat/x -F body=@${fwd(BODY)}`,
    ]) {
      expect(decide(input(c), withBody()).action, c).toBe('allow');
    }
  });
});

describe('Y: the body flag, the repo forms and the body path are read the way gh reads them (critic review of PR1)', () => {
  const BODY = resolve('/work/body.md');
  const OTHER = resolve('/work/other.md');
  const TEXT = 'the body\n';
  const FOREIGN = 'origin\thttps://github.com/other/repo.git (fetch)\norigin\thttps://github.com/other/repo.git (push)\n';
  const fwd = (p: string) => p.replace(/\\/g, '/');
  const B = fwd(BODY);
  const O = fwd(OTHER);
  const API = 'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f head=feat/x -f title=t';
  const withBody = (over: { remotes?: string; env?: NodeJS.ProcessEnv } = {}): Deps => ({
    ...deps({ remotes: over.remotes, stamps: { [join(ROOT, STAMP_REL)]: stampJson({ body_sha256: createHash('sha256').update(TEXT).digest('hex') }), [BODY]: TEXT, [OTHER]: 'other\n' } }),
    ...(over.env ? { env: over.env } : {}),
  });
  const reasonOf = (c: string, d: Deps, tool = 'Bash'): string => {
    const r = decide(input(c, { tool_name: tool }), d);
    expect(r.action, c).toBe('deny');
    return r.action === 'deny' ? r.reason : '';
  };

  // Finding 2: gh uses the LAST value of a repeated flag, and --input replaces the whole request body.
  it('Y1: a command that names more than one body, or a second source of the body, is denied as unverifiable', () => {
    for (const c of [
      `gh pr create --head feat/x --body-file ${B} --body-file ${O}`,
      `${API} -F body=@${B} -F body=@${O}`,
      `${API} --input pr.json -F body=@${B}`,
      `gh pr create --head feat/x --body-file ${B} --body evil`,
      `gh pr create --head feat/x --title "x --body-file ${B}" --body evil`,
      `gh pr create --head feat/x --body-file ${B} -b evil`,
      `${API} -F body=@${B} -f body=evil`,
      // Equals-form fields (CodeRabbit CLI, PR1 gate run 2): gh reads --field=body=@x like --field body=@x.
      `${API} -F body=@${B} --field=body=@${O}`,
      `${API} -F body=@${B} -F=body=@${O}`,
      `${API} -F body=@${B} --raw-field=body=evil`,
      `${API} -F body=@${B} -f=body=evil`,
      `${API} -F body=@${B} --field=body=evil`,
    ]) expect(reasonOf(c, withBody()), c).toContain('--body-file <file>');
  });

  it('Y1b: one equals-form body file field is read as that file', () => {
    expect(bodyFileOf(`${API} --field=body=@${B}`)).toBe(B);
    expect(decide(input(`${API} --field=body=@${B}`), withBody()).action).toBe('allow');
  });

  it('Y2: one body file with other flags is still allowed (the Y1 checks do not deny a normal create)', () => {
    for (const c of [
      `gh pr create --head feat/x --title "a title" --body-file ${B}`,
      `${API} -F body=@${B}`,
    ]) expect(decide(input(c), withBody()).action, c).toBe('allow');
  });

  // Finding 3: gh accepts HOST/OWNER/REPO, a URL and a glued -R value.
  it('Y3: namedRepo reads the host form, the URL form and a glued -R value', () => {
    for (const c of [
      'gh pr create --repo github.com/Rev4nchist/Continuous-Claude-v3 --head feat/x',
      'gh pr create --repo=github.com/Rev4nchist/Continuous-Claude-v3 --head feat/x',
      'gh pr create --repo https://github.com/Rev4nchist/Continuous-Claude-v3 --head feat/x',
      'gh pr create -RRev4nchist/Continuous-Claude-v3 --head feat/x',
      'gh pr create -R "github.com/Rev4nchist/Continuous-Claude-v3" --head feat/x',
      // The clone URL a user copies from GitHub ends in .git; gh trims it (CodeRabbit CLI, PR1 gate run).
      'gh pr create --repo https://github.com/Rev4nchist/Continuous-Claude-v3.git --head feat/x',
      'gh pr create --repo github.com/Rev4nchist/Continuous-Claude-v3.GIT --head feat/x',
    ]) expect(namedRepo(c), c).toBe(CCV3_REPO);
    expect(namedRepo('gh pr create --repo github.com/other/repo')).toBe('other/repo');
  });

  // CodeRabbit #197 full review (outside diff, Major): endpoint-shaped text in a title replaced the real target.
  it('Y3b: endpoint text in a title or another argument never hides an explicit or checkout CCv3 target', () => {
    const OTHER_EP = 'repos/other/repo/pulls';
    // An explicit CCv3 target stays CCv3 whatever the title says.
    expect(namedRepo(`gh pr create --repo Rev4nchist/Continuous-Claude-v3 --title "see ${OTHER_EP}" --head feat/x`)).toBe(CCV3_REPO);
    // gh pr create has no endpoint: with no repo flag the checkout decides (null), even if the title holds endpoint text.
    expect(namedRepo(`gh pr create --title "${OTHER_EP}" --head feat/x`)).toBeNull();
    expect(namedRepo(`gh pr create --title "gh api ${OTHER_EP}" --head feat/x`)).toBeNull();
    // gh api: a title field that names another repo cannot hide the real CCv3 endpoint, in either order.
    expect(namedRepo(`gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f title="${OTHER_EP}" -f head=feat/x`)).toBe(CCV3_REPO);
    expect(namedRepo(`gh api -f title="${OTHER_EP}" repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f head=feat/x`)).toBe(CCV3_REPO);
    // Fail closed: CCv3 named anywhere wins over a foreign explicit target.
    expect(namedRepo('gh pr create --repo other/repo --title "repos/Rev4nchist/Continuous-Claude-v3/pulls" --head feat/x')).toBe(CCV3_REPO);
    // A real foreign target with no CCv3 text stays foreign.
    expect(namedRepo(`gh api ${OTHER_EP} -X POST -f head=feat/x`)).toBe('other/repo');
  });

  it('Y3c: a title spoof from a foreign checkout no longer skips the gate', () => {
    const c = `gh pr create --repo Rev4nchist/Continuous-Claude-v3 --title "repos/other/repo/pulls" --head feat/x --body-file ${B}`;
    expect(reasonOf(c, withBody({ remotes: FOREIGN })), c).toMatch(/not a CCv3 checkout/i);
  });

  it('Y4: those repo forms from a foreign checkout are denied', () => {
    for (const c of [
      `gh pr create --repo github.com/Rev4nchist/Continuous-Claude-v3 --head feat/x --body-file ${B}`,
      `gh pr create -RRev4nchist/Continuous-Claude-v3 --head feat/x --body-file ${B}`,
    ]) expect(reasonOf(c, withBody({ remotes: FOREIGN })), c).toMatch(/not a CCv3 checkout/i);
  });

  // Finding 4: gh reads GH_REPO when no --repo is given.
  it('Y5: GH_REPO naming CCv3 (command prefix, PowerShell form, or process env) from a foreign checkout is denied', () => {
    const foreign = withBody({ remotes: FOREIGN });
    expect(reasonOf(`GH_REPO=Rev4nchist/Continuous-Claude-v3 gh pr create --head feat/x --body-file ${B}`, foreign), 'sh prefix').toMatch(/not a CCv3 checkout/i);
    expect(reasonOf(`$env:GH_REPO='Rev4nchist/Continuous-Claude-v3'; gh pr create --head feat/x --body-file ${B}`, foreign, 'PowerShell'), 'pwsh').toMatch(/not a CCv3 checkout/i);
    const viaEnv = withBody({ remotes: FOREIGN, env: { GH_REPO: 'Rev4nchist/Continuous-Claude-v3' } });
    expect(reasonOf(`gh pr create --head feat/x --body-file ${B}`, viaEnv), 'process env').toMatch(/not a CCv3 checkout/i);
  });

  // Finding 5: -F is gh's own short form of --body-file for gh pr create (and a field flag for gh api).
  it('Y6: gh pr create -F <file> is a body file: a matching file allows, another file and stdin deny', () => {
    expect(bodyFileOf(`gh pr create --head feat/x -F ${B}`)).toBe(B);
    expect(decide(input(`gh pr create --head feat/x -F ${B}`), withBody()).action).toBe('allow');
    expect(reasonOf(`gh pr create --head feat/x -F ${O}`, withBody())).toMatch(/not the body/);
    expect(reasonOf('gh pr create --head feat/x -F -', withBody())).toContain('--body-file <file>');
  });

  // Finding 6: the hook does not expand these, so the reason must say so.
  it('Y7: a body path the hook does not expand is denied with a reason that says what path to use', () => {
    for (const p of ['~/body.md', '$env:TEMP\\body.md', '/c/Users/x/body.md']) {
      expect(reasonOf(`gh pr create --head feat/x --body-file "${p}"`, withBody()), p).toMatch(/does not expand/);
    }
  });
});

describe('T: the git runner', () => {
  it('T1: a git timeout or a spawn error throws (the hook then fails open); a git exit code is a result', () => {
    const slow = makeGit(() => ({ status: null, stdout: '', error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }) }));
    expect(() => slow('/x', ['status'])).toThrow(/ETIMEDOUT/);
    const missing = makeGit(() => ({ status: null, stdout: '', error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) }));
    expect(() => missing('/x', ['status'])).toThrow(/ENOENT/);
    const seen: Array<Record<string, unknown>> = [];
    const exit = makeGit((_cmd, _args, opts) => { seen.push(opts); return { status: 128, stdout: 'x' }; });
    expect(exit('/x', ['status'])).toEqual({ status: 128, stdout: 'x' });
    expect(seen[0].timeout).toBe(2000);
    // Up to 6 git calls per decision must fit in the 15 s hook timeout.
    expect(GIT_TIMEOUT_MS).toBe(2000);
    expect(GIT_TIMEOUT_MS * 6).toBeLessThan(15_000);
    expect(seen[0].cwd).toBe('/x');
    // A git that times out on a PR create: denied (the stamp could not be checked), and logged.
    const errors: string[] = [];
    const timing: Deps = { ...deps(), git: slow, logError: (m) => errors.push(m) };
    expect(JSON.parse(handle(JSON.stringify(input(CREATE[0])), timing)).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(errors.length).toBe(1);
  });
});

describe('O: the override', () => {
  it('O1: only a leading assignment counts, in sh and PowerShell form', () => {
    expect(hasOverride('SKIP_PRE_PR_GATE=1 gh pr create --fill', {})).toBe(true);
    expect(hasOverride("$env:SKIP_PRE_PR_GATE='1'; gh pr create --fill", {})).toBe(true);
    expect(hasOverride('$env:SKIP_PRE_PR_GATE = "1"; gh pr create', {})).toBe(true);
    expect(hasOverride('echo SKIP_PRE_PR_GATE=1 && gh pr create --fill', {})).toBe(false);
    expect(hasOverride("echo hi; $env:SKIP_PRE_PR_GATE='1'; gh pr create --fill", {})).toBe(false);
    expect(hasOverride('gh pr create --fill # SKIP_PRE_PR_GATE=1', {})).toBe(false);
    expect(hasOverride('SKIP_PRE_PR_GATE=0 gh pr create', {})).toBe(false);
    expect(hasOverride('gh pr create', { SKIP_PRE_PR_GATE: '1' })).toBe(true);
    const d = decide(input('SKIP_PRE_PR_GATE=1 gh pr create --fill'), deps({ stamp: null }));
    expect(d.action).toBe('override');
    expect(decide(input('echo SKIP_PRE_PR_GATE=1 && gh pr create --fill'), deps({ stamp: null })).action).toBe('deny');
  });
});

describe('F: fail open', () => {
  const noLog = (): { errors: string[] } & Partial<Deps> => { const errors: string[] = []; return { errors, logError: (m: string) => { errors.push(m); } }; };

  it('F3: an internal error on a command that is a PR create DENIES, one reason per error kind; the deny does not teach the override', () => {
    const create = JSON.stringify(input(CREATE[0]));
    const named = JSON.stringify(input('gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f head=feat/x -f title=t -F body=@' + DB));
    const errors: string[] = [];
    const base = (over: Partial<Deps>): Deps => ({ ...deps({ stamp: stampJson() }), logError: (m) => errors.push(m), ...over });
    const timeout = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const spawnErr = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    const kinds: Array<[string, Deps, string, RegExp]> = [
      ['git timeout', base({ git: makeGit(() => ({ status: null, stdout: '', error: timeout })) }), create, /ETIMEDOUT/],
      ['git spawn error', base({ git: makeGit(() => ({ status: null, stdout: '', error: spawnErr })) }), create, /ENOENT/],
      ['git remote fails', base({ git: (_cwd, args) => (args[0] === 'remote' ? { status: 128, stdout: '' } : { status: 0, stdout: `${ROOT}\n` }) }), create, /git remote/],
      ['stamp unreadable', base({ readFile: () => { throw new Error('EACCES: permission denied'); } }), create, /EACCES/],
      ['worktree list throws', base({ git: (cwd, args) => { if (args[0] === 'worktree') throw new Error('worktree boom'); return deps({ stamp: stampJson() }).git(cwd, args); } }), named, /worktree boom/],
    ];
    for (const [kind, d, payload, why] of kinds) {
      errors.length = 0;
      const out = JSON.parse(handle(payload, d));
      expect(out.hookSpecificOutput.permissionDecision, kind).toBe('deny');
      const reason: string = out.hookSpecificOutput.permissionDecisionReason;
      expect(reason, kind).toMatch(/could not verify the pre-PR stamp/);
      expect(reason, kind).toMatch(why);
      expect(reason, kind).not.toMatch(/SKIP_PRE_PR_GATE/);
      expect(errors.length, kind).toBe(1);
    }
    // PowerShell is gated the same way.
    const ps = JSON.parse(handle(JSON.stringify(input(CREATE[0], { tool_name: 'PowerShell' })), base({ git: makeGit(() => ({ status: null, stdout: '', error: timeout })) })));
    expect(ps.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('F6: PRE_PR_GATE_GIT_TIMEOUT_MS can only raise the git timeout (tests under load); a missing, bad or lower value keeps 2000', () => {
    const timeoutWith = (value: string | undefined): unknown => {
      const seen: Array<Record<string, unknown>> = [];
      makeGit((_cmd, _args, opts) => { seen.push(opts); return { status: 0, stdout: '' }; }, value === undefined ? {} : { PRE_PR_GATE_GIT_TIMEOUT_MS: value })('/x', ['status']);
      return seen[0].timeout;
    };
    expect(timeoutWith(undefined)).toBe(2000);
    expect(timeoutWith('10000')).toBe(10000);
    expect(timeoutWith('500')).toBe(2000);
    expect(timeoutWith('abc')).toBe(2000);
    expect(timeoutWith('')).toBe(2000);
  });

  it('F7: an unparsable payload whose raw text is a PR create is denied (fail closed on raw text); other unparsable text allows', () => {
    const errors: string[] = [];
    const d: Deps = { ...deps({ stamp: null }), logError: (m) => errors.push(m) };
    // A truncated payload: the JSON does not parse, but the command text is there.
    const truncated = '{"tool_name":"Bash","tool_input":{"command":"gh pr create --fill"';
    const out = JSON.parse(handle(truncated, d));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/could not read/);
    const apiCreate = '{"tool_name":"PowerShell","tool_input":{"command":"gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f title=t"';
    expect(JSON.parse(handle(apiCreate, d)).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(handle('{not json', d)).toBe('{}');
    expect(handle('{"tool_name":"Bash","tool_input":{"command":"ls -la"', d)).toBe('{}');
  });

  it('F4: an unparsable payload, another tool, and a command that is not a PR create still allow, even when git is broken', () => {
    const errors: string[] = [];
    const broken: Deps = { ...deps({ stamp: null }), git: () => { throw new Error('git is broken'); }, logError: (m) => errors.push(m) };
    expect(handle('{not json', broken)).toBe('{}');
    expect(errors.length).toBe(1);
    expect(handle(JSON.stringify(input('ls -la')), broken)).toBe('{}');
    expect(handle(JSON.stringify(input('gh pr view 5')), broken)).toBe('{}');
    expect(handle(JSON.stringify({ tool_name: 'Write', tool_input: { command: CREATE[0] } }), broken)).toBe('{}');
    expect(errors.length).toBe(1);
  });

  it('F5: the leading override still lets a PR create through when the check itself failed, and is logged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepr-gate-f5-'));
    const file = join(dir, 'guard-decisions.jsonl');
    const saved = process.env.CCV3_GUARD_DECISIONS_LOG;
    process.env.CCV3_GUARD_DECISIONS_LOG = file;
    try {
      const broken: Deps = { ...deps({ stamp: null }), git: () => { throw new Error('git is broken'); } };
      expect(handle(JSON.stringify(input('SKIP_PRE_PR_GATE=1 gh pr create --fill')), broken)).toBe('{}');
      const denied = JSON.parse(handle(JSON.stringify(input('echo SKIP_PRE_PR_GATE=1 && gh pr create --fill')), broken));
      expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    } finally {
      if (saved === undefined) delete process.env.CCV3_GUARD_DECISIONS_LOG;
      else process.env.CCV3_GUARD_DECISIONS_LOG = saved;
    }
    const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => r.decision)).toEqual(['override', 'deny']);
  });

  it('F1: bad input, other tools and a git crash on a command that is not a PR create give {} and never block', () => {
    const base = deps({ stamp: null });
    const log = noLog();
    const d: Deps = { ...base, logError: log.logError };
    expect(handle('', d)).toBe('{}');
    expect(handle(JSON.stringify({ tool_name: 'Write', tool_input: { command: CREATE[0] } }), d)).toBe('{}');
    expect(handle(JSON.stringify({ tool_name: 'Bash', tool_input: {} }), d)).toBe('{}');
    expect(log.errors).toEqual([]);
    expect(handle('{not json', d)).toBe('{}');
    expect(log.errors.length).toBe(1);
    log.errors.length = 0;
    const boom: Deps = { ...base, git: () => { throw new Error('spawn failed'); }, logError: log.logError };
    expect(handle(JSON.stringify(input('ls -la')), boom)).toBe('{}');
    expect(log.errors.length).toBe(0);
    const create = JSON.parse(handle(JSON.stringify(input(CREATE[0])), boom));
    expect(create.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(log.errors.length).toBe(1);
    expect(log.errors[0]).toMatch(/spawn failed/);
  });

  it('F2: a deny is a PreToolUse permissionDecision deny; an allow is {}', () => {
    const out = JSON.parse(handle(JSON.stringify(input(CREATE[0])), deps({ stamp: null })));
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('pre-pr.mjs');
    expect(handle(JSON.stringify(input(CREATE[0])), deps({ stamp: stampJson() }))).toBe('{}');
    expect(handle(JSON.stringify(input('SKIP_PRE_PR_GATE=1 gh pr create')), deps({ stamp: null }))).toBe('{}');
    for (const tool of ['Bash', 'PowerShell']) {
      expect(JSON.parse(handle(JSON.stringify(input(CREATE[0], { tool_name: tool })), deps({ stamp: null }))).hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });
});

describe('L: the decision log', () => {
  it('L1: a deny and an override go to the log named by CCV3_GUARD_DECISIONS_LOG, never to the real one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepr-gate-log-'));
    const file = join(dir, 'guard-decisions.jsonl');
    const saved = process.env.CCV3_GUARD_DECISIONS_LOG;
    process.env.CCV3_GUARD_DECISIONS_LOG = file;
    try {
      handle(JSON.stringify(input(CREATE[0], { session_id: 's1' })), deps({ stamp: null }));
      handle(JSON.stringify(input('SKIP_PRE_PR_GATE=1 gh pr create --fill', { session_id: 's1' })), deps({ stamp: null }));
      handle(JSON.stringify(input('ls', { session_id: 's1' })), deps({ stamp: null }));
    } finally {
      if (saved === undefined) delete process.env.CCV3_GUARD_DECISIONS_LOG;
      else process.env.CCV3_GUARD_DECISIONS_LOG = saved;
    }
    const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => `${r.hook}:${r.decision}`)).toEqual(['pre-pr-gate:deny', 'pre-pr-gate:override']);
  });
});

describe('W: wiring', () => {
  it('W1: the template registers the built hook on both the Bash and the PowerShell matcher', () => {
    const tpl = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json.template'), 'utf8'));
    const blocks = (tpl.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ args?: string[] }> }>);
    const has = (b: { hooks: Array<{ args?: string[] }> }) => b.hooks.some((h) => (h.args ?? []).some((a) => /dist\/pre-pr-gate\.mjs$/.test(a)));
    expect(blocks.filter((b) => b.matcher === 'Bash' && has(b)).length).toBe(1);
    expect(blocks.filter((b) => b.matcher === 'PowerShell' && has(b)).length).toBe(1);
    // The hook runs up to 4 git commands of 3 s each; its timeout must leave room for them.
    for (const b of blocks.filter((x) => has(x))) {
      const entry = b.hooks.find((h) => (h.args ?? []).some((a) => /pre-pr-gate\.mjs$/.test(a))) as unknown as { timeout?: number };
      expect(entry.timeout ?? 0).toBeGreaterThanOrEqual(15);
    }
    expect(existsSync(join(REPO, '.claude', 'hooks', 'dist', 'pre-pr-gate.mjs'))).toBe(true);
  });

  it('W2: the stamp path is the one pre-pr.mjs writes', async () => {
    // Read as text: vitest cannot import a .mjs file that starts with a shebang on this setup (settings-template-validation fails the same way on main).
    const source = readFileSync(join(REPO, 'scripts', 'github', 'pre-pr.mjs'), 'utf8');
    const m = /export const STAMP_REL = '([^']+)'/.exec(source);
    expect(m).not.toBeNull();
    expect(STAMP_REL).toBe(m?.[1]);
  });
});

// =====================================================================================================================
// PR B: the checkpoint gate (spec .claudedocs/2026-10-28-pr-checkpoint-mod-spec.md section 3.2 and PR B row of section 7).
//
// Contract (written before the code):
//   Config: <git toplevel>/review-router.config.json  checkpoint.enforce. ONLY a literal `true` enforces. A missing file, an
//     unreadable or invalid file, a missing key or any other value is WARN mode (the week-one default).
//   Warn mode, for every NEW PR B deny (patterns below): the command is ALLOWED and one row goes to the guard decision log
//     (guard-decisions.jsonl, so CCV3_GUARD_DECISIONS_LOG redirects it in tests; guard-log.ts GREEN adds the kind 'warn'):
//       { ts, hook: 'pre-pr-gate', tool, decision: 'warn', reason: <pattern>, session_id, command (masked, at most 80 chars) }
//     No 'deny' row is written. Under VITEST with no CCV3_GUARD_DECISIONS_LOG nothing is written (same as guard-log.ts today).
//   Enforce mode: the same commands are denied, and the row is { decision: 'deny', reason: <pattern> }.
//   The stamp rules of #193 and #197 are NOT new: they are enforced in both modes, and they are checked before the PR B rules.
//   New patterns and deny texts (each text must not mention SKIP_PRE_PR_GATE):
//     non-draft       'open as draft; run /checkpoint'
//     self-confirm    names pr-checkpoint with --confirm or --apply: only Dave's press in the /checkpoint mod records a pathway
//     ready           gh pr ready, markPullRequestReadyForReview: ALWAYS denied in enforce mode, pathway or not (Dave 2026-10-28; --apply runs gh
//                     inside node, so the hook never sees it). Text must contain /checkpoint. `gh pr ready --undo` is NOT gated (recovery path).
//     review-label    a gh text that adds a review: label (--add-label, a labels endpoint, or gh pr create --label / -l). Allowed ONLY when pathway.json
//                     names HEAD AND the review: label equals pathway.label. Any other review: label is denied. A label add with no visible label text
//                     (gh api .../labels --input <file>, GraphQL addLabelsToLabelable) is denied on CCv3 even WITH a pathway (the label cannot be checked).
//     nonliteral-repo a --repo or -R value with $, a backtick or %VAR%: pass a literal OWNER/REPO
//   pathway.json (<toplevel>/.claude/cache/pre-pr/pathway.json) names the head when its `head` equals `git rev-parse HEAD` there.
//   Scope: ready and label shapes are gated for CCv3 only (named repo, else the checkout), as the create is. self-confirm and
//     nonliteral-repo are not repo-scoped: the text alone decides.
//   Draft tokens (explicit true only): gh pr create --draft | -d ; gh api -F draft=true | -f draft=true. Anything else, and any
//     draft=false next to a true token, is non-draft.
//   Override: a LEADING SKIP_PRE_PR_GATE=1 turns a deny into an 'override' row, as today.
//   Stamp scope (fill round): a create whose --repo or -R value is non-literal, from a CCv3 checkout, is judged by the stamp rules as a
//     CCv3 create. With no valid stamp it is denied 'stamp' in BOTH modes (stamp first, as B3). A bare $REPO already reads as "the checkout
//     decides" (namedRepo gives null). A literal prefix before the $ does not: "--repo other/x$Y" names "other/x" and skips the stamp, so
//     warn mode would leave that #197 bypass open for the whole week. B3 pins the prefix forms.
//   Foreign checkout naming CCv3 (fill round): a ready or label shape that names CCv3 (flag or GH_REPO) from a foreign checkout is denied with the
//     shape's own pattern ('ready' or 'review-label'), not 'repo-identity' (B8b; B9 leaves the same case as a plain deny).
//   Draft token search (fill round): a draft token inside a quoted value (a title such as "add -d flag") is not a draft token. A quoted
//     -F "draft=true" or -F 'draft=true' also counts as NON-draft: fail closed on the raw text, the unquoted form works (B2).
//   Errors: an internal error while judging a ready, label or self-confirm shape (git throws) DENIES in BOTH modes, as the
//     'verify-error' path does for a create today (F3). Warn mode covers rule hits only, not a gate that could not decide.
//
// How the new rules can fail, and the test that catches it:
//   a draft create is denied, or a non-draft create is allowed               -> B1, B2
//   --draft=false, a later draft=false, or a glued -dx counts as a draft      -> B2
//   a PR B rule hides or replaces a stamp deny                                -> B3 (also: a non-literal --repo create with no stamp, in warn mode)
//   a draft token inside a quoted title opens a non-draft PR                  -> B2
//   the warn or deny row has the wrong tool for a PowerShell payload          -> B4, B5
//   ready or label from a foreign checkout naming CCv3 by env, or CCv3 naming a foreign repo by env  -> B8, B9
//   warn mode denies, logs nothing, logs a deny row, or logs a wrong shape    -> B4
//   enforce mode allows, or logs the wrong row                                -> B5
//   a truthy non-boolean enforce value enforces                               -> B6
//   the session confirms or applies its own pathway from a shell              -> B7
//   --json is denied, or an allowed command spawns git                        -> B7
//   gh pr ready or a review: label goes through with no pathway for the head  -> B8
//   a pathway for another head, or a broken one, opens the gate               -> B8
//   a pathway lets a DIFFERENT review: label through, or a pathway with no label field lets one through -> B8c (Dave A.a)
//   a pathway lets a shell gh pr ready through                                -> B8d (Dave A.b); warn mode logs it and allows
//   a label add with no visible label text goes through, with or without a pathway -> B8e (Dave A.c)
//   gh pr create --label review:x / -l review:x goes through                  -> B8f (Dave A.d); a draft create with no review label stays allowed (DRAFT_OK)
//   gh pr ready --undo is denied (it is the recovery path), or --undo=false is read as an undo -> B9, B8d (Dave B)
//   other gh commands, other repos or non-review labels are blocked           -> B9
//   a non-literal --repo or -R skips the CCv3 identity test                   -> B10
//   the override stops working, or a non-leading override works               -> B11
//   an internal error on a ready or label shape lets it through (any mode)   -> B12
//   a continued line hides a ready shape                                      -> B13
//   the warn row is written to the real log under vitest                      -> B14
//   the pathway.json path drifts from the one pr-checkpoint.mjs writes        -> B15
// =====================================================================================================================
describe('B: the checkpoint gate (PR B)', () => {
  const CONFIG_FILE = join(ROOT, 'review-router.config.json');
  const PATHWAY_FILE = join(ROOT, '.claude', 'cache', 'pre-pr', 'pathway.json');
  const FOREIGN_REMOTES = 'origin\thttps://github.com/someone/else.git (fetch)\norigin\thttps://github.com/someone/else.git (push)\n';
  const ENFORCE = JSON.stringify({ checkpoint: { enforce: true } });
  const PATHWAY_OF: Record<string, string> = { 'review:none': 'none', 'review:coderabbit': 'coderabbit', 'review:deep': 'both' };
  /** A pathway.json for `head`. `label` is the label the pathway allows (Dave A.a: a label add must equal it). */
  const pathwayFor = (head: string, label = 'review:coderabbit'): string => JSON.stringify({ head, body_sha256: sha256(DEFAULT_BODY_TEXT), pathway: PATHWAY_OF[label], label, class: 'normal', recommended: 'coderabbit', decided_by: 'dave', at: new Date(NOW).toISOString(), budget: [1, 1] });
  /** The same record with the label key removed: the hook must read pathway.label, not just the head. */
  const pathwayNoLabel = (head: string): string => { const p = JSON.parse(pathwayFor(head)); delete p.label; return JSON.stringify(p); };
  const REVIEW_LABELS = ['review:none', 'review:coderabbit', 'review:deep'];
  /** The first review: token in a command (a label add always names one). */
  const labelOf = (c: string): string => /review:[a-z-]+/.exec(c)?.[0] ?? '';
  const BHEAD = 'b'.repeat(40);

  interface Opts { config?: string; head?: string; stamp?: boolean; pathway?: string; remotes?: string; calls?: Array<{ cwd: string; args: string[] }> }
  /** Deps for the PR B tests: a fresh stamp for HEAD (unless stamp: false), the config, and the pathway file, all served by path. */
  function gdeps(o: Opts = {}): Deps {
    const files: Record<string, string> = {};
    if (o.stamp !== false) files[join(ROOT, STAMP_REL)] = stampJson();
    if (o.config !== undefined) files[CONFIG_FILE] = o.config;
    if (o.pathway !== undefined) files[PATHWAY_FILE] = o.pathway;
    return deps({ stamps: files, remotes: o.remotes, calls: o.calls, head: o.head });
  }
  const payload = (command: string, tool = 'Bash') => JSON.stringify(input(command, { tool_name: tool, session_id: 's1' }));
  const act = (command: string, o: Opts = {}, tool = 'Bash') => decide(input(command, { tool_name: tool }), gdeps(o));
  const denied = (command: string, o: Opts = {}, tool = 'Bash') => {
    const d = act(command, o, tool);
    return d.action === 'deny' ? d : null;
  };

  /** Run `fn` with the guard decision log redirected to a temp file, and return the rows it wrote. */
  function logged(fn: () => void): Array<Record<string, unknown>> {
    const file = join(mkdtempSync(join(tmpdir(), 'prepr-gate-b-')), 'guard-decisions.jsonl');
    const saved = process.env.CCV3_GUARD_DECISIONS_LOG;
    process.env.CCV3_GUARD_DECISIONS_LOG = file;
    try { fn(); } finally {
      if (saved === undefined) delete process.env.CCV3_GUARD_DECISIONS_LOG;
      else process.env.CCV3_GUARD_DECISIONS_LOG = saved;
    }
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  }

  const DRAFT_OK = [
    `gh pr create --draft --body-file ${DB}`,
    `gh pr create -d --base main --head feat/x --title "t" --body-file ${DB}`,
    `gh pr create --base main --head feat/x --body-file ${DB} --draft`,
    `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -F draft=true -f title=t -f head=feat/x -F body=@${DB}`,
    `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f draft=true -f title=t -F body=@${DB}`,
    // A real draft token outside the quotes still counts, whatever the quoted title says.
    `gh pr create --draft --title "add -d flag" --body-file ${DB}`,
    // Dave A.d: a draft create WITHOUT a review: label stays allowed (guards: they pass today and must keep passing).
    `gh pr create --draft --label risk:low --body-file ${DB}`,
    `gh pr create --draft -l "area:hooks" --title "review: tidy up" --body-file ${DB}`,
    // Fix round guards: a redirect after the draft token, gh.exe with --draft, and a draft create chained before a gh api read.
    `gh pr create --draft --body-file ${DB} 2>&1`,
    `gh pr create --draft --body-file ${DB} > out.log`,
    `gh.exe pr create --draft --body-file ${DB}`,
    `gh pr create --draft --body-file ${DB} && gh api repos/Rev4nchist/Continuous-Claude-v3/pulls/201/comments`,
  ];
  const NON_DRAFT = [
    `gh pr create --body-file ${DB}`,
    // A draft token inside a quoted value is text, not a flag. A raw-text scan for -d or --draft would open a routed PR here.
    `gh pr create --title "add -d flag" --body-file ${DB}`,
    `gh pr create --title "add --draft flag" --body-file ${DB}`,
    `gh pr create --title 'add -d flag' --body-file ${DB}`,
    `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f title="fix -F draft=true" -F body=@${DB}`,
    // Pinned fail closed (choice 15): a quoted draft=true is a real draft token in the shell, but the hook does not lex quotes. Type it unquoted.
    `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -F "draft=true" -f title=t -F body=@${DB}`,
    `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -F 'draft=true' -f title=t -F body=@${DB}`,
    `gh pr create --draft=false --body-file ${DB}`,
    `gh pr create --draft --draft=false --body-file ${DB}`,
    `gh pr create --draft=true --body-file ${DB}`,
    `gh pr create -dx --body-file ${DB}`,
    `gh pr create --drafts --body-file ${DB}`,
    `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f title=t -F body=@${DB}`,
    `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -F draft=false -f title=t -F body=@${DB}`,
    `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f draft=false -f title=t -F body=@${DB}`,
    `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -F draft=true -F draft=false -F body=@${DB}`,
    `gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST --draft -F body=@${DB}`,
    // Fix round, critic 1: a comment, a here-string or a command substitution holding the draft token is not a draft flag.
    `gh pr create --body-file ${DB} # --draft`,
    `gh pr create --body-file ${DB} <# --draft #>`,
    `gh pr create --body-file ${DB} <<< --draft`,
    `gh pr create --body-file ${DB} $(: --draft )`,
    `gh pr create --body-file ${DB} \`: --draft\``,
    // Critic 2: an escaped quote moves the quote edge, so ' --draft ' is title text in the shell. An odd quote count or a backslash-quote is doubt: non-draft.
    `gh pr create --title "a\\" x --draft " --body-file ${DB}`,
    `gh pr create --title "a\\" x --draft \\"b" --body-file ${DB}`,
    'gh pr create --title "a`" x --draft " --body-file ' + DB,
    // Critic 6: gh.exe, a quoted gh, and a spliced subcommand are the same create.
    `gh.exe pr create --body-file ${DB}`,
    `& "gh" pr create --body-file ${DB}`,
    `gh pr "create" --body-file ${DB}`,
    `gh pr cre''ate --body-file ${DB}`,
    // Critic 14: a chained gh api create with no draft token (and no body file of its own, so the stamp body count stays one) is non-draft even when the CLI create before it is a draft.
    `gh pr create --draft --body-file ${DB} && gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f title=t`,
  ];

  /** One command per new pattern. Each is allowed today; each must be a deny in enforce mode and a logged allow in warn mode. */
  const NEW_DENIES: Array<{ name: string; command: string; pattern: string; reason: RegExp }> = [
    { name: 'non-draft create', command: CREATE[1], pattern: 'non-draft', reason: /open as draft; run \/checkpoint/ },
    { name: 'self-confirm', command: 'node scripts/github/pr-checkpoint.mjs --confirm none --by dave', pattern: 'self-confirm', reason: /pr-checkpoint[\s\S]*press/i },
    { name: 'ready', command: 'gh pr ready 201', pattern: 'ready', reason: /\/checkpoint/ },
    { name: 'review label', command: 'gh pr edit 201 --add-label review:coderabbit', pattern: 'review-label', reason: /\/checkpoint/ },
    { name: 'non-literal repo', command: `gh pr create --draft --repo $REPO --body-file ${DB}`, pattern: 'nonliteral-repo', reason: /literal/i },
  ];

  it('B1: a draft create with a valid stamp is allowed with or without a pathway, on Bash and PowerShell, in enforce mode', () => {
    for (const c of DRAFT_OK) {
      for (const tool of ['Bash', 'PowerShell']) {
        expect(act(c, { config: ENFORCE }, tool).action, `${tool}: ${c}`).toBe('allow');
        expect(act(c, { config: ENFORCE, pathway: pathwayFor(HEAD) }, tool).action, `${tool} + pathway: ${c}`).toBe('allow');
      }
    }
  });

  it('B2: a create with no explicit draft-true token is denied "open as draft; run /checkpoint" (enforce); --draft=false and a later draft=false count', () => {
    for (const c of NON_DRAFT) {
      for (const tool of ['Bash', 'PowerShell']) {
        const d = denied(c, { config: ENFORCE }, tool);
        expect(d, `${tool}: ${c}`).not.toBeNull();
        expect(d?.pattern, c).toBe('non-draft');
        expect(d?.reason, c).toContain('open as draft; run /checkpoint');
        expect(d?.reason, c).not.toMatch(/SKIP_PRE_PR_GATE/);
      }
    }
  });

  it('B3: the stamp rules come first and stay enforced in warn mode: a create with no stamp is denied "stamp", draft or not, literal repo or not', () => {
    // A non-literal --repo from a CCv3 checkout must not be a stamp hole, in warn mode too (#197). The first three already read as "the checkout
    // decides" today (namedRepo gives null), so they pass now and guard GREEN. The last three carry a literal PREFIX before the $: namedRepo reads the prefix
    // as the repo ("rev4nchist/continuous-claude-v", "other/x"), the identity test sees a foreign repo, and the create skips the stamp. They fail today.
    // Dave decision C (2026-10-28): a non-literal --repo on a create from a CCv3 checkout is judged by the CHECKOUT identity, so the stamp rules apply.
    // The bare forms $REPO, $(...), backticks and %VAR% are pinned the same way (guards: namedRepo gives null for them today, so they pass today).
    const NONLIT_CREATES = [
      `gh pr create --draft --repo $REPO --body-file ${DB}`,
      `gh pr create --repo "$REPO" --body-file ${DB}`,
      `gh pr create --draft -R $env:TARGET --body-file ${DB}`,
      `gh pr create --draft --repo=$(git remote get-url fork) --body-file ${DB}`,
      `gh pr create --draft --repo "$(git remote get-url fork)" --body-file ${DB}`,
      `gh pr create --draft --repo \`git remote get-url fork\` --body-file ${DB}`,
      `gh pr create --draft --repo %REPO% --body-file ${DB}`,
      `gh pr create --draft --repo Rev4nchist/Continuous-Claude-v$N --body-file ${DB}`,
      `gh pr create --repo other/x$Y --body-file ${DB}`,
      `gh pr create --draft -R "Rev4nchist/Continuous-Claude-v$env:N" --body-file ${DB}`,
    ];
    for (const config of [undefined, ENFORCE]) {
      for (const c of [DRAFT_OK[0], DRAFT_OK[3], NON_DRAFT[0], ...NONLIT_CREATES]) {
        for (const tool of ['Bash', 'PowerShell']) {
          const d = denied(c, { config, stamp: false }, tool);
          expect(d?.pattern, `${config ? 'enforce' : 'warn'} ${tool}: ${c}`).toBe('stamp');
        }
      }
    }
    // A stamp for another head is still the stamp deny, not the draft deny, in warn and in enforce mode.
    const staleHead = (config: string | undefined): Deps => ({ ...gdeps({ config }), git: (cwd, args) => (args.join(' ') === 'rev-parse HEAD' ? { status: 0, stdout: `${BHEAD}\n` } : gdeps().git(cwd, args)) });
    for (const config of [undefined, ENFORCE]) {
      for (const c of [NON_DRAFT[0], DRAFT_OK[0], NONLIT_CREATES[0]]) {
        const d = decide(input(c), staleHead(config));
        expect(d.action === 'deny' ? d.pattern : d.action, `${config ? 'enforce' : 'warn'} stale stamp: ${c}`).toBe('stamp');
      }
    }
  });

  it('B4: warn mode (no config, enforce false, no key, bad JSON): every new deny is ALLOWED and logs one warn row of the pinned shape', () => {
    const configs: Array<[string, string | undefined]> = [['no config file', undefined], ['enforce false', JSON.stringify({ checkpoint: { enforce: false } })], ['no key', JSON.stringify({ checkpoint: {} })], ['bad JSON', '{not json']];
    for (const [label, config] of configs) {
      for (const n of NEW_DENIES) {
        for (const tool of ['Bash', 'PowerShell']) {
          let out = '';
          const rows = logged(() => { out = handle(payload(n.command, tool), gdeps({ config })); });
          expect(out, `${label} / ${tool} / ${n.name}: allowed`).toBe('{}');
          expect(rows, `${label} / ${tool} / ${n.name}: one row`).toHaveLength(1);
          expect(rows[0], `${label} / ${tool} / ${n.name}`).toMatchObject({ hook: 'pre-pr-gate', tool, decision: 'warn', reason: n.pattern, session_id: 's1' });
          expect(typeof rows[0].ts, n.name).toBe('string');
          expect(String(rows[0].command), n.name).toContain(n.command.slice(0, 20));
          expect(String(rows[0].command).length, n.name).toBeLessThanOrEqual(80);
        }
      }
    }
  });

  it('B5: enforce mode: the same commands are denied with the pattern text, and the log row is a deny, not a warn', () => {
    for (const n of NEW_DENIES) {
      for (const tool of ['Bash', 'PowerShell']) {
        let out = '';
        const rows = logged(() => { out = handle(payload(n.command, tool), gdeps({ config: ENFORCE })); });
        const parsed = JSON.parse(out || '{}');
        expect(parsed.hookSpecificOutput?.permissionDecision, `${tool} / ${n.name}`).toBe('deny');
        expect(parsed.hookSpecificOutput?.permissionDecisionReason, n.name).toMatch(n.reason);
        expect(parsed.hookSpecificOutput?.permissionDecisionReason, n.name).not.toMatch(/SKIP_PRE_PR_GATE/);
        expect(rows, `${tool} / ${n.name}`).toHaveLength(1);
        expect(rows[0], `${tool} / ${n.name}`).toMatchObject({ hook: 'pre-pr-gate', tool, decision: 'deny', reason: n.pattern });
      }
    }
  });

  it('B6: only a boolean true enforces: the strings "true" and the number 1 are warn mode', () => {
    for (const enforce of ['true', 1, 'yes']) {
      const d = act(NEW_DENIES[2].command, { config: JSON.stringify({ checkpoint: { enforce } }) });
      expect(d.action, String(enforce)).toBe('allow');
    }
  });

  // ---- C1: self-confirm ----
  const SELF = [
    'node scripts/github/pr-checkpoint.mjs --confirm none --by dave',
    'node scripts/github/pr-checkpoint.mjs --confirm=coderabbit --by=default',
    'node scripts/github/pr-checkpoint.mjs --by dave --confirm both',
    'node scripts/github/pr-checkpoint.mjs --apply 201',
    'node scripts/github/pr-checkpoint.mjs --apply=201',
    'node scripts/github/PR-Checkpoint.mjs --apply 201',
    'node .\\scripts\\github\\pr-checkpoint.mjs --apply 201',
    'cd scripts/github; node "pr-checkpoint.mjs" --apply 201',
    'node scripts/github/pr-checkpoint.mjs --json --confirm none --by dave',
    '$f = "scripts/github/pr-checkpoint.mjs"; node $f --apply 201',
    // Fix round, critic 8: a glob or another script name still runs --apply or --confirm.
    'node scripts/github/pr-c*.mjs --apply 201',
    'node scripts/github/pr-?heckpoint.mjs --apply 201',
    'node scripts/github/cp.mjs --apply=201',
    'node scripts/github/cp.mjs --confirm none --by dave',
    'node.exe .\\scripts\\github\\x.mjs --by default --confirm=both',
  ];
  const SELF_OK = [
    'node scripts/github/pr-checkpoint.mjs --json',
    'node scripts/github/pr-checkpoint.mjs',
    'node scripts/github/pr-checkpoint.mjs --json --facts f.json --config c.json --dependabot',
    'node scripts/github/pre-pr.mjs --body b.md',
    'node --test scripts/github/pr-checkpoint.test.mjs',
    'git add scripts/github/pr-checkpoint.mjs',
    'some-other-tool --confirm none',
  ];

  it('B7: a shell text that names pr-checkpoint with --confirm or --apply is denied (Bash and PowerShell); --json and other tools are allowed with no git call', () => {
    for (const c of SELF) {
      for (const tool of ['Bash', 'PowerShell']) {
        const d = denied(c, { config: ENFORCE }, tool);
        expect(d, `${tool}: ${c}`).not.toBeNull();
        expect(d?.pattern, c).toBe('self-confirm');
        expect(d?.reason, c).not.toMatch(/SKIP_PRE_PR_GATE/);
      }
    }
    // Not repo-scoped: the text alone decides (a foreign checkout is denied too).
    expect(denied(SELF[0], { config: ENFORCE, remotes: FOREIGN_REMOTES })?.pattern).toBe('self-confirm');
    const calls: Array<{ cwd: string; args: string[] }> = [];
    for (const c of SELF_OK) {
      for (const tool of ['Bash', 'PowerShell']) expect(act(c, { config: ENFORCE, calls }, tool).action, `${tool}: ${c}`).toBe('allow');
    }
    expect(calls, 'an allowed command never spawns git').toEqual([]);
  });

  // ---- ready and review labels ----
  const READY = [
    'gh pr ready 201',
    'gh pr ready',
    'gh  pr   ready 201 --repo Rev4nchist/Continuous-Claude-v3',
    'GH PR READY 201',
    // Dave B: `--undo` alone is the recovery path and is NOT gated (B9). `--undo=false` is a boolean false, so it is a real ready: fail closed.
    'gh pr ready 201 --undo=false',
    `gh api graphql -f query='mutation { markPullRequestReadyForReview(input: {pullRequestId: "PR_x"}) { pullRequest { id } } }'`,
    // Fix round, critic 6: gh.exe, a quoted gh, and a spliced subcommand are still gh pr ready. Critic 3 and 4: a PR URL or any CCv3 -R value names CCv3.
    'gh.exe pr ready 201',
    '& "gh" pr ready 201',
    'gh pr "ready" 201',
    "gh pr rea''dy 201",
    'gh pr {ready,ready} 201',
    'gh pr ready https://github.com/Rev4nchist/Continuous-Claude-v3/pull/201',
    'gh pr ready 201 -R someone/else -R Rev4nchist/Continuous-Claude-v3',
    'gh pr ready 201 -R Rev4nchist/Continuous-Claude-v3 -R someone/else',
  ];
  // Label adds that name a review: label in the text. Allowed only with a pathway for HEAD whose label equals the one named (Dave A.a).
  const LABEL = [
    'gh pr edit 201 --add-label review:coderabbit',
    'gh pr edit 201 --add-label "review:deep"',
    "gh pr edit 201 --add-label 'review:coderabbit'",
    'gh pr edit 201 --add-label=review:none',
    'gh pr edit 201 --add-label risk:low,review:none',
    'gh pr edit 201 --repo Rev4nchist/Continuous-Claude-v3 --add-label review:none',
    'gh issue edit 201 --add-label review:none',
    'gh api repos/Rev4nchist/Continuous-Claude-v3/issues/201/labels -f "labels[]=review:coderabbit"',
    'gh api repos/Rev4nchist/Continuous-Claude-v3/issues/201/labels -X POST -f labels[]=review:deep',
    // Fix round, critic 5: a labels field on the issue or pull endpoint, with no /labels path.
    "gh api -X PATCH repos/Rev4nchist/Continuous-Claude-v3/issues/201 -f 'labels[]=review:deep'",
    'gh api --method=PATCH repos/Rev4nchist/Continuous-Claude-v3/pulls/201 -f labels[]=review:none',
    // Critic 6, 3 and 4: gh.exe, a PR URL selector, and a CCv3 value among several -R values.
    'gh.exe pr edit 201 --add-label review:deep',
    'gh pr edit https://github.com/Rev4nchist/Continuous-Claude-v3/pull/201 --add-label review:deep',
    'gh pr edit 201 -R someone/else -R Rev4nchist/Continuous-Claude-v3 --add-label review:none',
  ];

  it('B8: gh pr ready, markPullRequestReadyForReview and a review: label are denied with no pathway.json for HEAD, or a pathway for another head or a broken one', () => {
    for (const c of [...READY, ...LABEL]) {
      const want = READY.includes(c) ? 'ready' : 'review-label';
      for (const tool of ['Bash', 'PowerShell']) {
        const none = denied(c, { config: ENFORCE }, tool);
        expect(none?.pattern, `${tool}: ${c}`).toBe(want);
        expect(none?.reason, c).toContain('/checkpoint');
        expect(none?.reason, c).not.toMatch(/SKIP_PRE_PR_GATE/);
      }
      expect(denied(c, { config: ENFORCE, pathway: pathwayFor(BHEAD, READY.includes(c) ? undefined : labelOf(c)) })?.pattern, `pathway of another head: ${c}`).toBe(want);
      for (const bad of ['{not json', '{}', 'null', JSON.stringify({ head: 7 })]) {
        expect(denied(c, { config: ENFORCE, pathway: bad })?.pattern, `pathway ${bad}: ${c}`).toBe(want);
      }
    }
  });

  // ---- Dave A.a: the label must equal pathway.label ----
  it('B8c: a review: label add is allowed ONLY when pathway.json names HEAD and the label equals pathway.label; any other review: label is denied "review-label"', () => {
    for (const c of LABEL) {
      const label = labelOf(c);
      for (const tool of ['Bash', 'PowerShell']) {
        // The pathway for the SAME label allows it (a guard on over-blocking; it also passes today).
        expect(act(c, { config: ENFORCE, pathway: pathwayFor(HEAD, label) }, tool).action, `${tool}, matching pathway ${label}: ${c}`).toBe('allow');
        for (const other of REVIEW_LABELS.filter((l) => l !== label)) {
          const d = denied(c, { config: ENFORCE, pathway: pathwayFor(HEAD, other) }, tool);
          expect(d?.pattern, `${tool}, pathway ${other} vs label ${label}: ${c}`).toBe('review-label');
          expect(d?.reason, c).not.toMatch(/SKIP_PRE_PR_GATE/);
        }
      }
    }
    // A pathway for HEAD with no label field cannot vouch for any label: the hook must read pathway.label.
    expect(denied('gh pr edit 201 --add-label review:none', { config: ENFORCE, pathway: pathwayNoLabel(HEAD) })?.pattern, 'pathway with no label').toBe('review-label');
    // A label that only starts like the pathway label is another label (the match is equality, not a prefix or substring test).
    for (const c of ['gh pr edit 201 --add-label review:coderabbit-held', 'gh pr edit 201 --add-label review:coderabbitx', 'gh pr edit 201 --add-label review:deep-held']) {
      expect(denied(c, { config: ENFORCE, pathway: pathwayFor(HEAD, labelOf(c).replace(/-held$|x$/, '')) })?.pattern, c).toBe('review-label');
    }
    // More than one review: label in one command cannot match one pathway label: denied (also when the pathway names one of them).
    for (const c of [
      'gh pr edit 201 --add-label review:coderabbit,review:deep',
      'gh pr edit 201 --add-label review:coderabbit --add-label review:none',
    ]) expect(denied(c, { config: ENFORCE, pathway: pathwayFor(HEAD, 'review:coderabbit') })?.pattern, c).toBe('review-label');
    // GitHub label names are case-insensitive: a case variant is the same label, so with no pathway or a different one it is denied.
    for (const c of ['gh pr edit 201 --add-label Review:NONE', 'gh pr edit 201 --add-label REVIEW:Deep']) {
      expect(denied(c, { config: ENFORCE })?.pattern, `no pathway: ${c}`).toBe('review-label');
      expect(denied(c, { config: ENFORCE, pathway: pathwayFor(HEAD, 'review:coderabbit') })?.pattern, `other pathway: ${c}`).toBe('review-label');
    }
    // A matching label for ANOTHER head is not a match (the head test and the label test both apply).
    expect(denied('gh pr edit 201 --add-label review:none', { config: ENFORCE, pathway: pathwayFor(BHEAD, 'review:none') })?.pattern).toBe('review-label');
  });

  // ---- Dave A.b and B: ready ----
  it('B8d: a shell gh pr ready (and markPullRequestReadyForReview) is ALWAYS denied in enforce mode, even with a pathway for HEAD; warn mode logs a warn row and allows', () => {
    for (const c of READY) {
      for (const tool of ['Bash', 'PowerShell']) {
        for (const pathway of [pathwayFor(HEAD), pathwayFor(HEAD, 'review:none'), pathwayFor(HEAD, 'review:deep')]) {
          const d = denied(c, { config: ENFORCE, pathway }, tool);
          expect(d?.pattern, `${tool}, pathway ${JSON.parse(pathway).label}: ${c}`).toBe('ready');
          expect(d?.reason, c).toContain('/checkpoint');
          expect(d?.reason, c).not.toMatch(/SKIP_PRE_PR_GATE/);
        }
      }
      // Warn mode with a pathway: allowed, one warn row. (No pathway in warn mode is B4.)
      for (const config of [undefined, JSON.stringify({ checkpoint: { enforce: false } })]) {
        let out = '';
        const rows = logged(() => { out = handle(payload(c), gdeps({ config, pathway: pathwayFor(HEAD) })); });
        expect(out, `warn, pathway: ${c}`).toBe('{}');
        expect(rows, `warn, pathway: ${c}`).toHaveLength(1);
        expect(rows[0], c).toMatchObject({ hook: 'pre-pr-gate', decision: 'warn', reason: 'ready' });
      }
    }
  });

  // ---- Dave A.c: label adds with no visible label text ----
  const LABEL_BLIND = [
    'gh api repos/Rev4nchist/Continuous-Claude-v3/issues/201/labels --input labels.json',
    'gh api repos/Rev4nchist/Continuous-Claude-v3/issues/201/labels -X POST --input labels.json',
    'gh api repos/Rev4nchist/Continuous-Claude-v3/issues/201/labels --input=labels.json',
    'gh api repos/Rev4nchist/Continuous-Claude-v3/issues/201/labels -X PUT --input -',
    `gh api graphql -f query='mutation { addLabelsToLabelable(input: {labelableId: "PR_x", labelIds: ["L_x"]}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation($id: ID!, $l: [ID!]!) { addLabelsToLabelable(input: {labelableId: $id, labelIds: $l}) { clientMutationId } }' -f id=PR_x`,
    // Fix round, critic 5: file-fed label values and the update mutations carry the label text out of sight.
    'gh api -X PATCH repos/Rev4nchist/Continuous-Claude-v3/issues/201 -F labels[]=@l.txt',
    'gh api repos/Rev4nchist/Continuous-Claude-v3/issues/201/labels -F labels[]=@l.txt',
    `gh api graphql -f query='mutation { updatePullRequest(input: {pullRequestId: "PR_x", labelIds: ["L_x"]}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { updateIssue(input: {id: "I_x", labelIds: ["L_x"]}) { clientMutationId } }'`,
    // Critic 7: brace expansion hides the label text.
    'gh pr edit 201 --add-label=review:{deep,deep}',
  ];

  it('B8e: a label add with no visible label text (labels endpoint with --input, GraphQL addLabelsToLabelable) is denied "review-label" on CCv3, with no pathway AND with a pathway', () => {
    for (const c of LABEL_BLIND) {
      for (const tool of ['Bash', 'PowerShell']) {
        const none = denied(c, { config: ENFORCE }, tool);
        expect(none?.pattern, `${tool}, no pathway: ${c}`).toBe('review-label');
        expect(none?.reason, c).toContain('/checkpoint');
        expect(none?.reason, c).not.toMatch(/SKIP_PRE_PR_GATE/);
        // The label cannot be checked against pathway.label, so a pathway for HEAD does not open it.
        for (const label of REVIEW_LABELS) {
          expect(denied(c, { config: ENFORCE, pathway: pathwayFor(HEAD, label) }, tool)?.pattern, `${tool}, pathway ${label}: ${c}`).toBe('review-label');
        }
      }
    }
    // Scope: the same shapes are allowed from a foreign checkout (GraphQL has no repo in the text) and for another repo's endpoint.
    expect(act(LABEL_BLIND[4], { config: ENFORCE, remotes: FOREIGN_REMOTES }).action, 'foreign checkout, GraphQL').toBe('allow');
    expect(act('gh api repos/someone/else/issues/201/labels --input labels.json', { config: ENFORCE }).action, 'another repo endpoint').toBe('allow');
    // Warn mode: logged and allowed, like the other new patterns.
    for (const c of LABEL_BLIND) {
      let out = '';
      const rows = logged(() => { out = handle(payload(c), gdeps({})); });
      expect(out, `warn: ${c}`).toBe('{}');
      expect(rows, `warn: ${c}`).toHaveLength(1);
      expect(rows[0], c).toMatchObject({ decision: 'warn', reason: 'review-label' });
    }
  });

  // ---- Dave A.d: gh pr create --label / -l ----
  const CREATE_LABEL = [
    `gh pr create --draft --label review:coderabbit --body-file ${DB}`,
    `gh pr create --draft -l review:none --body-file ${DB}`,
    `gh pr create --draft --label=review:deep --body-file ${DB}`,
    `gh pr create --draft -lreview:none --body-file ${DB}`,
    `gh pr create --draft --label "risk:low,review:coderabbit" --body-file ${DB}`,
    `gh pr create -d --label 'review:none' --title t --body-file ${DB}`,
  ];

  it('B8f: gh pr create --draft --label review:x (and -l) is a label shape: denied "review-label" with no pathway or a pathway for another label; a draft create with no review label is allowed', () => {
    for (const c of CREATE_LABEL) {
      for (const tool of ['Bash', 'PowerShell']) {
        const none = denied(c, { config: ENFORCE }, tool);
        expect(none?.pattern, `${tool}, no pathway: ${c}`).toBe('review-label');
        expect(none?.reason, c).toContain('/checkpoint');
        expect(none?.reason, c).not.toMatch(/SKIP_PRE_PR_GATE/);
        const other = REVIEW_LABELS.find((l) => l !== labelOf(c)) as string;
        expect(denied(c, { config: ENFORCE, pathway: pathwayFor(HEAD, other) }, tool)?.pattern, `${tool}, pathway ${other}: ${c}`).toBe('review-label');
      }
      expect(denied(c, { config: ENFORCE, pathway: pathwayFor(BHEAD, labelOf(c)) })?.pattern, `pathway of another head: ${c}`).toBe('review-label');
      // Warn mode: allowed with one warn row.
      let out = '';
      const rows = logged(() => { out = handle(payload(c), gdeps({})); });
      expect(out, `warn: ${c}`).toBe('{}');
      expect(rows, `warn: ${c}`).toHaveLength(1);
      expect(rows[0], c).toMatchObject({ decision: 'warn', reason: 'review-label' });
    }
    // Over-blocking guards (pass today): a draft create with no review label, and a --label review: on another repo's create.
    for (const c of DRAFT_OK) expect(act(c, { config: ENFORCE }).action, c).toBe('allow');
    expect(act(`gh pr create --draft --repo someone/else --label review:none --body-file ${DB}`, { config: ENFORCE, stamp: false }).action, 'another repo').toBe('allow');
    // NOT pinned: a create --label review:x WITH a pathway for HEAD whose label equals it. Dave named the no-pathway case only (open item in prB-red.md).
  });

  it('B8b: an env prefix cannot move a ready or label shape out of scope: GH_REPO=CCv3 from a foreign checkout is denied; a plain FOO=1 prefix is denied', () => {
    const CCV3 = 'Rev4nchist/Continuous-Claude-v3';
    const named: Array<[string, string, string]> = [
      ['GH_REPO=' + CCV3 + ' gh pr ready 201', 'Bash', 'ready'],
      ["$env:GH_REPO='" + CCV3 + "'; gh pr ready 201", 'PowerShell', 'ready'],
      ['GH_REPO=' + CCV3 + ' gh pr edit 201 --add-label review:none', 'Bash', 'review-label'],
      ["$env:GH_REPO='" + CCV3 + "'; gh pr edit 201 --add-label review:none", 'PowerShell', 'review-label'],
    ];
    for (const [c, tool, pattern] of named) {
      expect(denied(c, { config: ENFORCE, remotes: FOREIGN_REMOTES }, tool)?.pattern, `foreign checkout, ${tool}: ${c}`).toBe(pattern);
    }
    const plain: Array<[string, string, string]> = [
      ['FOO=1 gh pr ready 201', 'Bash', 'ready'],
      ['FOO=1 gh pr edit 201 --add-label review:none', 'Bash', 'review-label'],
      ["$env:FOO='1'; gh pr ready 201", 'PowerShell', 'ready'],
      ["$env:FOO='1'; gh pr edit 201 --add-label review:none", 'PowerShell', 'review-label'],
    ];
    for (const [c, tool, pattern] of plain) {
      expect(denied(c, { config: ENFORCE }, tool)?.pattern, `CCv3 checkout, ${tool}: ${c}`).toBe(pattern);
    }
  });

  it('B9: other gh commands, non-review labels, removals, label creation, other repos and foreign checkouts are not gated; no git is spawned for text that is not a shape', () => {
    const NOT_GATED = [
      'gh pr view 201 --json labels',
      'gh pr edit 201 --add-label risk:low',
      'gh pr edit 201 --remove-label review:deep-held',
      'gh pr edit 201 --title "review: tidy up"',
      'gh label create review:none --color ededed',
      'gh pr list --label review:deep',
      'gh api repos/Rev4nchist/Continuous-Claude-v3/issues/201/labels',
      'gh pr checks 201',
      'gh pr view 201 --repo $REPO',
      'gh issue list -R $REPO',
      // Dave B: gh pr ready --undo moves a PR back to draft. It is the recovery path and is allowed in both modes. (Guards: nothing gates ready today.)
      'gh pr ready 201 --undo',
      'gh pr ready --undo',
      'gh pr ready --undo 201',
      // Dave A.c over-blocking guards: a labels read, a GraphQL read, and --input on an endpoint that is not a labels write.
      `gh api graphql -f query='{ repository(owner: "a", name: "b") { labels(first: 5) { nodes { name } } } }'`,
      'gh api repos/Rev4nchist/Continuous-Claude-v3/issues/201/comments --input comment.json',
      'gh api repos/Rev4nchist/Continuous-Claude-v3/issues/201/labels -X POST -f labels[]=risk:low',
    ];
    const calls: Array<{ cwd: string; args: string[] }> = [];
    for (const c of NOT_GATED) expect(act(c, { config: ENFORCE, calls }).action, c).toBe('allow');
    expect(calls).toEqual([]);
    // gh pr ready --undo is allowed with no warn or deny row in BOTH modes, with and without a pathway, Bash and PowerShell, also with a named CCv3 repo.
    for (const c of ['gh pr ready 201 --undo', 'gh pr ready --undo', 'gh pr ready 201 --repo Rev4nchist/Continuous-Claude-v3 --undo']) {
      for (const config of [undefined, ENFORCE]) {
        for (const tool of ['Bash', 'PowerShell']) {
          let out = '';
          const rows = logged(() => { out = handle(payload(c, tool), gdeps({ config })); });
          expect(out, `${config ? 'enforce' : 'warn'} ${tool}: ${c}`).toBe('{}');
          expect(rows, `${config ? 'enforce' : 'warn'} ${tool}: ${c}: no row`).toEqual([]);
        }
      }
    }
    // Another repo is not gated: named in the command, or by a foreign checkout.
    expect(act('gh pr ready 201 --repo someone/else', { config: ENFORCE }).action).toBe('allow');
    expect(act('gh pr edit 201 --add-label review:none -R someone/else', { config: ENFORCE }).action).toBe('allow');
    expect(act('gh pr ready 201', { config: ENFORCE, remotes: FOREIGN_REMOTES }).action).toBe('allow');
    expect(act('gh pr edit 201 --add-label review:none', { config: ENFORCE, remotes: FOREIGN_REMOTES }).action).toBe('allow');
    // Naming CCv3 from a foreign checkout is still gated.
    expect(denied('gh pr ready 201 -R Rev4nchist/Continuous-Claude-v3', { config: ENFORCE, remotes: FOREIGN_REMOTES })).not.toBeNull();
    // A GH_REPO for a foreign repo, from a CCv3 checkout, names another repo: not gated (Bash prefix and PowerShell $env: forms).
    const foreignByEnv: Array<[string, string]> = [
      ['GH_REPO=someone/else gh pr ready 201', 'Bash'],
      ["$env:GH_REPO='someone/else'; gh pr ready 201", 'PowerShell'],
      ['GH_REPO=someone/else gh pr edit 201 --add-label review:none', 'Bash'],
      ["$env:GH_REPO='someone/else'; gh pr edit 201 --add-label review:none", 'PowerShell'],
    ];
    for (const [c, tool] of foreignByEnv) expect(act(c, { config: ENFORCE }, tool).action, `CCv3 checkout, ${tool}: ${c}`).toBe('allow');
  });

  // ---- open item 3 of prB-red.md (default chosen by Dave's workflow): --undo counts only inside the same gh pr ready command segment ----
  it('B9b: --undo exempts only the gh pr ready command it belongs to (segments split on ; && || | and newlines); a --undo elsewhere, quoted or glued to =false is still a ready', () => {
    const NOT_UNDO = [
      'gh pr ready 201; echo --undo',
      'echo --undo && gh pr ready 201',
      'gh pr ready 201 | cat --undo',
      'gh pr ready 201\necho --undo',
      'gh pr ready --undo; gh pr ready 201',
      'gh pr ready 201 "--undo"',
      "bash -c 'gh pr ready 201'",
      // Fix round, critic 1: a comment, a here-string or a substitution that holds --undo does not excuse the ready.
      'gh pr ready 201 # --undo',
      'gh pr ready 201 <# --undo #>',
      'gh pr ready 201 <<< --undo',
      'gh pr ready 201 $(: --undo )',
      'gh pr ready 201 `: --undo`',
      // Critic 2: an escaped quote moves the quote edge.
      'gh pr ready 201 "x\\" --undo "',
    ];
    for (const c of NOT_UNDO) {
      for (const tool of ['Bash', 'PowerShell']) {
        expect(denied(c, { config: ENFORCE }, tool)?.pattern, `enforce ${tool}: ${JSON.stringify(c)}`).toBe('ready');
      }
      let out = '';
      const rows = logged(() => { out = handle(payload(c), gdeps({})); });
      expect(out, `warn: ${JSON.stringify(c)}`).toBe('{}');
      expect(rows, `warn: ${JSON.stringify(c)}`).toHaveLength(1);
      expect(rows[0], c).toMatchObject({ decision: 'warn', reason: 'ready' });
    }
    // Guards (pass today): the undo sits in its own ready segment, so nothing is logged or denied.
    for (const c of ['gh pr ready 201 --undo; echo done', 'echo start; gh pr ready --undo 201', 'gh pr ready 201 --undo && gh pr view 201', 'gh pr ready --undo; gh pr ready --undo']) {
      for (const config of [undefined, ENFORCE]) {
        let out = '';
        const rows = logged(() => { out = handle(payload(c), gdeps({ config })); });
        expect(out, `${config ? 'enforce' : 'warn'}: ${c}`).toBe('{}');
        expect(rows, `${config ? 'enforce' : 'warn'}: ${c}: no row`).toEqual([]);
      }
    }
  });

  // ---- fix round, critic 7: shell word splicing hides the label ----
  it('B8g: a label with spliced quotes or a quoted part is the same label: denied with no pathway or another pathway; the matching pathway allows', () => {
    const SPLICED = [
      "gh pr edit 201 --add-label rev''iew:deep",
      'gh pr edit 201 --add-label "review":deep',
      "gh pr edit 201 --add-label re'view':deep",
      'gh pr edit 201 --add-""label review:deep',
      'gh pr edit 201 --add-label \\review:deep',
    ];
    for (const c of SPLICED) {
      for (const tool of ['Bash', 'PowerShell']) {
        expect(denied(c, { config: ENFORCE }, tool)?.pattern, `${tool}, no pathway: ${c}`).toBe('review-label');
        expect(denied(c, { config: ENFORCE, pathway: pathwayFor(HEAD, 'review:none') }, tool)?.pattern, `${tool}, other pathway: ${c}`).toBe('review-label');
      }
      expect(act(c, { config: ENFORCE, pathway: pathwayFor(HEAD, 'review:deep') }).action, `matching pathway: ${c}`).toBe('allow');
    }
  });

  // ---- fix round, critic 3 and 4: the repo selector forms ----
  it('B9c: a PR URL or any CCv3 value among several -R / --repo / GH_REPO values names CCv3 from a foreign checkout; foreign values stay foreign', () => {
    const CCV3 = 'Rev4nchist/Continuous-Claude-v3';
    const gate = gateModule as unknown as { namedRepo: (c: string, env?: Record<string, string>) => string | null };
    for (const c of [
      `gh pr ready 201 -R someone/else -R ${CCV3}`,
      `gh pr ready 201 -R ${CCV3} -R someone/else`,
      `gh pr ready 201 --repo someone/else --repo=${CCV3}`,
      `GH_REPO=someone/else gh pr ready 201 -R ${CCV3}`,
      `gh pr ready https://github.com/${CCV3}/pull/201`,
      `gh issue edit https://github.com/${CCV3}/issues/7 --add-label review:none`,
    ]) expect(gate.namedRepo(c), c).toBe('rev4nchist/continuous-claude-v3');
    expect(gate.namedRepo('gh pr ready 201 -R someone/else -R other/repo'), 'foreign values name the first').toBe('someone/else');
    // Gated from a foreign checkout.
    expect(denied(`gh pr ready https://github.com/${CCV3}/pull/201`, { config: ENFORCE, remotes: FOREIGN_REMOTES })?.pattern).toBe('ready');
    expect(denied(`gh pr edit https://github.com/${CCV3}/pull/201 --add-label review:deep`, { config: ENFORCE, remotes: FOREIGN_REMOTES })?.pattern).toBe('review-label');
    expect(denied(`gh pr ready 201 -R someone/else -R ${CCV3}`, { config: ENFORCE, remotes: FOREIGN_REMOTES })?.pattern).toBe('ready');
    // A create with a CCv3 value among several: the stamp rules apply (a CCv3 checkout with no stamp; a foreign checkout is a repo-identity deny).
    const create = `gh pr create --draft -R someone/else -R ${CCV3} --body-file ${DB}`;
    expect(denied(create, { config: ENFORCE, stamp: false })?.pattern, 'CCv3 checkout, no stamp').toBe('stamp');
    expect(denied(create, { config: ENFORCE, remotes: FOREIGN_REMOTES })?.pattern, 'foreign checkout').toBe('repo-identity');
    // Guards: foreign values only, from a CCv3 checkout, stay allowed.
    expect(act('gh pr ready 201 -R someone/else -R other/repo', { config: ENFORCE }).action).toBe('allow');
  });

  // ---- CodeRabbit CLI (major): labelsEndpointRepo read repos/<o>/<r>/issues|pulls/<n> from anywhere in the raw text ----
  it('B9d: a foreign endpoint text in a create title does not name the target: the stamp rule applies in both modes', () => {
    // A create has no endpoint: the title text cannot move the target off a CCv3 checkout. The stamp rule applies in both modes.
    const create = `gh pr create --draft --body-file ${DB} --title "gh api repos/o/r/issues/5"`;
    for (const config of [undefined, ENFORCE]) {
      for (const tool of ['Bash', 'PowerShell']) {
        expect(denied(create, { config, stamp: false }, tool)?.pattern, `${config ? 'enforce' : 'warn'} ${tool}: ${create}`).toBe('stamp');
      }
    }
  });

  it('B9d2: a foreign endpoint in one segment cannot vouch for a later gh pr ready', () => {
    const ready = 'gh api repos/someone/else/issues/1/comments; gh pr ready 201';
    expect(denied(ready, { config: ENFORCE })?.pattern, ready).toBe('ready');
  });

  it('B9d3: a foreign endpoint in one segment cannot vouch for a later review: label add', () => {
    const label = 'gh api repos/someone/else/issues/1/labels -f labels[]=x; gh pr edit 201 --add-label review:deep';
    expect(denied(label, { config: ENFORCE })?.pattern, label).toBe('review-label');
  });

  it('B9e: a single non-create gh api call on a foreign endpoint stays foreign; a CCv3 endpoint anywhere is CCv3', () => {
    // Guard: one segment, not a create: the endpoint names the target, so a CCv3 checkout does not gate it.
    const foreign = 'gh api repos/someone/else/issues/1/labels -f labels[]=review:deep';
    expect(act(foreign, { config: ENFORCE }).action, foreign).toBe('allow');
    // A CCv3 endpoint in any segment is CCv3, also from a foreign checkout (fail closed).
    for (const c of [
      'gh api repos/Rev4nchist/Continuous-Claude-v3/issues/1/labels -f labels[]=review:deep',
      'gh api repos/someone/else/issues/1/comments; gh api repos/Rev4nchist/Continuous-Claude-v3/issues/1/labels -f labels[]=review:deep',
    ]) expect(denied(c, { config: ENFORCE, remotes: FOREIGN_REMOTES })?.pattern, c).toBe('review-label');
  });

  // ---- a foreign repo must not hide a CCv3 command in any text form (Dave's rule) ----
  // A command names a foreign repo only from a literal -R / --repo, or an inline `GH_REPO=o/r gh ...` prefix, in a raw text
  // with exactly one `gh` word and none of $( ` # ; & | CR LF. Endpoint text, a PR URL and a GH_REPO statement name nothing.
  it('B9f: text that only looks like a foreign target (title, comment, substitution, second gh, statement) leaves the checkout in charge', () => {
    const TITLE = '--title "gh api repos/x/y/issues/1"';
    const GRAPHQL = `gh api graphql -f query='mutation{markPullRequestReadyForReview(input:{pullRequestId:"PR_x"}){clientMutationId}}' -f n=repos/x/y/issues/1`;
    const cases: Array<{ c: string; tool: string; pattern: string }> = [
      { c: `gh pr "create" --draft --body-file ${DB} ${TITLE}`, tool: 'Bash', pattern: 'stamp' },
      { c: `gh pr cre''ate --draft --body-file ${DB} ${TITLE}`, tool: 'Bash', pattern: 'stamp' },
      { c: `gh pr "create" --draft --body-file ${DB} ${TITLE}`, tool: 'PowerShell', pattern: 'stamp' },
      { c: `gh pr edit 201 --add-label review:deep ${TITLE}`, tool: 'Bash', pattern: 'review-label' },
      { c: 'gh pr ready 201 # gh api repos/x/y/issues/1', tool: 'Bash', pattern: 'ready' },
      { c: GRAPHQL, tool: 'Bash', pattern: 'ready' },
      { c: 'gh api repos/{owner}/{repo}/issues/201/labels -f labels[]=review:deep -f n=repos/x/y/issues/1', tool: 'Bash', pattern: 'review-label' },
      { c: 'gh api repos/x/y/issues/1/comments -f body="$(gh pr ready 201)"', tool: 'Bash', pattern: 'ready' },
      { c: 'gh api repos/x/y/issues/1/comments -f body=`gh pr ready 201`', tool: 'Bash', pattern: 'ready' },
      { c: 'gh pr comment 1 -R x/y --body (gh pr ready 201)', tool: 'PowerShell', pattern: 'ready' },
      { c: 'GH_REPO=x/y; gh pr ready 201', tool: 'Bash', pattern: 'ready' },
      { c: "$env:GH_REPO='x/y'; gh pr ready 201", tool: 'Bash', pattern: 'ready' },
      { c: 'export GH_REPO=x/y; gh pr ready 201', tool: 'PowerShell', pattern: 'ready' },
      { c: "$env:GH_REPO='x/y'; gh pr ready 201", tool: 'PowerShell', pattern: 'ready' },
      { c: 'gh pr comment 1 -R x/y\rgh pr ready 201', tool: 'PowerShell', pattern: 'ready' },
      { c: 'gh pr ready 201 -R x/y; gh pr ready 202', tool: 'Bash', pattern: 'ready' },
    ];
    // Collect every miss so one run lists them all.
    const misses = cases
      .map(({ c, tool, pattern }) => ({ tool, c, pattern, got: denied(c, { config: ENFORCE, stamp: false }, tool)?.pattern ?? 'allow' }))
      .filter((r) => r.got !== r.pattern)
      .map((r) => `${r.tool} ${JSON.stringify(r.c)}: want ${r.pattern}, got ${r.got}`);
    expect(misses).toEqual([]);
  });

  it('B9g: a literal -R, --repo or inline GH_REPO prefix in a single gh call still names a foreign repo', () => {
    for (const c of [
      'gh pr ready 5 -R x/y',
      'gh pr ready 5 --repo=x/y',
      'gh pr ready 5 --repo x/y',
      'GH_REPO=x/y gh pr ready 5',
      'gh pr edit 5 -R x/y --add-label review:deep',
    ]) {
      for (const tool of ['Bash', 'PowerShell']) {
        expect(act(c, { config: ENFORCE }, tool).action, `${tool}: ${c}`).toBe('allow');
      }
    }
  });

  // ---- fix round, critic 6: gh.exe and a quoted gh on the PR create stamp rules (#193, #197) ----
  it('B16: gh.exe, a quoted gh and a spliced subcommand are a PR create: no stamp is a "stamp" deny, in warn mode too', () => {
    for (const c of [
      `gh.exe pr create --draft --body-file ${DB}`,
      `& "gh" pr create --draft --body-file ${DB}`,
      `gh pr "create" --draft --body-file ${DB}`,
      `gh pr cre''ate --draft --body-file ${DB}`,
      `gh.exe api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -F draft=true -F body=@${DB}`,
      `& "gh" api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -F draft=true -F body=@${DB}`,
    ]) {
      for (const config of [undefined, ENFORCE]) {
        for (const tool of ['Bash', 'PowerShell']) {
          expect(denied(c, { config, stamp: false }, tool)?.pattern, `${config ? 'enforce' : 'warn'} ${tool}: ${c}`).toBe('stamp');
        }
      }
    }
  });

  // ---- lane gate-nonliteral-repo (CodeRabbit #197 thread PRRT_kwDOQ9JX0c6xVOwe) ----
  const NONLIT = [
    `gh pr create --draft --repo $REPO --body-file ${DB}`,
    `gh pr create --draft --repo "$REPO" --body-file ${DB}`,
    `gh pr create --draft -R $env:TARGET --body-file ${DB}`,
    `gh pr create --draft --repo=$(git remote get-url fork) --body-file ${DB}`,
    `gh pr create --draft --repo \`git remote get-url fork\` --body-file ${DB}`,
    `gh pr create --draft --repo %REPO% --body-file ${DB}`,
    `gh pr create --draft --repo owner/$NAME --body-file ${DB}`,
    `gh pr create --draft --repo Rev4nchist/Continuous-Claude-v$N --body-file ${DB}`,
    `gh pr create --draft --repo other/x$Y --body-file ${DB}`,
    'gh pr ready 201 --repo $REPO',
    'gh pr edit 201 --add-label review:none -R "$(echo a/b)"',
    // Fix round, critic 9: a non-literal GH_REPO assignment, sh and PowerShell forms.
    'GH_REPO=$R gh pr ready 201',
    '$env:GH_REPO=$r; gh pr ready 201',
    'GH_REPO="$(git remote get-url fork)" gh pr edit 201 --add-label review:none',
    'GH_REPO=%REPO% gh pr ready 201',
  ];

  it('B10: a --repo or -R value with $, $(...), a backtick or %VAR% is denied "nonliteral-repo", from a CCv3 or a foreign checkout, even with a stamp and a pathway', () => {
    for (const c of NONLIT) {
      for (const remotes of [undefined, FOREIGN_REMOTES]) {
        const d = denied(c, { config: ENFORCE, pathway: pathwayFor(HEAD), remotes });
        expect(d?.pattern, `${remotes ? 'foreign' : 'ccv3'}: ${c}`).toBe('nonliteral-repo');
        expect(d?.reason, c).toMatch(/literal/i);
      }
    }
    // Literal values, and a $ that is not a repo value, stay allowed.
    for (const c of [
      `gh pr create --draft --repo Rev4nchist/Continuous-Claude-v3 --body-file ${DB}`,
      `gh pr create --draft --repo "Rev4nchist/Continuous-Claude-v3" --body-file ${DB}`,
      `gh pr create --draft -R Rev4nchist/Continuous-Claude-v3 --body-file ${DB}`,
      `gh pr create --draft --title "costs $5" --body-file ${DB}`,
    ]) {
      expect(act(c, { config: ENFORCE }).action, c).toBe('allow');
    }
  });

  // ---- override ----
  it('B11: a LEADING SKIP_PRE_PR_GATE=1 turns a new deny into an override row (sh and PowerShell form); a non-leading one does not', () => {
    const ok: Array<[string, string]> = [
      ['SKIP_PRE_PR_GATE=1 gh pr ready 201', 'Bash'],
      ['SKIP_PRE_PR_GATE=1 node scripts/github/pr-checkpoint.mjs --apply 201', 'Bash'],
      ["$env:SKIP_PRE_PR_GATE='1'; node scripts/github/pr-checkpoint.mjs --confirm none --by dave", 'PowerShell'],
      ['SKIP_PRE_PR_GATE=1 gh pr edit 201 --add-label review:none', 'Bash'],
    ];
    for (const [c, tool] of ok) {
      let out = '';
      const rows = logged(() => { out = handle(payload(c, tool), gdeps({ config: ENFORCE })); });
      expect(out, c).toBe('{}');
      expect(rows.map((r) => r.decision), c).toEqual(['override']);
      expect(rows[0].reason, c).toBe('SKIP_PRE_PR_GATE');
    }
    expect(act('echo SKIP_PRE_PR_GATE=1 && gh pr ready 201', { config: ENFORCE }).action).toBe('deny');
    expect(act('gh pr ready 201 # SKIP_PRE_PR_GATE=1', { config: ENFORCE }).action).toBe('deny');
  });

  it('B12: an internal error (git throws) on a ready or label shape DENIES in both modes; a command that is not a shape still allows', () => {
    for (const config of [ENFORCE, undefined]) {
      const boom: Deps = { ...gdeps({ config }), git: () => { throw new Error('git boom'); }, logError: () => {} };
      for (const c of ['gh pr ready 201', 'gh pr edit 201 --add-label review:none', LABEL_BLIND[4], `gh pr create --draft --label review:none --body-file ${DB}`]) {
        const out = JSON.parse(handle(payload(c), boom) || '{}');
        expect(out.hookSpecificOutput?.permissionDecision, `${config ? 'enforce' : 'warn'}: ${c}`).toBe('deny');
      }
      expect(handle(payload('gh pr view 201'), boom), 'a command that is not a shape still allows').toBe('{}');
    }
  });

  it('B13: a continued line is one command: PowerShell backtick and bash backslash-newline forms of ready, label and self-confirm are denied', () => {
    const cases: Array<[string, string, string]> = [
      ['gh pr `\n  ready 201', 'PowerShell', 'ready'],
      ['gh pr \\\nready 201', 'Bash', 'ready'],
      ['gh pr edit 201 `\n  --add-label review:none', 'PowerShell', 'review-label'],
      ['node scripts/github/pr-checkpoint.mjs `\n  --apply 201', 'PowerShell', 'self-confirm'],
      ['node scripts/github/pr-checkpoint.mjs \\\n  --confirm none --by dave', 'Bash', 'self-confirm'],
      [`gh pr create --draft \`\n  --label review:none --body-file ${DB}`, 'PowerShell', 'review-label'],
    ];
    for (const [c, tool, pattern] of cases) expect(denied(c, { config: ENFORCE }, tool)?.pattern, `${tool}: ${JSON.stringify(c)}`).toBe(pattern);
  });

  it('B14: under vitest with no CCV3_GUARD_DECISIONS_LOG a warn row is never written to the real home', () => {
    const home = mkdtempSync(join(tmpdir(), 'prepr-gate-home-'));
    const saved = { log: process.env.CCV3_GUARD_DECISIONS_LOG, up: process.env.USERPROFILE, home: process.env.HOME };
    delete process.env.CCV3_GUARD_DECISIONS_LOG;
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    try {
      for (const n of NEW_DENIES) handle(payload(n.command), gdeps());
    } finally {
      if (saved.log !== undefined) process.env.CCV3_GUARD_DECISIONS_LOG = saved.log;
      if (saved.up === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.up;
      if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    }
    expect(existsSync(join(home, '.claude')), 'nothing under the sandbox home').toBe(false);
  });

  it('B15: PATHWAY_REL is exported, sits next to STAMP_REL, and is the path pr-checkpoint.mjs writes', () => {
    const gate = gateModule as unknown as Record<string, unknown>;
    const source = readFileSync(join(REPO, 'scripts', 'github', 'pr-checkpoint.mjs'), 'utf8');
    const m = /export const PATHWAY_REL = '([^']+)'/.exec(source);
    expect(m, 'pr-checkpoint.mjs exports PATHWAY_REL').not.toBeNull();
    expect(gate.PATHWAY_REL).toBe(m?.[1]);
    expect(gate.PATHWAY_REL).toBe(STAMP_REL.replace(/stamp\.json$/, 'pathway.json'));
  });
});
