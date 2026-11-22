import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { SlotAction, SlotRow, SlotTick } from '../../types'
import type { Alert } from './model'
import { askDave, freeDialog, takeDialog } from '../pr-checkpoint/ask'
import { alertSlot, parseList, parseSlotArgs, parseTick, payHead, payPrice, rowsText, slotAskOf, slotAskSpec, slotOf, toastText } from './slot-model'
import type { SlotVerb } from './slot-model'

// The mod side of the free-slot queue. The queue is scripts/github/slot-queue.mjs; this file runs it and shows what it says.
// The model never posts for a queued PR and never writes the state file: the CLI is the one writer (plan sec 3.2, 4 W4).

/** The last tick's rows, so the model lines, the ask and `/watch` can say where a PR stands. Declared here, written only here. */
export const slotRows = atom({ plugin: 'ccv3-mods', key: 'slotRows' } as const, [] as SlotRow[])

const SCRIPT = 'scripts/github/slot-queue.mjs'
const STATE_REL = '.claude/state/coderabbit-slot.json'
/** A 5-item tick is about 20-25 s of gh plus up to 5 s of lock wait (plan sec 4 W4). */
const TICK_TIMEOUT_MS = 120_000
const VERB_TIMEOUT_MS = 60_000
const TOAST_MS = 15_000
const FINISHED = new Set(['done', 'dropped'])

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0] ?? ''

type Found = { script: string; root: string }

/** The queue script of the home checkout (one version for every session), else of this session's root. Null skips the work in silence. */
export async function slotScript($: EngineInterface): Promise<Found | null> {
  const roots: string[] = []
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (home) roots.push(`${home}/continuous-claude`)
  try {
    roots.push(await $.session.root())
  } catch {
    // No session root: the home checkout is the only candidate.
  }
  for (const root of roots) {
    try {
      if (await $.fs.exists(`${root}/${SCRIPT}`)) return { script: `${root}/${SCRIPT}`, root }
    } catch {
      // Try the next root.
    }
  }
  return null
}

type Ran = { ok: true; code: number; out: string; err: string } | { ok: false; text: string }

async function runCli($: EngineInterface, found: Found, argv: string[], timeoutMs: number, script: string = found.script): Promise<Ran> {
  try {
    const ran = await $.process.run(['node', script, ...argv], { cwd: found.root, timeoutMs })
    return { ok: true, code: ran.exitCode, out: ran.stdout, err: ran.stderr }
  } catch (err) {
    return { ok: false, text: message(err) }
  }
}

/**
 * The items list of the parsed state file, or null when slot-queue-model.mjs parseState would refuse it: a root that is not a plain object,
 * a version other than 1, or no items list. The caller then fails closed, so the CLI reports the bad file instead of the mod reading it as idle.
 */
const itemsOf = (root: unknown): unknown[] | null => {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null
  const { version, items } = root as { version?: unknown; items?: unknown }
  return version === 1 && Array.isArray(items) ? items : null
}

/** True when the file text lists an item that is not finished. Text that parseState refuses counts as live, so the failing tick tells Dave. */
const hasLiveItem = (text: unknown): boolean => {
  if (typeof text !== 'string' || text.trim() === '') return false
  try {
    const items = itemsOf(JSON.parse(text))
    return items === null || items.some(item => !FINISHED.has((item as { state?: unknown } | null)?.state as string))
  } catch {
    return true
  }
}

/**
 * Whether the state file lists an item that is not done or dropped. An idle session starts no process: a missing, unreadable or
 * finished file is false. The read is the gate, so a session that watches nothing still ticks while the queue has a live item.
 */
export async function queueActive($: EngineInterface): Promise<boolean> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return false
  try {
    return hasLiveItem(await $.fs.read(`${home}/${STATE_REL}`))
  } catch {
    return false
  }
}

async function setRows($: EngineInterface, rows: SlotRow[]): Promise<void> {
  if (rows.length === 0 && (await read($, slotRows)).length === 0) return
  await update($, slotRows, () => rows)
}

/** One toast per action. The CLI's "Type /slot ..." sentence is replaced: Dave answers the question the session asks. */
export function deliverActions($: EngineInterface, actions: SlotAction[]): void {
  for (const action of actions) $.ui.toast(toastText(action.text), { timeoutMs: TOAST_MS })
}

/** Consecutive failed ticks. Two in a row give one toast; a good tick resets the count. */
export type Streak = { fails: number }

