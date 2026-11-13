/**
 * Card coord-file-claims-worktree-local: a git-ignored per-worktree file under `.claude/cache/`
 * is not one claim for every worktree (the pre-pr summary file blocked a second worktree after
 * PR 536). A TRACKED file stays one claim across worktrees (rows 2 and 2-cross of coord-drill-2).
 *
 * Ways it can fail (one test each):
 *  1. A cache file in two worktrees gets ONE key (a false conflict: two sessions cannot run pre-pr).
 *  2. The same cache file in ONE worktree gets a key that two sessions do not share (the guard goes blind).
 *  3. A tracked file in two worktrees stops being one key (a weaker guard: the hard condition).
 *  4. The rule matches a sibling such as `.claude/cachex/` (too wide), or misses another case on win32.
 *  5. A path that reaches a tracked file through `..` is read as a cache file (a hole in the guard).
 *
 * The hook test mocks the DB call and fd 0 (pattern of file-claims-worktree-key.test.ts) and records
 * the arguments of resolveFileClaim. Real temp repos and a real `git worktree add`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveClaimKey } from '../shared/claim-target.js';

const seen = vi.hoisted(() => ({
  calls: [] as Array<{ filePath: string; project: string }>,
  payload: '',
}));

vi.mock('../shared/db-utils-pg.js', () => ({
  resolveFileClaim: async (filePath: string, project: string) => {
    seen.calls.push({ filePath, project });
    return { outcome: 'granted' };
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
let primary: string;
let wt: string;
let savedLog: string | undefined;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd, stdio: 'ignore' });
}

async function runHook(cwd: string, filePath: string): Promise<void> {
  seen.payload = JSON.stringify({ tool_name: 'Write', session_id: 's1', cwd, tool_input: { file_path: filePath } });
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.resetModules();
  await import('../file-claims.js');
  await vi.waitFor(() => expect(out).toHaveBeenCalled());
  out.mockRestore();
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fc-cache-')));
  primary = join(root, 'primary');
  mkdirSync(join(primary, 'src'), { recursive: true });
  git(primary, 'init', '-q');
  writeFileSync(join(primary, 'src', 'x.ts'), 'x');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-q', '-m', 'init');
  // The real layout: a linked worktree inside the primary checkout's .claude/worktrees folder.
  wt = join(primary, '.claude', 'worktrees', 'g1');
  mkdirSync(join(primary, '.claude', 'worktrees'), { recursive: true });
  git(primary, 'worktree', 'add', '-q', wt, '-b', 'b1');
  seen.calls = [];
  savedLog = process.env.CCV3_GUARD_DECISIONS_LOG;
  process.env.CCV3_GUARD_DECISIONS_LOG = join(root, 'guard.jsonl');
});
afterEach(() => {
  if (savedLog === undefined) delete process.env.CCV3_GUARD_DECISIONS_LOG;
  else process.env.CCV3_GUARD_DECISIONS_LOG = savedLog;
  rmSync(root, { recursive: true, force: true });
});

const CACHE = join('.claude', 'cache', 'pre-pr', 'summary.md');

describe('resolveClaimKey: .claude/cache files keep the per-worktree (old) key', () => {
  it('returns null for a cache file in the primary and in a worktree, so the caller keeps the raw path', () => {
    expect(resolveClaimKey(join(primary, CACHE))).toBeNull();
    expect(resolveClaimKey(join(wt, CACHE))).toBeNull();
  });

  it('keeps ONE key for a tracked file across the primary and the worktree (the hard condition)', () => {
    const a = resolveClaimKey(join(primary, 'src', 'x.ts'));
    const b = resolveClaimKey(join(wt, 'src', 'x.ts'));
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
    expect(a?.filePath).toBe('src/x.ts');
  });

  it('matches only the .claude/cache folder: a sibling keeps the repo key', () => {
    expect(resolveClaimKey(join(wt, '.claude', 'cachex', 'y.md'))).not.toBeNull();
    expect(resolveClaimKey(join(wt, 'cache', 'y.md'))).not.toBeNull();
    expect(resolveClaimKey(join(wt, '.claude', 'cache', 'y.md'))).toBeNull();
    expect(resolveClaimKey(join(wt, '.claude', 'cache'))).toBeNull();
  });

  it('folds case on win32 and darwin only', () => {
    const upper = join(wt, '.CLAUDE', 'Cache', 'y.md');
    expect(resolveClaimKey(upper, { platform: 'win32' })).toBeNull();
    expect(resolveClaimKey(upper, { platform: 'linux' })).not.toBeNull();
  });

  it('resolves ".." before the test: a tracked file reached through the cache folder is a tracked key', () => {
    const sneaky = join(wt, '.claude', 'cache', '..', '..', 'src', 'x.ts');
    expect(resolveClaimKey(sneaky)?.filePath).toBe('src/x.ts');
    expect(resolveClaimKey(sneaky)).toEqual(resolveClaimKey(join(primary, 'src', 'x.ts')));
  });

  it('a Windows separator inside the cache path is still the cache folder', () => {
    expect(resolveClaimKey(`${wt}\\.claude\\cache\\pre-pr\\summary.md`, { platform: 'win32' })).toBeNull();
  });
});

describe('file-claims hook: the key handed to resolveFileClaim', () => {
  it('a cache file in two worktrees gets two different keys; a tracked file gets one', async () => {
    await runHook(primary, join(primary, CACHE));
    await runHook(wt, join(wt, CACHE));
    expect(seen.calls).toHaveLength(2);
    expect(seen.calls[0].filePath).not.toBe(seen.calls[1].filePath);

    seen.calls = [];
    await runHook(primary, join(primary, 'src', 'x.ts'));
    await runHook(wt, join(wt, 'src', 'x.ts'));
    expect(seen.calls[0]).toEqual(seen.calls[1]);
    expect(seen.calls[0].filePath).toBe('src/x.ts');
  });

  it('the same cache file edited from the same worktree twice keeps one key (two sessions still meet)', async () => {
    await runHook(wt, join(wt, CACHE));
    await runHook(wt, join(wt, CACHE));
    expect(seen.calls[0]).toEqual(seen.calls[1]);
  });
});
