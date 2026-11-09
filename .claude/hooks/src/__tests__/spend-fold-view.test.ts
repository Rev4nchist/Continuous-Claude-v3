/**
 * Spend tab fold (PR E3): `foldSpendView` and `cdtDay` in apps/agentic-os/src/server/queries/spend-fold.ts, and the
 * rollup validator and derivation `parseRollup` in apps/agentic-os/src/server/queries/spend-rollup-parse.ts.
 * Both files are pure (type-only imports, no `server-only`), so this runner loads them by file URL, as
 * spend-fold.test.ts does. The file reader (src/server/sources/spend-rollup.ts) imports `server-only`; only
 * apps/agentic-os/e2e/spend.spec.ts reaches it.
 *
 * Each case names the change that breaks it:
 *   1   cdtDay on a fixed UTC offset (fails on the 25 h fall-back day), or the day cut at UTC midnight
 *   2   a today filter with `<` or `>` at the day edge, or one that reads Date.now() inside
 *   3   no today files: engine.usd 0 in place of null, or a residual of 0 in place of null
 *   4   the engine `live` flag read from the first session, not from any summed session
 *   5   a residual clamped at 0 (est can exceed engine), or a number when the engine is null
 *   6   the est sum added into engine.usd
 *   7   byModel: a wrong group key, a floor taken from another row, a null model dropped, a tie order that moves
 *   8   byEffort: a null effort merged with the string "null", or the effort dropped from the key
 *   9   byType: no top 8, an `other` row that drops floor or unpriced, a real type "other" merged into it
 *   10  a group table whose usd does not add up to est.usd
 *   11  bySession: a wrong sort or limit, null engine read as 0, amber at `>` or on a rounded value, shared flags
 *   12  the quality chip: unpriced counted per session, a wrong cap, resumed taken from a live-only set
 *   13  the quota amber line at `>`, or the quota read from live files only
 *   14  a clock text or day with no explicit zone (a server and a browser would print different text)
 *   15  parseRollup: the schema check after the field checks, a partial table for a bad row, a day that differs
 *   16  the per-model residual, or a null estUsd read as 0
 *   17  the share denominators
 *   18  money shown at cents: a residual or a total that is not the difference of the shown, cent-rounded operands
 *   19  a model with only null est rows read as est 0
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
  at: number;
  hud: { costUsd: number | null; limits: { kind: string; percentUsed: number }[] } | null;
  cache: { lastUsedAt: number | null; resumed: boolean } | null;
  agentRuns: Run[];
};
type Usd = { usd: number; floor: boolean; unpriced: number };
type EngineSum = { usd: number | null; live: boolean; resumed: number; noData: number; sessions: number };
type EstRow = { key: string; runs: number; isOther: boolean } & Usd;
type SessionRow = { sessionId: string; shortId: string; engine: EngineSum; est: Usd; amber: boolean };
type View = {
  asOf: string;
  day: string;
  engine: EngineSum;
  est: Usd;
  residualUsd: number | null;
  quota: { sevenDayPct: number | null; asOfMs: number | null; amber: boolean };
  byModel: EstRow[];
  byEffort: EstRow[];
  byType: EstRow[];
  bySession: SessionRow[];
  quality: { noData: number; unpricedRuns: number; atCap: number; resumed: number };
};
type SpendFold = {
  foldSpendView: (snaps: Snap[], liveIds: ReadonlySet<string>, nowMs: number) => View;
  cdtDay: (ms: number) => string;
  formatCtClock: (ms: number) => string;
  RUN_CAP: number;
};

type RollupRow = {
  model: string;
  effort: string | null;
  kind: string;
  requests: number;
  input: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
  writeRem: number;
  output: number;
  thinking: number;
  webSearches: number;
  estUsd: number | null;
};
type RollupFile = {
  schema: number;
  day: string;
  builtAt: string;
  rows: RollupRow[];
  engineByModel: { model: string; engineUsd: number }[];
  quality: { sessions: number; clean: number; resumed: number; sliced: number; residualBandPct: number | null };
};
type RollupResult =
  | {
      status: 'ok';
      rollup: {
        day: string;
        builtAt: string;
        rows: (RollupRow & { sharePct: number | null })[];
        models: { model: string; engineUsd: number | null; estUsd: number | null; residualUsd: number | null; sharePct: number | null }[];
        quality: RollupFile['quality'];
      };
    }
  | { status: 'absent' }
  | { status: 'unknown-schema' };
type RollupParse = {
  parseRollup: (raw: unknown, day: string, clean: (text: string) => string | null) => RollupResult;
};

const url = (rel: string): string => pathToFileURL(path.resolve(__dirname, rel)).href;
const g: SpendFold = await import(
  /* @vite-ignore */ url('../../../../apps/agentic-os/src/server/queries/spend-fold.ts')
);
const r: RollupParse = await import(
  /* @vite-ignore */ url('../../../../apps/agentic-os/src/server/queries/spend-rollup-parse.ts')
);

