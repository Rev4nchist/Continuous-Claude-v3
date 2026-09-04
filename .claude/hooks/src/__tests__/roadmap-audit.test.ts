/**
 * Tests for shared/roadmap-audit.ts -- the guarded write path all three
 * ROADMAP-writing hooks are meant to route through instead of raw
 * fs.writeFileSync (plan: `i-was-working-in-composed-manatee`, section 5).
 *
 * Hermetic by design: every case goes through the `deps` seam (write / backup
 * / appendLog), so NOTHING here touches the real filesystem or the real
 * `mutateStateWithLock` lock file. The one exception is the record-shape test,
 * which still injects `deps` but asserts on the returned in-memory record.
 *
 * The deletion-guard refusal test is the most important one in this file --
 * per the plan and the repo's own `vacuous-gate-class` lesson, a guard nobody
 * has seen refuse is not a guard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  writeRoadmapGuarded,
  appendRoadmapAuditRecord,
  roadmapBakPath,
  type RoadmapAuditRecord,
  type RoadmapWriteResult,
} from '../shared/roadmap-audit.js';

const PROJECT_DIR = 'C:/fake/project';
const ROADMAP_PATH = 'C:/fake/project/ROADMAP.md';

/**
 * A single backslash, built from its char code so no layer between here and
 * disk (heredoc, shell, editor) can eat the escape. Used only to normalise
 * Windows separators before comparing paths.
 */
const SEP_BACKSLASH = String.fromCharCode(92);

/** A `deps` bundle that always succeeds, recording every call for assertions. */
function makeSpyDeps() {
  const writeCalls: Array<{ roadmapPath: string; before: string; after: string }> = [];
  const backupCalls: Array<{ bakPath: string; content: string }> = [];
  const logCalls: Array<{ logPath: string; line: string }> = [];

  return {
    writeCalls,
    backupCalls,
    logCalls,
    deps: {
      write: vi.fn((roadmapPath: string, before: string, after: string): RoadmapWriteResult => {
        writeCalls.push({ roadmapPath, before, after });
        return { wrote: true, wait_ms: 1, write_ms: 1 };
      }),
      backup: vi.fn((bakPath: string, content: string) => {
        backupCalls.push({ bakPath, content });
      }),
      appendLog: vi.fn((logPath: string, line: string) => {
        logCalls.push({ logPath, line });
      }),
    },
  };
}

describe('writeRoadmapGuarded -- gate 1: no-op', () => {
  it('identical before/after -> no write, no backup, one noop record', () => {
    const { deps, writeCalls, backupCalls, logCalls } = makeSpyDeps();
    const content = '# ROADMAP\n\n## Current Focus\n- thing\n';

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before: content,
      after: content,
      deps,
    });

    expect(outcome).toBe('noop');
    expect(record.outcome).toBe('noop');
    expect(writeCalls).toHaveLength(0);
    expect(backupCalls).toHaveLength(0);
    expect(logCalls).toHaveLength(1);
    expect(record.before_sha256).toBe(record.after_sha256);
    expect(record.line_delta).toBe(0);
    expect(record.bytes_delta).toBe(0);
  });
});

