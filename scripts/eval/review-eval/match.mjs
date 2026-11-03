// One matcher for eval and shadow (main spec 5.2). Finding: { src, id, file, start, end, sev, ... }. start/end null = no line.
// Match: same file (after renames), engine line inside CR [start - tol, end + tol], one-to-one, nearest first.
// Severity is not a match key: a CR Major matched by an engine Minor is a severityDowngrade.

/** Copy of the unexported SEVERITY_OF in review-status.mjs (:1148), plus `info` (never counts). */
export const SEV = { critical: 'critical', major: 'major', minor: 'minor', trivial: 'minor', nitpick: 'minor', info: 'info' };
export const isMajor = (sev) => SEV[String(sev ?? '').toLowerCase()] === 'critical' || SEV[String(sev ?? '').toLowerCase()] === 'major';
export const foldSev = (sev) => SEV[String(sev ?? '').toLowerCase()] ?? 'unknown';

const hasLine = (f) => Number.isFinite(f.start);
const endOf = (f) => (Number.isFinite(f.end) ? f.end : f.start);

/** Distance between a CR range and an engine range: 0 inside the CR range, else the gap. null when outside tol. */
function distance(c, e, tol) {
  const lo = c.start - tol;
  const hi = endOf(c) + tol;
  if (endOf(e) < lo || e.start > hi) return null;
  if (endOf(e) >= c.start && e.start <= endOf(c)) return 0;
  return e.start > endOf(c) ? e.start - endOf(c) : c.start - endOf(e);
}

/**
 * { matches: [{ cr, eng, how: 'line', distance, severityDowngrade }],
 *   toJudge: [{ cr, candidates: [eng], low }], crOnly: [cr], engOnly: [eng] }
 * toJudge: a CR finding with no match that has unmatched engine findings in the same file, or no line at all (low).
 * engOnly keeps the judge candidates; the caller removes the ones the judge confirms.
 */
export function matchFindings(cr, eng, { renames = {}, tol = 3, slack } = {}) {
  const t = slack ?? tol;
  const pairs = [];
  cr.forEach((c, ci) => {
    if (!hasLine(c)) return;
    const file = renames[c.file] ?? c.file;
    eng.forEach((e, ei) => {
      if (e.file !== file || !hasLine(e)) return;
      const d = distance(c, e, t);
      if (d !== null) pairs.push({ ci, ei, d });
    });
  });
  pairs.sort((a, b) => a.d - b.d || eng[a.ei].start - eng[b.ei].start || a.ci - b.ci);
  const usedC = new Set();
  const usedE = new Set();
  const matches = [];
  for (const p of pairs) {
    if (usedC.has(p.ci) || usedE.has(p.ei)) continue;
    usedC.add(p.ci);
    usedE.add(p.ei);
    const c = cr[p.ci];
    const e = eng[p.ei];
    matches.push({ cr: c, eng: e, how: 'line', distance: p.d, severityDowngrade: isMajor(c.sev) && !isMajor(e.sev) });
  }
  const toJudge = [];
  const crOnly = [];
  cr.forEach((c, ci) => {
    if (usedC.has(ci)) return;
    const file = renames[c.file] ?? c.file;
    const candidates = eng.filter((e, ei) => !usedE.has(ei) && e.file === file);
    if (candidates.length > 0) toJudge.push({ cr: c, candidates, low: !hasLine(c) });
    else crOnly.push(c);
  });
  const engOnly = eng.filter((_, ei) => !usedE.has(ei));
  return { matches, toJudge, crOnly, engOnly };
}