// 2026-11-09 12:00 America/Chicago (CST, UTC-6 after the 2026-11-01 fall-back).
const NOW = Date.UTC(2026, 10, 9, 18, 0, 0);
// CST midnight at the start of 2026-11-09.
const DAY_START = Date.UTC(2026, 10, 9, 6, 0, 0);

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
  at: NOW - 1000,
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
const view = (snaps: Snap[], live: string[] = []): View => g.foldSpendView(snaps, new Set(live), NOW);

describe('spend view: the CDT day', () => {
  it('1 cdtDay follows Chicago, including the 25 h fall-back day 2026-11-01', () => {
    expect(g.cdtDay(Date.UTC(2026, 10, 1, 4, 59, 59, 999))).toBe('2026-10-31');
    expect(g.cdtDay(Date.UTC(2026, 10, 1, 5, 0, 0))).toBe('2026-11-01');
    // 05:59:59 UTC on Nov 2 is still Nov 1 in Chicago (CST began at 07:00 UTC Nov 1): a fixed -5 offset says Nov 2.
    expect(g.cdtDay(Date.UTC(2026, 10, 2, 5, 59, 59, 999))).toBe('2026-11-01');
    expect(g.cdtDay(Date.UTC(2026, 10, 2, 6, 0, 0))).toBe('2026-11-02');
  });

  it('2 a file one ms before midnight is out, one at midnight is in, and nowMs is injected', () => {
    const v = view([
      snap('before', { at: DAY_START - 1, hud: hud(10) }),
      snap('exact', { at: DAY_START, hud: hud(2) }),
      snap('late', { at: DAY_START + 86_399_999, hud: hud(1) }),
      snap('next', { at: DAY_START + 86_400_000, hud: hud(100) }),
    ]);
    expect(v.engine.sessions).toBe(2);
    expect(v.engine.usd).toBe(3);
    expect(v.day).toBe('2026-11-09');
    expect(v.asOf).toBe(new Date(NOW).toISOString());
  });

  it('2 the day filter also holds on the 25 h day', () => {
    const nowFall = Date.UTC(2026, 10, 2, 5, 0, 0); // 23:00 CST on 2026-11-01
    const start = Date.UTC(2026, 10, 1, 5, 0, 0);
    const v = g.foldSpendView(
      [snap('in', { at: start, hud: hud(1) }), snap('out', { at: start - 1, hud: hud(5) })],
      new Set(),
      nowFall,
    );
    expect(v.engine.sessions).toBe(1);
    expect(v.day).toBe('2026-11-01');
  });
});

