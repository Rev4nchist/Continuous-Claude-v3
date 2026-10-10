import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { diffLines, groupSummary, hunksOf, mainArg } from '../hooks/skin/model'

// Ways the CCv3 Skin can fail, one test each.
// K1 it draws while off (the default), or `/skin on` doesn't survive a reload ($.store)
// K2 a tool row misses its argument, timing or error state
// K3 a tool it doesn't know isn't left to the engine
// K4 an Agent row lacks its tier badge (or shows one for an unseen run)
// K5 a collapsed group isn't summarised; an expanded one isn't left to the engine
// K6 an edit's diff card loses line numbers or counts; an errored or patchless result isn't left to the engine
// K7 the terminal gets Svg icons
// K8 CCV3_MOD_SKIN_OFF still draws
// K10 a terminal session draws skin rows (Skin is desktop-only)
// K9 a row carrying its own output (verbose, expanded group) or a staged edit is redrawn by the skin, hiding it;
//    a stray /skin argument flips the setting

const store: Record<string, unknown> = {}

const world = (on: On, env: Record<string, string> = {}) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, env)
  mock.store(on, store)
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, { key: 'engine' }) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: {} }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('tool.call', { tool: 'Read' }, async ($, e) => {
    await clock.advance(200)
    return { result: { type: 'text', file: { filePath: e.file_path } } }
  })
  return { clock }
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
const skinOn = ($: Engine) => $.command.run({ command: 'skin', args: 'on', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)

const USE = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  tool_use_id: 'u1',
  tool,
  input,
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  ...extra,
})

const draw = async ($: Engine, component: 'ToolUse' | 'ToolResult' | 'ToolGroup', props: unknown, surface: 'terminal' | 'desktop' = 'desktop') => {
  const ui = await $.ui.mount({ plugin: 'ccv3-mods', surface, component, props } as never)
  const skinned = (await ui.findAll({ type: 'Box' })).find(found => found.key?.startsWith('skin-'))
  const svgs = (await ui.findAll({ type: 'Svg' })).length
  await ui.unmount()
  return { text: skinned?.text, key: skinned?.key, svgs }
}

const PATCH = { structuredPatch: [{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 3, lines: [' keep', '-old', '+new', '+more'] }] }

