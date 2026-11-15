/**
 * review-md.mjs - parse REVIEW.md "Skip paths". Side-effect free: a class and functions only. Moved byte-for-byte from
 * scripts/ratchets/review-skip-sync.mjs, which keeps it as a re-export. It lives apart because that script runs main() when its
 * argv[1] is itself, and in an esbuild bundle argv[1] is the bundle, so a hook could not import it.
 */

export class CannotCompare extends Error {}

const lines = (text) => String(text).split(/\r?\n/);

/** Globs in the first fenced block under the "Skip paths" heading of REVIEW.md. */
export function parseReviewMd(text) {
  const all = lines(text);
  const at = all.findIndex((l) => /^##\s+Skip paths\s*$/i.test(l));
  if (at < 0) throw new CannotCompare('REVIEW.md has no "## Skip paths" section');
  const rest = all.slice(at + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  const section = end < 0 ? rest : rest.slice(0, end);
  const open = section.findIndex((l) => /^```/.test(l));
  const close = open < 0 ? -1 : section.findIndex((l, i) => i > open && /^```\s*$/.test(l));
  if (open < 0 || close < 0) throw new CannotCompare('REVIEW.md "Skip paths" has no fenced block');
  const globs = section.slice(open + 1, close).map((l) => l.trim()).filter(Boolean);
  if (globs.length === 0) throw new CannotCompare('REVIEW.md "Skip paths" block is empty');
  return globs;
}
