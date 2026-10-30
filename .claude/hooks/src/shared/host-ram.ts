/**
 * Host memory pressure probe.
 *
 * Returns the amount of free physical RAM in bytes so callers can decide
 * whether to skip expensive in-process work (e.g., embedding/recall) and
 * fall back to a cheaper code path.
 *
 * Why this exists (memory-system-next-steps-2026-05-21, BLOCKER-2):
 *   The 2026-05-20 RED incident (52% db_subprocess_timed_out, 86%
 *   kept_after_floor:0) was driven by host RAM dropping to ~0.3 GB free.
 *   The BGE-large model (1.5 GB resident) got paged out, every recall paid
 *   ~10x warm latency on major page faults, and the 12s hook ceiling blew.
 *   Symptoms were diffuse (recall returning empty) so root-cause took hours.
 *   This probe lets the hook detect the pressure mode up front, force a
 *   text-only fallback (fast, no daemon), and log a clear reason so future
 *   triage doesn't repeat the diagnosis.
 *
 * Design:
 *   * Fail-open: any probe failure returns Number.POSITIVE_INFINITY so the
 *     caller treats RAM as plentiful and proceeds with the normal path. We
 *     never want this defensive probe to become a load-bearing dependency
 *     that can take memory recall offline.
 *   * Bounded: PowerShell probe is timed out at PROBE_TIMEOUT_MS to avoid
 *     burning the hook budget on a stuck shell.
 *   * Dependency-injectable: helpers accept optional spawn/read functions so
 *     vitest can exercise all branches without real OS calls.
 *
 * The 2 GB floor is the operating threshold from the 2026-05-20 incident
 * runbook (docs/memory-system-audit-followup-2026-05-21.md). Below it, the
 * BGE-large model competes with browser/Docker for RAM and the daemon hot
 * path degrades; above it, hot encodes hit the ~30-100ms target.
 */

import { spawnSync as defaultSpawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'child_process';
import { readFileSync as defaultReadFileSync } from 'fs';
import { freemem as defaultFreemem } from 'os';

/**
 * Free-RAM floor in bytes (2 GB). Below this, recommend text-only fallback.
 *
 * Operator override: set `CCV3_HOST_RAM_FLOOR_BYTES=<bytes>` in the env to
 * raise (or lower) the threshold without rebuilding. Useful for the synthetic
 * regression check called out in the BLOCKER-2 spec — set it to
 * `(current free RAM) * 2` and fire a hook to verify the fallback path.
 */
export const HOST_RAM_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Read the floor from env at call time. Done lazily (per call) rather than
 * baked into a module-level constant so tests and operators can tweak it
 * between invocations without re-importing the module.
 */
export function getHostRamFloorBytes(): number {
  const raw = process.env.CCV3_HOST_RAM_FLOOR_BYTES;
  if (!raw) return HOST_RAM_FLOOR_BYTES;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return HOST_RAM_FLOOR_BYTES;
  return parsed;
}

/**
 * Probe timeout in ms. PowerShell spin-up on Windows is ~200-400ms cold;
 * 1500ms is generous slack for a stressed host without blowing the hook
 * budget. POSIX /proc/meminfo read has no timeout (synchronous file read).
 */
const PROBE_TIMEOUT_MS = 1500;

/**
 * Minimal subset of spawnSync we depend on, so callers can pass a mock.
 * Mirrors `child_process.spawnSync` signature shape; we only care about
 * the `stdout` field of the return value.
 */
type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options?: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer | string>;

type ReadFileFn = (path: string, encoding: BufferEncoding) => string;

/**
 * Return free physical RAM in bytes, or Number.POSITIVE_INFINITY on probe
 * failure (fail-open).
 *
 * Windows:  reads `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory`
 *           via PowerShell. The result is in KB, multiplied by 1024 to bytes.
 * POSIX:    parses `MemAvailable:` from `/proc/meminfo`. This is the value
 *           glibc / sysstat tools use for "free for new allocations" — it
 *           accounts for reclaimable page cache, unlike `MemFree:`.
 *
 * @param spawnFn  Optional spawnSync replacement (for tests).
 * @param readFileFn  Optional readFileSync replacement (for tests).
 * @param platform  Optional platform override (for tests). Defaults to
 *                  `process.platform`.
 */
export function getFreeRamBytes(
  spawnFn: SpawnSyncFn = defaultSpawnSync,
  readFileFn: ReadFileFn = defaultReadFileSync as ReadFileFn,
  platform: NodeJS.Platform = process.platform,
): number {
  // Test/operator seam: short-circuit the real probe by setting
  // `CCV3_HOST_RAM_OVERRIDE_BYTES=<bytes>` in the env. Anything non-numeric
  // or non-positive is ignored so a stray env var doesn't accidentally
  // disable the probe.
  const override = process.env.CCV3_HOST_RAM_OVERRIDE_BYTES;
  if (override) {
    const parsed = parseInt(override, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }

  try {
    if (platform === 'win32') {
      const result = spawnFn(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory',
        ],
        { timeout: PROBE_TIMEOUT_MS, encoding: 'utf-8' },
      );
      const out = typeof result.stdout === 'string'
        ? result.stdout
        : (result.stdout?.toString('utf-8') ?? '');
      const kb = parseInt(out.trim(), 10);
      if (Number.isNaN(kb) || kb <= 0) {
        return Number.POSITIVE_INFINITY;
      }
      return kb * 1024;
    }

    // POSIX path: /proc/meminfo. MemAvailable is in kB.
    const meminfo = readFileFn('/proc/meminfo', 'utf-8');
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!match) {
      return Number.POSITIVE_INFINITY;
    }
    const kb = parseInt(match[1], 10);
    if (Number.isNaN(kb) || kb <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return kb * 1024;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Free physical RAM for callers that must not block the event loop (the merged
 * prompt-submit process runs five jobs on one loop).
 *
 * getFreeRamBytes() spawns PowerShell on Windows: ~570 ms of blocked loop per call,
 * measured 2026-10-29. This returns the same number without a child process.
 * os.freemem() on Windows is GlobalMemoryStatusEx ullAvailPhys, which is what
 * Win32_OperatingSystem.FreePhysicalMemory reports; measured on this host the two
 * differ by 0.1-0.2 percent. On POSIX it is the same /proc/meminfo path as the sync
 * version. The override env var and the fail-open rule are unchanged.
 */
export function getFreeRamBytesNoSpawn(
  freememFn: () => number = defaultFreemem,
  readFileFn: ReadFileFn = defaultReadFileSync as ReadFileFn,
  platform: NodeJS.Platform = process.platform,
): number {
  if (platform !== 'win32') {
    return getFreeRamBytes(defaultSpawnSync, readFileFn, platform);
  }
  const override = process.env.CCV3_HOST_RAM_OVERRIDE_BYTES;
  if (override) {
    const parsed = parseInt(override, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  try {
    const bytes = freememFn();
    return Number.isFinite(bytes) && bytes > 0 ? bytes : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Convenience: returns `true` when free RAM is below the floor. Encodes the
 * "should we fall back?" decision in one place so callers don't accidentally
 * use different thresholds.
 */
export function isHostMemoryPressured(
  freeRamBytes: number = getFreeRamBytes(),
  floor: number = getHostRamFloorBytes(),
): boolean {
  return freeRamBytes < floor;
}
