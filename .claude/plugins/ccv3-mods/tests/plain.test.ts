import { describe, expect, test } from 'claude-code/testing'

import { applyBrief } from '../hooks/agentic-os/brief'
import type { Chip } from '../hooks/agentic-os/brief'
import {
  askSentence,
  chipWord,
  driftSentence,
  filesSentences,
  helperSentence,
  keeperSentence,
  laneSentence,
  prSentence,
  proofSentence,
  roomSentences,
  stepSentence,
  workflowSentence,
} from '../hooks/agentic-os/plain'
// New exports come through the namespace, so a missing one fails its own test and not the whole file.
import * as plain from '../hooks/agentic-os/plain'
import { drift as driftOf } from '../hooks/agentic-os/steward'
import type { Activity } from '../hooks/agentic-os/steward'
import type { BoardLane, FileTouch, HudLimit, KeeperRecord } from '../types'

// /os redesign, round 1: hooks/agentic-os/plain.ts, the glossary (.claudedocs/2026-10-29-os-pane-glossary.md) as pure functions.
//
// Contract these tests pin (the plan left these holes; the choices are mine and the implementer must follow them or change the test):
//   - Where the plan and the glossary differ the plan wins: REVIEWED has no thread count ("Review found issues on change #N. I am
//     fixing them."), STALLED has no reason ("No review of change #N after 60 minutes."), LIMITED says "reviewer rate limit" only
//     with a known wait and plain "did not finish" without one (the bfb94e8c fix).
//   - prSentence of a null state returns null or a sentence with no 'null'; an unknown state ('DRAFT' today, or 'WEIRD') draws a plain
//     "Change #N ..." sentence that never prints the raw code. DRAFT is pinned: "Change #N is a draft, not ready for review yet" (round 2:
//     voice rule 3 bans a command name such as /pathway on the Overview; the final period is optional).
//   - stepSentence takes no artifact, so the proven sentence has no parenthesis: the Plan and Proof tabs add the artifact basename.
//   - proofSentence is NOT in the plan's interface list. The task asks for "checks and proofs" (glossary rows "tests pass", "tests fail",
//     "proof saved"), so I name it proofSentence(proof: { subject; result?: { passed; failed } }). The gate rows ("Pre-merge checks pass")
//     have no data source in the mod and are not pinned.
//   - driftSentence of a stale drift keeps the steward's counts ("12 tool calls and 1 commit") and swaps "since the brief changed" for
//     "since the plan last changed". The fixture comes from the real steward.drift().
//   - Plural counts are used in the helper, file and workflow sentences (2 helpers, 3 files). Round 2 pins the singular of proofSentence only:
//     "1 test passes" and "1 of 1 test fails" (a count of one reads singular, with no ", 0 fail" tail).
//   - Round 2: an ACTIVE lane that nobody owns (owner null, not mine) reads "A lane nobody holds yet", never "Another session holds".
//   - roomSentences order: context, cost, the 5-hour and weekly allowance, cache. A null field is left out. An unknown limit kind
//     draws nothing raw (it may be left out).
//
// Ways the wording can fail, one test each:
// W1  a sentence drifts from the glossary (chip, PR state, ask kind, plan step, helper, workflow, drift, lane, files, keeper, room, proof)
// W2  an unknown or null input prints the raw code, JSON, 'null' or 'undefined' instead of a plain label
// W3  a PR state that needs Dave is not marked, or one that does not is marked
// W4  LIMITED with no known wait says 'rate limit' (a review that did not finish is not a rate limit)
// W5  a helper with no description shows nothing, or the raw type is shown when the description exists
// W6  a helper at exactly 10 minutes reads as long (long means over 10 minutes)
// W7  a secret, a newline or a 5,000 character text in any input reaches any returned string, or a string is longer than 400
// W8  the keeper kill rule fires at 2 of 5, or the newest record does not decide the plain line
// W9  the Swarm run sentence puts a count before the counts, shows a zero running or a zero failed, or invents a total
// W10 the Swarm run sentence without a feed names a script or a phase it cannot know, or with one drops the name, the phase or its order
// W11 purposeOf is not exported, or reads the description after the type

