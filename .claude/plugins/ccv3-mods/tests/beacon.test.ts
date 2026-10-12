import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Desktop sessions left no proof file at all (2026-10-12), and every other write in the mod swallows its error.
// The beacon is written first, before the off check and any atom, so it says how far a session got.
// Ways it can fail, one test each.
// B1 the start hook leaves no `enter` file, or leaves one without the facts that explain a missing home
// B2 the off switch does not keep the beacon quiet (off means the module writes nothing)
// B3 a start hook that throws leaves no `error` file naming where
// B4 no home directory: no file anywhere, or one that does not say why
// B5 the home write fails: no fallback file, or one that hides the failure
// B6 the first turn leaves no `turn` file, or a second turn writes it again
// B7 both writes failing breaks the session

type Write = { path: string; text: string }
type Opts = { env?: Record<string, string>; isThrowAfterEnter?: boolean; failFs?: (path: string) => boolean }

const world = (on: On, opts: Opts = {}) => {
  const writes: Write[] = []
  const env = opts.env ?? { USERPROFILE: 'C:/home', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }
  const armed = { isOn: false }
  mock.clock(on, { now: 1_000_000 })
  // With isThrowAfterEnter the first off-switch read after the enter beacon throws: that read is the start hook's own.
  on('env.get', (_$, e) => {
    if (opts.isThrowAfterEnter && armed.isOn && e.name === 'CCV3_MODS_OFF') {
      armed.isOn = false
      throw new Error('env boom')
    }
    return { value: env[e.name] }
  })
  mock.store(on, {})
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: 'C:/r' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: 1 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: {} }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_$, e) => {
    // Windows reports backslash paths; record forward slashes so the suffix checks hold on every OS.
    const path = e.path.replace(/\\/g, '/')
    if (opts.failFs?.(path)) throw new Error(`EACCES ${path}`)
    writes.push({ path, text: e.text })
    if (path.endsWith('.enter.json')) armed.isOn = true
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return { writes }
}

const start = ($: Engine, isInteractive = false) => $.session.start({ cwd: 'C:/r', surface: isInteractive ? 'terminal' : null, isInteractive } as never)
const turn = ($: Engine) => $.turn.start({ turnId: 't1' } as never)

/** The parsed file whose path ends with `tail`, or null when none was written. */
const file = (writes: Write[], tail: string) => {
  const hit = writes.filter(w => w.path.endsWith(tail)).at(-1)
  return hit ? (JSON.parse(hit.text) as Record<string, unknown>) : null
}
const SESSIONS = '/.claude/state/ccv3-mods/sessions/'

describe('beacon', () => {
  test('B1 a start leaves an enter file with the facts', async ($, on) => {
    const { writes } = world(on)
    await start($)
    expect(file(writes, `${SESSIONS}s1.enter.json`)).toMatchObject({
      name: 'enter',
      sessionId: 's1',
      entrypoint: 'claude-desktop',
      hasUserProfile: true,
      hasHome: false,
      isInteractive: false,
      via: 'home',
    })
  })

  test('B2 CCV3_MODS_OFF=1 writes no beacon', async ($, on) => {
    const { writes } = world(on, { env: { USERPROFILE: 'C:/home', CCV3_MODS_OFF: '1' } })
    await start($)
    await turn($)
    expect(writes).toEqual([])
  })

  test('B3 a start hook that throws leaves an error file naming where', async ($, on) => {
    const { writes } = world(on, { isThrowAfterEnter: true })
    await start($).catch(() => undefined)
    expect(file(writes, `${SESSIONS}s1.enter.json`)).toMatchObject({ name: 'enter' })
    expect(file(writes, `${SESSIONS}s1.error.json`)).toMatchObject({ name: 'error', where: 'session.start' })
    expect(String(file(writes, `${SESSIONS}s1.error.json`)?.message ?? '')).not.toBe('')
  })

  test('B4 no home directory: the beacon falls back to the working folder and says why', async ($, on) => {
    const { writes } = world(on, { env: {} })
    await start($)
    expect(file(writes, '/.claude/cache/e2e/beacon-s1.enter.json')).toMatchObject({
      via: 'cwd',
      primaryFailed: 'no home directory',
      hasUserProfile: false,
      hasHome: false,
    })
  })

  test('B5 a failed home write falls back to the working folder and names the failure', async ($, on) => {
    const { writes } = world(on, { failFs: p => p.includes('/ccv3-mods/sessions/') })
    await start($)
    const fallback = file(writes, '/.claude/cache/e2e/beacon-s1.enter.json')
    expect(fallback).toMatchObject({ via: 'cwd' })
    // A refused write rejects; the reason is kept so the reader sees it was a failed write, not a missing home.
    expect(String(fallback?.primaryFailed)).toContain('fs.write')
    expect(fallback?.primaryFailed).not.toBe('no home directory')
  })

  test('B6 the first turn leaves a turn file once', async ($, on) => {
    const { writes } = world(on)
    await start($)
    await turn($)
    await turn($)
    expect(file(writes, `${SESSIONS}s1.turn.json`)).toMatchObject({ name: 'turn', sessionId: 's1' })
    expect(writes.filter(w => w.path.endsWith(`${SESSIONS}s1.turn.json`))).toHaveLength(1)
  })

  test('B7 when no beacon can be written the session still starts', async ($, on) => {
    // Only the beacon files fail; the proof the start hook writes after them must still land.
    const { writes } = world(on, { failFs: p => p.endsWith('.enter.json') || p.endsWith('.turn.json') || p.includes('/beacon-') })
    await start($)
    await turn($)
    expect(file(writes, `${SESSIONS}s1.start.json`)).toMatchObject({ trigger: 'start', sessionId: 's1' })
    expect(writes.filter(w => w.path.includes('enter.json') || w.path.includes('turn.json') || w.path.includes('/beacon-'))).toEqual([])
  })
})
