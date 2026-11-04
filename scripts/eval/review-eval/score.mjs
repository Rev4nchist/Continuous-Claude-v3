// The P0 scorecard (spec section 4). Pure: it takes records and returns the numbers.
//  runs:    [{ set, pr, round, status, promptSha256, durationMs, usage, findings: [{ id, sev, matchedKey?, judgeVerdict? }] }]
//  matches: [{ key, pr, set, crSev, crVerdict, crSource, engSev|null, engPairId|null }]   one per dataset finding of a replayed round
//  labels:  [{ findingId|pairId, verdict, sameIssue?, by }]   precision and strictSameIssue read by 'dave' and 'claude' (Dave wins);
//           judge agreement reads by 'dave' only, so model labels never grade the judge
//  sets:    { zeroMajorPrs: [pr] }     pairsSent: [{ pairId, judge: { verdict } }]
import { cohenKappa } from './agreement.mjs';
import { pairId } from './labels.mjs';
import { foldSev, isMajor, matchFindings } from './match.mjs';

const ratio = (found, total) => ({ found, total, value: total > 0 ? found / total : null });
const lc = (s) => String(s ?? '').toLowerCase();
/** Judge agreement is a NOTE below this many Dave-labelled pairs: too few to pass or fail a judge. */
export const JUDGE_GATE_MIN_N = 30;

function sumUsage(runs) {
  const total = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.usage ?? {})) if (typeof v === 'number') total[k] = (total[k] ?? 0) + v;
  return total;
}

/** One label per finding id from labels by dave or claude; a Dave label replaces a claude one. */
function labelMap(labels) {
  const map = new Map();
  for (const by of ['claude', 'dave']) for (const l of labels.filter((x) => x.by === by)) map.set(l.findingId ?? l.pairId, l);
  return map;
}

function recallOf(rows, labelBy = new Map()) {
  const majors = rows.filter((m) => isMajor(lc(m.crSev)) && lc(m.crVerdict) === 'real');
  const strict = majors.filter((m) => isMajor(lc(m.engSev)));
  // A strict line match whose pair a label calls a different issue (sameIssue === false) is not a recall. null does not exclude.
  const sameIssue = strict.filter((m) => !(m.engPairId && labelBy.get(m.engPairId)?.sameIssue === false));
  const lenient = majors.filter((m) => m.engSev);
  const prs = new Set(majors.map((m) => m.pr));
  const prHit = new Set(strict.map((m) => m.pr));
  const inline = majors.filter((m) => m.crSource === 'inline');
  return {
    strict: ratio(strict.length, majors.length), strictSameIssue: ratio(sameIssue.length, majors.length), lenient: ratio(lenient.length, majors.length), perPr: ratio(prHit.size, prs.size),
    inDiff: ratio(inline.filter((m) => isMajor(lc(m.engSev))).length, inline.length), overall: ratio(strict.length, majors.length),
  };
}

/** Same-issue recall for each link class (linkTypes: { key: class }). A key with no class is 'unlabelled'. Only classes that have a real Major appear. */
function perClass(rows, linkTypes, labelBy) {
  const groups = new Map();
  for (const row of rows) {
    const cls = linkTypes[row.key] ?? 'unlabelled';
    groups.set(cls, [...(groups.get(cls) ?? []), row]);
  }
  const recalls = [...groups].map(([cls, group]) => [cls, recallOf(group, labelBy).strictSameIssue]);
  return Object.fromEntries(recalls.filter(([, r]) => r.total > 0)); // a class with no real Major (only minor findings) adds no row
}

/** The funnel of the valid runs that carry one: { runs, raw, withdrawn, dropped: { total, byReason }, posted }. */
function sumFunnel(runs) {
  const total = { runs: 0, raw: 0, withdrawn: 0, dropped: { total: 0, byReason: {} }, posted: 0 };
  for (const r of runs.filter((x) => x.funnel)) {
    total.runs += 1;
    total.raw += r.funnel.raw ?? 0;
    total.withdrawn += r.funnel.withdrawn ?? 0;
    total.posted += r.funnel.posted ?? 0;
    for (const [reason, n] of Object.entries(r.funnel.dropped?.byReason ?? {})) {
      total.dropped.total += n;
      total.dropped.byReason[reason] = (total.dropped.byReason[reason] ?? 0) + n;
    }
  }
  return total;
}

