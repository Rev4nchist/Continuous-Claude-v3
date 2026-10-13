// Prompt-cache use of the main loop, pure: the reducer hooks/hud/index.ts feeds per request, the HUD
// element the band draws, and the /cache report.

import type { CacheMiss, CacheMissCause, CacheState } from '../../types'
import type { Tone } from '../agentic-os/pane-model'
import { cacheSaving, coldCost, fmtTokens, fmtUsd } from '../shared/price'
import type { Usage } from '../shared/price'

export const EMPTY_CACHE: CacheState = {
  requests: 0,
  input: 0,
  read: 0,
  write: 0,
  savedUsd: 0,
  contextTokens: null,
  cachedTokens: null,
  lastUsedAt: null,
  lastModel: null,
  lastTurnId: null,
  compacted: false,
  ttlMin: 60,
  oneHour: true,
  misses: [],
  missCount: 0,
}

/** Misses kept for /cache; `missCount` still counts the ones dropped. */
export const MISS_CAP = 30
/** A session's first request that carries more messages than this continues an older conversation. */
const FRESH_MESSAGES = 2
const MIN = 60_000

/** A subscription reports its own rate-limit windows; a gateway's `spend_limit` is not one. */
export const isSubscription = (limitKinds: readonly string[]): boolean => limitKinds.some(kind => kind === 'five_hour' || kind === 'seven_day')

/**
 * Minutes the prompt cache keeps an entry after a reply: an hour on a subscription, five minutes
 * on an API key. `CCV3_CACHE_TTL_MIN` overrides both. The API reports no lifetime per request, so
 * this is a rule, not a reading.
 */
export const ttlMinutes = (override: string | undefined, subscription: boolean): number => {
  const n = override === undefined || override.trim() === '' ? NaN : Number(override)
  if (Number.isFinite(n) && n > 0) return n
  return subscription ? 60 : 5
}

/** A whole percentage of the window, as the engine rounds its own. */
export const percentOf = (tokens: number, window: number): number | null =>
  window > 0 ? Math.min(100, Math.max(0, Math.round((100 * tokens) / window))) : null

export type CacheRequest = {
  usage: Usage & { model: string }
  /** The request's prompt size as the engine counts the window; null falls back to the usage sum. */
  contextTokens: number | null
  /** When the request was sent, and when its reply was whole. */
  sentAt: number
  at: number
  turnId: string
  /** Messages the request carried: a first request with a history is a resume. */
  messageCount: number
  ttlMin: number
  /** Writes are 1-hour entries (a subscription): the rate a rewrite is priced at. */
  oneHour: boolean
}

const causeOf = (state: CacheState, req: CacheRequest, idleMs: number): CacheMissCause => {
  if (state.requests === 0) return req.messageCount > FRESH_MESSAGES ? 'resume' : 'start'
  if (idleMs > state.ttlMin * MIN) return 'expired'
  if (state.compacted) return 'compaction'
  if (state.lastModel !== req.usage.model) return 'model'
  return 'changed'
}

/**
 * Folds one main-loop request into the state. A miss: the cache served under half of the prompt it
 * held before (the smaller of the last prompt and this one, so a compacted prompt is not held to
 * the old size). The first request has no "before": it is a miss when it wrote more than it read.
 * A request that neither read nor wrote ran with caching off: no miss. Limit: a server-side tool
 * loop reports one summed usage, so a miss between two responses of one request is not seen.
 */
export const addRequest = (state: CacheState, req: CacheRequest): CacheState => {
  const read = req.usage.cache_read_input_tokens ?? 0
  const write = req.usage.cache_creation_input_tokens ?? 0
  const used = read + write > 0
  const size = req.contextTokens ?? req.usage.input_tokens + read + write
  // Only what the cache held can be rewritten: uncached input was never in it.
  const held = state.cachedTokens === null ? null : Math.min(state.cachedTokens, size)
  // What it held and did not serve, and no more than this request wrote.
  const rewritten = held === null ? write : Math.min(Math.max(0, held - read), write)
  // A request that wrote nothing rewrote nothing, so caching switched off is never a miss.
  const isMiss = held === null ? write > read : rewritten > held / 2
  // The gap the entry had to live through: from the send that last used the cache to this send.
  const idleMs = state.lastUsedAt === null ? 0 : Math.max(0, req.sentAt - state.lastUsedAt)
  const miss: CacheMiss | null = isMiss
    ? { at: req.at, idleMs, rewritten, cause: causeOf(state, req, idleMs), model: req.usage.model, turnId: req.turnId, usd: coldCost(rewritten, req.usage.model, req.oneHour) }
    : null
  return {
    requests: state.requests + 1,
    input: state.input + req.usage.input_tokens,
    read: state.read + read,
    write: state.write + write,
    savedUsd: state.savedUsd + (cacheSaving(req.usage, req.usage.model, req.oneHour) ?? 0),
    contextTokens: size,
    // A request that neither read nor wrote leaves the entry, and its clock, as they were.
    cachedTokens: used ? Math.min(read + write, size) : state.cachedTokens,
    lastUsedAt: used ? req.sentAt : state.lastUsedAt,
    lastModel: req.usage.model,
    lastTurnId: req.turnId,
    compacted: false,
    ttlMin: req.ttlMin,
    oneHour: req.oneHour,
    misses: miss === null ? state.misses : [...state.misses, miss].slice(-MISS_CAP),
    missCount: state.missCount + (miss === null ? 0 : 1),
  }
}

