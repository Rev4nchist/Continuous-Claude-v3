/**
 * SessionStart Init-Check Hook tests.
 *
 * Phase 3 of cross-project isolation remediation:
 *   1. Path containing `.claude` (but not continuous-claude) -> stderr warning
 *   2. Tempdir with bare `main.py` (no manifest) -> hasCodeFiles() returns true
 *      so tree generation is at least attempted (we can't easily verify the
 *      generation result without a working PYTHONPATH; we assert the warning
 *      "Generating knowledge tree" is emitted).
 *
 * Spawns the built hook as a subprocess to mirror real runtime conditions.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const HOOK_PATH = resolve(__dirname, '..', '..', 'dist', 'session-start-init-check.mjs');

interface HookResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runHook(projectDir: string): HookResult {
  const input = JSON.stringify({
    session_id: 'init-check-test',
    source: 'startup',
    cwd: projectDir,
  });

  // Strip VITEST env vars so the spawned hook actually runs main()
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('VITEST')) cleanEnv[k] = v;
  }

  const result = spawnSync('node', [HOOK_PATH], {
    input,
    encoding: 'utf-8',
    timeout: 30000,
    env: {
      ...cleanEnv,
      CLAUDE_PROJECT_DIR: projectDir,
      // FH-01a: do not spawn a real tldr daemon for the throwaway temp project.
      CCV3_TLDR_WARM_OFF: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    exitCode: result.status,
    stdout: (result.stdout || '').toString(),
    stderr: (result.stderr || '').toString(),
  };
}

let tempDir: string;

beforeAll(() => {
  if (!existsSync(HOOK_PATH)) {
    throw new Error(
      `Built hook not found at ${HOOK_PATH}. Run 'npm run build' first.`
    );
  }
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'init-check-test-'));
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('session-start-init-check: .claude path skip warning (Phase 3A)', () => {
  it('emits stderr warning when projectDir contains .claude', () => {
    // Build a path that contains '.claude' but NOT 'continuous-claude'
    const claudePath = join(tempDir, '.claude', 'sub');
    require('fs').mkdirSync(claudePath, { recursive: true });

    const result = runHook(claudePath);

    // The hook should emit our warning string and continue
    expect(result.stderr).toContain('[init-check]');
    expect(result.stderr).toContain('Skipping bootstrap');
    // stdout should still be a valid {"result":"continue"} JSON
    expect(result.stdout).toContain('continue');
  });

  it('does not skip when path is continuous-claude (special case)', () => {
    // continuous-claude paths bypass the .claude skip
    // Just ensure no skip warning fires for a continuous-claude path
    const ccPath = join(tempDir, 'continuous-claude-fake', '.claude');
    require('fs').mkdirSync(ccPath, { recursive: true });

    const result = runHook(ccPath);

    // Skip warning should NOT appear -- continuous-claude is exempt
    expect(result.stderr).not.toContain('Skipping bootstrap');
  });
});

describe('session-start-init-check: hasCodeFiles extension detection (Phase 3B)', () => {
  it('treats a tempdir with only main.py as a code project', () => {
    // No package.json, no requirements.txt -- bare main.py only
    writeFileSync(join(tempDir, 'main.py'), 'print("hello")\n');

    const result = runHook(tempDir);

    // The hook should attempt to generate the tree (hasCodeFiles returns
    // true). The exact success/fail of tree generation depends on
    // PYTHONPATH/uv being on PATH, but the attempt is what we test.
    // The "Generating knowledge tree" message is logged to stderr when
    // hasCodeFiles() returns true.
    const sawAttempt = result.stderr.includes('Generating knowledge tree');
    const treeGenerated = result.stderr.includes('Knowledge tree generated');
    const treeFailed = result.stderr.includes('Failed to generate knowledge tree');

    // At minimum, hasCodeFiles must have returned true -- meaning we saw
    // either the attempt log or one of the result logs.
    expect(sawAttempt || treeGenerated || treeFailed).toBe(true);
  }, 30000);

  it('treats a tempdir with only main.ts as a code project', () => {
    writeFileSync(join(tempDir, 'main.ts'), 'console.log("hi");\n');

    const result = runHook(tempDir);

    const sawAttempt = result.stderr.includes('Generating knowledge tree');
    const treeGenerated = result.stderr.includes('Knowledge tree generated');
    const treeFailed = result.stderr.includes('Failed to generate knowledge tree');

    expect(sawAttempt || treeGenerated || treeFailed).toBe(true);
  }, 30000);

  it('does not attempt tree generation in an empty dir (no code files)', () => {
    // Empty dir -- no manifests, no code files
    const result = runHook(tempDir);

    // No knowledge-tree messages should appear
    expect(result.stderr).not.toContain('Generating knowledge tree');
  });
});

/**
 * Hook-build freshness warning.
 *
 * Both tests were confirmed to FAIL against the pre-fix predicate, which
 * compared src mtimes against `statSync(distDir).mtimeMs` -- a DIRECTORY mtime,
 * which does not move when a rebuild overwrites bundles in place -- and read src
 * with a NON-RECURSIVE readdirSync, so `src/shared/*.ts` was invisible.
 *
 * The fixture is built in the order dist-then-src deliberately: it leaves the
 * dist DIRECTORY older than the sources while the BUNDLE inside it is newer,
 * which is exactly the state a rebuild leaves behind and exactly the state the
 * old predicate misreported as stale.
 */
