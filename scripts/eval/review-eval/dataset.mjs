// The labelled dataset (.claudedocs/2026-11-01-pr-review-dataset.json): 40 PRs, 93 CodeRabbit findings, 22 real Majors.
import { readFileSync } from 'node:fs';
import { crRounds, defaultGh, originalPlace } from './github.mjs';

export function loadDataset(file) {
  const ds = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(ds.prs) || !Array.isArray(ds.findings)) throw new Error(`${file}: expected { prs[], findings[] }`);
  return ds;
}

const lc = (s) => String(s ?? '').toLowerCase();
export const isRealMajor = (f) => ['major', 'critical'].includes(lc(f.severity)) && lc(f.verdict) === 'real';
export const realMajors = (findings) => findings.filter(isRealMajor);
export const zeroMajorPrs = (ds) => ds.prs.filter((p) => p.real_major === 0).map((p) => p.pr);

/**
 * Each finding becomes { key, pr, round, sha40, path, startLine, endLine, severity, verdict, source, resolvedBy }.
 * comment: the place comes from the comment (original_* fields). round: the sha of that CR round, path from the dataset, no lines.
 * unresolved: neither worked. A comment gh cannot read falls back to its round. opts: { gh, repo, filter }.
 */
export async function resolveFindings(ds, { gh = defaultGh, repo, filter = () => true } = {}) {
  const roundsByPr = new Map();
  const roundsOf = (pr) => {
    if (!roundsByPr.has(pr)) roundsByPr.set(pr, crRounds(pr, { gh, repo }).catch(() => []));
    return roundsByPr.get(pr);
  };
  const out = [];
  for (const [i, f] of ds.findings.entries()) {
    if (!filter(f)) continue;
    const base = { key: `${f.pr}:${f.comment_id ?? `r${f.round}-${i}`}`, pr: f.pr, round: f.round, severity: f.severity, verdict: f.verdict, source: f.source, path: f.path, startLine: null, endLine: null, sha40: null, resolvedBy: 'unresolved' };
    let placed = null;
    if (f.comment_id) {
      try { placed = await originalPlace(f.comment_id, { gh, repo }); } catch { placed = null; }
    }
    if (placed?.sha40) {
      const rank = (await roundsOf(f.pr)).findIndex((r) => r.sha40 === placed.sha40);
      out.push({ ...base, path: placed.path ?? f.path, sha40: placed.sha40, startLine: placed.startLine, endLine: placed.endLine, resolvedBy: 'comment', roundRank: rank >= 0 ? rank + 1 : null });
      continue;
    }
    const round = (await roundsOf(f.pr))[Number(f.round) - 1];
    out.push(round ? { ...base, sha40: round.sha40, resolvedBy: 'round', roundRank: Number(f.round) } : base);
  }
  return out;
}

/** { replay: every real Major, dev: those in a holdoutExclude PR, holdout: the rest }. The two sets never mix. */
export function splitSets(findings, cfg) {
  const replay = realMajors(findings);
  const excluded = new Set(cfg.holdoutExclude ?? []);
  return { replay, dev: replay.filter((f) => excluded.has(f.pr)), holdout: replay.filter((f) => !excluded.has(f.pr)) };
}
