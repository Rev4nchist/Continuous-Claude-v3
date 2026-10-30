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
  askFor,
  checkpointOf,
  clipTail,
  grantRound,
  isClosed,
  isPrNumber,
  isStale,
  landCommand,
  noteFailure,
  parseArgs,
  parseProbe,
  readDoc,
  readRecord,
  reportLine,
  settle,
  stateOf,
  statusForModel,
  statusText,
  toastText,
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
const confirmLand = async ($: EngineInterface, pr: number): Promise<boolean> => {
  try {
    return (await $.ui.ask(`Land #${pr}?`, ['Land', 'No'])) === 'Land'
  } catch {
    return false
  }
}

const outputOf = (ran: { text?: string; result?: unknown }): string => {
  if (typeof ran.text === 'string') return ran.text
  const stdout = (ran.result as { stdout?: unknown } | undefined)?.stdout
  return typeof stdout === 'string' ? stdout : JSON.stringify(ran.result ?? '')
}

/**
 * Runs land-pr through the normal tool path. The caller has Dave's press;
 * `consent` carries it, so the permission check reads it as his request.
 */
const landNow = async ($: EngineInterface, pr: number, via: string): Promise<string> => {
  const root = await findRoot($)
  if (!root) return `Nothing landed: ${STATUS_SCRIPT} was not found.`
  const command = landCommand(root, pr)
  const consent = `The user pressed "Land" on ${via}`
  const names = new Set((await $.tool.list().catch(() => [])).map(tool => tool.name))
  const common = { command, consent, timeout: 600_000, description: `Land PR #${pr} with land-pr.ps1` }
  if (names.has('PowerShell') || names.has('Bash')) {
    try {
      const ran = names.has('PowerShell')
        ? await $.tool.call({ tool: 'PowerShell', ...common })
        : await $.tool.call({ tool: 'Bash', ...common })
      if (ran.deny !== undefined) return `Land refused: ${ran.deny}`
      const out = clipTail(outputOf(ran).trim(), 800)
      return ran.isError === true ? `Land failed:\n${out}` : out
    } catch {
      // The engine rejects an aborted call: Dave pressed Escape. His stop is not a reason to merge again.
      return `Land interrupted: nothing re-submitted. Check PR #${pr}, then press Land again.`
    }
  }
  // prompt.submit from inside a command.run hook would wait on the turn that hook holds: submit from a later dispatch.
  const text = `Dave pressed "Land" on ${via}. That press is his merge yes for PR #${pr} only. Run exactly: ${command} Then report its output.`
  $.clock.after(1, () => void $.prompt.submit({ text }).catch(() => undefined))
  return `No shell tool here: asked the model to run land-pr for #${pr}.`
}

const lastLine = (text: string): string =>
  text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1) ?? ''

/** Tells Dave and, for an alert the model must act on, the model. Never merges. */
const deliver = async ($: EngineInterface, alert: Alert): Promise<void> => {
  $.ui.toast(toastText(alert), { timeoutMs: 10_000 })
  // A closed PR needs no line. A draft gets the toast only: it waits on Dave's checkpoint command, not on the model.
  if (alert.state === 'CLOSED' || alert.state === 'DRAFT') return
  if (alert.state === 'READY' && alert.whenReady) {
    if (await confirmLand($, alert.pr)) {
      const out = await landNow($, alert.pr, `the READY alert for #${alert.pr}`)
      $.ui.toast(`Land #${alert.pr}: ${lastLine(out)}`, { timeoutMs: 15_000 })
      return
    }
  }
  // READY needs no model turn, and quiet mode wants none: the toast is the alert.
  if (alert.state === 'READY' || (await isQuiet($))) return
  await $.prompt.submit({ text: reportLine(alert) })
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
    if (queue.some(one => one.pr === status.pr)) await saveAsks($, queue.filter(one => one.pr !== status.pr))
    return
  }
  const kept = queue.filter(one => one.pr !== status.pr || one.head === status.head)
  if (kept.length !== queue.length) await saveAsks($, kept)
  const record = readRecord(await $.store.get(`${RECORD_PREFIX}${status.pr}`))
  const ask = askFor(record, status, now, grantRound(await $.store.get(`${GRANT_PREFIX}${status.pr}`)))
  if (ask) await queueAsk($, ask)
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
  const alerts: Alert[] = []
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
    if (settled.alert) alerts.push(settled.alert)
    await asking($, result.status, now).catch(() => undefined)
  }
  const fresh = await loadDoc($)
  await saveDoc($, { ...fresh, prs: merge(fresh.prs, results), backoffUntil: failure === null ? 0 : now + BACKOFF_MS })
  // One notice per failing streak: a repeat after the backoff stays quiet until a check works again.
  if (failure !== null && before.backoffUntil === 0) {
    $.ui.toast(`PR watcher: status check failed (${failure}). Trying again in 15 minutes.`, { timeoutMs: 10_000 })
  }
  for (const notice of notices) $.ui.toast(notice, { timeoutMs: 10_000 })
  for (const alert of alerts) await deliver($, alert)
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

const LAND_USAGE = 'Usage: /land <pr> [--when-ready]'

const landCommandRun = async ($: EngineInterface, args: string): Promise<{ text: string }> => {
  const { pr, whenReady } = parseArgs(args)
  if (pr === null) return { text: LAND_USAGE }
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
      description: 'Show the status of a PR; press Land to merge it when READY',
      argumentHint: '<pr> [--when-ready]',
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
