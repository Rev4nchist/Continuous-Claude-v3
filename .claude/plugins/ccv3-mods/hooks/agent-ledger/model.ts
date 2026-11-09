// Agent Ledger, pure: runs, their totals and the /ledger pane's rows.

import type { AgentRun } from '../../types'
import { elapsed } from '../agentic-os/model'
import { fit } from '../agentic-os/pane-model'
import type { PaneRow, Span, Tone } from '../agentic-os/pane-model'
import { advisorTokens, fmtTokens, fmtUsd, stepCost, tokenCount } from '../shared/price'
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
  workflowRunId?: string,
): AgentRun => ({
  id,
  ...(toolUseId === undefined ? {} : { toolUseId }),
  // Empty outside a real workflow run: stored only when the engine gave one.
  ...(workflowRunId === undefined || workflowRunId === '' ? {} : { workflowRunId }),
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

// A count that is negative, NaN or infinite adds nothing; a part of the usage that throws on read counts 0.
const safe = (read: () => number): number => {
  try {
    return read()
  } catch {
    return 0
  }
}

// The four top-level counts, plus the advisor iterations: the tokens that the run's dollars (stepCost) are made of.
const usageTokens = (usage: Usage): number =>
  safe(() => tokenCount(usage.input_tokens) + tokenCount(usage.output_tokens) + tokenCount(usage.cache_read_input_tokens) + tokenCount(usage.cache_creation_input_tokens)) +
  safe(() => advisorTokens(usage))

// A count of calls: a number above 0 and finite. A string, NaN, a negative or an infinite value in a saved file counts 0.
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

/** How many advisor calls the run used, as far as the live feed showed them. Absent, and any junk in a saved file, is 0. */
export const advisedOf = (run: AgentRun): number => count(run.advised)

/** Advisor calls in one step result. A list that is not an array, or a null entry, counts 0 and never throws. */
export const advisorCalls = (uses: unknown): number =>
  Array.isArray(uses) ? uses.filter(use => use !== null && typeof use === 'object' && (use as { name?: unknown }).name === 'advisor').length : 0

/**
 * One model request of the run: its model, effort and usage (null when the request counted nothing).
 * The cost prices the whole usage (5m/1h writes, web search, speed, and each advisor iteration at its own model).
 * The tokens add the advisor iterations to the four top-level counts, so a row shows one basis for both.
 * A model with no price adds $0 and marks the run `hasUnknownModelCost`: that key is set only then, so a saved run keeps its shape.
 * `advised` is the number of advisor calls the request used. It adds to the run's count, which is set only when above 0, and it counts
 * with no usage too (an aborted request). A step that arrives twice counts twice, as its cost does: the row holds no step id.
 */
export const addStep = (
  run: AgentRun,
  step: { model: string; effort: string | null; usage: (Usage & { model?: string }) | null; advised?: number },
): AgentRun => {
  const model = step.usage?.model ?? step.model
  const effort = step.effort ?? run.effort
  const { usd: cost, unknown } = step.usage === null ? { usd: 0, unknown: false } : stepCost(step.usage, model)
  const advised = advisedOf(run) + count(step.advised)
  return {
    ...run,
    model,
    effort,
    // A teammate or a resumed background agent runs again after its turn.complete: it is live once more.
    status: 'running',
    endedAt: null,
    tokens: run.tokens + (step.usage === null ? 0 : usageTokens(step.usage)),
    costUsd: run.costUsd + cost,
    ...(run.hasUnknownModelCost === true || unknown ? { hasUnknownModelCost: true } : {}),
    ...(advised > 0 ? { advised } : {}),
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

/** `hasUnknownModelCost`: a run used a model with no price, so `usd` leaves it out. `advised`: a run used the advisor, so `usd` is a floor. */
export type LedgerSummary = { running: number; usd: number; tokens: number; opusShare: number | null; hasUnknownModelCost: boolean; advised: boolean }

/**
 * "≈ $1.20", plus "unpriced" when a model had no price; a total that is only unpriced reads "unpriced", never "$0.00".
 * `floor` (a run used the advisor, whose own tokens the live feed leaves out) swaps "≈" for "≥" and never hides: it reads "≥ $0.00" at zero.
 */
const usdText = (usd: number, unpriced: boolean, gap = ' ', floor = false): string => {
  const sign = floor ? '≥' : '≈'
  if (!unpriced) return `${sign}${gap}${fmtUsd(usd)}`
  return usd > 0 || floor ? `${sign}${gap}${fmtUsd(usd)} + unpriced` : 'unpriced'
}

export const summarize = (runs: readonly AgentRun[]): LedgerSummary => {
  const usd = runs.reduce((n, run) => n + run.costUsd, 0)
  const opus = runs.filter(run => run.model !== null && tierOf(run.model) === 'opus').reduce((n, run) => n + run.costUsd, 0)
  return {
    running: runs.filter(run => run.status === 'running').length,
    usd,
    tokens: runs.reduce((n, run) => n + run.tokens, 0),
    opusShare: usd > 0 ? opus / usd : null,
    hasUnknownModelCost: runs.some(run => run.hasUnknownModelCost === true),
    advised: runs.some(run => advisedOf(run) > 0),
  }
}

/** The band's AGENTS part, or null with no runs. */
export const ledgerBandSpans = (runs: readonly AgentRun[]): Span[] | null => {
  if (runs.length === 0) return null
  const sum = summarize(runs)
  const drifted = runs.some(run => run.drift !== null)
  const lead = sum.running > 0 ? `◉ ${sum.running} running` : `◉ ${runs.length} agents`
  return [{ text: `${lead} · ${usdText(sum.usd, sum.hasUnknownModelCost, '', sum.advised)}${drifted ? ' !' : ''}`, tone: drifted ? 'bad' : 'dim' }]
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
  const cost = run.status === 'running' ? 'settles at finish' : usdText(run.costUsd, run.hasUnknownModelCost === true, ' ', advisedOf(run) > 0)
  const rows: PaneRow[] = [
    { key: `run-${run.id}`, left: [mark, sp(run.type, 'head'), sp(`  ${run.description}`, 'dim')], right: [badge] },
    { key: `run-${run.id}-meta`, left: [sp(`  ${time} · ${fmtTokens(run.tokens)} tok`, 'dim')], right: [sp(cost, run.status === 'running' ? 'dim' : 'todo')] },
  ]
  if (run.drift !== null) rows.push({ key: `run-${run.id}-drift`, left: [sp(`  Tier drift: ${run.drift}`, 'bad')] })
  return rows
}

/** The /ledger pane: totals, then running and finished runs (newest first), cut to `rows`. */
export const ledgerRows = (runs: readonly AgentRun[], nowMs: number, columns: number, rows: number, offset = 0): PaneRow[] => {
  const sum = summarize(runs)
  const head: PaneRow[] = [
    { key: 'title', left: [sp('Agents', 'title')], right: [sp(`${usdText(sum.usd, sum.hasUnknownModelCost, ' ', sum.advised)} ·${fmtTokens(sum.tokens)} tok`, 'dim')] },
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
  // A marked run: the dollars are a floor. One more foot row says why, only then.
  const foot: PaneRow[] = [
    { key: 'foot', left: [sp('Estimate from token counts, not your bill. Session total: HUD.', 'dim')] },
    ...(sum.advised ? [{ key: 'foot-floor', left: [sp('At least this much: advisor tokens may be missing.', 'dim')] }] : []),
  ]
  // Head and foot stay put; the run rows scroll.
  const room = Math.max(0, rows - head.length - foot.length)
  const start = Math.min(Math.max(0, offset), Math.max(0, body.length - room))
  return [...head, ...body.slice(start, start + room), ...foot].map(row => fit(row, Math.max(10, columns)))
}
