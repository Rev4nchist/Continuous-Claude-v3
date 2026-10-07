import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Ways the Agentic OS capture can fail, one test each. Every check reads the
// band the person sees, not the state behind it.
// F1 a TaskCreate result is not folded in (wrong field path), so the count is wrong
// F2 a TaskUpdate status is not applied, or a deleted task stays counted
// F3 a failed TaskUpdate (success false) still changes the band
// F4 a TodoWrite list does not replace the task list
// F5 the band draws on an idle session
// F6 the observer changes the tool's answer

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

// The engine beneath the plugin: a clock, no home folder (so no snapshot
// file), and an empty band when the plugin passes on.
const world = (on: On) => {
  mock.clock(on, { now: 1_000 })
  mock.env(on, {})
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
}

const bandOn = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string | undefined> => {
  const band = await $.ui.mount({ plugin: 'ccv3-mods', surface, component: 'AbovePrompt', props: BAND_PROPS })
  const text = (await band.find({ key: 'row-band' }))?.text
  await band.unmount()
  return text
}

describe('agentic-os capture', () => {
  test('F1 F2 a created task counts, shows as active, then drops out on delete', async ($, on) => {
    world(on)
    let next = 0
    on('tool.call', { tool: 'TaskCreate' }, (_$, e) => ({ result: { task: { id: String(++next), subject: e.subject } } }))
    on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({
      result: { success: true, taskId: e.taskId, updatedFields: ['status'] },
    }))

    await $.tool.call({ tool: 'TaskCreate', subject: 'scaffold', description: 'd', activeForm: 'Scaffolding' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'probe', description: 'd' })
    expect(await bandOn($)).toContain('0/2 done')

    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
    expect(await bandOn($)).toContain('▶ Scaffolding')

    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'deleted' })
    expect(await bandOn($)).toContain('1/1 done')
  })

  test('F3 a failed TaskUpdate leaves the band as it was', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'a' } } }))
    on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({
      result: { success: false, taskId: e.taskId, updatedFields: [], error: 'no such task' },
    }))

    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'd' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
    expect(await bandOn($)).toContain('0/1 done')
  })

  test('F4 TodoWrite replaces the list with its new todos', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'old' } } }))
    on('tool.call', { tool: 'TodoWrite' }, (_$, e) => ({ result: { oldTodos: [], newTodos: e.todos } }))

    await $.tool.call({ tool: 'TaskCreate', subject: 'old', description: 'd' })
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'one', status: 'completed', activeForm: 'Doing one' },
        { content: 'two', status: 'in_progress', activeForm: 'Doing two' },
        { content: 'three', status: 'pending', activeForm: 'Doing three' },
      ],
    })
    const text = await bandOn($)
    expect(text).toContain('1/3 done')
    expect(text).toContain('▶ Doing two')
  })

  test('F6 the observer hands the tool answer on unchanged', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '7', subject: 'x' } } }))

    const ran = await $.tool.call({ tool: 'TaskCreate', subject: 'x', description: 'd' })
    expect(ran.result).toEqual({ task: { id: '7', subject: 'x' } })
  })
})

describe('agentic-os band', () => {
  test('F5 quiet while idle, drawn on terminal and desktop once tasks exist', async ($, on) => {
    world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'a' } } }))
    for (const surface of ['terminal', 'desktop'] as const) {
      expect(await bandOn($, surface)).toBeUndefined()
    }

    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'd' })

    for (const surface of ['terminal', 'desktop'] as const) {
      expect(await bandOn($, surface)).toContain('0/1 done')
    }
  })
})
