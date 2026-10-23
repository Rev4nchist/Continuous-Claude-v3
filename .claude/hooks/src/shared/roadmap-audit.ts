/**
 * shared/roadmap-audit.ts -- the guarded write path for every hook that
 * touches ROADMAP.md (post-plan-roadmap, git-commit-roadmap, prd-roadmap-sync).
 *
 * Plan: thoughts context / `i-was-working-in-composed-manatee` (approved,
 * premortemed Claude, 2026-08-05). See plan Context section for why a
 * "shrink floor" invariant was REJECTED: the live clobber this fixes was 24
 * insertions / 19 deletions on a 335-line file -- net +5 lines, ~101% of the
 * original. A percentage-shrink check cannot fire on a write that grows the
 * file while still silently deleting real content. The invariant that DOES
 * fire on that clobber is "no line may vanish unless explicitly declared
 * removable" -- that is gate 2 below, and it is the actual point of this file.
 *
 * Gate order is the design; do not reorder:
 *   1. no-op            -- after === before -> `noop`, no write, no .bak.
 *   2. deletion-free     -- (skipped when allowFullRewrite) any line present
 *      invariant            in `before` and absent from `after`, beyond what
 *                           `allowedDeletions` explicitly names, refuses the
 *                           write outright (`skipped` / `deletion_guard`).
 *      catastrophic         (only when allowFullRewrite) before non-empty and
 *      backstop             after is empty or under 25% of before's lines ->
 *                           refuse (`skipped` / `catastrophic_rewrite`). This
 *                           is the legitimate fresh-file rewrite path only.
 *   3. pre-image         -- write the BEFORE content to
 *                           `~/.claude/state/roadmap-bak/<slug>-<hash8>/<ts>-<nonce>.md`
 *                           (see `roadmapBakPath`), NOT to `<roadmapPath>.bak`.
 *                           Changed 2026-09-02: the old in-tree path left an
 *                           untracked, un-gitignored file in the project root
 *                           after every guarded write, so it surfaced in
 *                           `git status` of every project on every plan
 *                           approval. Rotated to the newest `BAK_KEEP`; own
 *                           try/catch, so a failure sets `bak_error` and still
 *                           never blocks the write. The real path lands in the
 *                           audit row's `bak_path`.
 *   4. the write          -- via atomic-write's `mutateStateWithLock`, so a
 *                           concurrent modification safely no-ops instead of
 *                           losing an update. `mutateStateWithLock` returns
 *                           `false` for THREE different reasons (lock never
 *                           acquired, transform declined because `current !==
 *                           before`, or a write/read failure with the lock
 *                           held) and collapsing them into one generic
 *                           `skipped` reason would misdiagnose the next
 *                           incident. This module distinguishes them via
 *                           `onLockOutcome`/`onWriteTiming` (see
 *                           `shared/atomic-write.ts`'s `MutateLockOptions`):
 *                           `lock_timeout`, `concurrent_modification` (this is
 *                           the one that must be SURFACED to the session, not
 *                           just logged -- a silently dropped entry is exactly
 *                           the defect class this plan calls out elsewhere),
 *                           or `write_failed`.
 *   5. audit append        -- LAST, so the record reflects the real outcome.
 *      (always, even noop) `.claude/logs/roadmap-sync.jsonl`, one line, no
 *                           rotation (three hooks append concurrently; an
 *                           unsynchronised rename at a rotation boundary can
 *                           lose records -- see the README next to the log).
 *
 * Failure posture: every observability side effect (the backup write, the
 * audit-log append) is individually try/caught. writeRoadmapGuarded NEVER
 * throws. Only the deliberate gates (no-op / deletion / catastrophic / lock)
 * ever prevent a write.
 */

import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { mutateStateWithLock } from './atomic-write.js';

export type RoadmapWriteOutcome = 'written' | 'noop' | 'skipped' | 'failed';

