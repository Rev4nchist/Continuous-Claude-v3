import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { AgentRun } from '../../types'
import type { Span } from '../agentic-os/pane-model'
import { DIAG_DIR, errorFile, errorText } from '../shared/diag'
import { requestSnapshot } from '../shared/snapshot-port'
import { parseAgentSpec } from '../shared/tiers'
import { TONE } from '../shared/tones'
import { capRuns, ledgerRows, newRun, withSpec } from './model'

// Agent Ledger capture and the /ledger pane (`/agents` is a built-in: registering it is refused). A run's per-request tokens come from the turn.step hook in
// hooks/hud/index.ts, and its end from turn.complete in hooks/agentic-os/index.tsx: a plugin holds one
// unmatched hook per event, so those two hooks serve every module.

const agentRuns = atom({ plugin: 'ccv3-mods', key: 'agentRuns' } as const, [] as AgentRun[])
/** Bumped by the agentic-os pulse, so elapsed times redraw. */
const tick = atom({ plugin: 'ccv3-mods', key: 'tick' } as const, 0)

const PANE = 'ledger'

const isOff = async ($: EngineInterface): Promise<boolean> =>
  (await $.env.get('CCV3_MODS_OFF')) === '1' || (await $.env.get('CCV3_MOD_LEDGER_OFF')) === '1'

const homeDir = async ($: EngineInterface) => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

/** Leaves ~/.claude/state/ccv3-mods/errors/<time>-<where>.json, so a failure no one sees still says what broke. */
const noteError = async ($: EngineInterface, where: string, err: unknown) => {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (home) await $.fs.write(`${home}/${DIAG_DIR}/${errorFile(where)}`, errorText(where, err)).catch(() => undefined)
}

/** The agent's `model:` and `effort:`, from the project's .claude/agents first, then ~/.claude/agents. */
const specOf = async ($: EngineInterface, type: string): Promise<AgentRun['spec']> => {
  if (!/^[\w.-]+$/.test(type)) return {}
  const dirs = [`${await $.session.root().catch(() => '')}/.claude/agents`, `${(await homeDir($)) ?? ''}/.claude/agents`]
  for (const dir of dirs) {
    const path = `${dir}/${type}.md`
    if (dir.startsWith('/.claude') || !(await $.fs.exists(path).catch(() => false))) continue
    return parseAgentSpec(await $.fs.read(path).catch(() => ''))
  }
  return {}
}

/** Registers /ledger: at an interactive start, and when the desktop app attaches. */
const startUi = async ($: EngineInterface) => {
  if (await isOff($)) return
  await $.command
    .register({ name: 'ledger', description: 'Agent Ledger: each subagent this session, its tier, tokens and estimated cost' })
    .catch(err => noteError($, 'ledger-register', err))
}

export const agentLedger = (on: On) => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await startUi($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The desktop app drives Claude Code through the SDK: its sessions start headless and the desktop attaches later.
  on('session.attach', { surface: 'desktop' }, async ($, e, next) => {
    await startUi($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Observer: records a run once it started. Headless runs record too; the agentic-os snapshot carries
  // them whenever it writes one (see worthSnapshot there).
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || result.agentId === undefined || (await isOff($))) return result
    const id = result.agentId
    // Record first: the run's first request may finish before the spec file is read.
    const run = newRun(id, e.subagentType, e.description, result.model, {}, await $.clock.now(), e.tool_use_id, e.workflow?.runId)
    await update($, agentRuns, runs => capRuns([...runs.filter(one => one.id !== id), run]))
    const spec = await specOf($, e.subagentType)
    await update($, agentRuns, runs => runs.map(one => (one.id === id ? withSpec(one, spec) : one)))
    // Not awaited: the first spawn of a window must not wait for a file write (requestSnapshot never throws).
    void requestSnapshot($)
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'ledger' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Agents' })
    return { text: opened.isPlaced ? 'Agent Ledger opened.' : `Agent Ledger waits: ${opened.reason}` }
  }).catch(() => ({ text: 'Agent Ledger failed to open.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, tick)
    const { Box, Text } = $.ui.resolve(e)
    const line = (spans: Span[]) => (
      <Text wrap="truncate-end">
        {spans.map((span, i) => (
          <Text key={`s${i}`} {...TONE[span.tone]}>
            {span.text}
          </Text>
        ))}
      </Text>
    )
    const rows = ledgerRows(await read($, agentRuns), await $.clock.now(), e.props.bodyColumns - 2, e.props.scroll.bodyRows, e.props.scroll.offset)
    return (
      <Box flexDirection="column" paddingX={1}>
        {rows.map(row => (
          <Box key={`row-${row.key}`} flexDirection="row" justifyContent="space-between">
            {line(row.left)}
            {row.right ? line(row.right) : null}
          </Box>
        ))}
      </Box>
    )
  })
}
