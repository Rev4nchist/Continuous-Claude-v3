import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { addStep, advisorCalls, ledgerBandSpans, ledgerRows, newRun, summarize } from '../hooks/agent-ledger/model'
import { REAL_USAGE } from './fixtures/ledger-real-usage'

// Ways the Agent Ledger can fail, one test each. Checks read the /ledger pane, the band or the snapshot.
// L1 a started subagent is not recorded (or a denied spawn is)
// L2 tokens from several requests don't add up, or cost shows before the run ends
// L3 a run off its agent's spec (spark: sonnet/high) is not flagged; one on spec is
// L4 a Haiku run with no spec file is not flagged
// L5 a failed or aborted run shows as done
// L6 a headless run records nothing (the snapshot is its only reader)
// L7 CCV3_MOD_LEDGER_OFF still records (also when steps arrive)
// L8 a teammate's second turn adds to a run that already shows done
// L9 a numeric effort (a thinking budget) is flagged as drift
// L10 a refusal shows as done
// L11 /os redesign: a spawn that a workflow started (workflow.runId) does not store workflowRunId on the run
// L12 an empty runId (outside a real run) or no workflow field stores a workflowRunId anyway (the key must be absent, as toolUseId is); a real runId beside them is lost
// PR C: the run's dollars price the whole usage of each request (hooks/shared/price.ts), not only its top-level tokens.
// L13 an advisor iteration is left out of the run's cost, or priced at the run's model instead of its own
// L14 web searches of a request are not counted in the run's cost
// L15 a 1-hour cache write is priced as a 5-minute write
// L16 an unknown model id shows as a plain $0 (nothing says "unpriced"), in the pane, the band or the summary
// L17 an advisor iteration on an unknown model is skipped without a flag; a <synthetic> or empty step raises the flag
// L18 a run saved before this change (no new fields) fails to price, or gets a flag key it never had
// L19 a negative, NaN or infinite count lowers the run's cost or tokens, or makes them NaN
// L20 a throw while pricing breaks the observer: the step is lost (tokens, model and effort not folded in)
// L21 real transcript usage (advisor iterations, a 5m/1h split with a remainder, 1-hour writes) prices off the figure of an independent recompute
// L22 a run's tokens leave out the advisor iterations that its dollars include (one row, two bases); a non-advisor, junk or negative entry adds tokens
// PR D: a run that used the advisor shows its dollars as a floor ("at least"): the live feed leaves the advisor's own tokens out.
// L23 an advisor use at turn.step does not mark the run (`advised`), or the pane keeps the plain estimate sign
// L24 the counts of several steps do not add up on the saved row (the Fleet app reads that row)
// L25 a non-advisor server tool, an empty list or no list marks the run (the key must stay absent, never 0)
// L26 a saved run with no `advised`, or a junk one (string, NaN, negative, infinite), gains a key or a floor label, or breaks summarize
// L27 an advisor use on a request with no usage (aborted) is lost, or adds cost or tokens
// L28 a step that arrives twice: pinned, both the cost and the advisor count add twice (the row holds no step id)
// L29 a main-loop advisor use marks a subagent run
// L30 a step for an agent with no run creates a run, or throws
// L31 a failed finish or a resume clears the mark
// L32 the floor label is missing on the total, the band, the run row and the foot note when a run is marked, or shows when none is
// L33 a marked run at $0 or unpriced reads a plain $0.00, a bare "unpriced" or a malformed text
// L34 a running run shows a dollar figure, so a floor label with it
// L35 a step that carries priced iterations AND an advisor use loses the label (pinned: the label follows the count, not the iterations)

const PANE_PROPS = {
  title: 'Agents',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

// Windows reports backslash paths with a drive letter; compare forward-slash paths without the drive.
const posix = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '')

const SPARK_MD = '---\nname: spark\nmodel: sonnet\neffort: high\n---\nbody\n'

type Beneath = { spawnModel: string; agentId: string; deny?: string; serverToolUses?: { name: string }[]; usage: ({ input_tokens: number; output_tokens: number } & Record<string, unknown>) | null; usageModel: string }
const beneath: Beneath = { spawnModel: 'claude-sonnet-5-5', agentId: 'a1', usage: null, usageModel: 'claude-sonnet-5-5' }

