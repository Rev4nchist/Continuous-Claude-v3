/**
 * The spend rollup file: validate it and derive the per-model residual and the shares.
 *
 * The file is `<CDT day>.json` in the spend dir. Its writer is the later W4 task; the contract is plan section 5
 * of .claudedocs/2026-11-09-pr-e-fleet-cost-plan.md and the sample e2e/fixtures/spend-rollup.sample.json.
 *
 * Pure on purpose: no imports at all and no `server-only`, so the hooks vitest
 * (.claude/hooks/src/__tests__/spend-fold-view.test.ts) can load it by file URL. The file reader
 * (src/server/sources/spend-rollup.ts) opens the file, parses the JSON and passes a `clean` function that
 * strips, redacts and clips a string. This module never touches the disk.
 *
 * Rules:
 *   - `schema` is checked FIRST. Anything other than the number 1 is "unknown-schema", whatever else the file holds.
 *   - One bad row, or any bad field, fails the WHOLE file ("absent"): a partial table would mislead.
 *     "absent" covers "not built yet" and "bad": the tab says the same words for both.
 *   - A null `estUsd` is kept as null. It is never read as 0 (helper rows have no ledger price). A model whose rows
 *     all have a null `estUsd` has a null `estUsd` too.
 *   - The file stores neither the share nor the residual. They are derived here. Shares round to 2 places.
 *   - Money that the screen shows rounds to CENTS here, once, from the raw values: the row est, the model engine, the
 *     model est (the sum of the cent-rounded row ests) and the residual (cent engine minus cent est). So the shown
 *     numbers add up. Shares use the raw values.
 */

export type RollupKind = 'main' | 'agent' | 'advisor' | 'helper';

export type RollupRowView = {
  model: string;
  /** Null on helper rows. */
  effort: string | null;
  kind: RollupKind;
  requests: number;
  input: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
  writeRem: number;
  output: number;
  thinking: number;
  webSearches: number;
  /** Cents. Null on helper rows (engine only). */
  estUsd: number | null;
  /** This row's est over the sum of all non-null est, in percent. Null when estUsd is null or the sum is 0. */
  sharePct: number | null;
};

export type RollupModelView = {
  model: string;
  /** From `engineByModel`. Null when the model has rows but no engine entry. */
  engineUsd: number | null;
  /** The sum of the (cent-rounded) non-null `estUsd` of this model's rows. Null when no row has a non-null est. */
  estUsd: number | null;
  /** Engine minus est (a null est counts as nothing). Negative stays. Null when `engineUsd` is null. */
  residualUsd: number | null;
  /** This model's engine over the sum of all engine, in percent. Null when engine is null or the sum is 0. */
  sharePct: number | null;
};

export type RollupQuality = {
  sessions: number;
  clean: number;
  resumed: number;
  sliced: number;
  residualBandPct: number | null;
};

export type RollupView = {
  day: string;
  builtAt: string;
  rows: RollupRowView[];
  models: RollupModelView[];
  quality: RollupQuality;
};

/** `absent`: no file, or a file that is not valid. `unknown-schema`: a `schema` other than 1. */
export type RollupResult = { status: 'ok'; rollup: RollupView } | { status: 'absent' } | { status: 'unknown-schema' };

export const ROLLUP_SCHEMA = 1;
const MAX_ROWS = 5000;
const MAX_MODELS = 500;
const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: readonly RollupKind[] = ['main', 'agent', 'advisor', 'helper'];
const COUNT_KEYS = ['requests', 'input', 'cacheRead', 'write5m', 'write1h', 'writeRem', 'output', 'thinking', 'webSearches'] as const;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const toCents = (value: number): number => Math.round(value * 100);
const percent = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 10_000) / 100 : null);

function parseRow(raw: unknown, clean: (text: string) => string | null): Omit<RollupRowView, 'sharePct'> | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.model !== 'string') return null;
  const model = clean(raw.model);
  if (model === null) return null;
  // An effort that cleans to nothing reads as no effort.
  const effort = raw.effort === null ? null : typeof raw.effort === 'string' ? clean(raw.effort) : undefined;
  if (effort === undefined) return null;
  const kind = KINDS.find((item) => item === raw.kind);
  if (kind === undefined) return null;
  const counts: Record<string, number> = {};
  for (const key of COUNT_KEYS) {
    const value = raw[key];
    if (!isCount(value)) return null;
    counts[key] = value;
  }
  const estUsd = raw.estUsd;
  if (estUsd !== null && !(typeof estUsd === 'number' && Number.isFinite(estUsd))) return null;
  return {
    model,
    effort,
    kind,
    requests: counts.requests,
    input: counts.input,
    cacheRead: counts.cacheRead,
    write5m: counts.write5m,
    write1h: counts.write1h,
    writeRem: counts.writeRem,
    output: counts.output,
    thinking: counts.thinking,
    webSearches: counts.webSearches,
    estUsd,
  };
}

