import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { applyBrief } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import { tabRows } from '../hooks/agentic-os/os-tabs-model'
import type { TabState } from '../hooks/agentic-os/os-tabs-model'
import type { PaneRow } from '../hooks/agentic-os/pane-model'
import type { KeeperRecord } from '../types'

// Round 2 review findings that the other test files do not pin. Each test names the source change that breaks it.
// RR1 a home tab (Steps, Checks, Choices) draws an ask, step or proof as one clipped row, so the Overview hint "...more -> <tab>" promises text no tab shows
// RR2 the Session tab throws on a null record in the compactions atom (the Overview keeper line skips it)
// RR3 two keeper records with one time: the row tone follows the first record while the text follows the later one
// RR4 with the HUD off, a quiet session under 40 columns draws the chip and goal with no ctx anywhere
// RR5 /clear or a resume leaves the compactions atom, so the new conversation shows the old summary result
// RR6 the pane ROOM section reads the raw hud atom, so a resumed session shows the band's cost and limits but the pane shows none

const NOW = 1_700_000_000_000
const MIN = 60_000

const empty = (over: Partial<TabState> = {}): TabState => ({
  view: { tasks: [], plan: null, turn: null, step: null, ctx: null, agents: [], lanes: null, prs: [] },
  chip: 'idle',
  brief: null,
  repo: null,
  branch: null,
  worktree: null,
  costUsd: null,
  activeAt: null,
  ...over,
})

const briefWith = (raw: Record<string, unknown>): Brief => {
  const made = applyBrief(null, raw, [], NOW - 1000)
  if ('error' in made) throw new Error(made.error)
  return made.brief
}

const rowText = (row: PaneRow): string => [row.left.map(one => one.text).join(''), ...(row.right ? [row.right.map(one => one.text).join('')] : [])].join(' ')
/** The rows' text on one line with single spaces, so a phrase the wrap split across rows still reads whole. */
const all = (rows: PaneRow[]): string => rows.map(rowText).join(' ').replace(/\s+/g, ' ')
const record = (at: number, kept: boolean): KeeperRecord => ({ at, sessionId: 's', open: 3, total: 7, kept })

const SENTENCE = 'the quick brown fox jumps over the lazy dog and keeps running far beyond the hill '
const LONG = SENTENCE.repeat(2).trim()

describe('home tabs wrap what the Overview hint points to', () => {
  test('RR1 an ask wider than the pane takes up to 3 rows on Choices, its recommendation too, and nothing is clipped to one row', () => {
    const state = empty({ brief: briefWith({ ask: [{ kind: 'question', text: LONG, recommend: LONG }] }), activeAt: NOW })
    const rows = tabRows('decisions', state, NOW, 40, 40)
    const ask = rows.filter(one => /^a-0(-\d)?$/.test(one.key))
    const rec = rows.filter(one => /^a-0-rec(-\d)?$/.test(one.key))
    expect(ask.length).toBeGreaterThan(1)
    expect(rec.length).toBeGreaterThan(1)
    expect(all(ask)).toContain('far beyond')
    expect(all(rec)).toContain('recommend: the quick')
    expect(all(rec)).toContain('far beyond')
    for (const row of rows) expect(row.left.reduce((n, one) => n + one.text.length, 0)).toBeLessThanOrEqual(40)
  })

  test('RR1 a decision wider than the pane wraps on Choices', () => {
    const state = empty({ brief: briefWith({ decision: { text: LONG, by: 'Dave' } }) })
    const rows = tabRows('decisions', state, NOW, 40, 40).filter(one => /^d-0(-\d)?$/.test(one.key))
    expect(rows.length).toBeGreaterThan(1)
    expect(all(rows)).toContain('far beyond')
  })

  test('RR1 a step wider than the pane wraps on Steps, and keeps UNPROVEN beside its first row', () => {
    const state = empty({ brief: briefWith({ plan: [{ id: 'a', text: LONG, status: 'done' }] }) })
    const rows = tabRows('plan', state, NOW, 50, 40)
    const step = rows.filter(one => /^p-a(-\d)?$/.test(one.key))
    expect(step.length).toBeGreaterThan(1)
    expect(all(step)).toContain('far beyond')
    expect(rowText(step[0]!)).toContain('UNPROVEN')
  })

  test('RR1 a short step list whose rows wrap still fits the budget: a cut ends with +N more, never past the rows given', () => {
    const plan = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, text: LONG, status: 'todo' }))
    const rows = tabRows('plan', empty({ brief: briefWith({ plan }) }), NOW, 40, 8)
    expect(rows.length).toBeLessThanOrEqual(8)
    expect(all(rows)).toMatch(/\+\d+ more/)
  })

  test('RR1 an unproven step wider than the pane wraps on Checks', () => {
    const tasks = [{ id: '1', subject: LONG, status: 'completed' as const }]
    const state = empty({ view: { ...empty().view, tasks }, brief: briefWith({ goal: 'g' }) })
    const rows = tabRows('proof', state, NOW, 50, 40).filter(one => /^u-t-1(-\d)?$/.test(one.key))
    expect(rows.length).toBeGreaterThan(1)
    expect(all(rows)).toContain('far beyond')
  })
})

