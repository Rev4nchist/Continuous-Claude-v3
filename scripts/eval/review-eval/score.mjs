// The P0 scorecard (spec section 4). Pure: it takes records and returns the numbers.
//  runs:    [{ set, pr, round, status, promptSha256, durationMs, usage, findings: [{ id, sev, matchedKey?, judgeVerdict? }] }]
//  matches: [{ key, pr, set, crSev, crVerdict, crSource, engSev|null, engPairId|null }]   one per dataset finding of a replayed round
//  labels:  [{ findingId|pairId, verdict, sameIssue?, by }]   precision and strictSameIssue read by 'dave' and 'claude' (Dave wins);
//           judge agreement reads by 'dave' only, so model labels never grade the judge
//  sets:    { zeroMajorPrs: [pr] }     pairsSent: [{ pairId, judge: { verdict } }]
//  Dev and holdout never mix. perSuite, perSource, goldARecall, pairedBar, lostCaughtMajors, cleanFalseMajor and cleanRise are one cell per set: { holdout: <cell>, dev: <cell> }. A match row or run with no set is in neither cell.
//  Frozen hash of a row: frozenByArm[arm of the row] when present (two engine prompt versions on the holdout each keep their own hash), else frozenByReviewer[reviewer], else frozenPromptSha256.
//  lostCaughtMajors: { count, assessable, flagged }. assessable = items with 2 or more replicates on both arms; flagged is null when assessable is 0.
//  cleanFalseMajor: a control is one distinct clean PR with a valid run. perPr is the mean over those PRs of the false Majors of the PR averaged over its runs. The CI resamples PRs.
//  cleanRise: per set, over the clean PRs that both compared arms have a valid run on; null when they share none.
//  reliabilityFlags: { flagged, unmeasured }. unmeasured lists a metric that is null on either compared arm: an empty flagged list then does not mean no regression.
//  Counts only under 20 real Majors (MIN_CELL): a paired cell then prints n, unpaired, nNeeded, B and used and no delta, bounds, d or wouldBe. A clean-control CI needs 2 controls.
//  perArm cards carry no prFalseAlarm.prs: a new field prints no PR id. The top-level prFalseAlarm of a one-arm card keeps it.
//  A match row has cluster (evaluateRuns sets it from the dataset row). A run row whose replicate is set and invalid is not scored: attempts counts it as invalidReplicate.
//  Arms: a run or match row has arm (armKeyOf) and replicate. A card of two or more arms has no pooled number: perArm holds one card per arm. See armKeyOf, pairedBar, reliability.
import { normalizeRepoPath } from '../../github/review-filter.mjs';
import { cohenKappa } from './agreement.mjs';
import { clusterBootstrap, wilson } from './bootstrap.mjs';
import { LEGACY_ENGINE_VERSION } from './freeze.mjs';
import { pairId } from './labels.mjs';
import { foldSev, isMajor, matchFindings } from './match.mjs';

const ratio = (found, total) => ({ found, total, value: total > 0 ? found / total : null });
const lc = (s) => String(s ?? '').toLowerCase();
const isText = (x) => typeof x === 'string' && x !== '';
/** Judge agreement is a NOTE below this many Dave-labelled pairs: too few to pass or fail a judge. */
export const JUDGE_GATE_MIN_N = 30;
export const JUDGE_GATE_MIN_KAPPA = 0.6;

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

/** How many runs saw the PR body: { withheld, full, unknown } (unknown: an older run with no bodyMode). */
function bodyModes(runs) {
  const count = { withheld: 0, full: 0, unknown: 0 };
  for (const r of runs) count[r.bodyMode === 'withheld' || r.bodyMode === 'full' ? r.bodyMode : 'unknown'] += 1;
  return count;
}

