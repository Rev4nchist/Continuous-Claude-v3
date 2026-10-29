import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import {
  LIMITS,
  applyBrief,
  briefSummary,
  deriveChip,
  emptyBrief,
  isAskStale,
  isModSubmission,
  isProven,
  markAsksAnswered,
  mergeParsed,
  parseTurnEnd,
  redact,
  validateBrief,
} from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import type { AgentRun, OsTask } from '../types'

// Ways the brief unit can fail, one test each. Secrets are joined at run time: no secret-shaped literal sits here.
// V1  a valid full input is refused
// V2  a limit is off by one (title 80, goal 240, stopAt 240, ask 8 of 300, plan 30 of 200)
// V3  an unknown key (top level, plan step, ask item) is accepted
// V4  a bad kind or status is accepted
// V5  an empty input, a non-object, a wrong type or a duplicate plan id is accepted
// V6  a secret survives in any string field
// A1  plan merges instead of replacing
// A2  ask does not replace, or [] does not clear
// A3  a field left out of the input is wiped
// A4  a decision replaces the list, or has no author or time
// A5  proof does not join on a task id
// A6  proof does not join on a plan step id
// A7  proof does not join on an exact subject
// A8  an unmatched proof is accepted, lists no ids, or leaves a half-applied brief
// A9  a secret survives in proof.artifact or decision.text
// A10 the previous brief is mutated
// A11 a proof for todo-N lands on a different task after a TodoWrite reorder
// A13..A16 the no-items error text, two same-subject tasks, a task and a plan step sharing an id, a secret in a subject
// K2b stale counts from the last session activity; P9..P12 the parser cap, the tail read and a secret across the old cut
// E6b..E6c a parsed turn end refills a cleared ask; toolRunning is not exercised; E8b..E8c a subagent writes the brief; an active session's ask goes stale
// C1..C9 the chip is wrong for: idle, unproven, proven, ask+tool, ask only, answered, stale, blocked, working
// K1  an ask answered by Dave still counts, or stale is off by one
// P1..P7 the turn-end parser misreads the restate line or the Next steps block
// M1..M3 a parsed value overrides a brief_set value, or does not fill an empty one
// E1..E8 the wiring: registration, snapshot, stray key, prompt.submit, turn end, secrets, clear, off switch
// C10 E11 E12 E13 the chip ignores a running subagent run; a subagent turn.start overwrites the main turn, or clears a refusal, or is not passed on

const NOW = 1_000_000
const secrets = {
  anthropic: 'sk-' + 'ant-' + 'a'.repeat(40),
  bearer: 'Bear' + 'er ' + 't'.repeat(30),
  dbUrl: 'postgres' + '://' + 'admin' + ':' + 'pw' + 'Hunter99' + '@db.internal:5432/app',
}
const SECRET_BODIES = ['aaaaaaaa', 'tttttt', 'Hunter99']
const leaks = (text: string): boolean => SECRET_BODIES.some(body => text.includes(body))

const task = (id: string, subject: string, status: OsTask['status'] = 'pending'): OsTask => ({ id, subject, status })
const ok = (r: ReturnType<typeof applyBrief>): Brief => {
  if ('error' in r) throw new Error(r.error)
  return r.brief
}
const apply = (prev: Brief | null, input: unknown, tasks: OsTask[] = [], now = NOW) => ok(applyBrief(prev, input, tasks, now))
const fail = (r: ReturnType<typeof applyBrief>): string => ('error' in r ? r.error : 'NO ERROR')
const step = (id: string, status: 'todo' | 'doing' | 'done' | 'blocked' = 'todo') => ({ id, text: `step ${id}`, status })

describe('validateBrief', () => {
  test('V1 a full valid input passes', () => {
    const r = validateBrief({
      title: 't',
      goal: 'g',
      stopAt: 's',
      plan: [step('a')],
      ask: [{ kind: 'question', text: 'q?', recommend: 'yes' }],
      decision: { text: 'd', by: 'Dave' },
      proof: { taskId: 'a', artifact: 'out' },
    })
    expect('input' in r).toBe(true)
  })

  test('V2 every limit holds at the limit and fails one past it, naming the field', () => {
    const long = (n: number) => 'x'.repeat(n)
    const cases: [string, (n: number) => unknown, number][] = [
      ['title', n => ({ title: long(n) }), LIMITS.title],
      ['goal', n => ({ goal: long(n) }), LIMITS.goal],
      ['stopAt', n => ({ stopAt: long(n) }), LIMITS.stopAt],
      ['ask', n => ({ ask: Array.from({ length: n }, () => ({ kind: 'question', text: 'q' })) }), LIMITS.askItems],
      ['ask text', n => ({ ask: [{ kind: 'question', text: long(n) }] }), LIMITS.askText],
      ['plan', n => ({ plan: Array.from({ length: n }, (_, i) => step(`s${i}`)) }), LIMITS.planSteps],
      ['plan text', n => ({ plan: [{ id: 'a', text: long(n), status: 'todo' }] }), LIMITS.planText],
    ]
    expect([LIMITS.title, LIMITS.goal, LIMITS.stopAt, LIMITS.askItems, LIMITS.askText, LIMITS.planSteps, LIMITS.planText]).toEqual([80, 240, 240, 8, 300, 30, 200])
    for (const [name, build, limit] of cases) {
      expect([name, 'input' in validateBrief(build(limit))]).toEqual([name, true])
      const over = validateBrief(build(limit + 1))
      expect([name, 'error' in over]).toEqual([name, true])
      expect('error' in over && over.error).toContain(String(limit))
    }
  })

  test('V3 an unknown key is refused at the top level, in a plan step and in an ask item', () => {
    const top = validateBrief({ goal: 'g', gaol: 'typo' })
    expect('error' in top && top.error).toContain('gaol')
    const inPlan = validateBrief({ plan: [{ id: 'a', text: 't', status: 'todo', owner: 'me' }] })
    expect('error' in inPlan && inPlan.error).toContain('owner')
    const inAsk = validateBrief({ ask: [{ kind: 'question', text: 't', urgent: true }] })
    expect('error' in inAsk && inAsk.error).toContain('urgent')
    const inProof = validateBrief({ proof: { taskId: 'a', artifact: 'x', extra: 1 } })
    expect('error' in inProof && inProof.error).toContain('extra')
  })

  test('V4 a kind or status outside the sets is refused', () => {
    for (const kind of ['block', 'decision', 'approval', 'question']) expect('input' in validateBrief({ ask: [{ kind, text: 't' }] })).toBe(true)
    const badKind = validateBrief({ ask: [{ kind: 'nag', text: 't' }] })
    expect('error' in badKind && badKind.error).toContain('kind')
    for (const status of ['todo', 'doing', 'done', 'blocked']) expect('input' in validateBrief({ plan: [{ id: 'a', text: 't', status }] })).toBe(true)
    const badStatus = validateBrief({ plan: [{ id: 'a', text: 't', status: 'pending' }] })
    expect('error' in badStatus && badStatus.error).toContain('status')
  })

  test('V5 an empty input, a non-object, a wrong type and a duplicate plan id are refused', () => {
    for (const bad of [{}, null, 'goal', 5, [], { goal: 5 }, { plan: 'x' }, { ask: {} }, { decision: { text: 'd' } }, { proof: { taskId: 'a' } }, { plan: [step('a'), step('a')] }]) {
      expect([JSON.stringify(bad), 'error' in validateBrief(bad)]).toEqual([JSON.stringify(bad), true])
    }
  })

  test('V6 a secret is redacted in every string field', () => {
    const s = secrets.anthropic
    const r = validateBrief({
      title: s,
      goal: s,
      stopAt: s,
      plan: [{ id: 'a', text: s, status: 'todo' }],
      ask: [{ kind: 'question', text: s, recommend: s }],
      decision: { text: s, by: s },
      proof: { taskId: 'a', artifact: s },
    })
    expect(leaks(JSON.stringify(r))).toBe(false)
    expect(JSON.stringify(r)).toContain('[REDACTED:provider_token]')
  })

  test('V6 redact is the shared port: a Bearer token and a database URL password do not survive', () => {
    expect(leaks(redact(`header ${secrets.bearer} and ${secrets.dbUrl}`).text)).toBe(false)
  })
})

