import { clip, elapsed } from './model'
import type { OsView } from './model'

/** A colour role; the render maps each to theme props, so light and dark both work. */
export type Tone =
  | 'title' | 'head' | 'active' | 'done' | 'todo' | 'dim' | 'ok' | 'warn' | 'bad' | 'chip' | 'track'
  /** HUD: the model chip when effort is below the high pin, and the advisor. */
  | 'chipBad' | 'advisor'
  /** Band (band-model.ts), after the mockup: working is a blue chip (`chipDoing`) and a doing plan cell is blue (`doing`); waiting-on-dave amber, done green, idle grey, blocked `chipBad`. */
  | 'chipDoing' | 'doing' | 'chipWarn' | 'chipOk' | 'chipDim'
  /** Agent Ledger: a Sonnet tier badge. */
  | 'sonnetTier'
  /** Skin diff lines. */
  | 'diffAdd' | 'diffDel'

/** A run of text in one tone. */
export type Span = { text: string; tone: Tone }

/** One drawn line: spans on the left, an optional right-aligned group. */
export type PaneRow = { key: string; left: Span[]; right?: Span[] }

const sp = (text: string, tone: Tone): Span => ({ text, tone })

const width = (spans: Span[] = []) => spans.reduce((n, s) => n + s.text.length, 0)

/** Clips the left spans so left, a one-cell gap and right fit `columns`. */
export const fit = (row: PaneRow, columns: number): PaneRow => {
  let room = Math.max(4, columns - (row.right ? width(row.right) + 1 : 0))
  const left: Span[] = []
  for (const span of row.left) {
    if (room <= 0) break
    const text = clip(span.text, room)
    left.push({ ...span, text })
    room -= text.length
  }
  return { ...row, left }
}

/** A text gauge: `filled` cells in `tone`, the rest as an empty track. */
export const bar = (fraction: number, cells: number, tone: Tone, glyphs = ['█', '░']): Span[] => {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * cells)
  return [sp((glyphs[0] ?? '█').repeat(filled), tone), sp((glyphs[1] ?? '░').repeat(cells - filled), 'track')]
}

/** Green under half full, amber to three quarters, red past that. */
export const gaugeTone = (percent: number): Tone => (percent < 50 ? 'ok' : percent < 75 ? 'warn' : 'bad')

/** A watched PR a person or the model must look at: rate limited, reviewed with findings, or no review. */
const attention = (state: string | null): boolean => state === 'LIMITED' || state === 'REVIEWED' || state === 'STALLED' || state === 'PROOF'

export const head = (key: string, label: string, right?: Span[]): PaneRow => ({
  key,
  left: [sp(label, 'head')],
  ...(right ? { right } : {}),
})

export const gap = (key: string): PaneRow => ({ key, left: [sp(' ', 'dim')] })

/** The band's widget row spans: the active task, the running step (or the turn clock), PRs, agents. No plan title, no plan bar, no ctx (design 2026-11-18). */
export const bandSpans = (view: OsView, nowMs: number, columns: number, agentsPart: Span[] | null = null): Span[] => {
  const parts: Span[][] = []
  const active = view.tasks.find(task => task.status === 'in_progress')
  if (active) parts.push([sp('▶ ', 'active'), sp(active.activeForm ?? active.subject, 'active')])
  if (view.step) parts.push([sp(`${view.step.tool} ${view.step.label}`.trim(), 'dim'), sp(` ${elapsed(nowMs - view.step.startedAt)}`, 'dim')])
  else if (view.turn) parts.push([sp(`◌ ${elapsed(nowMs - view.turn.startedAt)}`, 'dim')])
  if (view.prs.length) parts.push([sp(`PR ${view.prs.map(one => `#${one.pr}${attention(one.state) ? '!' : ''}`).join(' ')}`, view.prs.some(one => attention(one.state)) ? 'warn' : 'dim')])
  if (agentsPart) parts.push(agentsPart)
  const joined = parts.flatMap((part, i) => (i ? [sp(' · ', 'track'), ...part] : part))
  return fit({ key: 'band', left: joined }, Math.max(10, columns)).left
}