describe('session-start-init-check: hook build freshness', () => {
  const HOUR = 3600;

  /** Returns the project dir. `newerThanBundle` gets an mtime past the bundle's. */
  function makeHookTree(newerThanBundle: string[] = []): string {
    // The freshness block is gated on the path containing 'continuous-claude'.
    const proj = join(tempDir, 'continuous-claude');
    const src = join(proj, '.claude', 'hooks', 'src');
    const dist = join(proj, '.claude', 'hooks', 'dist');
    mkdirSync(join(src, 'shared'), { recursive: true });
    mkdirSync(dist, { recursive: true });
    // hasCodeFiles() scans the project ROOT; without a source file there the hook
    // returns `continue` at the !hasCodeFiles gate and never reaches the
    // freshness block. Omitting this made the silent-tree test below vacuous --
    // the paired control test is what exposed it.
    writeFileSync(join(proj, 'main.ts'), 'export const x = 1;\n');

    // dist first, so the dist DIRECTORY mtime lands before the sources.
    writeFileSync(join(dist, 'bundle.mjs'), '// built\n');
    writeFileSync(join(src, 'top.ts'), 'export const a = 1;\n');
    writeFileSync(join(src, 'shared', 'nested.ts'), 'export const b = 2;\n');

    const now = Date.now() / 1000;
    // Bundle is NEWER than every source -- i.e. the tree is freshly built.
    utimesSync(join(dist, 'bundle.mjs'), now, now);
    utimesSync(join(src, 'top.ts'), now - HOUR, now - HOUR);
    utimesSync(join(src, 'shared', 'nested.ts'), now - HOUR, now - HOUR);
    // ...while the dist DIRECTORY mtime stays OLDER than the sources. This is the
    // real post-rebuild state (a directory mtime only moves when an entry is
    // added/removed/renamed, not when bundles are overwritten), and it is what
    // the old predicate read. Setting it last: writing into a dir bumps it.
    utimesSync(dist, now - 2 * HOUR, now - 2 * HOUR);

    for (const rel of newerThanBundle) {
      utimesSync(join(src, rel), now + HOUR, now + HOUR);
    }
    return proj;
  }

  it('stays silent on a freshly built tree (dist dir older than src)', () => {
    const result = runHook(makeHookTree());

    expect(result.stderr).not.toContain('is stale');
    expect(result.stdout).not.toContain('is stale');
  }, 30000);

  it('fires for a source under src/shared/ and names it', () => {
    // Also the positive control for the test above: same fixture, same code
    // path, so a silent result there cannot be a block that never ran.
    const result = runHook(makeHookTree(['shared/nested.ts']));

    const out = result.stderr + result.stdout;
    expect(out).toContain('is stale');
    expect(out).toContain('nested.ts');
  }, 30000);
});