describe('writeRoadmapGuarded -- a real change', () => {
  it('written: .bak receives the BEFORE content, hashes differ, deltas correct', () => {
    const { deps, writeCalls, backupCalls } = makeSpyDeps();
    const before = 'line1\nline2\nline3\n';
    const after = 'line1\nline2\nline3\nline4\n';

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before,
      after,
      ops: [{ label: 'session-insert', lines_removed: 0, lines_added: 1 }],
      deps,
    });

    expect(outcome).toBe('written');
    expect(record.outcome).toBe('written');
    expect(record.before_sha256).not.toBe(record.after_sha256);
    expect(record.before_sha256).toHaveLength(16);
    expect(record.after_sha256).toHaveLength(16);

    // The pre-image holds the BEFORE content, not the after content, and it
    // lands OUTSIDE the project tree (changed 2026-09-02 -- the old
    // `<roadmapPath>.bak` polluted every project's git status).
    expect(backupCalls).toHaveLength(1);
    expect(backupCalls[0].bakPath).not.toBe(`${ROADMAP_PATH}.bak`);
    expect(backupCalls[0].bakPath.startsWith(PROJECT_DIR)).toBe(false);
    expect(backupCalls[0].content).toBe(before);
    expect(record.bak_path).toBe(backupCalls[0].bakPath);
    expect(record.bak_error).toBeNull();

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]).toEqual({ roadmapPath: ROADMAP_PATH, before, after });

    expect(record.before_lines).toBe(before.split('\n').length);
    expect(record.after_lines).toBe(after.split('\n').length);
    expect(record.line_delta).toBe(1);
    expect(record.bytes_delta).toBe(Buffer.byteLength(after) - Buffer.byteLength(before));
    expect(record.ops).toEqual([{ label: 'session-insert', lines_removed: 0, lines_added: 1 }]);
  });
});

describe('writeRoadmapGuarded -- gate 2: the deletion-free invariant', () => {
  const before = '# ROADMAP\n\n## Current Focus\n- bullet one\n- bullet two\n- bullet three\n';
  // Drops "- bullet two" -- exactly the class of loss this guard exists for.
  const afterMissingLine =
    '# ROADMAP\n\n## Current Focus\n- bullet one\n- bullet three\n';

  it('REFUSES a write that drops one line with an empty allowedDeletions, naming the dropped line', () => {
    const { deps, writeCalls, backupCalls, logCalls } = makeSpyDeps();

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before,
      after: afterMissingLine,
      allowedDeletions: [],
      deps,
    });

    expect(outcome).toBe('skipped');
    expect(record.outcome).toBe('skipped');
    expect(record.reason).toBe('deletion_guard');
    expect(record.refused_deletions).toContain('- bullet two');

    // The file must NOT have been touched.
    expect(writeCalls).toHaveLength(0);
    expect(backupCalls).toHaveLength(0);
    // The refusal itself is still recorded.
    expect(logCalls).toHaveLength(1);
  });

  it('PASSES the exact same case when the dropped line is in allowedDeletions', () => {
    const { deps, writeCalls } = makeSpyDeps();

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before,
      after: afterMissingLine,
      allowedDeletions: ['- bullet two'],
      deps,
    });

    expect(outcome).toBe('written');
    expect(record.refused_deletions).toBeUndefined();
    expect(writeCalls).toHaveLength(1);
  });

  it('does not false-positive on a pure reorder + insertion (multiset, not positional)', () => {
    const { deps } = makeSpyDeps();
    const reordered =
      '# ROADMAP\n\n## Current Focus\n- bullet three\n- bullet one\n- bullet two\n- bullet four\n';

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before,
      after: reordered,
      deps,
    });

    expect(outcome).toBe('written');
    expect(record.reason).toBeUndefined();
  });
});

