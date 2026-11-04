#!/usr/bin/env node
// score-arms.mjs: score the P1 arms of TREX verify on the narrowed set and apply the narrowed gates (design section 5,
// "P1 narrowed scope"). No model, no container, no network: it only reads C2 verdict files and probe-set.json.
//
//   node scripts/trex/verify/score-arms.mjs [--out <dir>] [--arms verify,oracle0,rerate] [--probe-set <file>] [--no-write]
//
// Input (contract C2): <out>/<arm>/verdicts.json = { arm, generatedFrom, rows: [{ pid, row, group, verdict, reason, originalSeverity,
// originalConfidence, newSeverity, newConfidence, falseConfirm, evidencePath }] } with every one of the 44 probe-set pids once.
// Default <out>: C:\Users\dkhay\continuous-claude\.claude\cache\e2e\trex-verify-p1. The arm `baseline` is built from probe-set.json.
//
// SCORED SET: group A with no classify block (S1, S8, S11) + group B with no classify block (13) = 16. Group C is reported, never gated.
//
// HOW AN ARM IS APPLIED
//   verify, oracle0*  severity and confidence come from applyVerdict (verdict.mjs), never from the file. A newSeverity or
//                     newConfidence in the file that disagrees is a "drift" warning: a lie in the file cannot raise precision.
//   any other arm     (rerate) the file's newSeverity / newConfidence are used, because rerate lowers ONE level by its own rule
//                     (critical to major, major to minor). An arm that raises either value above the baseline is rejected.
//   apply-verdicts.mjs (the writer of record copies, design section 6) is not imported: this file scores probe-set rows, not baseline records.
//   The two give the same kept counts for a file that does not lie: score-arms.test.mjs applies verify and rerate files to the real baseline
//   records with apply-verdicts and counts isMajorOpen on the copies (last test of that file).
//   Both files lower through applyVerdict (verdict.mjs), so they agree on minor/2 and trivial/1. They differ in one place: apply-verdicts
//   also lowers by a file's own newSeverity for every arm; here verify and oracle0 ignore the file's value (drift warning) so a lie in a file
//   cannot raise precision.
//
// THREE VIEWS of "still a Major" (the design asks for both scorers; the third is what option F counts on negative rows):
//   severityOnly  isMajor(severity)                       review-eval score.mjs:52, match.mjs
//   optionF       majorFindings (severity and confidence>=3)  scripts/eval/trex-baseline/adapter.mjs, used by trex-baseline score.mjs
//   majorOpen     isMajorOpen (severity, status open, confidence>=3)  scripts/github/local-review/record.mjs, the record contract
// The gates use majorOpen. The overall of every view is printed, and a view that gives another overall is a warning.
// (trex-baseline score.mjs main() is NOT called: it runs the claude -p judge.)
//
// DEFINITIONS
//   keptHits   scored hits still a Major in the view.      hitsLost = 3 - keptHits.
//   keptB      scored group B findings still a Major.       precision (no relabel) = keptHits / (keptHits + keptB).
//   cutB       scored group B findings with verdict not_reproduced or refuted (the verdict, not the view).
//   blocked+unverified  verdict starts with "blocked:" or is "unverified". env-down is excluded. not_attempted is counted and reported
//                       apart (design (d) names blocked plus unverified only; a verify arm that tests nothing fails (a) anyway).
//   x2 agreement  a row "agreed" when its evidence (evidencePath: a JSON file { head: [{ exitClass, normalizedOutput|failLine }] }, or the
//                 folder verify.mjs writes, whose runs.json lists { side, label, exitClass, failLine, note? }) shows 2 or more
//                 head runs of one outcome; with no readable evidence, when its verdict could only be reached through G6 (reproduced,
//                 reproduced_new, not_reproduced, unverified, refuted). "disagreed": blocked:disagree or runs that differ. Every
//                 other row is "notShown" and does not count as agreed. Gate (e) needs agreed >= 15 of 16.
//   rerate matches verify  rerate precision >= verify precision AND rerate hitsLost <= verify hitsLost.
//   verify beats an arm    verify precision > arm precision AND verify hitsLost <= arm hitsLost.
//
// NARROWED GATES (the table in the design). PASS needs all of (a)-(f). KILL if any KILL line holds. Otherwise WATCH.
//   (a) group B cut                     PASS >= 8 of 13   KILL <= 5          else WATCH
//   (b) hits lost, false_confirm        PASS 0 and 0      KILL >= 2 lost     else WATCH (1 lost, or a false_confirm)
//   (c) precision, binding              PASS >= 50%                           else WATCH
//   (d) blocked+unverified              PASS <= 4         KILL > 7           else WATCH
//   (e) x2 agreement                    PASS >= 15 of 16                      else WATCH
//   (f) beats oracle0 and rerate        PASS               KILL if rerate matches verify   else WATCH
// A missing arm gives NO-DATA for the gate that needs it. NO-DATA is never PASS. With no verify arm the overall is NO-DATA.
//
// LIVE ARMS ONLY (critic fixes 1 and 2). An arm file counts only when it says dryRun: false and is not partial. A file with no dryRun
// marker (an old file) is NOT live. A dry run, a --only run and a legacy file give NO-DATA, never a score:
//   verify arm not live        every gate NO-DATA.
//   control arm (rerate, oracle0*) not live, or its attemptedPids does not hold every scored pid: gate (f) NO-DATA. KILL "rerate matches
//                              verify" needs a usable rerate too. The gate line says "attempted N of 16".
//   (b) PASS needs all 3 hits TESTED: a boolean falseConfirm (a fix run happened) and a verdict that is not blocked, not_attempted or
//                              env-down. Otherwise NO-DATA ("N of 3 hits tested"). 2 or more hits lost is still KILL.
//   The overall is KILL when any gate is KILL, else NO-DATA when any gate is NO-DATA, else PASS when all pass, else WATCH.
//   Every gate line ends with "[B cut: not_reproduced N, refuted M]": a refute is a cut of the finding but also what a bad probe makes.
//   attemptedPids (a list in the arm file): the pids the arm judged. rerate: a usable model answer. oracle0: the finding's tests were planned
//                              and run. verify: not required (the verify arm is judged on its rows).
// Exit: 0 report printed (PASS, WATCH, KILL and NO-DATA are all results), 2 bad input.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMajor } from '../../eval/review-eval/match.mjs';
import { majorFindings } from '../../eval/trex-baseline/adapter.mjs';
import { isMajorOpen } from '../../github/local-review/record.mjs';
import { BLOCK_REASONS, VERDICTS, applyVerdict } from './verdict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = 'C:\\Users\\dkhay\\continuous-claude\\.claude\\cache\\e2e\\trex-verify-p1';
export const GATE_LIMITS = Object.freeze({ aPass: 8, aKill: 5, bLostPass: 0, bLostKill: 2, precisionPass: 0.5, dPass: 4, dKill: 7, ePass: 15 });
export const VIEWS = Object.freeze(['majorOpen', 'severityOnly', 'optionF']);
const VIEW_TEST = {
  majorOpen: (f) => isMajorOpen(f),
  severityOnly: (f) => isMajor(f.severity),
  optionF: (f) => majorFindings([f]).length === 1,
};
const CUT = new Set(['not_reproduced', 'refuted']);
const AGREES_BY_CONSTRUCTION = new Set(['reproduced', 'reproduced_new', 'not_reproduced', 'unverified', 'refuted']);
const SEV_RANK = { critical: 5, major: 4, minor: 3, trivial: 2, info: 1 };
const RECOMPUTED = /^(verify|oracle0)/;
export class InputError extends Error {}

