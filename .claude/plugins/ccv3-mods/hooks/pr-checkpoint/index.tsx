import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { CheckpointAsk, CheckpointRecord, CheckpointResult, CheckpointView } from '../../types'
import { isPrNumber, readRecord } from '../pr-loop/model'
import {
  APPLY_TIMEOUT_MS,
  ENGINE_REL,
  ENGINE_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  NEED_PR,
  PANE,
  TOOL_NAME,
  USAGE,
  askButtonLabel,
  askOrder,
  clip,
  commentArgv,
  costText,
  coversRows,
  engineArgv,
  firstLine,
  headerRows,
  isStalePending,
  lastLine,
  optionLabel,
  optionsInOrder,
  parseCheckpointArgs,
  parseResult,
  pressNotice,
  recommendRows,
  resolveBody,
  viewArgv,
} from './model'

/** The same atoms the other modules declare (same plugin and key, same default): an atom is read only where it is declared. */
const mode = atom({ plugin: 'ccv3-mods', key: 'mode' } as const, 'interactive' as 'interactive' | 'headless')
const checkpoint = atom({ plugin: 'ccv3-mods', key: 'checkpoint' } as const, null as CheckpointView | null)
const checkpointAsks = atom({ plugin: 'ccv3-mods', key: 'checkpointAsks' } as const, [] as CheckpointAsk[])

const TOOL = `mcp__ccv3-mods__${TOOL_NAME}`
const PENDING_PREFIX = 'checkpoint:pending:'
const ASKS_PREFIX = 'checkpoint:asks:'
const RECORD_PREFIX = 'checkpoint:pr:'
const GRANT_PREFIX = 'checkpoint:grant:'
const VIEW_TIMEOUT_MS = 30_000
const WAIT_FOR_PRESS =
  "Wait for Dave's press. Do not run gh pr ready, add a review: label, or run pr-checkpoint --confirm or --apply."

/** A mod-served MCP tool answers with a list of content blocks (see pr-loop). */
const textResult = (text: string) => ({ result: [{ type: 'text', text }] })

/** CCV3_MODS_OFF=1 or CCV3_PR_CHECKPOINT_OFF=1 keeps the whole module inert. */
const isOff = async ($: EngineInterface): Promise<boolean> =>
  (await $.env.get('CCV3_MODS_OFF')) === '1' || (await $.env.get('CCV3_PR_CHECKPOINT_OFF')) === '1'

const interactive = async ($: EngineInterface): Promise<boolean> => (await read($, mode)) === 'interactive'

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The session root, and only when it holds the engine: the engine reads the facts of the checkout it runs in. */
const rootOf = async ($: EngineInterface): Promise<string | null> => {
  try {
    const root = await $.session.root()
    return (await $.fs.exists(`${root}/${ENGINE_REL}`)) ? root : null
  } catch {
    return null
  }
}

type Ran = { ok: true; code: number; out: string; err: string } | { ok: false; text: string }

/** A process that did not start or timed out is `ok: false` with its message; any exit code is `ok: true`. */
const run = async ($: EngineInterface, argv: string[], cwd: string, timeoutMs: number): Promise<Ran> => {
  try {
    const ran = await $.process.run(argv, { cwd, timeoutMs })
    return { ok: true, code: ran.exitCode, out: ran.stdout, err: ran.stderr }
  } catch (err) {
    return { ok: false, text: message(err) }
  }
}

const sessionId = async ($: EngineInterface): Promise<string> => $.session.id()

// ---- store -----------------------------------------------------------------------------------------------------------------

type Pending = { pr: number; body: string; root: string; result: CheckpointResult; covers: string[]; stamp: string | null; prHead: string; at: number }

const isPending = (value: unknown): value is Pending => {
  const p = value as Partial<Pending> | null | undefined
  return !!p && Number.isInteger(p.pr) && typeof p.body === 'string' && typeof p.root === 'string' && typeof p.prHead === 'string' && !!p.result && Array.isArray(p.result.options)
}

const loadPending = async ($: EngineInterface): Promise<Pending | null> => {
  const value = await $.store.get(`${PENDING_PREFIX}${await sessionId($)}`)
  return isPending(value) ? value : null
}