/** Cells with fewer real Majors than this print counts and no value. */
export const MIN_CELL = 20;
const SOURCES = ['A', 'B', 'C', 'CR'];
const SUITE_NAMES = ['regression', 'capability'];
/** Dev and holdout never mix: each of these numbers is one cell per set. A match row with no set belongs to neither cell. */
const SET_NAMES = ['holdout', 'dev'];
const bySet = (rows, cellOf) => Object.fromEntries(SET_NAMES.map((name) => [name, cellOf(rows.filter((m) => m.set === name))]));
const cell = ({ found, total }) => ({ found, total, value: total >= MIN_CELL ? found / total : null });
const meanOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const isRealMajor = (m) => isMajor(lc(m.crSev)) && lc(m.crVerdict) === 'real';
const clusterOf = (m) => m.cluster ?? `#${m.pr}`;
const armOfRow = (x) => x.arm ?? armKeyOf(x);
const suiteOf = (suites, key) => (SUITE_NAMES.includes(suites[key]) ? suites[key] : 'unassigned');
const sourceOf = (sources, key) => (SOURCES.includes(sources[key]) ? sources[key] : 'CR');
const groupBy = (rows, keyOf) => {
  const groups = new Map();
  for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
  return groups;
};

/** The two rules that keep a row out of the holdout: a stale prompt hash, and a full-body leak. Used by the arm cards and by the paired bar. */
function rowFilters({ frozenPromptSha256 = null, frozenByReviewer = {}, frozenByArm = {} }) {
  // The frozen hash of a row is the one of its arm (frozenByArm), so two engine prompt versions each keep their own hash.
  // An arm with no entry uses the one of the row's reviewer (frozenByReviewer); a row with no reviewer, or a reviewer with no entry, uses frozenPromptSha256.
  // An entry that is not a non-empty string is no hash: the row falls through to the reviewer and folder hashes.
  const armHash = (r) => (Object.hasOwn(frozenByArm, armOfRow(r)) && isText(frozenByArm[armOfRow(r)]) ? frozenByArm[armOfRow(r)] : undefined);
  const frozenFor = (r) => armHash(r) ?? (r.reviewer ? frozenByReviewer[r.reviewer] : undefined) ?? frozenPromptSha256;
  const hashStale = (r) => r.set === 'holdout' && Boolean(frozenFor(r)) && r.promptSha256 !== frozenFor(r);
  // bodyMode 'full' showed the reviewer the merged PR body, which holds the answers: a holdout run like that is a leak, not a recall. No bodyMode (older runs) scores as before.
  const leaked = (r) => r.set === 'holdout' && r.bodyMode === 'full';
  // evaluateRuns always sets promptSha256 on a match row (null when the run had none); a row with no such field carries no hash.
  const eligible = (m) => !(m.promptSha256 !== undefined && hashStale(m)) && !leaked(m);
  return { hashStale, leaked, stale: (r) => hashStale(r) || leaked(r), eligible };
}

/** Same-issue recall of one set of rows as counts over distinct real Majors: total = keys, found = the sum of each key's mean catch over its replicates. */
function itemRatio(rows, labelBy) {
  const items = [...armItems(rows, labelBy).values()].map((it) => meanOf(it.reps));
  return { found: items.reduce((a, b) => a + b, 0), total: items.length };
}

/** Same-issue recall of each group of rows, grouped by match key: { [group]: { found, total, value } }. A group with no real Major adds no cell. */
function perGroup(rows, groupOf, labelBy) {
  const cells = [...groupBy(rows, (m) => groupOf(m.key))].map(([name, group]) => [name, itemRatio(group, labelBy)]);
  return Object.fromEntries(cells.filter(([, r]) => r.total > 0).map(([name, r]) => [name, cell(r)]));
}

/** Same-issue recall on the source A rows, with the Wilson interval of found out of total from 20 items on. */
function goldARecallOf(rowsA, labelBy) {
  const r = itemRatio(rowsA, labelBy);
  // Below the cut a cell prints counts only: no interval either.
  return { ...cell(r), ci: r.total >= MIN_CELL ? wilson(r.found, r.total) : { lo: null, hi: null } };
}

