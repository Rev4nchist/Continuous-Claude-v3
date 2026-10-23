/**
 * L2 Context Bus single-writer (WS-2 Phase A.1).
 *
 * One small JSON file per session at:
 *   <projectDir>/.claude/cache/session/<bus_id>/context.json
 * where projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd() and the
 * default bus_id comes from shared/session-bus-id.ts getBusId(). NOTE: the bus
 * lives under the PROJECT dir (not home), so there is no home-resolution trap.
 *
 * Hooks (and only hooks) write the bus via this owner module; L3 specialists
 * read it to bias queries. This is the only sanctioned writer -- there is no
 * direct fs.writeFileSync to the bus path anywhere else.
 *
 * Schema: BusEntry v3 verbatim from the design doc section 4.1 (SCIP-style
 * focus_symbols[].id, ranks_by_source, stale_check, the 8-role files_in_play
 * taxonomy with a 30% ambient cap, recent_findings, open_threads,
 * schema_version=3, compact_generation, revision).
 *
 * Concurrency (mitigation #14, design doc section 13 Q4; review finding #1):
 * the default write path performs read -> apply -> write ATOMICALLY under a
 * SINGLE lock hold via atomic-write.ts mutateStateWithLock (atomic temp+rename
 * inside one O_EXCL lock acquisition). Correctness comes from the lock: two
 * writers can no longer observe the same pre-image and clobber each other. The
 * monotone `revision` counter is kept as defense-in-depth and bumped on each
 * successful write; the injected-write test branch additionally runs a CAS retry
 * loop so deterministic contention tests still exercise no-lost-update behavior.
 *
 * Transient-failure safety (review finding #2): a genuinely-absent file (ENOENT)
 * is the empty case (write revision 1); a file that EXISTS but fails to read
 * (EBUSY/EACCES/EPERM) or a NON-EMPTY file that fails to parse is treated as a
 * transient failure and is NEVER overwritten with empty-derived state -- mutateBus
 * no-ops instead.
 *
 * Path-traversal safety (review finding #3): busPath validates the bus id against
 * a strict directory-name pattern and asserts the resolved path stays under
 * <projectDir>/.claude/cache/session. An unsafe id makes readBus -> emptyBus and
 * mutateBus -> no-op, touching no filesystem outside the root.
 *
 * Re-read-on-every-call (design doc section 4.4): readBus re-reads disk EVERY
 * call -- there is no module-level cache. This makes hook ordering irrelevant
 * and survives compaction (the first reader after a compact pays a fresh disk
 * hit and gets restored content).
 *
 * Kill switch (mitigation #19): CCV3_BUS_OFF=1 -> readBus returns emptyBus and
 * mutateBus is a no-op. Read lazily on every call.
 *
 * Latency instrument (finding #8, design doc section 13 Q5): readBus times the
 * disk read; if it exceeds LATENCY_BUDGET_MS (50ms -- Windows Defender file-lock
 * territory), it appends a `bus_read_latency` event to intel-bus and STILL
 * returns. Day-1 instrument; the real >=70%-under-50ms gate is Phase C.
 *
 * Fail-open: NEVER throw into the hot path. Any fs/lock/parse error -> emptyBus
 * (reads) or best-effort no-throw (writes).
 *
 * Test seams: readBus/mutateBus accept injected read/write/now/onLatency (and a
 * beforeWrite hook for deterministic CAS tests), matching the host-ram.ts /
 * session-bus-id.ts injected-dependency style. ASCII only.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { getBusId } from './session-bus-id.js';
import { mutateStateWithLock } from './atomic-write.js';
import { appendIntelBus } from './intel-bus.js';

/** Read budget in ms; a slower read logs a latency event but still returns. */
export const LATENCY_BUDGET_MS = 50;

/** Ambient files_in_play may occupy at most this fraction of total slots. */
export const AMBIENT_CAP_RATIO = 0.3;

/**
 * Minimum ambient floor. The 30% cap prevents ambient (grep/browse/doc reads)
 * from FLOODING OUT load-bearing context -- it is not meant to forbid ambient
 * entirely on a near-empty bus (where ratio math would otherwise reject the very
 * first ambient add, since 1/1 > 0.3). Up to this many ambient slots are always
 * allowed; beyond the floor, the 30% ratio governs.
 */
export const AMBIENT_MIN_SLOTS = 3;

/** Bounded CAS retries before a best-effort write (never an infinite loop). */
const MAX_CAS_RETRIES = 5;

