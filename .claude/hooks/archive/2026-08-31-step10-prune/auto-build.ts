#!/usr/bin/env node
// NEUTRALIZED (CCv3 WS-0.3, Codex #3): rebuilt from STALE ACTIVE src (~/.claude/hooks) = the May-2026 regression amplifier. Under the edit-in-repo->sync convention, active-src edits shouldn't happen and dist propagates via sync-to-active.sh's dist-copy. Hook left registered-but-inert; settings.json deregistration deferred to Phase 2.
/**
 * Auto-Build Hook (NEUTRALIZED)
 *
 * Previously: a PostToolUse (Write|Edit) hook that detected edits to active
 * hook source files (~/.claude/hooks/src/*.ts) and ran `npm run build` in the
 * background to keep dist/ in sync. That build ran against STALE ACTIVE src,
 * which could clobber correctly-synced dist -- the amplifier behind the
 * May-2026 hook regression.
 *
 * Now: inert. main() reads and discards stdin and emits an empty result.
 * It never triggers a build. The hook remains registered in settings.json
 * but is a no-op; deregistration is deferred to Phase 2.
 *
 * Hook: PostToolUse (Write|Edit)
 */

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  // Read and discard stdin so the producing process can complete its write.
  await readStdin();
  // Inert: never trigger a build. Emit an empty PostToolUse result.
  console.log(JSON.stringify({}));
}

main().catch((err) => {
  console.error('[auto-build] Error:', err.message);
  console.log(JSON.stringify({}));
});
