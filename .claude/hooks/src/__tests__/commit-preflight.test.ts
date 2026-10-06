/**
 * commit-preflight: PreToolUse (Bash|PowerShell) on `git commit`.
 *
 * Check 1: the done-check. A commit with no proof (a recent non-ratchet test run, or a passing
 * verify sidecar on this HEAD) gets advisory context. Check 2: a `feat` or `fix` commit on
 * main or master gets an 'ask' (advisory when unattended).
 *
 * Real payload fixtures live in fixtures/correct/. Repos are fake (file writes only), so the
 * test reads HEAD the same way the hook does. One `it` per row of the PR2 spec, section d.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { preflight, commitMessageHead, type PreflightOptions } from '../commit-preflight.js';
import { getStateFile } from '../shared/test-run-state.js';
import {
  SHA,
  iso,
  loadFixture,
  mkRepo,
  mkWorktree,
  tempDir,
  writeRegistry,
  writeSidecar,
} from './correct-helpers.js';

const SHORT = SHA.slice(0, 7);
const sessions: string[] = [];
let n = 0;
const newSession = (): string => {
  const id = `commit-preflight-test-${process.pid}-${Date.now()}-${n++}`;
  sessions.push(id);
  return id;
};
afterEach(() => {
  for (const id of sessions.splice(0)) rmSync(getStateFile(id)!, { force: true });
});

interface Ctx {
  repo: string;
  session: string;
  opts: PreflightOptions;
}

/** A repo on `branch`; e2e = whether its registry entry carries an e2e key. */
function ctx(branch: string, e2e = true): Ctx {
  const repo = mkRepo(tempDir('pf'), branch);
  const registryPath = writeRegistry(join(tempDir('reg'), 'project-registry.json'), [
    e2e ? { name: 'p', path: repo, e2e: { command: 'x' } } : { name: 'p', path: repo },
  ]);
  return { repo, session: newSession(), opts: { env: {}, registryPath } };
}

const payload = (name: string, c: Ctx, extra: Record<string, string> = {}) =>
  loadFixture(name, { REPO: c.repo, SESSION: c.session, ...extra });

const ctxOf = (out: any): string | undefined => out?.hookSpecificOutput?.additionalContext;

function writeRun(session: string, command: string, ok: boolean | null, ageMs = 60_000): void {
  writeFileSync(getStateFile(session)!, JSON.stringify({ lastTestRun: Date.now() - ageMs, command, ok }));
}

