// Price table for estimates the HUD, the Agent Ledger and Cache Guard show. Pure.
// Rates come from prices.generated.ts, built by scripts/pricing/refresh-prices.mjs from the official
// pricing page and keyed by EXACT model id (prices.json is the same table). An estimate, never the bill:
// the HUD's session cost comes from $.session.usage(), which is the engine's own /cost ledger.
//
// One request costs: input x in + cache read x hit + 5m write x write5m + 1h write x write1h + output x out,
// where the write total that 5m + 1h leave out is priced at 5m (as the engine does). Haiku 5.5 reads its
// over-100K rates when the request's prompt (input + cache read + cache write) is over 100,000 tokens.
// Fast mode uses the id's own fast rates. US-only inference (`inference_geo: us`) is 1.1x from Claude 4.6 up.

import { PRICES } from './prices.generated'

/** Dollars per million tokens. */
type Rates = { input: number; write5m: number; write1h: number; cacheHit: number; output: number }
type Entry = Rates & { geo: boolean; fastInput?: number; fastOutput?: number; over100k?: Rates; promptTierTokens?: number }

const TABLE: Readonly<Record<string, Entry>> = PRICES.models
const WEB_SEARCH_USD = PRICES.modifiers.webSearchPerRequest
const GEO_MULTIPLIER = PRICES.modifiers.usGeoMultiplier
const M = 1_000_000

/** `<synthetic>` records are the engine's own placeholders: no tokens were billed. */
const SYNTHETIC = '<synthetic>'

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  /** The 5-minute and 1-hour parts of `cache_creation_input_tokens`. Absent on the turn.step usage. */
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null
  server_tool_use?: { web_search_requests?: number | null } | null
  /** Per-iteration usage of a server-side loop; only `advisor_message` entries are priced (see advisorCost). */
  iterations?: unknown
  speed?: string | null
  inference_geo?: string | null
}

/**
 * A model id to the key of the price table: lower case, no provider prefix ("anthropic.", "us.anthropic.",
 * "vertex_ai/"), no `[1m]`, no Bedrock version suffix (-v1:0), no trailing date (-YYYYMMDD, or @YYYYMMDD on Vertex).
 * It does not check that the key exists.
 */
export const normalizeModelId = (model: string): string => {
  const id = model.trim().toLowerCase().replace(/\[1m\]$/, '')
  const at = id.indexOf('claude-')
  return (at < 0 ? id : id.slice(at)).replace(/-v\d+:\d+$/, '').replace(/[-@]\d{8}$/, '')
}

const ZERO: Entry = { input: 0, write5m: 0, write1h: 0, cacheHit: 0, output: 0, geo: false }

/** The price row of a model id, or null for an id the table lacks. A tier or an alias ("opus") is not an id. */
const entryOf = (model: string): Entry | null => {
  if (model.trim().toLowerCase() === SYNTHETIC) return ZERO
  const id = normalizeModelId(model)
  return Object.hasOwn(TABLE, id) ? (TABLE[id] ?? null) : null
}

// A token count that is negative, NaN, infinite or not a number is CLAMPED to 0 (not priced as null):
// an odd transcript record then adds nothing, and never lowers a sum or makes a price negative.
// Every token count in this file passes through count(), including the `tokens` of coldCost and warmCost.
const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)

/** A token count as the Agent Ledger and the HUD sum it: negative, NaN, infinite or not a number is 0. */
export const tokenCount = count

/** The token classes of one request. `w5` holds the remainder; `split` says whether the usage named a 5m/1h split. */
type Parts = { input: number; read: number; w5: number; w1: number; out: number; split: boolean }

const partsOf = (usage: Usage, oneHour = false): Parts => {
  const total = count(usage.cache_creation_input_tokens)
  const cc = usage.cache_creation
  const split = cc !== null && cc !== undefined
  const w5 = count(cc?.ephemeral_5m_input_tokens)
  const w1 = count(cc?.ephemeral_1h_input_tokens)
  const rest = Math.max(0, total - w5 - w1)
  const base = { input: count(usage.input_tokens), read: count(usage.cache_read_input_tokens), out: count(usage.output_tokens), split }
  // With no split, the caller says which TTL the whole write used.
  if (!split && oneHour) return { ...base, w5: 0, w1: rest }
  return { ...base, w5: w5 + rest, w1 }
}

const isFast = (usage: Usage): boolean => typeof usage.speed === 'string' && usage.speed !== '' && usage.speed !== 'standard'

/** The rates one request pays: its Haiku tier, then fast mode, then the US-only multiplier. */
const ratesFor = (entry: Entry, prompt: number, usage: Usage): Rates => {
  const tiered = entry.over100k !== undefined && prompt > (entry.promptTierTokens ?? 100_000) ? entry.over100k : entry
  let rates: Rates = { input: tiered.input, write5m: tiered.write5m, write1h: tiered.write1h, cacheHit: tiered.cacheHit, output: tiered.output }
  if (isFast(usage) && entry.fastInput !== undefined && entry.fastOutput !== undefined) {
    // Cache multipliers stack on the fast input: the same ratios as the standard row.
    const f = entry.fastInput / entry.input
    rates = { input: entry.fastInput, write5m: entry.write5m * f, write1h: entry.write1h * f, cacheHit: entry.cacheHit * f, output: entry.fastOutput }
  }
  if (usage.inference_geo === 'us' && entry.geo) {
    rates = { input: rates.input * GEO_MULTIPLIER, write5m: rates.write5m * GEO_MULTIPLIER, write1h: rates.write1h * GEO_MULTIPLIER, cacheHit: rates.cacheHit * GEO_MULTIPLIER, output: rates.output * GEO_MULTIPLIER }
  }
  return rates
}

