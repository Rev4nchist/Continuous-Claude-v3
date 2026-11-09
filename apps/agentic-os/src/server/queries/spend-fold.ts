/**
 * The fold behind the Fleet Overview cost tiles: parsed state snapshots in, tile numbers out.
 *
 * Pure on purpose: type-only imports and no `server-only`, so the hooks vitest
 * (.claude/hooks/src/__tests__/spend-fold.test.ts) can load it by file URL, where the Next alias
 * does not resolve. Do not add a runtime import here.
 *
 * The caller passes the LIVE session ids. A state file has no live flag, and the directory also
 * holds ended, quiet and stale files: folding all of them would inflate every total.
 */
import type { StateSnapshot } from '@/server/sources/state-files';

/** Dave 11-09: amber "at or over". */
export const QUOTA_AMBER_PCT = 80;
export const SESSION_AMBER_USD = 150;
/** A reading of 0 is trusted only when another reading under this backs it. */
const QUOTA_ZERO_BACKING_PCT = 5;
// Only these two levels are below `high`. xhigh and max are above it; an unknown string is not a break.
const BELOW_HIGH_EFFORT: ReadonlySet<string> = new Set(['low', 'medium']);

/** A ledger sum. `floor`: any run with `advised > 0`. `unpriced`: runs with no price (left out of `usd`). */
export type Usd = { usd: number; floor: boolean; unpriced: number };

/** `usd` null: no hud at all. `live`: label est. `resumed` > 0: label at least (hud is per process). */
export type EngineSum = { usd: number | null; live: boolean; resumed: number; noData: number; sessions: number };

export type QuotaTile = { sevenDayPct: number | null; asOfMs: number | null; amber: boolean };
export type SpendTile = { engine: EngineSum; est: Usd; amber: boolean };
export type BreaksTile = {
  distinct: number;
  haiku: number;
  sonnetLow: number;
  drift: number;
  driftChecked: number;
  runs: number;
};
export type CostTiles = { quota: QuotaTile; spend: SpendTile; breaks: BreaksTile };

/** The slice of a snapshot the fold reads. A full StateSnapshot fits. */
type FoldSnapshot = Pick<StateSnapshot, 'sessionId' | 'hud' | 'agentRuns'> & {
  cache: { lastUsedAt: number | null; resumed: boolean } | null;
};

/** Four decimals, the `money()` rule of session-detail.ts (a copy: that one is not exported). */
const money = (value: number): number => Math.round(value * 10_000) / 10_000;

export type Tier = 'opus' | 'sonnet' | 'fable' | 'haiku' | 'other';

/**
 * A copy of `tierOf` in .claude/plugins/ccv3-mods/hooks/shared/tiers.ts (outside this app, so it
 * cannot be imported). Keep the order: fable or mythos, opus, sonnet, haiku, else other.
 */
export const tierOf = (model: string): Tier => {
  const id = model.toLowerCase();
  if (id.includes('fable') || id.includes('mythos')) return 'fable';
  if (id.includes('opus')) return 'opus';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('haiku')) return 'haiku';
  return 'other';
};

/** The label of an engine sum: no data, else at least (resumed), else est (live), else engine. */
export function engineKind(engine: EngineSum): 'no data' | 'at least' | 'est' | 'engine' {
  if (engine.usd === null) return 'no data';
  if (engine.resumed > 0) return 'at least';
  return engine.live ? 'est' : 'engine';
}

export function sumEngine(snapshots: readonly FoldSnapshot[], live: boolean): EngineSum {
  let total = 0;
  let priced = 0;
  let resumed = 0;
  for (const snap of snapshots) {
    const cost = snap.hud?.costUsd ?? null;
    if (cost === null) continue;
    total += cost;
    priced += 1;
    if (snap.cache?.resumed === true) resumed += 1;
  }
  return {
    usd: priced === 0 ? null : money(total),
    live,
    resumed,
    noData: snapshots.length - priced,
    sessions: snapshots.length,
  };
}

export function sumEst(snapshots: readonly FoldSnapshot[]): Usd {
  let total = 0;
  let floor = false;
  let unpriced = 0;
  for (const snap of snapshots) {
    for (const run of snap.agentRuns) {
      total += run.costUsd;
      if (run.advised > 0) floor = true;
      if (run.hasUnknownModelCost) unpriced += 1;
    }
  }
  return { usd: money(total), floor, unpriced };
}

/**
 * The 7-day quota: the reading in the file with the newest `cache.lastUsedAt` (not the newest write).
 * A 0 there is trusted only when the next-newest reading is under 5; a session that has no rate-limit
 * data yet can write 0. Anything else reads "not reported" (null).
 */
export function foldQuota(snapshots: readonly FoldSnapshot[]): { sevenDayPct: number | null; asOfMs: number | null } {
  const readings = snapshots
    .flatMap((snap) => {
      const limit = snap.hud?.limits.find((item) => item.kind === 'seven_day');
      return limit === undefined ? [] : [{ pct: limit.percentUsed, at: snap.cache?.lastUsedAt ?? null }];
    })
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
  const newest = readings[0];
  if (newest === undefined) return { sevenDayPct: null, asOfMs: null };
  if (newest.pct === 0) {
    const next = readings[1];
    if (next === undefined || next.pct >= QUOTA_ZERO_BACKING_PCT) return { sevenDayPct: null, asOfMs: null };
  }
  return { sevenDayPct: newest.pct, asOfMs: newest.at };
}

export function foldBreaks(snapshots: readonly FoldSnapshot[]): BreaksTile {
  const out: BreaksTile = { distinct: 0, haiku: 0, sonnetLow: 0, drift: 0, driftChecked: 0, runs: 0 };
  for (const snap of snapshots) {
    for (const run of snap.agentRuns) {
      out.runs += 1;
      if (run.hasSpec) out.driftChecked += 1;
      const tier = run.model === null ? 'other' : tierOf(run.model);
      const haiku = tier === 'haiku';
      const sonnetLow = tier === 'sonnet' && run.effort !== null && BELOW_HIGH_EFFORT.has(run.effort.toLowerCase());
      // A haiku run already reads "Haiku is banned" in drift: it counts in the haiku arm only.
      const drift = !haiku && run.drift !== null && run.drift !== '';
      if (haiku) out.haiku += 1;
      if (sonnetLow) out.sonnetLow += 1;
      if (drift) out.drift += 1;
      if (haiku || sonnetLow || drift) out.distinct += 1;
    }
  }
  return out;
}

export function foldTiles(snapshots: readonly FoldSnapshot[], liveIds: ReadonlySet<string>): CostTiles {
  const live = snapshots.filter((snap) => liveIds.has(snap.sessionId));
  const quota = foldQuota(live);
  const engine = sumEngine(live, true);
  const quotaAmber = quota.sevenDayPct !== null && quota.sevenDayPct >= QUOTA_AMBER_PCT;
  const sessionAmber = live.some((snap) => (snap.hud?.costUsd ?? 0) >= SESSION_AMBER_USD);
  return {
    quota: { ...quota, amber: quotaAmber },
    spend: { engine, est: sumEst(live), amber: quotaAmber || sessionAmber },
    breaks: foldBreaks(live),
  };
}
