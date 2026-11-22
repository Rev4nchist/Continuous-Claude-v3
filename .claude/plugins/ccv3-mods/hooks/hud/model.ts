// The HUD row, pure. The band in agentic-os/index.tsx draws it: Svg parts on desktop, text spans on the terminal.

import type { HudAdvisor, HudLimit, HudState } from '../../types'
import { cellWidth } from '../agentic-os/cells'
import { bar, gaugeTone } from '../agentic-os/pane-model'
import type { Span, Tone } from '../agentic-os/pane-model'
import { fmtUsd } from '../shared/price'
import { TIER_LABEL, tierOf } from '../shared/tiers'
import { cacheLabel } from './cache'
import type { CacheView } from './cache'

/** Env vars that keep the advisor off whatever `advisorModel` says (Claude Code env-vars docs). */
export const ADVISOR_KILL_SWITCHES = [
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  'DISABLE_TELEMETRY',
  'DISABLE_GROWTHBOOK',
  'DO_NOT_TRACK',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
] as const

export type KillSwitch = (typeof ADVISOR_KILL_SWITCHES)[number]

/** The advisor's state from the merged settings' `advisorModel` and the kill switches that are set. */
export const advisorFrom = (advisorModel: unknown, setSwitches: readonly KillSwitch[]): HudAdvisor => {
  const model = typeof advisorModel === 'string' && advisorModel !== '' && advisorModel !== 'off' ? advisorModel : undefined
  if (model === undefined) return { state: 'off', calls: 0 }
  const reason = setSwitches[0]
  return reason === undefined ? { state: 'on', model, calls: 0 } : { state: 'blocked', model, reason, calls: 0 }
}

/** Effort below the 2026-09-30 pin. `high`, `xhigh` and `max` are on policy; unknown is not flagged. */
export const effortDrift = (effort: string | null): boolean => effort === 'low' || effort === 'medium'

/** Rate-limit windows the HUD names, shortest first; others (spend limits) keep their own kind. */
const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

export const limitLabel = (limit: HudLimit): string => LIMIT_LABEL[limit.kind] ?? limit.kind.replace(/_/g, ' ')

/** One piece of the HUD row. A ring or bar is Svg on desktop and text on the terminal. */
export type HudPart =
  | { kind: 'chip'; key: string; text: string; tone: Tone }
  | { kind: 'text'; key: string; text: string; tone: Tone }
  | { kind: 'ring'; key: string; percent: number; label: string; tone: Tone }
  | { kind: 'bar'; key: string; percent: number; label: string; name: string; tone: Tone; short?: boolean }

const advisorLabel = (advisor: HudAdvisor): string => {
  if (advisor.state === 'off') return 'advisor off'
  const who = advisor.model === undefined ? 'advisor' : `${TIER_LABEL[tierOf(advisor.model)]} advisor`
  if (advisor.state === 'blocked') return `${who} blocked: ${advisor.reason ?? ''}`.trim()
  return advisor.calls > 0 ? `${who} calls ${advisor.calls}` : who
}

/**
 * The HUD row's parts, left to right: model chip, context, advisor, cost, cache, limits.
 * `skip` names parts another line already draws (their keys); the default is none, so a caller that passes nothing gets every part.
 */
