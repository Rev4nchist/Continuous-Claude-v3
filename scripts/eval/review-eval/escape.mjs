// The escape baseline: how many real Majors a reviewer could have found one step earlier.
//  laterRoundEscapes: a Major in CR round k>=2 whose lines were NOT changed by the round-k diff existed at round k-1.
//  postMergeEscapes:  git blame traces the lines to an earlier PR merged in the 30 days before this PR.
// escape is true, false, or null (cannot tell: no line, git or gh failed). Never throws.
import { DEFAULT_REPO } from '../../github/cursor-review.mjs';
import { isMajor } from './match.mjs';

const DAY = 86_400_000;

/** The new-side line ranges of a zero-context diff. */
function newRanges(diff) {
  const ranges = [];
  for (const m of String(diff).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    ranges.push([start, start + Math.max(count, 1) - 1]);
  }
  return ranges;
}

/** f: { round, sha40, prevSha, path, startLine, endLine, severity }. git(args) => { status, stdout }. */
export function laterRoundEscapes(f, { git }) {
  if (!isMajor(String(f.severity).toLowerCase()) || !(f.round >= 2)) return { escape: false, reason: 'not a later-round Major' };
  if (!Number.isFinite(f.startLine)) return { escape: null, reason: 'no line' };
  const r = git(['diff', '--unified=0', '--no-color', `${f.prevSha}..${f.sha40}`, '--', f.path]);
  if (r.status !== 0) return { escape: null, reason: 'diff failed' };
  const end = Number.isFinite(f.endLine) ? f.endLine : f.startLine;
  const touched = newRanges(r.stdout).some(([a, b]) => f.startLine <= b && end >= a);
  return { escape: !touched };
}

/** f adds mergedAt (the merge time of the PR). gh(args) => parsed JSON. */
export async function postMergeEscapes(f, { git, gh, repo = DEFAULT_REPO }) {
  if (!Number.isFinite(f.startLine)) return { escape: null, reason: 'no line' };
  const end = Number.isFinite(f.endLine) ? f.endLine : f.startLine;
  const r = git(['blame', '--porcelain', '-L', `${f.startLine},${end}`, f.sha40, '--', f.path]);
  if (r.status !== 0) return { escape: null, reason: 'blame failed' };
  const shas = [...new Set([...r.stdout.matchAll(/^([0-9a-f]{40}) \d+ \d+/gm)].map((m) => m[1]))];
  const anchor = Date.parse(f.mergedAt) || Date.now();
  const via = [];
  let failures = 0;
  for (const sha of shas) {
    try {
      const prs = await gh(['api', `repos/${repo}/commits/${sha}/pulls`]);
      for (const p of prs) {
        const t = Date.parse(p.merged_at);
        if (p.number !== f.pr && Number.isFinite(t) && t <= anchor && anchor - t <= 30 * DAY) via.push(p.number);
      }
    } catch { failures += 1; }
  }
  if (via.length > 0) return { escape: true, via: [...new Set(via)] };
  return failures > 0 && failures === shas.length ? { escape: null, reason: 'gh failed' } : { escape: false, via: [] };
}
