// Tests for score-arms.mjs. Every case builds synthetic C2 arm files over the REAL probe-set.json (44 pids) and calls the real
// scoreArms / loadArm / main. No model, no container, no network.
// Scored set: group A 3 (S1, S8, S11) + group B 13 (16 B minus the 3 mods-host findings). Group C: 22, reported, not gated.
// A row of a test arm gets the verdict named in `over`; every other row is `not_attempted` (or its classify block).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REFUTED_SEVERITY, applyVerdict } from './verdict.mjs';
import { applyArm } from './apply-verdicts.mjs';
import { defaultBaselineDir } from './probe-set.mjs';
import { isMajorOpen } from '../../github/local-review/record.mjs';
import {
  GATE_LIMITS, loadArm, loadProbeSet, main, narrowedSet, scoreArms, synthesizeBaseline, validateArm, VIEWS,
} from './score-arms.mjs';

const PS = loadProbeSet();
const ROWS = PS.rows;
const NARROW = narrowedSet(ROWS);
const HITS = NARROW.a.map((r) => r.pid);
const BS = NARROW.b.map((r) => r.pid);

const SCORED = [...HITS, ...NARROW.b.map((r) => r.pid)];
const RAN = (v) => !(v === 'not_attempted' || v.startsWith('blocked:'));

/**
 * A C2 arm over all 44 pids. over: { [pid]: verdict | { verdict, ...fields } }. Other rows: classify block or not_attempted.
 * Fix 1/2: a live, complete arm by default (dryRun false, partial false, every scored pid attempted); a hit that ran has falseConfirm false.
 * opts: { live: false } writes dryRun true; { attempted: [pids] } sets attemptedPids; { partial: true }.
 */
function arm(name, over = {}, { recompute = true, live = true, partial = false, attempted = SCORED } = {}) {
  const rows = ROWS.map((r) => {
    const o = typeof over[r.pid] === 'string' ? { verdict: over[r.pid] } : over[r.pid] ?? {};
    const verdict = o.verdict ?? (r.blocked ? `blocked:${r.blocked}` : 'not_attempted');
    const applied = applyVerdict({ id: r.pid, severity: r.severity, confidence: r.confidence }, { verdict, reason: 'test' });
    return {
      pid: r.pid, row: r.row, group: r.group, verdict, reason: o.reason ?? 'test', originalSeverity: r.severity, originalConfidence: r.confidence,
      newSeverity: recompute ? applied.severity : r.severity, newConfidence: recompute ? applied.confidence : r.confidence,
      falseConfirm: r.group === 'A' && RAN(verdict) ? false : null, evidencePath: null, ...o,
    };
  });
  return { arm: name, generatedFrom: 'test', dryRun: !live, partial, attemptedPids: attempted, rows };
}

const cut = (pids, verdict = 'not_reproduced') => Object.fromEntries(pids.map((p) => [p, verdict]));
const keep = (pids, verdict = 'reproduced') => Object.fromEntries(pids.map((p) => [p, verdict]));
const status = (rep, id) => rep.gates.find((g) => g.id === id).status;

/** A verify arm that passes every gate: 3 hits reproduced, 10 of 13 B cut, 3 B reproduced. */
function passingVerify() {
  return arm('verify', { ...keep(HITS), ...cut(BS.slice(0, 5)), ...cut(BS.slice(5, 10), 'refuted'), ...keep(BS.slice(10)) });
}
const score = (arms, opts) => scoreArms({ probeSet: PS, arms, ...opts });

// ---------- the scored set ----------

// Breaks if: the narrowed set is hard-coded or includes a mods-host finding.
test('narrowedSet: 3 hits and 13 group B findings, none blocked by classify', () => {
  assert.equal(NARROW.a.length, 3);
  assert.equal(NARROW.b.length, 13);
  assert.deepEqual(NARROW.a.map((r) => r.row).sort(), ['S1', 'S11', 'S8']);
  assert.ok([...NARROW.a, ...NARROW.b].every((r) => r.blocked === null));
});

// Breaks if: the baseline arm is read from disk or changes a severity.
test('synthesizeBaseline: every pid, classify blocks kept, nothing is cut', () => {
  const b = synthesizeBaseline(PS);
  assert.equal(b.rows.length, 44);
  assert.equal(b.rows.filter((r) => r.verdict === 'blocked:mods-host').length, 8);
  const rep = score({ verify: passingVerify() });
  assert.deepEqual([rep.arms.baseline.narrowed.byView.majorOpen.keptHits, rep.arms.baseline.narrowed.byView.majorOpen.keptB], [3, 13]);
  assert.equal(rep.arms.baseline.narrowed.byView.majorOpen.precision, 3 / 16);
});