describe('applyBrief', () => {
  test('A1 plan replaces the list', () => {
    const first = apply(null, { plan: [step('a'), step('b')] })
    const second = apply(first, { plan: [step('c')] })
    expect(second.plan.map(one => one.id)).toEqual(['c'])
  })

  test('A2 ask replaces the list and [] clears it', () => {
    const first = apply(null, { ask: [{ kind: 'question', text: 'one?' }, { kind: 'approval', text: 'two?' }] })
    const second = apply(first, { ask: [{ kind: 'decision', text: 'three?' }] })
    expect(second.ask.map(one => one.text)).toEqual(['three?'])
    expect(apply(second, { ask: [] }).ask).toEqual([])
  })

  test('A3 a field left out keeps its value', () => {
    const first = apply(null, { title: 'T', goal: 'G', stopAt: 'S', plan: [step('a')], ask: [{ kind: 'question', text: 'q' }] })
    const second = apply(first, { goal: 'G2' })
    expect([second.title, second.goal, second.stopAt, second.plan.length, second.ask.length]).toEqual(['T', 'G2', 'S', 1, 1])
  })

  test('A4 a decision appends with its author and time', () => {
    const first = apply(null, { decision: { text: 'use X', by: 'Dave' } }, [], 5)
    const second = apply(first, { decision: { text: 'then Y', by: 'agent' } }, [], 9)
    expect(second.decisions).toEqual([
      { text: 'use X', by: 'Dave', at: 5 },
      { text: 'then Y', by: 'agent', at: 9 },
    ])
  })

  test('A5 proof joins on a task id', () => {
    const tasks = [task('7', 'write it', 'completed')]
    const brief = apply(null, { proof: { taskId: '7', artifact: 'green run' } }, tasks)
    expect(isProven(brief, tasks[0]!)).toBe(true)
    expect(isProven(brief, task('8', 'other'))).toBe(false)
  })

  test('A6 proof joins on a plan step id, from the same call or an earlier one', () => {
    const same = apply(null, { plan: [step('p1', 'done')], proof: { taskId: 'p1', artifact: 'a' } })
    expect(same.proofs.map(one => one.id)).toEqual(['p1'])
    const later = apply(apply(null, { plan: [step('p2', 'done')] }), { proof: { taskId: 'p2', artifact: 'a' } })
    expect(later.proofs.map(one => one.id)).toEqual(['p2'])
  })

  test('A7 proof joins on the exact subject when the model has no id', () => {
    const tasks = [task('todo-1', 'ship the thing', 'completed')]
    const brief = apply(null, { proof: { taskId: 'ship the thing', artifact: 'a' } }, tasks)
    expect(brief.proofs[0]?.id).toBe('todo-1')
    expect(isProven(brief, tasks[0]!)).toBe(true)
    const near = applyBrief(null, { proof: { taskId: 'Ship the thing', artifact: 'a' } }, tasks, NOW)
    expect(fail(near)).toContain('todo-1')
  })

  test('A8 no match is an error that lists every valid id, says nothing was saved, and leaves the brief as it was', () => {
    const tasks = [task('1', 'a'), task('2', 'b')]
    const prev = apply(null, { plan: [step('p1')], goal: 'keep' }, tasks)
    const before = JSON.stringify(prev)
    const r = applyBrief(prev, { goal: 'changed', proof: { taskId: 'nope', artifact: 'x' } }, tasks, NOW)
    const error = fail(r)
    for (const id of ['1', '2', 'p1']) expect(error).toContain(id)
    // All or nothing: the goal, plan, ask and decision of the same call are dropped too. The text must say so and say what to resend.
    expect(error).toMatch(/nothing was saved/i)
    expect(error).toMatch(/resend/i)
    expect(error).toMatch(/without .?proof/i)
    expect(error).not.toContain('stays unproven')
    expect(JSON.stringify(prev)).toBe(before)
    expect('brief' in r).toBe(false)
  })

  test('A13 with no task and no plan step the error says so and still says nothing was saved', () => {
    const error = fail(applyBrief(null, { goal: 'g', proof: { taskId: 'x', artifact: 'a' } }, [], NOW))
    expect(error).toContain('There is no task and no plan step yet')
    expect(error).toMatch(/nothing was saved/i)
  })

  test('A14 two tasks with one subject: a proof for one does not prove the other', () => {
    const tasks = [task('todo-1', 'Run tests', 'completed'), task('todo-3', 'Run tests', 'completed')]
    const brief = apply(null, { proof: { taskId: 'todo-1', artifact: 'green' } }, tasks)
    expect(isProven(brief, tasks[0]!)).toBe(true)
    expect(isProven(brief, tasks[1]!)).toBe(false)
  })

  test('A15 a task and a plan step with the same id and text are two items; a proof lands on the task only', () => {
    const tasks = [task('x', 'same words', 'completed')]
    const brief = apply(null, { plan: [{ id: 'x', text: 'same words', status: 'done' }], proof: { taskId: 'x', artifact: 'a' } }, tasks)
    expect(brief.proofs).toHaveLength(1)
    expect(brief.proofs[0]?.kind).toBe('task')
    // PRD 5.1: the task list is the plan source while it holds a task, so the unproven plan step no longer keeps the chip off done.
    // (Before the 5.1 fix this expected 'idle', because the chip weighed the plan step too.)
    expect(deriveChip({ brief, tasks, toolRunning: false, turnActive: false, blocked: false, now: NOW })).toBe('done')
    // With no task the same plan step is the source, and its proof is missing.
    expect(deriveChip({ brief, tasks: [], toolRunning: false, turnActive: false, blocked: false, now: NOW })).toBe('idle')
  })

  test('A16 a secret in a task subject is not stored in the proof, and the proof still joins on it', () => {
    const tasks = [task('1', `deploy with ${secrets.anthropic}`, 'completed')]
    const byId = apply(null, { proof: { taskId: '1', artifact: 'a' } }, tasks)
    expect(leaks(JSON.stringify(byId))).toBe(false)
    expect(isProven(byId, tasks[0]!)).toBe(true)
    const bySubject = apply(null, { proof: { taskId: tasks[0]!.subject, artifact: 'a' } }, tasks)
    expect(leaks(JSON.stringify(bySubject))).toBe(false)
    expect(isProven(bySubject, tasks[0]!)).toBe(true)
    const secretId = [task(secrets.bearer, 'ship it', 'completed')]
    const byOddId = apply(null, { proof: { taskId: 'ship it', artifact: 'a' } }, secretId)
    expect(leaks(JSON.stringify(byOddId))).toBe(false)
    expect(isProven(byOddId, secretId[0]!)).toBe(true)
  })

  test('A9 a secret in proof.artifact or decision.text is not stored', () => {
    const tasks = [task('1', 'a')]
    const brief = apply(null, { proof: { taskId: '1', artifact: `ran with ${secrets.anthropic}` }, decision: { text: `use ${secrets.bearer} at ${secrets.dbUrl}`, by: 'Dave' } }, tasks)
    expect(leaks(JSON.stringify(brief))).toBe(false)
  })

  test('A10 the previous brief is not mutated', () => {
    const prev = apply(null, { plan: [step('a')], ask: [{ kind: 'question', text: 'q' }] })
    const before = JSON.stringify(prev)
    apply(prev, { plan: [], ask: [], goal: 'x', decision: { text: 'd', by: 'b' } })
    expect(JSON.stringify(prev)).toBe(before)
  })

  test('A11 a proof for todo-2 does not follow the id to a different task after a reorder', () => {
    const before = [task('todo-1', 'first', 'completed'), task('todo-2', 'second', 'completed')]
    const brief = apply(null, { proof: { taskId: 'todo-2', artifact: 'a' } }, before)
    const after = [task('todo-1', 'second', 'completed'), task('todo-2', 'third', 'completed')]
    expect(isProven(brief, after[1]!)).toBe(false)
    expect(isProven(brief, before[1]!)).toBe(true)
  })

  test('A12 the summary names the goal, the open asks and the proof count', () => {
    const tasks = [task('1', 'a', 'completed'), task('2', 'b')]
    const brief = apply(null, { goal: 'ship P1a', ask: [{ kind: 'question', text: 'q' }], proof: { taskId: '1', artifact: 'a' } }, tasks)
    const text = briefSummary(brief, tasks)
    expect(text).toContain('ship P1a')
    expect(text).toContain('1 open ask')
    expect(text).toContain('1 of 2 proven')
  })

  test('A12 the proven count weighs the tasks only when a task exists (PRD 5.1)', () => {
    const tasks = [task('1', 'a', 'completed'), task('2', 'b')]
    const brief = apply(null, { plan: [step('p1', 'done'), step('p2', 'done'), step('p3', 'done')], proof: { taskId: '1', artifact: 'a' } }, tasks)
    expect(briefSummary(brief, tasks)).toContain('1 of 2 proven')
    expect(briefSummary(brief, [])).toContain('0 of 3 proven')
  })
})