/** Holdout Majors the reviewer did not find (no engine critical/major at the place): how many of them sit in its withdrawn list. noData: runs with no list. */
function withdrawnMisses(rows) {
  const misses = rows.filter((m) => isMajor(lc(m.crSev)) && lc(m.crVerdict) === 'real' && !isMajor(lc(m.engSev)));
  return { misses: misses.length, inWithdrawn: misses.filter((m) => m.inWithdrawn === true).length, noData: misses.filter((m) => m.inWithdrawn == null).length };
}

export function scorecard({ runs = [], matches = [], labels = [], sets = {}, linkTypes = {}, frozenPromptSha256 = null, escapes = {}, bakeoff = {}, headless = {}, pairsSent = [] } = {}) {
  // A holdout run (or match row) with another prompt hash leaves every holdout number: recall, precision, false alarms, cost.
  const stale = (r) => r.set === 'holdout' && Boolean(frozenPromptSha256) && r.promptSha256 !== frozenPromptSha256;
  const valid = runs.filter((r) => !stale(r));
  const labelBy = labelMap(labels);
  // evaluateRuns always sets promptSha256 on a match row (null when the run had none); a row with no such field carries no hash.
  const holdoutRows = matches.filter((m) => m.set === 'holdout' && !(m.promptSha256 !== undefined && stale(m)));
  const devRows = matches.filter((m) => m.set === 'dev');
  const holdout = recallOf(holdoutRows, labelBy);
  const dev = recallOf(devRows, labelBy);

  const zero = new Set(sets.zeroMajorPrs ?? []);
  const zeroRuns = valid.filter((r) => zero.has(r.pr));
  const alarmed = new Set(zeroRuns.filter((r) => (r.findings ?? []).some((f) => isMajor(lc(f.sev)))).map((r) => r.pr));

  const crVerdict = new Map(matches.map((m) => [m.key, lc(m.crVerdict)]));
  let real = 0;
  let noise = 0;
  let unverified = 0;
  // labelers: posted findings whose verdict came from a label, by who wrote that label.
  const labelers = { dave: 0, claude: 0 };
  for (const f of valid.flatMap((r) => r.findings ?? [])) {
    const label = (f.pairId ? labelBy.get(f.pairId) : undefined) ?? labelBy.get(f.id);
    if (label) labelers[label.by] += 1;
    const verdict = label ? lc(label.verdict) : (f.matchedKey ? crVerdict.get(f.matchedKey) : undefined);
    if (verdict === 'real') real += 1; else if (verdict === 'noise') noise += 1; else unverified += 1;
  }
  const posted = real + noise + unverified;

  const sent = new Map(pairsSent.map((p) => [p.pairId, p]));
  const joined = labels.filter((l) => l.by === 'dave' && sent.has(l.pairId ?? l.findingId));
  const agree = joined.filter((l) => lc(sent.get(l.pairId ?? l.findingId).judge?.verdict) === lc(l.verdict)).length;
  const agreement = joined.length > 0 ? agree / joined.length : null;
  const kappa = cohenKappa(joined.map((l) => [lc(sent.get(l.pairId ?? l.findingId).judge?.verdict), lc(l.verdict)]));
  const gateMet = agreement !== null && agreement >= 0.8;
  const judgeStatus = joined.length < JUDGE_GATE_MIN_N ? 'NOTE' : (gateMet ? 'PASS' : 'FAIL');

  return {
    schema: 1,
    perMajorRecall: { strict: holdout.strict, lenient: holdout.lenient, strictSameIssue: holdout.strictSameIssue },
    perPrRecall: holdout.perPr,
    funnel: sumFunnel(valid),
    withdrawnMisses: withdrawnMisses(holdoutRows),
    perClassRecall: { holdout: perClass(holdoutRows, linkTypes, labelBy), dev: perClass(devRows, linkTypes, labelBy) },
    prFalseAlarm: { count: alarmed.size, total: new Set(zeroRuns.map((r) => r.pr)).size, prs: [...alarmed] },
    precision: { real, noise, unverified, posted, value: posted > 0 ? real / posted : null, range: posted > 0 ? [real / posted, (real + unverified) / posted] : null, labelers },
    recall: { inDiff: holdout.inDiff, overall: holdout.overall },
    devRecall: { strict: dev.strict, lenient: dev.lenient },
    escapeBaseline: { laterRound: escapes.laterRound ?? null, postMerge: escapes.postMerge ?? null },
    bakeoffCrosswalk: { mapped: Object.keys(bakeoff).length, letters: [...new Set(Object.values(bakeoff))].sort() },
    cost: {
      grok: { runs: valid.length, durationMs: valid.reduce((a, r) => a + (r.durationMs ?? 0), 0), usage: sumUsage(valid) },
      headless: { runs: headless.runs ?? 0, costUsd: headless.costUsd ?? 0, usage: headless.usage ?? null },
    },
    judgeAgreement: { n: joined.length, agree, value: agreement, kappa, gate: 0.8, status: judgeStatus, pass: judgeStatus === 'PASS' },
    excludedRuns: runs.length - valid.length,
  };
}

