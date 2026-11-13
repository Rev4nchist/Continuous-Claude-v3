/**
 * claim-target: the file-claims key is (repo-relative path, common dir of the FILE's own repo).
 *
 * Ways it can fail (one test each):
 *  1. A worktree and the primary checkout give two keys for one repo path (the card's bug).
 *  2. The same relative path in two different repos collides.
 *  3. A ".." segment gives a second spelling of one file.
 *  4. A new file in a folder that does not exist yet gets no key (or throws).
 *  5. A file outside any repo gets a key (it must keep today's raw key: null here).
 *  6. A moved worktree folder changes the key.
 *  7. A file reached through a link crashes the resolver, or gets a key from the link's side.
 *  8. Case folds on Linux, or does not fold on win32 and darwin (seat change C2).
 *  9. A broken .git file throws instead of falling back.
 * 10. The project string differs from the one `canonicalProject` (git) gives: 8.3 short names.
 *
 * Real temp repos and real `git worktree add`: the expected project value comes from the real
 * `canonicalProject`, not from a copy of the logic. Hooks CI runs on Linux: paths use "/".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveClaimKey } from '../shared/claim-target.js';
import { canonicalProject } from '../shared/session-id.js';

let root: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

function makeRepo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'x.ts'), 'x');
  return dir;
}

function addWorktree(repo: string, name: string): string {
  const wt = join(root, name);
  git(repo, 'worktree', 'add', '-q', wt, '-b', name);
  return wt;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claim-key-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveClaimKey', () => {
  it('1. gives one key for the primary checkout and a worktree', () => {
    const a = makeRepo('a');
    const wt = addWorktree(a, 'a-wt');
    const fromPrimary = resolveClaimKey(join(a, 'src', 'x.ts'));
    const fromWorktree = resolveClaimKey(join(wt, 'src', 'x.ts'));
    expect(fromPrimary).not.toBeNull();
    expect(fromWorktree).toEqual(fromPrimary);
    expect(fromWorktree?.filePath).toBe('src/x.ts');
  });

  it('10. project equals what canonicalProject (git) gives for the repo', () => {
    const a = makeRepo('a');
    const wt = addWorktree(a, 'a-wt');
    expect(resolveClaimKey(join(wt, 'src', 'x.ts'))?.project).toBe(canonicalProject(a));
    expect(resolveClaimKey(join(wt, 'src', 'x.ts'))?.project).toBe(canonicalProject(wt));
  });

  it('2. keeps the same relative path in two different repos apart', () => {
    const a = makeRepo('a');
    const b = makeRepo('b');
    const ka = resolveClaimKey(join(a, 'src', 'x.ts'));
    const kb = resolveClaimKey(join(b, 'src', 'x.ts'));
    expect(ka?.filePath).toBe(kb?.filePath);
    expect(ka?.project).not.toBe(kb?.project);
  });

  it('3. folds ".." segments into one spelling', () => {
    const a = makeRepo('a');
    const wt = addWorktree(a, 'a-wt');
    const plain = resolveClaimKey(join(a, 'src', 'x.ts'));
    const dotted = resolveClaimKey(join(wt, 'src', '..', 'src', '..', 'src', 'x.ts'));
    expect(dotted).toEqual(plain);
  });

  it('4. keys a new file in folders that do not exist yet', () => {
    const a = makeRepo('a');
    const key = resolveClaimKey(join(a, 'new', 'deep', 'y.ts'));
    expect(key?.filePath).toBe('new/deep/y.ts');
    expect(key?.project).toBe(canonicalProject(a));
  });

  it('5. returns null for a file outside any repo', () => {
    const loose = join(root, 'loose');
    mkdirSync(loose);
    writeFileSync(join(loose, 'z.ts'), 'z');
    expect(resolveClaimKey(join(loose, 'z.ts'))).toBeNull();
    expect(resolveClaimKey(join(loose, 'nope', 'z.ts'))).toBeNull();
  });

  it('6. keeps the key when the worktree folder moves', () => {
    const a = makeRepo('a');
    const wt = addWorktree(a, 'a-wt');
    const before = resolveClaimKey(join(wt, 'src', 'x.ts'));
    const moved = join(root, 'a-wt-moved');
    git(a, 'worktree', 'move', wt, moved);
    const after = resolveClaimKey(join(moved, 'src', 'x.ts'));
    expect(after).toEqual(before);
  });

  it('7. follows a link to the real file and does not throw', () => {
    const a = makeRepo('a');
    const b = makeRepo('b');
    const link = join(a, 'linked');
    symlinkSync(join(b, 'src'), link, process.platform === 'win32' ? 'junction' : 'dir');
    let key: ReturnType<typeof resolveClaimKey> = null;
    expect(() => {
      key = resolveClaimKey(join(link, 'x.ts'));
    }).not.toThrow();
    // The key follows the real file: repo B, not repo A.
    expect(key).toEqual(resolveClaimKey(join(b, 'src', 'x.ts')));
  });

  it('8. folds case only where the file system ignores case', () => {
    const a = makeRepo('a');
    mkdirSync(join(a, 'MixedDir'), { recursive: true });
    const file = join(a, 'MixedDir', 'File.ts');
    expect(resolveClaimKey(file, { platform: 'win32' })?.filePath).toBe('mixeddir/file.ts');
    expect(resolveClaimKey(file, { platform: 'darwin' })?.filePath).toBe('mixeddir/file.ts');
    expect(resolveClaimKey(file, { platform: 'linux' })?.filePath).toBe('MixedDir/File.ts');
  });

  it.skipIf(process.platform !== 'win32')('10b. an 8.3 short path gives the same key as the long path', () => {
    const a = makeRepo('a-long-repo-name');
    let short = a;
    try {
      short = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${a}').ShortPath`],
        { encoding: 'utf8' },
      ).trim();
    } catch {
      return; // no short names on this machine: nothing to pin
    }
    if (!short || short.toLowerCase() === a.toLowerCase()) return; // 8.3 names are off
    const viaShort = resolveClaimKey(join(short, 'src', 'x.ts'));
    expect(viaShort).toEqual(resolveClaimKey(join(a, 'src', 'x.ts')));
    expect(viaShort?.project).toBe(canonicalProject(a));
  });

  it('9. returns null for a broken .git file and does not throw', () => {
    const odd = join(root, 'odd');
    mkdirSync(odd);
    writeFileSync(join(odd, '.git'), 'this is not a gitdir line');
    writeFileSync(join(odd, 'f.ts'), 'f');
    expect(() => resolveClaimKey(join(odd, 'f.ts'))).not.toThrow();
    expect(resolveClaimKey(join(odd, 'f.ts'))).toBeNull();
  });
});
