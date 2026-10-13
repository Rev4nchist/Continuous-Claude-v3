// Cache Guard, pure: when the prompt cache is cold, and what the card says.

import type { CacheHold } from '../../types'
import { elapsed } from '../agentic-os/model'
import type { Span } from '../agentic-os/pane-model'
import { fmtTokens, fmtUsd } from '../shared/price'

/**
 * Minutes the prompt cache stays warm after a reply: an hour on a subscription (rate-limit windows
 * reported), five minutes on an API key. `CCV3_CACHE_TTL_MIN` overrides both.
 */
export const ttlMinutes = (override: string | undefined, isSubscription: boolean): number => {
  const n = override === undefined ? NaN : Number(override)
  if (Number.isFinite(n) && n >= 0) return n
  return isSubscription ? 60 : 5
}

/** Cold: the main loop has answered before, and longer ago than the TTL. */
export const isCold = (lastReplyAt: number | null, nowMs: number, ttlMin: number): boolean =>
  lastReplyAt !== null && nowMs - lastReplyAt > ttlMin * 60_000

const idle = (ms: number): string => {
  const min = Math.floor(ms / 60_000)
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : min > 0 ? `${min} min` : elapsed(ms)
}

/** The card's lines, top to bottom (the buttons are drawn after them). */
export const cardLines = (hold: CacheHold): Span[][] => {
  const cold = hold.coldUsd === null ? 'unknown' : `≈ ${fmtUsd(hold.coldUsd)}`
  const warm = hold.warmUsd === null ? 'unknown' : `≈ ${fmtUsd(hold.warmUsd)}`
  const tokens = hold.tokens === null ? 'the whole conversation' : `${fmtTokens(hold.tokens)} tokens`
  const preview = hold.text.replace(/\s+/g, ' ').trim()
  return [
    [{ text: 'Cache Guard · ', tone: 'warn' }, { text: `the cache went cold ${idle(hold.idleMs)} ago (keeps ${hold.ttlMin} min).`, tone: 'head' }],
    [
      { text: 'Cold send ', tone: 'dim' },
      { text: cold, tone: 'warn' },
      { text: ` re-writes ${tokens}`, tone: 'dim' },
      { text: '  ·  warm turn ', tone: 'dim' },
      { text: warm, tone: 'todo' },
      { text: '  ·  cheaper: /clear and resume from a handoff', tone: 'dim' },
    ],
    [{ text: 'Your message is back in the prompt box: press Enter to send it anyway. ', tone: 'head' }, { text: preview.length > 80 ? `${preview.slice(0, 79)}…` : preview, tone: 'dim' }],
  ]
}

export const DROP_REASON = 'Cache Guard: the prompt cache went cold. Your message is back in the prompt box; press Enter to send it anyway.'

/** A plain message: not a slash command, not a `!` shell line, and nothing attached (a re-send couldn't carry it). */
export const isPlainPrompt = (text: string, attachments: number): boolean => {
  const lead = text.trimStart()
  return attachments === 0 && !lead.startsWith('/') && !lead.startsWith('!') && lead !== ''
}