// ---------- gates ----------

// Breaks if: any narrowed threshold is wrong (a 8 of 13, b 0 lost, c 50%, d 4, e 15, f beats both).
test('PASS: all six gates pass and the overall is PASS', () => {
  const rerate = arm('rerate', { ...cut(BS.slice(0, 4), 'downgraded') }, { recompute: false });
  rerate.rows.filter((r) => BS.slice(0, 4).includes(r.pid)).forEach((r) => { r.newSeverity = 'minor'; r.newConfidence = 2; });
  const rep = score({ verify: passingVerify(), oracle0: arm('oracle0', keep(HITS)), rerate });
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) assert.equal(status(rep, id), 'PASS', `gate ${id}: ${rep.gates.find((g) => g.id === id).reason}`);
  assert.equal(rep.overall, 'PASS');
  const v = rep.arms.verify.narrowed.byView.majorOpen;
  assert.deepEqual([v.keptHits, v.keptB, v.precision], [3, 3, 0.5]);
});

// Breaks if: KILL (a) is "6 or fewer" (the original column) instead of "5 or fewer", or the boundary is off by one.
test('KILL (a): 5 of 13 group B cut is KILL, 6 and 7 are WATCH, 8 is PASS', () => {
  const at = (n) => score({ verify: arm('verify', { ...keep(HITS), ...cut(BS.slice(0, n)) }) });
  assert.equal(status(at(5), 'a'), 'KILL');
  assert.equal(at(5).overall, 'KILL');
  assert.equal(status(at(6), 'a'), 'WATCH');
  assert.equal(status(at(7), 'a'), 'WATCH');
  assert.equal(status(at(8), 'a'), 'PASS');
});

// Breaks if: KILL on hit loss waits for 2 of 6 (the original column) or counts a blocked hit as lost.
test('KILL (b): 2 of 3 hits lost is KILL, 1 lost is WATCH, a blocked hit is not lost', () => {
  const lose = (n) => score({ verify: arm('verify', { ...keep(HITS.slice(n)), ...cut(HITS.slice(0, n)), ...cut(BS.slice(0, 10)) }) });
  assert.equal(status(lose(2), 'b'), 'KILL');
  assert.equal(lose(2).overall, 'KILL');
  assert.equal(status(lose(1), 'b'), 'WATCH');
  assert.notEqual(lose(1).overall, 'KILL');
  // Fix 2: a blocked hit is not lost, but it was not tested either, so (b) cannot PASS (see the Fix 2 tests).
  const blockedHit = score({ verify: arm('verify', { [HITS[0]]: 'blocked:broken-probe', ...cut(BS.slice(0, 10)) }) });
  assert.notEqual(status(blockedHit, 'b'), 'PASS');
  assert.equal(blockedHit.arms.verify.narrowed.byView.majorOpen.hitsLost, 0);
});

// Breaks if: false_confirm is ignored by gate (b).
test('(b) fails on one false_confirm even with no hit lost, and is not a KILL', () => {
  const v = arm('verify', { ...keep(HITS), ...cut(BS.slice(0, 10)) });
  v.rows.find((r) => r.pid === HITS[0]).falseConfirm = true;
  const rep = score({ verify: v });
  assert.equal(status(rep, 'b'), 'WATCH');
  assert.equal(rep.arms.verify.narrowed.falseConfirm, 1);
  assert.notEqual(rep.overall, 'KILL');
});

// Breaks if: unverified is not counted, not_attempted is counted, or the KILL line is 10 (original) instead of "over 7".
test('KILL (d): blocked plus unverified over 7 is KILL, 5 to 7 is WATCH, 4 is PASS; not_attempted is reported apart', () => {
  const withBlocked = (n) => score({ verify: arm('verify', { ...keep(HITS), ...cut(BS.slice(n)), ...Object.fromEntries(BS.slice(0, n).map((p, i) => [p, i % 2 ? 'unverified' : 'blocked:no-coverage'])) }) });
  assert.equal(status(withBlocked(4), 'd'), 'PASS');
  assert.equal(status(withBlocked(5), 'd'), 'WATCH');
  assert.equal(status(withBlocked(7), 'd'), 'WATCH');
  assert.equal(status(withBlocked(8), 'd'), 'KILL');
  const na = score({ verify: arm('verify', { ...keep(HITS), ...cut(BS.slice(0, 8)), ...Object.fromEntries(BS.slice(8).map((p) => [p, 'not_attempted'])) }) });
  assert.equal(status(na, 'd'), 'PASS');
  assert.equal(na.arms.verify.narrowed.notAttempted, 5);
});

