/**
 * Card coord-file-claims-all-writers: file-claims checks every writer, not Edit and Write only.
 *
 * Ways it can fail (one test each):
 *  1. A group A tool (NotebookEdit, write_file, edit_block, move_file) writes a held file and is not stopped.
 *  2. move_file checks only one of its two paths.
 *  3. A shell write (Bash, PowerShell, Desktop Commander start_process) to a held file is not stopped.
 *  4. A shell write to a FREE file, or a read of a held file, is stopped (a guard that stops every shell call).
 *  5. A shell call makes a claim for the shell session (a path found in text must never become a claim).
 *  6. A path hit with no cue warns on every call, not once per session and path.
 *  7. The database is down and a shell call prints a warning (it would bury the banner).
 *  8. A review-agent (engine) run gets hook text, runs the claim query or writes a state file.
 *  9. A Desktop Commander shell call with an unreadable command field is allowed.
 * 10. Edit and Write change behaviour (they keep their one claim call and their deny).
 *
 * The DB module is mocked (pattern of file-claims-cache-key.test.ts); the repo is a real temp git repo.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveRepoContext } from '../shared/claim-target.js';

const DC = 'mcp__plugin_desktop-commander_desktop-commander__';

const seen = vi.hoisted(() => ({
  claimCalls: [] as string[],
  listCalls: 0,
  payload: '',
  blocked: new Set<string>(),
  held: [] as Array<{ filePath: string; sessionId: string; project: string }>,
  listDegraded: false,
  openLane: true as boolean | null,
  throwLane: false,
}));

vi.mock('../shared/db-utils-pg.js', () => ({
  resolveFileClaim: async (filePath: string) => {
    seen.claimCalls.push(filePath);
    return seen.blocked.has(filePath)
      ? { outcome: 'blocked', holder: 'other-session', leaseClass: 'edit', leaseExpired: false }
      : { outcome: 'granted' };
  },
  listBlockingClaims: async () => {
    seen.listCalls++;
    // Degraded WITH claims: only the degraded flag may keep the hook from denying (review F13).
    return { claims: seen.held, degraded: seen.listDegraded };
  },
}));
vi.mock('../shared/holder-lane.js', () => ({
  holderHoldsOpenLane: async () => {
    if (seen.throwLane) throw new Error('lane lookup down');
    return seen.openLane;
  },
}));
vi.mock('fs', async (importOriginal) => {
  const real = (await importOriginal()) as typeof import('fs');
  return {
    ...real,
    readFileSync: ((p: unknown, ...rest: unknown[]) =>
      p === 0 ? seen.payload : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.readFileSync,
  };
});

let root: string;
let repo: string;
let stateDir: string;
let project: string;
const saved: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd, stdio: 'ignore' });
}

type Out = { result?: string; message?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };

async function run(tool: string, toolInput: unknown, extra: Record<string, unknown> = {}): Promise<Out> {
  seen.payload = JSON.stringify({ tool_name: tool, session_id: 'me', cwd: repo, tool_input: toolInput, ...extra });
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.resetModules();
  await import('../file-claims.js');
  await vi.waitFor(() => expect(out).toHaveBeenCalled());
  const text = out.mock.calls[0][0] as string;
  out.mockRestore();
  return JSON.parse(text) as Out;
}

const denied = (o: Out) => o.hookSpecificOutput?.permissionDecision === 'deny';
const abs = (rel: string) => join(repo, rel).replace(/\\/g, '/');

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fc-all-')));
  repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'src', 'held.ts'), 'x');
  writeFileSync(join(repo, 'src', 'free.ts'), 'x');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  stateDir = join(root, 'state');
  for (const k of ['CCV3_GUARD_DECISIONS_LOG', 'CCV3_FILE_CLAIMS_STATE_DIR']) saved[k] = process.env[k];
  process.env.CCV3_GUARD_DECISIONS_LOG = join(root, 'guard.jsonl');
  process.env.CCV3_FILE_CLAIMS_STATE_DIR = stateDir;
  seen.claimCalls = [];
  seen.listCalls = 0;
  seen.blocked = new Set(['src/held.ts']);
  project = resolveRepoContext(repo)!.project;
  seen.held = [{ filePath: 'src/held.ts', sessionId: 'other-session', project }];
  seen.listDegraded = false;
  seen.openLane = true;
  seen.throwLane = false;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('group A: exact path writers', () => {
  it('stops NotebookEdit, write_file and edit_block on a held file', async () => {
    expect(denied(await run('NotebookEdit', { notebook_path: abs('src/held.ts') }))).toBe(true);
    expect(denied(await run(`${DC}write_file`, { path: abs('src/held.ts'), content: 'x' }))).toBe(true);
    expect(denied(await run(`${DC}edit_block`, { file_path: abs('src/held.ts') }))).toBe(true);
  });
  it('lets them write a free file, and claims it', async () => {
    const o = await run(`${DC}write_file`, { path: abs('src/free.ts'), content: 'x' });
    expect(denied(o)).toBe(false);
    expect(seen.claimCalls).toEqual(['src/free.ts']);
  });
  it('move_file checks both paths: a held destination or a held source stops it', async () => {
    expect(denied(await run(`${DC}move_file`, { source: abs('src/free.ts'), destination: abs('src/held.ts') }))).toBe(true);
    expect(denied(await run(`${DC}move_file`, { source: abs('src/held.ts'), destination: abs('src/free.ts') }))).toBe(true);
    seen.claimCalls = [];
    expect(denied(await run(`${DC}move_file`, { source: abs('src/free.ts'), destination: abs('src/new.ts') }))).toBe(false);
    expect(seen.claimCalls.sort()).toEqual(['src/free.ts', 'src/new.ts']);
  });
  it('Edit and Write keep one claim call and their deny', async () => {
    expect(denied(await run('Edit', { file_path: abs('src/held.ts') }))).toBe(true);
    seen.claimCalls = [];
    expect(denied(await run('Write', { file_path: abs('src/free.ts') }))).toBe(false);
    expect(seen.claimCalls).toEqual(['src/free.ts']);
    expect(seen.listCalls).toBe(0);
  });
  it('a tool that is not a writer is not touched', async () => {
    const o = await run('Read', { file_path: abs('src/held.ts') });
    expect(o).toEqual({ result: 'continue' });
    expect(seen.claimCalls).toEqual([]);
    expect(seen.listCalls).toBe(0);
  });
});

describe('group B: shell text', () => {
  it('stops a redirect from Bash, a Set-Content from PowerShell and a Desktop Commander start_process', async () => {
    expect(denied(await run('Bash', { command: `echo x > '${abs('src/held.ts')}'` }))).toBe(true);
    expect(denied(await run('PowerShell', { command: `Set-Content -LiteralPath '${abs('src/held.ts')}' -Value x` }))).toBe(true);
    expect(denied(await run(`${DC}start_process`, { command: 'echo x > src/held.ts' }))).toBe(true);
    expect(denied(await run(`${DC}interact_with_process`, { input: 'echo x > src/held.ts' }))).toBe(true);
  });
  it('finds the file by its cwd-relative name', async () => {
    expect(denied(await run('Bash', { command: 'echo x > src/held.ts' }))).toBe(true);
  });
  it('lets a write to a free file continue with no text', async () => {
    const o = await run('Bash', { command: 'echo x > src/free.ts' });
    expect(o).toEqual({ result: 'continue' });
  });
  it('lets the three read commands of the seat continue', async () => {
    for (const command of [
      'node --test src/held.ts 2>&1 | tail -5',
      'git diff main -- src/held.ts > scratch.txt',
      'cat src/held.ts 2>/dev/null',
    ]) {
      expect(denied(await run('Bash', { command }))).toBe(false);
    }
  });
  it('a shell call never makes a claim', async () => {
    await run('Bash', { command: 'echo x > src/free.ts' });
    await run('Bash', { command: 'echo x > src/held.ts' });
    expect(seen.claimCalls).toEqual([]);
  });
  it('a path hit with no cue warns once per session and path, then is silent', async () => {
    const first = await run('Bash', { command: 'cat src/held.ts' });
    expect(first.message ?? '').toMatch(/^\[WARN\]/);
    expect(first.message).toContain('src/held.ts');
    const second = await run('Bash', { command: 'grep -n x src/held.ts' });
    expect(second).toEqual({ result: 'continue' });
    const otherSession = await run('Bash', { command: 'cat src/held.ts' }, { session_id: 'someone-else' });
    expect(otherSession.message ?? '').toMatch(/^\[WARN\]/);
  });
  it('database down: silent continue, no warning line', async () => {
    seen.listDegraded = true;
    const o = await run('Bash', { command: 'echo x > src/held.ts' });
    expect(o).toEqual({ result: 'continue' });
  });
  it('a Desktop Commander shell call with an unreadable command field is denied', async () => {
    expect(denied(await run(`${DC}start_process`, { command: 5 }))).toBe(true);
    expect(denied(await run(`${DC}interact_with_process`, {}))).toBe(true);
  });
  it('a plain Bash call with no command text continues', async () => {
    expect(denied(await run('Bash', {}))).toBe(false);
  });
  it('asks no query for an empty command, and continues when nobody holds a file', async () => {
    expect(await run('Bash', { command: '  ' })).toEqual({ result: 'continue' });
    expect(seen.listCalls).toBe(0);
    seen.held = [];
    expect(await run('Bash', { command: 'echo hello' })).toEqual({ result: 'continue' });
  });
});

describe('group B: the cwd is not the repo of the file', () => {
  it('a shell started outside any repo is stopped when it names the held file by absolute path', async () => {
    const outside = join(root, 'elsewhere');
    mkdirSync(outside, { recursive: true });
    const o = await run('Bash', { command: `echo x > '${abs('src/held.ts')}'` }, { cwd: outside });
    expect(denied(o)).toBe(true);
  });
  it('a bare repo-relative name in ANOTHER repo is not the held file (no cross-repo false deny)', async () => {
    const other = join(root, 'other-repo');
    mkdirSync(join(other, 'src'), { recursive: true });
    git(other, 'init', '-q');
    const o = await run('Bash', { command: 'echo x > src/held.ts' }, { cwd: other });
    expect(denied(o)).toBe(false);
  });
  it('a linked worktree of the held repo: the same file by its worktree path or its bare name is stopped', async () => {
    const wt = join(repo, '.claude', 'worktrees', 'w1');
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'w1');
    const wtFwd = wt.split('\\').join('/');
    const viaPath = await run('Bash', { command: `echo x > '${wtFwd}/src/held.ts'` }, { cwd: wt });
    expect(denied(viaPath)).toBe(true);
    const viaRel = await run('Bash', { command: 'echo x > src/held.ts' }, { cwd: wt });
    expect(denied(viaRel)).toBe(true);
  });
});

describe('group B: a tracked file is one claim across worktrees, a .claude/cache file is local to one checkout (PR 544)', () => {
  const linked = (): string => {
    const wt = join(repo, '.claude', 'worktrees', 'w2');
    mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'w2');
    return wt.split('\\').join('/');
  };
  it('tracked file: a claim made in checkout P stops a write named under the linked worktree W (one key, row 2 of the drill)', async () => {
    const wt = linked();
    expect(denied(await run('Bash', { command: `echo x > '${wt}/src/held.ts'` }, { cwd: wt }))).toBe(true);
  });
  it('cache file: a claim keyed by the absolute path in P does not stop the same name under W', async () => {
    const wt = linked();
    const inP = abs('.claude/cache/pre-pr/summary.md');
    seen.held = [{ filePath: inP, sessionId: 'other-session', project }];
    // (a) the file under W is another file: continue
    expect(denied(await run('Bash', { command: `echo x > '${wt}/.claude/cache/pre-pr/summary.md'` }, { cwd: wt }))).toBe(false);
    // (b) the absolute path under P, run with cwd in W: the claim holds
    expect(denied(await run('Bash', { command: `echo x > '${inP}'` }, { cwd: wt }))).toBe(true);
    // a bare relative name from the cwd in W is W's file, not the claimed one
    expect(denied(await run('Bash', { command: 'echo x > .claude/cache/pre-pr/summary.md' }, { cwd: wt }))).toBe(false);
  });
});

describe('review round 1 (seat reviewer, 2026-11-13 11:21)', () => {
  const guardRows = (): Array<Record<string, string>> =>
    (existsSync(join(root, 'guard.jsonl')) ? readFileSync(join(root, 'guard.jsonl'), 'utf8').split('\n').filter(Boolean) : [])
      .map((l) => JSON.parse(l) as Record<string, string>);

  it('F1 b c: the deny says "may write", names the cue it saw, and the guard log keeps the cue', async () => {
    const o = await run('Bash', { command: 'rm -f out.log; cat src/held.ts' });
    expect(denied(o)).toBe(true);
    const text = o.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(text).toContain('may write');
    expect(text).not.toMatch(/ writes "/);
    expect(text).toContain('"rm"');
    const row = guardRows().find((r) => r.hook === 'file-claims' && r.decision === 'deny');
    expect(row?.reason).toContain('cue=rm');
  });

  it('F13: break-glass on a shell write continues with a warning and logs an override', async () => {
    process.env.COORDINATION_BREAK_GLASS = '1';
    try {
      const o = await run('Bash', { command: 'echo x > src/held.ts' });
      expect(denied(o)).toBe(false);
      expect(o.message ?? '').toMatch(/^\[WARN\] BREAK-GLASS/);
      expect(guardRows().some((r) => r.decision === 'override')).toBe(true);
    } finally {
      delete process.env.COORDINATION_BREAK_GLASS;
    }
  });

  it('F13: the database-down branch is decided by the degraded flag alone (the mock returns claims)', async () => {
    seen.listDegraded = true;
    expect(seen.held.length).toBeGreaterThan(0);
    expect(await run('Bash', { command: 'echo x > src/held.ts' })).toEqual({ result: 'continue' });
  });

  it('F9: move_file checks the destination first, so a held destination leaves no claim on the source', async () => {
    seen.claimCalls = [];
    const o = await run(`${DC}move_file`, { source: abs('src/free.ts'), destination: abs('src/held.ts') });
    expect(denied(o)).toBe(true);
    expect(seen.claimCalls).toEqual(['src/held.ts']);
  });

  it('F10: a message about a cache claim prints the base name, not the stored absolute path', async () => {
    const inP = abs('.claude/cache/pre-pr/summary.md');
    seen.held = [{ filePath: inP, sessionId: 'other-session', project }];
    const deny = (await run('Bash', { command: `echo x > '${inP}'` })).hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(deny).toContain('summary.md');
    expect(deny).not.toContain(root.split('\\').join('/'));
    const warn = (await run('Bash', { command: `cat '${inP}'` })).message ?? '';
    expect(warn).toContain('summary.md');
    expect(warn).not.toContain(root.split('\\').join('/'));
  });

  it('F2: where case is kept (Linux) and the cwd is outside the repo, an absolute path with upper case still hits', async () => {
    const mixed = join(root, 'MixedCase');
    mkdirSync(join(mixed, 'src'), { recursive: true });
    git(mixed, 'init', '-q');
    writeFileSync(join(mixed, 'src', 'held.ts'), 'x');
    const p2 = resolveRepoContext(mixed)!.project;
    seen.held = [{ filePath: 'src/held.ts', sessionId: 'other-session', project: p2 }];
    const outside = join(root, 'elsewhere2');
    mkdirSync(outside, { recursive: true });
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const o = await run('Bash', { command: `echo x > '${mixed.split('\\').join('/')}/src/held.ts'` }, { cwd: outside });
      expect(denied(o)).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: real });
    }
  });
});

describe('engine host (review agent)', () => {
  it('prints no text, asks no query and writes no state file for a shell call', async () => {
    const o = await run('Bash', { command: 'cat src/held.ts' }, { hook_event_name: 'preToolUse' });
    expect(o).toEqual({ result: 'continue' });
    expect(seen.listCalls).toBe(0);
    expect(existsSync(stateDir) ? readdirSync(stateDir) : []).toEqual([]);
  });
  it('a group A write still gets the claim check under the engine (the deny guard keeps its behaviour)', async () => {
    const o = await run('Edit', { file_path: abs('src/held.ts') }, { hook_event_name: 'preToolUse' });
    expect(denied(o)).toBe(true);
  });
});

// Card coord-file-guard-named-file (seat ruling 2026-11-15): the PowerShell tool reads a backtick line break inside a
// double-quoted note as plain text, so a note that only NAMES a held file passes. Bash and Desktop Commander keep every
// backtick as a risk sign, and a write to the held file still denies.
describe('named file in a note with a backtick line break', () => {
  const NOTE = 'Add-Content -Path notes/own.md -Value "- 08:20 src/held.ts landed`n- next step"';

  it('PowerShell: the note passes', async () => {
    expect(denied(await run('PowerShell', { command: NOTE }))).toBe(false);
  });

  it('Bash: the same text still denies (the Bash reading keeps the backtick as a risk sign)', async () => {
    expect(denied(await run('Bash', { command: NOTE }))).toBe(true);
  });

  it('Desktop Commander start_process: the same text still denies', async () => {
    expect(denied(await run(`${DC}start_process`, { command: NOTE }))).toBe(true);
  });

  it('PowerShell: a write to the held file with a backtick line break still denies', async () => {
    expect(denied(await run('PowerShell', { command: 'Add-Content src/held.ts "line one`nline two"' }))).toBe(true);
  });
});

// Card coord-file-guard-named-file (seat ruling 2026-11-15, Q1): a deny names the holder handle and the exact release
// command, and says "the holder's card is done" only when the holder holds no open lane. The guard never releases a claim:
// a release stays the holder's act.
//
// Ways this can fail:
//  1. The deny text has no holder handle or no release command (a blocked session cannot tell the holder what to run).
//  2. "card is done" shows for a holder that still holds an open lane (a false statement), or when the lookup is down.
//  3. The lookup breaks the deny (a database error must leave the deny as it was).
//  4. The text appears for the shell deny but not for the Edit deny (two deny paths).
describe('deny text names the holder and the release command', () => {
  const reason = (o: Out) => o.hookSpecificOutput?.permissionDecisionReason ?? '';
  const SHELL = { command: 'Set-Content src/held.ts "x"' };

  it('shell deny: handle, release command with the path; "card is done" when the holder holds no open lane', async () => {
    seen.openLane = false;
    const r = reason(await run('PowerShell', SHELL));
    expect(r).toContain('#other-se');
    expect(r).toContain('release-claim.mjs src/held.ts');
    expect(r).toContain("the holder's card is done");
  });

  it('shell deny: no "card is done" while the holder holds an open lane', async () => {
    seen.openLane = true;
    const r = reason(await run('PowerShell', SHELL));
    expect(r).toContain('release-claim.mjs src/held.ts');
    expect(r).not.toContain('card is done');
  });

  it('shell deny: no "card is done" when the lane lookup is down (unknown)', async () => {
    seen.openLane = null;
    const r = reason(await run('PowerShell', SHELL));
    expect(r).toContain('release-claim.mjs src/held.ts');
    expect(r).not.toContain('card is done');
  });

  it('Edit deny carries the same lines', async () => {
    seen.openLane = false;
    const r = reason(await run('Edit', { file_path: abs('src/held.ts') }));
    expect(r).toContain('#other-se');
    expect(r).toContain('release-claim.mjs src/held.ts');
    expect(r).toContain("the holder's card is done");
  });

  it('a lookup that throws leaves the deny in place', async () => {
    seen.openLane = 'boom' as unknown as boolean;
    seen.throwLane = true;
    const o = await run('PowerShell', SHELL);
    expect(denied(o)).toBe(true);
    expect(reason(o)).not.toContain('card is done');
  });
});
