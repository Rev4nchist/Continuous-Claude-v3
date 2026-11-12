/**
 * Engine host = the hook runs under cursor-agent (the review engine), not under Claude Code.
 *
 * Why: cursor-agent runs the global Claude hooks from ~/.claude/settings.json. A hook that adds
 * context to a Read or Grep call makes the read audit void the engine run (run d7e5b3f1, PR 523,
 * voided by epistemic-reminder). Three hooks call this and print `{}` when it is true:
 * epistemic-reminder, periodic-extract, tldr-read-enforcer.
 *
 * Signal: the payload `hook_event_name`. cursor-agent sends camelCase names; Claude Code sends
 * PascalCase. Measured under cursor-agent 2026.11.11-b912975 on 2026-11-12, run d7e5b3f1
 * (sessionStart x12, postToolUse x52, sessionEnd x1).
 *
 * Positive match on an exact, case-sensitive set. A "not PascalCase" test is unsafe: some Claude
 * Code payloads carry a null event. A false negative voids an engine run; a false positive drops a
 * reminder in a Claude Code session, so only proven names go in.
 *
 * No env signal (CURSOR_INVOKED_AS, CCV3_BASH_GUARD): no run has shown that a hook process sees
 * one and a Claude Code hook process does not (seat ruling, answer 2). Add one only after the probe.
 *
 * Kept in its own module so one hook never imports another hook's source (see shared/unattended.ts).
 *
 * NO DENY GUARD MAY IMPORT THIS (seat ruling C3): destructive-command-guard, decision-gate,
 * file-claims, package-install-guard, pre-pr-gate, rule-router and any other guard keep their
 * behaviour under the engine.
 */

// 'preToolUse' is NOT in the set: the name is not proven (no measured cursor-agent PreToolUse row).
// Until the probe proves it, the tldr-read-enforcer check is a no-op for a real PreToolUse event.
const ENGINE_EVENT_NAMES: ReadonlySet<string> = new Set(['sessionStart', 'postToolUse', 'sessionEnd']);

/** True only when the payload event name is one cursor-agent was measured to send. Never throws. */
export function isEngineHost(input: unknown): boolean {
  try {
    if (input === null || typeof input !== 'object') return false;
    const event = (input as { hook_event_name?: unknown }).hook_event_name;
    return typeof event === 'string' && ENGINE_EVENT_NAMES.has(event);
  } catch {
    return false;
  }
}