// Breaks if: env-down rows count in the blocked total, or stay in the blocked-share denominator.
test('env-down is excluded from the blocked count and from the blocked-share denominator', () => {
  const over = { ...keep(HITS), ...cut(BS.slice(0, 8)), ...Object.fromEntries(BS.slice(8, 10).map((p) => [p, 'blocked:no-coverage'])), ...Object.fromEntries(BS.slice(10).map((p) => [p, 'env-down'])) };
  const rep = score({ verify: arm('verify', over) });
  const n = rep.arms.verify.narrowed;
  assert.equal(n.blockedUnverified, 2);
  assert.equal(n.envDown, 3);
  assert.equal(n.blockedShare, 2 / 13);
  assert.equal(status(rep, 'd'), 'PASS');
  // The same three rows as blocked would be 5: a WATCH.
  const asBlocked = score({ verify: arm('verify', { ...over, ...Object.fromEntries(BS.slice(10).map((p) => [p, 'blocked:env-build'])) }) });
  assert.equal(status(asBlocked, 'd'), 'WATCH');
});

// Breaks if: "rerate matches verify" is not a KILL, or a rerate that is worse also kills.
test('KILL (f): rerate with the same precision at the same hit loss is KILL', () => {
  const verify = passingVerify();
  const rerate = arm('rerate', {}, { recompute: false });
  for (const r of rerate.rows.filter((x) => BS.slice(0, 10).includes(x.pid))) { r.verdict = 'downgraded'; r.newSeverity = 'minor'; r.newConfidence = 2; }
  const rep = score({ verify, rerate, oracle0: arm('oracle0', keep(HITS)) });
  assert.equal(status(rep, 'f'), 'KILL');
  assert.equal(rep.overall, 'KILL');
  assert.match(rep.gates.find((g) => g.id === 'f').reason, /rerate/);
});

test('(f) rerate that is worse than verify does not kill; rerate that loses fewer hits than verify is a match', () => {
  const rerate = arm('rerate', {}, { recompute: false });
  for (const r of rerate.rows.filter((x) => BS.slice(0, 4).includes(x.pid))) { r.verdict = 'downgraded'; r.newSeverity = 'minor'; r.newConfidence = 2; }
  const worse = score({ verify: passingVerify(), rerate, oracle0: arm('oracle0') });
  assert.equal(status(worse, 'f'), 'PASS');
  // verify loses one hit, rerate loses none and has the same kept-B count: rerate matches at a lower hit loss.
  const lossy = arm('verify', { [HITS[0]]: 'not_reproduced', ...keep(HITS.slice(1)), ...cut(BS.slice(0, 10)) });
  const same = arm('rerate', {}, { recompute: false });
  for (const r of same.rows.filter((x) => BS.slice(0, 10).includes(x.pid))) { r.verdict = 'downgraded'; r.newSeverity = 'minor'; r.newConfidence = 2; }
  assert.equal(status(score({ verify: lossy, rerate: same, oracle0: arm('oracle0') }), 'f'), 'KILL');
});

// Breaks if: oracle0 equal to baseline still lets verify "beat" it, or the hit-loss clause is dropped.
test('(f) verify that loses a hit does not beat oracle0 (0 hits lost); oracle0 is a keep-only control at 3/16', () => {
  const lossy = arm('verify', { [HITS[0]]: 'not_reproduced', ...keep(HITS.slice(1)), ...cut(BS.slice(0, 11)) });
  const rep = score({ verify: lossy, oracle0: arm('oracle0', keep(HITS)), rerate: arm('rerate') });
  assert.equal(status(rep, 'f'), 'WATCH');
  assert.equal(rep.arms.oracle0.narrowed.byView.majorOpen.precision, 3 / 16);
});

// Breaks if: a missing arm is read as zero or crashes, or a missing arm lets the overall reach PASS.
test('a missing rerate or oracle0 makes (f) NO-DATA and the overall NO-DATA; a missing verify gives NO-DATA', () => {
  const rep = score({ verify: passingVerify() });
  assert.equal(status(rep, 'f'), 'NO-DATA');
  assert.equal(rep.overall, 'NO-DATA');
  assert.match(rep.gates.find((g) => g.id === 'f').reason, /rerate.*missing|missing.*rerate/);
  const none = score({});
  assert.equal(none.overall, 'NO-DATA');
  assert.ok(none.gates.every((g) => g.status === 'NO-DATA'));
});

// ---------- Fix 1: gate (f) needs a live, complete control ----------