describe('check 1: the done-check', () => {
  // commit-no-proof: breaks when the `none` branch is removed. The empty state is synthetic.
  it('warns, advisory only, on a commit with no proof', () => {
    const c = ctx('work');
    const out = preflight(payload('commit-no-proof', c), c.opts);
    expect(ctxOf(out)).toContain('verify.mjs');
    expect(out!.hookSpecificOutput).not.toHaveProperty('permissionDecision');
  });

  // ratchet-is-not-proof: breaks when isRatchet is dropped from `proven`.
  it('a context-budget-guard run is not proof', () => {
    const c = ctx('work');
    writeRun(c.session, 'node scripts/rules/context-budget-guard.mjs --repo', true);
    expect(ctxOf(preflight(payload('commit-no-proof', c), c.opts))).toContain('verify.mjs');
  });

  it('a recent vitest run is proof', () => {
    const c = ctx('work');
    writeRun(c.session, 'npx vitest run', true);
    expect(preflight(payload('commit-no-proof', c), c.opts)).toBeNull();
  });

  // failed-sidecar: breaks when the `failed` branch stops reading `exit`.
  it('names a failed verify', () => {
    const c = ctx('work');
    writeSidecar(c.repo, 'a', { exit: 1, started: iso(Date.now() - 120_000), finished: iso(Date.now() - 60_000), head: SHORT });
    expect(ctxOf(preflight(payload('commit-no-proof', c), c.opts))).toContain('last verify exited 1');
  });

  // killed-sidecar: breaks when null is treated as a pass.
  it('names a verify that is still running or was killed', () => {
    const c = ctx('work');
    writeSidecar(c.repo, 'a', { exit: null, started: iso(Date.now() - 60_000), finished: null, head: SHORT });
    const text = ctxOf(preflight(payload('commit-no-proof', c), c.opts));
    expect(text).toContain('still running or was killed');
    expect(text).not.toContain('exited null');
  });

  // stale-head: breaks when the head check is removed.
  it('names a verify that ran on another commit', () => {
    const c = ctx('work');
    writeSidecar(c.repo, 'a', { exit: 0, started: iso(Date.now() - 120_000), finished: iso(Date.now() - 60_000), head: 'abc1234' });
    expect(ctxOf(preflight(payload('commit-no-proof', c), c.opts))).toContain('verify ran on abc1234');
  });

  // proven-sidecar: breaks when the hook warns on proof.
  it('is silent after a passing verify on this HEAD', () => {
    const c = ctx('work');
    writeSidecar(c.repo, 'a', { exit: 0, started: iso(Date.now() - 120_000), finished: iso(Date.now() - 60_000), head: SHORT });
    expect(preflight(payload('commit-no-proof', c), c.opts)).toBeNull();
  });

  // no-e2e-silent: breaks when `none` fires in a repo without e2e.
  it('is silent with no proof in a repo without e2e', () => {
    const c = ctx('work', false);
    expect(preflight(payload('commit-no-proof', c), c.opts)).toBeNull();
  });

  // no-e2e-failed-speaks: breaks when a failed run is hidden without e2e.
  it('speaks about a failed run even without e2e', () => {
    const c = ctx('work', false);
    writeRun(c.session, 'npx vitest run', false);
    expect(ctxOf(preflight(payload('commit-no-proof', c), c.opts))).toContain('npx vitest run');
  });

  it('a worktree finds the e2e entry of its main repo', () => {
    const main = mkRepo(tempDir('wtm'), 'main');
    const wt = mkWorktree(main, tempDir('wtd'), 'feat/x');
    const registryPath = writeRegistry(join(tempDir('reg'), 'project-registry.json'), [
      { name: 'p', path: main, e2e: { command: 'x' } },
    ]);
    const input = loadFixture('commit-no-proof', { REPO: wt, SESSION: newSession() });
    expect(ctxOf(preflight(input as any, { env: {}, registryPath }))).toContain('verify.mjs');
  });
});