function failTick($: EngineInterface, streak: Streak, reason: string): void {
  streak.fails += 1
  if (streak.fails === 2) $.ui.toast(`Free-slot queue: the tick failed twice in a row (${reason}). The queue could not be read twice. Dave answers the question the session asks.`, { timeoutMs: TOAST_MS })
}

async function readTick($: EngineInterface, found: Found): Promise<SlotTick> {
  const ran = await runCli($, found, ['tick', '--session', await $.session.id(), '--json'], TICK_TIMEOUT_MS)
  if (!ran.ok) return { ok: false, reason: `could not run the tick (${ran.text})` }
  return parseTick(ran.out) ?? { ok: false, reason: `the tick printed no result (exit ${ran.code}${ran.err ? `: ${firstLine(ran.err)}` : ''})` }
}

/**
 * The 5-minute tick of every interactive session. It runs only while the state file lists a live item. The CLI keeps the clock
 * in the file, so a session that starts late toasts a time-out at its first tick. Never throws.
 */
export async function slotTick($: EngineInterface, streak: Streak): Promise<void> {
  if (!(await queueActive($))) {
    streak.fails = 0
    return setRows($, [])
  }
  const found = await slotScript($)
  if (!found) return
  const tick = await readTick($, found)
  if (!tick.ok) return failTick($, streak, tick.reason)
  streak.fails = 0
  await setRows($, tick.rows)
  deliverActions($, tick.actions)
  await slotQuestions($, found, tick.actions).catch(() => undefined)
}

/**
 * The 30 minute paid ask and the 60 minute time-out as dialogs (the toast stays as a second signal). The answer runs the same verb as
 * `/slot pay|wait|drop`; the CLI still posts a paid round only on cr-paid ALLOW. Esc, text under Other or a busy dialog flag runs nothing:
 * the toast names the typed command. A tick that finds a question open skips its dialogs; the CLI asks once, so the toast is the fallback.
 */
async function slotQuestions($: EngineInterface, found: Found, actions: SlotAction[]): Promise<void> {
  const asks = actions.flatMap(action => slotAskOf(action) ?? [])
  if (asks.length === 0 || !takeDialog()) return
  try {
    for (const raw of asks) {
      // The price comes from a fresh cr-paid check, never from the toast text of the tick: Dave's tap on "Pay up to $X" is the cap the CLI enforces.
      const offer = raw.canPay ? await freshOffer($, found, raw.pr) : null
      const ask = raw.canPay ? { ...raw, cost: offer?.cost ?? null } : raw
      const spec = slotAskSpec(ask)
      const got = await askDave($, spec.question, spec.choices.map(one => one.label), spec.header)
      const choice = got.kind === 'text' ? spec.choices.find(one => one.label === got.text) : undefined
      if (!choice) continue
      const ran = await runCli($, found, verbArgv(choice.verb, ask.pr, offer), VERB_TIMEOUT_MS)
      $.ui.toast(resultText(choice.verb, ask.pr, ran), { timeoutMs: TOAST_MS })
    }
  } finally {
    freeDialog()
  }
}

/** The queue row of a PR from the last tick. */
export async function slotFor($: EngineInterface, pr: number): Promise<SlotRow | null> {
  return slotOf(await read($, slotRows), pr)
}

/** The alert with the queue state of its PR, when the queue holds it. `refreshAlert` rebuilds an alert without it, so call this last. */
export async function withSlot($: EngineInterface, alert: Alert): Promise<Alert> {
  const slot = alertSlot(await slotFor($, alert.pr))
  return slot ? { ...alert, slot } : alert
}

/**
 * Whether the queue holds the PR and so posts its review. An `opening` item counts: it waits in the queue for the label review and then
 * queues itself, so the opening ask would be a second post path beside the queue lock. `alertSlot` still leaves `opening` out of the model lines.
 */
export async function queueHolds($: EngineInterface, pr: number): Promise<boolean> {
  const row = await slotFor($, pr)
  if (row) return row.state === 'opening' || alertSlot(row) !== undefined
  return fileHolds($, pr)
}

/**
 * The row cache is empty when every tick of this session failed, or none ran yet. The state file still says what the queue holds:
 * a PR with an item that is not done or dropped is held. A missing or unreadable file holds nothing. A file that parseState refuses
 * (not JSON, a bad root, a wrong version, no items list) is held: the queue may hold the PR, so the opening ask must not post beside it.
 */