describe('deriveChip', () => {
  const state = (over: Partial<Parameters<typeof deriveChip>[0]> = {}) => ({
    brief: null as Brief | null,
    tasks: [] as OsTask[],
    toolRunning: false,
    turnActive: false,
    blocked: false,
    now: NOW,
    ...over,
  })

  test('C1 nothing at all is idle, never done', () => {
    expect(deriveChip(state())).toBe('idle')
    expect(deriveChip(state({ brief: emptyBrief(NOW) }))).toBe('idle')
  })

  test('C2 every task done but one unproven stays off done', () => {
    const tasks = [task('1', 'a', 'completed'), task('2', 'b', 'completed')]
    const brief = apply(null, { proof: { taskId: '1', artifact: 'a' } }, tasks)
    expect(deriveChip(state({ brief, tasks }))).toBe('idle')
  })

  test('C3 every task done and proven is done; with no task, every plan step done and proven is done', () => {
    const tasks = [task('1', 'a', 'completed')]
    const proven = apply(null, { proof: { taskId: '1', artifact: 'a' } }, tasks)
    expect(deriveChip(state({ brief: proven, tasks }))).toBe('done')
    const plan = apply(null, { plan: [step('p1', 'done')] })
    expect(deriveChip(state({ brief: plan }))).toBe('idle')
    const planProven = apply(plan, { proof: { taskId: 'p1', artifact: 'b' } })
    expect(deriveChip(state({ brief: planProven }))).toBe('done')
  })

  test('C11 PRD 5.1: with a task the plan is ignored; the chip weighs the tasks only', () => {
    const open = apply(null, { plan: [step('p1', 'done'), step('p2', 'doing')] })
    // Tasks all done and proven, plan unfinished: done.
    const done = [task('1', 'a', 'completed')]
    const brief = apply(open, { proof: { taskId: '1', artifact: 'a' } }, done)
    expect(deriveChip(state({ brief, tasks: done }))).toBe('done')
    // A pending task keeps the chip off done even when the whole plan is done and proven.
    const finished = apply(null, { plan: [step('p1', 'done')] })
    const planProven = apply(finished, { proof: { taskId: 'p1', artifact: 'b' } })
    expect(deriveChip(state({ brief: planProven, tasks: [task('1', 'a', 'pending')] }))).toBe('idle')
    // A blocked plan step does not block the chip while a task exists; it does with no task.
    const stuck = apply(null, { plan: [step('p1', 'blocked')] })
    expect(deriveChip(state({ brief: stuck, tasks: [task('1', 'a', 'pending')] }))).toBe('idle')
    expect(deriveChip(state({ brief: stuck }))).toBe('blocked')
  })

  test('C3 a plan step that is not done keeps the chip off done', () => {
    const brief = apply(null, { plan: [step('p1', 'done'), step('p2', 'doing')], proof: { taskId: 'p1', artifact: 'a' } })
    expect(deriveChip(state({ brief }))).toBe('idle')
  })

  test('C4 an open ask with a tool running is working', () => {
    const brief = apply(null, { ask: [{ kind: 'question', text: 'q' }] })
    expect(deriveChip(state({ brief, toolRunning: true }))).toBe('working')
  })

  test('C5 an open ask with no tool running is waiting-on-dave', () => {
    const brief = apply(null, { ask: [{ kind: 'approval', text: 'q' }] })
    expect(deriveChip(state({ brief }))).toBe('waiting-on-dave')
  })

  test('C6 an answered ask does not count', () => {
    const brief = markAsksAnswered(apply(null, { ask: [{ kind: 'question', text: 'q' }] }))
    expect(deriveChip(state({ brief }))).toBe('idle')
    expect(deriveChip(state({ brief, turnActive: true }))).toBe('working')
  })

  test('C7 a stale ask does not count', () => {
    const brief = apply(null, { ask: [{ kind: 'question', text: 'q' }] })
    expect(deriveChip(state({ brief, now: NOW + 24 * 3600_000 }))).toBe('idle')
  })

  test('C8 a refused tool or a blocked plan step is blocked, ahead of an open ask', () => {
    const asked = apply(null, { ask: [{ kind: 'question', text: 'q' }] })
    expect(deriveChip(state({ brief: asked, blocked: true }))).toBe('blocked')
    const stuck = apply(null, { plan: [step('p1', 'blocked')] })
    expect(deriveChip(state({ brief: stuck }))).toBe('blocked')
  })

  test('C10 two done tasks with one subject and a proof for one: the chip stays off done', () => {
    const tasks = [task('todo-1', 'Run tests', 'completed'), task('todo-3', 'Run tests', 'completed')]
    const brief = apply(null, { proof: { taskId: 'todo-1', artifact: 'green' } }, tasks)
    expect(deriveChip(state({ brief, tasks }))).toBe('idle')
    const both = apply(brief, { proof: { taskId: 'todo-3', artifact: 'green' } }, tasks)
    expect(deriveChip(state({ brief: both, tasks }))).toBe('done')
  })

  test('C9 an active turn with no ask is working; done work in an active turn is working', () => {
    expect(deriveChip(state({ turnActive: true }))).toBe('working')
    const tasks = [task('1', 'a', 'completed')]
    const brief = apply(null, { proof: { taskId: '1', artifact: 'a' } }, tasks)
    expect(deriveChip(state({ brief, tasks, turnActive: true }))).toBe('working')
  })

  // ChipState has no agents field yet. The field is named `agentRuns` (the Agent Ledger's runs); the cast goes when it exists.
  const run = (status: AgentRun['status']): AgentRun => ({
    id: 'a1',
    type: 'scout',
    description: 'map the hooks',
    model: 'claude-sonnet-5-5',
    effort: 'high',
    spec: {},
    startedAt: NOW - 5_000,
    endedAt: status === 'running' ? null : NOW - 1_000,
    status,
    tokens: 0,
    costUsd: 0,
    drift: null,
  })
  const withRuns = (runs: AgentRun[], over: Partial<Parameters<typeof deriveChip>[0]> = {}) => deriveChip({ ...state(over), agentRuns: runs } as never)

  test('C10 a running subagent run is working with no tool and no turn; a settled run is not; work that looks done is still working while one runs', () => {
    expect(withRuns([run('running')])).toBe('working')
    expect(withRuns([run('done'), run('failed')])).toBe('idle')
    const tasks = [task('1', 'a', 'completed')]
    const brief = apply(null, { proof: { taskId: '1', artifact: 'a' } }, tasks)
    expect(withRuns([], { brief, tasks })).toBe('done')
    expect(withRuns([run('running')], { brief, tasks })).toBe('working')
  })
})