/** One arm's real Majors by key: { cluster, reps: [catch per replicate, 0 to 1] }. A catch is an engine critical/major whose pair no label calls a different issue (the strictSameIssue rule). */
function armItems(rows, labelBy) {
  const byKey = new Map();
  for (const m of rows.filter(isRealMajor)) {
    const caught = isMajor(lc(m.engSev)) && !(m.engPairId && labelBy.get(m.engPairId)?.sameIssue === false) ? 1 : 0;
    const item = byKey.get(m.key) ?? { cluster: clusterOf(m), byRep: new Map() };
    const rep = replicateOf(m);
    item.byRep.set(rep, [...(item.byRep.get(rep) ?? []), caught]);
    byKey.set(m.key, item);
  }
  return new Map([...byKey].map(([key, it]) => [key, { cluster: it.cluster, reps: [...it.byRep.values()].map(meanOf) }]));
}

/**
 * One suite cell of the paired bar. paired: [{ b, c, cluster }] (mean catch of each arm). The bootstrap resamples whole clusters of pairs. clusters is their count: under 2, wouldBe is FAIL.
 * Under MIN_CELL paired items the cell prints counts only: delta, lo, hi, d and wouldBe are null. nNeeded stays: it says how many items are needed.
 */
function suiteCell(name, paired, unpaired, { B, seed }) {
  const n = paired.length;
  const stat = (items) => (items.length ? 100 * (meanOf(items.map((i) => i.c)) - meanOf(items.map((i) => i.b))) : null);
  const clusters = [...groupBy(paired, (i) => i.cluster).values()];
  const boot = clusterBootstrap({ clusters, stat, B, seed });
  const { point, lo, hi } = boot;
  const d = n ? paired.filter((i) => i.b !== i.c).length / n : null;
  const dp = point === null ? null : point / 100;
  let nNeeded = null;
  if (d !== null && d > 0 && name === 'regression') nNeeded = Math.ceil(1537 * d);
  if (d !== null && name === 'capability' && point > 0) nNeeded = Math.max(0, Math.ceil((3.8416 * (d - dp * dp)) / (dp * dp)));
  const gate = { regression: -5, capability: 0 }[name];
  // One cluster makes every resample the full data (lo === hi === point): that is no interval, so it cannot PASS.
  const wouldBe = gate === undefined ? null : (clusters.length >= 2 && lo !== null && lo > gate ? 'PASS' : 'FAIL');
  const shown = n >= MIN_CELL;
  return { delta: shown ? point : null, lo: shown ? lo : null, hi: shown ? hi : null, n, clusters: clusters.length, unpaired, d: shown ? d : null, nNeeded, wouldBe: shown ? wouldBe : null, B: boot.B, used: boot.used };
}

/** The paired bar and the lost-Major count of two arms on ONE set. rows: the eligible match rows of every arm in that set. Counts only: no key, no PR id leaves this function. */
function pairedOf({ rows, labelBy, compare, suites, B, seed }) {
  const side = (arm) => armItems(rows.filter((m) => armOfRow(m) === arm), labelBy);
  const base = side(compare.baseline);
  const cand = side(compare.candidate);
  const keys = [...new Set([...base.keys(), ...cand.keys()])];
  const pairs = keys.filter((k) => base.has(k) && cand.has(k)).map((k) => ({ key: k, cluster: base.get(k).cluster, bReps: base.get(k).reps, cReps: cand.get(k).reps }));
  const bar = { status: 'NOTE', baseline: compare.baseline, candidate: compare.candidate };
  for (const name of [...SUITE_NAMES, 'unassigned']) {
    const paired = pairs.filter((x) => suiteOf(suites, x.key) === name).map((x) => ({ b: meanOf(x.bReps), c: meanOf(x.cReps), cluster: x.cluster }));
    const unpaired = keys.filter((k) => suiteOf(suites, k) === name && !(base.has(k) && cand.has(k))).length;
    bar[name] = suiteCell(name, paired, unpaired, { B, seed });
  }
  // Assessable: an item with 2 or more replicates on both arms. Lost: an assessable item that the baseline catches in every replicate and the candidate misses in every replicate.
  // flagged is null when no item is assessable: a count of 0 then means "not measured", not "nothing lost".
  const assessable = pairs.filter((x) => x.bReps.length >= 2 && x.cReps.length >= 2);
  const lost = assessable.filter((x) => x.bReps.every((v) => v === 1) && x.cReps.every((v) => v === 0)).length;
  return { pairedBar: bar, lostCaughtMajors: { count: lost, assessable: assessable.length, flagged: assessable.length === 0 ? null : lost > 0 } };
}

