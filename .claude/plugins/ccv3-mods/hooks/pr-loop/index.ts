import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { CheckpointAsk, PrWatch } from '../../types'
import { SLASH } from '../pr-checkpoint/model'
import {
  BACKOFF_MS,
  BACKOFF_SLACK_MS,
  MAX_FAILS,
  STATUS_TIMEOUT_MS,
  TICK_MS,
  addWatch,
  alertKey,
  askFor,
  checkpointOf,
  clipTail,
  grantRound,
  isClosed,
  isPrNumber,
  isStale,
  isWaived,
  landCommand,
  MAX_LAND_BATCH,
  markSent,
  parseLandArgs,
  unmarkSent,
  noteFailure,
  parseArgs,
  parseProbe,
  readDoc,
  readRecord,
  refreshAlert,
  reportLine,
  settle,
  stateOf,
  statusForModel,
  statusText,
  toastText,
  wasSent,
  watchLine,
} from './model'
import type { Alert, AlertCheckpoint, Probe, PrStatus, WatchDoc } from './model'

/**
 * The same atom the Agentic OS module declares (same plugin and key, same default): the engine
 * reads an atom only where it is written, so each module declares it. Both set it at session.start.
 */
const mode = atom({ plugin: 'ccv3-mods', key: 'mode' } as const, 'interactive' as 'interactive' | 'headless')

/** This session's watched PRs, mirrored from $.store so the band and pane redraw. */
const prs = atom({ plugin: 'ccv3-mods', key: 'prs' } as const, [] as PrWatch[])

/** Questions for Dave in the checkpoint pane. The pr-checkpoint module declares the same atom and answers them. */
const checkpointAsks = atom({ plugin: 'ccv3-mods', key: 'checkpointAsks' } as const, [] as CheckpointAsk[])

const STATUS_SCRIPT = 'scripts/github/review-status.mjs'
const REPO = 'Rev4nchist/Continuous-Claude-v3'
const KEY_PREFIX = 'pr-watch:'
const WATCH_TOOL = 'mcp__ccv3-mods__pr_watch'
const STATUS_TOOL = 'mcp__ccv3-mods__pr_status'

const ASKS_PREFIX = 'checkpoint:asks:'
const RECORD_PREFIX = 'checkpoint:pr:'
const GRANT_PREFIX = 'checkpoint:grant:'
/** The head for which the PR author's waiver comment was seen. A PR with a waiver is read once per head, not once per tick. */
const WAIVED_PREFIX = 'checkpoint:waived:'
const CHECKPOINT_PANE = 'pr-checkpoint'

const prSchema = {
  type: 'object',
  properties: { pr: { type: 'integer', minimum: 1, description: 'The pull request number' } },
  required: ['pr'],
}

/**
 * A mod-served MCP tool answers with a list of content blocks (or a string). The engine refused the
 * MCP result object { content, isError }: "result does not match its output shape" (seen live, 2.1.292).
 */
const textResult = (text: string) => ({ result: [{ type: 'text', text }] })

/** CCV3_MODS_OFF=1 keeps the whole module inert. */
const isOff = async ($: EngineInterface): Promise<boolean> => (await $.env.get('CCV3_MODS_OFF')) === '1'

/** CCV3_MOD_PRLOOP_QUIET=1 (exactly "1") keeps every alert off the model: the toast and the PRS row stay. */
const isQuiet = async ($: EngineInterface): Promise<boolean> => (await $.env.get('CCV3_MOD_PRLOOP_QUIET')) === '1'

const homeDir = async ($: EngineInterface) => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

const interactive = async ($: EngineInterface): Promise<boolean> => (await read($, mode)) === 'interactive'

/** The checkout that holds the CCv3 scripts: this session's root, else the home checkout. */
const findRoot = async ($: EngineInterface): Promise<string | null> => {
  const roots: string[] = []
  try {
    roots.push(await $.session.root())
  } catch {
    // No session root: the home checkout is the only candidate.
  }
  const home = await homeDir($)
  if (home) roots.push(`${home}/continuous-claude`)
  for (const root of roots) if (await $.fs.exists(`${root}/${STATUS_SCRIPT}`)) return root
  return null
}