export const hudParts = (hud: HudState, ctx: number | null, cache: CacheView | null = null, skip: readonly string[] = []): HudPart[] => {
  const parts: HudPart[] = []
  if (hud.model !== null) {
    const label = TIER_LABEL[tierOf(hud.model)]
    // Two short numbers, never a date: claude-opus-5-5 is "5.5", claude-opus-4-20250514 is "4".
    const version = /(\d+)(?:[-.](\d{1,2}))?(?!\d)/.exec(hud.model)
    const name = version ? `${label} ${version[1]}${version[2] === undefined ? '' : `.${version[2]}`}` : label
    // The red fill says the effort is below high; the text needs no "(not high)".
    const text = hud.effort === null ? name : `${name} · ${hud.effort}`
    parts.push({ kind: 'chip', key: 'hud-model', text, tone: effortDrift(hud.effort) ? 'chipBad' : 'chip' })
  }
  if (ctx !== null) parts.push({ kind: 'ring', key: 'hud-ctx', percent: ctx, label: `ctx ${ctx}%`, tone: gaugeTone(ctx) })
  const advisorTone: Tone = hud.advisor.state === 'on' ? 'advisor' : hud.advisor.state === 'blocked' ? 'warn' : 'dim'
  parts.push({ kind: 'text', key: 'hud-advisor', text: advisorLabel(hud.advisor), tone: advisorTone })
  if (hud.costUsd !== null) parts.push({ kind: 'text', key: 'hud-cost', text: `est ${fmtUsd(hud.costUsd)}`, tone: 'todo' })
  if (cache !== null) parts.push({ kind: 'text', key: 'hud-cache', ...cacheLabel(cache) })
  for (const limit of hud.limits) {
    const pct = Math.round(limit.percentUsed)
    const name = limitLabel(limit)
    parts.push({ kind: 'bar', key: `hud-limit-${limit.kind}`, percent: pct, label: `${name} ${pct}%`, name, tone: gaugeTone(pct) })
  }
  return parts.filter(part => !skip.includes(part.key))
}

/** The terminal's version of the row: rings and bars as text gauges. A bar in its short form has no gauge: `5h 41%`. */
export const hudSpans = (parts: HudPart[]): Span[] =>
  parts.flatMap((part, i): Span[] => {
    const lead: Span[] = i === 0 ? [] : [{ text: '  ', tone: 'track' }]
    if (part.kind === 'chip') return [...lead, { text: ` ${part.text} `, tone: part.tone }]
    if (part.kind === 'text') return [...lead, { text: part.text, tone: part.tone }]
    if (part.kind === 'ring') return [...lead, { text: part.label, tone: part.tone }]
    if (part.short === true) return [...lead, { text: `${part.name} `, tone: 'dim' }, { text: `${part.percent}%`, tone: 'dim' }]
    return [...lead, { text: `${part.name} `, tone: 'dim' }, ...bar(part.percent / 100, 4, part.tone, ['▰', '▱']), { text: ` ${part.percent}%`, tone: 'dim' }]
  })

const rowCells = (parts: HudPart[]): number => cellWidth(hudSpans(parts).map(span => span.text).join(''))
const RATE_KEYS = ['hud-limit-five_hour', 'hud-limit-seven_day']
const without = (parts: HudPart[], keys: readonly string[]): HudPart[] => parts.filter(part => !keys.includes(part.key))

/**
 * The terminal row, fitted to `width` cells. Pure; the desktop Svg path does not call it, so it keeps every part.
 * Parts drop whole, never cut, in Dave's order (design note, section 2): cache, advisor, cost, other limit kinds,
 * bars to the short form, the model chip, `7d`, `5h`. ctx always stays. Each step keeps what the one before it dropped,
 * so a dropped part does not return when a wider part goes.
 */
export const fitHudParts = (parts: HudPart[], width: number): HudPart[] => {
  const other = parts.filter(part => part.kind === 'bar' && !RATE_KEYS.includes(part.key)).map(part => part.key)
  const shorten = (list: HudPart[]): HudPart[] => list.map(part => (part.kind === 'bar' ? { ...part, short: true } : part))
  const steps: ((list: HudPart[]) => HudPart[])[] = [
    list => without(list, ['hud-cache']),
    list => without(list, ['hud-advisor']),
    list => without(list, ['hud-cost']),
    list => without(list, other),
    shorten,
    list => without(list, ['hud-model']),
    list => without(list, ['hud-limit-seven_day']),
    list => without(list, ['hud-limit-five_hour']),
  ]
  let row = parts
  for (const step of steps) {
    if (rowCells(row) <= width) break
    row = step(row)
  }
  return row
}