/**
 * False Majors on clean PRs for one arm. A control is one distinct clean PR that has at least one valid run, not a run.
 * perPr = the mean over clean PRs of (the false Majors of that PR, averaged over its valid runs). falseMajors and runs are raw totals over the valid runs.
 * The CI resamples PRs: one cluster per PR holds its runs. Each run item has the weight 1 / (runs of its PR), so a PR drawn twice counts twice.
 * valid: the valid runs of ONE set (scoreOne calls it once per set).
 * With fewer than 2 controls lo and hi are null: one control gives no interval.
 */
const falseMajorsOf = (r) => (r.findings ?? []).filter((f) => isMajor(lc(f.sev))).length;
function cleanFalseMajorOf(valid, cleanPrs, { B, seed }) {
  const clean = new Set(cleanPrs);
  const runsOf = groupBy(valid.filter((r) => clean.has(r.pr)), (r) => r.pr);
  const clusters = [...runsOf.values()].map((rs) => rs.map((r) => ({ n: falseMajorsOf(r), w: 1 / rs.length })));
  const stat = (items) => (items.length ? items.reduce((x, i) => x + i.n * i.w, 0) / items.reduce((x, i) => x + i.w, 0) : null);
  const perPr = meanOf(clusters.map((rs) => meanOf(rs.map((i) => i.n))));
  const { lo, hi } = clusterBootstrap({ clusters, stat, B, seed });
  const enough = clusters.length >= 2;
  return { controls: clusters.length, falseMajors: clusters.flat().reduce((x, i) => x + i.n, 0), runs: clusters.flat().length, perPr, lo: enough ? lo : null, hi: enough ? hi : null };
}

function scoreOne({ runs = [], matches = [], labels = [], sets = {}, linkTypes = {}, frozenPromptSha256 = null, frozenByReviewer = {}, frozenByArm = {}, escapes = {}, bakeoff = {}, headless = {}, pairsSent = [], suites = {}, sources = {}, cleanPrs = [], B = 2000, seed = 1 } = {}) {
  // A holdout run (or match row) with another prompt hash leaves every holdout number: recall, precision, false alarms, cost.
  // The frozen hash is the one of the row's arm (frozenByArm), else the one of its reviewer (frozenByReviewer), else frozenPromptSha256.
  const { stale, eligible } = rowFilters({ frozenPromptSha256, frozenByReviewer, frozenByArm });
  // A run whose coverage was incomplete missed files by design: its Majors are not misses of the reviewer. It leaves every number and shows in excludedRuns.
  const valid = runs.filter((r) => !stale(r) && r.coverageComplete !== false);
  const labelBy = labelMap(labels);
  // evaluateRuns always sets promptSha256 on a match row (null when the run had none); a row with no such field carries no hash.
  const holdoutRows = matches.filter((m) => m.set === 'holdout' && eligible(m));
  const eligibleRows = matches.filter(eligible);
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
  // Raw agreement alone passes a judge that always gives the common verdict (kappa 0). Kappa must be defined and at least 0.6.
  const gateMet = agreement !== null && agreement >= 0.8 && kappa !== null && kappa >= JUDGE_GATE_MIN_KAPPA;
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
    judgeAgreement: { n: joined.length, agree, value: agreement, kappa, gate: 0.8, kappaGate: JUDGE_GATE_MIN_KAPPA, status: judgeStatus, pass: judgeStatus === 'PASS' },
    excludedRuns: runs.length - valid.length,
    bodyModes: bodyModes(runs),
    perSuite: bySet(eligibleRows, (rows) => perGroup(rows, (key) => suiteOf(suites, key), labelBy)),
    perSource: bySet(eligibleRows, (rows) => perGroup(rows, (key) => sourceOf(sources, key), labelBy)),
    goldARecall: bySet(eligibleRows, (rows) => goldARecallOf(rows.filter((m) => sourceOf(sources, m.key) === 'A'), labelBy)),
    cleanFalseMajor: bySet(valid, (rows) => cleanFalseMajorOf(rows, cleanPrs, { B, seed })),
  };
}