const probe = async ($: EngineInterface, pr: number): Promise<Probe> => {
  try {
    const root = await findRoot($)
    if (!root) return { kind: 'error', text: `${STATUS_SCRIPT} not found in the session root or ~/continuous-claude`, perPr: false }
    const run = await $.process.run(['node', `${root}/${STATUS_SCRIPT}`, String(pr), '--json'], {
      cwd: root,
      timeoutMs: STATUS_TIMEOUT_MS,
    })
    return parseProbe(run)
  } catch (err) {
    return { kind: 'error', text: `could not run the status script (${err instanceof Error ? err.message : String(err)})`, perPr: false }
  }
}

const probeText = (pr: number, result: Probe): string =>
  result.kind === 'ok' ? statusText(result.status) : `PR #${pr}: could not read the status (${result.text}).`

/**
 * Whether the PR author posted a waiver comment (isWaived): one `gh pr view` of its author and comments, kept per head after a hit.
 * Any failure reads as "not waived", so a gh outage keeps the question. It only decides whether `asking` queues a question for Dave.
 */
const waivedFor = async ($: EngineInterface, pr: number, head: string): Promise<boolean> => {
  if ((await $.store.get(`${WAIVED_PREFIX}${pr}`)) === head) return true
  try {
    const run = await $.process.run(['gh', 'pr', 'view', String(pr), '--json', 'author,comments', '-R', REPO], { timeoutMs: STATUS_TIMEOUT_MS })
    const waived = run.exitCode === 0 && isWaived(JSON.parse(run.stdout))
    if (waived) await $.store.set(`${WAIVED_PREFIX}${pr}`, head)
    return waived
  } catch {
    return false
  }
}

const storeKey = async ($: EngineInterface): Promise<string> => `${KEY_PREFIX}${await $.session.id()}`

const loadDoc = async ($: EngineInterface): Promise<WatchDoc> =>
  readDoc(await $.store.get(await storeKey($)), await $.clock.now())

/** An empty list deletes the key, so a finished session leaves nothing behind. */
const saveDoc = async ($: EngineInterface, doc: WatchDoc): Promise<void> => {
  const key = await storeKey($)
  if (doc.prs.length === 0) await $.store.delete(key)
  else await $.store.set(key, { ...doc, touched: await $.clock.now() })
  await update($, prs, () => doc.prs)
}

/** Reads this session's list into the atom, and drops lists of sessions untouched for a week. */
const restore = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  const mine = await storeKey($)
  for (const key of await $.store.keys()) {
    if (key.startsWith(KEY_PREFIX) && key !== mine && isStale(await $.store.get(key), now)) await $.store.delete(key)
  }
  const doc = await loadDoc($)
  await update($, prs, () => doc.prs)
}

/** Dave's press, and only an exact "Land". Dismiss, a failed dialog or any other reply is No. */
const askLand = async ($: EngineInterface, question: string): Promise<boolean> => {
  try {
    return (await $.ui.ask(question, ['Land', 'No'])) === 'Land'
  } catch {
    return false
  }
}

const confirmLand = ($: EngineInterface, pr: number): Promise<boolean> => askLand($, `Land #${pr}?`)

const outputOf = (ran: { text?: string; result?: unknown }): string => {
  if (typeof ran.text === 'string') return ran.text
  const stdout = (ran.result as { stdout?: unknown } | undefined)?.stdout
  return typeof stdout === 'string' ? stdout : JSON.stringify(ran.result ?? '')
}

/**
 * Runs land-pr through the normal tool path. The caller has Dave's press;
 * `consent` carries it, so the permission check reads it as his request.
 */
const landNow = async ($: EngineInterface, pr: number, via: string): Promise<string> => (await landRun($, pr, via)).text

/** True when a shell tool exists to run land-pr in sequence. Without one, a landing is handed to the model as a single instruction. */
const hasShell = async ($: EngineInterface): Promise<boolean> => {
  const names = new Set((await $.tool.list().catch(() => [])).map(tool => tool.name))
  return names.has('PowerShell') || names.has('Bash')
}

