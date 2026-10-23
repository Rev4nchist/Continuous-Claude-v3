/**
 * Tests for the telemetry-hardening additions to the L0 observability appender
 * (WS-2 Phase B): secret redaction, size-based rotation, and retention prune.
 *
 * These extend the base contract in intel-bus.test.ts WITHOUT changing it. The
 * base 12 tests still pass unchanged (the 4 KB cap, newline-strip, fail-open,
 * ts/schema stamping, and append/now/projectDir seams all stay intact).
 *
 * Three new behaviors under test:
 *  1. Secret redaction -- secrets never reach disk; redaction runs before the
 *     newline-strip and size-cap. OpenAI keys, AWS access key ids, DB URLs with
 *     creds, and generic SECRET/TOKEN/PASSWORD/... assignments are masked.
 *  2. Size-based rotation -- when the live file is >= MAX_INTEL_BUS_BYTES, the
 *     file is rotated to intel-bus.jsonl.1 and a fresh file is started. No data
 *     is lost across the boundary; the live file stays under the cap.
 *  3. Retention prune -- pruneIntelBus deletes rotated files older than maxAgeMs
 *     (default 7 days), best-effort, never throwing.
 *
 * Tests inject `append` / `size` / `rename` / `unlink` / `now` seams rather than
 * touching real disk, matching the injected-dependency style already used by
 * appendIntelBus. Runner is vitest; ASCII only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  appendIntelBus,
  pruneIntelBus,
  intelBusPath,
  MAX_INTEL_BUS_BYTES,
  type IntelBusEvent,
} from '../shared/intel-bus.js';

// ---------------------------------------------------------------------------
// A capturing append seam: records (path, line) pairs without touching disk.
// ---------------------------------------------------------------------------
function makeCapture() {
  const lines: { path: string; line: string }[] = [];
  const append = (path: string, line: string) => {
    lines.push({ path, line });
  };
  return { lines, append };
}

/**
 * An in-memory file system over the two intel-bus paths. Models the live file
 * and its .1 rotation generation so rotation/prune can be tested deterministically.
 */
function makeFakeFs(initial: Record<string, string> = {}) {
  const files: Record<string, string> = { ...initial };
  const mtimes: Record<string, number> = {};

  const norm = (p: string) => p.replace(/\\/g, '/');

  const append = (path: string, line: string) => {
    const k = norm(path);
    files[k] = (files[k] ?? '') + line;
  };
  const size = (path: string): number => {
    const k = norm(path);
    if (!(k in files)) throw new Error('ENOENT');
    return Buffer.byteLength(files[k], 'utf-8');
  };
  const rename = (from: string, to: string) => {
    const f = norm(from);
    const t = norm(to);
    if (!(f in files)) throw new Error('ENOENT');
    files[t] = files[f];
    if (t in mtimes || true) mtimes[t] = mtimes[f] ?? Date.now();
    delete files[f];
    delete mtimes[f];
  };
  const unlink = (path: string) => {
    const k = norm(path);
    if (!(k in files)) throw new Error('ENOENT');
    delete files[k];
    delete mtimes[k];
  };
  const setMtime = (path: string, ms: number) => {
    mtimes[norm(path)] = ms;
  };
  const mtime = (path: string): number => {
    const k = norm(path);
    if (!(k in files)) throw new Error('ENOENT');
    return mtimes[k] ?? 0;
  };

  return { files, append, size, rename, unlink, setMtime, mtime, norm };
}

const FIXED_NOW = () => '2026-06-01T12:00:00.000Z';
const PROJ = 'C:/tmp/proj';
const LIVE = intelBusPath(PROJ).replace(/\\/g, '/');
const ROT1 = LIVE + '.1';
const ROT2 = LIVE + '.2';

let saved: string | undefined;
let savedMax: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = PROJ;
  savedMax = process.env.CCV3_INTEL_BUS_MAX_BYTES;
  delete process.env.CCV3_INTEL_BUS_MAX_BYTES;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = saved;
  if (savedMax === undefined) delete process.env.CCV3_INTEL_BUS_MAX_BYTES;
  else process.env.CCV3_INTEL_BUS_MAX_BYTES = savedMax;
});

