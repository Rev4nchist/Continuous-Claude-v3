import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { CheckpointAsk, CheckpointRecord, CheckpointResult, CheckpointView } from '../../types'
import { isPrNumber, readRecord } from '../pr-loop/model'
import { QUEUE_BANDS, slotAdd } from '../pr-loop/slot'
import { DIAG_DIR } from '../shared/diag'
import {
  APPLY_TIMEOUT_MS,
  COMMAND,
  CONFIG_REL,
  ENGINE_REL,
  ENGINE_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  LOCK_FAILED,
  MARKER_DENY,
  NEED_PR,
  PANE,
  PATHWAY_DENY,
  SLOT_DENY,
  SHAPES_CLI_REL,
  SHAPES_TIMEOUT_MS,
  SLASH,
  TOOL_NAME,
  USAGE,
  askButtonLabel,
  askOrder,
  autoNotice,
  autoToast,
  clip,
  commentArgv,
  costText,
  coversRows,
  editedPr,
  engineArgv,
  firstLine,
  headerRows,
  isPathwayFile,
  isSlotStateFile,
  isStalePending,
  labelNeedsRecord,
  lastLine,
  lockDeny,
  lockWarn,
  mayBeGated,
  namesMarker,
  namesPathway,
  namesSlotWrite,
  optionLabel,
  optionsInOrder,
  parseCheckpointArgs,
  parseGrantArgs,
  parseResult,
  parseShapes,
  pressNotice,
  recommendRows,
  recordAllowsLabel,
  resolveBody,
  stateArgv,
  viewArgv,
  WORKTREE_ARGV,
  samePath,
  worktreeFor,
} from './model'
import type { LockPattern, LockShapes } from './model'

/** The same atoms the other modules declare (same plugin and key, same default): an atom is read only where it is declared. */
const mode = atom({ plugin: 'ccv3-mods', key: 'mode' } as const, 'interactive' as 'interactive' | 'headless')
const checkpoint = atom({ plugin: 'ccv3-mods', key: 'checkpoint' } as const, null as CheckpointView | null)
const checkpointAsks = atom({ plugin: 'ccv3-mods', key: 'checkpointAsks' } as const, [] as CheckpointAsk[])
/** The lock patterns already shown in a warn toast this session. */
const lockWarned = atom({ plugin: 'ccv3-mods', key: 'lockWarned' } as const, [] as string[])

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

/**
 * The text plan: the engine in text mode. Never --json, --confirm or --apply, never gh.
 * `checkout` is the cwd the engine reads its facts in (the PR worktree holds the pre-pr stamp; the session root may not).
 * `via` names a live session's non-composer origin (the bridge is mobile remote control); null is a headless session. The plan says
 * why nothing was recorded. `waiting` is the PR of this session's pending checkpoint, the one PR a bridge command may record.
 */
const textPlan = async ($: EngineInterface, root: string, checkout: string = root, via: string | null = null, waiting: number | null = null): Promise<string> => {
  const ran = await run($, engineArgv(root), checkout, ENGINE_TIMEOUT_MS)
  if (!ran.ok) return `pr-checkpoint could not run (${ran.text}). Nothing was recorded. The PR stays a draft.`
  const out = (ran.out || ran.err).trim()
  return `${out}\nNothing was recorded. The PR stays a draft. ${whyTextOnly(via, waiting)}`
}

const whyTextOnly = (via: string | null, waiting: number | null): string => {
  if (via === null) return `This session is headless, so ${SLASH} only shows the plan. Dave runs ${SLASH} in an interactive session.`
  const where = `This ${SLASH} came from ${via}, not Dave's terminal composer, so it only shows the plan. Dave types ${SLASH} in the composer to record it.`
  if (via !== 'bridge') return where
  return `${where} From the bridge, ${SLASH} records only the PR whose checkpoint waits in this session (${waiting === null ? 'none waits now' : `#${waiting}`}).`
}

/**
 * A bridge (phone) /pathway for the pending PR with no pathway word: a phone has no side pane. It answers with the PR, its plan read in
 * the PR checkout, and the exact command to type. It records nothing.
 */
