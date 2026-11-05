import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { CheckpointRecord, CheckpointResult } from '../../types'
import { isPrNumber, readRecord } from '../pr-loop/model'
import { QUEUE_BANDS, slotAdd } from '../pr-loop/slot'
import { DIAG_DIR } from '../shared/diag'
import { askDave, freeDialog, message, run, takeDialog, tellModel } from './ask'
import {
  APPLY_TIMEOUT_MS,
  BUSY_TEXT,
  COMMAND,
  CONFIG_REL,
  ENGINE_REL,
  ENGINE_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  LOCK_FAILED,
  MARKER_DENY,
  NEED_PR,
  PATHWAY_DENY,
  RETRY_LABELS,
  SLOT_DENY,
  STORE_DENY,
  SHAPES_CLI_REL,
  SHAPES_TIMEOUT_MS,
  SLASH,
  SUBAGENT_WHY,
  TOOL_NAME,
  USAGE,
  ageText,
  autoNotice,
  autoToast,
  buildPathwayAsk,
  clip,
  closedText,
  costText,
  coversRows,
  editedPr,
  emptyText,
  engineArgv,
  firstLine,
  isPathwayFile,
  isSlotStateFile,
  isStoreFile,
  isStalePending,
  keptDraftText,
  labelNeedsRecord,
  lastLine,
  lockDeny,
  lockWarn,
  mayBeGated,
  movedText,
  namesMarker,
  namesPathway,
  namesSlotWrite,
  namesStore,
  noQuestionText,
  onlyDaveRecordsNone,
  otherText,
  parseCheckpointArgs,
  parseGrantArgs,
  parseResult,
  parseShapes,
  pathwayOfAnswer,
  pressNotice,
  recordAllowsLabel,
  resolveBody,
  riskHighOf,
  stateArgv,
  viewArgv,
  WORKTREE_ARGV,
  samePath,
  worktreeFor,
} from './model'
import type { LockPattern, LockShapes, PathwayChoice } from './model'
import { GRANT_PREFIX, RECORD_PREFIX, allowedRound, askNotice, coverDecline, currentHead, enqueueRound, keptNotice, loadAsks, raiseQueued, rootOf, saveAsks } from './tick-asks'

/** The same atom the other modules declare (same plugin and key, same default): an atom is read only where it is declared. */
const mode = atom({ plugin: 'ccv3-mods', key: 'mode' } as const, 'interactive' as 'interactive' | 'headless')
/** The lock patterns already shown in a warn toast this session. */
const lockWarned = atom({ plugin: 'ccv3-mods', key: 'lockWarned' } as const, [] as string[])

const TOOL = `mcp__ccv3-mods__${TOOL_NAME}`
const PENDING_PREFIX = 'checkpoint:pending:'
const VIEW_TIMEOUT_MS = 30_000
/** A refused --apply offers Retry at most this many times in one call. */
const MAX_RETRIES = 3

/** A mod-served MCP tool answers with a list of content blocks (see pr-loop). */
const textResult = (text: string) => ({ result: [{ type: 'text', text }] })

/** CCV3_MODS_OFF=1 or CCV3_PR_CHECKPOINT_OFF=1 keeps the whole module inert. */
const isOff = async ($: EngineInterface): Promise<boolean> =>
  (await $.env.get('CCV3_MODS_OFF')) === '1' || (await $.env.get('CCV3_PR_CHECKPOINT_OFF')) === '1'

const interactive = async ($: EngineInterface): Promise<boolean> => (await read($, mode)) === 'interactive'

const sessionId = async ($: EngineInterface): Promise<string> => $.session.id()

// ---- store -----------------------------------------------------------------------------------------------------------------

/** riskHigh: whether the PR carried risk:high when the checkpoint read it (null: unread; absent: a pending stored by an older mod). A flip makes the recommendation stale. */
type Pending = { pr: number; body: string; root: string; result: CheckpointResult; covers: string[]; stamp: string | null; prHead: string; at: number; riskHigh?: boolean | null }

