// Price table for estimates the HUD, the Agent Ledger and Cache Guard show. Pure.
// Source: the claude-api skill's model table and shared/prompt-caching.md, read 2026-10-09
// (Claude Code 2.1.296). An estimate, never the bill: the HUD's session cost comes from
// $.session.usage(), which is the engine's own /cost ledger.

import { tierOf } from './tiers'
import type { Tier } from './tiers'

/** Dollars per million tokens. Haiku is its rate for prompts up to 100K tokens. */
type Rate = { input: number; output: number; cacheRead: number }

const RATES: Record<Tier, Rate | null> = {
  opus: { input: 4, output: 20, cacheRead: 0.2 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2 },
  fable: { input: 10, output: 50, cacheRead: 0.25 },
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01 },
  other: null,
}

/** A cache write costs 1.25× input for the 5-minute TTL (2× for 1 hour; not used here). */
const CACHE_WRITE = 1.25
const M = 1_000_000

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/** Estimated dollars for one usage record, or null when the model has no price here. */
export const estimate = (usage: Usage, model: string): number | null => {
  const rate = RATES[tierOf(model)]
  if (rate === null) return null
  return (
    (usage.input_tokens * rate.input +
      usage.output_tokens * rate.output +
      (usage.cache_read_input_tokens ?? 0) * rate.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * rate.input * CACHE_WRITE) /
    M
  )
}

/** What re-sending `tokens` of context costs when the cache is cold: a cache write. */
export const coldCost = (tokens: number, model: string): number | null => {
  const rate = RATES[tierOf(model)]
  return rate === null ? null : (tokens * rate.input * CACHE_WRITE) / M
}

/** What the same context costs warm: a cache read. */
export const warmCost = (tokens: number, model: string): number | null => {
  const rate = RATES[tierOf(model)]
  return rate === null ? null : (tokens * rate.cacheRead) / M
}

export const fmtUsd = (usd: number): string => `$${usd.toFixed(2)}`

/** "38k", "1.2M": compact token counts for cards and chips. */
export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
