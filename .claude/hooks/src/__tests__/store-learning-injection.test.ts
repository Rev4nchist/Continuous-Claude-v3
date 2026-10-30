/**
 * QW-01 (S0) — store_learning.py shell-injection regression test.
 *
 * The "junk-creator" bug: four hook call sites built a `store_learning.py`
 * invocation as a SHELL STRING by interpolating untrusted content (agent
 * error text / user prompt), then ran it via execSync — which ALWAYS uses a
 * shell. On Windows cmd.exe, content containing `& | < > ^ % " $() ` (backticks)
 * broke the quoting and either executed injected commands or wrote malformed
 * "junk" files at the repo root.
 *
 * The fix converts each call site to spawnSync('uv', [...argv], { shell:false })
 * with every argument as a SEPARATE array element and NO manual escaping — so
 * the raw content is passed verbatim as one argv element and no shell can
 * interpret metacharacters.
 *
 * These tests assert, for each of the 3 hooks:
 *   1. spawnSync was called (NOT execSync) for the store path.
 *   2. The 2nd argument is an ARRAY (argv list).
 *   3. The element immediately after '--content' EQUALS the raw injected
 *      content byte-for-byte (no backslash escaping, no stripped chars).
 *   4. The options object has shell !== true.
 *
 * Plus a static-source regression guard: the post-fix sources contain no
 * `execSync(` building a store_learning command and no `.replace(/"/g`
 * escaping near these sites.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_DIR = join(__dirname, '..');

// A nasty payload exercising every dangerous shell metacharacter across
// POSIX sh AND Windows cmd.exe: & | < > ^ % " $() `backticks` ; rm -rf.
const INJECTION = 'bad & rm -rf x; $(whoami) `id` "q" | cat > pwn.txt ^ %PATH% < /etc/passwd';

// Mock child_process so neither execSync nor spawnSync ever shells out for real.
const spawnSyncMock = vi.fn(() => ({
  status: 0,
  stdout: '',
  stderr: '',
  pid: 1234,
  output: ['', '', ''],
  signal: null,
}));
const execSyncMock = vi.fn(() => '');

/**
 * agent-error-capture no longer uses spawnSync: 09ba655 made its store a DETACHED
 * async spawn (fire-and-forget, so the store outlives the short-lived hook). It is
 * reached through the injectable `deps.spawnFn` seam, so this stub is passed in
 * directly rather than mocked globally.
 *
 * That injection also fixes a real side effect: because only spawnSync/execSync
 * were stubbed, the unmocked spawn actually launched a detached
 * `uv run python .../store_learning.py` on every single suite run -- which is where
 * the "[AgentErrorCapture] Dispatched (detached)" line in the run log came from,
 * and which contradicted this file's own premise that nothing ever shells out.
 */
const spawnMock = vi.fn(() => ({ pid: 4321, unref: () => {} }) as any);

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: spawnSyncMock,
    execSync: execSyncMock,
  };
});

// store_learning.py must "exist" for the existsSync guards in the hooks to pass.
// Create a real opc tree in a temp dir and point CLAUDE_OPC_DIR at it.
const OPC_DIR = mkdtempSync(join(tmpdir(), 'ccv3-qw01-opc-'));
mkdirSync(join(OPC_DIR, 'scripts', 'core'), { recursive: true });
writeFileSync(join(OPC_DIR, 'scripts', 'core', 'store_learning.py'), '# stub\n');
process.env.CLAUDE_OPC_DIR = OPC_DIR;

/** Find the argv element immediately after the given flag. */
function argAfter(argv: unknown, flag: string): string | undefined {
  if (!Array.isArray(argv)) return undefined;
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return undefined;
  return argv[i + 1] as string;
}

/** The first call on `mock` whose argv contains store_learning.py. */
function findStoreCall(mock: { mock: { calls: unknown[][] } }): any[] | undefined {
  const calls = mock.mock.calls as unknown as any[][];
  return calls.find((c) => {
    const argv = c[1];
    return Array.isArray(argv) && argv.some((a: unknown) => typeof a === 'string' && a.includes('store_learning.py'));
  });
}