describe('writeRoadmapGuarded -- gate 2 (full rewrite path): catastrophic backstop', () => {
  it('refuses an empty `after` under allowFullRewrite when before is non-empty', () => {
    const { deps, writeCalls } = makeSpyDeps();
    const before = '# ROADMAP\n\n## Current Focus\n- something\n';

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before,
      after: '',
      allowFullRewrite: true,
      deps,
    });

    expect(outcome).toBe('skipped');
    expect(record.reason).toBe('catastrophic_rewrite');
    expect(writeCalls).toHaveLength(0);
  });

  it('refuses an `after` under 25% of before-lines under allowFullRewrite', () => {
    const { deps, writeCalls } = makeSpyDeps();
    const before = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const after = 'line0\nline1\n'; // well under 25% of 20 lines

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before,
      after,
      allowFullRewrite: true,
      deps,
    });

    expect(outcome).toBe('skipped');
    expect(record.reason).toBe('catastrophic_rewrite');
    expect(writeCalls).toHaveLength(0);
  });

  it('allows a legitimate fresh-file rewrite (before empty) under allowFullRewrite', () => {
    const { deps, writeCalls } = makeSpyDeps();

    const { outcome } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before: '',
      after: '# ROADMAP\n\n## Current Focus\n- new\n',
      allowFullRewrite: true,
      deps,
    });

    expect(outcome).toBe('written');
    expect(writeCalls).toHaveLength(1);
  });

  it('a real deletion NOT flagged by gate 2 would otherwise be caught -- but allowFullRewrite intentionally skips gate 2', () => {
    // This documents the deliberate trade-off: allowFullRewrite bypasses the
    // deletion-free invariant entirely and relies solely on the catastrophic
    // backstop. A small deletion (not catastrophic) is allowed through.
    const { deps, writeCalls } = makeSpyDeps();
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    const after = 'a\nb\nc\nd\ne\nf\ng\n'; // drops "h", but nowhere near 25% threshold

    const { outcome } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before,
      after,
      allowFullRewrite: true,
      deps,
    });

    expect(outcome).toBe('written');
    expect(writeCalls).toHaveLength(1);
  });
});

describe('writeRoadmapGuarded -- gate 4: the write-gate distinguishes three false-outcome reasons', () => {
  const before = 'a\nb\nc\n';
  const after = 'a\nb\nc\nd\n';

  it('lock_timeout: acquired=false surfaces as skipped/lock_timeout with wait_ms', () => {
    const { backupCalls, logCalls } = makeSpyDeps();
    const write = vi.fn(
      (): RoadmapWriteResult => ({ wrote: false, reason: 'lock_timeout', wait_ms: 5000 }),
    );
    const backup = vi.fn((bakPath: string, content: string) => {
      backupCalls.push({ bakPath, content });
    });
    const appendLog = vi.fn((logPath: string, line: string) => {
      logCalls.push({ logPath, line });
    });

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'git-commit-roadmap',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before,
      after,
      deps: { write, backup, appendLog },
    });

    expect(outcome).toBe('skipped');
    expect(record.reason).toBe('lock_timeout');
    expect(record.wait_ms).toBe(5000);
    // .bak still ran (gate 3 precedes gate 4).
    expect(backupCalls).toHaveLength(1);
  });

  it('concurrent_modification: transform declined surfaces distinctly from a lock timeout', () => {
    const write = vi.fn(
      (): RoadmapWriteResult => ({ wrote: false, reason: 'concurrent_modification', wait_ms: 12 }),
    );

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'git-commit-roadmap',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before,
      after,
      deps: { write, backup: vi.fn(), appendLog: vi.fn() },
    });

    expect(outcome).toBe('skipped');
    expect(record.reason).toBe('concurrent_modification');
    expect(record.reason).not.toBe('lock_timeout');
  });

  it('write_failed: lock acquired, transform ran, but the underlying write still failed', () => {
    const write = vi.fn((): RoadmapWriteResult => ({ wrote: false, reason: 'write_failed' }));

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'git-commit-roadmap',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before,
      after,
      deps: { write, backup: vi.fn(), appendLog: vi.fn() },
    });

    expect(outcome).toBe('skipped');
    expect(record.reason).toBe('write_failed');
  });

  it('a throwing write dep degrades to write_failed rather than throwing out', () => {
    const write = vi.fn(() => {
      throw new Error('boom in write');
    });

    expect(() =>
      writeRoadmapGuarded({
        hook: 'git-commit-roadmap',
        roadmapPath: ROADMAP_PATH,
        projectDir: PROJECT_DIR,
        before,
        after,
        deps: { write: write as unknown as () => RoadmapWriteResult, backup: vi.fn(), appendLog: vi.fn() },
      }),
    ).not.toThrow();
  });
});