const critic = () => ({ verify: passingVerify() });
const fReason = (rep) => rep.gates.find((g) => g.id === 'f').reason;
const cutRerate = (n, opts) => {
  const rr = arm('rerate', {}, { recompute: false, ...opts });
  for (const r of rr.rows.filter((x) => BS.slice(0, n).includes(x.pid))) { r.verdict = 'rerate_down'; r.newSeverity = 'minor'; r.newConfidence = 2; }
  return rr;
};

// Breaks if: a rerate dry run (every scored pid not_attempted, dryRun true) is scored as a real control. This is the critic's exact case.
test('Fix 1: a dry-run rerate file never makes (f) PASS or KILL; (f) is NO-DATA and the overall is not PASS', () => {
  const dry = arm('rerate', {}, { recompute: false, live: false, attempted: [] });
  const rep = score({ ...critic(), oracle0: arm('oracle0', keep(HITS)), rerate: dry });
  assert.equal(status(rep, 'f'), 'NO-DATA');
  assert.match(fReason(rep), /rerate.*(dry run|dryRun)/i);
  assert.notEqual(rep.overall, 'PASS');
  assert.equal(rep.overall, 'NO-DATA');
});

// Breaks if: a file with no dryRun marker (the old rerate file on disk) counts as live. Absence of the marker means "not live".
test('Fix 1: a control file with no dryRun marker is not live', () => {
  const old = cutRerate(4);
  delete old.dryRun;
  delete old.attemptedPids;
  const rep = score({ ...critic(), oracle0: arm('oracle0', keep(HITS)), rerate: old });
  assert.equal(status(rep, 'f'), 'NO-DATA');
  assert.match(fReason(rep), /rerate/);
});

// Breaks if: (f) is evaluated when the control did not attempt every scored pid it could (one retry left a pid not_attempted).
test('Fix 1: a live control that attempted 15 of the 16 scored pids gives (f) NO-DATA and says 15 of 16', () => {
  const rep = score({ ...critic(), oracle0: arm('oracle0', keep(HITS)), rerate: cutRerate(4, { attempted: SCORED.slice(0, 15) }) });
  assert.equal(status(rep, 'f'), 'NO-DATA');
  assert.match(fReason(rep), /15 of 16/);
  assert.equal(rep.arms.rerate.meta.attempted, 15);
});

// Breaks if: a partial control file counts as live.
test('Fix 1: a partial control file gives (f) NO-DATA', () => {
  const rep = score({ ...critic(), oracle0: arm('oracle0', keep(HITS), { partial: true }), rerate: cutRerate(4) });
  assert.equal(status(rep, 'f'), 'NO-DATA');
  assert.match(fReason(rep), /oracle0.*partial|partial.*oracle0/i);
});

// Breaks if: "rerate matches verify" KILLs on a rerate that is not live (a dry rerate can look like the baseline or like anything).
test('Fix 1: KILL (f) needs a live rerate; a dry rerate that would match verify is NO-DATA, not KILL', () => {
  const dry = cutRerate(10, { live: false, attempted: [] });
  const rep = score({ ...critic(), oracle0: arm('oracle0', keep(HITS)), rerate: dry });
  assert.equal(status(rep, 'f'), 'NO-DATA');
  assert.notEqual(rep.overall, 'KILL');
});

// Breaks if: the fix also blocks a good live control (positive control).
test('Fix 1: a live, complete rerate and oracle0 still give (f) PASS when verify beats both', () => {
  const rep = score({ ...critic(), oracle0: arm('oracle0', keep(HITS)), rerate: cutRerate(4) });
  assert.equal(status(rep, 'f'), 'PASS');
  assert.match(fReason(rep), /16 of 16/);
});

// Breaks if: a dry or partial VERIFY file is scored (a --only run is all not_attempted and would read as KILL on (a)).
test('Fix 1: a partial or dry verify arm gives NO-DATA on every gate', () => {
  for (const o of [{ partial: true }, { live: false }]) {
    const rep = score({ verify: arm('verify', { ...keep(HITS), ...cut(BS.slice(0, 10)) }, o), oracle0: arm('oracle0'), rerate: cutRerate(4) });
    assert.ok(rep.gates.every((g) => g.status === 'NO-DATA'), JSON.stringify(o));
    assert.equal(rep.overall, 'NO-DATA');
  }
});

// ---------- Fix 2: gate (b) needs all 3 hits tested at fix ----------

const hitFile = (o = {}) => arm('verify', { ...keep(HITS), ...cut(BS.slice(0, 10)), ...o });
const bReason = (rep) => rep.gates.find((g) => g.id === 'b').reason;