const bridgePrompt = async ($: EngineInterface, pending: Pending): Promise<string> => {
  const ran = await run($, engineArgv(await engineRoot($, pending.root)), pending.root, ENGINE_TIMEOUT_MS)
  const plan = ran.ok ? (ran.out || ran.err).trim() : `pr-checkpoint could not run (${ran.text}).`
  const { recommended, options } = pending.result
  const words = options.filter(one => one.available && one.pathway !== 'wait').map(one => one.pathway)
  const lead = recommended && words.includes(recommended) ? `To record the recommendation, type: ${SLASH} ${pending.pr} ${recommended}.` : 'The recommendation cannot be recorded now.'
  const others = words.filter(word => word !== recommended).map(word => `${SLASH} ${pending.pr} ${word}`)
  const more = others.length > 0 ? ` Other choices: ${others.join(', ')}.` : ''
  return `PR #${pending.pr} waits for its checkpoint. Nothing was recorded.\n${plan}\n${lead}${more} ${SLASH} ${pending.pr} wait keeps it a draft.`
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
 * The checkout whose facts the engine reads (its cwd): the worktree that has the PR branch checked out, when it is a CCv3 checkout;
 * else the session root. So Dave can press /pathway from any CCv3 session, not only from one started in the PR's worktree.
 * The engine CODE always comes from the session root (engineArgv(sessionRoot)); pr-checkpoint.mjs reads every fact from the git
 * toplevel of its cwd. So a session in main never runs another worktree's copy of the engine.
 */
const checkoutOf = async ($: EngineInterface, root: string, branch: string): Promise<string> => {
  const listed = await gitLines($, root, WORKTREE_ARGV)
  const found = listed === null ? null : worktreeFor(listed, branch)
  if (!found || samePath(found, root)) return root
  return (await $.fs.exists(`${found}/${ENGINE_REL}`)) ? found : root
}

/** The checkout of a PR's branch for a command that gave no pending checkpoint: one read of the PR, then checkoutOf. Any failure: the session root. */
const checkoutOfPr = async ($: EngineInterface, sessionRoot: string, pr: number): Promise<string> => {
  const viewed = await run($, viewArgv(pr), sessionRoot, VIEW_TIMEOUT_MS)
  if (!viewed.ok || viewed.code !== 0) return sessionRoot
  try {
    const branch = (JSON.parse(viewed.out) as { headRefName?: unknown }).headRefName
    return typeof branch === 'string' ? await checkoutOf($, sessionRoot, branch) : sessionRoot
  } catch {
    return sessionRoot
  }
}

/** The roots a relative body path is looked up in, in order: the PR checkout, then the session root. */
const bodyBases = (checkout: string, root: string): string[] => (samePath(checkout, root) ? [root] : [checkout, root])

/** The body file, or null when no base has it. */
const bodyIn = async ($: EngineInterface, checkout: string, root: string, body: string): Promise<string | null> => {
  for (const base of bodyBases(checkout, root)) {
    const path = resolveBody(base, body)
    if (await $.fs.exists(path)) return path
  }
  return null
}

const missingBody = (body: string, checkout: string, root: string = checkout): string =>
  `The body file ${body} was not found (${[...new Set(bodyBases(checkout, root).map(base => resolveBody(base, body)))].join(', ')}). Write the PR body to a file and pass it. Nothing was run.`

/** The engine code: the session root's copy, else the checkout's (a session root that lost the engine since the checkpoint opened). */
const engineRoot = async ($: EngineInterface, fallback: string): Promise<string> => (await rootOf($)) ?? fallback

/**
 * gh pr view, the engine's --json, and the checks the plan lists: the PR is a draft, the checkout is at its head.
 * It records nothing. The PR number and the body path come from the tool or the command; the body resolves in the PR checkout.
 */
const prepare = async ($: EngineInterface, sessionRoot: string, pr: number, rawBody: string): Promise<Prepared | Failure> => {
  const viewed = await run($, viewArgv(pr), sessionRoot, VIEW_TIMEOUT_MS)
  if (!viewed.ok) return fail(`Could not read PR #${pr} (${viewed.text}). Nothing was recorded.`)
  if (viewed.code !== 0) return fail(`Could not read PR #${pr}: ${firstLine(viewed.err || viewed.out)}. Nothing was recorded.`)
  let info: { isDraft?: unknown; headRefOid?: unknown; headRefName?: unknown; author?: { login?: unknown } }
  try {
    info = JSON.parse(viewed.out)
  } catch {
    return fail(`gh pr view printed no JSON for PR #${pr}. Nothing was recorded.`)
  }
  if (info.isDraft !== true) return fail(`PR #${pr} is not a draft. The checkpoint applies to a draft PR only. Nothing was recorded.`)
  const branch = typeof info.headRefName === 'string' ? info.headRefName : ''
  const root = await checkoutOf($, sessionRoot, branch)
  const body = await bodyIn($, root, sessionRoot, rawBody)
  if (body === null) return fail(missingBody(rawBody, root, sessionRoot))
  const dependabot = info.author?.login === 'dependabot[bot]'
  const ran = await run($, engineArgv(sessionRoot, '--json', ...(dependabot ? ['--dependabot'] : [])), root, ENGINE_TIMEOUT_MS)
  if (!ran.ok) return fail(`pr-checkpoint did not finish (timed out or failed to start: ${ran.text}). Nothing was recorded. The PR stays a draft.`)
  if (ran.code !== 0) return fail(`pr-checkpoint exited ${ran.code}: ${lastLine(ran.err || ran.out)}. Nothing was recorded. The PR stays a draft.`)
  const result = parseResult(ran.out)
  if (!result) return fail(`pr-checkpoint printed no JSON the mod can read (${clip(firstLine(ran.out), 80)}). Nothing was recorded. The PR stays a draft.`)
  const prHead = typeof info.headRefOid === 'string' ? info.headRefOid : ''
  if (result.head !== prHead) {
    const named = branch ? ` (branch ${branch})` : ''
    return fail(
      `The checkout ${root} is at ${result.head.slice(0, 7)} but PR #${pr}${named} is at ${prHead.slice(0, 7)}: check out the PR branch at its head in any worktree, run pre-pr.mjs, then ask for the checkpoint again. Nothing was recorded.`,
    )
  }
  const subjects = await gitLines($, root, ['git', 'log', '--format=%s', '-n', '8', 'fork/main..HEAD'])
  const numstat = await gitLines($, root, ['git', 'diff', '--numstat', 'fork/main...HEAD'])
  return {
    ok: true,
    pending: { pr, body, root, result, covers: coversRows(subjects, numstat), stamp: await stampAt($, root), prHead, at: await $.clock.now() },
  }
}

/** Opens the pane. The pending pair stays in the store when the pane waits undrawn, so the command can open it later. */
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
  if (!placed.isPlaced) $.ui.toast(`PR #${pending.pr}: checkpoint ready, but the pane waits (${placed.reason}); type ${SLASH} to open it`, { timeoutMs: 15_000 })
  return placed
}

type Outcome =
  | { stage: 'confirm' | 'apply'; text: string }
  | { stage: 'done'; record: CheckpointRecord }

/** --apply for a confirmed record. A refusal keeps the record confirmed. */
const applyRecord = async ($: EngineInterface, root: string, record: CheckpointRecord): Promise<Outcome> => {
  const ran = await run($, engineArgv(await engineRoot($, root), '--apply', String(record.pr)), root, APPLY_TIMEOUT_MS)
  if (!ran.ok) return { stage: 'apply', text: `--apply could not run (${ran.text})` }
  if (ran.code !== 0) return { stage: 'apply', text: lastLine(ran.err || ran.out) || `--apply exited ${ran.code}` }
  const applied: CheckpointRecord = { ...record, state: 'applied', appliedAt: await $.clock.now() }
  await $.store.set(`${RECORD_PREFIX}${record.pr}`, applied)
  await enqueueApplied($, applied)
  return { stage: 'done', record: applied }
}

const isQueueBand = (band: unknown): band is string => typeof band === 'string' && QUEUE_BANDS.includes(band)

