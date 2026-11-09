/**
 * cost-reconcile-lib.mjs - Pure parts of the cost reconcile check. Node builtins only. Read-only.
 *
 * Method: .claudedocs/2026-11-09-token-cost-method.md sections 2.3, 3, 6.1 and 6.2.
 * Rates: .claude/plugins/ccv3-mods/hooks/shared/prices.json, keyed by EXACT model id.
 * The price rule here is the same rule as hooks/shared/price.ts. cost-reconcile-parity.test.mjs proves it on real usage rows.
 *
 * Residual = (recompute - ledger) / ledger, in percent. A negative residual means the transcript holds less than the ledger billed.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const M = 1_000_000;
export const SYNTHETIC = '<synthetic>';
const ZERO = Object.freeze({ zero: true });

export const loadPrices = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** A model id to the key of the price table: no provider prefix, no [1m], no Bedrock version, no trailing date. */
export const normalizeModelId = (model) => {
  const id = String(model ?? '').trim().toLowerCase().replace(/\[1m\]$/, '');
  const at = id.indexOf('claude-');
  return (at < 0 ? id : id.slice(at)).replace(/-v\d+:\d+$/, '').replace(/[-@]\d{8}$/, '');
};

/** The price row of an id, ZERO for <synthetic>, null for an id the table lacks. */
export const entryOf = (prices, model) => {
  if (String(model ?? '').trim().toLowerCase() === SYNTHETIC) return ZERO;
  const id = normalizeModelId(model);
  return Object.hasOwn(prices.models, id) ? prices.models[id] : null;
};

export const isHaiku = (model) => normalizeModelId(model).startsWith('claude-haiku');

const count = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

const ratesFor = (prices, entry, prompt, { fast = false, geoUs = false, tier } = {}) => {
  const limit = entry.promptTierTokens ?? prices.modifiers.haikuPromptTierTokens ?? 100_000;
  const high = entry.over100k !== undefined && (tier === 'high' || (tier === undefined && prompt > limit));
  const base = high ? entry.over100k : entry;
  let r = { input: base.input, write5m: base.write5m, write1h: base.write1h, cacheHit: base.cacheHit, output: base.output };
  if (fast && entry.fastInput !== undefined && entry.fastOutput !== undefined) {
    const f = entry.fastInput / entry.input;
    r = { input: entry.fastInput, write5m: entry.write5m * f, write1h: entry.write1h * f, cacheHit: entry.cacheHit * f, output: entry.fastOutput };
  }
  if (geoUs && entry.geo) {
    const g = prices.modifiers.usGeoMultiplier;
    r = { input: r.input * g, write5m: r.write5m * g, write1h: r.write1h * g, cacheHit: r.cacheHit * g, output: r.output * g };
  }
  return r;
};

/** Dollars for one request's top-level usage (web search included), or null for an unknown id. */
export const priceUsage = (prices, usage, model) => {
  const entry = entryOf(prices, model);
  if (entry === null) return null;
  if (entry === ZERO) return 0;
  const cc = usage.cache_creation;
  const w5 = count(cc?.ephemeral_5m_input_tokens);
  const w1 = count(cc?.ephemeral_1h_input_tokens);
  const rest = Math.max(0, count(usage.cache_creation_input_tokens) - w5 - w1);
  const input = count(usage.input_tokens);
  const read = count(usage.cache_read_input_tokens);
  const out = count(usage.output_tokens);
  const speed = typeof usage.speed === 'string' && usage.speed !== '' && usage.speed !== 'standard';
  const r = ratesFor(prices, entry, input + read + w5 + w1 + rest, { fast: speed, geoUs: usage.inference_geo === 'us' });
  const tokens = (input * r.input + read * r.cacheHit + (w5 + rest) * r.write5m + w1 * r.write1h + out * r.output) / M;
  return tokens + count(usage.server_tool_use?.web_search_requests) * prices.modifiers.webSearchPerRequest;
};

/** The advisor_message entries of usage.iterations, each with its own model id. */
export const advisorIterations = (usage, fallbackModel) => {
  if (!Array.isArray(usage.iterations)) return [];
  return usage.iterations
    .filter((it) => typeof it === 'object' && it !== null && it.type === 'advisor_message')
    .map((it) => ({ model: typeof it.model === 'string' ? it.model : fallbackModel, usage: { ...it, inference_geo: usage.inference_geo } }));
};

/** One request in full: top-level usage plus every advisor iteration at its own model. Same contract as price.ts stepCost(). */
export const priceStep = (prices, usage, model) => {
  const top = priceUsage(prices, usage, model);
  let usd = top ?? 0;
  let unknown = top === null;
  for (const it of advisorIterations(usage, undefined)) {
    const p = typeof it.model === 'string' ? priceUsage(prices, it.usage, it.model) : null;
    if (p === null) unknown = true;
    else usd += p;
  }
  return { usd, unknown };
};