describe('defaultWrite (real fs, no deps.write) -- absent-file CAS semantics', () => {
  // These two exercise the REAL defaultWrite/mutateStateWithLock path (no
  // deps.write stub) against an absent file on disk. mutateStateWithLock
  // presents `null` for a genuinely-absent file, never `''` -- defaultWrite
  // must normalise that to '' before the `=== before` comparison, or a
  // brand-new project can never get its first ROADMAP.md written. This is
  // exactly the bug the coordinator caught: `null === ''` is false, so
  // without the fix the transform declines and the record lies about why
  // (`concurrent_modification` when nothing was actually concurrent).
  let dir: string;
  let roadmapPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccv3-roadmap-audit-defaultwrite-'));
    roadmapPath = join(dir, 'ROADMAP.md');
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('absent file + before:"" + allowFullRewrite -> written, and the file now holds `after`', () => {
    expect(existsSync(roadmapPath)).toBe(false);
    const after = '# ROADMAP\n\n## Current Focus\n- fresh project\n';

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      roadmapPath,
      projectDir: dir,
      before: '',
      after,
      allowFullRewrite: true,
      // No deps.write -- this is the real defaultWrite/mutateStateWithLock path.
      // backup IS stubbed: the real one writes under ~/.claude/state/roadmap-bak
      // keyed by this tmp dir, and afterEach only removes the tmp dir, so every
      // run left an orphan pre-image dir behind (16 found 2026-09-02).
      deps: { backup: vi.fn() },
    });

    expect(outcome).toBe('written');
    expect(record.reason).toBeUndefined();
    // The proof: the file was actually created on disk with `after`'s content,
    // not silently dropped as a false "concurrent modification".
    expect(existsSync(roadmapPath)).toBe(true);
    expect(readFileSync(roadmapPath, 'utf-8')).toBe(after);
  });

  it('absent file + before:"something non-empty" -> still declines as concurrent_modification (correct asymmetry)', () => {
    expect(existsSync(roadmapPath)).toBe(false);
    // Gate 2 (deletion-free invariant) must pass on the before/after STRINGS
    // the caller supplies -- it does not look at the real file -- so this is
    // a pure append (no line removed) and reaches the write gate cleanly.
    const before = 'a\n';
    const after = 'a\nb\n';

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      roadmapPath,
      projectDir: dir,
      before,
      after,
      // No deps.write -- real defaultWrite/mutateStateWithLock path.
      deps: { backup: vi.fn() }, // see above: keep ~/.claude/state clean
    });

    // Expecting non-empty content but finding an absent file genuinely IS a
    // conflict (the caller's assumed pre-image is wrong) -- this must NOT be
    // treated the same as the legitimate absent-and-expecting-empty case.
    expect(outcome).toBe('skipped');
    expect(record.reason).toBe('concurrent_modification');
    // And, critically, nothing was written.
    expect(existsSync(roadmapPath)).toBe(false);
  });
});

describe('writeRoadmapGuarded -- observability failures never block the write', () => {
  const before = 'a\nb\n';
  const after = 'a\nb\nc\n';

  it('a THROWING backup sink still writes and does not throw out', () => {
    const write = vi.fn((): RoadmapWriteResult => ({ wrote: true }));
    const backup = vi.fn(() => {
      throw new Error('disk full');
    });
    const appendLog = vi.fn();

    let result: ReturnType<typeof writeRoadmapGuarded> | undefined;
    expect(() => {
      result = writeRoadmapGuarded({
        hook: 'prd-roadmap-sync',
        roadmapPath: ROADMAP_PATH,
        projectDir: PROJECT_DIR,
        before,
        after,
        deps: { write, backup, appendLog },
      });
    }).not.toThrow();

    expect(result!.outcome).toBe('written');
    expect(result!.record.bak_error).toBe('disk full');
    expect(write).toHaveBeenCalledTimes(1);
    expect(appendLog).toHaveBeenCalledTimes(1);
  });

  it('a THROWING log sink still writes and does not throw out', () => {
    const write = vi.fn((): RoadmapWriteResult => ({ wrote: true }));
    const backup = vi.fn();
    const appendLog = vi.fn(() => {
      throw new Error('disk full on log');
    });

    let result: ReturnType<typeof writeRoadmapGuarded> | undefined;
    expect(() => {
      result = writeRoadmapGuarded({
        hook: 'prd-roadmap-sync',
        roadmapPath: ROADMAP_PATH,
        projectDir: PROJECT_DIR,
        before,
        after,
        deps: { write, backup, appendLog },
      });
    }).not.toThrow();

    expect(result!.outcome).toBe('written');
    expect(write).toHaveBeenCalledTimes(1);
    expect(backup).toHaveBeenCalledTimes(1);
  });
});