const viewOf = (p: Pending): CheckpointView => ({
  pr: p.pr, body: p.body, root: p.root, result: p.result, covers: p.covers, stamp: p.stamp, prHead: p.prHead, running: null, error: null, retry: null,
})

const clearPending = async ($: EngineInterface): Promise<void> => {
  await $.store.delete(`${PENDING_PREFIX}${await sessionId($)}`)
  await update($, checkpoint, () => null)
}

const isAsk = (value: unknown): value is CheckpointAsk => {
  const ask = value as Partial<CheckpointAsk> | null
  return !!ask && Number.isInteger(ask.pr) && typeof ask.head === 'string' && typeof ask.text === 'string' && (ask.kind === 'opening' || ask.kind === 'round' || ask.kind === 'greptile')
}

const loadAsks = async ($: EngineInterface): Promise<CheckpointAsk[]> => {
  const value = await $.store.get(`${ASKS_PREFIX}${await sessionId($)}`)
  return Array.isArray(value) ? value.filter(isAsk) : []
}

const saveAsks = async ($: EngineInterface, list: CheckpointAsk[]): Promise<void> => {
  const key = `${ASKS_PREFIX}${await sessionId($)}`
  if (list.length === 0) await $.store.delete(key)
  else await $.store.set(key, list)
  await update($, checkpointAsks, () => list)
}

/** Reads this session's pending checkpoint and questions into the atoms; drops a pending one that nobody touched for a week. */
const restore = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (key.startsWith(PENDING_PREFIX) && isStalePending(await $.store.get(key), now)) await $.store.delete(key)
  }
  const pending = await loadPending($)
  await update($, checkpoint, () => (pending ? viewOf(pending) : null))
  const asks = await loadAsks($)
  await update($, checkpointAsks, () => asks)
}

// ---- the model's view of a press ---------------------------------------------------------------------------------------------

/** Tells the model what Dave decided: a user row it reads at its next request. It starts no turn. A refusal is only a missed note. */
const tellModel = async ($: EngineInterface, text: string): Promise<void> => {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch {
    // The next pr_watch line carries the state.
  }
}

// ---- the engine --------------------------------------------------------------------------------------------------------------

type Failure = { ok: false; text: string }
type Prepared = { ok: true; pending: Pending }

const fail = (text: string): Failure => ({ ok: false, text })

/** The text plan: the engine in text mode. Never --json, --confirm or --apply, never gh. */
const textPlan = async ($: EngineInterface, root: string): Promise<string> => {
  const ran = await run($, engineArgv(root), root, ENGINE_TIMEOUT_MS)
  if (!ran.ok) return `pr-checkpoint could not run (${ran.text}). Nothing was recorded. The PR stays a draft.`
  const out = (ran.out || ran.err).trim()
  return `${out}\nNothing was recorded. The PR stays a draft. Dave runs /checkpoint in an interactive session.`
}

const gitLines = async ($: EngineInterface, root: string, argv: string[]): Promise<string | null> => {
  const ran = await run($, argv, root, GIT_TIMEOUT_MS)
  return ran.ok && ran.code === 0 ? ran.out : null
}

const stampAt = async ($: EngineInterface, root: string): Promise<string | null> => {
  try {
    const at = (JSON.parse(await $.fs.read(`${root}/.claude/cache/pre-pr/stamp.json`)) as { at?: unknown }).at
    return typeof at === 'string' ? at : null
  } catch {
    return null
  }
}

/**
 * gh pr view, the engine's --json, and the checks the plan lists: the PR is a draft, the checkout is at its head.
 * It records nothing. The PR number and the body path come from the tool or /checkpoint.
 */