// Breaks if: a null falseConfirm (no fix run) counts as 0 false_confirm. This is the critic's exact case: 0 of 3 hits tested gave PASS.
test('Fix 2: falseConfirm null on all 3 hits gives (b) NO-DATA, never PASS, and says 0 of 3', () => {
  const v = hitFile();
  for (const r of v.rows) if (HITS.includes(r.pid)) r.falseConfirm = null;
  const rep = score({ verify: v, oracle0: arm('oracle0', keep(HITS)), rerate: cutRerate(4) });
  assert.equal(status(rep, 'b'), 'NO-DATA');
  assert.match(bReason(rep), /0 of 3/);
  assert.notEqual(rep.overall, 'PASS');
});

// Breaks if: one untested hit still lets (b) PASS.
test('Fix 2: 2 hits tested at fix and 1 not gives (b) NO-DATA and names the missing hit', () => {
  const v = hitFile();
  v.rows.find((r) => r.pid === HITS[1]).falseConfirm = null;
  const rep = score({ verify: v });
  assert.equal(status(rep, 'b'), 'NO-DATA');
  assert.match(bReason(rep), /2 of 3/);
  assert.ok(bReason(rep).includes(HITS[1]));
});

// Breaks if: a hit that ended blocked or not_attempted counts as tested (falseConfirm is false on it, a stale value).
test('Fix 2: a hit that ended blocked or not_attempted is not tested, even with falseConfirm false', () => {
  for (const verdict of ['blocked:no-coverage', 'blocked:broken-probe', 'not_attempted']) {
    const v = hitFile({ [HITS[0]]: { verdict, falseConfirm: false } });
    const rep = score({ verify: v });
    assert.equal(status(rep, 'b'), 'NO-DATA', verdict);
    assert.match(bReason(rep), /2 of 3/, verdict);
  }
});

// Breaks if: the fix removes the PASS path (positive control), or counts unverified as untested.
test('Fix 2: all 3 hits tested and kept, 0 false_confirm: (b) PASS and says 3 of 3', () => {
  const rep = score({ verify: hitFile() });
  assert.equal(status(rep, 'b'), 'PASS');
  assert.match(bReason(rep), /3 of 3/);
});

// Breaks if: lost hits (real evidence) are hidden behind NO-DATA, so a KILL is never raised.
test('Fix 2: 2 hits lost is still KILL when the third was not tested', () => {
  const v = arm('verify', { [HITS[0]]: 'not_reproduced', [HITS[1]]: 'not_reproduced', [HITS[2]]: 'blocked:no-coverage', ...cut(BS.slice(0, 10)) });
  const rep = score({ verify: v });
  assert.equal(status(rep, 'b'), 'KILL');
});

// Breaks if: a false_confirm on a tested hit stops being WATCH.
test('Fix 2: a false_confirm on a tested hit is WATCH', () => {
  const v = hitFile({ [HITS[0]]: { verdict: 'reproduced', falseConfirm: true } });
  assert.equal(status(score({ verify: v }), 'b'), 'WATCH');
});

// ---------- Fix 4: refuted counted apart in every gate line ----------

// Breaks if: refuted and not_reproduced are summed in a gate line (a bad probe that fires on both sides reads as a win in (a) and (c)).
test('Fix 4: every gate line reports not_reproduced and refuted counts apart', () => {
  const rep = score({ verify: arm('verify', { ...keep(HITS), ...cut(BS.slice(0, 5)), ...cut(BS.slice(5, 9), 'refuted'), ...keep(BS.slice(9)) }), oracle0: arm('oracle0', keep(HITS)), rerate: cutRerate(4) });
  for (const g of rep.gates) assert.match(g.reason, /not_reproduced 5, refuted 4/, `gate ${g.id}: ${g.reason}`);
  const n = rep.arms.verify.narrowed;
  assert.deepEqual([n.cutB, n.notReproducedB, n.refutedB], [9, 5, 4]);
});

// ---------- applying an arm ----------

// Breaks if: a C2 file that omits a pid, repeats one, or names an unknown one is scored anyway.
test('validateArm rejects a missing pid, a duplicate pid, an unknown pid and a bad verdict', () => {
  const a = arm('verify');
  assert.doesNotThrow(() => validateArm(a, ROWS));
  assert.throws(() => validateArm({ ...a, rows: a.rows.slice(1) }, ROWS), /missing.*43|43.*missing|missing pid/i);
  assert.throws(() => validateArm({ ...a, rows: [...a.rows, a.rows[0]] }, ROWS), /duplicate/i);
  assert.throws(() => validateArm({ ...a, rows: [{ ...a.rows[0], pid: 'zzzz' }, ...a.rows.slice(1)] }, ROWS), /unknown pid|missing/i);
  assert.throws(() => validateArm({ ...a, rows: [{ ...a.rows[0], verdict: 'maybe' }, ...a.rows.slice(1)] }, ROWS), /verdict/i);
  assert.throws(() => validateArm({ arm: 'verify', rows: 'x' }, ROWS), /rows/);
});