describe('spend view: headline', () => {
  it('3 no files today: engine.usd is null, not 0, and the residual is null', () => {
    const v = view([snap('old', { at: DAY_START - 5, hud: hud(50) })]);
    expect(v.engine.sessions).toBe(0);
    expect(v.engine.usd).toBeNull();
    expect(v.residualUsd).toBeNull();
    expect(v.byModel).toEqual([]);
    expect(v.bySession).toEqual([]);
  });

  it('4 the engine live flag is true when ANY summed session is live', () => {
    const snaps = [snap('a', { hud: hud(1) }), snap('b', { hud: hud(1) })];
    expect(view(snaps, ['b']).engine.live).toBe(true);
    expect(view(snaps, ['x']).engine.live).toBe(false);
    // A live id with no file today does not make the sum live.
    expect(view([snap('a', { at: DAY_START - 1, hud: hud(1) })], ['a']).engine.live).toBe(false);
  });

  it('5 the residual is engine minus est to 4 places; a negative value stays; null engine gives null', () => {
    const pos = view([snap('a', { hud: hud(10), agentRuns: [run({ costUsd: 3.25 })] })]);
    expect(pos.residualUsd).toBe(6.75);
    const neg = view([snap('a', { hud: hud(1), agentRuns: [run({ costUsd: 4 })] })]);
    expect(neg.residualUsd).toBe(-3);
    const none = view([snap('a', { agentRuns: [run({ costUsd: 4 })] })]);
    expect(none.residualUsd).toBeNull();
    const round = view([snap('a', { hud: hud(0.3), agentRuns: [run({ costUsd: 0.1 }), run({ costUsd: 0.2 })] })]);
    expect(round.residualUsd).toBe(0);
  });

  it('18 the headline shows cents: engine, est and residual are cent-rounded, and residual is their difference', () => {
    // 4-place residual is 0.998 (shows $1.00), but the shown operands are $2.00 and $1.01: the residual must read $0.99.
    const v = view([snap('a', { hud: hud(2.004), agentRuns: [run({ costUsd: 1.006 })] })]);
    expect(v.engine.usd).toBe(2);
    expect(v.est.usd).toBe(1.01);
    expect(v.residualUsd).toBe(0.99);
  });

  it('18 est rows and session rows are cent-rounded too, and three sub-cent runs of one model add before the cut', () => {
    const runs = [run({ costUsd: 0.3333 }), run({ costUsd: 0.3333 }), run({ costUsd: 0.3333 })];
    const v = view([snap('a', { hud: hud(2.0049), agentRuns: runs })]);
    expect(v.byModel[0].usd).toBe(1);
    expect(v.est.usd).toBe(1);
    expect(v.bySession[0].engine.usd).toBe(2);
    expect(v.bySession[0].est.usd).toBe(1);
    const split = view([snap('b', { agentRuns: [run({ model: 'm-1', costUsd: 0.3333 }), run({ model: 'm-2', costUsd: 0.3333 })] })]);
    expect(split.byModel.map((row) => row.usd)).toEqual([0.33, 0.33]);
  });

  it('6 the est sum never goes into engine.usd', () => {
    const v = view([snap('a', { agentRuns: [run({ costUsd: 3 })] })]);
    expect(v.est.usd).toBe(3);
    expect(v.engine.usd).toBeNull();
  });

  it('a resumed session sets engine.resumed (label "at least")', () => {
    const v = view([snap('a', { hud: hud(4), cache: cache(1, true) }), snap('b', { hud: hud(1) })]);
    expect(v.engine.resumed).toBe(1);
  });
});

