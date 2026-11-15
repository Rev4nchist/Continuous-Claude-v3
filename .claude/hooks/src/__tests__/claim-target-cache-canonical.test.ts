/**
 * Card coord-file-claims-cache-key-canonical: one claim key for one `.claude/cache` file in one worktree, whatever the
 * spelling of its path (slash, case, relative, "..", a link).
 *
 * Before: resolveClaimKey returned null for such a file and the hook kept the RAW file_path as the key, so
 * `C:\wt\.claude\cache\a.md`, `C:/wt/.claude/cache/a.md` and `.claude/cache/a.md` (with a cwd) were three keys: a second
 * session meets no claim. After: the key is the real absolute path (forward slashes, case folded where the file system
 * ignores case) plus the file's own repo project. It stays per worktree: two worktrees give two keys.
 *
 * Ways it can fail (one test each):
 *  1. Two spellings of one cache file give two keys (slash, case, "..", relative to cwd, a link to the folder).
 *  2. Two worktrees give ONE key for a cache file (a false conflict: the worktree-local card comes back).
 *  3. The key is not an absolute path with forward slashes, so the shell guard and the release hint do not read it
 *     as a stored absolute path.
 *  4. A tracked file (or a sibling folder such as `.claude/cachex`) changes its key.
 *  5. Case is folded on Linux, or not folded on win32 and darwin.
 *  6. The hook hands resolveFileClaim a different pair for each spelling (the card's bug, proved on the real hook).
 *  7. A deny for a cache file shows the holder's absolute path, or a base name as the release path.
 *  8. A holder cannot release its cache claim by naming it with another spelling.
 *  9. A claim stored under the old raw key (a session that started before this change) can no longer be released.
 * 10. A file outside any repo gets a key (it must keep today's raw key).
 *
 * Real temp repos and a real `git worktree add`. The hook tests mock the database call and fd 0 (pattern of
 * file-claims-cache-key.test.ts). Hooks CI runs on Linux: paths use "/", and a backslash case runs on win32 only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveClaimKey } from '../shared/claim-target.js';
import { canonicalProject } from '../shared/session-id.js';
import { matchOwnRows } from '../shared/claim-release.js';

const seen = vi.hoisted(() => ({
  calls: [] as Array<{ filePath: string; project: string }>,
  payload: '',
  outcome: 'granted' as 'granted' | 'blocked',
}));

vi.mock('../shared/db-utils-pg.js', () => ({
  resolveFileClaim: async (filePath: string, project: string) => {
    seen.calls.push({ filePath, project });
    return seen.outcome === 'blocked'
      ? { outcome: 'blocked', holder: 'aaaaaaaa-1111-2222-3333-444444444444', leaseClass: 'file', leaseExpired: false, holderExpiresAt: null }
      : { outcome: 'granted' };
  },
}));
vi.mock('../shared/holder-lane.js', () => ({ holderHoldsOpenLane: async () => null }));
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
let wt2: string;
let savedLog: string | undefined;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd, stdio: 'ignore' });
}

async function runHook(cwd: string, filePath: string): Promise<string> {
  seen.payload = JSON.stringify({ tool_name: 'Write', session_id: 's1', cwd, tool_input: { file_path: filePath } });
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.resetModules();
  await import('../file-claims.js');
  await vi.waitFor(() => expect(out).toHaveBeenCalled());
  const text = String(out.mock.calls[out.mock.calls.length - 1]?.[0] ?? '');
  out.mockRestore();
  return text;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fc-cache-canon-')));
  primary = join(root, 'primary');
  mkdirSync(join(primary, 'src'), { recursive: true });
  git(primary, 'init', '-q');
  writeFileSync(join(primary, 'src', 'x.ts'), 'x');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-q', '-m', 'init');
  mkdirSync(join(primary, '.claude', 'worktrees'), { recursive: true });
  wt = join(primary, '.claude', 'worktrees', 'g1');
  wt2 = join(primary, '.claude', 'worktrees', 'g2');
  git(primary, 'worktree', 'add', '-q', wt, '-b', 'b1');
  git(primary, 'worktree', 'add', '-q', wt2, '-b', 'b2');
  seen.calls = [];
  seen.outcome = 'granted';
  savedLog = process.env.CCV3_GUARD_DECISIONS_LOG;
  process.env.CCV3_GUARD_DECISIONS_LOG = join(root, 'guard.jsonl');
});
afterEach(() => {
  if (savedLog === undefined) delete process.env.CCV3_GUARD_DECISIONS_LOG;
  else process.env.CCV3_GUARD_DECISIONS_LOG = savedLog;
  rmSync(root, { recursive: true, force: true });
});

const CACHE = join('.claude', 'cache', 'pre-pr', 'summary.md');
const slashed = (p: string): string => p.replace(/\\/g, '/');

describe('one cache file, one key', () => {
  it('1a. a ".." segment and a relative path against the cwd give the key of the plain path', () => {
    const plain = resolveClaimKey(join(wt, CACHE));
    expect(plain).not.toBeNull();
    expect(resolveClaimKey(join(wt, '.claude', 'cache', 'pre-pr', '..', 'pre-pr', 'summary.md'))).toEqual(plain);
    expect(resolveClaimKey(CACHE, { cwd: wt })).toEqual(plain);
    expect(resolveClaimKey(join('.claude', 'cache', 'x', '..', 'pre-pr', 'summary.md'), { cwd: wt })).toEqual(plain);
  });

  it('1b. case spellings give one key where the file system ignores case', () => {
    const lower = resolveClaimKey(join(wt, CACHE), { platform: 'win32' });
    const mixed = resolveClaimKey(join(wt, '.CLAUDE', 'Cache', 'Pre-PR', 'SUMMARY.md'), { platform: 'win32' });
    expect(lower).not.toBeNull();
    expect(mixed).toEqual(lower);
    expect(resolveClaimKey(join(wt, '.Claude', 'CACHE', 'pre-pr', 'Summary.md'), { platform: 'darwin' })).toEqual(
      resolveClaimKey(join(wt, CACHE), { platform: 'darwin' }),
    );
  });

  it.skipIf(process.platform !== 'win32')('1c. a Windows separator gives the key of the slash spelling', () => {
    const back = `${wt}\\.claude\\cache\\pre-pr\\summary.md`;
    expect(resolveClaimKey(back, { platform: 'win32' })).toEqual(resolveClaimKey(slashed(back), { platform: 'win32' }));
  });

  it('1d. a path through a link to the cache folder gives the key of the real file', () => {
    mkdirSync(join(wt, '.claude', 'cache', 'pre-pr'), { recursive: true });
    writeFileSync(join(wt, CACHE), 's');
    const link = join(root, 'cache-link');
    symlinkSync(join(wt, '.claude', 'cache'), link, process.platform === 'win32' ? 'junction' : 'dir');
    const viaLink = resolveClaimKey(join(link, 'pre-pr', 'summary.md'));
    expect(viaLink).not.toBeNull();
    expect(viaLink).toEqual(resolveClaimKey(join(wt, CACHE)));
  });

  it('2. a cache file in two worktrees and in the primary gives three keys of one project', () => {
    const a = resolveClaimKey(join(primary, CACHE));
    const b = resolveClaimKey(join(wt, CACHE));
    const c = resolveClaimKey(join(wt2, CACHE));
    expect(new Set([a?.filePath, b?.filePath, c?.filePath]).size).toBe(3);
    expect(new Set([a?.project, b?.project, c?.project]).size).toBe(1);
    expect(b?.project).toBe(canonicalProject(wt));
  });

  it('3. the key is an absolute path with forward slashes only', () => {
    const k = resolveClaimKey(join(wt, CACHE), { platform: 'linux' });
    expect(k?.filePath).toBe(slashed(join(wt, CACHE)));
    expect(k?.filePath).not.toContain('\\');
    expect(/^(?:[a-zA-Z]:\/|\/)/.test(k?.filePath ?? '')).toBe(true);
  });

  it('5. Linux keeps the case of the path; win32 and darwin fold it', () => {
    const upper = join(wt, '.claude', 'cache', 'Pre-PR', 'Summary.md');
    expect(resolveClaimKey(upper, { platform: 'linux' })?.filePath).toBe(slashed(upper));
    expect(resolveClaimKey(upper, { platform: 'win32' })?.filePath).toBe(slashed(upper).toLowerCase());
    expect(resolveClaimKey(upper, { platform: 'darwin' })?.filePath).toBe(slashed(upper).toLowerCase());
  });

  it('4. a tracked file, a sibling folder and a file outside any repo keep their keys', () => {
    expect(resolveClaimKey(join(wt, 'src', 'x.ts'))?.filePath).toBe('src/x.ts');
    expect(resolveClaimKey(join(wt, '.claude', 'cachex', 'y.md'))?.filePath).toBe('.claude/cachex/y.md');
    expect(resolveClaimKey(join(wt, 'cache', 'y.md'))?.filePath).toBe('cache/y.md');
    const loose = join(root, 'loose', '.claude', 'cache');
    mkdirSync(loose, { recursive: true });
    expect(resolveClaimKey(join(loose, 'z.md'))).toBeNull(); // 10. outside any repo: today's raw key
  });
});

describe('file-claims hook: the pair handed to resolveFileClaim', () => {
  it('6. three spellings of one cache file in one worktree are one pair; two worktrees are two', async () => {
    await runHook(wt, join(wt, CACHE));
    await runHook(wt, join(wt, '.claude', 'cache', 'x', '..', 'pre-pr', 'summary.md'));
    await runHook(wt, CACHE);
    expect(seen.calls).toHaveLength(3);
    expect(seen.calls[1]).toEqual(seen.calls[0]);
    expect(seen.calls[2]).toEqual(seen.calls[0]);
    await runHook(wt2, join(wt2, CACHE));
    expect(seen.calls[3]).not.toEqual(seen.calls[0]);
    expect(seen.calls[3].project).toBe(seen.calls[0].project);
  });

  it('7. a deny for a cache file shows the base name and gives the --list release form, never the holder folder', async () => {
    seen.outcome = 'blocked';
    const text = await runHook(wt, join(wt, CACHE));
    const reason = String(JSON.parse(text).hookSpecificOutput?.permissionDecisionReason ?? '');
    expect(reason).toContain('FILE CONFLICT BLOCKED');
    expect(reason).toContain('"summary.md"');
    expect(reason).not.toContain(slashed(wt));
    expect(reason).not.toContain(slashed(wt).toLowerCase());
    expect(reason).toContain('release-claim.mjs --list');
  });
});

describe('release', () => {
  const row = (filePath: string, project: string) => ({ file_path: filePath, project });

  it('8. a holder frees its cache claim by naming it with another spelling', () => {
    const key = resolveClaimKey(join(wt, CACHE));
    expect(key).not.toBeNull();
    const own = [row(key!.filePath, key!.project)];
    for (const typed of [join(wt, CACHE), join(wt, '.claude', 'cache', 'x', '..', 'pre-pr', 'summary.md'), CACHE]) {
      const m = matchOwnRows(typed, wt, own);
      expect(m.kind).toBe('delete');
      if (m.kind === 'delete') expect(m.tier).toBe('exact');
    }
  });

  it('9. a claim stored under the old raw key is still freed (a session that started before this change)', () => {
    const old = row(join(wt, CACHE), canonicalProject(wt));
    const m = matchOwnRows(join(wt, CACHE), wt, [old]);
    expect(m.kind).toBe('delete');
  });
});
