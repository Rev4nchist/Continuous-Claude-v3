import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, TurnUsage } from 'claude-code'

import type { AgentRun, CacheState, HudState } from '../../types'
import { addStep } from '../agent-ledger/model'
import { DIAG_DIR, errorFile, errorText } from '../shared/diag'
import { EMPTY_CACHE, addRequest, afterCompaction, cacheReport, isSubscription, percentOf, ttlMinutes } from './cache'
import { advisorFrom } from './model'
import type { KillSwitch } from './model'

// HUD capture. The agentic-os band draws the row from these atoms (declared there under the same keys).
// The HUD row is for interactive sessions only: a headless run has no band to read it. The context
// figure and the cache counts are captured in every run, so the snapshot carries them.

const hud = atom({ plugin: 'ccv3-mods', key: 'hud' } as const, null as HudState | null)
/** Context %, also written by session.measure in agentic-os: this file moves it per request and at a compaction. */
const ctx = atom({ plugin: 'ccv3-mods', key: 'ctx' } as const, null as number | null)
/** Prompt-cache use of the main loop: the HUD's cache element and /cache. */
const cache = atom({ plugin: 'ccv3-mods', key: 'cache' } as const, EMPTY_CACHE as CacheState)
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

/**
 * After a main-loop request: the context figure and the cache counts. The engine raises
 * session.measure once per turn, so a turn of many requests would hold one context value; its own
 * figure is fresh as soon as the response is in (probe, 2026-10-13: `$.session.usage()` after
 * `next(e)` equals the request's input + cache read + cache write).
 */
type Step = { turnId: string; messageCount: number; sentAt: number | null }

const measureStep = async ($: EngineInterface, step: Step, usage: TurnUsage | null): Promise<void> => {
  if ((await $.env.get('CCV3_MODS_OFF')) === '1') return
  const session = await $.session.usage().catch(() => null)
  const percent = session?.context.percent
  if (percent !== undefined) await update($, ctx, () => percent)
  if (usage === null || (await $.env.get('CCV3_MOD_HUD_OFF')) === '1') return
  const at = await $.clock.now()
  const override = await $.env.get('CCV3_CACHE_TTL_MIN')
  const subscription = session === null ? null : isSubscription(session.rateLimits.map(limit => limit.kind))
  await update($, cache, now => {
    // A failed usage read says nothing about the account: the last request's rate, and so its lifetime, stand.
    const oneHour = subscription ?? now.oneHour
    return addRequest(now, { usage, contextTokens: session?.context.tokens ?? null, sentAt: step.sentAt ?? at, at, turnId: step.turnId, messageCount: step.messageCount, ttlMin: ttlMinutes(override, oneHour), oneHour })
  })
}

/** A new conversation in the same process (`/clear`, or another session resumed in its place): its counts start over. */
const reset = async ($: EngineInterface): Promise<void> => {
  if ((await $.env.get('CCV3_MODS_OFF')) === '1') return
  await update($, cache, () => EMPTY_CACHE)
  await update($, ctx, () => null)
}

const start = async ($: EngineInterface): Promise<void> => {
  if (await isOff($)) return
  await $.command
    .register({ name: 'cache', description: 'Prompt cache of this session: hit rate, tokens read and written, each miss and its cause' })
    .catch(async err => {
      const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
      if (home) await $.fs.write(`${home}/${DIAG_DIR}/${errorFile('cache-register')}`, errorText('cache-register', err)).catch(() => undefined)
    })
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

  // The desktop app drives Claude Code through the SDK: its sessions start headless and the desktop attaches later.
  on('session.attach', { surface: 'desktop' }, async ($, e, next) => {
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
    // Read before the request: the idle gap a cache entry lived through ends when the request is sent.
    const sentAt = await $.clock.now().catch(() => null)
    const result = yield* next(e)
    try {
      await measureStep($, { turnId: e.turnId, messageCount: e.messageCount, sentAt }, result.usage)
    } catch {
      // Observer only.
    }
    try {
      if ((await read($, hud)) === null) return result
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

  // A compaction of the main conversation empties the window: the old percent is wrong at once, and the
  // engine reports none until the next response. The size it recorded stands in until then. A `precompute`
  // installs nothing, and a subagent's compaction is not this window.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined && (await $.env.get('CCV3_MODS_OFF')) !== '1') {
        const after = result.tokensAfter
        const window = after === undefined ? undefined : (await $.session.usage().catch(() => null))?.context.window
        await update($, ctx, () => (after === undefined || window === undefined ? null : percentOf(after, window)))
        // The next request rewrites the compacted prompt: /cache names the cause, and a cold send is
        // priced at the new size.
        if ((await $.env.get('CCV3_MOD_HUD_OFF')) !== '1') {
          await update($, cache, now => afterCompaction(now, after))
        }
      }
    } catch {
      // Observer only: the compaction stands as the engine made it.
    }
    return result
  }).catch(($, e, next) => next(e))

  // `/clear` keeps the process and fires no session.start; `resume` puts another session in this one's place.
  // Either way the old conversation's counts and context figure are not the new one's.
  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await reset($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', { reason: 'resume' }, async ($, e, next) => {
    await reset($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Answers itself: no model turn. Registered at an interactive start; a headless `claude -p "/cache"` is not.
  on('command.run', { command: 'cache' }, async $ => ({ text: cacheReport(await read($, cache), await $.clock.now()) })).catch(() => ({
    text: '/cache failed.',
  }))

  // session.measure (cost, limits) is handled in agentic-os/index.tsx: a plugin holds one unmatched hook per event.
}
