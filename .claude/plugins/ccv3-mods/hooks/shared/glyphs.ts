// Svg sources for the desktop (and vscode, mobile) surfaces. Pure. The terminal draws no Svg:
// its fallback is the text gauges in agentic-os/pane-model.ts (`bar`, `gaugeTone`).

const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0))

const RING_C = 2 * Math.PI * 15

/** An 18 px context ring, `percent` 0-100 of the circle filled in `color` over `track`. */
export const ringSvg = (percent: number, color: string, track: string): string => {
  const filled = (RING_C * clamp01(percent / 100)).toFixed(1)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 36 36">` +
    `<circle cx="18" cy="18" r="15" fill="none" stroke="${track}" stroke-width="5"/>` +
    `<circle cx="18" cy="18" r="15" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" ` +
    `stroke-dasharray="${filled} ${RING_C.toFixed(1)}" transform="rotate(-90 18 18)"/></svg>`
  )
}

/** A 56×6 rounded bar, `fraction` 0-1 filled. */
export const barSvg = (fraction: number, color: string, track: string): string => {
  const w = Math.round(clamp01(fraction) * 56)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="6" viewBox="0 0 56 6">` +
    `<rect x="0" y="0" width="56" height="6" rx="3" fill="${track}"/>` +
    `<rect x="0" y="0" width="${w}" height="6" rx="3" fill="${color}"/></svg>`
  )
}

/** Stroke icons (24 px grid paths) by tool family, drawn at 14 px. */
export const ICON_PATHS = {
  read: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  shell: 'M4 17l6-6-6-6M12 19h8',
  agent: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21a8 8 0 0 1 16 0',
  advisor: 'M12 3l2.6 5.6L20 9.5l-4 4 1 5.5-5-2.7-5 2.7 1-5.5-4-4 5.4-.9z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  other: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
} as const

export type IconName = keyof typeof ICON_PATHS

export const iconSvg = (name: IconName, color: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ` +
  `stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON_PATHS[name]}"/></svg>`

/** One-character stand-ins for the icons on the terminal. */
export const ICON_GLYPH: Record<IconName, string> = {
  read: '◇',
  edit: '✎',
  search: '⌕',
  shell: '›',
  agent: '◉',
  advisor: '✦',
  folder: '▸',
  other: '•',
}
