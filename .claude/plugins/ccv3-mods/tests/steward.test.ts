import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { applyBrief } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import { STALE_CALLS, drift, observe, signalOf } from '../hooks/agentic-os/steward'
import type { Activity } from '../hooks/agentic-os/steward'
import type { OsSteward, OsTask } from '../types'

// The steward (PR 4), watch-only. Dave, 2026-10-28: the mod injects nothing into the session; the prompt cache hit rate comes first.
// It observes (counts, drift) and draws (the pane's dim `brief stale` row). Ways it can fail, one test each.
// D0..D8  drift: a quiet session, no goal, the stale boundary, a commit / PR / run alone, a finished plan, a stable reason key, plain-English reasons
// S1..S9  signalOf: a real tool call is read as the wrong signal, or as none (commit with HEAD moved, PR, run, resume, lane, e2e file)
// O1..O2  observe: the call count or the signal count is off, or the old counts are mutated
// W1..W8  the wiring: nothing reaches the model (no prompt.compose section, no prompt.submit), the state key holds only briefAt and the
//         counts, subagent calls and a switched-off steward are not counted, a brief_set restarts the counts and a parsed turn end does not,
//         /clear resets them, and the pane Overview draws the dim `brief stale` row (the row itself is tested in os-tabs-model.test.ts)
//
// Reason identity: `Drift.key` is the level plus the brief version (`updatedAt`). It stays equal while the counts grow.

const NOW = 1_000_000

const zero: Activity = { toolCalls: 0, commits: 0, prs: 0, runs: 0, resumes: 0, laneClaims: 0, artifacts: 0 }
const act = (part: Partial<Activity>): Activity => ({ ...zero, ...part })

const ok = (r: ReturnType<typeof applyBrief>): Brief => {
  if ('error' in r) throw new Error(r.error)
  return r.brief
}
const apply = (prev: Brief | null, input: unknown, tasks: OsTask[] = [], now = NOW) => ok(applyBrief(prev, input, tasks, now))
const steps = (statuses: ('todo' | 'doing' | 'done' | 'blocked')[]) =>
  statuses.map((status, i) => ({ id: `s${i + 1}`, text: `step ${i + 1}`, status }))
const planned = (statuses: ('todo' | 'doing' | 'done' | 'blocked')[], goal = 'Ship the steward') => apply(null, { goal, plan: steps(statuses) })