const prepare = async ($: EngineInterface, root: string, pr: number, body: string): Promise<Prepared | Failure> => {
  const viewed = await run($, viewArgv(pr), root, VIEW_TIMEOUT_MS)
  if (!viewed.ok) return fail(`Could not read PR #${pr} (${viewed.text}). Nothing was recorded.`)
  if (viewed.code !== 0) return fail(`Could not read PR #${pr}: ${firstLine(viewed.err || viewed.out)}. Nothing was recorded.`)
  let info: { isDraft?: unknown; headRefOid?: unknown; author?: { login?: unknown } }
  try {
    info = JSON.parse(viewed.out)
  } catch {
    return fail(`gh pr view printed no JSON for PR #${pr}. Nothing was recorded.`)
  }
  if (info.isDraft !== true) return fail(`PR #${pr} is not a draft. The checkpoint applies to a draft PR only. Nothing was recorded.`)
  const dependabot = info.author?.login === 'dependabot[bot]'
  const ran = await run($, engineArgv(root, '--json', ...(dependabot ? ['--dependabot'] : [])), root, ENGINE_TIMEOUT_MS)
  if (!ran.ok) return fail(`pr-checkpoint did not finish (timed out or failed to start: ${ran.text}). Nothing was recorded. The PR stays a draft.`)
  if (ran.code !== 0) return fail(`pr-checkpoint exited ${ran.code}: ${lastLine(ran.err || ran.out)}. Nothing was recorded. The PR stays a draft.`)
  const result = parseResult(ran.out)
  if (!result) return fail(`pr-checkpoint printed no JSON the mod can read (${clip(firstLine(ran.out), 80)}). Nothing was recorded. The PR stays a draft.`)
  const prHead = typeof info.headRefOid === 'string' ? info.headRefOid : ''
  if (result.head !== prHead) {
    return fail(
      `This checkout is at ${result.head.slice(0, 7)} but PR #${pr} is at ${prHead.slice(0, 7)}: check out the PR branch at its head, run pre-pr.mjs, then ask for the checkpoint again. Nothing was recorded.`,
    )
  }
  const subjects = await gitLines($, root, ['git', 'log', '--format=%s', '-n', '8', 'fork/main..HEAD'])
  const numstat = await gitLines($, root, ['git', 'diff', '--numstat', 'fork/main...HEAD'])
  return {
    ok: true,
    pending: { pr, body, root, result, covers: coversRows(subjects, numstat), stamp: await stampAt($, root), prHead, at: await $.clock.now() },
  }
}

/** Opens the pane. The pending pair stays in the store when the pane waits undrawn, so /checkpoint can open it later. */
const openPane = async ($: EngineInterface): Promise<{ isPlaced: boolean; reason?: string }> => {
  try {
    const opened = await $.ui.open({ id: PANE, title: 'PR checkpoint', focus: true, closeOnEscape: true })
    return opened.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: opened.reason }
  } catch (err) {
    return { isPlaced: false, reason: message(err) }
  }
}

/** Stores the pending checkpoint, mirrors it to the pane atom and opens the pane. An unplaced pane gets a toast. */
const show = async ($: EngineInterface, pending: Pending): Promise<{ isPlaced: boolean; reason?: string }> => {
  await $.store.set(`${PENDING_PREFIX}${await sessionId($)}`, pending)
  await update($, checkpoint, () => viewOf(pending))
  const placed = await openPane($)
  if (!placed.isPlaced) $.ui.toast(`PR #${pending.pr}: checkpoint ready, but the pane waits (${placed.reason}); type /checkpoint to open it`, { timeoutMs: 15_000 })
  return placed
}

type Outcome =
  | { stage: 'confirm' | 'apply'; text: string }
  | { stage: 'done'; record: CheckpointRecord }

/** --apply for a confirmed record. A refusal keeps the record confirmed. */
const applyRecord = async ($: EngineInterface, root: string, record: CheckpointRecord): Promise<Outcome> => {
  const ran = await run($, engineArgv(root, '--apply', String(record.pr)), root, APPLY_TIMEOUT_MS)
  if (!ran.ok) return { stage: 'apply', text: `--apply could not run (${ran.text})` }
  if (ran.code !== 0) return { stage: 'apply', text: lastLine(ran.err || ran.out) || `--apply exited ${ran.code}` }
  const applied: CheckpointRecord = { ...record, state: 'applied', appliedAt: await $.clock.now() }
  await $.store.set(`${RECORD_PREFIX}${record.pr}`, applied)
  return { stage: 'done', record: applied }
}