/** Top-level keys that no card of two or more arms may carry: a pooled number would blend the arms. */
const POOLED_KEYS = ['perMajorRecall', 'perPrRecall', 'funnel', 'withdrawnMisses', 'perClassRecall', 'prFalseAlarm', 'precision', 'recall', 'devRecall'];

const RELIABILITY_LIMIT_POINTS = 2;

/** Nearest-rank percentile of a list of numbers; null for an empty list. */
function percentile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

/** Mean over the rounds that have 2 or more replicates of the population variance of the posted finding count. Null when no round has 2. */
function findingsVarianceOf(valid) {
  const variances = [...groupBy(valid.filter((r) => r.status !== 'incomplete'), (r) => [r.pr, r.round, r.sha40].join('|')).values()]
    .filter((g) => g.length >= 2)
    .map((g) => {
      const counts = g.map((r) => (r.findings ?? []).length);
      const mean = meanOf(counts);
      return meanOf(counts.map((c) => (c - mean) ** 2));
    });
  return meanOf(variances);
}

/** The reliability row of one arm. runs: the arm's output runs. a: the arm's attempts row from evaluateRuns (undefined when the caller gave none). */
function reliabilityOf(runs, a, { stale }) {
  const valid = runs.filter((r) => !stale(r) && r.coverageComplete !== false);
  // The share counts the ok rows that carry a boolean repairedJson. A row with no flag is not a row without repair.
  const flagged = runs.filter((r) => r.status === 'ok' && typeof r.repairedJson === 'boolean');
  return {
    runFailure: a && a.newest > 0 ? a.failed / a.newest : null,
    repairedJson: flagged.length > 0 ? flagged.filter((r) => r.repairedJson === true).length / flagged.length : null,
    p95WallMs: percentile(valid.map((r) => r.durationMs).filter(Number.isFinite), 0.95),
    findingsVariance: findingsVarianceOf(valid),
    attempts: a?.attempts ?? null,
    failedThenOk: a?.failedThenOk ?? null,
  };
}

/**
 * { flagged, unmeasured }; null without compare. flagged: the metrics where the candidate is worse than the baseline by more than 2 points (shares x 100).
 * Rounding first keeps 0.05 - 0.03 at 2 points. unmeasured: the metrics that are null on either arm. A null metric is never flagged, so an empty flagged list holds only for the metrics that are not unmeasured.
 */
function reliabilityFlagsOf(compare, reliability) {
  if (!compare) return null;
  const metrics = ['runFailure', 'repairedJson'];
  const pair = (metric) => [reliability[compare.baseline]?.[metric], reliability[compare.candidate]?.[metric]];
  const measured = (metric) => pair(metric).every((v) => typeof v === 'number');
  const worse = (metric) => measured(metric) && Math.round((pair(metric)[1] - pair(metric)[0]) * 100 * 1e6) / 1e6 > RELIABILITY_LIMIT_POINTS;
  return { flagged: metrics.filter(worse), unmeasured: metrics.filter((m) => !measured(m)) };
}

/** The paired bar and the lost-Major count, one cell per set: { pairedBar: { holdout, dev }, lostCaughtMajors: { holdout, dev } }. */
function pairedBySet(input) {
  const cells = bySet(input.rows, (rows) => pairedOf({ ...input, rows }));
  return { pairedBar: Object.fromEntries(SET_NAMES.map((n) => [n, cells[n].pairedBar])), lostCaughtMajors: Object.fromEntries(SET_NAMES.map((n) => [n, cells[n].lostCaughtMajors])) };
}

/** A copy of an arm card whose prFalseAlarm has count and total and no PR list. */
const withoutPrs = (card) => ({ ...card, prFalseAlarm: { count: card.prFalseAlarm.count, total: card.prFalseAlarm.total } });

