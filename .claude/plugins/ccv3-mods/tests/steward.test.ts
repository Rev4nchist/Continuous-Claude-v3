import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { applyBrief, redact } from '../hooks/agentic-os/brief'
import type { Brief } from '../hooks/agentic-os/brief'
import {
  BLOCK_MAX,
  NUDGE_EVERY,
  STALE_CALLS,
  drift,
  instructBlock,
  nudgeLine,
  observe,
  shouldNudge,
  signalOf,
} from '../hooks/agentic-os/steward'
import type { Activity, Drift, NudgeGate } from '../hooks/agentic-os/steward'
import type { OsTask } from '../types'

// PR 4, the steward: the mod instructs the model (prompt.compose), watches the work (drift) and nudges.
// Ways it can fail, one test each. Dave, 2026-10-28: "the mod should also be instructing the system and watching the work".
// D0..D6  drift: a quiet session, no goal, the stale boundary, a commit / PR / run alone, a finished plan, a stable reason key
// S1..S9  signalOf: a real tool call is read as the wrong signal, or as none (commit with HEAD moved, PR, run, resume, lane, e2e file)
// O1..O2  observe: the call count or the signal count is off, or the old counts are mutated
// N1..N5  the nudge line, the 20-call rate limit, one nudge per reason, no nudge headless / in a subagent / switched off
// I1..I6  the instruct block: over 600 characters, missing the instruction, missing the current brief, a secret, the nudge cut off
// W1..W11 the wiring: a prompt.compose section on every render with byte-identical text until the brief or the nudge changes (a
//         changed text loses the prompt cache), the nudge line once, subagent calls not counted, never when switched off, nothing
//         headless unless opted in, and a parsed turn end does not restart the counts
// Review fixes (P1): a section that goes once toggles the system prompt twice per change; the turn-end parser bumps brief.updatedAt;
// a headless run would write one state file per run.
//
// Not tested here, on purpose: the dim `brief stale` marker next to GOAL (contract item 4). PR 3 edits band-model.ts and
// os-tabs-model.ts lines, so the display is left to a later PR.
//
// Reason identity (contract: "never twice for the same drift reason"): `Drift.key` is the level plus the brief version
// (`updatedAt`). It stays equal while the counts grow, so a drift that persists is not nudged again until the brief changes.

const NOW = 1_000_000
const secrets = { anthropic: 'sk-' + 'ant-' + 'a'.repeat(40) }

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
const task = (id: string, subject: string, status: OsTask['status']): OsTask => ({ id, subject, status })

const gate: NudgeGate = { headless: false, subagent: false, off: false }
const stale = (key = 'stale@1'): Drift => ({ level: 'stale', reason: '12 tool calls and 1 commit since the last update', key })

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