/**
 * runs.jsonl is append-only, so a re-run adds a second row for the same round. The newest row per (pr, round, sha40) wins,
 * by ts, and on a tie (or an unreadable ts) the later line wins. A newest row that is not ok makes the round a failure.
 */
function newestPerRound(runs) {
  const best = new Map();
  runs.forEach((r, i) => {
    const key = `${r.pr}|${r.round}|${r.sha40}`;
    const t = Date.parse(r.ts);
    const prev = best.get(key);
    if (!prev || !(t < prev.t)) best.set(key, { t, i, r }); // NaN on either side compares false: the later line wins
  });
  return [...best.values()].sort((a, b) => a.i - b.i).map((x) => x.r);
}

/**
 * Did the reviewer withdraw a finding at the place of this dataset finding? Same file, and a line within tol of its lines (a dataset finding with no
 * lines matches on the file alone). null when the run has no withdrawn list (an old run): "unknown", not "no".
 */
function nearWithdrawn(withdrawn, c, tol) {
  if (withdrawn === null) return null;
  return withdrawn.some((w) => w?.path === c.file && (c.start == null || (Number.isFinite(w.line) && w.line >= c.start - tol && w.line <= (c.end ?? c.start) + tol)));
}

/**
 * Glue: match each replayed run against the dataset findings of its (pr, sha40).
 * runs: run records (with findingsPath). dataset: resolved findings. readFindings(path) => { findings: [{ file, line, lineEnd, severity, title }] }.
 * Returns { runs: [{ ...run, findings: [{ id, sev, matchedKey }] }], matches: [...] } ready for scorecard().
 */
export function evaluateRuns({ runs, dataset, readFindings, tol = 3 }) {
  const outRuns = [];
  const matches = [];
  for (const run of newestPerRound(runs).filter((r) => r.status === 'ok')) {
    // pairId is the key ingestLabels writes; it must use the same fields as the exported pair (pr, sha40, file, raw line, title).
    const found = readFindings(run.findingsPath);
    const withdrawn = Array.isArray(found.withdrawn) ? found.withdrawn : null;
    const eng = (found.findings ?? []).map((f, i) => ({ src: 'engine', id: `${run.pr}-${run.round}-${i}`, pairId: pairId({ pr: run.pr, sha: run.sha40, file: f.file, line: f.line, engineTitle: f.title }), file: f.file, start: Number.isFinite(f.line) ? f.line : null, end: Number.isFinite(f.lineEnd) ? f.lineEnd : (Number.isFinite(f.line) ? f.line : null), sev: lc(f.severity) }));
    const cr = dataset.filter((d) => d.pr === run.pr && d.sha40 === run.sha40).map((d) => ({ src: 'cr', id: d.key, file: d.path, start: d.startLine, end: d.endLine, sev: foldSev(d.severity), d }));
    const res = matchFindings(cr, eng, { tol });
    const hit = new Map(res.matches.map((m) => [m.cr.id, m.eng]));
    for (const c of cr) matches.push({ key: c.id, pr: run.pr, set: run.set, promptSha256: run.promptSha256 ?? null, crSev: c.sev, crVerdict: c.d.verdict, crSource: c.d.source, engSev: hit.get(c.id)?.sev ?? null, engPairId: hit.get(c.id)?.pairId ?? null, inWithdrawn: nearWithdrawn(withdrawn, c, tol) });
    const byEng = new Map(res.matches.map((m) => [m.eng.id, m.cr.id]));
    outRuns.push({ ...run, findings: eng.map((e) => ({ id: e.id, pairId: e.pairId, sev: e.sev, matchedKey: byEng.get(e.id) ?? null })) });
  }
  return { runs: outRuns, matches };
}