describe('skin', () => {
  test('K1 off by default; /skin on draws and survives a reload', async ($, on) => {
    for (const key of Object.keys(store)) delete store[key]
    world(on)
    await start($)
    expect((await draw($, 'ToolUse', USE('Read', { file_path: '/repo/a.ts' }))).key).toBeUndefined()
    await skinOn($)
    expect((await draw($, 'ToolUse', USE('Read', { file_path: '/repo/a.ts' }))).key).toBe('skin-row')
    await start($)
    expect((await draw($, 'ToolUse', USE('Read', { file_path: '/repo/a.ts' }))).key).toBe('skin-row')
  })

  test('K2 K7 a row shows the argument and timing; Svg on desktop only; errors marked', async ($, on) => {
    world(on)
    await start($)
    await skinOn($)
    await $.tool.call({ tool: 'Read', file_path: '/repo/hooks/a/b/c.ts', tool_use_id: 'u1' } as never)
    const desktop = await draw($, 'ToolUse', USE('Read', { file_path: '/repo/hooks/a/b/c.ts' }))
    expect(desktop.text).toContain('…/a/b/c.ts')
    expect(desktop.text).toContain('0.2s')
    expect(desktop.svgs).toBe(1)
    expect((await draw($, 'ToolUse', USE('Read', { file_path: '/x' }), 'terminal')).svgs).toBe(0)
    // K10: the terminal keeps the engine's own row, Skin on or not.
    expect((await draw($, 'ToolUse', USE('Read', { file_path: '/x' }), 'terminal')).key).toBeUndefined()
    expect((await draw($, 'ToolUse', USE('Bash', { command: 'npm test\nmore' }, { isErrored: true }))).text).toContain('error')
  })

  test('K3 an unknown tool is left to the engine', async ($, on) => {
    world(on)
    await start($)
    await skinOn($)
    expect((await draw($, 'ToolUse', USE('mcp__x__y', {}))).key).toBeUndefined()
  })

  test('K4 an Agent row carries its run tier', async ($, on) => {
    world(on)
    await start($)
    await skinOn($)
    await $.agent.spawn({ tool_use_id: 'u1', prompt: 'p', description: 'map it', subagentType: 'scout', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
    expect((await draw($, 'ToolUse', USE('Agent', { subagent_type: 'scout', description: 'map it' }))).text).toContain('Sonnet')
    expect((await draw($, 'ToolUse', USE('Agent', { subagent_type: 'x' }, { tool_use_id: 'other' }))).text).not.toContain('Sonnet')
  })

  test('K5 collapsed groups summarise; expanded ones are left alone', async ($, on) => {
    world(on)
    await start($)
    await skinOn($)
    const calls = [
      { tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
      { tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
      { tool: 'Grep', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
    ]
    expect((await draw($, 'ToolGroup', { calls, isActive: false, isExpanded: false })).text).toContain('Explored 3 calls · 2 Read · 1 Grep')
    expect((await draw($, 'ToolGroup', { calls, isActive: false, isExpanded: true })).key).toBeUndefined()
  })

  test('K6 an edit becomes a numbered diff card; errored or patchless results are left alone', async ($, on) => {
    world(on)
    await start($)
    await skinOn($)
    const card = await draw($, 'ToolResult', { tool_use_id: 'u1', tool: 'Edit', output: PATCH, isErrored: false })
    expect(card.text).toContain('+2')
    expect(card.text).toContain('−1')
    expect(card.text).toContain('11')
    expect((await draw($, 'ToolResult', { tool_use_id: 'u1', tool: 'Edit', output: PATCH, isErrored: true })).key).toBeUndefined()
    expect((await draw($, 'ToolResult', { tool_use_id: 'u1', tool: 'Edit', output: 'ok', isErrored: false })).key).toBeUndefined()
  })

  test('K8 the off switch never draws', async ($, on) => {
    world(on, { CCV3_MOD_SKIN_OFF: '1' })
    store.skin = 'on'
    await start($)
    expect((await draw($, 'ToolUse', USE('Read', { file_path: '/repo/a.ts' }))).key).toBeUndefined()
  })

  test('K6 pure: diff numbering, counts and the cut line', () => {
    const hunks = hunksOf(PATCH)
    expect(hunks).not.toBeNull()
    const { lines, added, removed } = diffLines(hunks ?? [], 3)
    expect([added, removed]).toEqual([2, 1])
    expect(lines.map(line => line.number)).toEqual(['10', '11', '11', ''])
    expect(lines.at(-1)?.spans[0]?.text).toBe('… 1 more lines')
    expect(groupSummary([{ tool: 'Read', isRunning: true }])).toBe('Exploring 1 call · 1 Read')
    expect(mainArg('Grep', { pattern: 'foo', path: '/a/b/c/d' })).toBe('foo in …/b/c/d')
  })

  test('K9 rows with inline output and staged edits are left to the engine; bad /skin args change nothing', async ($, on) => {
    world(on)
    await start($)
    await skinOn($)
    expect((await draw($, 'ToolUse', USE('Bash', { command: 'npm test' }, { isErrored: true, output: 'boom' }))).key).toBeUndefined()
    expect((await draw($, 'ToolResult', { tool_use_id: 'u1', tool: 'Edit', output: { ...PATCH, staged: true }, isErrored: false })).key).toBeUndefined()
    const said = await $.command.run({ command: 'skin', args: 'maybe', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
    expect(said).toMatchObject({ text: expect.stringContaining('Usage') })
    expect((await draw($, 'ToolUse', USE('Read', { file_path: '/repo/a.ts' }))).key).toBe('skin-row')
  })
})
