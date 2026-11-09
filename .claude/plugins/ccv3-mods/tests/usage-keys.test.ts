import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { usageKeysProbe } from '../hooks/shared/diag'
import { REAL_USAGE } from './fixtures/ledger-real-usage'

// The live turn.step usage probe: which fields does the live feed carry? (Method doc 2026-11-09, section 7.)
// Ways it can fail, one test each. Checks read the files the probe writes under ~/.claude/state/ccv3-mods/usage-keys/.
// K1 a main-loop step with usage writes no key list, or one without the cache_creation keys or the iterations count, keys and types
// K2 a subagent step with no ledger run (the case under suspicion) writes nothing
// K3 the same key set twice in one session writes twice; a changed key set writes nothing new
// K4 a token value or a model id reaches the file (keys and a count only)
// K5 a step with no usage, or CCV3_MODS_OFF, writes a file
// K6 a failing write changes the step's result or throws
// K7 a subagent's key set is taken for the main loop's (same keys, same file)
// K8 a malformed usage (iterations not a list, cache_creation null) throws or writes values

const posix = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '')
const DIR = '/home/me/.claude/state/ccv3-mods/usage-keys/'

const beneath: { usage: Record<string, unknown> | null } = { usage: null }

const world = (on: On, opts: { env?: Record<string, string>; failWrite?: boolean } = {}) => {
  const writes: Record<string, string> = {}
  mock.clock(on, { now: 1_000 })
  mock.env(on, { HOME: '/home/me', ...opts.env })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: {} }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.exists', (_$, e) => ({ value: posix(e.path) in writes }))
  on('fs.read', () => ({ value: '' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.write', (_$, e) => {
    if (opts.failWrite) throw new Error('disk full')
    writes[posix(e.path)] = e.text
    return { value: undefined }
  })
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: beneath.usage as never }
  })
  return writes
}

const step = async ($: Engine, usage: Record<string, unknown> | null, agentId?: string) => {
  beneath.usage = usage
  const stream = $.turn.step({ turnId: 't1', index: 0, messageCount: 1, model: 'claude-sonnet-5-5', effort: 'high', ...(agentId ? { agentId } : {}) } as never)
  let next = await stream.next()
  while (!next.done) next = await stream.next()
  return next.value
}

const probeFiles = (writes: Record<string, string>) => Object.keys(writes).filter(path => path.startsWith(DIR))
const parsed = (writes: Record<string, string>) => probeFiles(writes).map(path => JSON.parse(writes[path]!) as Record<string, unknown>)

// A real subagent usage record: cache_creation, server_tool_use and one message iteration.
const RICH = REAL_USAGE.runA.steps[0]!.usage
// A real record that carries advisor iterations, if the fixture has one.
const WITH_ADVISOR = REAL_USAGE.runA.steps.map(s => s.usage).find(u => JSON.stringify(u.iterations).includes('advisor_message'))!
const FLAT = { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

describe('usage keys probe', () => {
  test('K1 a main-loop step records top-level keys, cache_creation keys, iteration count, keys and types', async ($, on) => {
    const writes = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($, WITH_ADVISOR)
    const [probe] = parsed(writes)
    expect(probe).toBeDefined()
    expect(probe!.where).toBe('main')
    expect(probe!.keys).toEqual(Object.keys(WITH_ADVISOR).sort())
    expect(probe!.cacheCreationKeys).toEqual(['ephemeral_1h_input_tokens', 'ephemeral_5m_input_tokens'])
    const iterations = probe!.iterations as { count: number; keys: string[]; types: string[] }
    expect(iterations.count).toBe((WITH_ADVISOR.iterations as unknown[]).length)
    expect(iterations.types).toContain('advisor_message')
    expect(iterations.keys).toContain('model')
  })

  test('K2 a subagent step with no ledger run is recorded as a subagent', async ($, on) => {
    const writes = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($, RICH, 'ghost-agent')
    const [probe] = parsed(writes)
    expect(probe).toBeDefined()
    expect(probe!.where).toBe('subagent')
    expect(probe!.keys).toEqual(Object.keys(RICH).sort())
  })

  test('K3 once per distinct key set per session', async ($, on) => {
    const writes = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($, FLAT)
    await step($, { ...FLAT, output_tokens: 99 })
    expect(probeFiles(writes)).toHaveLength(1)
    await step($, { ...FLAT, iterations: [{ type: 'message', input_tokens: 1 }] })
    expect(probeFiles(writes)).toHaveLength(2)
  })

  test('K7 the same keys on the main loop and a subagent are two records', async ($, on) => {
    const writes = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($, FLAT)
    await step($, FLAT, 'sub1')
    expect(parsed(writes).map(p => p.where).sort()).toEqual(['main', 'subagent'])
  })

  test('K4 no token value and no model id in the file', async ($, on) => {
    const writes = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($, { ...WITH_ADVISOR, model: 'claude-sonnet-5-5' })
    // `at` (the time) holds digits by design; every other field is a key, a label or a one-digit count.
    const text = parsed(writes).map(({ at: _at, ...rest }) => JSON.stringify(rest)).join('\n')
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toMatch(/\d{3,}/)
    expect(text).not.toContain('claude-')
  })

  test('K5 a step with no usage writes no file', async ($, on) => {
    const writes = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($, null)
    await step($, null, 'sub1')
    expect(probeFiles(writes)).toHaveLength(0)
  })

  test('K5 CCV3_MODS_OFF writes no file', async ($, on) => {
    const writes = world(on, { env: { CCV3_MODS_OFF: '1' } })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($, FLAT)
    await step($, FLAT, 'sub1')
    expect(probeFiles(writes)).toHaveLength(0)
  })

  test('K6 a failing write leaves the result as the engine gave it', async ($, on) => {
    world(on, { failWrite: true })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const main = await step($, FLAT)
    const sub = await step($, FLAT, 'sub1')
    expect(main.answer).toBe('ok')
    expect(main.usage).toMatchObject(FLAT)
    expect(sub.usage).toMatchObject(FLAT)
  })
})

describe('usageKeysProbe', () => {
  test('K8 a malformed usage gives keys and no values', () => {
    const probe = usageKeysProbe({ ...FLAT, iterations: 'x', cache_creation: null } as never, 'main')
    expect(probe).not.toBeNull()
    expect(JSON.parse(probe!.text)).toMatchObject({ keys: expect.any(Array) })
    expect(probe!.text).not.toContain('"x"')
    expect(usageKeysProbe(null, 'main')).toBeNull()
  })

  test('K3 the signature ignores values and order, and changes with keys, iteration types and where', () => {
    const a = usageKeysProbe({ b: 1, a: 2 } as never, 'main')!
    const b = usageKeysProbe({ a: 9, b: 8 } as never, 'main')!
    expect(a.signature).toBe(b.signature)
    expect(usageKeysProbe({ a: 1, b: 2, c: 3 } as never, 'main')!.signature).not.toBe(a.signature)
    expect(usageKeysProbe({ a: 1, b: 2 } as never, 'subagent')!.signature).not.toBe(a.signature)
    const msg = usageKeysProbe({ iterations: [{ type: 'message' }] } as never, 'main')!
    const adv = usageKeysProbe({ iterations: [{ type: 'message' }, { type: 'advisor_message' }] } as never, 'main')!
    expect(msg.signature).not.toBe(adv.signature)
  })
})
