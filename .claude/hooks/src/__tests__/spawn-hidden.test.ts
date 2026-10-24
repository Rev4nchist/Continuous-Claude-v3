/**
 * spawnDetachedHidden: fire-and-forget spawn that does not open console windows.
 *
 * Ways it can fail, one test each:
 *  1. On Windows it spawns the command directly (the popup comes back).
 *  2. It drops caller options, or does not force detached + windowsHide.
 *  3. On other platforms it changes behaviour (adds the relay).
 *  4. The relay mangles args (spaces, quotes, leading dashes) or ignores cwd.
 *  5. The relay loses the command's exit code.
 *  6. A command that cannot start fails silently (no reason recorded).
 * Tests 4-6 force the win32 path with the real spawn, so they run the relay on
 * every platform. The window itself is checked end to end by the console probe
 * (.claude/cache/e2e/2026-10-24-spawn-hidden.txt); a unit test cannot see it.
 */
import { describe, it, expect, vi } from 'vitest';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnDetachedHidden, RELAY_SCRIPT, RELAY_LAUNCH_FAILED } from '../lib/spawn-hidden.js';

const fakeChild = (_cmd: string, _args: string[], _opts: SpawnOptions) => ({ unref: vi.fn(), on: vi.fn() }) as never;

/** Run through the relay (win32 path) with the real spawn, on any platform. */
function viaRelay(cmd: string, args: string[], options: SpawnOptions): ChildProcess {
  return spawnDetachedHidden(cmd, args, options, spawn, 'win32');
}
const exitCode = (child: ChildProcess) => new Promise<number | null>((r) => child.on('exit', r));

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
    const child = viaRelay(process.execPath, ['-e', writer, out, ...tricky], { cwd: dir, stdio: 'ignore' });
    expect(await exitCode(child)).toBe(0);
    expect(existsSync(out)).toBe(true);
    const got = JSON.parse(readFileSync(out, 'utf8'));
    expect(got.argv).toEqual(tricky);
    expect(got.cwd.toLowerCase()).toBe(dir.toLowerCase());
  });

  it('relay exits with the command exit code (real processes)', async () => {
    const child = viaRelay(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
    expect(await exitCode(child)).toBe(7);
  });

  it('relay records why a command cannot start and exits 127 (real processes)', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'spawn-hidden-')), 'errors.log');
    const missing = 'ccv3-no-such-command-xyz';
    const child = viaRelay(missing, ['--x'], { stdio: 'ignore', env: { ...process.env, CCV3_SPAWN_HIDDEN_LOG: log } });
    expect(await exitCode(child)).toBe(RELAY_LAUNCH_FAILED);
    expect(readFileSync(log, 'utf8')).toMatch(new RegExp(`cannot start ${missing}: ENOENT`));
  });
});