// ===========================================================================
// Change 1 -- Secret redaction
// ===========================================================================
describe('appendIntelBus -- secret redaction', () => {
  it('redacts an OpenAI key and DB creds before they reach disk', () => {
    const { lines, append } = makeCapture();
    appendIntelBus(
      {
        bus_id: 'abc123',
        // arbitrary string field via the open index signature -- the leak surface
        note: 'OPENAI_API_KEY=sk-proj-ABC123XYZ456789012 and ' +
          'DATABASE_URL=postgresql://claude:claude_dev@localhost:5432/continuous_claude' as string,
      },
      { append, now: FIXED_NOW },
    );
    expect(lines).toHaveLength(1);
    const raw = lines[0].line;
    // the raw secrets must NOT appear anywhere on the written line
    expect(raw).not.toContain('sk-proj-ABC123XYZ456789012');
    expect(raw).not.toContain('claude_dev');
    // and a redaction marker IS present
    expect(raw).toContain('[REDACTED]');
    // line still round-trips
    expect(() => JSON.parse(raw.slice(0, -1))).not.toThrow();
  });

  it('redacts a bare AWS access key id', () => {
    const { lines, append } = makeCapture();
    appendIntelBus(
      { bus_id: 'abc123', note: 'creds AKIAIOSFODNN7EXAMPLE leaked' as string },
      { append, now: FIXED_NOW },
    );
    const raw = lines[0].line;
    expect(raw).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(raw).toContain('[REDACTED-AWS-KEY]');
  });

  it('redacts an OpenAI key that appears without an assignment', () => {
    const { lines, append } = makeCapture();
    appendIntelBus(
      { bus_id: 'abc123', note: 'token sk-ABCDEFGHIJ1234567890 here' as string },
      { append, now: FIXED_NOW },
    );
    const raw = lines[0].line;
    expect(raw).not.toContain('sk-ABCDEFGHIJ1234567890');
    expect(raw).toContain('sk-[REDACTED]');
  });

  it('redacts a generic SECRET= assignment value only', () => {
    const { lines, append } = makeCapture();
    appendIntelBus(
      { bus_id: 'abc123', note: 'MY_SECRET=hunter2supersecret done' as string },
      { append, now: FIXED_NOW },
    );
    const raw = lines[0].line;
    const parsed = JSON.parse(raw.slice(0, -1));
    expect(parsed.note).not.toContain('hunter2supersecret');
    expect(parsed.note).toContain('[REDACTED]');
    // surrounding text preserved
    expect(parsed.note).toContain('done');
  });

  it('redacts a bare postgres URL with creds anywhere in the string', () => {
    const { lines, append } = makeCapture();
    appendIntelBus(
      { bus_id: 'abc123', note: 'conn postgres://u:p@host:5432/db ready' as string },
      { append, now: FIXED_NOW },
    );
    const raw = lines[0].line;
    const parsed = JSON.parse(raw.slice(0, -1));
    expect(parsed.note).not.toContain('u:p@');
    expect(parsed.note).toContain('[REDACTED]');
  });

  it('leaves a benign field (a file path) untouched', () => {
    const { lines, append } = makeCapture();
    const path = '~/continuous-claude/.claude/hooks/src/shared/intel-bus.ts';
    appendIntelBus(
      { bus_id: 'abc123', subject_id: path },
      { append, now: FIXED_NOW },
    );
    const parsed = JSON.parse(lines[0].line.slice(0, -1));
    expect(parsed.subject_id).toBe(path);
  });

  it('recurses into nested arrays and objects', () => {
    const { lines, append } = makeCapture();
    appendIntelBus(
      {
        bus_id: 'abc123',
        bus_updates: ['TOKEN=ghp_aaaaaaaaaaaaaaaaaaaa'],
        corpus_signature: { detail: 'PASSWORD=p4ssw0rd!' },
      } as IntelBusEvent,
      { append, now: FIXED_NOW },
    );
    const parsed = JSON.parse(lines[0].line.slice(0, -1));
    expect(JSON.stringify(parsed)).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaa');
    expect(JSON.stringify(parsed)).not.toContain('p4ssw0rd!');
    expect(JSON.stringify(parsed)).toContain('[REDACTED]');
  });

  it('redaction runs before the size cap (a secret-laden oversized event is not corrupted)', () => {
    const { lines, append } = makeCapture();
    const huge = 'sk-proj-' + 'A'.repeat(MAX_INTEL_BUS_BYTES); // far over 4 KB
    expect(() =>
      appendIntelBus({ bus_id: 'abc123', note: huge as string }, { append, now: FIXED_NOW }),
    ).not.toThrow();
    for (const { line } of lines) {
      // whatever was written parses cleanly and does not contain the raw run
      expect(() => JSON.parse(line.slice(0, -1))).not.toThrow();
    }
  });
});

