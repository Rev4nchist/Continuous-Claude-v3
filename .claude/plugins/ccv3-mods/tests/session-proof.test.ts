import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// last-session.json is one slot that every session overwrites, so it cannot say whether the desktop attached.
// The per-session proof is sessions/<id>.<trigger>.json. Ways it can fail, one test each.
// P1 a start leaves no per-session file
// P2 an attach overwrites the start file, or leaves no file of its own
// P3 an attach from a surface other than desktop is lost, draws a UI, or overwrites the slot
// P4 a second session overwrites the first one's files
// P5 the off switch still writes proof

type Write = { path: string; text: string }

const world = (on: On, env: Record<string, string> = {}) => {
  const writes: Write[] = []
  const commands: string[] = []
  const ids = { current: 's1' }
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { USERPROFILE: 'C:/home', ...env })
  mock.store(on, {})
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.id', () => ({ value: ids.current }))
  on('session.root', () => ({ value: 'C:/r' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: 1 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: {} }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_$, e) => {
    // Windows reports backslash paths; record forward slashes so the suffix checks hold on every OS.
    writes.push({ path: e.path.replace(/\\/g, '/'), text: e.text })
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', (_$, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return { writes, commands, ids }
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/r', surface: null, isInteractive: false } as never)
const attach = ($: Engine, surface: string) => $.session.attach({ surface, clientId: `${surface}:default` } as never)

/** The parsed proof written to sessions/<name>, or null when no such file was written. */
const proof = (writes: Write[], name: string) => {
  const hit = writes.filter(w => w.path.endsWith(`/ccv3-mods/sessions/${name}`)).at(-1)
  return hit ? (JSON.parse(hit.text) as Record<string, unknown>) : null
}
const slot = (writes: Write[]) => writes.filter(w => w.path.endsWith('/ccv3-mods/last-session.json')).map(w => JSON.parse(w.text) as Record<string, unknown>)

describe('per-session proof', () => {
  test('P1 P2 a start and a desktop attach each leave their own file', async ($, on) => {
    const { writes } = world(on)
    await start($)
    await attach($, 'desktop')
    expect(proof(writes, 's1.start.json')).toMatchObject({ trigger: 'start', isInteractive: false, surface: null, sessionId: 's1' })
    expect(proof(writes, 's1.attach.json')).toMatchObject({ trigger: 'attach', surface: 'desktop', sessionId: 's1' })
  })

  test('P3 an attach from another surface is recorded, draws nothing and leaves the slot alone', async ($, on) => {
    const { writes, commands } = world(on)
    await start($)
    await attach($, 'vscode')
    expect(proof(writes, 's1.attach.json')).toMatchObject({ trigger: 'attach', surface: 'vscode', sessionId: 's1' })
    expect(commands.filter(c => ['os', 'ledger', 'files', 'skin'].includes(c))).toEqual([])
    expect(slot(writes).at(-1)).toMatchObject({ trigger: 'start' })
  })

  test('P4 a second session never overwrites the first one', async ($, on) => {
    const { writes, ids } = world(on)
    await start($)
    await attach($, 'desktop')
    ids.current = 's2'
    await start($)
    expect(proof(writes, 's2.start.json')).toMatchObject({ sessionId: 's2' })
    expect(proof(writes, 's1.attach.json')).toMatchObject({ surface: 'desktop', sessionId: 's1' })
    expect(slot(writes).at(-1)).toMatchObject({ sessionId: 's2' })
  })

  test('P5 CCV3_MODS_OFF=1 writes no proof, for a start or an attach', async ($, on) => {
    const { writes } = world(on, { CCV3_MODS_OFF: '1' })
    await start($)
    await attach($, 'vscode')
    await attach($, 'desktop')
    expect(writes.filter(w => w.path.includes('/ccv3-mods/'))).toEqual([])
  })
})