export interface RoadmapAuditRecord {
  ts: string;
  hook: string;
  /**
   * The harness tool whose PostToolUse event triggered this write, taken from
   * the hook payload's `tool_name` (`Bash`, `PowerShell`, `ExitPlanMode`, ...).
   *
   * REQUIRED, not optional, and that is the point. git-commit-roadmap was
   * registered on the `Bash` matcher alone while windows-platform.md told
   * everyone to prefer the PowerShell tool for git. The recommended way to
   * commit was the one way that went unrecorded. The log built to catch that
   * could not, because it never recorded which tool ran. An optional field that
   * silently goes missing rebuilds the same blind spot. A required one degrades
   * to the literal string `unknown`, which is visible.
   */
  tool: string;
  project_dir: string;
  roadmap_path: string;
  outcome: RoadmapWriteOutcome;
  reason?: string;
  before_sha256: string;
  after_sha256: string;
  before_lines: number;
  after_lines: number;
  line_delta: number;
  before_bytes: number;
  after_bytes: number;
  bytes_delta: number;
  ops?: Array<{ label: string; lines_removed: number; lines_added: number }>;
  refused_deletions?: string[];
  bak_path?: string | null;
  bak_error?: string | null;
  session_id?: string | null;
  committed?: boolean;
  commit_hash?: string | null;
  /** Present only on the write-gate path; from `MutateLockOptions.onLockOutcome`. */
  wait_ms?: number;
  /** Present only on a successful write; from `MutateLockOptions.onWriteTiming`. */
  write_ms?: number;
}

/**
 * Outcome of the write-gate primitive. `mutateStateWithLock` returns a bare
 * `false` for three genuinely different situations; this shape keeps them
 * distinguishable so the audit record (and any caller surfacing it to the
 * session) can tell a lock timeout apart from a concurrent hand-edit apart
 * from a read/write failure with the lock held.
 */
export interface RoadmapWriteResult {
  wrote: boolean;
  reason?: 'lock_timeout' | 'concurrent_modification' | 'write_failed';
  wait_ms?: number;
  write_ms?: number;
}

/**
 * Test/production seam. Omitting `deps` (or passing `{}`) uses the real
 * implementations: `mutateStateWithLock` for the write, `writeFileSync` for
 * the backup, and an `mkdirSync` + `appendFileSync` for the audit log.
 */
export interface RoadmapAuditDeps {
  /** Perform the guarded write. See RoadmapWriteResult for the three failure reasons. */
  write?: (roadmapPath: string, before: string, after: string) => RoadmapWriteResult;
  /** Persist the `.bak` (pre-image) content. May throw -- caller catches. */
  backup?: (bakPath: string, content: string) => void;
  /** Append one already-serialized JSON line to the audit log. May throw. */
  appendLog?: (logPath: string, line: string) => void;
}

const MAX_REFUSED_DELETIONS = 20;
const CATASTROPHIC_MIN_RATIO = 0.25;

function sha256Prefix16(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16);
}

