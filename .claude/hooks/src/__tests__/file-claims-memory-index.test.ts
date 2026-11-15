/**
 * Card coord-file-claims-memory-index: the per-project memory index (`.claude/projects/<project>/memory/MEMORY.md`)
 * is one append point that every session shares. The file guard must never hold it.
 *
 * Why not a short lease: a takeover needs an expired lease AND a holder quiet for 5 minutes, so an alive
 * session would still keep the file. The guard skips the file instead: no claim row, no deny.
 *
 * Ways it can fail (one test or row each):
 *  1. A second session is denied an Edit or Write of the index (the bug).
 *  2. Only one spelling is skipped: backslashes, upper-case drive and folders, a relative path from another cwd,
 *     a ".." form, a junction from outside the folder. The CANONICAL real path decides (seat word 2026-11-15).
 *  3. The rule is too wide: another memory file, a MEMORY.md outside `memory/`, a MEMORY.md in a sub folder of
 *     `memory/`, a file spelled under the index folder whose real path is elsewhere, are skipped.
 *  4. The claim is still written for the index (a row with no deny still holds the file for the next session).
 *  5. An old claim row for the index (a session that started before this change) still stops a shell write.
 *  6. The shell guard stops being strict for a held file that is not the index.
 *  7. An ordinary file gets another claim key (the key rules are not part of this card).
 *
 * The DB module is mocked (pattern of file-claims-all-writers.test.ts); the repo is a real temp git repo.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { realFilePath, resolveClaimKey, resolveRepoContext } from '../shared/claim-target.js';
import * as leases from '../shared/leases.js';

const FOLDS = process.platform === 'win32' || process.platform === 'darwin';

const seen = vi.hoisted(() => ({
  claimCalls: [] as string[],
  payload: '',
  blockAll: true,
  held: [] as Array<{ filePath: string; sessionId: string; project: string }>,
}));

vi.mock('../shared/db-utils-pg.js', () => ({
  // Another session holds EVERY file: any claim call that reaches the database is blocked.
  resolveFileClaim: async (filePath: string) => {
    seen.claimCalls.push(filePath);
    return seen.blockAll
      ? { outcome: 'blocked', holder: 'other-session', leaseClass: 'file', leaseExpired: false }
      : { outcome: 'granted' };
  },
  listBlockingClaims: async () => ({ claims: seen.held, degraded: false }),
}));
vi.mock('../shared/holder-lane.js', () => ({ holderHoldsOpenLane: async () => true }));
vi.mock('fs', async (importOriginal) => {
  const real = (await importOriginal()) as typeof import('fs');
  return {
    ...real,
    readFileSync: ((p: unknown, ...rest: unknown[]) =>
      p === 0 ? seen.payload : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.readFileSync,
  };
});

let root: string;
let home: string; // a stand-in for the user's home: it holds `.claude`, a git repo of its own (as the real one is)
let claudeDir: string;
let indexFile: string; // <home>/.claude/projects/p1/memory/MEMORY.md
const saved: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd, stdio: 'ignore' });
}

type Out = { result?: string; message?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };

async function run(tool: string, toolInput: unknown, extra: Record<string, unknown> = {}): Promise<Out> {
  seen.payload = JSON.stringify({ tool_name: tool, session_id: 'me', cwd: claudeDir, tool_input: toolInput, ...extra });
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
const slash = (p: string) => p.replace(/\\/g, '/');
const back = (p: string) => p.replace(/\//g, '\\');

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fc-memidx-')));
  home = join(root, 'home');
  claudeDir = join(home, '.claude');
  mkdirSync(join(claudeDir, 'projects', 'p1', 'memory', 'sub'), { recursive: true });
  mkdirSync(join(claudeDir, 'src'), { recursive: true });
  indexFile = join(claudeDir, 'projects', 'p1', 'memory', 'MEMORY.md');
  writeFileSync(indexFile, '- one\n');
  writeFileSync(join(claudeDir, 'projects', 'p1', 'memory', 'other.md'), 'x');
  writeFileSync(join(claudeDir, 'projects', 'p1', 'memory', 'sub', 'MEMORY.md'), 'x');
  writeFileSync(join(claudeDir, 'projects', 'p1', 'MEMORY.md'), 'x');
  writeFileSync(join(claudeDir, 'src', 'MEMORY.md'), 'x');
  git(claudeDir, 'init', '-q');
  git(claudeDir, 'add', '-A');
  git(claudeDir, 'commit', '-q', '-m', 'init');
  for (const k of ['CCV3_GUARD_DECISIONS_LOG', 'CCV3_FILE_CLAIMS_STATE_DIR']) saved[k] = process.env[k];
  process.env.CCV3_GUARD_DECISIONS_LOG = join(root, 'guard.jsonl');
  process.env.CCV3_FILE_CLAIMS_STATE_DIR = join(root, 'state');
  seen.claimCalls = [];
  seen.blockAll = true;
  seen.held = [];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('the index is never held (Edit and Write)', () => {
  it('1. a second session may edit the index: no deny, and no claim is written', async () => {
    const o = await run('Edit', { file_path: slash(indexFile) });
    expect(denied(o)).toBe(false);
    expect(seen.claimCalls).toEqual([]);
    expect(denied(await run('Write', { file_path: slash(indexFile) }))).toBe(false);
    expect(seen.claimCalls).toEqual([]);
  });

  it('2a. a backslash spelling is the index too', async () => {
    expect(denied(await run('Edit', { file_path: back(indexFile) }))).toBe(false);
    expect(seen.claimCalls).toEqual([]);
  });

  it.skipIf(!FOLDS)('2b. an upper-case drive and upper-case folder names are the index too (win32, darwin)', async () => {
    expect(denied(await run('Edit', { file_path: slash(indexFile).toUpperCase() }))).toBe(false);
    expect(seen.claimCalls).toEqual([]);
  });

  it('2c. a relative path from another cwd is the index too', async () => {
    const o = await run('Edit', { file_path: 'p1/memory/MEMORY.md' }, { cwd: join(claudeDir, 'projects') });
    expect(denied(o)).toBe(false);
    expect(seen.claimCalls).toEqual([]);
  });

  it('2d. a ".." form is the index too', async () => {
    const dotted = `${slash(claudeDir)}/src/../projects/p1/memory/MEMORY.md`;
    expect(denied(await run('Edit', { file_path: dotted }))).toBe(false);
    expect(seen.claimCalls).toEqual([]);
  });

  it('2e. a path reached through a link from OUTSIDE the folder is the index too: the real path decides', async () => {
    const link = join(root, 'outside-link');
    symlinkSync(join(claudeDir, 'projects', 'p1', 'memory'), link, 'junction');
    const o = await run('Edit', { file_path: `${slash(link)}/MEMORY.md` }, { cwd: root });
    expect(denied(o)).toBe(false);
    expect(seen.claimCalls).toEqual([]);
  });

  it.skipIf(!FOLDS)('2g. a NEW index spelled in another case (the file does not exist yet, so the real path keeps the typed case) is the index too (win32, darwin)', async () => {
    mkdirSync(join(claudeDir, 'projects', 'p3', 'memory'), { recursive: true });
    const typed = `${slash(claudeDir)}/projects/p3/memory/memory.md`;
    expect(denied(await run('Write', { file_path: typed }))).toBe(false);
    expect(seen.claimCalls).toEqual([]);
  });

  it('2f. a new index in a new project folder (the file does not exist yet) is the index too', async () => {
    const fresh = `${slash(claudeDir)}/projects/p9/memory/MEMORY.md`;
    expect(denied(await run('Write', { file_path: fresh }))).toBe(false);
    expect(seen.claimCalls).toEqual([]);
  });
});

describe('one real-path step for the key and for the index test (seat item 2: they cannot drift)', () => {
  it('2h. realFilePath and resolveClaimKey agree on every spelling of the index (2a to 2e)', () => {
    const link = join(root, 'outside-link');
    symlinkSync(join(claudeDir, 'projects', 'p1', 'memory'), link, 'junction');
    const top = resolveRepoContext(claudeDir)!.top;
    const spellings: Array<[string, string]> = [
      [slash(indexFile), claudeDir],
      [back(indexFile), claudeDir],
      ['p1/memory/MEMORY.md', join(claudeDir, 'projects')],
      [`${slash(claudeDir)}/src/../projects/p1/memory/MEMORY.md`, claudeDir],
      [`${slash(link)}/MEMORY.md`, root],
    ];
    const norm = (s: string) => (FOLDS ? slash(s).toLowerCase() : slash(s));
    const seenStrings = new Set<string>();
    for (const [spelling, cwd] of spellings) {
      const key = resolveClaimKey(spelling, { cwd })!;
      expect(key).not.toBeNull();
      const fromKey = norm(`${top}/${key.filePath}`);
      const fromStep = norm(realFilePath(spelling, cwd)!);
      expect(fromStep).toBe(fromKey);
      seenStrings.add(fromStep);
    }
    expect(seenStrings.size).toBe(1); // five spellings, one string
  });
});

describe('controls: everything else is still held', () => {
  it('3a. another memory file is held', async () => {
    const o = await run('Edit', { file_path: join(claudeDir, 'projects', 'p1', 'memory', 'other.md') });
    expect(denied(o)).toBe(true);
    expect(seen.claimCalls.length).toBe(1);
  });
  it('3b. a MEMORY.md outside a memory folder is held', async () => {
    expect(denied(await run('Edit', { file_path: join(claudeDir, 'src', 'MEMORY.md') }))).toBe(true);
    expect(denied(await run('Edit', { file_path: join(claudeDir, 'projects', 'p1', 'MEMORY.md') }))).toBe(true);
  });
  it('3c. a MEMORY.md in a sub folder of memory/ is held', async () => {
    expect(denied(await run('Edit', { file_path: join(claudeDir, 'projects', 'p1', 'memory', 'sub', 'MEMORY.md') }))).toBe(true);
  });
  it('3d. a path spelled under the index folder whose REAL file is elsewhere is held (the real path decides)', async () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'MEMORY.md'), 'x');
    symlinkSync(elsewhere, join(claudeDir, 'projects', 'p1', 'memory-link'), 'junction');
    mkdirSync(join(claudeDir, 'projects', 'p2'), { recursive: true });
    symlinkSync(elsewhere, join(claudeDir, 'projects', 'p2', 'memory'), 'junction');
    const o = await run('Edit', { file_path: `${slash(claudeDir)}/projects/p2/memory/MEMORY.md` });
    expect(denied(o)).toBe(true);
    expect(seen.claimCalls.length).toBe(1);
  });
  it('3e. an ordinary file keeps its claim key (the key rules are not part of this card)', async () => {
    const f = join(claudeDir, 'src', 'MEMORY.md');
    const key = resolveClaimKey(f, { cwd: claudeDir })!;
    await run('Edit', { file_path: f });
    expect(seen.claimCalls).toEqual([key.filePath]);
  });
});

describe('shell text: an old claim row for the index blocks nobody', () => {
  function heldRow(file: string) {
    const key = resolveClaimKey(file, { cwd: claudeDir })!;
    return { filePath: key.filePath, sessionId: 'other-session', project: key.project };
  }
  const project = () => resolveRepoContext(claudeDir)!.project;

  it('5. a shell append to the index passes although a row from an older session holds it', async () => {
    seen.held = [heldRow(indexFile)];
    expect(seen.held[0].project).toBe(project());
    const o = await run('Bash', { command: `echo "- line" >> '${slash(indexFile)}'` });
    expect(denied(o)).toBe(false);
  });
  it('6. the same shell append to another held memory file is still stopped', async () => {
    const other = join(claudeDir, 'projects', 'p1', 'memory', 'other.md');
    seen.held = [heldRow(other)];
    const o = await run('Bash', { command: `echo "- line" >> '${slash(other)}'` });
    expect(denied(o)).toBe(true);
  });
});

describe('isMemoryIndexPath (pure)', () => {
  const fn = (p: string, fold: boolean): boolean => (leases as unknown as { isMemoryIndexPath(p: string, fold: boolean): boolean }).isMemoryIndexPath(p, fold);
  it('accepts the index in slash and backslash form', () => {
    expect(fn('C:/Users/d/.claude/projects/C--Users-d-x/memory/MEMORY.md', true)).toBe(true);
    expect(fn('C:\\Users\\d\\.claude\\projects\\p\\memory\\MEMORY.md', true)).toBe(true);
    expect(fn('/home/d/.claude/projects/p/memory/MEMORY.md', false)).toBe(true);
  });
  it('folds case only when the file system folds it', () => {
    expect(fn('c:/users/d/.claude/projects/p/memory/memory.md', true)).toBe(true);
    expect(fn('/home/d/.claude/projects/p/memory/memory.md', false)).toBe(false);
  });
  it('rejects everything that is not the index', () => {
    for (const p of [
      '/h/.claude/projects/p/memory/other.md',
      '/h/.claude/projects/p/memory/MEMORY.md.bak',
      '/h/.claude/projects/p/memory/sub/MEMORY.md',
      '/h/.claude/projects/p/MEMORY.md',
      '/h/.claude/projects/memory/MEMORY.md',
      '/h/.claude/src/MEMORY.md',
      '/h/proj/memory/MEMORY.md',
      '/h/x.claude/projects/p/memory/MEMORY.md',
      'MEMORY.md',
      '',
    ]) expect(fn(p, true)).toBe(false);
  });
});