describe('spend view: est tables', () => {
  it('7 byModel groups by model id with a fixed key for a null model, and per-row floor and unpriced', () => {
    const v = view([
      snap('a', {
        agentRuns: [
          run({ model: 'claude-opus-4-7', costUsd: 2, advised: 1 }),
          run({ model: 'claude-opus-4-7', costUsd: 1 }),
          run({ model: 'claude-sonnet-4-5', costUsd: 0.5 }),
          run({ model: 'claude-mystery-1', costUsd: 0, hasUnknownModelCost: true }),
          run({ model: null, costUsd: 0.25 }),
        ],
      }),
    ]);
    const by = Object.fromEntries(v.byModel.map((row) => [row.key, row]));
    expect(by['claude-opus-4-7']).toMatchObject({ runs: 2, usd: 3, floor: true, unpriced: 0 });
    expect(by['claude-sonnet-4-5']).toMatchObject({ runs: 1, usd: 0.5, floor: false, unpriced: 0 });
    expect(by['claude-mystery-1']).toMatchObject({ runs: 1, usd: 0, floor: false, unpriced: 1 });
    expect(by['unknown']).toMatchObject({ runs: 1, usd: 0.25 });
    expect(v.byModel.map((row) => row.key)).toEqual([
      'claude-opus-4-7',
      'claude-sonnet-4-5',
      'unknown',
      'claude-mystery-1',
    ]);
  });

  it('7 ties on usd sort by key ascending', () => {
    const v = view([
      snap('a', {
        agentRuns: [
          run({ model: 'm-b', costUsd: 1 }),
          run({ model: 'm-c', costUsd: 1 }),
          run({ model: 'm-a', costUsd: 1 }),
        ],
      }),
    ]);
    expect(v.byModel.map((row) => row.key)).toEqual(['m-a', 'm-b', 'm-c']);
  });

  it('8 byEffort has one row per model x effort; a null effort is not the string "null"', () => {
    const v = view([
      snap('a', {
        agentRuns: [
          run({ model: 'claude-sonnet-4-5', effort: 'high', costUsd: 1 }),
          run({ model: 'claude-sonnet-4-5', effort: 'medium', costUsd: 2 }),
          run({ model: 'claude-sonnet-4-5', effort: null, costUsd: 3 }),
          run({ model: 'claude-sonnet-4-5', effort: 'null', costUsd: 4 }),
          run({ model: 'claude-opus-4-7', effort: 'high', costUsd: 5 }),
        ],
      }),
    ]);
    expect(v.byEffort).toHaveLength(5);
    expect(new Set(v.byEffort.map((row) => row.key)).size).toBe(5);
    const noEffort = v.byEffort.filter((row) => row.usd === 3);
    const literal = v.byEffort.filter((row) => row.usd === 4);
    expect(noEffort[0].key).not.toBe(literal[0].key);
  });

  const types = (count: number): Run[] =>
    Array.from({ length: count }, (_, i) => run({ type: `type-${String(i).padStart(2, '0')}`, costUsd: 100 - i }));

  it('9 byType keeps the top 8 and merges the rest into one other row', () => {
    const runs = types(10);
    runs[8] = run({ type: 'type-08', costUsd: 92, advised: 1 });
    runs[9] = run({ type: 'type-09', costUsd: 0, hasUnknownModelCost: true });
    const v = view([snap('a', { agentRuns: runs })]);
    expect(v.byType).toHaveLength(9);
    const other = v.byType[8];
    expect(other).toMatchObject({ key: 'other', isOther: true, runs: 2, usd: 92, floor: true, unpriced: 1 });
    expect(v.byType.slice(0, 8).every((row) => !row.isOther)).toBe(true);
    expect(v.byType[0].key).toBe('type-00');
  });

  it('9 eight types or fewer: no other row', () => {
    expect(view([snap('a', { agentRuns: types(8) })]).byType).toHaveLength(8);
    expect(view([snap('a', { agentRuns: types(8) })]).byType.some((row) => row.isOther)).toBe(false);
  });

  it('9 a real agent type named "other" does not collide with the merged row', () => {
    const runs = [...types(9), run({ type: 'other', costUsd: 1000 })];
    const v = view([snap('a', { agentRuns: runs })]);
    const flagged = v.byType.filter((row) => row.isOther);
    expect(flagged).toHaveLength(1);
    const real = v.byType.find((row) => row.key === 'other' && !row.isOther);
    expect(real).toMatchObject({ runs: 1, usd: 1000 });
  });

  it('10 the usd of byModel, byEffort and byType adds up to est.usd', () => {
    const runs = [
      ...types(12),
      run({ type: 'x', model: 'm-1', effort: null, costUsd: 1.1 }),
      run({ type: null, model: null, effort: 'low', costUsd: 2.2 }),
    ];
    const v = view([snap('a', { agentRuns: runs }), snap('b', { agentRuns: [run({ costUsd: 0.3 })] })]);
    const total = (rows: EstRow[]): number => Math.round(rows.reduce((sum, row) => sum + row.usd, 0) * 10_000) / 10_000;
    expect(total(v.byModel)).toBe(v.est.usd);
    expect(total(v.byEffort)).toBe(v.est.usd);
    expect(total(v.byType)).toBe(v.est.usd);
  });
});