describe('ask lifecycle', () => {
  test('K1 Dave answers: open asks flip to answered, the input is not mutated, the next brief_set replaces them', () => {
    const prev = apply(null, { ask: [{ kind: 'question', text: 'q' }, { kind: 'block', text: 'b' }] })
    const after = markAsksAnswered(prev)
    expect(after.ask.every(one => one.answered === true)).toBe(true)
    expect(prev.ask.some(one => one.answered === true)).toBe(false)
    expect(apply(after, { ask: [{ kind: 'question', text: 'fresh' }] }).ask.map(one => one.answered)).toEqual([undefined])
  })

  test('K2 an ask is stale at 24 hours, not before, and only while open', () => {
    const brief = apply(null, { ask: [{ kind: 'question', text: 'q' }] }, [], NOW)
    expect(isAskStale(brief, NOW + 24 * 3600_000 - 1)).toBe(false)
    expect(isAskStale(brief, NOW + 24 * 3600_000)).toBe(true)
    expect(isAskStale(markAsksAnswered(brief), NOW + 48 * 3600_000)).toBe(false)
    expect(isAskStale(emptyBrief(NOW), NOW + 48 * 3600_000)).toBe(false)
  })

  test('K2b an ask counts 24 hours from the last session activity, not from the last brief change', () => {
    const brief = apply(null, { ask: [{ kind: 'question', text: 'q' }] }, [], NOW)
    const HOUR = 3600_000
    // Active 23 hours in: the ask is fresh at 24 and at 46 hours, stale at 47.
    expect(isAskStale(brief, NOW + 24 * HOUR, NOW + 23 * HOUR)).toBe(false)
    expect(isAskStale(brief, NOW + 47 * HOUR - 1, NOW + 23 * HOUR)).toBe(false)
    expect(isAskStale(brief, NOW + 47 * HOUR, NOW + 23 * HOUR)).toBe(true)
    // Activity older than the brief change does not make it stale sooner.
    expect(isAskStale(brief, NOW + 24 * HOUR - 1, NOW - 5 * HOUR)).toBe(false)
    expect(isAskStale(brief, NOW + 24 * HOUR, null)).toBe(true)
  })

  test('K3 the mod\'s own PR watcher line is not Dave', () => {
    expect(isModSubmission('PR watcher: #12 head abc1234 is READY')).toBe(true)
    expect(isModSubmission('yes, merge it')).toBe(false)
  })

  test('K3b the /land fallback text (pr-loop, submitted by the mod) is not Dave either', () => {
    // hooks/pr-loop/index.ts builds this text: `Dave pressed "Land" on <via>. ...`
    expect(isModSubmission('Dave pressed "Land" on /land 191. That press is his merge yes for PR #191 only.')).toBe(true)
    // A real reply that merely mentions the word is still Dave.
    expect(isModSubmission('I pressed Land earlier, now fix the test')).toBe(false)
  })
})