const ratio = (n, d) => (d > 0 ? n / d : null);
const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 1000) / 10}%`);
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

// ---------- inputs ----------

export function loadProbeSet(file = path.join(HERE, 'probe-set.json')) {
  const ps = readJson(file);
  if (!Array.isArray(ps.rows)) throw new InputError(`${file}: no rows`);
  return ps;
}

/** The scored set: groups A and B findings that classify did not block. */
export function narrowedSet(rows) {
  return { a: rows.filter((r) => r.group === 'A' && !r.blocked), b: rows.filter((r) => r.group === 'B' && !r.blocked) };
}

/** The `baseline` arm: no change. A classify block stays a block; every other finding is not_attempted. */
export function synthesizeBaseline(probeSet) {
  return {
    arm: 'baseline', dryRun: false, partial: false, generatedFrom: 'probe-set.json (no change)',
    rows: probeSet.rows.map((r) => ({
      pid: r.pid, row: r.row, group: r.group, verdict: r.blocked ? `blocked:${r.blocked}` : 'not_attempted', reason: r.blocked ? `classify: ${r.blocked}` : 'baseline: no change',
      originalSeverity: r.severity, originalConfidence: r.confidence, newSeverity: r.severity, newConfidence: r.confidence, falseConfirm: null, evidencePath: null,
    })),
  };
}

export function loadArm(file) {
  if (!existsSync(file)) throw new InputError(`${file}: file not found`);
  try {
    return readJson(file);
  } catch (e) {
    throw new InputError(`${file}: ${e.message}`);
  }
}

const validVerdict = (name, v) => {
  if (typeof v !== 'string' || v === '') return false;
  if (!RECOMPUTED.test(name)) return true;
  return VERDICTS.includes(v) || (v.startsWith('blocked:') && BLOCK_REASONS.includes(v.slice(8)));
};

/** Throws InputError unless the file holds every probe-set pid exactly once, each with a usable verdict. */
export function validateArm(armFile, probeRows) {
  const name = armFile?.arm ?? '?';
  if (!Array.isArray(armFile?.rows)) throw new InputError(`arm ${name}: "rows" must be an array`);
  const known = new Set(probeRows.map((r) => r.pid));
  const seen = new Set();
  for (const r of armFile.rows) {
    if (!known.has(r?.pid)) throw new InputError(`arm ${name}: unknown pid ${JSON.stringify(r?.pid)}`);
    if (seen.has(r.pid)) throw new InputError(`arm ${name}: duplicate pid ${r.pid}`);
    seen.add(r.pid);
    if (!validVerdict(name, r.verdict)) throw new InputError(`arm ${name}: pid ${r.pid} has verdict ${JSON.stringify(r.verdict)}, which is not allowed for this arm`);
  }
  const missing = probeRows.filter((r) => !seen.has(r.pid));
  if (missing.length) throw new InputError(`arm ${name}: missing pid(s) ${missing.length} of ${probeRows.length}: ${missing.slice(0, 3).map((r) => r.pid).join(', ')}${missing.length > 3 ? ', ...' : ''}`);
}

// ---------- apply ----------

function noRaise(name, row, orig, sev, conf) {
  const raised = (SEV_RANK[sev] ?? 0) > (SEV_RANK[orig.severity] ?? 0) || (Number.isFinite(conf) && conf > (orig.confidence ?? 3));
  if (raised) throw new InputError(`arm ${name}: pid ${row.pid} raises severity or confidence above the baseline (${orig.severity}/${orig.confidence} -> ${sev}/${conf})`);
}

function applyRow(name, row, p, warnings) {
  const base = { id: p.pid, file: p.file, severity: p.severity, confidence: p.confidence, status: 'open' };
  if (row.originalSeverity !== undefined && row.originalSeverity !== p.severity) warnings.push(`drift: ${name} ${p.pid} originalSeverity ${row.originalSeverity} differs from probe-set ${p.severity}`);
  const byRule = applyVerdict(base, { verdict: row.verdict, reason: row.reason });
  const hasNew = typeof row.newSeverity === 'string';
  if (!RECOMPUTED.test(name) && hasNew) {
    const conf = Number.isFinite(row.newConfidence) ? row.newConfidence : p.confidence;
    noRaise(name, row, base, row.newSeverity, conf);
    return { ...base, severity: row.newSeverity, confidence: conf };
  }
  if (hasNew && (row.newSeverity !== byRule.severity || (Number.isFinite(row.newConfidence) && row.newConfidence !== byRule.confidence))) {
    warnings.push(`drift: ${name} ${p.pid} file says ${row.newSeverity}/${row.newConfidence}, verdict ${row.verdict} gives ${byRule.severity}/${byRule.confidence}; the verdict rule is used`);
  }
  return { ...base, severity: byRule.severity, confidence: byRule.confidence };
}

/** Every probe-set row with the arm's verdict and the finding after the arm is applied. */
export function applyArm(armFile, probeRows) {
  const name = armFile.arm;
  validateArm(armFile, probeRows);
  const by = new Map(armFile.rows.map((r) => [r.pid, r]));
  const warnings = [];
  const rows = probeRows.map((p) => {
    const r = by.get(p.pid);
    return { pid: p.pid, row: p.row, group: p.group, blocked: p.blocked, verdict: r.verdict, reason: r.reason ?? '', falseConfirm: r.falseConfirm === true, falseConfirmSeen: typeof r.falseConfirm === 'boolean', evidencePath: r.evidencePath ?? null, finding: applyRow(name, r, p, warnings) };
  });
  return { name, rows, warnings };
}

// ---------- metrics ----------

const allStrings = (xs) => xs.every((x) => typeof x === 'string');
const headRunsAgree = (head) => {
  if (new Set(head.map((h) => String(h?.exitClass))).size !== 1) return false;
  for (const key of ['normalizedOutput', 'failLine']) {
    const xs = head.map((h) => h?.[key]);
    if (allStrings(xs)) return new Set(xs).size === 1;
  }
  return true;
};

/**
 * Evidence for one row. A JSON file { head: [run, ...] } or { agree: bool }, or a folder written by verify.mjs whose runs.json is a list of
 * { label, side, exitClass, failLine }: the head runs are the side "head" entries without a note (the G9 revert run carries a note).
 */
export function readEvidenceFile(p, baseDir) {
  try {
    const abs = path.isAbsolute(p) ? p : path.join(baseDir, p);
    if (statSync(abs).isDirectory()) {
      const runs = readJson(path.join(abs, 'runs.json'));
      return Array.isArray(runs) ? { head: runs.filter((r) => r?.side === 'head' && !r.note) } : null;
    }
    return readJson(abs);
  } catch {
    return null;
  }
}

function agreementOf(row, readEvidence) {
  if (row.verdict === 'blocked:disagree') return 'disagreed';
  const ev = row.evidencePath ? readEvidence(row.evidencePath) : null;
  if (Array.isArray(ev?.head)) return ev.head.length < 2 ? 'notShown' : headRunsAgree(ev.head) ? 'agreed' : 'disagreed';
  if (typeof ev?.agree === 'boolean') return ev.agree ? 'agreed' : 'disagreed';
  return AGREES_BY_CONSTRUCTION.has(row.verdict) && !/does not exist/.test(row.reason) ? 'agreed' : 'notShown';
}

/** A verdict that came from a run: not blocked, not not_attempted, not env-down. */
const RAN = (v) => !(v.startsWith('blocked:') || v === 'not_attempted' || v === 'env-down');

const countBy = (rows, f) => rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] ?? 0) + 1; return m; }, {});

function viewMetrics(hits, bs, test) {
  const keptHits = hits.filter((r) => test(r.finding)).length;
  const keptB = bs.filter((r) => test(r.finding)).length;
  return { keptHits, hitsLost: hits.length - keptHits, keptB, precision: ratio(keptHits, keptHits + keptB) };
}

/** Metrics of one arm over a row subset (the scored set or the original 22). */
function metricsOf(rows, readEvidence) {
  const hits = rows.filter((r) => r.group === 'A');
  const bs = rows.filter((r) => r.group === 'B');
  const live = rows.filter((r) => r.verdict !== 'env-down');
  const blocked = rows.filter((r) => r.verdict.startsWith('blocked:') || r.verdict === 'unverified');
  const ag = countBy(rows, (r) => agreementOf(r, readEvidence));
  return {
    n: rows.length, hits: hits.length, bs: bs.length,
    byView: Object.fromEntries(VIEWS.map((v) => [v, viewMetrics(hits, bs, VIEW_TEST[v])])),
    cutB: bs.filter((r) => CUT.has(r.verdict)).length,
    notReproducedB: bs.filter((r) => r.verdict === 'not_reproduced').length,
    refutedB: bs.filter((r) => r.verdict === 'refuted').length,
    hitsTested: hits.filter((r) => r.falseConfirmSeen && RAN(r.verdict)).length,
    hitsUntested: hits.filter((r) => !(r.falseConfirmSeen && RAN(r.verdict))).map((r) => `${r.pid} ${r.row} ${r.falseConfirmSeen ? r.verdict : `no fix run, ${r.verdict}`}`),
    blockedUnverified: blocked.length,
    blockedBreakdown: countBy(blocked, (r) => r.verdict),
    blockedShare: ratio(blocked.length, live.length),
    notAttempted: rows.filter((r) => r.verdict === 'not_attempted').length,
    envDown: rows.length - live.length,
    falseConfirm: rows.filter((r) => r.falseConfirm).length,
    agreement: { agreed: ag.agreed ?? 0, disagreed: ag.disagreed ?? 0, notShown: ag.notShown ?? 0, of: rows.length },
  };
}

/**
 * Is the arm file a live, complete run? { live, why, attempted, of }. Only a file with dryRun === false that is not partial is live.
 * attempted = how many scored pids the file lists in attemptedPids. The synthetic baseline is built with dryRun false.
 */
export function armMeta(file, scoredPids) {
  const list = Array.isArray(file.attemptedPids) ? new Set(file.attemptedPids) : new Set();
  const attempted = scoredPids.filter((p) => list.has(p)).length;
  const base = { attempted, of: scoredPids.length };
  if (file.dryRun === true) return { ...base, live: false, why: 'is a dry run (dryRun true)' };
  if (file.dryRun !== false) return { ...base, live: false, why: 'has no dryRun marker (an old file is not a live run)' };
  if (file.partial === true) return { ...base, live: false, why: 'file is partial (a --only or unfinished run)' };
  return { ...base, live: true, why: null };
}

function armReport(applied, probeRows, narrow, readEvidence, meta) {
  const pids = (list) => new Set(list.map((r) => r.pid));
  const scored = pids([...narrow.a, ...narrow.b]);
  const ab = applied.rows.filter((r) => r.group === 'A' || r.group === 'B');
  const c = applied.rows.filter((r) => r.group === 'C');
  return {
    narrowed: metricsOf(applied.rows.filter((r) => scored.has(r.pid)), readEvidence),
    original: metricsOf(ab, readEvidence),
    groupC: { n: c.length, verdicts: countBy(c, (r) => r.verdict) },
    meta,
    warnings: applied.warnings,
  };
}

function modsHostShare(probeRows, narrow) {
  const share = (rows) => ({ blocked: rows.filter((r) => r.blocked === 'mods-host').length, of: rows.length });
  return { all: share(probeRows), scoredAB: share(probeRows.filter((r) => r.group !== 'C')), narrowed: share([...narrow.a, ...narrow.b]) };
}

// ---------- gates ----------

const gate = (id, status, reason) => ({ id, status, reason });
const lowerOf = (n, pass, kill) => (n >= pass ? 'PASS' : n <= kill ? 'KILL' : 'WATCH');

function gateA(v) {
  const n = v.narrowed.cutB;
  const of = v.narrowed.bs;
  return gate('a', lowerOf(n, GATE_LIMITS.aPass, GATE_LIMITS.aKill), `${n} of ${of} group B Majors end not_reproduced or refuted (PASS >= ${GATE_LIMITS.aPass}, KILL <= ${GATE_LIMITS.aKill})`);
}

function gateB(v, view) {
  const m = v.narrowed.byView[view];
  const n = v.narrowed;
  const fc = n.falseConfirm;
  const tested = `${n.hitsTested} of ${n.hits} hits tested at fix`;
  const text = `${m.hitsLost} of ${n.hits} hits lost, ${fc} false_confirm, ${tested} (PASS 0 and 0 with all tested, KILL >= ${GATE_LIMITS.bLostKill} lost)`;
  if (m.hitsLost >= GATE_LIMITS.bLostKill) return gate('b', 'KILL', text);
  if (n.hitsTested < n.hits) return gate('b', 'NO-DATA', `not evaluable: ${tested}; untested: ${n.hitsUntested.join('; ')}. ${text}`);
  return gate('b', m.hitsLost === 0 && fc === 0 ? 'PASS' : 'WATCH', text);
}

function gateC(v, view) {
  const m = v.narrowed.byView[view];
  const ok = m.precision !== null && m.precision >= GATE_LIMITS.precisionPass;
  return gate('c', ok ? 'PASS' : 'WATCH', `precision with no relabel ${m.keptHits} / (${m.keptHits} + ${m.keptB}) = ${pct(m.precision)}, baseline 3 / 16 = 19% (PASS >= 50%)`);
}

function gateD(v) {
  const n = v.narrowed.blockedUnverified;
  const status = n <= GATE_LIMITS.dPass ? 'PASS' : n > GATE_LIMITS.dKill ? 'KILL' : 'WATCH';
  const extra = `env-down ${v.narrowed.envDown} excluded, not_attempted ${v.narrowed.notAttempted} reported apart`;
  return gate('d', status, `${n} of ${v.narrowed.n} blocked or unverified (${extra}; PASS <= ${GATE_LIMITS.dPass}, KILL > ${GATE_LIMITS.dKill})`);
}

function gateE(v) {
  const a = v.narrowed.agreement;
  return gate('e', a.agreed >= GATE_LIMITS.ePass ? 'PASS' : 'WATCH', `x2 agreement ${a.agreed} of ${a.of} (${a.disagreed} disagreed, ${a.notShown} not shown; PASS >= ${GATE_LIMITS.ePass})`);
}

const prec = (m) => m.precision ?? 0;
const beats = (v, o) => prec(v) > prec(o) && v.hitsLost <= o.hitsLost;
const matches = (r, v) => prec(r) >= prec(v) && r.hitsLost <= v.hitsLost;
const brief = (m) => `${pct(m.precision)}, ${m.hitsLost} hits lost`;

/** Why a control arm cannot be scored, or null. A control is live and attempted every scored pid. */
function controlProblem(name, r) {
  const m = r.meta;
  if (!m.live) return `${name} ${m.why}`;
  if (m.attempted < m.of) return `${name} attempted ${m.attempted} of ${m.of} scored pids (a control must attempt all of them)`;
  return null;
}

function gateF(report, view) {
  const v = report.verify.narrowed.byView[view];
  const rr = report.rerate;
  const rerate = rr?.narrowed.byView[view];
  const rerateProblem = rr ? controlProblem('rerate', rr) : null;
  if (rerate && !rerateProblem && matches(rerate, v)) return gate('f', 'KILL', `rerate matches verify (rerate ${brief(rerate)}; verify ${brief(v)})`);
  const oracles = Object.entries(report).filter(([k]) => k.startsWith('oracle0'));
  const controls = oracles.map(([k, r]) => [k, r.narrowed.byView[view]]);
  const problems = [
    ...(oracles.length ? [] : ['oracle0 missing']), ...(rr ? [] : ['rerate missing']),
    ...oracles.map(([k, r]) => controlProblem(k, r)), rerateProblem,
  ].filter(Boolean);
  if (problems.length) return gate('f', 'NO-DATA', `not evaluable: ${problems.join('; ')}`);
  const all = [...controls, ['rerate', rerate]];
  const attempted = [...oracles, ['rerate', rr]].map(([k, r]) => `${k} ${r.meta.attempted} of ${r.meta.of}`).join(', ');
  const lost = all.filter(([, m]) => !beats(v, m));
  if (lost.length) return gate('f', 'WATCH', `verify (${brief(v)}) does not beat ${lost.map(([k, m]) => `${k} (${brief(m)})`).join(', ')}`);
  return gate('f', 'PASS', `verify (${brief(v)}) beats ${all.map(([k, m]) => `${k} (${brief(m)})`).join(', ')}; controls attempted: ${attempted}`);
}

function overallOf(gates) {
  if (gates.some((g) => g.status === 'KILL')) return 'KILL';
  if (gates.some((g) => g.status === 'NO-DATA')) return 'NO-DATA';
  return gates.every((g) => g.status === 'PASS') ? 'PASS' : 'WATCH';
}

const cutText = (v) => ` [B cut: not_reproduced ${v.narrowed.notReproducedB}, refuted ${v.narrowed.refutedB}]`;

function gatesFor(report, view) {
  const noData = (why) => 'abcdef'.split('').map((id) => gate(id, 'NO-DATA', why));
  if (!report.verify) return noData('no verify arm');
  if (!report.verify.meta.live) return noData(`verify arm ${report.verify.meta.why}`);
  const gates = [gateA(report.verify), gateB(report.verify, view), gateC(report.verify, view), gateD(report.verify), gateE(report.verify), gateF(report, view)];
  return gates.map((g) => ({ ...g, reason: g.reason + cutText(report.verify) }));
}

// ---------- the whole report ----------

/**
 * @param {{ probeSet: object, arms: Record<string, object>, baseDir?: string, readEvidence?: (p: string) => object|null }} input
 */
export function scoreArms({ probeSet, arms, baseDir = DEFAULT_OUT, readEvidence }) {
  const rows = probeSet.rows;
  const narrow = narrowedSet(rows);
  const read = readEvidence ?? ((p) => readEvidenceFile(p, baseDir));
  const all = { baseline: synthesizeBaseline(probeSet), ...Object.fromEntries(Object.entries(arms).map(([k, a]) => [k, { ...a, arm: k }])) };
  const reports = {};
  const warnings = [];
  const scoredPids = [...narrow.a, ...narrow.b].map((r) => r.pid);
  for (const [name, file] of Object.entries(all)) {
    reports[name] = armReport(applyArm(file, rows, name), rows, narrow, read, armMeta(file, scoredPids));
    warnings.push(...reports[name].warnings);
  }
  const gatesByView = Object.fromEntries(VIEWS.map((v) => [v, gatesFor(reports, v)]));
  const viewOverall = Object.fromEntries(VIEWS.map((v) => [v, overallOf(gatesByView[v])]));
  const differing = VIEWS.filter((v) => viewOverall[v] !== viewOverall.majorOpen);
  if (differing.length) warnings.push(`view: the overall differs by scorer (${VIEWS.map((v) => `${v} ${viewOverall[v]}`).join(', ')}); the gates use majorOpen`);
  const sets = { narrowed: { hits: narrow.a.length, bs: narrow.b.length, n: narrow.a.length + narrow.b.length }, original: { n: rows.filter((r) => r.group !== 'C').length } };
  return { schema: 1, sets, arms: reports, gates: gatesByView.majorOpen, overall: viewOverall.majorOpen, viewOverall, gatesByView, modsHost: modsHostShare(rows, narrow), warnings };
}

// ---------- text report ----------

const row = (cells, widths) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();

function armTable(report, key) {
  const w = [12, 8, 6, 10, 9, 12, 8, 8, 4, 10];
  const lines = [row(['arm', 'keptHits', 'keptB', 'precision', 'hitsLost', 'blocked+unv', 'notAtt', 'envDown', 'fc', 'nr/ref'], w)];
  for (const [name, r] of Object.entries(report.arms)) {
    const n = r[key];
    const m = n.byView.majorOpen;
    lines.push(row([name, `${m.keptHits}/${n.hits}`, `${m.keptB}/${n.bs}`, pct(m.precision), m.hitsLost, n.blockedUnverified, n.notAttempted, n.envDown, n.falseConfirm, `${n.notReproducedB}/${n.refutedB}`], w));
  }
  return lines;
}

export function formatReport(report, { out = '' } = {}) {
  const s = report.sets;
  const L = [`TREX verify P1 arm scoring${out ? `  (${out})` : ''}`, `scored set: ${s.narrowed.hits} hits + ${s.narrowed.bs} group B = ${s.narrowed.n} (mods-host and other classify-blocked findings are outside the gate)`, ''];
  L.push('NARROWED SET (nr/ref = group B not_reproduced / refuted, counted apart)', ...armTable(report, 'narrowed'), '');
  L.push('ARM FILES (a gate scores a live file only)');
  for (const [name, r] of Object.entries(report.arms)) L.push(`  ${name.padEnd(10)} ${r.meta.live ? 'live' : `NOT LIVE: ${r.meta.why}`}; attempted ${r.meta.attempted} of ${r.meta.of} scored pids`);
  L.push('');
  L.push('both scorers, narrowed set (keptHits/keptB, precision):');
  for (const [name, r] of Object.entries(report.arms)) {
    L.push(`  ${name.padEnd(10)} ${VIEWS.map((v) => { const m = r.narrowed.byView[v]; return `${v} ${m.keptHits}/${m.keptB} ${pct(m.precision)}`; }).join('   ')}`);
  }
  L.push('', 'GATES (narrowed table; majorOpen scorer)');
  for (const g of report.gates) L.push(`(${g.id}) ${g.status.padEnd(7)} ${g.reason}`);
  L.push(`OVERALL: ${report.overall}   by scorer: ${VIEWS.map((v) => `${v} ${report.viewOverall[v]}`).join(', ')}`, '');
  L.push('ORIGINAL 22 (6 hits + 16 group B; the 6 mods-host findings stay kept and count as blocked)', ...armTable(report, 'original'), '');
  L.push('GROUP C (22 findings, reported, not gated): verdict counts');
  for (const [name, r] of Object.entries(report.arms)) L.push(`  ${name.padEnd(10)} ${Object.entries(r.groupC.verdicts).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  const mh = report.modsHost;
  L.push('', `mods-host blocked share (classify, not a gate): all ${mh.all.blocked} of ${mh.all.of}; hits + group B ${mh.scoredAB.blocked} of ${mh.scoredAB.of}; narrowed ${mh.narrowed.blocked} of ${mh.narrowed.of}`);
  const v = report.arms.verify;
  if (v) {
    const n = v.narrowed;
    L.push(`verify blocked share (blocked+unverified over scored minus env-down): ${n.blockedUnverified} of ${n.n - n.envDown} = ${pct(n.blockedShare)}; breakdown ${JSON.stringify(n.blockedBreakdown)}`);
    const o = v.original;
    L.push(`verify blocked share on the original 22: ${o.blockedUnverified} of ${o.n - o.envDown} = ${pct(o.blockedShare)}`);
  }
  if (report.warnings.length) L.push('', 'WARNINGS', ...report.warnings.map((w) => `  ${w}`));
  return `${L.join('\n')}\n`;
}