const isPending = (value: unknown): value is Pending => {
  const p = value as Partial<Pending> | null | undefined
  return !!p && Number.isInteger(p.pr) && typeof p.body === 'string' && typeof p.root === 'string' && typeof p.prHead === 'string' && !!p.result && Array.isArray(p.result.options)
}

const loadPending = async ($: EngineInterface): Promise<Pending | null> => {
  const value = await $.store.get(`${PENDING_PREFIX}${await sessionId($)}`)
  return isPending(value) ? value : null
}

const clearPending = async ($: EngineInterface): Promise<void> => {
  await $.store.delete(`${PENDING_PREFIX}${await sessionId($)}`)
}

/** Drops a pending checkpoint that nobody touched for a week. */
const restore = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (key.startsWith(PENDING_PREFIX) && isStalePending(await $.store.get(key), now)) await $.store.delete(key)
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
 * `why` replaces that sentence (a subagent call).
 */
const textPlan = async ($: EngineInterface, root: string, checkout: string = root, via: string | null = null, waiting: number | null = null, why?: string): Promise<string> => {
  const ran = await run($, engineArgv(root), checkout, ENGINE_TIMEOUT_MS)
  if (!ran.ok) return `pr-checkpoint could not run (${ran.text}). Nothing was recorded. The PR stays a draft.`
  const out = (ran.out || ran.err).trim()
  return `${out}\nNothing was recorded. The PR stays a draft. ${why ?? whyTextOnly(via, waiting)}`
}

const whyTextOnly = (via: string | null, waiting: number | null): string => {
  if (via === null) return `This session is headless, so ${SLASH} only shows the plan. Dave runs ${SLASH} in an interactive session.`
  const where = `This ${SLASH} came from ${via}, not Dave's terminal composer, so it only shows the plan. Dave types ${SLASH} in the composer to record it.`
  if (via !== 'bridge') return where
  return `${where} From the bridge, ${SLASH} records only the PR whose checkpoint waits in this session (${waiting === null ? 'none waits now' : `#${waiting}`}).`
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
  let info: { isDraft?: unknown; headRefOid?: unknown; headRefName?: unknown; author?: { login?: unknown }; labels?: unknown }
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
    pending: { pr, body, root, result, covers: coversRows(subjects, numstat), stamp: await stampAt($, root), prHead, at: await $.clock.now(), riskHigh: riskHighOf(info.labels) },
  }
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

/** --confirm then --apply, as the engine's two steps. Nothing is stored when --confirm refuses. */
const recordPathway = async (
  $: EngineInterface,
  a: { pr: number; root: string; body: string; result: CheckpointResult },
  pathway: string,
  by: string,
  via: NonNullable<CheckpointRecord['via']>,
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
    // How the pick arrived. land-none-check.mjs refuses a HIGH or CRITICAL none that did not come from Dave's dialog or composer.
    via,
    // The router band, so the apply (and the retry of a refused apply) can queue the PR for the free CodeRabbit slot.
    band: a.result.auto?.band ?? null,
    // The changed-file count prices the "up to $X" of a later question.
    files: a.result.size.files,
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
  if (live.length !== queued.length) await saveAsks($, live)
  await $.store.set(`${RECORD_PREFIX}${a.pr}`, stored)
  return applyRecord($, a.root, stored)
}

/** Why the PR is no longer what the checkpoint read, or null: a second read right before the record (the first read was before the engine ran). */
const driftSince = async ($: EngineInterface, root: string, pending: Pending): Promise<string | null> => {
  const ran = await run($, viewArgv(pending.pr), root, VIEW_TIMEOUT_MS)
  if (!ran.ok) return `could not read the PR again (${ran.text})`
  if (ran.code !== 0) return `could not read the PR again (${firstLine(ran.err || ran.out) || `gh exited ${ran.code}`})`
  let info: { isDraft?: unknown; headRefOid?: unknown; labels?: unknown }
  try {
    info = JSON.parse(ran.out)
  } catch {
    return 'gh printed no JSON on the second read'
  }
  if (info.isDraft !== true) return 'the PR is no longer a draft'
  if (info.headRefOid !== pending.prHead) return `the head moved to ${typeof info.headRefOid === 'string' ? info.headRefOid.slice(0, 7) : 'an unknown commit'}`
  // The band reads risk:high, so a flip changes the recommendation Dave answered. The engine re-reads the labels but cannot know what he saw.
  if (typeof pending.riskHigh === 'boolean') {
    const now = riskHighOf(info.labels)
    if (now === null) return 'the PR labels could not be read again'
    if (now !== pending.riskHigh) return `the risk:high label was ${now ? 'added' : 'removed'}, so the recommendation changed`
  }
  return null
}