describe('writeRoadmapGuarded -- record shape', () => {
  it('has every required key on the RoadmapAuditRecord contract', () => {
    const { deps } = makeSpyDeps();
    const before = 'a\nb\n';
    const after = 'a\nb\nc\n';

    const { record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      tool: 'ExitPlanMode',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before,
      after,
      sessionId: 'sess-123',
      deps,
    });

    const requiredKeys: Array<keyof RoadmapAuditRecord> = [
      'ts',
      'hook',
      'tool',
      'project_dir',
      'roadmap_path',
      'outcome',
      'before_sha256',
      'after_sha256',
      'before_lines',
      'after_lines',
      'line_delta',
      'before_bytes',
      'after_bytes',
      'bytes_delta',
      'bak_path',
      'bak_error',
      'session_id',
    ];
    for (const key of requiredKeys) {
      expect(record).toHaveProperty(key);
    }
    expect(record.session_id).toBe('sess-123');
    expect(record.hook).toBe('post-plan-roadmap');
    expect(record.project_dir).toBe(PROJECT_DIR);
    expect(record.roadmap_path).toBe(ROADMAP_PATH);
    expect(typeof record.ts).toBe('string');
    expect(() => new Date(record.ts).toISOString()).not.toThrow();
  });

  it('defaults session_id to null when omitted', () => {
    const { deps } = makeSpyDeps();
    const { record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before: 'a\n',
      after: 'a\nb\n',
      deps,
    });
    expect(record.session_id).toBeNull();
  });

  // The `tool` field exists so a future reader can tell which harness tool
  // triggered a write WITHOUT relying on anyone's recollection. It is only
  // worth anything if it survives serialization into the JSONL, so assert on
  // the appended LINE, not just the returned record.
  it('round-trips the triggering tool into the appended log line', () => {
    const { deps, logCalls } = makeSpyDeps();

    const { record } = writeRoadmapGuarded({
      hook: 'git-commit-roadmap',
      tool: 'PowerShell',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before: 'a\n',
      after: 'a\nb\n',
      deps,
    });

    expect(record.tool).toBe('PowerShell');
    expect(logCalls).toHaveLength(1);
    const written = JSON.parse(logCalls[0].line.trim());
    expect(written.tool).toBe('PowerShell');
  });

  // A caller that forgets to pass `tool` must produce a VISIBLE placeholder,
  // never an absent key. An absent key is exactly the blind spot this field
  // was added to close.
  it('records the tool as "unknown" when a caller omits it', () => {
    const { deps } = makeSpyDeps();
    const { record } = writeRoadmapGuarded({
      hook: 'prd-roadmap-sync',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before: 'a\n',
      after: 'a\nb\n',
      deps,
    });
    expect(record.tool).toBe('unknown');
  });
});

