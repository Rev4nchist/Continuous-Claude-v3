import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { EMPTY_CACHE, MISS_CAP, addRequest, afterCompaction, cacheLabel, cacheReport, cacheView, isSubscription, ttlMinutes } from '../hooks/hud/cache'
import type { CacheRequest } from '../hooks/hud/cache'
import type { CacheState } from '../types'

// Ways the context figure and the cache element can fail, one test each.
// X1 ctx holds the last turn's value while a turn makes more requests (the engine measures per turn)
// X2 ctx holds the pre-compaction value after /compact; a subagent's, a precomputed or a vetoed compaction moves it
// X3 /clear or a resume in the same process keeps the old conversation's ctx and cache counts
// K1 the hit rate counts a subagent's requests, or is not read ÷ all input
// K2 a request that rewrote the prompt is not flagged, or the flag never clears
// K3 the countdown stands still while the session is idle; past the lifetime the element is not COLD
// K4 an off switch still captures or draws the cache; ctx stops moving with the HUD off
// K5 /cache is missing, costs a model turn, or names no cause
// K6 the lifetime is an hour off a subscription (a spend limit is not one), or the override is ignored
// K7 prompt growth, an advisor loop's summed usage, or caching switched off reads as a miss
// K8 a miss is given the wrong cause, or the miss list grows without bound
/// K9 a cold send after a compaction or an advisor loop is priced at the wrong prompt size or rate
// K10 uncached input is counted as cached; an uncached request or a long reply stretches the lifetime

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} }

/** `window` is the prompt size the engine reports when it differs from the counts' sum (an advisor loop sums two responses). */
type Reply = { input: number; read: number; write: number; model?: string; window?: number }

const beneath = {
  reply: null as Reply | null,
  /** The window as the engine reports it after the last response. */
  context: { window: 1_000_000 } as { window: number; tokens?: number; percent?: number },
  tokensAfter: undefined as number | undefined,
  /** The engine vetoes the compaction. */
  skip: false,
  /** `$.session.usage()` fails. */
  usageFails: false,
  limits: [] as { kind: string; percentUsed: number }[],
  /** Every command name the plugin registered. */
  registered: [] as string[],
}

/** A compaction leaves at least one message. */
const SUMMARY = { role: 'user' as const, text: 'summary', toolUses: [] }