// ---- auto-confirm (review factory step A, Dave 2026-11-01) --------------------------------------------------------------------
// The engine says a PR may be confirmed without an answer (`result.auto.eligible`: band LOW, MID or ELEVATED, recommended none, config equal
// to main, labels read, kill switch checkpoint.autoConfirm on). The engine refuses a PR that touches a security-tier or critical file (the
// spec 3.1 floor: aegis + critic run before READY, so Dave answers). The kill switch ships false, so every checkpoint waits for Dave until
// he sets it true. The mod then records exactly what an answer of `none` records, with decided_by "auto". Anything short of a clean
// record falls back to the question. Interactive sessions only (a headless run gets the text plan). The caller holds the dialog flag.

type AutoOutcome = { kind: 'done'; record: CheckpointRecord } | { kind: 'failed'; why: string; stage: 'confirm' | 'apply' | 'check' }

/** null: the engine did not allow it, so nothing was tried. Otherwise the record, or why the question must ask. Never throws. */
const autoConfirm = async ($: EngineInterface, pending: Pending): Promise<AutoOutcome | null> => {
  const { result } = pending
  // Both the engine's flag and the recommendation: a flag alone never records a pathway the engine does not recommend.
  if (result.auto.eligible !== true || result.recommended !== 'none') return null
  try {
    const drift = await driftSince($, pending.root, pending)
    if (drift) return { kind: 'failed', why: drift, stage: 'check' }
    const out = await recordPathway($, { pr: pending.pr, root: pending.root, body: pending.body, result }, 'none', 'auto', 'auto')
    if (out.stage !== 'done') return { kind: 'failed', why: out.text, stage: out.stage }
    return { kind: 'done', record: out.record }
  } catch (err) {
    return { kind: 'failed', why: message(err), stage: 'check' }
  }
}

/** The visible line to Dave and the note for the model. An older pending checkpoint of this PR goes. */
const finishAuto = async ($: EngineInterface, record: CheckpointRecord, band: string | null): Promise<void> => {
  $.ui.toast(autoToast({ pr: record.pr, band }), { timeoutMs: 15_000 })
  const old = await loadPending($)
  if (old && old.pr === record.pr) await clearPending($)
  await tellModel($, autoNotice({ pr: record.pr, band, label: record.label, budget: record.budget }))
}

// ---- the question -------------------------------------------------------------------------------------------------------------------
// The mod raises the dialog itself ($.ui.ask) and waits for the answer inside the call. Only an exact match of one of its own labels records.
// Esc, free text, an empty answer, a moved head or a refusal records nothing, and the PR stays a draft.

/** A checkpoint that Dave answered: toast and the pending checkpoint goes. */
const finishPress = async ($: EngineInterface, record: CheckpointRecord): Promise<void> => {
  $.ui.toast(`PR #${record.pr}: ${record.pathway} recorded, the PR is ready`, { timeoutMs: 10_000 })
  await clearPending($)
}

type Asked = { text: string; recorded: CheckpointRecord | null }

const refusedText = (pr: number, pathway: string, out: Exclude<Outcome, { stage: 'done' }>): string =>
  out.stage === 'apply'
    ? `PR #${pr}: ${pathway} is confirmed, but --apply was refused: ${out.text}. The PR stays a draft.`
    : `PR #${pr}: ${pathway} was not recorded: ${out.text}.`

