/**
 * Spend fold: the money math and pick rules of the Fleet Overview cost tiles (T3 quota and spend, T4 rule breaks).
 *
 * The code is `foldTiles` in apps/agentic-os/src/server/queries/spend-fold.ts. That file is pure: type-only
 * imports and no `server-only`, so this runner can load it by URL, as fleet-cost-label.test.ts does.
 * The parser (state-files.ts) imports `server-only`; only apps/agentic-os/e2e/spend.spec.ts reaches it.
 *
 * Each case names the change that breaks it:
 *   1   a null engine total that reads 0
 *   2   a sum that adds null as 0, or a missing noData count
 *   3   a quota pick by `at` (file write time) instead of `cache.lastUsedAt`
 *   4   a quota of 0 trusted with no corroborating reading under 5
 *   5   the sonnet<high arm: a wrong tier test or a `<` effort compare
 *   6   a null effort counted as a break
 *   7   a haiku run counted in the drift arm, or twice in the distinct count
 *   8   driftChecked read from `drift !== null` instead of `hasSpec`
 *   9   a run that breaks two arms counted twice in `distinct`
 *   10  a resumed session that does not set engine.resumed or the "at least" label
 *   11  an amber line at `>` instead of `>=` (quota 80, engine $150)
 *   12  the est run sum added into engine.usd
 *   13  a dead session (not in the live set) counted in a total
 *   14  est money not rounded to 4 places
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

type Run = {
  id: string;
  type: string | null;
  model: string | null;
  status: string | null;
  tokens: number;
  costUsd: number;
  hasUnknownModelCost: boolean;
  advised: number;
  effort: string | null;
  drift: string | null;
  hasSpec: boolean;
  startedAt: number | null;
  endedAt: number | null;
};
type Snap = {
  sessionId: string;
  hud: { costUsd: number | null; limits: { kind: string; percentUsed: number }[] } | null;
  cache: { lastUsedAt: number | null; resumed: boolean } | null;
  agentRuns: Run[];
};
type EngineSum = { usd: number | null; live: boolean; resumed: number; noData: number; sessions: number };
type Fold = {
  quota: { sevenDayPct: number | null; asOfMs: number | null; amber: boolean };
  spend: {
    engine: EngineSum;
    est: { usd: number; floor: boolean; unpriced: number };
    amber: boolean;
  };
  breaks: {
    distinct: number;
    haiku: number;
    sonnetLow: number;
    drift: number;
    driftChecked: number;
    runs: number;
  };
};
type SpendFold = {
  foldTiles: (snapshots: Snap[], liveIds: ReadonlySet<string>) => Fold;
  engineKind: (engine: EngineSum) => 'no data' | 'at least' | 'est' | 'engine';
  tierOf: (model: string) => string;
};

const url = (rel: string): string => pathToFileURL(path.resolve(__dirname, rel)).href;
const g: SpendFold = await import(
  /* @vite-ignore */ url('../../../../apps/agentic-os/src/server/queries/spend-fold.ts')
);

let n = 0;
const run = (parts: Partial<Run> = {}): Run => ({
  id: `r${(n += 1)}`,
  type: 'scout',
  model: 'claude-sonnet-4-5',
  status: 'done',
  tokens: 100,
  costUsd: 0,
  hasUnknownModelCost: false,
  advised: 0,
  effort: 'high',
  drift: null,
  hasSpec: false,
  startedAt: null,
  endedAt: null,
  ...parts,
});
const snap = (id: string, parts: Partial<Snap> = {}): Snap => ({
  sessionId: id,
  hud: null,
  cache: null,
  agentRuns: [],
  ...parts,
});
const hud = (costUsd: number | null, sevenDay?: number): Snap['hud'] => ({
  costUsd,
  limits: sevenDay === undefined ? [] : [{ kind: 'seven_day', percentUsed: sevenDay }],
});
const cache = (lastUsedAt: number | null, resumed = false): Snap['cache'] => ({ lastUsedAt, resumed });
const fold = (snaps: Snap[], live?: string[]): Fold =>
  g.foldTiles(snaps, new Set(live ?? snaps.map((s) => s.sessionId)));

