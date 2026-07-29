/**
 * Braintrust score-emit helper for TypeScript hooks.
 *
 * Companion to the Python `braintrust_hooks.py` insert-span helpers. The Python
 * hooks own span/event creation; this helper owns score (feedback) emission
 * from TS-side hooks (memory-awareness, hook-health-monitor, etc.).
 *
 * Design contract:
 *   - Fail-open: NEVER throws. All errors swallowed to stderr only.
 *   - Skips silently when TRACE_TO_BRAINTRUST != "true" or BRAINTRUST_API_KEY unset.
 *   - 2-second AbortController timeout (matches dashboard-reporter pattern).
 *   - Endpoint: POST {API_URL}/v1/project_logs/{project_id}/feedback
 *   - Payload shape: { feedback: [{ id, scores, metadata?, comment? }] }
 *
 * Project ID resolution (mirrors Python `get_project_id`):
 *   1. BRAINTRUST_CC_PROJECT_ID env var (direct, no lookup)
 *   2. BRAINTRUST_CC_PROJECT env var -> GET /v1/project?project_name=... -> cache
 *
 * Cache is in-process only; each hook invocation is a separate Node process so
 * the cache lives for one hook execution. The Python hook caches via the
 * shared `braintrust_global.json`; we don't share that file here (different
 * runtime, different lifetime).
 *
 * WHY THIS FILE READS ~/.claude/.env ITSELF (fixed 2026-07-28)
 * -----------------------------------------------------------
 * Everything above worked. Nothing was ever emitted, for months, because the
 * config it depends on was never in the environment.
 *
 * `TRACE_TO_BRAINTRUST` and `BRAINTRUST_API_KEY` live in `~/.claude/.env`.
 * Claude Code does NOT load that file into hook processes, and the
 * `settings.json` `env` block does not carry them (correctly -- a live API key
 * does not belong in a file that is synced and committed). The Python hook
 * works only because `braintrust_hooks.py:884-889` loads the file MANUALLY.
 * This module read `process.env` directly, so `isEnabled()` returned false on
 * every invocation and every score emit returned silently at the guard.
 *
 * Proven by minimal reproduction, not inferred: the same hook, the same
 * payload, run twice, differing ONLY in whether the .env values were injected
 * into the child environment. Arm A (absent) produced nothing; Arm B (injected)
 * landed `memory_recall_hit=1, memory_recall_relevance=0.0328` in Braintrust at
 * 03:39:44Z. Two rival explanations were eliminated first: the span state file
 * was present and valid (so `spanId` was never the blocker), and the API
 * accepted the POST (so it was not a rejected write).
 *
 * WHY IT OVERRIDES process.env RATHER THAN DEFERRING TO IT
 * -------------------------------------------------------
 * Deliberately mirrors the Python loader, which also overwrites. It matters
 * that the two AGREE: Python creates the spans, this module attaches scores to
 * them. If a stray `TRACE_TO_BRAINTRUST=false` in the environment disabled this
 * side while the file kept Python enabled, spans would be created with scores
 * silently missing -- which is precisely the failure being fixed here, in a new
 * costume. Parity with the span creator beats conventional dotenv semantics.
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout for both project lookup and feedback POST. */
export const BRAINTRUST_FEEDBACK_TIMEOUT_MS = 2000;

const DEFAULT_API_URL = 'https://api.braintrust.dev';
const DEFAULT_PROJECT_NAME = 'claude-code';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmitScoreOptions {
  /** Braintrust span_id to attach the score to. */
  spanId: string;
  /** 0-1 floats keyed by score dimension name. */
  scores: Record<string, number>;
  /** Optional metadata blob recorded alongside the score. */
  metadata?: Record<string, unknown>;
  /** Optional human-readable comment for the score. */
  comment?: string;
}

interface FeedbackEntry {
  id: string;
  scores: Record<string, number>;
  metadata?: Record<string, unknown>;
  comment?: string;
}

// ---------------------------------------------------------------------------
// In-process project-id cache
// ---------------------------------------------------------------------------

/**
 * Cached project_id keyed by project_name. Populated lazily on first lookup.
 * Lives only for the lifetime of this Node process (one hook invocation).
 */
let projectIdCache: Record<string, string> = {};

/**
 * Test-only escape hatch to reset the cache between unit tests.
 * NOT for production use.
 */
export function resetProjectIdCacheForTests(): void {
  projectIdCache = {};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load `~/.claude/.env` into process.env, once per process.
 *
 * Mirrors `braintrust_hooks.py:884-889` deliberately, including the override --
 * see the header for why parity with the span creator matters more than
 * conventional dotenv semantics.
 *
 * Fail-open in every direction: a missing file, an unreadable file, a malformed
 * line, or a thrown error all leave the environment untouched and the caller
 * simply stays disabled. This module must never be the reason a hook dies.
 */
let dotenvLoaded = false;
function loadClaudeDotEnv(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  try {
    const envPath = join(homedir(), '.claude', '.env');
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (key) process.env[key] = value;
    }
  } catch {
    // No .env, or unreadable -> stay exactly as disabled as before.
  }
}

function getApiUrl(): string {
  loadClaudeDotEnv();
  return process.env.BRAINTRUST_API_URL || DEFAULT_API_URL;
}

function getApiKey(): string | null {
  loadClaudeDotEnv();
  const key = process.env.BRAINTRUST_API_KEY;
  return key && key.length > 0 ? key : null;
}

function isTraceEnabled(): boolean {
  loadClaudeDotEnv();
  return (process.env.TRACE_TO_BRAINTRUST || '').toLowerCase() === 'true';
}

