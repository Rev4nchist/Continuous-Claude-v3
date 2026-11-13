// Cursor budget (P0 spec, main spec 13.4): the eval and the shadow replays may not eat the live review capacity.
// Eval: refuse when the start rows (all time) of the job's eval scope reach its cap (evalScopes, else cursorEvalBudget),
// or the global 7-day count reaches WEEKLY_CAP - cursorHeadroom (240). Shadow: dailyMax runs per Chicago day, and the same global headroom.
import { WEEKLY_CAP, countRuns, readLedger } from '../../github/cursor-review.mjs';
import { chicagoDay } from '../../lib/headless.mjs';

export const EVAL_SESSION = 'review-eval';
export const SHADOW_SESSION = 'review-shadow';

// keep(e) narrows the rows further (the shadow day filter). A row with no id counts on its own.
const starts = (entries, session, keep = () => true) => {
  const ids = new Set();
  let anon = 0;
  for (const e of entries) {
    if (e.phase !== 'start' || e.sessionId !== session || !keep(e)) continue;
    ids.add(e.id ?? `anon-${anon++}`);
  }
  return ids;
};

// An unreadable time counts as today, the same safe-side rule as countRuns.
const onDay = (day) => (e) => {
  const t = Date.parse(e.ts);
  return Number.isNaN(t) || chicagoDay(t) === day;
};

// ---------- per-phase eval scopes (map C1) ----------
// The scope rides in the ledger sessionId: `review-eval` is P1 (the untagged rows), `review-eval-P4` is P4. A hyphen, not a
// colon: the value reaches child processes as CLAUDE_CODE_SESSION_ID, and a colon is not valid in a Windows file name.
export const EVAL_SCOPES = Object.freeze(['P1', 'P4', 'P6']);
const SESSION_OF_SCOPE = Object.freeze(Object.fromEntries(EVAL_SCOPES.map((s) => [s, s === 'P1' ? EVAL_SESSION : `${EVAL_SESSION}-${s}`])));
const SCOPE_OF_SESSION = Object.freeze(Object.fromEntries(Object.entries(SESSION_OF_SCOPE).map(([s, id]) => [id, s])));

/** The ledger sessionId of an eval scope. An unknown scope throws. */
export function evalSessionFor(scope) {
  if (!Object.hasOwn(SESSION_OF_SCOPE, scope)) throw new Error(`unknown eval scope ${JSON.stringify(scope)}: use ${EVAL_SCOPES.join(', ')}`);
  return SESSION_OF_SCOPE[scope];
}

/** The eval scope of a ledger sessionId, or null (live, shadow, label and unknown ids). Exact match only. */
export const scopeOf = (sessionId) => (typeof sessionId === 'string' && Object.hasOwn(SCOPE_OF_SESSION, sessionId) ? SCOPE_OF_SESSION[sessionId] : null);

/** { P1: {used, cap, free}, ... }. Cap: cfg.evalScopes[scope], else cfg.cursorEvalBudget. */
function scopeTable(entries, cfg) {
  return Object.fromEntries(EVAL_SCOPES.map((s) => {
    const used = starts(entries, SESSION_OF_SCOPE[s]).size;
    const cap = cfg.evalScopes?.[s] ?? cfg.cursorEvalBudget;
    return [s, { used, cap, free: Math.max(0, cap - used) }];
  }));
}

/**
 * { ok, evalUsed (all scopes), scopes, scope, globalUsed, shadowUsedToday, reason?: 'eval-budget' | 'unknown-scope' | 'headroom' | 'shadow-daily' }.
 * need: how many runs this job may reserve (an engine run reserves 1 + retry_max). scope: the eval scope of the job (default P1).
 * The eval check refuses when the used count of that scope + need passes its cap.
 */
export function cursorBudget(entries, cfg, { now = Date.now(), kind = 'eval', need = 1, scope = 'P1' } = {}) {
  const scopes = scopeTable(entries, cfg);
  const evalUsed = EVAL_SCOPES.reduce((n, s) => n + scopes[s].used, 0);
  const globalUsed = countRuns(entries, { now });
  const shadowUsedToday = starts(entries, SHADOW_SESSION, onDay(chicagoDay(now))).size;
  const out = { ok: true, evalUsed, scopes, scope, globalUsed, shadowUsedToday };
  const headroomCap = WEEKLY_CAP - (cfg.cursorHeadroom ?? 60);
  if (kind === 'eval' && !Object.hasOwn(scopes, scope)) return { ...out, ok: false, reason: 'unknown-scope' };
  if (kind === 'eval' && scopes[scope].used + need > scopes[scope].cap) return { ...out, ok: false, reason: 'eval-budget' };
  if (kind === 'shadow' && shadowUsedToday >= (cfg.shadow?.dailyMax ?? 6)) return { ...out, ok: false, reason: 'shadow-daily' };
  if (globalUsed >= headroomCap) return { ...out, ok: false, reason: 'headroom' };
  return out;
}