// ===========================================================================
// Change 1b -- Secret redaction: cross-model review hardening (F1/F2/F4)
// ===========================================================================
describe('appendIntelBus -- secret redaction (cross-model hardening)', () => {
  it('F1: does not leak the tail of a secret value past a delimiter', () => {
    // A DB password containing `;` must not split the redaction and leak `ss@host`.
    const { lines, append } = makeCapture();
    appendIntelBus(
      { bus_id: 'abc123', note: 'DATABASE_URL=postgresql://user:p;ss@db.internal/app' },
      { append, now: FIXED_NOW },
    );
    const parsed = JSON.parse(lines[0].line.slice(0, -1));
    expect(parsed.note).not.toContain('ss@db.internal');
    expect(parsed.note).not.toContain('p;ss');
    expect(parsed.note).not.toContain('db.internal');
    expect(parsed.note).toContain('[REDACTED]');
  });

  it('F2: redacts a GitHub token carried in a free-text Authorization header', () => {
    const { lines, append } = makeCapture();
    const tok = 'ghp_' + 'a'.repeat(36);
    appendIntelBus(
      { bus_id: 'abc123', note: 'Authorization: Bearer ' + tok },
      { append, now: FIXED_NOW },
    );
    const parsed = JSON.parse(lines[0].line.slice(0, -1));
    expect(parsed.note).not.toContain(tok);
    expect(parsed.note).toContain('[REDACTED]');
  });

  it('F2: redacts Slack and JWT tokens by shape', () => {
    const { lines, append } = makeCapture();
    // Split the literal so secret-scanners don't flag this synthetic fixture
    // (same runtime value; mirrors the 'ghp_' + ... pattern in the F2 test above).
    const slack = 'xoxb-' + '1234567890-abcdefghijklmnop';
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    appendIntelBus({ bus_id: 'abc123', note: slack + ' ' + jwt }, { append, now: FIXED_NOW });
    const parsed = JSON.parse(lines[0].line.slice(0, -1));
    expect(parsed.note).not.toContain(slack);
    expect(parsed.note).not.toContain(jwt);
    expect(parsed.note).toContain('[REDACTED');
  });

  it('F4: redacts an opaque value (no shape) under a credential-named field', () => {
    const { lines, append } = makeCapture();
    appendIntelBus(
      { bus_id: 'abc123', password: 'hunter2-no-recognizable-shape' } as IntelBusEvent,
      { append, now: FIXED_NOW },
    );
    const parsed = JSON.parse(lines[0].line.slice(0, -1));
    expect(parsed.password).toBe('[REDACTED]');
  });

  it('does NOT over-redact credential-substring fields that are not secrets', () => {
    // `token_count` ends in count, `subject_id` ends in id -> not credentials.
    const { lines, append } = makeCapture();
    appendIntelBus(
      { bus_id: 'abc123', token_count: '50', subject_id: 'foo.bar.baz' } as IntelBusEvent,
      { append, now: FIXED_NOW },
    );
    const parsed = JSON.parse(lines[0].line.slice(0, -1));
    expect(parsed.token_count).toBe('50');
    expect(parsed.subject_id).toBe('foo.bar.baz');
  });
});