describe('spend view: by session and quality', () => {
  it('11 bySession is the top 10 by engine descending, null last, then id ascending', () => {
    const snaps = [
      snap('s-nodata'),
      ...Array.from({ length: 11 }, (_, i) => snap(`s-${String(i).padStart(2, '0')}`, { hud: hud(i + 1) })),
      snap('s-tie-b', { hud: hud(5) }),
    ];
    const v = view(snaps);
    expect(v.bySession).toHaveLength(10);
    expect(v.bySession[0].sessionId).toBe('s-10');
    expect(v.bySession.map((row) => row.engine.usd)).toEqual([11, 10, 9, 8, 7, 6, 5, 5, 4, 3]);
    const fives = v.bySession.filter((row) => row.engine.usd === 5).map((row) => row.sessionId);
    expect(fives).toEqual(['s-04', 's-tie-b']);
  });

  it('11 a null engine is kept as no data (usd null), never 0, and sorts after priced rows', () => {
    const v = view([snap('a'), snap('b', { hud: hud(0) })]);
    expect(v.bySession.map((row) => row.sessionId)).toEqual(['b', 'a']);
    expect(v.bySession[0].engine.usd).toBe(0);
    expect(v.bySession[1].engine.usd).toBeNull();
    expect(v.bySession[1].amber).toBe(false);
  });

  it('11 session amber is at or over 150 on the raw value', () => {
    const v = view([
      snap('plain', { hud: hud(149.99) }),
      snap('amber', { hud: hud(150) }),
      snap('round', { hud: hud(149.99996) }),
    ]);
    const by = Object.fromEntries(v.bySession.map((row) => [row.sessionId, row.amber]));
    expect(by).toEqual({ plain: false, amber: true, round: false });
  });

  it('11 live and resumed are set per session, and the short id is the first 8 characters', () => {
    const v = view(
      [snap('abcdef0123456789', { hud: hud(5), cache: cache(1, true) }), snap('zzzzzzzz-1', { hud: hud(1) })],
      ['zzzzzzzz-1'],
    );
    const a = v.bySession.find((row) => row.sessionId === 'abcdef0123456789');
    const z = v.bySession.find((row) => row.sessionId === 'zzzzzzzz-1');
    expect(a?.shortId).toBe('abcdef01');
    expect(a?.engine).toMatchObject({ live: false, resumed: 1 });
    expect(z?.engine).toMatchObject({ live: true, resumed: 0 });
  });

  it('12 quality: noData counts sessions, unpriced counts runs, atCap counts sessions at 50 runs, resumed counts today files', () => {
    expect(g.RUN_CAP).toBe(50);
    const full = Array.from({ length: g.RUN_CAP }, () => run({ costUsd: 0.01 }));
    const almost = Array.from({ length: g.RUN_CAP - 1 }, () => run());
    const v = view([
      snap('a', { agentRuns: [run({ hasUnknownModelCost: true }), run({ hasUnknownModelCost: true })] }),
      snap('b', { hud: hud(1), agentRuns: full, cache: cache(1, true) }),
      snap('c', { hud: hud(1), agentRuns: almost }),
      // A resumed file with no hud still counts as resumed here (unlike engine.resumed).
      snap('d', { cache: cache(1, true) }),
      snap('old', { at: DAY_START - 1, hud: hud(1), cache: cache(1, true), agentRuns: [run({ hasUnknownModelCost: true })] }),
    ]);
    expect(v.quality).toEqual({ noData: 2, unpricedRuns: 2, atCap: 1, resumed: 2 });
  });

  it('13 quota amber is at 80 and not at 79.9, over the today set (live or not)', () => {
    const at = (pct: number): View['quota'] =>
      view([snap('a', { hud: hud(1, pct), cache: cache(9_000) })]).quota;
    expect(at(79.9)).toMatchObject({ sevenDayPct: 79.9, amber: false });
    expect(at(80)).toMatchObject({ sevenDayPct: 80, amber: true });
    const old = view([snap('a', { at: DAY_START - 1, hud: hud(1, 90), cache: cache(9_000) })]).quota;
    expect(old).toMatchObject({ sevenDayPct: null, amber: false });
  });

  it('14 formatCtClock names the zone and the hour is 00 to 23', () => {
    expect(g.formatCtClock(Date.UTC(2026, 10, 9, 18, 5, 0))).toBe('12:05 CST');
    expect(g.formatCtClock(Date.UTC(2026, 6, 1, 17, 5, 0))).toBe('12:05 CDT');
    expect(g.formatCtClock(Date.UTC(2026, 10, 9, 6, 7, 0))).toBe('00:07 CST');
  });
});