/** One land-pr run. `ok` is true only for a run that reached the end without a deny, an error flag or an Escape; the hand-off to the model is not ok. */
const landRun = async ($: EngineInterface, pr: number, via: string): Promise<{ ok: boolean; text: string }> => {
  const root = await findRoot($)
  if (!root) return { ok: false, text: `Nothing landed: ${STATUS_SCRIPT} was not found.` }
  const command = landCommand(root, pr)
  const consent = `The user pressed "Land" on ${via}`
  const names = new Set((await $.tool.list().catch(() => [])).map(tool => tool.name))
  const common = { command, consent, timeout: 600_000, description: `Land PR #${pr} with land-pr.ps1` }
  if (names.has('PowerShell') || names.has('Bash')) {
    try {
      const ran = names.has('PowerShell')
        ? await $.tool.call({ tool: 'PowerShell', ...common })
        : await $.tool.call({ tool: 'Bash', ...common })
      if (ran.deny !== undefined) return { ok: false, text: `Land refused: ${ran.deny}` }
      const out = clipTail(outputOf(ran).trim(), 800)
      return ran.isError === true ? { ok: false, text: `Land failed:\n${out}` } : { ok: true, text: out }
    } catch {
      // The engine rejects an aborted call: Dave pressed Escape. His stop is not a reason to merge again.
      return { ok: false, text: `Land interrupted: nothing re-submitted. Check PR #${pr}, then press Land again.` }
    }
  }
  // prompt.submit from inside a command.run hook would wait on the turn that hook holds: submit from a later dispatch.
  const text = `Dave pressed "Land" on ${via}. That press is his merge yes for PR #${pr} only. Run exactly: ${command} Then report its output.`
  $.clock.after(1, () => void $.prompt.submit({ text }).catch(() => undefined))
  return { ok: false, text: `No shell tool here: asked the model to run land-pr for #${pr}.` }
}

const lastLine = (text: string): string =>
  text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1) ?? ''

/**
 * Puts the watch of a PR whose alert was dropped back in line with the re-probe. The dropped alert never reached the model, so
 * its mark (the LIMITED state, the PROOF or REVIEWED marker) must not suppress the next one. The watch from before the check is
 * folded with the fresh status. When that fold alerts, the fresh state is news that nothing delivered: the watch from before the
 * check stays, and the next check alerts.
 */
const resync = async ($: EngineInterface, prior: PrWatch, fresh: PrStatus): Promise<void> => {
  const folded = settle(prior, fresh, await $.clock.now(), await checkpointFor($, fresh))
  const next = folded.alert ? prior : folded.watch
  if (!next) return
  const doc = await loadDoc($)
  await saveDoc($, { ...doc, prs: doc.prs.map(one => (one.pr === prior.pr ? { ...next, whenReady: one.whenReady || next.whenReady } : one)) })
}

/** A delivery failed: the check already saved the advanced state, so put the prior watch back and the next check alerts again. */
const keepPending = async ($: EngineInterface, prior: PrWatch): Promise<void> => {
  const doc = await loadDoc($)
  await saveDoc($, { ...doc, prs: doc.prs.map(one => (one.pr === prior.pr ? { ...prior, whenReady: one.whenReady || prior.whenReady } : one)) })
}

/**
 * The alert as the PR reads right now, or null when it must not go out. The alert waits behind the probe, other alerts and
 * dialogs, so the PR may have changed: one more probe drops it when the PR is merged or closed, its head moved or its state
 * changed (the new head alerts at the next check). A failed re-probe keeps the alert.
 */
const liveAlert = async ($: EngineInterface, alert: Alert, prior: PrWatch): Promise<Alert | null> => {
  const result = await probe($, alert.pr)
  if (result.kind !== 'ok') return alert
  const live = refreshAlert(alert, result.status, await checkpointFor($, result.status))
  if (!live) await resync($, prior, result.status)
  return live
}

/**
 * Submits the model line once per PR, state, head and reason. The ledger entry is written before the submit, so two overlapping
 * deliveries cannot both send. A rejected submit takes the entry back out, or the line would be skipped when the state returns.
 */
const submitLine = async ($: EngineInterface, live: Alert): Promise<void> => {
  const doc = await loadDoc($)
  const key = alertKey(live)
  if (wasSent(doc, key)) return
  await saveDoc($, markSent(doc, key))
  try {
    await $.prompt.submit({ text: reportLine(live) })
  } catch (err) {
    await saveDoc($, unmarkSent(await loadDoc($), key))
    throw err
  }
}

