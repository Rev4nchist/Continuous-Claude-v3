import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, TurnUsage } from 'claude-code'

import type { AgentRun, CacheState, HudState, OsBrief } from '../../types'
import { addStep } from '../agent-ledger/model'
import { mergeParsed, parseStep } from '../agentic-os/brief'
import { DIAG_DIR, errorFile, errorText } from '../shared/diag'
import { EMPTY_CACHE, addRequest, afterCompaction, cacheReport, isSubscription, ttlMinutes } from './cache'
import { advisorFrom } from './model'
import { costShownAgain, forgetSeedCost, isCostForgotten, reassertCostForgotten, seedHud, setSwitches } from './seed'

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

/** The session brief and the run mode, written by hooks/agentic-os (same keys): learnFromStep below fills the brief. */
const brief = atom({ plugin: 'ccv3-mods', key: 'brief' } as const, null as OsBrief | null)
const mode = atom({ plugin: 'ccv3-mods', key: 'mode' } as const, 'interactive' as 'interactive' | 'headless')

/** CCV3_MODS_OFF=1 turns every mod off; CCV3_MOD_HUD_OFF=1 this one. Off, the atom stays null. */
const isOff = async ($: EngineInterface): Promise<boolean> =>
  (await $.env.get('CCV3_MODS_OFF')) === '1' || (await $.env.get('CCV3_MOD_HUD_OFF')) === '1'

/**
 * After a main-loop request: the context figure and the cache counts. The engine raises
 * session.measure once per turn, so a turn of many requests would hold one context value; its own
 * figure is fresh as soon as the response is in (probe, 2026-10-13: `$.session.usage()` after
 * `next(e)` equals the request's input + cache read + cache write).
 */
type Step = { turnId: string; sentAt: number | null }

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
    return addRequest(now, { usage, contextTokens: session?.context.tokens ?? null, sentAt: step.sentAt ?? at, at, turnId: step.turnId, ttlMin: ttlMinutes(override, oneHour), oneHour })
  })
}

/**
 * A main-loop request answered: its restate line fills the session brief's goal and stop-at early in the turn.
 * Here, not in hooks/agentic-os: a plugin holds one unmatched turn.step hook. Same rules as the turn-end parse there:
 * a brief_set value stays (mergeParsed), and a headless run with no brief writes none. The snapshot follows at the turn end.
 */
const learnFromStep = async ($: EngineInterface, answer: unknown): Promise<void> => {
  try {
    if (typeof answer !== 'string' || (await $.env.get('CCV3_MODS_OFF')) === '1') return
    const parsed = parseStep(answer)
    if (!parsed.goal && !parsed.stopAt) return
    if ((await read($, brief)) === null && (await read($, mode)) !== 'interactive') return
    const at = await $.clock.now()
    await update($, brief, now => mergeParsed(now, parsed, at))
  } catch {
    // Observer only: a parser failure never touches the request.
  }
}

/**
 * A resumed or forked conversation reports no context until its first response, but classic.SessionStart
 * carries its transcript's size. That size stands in until the reply, which counts the last reply's output,
 * so it reads slightly high. Only the window comes from usage(): its percent may still be the old conversation's.
 * CCV3_MODS_OFF only, not isOff(): the figure is captured with the HUD off too.
 */
const seedCtx = async ($: EngineInterface, tokens: number): Promise<void> => {
  if ((await $.env.get('CCV3_MODS_OFF')) === '1') return
  const context = (await $.session.usage().catch(() => null))?.context
  if (context === undefined) return
  if (context.window > 0) await update($, ctx, () => Math.min(100, Math.round((tokens / context.window) * 100)))
}

/**
 * A new conversation in the same process (`/clear`, or another session resumed in its place): its counts,
 * context figure, advisor count and cost start over. The cost shows again at the next session.measure.
 * Both states of the hud atom happen. A set one is edited here, so the row keeps the last step's model and effort.
 * In the real engine (E2E 2026-10-30) it is already null by now: the next render or handler re-seeds it from the cached
 * seed, so forgetSeedCost() keeps the old conversation's cost, and the startup $0.00, out of that seed. It also sets the
 * "cost forgotten" atom, which a reload's start() reads (module state would not survive the reload); the first reply clears it.
 */
