import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// The desktop app drives Claude Code through the SDK: its session starts with isInteractive false and surface null,
// and the desktop joins later by session.attach. Found live 2026-10-10 (desktop 2.31226.1, Claude Code 2.1.295):
// the mods loaded (pr_status was there) and drew nothing. Ways the attach path can fail, one test each.
// A1 a desktop attach registers no commands, so /os /ledger /files say "Unknown command"
// A2 a desktop attach leaves no proof, or the proof can't tell an attach from a start
// A3 a desktop attach draws no HUD row
// A4 two attaches (a reconnect) arm two pulses
// A6 a headless run that nothing attaches to starts any UI (commands, pulse)

type Seen = { commands: string[]; writes: { path: string; text: string }[]; agentList: number }

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} }

const world = (on: On) => {
  const seen: Seen = { commands: [], writes: [], agentList: 0 }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { USERPROFILE: 'C:/home' })
  mock.store(on, {})
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: 'C:/r' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens: 330_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }] },
  }))
  on('settings.read', () => ({ value: {} }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_$, e) => {
    // Windows reports backslash paths; record forward slashes so the suffix checks hold on every OS.
    seen.writes.push({ path: e.path.replace(/\\/g, '/'), text: e.text })
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.list', () => {
    seen.agentList += 1
    return { value: [] }
  })
  on('command.register', (_$, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return { seen, clock }
}

/** How the desktop app opens a session: an SDK start, then the desktop attaches. */
const desktopSession = async ($: Engine, attaches = 1) => {
  await $.session.start({ cwd: 'C:/r', surface: null, isInteractive: false } as never)
  for (let i = 0; i < attaches; i++) await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' } as never)
}

describe('desktop attach', () => {
  test('A1 an attach registers the commands', async ($, on) => {
    const { seen } = world(on)
    await desktopSession($)
    expect(seen.commands).toEqual(expect.arrayContaining(['os', 'ledger', 'files']))
  })

  test('A2 the proof says attach, desktop', async ($, on) => {
    const { seen } = world(on)
    await desktopSession($)
    const proofs = seen.writes.filter(w => w.path.endsWith('C:/home/.claude/state/ccv3-mods/last-session.json'))
    expect(JSON.parse(proofs.at(-1)?.text ?? '{}')).toMatchObject({ trigger: 'attach', surface: 'desktop', sessionId: 's1' })
    expect(JSON.parse(proofs[0]?.text ?? '{}')).toMatchObject({ trigger: 'start', isInteractive: false, surface: null })
  })

  test('A3 an attached desktop session draws the HUD row', async ($, on) => {
    world(on)
    await desktopSession($)
    const band = await $.ui.mount({ plugin: 'ccv3-mods', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ key: 'row-hud' })).toBeTruthy()
    await band.unmount()
  })

  test('A4 a second attach arms no second pulse', async ($, on) => {
    const once = world(on)
    await desktopSession($, 2)
    const before = once.seen.agentList
    await once.clock.advance(5_000)
    const perPulse = once.seen.agentList - before
    expect(perPulse).toBeLessThanOrEqual(1)
  })

  test('A6 a headless run with no attach starts no UI', async ($, on) => {
    const { seen, clock } = world(on)
    await $.session.start({ cwd: 'C:/r', surface: null, isInteractive: false } as never)
    await clock.advance(10_000)
    expect(seen.commands.filter(c => ['os', 'ledger', 'files'].includes(c))).toEqual([])
    expect(seen.agentList).toBe(0)
  })
})