/**
 * Tells Dave and, for an alert the model must act on, the model. Never merges. CLOSED, DRAFT and READY toast at once. LIMITED, PROOF,
 * STALLED and REVIEWED wait for the re-probe, so a PR that was merged or fixed meanwhile gets neither a toast nor a line.
 */
const deliver = async ($: EngineInterface, alert: Alert, prior: PrWatch): Promise<void> => {
  if (alert.state === 'CLOSED' || alert.state === 'DRAFT' || alert.state === 'READY') {
    $.ui.toast(toastText(alert), { timeoutMs: 10_000 })
    if (alert.state === 'READY' && alert.whenReady && (await confirmLand($, alert.pr))) {
      const out = await landNow($, alert.pr, `the READY alert for #${alert.pr}`)
      $.ui.toast(`Land #${alert.pr}: ${lastLine(out)}`, { timeoutMs: 15_000 })
    }
    return
  }
  const live = await liveAlert($, alert, prior)
  if (!live) return
  $.ui.toast(toastText(live), { timeoutMs: 10_000 })
  // Quiet mode wants no model turn: the toast is the alert.
  if (!(await isQuiet($))) await submitLine($, live)
}

const isAsk = (value: unknown): value is CheckpointAsk => {
  const ask = value as Partial<CheckpointAsk> | null
  return !!ask && Number.isInteger(ask.pr) && typeof ask.head === 'string' && typeof ask.text === 'string' && (ask.kind === 'opening' || ask.kind === 'round' || ask.kind === 'greptile')
}

const loadAsks = async ($: EngineInterface): Promise<CheckpointAsk[]> => {
  const value = await $.store.get(`${ASKS_PREFIX}${await $.session.id()}`)
  return Array.isArray(value) ? value.filter(isAsk) : []
}

/** An empty queue deletes the key. The atom mirrors the queue so the pane redraws. */
const saveAsks = async ($: EngineInterface, list: CheckpointAsk[]): Promise<void> => {
  const key = `${ASKS_PREFIX}${await $.session.id()}`
  if (list.length === 0) await $.store.delete(key)
  else await $.store.set(key, list)
  await update($, checkpointAsks, () => list)
}

/** Opens the checkpoint pane with the keys. A pane that waits undrawn gets a toast: Dave types the checkpoint command. */
const openAskPane = async ($: EngineInterface, ask: CheckpointAsk): Promise<void> => {
  try {
    const opened = await $.ui.open({ id: CHECKPOINT_PANE, title: 'PR checkpoint', focus: true, closeOnEscape: true })
    if (!opened.isPlaced) {
      $.ui.toast(`PR #${ask.pr}: a question waits in the checkpoint pane (${opened.reason}); type ${SLASH} to open it`, { timeoutMs: 15_000 })
    }
  } catch {
    // The question stays queued: the checkpoint command draws it.
  }
}

/** One ask per PR, kind and head. The pane opens when the queue was empty. */
const queueAsk = async ($: EngineInterface, ask: CheckpointAsk): Promise<void> => {
  const list = await loadAsks($)
  if (list.some(one => one.pr === ask.pr && one.kind === ask.kind && one.head === ask.head)) return
  await saveAsks($, [...list, ask])
  if (list.length === 0) await openAskPane($, ask)
}

/**
 * The checkpoint part of one PR's check: a closed PR drops its record, grant and asks; an ask whose head moved leaves the
 * queue; a record that has run out of its budget, or waited 30 minutes for CodeRabbit, queues one question for Dave.
 * The watcher never posts a review request: the mod posts only on Dave's press.
 */
