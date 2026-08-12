/**
 * Tests for braintrust-score shared helper.
 *
 * Validates the fail-open POST helper used by TypeScript hooks to emit
 * scores to Braintrust's `/v1/project_logs/{project_id}/feedback` endpoint.
 *
 * Design contract (mirrors dashboard-reporter.ts):
 *   - Fail-open: never throws, swallows all errors
 *   - No-op when TRACE_TO_BRAINTRUST != "true"
 *   - No-op when BRAINTRUST_API_KEY is unset
 *   - Uses fetch with AbortSignal timeout (2s)
 *   - POSTs `{ feedback: [{ id, scores, metadata, comment }] }` shape
 *   - Bearer auth header
 *
 * Project-id resolution mirrors the Python hook:
 *   - Prefer BRAINTRUST_CC_PROJECT_ID if set
 *   - Else look up by name via /v1/project?project_name=... (cached)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  emitBraintrustScore,
  resetProjectIdCacheForTests,
  resetDotEnvStateForTests,
  BRAINTRUST_FEEDBACK_TIMEOUT_MS,
} from '../shared/braintrust-score.js';

/**
 * A .env path that does not exist, so the loader fails open and these tests never
 * read the developer's real ~/.claude/.env.
 *
 * That file carries a live BRAINTRUST_API_KEY and TRACE_TO_BRAINTRUST=true. Before
 * this, the suite loaded it: the off-switch test failed because the file's `true`
 * overwrote the test's `false`, and the failure output printed the real key as
 * `Authorization: Bearer sk-...`. Any CI log or pasted failure leaked the
 * credential.
 */
const NO_DOTENV = join(tmpdir(), 'braintrust-score-tests-no-such-file.env');

