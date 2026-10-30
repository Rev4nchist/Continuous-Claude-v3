import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

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

type Beneath = { spawnModel: string; agentId: string; deny?: string; usage: { input_tokens: number; output_tokens: number } | null; usageModel: string }
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