// ===========================================================================
// Change 1c -- Secret redaction: session-3 review hardening (Codex #2/#3)
// ===========================================================================
describe('appendIntelBus -- secret redaction (session-3 hardening)', () => {
  it('Codex#2: redacts an OPAQUE Bearer token (no shape) in an Authorization header', () => {
    // ASSIGNMENT_RE used to consume "Bearer" as Authorization's value, leaving the
    // opaque token, and the Bearer SHAPE could no longer match it. Shapes now run
    // BEFORE the assignment pass so the token is caught regardless of the header.
    const { lines, append } = makeCapture();
    const opaque = 'abcDEF123456ghiJKL789mnoPQRstu'; // no sk-/gh-/xox-/jwt shape
    appendIntelBus(
      { bus_id: 'abc123', note: 'Authorization: Bearer ' + opaque },
      { append, now: FIXED_NOW },
    );
    const parsed = JSON.parse(lines[0].line.slice(0, -1));
    expect(parsed.note).not.toContain(opaque);
    expect(parsed.note).toContain('[REDACTED]');
  });

  it('Codex#3: redacts opaque secrets inside an ARRAY under a credential-named field', () => {
    // redactSecretsDeep dropped keyHint when recursing into arrays, so an array of
    // opaque secrets under e.g. `tokens` survived. keyHint now threads through.
    const { lines, append } = makeCapture();
    appendIntelBus(
      {
        bus_id: 'abc123',
        tokens: ['opaque-no-shape-aaaa', 'opaque-no-shape-bbbb'],
      } as IntelBusEvent,
      { append, now: FIXED_NOW },
    );
    const parsed = JSON.parse(lines[0].line.slice(0, -1));
    const blob = JSON.stringify(parsed.tokens);
    expect(blob).not.toContain('opaque-no-shape-aaaa');
    expect(blob).not.toContain('opaque-no-shape-bbbb');
    expect(blob).toContain('[REDACTED]');
  });

  it('does NOT over-redact a benign array under a non-credential field', () => {
    const { lines, append } = makeCapture();
    appendIntelBus(
      { bus_id: 'abc123', edited_files: ['a.ts', 'b.ts'] } as IntelBusEvent,
      { append, now: FIXED_NOW },
    );
    const parsed = JSON.parse(lines[0].line.slice(0, -1));
    expect(parsed.edited_files).toEqual(['a.ts', 'b.ts']);
  });

  it('fix-review: still redacts a secret assignment with MANY spaces around the separator', () => {
    // Guards the fix-review codex finding: bounding the ASSIGNMENT_RE separator to
    // {0,40} would let a `KEY  :  VALUE` with 41+ spaces leak. The separator stays
    // `\s*` (it is never the ReDoS surface -- the {1,2048} VALUE bound is).
    const { lines, append } = makeCapture();
    appendIntelBus(
      { bus_id: 'abc123', note: 'api_key' + ' '.repeat(50) + '= opaque_value_here' },
      { append, now: FIXED_NOW },
    );
    const parsed = JSON.parse(lines[0].line.slice(0, -1));
    expect(parsed.note).not.toContain('opaque_value_here');
    expect(parsed.note).toContain('[REDACTED]');
  });
});

// ===========================================================================
// Change 4 -- Kill switch gates the appender (critic F6)
// ===========================================================================
describe('appendIntelBus -- CCV3_BUS_OFF kill switch', () => {
  it('writes nothing when CCV3_BUS_OFF=1 (plan property: kills ALL bus I/O)', () => {
    const { lines, append } = makeCapture();
    const prev = process.env.CCV3_BUS_OFF;
    process.env.CCV3_BUS_OFF = '1';
    try {
      appendIntelBus(
        { bus_id: 'abc123', query_type: 'should_not_write' },
        { append, now: FIXED_NOW },
      );
    } finally {
      if (prev === undefined) delete process.env.CCV3_BUS_OFF;
      else process.env.CCV3_BUS_OFF = prev;
    }
    expect(lines).toHaveLength(0);
  });

  it('writes normally when CCV3_BUS_OFF is unset', () => {
    const { lines, append } = makeCapture();
    const prev = process.env.CCV3_BUS_OFF;
    delete process.env.CCV3_BUS_OFF;
    try {
      appendIntelBus({ bus_id: 'abc123', query_type: 'writes' }, { append, now: FIXED_NOW });
    } finally {
      if (prev !== undefined) process.env.CCV3_BUS_OFF = prev;
    }
    expect(lines).toHaveLength(1);
  });
});

