import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Review waiver. A PR comment from the PR author that starts "Review waived by Dave" stops ONE thing: the opening-review question
// that pr_watch queues for Dave. It proves nothing about Dave: the agents post as the PR author too (same account). So it must
// never hide an alert, never change a status text, and never reach the model as "Dave waived". The mock answers `gh pr view`.
// RW1 a waived PR still gets its LIMITED line and toast (the "no finished review ... Do not merge it" alert stays)
// RW2 a waived PR still gets its STALLED line after 60 minutes
// RW3 a waiver comment from an account other than the PR author is ignored: no waiver for the question either
// RW5 a waived PR reads its comments once per head, not once per tick (the ask condition holds on every tick)
// RW6 a comment that only mentions the waiver, or a failed `gh`, is no waiver: the question is queued
// RW7 no opening review question is queued for a waived PR; RW7b a PR with no waiver queues it
// RW8 /watch N --once and pr_status say nothing about a waiver, and read no comments
// RW9 a waiver never changes PROOF: a PR body proof problem still alerts

const SESSION = 'test-session'
const KEY = `pr-watch:${SESSION}`
const TICK = 300_000
const MIN = 60_000
const NOW = 1_000_000
const HEAD_A = 'a'.repeat(40)
const AUTHOR = 'Rev4nchist'
const WAIVER = 'Review waived by Dave: CodeRabbit is rate limited and the change is small.'

type Status = {
  pr: number
  head: string
  headShort: string
  branch: string
  ready: boolean
  reasons: string[]
  mergeable_state: string
  reviewedHead: boolean
  unresolved: number
  rateLimited: boolean
  prState: string
  merged: boolean
}

const status = (pr: number, over: Partial<Status> = {}): Status => ({
  pr,
  head: HEAD_A,
  headShort: 'aaaaaaa',
  branch: 'feat/x',
  ready: false,
  reasons: ['no Greptile check on the head commit yet (review pending)'],
  mergeable_state: 'blocked',
  reviewedHead: false,
  unresolved: 0,
  rateLimited: false,
  prState: 'open',
  merged: false,
  ...over,
})
const LIMITED = (pr: number, extra: string[] = []) =>
  status(pr, { rateLimited: true, reasons: ['Greptile did not finish a review of the head (completed/neutral)', ...extra] })
const FAILED_BUILD = 'check "build" is completed/failure'
const PROOF_REASON = 'PR body proof: no "Proof type:" line. Add the Evidence block from pr-and-commit-style.md (types: bugfix, feature, refactor, ui, harness, docs)'

/** What `gh pr view N --json author,comments` prints. */
const view = (comments: { login: string; body: string }[], author = AUTHOR) => ({
  author: { login: author },
  comments: comments.map(c => ({ author: { login: c.login }, body: c.body })),
})
const WAIVED = view([{ login: AUTHOR, body: WAIVER }])

type Opts = {
  script?: Record<number, Status[]>
  /** The `gh pr view` answer per PR. 'error' is a failed gh. A PR with no entry has no comments. */
  gh?: Record<number, unknown>
  store?: Record<string, unknown>
}

const world = (on: On, opts: Opts = {}) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/home' })
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  const script = opts.script ?? {}
  const seen = { status: [] as number[], gh: [] as string[][], toasts: [] as string[], submits: [] as string[] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }))
  mock.session(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => ({ value: 'C:/r' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('tool.list', () => ({ value: [{ name: 'Bash' }, { name: 'PowerShell' }] as never }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    seen.submits.push(e.text)
    return { text: e.text }
  })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    const done = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    const pr = Number(argv.find(part => /^\d+$/.test(part)))
    if (argv[0] === 'gh') {
      seen.gh.push(argv)
      const reply = opts.gh?.[pr]
      if (reply === 'error') return done(1, '', 'gh: could not resolve host')
      return done(0, JSON.stringify(reply ?? view([])))
    }
    if (!argv.some(part => part.includes('review-status.mjs'))) return done(0, '[]')
    seen.status.push(pr)
    const queue = script[pr] ?? []
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) as Status
    return done(reply.ready ? 0 : 1, JSON.stringify(reply))
  })
  return { clock, seen, store }
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/r', surface: 'terminal', isInteractive: true })

type Doc = { prs: { pr: number; state: string | null }[]; backoffUntil: number }
const stored = (store: Map<string, unknown>): Doc | undefined => store.get(KEY) as Doc | undefined

const watching = (pr: number, over: Record<string, unknown> = {}) => ({
  [KEY]: { prs: [{ pr, state: 'PENDING', whenReady: false, head: HEAD_A, since: NOW - MIN, ...over }], backoffUntil: 0, touched: NOW },
})

const APPLIED_RECORD = {
  pr: 7, state: 'applied', head: HEAD_A, pathway: 'coderabbit', label: 'review:coderabbit', budget: [1, 0], decided_by: 'default',
  capacity: { count: 38, band: 'ok', source: 'manual', date: '2026-10-25' }, session: SESSION, appliedAt: NOW - 40 * MIN,
}

const openingAsks = (store: Map<string, unknown>) => ((store.get(`checkpoint:asks:${SESSION}`) ?? []) as { kind: string }[]).map(a => a.kind)