describe('keeper records', () => {
  test('RR2 a null or untimed record in the compactions list does not break the Session tab; the good record still reads', () => {
    const list = [null, { at: 'x' }, record(NOW - MIN, false)] as unknown as KeeperRecord[]
    const rows = tabRows('session', empty({ compactions: list }), NOW, 60, 40)
    expect(all(rows)).toContain('The last summary lost the plan.')
  })

  test('RR3 two records with one time: the Overview row tone follows the later record, as the text does', () => {
    const rows = tabRows('overview', empty({ compactions: [record(NOW - MIN, true), record(NOW - MIN, false)] }), NOW, 80, 40)
    const span = rows.flatMap(one => one.left).find(one => one.text.includes('The last summary'))
    expect(span?.text).toContain('lost the plan')
    expect(span?.tone).toBe('warn')
  })
})

// --- Engine tests: the band and the clear handler ---

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }

const world = (on: On, env: Record<string, string> = {}) => {
  const written: Record<string, unknown[]> = {}
  mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home', ...env })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('settings.read', () => ({ value: {} }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 38 }], cost: { usd: 3.84 } } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('state.set', { plugin: 'ccv3-mods', key: 'compactions' } as never, ((_$: unknown, e: { value: unknown }, next: (e: unknown) => unknown) => {
    ;(written.compactions ??= []).push(e.value)
    return next(e)
  }) as never)
  return written
}

const measure = ($: Engine) =>
  $.session.measure({ startedAt: 0, context: { window: 1_000_000, percent: 42 }, rateLimits: [], changed: ['context'] } as never)

const bandText = async ($: Engine, maxRows: number, bodyColumns: number): Promise<string> => {
  const band = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, maxRows, bodyColumns } })
  const boxes = (await band.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-'))
  await band.unmount()
  return boxes.map(found => found.text).join('\n')
}

describe('band and pane wiring', () => {
  test('RR4 with the HUD off, a quiet session under 40 columns still shows ctx at every budget of 1 to 4 rows', async ($, on) => {
    world(on, { CCV3_MOD_HUD_OFF: '1' })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await measure($)
    for (const columns of [20, 30, 39]) {
      for (const maxRows of [1, 2, 3, 4]) {
        const shown = (await bandText($, maxRows, columns)).includes('ctx 42%')
        expect({ columns, maxRows, shown }).toEqual({ columns, maxRows, shown: true })
      }
    }
  })

  test('RR6 a resumed session (no session.start, nothing measured) shows the seeded cost and 5-hour allowance in the Session tab ROOM section', async ($, on) => {
    world(on)
    const pane = await $.ui.mount({
      plugin: 'ccv3-mods',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'agentic-os',
      props: { title: 'Agentic OS', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      viewport: { columns: 80, rows: 40 },
    })
    await pane.press({ key: 'tab-session' })
    const text = (await pane.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-')).map(found => found.text).join('\n')
    await pane.unmount()
    expect(text).toContain('Spent $3.84 this session')
    expect(text).toContain('38% of the 5-hour allowance used')
  })

  test('RR5 a /clear and a resume empty the compactions atom; other session ends leave it', async ($, on) => {
    const written = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const end = (reason: string) => $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } } as never)
    await end('clear')
    expect(written.compactions).toEqual([[]])
    await end('resume')
    expect(written.compactions).toEqual([[], []])
    await end('other')
    expect(written.compactions).toEqual([[], []])
  })
})