describe('drift', () => {
  test('D0 a session with no brief and no activity is ok', () => {
    expect(drift(null, zero).level).toBe('ok')
  })

  test('D1 work started and no goal is unset, with no brief and with a brief that holds only a title', () => {
    const first = drift(null, act({ toolCalls: 1 }))
    expect(first.level).toBe('unset')
    expect(first.reason).toMatch(/goal/i)
    expect(drift(apply(null, { title: 'a title and nothing else' }), act({ toolCalls: 1 })).level).toBe('unset')
  })

  test('D2 STALE_CALLS - 1 tool calls since the last brief change is ok, STALE_CALLS is stale', () => {
    const brief = planned(['doing', 'todo'])
    expect(drift(brief, act({ toolCalls: STALE_CALLS - 1 })).level).toBe('ok')
    const at = drift(brief, act({ toolCalls: STALE_CALLS }))
    expect(at.level).toBe('stale')
    expect(at.reason).toContain(`${STALE_CALLS} tool calls`)
  })

  test('D3 one commit, one PR or one workflow run since the last brief change is stale, and the reason names it', () => {
    const brief = planned(['doing', 'todo'])
    const commit = drift(brief, act({ toolCalls: 1, commits: 1 }))
    const pr = drift(brief, act({ toolCalls: 1, prs: 1 }))
    const run = drift(brief, act({ toolCalls: 1, runs: 1 }))
    expect([commit.level, pr.level, run.level]).toEqual(['stale', 'stale', 'stale'])
    expect(commit.reason).toMatch(/1 commit/)
    expect(pr.reason).toMatch(/1 PR/)
    expect(run.reason).toMatch(/1 run/)
  })

  test('D4 a goal and one tool call, nothing else, is ok', () => {
    expect(drift(planned(['doing', 'todo']), act({ toolCalls: 1 })).level).toBe('ok')
  })

  test('D5 every plan step done and work continues is finished; with no work after it, or with a step open, it is not', () => {
    const done = planned(['done', 'done', 'done'])
    const after = drift(done, act({ toolCalls: 1 }))
    expect(after.level).toBe('finished')
    expect(after.reason).toMatch(/plan/i)
    expect(drift(done, zero).level).toBe('ok')
    expect(drift(planned(['done', 'done', 'doing']), act({ toolCalls: 1 })).level).toBe('ok')
  })

  test('D5b finished wins over stale when the plan is done and the counts are high', () => {
    expect(drift(planned(['done', 'done']), act({ toolCalls: STALE_CALLS + 5, commits: 3 })).level).toBe('finished')
  })

  test('D6 the reason key stays equal while the counts grow, and changes with the level and with the brief version', () => {
    const brief = planned(['doing', 'todo'])
    const a = drift(brief, act({ toolCalls: STALE_CALLS }))
    const b = drift(brief, act({ toolCalls: STALE_CALLS + 9, commits: 2 }))
    expect(b.key).toBe(a.key)
    expect(drift(apply(brief, { goal: 'a new goal' }, [], NOW + 5), act({ toolCalls: STALE_CALLS })).key).not.toBe(a.key)
    expect(drift(planned(['done', 'done']), act({ toolCalls: STALE_CALLS })).key).not.toBe(a.key)
  })

  test('D7 the reason key follows the version it is given, not brief.updatedAt (the turn-end parser bumps updatedAt)', () => {
    const brief = planned(['doing', 'todo'])
    const later = apply(brief, { goal: 'a new goal' }, [], NOW + 5)
    expect(drift(brief, act({ toolCalls: STALE_CALLS }), 7).key).toBe('stale@7')
    expect(drift(later, act({ toolCalls: STALE_CALLS }), 7).key).toBe('stale@7')
    expect(drift(null, act({ toolCalls: 1 }), 7).key).toBe('unset@7')
  })

  test('D8 the reasons are plain English that say why: no goal while work started, N calls and a commit since the brief changed, a done plan with work going on', () => {
    expect(drift(null, act({ toolCalls: 1 })).reason).toBe('no goal set yet while work started')
    expect(drift(planned(['doing', 'todo']), act({ toolCalls: 12, commits: 1 })).reason).toBe('12 tool calls and 1 commit since the brief changed')
    expect(drift(planned(['done', 'done']), act({ toolCalls: 1 })).reason).toBe('every plan step is done but work continues')
  })
})

describe('signalOf', () => {
  test('S1 git commit with HEAD moved is a commit, in a plain, a compound and a git-safe form', () => {
    expect(signalOf('Bash', { command: 'git commit -m "feat(agentic-os): add the steward"' }, true)).toBe('commits')
    expect(signalOf('Bash', { command: 'git add a.ts && git commit -m "x"' }, true)).toBe('commits')
    expect(signalOf('PowerShell', { command: 'pwsh -File scripts/git-safe.ps1 commit -m "x"' }, true)).toBe('commits')
  })

  test('S2 git commit with HEAD not moved (nothing to commit, a hook refused) is not a commit', () => {
    expect(signalOf('Bash', { command: 'git commit -m "x"' }, false)).toBeNull()
  })

  test('S3 git commands that are not a commit are not a commit', () => {
    expect(signalOf('Bash', { command: 'git status' }, false)).toBeNull()
    expect(signalOf('Bash', { command: 'git log --oneline -3' }, false)).toBeNull()
  })

  test('S4 a PR opened, through gh pr create and through gh api POST to pulls, is a PR; reading one is not', () => {
    expect(signalOf('Bash', { command: 'gh pr create --title "x" --body "y"' }, false)).toBe('prs')
    expect(
      signalOf('Bash', { command: 'gh api repos/Rev4nchist/continuous-claude/pulls -X POST -f title=x -f head=feat/x -f base=main' }, false),
    ).toBe('prs')
    expect(signalOf('Bash', { command: 'gh api repos/Rev4nchist/continuous-claude/pulls/202' }, false)).toBeNull()
    expect(signalOf('Bash', { command: 'gh pr view 202' }, false)).toBeNull()
  })

  test('S5 a Workflow or Agent call is a run; a plain Bash call is not', () => {
    expect(signalOf('Workflow', { name: 'os-pane-wave1' }, false)).toBe('runs')
    expect(signalOf('Agent', { subagent_type: 'kraken', prompt: 'write the tests' }, false)).toBe('runs')
    expect(signalOf('Bash', { command: 'ls' }, false)).toBeNull()
  })

  test('S6 the Skill resume_handoff is a resume; another skill is not', () => {
    expect(signalOf('Skill', { skill: 'resume_handoff', args: 'Start follow-up 1' }, false)).toBe('resumes')
    expect(signalOf('Skill', { skill: 'create_handoff' }, false)).toBeNull()
  })

  test('S7 a lane claim is a lane claim; reading the board is not', () => {
    expect(signalOf('Bash', { command: 'node scripts/coordination/lane.mjs claim sdlc-os --as 364266d5' }, false)).toBe('laneClaims')
    expect(signalOf('Bash', { command: 'node scripts/coordination/lane.mjs mine --json --as 364266d5' }, false)).toBeNull()
  })

  test('S8 writing an e2e artifact, by Write with either slash and by a shell redirect, is an artifact', () => {
    expect(signalOf('Write', { file_path: '.claude/cache/e2e/2026-10-28-fu1-rawproject-green.txt' }, false)).toBe('artifacts')
    expect(signalOf('Write', { file_path: 'C:\\Users\\dkhay\\continuous-claude\\.claude\\cache\\e2e\\2026-10-28-pre-pr-c2797a1.log' }, false)).toBe('artifacts')
    expect(
      signalOf('PowerShell', { command: 'Get-Content payload.json -Raw | node .claude/hooks/dist/x.mjs | Out-File .claude/cache/e2e/2026-10-28-hook.json' }, false),
    ).toBe('artifacts')
  })

  test('S9 a Write outside e2e, and a Read of an e2e file, are not artifacts', () => {
    expect(signalOf('Write', { file_path: '.claude/plugins/ccv3-mods/hooks/agentic-os/steward.ts' }, false)).toBeNull()
    expect(signalOf('Read', { file_path: '.claude/cache/e2e/2026-10-28-fu1-rawproject-green.txt' }, false)).toBeNull()
  })
})