describe('pr-loop review waiver', () => {
  test('RW1 a waived PR still gets its LIMITED line and toast', { timeoutMs: 30_000 }, async ($, on) => {
    const { clock, seen } = world(on, { store: watching(8), script: { 8: [LIMITED(8)] }, gh: { 8: WAIVED } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toContain('no finished review')
    expect(seen.submits[0]).toContain('Do not merge it')
    expect(seen.toasts.length).toBe(1)
  })

  test('RW2 a waived PR still gets its STALLED line after 60 minutes', async ($, on) => {
    const { clock, seen, store } = world(on, { store: watching(8, { since: NOW - 61 * MIN }), script: { 8: [status(8)] }, gh: { 8: WAIVED } })
    await start($)
    await clock.advance(TICK)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['STALLED'])
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toContain('Do not merge it')
  })

  test('RW3 a waiver comment from another account does not stop the opening question', async ($, on) => {
    const other = view([{ login: 'someone-else', body: WAIVER }])
    const { clock, store } = world(on, { store: { ...watching(7), 'checkpoint:pr:7': APPLIED_RECORD }, script: { 7: [status(7)] }, gh: { 7: other } })
    await start($)
    await clock.advance(TICK)
    expect(openingAsks(store)).toEqual(['opening'])
  })

  test('RW5 a waived PR reads its comments once per head: later ticks use the stored waiver', async ($, on) => {
    const { clock, seen, store } = world(on, { store: { ...watching(7), 'checkpoint:pr:7': APPLIED_RECORD }, script: { 7: [status(7)] }, gh: { 7: WAIVED } })
    await start($)
    await clock.advance(TICK)
    await clock.advance(TICK)
    await clock.advance(TICK)
    expect(seen.gh.length).toBe(1)
    expect(store.get('checkpoint:waived:7')).toBe(HEAD_A)
  })

  test('RW5b a PR with no waiver does not read its comments again once its question is queued', async ($, on) => {
    const { clock, seen, store } = world(on, { store: { ...watching(7), 'checkpoint:pr:7': APPLIED_RECORD }, script: { 7: [status(7)] } })
    await start($)
    await clock.advance(TICK)
    await clock.advance(TICK)
    await clock.advance(TICK)
    expect(openingAsks(store)).toEqual(['opening'])
    expect(seen.gh.length).toBe(1)
  })

  test('RW6 a comment that only quotes the waiver is no waiver: the question is queued', async ($, on) => {
    const quoted = view([{ login: AUTHOR, body: `I asked: was the Review waived by Dave? ${WAIVER}` }])
    const { clock, store } = world(on, { store: { ...watching(7), 'checkpoint:pr:7': APPLIED_RECORD }, script: { 7: [status(7)] }, gh: { 7: quoted } })
    await start($)
    await clock.advance(TICK)
    expect(openingAsks(store)).toEqual(['opening'])
  })

  test('RW6b a failed gh read is no waiver: the question is queued', async ($, on) => {
    const { clock, store } = world(on, { store: { ...watching(7), 'checkpoint:pr:7': APPLIED_RECORD }, script: { 7: [status(7)] }, gh: { 7: 'error' } })
    await start($)
    await clock.advance(TICK)
    expect(openingAsks(store)).toEqual(['opening'])
  })

  test('RW7 a waived PR queues no opening review question', async ($, on) => {
    const { clock, store } = world(on, { store: { ...watching(7), 'checkpoint:pr:7': APPLIED_RECORD }, script: { 7: [status(7)] }, gh: { 7: WAIVED } })
    await start($)
    await clock.advance(TICK)
    expect(openingAsks(store)).toEqual([])
  })

  test('RW7b the same PR with no waiver does queue the opening question', async ($, on) => {
    const { clock, store } = world(on, { store: { ...watching(7), 'checkpoint:pr:7': APPLIED_RECORD }, script: { 7: [status(7)] } })
    await start($)
    await clock.advance(TICK)
    expect(openingAsks(store)).toEqual(['opening'])
  })

  test('RW8 /watch N --once and pr_status say nothing about a waiver, and read no comments', async ($, on) => {
    const { seen } = world(on, { script: { 8: [LIMITED(8)] }, gh: { 8: WAIVED } })
    await start($)
    const watch = await $.command.run({ command: 'watch', args: '8 --once', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    const tool = (await $.tool.call({ tool: 'mcp__ccv3-mods__pr_status', pr: 8 })).result as { text: string }[]
    expect(JSON.stringify(watch).toLowerCase()).not.toContain('waive')
    expect((tool[0]?.text ?? '').toLowerCase()).not.toContain('waive')
    expect(seen.gh).toEqual([])
  })

  test('RW8c pr_status for a PR the status script cannot read says so', async ($, on) => {
    const { seen: _seen } = world(on, { script: {} })
    await start($)
    const ran = await $.tool.call({ tool: 'mcp__ccv3-mods__pr_status', pr: 5 })
    expect(JSON.stringify(ran.result)).toContain('pr_status failed')
  })

  test('RW9 a waiver does not hide a PR body proof problem', async ($, on) => {
    const { clock, seen } = world(on, { store: watching(8), script: { 8: [status(8, { reasons: [PROOF_REASON] })] }, gh: { 8: WAIVED } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toContain('PR body proof')
  })
})
