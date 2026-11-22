import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// PR loop alerts: which ones may start a model turn ($.prompt.submit). Every check reads what the engine was asked to do.
// Q1  option C (default): only REVIEWED with open threads, PROOF, STALLED and LIMITED submit a model line
// Q2  option C: READY, merged and closed raise a toast only
// Q3  option D (CCV3_MOD_PRLOOP_QUIET=1): no alert submits; the toast and the PRS row stay
// Q4  any other value of the variable is option C
// Q5  Dave's own /land press with no shell tool still hands the model its instruction, quiet or not
// Paid flag (paid guard PR 2): a watched PR whose head holds a paid CodeRabbit comment with no paid-ledger row gets ONE toast and ONE model notice.
// PF1 flagged: one toast, one notice, the exact text         PF2 the same check again: nothing (dedupe by PR, head and comment)
// PF3 the verb names no comment (ledger row, plain request, older head: the verb's own tests): nothing
// PF4 a failed verb (bad exit, a throw, not JSON): no flag, no throw, the PR stays watched
// PF5 no CodeRabbit request on the PR, or a closed PR: the verb is not run
// PF6 a new comment, or a new head, flags again             PF7 quiet mode: the toast stays, no notice
// PF8 a rejected notice is retried at the next check, with no toast before it
// PF9 quiet mode: one toast, the notice key is NOT marked sent; the same check in normal mode sends the notice once
// PF10 more than 200 distinct paid keys leave exactly 200 (own cap, seat ruling); the other keys in doc.sent (40 at most) are not pruned by them
// PF11 a stored ledger with 200 paid keys and 40 other keys survives a load (readDoc caps each class, not the whole list)

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
  coderabbitRequests?: number
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
  /** What `cr-paid.mjs unledgered` prints, per call in order (the last repeats): a { head, ids } object, 'exit2', 'throw' or 'junk'. */
  paid?: Record<number, (Paid | 'exit2' | 'throw' | 'junk')[]>
  /** The first N model notices are rejected. */
  submitFails?: number
}

type Paid = { head: string; ids: number[] }

