// The P0 scorecard (spec section 4). Pure: it takes records and returns the numbers.
//  runs:    [{ set, pr, round, status, promptSha256, durationMs, usage, findings: [{ id, sev, matchedKey?, judgeVerdict? }] }]
//  matches: [{ key, pr, set, crSev, crVerdict, crSource, engSev|null }]   one per dataset finding of a replayed round
//  labels:  [{ findingId|pairId, verdict, by }]   only by 'dave' counts
//  sets:    { zeroMajorPrs: [pr] }     pairsSent: [{ pairId, judge: { verdict } }]
import { foldSev, isMajor, matchFindings } from './match.mjs';

const ratio = (found, total) => ({ found, total, value: total > 0 ? found / total : null });
const lc = (s) => String(s ?? '').toLowerCase();

function sumUsage(runs) {
  const total = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.usage ?? {})) if (typeof v === 'number') total[k] = (total[k] ?? 0) + v;
  return total;
}

function recallOf(rows) {
  const majors = rows.filter((m) => isMajor(lc(m.crSev)) && lc(m.crVerdict) === 'real');
  const strict = majors.filter((m) => isMajor(lc(m.engSev)));
  const lenient = majors.filter((m) => m.engSev);
  const prs = new Set(majors.map((m) => m.pr));
  const prHit = new Set(strict.map((m) => m.pr));
  const inline = majors.filter((m) => m.crSource === 'inline');
  return {
    strict: ratio(strict.length, majors.length), lenient: ratio(lenient.length, majors.length), perPr: ratio(prHit.size, prs.size),
    inDiff: ratio(inline.filter((m) => isMajor(lc(m.engSev))).length, inline.length), overall: ratio(strict.length, majors.length),
  };
}

export function scorecard({ runs = [], matches = [], labels = [], sets = {}, frozenPromptSha256 = null, escapes = {}, bakeoff = {}, headless = {}, pairsSent = [] } = {}) {
  const valid = runs.filter((r) => !(r.set === 'holdout' && frozenPromptSha256 && r.promptSha256 !== frozenPromptSha256));
  const holdout = recallOf(matches.filter((m) => m.set === 'holdout'));
  const dev = recallOf(matches.filter((m) => m.set === 'dev'));

  const zero = new Set(sets.zeroMajorPrs ?? []);
  const zeroRuns = valid.filter((r) => zero.has(r.pr));
  const alarmed = new Set(zeroRuns.filter((r) => (r.findings ?? []).some((f) => isMajor(lc(f.sev)))).map((r) => r.pr));

  const daveLabel = new Map(labels.filter((l) => l.by === 'dave').map((l) => [l.findingId ?? l.pairId, lc(l.verdict)]));
  const crVerdict = new Map(matches.map((m) => [m.key, lc(m.crVerdict)]));
  let real = 0;
  let noise = 0;
  let unverified = 0;
  for (const f of valid.flatMap((r) => r.findings ?? [])) {
    const verdict = daveLabel.get(f.id) ?? (f.matchedKey ? crVerdict.get(f.matchedKey) : undefined);
    if (verdict === 'real') real += 1; else if (verdict === 'noise') noise += 1; else unverified += 1;
  }
  const posted = real + noise + unverified;

  const sent = new Map(pairsSent.map((p) => [p.pairId, p]));
  const joined = labels.filter((l) => l.by === 'dave' && sent.has(l.pairId ?? l.findingId));
  const agree = joined.filter((l) => lc(sent.get(l.pairId ?? l.findingId).judge?.verdict) === lc(l.verdict)).length;
  const agreement = joined.length > 0 ? agree / joined.length : null;

  return {
    schema: 1,
    perMajorRecall: { strict: holdout.strict, lenient: holdout.lenient },
    perPrRecall: holdout.perPr,
    prFalseAlarm: { count: alarmed.size, total: new Set(zeroRuns.map((r) => r.pr)).size, prs: [...alarmed] },
    precision: { real, noise, unverified, posted, value: posted > 0 ? real / posted : null, range: posted > 0 ? [real / posted, (real + unverified) / posted] : null },
    recall: { inDiff: holdout.inDiff, overall: holdout.overall },
    devRecall: { strict: dev.strict, lenient: dev.lenient },
    escapeBaseline: { laterRound: escapes.laterRound ?? null, postMerge: escapes.postMerge ?? null },
    bakeoffCrosswalk: { mapped: Object.keys(bakeoff).length, letters: [...new Set(Object.values(bakeoff))].sort() },
    cost: {
      grok: { runs: valid.length, durationMs: valid.reduce((a, r) => a + (r.durationMs ?? 0), 0), usage: sumUsage(valid) },
      headless: { runs: headless.runs ?? 0, costUsd: headless.costUsd ?? 0, usage: headless.usage ?? null },
    },
    judgeAgreement: { n: joined.length, agree, value: agreement, gate: 0.8, pass: joined.length >= 30 && agreement !== null && agreement >= 0.8 },
    excludedRuns: runs.length - valid.length,
  };
}

/**
 * Glue: match each replayed run against the dataset findings of its (pr, sha40).
 * runs: run records (with findingsPath). dataset: resolved findings. readFindings(path) => { findings: [{ file, line, lineEnd, severity, title }] }.
 * Returns { runs: [{ ...run, findings: [{ id, sev, matchedKey }] }], matches: [...] } ready for scorecard().
 */
export function evaluateRuns({ runs, dataset, readFindings, tol = 3 }) {
  const outRuns = [];
  const matches = [];
  for (const run of runs.filter((r) => r.status === 'ok')) {
    const eng = (readFindings(run.findingsPath).findings ?? []).map((f, i) => ({ src: 'engine', id: `${run.pr}-${run.round}-${i}`, file: f.file, start: Number.isFinite(f.line) ? f.line : null, end: Number.isFinite(f.lineEnd) ? f.lineEnd : (Number.isFinite(f.line) ? f.line : null), sev: lc(f.severity) }));
    const cr = dataset.filter((d) => d.pr === run.pr && d.sha40 === run.sha40).map((d) => ({ src: 'cr', id: d.key, file: d.path, start: d.startLine, end: d.endLine, sev: foldSev(d.severity), d }));
    const res = matchFindings(cr, eng, { tol });
    const hit = new Map(res.matches.map((m) => [m.cr.id, m.eng]));
    for (const c of cr) matches.push({ key: c.id, pr: run.pr, set: run.set, crSev: c.sev, crVerdict: c.d.verdict, crSource: c.d.source, engSev: hit.get(c.id)?.sev ?? null });
    const byEng = new Map(res.matches.map((m) => [m.eng.id, m.cr.id]));
    outRuns.push({ ...run, findings: eng.map((e) => ({ id: e.id, sev: e.sev, matchedKey: byEng.get(e.id) ?? null })) });
  }
  return { runs: outRuns, matches };
}