function parseQuality(raw: unknown): RollupQuality | null {
  if (!isRecord(raw)) return null;
  const counts = [raw.sessions, raw.clean, raw.resumed, raw.sliced];
  if (!counts.every((value) => typeof value === 'number' && Number.isInteger(value) && value >= 0)) return null;
  const band = raw.residualBandPct;
  if (band !== null && !(typeof band === 'number' && Number.isFinite(band))) return null;
  return {
    sessions: raw.sessions as number,
    clean: raw.clean as number,
    resumed: raw.resumed as number,
    sliced: raw.sliced as number,
    residualBandPct: band,
  };
}

/** Engine totals by model id, in file order. A model listed twice adds. Null when an entry is not valid. */
function parseEngine(raw: unknown, clean: (text: string) => string | null): Map<string, number> | null {
  if (!Array.isArray(raw) || raw.length > MAX_MODELS) return null;
  const engine = new Map<string, number>();
  for (const item of raw) {
    if (!isRecord(item) || typeof item.model !== 'string') return null;
    const model = clean(item.model);
    if (model === null || !isCount(item.engineUsd)) return null;
    engine.set(model, (engine.get(model) ?? 0) + item.engineUsd);
  }
  return engine;
}

function deriveModels(rows: readonly RollupRowView[], engine: ReadonlyMap<string, number>): RollupModelView[] {
  // In cents, from the cent-rounded row ests, so a model's est is the sum of the cells on screen.
  const estCentsByModel = new Map<string, number>();
  for (const row of rows) {
    if (row.estUsd === null) continue;
    estCentsByModel.set(row.model, (estCentsByModel.get(row.model) ?? 0) + toCents(row.estUsd));
  }
  const engineTotal = [...engine.values()].reduce((sum, value) => sum + value, 0);
  const names = new Set([...engine.keys(), ...rows.map((row) => row.model)]);
  return [...names]
    .map((model): RollupModelView => {
      const engineCents = engine.has(model) ? toCents(engine.get(model) as number) : null;
      const estCents = estCentsByModel.get(model) ?? null;
      return {
        model,
        engineUsd: engineCents === null ? null : engineCents / 100,
        estUsd: estCents === null ? null : estCents / 100,
        residualUsd: engineCents === null ? null : (engineCents - (estCents ?? 0)) / 100,
        sharePct: engineCents === null ? null : percent(engine.get(model) as number, engineTotal),
      };
    })
    .sort((a, b) => {
      if (a.engineUsd === null || b.engineUsd === null) {
        if (a.engineUsd !== null) return -1;
        if (b.engineUsd !== null) return 1;
      } else if (a.engineUsd !== b.engineUsd) {
        return b.engineUsd - a.engineUsd;
      }
      return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
    });
}

/**
 * `raw` is the parsed JSON. `day` is the Chicago date asked for: a file that holds another day is not used.
 * `clean` strips, redacts and clips one string; it returns null for a string that is empty after cleaning.
 */
export function parseRollup(raw: unknown, day: string, clean: (text: string) => string | null): RollupResult {
  if (!isRecord(raw)) return { status: 'absent' };
  // First: a file of a newer schema may change every other field.
  if (raw.schema !== ROLLUP_SCHEMA) return { status: 'unknown-schema' };
  if (!DAY_FORMAT.test(day) || raw.day !== day) return { status: 'absent' };
  if (typeof raw.builtAt !== 'string' || !Number.isFinite(Date.parse(raw.builtAt))) return { status: 'absent' };
  if (!Array.isArray(raw.rows) || raw.rows.length > MAX_ROWS) return { status: 'absent' };

  const parsed: Omit<RollupRowView, 'sharePct'>[] = [];
  for (const item of raw.rows) {
    const row = parseRow(item, clean);
    if (row === null) return { status: 'absent' };
    parsed.push(row);
  }
  const engine = parseEngine(raw.engineByModel, clean);
  const quality = parseQuality(raw.quality);
  if (engine === null || quality === null) return { status: 'absent' };

  const estTotal = parsed.reduce((sum, row) => sum + (row.estUsd ?? 0), 0);
  const rows = parsed.map((row): RollupRowView => ({
    ...row,
    // The share uses the raw est; the shown est is rounded to the cent.
    estUsd: row.estUsd === null ? null : toCents(row.estUsd) / 100,
    sharePct: row.estUsd === null ? null : percent(row.estUsd, estTotal),
  }));
  return {
    status: 'ok',
    rollup: { day, builtAt: raw.builtAt, rows, models: deriveModels(rows, engine), quality },
  };
}