/**
 * Default bus lock-wait cap (WS-2 Phase B.0). A per-tool bus write waits at most
 * this long for the lock before it is treated as a DROPPED write (logged, never
 * silent) -- far below atomic-write's 5s default so the hook can never hang on a
 * contended bus. Callers override via BusOptions.lockTimeoutMs.
 */
export const BUS_LOCK_TIMEOUT_MS = 200;

/**
 * Slow-path threshold (ms) above which a successful bus write ALSO emits a
 * `bus_write` timing row to intel-bus. The fast common path stays quiet (the
 * onOutcome seam carries every-call timing) so intel-bus is not spammed.
 * Aligned to LATENCY_BUDGET_MS (50ms): a bus write is "slow" once it crosses the
 * same budget a slow READ does. A 10ms threshold was too chatty -- ordinary
 * writes cross it under CPU/Defender load, which would spam intel-bus in
 * production (and made the "fast write stays quiet" test load-flaky). Exported so
 * tests can assert the gating invariant (a `bus_write` row appears IFF slow).
 */
export const BUS_WRITE_SLOW_MS = LATENCY_BUDGET_MS;

// ---------------------------------------------------------------------------
// BusEntry v3 schema (design doc section 4.1)
// ---------------------------------------------------------------------------

/** SCIP-style stable symbol identity (design doc section 13 Q10). */
export interface SymbolId {
  git_sha?: string;
  file_uri: string;
  lang: string;
  container?: string;
  name: string;
  /** sha256(normalized_signature)[:8] -- survives moves. */
  signature_hash?: string;
}

/** Per-source ranks (design doc section 13 Q12 -- replaces confidence in [0,1]). */
export interface RanksBySource {
  codegraph_fts?: number | null;
  serena_lsp?: number | null;
  tldr_ast?: number | null;
  user_mentioned?: number | null;
  [source: string]: number | null | undefined;
}

/** Stale-detection provenance (design doc section 13 Q9). */
export interface StaleCheck {
  git_head_at_discovery?: string;
  content_hash?: string;
  mtime_at_discovery?: number;
}

/** A symbol the session is focused on. */
export interface FocusSymbol {
  id: SymbolId;
  ranks_by_source?: RanksBySource;
  stale_check?: StaleCheck;
  discovered_via?: string[];
  turn_added: number;
  last_referenced_turn?: number;
  stale?: boolean;
}

/** The 8 roles in the files_in_play taxonomy (design doc section 4.2). */
export type FileRole =
  // load_bearing slice
  | 'user_mentioned'
  | 'edited'
  | 'test_failed'
  | 'dependency_traced'
  | 'read_for_context'
  // ambient slice
  | 'grep_hit'
  | 'read_for_browse'
  | 'doc_read';

/** A file in play, with its role and provenance. */
export interface FileInPlay {
  path: string;
  role: FileRole;
  turn_added: number;
  stale_check?: StaleCheck;
  stale?: boolean;
}

/** Two-slice files_in_play (design doc section 4.2). */
export interface FilesInPlay {
  load_bearing: FileInPlay[];
  ambient: FileInPlay[];
}

/** A recent tool finding (design doc section 4.1). */
export interface RecentFinding {
  correlation_id: string;
  tool: string;
  subject_id: string;
  result_count: number;
  rank: number;
  ts: string;
  duration_ms?: number;
}

/** An open sub-agent thread (design doc section 4.1). */
export interface OpenThread {
  agent: string;
  task_id: string;
  subject_id: string;
  parent_correlation_id?: string | null;
}

/** The whole bus entry (design doc section 4.1, schema_version 3). */
export interface BusEntry {
  bus_id: string;
  current_intent: string | null;
  focus_symbols: FocusSymbol[];
  files_in_play: FilesInPlay;
  recent_findings: RecentFinding[];
  open_threads: OpenThread[];
  schema_version: 3;
  compact_generation: number;
  /** CAS-style monotone counter (design doc section 13 Q4). */
  revision: number;
  /**
   * Per-turn counter (WS-2 Phase B.4a). Bumped once per UserPromptSubmit by the
   * bus populator; PostToolUse writers stamp entries with the turn they landed
   * on. The reader (B.3) uses it to compute focus/file staleness, since the bus
   * READ happens at UserPromptSubmit but WRITES happen at PostToolUse -- so by
   * the time a later turn reads, focus/files from a prior turn are >=1 turn
   * stale (design mitigation #4).
   */
  current_turn: number;
}

/** The load-bearing roles (everything else is ambient). */
const LOAD_BEARING_ROLES: ReadonlySet<FileRole> = new Set<FileRole>([
  'user_mentioned',
  'edited',
  'test_failed',
  'dependency_traced',
  'read_for_context',
]);