const asking = async ($: EngineInterface, status: PrStatus, now: number): Promise<void> => {
  if ((await $.env.get('CCV3_PR_CHECKPOINT_OFF')) === '1') return
  const queue = await loadAsks($)
  if (isClosed(status)) {
    await $.store.delete(`${RECORD_PREFIX}${status.pr}`)
    await $.store.delete(`${GRANT_PREFIX}${status.pr}`)
    await $.store.delete(`${WAIVED_PREFIX}${status.pr}`)
    if (queue.some(one => one.pr === status.pr)) await saveAsks($, queue.filter(one => one.pr !== status.pr))
    return
  }
  const kept = queue.filter(one => one.pr !== status.pr || one.head === status.head)
  if (kept.length !== queue.length) await saveAsks($, kept)
  const record = readRecord(await $.store.get(`${RECORD_PREFIX}${status.pr}`))
  const ask = askFor(record, status, now, grantRound(await $.store.get(`${GRANT_PREFIX}${status.pr}`)))
  if (!ask || kept.some(one => one.pr === ask.pr && one.kind === ask.kind && one.head === ask.head)) return
  // A waiver comment by the PR author quiets only the opening question. Round and Greptile questions still reach Dave.
  if (ask.kind !== 'opening' || !(await waivedFor($, status.pr, status.head))) await queueAsk($, ask)
}

/** The PR's checkpoint record and grant, read for the report lines. Null with no record, a closed PR or the kill switch. */
const checkpointFor = async ($: EngineInterface, status: PrStatus): Promise<AlertCheckpoint | null> => {
  if ((await $.env.get('CCV3_PR_CHECKPOINT_OFF')) === '1' || isClosed(status)) return null
  const record = readRecord(await $.store.get(`${RECORD_PREFIX}${status.pr}`))
  return checkpointOf(record, status, grantRound(await $.store.get(`${GRANT_PREFIX}${status.pr}`)))
}

type Results = Map<number, PrWatch | null>

/** The list as it stands now with this tick's results applied; a PR added meanwhile survives. */
const merge = (fresh: PrWatch[], results: Results): PrWatch[] =>
  fresh.flatMap(one => {
    if (!results.has(one.pr)) return [one]
    const next = results.get(one.pr)
    return next ? [{ ...next, whenReady: one.whenReady || next.whenReady }] : []
  })

const check = async ($: EngineInterface): Promise<void> => {
  if ((await isOff($)) || !(await interactive($))) return
  const before = await loadDoc($)
  const now = await $.clock.now()
  if (before.prs.length === 0 || now + BACKOFF_SLACK_MS < before.backoffUntil) return
  const results: Results = new Map()
  const alerts: { alert: Alert; prior: PrWatch }[] = []
  const notices: string[] = []
  let failure: string | null = null
  for (const watch of before.prs) {
    const result = await probe($, watch.pr)
    if (result.kind === 'error') {
      // An error all PRs share stops this check. One PR's own error counts against that PR only.
      if (!result.perPr) {
        failure = result.text
        break
      }
      const kept = noteFailure(watch)
      results.set(watch.pr, kept)
      if (!kept) notices.push(`PR #${watch.pr}: dropped from the watch list after ${MAX_FAILS} failed checks in a row (${result.text}).`)
      continue
    }
    const settled = settle(watch, result.status, now, await checkpointFor($, result.status))
    results.set(watch.pr, settled.watch)
    if (settled.alert) alerts.push({ alert: settled.alert, prior: watch })
    await asking($, result.status, now).catch(() => undefined)
  }
  const fresh = await loadDoc($)
  await saveDoc($, { ...fresh, prs: merge(fresh.prs, results), backoffUntil: failure === null ? 0 : now + BACKOFF_MS })
  // One notice per failing streak: a repeat after the backoff stays quiet until a check works again.
  if (failure !== null && before.backoffUntil === 0) {
    $.ui.toast(`PR watcher: status check failed (${failure}). Trying again in 15 minutes.`, { timeoutMs: 10_000 })
  }
  for (const notice of notices) $.ui.toast(notice, { timeoutMs: 10_000 })
  // One failed delivery must not cost the others their line, and its own alert must come back at the next check.
  for (const { alert, prior } of alerts) {
    try {
      await deliver($, alert, prior)
    } catch {
      // A failing store must not stop the alerts after this one either.
      await keepPending($, prior).catch(() => undefined)
    }
  }
}

const arm = ($: EngineInterface): void => {
  // One check at a time: a Land/No dialog can stay open longer than a period.
  let busy = false
  $.clock.every(TICK_MS, () => {
    if (busy) return
    busy = true
    void check($)
      .catch(() => undefined)
      .finally(() => {
        busy = false
      })
  })
}

