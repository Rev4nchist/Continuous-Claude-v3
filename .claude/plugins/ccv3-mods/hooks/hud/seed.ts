import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { HudState } from '../../types'
import { advisorFrom } from './model'
import type { KillSwitch } from './model'

// The HUD's start, run again when it never ran. A session that resumes, or a reload that skips session.start, leaves the
// hud atom null and the band without its HUD row (Dave's screenshot 8). A band render, session.measure and turn.step
// seed it once from the model, the settings (advisor) and the usage (cost, limits).
// Function declarations, not arrows: the engine follows $ past an import only into a declaration.

const hud = atom({ plugin: 'ccv3-mods', key: 'hud' } as const, null as HudState | null)
/** Written by hooks/agentic-os (same key). */
const mode = atom({ plugin: 'ccv3-mods', key: 'mode' } as const, 'interactive' as 'interactive' | 'headless')

/**
 * What the last good read gave. A render cannot write state (the host denies it), so it draws from this and the next
 * handler (session.measure, turn.step) moves it into the atom. It keeps the model, settings and usage from being read twice.
 */
let seeded: HudState | null = null
/**
 * Set when a conversation ends in this process, cleared at the next one's first reply (see forgetSeedCost). An atom, not a
 * module variable: a plugin reload drops module state but keeps atoms, and the reload re-runs start() before any measure.
 */
let endedHere = false
const costForgotten = atom({ plugin: 'ccv3-mods', key: 'costForgotten' } as const, false)

/**
 * A conversation ended in this process (/clear, an in-session resume). The engine leaves the hud atom null then, and the next
 * render or handler re-seeds it from `seeded`, whose cost is the old conversation's or the startup $0.00. Limits are
 * account-wide and stay. The new conversation shows no cost until its first session.measure writes one.
 * Never throws: reset() goes on to the counts and the context figure.
 */
export async function forgetSeedCost($: EngineInterface): Promise<void> {
  endedHere = true
  if (seeded !== null) seeded = { ...seeded, costUsd: null }
  try {
    await update($, costForgotten, () => true)
  } catch {
    // Observer only.
  }
}

/**
 * The real engine resets the plugin's atoms after session.end (E2E 2026-10-30), wiping the flag forgetSeedCost wrote.
 * classic.SessionStart follows in the same process, so it writes the flag again. Only after a conversation ended here:
 * a resume at launch has none, and its cost shows at once. Never throws.
 */
export async function reassertCostForgotten($: EngineInterface): Promise<void> {
  if (!endedHere) return
  try {
    await update($, costForgotten, () => true)
  } catch {
    // Observer only.
  }
}

/** True from forgetSeedCost until the new conversation's first reply: usage() may still hold the old cost. Never throws. */
export async function isCostForgotten($: EngineInterface): Promise<boolean> {
  // The module flag covers the gap after session.end, where the engine has wiped the atom and classic.SessionStart has not
  // written it again; the atom covers a reload, which drops the module flag.
  return endedHere || (await read($, costForgotten).catch(() => false))
}

/**
 * The new conversation's first reply is in: usage() is its own now, so a seed or a re-run start may show its cost.
 * Called by the main-loop turn.step only, after the response, so a reload before that reply still sees the flag.
 */
export async function costShownAgain($: EngineInterface): Promise<void> {
  endedHere = false
  try {
    if (await read($, costForgotten)) await update($, costForgotten, () => false)
  } catch {
    // Observer only.
  }
}

/** The kill switches that are set. `$.env.get` takes literals only, so each is spelled out. */
export async function setSwitches($: EngineInterface): Promise<KillSwitch[]> {
  const set: KillSwitch[] = []
  const on = (value: string | undefined) => value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
  if (on(await $.env.get('CLAUDE_CODE_DISABLE_ADVISOR_TOOL'))) set.push('CLAUDE_CODE_DISABLE_ADVISOR_TOOL')
  if (on(await $.env.get('DISABLE_TELEMETRY'))) set.push('DISABLE_TELEMETRY')
  if (on(await $.env.get('DISABLE_GROWTHBOOK'))) set.push('DISABLE_GROWTHBOOK')
  if (on(await $.env.get('DO_NOT_TRACK'))) set.push('DO_NOT_TRACK')
  if (on(await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))) set.push('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
  return set
}

/** The HUD as the session start would build it, or null: HUD off, headless run, or a model or usage read that threw (no half HUD). */
async function readHud($: EngineInterface): Promise<HudState | null> {
  try {
    if ((await $.env.get('CCV3_MODS_OFF')) === '1' || (await $.env.get('CCV3_MOD_HUD_OFF')) === '1') return null
    if ((await read($, mode)) !== 'interactive') return null
    if (seeded !== null) return seeded
    const settings = await $.settings.read().catch(() => ({}) as Record<string, unknown>)
    const advisor = advisorFrom(settings.advisorModel, await setSwitches($))
    const model = await $.session.model()
    const usage = await $.session.usage()
    seeded = {
      model,
      effort: null,
      advisor,
      costUsd: (await isCostForgotten($)) ? null : (usage.cost?.usd ?? null),
      limits: usage.rateLimits.map(({ kind, percentUsed }) => ({ kind, percentUsed })),
    }
    return seeded
  } catch {
    // Observer only: the band goes on without a HUD row, and the next call tries again.
    return null
  }
}

/** For a render, which cannot write state: the hud atom, else a seed read once. Never throws. */
export async function hudOrSeed($: EngineInterface): Promise<HudState | null> {
  const now = await read($, hud)
  return now !== null ? now : readHud($)
}

/** For a handler: fills a null hud atom from the seed. Never throws; nothing when the HUD is off or the run is headless. */
export async function seedHud($: EngineInterface): Promise<void> {
  try {
    if ((await read($, hud)) !== null) return
    const fresh = await readHud($)
    // A start that ran meanwhile wins.
    if (fresh !== null) await update($, hud, now => now ?? fresh)
  } catch {
    // Observer only.
  }
}