/** A coderabbit or both record in band HIGH or CRITICAL joins the free-slot queue, which posts its review. A failed add never fails the apply. */
const enqueueApplied = async ($: EngineInterface, record: CheckpointRecord): Promise<void> => {
  if ((record.pathway !== 'coderabbit' && record.pathway !== 'both') || !isQueueBand(record.band)) return
  await slotAdd($, { pr: record.pr, band: record.band, head: record.head, round: 1 }).catch(() => false)
}

/**
 * A round Dave allowed puts the PR back in the queue (awaiting the fix push). True only when the add exited 0: then the notice says the queue
 * posts. A record with no HIGH or CRITICAL band (an older record) is not queued and keeps the old notice. The head is the one the grant stores.
 */
const enqueueRound = async ($: EngineInterface, record: CheckpointRecord | null, round: number, head: string): Promise<boolean> => {
  if (!record || !isQueueBand(record.band)) return false
  return slotAdd($, { pr: record.pr, band: record.band, head, round }).catch(() => false)
}

/** --confirm then --apply, as the engine's two steps. Nothing is stored when --confirm refuses. */
const recordPathway = async (
  $: EngineInterface,
  a: { pr: number; root: string; body: string; result: CheckpointResult },
  pathway: string,
  by: string,
): Promise<Outcome> => {
  const ran = await run($, engineArgv(await engineRoot($, a.root), '--confirm', pathway, '--by', by, '--body', a.body), a.root, ENGINE_TIMEOUT_MS)
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
    // The router band, so the apply (and the retry of a refused apply) can queue the PR for the free CodeRabbit slot.
    band: a.result.auto?.band ?? null,
    pr: a.pr,
    state: 'confirmed',
    session: await sessionId($),
    capacity: a.result.capacity,
    root: a.root,
  } as CheckpointRecord
  // A grant belongs to the record it was made under (its budget and rounds). A new record voids it, or it would cover the new one.
  await $.store.delete(`${GRANT_PREFIX}${a.pr}`)
  // The queued asks of the old record go too: an old Yes would recreate the grant just deleted.
  const queued = await loadAsks($)
  const live = queued.filter(ask => ask.pr !== a.pr)
  if (live.length !== queued.length) {
    await saveAsks($, live)
    await closeIfIdle($)
  }
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

/** A press that threw after it set `running`: the pane must not stay on "Running" with its Buttons hidden. */
const freePane = async ($: EngineInterface, err: unknown, retry: { pathway: string } | null = null): Promise<void> => {
  await update($, checkpoint, v => (v ? { ...v, running: null, error: message(err), retry } : v))
}

/**
 * One pane press at a time (the module loads once per session). The `running` flag lives in the store, so two presses that land before the first write both read
 * "idle" and run the engine, or post a review request, twice. This flag is set before the first await and cleared in `finally`.
 */
let pressing = false
const exclusive = async (press: () => Promise<void>): Promise<void> => {
  if (pressing) return
  pressing = true
  try {
    await press()
  } finally {
    pressing = false
  }
}

// ---- auto-confirm (review factory step A, Dave 2026-11-01) --------------------------------------------------------------------
// The engine says a PR may be confirmed without a press (`result.auto.eligible`: band LOW, MID or ELEVATED, recommended none, config equal
// to main, labels read, kill switch checkpoint.autoConfirm on). The engine refuses a PR that touches a security-tier or critical file (the
// spec 3.1 floor: aegis + critic run before READY, so Dave presses). The kill switch ships false, so every checkpoint waits for Dave until
// he sets it true. The mod then records exactly what a press of `none` records, with decided_by
// "auto". Anything short of a clean record falls back to the pane ask. Interactive sessions only (a headless run gets the text plan).

type AutoOutcome = { kind: 'done'; record: CheckpointRecord } | { kind: 'failed'; why: string; stage: 'confirm' | 'apply' | 'check' }

/** Why the PR is no longer what the checkpoint read, or null: a second read right before the record (the first read was before the engine ran). */
const driftSince = async ($: EngineInterface, root: string, pending: Pending): Promise<string | null> => {
  const ran = await run($, viewArgv(pending.pr), root, VIEW_TIMEOUT_MS)
  if (!ran.ok) return `could not read the PR again (${ran.text})`
  if (ran.code !== 0) return `could not read the PR again (${firstLine(ran.err || ran.out) || `gh exited ${ran.code}`})`
  let info: { isDraft?: unknown; headRefOid?: unknown }
  try {
    info = JSON.parse(ran.out)
  } catch {
    return 'gh printed no JSON on the second read'
  }
  if (info.isDraft !== true) return 'the PR is no longer a draft'
  if (info.headRefOid !== pending.prHead) return `the head moved to ${typeof info.headRefOid === 'string' ? info.headRefOid.slice(0, 7) : 'an unknown commit'}`
  return null
}

/** null: the engine did not allow it, so nothing was tried. Otherwise the record, or why the pane must ask. Never throws. */
const autoConfirm = async ($: EngineInterface, pending: Pending): Promise<AutoOutcome | null> => {
  const { result } = pending
  // Both the engine's flag and the recommendation: a flag alone never records a pathway the engine does not recommend.
  if (result.auto.eligible !== true || result.recommended !== 'none') return null
  if (pressing) return { kind: 'failed', why: 'a pane press is running', stage: 'check' }
  pressing = true
  try {
    const drift = await driftSince($, pending.root, pending)
    if (drift) return { kind: 'failed', why: drift, stage: 'check' }
    const out = await recordPathway($, { pr: pending.pr, root: pending.root, body: pending.body, result }, 'none', 'auto')
    if (out.stage !== 'done') return { kind: 'failed', why: out.text, stage: out.stage }
    return { kind: 'done', record: out.record }
  } catch (err) {
    return { kind: 'failed', why: message(err), stage: 'check' }
  } finally {
    pressing = false
  }
}