const ANSWER = [
  'Restate: I will add brief.ts to the ccv3-mods plugin and stop at the validator run.',
  '',
  'Work happened here.',
  '',
  '## Next steps',
  '1. Approve the merge of PR 12? Recommend: yes.',
  '2. Paste the T2 response here',
  '```',
  '1. not an item',
  '```',
  '',
  '## Notes',
  '1. not an ask either',
].join('\n')

describe('parseTurnEnd', () => {
  test('P1 the Next steps block gives asks marked parsed, and stops at the next heading and at fenced code', () => {
    const parsed = parseTurnEnd(ANSWER)
    expect(parsed.ask?.map(one => one.text)).toEqual(['Approve the merge of PR 12?', 'Paste the T2 response here'])
    expect(parsed.ask?.every(one => one.source === 'parsed')).toBe(true)
    expect(parsed.ask?.[0]).toMatchObject({ kind: 'approval', recommend: 'yes' })
  })

  test('P2 "None — waiting on X" is an empty ask list, not no list', () => {
    expect(parseTurnEnd('## Next steps\nNone — waiting on the CI run.').ask).toEqual([])
  })

  test('P3 no Next steps block gives no ask value', () => {
    expect(parseTurnEnd('Just prose.\n1. a list that is not Next steps').ask).toBeUndefined()
  })

  test('P4 the restate sentence gives goal and stop-at, both marked parsed', () => {
    const parsed = parseTurnEnd(ANSWER)
    expect(parsed.goal).toEqual({ text: 'add brief.ts to the ccv3-mods plugin', source: 'parsed' })
    expect(parsed.stopAt).toEqual({ text: 'the validator run', source: 'parsed' })
  })

  test('P5 labelled Goal and Stop at lines work', () => {
    const parsed = parseTurnEnd('**Goal:** ship the mod\n- Stop at: before commit')
    expect(parsed.goal?.text).toBe('ship the mod')
    expect(parsed.stopAt?.text).toBe('before commit')
  })

  test('P6 no restate line gives no goal and no stop-at, and plain "I will" prose is not a goal', () => {
    const parsed = parseTurnEnd('I will check the file now.\n\nDone.')
    expect(parsed.goal).toBeUndefined()
    expect(parsed.stopAt).toBeUndefined()
  })

  test('P7 a secret in the output is redacted in every parsed value', () => {
    const parsed = parseTurnEnd(`Goal: rotate ${secrets.anthropic}\n## Next steps\n1. Use ${secrets.bearer} against ${secrets.dbUrl}`)
    expect(leaks(JSON.stringify(parsed))).toBe(false)
  })

  test('P8 more than 8 asks are cut to 8', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `${i + 1}. item ${i}`).join('\n')
    expect(parseTurnEnd(`## Next steps\n${lines}`).ask).toHaveLength(8)
  })

  const timed = (answer: string): number => {
    const started = Date.now()
    parseTurnEnd(answer)
    return Date.now() - started
  }

  test('P9 a 32,000 character line of spaces parses in under 50 ms, as a bare line and as a Next steps item', () => {
    const spaces = ' '.repeat(32_000)
    const times = [timed(`${spaces}\nDone.`), timed(`## Next steps\n1. first${spaces}end`), timed(`Goal: g${spaces}end`)]
    for (const ms of times) expect(ms).toBeLessThan(50)
  })

  test('P10 a huge line is skipped and the restate line in the tail is still read', () => {
    const answer = `${' '.repeat(32_000)}x\nRestate: I will add brief.ts and stop at the validator run.\n## Next steps\n1. Approve the merge? Recommend: yes.`
    const parsed = parseTurnEnd(answer)
    expect(parsed.goal?.text).toBe('add brief.ts')
    expect(parsed.stopAt?.text).toBe('the validator run')
    expect(parsed.ask?.map(one => one.text)).toEqual(['Approve the merge?'])
  })

  test('P11 only the last 16 KB of the answer is read', () => {
    const early = 'Goal: from the far past\n'
    const filler = 'filler line of prose here\n'.repeat(1_000)
    expect(parseTurnEnd(`${early}${filler}`).goal).toBeUndefined()
    expect(parseTurnEnd(`${filler}${early}`).goal?.text).toBe('from the far past')
  })

  test('P12 a secret that crosses character 2000 of a line leaves no readable fragment', () => {
    // A long Bearer token shrinks to a marker; the key behind it starts 15 characters before the old cut at 2000.
    const lead = 'Bear' + 'er ' + 't'.repeat(1_977) + ' '
    const key = secrets.anthropic
    const answer = `Goal: ${lead}${key}\n## Next steps\n1. ${lead}${key}`
    expect(leaks(JSON.stringify(parseTurnEnd(answer)))).toBe(false)
    // The same shape inside the bound: the whole line is redacted before any clip.
    const inside = parseTurnEnd(`Goal: ${'Bear' + 'er ' + 't'.repeat(1_700)} ${key}`)
    expect(leaks(JSON.stringify(inside))).toBe(false)
    expect(inside.goal?.text).toContain('[REDACTED:')
  })
})

describe('mergeParsed', () => {
  test('M1 a parsed goal and stop-at fill an empty brief and replace an older parsed value', () => {
    const first = mergeParsed(null, parseTurnEnd('Goal: one\nStop at: two'), NOW)
    expect([first.goal, first.stopAt, first.sources.goal]).toEqual(['one', 'two', 'parsed'])
    const second = mergeParsed(first, parseTurnEnd('Goal: three'), NOW)
    expect([second.goal, second.stopAt]).toEqual(['three', 'two'])
  })

  test('M2 a brief_set goal, stop-at and ask survive a parsed value', () => {
    const set = apply(null, { goal: 'from the tool', stopAt: 'tool stop', ask: [{ kind: 'question', text: 'from the tool?' }] })
    const merged = mergeParsed(set, parseTurnEnd('Goal: parsed goal\nStop at: parsed stop\n## Next steps\n1. parsed ask'), NOW)
    expect([merged.goal, merged.stopAt, merged.ask.map(one => one.text)]).toEqual(['from the tool', 'tool stop', ['from the tool?']])
    expect(merged.sources.goal).toBe('brief_set')
  })

  test('M3 parsed asks fill an empty list and a later brief_set replaces them', () => {
    const merged = mergeParsed(null, parseTurnEnd('## Next steps\n1. Pick one'), NOW)
    expect(merged.ask.map(one => [one.text, one.source])).toEqual([['Pick one', 'parsed']])
    const replaced = apply(merged, { ask: [{ kind: 'question', text: 'real' }] })
    expect(replaced.ask.map(one => [one.text, one.source])).toEqual([['real', 'brief_set']])
    expect(mergeParsed(replaced, parseTurnEnd('## Next steps\n1. late parse'), NOW).ask.map(one => one.text)).toEqual(['real'])
  })

  test('M4 a parse with nothing in it changes nothing', () => {
    const set = apply(null, { goal: 'g' })
    expect(mergeParsed(set, parseTurnEnd('nothing here'), NOW)).toEqual(set)
  })
})

