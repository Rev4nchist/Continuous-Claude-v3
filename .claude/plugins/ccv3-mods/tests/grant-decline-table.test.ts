import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { tableProblems } from './state-table'
import type { Cell } from './state-table'

// T3: Dave's Yes to a review round against a decline that is kept, as a state x event table (check C5).
//
// The PR Checkpoint mod records a decline (the opening review, or a round) and a queue of asks. Dave answers a round ask in two
// ways: the typed grant command (a grant of round 4 for PR 7) and a Yes in the dialog the mod raises. CodeRabbit found Major #84 on PR 238: with a
// decline the grant does not cover (the opening review, or a later round), the model was still told to post a review. This table
// pairs every decline with every queued ask and every way Dave answers, so the next pair that is missing fails a test.
//
// States are "<decline>/<queued ask>":
//   decline:    none, opening (the opening review), round-3 (covered by a grant of 4), round-5 (not covered)
//   queued ask: none, covered (a round 4 ask), uncovered (a round 5 ask)
// Events: grant (the typed grant 7 4), grant-twice (the same grant typed again), dialog-yes (a bare /pathway raises the first queued ask; Dave answers Yes).
//
// Each cell asserts: the stored grant round, the decline left on the record, the rounds still queued, and what the model is told
// (an allowed line; "decline of X stays" for a kept decline; "post one @coderabbitai review" only when no decline is kept).
//
// Break it (the cell that goes red):
//   #84 the model is told to post a review while an uncovered decline stays:   opening/none + grant, round-5/none + grant
//   a grant clears a decline it does not cover:                                opening/none + grant, round-5/none + grant
//   a grant keeps a decline it covers (round-3):                               round-3/none + grant
//   a grant leaves a covered queued ask in the queue:                          none/covered + grant
//   a grant removes an uncovered queued ask:                                   none/uncovered + grant
//   the dialog Yes clears a decline it does not cover (D-a):                  opening/covered + dialog-yes, round-5/covered + dialog-yes
//   the table loses a cell or a kind:                                          T3 table is complete

const SESSION = 'test-session'
const ROOT = 'C:/r'
const HEAD = 'a'.repeat(40)
const COMMAND = 'pathway'
const NOW = 1_000_000
const MIN = 60_000
const ASKS = `checkpoint:asks:${SESSION}`
const WATCH = `pr-watch:${SESSION}`
const CONFIG = `${ROOT}/review-router.config.json`

type Rec = Record<string, unknown>

const status = (pr: number): Rec => ({
  pr, head: HEAD, headShort: 'aaaaaaa', branch: 'feat/x', ready: false, reasons: ['1 review thread(s) unresolved'], mergeable_state: 'blocked', reviewedHead: false,
  unresolved: 1, rateLimited: false, prState: 'open', merged: false, isDraft: false, labels: ['review:coderabbit', 'risk:infra'],
  routing: { required: ['coderabbit'], held: null, source: 'labels' }, routedReviewed: true, coderabbitReviewedHead: true, coderabbitRounds: 3, coderabbitRequests: 2,
})