/** Build a fresh, empty bus entry. */
export function emptyBus(busId: string): BusEntry {
  return {
    bus_id: busId,
    current_intent: null,
    focus_symbols: [],
    files_in_play: { load_bearing: [], ambient: [] },
    recent_findings: [],
    open_threads: [],
    schema_version: 3,
    compact_generation: 0,
    revision: 0,
    current_turn: 0,
  };
}

/**
 * Strict directory-name pattern for a bus id (finding #3). Must start with an
 * alphanumeric, then up to 80 more of [A-Za-z0-9._-]. This intentionally forbids
 * path separators, leading dots, and anything that could form a traversal.
 */
const VALID_BUS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/**
 * Validate a bus id against the strict pattern AND explicitly reject the obvious
 * traversal shapes. Throws on anything unsafe; callers (busPath, and through it
 * readBus/mutateBus) catch this and fail SAFE. Centralizing here means all three
 * exported entry points are covered by one chokepoint.
 */
function assertSafeBusId(busId: string): void {
  if (
    typeof busId !== 'string' ||
    busId.length === 0 ||
    busId === '.' ||
    busId === '..' ||
    busId.includes('/') ||
    busId.includes('\\') ||
    busId.includes('..') ||
    !VALID_BUS_ID.test(busId)
  ) {
    throw new Error('unsafe bus id');
  }
}

/** The session-cache root that every bus path MUST stay under. */
function sessionCacheRoot(projectDir?: string): string {
  const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(root, '.claude', 'cache', 'session');
}

/**
 * Resolve the project-relative bus path for a given id. Validates the id and
 * asserts the fully-resolved path stays under <projectDir>/.claude/cache/session
 * (defense in depth against traversal -- finding #3). Throws on an unsafe id or
 * an escaping path; readBus/mutateBus catch and fail safe.
 */
export function busPath(busId: string, projectDir?: string): string {
  assertSafeBusId(busId);
  const sessionRoot = sessionCacheRoot(projectDir);
  const full = join(sessionRoot, busId, 'context.json');

  // Resolve both sides and assert containment. A trailing separator on the root
  // prevents a sibling-prefix bypass (e.g. ".../session-evil" vs ".../session").
  const resolvedRoot = resolve(sessionRoot);
  const resolvedFull = resolve(full);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (!resolvedFull.startsWith(rootWithSep)) {
    throw new Error('bus path escapes session root');
  }
  return full;
}

/** Is the kill switch engaged? Read lazily on every call. */
function busOff(): boolean {
  return process.env.CCV3_BUS_OFF === '1';
}

/** Keep at most `cap` newest (tail) entries -- FIFO eviction of the oldest. */
function capTail<T>(arr: T[], cap: number): T[] {
  return arr.length > cap ? arr.slice(arr.length - cap) : arr;
}

/** Keep at most `cap` FileInPlay entries with the newest turn_added (oldest evicted). */
function capByTurn(arr: FileInPlay[], cap: number): FileInPlay[] {
  if (arr.length <= cap) return arr;
  return [...arr].sort((a, b) => (a.turn_added ?? 0) - (b.turn_added ?? 0)).slice(arr.length - cap);
}

/**
 * Coerce arbitrary parsed JSON into a well-formed BusEntry. Missing or wrong
 * fields fall back to empty defaults so a partially-written or older file still
 * yields a usable bus (fail-soft).
 *
 * The per-slice CAPS are enforced HERE (the read/coerce choke point), not only in
 * the add* write helpers: bumpTurn/setIntent re-serialize the WHOLE bus without
 * going through those helpers, so a file that arrived already bloated (an older
 * version, an external writer) would otherwise persist and grow unbounded on every
 * turn-bump -- the write-slowdown feedback loop (session-3 review#5 / critic F5).
 */
function coerceBus(busId: string, parsed: unknown): BusEntry {
  const base = emptyBus(busId);
  if (!parsed || typeof parsed !== 'object') return base;
  const p = parsed as Record<string, unknown>;
  return {
    bus_id: typeof p.bus_id === 'string' ? p.bus_id : busId,
    current_intent: typeof p.current_intent === 'string' ? p.current_intent : null,
    focus_symbols: capTail(
      Array.isArray(p.focus_symbols) ? (p.focus_symbols as FocusSymbol[]) : [],
      FOCUS_SYMBOLS_CAP,
    ),
    files_in_play: coerceFilesInPlay(p.files_in_play),
    recent_findings: capTail(
      Array.isArray(p.recent_findings) ? (p.recent_findings as RecentFinding[]) : [],
      RECENT_FINDINGS_CAP,
    ),
    open_threads: capTail(
      Array.isArray(p.open_threads) ? (p.open_threads as OpenThread[]) : [],
      OPEN_THREADS_CAP,
    ),
    schema_version: 3,
    compact_generation: typeof p.compact_generation === 'number' ? p.compact_generation : 0,
    revision: typeof p.revision === 'number' && Number.isFinite(p.revision) ? p.revision : 0,
    current_turn:
      typeof p.current_turn === 'number' && Number.isFinite(p.current_turn) ? p.current_turn : 0,
  };
}

