// Shared test and flow selector (review engine P1, TREX request 1). Pure: no git, no file reads, no clock.
// Contract: TREX build spec section 8 (.claudedocs/2026-11-02-local-trex-spec.md). The engine spec section 7 uses the same
// scores with other option names, so both spellings are accepted (see normalizeChange).
//
// selectFlows(flows, change, opts) -> { selected: [{id, score, reasons}], scores, scored, belowThreshold }
//   flow:   { id, paths: [glob | '!glob'], symbols?: [string], surfaces?: [id], lastFailAt?: ISO (lastFailedAt is read too) }
//   change: { paths: [string], hunks?: [{ path, symbols?: [string], text?: string }], surfaceIds?: [id] }
//           or a plain array of changed paths (engine spec form; then opts.hunks and opts.surfaceIds carry the rest)
//   opts:   { threshold = 3, cap = 5 } (min and max are read as aliases)
// Score: +3 when a changed path matches a flow glob and no '!glob' of that flow, +2 when a flow symbol appears in a hunk (its
// `symbols` list or its `text`, never a file name), +1 when a flow surface is in surfaceIds. A flow is selected when its score
// reaches the threshold. Order: score descending, then lastFailAt descending (never failed last), then id. At most `cap` are selected.
// `scores` holds every flow with its score, in the same order. `belowThreshold` holds the ids of flows that scored 1 or more
// and stayed under the threshold. A flow with an empty glob throws (globToRegExp): TREX lints flows before it selects.
// Skip rules (host-only, agent mode, needs) stay in TREX.

import { matchGlob } from '../github/review-router.mjs';

export const SCORE = Object.freeze({ path: 3, symbol: 2, surface: 1 });
export const SELECT_DEFAULTS = Object.freeze({ threshold: 3, cap: 5 });

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const asList = (v) => (Array.isArray(v) ? v : []);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Accept the TREX change object or the engine form (an array of paths plus opts.hunks and opts.surfaceIds). */
function normalizeChange(change, opts) {
  const base = Array.isArray(change) ? { paths: change } : change ?? {};
  return {
    paths: asList(base.paths).map(norm),
    hunks: asList(base.hunks ?? opts.hunks),
    surfaceIds: asList(base.surfaceIds ?? opts.surfaceIds),
  };
}

/** The first changed path that matches a positive glob and no negated glob of the flow, else null. */
function pathHit(globs, paths) {
  const pos = asList(globs).filter((g) => !g.startsWith('!'));
  const neg = asList(globs).filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  return paths.find((p) => pos.some((g) => matchGlob(g, p)) && !neg.some((g) => matchGlob(g, p))) ?? null;
}

/** The first flow symbol found in a hunk: in its `symbols` list, or as a whole word in its `text`. */
function symbolHit(symbols, hunks) {
  const inHunk = (s, h) => asList(h?.symbols).includes(s) || (typeof h?.text === 'string' && new RegExp(`(?<![\\w$])${escapeRe(s)}(?![\\w$])`).test(h.text));
  return asList(symbols).find((s) => typeof s === 'string' && s !== '' && hunks.some((h) => inHunk(s, h))) ?? null;
}

function scoreFlow(flow, change) {
  const reasons = [];
  let score = 0;
  const p = pathHit(flow.paths, change.paths);
  if (p !== null) { score += SCORE.path; reasons.push(`path:${p}`); }
  const sym = symbolHit(flow.symbols, change.hunks);
  if (sym !== null) { score += SCORE.symbol; reasons.push(`symbol:${sym}`); }
  const surf = asList(flow.surfaces).find((s) => change.surfaceIds.includes(s));
  if (surf !== undefined) { score += SCORE.surface; reasons.push(`surface:${surf}`); }
  return { id: flow.id, score, reasons, failAt: failTime(flow) };
}

function failTime(flow) {
  const t = Date.parse(flow.lastFailAt ?? flow.lastFailedAt ?? '');
  return Number.isNaN(t) ? -Infinity : t;
}

const byRank = (a, b) => b.score - a.score || (a.failAt === b.failAt ? 0 : b.failAt > a.failAt ? 1 : -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const publicRow = ({ id, score, reasons }) => ({ id, score, reasons });

export function selectFlows(flows, change, opts = {}) {
  const threshold = opts.threshold ?? opts.min ?? SELECT_DEFAULTS.threshold;
  const cap = opts.cap ?? opts.max ?? SELECT_DEFAULTS.cap;
  const c = normalizeChange(change, opts);
  const ranked = asList(flows).filter((f) => typeof f?.id === 'string').map((f) => scoreFlow(f, c)).sort(byRank);
  const scores = ranked.map(publicRow);
  const selected = scores.filter((r) => r.score >= threshold).slice(0, Math.max(0, cap));
  const belowThreshold = scores.filter((r) => r.score > 0 && r.score < threshold).map((r) => r.id);
  return { selected, scores, scored: scores, belowThreshold };
}