/**
 * VESTIGIAL as of 2026-07-29: hook-error-pipeline is archived, so nothing in this
 * file writes the marker any more. The cleanup is kept because it is free and the
 * failure mode it documents is worth not relearning.
 *
 * hook-error-pipeline dedups identical errors for 5 minutes via a REAL file in the
 * developer's temp dir ($TEMP/claude-hook-errors/recent-errors.json, keyed on
 * hookName + errorMessage). Because this test always reports the same hook name
 * and the same INJECTION message, it stored a marker on its first run and then
 * SKIPPED the store on every run within the next 5 minutes -- so it passed once
 * and failed on every rerun, with `expected undefined to be defined`.
 *
 * That is a pre-existing defect, not a new one, and it is the most likely
 * explanation for the suite's total moving between 93 and 94 failures across runs.
 * Proven 2026-07-29 by execution: delete the marker -> 7 passed; rerun
 * immediately -> 1 failed / 6 passed, deterministically. The live marker held 20
 * entries, several dated days earlier.
 *
 * Clearing it here makes the run independent of when the previous run happened.
 */
const HOOK_ERROR_STATE = join(tmpdir(), 'claude-hook-errors');

beforeEach(() => {
  spawnSyncMock.mockClear();
  execSyncMock.mockClear();
  spawnMock.mockClear();
  try {
    rmSync(join(HOOK_ERROR_STATE, 'recent-errors.json'), { force: true });
  } catch {
    // Never let cleanup fail the test.
  }
});

describe('QW-01: store_learning.py injection — no-shell spawnSync', () => {
  it('agent-error-capture.ts: stores via detached spawn with raw content argv', async () => {
    const mod: any = await import('../agent-error-capture.js');
    const fn = mod.storeLearning;
    expect(typeof fn, 'storeLearning must be exported for testing').toBe('function');

    // Drive the store path directly with the injection payload as the error context.
    // spawnFn is injected so nothing is really launched (see spawnMock above).
    fn('sess-1', 'kraken', 'do a thing', INJECTION, { spawnFn: spawnMock });

    expect(execSyncMock, 'execSync must NOT be used for the store').not.toHaveBeenCalled();
    expect(spawnSyncMock, 'the store is a detached spawn, not spawnSync').not.toHaveBeenCalled();
    const call = findStoreCall(spawnMock);
    expect(call, 'spawn should have been called with store_learning.py').toBeDefined();

    const argv = call![1];
    expect(Array.isArray(argv)).toBe(true);

    // Raw content passed verbatim — must CONTAIN the injection unescaped.
    const content = argAfter(argv, '--content');
    expect(content).toContain(INJECTION);
    expect(content).not.toContain('\\"'); // no sh-style escaping leaked in

    const opts: any = call![2] || {};
    expect(opts.shell).not.toBe(true);
  });

  // hook-error-pipeline.ts was ARCHIVED 2026-07-29 -> .claude/hooks/archive/.
  // It was dead code: zero importers outside this test, registered in no
  // settings.json, and flagged for archive by three independent audits (35
  // health_*.json orphan entries, hook-audit-2026-04.md:134, the 2026-06-10 WF2
  // review). Its own QW-01 test is removed with it -- keeping a security test for
  // a module nothing loads is what made the sibling arscontexta fossils survive a
  // month of red. The two live producers below still carry their QW-01 coverage.

  it('user-confirmation-detector.ts: USER_PREFERENCE store via detached spawn with raw content', async () => {
    const mod: any = await import('../user-confirmation-detector.js');
    const fn = mod.storeUserConfirmedLearning;
    expect(typeof fn, 'storeUserConfirmedLearning must be exported').toBe('function');

    // 14: the store is dispatched DETACHED through the injected spawnFn (the 60 s
    // spawnSync could never finish under the 5 s hook timeout). The hook returns at once.
    const child = { pid: 99, unref: vi.fn() };
    const seamSpawn = vi.fn(() => child as any);
    const t0 = Date.now();
    await fn('sess-3', INJECTION, null, OPC_DIR, { spawnFn: seamSpawn });
    expect(Date.now() - t0, 'the hook must return at once').toBeLessThan(500);

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(spawnSyncMock, 'the store must not block on spawnSync').not.toHaveBeenCalled();
    const call = findStoreCall(seamSpawn);
    expect(call, 'spawnFn should have been called with store_learning.py').toBeDefined();
    expect((call![2] as any).detached, 'the store must be detached').toBe(true);
    expect(child.unref, 'the child must be unreffed').toHaveBeenCalled();

    const argv = call![1];
    expect(Array.isArray(argv)).toBe(true);
    expect(argv.indexOf('--type')).toBeGreaterThanOrEqual(0);
    expect(argAfter(argv, '--type')).toBe('USER_PREFERENCE');

    const content = argAfter(argv, '--content');
    // The hook wraps the prompt: `User confirmed: "<prompt>"`; the raw prompt
    // (with all metachars) must survive verbatim inside that wrapper.
    expect(content).toContain(INJECTION);
    expect(content).not.toContain('\\"');

    const opts: any = call![2] || {};
    expect(opts.shell).not.toBe(true);
  });

  it('user-confirmation-detector.ts: WORKING_SOLUTION store via detached spawn with raw content', async () => {
    const mod: any = await import('../user-confirmation-detector.js');
    const fn = mod.storeVictoryFromConfirmation;
    expect(typeof fn, 'storeVictoryFromConfirmation must be exported').toBe('function');

    const state = {
      session_id: 'sess-4',
      state: 'CANDIDATE',
      tracked_file: 'foo.ts',
      attempts: 3,
      failures: [{ turn: 1, error: 'boom' }],
      candidate_turn: 2,
      last_edit_content: INJECTION,
      test_command: null,
      context: 'ctx',
      current_turn: 5,
    };

    const child = { pid: 99, unref: vi.fn() };
    const seamSpawn = vi.fn(() => child as any);
    await fn(state, INJECTION, OPC_DIR, { spawnFn: seamSpawn });

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(spawnSyncMock, 'the store must not block on spawnSync').not.toHaveBeenCalled();
    const call = findStoreCall(seamSpawn);
    expect(call, 'spawnFn should have been called with store_learning.py').toBeDefined();
    expect((call![2] as any).detached, 'the store must be detached').toBe(true);
    expect(child.unref, 'the child must be unreffed').toHaveBeenCalled();

    const argv = call![1];
    expect(Array.isArray(argv)).toBe(true);
    expect(argAfter(argv, '--type')).toBe('WORKING_SOLUTION');

    const content = argAfter(argv, '--content');
    expect(content).toContain(INJECTION);
    expect(content).not.toContain('\\"');

    const opts: any = call![2] || {};
    expect(opts.shell).not.toBe(true);
  });
});