function coerceFilesInPlay(value: unknown): FilesInPlay {
  if (!value || typeof value !== 'object') return { load_bearing: [], ambient: [] };
  const v = value as Record<string, unknown>;
  const lb = Array.isArray(v.load_bearing) ? (v.load_bearing as FileInPlay[]) : [];
  const amb = Array.isArray(v.ambient) ? (v.ambient as FileInPlay[]) : [];
  // load_bearing keeps the newest by turn (matches addFileInPlay eviction); ambient
  // is bounded by the same ceiling so a bloated file cannot grow without bound.
  return {
    load_bearing: capByTurn(lb, LOAD_BEARING_CAP),
    ambient: capTail(amb, LOAD_BEARING_CAP),
  };
}

/** Options shared by readBus / mutateBus. All optional; defaults hit disk. */
export interface BusOptions {
  /** Project root override (default: CLAUDE_PROJECT_DIR || cwd). */
  projectDir?: string;
  /** Disk read seam (default: readFileSync -> string | null). Test seam. */
  read?: (path: string) => string | null;
  /**
   * Disk write seam. When PROVIDED, mutateBus uses the injected-write CAS branch
   * (in-memory disk tests). When ABSENT, the default lock-backed atomic primitive
   * (atomic-write.ts mutateStateWithLock) performs the read+write under one lock.
   * Test seam.
   */
  write?: (path: string, content: string) => void;
  /** Monotonic-ish clock in ms (default: Date.now). Test seam. */
  now?: () => number;
  /** Latency sink (default: appendIntelBus latency event). Test seam. */
  onLatency?: (event: Record<string, unknown>) => void;
  /**
   * Fired inside mutateBus AFTER the mutation is applied but BEFORE the write,
   * on each attempt. Lets tests inject a competing writer to exercise CAS.
   */
  beforeWrite?: () => void;
  /**
   * Max time the real-lock write path waits for the bus lock, in ms (WS-2 Phase
   * B.0). DEFAULT is 200 (BUS_LOCK_TIMEOUT_MS) so a per-tool bus write can never
   * hang the hook on atomic-write's 5s default. Only the real-lock path
   * (mutateViaLock) honors this; the injected-write CAS branch ignores it.
   */
  lockTimeoutMs?: number;
  /**
   * Every-call write outcome seam (WS-2 Phase B.0). Fires once per real-lock
   * mutateBus with whether the write was DROPPED (lock timeout) and the timings.
   * A dropped write is ALSO logged to intel-bus (bus_write_dropped) so the drop
   * is never silent; onOutcome is the in-process signal tests/benches read.
   */
  onOutcome?: (o: { dropped: boolean; wait_ms: number; write_ms?: number }) => void;
}

/** Default disk read: returns file contents or null if missing/unreadable. */
function defaultRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null; // missing or unreadable -> caller treats as empty
  }
}

/**
 * Read the bus, re-reading disk on every call (no cache, design doc section
 * 4.4). Missing/unreadable/unparseable -> emptyBus. Times the read; if it
 * exceeds LATENCY_BUDGET_MS, logs a latency event to intel-bus and still
 * returns. Kill switch + fail-open honored. NEVER throws.
 *
 * @param busId Bus id (default: getBusId()).
 * @param opts  Injected seams.
 */
export function readBus(busId?: string, opts: BusOptions = {}): BusEntry {
  const id = busId ?? safeBusId();
  if (busOff()) return emptyBus(id);

  const read = opts.read ?? defaultRead;
  const now = opts.now ?? Date.now;

  try {
    // busPath validates the id; an unsafe id throws here, BEFORE the read seam
    // is touched, so a traversal id never causes any filesystem access.
    const path = busPath(id, opts.projectDir);

    const start = now();
    const raw = read(path);
    const elapsed = now() - start;

    if (elapsed >= LATENCY_BUDGET_MS) {
      reportLatency(id, elapsed, opts);
    }

    if (raw == null) return emptyBus(id);
    return coerceBus(id, JSON.parse(raw));
  } catch {
    // Any fs/parse/validation error -> empty bus, never throw into the hot path.
    return emptyBus(id);
  }
}