/** Write a throwaway .env fixture and return its path. */
function writeDotEnvFixture(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bt-score-'));
  const p = join(dir, '.env');
  writeFileSync(p, contents, 'utf-8');
  return p;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a clean env snapshot we can restore between tests.
 * Tests mutate process.env; this ensures isolation.
 */
function snapshotEnv(): Record<string, string | undefined> {
  return {
    TRACE_TO_BRAINTRUST: process.env.TRACE_TO_BRAINTRUST,
    BRAINTRUST_API_KEY: process.env.BRAINTRUST_API_KEY,
    BRAINTRUST_API_URL: process.env.BRAINTRUST_API_URL,
    BRAINTRUST_CC_PROJECT: process.env.BRAINTRUST_CC_PROJECT,
    BRAINTRUST_CC_PROJECT_ID: process.env.BRAINTRUST_CC_PROJECT_ID,
    BRAINTRUST_DOTENV_PATH: process.env.BRAINTRUST_DOTENV_PATH,
  };
}

function restoreEnv(snap: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function setEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Group A — Skip conditions (no-op paths)
// ---------------------------------------------------------------------------

describe('emitBraintrustScore: skip conditions', () => {
  let originalFetch: typeof globalThis.fetch;
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    originalFetch = globalThis.fetch;
    resetProjectIdCacheForTests();
    // Hermetic: never read the developer's real ~/.claude/.env (live API key,
    // TRACE_TO_BRAINTRUST=true). The latch must be cleared too, or only the first
    // test in the file ever re-reads the environment.
    resetDotEnvStateForTests();
    process.env.BRAINTRUST_DOTENV_PATH = NO_DOTENV;
  });

  afterEach(() => {
    restoreEnv(envSnap);
    globalThis.fetch = originalFetch;
  });

  it('returns silently when TRACE_TO_BRAINTRUST is "false"', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'false',
      BRAINTRUST_API_KEY: 'sk-test',
      BRAINTRUST_CC_PROJECT_ID: 'proj-abc',
    });

    await emitBraintrustScore({
      spanId: 'span-1',
      scores: { quality: 0.9 },
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // THE OFF SWITCH. ~/.claude/.env says true; the environment says false. The
  // environment must win, or there is no way to disable tracing without editing a
  // credentials file. This is the assertion the pre-2026-07-29 code failed.
  it('an explicit TRACE_TO_BRAINTRUST=false beats ~/.claude/.env saying true', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as any;

    resetDotEnvStateForTests();
    process.env.BRAINTRUST_DOTENV_PATH = writeDotEnvFixture(
      'TRACE_TO_BRAINTRUST=true\nBRAINTRUST_API_KEY=sk-from-file\nBRAINTRUST_CC_PROJECT_ID=proj-from-file\n',
    );
    setEnv({ TRACE_TO_BRAINTRUST: 'false' });

    await emitBraintrustScore({ spanId: 'span-1', scores: { quality: 0.9 } });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // NEGATIVE CONTROL for the test above. "No requests" is also what a completely
  // broken emitter looks like, so prove the switch did not over-shoot: environment
  // silent + file says true => the POST still happens, from the file's values.
  it('still emits when the environment is silent and ~/.claude/.env enables tracing', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch as any;

    resetDotEnvStateForTests();
    process.env.BRAINTRUST_DOTENV_PATH = writeDotEnvFixture(
      'TRACE_TO_BRAINTRUST=true\nBRAINTRUST_API_KEY=sk-from-file\nBRAINTRUST_CC_PROJECT_ID=proj-from-file\n',
    );
    setEnv({ TRACE_TO_BRAINTRUST: undefined });

    await emitBraintrustScore({ spanId: 'span-1', scores: { quality: 0.9 } });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/v1/project_logs/proj-from-file/feedback');
  });

  it('returns silently when TRACE_TO_BRAINTRUST is unset', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as any;

    setEnv({
      TRACE_TO_BRAINTRUST: undefined,
      BRAINTRUST_API_KEY: 'sk-test',
      BRAINTRUST_CC_PROJECT_ID: 'proj-abc',
    });

    await emitBraintrustScore({
      spanId: 'span-1',
      scores: { quality: 0.9 },
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns silently when BRAINTRUST_API_KEY is unset', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: undefined,
      BRAINTRUST_CC_PROJECT_ID: 'proj-abc',
    });

    await emitBraintrustScore({
      spanId: 'span-1',
      scores: { quality: 0.9 },
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns silently when BRAINTRUST_API_KEY is empty string', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: '',
      BRAINTRUST_CC_PROJECT_ID: 'proj-abc',
    });

    await emitBraintrustScore({
      spanId: 'span-1',
      scores: { quality: 0.9 },
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns silently when scores object is empty', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: 'sk-test',
      BRAINTRUST_CC_PROJECT_ID: 'proj-abc',
    });

    await emitBraintrustScore({
      spanId: 'span-1',
      scores: {},
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns silently when spanId is empty', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: 'sk-test',
      BRAINTRUST_CC_PROJECT_ID: 'proj-abc',
    });

    await emitBraintrustScore({
      spanId: '',
      scores: { quality: 0.9 },
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group B — Happy path POST shape
// ---------------------------------------------------------------------------

describe('emitBraintrustScore: POST shape', () => {
  let originalFetch: typeof globalThis.fetch;
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    originalFetch = globalThis.fetch;
    resetProjectIdCacheForTests();
    // Hermetic: never read the developer's real ~/.claude/.env (live API key,
    // TRACE_TO_BRAINTRUST=true). The latch must be cleared too, or only the first
    // test in the file ever re-reads the environment.
    resetDotEnvStateForTests();
    process.env.BRAINTRUST_DOTENV_PATH = NO_DOTENV;
  });

  afterEach(() => {
    restoreEnv(envSnap);
    globalThis.fetch = originalFetch;
  });

  it('POSTs to /v1/project_logs/{project_id}/feedback with correct shape', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: 'sk-test-key',
      BRAINTRUST_CC_PROJECT_ID: 'proj-abc123',
      BRAINTRUST_API_URL: 'https://api.braintrust.dev',
    });

    await emitBraintrustScore({
      spanId: 'span-xyz',
      scores: { recall_relevance: 0.85, tool_success: 1.0 },
      metadata: { source: 'memory-awareness', mode: 'hybrid' },
      comment: 'top RRF score >= floor',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.braintrust.dev/v1/project_logs/proj-abc123/feedback');
    expect(options.method).toBe('POST');
    expect(options.headers['Authorization']).toBe('Bearer sk-test-key');
    expect(options.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(options.body);
    expect(body.feedback).toHaveLength(1);
    expect(body.feedback[0].id).toBe('span-xyz');
    expect(body.feedback[0].scores).toEqual({
      recall_relevance: 0.85,
      tool_success: 1.0,
    });
    expect(body.feedback[0].metadata).toEqual({
      source: 'memory-awareness',
      mode: 'hybrid',
    });
    expect(body.feedback[0].comment).toBe('top RRF score >= floor');
  });

  it('omits metadata and comment fields when not provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: 'sk-test',
      BRAINTRUST_CC_PROJECT_ID: 'proj-abc',
    });

    await emitBraintrustScore({
      spanId: 'span-1',
      scores: { foo: 0.5 },
    });

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.feedback[0].id).toBe('span-1');
    expect(body.feedback[0].scores).toEqual({ foo: 0.5 });
    // metadata and comment must NOT appear when not provided
    expect('metadata' in body.feedback[0]).toBe(false);
    expect('comment' in body.feedback[0]).toBe(false);
  });

  it('uses AbortSignal with timeout', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: 'sk-test',
      BRAINTRUST_CC_PROJECT_ID: 'proj-abc',
    });

    await emitBraintrustScore({
      spanId: 'span-1',
      scores: { foo: 0.5 },
    });

    const [, options] = mockFetch.mock.calls[0];
    expect(options.signal).toBeDefined();
  });

  it('respects custom BRAINTRUST_API_URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: 'sk-test',
      BRAINTRUST_CC_PROJECT_ID: 'proj-abc',
      BRAINTRUST_API_URL: 'https://staging.braintrust.dev',
    });

    await emitBraintrustScore({
      spanId: 'span-1',
      scores: { foo: 0.5 },
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://staging.braintrust.dev/v1/project_logs/proj-abc/feedback');
  });

  it('TIMEOUT constant is reasonable (1-5 seconds)', () => {
    expect(BRAINTRUST_FEEDBACK_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(BRAINTRUST_FEEDBACK_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});

// ---------------------------------------------------------------------------
// Group C — Project ID resolution
// ---------------------------------------------------------------------------

describe('emitBraintrustScore: project id resolution', () => {
  let originalFetch: typeof globalThis.fetch;
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    originalFetch = globalThis.fetch;
    resetProjectIdCacheForTests();
    // Hermetic: never read the developer's real ~/.claude/.env (live API key,
    // TRACE_TO_BRAINTRUST=true). The latch must be cleared too, or only the first
    // test in the file ever re-reads the environment.
    resetDotEnvStateForTests();
    process.env.BRAINTRUST_DOTENV_PATH = NO_DOTENV;
  });

  afterEach(() => {
    restoreEnv(envSnap);
    globalThis.fetch = originalFetch;
  });

  it('looks up project id by name when BRAINTRUST_CC_PROJECT_ID is unset', async () => {
    // First call: GET /v1/project?project_name=claude-code
    // Second call: POST /v1/project_logs/<id>/feedback
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ objects: [{ id: 'looked-up-id' }] }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    globalThis.fetch = mockFetch as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: 'sk-test',
      BRAINTRUST_CC_PROJECT_ID: undefined,
      BRAINTRUST_CC_PROJECT: 'claude-code',
    });

    await emitBraintrustScore({
      spanId: 'span-1',
      scores: { foo: 0.5 },
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [lookupUrl] = mockFetch.mock.calls[0];
    expect(lookupUrl).toContain('/v1/project');
    expect(lookupUrl).toContain('project_name=claude-code');

    const [postUrl] = mockFetch.mock.calls[1];
    expect(postUrl).toContain('/v1/project_logs/looked-up-id/feedback');
  });

  it('caches project id lookup across calls (only one lookup per project name)', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ objects: [{ id: 'cached-id' }] }),
      })
      .mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: 'sk-test',
      BRAINTRUST_CC_PROJECT_ID: undefined,
      BRAINTRUST_CC_PROJECT: 'claude-code',
    });

    await emitBraintrustScore({ spanId: 'span-1', scores: { a: 0.1 } });
    await emitBraintrustScore({ spanId: 'span-2', scores: { b: 0.2 } });
    await emitBraintrustScore({ spanId: 'span-3', scores: { c: 0.3 } });

    // 1 lookup + 3 posts = 4 calls (not 6 with re-lookups)
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('returns silently when project lookup returns no objects', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ objects: [] }),
    });
    globalThis.fetch = mockFetch as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: 'sk-test',
      BRAINTRUST_CC_PROJECT_ID: undefined,
      BRAINTRUST_CC_PROJECT: 'nonexistent-project',
    });

    await emitBraintrustScore({ spanId: 'span-1', scores: { foo: 0.5 } });

    // Only the lookup happened; no POST followed
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Group D — Fail-open behavior
// ---------------------------------------------------------------------------