/** Records Dave's pick. A refused --apply raises one Retry dialog per refusal. Nothing is recorded when the PR moved while he answered. */
const recordChoice = async ($: EngineInterface, pending: Pending, choice: PathwayChoice): Promise<Asked> => {
  const { pr } = pending
  const drift = await driftSince($, pending.root, pending)
  if (drift) return { text: movedText(pr, drift), recorded: null }
  try {
    let out = await recordPathway($, { pr, root: pending.root, body: pending.body, result: pending.result }, choice.pathway, choice.by, 'dialog')
    for (let tries = 0; out.stage === 'apply' && tries < MAX_RETRIES; tries += 1) {
      const record = readRecord(await $.store.get(`${RECORD_PREFIX}${pr}`))
      if (!record) break
      const retry = await askDave($, `${refusedText(pr, choice.pathway, out)} Retry the apply?`, RETRY_LABELS, clip(`PR #${pr}`, 12))
      if (retry.kind !== 'text' || retry.text !== RETRY_LABELS[0]) break
      out = await applyRecord($, pending.root, record)
    }
    if (out.stage !== 'done') return { text: refusedText(pr, choice.pathway, out), recorded: null }
    await finishPress($, out.record)
    return { text: pressNotice({ pr, pathway: out.record.pathway, label: out.record.label, budget: out.record.budget, by: out.record.decided_by }), recorded: out.record }
  } catch (err) {
    return { text: `PR #${pr}: ${choice.pathway} was not recorded (${message(err)}). The PR stays a draft.`, recorded: null }
  }
}

/**
 * Raises the checkpoint question for a pending checkpoint and acts on the answer. The caller holds the dialog flag. The pending checkpoint is
 * stored first, so a closed question comes back with a bare /pathway. With no recommendation or no open pathway nothing is asked.
 */
const askCheckpoint = async ($: EngineInterface, pending: Pending): Promise<Asked> => {
  const { pr } = pending
  const ask = buildPathwayAsk(pr, pending.result, ageText(pending.stamp, await $.clock.now()))
  if (!ask) return { text: noQuestionText(pr, pending.result.why[0]), recorded: null }
  await $.store.set(`${PENDING_PREFIX}${await sessionId($)}`, pending)
  const got = await askDave($, ask.question, ask.choices.map(one => one.label), ask.header)
  if (got.kind === 'closed') return { text: closedText(pr), recorded: null }
  if (got.kind === 'empty') return { text: emptyText(pr), recorded: null }
  const choice = pathwayOfAnswer(got.text, ask)
  if (!choice) return { text: otherText(pr, got.text), recorded: null }
  if (choice.pathway === 'wait') {
    $.ui.toast(`PR #${pr} stays a draft`, { timeoutMs: 10_000 })
    await clearPending($)
    return { text: keptDraftText(pr), recorded: null }
  }
  return recordChoice($, pending, choice)
}

// ---- the tool -----------------------------------------------------------------------------------------------------------------------

/**
 * The tool. Headless and a subagent get the text plan. The main session of an interactive run gets Dave's question, and the call
 * waits for his answer. Returns the text for the model.
 */
const toolText = async ($: EngineInterface, pr: number, body: string, isSubagent: boolean): Promise<string> => {
  const root = await rootOf($)
  if (!root) return `pr_checkpoint runs in a CCv3 checkout (it needs ${ENGINE_REL} in the session root). Nothing was recorded.`
  const live = await interactive($)
  if (!live || isSubagent) {
    if (!(await $.fs.exists(resolveBody(root, body)))) return missingBody(body, root)
    return textPlan($, root, root, null, null, isSubagent && live ? SUBAGENT_WHY : undefined)
  }
  // Taken before the first await below: a second call that finds it taken asks nothing.
  if (!takeDialog()) return BUSY_TEXT
  try {
    const prepared = await prepare($, root, pr, body)
    if (!prepared.ok) return prepared.text
    const auto = await autoConfirm($, prepared.pending)
    if (auto?.kind === 'done') {
      await finishAuto($, auto.record, prepared.pending.result.auto.band)
      return `The checkpoint for #${pr} was auto-confirmed: band ${prepared.pending.result.auto.band ?? 'unknown'}, none (${auto.record.label ?? 'no label'}). The mod added the label and marked the PR ready. No answer is needed. pr_watch continues. Do not merge.`
    }
    const lead = auto ? `Auto-confirm was not possible (${auto.why}), so the checkpoint for #${pr} waits for Dave. ` : ''
    return `${lead}${(await askCheckpoint($, prepared.pending)).text}`
  } finally {
    freeDialog()
  }
}