/** --confirm then --apply, as the engine's two steps. Nothing is stored when --confirm refuses. */
const recordPathway = async (
  $: EngineInterface,
  a: { pr: number; root: string; body: string; result: CheckpointResult },
  pathway: string,
  by: string,
): Promise<Outcome> => {
  const ran = await run($, engineArgv(a.root, '--confirm', pathway, '--by', by, '--body', a.body), a.root, ENGINE_TIMEOUT_MS)
  if (!ran.ok) return { stage: 'confirm', text: `--confirm could not run (${ran.text})` }
  if (ran.code !== 0) return { stage: 'confirm', text: lastLine(ran.err || ran.out) || `--confirm exited ${ran.code}` }
  let printed: Partial<CheckpointRecord>
  try {
    printed = JSON.parse(ran.out)
  } catch {
    return { stage: 'confirm', text: '--confirm printed no record' }
  }
  const stored = {
    ...printed,
    pathway: printed.pathway ?? pathway,
    label: printed.label ?? null,
    budget: printed.budget ?? a.result.budget,
    head: printed.head ?? a.result.head,
    decided_by: printed.decided_by ?? by,
    pr: a.pr,
    state: 'confirmed',
    session: await sessionId($),
    capacity: a.result.capacity,
  } as CheckpointRecord
  await $.store.set(`${RECORD_PREFIX}${a.pr}`, stored)
  return applyRecord($, a.root, stored)
}

// ---- the pane ---------------------------------------------------------------------------------------------------------------

/** Closes the pane when no question and no checkpoint is left in it. */
const closeIfIdle = async ($: EngineInterface): Promise<void> => {
  if ((await read($, checkpointAsks)).length === 0 && (await read($, checkpoint)) === null) await $.ui.close({ id: PANE })
}

/** A checkpoint that Dave answered in the pane: toast, the note for the model, and the pane closes unless a question is left. */
const finishPress = async ($: EngineInterface, record: CheckpointRecord): Promise<void> => {
  $.ui.toast(`PR #${record.pr}: ${record.pathway} recorded, the PR is ready`, { timeoutMs: 10_000 })
  await clearPending($)
  await tellModel($, pressNotice({ pr: record.pr, pathway: record.pathway, label: record.label, budget: record.budget, by: record.decided_by }))
  await closeIfIdle($)
}

const pressOption = async ($: EngineInterface, pathway: string, isFirst: boolean): Promise<void> => {
  const view = await read($, checkpoint)
  if (!view || view.running !== null) return
  if (pathway === 'wait') {
    $.ui.toast(`PR #${view.pr} stays a draft`, { timeoutMs: 10_000 })
    await clearPending($)
    await closeIfIdle($)
    return
  }
  await update($, checkpoint, v => (v ? { ...v, running: pathway, error: null, retry: null } : v))
  const out = await recordPathway($, { pr: view.pr, root: view.root, body: view.body, result: view.result }, pathway, isFirst ? 'default' : 'dave')
  if (out.stage === 'done') return finishPress($, out.record)
  await update($, checkpoint, v => (v ? { ...v, running: null, error: out.text, retry: out.stage === 'apply' ? { pathway } : null } : v))
}

const pressRetry = async ($: EngineInterface): Promise<void> => {
  const view = await read($, checkpoint)
  if (!view || view.running !== null || view.retry === null) return
  const record = readRecord(await $.store.get(`${RECORD_PREFIX}${view.pr}`))
  if (!record) return
  await update($, checkpoint, v => (v ? { ...v, running: 'apply', error: null } : v))
  const out = await applyRecord($, view.root, record)
  if (out.stage === 'done') return finishPress($, out.record)
  await update($, checkpoint, v => (v ? { ...v, running: null, error: out.text, retry: { pathway: record.pathway } } : v))
}

const pressDismiss = async ($: EngineInterface): Promise<void> => {
  await $.ui.close({ id: PANE })
}

const askNotice = (ask: CheckpointAsk, answer: 'yes' | 'no'): string => {
  const round = ask.round ?? 1
  if (ask.kind === 'round') {
    return answer === 'yes'
      ? `PR checkpoint: Dave allowed round ${round} for #${ask.pr}: after the fix push, post one @coderabbitai review.`
      : `PR checkpoint: Dave declined round ${round} for #${ask.pr}. Do not request a review. Report the open findings to Dave.`
  }
  if (ask.kind === 'opening') {
    return answer === 'yes'
      ? `PR checkpoint: Dave asked for the opening CodeRabbit review of #${ask.pr}. The mod posted @coderabbitai review. Do not post another.`
      : `PR checkpoint: Dave declined the opening CodeRabbit review. Do not request a review on #${ask.pr}. Report to Dave.`
  }
  return answer === 'yes'
    ? `PR checkpoint: Dave asked for Greptile on #${ask.pr}. The mod posted @greptileai. Do not post another.`
    : `PR checkpoint: Dave declined Greptile for #${ask.pr}. Do not request a Greptile review.`
}

