/**
 * claim-target: file-system errors and network paths (seat round on PR 536, R2 and R3).
 *
 * Ways it can fail (one test each):
 *  1. An lstat error other than "not found" on a .git entry (EACCES, EIO) reads as "no .git here",
 *     and the walk goes on to an OUTER repo: a key from the wrong repo, not the old key.
 *  2. "Not found" and "not a directory" must still mean "no .git here" (control).
 *  3. A raw path on a network share (leading \\ or //) makes sync file-system calls with no time
 *     limit, in every session. It must keep the old key and read nothing.
 *
 * The real fs is wrapped, not replaced: temp repos are real. A counter shows which calls happen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const probe = vi.hoisted(() => ({ calls: 0, code: '' as string, match: '' as string }));

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const count =
    <A extends unknown[], R>(fn: (...a: A) => R) =>
    (...a: A): R => {
      probe.calls++;
      return fn(...a);
    };
  const realpathSync = Object.assign(count(real.realpathSync), { native: count(real.realpathSync.native) });
  return {
    ...real,
    existsSync: count(real.existsSync),
    readFileSync: count(real.readFileSync),
    realpathSync,
    lstatSync: ((p: unknown, ...rest: unknown[]) => {
      probe.calls++;
      if (probe.code && String(p).replace(/\\/g, '/').includes(probe.match)) {
        throw Object.assign(new Error(`${probe.code}: injected`), { code: probe.code });
      }
      return (real.lstatSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.lstatSync,
  };
});

import { resolveClaimKey } from '../shared/claim-target.js';

let root: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd, stdio: 'ignore' });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claim-fs-')));
  probe.calls = 0;
  probe.code = '';
  probe.match = '';
});
afterEach(() => {
  probe.code = '';
  rmSync(root, { recursive: true, force: true });
});

function outerWithInnerFolder(): { file: string } {
  const outer = join(root, 'outer');
  mkdirSync(join(outer, 'inner'), { recursive: true });
  git(outer, 'init', '-q');
  writeFileSync(join(outer, 'inner', 'x.ts'), 'x');
  return { file: join(outer, 'inner', 'x.ts') };
}

describe('claim-target fs errors and network paths', () => {
  it('1. R2: an lstat error other than not-found on a .git entry stops the walk (old key)', () => {
    const { file } = outerWithInnerFolder();
    for (const code of ['EACCES', 'EIO', 'EPERM']) {
      probe.code = code;
      probe.match = 'inner/.git';
      expect(resolveClaimKey(file), code).toBeNull();
    }
  });

  it('2. R2 control: ENOENT and ENOTDIR on a .git entry still mean "no .git here"', () => {
    const { file } = outerWithInnerFolder();
    for (const code of ['ENOENT', 'ENOTDIR']) {
      probe.code = code;
      probe.match = 'inner/.git';
      expect(resolveClaimKey(file)?.filePath, code).toBe('inner/x.ts'); // the outer repo
    }
  });

  it('3. R3: a raw path on a network share keeps the old key and reads nothing', () => {
    probe.calls = 0;
    expect(resolveClaimKey('\\\\srv\\share\\a\\x.ts')).toBeNull();
    expect(resolveClaimKey('//srv/share/a/x.ts')).toBeNull();
    expect(probe.calls).toBe(0);
  });
});
