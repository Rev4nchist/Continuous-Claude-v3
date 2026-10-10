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
}

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
  const seen = { status: [] as number[], toasts: [] as string[], submits: [] as string[], asks: [] as string[], land: [] as Record<string, unknown>[], registered: [] as string[], tools: [] as string[], descriptions: {} as Record<string, string> }
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
  test('W1 pending, pending, READY gives one toast and one report line and the PR leaves the list', async ($, on) => {
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
    expect(seen.tools).toEqual(['pr_status'])
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