/** Dave's Yes or No on the first question. A Yes that posts a comment and fails leaves the question queued. */
const pressAsk = async ($: EngineInterface, answer: 'yes' | 'no'): Promise<void> => {
  const queue = await read($, checkpointAsks)
  const ask = queue[0]
  if (!ask) return
  const now = await $.clock.now()
  const key = `${RECORD_PREFIX}${ask.pr}`
  const stored = readRecord(await $.store.get(key))
  let next: CheckpointRecord | null = stored
  if (ask.kind !== 'round' && answer === 'yes') {
    const root = await rootOf($)
    const ran = root ? await run($, commentArgv(ask.pr, ask.kind === 'opening' ? '@coderabbitai review' : '@greptileai'), root, VIEW_TIMEOUT_MS) : null
    if (!ran || !ran.ok || ran.code !== 0) {
      $.ui.toast(`PR #${ask.pr}: could not post the request (${ran ? (ran.ok ? firstLine(ran.err) : ran.text) : 'no checkout'}); it stays queued`, { timeoutMs: 10_000 })
      return
    }
  }
  if (ask.kind === 'round' && answer === 'yes') {
    await $.store.set(`${GRANT_PREFIX}${ask.pr}`, { round: ask.round ?? 1, head: ask.head, at: now })
    if (next) {
      const { declined: _declined, ...rest } = next
      next = rest as CheckpointRecord
    }
  } else if (next) {
    if (ask.kind === 'opening') next = answer === 'yes' ? { ...next, opened: { head: ask.head, at: now } } : { ...next, declined: { kind: 'opening', round: 1, head: ask.head } }
    else if (ask.kind === 'round') next = { ...next, declined: { kind: 'round', round: ask.round ?? 1, head: ask.head } }
    else next = { ...next, greptile: answer === 'yes' ? { head: ask.head, at: now } : { declined: true } }
  }
  if (next && next !== stored) await $.store.set(key, next)
  await saveAsks($, queue.slice(1))
  await tellModel($, askNotice(ask, answer))
  await closeIfIdle($)
}

// ---- the tool and the command -------------------------------------------------------------------------------------------------

/** The tool: headless gets the text plan; an interactive session gets the pane. Returns the text for the model. */
const toolText = async ($: EngineInterface, pr: number, body: string): Promise<string> => {
  const root = await rootOf($)
  if (!root) return `pr_checkpoint runs in a CCv3 checkout (it needs ${ENGINE_REL} in the session root). Nothing was recorded.`
  const bodyPath = resolveBody(root, body)
  if (!(await $.fs.exists(bodyPath))) return `The body file ${body} was not found (${bodyPath}). Write the PR body to a file and pass it as "body". Nothing was run.`
  if (!(await interactive($))) return textPlan($, root)
  const prepared = await prepare($, root, pr, bodyPath)
  if (!prepared.ok) return prepared.text
  const placed = await show($, prepared.pending)
  if (placed.isPlaced) return `The checkpoint for #${pr} is in Dave's side pane. ${WAIT_FOR_PRESS}`
  return `The checkpoint for #${pr} is ready, but the pane could not be placed (${placed.reason}). Dave types /checkpoint to open it. ${WAIT_FOR_PRESS}`
}


