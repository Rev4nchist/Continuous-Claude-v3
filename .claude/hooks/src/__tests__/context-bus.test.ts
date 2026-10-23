/**
 * Tests for the L2 Context Bus single-writer (WS-2 Phase A.1).
 *
 * The bus is one small JSON file per session at
 *   <projectDir>/.claude/cache/session/<bus_id>/context.json
 * Hooks (and only hooks) write it via the owner module; specialists read it.
 *
 * Contract under test (design doc sections 4.1/4.2/4.4 + plan A.1, gate section 3):
 *  - missing/unreadable file -> emptyBus (never throws)
 *  - mutate -> read round-trip
 *  - CAS on the monotone `revision`: a concurrent revision bump forces a retry,
 *    no lost update, revision strictly increases
 *  - CCV3_BUS_OFF=1 -> readBus returns emptyBus, mutateBus is a no-op
 *  - fail-open: an injected fs error -> emptyBus, never throws into the hot path
 *  - a read slower than 50ms emits a latency event to intel-bus and still returns
 *  - files_in_play ambient slice is capped at 30% of total slots
 *
 * Tests inject read/write/now/onLatency seams (host-ram.ts style) so behavior is
 * deterministic without mocking ESM fs. Runner is vitest; ASCII only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readBus,
  mutateBus,
  emptyBus,
  busPath,
  setIntent,
  addFocusSymbol,
  addFileInPlay,
  addRecentFinding,
  bumpTurn,
  AMBIENT_CAP_RATIO,
  AMBIENT_MIN_SLOTS,
  LOAD_BEARING_CAP,
  FOCUS_SYMBOLS_CAP,
  RECENT_FINDINGS_CAP,
  LATENCY_BUDGET_MS,
  type BusEntry,
} from '../shared/context-bus.js';

// ---------------------------------------------------------------------------
// An in-memory "disk" so injected read/write seams form a real round-trip.
// ---------------------------------------------------------------------------
function makeMemoryDisk(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  const read = (path: string): string | null => (store.has(path) ? store.get(path)! : null);
  const write = (path: string, content: string): void => {
    store.set(path, content);
  };
  return { store, read, write };
}

const BUS_ID = 'sess1-abcdef012345';

let savedEnv: Record<string, string | undefined>;
const ENV_KEYS = ['CLAUDE_PROJECT_DIR', 'CCV3_BUS_OFF'] as const;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CLAUDE_PROJECT_DIR = 'C:/tmp/proj';
  delete process.env.CCV3_BUS_OFF;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ---------------------------------------------------------------------------
// Path + emptyBus shape
// ---------------------------------------------------------------------------
describe('busPath', () => {
  it('resolves under <projectDir>/.claude/cache/session/<bus_id>/context.json', () => {
    const p = busPath(BUS_ID, 'C:/tmp/proj').replace(/\\/g, '/');
    expect(p).toBe(`C:/tmp/proj/.claude/cache/session/${BUS_ID}/context.json`);
  });

  it('throws on a traversal / invalid busId (single validation chokepoint, finding #3)', () => {
    for (const bad of ['..', '../escape', 'a/b', 'a\\b', '', '.', './x', 'foo/../bar']) {
      expect(() => busPath(bad, 'C:/tmp/proj')).toThrow();
    }
  });

  it('accepts a normal id that getBusId would emit', () => {
    expect(() => busPath('s-fixed1-abcdef012345', 'C:/tmp/proj')).not.toThrow();
  });
});

describe('emptyBus', () => {
  it('is schema_version 3, revision 0, with empty collections', () => {
    const b = emptyBus(BUS_ID);
    expect(b.schema_version).toBe(3);
    expect(b.revision).toBe(0);
    expect(b.bus_id).toBe(BUS_ID);
    expect(b.focus_symbols).toEqual([]);
    expect(b.recent_findings).toEqual([]);
    expect(b.open_threads).toEqual([]);
    expect(b.files_in_play.load_bearing).toEqual([]);
    expect(b.files_in_play.ambient).toEqual([]);
    expect(b.current_intent).toBeNull();
    expect(b.compact_generation).toBe(0);
    expect(b.current_turn).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readBus: empty on missing, round-trip
// ---------------------------------------------------------------------------
describe('readBus', () => {
  it('returns emptyBus when the file is missing', () => {
    const disk = makeMemoryDisk();
    const b = readBus(BUS_ID, { read: disk.read });
    expect(b.revision).toBe(0);
    expect(b.bus_id).toBe(BUS_ID);
    expect(b.focus_symbols).toEqual([]);
  });

  it('returns emptyBus (never throws) when the file is unparseable', () => {
    const path = busPath(BUS_ID, 'C:/tmp/proj');
    const disk = makeMemoryDisk({ [path]: '{ not json' });
    let b: BusEntry | undefined;
    expect(() => {
      b = readBus(BUS_ID, { read: disk.read });
    }).not.toThrow();
    expect(b!.revision).toBe(0);
  });

  it('re-reads disk on every call (no module cache)', () => {
    const disk = makeMemoryDisk();
    const first = readBus(BUS_ID, { read: disk.read });
    expect(first.current_intent).toBeNull();
    // mutate the underlying disk out-of-band
    const path = busPath(BUS_ID, 'C:/tmp/proj');
    const seeded = emptyBus(BUS_ID);
    seeded.current_intent = 'changed on disk';
    seeded.revision = 9;
    disk.store.set(path, JSON.stringify(seeded));
    const second = readBus(BUS_ID, { read: disk.read });
    expect(second.current_intent).toBe('changed on disk');
    expect(second.revision).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// mutateBus: round-trip + revision bump
// ---------------------------------------------------------------------------
describe('mutateBus -- basic round-trip', () => {
  it('applies fn, bumps revision, and the result is readable', () => {
    const disk = makeMemoryDisk();
    const opts = { read: disk.read, write: disk.write };
    const after = mutateBus(
      BUS_ID,
      (bus) => {
        bus.current_intent = 'tighten L0 gate';
      },
      opts,
    );
    expect(after.current_intent).toBe('tighten L0 gate');
    expect(after.revision).toBe(1);

    const reread = readBus(BUS_ID, { read: disk.read });
    expect(reread.current_intent).toBe('tighten L0 gate');
    expect(reread.revision).toBe(1);
  });

  it('bumps revision monotonically across sequential mutations', () => {
    const disk = makeMemoryDisk();
    const opts = { read: disk.read, write: disk.write };
    mutateBus(BUS_ID, (b) => void (b.current_intent = 'a'), opts);
    mutateBus(BUS_ID, (b) => void (b.current_intent = 'b'), opts);
    const third = mutateBus(BUS_ID, (b) => void (b.current_intent = 'c'), opts);
    expect(third.revision).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// CAS: concurrent revision bump -> stale write retries, no lost update
// ---------------------------------------------------------------------------
describe('mutateBus -- CAS on revision (concurrent writer)', () => {
  it('retries when the on-disk revision moves under it, with no lost update', () => {
    const disk = makeMemoryDisk();
    const path = busPath(BUS_ID, 'C:/tmp/proj');

    // Simulate a competing writer that commits exactly once, in the window
    // between our read and our write. It adds a finding and bumps revision.
    let interfered = false;
    const beforeWrite = () => {
      if (interfered) return;
      interfered = true;
      const competing = emptyBus(BUS_ID);
      competing.revision = 1; // competitor bumped 0 -> 1
      competing.recent_findings.push({
        correlation_id: 'competitor',
        tool: 'codegraph_callers',
        subject_id: 'scip:competitor',
        result_count: 1,
        rank: 1,
        ts: '2026-06-01T00:00:00.000Z',
      });
      disk.store.set(path, JSON.stringify(competing));
    };

    const after = mutateBus(
      BUS_ID,
      (bus) => {
        bus.current_intent = 'my intent';
      },
      { read: disk.read, write: disk.write, beforeWrite },
    );

    // Our write must have observed the competitor's revision and bumped past it.
    expect(after.revision).toBe(2);
    // Our own change is present.
    expect(after.current_intent).toBe('my intent');
    // The competitor's finding was NOT lost (we re-read its state on retry).
    expect(after.recent_findings.map((f) => f.correlation_id)).toContain('competitor');

    // Disk reflects the final, merged state.
    const reread = readBus(BUS_ID, { read: disk.read });
    expect(reread.revision).toBe(2);
    expect(reread.current_intent).toBe('my intent');
    expect(reread.recent_findings.map((f) => f.correlation_id)).toContain('competitor');
  });

  it('revision strictly increases and never decreases under contention', () => {
    const disk = makeMemoryDisk();
    const path = busPath(BUS_ID, 'C:/tmp/proj');
    // Seed disk at a high revision.
    const seeded = emptyBus(BUS_ID);
    seeded.revision = 41;
    disk.store.set(path, JSON.stringify(seeded));

    const after = mutateBus(BUS_ID, (b) => void (b.current_intent = 'x'), {
      read: disk.read,
      write: disk.write,
    });
    expect(after.revision).toBe(42);
    expect(after.revision).toBeGreaterThan(41);
  });

  it('gives up gracefully after the retry budget (still returns, never throws)', () => {
    const disk = makeMemoryDisk();
    const path = busPath(BUS_ID, 'C:/tmp/proj');
    // A pathological competitor that bumps revision on EVERY beforeWrite, so
    // CAS can never converge. mutateBus must bound its retries and still return
    // without throwing.
    let n = 100;
    const beforeWrite = () => {
      const competing = emptyBus(BUS_ID);
      competing.revision = ++n;
      disk.store.set(path, JSON.stringify(competing));
    };
    let result: BusEntry | undefined;
    expect(() => {
      result = mutateBus(BUS_ID, (b) => void (b.current_intent = 'never lands'), {
        read: disk.read,
        write: disk.write,
        beforeWrite,
      });
    }).not.toThrow();
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------
describe('CCV3_BUS_OFF kill switch', () => {
  it('readBus returns emptyBus without touching disk', () => {
    process.env.CCV3_BUS_OFF = '1';
    let read_called = false;
    const read = (_p: string) => {
      read_called = true;
      return '{"should":"not be read"}';
    };
    const b = readBus(BUS_ID, { read });
    expect(b.revision).toBe(0);
    expect(b.focus_symbols).toEqual([]);
    expect(read_called).toBe(false);
  });

  it('mutateBus is a no-op (no write) and returns emptyBus', () => {
    process.env.CCV3_BUS_OFF = '1';
    let write_called = false;
    const disk = makeMemoryDisk();
    const write = (p: string, c: string) => {
      write_called = true;
      disk.write(p, c);
    };
    const after = mutateBus(BUS_ID, (b) => void (b.current_intent = 'ignored'), {
      read: disk.read,
      write,
    });
    expect(write_called).toBe(false);
    expect(after.current_intent).toBeNull();
    expect(after.revision).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fail-open
// ---------------------------------------------------------------------------
describe('fail-open (never throws into the hot path)', () => {
  it('readBus returns emptyBus when the injected read throws', () => {
    const read = (_p: string): string | null => {
      throw new Error('EIO: simulated read failure');
    };
    let b: BusEntry | undefined;
    expect(() => {
      b = readBus(BUS_ID, { read });
    }).not.toThrow();
    expect(b!.revision).toBe(0);
    expect(b!.bus_id).toBe(BUS_ID);
  });

  it('mutateBus returns a best-effort bus when the injected write throws', () => {
    const disk = makeMemoryDisk();
    const write = (_p: string, _c: string): void => {
      throw new Error('EROFS: read-only file system');
    };
    let after: BusEntry | undefined;
    expect(() => {
      after = mutateBus(BUS_ID, (b) => void (b.current_intent = 'attempted'), {
        read: disk.read,
        write,
      });
    }).not.toThrow();
    expect(after).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 50ms latency instrument
// ---------------------------------------------------------------------------
describe('50ms read-latency instrument (finding #8)', () => {
  it('emits a latency event to intel-bus when a read exceeds the budget', () => {
    const disk = makeMemoryDisk();
    // A clock that jumps past the budget between start and end of the read.
    let t = 1000;
    const ticks = [1000, 1000 + LATENCY_BUDGET_MS + 25];
    let i = 0;
    const now = () => {
      const v = ticks[Math.min(i, ticks.length - 1)];
      i += 1;
      return v;
    };
    void t;
    const events: unknown[] = [];
    const onLatency = (e: unknown) => {
      events.push(e);
    };
    const b = readBus(BUS_ID, { read: disk.read, now, onLatency });
    // Still returns a valid (empty) bus.
    expect(b.revision).toBe(0);
    // A latency event was recorded.
    expect(events.length).toBe(1);
    const ev = events[0] as Record<string, unknown>;
    expect(ev.query_type).toBe('bus_read_latency');
    expect(typeof ev.duration_ms).toBe('number');
    expect(ev.duration_ms as number).toBeGreaterThanOrEqual(LATENCY_BUDGET_MS);
  });

  it('does NOT emit a latency event for a fast read', () => {
    const disk = makeMemoryDisk();
    let i = 0;
    const ticks = [2000, 2001];
    const now = () => ticks[Math.min(i++, ticks.length - 1)];
    const events: unknown[] = [];
    const onLatency = (e: unknown) => void events.push(e);
    readBus(BUS_ID, { read: disk.read, now, onLatency });
    expect(events.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Typed helpers + ambient 30% cap
// ---------------------------------------------------------------------------
describe('typed helpers', () => {
  it('setIntent sets current_intent', () => {
    const b = emptyBus(BUS_ID);
    setIntent(b, 'do the thing');
    expect(b.current_intent).toBe('do the thing');
  });

  it('addFocusSymbol appends a symbol entry', () => {
    const b = emptyBus(BUS_ID);
    addFocusSymbol(b, {
      id: {
        git_sha: 'ed7a3c4f0218',
        file_uri: 'file:///c/Users/x/store_learning.py',
        lang: 'python',
        container: 'store_learning',
        name: 'validate_learning_quality',
        signature_hash: '9a3b1f8c',
      },
      turn_added: 14,
    });
    expect(b.focus_symbols).toHaveLength(1);
    expect(b.focus_symbols[0].id.name).toBe('validate_learning_quality');
  });

  it('addRecentFinding appends a finding entry', () => {
    const b = emptyBus(BUS_ID);
    addRecentFinding(b, {
      correlation_id: 'f-7c2e',
      tool: 'codegraph_callers',
      subject_id: 'scip:abc',
      result_count: 7,
      rank: 1,
      ts: '2026-06-01T00:00:00.000Z',
    });
    expect(b.recent_findings).toHaveLength(1);
    expect(b.recent_findings[0].correlation_id).toBe('f-7c2e');
  });
});

describe('addFileInPlay -- load_bearing vs ambient + 30% cap', () => {
  it('routes a load-bearing role into the load_bearing slice', () => {
    const b = emptyBus(BUS_ID);
    addFileInPlay(b, { path: 'src/a.py', role: 'edited', turn_added: 1 });
    expect(b.files_in_play.load_bearing).toHaveLength(1);
    expect(b.files_in_play.ambient).toHaveLength(0);
  });

  it('routes an ambient role into the ambient slice', () => {
    const b = emptyBus(BUS_ID);
    addFileInPlay(b, { path: 'docs/x.md', role: 'doc_read', turn_added: 1 });
    expect(b.files_in_play.ambient).toHaveLength(1);
    expect(b.files_in_play.load_bearing).toHaveLength(0);
  });

  it('caps ambient entries at 30% of total slots', () => {
    const b = emptyBus(BUS_ID);
    // 7 load-bearing files.
    for (let k = 0; k < 7; k++) {
      addFileInPlay(b, { path: `src/lb${k}.py`, role: 'edited', turn_added: k });
    }
    // Try to add many ambient files; only ~30% of total slots may be ambient.
    for (let k = 0; k < 20; k++) {
      addFileInPlay(b, { path: `docs/amb${k}.md`, role: 'doc_read', turn_added: k });
    }
    const lb = b.files_in_play.load_bearing.length;
    const amb = b.files_in_play.ambient.length;
    const total = lb + amb;
    expect(amb / total).toBeLessThanOrEqual(AMBIENT_CAP_RATIO + 1e-9);
    // Load-bearing entries are never evicted by ambient pressure.
    expect(lb).toBe(7);
  });

  it('admits up to the ambient floor when there are zero load-bearing files', () => {
    const b = emptyBus(BUS_ID);
    for (let k = 0; k < 10; k++) {
      addFileInPlay(b, { path: `docs/only${k}.md`, role: 'doc_read', turn_added: k });
    }
    // The 30% cap is meant to stop ambient FLOODING OUT load-bearing context,
    // not to forbid ambient on a near-empty bus. With no load-bearing anchors,
    // ambient settles at the floor (a few slots), never unbounded.
    const amb = b.files_in_play.ambient.length;
    expect(amb).toBe(AMBIENT_MIN_SLOTS);
    expect(amb).toBeLessThan(10); // far below the number we tried to add
  });
});

// ---------------------------------------------------------------------------
// Bounded growth (cross-model review F3): the bus JSON is rewritten on every
// mutateBus call, so the writer slices must not grow without bound over a long
// session. load_bearing dedups by (path, role) + caps; focus/findings are FIFO.
// ---------------------------------------------------------------------------
describe('bus arrays stay bounded (review F3)', () => {
  it('addFileInPlay DEDUPs load_bearing by (path, role), refreshing turn_added', () => {
    const b = emptyBus(BUS_ID);
    addFileInPlay(b, { path: 'src/a.ts', role: 'edited', turn_added: 1 });
    addFileInPlay(b, { path: 'src/a.ts', role: 'edited', turn_added: 5 });
    expect(b.files_in_play.load_bearing).toHaveLength(1);
    expect(b.files_in_play.load_bearing[0].turn_added).toBe(5);
  });

  it('addFileInPlay keeps a DIFFERENT role on the same path as a separate entry', () => {
    const b = emptyBus(BUS_ID);
    addFileInPlay(b, { path: 'src/a.ts', role: 'edited', turn_added: 1 });
    addFileInPlay(b, { path: 'src/a.ts', role: 'user_mentioned', turn_added: 1 });
    expect(b.files_in_play.load_bearing).toHaveLength(2);
  });

  it('addFileInPlay CAPS load_bearing at LOAD_BEARING_CAP, evicting the oldest turn', () => {
    const b = emptyBus(BUS_ID);
    for (let k = 0; k < LOAD_BEARING_CAP + 5; k++) {
      addFileInPlay(b, { path: `src/f${k}.ts`, role: 'edited', turn_added: k });
    }
    const lb = b.files_in_play.load_bearing;
    expect(lb).toHaveLength(LOAD_BEARING_CAP);
    // The 5 oldest (turn_added 0..4) were evicted; min surviving turn is 5.
    expect(Math.min(...lb.map((f) => f.turn_added))).toBe(5);
  });

  it('addFocusSymbol caps focus_symbols at FOCUS_SYMBOLS_CAP (FIFO)', () => {
    const b = emptyBus(BUS_ID);
    for (let k = 0; k < FOCUS_SYMBOLS_CAP + 3; k++) {
      addFocusSymbol(b, { id: { file_uri: `src/f${k}.ts`, lang: 'ts', name: `fn${k}` }, turn_added: k });
    }
    expect(b.focus_symbols).toHaveLength(FOCUS_SYMBOLS_CAP);
    expect(b.focus_symbols[0].id.name).toBe('fn3'); // earliest 3 dropped
  });

  it('addRecentFinding caps recent_findings at RECENT_FINDINGS_CAP (FIFO)', () => {
    const b = emptyBus(BUS_ID);
    for (let k = 0; k < RECENT_FINDINGS_CAP + 3; k++) {
      addRecentFinding(b, {
        correlation_id: `c${k}`, tool: 'grep', subject_id: `s${k}`,
        result_count: 1, rank: 1, ts: '2026-06-02T00:00:00.000Z',
      });
    }
    expect(b.recent_findings).toHaveLength(RECENT_FINDINGS_CAP);
    expect(b.recent_findings[0].correlation_id).toBe('c3');
  });
});

// ---------------------------------------------------------------------------
// coerceBus enforces the array caps on the READ path too (session-3 Retired#5 /
// critic F5). The per-write helpers cap their slices, but bumpTurn/setIntent
// re-serialize the whole bus WITHOUT going through them -- so a file that arrived
// already bloated (older version, external writer) must be trimmed at coerce time
// or it grows unbounded on every turn-bump (the write-slowdown feedback loop).
// ---------------------------------------------------------------------------
describe('coerceBus enforces caps on a bloated file (read path)', () => {
  function bloatedBusJson(): string {
    const focus = Array.from({ length: FOCUS_SYMBOLS_CAP + 40 }, (_, i) => ({
      scip_id: `sym${i}`, name: `sym${i}`, kind: 'function', turn_added: i,
    }));
    const findings = Array.from({ length: RECENT_FINDINGS_CAP + 40 }, (_, i) => ({
      correlation_id: `c${i}`, tool: 'grep', subject_id: `s${i}`,
      result_count: 1, rank: 1, ts: '2026-06-02T00:00:00.000Z',
    }));
    const lb = Array.from({ length: LOAD_BEARING_CAP + 40 }, (_, i) => ({
      path: `lb${i}.ts`, role: 'edited', turn_added: i,
    }));
    const amb = Array.from({ length: 200 }, (_, i) => ({
      path: `amb${i}.ts`, role: 'read_for_context', turn_added: i,
    }));
    return JSON.stringify({
      bus_id: BUS_ID, schema_version: 3, revision: 1, current_turn: 1,
      current_intent: null, focus_symbols: focus, recent_findings: findings,
      open_threads: [], files_in_play: { load_bearing: lb, ambient: amb },
    });
  }

  it('readBus trims every over-cap array to within its cap', () => {
    const disk = makeMemoryDisk({ [busPath(BUS_ID)]: bloatedBusJson() });
    const b = readBus(BUS_ID, { read: disk.read });
    expect(b.focus_symbols.length).toBeLessThanOrEqual(FOCUS_SYMBOLS_CAP);
    expect(b.recent_findings.length).toBeLessThanOrEqual(RECENT_FINDINGS_CAP);
    expect(b.files_in_play.load_bearing.length).toBeLessThanOrEqual(LOAD_BEARING_CAP);
    // ambient is bounded by the same cap ceiling (kept from growing without bound)
    expect(b.files_in_play.ambient.length).toBeLessThanOrEqual(LOAD_BEARING_CAP);
  });

  it('a turn-bump on a bloated file persists a trimmed bus (no unbounded growth)', () => {
    const disk = makeMemoryDisk({ [busPath(BUS_ID)]: bloatedBusJson() });
    mutateBus(BUS_ID, (b) => bumpTurn(b), { read: disk.read, write: disk.write });
    const reread = readBus(BUS_ID, { read: disk.read });
    expect(reread.focus_symbols.length).toBeLessThanOrEqual(FOCUS_SYMBOLS_CAP);
    expect(reread.files_in_play.load_bearing.length).toBeLessThanOrEqual(LOAD_BEARING_CAP);
  });
});

// ---------------------------------------------------------------------------
// current_turn -- the per-turn staleness counter (WS-2 Phase B.4a).
// The bus READ is at UserPromptSubmit but WRITES land at PostToolUse, so the
// reader needs a turn counter to compute how stale focus/files are. Cover:
// emptyBus starts at 0; coerceBus (via the read path) defaults a missing/garbage
// value to 0 and preserves a valid one; bumpTurn increments (and coalesces a
// legacy bus); and a mutateBus(id, bumpTurn) persists current_turn across a read.
// ---------------------------------------------------------------------------
describe('current_turn counter (Phase B.4a)', () => {
  it('emptyBus starts current_turn at 0', () => {
    expect(emptyBus(BUS_ID).current_turn).toBe(0);
  });

  it('bumpTurn increments the counter', () => {
    const b = emptyBus(BUS_ID);
    bumpTurn(b);
    expect(b.current_turn).toBe(1);
    bumpTurn(b);
    bumpTurn(b);
    expect(b.current_turn).toBe(3);
  });

  it('bumpTurn coalesces a missing counter on a legacy bus (undefined -> 1)', () => {
    // A bus persisted before this schema field existed has no current_turn.
    const legacy = emptyBus(BUS_ID) as Partial<BusEntry> as BusEntry;
    delete (legacy as { current_turn?: number }).current_turn;
    bumpTurn(legacy);
    expect(legacy.current_turn).toBe(1);
  });

  it('coerceBus (read path) defaults a MISSING current_turn to 0', () => {
    // Seed disk with a bus object that omits current_turn entirely.
    const path = busPath(BUS_ID, 'C:/tmp/proj');
    const seeded = emptyBus(BUS_ID) as Partial<BusEntry>;
    delete (seeded as { current_turn?: number }).current_turn;
    const disk = makeMemoryDisk({ [path]: JSON.stringify(seeded) });
    const b = readBus(BUS_ID, { read: disk.read });
    expect(b.current_turn).toBe(0);
  });

  it('coerceBus (read path) defaults a GARBAGE current_turn to 0', () => {
    const path = busPath(BUS_ID, 'C:/tmp/proj');
    // current_turn set to a non-finite / non-number value on disk.
    const raw = JSON.stringify({ ...emptyBus(BUS_ID), current_turn: 'not-a-number' });
    const disk = makeMemoryDisk({ [path]: raw });
    const b = readBus(BUS_ID, { read: disk.read });
    expect(b.current_turn).toBe(0);
  });

  it('coerceBus (read path) PRESERVES a valid current_turn', () => {
    const path = busPath(BUS_ID, 'C:/tmp/proj');
    const seeded = emptyBus(BUS_ID);
    seeded.current_turn = 7;
    const disk = makeMemoryDisk({ [path]: JSON.stringify(seeded) });
    const b = readBus(BUS_ID, { read: disk.read });
    expect(b.current_turn).toBe(7);
  });

  it('mutateBus(id, bumpTurn) persists current_turn across a read', () => {
    const disk = makeMemoryDisk();
    const opts = { read: disk.read, write: disk.write };
    const after = mutateBus(BUS_ID, bumpTurn, opts);
    expect(after.current_turn).toBe(1);
    // A subsequent read sees the persisted counter, not a reset.
    const reread = readBus(BUS_ID, { read: disk.read });
    expect(reread.current_turn).toBe(1);
    // And a second mutate keeps incrementing on top of the persisted value.
    const after2 = mutateBus(BUS_ID, bumpTurn, opts);
    expect(after2.current_turn).toBe(2);
    expect(readBus(BUS_ID, { read: disk.read }).current_turn).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// FINDING 2 (Retired): mutateBus must NOT erase valid state on a transient read
// failure. A genuinely-absent file (ENOENT) -> empty bus -> write rev 1 is fine;
// but a file that EXISTS yet fails to read (EBUSY/EACCES/EPERM) or fails to
// parse must NEVER be overwritten with empty-derived state.
// ---------------------------------------------------------------------------
describe('mutateBus -- transient read failure must not erase valid state (finding #2)', () => {
  const path = busPath(BUS_ID, 'C:/tmp/proj');

  function busyError(code: string): Error {
    const e = new Error(`${code}: simulated transient lock`) as Error & { code: string };
    e.code = code;
    return e;
  }

  it('does NOT write when the existing file fails to read with EBUSY (no clobber)', () => {
    // Seed a real, non-empty bus on disk.
    const disk = makeMemoryDisk();
    const seeded = emptyBus(BUS_ID);
    seeded.current_intent = 'precious state';
    seeded.revision = 7;
    disk.store.set(path, JSON.stringify(seeded));

    // A read seam that throws EBUSY (Windows transient file lock) on EVERY read.
    const read = (_p: string): string | null => {
      throw busyError('EBUSY');
    };
    let writeCalled = false;
    const write = (p: string, c: string): void => {
      writeCalled = true;
      disk.store.set(p, c);
    };

    let after: BusEntry | undefined;
    expect(() => {
      after = mutateBus(BUS_ID, (b) => void (b.current_intent = 'attempted overwrite'), {
        read,
        write,
      });
    }).not.toThrow();

    // The transient failure must NOT have persisted empty-derived state.
    expect(writeCalled).toBe(false);
    // The precious on-disk state is intact (real read, no injected error).
    const onDisk = JSON.parse(disk.store.get(path)!);
    expect(onDisk.current_intent).toBe('precious state');
    expect(onDisk.revision).toBe(7);
    // The returned bus must NOT claim to have erased+bumped (defense-in-depth).
    expect(after).toBeDefined();
  });

  it('does NOT write when a NON-empty existing file fails to PARSE (no clobber)', () => {
    // A non-empty but corrupt file that exists. This is a transient parse race,
    // NOT a genuinely-absent file -> mutateBus must not overwrite it with empty.
    const disk = makeMemoryDisk({ [path]: '{ this is not valid json and is non-empty' });
    let writeCalled = false;
    const write = (p: string, c: string): void => {
      writeCalled = true;
      disk.store.set(p, c);
    };
    let after: BusEntry | undefined;
    expect(() => {
      after = mutateBus(BUS_ID, (b) => void (b.current_intent = 'attempted'), {
        read: disk.read,
        write,
      });
    }).not.toThrow();
    expect(writeCalled).toBe(false);
    // The corrupt-but-present bytes are left untouched for a later recovery.
    expect(disk.store.get(path)).toBe('{ this is not valid json and is non-empty');
    expect(after).toBeDefined();
  });

  it('DOES write rev 1 for a genuinely-absent file (ENOENT is the empty case)', () => {
    // Contrast: a truly-missing file (read returns null) is the legitimate empty
    // case -> mutateBus writes revision 1. This proves the fix distinguishes
    // ENOENT (null) from a read/parse FAILURE of a file that exists.
    const disk = makeMemoryDisk();
    const after = mutateBus(BUS_ID, (b) => void (b.current_intent = 'fresh'), {
      read: disk.read,
      write: disk.write,
    });
    expect(after.current_intent).toBe('fresh');
    expect(after.revision).toBe(1);
    expect(disk.store.has(path)).toBe(true);
  });

  it('does NOT erase even when only the FIRST read fails then later reads would succeed', () => {
    // A read that fails EACCES the first time (mutateBus must bail safely on that
    // transient failure rather than fall through to writing empty-derived state).
    const disk = makeMemoryDisk();
    const seeded = emptyBus(BUS_ID);
    seeded.current_intent = 'keep me';
    seeded.revision = 4;
    disk.store.set(path, JSON.stringify(seeded));

    let reads = 0;
    const read = (p: string): string | null => {
      reads += 1;
      if (reads === 1) {
        const e = new Error('EACCES: simulated') as Error & { code: string };
        e.code = 'EACCES';
        throw e;
      }
      return disk.read(p);
    };
    let writeCalled = false;
    const write = (p: string, c: string): void => {
      writeCalled = true;
      disk.store.set(p, c);
    };
    mutateBus(BUS_ID, (b) => void (b.current_intent = 'overwrite'), { read, write });
    // No empty-derived clobber on the transient failure.
    expect(writeCalled).toBe(false);
    expect(JSON.parse(disk.store.get(path)!).current_intent).toBe('keep me');
  });
});

// ---------------------------------------------------------------------------
// FINDING 3 (Retired): path-traversal via busId. busPath/readBus/mutateBus must
// validate busId against a strict directory-name pattern and assert the resolved
// path stays under the session-cache root. Invalid ids fail SAFE: readBus ->
// emptyBus, mutateBus -> no-op, and NOTHING is read or written.
// ---------------------------------------------------------------------------
describe('busId validation -- path traversal is rejected (finding #3)', () => {
  const BAD_IDS = ['..', '../escape', '../../etc', 'a/b', 'a\\b', '', '.', './x', 'foo/../bar'];

  it('readBus returns emptyBus and never touches the read seam for a bad busId', () => {
    for (const bad of BAD_IDS) {
      let readCalled = false;
      const read = (_p: string): string | null => {
        readCalled = true;
        return '{"revision":99}';
      };
      const b = readBus(bad, { read });
      expect(b.revision).toBe(0); // emptyBus
      expect(b.focus_symbols).toEqual([]);
      expect(readCalled).toBe(false); // fail-safe: filesystem never touched
    }
  });

  it('mutateBus is a no-op and never touches read/write seams for a bad busId', () => {
    for (const bad of BAD_IDS) {
      let readCalled = false;
      let writeCalled = false;
      const read = (_p: string): string | null => {
        readCalled = true;
        return null;
      };
      const write = (_p: string, _c: string): void => {
        writeCalled = true;
      };
      const after = mutateBus(bad, (b) => void (b.current_intent = 'should not persist'), {
        read,
        write,
      });
      expect(writeCalled).toBe(false);
      expect(readCalled).toBe(false);
      // Returns a harmless empty bus, never throws.
      expect(after.current_intent).toBeNull();
      expect(after.revision).toBe(0);
    }
  });

  it('no file is created OUTSIDE the session-cache root for a traversal busId (real disk)', () => {
    // Use a real temp project dir and the REAL default write seam. A traversal
    // id must not escape <projectDir>/.claude/cache/session. We assert the
    // sentinel escape target is never created.
    const proj = mkdtempSync(join(tmpdir(), 'ccv3-trav-'));
    try {
      // ".." would resolve to <projectDir>/.claude/cache (one level up from the
      // per-session dir) -> a context.json there would be the escape artifact.
      const escapeArtifact = join(proj, '.claude', 'cache', 'context.json');
      const after = mutateBus(
        '..',
        (b) => void (b.current_intent = 'escape attempt'),
        { projectDir: proj },
      );
      expect(existsSync(escapeArtifact)).toBe(false);
      expect(after.current_intent).toBeNull(); // no-op
    } finally {
      try {
        rmSync(proj, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('accepts a normal, safe busId (regression guard for the validator)', () => {
    // The real getBusId() output shape `<sessionId>-<hash>` must still pass.
    const goodId = 's-fixed1-abcdef012345';
    const goodPath = busPath(goodId, 'C:/tmp/proj');
    const disk = makeMemoryDisk();
    const after = mutateBus(goodId, (b) => void (b.current_intent = 'ok'), {
      read: disk.read,
      write: disk.write,
    });
    expect(after.current_intent).toBe('ok');
    expect(after.revision).toBe(1);
    expect(disk.store.has(goodPath)).toBe(true);
  });
});