const tokenCost = (entry: Entry, parts: Parts, usage: Usage): number => {
  const rates = ratesFor(entry, parts.input + parts.read + parts.w5 + parts.w1, usage)
  return (parts.input * rates.input + parts.read * rates.cacheHit + parts.w5 * rates.write5m + parts.w1 * rates.write1h + parts.out * rates.output) / M
}

/**
 * Estimated dollars for one request's top-level usage, or null when the id is not in the table.
 * The advisor iterations are not in it: the engine leaves them out of the top-level usage too (see advisorCost).
 */
export const estimate = (usage: Usage, model: string): number | null => {
  const entry = entryOf(model)
  if (entry === null) return null
  if (entry === ZERO) return 0
  return tokenCost(entry, partsOf(usage), usage) + count(usage.server_tool_use?.web_search_requests) * WEB_SEARCH_USD
}

/** Dollars, and whether a part of the request had no price (an id the table lacks). */
export type StepCost = { usd: number; unknown: boolean }

/** The `advisor_message` entries of `usage.iterations`, each at its own model's rates; an entry on an unknown model adds $0 and sets `unknown`. */
const advisorSum = (usage: Usage): StepCost => {
  const sum: StepCost = { usd: 0, unknown: false }
  if (!Array.isArray(usage.iterations)) return sum
  for (const item of usage.iterations as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const it = item as Usage & { type?: unknown; model?: unknown }
    if (it.type !== 'advisor_message') continue
    const entry = typeof it.model === 'string' ? entryOf(it.model) : null
    if (entry === null) sum.unknown = true
    else sum.usd += tokenCost(entry, partsOf(it), { ...it, inference_geo: usage.inference_geo })
  }
  return sum
}

/**
 * Tokens of the `advisor_message` entries of `usage.iterations` (input, output, cache read and cache write), the same entries
 * advisorCost() prices, with the same guards. A run shows these with its top-level tokens, because its dollars include both.
 */
export const advisorTokens = (usage: Usage): number => {
  if (!Array.isArray(usage.iterations)) return 0
  let sum = 0
  for (const item of usage.iterations as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const it = item as Usage & { type?: unknown }
    if (it.type !== 'advisor_message') continue
    sum += count(it.input_tokens) + count(it.output_tokens) + count(it.cache_read_input_tokens) + count(it.cache_creation_input_tokens)
  }
  return sum
}

/**
 * Dollars for the `advisor_message` entries of `usage.iterations`, each at its own model's rates.
 * An entry whose model is not in the table adds nothing. The caller adds this to estimate() where it wants the advisor in.
 */
export const advisorCost = (usage: Usage): number => advisorSum(usage).usd

/**
 * One request in full: estimate() of its top-level usage plus advisorCost(). A model id with no price adds $0 and sets
 * `unknown`, so a caller can tell it from a real $0 (`<synthetic>`). Never throws: a usage that breaks pricing is $0 and unknown.
 */
export const stepCost = (usage: Usage, model: string): StepCost => {
  try {
    const main = estimate(usage, model)
    const advisor = advisorSum(usage)
    return { usd: (main ?? 0) + advisor.usd, unknown: main === null || advisor.unknown }
  } catch {
    return { usd: 0, unknown: true }
  }
}

/**
 * What re-sending `tokens` of context costs when the cache is cold: a cache write, at the 1-hour
 * rate when the session caches for an hour (a subscription), else the 5-minute rate.
 */
export const coldCost = (tokens: number, model: string, oneHour = false): number | null => {
  const entry = entryOf(model)
  if (entry === null) return null
  const n = count(tokens)
  const rates = ratesFor(entry, n, { input_tokens: 0, output_tokens: 0 })
  return (n * (oneHour ? rates.write1h : rates.write5m)) / M
}

/**
 * What the prompt cache saved on one request's input side, against the same request uncached:
 * each token read costs the cache-read rate, not the input rate, less the premium paid on each
 * token written. Negative on a request that only wrote. Null when the id is not in the table.
 * A usage with a 5m/1h split uses it; without one, `oneHour` says which rate the whole write paid.
 */
export const cacheSaving = (usage: Usage, model: string, oneHour = false): number | null => {
  const entry = entryOf(model)
  if (entry === null) return null
  const parts = partsOf(usage, oneHour)
  const rates = ratesFor(entry, parts.input + parts.read + parts.w5 + parts.w1, usage)
  const saved = parts.read * (rates.input - rates.cacheHit)
  const premium = parts.w5 * (rates.write5m - rates.input) + parts.w1 * (rates.write1h - rates.input)
  return (saved - premium) / M
}

/** What the same context costs warm: a cache read. */
export const warmCost = (tokens: number, model: string): number | null => {
  const entry = entryOf(model)
  if (entry === null) return null
  const n = count(tokens)
  return (n * ratesFor(entry, n, { input_tokens: 0, output_tokens: 0 }).cacheHit) / M
}

export const fmtUsd = (usd: number): string => `$${usd.toFixed(2)}`

/** "38k", "1.2M": compact token counts for cards and chips. */
export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