describe('spend fold: engine sum', () => {
  it('1 all hud null: engine.usd is null, not 0', () => {
    const f = fold([snap('a'), snap('b', { hud: hud(null) })]);
    expect(f.spend.engine.usd).toBeNull();
    expect(f.spend.engine.noData).toBe(2);
    expect(g.engineKind(f.spend.engine)).toBe('no data');
  });

  it('2 mixed: the sum skips null and noData counts it', () => {
    const f = fold([snap('a', { hud: hud(1.5) }), snap('b'), snap('c', { hud: hud(2) })]);
    expect(f.spend.engine.usd).toBe(3.5);
    expect(f.spend.engine.noData).toBe(1);
    expect(f.spend.engine.sessions).toBe(3);
  });

  it('13 a session outside the live set is in no total', () => {
    const f = fold(
      [
        snap('live', { hud: hud(1), agentRuns: [run({ costUsd: 0.5 })] }),
        snap('dead', { hud: hud(100), agentRuns: [run({ model: 'claude-haiku-4-5', costUsd: 9 })] }),
      ],
      ['live'],
    );
    expect(f.spend.engine.usd).toBe(1);
    expect(f.spend.est.usd).toBe(0.5);
    expect(f.breaks.runs).toBe(1);
    expect(f.breaks.haiku).toBe(0);
  });

  it('10 one resumed summed session: engine.resumed is 1 and the label is "at least"', () => {
    const f = fold([snap('a', { hud: hud(4), cache: cache(1000, true) }), snap('b', { hud: hud(1) })]);
    expect(f.spend.engine.resumed).toBe(1);
    expect(g.engineKind(f.spend.engine)).toBe('at least');
  });

  it('a live engine sum with no resume reads "est"', () => {
    const f = fold([snap('a', { hud: hud(4), cache: cache(1000) })]);
    expect(f.spend.engine.live).toBe(true);
    expect(f.spend.engine.resumed).toBe(0);
    expect(g.engineKind(f.spend.engine)).toBe('est');
  });

  it('12 the est run sum never goes into engine.usd', () => {
    const f = fold([snap('a', { agentRuns: [run({ costUsd: 3 })] })]);
    expect(f.spend.est.usd).toBe(3);
    expect(f.spend.engine.usd).toBeNull();
  });

  it('14 est money rounds to 4 places and carries the floor and unpriced counts', () => {
    const f = fold([
      snap('a', {
        agentRuns: [
          run({ costUsd: 0.1 }),
          run({ costUsd: 0.2 }),
          run({ costUsd: 0.00004, advised: 2 }),
          run({ hasUnknownModelCost: true }),
        ],
      }),
    ]);
    expect(f.spend.est.usd).toBe(0.3);
    expect(f.spend.est.floor).toBe(true);
    expect(f.spend.est.unpriced).toBe(1);
  });
});

describe('spend fold: quota', () => {
  // readStateFiles hands the fold its snapshots newest FILE WRITE first. So in every case below the
  // snapshot with the newest cache.lastUsedAt is the SECOND one: only a real sort by lastUsedAt picks it.
  it('3 quota comes from the newest cache.lastUsedAt, not the newest file write', () => {
    const f = fold([
      snap('newWrite', { hud: hud(1, 40), cache: cache(5_000) }),
      snap('oldWrite', { hud: hud(1, 61), cache: cache(9_000) }),
    ]);
    expect(f.quota.sevenDayPct).toBe(61);
    expect(f.quota.asOfMs).toBe(9_000);
  });

  it('4 a newest reading of 0 is not trusted when the next-newest reading is not under 5', () => {
    const f = fold([
      snap('b', { hud: hud(1, 40), cache: cache(5_000) }),
      snap('a', { hud: hud(1, 0), cache: cache(9_000) }),
    ]);
    expect(f.quota.sevenDayPct).toBeNull();
  });

  it('4 a lone 0 is not reported', () => {
    expect(fold([snap('a', { hud: hud(1, 0), cache: cache(9_000) })]).quota.sevenDayPct).toBeNull();
  });

  it('4 a 0 that the next-newest reading backs (under 5) is reported as 0', () => {
    const f = fold([
      snap('b', { hud: hud(1, 3), cache: cache(5_000) }),
      snap('a', { hud: hud(1, 0), cache: cache(9_000) }),
    ]);
    expect(f.quota.sevenDayPct).toBe(0);
  });

  it('no seven_day limit anywhere: not reported', () => {
    const f = fold([snap('a', { hud: hud(1), cache: cache(9_000) })]);
    expect(f.quota.sevenDayPct).toBeNull();
    expect(f.quota.amber).toBe(false);
  });
});

describe('spend fold: amber', () => {
  it('11 quota 79.9 is not amber, 80 is', () => {
    expect(fold([snap('a', { hud: hud(1, 79.9), cache: cache(1) })]).quota.amber).toBe(false);
    expect(fold([snap('a', { hud: hud(1, 80), cache: cache(1) })]).quota.amber).toBe(true);
  });

  it('11 a session engine of $149.99 is not amber, $150 is', () => {
    expect(fold([snap('a', { hud: hud(149.99) })]).spend.amber).toBe(false);
    expect(fold([snap('a', { hud: hud(150) })]).spend.amber).toBe(true);
  });

  it('11 quota at 80 makes spend amber too', () => {
    expect(fold([snap('a', { hud: hud(1, 80), cache: cache(1) })]).spend.amber).toBe(true);
  });
});