const reset = async ($: EngineInterface): Promise<void> => {
  if ((await $.env.get('CCV3_MODS_OFF')) === '1') return
  await forgetSeedCost($)
  await update($, cache, () => EMPTY_CACHE)
  await update($, ctx, () => null)
  await update($, hud, now => (now === null ? now : { ...now, costUsd: null, advisor: { ...now.advisor, calls: 0 } }))
}

const advisorOn = (model: string | undefined, calls: number) => ({ state: 'on' as const, ...(model === undefined ? {} : { model }), calls })

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
  // After /clear or a resume, usage() may still hold the old cost until the new conversation's first reply: show the dash.
  const costUsd = (await isCostForgotten($)) ? null : (usage?.cost?.usd ?? null)
  // A re-run start (reload, respawn, attach) keeps the advisor count and the effort (read here, so a step's increment is not lost)
  // but takes the advisor state from the settings as they are now: an advisor turned off or blocked since is not drawn "on".
  // reset() zeroes the count.
  await update($, hud, now => ({
    model,
    effort: now?.effort ?? null,
    advisor: { ...advisor, calls: now?.advisor.calls ?? 0 },
    costUsd,
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
    await learnFromStep($, result.answer)
    try {
      await measureStep($, { turnId: e.turnId, sentAt }, result.usage)
    } catch {
      // Observer only.
    }
    try {
      // A resumed session never ran the start above: seed the HUD here, then the step's own model and effort go over it.
      await seedHud($)
      // After the seed, so a seed made at this step still carries no cost; session.measure writes it next.
      // Only a step with usage: an aborted request measured no cost, and a reload after it would show the old one.
      if (result.usage) await costShownAgain($)
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
                  ? advisorOn(now.advisor.model, now.advisor.calls + advised)
                  : now.advisor,
            },
      )
    } catch {
      // Observer only: a failed update never touches the request.
    }
    return result
  })

  // A compaction of the main conversation empties the window: the old percent is wrong at once, and the
  // engine reports none until the next response. No figure stands in: the size the engine records at the
  // compaction (`tokensAfter`) is far below the next prompt (see afterCompaction), so the HUD shows no ctx
  // until that response. A `precompute` installs nothing, and a subagent's compaction is not this window.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined && (await $.env.get('CCV3_MODS_OFF')) !== '1') {
        await update($, ctx, () => null)
        // The next request rewrites the compacted prompt: /cache names the cause.
        if ((await $.env.get('CCV3_MOD_HUD_OFF')) !== '1') await update($, cache, afterCompaction)
      }
    } catch {
      // Observer only: the compaction stands as the engine made it.
    }
    return result
  }).catch(($, e, next) => next(e))

  // How the conversation began, in the engine's own word. A resumed or forked one sends a history the cache
  // may no longer hold, so a rewrite on its first request is flagged; a fresh one always writes, and is not.
  // The message count cannot tell them apart: a fresh first request here carries about 40 messages of hook
  // and memory context (probe, 2026-10-13: 41 fresh, 60 resumed). `compact` is not a new conversation.
  // A resumed or forked transcript's size also stands in for the context figure until the first reply (seedCtx).
  // Written with no condition, so it does not depend on what ctx held. If session.end fires after this event,
  // reset() clears it and the HUD shows no ctx until the first reply.
  on('classic.SessionStart', async ($, e, next) => {
    try {
      if (e.source !== 'compact' && !(await isOff($))) {
        const resumed = e.source === 'resume' || e.source === 'fork'
        await update($, cache, now => (now.resumed === resumed ? now : { ...now, resumed }))
      }
    } catch {
      // Observer only.
    }
    await reassertCostForgotten($)
    try {
      if ((e.source === 'resume' || e.source === 'fork') && typeof e.context_tokens === 'number') await seedCtx($, e.context_tokens)
    } catch {
      // Observer only.
    }
    return next(e)
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
