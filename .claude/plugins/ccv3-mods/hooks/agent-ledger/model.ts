// Agent Ledger, pure: runs, their totals and the /agents pane's rows.

import type { AgentRun } from '../../types'
import { elapsed } from '../agentic-os/model'
import { fit } from '../agentic-os/pane-model'
import type { PaneRow, Span, Tone } from '../agentic-os/pane-model'
import { estimate, fmtTokens, fmtUsd } from '../shared/price'
import type { Usage } from '../shared/price'
import { driftOf, tierBadge, tierOf } from '../shared/tiers'

export const newRun = (
  id: string,
  type: string,
  description: string,
  model: string | null,
  spec: AgentRun['spec'],
  startedAt: number,
  toolUseId?: string,
): AgentRun => ({
  id,
  ...(toolUseId === undefined ? {} : { toolUseId }),
  type,
  description,
  model,
  effort: null,
  spec,
  startedAt,
  endedAt: null,
  status: 'running',
  tokens: 0,
  costUsd: 0,
  drift: model === null ? null : driftOf(spec, { model }),
})

const usageTokens = (usage: Usage): number =>
  usage.input_tokens + usage.output_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)

/** One model request of the run: its model, effort and usage (null when the request counted nothing). */
export const addStep = (run: AgentRun, step: { model: string; effort: string | null; usage: (Usage & { model?: string }) | null }): AgentRun => {
  const model = step.usage?.model ?? step.model
  const effort = step.effort ?? run.effort
  const cost = step.usage === null ? 0 : (estimate(step.usage, model) ?? 0)
  return {
    ...run,
    model,
    effort,
    // A teammate or a resumed background agent runs again after its turn.complete: it is live once more.
    status: 'running',
    endedAt: null,
    tokens: run.tokens + (step.usage === null ? 0 : usageTokens(step.usage)),
    costUsd: run.costUsd + cost,
    // The first drift sticks: one fallback or Haiku request is worth seeing even if later ones are on spec.
    drift: run.drift ?? driftOf(run.spec, { model, ...(effort === null ? {} : { effort }) }),
  }
}

/** The end of one of the run's turns (a teammate has several). `failed` marks an error, abort or refusal. */
export const settle = (run: AgentRun, endedAt: number, failed: boolean): AgentRun => ({ ...run, endedAt, status: failed ? 'failed' : 'done' })

/** The spec arrived after the run started: fold it in and check the steps seen so far. */
export const withSpec = (run: AgentRun, spec: AgentRun['spec']): AgentRun => ({
  ...run,
  spec,
  drift: run.drift ?? (run.model === null ? null : driftOf(spec, { model: run.model, ...(run.effort === null ? {} : { effort: run.effort }) })),
})

/** Finished runs kept for the pane; older ones fall off so the atom stays small. */
export const MAX_FINISHED = 50

export const capRuns = (runs: readonly AgentRun[]): AgentRun[] => {
  const finished = runs.filter(run => run.status !== 'running')
  const drop = new Set(finished.slice(0, Math.max(0, finished.length - MAX_FINISHED)).map(run => run.id))
  return runs.filter(run => !drop.has(run.id))
}

export type LedgerSummary = { running: number; usd: number; tokens: number; opusShare: number | null }

export const summarize = (runs: readonly AgentRun[]): LedgerSummary => {
  const usd = runs.reduce((n, run) => n + run.costUsd, 0)
  const opus = runs.filter(run => run.model !== null && tierOf(run.model) === 'opus').reduce((n, run) => n + run.costUsd, 0)
  return {
    running: runs.filter(run => run.status === 'running').length,
    usd,
    tokens: runs.reduce((n, run) => n + run.tokens, 0),
    opusShare: usd > 0 ? opus / usd : null,
  }
}

