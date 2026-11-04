import type { EngineInterface } from 'claude-code'

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

/**
 * Raises one dialog and waits for Dave. Never throws and never guesses: Esc, a headless run, a failed call or a refusal is `closed`;
 * an answer with no text is `empty`. 2 to 4 labels (the dialog's limit). `header` is at most 12 characters.
 */
export async function askDave($: EngineInterface, question: string, labels: readonly string[], header?: string): Promise<Answered> {
  try {
    const text: unknown = await $.ui.ask(question, header ? { options: labels, header: header.slice(0, 12) } : { options: labels })
    return typeof text === 'string' && text.trim() !== '' ? { kind: 'text', text } : { kind: 'empty' }
  } catch {
    return { kind: 'closed' }
  }
}

/** The label Dave chose: an exact match of one of the mod's own labels, nothing looser. */
export const chosenOf = <T extends { label: string }>(answered: Answered, choices: readonly T[]): T | null =>
  answered.kind === 'text' ? (choices.find(one => one.label === answered.text) ?? null) : null
