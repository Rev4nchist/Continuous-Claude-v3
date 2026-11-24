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

/** Two decimals. The Spend view shows cents, so it rounds here once and every shown total is a difference of shown numbers. */
const cent = (value: number): number => Math.round(value * 100) / 100;
const centEngine = (engine: EngineSum): EngineSum => ({ ...engine, usd: engine.usd === null ? null : cent(engine.usd) });
const centEst = (est: Usd): Usd => ({ ...est, usd: cent(est.usd) });

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

// --- The Spend tab (PR E3) ----------------------------------------------------------------------

/** A subagent ledger holds at most this many runs per session; a session at the cap undercounts. */
export const RUN_CAP = 50;
const BY_TYPE_TOP = 8;
const BY_SESSION_TOP = 10;
const CHICAGO = 'America/Chicago';

// Explicit zone, never the host zone: the server render and the browser must print the same text.
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: CHICAGO, year: 'numeric', month: '2-digit', day: '2-digit' });
const CLOCK_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: CHICAGO,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});

/** The Chicago calendar day of an epoch-ms time, `YYYY-MM-DD`. DST-safe (the fall-back day is 25 h). */
export const cdtDay = (ms: number): string => DAY_FORMAT.format(ms);

/** "12:05 CST" or "12:05 CDT": the Chicago clock with the zone name that holds at that time. */
export const formatCtClock = (ms: number): string => CLOCK_FORMAT.format(ms);

/** A state snapshot with its write time: the day filter needs `at`. A full StateSnapshot fits. */
export type DaySnapshot = FoldSnapshot & { at: number };

/** One row of an est table. `key` is the shown text; `isOther` marks the merged tail, so a real type "other" never collides. */
export type EstRow = { key: string; runs: number; isOther: boolean } & Usd;

/** One session of the "by session" table. The name is added by the caller: this fold reads no identity file. */
export type SessionRow = { sessionId: string; shortId: string; engine: EngineSum; est: Usd; amber: boolean };

export type SpendFoldView = {
  /** ISO-8601 UTC of `nowMs`. */
  asOf: string;
  /** The Chicago date the view covers. */
  day: string;
  engine: EngineSum;
  /**
   * The same files in two sums (fault C16): a LIVE session's cost is an estimate that still grows, an ENDED
   * session's cost is final. `engine` above is the whole day and reads `est` when any session is live; `split`
   * says how much of it is which.
   */
  split: { live: EngineSum; ended: EngineSum };
  est: Usd;
  /** Cent-rounded engine minus cent-rounded est. Negative values stay. Null when the engine has no data. */
  residualUsd: number | null;
  quota: QuotaTile;
  byModel: EstRow[];
  byEffort: EstRow[];
  byType: EstRow[];
  bySession: SessionRow[];
  quality: { noData: number; unpricedRuns: number; atCap: number; resumed: number };
};

type RunOf = FoldSnapshot['agentRuns'][number];

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const rowOrder = (a: EstRow, b: EstRow): number => b.usd - a.usd || byKey(a.key, b.key);

/** Group runs by an identity. `label` is the shown text. Sorted by usd descending, then key ascending. */
function groupRuns(
  snapshots: readonly FoldSnapshot[],
  identity: (run: RunOf) => [id: string, label: string],
): EstRow[] {
  const groups = new Map<string, { key: string; runs: number; usd: number; floor: boolean; unpriced: number }>();
  for (const snap of snapshots) {
    for (const run of snap.agentRuns) {
      const [id, key] = identity(run);
      const row = groups.get(id) ?? { key, runs: 0, usd: 0, floor: false, unpriced: 0 };
      row.runs += 1;
      row.usd += run.costUsd;
      if (run.advised > 0) row.floor = true;
      if (run.hasUnknownModelCost) row.unpriced += 1;
      groups.set(id, row);
    }
  }
  return [...groups.values()].map((row) => ({ ...row, usd: cent(row.usd), isOther: false })).sort(rowOrder);
}

