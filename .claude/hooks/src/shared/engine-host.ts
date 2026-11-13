/**
 * Engine host = the hook runs under a Cursor host (cursor-agent), not under Claude Code.
 *
 * The helper matches ANY Cursor host that sends these event names, not only the review engine.
 * The review engine is the reason it exists: cursor-agent runs the global Claude hooks from
 * ~/.claude/settings.json, and a hook that adds context makes the read audit void the engine run
 * (run d7e5b3f1, PR 523, voided by epistemic-reminder). SessionStart text can reach the review
 * model with no trace in the audit, so the session hooks stay silent too.
 *
 * Callers print `{}` or the hook's own no-op output and return when it is true. The own no-op is
 * `{"result":"continue"}` for session-start-docker, session-start-continuity and hook-health-monitor;
 * identity-probe prints nothing. The callers are: epistemic-reminder, periodic-extract,
 * tldr-read-enforcer (PR 529); session-register, session-start-init-check,
 * session-start-memory-loaders, identity-probe, and the Tier B SessionStart hooks of card
 * engine-run-hook-silence-2. Card engine-run-hook-files adds the hooks that write a FILE into the
 * project folder (the reviewed tree): bus-tool-populator, bus-session-populator,
 * post-edit-diagnostics, session-end-handoff-indexer and post-plan-roadmap. The cursor-agent name
 * for UserPromptSubmit is not measured, so the bus-session-populator guard is by convention.
 *
 * tldr-read-enforcer is the one caller that has a deny branch. It may import this module because
 * seat ruling 1 made it ALLOW a Read under the engine host: its deny text would be hook text in
 * the tool call and void the engine run. It is an exception by ruling, not a guard that keeps its
 * behaviour (see the rule below).
 *
 * Signal: the payload `hook_event_name`. cursor-agent sends camelCase names; Claude Code sends
 * PascalCase only (headless baseline of card engine-run-hook-silence).
 * - MEASURED under cursor-agent 2026.11.11-b912975 on 2026-11-12, run d7e5b3f1:
 *   sessionStart (x12), postToolUse (x52), sessionEnd (x1).
 * - BY CONVENTION, not measured: preToolUse (seat ruling 2, card engine-run-hook-silence-2). No
 *   cursor-agent PreToolUse row was captured. It follows the camelCase form of the measured three.
 *   It cannot cause a false positive in Claude Code, which never sends a camelCase name. If
 *   cursor-agent sends another name, the entry matches nothing.
 *
 * Positive match on an exact, case-sensitive set. A "not PascalCase" test is unsafe: some Claude
 * Code payloads carry a null event. A false negative voids an engine run; a false positive drops a
 * reminder in a Claude Code session, so only measured or by-convention camelCase names go in.
 *
 * No env signal (CURSOR_INVOKED_AS, CCV3_BASH_GUARD): no run has shown that a hook process sees
 * one and a Claude Code hook process does not (seat ruling, answer 2). Add one only after a probe.
 *
 * Kept in its own module so one hook never imports another hook's source (see shared/unattended.ts).
 *
 * NO DENY GUARD MAY IMPORT THIS (seat ruling C3): destructive-command-guard, decision-gate,
 * file-claims, package-install-guard, pre-pr-gate, rule-router and any other guard keep their
 * behaviour under the engine. The one exception is tldr-read-enforcer (seat ruling 1, above).
 */

const ENGINE_EVENT_NAMES: ReadonlySet<string> = new Set(['sessionStart', 'postToolUse', 'sessionEnd', 'preToolUse']);

/** True only when the payload event name is in the set (measured or by convention). Never throws. */
export function isEngineHost(input: unknown): boolean {
  try {
    if (input === null || typeof input !== 'object') return false;
    const event = (input as { hook_event_name?: unknown }).hook_event_name;
    return typeof event === 'string' && ENGINE_EVENT_NAMES.has(event);
  } catch {
    return false;
  }
}
