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
      costUsd: usage.cost?.usd ?? null,
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