const world = (on: On, env: Record<string, string> = {}) => {
  const writes: Record<string, string> = {}
  mock.clock(on, { now: 1_000 })
  mock.env(on, { HOME: '/home/me', ...env })
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: {} }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', (_$, e) => ({ value: posix(e.path) === '/repo/.claude/agents/spark.md' }))
  on('fs.read', () => ({ value: SPARK_MD }))
  on('fs.write', (_$, e) => {
    writes[posix(e.path)] = e.text
    return { value: undefined }
  })
  on('agent.spawn', () => (beneath.deny ? { deny: beneath.deny } : { model: beneath.spawnModel, agentId: beneath.agentId }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      // As the engine reports them: absent when the request used no server tool.
      ...(beneath.serverToolUses === undefined ? {} : { serverToolUses: beneath.serverToolUses.map((use, i) => ({ id: `s${i}`, name: use.name, input: {}, startedAt: 1 })) }),
      stopReason: 'end_turn' as const,
      usage: beneath.usage === null ? null : { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...beneath.usage, model: beneath.usageModel },
    }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return writes
}

const start = ($: Engine, isInteractive = true) =>
  $.session.start({ cwd: '/repo', surface: isInteractive ? 'terminal' : null, isInteractive } as never)

const spawn = ($: Engine, subagentType: string) =>
  $.agent.spawn({ tool_use_id: 't', prompt: 'p', description: `do ${subagentType}`, subagentType, parentModel: 'claude-opus-5-5', background: false, fork: false } as never)

// A spawn with extra input fields, as a workflow script's agent() call raises it (`workflow: { runId, agentIndex }`).
const spawnIn = ($: Engine, subagentType: string, extra: Record<string, unknown>) =>
  $.agent.spawn({ tool_use_id: 't', prompt: 'p', description: `do ${subagentType}`, subagentType, parentModel: 'claude-opus-5-5', background: false, fork: false, ...extra } as never)

// The runs the headless snapshot carried at its last write.
type SavedRun = { id: string; workflowRunId?: string; advised?: number; costUsd?: number; tokens?: number; status?: string }
const agentRunsOf = (writes: Record<string, string>): SavedRun[] =>
  (JSON.parse(writes['/home/me/.claude/state/agentic-os/s1.json'] ?? '{}') as { agentRuns?: SavedRun[] }).agentRuns ?? []

const step = async ($: Engine, agentId: string | undefined, model: string, effort: string | number, usage: Beneath['usage'], serverToolUses?: { name: string }[]) => {
  beneath.usage = usage
  beneath.usageModel = model
  if (serverToolUses === undefined) delete beneath.serverToolUses
  else beneath.serverToolUses = serverToolUses
  const stream = $.turn.step({ turnId: 'sub', index: 0, messageCount: 1, model, effort, ...(agentId === undefined ? {} : { agentId }) } as never)
  for await (const _chunk of stream) {
    // drain
  }
  await stream.result
}

const finish = ($: Engine, agentId: string, reason = 'answer') =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: 'sub', agentId, reason } as never)

const paneText = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => {
  const pane = await $.ui.mount({ plugin: 'ccv3-mods', surface, component: 'Pane', requestId: 'ledger', props: PANE_PROPS, viewport: { columns: 80, rows: 40 } })
  const text = (await pane.findAll({ type: 'Box' })).filter(found => found.key?.startsWith('row-')).map(found => found.text).join('\n')
  await pane.unmount()
  return text
}

const reset = (over: Partial<Beneath> = {}) => {
  beneath.spawnModel = 'claude-sonnet-5-5'
  beneath.agentId = 'a1'
  delete beneath.deny
  delete beneath.serverToolUses
  Object.assign(beneath, over)
}