/** Emit a bus_read_latency event (default: intel-bus; test seam overrides). */
function reportLatency(busId: string, durationMs: number, opts: BusOptions): void {
  const event = {
    bus_id: busId,
    query_type: 'bus_read_latency',
    duration_ms: durationMs,
  };
  try {
    if (opts.onLatency) {
      opts.onLatency(event);
    } else {
      appendIntelBus({ ...event, bus_id: busId }, { projectDir: opts.projectDir });
    }
  } catch {
    // Latency logging must never break a read.
  }
}

/**
 * Classified read of the current bus state. Critically distinguishes:
 *  - 'absent'  : the file genuinely does not exist (read returned null / ENOENT)
 *  - 'present' : the file exists and parsed into a usable bus
 *  - 'failed'  : the file EXISTS but could not be read (read threw) OR a
 *                NON-EMPTY file failed to parse (transient lock / parse race)
 * The 'failed' case must NEVER be coerced to empty-and-written (finding #2).
 */
type LoadResult =
  | { kind: 'absent' }
  | { kind: 'present'; bus: BusEntry }
  | { kind: 'failed' };

/**
 * Read + classify current bus state through the given (possibly injected) read
 * seam. A throwing read => 'failed' (existing-but-unreadable). A null read =>
 * 'absent'. A non-null string that fails to parse => 'failed' only if it is
 * non-empty (a non-empty-but-corrupt file is a transient/parse race we must not
 * clobber); a whitespace-only string parses as absent-equivalent empty.
 */
function loadState(
  id: string,
  read: (path: string) => string | null,
  path: string,
): LoadResult {
  let raw: string | null;
  try {
    raw = read(path);
  } catch {
    // The file exists but the read failed (EBUSY/EACCES/EPERM). Transient.
    return { kind: 'failed' };
  }
  if (raw == null) return { kind: 'absent' };
  if (raw.trim().length === 0) return { kind: 'absent' }; // empty file ~ absent
  try {
    return { kind: 'present', bus: coerceBus(id, JSON.parse(raw)) };
  } catch {
    // Non-empty file that failed to parse -> transient parse race; do not erase.
    return { kind: 'failed' };
  }
}

/**
 * Read-modify-write the bus with the read -> apply -> write performed ATOMICALLY
 * under a SINGLE lock hold (finding #1). The revision counter is kept as
 * defense-in-depth and is bumped monotonically, but correctness now comes from
 * the lock: no two writers can observe the same pre-image and clobber each other.
 *
 * A genuinely-absent file is the legitimate empty case (write revision 1). A
 * file that exists but fails to read/parse is a TRANSIENT failure -> NO-OP, so
 * real state is never overwritten with empty-derived state (finding #2).
 *
 * An unsafe busId fails SAFE: no filesystem access, returns emptyBus (finding #3).
 * Kill switch + fail-open honored. NEVER throws; returns the best-effort BusEntry.
 *
 * @param busId Bus id (default: getBusId()).
 * @param fn    Mutation applied in place to the working BusEntry.
 * @param opts  Injected seams.
 */
export function mutateBus(
  busId: string | undefined,
  fn: (bus: BusEntry) => void,
  opts: BusOptions = {},
): BusEntry {
  const id = busId ?? safeBusId();
  if (busOff()) return emptyBus(id);

  let path: string;
  try {
    // Validate the id FIRST. An unsafe id throws here, before any read/write
    // seam is touched -> no filesystem access at all (finding #3 fail-safe).
    path = busPath(id, opts.projectDir);
  } catch {
    return emptyBus(id);
  }

  // The injected-write branch (unit tests with an in-memory disk) keeps the
  // seam-based CAS loop; the default branch uses the real lock-backed atomic
  // primitive. Both share the same transient-failure + validation semantics.
  if (opts.write) {
    return mutateViaSeam(id, path, fn, opts);
  }
  return mutateViaLock(id, path, fn, opts);
}

/**
 * Default path: perform the whole read -> apply -> write inside ONE lock hold via
 * mutateStateWithLock. The transform reads the current bytes (honoring an
 * injected read seam if present, for deterministic contention tests), classifies
 * them, applies fn, bumps revision, and serializes. On a transient failure it
 * returns null -> the primitive performs a NO-OP (no clobber).
 *
 * WS-2 Phase B.0: the lock wait is capped (default BUS_LOCK_TIMEOUT_MS = 200ms)
 * so a contended per-tool bus write can never hang the hook on the 5s default.
 * A lock-timeout is a DROPPED write -- it is LOGGED to intel-bus
 * (bus_write_dropped) and signaled via opts.onOutcome, NEVER silently swallowed.
 * The bus file is left untouched on a drop; we return the best-effort `result`
 * (the pre-write emptyBus/last-read), so a drop is surfaced, not hidden behind a
 * clobbered/empty bus. A successful write that crossed the slow threshold also
 * emits a `bus_write` timing row; the fast common path stays quiet on intel-bus.
 */
