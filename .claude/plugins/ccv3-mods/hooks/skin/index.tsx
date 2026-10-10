import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { AgentRun, ToolTime } from '../../types'
import { DIAG_DIR, errorFile, errorText, isDesktop } from '../shared/diag'
import { ICON_GLYPH, iconSvg } from '../shared/glyphs'
import { tierBadge } from '../shared/tiers'
import { TONE } from '../shared/tones'
import { tierTone } from '../agent-ledger/model'
import { SKIN_TOOLS, diffLines, fmtMs, groupSummary, hunksOf, mainArg } from './model'

// CCv3 Skin: tool rows with icons, timings and tier badges, collapsed groups as one line, edits as diff
// cards. Desktop app only (the terminal keeps the engine's rows). OFF by default (it replaces how the app draws every tool call); `/skin on` turns it on and
// $.store keeps the choice across sessions. Any tool it doesn't know, or any error, draws the engine's own.

const skinOn = atom({ plugin: 'ccv3-mods', key: 'skinOn' } as const, false)
/** Written by the agentic-os tool.call hook (the plugin's one unmatched tool.call hook). */
const toolTimes = atom({ plugin: 'ccv3-mods', key: 'toolTimes' } as const, {} as Record<string, ToolTime>)
const agentRuns = atom({ plugin: 'ccv3-mods', key: 'agentRuns' } as const, [] as AgentRun[])

const STORE_KEY = 'skin'

const isOff = async ($: EngineInterface): Promise<boolean> =>
  (await $.env.get('CCV3_MODS_OFF')) === '1' || (await $.env.get('CCV3_MOD_SKIN_OFF')) === '1'

/** Svg can't read theme keys: one icon colour per tool family. */
const ICON_HEX: Record<string, string> = { edit: '#D97757', agent: '#5B8FD9', advisor: '#8A74D6', shell: '#C9922E' }

/** Skin on, not switched off, and drawing in the desktop app. */
const active = async ($: EngineInterface, surface: string): Promise<boolean> =>
  isDesktop(surface, await $.env.get('CCV3_FORCE_SURFACE')) && (await read($, skinOn)) && !(await isOff($))

/** Leaves ~/.claude/state/ccv3-mods/errors/<time>-<where>.json, so a failure no one sees still says what broke. */
const noteError = async ($: EngineInterface, where: string, err: unknown) => {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (home) await $.fs.write(`${home}/${DIAG_DIR}/${errorFile(where)}`, errorText(where, err)).catch(() => undefined)
}

export const skin = (on: On) => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    if ((await isOff($)) || !isDesktop(e.surface, await $.env.get('CCV3_FORCE_SURFACE'))) return next(e)
    await $.command
      .register({ name: 'skin', description: 'CCv3 Skin: /skin on, /skin off (remembered across sessions)', argumentHint: 'on|off' })
      .catch(err => noteError($, 'skin-register', err))
    const saved = await $.store.get(STORE_KEY).catch(() => undefined)
    await update($, skinOn, () => saved === 'on')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'skin' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== '' && arg !== 'on' && arg !== 'off') return { text: 'Usage: /skin on, /skin off, or /skin to toggle.' }
    const want = arg === 'on' ? true : arg === 'off' ? false : !(await read($, skinOn))
    await update($, skinOn, () => want)
    await $.store.set(STORE_KEY, want ? 'on' : 'off')
    return { text: want ? 'CCv3 Skin on. /skin off to go back to the default rows.' : 'CCv3 Skin off.' }
  }).catch(() => ({ text: 'CCv3 Skin could not change.' }))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await active($, e.surface))) return next(e)
    const p = e.props
    const icon = SKIN_TOOLS[p.tool]
    // A row that carries its own output (an expanded group, verbose mode) keeps the engine's row:
    // the skin's row would hide that output, error text included.
    if (icon === undefined || p.output !== undefined) return next(e)
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const input = (p.input ?? {}) as Record<string, unknown>
    const time = (await read($, toolTimes))[p.tool_use_id]
    const run = icon === 'agent' ? (await read($, agentRuns)).find(one => one.toolUseId === p.tool_use_id) : undefined
    const chip = p.isErrored
      ? { text: time?.ms ? `error · ${fmtMs(time.ms)}` : 'error', tone: 'bad' as const }
      : p.isInterrupted
        ? { text: 'interrupted', tone: 'warn' as const }
        : p.isRunning
          ? { text: 'running', tone: 'active' as const }
          : { text: time?.ms === null || time === undefined ? '' : fmtMs(time.ms), tone: 'dim' as const }
    const color = p.isErrored ? '#D9534F' : (ICON_HEX[icon] ?? '#8A867D')
    const glyph =
      e.surface !== 'terminal' && 'Svg' in elements ? (
        <elements.Svg source={iconSvg(icon, color)} alt={p.tool} width={14} height={14} />
      ) : (
        <Text {...TONE[p.isErrored ? 'bad' : 'dim']}>{ICON_GLYPH[icon]}</Text>
      )
    return (
      <Box key="skin-row" flexDirection="row" gap={1} borderStyle="round" borderColor={p.isErrored ? 'error' : 'subtle'} paddingX={1}>
        {glyph}
        <Text bold>{p.tool}</Text>
        <Box flexGrow={1}>
          <Text wrap="truncate-end" {...TONE.dim}>
            {mainArg(p.tool, input)}
          </Text>
        </Box>
        {run?.model ? (
          <Text {...TONE[run.drift ? 'bad' : tierTone(run.model)]}>{` ${tierBadge(run.model, run.effort ?? undefined)} `}</Text>
        ) : null}
        {chip.text ? <Text {...TONE[chip.tone]}>{chip.text}</Text> : null}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await active($, e.surface)) || e.props.isExpanded) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="skin-group" flexDirection="row" gap={1} borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text {...TONE.dim}>▸</Text>
        <Text bold>{groupSummary(e.props.calls)}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await active($, e.surface)) || e.props.isErrored) return next(e)
    if (e.props.tool !== 'Edit' && e.props.tool !== 'Write' && e.props.tool !== 'MultiEdit') return next(e)
    // A staged edit was held for review, not applied: the engine says so better than a diff would.
    if ((e.props.output as { staged?: unknown } | null)?.staged === true) return next(e)
    const hunks = hunksOf(e.props.output)
    if (hunks === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const { lines, added, removed } = diffLines(hunks)
    const width = Math.max(2, ...lines.map(line => line.number.length))
    return (
      <Box key="skin-diff" flexDirection="column" borderStyle="round" borderColor="subtle">
        <Box flexDirection="row" justifyContent="flex-end" gap={1} paddingX={1}>
          <Text {...TONE.ok}>{`+${added}`}</Text>
          <Text {...TONE.bad}>{`−${removed}`}</Text>
        </Box>
        {lines.map(line => (
          <Box key={`d${line.key}`} flexDirection="row">
            <Text {...TONE.dim}>{`${line.number.padStart(width)} `}</Text>
            <Text wrap="truncate-end" {...TONE[line.spans[0]?.tone ?? 'dim']}>
              {line.spans[0]?.text ?? ''}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