async function fileHolds($: EngineInterface, pr: number): Promise<boolean> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return false
  let text: unknown
  try {
    text = await $.fs.read(`${home}/${STATE_REL}`)
  } catch {
    return false
  }
  if (typeof text !== 'string' || text.trim() === '') return false
  try {
    const items = itemsOf(JSON.parse(text))
    return items === null || items.some(item => (item as { pr?: unknown } | null)?.pr === pr && !FINISHED.has((item as { state?: unknown }).state as string))
  } catch {
    return true
  }
}

// ---- add (the apply and the round grants) -------------------------------------------------------------------------------------

export type Enqueue = { pr: number; band: string; head: string; round: number }

/** The bands the queue takes from a checkpoint record: the others keep the old opening ask and the model's own post. */
export const QUEUE_BANDS: readonly string[] = ['HIGH', 'CRITICAL']

const addArgv = (e: Enqueue, session: string): string[] => [
  'add', '--pr', String(e.pr), '--band', e.band, '--head', e.head, ...(e.round > 1 ? ['--round', String(e.round), '--escalated'] : []), '--session', session, '--json',
]

const jsonOf = (text: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The enqueue line (design sec 7 row 1) from the `add` output. */
const enqueueLine = (pr: number, out: string): string => {
  const body = jsonOf(out)
  const state = (body.item as { state?: unknown } | undefined)?.state
  if (state === 'opening') return `PR #${pr}: queued for the free CodeRabbit slot. It waits for the label review first.`
  if (state === 'awaiting-fix') return `PR #${pr}: waits for the fix push, then queues for the free CodeRabbit slot.`
  const { position, total, nextSlotInMin } = body
  if (typeof position !== 'number' || typeof total !== 'number' || typeof nextSlotInMin !== 'number') return `PR #${pr}: queued for the free CodeRabbit slot.`
  return `PR #${pr}: queued for the free CodeRabbit slot, ${position} of ${total}. Next slot in about ${nextSlotInMin} minutes.`
}

const whyFailed = (ran: Ran): string => {
  if (!ran.ok) return ran.text
  const reason = jsonOf(ran.out).reason
  return typeof reason === 'string' ? reason : firstLine(ran.err) || `exit ${ran.code}`
}

/**
 * Adds a PR to the queue and toasts the result. True only when the CLI exited 0: the caller then tells the model the queue posts.
 * A failure gives one toast and false; it never fails the apply or the grant. A missing script is false in silence.
 */
export async function slotAdd($: EngineInterface, e: Enqueue): Promise<boolean> {
  const found = await slotScript($)
  if (!found) return false
  const ran = await runCli($, found, addArgv(e, await $.session.id()), VERB_TIMEOUT_MS)
  if (ran.ok && ran.code === 0) {
    $.ui.toast(enqueueLine(e.pr, ran.out), { timeoutMs: 10_000 })
    return true
  }
  $.ui.toast(`PR #${e.pr}: could not add it to the free-slot queue (${whyFailed(ran)}). Nothing else changed.`, { timeoutMs: 10_000 })
  return false
}

// ---- /slot --------------------------------------------------------------------------------------------------------------------

const USAGE = 'Usage: /slot   or   /slot pay|wait|first|drop <pr>'

/** The price ("$X") and the PR head of one fresh `cr-paid.mjs check`: Dave's tap is a yes to this price at this head. */
type Offer = { cost: string; head: string }

/** A pay decision carries the offer as `--head SHA --cap X`: the head Dave saw and the price of his tap. The CLI refuses a PR whose head moved. */
const verbArgv = (verb: SlotVerb, pr: number, offer: Offer | null = null): string[] => {
  if (verb === 'drop') return ['drop', '--pr', String(pr), '--reason', 'dave', '--json']
  return ['decide', '--pr', String(pr), '--kind', verb, ...(verb === 'pay' && offer ? ['--head', offer.head, '--cap', offer.cost.replace('$', '')] : []), '--json']
}

const PAID_SCRIPT = 'scripts/github/cr-paid.mjs'

/** A fresh `cr-paid.mjs check` of the PR: the price of its round ("$2.75") and the head it was read at, or null (not ALLOW, a failed read, an old script that prints no file count or no head). */
async function freshOffer($: EngineInterface, found: Found, pr: number): Promise<Offer | null> {
  const ran = await runCli($, found, ['check', '--pr', String(pr), '--json'], VERB_TIMEOUT_MS, `${found.root}/${PAID_SCRIPT}`)
  if (!ran.ok) return null
  const cost = payPrice(ran.out)
  const head = payHead(ran.out)
  return cost !== null && head !== null ? { cost, head } : null
}

/**
 * `/slot pay N`: Dave's typed command opens the same priced dialog as the paid ask (the cap is the price of his tap, so a typed number is no yes).
 * A choice other than Pay runs its own verb.
 */
async function payByDialog($: EngineInterface, found: Found, pr: number): Promise<string> {
  const offer = await freshOffer($, found, pr)
  if (offer === null) return `PR #${pr}: no paid round is offered now: cr-paid gave no price and head (it is not ALLOW, or it could not be read). Nothing was posted.`
  if (!takeDialog()) return `PR #${pr}: another question is open. Answer it first. Nothing was posted.`
  try {
    const spec = slotAskSpec({ pr, kind: 'paid', canPay: true, cost: offer.cost })
    const got = await askDave($, spec.question, spec.choices.map(one => one.label), spec.header)
    const choice = got.kind === 'text' ? spec.choices.find(one => one.label === got.text) : undefined
    if (!choice) return `PR #${pr}: no answer. Nothing was posted.`
    return resultText(choice.verb, pr, await runCli($, found, verbArgv(choice.verb, pr, offer), VERB_TIMEOUT_MS))
  } finally {
    freeDialog()
  }
}

async function listText($: EngineInterface, found: Found): Promise<string> {
  const ran = await runCli($, found, ['list', '--json'], VERB_TIMEOUT_MS)
  if (!ran.ok) return `Could not read the free-slot queue (${ran.text}).`
  const list = parseList(ran.out)
  if (!list || !list.ok) return `Could not read the free-slot queue (${list ? list.reason : `exit ${ran.code}`}).`
  await setRows($, list.rows)
  return rowsText(list.rows)
}

const DONE_TEXT: Record<SlotVerb, string> = {
  pay: 'the paid review is posted.',
  wait: 'keeps waiting for the free slot; the 60 minute clock restarted.',
  first: 'is first in line.',
  drop: 'is dropped from the queue.',
}

const resultText = (verb: SlotVerb, pr: number, ran: Ran): string => {
  if (!ran.ok) return `PR #${pr}: /slot ${verb} could not run (${ran.text}). Nothing was changed.`
  const body = jsonOf(ran.out)
  if (ran.code === 3) return `PR #${pr}: cr-paid says ESCALATE (${Array.isArray(body.reasons) ? body.reasons.join('; ') : 'no reason given'}). Nothing posted.`
  // A failed paid post leaves a ledger row and a posted item, and its reason says so: no "Nothing was changed" there.
  if (ran.code !== 0) return `PR #${pr}: /slot ${verb} failed (${whyFailed(ran)}).${verb === 'pay' ? '' : ' Nothing was changed.'}`
  if (verb === 'pay' && body.posted !== true) return `PR #${pr}: nothing posted.`
  if (verb === 'drop' && body.dropped === false) return `PR #${pr}: is not in the queue.`
  return `PR #${pr}: ${DONE_TEXT[verb]}`
}

/**
 * `/slot` lists the queue; `/slot pay|wait|first|drop <pr>` is Dave's answer. A write needs his composer in an interactive session:
 * any other origin, or a headless run, changes nothing. `pay` posts only when cr-paid says ALLOW (the CLI checks).
 */
export async function slotCommand($: EngineInterface, e: { args: string; origin: { kind: string } }, interactive: boolean): Promise<{ text: string }> {
  const parsed = parseSlotArgs(e.args)
  if (parsed.kind === 'usage') return { text: USAGE }
  if (parsed.kind !== 'list' && (e.origin.kind !== 'composer' || !interactive)) {
    return { text: `Only Dave's own /slot ${parsed.kind} in an interactive session changes the queue. Nothing was changed.` }
  }
  const found = await slotScript($)
  if (!found) return { text: `${SCRIPT} was not found in ~/continuous-claude or the session root.` }
  if (parsed.kind === 'list') return { text: await listText($, found) }
  if (parsed.kind === 'pay') return { text: await payByDialog($, found, parsed.pr) }
  return { text: resultText(parsed.kind, parsed.pr, await runCli($, found, verbArgv(parsed.kind, parsed.pr), VERB_TIMEOUT_MS)) }
}

/** Registers `/slot`. */
export async function registerSlot($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'slot',
    description: 'Show the free-slot CodeRabbit queue; /slot pay|wait|first|drop <pr> answers it',
    argumentHint: '[pay|wait|first|drop <pr>]',
  })
}
