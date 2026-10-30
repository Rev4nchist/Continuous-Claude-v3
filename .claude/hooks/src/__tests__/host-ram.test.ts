/**
 * Unit tests for the host-memory-pressure probe (BLOCKER-2,
 * memory-system-next-steps-2026-05-21).
 *
 * These tests inject mocked spawnSync / readFileSync so they exercise both
 * platform branches without touching real PowerShell or /proc on disk.
 *
 * The contract under test:
 *   * Windows: PowerShell stdout in KB → bytes
 *   * POSIX:   /proc/meminfo MemAvailable line in kB → bytes
 *   * Any failure (timeout, malformed output, missing field, exception)
 *     → POSITIVE_INFINITY (fail-open)
 *   * isHostMemoryPressured() picks up the floor consistently
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { SpawnSyncReturns } from 'child_process';
import {
  getFreeRamBytes,
  getHostRamFloorBytes,
  isHostMemoryPressured,
  getFreeRamBytesNoSpawn,
  HOST_RAM_FLOOR_BYTES,
} from '../shared/host-ram.js';

// Each test owns its env overrides. Clean both vars after every test so a
// failure in one doesn't bleed into the next.
afterEach(() => {
  delete process.env.CCV3_HOST_RAM_OVERRIDE_BYTES;
  delete process.env.CCV3_HOST_RAM_FLOOR_BYTES;
});

// ---------------------------------------------------------------------------
// Helpers: tiny factories so each test reads as "given X, expect Y" without
// boilerplate noise.
// ---------------------------------------------------------------------------

function fakeSpawn(stdout: string): (...args: any[]) => SpawnSyncReturns<string> {
  return () =>
    ({
      pid: 0,
      output: [],
      stdout,
      stderr: '',
      status: 0,
      signal: null,
    }) as unknown as SpawnSyncReturns<string>;
}

function throwingSpawn(): (...args: any[]) => SpawnSyncReturns<string> {
  return () => {
    throw new Error('spawn failed');
  };
}

function fakeReadFile(contents: string): (path: string, enc: BufferEncoding) => string {
  return () => contents;
}

function throwingReadFile(): (path: string, enc: BufferEncoding) => string {
  return () => {
    throw new Error('ENOENT');
  };
}

// ---------------------------------------------------------------------------
// Group A — Windows path (PowerShell)
// ---------------------------------------------------------------------------

describe('host-ram: Windows (PowerShell)', () => {
  it('parses KB output and converts to bytes', () => {
    // 4194304 KB = 4 GB
    const bytes = getFreeRamBytes(fakeSpawn('4194304\n'), fakeReadFile(''), 'win32');
    expect(bytes).toBe(4 * 1024 * 1024 * 1024);
  });

  it('tolerates whitespace and CR/LF around the number', () => {
    const bytes = getFreeRamBytes(fakeSpawn('  524288 \r\n'), fakeReadFile(''), 'win32');
    expect(bytes).toBe(524288 * 1024); // 512 MB
  });

  it('returns POSITIVE_INFINITY when stdout is empty', () => {
    const bytes = getFreeRamBytes(fakeSpawn(''), fakeReadFile(''), 'win32');
    expect(bytes).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns POSITIVE_INFINITY when stdout is non-numeric', () => {
    const bytes = getFreeRamBytes(fakeSpawn('not a number'), fakeReadFile(''), 'win32');
    expect(bytes).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns POSITIVE_INFINITY when stdout is 0 (sentinel for unknown)', () => {
    // 0 KB free is physically impossible on a running system; treat as
    // probe failure rather than reporting an unrealistic floor breach.
    const bytes = getFreeRamBytes(fakeSpawn('0'), fakeReadFile(''), 'win32');
    expect(bytes).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns POSITIVE_INFINITY when spawn itself throws', () => {
    const bytes = getFreeRamBytes(throwingSpawn(), fakeReadFile(''), 'win32');
    expect(bytes).toBe(Number.POSITIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------
// Group B — POSIX path (/proc/meminfo)
// ---------------------------------------------------------------------------

describe('host-ram: POSIX (/proc/meminfo)', () => {
  it('parses MemAvailable from a realistic meminfo blob', () => {
    const meminfo = [
      'MemTotal:       16384000 kB',
      'MemFree:         1234567 kB',
      'MemAvailable:    8388608 kB', // 8 GB
      'Buffers:           12345 kB',
    ].join('\n');
    const bytes = getFreeRamBytes(fakeSpawn(''), fakeReadFile(meminfo), 'linux');
    expect(bytes).toBe(8388608 * 1024);
  });

  it('returns POSITIVE_INFINITY when MemAvailable is absent', () => {
    // Some older kernels (<3.14) lack MemAvailable. Treat as probe failure
    // rather than falling back to MemFree (which under-reports usable RAM).
    const meminfo = 'MemTotal: 16384000 kB\nMemFree: 1234567 kB\n';
    const bytes = getFreeRamBytes(fakeSpawn(''), fakeReadFile(meminfo), 'linux');
    expect(bytes).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns POSITIVE_INFINITY when readFileSync throws', () => {
    const bytes = getFreeRamBytes(fakeSpawn(''), throwingReadFile(), 'linux');
    expect(bytes).toBe(Number.POSITIVE_INFINITY);
  });

  it('treats non-positive MemAvailable as probe failure', () => {
    const meminfo = 'MemAvailable:        0 kB\n';
    const bytes = getFreeRamBytes(fakeSpawn(''), fakeReadFile(meminfo), 'linux');
    expect(bytes).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('host-ram: getFreeRamBytesNoSpawn (no child process)', () => {
  afterEach(() => { delete process.env.CCV3_HOST_RAM_OVERRIDE_BYTES; });

  it('Windows: returns os.freemem() bytes', () => {
    expect(getFreeRamBytesNoSpawn(() => 8 * 1024 ** 3, fakeReadFile(''), 'win32')).toBe(8 * 1024 ** 3);
  });

  it('Windows: a zero, NaN or throwing freemem fails open', () => {
    expect(getFreeRamBytesNoSpawn(() => 0, fakeReadFile(''), 'win32')).toBe(Number.POSITIVE_INFINITY);
    expect(getFreeRamBytesNoSpawn(() => NaN, fakeReadFile(''), 'win32')).toBe(Number.POSITIVE_INFINITY);
    expect(getFreeRamBytesNoSpawn(() => { throw new Error('x'); }, fakeReadFile(''), 'win32')).toBe(Number.POSITIVE_INFINITY);
  });

  it('Windows: the override env var wins', () => {
    process.env.CCV3_HOST_RAM_OVERRIDE_BYTES = '12345';
    expect(getFreeRamBytesNoSpawn(() => 8 * 1024 ** 3, fakeReadFile(''), 'win32')).toBe(12345);
  });

  it('POSIX: reads MemAvailable like the sync probe', () => {
    const meminfo = 'MemAvailable:     2048 kB\n';
    expect(getFreeRamBytesNoSpawn(() => 1, fakeReadFile(meminfo), 'linux')).toBe(2048 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Group C — isHostMemoryPressured() decision
// ---------------------------------------------------------------------------

describe('host-ram: pressure decision', () => {
  it('returns true below the floor', () => {
    expect(isHostMemoryPressured(1024 * 1024 * 1024)).toBe(true); // 1 GB free
  });

  it('returns false at the floor (strictly less-than)', () => {
    expect(isHostMemoryPressured(HOST_RAM_FLOOR_BYTES)).toBe(false);
  });

  it('returns false well above the floor', () => {
    expect(isHostMemoryPressured(16 * 1024 * 1024 * 1024)).toBe(false); // 16 GB free
  });

  it('returns false on probe failure (POSITIVE_INFINITY)', () => {
    // Fail-open: if we can't tell, we don't pressure-trip — the whole
    // point of fail-open is to never break the hook over probe noise.
    expect(isHostMemoryPressured(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('honors a custom floor when caller overrides it', () => {
    expect(isHostMemoryPressured(3 * 1024 * 1024 * 1024, 4 * 1024 * 1024 * 1024)).toBe(true);
    expect(isHostMemoryPressured(5 * 1024 * 1024 * 1024, 4 * 1024 * 1024 * 1024)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group D — Sanity: floor is exactly 2 GB (per BLOCKER-2 spec)
// ---------------------------------------------------------------------------

describe('host-ram: constants', () => {
  it('HOST_RAM_FLOOR_BYTES is 2 GB', () => {
    expect(HOST_RAM_FLOOR_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Group E — Env-var seams (operator + test overrides)
// ---------------------------------------------------------------------------

describe('host-ram: env-var overrides', () => {
  it('CCV3_HOST_RAM_OVERRIDE_BYTES short-circuits the probe', () => {
    process.env.CCV3_HOST_RAM_OVERRIDE_BYTES = String(1024 * 1024); // 1 MB
    // throwingSpawn would normally cause us to fail open to INFINITY; the
    // env override should beat that and return the requested value.
    const bytes = getFreeRamBytes(throwingSpawn(), throwingReadFile(), 'win32');
    expect(bytes).toBe(1024 * 1024);
  });

  it('CCV3_HOST_RAM_OVERRIDE_BYTES ignores non-numeric values (probe runs)', () => {
    process.env.CCV3_HOST_RAM_OVERRIDE_BYTES = 'garbage';
    const bytes = getFreeRamBytes(fakeSpawn('4194304\n'), fakeReadFile(''), 'win32');
    expect(bytes).toBe(4 * 1024 * 1024 * 1024); // probe ran
  });

  it('CCV3_HOST_RAM_OVERRIDE_BYTES ignores zero and negative (probe runs)', () => {
    process.env.CCV3_HOST_RAM_OVERRIDE_BYTES = '0';
    const bytes = getFreeRamBytes(fakeSpawn('4194304\n'), fakeReadFile(''), 'win32');
    expect(bytes).toBe(4 * 1024 * 1024 * 1024);
  });

  it('CCV3_HOST_RAM_FLOOR_BYTES raises the threshold', () => {
    process.env.CCV3_HOST_RAM_FLOOR_BYTES = String(8 * 1024 * 1024 * 1024); // 8 GB
    expect(getHostRamFloorBytes()).toBe(8 * 1024 * 1024 * 1024);
  });

  it('CCV3_HOST_RAM_FLOOR_BYTES falls back to default on garbage', () => {
    process.env.CCV3_HOST_RAM_FLOOR_BYTES = 'not a number';
    expect(getHostRamFloorBytes()).toBe(HOST_RAM_FLOOR_BYTES);
  });

  it('synthetic regression: override pressures the host', () => {
    // The exact synthetic regression from the BLOCKER-2 spec:
    //   "temporarily set HOST_RAM_FLOOR_BYTES to current free RAM × 2,
    //    fire a hook, verify text-only fallback"
    // We simulate by saying probe returns 4 GB, but the floor is 8 GB.
    process.env.CCV3_HOST_RAM_OVERRIDE_BYTES = String(4 * 1024 * 1024 * 1024);
    process.env.CCV3_HOST_RAM_FLOOR_BYTES = String(8 * 1024 * 1024 * 1024);
    const free = getFreeRamBytes();
    const floor = getHostRamFloorBytes();
    expect(isHostMemoryPressured(free, floor)).toBe(true);
  });
});