function mutateViaLock(
  id: string,
  path: string,
  fn: (bus: BusEntry) => void,
  opts: BusOptions,
): BusEntry {
  const read = opts.read; // may be undefined -> the primitive reads the file itself
  const lockTimeoutMs = opts.lockTimeoutMs ?? BUS_LOCK_TIMEOUT_MS;
  let result = emptyBus(id);

  // Captured from the primitive's instrumentation callbacks. `outcomeKnown`
  // distinguishes a REPORTED lock outcome from an exception that prevented the
  // acquire from ever running, so a drop's intel-bus `reason` stays honest
  // (cross-model review finding: a pre-acquire throw must not masquerade as a
  // lock_timeout). The acquire callback flips it true.
  let outcomeKnown = false;
  let acquired = false;
  let waitMs = 0;
  let writeMs: number | undefined;
  // Whether the mutation actually PERSISTED. mutateStateWithLock returns false on
  // every in-lock failure too (corrupt/unreadable pre-image -> null transform, a
  // throwing transform, or a failed atomicWriteSync), not just on a lock timeout.
  let wrote = false;

  try {
    ensureDir(path, opts);
    wrote = mutateStateWithLock(
      path,
      (current) => {
        // Determine the pre-image. If a read seam is injected, classify through
        // it (lets the contention test slip a competitor write in). Otherwise use
        // the `current` string the primitive already read under the lock.
        let loaded: LoadResult;
        if (read) {
          loaded = loadState(id, read, path);
        } else if (current == null) {
          loaded = { kind: 'absent' };
        } else if (current.trim().length === 0) {
          loaded = { kind: 'absent' };
        } else {
          try {
            loaded = { kind: 'present', bus: coerceBus(id, JSON.parse(current)) };
          } catch {
            loaded = { kind: 'failed' };
          }
        }

        if (loaded.kind === 'failed') {
          // Transient: do not overwrite existing-but-unreadable state.
          return null;
        }

        const base = loaded.kind === 'present' ? loaded.bus : emptyBus(id);
        const baseRevision = base.revision;
        fn(base);
        base.revision = baseRevision + 1;
        result = base;
        return JSON.stringify(base, null, 2);
      },
      {
        lockTimeoutMs,
        onLockOutcome: (o) => {
          outcomeKnown = true;
          acquired = o.acquired;
          waitMs = o.wait_ms;
        },
        onWriteTiming: (o) => {
          writeMs = o.write_ms;
        },
      },
    );
  } catch {
    // Fail-open: never throw into the hot path.
  }

  // B.0 outcome handling. A DROPPED write is any mutation that did NOT persist.
  // Three cases, all logged (never silent) + signaled dropped:true:
  //   1. lock never acquired -> reason 'lock_timeout' (outcome reported) or
  //      'write_error' (a pre-acquire exception -- outcomeKnown stays false).
  //   2. lock acquired but the write did not land (corrupt pre-image, throwing
  //      transform, or a failed atomicWriteSync -> wrote === false) -> 'write_error'.
  // This is the session-3 review#1 hole: the acquired-but-no-write path used to
  //      report dropped:false (a silent drop) -- the drop-storm rollback signal the
  //      quality gate relies on would have missed exactly these failures.
  // Only an acquired AND persisted write is a success.
  if (!acquired) {
    emitDropEvent(id, waitMs, opts, outcomeKnown ? 'lock_timeout' : 'write_error');
    fireOutcome(opts, { dropped: true, wait_ms: waitMs });
  } else if (!wrote) {
    emitDropEvent(id, waitMs, opts, 'write_error');
    fireOutcome(opts, { dropped: true, wait_ms: waitMs });
  } else {
    fireOutcome(opts, { dropped: false, wait_ms: waitMs, write_ms: writeMs });
    if (waitMs > BUS_WRITE_SLOW_MS || (writeMs ?? 0) > BUS_WRITE_SLOW_MS) {
      emitWriteTiming(id, waitMs, writeMs, opts);
    }
  }

  return result;
}

/**
 * Log a DROPPED bus write to intel-bus (WS-2 Phase B.0). A drop means a per-tool
 * mutation could not land -- either the lock timed out (`reason:'lock_timeout'`)
 * or an exception prevented the acquire (`reason:'write_error'`). Surfacing it
 * here is what makes the drop NON-silent. Fully fail-open: a throwing
 * appendIntelBus must NEVER propagate into the write path.
 */