/** Share of all input tokens the cache served, 0 to 100, unrounded; null before the first request. */
export const hitRate = (state: CacheState): number | null => {
  const total = state.input + state.read + state.write
  return total === 0 ? null : (100 * state.read) / total
}

/**
 * The cache as the HUD shows it now. `off`: no request read or wrote the cache. `cold`: idle past
 * the lifetime, so the next send rewrites the whole prompt (`coldUsd` prices it). `miss`: a request
 * of the newest turn rewrote `missTokens`; a fresh session's first request is not flagged. Else
 * `warm`, with the minutes the entry still has.
 */
export type CacheView =
  | { status: 'off' }
  | { status: 'warm'; hitPct: number; minutesLeft: number; isLow: boolean }
  | { status: 'miss'; hitPct: number; missTokens: number }
  | { status: 'cold'; hitPct: number; coldUsd: number | null }

export const cacheView = (state: CacheState, now: number): CacheView | null => {
  const rate = hitRate(state)
  if (rate === null) return null
  if (state.read + state.write === 0) return { status: 'off' }
  if (state.lastUsedAt === null) return null
  const hitPct = Math.round(rate)
  // From the send, not the reply: the API refreshes the entry when the request reads it.
  const leftMs = state.ttlMin * MIN - (now - state.lastUsedAt)
  if (leftMs <= 0) {
    const coldUsd = state.cachedTokens === null || state.lastModel === null ? null : coldCost(state.cachedTokens, state.lastModel, state.oneHour)
    return { status: 'cold', hitPct, coldUsd }
  }
  const last = state.misses.at(-1)
  if (last !== undefined && last.turnId === state.lastTurnId && last.cause !== 'start') return { status: 'miss', hitPct, missTokens: last.rewritten }
  // The last tenth of the lifetime reads as low: six minutes of an hour, thirty seconds of five minutes.
  return { status: 'warm', hitPct, minutesLeft: Math.ceil(leftMs / MIN), isLow: leftMs * 10 <= state.ttlMin * MIN }
}

/** The HUD element's text and tone. */
export const cacheLabel = (view: CacheView): { text: string; tone: Tone } => {
  if (view.status === 'off') return { text: 'cache off', tone: 'warn' }
  if (view.status === 'cold') return { text: view.coldUsd === null ? 'cache COLD' : `cache COLD · next ≈${fmtUsd(view.coldUsd)}`, tone: 'warn' }
  if (view.status === 'miss') return { text: `cache ${view.hitPct}% · MISS ${fmtTokens(view.missTokens)}`, tone: 'warn' }
  return { text: `cache ${view.hitPct}% · ${view.minutesLeft}m`, tone: view.isLow ? 'warn' : 'todo' }
}

const span = (ms: number): string => {
  const min = Math.floor(Math.max(0, ms) / MIN)
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`
}

const CAUSE_LABEL: Record<CacheMissCause, string> = {
  start: 'session start',
  resume: 'resume',
  expired: 'expired',
  compaction: 'compaction',
  model: 'model change',
  changed: 'prompt changed',
}

const stateLine = (state: CacheState, view: CacheView): string => {
  if (view.status === 'off') return 'off: no request read or wrote the cache'
  if (view.status === 'cold') {
    const cost = view.coldUsd === null ? '' : `: the next send rewrites ${fmtTokens(state.cachedTokens ?? 0)} tokens, ≈ ${fmtUsd(view.coldUsd)}`
    return `cold (keeps ${state.ttlMin} min)${cost}`
  }
  if (view.status === 'miss') return `warm, the newest turn rewrote ${fmtTokens(view.missTokens)} tokens (keeps ${state.ttlMin} min)`
  return `warm, ${view.minutesLeft} min left (keeps ${state.ttlMin} min)`
}

/** What /cache prints: the totals, the state now, and each miss with its idle gap, size and cause. */
export const cacheReport = (state: CacheState, now: number): string => {
  const view = cacheView(state, now)
  const rate = hitRate(state)
  if (view === null || rate === null) return 'Cache: no main-loop request yet this session.'
  const pad = (text: string, width: number) => text.padEnd(width)
  // A session that has only written so far has paid the write premium and saved nothing yet.
  const saved = `${state.savedUsd < 0 ? '-' : ''}${fmtUsd(Math.abs(state.savedUsd))}`
  const lines = [
    'Cache, this session (main loop)',
    `  requests      ${state.requests}`,
    `  hit rate      ${rate.toFixed(1)}%`,
    `  read / write  ${fmtTokens(state.read)} / ${fmtTokens(state.write)} tokens`,
    `  saved         ≈ ${saved} (list price, estimate)`,
    `  state         ${stateLine(state, view)}`,
    '',
    `Misses (${state.missCount})`,
  ]
  if (state.missCount > state.misses.length) lines.push(`  the newest ${state.misses.length} are listed`)
  for (const miss of state.misses) {
    const cost = miss.usd === null ? '' : `≈ ${fmtUsd(miss.usd)}`
    lines.push(
      `  ${pad(`${span(now - miss.at)} ago`, 12)} ${pad(`idle ${span(miss.idleMs)}`, 13)} ${pad(`rewrote ${fmtTokens(miss.rewritten)}`, 14)} ${pad(CAUSE_LABEL[miss.cause], 15)} ${cost}`.trimEnd(),
    )
  }
  return lines.join('\n')
}
