#!/usr/bin/env node
/**
 * Heartbeat Hook - Updates session last_heartbeat on each user prompt
 *
 * Runs on UserPromptSubmit to keep the session marked as active
 * in the cross-terminal coordination database.
 */

import { registerSession } from './shared/db-utils-pg.js';
import { getSessionId } from './shared/session-id.js';

interface HookInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
}

async function main(): Promise<void> {
  let input: HookInput = {};

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  try {
    const rawInput = Buffer.concat(chunks).toString('utf-8').trim();
    if (rawInput) {
      input = JSON.parse(rawInput);
    }
  } catch {
    // Ignore parse errors
  }

  const sessionId = input.session_id || getSessionId();
  const project = input.cwd || process.cwd();

  // Extract first line of prompt as "working on" context (max 100 chars)
  const workingOn = input.prompt
    ? input.prompt.split('\n')[0].substring(0, 100)
    : undefined;

  // Update session heartbeat via registerSession (upserts)
  const result = registerSession(sessionId, project, workingOn);

  if (!result.success) {
    console.error(`Heartbeat update failed: ${result.error}`);
  }

  console.log(JSON.stringify({ result: 'continue' }));
}

main().catch((err) => {
  console.error('Heartbeat error:', err);
  console.log(JSON.stringify({ result: 'continue' }));
});