/** The visible line to Dave and the note for the model. The pane is not opened, so an older pending checkpoint of this PR goes. */
const finishAuto = async ($: EngineInterface, record: CheckpointRecord, band: string | null): Promise<void> => {
  $.ui.toast(autoToast({ pr: record.pr, band }), { timeoutMs: 15_000 })
  const old = await loadPending($)
  if (old && old.pr === record.pr) await clearPending($)
  await tellModel($, autoNotice({ pr: record.pr, band, label: record.label, budget: record.budget }))
  await closeIfIdle($)
}

const pressOption = ($: EngineInterface, pathway: string, isRecommended: boolean): Promise<void> => exclusive(() => runOption($, pathway, isRecommended))

const runOption = async ($: EngineInterface, pathway: string, isRecommended: boolean): Promise<void> => {
  const view = await read($, checkpoint)
  if (!view || view.running !== null) return
  if (pathway === 'wait') {
    $.ui.toast(`PR #${view.pr} stays a draft`, { timeoutMs: 10_000 })
    await clearPending($)
    await closeIfIdle($)
    return
  }
  await update($, checkpoint, v => (v ? { ...v, running: pathway, error: null, retry: null } : v))
  try {
    const out = await recordPathway($, { pr: view.pr, root: view.root, body: view.body, result: view.result }, pathway, isRecommended ? 'default' : 'dave')
    if (out.stage === 'done') return await finishPress($, out.record)
    await update($, checkpoint, v => (v ? { ...v, running: null, error: out.text, retry: out.stage === 'apply' ? { pathway } : null } : v))
  } catch (err) {
    await freePane($, err)
  }
}

const pressRetry = ($: EngineInterface): Promise<void> => exclusive(() => runRetry($))

const runRetry = async ($: EngineInterface): Promise<void> => {
  const view = await read($, checkpoint)
  if (!view || view.running !== null || view.retry === null) return
  const record = readRecord(await $.store.get(`${RECORD_PREFIX}${view.pr}`))
  if (!record) return
  await update($, checkpoint, v => (v ? { ...v, running: 'apply', error: null } : v))
  try {
    const out = await applyRecord($, view.root, record)
    if (out.stage === 'done') return await finishPress($, out.record)
    await update($, checkpoint, v => (v ? { ...v, running: null, error: out.text, retry: { pathway: record.pathway } } : v))
  } catch (err) {
    await freePane($, err, { pathway: record.pathway })
  }
}

const pressDismiss = async ($: EngineInterface): Promise<void> => {
  await $.ui.close({ id: PANE })
}

/** A round allowed up to `allowed` clears only a round decline at or below it. An opening decline or a later round decline stays. */
const coverDecline = (stored: CheckpointRecord | null, allowed: number): { covered: boolean; retained: string | null } => {
  const covered = stored?.declined?.kind === 'round' && stored.declined.round <= allowed
  const retained = stored?.declined && !covered ? (stored.declined.kind === 'opening' ? 'the opening review' : `round ${stored.declined.round}`) : null
  return { covered, retained }
}

/** A lower grant never lowers a round Dave already allowed, whichever head that grant carries. */
const allowedRound = async ($: EngineInterface, pr: number, round: number): Promise<number> => {
  const prior = (await $.store.get(`${GRANT_PREFIX}${pr}`)) as { round?: unknown } | null | undefined
  return prior && typeof prior.round === 'number' ? Math.max(prior.round, round) : round
}

const keptNotice = (pr: number, round: number, retained: string): string =>
  `PR checkpoint: Dave allowed round ${round} for #${pr}, but his decline of ${retained} stays. Do not request that review.`