// The engine below the mod, mocked. Each table file builds its own world (see pr-checkpoint.test.ts for the long form).
const world = (on: On, store: Rec) => {
  mock.clock(on, { now: NOW })
  const variables: Record<string, string> = { USERPROFILE: 'C:/home' }
  on('env.get', (_$, e) => ({ value: variables[e.name] }))
  const session = mock.session(on)
  const kv = new Map<string, unknown>(Object.entries(store))
  const files: Record<string, string> = { [CONFIG]: JSON.stringify({ checkpoint: { enforce: false } }) }
  on('store.get', (_$, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_$, e) => {
    kv.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    kv.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...kv.keys()] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => ({ value: ROOT }))
  on('agent.list', () => ({ value: [] }))
  on('tool.list', () => ({ value: ['Bash', 'PowerShell'].map(name => ({ name })) as never }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', (_$, e) => {
    const text = files[e.path.replace(/\\/g, '/')]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }))
  // The dialog the mod raises ($.ui.ask): Dave answers Yes.
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const q = (e as unknown as { questions: { question: string; options: ({ label: string } | string)[] }[] }).questions[0]!
    const labels = q.options.map(one => (typeof one === 'string' ? one : one.label))
    return { result: { questions: [], answers: { [q.question]: labels.find(label => label.startsWith('Yes'))! } } } as never
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('process.run', (_$, e) => {
    const line = [...e.argv].join(' ')
    const out = line.includes('review-status.mjs') ? JSON.stringify(status(7)) : ''
    return { value: { exitCode: line.includes('review-status.mjs') ? 1 : 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { kv, session }
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
const slash = ($: Engine, args: string) =>
  $.command.run({ command: COMMAND, args, origin: { kind: 'composer' } as never, presentation: { isFullscreen: false, columns: 100 } })
const settle = async () => {
  for (let turn = 0; turn < 500; turn += 1) await Promise.resolve()
}

const DECLINES: Record<string, Rec | null> = {
  none: null,
  opening: { kind: 'opening', round: 1, head: HEAD },
  'round-3': { kind: 'round', round: 3, head: HEAD },
  'round-5': { kind: 'round', round: 5, head: HEAD },
}
const ask = (round: number): Rec => ({ kind: 'round', pr: 7, head: HEAD, text: `Round ${round} of 1+2 for #7`, round })
const QUEUES: Record<string, Rec[]> = { none: [], covered: [ask(4)], uncovered: [ask(5)] }

const record = (declined: Rec | null): Rec => ({
  pr: 7, state: 'applied', head: HEAD, pathway: 'coderabbit', label: 'review:coderabbit', budget: [1, 2], decided_by: 'default',
  capacity: { count: 38, band: 'ok', source: 'manual', date: '2026-10-25' }, session: SESSION, appliedAt: NOW - 26 * MIN, ...(declined ? { declined } : {}),
})

type Result = { grant: unknown; declined: Rec | undefined; queued: unknown[]; rows: string; text: string }

const EVENTS: Record<string, ($: Engine, kv: Map<string, unknown>) => Promise<string>> = {
  grant: async $ => String((await slash($, 'grant 7 4')).text ?? ''),
  'grant-twice': async $ => {
    await slash($, 'grant 7 4')
    return String((await slash($, 'grant 7 4')).text ?? '')
  },
  'dialog-yes': async $ => {
    await slash($, '')
    await settle()
    return ''
  },
}

/** Arrange the state, act the event, and read what the mod holds and told the model. */
async function play(stateId: string, eventId: string, $: Engine, on: On): Promise<Result> {
  const [decline, queue] = stateId.split('/') as [string, string]
  const w = world(on, {
    [WATCH]: { prs: [{ pr: 7, state: null, whenReady: false }], backoffUntil: 0, touched: NOW },
    'checkpoint:pr:7': record(DECLINES[decline] ?? null),
    ...(QUEUES[queue]!.length ? { [ASKS]: QUEUES[queue] } : {}),
  })
  await start($)
  const text = await EVENTS[eventId]!($, w.kv)
  await settle()
  return {
    grant: (w.kv.get('checkpoint:grant:7') as Rec | undefined)?.round,
    declined: (w.kv.get('checkpoint:pr:7') as Rec).declined as Rec | undefined,
    queued: ((w.kv.get(ASKS) ?? []) as Rec[]).map(one => one.round),
    rows: JSON.stringify(w.session.appended().map(row => row.message)),
    text,
  }
}

// What the typed grant of round 4 leaves behind. One fact per dimension, read from the spec of the command.
const DECLINE_AFTER_GRANT: Record<string, Rec | undefined> = { none: undefined, opening: DECLINES.opening!, 'round-3': undefined, 'round-5': DECLINES['round-5']! }
const KEPT_WORDS: Record<string, string | null> = { none: null, opening: 'the opening review', 'round-3': null, 'round-5': 'round 5' }
const QUEUE_AFTER_GRANT: Record<string, number[]> = { none: [], covered: [], uncovered: [5] }

type Want = { declined: Rec | undefined; queued: number[]; kept: string | null }
const grantWant = (decline: string, queue: string): Want => ({ declined: DECLINE_AFTER_GRANT[decline], queued: QUEUE_AFTER_GRANT[queue]!, kept: KEPT_WORDS[decline]! })
// A Yes in the dialog on a round 4 ask is the typed grant of 4: it clears only a round decline it covers (D-a, Dave 11-01).

const declineIds = Object.keys(DECLINES)
const queueIds = Object.keys(QUEUES)
const states = declineIds.flatMap(d => queueIds.map(q => `${d}/${q}`))
const events = Object.keys(EVENTS)

type TableCell = Cell & { want?: Want }
const label = (w: Want) => `declined ${w.declined ? `${w.declined.kind}-${w.declined.round}` : 'none'}, queued [${w.queued.join(' ')}], ${w.kept ? `decline of ${w.kept} stays, no review request` : 'post one review'}`
const cells: TableCell[] = []
for (const state of states) {
  const [decline, queue] = state.split('/') as [string, string]
  for (const event of ['grant', 'grant-twice']) cells.push({ state, event, expect: label(grantWant(decline, queue)), want: grantWant(decline, queue) })
  if (queue === 'covered') {
    cells.push({ state, event: 'dialog-yes', expect: label(grantWant(decline, queue)), want: grantWant(decline, queue) })
  } else {
    cells.push({
      state,
      event: 'dialog-yes',
      na: queue === 'none' ? 'no ask is queued, so no dialog is raised to answer' : 'the queued ask is round 5: its Yes grants round 5, a different event from the typed grant of 4',
    })
  }
}

const kinds = {
  'stale-read': { na: 'the grant reads the record and the queue inside one call; a grant after the record was replaced is the #87 shape, which no cell here credits' },
  duplicate: ['grant-twice'],
  'second-entry': ['dialog-yes'],
  'timer-overlap': { na: 'a grant is one typed command; the watcher tick only reads the grant afterwards' },
  'retained-flag': ['grant'],
}

describe('T3 grant against a kept decline', () => {
  test('T3 table is complete', () => {
    expect(tableProblems({ states, events, cells, kinds })).toEqual([])
  })

  for (const cell of cells.filter(one => !('na' in one))) {
    test(`T3 ${cell.state} + ${cell.event} -> ${cell.expect}`, async ($, on) => {
      const want = cell.want as Want
      const got = await play(cell.state, cell.event, $, on)
      const where = `${cell.state} + ${cell.event}`
      expect(got.grant, `${where}: stored grant round`).toBe(4)
      expect(got.declined, `${where}: decline left on the record`).toEqual(want.declined)
      expect(got.queued, `${where}: rounds still queued`).toEqual(want.queued)
      expect(got.rows, `${where}: the model hears the allowed round`).toContain('Dave allowed round 4 for #7')
      if (want.kept) {
        expect(got.rows, `${where}: the model hears the kept decline`).toContain(`decline of ${want.kept} stays`)
        expect(got.rows, `${where}: the model is not told to post a review`).not.toContain('post one @coderabbitai review')
        if (cell.event !== 'dialog-yes') expect(got.text, `${where}: Dave's reply names the kept decline`).toContain(`decline of ${want.kept} stays`)
      } else {
        expect(got.rows, `${where}: the model is told to post one review`).toContain('post one @coderabbitai review')
        expect(got.rows, `${where}: no kept decline is named`).not.toContain('stays')
      }
    })
  }
})
