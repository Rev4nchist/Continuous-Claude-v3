// Human-turn detection for session-review.
// ORIGIN: copied from scripts/self-improvement/failure-audit.mjs lines 44-71 (INJECTED_PREFIX,
// isHuman, textOf). This skill syncs to ~/.claude and the repo-level scripts/ folder does not, so
// the skill cannot import them. A later change to the source must be mirrored here by hand.

// Text that the harness injects as a "user" turn. Only needed for transcripts older than the
// origin metadata below; newer ones say who wrote the turn.
export const INJECTED_PREFIX = /^(<local-command|<system-reminder|<command-name>|<task-notification|Base directory for this skill|This session is being continued|Caveat: The messages below)/;

export const isHuman = (o) => {
  if (o.type !== 'user' || !o.message || o.message.role !== 'user') return false;
  if (o.isSidechain) return false; // subagent-internal turns
  // Headless `claude -p` runs (scheduled pipelines) are prompts a script wrote, not Dave.
  if (o.entrypoint === 'sdk-cli') return false;
  // Meta flags first: skill loads, /loop prompts and compact summaries are never Dave, even
  // if a record also carries a human origin.
  if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return false;
  // Authoritative when present: 'human' for typed/queued turns; 'task-notification', 'peer',
  // 'scheduled' and 'sdk' for everything the harness injects.
  if (o.origin && o.origin.kind) return o.origin.kind === 'human';
  if (o.turnOrigin) return o.turnOrigin === 'human';
  const c = o.message.content;
  if (typeof c === 'string') return c.length > 0 && !INJECTED_PREFIX.test(c.trimStart());
  if (Array.isArray(c)) {
    if (c.some((b) => b.type === 'tool_result')) return false;
    const t = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return t.length > 0 && !INJECTED_PREFIX.test(t.trimStart());
  }
  return false;
};

export const textOf = (o) => {
  const c = o.message.content;
  if (typeof c === 'string') return c;
  return c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
};
