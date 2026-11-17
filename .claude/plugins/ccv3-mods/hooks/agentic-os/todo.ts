import { redact } from '../shared/redact'
import type { OsAskItem, OsTodo } from '../../types'

// "To do for you": actions for Dave that need no answer (Dave's design choice, 2026-11-16). Design v2:
// .claudedocs/coordination/2026-11-16-coord-status-band-2-todo-design-v2.md. The first try put a `todo` kind into the ask list and went back to
// design after three hidden-question findings (.claudedocs/coordination/2026-11-16-coord-status-band-2-todo-findings.md).
//
// The rule: the to-dos live in their own list, `brief.todos`. No ask path reads them: the chip, the answered mark, the stale clock of the
// questions, the cleared list, the closing-line parser (`mergeParsed`) and the digest never see this list. Everything about to-dos is here (pure).

export const TODO_LIMITS = { items: 8, text: 300 } as const

/** The same 24 hours as a question (`STALE_ASK_MS` in brief.ts); a copy, because brief.ts imports this file. */
export const STALE_TODO_MS = 24 * 3600_000

/** The question mark in its three forms. Tested on the RAW text, before redaction: a redaction can take a trailing mark into its value. */
const QUESTION_MARK = /[?？¿]/

export const holdsQuestionMark = (raw: string): boolean => QUESTION_MARK.test(raw)

/** The text as the closing-line parser reads a line: redacted, trimmed, the final dots and spaces cut. */
const normalized = (value: string): string => redact(value).text.trim().replace(/[.\s]+$/, '')

/**
 * Drops from the parsed asks every line that is exactly (after the clean-up above) the text of an open to-do. The model declared that text
 * as a to-do, and the Next steps block is mandatory, so the model repeats it there. Fences, by the seat's ruling:
 * the match is the whole text, equal, never a prefix or a part; only against the to-dos of the current brief; a line with a question mark
 * (any of the three forms) or a recommend is never dropped. Pure. `mergeParsed` is not touched: it gets the filtered result.
 */
export const withoutDeclaredTodos = <T extends { ask?: OsAskItem[] }>(parsed: T, todos: readonly OsTodo[] | undefined): T => {
  if (parsed.ask === undefined || todos === undefined || todos.length === 0) return parsed
  const declared = new Set(todos.map(one => normalized(one.text)))
  const kept = parsed.ask.filter(one => {
    if (one.recommend !== undefined && one.recommend !== '') return true
    if (holdsQuestionMark(one.text)) return true
    return !declared.has(normalized(one.text))
  })
  return kept.length === parsed.ask.length ? parsed : { ...parsed, ask: kept }
}

/** True when the brief holds a to-do and 24 hours of quiet are behind it (the later of the last brief change and the last activity). Never read by the chip. */
export const todoStale = (brief: { todos?: readonly OsTodo[]; updatedAt: number }, now: number, lastActivity?: number | null): boolean =>
  (brief.todos?.length ?? 0) > 0 && now - Math.max(brief.updatedAt, lastActivity ?? 0) >= STALE_TODO_MS