// --- The wiring: the real mod, with the engine below it mocked. ---

const BRIEF_TOOL = 'mcp__ccv3-mods__brief_set'

type Seen = { writes: { path: string; text: string }[]; tools: Record<string, string>; schemas: Record<string, unknown>; clock: ReturnType<typeof mock.clock>; inRead?: () => Promise<void>; agents: unknown[] }

const world = (on: On, env: Record<string, string> = {}) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/home', ...env })
  const seen: Seen = { writes: [], tools: {}, schemas: {}, clock, agents: [] }
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', (_$, e) => {
    seen.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => ({ value: seen.agents as never }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => {
    const named = e as unknown as { description?: string; inputSchema?: unknown }
    seen.tools[e.name] = String(named.description)
    seen.schemas[e.name] = named.inputSchema
    return { value: { tool: `mcp__ccv3-mods__${e.name}` } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => ({ result: { task: { id: '1', subject: e.subject } } }))
  on('tool.call', { tool: 'Read' }, async () => {
    await seen.inRead?.()
    return { result: { type: 'text' } } as never
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    if (String((e as unknown as { command?: string }).command).includes('refuse')) return { deny: 'refused' }
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  return seen
}

const startMod = ($: Engine, isInteractive = false) => $.session.start({ cwd: 'C:/r', surface: isInteractive ? 'terminal' : null, isInteractive })

const snapshots = (seen: Seen) => seen.writes.filter(write => /[\\/]test-session\.json$/.test(write.path))
const lastSnapshot = (seen: Seen): Record<string, any> => JSON.parse(snapshots(seen).at(-1)?.text ?? '{}')
const said = (ran: { result?: unknown }): string => {
  const result = ran.result
  return Array.isArray(result) ? result.map(block => String((block as { text?: unknown }).text)).join('\n') : String(result)
}
const turnEnd = ($: Engine, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never)

describe('brief_set in the mod', () => {
  test('E1 headless and interactive sessions both register brief_set, and the description says when to call it and that [] clears', async ($, on) => {
    const seen = world(on)
    await startMod($, false)
    expect(Object.keys(seen.tools)).toContain('brief_set')
    const description = seen.tools.brief_set ?? ''
    for (const word of ['goal', 'stop-at', 'title', 'plan', '[]']) expect(description).toContain(word)
    expect(JSON.stringify(seen.schemas.brief_set)).toContain('"type":"object"')
  })

  test('E1 an interactive start registers it too', async ($, on) => {
    const seen = world(on)
    await startMod($, true)
    expect(Object.keys(seen.tools)).toContain('brief_set')
  })

  test('E2 a headless brief_set with only a goal writes a snapshot holding brief and chip', async ($, on) => {
    const seen = world(on)
    await startMod($, false)
    const ran = await $.tool.call({ tool: BRIEF_TOOL, goal: 'prove P1a' })
    expect(said(ran)).toContain('prove P1a')
    const snapshot = lastSnapshot(seen)
    expect(snapshot.brief.goal).toBe('prove P1a')
    expect(snapshot.chip).toBe('idle')
  })

  test('E3 a stray key inside a plan step answers with brief_set failed, not a throw or a deny, and writes nothing', async ($, on) => {
    const seen = world(on)
    await startMod($, false)
    const ran = await $.tool.call({ tool: BRIEF_TOOL, plan: [{ id: 'a', text: 't', status: 'todo', owner: 'x' }] })
    expect(ran.deny).toBeUndefined()
    expect(said(ran)).toMatch(/^brief_set failed:/)
    expect(said(ran)).toContain('owner')
    expect(snapshots(seen)).toEqual([])
  })

  test('E3 a proof with no match answers with the valid ids', async ($, on) => {
    world(on)
    await startMod($, false)
    await $.tool.call({ tool: 'TaskCreate', subject: 'a real task', description: 'd' })
    const ran = await $.tool.call({ tool: BRIEF_TOOL, proof: { taskId: 'zzz', artifact: 'x' } })
    expect(said(ran)).toMatch(/^brief_set failed:/)
    expect(said(ran)).toContain('1')
  })

  test('E4 a proof on a captured task id lands in the snapshot and moves the count', async ($, on) => {
    const seen = world(on)
    await startMod($, false)
    await $.tool.call({ tool: 'TaskCreate', subject: 'a real task', description: 'd' })
    await $.tool.call({ tool: BRIEF_TOOL, proof: { taskId: '1', artifact: 'ran it' } })
    expect(lastSnapshot(seen).brief.proofs.map((one: { id: string }) => one.id)).toEqual(['1'])
  })

  test('E5 Dave\'s prompt flips open asks to answered; the PR watcher line does not', async ($, on) => {
    const seen = world(on)
    await startMod($, true)
    await $.tool.call({ tool: BRIEF_TOOL, ask: [{ kind: 'question', text: 'which one?' }] })
    expect(lastSnapshot(seen).chip).toBe('waiting-on-dave')
    await $.prompt.submit({ text: 'PR watcher: #12 head abc1234 is READY', wait: false, origin: { kind: 'composer' } })
    expect(lastSnapshot(seen).brief.ask[0].answered).toBeUndefined()
    await $.prompt.submit({ text: 'the second one', wait: false, origin: { kind: 'composer' } })
    const after = lastSnapshot(seen)
    expect(after.brief.ask[0].answered).toBe(true)
    expect(after.chip).toBe('working')
  })

  test('E6 a turn end parses the answer, keeps a brief_set goal, and fills the rest', async ($, on) => {
    const seen = world(on)
    await startMod($, true)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'from the tool' })
    await turnEnd($, 'Stop at: before commit\nGoal: parsed goal\n## Next steps\n1. Paste the response')
    const brief = lastSnapshot(seen).brief
    expect(brief.goal).toBe('from the tool')
    expect(brief.stopAt).toBe('before commit')
    expect(brief.ask[0]).toMatchObject({ text: 'Paste the response', source: 'parsed' })
    expect(lastSnapshot(seen).chip).toBe('waiting-on-dave')
  })

  test('E6b a parsed turn end does not refill an ask list that brief_set cleared with []', async ($, on) => {
    const seen = world(on)
    await startMod($, true)
    await $.tool.call({ tool: BRIEF_TOOL, ask: [{ kind: 'question', text: 'which one?' }] })
    await $.tool.call({ tool: BRIEF_TOOL, ask: [] })
    await turnEnd($, '## Next steps\n1. Paste the response\n2. Approve the merge?')
    const after = lastSnapshot(seen)
    expect(after.brief.ask).toEqual([])
    expect(after.chip).not.toBe('waiting-on-dave')
  })

  test('E6c an open ask with another tool still running is working; with none running it is waiting-on-dave', async ($, on) => {
    const seen = world(on)
    await startMod($, true)
    // A Read that is still running when the model calls brief_set: the brief_set step does not count, the Read does.
    seen.inRead = async () => {
      await $.tool.call({ tool: BRIEF_TOOL, ask: [{ kind: 'question', text: 'which one?' }] })
    }
    await $.tool.call({ tool: 'Read', file_path: 'C:/r/a.md' })
    seen.inRead = undefined
    const during = snapshots(seen).find(write => JSON.parse(write.text).brief?.ask?.length === 1)
    expect(JSON.parse(during?.text ?? '{}').chip).toBe('working')
    await $.tool.call({ tool: BRIEF_TOOL, ask: [{ kind: 'question', text: 'which one?' }] })
    expect(lastSnapshot(seen).chip).toBe('waiting-on-dave')
  })

  test('E7 no secret reaches the state file through any field', async ($, on) => {
    const seen = world(on)
    await startMod($, true)
    await $.tool.call({ tool: 'TaskCreate', subject: 'a real task', description: 'd' })
    await $.tool.call({
      tool: BRIEF_TOOL,
      goal: `use ${secrets.anthropic}`,
      proof: { taskId: '1', artifact: `log ${secrets.dbUrl}` },
      decision: { text: `header ${secrets.bearer}`, by: 'Dave' },
    })
    await turnEnd($, `Goal: ${secrets.anthropic}\n## Next steps\n1. send ${secrets.bearer}`)
    expect(snapshots(seen).length).toBeGreaterThan(0)
    for (const write of snapshots(seen)) expect(leaks(write.text)).toBe(false)
  })

  test('E8 a refused tool makes the chip blocked until the next turn starts', async ($, on) => {
    const seen = world(on)
    await startMod($, true)
    await $.turn.start({ turnId: 't1' } as never)
    await $.tool.call({ tool: 'Bash', command: 'refuse this' })
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(lastSnapshot(seen).chip).toBe('blocked')
    await turnEnd($, 'ok')
    await $.turn.start({ turnId: 't2' } as never)
    expect(lastSnapshot(seen).chip).toBe('working')
  })

  test('E8b a subagent cannot set the brief; the main session still can', async ($, on) => {
    const seen = world(on)
    await startMod($, false)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'main goal' })
    const ran = await $.tool.call({ tool: BRIEF_TOOL, goal: 'subagent goal', agentId: 'a1' })
    expect(ran.deny).toBeUndefined()
    expect(said(ran)).toBe('brief_set failed: only the main session sets the brief')
    expect(lastSnapshot(seen).brief.goal).toBe('main goal')
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'main again' })
    expect(lastSnapshot(seen).brief.goal).toBe('main again')
  })

  test('E8c a session that is still active keeps its ask fresh past 24 hours; the snapshot chip stays waiting-on-dave', async ($, on) => {
    const seen = world(on)
    await startMod($, false)
    await $.tool.call({ tool: BRIEF_TOOL, ask: [{ kind: 'question', text: 'which one?' }] })
    // 25 hours later the session starts another turn: it is active, so the ask is not stale.
    await seen.clock.advance(25 * 3600_000)
    await $.turn.start({ turnId: 't9' } as never)
    expect(lastSnapshot(seen).chip).toBe('waiting-on-dave')
  })

  // The Agent Ledger records the run on agent.spawn (hooks/agent-ledger); agent.list stays empty in this world, so only agentRuns can say a run is live.
  const withAgents = (on: On, env: Record<string, string> = {}) => {
    const seen = world(on, env)
    on('fs.read', () => ({ value: '' }))
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
    return seen
  }
  const spawnScout = ($: Engine) =>
    $.agent.spawn({ tool_use_id: 't', prompt: 'p', description: 'map the hooks', subagentType: 'scout', parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  const subagentStart = ($: Engine) => $.turn.start({ turnId: 'sub', agentId: 'a1' } as never)
  const subagentEnd = ($: Engine) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub', agentId: 'a1', reason: 'end_turn' } as never)

  test('E11 a running subagent makes the snapshot chip working with no turn and no tool; it is idle again once the run ends', async ($, on) => {
    const seen = withAgents(on)
    await startMod($, true)
    await spawnScout($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(lastSnapshot(seen).agentRuns.map((one: { status: string }) => one.status)).toEqual(['running'])
    expect(lastSnapshot(seen).chip).toBe('working')
    await subagentEnd($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g2' })
    expect(lastSnapshot(seen).agentRuns.map((one: { status: string }) => one.status)).toEqual(['done'])
    expect(lastSnapshot(seen).chip).toBe('idle')
  })

  test("E12 a subagent's turn.start leaves the main turn as it was, and is passed on", async ($, on) => {
    const seen = withAgents(on)
    await startMod($, true)
    await $.turn.start({ turnId: 't1' } as never)
    await seen.clock.advance(5_000)
    const out = await subagentStart($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(lastSnapshot(seen).turn).toEqual({ id: 't1', startedAt: 1_000 })
    expect(out).toMatchObject({ turnId: 'sub' })
  })

  test('E12b a subagent turn.start with no main turn leaves turn null (the audit snapshot case)', async ($, on) => {
    const seen = withAgents(on)
    await startMod($, true)
    await subagentStart($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(lastSnapshot(seen).turn).toBeNull()
  })

  test("E13 a subagent's turn.start does not clear the main turn's refusal: the chip stays blocked", async ($, on) => {
    const seen = withAgents(on)
    await startMod($, true)
    await $.turn.start({ turnId: 't1' } as never)
    await $.tool.call({ tool: 'Bash', command: 'refuse this' })
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(lastSnapshot(seen).chip).toBe('blocked')
    await subagentStart($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g2' })
    expect(lastSnapshot(seen).chip).toBe('blocked')
  })

  // Review fixes. The agents atom fills from agent.list while a turn runs (the 5 s pulse), so these tests run a main turn, let the pulse read, then end it.
  const listing = (seen: Seen, agents: { id: string; status: string }[]) => {
    seen.agents = agents.map(one => ({ ...one, description: 'map the hooks', type: 'scout' }))
  }
  const pulseRead = async ($: Engine, seen: Seen) => {
    await $.turn.start({ turnId: 't1' } as never)
    await seen.clock.advance(5_000)
    await turnEnd($, 'ok')
  }
  const agentStatuses = (seen: Seen) => lastSnapshot(seen).agents.map((one: { id: string; status: string }) => `${one.id}:${one.status}`)

  test('E14 a settled run whose agent starts a turn again is live again: chip working, listed in AGENTS', async ($, on) => {
    const seen = withAgents(on)
    await startMod($, true)
    await spawnScout($)
    await subagentEnd($)
    await subagentStart($)
    listing(seen, [{ id: 'a1', status: 'running' }])
    await pulseRead($, seen)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(lastSnapshot(seen).agentRuns.map((one: { status: string }) => one.status)).toEqual(['running'])
    expect(agentStatuses(seen)).toEqual(['a1:running'])
    expect(lastSnapshot(seen).chip).toBe('working')
  })

  test('E14b an agent that ends drops out of AGENTS at once, even when the last list still held it', async ($, on) => {
    const seen = withAgents(on)
    await startMod($, true)
    await spawnScout($)
    listing(seen, [{ id: 'a1', status: 'running' }])
    await pulseRead($, seen)
    await subagentEnd($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(agentStatuses(seen)).toEqual([])
    expect(lastSnapshot(seen).chip).toBe('idle')
  })

  test('E15 the list is authoritative: a running ledger run the list holds as waiting is not working', async ($, on) => {
    const seen = withAgents(on)
    await startMod($, true)
    await spawnScout($)
    listing(seen, [{ id: 'a1', status: 'waiting' }])
    await pulseRead($, seen)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(agentStatuses(seen)).toEqual(['a1:waiting'])
    expect(lastSnapshot(seen).chip).toBe('idle')
  })

  test('E15b ledger off: an agent the list holds as running still makes the chip working, the same as AGENTS says', async ($, on) => {
    const seen = withAgents(on, { CCV3_MOD_LEDGER_OFF: '1' })
    await startMod($, true)
    await spawnScout($)
    listing(seen, [{ id: 'a1', status: 'running' }])
    await pulseRead($, seen)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(lastSnapshot(seen).agentRuns).toEqual([])
    expect(agentStatuses(seen)).toEqual(['a1:running'])
    expect(lastSnapshot(seen).chip).toBe('working')
  })

  // CodeRabbit on PR #206. The idle pulse (no main turn, no step) re-reads agent.list only while a ledger run is running.
  const countListReads = (seen: Seen) => {
    const state = { reads: 0 }
    Object.defineProperty(seen, 'agents', { configurable: true, get: () => ((state.reads += 1), [{ id: 'a1', status: 'completed', description: 'map the hooks', type: 'scout' }]) })
    return state
  }
  const idleTick = async (seen: Seen) => {
    await seen.clock.advance(5_000)
    // The pulse runs unawaited (void pulse): let its reads finish.
    for (let turns = 0; turns < 50; turns += 1) await Promise.resolve()
  }

  test('E16 an idle pulse with a running ledger run re-reads agent.list, so a run the list holds as done settles', async ($, on) => {
    const seen = withAgents(on)
    await startMod($, true)
    await spawnScout($)
    const list = countListReads(seen)
    await idleTick(seen)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(list.reads).toBeGreaterThan(0)
    expect(lastSnapshot(seen).agentRuns.map((one: { status: string }) => one.status)).toEqual(['done'])
    expect(lastSnapshot(seen).chip).toBe('idle')
  })

  test('E16b an idle pulse with no running ledger run does not call agent.list', async ($, on) => {
    const seen = withAgents(on)
    await startMod($, true)
    await spawnScout($)
    await subagentEnd($)
    const list = countListReads(seen)
    await idleTick(seen)
    expect(list.reads).toBe(0)
  })

  test('E16c an idle pulse re-reads agent.list while the list itself holds a running agent, so a stale running entry settles', async ($, on) => {
    const seen = withAgents(on)
    await startMod($, true)
    listing(seen, [{ id: 'a9', status: 'running' }])
    await pulseRead($, seen)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(agentStatuses(seen)).toEqual(['a9:running'])
    const list = countListReads(seen)
    await idleTick(seen)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g2' })
    expect(list.reads).toBeGreaterThan(0)
    expect(agentStatuses(seen)).toEqual([])
    expect(lastSnapshot(seen).chip).toBe('idle')
  })

  test('E17 a subagent turn.start sets the listed entry for that agent to running: a waiting list entry no longer hides the run', async ($, on) => {
    const seen = withAgents(on)
    await startMod($, true)
    await spawnScout($)
    listing(seen, [{ id: 'a1', status: 'waiting' }])
    await pulseRead($, seen)
    await subagentStart($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(agentStatuses(seen)).toEqual(['a1:running'])
    expect(lastSnapshot(seen).chip).toBe('working')
  })

  test('E17c a stale waiting list result on the next refresh does not undo the running state a subagent turn.start set', async ($, on) => {
    const seen = withAgents(on)
    await startMod($, true)
    await spawnScout($)
    listing(seen, [{ id: 'a1', status: 'waiting' }])
    await pulseRead($, seen)
    await subagentStart($)
    await idleTick(seen)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(agentStatuses(seen)).toEqual(['a1:running'])
    expect(lastSnapshot(seen).chip).toBe('working')
  })

  test('E17b after that turn.start, a turn.complete for the agent removes it from AGENTS and the chip is idle', async ($, on) => {
    const seen = withAgents(on)
    await startMod($, true)
    await spawnScout($)
    listing(seen, [{ id: 'a1', status: 'waiting' }])
    await pulseRead($, seen)
    await subagentStart($)
    await subagentEnd($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'g' })
    expect(agentStatuses(seen)).toEqual([])
    expect(lastSnapshot(seen).chip).toBe('idle')
  })

  test('E9 /clear drops the brief', async ($, on) => {
    const seen = world(on)
    await startMod($, true)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'old goal' })
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    await turnEnd($, 'ok')
    expect(lastSnapshot(seen).brief ?? null).toBeNull()
  })

  test('E10 CCV3_MODS_OFF=1 registers nothing and writes nothing', async ($, on) => {
    const seen = world(on, { CCV3_MODS_OFF: '1' })
    await startMod($, true)
    expect(Object.keys(seen.tools)).toEqual([])
    expect(seen.writes).toEqual([])
  })
})