const world = (on: On, env: Record<string, string> = {}, limits = [{ kind: 'five_hour', percentUsed: 38 }]) => {
  beneath.reply = null
  beneath.context = { window: 1_000_000 }
  beneath.tokensAfter = undefined
  beneath.skip = false
  beneath.usageFails = false
  beneath.limits = limits
  beneath.registered = []
  on('turn.step', async function* (_$, e) {
    const reply = beneath.reply
    if (reply !== null) {
      const tokens = reply.window ?? reply.input + reply.read + reply.write
      beneath.context = { window: 1_000_000, tokens, percent: Math.round(tokens / 10_000) }
    }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage:
        reply === null
          ? null
          : { input_tokens: reply.input, output_tokens: 10, cache_read_input_tokens: reply.read, cache_creation_input_tokens: reply.write, model: reply.model ?? 'claude-opus-5-5' },
    }
  })
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, env)
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('settings.read', () => ({ value: { advisorModel: 'fable' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => {
    if (beneath.usageFails) throw new Error('usage unavailable')
    return { value: { startedAt: 0, context: beneath.context, rateLimits: beneath.limits, cost: { usd: 3.84 } } }
  })
  on('session.compact', () => (beneath.skip ? { skip: 'vetoed' } : { messages: [SUMMARY], ...(beneath.tokensAfter === undefined ? {} : { tokensAfter: beneath.tokensAfter }) }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('command.register', (_$, e) => {
    beneath.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('fs.exists', () => ({ value: false }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.id', () => ({ value: 's1' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  return clock
}

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: '/repo', surface: isInteractive ? 'terminal' : null, isInteractive } as never)

/** One model request, answered beneath with `reply`'s token counts. */
const step = async ($: Engine, reply: Reply | null, at: { turnId?: string; agentId?: string; messageCount?: number } = {}) => {
  beneath.reply = reply
  const stream = $.turn.step({
    turnId: at.turnId ?? 't1',
    index: 0,
    messageCount: at.messageCount ?? 1,
    model: 'claude-opus-5-5',
    effort: 'high',
    ...(at.agentId === undefined ? {} : { agentId: at.agentId }),
  } as never)
  for await (const _chunk of stream) {
    // drain
  }
  await stream.result
}

const compact = ($: Engine, trigger: string, agentId?: string) =>
  $.session.compact({ trigger, messages: [SUMMARY], ...(agentId === undefined ? {} : { agentId }) } as never)

const end = ($: Engine, reason: string) => $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } } as never)

const band = async ($: Engine) => {
  const mounted = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const hud = (await mounted.find({ key: 'row-hud' }))?.text ?? ''
  const tasks = (await mounted.find({ key: 'row-band' }))?.text ?? ''
  await mounted.unmount()
  return { hud, tasks }
}

const cacheCommand = async ($: Engine) =>
  (await $.command.run({ command: 'cache', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })).text ?? ''

type Over = Partial<Omit<CacheRequest, 'usage'>> & { read: number; write: number; input?: number; model?: string }

const request = (over: Over): CacheRequest => ({
  usage: { input_tokens: over.input ?? 2, output_tokens: 10, cache_read_input_tokens: over.read, cache_creation_input_tokens: over.write, model: over.model ?? 'claude-opus-5-5' },
  contextTokens: over.contextTokens ?? null,
  sentAt: over.sentAt ?? over.at ?? 60_000,
  at: over.at ?? 60_000,
  turnId: over.turnId ?? 't1',
  messageCount: over.messageCount ?? 1,
  ttlMin: over.ttlMin ?? 60,
  oneHour: over.oneHour ?? true,
})

/** A session with one request behind it: 100k of prompt cached, last reply at one minute. */
const warm = (): CacheState => addRequest(EMPTY_CACHE, request({ read: 0, write: 100_000, at: 60_000 }))

describe('context figure', () => {
  test('X1 each main-loop request moves ctx, with no session.measure', async ($, on) => {
    world(on)
    await start($)
    await step($, { input: 2, read: 300_000, write: 60_000 })
    expect((await band($)).hud).toContain('ctx 36%')
    await step($, { input: 2, read: 360_000, write: 40_000 })
    expect((await band($)).hud).toContain('ctx 40%')
    await step($, { input: 2, read: 1_000, write: 9_000 }, { agentId: 'sub1' })
    expect((await band($)).hud).toContain('ctx 40%')
  })

  test('X2 a compaction replaces the old ctx with the size the engine reports', async ($, on) => {
    world(on)
    await start($)
    await step($, { input: 2, read: 300_000, write: 60_000 })
    beneath.tokensAfter = 133_800
    await compact($, 'manual')
    expect((await band($)).hud).toContain('ctx 13%')
  })

  test('X2 a compaction that reports no size shows no ctx, never the old one', async ($, on) => {
    world(on)
    await start($)
    await step($, { input: 2, read: 300_000, write: 60_000 })
    await compact($, 'auto')
    expect((await band($)).hud).not.toContain('ctx')
  })

  test("X2 a subagent's, a precomputed and a vetoed compaction leave ctx and the cache alone", async ($, on) => {
    world(on)
    await start($)
    await step($, { input: 2, read: 300_000, write: 60_000 })
    beneath.tokensAfter = 10_000
    await compact($, 'auto', 'sub1')
    await compact($, 'precompute')
    beneath.skip = true
    await compact($, 'manual')
    expect((await band($)).hud).toContain('ctx 36%')
    // No compaction stood, so a rewrite on the next request is not named one.
    await step($, { input: 2, read: 10_000, write: 350_000 }, { turnId: 't2' })
    expect(await cacheCommand($)).toContain('prompt changed')
  })

  test('X3 /clear and a resume in the same process start ctx and the cache counts over', async ($, on) => {
    world(on)
    await start($)
    for (const reason of ['clear', 'resume']) {
      await step($, { input: 2, read: 300_000, write: 60_000 })
      expect(await cacheCommand($)).toContain('requests      1')
      await end($, reason)
      const seen = await band($)
      expect(seen.hud).not.toContain('ctx')
      expect(seen.hud).not.toContain('cache')
      expect(await cacheCommand($)).toContain('no main-loop request yet')
    }
  })

  test('X3 an exit leaves the counts as they are', async ($, on) => {
    world(on)
    await start($)
    await step($, { input: 2, read: 300_000, write: 60_000 })
    await end($, 'prompt_input_exit')
    expect(await cacheCommand($)).toContain('requests      1')
  })

  test('K4 with the HUD off, ctx still moves per request and no cache is captured', async ($, on) => {
    world(on, { CCV3_MOD_HUD_OFF: '1' })
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'a' } } }))
    await start($)
    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'd' })
    await step($, { input: 2, read: 300_000, write: 60_000 })
    const seen = await band($)
    expect(seen.tasks).toContain('ctx 36%')
    expect(seen.hud).toBe('')
    expect(await cacheCommand($)).toContain('no main-loop request yet')
  })

  test('K4 CCV3_MODS_OFF captures nothing', async ($, on) => {
    world(on, { CCV3_MODS_OFF: '1' })
    await start($)
    await step($, { input: 2, read: 300_000, write: 60_000 })
    expect(await cacheCommand($)).toContain('no main-loop request yet')
  })
})

