import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { hudParts } from '../hooks/hud/model'

// Ways the HUD can fail, one test each. Every check reads the band the person sees.
// H1 the advisor chip says "on" when advisorModel is set but a kill switch keeps it off
// H2 effort below the high pin is not flagged (or high is flagged)
// H3 a subagent's request overwrites the main loop's model and effort
// H4 advisor calls on the main loop are not counted
// H4b a re-run start (reload, respawn, desktop attach) zeroes the advisor count
// H4e a re-run start draws an advisor "on" that the settings now turn off, or drops the kept count when they come back
// H4c /clear or a resume keeps the old conversation's advisor count and cost
// H5 rate-limit bars draw with no subscription windows, or miss a measured change
// H6 the terminal gets Svg (it can't draw it) or the desktop gets none
// H7 CCV3_MOD_HUD_OFF or a headless run still draws the HUD row
// H8 with the HUD up, ctx shows twice (ring and task row); with it off, the task row loses ctx
// H9 a kill switch is set but the advisor runs anyway: the chip stays "blocked"
// H10 a dated model id shows a date as its version; a spend limit's label breaks on the terminal
// H11 the rows do not run core 1, core 2, HUD, widget in order, or two rows still hold two core lines and no HUD (Band reliability: the compact line)
// H12 below 40 columns the one core line is not followed by the HUD row, then the widget
// H13 /os redesign, Band reliability: a render with a null hud atom (no session.start ran the HUD's start) leaves the HUD row hidden
// H14 the HUD row draws ctx and the widget line draws it again

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 160,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

type World = { env?: Record<string, string>; settings?: Record<string, unknown>; limits?: { kind: string; percentUsed: number }[] }

const beneath = { advisorCalls: 0 }

const world = (on: On, w: World = {}) => {
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      serverToolUses: Array.from({ length: beneath.advisorCalls }, (_, i) => ({ id: `a${i}`, name: 'advisor', input: {}, startedAt: 1 })),
      stopReason: 'end_turn' as const,
      usage: null,
    }
  })
  mock.clock(on, { now: 1_000 })
  mock.env(on, w.env ?? {})
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('settings.read', () => ({ value: w.settings ?? { advisorModel: 'fable' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: w.limits ?? [{ kind: 'five_hour', percentUsed: 38 }], cost: { usd: 3.84 } },
  }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.exists', () => ({ value: false }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.id', () => ({ value: 's1' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
}

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: '/repo', surface: isInteractive ? 'terminal' : null, isInteractive } as never)

/** One model request; the engine beneath (in `world`) answers with `beneath.advisorCalls` advisor uses. */
const step = async ($: Engine, input: { model: string; effort?: string; agentId?: string }, advisorCalls = 0) => {
  beneath.advisorCalls = advisorCalls
  const stream = $.turn.step({ turnId: 't1', index: 0, messageCount: 1, ...input } as never)
  for await (const _chunk of stream) {
    // drain
  }
  await stream.result
}

const hudOn = async ($: Engine, surface: 'terminal' | 'desktop') => {
  const band = await $.ui.mount({ plugin: 'ccv3-mods', surface, component: 'AbovePrompt', props: BAND_PROPS })
  const row = await band.find({ key: 'row-hud' })
  // A Text element's key is not kept in tests (README, Facts proven): find the chip by its text.
  const model = await band.find({ type: 'Text', text: /^ (Opus|Sonnet|Fable) / })
  const svgs = await band.findAll({ type: 'Svg' })
  const taskRow = (await band.find({ key: 'row-band' }))?.text
  const core = (await band.find({ key: 'row-core-1' }))?.text
  await band.unmount()
  return { text: row?.text, modelProps: model?.props, svgs: svgs.length, taskRow, core }
}

/**
 * The hud atom as a store a test controls. In the real engine (Claude Code 2.1.312, E2E 2026-10-30) the atom is already
 * null when classic.SessionStart fires after /clear or an in-session /resume, so reset() finds nothing to edit.
 * The kit cannot write an atom, so state.get and state.set for the key answer from `held`; a test nulls it with `held.value = null`.
 */
const heldHud = (on: On) => {
  const held = { value: null as unknown, version: 0 }
  const ref = { plugin: 'ccv3-mods', key: 'hud' } as never
  on('state.get', ref, (() => ({ value: { value: held.value, version: held.version } })) as never)
  on('state.set', ref, ((_$: unknown, e: { value: unknown; ifVersion?: number }) => {
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) return { value: { isSet: false, version: held.version } }
    held.value = e.value
    held.version += 1
    return { value: { isSet: true, version: held.version } }
  }) as never)
  return held
}

