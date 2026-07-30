/**
 * Bus Session Populator Hook (UserPromptSubmit) -- WS-2 Phase B.4a.
 *
 * Seeds the L2 context bus once per turn so the recall path (B.3, later) can
 * bias on a fresh intent + an accurate turn counter. This hook is a WRITER, not
 * an injector: it bumps current_turn and sets current_intent, then emits a bare
 * continue with NO additionalContext. It never reads the bus back, never adds
 * context, and never blocks the prompt.
 *
 * Guards (mirrored from memory-awareness.ts main()):
 *   - subagent context (CLAUDE_AGENT_ID set) -> skip
 *   - prompt length < 15 -> skip
 *   - prompt starts with '/' (slash command) -> skip
 * A skipped turn does NOT touch the bus (no turn bump, no intent write) -- the
 * counter only advances on real, recall-worthy prompts, matching what the
 * recall path actually fires on.
 *
 * Write path: mutateBus(undefined, ...) uses the default getBusId(), and the
 * mutation runs bumpTurn() then setIntent() with the prompt routed through
 * sanitizeMemoryContent (the SAME sanitizer memory-awareness uses; we never
 * hand-roll sanitization) capped to ~120 chars. mutateBus already honors the
 * CCV3_BUS_OFF kill switch and the 200ms lock cap (Phase B.0), so a contended
 * or disabled bus degrades safely without any extra handling here.
 *
 * Fail-open: the whole body is wrapped so any error (bad stdin, bus failure)
 * degrades to outputContinue(). It NEVER throws and NEVER blocks a prompt.
 *
 * ASCII only.
 */

import { readFileSync } from 'fs';
import { outputContinue } from './shared/output.js';
import { mutateBus, bumpTurn, setIntent } from './shared/context-bus.js';
import { sanitizeMemoryContent } from './shared/memory-sanitize.js';

/** Max length of the sanitized intent we stamp onto the bus. */
const INTENT_CAP = 120;

/** Minimum prompt length to seed the bus (mirrors memory-awareness). */
const MIN_PROMPT_LEN = 15;

interface UserPromptSubmitInput {
  session_id?: string;
  hook_event_name?: string;
  prompt?: string;
  cwd?: string;
}

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

/**
 * Decide whether this prompt should seed the bus. Skip subagents, very short
 * prompts, and slash commands -- exactly the prompts memory-awareness also
 * skips, so the turn counter and the recall path stay in lock-step.
 */
function shouldSeed(prompt: string | undefined): boolean {
  if (process.env.CLAUDE_AGENT_ID) return false;
  if (typeof prompt !== 'string') return false;
  if (prompt.length < MIN_PROMPT_LEN) return false;
  if (prompt.trim().startsWith('/')) return false;
  return true;
}

function main(): void {
  try {
    const input: UserPromptSubmitInput = JSON.parse(readStdin());

    if (!shouldSeed(input.prompt)) {
      outputContinue();
      return;
    }

    // Sanitize + truncate the prompt into a bus-safe intent. sanitizeMemoryContent
    // strips control chars and HTML-encodes; the cap keeps the bus small.
    const intent = sanitizeMemoryContent(input.prompt as string, INTENT_CAP);

    // Single mutation: bump the turn counter, then set the intent. mutateBus is
    // fail-open and honors CCV3_BUS_OFF + the 200ms lock cap (Phase B.0), so a
    // disabled or contended bus simply no-ops without throwing.
    mutateBus(undefined, (b) => {
      bumpTurn(b);
      setIntent(b, intent);
    });
  } catch {
    // Fail-open: any error degrades to a bare continue. Never block a prompt.
  }
  // Always end with a bare continue -- this hook injects NO context.
  outputContinue();
}

if ((process.argv[1] || '').includes('bus-session-populator')) {
  main();
}
