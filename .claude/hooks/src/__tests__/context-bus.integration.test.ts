/**
 * Real-path integration smoke for the L2 context bus (WS-2 Phase A gate,
 * finding #14 "fresh-session smoke").
 *
 * The unit tests in context-bus.test.ts inject in-memory read/write seams for
 * determinism; THIS test deliberately uses the REAL default seams to exercise
 * the full path end to end:
 *   getBusId() -> busPath() -> mkdirSync -> writeStateWithLock -> readFileSync
 * against a throwaway temp CLAUDE_PROJECT_DIR. It proves a fresh session creates
 * a valid bus file at the expected location and that CCV3_BUS_OFF fully disables
 * persistence. ASCII only; vitest.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mutateBus, readBus, busPath, setIntent } from '../shared/context-bus.js';
import { getBusId } from '../shared/session-bus-id.js';

let tmp: string;
const SAVE = ['CLAUDE_PROJECT_DIR', 'CCV3_BUS_OFF', 'COORDINATION_SESSION_ID'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of SAVE) saved[k] = process.env[k];
  // Pin the session signal so getBusId() is stable and never touches the real
  // persisted ~/.claude coordination file.
  process.env.COORDINATION_SESSION_ID = 'smoke-sess';
  delete process.env.CCV3_BUS_OFF;
  tmp = mkdtempSync(join(tmpdir(), 'ccv3-bus-'));
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
    /* best-effort cleanup */
  }
});

describe('context-bus real-path integration (fresh-session smoke)', () => {
  it('mutateBus creates a valid bus file at the default path and readBus round-trips', () => {
    // Nothing on disk yet.
    expect(readBus().revision).toBe(0);

    const after = mutateBus(undefined, (b) => setIntent(b, 'phase-a smoke'));
    expect(after.current_intent).toBe('phase-a smoke');
    expect(after.revision).toBe(1);

    // The file exists at the REAL computed path, under the temp project dir.
    const path = busPath(getBusId());
    expect(path.replace(/\\/g, '/')).toContain('/.claude/cache/session/');
    expect(existsSync(path)).toBe(true);

    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    expect(onDisk.schema_version).toBe(3);
    expect(onDisk.current_intent).toBe('phase-a smoke');
    expect(onDisk.revision).toBe(1);

    // Real-disk re-read round-trips.
    const reread = readBus();
    expect(reread.current_intent).toBe('phase-a smoke');
    expect(reread.revision).toBe(1);
  });

  it('CCV3_BUS_OFF disables real persistence (no file) and reads return emptyBus', () => {
    process.env.CCV3_BUS_OFF = '1';
    const after = mutateBus(undefined, (b) => setIntent(b, 'should not persist'));
    expect(after.current_intent).toBeNull();
    expect(existsSync(busPath(getBusId()))).toBe(false);
    expect(readBus().revision).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FINDING 1 (HIGH, critic C-1): the read->apply->write must be ATOMIC
// under ONE lock hold, so a competitor that commits in the read/write window is
// not lost. This drives the REAL default write path (which now flows through
// mutateStateWithLock). We inject ONLY a `read` seam that, on the victim's
// FIRST read, writes a competitor's update straight to the real file; the
// victim's own write goes through the real lock-backed primitive, which must
// re-read the competitor's bytes under the lock and merge rather than clobber.
// ---------------------------------------------------------------------------
describe('context-bus atomic mutate (finding #1: no lost update under contention)', () => {
  it('does not lose a competitor write that lands during the victim read window', () => {
    const id = getBusId();
    const path = busPath(id);

    let interfered = false;
    // A read seam that performs the REAL read, but the first time it is called
    // it first slips a competitor commit onto the real file (revision 1 + a
    // finding). The lock-backed write must observe and preserve it.
    const read = (p: string): string | null => {
      if (!interfered) {
        interfered = true;
        const competing = {
          bus_id: id,
          current_intent: null,
          focus_symbols: [],
          files_in_play: { load_bearing: [], ambient: [] },
          recent_findings: [
            {
              correlation_id: 'competitor',
              tool: 'codegraph_callers',
              subject_id: 'scip:competitor',
              result_count: 1,
              rank: 1,
              ts: '2026-06-01T00:00:00.000Z',
            },
          ],
          open_threads: [],
          schema_version: 3,
          compact_generation: 0,
          revision: 1,
        };
        // Ensure the directory exists (mutateBus would create it for its own
        // write, but the competitor writes first).
        writeFileSync(path, JSON.stringify(competing), 'utf-8');
      }
      try {
        return readFileSync(p, 'utf-8');
      } catch {
        return null;
      }
    };

    const after = mutateBus(id, (b) => setIntent(b, 'victim intent'), { read });

    // Victim landed its change AND preserved the competitor's finding.
    expect(after.current_intent).toBe('victim intent');
    expect(after.recent_findings.map((f) => f.correlation_id)).toContain('competitor');
    // Revision strictly advanced past the competitor's.
    expect(after.revision).toBeGreaterThanOrEqual(2);

    // The real file on disk reflects the merged, non-lossy state.
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    expect(onDisk.current_intent).toBe('victim intent');
    expect(onDisk.recent_findings.map((f: { correlation_id: string }) => f.correlation_id)).toContain(
      'competitor',
    );
  });

  it('two sequential real mutations compose (0 -> 1 -> 2) with no lost update', () => {
    mutateBus(undefined, (b) => setIntent(b, 'first'));
    const second = mutateBus(undefined, (b) => {
      b.compact_generation += 1;
    });
    expect(second.revision).toBe(2);
    expect(second.current_intent).toBe('first'); // first write not lost
    expect(second.compact_generation).toBe(1);
  });
});