function emitDropEvent(
  id: string,
  waitMs: number,
  opts: BusOptions,
  reason: 'lock_timeout' | 'write_error',
): void {
  try {
    appendIntelBus(
      {
        bus_id: id,
        query_type: 'bus_write_dropped',
        reason,
        wait_ms: waitMs,
        duration_ms: waitMs,
      },
      { projectDir: opts.projectDir },
    );
  } catch {
    // Drop-logging must never break the write path (fail-open).
  }
}

/**
 * Log a slow-but-successful bus write to intel-bus (WS-2 Phase B.0). Only fired
 * when the wait or write crossed BUS_WRITE_SLOW_MS so the fast common path stays
 * quiet. Fully fail-open.
 */
function emitWriteTiming(
  id: string,
  waitMs: number,
  writeMs: number | undefined,
  opts: BusOptions,
): void {
  try {
    appendIntelBus(
      {
        bus_id: id,
        query_type: 'bus_write',
        wait_ms: waitMs,
        // Explicit null (not undefined): keep the field present so a consumer can
        // tell "write not measured" from "sub-ms write" (review finding).
        write_ms: writeMs ?? null,
        duration_ms: waitMs + (writeMs ?? 0),
      },
      { projectDir: opts.projectDir },
    );
  } catch {
    // Timing-logging must never break the write path (fail-open).
  }
}

/** Fire the per-call write outcome seam, fail-open (a throwing sink is ignored). */
function fireOutcome(
  opts: BusOptions,
  o: { dropped: boolean; wait_ms: number; write_ms?: number },
): void {
  if (!opts.onOutcome) return;
  try {
    opts.onOutcome(o);
  } catch {
    // The outcome seam must never throw into the write path.
  }
}

/**
 * Injected-write branch: seam-based CAS retry loop (used by unit tests with an
 * in-memory disk). Honors the beforeWrite seam so tests can inject a competing
 * writer. Shares the transient-failure semantics: a 'failed' load is a NO-OP
 * (no clobber), an 'absent' load is the empty case.
 */
function mutateViaSeam(
  id: string,
  path: string,
  fn: (bus: BusEntry) => void,
  opts: BusOptions,
): BusEntry {
  const read = opts.read ?? defaultRead;
  const write = opts.write!;

  let working = emptyBus(id);

  try {
    // Initial load. A transient failure here means existing-but-unreadable state
    // -> abort without writing (finding #2).
    const initial = loadState(id, read, path);
    if (initial.kind === 'failed') return working;

    let base = initial.kind === 'present' ? initial.bus : emptyBus(id);
    let baseRevision = base.revision;
    fn(base);
    working = base;

    for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt++) {
      // Test seam: a competing writer may commit here.
      if (opts.beforeWrite) opts.beforeWrite();

      // CAS: re-load and check whether the on-disk revision moved.
      const reload = loadState(id, read, path);
      if (reload.kind === 'failed') {
        // Became unreadable mid-flight -> do not clobber. Safe abort.
        return working;
      }
      const currentRevision = reload.kind === 'present' ? reload.bus.revision : 0;

      if (currentRevision === baseRevision) {
        working.revision = baseRevision + 1;
        write(path, JSON.stringify(working, null, 2));
        return working;
      }

      // Stale: someone bumped it. Re-apply fn onto the NEWER state and retry so
      // we never clobber the competitor's update (no lost update).
      base = reload.kind === 'present' ? reload.bus : emptyBus(id);
      baseRevision = base.revision;
      fn(base);
      working = base;
    }

    // Retry budget exhausted (pathological contention). Best-effort write at
    // current+1 so we don't silently drop the mutation; never throw.
    const tail = loadState(id, read, path);
    if (tail.kind === 'failed') return working;
    const tailRevision = tail.kind === 'present' ? tail.bus.revision : 0;
    working.revision = tailRevision + 1;
    try {
      write(path, JSON.stringify(working, null, 2));
    } catch {
      /* swallow: fail-open */
    }
    return working;
  } catch {
    // Any unexpected error -> return the best-effort working copy, never throw.
    return working;
  }
}

/** Ensure the bus directory exists before a default disk write. */
function ensureDir(path: string, opts: BusOptions): void {
  // Only the default writer needs the directory pre-created; an injected write
  // seam manages its own storage. Detect "default" by absence of opts.write.
  if (opts.write) return;
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    /* swallow: fail-open */
  }
}

