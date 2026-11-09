import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { addStep, ledgerBandSpans, ledgerRows, newRun, summarize } from '../hooks/agent-ledger/model'
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

type Beneath = { spawnModel: string; agentId: string; deny?: string; usage: ({ input_tokens: number; output_tokens: number } & Record<string, unknown>) | null; usageModel: string }
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
const agentRunsOf = (writes: Record<string, string>): { id: string; workflowRunId?: string }[] =>
  (JSON.parse(writes['/home/me/.claude/state/agentic-os/s1.json'] ?? '{}') as { agentRuns?: { id: string; workflowRunId?: string }[] }).agentRuns ?? []

const step = async ($: Engine, agentId: string, model: string, effort: string | number, usage: Beneath['usage']) => {
  beneath.usage = usage
  beneath.usageModel = model
  const stream = $.turn.step({ turnId: 'sub', index: 0, messageCount: 1, model, effort, agentId } as never)
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
})
