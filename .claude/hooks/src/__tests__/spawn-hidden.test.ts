/**
 * spawnDetachedHidden: fire-and-forget spawn that does not open console windows.
 *
 * Ways it can fail, one test each:
 *  1. On Windows it spawns the command directly (the popup comes back).
 *  2. It drops caller options, or does not force detached + windowsHide.
 *  3. On other platforms it changes behaviour (adds the relay).
 *  4. The relay mangles args (spaces, quotes, leading dashes) or ignores cwd.
 *  5. The relay loses the command's exit code.
 * The window itself is checked end to end by the console probe
 * (.claude/cache/e2e/2026-10-24-spawn-hidden.txt); a unit test cannot see it.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnDetachedHidden, RELAY_SCRIPT } from '../lib/spawn-hidden.js';

const fakeChild = () => ({ unref: vi.fn(), on: vi.fn() }) as never;

describe('spawnDetachedHidden', () => {
  it('on win32 runs the command through the node relay', () => {
    const spawnFn = vi.fn(fakeChild);
    spawnDetachedHidden('uv', ['run', 'python', 'x.py'], {}, spawnFn, 'win32');
    expect(spawnFn).toHaveBeenCalledWith(
      process.execPath,
      ['-e', RELAY_SCRIPT, '--', 'uv', 'run', 'python', 'x.py'],
      expect.anything(),
    );
  });

  it('keeps caller options and forces detached + windowsHide', () => {
    const spawnFn = vi.fn(fakeChild);
    const env = { A: '1' };
    spawnDetachedHidden('uv', [], { cwd: 'C:/w', env, stdio: 'ignore', detached: false, windowsHide: false }, spawnFn, 'win32');
    expect(spawnFn.mock.calls[0][2]).toEqual({ cwd: 'C:/w', env, stdio: 'ignore', detached: true, windowsHide: true });
  });

  it('on other platforms spawns the command directly, detached', () => {
    const spawnFn = vi.fn(fakeChild);
    spawnDetachedHidden('uv', ['run'], { cwd: '/w' }, spawnFn, 'linux');
    expect(spawnFn).toHaveBeenCalledWith('uv', ['run'], { cwd: '/w', detached: true, windowsHide: true });
  });

  it('relay passes args verbatim and honours cwd (real processes)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-hidden-'));
    const out = join(dir, 'argv.json');
    const writer = `require('fs').writeFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))`;
    const tricky = ['a b', 'q"uote', '--flag', 'back\\slash\\', ''];
    const child = spawnDetachedHidden(process.execPath, ['-e', writer, out, ...tricky], { cwd: dir, stdio: 'ignore' });
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    const got = JSON.parse(readFileSync(out, 'utf8'));
    expect(got.argv).toEqual(tricky);
    expect(got.cwd.toLowerCase()).toBe(dir.toLowerCase());
  });

  it('relay exits with the command exit code (real processes)', async () => {
    const child = spawnDetachedHidden(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    expect(code).toBe(7);
  });
});
