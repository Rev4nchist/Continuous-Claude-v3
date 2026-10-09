import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Ways Cache Guard can fail, one test each.
// C1 a warm send is held
// C2 a cold send is not held, or is held twice in one cold window
// C3 the held text is not put back in the prompt box (the person would have to retype it)
// C4 a headless run is held: it would never be sent
// C5 a non-composer origin, a mid-turn message, an sdk send is held
// C6 a slash or bang command, or a message with an attachment, is held
// C7 /clear or compaction leaves the old clock, so the fresh context's first send is held
// C8 an interrupted turn doesn't count as a reply (stale clock, a warm send held)
// C9 CCV3_MOD_CACHE_OFF still holds; a surface that can't draw the card holds
// C10 the card stays after Dismiss or a new send, or hides the band when nothing is held
// C11 the cold figure is priced at the 5-minute write on a subscription (1-hour cache)

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 160,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const HOUR = 60 * 60_000

const world = (on: On, env: Record<string, string> = {}, subscription = true) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const sent: string[] = []
  const filled: string[] = []
  mock.env(on, env)
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens: 330_000 }, rateLimits: subscription ? [{ kind: 'five_hour', percentUsed: 10 }] : [] },
  }))
  on('settings.read', () => ({ value: {} }))
  on('session.id', () => ({ value: 's1' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.SessionStart', () => ({}))
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  return { clock, sent, filled }
}

const start = ($: Engine, isInteractive = true, surface: string | null = 'terminal') =>
  $.session.start({ cwd: '/repo', surface: isInteractive ? surface : null, isInteractive } as never)

/** The main loop answered (or was interrupted, which talks to the model just the same). */
const reply = ($: Engine, isAborted = false) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted, turnId: 't', reason: isAborted ? 'aborted' : 'answer' } as never)

const type = ($: Engine, text: string, extra: Record<string, unknown> = {}) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...extra } as never)

const cardText = async ($: Engine) => {
  const band = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  const text = (await band.find({ key: 'row-cache' }))?.text
  await band.unmount()
  return text
}

const HELD = { drop: expect.stringContaining('Cache Guard') }

describe('cache guard', () => {
  test('C1 a warm send goes straight through', async ($, on) => {
    const { clock, sent } = world(on)
    await start($)
    await reply($)
    await clock.advance(10 * 60_000)
    expect(await type($, 'next step')).toMatchObject({ text: 'next step' })
    expect(sent).toEqual(['next step'])
  })

  test('C2 a cold send is held once per cold window', async ($, on) => {
    const { clock, sent } = world(on)
    await start($)
    await reply($)
    await clock.advance(2 * HOUR)
    expect(await type($, 'recap please')).toMatchObject(HELD)
    expect(sent).toHaveLength(0)
    expect(await type($, 'recap please')).toMatchObject({ text: 'recap please' })
    await reply($)
    await clock.advance(2 * HOUR)
    expect(await type($, 'again')).toMatchObject(HELD)
  })

  test('C3 the held text goes back in the prompt box; the card says so', async ($, on) => {
    const { clock, filled } = world(on)
    await start($)
    await reply($)
    await clock.advance(2 * HOUR)
    await type($, 'Where were we?  Give me a 2 line recap.')
    await clock.advance(10)
    expect(filled).toEqual(['Where were we?  Give me a 2 line recap.'])
    expect(await cardText($)).toContain('back in the prompt box')
  })

  test('C4 a headless run is never held', async ($, on) => {
    const { clock } = world(on)
    await start($, false)
    await reply($)
    await clock.advance(2 * HOUR)
    expect(await type($, 'scheduled report')).toMatchObject({ text: 'scheduled report' })
  })

  test('C5 non-composer, mid-turn and sdk sends pass', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await reply($)
    await clock.advance(2 * HOUR)
    expect(await type($, 'from a trigger', { origin: { kind: 'scheduled-trigger' } })).toMatchObject({ text: 'from a trigger' })
    expect(await type($, 'from the sdk', { origin: { kind: 'sdk' } })).toMatchObject({ text: 'from the sdk' })
    expect(await type($, 'queued mid-turn', { turnId: 't9' })).toMatchObject({ text: 'queued mid-turn' })
  })

  test('C6 slash and bang commands and attachments pass', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await reply($)
    await clock.advance(2 * HOUR)
    expect(await type($, '/clear')).toMatchObject({ text: '/clear' })
    expect(await type($, '  !git status')).toMatchObject({ text: '  !git status' })
    expect(await type($, 'look at this', { attachments: [{ type: 'image' }] })).toMatchObject({ text: 'look at this' })
    expect(await type($, 'now a plain one')).toMatchObject(HELD)
  })

  test('C7 /clear and compaction reset the clock', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await reply($)
    await clock.advance(2 * HOUR)
    await $.classic.SessionStart({ source: 'clear' } as never)
    expect(await type($, 'fresh start')).toMatchObject({ text: 'fresh start' })
  })

  test('C8 an interrupted turn counts as a reply', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await reply($)
    await clock.advance(2 * HOUR)
    await reply($, true)
    expect(await type($, 'after the interrupt')).toMatchObject({ text: 'after the interrupt' })
  })

  test('C9 the off switch never holds', async ($, on) => {
    const { clock } = world(on, { CCV3_MOD_CACHE_OFF: '1' })
    await start($)
    await reply($)
    await clock.advance(2 * HOUR)
    expect(await type($, 'go')).toMatchObject({ text: 'go' })
  })

  test('C9 a surface that cannot draw the card never holds', async ($, on) => {
    const { clock } = world(on)
    await start($, true, 'vscode')
    await reply($)
    await clock.advance(2 * HOUR)
    expect(await type($, 'go')).toMatchObject({ text: 'go' })
  })

  test('C10 Dismiss clears the card; a new send clears it too; no hold, no card', async ($, on) => {
    const { clock } = world(on)
    await start($)
    expect(await cardText($)).toBeUndefined()
    await reply($)
    await clock.advance(2 * HOUR)
    await type($, 'hello')
    const band = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    await band.press({ key: 'cg-dismiss' })
    await band.unmount()
    expect(await cardText($)).toBeUndefined()
    await reply($)
    await clock.advance(2 * HOUR)
    await type($, 'first')
    expect(await type($, 'actually, this instead')).toMatchObject({ text: 'actually, this instead' })
    expect(await cardText($)).toBeUndefined()
  })

  test('C11 a subscription prices the cold send at the 1-hour write', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await reply($)
    await clock.advance(2 * HOUR)
    await type($, 'x')
    const text = (await cardText($)) ?? ''
    // 330k × $4 × 2 = $2.64; warm 330k × $0.20 = $0.07
    expect(text).toContain('≈ $2.64')
    expect(text).toContain('≈ $0.07')
    expect(text).toContain('keeps 60 min')
  })
})
