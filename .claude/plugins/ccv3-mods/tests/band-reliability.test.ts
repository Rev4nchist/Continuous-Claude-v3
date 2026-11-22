import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// /os redesign, round 2: Band reliability (build plan, "Band reliability"; Dave: "fix 3"). Evidence: in his screenshot 8 the band
// drew two core lines and the widget line with `ctx 47%` but no HUD row, so the hud atom was empty although /cache worked.
// Every check reads the band the person sees (row keys and row text), or the debug log file the mod writes.
//
// Row budget (item 2; the row plan of band-model.ts, design 2026-11-18, section 3). The core rows never move when there is room, at every width.
//   maxRows 1: the one-row line (key row-core-1; chip, sign, ctx, 5h, 7d, then the goal at 12 cells; no name, repo, helpers or cost)
//   maxRows 2: the compact line plus the HUD row (HUD up); with the HUD off row 1 and the Goal row draw
//   maxRows 3: row 1, the Goal row (row-core-2) and the HUD row; with the HUD off row 1, the Goal row and the widget row
//   maxRows 4: plus the widget row (row-band): the active task, the step, PRs, agents. A row with nothing to say is not drawn.
// B1 a row budget picks the wrong rows at some width from the matrix 20, 40, 120 (compact line missing, goal row dropped or kept, HUD or widget out of order)
// B2 the one-row line or the compact line is not what the plan says: the compact line loses the chip, ctx, cost or the helper count, or either keeps lane
// B3 the core rows move when there is room: with maxRows 3 or more their text differs from the roomy band
// B4 the HUD is off and a two-row budget still gets the compact line (row 1 and the Goal row fit and must draw)
//
// HUD self-seeding (item 3). The hud atom is null when no session.start ran the HUD's start. A band render, session.measure and
// turn.step seed it once from session.model, settings (advisor) and session.usage (cost, limits).
// HS1 a render with a null atom leaves the HUD row hidden (the bug)
// HS2 the seed runs more than once: model or settings read again at a second render, measure or step
// HS3 session.measure with a null atom does not seed (read at once, before any render), or loses the measured cost and limits
// HS4 turn.step with a null atom does not seed, or loses the step's model and effort
// HS5 CCV3_MOD_HUD_OFF=1 or CCV3_MODS_OFF=1 seeds anyway (it must stay null, and read nothing)
// HS6 a headless run seeds (the HUD row is for interactive sessions only)
// HS7 a seed that throws breaks the measure or the render, draws a half HUD, or never tries again at the next render
// HS8 the first render that seeds the atom draws ctx twice: in the HUD row and on the widget line
// HS9 with the HUD up and ctx unknown, the HUD row does not read `ctx -` right after the model chip, or a second row draws ctx too
//
// Debug log (item 4). CCV3_MOD_BAND_DEBUG=1: each band render appends ONE JSON line to ~/.claude/state/agentic-os/band-debug.log.
// G1 the log is written by default, or with a value other than 1
// G2 the line is missing, is not one JSON object, has the wrong numbers, or holds text (a goal, a path, a repo name, a secret)
// G3 a second render overwrites the first line instead of appending
// G4 the log passes 200 lines, or the oldest lines stay and the newest drop
// G5 a write failure breaks the render
// G6 the log reaches the session (a session.append) or CCV3_MODS_OFF=1 still writes
// G7 the line records the HUD wrong (hudNow must be false with the HUD off) or the row count wrong
//
// Band must-haves (Dave, 2026-10-29; build plan "Band must-haves"), under the plan of design 2026-11-18: the band shows ctx, 5h and 7d once each, where its owner draws them.
// The band state carries the limits as the HUD atom's `limits` (the one-row line and the compact line read BandState.limits; see band-model.test.ts CL9 to CL14).
// With no HUD state (the atom is null) no limit field and no cost draw; ctx stays. An account with no such window draws nothing for that figure.
// M1 some row budget (maxRows 1 to 4) at width 20, 40 or 120 draws no ctx
// M2 maxRows 1 at 120 columns is not the one-row line with ctx, 5h and 7d, no cost, and the goal (the limits vanish because the HUD row is hidden)
// M3 maxRows 1 at 40 columns loses the chip, ctx, 5h or 7d; at 20 columns it loses the chip or ctx, or passes 20 cells
// M4 with room for the HUD row (maxRows 2 to 4, width 40 or 120) the 5h and 7d figures are drawn nowhere
// M5 at 20 columns a budget of 2 to 4 rows loses the chip on core row 1, or draws ctx nowhere, or overruns 20 cells
// M6 an account with no 5h or 7d window gets a dash or a made-up figure for it; one with only a 5h window gets a 7d figure
// M7 the limits are unknown (the HUD seed failed): the one-row line draws ctx and no limit field; the next render that seeds fills them
// M8 a resumed session (HUD atom null, no session.start) shows no 5h or 7d after the HUD self-seed filled them from usage

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const LOG = /\.claude\/state\/agentic-os\/band-debug\.log$/
const SECRET = 'sk-' + 'ant-' + 'a'.repeat(40)