/**
 * `/pathway grant <pr> <round>`: Dave allows a review round the watcher did not ask about, or one he declined. It stores the grant
 * (`checkpoint:grant:<pr>`) on the record's head and clears a round decline it covers. Only his own composer command writes. It posts nothing.
 */
const grantCommand = async ($: EngineInterface, origin: string, grant: { pr: number; round: number }): Promise<{ text: string }> => {
  if (origin !== 'composer' || !(await interactive($))) return { text: `Only Dave's own ${SLASH} grant records. Nothing was recorded.` }
  const key = `${RECORD_PREFIX}${grant.pr}`
  const stored = readRecord(await $.store.get(key))
  if (!stored) return { text: `PR #${grant.pr} has no checkpoint record. Run ${SLASH} on it first. Nothing was recorded.` }
  // A lower grant never lowers a round Dave already allowed, whichever head that grant carries (a dialog stores the PR head at ask time).
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
    // A queued round ask this grant covers is answered: a later No in a dialog would write `declined`, which the model line reads before the grant.
    const queue = await loadAsks($)
    const kept = queue.filter(ask => !(ask.kind === 'round' && ask.pr === grant.pr && (ask.round ?? 1) <= allowed))
    if (kept.length !== queue.length) {
      await saveAsks($, kept)
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

/** The checkpoint question for a pending checkpoint, from a command. The reply carries what was recorded; the model gets the same line as hidden context. */
const askPending = async ($: EngineInterface, pending: Pending, trace: Trace): Promise<CommandReply> => {
  const say = sayer(trace)
  if (!takeDialog()) return say('busy', BUSY_TEXT)
  try {
    const asked = await askCheckpoint($, pending)
    return asked.recorded ? say('recorded', asked.text, [asked.text]) : say('asked', asked.text)
  } finally {
    freeDialog()
  }
}

/**
 * A bare /pathway raises the question again: the pending checkpoint of this session, else the first queued watcher question, deferred or
 * not. It works from Dave's composer and from the bridge (his phone); the dialog is drawn where he is, and only his answer records.
 */
const bareCommand = async ($: EngineInterface, e: CommandEvent, live: boolean, pending: Pending | null, trace: Trace): Promise<CommandReply> => {
  const say = sayer(trace)
  if (!live) return say('need-pr', NEED_PR)
  if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') {
    return say('refused', `This ${SLASH} came from ${e.origin.kind}, not Dave's composer or phone, so it raises no question. Nothing was recorded.`)
  }
  if (pending) {
    trace.root = await rootOf($)
    trace.checkout = pending.root
    return askPending($, pending, trace)
  }
  if ((await loadAsks($)).length === 0) return say('need-pr', NEED_PR)
  if (!takeDialog()) return say('busy', BUSY_TEXT)
  try {
    const text = await raiseQueued($)
    return text === null ? say('need-pr', NEED_PR) : say('asked', text)
  } finally {
    freeDialog()
  }
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
    return askPending($, phone, trace)
  }
  const prepared = await prepare($, root, pr, body)
  if (!prepared.ok) return say('refused', prepared.text)
  const next = prepared.pending
  trace.checkout = next.root
  if (parsed.word === null) return askPending($, next, trace)
  if (parsed.word === 'wait') return say('wait', `PR #${pr} stays a draft. Nothing was recorded.`)
  const result = next.result
  const pathway = parsed.word === 'accept' ? result.recommended : parsed.word
  if (!pathway) return say('refused', `There is no recommendation: ${result.why[0] ?? 'run pre-pr.mjs'}. Nothing was recorded.`)
  const option = result.options.find(one => one.pathway === pathway)
  if (!option || !option.available) return say('refused', `Pathway ${pathway} is not available${option ? `: ${option.reason}` : ''}. Nothing was recorded.`)
  // At HIGH and CRITICAL "no review" records only from Dave's own composer. A bridge command (the phone, a relay) raises the dialog instead,
  // so only his tap on the exact label records.
  if (pathway === 'none' && e.origin.kind !== 'composer' && isQueueBand(result.auto.band)) return askPending($, next, trace)
  const by = parsed.word === 'accept' && !onlyDaveRecordsNone(pathway, result.auto.band) ? 'default' : 'dave'
  // Only a composer command or a bridge command for the pending PR gets here (the check above). The bridge is Remote Control, not Dave's keyboard.
  const via = e.origin.kind === 'bridge' ? 'bridge' : 'composer'
  const out = await recordPathway($, { pr, root: next.root, body: next.body, result }, pathway, by, via)
  if (out.stage !== 'done') {
    return say('not-recorded', out.stage === 'apply' ? `PR #${pr}: ${pathway} is confirmed, but --apply was refused: ${out.text}` : `PR #${pr}: ${pathway} was not recorded: ${out.text}`)
  }
  const record = out.record
  if (pending && pending.pr === pr) await clearPending($)
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
    if (namesStore(command)) return { deny: STORE_DENY }
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
    if (isStoreFile(path)) return { deny: STORE_DENY }
    return isSlotStateFile(path) ? { deny: SLOT_DENY } : null
  } catch {
    return { deny: LOCK_FAILED }
  }
}