function multisetCounts(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/**
 * Lines present (by multiset count) in `beforeLines` but not in `afterLines`.
 * Order-independent by design: a pure reorder or a pure insertion produces an
 * empty result. Only a genuine removal of a line's occurrence shows up here.
 */
function computeRemovedLines(beforeLines: string[], afterLines: string[]): string[] {
  const beforeCounts = multisetCounts(beforeLines);
  const afterCounts = multisetCounts(afterLines);
  const removed: string[] = [];
  for (const [line, count] of beforeCounts) {
    const remaining = count - (afterCounts.get(line) ?? 0);
    for (let i = 0; i < remaining; i++) {
      removed.push(line);
    }
  }
  return removed;
}

/**
 * Real implementation of the write gate. Wraps `mutateStateWithLock` and uses
 * its `onLockOutcome` (fires ALWAYS, success and timeout) plus a closure flag
 * set inside the transform (the return value alone cannot distinguish "lock
 * never acquired" from "lock acquired, transform declined") to produce one of
 * the three distinct failure reasons instead of a single collapsed boolean.
 */
function defaultWrite(roadmapPath: string, before: string, after: string): RoadmapWriteResult {
  // NOTE: captured in a plain object, not bare `let`s. A bare `let` reassigned
  // only inside the onLockOutcome/onWriteTiming closures gets narrowed by TS's
  // control-flow analysis to its initial (`null`/`undefined`) type and never
  // re-widened after the (synchronous) mutateStateWithLock call returns --
  // reproduced in isolation; wrapping in an object sidesteps the CFA quirk.
  const captured: {
    transformDeclined: boolean;
    lockOutcome: { acquired: boolean; wait_ms: number } | null;
    writeMs: number | undefined;
  } = { transformDeclined: false, lockOutcome: null, writeMs: undefined };

  const wrote = mutateStateWithLock(
    roadmapPath,
    (current) => {
      // mutateStateWithLock presents `null` for a genuinely-ABSENT file
      // (ENOENT), never `''`. A caller building a fresh ROADMAP.md passes
      // `before: ''` (see post-plan-roadmap's allowFullRewrite path), so the
      // CAS must treat "absent" and "empty string" as the same pre-image --
      // otherwise `null === ''` is false, the transform declines, and a
      // brand-new project can never get its first ROADMAP.md written (and
      // the record would misreport it as `concurrent_modification`, which is
      // actively misleading: nothing was concurrent, the file just didn't
      // exist yet).
      const observed = current ?? '';
      if (observed === before) return after;
      captured.transformDeclined = true; // concurrent modification: pre-image moved under us
      return null;
    },
    {
      onLockOutcome: (o) => {
        captured.lockOutcome = o;
      },
      onWriteTiming: (o) => {
        captured.writeMs = o.write_ms;
      },
    },
  );

  if (wrote) {
    return { wrote: true, wait_ms: captured.lockOutcome?.wait_ms, write_ms: captured.writeMs };
  }

  if (captured.lockOutcome && !captured.lockOutcome.acquired) {
    return { wrote: false, reason: 'lock_timeout', wait_ms: captured.lockOutcome.wait_ms };
  }
  if (captured.transformDeclined) {
    return {
      wrote: false,
      reason: 'concurrent_modification',
      wait_ms: captured.lockOutcome?.wait_ms,
    };
  }
  // Lock WAS acquired, transform never declined (or never ran, e.g. an
  // unreadable-but-existing file) -- some other failure inside the locked
  // section (read failure, throwing transform, atomic-write failure).
  return { wrote: false, reason: 'write_failed', wait_ms: captured.lockOutcome?.wait_ms };
}

/**
 * The per-project opt-out marker. A ROADMAP.md containing this comment is
 * hand-owned: every guarded writer records its audit row and surfaces session
 * context as usual, but none of them modify the file.
 *
 * Tolerant of internal spacing and case so a human writing it from memory gets
 * it right; still requires the real `<!-- ... -->` delimiters, so prose that
 * merely mentions "roadmap-sync manual" does not silently disable the hooks.
 *
 * Documented for humans in docs/hooks/roadmap-sync-opt-out.md.
 */
export const ROADMAP_MANUAL_MARKER = /<!--\s*roadmap-sync\s*:\s*manual\s*-->/i;

/** How many pre-images to keep per project before the oldest are dropped. */
const BAK_KEEP = 10;

/**
 * Where a ROADMAP pre-image goes.
 *
 * NOT `<roadmapPath>.bak` (2026-09-02). That is what this used to be, and it
 * dropped an untracked, un-gitignored file into the project root on EVERY
 * guarded write -- so a hook whose whole job is to be unobtrusive showed up in
 * `git status` of every project after every plan approval. A backup is our
 * diagnostic, not the project's content, so it belongs in our state dir.
 *
 * Namespaced `<basename>-<hash8 of full path>` rather than by basename alone:
 * two checkouts of the same repo, or any two projects that happen to share a
 * directory name, must not overwrite each other's pre-images. The hash keeps
 * them distinct; the basename keeps the directory human-readable when someone
 * is actually looking for a lost ROADMAP.
 */
export function roadmapBakPath(projectDir: string, when: Date = new Date()): string {
  const slug = basename(projectDir).replace(/[^A-Za-z0-9._-]/g, '_') || 'project';
  const hash = sha256Prefix16(projectDir).slice(0, 8);
  const stamp = when.toISOString().replace(/[:.]/g, '-');
  // Random suffix AFTER the timestamp (2026-09-03). The stamp alone resolves
  // to the millisecond, so two guarded writes against the same project in the
  // same millisecond produced the SAME path -- and because the pre-image is
  // written before the CAS write, the second process silently overwrote the
  // first one's backup. Both audit rows then named one file and one
  // recoverable version was gone. This tree is shared by concurrent sessions,
  // so that is a real race, not a theoretical one.
  //
  // The suffix trails the timestamp so `rotateBaks`'s lexicographic sort still
  // orders by time.
  const nonce = randomBytes(3).toString('hex');
  return join(homedir(), '.claude', 'state', 'roadmap-bak', `${slug}-${hash}`, `${stamp}-${nonce}.md`);
}

/**
 * Keep only the newest `BAK_KEEP` pre-images in `dir`. Best-effort: a rotation
 * failure must never surface, because the caller's contract is that nothing in
 * the backup path can block the ROADMAP write.
 */
function rotateBaks(dir: string): void {
  try {
    const entries = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - BAK_KEEP))) {
      try { unlinkSync(join(dir, stale)); } catch { /* best effort */ }
    }
  } catch {
    /* directory unreadable -- nothing to rotate, never escalate */
  }
}