type World = {
  env?: Record<string, string>
  /** The first N reads of session.model throw. */
  modelFails?: number
  /** Files the engine beneath holds before the mod runs, by forward-slash path. */
  files?: Record<string, string>
  /** Every write to the debug log throws. */
  logWriteFails?: boolean
  /** What session.usage reports as rate limits (default: a 5-hour window at 38%). */
  usageLimits?: { kind: string; percentUsed: number }[]
}

type Seen = { modelCalls: number; settingsCalls: number; appended: number; files: Record<string, string>; spawned: number }

const norm = (path: string): string => path.replace(/\\/g, '/')

const world = (on: On, w: World = {}): Seen => {
  const seen: Seen = { modelCalls: 0, settingsCalls: 0, appended: 0, files: { ...(w.files ?? {}) }, spawned: 0 }
  mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home', ...(w.env ?? {}) })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('settings.read', () => {
    seen.settingsCalls++
    return { value: { advisorModel: 'fable' } }
  })
  on('session.model', () => {
    seen.modelCalls++
    if (seen.modelCalls <= (w.modelFails ?? 0)) throw new Error('model read failed')
    return { value: 'claude-opus-5-5' }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: w.usageLimits ?? [{ kind: 'five_hour', percentUsed: 38 }], cost: { usd: 3.84 } },
  }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('fs.exists', (_$, e) => ({ value: norm(e.path) in seen.files }))
  on('fs.read', (_$, e) => {
    const hit = seen.files[norm(e.path)]
    if (hit === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: hit }
  })
  on('fs.write', (_$, e) => {
    if (w.logWriteFails && LOG.test(norm(e.path))) throw new Error('EACCES')
    seen.files[norm(e.path)] = e.text
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.append', () => {
    seen.appended++
    return {} as never
  })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `a${++seen.spawned}` }))
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => ({ result: { task: { id: '1', subject: e.subject } } }))
  on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return seen
}

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: '/repo', surface: isInteractive ? 'terminal' : null, isInteractive } as never)

