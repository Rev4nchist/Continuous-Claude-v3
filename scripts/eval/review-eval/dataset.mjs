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

/** The PR numbers of the reserve list (cfg.reserve: [{ pr, answerKeySource }]): the next holdout. */
function reservePrs(cfg) {
  const list = cfg.reserve ?? [];
  const bad = !Array.isArray(list) || list.some((r) => !r || typeof r !== 'object' || !Number.isInteger(r.pr));
  if (bad) throw Object.assign(new Error('config.json reserve must be a list of { pr: <integer>, answerKeySource }'), { code: 'BAD_INPUT' });
  return new Set(list.map((r) => r.pr));
}

/** 'reserve' | 'dev' | 'holdout' for one of our own PRs. Reserve wins over holdoutExclude: a reserve PR is never replayed. */
export function setOf(pr, cfg) {
  if (reservePrs(cfg).has(pr)) return 'reserve';
  return (cfg.holdoutExclude ?? []).includes(pr) ? 'dev' : 'holdout';
}

/**
 * { replay: the real Majors of dev and holdout, dev: those in a holdoutExclude PR, holdout: the rest, reserve: those in a reserve PR }.
 * The sets never mix. A reserve PR is in neither dev, holdout nor replay.
 */
export function splitSets(findings, cfg) {
  const majors = realMajors(findings);
  const by = (set) => majors.filter((f) => setOf(f.pr, cfg) === set);
  const dev = by('dev');
  const holdout = by('holdout');
  return { replay: majors.filter((f) => setOf(f.pr, cfg) !== 'reserve'), dev, holdout, reserve: by('reserve') };
}

/** E02: { total, noSource, bySource } of the reserve list. Counts only. */
export function reserveSources(cfg) {
  const list = cfg.reserve ?? [];
  const bySource = {};
  for (const r of list) if (r.answerKeySource) bySource[r.answerKeySource] = (bySource[r.answerKeySource] ?? 0) + 1;
  return { total: list.length, noSource: list.filter((r) => !r.answerKeySource).length, bySource };
}

/** The target key of a gold row: 'owner/name#pr' (external), '#pr' (our own repo), or 'range:<base..head>'. */
export const goldKey = (row) => (row.target?.range ? `range:${row.target.range}` : `${row.target?.repo ?? ''}#${row.target?.pr}`);

/**
 * Merge gold rows (from gold.mjs loadGold) with the split of config.json (seat, 2026-11-11).
 * Source A or CR (our own PRs): config.json wins; splitDiffers counts the rows whose own split differs.
 * Source B (range) or C (external): the row's own split is the only source.
 * @returns {{ rows: object[], splitDiffers: number }} each row gets `key` and the effective `split`.
 */
export function mergeGold(rows, cfg) {
  let splitDiffers = 0;
  const out = rows.map((row) => {
    const own = ['A', 'CR'].includes(row.source) && !row.target?.repo && !row.target?.range;
    const split = own ? setOf(row.target.pr, cfg) : row.split;
    if (split !== row.split) splitDiffers += 1;
    return { ...row, key: goldKey(row), split };
  });
  return { rows: out, splitDiffers };
}

/**
 * Counts for the phase 4 need (map T04): PRs with a real Major per set, and distinct gold targets outside the reserve.
 * ds: the CodeRabbit dataset ({ prs, findings }). goldRows: mergeGold(...).rows. Counts only, never PR ids.
 */
export function prCounts({ ds, cfg, goldRows = [] }) {
  const prs = [...new Set(realMajors(ds.findings).map((f) => f.pr))];
  const count = (set) => prs.filter((p) => setOf(p, cfg) === set).length;
  // An own-repo gold target on a PR that is already a holdout or dev PR of the dataset adds no run: it is counted once, as that PR.
  const datasetPrs = new Set(prs.filter((p) => setOf(p, cfg) !== 'reserve').map((p) => `#${p}`));
  const targets = new Map();
  const seen = new Set();
  let goldOverlap = 0;
  for (const r of goldRows) {
    if (r.split === 'reserve' || seen.has(r.key)) continue;
    seen.add(r.key);
    if (datasetPrs.has(r.key)) goldOverlap += 1; else targets.set(r.key, r.source);
  }
  const goldBySource = {};
  for (const s of targets.values()) goldBySource[s] = (goldBySource[s] ?? 0) + 1;
  // Suites (config.json suites): the dataset PRs outside the reserve that neither list names. Gold rows carry their own suite.
  const inScope = prs.filter((p) => setOf(p, cfg) !== 'reserve');
  const listed = (name) => new Set(cfg.suites?.[name] ?? []);
  const regression = listed('regression');
  const capability = listed('capability');
  const suites = { total: inScope.length, regression: inScope.filter((p) => regression.has(p)).length, capability: inScope.filter((p) => capability.has(p)).length, none: inScope.filter((p) => !regression.has(p) && !capability.has(p)).length };
  return { holdout: count('holdout'), dev: count('dev'), reserve: count('reserve'), gold: targets.size, goldOverlap, goldBySource, suites };
}
