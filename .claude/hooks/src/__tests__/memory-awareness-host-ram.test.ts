/**
 * Hook-layer integration tests for the BLOCKER-2 host-memory-pressure defense
 * (memory-system-next-steps-2026-05-21).
 *
 * Lives in its own file so the existing memory-awareness.test.ts stays at
 * its original scope (early-exit guards, fail-safe, envelope shape) and any
 * formatter/linter on that file leaves these tests alone.
 *
 * Verifies the wiring between `getFreeRamBytes()` / `getHostRamFloorBytes()`
 * (unit-tested in host-ram.test.ts) and the memory-awareness hook:
 *
 *   * Pressured host -> mode='text-only', host_memory_pressure=true logged
 *   * Healthy host   -> normal flow, host_memory_pressure=false logged
 *   * Probe failure  -> fail-open, host_memory_pressure=false logged
 *
 * We drive the probe via env vars (CCV3_HOST_RAM_OVERRIDE_BYTES and
 * CCV3_HOST_RAM_FLOOR_BYTES) so the tests never depend on actual system RAM
 * and run the same on any machine. The hook writes one jsonl line per fire
 * to <projectDir>/.claude/logs/memory-recall.jsonl; we read it post-hook to
 * assert the entry's shape.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const HOOK_PATH = resolve(__dirname, '..', '..', 'dist', 'memory-awareness.mjs');

// Per-test timeout matches the sibling test file's value; node cold-starts
// can take 3-5s on Windows.
const TEST_TIMEOUT_MS = 20000;

interface HookResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  parsed?: any;
}

function runHook(
  input: object,
  envOverrides: Record<string, string | undefined> = {},
  opts: { timeoutMs?: number } = {},
): HookResult {
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('VITEST')) cleanEnv[k] = v;
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      delete cleanEnv[k];
    } else {
      cleanEnv[k] = v;
    }
  }

  const result = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: opts.timeoutMs ?? 10000,
    env: cleanEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdout = (result.stdout || '').toString();
  let parsed: any;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    /* leave parsed undefined */
  }

  return {
    exitCode: result.status,
    stdout,
    stderr: (result.stderr || '').toString(),
    parsed,
  };
}

let tempDir: string;
let projectDir: string;
let fakeHome: string;

function isolatedEnv(): Record<string, string | undefined> {
  return {
    CLAUDE_AGENT_ID: undefined,
    CLAUDE_OPC_DIR: join(tempDir, 'no-such-opc-dir'),
    CLAUDE_PROJECT_DIR: projectDir,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    // Kill-switch. This file spawns the REAL dist/memory-awareness.mjs, which
    // calls ensureDaemonRunning(); resolveRepoRoot() walks process.argv[1] up to
    // the REAL repo's opc/ and ignores the fake HOME/CLAUDE_PROJECT_DIR above. So
    // without this, every run of this file leaks TWO detached
    // `uv run embedding_daemon.py --daemon` trees that never exit -- each loading
    // a ~1.3GB model and opening console windows.
    //
    // Measured 2026-07-29: this file leaked exactly 2 per run and accounted for
    // the entire full-suite leak (9 suite runs -> 18 orphaned daemon trees, 45
    // python + 22 uv processes). isolatedEnv() here is a near-copy of the one in
    // memory-awareness.test.ts, which has carried this guard (and the comment
    // explaining it) since 2026-06-05; the copy dropped the line.
    CCV3_EMBEDDING_NO_SPAWN: '1',
    // These two are scrubbed by default; individual tests override.
    CCV3_HOST_RAM_OVERRIDE_BYTES: undefined,
    CCV3_HOST_RAM_FLOOR_BYTES: undefined,
  };
}

function readLastLogEntry(): any {
  const logPath = join(projectDir, '.claude', 'logs', 'memory-recall.jsonl');
  expect(existsSync(logPath)).toBe(true);
  const lines = readFileSync(logPath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]);
}

beforeAll(() => {
  if (!existsSync(HOOK_PATH)) {
    throw new Error(
      `Built hook not found at ${HOOK_PATH}. Run 'npm run build' first.`,
    );
  }
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mem-aware-host-ram-test-'));
  projectDir = join(tempDir, 'proj');
  mkdirSync(projectDir, { recursive: true });
  fakeHome = join(tempDir, 'fakehome');
  mkdirSync(fakeHome, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('memory-awareness: BLOCKER-2 host-memory-pressure', () => {
  it('pressured host -> mode=text-only, host_memory_pressure=true, fallback reason set', () => {
    const env = {
      ...isolatedEnv(),
      CCV3_HOST_RAM_OVERRIDE_BYTES: '1',
      CCV3_HOST_RAM_FLOOR_BYTES: String(8 * 1024 * 1024 * 1024),
    };
    const result = runHook(
      {
        session_id: 'test-pressure-on',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'help me debug why recall keeps returning empty results today',
        cwd: projectDir,
      },
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toBeDefined();
    expect(result.stderr).toMatch(/host RAM low/);

    const entry = readLastLogEntry();
    expect(entry.host_memory_pressure).toBe(true);
    expect(entry.embed_fallback_reason).toBe('host_memory_pressure');
    expect(entry.mode).toBe('text-only');
    expect(entry.daemon_ready).toBe(false);
    expect(entry.free_ram_bytes).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('healthy host -> host_memory_pressure=false, no fallback reason, normal flow', () => {
    const env = {
      ...isolatedEnv(),
      CCV3_HOST_RAM_OVERRIDE_BYTES: String(16 * 1024 * 1024 * 1024),
    };
    const result = runHook(
      {
        session_id: 'test-pressure-off',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'help me debug why recall keeps returning empty results today',
        cwd: projectDir,
      },
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(/host RAM low/);

    const entry = readLastLogEntry();
    expect(entry.host_memory_pressure).toBe(false);
    expect(entry.embed_fallback_reason).toBeNull();
    expect(entry.free_ram_bytes).toBe(16 * 1024 * 1024 * 1024);
  }, TEST_TIMEOUT_MS);

  it('probe fail-open (no override) -> healthy path on a normal dev box', () => {
    const env = isolatedEnv();
    const result = runHook(
      {
        session_id: 'test-pressure-fail-open',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'a query that gets past early exit guards and reaches the probe',
        cwd: projectDir,
      },
      env,
    );
    expect(result.exitCode).toBe(0);

    const entry = readLastLogEntry();
    expect(entry.host_memory_pressure).toBe(false);
  }, TEST_TIMEOUT_MS);
});
