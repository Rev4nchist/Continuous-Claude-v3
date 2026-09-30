/**
 * Resolve the Braintrust span a TS hook should attach its score to.
 *
 * WHY THIS EXISTS (2026-07-28)
 * ---------------------------
 * There were TWO independent reasons the TS scoring layer emitted nothing, and
 * fixing the first did not fix the second:
 *
 *   1. `braintrust-score.ts` read `TRACE_TO_BRAINTRUST` / `BRAINTRUST_API_KEY`
 *      from `process.env`, which never carries them -- fixed by making that
 *      module load `~/.claude/.env` the way the Python hook always has.
 *
 *   2. THIS one. `hook-health-monitor` and `telemetry-tracker` each
 *      resolved their span from
 *      `process.env.BRAINTRUST_SESSION_ID` -- a variable set NOWHERE. Not the
 *      process environment, not `~/.claude/.env`, not the `settings.json` env
 *      block (all three checked). So `spanId` was always empty and
 *      `emitBraintrustScore` bailed at its guard no matter what, which is why
 *      `hook_health_ratio`, `agent_task_success` and `skill_trigger_accuracy`
 *      have never appeared in Braintrust.
 *
 * `memory-awareness` was the only TS hook that worked, because it read the span
 * from the file the Python hook actually writes. This module is that resolver,
 * lifted out of `memory-awareness.ts` verbatim so the three broken hooks use
 * the implementation with a proven track record rather than a second opinion.
 *
 * A second opinion about where span state lives is exactly how this happened.
 *
 * THE SOURCE OF TRUTH
 * -------------------
 * `braintrust_hooks.py user_prompt_submit` stores per-session span state at
 * `~/.claude/state/braintrust_sessions/<session_id>.json`. Each turn it bumps
 * `current_turn_span_id` to a fresh uuid (the span owning that turn's tool
 * calls); `root_span_id` persists for the session.
 *
 * Prefer the turn span -- these scores are per-turn signals. Fall back to the
 * root span if the turn span isn't recorded yet (race with the Python handler,
 * missing state file) so the score still lands somewhere visible.
 *
 * Fail-open throughout: returns null rather than throwing, and a null simply
 * means the caller skips its emit.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface BraintrustSessionState {
  root_span_id?: string;
  current_turn_span_id?: string;
  project_id?: string;
  sampled_out?: boolean;
}

export interface ResolvedSpan {
  spanId: string;
  attachedTo: 'turn' | 'root';
}

export function readBraintrustSessionState(sessionId: string): BraintrustSessionState | null {
  if (!sessionId) return null;
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
    if (!homeDir) return null;
    const statePath = join(homeDir, '.claude', 'state', 'braintrust_sessions', `${sessionId}.json`);
    if (!existsSync(statePath)) return null;
    return JSON.parse(readFileSync(statePath, 'utf-8')) as BraintrustSessionState;
  } catch {
    // Any I/O or parse error means we just skip the score.
    return null;
  }
}

/**
 * The span id to attach a score to, or null if there is none.
 *
 * Pass the session id from the hook's own stdin payload. Do NOT reach for
 * `process.env.BRAINTRUST_SESSION_ID` -- nothing sets it, and reading it is the
 * bug this module exists to retire.
 */
export function resolveBraintrustSpan(sessionId: string): ResolvedSpan | null {
  const state = readBraintrustSessionState(sessionId);
  if (!state) return null;
  // Sampled-out sessions have no spans to attach to.
  if (state.sampled_out) return null;

  if (state.current_turn_span_id && state.current_turn_span_id.length > 0) {
    return { spanId: state.current_turn_span_id, attachedTo: 'turn' };
  }
  if (state.root_span_id && state.root_span_id.length > 0) {
    return { spanId: state.root_span_id, attachedTo: 'root' };
  }
  return null;
}

/** Convenience: just the id, empty string when unavailable. */
export function resolveBraintrustSpanId(sessionId: string): string {
  return resolveBraintrustSpan(sessionId)?.spanId ?? '';
}