/** One module's part of session.start, on either trigger. The tool and the command register in both modes; the question is interactive only. */
const start = async ($: EngineInterface, isInteractive: boolean): Promise<void> => {
  // The mode first: a throw below must not leave the default ('interactive') in place for a headless run.
  await update($, mode, () => (isInteractive ? 'interactive' : 'headless'))
  if (await isOff($)) return
  // Each registration has its own try: a refused name must not stop the rest.
  try {
    await $.tool.register({
      name: TOOL_NAME,
      description:
        "Asks Dave the PR checkpoint question for a DRAFT pull request in Rev4nchist/Continuous-Claude-v3, in this session: the review pathways with their cost in dollars, and the recommended one first. The call waits for his answer. The mod then records the pathway he picked, adds the review label and marks the PR ready, and the result tells you what he chose. Call it after pre-pr.mjs passed, with the PR number and the path of the body file that pre-pr.mjs --body checked. Do not ask Dave the question yourself, and never run gh pr ready, add a review: label or run pr-checkpoint --confirm yourself. A headless session or a subagent gets the text plan only and nothing is recorded.",
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
    // The command still loads.
  }
  try {
    await $.command.register({
      name: COMMAND,
      description: 'Ask the PR checkpoint question again, or record a pathway',
      argumentHint: '[pr] [accept|coderabbit|both|none|wait] [--body <file>]',
    })
  } catch {
    // The tool still loads.
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
    const input = e as unknown as { pr?: unknown; body?: unknown; agentId?: unknown }
    if (!isPrNumber(input.pr) || typeof input.body !== 'string' || input.body.trim() === '') {
      return { deny: 'pr_checkpoint needs "pr" (a positive whole number) and "body" (the PR body file).' }
    }
    return textResult(await toolText($, input.pr, input.body.trim(), input.agentId !== undefined))
  }).catch(($, e, next) => (next.called ? next(e) : textResult('pr_checkpoint failed. Nothing was recorded. The PR stays a draft.')))

  // Lock A: no tool writes pathway.json. Always enforced, warn mode included.
  on('tool.call', { tool: /^(Write|Edit|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => (await writeLock($, e as unknown as WriteCall)) ?? next(e)).catch(($, e, next) => (next.called ? next(e) : { deny: LOCK_FAILED }))

  // Lock B: shell text. Judge first, call next last, so a throw never denies a command that already ran.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => (await shellLock($, e as unknown as ShellCall, 'bash')) ?? next(e)).catch(($, e, next) => (next.called ? next(e) : { deny: LOCK_FAILED }))

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => (await shellLock($, e as unknown as ShellCall, 'pwsh')) ?? next(e)).catch(($, e, next) => (next.called ? next(e) : { deny: LOCK_FAILED }))

  on('command.run', { command: COMMAND }, ($, e) => checkpointCommand($, e)).catch(() => ({
    text: `${SLASH} failed. Nothing was recorded.`,
  }))
}