/** /checkpoint. It answers its own command: Dave's text, and one hidden line for the model. It never calls prompt.submit. */
const checkpointCommand = async ($: EngineInterface, e: { args: string; origin: { kind: string } }): Promise<{ text: string; context?: string[] }> => {
  const parsed = parseCheckpointArgs(e.args)
  if (!parsed) return { text: USAGE }
  const live = await interactive($)
  const pending = await loadPending($)
  if (parsed.pr === null && parsed.word === null && parsed.body === null) {
    const queued = await loadAsks($)
    if (!live || (!pending && queued.length === 0)) return { text: NEED_PR }
    if (pending && (await read($, checkpoint)) === null) await update($, checkpoint, () => viewOf(pending))
    if (queued.length > 0 && (await read($, checkpointAsks)).length === 0) await update($, checkpointAsks, () => queued)
    const placed = await openPane($)
    return { text: placed.isPlaced ? 'The checkpoint is in the side pane.' : `The pane could not be placed (${placed.reason}). Widen the terminal, then type /checkpoint again.` }
  }
  const pr = parsed.pr ?? pending?.pr ?? null
  const body = parsed.body ?? (pending && pending.pr === pr ? pending.body : null)
  if (pr === null || body === null) return { text: NEED_PR }
  const root = await rootOf($)
  if (!root) return { text: `/checkpoint runs in a CCv3 checkout (it needs ${ENGINE_REL} in the session root). Nothing was recorded.` }
  const bodyPath = resolveBody(root, body)
  if (!(await $.fs.exists(bodyPath))) return { text: `The body file ${body} was not found (${bodyPath}). Pass --body <file>. Nothing was run.` }
  // Only Dave's own command records. A plugin, the SDK or a headless run gets the text plan.
  if (!live || e.origin.kind !== 'composer') return { text: await textPlan($, root) }
  const prepared = await prepare($, root, pr, bodyPath)
  if (!prepared.ok) return { text: prepared.text }
  const next = prepared.pending
  if (parsed.word === null) {
    const placed = await show($, next)
    return { text: placed.isPlaced ? `The checkpoint for #${pr} is in the side pane.` : `The pane could not be placed (${placed.reason}). Widen the terminal, then type /checkpoint again.` }
  }
  if (parsed.word === 'wait') return { text: `PR #${pr} stays a draft. Nothing was recorded.` }
  const result = next.result
  const pathway = parsed.word === 'accept' ? result.recommended : parsed.word
  if (!pathway) return { text: `There is no recommendation: ${result.why[0] ?? 'run pre-pr.mjs'}. Nothing was recorded.` }
  const option = result.options.find(one => one.pathway === pathway)
  if (!option || !option.available) return { text: `Pathway ${pathway} is not available${option ? `: ${option.reason}` : ''}. Nothing was recorded.` }
  const by = parsed.word === 'accept' ? 'default' : 'dave'
  const out = await recordPathway($, { pr, root, body: bodyPath, result }, pathway, by)
  if (out.stage !== 'done') {
    return { text: out.stage === 'apply' ? `PR #${pr}: ${pathway} is confirmed, but --apply was refused: ${out.text}` : `PR #${pr}: ${pathway} was not recorded: ${out.text}` }
  }
  const record = out.record
  if (pending && pending.pr === pr) {
    await clearPending($)
    await closeIfIdle($)
  }
  $.ui.toast(`PR #${pr}: ${pathway} recorded, the PR is ready`, { timeoutMs: 10_000 })
  return {
    text: `PR #${pr}: ${pathway} recorded (${record.label ?? 'no label'}, ${costText(record.budget)}, by ${by}). The label is on the PR and it is ready.`,
    context: [pressNotice({ pr, pathway, label: record.label, budget: record.budget, by })],
  }
}

/** One module's part of session.start, on either trigger. The tool and the command register in both modes; the pane is interactive only. */
const start = async ($: EngineInterface, isInteractive: boolean): Promise<void> => {
  if (await isOff($)) return
  await update($, mode, () => (isInteractive ? 'interactive' : 'headless'))
  // Each registration has its own try: a refused name must not stop the rest.
  try {
    await $.tool.register({
      name: TOOL_NAME,
      description:
        "Opens the PR checkpoint for a DRAFT pull request in Rev4nchist/Continuous-Claude-v3 in Dave's side pane: the review pathways with their cost, and the recommended one first. Dave presses an option; the mod then records it, adds the review label and marks the PR ready. Call it after pre-pr.mjs passed, with the PR number and the path of the body file that pre-pr.mjs --body checked. It returns at once. Never run gh pr ready, add a review: label or run pr-checkpoint --confirm yourself. A headless session gets the text plan only and nothing is recorded.",
      inputSchema: {
        type: 'object',
        properties: {
          pr: { type: 'integer', minimum: 1, description: 'The draft pull request number' },
          body: { type: 'string', description: 'The PR body file that pre-pr.mjs --body checked (a path relative to the session root, or absolute)' },
        },
        required: ['pr', 'body'],
      },
    })
  } catch {
    // The command and the pane still load.
  }
  try {
    await $.command.register({
      name: 'checkpoint',
      description: 'Open the PR checkpoint pane, or record a pathway',
      argumentHint: '[pr] [accept|coderabbit|both|none|wait] [--body <file>]',
    })
  } catch {
    // The tool and the pane still load.
  }
  if (!isInteractive) return
  try {
    await restore($)
  } catch {
    // /checkpoint reads the store again.
  }
}