describe('spend rollup: parse and derive', () => {
  const clean = (text: string): string | null => {
    const t = text.trim();
    return t === '' ? null : t;
  };
  const DAY = '2026-11-09';
  const row = (parts: Partial<RollupRow> = {}): RollupRow => ({
    model: 'claude-opus-4-7',
    effort: 'high',
    kind: 'main',
    requests: 10,
    input: 100,
    cacheRead: 1000,
    write5m: 10,
    write1h: 0,
    writeRem: 0,
    output: 50,
    thinking: 5,
    webSearches: 0,
    estUsd: 8,
    ...parts,
  });
  const file = (parts: Partial<RollupFile> = {}): RollupFile => ({
    schema: 1,
    day: DAY,
    builtAt: '2026-11-09T17:45:00.000Z',
    rows: [row()],
    engineByModel: [{ model: 'claude-opus-4-7', engineUsd: 10 }],
    quality: { sessions: 3, clean: 2, resumed: 1, sliced: 0, residualBandPct: 4.5 },
    ...parts,
  });
  const ok = (result: RollupResult): Extract<RollupResult, { status: 'ok' }>['rollup'] => {
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    return result.rollup;
  };

  it('15 schema other than 1 is "unknown-schema", and the check comes BEFORE the field checks', () => {
    expect(r.parseRollup(file({ schema: 2 }), DAY, clean)).toEqual({ status: 'unknown-schema' });
    expect(r.parseRollup({ schema: 2, rows: 'garbage', day: 5 }, DAY, clean)).toEqual({ status: 'unknown-schema' });
    expect(r.parseRollup({ schema: '1' }, DAY, clean)).toEqual({ status: 'unknown-schema' });
  });

  it('15 not an object, or a missing schema key: absent', () => {
    for (const raw of [null, 'x', 5, [], {}]) {
      expect(r.parseRollup(raw, DAY, clean).status).not.toBe('ok');
    }
    expect(r.parseRollup(null, DAY, clean)).toEqual({ status: 'absent' });
  });

  it('15 a valid file is ok', () => {
    expect(r.parseRollup(file(), DAY, clean).status).toBe('ok');
  });

  it('15 one bad row fails the whole file (no partial table)', () => {
    const bad: Partial<RollupRow>[] = [
      { requests: -1 },
      { input: Number.NaN },
      { output: Infinity },
      { kind: 'other' },
      { model: '' },
      { estUsd: Number.NaN },
      { webSearches: '1' as unknown as number },
    ];
    for (const parts of bad) {
      const result = r.parseRollup(file({ rows: [row(), row(parts)] }), DAY, clean);
      expect(result, JSON.stringify(parts)).toEqual({ status: 'absent' });
    }
  });

  it('15 a day that differs from the requested day, an unparseable builtAt, a bad quality: absent', () => {
    expect(r.parseRollup(file({ day: '2026-11-08' }), DAY, clean)).toEqual({ status: 'absent' });
    expect(r.parseRollup(file({ day: 'nope' }), 'nope', clean)).toEqual({ status: 'absent' });
    expect(r.parseRollup(file({ builtAt: 'yesterday-ish' }), DAY, clean)).toEqual({ status: 'absent' });
    const q = { sessions: 1.5, clean: 0, resumed: 0, sliced: 0, residualBandPct: null };
    expect(r.parseRollup(file({ quality: q }), DAY, clean)).toEqual({ status: 'absent' });
  });

  it('15 too many rows: absent', () => {
    const rows = Array.from({ length: 5001 }, () => row());
    expect(r.parseRollup(file({ rows }), DAY, clean)).toEqual({ status: 'absent' });
  });

  it('15 effort may be null (helper rows); estUsd may be null; residualBandPct may be null', () => {
    const rollup = ok(
      r.parseRollup(
        file({
          rows: [row({ model: 'claude-haiku-4-5', effort: null, kind: 'helper', estUsd: null })],
          quality: { sessions: 1, clean: 1, resumed: 0, sliced: 0, residualBandPct: null },
        }),
        DAY,
        clean,
      ),
    );
    expect(rollup.rows[0].estUsd).toBeNull();
    expect(rollup.rows[0].effort).toBeNull();
    expect(rollup.rows[0].sharePct).toBeNull();
    expect(rollup.quality.residualBandPct).toBeNull();
  });

  it('15 model and effort pass through the injected cleaner; a model that cleans to nothing fails the file', () => {
    const upper = (text: string): string | null => (text === 'bad' ? null : text.toUpperCase());
    const rollup = ok(r.parseRollup(file({ rows: [row({ model: 'm-1', effort: 'low' })], engineByModel: [] }), DAY, upper));
    expect(rollup.rows[0]).toMatchObject({ model: 'M-1', effort: 'LOW' });
    expect(r.parseRollup(file({ rows: [row({ model: 'bad' })] }), DAY, upper)).toEqual({ status: 'absent' });
  });

  it('16 per-model residual is engine minus the non-null est of its rows; null est never reads as 0', () => {
    const rollup = ok(
      r.parseRollup(
        file({
          rows: [
            row({ model: 'claude-opus-4-7', effort: 'high', estUsd: 6 }),
            row({ model: 'claude-opus-4-7', effort: 'low', kind: 'advisor', estUsd: 2 }),
            row({ model: 'claude-haiku-4-5', effort: null, kind: 'helper', estUsd: null }),
          ],
          engineByModel: [
            { model: 'claude-opus-4-7', engineUsd: 10.5 },
            { model: 'claude-haiku-4-5', engineUsd: 0.75 },
            { model: 'claude-fable-1', engineUsd: 3 },
          ],
        }),
        DAY,
        clean,
      ),
    );
    const by = Object.fromEntries(rollup.models.map((m) => [m.model, m]));
    expect(by['claude-opus-4-7']).toMatchObject({ engineUsd: 10.5, estUsd: 8, residualUsd: 2.5 });
    // A helper-only model: the whole engine cost is the residual.
    expect(by['claude-haiku-4-5']).toMatchObject({ engineUsd: 0.75, estUsd: null, residualUsd: 0.75 });
    // A model with no rows at all.
    expect(by['claude-fable-1']).toMatchObject({ engineUsd: 3, estUsd: null, residualUsd: 3 });
  });

  it('16 a negative residual is kept; a model with rows but no engine entry has a null residual', () => {
    const rollup = ok(
      r.parseRollup(
        file({
          rows: [row({ model: 'a', estUsd: 5 }), row({ model: 'b', estUsd: 1 })],
          engineByModel: [{ model: 'a', engineUsd: 4 }],
        }),
        DAY,
        clean,
      ),
    );
    const by = Object.fromEntries(rollup.models.map((m) => [m.model, m]));
    expect(by.a.residualUsd).toBe(-1);
    expect(by.b).toMatchObject({ engineUsd: null, residualUsd: null, estUsd: 1 });
  });

  it('19 a model whose rows all have a null est has est null (not 0); its residual is the whole engine', () => {
    const rollup = ok(
      r.parseRollup(
        file({
          rows: [row({ model: 'h', effort: null, kind: 'helper', estUsd: null }), row({ model: 'h', effort: null, kind: 'helper', estUsd: null })],
          engineByModel: [{ model: 'h', engineUsd: 0.75 }],
        }),
        DAY,
        clean,
      ),
    );
    expect(rollup.models[0]).toMatchObject({ model: 'h', engineUsd: 0.75, estUsd: null, residualUsd: 0.75 });
    // One non-null est among null rows is a real est, even when it is 0.
    const mixed = ok(
      r.parseRollup(
        file({
          rows: [row({ model: 'h', kind: 'helper', estUsd: null }), row({ model: 'h', estUsd: 0 })],
          engineByModel: [{ model: 'h', engineUsd: 1 }],
        }),
        DAY,
        clean,
      ),
    );
    expect(mixed.models[0]).toMatchObject({ estUsd: 0, residualUsd: 1 });
  });

  it('18 rollup money is cent-rounded: the model est is the sum of the shown row ests, the residual the difference', () => {
    const rollup = ok(
      r.parseRollup(
        file({
          rows: [0, 1, 2].map((i) => row({ effort: `e${i}`, estUsd: 0.3333 })),
          engineByModel: [{ model: 'claude-opus-4-7', engineUsd: 2 }],
        }),
        DAY,
        clean,
      ),
    );
    expect(rollup.rows.map((x) => x.estUsd)).toEqual([0.33, 0.33, 0.33]);
    // Not $1.00 / $1.00: 3 x $0.33 = $0.99, and $2.00 - $0.99 = $1.01.
    expect(rollup.models[0]).toMatchObject({ engineUsd: 2, estUsd: 0.99, residualUsd: 1.01 });
    // The share still uses the raw values: three equal rows are a third each.
    expect(rollup.rows.map((x) => x.sharePct)).toEqual([33.33, 33.33, 33.33]);
  });

  it('17 row share is estUsd over the sum of non-null estUsd; model share is engine over the sum of engine', () => {
    const rollup = ok(
      r.parseRollup(
        file({
          rows: [
            row({ model: 'a', effort: 'high', estUsd: 3 }),
            row({ model: 'a', effort: 'low', estUsd: 1 }),
            row({ model: 'h', effort: null, kind: 'helper', estUsd: null }),
          ],
          engineByModel: [
            { model: 'a', engineUsd: 6 },
            { model: 'h', engineUsd: 2 },
          ],
        }),
        DAY,
        clean,
      ),
    );
    expect(rollup.rows.map((x) => x.sharePct)).toEqual([75, 25, null]);
    const by = Object.fromEntries(rollup.models.map((m) => [m.model, m.sharePct]));
    expect(by).toEqual({ a: 75, h: 25 });
  });

  it('17 a zero total gives a null share, not NaN', () => {
    const rollup = ok(
      r.parseRollup(file({ rows: [row({ estUsd: 0 })], engineByModel: [{ model: 'claude-opus-4-7', engineUsd: 0 }] }), DAY, clean),
    );
    expect(rollup.rows[0].sharePct).toBeNull();
    expect(rollup.models[0].sharePct).toBeNull();
  });
});