describe('spend fold: rule breaks', () => {
  it('5 sonnet at medium is in sonnetLow, sonnet at high and opus at medium are not', () => {
    const f = fold([
      snap('a', {
        agentRuns: [
          run({ model: 'claude-sonnet-4-5', effort: 'medium' }),
          run({ model: 'claude-sonnet-4-5', effort: 'high' }),
          run({ model: 'claude-opus-4-5', effort: 'medium' }),
        ],
      }),
    ]);
    expect(f.breaks.sonnetLow).toBe(1);
    expect(f.breaks.distinct).toBe(1);
    expect(f.breaks.runs).toBe(3);
  });

  it('5b only low and medium are below high: xhigh, max, High and unknown strings are not in sonnetLow', () => {
    const f = fold([
      snap('a', {
        agentRuns: [
          run({ model: 'claude-sonnet-4-5', effort: 'low' }),
          run({ model: 'claude-sonnet-4-5', effort: 'MEDIUM' }),
          run({ model: 'claude-sonnet-4-5', effort: 'xhigh' }),
          run({ model: 'claude-sonnet-4-5', effort: 'max' }),
          run({ model: 'claude-sonnet-4-5', effort: 'High' }),
          run({ model: 'claude-sonnet-4-5', effort: 'turbo' }),
        ],
      }),
    ]);
    expect(f.breaks.sonnetLow).toBe(2);
    expect(f.breaks.distinct).toBe(2);
  });

  it('6 a sonnet run with a null effort is not in sonnetLow', () => {
    const f = fold([snap('a', { agentRuns: [run({ effort: null })] })]);
    expect(f.breaks.sonnetLow).toBe(0);
    expect(f.breaks.distinct).toBe(0);
  });

  it('7 a haiku run with drift "Haiku is banned" is in haiku, not in drift, once in distinct', () => {
    const f = fold([
      snap('a', { agentRuns: [run({ model: 'claude-haiku-4-5', drift: 'Haiku is banned', hasSpec: true })] }),
    ]);
    expect(f.breaks.haiku).toBe(1);
    expect(f.breaks.drift).toBe(0);
    expect(f.breaks.distinct).toBe(1);
  });

  it('8 driftChecked counts runs with a spec, not runs with a drift value', () => {
    const f = fold([
      snap('a', {
        agentRuns: [run({ hasSpec: true, drift: null }), run({ hasSpec: false, drift: null })],
      }),
    ]);
    expect(f.breaks.driftChecked).toBe(1);
    expect(f.breaks.runs).toBe(2);
  });

  it('9 a sonnet medium run with drift is in sonnetLow and in drift, once in distinct', () => {
    const f = fold([
      snap('a', {
        agentRuns: [run({ effort: 'medium', drift: 'expected Sonnet · high', hasSpec: true })],
      }),
    ]);
    expect(f.breaks.sonnetLow).toBe(1);
    expect(f.breaks.drift).toBe(1);
    expect(f.breaks.distinct).toBe(1);
  });

  it('an empty drift string is not a drift', () => {
    const f = fold([snap('a', { agentRuns: [run({ drift: '' })] })]);
    expect(f.breaks.drift).toBe(0);
  });

  it('no runs: all zero', () => {
    const f = fold([snap('a')]);
    expect(f.breaks).toEqual({ distinct: 0, haiku: 0, sonnetLow: 0, drift: 0, driftChecked: 0, runs: 0 });
  });
});

describe('tierOf copy', () => {
  it('follows the order of shared/tiers.ts: fable or mythos, opus, sonnet, haiku, else other', () => {
    expect(g.tierOf('claude-fable-1')).toBe('fable');
    expect(g.tierOf('Claude-Mythos-1')).toBe('fable');
    expect(g.tierOf('claude-opus-4-5')).toBe('opus');
    expect(g.tierOf('anthropic/claude-sonnet-4-5')).toBe('sonnet');
    expect(g.tierOf('claude-haiku-4-5')).toBe('haiku');
    expect(g.tierOf('gpt-5')).toBe('other');
  });

  it('an id that holds two tier words takes the first branch: mythos before opus, opus before haiku', () => {
    expect(g.tierOf('mythos-opus-x')).toBe('fable');
    expect(g.tierOf('opus-haiku-x')).toBe('opus');
    expect(g.tierOf('sonnet-haiku-x')).toBe('sonnet');
    expect(g.tierOf('opus-sonnet-x')).toBe('opus');
  });
});