/** Adds a PR only when its status can be read, so a typo or a foreign number never joins the list. */
const addChecked = async ($: EngineInterface, pr: number): Promise<string | null> => {
  const result = await probe($, pr)
  if (result.kind === 'error') {
    return `Not watching #${pr}: could not read the status (${result.text}). Check the number: the watcher reads ${REPO} only.`
  }
  const doc = await loadDoc($)
  await saveDoc($, { ...doc, prs: addWatch(doc.prs, pr, false) })
  return null
}

const USAGE = 'Usage: /watch <pr> [--once]   or   /watch to list the PRs watched'

const watchCommand = async ($: EngineInterface, args: string): Promise<{ text: string }> => {
  const { pr, once } = parseArgs(args)
  if (args.trim() === '') {
    const list = (await loadDoc($)).prs
    return { text: list.length ? `Watching:\n${list.map(one => `  ${watchLine(one)}`).join('\n')}` : 'No PRs watched.' }
  }
  if (pr === null) return { text: USAGE }
  if (once || !(await interactive($))) {
    const note = once ? '' : 'This session is headless: checked once, nothing is watched.\n'
    return { text: note + probeText(pr, await probe($, pr)) }
  }
  const refused = await addChecked($, pr)
  if (refused) return { text: refused }
  return { text: `Watching #${pr}. A check runs every 5 minutes. READY, merged and closed reach Dave by toast only; the model gets a line only for REVIEWED, PROOF, STALLED and LIMITED (none with CCV3_MOD_PRLOOP_QUIET=1).` }
}

const LAND_USAGE = 'Usage: /land <pr> [--when-ready]   or   /land <pr> <pr> ...   or   /land ready'

// ---- batched /land (review factory step A, Dave 2026-11-01) ------------------------------------------------------------------------
// One press lands a list of READY PRs, or every READY PR on the watch list (`ready`), in order. Each PR is its own land-pr.ps1 run, so each is
// SHA-pinned through Gate C. Between runs the PR is read again: it must still be READY at the head Dave saw when he pressed. The batch stops at
// the first PR that does not land. It never lands a PR Dave did not name or that is not on his watch list.

type Row = { pr: number; result: Probe }

const rowText = (row: Row): string => probeText(row.pr, row.result)

/** Why a row cannot land now, or null when it is READY and open. */
const notLandable = (row: Row): string | null => {
  if (row.result.kind === 'error') return 'its status could not be read'
  if (isClosed(row.result.status)) return row.result.status.merged ? 'it is already merged' : 'it is closed'
  return row.result.status.ready ? null : 'it is not READY'
}