function defaultBackup(bakPath: string, content: string): void {
  const dir = dirname(bakPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(bakPath, content, 'utf-8');
  rotateBaks(dir);
}

function defaultAppendLog(logPath: string, line: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line, 'utf-8');
}

/** Best-effort append. Never throws -- observability must never break a hook. */
function appendAudit(
  projectDir: string,
  record: RoadmapAuditRecord,
  appendLogDep?: RoadmapAuditDeps['appendLog'],
): void {
  try {
    const logPath = join(projectDir, '.claude', 'logs', 'roadmap-sync.jsonl');
    const line = JSON.stringify(record) + '\n';
    (appendLogDep ?? defaultAppendLog)(logPath, line);
  } catch {
    /* audit logging must never throw into the write path */
  }
}

export function writeRoadmapGuarded(args: {
  hook: string;
  /**
   * The triggering tool name, from the hook payload's `tool_name`. Optional on
   * the ARGS so an existing caller still compiles, but it lands on the record
   * as the literal `unknown` when omitted -- a missing wire-up stays visible in
   * the log instead of vanishing. See `RoadmapAuditRecord.tool`.
   */
  tool?: string;
  roadmapPath: string;
  projectDir: string;
  before: string;
  after: string;
  ops?: RoadmapAuditRecord['ops'];
  allowedDeletions?: string[];
  allowFullRewrite?: boolean;
  sessionId?: string | null;
  deps?: RoadmapAuditDeps;
}): { outcome: RoadmapWriteOutcome; record: RoadmapAuditRecord } {
  const {
    hook,
    tool,
    roadmapPath,
    projectDir,
    before,
    after,
    ops,
    allowedDeletions,
    allowFullRewrite,
    sessionId,
    deps,
  } = args;

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const beforeBytes = Buffer.byteLength(before, 'utf-8');
  const afterBytes = Buffer.byteLength(after, 'utf-8');

  const base = {
    ts: new Date().toISOString(),
    hook,
    tool: tool ?? 'unknown',
    project_dir: projectDir,
    roadmap_path: roadmapPath,
    before_sha256: sha256Prefix16(before),
    after_sha256: sha256Prefix16(after),
    before_lines: beforeLines.length,
    after_lines: afterLines.length,
    line_delta: afterLines.length - beforeLines.length,
    before_bytes: beforeBytes,
    after_bytes: afterBytes,
    bytes_delta: afterBytes - beforeBytes,
    ops,
    session_id: sessionId ?? null,
  };

  const finish = (
    outcome: RoadmapWriteOutcome,
    extra: Partial<RoadmapAuditRecord> = {},
  ): { outcome: RoadmapWriteOutcome; record: RoadmapAuditRecord } => {
    const record: RoadmapAuditRecord = {
      ...base,
      outcome,
      bak_path: null,
      bak_error: null,
      ...extra,
    };
    appendAudit(projectDir, record, deps?.appendLog);
    return { outcome, record };
  };

  // Gate 1: no-op.
  if (after === before) {
    return finish('noop');
  }

  // Gate 1.5: per-project manual opt-out (2026-09-02).
  //
  // A ROADMAP.md that carries `<!-- roadmap-sync: manual -->` is hand-owned.
  // The hooks still record the audit row and still surface session context to
  // the session -- they simply never modify the file. Deliberately placed
  // AFTER the no-op gate so a run that would have changed nothing still
  // reports the more precise `noop`.
  //
  // It lives HERE, in the one function every ROADMAP writer routes through,
  // rather than in each hook: post-plan-roadmap, git-commit-roadmap and
  // prd-roadmap-sync all inherit it from this single check, and any future
  // writer gets it by construction instead of by remembering to add it.
  if (ROADMAP_MANUAL_MARKER.test(before)) {
    return finish('skipped', { reason: 'opt_out_manual' });
  }

  // Gate 2: deletion-free invariant (skipped for the legitimate full-rewrite
  // path, which instead runs the catastrophic backstop below).
  if (!allowFullRewrite) {
    const allowedSet = new Set(allowedDeletions ?? []);
    const removed = computeRemovedLines(beforeLines, afterLines);
    const refused = removed.filter((line) => !allowedSet.has(line));
    if (refused.length > 0) {
      return finish('skipped', {
        reason: 'deletion_guard',
        refused_deletions: refused.slice(0, MAX_REFUSED_DELETIONS),
      });
    }
  } else {
    const beforeTrim = before.trim();
    const afterTrim = after.trim();
    const tooSmall =
      beforeLines.length > 0 && afterLines.length < beforeLines.length * CATASTROPHIC_MIN_RATIO;
    if (beforeTrim !== '' && (afterTrim === '' || tooSmall)) {
      return finish('skipped', { reason: 'catastrophic_rewrite' });
    }
  }

  // Gate 3: pre-image of the BEFORE content, written OUTSIDE the project tree
  // (see roadmapBakPath). Own try/catch -- never blocks the write.
  const bakPath = roadmapBakPath(projectDir);
  let bakError: string | null = null;
  try {
    (deps?.backup ?? defaultBackup)(bakPath, before);
  } catch (err) {
    bakError = err instanceof Error ? err.message : String(err);
  }

  // Gate 4: the write itself, CAS-guarded via mutateStateWithLock. Distinguish
  // the three false-outcome reasons -- see RoadmapWriteResult and defaultWrite.
  let writeResult: RoadmapWriteResult;
  try {
    writeResult = (deps?.write ?? defaultWrite)(roadmapPath, before, after);
  } catch {
    writeResult = { wrote: false, reason: 'write_failed' };
  }

  if (!writeResult.wrote) {
    return finish('skipped', {
      reason: writeResult.reason ?? 'write_failed',
      bak_path: bakPath,
      bak_error: bakError,
      wait_ms: writeResult.wait_ms,
      write_ms: writeResult.write_ms,
    });
  }

  return finish('written', {
    bak_path: bakPath,
    bak_error: bakError,
    wait_ms: writeResult.wait_ms,
    write_ms: writeResult.write_ms,
  });
}

/**
 * Append a follow-up record correlated to an earlier `writeRoadmapGuarded`
 * call by `before_sha256` -- used by git-commit-roadmap to record whether the
 * write it just made was also committed (outcome/`committed`/`commit_hash`
 * fields set by the caller). Same fail-open contract: never throws.
 */
export function appendRoadmapAuditRecord(projectDir: string, record: RoadmapAuditRecord): void {
  appendAudit(projectDir, record);
}