describe('nudge', () => {
  test('N1 the line reads "brief is stale: <what changed>; update it with brief_set" for each level, and ok has none', () => {
    expect(nudgeLine(stale())).toBe('brief is stale: 12 tool calls and 1 commit since the last update; update it with brief_set')
    expect(nudgeLine({ level: 'unset', reason: 'work started and no goal is set', key: 'unset@1' })).toBe(
      'brief is stale: work started and no goal is set; update it with brief_set',
    )
    expect(nudgeLine({ level: 'finished', reason: 'every plan step is done and work continues', key: 'finished@1' })).toBe(
      'brief is stale: every plan step is done and work continues; update it with brief_set',
    )
    expect(nudgeLine({ level: 'ok', reason: '', key: 'ok@1' })).toBeNull()
  })

  test('N2 the first nudge is allowed; an ok drift is never nudged', () => {
    expect(shouldNudge(stale(), { lastKey: null, callsSinceNudge: null }, gate)).toBe(true)
    expect(shouldNudge({ level: 'ok', reason: '', key: 'ok@1' }, { lastKey: null, callsSinceNudge: null }, gate)).toBe(false)
  })

  test('N3 a new reason is nudged after NUDGE_EVERY tool calls and not before (19 no, 20 yes)', () => {
    const prior = { lastKey: 'unset@1' }
    expect(NUDGE_EVERY).toBe(20)
    expect(shouldNudge(stale('stale@7'), { ...prior, callsSinceNudge: NUDGE_EVERY - 1 }, gate)).toBe(false)
    expect(shouldNudge(stale('stale@7'), { ...prior, callsSinceNudge: NUDGE_EVERY }, gate)).toBe(true)
  })

  test('N4 the same reason is never nudged twice, however many calls pass', () => {
    expect(shouldNudge(stale('stale@7'), { lastKey: 'stale@7', callsSinceNudge: 40 }, gate)).toBe(false)
    expect(shouldNudge(stale('stale@7'), { lastKey: 'stale@7', callsSinceNudge: 400 }, gate)).toBe(false)
  })

  test('N5 no nudge in a headless run, in a subagent, or with CCV3_MOD_STEWARD_OFF=1', () => {
    const fresh = { lastKey: null, callsSinceNudge: null }
    expect(shouldNudge(stale(), fresh, { ...gate, headless: true })).toBe(false)
    expect(shouldNudge(stale(), fresh, { ...gate, subagent: true })).toBe(false)
    expect(shouldNudge(stale(), fresh, { ...gate, off: true })).toBe(false)
  })
})

describe('instructBlock', () => {
  const maxBrief = (): Brief =>
    apply(null, {
      goal: 'G'.repeat(240),
      stopAt: 'S'.repeat(240),
      plan: Array.from({ length: 30 }, (_, i) => ({ id: `s${i + 1}`, text: 'T'.repeat(200), status: i < 15 ? 'done' : 'todo' })),
    })

  test('I1 the biggest brief the tool accepts still gives a block of at most 600 characters, with the instruction and the whole nudge in it', () => {
    const line = nudgeLine(stale()) ?? ''
    const plain = instructBlock(maxBrief(), [], null)
    const nudged = instructBlock(maxBrief(), [], line)
    expect(BLOCK_MAX).toBe(600)
    expect(plain.length).toBeLessThanOrEqual(BLOCK_MAX)
    expect(nudged.length).toBeLessThanOrEqual(BLOCK_MAX)
    expect(plain).toContain('brief_set')
    expect(nudged).toContain('brief_set')
    expect(nudged).toContain(line)
  })

  test('I2 the block teaches brief_set: it is deferred so load it first, restate the goal and stop point, record plan, proof and decisions', () => {
    const text = instructBlock(null, [], null)
    expect(text.length).toBeLessThanOrEqual(BLOCK_MAX)
    expect(text).toContain('brief_set')
    expect(text).toMatch(/deferred/i)
    expect(text).toMatch(/load/i)
    expect(text).toMatch(/restate/i)
    expect(text).toMatch(/stop point/i)
    expect(text).toMatch(/plan/i)
    expect(text).toMatch(/proof/i)
    expect(text).toMatch(/decision/i)
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('brief is stale')
  })

  test('I3 the block carries the current brief: the goal, plan done/total and the unproven count', () => {
    const base = planned(['done', 'done', 'doing', 'todo'])
    const brief = apply(base, { proof: { taskId: 's1', artifact: '.claude/cache/e2e/2026-10-28-steward-green.txt' } })
    const text = instructBlock(brief, [], null)
    expect(text).toContain('Ship the steward')
    expect(text).toMatch(/plan:? 2\/4/i)
    expect(text).toMatch(/unproven:? 1\b/i)
  })

  test('I4 the numbers follow the task list when one exists, as the pane does', () => {
    const brief = planned(['done'])
    const tasks = [
      task('1', 'a', 'completed'),
      task('2', 'b', 'completed'),
      task('3', 'c', 'completed'),
      task('4', 'd', 'in_progress'),
      task('5', 'e', 'pending'),
    ]
    const text = instructBlock(brief, tasks, null)
    expect(text).toMatch(/plan:? 3\/5/i)
    expect(text).toMatch(/unproven:? 3\b/i)
  })

  test('I5 a secret that reached the brief is redacted in the block', () => {
    const brief: Brief = { ...planned(['doing']), goal: `use ${secrets.anthropic}` }
    const text = instructBlock(brief, [], null)
    expect(text).not.toContain('aaaaaaaa')
    expect(text).toContain(redact(`use ${secrets.anthropic}`).text)
  })

  test('I6 the nudge line sits in the block exactly as given, once', () => {
    const line = nudgeLine(stale()) ?? ''
    const text = instructBlock(planned(['doing', 'todo']), [], line)
    expect(text.split(line).length - 1).toBe(1)
  })
})