// ---------- phase 4 need and the cut (map T04, DP1.16) ----------
// need = ceil(sum over strata of count x arms x runs / successRate). The cut fills the free P4 calls in this order:
// controls (controlsMin, the decided floor), every holdout PR, dev PRs, then gold targets. It decides nothing: Dave chooses
// what gives way (decisions.md "Open after DP1"). Four cases: holdout 1 or 2 runs per arm, winner evidence with or without the divisor.

const callsOf = (n, arms, runs) => n * arms * runs;

function cutCase({ counts, p4, p4Free, holdoutRuns, winnerDivisor }) {
  const { arms, successRate: sr, runs, controlsMin, reserved } = p4;
  const winnerStarts = winnerDivisor ? Math.ceil(reserved.winnerEvidence / sr) : reserved.winnerEvidence;
  const freeStarts = p4Free - reserved.verifierReplay - winnerStarts;
  // No clamp: a negative value shows the real shortfall. p4Free already leaves out P4 starts spent so far; the report says the
  // reserved starts are taken whole (it assumes verifier replay and winner evidence have spent none yet).
  const freeCalls = Math.floor(freeStarts * sr);
  const controlsCalls = callsOf(controlsMin, arms, runs.controls);
  const holdoutCalls = callsOf(counts.holdout, arms, holdoutRuns);
  const left = freeCalls - controlsCalls - holdoutCalls;
  const base = { holdoutRuns, winnerDivisor, winnerStarts, freeStarts, freeCalls, controls: controlsMin, controlsCalls, holdoutCalls, left };
  if (left < 0) return { ...base, fits: false, shortfall: -left, devTargets: 0, devCalls: 0, goldTargets: 0, goldCalls: 0, p4abStarts: null };
  const devTargets = Math.min(counts.dev, Math.floor(left / (arms * runs.dev)));
  const devCalls = callsOf(devTargets, arms, runs.dev);
  const goldTargets = Math.min(counts.gold, Math.floor((left - devCalls) / (arms * runs.gold)));
  const goldCalls = callsOf(goldTargets, arms, runs.gold);
  const p4abStarts = Math.ceil((controlsCalls + holdoutCalls + devCalls + goldCalls) / sr);
  return { ...base, fits: true, shortfall: 0, devTargets, devCalls, goldTargets, goldCalls, p4abStarts, sum: p4abStarts + reserved.verifierReplay + winnerStarts };
}

/**
 * counts: { controls, holdout, dev, gold } (counts only). p4: config.json p4. p4Free: free starts of the P4 scope.
 * A control count under controlsMin plans with controlsMin (controlsPlanned true).
 * @returns {{ inputs, need, fits, cases }} fits: the full design fits in p4Free beside the reserved starts.
 */
export function p4Plan({ counts, p4, p4Free }) {
  const controlsPlanned = counts.controls < p4.controlsMin;
  const inputs = { ...counts, controls: controlsPlanned ? p4.controlsMin : counts.controls, controlsInFile: counts.controls, controlsPlanned };
  const r = p4.runs;
  const calls = callsOf(inputs.controls, p4.arms, r.controls) + callsOf(inputs.holdout, p4.arms, r.holdout) + callsOf(inputs.dev, p4.arms, r.dev) + callsOf(inputs.gold, p4.arms, r.gold);
  const need = Math.ceil(calls / p4.successRate);
  const fits = need + p4.reserved.verifierReplay + p4.reserved.winnerEvidence <= p4Free;
  const cases = [1, 2].flatMap((holdoutRuns) => [false, true].map((winnerDivisor) => cutCase({ counts: inputs, p4, p4Free, holdoutRuns, winnerDivisor })));
  return { inputs, need, fits, cases };
}

/** cursorBudget over a ledger file. A missing file is empty; a damaged line is skipped by the shared reader. */
export function budgetFromFile(file, cfg, opts = {}) {
  return cursorBudget(readLedger(file).entries, cfg, opts);
}