/**
 * Dollars for an aggregate row of token counts { in, out, cr, cw, cw5, cw1h, ws }. The write that cw5 and cw1h leave out is
 * priced at 5m. tier 'high' reads the Haiku over-100K rates (an aggregate row cannot know the tier of each request).
 */
export const priceCounts = (prices, model, c, { tier } = {}) => {
  const entry = entryOf(prices, model);
  if (entry === null) return null;
  if (entry === ZERO) return 0;
  const rem = Math.max(0, count(c.cw) - count(c.cw5) - count(c.cw1h));
  const r = ratesFor(prices, entry, 0, { tier: tier ?? 'low' });
  return (count(c.in) * r.input + count(c.out) * r.output + count(c.cr) * r.cacheHit + (count(c.cw5) + rem) * r.write5m + count(c.cw1h) * r.write1h) / M
    + count(c.ws) * prices.modifiers.webSearchPerRequest;
};

// ---- statistics -----------------------------------------------------------------------------------------------------
export const quantile = (xs, p) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const k = (s.length - 1) * p;
  const f = Math.floor(k);
  const c = Math.min(f + 1, s.length - 1);
  return s[f] + (s[c] - s[f]) * (k - f);
};
export const median = (xs) => quantile(xs, 0.5);
export const stat = (xs) => {
  if (xs.length === 0) return { n: 0 };
  const ab = xs.map(Math.abs);
  return { n: xs.length, median: median(xs), p95abs: quantile(ab, 0.95), maxabs: Math.max(...ab), min: Math.min(...xs), max: Math.max(...xs) };
};

// ---- transcripts and ledger -----------------------------------------------------------------------------------------
const recordsOf = (file, type) => {
  const needle = `"type":"${type}"`;
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes(needle)) continue;
    try {
      const r = JSON.parse(line);
      if (r.type === type) out.push(r);
    } catch { /* a torn last line of a live transcript is not a record */ }
  }
  return out;
};

export const readLedger = (mainFile) => recordsOf(mainFile, 'cost-state');

const zeroCounts = () => ({ in: 0, out: 0, cr: 0, cw: 0, cw5: 0, cw1h: 0, ws: 0, n: 0, adv: 0 });

/**
 * Fold the assistant records of a session. files[0] is the main transcript, the rest are subagent files.
 * minMs > 0 keeps only records at or after that time (the slice of a resumed session). A message.id counts once across all files.
 * Returns { models: { id: { usd, c, unknown } }, requests, advisorIterations, firstTs, flags: { id: { speed, geo } } }.
 */
export const foldTranscripts = (prices, files, { minMs = 0 } = {}) => {
  const seen = new Set();
  const models = {};
  const flags = {};
  let firstTs = null;
  let requests = 0;
  let advisor = 0;
  const bucket = (id) => (models[id] ??= { usd: 0, c: zeroCounts(), unknown: false });
  files.forEach((file, index) => {
    for (const r of recordsOf(file, 'assistant')) {
      const u = r.message?.usage;
      const id = r.message?.id;
      if (!u || !id) continue;
      if (minMs > 0 && !(Date.parse(r.timestamp) >= minMs)) continue;
      if (index === 0 && firstTs === null) firstTs = r.timestamp;
      if (seen.has(id)) continue;
      seen.add(id);
      requests += 1;
      const model = r.message.model;
      const b = bucket(model);
      const top = priceUsage(prices, u, model);
      if (top === null) b.unknown = true;
      else b.usd += top;
      const cc = u.cache_creation ?? {};
      b.c.in += count(u.input_tokens); b.c.out += count(u.output_tokens); b.c.cr += count(u.cache_read_input_tokens);
      b.c.cw += count(u.cache_creation_input_tokens); b.c.cw5 += count(cc.ephemeral_5m_input_tokens); b.c.cw1h += count(cc.ephemeral_1h_input_tokens);
      b.c.ws += count(u.server_tool_use?.web_search_requests); b.c.n += 1;
      if (String(model).toLowerCase() !== SYNTHETIC) {
        const f = (flags[model] ??= { speed: 0, geo: 0 });
        if (typeof u.speed === 'string' && u.speed !== '' && u.speed !== 'standard') f.speed += 1;
        if (typeof u.inference_geo === 'string' && u.inference_geo !== '' && u.inference_geo !== 'global') f.geo += 1;
      }
      for (const it of advisorIterations(u, r.advisorModel)) {
        advisor += 1;
        const ab = bucket(it.model);
        const p = typeof it.model === 'string' ? priceUsage(prices, it.usage, it.model) : null;
        if (p === null) ab.unknown = true;
        else ab.usd += p;
        ab.c.in += count(it.usage.input_tokens); ab.c.out += count(it.usage.output_tokens);
        ab.c.cr += count(it.usage.cache_read_input_tokens); ab.c.cw += count(it.usage.cache_creation_input_tokens); ab.c.adv += 1;
      }
    }
  });
  return { models, requests, advisorIterations: advisor, firstTs, flags };
};