// --- The wiring: the real mod, with the engine below it mocked. ---

const BRIEF_TOOL = 'mcp__ccv3-mods__brief_set'
const SECTION = 'ccv3-mods:steward'
/** The facts a render is composed from; the mod reads none of them. */
const RENDER = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as const

/** `env` is read live, so a test can flip a switch after the session started. */
const world = (on: On, env: Record<string, string> = {}) => {
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
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'the engine intro', scope: 'shared' }] }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text' } }) as never)
  return clock
}

const startMod = ($: Engine, isInteractive = true) => $.session.start({ cwd: 'C:/r', surface: isInteractive ? 'terminal' : null, isInteractive })
const section = async ($: Engine) => (await $.prompt.compose(RENDER)).sections.find(one => one.id === SECTION)
const reads = async ($: Engine, n: number, agentId?: string) => {
  for (let i = 0; i < n; i++) await $.tool.call({ tool: 'Read', file_path: `C:/r/f${i}.md`, ...(agentId ? { agentId } : {}) } as never)
}
/** An answer as CLAUDE.md asks for: it ends with a Next steps block, so the turn-end parser finds an ask in it. */
const ANSWER = ['Done.', '', '## Next steps', '1. Run the gate.', ''].join('\n')
const turnEnd =($: Engine, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never)
const stales = (text: string | undefined): number => ((text ?? '').match(/brief is stale:/g) ?? []).length

