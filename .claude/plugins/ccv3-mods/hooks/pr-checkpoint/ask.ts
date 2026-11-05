import type { EngineInterface } from 'claude-code'
import { DIAG_DIR } from '../shared/diag'

/**
 * The dialog primitives of the PR checkpoint. Every question the mod puts to Dave goes through `askDave` (the engine's own AskUserQuestion
 * dialog, `$.ui.ask`) and every answer is matched against the labels the mod wrote. The model has no input to a dialog and no hook reads one.
 * Spike S2 (2026-11-04): a mod may not `$.tool.call` AskUserQuestion; the host says "that is $.ui.ask". So `$.ui.ask` is the only way.
 */

/** The shared helpers `run` and `rootOf` read the engine; they take `$` and no atom, so another module may import them. */
export const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export type Ran = { ok: true; code: number; out: string; err: string } | { ok: false; text: string }

/** A process that did not start or timed out is `ok: false` with its message; any exit code is `ok: true`. */
export async function run($: EngineInterface, argv: string[], cwd: string, timeoutMs: number): Promise<Ran> {
  try {
    const ran = await $.process.run(argv, { cwd, timeoutMs })
    return { ok: true, code: ran.exitCode, out: ran.stdout, err: ran.stderr }
  } catch (err) {
    return { ok: false, text: message(err) }
  }
}

/** Tells the model what Dave decided: a user row it reads at its next request. It starts no turn. A refusal is only a missed note. */
export async function tellModel($: EngineInterface, text: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch {
    // The next pr_watch line carries the state.
  }
}

// ---- one dialog at a time ----------------------------------------------------------------------------------------------------------

/**
 * One question or record at a time per session (the module loads once per session). The flag is taken before the first await, so two
 * callers that both found it free cannot both run: the second gets false. The caller frees it in `finally`.
 */
let dialogOpen = false

export const takeDialog = (): boolean => {
  if (dialogOpen) return false
  dialogOpen = true
  return true
}

export const freeDialog = (): void => {
  dialogOpen = false
}

// ---- the dialog --------------------------------------------------------------------------------------------------------------------

/** `text` is what came back: a label, or the words typed under Other. Match it against the mod's labels, exactly. */
export type Answered = { kind: 'text'; text: string } | { kind: 'empty' } | { kind: 'closed' }

const ASK_LOG = `${DIAG_DIR}/ask-dialogs.jsonl`
const ASK_LOG_LINES = 500
const LABEL_CLIP = 80

/** A label text for the log line: the mod writes every label, so it holds no secret; the clip only bounds the line. */
const clipLabel = (label: string): string => label.slice(0, LABEL_CLIP)

/** The engine clock, or null. A failing clock never changes a dialog. A function declaration: the engine follows `$` only into those. */
async function nowOf($: EngineInterface): Promise<number | null> {
  try {
    return await $.clock.now()
  } catch {
    return null
  }
}

/**
 * One JSON line per dialog in ~/.claude/state/ccv3-mods/ask-dialogs.jsonl, the newest 500 kept (lane checkpoint-ask-self-answer: a dialog
 * once came back with the first label and Dave saw no question; the line shows how long it took). Timing, sizes, the option texts in the
 * order shown and the label picked (11-05: #315 and #316 recorded the second label after 7 s and 20 s, and the counts alone could not say
 * what was on screen). No question text, nothing Dave typed. The fs API has no append, so two sessions that write at the same moment can lose one line:
 * accepted. A failed write never touches the dialog.
 */
async function logAsk($: EngineInterface, entry: Record<string, unknown>): Promise<void> {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (!home) return
    const path = `${home}/${ASK_LOG}`
    const old = await $.fs.read(path).then(text => (typeof text === 'string' ? text : ''), () => '')
    const kept = old.split('\n').filter(line => line.trim() !== '').slice(-(ASK_LOG_LINES - 1))
    await $.fs.write(path, `${[...kept, JSON.stringify({ ...entry, session: await $.session.id() })].join('\n')}\n`)
  } catch {
    // Diagnostics only.
  }
}

/**
 * Raises one dialog and waits for Dave. Never throws and never guesses: Esc, a headless run, a failed call or a refusal is `closed`;
 * an answer with no text is `empty`. 2 to 4 labels (the dialog's limit). `header` is at most 12 characters. Every call leaves one log line.
 */
export async function askDave($: EngineInterface, question: string, labels: readonly string[], header?: string): Promise<Answered> {
  const startedAt = await nowOf($)
  let answered: Answered
  try {
    const text: unknown = await $.ui.ask(question, header ? { options: labels, header: header.slice(0, 12) } : { options: labels })
    answered = typeof text === 'string' && text.trim() !== '' ? { kind: 'text', text } : { kind: 'empty' }
  } catch {
    answered = { kind: 'closed' }
  }
  const endedAt = await nowOf($)
  const index = answered.kind === 'text' ? labels.indexOf(answered.text) : -1
  await logAsk($, {
    ts: startedAt === null ? null : new Date(startedAt).toISOString(),
    header: header ? header.slice(0, 12) : null,
    labels: labels.length,
    questionChars: question.length,
    outcome: answered.kind,
    matched: index >= 0 ? index : null,
    // The mod's own label texts, in the order shown, and the one picked. Words typed under Other are never logged: chosen is null then.
    options: labels.map(clipLabel),
    chosen: index >= 0 ? clipLabel(labels[index]!) : null,
    answerChars: answered.kind === 'text' ? answered.text.length : 0,
    elapsedMs: startedAt === null || endedAt === null ? null : endedAt - startedAt,
  })
  return answered
}

/** The label Dave chose: an exact match of one of the mod's own labels, nothing looser. */
export const chosenOf = <T extends { label: string }>(answered: Answered, choices: readonly T[]): T | null =>
  answered.kind === 'text' ? (choices.find(one => one.label === answered.text) ?? null) : null