describe('appendRoadmapAuditRecord', () => {
  // This export takes no `deps` seam (by design -- it is the simple
  // correlated follow-up append used by git-commit-roadmap after a commit
  // attempt), so these two cases use a real, self-contained temp directory
  // rather than mocking node:fs -- same pattern as atomic-write.test.ts.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccv3-roadmap-audit-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('appends a follow-up record to <projectDir>/.claude/logs/roadmap-sync.jsonl', () => {
    const record: RoadmapAuditRecord = {
      ts: new Date().toISOString(),
      hook: 'git-commit-roadmap',
      tool: 'Bash',
      project_dir: dir,
      roadmap_path: join(dir, 'ROADMAP.md'),
      outcome: 'written',
      before_sha256: 'aaaaaaaaaaaaaaaa',
      after_sha256: 'bbbbbbbbbbbbbbbb',
      before_lines: 1,
      after_lines: 1,
      line_delta: 0,
      before_bytes: 1,
      after_bytes: 1,
      bytes_delta: 0,
      committed: true,
      commit_hash: 'deadbeef',
    };

    appendRoadmapAuditRecord(dir, record);

    const logPath = join(dir, '.claude', 'logs', 'roadmap-sync.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    expect(parsed.commit_hash).toBe('deadbeef');
    expect(parsed.committed).toBe(true);
  });

  it('never throws even when the target path cannot be created (fail-open)', () => {
    // A NUL byte makes mkdirSync/appendFileSync fail on every platform.
    const badProjectDir = join(dir, 'bad\0path');
    const record: RoadmapAuditRecord = {
      ts: new Date().toISOString(),
      hook: 'git-commit-roadmap',
      tool: 'PowerShell',
      project_dir: badProjectDir,
      roadmap_path: ROADMAP_PATH,
      outcome: 'written',
      before_sha256: 'aaaaaaaaaaaaaaaa',
      after_sha256: 'bbbbbbbbbbbbbbbb',
      before_lines: 1,
      after_lines: 1,
      line_delta: 0,
      before_bytes: 1,
      after_bytes: 1,
      bytes_delta: 0,
    };

    expect(() => appendRoadmapAuditRecord(badProjectDir, record)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Regression: the two REAL clobber incidents gate 2 exists to refuse.
//
// Added 2026-09-02. These are not hypotheticals -- both happened, in named
// repos, on named dates, and both are what edbbe2d's deletion-free invariant
// was built for. A guard nobody has seen refuse is not a guard
// (repo lesson: vacuous-gate-class), and a guard whose refusal is not pinned
// by a test can be silently weakened by the next refactor.
// ---------------------------------------------------------------------------
describe('writeRoadmapGuarded -- gate 2 regression: the real incidents', () => {
  it('agent-arch 2026-07-16: refuses replacing a 329-line tracker with an 18-line summary', () => {
    const { deps, writeCalls, backupCalls } = makeSpyDeps();

    // 329 lines of hand-maintained tracker.
    const before = Array.from({ length: 329 }, (_, i) => `- tracker row ${i + 1}`).join('\n');
    // The 18-line "summary" that replaced it.
    const after = Array.from({ length: 18 }, (_, i) => `- summary line ${i + 1}`).join('\n');

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      tool: 'ExitPlanMode',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before,
      after,
      deps,
    });

    expect(outcome).toBe('skipped');
    expect(record.reason).toBe('deletion_guard');
    expect(writeCalls).toHaveLength(0);
    // Gate 2 runs BEFORE gate 3, so a refused write leaves no pre-image behind.
    expect(backupCalls).toHaveLength(0);
    expect(record.refused_deletions!.length).toBeGreaterThan(0);
  });

  it('fourth-netsuite-mcp 2026-07-29: refuses a write that deletes 67 lines while adding others', () => {
    const { deps, writeCalls } = makeSpyDeps();

    // The shape that defeats a percentage-shrink check: the file GROWS overall
    // (+80 added vs 67 removed) while 67 real lines silently vanish.
    const kept = Array.from({ length: 120 }, (_, i) => `- kept line ${i + 1}`);
    const doomed = Array.from({ length: 67 }, (_, i) => `- hand-written note ${i + 1}`);
    const added = Array.from({ length: 80 }, (_, i) => `- generated line ${i + 1}`);

    const before = [...kept, ...doomed].join('\n');
    const after = [...kept, ...added].join('\n');

    // Guard against the test lying to itself: this must be a NET GROWTH write,
    // otherwise it is not reproducing the incident that motivated the invariant.
    expect(after.split('\n').length).toBeGreaterThan(before.split('\n').length);

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      tool: 'ExitPlanMode',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before,
      after,
      deps,
    });

    expect(outcome).toBe('skipped');
    expect(record.reason).toBe('deletion_guard');
    expect(writeCalls).toHaveLength(0);
    expect(record.refused_deletions).toContain('- hand-written note 1');
  });
});

