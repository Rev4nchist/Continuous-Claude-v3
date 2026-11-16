/**
 * The hooks vitest run keeps all test temp folders in ONE run-owned folder (vitest-global-temp.ts) and removes it at the end.
 * Failures this file catches:
 *  1. the env set in globalSetup does not reach a test worker (a silent no-op);
 *  2. the teardown follows a junction or symlink and deletes files outside the run folder;
 *  3. the teardown removes a folder it did not make (a prefix or age rule, or a path outside the real temp dir);
 *  4. a teardown is removed or never runs, so the run folder stays;
 *  5. two runs at the same time share a folder, or one teardown removes the other run's folder.
 * Paths use join(), so the file passes on Windows and on Linux (TMPDIR is the variable that counts there).
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { makeRunRoot, removeRunRoot, removeTree, RUN_PREFIX } from './vitest-global-temp.js';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_CONFIG = join(HOOKS_DIR, 'src', '__tests__', 'fixtures', 'vitest-run-temp', 'vitest.config.ts');

/** Folders this file made outside the run folder. Only these are removed here, never a prefix match. */
const outside: string[] = [];
afterAll(async () => {
  await stopChildren(); // a child still running could write into a folder removed below
  for (const dir of outside.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* leave it: a leak is better than a failed test */
    }
  }
});

/** A folder next to the run folder (in the real temp dir) that the teardown must never touch. */
function realTempDir(label: string): string {
  const real = process.env.CCV3_REAL_TEMP;
  if (!real) throw new Error('CCV3_REAL_TEMP is not set: globalSetup did not run');
  const dir = mkdtempSync(join(real, `ccv3-vt-test-${label}-`));
  outside.push(dir);
  return dir;
}

describe('run folder reaches a worker (condition 2)', () => {
  it('tmpdir() and TEMP, TMP, TMPDIR name the run folder inside a real test file', () => {
    const root = process.env.CCV3_RUN_TEMP;
    expect(root).toBeTruthy();
    expect(realpathSync(tmpdir())).toBe(realpathSync(root as string));
    for (const key of ['TEMP', 'TMP', 'TMPDIR']) expect(process.env[key]).toBe(root);
    expect(basename(root as string).startsWith(RUN_PREFIX)).toBe(true);
    expect(process.env.CCV3_REAL_TEMP).toBeTruthy();
    expect(process.env.CCV3_REAL_TEMP).not.toBe(root);
  });

  it('a mkdtemp under tmpdir() lands inside the run folder', () => {
    const made = mkdtempSync(join(tmpdir(), 'inside-'));
    expect(dirname(realpathSync(made))).toBe(realpathSync(process.env.CCV3_RUN_TEMP as string));
  });
});

describe('teardown never deletes through a link (condition 1)', () => {
  it('a junction or symlink that points outside the run folder is unlinked and its target keeps every file', () => {
    const target = realTempDir('target');
    writeFileSync(join(target, 'keep.txt'), 'keep');
    mkdirSync(join(target, 'sub'));
    writeFileSync(join(target, 'sub', 'deep.txt'), 'deep');
    const run = makeRunRoot(realTempDir('base'));
    symlinkSync(target, join(run, 'link-top'), 'junction');
    mkdirSync(join(run, 'nested'));
    symlinkSync(target, join(run, 'nested', 'link-nested'), 'junction');
    writeFileSync(join(run, 'nested', 'own.txt'), 'own');

    removeTree(run);

    expect(existsSync(run)).toBe(false);
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep');
    expect(readFileSync(join(target, 'sub', 'deep.txt'), 'utf8')).toBe('deep');
    expect(readdirSync(target).sort()).toEqual(['keep.txt', 'sub']);
  });
});

describe('teardown fails closed when a folder cannot be read', () => {
  /** A read that throws `code` for the folder named `locked` and reads every other folder for real. */
  const readFailing = (code: string) => ({
    readdir: (dir: string) => {
      if (basename(dir) === 'locked') throw Object.assign(new Error(code), { code });
      return readdirSync(dir, { withFileTypes: true });
    },
  });

  it('an unreadable folder (EACCES) may hold a link, so nothing is removed and the run folder stays', () => {
    const run = makeRunRoot(realTempDir('unreadable'));
    mkdirSync(join(run, 'locked'));
    writeFileSync(join(run, 'locked', 'f.txt'), 'x');
    writeFileSync(join(run, 'own.txt'), 'own');
    expect(removeTree(run, readFailing('EACCES'))).toBe(false);
    expect(existsSync(join(run, 'locked', 'f.txt'))).toBe(true);
    expect(existsSync(join(run, 'own.txt'))).toBe(true);
    expect(existsSync(join(run, 'owner.json'))).toBe(true);
  });

  it('a folder that is already gone (ENOENT) is fine and the remove goes on', () => {
    const run = makeRunRoot(realTempDir('gone'));
    mkdirSync(join(run, 'locked'));
    expect(removeTree(run, readFailing('ENOENT'))).toBe(true);
    expect(existsSync(run)).toBe(false);
  });
});