// Breaks if: the verify arm trusts the file's newSeverity instead of the verdict rule (a lie in the file would raise precision).
test('verify arm: severity comes from the verdict, and a newSeverity that disagrees is a drift warning', () => {
  const v = arm('verify', { ...keep(HITS), [BS[0]]: { verdict: 'not_attempted', newSeverity: 'minor', newConfidence: 2 } });
  const rep = score({ verify: v });
  assert.equal(rep.arms.verify.narrowed.byView.majorOpen.keptB, 13);
  assert.ok(rep.arms.verify.warnings.some((w) => w.includes(BS[0]) && /drift/i.test(w)));
});

// Breaks if: the verify arm's own severity changes are not applied (a refuted row must leave both views).
test('verify arm: refuted becomes trivial and not_reproduced becomes minor in every view', () => {
  const rep = score({ verify: arm('verify', { ...keep(HITS), [BS[0]]: 'refuted', [BS[1]]: 'not_reproduced' }) });
  for (const view of VIEWS) assert.equal(rep.arms.verify.narrowed.byView[view].keptB, 11, view);
  assert.equal(REFUTED_SEVERITY, 'trivial');
});

// Breaks if: rerate is run through the verify rule (not_reproduced -> minor) instead of its own one-level newSeverity.
test('rerate arm: newSeverity and newConfidence from the file are used, not the verify rule', () => {
  const rr = arm('rerate', {}, { recompute: false });
  const crit = rr.rows.find((r) => r.pid === BS[0]);
  crit.newSeverity = 'major'; crit.newConfidence = crit.originalConfidence; crit.verdict = 'downgraded';
  const low = rr.rows.find((r) => r.pid === BS[1]);
  low.newSeverity = 'minor'; low.newConfidence = 2; low.verdict = 'downgraded';
  const rep = score({ verify: passingVerify(), rerate: rr });
  assert.equal(rep.arms.rerate.narrowed.byView.majorOpen.keptB, 12);
});

// Breaks if: an arm can raise a severity above the baseline and be scored as if it had not.
test('an arm that raises severity is rejected', () => {
  const rr = arm('rerate', {}, { recompute: false });
  rr.rows.find((r) => r.pid === BS[0]).newSeverity = 'critical';
  assert.throws(() => score({ rerate: rr }), /raise|above/i);
});

// Breaks if: both scorers always agree because only one view is computed.
test('views: a confidence-only cut leaves the severity-only view and removes the isMajorOpen view', () => {
  const rr = arm('rerate', {}, { recompute: false });
  const r0 = rr.rows.find((r) => r.pid === BS[0]);
  r0.verdict = 'downgraded'; r0.newSeverity = 'major'; r0.newConfidence = 2;
  const rep = score({ verify: passingVerify(), rerate: rr });
  const v = rep.arms.rerate.narrowed.byView;
  assert.equal(v.majorOpen.keptB, 12);
  assert.equal(v.severityOnly.keptB, 13);
  assert.equal(v.optionF.keptB, 12);
});

// ---------- agreement ----------