describe('the steward in the mod', () => {
  test('W1 the first prompt.compose of a session gets one session section that teaches brief_set and stays under 600 characters; the engine sections stay first', async ($, on) => {
    world(on)
    await startMod($)
    const all = (await $.prompt.compose(RENDER)).sections
    const mine = all.find(one => one.id === SECTION)
    expect(mine?.scope).toBe('session')
    expect(mine?.text.length).toBeLessThanOrEqual(BLOCK_MAX)
    expect(mine?.text).toContain('brief_set')
    expect(all[0]?.id).toBe('intro')
    expect(all.at(-1)?.id).toBe(SECTION)
  })

  test('W2 compose after compose with nothing changed returns the same section, byte for byte (a changed system prompt loses the cache)', async ($, on) => {
    world(on)
    await startMod($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'prove the steward' })
    const first = await section($)
    expect(first).toBeDefined()
    await reads($, 3)
    expect(await section($)).toEqual(first)
    expect(await section($)).toEqual(first)
  })

  test('W3 a brief_set that changes the brief brings the block back, carrying the new goal', async ($, on) => {
    world(on)
    await startMod($)
    await section($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'prove the steward' })
    const again = await section($)
    expect(again?.text).toContain('prove the steward')
  })

  test('W4 flipping CCV3_MOD_STEWARD_OFF=1 mid-session stops the block (read on every compose): a changed brief adds no section, and the engine sections stay as they were', async ($, on) => {
    const env: Record<string, string> = {}
    world(on, env)
    await startMod($)
    expect(await section($)).toBeDefined()
    env.CCV3_MOD_STEWARD_OFF = '1'
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'prove the steward' })
    await reads($, STALE_CALLS)
    expect((await $.prompt.compose(RENDER)).sections.map(one => one.id)).toEqual(['intro'])
  })

  test('W5 work with no goal gets one "no goal" nudge in the next block', async ($, on) => {
    world(on)
    await startMod($)
    await section($)
    await reads($, 1)
    const nudged = await section($)
    expect(stales(nudged?.text)).toBe(1)
    expect(nudged?.text).toMatch(/brief is stale: .*goal.*; update it with brief_set/i)
    const after = await section($)
    expect(after?.text).toContain('brief_set')
    expect(stales(after?.text)).toBe(0)
  })

  test('W6 STALE_CALLS tool calls after a brief_set give exactly one stale nudge; the compose after it keeps the section and drops the line; 5 more calls add none (rate limit, same reason)', async ($, on) => {
    world(on)
    await startMod($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'prove the steward' })
    await section($)
    await reads($, STALE_CALLS)
    const nudged = await section($)
    expect(stales(nudged?.text)).toBe(1)
    const after = await section($)
    expect(after?.text).toContain('brief_set')
    expect(stales(after?.text)).toBe(0)
    await reads($, 5)
    expect(stales((await section($))?.text)).toBe(0)
  })

  test('W7 a brief_set after the tool calls clears the drift: the block comes back with no nudge', async ($, on) => {
    world(on)
    await startMod($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'prove the steward' })
    await section($)
    await reads($, STALE_CALLS)
    await $.tool.call({ tool: BRIEF_TOOL, plan: [{ id: 'a', text: 'write the tests', status: 'doing' }] })
    const after = await section($)
    expect(after).toBeDefined()
    expect(stales(after?.text)).toBe(0)
  })

  test('W8 tool calls of a subagent do not count as the main session drifting: the section stays as it was', async ($, on) => {
    world(on)
    await startMod($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'prove the steward' })
    const before = await section($)
    expect(before).toBeDefined()
    await reads($, STALE_CALLS + 5, 'a1')
    expect(await section($)).toEqual(before)
  })

  test('W9 a headless run gets no block, so it is never told to call brief_set (and writes no state file for it)', async ($, on) => {
    world(on)
    await startMod($, false)
    expect(await section($)).toBeUndefined()
    await reads($, STALE_CALLS + 5)
    expect(await section($)).toBeUndefined()
  })

  test('W9b CCV3_MOD_STEWARD_HEADLESS=1 opts a headless run in: the block comes on every render and never a nudge', async ($, on) => {
    world(on, { CCV3_MOD_STEWARD_HEADLESS: '1' })
    await startMod($, false)
    const first = await section($)
    expect(first?.text).toContain('brief_set')
    expect(stales(first?.text)).toBe(0)
    await reads($, STALE_CALLS + 5)
    const later = await section($)
    expect(later?.text).toContain('brief_set')
    expect(stales(later?.text)).toBe(0)
  })

  test('W10 a turn end with a Next steps block does not restart the counts: 10 calls, a turn end, 10 calls is a stale nudge', async ($, on) => {
    const clock = world(on)
    await startMod($)
    await $.tool.call({ tool: BRIEF_TOOL, goal: 'prove the steward' })
    await section($)
    await reads($, 10)
    await clock.advance(1_000)
    await turnEnd($, ANSWER)
    await reads($, 10)
    expect(stales((await section($))?.text)).toBe(1)
  })

  test('W11 a turn end that the parser merges does not bring the "no goal" nudge back every 20 calls', async ($, on) => {
    const clock = world(on)
    await startMod($)
    await section($)
    await reads($, 1)
    expect(stales((await section($))?.text)).toBe(1)
    await clock.advance(1_000)
    await turnEnd($, ANSWER)
    await reads($, NUDGE_EVERY + 5)
    expect(stales((await section($))?.text)).toBe(0)
  })
})