describe('agent ledger', () => {
  test('L1 a started run is recorded; a denied spawn is not', async ($, on) => {
    reset({ deny: 'no' })
    world(on)
    await start($)
    await spawn($, 'scout')
    expect(await paneText($)).toContain('No subagents yet')
    reset()
    await spawn($, 'scout')
    const text = await paneText($, 'desktop')
    expect(text).toContain('RUNNING · 1')
    expect(text).toContain('scout')
    expect(text).toContain('Sonnet')
  })

  test('L2 tokens add up across requests; cost settles at the end', async ($, on) => {
    reset()
    world(on)
    await start($)
    await spawn($, 'spark')
    await step($, 'a1', 'claude-sonnet-5-5', 'high', { input_tokens: 20_000, output_tokens: 0 })
    await step($, 'a1', 'claude-sonnet-5-5', 'high', { input_tokens: 18_000, output_tokens: 0 })
    let text = await paneText($)
    expect(text).toContain('38k tok')
    expect(text).toContain('settles at finish')
    await finish($, 'a1')
    text = await paneText($)
    expect(text).toContain('FINISHED · 1')
    expect(text).toContain('≈ $0.08')
  })

  test('L3 a run off its spec is flagged; on spec it is not', async ($, on) => {
    reset({ spawnModel: 'claude-opus-5-5' })
    world(on)
    await start($)
    await spawn($, 'spark')
    await step($, 'a1', 'claude-opus-5-5', 'medium', { input_tokens: 1000, output_tokens: 100 })
    expect(await paneText($)).toContain('Tier drift: expected Sonnet · high')
    reset({ agentId: 'a2' })
    await spawn($, 'spark')
    await step($, 'a2', 'claude-sonnet-5-5', 'high', { input_tokens: 1000, output_tokens: 100 })
    const text = await paneText($)
    expect(text.match(/Tier drift/g)?.length).toBe(1)
  })

  test('L4 a Haiku run is flagged with no spec file', async ($, on) => {
    reset({ spawnModel: 'claude-haiku-5-5' })
    world(on)
    await start($)
    await spawn($, 'general-purpose')
    expect(await paneText($)).toContain('Tier drift: Haiku is banned')
  })

  test('L5 an aborted run shows as failed', async ($, on) => {
    reset()
    world(on)
    await start($)
    await spawn($, 'scout')
    await finish($, 'a1', 'aborted')
    expect(await paneText($)).toContain('✗ scout')
  })

  test('L6 a headless run records, and the snapshot carries it', async ($, on) => {
    reset()
    const writes = world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'a' } } }))
    await start($, false)
    await spawn($, 'scout')
    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'd' })
    const snapshot = JSON.parse(writes['/home/me/.claude/state/agentic-os/s1.json'] ?? '{}') as { agentRuns?: { type: string }[] }
    expect(snapshot.agentRuns?.[0]?.type).toBe('scout')
  })

  test('L7 CCV3_MOD_LEDGER_OFF records nothing', async ($, on) => {
    reset()
    world(on, { CCV3_MOD_LEDGER_OFF: '1' })
    await start($)
    await spawn($, 'scout')
    await step($, 'a1', 'claude-sonnet-5-5', 'high', { input_tokens: 1000, output_tokens: 10 })
    expect(await paneText($)).toContain('No subagents yet')
  })

  test('L8 a teammate runs again after its turn.complete', async ($, on) => {
    reset()
    world(on)
    await start($)
    await spawn($, 'scout')
    await step($, 'a1', 'claude-sonnet-5-5', 'high', { input_tokens: 10_000, output_tokens: 0 })
    await finish($, 'a1')
    expect(await paneText($)).toContain('FINISHED · 1')
    await step($, 'a1', 'claude-sonnet-5-5', 'high', { input_tokens: 5_000, output_tokens: 0 })
    const text = await paneText($)
    expect(text).toContain('RUNNING · 1')
    expect(text).toContain('15k tok')
  })

  test('L9 a numeric effort is not drift', async ($, on) => {
    reset()
    world(on)
    await start($)
    await spawn($, 'spark')
    await step($, 'a1', 'claude-sonnet-5-5', 32000, { input_tokens: 1000, output_tokens: 10 })
    const text = await paneText($)
    expect(text).not.toContain('Tier drift')
    expect(text).not.toContain('32000')
  })

  test('L10 a refusal shows as failed', async ($, on) => {
    reset()
    world(on)
    await start($)
    await spawn($, 'scout')
    await finish($, 'a1', 'refusal')
    expect(await paneText($)).toContain('✗ scout')
  })

  test('L11 a spawn that a workflow started stores the workflow run id on the run', async ($, on) => {
    reset()
    const writes = world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'a' } } }))
    await start($, false)
    await spawnIn($, 'scout', { workflow: { runId: 'wf_1', agentIndex: 1 } })
    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'd' })
    const runs = agentRunsOf(writes)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.workflowRunId).toBe('wf_1')
  })

  test('L13 an advisor iteration is priced at its own model and added to the run', async ($, on) => {
    reset()
    world(on)
    await start($)
    await spawn($, 'spark')
    await step($, 'a1', 'claude-sonnet-5-5', 'high', {
      input_tokens: 100_000,
      output_tokens: 0,
      iterations: [
        { type: 'advisor_message', model: 'claude-fable-5-1', input_tokens: 100_000, output_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 50_000, output_tokens: 5_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        // Not an advisor entry: the engine's own top-level usage already holds it.
        { type: 'message', model: 'claude-opus-5-5', input_tokens: 1_000_000, output_tokens: 0 },
      ],
    })
    await finish($, 'a1')
    // Sonnet 100k in $0.20 + Fable 100k in / 10k out $1.50 + Opus 50k in / 5k out $0.30.
    expect(await paneText($)).toContain('≈ $2.00')
  })

  test('L14 web searches are counted at $0.01 each', async ($, on) => {
    reset()
    world(on)
    await start($)
    await spawn($, 'spark')
    await step($, 'a1', 'claude-sonnet-5-5', 'high', { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 100 } })
    await finish($, 'a1')
    expect(await paneText($)).toContain('≈ $1.00')
  })

  test('L15 a 1-hour cache write is priced at the 1-hour rate', async ($, on) => {
    reset()
    world(on)
    await start($)
    await spawn($, 'spark')
    await step($, 'a1', 'claude-sonnet-5-5', 'high', {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
    })
    await finish($, 'a1')
    // Sonnet 5.5: $4.00 per million at 1 hour, $2.50 at 5 minutes.
    expect(await paneText($)).toContain('≈ $4.00')
  })

  test('L16 an unknown model id is flagged as unpriced, apart from a real $0', async ($, on) => {
    reset({ spawnModel: 'claude-future-9' })
    world(on)
    await start($)
    await spawn($, 'spark')
    await step($, 'a1', 'claude-future-9', 'high', { input_tokens: 1_000_000, output_tokens: 1_000 })
    await finish($, 'a1')
    const text = await paneText($)
    expect(text).toContain('unpriced')
    expect(text).not.toContain('≈ $0.00')
    // The summary and the band carry it too.
    let run = newRun('r1', 'scout', 'd', 'claude-future-9', {}, 0)
    run = addStep(run, { model: 'claude-future-9', effort: 'high', usage: { input_tokens: 1_000_000, output_tokens: 1_000 } })
    expect(run.costUsd).toBe(0)
    expect(run.hasUnknownModelCost).toBe(true)
    expect(summarize([run]).hasUnknownModelCost).toBe(true)
    expect(JSON.stringify(ledgerBandSpans([run]))).toContain('unpriced')
    expect(JSON.stringify(ledgerRows([run], 1_000, 80, 20))).toContain('unpriced')
    // A run on a priced model beside it is not flagged.
    const known = addStep(newRun('r2', 'scout', 'd', 'claude-sonnet-5-5', {}, 0), { model: 'claude-sonnet-5-5', effort: 'high', usage: { input_tokens: 1_000_000, output_tokens: 0 } })
    expect(known.hasUnknownModelCost).toBeUndefined()
    expect(summarize([known]).hasUnknownModelCost).toBe(false)
    expect(JSON.stringify(ledgerBandSpans([known]))).not.toContain('unpriced')
  })

  test('L17 an advisor iteration on an unknown model raises the flag; a synthetic or empty step does not', () => {
    const base = newRun('r1', 'scout', 'd', 'claude-sonnet-5-5', {}, 0)
    const advised = addStep(base, {
      model: 'claude-sonnet-5-5',
      effort: 'high',
      usage: { input_tokens: 100_000, output_tokens: 0, iterations: [{ type: 'advisor_message', model: 'claude-future-9', input_tokens: 5_000, output_tokens: 500 }] } as never,
    })
    expect(advised.hasUnknownModelCost).toBe(true)
    // The priced part still counts: Sonnet 100k in.
    expect(Math.abs(advised.costUsd - 0.2)).toBeLessThan(1e-9)
    const synthetic = addStep(base, { model: '<synthetic>', effort: null, usage: { input_tokens: 0, output_tokens: 0 } })
    expect(synthetic.hasUnknownModelCost).toBeUndefined()
    expect(addStep(base, { model: 'claude-future-9', effort: null, usage: null }).hasUnknownModelCost).toBeUndefined()
  })

  test('L18 a run saved before this change still prices and gains no flag key', () => {
    // The shape a state file from before PR C holds: no hasUnknownModelCost.
    const saved = JSON.parse(JSON.stringify(newRun('old', 'scout', 'd', 'claude-sonnet-5-5', { model: 'sonnet' }, 5))) as ReturnType<typeof newRun>
    saved.costUsd = 0.25
    saved.tokens = 1_000
    const next = addStep(saved, { model: 'claude-sonnet-5-5', effort: 'high', usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 } })
    // 0.25 kept; Sonnet 5.5 1M in $2.00 + 1M cache read $0.10.
    expect(Math.abs(next.costUsd - 2.35)).toBeLessThan(1e-9)
    expect(next.tokens).toBe(2_001_000)
    expect('hasUnknownModelCost' in next).toBe(false)
    expect(summarize([saved, next]).hasUnknownModelCost).toBe(false)
  })

  test('L19 a negative, NaN or infinite count adds nothing and never turns the run into NaN', () => {
    const base = newRun('r1', 'scout', 'd', 'claude-sonnet-5-5', {}, 0)
    const odd = addStep(base, {
      model: 'claude-sonnet-5-5',
      effort: 'high',
      usage: {
        input_tokens: Number.NaN,
        output_tokens: -5_000,
        cache_read_input_tokens: Number.POSITIVE_INFINITY,
        cache_creation_input_tokens: -1,
        server_tool_use: { web_search_requests: -3 },
        iterations: [{ type: 'advisor_message', model: 'claude-fable-5-1', input_tokens: -1, output_tokens: Number.NaN }, null, 7, 'x'],
      } as never,
    })
    expect(Number.isFinite(odd.costUsd)).toBe(true)
    expect(odd.costUsd).toBe(0)
    expect(Number.isFinite(odd.tokens)).toBe(true)
    expect(odd.tokens).toBe(0)
    // A later good step still adds on top.
    const later = addStep(odd, { model: 'claude-sonnet-5-5', effort: 'high', usage: { input_tokens: 1_000_000, output_tokens: 0 } })
    expect(Math.abs(later.costUsd - 2)).toBeLessThan(1e-9)
    expect(later.tokens).toBe(1_000_000)
  })

  test('L20 a throw while pricing keeps the step: tokens, model and effort fold in, the cost is flagged unpriced', () => {
    const base = newRun('r1', 'scout', 'd', 'claude-sonnet-5-5', {}, 0)
    const usage = { input_tokens: 10_000, output_tokens: 0 }
    Object.defineProperty(usage, 'cache_creation', {
      enumerable: true,
      get: () => {
        throw new Error('boom')
      },
    })
    const next = addStep(base, { model: 'claude-sonnet-5-5', effort: 'medium', usage: usage as never })
    expect(next.tokens).toBe(10_000)
    expect(next.effort).toBe('medium')
    expect(next.costUsd).toBe(0)
    expect(next.hasUnknownModelCost).toBe(true)
  })

  test('L21 real subagent and main-loop usage prices to the independent recompute, through the engine', async ($, on) => {
    reset()
    const writes = world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'a' } } }))
    await start($, false)
    const { runA, runB, expected } = REAL_USAGE
    const plan: [string, typeof runA.steps][] = [
      ['a1', runA.steps],
      ['a2', runB.steps],
      ['a3', [...runA.steps, ...runB.steps]],
    ]
    for (const [id, steps] of plan) {
      reset({ agentId: id })
      await spawn($, 'spark')
      for (const s of steps) await step($, id, s.model, s.effort ?? 'high', s.usage as never)
    }
    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'd' })
    const runs = (JSON.parse(writes['/home/me/.claude/state/agentic-os/s1.json'] ?? '{}') as { agentRuns?: { id: string; costUsd: number }[] }).agentRuns ?? []
    const costOf = (id: string) => runs.find(run => run.id === id)?.costUsd ?? Number.NaN
    // The recompute sums the same records apart from price.ts: a tier-rate or advisor-less run is off by far more than a cent.
    expect(Math.abs(costOf('a1') - expected.runA.usd)).toBeLessThan(1e-6)
    expect(Math.abs(costOf('a2') - expected.runB.usd)).toBeLessThan(1e-6)
    expect(Math.abs(costOf('a3') - expected.runAB.usd)).toBeLessThan(1e-6)
    // The advisor part is a real share of run A.
    expect(expected.runA.advisorUsd).toBeGreaterThan(0.5)
  })

  test('L22 a run counts advisor iteration tokens with the top-level ones, as its dollars do', async ($, on) => {
    reset()
    world(on)
    await start($)
    await spawn($, 'spark')
    await step($, 'a1', 'claude-sonnet-5-5', 'high', {
      input_tokens: 100_000,
      output_tokens: 0,
      iterations: [
        { type: 'advisor_message', model: 'claude-fable-5-1', input_tokens: 100_000, output_tokens: 10_000, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 2_000 },
        // Not an advisor entry, junk and a bad count: none adds tokens, and the bad count does not lower the sum.
        { type: 'message', model: 'claude-opus-5-5', input_tokens: 1_000_000, output_tokens: 0 },
        null,
        'x',
        { type: 'advisor_message', model: 'claude-fable-5-1', input_tokens: -50, output_tokens: Number.NaN },
      ],
    })
    await finish($, 'a1')
    // 100k top level + (100k + 10k + 5k + 2k) advisor = 217k.
    expect(await paneText($)).toContain('217k tok')
    const base = newRun('r1', 'scout', 'd', 'claude-sonnet-5-5', {}, 0)
    expect(addStep(base, { model: 'claude-sonnet-5-5', effort: null, usage: { input_tokens: 10, output_tokens: 5, iterations: 'junk' } }).tokens).toBe(15)
    const advisor = { type: 'advisor_message', model: 'claude-fable-5-1', input_tokens: 7, output_tokens: 3 }
    expect(addStep(base, { model: 'claude-sonnet-5-5', effort: null, usage: { input_tokens: 10, output_tokens: 5, iterations: [advisor] } }).tokens).toBe(25)
  })

  const ADVISOR = [{ name: 'advisor' }]
  const SONNET_USAGE = { input_tokens: 100_000, output_tokens: 0 }

  // A headless world: the snapshot is the reader, and one TaskCreate makes it write.
  const headless = async ($: Engine, on: On) => {
    const writes = world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'a' } } }))
    await start($, false)
    return async () => {
      await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'd' })
      return agentRunsOf(writes)
    }
  }

  test('L23 an advisor use at turn.step marks the run and the pane shows a floor, not an estimate', async ($, on) => {
    reset()
    world(on)
    await start($)
    await spawn($, 'spark')
    await step($, 'a1', 'claude-sonnet-5-5', 'high', SONNET_USAGE, ADVISOR)
    await finish($, 'a1')
    const text = await paneText($)
    expect(text).toContain('≥ $0.20')
    expect(text).not.toContain('≈')
  })

  test('L24 the advisor counts of several steps add up on the saved row', async ($, on) => {
    reset()
    const read = await headless($, on)
    await spawn($, 'spark')
    await step($, 'a1', 'claude-sonnet-5-5', 'high', SONNET_USAGE, ADVISOR)
    await step($, 'a1', 'claude-sonnet-5-5', 'high', SONNET_USAGE, [...ADVISOR, ...ADVISOR])
    const runs = await read()
    expect(runs[0]?.advised).toBe(3)
    // The same steps still add their own dollars: 2 x Sonnet 100k in.
    expect(Math.abs((runs[0]?.costUsd ?? 0) - 0.4)).toBeLessThan(1e-9)
  })

  test('L25 a non-advisor server tool, an empty list and no list leave the key absent', async ($, on) => {
    reset()
    const read = await headless($, on)
    const cases: [string, { name: string }[] | undefined][] = [
      ['a1', [{ name: 'web_search' }]],
      ['a2', []],
      ['a3', undefined],
      // One mixed list: only the advisor entry counts.
      ['a4', [{ name: 'web_search' }, { name: 'advisor' }]],
    ]
    for (const [id, tools] of cases) {
      reset({ agentId: id })
      await spawn($, 'spark')
      await step($, id, 'claude-sonnet-5-5', 'high', SONNET_USAGE, tools)
    }
    const runs = await read()
    expect(runs.map(run => run.id)).toEqual(['a1', 'a2', 'a3', 'a4'])
    for (const run of runs.slice(0, 3)) expect('advised' in run).toBe(false)
    expect(runs[3]?.advised).toBe(1)
  })

  test('L26 a saved run with no mark, or a junk one, keeps its shape and shows no floor', () => {
    const old = JSON.parse(JSON.stringify(newRun('old', 'scout', 'd', 'claude-sonnet-5-5', {}, 5))) as ReturnType<typeof newRun>
    const next = addStep(old, { model: 'claude-sonnet-5-5', effort: 'high', usage: SONNET_USAGE })
    expect('advised' in next).toBe(false)
    expect(summarize([old, next]).advised).toBe(false)
    expect('advised' in addStep(old, { model: 'claude-sonnet-5-5', effort: 'high', usage: SONNET_USAGE, advised: 0 })).toBe(false)
    for (const junk of ['2', Number.NaN, -1, Number.POSITIVE_INFINITY, null, {}, [], true]) {
      const saved = { ...old, advised: junk } as never as ReturnType<typeof newRun>
      expect(summarize([saved]).advised).toBe(false)
      expect(JSON.stringify(ledgerRows([saved], 1_000, 80, 20))).not.toContain('≥')
      // A junk count adds nothing: one real use afterwards counts as one.
      expect(addStep(saved, { model: 'claude-sonnet-5-5', effort: 'high', usage: SONNET_USAGE, advised: 1 }).advised).toBe(1)
      // A junk step count adds nothing either.
      expect(summarize([addStep(old, { model: 'claude-sonnet-5-5', effort: 'high', usage: SONNET_USAGE, advised: junk as never })]).advised).toBe(false)
    }
  })

  test('L27 an advisor use on a request with no usage counts, and adds no cost or tokens', () => {
    const base = addStep(newRun('r1', 'scout', 'd', 'claude-sonnet-5-5', {}, 0), { model: 'claude-sonnet-5-5', effort: 'high', usage: SONNET_USAGE })
    const next = addStep(base, { model: 'claude-sonnet-5-5', effort: 'high', usage: null, advised: 2 })
    expect(next.advised).toBe(2)
    expect(next.costUsd).toBe(base.costUsd)
    expect(next.tokens).toBe(base.tokens)
  })

  test('L27b the same through the engine: an aborted request with an advisor use is counted', async ($, on) => {
    reset()
    const read = await headless($, on)
    await spawn($, 'spark')
    await step($, 'a1', 'claude-sonnet-5-5', 'high', null, ADVISOR)
    const runs = await read()
    expect(runs[0]?.advised).toBe(1)
    expect(runs[0]?.costUsd).toBe(0)
    expect(runs[0]?.tokens).toBe(0)
  })

  test('L28 a step that arrives twice counts twice for the cost and for the advisor (pinned: the row holds no step id)', async ($, on) => {
    reset()
    const read = await headless($, on)
    await spawn($, 'spark')
    await step($, 'a1', 'claude-sonnet-5-5', 'high', SONNET_USAGE, ADVISOR)
    await step($, 'a1', 'claude-sonnet-5-5', 'high', SONNET_USAGE, ADVISOR)
    const run = (await read())[0]
    expect(run?.advised).toBe(2)
    expect(Math.abs((run?.costUsd ?? 0) - 0.4)).toBeLessThan(1e-9)
  })

  test('L29 a main-loop advisor use marks no subagent run', async ($, on) => {
    reset()
    const read = await headless($, on)
    await spawn($, 'spark')
    await step($, undefined, 'claude-opus-5-5', 'high', SONNET_USAGE, ADVISOR)
    await step($, 'a1', 'claude-sonnet-5-5', 'high', SONNET_USAGE)
    const runs = await read()
    expect(runs).toHaveLength(1)
    expect('advised' in (runs[0] ?? {})).toBe(false)
  })

  test('L30 a step for an agent with no run creates no run and does not throw', async ($, on) => {
    reset()
    const read = await headless($, on)
    await step($, 'ghost', 'claude-sonnet-5-5', 'high', SONNET_USAGE, ADVISOR)
    expect(await read()).toEqual([])
  })

  test('L31 a failed finish and a resume keep the mark', async ($, on) => {
    reset()
    on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
    const read = await headless($, on)
    await spawn($, 'spark')
    await step($, 'a1', 'claude-sonnet-5-5', 'high', SONNET_USAGE, ADVISOR)
    await finish($, 'a1', 'aborted')
    expect((await read())[0]).toMatchObject({ status: 'failed', advised: 1 })
    // A message resumes the agent under the same id.
    await $.turn.start({ turnId: 'sub', agentId: 'a1' } as never)
    expect((await read())[0]).toMatchObject({ status: 'running', advised: 1 })
    await step($, 'a1', 'claude-sonnet-5-5', 'high', SONNET_USAGE)
    await finish($, 'a1')
    expect((await read())[0]).toMatchObject({ status: 'done', advised: 1 })
  })

  test('L32 a marked run puts the floor on the total, the band, its own row and a foot note; none marked changes nothing', () => {
    type Run = ReturnType<typeof newRun>
    const plain = addStep(newRun('p', 'scout', 'plain', 'claude-sonnet-5-5', {}, 0), { model: 'claude-sonnet-5-5', effort: 'high', usage: SONNET_USAGE })
    const marked = addStep(newRun('m', 'scout', 'marked', 'claude-sonnet-5-5', {}, 0), { model: 'claude-sonnet-5-5', effort: 'high', usage: SONNET_USAGE, advised: 1 })
    const done = (run: Run): Run => ({ ...run, status: 'done', endedAt: 10 })
    const rowsText = (runs: Run[]) => ledgerRows(runs, 1_000, 100, 40).map(row => ({ key: row.key, text: JSON.stringify(row) }))
    // Nothing marked: the strings of today, byte for byte.
    expect(JSON.stringify(ledgerBandSpans([done(plain)]))).toContain('◉ 1 agents · ≈$0.20')
    const none = rowsText([done(plain)])
    expect(none.find(row => row.key === 'title')?.text).toContain('≈ $0.20')
    expect(none.map(row => row.text).join('')).not.toContain('≥')
    expect(none.find(row => row.key === 'foot')?.text).toContain('Estimate from token counts, not your bill. Session total: HUD.')
    expect(none.some(row => row.key === 'foot-floor')).toBe(false)
    // One marked beside one plain.
    expect(JSON.stringify(ledgerBandSpans([done(plain), done(marked)]))).toContain('◉ 2 agents · ≥$0.40')
    const both = rowsText([done(plain), done(marked)])
    expect(both.find(row => row.key === 'title')?.text).toContain('≥ $0.40')
    expect(both.find(row => row.key === 'run-m-meta')?.text).toContain('≥ $0.20')
    expect(both.find(row => row.key === 'run-p-meta')?.text).toContain('≈ $0.20')
    expect(both.find(row => row.key === 'run-p-meta')?.text).not.toContain('≥')
    expect(both.find(row => row.key === 'foot-floor')?.text).toContain('At least')
  })

  test('L33 a marked run at $0 or unpriced keeps the floor and stays well formed', () => {
    type Run = ReturnType<typeof newRun>
    const zero = addStep(newRun('z', 'scout', 'd', 'claude-sonnet-5-5', {}, 0), { model: 'claude-sonnet-5-5', effort: 'high', usage: null, advised: 1 })
    const unpriced = addStep(newRun('u', 'scout', 'd', 'claude-future-9', {}, 0), { model: 'claude-future-9', effort: 'high', usage: { input_tokens: 1_000, output_tokens: 10 }, advised: 1 })
    const priced = addStep(newRun('q', 'scout', 'd', 'claude-sonnet-5-5', {}, 0), { model: 'claude-sonnet-5-5', effort: 'high', usage: SONNET_USAGE })
    const title = (runs: Run[]) => JSON.stringify(ledgerRows(runs, 1_000, 100, 40).find(row => row.key === 'title'))
    expect(title([zero])).toContain('≥ $0.00')
    expect(title([zero])).not.toContain('≈')
    expect(JSON.stringify(ledgerBandSpans([zero]))).toContain('≥$0.00')
    // Unpriced only: the floor still says "at least $0.00", then the unpriced note.
    expect(title([unpriced])).toContain('≥ $0.00 + unpriced')
    expect(JSON.stringify(ledgerBandSpans([unpriced]))).toContain('≥$0.00 + unpriced')
    // Priced dollars beside an unpriced run.
    expect(title([priced, unpriced])).toContain('≥ $0.20 + unpriced')
    // An unpriced run that is not marked keeps the bare word (L16).
    const bare: Run = { ...unpriced }
    delete bare.advised
    expect(title([bare])).toContain('unpriced')
    expect(title([bare])).not.toContain('≥')
  })

  test('L34 a running run shows no dollar, so no floor on its row; the total still carries it', async ($, on) => {
    reset()
    world(on)
    await start($)
    await spawn($, 'spark')
    await step($, 'a1', 'claude-sonnet-5-5', 'high', SONNET_USAGE, ADVISOR)
    const text = await paneText($)
    expect(text).toContain('settles at finish')
    expect(text).toContain('≥ $0.20')
    expect(text.match(/≥/g)?.length).toBe(1)
  })

  test('L35 priced advisor iterations beside an advisor use: the dollars stay exact and the label stays', async ($, on) => {
    reset()
    world(on)
    await start($)
    await spawn($, 'spark')
    await step(
      $, 'a1', 'claude-sonnet-5-5', 'high',
      {
        input_tokens: 100_000,
        output_tokens: 0,
        iterations: [{ type: 'advisor_message', model: 'claude-fable-5-1', input_tokens: 100_000, output_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
      },
      ADVISOR,
    )
    await finish($, 'a1')
    // Sonnet 100k in $0.20 + Fable 100k in / 10k out $1.50 (L13): exact, yet marked.
    expect(await paneText($)).toContain('≥ $1.70')
  })

  test('L12 an empty run id, and a spawn with no workflow, store no workflow run id; a real one beside them is stored', async ($, on) => {
    reset()
    const writes = world(on)
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'a' } } }))
    await start($, false)
    await spawnIn($, 'scout', { workflow: { runId: '', agentIndex: 1 } })
    reset({ agentId: 'a2' })
    await spawn($, 'scout')
    reset({ agentId: 'a3' })
    await spawnIn($, 'scout', { workflow: { runId: 'wf_2', agentIndex: 2 } })
    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'd' })
    const runs = agentRunsOf(writes)
    expect(runs.map(run => run.id)).toEqual(['a1', 'a2', 'a3'])
    expect('workflowRunId' in (runs[0] ?? {})).toBe(false)
    expect('workflowRunId' in (runs[1] ?? {})).toBe(false)
    expect(runs[2]?.workflowRunId).toBe('wf_2')
  })

  test('L36 a serverToolUses list that is not an array, or holds a null entry, counts only the advisor entries and never throws', () => {
    expect(advisorCalls(undefined)).toBe(0)
    expect(advisorCalls('advisor')).toBe(0)
    expect(advisorCalls({ name: 'advisor' })).toBe(0)
    expect(advisorCalls([null, { name: 'web_search' }, { name: 'advisor' }, 3, { name: 'advisor' }])).toBe(2)
  })
})
