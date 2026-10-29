import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// PR loop alerts: which ones may start a model turn ($.prompt.submit). Every check reads what the engine was asked to do.
// Q1  option C (default): only REVIEWED with open threads, PROOF, STALLED and LIMITED submit a model line
// Q2  option C: READY, merged and closed raise a toast only
// Q3  option D (CCV3_MOD_PRLOOP_QUIET=1): no alert submits; the toast and the PRS row stay
// Q4  any other value of the variable is option C
// Q5  Dave's own /land press with no shell tool still hands the model its instruction, quiet or not

const SESSION = 'test-session'
const KEY = `pr-watch:${SESSION}`
const QUIET = 'CCV3_MOD_PRLOOP_QUIET'
const TICK = 300_000
const MIN = 60_000
const NOW = 1_000_000
const HEAD_A = 'a'.repeat(40)

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

const PROOF_REASON = 'PR body proof: no "Proof type:" line. Add the Evidence block from pr-and-commit-style.md (types: bugfix, feature, refactor, ui, harness, docs)'

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
const READY = (pr: number) => status(pr, { ready: true, reasons: [], reviewedHead: true, mergeable_state: 'clean' })
const MERGED = (pr: number) => status(pr, { prState: 'closed', merged: true, reasons: ['already merged', 'PR is closed'] })
const CLOSED = (pr: number) => status(pr, { prState: 'closed', reasons: ['PR is closed'] })
const LIMITED = (pr: number) => status(pr, { rateLimited: true, reasons: ['Greptile did not finish a review of the head (completed/neutral)'] })
const REVIEWED_WITH_THREADS = (pr: number) =>
  status(pr, { reviewedHead: true, unresolved: 3, reasons: ['3 review thread(s) unresolved'] })
const PROOF = (pr: number) => status(pr, { reasons: [PROOF_REASON, 'no CodeRabbit PR-bot review of the head commit'] })

type Opts = {
  script?: Record<number, Status[]>
  env?: Record<string, string>
  store?: Record<string, unknown>
  answer?: 'Land' | 'No' | 'dismiss'
  tools?: string[]
}

