// Tone -> theme props for every mod's Text, plus the Svg colours (Svg can't read theme keys). Pure.
import type { TextProps } from 'claude-code'

import type { Tone } from '../agentic-os/pane-model'

/** Theme keys only, so the pane follows the person's light or dark theme. */
export const TONE: Record<Tone, TextProps> = {
  title: { color: 'claude', bold: true },
  head: { bold: true },
  active: { color: 'claude', bold: true },
  done: { color: 'success' },
  todo: {},
  dim: { dimColor: true },
  ok: { color: 'success' },
  warn: { color: 'warning' },
  bad: { color: 'error' },
  chip: { color: 'inverseText', backgroundColor: 'claude', bold: true },
  track: { color: 'subtle' },
  chipBad: { color: 'inverseText', backgroundColor: 'error', bold: true },
  advisor: { color: 'merged' },
  sonnetTier: { color: 'suggestion', bold: true },
  diffAdd: { backgroundColor: 'diffAdded' },
  diffDel: { backgroundColor: 'diffRemoved' },
}

/** Svg can't read theme keys: one mid-tone per gauge tone that reads on light and dark. */
const SVG_HEX: Partial<Record<Tone, string>> = { ok: '#4E9A6A', warn: '#C9922E', bad: '#D9534F' }
export const SVG_TRACK = 'rgba(128,128,128,0.35)'
export const svgHex = (tone: Tone): string => SVG_HEX[tone] ?? '#D97757'