/** Group cost-state rows by startTime, keep the last row of each group, order by startTime. */
export const groupLedger = (rows) => {
  const byStart = new Map();
  for (const row of rows) byStart.set(row.startTime, row);
  return [...byStart.entries()].sort((a, b) => a[0] - b[0]).map(([startTime, row]) => ({ startTime, row }));
};

/** One entry per (group, model): the ledger tokens and dollars, and whether the row names the 5m and 1h parts. */
export const ledgerModelRows = (groups) => {
  const out = [];
  for (const { startTime, row } of groups) {
    for (const [model, m] of Object.entries(row.modelUsage ?? {})) {
      out.push({
        startTime, model, costUSD: m.costUSD ?? 0,
        hasSplit: m.cacheCreationEphemeral5mInputTokens !== undefined && m.cacheCreationEphemeral1hInputTokens !== undefined,
        counts: {
          in: m.inputTokens ?? 0, out: m.outputTokens ?? 0, cr: m.cacheReadInputTokens ?? 0, cw: m.cacheCreationInputTokens ?? 0,
          cw5: m.cacheCreationEphemeral5mInputTokens ?? 0, cw1h: m.cacheCreationEphemeral1hInputTokens ?? 0, ws: m.webSearchRequests ?? 0,
        },
      });
    }
  }
  return out;
};

export const isClean = ({ groups, resumed, totalUsd, minUsd = 1 }) => groups === 1 && resumed !== true && totalUsd >= minUsd;

// ---- price check ----------------------------------------------------------------------------------------------------
const pct = (recompute, ledger) => ((recompute - ledger) / ledger) * 100;
const fmt = (x) => (Math.abs(x) < 0.005 ? 0 : x).toFixed(2);

/**
 * Price check of one ledger row: its tokens x prices.json against its costUSD (method 6.1).
 * status: pass | fail | unproven | repaired | reported | warn | skip-small | skip-synthetic.
 *   fail: an unknown id, or a complete non-Haiku row above the tolerance (0.01%).
 *   unproven: the row would fail the gate, but the transcript holds fast-mode or non-global requests of that model (opts.mixed).
 *             The row has no fast or geo split, so the gate cannot judge it. It never fails; the capture bands judge it (method 6.2).
 *   repaired: a no-split non-Haiku row, priced with the transcript 1h share; never fails.
 *   reported: a Haiku row with cache tokens; the tier of each request is lost in an aggregate row.
 */
export const checkPriceRow = (prices, row, { share1h, minRowUsd = 0.01, tolerancePct = 0.01, mixed = false } = {}) => {
  const { model, counts: c, costUSD: ledger } = row;
  const base = { model, startTime: row.startTime, ledgerUsd: ledger, remainder: Math.max(0, c.cw - c.cw5 - c.cw1h) };
  const entry = entryOf(prices, model);
  if (entry === null) return { ...base, status: 'fail', code: 'unknown-model', residualPct: null };
  if (entry === ZERO) return { ...base, status: 'skip-synthetic', residualPct: null };
  if (ledger < minRowUsd) return { ...base, status: 'skip-small', residualPct: null };
  if (isHaiku(model)) {
    const low = pct(priceCounts(prices, model, c, { tier: 'low' }), ledger);
    if (c.cr + c.cw > 0) {
      return { ...base, status: 'reported', residualPct: low, highTierResidualPct: pct(priceCounts(prices, model, c, { tier: 'high' }), ledger), note: `Haiku row with cache tokens, reported only, residual ${fmt(low)}%` };
    }
    return { ...base, status: Math.abs(low) > tolerancePct ? 'warn' : 'pass', code: 'haiku-price-mismatch', residualPct: low };
  }
  if (!row.hasSplit && c.cw > 0) {
    const cw1h = Math.round(c.cw * (share1h ?? 0));
    const fixed = pct(priceCounts(prices, model, { ...c, cw1h, cw5: c.cw - cw1h }), ledger);
    return {
      ...base, status: 'repaired', residualPct: fixed, share1h: share1h ?? 0,
      allFivePct: pct(priceCounts(prices, model, { ...c, cw5: c.cw, cw1h: 0 }), ledger),
      allOneHourPct: pct(priceCounts(prices, model, { ...c, cw5: 0, cw1h: c.cw }), ledger),
      note: `repaired, residual ${fmt(fixed)}%`,
    };
  }
  const res = pct(priceCounts(prices, model, c), ledger);
  if (Math.abs(res) <= tolerancePct) return { ...base, status: 'pass', residualPct: res };
  if (mixed) return { ...base, status: 'unproven', code: 'rule-unproven', residualPct: res };
  return { ...base, status: 'fail', code: 'price-mismatch', residualPct: res };
};