describe('cache element', () => {
  test('K1 the hit rate is read over all input of the main loop; a subagent is not counted', async ($, on) => {
    world(on)
    await start($)
    expect((await band($)).hud).not.toContain('cache')
    await step($, { input: 0, read: 0, write: 100_000 })
    await step($, { input: 0, read: 100_000, write: 0 })
    await step($, { input: 0, read: 0, write: 900_000 }, { agentId: 'sub1' })
    expect((await band($)).hud).toContain('cache 50% · 60m')
  })

  test('K2 a rewrite in the newest turn shows MISS with its size; a clean next turn clears it', async ($, on) => {
    world(on)
    await start($)
    await step($, { input: 0, read: 0, write: 100_000 }, { turnId: 't1' })
    await step($, { input: 0, read: 100_000, write: 2_000 }, { turnId: 't1' })
    expect((await band($)).hud).not.toContain('MISS')
    await step($, { input: 0, read: 5_000, write: 97_000 }, { turnId: 't2' })
    await step($, { input: 0, read: 102_000, write: 1_000 }, { turnId: 't2' })
    expect((await band($)).hud).toContain('MISS 97k')
    await step($, { input: 0, read: 103_000, write: 1_000 }, { turnId: 't3' })
    expect((await band($)).hud).not.toContain('MISS')
  })

  test('K2 a resumed conversation that rewrites its history is flagged; a fresh first request is not', async ($, on) => {
    world(on)
    await start($)
    await step($, { input: 0, read: 20_000, write: 340_000 }, { messageCount: 412 })
    expect((await band($)).hud).toContain('MISS 340k')
    expect(await cacheCommand($)).toContain('resume')
  })

  test('K3 the countdown moves while idle, on a mounted band, and ends in COLD with the next cost', async ($, on) => {
    const clock = world(on)
    await start($)
    await step($, { input: 0, read: 0, write: 360_000 })
    const mounted = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    const text = async () => (await mounted.find({ key: 'row-hud' }))?.text ?? ''
    expect(await text()).toContain('· 60m')
    await clock.advance(18 * 60_000)
    expect(await text()).toContain('· 42m')
    await clock.advance(43 * 60_000)
    // 360k tokens rewritten at the 1-hour write rate on Opus: 360_000 × $4 × 2 ÷ 1M.
    expect(await text()).toContain('cache COLD · next ≈$2.88')
    await mounted.unmount()
  })

  test('K9 after a compaction, the cause is named and a cold send is priced at the new size', async ($, on) => {
    const clock = world(on)
    await start($)
    await step($, { input: 0, read: 0, write: 360_000 })
    beneath.tokensAfter = 133_800
    await compact($, 'manual')
    await clock.advance(61 * 60_000)
    // 133_800 × $4 × 2 ÷ 1M, not the 360k the window held before.
    expect((await band($)).hud).toContain('cache COLD · next ≈$1.07')
    await step($, { input: 0, read: 36_000, write: 97_800 }, { turnId: 't2' })
    await compact($, 'manual')
    await step($, { input: 0, read: 30_000, write: 60_000 }, { turnId: 't3' })
    expect(await cacheCommand($)).toMatch(/rewrote 60k\s+compaction/)
  })

  test("K9 an advisor loop's cold send is priced at the window, not at the summed counts", async ($, on) => {
    const clock = world(on)
    await start($)
    await step($, { input: 0, read: 0, write: 100_000 })
    await step($, { input: 0, read: 200_000, write: 4_000, window: 102_000 })
    expect((await band($)).hud).not.toContain('MISS')
    await clock.advance(61 * 60_000)
    // 102_000 × $4 × 2 ÷ 1M.
    expect((await band($)).hud).toContain('cache COLD · next ≈$0.82')
  })

  test('K5 /cache answers with the totals and each miss, its idle gap and cause', async ($, on) => {
    const clock = world(on)
    await start($)
    await step($, { input: 0, read: 0, write: 100_000 })
    await clock.advance(61 * 60_000)
    await step($, { input: 0, read: 0, write: 100_000 })
    const text = await cacheCommand($)
    expect(text).toContain('requests      2')
    expect(text).toContain('hit rate      0.0%')
    expect(text).toContain('saved         ≈ -$0.80')
    expect(text).toContain('Misses (2)')
    expect(text).toMatch(/idle 1h 1m\s+rewrote 100k\s+expired\s+≈ \$0\.80/)
    expect(text).toContain('session start')
  })

  test('K5 a headless run captures the cache and registers no /cache', async ($, on) => {
    world(on)
    await start($, false)
    await step($, { input: 0, read: 0, write: 100_000 })
    expect(beneath.registered).not.toContain('cache')
    expect(await cacheCommand($)).toContain('requests      1')
  })

  test('K5 an interactive start registers /cache', async ($, on) => {
    world(on)
    await start($)
    expect(beneath.registered).toContain('cache')
  })

  test('K6 a spend limit alone is no subscription: five minutes', async ($, on) => {
    world(on, {}, [{ kind: 'spend_limit', percentUsed: 40 }])
    await start($)
    await step($, { input: 0, read: 0, write: 100_000 })
    expect((await band($)).hud).toContain('· 5m')
    expect(isSubscription(['spend_limit'])).toBe(false)
    expect(isSubscription(['seven_day'])).toBe(true)
    expect(isSubscription([])).toBe(false)
  })

  test('K6 CCV3_CACHE_TTL_MIN overrides the lifetime and keeps the 1-hour write rate', async ($, on) => {
    const clock = world(on, { CCV3_CACHE_TTL_MIN: '30' })
    await start($)
    await step($, { input: 0, read: 0, write: 100_000 })
    expect((await band($)).hud).toContain('· 30m')
    await clock.advance(31 * 60_000)
    // A subscription still writes 1-hour entries: 100_000 × $4 × 2 ÷ 1M.
    expect((await band($)).hud).toContain('cache COLD · next ≈$0.80')
    expect(ttlMinutes('junk', true)).toBe(60)
    expect(ttlMinutes(undefined, false)).toBe(5)
  })

  test('K6 a failed usage read keeps the last lifetime and write rate', async ($, on) => {
    const clock = world(on)
    await start($)
    await step($, { input: 0, read: 0, write: 100_000 })
    beneath.usageFails = true
    await step($, { input: 0, read: 100_000, write: 1_000 })
    expect((await band($)).hud).toContain('· 60m')
    await clock.advance(61 * 60_000)
    // Still a subscription: 101_000 × $4 × 2 ÷ 1M, not the 5-minute rate ($0.51).
    expect((await band($)).hud).toContain('cache COLD · next ≈$0.81')
  })
})

