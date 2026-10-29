import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// The PR loop mod, one test each. Every check reads what the engine was asked to do
// (a spawned process, a toast, a submitted prompt, a tool call, a store write).
// W1  pending, pending, READY: one toast and one report line, and the PR leaves the list
// W2  NOT READY (exit 1) is a normal answer: it must not read as an error or start the backoff
// W3  merged or closed: one toast, no model turn, the PR leaves the list
// W4  a reload re-arms from the store and does not report a state it already reported
// W5  headless: no timer, no process, no pr_watch tool; /land asks nobody and runs nothing
// W6  an error backs the watcher off to 15 minutes, tells Dave once, then resumes
// W7  pr_watch: a bad PR number adds nothing; the same PR twice is one entry
// W8  pr_status returns the status JSON to the model
// W9  /watch N --once checks once and arms nothing
// W10 /land: Land runs the land call once; No, dismiss and a failed dialog run nothing
// W11 /land on a NOT READY PR shows the reasons and asks nothing; --when-ready flags the watch
// W12 a watch flagged by --when-ready asks Land/No when READY instead of only reporting
// W13 /land with no shell tool falls back to one report-only-free instruction for the model
// W14 CCV3_MODS_OFF=1 arms nothing and registers nothing
// W15 a review Greptile did not finish is reported once and the PR stays on the list
// W16 another session's list is not watched: the store is keyed by session id
// W17 the status process is a failed spawn: nothing is reported as READY
// W19 the pane and the band show the watched PRs, so a wait is visible
// W18 a list untouched for a week is deleted, so dead sessions leave nothing
// W20 an aborted Land call re-submits nothing: Dave's Escape is not a second merge request
// W21 a reviewed head with open threads or a failed check alerts the model once per head
// W22 no review 60 minutes after the head appeared alerts once; a push restarts the clock
// W23 a status script without prState or merged is an error, never CLOSED
// W24 one PR's own error never stops the others; three in a row drop it; shared errors still back off
// W25 pr_watch and /watch refuse a PR whose status cannot be read; the tool names its repo
// W12 (again) a READY alert answered No or dismissed still gives the model its report line
// W26 a reviewed head below the confidence bar alerts REVIEWED, not STALLED
// W27 a labelled PR whose CodeRabbit review was rate limited or skipped is LIMITED, not PENDING for 60 minutes
// W28 a Greptile review a push cancelled says cancelled; a reviewed head below the bar is REVIEWED
// W29 the labels pick the bots: routedReviewed and routing.required drive REVIEWED, STALLED and the texts
// W30 a second bot's findings on the same head alert again; a failed Greptile check alerts at once; REVIEWED beats LIMITED

const SESSION = 'test-session'
const KEY = `pr-watch:${SESSION}`
const PR_TOOL = 'mcp__ccv3-mods__pr_watch'
const STATUS_TOOL = 'mcp__ccv3-mods__pr_status'
const TICK = 300_000
const MIN = 60_000

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
  lowConfidence?: boolean
  confidence?: number | null
  coderabbitLimited?: boolean | null
  routedReviewed?: boolean
  coderabbitReviewedHead?: boolean | null
  routing?: { required: string[]; held: string | null; source: string }
  coderabbitRateLimited?: boolean | null
  coderabbitRetryMinutes?: number | null
  coderabbitOutsideDiff?: number
  proof?: { required: boolean; type: string | null; status: string; problems: string[] }
  // PR C (checkpoint): additive fields of review-status.mjs. Absent from an older script.
  isDraft?: boolean
  labels?: string[]
  coderabbitRequests?: number
  coderabbitRounds?: number
}

const PROOF_REASON = 'PR body proof: no "Proof type:" line. Add the Evidence block from pr-and-commit-style.md (types: bugfix, feature, refactor, ui, harness, docs)'
const GREEN_REASON = 'PR body proof: GREEN names commit aaaaaaa, not the head bbbbbbb. Run the check on the head and update the GREEN line'