export const prCheckpoint = (on: On) => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await start($, true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', { isInteractive: false }, async ($, e, next) => {
    await start($, false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TOOL }, async ($, e, next) => {
    if (await isOff($)) return next(e)
    const input = e as unknown as { pr?: unknown; body?: unknown }
    if (!isPrNumber(input.pr) || typeof input.body !== 'string' || input.body.trim() === '') {
      return { deny: 'pr_checkpoint needs "pr" (a positive whole number) and "body" (the PR body file).' }
    }
    return textResult(await toolText($, input.pr, input.body.trim()))
  }).catch(($, e, next) => (next.called ? next(e) : textResult('pr_checkpoint failed. Nothing was recorded. The PR stays a draft.')))

  on('command.run', { command: 'checkpoint' }, ($, e) => checkpointCommand($, e)).catch(() => ({
    text: '/checkpoint failed. Nothing was recorded.',
  }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (await isOff($)) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = await read($, checkpoint)
    const asks = await read($, checkpointAsks)
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns - 2)
    const row = (key: string, text: string, dim = false) => (
      <Text key={key} wrap="truncate-end" {...(dim ? { dimColor: true } : {})}>
        {clip(text, width)}
      </Text>
    )
    if (view) {
      const { buttons, held } = optionsInOrder(view.result)
      const rows = [...headerRows(view, now), ...recommendRows(view.result)]
      return (
        <Box flexDirection="column" paddingX={1}>
          {rows.map((text, i) => row(`row-${i}`, text))}
          {held.map(one => row(`held-${one.pathway}`, `${one.pathway} held: ${one.reason}`, true))}
          {view.error ? <Text key="error">{view.error}</Text> : null}
          {view.running ? row('running', `Running ${view.running}...`, true) : null}
          {view.running === null &&
            buttons.map((one, i) => (
              <Button
                key={`opt-${one.pathway}`}
                hotkey={String(i + 1)}
                {...(i === 0 ? { autoFocus: true as const, variant: 'primary' as const } : {})}
                onPress={() => void pressOption($, one.pathway, i === 0).catch(() => undefined)}
              >
                {optionLabel(one, i === 0)}
              </Button>
            ))}
          {view.running === null && view.retry ? (
            <Button key="retry-apply" hotkey="r" onPress={() => void pressRetry($).catch(() => undefined)}>
              Retry --apply
            </Button>
          ) : null}
          <Button key="dismiss" hotkey="0" role="dismiss" onPress={() => void pressDismiss($).catch(() => undefined)}>
            Dismiss (nothing is recorded)
          </Button>
        </Box>
      )
    }
    const ask = asks[0]
    if (!ask) {
      return (
        <Box flexDirection="column" paddingX={1}>
          {row('none', 'No checkpoint or question waits for you.', true)}
          <Button key="dismiss" hotkey="0" role="dismiss" onPress={() => void pressDismiss($).catch(() => undefined)}>
            Dismiss
          </Button>
        </Box>
      )
    }
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text key="ask">{ask.text}</Text>
        {asks.length > 1 ? row('more', `${asks.length - 1} more question(s) wait.`, true) : null}
        {askOrder(ask.kind).map((answer, i) => (
          <Button
            key={`ask-${answer}`}
            hotkey={String(i + 1)}
            {...(i === 0 ? { autoFocus: true as const, variant: 'primary' as const } : {})}
            onPress={() => void pressAsk($, answer).catch(() => undefined)}
          >
            {askButtonLabel(ask.kind, answer) + (i === 0 ? '  (Recommended)' : '')}
          </Button>
        ))}
      </Box>
    )
  })
}