describe('cache model', () => {
  test('K7 a large tool result grows the prompt without a miss', () => {
    const after = addRequest(warm(), request({ read: 100_000, write: 150_000, at: 120_000 }))
    expect(after.missCount).toBe(1) // the session start alone
    expect(after.contextTokens).toBe(250_002)
  })

  test("K7 an advisor loop's summed usage is no miss, on it or on the request after", () => {
    // Two responses inside one request: the counts are summed, the window is the last response's.
    const looped = addRequest(warm(), request({ read: 200_000, write: 4_000, contextTokens: 102_000, at: 120_000 }))
    const next = addRequest(looped, request({ read: 102_000, write: 1_000, contextTokens: 103_000, at: 180_000 }))
    expect(next.missCount).toBe(1)
  })

  test('K7 caching switched off is no miss on any request, and the element says off', () => {
    const first = addRequest(EMPTY_CACHE, request({ input: 50_000, read: 0, write: 0, at: 60_000 }))
    const second = addRequest(first, request({ input: 52_000, read: 0, write: 0, at: 120_000 }))
    expect(second.missCount).toBe(0)
    expect(cacheLabel(cacheView(second, 120_000)!)).toEqual({ text: 'cache off', tone: 'warn' })
  })

  test('K10 input the cache never held is not a rewrite when it comes again uncached', () => {
    // 100k prompt, of which 40k is cached; the same request again reads the 40k and writes nothing.
    const first = addRequest(EMPTY_CACHE, request({ input: 60_000, read: 0, write: 40_000, at: 60_000 }))
    const again = addRequest(first, request({ input: 60_000, read: 40_000, write: 0, at: 120_000 }))
    expect(again.missCount).toBe(1) // the session start alone
    expect(again.cachedTokens).toBe(40_000)
  })

  test('K10 a request that did not use the cache does not refresh its lifetime', () => {
    const uncached = addRequest(warm(), request({ input: 100_000, read: 0, write: 0, at: 60_000 + 30 * 60_000 }))
    expect(uncached.missCount).toBe(1)
    expect(cacheView(uncached, 60_000 + 59 * 60_000)).toMatchObject({ status: 'warm', minutesLeft: 1 })
    expect(cacheView(uncached, 60_000 + 61 * 60_000)).toMatchObject({ status: 'cold' })
  })

  test('K10 the lifetime runs from the send, so a long reply does not stretch it', () => {
    const slow = addRequest(EMPTY_CACHE, request({ read: 0, write: 100_000, sentAt: 60_000, at: 60_000 + 10 * 60_000 }))
    expect(cacheView(slow, 60_000 + 55 * 60_000)).toMatchObject({ status: 'warm', minutesLeft: 5 })
  })

  test('K8 each miss names its cause', () => {
    const cause = (state: CacheState, over: Over) => addRequest(state, request(over)).misses.at(-1)?.cause
    // A first request an hour after launch is still a start: the clock says nothing about a history.
    expect(cause(EMPTY_CACHE, { read: 0, write: 50_000, at: 3_600_000 })).toBe('start')
    expect(cause(EMPTY_CACHE, { read: 0, write: 50_000, at: 60_000, messageCount: 40 })).toBe('resume')
    expect(cause(warm(), { read: 0, write: 100_000, at: 60_000 + 61 * 60_000 })).toBe('expired')
    expect(cause({ ...warm(), compacted: true }, { read: 10_000, write: 30_000, at: 120_000 })).toBe('compaction')
    expect(cause(warm(), { read: 0, write: 100_000, at: 120_000, model: 'claude-sonnet-5-5' })).toBe('model')
    expect(cause(warm(), { read: 20_000, write: 80_000, at: 120_000 })).toBe('changed')
  })

  test('K8 idle time ends when the request is sent, not when its reply is whole', () => {
    // Five-minute lifetime, sent four minutes after the last reply, answered two minutes later.
    const five = addRequest(EMPTY_CACHE, request({ read: 0, write: 100_000, at: 60_000, ttlMin: 5, oneHour: false }))
    const late = addRequest(five, request({ read: 0, write: 100_000, sentAt: 60_000 + 4 * 60_000, at: 60_000 + 6 * 60_000, ttlMin: 5, oneHour: false }))
    expect(late.misses.at(-1)).toMatchObject({ cause: 'changed', idleMs: 4 * 60_000 })
  })

  test('K8 a compacted prompt is held to its new size, and the flag clears', () => {
    const big = addRequest(EMPTY_CACHE, request({ read: 0, write: 360_000, at: 60_000 }))
    const after = addRequest({ ...big, compacted: true }, request({ read: 36_000, write: 97_800, at: 120_000 }))
    expect(after.misses.at(-1)).toMatchObject({ cause: 'compaction', rewritten: 97_800 })
    expect(after.compacted).toBe(false)
  })

  test('K8 a partly cached prompt that compacts and is served whole is no miss', () => {
    // 100k prompt with 40k cached compacts to 90k; the next request reads the 40k and writes 50k of new text.
    const partly = addRequest(EMPTY_CACHE, request({ input: 60_000, read: 0, write: 40_000, at: 60_000 }))
    const compacted = afterCompaction(partly, 90_000)
    expect(compacted).toMatchObject({ compacted: true, contextTokens: 90_000, cachedTokens: 40_000 })
    // Left idle past the lifetime, the next send caches the whole 90k prompt: 90_000 × $4 × 2 ÷ 1M, not the 40k price.
    const cold = cacheView(compacted, 60_000 + 61 * 60_000)
    expect(cold).toMatchObject({ status: 'cold' })
    expect(cold?.status === 'cold' ? Math.round((cold.coldUsd ?? 0) * 100) : null).toBe(72)
    expect(cacheReport(compacted, 60_000 + 61 * 60_000)).toContain('the next send rewrites 90k tokens')
    const next = addRequest(compacted, request({ input: 0, read: 40_000, write: 50_000, at: 120_000 }))
    expect(next.missCount).toBe(1) // the session start alone
    // A cache that held more than the new prompt holds no more than the new prompt.
    expect(afterCompaction(warm(), 30_000).cachedTokens).toBe(30_000)
    expect(afterCompaction(warm(), undefined)).toMatchObject({ compacted: true, cachedTokens: 100_000 })
    expect(afterCompaction(EMPTY_CACHE, 30_000)).toBe(EMPTY_CACHE)
  })

  test('K8 the miss list is capped and the count is not', () => {
    let state = EMPTY_CACHE
    for (let i = 0; i < MISS_CAP + 5; i++) state = addRequest(state, request({ read: 0, write: 100_000, at: 60_000 * (i + 1), model: i % 2 ? 'claude-opus-5-5' : 'claude-sonnet-5-5' }))
    expect(state.misses.length).toBe(MISS_CAP)
    expect(state.missCount).toBe(MISS_CAP + 5)
    expect(cacheReport(state, 60_000 * 40)).toContain(`the newest ${MISS_CAP} are listed`)
  })

  test('K9 a rewrite is priced at the rate of the account, not of the lifetime', () => {
    // 100k rewritten on Opus: $0.80 at the 1-hour rate, $0.50 at the 5-minute rate.
    const cents = (oneHour: boolean) =>
      Math.round((addRequest(warm(), request({ read: 0, write: 100_000, at: 120_000, ttlMin: 30, oneHour, input: 0 })).misses.at(-1)?.usd ?? 0) * 100)
    expect(cents(true)).toBe(80)
    expect(cents(false)).toBe(50)
  })

  test('K2 the label, the low-time tone and the report read the same state', () => {
    const state = addRequest(warm(), request({ read: 100_000, write: 0, at: 120_000 }))
    expect(cacheLabel(cacheView(state, 120_000)!)).toEqual({ text: 'cache 50% · 60m', tone: 'todo' })
    expect(cacheLabel(cacheView(state, 120_000 + 55 * 60_000)!)).toEqual({ text: 'cache 50% · 5m', tone: 'warn' })
    // A five-minute lifetime warns in its last half minute.
    const five = addRequest(EMPTY_CACHE, request({ read: 0, write: 100_000, at: 60_000, ttlMin: 5, oneHour: false }))
    expect(cacheLabel(cacheView(five, 60_000 + 4 * 60_000)!).tone).toBe('todo')
    expect(cacheLabel(cacheView(five, 60_000 + 4.6 * 60_000)!).tone).toBe('warn')
    expect(cacheView(EMPTY_CACHE, 0)).toBeNull()
    expect(cacheReport(EMPTY_CACHE, 0)).toContain('no main-loop request yet')
    // Saved: 100k read at $3.80 per million less the 1-hour premium on 100k written ($4 per million).
    expect(cacheReport(state, 120_000)).toContain('saved         ≈ -$0.02')
  })
})
