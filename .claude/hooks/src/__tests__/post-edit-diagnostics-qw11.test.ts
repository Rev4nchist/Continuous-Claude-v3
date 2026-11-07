/**
 * QW-11 regression tests for post-edit-diagnostics (closes D2e-02, D2e-08).
 *
 * D2e-02 (tsc shim): the hook must invoke tsc as a direct Node entrypoint
 *   -- `node <typescript/bin/tsc> --noEmit --pretty false` with args kept as a
 *   discrete ARRAY and NO shell -- NOT via the `tsc`/`tsc.cmd` shim. On modern
 *   Node (Windows CVE-2024-27980 hardening) spawning a `.cmd`/`.bat` shim
 *   without shell:true returns status:null/EINVAL, which the hook treats as
 *   "tsc not found" and silently kills the entire TS/JS diagnostics path.
 *   Tested via the extracted pure helper resolveTscCommand(), imported straight
 *   from src -- safe because the module's isDirectInvocation guard means an
 *   import does NOT run main().
 *
 * D2e-08 (bus write skipped by early-return): the L2 context-bus `edited` write
 *   must land even when diagnostics short-circuit (tsc unresolvable / daemon
 *   down). Asserted end-to-end by spawning the BUILT dist hook against a temp
 *   CLAUDE_PROJECT_DIR with NO typescript installed (so resolveTscCommand() ->
 *   null and the tsc path early-returns) and confirming the `edited` entry is
 *   still recorded on the bus.
 *
 * Both targets are deterministic and Windows-safe (drive-letter paths, array
 * arg spawns, pinned COORDINATION_SESSION_ID for a stable bus id).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import { resolveTscCommand } from '../post-edit-diagnostics.js';
import { getBusId } from '../shared/session-bus-id.js';
import { busPath } from '../shared/context-bus.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
// .claude/hooks (parent of src/__tests__) -- has node_modules/typescript.
const HOOKS_DIR = resolve(__dirname, '..', '..');
const HOOK_PATH = resolve(HOOKS_DIR, 'dist', 'post-edit-diagnostics.mjs');

/** Normalize Windows backslashes for stable path assertions. */
function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// D2e-02: tsc resolved as `node <typescript/bin/tsc>`, never a .cmd/.bat shim.
// ---------------------------------------------------------------------------
describe('post-edit-diagnostics D2e-02: tsc invoked as node <tsc>, not a .cmd shim', () => {
  it('resolves to `node <typescript/bin/tsc>` with discrete array args (no shell)', () => {
    // A fixture project with its own typescript entry: the test must not depend on where this
    // checkout keeps node_modules (a nested worktree reaches it through the shared store link).
    const fixture = mkdtempSync(join(tmpdir(), 'ped-d2e02-'));
    mkdirSync(join(fixture, 'node_modules', 'typescript', 'bin'), { recursive: true });
    writeFileSync(join(fixture, 'node_modules', 'typescript', 'bin', 'tsc'), '#!/usr/bin/env node\n');
    try {
      const cmd = resolveTscCommand(fixture);

      expect(cmd).not.toBeNull();

      // The command is the Node binary itself -- never a tsc/.cmd/.bat shim.
      expect(cmd!.command).toBe(process.execPath);
      expect(norm(cmd!.command).toLowerCase()).toMatch(/node(\.exe)?$/);
      expect(norm(cmd!.command).toLowerCase()).not.toMatch(/tsc(\.cmd|\.bat)$/);

      // First arg is the typescript package JS entrypoint, and it really exists.
      expect(norm(cmd!.args[0])).toMatch(/typescript\/bin\/tsc$/);
      expect(existsSync(cmd!.args[0])).toBe(true);

      // Flags are preserved as individual array elements (spaced-path safe).
      expect(cmd!.args).toEqual([cmd!.args[0], '--noEmit', '--pretty', 'false']);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('returns null when typescript is not installed for the project', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ped-no-ts-'));
    try {
      expect(resolveTscCommand(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// D2e-08: the bus `edited` write survives the tsc early-return path.
// ---------------------------------------------------------------------------
describe('post-edit-diagnostics D2e-08: bus `edited` write survives tsc early-return', () => {
  let tmp: string;
  let projectDir: string;
  const SESSION = 'ped-qw11-sess';

  beforeAll(() => {
    if (!existsSync(HOOK_PATH)) {
      throw new Error(
        `Built hook not found at ${HOOK_PATH}. Run 'npm run build' first.`,
      );
    }
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ped-qw11-'));
    projectDir = join(tmp, 'proj');
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function runHook(input: object): {
    exitCode: number | null;
    stdout: string;
    stderr: string;
  } {
    const cleanEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('VITEST')) cleanEnv[k] = v;
    }
    cleanEnv.COORDINATION_SESSION_ID = SESSION;
    cleanEnv.CLAUDE_PROJECT_DIR = projectDir;
    delete cleanEnv.CCV3_BUS_OFF;
    const r = spawnSync('node', [HOOK_PATH], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 20000,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      exitCode: r.status,
      stdout: (r.stdout || '').toString(),
      stderr: (r.stderr || '').toString(),
    };
  }

  /** Compute the bus file path the subprocess will write to (pinned session). */
  function busFile(): string {
    const prev = {
      COORDINATION_SESSION_ID: process.env.COORDINATION_SESSION_ID,
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
    };
    process.env.COORDINATION_SESSION_ID = SESSION;
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    try {
      return busPath(getBusId({ cwd: projectDir }), projectDir);
    } finally {
      if (prev.COORDINATION_SESSION_ID === undefined)
        delete process.env.COORDINATION_SESSION_ID;
      else process.env.COORDINATION_SESSION_ID = prev.COORDINATION_SESSION_ID;
      if (prev.CLAUDE_PROJECT_DIR === undefined)
        delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev.CLAUDE_PROJECT_DIR;
    }
  }

  it('records the `edited` file even when tsc cannot run (no typescript in project)', () => {
    // projectDir has no node_modules/typescript and no .claude/hooks/node_modules
    // -> resolveTscCommand() returns null -> the tsc path short-circuits.
    // Pre-fix the early-return ran BEFORE the bus write so nothing landed;
    // post-fix the `edited` entry is recorded first.
    const edited = norm(join(projectDir, 'src', 'widget.ts'));
    const r = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: edited },
      tool_result: { success: true },
    });

    // The hook never crashes and emits exactly one valid JSON object.
    expect(r.exitCode).toBe(0);
    expect(() => JSON.parse(r.stdout.trim())).not.toThrow();

    // The bus `edited` entry landed despite tsc not running.
    const path = busFile();
    expect(existsSync(path)).toBe(true);
    const bus = JSON.parse(readFileSync(path, 'utf-8'));
    const entries = bus.files_in_play.load_bearing as Array<{
      path: string;
      role: string;
    }>;
    expect(entries.some((f) => f.role === 'edited')).toBe(true);
    expect(entries.some((f) => f.path === edited && f.role === 'edited')).toBe(
      true,
    );
  }, 25000);
});