/** Per-arm keys of the gold rows. A card of two or more arms keeps them in perArm only. */
const ARM_ONLY_KEYS = ['perSuite', 'perSource', 'goldARecall', 'cleanFalseMajor'];

/** One arm's false Majors per clean PR of one set: Map pr -> the mean over the PR's valid runs. */
function cleanPrMeans(valid, arm, set, cleanPrs) {
  const clean = new Set(cleanPrs);
  const runs = valid.filter((r) => r.set === set && clean.has(r.pr) && armOfRow(r) === arm);
  return new Map([...groupBy(runs, (r) => r.pr)].map(([pr, rs]) => [pr, meanOf(rs.map(falseMajorsOf))]));
}

/**
 * { holdout, dev }; null without compare. Each is true when the candidate has more false Majors per clean PR than the baseline, over the clean PRs that
 * BOTH arms have a valid run on in that set. null when the arms share no clean PR in the set.
 */
function cleanRiseOf(compare, valid, cleanPrs) {
  if (!compare) return null;
  const rise = (set) => {
    const [base, cand] = [compare.baseline, compare.candidate].map((arm) => cleanPrMeans(valid, arm, set, cleanPrs));
    const shared = [...base.keys()].filter((pr) => cand.has(pr));
    return shared.length === 0 ? null : meanOf(shared.map((pr) => cand.get(pr))) > meanOf(shared.map((pr) => base.get(pr)));
  };
  return Object.fromEntries(SET_NAMES.map((name) => [name, rise(name)]));
}

/** One reliability row per arm. An arm that has attempts but no output run (every row failed) still gets a row. */
function reliabilityByArm(runs, arms, input, stale) {
  const attempts = input.attempts ?? {};
  const names = [...new Set([...arms, ...Object.keys(attempts)])].sort();
  return Object.fromEntries(names.map((a) => [a, reliabilityOf(runs.filter((r) => armOfRow(r) === a), input.attempts ? attempts[a] : undefined, { stale })]));
}

/**
 * The scorecard. One arm (or none): the scoreOne card plus arms and perArm. Two or more arms: the pooled keys are null and perArm holds one scoreOne card per arm.
 * A run's arm is run.arm (evaluateRuns sets it) or armKeyOf(run). A match row's arm is m.arm or armKeyOf(m). The arms are the union of both, so a match row of an arm with no run makes a second arm.
 * A perArm card has no prFalseAlarm.prs: a new field prints no PR id.
 */
export function scorecard(input = {}) {
  const runs = input.runs ?? [];
  const matches = input.matches ?? [];
  const arms = [...new Set([...runs, ...matches].map(armOfRow))].sort();
  const { compare = null, suites = {}, B = 2000, seed = 1 } = input;
  const { eligible, stale } = rowFilters(input);
  const reliability = reliabilityByArm(runs, arms, input, stale);
  const paired = compare ? pairedBySet({ rows: matches.filter(eligible), labelBy: labelMap(input.labels ?? []), compare, suites, B, seed }) : { pairedBar: null, lostCaughtMajors: null };
  const armCard = (a) => scoreOne({ ...input, runs: runs.filter((r) => armOfRow(r) === a), matches: matches.filter((m) => armOfRow(m) === a) });
  let card;
  let perArm;
  if (arms.length <= 1) {
    card = scoreOne(input);
    perArm = Object.fromEntries(arms.map((a) => [a, withoutPrs(card)]));
  } else {
    perArm = Object.fromEntries(arms.map((a) => [a, withoutPrs(armCard(a))]));
    const all = scoreOne(input);
    card = { ...all, ...Object.fromEntries([...POOLED_KEYS, ...ARM_ONLY_KEYS].map((k) => [k, null])), cost: { ...all.cost, grok: null } };
  }
  return { ...card, arms, perArm, ...paired, cleanRise: cleanRiseOf(compare, runs.filter((r) => !stale(r) && r.coverageComplete !== false), input.cleanPrs ?? []), reliability, reliabilityFlags: reliabilityFlagsOf(compare, reliability) };
}

