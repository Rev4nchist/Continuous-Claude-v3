/**
 * agent-error-capture — Phase 1a (USABLE / review S2) tests.
 *
 * Verifies the QW-04 hot-path fix: the archival store is FIRE-AND-FORGET
 * (detached async spawn + unref, never a synchronous 10s spawnSync that blocks
 * Task completion) and the trigger is TIGHTENED to structured error signals so
 * bare "error"/"failed" prose no longer pollutes recall. Deps are injected so
 * these are pure unit tests (no real fs / scorer / child process).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  buildStoreInvocation,
  storeLearning,
  hasStructuredError,
  releaseWhenRunning,
} from '../agent-error-capture.js';

describe('buildStoreInvocation — argv shape + fire-and-forget options', () => {
  it('passes content/context/tags verbatim as separate argv (no shell injection surface)', () => {
    const inv = buildStoreInvocation(
      '/opc',
      'sess-1',
      'Task failure in the kraken agent. ... the error it surfaced was: boom',
      'Failed agent invocation: kraken',
      'auto_captured,agent:kraken',
    );
    expect(inv.cmd).toBe('uv');
    expect(inv.args).toEqual([
      'run', 'python', 'scripts/core/store_learning.py',
      '--session-id', 'sess-1',
      '--type', 'FAILED_APPROACH',
      '--content', 'Task failure in the kraken agent. ... the error it surfaced was: boom',
      '--context', 'Failed agent invocation: kraken',
      '--tags', 'auto_captured,agent:kraken',
      '--confidence', 'medium',
    ]);
  });

  it('detached + ignored stdio + no shell (so the store outlives the hook process)', () => {
    const inv = buildStoreInvocation('/opc', 's', 'c', 'ctx', 't');
    expect(inv.options.shell).toBe(false);
    expect(inv.options.detached).toBe(true);
    expect(inv.options.stdio).toBe('ignore');
    expect(inv.options.windowsHide).toBe(true);
    expect(inv.options.cwd).toBe('/opc');
  });
});

describe('storeLearning — non-blocking detached spawn (QW-04 hot-path fix)', () => {
  const fakeChild = () => ({ unref: vi.fn() } as never);
  const okScore = () => ({ classification: 'SIGNAL', score: 7, reasons: [] } as never);

  it('spawns async + detached + unref (never spawnSync, never awaits the store)', () => {
    const child = { unref: vi.fn() };
    const spawnFn = vi.fn(() => child as never);
    storeLearning('s', 'kraken', 'p', 'TypeError: boom', {
      spawnFn,
      scoreFn: okScore,
      existsFn: () => true,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const opts = (spawnFn.mock.calls[0] as any[])[2] as { detached?: boolean; stdio?: string; shell?: boolean };
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(opts.shell).toBe(false);
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  // ── the guard that was missing for 161 days ─────────────────────────────
  //
  // From 05abf54 (2026-02-18) to 2026-07-29 this hook emitted
  // `Agent '<type>' error: ...` while store_learning.py's NOISE_PREFIXES
  // blacklisted "Agent '" and checked it FIRST. Every learning was discarded at
  // ingestion: 0 of 622 archival_memory rows. The store returns
  // {"success": true, "skipped": true} and exits 0, and this hook spawns with
  // stdio:'ignore', so neither end could see it. The same commit added the
  // blacklist and rewrote the producer to emit it.
  //
  // These two tests read the blacklist and the length floor OUT OF THE PYTHON
  // SOURCE rather than hardcoding them, so the pair fails if either side drifts
  // again -- whether someone rewords the producer or adds a colliding prefix.
  describe('content clears the ingestion gate (regression: 161 silent days)', () => {
    const STORE_LEARNING_PY = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..', '..', '..', '..', 'opc', 'scripts', 'core', 'store_learning.py',
    );

    /** The live NOISE_PREFIXES list, parsed from store_learning.py. */
    function noisePrefixes(): string[] {
      const src = readFileSync(STORE_LEARNING_PY, 'utf-8');
      const block = /NOISE_PREFIXES\s*=\s*\[([\s\S]*?)\]/.exec(src);
      expect(block, 'NOISE_PREFIXES not found -- did store_learning.py move?').toBeTruthy();
      const found = [...block![1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
      // Non-vacuity: an empty list would make the assertion below trivially true.
      expect(found.length, 'parsed an empty NOISE_PREFIXES').toBeGreaterThan(3);
      return found;
    }

    /** FAILED_APPROACH's minimum content length, parsed from store_learning.py. */
    function failedApproachMinLength(): number {
      const src = readFileSync(STORE_LEARNING_PY, 'utf-8');
      const m = /"FAILED_APPROACH"\s*:\s*(\d+)/.exec(src);
      expect(m, 'FAILED_APPROACH min length not found').toBeTruthy();
      return Number(m![1]);
    }

    /** The content this hook actually passes to store_learning.py. */
    function producedContent(agentType: string, errorContext: string): string {
      const spawnFn = vi.fn(() => fakeChild());
      storeLearning('s', agentType, 'p', errorContext, {
        spawnFn,
        scoreFn: okScore,
        existsFn: () => true,
      });
      expect(spawnFn).toHaveBeenCalledTimes(1);
      const argv = (spawnFn.mock.calls[0] as any[])[1] as string[];
      const i = argv.indexOf('--content');
      expect(i).toBeGreaterThanOrEqual(0);
      return argv[i + 1];
    }

    it('does not start with any blacklisted NOISE_PREFIX', () => {
      const content = producedContent('kraken', 'TypeError: cannot read x of undefined');
      const hit = noisePrefixes().find((p) => content.startsWith(p));
      expect(
        hit,
        `content starts with the blacklisted prefix ${JSON.stringify(hit)} -- ` +
          `store_learning.py will silently discard every capture. content=${JSON.stringify(content.slice(0, 80))}`,
      ).toBeUndefined();
    });

    it('clears the FAILED_APPROACH length floor for a realistic error', () => {
      const content = producedContent(
        'kraken',
        "TypeError: Cannot read properties of undefined (reading 'sessionId') at storeLearning (agent-error-capture.ts:237)",
      );
      expect(content.trim().length).toBeGreaterThanOrEqual(failedApproachMinLength());
    });

    it('keeps fixed boilerplate SHORT, so the 0.85 dedup gate cannot collapse all failures into one', () => {
      // Measured 2026-07-29: a ~95-char fixed lead-in produced 0.88 embedding
      // similarity between two UNRELATED agent failures, so the store skipped them
      // as duplicates -- the first failure would land and every later one would
      // vanish silently. Boilerplate is the share of the record that is identical
      // across every capture, so it is the thing to bound.
      const a = producedContent('kraken', 'AAAAAAAAAA');
      const b = producedContent('kraken', 'BBBBBBBBBB');
      // Whatever is common to both, with the error text differing, IS the boilerplate.
      let common = 0;
      while (common < a.length && common < b.length && a[common] === b[common]) common++;
      const tailCommon = (() => {
        let n = 0;
        while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
        return n;
      })();
      expect(
        common + tailCommon,
        'fixed boilerplate is long enough to dominate the embedding -- unrelated failures will dedup against each other',
      ).toBeLessThan(80);
    });

    it('POSITIVE CONTROL: the pre-2026-07-29 wording would FAIL this check', () => {
      const old = "Agent 'kraken' error: TypeError: boom";
      expect(noisePrefixes().some((p) => old.startsWith(p))).toBe(true);
    });
  });

  // ── the OTHER half of the 161 silent days ────────────────────────────────
  //
  // 09ba655 (QW-04) made the store detached + unref'd to stop a ~10s spawnSync
  // blocking Task completion. But unref() followed by the parent exiting in the
  // SAME tick kills the child: measured 2026-07-29, exit-same-tick stored NO row
  // while exit-one-tick-later stored one, identical spawn. So the store was
  // dispatched, logged, exited 0 -- and never completed.
  //
  // The fix is to release the child only once the OS reports it running. These
  // tests pin the ORDER, which is the whole content of the bug.
  describe('detached child is released only once running (regression: fire-and-forget never finished)', () => {
    /** A child stub that records unref timing and lets the test fire events. */
    function eventChild() {
      const handlers: Record<string, Array<() => void>> = {};
      return {
        unref: vi.fn(),
        once(event: string, fn: () => void) {
          (handlers[event] ||= []).push(fn);
          return this;
        },
        emit(event: string) {
          for (const fn of handlers[event] || []) fn();
        },
      };
    }

    it('does NOT unref in the same tick as the spawn', () => {
      const child = eventChild();
      storeLearning('s', 'kraken', 'p', 'TypeError: boom', {
        spawnFn: (() => child) as never,
        scoreFn: okScore,
        existsFn: () => true,
      });
      // This is the assertion that would have caught the bug: at this point the
      // hook has returned and, before the fix, the child was already released.
      expect(
        child.unref,
        'unref() in the spawn tick kills the store -- release on the spawn event instead',
      ).not.toHaveBeenCalled();
    });

    it('unrefs once the child reports spawned', () => {
      const child = eventChild();
      storeLearning('s', 'kraken', 'p', 'TypeError: boom', {
        spawnFn: (() => child) as never,
        scoreFn: okScore,
        existsFn: () => true,
      });
      child.emit('spawn');
      expect(child.unref).toHaveBeenCalledTimes(1);
    });

    it('unrefs on spawn error too, so a failed spawn cannot hold the hook open', () => {
      const child = eventChild();
      storeLearning('s', 'kraken', 'p', 'TypeError: boom', {
        spawnFn: (() => child) as never,
        scoreFn: okScore,
        existsFn: () => true,
      });
      child.emit('error');
      expect(child.unref).toHaveBeenCalledTimes(1);
    });

    it('a stub child without .once is released immediately (back-compat)', () => {
      const plain = { unref: vi.fn() };
      releaseWhenRunning(plain);
      expect(plain.unref).toHaveBeenCalledTimes(1);
    });
  });

  it('drops NOISE-scored content WITHOUT spawning (recall not polluted)', () => {
    const spawnFn = vi.fn(() => fakeChild());
    storeLearning('s', 'kraken', 'p', 'something happened', {
      spawnFn,
      scoreFn: () => ({ classification: 'NOISE', score: 1, reasons: ['low signal'] } as never),
      existsFn: () => true,
    });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('missing store_learning.py → no spawn (graceful, no throw)', () => {
    const spawnFn = vi.fn(() => fakeChild());
    expect(() =>
      storeLearning('s', 'kraken', 'p', 'TypeError: boom', {
        spawnFn,
        scoreFn: okScore,
        existsFn: () => false,
      }),
    ).not.toThrow();
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe('hasStructuredError — tightened trigger (structured only, not bare error/failed)', () => {
  it('structured signals trigger a capture', () => {
    expect(hasStructuredError('TypeError: x is not a function')).toBe(true);
    expect(hasStructuredError('ENOENT: no such file or directory')).toBe(true);
    expect(hasStructuredError('Traceback (most recent call last):')).toBe(true);
    expect(hasStructuredError('panic: runtime error: index out of range')).toBe(true);
    expect(hasStructuredError('    at processData (/app/src/index.ts:42:10)')).toBe(true);
    expect(hasStructuredError('the agent crashed unexpectedly')).toBe(true);
    expect(hasStructuredError('the process will crash on startup')).toBe(true);  // bare "crash"
    expect(hasStructuredError('the worker crashes repeatedly')).toBe(true);      // "crashes"
    expect(hasStructuredError('socket hangup: ECONNRESET')).toBe(true);
  });

  it('bare / benign error words do NOT trigger (the noise source)', () => {
    expect(hasStructuredError('0 errors, build succeeded')).toBe(false);
    expect(hasStructuredError('the test that failed earlier now passes')).toBe(false);
    expect(hasStructuredError('completed with no failures')).toBe(false);
    expect(hasStructuredError('timeout was increased to 30s and it worked')).toBe(false);
  });
});