const batchReport = (landed: number[], stopped: { pr: number; why: string } | null, rest: number[]): string => {
  const parts = [`Landed: ${landed.length ? landed.map(n => `#${n}`).join(', ') : 'none'}.`]
  if (stopped) parts.push(`Stopped at #${stopped.pr}: ${stopped.why}`)
  if (rest.length) parts.push(`Not tried: ${rest.map(n => `#${n}`).join(', ')}.`)
  return parts.join('\n')
}

/** The state of one PR right before its land run, against the head Dave saw. Null when it may land. */
const driftBefore = async ($: EngineInterface, row: Row & { head: string }): Promise<string | null> => {
  const fresh = await probe($, row.pr)
  if (fresh.kind === 'error') return `its status could not be read (${fresh.text}).`
  const status = fresh.status
  if (isClosed(status)) return `${status.merged ? 'it was merged' : 'it was closed'} since you pressed Land.`
  if (!status.ready) return `it is not READY any more (${status.reasons[0] ?? 'no reason given'}).`
  if (status.head !== row.head) return `the head moved to ${status.headShort} since you pressed Land. Press Land again to land the new head.`
  return null
}

/** Lands the rows in order after one dialog. Stops at the first failure. */
const landRows = async ($: EngineInterface, rows: Row[], table: string): Promise<{ text: string }> => {
  const prs = rows.map(row => row.pr)
  const heads = new Map(rows.map(row => [row.pr, row.result.kind === 'ok' ? row.result.status.head : ''] as const))
  const shown = rows.map(row => `#${row.pr} (${row.result.kind === 'ok' ? row.result.status.headShort : '?'})`).join(', ')
  if (!(await askLand($, `Land ${shown} in this order? Each is checked READY again and merged by its own land-pr run; the first failure stops the rest.`))) {
    return { text: `${table}\nNot landed.` }
  }
  const via = `/land ${prs.map(n => `#${n}`).join(' ')}`
  const landed: number[] = []
  for (const [i, pr] of prs.entries()) {
    const rest = prs.slice(i + 1)
    const stop = (why: string) => ({ text: `${table}\n${batchReport(landed, { pr, why }, rest)}` })
    const drift = await driftBefore($, { pr, result: rows[i]!.result, head: heads.get(pr) ?? '' })
    if (drift) return stop(drift)
    const ran = await landRun($, pr, via)
    if (!ran.ok) return stop(lastLine(ran.text) || 'land-pr did not finish.')
    const after = await probe($, pr)
    // Fail closed: a status that cannot be read after the run is no proof of a merge.
    if (after.kind === 'error') return stop(`could not confirm #${pr} merged; check it before you land again.`)
    if (!after.status.merged) return stop('land-pr printed no error, but the PR is not merged. Check it before you land again.')
    landed.push(pr)
  }
  return { text: `${table}\n${batchReport(landed, null, [])}` }
}

/** `/land 12 13 14` or `/land ready`. Interactive and Dave's press only; every other case lands nothing. */
const landBatch = async ($: EngineInterface, requested: number[] | 'ready'): Promise<{ text: string }> => {
  const numbers = requested === 'ready' ? (await loadDoc($)).prs.map(one => one.pr) : requested
  const overCap = (count: number) => ({ text: `Nothing landed: ${count} PRs is over the limit. A press lands at most ${MAX_LAND_BATCH}.` })
  // An explicit list is capped before any read. `ready` reads the whole watch list and caps the READY rows, which are what would land.
  if (requested !== 'ready' && numbers.length > MAX_LAND_BATCH) return overCap(numbers.length)
  if (requested === 'ready' && numbers.length === 0) return { text: 'Nothing landed: no PR is on the watch list, so no watched PR is READY. Name the PRs: /land <pr> <pr>.' }
  const rows: Row[] = []
  for (const pr of numbers) rows.push({ pr, result: await probe($, pr) })
  const table = rows.map(rowText).join('\n')
  const bad = rows.filter(row => notLandable(row) !== null)
  const ready = rows.filter(row => notLandable(row) === null)
  if (requested !== 'ready' && bad.length > 0) {
    return { text: `${table}\nNothing landed: ${bad.map(row => `#${row.pr} (${notLandable(row)})`).join(', ')}. Fix the list or land the READY ones alone.` }
  }
  if (ready.length === 0) return { text: `${table}\nNothing landed: no watched PR is READY.` }
  if (ready.length > MAX_LAND_BATCH) return { text: `${table}\n${overCap(ready.length).text}` }
  if (!(await interactive($))) return { text: `${table}\nNot landed: landing needs an interactive session and Dave's press.` }
  if (!(await hasShell($))) return { text: `${table}\nNot landed: a batch needs a shell tool to run land-pr one PR at a time, and this session has none. Land them one at a time.` }
  return landRows($, ready, table)
}

const landCommandRun = async ($: EngineInterface, args: string): Promise<{ text: string }> => {
  const parsed = parseLandArgs(args)
  if (parsed.usage) return { text: LAND_USAGE }
  if (parsed.ready) return landBatch($, 'ready')
  if (parsed.prs.length > 1) return landBatch($, parsed.prs)
  const pr = parsed.prs[0]!
  const whenReady = parsed.whenReady
  const result = await probe($, pr)
  const table = probeText(pr, result)
  if (result.kind === 'error') return { text: `${table}\nNothing landed.` }
  const status = result.status
  if (isClosed(status)) return { text: `${table}\nNothing to land: the PR is ${status.merged ? 'merged' : 'closed'}.` }
  const live = await interactive($)
  if (!status.ready) {
    if (!whenReady) return { text: `${table}\nNot landed: the PR is not READY.` }
    if (!live) return { text: `${table}\nNot landed. --when-ready needs an interactive session to watch and ask.` }
    const doc = await loadDoc($)
    const added = addWatch(doc.prs, pr, true).map(one =>
      one.pr === pr && one.state === null ? { ...one, state: stateOf(status) } : one,
    )
    await saveDoc($, { ...doc, prs: added })
    return { text: `${table}\nNot landed yet. Watching #${pr}: Dave is asked Land/No when it turns READY.` }
  }
  if (!live) return { text: `${table}\nNot landed: landing needs an interactive session and Dave's press.` }
  if (!(await confirmLand($, pr))) return { text: `${table}\nNot landed.` }
  return { text: `${table}\n${await landNow($, pr, `/land #${pr}`)}` }
}

const inputPr = (e: unknown): number | null => {
  const pr = (e as { pr?: unknown }).pr
  return isPrNumber(pr) ? pr : null
}

/** One module's part of session.start. Two hooks narrowed by `isInteractive`: the engine refuses a second unmatched one. */
const start = async ($: EngineInterface, isInteractive: boolean): Promise<void> => {
  if (await isOff($)) return
  await update($, mode, () => (isInteractive ? 'interactive' : 'headless'))
  try {
    await $.command.register({
      name: 'watch',
      description: 'Watch a PR for the Greptile review and CI; /watch N --once checks now',
      argumentHint: '<pr> [--once]',
    })
    await $.command.register({
      name: 'land',
      description: 'Show the status of a PR; press Land to merge it when READY. Several numbers, or "ready", land the READY PRs in turn',
      argumentHint: '<pr> [<pr> ...] [--when-ready]  |  ready',
    })
    await $.tool.register({
      name: 'pr_status',
      description:
        'Reads the Greptile review and CI status of a pull request in Rev4nchist/Continuous-Claude-v3 for its current head. Returns JSON: ready, reasons, reviewedHead, confidence, unresolved, mergeable_state. Read only.',
      inputSchema: prSchema,
    })
    // A headless run has no watcher, so it offers no pr_watch: the model starts its /loop fallback.
    if (isInteractive) {
      await $.tool.register({
        name: 'pr_watch',
        description:
          'Adds a pull request in Rev4nchist/Continuous-Claude-v3 to the watch list. Every 5 minutes the session checks the Greptile review and CI for it. READY, merged and closed reach Dave by toast only. You get one report line only when Greptile reviewed it and findings, a low confidence score or failed checks need action (REVIEWED), the PR body proof is wrong (PROOF), no review comes in 60 minutes (STALLED), or a review did not finish (LIMITED). Use pr_status to read the state. CCV3_MOD_PRLOOP_QUIET=1 stops those lines too. Never merges. Call this when you open a PR in that repo.',
        inputSchema: prSchema,
      })
    }
  } catch {
    // Best effort: a failed registration leaves the session as it was.
  }
  if (!isInteractive) return
  try {
    await restore($)
  } catch {
    // The list is read again at each check.
  }
  arm($)
}

export const prLoop = (on: On) => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await start($, true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', { isInteractive: false }, async ($, e, next) => {
    await start($, false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: WATCH_TOOL }, async ($, e) => {
    const pr = inputPr(e)
    if (pr === null) return { deny: 'pr_watch needs "pr": a positive whole number.' }
    const refused = await addChecked($, pr)
    if (refused) return textResult(refused)
    return textResult(
      `Watching #${pr}. The session checks every 5 minutes. READY, merged and closed reach Dave by toast only: you get one line only for REVIEWED, PROOF, STALLED and LIMITED. Use pr_status to read the state. Do not merge.`,
    )
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: STATUS_TOOL }, async ($, e) => {
    const pr = inputPr(e)
    if (pr === null) return { deny: 'pr_status needs "pr": a positive whole number.' }
    const result = await probe($, pr)
    return result.kind === 'ok' ? textResult(JSON.stringify(statusForModel(result.status))) : textResult(`pr_status failed: ${probeText(pr, result)}`)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'watch' }, ($, e) => watchCommand($, e.args)).catch(() => ({ text: '/watch failed.' }))

  on('command.run', { command: 'land' }, ($, e) => landCommandRun($, e.args)).catch(() => ({
    text: '/land failed. Nothing was landed.',
  }))
}