// ---------------------------------------------------------------------------
// Defect 1 (2026-09-02): the pre-image must NOT land in the project tree.
//
// `<roadmapPath>.bak` is untracked and not gitignored, so every guarded write
// left a file in `git status` of whatever project the hook fired in.
// ---------------------------------------------------------------------------
describe('writeRoadmapGuarded -- gate 3: pre-image lives outside the project tree', () => {
  it('does not write the pre-image next to ROADMAP.md', () => {
    const { deps, backupCalls } = makeSpyDeps();

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      tool: 'ExitPlanMode',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before: '# ROADMAP\n\n- one\n',
      after: '# ROADMAP\n\n- one\n- two\n',
      deps,
    });

    expect(outcome).toBe('written');
    expect(backupCalls).toHaveLength(1);

    const bakPath = backupCalls[0].bakPath.split(SEP_BACKSLASH).join('/');

    // The actual defect: the old code produced `<roadmapPath>.bak`.
    expect(bakPath).not.toBe(`${ROADMAP_PATH}.bak`);
    // Nothing may be written anywhere under the project directory.
    expect(bakPath.startsWith(PROJECT_DIR)).toBe(false);
    // And the audit row must point at wherever it really went.
    expect(record.bak_path!.split(SEP_BACKSLASH).join('/')).toBe(bakPath);
  });

  it('namespaces the pre-image by project so two projects cannot collide', () => {
    const a = makeSpyDeps();
    const b = makeSpyDeps();

    writeRoadmapGuarded({
      hook: 'post-plan-roadmap', roadmapPath: 'C:/repos/alpha/ROADMAP.md',
      projectDir: 'C:/repos/alpha', before: '- a\n', after: '- a\n- b\n', deps: a.deps,
    });
    writeRoadmapGuarded({
      hook: 'post-plan-roadmap', roadmapPath: 'C:/repos/beta/ROADMAP.md',
      projectDir: 'C:/repos/beta', before: '- a\n', after: '- a\n- b\n', deps: b.deps,
    });

    const pathA = a.backupCalls[0].bakPath.split(SEP_BACKSLASH).join('/');
    const pathB = b.backupCalls[0].bakPath.split(SEP_BACKSLASH).join('/');
    expect(pathA).not.toBe(pathB);
    expect(pathA).toContain('alpha');
    expect(pathB).toContain('beta');
  });

  // Regression (2026-09-03, CodeRabbit on PR #35). The name resolved only to
  // the millisecond, so two guarded writes against the SAME project in the
  // same millisecond produced one path -- and since the pre-image is written
  // before the CAS write, the second process overwrote the first one's backup.
  // Both audit rows then named the same file and one recoverable version was
  // lost. Passing a fixed `when` makes the collision deterministic instead of
  // relying on winning a race.
  it('does not collide when two writes share a project AND a millisecond', () => {
    const when = new Date('2026-09-03T10:00:00.000Z');

    const paths = new Set(
      Array.from({ length: 50 }, () => roadmapBakPath(PROJECT_DIR, when)),
    );

    expect(paths.size).toBe(50);
  });

  it('still sorts by time, so rotation drops the oldest pre-image first', () => {
    // rotateBaks sorts filenames lexicographically and keeps the newest N, so
    // the collision suffix has to trail the timestamp, never lead it.
    const earlier = roadmapBakPath(PROJECT_DIR, new Date('2026-09-03T10:00:00.000Z'));
    const later = roadmapBakPath(PROJECT_DIR, new Date('2026-09-03T10:00:00.001Z'));

    const nameOf = (p: string) => p.split(SEP_BACKSLASH).join('/').split('/').pop()!;

    expect(nameOf(earlier) < nameOf(later)).toBe(true);
  });

  it('a backup failure still never blocks the write', () => {
    const { deps, writeCalls } = makeSpyDeps();
    deps.backup = vi.fn(() => { throw new Error('disk full'); });

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap', roadmapPath: ROADMAP_PATH, projectDir: PROJECT_DIR,
      before: '- one\n', after: '- one\n- two\n', deps,
    });

    expect(outcome).toBe('written');
    expect(writeCalls).toHaveLength(1);
    expect(record.bak_error).toBe('disk full');
  });
});