/** The arm of a run row: armId when set, else reviewer | promptVersion (engine only) | model | backend. Same groups as cli.mjs newestPerArm. */
export function armKeyOf(run) {
  if (typeof run?.armId === 'string' && run.armId !== '') return run.armId;
  const reviewer = run?.reviewer ?? 'none';
  return [reviewer, reviewer === 'engine' ? (run?.promptVersion ?? LEGACY_ENGINE_VERSION) : '-', run?.model ?? '-', run?.backend ?? '-'].join('|');
}

/** A replicate number is an integer of 1 or more. */
const validReplicate = (v) => Number.isInteger(v) && v >= 1;

/** The replicate of a run row: 1 when it is undefined, else the value as it is. An invalid value (0, -1, 1.5, '3', null) stays invalid: evaluateRuns does not score that row. */
export const replicateOf = (run) => (run?.replicate === undefined ? 1 : run.replicate);

/** Join the RAW run rows of several folders: call it before evaluateRuns, which stamps replicate 1 on a row that has none. A row with an undefined replicate gets the folder number (first folder is replicate 1). A set value stays, valid or not. */
export function joinReplicates(folders) {
  return folders.flatMap((rows, i) => rows.map((r) => ({ ...r, replicate: r?.replicate === undefined ? i + 1 : r.replicate })));
}

const isFailure = (r) => r.status !== 'ok' && r.status !== 'incomplete';

/**
 * runs.jsonl is append-only, so a re-run adds a second row for the same round. The newest row per (pr, round, sha40, arm, replicate) wins,
 * by ts, and on a tie (or an unreadable ts) the later line wins. A newest row that is not ok makes the round a failure.
 * Returns the groups in line order: { r: the newest row, earlierNotOk: true when an older row of the group was a failure }.
 */
function newestPerRound(runs) {
  const best = new Map();
  runs.forEach((r, i) => {
    const key = [r.pr, r.round, r.sha40, armKeyOf(r), replicateOf(r)].join('|');
    const t = Date.parse(r.ts);
    const prev = best.get(key);
    const earlierNotOk = Boolean(prev?.earlierNotOk) || (prev ? isFailure(prev.r) : false);
    if (!prev || !(t < prev.t)) best.set(key, { t, i, r, earlierNotOk });
    else prev.earlierNotOk = prev.earlierNotOk || isFailure(r);
  });
  return [...best.values()].sort((a, b) => a.i - b.i);
}

/**
 * Per arm: { attempts (every row), newest (newest rows), failed (newest rows that are not ok and not incomplete), failedThenOk (groups that ended ok or incomplete after a failure),
 * invalidReplicate (rows whose replicate is set and invalid: they count in attempts, and in no other number) }.
 */
function attemptsByArm(runs, groups) {
  const out = {};
  const slot = (arm) => (out[arm] ??= { attempts: 0, newest: 0, failed: 0, failedThenOk: 0, invalidReplicate: 0 });
  for (const r of runs) {
    const a = slot(armKeyOf(r));
    a.attempts += 1;
    if (!validReplicate(replicateOf(r))) a.invalidReplicate += 1;
  }
  for (const g of groups) {
    const a = slot(armKeyOf(g.r));
    a.newest += 1;
    if (isFailure(g.r)) a.failed += 1; else if (g.earlierNotOk) a.failedThenOk += 1;
  }
  return out;
}

/**
 * Did the reviewer withdraw a finding at the place of this dataset finding? Same file, and a line within tol of its lines (a dataset finding with no
 * lines matches on the file alone). null when the run has no withdrawn list (an old run): "unknown", not "no".
 */
function nearWithdrawn(withdrawn, c, tol) {
  if (withdrawn === null) return null;
  return withdrawn.some((w) => normalizeRepoPath(w?.path) === normalizeRepoPath(c.file) && (c.start == null || (Number.isFinite(w.line) && w.line >= c.start - tol && w.line <= (c.end ?? c.start) + tol)));
}

/**
 * The cluster of a match row, from the dataset row: d.cluster when it is a non-empty string, else range:<range> for a range row,
 * else owner/repo#pr in lower case (the goldKey form: an own-repo row gives '#pr'). The repo comes from the dataset row, else the run.
 */