// ---------- CLI ----------

const flag = (argv, name, d) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d; };

export async function main(argv, io = { log: (s) => process.stdout.write(`${s}\n`) }) {
  const out = path.resolve(flag(argv, '--out', DEFAULT_OUT));
  const names = flag(argv, '--arms', 'verify,oracle0,rerate').split(',').map((s) => s.trim()).filter(Boolean);
  const arms = {};
  const missing = [];
  let probeSet;
  try {
    probeSet = loadProbeSet(flag(argv, '--probe-set', undefined));
    for (const name of names) {
      const file = path.join(out, name, 'verdicts.json');
      if (!existsSync(file)) { missing.push(name); continue; }
      try {
        arms[name] = loadArm(file);
        validateArm({ ...arms[name], arm: name }, probeSet.rows);
      } catch (e) {
        throw new InputError(`${file}: ${e.message}`);
      }
    }
    const report = scoreArms({ probeSet, arms, baseDir: out });
    if (missing.length) report.warnings.push(`arm file not found, scored as missing: ${missing.join(', ')}`);
    const text = formatReport(report, { out });
    io.log(text.trimEnd());
    if (!argv.includes('--no-write')) {
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, 'score-arms.json'), `${JSON.stringify(report, null, 2)}\n`);
      writeFileSync(path.join(out, 'score-arms.txt'), text);
    }
    return 0;
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    io.log(`score-arms: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