// ===========================================================================
// Change 2 -- Size-based rotation
// ===========================================================================
describe('appendIntelBus -- size-based rotation', () => {
  it('exports a numeric default cap', () => {
    expect(typeof MAX_INTEL_BUS_BYTES).toBe('number');
    expect(MAX_INTEL_BUS_BYTES).toBe(2_000_000);
  });

  it('rotates live -> .1 when the live file is at/over the cap, then appends fresh', () => {
    const fs = makeFakeFs();
    // pre-seed the live file so it already exceeds a tiny cap
    fs.files[LIVE] = 'x'.repeat(500) + '\n';
    process.env.CCV3_INTEL_BUS_MAX_BYTES = '100';

    appendIntelBus(
      { bus_id: 'abc123', query_type: 'after_rotation' },
      { append: fs.append, size: fs.size, rename: fs.rename, now: FIXED_NOW, projectDir: PROJ },
    );

    // .1 now holds the pre-rotation content
    expect(fs.files[ROT1]).toBeDefined();
    expect(fs.files[ROT1]).toContain('x'.repeat(500));
    // live file holds ONLY the post-rotation row
    expect(fs.files[LIVE]).toBeDefined();
    expect(fs.files[LIVE]).not.toContain('x'.repeat(500));
    expect(fs.files[LIVE]).toContain('after_rotation');
  });

  it('replaces an existing .1 on rotation (single-generation)', () => {
    const fs = makeFakeFs();
    fs.files[ROT1] = 'OLD-GEN\n';
    fs.files[LIVE] = 'y'.repeat(500) + '\n';
    process.env.CCV3_INTEL_BUS_MAX_BYTES = '100';

    appendIntelBus(
      { bus_id: 'abc123', query_type: 'gen2' },
      { append: fs.append, size: fs.size, rename: fs.rename, now: FIXED_NOW, projectDir: PROJ },
    );

    // old .1 content is gone; .1 now has the prior live content
    expect(fs.files[ROT1]).not.toContain('OLD-GEN');
    expect(fs.files[ROT1]).toContain('y'.repeat(500));
  });

  it('does not rotate when the live file is under the cap', () => {
    const fs = makeFakeFs();
    fs.files[LIVE] = 'small\n';
    process.env.CCV3_INTEL_BUS_MAX_BYTES = '1000000';

    appendIntelBus(
      { bus_id: 'abc123', query_type: 'no_rotate' },
      { append: fs.append, size: fs.size, rename: fs.rename, now: FIXED_NOW, projectDir: PROJ },
    );

    expect(fs.files[ROT1]).toBeUndefined();
    expect(fs.files[LIVE]).toContain('small');
    expect(fs.files[LIVE]).toContain('no_rotate');
  });

  it('treats a missing live file as size 0 (first write, no rotation, no throw)', () => {
    const fs = makeFakeFs();
    process.env.CCV3_INTEL_BUS_MAX_BYTES = '100';

    expect(() =>
      appendIntelBus(
        { bus_id: 'abc123', query_type: 'first' },
        { append: fs.append, size: fs.size, rename: fs.rename, now: FIXED_NOW, projectDir: PROJ },
      ),
    ).not.toThrow();
    expect(fs.files[ROT1]).toBeUndefined();
    expect(fs.files[LIVE]).toContain('first');
  });

  it('a 10k-write loop with a small cap keeps the LIVE file under the cap and loses no rows', () => {
    const fs = makeFakeFs();
    const cap = 5000;
    process.env.CCV3_INTEL_BUS_MAX_BYTES = String(cap);

    const N = 10_000;
    for (let i = 0; i < N; i++) {
      appendIntelBus(
        { bus_id: 'abc123', result_count: i },
        { append: fs.append, size: fs.size, rename: fs.rename, now: FIXED_NOW, projectDir: PROJ },
      );
    }

    // live file is bounded
    const liveBytes = Buffer.byteLength(fs.files[LIVE] ?? '', 'utf-8');
    expect(liveBytes).toBeLessThanOrEqual(cap);

    // no rows lost across the single rotation boundary: live + .1 together hold
    // a contiguous tail ending at the last write, and the last write is present.
    const liveRows = (fs.files[LIVE] ?? '').trim().split('\n').filter(Boolean);
    const rot1Rows = (fs.files[ROT1] ?? '').trim().split('\n').filter(Boolean);
    const all = [...rot1Rows, ...liveRows].map((l) => JSON.parse(l).result_count);
    // last write present
    expect(all[all.length - 1]).toBe(N - 1);
    // contiguous (monotonic, step 1) across the boundary -- nothing dropped between .1 and live
    for (let j = 1; j < all.length; j++) {
      expect(all[j]).toBe(all[j - 1] + 1);
    }
  });

  it('fails open if rotation throws: still attempts the append', () => {
    const fs = makeFakeFs();
    fs.files[LIVE] = 'z'.repeat(500) + '\n';
    process.env.CCV3_INTEL_BUS_MAX_BYTES = '100';
    const throwingRename = () => {
      throw new Error('EPERM: rename failed');
    };

    expect(() =>
      appendIntelBus(
        { bus_id: 'abc123', query_type: 'rotate_failed_but_append' },
        { append: fs.append, size: fs.size, rename: throwingRename, now: FIXED_NOW, projectDir: PROJ },
      ),
    ).not.toThrow();
    // append still happened (to the live file, since rotation failed)
    expect(fs.files[LIVE]).toContain('rotate_failed_but_append');
  });

  it('fails open if size() throws: skips rotation, still appends', () => {
    const fs = makeFakeFs();
    const throwingSize = () => {
      throw new Error('ENOENT-but-not-handled');
    };
    expect(() =>
      appendIntelBus(
        { bus_id: 'abc123', query_type: 'size_threw' },
        { append: fs.append, size: throwingSize, rename: fs.rename, now: FIXED_NOW, projectDir: PROJ },
      ),
    ).not.toThrow();
    expect(fs.files[LIVE]).toContain('size_threw');
  });
});