// Breaks if: disagreement is not read from blocked:disagree or evidence, or an arm with no evidence can score 16 of 16 shown.
test('x2 agreement: evidence file with two head runs, blocked:disagree, and a verdict that needs agreement', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'score-arms-ev-'));
  try {
    const ev = (name, head) => { const f = path.join(dir, name); writeFileSync(f, JSON.stringify({ head })); return f; };
    const agree = ev('agree.json', [{ exitClass: 'assert-fail', normalizedOutput: 'x' }, { exitClass: 'assert-fail', normalizedOutput: 'x' }]);
    const differ = ev('differ.json', [{ exitClass: 'assert-fail', normalizedOutput: 'x' }, { exitClass: 'pass', normalizedOutput: '' }]);
    const one = ev('one.json', [{ exitClass: 'pass' }]);
    const v = arm('verify', {
      [HITS[0]]: { verdict: 'reproduced', evidencePath: agree },
      [HITS[1]]: { verdict: 'reproduced', evidencePath: differ },
      [HITS[2]]: { verdict: 'reproduced', evidencePath: one },
      [BS[0]]: 'blocked:disagree',
      [BS[1]]: 'not_reproduced',
      [BS[2]]: 'not_attempted',
    });
    const a = score({ verify: v }).arms.verify.narrowed.agreement;
    assert.deepEqual(a, { agreed: 2, disagreed: 2, notShown: 12, of: 16 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Breaks if: gate (e) passes when 2 rows disagree, or fails with 1.
test('gate (e): 15 of 16 agreeing passes, 14 fails', () => {
  const noShown = (nDisagree) => score({ verify: arm('verify', { ...keep(HITS), ...cut(BS.slice(0, 10)), ...keep(BS.slice(10)), ...Object.fromEntries(BS.slice(0, nDisagree).map((p) => [p, 'blocked:disagree'])) }) });
  assert.equal(status(noShown(1), 'e'), 'PASS');
  assert.equal(status(noShown(2), 'e'), 'WATCH');
});

// ---------- reports beside the gates ----------

// Breaks if: group C is gated, or its counts are missing, or the mods-host share is computed from the scored set only.
test('group C verdict counts and the mods-host blocked share', () => {
  const v = arm('verify', { ...keep(HITS), ...cut(BS.slice(0, 10)), ...keep(BS.slice(10)), ...keep(ROWS.filter((r) => r.group === 'C' && !r.blocked).slice(0, 5).map((r) => r.pid)) });
  const rep = score({ verify: v });
  assert.equal(rep.arms.verify.groupC.n, 22);
  assert.equal(rep.arms.verify.groupC.verdicts.reproduced, 5);
  assert.equal(rep.arms.verify.groupC.verdicts['blocked:mods-host'], 2);
  assert.deepEqual(rep.modsHost, { all: { blocked: 8, of: 44 }, scoredAB: { blocked: 6, of: 22 }, narrowed: { blocked: 0, of: 16 } });
});

// Breaks if: the original 22-finding numbers are missing or use the narrowed gate counts.
test('original 22: 6 hits and 16 group B, mods-host findings counted as kept and blocked', () => {
  const rep = score({ verify: passingVerify() });
  const o = rep.arms.verify.original;
  assert.deepEqual([o.n, o.hits, o.bs], [22, 6, 16]);
  const m = o.byView.majorOpen;
  assert.deepEqual([m.keptHits, m.keptB], [6, 6]);
  assert.equal(m.precision, 0.5);
  assert.equal(o.blockedUnverified, 6);
  assert.equal(rep.arms.baseline.original.byView.majorOpen.precision, 6 / 22);
});

// Breaks if: a view that flips the verdict is silent.
test('viewOverall lists the verdict of each scorer and warns when they differ', () => {
  const v = arm('verify', { ...keep(HITS), ...cut(BS.slice(0, 10)), ...keep(BS.slice(10)) }, { recompute: false });
  for (const r of v.rows.filter((x) => BS.slice(0, 10).includes(x.pid))) { r.verdict = 'not_reproduced'; r.newSeverity = 'major'; r.newConfidence = 2; }
  // The file lies (confidence only). The verify rule recomputes minor/2, so all views agree and a drift warning is raised.
  const rep = score({ verify: v, oracle0: arm('oracle0'), rerate: arm('rerate') });
  assert.deepEqual(Object.keys(rep.viewOverall).sort(), [...VIEWS].sort());
  assert.equal(rep.overall, 'PASS');
  const rr = arm('rerate', {}, { recompute: false });
  for (const r of rr.rows.filter((x) => BS.slice(0, 13).includes(x.pid))) { r.verdict = 'downgraded'; r.newSeverity = 'major'; r.newConfidence = 2; }
  const rep2 = score({ verify: arm('verify', { ...keep(HITS), ...cut(BS.slice(0, 7)), ...keep(BS.slice(7)) }), rerate: rr, oracle0: arm('oracle0') });
  assert.notEqual(rep2.viewOverall.severityOnly, rep2.viewOverall.majorOpen);
  assert.ok(rep2.warnings.some((w) => /view/i.test(w)));
});

test('GATE_LIMITS holds the narrowed table', () => {
  assert.deepEqual(GATE_LIMITS, { aPass: 8, aKill: 5, bLostPass: 0, bLostKill: 2, precisionPass: 0.5, dPass: 4, dKill: 7, ePass: 15 });
});

// ---------- CLI ----------

function writeArms(dir, arms) {
  for (const [name, file] of Object.entries(arms)) {
    mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, name, 'verdicts.json'), JSON.stringify(file));
  }
}

// Breaks if: main cannot read <out>/<arm>/verdicts.json, prints no per-gate line, or writes nothing.
test('main: reads <out>/<arm>/verdicts.json, prints a line per gate and the overall, writes score-arms.json', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'score-arms-main-'));
  try {
    writeArms(dir, { verify: passingVerify(), oracle0: arm('oracle0', keep(HITS)), rerate: arm('rerate') });
    const lines = [];
    const code = await main(['--out', dir], { log: (s) => lines.push(s) });
    const text = lines.join('\n');
    assert.equal(code, 0);
    for (const id of ['(a)', '(b)', '(c)', '(d)', '(e)', '(f)']) assert.match(text, new RegExp(`\\${id[0]}${id[1]}\\) +PASS`));
    assert.match(text, /OVERALL: PASS/);
    assert.ok(existsSync(path.join(dir, 'score-arms.json')));
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'score-arms.json'), 'utf8')).overall, 'PASS');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Breaks if: a malformed arm file is scored, or exits 0.
test('main: a C2 file with a missing pid exits 2 and names the file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'score-arms-bad-'));
  try {
    const bad = passingVerify();
    bad.rows.pop();
    writeArms(dir, { verify: bad });
    const lines = [];
    assert.equal(await main(['--out', dir], { log: (s) => lines.push(s) }), 2);
    assert.match(lines.join('\n'), /verify[\\/]verdicts\.json/);
    assert.throws(() => loadArm(path.join(dir, 'nope.json')), /nope\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Breaks if: the evidence FOLDER verify.mjs writes (runs.json with side/label/exitClass/failLine) is not read, or the G9 revert run
// (side head, with a note) is counted as a head run and reads as a disagreement.
test('x2 agreement: reads a verify.mjs evidence folder and ignores the G9 revert run', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'score-arms-evdir-'));
  try {
    const mk = (name, runs) => { mkdirSync(path.join(dir, name), { recursive: true }); writeFileSync(path.join(dir, name, 'runs.json'), JSON.stringify(runs)); return path.join(dir, name); };
    const run = (label, side, exitClass, failLine, extra = {}) => ({ label, side, exitClass, failLine, ...extra });
    const same = mk('same', [run('h1', 'head', 'assert-fail', 'x: boom'), run('h2', 'head', 'assert-fail', 'x: boom'), run('b1', 'base', 'pass', null), run('g9', 'head', 'pass', null, { note: 'cited file at base content' })]);
    const differ = mk('differ', [run('h1', 'head', 'assert-fail', 'x: boom'), run('h2', 'head', 'assert-fail', 'y: other')]);
    const v = arm('verify', { [HITS[0]]: { verdict: 'reproduced', evidencePath: same }, [HITS[1]]: { verdict: 'reproduced', evidencePath: differ } });
    const a = score({ verify: v }).arms.verify.narrowed.agreement;
    assert.equal(a.agreed, 1 + 0);
    assert.equal(a.disagreed, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- scoring from the record copies (design section 6) ----------

// Critic minor: design section 6 scores the apply-verdicts record copies; score-arms scores probe-set rows. They must give the same numbers.
// Breaks if: the two paths lower a finding differently (verdict rule vs the file's newSeverity), so the gate numbers depend on which path is read.
test('score-arms numbers equal the numbers counted from the apply-verdicts record copies (verify and rerate, real baseline)', { skip: !existsSync(path.join(defaultBaselineDir(), 'results.json')) && 'baseline records not in this clone' }, () => {
  const rerate = arm('rerate', {}, { recompute: false });
  for (const r of rerate.rows.filter((x) => BS.slice(0, 4).includes(x.pid))) { r.verdict = 'rerate_down'; r.newSeverity = 'minor'; r.newConfidence = 2; }
  const verify = arm('verify', { ...keep(HITS), ...cut(BS.slice(0, 5)), ...cut(BS.slice(5, 9), 'refuted'), ...keep(BS.slice(9)) });
  const rep = score({ verify, rerate });
  for (const file of [verify, rerate]) {
    const out = mkdtempSync(path.join(os.tmpdir(), 'score-arms-copies-'));
    try {
      applyArm({ c2: file, baselineDir: defaultBaselineDir(), outDir: out });
      const found = new Map();
      for (const r of ROWS.filter((x) => x.group !== 'C' && !x.blocked)) {
        const rec = JSON.parse(readFileSync(path.join(out, file.arm, 'records', r.row, 'record.json'), 'utf8'));
        const f = rec.findings.find((x) => x.id === r.pid);
        assert.ok(f, `${r.pid} is in the copy of ${r.row}`);
        found.set(r.pid, f);
      }
      const kept = (pids) => pids.filter((p) => isMajorOpen(found.get(p))).length;
      const m = rep.arms[file.arm].narrowed.byView.majorOpen;
      assert.deepEqual([kept(HITS), kept(BS)], [m.keptHits, m.keptB], `${file.arm}: record copies and probe-set rows give the same kept counts`);
    } finally { rmSync(out, { recursive: true, force: true }); }
  }
});
