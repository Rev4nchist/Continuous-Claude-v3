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
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync, readdirSync } from 'fs';
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
    return { claims: seen.listDegraded ? [] : seen.held, degraded: seen.listDegraded };
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