// The task is in progress: the widget row draws the active task, and a row with nothing to say is not drawn.
const addTask = async ($: Engine, subject = 'build it') => {
  await $.tool.call({ tool: 'TaskCreate', subject, description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
}
const spawn = ($: Engine) =>
  $.agent.spawn({ tool_use_id: 't', prompt: 'p', description: 'map the hooks', subagentType: 'scout', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
const measure = ($: Engine, over: Record<string, unknown> = {}) =>
  $.session.measure({ startedAt: 0, context: { window: 1_000_000, percent: 42 }, rateLimits: [], changed: ['context'], ...over } as never)
const step = async ($: Engine, input: { model: string; effort?: string }) => {
  const stream = $.turn.step({ turnId: 't1', index: 0, messageCount: 1, ...input } as never)
  for await (const _chunk of stream) {
    // drain
  }
  await stream.result
}

type Drawn = { keys: (string | undefined)[]; text: (key: string) => string | undefined }

const draw = async ($: Engine, maxRows: number, bodyColumns = 120, surface: 'terminal' | 'desktop' = 'terminal'): Promise<Drawn> => {
  const band = await $.ui.mount({ plugin: 'ccv3-mods', surface, component: 'AbovePrompt', props: { ...BAND_PROPS, maxRows, bodyColumns } })
  const boxes = (await band.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-'))
  await band.unmount()
  return { keys: boxes.map(found => found.key), text: key => boxes.find(found => found.key === key)?.text }
}

const logOf = (seen: Seen): string[] => {
  const path = Object.keys(seen.files).find(one => LOG.test(one))
  return path === undefined ? [] : (seen.files[path] ?? '').split('\n').filter(line => line.trim() !== '')
}

describe('band row budget', () => {
  // The rows do not depend on the width (the Goal row draws at every width from 20).
  const expected = (_width: number, maxRows: number): string[] => {
    if (maxRows === 1) return ['row-core-1']
    if (maxRows === 2) return ['row-core-1', 'row-hud']
    if (maxRows === 3) return ['row-core-1', 'row-core-2', 'row-hud']
    return ['row-core-1', 'row-core-2', 'row-hud', 'row-band']
  }

  test('B1 maxRows 1, 2, 3 and 4 at widths 20, 40 and 120 choose the one-row line, the compact line and HUD row, then row 1, the Goal row and the HUD row, then the widget row', async ($, on) => {
    world(on)
    await start($)
    await addTask($)
    for (const width of [20, 40, 120]) {
      for (const maxRows of [1, 2, 3, 4]) {
        expect({ width, maxRows, keys: (await draw($, maxRows, width)).keys }).toEqual({ width, maxRows, keys: expected(width, maxRows) })
      }
    }
  })

  test('B2 the compact line (maxRows 2) holds chip, ctx, cost and the helper count, and no lane; the one-row line holds no cost and no helpers', async ($, on) => {
    world(on)
    await start($)
    await addTask($)
    await spawn($)
    await spawn($)
    await measure($)
    const compact = (await draw($, 2, 120)).text('row-core-1') ?? ''
    for (const part of ['WORKING', 'ctx 42%', '$3.84', '2 helpers running']) expect(compact).toContain(part)
    expect(compact).not.toContain('lane ')
    const one = (await draw($, 1, 120)).text('row-core-1') ?? ''
    expect(one).toContain('WORKING')
    expect(one).toContain('ctx 42%')
    expect(one).toContain('goal not set')
    for (const word of ['$', 'helper', 'lane ', 'GOAL']) expect(one).not.toContain(word)
  })

  test('B2 at 20 columns the one-row line is the chip and ctx, within 20 cells', async ($, on) => {
    world(on)
    await start($)
    await addTask($)
    await spawn($)
    await measure($)
    const line = (await draw($, 1, 20)).text('row-core-1') ?? ''
    expect(line).toContain('WORKING')
    expect(line).toContain('ctx 42%')
    expect(line).not.toContain('helper')
    expect(line.length).toBeLessThanOrEqual(20)
  })

  test('B3 with room for two core lines and the HUD row, the core lines are what they are with ten rows', async ($, on) => {
    world(on)
    await start($)
    await addTask($)
    const roomy = await draw($, 10, 120)
    expect(roomy.text('row-core-2')).toBe('goal not set')
    for (const maxRows of [3, 4]) {
      const got = await draw($, maxRows, 120)
      expect(got.text('row-core-1')).toBe(roomy.text('row-core-1'))
      expect(got.text('row-core-2')).toBe(roomy.text('row-core-2'))
    }
    expect(roomy.text('row-core-1')).toContain('lane ')
  })

  test('B4 with the HUD off two rows hold row 1 and the Goal row, and one row holds the one-row line', async ($, on) => {
    world(on, { env: { CCV3_MOD_HUD_OFF: '1' } })
    await start($)
    await addTask($)
    await spawn($)
    const two = await draw($, 2, 120)
    expect(two.keys).toEqual(['row-core-1', 'row-core-2'])
    expect(two.text('row-core-2')).toBe('goal not set')
    expect(two.text('row-core-1')).toContain('lane ')
    expect(two.text('row-core-1')).toContain('ctx ')
    const one = await draw($, 1, 120)
    expect(one.keys).toEqual(['row-core-1'])
    expect(one.text('row-core-1')).not.toContain('lane ')
    expect(one.text('row-core-1')).not.toContain('helper')
    expect((await draw($, 3, 120)).keys).toEqual(['row-core-1', 'row-core-2', 'row-band'])
  })
})

describe('hud self-seeding', () => {
  test('HS1 a render with a null atom seeds it: the HUD row shows the model, the advisor, the cost and the limits', async ($, on) => {
    const seen = world(on)
    const got = await draw($, 10)
    const hud = got.text('row-hud') ?? ''
    expect(hud).toContain('Opus 5.5')
    expect(hud).toContain('Fable advisor')
    expect(hud).toContain('$3.84')
    expect(hud).toContain('38%')
    expect(seen.modelCalls).toBe(1)
  })

  test('HS2 the seed runs once: later renders, measures and steps read the model and the settings no more', async ($, on) => {
    const seen = world(on)
    await draw($, 10)
    await draw($, 10)
    await measure($, { cost: { usd: 4.1 }, changed: ['cost'] })
    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    await draw($, 10)
    expect(seen.modelCalls).toBe(1)
    expect(seen.settingsCalls).toBe(1)
  })

  test('HS3 session.measure with a null atom seeds at once, and the measured cost and limits stand over the seed', async ($, on) => {
    const seen = world(on)
    await measure($, { cost: { usd: 4.1 }, rateLimits: [{ kind: 'seven_day', percentUsed: 61 }], changed: ['cost', 'rateLimits'] })
    expect(seen.modelCalls).toBe(1)
    const hud = (await draw($, 10)).text('row-hud') ?? ''
    expect(hud).toContain('Opus 5.5')
    expect(hud).toContain('$4.10')
    expect(hud).toContain('7d')
    expect(hud).toContain('61%')
    expect(hud).not.toContain('$3.84')
    expect(seen.modelCalls).toBe(1)
  })

  test('HS4 turn.step with a null atom seeds at once, and the step\'s model and effort stand over the seed', async ($, on) => {
    const seen = world(on)
    await step($, { model: 'claude-opus-5-5', effort: 'medium' })
    expect(seen.modelCalls).toBe(1)
    const hud = (await draw($, 10)).text('row-hud') ?? ''
    expect(hud).toContain('Opus 5.5 · medium')
    expect(seen.modelCalls).toBe(1)
  })

  const offCase = (env: Record<string, string>) => async ($: Engine, on: On) => {
    const seen = world(on, { env })
    await addTask($)
    await measure($, { cost: { usd: 4.1 }, changed: ['cost'] })
    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    const got = await draw($, 10)
    expect(got.text('row-hud')).toBeUndefined()
    expect(seen.modelCalls).toBe(0)
    expect(seen.settingsCalls).toBe(0)
  }

  test('HS5 CCV3_MOD_HUD_OFF=1 keeps the atom null: no HUD row and no read', offCase({ CCV3_MOD_HUD_OFF: '1' }))
  test('HS5 CCV3_MODS_OFF=1 keeps the atom null: no HUD row and no read', offCase({ CCV3_MODS_OFF: '1' }))

  test('HS6 a headless run seeds nothing at a render, a measure or a step', async ($, on) => {
    const seen = world(on)
    await start($, false)
    await measure($, { cost: { usd: 4.1 }, changed: ['cost'] })
    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    expect((await draw($, 10, 120, 'desktop')).text('row-hud')).toBeUndefined()
    expect(seen.modelCalls).toBe(0)
  })

  test('HS7 a seed that throws leaves the atom null and the render goes on; the next render seeds', async ($, on) => {
    const seen = world(on, { modelFails: 2 })
    await addTask($)
    await measure($)
    const first = await draw($, 10)
    expect(first.keys).toEqual(['row-core-1', 'row-core-2', 'row-band'])
    // No HUD state: row 1 owns ctx, and the widget row never draws it.
    expect(first.text('row-core-1')).toContain('ctx 42%')
    expect(first.text('row-band')).not.toContain('ctx')
    expect(first.text('row-hud')).toBeUndefined()
    const second = await draw($, 10)
    expect(second.keys).toEqual(['row-core-1', 'row-core-2', 'row-hud', 'row-band'])
    expect(second.text('row-hud')).toContain('Opus 5.5')
    expect(seen.modelCalls).toBe(3)
  })

  test('HS8 the render that seeds the atom draws ctx in the HUD row only, not on the widget line too', async ($, on) => {
    world(on, { modelFails: 1 })
    await addTask($)
    await measure($)
    const got = await draw($, 10)
    expect(got.text('row-hud')).toContain('ctx 42%')
    expect(got.text('row-band')).toBeDefined()
    expect(got.text('row-band')).not.toContain('ctx')
  })
})

describe('hud ctx owner', () => {
  // Breaks if the HUD row stops drawing `ctx -` for an unknown ctx it owns (maxRows 3 and more), or a row that does not own ctx draws it.
  test('HS9 with the HUD up and ctx unknown, the HUD row reads ctx - right after the model chip, and no other row draws ctx', async ($, on) => {
    world(on)
    const got = await draw($, 10)
    const hud = got.text('row-hud') ?? ''
    expect(hud).toMatch(/Opus 5\.5 +ctx -/)
    for (const key of ['row-core-1', 'row-core-2', 'row-band']) expect(got.text(key) ?? '').not.toContain('ctx')
  })

  // Breaks if the HUD row draws ctx again at maxRows 2, where the compact line owns it.
  test('HS9 at maxRows 2 the compact line owns an unknown ctx as ctx -, and the HUD row does not repeat it', async ($, on) => {
    world(on)
    const got = await draw($, 2, 120)
    expect(got.text('row-core-1')).toContain('ctx -')
    expect(got.text('row-hud') ?? '').not.toContain('ctx')
  })
})

describe('band debug log', () => {
  const debug = { CCV3_MOD_BAND_DEBUG: '1' }

  test('G1 by default no log file is written', async ($, on) => {
    const seen = world(on)
    await start($)
    await addTask($)
    await draw($, 10)
    expect(Object.keys(seen.files).some(path => LOG.test(path))).toBe(false)
  })

  test('G1 a value other than 1 writes no log file', async ($, on) => {
    const seen = world(on, { env: { CCV3_MOD_BAND_DEBUG: '0' } })
    await start($)
    await addTask($)
    await draw($, 10)
    expect(Object.keys(seen.files).some(path => LOG.test(path))).toBe(false)
  })

  test('G2 one render appends one JSON line of numbers and booleans: maxRows, bodyColumns, hudNow, quiet and the lines drawn', async ($, on) => {
    const seen = world(on, { env: debug })
    await start($)
    await addTask($, `fix C:/Users/dave/secret-project/app.ts ${SECRET}`)
    const got = await draw($, 10, 120)
    expect(got.keys).toEqual(['row-core-1', 'row-core-2', 'row-hud', 'row-band'])
    const lines = logOf(seen)
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    expect(entry).toMatchObject({ maxRows: 10, bodyColumns: 120, hudNow: true, quiet: false, lines: 4 })
    for (const value of Object.values(entry)) expect(['number', 'boolean']).toContain(typeof value)
    expect(lines[0]).not.toMatch(/secret-project|Users|\/repo|sk-|build|fix|WORKING|GOAL/)
  })

  test('G3 a second render appends a second line after the first', async ($, on) => {
    const seen = world(on, { env: debug })
    await start($)
    await addTask($)
    await draw($, 6, 100)
    await draw($, 2, 30)
    const entries = logOf(seen).map(line => JSON.parse(line) as Record<string, unknown>)
    expect(entries.map(one => [one.maxRows, one.bodyColumns])).toEqual([
      [6, 100],
      [2, 30],
    ])
    expect(entries[1]?.lines).toBe(2)
  })

  test('G4 the log is capped at 200 lines and the oldest lines drop', async ($, on) => {
    const old = Array.from({ length: 250 }, (_, i) => JSON.stringify({ old: i })).join('\n') + '\n'
    const seen = world(on, { env: debug, files: { 'C:/home/.claude/state/agentic-os/band-debug.log': old } })
    await start($)
    await addTask($)
    await draw($, 7, 120)
    const lines = logOf(seen)
    expect(lines).toHaveLength(200)
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({ old: 51 })
    expect(JSON.parse(lines[198] ?? '{}')).toEqual({ old: 249 })
    expect(JSON.parse(lines[199] ?? '{}')).toMatchObject({ maxRows: 7, bodyColumns: 120 })
  })

  test('G5 a failing write does not break the render', async ($, on) => {
    const seen = world(on, { env: debug, logWriteFails: true })
    await start($)
    await addTask($)
    const got = await draw($, 10)
    expect(got.keys).toEqual(['row-core-1', 'row-core-2', 'row-hud', 'row-band'])
    expect(logOf(seen)).toEqual([])
  })

  test('G6 nothing reaches the session: no session.append', async ($, on) => {
    const seen = world(on, { env: debug })
    await start($)
    await addTask($)
    await draw($, 10)
    expect(logOf(seen)).toHaveLength(1)
    expect(seen.appended).toBe(0)
  })

  test('G6 CCV3_MODS_OFF=1 writes no log', async ($, on) => {
    const seen = world(on, { env: { ...debug, CCV3_MODS_OFF: '1' } })
    await draw($, 10)
    expect(Object.keys(seen.files).some(path => LOG.test(path))).toBe(false)
  })

  test('G7 with the HUD off the line says hudNow false and counts the rows drawn', async ($, on) => {
    const seen = world(on, { env: { ...debug, CCV3_MOD_HUD_OFF: '1' } })
    await start($)
    await addTask($)
    await draw($, 3, 120)
    const entry = JSON.parse(logOf(seen)[0] ?? '{}') as Record<string, unknown>
    expect(entry).toMatchObject({ maxRows: 3, hudNow: false, quiet: false, lines: 3 })
  })
})

describe('band must-haves: ctx, 5h and 7d in every row budget', () => {
  const BOTH = [
    { kind: 'five_hour', percentUsed: 38 },
    { kind: 'seven_day', percentUsed: 61 },
  ]
  const FIVE = /5h\D{0,12}38%/
  const SEVEN = /7d\D{0,12}61%/
  const everything = (got: Drawn): string => got.keys.map(key => got.text(key ?? '') ?? '').join('\n')
  // A working session (one task, one helper) with both windows known: the HUD seeded by session.start, ctx 42% measured, limits carried by the measure.
  const ready = async ($: Engine, on: On, w: World = {}) => {
    world(on, { usageLimits: BOTH, ...w })
    await start($)
    await addTask($)
    await spawn($)
    await measure($, { rateLimits: w.usageLimits ?? BOTH, changed: ['context', 'rateLimits'] })
  }

  test('M1 every row budget at widths 20, 40 and 120 shows ctx', async ($, on) => {
    await ready($, on)
    for (const width of [20, 40, 120]) {
      for (const maxRows of [1, 2, 3, 4]) {
        const shown = everything(await draw($, maxRows, width)).includes('ctx 42%')
        expect({ width, maxRows, shown }).toEqual({ width, maxRows, shown: true })
      }
    }
  })

  test('M2 maxRows 1 at 120 columns is the one-row line with ctx, 5h, 7d and the goal, no cost, and no HUD row', async ($, on) => {
    await ready($, on)
    const got = await draw($, 1, 120)
    expect(got.keys).toEqual(['row-core-1'])
    const line = got.text('row-core-1') ?? ''
    for (const part of ['WORKING', 'ctx 42%', '5h 38%', '7d 61%', 'goal not set']) expect(line).toContain(part)
    for (const word of ['$', 'lane ', 'GOAL', 'helper']) expect(line).not.toContain(word)
  })

  test('M3 maxRows 1 at 40 columns shows the chip, ctx, 5h and 7d; at 20 columns the chip and ctx, in 20 cells', async ($, on) => {
    await ready($, on)
    const forty = (await draw($, 1, 40)).text('row-core-1') ?? ''
    for (const part of ['WORKING', 'ctx 42%', '5h 38%', '7d 61%']) expect(forty).toContain(part)
    expect(forty.length).toBeLessThanOrEqual(40)
    const twenty = (await draw($, 1, 20)).text('row-core-1') ?? ''
    expect(twenty).toContain('WORKING')
    expect(twenty).toContain('ctx 42%')
    expect(twenty.length).toBeLessThanOrEqual(20)
  })

  test('M4 with room for the HUD row the 5h and 7d figures are drawn, at 40 and 120 columns', async ($, on) => {
    await ready($, on)
    for (const width of [40, 120]) {
      for (const maxRows of [2, 3, 4]) {
        const got = everything(await draw($, maxRows, width))
        // Each figure draws once: the compact line or the HUD row owns it, never both.
        const times = (pattern: RegExp) => (got.match(new RegExp(pattern.source, 'g')) ?? []).length
        expect({ width, maxRows, five: times(FIVE), seven: times(SEVEN) }).toEqual({ width, maxRows, five: 1, seven: 1 })
      }
    }
  })

  test('M5 at 20 columns a budget of 2 to 4 rows keeps the chip on core row 1 and draws ctx once, in 20 cells', async ($, on) => {
    await ready($, on)
    for (const maxRows of [2, 3, 4]) {
      const got = await draw($, maxRows, 20)
      const line = got.text('row-core-1') ?? ''
      const all = got.keys.map(key => got.text(key ?? '') ?? '').join('\n')
      expect({ maxRows, chip: line.includes('WORKING'), ctx: all.split('ctx 42%').length - 1, fits: got.keys.every(key => (got.text(key ?? '') ?? '').length <= 20) }).toEqual({ maxRows, chip: true, ctx: 1, fits: true })
    }
  })

  test('M6 an account with no 5h or 7d window shows nothing for them: no dash, no made-up figure', async ($, on) => {
    await ready($, on, { usageLimits: [] })
    const line = (await draw($, 1, 120)).text('row-core-1') ?? ''
    expect(line).toContain('ctx 42%')
    for (const word of ['5h', '7d', 'null', 'undefined', 'NaN']) expect(line).not.toContain(word)
  })

  test('M6 an account with only a 5-hour window shows 5h and nothing for 7d', async ($, on) => {
    await ready($, on, { usageLimits: [{ kind: 'five_hour', percentUsed: 38 }] })
    const line = (await draw($, 1, 120)).text('row-core-1') ?? ''
    expect(line).toContain('5h 38%')
    expect(line).not.toContain('7d')
  })

  test('M7 limits not known yet draw no limit field and no value; the next render that seeds the HUD fills them', async ($, on) => {
    world(on, { modelFails: 2, usageLimits: BOTH })
    await addTask($)
    await measure($, { rateLimits: BOTH, changed: ['context', 'rateLimits'] })
    const first = (await draw($, 1, 120)).text('row-core-1') ?? ''
    expect(first).toContain('ctx 42%')
    expect(first).not.toMatch(/5h|7d|\$/)
    const second = (await draw($, 1, 120)).text('row-core-1') ?? ''
    expect(second).toContain('5h 38%')
    expect(second).toContain('7d 61%')
  })

  test('M8 a resumed session (HUD atom null, no session.start) shows 5h and 7d once the self-seed read the usage', async ($, on) => {
    world(on, { usageLimits: BOTH })
    const one = (await draw($, 1, 120)).text('row-core-1') ?? ''
    expect(one).toContain('5h 38%')
    expect(one).toContain('7d 61%')
    expect(one).not.toContain('$')
    const roomy = everything(await draw($, 4, 120))
    expect(FIVE.test(roomy)).toBe(true)
    expect(SEVEN.test(roomy)).toBe(true)
  })

  test('M8 a resumed session whose first event is a measure shows ctx, 5h and 7d on the compact line', async ($, on) => {
    world(on, { usageLimits: BOTH })
    await measure($, { rateLimits: BOTH, changed: ['context', 'rateLimits'] })
    const line = (await draw($, 1, 120)).text('row-core-1') ?? ''
    for (const part of ['ctx 42%', '5h 38%', '7d 61%']) expect(line).toContain(part)
  })
})