describe('QW-01: static-source regression guard', () => {
  // hook-error-pipeline.ts removed 2026-07-29 -- archived as dead code. These are
  // the two producers that are actually registered and actually run.
  const FILES = [
    'agent-error-capture.ts',
    'user-confirmation-detector.ts',
  ];

  for (const f of FILES) {
    it(`${f}: no execSync building a store_learning command, no sh-escaping`, () => {
      const p = join(SRC_DIR, f);
      expect(existsSync(p)).toBe(true);
      const src = readFileSync(p, 'utf-8');

      // No execSync(...) anywhere that could shell out for the store.
      expect(/execSync\s*\(/.test(src), `${f} still calls execSync(`).toBe(false);

      // No sh-style double-quote escaping near the store call sites.
      expect(/\.replace\(\/"\/g/.test(src), `${f} still does .replace(/"/g escaping`).toBe(false);

      // Must dispatch the store through child_process WITHOUT a shell. The
      // original assertion here was /spawnSync\s*\(/ -- a function NAME, which
      // 09ba655 broke by moving agent-error-capture to a detached async spawn()
      // while leaving the security invariant fully intact. A name is not the
      // invariant; "argv array, no shell" is. Note /spawn\s*\(/ would not work
      // either: agent-error-capture calls through an injected `spawnFn` seam and
      // contains no literal spawn( at all. So assert the import.
      expect(
        /import\s*\{[^}]*\bspawn(Sync)?\b[^}]*\}\s*from\s*['"]child_process['"]/.test(src),
        `${f} must import spawn or spawnSync from child_process`,
      ).toBe(true);

      // The actual invariant: never hand the store to a shell.
      expect(/shell:\s*true/.test(src), `${f} must not pass shell: true`).toBe(false);
      expect(/shell:\s*false/.test(src), `${f} must pass shell: false explicitly`).toBe(true);
    });
  }
});
