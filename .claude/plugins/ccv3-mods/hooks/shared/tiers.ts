// Model tiers for the HUD, the Agent Ledger and the skin. Pure: no `$`, no atoms.
// Policy source: .claude/rules-src/agent-model-selection.md (two tiers, never Haiku, effort high).

export type Tier = 'opus' | 'sonnet' | 'fable' | 'haiku' | 'other'

/** A model id (alias, full id, provider-prefixed) to its tier. Mythos shares Fable's tier. */
export const tierOf = (model: string): Tier => {
  const id = model.toLowerCase()
  if (id.includes('fable') || id.includes('mythos')) return 'fable'
  if (id.includes('opus')) return 'opus'
  if (id.includes('sonnet')) return 'sonnet'
  if (id.includes('haiku')) return 'haiku'
  return 'other'
}

export const TIER_LABEL: Record<Tier, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  fable: 'Fable',
  haiku: 'Haiku',
  other: 'Model',
}

/** Theme keys, so text follows the person's light or dark theme. */
export const TIER_KEY: Record<Tier, 'claude' | 'suggestion' | 'merged' | 'error' | 'subtle'> = {
  opus: 'claude',
  sonnet: 'suggestion',
  fable: 'merged',
  haiku: 'error',
  other: 'subtle',
}

/** Raw colors for Svg sources only (an Svg cannot read a theme key), dark first. */
export const TIER_HEX: Record<Tier, { dark: string; light: string }> = {
  opus: { dark: '#D97757', light: '#B85536' },
  sonnet: { dark: '#86AEE6', light: '#2D5FA3' },
  fable: { dark: '#AE9CEB', light: '#5E4BAE' },
  haiku: { dark: '#E5655B', light: '#B3392F' },
  other: { dark: '#857F75', light: '#7A766D' },
}

/** `model · effort`, e.g. "Opus · high"; the effort part is left off when unknown. */
export const tierBadge = (model: string, effort?: string | number): string =>
  typeof effort !== 'string' ? TIER_LABEL[tierOf(model)] : `${TIER_LABEL[tierOf(model)]} · ${effort}`

export type AgentSpec = { model?: string; effort?: string }

/** `model:` and `effort:` from an agent .md's leading frontmatter block; nothing from the body. */
export const parseAgentSpec = (md: string): AgentSpec => {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1]
  if (head === undefined) return {}
  const spec: AgentSpec = {}
  for (const line of head.split(/\r?\n/)) {
    const m = /^(model|effort):\s*["']?([\w.-]+)["']?\s*$/.exec(line)
    // `inherit` and `default` name no tier: the run takes the parent's or the session's model.
    if (m?.[1] === 'model' && m[2] !== 'inherit' && m[2] !== 'default') spec.model = m[2]
    if (m?.[1] === 'effort') spec.effort = m[2]
  }
  return spec
}

/**
 * Why a run breaks its agent's spec, or null when it doesn't. A Haiku run always breaks policy.
 * A side the spec leaves out is not checked.
 */
export const driftOf = (spec: AgentSpec, run: { model?: string; effort?: string | number }): string | null => {
  if (run.model !== undefined && tierOf(run.model) === 'haiku') return 'Haiku is banned'
  const tierOff = spec.model !== undefined && run.model !== undefined && tierOf(spec.model) !== tierOf(run.model)
  // A numeric effort is a thinking budget, not a level: it can't be compared with `high`.
  const effortOff = spec.effort !== undefined && typeof run.effort === 'string' && run.effort !== spec.effort
  if (!tierOff && !effortOff) return null
  const want = [spec.model === undefined ? null : TIER_LABEL[tierOf(spec.model)], spec.effort ?? null]
  return `expected ${want.filter(Boolean).join(' · ')}`
}