/** The band's AGENTS part, or null with no runs. */
export const ledgerBandSpans = (runs: readonly AgentRun[]): Span[] | null => {
  if (runs.length === 0) return null
  const sum = summarize(runs)
  const drifted = runs.some(run => run.drift !== null)
  const lead = sum.running > 0 ? `◉ ${sum.running} running` : `◉ ${runs.length} agents`
  return [{ text: `${lead} · ≈${fmtUsd(sum.usd)}${drifted ? ' !' : ''}`, tone: drifted ? 'bad' : 'dim' }]
}

const sp = (text: string, tone: Tone): Span => ({ text, tone })

/** Tier tone for a badge: theme-key tones only, so light and dark both work. */
export const tierTone = (model: string | null): Tone => {
  if (model === null) return 'dim'
  const tier = tierOf(model)
  return tier === 'opus' ? 'active' : tier === 'sonnet' ? 'sonnetTier' : tier === 'fable' ? 'advisor' : tier === 'haiku' ? 'bad' : 'dim'
}

const runRows = (run: AgentRun, nowMs: number): PaneRow[] => {
  const mark: Span =
    run.status === 'running' ? sp('● ', 'active') : run.status === 'failed' ? sp('✗ ', 'bad') : sp('✓ ', 'done')
  const badge = run.model === null ? sp('…', 'dim') : sp(tierBadge(run.model, run.effort ?? undefined), run.drift ? 'bad' : tierTone(run.model))
  const time = elapsed((run.endedAt ?? nowMs) - run.startedAt)
  const cost = run.status === 'running' ? 'settles at finish' : `≈ ${fmtUsd(run.costUsd)}`
  const rows: PaneRow[] = [
    { key: `run-${run.id}`, left: [mark, sp(run.type, 'head'), sp(`  ${run.description}`, 'dim')], right: [badge] },
    { key: `run-${run.id}-meta`, left: [sp(`  ${time} · ${fmtTokens(run.tokens)} tok`, 'dim')], right: [sp(cost, run.status === 'running' ? 'dim' : 'todo')] },
  ]
  if (run.drift !== null) rows.push({ key: `run-${run.id}-drift`, left: [sp(`  Tier drift: ${run.drift}`, 'bad')] })
  return rows
}

/** The /agents pane: totals, then running and finished runs (newest first), cut to `rows`. */
export const ledgerRows = (runs: readonly AgentRun[], nowMs: number, columns: number, rows: number, offset = 0): PaneRow[] => {
  const sum = summarize(runs)
  const head: PaneRow[] = [
    { key: 'title', left: [sp('Agents', 'title')], right: [sp(`≈ ${fmtUsd(sum.usd)} · ${fmtTokens(sum.tokens)} tok`, 'dim')] },
  ]
  if (sum.opusShare !== null) {
    const pct = Math.round(sum.opusShare * 100)
    head.push({ key: 'split', left: [sp(`Opus ${pct}%`, 'active'), sp(' · ', 'track'), sp(`other ${100 - pct}%`, 'dim')] })
  }
  if (runs.length === 0) head.push({ key: 'empty', left: [sp('No subagents yet this session.', 'dim')] })
  const live = runs.filter(run => run.status === 'running').reverse()
  const done = runs.filter(run => run.status !== 'running').reverse()
  const body: PaneRow[] = [
    ...(live.length ? [{ key: 'h-live', left: [sp(`RUNNING · ${live.length}`, 'head')] }, ...live.flatMap(run => runRows(run, nowMs))] : []),
    ...(done.length ? [{ key: 'h-done', left: [sp(`FINISHED · ${done.length}`, 'head')] }, ...done.flatMap(run => runRows(run, nowMs))] : []),
  ]
  const foot: PaneRow = { key: 'foot', left: [sp('Estimate from token counts, not your bill. Session total: HUD.', 'dim')] }
  // Head and foot stay put; the run rows scroll.
  const room = Math.max(0, rows - head.length - 1)
  const start = Math.min(Math.max(0, offset), Math.max(0, body.length - room))
  return [...head, ...body.slice(start, start + room), foot].map(row => fit(row, Math.max(10, columns)))
}