function clusterOfDataset(d, run) {
  if (isText(d.cluster)) return d.cluster;
  const range = d.range ?? d.target?.range;
  if (isText(range)) return `range:${range}`;
  return `${String(d.repo ?? d.target?.repo ?? run.repo ?? '').toLowerCase()}#${run.pr}`;
}

/**
 * Glue: match each replayed run against the dataset findings of its (pr, sha40).
 * runs: run records (with findingsPath). dataset: resolved findings. readFindings(path) => { findings: [{ file, line, lineEnd, severity, title }] }.
 * Returns { runs, matches, attempts } ready for scorecard(). runs: [{ ...run, arm, replicate, findings: [{ id, pairId, sev, matchedKey }] }]. matches: one row per dataset finding of a replayed round, with arm, replicate and cluster.
 * A row whose replicate is set and invalid is not scored. attempts: { [arm]: { attempts, newest, failed, failedThenOk, invalidReplicate } }.
 */
export function evaluateRuns({ runs, dataset, readFindings, tol = 3 }) {
  const outRuns = [];
  const matches = [];
  const groups = newestPerRound(runs.filter((r) => validReplicate(replicateOf(r))));
  for (const run0 of groups.map((g) => g.r).filter((r) => r.status === 'ok' || r.status === 'incomplete')) {
    const run = { ...run0, arm: armKeyOf(run0), replicate: replicateOf(run0) };
    // An incomplete run (status incomplete, or an older ok row with coverageComplete false) stays in the output so the card counts it as excluded,
    // but it adds no match rows: its Majors are not misses.
    if (run.status === 'incomplete' || run.coverageComplete === false) { outRuns.push({ ...run, coverageComplete: false, findings: [] }); continue; }
    // id is only a fallback label key for hand-made labels: ingestLabels writes findingId = pairId, never this id. The id holds the arm and the replicate, so a hand label cannot reach the findings of another arm or replicate.
    // pairId is the key ingestLabels writes; it must use the same fields as the exported pair (pr, sha40, file, raw line, title).
    const found = readFindings(run.findingsPath);
    const withdrawn = Array.isArray(found.withdrawn) ? found.withdrawn : null;
    const eng = (found.findings ?? []).map((f, i) => ({ src: 'engine', id: `${run.pr}-${run.round}-${run.arm}-r${run.replicate}-${i}`, pairId: pairId({ pr: run.pr, sha: run.sha40, file: f.file, line: f.line, engineTitle: f.title }), file: f.file, start: Number.isFinite(f.line) ? f.line : null, end: Number.isFinite(f.lineEnd) ? f.lineEnd : (Number.isFinite(f.line) ? f.line : null), sev: lc(f.severity) }));
    const cr = dataset.filter((d) => d.pr === run.pr && d.sha40 === run.sha40).map((d) => ({ src: 'cr', id: d.key, file: d.path, start: d.startLine, end: d.endLine, sev: foldSev(d.severity), d }));
    const res = matchFindings(cr, eng, { tol });
    const hit = new Map(res.matches.map((m) => [m.cr.id, m.eng]));
    for (const c of cr) matches.push({ key: c.id, pr: run.pr, arm: run.arm, replicate: run.replicate, cluster: clusterOfDataset(c.d, run), set: run.set, reviewer: run.reviewer ?? null, promptSha256: run.promptSha256 ?? null, bodyMode: run.bodyMode ?? null, crSev: c.sev, crVerdict: c.d.verdict, crSource: c.d.source, engSev: hit.get(c.id)?.sev ?? null, engPairId: hit.get(c.id)?.pairId ?? null, inWithdrawn: nearWithdrawn(withdrawn, c, tol) });
    const byEng = new Map(res.matches.map((m) => [m.eng.id, m.cr.id]));
    outRuns.push({ ...run, findings: eng.map((e) => ({ id: e.id, pairId: e.pairId, sev: e.sev, matchedKey: byEng.get(e.id) ?? null })) });
  }
  return { runs: outRuns, matches, attempts: attemptsByArm(runs, groups) };
}
