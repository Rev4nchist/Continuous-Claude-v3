// Cursor budget (P0 spec, main spec 13.4): the eval and the shadow replays may not eat the live review capacity.
// Eval: refuse when the `review-eval` start rows (all time) reach cursorEvalBudget, or the global 7-day count reaches
// WEEKLY_CAP - cursorHeadroom (240). Shadow: dailyMax runs per Chicago day, and the same global headroom.
import { WEEKLY_CAP, countRuns, readLedger } from '../../github/cursor-review.mjs';
import { chicagoDay } from '../../lib/headless.mjs';

export const EVAL_SESSION = 'review-eval';
export const SHADOW_SESSION = 'review-shadow';

const starts = (entries, session) => {
  const ids = new Set();
  let anon = 0;
  for (const e of entries) {
    if (e.phase !== 'start' || e.sessionId !== session) continue;
    ids.add(e.id ?? `anon-${anon++}`);
  }
  return ids;
};

/** { ok, evalUsed, globalUsed, shadowUsedToday, reason?: 'eval-budget' | 'headroom' | 'shadow-daily' }. */
export function cursorBudget(entries, cfg, { now = Date.now(), kind = 'eval' } = {}) {
  const evalUsed = starts(entries, EVAL_SESSION).size;
  const globalUsed = countRuns(entries, { now });
  const today = chicagoDay(now);
  const shadowToday = entries.filter((e) => e.phase === 'start' && e.sessionId === SHADOW_SESSION && chicagoDay(Date.parse(e.ts)) === today);
  const shadowUsedToday = new Set(shadowToday.map((e) => e.id)).size;
  const out = { ok: true, evalUsed, globalUsed, shadowUsedToday };
  const headroomCap = WEEKLY_CAP - (cfg.cursorHeadroom ?? 60);
  if (kind === 'eval' && evalUsed >= cfg.cursorEvalBudget) return { ...out, ok: false, reason: 'eval-budget' };
  if (kind === 'shadow' && shadowUsedToday >= (cfg.shadow?.dailyMax ?? 6)) return { ...out, ok: false, reason: 'shadow-daily' };
  if (globalUsed >= headroomCap) return { ...out, ok: false, reason: 'headroom' };
  return out;
}

/** cursorBudget over a ledger file. A missing file is empty; a damaged line is skipped by the shared reader. */
export function budgetFromFile(file, cfg, opts = {}) {
  return cursorBudget(readLedger(file).entries, cfg, opts);
}