describe('observe', () => {
  test('O1 every call adds one tool call, and a signal call adds its signal too', () => {
    expect(observe(zero, 'Bash', { command: 'git commit -m x' }, true)).toEqual(act({ toolCalls: 1, commits: 1 }))
    expect(observe(act({ toolCalls: 4 }), 'Read', { file_path: 'a.ts' }, false)).toEqual(act({ toolCalls: 5 }))
  })

  test('O2 the counts passed in are not mutated', () => {
    const before = act({ toolCalls: 2, runs: 1 })
    observe(before, 'Agent', { prompt: 'x' }, false)
    expect(before).toEqual(act({ toolCalls: 2, runs: 1 }))
  })
})

// --- The wiring: the real mod, with the engine below it mocked. ---

const BRIEF_TOOL = 'mcp__ccv3-mods__brief_set'
const INTRO = { id: 'intro', text: 'the engine intro', scope: 'shared' } as const
/** The facts a render is composed from; the mod reads none of them. */
const RENDER = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as const
const PANE_PROPS = { title: 'Agentic OS', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }

/**
 * `env` is read live, so a test can flip a switch after the session started. `submitted` holds every prompt that reached the engine.
 * `seen.value` is the steward record as last written: the kit's `$` has no `state`, so a state.set hook watches the write.
 */