const world = (on: On, opts: Opts = {}) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/home', ...(opts.env ?? {}) })
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
  const seen = { status: [] as number[], toasts: [] as string[], submits: [] as string[], asks: [] as string[], land: [] as Record<string, unknown>[] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => ({ value: 'C:/r' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('tool.list', () => ({ value: (opts.tools ?? ['Bash', 'PowerShell']).map(name => ({ name })) as never }))
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
    if (!argv.some(part => part.includes('review-status.mjs'))) {
      return { value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const pr = Number(argv.find(part => /^\d+$/.test(part)))
    seen.status.push(pr)
    const queue = script[pr] ?? []
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) as Status
    return { value: { exitCode: reply.ready ? 0 : 1, stdout: JSON.stringify(reply), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = String((e as unknown as { questions: { question: string }[] }).questions[0]?.question)
    seen.asks.push(question)
    if (opts.answer === 'dismiss') return { deny: 'dismissed' }
    return { result: { questions: [], answers: { [question]: opts.answer ?? 'No' } } }
  })
  on('tool.call', { tool: 'PowerShell' }, (_$, e) => {
    seen.land.push({ ...e })
    return { result: { stdout: 'LANDED #1', stderr: '', interrupted: false } }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.land.push({ ...e })
    return { result: { stdout: 'LANDED #1', stderr: '', interrupted: false } }
  })
  return { clock, seen, store }
}

const start = ($: Engine) => $.session.start({ cwd: 'C:/r', surface: 'terminal', isInteractive: true })

type Doc = { prs: { pr: number; state: string | null; whenReady: boolean }[]; backoffUntil: number }
const stored = (store: Map<string, unknown>): Doc | undefined => store.get(KEY) as Doc | undefined

type SeedPr = { pr: number; state?: string | null; whenReady?: boolean; head?: string; since?: number }
const seed = (prs: SeedPr[]) => ({
  [KEY]: {
    prs: prs.map(({ state, whenReady, ...p }) => ({ ...p, state: state ?? null, whenReady: whenReady ?? false })),
    backoffUntil: 0,
    touched: NOW,
  },
})

// One alert per case. `model` is true when the alert needs the model to act (option C submits it).
// `listed` is the state the PRS row keeps after the tick; null means the PR leaves the list.
type Case = { name: string; model: boolean; toast: RegExp; listed: string | null; store: () => Record<string, unknown>; reply: () => Status }
const CASES: Case[] = [
  { name: 'REVIEWED with open threads', model: true, toast: /#7/, listed: 'REVIEWED', store: () => seed([{ pr: 7, state: 'PENDING' }]), reply: () => REVIEWED_WITH_THREADS(7) },
  { name: 'PROOF', model: true, toast: /PR body proof needs fixing/, listed: 'PROOF', store: () => seed([{ pr: 8, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), reply: () => PROOF(8) },
  { name: 'STALLED', model: true, toast: /#7/, listed: 'STALLED', store: () => seed([{ pr: 7, state: 'PENDING', head: HEAD_A, since: NOW - 61 * MIN }]), reply: () => status(7) },
  { name: 'LIMITED', model: true, toast: /did not finish/i, listed: 'LIMITED', store: () => seed([{ pr: 6 }]), reply: () => LIMITED(6) },
  { name: 'READY', model: false, toast: /READY/, listed: null, store: () => seed([{ pr: 7, state: 'PENDING' }]), reply: () => READY(7) },
  { name: 'merged', model: false, toast: /merged/i, listed: null, store: () => seed([{ pr: 8 }]), reply: () => MERGED(8) },
  { name: 'closed', model: false, toast: /closed/i, listed: null, store: () => seed([{ pr: 9 }]), reply: () => CLOSED(9) },
]

const tick = async (c: Case, env: Record<string, string>, $: Engine, on: On) => {
  const pr = c.reply().pr
  const w = world(on, { env, store: c.store(), script: { [pr]: [c.reply()] } })
  await start($)
  await w.clock.advance(TICK)
  await w.clock.advance(1)
  return w
}

const expectRow = (store: Map<string, unknown>, c: Case) => {
  if (c.listed === null) expect(stored(store)).toBeUndefined()
  else expect(stored(store)?.prs.map(p => p.state)).toEqual([c.listed])
}

describe('pr-loop option C: only an alert the model must act on submits a line', () => {
  for (const c of CASES) {
    test(`Q1 default env: ${c.name} ${c.model ? 'submits one model line and toasts' : 'toasts and submits nothing'}`, async ($, on) => {
      const { seen, store } = await tick(c, {}, $, on)
      expect(seen.toasts.length).toBe(1)
      expect(seen.toasts[0]).toMatch(c.toast)
      expect(seen.submits.length).toBe(c.model ? 1 : 0)
      expectRow(store, c)
    })
  }

  test('Q2 a READY alert answered No still raises its toast and submits nothing', async ($, on) => {
    const w = world(on, { answer: 'No', store: seed([{ pr: 7, state: 'PENDING', whenReady: true }]), script: { 7: [READY(7)] } })
    await start($)
    await w.clock.advance(TICK)
    await w.clock.advance(1)
    expect(w.seen.asks).toEqual(['Land #7?'])
    expect(w.seen.toasts.length).toBe(1)
    expect(w.seen.toasts[0]).toContain('READY')
    expect(w.seen.land).toEqual([])
    expect(w.seen.submits).toEqual([])
  })

  test('Q2 a READY alert whose Land dialog is dismissed submits nothing', async ($, on) => {
    const w = world(on, { answer: 'dismiss', store: seed([{ pr: 7, state: 'PENDING', whenReady: true }]), script: { 7: [READY(7)] } })
    await start($)
    await w.clock.advance(TICK)
    await w.clock.advance(1)
    expect(w.seen.land).toEqual([])
    expect(w.seen.submits).toEqual([])
  })
})

describe('pr-loop option D: CCV3_MOD_PRLOOP_QUIET=1 submits no alert', () => {
  for (const c of CASES) {
    test(`Q3 ${c.name} toasts, keeps its PRS row where the default does, and submits nothing`, async ($, on) => {
      const { seen, store } = await tick(c, { [QUIET]: '1' }, $, on)
      expect(seen.toasts.length).toBe(1)
      expect(seen.toasts[0]).toMatch(c.toast)
      expect(seen.submits).toEqual([])
      expectRow(store, c)
    })
  }

  test('Q3 a READY alert answered No submits nothing', async ($, on) => {
    const w = world(on, { env: { [QUIET]: '1' }, answer: 'No', store: seed([{ pr: 7, state: 'PENDING', whenReady: true }]), script: { 7: [READY(7)] } })
    await start($)
    await w.clock.advance(TICK)
    await w.clock.advance(1)
    expect(w.seen.submits).toEqual([])
  })

  test('Q4 CCV3_MOD_PRLOOP_QUIET=0 is option C: REVIEWED still submits', async ($, on) => {
    const reviewed = CASES.find(c => c.name === 'REVIEWED with open threads') as Case
    const { seen } = await tick(reviewed, { [QUIET]: '0' }, $, on)
    expect(seen.submits.length).toBe(1)
  })

  test('Q4 CCV3_MOD_PRLOOP_QUIET=true is option C: READY submits nothing', async ($, on) => {
    const ready = CASES.find(c => c.name === 'READY') as Case
    const { seen } = await tick(ready, { [QUIET]: 'true' }, $, on)
    expect(seen.submits).toEqual([])
  })

  test('Q5 /land with no shell tool still hands the model its instruction when quiet', async ($, on) => {
    const w = world(on, { env: { [QUIET]: '1' }, answer: 'Land', tools: ['Read'], script: { 12: [READY(12)] } })
    await start($)
    await $.command.run({ command: 'land', args: '12', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    await w.clock.advance(1)
    expect(w.seen.land).toEqual([])
    expect(w.seen.submits.length).toBe(1)
    expect(w.seen.submits[0]).toContain('-Pr 12')
  })
})