describe('hud', () => {
  test('H1 a kill switch shows the advisor as blocked, with the reason', async ($, on) => {
    world(on, { env: { DISABLE_TELEMETRY: '1' } })
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      expect((await hudOn($, surface)).text).toContain('Fable advisor blocked: DISABLE_TELEMETRY')
    }
  })

  test('H1 no advisorModel shows advisor off; set and unblocked shows it on', async ($, on) => {
    world(on, { settings: {} })
    await start($)
    expect((await hudOn($, 'terminal')).text).toContain('advisor off')
  })

  test('H1 advisorModel set and no kill switch shows the advisor on', async ($, on) => {
    world(on)
    await start($)
    const text = (await hudOn($, 'terminal')).text ?? ''
    expect(text).toContain('Fable advisor')
    expect(text).not.toContain('blocked')
    expect(text).not.toContain('advisor off')
  })

  test('H2 H3 medium effort turns the chip red; a subagent request changes nothing', async ($, on) => {
    world(on)
    await start($)
    await step($, { model: 'claude-opus-5-5', effort: 'medium' })
    await step($, { model: 'claude-sonnet-5-5', effort: 'high', agentId: 'sub1' })
    const desktop = await hudOn($, 'desktop')
    expect(desktop.text).toContain('Opus 5.5 · medium')
    expect(desktop.modelProps?.backgroundColor).toBe('error')
    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    expect((await hudOn($, 'desktop')).modelProps?.backgroundColor).toBe('claude')
  })

  test('H4 advisor uses on the main loop are counted', async ($, on) => {
    world(on)
    await start($)
    await step($, { model: 'claude-opus-5-5', effort: 'high' }, 2)
    await step($, { model: 'claude-sonnet-5-5', effort: 'high', agentId: 'sub1' }, 3)
    expect((await hudOn($, 'terminal')).text).toContain('Fable advisor ×2')
  })

  // H4b session.start fires again on a reload, a worker respawn or an enable; the turns' count must survive it.
  test('H4b a second session.start keeps the advisor count', async ($, on) => {
    world(on)
    await start($)
    await step($, { model: 'claude-opus-5-5', effort: 'high' }, 2)
    await start($)
    expect((await hudOn($, 'terminal')).text).toContain('Fable advisor ×2')
  })

  // H4e a re-run start keeps the count but reads the settings as they are now: an advisor switched off or blocked since is not drawn "on".
  test('H4e a second session.start follows the settings it finds and keeps the count', async ($, on) => {
    const w: World = {}
    world(on, w)
    await start($)
    await step($, { model: 'claude-opus-5-5', effort: 'high' }, 2)
    w.settings = {}
    await start($)
    const off = (await hudOn($, 'terminal')).text ?? ''
    expect(off).toContain('advisor off')
    expect(off).not.toContain('×')
    w.settings = { advisorModel: 'fable' }
    await start($)
    expect((await hudOn($, 'terminal')).text).toContain('Fable advisor ×2')
  })

  // H4c a new conversation in the same process: the old one's count and cost go, the row stays.
  test('H4c /clear and a resume start the advisor count and the cost over', async ($, on) => {
    world(on)
    await start($)
    for (const reason of ['clear', 'resume']) {
      await step($, { model: 'claude-opus-5-5', effort: 'medium' }, 2)
      await $.session.measure({ startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 4.1 }, changed: ['cost'] } as never)
      const before = (await hudOn($, 'terminal')).text ?? ''
      expect(before).toContain('$4.10')
      expect(before).toContain('×2')
      await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } } as never)
      const after = (await hudOn($, 'terminal')).text ?? ''
      expect(after).not.toContain('$4.10')
      expect(after).not.toContain('×')
      expect(after).toContain('Fable advisor')
      // The row keeps the last step's model chip: a null atom would re-seed it with no effort.
      expect(after).toContain('· medium')
    }
  })

  // H4d the real engine leaves the hud atom null at /clear and at an in-session resume. A render then re-seeds it from the
  // cached seed, whose cost is the startup one ($0.00 at a launch, or whatever usage() said first). The new conversation
  // shows a dash until its first session.measure, then the engine's cost.
  test('H4d /clear and a resume with a null hud atom show no cost until the first measure', async ($, on) => {
    world(on)
    const held = heldHud(on)
    // The first render finds the atom null (no start ran) and caches the seed, which holds usage()'s cost of 3.84.
    expect((await hudOn($, 'terminal')).text).toContain('$3.84')
    for (const reason of ['clear', 'resume']) {
      await $.session.measure({ startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 4.1 }, changed: ['cost'] } as never)
      expect((await hudOn($, 'terminal')).text).toContain('$4.10')
      held.value = null
      await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } } as never)
      const after = await hudOn($, 'terminal')
      for (const old of ['$3.84', '$4.10', '$0.50', '$0.00']) {
        expect(after.text).not.toContain(old)
        expect(after.core).not.toContain(old)
      }
      expect(after.core).toContain('$-')
      await $.session.measure({ startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 0.5 }, changed: ['cost'] } as never)
      expect((await hudOn($, 'terminal')).text).toContain('$0.50')
    }
  })

  test('H9 an advisor use clears a "blocked" chip', async ($, on) => {
    world(on, { env: { DISABLE_TELEMETRY: 'yes' } })
    await start($)
    expect((await hudOn($, 'terminal')).text).toContain('blocked')
    await step($, { model: 'claude-opus-5-5', effort: 'high' }, 1)
    const text = (await hudOn($, 'terminal')).text ?? ''
    expect(text).toContain('Fable advisor ×1')
    expect(text).not.toContain('blocked')
  })

  test('H9 an env value like "no" is not a kill switch', async ($, on) => {
    world(on, { env: { DISABLE_TELEMETRY: 'no' } })
    await start($)
    expect((await hudOn($, 'terminal')).text).not.toContain('blocked')
  })

  test('H10 dated ids and spend limits', async ($, on) => {
    const parts = hudParts(
      { model: 'claude-opus-4-20250514', effort: 'high', advisor: { state: 'off', calls: 0 }, costUsd: null, limits: [{ kind: 'spend_limit', percentUsed: 40 }] },
      null,
    )
    expect(parts.find(part => part.key === 'hud-model')).toMatchObject({ text: 'Opus 4 · high' })
    world(on, { limits: [{ kind: 'spend_limit', percentUsed: 40 }] })
    await start($)
    const text = (await hudOn($, 'terminal')).text ?? ''
    expect(text).toContain('spend limit ▰')
    expect(text).toContain('40%')
  })

  test('H5 no rate-limit windows, no bars; a measured change shows up', async ($, on) => {
    world(on, { limits: [] })
    await start($)
    expect((await hudOn($, 'terminal')).text).not.toContain('5h')
    await $.session.measure({ startedAt: 0, context: { window: 1_000_000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 61 }], cost: { usd: 4.1 }, changed: ['rateLimits', 'cost'] } as never)
    const text = (await hudOn($, 'terminal')).text
    expect(text).toContain('7d')
    expect(text).toContain('61%')
    expect(text).toContain('$4.10')
  })

  test('H6 Svg on desktop, never on the terminal', async ($, on) => {
    world(on)
    await start($)
    await $.session.measure({ startedAt: 0, context: { window: 1_000_000, percent: 42 }, rateLimits: [{ kind: 'five_hour', percentUsed: 38 }], changed: ['context'] } as never)
    const terminal = await hudOn($, 'terminal')
    expect(terminal.svgs).toBe(0)
    expect(terminal.text).toMatch(/[▰▱]/)
    expect((await hudOn($, 'desktop')).svgs).toBe(2)
  })

  test('H7 off switch and headless runs draw no HUD row', async ($, on) => {
    world(on, { env: { CCV3_MOD_HUD_OFF: '1' } })
    await start($)
    expect((await hudOn($, 'desktop')).text).toBeUndefined()
  })

  test('H7 CCV3_MODS_OFF draws no HUD row', async ($, on) => {
    world(on, { env: { CCV3_MODS_OFF: '1' } })
    await start($)
    expect((await hudOn($, 'desktop')).text).toBeUndefined()
  })

  test('H7 a headless run draws no HUD row', async ($, on) => {
    world(on)
    await start($, false)
    expect((await hudOn($, 'desktop')).text).toBeUndefined()
  })

  test('H8 with the HUD up, ctx is in the ring only', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'a' } } }))
    await start($)
    await $.session.measure({ startedAt: 0, context: { window: 1_000_000, percent: 42 }, rateLimits: [], changed: ['context'] } as never)
    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'd' })
    const seen = await hudOn($, 'terminal')
    expect(seen.text).toContain('ctx 42%')
    expect(seen.taskRow).toContain('0/1 done')
    expect(seen.taskRow).not.toContain('ctx')
  })

  test('H8 with the HUD off, the task row keeps ctx', async ($, on) => {
    world(on, { env: { CCV3_MOD_HUD_OFF: '1' } })
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'a' } } }))
    await start($)
    await $.session.measure({ startedAt: 0, context: { window: 1_000_000, percent: 42 }, rateLimits: [], changed: ['context'] } as never)
    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'd' })
    expect((await hudOn($, 'terminal')).taskRow).toContain('ctx 42%')
  })

  // H11 the HUD row draws above the two core lines (PRD 5.3: the core lines never move), or the rows do not give way in order.
  // Band reliability: with two rows the compact line (one core row, key row-core-1) and the HUD row draw; two core lines need three rows with the HUD up.
  test('H11 with the HUD up the rows run core 1, core 2, HUD, widget; short room drops the widget, then core 2 (the compact line), never the HUD', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'a' } } }))
    await start($)
    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'd' })
    const keysAt = async (maxRows: number) => {
      const band = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, maxRows } })
      const keys = (await band.findAll({ type: 'Box' })).map(found => found.key).filter(key => key?.startsWith('row-'))
      await band.unmount()
      return keys
    }
    expect(await keysAt(10)).toEqual(['row-core-1', 'row-core-2', 'row-hud', 'row-band'])
    expect(await keysAt(4)).toEqual(['row-core-1', 'row-core-2', 'row-hud', 'row-band'])
    expect(await keysAt(3)).toEqual(['row-core-1', 'row-core-2', 'row-hud'])
    expect(await keysAt(2)).toEqual(['row-core-1', 'row-hud'])
    expect(await keysAt(1)).toEqual(['row-core-1'])
  })

  // H12 below 40 columns the band is ONE core line; the row it does not use goes to the HUD and the widget (CodeRabbit, PR 194)
  test('H12 a narrow band draws one core line, and the row it saves goes to the HUD, then the widget', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'a' } } }))
    await start($)
    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'd' })
    const keysAt = async (maxRows: number) => {
      const band = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, maxRows, bodyColumns: 30 } })
      const keys = (await band.findAll({ type: 'Box' })).map(found => found.key).filter(key => key?.startsWith('row-'))
      await band.unmount()
      return keys
    }
    expect(await keysAt(2)).toEqual(['row-core-1', 'row-hud'])
    expect(await keysAt(3)).toEqual(['row-core-1', 'row-hud', 'row-band'])
  })

  // H13 a render with a null atom seeds it. No session.start here: the HUD's start never ran, as in Dave's screenshot 8.
  test('H13 a render with a null hud atom still draws the HUD row: model, advisor, cost and limits', async ($, on) => {
    world(on)
    const seen = await hudOn($, 'terminal')
    expect(seen.text).toContain('Opus 5.5')
    expect(seen.text).toContain('Fable advisor')
    expect(seen.text).toContain('$3.84')
    expect(seen.text).toContain('38%')
  })

  test('H13 the seeded HUD row draws on the desktop with rings too', async ($, on) => {
    world(on)
    const seen = await hudOn($, 'desktop')
    expect(seen.text).toContain('Opus 5.5')
    expect(seen.svgs).toBeGreaterThan(0)
  })

  // H14 the first render seeds the atom; the widget line must already leave ctx to the HUD row.
  test('H14 with a seeded HUD, ctx is in the HUD row only, not on the widget line', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'a' } } }))
    await $.session.measure({ startedAt: 0, context: { window: 1_000_000, percent: 42 }, rateLimits: [], changed: ['context'] } as never)
    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'd' })
    const seen = await hudOn($, 'terminal')
    expect(seen.text).toContain('ctx 42%')
    expect(seen.taskRow).toContain('0/1 done')
    expect(seen.taskRow).not.toContain('ctx')
  })
})