describe('detecting the commit', () => {
  it.each([
    'git status --short',
    'git log --oneline -5',
    'echo git commit',
    'git log --grep "git commit"',
    'git add -A',
    'ls',
  ])('ignores %s', (command) => {
    const c = ctx('work');
    const input = payload('commit-no-proof', c);
    input.tool_input.command = command;
    expect(preflight(input, c.opts)).toBeNull();
  });

  it.each([
    'git commit -am "x"',
    'git add -A && git commit -m "x"',
    'git -C . commit --amend --no-edit',
    'git.exe commit -F msg.txt',
    'pwsh -File scripts/git-safe.ps1 -C <REPO> commit -F msg.txt',
    'git -c user.name=x commit -m "x"',
  ])('sees %s as a commit', (command) => {
    const c = ctx('work');
    const input = payload('commit-no-proof', c);
    input.tool_input.command = command.replace('<REPO>', c.repo);
    expect(ctxOf(preflight(input, c.opts))).toContain('verify.mjs');
  });

  // powershell-tool: breaks when the runtime gate narrows to Bash.
  it('handles the PowerShell tool', () => {
    const c = ctx('main');
    const out = preflight(payload('powershell-tool', c), c.opts);
    expect((out as any).hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('ignores a tool that is not a shell', () => {
    const c = ctx('main');
    const input = payload('commit-on-main', c);
    input.tool_name = 'Read';
    expect(preflight(input, c.opts)).toBeNull();
  });
});

describe('check 2: feat or fix on main', () => {
  // commit-on-main: breaks when the branch check is removed.
  it('asks, with the way out in the reason', () => {
    const c = ctx('main', false);
    const out = preflight(payload('commit-on-main', c), c.opts) as any;
    const h = out.hookSpecificOutput;
    expect(h.hookEventName).toBe('PreToolUse');
    expect(h.permissionDecision).toBe('ask');
    expect(h.permissionDecisionReason).toContain('On branch main');
    expect(h.permissionDecisionReason).toContain('no feature work on main');
    expect(h.permissionDecisionReason).toContain('git switch -c');
  });

  it('asks on master too', () => {
    const c = ctx('master', false);
    expect((preflight(payload('commit-on-main', c), c.opts) as any).hookSpecificOutput.permissionDecision).toBe('ask');
  });

  // chore-on-main-silent: breaks when the type filter is removed.
  it('stays silent for a chore on main', () => {
    const c = ctx('main', false);
    expect(preflight(payload('chore-on-main', c), c.opts)).toBeNull();
  });

  // commit-on-branch: breaks when the check fires on every branch.
  it('stays silent for the same message on a feature branch', () => {
    const c = ctx('feat/x', false);
    expect(preflight(payload('commit-on-main', c), c.opts)).toBeNull();
  });

  it('reads a heredoc message', () => {
    const c = ctx('main', false);
    expect((preflight(payload('heredoc-on-main', c), c.opts) as any).hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it.each([
    'git commit',
    'git commit -F C:/tmp/msg.txt',
    'git commit --amend --no-edit',
    'git commit -C HEAD',
  ])('stays silent with no -m (%s)', (command) => {
    const c = ctx('main', false);
    const input = payload('commit-on-main', c);
    input.tool_input.command = command;
    expect(preflight(input, c.opts)).toBeNull();
  });

  it.each([
    ['git commit -m "fix: x"', true],
    ['git commit -m "fix(hooks)!: x"', true],
    ['git commit -m "fix!: x"', true],
    ["git commit -m 'feat(x): y'", true],
    ['git commit --message="feat: y"', true],
    ['git commit -sm "feat: y"', true],
    ['git commit -m "feature: y"', false],
    ['git commit -m "fixup! y"', false],
    ['git commit -m "docs: fix the thing"', false],
    ['git commit -m "refactor: feat"', false],
  ])('message %s asks: %s', (command, asks) => {
    const c = ctx('main', false);
    const input = payload('commit-on-main', c);
    input.tool_input.command = command;
    const out = preflight(input, c.opts) as any;
    expect(out?.hookSpecificOutput?.permissionDecision === 'ask').toBe(asks);
  });

  it('a -m on a later command does not count', () => {
    const c = ctx('main', false);
    const input = payload('commit-on-main', c);
    input.tool_input.command = 'git commit -F msg.txt && git tag -m "feat: y" v1';
    expect(preflight(input, c.opts)).toBeNull();
  });

  it('is advisory, with the same text, when unattended', () => {
    const c = ctx('main', false);
    const input = payload('commit-on-main', c);
    input.permission_mode = 'bypassPermissions';
    const out = preflight(input, c.opts) as any;
    expect(out.hookSpecificOutput).not.toHaveProperty('permissionDecision');
    expect(out.hookSpecificOutput.additionalContext).toContain('git switch -c');
    const ask = preflight(payload('commit-on-main', c), c.opts) as any;
    expect(out.hookSpecificOutput.additionalContext).toBe(ask.hookSpecificOutput.permissionDecisionReason);
  });

  it('is advisory for a subagent (CLAUDE_AGENT_ID)', () => {
    const c = ctx('main', false);
    const out = preflight(payload('commit-on-main', c), { ...c.opts, env: { CLAUDE_AGENT_ID: 'a1' } }) as any;
    expect(out.hookSpecificOutput).not.toHaveProperty('permissionDecision');
  });

  it('keeps the done-check text next to the ask', () => {
    const c = ctx('main', true);
    const h = (preflight(payload('commit-on-main', c), c.opts) as any).hookSpecificOutput;
    expect(h.permissionDecision).toBe('ask');
    expect(h.additionalContext).toContain('verify.mjs');
  });
});

describe('which directory', () => {
  // git-C-path: breaks when the dir comes from cwd only.
  it('takes the repo from git -C, not from cwd', () => {
    const cwdRepo = ctx('feat/x', false);
    const other = ctx('main', false);
    const out = preflight(payload('git-C-path', cwdRepo, { OTHER: other.repo.replace(/\\/g, '/') }), cwdRepo.opts) as any;
    expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('main');
  });

  it('takes the repo from git-safe.ps1 -C', () => {
    const cwdRepo = ctx('feat/x', false);
    const other = ctx('main', false);
    const input = payload('commit-on-main', cwdRepo);
    input.tool_input.command = `pwsh -File scripts/git-safe.ps1 -C "${other.repo}" commit -m "feat(x): y"`;
    expect((preflight(input, cwdRepo.opts) as any).hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('resolves a relative -C against cwd', () => {
    const cwdRepo = ctx('feat/x', false);
    const inner = mkRepo(join(cwdRepo.repo, 'inner'), 'main');
    expect(inner).toBeTruthy();
    const input = payload('commit-on-main', cwdRepo);
    input.tool_input.command = 'git -C inner commit -m "feat(x): y"';
    expect((preflight(input, cwdRepo.opts) as any).hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('works from a subdirectory of the repo', () => {
    const c = ctx('main', false);
    const sub = join(c.repo, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    const input = loadFixture('commit-on-main', { REPO: sub, SESSION: c.session });
    expect((preflight(input as any, c.opts) as any).hookSpecificOutput.permissionDecision).toBe('ask');
  });
});

describe('fail-open', () => {
  // fail-open: breaks when the hook throws.
  it('returns null when cwd is not a git repo', () => {
    const c = ctx('main', true);
    const input = loadFixture('commit-on-main', { REPO: tempDir('nogit'), SESSION: c.session });
    expect(preflight(input as any, c.opts)).toBeNull();
  });

  it('returns null when -C points at nothing', () => {
    const c = ctx('main', true);
    const input = payload('commit-on-main', c);
    input.tool_input.command = 'git -C Z:/does/not/exist commit -m "feat: y"';
    expect(preflight(input, c.opts)).toBeNull();
  });

  it('returns null for a broken registry and a missing session id', () => {
    const c = ctx('work', true);
    writeFileSync(c.opts.registryPath!, '{{');
    const input = payload('commit-no-proof', c);
    delete input.session_id;
    expect(preflight(input, c.opts)).toBeNull();
  });

  it.each([null, undefined, {}, { tool_name: 'Bash' }, { tool_name: 'Bash', tool_input: {} }, { tool_name: 'Bash', tool_input: { command: 42 } }])(
    'does not throw on %j',
    (input) => {
      expect(() => preflight(input as any, { env: {} })).not.toThrow();
      expect(preflight(input as any, { env: {} })).toBeNull();
    },
  );
});

describe('review fixes: the message from -F', () => {
  const asks = (out: any): boolean => out?.hookSpecificOutput?.permissionDecision === 'ask';
  const commitWith = (c: Ctx, command: string) => {
    const input = payload('commit-on-main', c);
    input.tool_input.command = command;
    return preflight(input, c.opts);
  };
  const msgFile = (c: Ctx, text: string, name = 'msg.txt'): string => {
    const file = join(c.repo, name);
    writeFileSync(file, text);
    return file.replace(/\\/g, '/');
  };

  // Breaks when the check needs -m: pr-and-commit-style.md tells the agent to commit with -F.
  it('asks for a feat commit whose -F file starts with feat (path relative to cwd)', () => {
    const c = ctx('main', false);
    msgFile(c, 'feat(hooks): x\n\nbody\n');
    expect(asks(commitWith(c, 'git commit -F msg.txt'))).toBe(true);
  });

  it('asks through git-safe.ps1 -C <repo> commit -F <abs file>', () => {
    const c = ctx('main', false);
    const file = msgFile(c, 'fix: x\n');
    expect(asks(commitWith(c, `pwsh -File scripts/git-safe.ps1 -C "${c.repo}" commit -F ${file}`))).toBe(true);
  });

  it('reads --file=<path> and --file <path>', () => {
    const c = ctx('main', false);
    msgFile(c, 'feat: x\n');
    expect(asks(commitWith(c, 'git commit --file=msg.txt'))).toBe(true);
    expect(asks(commitWith(c, 'git commit --file msg.txt'))).toBe(true);
  });

  it('resolves a relative -F against the -C directory first', () => {
    const cwdRepo = ctx('feat/x', false);
    const other = ctx('main', false);
    msgFile(other, 'feat: x\n');
    const input = payload('commit-on-main', cwdRepo);
    input.tool_input.command = `git -C "${other.repo}" commit -F msg.txt`;
    expect(asks(preflight(input, cwdRepo.opts))).toBe(true);
  });

  it('skips blank lines and a BOM before the subject', () => {
    const c = ctx('main', false);
    msgFile(c, '\uFEFF\n\n  fix: x\n');
    expect(asks(commitWith(c, 'git commit -F msg.txt'))).toBe(true);
  });

  it('stays silent for a chore file, a missing file, stdin and an empty file', () => {
    const c = ctx('main', false);
    msgFile(c, 'chore: x\n');
    expect(commitWith(c, 'git commit -F msg.txt')).toBeNull();
    expect(commitWith(c, 'git commit -F absent.txt')).toBeNull();
    expect(commitWith(c, 'git commit -F -')).toBeNull();
    msgFile(c, '', 'empty.txt');
    expect(commitWith(c, 'git commit -F empty.txt')).toBeNull();
  });

  it('-m wins over a -F that names a feat file', () => {
    const c = ctx('main', false);
    msgFile(c, 'feat: x\n');
    // git itself rejects both together; the hook must not crash and must read the -m.
    expect(commitWith(c, 'git commit -m "chore: y" -F msg.txt')).toBeNull();
  });
});

describe('review fixes: which commit and which message', () => {
  const asks = (out: any): boolean => out?.hookSpecificOutput?.permissionDecision === 'ask';
  const commitWith = (c: Ctx, command: string, tool = 'Bash') => {
    const input = payload('commit-on-main', c);
    input.tool_input.command = command;
    input.tool_name = tool;
    return preflight(input, c.opts);
  };

  // Breaks when only the first commit of a chained command is read.
  it('asks when the second commit of a chain is a feat commit', () => {
    const c = ctx('main', false);
    expect(asks(commitWith(c, 'git commit -m "chore: a" && git commit -m "feat: b"'))).toBe(true);
  });

  it('asks when the first commit of a chain is a feat commit', () => {
    const c = ctx('main', false);
    expect(asks(commitWith(c, 'git commit -m "feat: a" && git commit -m "chore: b"'))).toBe(true);
  });

  it('stays silent when every commit of a chain is a chore', () => {
    const c = ctx('main', false);
    expect(commitWith(c, 'git commit -m "chore: a" && git commit -m "docs: b"')).toBeNull();
  });

  it('checks each commit against its own -C repo', () => {
    const feat = ctx('feat/x', false);
    const main = ctx('main', false);
    const cmd = `git -C "${feat.repo}" commit -m "feat: a" && git -C "${main.repo}" commit -m "feat: b"`;
    expect(asks(commitWith(feat, cmd))).toBe(true);
    expect(commitWith(main, `git -C "${feat.repo}" commit -m "feat: a" && git -C "${feat.repo}" commit -m "fix: b"`)).toBeNull();
  });

  // Breaks when a `git commit` inside a quoted string is taken as the call.
  it('ignores a quoted `git commit -m` that comes before the real commit', () => {
    const c = ctx('main', false);
    expect(commitWith(c, `echo "git commit -m 'feat: x'"; git commit -m "chore: y"`)).toBeNull();
  });

  it('takes the directory from the real commit, not from a quoted one', () => {
    const c = ctx('main', false);
    const feat = ctx('feat/x', false);
    expect(asks(commitWith(c, `echo "git -C ${feat.repo} commit"; git commit -m "feat: x"`))).toBe(true);
  });

  // Breaks when the message is read only from a plain quoted -m.
  it.each([
    ['git commit -m "$msg"', true],
    ['git commit -m $msg', true],
    ['git commit -m "$(date)"', true],
    ["git commit -m $'feat: x'", true],
    ["git commit -m $'chore: x'", false],
  ])('message form %j asks on main: %s', (command, expected) => {
    const c = ctx('main', false);
    expect(asks(commitWith(c, command))).toBe(expected);
  });

  it('an unresolved message stays silent on a feature branch', () => {
    const c = ctx('feat/x', false);
    expect(commitWith(c, 'git commit -m "$msg"')).toBeNull();
  });

  it('commitMessageHead reads $\'..\' and marks a variable as unresolved', () => {
    expect(commitMessageHead("git commit -m $'feat: y'")).toBe('feat: y');
    expect(commitMessageHead('git commit -m "$msg"')).toBe('$msg');
  });
});

describe('review fixes: detecting the call', () => {
  const sees = (c: Ctx, command: string, tool = 'Bash'): boolean => {
    const input = payload('commit-no-proof', c);
    input.tool_input.command = command;
    input.tool_name = tool;
    return (preflight(input, c.opts) as any)?.hookSpecificOutput?.additionalContext?.includes('verify.mjs') === true;
  };

  // Breaks when COMMIT_CALL needs `git` at the start of a segment with nothing before it.
  it.each([
    'GIT_AUTHOR_NAME=x git commit -m "x"',
    'GIT_AUTHOR_NAME=x GIT_COMMITTER_NAME=x git commit -m "x"',
    'if true; then git commit -m "x"; fi',
    'for i in 1; do git commit -m "x"; done',
    'time git commit -m "x"',
    'sudo git commit -m "x"',
    'git add -A &&\n  git commit -m "x"',
    'pwsh -File scripts/git-safe.ps1 -c core.autocrlf=false commit -m "x"',
    'pwsh -NoProfile -ExecutionPolicy Bypass -File C:/x/scripts/git-safe.ps1 -C . commit -m "x"',
    '& ./scripts/git-safe.ps1 -C . commit -m "x"',
    'pwsh -File "C:\\x\\git-safe.ps1" -C . commit -m "x"',
    'git -c user.name="A B" commit -m "x"',
  ])('sees %j as a commit', (command) => {
    expect(sees(ctx('work'), command)).toBe(true);
  });

  // Breaks when git-safe.ps1 is not anchored to a command position.
  it.each([
    'echo git-safe.ps1 commit',
    'cat scripts/git-safe.ps1 commit',
    'Write-Output "pwsh -File scripts/git-safe.ps1 commit"',
    'git log --grep "git-safe.ps1 commit"',
    'echo "x" git commit',
    'pwsh -File other.ps1 commit',
    'pwsh -File "C:\\x\\other.ps1" -C . commit',
  ])('does not see %j as a commit', (command) => {
    expect(sees(ctx('work'), command)).toBe(false);
  });
});

describe('review fixes: the effective directory', () => {
  const asks = (out: any): boolean => out?.hookSpecificOutput?.permissionDecision === 'ask';
  const commitWith = (c: Ctx, command: string) => {
    const input = payload('commit-on-main', c);
    input.tool_input.command = command;
    return preflight(input, c.opts);
  };
  const fwd = (p: string): string => p.replace(/\\/g, '/');

  // Breaks when `cd <path> && git commit` is read against cwd.
  it('follows a cd before the commit', () => {
    const cwdRepo = ctx('feat/x', false);
    const main = ctx('main', false);
    expect(asks(commitWith(cwdRepo, `cd ${fwd(main.repo)} && git commit -m "feat: x"`))).toBe(true);
    expect(asks(commitWith(cwdRepo, `cd "${main.repo}"; git commit -m "feat: x"`))).toBe(true);
    expect(asks(commitWith(cwdRepo, `Set-Location '${main.repo}'; git commit -m "feat: x"`))).toBe(true);
  });

  it('stays on a feature branch after a cd to one', () => {
    const cwdRepo = ctx('main', false);
    const feat = ctx('feat/x', false);
    expect(commitWith(cwdRepo, `cd ${fwd(feat.repo)} && git commit -m "feat: x"`)).toBeNull();
  });

  it('resolves a relative cd against cwd, then -C against that', () => {
    const cwdRepo = ctx('feat/x', false);
    mkRepo(join(cwdRepo.repo, 'inner'), 'main');
    expect(asks(commitWith(cwdRepo, 'cd inner && git commit -m "feat: x"'))).toBe(true);
  });

  it('reads a Git Bash /c/ path on Windows', () => {
    if (process.platform !== 'win32') return;
    const cwdRepo = ctx('feat/x', false);
    const main = ctx('main', false);
    const msys = fwd(main.repo).replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);
    expect(asks(commitWith(cwdRepo, `cd ${msys} && git commit -m "feat: x"`))).toBe(true);
  });

  // Breaks when a cd to nowhere falls back to cwd (the hook would judge the wrong repo).
  it('fails open when the cd target does not exist or cannot be resolved', () => {
    const main = ctx('main', false);
    expect(commitWith(main, 'cd Z:/does/not/exist && git commit -m "feat: x"')).toBeNull();
    expect(commitWith(main, 'cd "$HOME/x" && git commit -m "feat: x"')).toBeNull();
    expect(commitWith(main, 'cd ~/x && git commit -m "feat: x"')).toBeNull();
    expect(commitWith(main, 'cd - && git commit -m "feat: x"')).toBeNull();
  });

  // Breaks when --git-dir / --work-tree are ignored and cwd is judged instead.
  it('fails open for --git-dir and --work-tree', () => {
    const main = ctx('main', false);
    const other = ctx('feat/x', false);
    expect(commitWith(main, `git --git-dir=${fwd(other.repo)}/.git commit -m "feat: x"`)).toBeNull();
    expect(commitWith(main, `git --work-tree ${fwd(other.repo)} commit -m "feat: x"`)).toBeNull();
  });
});

describe('commitMessageHead', () => {
  it.each([
    ['git commit -m "feat(x): y"', 'feat(x): y'],
    ["git commit -m 'fix: y'", 'fix: y'],
    ['git commit -am "fix: y"', 'fix: y'],
    ['git commit --message "fix: y"', 'fix: y'],
    ["git commit -m \"$(cat <<'EOF'\nfeat: y\n\nbody\nEOF\n)\"", 'feat: y'],
    ["git commit -m @'\nfeat: y\n'@", 'feat: y'],
    ['git commit -F msg.txt', null],
    ['git commit', null],
  ])('%j -> %j', (command, head) => {
    expect(commitMessageHead(command)).toBe(head);
  });
});

describe('the built hook (stdin to stdout)', () => {
  const hooksDir = resolve(__dirname, '..', '..');
  const dist = (name: string): string => join(hooksDir, 'dist', `${name}.mjs`);

  const run = (name: string, stdin: string, env: Record<string, string> = {}) =>
    spawnSync('node', [dist(name)], { input: stdin, encoding: 'utf8', env: { ...process.env, VITEST: '', ...env }, timeout: 20_000 });

  it('prints {} for empty and malformed input', () => {
    expect(existsSync(dist('commit-preflight'))).toBe(true);
    expect(run('commit-preflight', '').stdout.trim()).toBe('{}');
    expect(run('commit-preflight', '{nope').stdout.trim()).toBe('{}');
  });

  // combined-first-commit: breaks when the two outputs conflict (two decisions, or the deny
  // loses the rule text).
  it('the first commit of a session: rule-router denies with the rule, preflight adds its context', () => {
    const home = tempDir('home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const repo = mkRepo(tempDir('combo'), 'work');
    writeRegistry(join(home, '.claude', 'project-registry.json'), [{ name: 'p', path: repo, e2e: { command: 'x' } }]);
    const session = newSession();
    const stdin = JSON.stringify(loadFixture('commit-no-proof', { REPO: repo, SESSION: session }));
    const stateDir = tempDir('rr-state');
    const env = {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_RULES_ONDEMAND_DIR: resolve(hooksDir, '..', 'rules-ondemand'),
      CLAUDE_RULE_ROUTER_STATE_DIR: stateDir,
      CLAUDE_RULE_ROUTER_LOG: join(stateDir, 'log.jsonl'),
      CLAUDE_AGENT_ID: '',
      CI: '',
    };
    const router = JSON.parse(run('rule-router', stdin, env).stdout);
    const pre = JSON.parse(run('commit-preflight', stdin, env).stdout);
    expect(router.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(router.hookSpecificOutput.permissionDecisionReason).toContain('git-safe.ps1');
    expect(pre.hookSpecificOutput.additionalContext).toContain('verify.mjs');
    expect(pre.hookSpecificOutput).not.toHaveProperty('permissionDecision');
    // The re-issued commit: the router is quiet, the preflight still speaks.
    expect(JSON.parse(run('rule-router', stdin, env).stdout)).toEqual({ result: 'continue' });
    expect(JSON.parse(run('commit-preflight', stdin, env).stdout).hookSpecificOutput.additionalContext).toContain('verify.mjs');
  });
});
