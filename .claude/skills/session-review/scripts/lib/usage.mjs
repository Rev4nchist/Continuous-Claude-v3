// Token de-duplication helpers for session-review.
// ORIGIN: copied from scripts/usage/token-report.mjs lines 59-71 (messageKey, mergeMax). The
// skill syncs to ~/.claude and the repo-level scripts/ folder does not, so it cannot import
// them. A later change to the source must be mirrored here by hand.

/** De-dup key. Returns {key, fallback}. fallback is true when message.id was missing. */
export function messageKey(o, anonKey) {
  if (o.message && o.message.id) return { key: `msg:${o.message.id}`, fallback: false };
  if (o.requestId) return { key: `req:${o.requestId}`, fallback: true };
  if (o.uuid) return { key: `uuid:${o.uuid}`, fallback: true };
  return { key: `anon:${anonKey}`, fallback: true };
}

/** Merge usage copies of one message: MAX per field. Mutates and returns prev. */
export function mergeMax(prev, cur) {
  for (const k of Object.keys(prev)) if (cur[k] > prev[k]) prev[k] = cur[k];
  return prev;
}
