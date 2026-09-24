/**
 * Tests for post-edit-diagnostics hook.
 *
 * The tsc-parsing tests that lived here were removed on 2026-09-24 (test signal audit): they
 * exercised copies of the parser defined in this file, and stayed green with the real
 * TSC_LINE_REGEX broken. The real tsc invocation is covered by post-edit-diagnostics-qw11.test.ts.
 *
 * WS-2 Phase B.4a: the hook records the edited file on the L2
 * context bus as a load-bearing `edited` entry (ONLY `edited` -- a type error is
 * not a test failure; review F6). Those tests exercise recordBusFilesInPlay
 * directly against a temp CLAUDE_PROJECT_DIR (real mutateBus default path) and
 * confirm a non-Edit / no-file-path invocation writes nothing.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import { recordBusFilesInPlay } from '../post-edit-diagnostics.js';
import { getBusId } from '../shared/session-bus-id.js';
import { busPath, readBus, mutateBus, bumpTurn, type BusEntry } from '../shared/context-bus.js';

// ---------------------------------------------------------------------------
// 6. WS-2 Phase B.4a: bus files_in_play recording (recordBusFilesInPlay)
//
// The hook records the edited file on the L2 context bus as a load-bearing
// `edited` entry (ONLY `edited`; a type-check failure is not a test failure --
// review F6). These tests drive recordBusFilesInPlay directly against a real temp
// CLAUDE_PROJECT_DIR (the default mutateBus lock-backed path), so the
// load-bearing slice is asserted end-to-end.
// COORDINATION_SESSION_ID is pinned so getBusId() is stable.
// ---------------------------------------------------------------------------
describe('post-edit-diagnostics: bus files_in_play recording (Phase B.4a)', () => {
  let tmp: string;
  const SAVE = ['CLAUDE_PROJECT_DIR', 'CCV3_BUS_OFF', 'COORDINATION_SESSION_ID'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of SAVE) saved[k] = process.env[k];
    process.env.COORDINATION_SESSION_ID = 'ped-bus-sess';
    delete process.env.CCV3_BUS_OFF;
    tmp = mkdtempSync(join(tmpdir(), 'ped-bus-'));
    process.env.CLAUDE_PROJECT_DIR = tmp;
  });

  afterEach(() => {
    for (const k of SAVE) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('adds an `edited` load-bearing file when there are NO type errors', () => {
    const file = 'C:/proj/src/feature.ts';
    recordBusFilesInPlay(file);

    const bus = readBus();
    expect(bus.files_in_play.load_bearing).toHaveLength(1);
    expect(bus.files_in_play.load_bearing[0]).toMatchObject({
      path: file,
      role: 'edited',
    });
    // No type errors -> no test_failed entry.
    expect(
      bus.files_in_play.load_bearing.some((f) => f.role === 'test_failed'),
    ).toBe(false);
    // turn_added is stamped from current_turn (0 on a fresh bus).
    expect(bus.files_in_play.load_bearing[0].turn_added).toBe(0);
  });

  it('adds ONLY `edited` (never test_failed) even on a file with type errors', () => {
    // Review F6: a type-check failure is not a test failure -- recordBusFilesInPlay
    // records only the `edited` role; `test_failed` is reserved for a real runner.
    const file = 'C:/proj/src/broken.ts';
    recordBusFilesInPlay(file);

    const bus = readBus();
    const roles = bus.files_in_play.load_bearing.map((f) => f.role);
    expect(roles).toEqual(['edited']);
    expect(bus.files_in_play.load_bearing[0].path).toBe(file);
  });

  it('persists to the real default bus path and bumps revision', () => {
    const file = 'C:/proj/src/x.ts';
    recordBusFilesInPlay(file);
    const path = busPath(getBusId());
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    expect(onDisk.revision).toBe(1);
    expect(onDisk.files_in_play.load_bearing[0].path).toBe(file);
  });

  it('stamps turn_added from the bus current_turn (not always 0)', () => {
    // Seed the bus to turn 3 first, then record an edit; the entry must carry 3.
    mutateBus(undefined, (b: BusEntry) => {
      bumpTurn(b);
      bumpTurn(b);
      bumpTurn(b);
    });
    recordBusFilesInPlay('C:/proj/src/turned.ts');
    const bus = readBus();
    for (const f of bus.files_in_play.load_bearing) {
      expect(f.turn_added).toBe(3);
    }
  });

  it('is fail-open: CCV3_BUS_OFF makes it a no-op (no file, no throw)', () => {
    process.env.CCV3_BUS_OFF = '1';
    expect(() => recordBusFilesInPlay('C:/proj/src/off.ts')).not.toThrow();
    expect(existsSync(busPath(getBusId()))).toBe(false);
  });

  it('is fail-open: an unwritable project dir does not throw and writes no file', () => {
    // Point the bus at a path under a regular FILE so the write cannot land.
    const fileAsProj = join(tmp, 'regular-file');
    // Write a file where a directory would be expected.
    writeFileSync(fileAsProj, 'not a dir');
    process.env.CLAUDE_PROJECT_DIR = fileAsProj;
    expect(() => recordBusFilesInPlay('C:/proj/src/y.ts')).not.toThrow();
    expect(existsSync(busPath(getBusId(), fileAsProj))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Guard contract: a non-Edit / no-file-path invocation writes NOTHING to the
// bus. recordBusFilesInPlay sits AFTER main()'s tool_name + file_path guards, so
// those invocations never reach it. We assert the contract end-to-end by
// spawning the built hook (which early-exits before any diagnostics or bus
// write) and confirming no bus file appears under a temp project dir.
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const HOOK_PATH = resolve(__dirname, '..', '..', 'dist', 'post-edit-diagnostics.mjs');

describe('post-edit-diagnostics: non-Edit / no-file-path invocations write no bus file', () => {
  let tmp: string;
  let projectDir: string;
  const SESSION = 'ped-guard-sess';

  function runHook(input: object): {
    exitCode: number | null;
    stdout: string;
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
      timeout: 15000,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: r.status, stdout: (r.stdout || '').toString() };
  }

  function busPathForProject(): string {
    const prev = {
      COORDINATION_SESSION_ID: process.env.COORDINATION_SESSION_ID,
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
    };
    process.env.COORDINATION_SESSION_ID = SESSION;
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    try {
      return busPath(getBusId({ cwd: projectDir }), projectDir);
    } finally {
      if (prev.COORDINATION_SESSION_ID === undefined) delete process.env.COORDINATION_SESSION_ID;
      else process.env.COORDINATION_SESSION_ID = prev.COORDINATION_SESSION_ID;
      if (prev.CLAUDE_PROJECT_DIR === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev.CLAUDE_PROJECT_DIR;
    }
  }

  beforeAll(() => {
    if (!existsSync(HOOK_PATH)) {
      throw new Error(`Built hook not found at ${HOOK_PATH}. Run 'npm run build' first.`);
    }
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ped-guard-'));
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

  it('a non-Edit tool (Read) writes no bus file', () => {
    const r = runHook({
      tool_name: 'Read',
      tool_input: { file_path: 'C:/proj/src/whatever.ts' },
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(busPathForProject())).toBe(false);
  }, 20000);

  it('an Edit with no file_path writes no bus file', () => {
    const r = runHook({
      tool_name: 'Edit',
      tool_input: {},
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(busPathForProject())).toBe(false);
  }, 20000);

  it('an Edit on a NON-code file (.md) writes no bus file', () => {
    const r = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: 'C:/proj/docs/notes.md' },
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(busPathForProject())).toBe(false);
  }, 20000);
});