const askNotice = (ask: CheckpointAsk, answer: 'yes' | 'no', queued = false): string => {
  const round = ask.round ?? 1
  if (ask.kind === 'round') {
    if (answer === 'yes' && queued) return `PR checkpoint: Dave allowed round ${round} for #${ask.pr}: the free-slot queue posts @coderabbitai review after the fix push. Do not post it.`
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

type Staleness = { kind: 'open' } | { kind: 'gone'; why: string } | { kind: 'unreadable'; why: string }

/**
 * Whether a Yes may post: the PR must be open at the asked head. A post spends a review, so a state that cannot be read fails closed
 * (the question stays queued), as the post failure below does.
 */
const staleness = async ($: EngineInterface, root: string, ask: CheckpointAsk): Promise<Staleness> => {
  const ran = await run($, stateArgv(ask.pr), root, VIEW_TIMEOUT_MS)
  if (!ran.ok) return { kind: 'unreadable', why: ran.text }
  if (ran.code !== 0) return { kind: 'unreadable', why: firstLine(ran.err || ran.out) || `gh exited ${ran.code}` }
  let info: { state?: unknown; headRefOid?: unknown }
  try {
    info = JSON.parse(ran.out)
  } catch {
    return { kind: 'unreadable', why: 'gh printed no JSON' }
  }
  if (typeof info.state !== 'string' || typeof info.headRefOid !== 'string') return { kind: 'unreadable', why: 'gh printed no state or head' }
  if (info.state.toUpperCase() !== 'OPEN') return { kind: 'gone', why: `the PR is ${info.state.toLowerCase()}` }
  if (info.headRefOid !== ask.head) return { kind: 'gone', why: `the head moved to ${info.headRefOid.slice(0, 7)}` }
  return { kind: 'open' }
}

/** The PR's head now, or null when it cannot be read (no checkout, gh failed, no JSON). */
const currentHead = async ($: EngineInterface, pr: number): Promise<string | null> => {
  const root = await rootOf($)
  if (!root) return null
  const ran = await run($, stateArgv(pr), root, VIEW_TIMEOUT_MS)
  if (!ran.ok || ran.code !== 0) return null
  try {
    const head = (JSON.parse(ran.out) as { headRefOid?: unknown }).headRefOid
    return typeof head === 'string' && head !== '' ? head : null
  } catch {
    return null
  }
}

/** Dave's Yes or No on the first question. A Yes that posts a comment and fails leaves the question queued. */
const pressAsk = ($: EngineInterface, answer: 'yes' | 'no'): Promise<void> => exclusive(() => runAsk($, answer))

const runAsk = async ($: EngineInterface, answer: 'yes' | 'no'): Promise<void> => {
  const queue = await read($, checkpointAsks)
  const ask = queue[0]
  if (!ask) return
  const now = await $.clock.now()
  const key = `${RECORD_PREFIX}${ask.pr}`
  const stored = readRecord(await $.store.get(key))
  let next: CheckpointRecord | null = stored
  if (ask.kind !== 'round' && answer === 'yes') {
    const root = await rootOf($)
    // A question can wait for days (restore keeps it): a late Yes spends a review only on a PR that is still open at the asked head.
    const seen = root ? await staleness($, root, ask) : null
    if (seen && seen.kind === 'unreadable') {
      $.ui.toast(`PR #${ask.pr}: could not read the PR state (${seen.why}); nothing posted, the question stays queued`, { timeoutMs: 10_000 })
      return
    }
    if (seen && seen.kind === 'gone') {
      await saveAsks($, queue.slice(1))
      $.ui.toast(`PR #${ask.pr}: question dropped, nothing posted (${seen.why})`, { timeoutMs: 10_000 })
      await closeIfIdle($)
      return
    }
    const ran = root ? await run($, commentArgv(ask.pr, ask.kind === 'opening' ? '@coderabbitai review' : '@greptileai'), root, VIEW_TIMEOUT_MS) : null
    if (!ran || !ran.ok || ran.code !== 0) {
      $.ui.toast(`PR #${ask.pr}: could not post the request (${ran ? (ran.ok ? firstLine(ran.err) : ran.text) : 'no checkout'}); it stays queued`, { timeoutMs: 10_000 })
      return
    }
  }
  let retained: string | null = null
  let queued = false
  if (ask.kind === 'round' && answer === 'yes') {
    // The same rule as the typed grant (D-a, Dave 11-01): only a round decline this Yes covers goes.
    const allowed = await allowedRound($, ask.pr, ask.round ?? 1)
    await $.store.set(`${GRANT_PREFIX}${ask.pr}`, { round: allowed, head: ask.head, at: now })
    const cover = coverDecline(next, allowed)
    retained = cover.retained
    if (next && cover.covered) {
      const { declined: _declined, ...rest } = next
      next = rest as CheckpointRecord
    }
    queued = retained === null && (await enqueueRound($, stored, allowed, ask.head))
  } else if (next) {
    if (ask.kind === 'opening') next = answer === 'yes' ? { ...next, opened: { head: ask.head, at: now } } : { ...next, declined: { kind: 'opening', round: 1, head: ask.head } }
    else if (ask.kind === 'round') next = { ...next, declined: { kind: 'round', round: ask.round ?? 1, head: ask.head } }
    else next = { ...next, greptile: answer === 'yes' ? { head: ask.head, at: now } : { declined: true } }
  }
  if (next && next !== stored) await $.store.set(key, next)
  await saveAsks($, queue.slice(1))
  await tellModel($, retained ? keptNotice(ask.pr, ask.round ?? 1, retained) : askNotice(ask, answer, queued))
  await closeIfIdle($)
}

// ---- the tool and the command -------------------------------------------------------------------------------------------------

/** The tool: headless gets the text plan; an interactive session gets the pane. Returns the text for the model. */
const toolText = async ($: EngineInterface, pr: number, body: string): Promise<string> => {
  const root = await rootOf($)
  if (!root) return `pr_checkpoint runs in a CCv3 checkout (it needs ${ENGINE_REL} in the session root). Nothing was recorded.`
  if (!(await interactive($))) {
    if (!(await $.fs.exists(resolveBody(root, body)))) return missingBody(body, root)
    return textPlan($, root)
  }
  const prepared = await prepare($, root, pr, body)
  if (!prepared.ok) return prepared.text
  const auto = await autoConfirm($, prepared.pending)
  if (auto?.kind === 'done') {
    await finishAuto($, auto.record, prepared.pending.result.auto.band)
    return `The checkpoint for #${pr} was auto-confirmed: band ${prepared.pending.result.auto.band ?? 'unknown'}, none (${auto.record.label ?? 'no label'}). The mod added the label and marked the PR ready. No press is needed. pr_watch continues. Do not merge.`
  }
  const placed = await show($, prepared.pending)
  const lead = auto ? `Auto-confirm was not possible (${auto.why}), so the checkpoint for #${pr} waits for Dave. ` : ''
  if (auto?.stage === 'apply') await update($, checkpoint, v => (v ? { ...v, error: auto.why, retry: { pathway: 'none' } } : v))
  if (placed.isPlaced) return `${lead}The checkpoint for #${pr} is in Dave's side pane. ${WAIT_FOR_PRESS}`
  return `${lead}The checkpoint for #${pr} is ready, but the pane could not be placed (${placed.reason}). Dave types ${SLASH} to open it. ${WAIT_FOR_PRESS}`
}


/**
 * `/pathway grant <pr> <round>`: Dave allows a review round the pane did not ask about, or one he declined. It stores the grant
 * (`checkpoint:grant:<pr>`) on the record's head and clears a round decline it covers. Only his own composer command writes. It posts nothing.
 */
const grantCommand = async ($: EngineInterface, origin: string, grant: { pr: number; round: number }): Promise<{ text: string }> => {
  if (origin !== 'composer' || !(await interactive($))) return { text: `Only Dave's own ${SLASH} grant records. Nothing was recorded.` }
  const key = `${RECORD_PREFIX}${grant.pr}`
  const stored = readRecord(await $.store.get(key))
  if (!stored) return { text: `PR #${grant.pr} has no checkpoint record. Run ${SLASH} on it first. Nothing was recorded.` }
  // A lower grant never lowers a round Dave already allowed, whichever head that grant carries (the pane stores the PR head at ask time).
  // A grant never outlives its checkpoint record: recordPathway deletes it, so a stored grant belongs to this record.
  const allowed = await allowedRound($, grant.pr, grant.round)
  await $.store.set(`${GRANT_PREFIX}${grant.pr}`, { round: allowed, head: stored.head, at: await $.clock.now() })
  // Only a round decline the grant covers goes. An opening decline or a decline of a later round stays, or the watcher asks again.
  const { covered, retained } = coverDecline(stored, allowed)
  try {
    if (covered) {
      const { declined: _declined, ...rest } = stored
      await $.store.set(key, rest as CheckpointRecord)
    }
    // A queued round ask this grant covers is answered: a later No in the pane would write `declined`, which the model line reads before the grant.
    const queue = await loadAsks($)
    const kept = queue.filter(ask => !(ask.kind === 'round' && ask.pr === grant.pr && (ask.round ?? 1) <= allowed))
    if (kept.length !== queue.length) {
      await saveAsks($, kept)
      await closeIfIdle($)
    }
  } catch (err) {
    // The grant is already stored and the watcher reads it, so say so. The decline or the queued ask may still be there.
    await tellModel($, `PR checkpoint: Dave allowed round ${grant.round} for #${grant.pr}, but the cleanup failed (${message(err)}). Read pr_status before you request a review.`)
    return { text: `PR #${grant.pr}: the grant is stored for round ${grant.round}, but the cleanup failed (${message(err)}). A decline or a queued ask may remain. Type the command again.` }
  }
  if (retained) {
    await tellModel($, keptNotice(grant.pr, grant.round, retained))
    return { text: `PR #${grant.pr}: round ${grant.round} allowed. His decline of ${retained} stays.` }
  }
  // The grant comes after fix pushes, so the record head is stale. The add carries the PR's head now; an unreadable head queues nothing.
  const head = await currentHead($, grant.pr)
  const queued = head !== null && (await enqueueRound($, stored, allowed, head))
  await tellModel($, askNotice({ kind: 'round', pr: grant.pr, head: head ?? stored.head, text: '', round: grant.round }, 'yes', queued))
  const next = queued ? 'the free-slot queue posts @coderabbitai review' : 'post one @coderabbitai review'
  return { text: `PR #${grant.pr}: round ${grant.round} allowed. After the fix push, ${next}.` }
}

type CommandEvent = { args: string; origin: { kind: string } }
type CommandReply = { text: string; context?: string[] }
/** What one /pathway did, for its log line. `outcome` stays 'error' when the command throws. */
type Trace = { outcome: string; root: string | null; checkout: string | null }

const PATHWAY_LOG = `${DIAG_DIR}/pathway-commands.jsonl`
const PATHWAY_LOG_LINES = 500

/**
 * One JSON line per /pathway in ~/.claude/state/ccv3-mods/pathway-commands.jsonl, the newest 500 kept. The args hold a body PATH at most;
 * no file is read for the line. The fs API has no append, so two sessions that write at the same moment can lose one line: accepted.
 * A failed write never touches the command.
 */
const logCommand = async ($: EngineInterface, e: CommandEvent, trace: Trace): Promise<void> => {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (!home) return
    const entry = {
      ts: new Date(await $.clock.now()).toISOString(),
      session: await sessionId($),
      origin: e.origin.kind,
      args: clip(e.args, 200),
      mode: (await interactive($)) ? 'interactive' : 'headless',
      root: trace.root,
      checkout: trace.checkout,
      outcome: trace.outcome,
    }
    const path = `${home}/${PATHWAY_LOG}`
    const old = await $.fs.read(path).then(text => (typeof text === 'string' ? text : ''), () => '')
    const kept = old.split('\n').filter(line => line.trim() !== '').slice(-(PATHWAY_LOG_LINES - 1))
    await $.fs.write(path, `${[...kept, JSON.stringify(entry)].join('\n')}\n`)
  } catch {
    // Diagnostics only.
  }
}

/** The command (SLASH). It answers its own command: Dave's text, and one hidden line for the model. It never calls prompt.submit. Every run leaves one log line. */
const checkpointCommand = async ($: EngineInterface, e: CommandEvent): Promise<CommandReply> => {
  const trace: Trace = { outcome: 'error', root: null, checkout: null }
  try {
    return await commandReply($, e, trace)
  } finally {
    await logCommand($, e, trace)
  }
}

/** A reply that notes its outcome for the log line. */
const sayer = (trace: Trace) => (outcome: string, text: string, context?: string[]): CommandReply => {
  trace.outcome = outcome
  return context ? { text, context } : { text }
}

/** A bare /pathway: the pane in Dave's terminal; on the bridge (a phone, no pane) the pending PR and the command to type. */
const bareCommand = async ($: EngineInterface, e: CommandEvent, live: boolean, pending: Pending | null, trace: Trace): Promise<CommandReply> => {
  const say = sayer(trace)
  if (!live) return say('need-pr', NEED_PR)
  if (e.origin.kind === 'bridge') {
    if (!pending) return say('need-pr', NEED_PR)
    trace.root = await rootOf($)
    trace.checkout = pending.root
    return say('bridge-prompt', await bridgePrompt($, pending))
  }
  const queued = await loadAsks($)
  if (!pending && queued.length === 0) return say('need-pr', NEED_PR)
  if (pending && (await read($, checkpoint)) === null) await update($, checkpoint, () => viewOf(pending))
  if (queued.length > 0 && (await read($, checkpointAsks)).length === 0) await update($, checkpointAsks, () => queued)
  const placed = await openPane($)
  if (placed.isPlaced) return say('pane', 'The checkpoint is in the side pane.')
  return say('pane-unplaced', `The pane could not be placed (${placed.reason}). Widen the terminal, then type ${SLASH} again.`)
}

const commandReply = async ($: EngineInterface, e: CommandEvent, trace: Trace): Promise<CommandReply> => {
  const say = sayer(trace)
  const grant = parseGrantArgs(e.args)
  if (grant === 'usage') return say('usage', USAGE)
  if (grant) return say('grant', (await grantCommand($, e.origin.kind, grant)).text)
  const parsed = parseCheckpointArgs(e.args)
  if (!parsed) return say('usage', USAGE)
  const live = await interactive($)
  const pending = await loadPending($)
  if (parsed.pr === null && parsed.word === null && parsed.body === null) return bareCommand($, e, live, pending, trace)
  const pr = parsed.pr ?? pending?.pr ?? null
  const body = parsed.body ?? (pending && pending.pr === pr ? pending.body : null)
  if (pr === null || body === null) return say('need-pr', NEED_PR)
  const root = await rootOf($)
  trace.root = root
  if (!root) return say('refused', `${SLASH} runs in a CCv3 checkout (it needs ${ENGINE_REL} in the session root). Nothing was recorded.`)
  // Dave's own composer command records. So does a bridge command (Remote Control from his phone, Dave 2026-11-02) for the PR whose
  // checkpoint waits in THIS session. A plugin, the SDK, any other origin, a bridge command for another PR or a headless run gets the text plan.
  const phone = live && e.origin.kind === 'bridge' && pending && pending.pr === pr ? pending : null
  if (!live || (e.origin.kind !== 'composer' && !phone)) {
    // The plan is read where the pre-pr stamp lives: the pending checkpoint's checkout, else the worktree of the PR branch (one gh read).
    // A headless run makes no gh call. Nothing is recorded from here.
    const checkout = !live ? root : pending && pending.pr === pr ? pending.root : await checkoutOfPr($, root, pr)
    trace.checkout = checkout
    if ((await bodyIn($, checkout, root, body)) === null) return say('refused', missingBody(body, checkout, root))
    return say('text-plan', await textPlan($, root, checkout, live ? e.origin.kind : null, pending?.pr ?? null))
  }
  if (phone && parsed.word === null) {
    trace.checkout = phone.root
    return say('bridge-prompt', await bridgePrompt($, phone))
  }
  const prepared = await prepare($, root, pr, body)
  if (!prepared.ok) return say('refused', prepared.text)
  const next = prepared.pending
  trace.checkout = next.root
  if (parsed.word === null) {
    const placed = await show($, next)
    if (placed.isPlaced) return say('pane', `The checkpoint for #${pr} is in the side pane.`)
    return say('pane-unplaced', `The pane could not be placed (${placed.reason}). Widen the terminal, then type ${SLASH} again.`)
  }
  if (parsed.word === 'wait') return say('wait', `PR #${pr} stays a draft. Nothing was recorded.`)
  const result = next.result
  const pathway = parsed.word === 'accept' ? result.recommended : parsed.word
  if (!pathway) return say('refused', `There is no recommendation: ${result.why[0] ?? 'run pre-pr.mjs'}. Nothing was recorded.`)
  const option = result.options.find(one => one.pathway === pathway)
  if (!option || !option.available) return say('refused', `Pathway ${pathway} is not available${option ? `: ${option.reason}` : ''}. Nothing was recorded.`)
  const by = parsed.word === 'accept' ? 'default' : 'dave'
  const out = await recordPathway($, { pr, root: next.root, body: next.body, result }, pathway, by)
  if (out.stage !== 'done') {
    return say('not-recorded', out.stage === 'apply' ? `PR #${pr}: ${pathway} is confirmed, but --apply was refused: ${out.text}` : `PR #${pr}: ${pathway} was not recorded: ${out.text}`)
  }
  const record = out.record
  if (pending && pending.pr === pr) {
    await clearPending($)
    await closeIfIdle($)
  }
  $.ui.toast(`PR #${pr}: ${pathway} recorded, the PR is ready`, { timeoutMs: 10_000 })
  return say(
    'recorded',
    `PR #${pr}: ${pathway} recorded (${record.label ?? 'no label'}, ${costText(record.budget)}, by ${by}). The label is on the PR and it is ready.`,
    [pressNotice({ pr, pathway, label: record.label, budget: record.budget, by })],
  )
}

// ---- the lock ---------------------------------------------------------------------------------------------------------------
// Lock A denies a tool write to pathway.json. Lock B reads shell text: it denies any text that names the file, and asks the built
// shapes CLI (one parser, no lexer here) about ready, a review: label and a self-confirm. Any failure after a prefilter hit denies.

const lockFailure = (what: string): Error => new Error(`${LOCK_FAILED}: ${what}`)

/** The shapes of the gate's own readers for this command. A failure of any kind throws: the .catch denies, in both modes. */
const readShapes = async ($: EngineInterface, root: string, command: string, shell: 'bash' | 'pwsh'): Promise<LockShapes> => {
  let ran
  try {
    ran = await $.process.run(['node', `${root}/${SHAPES_CLI_REL}`, '--shell', shell], { cwd: root, stdin: command, timeoutMs: SHAPES_TIMEOUT_MS })
  } catch (err) {
    throw lockFailure(`the shapes CLI did not run (${message(err)})`)
  }
  if (ran.exitCode !== 0) throw lockFailure(`the shapes CLI exited ${ran.exitCode}`)
  const shapes = parseShapes(ran.stdout)
  if (!shapes) throw lockFailure('the shapes CLI printed no shapes')
  return shapes
}

/** A label add passes only with a store record for this PR number, this HEAD and this label. The store is read before git. */
const labelAllowed = async ($: EngineInterface, root: string, command: string, shapes: LockShapes): Promise<boolean> => {
  const labels = shapes.label?.labels ?? []
  const pr = editedPr(command)
  if (shapes.label?.blind || labels.length !== 1 || pr === null) return false
  const stored = await $.store.get(`${RECORD_PREFIX}${pr}`)
  if (stored === undefined || stored === null) return false
  // HEAD of the checkout the record came from (the PR branch worktree), else the session root. Only the mod writes the store.
  const recorded = (stored as { root?: unknown }).root
  const cwd = typeof recorded === 'string' && recorded.length > 0 ? recorded : root
  const head = await $.process.run(['git', 'rev-parse', 'HEAD'], { cwd, timeoutMs: GIT_TIMEOUT_MS })
  if (head.exitCode !== 0) throw lockFailure('git rev-parse HEAD failed')
  return recordAllowsLabel(stored, pr, head.stdout.trim(), labels[0]!)
}

const patternsOf = async ($: EngineInterface, root: string, command: string, shapes: LockShapes): Promise<LockPattern[]> => {
  const found: LockPattern[] = []
  if (shapes.self) found.push('self-confirm')
  if (shapes.ready) found.push('ready')
  if (labelNeedsRecord(shapes) && !(await labelAllowed($, root, command, shapes))) found.push('review-label')
  return found
}

/**
 * Only a boolean true enforces. A missing or unreadable config is warn mode HERE, unlike the pre-PR gate. With no readable config, the gate
 * enforces a command that names CCv3, a self-confirm, and any command that runs in a CCv3 checkout. The mod has no lexer to read a repo
 * name or a cwd, so it only warns. For those commands the gate still denies, and the two layers together deny. A readable config keeps
 * its own value in both layers.
 * The config is the SESSION ROOT's, not the command's cwd. The PR B gate reads the git toplevel of the cwd, so a Bash call that `cd`s into
 * another worktree can meet a different `enforce` here than in the gate below. Accepted: the mod has no shell lexer to find the cwd, and
 * the gate still decides for that cwd; the mod only warns or denies by the root it was started in.
 */
const enforcing = async ($: EngineInterface, root: string): Promise<boolean> => {
  try {
    const config = JSON.parse(await $.fs.read(`${root}/${CONFIG_REL}`)) as { checkpoint?: { enforce?: unknown } } | null
    return config?.checkpoint?.enforce === true
  } catch {
    return false
  }
}

/** Warn mode: one toast per pattern per session. */
const warnOnce = async ($: EngineInterface, patterns: LockPattern[]): Promise<void> => {
  const shown = await read($, lockWarned)
  const fresh = patterns.filter(one => !shown.includes(one))
  if (fresh.length === 0) return
  await update($, lockWarned, list => [...list, ...fresh])
  for (const one of fresh) await $.ui.toast(lockWarn(one), { timeoutMs: 10_000 })
}

type ShellCall = { command?: unknown }

/**
 * The verdict for one shell command: a deny, or null to let it go on. Any failure after a prefilter hit is a deny, in both modes.
 * The kill-switch read is inside the try as well: a throw from env.get must be answered here, like Lock A's (writeLock).
 * It is answered here and not left to `.catch`: under an outer unmatched hook (the Agentic OS observer) the engine drops a `.catch` deny
 * of a hook that threw, while a plain return survives (scratchpad repro, kit 2.1.312).
 */
const shellLock = async ($: EngineInterface, e: ShellCall, shell: 'bash' | 'pwsh'): Promise<{ deny: string } | null> => {
  try {
    if (await isOff($)) return null
    const command = typeof e.command === 'string' ? e.command : ''
    if (namesPathway(command)) return { deny: PATHWAY_DENY }
    if (namesSlotWrite(command)) return { deny: SLOT_DENY }
    if (namesMarker(command)) return { deny: MARKER_DENY }
    if (!mayBeGated(command)) return null
    // The root lookup is not rootOf(): that one answers "no checkout" for a lookup that threw. Here only a clean `false` means "not CCv3";
    // a throw from session.root or fs.exists reaches the catch below and denies, as the other failures after a prefilter hit do.
    const root = await $.session.root()
    if ((await $.fs.exists(`${root}/${ENGINE_REL}`)) === false) return null
    const patterns = await patternsOf($, root, command, await readShapes($, root, command, shell))
    if (patterns.length === 0) return null
    if (await enforcing($, root)) return { deny: lockDeny(patterns) }
    await warnOnce($, patterns)
    return null
  } catch {
    return { deny: LOCK_FAILED }
  }
}

type WriteCall = { file_path?: unknown; notebook_path?: unknown }

/**
 * Lock A's verdict for one tool write: a deny, or null to let it go on. Like shellLock, it answers a failure by its own return and does not
 * leave the deny to `.catch`, which an outer unmatched hook can drop. `next` is called outside, so a throw never denies a write that ran.
 */
const writeLock = async ($: EngineInterface, e: WriteCall): Promise<{ deny: string } | null> => {
  try {
    if (await isOff($)) return null
    const path = typeof e.file_path === 'string' ? e.file_path : typeof e.notebook_path === 'string' ? e.notebook_path : null
    if (path === null) return null
    if (isPathwayFile(path)) return { deny: PATHWAY_DENY }
    return isSlotStateFile(path) ? { deny: SLOT_DENY } : null
  } catch {
    return { deny: LOCK_FAILED }
  }
}

/** One module's part of session.start, on either trigger. The tool and the command register in both modes; the pane is interactive only. */
const start = async ($: EngineInterface, isInteractive: boolean): Promise<void> => {
  // The mode first: a throw below must not leave the default ('interactive') in place for a headless run.
  await update($, mode, () => (isInteractive ? 'interactive' : 'headless'))
  if (await isOff($)) return
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
          body: { type: 'string', description: 'The PR body file that pre-pr.mjs --body checked (absolute, or relative to the PR branch worktree or the session root; a headless run looks in the session root only)' },
        },
        required: ['pr', 'body'],
      },
    })
  } catch {
    // The command and the pane still load.
  }
  try {
    await $.command.register({
      name: COMMAND,
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
    // The command reads the store again.
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

  // Lock A: no tool writes pathway.json. Always enforced, warn mode included.
  on('tool.call', { tool: /^(Write|Edit|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => (await writeLock($, e as unknown as WriteCall)) ?? next(e)).catch(($, e, next) => (next.called ? next(e) : { deny: LOCK_FAILED }))

  // Lock B: shell text. Judge first, call next last, so a throw never denies a command that already ran.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => (await shellLock($, e as unknown as ShellCall, 'bash')) ?? next(e)).catch(($, e, next) => (next.called ? next(e) : { deny: LOCK_FAILED }))

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => (await shellLock($, e as unknown as ShellCall, 'pwsh')) ?? next(e)).catch(($, e, next) => (next.called ? next(e) : { deny: LOCK_FAILED }))

  on('command.run', { command: COMMAND }, ($, e) => checkpointCommand($, e)).catch(() => ({
    text: `${SLASH} failed. Nothing was recorded.`,
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
      const { buttons, held, recommendedFirst } = optionsInOrder(view.result)
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
                {...(i === 0 && recommendedFirst ? { autoFocus: true as const, variant: 'primary' as const } : {})}
                onPress={() => void pressOption($, one.pathway, i === 0 && recommendedFirst).catch(() => undefined)}
              >
                {optionLabel(one, i === 0 && recommendedFirst)}
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
  }).catch(($, e, next) => next(e))
}