/**
 * Read and discard a response body so undici releases its socket.
 *
 * Never throws: a failure to drain is strictly less bad than a failure to emit,
 * and this whole module is fail-open.
 */
async function consumeBody(resp: Response): Promise<void> {
  try {
    await resp.arrayBuffer();
  } catch {
    /* already consumed, aborted, or no body -- nothing to release */
  }
}

function logErr(msg: string): void {
  // Hooks should never crash, but we still want a breadcrumb on stderr so
  // operators can grep the hook log if scores stop appearing in Braintrust.
  try {
    process.stderr.write(`[braintrust-score] ${msg}\n`);
  } catch {
    /* truly nothing we can do */
  }
}

/**
 * Resolve the Braintrust project_id from env or via API lookup.
 * Returns null on any failure (no project_id env, no project_name env,
 * lookup failure, lookup returned no objects).
 *
 * Never throws.
 */
async function resolveProjectId(apiKey: string): Promise<string | null> {
  // Explicit, not inherited from call order. In the current emit path
  // isTraceEnabled() and getApiKey() always run first, so the env is already
  // loaded -- but depending on that is an implicit coupling, and a future
  // caller reaching this function directly would silently read an unloaded
  // environment. loadClaudeDotEnv() is idempotent and costs one boolean.
  loadClaudeDotEnv();

  // Prefer explicit project id env var (cheapest path)
  const directId = process.env.BRAINTRUST_CC_PROJECT_ID;
  if (directId && directId.length > 0) {
    return directId;
  }

  // Fall back to looking up by name
  const projectName = process.env.BRAINTRUST_CC_PROJECT || DEFAULT_PROJECT_NAME;

  // Cache hit?
  const cached = projectIdCache[projectName];
  if (cached) return cached;

  // GET /v1/project?project_name=<name>
  try {
    const url =
      getApiUrl() +
      '/v1/project?project_name=' +
      encodeURIComponent(projectName);

    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(BRAINTRUST_FEEDBACK_TIMEOUT_MS),
    });

    if (!resp.ok) {
      logErr(`project lookup ${projectName}: HTTP ${resp.status}`);
      // Same socket-release requirement as the feedback POST. The success path
      // drains via resp.json() just below; this early return would not.
      await consumeBody(resp);
      return null;
    }

    const data = (await resp.json()) as { objects?: Array<{ id?: string }> };
    const objects = data?.objects;
    if (!objects || objects.length === 0) {
      logErr(`project lookup ${projectName}: no objects`);
      return null;
    }

    const id = objects[0]?.id;
    if (!id) {
      logErr(`project lookup ${projectName}: object missing id`);
      return null;
    }

    projectIdCache[projectName] = id;
    return id;
  } catch (e) {
    logErr(`project lookup ${projectName} failed: ${(e as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

/**
 * Emit a score (feedback) to Braintrust.
 *
 * Fail-open contract — never throws. Skips silently when:
 *   - TRACE_TO_BRAINTRUST is not "true"
 *   - BRAINTRUST_API_KEY is missing or empty
 *   - scores is empty
 *   - spanId is empty
 *   - project id cannot be resolved
 *   - fetch fails (network, timeout, non-2xx)
 *
 * @param opts - spanId, scores, optional metadata/comment
 */
export async function emitBraintrustScore(
  opts: EmitScoreOptions,
): Promise<void> {
  try {
    // Skip if tracing is disabled
    if (!isTraceEnabled()) return;

    const apiKey = getApiKey();
    if (!apiKey) return;

    // Skip empty payloads
    if (!opts.spanId || opts.spanId.length === 0) return;
    if (!opts.scores || Object.keys(opts.scores).length === 0) return;

    const projectId = await resolveProjectId(apiKey);
    if (!projectId) return;

    // Build feedback entry — only include optional fields when present
    const entry: FeedbackEntry = {
      id: opts.spanId,
      scores: opts.scores,
    };
    if (opts.metadata !== undefined) {
      entry.metadata = opts.metadata;
    }
    if (opts.comment !== undefined) {
      entry.comment = opts.comment;
    }

    const url = `${getApiUrl()}/v1/project_logs/${projectId}/feedback`;

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ feedback: [entry] }),
        signal: AbortSignal.timeout(BRAINTRUST_FEEDBACK_TIMEOUT_MS),
      });

      if (!resp.ok) {
        logErr(`feedback POST ${opts.spanId}: HTTP ${resp.status}`);
      }

      // MUST drain the body, even though we never read it.
      //
      // undici keeps the socket in its pool until the body is consumed. An
      // undrained response leaves a live handle, and a hook that then calls
      // process.exit() tears the loop down mid-teardown:
      //
      //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
      //   file src\win\async.c, line 76        -> exit 0xC0000409
      //
      // Found by this crashing telemetry-tracker deterministically (3/3) the
      // moment the emit started doing real network I/O. It was invisible before
      // only because the emit was disabled and never opened a socket -- so
      // fixing the .env gate is what surfaced it. telemetry-tracker is the only
      // hook here that calls process.exit(), which is why it alone crashed;
      // the others drain implicitly by letting the loop finish.
      await consumeBody(resp);
    } catch (e) {
      logErr(`feedback POST ${opts.spanId} failed: ${(e as Error).message}`);
    }
  } catch (e) {
    // Last-resort catch — should be unreachable, but the fail-open contract
    // is non-negotiable.
    logErr(`unexpected error: ${(e as Error).message}`);
  }
}
