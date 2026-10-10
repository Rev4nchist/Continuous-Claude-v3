import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { AgentRun, HudState } from '../../types'
import { addStep } from '../agent-ledger/model'
import { advisorFrom } from './model'
import type { KillSwitch } from './model'

// HUD capture. The agentic-os band draws the row from this atom (declared there under the same key).
// Interactive sessions only: a headless run has no band to read it.

const hud = atom({ plugin: 'ccv3-mods', key: 'hud' } as const, null as HudState | null)
/** The Agent Ledger's runs (hooks/agent-ledger): this file's turn.step hook adds each subagent request. */
const agentRuns = atom({ plugin: 'ccv3-mods', key: 'agentRuns' } as const, [] as AgentRun[])

/** CCV3_MODS_OFF=1 turns every mod off; CCV3_MOD_HUD_OFF=1 this one. Off, the atom stays null. */
const isOff = async ($: EngineInterface): Promise<boolean> =>
  (await $.env.get('CCV3_MODS_OFF')) === '1' || (await $.env.get('CCV3_MOD_HUD_OFF')) === '1'

/** The kill switches that are set. `$.env.get` takes literals only, so each is spelled out. */
const setSwitches = async ($: EngineInterface): Promise<KillSwitch[]> => {
  const set: KillSwitch[] = []
  const on = (value: string | undefined) => value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
  if (on(await $.env.get('CLAUDE_CODE_DISABLE_ADVISOR_TOOL'))) set.push('CLAUDE_CODE_DISABLE_ADVISOR_TOOL')
  if (on(await $.env.get('DISABLE_TELEMETRY'))) set.push('DISABLE_TELEMETRY')
  if (on(await $.env.get('DISABLE_GROWTHBOOK'))) set.push('DISABLE_GROWTHBOOK')
  if (on(await $.env.get('DO_NOT_TRACK'))) set.push('DO_NOT_TRACK')
  if (on(await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))) set.push('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
  return set
}

const start = async ($: EngineInterface): Promise<void> => {
  if (await isOff($)) return
  const settings = await $.settings.read().catch(() => ({}) as Record<string, unknown>)
  const advisor = advisorFrom(settings.advisorModel, await setSwitches($))
  const model = await $.session.model().catch(() => null)
  const usage = await $.session.usage().catch(() => null)
  await update($, hud, () => ({
    model,
    effort: null,
    advisor,
    costUsd: usage?.cost?.usd ?? null,
    limits: (usage?.rateLimits ?? []).map(({ kind, percentUsed }) => ({ kind, percentUsed })),
  }))
}

export const hudCapture = (on: On) => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await start($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The plugin's one turn.step hook. A subagent's request feeds its Agent Ledger run; a main-loop request the HUD.
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (agentId !== undefined) {
      const result = yield* next(e)
      try {
        const effort = typeof e.effort === 'string' ? e.effort : null
        // No run (ledger off, or a spawn this plugin never saw): leave the list as it is.
        if ((await read($, agentRuns)).some(run => run.id === agentId)) {
          await update($, agentRuns, runs =>
            runs.map(run => (run.id === agentId ? addStep(run, { model: e.model, effort, usage: result.usage }) : run)),
          )
        }
      } catch {
        // Observer only.
      }
      return result
    }
    if ((await read($, hud)) === null) return yield* next(e)
    const result = yield* next(e)
    try {
      // The model that answered (a fallback or a lower hook may have changed the one asked for).
      const model = result.usage?.model ?? e.model
      // A numeric effort is a thinking budget, not a level: the chip shows no effort then.
      const effort = typeof e.effort === 'string' ? e.effort : null
      // An advisor use proves the advisor is on, whatever the settings and env said at start.
      const advised = (result.serverToolUses ?? []).filter(use => use.name === 'advisor').length
      await update($, hud, now =>
        now === null
          ? now
          : {
              ...now,
              model,
              effort,
              advisor:
                advised > 0
                  ? { state: 'on' as const, ...(now.advisor.model === undefined ? {} : { model: now.advisor.model }), calls: now.advisor.calls + advised }
                  : now.advisor,
            },
      )
    } catch {
      // Observer only: a failed update never touches the request.
    }
    return result
  })

  // session.measure (cost, limits) is handled in agentic-os/index.tsx: a plugin holds one unmatched hook per event.

}