// ---------------------------------------------------------------------------
// Defect 2b (2026-09-02): per-project opt-out.
//
// A hand-maintained ROADMAP.md can declare itself off-limits to the sync hooks
// with a marker comment. The hooks then still record the audit row and still
// surface session context -- they just never touch the file. Placed in
// writeRoadmapGuarded (not in one hook) so ALL writers inherit it: that is the
// defect-3 requirement satisfied in one place rather than five.
// ---------------------------------------------------------------------------
describe('writeRoadmapGuarded -- gate 0: per-project manual opt-out', () => {
  const MARKER = '<!-- roadmap-sync: manual -->';

  it('refuses to write a ROADMAP that declares itself manual, but still audits', () => {
    const { deps, writeCalls, backupCalls, logCalls } = makeSpyDeps();
    const before = `# ROADMAP\n${MARKER}\n\n## Current Focus\n- hand written\n`;

    const { outcome, record } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap',
      tool: 'ExitPlanMode',
      roadmapPath: ROADMAP_PATH,
      projectDir: PROJECT_DIR,
      before,
      after: `${before}\n### 2026-09-02: Some Plan\n`,
      deps,
    });

    expect(outcome).toBe('skipped');
    expect(record.reason).toBe('opt_out_manual');
    expect(writeCalls).toHaveLength(0);
    expect(backupCalls).toHaveLength(0);
    // The audit row is the whole point -- an opt-out must stay observable.
    expect(logCalls).toHaveLength(1);
  });

  it('tolerates spacing and case in the marker', () => {
    for (const marker of [
      '<!--roadmap-sync:manual-->',
      '<!--   roadmap-sync:   manual   -->',
      '<!-- ROADMAP-SYNC: MANUAL -->',
    ]) {
      const { deps } = makeSpyDeps();
      const before = `# ROADMAP\n${marker}\n\n- x\n`;
      const { outcome, record } = writeRoadmapGuarded({
        hook: 'post-plan-roadmap', roadmapPath: ROADMAP_PATH, projectDir: PROJECT_DIR,
        before, after: `${before}- y\n`, deps,
      });
      expect(outcome, `marker: ${marker}`).toBe('skipped');
      expect(record.reason, `marker: ${marker}`).toBe('opt_out_manual');
    }
  });

  it('a ROADMAP without the marker is written normally', () => {
    const { deps, writeCalls } = makeSpyDeps();
    const before = '# ROADMAP\n\n## Current Focus\n- hand written\n';
    const { outcome } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap', roadmapPath: ROADMAP_PATH, projectDir: PROJECT_DIR,
      before, after: `${before}- more\n`, deps,
    });
    expect(outcome).toBe('written');
    expect(writeCalls).toHaveLength(1);
  });

  it('does not fire on prose that merely mentions the marker name', () => {
    const { deps } = makeSpyDeps();
    const before = '# ROADMAP\n\n- We considered a roadmap-sync manual mode.\n';
    const { outcome } = writeRoadmapGuarded({
      hook: 'post-plan-roadmap', roadmapPath: ROADMAP_PATH, projectDir: PROJECT_DIR,
      before, after: `${before}- more\n`, deps,
    });
    expect(outcome).toBe('written');
  });
});
