/**
 * Tool-error detection for PostToolUse hook responses.
 *
 * TypeScript port of `_detect_tool_error` in
 * `~/.claude/hooks/braintrust_hooks.py:422-449` (Phase 2.3, story
 * braintrust-scoring). The Python detector was the right shape; the TS
 * sibling at `telemetry-tracker.ts:118,150` was only checking
 * `tool_response?.status !== 'error'` — a field that empirically is never set
 * in real Claude Code payloads (0/285 prod rows showed `success: false` as of
 * 2026-05-23). This helper closes that gap.
 *
 * Detection rules (any one is sufficient → returns true):
 *   1. is_error === true
 *   2. error is a truthy non-empty string, or error === true
 *   3. success === false
 *   4. status === 'error' (backward-compat with the original TS check;
 *      retained alongside the three Python checks)
 *
 * Everything else (non-object responses, objects with none of these flags,
 * objects with success === undefined) is treated as success.
 *
 * Fail-open by design: invalid / null / non-object inputs return false
 * (= "no error detected"). Callers that need an explicit signal should
 * also instrument `tool_response_keys` so the empirical shape of real
 * tool_response payloads can be audited separately.
 */
export function detectToolError(toolResponse: unknown): boolean {
  if (toolResponse === null || typeof toolResponse !== 'object') {
    return false;
  }

  const resp = toolResponse as Record<string, unknown>;

  // Rule 1: is_error === true
  if (resp.is_error === true) {
    return true;
  }

  // Rule 2: error is truthy non-empty string OR error === true
  const err = resp.error;
  if (typeof err === 'string' && err.trim().length > 0) {
    return true;
  }
  if (err === true) {
    return true;
  }

  // Rule 3: success === false
  if (resp.success === false) {
    return true;
  }

  // Rule 4: status === 'error' (backward-compat with the original TS check)
  if (resp.status === 'error') {
    return true;
  }

  return false;
}

/**
 * The exit code in a tool_response, or null when the payload has none.
 *
 * Moved here from msys-crash-capture.ts so test-run-tracker and msys-crash-capture share it
 * (a hook file cannot be imported by another: its top-level main() would run in the bundle).
 *
 * Evidence (2026-10-06, isolated `claude -p --settings` capture, see
 * .claude/cache/e2e/2026-10-06-correct-posttooluse-bash.json): a PASSING Bash PostToolUse
 * tool_response is {stdout, stderr, interrupted, isImage, noOutputExpected}: no exit field. A
 * failing command never reaches PostToolUse; it fires PostToolUseFailure with
 * `error: "Exit code N"` and no tool_response (test-run-tracker reads the event name).
 */
export function exitCodeOf(resp: unknown): number | null {
  if (resp && typeof resp === 'object') {
    const o = resp as Record<string, unknown>;
    for (const k of ['exit_code', 'exitCode', 'code', 'status']) {
      if (typeof o[k] === 'number') return o[k] as number;
    }
    if (o.is_error === true) return -1;
  }
  return null;
}