const world = (on: On, opts: Opts = {}) => {
  const clock = mock.clock(on, { now: NOW })
  // What mock.env does (a variable not listed is unset), on an object a test may change between checks (PF9 turns quiet mode off).
  const env: Record<string, string> = { USERPROFILE: 'C:/home', ...(opts.env ?? {}) }
  on('env.get', (_$, e) => ({ value: env[e.name] }))
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
  const seen = { status: [] as number[], toasts: [] as string[], submits: [] as string[], asks: [] as string[], land: [] as Record<string, unknown>[], paid: [] as string[][] }
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
  let submitCalls = 0
  on('prompt.submit', (_$, e) => {
    submitCalls += 1
    if (submitCalls <= (opts.submitFails ?? 0)) throw new Error('prompt.submit rejected')
    seen.submits.push(e.text)
    return { text: e.text }
  })
  const out = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    if (argv.some(part => part.includes('cr-paid.mjs'))) {
      seen.paid.push(argv.slice(2))
      const queue = opts.paid?.[Number(argv.find(part => /^\d+$/.test(part)))] ?? []
      const reply = queue.length > 1 ? queue.shift() : queue[0]
      if (reply === 'throw') throw new Error('spawn failed')
      if (reply === 'exit2') return out(2, '')
      if (reply === 'junk' || reply === undefined) return out(0, 'not json')
      return out(0, JSON.stringify(reply))
    }
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
  return { clock, seen, store, env }
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

describe('pr-loop paid flag: a paid CodeRabbit comment with no paid-ledger row is flagged once, on every watched PR', () => {
  const HEAD_B = 'b'.repeat(40)
  const TEXT = (head = 'aaaaaaa') => `PR #7: a paid CodeRabbit request is on head ${head}, and the paid ledger has no round for it. It did not go through cr-paid.mjs post. Tell Dave.`
  const asked = (over: Partial<Status> = {}) => status(7, { coderabbitRequests: 1, ...over })
  const checks = async (w: ReturnType<typeof world>, $: Engine, count: number) => {
    await start($)
    for (let i = 0; i < count; i += 1) await w.clock.advance(TICK)
    await w.clock.advance(1)
  }
  const flagged = (opts: Opts) => async ($: Engine, on: On, count = 1) => {
    const w = world(on, { store: seed([{ pr: 7 }]), ...opts })
    await checks(w, $, count)
    return w
  }

  test('PF1 one toast and one model notice, with the exact text, for a paid comment on the head with no ledger row', async ($, on) => {
    const w = await flagged({ script: { 7: [asked()] }, paid: { 7: [{ head: HEAD_A, ids: [41] }] } })($, on)
    expect(w.seen.paid).toEqual([['unledgered', '--pr', '7', '--json']])
    expect(w.seen.toasts).toEqual([TEXT()])
    expect(w.seen.submits).toEqual([TEXT()])
    expect(stored(w.store)?.prs.map(p => p.pr)).toEqual([7])
  })

  test('PF2 the same comment at the next two checks flags nothing more', async ($, on) => {
    const w = await flagged({ script: { 7: [asked()] }, paid: { 7: [{ head: HEAD_A, ids: [41] }] } })($, on, 3)
    expect(w.seen.paid.length).toBe(3)
    expect(w.seen.toasts).toEqual([TEXT()])
    expect(w.seen.submits).toEqual([TEXT()])
  })

  test('PF3 a verb that names no comment (a ledger row, a plain request, an older head) flags nothing', async ($, on) => {
    const w = await flagged({ script: { 7: [asked()] }, paid: { 7: [{ head: HEAD_A, ids: [] }] } })($, on)
    expect(w.seen.paid.length).toBe(1)
    expect(w.seen.toasts).toEqual([])
    expect(w.seen.submits).toEqual([])
  })

  for (const bad of ['exit2', 'throw', 'junk'] as const) {
    test(`PF4 a failed verb (${bad}) flags nothing, throws nothing and keeps the PR watched`, async ($, on) => {
      const w = await flagged({ script: { 7: [asked()] }, paid: { 7: [bad] } })($, on)
      expect(w.seen.paid.length).toBe(1)
      expect(w.seen.toasts).toEqual([])
      expect(w.seen.submits).toEqual([])
      expect(stored(w.store)?.prs.map(p => p.pr)).toEqual([7])
    })
  }

  test('PF5 a PR with no CodeRabbit request, and a closed PR, never run the verb', async ($, on) => {
    const quiet = await flagged({ script: { 7: [status(7)] }, paid: { 7: [{ head: HEAD_A, ids: [41] }] } })($, on)
    expect(quiet.seen.paid).toEqual([])
    expect(quiet.seen.toasts).toEqual([])
  })

  test('PF5b a closed PR with CodeRabbit requests never runs the verb', async ($, on) => {
    const w = await flagged({ script: { 7: [asked({ prState: 'closed', merged: true, reasons: ['already merged'] })] }, paid: { 7: [{ head: HEAD_A, ids: [41] }] } })($, on)
    expect(w.seen.paid).toEqual([])
    expect(w.seen.submits).toEqual([])
  })

  test('PF6 a new comment on the same head, and a comment on a new head, are each flagged again', async ($, on) => {
    const w = await flagged({
      script: { 7: [asked()] },
      paid: { 7: [{ head: HEAD_A, ids: [41] }, { head: HEAD_A, ids: [41, 42] }, { head: HEAD_B, ids: [41] }] },
    })($, on, 3)
    expect(w.seen.submits).toEqual([TEXT(), TEXT(), TEXT('bbbbbbb')])
    expect(w.seen.toasts).toEqual(w.seen.submits)
  })

  test('PF7 CCV3_MOD_PRLOOP_QUIET=1 keeps the toast and sends no model notice', async ($, on) => {
    const w = await flagged({ env: { [QUIET]: '1' }, script: { 7: [asked()] }, paid: { 7: [{ head: HEAD_A, ids: [41] }] } })($, on, 2)
    expect(w.seen.toasts).toEqual([TEXT()])
    expect(w.seen.submits).toEqual([])
  })

  test('PF8 a rejected model notice gives no toast, and the next check sends both once', async ($, on) => {
    const w = await flagged({ submitFails: 1, script: { 7: [asked()] }, paid: { 7: [{ head: HEAD_A, ids: [41] }] } })($, on, 2)
    expect(w.seen.submits).toEqual([TEXT()])
    expect(w.seen.toasts).toEqual([TEXT()])
  })

  const sentOf = (store: Map<string, unknown>): string[] => (store.get(KEY) as { sent?: string[] }).sent ?? []
  const PAID_KEY_41 = `paid:7:${HEAD_A}:41`

  test('PF9 quiet mode: one toast, the notice key is not marked sent, and the same check in normal mode sends the notice once', async ($, on) => {
    const w = world(on, { env: { [QUIET]: '1' }, store: seed([{ pr: 7 }]), script: { 7: [asked()] }, paid: { 7: [{ head: HEAD_A, ids: [41] }] } })
    await checks(w, $, 2)
    expect(w.seen.toasts).toEqual([TEXT()])
    expect(w.seen.submits).toEqual([])
    expect(sentOf(w.store)).not.toContain(PAID_KEY_41)
    delete w.env[QUIET]
    await w.clock.advance(TICK)
    await w.clock.advance(1)
    expect(w.seen.submits).toEqual([TEXT()])
    expect(sentOf(w.store)).toContain(PAID_KEY_41)
    await w.clock.advance(TICK)
    await w.clock.advance(1)
    expect(w.seen.submits).toEqual([TEXT()])
  })

  test('PF10 more than 200 distinct paid keys leave exactly 200 in doc.sent, and the 40 other keys stay', async ($, on) => {
    const others = Array.from({ length: 40 }, (_, i) => `other ${i}`)
    const store = seed([{ pr: 7 }])
    ;(store[KEY] as { sent?: string[] }).sent = others
    const ids = Array.from({ length: 250 }, (_, i) => i + 1)
    const w = await flagged({ store, script: { 7: [asked()] }, paid: { 7: [{ head: HEAD_A, ids }] } })($, on)
    const sent = sentOf(w.store)
    const paid = sent.filter(key => key.startsWith('paid:'))
    expect(paid.length).toBe(200)
    expect(paid[0]).toBe(`paid:7:${HEAD_A}:51`)
    expect(paid[199]).toBe(`paid:7:${HEAD_A}:250`)
    expect(sent.filter(key => !key.startsWith('paid:'))).toEqual(others)
  })

  // L4a (card prflow-paid-guard-leftovers, CLI run 2 pr-loop/index.ts 413): a READY PR leaves the watch list in the same check that scans it. A scan that FAILS
  // there must come back at the next check (the scan is the detection for a paid comment that did not go through `post`). A scan that works runs once.
  const readyAsked = (over: Partial<Status> = {}) => status(7, { ready: true, reasons: [], reviewedHead: true, mergeable_state: 'clean', coderabbitRequests: 1, ...over })
  const readyToasts = (w: ReturnType<typeof world>) => w.seen.toasts.filter(text => /READY/.test(text))

  test('PF12 a paid scan that throws when the PR reaches READY runs again at the next check and flags the comment once', async ($, on) => {
    const w = await flagged({ script: { 7: [readyAsked()] }, paid: { 7: ['throw', { head: HEAD_A, ids: [41] }] } })($, on, 2)
    expect(w.seen.paid.length).toBe(2)
    expect(w.seen.toasts.filter(text => text === TEXT())).toEqual([TEXT()])
    expect(w.seen.submits).toEqual([TEXT()])
    expect(readyToasts(w).length).toBe(1)
  })

  test('PF13 (control) a paid scan that works when the PR reaches READY runs once, not again', async ($, on) => {
    const w = await flagged({ script: { 7: [readyAsked()] }, paid: { 7: [{ head: HEAD_A, ids: [41] }] } })($, on, 3)
    expect(w.seen.paid.length).toBe(1)
    expect(w.seen.submits).toEqual([TEXT()])
  })

  test('PF14 a scan that keeps failing is tried 3 times in all (MAX_FAILS), then the PR leaves the scan list', async ($, on) => {
    const w = await flagged({ script: { 7: [readyAsked()] }, paid: { 7: ['throw'] } })($, on, 6)
    expect(w.seen.paid.length).toBe(3)
    expect(w.seen.submits).toEqual([])
  })

  test('PF15 the retry of a scan never repeats the READY alert or the Land dialog', async ($, on) => {
    const w = world(on, { store: seed([{ pr: 7, whenReady: true }]), answer: 'No', script: { 7: [readyAsked()] }, paid: { 7: ['throw', { head: HEAD_A, ids: [41] }] } })
    await checks(w, $, 3)
    expect(w.seen.asks.length).toBe(1)
    expect(readyToasts(w).length).toBe(1)
    expect(w.seen.status).toEqual([7])
  })

  test('PF11 a stored ledger with 200 paid keys and 40 other keys is kept whole when the list is loaded', async ($, on) => {
    const others = Array.from({ length: 40 }, (_, i) => `other ${i}`)
    const paids = Array.from({ length: 200 }, (_, i) => `paid:9:${HEAD_A}:${i + 1}`)
    const store = seed([{ pr: 7 }])
    ;(store[KEY] as { sent?: string[] }).sent = [...paids.slice(0, 100), ...others, ...paids.slice(100)]
    const w = await flagged({ store, script: { 7: [status(7)] } })($, on)
    const sent = sentOf(w.store)
    expect(sent.filter(key => key.startsWith('paid:'))).toEqual(paids)
    expect(sent.filter(key => !key.startsWith('paid:'))).toEqual(others)
  })
})