// ---- capture bands --------------------------------------------------------------------------------------------------
/** Info above singleInfoPct, warn above singleWarnPct. A single session is never a fail. */
export const singleSessionLevel = (baseline, residualPct) => {
  const a = Math.abs(residualPct);
  if (a > baseline.singleWarnPct) return 'warn';
  if (a > baseline.singleInfoPct) return 'info';
  return null;
};

/**
 * Add clean sessions to the rolling window: only sessions that start after baseline.afterTs, each sid once (the first residual stays),
 * ordered by first timestamp, newest baseline.window kept.
 */
export const updateWindow = (window, sessions, baseline) => {
  const have = new Set(window.map((w) => w.sid));
  const cut = Date.parse(baseline.afterTs);
  const add = [];
  for (const s of sessions) {
    if (have.has(s.sid) || !(Date.parse(s.firstTs) > cut)) continue;
    have.add(s.sid);
    add.push({ sid: s.sid, firstTs: s.firstTs, residualPct: s.residualPct });
  }
  return [...window, ...add].sort((a, b) => Date.parse(a.firstTs) - Date.parse(b.firstTs)).slice(-baseline.window);
};

/** A short fingerprint of the sids in the rolling window. Two nights with the same fingerprint saw no new evidence. */
export const windowSig = (window) => createHash('sha1').update(window.map((w) => w.sid).join(',')).digest('hex').slice(0, 12);

/**
 * One nightly evaluation of the rolling median.
 * status: warmup (fewer than baseline.window sessions: report only) | ok | warn | fail.
 * warn: |median| > |baseline| + warnDelta. over: |median| > |baseline| + failDelta. fail: over on failConsecutiveRuns runs in a row.
 * A median closer to 0 than the thresholds never warns or fails. A rerun on the same day replaces that day's entry.
 * sig is the windowSig of the window. A night with the same sig as the last entry saw no new evidence: it does not count as
 * another run. That entry moves to the new day and keeps its result. Without a sig (replay) every run counts.
 */
export const evaluateBands = (baseline, residuals, history, day, sig = null) => {
  const n = residuals.length;
  const med = n > 0 ? median(residuals) : null;
  const warnAt = Math.abs(baseline.baselineMedianPct) + baseline.warnDeltaPts;
  const failAt = Math.abs(baseline.baselineMedianPct) + baseline.failDeltaPts;
  const warmup = n < baseline.window;
  const over = !warmup && Math.abs(med) > failAt;
  const kept = history.filter((h) => h.day !== day);
  const carry = sig !== null && kept.length > 0 && kept[kept.length - 1].sig === sig;
  const entry = carry ? { ...kept[kept.length - 1], day } : { day, median: med, n, over, status: 'ok', sig };
  const next = [...(carry ? kept.slice(0, -1) : kept), entry].slice(-10);
  let trailing = 0;
  for (let i = next.length - 1; i >= 0 && next[i].over; i -= 1) trailing += 1;
  let status = 'ok';
  if (warmup) status = 'warmup';
  else if (over && trailing >= baseline.failConsecutiveRuns) status = 'fail';
  else if (Math.abs(med) > warnAt) status = 'warn';
  entry.status = status;
  return { status, median: med, n, over: entry.over, consecutiveOver: trailing, warnAt, failAt, history: next };
};

/**
 * Replay a series of clean-session residuals (date order) as nightly runs. One run per entry of `ends` (end positions in the
 * series), default one run per session. Each run sees the newest baseline.window sessions up to its end.
 */
export const replayBands = (baseline, residuals, ends = residuals.map((_, i) => i + 1)) => {
  let history = [];
  const steps = [];
  ends.forEach((end, i) => {
    const r = evaluateBands(baseline, residuals.slice(Math.max(0, end - baseline.window), end), history, `step-${i}`);
    history = r.history;
    steps.push({ end, n: r.n, median: r.median, status: r.status });
  });
  return { steps, fails: steps.filter((s) => s.status === 'fail').length, warns: steps.filter((s) => s.status === 'warn').length };
};