const status = (pr: number, over: Partial<Status> = {}): Status => ({
  pr,
  head: 'a'.repeat(40),
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

// 'not-found' is a 404 for one PR; 'old-script' is a status script that predates prState and merged.
type Reply = Status | 'error' | 'spawn-fail' | 'not-found' | 'old-script'
type Opts = {
  script?: Record<number, Reply[]>
  env?: Record<string, string>
  store?: Record<string, unknown>
  answer?: 'Land' | 'No' | 'dismiss'
  tools?: string[]
  home?: boolean
  landThrows?: boolean
}

const world = (on: On, opts: Opts = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
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
  const seen = { calls: [] as string[][], status: [] as number[], toasts: [] as string[], submits: [] as string[], asks: [] as string[], land: [] as Record<string, unknown>[], registered: [] as string[], tools: [] as string[], descriptions: {} as Record<string, string> }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => ({ value: 'C:/r' }))
  on('fs.exists', () => ({ value: opts.home !== false }))
  on('fs.write', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', (_$, e) => {
    seen.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', (_$, e) => {
    seen.tools.push(e.name)
    seen.descriptions[e.name] = String((e as unknown as { description?: string }).description)
    return { value: { tool: `mcp__ccv3-mods__${e.name}` } }
  })
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
    seen.calls.push(argv)
    if (!argv.some(part => part.includes('review-status.mjs'))) {
      return { value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const pr = Number(argv.find(part => /^\d+$/.test(part)))
    seen.status.push(pr)
    const queue = script[pr] ?? []
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) as Reply
    if (reply === 'error') return { value: { exitCode: 2, stdout: '', stderr: 'review-status: could not determine (API rate limit exceeded)', isStdoutTruncated: false, isStderrTruncated: false } }
    if (reply === 'spawn-fail') return { value: { exitCode: 1, stdout: '', stderr: 'node: not found', isStdoutTruncated: false, isStderrTruncated: false } }
    if (reply === 'not-found') return { value: { exitCode: 2, stdout: '', stderr: 'review-status: could not determine (gh: Not Found (HTTP 404))', isStdoutTruncated: false, isStderrTruncated: false } }
    if (reply === 'old-script') {
      const { prState: _prState, merged: _merged, ...old } = status(pr)
      return { value: { exitCode: 1, stdout: JSON.stringify(old), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
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
    // The engine rejects a tool call that is aborted (claude-code.d.ts, tool.call): Dave pressed Escape.
    if (opts.landThrows) throw new Error('aborted')
    return { result: { stdout: 'LANDED #1', stderr: '', interrupted: false } }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.land.push({ ...e })
    return { result: { stdout: 'LANDED #1', stderr: '', interrupted: false } }
  })
  return { clock, seen, store, settle: () => clock.advance(1) }
}

const start = ($: Engine, isInteractive = true) =>
  $.session.start({ cwd: 'C:/r', surface: isInteractive ? 'terminal' : null, isInteractive })

type Doc = { prs: { pr: number; state: string | null; whenReady: boolean }[]; backoffUntil: number }
const stored = (store: Map<string, unknown>): Doc | undefined => store.get(KEY) as Doc | undefined

const run = ($: Engine, command: string, args: string) =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

type SeedPr = { pr: number; state?: string | null; whenReady?: boolean; head?: string; since?: number; alerted?: string; fails?: number }
const seed = (prs: SeedPr[], backoffUntil = 0) => ({
  [KEY]: {
    prs: prs.map(({ state, whenReady, ...p }) => ({ ...p, state: state ?? null, whenReady: whenReady ?? false })),
    backoffUntil,
    touched: 1_000_000,
  },
})

describe('pr-loop watcher', () => {
  // The first test of the file pays the cold load of the engine and the plugin: 3.8 to 5.0 s on a quiet machine, so the 5 s default
  // made the mods gate fail at random. A longer limit changes no assertion.
  test('W1 pending, pending, READY gives one toast and one report line and the PR leaves the list', { timeoutMs: 30_000 }, async ($, on) => {
    const { clock, seen, store } = world(on, { store: seed([{ pr: 7 }]), script: { 7: [status(7), status(7, { reasons: ['other'] }), READY(7)] } })
    await start($)
    await clock.advance(TICK)
    await clock.advance(TICK)
    expect(seen.toasts).toEqual([])
    expect(seen.submits).toEqual([])
    await clock.advance(TICK)
    expect(seen.toasts.length).toBe(1)
    expect(seen.toasts[0]).toContain('#7')
    expect(seen.toasts[0]).toContain('READY')
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toContain('#7')
    expect(seen.submits[0]).toMatch(/do not merge/i)
    expect(stored(store)).toBeUndefined()
    await clock.advance(TICK * 3)
    expect(seen.status).toEqual([7, 7, 7])
  })

  test('W2 NOT READY with exit 1 is a normal answer: no backoff, the next tick checks again', async ($, on) => {
    const { clock, seen, store } = world(on, { store: seed([{ pr: 7 }]), script: { 7: [status(7)] } })
    await start($)
    await clock.advance(TICK)
    await clock.advance(TICK)
    expect(seen.status).toEqual([7, 7])
    expect(stored(store)?.backoffUntil).toBe(0)
  })

  test('W3 a merged PR gives one toast, no model turn, and leaves the list; a closed one the same', async ($, on) => {
    const { clock, seen, store } = world(on, { store: seed([{ pr: 8 }, { pr: 9 }]), script: { 8: [MERGED(8)], 9: [CLOSED(9)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.toasts.length).toBe(2)
    expect(seen.toasts[0]).toMatch(/#8.*merged/i)
    expect(seen.toasts[1]).toMatch(/#9.*closed/i)
    expect(seen.submits).toEqual([])
    expect(stored(store)).toBeUndefined()
  })

  test('W4 a reload re-arms from the store and does not report a state it already reported', async ($, on) => {
    const { clock, seen, store } = world(on, { store: seed([{ pr: 3, state: 'LIMITED' }, { pr: 4, state: 'PENDING' }]), script: { 3: [LIMITED(3)], 4: [READY(4)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.status).toEqual([3, 4])
    expect(seen.toasts.length).toBe(1)
    expect(seen.toasts[0]).toContain('#4')
    expect(stored(store)?.prs.map(p => p.pr)).toEqual([3])
  })

  test('W6 an error backs the watcher off to 15 minutes, then it resumes', async ($, on) => {
    const { clock, seen, store } = world(on, { store: seed([{ pr: 5 }]), script: { 5: ['error', status(5)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.status).toEqual([5])
    await clock.advance(TICK)
    await clock.advance(TICK)
    expect(seen.status).toEqual([5])
    await clock.advance(TICK)
    expect(seen.status).toEqual([5, 5])
    expect(seen.toasts.length).toBe(1)
    expect(seen.toasts[0]).toMatch(/status check failed/)
    expect(seen.submits).toEqual([])
    expect(stored(store)?.backoffUntil).toBe(0)
  })

  test('W17 a spawn that prints no JSON is an error, never READY', async ($, on) => {
    const { clock, seen, store } = world(on, { store: seed([{ pr: 5 }]), script: { 5: ['spawn-fail'] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.toasts.every(text => /status check failed/.test(text))).toBe(true)
    expect(seen.submits).toEqual([])
    expect(stored(store)?.prs.map(p => p.pr)).toEqual([5])
    expect((stored(store)?.backoffUntil ?? 0) > 0).toBe(true)
  })

  test('W15 a review Greptile did not finish is reported once and the PR stays on the list', async ($, on) => {
    const { clock, seen, store } = world(on, { store: seed([{ pr: 6 }]), script: { 6: [LIMITED(6)] } })
    await start($)
    await clock.advance(TICK)
    await clock.advance(TICK)
    await clock.advance(TICK)
    expect(seen.toasts.length).toBe(1)
    expect(seen.toasts[0]).toMatch(/did not finish/i)
    expect(seen.submits.length).toBe(1)
    expect(stored(store)?.prs.map(p => p.pr)).toEqual([6])
  })

  // P3b: Greptile ends its check `neutral` when a newer push superseded it, and `failure` when it reviewed below the bar.
  test('W28 a Greptile review a push cancelled says cancelled, not rate limited or "no finished review"', async ($, on) => {
    const cancelled = status(6, { rateLimited: true, reasons: ['Greptile review of the head was cancelled (superseded by a push); wait for the review of the new head'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 6 }]), script: { 6: [cancelled] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/cancelled/)
    expect(seen.submits[0]).toMatch(/superseded/)
    expect(seen.submits[0]).not.toMatch(/rate limited|no finished review/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['LIMITED'])
  })

  test('W28 a reviewed head that scored below the bar (Greptile check failure) is REVIEWED, not "no finished review"', async ($, on) => {
    const low = status(6, { reviewedHead: true, lowConfidence: true, confidence: 3, rateLimited: false, reasons: ['Greptile confidence 3/5 is below 4'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 6 }]), script: { 6: [low] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/reviewed by Greptile but is not READY/)
    expect(seen.submits[0]).not.toMatch(/no finished review/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['REVIEWED'])
  })

  // P3b follow-up: the labels pick the bots. A PR that does not need Greptile must not wait on Greptile's reviewedHead.
  const CR_ONLY = { required: ['coderabbit'], held: null, source: 'labels' }

  test('W29 a CodeRabbit-only PR with an open thread alerts REVIEWED, though Greptile never reviewed it', async ($, on) => {
    const s = status(9, { routing: CR_ONLY, routedReviewed: true, reviewedHead: false, unresolved: 1, reasons: ['1 review thread(s) unresolved'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/reviewed by CodeRabbit but is not READY/)
    expect(seen.submits[0]).not.toMatch(/Greptile/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['REVIEWED'])
  })

  test('W29 a CodeRabbit-only PR with no CodeRabbit review after 60 minutes is STALLED and names CodeRabbit', async ($, on) => {
    const s = status(9, { routing: CR_ONLY, routedReviewed: false, reviewedHead: true, reasons: ['no CodeRabbit PR-bot review of the head commit'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - 61 * MIN }]), script: { 9: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/no CodeRabbit review after 60 minutes/)
    expect(seen.submits[0]).not.toMatch(/Greptile/)
    expect(seen.toasts[0]).toMatch(/no CodeRabbit review after 60 minutes/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['STALLED'])
  })

  test('W29 a status without routedReviewed keeps the old behaviour: reviewedHead decides and the text names Greptile', async ($, on) => {
    const open = status(9, { reviewedHead: false, unresolved: 1, reasons: ['1 review thread(s) unresolved'] })
    const a = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [open] } })
    await start($)
    await a.clock.advance(TICK)
    expect(a.seen.submits).toEqual([])
    expect(stored(a.store)?.prs.map(p => p.state)).toEqual(['PENDING'])
  })

  test('W29 an old status 61 minutes without a review is STALLED with the Greptile text', async ($, on) => {
    const { clock, seen } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - 61 * MIN }]), script: { 9: [status(9)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits[0]).toMatch(/no Greptile review after 60 minutes/)
  })

  test('W29 a deep PR alerts Greptile findings at once, without waiting for CodeRabbit, and names only Greptile', async ($, on) => {
    const deep = { required: ['greptile', 'coderabbit'], held: null, source: 'labels' }
    const s = status(9, { routing: deep, routedReviewed: false, reviewedHead: true, coderabbitReviewedHead: false, unresolved: 2, reasons: ['2 review thread(s) unresolved', 'no CodeRabbit PR-bot review of the head commit'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/reviewed by Greptile but is not READY/)
    expect(seen.submits[0]).not.toMatch(/reviewed by Greptile and CodeRabbit/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['REVIEWED'])
  })

  test('W29 a deep PR with no findings and no CodeRabbit review yet stays PENDING', async ($, on) => {
    const deep = { required: ['greptile', 'coderabbit'], held: null, source: 'labels' }
    const s = status(9, { routing: deep, routedReviewed: false, reviewedHead: true, coderabbitReviewedHead: false, unresolved: 0, reasons: ['no CodeRabbit PR-bot review of the head commit'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits).toEqual([])
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['PENDING'])
  })

  test('W29 READY names the bots the labels required', async ($, on) => {
    const ready = status(9, { ready: true, reasons: [], routing: CR_ONLY, routedReviewed: true, reviewedHead: false, mergeable_state: 'clean' })
    const { clock, seen } = world(on, { store: seed([{ pr: 9 }]), script: { 9: [ready] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits[0]).toMatch(/CodeRabbit reviewed it/)
    expect(seen.submits[0]).not.toMatch(/Greptile|confidence at least/)
  })

  test('W29 a docs-only PR (no bot required) never waits for a review', async ($, on) => {
    const docs = { required: [], held: null, source: 'labels' }
    const s = status(9, { routing: docs, routedReviewed: true, reviewedHead: false, unresolved: 1, reasons: ['1 review thread(s) unresolved'] })
    const { clock, seen } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).not.toMatch(/Greptile|CodeRabbit/)
  })

  // Critic round: markers, ordering and texts for PRs that need more than one bot.
  const DEEP = { required: ['greptile', 'coderabbit'], held: null, source: 'labels' }
  const GREPTILE_FAILED = 'Greptile check ended failure on the head although its summary scores 5/5. Post one @greptileai comment to re-run it'

  test('W30 a review:deep PR alerts REVIEWED again when the second bot reviews the same head', async ($, on) => {
    const first = status(9, { routing: DEEP, reviewedHead: true, coderabbitReviewedHead: false, routedReviewed: false, unresolved: 2, reasons: ['2 review thread(s) unresolved', 'no CodeRabbit PR-bot review of the head commit'] })
    const second = status(9, { routing: DEEP, reviewedHead: true, coderabbitReviewedHead: true, routedReviewed: true, unresolved: 3, reasons: ['3 review thread(s) unresolved'] })
    const { clock, seen } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [first, first, second, second] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/reviewed by Greptile but is not READY/)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(2)
    expect(seen.submits[1]).toMatch(/reviewed by Greptile and CodeRabbit but is not READY/)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(2)
  })

  test('W32 a failed Greptile check with an unusable summary on a CodeRabbit-only PR alerts REVIEWED, not PENDING', async ($, on) => {
    const failedNoSummary = status(9, {
      routing: CR_ONLY, reviewedHead: false, coderabbitReviewedHead: true, routedReviewed: true, unresolved: 0,
      reasons: ['Greptile check ended failure on the head (a review under 4/5); a failed review blocks even when the labels do not require Greptile'],
    })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [failedNoSummary] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/reviewed by .*Greptile.* but is not READY/)
    expect(seen.submits[0]).toMatch(/ended failure/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['REVIEWED'])
  })

  test('W31 a shrink of the reviewing bots (a same-head re-run) is not news, and growing back to a known set is not either', async ($, on) => {
    const both = status(9, { routing: DEEP, reviewedHead: true, coderabbitReviewedHead: true, routedReviewed: true, unresolved: 2, reasons: ['2 review thread(s) unresolved'] })
    const crOnly = status(9, { routing: DEEP, reviewedHead: false, coderabbitReviewedHead: true, routedReviewed: false, unresolved: 2, reasons: ['2 review thread(s) unresolved', 'Greptile review of the head is in_progress'] })
    const { clock, seen } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [both, crOnly, both] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
  })

  test('W31 a watch stored with the old REVIEWED marker alerts once when CodeRabbit is new, not when Greptile alone is still in', async ($, on) => {
    const greptileOnly = status(9, { routing: DEEP, reviewedHead: true, coderabbitReviewedHead: false, routedReviewed: false, unresolved: 1, reasons: ['1 review thread(s) unresolved'] })
    const both = status(9, { routing: DEEP, reviewedHead: true, coderabbitReviewedHead: true, routedReviewed: true, unresolved: 1, reasons: ['1 review thread(s) unresolved'] })
    const { clock, seen } = world(on, { store: seed([{ pr: 9, state: 'REVIEWED', head: HEAD_A, since: NOW - MIN, alerted: `REVIEWED:${HEAD_A}` }]), script: { 9: [greptileOnly, both, both] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(0)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
  })

  test('W30 a Greptile check that ended failure at 5/5 alerts at once, not PENDING then STALLED', async ($, on) => {
    const failed = status(9, { routing: { required: ['greptile'], held: null, source: 'default' }, reviewedHead: true, routedReviewed: true, reasons: [GREPTILE_FAILED] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [failed] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/ended failure/)
    expect(seen.submits[0]).not.toMatch(/no Greptile review/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['REVIEWED'])
  })

  test('W30 a Greptile score under the bar alerts even when the labels do not require Greptile', async ($, on) => {
    const low = status(9, { routing: CR_ONLY, reviewedHead: true, lowConfidence: true, confidence: 2, coderabbitReviewedHead: false, routedReviewed: false, reasons: ['Greptile confidence 2/5 is below 4', 'no CodeRabbit PR-bot review of the head commit'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [low] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/confidence 2\/5/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['REVIEWED'])
  })

  test('W30 a cancelled Greptile run on a review:deep PR does not hide CodeRabbit findings', async ($, on) => {
    const cancelled = 'Greptile review of the head was cancelled (superseded by a push); wait for the review of the new head'
    const s = status(9, { routing: DEEP, rateLimited: true, reviewedHead: false, coderabbitReviewedHead: true, routedReviewed: false, unresolved: 1, reasons: [cancelled, '1 review thread(s) unresolved'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/reviewed by CodeRabbit but is not READY/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['REVIEWED'])
  })

  test('W30 a cancelled Greptile run with nothing to fix is still LIMITED', async ($, on) => {
    const cancelled = 'Greptile review of the head was cancelled (superseded by a push); wait for the review of the new head'
    const s = status(9, { routing: DEEP, rateLimited: true, reviewedHead: false, coderabbitReviewedHead: true, routedReviewed: false, reasons: [cancelled] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 9 }]), script: { 9: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits[0]).toMatch(/cancelled/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['LIMITED'])
  })

  test('W30 STALLED on a review:deep PR names only the bots that have not reviewed', async ($, on) => {
    const s = status(9, { routing: DEEP, reviewedHead: true, coderabbitReviewedHead: false, routedReviewed: false, reasons: ['no CodeRabbit PR-bot review of the head commit'] })
    const { clock, seen } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - 61 * MIN }]), script: { 9: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits[0]).toMatch(/no CodeRabbit review after 60 minutes/)
    expect(seen.submits[0]).not.toMatch(/Greptile/)
    expect(seen.toasts[0]).toMatch(/no CodeRabbit review after 60 minutes/)
    expect(seen.toasts[0]).not.toMatch(/Greptile/)
  })

  test('W30 STALLED with every required review in (CI still pending) does not blame a bot', async ($, on) => {
    const s = status(9, { routing: DEEP, reviewedHead: true, coderabbitReviewedHead: true, routedReviewed: true, reasons: ['check "ci" is in_progress/null'] })
    const { clock, seen } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - 61 * MIN }]), script: { 9: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits[0]).toMatch(/not READY after 60 minutes/)
    expect(seen.submits[0]).not.toMatch(/no (Greptile|CodeRabbit)/)
  })

  test('W31 a CodeRabbit rate limit says do NOT post the review request, check capacity free, and gives the minutes', async ($, on) => {
    const s = status(8, {
      routing: CR_ONLY, routedReviewed: false, coderabbitLimited: true, coderabbitRateLimited: true, coderabbitRetryMinutes: 12,
      reasons: ['CodeRabbit rate limited: head not reviewed (PR-bot review does not count; do not buy on-demand review)'],
    })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 8, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 8: [s] } })
    await start($)
    await clock.advance(TICK)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    const line = seen.submits[0] as string
    expect(line).toMatch(/rate limited by CodeRabbit/)
    expect(line).toContain('Do NOT post @coderabbitai review')
    expect(line).toContain('@coderabbitai rate limit')
    expect(line).toMatch(/costs no review/)
    expect(line).toContain('available in 12 minutes')
    expect(line).toMatch(/once when capacity is back/)
    expect(line).not.toMatch(/Act per pr-review-loop/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['LIMITED'])
  })

  test('W31 an older status script is still read as a rate limit from its reason, with no minutes', async ($, on) => {
    const s = status(8, { coderabbitLimited: true, reasons: ['CodeRabbit rate limited: head not reviewed (PR-bot review does not count; do not buy on-demand review)'] })
    const { clock, seen } = world(on, { store: seed([{ pr: 8, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 8: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits[0]).toContain('Do NOT post @coderabbitai review')
    expect(seen.submits[0]).not.toMatch(/available in/)
  })

  test('W31 a skipped or failed CodeRabbit review keeps the general LIMITED text', async ($, on) => {
    const s = status(8, { coderabbitLimited: true, coderabbitRateLimited: false, reasons: ['CodeRabbit skipped the review of the head (PR-bot review did not run; CLI/plugin output does not count)'] })
    const { clock, seen } = world(on, { store: seed([{ pr: 8, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 8: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits[0]).toMatch(/Act per pr-review-loop.md "No review on the head"/)
    expect(seen.submits[0]).not.toMatch(/Do NOT post/)
  })

  test('W32 a missing PR body proof is an author action at once, not PENDING', async ($, on) => {
    const s = status(8, { reasons: [PROOF_REASON, 'no CodeRabbit PR-bot review of the head commit'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 8, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 8: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    const line = seen.submits[0] as string
    expect(line).toMatch(/Author action: add or fix the Evidence block/)
    expect(line).toMatch(/update the GREEN line to that head/)
    expect(line).toContain('no "Proof type:" line')
    expect(line).toContain('aaaaaaa')
    expect(seen.toasts[0]).toMatch(/PR body proof needs fixing/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['PROOF'])
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
  })

  test('W35 a docs proof that the router did not confirm asks for the docs class and label, not a GREEN run', async ($, on) => {
    const DOCS_REASON = 'PR body proof: proof type docs needs the review router to class this head as docs, with risk:docs as the only risk label'
    const s = status(8, { reasons: [DOCS_REASON, 'no CodeRabbit PR-bot review of the head commit'] })
    const { clock, seen } = world(on, { store: seed([{ pr: 8, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 8: [s] } })
    await start($)
    await clock.advance(TICK)
    const line = seen.submits[0] as string
    expect(line).toContain('proof type docs needs the review router')
    expect(line).toMatch(/risk:docs/)
    expect(line).not.toMatch(/update the GREEN line/)
  })

  test('W32 a proof problem is PROOF after 60 minutes too, never STALLED', async ($, on) => {
    const s = status(8, { reasons: [GREEN_REASON] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 8, state: 'PENDING', head: HEAD_A, since: NOW - 61 * MIN }]), script: { 8: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits[0]).toMatch(/Author action/)
    expect(seen.submits[0]).not.toMatch(/after 60 minutes/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['PROOF'])
  })

  test('W32 a new head with a stale GREEN alerts again; the structured proof field counts without the reason text', async ($, on) => {
    const first = status(8, { reasons: [GREEN_REASON] })
    const second = status(8, { head: 'b'.repeat(40), headShort: 'bbbbbbb', reasons: [], proof: { required: true, type: 'feature', status: 'invalid', problems: [GREEN_REASON] } })
    const { clock, seen } = world(on, { store: seed([{ pr: 8, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 8: [first, second] } })
    await start($)
    await clock.advance(TICK)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(2)
    expect(seen.submits[1]).toContain('bbbbbbb')
  })

  test('W34 a proof problem only in status.proof.problems is listed in the author line', async ($, on) => {
    const s = status(8, { reasons: [], proof: { required: true, type: 'feature', status: 'invalid', problems: [PROOF_REASON, GREEN_REASON] } })
    const { clock, seen } = world(on, { store: seed([{ pr: 8, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 8: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    const line = seen.submits[0] as string
    expect(line).toContain('no "Proof type:" line')
    expect(line).toContain('GREEN names commit aaaaaaa')
    expect(line).not.toMatch(/wrong: \./)
    expect(line).toMatch(/Author action/)
  })

  test('W32 findings on a reviewed head come before the proof problem', async ($, on) => {
    const s = status(8, { routing: CR_ONLY, routedReviewed: true, coderabbitReviewedHead: true, reviewedHead: true, unresolved: 2, reasons: [PROOF_REASON, '2 review thread(s) unresolved'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 8, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 8: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits[0]).toMatch(/was reviewed by CodeRabbit but is not READY/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['REVIEWED'])
  })

  test('W33 a STALLED line lists the reasons', async ($, on) => {
    const s = status(9, { routing: DEEP, reviewedHead: true, coderabbitReviewedHead: true, routedReviewed: true, reasons: ['check "ci" is in_progress/null', 'mergeable_state is "blocked"'] })
    const { clock, seen } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - 61 * MIN }]), script: { 9: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits[0]).toContain('Reasons: check "ci" is in_progress/null; mergeable_state is "blocked"')
  })

  test('W33 a STALLED line for a missing bot review lists the reasons too', async ($, on) => {
    const t = status(10, { routing: CR_ONLY, routedReviewed: false, reviewedHead: true, reasons: ['no CodeRabbit PR-bot review of the head commit'] })
    const { clock, seen } = world(on, { store: seed([{ pr: 10, state: 'PENDING', head: HEAD_A, since: NOW - 61 * MIN }]), script: { 10: [t] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits[0]).toContain('Reasons: no CodeRabbit PR-bot review of the head commit')
  })

  test('W16 another session\'s list is not watched', async ($, on) => {
    const { clock, seen } = world(on, { store: { 'pr-watch:other-session': { prs: [{ pr: 4, state: null, whenReady: false }], backoffUntil: 0, touched: 1_000_000 } }, script: { 4: [READY(4)] } })
    await start($)
    await clock.advance(TICK * 2)
    expect(seen.status).toEqual([])
  })

  test('W14 CCV3_MODS_OFF=1 arms nothing and registers nothing', async ($, on) => {
    const { clock, seen } = world(on, { env: { CCV3_MODS_OFF: '1' }, store: seed([{ pr: 7 }]), script: { 7: [READY(7)] } })
    await start($)
    await clock.advance(TICK * 2)
    expect(seen.status).toEqual([])
    expect(seen.tools).toEqual([])
    expect(seen.registered).toEqual([])
  })
})

describe('pr-loop store', () => {
  test('W18 a list untouched for a week is deleted at session start; a fresh one stays', async ($, on) => {
    const old = { prs: [{ pr: 1, state: null, whenReady: false }], backoffUntil: 0, touched: 1_000_000 - 8 * 24 * 3_600_000 }
    const fresh = { prs: [{ pr: 2, state: null, whenReady: false }], backoffUntil: 0, touched: 1_000_000 - 3_600_000 }
    const { store } = world(on, { store: { 'pr-watch:old-session': old, 'pr-watch:fresh-session': fresh, unrelated: 1 } })
    await start($)
    expect([...store.keys()].sort()).toEqual(['pr-watch:fresh-session', 'unrelated'])
  })
})

describe('pr-loop view', () => {
  test('W19 the pane and the band show the watched PRs', async ($, on) => {
    world(on, { store: seed([{ pr: 12, state: 'PENDING' }, { pr: 13, state: 'LIMITED' }]) })
    await start($)
    const pane = await $.ui.mount({
      plugin: 'ccv3-mods',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'agentic-os',
      props: { title: 'Agentic OS', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 24 }, view: {} },
      viewport: { columns: 60, rows: 24 },
    })
    const rows = (await pane.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-')).map(found => found.text).join(String.fromCharCode(10))
    await pane.unmount()
    expect(rows).toMatch(/PRS/)
    expect(rows).toMatch(/#12\s+● PENDING/)
    expect(rows).toMatch(/#13\s+● LIMITED/)
    const band = await $.ui.mount({
      plugin: 'ccv3-mods',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    const text = (await band.find({ key: 'row-band' }))?.text
    await band.unmount()
    expect(text).toContain('PR #12 #13')
  })

  test('W19 no watched PR leaves the band quiet', async ($, on) => {
    world(on)
    await start($)
    const band = await $.ui.mount({
      plugin: 'ccv3-mods',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect(await band.find({ key: 'row-band' })).toBeUndefined()
    await band.unmount()
  })
})

describe('pr-loop tools', () => {
  test('W7 pr_watch rejects a bad PR number and adds a repeated PR once', async ($, on) => {
    const { store } = world(on, { script: { 12: [status(12)] } })
    await start($)
    for (const pr of [0, -1, 1.5, '12', null]) {
      const bad = await $.tool.call({ tool: PR_TOOL, pr })
      expect(bad.isError === true || bad.deny !== undefined).toBe(true)
    }
    expect(stored(store)).toBeUndefined()
    await $.tool.call({ tool: PR_TOOL, pr: 12 })
    await $.tool.call({ tool: PR_TOOL, pr: 12 })
    expect(stored(store)?.prs.map(p => p.pr)).toEqual([12])
  })

  test('W8 pr_status returns the status JSON to the model', async ($, on) => {
    const { seen } = world(on, { script: { 12: [READY(12)] } })
    await start($)
    const ran = await $.tool.call({ tool: STATUS_TOOL, pr: 12 })
    expect(seen.status).toEqual([12])
    // Live, the engine refused a result object: only a string or a list of content blocks fits the tool's output shape.
    const blocks = ran.result as { type: string; text: string }[]
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks[0]?.type).toBe('text')
    expect(JSON.parse(blocks[0]?.text ?? '')).toMatchObject({ pr: 12, ready: true, headShort: 'aaaaaaa' })
  })

  test('W5 headless registers pr_status but not pr_watch, and arms no timer', async ($, on) => {
    const { clock, seen } = world(on, { store: seed([{ pr: 7 }]), script: { 7: [READY(7)] } })
    await start($, false)
    await clock.advance(TICK * 2)
    // Agentic OS registers brief_set and the PR checkpoint module registers pr_checkpoint (a headless session gets its text plan) in the same session; this test is about this module's tools.
    expect(seen.tools.filter(name => name !== 'brief_set' && name !== 'pr_checkpoint')).toEqual(['pr_status'])
    expect(seen.status).toEqual([])
    expect(seen.toasts).toEqual([])
  })
})

describe('/watch', () => {
  test('W9 /watch N --once answers with the status and arms nothing', async ($, on) => {
    const { clock, seen, store } = world(on, { script: { 12: [status(12)] } })
    await start($)
    const out = await run($, 'watch', '12 --once')
    expect(out.text).toContain('#12')
    expect(out.text).toMatch(/NOT READY/)
    expect(stored(store)).toBeUndefined()
    await clock.advance(TICK * 3)
    expect(seen.status).toEqual([12])
  })

  test('/watch N adds the PR; /watch lists it', async ($, on) => {
    const { store } = world(on, { script: { 12: [status(12)] } })
    await start($)
    const added = await run($, 'watch', '12')
    expect(added.text).toContain('#12')
    expect(stored(store)?.prs.map(p => p.pr)).toEqual([12])
    const listed = await run($, 'watch', '')
    expect(listed.text).toContain('#12')
  })

  test('W5 headless /watch N checks once and arms nothing', async ($, on) => {
    const { clock, seen, store } = world(on, { script: { 12: [status(12)] } })
    await start($, false)
    const out = await run($, 'watch', '12')
    expect(out.text).toContain('#12')
    expect(stored(store)).toBeUndefined()
    await clock.advance(TICK * 3)
    expect(seen.status).toEqual([12])
  })
})

describe('/land', () => {
  test('W10 Land runs the land call once, with the press as consent', async ($, on) => {
    const { seen } = world(on, { answer: 'Land', script: { 12: [READY(12)] } })
    await start($)
    const out = await run($, 'land', '12')
    expect(seen.asks).toEqual(['Land #12?'])
    expect(seen.land.length).toBe(1)
    expect(seen.land[0]).toMatchObject({ tool: 'PowerShell', consent: 'The user pressed "Land" on /land #12' })
    expect(String(seen.land[0]?.command)).toMatch(/land-pr\.ps1"? -Pr 12$/)
    expect(out.text).toContain('LANDED')
  })

  for (const answer of ['No', 'dismiss'] as const) {
    test(`W10 ${answer} runs nothing`, async ($, on) => {
      const { seen } = world(on, { answer, script: { 12: [READY(12)] } })
      await start($)
      const out = await run($, 'land', '12')
      expect(seen.asks.length).toBe(1)
      expect(seen.land).toEqual([])
      expect(seen.submits).toEqual([])
      expect(out.text).toMatch(/not landed|nothing landed/i)
    })
  }

  test('W10 a reply that is not exactly Land lands nothing', async ($, on) => {
    const { seen } = world(on, { answer: 'Land now please' as never, script: { 12: [READY(12)] } })
    await start($)
    await run($, 'land', '12')
    expect(seen.land).toEqual([])
  })

  test('W5 headless /land shows the status, asks nobody and runs nothing', async ($, on) => {
    const { seen } = world(on, { answer: 'Land', script: { 12: [READY(12)] } })
    await start($, false)
    const out = await run($, 'land', '12')
    expect(out.text).toContain('READY')
    expect(seen.asks).toEqual([])
    expect(seen.land).toEqual([])
    expect(seen.submits).toEqual([])
  })

  test('W11 NOT READY shows the reasons and asks nothing', async ($, on) => {
    const { seen, store } = world(on, { answer: 'Land', script: { 12: [status(12, { reasons: ['2 review thread(s) unresolved'] })] } })
    await start($)
    const out = await run($, 'land', '12')
    expect(out.text).toContain('2 review thread(s) unresolved')
    expect(seen.asks).toEqual([])
    expect(seen.land).toEqual([])
    expect(stored(store)).toBeUndefined()
  })

  test('W11 a merged PR is not landed again', async ($, on) => {
    const { seen } = world(on, { answer: 'Land', script: { 12: [MERGED(12)] } })
    await start($)
    const out = await run($, 'land', '12')
    expect(out.text).toMatch(/merged/i)
    expect(seen.asks).toEqual([])
    expect(seen.land).toEqual([])
  })

  test('W11 --when-ready flags the watch; headless arms nothing', async ($, on) => {
    const { store } = world(on, { script: { 12: [status(12)] } })
    await start($)
    await run($, 'land', '12 --when-ready')
    expect(stored(store)?.prs).toEqual([{ pr: 12, state: 'PENDING', whenReady: true }])
  })

  test('W11 headless --when-ready adds no watch', async ($, on) => {
    const { store } = world(on, { script: { 12: [status(12)] } })
    await start($, false)
    const out = await run($, 'land', '12 --when-ready')
    expect(stored(store)).toBeUndefined()
    expect(out.text).toMatch(/interactive/i)
  })

  test('W12 a PR flagged --when-ready asks Land/No at READY; Land lands once; no report line', async ($, on) => {
    const { clock, seen, store } = world(on, { answer: 'Land', store: seed([{ pr: 7, state: 'PENDING', whenReady: true }]), script: { 7: [READY(7)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.asks).toEqual(['Land #7?'])
    expect(seen.land.length).toBe(1)
    expect(String(seen.land[0]?.command)).toMatch(/-Pr 7$/)
    expect(seen.toasts.length).toBe(2)
    expect(seen.toasts[1]).toContain('LANDED')
    expect(seen.submits).toEqual([])
    expect(stored(store)).toBeUndefined()
  })

  test('W12 a flagged PR answered No lands nothing', async ($, on) => {
    const { clock, seen } = world(on, { answer: 'No', store: seed([{ pr: 7, state: 'PENDING', whenReady: true }]), script: { 7: [READY(7)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.asks.length).toBe(1)
    expect(seen.land).toEqual([])
    // The PR left the list at READY: a No must not leave Dave with only a 10 second toast.
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toContain('#7')
    expect(seen.submits[0]).toMatch(/READY/)
    expect(seen.submits[0]).toMatch(/do not merge/i)
  })

  test('W12 a flagged PR whose dialog is dismissed still reports READY to the model', async ($, on) => {
    const { clock, seen } = world(on, { answer: 'dismiss', store: seed([{ pr: 7, state: 'PENDING', whenReady: true }]), script: { 7: [READY(7)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.land).toEqual([])
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/READY/)
  })

  test('W13 with no shell tool, Land hands the model one instruction instead', async ($, on) => {
    const { clock, seen } = world(on, { answer: 'Land', tools: ['Read'], script: { 12: [READY(12)] } })
    await start($)
    await run($, 'land', '12')
    await clock.advance(1)
    expect(seen.land).toEqual([])
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toContain('land-pr.ps1')
    expect(seen.submits[0]).toContain('-Pr 12')
    expect(seen.submits[0]).toContain('pressed "Land"')
  })
})

const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)
const NOW = 1_000_000
const REVIEWED_WITH_THREADS = (pr: number, over: Partial<Status> = {}) =>
  status(pr, { reviewedHead: true, unresolved: 3, reasons: ['3 review thread(s) unresolved'], mergeable_state: 'blocked', ...over })

describe('/land interrupted', () => {
  test('W20 an aborted Land call submits nothing and says so; it does not ask the model to merge again', async ($, on) => {
    const { clock, seen } = world(on, { answer: 'Land', landThrows: true, script: { 12: [READY(12)] } })
    await start($)
    const out = await run($, 'land', '12')
    await clock.advance(1)
    expect(seen.land.length).toBe(1)
    expect(seen.submits).toEqual([])
    expect(out.text).toMatch(/interrupted/i)
    expect(out.text).not.toMatch(/No shell tool/i)
  })

  test('W20 an aborted Land from the READY dialog also submits nothing', async ($, on) => {
    const { clock, seen } = world(on, { answer: 'Land', landThrows: true, store: seed([{ pr: 7, state: 'PENDING', whenReady: true }]), script: { 7: [READY(7)] } })
    await start($)
    await clock.advance(TICK)
    await clock.advance(1)
    expect(seen.submits).toEqual([])
    expect(seen.toasts.some(text => /interrupted/i.test(text))).toBe(true)
  })
})

describe('pr-loop review alerts', () => {
  test('W21 a reviewed head with open threads alerts once with the act-on-it instruction, and stays watched', async ($, on) => {
    const { clock, seen, store } = world(on, { store: seed([{ pr: 7, state: 'PENDING' }]), script: { 7: [REVIEWED_WITH_THREADS(7)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toContain('#7')
    expect(seen.submits[0]).toContain('3 review thread(s) unresolved')
    expect(seen.submits[0]).toContain('When the review lands')
    expect(seen.submits[0]).toMatch(/do not merge/i)
    expect(seen.toasts.length).toBe(1)
    expect(seen.toasts[0]).toMatch(/#7/)
    expect(stored(store)?.prs.map(p => p.pr)).toEqual([7])
    await clock.advance(TICK)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
  })

  test('W21 a failing check on a reviewed head alerts', async ($, on) => {
    const { clock, seen } = world(on, { store: seed([{ pr: 7, state: 'PENDING' }]), script: { 7: [status(7, { reviewedHead: true, unresolved: 0, reasons: ['check "ci" is completed/failure'] })] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
  })

  test('W21 a reviewed head whose checks are still running is not an alert', async ($, on) => {
    const { clock, seen } = world(on, { store: seed([{ pr: 7, state: 'PENDING' }]), script: { 7: [status(7, { reviewedHead: true, unresolved: 0, reasons: ['check "ci" is in_progress/null'] })] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits).toEqual([])
    expect(seen.toasts).toEqual([])
  })

  test('W21 a new head with a new review alerts again, even when both fall between two checks', async ($, on) => {
    const { clock, seen } = world(on, {
      store: seed([{ pr: 7, state: 'REVIEWED', head: HEAD_A, since: NOW - MIN, alerted: `REVIEWED:${HEAD_A}` }]),
      script: { 7: [REVIEWED_WITH_THREADS(7, { head: HEAD_B, headShort: 'bbbbbbb' })] },
    })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toContain('bbbbbbb')
  })

  test('W22 no review 60 minutes after the head appeared alerts once', async ($, on) => {
    const { clock, seen, store } = world(on, { store: seed([{ pr: 7, state: 'PENDING', head: HEAD_A, since: NOW - 61 * MIN }]), script: { 7: [status(7)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/no Greptile review after 60 minutes/i)
    expect(seen.submits[0]).toMatch(/pr-review-loop\.md "No review on the head"/)
    expect(stored(store)?.prs.map(p => p.pr)).toEqual([7])
    await clock.advance(TICK)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
  })

  test('W26 a reviewed head below the confidence bar alerts REVIEWED, not STALLED', async ($, on) => {
    const low = status(7, { reviewedHead: true, lowConfidence: true, confidence: 3, unresolved: 0, reasons: ['Greptile confidence 3/5 is below 4'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 7, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 7: [low] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/reviewed by Greptile but is not READY/)
    expect(seen.submits[0]).toContain('confidence 3/5')
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['REVIEWED'])
  })

  test('W27 a CodeRabbit review that was skipped or rate limited is reported once as LIMITED, not left PENDING', async ($, on) => {
    const skipped = status(8, { coderabbitLimited: true, reasons: ['CodeRabbit skipped the review of the head (label gate or rate limit)'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 8, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 8: [skipped] } })
    await start($)
    await clock.advance(TICK)
    await clock.advance(TICK)
    expect(seen.toasts.length).toBe(1)
    expect(seen.toasts[0]).toMatch(/did not finish/i)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/CodeRabbit/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['LIMITED'])
  })

  test('W27 a CodeRabbit limit does not hide a reviewed head that needs a fix', async ($, on) => {
    const both = status(8, { coderabbitLimited: true, reviewedHead: true, unresolved: 2, reasons: ['2 review thread(s) unresolved', 'CodeRabbit skipped the review of the head'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 8, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 8: [both] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/reviewed by Greptile but is not READY/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['REVIEWED'])
  })

  test('W27 coderabbitLimited false stays PENDING and quiet', async ($, on) => {
    const { clock, seen, store } = world(on, { store: seed([{ pr: 8, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 8: [status(8, { coderabbitLimited: false })] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits).toEqual([])
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['PENDING'])
  })

  test('W22 30 minutes without a review is still quiet', async ($, on) => {
    const { clock, seen } = world(on, { store: seed([{ pr: 7, state: 'PENDING', head: HEAD_A, since: NOW - 30 * MIN }]), script: { 7: [status(7)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits).toEqual([])
  })

  test('W22 a push restarts the 60 minute clock', async ($, on) => {
    const { clock, seen } = world(on, { store: seed([{ pr: 7, state: 'PENDING', head: HEAD_B, since: NOW - 90 * MIN }]), script: { 7: [status(7)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits).toEqual([])
  })

  test('W22 the 60 minutes run from the first check when the list had no clock', async ($, on) => {
    const { clock, seen } = world(on, { store: seed([{ pr: 7 }]), script: { 7: [status(7)] } })
    await start($)
    for (let i = 0; i < 11; i++) await clock.advance(TICK)
    expect(seen.submits).toEqual([])
    await clock.advance(TICK)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
  })
})

describe('pr-loop bad status answers', () => {
  test('W23 a status script without prState is an error, never CLOSED', async ($, on) => {
    const { clock, seen, store } = world(on, { store: seed([{ pr: 5 }]), script: { 5: ['old-script'] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.toasts.some(text => /^PR #5: (closed|merged)/i.test(text))).toBe(false)
    expect(seen.toasts.some(text => /prState/.test(text))).toBe(true)
    expect(stored(store)?.prs.map(p => p.pr)).toEqual([5])
  })

  test('W23 /land on a status script without prState does not call the PR closed', async ($, on) => {
    const { seen } = world(on, { answer: 'Land', script: { 12: ['old-script'] } })
    await start($)
    const out = await run($, 'land', '12')
    expect(out.text).not.toMatch(/closed/i)
    expect(out.text).toMatch(/prState/)
    expect(seen.asks).toEqual([])
  })
})

describe('pr-loop one bad PR', () => {
  test('W24 a PR that answers 404 does not stop the checks of the PRs after it', async ($, on) => {
    const { clock, seen, store } = world(on, { store: seed([{ pr: 99 }, { pr: 7 }]), script: { 99: ['not-found'], 7: [READY(7)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.status).toEqual([99, 7])
    expect(seen.toasts.some(text => /#7.*READY/.test(text))).toBe(true)
    expect(stored(store)?.backoffUntil ?? 0).toBe(0)
  })

  test('W24 a PR that fails three checks in a row is dropped with a notice', async ($, on) => {
    const { clock, seen, store } = world(on, { store: seed([{ pr: 99 }]), script: { 99: ['not-found'] } })
    await start($)
    await clock.advance(TICK)
    await clock.advance(TICK)
    expect(stored(store)?.prs.map(p => p.pr)).toEqual([99])
    expect(seen.toasts).toEqual([])
    await clock.advance(TICK)
    expect(stored(store)).toBeUndefined()
    expect(seen.toasts.length).toBe(1)
    expect(seen.toasts[0]).toMatch(/#99.*dropped/i)
    expect(seen.submits).toEqual([])
  })

  test('W24 a good answer between failures resets the count', async ($, on) => {
    const { clock, store } = world(on, { store: seed([{ pr: 99, fails: 2 }]), script: { 99: [status(99)] } })
    await start($)
    await clock.advance(TICK)
    expect(stored(store)?.prs.map(p => p.pr)).toEqual([99])
    expect((stored(store)?.prs[0] as { fails?: number }).fails ?? 0).toBe(0)
  })

  test('W24 an error every PR shares still backs the watcher off', async ($, on) => {
    const { clock, seen, store } = world(on, { store: seed([{ pr: 5 }, { pr: 6 }]), script: { 5: ['error'], 6: [status(6)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.status).toEqual([5])
    expect((stored(store)?.backoffUntil ?? 0) > 0).toBe(true)
  })

  test('W25 pr_watch refuses a PR whose status cannot be read, and /watch does too', async ($, on) => {
    const { seen, store } = world(on, { script: { 13: ['not-found'] } })
    await start($)
    const ran = await $.tool.call({ tool: PR_TOOL, pr: 13 })
    const blocks = ran.result as { type: string; text: string }[]
    expect(blocks[0]?.text).toMatch(/not watching #13/i)
    const out = await run($, 'watch', '13')
    expect(out.text).toMatch(/not watching #13/i)
    expect(seen.status).toEqual([13, 13])
    expect(stored(store)).toBeUndefined()
  })

  test('W25 pr_watch names the repository it checks', async ($, on) => {
    const { seen } = world(on)
    await start($)
    expect(seen.descriptions.pr_watch).toContain('Rev4nchist/Continuous-Claude-v3')
  })
})

describe('pr-loop outside-diff findings', () => {
  // CodeRabbit lists findings on lines outside the diff in its review body. They make no thread, so
  // unresolved is 0. review-status.mjs reports their count as coderabbitOutsideDiff and fails READY.
  const CR_ONLY_OD = { required: ['coderabbit'], held: null, source: 'labels' }
  const OUTSIDE = (pr: number, over: Partial<Status> = {}) =>
    status(pr, {
      routing: CR_ONLY_OD, routedReviewed: true, reviewedHead: false, coderabbitReviewedHead: true, unresolved: 0, coderabbitOutsideDiff: 3,
      reasons: ['CodeRabbit lists 3 outside-diff finding(s) on head aaaaaaa'], ...over,
    })

  test('W36 a reviewed head with outside-diff findings and no open thread alerts REVIEWED at once, not STALLED an hour later', async ($, on) => {
    const { clock, seen, store } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [OUTSIDE(9)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/reviewed by CodeRabbit but is not READY/)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['REVIEWED'])
  })

  test('W36 the REVIEWED line tells the model the findings are in the review body, where it must read them', async ($, on) => {
    const { clock, seen } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [OUTSIDE(9)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits[0]).toMatch(/review body/i)
    expect(seen.submits[0]).toMatch(/Outside-diff: handled/)
    expect(seen.submits[0]).toMatch(/do not merge/i)
  })

  test('W36 a Greptile-routed PR (no CodeRabbit label) with outside-diff findings and no open thread alerts REVIEWED too', async ($, on) => {
    const greptileRoute = { required: ['greptile'], held: null, source: 'default' }
    const s = status(9, {
      routing: greptileRoute, routedReviewed: true, reviewedHead: true, coderabbitReviewedHead: true, unresolved: 0, coderabbitOutsideDiff: 2,
      reasons: ['CodeRabbit lists 2 outside-diff finding(s) on head aaaaaaa'],
    })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [s] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['REVIEWED'])
  })

  test('W36 the review-body sentence is only for outside-diff alerts: an open thread with a count of 0 does not mention it', async ($, on) => {
    const threadOnly = OUTSIDE(9, { coderabbitOutsideDiff: 0, unresolved: 1, reasons: ['1 review thread(s) unresolved'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [threadOnly] } })
    await start($)
    await clock.advance(TICK)
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['REVIEWED'])
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).not.toMatch(/Outside-diff: handled/)
  })

  test('W36 findings the handled list already covers do not make REVIEWED: the PR waits for its pending check', async ($, on) => {
    // review-status.mjs writes the "CodeRabbit lists N outside-diff" reason only while N is above the handled count.
    const covered = OUTSIDE(9, { coderabbitOutsideDiff: 3, reasons: ['check "ci" is in_progress/null'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [covered] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits).toEqual([])
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['PENDING'])
  })

  test('W36 a count of 0 changes nothing: a reviewed head with nothing to fix and a pending check stays PENDING', async ($, on) => {
    const quiet = OUTSIDE(9, { coderabbitOutsideDiff: 0, reasons: ['check "ci" is in_progress/null'] })
    const { clock, seen, store } = world(on, { store: seed([{ pr: 9, state: 'PENDING', head: HEAD_A, since: NOW - MIN }]), script: { 9: [quiet] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits).toEqual([])
    expect(stored(store)?.prs.map(p => p.state)).toEqual(['PENDING'])
  })
})

// PR C (checkpoint states). The module under test is pr-loop plus the pr-checkpoint pane; every check reads the engine's calls.
// CW1  a draft PR is DRAFT: one toast "waiting on /<command>", no STALLED model line after 60 minutes
// CW2  review:none with no router state: the STALLED line names the router re-run, never "No review on the head"
// CW3  a PR that leaves draft restarts the 60 minute clock (it is not STALLED at its first ready check)
// CW4  the round ask fires at budget + 1 (rounds 3 of 1+2 -> "Round 4 of 1+2"), not before; the line says Dave decides in the pane
// CW5  the opening ask is queued 15 minutes after ready on a coderabbit record with 0 rounds
// CW6  a draft's pr_status text never tells the model to post @coderabbitai review
// CW7  a round grant changes the REVIEWED line to "Dave allowed round 4"
// CW8  a closed PR deletes its checkpoint record and grant
// CW9  after Dave declines the opening ask the STALLED line says "Do not request a review", not "No review on the head"
// CW10 a skipped CodeRabbit review at the budget (LIMITED) queues the round ask and tells the model to wait for Dave
// CW11 CLASS_RAISED_NOTE in the reasons: the line says "Run /<command> again" and "Do not request a review"
// CW12 an older status script (no isDraft) is still a draft, from the DRAFT_REASON text
// CW13 an older status script (no round fields) with a record: "rounds unknown", and no round ask
describe('pr-loop checkpoint states', () => {
  // The command the pr-checkpoint module registers (COMMAND in pr-checkpoint.test.ts).
  const COMMAND = 'pathway'
  const DRAFT_REASON = 'PR is a draft (no bot review on drafts)'
  const NONE_UNVERIFIED = 'the router has not classified this head; re-run the router workflow'
  const CLASS_RAISED = 'class raised after the checkpoint (review:none was chosen at a lower class). Run /checkpoint again'
  const CR_ROUTE = { required: ['coderabbit'], held: null, source: 'labels' }
  const NO_REVIEW = 'no CodeRabbit PR-bot review of the head commit (CLI/plugin output does not count). After a push, post "@coderabbitai review" once to start one'
  const record = (over: Record<string, unknown> = {}) => ({
    pr: 7, state: 'applied', head: HEAD_A, pathway: 'coderabbit', label: 'review:coderabbit', budget: [1, 2], decided_by: 'default',
    capacity: { count: 38, band: 'ok', source: 'manual', date: '2026-10-25' }, session: SESSION, appliedAt: NOW - 11 * MIN, ...over,
  })
  const cw = (on: On, opts: Opts = {}) => {
    const w = world(on, opts)
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('ui.close', () => ({ value: undefined }))
    mock.session(on)
    return w
  }
  const ticks = async (clock: { advance: (ms: number) => Promise<unknown> }, n: number) => {
    for (let i = 0; i < n; i += 1) await clock.advance(TICK)
  }
  /** Every `gh pr comment` the mod ran. A review request is posted only on Dave's press in the pane, never by the watcher. */
  const comments = (seen: { calls: string[][] }) => seen.calls.filter(argv => argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'comment')
  const asks = (store: Map<string, unknown>) => (store.get(`checkpoint:asks:${SESSION}`) ?? []) as { kind: string; text: string }[]
  const REVIEWED_AT = (rounds: number, over: Partial<Status> = {}) =>
    status(7, { routing: CR_ROUTE, routedReviewed: true, coderabbitReviewedHead: true, unresolved: 1, reasons: ['1 review thread(s) unresolved'], isDraft: false, coderabbitRounds: rounds, ...over })

  test('CW1 a draft PR is DRAFT: one toast "waiting on /<command>", and no STALLED line after 60 minutes', async ($, on) => {
    const draft = status(7, { isDraft: true, labels: [], routing: CR_ROUTE, routedReviewed: false, reasons: [DRAFT_REASON, NO_REVIEW] })
    const { clock, seen } = cw(on, { store: seed([{ pr: 7, head: HEAD_A, since: NOW - MIN }]), script: { 7: [draft] } })
    await start($)
    await ticks(clock, 13)
    expect(seen.submits).toEqual([])
    expect(seen.toasts.length).toBe(1)
    expect(seen.toasts[0]).toContain(`waiting on /${COMMAND}`)
  })

  test('CW2 review:none with no router state: STALLED names the router re-run and never "No review on the head"', async ($, on) => {
    const none = status(7, { labels: ['review:none', 'risk:normal'], routing: { required: [], held: null, source: 'labels' }, routedReviewed: true, reasons: [NONE_UNVERIFIED] })
    const { clock, seen } = cw(on, { store: seed([{ pr: 7, head: HEAD_A, since: NOW - MIN }]), script: { 7: [none] } })
    await start($)
    await ticks(clock, 13)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/re-run the review-router workflow/i)
    expect(seen.submits[0]).toContain('review:none')
    expect(seen.submits[0]).not.toMatch(/No review on the head/)
  })

  test('CW3 a PR that leaves draft restarts the 60 minute clock: no STALLED at its first ready check', async ($, on) => {
    const draft = status(7, { isDraft: true, labels: [], routing: CR_ROUTE, routedReviewed: false, reasons: [DRAFT_REASON, NO_REVIEW] })
    const ready = status(7, { routing: CR_ROUTE, routedReviewed: false, reasons: [NO_REVIEW] })
    const { clock, seen } = cw(on, { store: seed([{ pr: 7, head: HEAD_A, since: NOW - MIN }]), script: { 7: [...Array.from({ length: 12 }, () => draft), ready] } })
    await start($)
    await ticks(clock, 13)
    expect(seen.submits).toEqual([])
  })

  test('CW4 the round ask fires at budget + 1: rounds 3 of 1+2 ask "Round 4 of 1+2", and the line sends the decision to the pane', async ($, on) => {
    const { clock, seen, store } = cw(on, { store: { ...seed([{ pr: 7, head: HEAD_A, since: NOW - MIN }]), 'checkpoint:pr:7': record() }, script: { 7: [REVIEWED_AT(3)] } })
    await start($)
    await clock.advance(TICK)
    expect(asks(store).map(ask => ask.kind)).toEqual(['round'])
    expect(asks(store)[0]!.text).toContain('Round 4 of 1+2 for #7')
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toContain('Dave decides round 4 in the checkpoint pane')
    expect(seen.submits[0]).not.toMatch(/post one @coderabbitai review/i)
    expect(comments(seen)).toEqual([])
  })

  test('CW4b rounds 2 of 1+2: no ask, and the line says "Rounds used 2 of 1+2" with a round left', async ($, on) => {
    const { clock, seen, store } = cw(on, { store: { ...seed([{ pr: 7, head: HEAD_A, since: NOW - MIN }]), 'checkpoint:pr:7': record() }, script: { 7: [REVIEWED_AT(2)] } })
    await start($)
    await clock.advance(TICK)
    expect(asks(store)).toEqual([])
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toContain('Rounds used 2 of 1+2')
    expect(seen.submits[0]).toMatch(/post one @coderabbitai review/i)
  })

  // Clock anchor (critic finding 14): CW5 and the pr-checkpoint A2/A2b start the 15 minutes at the record's `appliedAt`, the moment the mod's
  // --apply succeeded. That is when the PR left draft (plan 4.2 "since the PR left draft"), not the first watcher check and not the push.
  test('CW5 the opening ask is queued 15 minutes after ready on a coderabbit record with 0 rounds', async ($, on) => {
    const quiet = status(7, { routing: CR_ROUTE, routedReviewed: false, reasons: [NO_REVIEW] })
    const { clock, seen, store } = cw(on, { store: { ...seed([{ pr: 7, head: HEAD_A, since: NOW - MIN }]), 'checkpoint:pr:7': record() }, script: { 7: [quiet] } })
    await start($)
    await clock.advance(TICK)
    expect(asks(store).map(ask => ask.kind)).toEqual(['opening'])
    expect(asks(store)[0]!.text).toContain('Post one @coderabbitai review?')
    expect(seen.submits).toEqual([])
    expect(comments(seen)).toEqual([])
  })

  test('CW6 a draft status text never tells the model to post @coderabbitai review', async ($, on) => {
    const draft = status(7, { isDraft: true, labels: [], routing: CR_ROUTE, routedReviewed: false, reasons: [DRAFT_REASON, NO_REVIEW] })
    cw(on, { script: { 7: [draft] } })
    await start($)
    const told = JSON.stringify(((await $.tool.call({ tool: STATUS_TOOL, pr: 7 } as never)) as unknown as { result?: unknown }).result)
    expect(told).toContain(`waiting on Dave's /${COMMAND}`)
    expect(told).toMatch(/Do not request a review/)
    expect(told).not.toContain('@coderabbitai')
  })

  test('CW7 a round grant changes the REVIEWED line to "Dave allowed round 4"', async ($, on) => {
    const kept = { ...seed([{ pr: 7, head: HEAD_A, since: NOW - MIN }]), 'checkpoint:pr:7': record(), 'checkpoint:grant:7': { round: 4, head: HEAD_A, at: NOW } }
    const { clock, seen, store } = cw(on, { store: kept, script: { 7: [REVIEWED_AT(3)] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toContain('Dave allowed round 4')
    expect(asks(store)).toEqual([])
  })

  test('CW8 a closed PR deletes its checkpoint record and grant', async ($, on) => {
    const kept = { ...seed([{ pr: 7 }]), 'checkpoint:pr:7': record(), 'checkpoint:grant:7': { round: 4, head: HEAD_A, at: NOW } }
    const { clock, store } = cw(on, { store: kept, script: { 7: [CLOSED(7)] } })
    await start($)
    await clock.advance(TICK)
    expect(store.get('checkpoint:pr:7')).toBeUndefined()
    expect(store.get('checkpoint:grant:7')).toBeUndefined()
  })

  test('CW9 after Dave declined the opening ask, STALLED says "Do not request a review" and never "No review on the head"', async ($, on) => {
    const quiet = status(7, { routing: CR_ROUTE, routedReviewed: false, reasons: [NO_REVIEW] })
    const declined = record({ declined: { kind: 'opening', round: 1, head: HEAD_A } })
    const { clock, seen } = cw(on, { store: { ...seed([{ pr: 7, head: HEAD_A, since: NOW - 61 * MIN }]), 'checkpoint:pr:7': declined }, script: { 7: [quiet] } })
    await start($)
    await clock.advance(TICK)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toMatch(/Do not request a review/)
    expect(seen.submits[0]).not.toMatch(/No review on the head/)
  })

  test('CW10 a skipped CodeRabbit review at the budget (LIMITED, rounds 3 of 1+2) queues the round ask and tells the model to wait for Dave', async ($, on) => {
    const skipped = status(7, { routing: CR_ROUTE, routedReviewed: false, coderabbitReviewedHead: false, coderabbitLimited: true, coderabbitRounds: 3, reasons: ['CodeRabbit skipped the review of the head (PR-bot review did not run; CLI/plugin output does not count)'] })
    const { clock, seen, store } = cw(on, { store: { ...seed([{ pr: 7, head: HEAD_A, since: NOW - MIN }]), 'checkpoint:pr:7': record() }, script: { 7: [skipped] } })
    await start($)
    await clock.advance(TICK)
    expect(asks(store).map(ask => ask.kind)).toEqual(['round'])
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toContain('Dave decides round 4 in the checkpoint pane')
    expect(seen.submits[0]).not.toMatch(/No review on the head/)
    expect(comments(seen)).toEqual([])
  })

  test('CW11 CLASS_RAISED_NOTE in the reasons: the line says "Run /<command> again" and "Do not request a review"', async ($, on) => {
    const raised = status(7, { labels: ['review:none', 'risk:infra'], routing: { required: [], held: null, source: 'labels' }, routedReviewed: true, reasons: [CLASS_RAISED] })
    const { clock, seen } = cw(on, { store: seed([{ pr: 7, head: HEAD_A, since: NOW - MIN }]), script: { 7: [raised] } })
    await start($)
    await ticks(clock, 13)
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toContain(`Run /${COMMAND} again: the class rose after the checkpoint. Do not request a review.`)
  })

  test('CW12 an older status script with no isDraft is still a draft, from the DRAFT_REASON text', async ($, on) => {
    const old = status(7, { routing: CR_ROUTE, routedReviewed: false, reasons: [DRAFT_REASON, NO_REVIEW] })
    const { clock, seen } = cw(on, { store: seed([{ pr: 7, head: HEAD_A, since: NOW - MIN }]), script: { 7: [old] } })
    await start($)
    await ticks(clock, 13)
    expect(seen.submits).toEqual([])
    expect(seen.toasts.length).toBe(1)
    expect(seen.toasts[0]).toContain(`waiting on /${COMMAND}`)
  })

  test('CW13 an older status script with no round fields and a record: "rounds unknown", and no round ask', async ($, on) => {
    const old = status(7, { routing: CR_ROUTE, routedReviewed: true, coderabbitReviewedHead: true, unresolved: 1, reasons: ['1 review thread(s) unresolved'] })
    const { clock, seen, store } = cw(on, { store: { ...seed([{ pr: 7, head: HEAD_A, since: NOW - MIN }]), 'checkpoint:pr:7': record() }, script: { 7: [old] } })
    await start($)
    await clock.advance(TICK)
    expect(asks(store)).toEqual([])
    expect(seen.submits.length).toBe(1)
    expect(seen.submits[0]).toContain('rounds unknown')
  })
})