const world = (on: On, env: Record<string, string> = {}) => {
  const submitted: string[] = []
  const seen: { value: OsSteward | undefined } = { value: undefined }
  const clock = mock.clock(on, { now: 1_000 })
  env.USERPROFILE ??= 'C:/home'
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ccv3-mods__${e.name}` } }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.compose', () => ({ sections: [INTRO] }))
  on('state.set', { plugin: 'ccv3-mods', key: 'steward' }, ($, e, next) => {
    seen.value = e.value
    return next(e)
  })
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text' } }) as never)
  return { clock, submitted, seen }
}

const startMod = ($: Engine) => $.session.start({ cwd: 'C:/r', surface: 'terminal', isInteractive: true })
const reads = async ($: Engine, n: number, agentId?: string) => {
  for (let i = 0; i < n; i++) await $.tool.call({ tool: 'Read', file_path: `C:/r/f${i}.md`, ...(agentId ? { agentId } : {}) } as never)
}
/** An answer as CLAUDE.md asks for: it ends with a Next steps block, so the turn-end parser finds an ask in it. */
const ANSWER = ['Done.', '', '## Next steps', '1. Run the gate.', ''].join('\n')
const turnEnd = ($: Engine, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never)

const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'ccv3-mods', surface: 'terminal', component: 'Pane', requestId: 'agentic-os', props: PANE_PROPS, viewport: { columns: 80, rows: 30 } })
const paneText = async ($: Engine): Promise<string> => {
  const pane = await mountPane($)
  const text = (await pane.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-')).map(found => found.text).join('\n')
  await pane.unmount()
  return text
}

describe('the steward in the mod', () => {
  test('W1 nothing reaches the model: with no goal and with a stale brief, prompt.compose adds no section and no prompt is submitted', async ($, on) => {
    const { clock, submitted } = world(on)
    await startMod($)
    await reads($, 1)
    expect(await $.prompt.compose(RENDER)).toEqual({ sections: [INTRO] })
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'prove the steward' })
    await reads($, STALE_CALLS + 5)
    expect(await $.prompt.compose(RENDER)).toEqual({ sections: [INTRO] })
    await turnEnd($, ANSWER)
    await clock.advance(10_000)
    expect(submitted).toEqual([])
  })

  test('W2 the steward state key holds only briefAt and the activity counts: no nudge record', async ($, on) => {
    const { seen } = world(on)
    await startMod($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'prove the steward' })
    await reads($, 3)
    await $.prompt.compose(RENDER)
    const state = seen.value
    expect(Object.keys(state ?? {}).sort()).toEqual(['activity', 'briefAt'])
    expect(state?.briefAt).toBe(1_000)
    expect(state?.activity).toEqual(act({ toolCalls: 3 }))
  })

  test('W3 tool calls of a subagent are not counted', async ($, on) => {
    const { seen } = world(on)
    await startMod($)
    await reads($, STALE_CALLS + 5, 'a1')
    expect(seen.value?.activity).toEqual(zero)
  })

  test('W4 CCV3_MOD_STEWARD_OFF=1 stops the counting, read live: calls before the switch count, calls after it do not', async ($, on) => {
    const env: Record<string, string> = {}
    const { seen } = world(on, env)
    await startMod($)
    await reads($, 2)
    env.CCV3_MOD_STEWARD_OFF = '1'
    await reads($, STALE_CALLS)
    expect(seen.value?.activity.toolCalls).toBe(2)
  })

  test('W5 a brief_set restarts the counts and sets briefAt; the brief_set call itself is not work', async ($, on) => {
    const { clock, seen } = world(on)
    await startMod($)
    await reads($, 4)
    await clock.advance(500)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'prove the steward' })
    const state = seen.value
    expect(state?.activity).toEqual(zero)
    expect(state?.briefAt).toBe(1_500)
  })

  test('W6 a turn end that the parser merges does not restart the counts: 10 calls, a turn end, 10 calls is 20', async ($, on) => {
    const { clock, seen } = world(on)
    await startMod($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'prove the steward' })
    await reads($, 10)
    await clock.advance(1_000)
    await turnEnd($, ANSWER)
    await reads($, 10)
    const state = seen.value
    expect(state?.activity.toolCalls).toBe(20)
    expect(state?.briefAt).toBe(1_000)
  })

  test('W7 /clear resets the record', async ($, on) => {
    const { seen } = world(on)
    await startMod($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'prove the steward' })
    await reads($, 3)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    expect(seen.value).toEqual({ briefAt: null, activity: zero })
  })

  test('W8 the pane Overview WATCH line says the goal is not set while work started, is gone after a brief_set, comes back when stale, and is absent with the steward off', async ($, on) => {
    const UNSET = 'The session goal is not set yet, and work has started.'
    const STALE = `${STALE_CALLS} tool calls since the plan last changed.`
    const env: Record<string, string> = {}
    world(on, env)
    await startMod($)
    expect(await paneText($)).not.toContain(UNSET)
    await reads($, 1)
    expect(await paneText($)).toContain(UNSET)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'prove the steward' })
    const afterBrief = await paneText($)
    expect(afterBrief).not.toContain(UNSET)
    expect(afterBrief).not.toContain('since the plan last changed')
    await reads($, STALE_CALLS)
    expect(await paneText($)).toContain(STALE)
    env.CCV3_MOD_STEWARD_OFF = '1'
    const off = await paneText($)
    expect(off).not.toContain(STALE)
    expect(off).not.toContain(UNSET)
  })
})