describe('teardown removes only its own recorded folder', () => {
  it('removeRunRoot refuses a folder that is not a run folder of this base', () => {
    const base = realTempDir('refuse');
    const foreign = join(base, 'not-a-run-folder');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'f.txt'), 'x');
    expect(removeRunRoot(foreign, base)).toBe(false);
    expect(existsSync(join(foreign, 'f.txt'))).toBe(true);
    // A run-looking name in another base is refused too.
    const other = makeRunRoot(realTempDir('other'));
    expect(removeRunRoot(other, base)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('removeRunRoot refuses a link that has a run-folder name', () => {
    const base = realTempDir('linkname');
    const target = realTempDir('linktarget');
    writeFileSync(join(target, 'keep.txt'), 'keep');
    const link = join(base, `${RUN_PREFIX}${process.pid}-LINK00`);
    symlinkSync(target, link, 'junction');
    expect(removeRunRoot(link, base)).toBe(false);
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('two run folders from one base are two folders, and removing one leaves the other whole', () => {
    const base = realTempDir('two');
    const a = makeRunRoot(base);
    const b = makeRunRoot(base);
    expect(a).not.toBe(b);
    for (const dir of [a, b]) {
      const owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8'));
      expect(owner.pid).toBe(process.pid);
      expect(typeof owner.startedAt).toBe('string');
      writeFileSync(join(dir, 'own.txt'), basename(dir));
    }
    expect(removeRunRoot(a, base)).toBe(true);
    expect(existsSync(a)).toBe(false);
    expect(readFileSync(join(b, 'own.txt'), 'utf8')).toBe(basename(b));
    expect(existsSync(join(b, 'owner.json'))).toBe(true);
  });
});

/** Run vitest on the fixture config in a child process with TEMP, TMP and TMPDIR set to `scratch`. */
interface Fixture {
  done: Promise<number | null>;
  /** The last 20,000 characters the child wrote to stdout and stderr: put it in an assertion message. */
  output: () => string;
}

/** Every child this file started and that has not ended yet. stopChildren stops only these, by their own pid. */
const children = new Set<ChildProcess>();

function runFixture(scratch: string, waitMs: number, extraEnv: Record<string, string> = {}): Fixture {
  const vitestBin = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
  const env: Record<string, string | undefined> = { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch, FX_WAIT_MS: String(waitMs), ...extraEnv };
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key];
  const child = spawn(process.execPath, [vitestBin, 'run', '--config', FIXTURE_CONFIG], { cwd: HOOKS_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  let out = '';
  const keep = (chunk: Buffer): void => {
    out = (out + chunk.toString()).slice(-20_000);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const done = new Promise<number | null>((resolve) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      children.delete(child);
      resolve(code);
    };
    child.on('close', finish);
    // A grandchild can keep the pipes open, so 'close' may never come: one second after 'exit' is enough to drain them.
    child.on('exit', (code) => setTimeout(() => finish(code), 1000));
  });
  return { done, output: () => out };
}

/** Stop every child this file started and has not seen end, then wait up to 10 s for each to exit. */
async function stopChildren(): Promise<void> {
  const running = [...children].filter((child) => child.exitCode === null && child.signalCode === null);
  for (const child of running) child.kill();
  await Promise.all(
    running.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          const timer = setTimeout(resolve, 10_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        }),
    ),
  );
}

const runFolders = (scratch: string): string[] => readdirSync(scratch).filter((n) => n.startsWith(RUN_PREFIX));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

describe('real vitest runs on the fixture (conditions 3 and 4)', () => {
  it('one run leaves no run folder behind after it ends', async () => {
    const scratch = realTempDir('one');
    const run = runFixture(scratch, 0);
    expect(await run.done, run.output()).toBe(0);
    expect(runFolders(scratch)).toEqual([]);
  }, 120_000);

  it('two runs at once get two folders, and the end of one leaves the other whole', async () => {
    const scratch = realTempDir('both');
    const quickRelease = join(scratch, 'release-quick');
    const slowRelease = join(scratch, 'release-slow');
    // Each run waits for its own release file, so no fixed sleep decides who ends first. The slow run also boots late on purpose.
    const quick = runFixture(scratch, 0, { FX_RELEASE_FILE: quickRelease });
    const slow = runFixture(scratch, 0, { FX_RELEASE_FILE: slowRelease, FX_START_DELAY_MS: '4000' });
    const hasFixtureFolder = (n: string): boolean => readdirSync(join(scratch, n)).some((e) => e.startsWith('fx-'));
    const two = await waitFor(() => runFolders(scratch).length === 2 && runFolders(scratch).every(hasFixtureFolder), 90_000);
    expect(two, `${quick.output()}\n${slow.output()}`).toBe(true);
    expect(new Set(runFolders(scratch)).size).toBe(2);
    writeFileSync(quickRelease, '');
    expect(await quick.done, quick.output()).toBe(0);
    // The quick run is over. The slow run is still going, so exactly its folder remains, with its files.
    const left = runFolders(scratch);
    expect(left).toHaveLength(1);
    const owner = JSON.parse(readFileSync(join(scratch, left[0], 'owner.json'), 'utf8'));
    expect(typeof owner.pid).toBe('number');
    expect(hasFixtureFolder(left[0])).toBe(true);
    writeFileSync(slowRelease, '');
    expect(await slow.done, slow.output()).toBe(0);
    expect(runFolders(scratch)).toEqual([]);
  }, 180_000);

  it('a failing fixture run puts its own output in the failure message', async () => {
    const scratch = realTempDir('fail');
    const run = runFixture(scratch, 0, { FX_FAIL: '1' });
    expect(await run.done).not.toBe(0);
    expect(run.output()).toContain('FX deliberate failure');
  }, 120_000);

  it('stopChildren stops a run that is still going, and the run leaves no folder behind it', async () => {
    const scratch = realTempDir('stop');
    const run = runFixture(scratch, 0, { FX_RELEASE_FILE: join(scratch, 'never-created') });
    expect(await waitFor(() => runFolders(scratch).some((n) => readdirSync(join(scratch, n)).some((e) => e.startsWith('fx-'))), 60_000)).toBe(true);
    await stopChildren();
    const result = await Promise.race([run.done, sleep(15_000).then(() => 'still running')]);
    expect(result).not.toBe('still running');
  }, 120_000);
});