/** getBusId() but never throws (extra belt-and-suspenders for the hot path). */
function safeBusId(): string {
  try {
    return getBusId();
  } catch {
    return 's-unknown';
  }
}

// ---------------------------------------------------------------------------
// Typed mutation helpers (operate in place on a BusEntry; revision is bumped by
// mutateBus, not here -- these are the building blocks callers pass to it).
// ---------------------------------------------------------------------------

/** Set the current intent. */
export function setIntent(bus: BusEntry, intent: string): void {
  bus.current_intent = intent;
}

/**
 * Increment the per-turn counter (WS-2 Phase B.4a). Tolerates a missing/garbage
 * counter on a legacy bus (coalesces to 0 before bumping) so the first bump on
 * an older file still yields 1.
 */
export function bumpTurn(bus: BusEntry): void {
  bus.current_turn = (bus.current_turn ?? 0) + 1;
}

/**
 * Per-array caps (WS-2 cross-model review finding F3). The bus JSON is
 * read+parsed+written on every mutateBus call, so an unbounded array makes writes
 * progressively slower and the 200ms lock hold creep up over a long session --
 * which would feed back into MORE write drops. Each writer keeps its slice
 * bounded: load_bearing evicts the oldest last-touch turn, focus/findings are
 * FIFO. Exported so tests can pin the boundary.
 */
export const LOAD_BEARING_CAP = 50;
export const FOCUS_SYMBOLS_CAP = 50;
export const RECENT_FINDINGS_CAP = 50;
export const OPEN_THREADS_CAP = 50;

/** Append a focus symbol, keeping the slice within FOCUS_SYMBOLS_CAP (FIFO). */
export function addFocusSymbol(bus: BusEntry, sym: FocusSymbol): void {
  bus.focus_symbols.push(sym);
  if (bus.focus_symbols.length > FOCUS_SYMBOLS_CAP) {
    bus.focus_symbols.splice(0, bus.focus_symbols.length - FOCUS_SYMBOLS_CAP);
  }
}

/** Append a recent finding, keeping the slice within RECENT_FINDINGS_CAP (FIFO). */
export function addRecentFinding(bus: BusEntry, finding: RecentFinding): void {
  bus.recent_findings.push(finding);
  if (bus.recent_findings.length > RECENT_FINDINGS_CAP) {
    bus.recent_findings.splice(0, bus.recent_findings.length - RECENT_FINDINGS_CAP);
  }
}

/**
 * Add a file in play, routing by role into the load_bearing or ambient slice.
 *
 * Load-bearing (review F3): DEDUP by (path, role) -- a re-touched file refreshes
 * its turn_added in place instead of appending a duplicate -- then CAP the slice
 * at LOAD_BEARING_CAP, evicting the entry with the oldest last-touch turn. This
 * keeps a long edit-heavy session from growing the bus without bound. The dedup
 * scan is O(LOAD_BEARING_CAP) (the array is capped small), not a full-session scan.
 *
 * Ambient: the 30% cap (design doc section 4.2). Load-bearing is never evicted by
 * ambient pressure; an ambient add that would breach the cap is dropped.
 */
export function addFileInPlay(bus: BusEntry, file: FileInPlay): void {
  if (LOAD_BEARING_ROLES.has(file.role)) {
    const lbArr = bus.files_in_play.load_bearing;
    const existing = lbArr.find((f) => f.path === file.path && f.role === file.role);
    if (existing) {
      // Re-touch: refresh recency + freshness in place (no duplicate row).
      existing.turn_added = file.turn_added;
      existing.stale = file.stale;
      existing.stale_check = file.stale_check;
      return;
    }
    lbArr.push(file);
    if (lbArr.length > LOAD_BEARING_CAP) {
      lbArr.sort((a, b) => (a.turn_added ?? 0) - (b.turn_added ?? 0));
      lbArr.splice(0, lbArr.length - LOAD_BEARING_CAP);
    }
    return;
  }
  // Ambient: accept if it stays within the floor OR keeps ambient/total within
  // the 30% cap. The floor lets the first few ambient files in on a near-empty
  // bus; the ratio prevents ambient from flooding out load-bearing context.
  const lb = bus.files_in_play.load_bearing.length;
  const amb = bus.files_in_play.ambient.length;
  const totalAfter = lb + amb + 1;
  const ambAfter = amb + 1;
  const withinFloor = ambAfter <= AMBIENT_MIN_SLOTS;
  const withinRatio = ambAfter / totalAfter <= AMBIENT_CAP_RATIO + 1e-9;
  if (withinFloor || withinRatio) {
    bus.files_in_play.ambient.push(file);
  }
  // else: cap reached -> drop the ambient entry (load_bearing untouched).
}