/** The first `top` rows, then one `other` row that holds the rest: runs and usd add, floor is OR, unpriced adds. */
function topWithOther(rows: EstRow[], top: number): EstRow[] {
  if (rows.length <= top) return rows;
  const tail = rows.slice(top);
  const other: EstRow = {
    key: 'other',
    isOther: true,
    runs: tail.reduce((sum, row) => sum + row.runs, 0),
    usd: cent(tail.reduce((sum, row) => sum + row.usd, 0)),
    floor: tail.some((row) => row.floor),
    unpriced: tail.reduce((sum, row) => sum + row.unpriced, 0),
  };
  return [...rows.slice(0, top), other];
}

const sessionOrder = (a: SessionRow, b: SessionRow): number => {
  if (a.engine.usd === null || b.engine.usd === null) {
    if (a.engine.usd !== null) return -1;
    if (b.engine.usd !== null) return 1;
  } else if (a.engine.usd !== b.engine.usd) {
    return b.engine.usd - a.engine.usd;
  }
  return byKey(a.sessionId, b.sessionId);
};

/**
 * The Spend tab, from the state files with `at` on the Chicago day of `nowMs`. Live or not: a file keeps
 * its totals after the session ends. `nowMs` is a parameter so a test can fix the day. The rollup and the
 * session names are added by the caller. Money rounds once, here, to the cent (the tiles keep 4 places).
 */
export function foldSpendView(
  snapshots: readonly DaySnapshot[],
  liveIds: ReadonlySet<string>,
  nowMs: number,
): SpendFoldView {
  const day = cdtDay(nowMs);
  const today = snapshots.filter((snap) => cdtDay(snap.at) === day);
  const engine = centEngine(sumEngine(today, today.some((snap) => liveIds.has(snap.sessionId))));
  const est = centEst(sumEst(today));
  const quota = foldQuota(today);
  const split = {
    live: centEngine(sumEngine(today.filter((snap) => liveIds.has(snap.sessionId)), true)),
    ended: centEngine(sumEngine(today.filter((snap) => !liveIds.has(snap.sessionId)), false)),
  };

  const bySession = today
    .map((snap): SessionRow => ({
      sessionId: snap.sessionId,
      shortId: snap.sessionId.slice(0, 8),
      engine: sumEngine([snap], liveIds.has(snap.sessionId)),
      est: sumEst([snap]),
      // The raw value, not the rounded engine sum: $149.99996 is under the line.
      amber: (snap.hud?.costUsd ?? 0) >= SESSION_AMBER_USD,
    }))
    .sort(sessionOrder)
    .slice(0, BY_SESSION_TOP)
    // Round after the sort: two sessions that tie at the cent still order by their real cost.
    .map((row): SessionRow => ({ ...row, engine: centEngine(row.engine), est: centEst(row.est) }));

  return {
    asOf: new Date(nowMs).toISOString(),
    day,
    engine,
    split,
    est,
    residualUsd: engine.usd === null ? null : cent(engine.usd - est.usd),
    quota: { ...quota, amber: quota.sevenDayPct !== null && quota.sevenDayPct >= QUOTA_AMBER_PCT },
    byModel: groupRuns(today, (run) => {
      const model = run.model ?? 'unknown';
      return [JSON.stringify([run.model]), model];
    }),
    byEffort: groupRuns(today, (run) => [
      JSON.stringify([run.model, run.effort]),
      `${run.model ?? 'unknown'} / ${run.effort ?? 'no effort'}`,
    ]),
    byType: topWithOther(
      groupRuns(today, (run) => [JSON.stringify([run.type]), run.type ?? 'unknown']),
      BY_TYPE_TOP,
    ),
    bySession,
    quality: {
      noData: engine.noData,
      unpricedRuns: est.unpriced,
      atCap: today.filter((snap) => snap.agentRuns.length >= RUN_CAP).length,
      // Every today file with cache.resumed, also one with no hud (engine.resumed counts priced files only).
      resumed: today.filter((snap) => snap.cache?.resumed === true).length,
    },
  };
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