const SECRET = 'sk-' + 'ant-' + 'a'.repeat(40)
const MIN = 60_000
const NOW = 100 * 3600_000

// Every string inside a result: a string, an array of strings, or { text, next }.
const strings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : []

const RAW = /undefined|null|\[object|[{}]/

const run = (over: Record<string, unknown> = {}) => ({ description: 'mapping the hooks', type: 'scout', status: 'running' as const, startedAt: NOW - 2 * MIN, endedAt: null, ...over })
const lane = (over: Partial<BoardLane> = {}): BoardLane => ({ id: 'ccv3-mods', title: 'the mods lane', state: 'active', mine: true, owner: 'aaaaaaaa', ...over })
const rec = (at: number, kept: boolean): KeeperRecord => ({ at, sessionId: 's1', open: 1, total: 2, kept })
const file = (state: FileTouch['state'], path: string, added = 0, removed = 0): FileTouch => ({ path, state, added, removed })

describe('chipWord', () => {
  test('W1 the five chips read as plain words', () => {
    const words: Record<Chip, string> = {
      working: 'Working',
      'waiting-on-dave': 'Waiting for you',
      blocked: 'Stuck: a step cannot go on',
      done: 'Done: every step is proven',
      idle: 'Idle',
    }
    for (const [chip, word] of Object.entries(words)) expect(chipWord(chip as Chip)).toBe(word)
  })

  test('W2 an unknown chip reads Idle', () => {
    expect(chipWord('bogus' as never)).toBe('Idle')
    expect(chipWord(undefined as never)).toBe('Idle')
  })
})

describe('prSentence', () => {
  test('W1 W3 READY asks Dave to say merge; it is the one state that needs him', () => {
    expect(prSentence({ pr: 7, state: 'READY' })).toEqual({ text: 'Change #7 is approved and checks pass. Say "merge" to land it.', needsDave: true })
  })

  test('W1 REVIEWED, PROOF, PENDING and CLOSED read as the glossary says and do not need Dave', () => {
    expect(prSentence({ pr: 8, state: 'REVIEWED' })).toEqual({ text: 'Review found issues on change #8. I am fixing them.', needsDave: false })
    expect(prSentence({ pr: 9, state: 'PROOF' })).toEqual({ text: 'Change #9 needs its test evidence fixed in the description.', needsDave: false })
    expect(prSentence({ pr: 10, state: 'PENDING' })).toEqual({ text: 'Waiting for the review of change #10.', needsDave: false })
    expect(prSentence({ pr: 11, state: 'CLOSED' })).toEqual({ text: 'Change #11 is closed.', needsDave: false })
  })

  test('W1 a merged change reads merged, whatever its last state was', () => {
    expect(prSentence({ pr: 12, state: 'READY', merged: true })?.text).toBe('Change #12 is merged.')
    expect(prSentence({ pr: 12, state: 'CLOSED', merged: true })?.text).toBe('Change #12 is merged.')
    expect(prSentence({ pr: 12, state: 'READY', merged: true })?.needsDave).toBe(false)
  })

  test('W1 STALLED has no reason, so the sentence has no reason slot', () => {
    const text = prSentence({ pr: 13, state: 'STALLED' })?.text ?? ''
    expect(text).toContain('No review of change #13 after 60 minutes')
    expect(text).not.toMatch(/: \.|undefined|null|:\s*$/)
  })

  test('W1 W4 LIMITED says "reviewer rate limit" with a known wait and only "did not finish" without one', () => {
    const waited = prSentence({ pr: 14, state: 'LIMITED', rateLimit: { minutes: 30 } })?.text ?? ''
    expect(waited).toBe('The review of change #14 did not finish: reviewer rate limit.')
    const unknown = prSentence({ pr: 14, state: 'LIMITED' })?.text ?? ''
    expect(unknown).toContain('The review of change #14 did not finish')
    expect(unknown).not.toMatch(/rate limit/i)
  })

  test('W1 W2 DRAFT reads as the glossary amendment says; an unknown state draws a plain sentence with no raw code', () => {
    expect(prSentence({ pr: 15, state: 'DRAFT' as never })?.text).toMatch(/^Change #15 is a draft, not ready for review yet\.?$/)
    expect(prSentence({ pr: 15, state: 'DRAFT' as never })?.text).not.toMatch(/pathway|\//)
    expect(prSentence({ pr: 15, state: 'DRAFT' as never })?.needsDave).toBe(false)
    const weird = prSentence({ pr: 16, state: 'WEIRD' as never })
    expect(weird?.text).toContain('hange #16')
    expect(weird?.text).not.toContain('WEIRD')
    expect(weird?.needsDave).toBe(false)
  })

  test('W2 a state that is null is not printed as null; a pr that is not a number gives no sentence', () => {
    const unchecked = prSentence({ pr: 17, state: null })
    expect(unchecked === null || !/null|undefined/.test(unchecked.text)).toBe(true)
    expect(prSentence({ pr: Number.NaN, state: 'READY' })).toBeNull()
    expect(prSentence({ pr: undefined as never, state: 'READY' })).toBeNull()
  })
})

describe('askSentence', () => {
  test('W1 a question reads Answer: with the recommendation on the next line', () => {
    expect(askSentence({ kind: 'question', text: 'Which port?', recommend: '8080' }, false)).toEqual({ text: 'Answer: Which port?', next: 'I suggest: 8080' })
  })

  test('W1 a question with no recommendation has no next line', () => {
    const out = askSentence({ kind: 'question', text: 'Which port?' }, false)
    expect(out.text).toBe('Answer: Which port?')
    expect(out.next).toBeUndefined()
  })

  test('W1 an approval, a block and a decision read Approve:, Stuck: and Decide:', () => {
    expect(askSentence({ kind: 'approval', text: 'run the migration' }, false).text).toBe('Approve: run the migration')
    expect(askSentence({ kind: 'block', text: 'the lockfile is locked' }, false).text).toBe('Stuck: the lockfile is locked')
    expect(askSentence({ kind: 'decision', text: 'pick a database', recommend: 'Postgres' }, false).text).toBe('Decide: pick a database. I suggest Postgres.')
    const bare = askSentence({ kind: 'decision', text: 'pick a database' }, false).text
    expect(bare.startsWith('Decide: pick a database')).toBe(true)
    expect(bare).not.toContain('I suggest')
  })

  test('W1 an answered ask that went quiet reads as an old question', () => {
    expect(askSentence({ kind: 'question', text: 'Which port?', answered: true }, true).text).toBe('Old question, still open?')
  })

  test('W2 an unknown kind keeps the ask text and prints no raw kind', () => {
    const out = askSentence({ kind: 'weirdkind' as never, text: 'check the lockfile' }, false)
    expect(out.text).toContain('check the lockfile')
    expect(out.text).not.toContain('weirdkind')
    expect(strings(out).join('\n')).not.toMatch(RAW)
  })
})

describe('stepSentence', () => {
  test('W1 each step status reads as the glossary says; the proven sentence carries no artifact', () => {
    expect(stepSentence({ state: 'todo', subject: 'wire the pane', proven: false })).toBe('Next: wire the pane')
    expect(stepSentence({ state: 'doing', subject: 'wire the pane', proven: false })).toBe('Doing: wire the pane')
    expect(stepSentence({ state: 'done', subject: 'wire the pane', proven: true })).toBe('Done and proven: wire the pane')
    expect(stepSentence({ state: 'done', subject: 'wire the pane', proven: false })).toBe('Done but not proven yet: wire the pane')
  })

  test('W1 W2 a blocked step names the subject; an unknown state falls back to a plain label', () => {
    expect(stepSentence({ state: 'blocked', subject: 'wire the pane', proven: false })).toContain('wire the pane')
    const weird = stepSentence({ state: 'weird' as never, subject: 'wire the pane', proven: false })
    expect(weird).toContain('wire the pane')
    expect(weird).not.toMatch(/weird|undefined|null/)
  })
})

describe('helperSentence', () => {
  test('W1 a running helper reads A helper is <description>', () => {
    expect(helperSentence(run(), NOW)).toBe('A helper is mapping the hooks')
  })

  test('W1 W6 a helper over 10 minutes says how long; at exactly 10 minutes it does not', () => {
    expect(helperSentence(run({ startedAt: NOW - 12 * MIN }), NOW)).toBe('A helper has run 12 min: mapping the hooks')
    expect(helperSentence(run({ startedAt: NOW - 10 * MIN }), NOW)).toBe('A helper is mapping the hooks')
  })

  test('W1 a finished helper reads A helper finished: <description>', () => {
    expect(helperSentence(run({ status: 'done', endedAt: NOW - MIN }), NOW)).toBe('A helper finished: mapping the hooks')
  })

  test('W5 with no description the type is the purpose; with neither it is "a task"', () => {
    expect(helperSentence(run({ description: '' }), NOW)).toBe('A helper is scout')
    expect(helperSentence(run({ description: '   ' }), NOW)).toBe('A helper is scout')
    expect(helperSentence(run({ description: '', type: '' }), NOW)).toBe('A helper is a task')
    expect(helperSentence(run({ description: undefined, type: undefined }), NOW)).toBe('A helper is a task')
  })

  test('W5 the description wins over the type when both exist', () => {
    expect(helperSentence(run({ description: 'checking the lanes', type: 'kraken' }), NOW)).not.toContain('kraken')
  })

  test('W2 a failed helper prints no raw status', () => {
    const text = helperSentence(run({ status: 'failed', endedAt: NOW - MIN }), NOW)
    expect(text).toContain('mapping the hooks')
    expect(text).not.toMatch(RAW)
  })
})

describe('workflowSentence', () => {
  test('W1 a workflow reads its done and running helpers and invents no total', () => {
    const text = workflowSentence({ key: 'wf_1', done: 2, failed: 0, running: 1, startedAt: 1, latestAt: 2 })
    expect(text).toBe('A workflow: 2 helpers done, 1 running')
    expect(text).not.toMatch(/ of \d/)
    expect(workflowSentence({ key: 'wf_2', done: 3, failed: 0, running: 0, startedAt: 1, latestAt: 2 })).toBe('A workflow: 3 helpers done, 0 running')
  })
})

describe('swarmRunSentence', () => {
  const progress = (over: Record<string, number> = {}) => ({ key: 'wf_1', done: 4, failed: 0, running: 1, startedAt: 1, latestAt: 2, ...over })

  test('W9 the counts come first: running, done, then failed only above 0; a zero count is left out', () => {
    expect(plain.swarmRunSentence(progress())).toBe('1 running, 4 done · a workflow')
    expect(plain.swarmRunSentence(progress({ failed: 1 }))).toBe('1 running, 4 done, 1 failed · a workflow')
    expect(plain.swarmRunSentence(progress({ running: 0, done: 3 }))).toBe('3 done · a workflow')
    expect(plain.swarmRunSentence(progress({ running: 2, done: 0, failed: 0 }))).toBe('2 running · a workflow')
    expect(plain.swarmRunSentence(progress({ running: 0, done: 0, failed: 2 }))).toBe('2 failed · a workflow')
    expect(plain.swarmRunSentence(progress({ running: 0, done: 0, failed: 0 }))).toBe('0 done · a workflow')
  })

  test('W9 W10 with a feed the order is counts, phase, name; the phase reads "of N" only when the total is known', () => {
    const feed = { name: 'pane-fleet-assess', phase: { index: 2, total: 2, title: 'Judge' } }
    expect(plain.swarmRunSentence(progress(), feed)).toBe('1 running, 4 done · phase 2 of 2: Judge · pane-fleet-assess')
    expect(plain.swarmRunSentence(progress(), { name: 'pane-fleet-assess', phase: { index: 2, total: null, title: 'Judge' } })).toBe('1 running, 4 done · phase 2: Judge · pane-fleet-assess')
    expect(plain.swarmRunSentence(progress(), { name: 'pane-fleet-assess', phase: { index: 2, total: 3, title: null } })).toBe('1 running, 4 done · phase 2 of 3 · pane-fleet-assess')
  })

  test('W10 no feed, an empty feed or a feed with no name reads "a workflow"; a feed with no phase draws no phase', () => {
    for (const feed of [undefined, null, { name: null, phase: null }, { name: '  ', phase: null }]) {
      const text = plain.swarmRunSentence(progress(), feed)
      expect(text).toBe('1 running, 4 done · a workflow')
      expect(text).not.toMatch(/phase/)
    }
    expect(plain.swarmRunSentence(progress(), { name: 'flow', phase: null })).toBe('1 running, 4 done · flow')
    expect(plain.swarmRunSentence(progress(), { name: null, phase: { index: 1, total: 2, title: 'Map' } })).toBe('1 running, 4 done · phase 1 of 2: Map · a workflow')
  })

  test('W9 W2 a count that is not a number, or a total that is not finite, prints no NaN, null or undefined', () => {
    const odd = plain.swarmRunSentence({ key: 'k', done: Number.NaN, failed: undefined, running: null, startedAt: 1, latestAt: 2 } as never, { name: null, phase: { index: Number.NaN, total: Number.POSITIVE_INFINITY, title: null } })
    expect(odd).not.toMatch(/NaN|Infinity|null|undefined/)
    expect(odd).toContain('a workflow')
  })

  test('W7 a secret or a 5,000-character name or title reaches no part of the sentence', () => {
    for (const text of [SECRET, `x ${SECRET}\ny`, 'q'.repeat(5000)]) {
      const one = plain.swarmRunSentence(progress(), { name: text, phase: { index: 1, total: 2, title: text } })
      expect(one).not.toContain('sk-ant')
      expect(one).not.toMatch(/a{12}/)
      expect(one).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/)
      expect(one.length).toBeLessThanOrEqual(400)
    }
  })
})

describe('purposeOf', () => {
  test('W11 W5 the description first, then the type, then "a task"; the export is the one helperSentence uses', () => {
    expect(plain.purposeOf({ description: 'map the hooks', type: 'scout' })).toBe('map the hooks')
    expect(plain.purposeOf({ description: '', type: 'scout' })).toBe('scout')
    expect(plain.purposeOf({ description: '  ', type: '' })).toBe('a task')
    expect(plain.purposeOf({ description: null, type: undefined } as never)).toBe('a task')
    expect(helperSentence(run({ description: 'map the hooks' }), NOW)).toContain(plain.purposeOf({ description: 'map the hooks', type: 'scout' }))
  })

  test('W11 W7 a secret in the description or the type is redacted', () => {
    expect(plain.purposeOf({ description: SECRET, type: 'scout' })).not.toContain('sk-ant')
    expect(plain.purposeOf({ description: '', type: SECRET })).not.toContain('sk-ant')
  })
})

describe('driftSentence', () => {
  const activity = (over: Partial<Activity> = {}): Activity => ({ toolCalls: 0, commits: 0, prs: 0, runs: 0, resumes: 0, laneClaims: 0, artifacts: 0, ...over })
  const withGoal = (plan?: unknown[]) => {
    const made = applyBrief(null, { goal: 'ship the pane', ...(plan ? { plan } : {}) }, [], NOW)
    if ('error' in made) throw new Error(made.error)
    return made.brief
  }

  test('W1 no drift gives nothing: null input, and the ok level', () => {
    expect(driftSentence(null)).toBeNull()
    expect(driftSentence(driftOf(withGoal(), activity()))).toBeNull()
  })

  test('W1 an unset goal with work started reads as the glossary says', () => {
    expect(driftSentence(driftOf(null, activity({ toolCalls: 3 })))).toBe('The session goal is not set yet, and work has started.')
  })

  test('W1 a stale brief keeps the counts and says the plan, not the brief', () => {
    const text = driftSentence(driftOf(withGoal(), activity({ toolCalls: 12, commits: 1 }))) ?? ''
    expect(text).toContain('12 tool calls and 1 commit')
    expect(text).toContain('since the plan last changed')
    expect(text).not.toMatch(/brief/i)
    expect(text.endsWith('.')).toBe(true)
  })

  test('W1 a plan that is all done while work goes on reads as the glossary says', () => {
    const done = withGoal([{ id: '1', text: 'only step', status: 'done' }])
    expect(driftSentence(driftOf(done, activity({ toolCalls: 2 })))).toBe('Every plan step is done, but work goes on.')
  })

  test('W2 an unknown level gives nothing or a sentence with no raw code', () => {
    const out = driftSentence({ level: 'weird' as never, reason: 'x', key: 'k' })
    expect(out === null || !/weird|undefined|null/.test(out)).toBe(true)
  })
})

describe('laneSentence', () => {
  test('W1 my active lane reads You hold lane <id>: <title>; a peer lane reads Another session holds lane <id>', () => {
    expect(laneSentence(lane())).toBe('You hold lane ccv3-mods: the mods lane')
    expect(laneSentence(lane({ mine: false, owner: 'bbbbbbbb' }))).toBe('Another session holds lane ccv3-mods')
  })

  test('W1 ready, review and blocked lanes read as the glossary says', () => {
    expect(laneSentence(lane({ state: 'ready', mine: false, owner: null }))).toBe('Lane ccv3-mods is ready for the next step')
    expect(laneSentence(lane({ state: 'review' }))).toBe('Lane ccv3-mods waits for review')
    expect(laneSentence(lane({ state: 'blocked' }))).toBe('Lane ccv3-mods is blocked')
  })

  test('W1 W2 an active lane that nobody owns reads "A lane nobody holds yet", not "Another session holds"; an owned peer lane still does', () => {
    const text = laneSentence(lane({ state: 'active', mine: false, owner: null }))
    expect(text).toMatch(/^A lane nobody holds yet/)
    expect(text).toContain('ccv3-mods')
    expect(text).not.toMatch(/Another session|You hold/)
    expect(laneSentence(lane({ state: 'active', mine: false, owner: 'bbbbbbbb' }))).toBe('Another session holds lane ccv3-mods')
    expect(laneSentence(lane({ state: 'active', mine: true, owner: null }))).toMatch(/^You hold lane ccv3-mods/)
  })

  test('W2 an unknown state keeps the lane id and prints no raw state', () => {
    const text = laneSentence(lane({ state: 'weirdstate' }))
    expect(text).toContain('ccv3-mods')
    expect(text).not.toContain('weirdstate')
    expect(text).not.toMatch(RAW)
  })
})

describe('filesSentences', () => {
  test('W1 reads, edits and commits read as Looked at, Changed (+added -removed) and Saved to git, in that order', () => {
    const files = [
      file('read', 'a.ts'),
      file('read', 'b.ts'),
      file('read', 'c.ts'),
      file('edited', 'd.ts', 6, 1),
      file('edited', 'e.ts', 4, 3),
      file('committed', 'f.ts'),
      file('committed', 'g.ts'),
    ]
    expect(filesSentences(files)).toEqual(['Looked at 3 files', 'Changed 2 files (+10 -4)', 'Saved 2 files to git'])
  })

  test('W1 a state with no file is left out, and no files give no sentence', () => {
    expect(filesSentences([])).toEqual([])
    expect(filesSentences([file('read', 'a.ts'), file('read', 'b.ts')])).toEqual(['Looked at 2 files'])
  })
})

describe('keeperSentence', () => {
  test('W1 no record gives nothing', () => {
    expect(keeperSentence([])).toBeNull()
  })

  test('W1 W8 the newest record decides: kept, then lost', () => {
    expect(keeperSentence([rec(1, true)])).toEqual({ text: 'The last summary kept the plan.', kill: false })
    expect(keeperSentence([rec(1, true), rec(2, false)])).toEqual({ text: 'The last summary lost the plan.', kill: false })
    expect(keeperSentence([rec(1, false), rec(2, true)])).toEqual({ text: 'The last summary kept the plan.', kill: false })
  })

  test('W1 W8 3 of the newest 5 lost reads the kill line and sets kill', () => {
    const five = [rec(1, false), rec(2, true), rec(3, false), rec(4, true), rec(5, false)]
    expect(keeperSentence(five)).toEqual({ text: 'The plan keeper failed 3 of 5 times. Consider removing it.', kill: true })
  })

  test('W9 an empty session (0 of 0) with a lost marker never claims a lost plan, and a kept one never claims a kept plan', () => {
    const empty = (kept: boolean): KeeperRecord => ({ at: 1, sessionId: 's1', open: 0, total: 0, kept })
    const lost = keeperSentence([empty(false)])
    expect(lost?.text).toBe('The last summary lost the keeper marker.')
    expect(lost?.text).not.toContain('plan')
    expect(keeperSentence([empty(true)])?.text).toBe('The last summary kept the keeper marker.')
  })

  test('W9 a session that had tasks (open or all done) still reads plan loss', () => {
    expect(keeperSentence([{ at: 1, sessionId: 's1', open: 0, total: 3, kept: false }])?.text).toBe('The last summary lost the plan.')
  })

  test('W8 2 of 5 lost does not set the kill rule; an old loss outside the newest 5 does not count', () => {
    const two = [rec(1, false), rec(2, true), rec(3, false), rec(4, true), rec(5, true)]
    expect(keeperSentence(two)?.kill).toBe(false)
    const old = [rec(1, false), rec(2, false), rec(3, false), rec(4, true), rec(5, true), rec(6, true), rec(7, true), rec(8, true)]
    expect(keeperSentence(old)?.kill).toBe(false)
  })
})

describe('roomSentences', () => {
  const limits: HudLimit[] = [
    { kind: 'five_hour', percentUsed: 63 },
    { kind: 'seven_day', percentUsed: 12 },
  ]

  test('W1 context, cost, allowances and cache read as the glossary says, in that order', () => {
    expect(roomSentences({ ctx: 42, costUsd: 1.5, cachePct: 88, limits })).toEqual([
      'Context 42% full',
      'Spent $1.50 this session',
      '63% of the 5-hour allowance used',
      '12% of the weekly allowance used',
      'Cache saving 88%',
    ])
  })

  test('W1 a percent is rounded to a whole number', () => {
    expect(roomSentences({ ctx: 41.6, costUsd: null, cachePct: 87.6, limits: [] })).toEqual(['Context 42% full', 'Cache saving 88%'])
  })

  test('W2 null fields and no limits give no sentence; an unknown limit kind prints nothing raw', () => {
    expect(roomSentences({ ctx: null, costUsd: null, cachePct: null, limits: [] })).toEqual([])
    const odd = roomSentences({ ctx: null, costUsd: null, cachePct: null, limits: [{ kind: 'extra_spend', percentUsed: 5 }] })
    expect(strings(odd).join('\n')).not.toMatch(RAW)
    expect(strings(odd).join('\n')).not.toContain('extra_spend')
  })
})

describe('proofSentence', () => {
  test('W1 a pass reads the numbers; a fail reads k of n; a proof with no result reads Proof saved', () => {
    expect(proofSentence({ subject: 'the gate', result: { passed: 502, failed: 0 } })).toBe('502 tests pass, 0 fail')
    expect(proofSentence({ subject: 'the gate', result: { passed: 9, failed: 3 } })).toBe('3 of 12 tests fail')
    expect(proofSentence({ subject: 'Build the pane' })).toBe('Proof saved for "Build the pane"')
  })

  test('W1 a count of one reads singular: "1 test passes" and "1 of 1 test fails"; two or more stay plural', () => {
    expect(proofSentence({ subject: 'the gate', result: { passed: 1, failed: 0 } })).toBe('1 test passes')
    expect(proofSentence({ subject: 'the gate', result: { passed: 0, failed: 1 } })).toBe('1 of 1 test fails')
    expect(proofSentence({ subject: 'the gate', result: { passed: 0, failed: 2 } })).toBe('2 of 2 tests fail')
    expect(proofSentence({ subject: 'the gate', result: { passed: 2, failed: 0 } })).toBe('2 tests pass, 0 fail')
    expect(proofSentence({ subject: 'the gate', result: { passed: 1, failed: 1 } })).toBe('1 of 2 tests fail')
  })
})

describe('every sentence', () => {
  const HOSTILE = [SECRET, 'one\ntwo\u0001three', 'q'.repeat(5000), `a ${SECRET}\nb`]

  const everything = (text: string): unknown[] => [
    prSentence({ pr: 1, state: 'READY' }),
    prSentence({ pr: 1, state: 'STALLED' }),
    askSentence({ kind: 'question', text, recommend: text }, false),
    askSentence({ kind: 'decision', text, recommend: text }, false),
    askSentence({ kind: 'approval', text }, false),
    askSentence({ kind: 'block', text }, false),
    stepSentence({ state: 'todo', subject: text, proven: false }),
    stepSentence({ state: 'done', subject: text, proven: true }),
    stepSentence({ state: 'blocked', subject: text, proven: false }),
    helperSentence(run({ description: text }), NOW),
    helperSentence(run({ description: text, startedAt: NOW - 30 * MIN }), NOW),
    helperSentence(run({ description: text, status: 'done', endedAt: NOW }), NOW),
    plain.swarmRunSentence({ key: 'wf', done: 1, failed: 1, running: 1, startedAt: 1, latestAt: 2 }, { name: text, phase: { index: 1, total: 2, title: text } }),
    laneSentence(lane({ id: text, title: text })),
    laneSentence(lane({ id: text, title: text, mine: false })),
    proofSentence({ subject: text, result: { passed: 1, failed: 0 } }),
    proofSentence({ subject: text }),
    driftSentence({ level: 'stale', reason: text, key: 'k' }),
    filesSentences([file('edited', text, 1, 1)]),
  ]

  test('W7 no returned string holds a secret, a control character or a newline, or runs past 400 characters', () => {
    for (const text of HOSTILE) {
      for (const one of strings(everything(text))) {
        expect(one).not.toContain('sk-ant')
        expect(one).not.toMatch(/a{12}/)
        expect(one).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/)
        expect(one.length).toBeLessThanOrEqual(400)
      }
    }
  })

  test('W2 W7 no input of null, undefined or the wrong type makes a sentence print null, undefined or JSON', () => {
    const outs = [
      askSentence({ kind: 'question', text: undefined as never, recommend: null as never }, false),
      askSentence({ kind: undefined as never, text: null as never }, false),
      stepSentence({ state: undefined as never, subject: undefined as never, proven: undefined as never }),
      helperSentence({ description: null, type: null, status: 'running', startedAt: NOW, endedAt: null } as never, NOW),
      laneSentence({ id: 'x', title: null, state: null, mine: false, owner: null } as never),
      laneSentence({ id: 'x' } as never),
      proofSentence({ subject: undefined as never }),
      filesSentences([{ path: 'a', state: 'weird', added: Number.NaN, removed: undefined } as never]),
      roomSentences({ ctx: Number.NaN, costUsd: undefined as never, cachePct: undefined as never, limits: undefined as never }),
      chipWord(null as never),
    ]
    expect(strings(outs).join('\n')).not.toMatch(RAW)
  })
})