// ===========================================================================
// Change 3 -- Retention prune
// ===========================================================================
describe('pruneIntelBus -- retention of rotated files', () => {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const NOW_MS = 1_000_000_000_000; // fixed epoch for determinism

  it('removes a .1 whose mtime is older than maxAgeMs', () => {
    const fs = makeFakeFs();
    fs.files[ROT1] = 'old\n';
    fs.setMtime(ROT1, NOW_MS - SEVEN_DAYS - 1000); // older than 7d

    pruneIntelBus({
      projectDir: PROJ,
      now: () => NOW_MS,
      stat: (p) => ({ mtimeMs: fs.mtime(p) }),
      unlink: fs.unlink,
    });

    expect(fs.files[ROT1]).toBeUndefined();
  });

  it('keeps a fresh .1 (mtime within maxAgeMs)', () => {
    const fs = makeFakeFs();
    fs.files[ROT1] = 'fresh\n';
    fs.setMtime(ROT1, NOW_MS - 1000); // very recent

    pruneIntelBus({
      projectDir: PROJ,
      now: () => NOW_MS,
      stat: (p) => ({ mtimeMs: fs.mtime(p) }),
      unlink: fs.unlink,
    });

    expect(fs.files[ROT1]).toBe('fresh\n');
  });

  it('also prunes a stale .2 generation if present', () => {
    const fs = makeFakeFs();
    fs.files[ROT2] = 'old2\n';
    fs.setMtime(ROT2, NOW_MS - SEVEN_DAYS - 1000);

    pruneIntelBus({
      projectDir: PROJ,
      now: () => NOW_MS,
      stat: (p) => ({ mtimeMs: fs.mtime(p) }),
      unlink: fs.unlink,
    });

    expect(fs.files[ROT2]).toBeUndefined();
  });

  it('is a no-op when no rotated files exist', () => {
    const fs = makeFakeFs();
    const removed: string[] = [];
    expect(() =>
      pruneIntelBus({
        projectDir: PROJ,
        now: () => NOW_MS,
        stat: (p) => ({ mtimeMs: fs.mtime(p) }), // throws ENOENT for absent files
        unlink: (p) => {
          removed.push(p);
          fs.unlink(p);
        },
      }),
    ).not.toThrow();
    expect(removed).toHaveLength(0);
  });

  it('never throws even if unlink throws (best-effort)', () => {
    const fs = makeFakeFs();
    fs.files[ROT1] = 'old\n';
    fs.setMtime(ROT1, NOW_MS - SEVEN_DAYS - 1000);
    const throwingUnlink = () => {
      throw new Error('EPERM');
    };
    expect(() =>
      pruneIntelBus({
        projectDir: PROJ,
        now: () => NOW_MS,
        stat: (p) => ({ mtimeMs: fs.mtime(p) }),
        unlink: throwingUnlink,
      }),
    ).not.toThrow();
  });

  it('does NOT delete the live file (only rotated generations)', () => {
    const fs = makeFakeFs();
    fs.files[LIVE] = 'live-stays\n';
    fs.setMtime(LIVE, NOW_MS - SEVEN_DAYS - 1000); // even if old
    const removed: string[] = [];

    pruneIntelBus({
      projectDir: PROJ,
      now: () => NOW_MS,
      stat: (p) => ({ mtimeMs: fs.mtime(p) }),
      unlink: (p) => {
        removed.push(fs.norm(p));
        fs.unlink(p);
      },
    });

    expect(fs.files[LIVE]).toBe('live-stays\n');
    expect(removed).not.toContain(LIVE);
  });
});