describe('emitBraintrustScore: fail-open behavior', () => {
  let originalFetch: typeof globalThis.fetch;
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    originalFetch = globalThis.fetch;
    resetProjectIdCacheForTests();
    // Hermetic: never read the developer's real ~/.claude/.env (live API key,
    // TRACE_TO_BRAINTRUST=true). The latch must be cleared too, or only the first
    // test in the file ever re-reads the environment.
    resetDotEnvStateForTests();
    process.env.BRAINTRUST_DOTENV_PATH = NO_DOTENV;
  });

  afterEach(() => {
    restoreEnv(envSnap);
    globalThis.fetch = originalFetch;
  });

  it('does not throw when fetch rejects (network error)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: 'sk-test',
      BRAINTRUST_CC_PROJECT_ID: 'proj-abc',
    });

    await expect(
      emitBraintrustScore({ spanId: 'span-1', scores: { foo: 0.5 } }),
    ).resolves.not.toThrow();
  });

  it('does not throw when fetch returns non-ok status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: 'sk-test',
      BRAINTRUST_CC_PROJECT_ID: 'proj-abc',
    });

    await expect(
      emitBraintrustScore({ spanId: 'span-1', scores: { foo: 0.5 } }),
    ).resolves.not.toThrow();
  });

  it('does not throw on timeout (AbortError)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException('Aborted', 'AbortError')) as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: 'sk-test',
      BRAINTRUST_CC_PROJECT_ID: 'proj-abc',
    });

    await expect(
      emitBraintrustScore({ spanId: 'span-1', scores: { foo: 0.5 } }),
    ).resolves.not.toThrow();
  });

  it('does not throw when project lookup fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('DNS failure')) as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: 'sk-test',
      BRAINTRUST_CC_PROJECT_ID: undefined,
      BRAINTRUST_CC_PROJECT: 'claude-code',
    });

    await expect(
      emitBraintrustScore({ spanId: 'span-1', scores: { foo: 0.5 } }),
    ).resolves.not.toThrow();
  });

  it('does not throw on malformed lookup response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('invalid JSON');
      },
    }) as any;

    setEnv({
      TRACE_TO_BRAINTRUST: 'true',
      BRAINTRUST_API_KEY: 'sk-test',
      BRAINTRUST_CC_PROJECT_ID: undefined,
      BRAINTRUST_CC_PROJECT: 'claude-code',
    });

    await expect(
      emitBraintrustScore({ spanId: 'span-1', scores: { foo: 0.5 } }),
    ).resolves.not.toThrow();
  });
});
