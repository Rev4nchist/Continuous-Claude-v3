import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Ways command registration can fail, one test each. Found live on 2.1.296: `/agents` is a built-in name,
// the engine refused it, the throw failed the session.start chain and /files never registered.
// R1 one refused name stops the other modules' commands
// R2 a refused name leaves no trace (nothing on disk says what broke)
// R3 the Agent Ledger asks for a built-in name again
// R4 a session leaves no proof it loaded, or the proof misses the surface
// R5 /skin comes back: Skin is archived (archive/ccv3-mods-desktop-2026-10) and must register nowhere

type Seen = { commands: string[]; writes: { path: string; text: string }[] }

const world = (on: On, refuse: string[]) => {
  const seen: Seen = { commands: [], writes: [] }
  mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home' })
  mock.store(on, {})
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: 'C:/r' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: {} }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_$, e) => {
    // Windows reports backslash paths; record forward slashes so the suffix checks hold on every OS.
    seen.writes.push({ path: e.path.replace(/\\/g, '/'), text: e.text })
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', (_$, e) => {
    if (refuse.includes(e.name)) throw new Error(`/${e.name} is a built-in command`)
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  return seen
}

const start = ($: Engine, surface: string) => $.session.start({ cwd: 'C:/r', surface, isInteractive: true } as never)

describe('command registration', () => {
  test('R1 R2 a refused name leaves the other commands and a note on disk', async ($, on) => {
    const seen = world(on, ['files'])
    await start($, 'desktop')
    expect(seen.commands).toEqual(expect.arrayContaining(['os', 'ledger', 'watch', 'land']))
    const note = seen.writes.find(w => w.path.includes('/.claude/state/ccv3-mods/errors/'))
    expect(note?.path).toContain('files-register')
    expect(note?.text).toContain('"where": "files-register"')
  })

  test('R3 the ledger registers /ledger, never /agents', async ($, on) => {
    const seen = world(on, [])
    await start($, 'desktop')
    expect(seen.commands).toContain('ledger')
    expect(seen.commands).not.toContain('agents')
  })

  test('R4 each interactive session writes its proof with the surface', async ($, on) => {
    const seen = world(on, [])
    await start($, 'desktop')
    // The test engine resolves C:/ against the plugin folder on Linux, so match the end of the path.
    const proof = seen.writes.find(w => w.path.endsWith('C:/home/.claude/state/ccv3-mods/last-session.json'))
    expect(JSON.parse(proof?.text ?? '{}')).toMatchObject({ surface: 'desktop', sessionId: 's1' })
  })

  test('R5 a terminal session registers /files and never /skin', async ($, on) => {
    const seen = world(on, [])
    await start($, 'terminal')
    expect(seen.commands).not.toContain('skin')
    expect(seen.commands).toContain('files')
  })

  test('R5 a desktop session registers /files and never /skin', async ($, on) => {
    const seen = world(on, [])
    await start($, 'desktop')
    expect(seen.commands).not.toContain('skin')
    expect(seen.commands).toContain('files')
  })
})
