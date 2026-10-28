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
import {
  CCV3_REPO,
  MAX_STAMP_AGE_MS,
  STAMP_REL,
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

type GitFn = (cwd: string, args: string[]) => { status: number; stdout: string };

function stampJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ head: HEAD, branch: 'feat/x', at: new Date(NOW - 3_600_000).toISOString(), body_sha256: 'b'.repeat(64), results: [], ...over });
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
      if (over.stamps) return over.stamps[p] ?? null;
      return over.stamp === undefined ? null : over.stamp;
    },
    now: () => NOW,
    env: {},
  };
}

const input = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd: ROOT, ...extra });

const CREATE = [
  'gh pr create --fill',
  'gh pr create --base main --head feat/x --title "t" --body "x"',
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f title=t -f head=feat/x -f base=main',
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls --method POST -f title=t',
  'gh api -X POST repos/Rev4nchist/Continuous-Claude-v3/pulls -f title=t',
  'gh api --method=POST repos/Rev4nchist/Continuous-Claude-v3/pulls -f title=t',
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -f title=t -f head=feat/x',
];

const CONTINUED = [
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls `\n  -X POST `\n  -f title=t',
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls `\r\n  --method POST `\r\n  -f title=t',
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls \\\n  -X POST \\\n  -f title=t',
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls \\\r\n  -f title=t \\\r\n  -f head=feat/x',
  'gh api -X POST `\n  repos/Rev4nchist/Continuous-Claude-v3/pulls `\n  -f title=t',
  'gh pr create `\n  --fill',
  // Bash deletes a backslash-newline outright, so a word split across lines runs as one word (CLI review, d2403f3).
  'gh a\\\npi repos/Rev4nchist/Continuous-Claude-v3/pulls -f title=x',
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pu\\\nlls -X POST -f title=x',
  'gh pr cre\\\r\nate --fill',
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
    const c = 'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f title=t -f head=feat/other -f base=main';
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
    const spy: Deps = { ...d, readFile: (p) => { seen.push(p.replace(/\\/g, '/')); return stampJson(); } };
    decide(input('gh pr create --fill'), spy);
    expect(seen).toEqual([`${ROOT}/${STAMP_REL}`]);
    seen.length = 0;
    decide(input('cd /other/checkout && gh pr create --fill'), spy);
    expect(seen).toEqual([`/other/checkout/${STAMP_REL}`]);
    seen.length = 0;
    const wt = 'worktree /work/ccv3\nHEAD aaa\nbranch refs/heads/main\n\nworktree /work/wt-x\nHEAD bbb\nbranch refs/heads/feat/x\n';
    const c = 'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f head=feat/x -f title=t';
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
    decide(input('gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f head=feat/named -f title=t'), deps({ calls, stamp: stampJson(), pushed: HEAD }));
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

  it('B3: an inline body, a stdin body and no body are not compared', () => {
    for (const c of [
      'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f head=feat/x -f body=inline',
      'gh pr create --head feat/x --body-file -',
      'gh pr create --fill',
    ]) {
      expect(decide(input(c), bodyDeps(null, 'a'.repeat(64))).action, c).toBe('allow');
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
    const named = JSON.stringify(input('gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -f head=feat/x -f title=t'));
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
